const express = require('express');
const crypto = require('crypto');
const { webcrypto } = crypto;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.set('trust proxy', true);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DIALOGFLOW_PROJECT_ID = process.env.DIALOGFLOW_PROJECT_ID || '';
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '';
const PORT = process.env.PORT || 3000;

function normalizeGooglePrivateKey(rawValue) {
  if (!rawValue) return '';
  let key = String(rawValue).trim();
  if (!key) return '';

  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }

  key = key
    .replace(/\r\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  const beginMarker = '-----BEGIN PRIVATE KEY-----';
  const endMarker = '-----END PRIVATE KEY-----';

  if (key.includes(beginMarker) && key.includes(endMarker)) {
    const body = key
      .replace(beginMarker, '')
      .replace(endMarker, '')
      .replace(/\s+/g, '');

    const wrapped = body.match(/.{1,64}/g)?.join('\n') || body;
    return `${beginMarker}\n${wrapped}\n${endMarker}\n`;
  }

  key = key.replace(/\s+/g, '');
  const wrapped = key.match(/.{1,64}/g)?.join('\n') || key;
  return `${beginMarker}\n${wrapped}\n${endMarker}\n`;
}

const GOOGLE_PRIVATE_KEY = normalizeGooglePrivateKey(process.env.GOOGLE_PRIVATE_KEY || '');

function base64UrlEncode(input) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return raw.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getGoogleAccessToken() {
  if (!DIALOGFLOW_PROJECT_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    return {
      ok: false,
      error: 'Не заданы DIALOGFLOW_PROJECT_ID / GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY'
    };
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claimSet = {
      iss: GOOGLE_CLIENT_EMAIL,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    };

    const unsignedToken = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claimSet))}`;

    const pem = GOOGLE_PRIVATE_KEY
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\s+/g, '');

    const pkcs8Der = Buffer.from(pem, 'base64');

    const cryptoKey = await webcrypto.subtle.importKey(
      'pkcs8',
      pkcs8Der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await webcrypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      Buffer.from(unsignedToken)
    );

    const signature = Buffer.from(signatureBuffer)
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    const assertion = `${unsignedToken}.${signature}`;

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      })
    });

    const data = await response.json();
    if (!response.ok || !data.access_token) {
      return { ok: false, error: JSON.stringify(data) };
    }

    return { ok: true, accessToken: data.access_token };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function detectDialogflowIntent(text, sessionId = 'diag-session') {
  const tokenResult = await getGoogleAccessToken();
  if (!tokenResult.ok) {
    return { ok: false, stage: 'token', error: tokenResult.error };
  }

  try {
    const url = `https://dialogflow.googleapis.com/v2/projects/${encodeURIComponent(DIALOGFLOW_PROJECT_ID)}/agent/sessions/${encodeURIComponent(sessionId)}:detectIntent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenResult.accessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        queryInput: {
          text: {
            text,
            languageCode: 'ru'
          }
        }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return { ok: false, stage: 'detectIntent', error: JSON.stringify(data) };
    }

    const queryResult = data.queryResult || {};
    const intent = queryResult.intent || {};
    return {
      ok: true,
      intentName: intent.displayName || '',
      isFallback: Boolean(intent.isFallback),
      fulfillmentText: queryResult.fulfillmentText || ''
    };
  } catch (error) {
    return { ok: false, stage: 'detectIntent', error: error.message };
  }
}

async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendMessage error: ${JSON.stringify(data)}`);
  }
}

app.get('/', (req, res) => {
  res.send('OK');
});

app.get('/diag-http', async (req, res) => {
  const phrase = String(req.query.q || '/command1');
  const diagnostics = [];
  diagnostics.push(`PUBLIC_BASE_URL: ${PUBLIC_BASE_URL ? 'есть' : 'нет'}`);
  diagnostics.push(`DIALOGFLOW_PROJECT_ID: ${DIALOGFLOW_PROJECT_ID ? 'есть' : 'нет'}`);
  diagnostics.push(`GOOGLE_CLIENT_EMAIL: ${GOOGLE_CLIENT_EMAIL ? 'есть' : 'нет'}`);
  diagnostics.push(`GOOGLE_PRIVATE_KEY: ${GOOGLE_PRIVATE_KEY ? 'есть' : 'нет'}`);
  diagnostics.push(`PRIVATE_KEY_BEGIN: ${GOOGLE_PRIVATE_KEY.trim().startsWith('-----BEGIN PRIVATE KEY-----') ? 'ok' : 'нет'}`);
  diagnostics.push(`PRIVATE_KEY_END: ${GOOGLE_PRIVATE_KEY.trim().endsWith('-----END PRIVATE KEY-----') ? 'ok' : 'нет'}`);
  diagnostics.push(`PRIVATE_KEY_LENGTH: ${GOOGLE_PRIVATE_KEY.length}`);
  diagnostics.push(`TOKEN_SIGN_METHOD: webcrypto.subtle`);
  diagnostics.push(`Тестовая фраза: ${phrase}`);

  const result = await detectDialogflowIntent(phrase, 'diag-http-session');

  if (!result.ok) {
    diagnostics.push(`Статус: ошибка на этапе ${result.stage}`);
    diagnostics.push(`Детали: ${result.error}`);
  } else {
    diagnostics.push(`Статус: успешно`);
    diagnostics.push(`intent = ${result.intentName || '(пусто)'}`);
    diagnostics.push(`isFallback = ${result.isFallback ? 'true' : 'false'}`);
    diagnostics.push(`fulfillmentText = ${result.fulfillmentText || '(пусто)'}`);
  }

  res.type('text/plain; charset=utf-8').send(diagnostics.join('\n'));
});

app.post('/telegram-webhook', async (req, res) => {
  try {
    const message = req.body?.message;
    const chatId = message?.chat?.id;
    const text = message?.text || '';

    if (!chatId || !text) {
      return res.json({ ok: true });
    }

    if (text.startsWith('/diag')) {
      const phrase = text.replace('/diag', '').trim() || '/command1';
      const diagnostics = [];
      diagnostics.push('Проверка Dialogflow:');
      diagnostics.push(`PUBLIC_BASE_URL: ${PUBLIC_BASE_URL ? 'есть' : 'нет'}`);
      diagnostics.push(`DIALOGFLOW_PROJECT_ID: ${DIALOGFLOW_PROJECT_ID ? 'есть' : 'нет'}`);
      diagnostics.push(`GOOGLE_CLIENT_EMAIL: ${GOOGLE_CLIENT_EMAIL ? 'есть' : 'нет'}`);
      diagnostics.push(`GOOGLE_PRIVATE_KEY: ${GOOGLE_PRIVATE_KEY ? 'есть' : 'нет'}`);
      diagnostics.push(`PRIVATE_KEY_BEGIN: ${GOOGLE_PRIVATE_KEY.trim().startsWith('-----BEGIN PRIVATE KEY-----') ? 'ok' : 'нет'}`);
      diagnostics.push(`PRIVATE_KEY_END: ${GOOGLE_PRIVATE_KEY.trim().endsWith('-----END PRIVATE KEY-----') ? 'ok' : 'нет'}`);
      diagnostics.push(`PRIVATE_KEY_LENGTH: ${GOOGLE_PRIVATE_KEY.length}`);
      diagnostics.push(`TOKEN_SIGN_METHOD: webcrypto.subtle`);
      diagnostics.push(`Тестовая фраза: ${phrase}`);

      const result = await detectDialogflowIntent(phrase, `diag-${chatId}`);

      if (!result.ok) {
        diagnostics.push(`Статус: ошибка на этапе ${result.stage}`);
        diagnostics.push(`Детали: ${result.error}`);
      } else {
        diagnostics.push(`Статус: успешно`);
        diagnostics.push(`intent = ${result.intentName || '(пусто)'}`);
        diagnostics.push(`isFallback = ${result.isFallback ? 'true' : 'false'}`);
        diagnostics.push(`fulfillmentText = ${result.fulfillmentText || '(пусто)'}`);
      }

      await sendTelegramMessage(chatId, diagnostics.join('\n'));
      return res.json({ ok: true });
    }

    await sendTelegramMessage(chatId, 'Файл предназначен для диагностики. Напишите /diag');
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
