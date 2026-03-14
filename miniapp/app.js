const tg = window.Telegram.WebApp;
tg.ready();

const cardsContainer = document.getElementById('cards');
const directionFilter = document.getElementById('directionFilter');
const formatFilter = document.getElementById('formatFilter');

let allPrograms = [];

async function loadPrograms() {
  try {
    const response = await fetch('/api/programs');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    allPrograms = await response.json();
    renderCards(allPrograms);
  } catch (error) {
    console.error('Ошибка загрузки программ:', error);
    cardsContainer.innerHTML = '<div class="empty-state">Не удалось загрузить каталог программ.</div>';
  }
}

function renderCards(programs) {
  if (!programs.length) {
    cardsContainer.innerHTML = '<div class="empty-state">По выбранным фильтрам ничего не найдено.</div>';
    return;
  }

  cardsContainer.innerHTML = programs.map(program => `
    <article class="card">
      <div class="card-top">
        <div class="icon">${escapeHtml(program.direction_icon || '📘')}</div>
        <div>
          <h2>${escapeHtml(program.title)}</h2>
          <div class="direction-line">${escapeHtml(program.direction_label)}</div>
        </div>
      </div>

      <div class="description">${escapeHtml(program.short_description || program.goal || '')}</div>

      <div class="meta">
        <div><strong>Срок:</strong> ${escapeHtml(program.duration || 'Не указано')}</div>
        <div><strong>Документ:</strong> ${escapeHtml(program.certificate || 'Не указано')}</div>
        <div><strong>Стоимость:</strong> ${escapeHtml(program.price || 'Не указано')}</div>
      </div>

      <div class="tags">
        ${(program.formats || []).map(format => `<span class="tag">${escapeHtml(format)}</span>`).join('')}
      </div>

      <div class="actions">
        <button class="primary" onclick="showDetails('${program.id}')">Подробнее</button>
        <button class="secondary" onclick="openSite('${program.url}')">Открыть на сайте</button>
        <button class="secondary" onclick="askBot('${program.id}', '${encodeURIComponent(program.title)}')">Спросить у бота</button>
      </div>
    </article>
  `).join('');
}

function applyFilters() {
  const selectedDirection = directionFilter.value;
  const selectedFormat = formatFilter.value;

  const filtered = allPrograms.filter(program => {
    const directionOk = !selectedDirection || program.direction === selectedDirection;
    const formatOk = !selectedFormat || (program.formats || []).includes(selectedFormat);
    return directionOk && formatOk;
  });

  renderCards(filtered);
}

function showDetails(id) {
  const program = allPrograms.find(item => item.id === id);
  if (!program) return;

  cardsContainer.innerHTML = `
    <article class="card">
      <div class="card-top">
        <div class="icon">${escapeHtml(program.direction_icon || '📘')}</div>
        <div>
          <h2>${escapeHtml(program.title)}</h2>
          <div class="direction-line">${escapeHtml(program.direction_label)}</div>
        </div>
      </div>

      <div class="meta">
        <div><strong>Срок освоения:</strong> ${escapeHtml(program.duration || 'Не указано')}</div>
        <div><strong>Форма обучения:</strong> ${escapeHtml((program.formats || []).join(', ') || 'Не указано')}</div>
        <div><strong>Документ:</strong> ${escapeHtml(program.certificate || 'Не указано')}</div>
        <div><strong>Стоимость:</strong> ${escapeHtml(program.price || 'Не указано')}</div>
      </div>

      <div class="description"><strong>Краткое описание:</strong> ${escapeHtml(program.short_description || 'Не указано')}</div>
      <div class="description"><strong>Цель программы:</strong> ${escapeHtml(program.goal || 'Не указано')}</div>

      <div class="actions">
        <button class="primary" onclick="openSite('${program.url}')">Открыть на сайте</button>
        <button class="secondary" onclick="askBot('${program.id}', '${encodeURIComponent(program.title)}')">Спросить у бота</button>
        <button class="secondary" onclick="goBack()">Назад</button>
      </div>
    </article>
  `;
}

function goBack() {
  applyFilters();
}

function openSite(url) {
  if (!url) return;
  window.open(url, '_blank');
}

function askBot(id, encodedTitle) {
  const title = decodeURIComponent(encodedTitle || '');
  tg.sendData(JSON.stringify({
    type: 'program_selected',
    id,
    title
  }));
}

function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

directionFilter.addEventListener('change', applyFilters);
formatFilter.addEventListener('change', applyFilters);

loadPrograms();
