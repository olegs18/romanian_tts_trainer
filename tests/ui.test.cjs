"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {JSDOM} = require("jsdom");

const root = path.join(__dirname, "..");
const defaults = [
  ["Bună ziua.", "Добрый день.", "friendly greeting"],
  ["Nu am înțeles.", "Я не понял.", "confused person"],
  ["Puteți repeta?", "Можете повторить?", "repeat gesture"],
];
const cachedImage = {
  url: "/cache/images/" + "a".repeat(64) + ".png",
  version: "version-one",
  source_type: "clipboard",
};

function response(data, status = 200) {
  return {ok: status >= 200 && status < 300, status, json: async () => data};
}

async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("UI did not reach the expected state");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function launch({saved = null, cloudflareConfigured = true} = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "static/index.html"), "utf8"), {
    url: "http://localhost:8765",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const requests = [];
  const played = [];
  const q = selector => w.document.querySelector(selector);

  if (saved) w.localStorage.setItem(saved.key, JSON.stringify(saved.value));
  q("#imageDialog").showModal = function () { this.open = true; };
  q("#imageDialog").close = function () { this.open = false; };
  w.HTMLElement.prototype.scrollIntoView = function () {
    throw new Error("The page must not scroll between cards");
  };
  w.HTMLMediaElement.prototype.play = function () {
    played.push(this.getAttribute("src"));
    clearTimeout(this._finishTimer);
    this._finishTimer = setTimeout(() => this.dispatchEvent(new w.Event("ended")), 8);
    return Promise.resolve();
  };
  w.HTMLMediaElement.prototype.pause = function () { clearTimeout(this._finishTimer); };
  w.HTMLMediaElement.prototype.load = function () {};

  w.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({url, body});
    if (url === "/api/status") return response({ok: true, defaults, image: {max_bytes: 12 * 1024 * 1024, cloudflare: {configured: cloudflareConfigured, model: "@cf/black-forest-labs/flux-1-schnell", output_size: 300}}});
    if (url === "/api/voices") return response({ok: true, warning: null, voices: [
      {ShortName: "ro-RO-AlinaNeural", Gender: "Female", Locale: "ro-RO"},
      {ShortName: "ro-RO-EmilNeural", Gender: "Male", Locale: "ro-RO"},
      {ShortName: "en-US-JennyNeural", Gender: "Female", Locale: "en-US"},
      {ShortName: "en-US-GuyNeural", Gender: "Male", Locale: "en-US"},
      {ShortName: "en-GB-SoniaNeural", Gender: "Female", Locale: "en-GB"},
      {ShortName: "en-GB-RyanNeural", Gender: "Male", Locale: "en-GB"},
    ]});
    if (url === "/api/image/lookup") {
      return response({ok: true, found: body.text === defaults[0][0], query: body.query, image: body.text === defaults[0][0] ? cachedImage : null});
    }
    if (url === "/api/audio") return response({ok: true, cached: true, url: "/cache/audio/" + encodeURIComponent(body.text) + ".mp3"});
    if (url === "/api/image/generate") return response({ok: true, query: body.query, image: {...cachedImage, version: "generated-version", source_type: "cloudflare"}});
    if (url === "/api/image/import") return response({ok: true, image: {...cachedImage, version: "imported-version", source_type: body.mode, source_url: body.source_url || ""}});
    if (url === "/api/image/delete") return response({ok: true, deleted: true});
    throw new Error("Unexpected request " + url);
  };

  w.eval(fs.readFileSync(path.join(root, "static/app.js"), "utf8"));
  await until(() => q("#connectionBadge").textContent === "EDGE TTS ПОДКЛЮЧЁН" && !q("#imageInfo").textContent.includes("Проверяю"));
  return {dom, w, q, requests, played};
}

test("lesson parser keeps phrase, translation and image query separate", async () => {
  const app = await launch();
  try {
    assert.equal(app.w.RomanianTrainer, app.w.PhraseTrainer);
    const parsed = JSON.parse(JSON.stringify(app.w.PhraseTrainer.parseLines("Salut | Привет | waving hand\nBună\tДобрый день\tstreet greeting")));
    assert.deepEqual(parsed, [
      {ro: "Salut", ru: "Привет", query: "waving hand"},
      {ro: "Bună", ru: "Добрый день", query: "street greeting"},
    ]);
  } finally { app.dom.window.close(); }
});

test("interface has one large study card and a compact playlist", async () => {
  const app = await launch();
  try {
    assert.equal(app.w.document.querySelectorAll(".study-card").length, 1);
    assert.equal(app.w.document.querySelectorAll(".sentence-card").length, defaults.length);
    assert.equal(app.q("#currentSentence").textContent, defaults[0][0]);
    assert.match(app.q("#currentImage").getAttribute("src"), /version-one$/);
    assert.equal(app.q("#currentImage").hidden, false);
    assert.equal(app.q("#imagePlaceholder").hidden, true);
    assert.equal(app.q("#manageImageLabel").textContent, "Заменить изображение");
    assert.match(fs.readFileSync(path.join(root, "static/style.css"), "utf8"), /\.image-manage-overlay[^}]*opacity:\s*0/);
  } finally { app.dom.window.close(); }
});

test("language selector filters voices and remembers the English choice", async () => {
  const app = await launch();
  try {
    const optionValues = () => [...app.q("#voice").options].map(option => option.value);
    assert.equal(app.q("#locale").value, "ro-RO");
    assert.deepEqual(optionValues(), ["ro-RO-AlinaNeural", "ro-RO-EmilNeural"]);

    app.q("#locale").value = "en-US";
    app.q("#locale").dispatchEvent(new app.w.Event("change"));
    assert.deepEqual(optionValues(), ["en-US-JennyNeural", "en-US-GuyNeural"]);
    assert.equal(app.q("#voice").value, "en-US-JennyNeural");
    assert.equal(app.q("#currentSentence").lang, "en-US");

    app.q("#voice").value = "en-US-GuyNeural";
    app.q("#voice").dispatchEvent(new app.w.Event("change"));
    app.q("#locale").value = "en-GB";
    app.q("#locale").dispatchEvent(new app.w.Event("change"));
    assert.deepEqual(optionValues(), ["en-GB-SoniaNeural", "en-GB-RyanNeural"]);
    assert.equal(app.q("#voice").value, "en-GB-SoniaNeural");

    app.q("#locale").value = "en-US";
    app.q("#locale").dispatchEvent(new app.w.Event("change"));
    assert.equal(app.q("#voice").value, "en-US-GuyNeural");
    const saved = JSON.parse(app.w.localStorage.getItem("romanian-tts-trainer-v5"));
    assert.equal(saved.settings.locale, "en-US");
    assert.equal(saved.settings.voice, "en-US-GuyNeural");
  } finally { app.dom.window.close(); }
});

test("image action appears only on picture interaction and remains usable on touch screens", () => {
  const css = fs.readFileSync(path.join(root, "static/style.css"), "utf8");
  assert.match(css, /\.image-manage-overlay \{[^}]*opacity: 0;[^}]*pointer-events: none;/s);
  assert.match(css, /\.picture-frame:hover \.image-manage-overlay,[\s\S]*\.picture-frame:focus-within \.image-manage-overlay \{[^}]*opacity: 1;[^}]*pointer-events: auto;/);
  assert.match(css, /@media \(hover: none\) \{[\s\S]*\.image-manage-overlay \{[^}]*opacity: \.92;[^}]*pointer-events: auto;/);
});

test("playlist playback swaps the large card without scrolling the page", async () => {
  const app = await launch();
  try {
    app.q("#repeats").value = "1";
    app.q("#pause").value = "0";
    app.q("#playButton").click();
    await until(() => app.requests.filter(item => item.url === "/api/audio").length === defaults.length && !app.q("#playButton").disabled);
    assert.deepEqual(app.requests.filter(item => item.url === "/api/audio").map(item => item.body.text), defaults.map(item => item[0]));
    assert.equal(app.q("#currentSentence").textContent, defaults.at(-1)[0]);
    assert.equal(app.q(".sentence-card.active").dataset.index, "2");
    assert.equal(app.played.length, defaults.length);
  } finally { app.dom.window.close(); }
});

test("recall mode hides every textual answer and plays only the selected card", async () => {
  const app = await launch();
  try {
    app.q("#recallCheckbox").click();
    assert.equal(app.q("#currentSentence").hidden, true);
    assert.equal(app.q("#currentTranslation").hidden, true);
    assert.equal(app.q("#editorSection").hidden, true);
    assert.equal(app.q("#imageOptions").hidden, true);
    assert.equal(app.q(".sentence-main strong").textContent, "Карточка 1");
    app.q("#revealButton").click();
    assert.equal(app.q("#currentSentence").hidden, false);
    app.q("#repeats").value = "1";
    app.q("#pause").value = "0";
    const before = app.requests.filter(item => item.url === "/api/audio").length;
    app.q("#playButton").click();
    await until(() => app.requests.filter(item => item.url === "/api/audio").length === before + 1 && !app.q("#playButton").disabled);
    assert.equal(app.requests.filter(item => item.url === "/api/audio").length - before, 1);
  } finally { app.dom.window.close(); }
});

test("image manager generates and attaches a Cloudflare association", async () => {
  const app = await launch();
  try {
    app.q("#nextButton").click();
    app.q("#manageImage").click();
    assert.equal(app.q("#imageDialog").open, true);
    assert.equal(app.requests.filter(item => item.url === "/api/image/generate").length, 0);
    assert.match(app.q("#openGoogleImages").href, /google\.com\/search/);
    assert.match(app.q("#openBingImages").href, /bing\.com\/images\/search/);
    assert.match(app.q("#openOpenverse").href, /openverse\.org\/search\/image/);
    app.q("#generateImage").click();
    await until(() => app.q("#imageDialog").open === false && !app.q("#currentImage").hidden);
    assert.match(app.q("#currentImage").getAttribute("src"), /generated-version$/);
    assert.equal(app.requests.filter(item => item.url === "/api/image/generate").length, 1);
    assert.equal(app.q("#manageImageLabel").textContent, "Заменить изображение");
  } finally { app.dom.window.close(); }
});

test("image manager accepts clipboard images and direct URLs", async () => {
  const app = await launch();
  try {
    app.q("#nextButton").click();
    app.q("#manageImage").click();
    const file = new app.w.File([new Uint8Array([137, 80, 78, 71])], "memory.png", {type: "image/png"});
    const paste = new app.w.Event("paste", {bubbles: true, cancelable: true});
    Object.defineProperty(paste, "clipboardData", {value: {items: [{kind: "file", type: "image/png", getAsFile: () => file}]}});
    app.q("#pasteZone").dispatchEvent(paste);
    await until(() => app.requests.some(item => item.url === "/api/image/import" && item.body.mode === "clipboard") && !app.q("#imageDialog").open);
    assert.match(app.requests.find(item => item.url === "/api/image/import" && item.body.mode === "clipboard").body.data_url, /^data:image\/png;base64,/);

    app.q("#manageImage").click();
    app.q("#imageUrlInput").value = "https://example.org/image.png";
    app.q("#importImageUrl").click();
    await until(() => app.requests.some(item => item.url === "/api/image/import" && item.body.mode === "url") && !app.q("#imageDialog").open);
    assert.equal(app.requests.find(item => item.url === "/api/image/import" && item.body.mode === "url").body.source_url, "https://example.org/image.png");
  } finally { app.dom.window.close(); }
});

test("browser image searches remain available without Cloudflare credentials", async () => {
  const app = await launch({cloudflareConfigured: false});
  try {
    app.q("#manageImage").click();
    assert.equal(app.q("#imageDialog").open, true);
    assert.equal(app.q("#generateImage").disabled, true);
    assert.match(app.q("#generatorInfo").textContent, /CLOUDFLARE_ACCOUNT_ID/);
    assert.match(app.q("#openGoogleImages").href, /google\.com\/search/);
    assert.match(app.q("#openBingImages").href, /bing\.com\/images\/search/);
    assert.match(app.q("#openOpenverse").href, /openverse\.org\/search\/image/);
    assert.equal(app.requests.filter(item => item.url === "/api/image/generate").length, 0);
  } finally { app.dom.window.close(); }
});

test("an intentionally empty lesson from the previous repository version remains empty", async () => {
  const app = await launch({saved: {key: "romanian-tts-trainer-v4", value: {phrases: "", rate: -25, repeats: 5}}});
  try {
    assert.equal(app.q("#sentenceCount").textContent, "0 фраз");
    assert.equal(app.q("#playButton").disabled, true);
    assert.equal(app.q("#rate").value, "-25");
  } finally { app.dom.window.close(); }
});
