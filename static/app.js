'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const STORAGE_KEY = 'romanian-tts-trainer-v5';
const LEGACY_KEYS = ['romanian-tts-trainer-v4', 'romanian-tts-trainer-v1'];

const elements = {
  input: $('#phrasesInput'),
  list: $('#sentenceList'),
  count: $('#sentenceCount'),
  current: $('#currentSentence'),
  translation: $('#currentTranslation'),
  image: $('#currentImage'),
  imagePlaceholder: $('#imagePlaceholder'),
  credit: $('#imageCredit'),
  imageQuery: $('#imageQueryInput'),
  imageInfo: $('#imageInfo'),
  imageStatus: $('#imageStatus'),
  imageProgress: $('#imageProgress'),
  imageOptions: $('#imageOptions'),
  voice: $('#voice'),
  rate: $('#rate'),
  pitch: $('#pitch'),
  pause: $('#pause'),
  repeats: $('#repeats'),
  loop: $('#loopList'),
  hideTranslation: $('#hideTranslationCheckbox'),
  recall: $('#recallCheckbox'),
  reveal: $('#revealButton'),
  recallHint: $('#recallHint'),
  badge: $('#connectionBadge'),
  playerState: $('#playerState'),
  progressText: $('#progressText'),
  progressBar: $('#progressBar'),
  play: $('#playButton'),
  pauseButton: $('#pauseButton'),
  stop: $('#stopButton'),
  previous: $('#previousButton'),
  next: $('#nextButton'),
  error: $('#errorMessage'),
  dialog: $('#imageDialog'),
  dialogPhrase: $('#dialogPhrase'),
  dialogQuery: $('#dialogQuery'),
  candidates: $('#candidateGrid'),
  provider: $('#imageSearchProvider'),
  pasteZone: $('#pasteZone'),
  fileInput: $('#imageFileInput'),
  urlInput: $('#imageUrlInput'),
  audio: $('#audio'),
};

const state = {
  sentences: [],
  defaults: [],
  currentIndex: -1,
  playing: false,
  paused: false,
  runId: 0,
  audioActive: false,
  finishAudio: null,
  audioUrls: new Map(),
  images: new Map(),
  lookupId: 0,
  revealed: false,
  dialogIndex: null,
  dialogSearch: null,
  maxImageBytes: 12 * 1024 * 1024,
  googleConfigured: false,
  batchActive: false,
  cancelBatch: false,
};

function parseLines(raw) {
  return String(raw || '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
    const parts = line.includes('|') ? line.split('|') : line.split('\t');
    return {
      ro: (parts[0] || '').replace(/^[-*]\s+/, '').trim(),
      ru: (parts[1] || '').trim(),
      query: parts.slice(2).join('|').trim(),
    };
  }).filter(item => item.ro);
}

function serializeLines(items) {
  return items.map(item => [item.ro, item.ru, item.query].filter((value, index) => index < 2 || value).join(' | ')).join('\n');
}

function phraseKey(item) {
  return item ? item.ro.normalize('NFC').trim().toLocaleLowerCase('ro-RO') : '';
}

function pluralize(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} фраза`;
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return `${count} фразы`;
  return `${count} фраз`;
}

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: {'Content-Type': 'application/json', ...(options.headers || {})},
  }).then(async response => {
    let data;
    try { data = await response.json(); }
    catch (_) { throw new Error(`HTTP ${response.status}`); }
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  });
}

function loadSaved() {
  const read = key => {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); }
    catch (_) { return null; }
  };
  const current = read(STORAGE_KEY);
  if (current) return current;

  const v4 = read(LEGACY_KEYS[0]);
  if (v4) {
    return {
      rawText: Object.prototype.hasOwnProperty.call(v4, 'phrases') ? v4.phrases : undefined,
      settings: {
        voice: v4.voice, rate: v4.rate, pitch: v4.pitch, pause: v4.pause,
        repeats: v4.repeats, loop: v4.listMode === 'loop', hideTranslation: v4.hideTranslation,
        provider: v4.imageProvider,
      },
    };
  }

  const v1 = read(LEGACY_KEYS[1]);
  if (!v1) return null;
  return {
    rawText: Object.prototype.hasOwnProperty.call(v1, 'rawText') ? v1.rawText : undefined,
    settings: {
      voice: v1.settings?.voice, rate: v1.settings?.rate, pitch: v1.settings?.pitch,
      pause: v1.settings?.gap, repeats: v1.settings?.repeat, loop: v1.settings?.loop,
      hideTranslation: v1.settings?.hideTranslation, recall: v1.settings?.recall,
    },
  };
}

function settings() {
  return {
    voice: elements.voice.value,
    rate: Number(elements.rate.value),
    pitch: Number(elements.pitch.value),
    pause: Number(elements.pause.value),
    repeats: Number(elements.repeats.value),
    loop: elements.loop.checked,
    hideTranslation: elements.hideTranslation.checked,
    recall: elements.recall.checked,
    provider: elements.provider.value,
  };
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({rawText: elements.input.value, settings: settings()}));
  } catch (_) {
    setError('Браузер не смог сохранить урок. Проверьте доступ к локальному хранилищу.');
  }
}

function restoreSettings(saved = {}) {
  const pairs = [['rate', elements.rate], ['pitch', elements.pitch], ['pause', elements.pause], ['repeats', elements.repeats]];
  for (const [key, element] of pairs) {
    if (saved[key] !== undefined && saved[key] !== null) element.value = String(saved[key]);
  }
  elements.loop.checked = Boolean(saved.loop);
  elements.hideTranslation.checked = Boolean(saved.hideTranslation);
  elements.recall.checked = Boolean(saved.recall);
  elements.voice.dataset.savedVoice = saved.voice || '';
  elements.provider.dataset.savedProvider = saved.provider || 'auto';
}

function updateRangeOutputs() {
  const rate = Number(elements.rate.value);
  const pitch = Number(elements.pitch.value);
  $('#rateValue').value = `${rate >= 0 ? '+' : ''}${rate}%`;
  $('#pitchValue').value = `${pitch >= 0 ? '+' : ''}${pitch} Гц`;
  $('#pauseValue').value = `${Number(elements.pause.value).toFixed(1).replace('.', ',')} с`;
}

function setError(message = '') {
  elements.error.textContent = message;
}

function setImageStatus(message = '', error = false) {
  elements.imageStatus.textContent = message;
  elements.imageStatus.style.color = error ? 'var(--red)' : '';
}

function imageFor(item) {
  return state.images.get(phraseKey(item)) || null;
}

function rememberImage(item, image) {
  const key = phraseKey(item);
  if (!key) return;
  if (image) state.images.set(key, image);
  else state.images.delete(key);
}

function imageUrl(image) {
  if (!image?.url) return '';
  const separator = image.url.includes('?') ? '&' : '?';
  return `${image.url}${separator}v=${encodeURIComponent(image.version || 1)}`;
}

function appendCredit(parent, content, url = '') {
  const span = document.createElement('span');
  if (url) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = content;
    span.append(link);
  } else {
    span.textContent = content;
  }
  parent.append(span);
}

function renderCredit(image, hide) {
  elements.credit.replaceChildren();
  if (!image || hide) {
    elements.credit.hidden = true;
    return;
  }
  const type = image.source_type || 'openverse';
  if (type === 'openverse') {
    if (image.creator) appendCredit(elements.credit, `Автор: ${image.creator}`, image.creator_url);
    if (image.license) {
      const label = `${image.license}${image.license_version ? ` ${image.license_version}` : ''}`.toUpperCase();
      appendCredit(elements.credit, label, image.license_url);
    }
    if (image.source_url) appendCredit(elements.credit, 'Источник', image.source_url);
  } else if (type === 'google') {
    appendCredit(elements.credit, image.creator ? `Google Images · ${image.creator}` : 'Google Images', image.source_url);
  } else if (type === 'file') {
    appendCredit(elements.credit, image.original_filename ? `Файл: ${image.original_filename}` : 'Локальный файл');
  } else if (type === 'clipboard') {
    appendCredit(elements.credit, 'Вставлено из буфера обмена');
  } else if (type === 'url') {
    appendCredit(elements.credit, 'Загружено по ссылке', image.source_url);
  } else {
    appendCredit(elements.credit, 'Пользовательское изображение');
  }
  elements.credit.hidden = !elements.credit.childElementCount;
}

function renderPlaylist() {
  elements.list.replaceChildren();
  elements.count.textContent = pluralize(state.sentences.length);
  const hideAnswers = elements.recall.checked;
  for (const [index, item] of state.sentences.entries()) {
    const card = document.createElement('li');
    card.className = `sentence-card${index === state.currentIndex ? ' active' : ''}`;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.dataset.index = String(index);
    card.setAttribute('aria-label', hideAnswers ? `Карточка ${index + 1}` : `Выбрать: ${item.ro}`);

    const preview = document.createElement('div');
    preview.className = 'card-preview';
    const stored = imageFor(item);
    if (stored) {
      const image = document.createElement('img');
      image.src = imageUrl(stored);
      image.alt = '';
      image.loading = 'lazy';
      preview.append(image);
    } else {
      preview.textContent = String(index + 1).padStart(2, '0');
    }

    const main = document.createElement('div');
    main.className = 'sentence-main';
    const phrase = document.createElement('strong');
    phrase.textContent = hideAnswers ? `Карточка ${index + 1}` : item.ro;
    phrase.lang = hideAnswers ? 'ru' : 'ro';
    const translation = document.createElement('span');
    translation.textContent = hideAnswers ? 'Ответ скрыт' : item.ru;
    if (!hideAnswers && elements.hideTranslation.checked) translation.classList.add('translation-hidden');
    main.append(phrase, translation);
    card.append(preview, main);

    const activate = () => selectSentence(index);
    card.addEventListener('click', activate);
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
    elements.list.append(card);
  }
}

function scrollActivePlaylistItem() {
  const active = $('.sentence-card.active', elements.list);
  if (!active) return;
  const listRect = elements.list.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  if (activeRect.top < listRect.top) elements.list.scrollTop -= listRect.top - activeRect.top + 8;
  else if (activeRect.bottom > listRect.bottom) elements.list.scrollTop += activeRect.bottom - listRect.bottom + 8;
}

function renderCurrent(repeatNumber = null) {
  const total = state.sentences.length;
  const item = state.sentences[state.currentIndex];
  const recallHidden = Boolean(item && elements.recall.checked && !state.revealed);
  document.body.classList.toggle('recall-mode', elements.recall.checked);
  $('#editorSection').hidden = elements.recall.checked;
  elements.imageOptions.hidden = elements.recall.checked;

  if (!item) {
    elements.current.textContent = 'Добавьте фразы для тренировки.';
    elements.current.hidden = false;
    elements.translation.textContent = '';
    elements.translation.hidden = false;
    elements.progressText.textContent = `0 / ${total}`;
    elements.progressBar.style.width = '0%';
    elements.image.hidden = true;
    elements.image.removeAttribute('src');
    elements.imagePlaceholder.hidden = false;
    elements.imagePlaceholder.textContent = 'Добавьте фразы для тренировки.';
    elements.recallHint.hidden = true;
    elements.reveal.hidden = true;
    elements.credit.hidden = true;
    elements.imageQuery.value = '';
    return;
  }

  elements.current.textContent = item.ro;
  elements.translation.textContent = item.ru;
  elements.current.hidden = recallHidden;
  elements.translation.hidden = recallHidden;
  elements.translation.classList.toggle('translation-hidden', elements.hideTranslation.checked);
  elements.recallHint.hidden = !recallHidden;
  elements.reveal.hidden = !recallHidden;
  elements.progressText.textContent = `${state.currentIndex + 1} / ${total}`;
  elements.progressBar.style.width = `${((state.currentIndex + 1) / total) * 100}%`;
  elements.playerState.textContent = repeatNumber ? `Повтор ${repeatNumber}` : (state.playing ? 'Воспроизведение' : 'Готов');
  if (document.activeElement !== elements.imageQuery) elements.imageQuery.value = item.query || '';

  const stored = imageFor(item);
  if (stored) {
    const url = imageUrl(stored);
    if (elements.image.getAttribute('src') !== url) elements.image.src = url;
    elements.image.hidden = false;
    elements.imagePlaceholder.hidden = true;
  } else {
    elements.image.hidden = true;
    elements.image.removeAttribute('src');
    elements.imagePlaceholder.hidden = false;
    elements.imagePlaceholder.textContent = 'У этой фразы пока нет изображения.';
  }
  renderCredit(stored, recallHidden);
  $('#manageImage').disabled = false;
  $('#saveImageQuery').disabled = false;
  $('#deleteCurrentImage').disabled = !stored;
}

function renderAll(repeatNumber = null) {
  renderPlaylist();
  renderCurrent(repeatNumber);
  requestAnimationFrame(scrollActivePlaylistItem);
}

function updateControls() {
  elements.play.disabled = !state.sentences.length || state.playing;
  elements.pauseButton.disabled = !state.playing;
  elements.stop.disabled = !state.playing;
  elements.pauseButton.textContent = state.paused ? '▶ Продолжить' : 'Ⅱ Пауза';
  elements.previous.disabled = !state.sentences.length;
  elements.next.disabled = !state.sentences.length;
  $('#autoFindMissing').disabled = !state.sentences.length && !state.batchActive;
}

function selectSentence(index) {
  if (!state.sentences.length) return;
  stopPlayback(false);
  const total = state.sentences.length;
  state.currentIndex = (index + total) % total;
  state.revealed = false;
  setError();
  renderAll();
  updateControls();
}

function applyPhrases() {
  stopPlayback(false);
  state.lookupId += 1;
  state.sentences = parseLines(elements.input.value);
  state.currentIndex = state.sentences.length ? 0 : -1;
  state.revealed = false;
  renderAll();
  updateControls();
  persist();
  lookupAllImages(state.sentences);
  setError(state.sentences.length ? '' : 'Добавьте хотя бы одну фразу.');
}

async function lookupImage(item, lookupToken = state.lookupId) {
  if (!item) return null;
  const snapshot = {...item};
  try {
    const data = await api('/api/image/lookup', {method: 'POST', body: JSON.stringify(imagePayload(snapshot))});
    if (lookupToken !== state.lookupId) return null;
    rememberImage(snapshot, data.found ? data.image : null);
    return data.found ? data.image : null;
  } catch (_) {
    return null;
  }
}

async function lookupAllImages(items) {
  const token = ++state.lookupId;
  const snapshot = items.map(item => ({...item}));
  for (let offset = 0; offset < snapshot.length; offset += 8) {
    const chunk = snapshot.slice(offset, offset + 8);
    await Promise.all(chunk.map(item => lookupImage(item, token)));
    if (token !== state.lookupId) return;
    renderAll();
  }
}

function imagePayload(item) {
  return {text: item.ro, translation: item.ru, query: item.query || ''};
}

async function getAudio(item) {
  const current = settings();
  const key = JSON.stringify([item.ro, current.voice, current.rate, current.pitch]);
  if (state.audioUrls.has(key)) return state.audioUrls.get(key);
  elements.playerState.textContent = 'Готовлю аудио…';
  const data = await api('/api/audio', {
    method: 'POST',
    body: JSON.stringify({text: item.ro, voice: current.voice, rate: current.rate, pitch: current.pitch}),
  });
  state.audioUrls.set(key, data.url);
  return data.url;
}

function playAudio(url, token) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      elements.audio.removeEventListener('ended', onEnded);
      elements.audio.removeEventListener('error', onError);
      if (state.finishAudio === finish) {
        state.finishAudio = null;
        state.audioActive = false;
      }
      if (error) reject(error); else resolve();
    };
    const onEnded = () => finish();
    const onError = () => finish(new Error('Браузер не смог воспроизвести MP3.'));
    state.finishAudio = finish;
    elements.audio.addEventListener('ended', onEnded);
    elements.audio.addEventListener('error', onError);
    elements.audio.src = url;
    elements.audio.currentTime = 0;
    state.audioActive = true;
    elements.audio.play().catch(() => finish(token === state.runId ? new Error('Браузер заблокировал звук. Нажмите воспроизведение ещё раз.') : null));
  });
}

async function waitGap(milliseconds, token) {
  let remaining = milliseconds;
  let previous = performance.now();
  while (remaining > 0 || state.paused) {
    if (token !== state.runId) return false;
    await new Promise(resolve => setTimeout(resolve, 80));
    const now = performance.now();
    if (!state.paused) remaining -= now - previous;
    previous = now;
  }
  return token === state.runId;
}

async function startPlayback(startIndex = 0) {
  if (!state.sentences.length) {
    setError('Добавьте хотя бы одну фразу.');
    return;
  }
  stopPlayback(false);
  const token = state.runId;
  state.playing = true;
  state.paused = false;
  setError();
  updateControls();
  let index = Math.max(0, Math.min(startIndex, state.sentences.length - 1));

  try {
    while (token === state.runId) {
      state.currentIndex = index;
      state.revealed = true;
      renderAll();
      const item = state.sentences[index];
      const url = await getAudio(item);
      if (token !== state.runId) return;
      const current = settings();
      let repetition = 0;
      while (current.repeats === 0 || repetition < current.repeats) {
        while (state.paused && token === state.runId) await new Promise(resolve => setTimeout(resolve, 80));
        if (token !== state.runId) return;
        repetition += 1;
        renderCurrent(repetition);
        await playAudio(url, token);
        if (token !== state.runId) return;
        if (current.repeats === 0 || repetition < current.repeats) {
          if (!await waitGap(current.pause * 1000, token)) return;
        }
      }

      if (elements.recall.checked) break;
      index += 1;
      if (index >= state.sentences.length) {
        if (current.loop) index = 0;
        else break;
      }
      if (!await waitGap(current.pause * 1000, token)) return;
    }
  } catch (error) {
    if (token === state.runId) setError(error instanceof Error ? error.message : String(error));
  } finally {
    if (token === state.runId) {
      state.playing = false;
      state.paused = false;
      elements.playerState.textContent = 'Готов';
      updateControls();
    }
  }
}

function stopPlayback(resetLabel = true) {
  state.runId += 1;
  state.finishAudio?.();
  state.finishAudio = null;
  state.playing = false;
  state.paused = false;
  state.audioActive = false;
  elements.audio.pause();
  elements.audio.removeAttribute('src');
  elements.audio.load();
  if (resetLabel) elements.playerState.textContent = 'Остановлено';
  updateControls();
}

function togglePause() {
  if (!state.playing) return;
  state.paused = !state.paused;
  if (state.paused) {
    elements.audio.pause();
    elements.playerState.textContent = 'Пауза';
  } else {
    if (state.audioActive) elements.audio.play().catch(() => setError('Не удалось продолжить воспроизведение.'));
    elements.playerState.textContent = 'Воспроизведение';
  }
  updateControls();
}

function updatePhraseQuery(index, query) {
  const item = state.sentences[index];
  if (!item) return;
  item.query = query.trim();
  elements.input.value = serializeLines(state.sentences);
  persist();
  renderPlaylist();
}

function currentDialogContext() {
  const index = state.dialogIndex;
  if (index === null || index < 0) return null;
  const item = state.sentences[index];
  return item ? {index, item} : null;
}

function renderCandidates(context, data) {
  state.dialogSearch = {contextKey: phraseKey(context.item), ...data};
  elements.dialogQuery.textContent = `Запрос: ${data.query}`;
  elements.candidates.replaceChildren();
  if (!data.results.length) {
    elements.candidates.textContent = 'Ничего не найдено. Измените поисковый запрос и повторите поиск.';
    return;
  }
  for (const candidate of data.results) {
    const card = document.createElement('article');
    card.className = 'candidate';
    const image = document.createElement('img');
    image.src = candidate.thumbnail;
    image.alt = candidate.title || 'Результат поиска';
    image.loading = 'lazy';
    const meta = document.createElement('div');
    meta.className = 'candidate-meta';
    const title = document.createElement('strong');
    title.textContent = candidate.title || 'Без названия';
    const info = document.createElement('span');
    info.textContent = (candidate.provider || data.provider) === 'google'
      ? `Google Images${candidate.creator ? ` · ${candidate.creator}` : ''}`
      : `${candidate.creator || 'автор не указан'} · ${candidate.license || 'лицензия не указана'}`;
    const choose = document.createElement('button');
    choose.className = 'button primary';
    choose.textContent = 'Выбрать';
    choose.addEventListener('click', () => selectCandidate(context, data, candidate, choose));
    meta.append(title, info, choose);
    card.append(image, meta);
    elements.candidates.append(card);
  }
}

async function searchCurrentImage() {
  const context = currentDialogContext();
  if (!context) return;
  updatePhraseQuery(context.index, elements.imageQuery.value);
  const snapshot = {...context.item};
  elements.candidates.textContent = 'Ищу изображения…';
  setImageStatus('Ищу подходящие изображения…');
  try {
    const data = await api('/api/image/search', {
      method: 'POST',
      body: JSON.stringify({...imagePayload(snapshot), provider: elements.provider.value || 'auto'}),
    });
    const live = currentDialogContext();
    if (!live || phraseKey(live.item) !== phraseKey(snapshot)) return;
    if (!live.item.query && data.query) updatePhraseQuery(live.index, data.query);
    renderCandidates(live, data);
    setImageStatus(data.results.length ? `Найдено: ${data.results.length}` : 'Ничего не найдено.', !data.results.length);
  } catch (error) {
    elements.candidates.textContent = error.message;
    setImageStatus(error.message, true);
  }
}

async function openImageManager() {
  const item = state.sentences[state.currentIndex];
  if (!item) return;
  state.dialogIndex = state.currentIndex;
  state.dialogSearch = null;
  elements.dialogPhrase.textContent = `${item.ro}${item.ru ? ` — ${item.ru}` : ''}`;
  elements.urlInput.value = '';
  elements.candidates.textContent = 'Поиск ещё не выполнен.';
  if (!elements.dialog.open) elements.dialog.showModal();
  await searchCurrentImage();
}

async function selectCandidate(context, searchData, candidate, button) {
  const snapshot = {...context.item};
  button.disabled = true;
  setImageStatus('Сохраняю выбранное изображение…');
  try {
    const data = await api('/api/image/select', {
      method: 'POST',
      body: JSON.stringify({...imagePayload(snapshot), token: searchData.token, candidate_id: candidate.id}),
    });
    rememberImage(snapshot, data.image);
    renderAll();
    setImageStatus('Изображение сохранено локально.');
    if (elements.dialog.open) elements.dialog.close();
  } catch (error) {
    setImageStatus(error.message, true);
    button.disabled = false;
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}

async function importLocalFile(file, mode) {
  const context = currentDialogContext();
  if (!context || !file) return;
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
    setImageStatus('Поддерживаются JPEG, PNG, WebP и GIF.', true);
    return;
  }
  if (file.size > state.maxImageBytes) {
    setImageStatus('Изображение превышает допустимый размер.', true);
    return;
  }
  const snapshot = {...context.item};
  setImageStatus(mode === 'clipboard' ? 'Сохраняю изображение из буфера…' : 'Загружаю файл…');
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const data = await api('/api/image/import', {
      method: 'POST',
      body: JSON.stringify({...imagePayload(snapshot), mode, data_url: dataUrl, filename: file.name || ''}),
    });
    rememberImage(snapshot, data.image);
    renderAll();
    setImageStatus(mode === 'clipboard' ? 'Изображение вставлено из буфера.' : 'Файл сохранён локально.');
    elements.dialog.close();
  } catch (error) {
    setImageStatus(error.message, true);
  }
}

async function importFromUrl() {
  const context = currentDialogContext();
  const sourceUrl = elements.urlInput.value.trim();
  if (!context || !sourceUrl) {
    setImageStatus('Укажите прямую ссылку на изображение.', true);
    return;
  }
  const snapshot = {...context.item};
  $('#importImageUrl').disabled = true;
  setImageStatus('Скачиваю изображение…');
  try {
    const data = await api('/api/image/import', {
      method: 'POST', body: JSON.stringify({...imagePayload(snapshot), mode: 'url', source_url: sourceUrl}),
    });
    rememberImage(snapshot, data.image);
    renderAll();
    setImageStatus('Изображение по ссылке сохранено локально.');
    elements.dialog.close();
  } catch (error) {
    setImageStatus(error.message, true);
  } finally {
    $('#importImageUrl').disabled = false;
  }
}

async function deleteImage(index = state.currentIndex) {
  const item = state.sentences[index];
  if (!item) return;
  try {
    await api('/api/image/delete', {method: 'POST', body: JSON.stringify(imagePayload(item))});
    rememberImage(item, null);
    renderAll();
    setImageStatus('Изображение удалено.');
  } catch (error) {
    setImageStatus(error.message, true);
  }
}

function clipboardImage(event) {
  const items = [...(event.clipboardData?.items || [])];
  const image = items.find(item => item.kind === 'file' && item.type.startsWith('image/'));
  return image ? image.getAsFile() : null;
}

async function autoFindMissing() {
  const button = $('#autoFindMissing');
  if (state.batchActive) {
    state.cancelBatch = true;
    setImageStatus('Остановлю подбор после текущего изображения.');
    return;
  }
  const unique = [...new Map(state.sentences.map(item => [phraseKey(item), {...item}])).values()];
  state.batchActive = true;
  state.cancelBatch = false;
  button.textContent = 'Остановить подбор';
  button.disabled = false;
  let added = 0;
  let skipped = 0;
  try {
    for (const [index, item] of unique.entries()) {
      if (state.cancelBatch) break;
      let stored = imageFor(item) || await lookupImage(item, state.lookupId);
      if (stored) {
        skipped += 1;
      } else {
        setImageStatus(`Подбираю изображения: ${index + 1} / ${unique.length}`);
        const search = await api('/api/image/search', {
          method: 'POST', body: JSON.stringify({...imagePayload(item), provider: elements.provider.value || 'auto'}),
        });
        if (search.results.length) {
          const selected = await api('/api/image/select', {
            method: 'POST',
            body: JSON.stringify({...imagePayload(item), token: search.token, candidate_id: search.results[0].id}),
          });
          rememberImage(item, selected.image);
          added += 1;
          renderAll();
        }
      }
      elements.imageProgress.style.width = `${Math.round(((index + 1) / unique.length) * 100)}%`;
    }
    setImageStatus(`Добавлено: ${added}. Уже было: ${skipped}.${state.cancelBatch ? ' Подбор остановлен.' : ''}`);
  } catch (error) {
    setImageStatus(`${error.message} Подбор остановлен.`, true);
  } finally {
    state.batchActive = false;
    button.textContent = 'Автоподобрать недостающие';
    updateControls();
    setTimeout(() => { elements.imageProgress.style.width = '0%'; }, 1200);
  }
}

async function loadVoices() {
  try {
    const data = await api('/api/voices');
    elements.voice.replaceChildren();
    for (const voice of data.voices || []) {
      const name = voice.ShortName || voice.name;
      const genderValue = voice.Gender || voice.gender || '';
      const gender = genderValue === 'Female' ? 'женский' : genderValue === 'Male' ? 'мужской' : genderValue;
      const option = document.createElement('option');
      option.value = name;
      option.textContent = `${name}${gender ? ` · ${gender}` : ''}`;
      elements.voice.append(option);
    }
    const saved = elements.voice.dataset.savedVoice;
    if (saved && [...elements.voice.options].some(option => option.value === saved)) elements.voice.value = saved;
    else if ([...elements.voice.options].some(option => option.value === 'ro-RO-AlinaNeural')) elements.voice.value = 'ro-RO-AlinaNeural';
    elements.badge.textContent = data.warning ? 'TTS РАБОТАЕТ ИЗ РЕЗЕРВА' : 'EDGE TTS ПОДКЛЮЧЁН';
    elements.badge.className = data.warning ? 'badge warning' : 'badge ok';
    if (data.warning) elements.badge.title = data.warning;
    persist();
  } catch (error) {
    elements.badge.textContent = 'TTS НЕДОСТУПЕН';
    elements.badge.className = 'badge warning';
    setError(error.message);
  }
}

async function initialize() {
  const saved = loadSaved();
  restoreSettings(saved?.settings);
  updateRangeOutputs();
  const status = await api('/api/status');
  state.defaults = status.defaults || [];
  state.maxImageBytes = status.image?.max_bytes || state.maxImageBytes;
  state.googleConfigured = Boolean(status.image?.google?.configured);
  const googleOption = $('option[value="google"]', elements.provider);
  if (googleOption) {
    googleOption.disabled = !state.googleConfigured;
    googleOption.textContent = state.googleConfigured ? 'Google Images API' : 'Google Images API (не настроен)';
  }
  const savedProvider = elements.provider.dataset.savedProvider;
  elements.provider.value = savedProvider === 'google' && !state.googleConfigured ? 'auto' : savedProvider;
  elements.imageInfo.textContent = state.googleConfigured
    ? 'Google Images доступен внутри приложения; также работают Openverse, буфер, файл и URL.'
    : 'Openverse работает без ключа. Google Images открывается отдельно; найденное фото можно вставить, выбрать с диска или загрузить по URL.';
  const defaultText = serializeLines(state.defaults.map(([ro, ru, query]) => ({ro, ru, query: query || ''})));
  elements.input.value = saved && Object.prototype.hasOwnProperty.call(saved, 'rawText') && saved.rawText !== undefined ? saved.rawText : defaultText;
  state.sentences = parseLines(elements.input.value);
  state.currentIndex = state.sentences.length ? 0 : -1;
  renderAll();
  updateControls();
  await Promise.all([loadVoices(), lookupAllImages(state.sentences)]);
}

$('#applyPhrases').addEventListener('click', applyPhrases);
$('#loadDefaults').addEventListener('click', () => {
  elements.input.value = serializeLines(state.defaults.map(([ro, ru, query]) => ({ro, ru, query: query || ''})));
  applyPhrases();
});
$('#clearPhrases').addEventListener('click', () => { elements.input.value = ''; applyPhrases(); });
$('#pastePhrases').addEventListener('click', async () => {
  try {
    elements.input.value = await navigator.clipboard.readText();
    applyPhrases();
  } catch (_) {
    setError('Браузер не дал доступ к буферу. Вставьте текст клавишами Ctrl+V.');
    elements.input.focus();
  }
});

elements.play.addEventListener('click', () => startPlayback(state.currentIndex >= 0 ? state.currentIndex : 0));
elements.pauseButton.addEventListener('click', togglePause);
elements.stop.addEventListener('click', () => stopPlayback());
elements.previous.addEventListener('click', () => selectSentence(state.currentIndex - 1));
elements.next.addEventListener('click', () => selectSentence(state.currentIndex + 1));
elements.recall.addEventListener('change', () => {
  stopPlayback(false);
  state.revealed = false;
  persist();
  renderAll();
});
elements.reveal.addEventListener('click', () => { state.revealed = true; renderCurrent(); });
elements.hideTranslation.addEventListener('change', () => { persist(); renderAll(); });

$('#saveImageQuery').addEventListener('click', () => {
  updatePhraseQuery(state.currentIndex, elements.imageQuery.value);
  setImageStatus('Поисковый запрос сохранён.');
});
$('#manageImage').addEventListener('click', openImageManager);
$('#deleteCurrentImage').addEventListener('click', () => deleteImage());
$('#autoFindMissing').addEventListener('click', autoFindMissing);
$('#closeDialog').addEventListener('click', () => elements.dialog.close());
$('#refreshSearch').addEventListener('click', searchCurrentImage);
elements.provider.addEventListener('change', () => { persist(); if (elements.dialog.open) searchCurrentImage(); });
$('#openGoogleImages').addEventListener('click', () => {
  const context = currentDialogContext();
  if (!context) return;
  const query = context.item.query || context.item.ru || context.item.ro;
  window.open(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`, '_blank', 'noopener,noreferrer');
});

$('#chooseImageFile').addEventListener('click', () => elements.fileInput.click());
elements.fileInput.addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) importLocalFile(file, 'file');
  event.target.value = '';
});
$('#importImageUrl').addEventListener('click', importFromUrl);
elements.urlInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); importFromUrl(); }
});
elements.pasteZone.addEventListener('paste', event => {
  const file = clipboardImage(event);
  if (file) { event.preventDefault(); event.stopPropagation(); importLocalFile(file, 'clipboard'); }
});
document.addEventListener('paste', event => {
  if (!elements.dialog.open) return;
  const file = clipboardImage(event);
  if (file) { event.preventDefault(); importLocalFile(file, 'clipboard'); }
});
for (const type of ['dragenter', 'dragover']) {
  elements.pasteZone.addEventListener(type, event => { event.preventDefault(); elements.pasteZone.classList.add('dragging'); });
}
for (const type of ['dragleave', 'drop']) {
  elements.pasteZone.addEventListener(type, event => { event.preventDefault(); elements.pasteZone.classList.remove('dragging'); });
}
elements.pasteZone.addEventListener('drop', event => {
  const file = [...(event.dataTransfer?.files || [])].find(candidate => candidate.type.startsWith('image/'));
  if (file) importLocalFile(file, 'file');
});
elements.dialog.addEventListener('click', event => { if (event.target === elements.dialog) elements.dialog.close(); });
elements.image.addEventListener('error', () => {
  elements.image.hidden = true;
  elements.imagePlaceholder.hidden = false;
  elements.imagePlaceholder.textContent = 'Не удалось открыть изображение из кеша.';
});

for (const element of [elements.rate, elements.pitch, elements.pause]) {
  element.addEventListener('input', () => { updateRangeOutputs(); persist(); });
}
for (const element of [elements.voice, elements.repeats, elements.loop]) element.addEventListener('change', persist);
elements.input.addEventListener('input', persist);
window.addEventListener('beforeunload', persist);

window.RomanianTrainer = {parseLines, serializeLines};
initialize().catch(error => {
  elements.badge.textContent = 'ОШИБКА ЗАПУСКА';
  elements.badge.className = 'badge warning';
  setError(error instanceof Error ? error.message : String(error));
});
