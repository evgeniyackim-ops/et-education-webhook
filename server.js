const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

function loadPages() {
  const filePath = path.join(__dirname, 'pages.json');
  const data = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(data);
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findPage(query, pages) {
  const lowerQuery = normalize(query);

  let bestPage = null;
  let bestScore = 0;

  for (const page of pages) {
    const title = normalize(page.title);
    const keywords = (page.keywords || []).map(normalize);

    let score = 0;

    if (lowerQuery === title) score += 10;
    if (lowerQuery.includes(title)) score += 6;
    if (title.includes(lowerQuery) && lowerQuery.length > 3) score += 5;

    const queryWords = lowerQuery.split(' ').filter(w => w.length > 2);

    for (const word of queryWords) {
      if (title.includes(word)) score += 2;
      if (keywords.some(k => k.includes(word))) score += 3;
    }

    if (score > bestScore) {
      bestScore = score;
      bestPage = page;
    }
  }

  return bestScore > 0 ? bestPage : null;
}

function buildResponse(page) {
  if (!page) {
    return 'К сожалению, я не смог найти точную информацию на сайте. Попробуйте уточнить вопрос.';
  }

  if (page.shortText) {
    return `${page.shortText} Подробнее: ${page.url}`;
  }

  return `Я нашёл подходящий раздел: «${page.title}». Ссылка: ${page.url}`;
}

app.get('/', (req, res) => {
  res.send('ET Education webhook работает');
});

app.post('/webhook', (req, res) => {
  try {

    const queryResult = req.body?.queryResult || {};
    const userText = queryResult.queryText || '';
    const intentName = queryResult.intent?.displayName || '';
    const action = queryResult.action || '';

    console.log('Intent:', intentName);
    console.log('Action:', action);
    console.log('Query:', userText);

    const pages = loadPages();

    if (
      intentName === 'site-search' ||
      action === 'search_site' ||
      intentName === 'Default Fallback Intent'
    ) {

      const foundPage = findPage(userText, pages);
      const answer = buildResponse(foundPage);

      return res.json({
        fulfillmentText: answer
      });
    }

    return res.json({
      fulfillmentText: `Webhook работает. Сработал интент: ${intentName || 'без названия'}.`
    });

  } catch (error) {

    console.error('Ошибка webhook:', error);

    return res.json({
      fulfillmentText: 'Произошла ошибка при обработке запроса на сервере.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});