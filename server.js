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

function findPage(query, pages) {
  const lowerQuery = String(query || '').toLowerCase();

  for (const page of pages) {
    const title = String(page.title || '').toLowerCase();
    if (title && lowerQuery.includes(title)) {
      return page;
    }
  }

  return null;
}

app.get('/', (req, res) => {
  res.send('ET Education webhook работает');
});

app.post('/webhook', (req, res) => {
  try {
    const queryResult = req.body && req.body.queryResult ? req.body.queryResult : {};
    const userText = queryResult.queryText || '';

    const pages = loadPages();
    const foundPage = findPage(userText, pages);

    if (foundPage) {
      return res.json({
        fulfillmentText: 'Я нашёл информацию на странице "' + foundPage.title + '". Перейдите по ссылке: ' + foundPage.url
      });
    }

    return res.json({
      fulfillmentText: 'К сожалению, я не смог найти информацию на сайте. Попробуйте сформулировать вопрос иначе.'
    });
  } catch (error) {
    console.error('Ошибка webhook:', error);
    return res.json({
      fulfillmentText: 'Произошла ошибка при обработке запроса.'
    });
  }
});

app.listen(PORT, () => {
  console.log('Сервер запущен на порту ' + PORT);
});