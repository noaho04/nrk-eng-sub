/**
 * NRK English Subtitles — content script
 *
 * 1. Fetch the VTT subtitle file for the current episode via NRK's API.
 * 2. Translate every line into a cache via Google Translate.
 * 3. Lock the video until translation is complete.
 * 4. Watch the subtitle DOM element and replace each line from the cache.
 *    Cache misses are translated on the fly so nothing is left in Norwegian.
 * 5. Re-runs on SPA navigation between episodes.
 */

// ─── Program ID ───────────────────────────────────────────────────────────────

function getProgramId() {
  const match = location.pathname.match(/([A-Z]{2,6}\d{6,12})/);
  return match ? match[1] : null;
}

async function getVttUrl(programId) {
  const resp = await fetch(`https://psapi.nrk.no/playback/manifest/program/${programId}`);
  if (!resp.ok) throw new Error(`Manifest fetch failed: ${resp.status}`);
  const data = await resp.json();
  const subs = data?.playable?.subtitles ?? [];

  // Prefer the SDH ("på all tale") track — it has the full subtitle text.
  const preferred =
    subs.find(s => s.webVtt && /sdh/i.test(s.webVtt) && !/non-sdh/i.test(s.webVtt)) ||
    subs.find(s => s.defaultOn && s.webVtt) ||
    subs.find(s => s.webVtt) ||
    subs[0];

  let url = preferred?.webVtt || preferred?.url;
  if (!url) throw new Error("No subtitle URL in manifest");

  // If only a partial "non-sdh-translated" file was returned, probe for the
  // full SDH version by trying common version suffixes in parallel.
  if (/non-sdh-translated/i.test(url)) {
    const versions = ["170004", "170003", "170005", "170002", "170001", "170006"];
    const probes = versions.map(v => {
      const sdhUrl = url.replace(/non-sdh-translated-\d+/, `sdh-${v}`);
      return fetch(sdhUrl, { method: "HEAD" })
        .then(r => r.ok ? sdhUrl : null)
        .catch(() => null);
    });
    const sdh = (await Promise.all(probes)).find(r => r !== null);
    if (sdh) url = sdh;
  }

  return url;
}

// ─── VTT parsing ──────────────────────────────────────────────────────────────

function parseVTT(vttText) {
  const lines = new Set();
  const raw = vttText.split("\n");
  let i = 0;
  while (i < raw.length) {
    if (raw[i].includes("-->")) {
      i++;
      while (i < raw.length && raw[i].trim() !== "") {
        const clean = raw[i].replace(/<[^>]+>/g, "").trim();
        if (clean) lines.add(clean);
        i++;
      }
    } else {
      i++;
    }
  }
  return [...lines];
}

// ─── Translation ──────────────────────────────────────────────────────────────

async function translateOne(text) {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "no");
  url.searchParams.set("tl", "en");
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Translate API ${resp.status}`);
  const data = await resp.json();
  return data[0].map(p => p[0]).join("").trim();
}

async function translateChunk(texts) {
  return Promise.all(texts.map(t => translateOne(t).catch(() => t)));
}

async function buildCache(lines, onProgress) {
  const cache = new Map();
  const CHUNK = 40;
  for (let i = 0; i < lines.length; i += CHUNK) {
    const chunk = lines.slice(i, i + CHUNK);
    const translated = await translateChunk(chunk);
    chunk.forEach((orig, j) => cache.set(orig, translated[j] || orig));
    onProgress(Math.min(i + CHUNK, lines.length), lines.length);
  }
  return cache;
}

// ─── Overlay ──────────────────────────────────────────────────────────────────

let overlay = null, statusEl = null;

function showOverlay(msg) {
  if (overlay) { if (statusEl) statusEl.textContent = msg; return; }
  const style = document.createElement("style");
  style.textContent = `@keyframes _nrk_spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(style);
  overlay = document.createElement("div");
  overlay.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:rgba(10,10,10,0.85);
    backdrop-filter:blur(8px);display:flex;flex-direction:column;align-items:center;
    justify-content:center;font-family:ui-sans-serif,sans-serif;color:#fff;gap:16px;`;
  const spinner = document.createElement("div");
  spinner.style.cssText = `width:36px;height:36px;border:3px solid rgba(255,255,255,0.15);
    border-top-color:#fff;border-radius:50%;animation:_nrk_spin 0.8s linear infinite;`;
  const label = document.createElement("div");
  label.style.cssText = `font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;opacity:0.45;`;
  label.textContent = "NRK English Subtitles";
  statusEl = document.createElement("div");
  statusEl.style.cssText = `font-size:15px;font-weight:500;max-width:320px;text-align:center;line-height:1.5;`;
  statusEl.textContent = msg;
  overlay.append(spinner, label, statusEl);
  document.body.appendChild(overlay);
}

function hideOverlay() {
  overlay?.remove(); overlay = null; statusEl = null;
}

// ─── Video lock ───────────────────────────────────────────────────────────────

function lockVideo(video) {
  video.pause();
  const onPlay = () => { if (video._nrkLocked) video.pause(); };
  video._nrkLocked = true;
  video.addEventListener("play", onPlay);
  return () => { video._nrkLocked = false; video.removeEventListener("play", onPlay); };
}

function waitForVideo() {
  return new Promise(resolve => {
    const v = document.querySelector("video");
    if (v) return resolve(v);
    const obs = new MutationObserver(() => {
      const v = document.querySelector("video");
      if (v) { obs.disconnect(); resolve(v); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  });
}

// ─── Subtitle observer ────────────────────────────────────────────────────────

const SELECTORS = [
  "tv-player-subtitles .tv-player-subtitle-text",
  ".tv-player-subtitle-text",
  "[class*='subtitle-text']",
  "tv-player-subtitles span",
];

function findSubtitleSpan() {
  for (const sel of SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function observeSubtitles(cache) {
  let spanRef = null;
  let lastInput = "";

  async function translateAndSet(span, norwegianText) {
    try {
      const lines = norwegianText.split("\n").map(l => l.trim()).filter(Boolean);
      const translated = await translateChunk(lines);
      lines.forEach((orig, i) => { if (!cache.has(orig)) cache.set(orig, translated[i] || orig); });
      const result = translated.join("\n");
      if (span.isConnected && lastInput === norwegianText) {
        lastInput = result;
        span.textContent = result;
      }
    } catch { /* leave as-is */ }
  }

  function onMutation() {
    const span = spanRef || (spanRef = findSubtitleSpan());
    if (!span) return;
    if (!span.isConnected) { spanRef = null; return; }

    const text = span.textContent.trim();
    if (!text || text === lastInput) return;
    lastInput = text;

    // Look up each line individually (the DOM joins multi-line cues with \n).
    const lines = text.split("\n").map(l => l.trim());
    const hits = lines.map(line => cache.get(line));

    if (hits.every(h => h !== undefined)) {
      const result = hits.join("\n");
      if (result !== text) { lastInput = result; span.textContent = result; }
    } else {
      translateAndSet(span, text);
    }
  }

  function attach(container) {
    const obs = new MutationObserver(onMutation);
    obs.observe(container, { childList: true, characterData: true, subtree: true });
    onMutation();
    return () => obs.disconnect();
  }

  const existing = document.querySelector("tv-player-subtitles") ||
                   document.querySelector("[class*='subtitle']");
  if (existing) return attach(existing);

  let detach = () => {};
  const waitObs = new MutationObserver((_, obs) => {
    const el = document.querySelector("tv-player-subtitles") ||
               document.querySelector("[class*='subtitle']");
    if (el) { obs.disconnect(); detach = attach(el); }
  });
  waitObs.observe(document.documentElement, { childList: true, subtree: true });
  return () => { waitObs.disconnect(); detach(); };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let currentRun = 0;
let lastProcessedId = null;
let stopObserver = null;

async function main() {
  const programId = getProgramId();
  if (!programId) return;
  if (programId === lastProcessedId) return;

  const run = ++currentRun;
  lastProcessedId = programId;
  const stale = () => run !== currentRun;

  if (stopObserver) { stopObserver(); stopObserver = null; }

  let unlock = () => {};
  try {
    showOverlay("Fetching subtitle data…");
    const [video, vttUrl] = await Promise.all([waitForVideo(), getVttUrl(programId)]);
    if (stale()) return;

    unlock = lockVideo(video);

    showOverlay("Downloading subtitles…");
    const vttResp = await fetch(vttUrl);
    if (stale()) { unlock(); hideOverlay(); return; }
    if (!vttResp.ok) throw new Error(`VTT fetch failed: ${vttResp.status}`);

    const lines = parseVTT(await vttResp.text());
    if (lines.length === 0) throw new Error("No subtitle lines found");

    showOverlay(`Translating… (0 / ${lines.length})`);
    const cache = await buildCache(lines, (done, total) => {
      if (!stale()) showOverlay(`Translating… (${done} / ${total})`);
    });
    if (stale()) { unlock(); hideOverlay(); return; }

    stopObserver = observeSubtitles(cache);
    unlock();
    hideOverlay();
  } catch (err) {
    if (stale()) return;
    console.error("[NRK]", err);
    showOverlay(`Error: ${err.message}`);
    unlock();
    setTimeout(hideOverlay, 4000);
    stopObserver = observeSubtitles(new Map());
  }
}

// ─── SPA navigation ───────────────────────────────────────────────────────────

(function watchNavigation() {
  function check() {
    const id = getProgramId();
    if (id && id !== lastProcessedId) main();
  }

  // History API (most SPAs).
  const origPush = history.pushState.bind(history);
  history.pushState = function (...args) { origPush(...args); check(); };
  const origReplace = history.replaceState.bind(history);
  history.replaceState = function (...args) { origReplace(...args); check(); };
  window.addEventListener("popstate", check);

  // Navigation API (Chrome 102+).
  window.navigation?.addEventListener("navigate", check);

  // Polling fallback for any navigation method not caught above.
  setInterval(check, 1000);
})();

main();
