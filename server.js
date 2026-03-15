const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { webcrypto } = crypto;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DIALOGFLOW_PROJECT_ID = process.env.DIALOGFLOW_PROJECT_ID || '';
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '';

const KB_FILE = path.join(__dirname, 'knowledge_base.json');
const PROGRAM_CATALOG_FILE = path.join(__dirname, 'program_catalog.json');
const FEEDBACK_LOG_FILE = path.join(__dirname, 'feedback_log.json');
const HANDOFF_FILE = path.join(__dirname, 'handoff_requests.json');
const TEACHERS_CONFIG_FILE = path.join(__dirname, 'teachers_config.json');

const miniappDir = path.join(__dirname, 'miniapp');
app.use('/miniapp', express.static(fs.existsSync(miniappDir) ? miniappDir : __dirname));

const sessionState = new Map();

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function appendJsonRecord(filePath, record) {
  const arr = loadJson(filePath, []);
  arr.push(record);
  saveJson(filePath, arr);
}

function loadKB() {
  return loadJson(KB_FILE, { cards: [], aliases: {}, intent_map: {} });
}

function loadProgramCatalog() {
  return loadJson(PROGRAM_CATALOG_FILE, []);
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\u0000-\u007F\u0400-\u04FF\d\s/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textIncludesAny(text, variants = []) {
  const q = normalize(text);
  return variants.some(v => q.includes(normalize(v)));
}

function buildCardMap(kb) {
  const map = new Map();
  for (const card of kb.cards || []) map.set(card.id, card);
  return map;
}

function findCardById(kb, id) {
  return (kb.cards || []).find(c => c.id === id) || null;
}

function getCardByIntent(kb, intentName) {
  const cardId = kb.intent_map?.[intentName];
  if (!cardId) return null;
  return findCardById(kb, cardId);
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
  if (!card || !Array.isArray(card.chunks) || card.chunks.length === 0) return null;

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
    return 'Я не нашёл точного ответа. Напишите, пожалуйста: направления обучения, стоимость, документы, расписание, контакты или откройте каталог программ.';
  }

  const mainText = chunk || card.answer;
  const detailsUrl = card.url ? `\n\nПодробнее:\n${card.url}` : '';
  const nextStep = card.next_step ? `\n\n${card.next_step}` : '';
  return `${mainText}${detailsUrl}${nextStep}`;
}

function getMainMenuText(kb) {
  const mainCard = findCardById(kb, 'main_menu');
  return mainCard
    ? buildStructuredAnswer(mainCard)
    : '👋 Добро пожаловать! Выберите раздел: направления обучения, стоимость, расписание, документы, контакты или вход в СДО.';
}

function normalizeGooglePrivateKey(rawValue) {
  if (!rawValue) return '';
  let key = String(rawValue).trim();
  if (!key) return '';

  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
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

async function detectDialogflowIntent(text, sessionId = 'tg-session') {
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

function getBaseUrl(req) {
  if (PUBLIC_BASE_URL) {
    return String(PUBLIC_BASE_URL).replace(/\/+$/, '');
  }
  const host = req.get('host');
  if (!host) return '';
  if (host.includes('onrender.com')) {
    return `https://${host}`;
  }
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
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

function getFeedbackReplyMarkup() {
  return {
    keyboard: [
      [{ text: '✅ Да, спасибо' }, { text: '🟡 Частично' }],
      [{ text: '👩‍💼 Нужен специалист' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}

function getHandoffReplyMarkup() {
  return {
    keyboard: [
      [{ text: '📨 Да, передать специалисту' }, { text: 'Нет' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}

async function sendTelegramMessage(chatId, text, replyMarkup = undefined) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('Не задан TELEGRAM_BOT_TOKEN');

  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: false
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendMessage error: ${JSON.stringify(data)}`);
  }
  return data;
}

function getOrCreateState(chatId) {
  const key = String(chatId);
  const state = sessionState.get(key) || {
    history: [],
    suggestionIds: [],
    awaitingFeedback: false,
    awaitingHandoffConfirm: false,
    lastInteraction: null,
    pendingHandoffReason: null,
    conversationState: null,
    selectedTeacher: null,
    remindersEnabled: false
  };
  sessionState.set(key, state);
  return state;
}

function pushHistory(chatId, role, text) {
  const state = getOrCreateState(chatId);
  state.history = state.history || [];
  state.history.push({
    role,
    text,
    timestamp: new Date().toISOString()
  });
  if (state.history.length > 20) {
    state.history = state.history.slice(-20);
  }
  sessionState.set(String(chatId), state);
}

function setLastInteraction(chatId, payload) {
  const state = getOrCreateState(chatId);
  state.lastInteraction = {
    timestamp: new Date().toISOString(),
    ...payload
  };
  state.awaitingFeedback = true;
  state.awaitingHandoffConfirm = false;
  state.pendingHandoffReason = null;
  sessionState.set(String(chatId), state);
}

function logFeedback(chatId, result) {
  const state = getOrCreateState(chatId);
  const entry = {
    timestamp: new Date().toISOString(),
    chatId,
    userQuestion: state.lastInteraction?.userQuestion || '',
    detectedIntent: state.lastInteraction?.detectedIntent || '',
    answerSource: state.lastInteraction?.answerSource || '',
    botAnswer: state.lastInteraction?.botAnswer || '',
    feedbackResult: result
  };
  appendJsonRecord(FEEDBACK_LOG_FILE, entry);
}

function createHandoff(chatId, reason) {
  const state = getOrCreateState(chatId);
  const entry = {
    timestamp: new Date().toISOString(),
    chatId,
    sessionId: `tg-${chatId}`,
    lastIntent: state.lastInteraction?.detectedIntent || '',
    lastAnswerSource: state.lastInteraction?.answerSource || '',
    handoffReason: reason,
    dialogHistory: state.history || []
  };
  appendJsonRecord(HANDOFF_FILE, entry);
}

function isSpecialistRequest(text) {
  return textIncludesAny(text, [
    'специалист',
    'оператор',
    'сотрудник',
    'живой человек',
    'переведи на специалиста',
    'передай специалисту',
    'свяжи с сотрудником'
  ]);
}

function isPositiveFeedback(text) {
  return textIncludesAny(text, ['да, спасибо', 'да спасибо', 'спасибо', 'решено', 'удалось', 'да']);
}

function isPartialFeedback(text) {
  return textIncludesAny(text, ['частично', 'не совсем', 'отчасти']);
}

function isNegativeFeedback(text) {
  return textIncludesAny(text, ['нужен специалист', 'нет', 'не помогло', 'не решено']);
}

async function askForFeedback(chatId) {
  await sendTelegramMessage(chatId, 'Удалось ли решить ваш вопрос?', getFeedbackReplyMarkup());
}

async function askForHandoff(chatId, baseUrl) {
  const state = getOrCreateState(chatId);
  state.awaitingHandoffConfirm = true;
  state.awaitingFeedback = false;
  sessionState.set(String(chatId), state);

  await sendTelegramMessage(
    chatId,
    'Я не смог точно ответить на ваш вопрос. Хотите, чтобы я передал обращение специалисту?',
    getHandoffReplyMarkup(baseUrl)
  );
}

async function handleFeedbackResponse(chatId, text, baseUrl) {
  const state = getOrCreateState(chatId);

  if (isPositiveFeedback(text)) {
    logFeedback(chatId, 'resolved_yes');
    state.awaitingFeedback = false;
    sessionState.set(String(chatId), state);
    await sendTelegramMessage(chatId, 'Спасибо за обратную связь.', getMainMenuReplyMarkup(baseUrl));
    return true;
  }

  if (isPartialFeedback(text)) {
    logFeedback(chatId, 'resolved_partial');
    state.awaitingFeedback = false;
    sessionState.set(String(chatId), state);
    await sendTelegramMessage(chatId, 'Спасибо. Я учту это для улучшения ответов.', getMainMenuReplyMarkup(baseUrl));
    return true;
  }

  if (isNegativeFeedback(text)) {
    logFeedback(chatId, 'resolved_no');
    createHandoff(chatId, 'feedback_requested_specialist');
    state.awaitingFeedback = false;
    state.awaitingHandoffConfirm = false;
    sessionState.set(String(chatId), state);
    await sendTelegramMessage(
      chatId,
      'Ваш запрос передан специалисту. История диалога сохранена.',
      getMainMenuReplyMarkup(baseUrl)
    );
    return true;
  }

  return false;
}

async function handleHandoffConfirm(chatId, text, baseUrl) {
  const state = getOrCreateState(chatId);

  if (textIncludesAny(text, ['да, передать специалисту', 'да передать специалисту', 'да', 'передать'])) {
    createHandoff(chatId, state.pendingHandoffReason || 'bot_could_not_answer');
    state.awaitingHandoffConfirm = false;
    sessionState.set(String(chatId), state);
    await sendTelegramMessage(
      chatId,
      'Ваш запрос передан специалисту. История диалога сохранена. Сотрудник сможет ознакомиться с обращением.',
      getMainMenuReplyMarkup(baseUrl)
    );
    return true;
  }

  if (textIncludesAny(text, ['нет', 'отмена'])) {
    state.awaitingHandoffConfirm = false;
    sessionState.set(String(chatId), state);
    await sendTelegramMessage(
      chatId,
      'Хорошо. Вы можете задать вопрос по-другому или выбрать раздел: направления, стоимость, документы, расписание, контакты.',
      getMainMenuReplyMarkup(baseUrl)
    );
    return true;
  }

  return false;
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
    `Подробнее на сайте:\n${program.url || 'Не указано'}`
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


function loadTeachersConfig() {
  return loadJson(TEACHERS_CONFIG_FILE, { teachers: [] });
}

function findTeacherByText(input) {
  const teachers = loadTeachersConfig().teachers || [];
  const q = normalize(input);
  if (!q) return null;

  const scored = teachers.map(teacher => {
    const variants = [teacher.full_name, ...(teacher.aliases || [])]
      .filter(Boolean)
      .map(normalize);

    let score = 0;
    for (const variant of variants) {
      if (q === variant) score += 100;
      else if (q.includes(variant)) score += 80;
      else if (variant.includes(q) && q.length >= 3) score += 40;

      const words = variant.split(' ').filter(Boolean);
      const matched = words.filter(word => q.includes(word)).length;
      score += matched * 10;
    }

    return { teacher, score };
  }).sort((a, b) => b.score - a.score);

  return scored[0] && scored[0].score >= 20 ? scored[0].teacher : null;
}

function getTeacherSlots(teacher) {
  const pages = Array.isArray(teacher?.slots_pages) ? teacher.slots_pages : [];
  return pages.flat().filter(slot => slot?.date && slot?.time);
}

function formatTeacherSlots(teacher) {
  const slots = getTeacherSlots(teacher);
  if (!slots.length) {
    return `Свободных дат для записи к преподавателю ${teacher.full_name} сейчас нет.`;
  }

  const lines = slots.map((slot, index) => {
    const format = slot.format ? ` (${slot.format})` : '';
    return `${index + 1}. ${slot.date} — ${slot.time}${format}`;
  });

  return [
    `Доступные даты для записи к преподавателю ${teacher.full_name}:`,
    '',
    ...lines,
    '',
    'Напишите номер подходящего времени.'
  ].join('\n');
}

function getDeadlineItems() {
  return [
    '30.03.2026 — регистрация на курс «Экологическая безопасность»',
    '01.04.2026 — начало программы «Нормоконтроль»',
    '03.04.2026 — вебинар по радиационной безопасности',
    '07.04.2026 — окончание набора на курс «Охрана труда»',
    '10.04.2026 — семинар по метрологии',
    '12.04.2026 — начало курса «Метрологическое обеспечение производства»'
  ];
}

function buildDeadlinesText(withQuestion = true) {
  const lines = getDeadlineItems();
  const text = ['Ближайшие события:', '', ...lines].join('\n');
  return withQuestion ? `${text}\n\nХотите получать напоминания?` : text;
}

function isConsultationStart(text) {
  return textIncludesAny(text, [
    'хочу записаться на консультацию',
    'записаться на консультацию',
    'мне нужна консультация',
    'хочу консультацию',
    'записаться к преподавателю',
    'консультация с преподавателем'
  ]);
}

function isDeadlinesRequest(text) {
  return textIncludesAny(text, [
    'какие ближайшие дедлайны',
    'ближайшие дедлайны',
    'какие дедлайны',
    'какие ближайшие события',
    'ближайшие события',
    'сроки сдачи',
    'ближайшие аттестации'
  ]);
}

function isRemindersConsent(text) {
  return textIncludesAny(text, [
    'включи напоминания о дедлайнах',
    'включи напоминания',
    'подключи напоминания',
    'хочу получать напоминания',
    'да',
    'давай',
    'хорошо',
    'ок',
    'подключай'
  ]);
}

async function respondWithAnswer(chatId, userText, botAnswer, meta, baseUrl) {
  pushHistory(chatId, 'user', userText);
  pushHistory(chatId, 'bot', botAnswer);
  setLastInteraction(chatId, {
    userQuestion: userText,
    detectedIntent: meta.detectedIntent || '',
    answerSource: meta.answerSource || '',
    botAnswer
  });
  await sendTelegramMessage(chatId, botAnswer, getMainMenuReplyMarkup(baseUrl));
  await askForFeedback(chatId);
}

async function processTelegramQuery(chatId, userText, baseUrl) {
  const kb = loadKB();
  const state = getOrCreateState(chatId);

  const dialogflowResult = await detectDialogflowIntent(userText, `tg-${chatId}`);

  if (dialogflowResult.ok && !dialogflowResult.isFallback && dialogflowResult.fulfillmentText) {
    state.suggestionIds = [];
    sessionState.set(String(chatId), state);
    await respondWithAnswer(chatId, userText, dialogflowResult.fulfillmentText, {
      detectedIntent: dialogflowResult.intentName,
      answerSource: 'dialogflow'
    }, baseUrl);
    return;
  }

  const explicitDirectionCard = detectDirectionCard(userText, kb);
  const bestCard = explicitDirectionCard || findBestCard(userText, kb);

  if (bestCard) {
    const answer = buildStructuredAnswer(bestCard, findBestChunk(userText, bestCard) || bestCard.answer);
    state.suggestionIds = bestCard.follow_up_ids || [];
    sessionState.set(String(chatId), state);
    await respondWithAnswer(chatId, userText, answer, {
      detectedIntent: dialogflowResult.ok ? dialogflowResult.intentName : '',
      answerSource: 'knowledge_base'
    }, baseUrl);
    return;
  }

  state.pendingHandoffReason = dialogflowResult.ok ? 'fallback_and_kb_miss' : `dialogflow_error:${dialogflowResult.stage || 'unknown'}`;
  sessionState.set(String(chatId), state);
  pushHistory(chatId, 'user', userText);
  await askForHandoff(chatId, baseUrl);
}


async function handleConsultationFlow(chatId, text, baseUrl) {
  const state = getOrCreateState(chatId);

  if (isConsultationStart(text)) {
    state.awaitingFeedback = false;
    state.awaitingHandoffConfirm = false;
    state.conversationState = 'awaiting_teacher_name';
    state.selectedTeacher = null;
    sessionState.set(String(chatId), state);
    pushHistory(chatId, 'user', text);
    const reply = 'Хорошо. Напишите ФИО преподавателя, к которому хотите записаться.';
    pushHistory(chatId, 'bot', reply);
    await sendTelegramMessage(chatId, reply, getMainMenuReplyMarkup(baseUrl));
    return true;
  }

  if (state.conversationState === 'awaiting_teacher_name') {
    const teacher = findTeacherByText(text);
    pushHistory(chatId, 'user', text);

    if (!teacher) {
      const reply = 'Не удалось найти преподавателя. Напишите ФИО полностью.';
      pushHistory(chatId, 'bot', reply);
      await sendTelegramMessage(chatId, reply, getMainMenuReplyMarkup(baseUrl));
      return true;
    }

    state.awaitingFeedback = false;
    state.awaitingHandoffConfirm = false;
    state.conversationState = 'awaiting_consultation_slot';
    state.selectedTeacher = teacher;
    sessionState.set(String(chatId), state);

    const reply = formatTeacherSlots(teacher);
    pushHistory(chatId, 'bot', reply);
    await sendTelegramMessage(chatId, reply, getMainMenuReplyMarkup(baseUrl));
    return true;
  }

  if (state.conversationState === 'awaiting_consultation_slot') {
    pushHistory(chatId, 'user', text);
    const teacher = state.selectedTeacher;
    const slots = getTeacherSlots(teacher);
    const match = normalize(text).match(/\d+/);
    const choice = match ? Number(match[0]) : NaN;

    if (!teacher || !Number.isInteger(choice) || choice < 1 || choice > slots.length) {
      const reply = 'Напишите номер подходящего времени из списка.';
      pushHistory(chatId, 'bot', reply);
      await sendTelegramMessage(chatId, reply, getMainMenuReplyMarkup(baseUrl));
      return true;
    }

    const slot = slots[choice - 1];
    state.conversationState = null;
    state.selectedTeacher = null;
    state.awaitingFeedback = false;
    state.awaitingHandoffConfirm = false;
    sessionState.set(String(chatId), state);

    const reply = [
      'Запись подтверждена.',
      '',
      `Преподаватель: ${teacher.full_name}`,
      `Дата: ${slot.date}`,
      `Время: ${slot.time}`,
      `Формат: ${slot.format || 'не указан'}`,
      '',
      'Перед встречей вам придёт напоминание.'
    ].join('\n');

    pushHistory(chatId, 'bot', reply);
    await sendTelegramMessage(chatId, reply, getMainMenuReplyMarkup(baseUrl));
    return true;
  }

  return false;
}

async function handleDeadlinesFlow(chatId, text, baseUrl) {
  const state = getOrCreateState(chatId);

  if (isDeadlinesRequest(text)) {
    state.awaitingFeedback = false;
    state.awaitingHandoffConfirm = false;
    state.conversationState = 'awaiting_deadlines_consent';
    sessionState.set(String(chatId), state);
    pushHistory(chatId, 'user', text);
    const reply = buildDeadlinesText(true);
    pushHistory(chatId, 'bot', reply);
    await sendTelegramMessage(chatId, reply, getMainMenuReplyMarkup(baseUrl));
    return true;
  }

  if (state.conversationState === 'awaiting_deadlines_consent' && isRemindersConsent(text)) {
    pushHistory(chatId, 'user', text);
    state.conversationState = null;
    state.remindersEnabled = true;
    state.awaitingFeedback = false;
    state.awaitingHandoffConfirm = false;
    sessionState.set(String(chatId), state);

    const reply = buildDeadlinesText(false);
    pushHistory(chatId, 'bot', reply);
    await sendTelegramMessage(chatId, reply, getMainMenuReplyMarkup(baseUrl));

    setTimeout(async () => {
      try {
        const followUp = 'Напоминания подключены. Теперь вы будете получать уведомления о ближайших событиях.';
        pushHistory(chatId, 'bot', followUp);
        await sendTelegramMessage(chatId, followUp, getMainMenuReplyMarkup(baseUrl));
      } catch (error) {
        console.error('Ошибка отправки напоминания:', error);
      }
    }, 10000);

    return true;
  }

  return false;
}

async function handleTelegramTextMessage(req, message) {
  const chatId = message.chat.id;
  const text = message.text || '';
  const normalized = normalize(text);
  const kb = loadKB();
  const baseUrl = getBaseUrl(req);
  const state = getOrCreateState(chatId);

  if (normalized === '/start' || normalized === 'start' || normalized === '/menu' || normalized === 'главное меню' || normalized === '🏠 главное меню') {
    state.awaitingFeedback = false;
    state.awaitingHandoffConfirm = false;
    state.conversationState = null;
    state.selectedTeacher = null;
    state.suggestionIds = [];
    sessionState.set(String(chatId), state);
    pushHistory(chatId, 'user', text);
    const menuText = getMainMenuText(kb);
    pushHistory(chatId, 'bot', menuText);
    await sendTelegramMessage(chatId, menuText, getMainMenuReplyMarkup(baseUrl));
    return;
  }

  const consultationHandled = await handleConsultationFlow(chatId, text, baseUrl);
  if (consultationHandled) return;

  const deadlinesHandled = await handleDeadlinesFlow(chatId, text, baseUrl);
  if (deadlinesHandled) return;

  if (state.awaitingFeedback) {
    const handled = await handleFeedbackResponse(chatId, text, baseUrl);
    if (handled) return;
  }

  if (state.awaitingHandoffConfirm) {
    const handled = await handleHandoffConfirm(chatId, text, baseUrl);
    if (handled) return;
  }

  if (isSpecialistRequest(text)) {
    pushHistory(chatId, 'user', text);
    createHandoff(chatId, 'user_requested_specialist');
    await sendTelegramMessage(
      chatId,
      'Хорошо, передаю ваш диалог специалисту. История обращения сохранена.',
      getMainMenuReplyMarkup(baseUrl)
    );
    return;
  }

  await processTelegramQuery(chatId, text, baseUrl);
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
    const update = req.body || {};
    const message = update.message || update.edited_message;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat?.id;
    const baseUrl = getBaseUrl(req);

    if (message.web_app_data?.data) {
      const payload = JSON.parse(message.web_app_data.data);

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
        const state = getOrCreateState(chatId);
        const directionCardId = findDirectionCardIdByProgram(program);
        const directionCard = directionCardId ? findCardById(kb, directionCardId) : null;

        state.lastProgramId = program.id;
        state.suggestionIds = directionCard?.follow_up_ids || [];
        sessionState.set(String(chatId), state);

        await respondWithAnswer(chatId, 'Выбор программы из каталога', buildProgramText(program), {
          detectedIntent: 'miniapp_program_selected',
          answerSource: 'miniapp'
        }, baseUrl);
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
    const queryResult = body?.queryResult || {};
    const intentName = queryResult?.intent?.displayName || '';
    const userText = queryResult?.queryText || '';
    const kb = loadKB();

    const explicitDirectionCard = detectDirectionCard(userText, kb);
    if (explicitDirectionCard) {
      return res.json({
        fulfillmentText: buildStructuredAnswer(explicitDirectionCard, findBestChunk(userText, explicitDirectionCard) || explicitDirectionCard.answer)
      });
    }

    const directCard = getCardByIntent(kb, intentName);
    if (directCard && directCard.id !== 'site_search') {
      return res.json({
        fulfillmentText: buildStructuredAnswer(directCard, findBestChunk(userText, directCard) || directCard.answer)
      });
    }

    const bestCard = findBestCard(userText, kb);
    if (bestCard) {
      return res.json({
        fulfillmentText: buildStructuredAnswer(bestCard, findBestChunk(userText, bestCard) || bestCard.answer)
      });
    }

    return res.json({
      fulfillmentText: 'Я не нашёл точного ответа. Уточните, пожалуйста, вопрос или напишите его по-другому.'
    });
  } catch (error) {
    console.error('Ошибка webhook:', error);
    return res.json({
      fulfillmentText: 'Произошла ошибка при обработке запроса. Попробуйте повторить запрос позже.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
