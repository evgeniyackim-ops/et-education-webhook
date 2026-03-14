const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const KB_FILE = path.join(__dirname, 'knowledge_base.json');
const PROGRAM_CATALOG_FILE = path.join(__dirname, 'program_catalog.json');

// Раздача Mini App как статического приложения
app.use('/miniapp', express.static(path.join(__dirname, 'miniapp')));

// Простое in-memory хранение контекста диалога по session/chat id
const sessionState = new Map();

function loadKB() {
  const raw = fs.readFileSync(KB_FILE, 'utf8');
  return JSON.parse(raw);
}

function loadProgramCatalog() {
  const raw = fs.readFileSync(PROGRAM_CATALOG_FILE, 'utf8');
  return JSON.parse(raw);
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[ё]/g, 'е')
    .replace(/[^\u0000-\u007F\u0400-\u04FF\d\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSessionId(body) {
  return body?.session || body?.originalDetectIntentRequest?.payload?.data?.chat?.id || 'default-session';
}

function getQueryResult(body) {
  return body?.queryResult || {};
}

function getIntentName(queryResult) {
  return queryResult?.intent?.displayName || '';
}

function getAction(queryResult) {
  return queryResult?.action || '';
}

function getUserText(queryResult) {
  return queryResult?.queryText || '';
}

function getParameters(queryResult) {
  return queryResult?.parameters || {};
}

function isAffirmative(text) {
  const q = normalize(text);
  return [
    'да', 'давай', 'хорошо', 'ок', 'окей', 'конечно', 'покажи', 'хочу', 'ага', 'угу', 'покажи пожалуйста'
  ].includes(q);
}

function textIncludesAny(text, variants = []) {
  const q = normalize(text);
  return variants.some(v => q.includes(normalize(v)));
}

function buildCardMap(kb) {
  const map = new Map();
  for (const card of kb.cards || []) {
    map.set(card.id, card);
  }
  return map;
}

function getCardByIntent(kb, intentName) {
  const cardId = kb.intent_map?.[intentName];
  if (!cardId) return null;
  return (kb.cards || []).find(c => c.id === cardId) || null;
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
      return (kb.cards || []).find(c => c.id === id) || null;
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

function resolveFollowUpByUserText(userText, suggestions, kb) {
  if (!suggestions || suggestions.length === 0) return null;

  for (const suggestion of suggestions) {
    const aliases = kb.aliases?.[suggestion.id] || [];
    const haystack = [suggestion.title, ...(suggestion.keywords || []), ...aliases];
    if (textIncludesAny(userText, haystack)) {
      return suggestion;
    }
  }

  if (isAffirmative(userText)) {
    return suggestions[0];
  }

  return null;
}

function buildMenuKeyboardText(kb) {
  const main = (kb.cards || []).find(c => c.id === 'main_menu');
  return main ? buildStructuredAnswer(main) : 'Главное меню недоступно.';
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
    food: 'direction_food'
  };

  return map[program?.direction] || null;
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

async function sendTelegramMessage(chatId, text, replyMarkup = undefined) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('Не задан TELEGRAM_BOT_TOKEN');
  }

  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: false
  };

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram sendMessage error: ${JSON.stringify(data)}`);
  }

  return data;
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

// Telegram webhook для обработки ответа из Mini App: tg.sendData(...)
app.post('/telegram-webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const message = update.message;

    if (!message) {
      return res.sendStatus(200);
    }

    if (message.web_app_data?.data) {
      const payload = JSON.parse(message.web_app_data.data);
      console.log('Получены данные из Mini App:', payload);

      if (payload.type === 'program_selected') {
        const program = findProgramById(payload.id);

        if (!program) {
          await sendTelegramMessage(
            message.chat.id,
            'Не удалось найти выбранную программу. Откройте каталог ещё раз и попробуйте снова.'
          );
          return res.sendStatus(200);
        }

        const kb = loadKB();
        const directionCardId = findDirectionCardIdByProgram(program);
        const directionCard = directionCardId
          ? (kb.cards || []).find(card => card.id === directionCardId)
          : null;

        sessionState.set(String(message.chat.id), {
          lastProgramId: program.id,
          lastCardId: directionCard?.id || null,
          suggestionIds: directionCard?.follow_up_ids || []
        });

        const replyMarkup = {
          keyboard: [
            [{ text: '💰 Стоимость' }, { text: '📅 Расписание' }],
            [{ text: '📄 Документы' }, { text: '📞 Контакты' }],
            [{ text: '🏠 Главное меню' }]
          ],
          resize_keyboard: true
        };

        await sendTelegramMessage(
          message.chat.id,
          buildProgramText(program),
          replyMarkup
        );
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('Ошибка Telegram webhook:', error);
    return res.sendStatus(200);
  }
});

// Webhook Dialogflow
app.post('/webhook', (req, res) => {
  try {
    const body = req.body || {};
    const sessionId = getSessionId(body);
    const queryResult = getQueryResult(body);
    const intentName = getIntentName(queryResult);
    const action = getAction(queryResult);
    const userText = getUserText(queryResult);
    const parameters = getParameters(queryResult);
    const kb = loadKB();
    const cardMap = buildCardMap(kb);

    console.log('Session:', sessionId);
    console.log('Intent:', intentName);
    console.log('Action:', action);
    console.log('Query:', userText);
    console.log('Parameters:', parameters);

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
      const menuText = buildMenuKeyboardText(kb);
      const menuCard = cardMap.get('main_menu');
      sessionState.set(sessionId, {
        lastCardId: 'main_menu',
        suggestionIds: menuCard?.follow_up_ids || []
      });
      return res.json({ fulfillmentText: menuText });
    }

    const explicitDirectionCard = detectDirectionCard(userText, kb);
    if (explicitDirectionCard) {
      const chunk = findBestChunk(userText, explicitDirectionCard) || explicitDirectionCard.answer;
      const text = buildStructuredAnswer(explicitDirectionCard, chunk);
      sessionState.set(sessionId, {
        lastCardId: explicitDirectionCard.id,
        suggestionIds: explicitDirectionCard.follow_up_ids || []
      });
      return res.json({ fulfillmentText: text });
    }

    const directCard = getCardByIntent(kb, intentName);
    if (directCard && directCard.id !== 'site_search') {
      const chunk = findBestChunk(userText, directCard) || directCard.answer;
      const text = buildStructuredAnswer(directCard, chunk);
      sessionState.set(sessionId, {
        lastCardId: directCard.id,
        suggestionIds: directCard.follow_up_ids || []
      });
      return res.json({ fulfillmentText: text });
    }

    const directionName = normalize(parameters.direction_name || '');
    if (directionName) {
      const directionCard = detectDirectionCard(directionName, kb);
      if (directionCard) {
        const chunk = findBestChunk(userText || directionName, directionCard) || directionCard.answer;
        const text = buildStructuredAnswer(directionCard, chunk);
        sessionState.set(sessionId, {
          lastCardId: directionCard.id,
          suggestionIds: directionCard.follow_up_ids || []
        });
        return res.json({ fulfillmentText: text });
      }
    }

    const isSearchIntent = (
      intentName === 'site_search' ||
      intentName === 'site-search' ||
      intentName === 'Default Fallback Intent' ||
      action === 'search_site'
    );

    if (isSearchIntent || userText) {
      const bestCard = findBestCard(userText, kb);
      if (bestCard) {
        const bestChunk = findBestChunk(userText, bestCard) || bestCard.answer;
        const text = buildStructuredAnswer(bestCard, bestChunk);
        sessionState.set(sessionId, {
          lastCardId: bestCard.id,
          suggestionIds: bestCard.follow_up_ids || []
        });
        return res.json({ fulfillmentText: text });
      }
    }

    const fallbackText = 'Я не нашёл точного ответа. Уточните, пожалуйста: вас интересуют направления обучения, стоимость, контакты, реквизиты, документы, расписание или вход в СДО?';
    sessionState.set(sessionId, {
      lastCardId: 'site_search',
      suggestionIds: ['directions', 'price_list', 'contacts', 'documents', 'calendar', 'lms_login']
    });
    return res.json({ fulfillmentText: fallbackText });
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
