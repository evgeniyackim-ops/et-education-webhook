const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const dialogflow = require('@google-cloud/dialogflow');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DIALOGFLOW_PROJECT_ID = process.env.DIALOGFLOW_PROJECT_ID || '';
const GOOGLE_APPLICATION_CREDENTIALS_JSON = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '';

const KB_FILE = path.join(__dirname, 'knowledge_base.json');
const PROGRAM_CATALOG_FILE = path.join(__dirname, 'program_catalog.json');
const MINIAPP_DIR = path.join(__dirname, 'miniapp');

app.use('/miniapp', express.static(MINIAPP_DIR));
app.get('/miniapp', (req, res) => {
  res.sendFile(path.join(MINIAPP_DIR, 'index.html'));
});

const sessionState = new Map();

function loadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function loadKB() {
  return loadJson(KB_FILE);
}

function loadProgramCatalog() {
  return loadJson(PROGRAM_CATALOG_FILE);
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\u0000-\u007F\u0400-\u04FF\d\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textIncludesAny(text, variants = []) {
  const q = normalize(text);
  return variants.some(v => q.includes(normalize(v)));
}

function isAffirmative(text) {
  const q = normalize(text);
  return ['да', 'давай', 'хорошо', 'ок', 'окей', 'ага', 'угу', 'покажи', 'хочу'].includes(q);
}

function buildCardMap(kb) {
  const map = new Map();
  for (const card of kb.cards || []) {
    map.set(card.id, card);
  }
  return map;
}

function findCardById(kb, id) {
  return (kb.cards || []).find(c => c.id === id) || null;
}

function detectDirectionCard(query, kb) {
  const q = normalize(query);
  const directionCards = [
    'direction_labs',
    'direction_ecology',
    'direction_fire',
    'direction_radiation',
    'direction_electro',
    'direction_food',
    'direction_labor'
  ];

  for (const id of directionCards) {
    const aliases = kb.aliases?.[id] || [];
    if (aliases.some(a => q.includes(normalize(a)))) {
      return findCardById(kb, id);
    }
  }
  return null;
}

function scoreCard(query, card) {
  const q = normalize(query);
  const words = q.split(' ').filter(w => w.length > 2);
  let score = 0;

  const title = normalize(card.title);
  const answer = normalize(card.answer);
  const nextStep = normalize(card.next_step);
  const keywords = (card.keywords || []).map(normalize);
  const chunks = (card.chunks || []).map(normalize);

  if (q === title) score += 20;
  if (title.includes(q) && q.length > 3) score += 12;
  if (q.includes(title) && title.length > 3) score += 10;

  for (const keyword of keywords) {
    if (q === keyword) score += 18;
    if (q.includes(keyword)) score += 10;
    if (keyword.includes(q) && q.length > 3) score += 8;
  }

  for (const word of words) {
    if (title.includes(word)) score += 4;
    if (answer.includes(word)) score += 3;
    if (nextStep.includes(word)) score += 2;
    if (keywords.some(k => k.includes(word))) score += 5;
    if (chunks.some(chunk => chunk.includes(word))) score += 4;
  }

  return score;
}

function findBestCard(query, kb, options = {}) {
  const { restrictToIds = null } = options;
  const cards = restrictToIds
    ? (kb.cards || []).filter(c => restrictToIds.includes(c.id))
    : (kb.cards || []);

  let bestCard = null;
  let bestScore = 0;

  for (const card of cards) {
    const score = scoreCard(query, card);
    if (score > bestScore) {
      bestScore = score;
      bestCard = card;
    }
  }

  return bestScore > 0 ? bestCard : null;
}

function findBestChunk(query, card) {
  if (!card || !Array.isArray(card.chunks) || card.chunks.length === 0) {
    return null;
  }

  const q = normalize(query);
  const words = q.split(' ').filter(w => w.length > 2);
  let bestChunk = null;
  let bestScore = 0;

  for (const chunk of card.chunks) {
    const c = normalize(chunk);
    let score = 0;

    if (c.includes(q) && q.length > 3) score += 10;
    for (const word of words) {
      if (c.includes(word)) score += 3;
    }

    if (score > bestScore) {
      bestScore = score;
      bestChunk = chunk;
    }
  }

  return bestChunk || card.chunks[0];
}

function buildStructuredAnswer(card, chunk = null) {
  if (!card) {
    return 'Я не нашёл точного ответа. Уточните, пожалуйста: вас интересуют направления обучения, стоимость, контакты, реквизиты, документы, расписание или вход в СДО?';
  }

  const mainText = chunk || card.answer;
  const detailsUrl = card.url ? `\n\nПодробнее:\n${card.url}` : '';
  const nextStep = card.next_step ? `\n\n${card.next_step}` : '';

  return `${mainText}${detailsUrl}${nextStep}`;
}

function resolveFollowUpByUserText(userText, suggestionCards, kb) {
  if (!suggestionCards || suggestionCards.length === 0) return null;

  for (const suggestion of suggestionCards) {
    const aliases = kb.aliases?.[suggestion.id] || [];
    const haystack = [suggestion.title, ...(suggestion.keywords || []), ...aliases];
    if (textIncludesAny(userText, haystack)) {
      return suggestion;
    }
  }

  if (isAffirmative(userText)) {
    return suggestionCards[0];
  }

  return null;
}

function getBaseUrl(req) {
  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol;
  return `${protocol}://${req.get('host')}`;
}

function getMainMenuReplyMarkup(baseUrl) {
  return {
    keyboard: [
      [{ text: '📚 Каталог программ', web_app: { url: `${baseUrl}/miniapp` } }],
      [{ text: '🎓 Направления' }, { text: '💰 Стоимость' }],
      [{ text: '📅 Расписание' }, { text: '📄 Документы' }],
      [{ text: '👩‍🏫 Преподаватели' }, { text: '📞 Контакты' }],
      [{ text: '🔐 Вход в СДО' }, { text: '🏠 Главное меню' }]
    ],
    resize_keyboard: true
  };
}

function getProgramReplyMarkup(baseUrl) {
  return {
    keyboard: [
      [{ text: '📚 Каталог программ', web_app: { url: `${baseUrl}/miniapp` } }],
      [{ text: '💰 Стоимость' }, { text: '📅 Расписание' }],
      [{ text: '📄 Документы' }, { text: '📞 Контакты' }],
      [{ text: '🏠 Главное меню' }]
    ],
    resize_keyboard: true
  };
}

function telegramRequest(method, payload) {
  return new Promise((resolve, reject) => {
    if (!TELEGRAM_BOT_TOKEN) {
      reject(new Error('Не задан TELEGRAM_BOT_TOKEN'));
      return;
    }

    const body = JSON.stringify(payload);

    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      res => {
        let data = '';

        res.on('data', chunk => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data || '{}');
            if (res.statusCode < 200 || res.statusCode >= 300 || !parsed.ok) {
              return reject(new Error(`Telegram API error: ${JSON.stringify(parsed)}`));
            }
            resolve(parsed);
          } catch (error) {
            reject(new Error(`Не удалось разобрать ответ Telegram: ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendTelegramMessage(chatId, text, replyMarkup = undefined) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: false
  };

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  console.log('SEND TO TELEGRAM:', {
    chatId,
    textPreview: String(text || '').slice(0, 150)
  });

  return telegramRequest('sendMessage', payload);
}

function buildProgramText(program) {
  const formats = Array.isArray(program.formats) ? program.formats.join(', ') : 'Не указано';

  return [
    `🎓 ${program.title}`,
    '',
    `Направление: ${program.direction_label || 'Не указано'}`,
    `Форма обучения: ${formats || 'Не указано'}`,
    `Срок освоения: ${program.duration || 'Не указано'}`,
    `Документ: ${program.certificate || 'Не указано'}`,
    `Стоимость: ${program.price || 'Не указано'}`,
    '',
    `Краткое описание: ${program.short_description || 'Не указано'}`,
    `Цель программы: ${program.goal || 'Не указано'}`,
    '',
    `Подробнее на сайте:\n${program.url || 'Не указано'}`,
    '',
    'Что показать дальше? Напишите, например: стоимость, расписание, документы или контакты.'
  ].join('\n');
}

function findProgramById(id) {
  const programs = loadProgramCatalog();
  return programs.find(item => item.id === id) || null;
}

function findDirectionCardIdByProgram(program) {
  const map = {
    laboratories: 'direction_labs',
    ecology: 'direction_ecology',
    fire: 'direction_fire',
    labor_safety: 'direction_labor',
    radiation: 'direction_radiation',
    energy: 'direction_electro',
    food: 'direction_food',
    normocontrol: 'documents'
  };
  return map[program?.direction] || null;
}

function getMainMenuText(kb) {
  const mainCard = findCardById(kb, 'main_menu');
  return mainCard
    ? buildStructuredAnswer(mainCard)
    : '👋 Добро пожаловать! Выберите раздел: направления обучения, стоимость, расписание, документы, контакты или вход в СДО.';
}

function getDialogflowCredentials() {
  if (!GOOGLE_APPLICATION_CREDENTIALS_JSON) return null;

  try {
    return JSON.parse(GOOGLE_APPLICATION_CREDENTIALS_JSON);
  } catch (error) {
    console.error('Ошибка парсинга GOOGLE_APPLICATION_CREDENTIALS_JSON:', error);
    return null;
  }
}

async function detectDialogflowIntent(text, sessionId) {
  if (!DIALOGFLOW_PROJECT_ID) {
    console.log('DIALOGFLOW_PROJECT_ID не задан');
    return null;
  }

  const credentials = getDialogflowCredentials();
  if (!credentials) {
    console.log('Не удалось получить credentials для Dialogflow');
    return null;
  }

  const sessionClient = new dialogflow.SessionsClient({ credentials });
  const sessionPath = sessionClient.projectAgentSessionPath(
    DIALOGFLOW_PROJECT_ID,
    String(sessionId)
  );

  const request = {
    session: sessionPath,
    queryInput: {
      text: {
        text,
        languageCode: 'ru'
      }
    }
  };

  const responses = await sessionClient.detectIntent(request);
  const result = responses[0]?.queryResult || null;

  if (!result) return null;

  const parsed = {
    intentName: result.intent?.displayName || '',
    confidence: Number(result.intentDetectionConfidence || 0),
    fulfillmentText: result.fulfillmentText || ''
  };

  console.log('DIALOGFLOW RESULT:', parsed);

  return parsed;
}

function shouldUseDialogflowFulfillment(dfResult) {
  if (!dfResult) return false;
  if (!dfResult.intentName) return false;
  if (dfResult.intentName === 'Default Fallback Intent') return false;
  if (!dfResult.fulfillmentText || !dfResult.fulfillmentText.trim()) return false;
  if (dfResult.confidence < 0.35) return false;

  return true;
}

async function handleTelegramFallbackByKB(req, message, kb) {
  const chatId = message.chat.id;
  const text = message.text || '';
  const baseUrl = getBaseUrl(req);
  const cardMap = buildCardMap(kb);
  const previousState = sessionState.get(String(chatId)) || null;

  if (previousState?.suggestionIds?.length) {
    const suggestionCards = previousState.suggestionIds.map(id => cardMap.get(id)).filter(Boolean);
    const followUpCard = resolveFollowUpByUserText(text, suggestionCards, kb);

    if (followUpCard) {
      const chunk = findBestChunk(text, followUpCard) || followUpCard.answer;
      const answer = buildStructuredAnswer(followUpCard, chunk);

      sessionState.set(String(chatId), {
        lastCardId: followUpCard.id,
        suggestionIds: followUpCard.follow_up_ids || []
      });

      await sendTelegramMessage(chatId, answer, getMainMenuReplyMarkup(baseUrl));
      return true;
    }
  }

  const quickMap = [
    { variants: ['контакты', '📞 контакты'], cardId: 'contacts' },
    { variants: ['документы', '📄 документы'], cardId: 'documents' },
    { variants: ['расписание', '📅 расписание', 'календарь'], cardId: 'calendar' },
    { variants: ['стоимость', 'цена', 'цены', '💰 стоимость', 'прайс'], cardId: 'price_list' },
    { variants: ['преподаватели', '👩‍🏫 преподаватели'], cardId: 'teachers' },
    { variants: ['вход в сдо', '🔐 вход в сдо', 'личный кабинет'], cardId: 'lms_login' },
    { variants: ['направления', '🎓 направления'], cardId: 'directions' }
  ];

  for (const item of quickMap) {
    if (textIncludesAny(text, item.variants)) {
      const card = findCardById(kb, item.cardId);
      if (card) {
        const answer = buildStructuredAnswer(card, findBestChunk(text, card) || card.answer);

        sessionState.set(String(chatId), {
          lastCardId: card.id,
          suggestionIds: card.follow_up_ids || []
        });

        await sendTelegramMessage(chatId, answer, getMainMenuReplyMarkup(baseUrl));
        return true;
      }
    }
  }

  const explicitDirectionCard = detectDirectionCard(text, kb);
  if (explicitDirectionCard) {
    const answer = buildStructuredAnswer(
      explicitDirectionCard,
      findBestChunk(text, explicitDirectionCard) || explicitDirectionCard.answer
    );

    sessionState.set(String(chatId), {
      lastCardId: explicitDirectionCard.id,
      suggestionIds: explicitDirectionCard.follow_up_ids || []
    });

    await sendTelegramMessage(chatId, answer, getMainMenuReplyMarkup(baseUrl));
    return true;
  }

  const bestCard = findBestCard(text, kb);
  if (bestCard) {
    const answer = buildStructuredAnswer(bestCard, findBestChunk(text, bestCard) || bestCard.answer);

    sessionState.set(String(chatId), {
      lastCardId: bestCard.id,
      suggestionIds: bestCard.follow_up_ids || []
    });

    await sendTelegramMessage(chatId, answer, getMainMenuReplyMarkup(baseUrl));
    return true;
  }

  await sendTelegramMessage(
    chatId,
    'Я не нашёл точного ответа. Напишите, пожалуйста: направления обучения, стоимость, документы, расписание, контакты или откройте каталог программ.',
    getMainMenuReplyMarkup(baseUrl)
  );

  return true;
}

async function handleTelegramTextMessage(req, message) {
  const chatId = message.chat.id;
  const text = message.text || '';
  const normalized = normalize(text);
  const kb = loadKB();
  const baseUrl = getBaseUrl(req);

  if (
    normalized === '/start' ||
    normalized === 'start' ||
    normalized === '/menu' ||
    normalized === 'главное меню' ||
    normalized === '🏠 главное меню'
  ) {
    const menuText = getMainMenuText(kb);
    const mainCard = findCardById(kb, 'main_menu');

    sessionState.set(String(chatId), {
      lastCardId: 'main_menu',
      suggestionIds: mainCard?.follow_up_ids || []
    });

    await sendTelegramMessage(chatId, menuText, getMainMenuReplyMarkup(baseUrl));
    return;
  }

  let dfResult = null;

  try {
    dfResult = await detectDialogflowIntent(text, chatId);
  } catch (error) {
    console.error('Ошибка detectIntent:', error);
  }

  if (shouldUseDialogflowFulfillment(dfResult)) {
    await sendTelegramMessage(
      chatId,
      dfResult.fulfillmentText.trim(),
      getMainMenuReplyMarkup(baseUrl)
    );
    return;
  }

  await handleTelegramFallbackByKB(req, message, kb);
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'ET Education webhook работает',
    endpoints: {
      dialogflowWebhook: '/webhook',
      telegramWebhook: '/telegram-webhook',
      miniapp: '/miniapp',
      apiPrograms: '/api/programs'
    }
  });
});

app.get('/telegram-webhook', (req, res) => {
  res.status(200).send('Telegram webhook endpoint is alive');
});

app.get('/api/programs', (req, res) => {
  try {
    let programs = loadProgramCatalog();
    const { direction, format } = req.query;

    if (direction) {
      programs = programs.filter(program => program.direction === direction);
    }

    if (format) {
      programs = programs.filter(program =>
        Array.isArray(program.formats) && program.formats.includes(format)
      );
    }

    res.json(programs);
  } catch (error) {
    console.error('Ошибка загрузки каталога:', error);
    res.status(500).json({ error: 'Не удалось загрузить каталог программ' });
  }
});

app.post('/telegram-webhook', async (req, res) => {
  try {
    console.log('TELEGRAM UPDATE:', JSON.stringify(req.body, null, 2));

    const update = req.body || {};
    const message = update.message || update.edited_message;

    if (!message) {
      return res.sendStatus(200);
    }

    const chatId = message.chat?.id;
    const baseUrl = getBaseUrl(req);

    if (message.web_app_data?.data) {
      let payload;

      try {
        payload = JSON.parse(message.web_app_data.data);
      } catch (error) {
        console.error('Ошибка парсинга web_app_data:', error);
        await sendTelegramMessage(
          chatId,
          'Не удалось обработать данные из каталога. Попробуйте выбрать программу ещё раз.',
          getProgramReplyMarkup(baseUrl)
        );
        return res.sendStatus(200);
      }

      console.log('Получены данные из Mini App:', payload);

      if (payload.type === 'program_selected') {
        const program = findProgramById(payload.id);

        if (!program) {
          await sendTelegramMessage(
            chatId,
            'Не удалось найти выбранную программу. Откройте каталог ещё раз и попробуйте снова.',
            getProgramReplyMarkup(baseUrl)
          );
          return res.sendStatus(200);
        }

        const kb = loadKB();
        const directionCardId = findDirectionCardIdByProgram(program);
        const directionCard = directionCardId ? findCardById(kb, directionCardId) : null;

        sessionState.set(String(chatId), {
          lastProgramId: program.id,
          lastCardId: directionCard?.id || null,
          suggestionIds: directionCard?.follow_up_ids || []
        });

        await sendTelegramMessage(chatId, buildProgramText(program), getProgramReplyMarkup(baseUrl));
        return res.sendStatus(200);
      }
    }

    if (message.text) {
      await handleTelegramTextMessage(req, message);
      return res.sendStatus(200);
    }

    await sendTelegramMessage(
      chatId,
      'Пожалуйста, отправьте текстовый запрос или откройте каталог программ.',
      getMainMenuReplyMarkup(baseUrl)
    );

    return res.sendStatus(200);
  } catch (error) {
    console.error('Ошибка Telegram webhook:', error);
    return res.sendStatus(200);
  }
});

app.post('/webhook', (req, res) => {
  try {
    const body = req.body || {};
    const sessionId = body?.session || 'default-session';
    const queryResult = body?.queryResult || {};
    const intentName = queryResult?.intent?.displayName || '';
    const action = queryResult?.action || '';
    const userText = queryResult?.queryText || '';
    const parameters = queryResult?.parameters || {};
    const kb = loadKB();
    const cardMap = buildCardMap(kb);

    const previousState = sessionState.get(sessionId) || null;

    if (previousState?.suggestionIds?.length) {
      const suggestionCards = previousState.suggestionIds.map(id => cardMap.get(id)).filter(Boolean);
      const followUpCard = resolveFollowUpByUserText(userText, suggestionCards, kb);

      if (followUpCard) {
        const chunk = findBestChunk(userText, followUpCard) || followUpCard.answer;
        const text = buildStructuredAnswer(followUpCard, chunk);

        sessionState.set(sessionId, {
          lastCardId: followUpCard.id,
          suggestionIds: followUpCard.follow_up_ids || []
        });

        return res.json({ fulfillmentText: text });
      }
    }

    if (intentName === 'main_menu') {
      const mainCard = findCardById(kb, 'main_menu');

      sessionState.set(sessionId, {
        lastCardId: 'main_menu',
        suggestionIds: mainCard?.follow_up_ids || []
      });

      return res.json({ fulfillmentText: getMainMenuText(kb) });
    }

    const explicitDirectionCard = detectDirectionCard(userText, kb);
    if (explicitDirectionCard) {
      const text = buildStructuredAnswer(
        explicitDirectionCard,
        findBestChunk(userText, explicitDirectionCard) || explicitDirectionCard.answer
      );

      sessionState.set(sessionId, {
        lastCardId: explicitDirectionCard.id,
        suggestionIds: explicitDirectionCard.follow_up_ids || []
      });

      return res.json({ fulfillmentText: text });
    }

    const directionName = normalize(parameters.direction_name || '');
    if (directionName) {
      const directionCard = detectDirectionCard(directionName, kb);
      if (directionCard) {
        const text = buildStructuredAnswer(
          directionCard,
          findBestChunk(userText || directionName, directionCard) || directionCard.answer
        );

        sessionState.set(sessionId, {
          lastCardId: directionCard.id,
          suggestionIds: directionCard.follow_up_ids || []
        });

        return res.json({ fulfillmentText: text });
      }
    }

    const isSearchIntent =
      intentName === 'site_search' ||
      intentName === 'site-search' ||
      intentName === 'Default Fallback Intent' ||
      action === 'search_site';

    if (isSearchIntent || userText) {
      const bestCard = findBestCard(userText, kb);
      if (bestCard) {
        const text = buildStructuredAnswer(bestCard, findBestChunk(userText, bestCard) || bestCard.answer);

        sessionState.set(sessionId, {
          lastCardId: bestCard.id,
          suggestionIds: bestCard.follow_up_ids || []
        });

        return res.json({ fulfillmentText: text });
      }
    }

    sessionState.set(sessionId, {
      lastCardId: 'site_search',
      suggestionIds: ['directions', 'price_list', 'contacts', 'documents', 'calendar', 'lms_login']
    });

    return res.json({
      fulfillmentText:
        'Я не нашёл точного ответа. Уточните, пожалуйста: вас интересуют направления обучения, стоимость, контакты, реквизиты, документы, расписание или вход в СДО?'
    });
  } catch (error) {
    console.error('Ошибка webhook:', error);
    return res.json({
      fulfillmentText:
        'Произошла ошибка при обработке запроса. Попробуйте повторить запрос или выберите один из разделов: контакты, направления обучения, стоимость, документы, расписание, вход в СДО.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
