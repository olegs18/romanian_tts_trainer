'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const storageKey = 'romanian-tts-trainer-v4';

const state = {
  phrases: [],
  defaults: [],
  playing: false,
  stopToken: 0,
  dialogIndex: null,
  dialogSearch: null,
  maxImageBytes: 12 * 1024 * 1024,
};

function parseLines(text) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const parts = line.includes('|') ? line.split('|') : line.split('\t');
    return {
      ro: (parts[0] || '').trim(),
      ru: (parts[1] || '').trim(),
      query: (parts[2] || '').trim(),
    };
  }).filter(item => item.ro);
}

function serializeLines(phrases) {
  return phrases.map(p => [p.ro, p.ru, p.query].filter((value, index) => index < 2 || value).join(' | ')).join('\n');
}

function defaultText() {
  return state.defaults.map(([ro, ru, query]) => `${ro} | ${ru} | ${query || ''}`).join('\n');
}

function saveState() {
  const payload = {
    phrases: $('#phrasesInput').value,
    voice: $('#voice').value,
    rate: $('#rate').value,
    pitch: $('#pitch').value,
    pause: $('#pause').value,
    repeats: $('#repeats').value,
    listMode: $('#listMode').value,
    hideTranslation: $('#hideTranslation').checked,
  };
  localStorage.setItem(storageKey, JSON.stringify(payload));
}

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); }
  catch { return {}; }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`HTTP ${response.status}`); }
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setCardStatus(card, text, kind = '') {
  const el = $('.card-status', card);
  el.textContent = text;
  el.className = `card-status muted ${kind}`.trim();
}

function sleep(ms, token) {
  return new Promise(resolve => {
    const started = performance.now();
    const tick = () => {
      if (token !== state.stopToken || performance.now() - started >= ms) resolve();
      else setTimeout(tick, Math.min(100, ms));
    };
    tick();
  });
}

function playAudio(url, token) {
  return new Promise((resolve, reject) => {
    if (token !== state.stopToken) return resolve();
    const audio = $('#audio');
    const cleanup = () => {
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
    const onEnded = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('Браузер не смог воспроизвести аудио')); };
    audio.addEventListener('ended', onEnded, { once: true });
    audio.addEventListener('error', onError, { once: true });
    audio.src = url;
    audio.play().catch(error => { cleanup(); reject(error); });
  });
}

async function getAudio(phrase) {
  return api('/api/audio', {
    method: 'POST',
    body: JSON.stringify({
      text: phrase.ro,
      voice: $('#voice').value,
      rate: Number($('#rate').value),
      pitch: Number($('#pitch').value),
    }),
  });
}

async function playPhrase(index, token) {
  const phrase = state.phrases[index];
  const card = $$('.card')[index];
  if (!phrase || !card || token !== state.stopToken) return;
  $$('.card').forEach(c => c.classList.remove('active'));
  card.classList.add('active');
  $('#playbackStatus').textContent = `${index + 1}/${state.phrases.length}: ${phrase.ro}`;
  setCardStatus(card, 'готовлю аудио…');
  const audioData = await getAudio(phrase);
  setCardStatus(card, audioData.cached ? 'аудио из кеша' : 'аудио создано', 'ok');
  const repeats = Number($('#repeats').value);
  const pauseMs = Math.max(0, Number($('#pause').value) || 0) * 1000;
  for (let repeat = 0; repeat < repeats && token === state.stopToken; repeat++) {
    await playAudio(audioData.url, token);
    if (repeat < repeats - 1 && token === state.stopToken) await sleep(pauseMs, token);
  }
}

async function playAll() {
  stopPlayback();
  const token = state.stopToken;
  state.playing = true;
  $('#playAll').disabled = true;
  try {
    do {
      for (let i = 0; i < state.phrases.length && token === state.stopToken; i++) {
        await playPhrase(i, token);
      }
    } while ($('#listMode').value === 'loop' && token === state.stopToken);
  } catch (error) {
    $('#playbackStatus').textContent = error.message;
  } finally {
    if (token === state.stopToken) {
      state.playing = false;
      $('#playAll').disabled = false;
      $$('.card').forEach(c => c.classList.remove('active'));
    }
  }
}

function stopPlayback() {
  state.stopToken += 1;
  state.playing = false;
  const audio = $('#audio');
  audio.pause();
  audio.removeAttribute('src');
  $('#playAll').disabled = false;
  $('#playbackStatus').textContent = 'Остановлено';
  $$('.card').forEach(c => c.classList.remove('active'));
}

function imagePayload(phrase) {
  return { text: phrase.ro, translation: phrase.ru, query: phrase.query || '' };
}

function clearImage(card) {
  const img = $('.mnemonic-image', card);
  img.hidden = true;
  img.removeAttribute('src');
  $('.image-placeholder', card).hidden = false;
  renderCredit(card, null);
}

function makeExternalLink(url, label) {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = label;
  return link;
}

function renderCredit(card, image) {
  const credit = $('.image-credit', card);
  credit.innerHTML = '';
  if (!image) {
    credit.hidden = true;
    return;
  }

  const pieces = [];
  const sourceType = image.source_type || 'openverse';
  if (sourceType === 'openverse') {
    if (image.creator) pieces.push(document.createTextNode('Автор: ' + image.creator));
    if (image.license) {
      const licenseText = (image.license + (image.license_version ? ' ' + image.license_version : '')).toUpperCase();
      pieces.push(image.license_url ? makeExternalLink(image.license_url, licenseText) : document.createTextNode(licenseText));
    }
    if (image.source_url) pieces.push(makeExternalLink(image.source_url, 'источник'));
  } else if (sourceType === 'file') {
    pieces.push(document.createTextNode('Локальный файл' + (image.original_filename ? ': ' + image.original_filename : '')));
  } else if (sourceType === 'clipboard') {
    pieces.push(document.createTextNode('Вставлено из буфера обмена'));
  } else if (sourceType === 'url') {
    pieces.push(document.createTextNode('Загружено по ссылке'));
    if (image.source_url) pieces.push(makeExternalLink(image.source_url, 'источник'));
  } else {
    pieces.push(document.createTextNode('Пользовательское изображение'));
  }

  pieces.forEach((piece, i) => {
    if (i) credit.append(document.createTextNode(' · '));
    credit.append(piece);
  });
  credit.hidden = pieces.length === 0;
}

function showImage(card, image) {
  const img = $('.mnemonic-image', card);
  img.src = image.url + '?v=' + Date.now();
  img.hidden = false;
  $('.image-placeholder', card).hidden = true;
  renderCredit(card, image);
}

async function lookupImage(index) {
  const phrase = state.phrases[index];
  const card = $$('.card')[index];
  if (!phrase || !card) return false;
  try {
    const data = await api('/api/image/lookup', {
      method: 'POST',
      body: JSON.stringify(imagePayload(phrase)),
    });
    if (data.found && data.image) {
      if (!phrase.query && data.query) phrase.query = data.query;
      $('.image-query', card).value = phrase.query || data.query || '';
      showImage(card, data.image);
      return true;
    }
    clearImage(card);
  } catch {
    // Image lookup is optional; TTS should continue to work.
  }
  return false;
}

function renderCandidates(index, searchData) {
  state.dialogSearch = searchData;
  $('#dialogQuery').textContent = 'Запрос: ' + searchData.query;
  const grid = $('#candidateGrid');
  grid.innerHTML = '';
  if (!searchData.results.length) {
    grid.textContent = 'Ничего не найдено. Измените поисковый запрос в карточке и повторите поиск.';
    return;
  }

  searchData.results.forEach(candidate => {
    const item = document.createElement('article');
    item.className = 'candidate';
    const img = document.createElement('img');
    img.src = candidate.thumbnail;
    img.alt = candidate.title || 'Результат поиска';
    img.loading = 'lazy';
    const meta = document.createElement('div');
    meta.className = 'candidate-meta';
    const title = document.createElement('strong');
    title.textContent = candidate.title || 'Без названия';
    const info = document.createElement('span');
    const license = (candidate.license || 'license ?') + (candidate.license_version ? ' ' + candidate.license_version : '');
    info.textContent = (candidate.creator || 'автор не указан') + ' · ' + license;
    const choose = document.createElement('button');
    choose.className = 'button small primary';
    choose.textContent = 'Выбрать';
    choose.addEventListener('click', () => selectImage(index, searchData, candidate, choose));
    meta.append(title, info, choose);
    item.append(img, meta);
    grid.appendChild(item);
  });
}

async function searchImage(index) {
  const phrase = state.phrases[index];
  const card = $$('.card')[index];
  if (!phrase || !card) return null;
  setCardStatus(card, 'ищу картинки…');
  $('#candidateGrid').textContent = 'Ищу изображения в Openverse…';
  try {
    const data = await api('/api/image/search', {
      method: 'POST',
      body: JSON.stringify(imagePayload(phrase)),
    });
    phrase.query = data.query;
    $('.image-query', card).value = data.query;
    $('#phrasesInput').value = serializeLines(state.phrases);
    saveState();
    setCardStatus(card, data.results.length ? 'найдено: ' + data.results.length : 'ничего не найдено', data.results.length ? 'ok' : 'error');
    renderCandidates(index, data);
    return data;
  } catch (error) {
    setCardStatus(card, error.message, 'error');
    $('#candidateGrid').textContent = error.message;
    return null;
  }
}

function updateDeleteButton(hasImage) {
  $('#deleteImage').disabled = !hasImage;
}

async function openImageManager(index) {
  state.dialogIndex = index;
  state.dialogSearch = null;
  const phrase = state.phrases[index];
  if (!phrase) return;

  $('#dialogPhrase').textContent = phrase.ro + (phrase.ru ? ' — ' + phrase.ru : '');
  $('#imageUrlInput').value = '';
  $('#candidateGrid').textContent = 'Поиск ещё не выполнен.';

  const dialog = $('#imageDialog');
  if (!dialog.open) dialog.showModal();

  updateDeleteButton(await lookupImage(index));
  await searchImage(index);
}

async function selectImage(index, searchData, candidate, button = null) {
  const phrase = state.phrases[index];
  const card = $$('.card')[index];
  if (!phrase || !card) return false;
  if (button) button.disabled = true;
  setCardStatus(card, 'сохраняю выбранную картинку…');
  try {
    const data = await api('/api/image/select', {
      method: 'POST',
      body: JSON.stringify({
        ...imagePayload(phrase),
        token: searchData.token,
        candidate_id: candidate.id,
      }),
    });
    showImage(card, data.image);
    setCardStatus(card, 'картинка сохранена локально', 'ok');
    if ($('#imageDialog').open) $('#imageDialog').close();
    return true;
  } catch (error) {
    setCardStatus(card, error.message, 'error');
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

async function autoFindMissing() {
  const button = $('#autoFindMissing');
  button.disabled = true;
  const progress = $('#imageProgress');
  try {
    for (let i = 0; i < state.phrases.length; i++) {
      const found = await lookupImage(i);
      if (!found) {
        const search = await searchImage(i, false);
        if (search && search.results.length) await selectImage(i, search, search.results[0]);
      }
      progress.style.width = `${Math.round(((i + 1) / state.phrases.length) * 100)}%`;
    }
  } finally {
    button.disabled = false;
    setTimeout(() => { progress.style.width = '0%'; }, 1200);
  }
}

function renderCards() {
  const container = $('#cards');
  const template = $('#cardTemplate');
  container.innerHTML = '';
  state.phrases.forEach((phrase, index) => {
    const card = template.content.firstElementChild.cloneNode(true);
    $('.card-index', card).textContent = String(index + 1).padStart(2, '0');
    $('.romanian', card).textContent = phrase.ro;
    $('.translation', card).textContent = phrase.ru || '—';
    $('.translation', card).hidden = $('#hideTranslation').checked;

    const query = $('.image-query', card);
    query.value = phrase.query || '';
    query.addEventListener('change', () => {
      phrase.query = query.value.trim();
      $('#phrasesInput').value = serializeLines(state.phrases);
      saveState();
      $('.mnemonic-image', card).hidden = true;
      $('.image-placeholder', card).hidden = false;
      renderCredit(card, null);
      lookupImage(index);
    });

    $('.play-one', card).addEventListener('click', async () => {
      stopPlayback();
      const token = state.stopToken;
      try { await playPhrase(index, token); } catch (error) { setCardStatus(card, error.message, 'error'); }
    });
    $('.find-image', card).addEventListener('click', () => searchImage(index, true));
    $('.change-image', card).addEventListener('click', () => searchImage(index, true));
    container.appendChild(card);
    lookupImage(index);
  });
}

function applyPhrases() {
  state.phrases = parseLines($('#phrasesInput').value);
  renderCards();
  saveState();
}

async function init() {
  const saved = loadSaved();
  const status = await api('/api/status');
  state.defaults = status.defaults || [];
  $('#phrasesInput').value = saved.phrases || defaultText();
  $('#rate').value = saved.rate ?? 0;
  $('#pitch').value = saved.pitch ?? 0;
  $('#pause').value = saved.pause ?? 1.5;
  $('#repeats').value = saved.repeats ?? 3;
  $('#listMode').value = saved.listMode ?? 'stop';
  $('#hideTranslation').checked = Boolean(saved.hideTranslation);
  updateSliderLabels();

  $('#imageInfo').textContent = 'Openverse: поиск по открыто лицензированным изображениям без API-ключа. Выбранные картинки кешируются локально вместе с данными об авторе и лицензии.';

  try {
    const voiceData = await api('/api/voices');
    const select = $('#voice');
    select.innerHTML = '';
    voiceData.voices.forEach(voice => {
      const option = document.createElement('option');
      option.value = voice.ShortName;
      const gender = voice.Gender === 'Female' ? 'жен.' : voice.Gender === 'Male' ? 'муж.' : voice.Gender;
      option.textContent = `${voice.ShortName} · ${gender}`;
      select.appendChild(option);
    });
    if (saved.voice && [...select.options].some(o => o.value === saved.voice)) select.value = saved.voice;
    if (voiceData.warning) $('#connectionBadge').title = `Список голосов взят из кеша/резерва: ${voiceData.warning}`;
  } catch (error) {
    $('#connectionBadge').textContent = 'ошибка голосов';
    $('#connectionBadge').title = error.message;
  }

  applyPhrases();
}

function updateSliderLabels() {
  const rate = Number($('#rate').value);
  const pitch = Number($('#pitch').value);
  $('#rateValue').textContent = `${rate > 0 ? '+' : ''}${rate}%`;
  $('#pitchValue').textContent = `${pitch > 0 ? '+' : ''}${pitch} Hz`;
}

$('#applyPhrases').addEventListener('click', applyPhrases);
$('#loadDefaults').addEventListener('click', () => { $('#phrasesInput').value = defaultText(); applyPhrases(); });
$('#playAll').addEventListener('click', playAll);
$('#stop').addEventListener('click', stopPlayback);
$('#autoFindMissing').addEventListener('click', autoFindMissing);
$('#closeDialog').addEventListener('click', () => $('#imageDialog').close());
$('#imageDialog').addEventListener('click', event => {
  if (event.target === $('#imageDialog')) $('#imageDialog').close();
});
$('#hideTranslation').addEventListener('change', () => { $$('.translation').forEach(el => { el.hidden = $('#hideTranslation').checked; }); saveState(); });
['voice', 'pause', 'repeats', 'listMode'].forEach(id => $(`#${id}`).addEventListener('change', saveState));
['rate', 'pitch'].forEach(id => $(`#${id}`).addEventListener('input', () => { updateSliderLabels(); saveState(); }));
window.addEventListener('beforeunload', saveState);

init().catch(error => {
  $('#connectionBadge').textContent = 'ошибка';
  $('#playbackStatus').textContent = error.message;
});
