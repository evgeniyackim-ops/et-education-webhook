const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DEMO_REMINDER_DELAY_SECONDS = Number(process.env.DEMO_REMINDER_DELAY_SECONDS || 30);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '';
const DIALOGFLOW_PROJECT_ID = process.env.DIALOGFLOW_PROJECT_ID || '';
const DIALOGFLOW_LANGUAGE_CODE = process.env.DIALOGFLOW_LANGUAGE_CODE || 'ru';
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || '';
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\n/g, '\n');

const KB_FILE = path.join(__dirname, 'knowledge_base.json');
const PROGRAM_CATALOG_FILE = path.join(__dirname, 'program_catalog.json');
const TEACHERS_CONFIG_FILE = path.join(__dirname, 'teachers_config.json');

const miniappDir = fs.existsSync(path.join(__dirname, 'miniapp')) ? path.join(__dirname, 'miniapp') : __dirname;
app.use('/miniapp', express.static(miniappDir));

const sessionState = new Map();
const reminderTimers = new Map();

const fallbackTeachersConfig = {
  teachers: [],
  default_slots_pages: [
    [
      { date: '30.03.2026', time: '11:00', format: 'онлайн' },
      { date: '01.04.2026', time: '15:00', format: 'очно' },
      { date: '03.04.2026', time: '12:30', format: 'онлайн' }
    ],
    [
      { date: '06.04.2026', time: '10:30', format: 'онлайн' },
      { date: '08.04.2026', time: '16:00', format: 'очно' },
      { date: '10.04.2026', time: '13:00', format: 'онлайн' }
    ]
  ]
};

const demoDeadlines = [
  { type: 'deadline', title: 'Сдача итоговой работы', date: '25.03.2026' },
  { type: 'attestation', title: 'Промежуточная аттестация', date: '28.03.2026' },
  { type: 'deadline', title: 'Завершение тестирования', date: '30.03.2026' }
];

function loadKB() {
  return JSON.parse(fs.readFileSync(KB_FILE, 'utf8'));
}

function loadProgramCatalog() {
  return JSON.parse(fs.readFileSync(PROGRAM_CATALOG_FILE, 'utf8'));
}

function loadTeachersConfig() {
  try {
    if (!fs.existsSync(TEACHERS_CONFIG_FILE)) return fallbackTeachersConfig;
    const parsed = JSON.parse(fs.readFileSync(TEACHERS_CONFIG_FILE, 'utf8'));
    if (!Array.isArray(parsed.teachers)) return fallbackTeachersConfig;
    return parsed;
  } catch (e) {
    console.error('Ошибка чтения teachers_config.json, используется fallback-конфиг', e);
    return fallbackTeachersConfig;
  }
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
  return ['да', 'давай', 'хорошо', 'ок', 'окей', 'ага', 'угу', 'покажи', 'хочу', 'подтверждаю', 'записать', 'подходит'].includes(q);
}

function isNegative(text) {
  const q = normalize(text);
  return ['нет', 'не надо', 'отмена', 'отменить', 'не подходит'].includes(q);
}

function wantsOtherDates(text) {
  const q = normalize(text);
  return textIncludesAny(q, ['другие даты', 'другая дата', 'другие слоты', 'другое время', 'покажи еще', 'покажи другие', 'другой вариант', 'еще даты']);
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
  const directionCards = ['direction_labs', 'direction_ecology', 'direction_fire', 'direction_radiation', 'direction_electro', 'direction_food', 'direction_labor'];
  for (const id of directionCards) {
    const aliases = kb.aliases?.[id] || [];
    if (aliases.some(a => q.includes(normalize(a)))) return findCardById(kb, id);
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
  const cards = restrictToIds ? (kb.cards || []).filter(c => restrictToIds.includes(c.id)) : (kb.cards || []);
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
    if (textIncludesAny(userText, haystack)) return suggestion;
  }
  if (isAffirmative(userText)) return suggestionCards[0];
  return null;
}

function getBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/$/, '');
  const host = req.get('host') || '';
  if (host.includes('onrender.com')) return `https://${host}`;
  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol;
  return `${protocol}://${host}`;
}

function getMainMenuReplyMarkup(baseUrl) {
  return {
    keyboard: [
      [{ text: '📚 Каталог программ', web_app: { url: `${baseUrl}/miniapp` } }],
      [{ text: '🎓 Направления' }, { text: '💰 Стоимость' }],
      [{ text: '📅 Расписание' }, { text: '📄 Документы' }],
      [{ text: '👩‍🏫 Преподаватели' }, { text: '📞 Контакты' }],
      [{ text: '🗓 Консультация' }, { text: '⏰ Дедлайны' }],
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
      [{ text: '🗓 Консультация' }, { text: '⏰ Дедлайны' }],
      [{ text: '🏠 Главное меню' }]
    ],
    resize_keyboard: true
  };
}


function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createServiceAccountJwt() {
  if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: GOOGLE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const toSign = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(toSign), GOOGLE_PRIVATE_KEY)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${toSign}.${signature}`;
}

let googleAccessTokenCache = { token: null, expiresAt: 0 };

async function getGoogleAccessToken() {
  if (googleAccessTokenCache.token && Date.now() < googleAccessTokenCache.expiresAt - 60_000) {
    return googleAccessTokenCache.token;
  }
  const assertion = createServiceAccountJwt();
  if (!assertion) return null;

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
    throw new Error(`Google OAuth error: ${JSON.stringify(data)}`);
  }
  googleAccessTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
  };
  return googleAccessTokenCache.token;
}

async function detectDialogflowIntent(text, sessionId) {
  if (!DIALOGFLOW_PROJECT_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) return null;
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) return null;
  const safeSessionId = encodeURIComponent(`telegram-${sessionId}`);
  const url = `https://dialogflow.googleapis.com/v2/projects/${encodeURIComponent(DIALOGFLOW_PROJECT_ID)}/agent/sessions/${safeSessionId}:detectIntent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      queryInput: {
        text: {
          text,
          languageCode: DIALOGFLOW_LANGUAGE_CODE
        }
      }
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Dialogflow detectIntent error: ${JSON.stringify(data)}`);
  }
  return data.queryResult || null;
}

function shouldUseDialogflowResult(queryResult) {
  if (!queryResult) return false;
  const intentName = queryResult.intent?.displayName || '';
  const fulfillmentText = String(queryResult.fulfillmentText || '').trim();
  if (!intentName) return false;
  if (intentName === 'Default Fallback Intent') return false;
  if (!fulfillmentText) return false;
  return true;
}

async function sendTelegramMessage(chatId, text, replyMarkup = undefined) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('Не задан TELEGRAM_BOT_TOKEN');
  const payload = { chat_id: chatId, text, disable_web_page_preview: false };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`Telegram sendMessage error: ${JSON.stringify(data)}`);
  return data;
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
  return loadProgramCatalog().find(item => item.id === id) || null;
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

function findTeacherMatch(userText) {
  const cfg = loadTeachersConfig();
  const q = normalize(userText);
  for (const teacher of cfg.teachers || []) {
    const variants = [teacher.full_name, ...(teacher.aliases || [])].map(normalize);
    if (variants.some(v => q === v || q.includes(v) || v.includes(q))) return teacher;
  }
  return null;
}

function buildTeacherSuggestionsText() {
  const cfg = loadTeachersConfig();
  const names = (cfg.teachers || []).map(t => `• ${t.full_name}`).join('\n');
  return names
    ? `Преподаватель не найден. Проверьте написание и выберите один из вариантов:\n\n${names}`
    : 'Преподаватель не найден. Проверьте написание фамилии или ФИО.';
}


function getSlotsPageForTeacher(teacher, pageIndex = 0) {
  const cfg = loadTeachersConfig();
  const pages = teacher?.slots_pages?.length ? teacher.slots_pages : cfg.default_slots_pages || fallbackTeachersConfig.default_slots_pages;
  const idx = Math.max(0, Math.min(pageIndex, pages.length - 1));
  return { slots: pages[idx], pageIndex: idx, totalPages: pages.length };
}

function formatSlots(slots) {
  return slots.map((slot, index) => `${index + 1}. ${slot.date} в ${slot.time} (${slot.format})`).join('\n');
}

function buildConsultationSlotsText(teacher, slots, pageIndex, totalPages) {
  const teacherName = teacher?.full_name || 'выбранного преподавателя';
  const teacherMeta = teacher?.direction ? `Направление: ${teacher.direction}.\n` : '';
  const moreHint = pageIndex < totalPages - 1
    ? 'Если эти варианты не подходят, напишите: «другие даты». Тогда я покажу окна с 6 по 10 апреля.\n'
    : 'Это вторая подборка дат. Если хотите, можно выбрать один из вариантов ниже.\n';
  return `Доступные даты для консультации у преподавателя «${teacherName}»:\n${teacherMeta}\n${formatSlots(slots)}\n\n${moreHint}Напишите номер варианта, дату или время, которое вам подходит.`;
}

function pickSlotFromUserText(userText, slots) {
  const q = normalize(userText);
  if (q === '1' || q.includes('перв')) return slots[0] || null;
  if (q === '2' || q.includes('втор')) return slots[1] || null;
  if (q === '3' || q.includes('трет')) return slots[2] || null;
  return slots.find(s => q.includes(normalize(s.date)) || q.includes(normalize(s.time))) || null;
}

function buildDeadlinesText() {
  const lines = demoDeadlines.map(item => `• ${item.date} — ${item.title}`);
  return ['Ближайшие учебные события:', ...lines, '', 'Чтобы подключить демонстрационные напоминания, напишите: «включи напоминания о дедлайнах».'].join('\n');
}

function reminderLabelByType(value) {
  const q = normalize(value);
  if (q.includes('аттест')) return 'об аттестациях';
  if (q.includes('все')) return 'обо всех учебных событиях';
  return 'о дедлайнах';
}

async function scheduleDemoReminder(chatId, reminderType, baseUrl) {
  if (!chatId) return;
  const key = String(chatId);
  if (reminderTimers.has(key)) {
    clearTimeout(reminderTimers.get(key));
    reminderTimers.delete(key);
  }
  const timer = setTimeout(async () => {
    try {
      const firstEvent = demoDeadlines[0];
      await sendTelegramMessage(
        chatId,
        `🔔 Напоминание ${reminderLabelByType(reminderType)}:\n${firstEvent.date} — ${firstEvent.title}.\n\nЭто демонстрация проактивного сообщения бота для ВКР.`,
        getMainMenuReplyMarkup(baseUrl)
      );
    } catch (e) {
      console.error('Ошибка отправки демо-напоминания:', e);
    } finally {
      reminderTimers.delete(key);
    }
  }, DEMO_REMINDER_DELAY_SECONDS * 1000);
  reminderTimers.set(key, timer);
}

async function handleTelegramTextMessage(req, message) {
  const chatId = message.chat.id;
  const text = message.text || '';
  const normalized = normalize(text);
  const kb = loadKB();
  const cardMap = buildCardMap(kb);
  const baseUrl = getBaseUrl(req);

  if (normalized === '/start' || normalized === 'start' || normalized === '/menu' || normalized === 'главное меню' || normalized === '🏠 главное меню') {
    const menuText = getMainMenuText(kb);
    const mainCard = findCardById(kb, 'main_menu');
    sessionState.set(String(chatId), { lastCardId: 'main_menu', suggestionIds: mainCard?.follow_up_ids || [] });
    await sendTelegramMessage(chatId, menuText, getMainMenuReplyMarkup(baseUrl));
    return;
  }

  const previousState = sessionState.get(String(chatId)) || null;

  if (previousState?.flow === 'consultation' && previousState?.step === 'awaiting_teacher') {
    const teacher = findTeacherMatch(text);
    if (!teacher) {
      await sendTelegramMessage(chatId, 'Я не смогла точно определить преподавателя. Напишите, пожалуйста, фамилию или ФИО так, как они указаны на сайте.', getMainMenuReplyMarkup(baseUrl));
      return;
    }
    const page = getSlotsPageForTeacher(teacher, 0);
    sessionState.set(String(chatId), {
      flow: 'consultation',
      step: 'awaiting_slot',
      teacher,
      slots: page.slots,
      pageIndex: page.pageIndex,
      totalPages: page.totalPages
    });
    await sendTelegramMessage(chatId, buildConsultationSlotsText(teacher, page.slots, page.pageIndex, page.totalPages), getMainMenuReplyMarkup(baseUrl));
    return;
  }

  if (previousState?.flow === 'consultation' && previousState?.step === 'awaiting_slot') {
    if (wantsOtherDates(text)) {
      const nextPageIndex = previousState.pageIndex + 1;
      if (nextPageIndex >= previousState.totalPages) {
        await sendTelegramMessage(chatId, 'Других свободных слотов после 10 апреля в демонстрационном расписании пока нет. Выберите один из предложенных вариантов или начните запись заново.', getMainMenuReplyMarkup(baseUrl));
        return;
      }
      const page = getSlotsPageForTeacher(previousState.teacher, nextPageIndex);
      sessionState.set(String(chatId), {
        ...previousState,
        slots: page.slots,
        pageIndex: page.pageIndex,
        totalPages: page.totalPages
      });
      await sendTelegramMessage(chatId, buildConsultationSlotsText(previousState.teacher, page.slots, page.pageIndex, page.totalPages), getMainMenuReplyMarkup(baseUrl));
      return;
    }

    const selectedSlot = pickSlotFromUserText(text, previousState.slots || []);
    if (!selectedSlot) {
      await sendTelegramMessage(chatId, 'Я не смогла определить выбранный слот. Напишите номер варианта, например «1», или попросите «другие даты».', getMainMenuReplyMarkup(baseUrl));
      return;
    }

    sessionState.set(String(chatId), { ...previousState, step: 'awaiting_confirmation', selectedSlot });
    await sendTelegramMessage(chatId, `Подтвердите запись:\nПреподаватель: ${previousState.teacher.full_name}\nДата: ${selectedSlot.date}\nВремя: ${selectedSlot.time}\nФормат: ${selectedSlot.format}\n\nНапишите «да», чтобы подтвердить, или «нет», чтобы отменить запись.`, getMainMenuReplyMarkup(baseUrl));
    return;
  }

  if (previousState?.flow === 'consultation' && previousState?.step === 'awaiting_confirmation') {
    if (isAffirmative(text)) {
      const slot = previousState.selectedSlot || {};
      sessionState.set(String(chatId), { flow: null, step: null });
      await sendTelegramMessage(chatId, `Вы записаны на консультацию.\nПреподаватель: ${previousState.teacher.full_name}\nДата: ${slot.date || '-'}\nВремя: ${slot.time || '-'}\nФормат: ${slot.format || '-'}\n\nЭто демонстрационный сценарий записи для ВКР.`, getMainMenuReplyMarkup(baseUrl));
      return;
    }
    if (isNegative(text)) {
      sessionState.set(String(chatId), { flow: null, step: null });
      await sendTelegramMessage(chatId, 'Запись отменена. Если хотите, можно начать заново и выбрать другого преподавателя.', getMainMenuReplyMarkup(baseUrl));
      return;
    }
    await sendTelegramMessage(chatId, 'Напишите «да», чтобы подтвердить запись, или «нет», чтобы отменить.', getMainMenuReplyMarkup(baseUrl));
    return;
  }

  if (previousState?.suggestionIds?.length) {
    const suggestionCards = previousState.suggestionIds.map(id => cardMap.get(id)).filter(Boolean);
    const followUpCard = resolveFollowUpByUserText(text, suggestionCards, kb);
    if (followUpCard) {
      const chunk = findBestChunk(text, followUpCard) || followUpCard.answer;
      const answer = buildStructuredAnswer(followUpCard, chunk);
      sessionState.set(String(chatId), { lastCardId: followUpCard.id, suggestionIds: followUpCard.follow_up_ids || [] });
      await sendTelegramMessage(chatId, answer, getMainMenuReplyMarkup(baseUrl));
      return;
    }
  }

  if (textIncludesAny(text, ['запись на консультацию', 'консультация', 'нужна консультация', '🗓 консультация'])) {
    sessionState.set(String(chatId), { flow: 'consultation', step: 'awaiting_teacher' });
    await sendTelegramMessage(chatId, 'Я помогу оформить запись на консультацию. Напишите, пожалуйста, фамилию или ФИО преподавателя.', getMainMenuReplyMarkup(baseUrl));
    return;
  }

  if (textIncludesAny(text, ['дедлайны', 'напоминания', 'аттестации', 'сроки сдачи', '⏰ дедлайны'])) {
    if (textIncludesAny(text, ['включи напоминания', 'подключи напоминания', 'напоминай', 'уведомления'])) {
      await scheduleDemoReminder(chatId, text, baseUrl);
      await sendTelegramMessage(chatId, `Напоминания ${reminderLabelByType(text)} подключены. Через ${DEMO_REMINDER_DELAY_SECONDS} сек. бот сам отправит демонстрационное сообщение в этот чат.`, getMainMenuReplyMarkup(baseUrl));
      return;
    }
    await sendTelegramMessage(chatId, buildDeadlinesText(), getMainMenuReplyMarkup(baseUrl));
    return;
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
        sessionState.set(String(chatId), { lastCardId: card.id, suggestionIds: card.follow_up_ids || [] });
        await sendTelegramMessage(chatId, answer, getMainMenuReplyMarkup(baseUrl));
        return;
      }
    }
  }

  const explicitDirectionCard = detectDirectionCard(text, kb);
  if (explicitDirectionCard) {
    const answer = buildStructuredAnswer(explicitDirectionCard, findBestChunk(text, explicitDirectionCard) || explicitDirectionCard.answer);
    sessionState.set(String(chatId), { lastCardId: explicitDirectionCard.id, suggestionIds: explicitDirectionCard.follow_up_ids || [] });
    await sendTelegramMessage(chatId, answer, getMainMenuReplyMarkup(baseUrl));
    return;
  }

  const bestCard = findBestCard(text, kb);
  if (bestCard) {
    const answer = buildStructuredAnswer(bestCard, findBestChunk(text, bestCard) || bestCard.answer);
    sessionState.set(String(chatId), { lastCardId: bestCard.id, suggestionIds: bestCard.follow_up_ids || [] });
    await sendTelegramMessage(chatId, answer, getMainMenuReplyMarkup(baseUrl));
    return;
  }

  await sendTelegramMessage(chatId, 'Я не нашёл точного ответа. Напишите, пожалуйста: направления обучения, стоимость, документы, расписание, контакты или откройте каталог программ.', getMainMenuReplyMarkup(baseUrl));
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
      programs = programs.filter(program => Array.isArray(program.formats) && program.formats.includes(format));
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
          await sendTelegramMessage(chatId, 'Не удалось найти выбранную программу. Откройте каталог ещё раз и попробуйте снова.', getProgramReplyMarkup(baseUrl));
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

    await sendTelegramMessage(chatId, 'Пожалуйста, отправьте текстовый запрос или откройте каталог программ.', getMainMenuReplyMarkup(baseUrl));
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

    if (action === 'consultation.start' || intentName === 'consultation_booking_start') {
      sessionState.set(sessionId, { flow: 'consultation', step: 'awaiting_teacher' });
      return res.json({ fulfillmentText: 'Я помогу оформить запись на консультацию. Укажите, пожалуйста, фамилию или ФИО преподавателя.' });
    }

    if (action === 'consultation.teacher' || intentName === 'consultation_booking_teacher') {
      const teacherText = parameters.consultation_teacher || parameters.teacher_request || userText;
      const teacher = findTeacherMatch(teacherText);
      if (!teacher) {
        return res.json({ fulfillmentText: buildTeacherSuggestionsText() });
      }
      const page = getSlotsPageForTeacher(teacher, 0);
      sessionState.set(sessionId, {
        flow: 'consultation',
        step: 'awaiting_slot',
        teacher,
        slots: page.slots,
        pageIndex: page.pageIndex,
        totalPages: page.totalPages
      });
      return res.json({ fulfillmentText: buildConsultationSlotsText(teacher, page.slots, page.pageIndex, page.totalPages) });
    }

    if (action === 'consultation.slot' || intentName === 'consultation_booking_slot') {
      const state = sessionState.get(sessionId) || {};
      if (wantsOtherDates(userText)) {
        const nextPageIndex = (state.pageIndex || 0) + 1;
        if (nextPageIndex >= (state.totalPages || 1)) {
          return res.json({ fulfillmentText: 'Других свободных слотов после 10 апреля в демонстрационном расписании пока нет. Выберите один из предложенных вариантов или начните запись заново.' });
        }
        const page = getSlotsPageForTeacher(state.teacher, nextPageIndex);
        sessionState.set(sessionId, { ...state, slots: page.slots, pageIndex: page.pageIndex, totalPages: page.totalPages });
        return res.json({ fulfillmentText: buildConsultationSlotsText(state.teacher, page.slots, page.pageIndex, page.totalPages) });
      }
      const selectedSlot = pickSlotFromUserText(userText, state.slots || []);
      if (!selectedSlot) {
        return res.json({ fulfillmentText: 'Я не смогла определить выбранный слот. Напишите номер варианта, например «1», или попросите «другие даты».' });
      }
      sessionState.set(sessionId, { ...state, step: 'awaiting_confirmation', selectedSlot });
      return res.json({ fulfillmentText: `Подтвердите запись:\nПреподаватель: ${state.teacher?.full_name || 'не указан'}\nДата: ${selectedSlot.date}\nВремя: ${selectedSlot.time}\nФормат: ${selectedSlot.format}\n\nНапишите «да», чтобы подтвердить, или «нет», чтобы отменить запись.` });
    }

    if (action === 'consultation.confirm' || intentName === 'consultation_booking_confirm') {
      const state = sessionState.get(sessionId) || {};
      if (isAffirmative(userText)) {
        sessionState.set(sessionId, { flow: null, step: null });
        return res.json({ fulfillmentText: `Вы записаны на консультацию.\nПреподаватель: ${state.teacher?.full_name || 'не указан'}\nДата: ${state.selectedSlot?.date || '-'}\nВремя: ${state.selectedSlot?.time || '-'}\nФормат: ${state.selectedSlot?.format || '-'}\n\nЭто демонстрационный сценарий записи для ВКР.` });
      }
      sessionState.set(sessionId, { flow: null, step: null });
      return res.json({ fulfillmentText: 'Запись отменена. Если хотите, можно выбрать другого преподавателя или другое время.' });
    }

    if (action === 'reminders.show' || intentName === 'deadlines_info') {
      return res.json({ fulfillmentText: buildDeadlinesText() });
    }

    if (action === 'reminders.subscribe' || intentName === 'reminders_subscribe') {
      return res.json({ fulfillmentText: `Напоминания ${reminderLabelByType(parameters.reminder_type || userText)} подключены. В Telegram-версии бот сам отправит демонстрационное сообщение через ${DEMO_REMINDER_DELAY_SECONDS} сек.` });
    }

    if (previousState?.suggestionIds?.length) {
      const suggestionCards = previousState.suggestionIds.map(id => cardMap.get(id)).filter(Boolean);
      const followUpCard = resolveFollowUpByUserText(userText, suggestionCards, kb);
      if (followUpCard) {
        const chunk = findBestChunk(userText, followUpCard) || followUpCard.answer;
        const text = buildStructuredAnswer(followUpCard, chunk);
        sessionState.set(sessionId, { lastCardId: followUpCard.id, suggestionIds: followUpCard.follow_up_ids || [] });
        return res.json({ fulfillmentText: text });
      }
    }

    if (intentName === 'main_menu') {
      const mainCard = findCardById(kb, 'main_menu');
      sessionState.set(sessionId, { lastCardId: 'main_menu', suggestionIds: mainCard?.follow_up_ids || [] });
      return res.json({ fulfillmentText: getMainMenuText(kb) });
    }

    const explicitDirectionCard = detectDirectionCard(userText, kb);
    if (explicitDirectionCard) {
      const text = buildStructuredAnswer(explicitDirectionCard, findBestChunk(userText, explicitDirectionCard) || explicitDirectionCard.answer);
      sessionState.set(sessionId, { lastCardId: explicitDirectionCard.id, suggestionIds: explicitDirectionCard.follow_up_ids || [] });
      return res.json({ fulfillmentText: text });
    }

    const directCard = getCardByIntent(kb, intentName);
    if (directCard && directCard.id !== 'site_search') {
      const text = buildStructuredAnswer(directCard, findBestChunk(userText, directCard) || directCard.answer);
      sessionState.set(sessionId, { lastCardId: directCard.id, suggestionIds: directCard.follow_up_ids || [] });
      return res.json({ fulfillmentText: text });
    }

    const directionName = normalize(parameters.direction_name || '');
    if (directionName) {
      const directionCard = detectDirectionCard(directionName, kb);
      if (directionCard) {
        const text = buildStructuredAnswer(directionCard, findBestChunk(userText || directionName, directionCard) || directionCard.answer);
        sessionState.set(sessionId, { lastCardId: directionCard.id, suggestionIds: directionCard.follow_up_ids || [] });
        return res.json({ fulfillmentText: text });
      }
    }

    const isSearchIntent = intentName === 'site_search' || intentName === 'site-search' || intentName === 'Default Fallback Intent' || action === 'search_site';
    if (isSearchIntent || userText) {
      const bestCard = findBestCard(userText, kb);
      if (bestCard) {
        const text = buildStructuredAnswer(bestCard, findBestChunk(userText, bestCard) || bestCard.answer);
        sessionState.set(sessionId, { lastCardId: bestCard.id, suggestionIds: bestCard.follow_up_ids || [] });
        return res.json({ fulfillmentText: text });
      }
    }

    sessionState.set(sessionId, {
      lastCardId: 'site_search',
      suggestionIds: ['directions', 'price_list', 'contacts', 'documents', 'calendar', 'lms_login']
    });

    return res.json({
      fulfillmentText: 'Я не нашёл точного ответа. Уточните, пожалуйста: вас интересуют направления обучения, стоимость, контакты, реквизиты, документы, расписание или вход в СДО?'
    });
  } catch (error) {
    console.error('Ошибка webhook:', error);
    return res.json({
      fulfillmentText: 'Произошла ошибка при обработке запроса. Попробуйте повторить запрос или выберите один из разделов: контакты, направления обучения, стоимость, документы, расписание, вход в СДО.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
