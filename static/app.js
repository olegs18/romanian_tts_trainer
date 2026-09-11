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
  batchImageStatus: $('#batchImageStatus'),
  imageProgress: $('#imageProgress'),
  imageOptions: $('#imageOptions'),
  manageImage: $('#manageImage'),
  manageImageLabel: $('#manageImageLabel'),
  generateImage: $('#generateImage'),
  generatorInfo: $('#generatorInfo'),
  locale: $('#locale'),
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
  pasteZone: $('#pasteZone'),
  fileInput: $('#imageFileInput'),
  urlInput: $('#imageUrlInput'),
  audio: $('#audio'),
};

const state = {
  sentences: [],
  defaults: [],
  voices: [],
  voiceByLocale: {},
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
  maxImageBytes: 12 * 1024 * 1024,
  cloudflareConfigured: false,
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
  return item ? item.ro.normalize('NFC').trim().toLocaleLowerCase() : '';
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
    locale: elements.locale.value,
    voice: elements.voice.value,
    rate: Number(elements.rate.value),
    pitch: Number(elements.pitch.value),
    pause: Number(elements.pause.value),
    repeats: Number(elements.repeats.value),
    loop: elements.loop.checked,
    hideTranslation: elements.hideTranslation.checked,
    recall: elements.recall.checked,
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
  elements.locale.value = saved.locale || 'ro-RO';
  elements.voice.dataset.savedVoice = saved.voice || '';
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

function setBatchImageStatus(message = '', error = false) {
  elements.batchImageStatus.textContent = message;
  elements.batchImageStatus.style.color = error ? 'var(--red)' : '';
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
  const type = image.source_type || 'legacy';
  if (type === 'openverse') {
    if (image.creator) appendCredit(elements.credit, `Автор: ${image.creator}`, image.creator_url);
    if (image.license) {
      const label = `${image.license}${image.license_version ? ` ${image.license_version}` : ''}`.toUpperCase();
      appendCredit(elements.credit, label, image.license_url);
    }
    if (image.source_url) appendCredit(elements.credit, 'Источник', image.source_url);
  } else if (type === 'google') {
    appendCredit(elements.credit, image.creator ? `Google Images · ${image.creator}` : 'Google Images', image.source_url);
  } else if (type === 'cloudflare') {
    appendCredit(elements.credit, 'Сгенерировано FLUX.1 Schnell', image.source_url);
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
    phrase.lang = hideAnswers ? 'ru' : (elements.locale.value || 'ro-RO');
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
    elements.manageImage.disabled = true;
    elements.manageImageLabel.textContent = 'Добавить изображение';
    return;
  }

  elements.current.textContent = item.ro;
  elements.current.lang = elements.locale.value || 'ro-RO';
  elements.translation.textContent = item.ru;
  elements.current.hidden = recallHidden;
  elements.translation.hidden = recallHidden;
  elements.translation.classList.toggle('translation-hidden', elements.hideTranslation.checked);
  elements.recallHint.hidden = !recallHidden;
  elements.reveal.hidden = !recallHidden;
  elements.progressText.textContent = `${state.currentIndex + 1} / ${total}`;
  elements.progressBar.style.width = `${((state.currentIndex + 1) / total) * 100}%`;
  elements.playerState.textContent = repeatNumber ? `Повтор ${repeatNumber}` : (state.playing ? 'Воспроизведение' : 'Готов');
  if (document.activeElement !== elements.imageQuery) elements.imageQuery.value = item.query || item.ru || item.ro;

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
  elements.manageImage.disabled = false;
  elements.manageImageLabel.textContent = stored ? 'Заменить изображение' : 'Добавить изображение';
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
  $('#autoFindMissing').disabled = (!state.sentences.length || !state.cloudflareConfigured) && !state.batchActive;
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

function updateBrowserSearchLinks(item) {
  const query = (elements.imageQuery.value || item?.query || item?.ru || item?.ro || '').trim();
  const encoded = encodeURIComponent(query);
  $('#openGoogleImages').href = `https://www.google.com/search?tbm=isch&q=${encoded}`;
  $('#openBingImages').href = `https://www.bing.com/images/search?q=${encoded}`;
  $('#openOpenverse').href = `https://openverse.org/search/image?q=${encoded}`;
  elements.dialogQuery.textContent = query ? `Запрос: ${query}` : 'Добавьте идею образа выше.';
}

function saveCurrentImageHint(showConfirmation = true) {
  const context = currentDialogContext();
  if (!context) return;
  const hint = elements.imageQuery.value.trim();
  updatePhraseQuery(context.index, hint);
  updateBrowserSearchLinks(context.item);
  if (showConfirmation) setImageStatus('Идея образа сохранена.');
}

async function openImageManager() {
  const item = state.sentences[state.currentIndex];
  if (!item) return;
  state.dialogIndex = state.currentIndex;
  elements.dialogPhrase.textContent = `${item.ro}${item.ru ? ` — ${item.ru}` : ''}`;
  elements.imageQuery.value = item.query || item.ru || item.ro;
  elements.urlInput.value = '';
  setImageStatus();
  updateBrowserSearchLinks(item);
  elements.generateImage.disabled = !state.cloudflareConfigured;
  elements.generatorInfo.textContent = state.cloudflareConfigured
    ? 'Готово к генерации. Результат будет приведён к 300 × 300 и сохранён локально.'
    : 'Для генерации укажите CLOUDFLARE_ACCOUNT_ID и CLOUDFLARE_API_TOKEN в файле .env.';
  if (!elements.dialog.open) elements.dialog.showModal();
}

async function generateCurrentImage() {
  const context = currentDialogContext();
  if (!context) return;
  if (!state.cloudflareConfigured) {
    setImageStatus('Cloudflare Workers AI не настроен. Ссылки поиска и ручная загрузка доступны ниже.', true);
    return;
  }
  if (!elements.imageQuery.value.trim()) {
    setImageStatus('Укажите идею образа.', true);
    elements.imageQuery.focus();
    return;
  }
  saveCurrentImageHint(false);
  const snapshot = {...context.item};
  elements.generateImage.disabled = true;
  setImageStatus('FLUX создаёт ассоциацию… Обычно это занимает несколько секунд.');
  try {
    const data = await api('/api/image/generate', {
      method: 'POST',
      body: JSON.stringify(imagePayload(snapshot)),
    });
    rememberImage(snapshot, data.image);
    renderAll();
    setImageStatus('Ассоциация сгенерирована и сохранена локально.');
    if (elements.dialog.open) elements.dialog.close();
  } catch (error) {
    setImageStatus(error.message, true);
  } finally {
    elements.generateImage.disabled = !state.cloudflareConfigured;
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
    setBatchImageStatus('Остановлю генерацию после текущего изображения.');
    return;
  }
  if (!state.cloudflareConfigured) {
    setBatchImageStatus('Cloudflare Workers AI не настроен.', true);
    return;
  }
  const unique = [...new Map(state.sentences.map(item => [phraseKey(item), {...item}])).values()];
  state.batchActive = true;
  state.cancelBatch = false;
  button.textContent = 'Остановить генерацию';
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
        setBatchImageStatus(`Генерирую ассоциации: ${index + 1} / ${unique.length}`);
        const generated = await api('/api/image/generate', {
          method: 'POST', body: JSON.stringify(imagePayload(item)),
        });
        rememberImage(item, generated.image);
        added += 1;
        renderAll();
      }
      elements.imageProgress.style.width = `${Math.round(((index + 1) / unique.length) * 100)}%`;
    }
    setBatchImageStatus(`Сгенерировано: ${added}. Уже было: ${skipped}.${state.cancelBatch ? ' Генерация остановлена.' : ''}`);
  } catch (error) {
    setBatchImageStatus(`${error.message} Генерация остановлена.`, true);
  } finally {
    state.batchActive = false;
    button.textContent = 'Сгенерировать недостающие';
    updateControls();
    setTimeout(() => { elements.imageProgress.style.width = '0%'; }, 1200);
  }
}

const DEFAULT_VOICES = {
  'ro-RO': 'ro-RO-AlinaNeural',
  'en-US': 'en-US-JennyNeural',
  'en-GB': 'en-GB-SoniaNeural',
};

function voiceLocale(voice) {
  const name = voice.ShortName || voice.name || '';
  return voice.Locale || voice.locale || name.slice(0, 5);
}

function renderVoiceOptions(preferredVoice = '') {
  const locale = elements.locale.value || 'ro-RO';
  const voices = state.voices.filter(voice => voiceLocale(voice) === locale);
  elements.voice.replaceChildren();

  for (const voice of voices) {
    const name = voice.ShortName || voice.name;
    const genderValue = voice.Gender || voice.gender || '';
    const gender = genderValue === 'Female' ? 'женский' : genderValue === 'Male' ? 'мужской' : genderValue;
    const option = document.createElement('option');
    option.value = name;
    option.textContent = `${name}${gender ? ` · ${gender}` : ''}`;
    elements.voice.append(option);
  }

  const candidates = [preferredVoice, state.voiceByLocale[locale], DEFAULT_VOICES[locale]];
  const selected = candidates.find(name => name && [...elements.voice.options].some(option => option.value === name));
  if (selected) elements.voice.value = selected;
  if (elements.voice.value) state.voiceByLocale[locale] = elements.voice.value;
  elements.current.lang = locale;
}

async function loadVoices() {
  try {
    const data = await api('/api/voices');
    state.voices = data.voices || [];
    renderVoiceOptions(elements.voice.dataset.savedVoice);
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
  state.cloudflareConfigured = Boolean(status.image?.cloudflare?.configured);
  elements.generateImage.disabled = !state.cloudflareConfigured;
  elements.imageInfo.textContent = state.cloudflareConfigured
    ? 'FLUX.1 Schnell готов. Можно сгенерировать все отсутствующие ассоциации автоматически.'
    : 'Генерация отключена до настройки Cloudflare. Ручная загрузка и ссылки поиска в браузере работают без неё.';
  elements.generatorInfo.textContent = state.cloudflareConfigured
    ? 'Готово к генерации изображений 300 × 300.'
    : 'Добавьте CLOUDFLARE_ACCOUNT_ID и CLOUDFLARE_API_TOKEN в файл .env.';
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

$('#saveImageQuery').addEventListener('click', () => saveCurrentImageHint());
elements.manageImage.addEventListener('click', openImageManager);
elements.generateImage.addEventListener('click', generateCurrentImage);
$('#deleteCurrentImage').addEventListener('click', () => deleteImage());
$('#autoFindMissing').addEventListener('click', autoFindMissing);
$('#closeDialog').addEventListener('click', () => elements.dialog.close());
elements.imageQuery.addEventListener('input', () => {
  const context = currentDialogContext();
  if (context) updateBrowserSearchLinks(context.item);
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
elements.locale.addEventListener('change', () => {
  stopPlayback(false);
  renderVoiceOptions();
  renderAll();
  persist();
});
elements.voice.addEventListener('change', () => {
  state.voiceByLocale[elements.locale.value] = elements.voice.value;
  persist();
});
for (const element of [elements.repeats, elements.loop]) element.addEventListener('change', persist);
elements.input.addEventListener('input', persist);
window.addEventListener('beforeunload', persist);

window.PhraseTrainer = {parseLines, serializeLines};
window.RomanianTrainer = window.PhraseTrainer;
initialize().catch(error => {
  elements.badge.textContent = 'ОШИБКА ЗАПУСКА';
  elements.badge.className = 'badge warning';
  setError(error instanceof Error ? error.message : String(error));
});
