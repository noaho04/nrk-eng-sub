
/**
 * NRK English Subtitles — native TextTrack version
 */

function getProgramId() {
  return location.pathname.match(/([A-Z]{2,6}\d{6,12})/)?.[1] || null;
}

async function getVttUrl(programId) {
  const resp = await fetch(`https://psapi.nrk.no/playback/manifest/program/${programId}`);
  if (!resp.ok) throw new Error(`Manifest fetch failed: ${resp.status}`);

  const data = await resp.json();
  const subs = data?.playable?.subtitles ?? [];
  const preferred =
    subs.find(s => s.webVtt && /sdh/i.test(s.webVtt) && !/non-sdh/i.test(s.webVtt)) ||
    subs.find(s => s.defaultOn && s.webVtt) ||
    subs.find(s => s.webVtt) ||
    subs[0];

  let url = preferred?.webVtt || preferred?.url;
  if (!url) throw new Error("No subtitle URL in manifest");

  if (/non-sdh-translated/i.test(url)) {
    const versions = ["170004", "170003", "170005", "170002", "170001", "170006"];
    const probes = versions.map(v => {
      const candidate = url.replace(/non-sdh-translated-\d+/, `sdh-${v}`);
      return fetch(candidate, { method: "HEAD" })
        .then(r => r.ok ? candidate : null).catch(() => null);
    });
    const sdh = (await Promise.all(probes)).find(Boolean);
    if (sdh) url = sdh;
  }
  return url;
}

// Preserve timestamps while extracting the lines for translation.
function parseVTT(vtt) {
  const cues = [];
  const timing = /((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})/;

  const seconds = t => t.replace(",", ".").split(":")
    .reduce((total, n) => total * 60 + Number(n), 0);

  for (const block of vtt.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const index = lines.findIndex(l => timing.test(l));
    if (index < 0) continue;

    const match = lines[index].match(timing);
    const text = lines.slice(index + 1)
      .map(l => l.replace(/<[^>]*>/g, "").trim())
      .filter(Boolean).join("\n");

    const start = seconds(match[1]), end = seconds(match[2]);
    if (text && Number.isFinite(start) && Number.isFinite(end) && end > start)
      cues.push({ start, end, text });
  }
  return cues;
}

// translation pipeline

async function translateOne(text) {
  const response = await chrome.runtime.sendMessage({
    type: "translate",
    text
  });

  if (response?.error) {
    throw new Error(response.error);
  }

  if (typeof response?.text !== "string") {
    throw new Error("Invalid translation response");
  }

  return response.text;
}


async function translateChunk(texts) {
  const results = [];

  for (const text of texts) {
    results.push(await translateOne(text));
  }

  return results;
}

async function buildCache(lines, onProgress) {
  const cache = new Map(), CHUNK = 40;
  for (let i = 0; i < lines.length; i += CHUNK) {
    const chunk = lines.slice(i, i + CHUNK);
    const translated = await translateChunk(chunk);
    chunk.forEach((orig, j) => cache.set(orig, translated[j] || orig));
    onProgress(Math.min(i + CHUNK, lines.length), lines.length);
  }
  return cache;
}

function lockVideo(video) {
  video.pause();
  const onPlay = () => video.pause();
  video.addEventListener("play", onPlay);
  return () => video.removeEventListener("play", onPlay);
}

function waitForVideo() {
  return new Promise(resolve => {
    const v = document.querySelector("video");
    if (v) return resolve(v);

    const obs = new MutationObserver(() => {
      const video = document.querySelector("video");
      if (video) { obs.disconnect(); resolve(video); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  });
}

// Native English subtitle track.
const TRACK_LABEL = "English (NRK Translated)";
let translatedCues = null;
let activeVideo = null;
let stopTrack = () => {};

function installTrack(video, cues) {
  if (!video || !cues?.length) return;

  let track = [...video.textTracks].find(t => t.label === TRACK_LABEL);
  if (!track) track = video.addTextTrack("subtitles", TRACK_LABEL, "en");

  track.mode = "hidden";

  // Reuse the track; never create duplicate English tracks.
  for (const cue of [...(track.cues || [])]) track.removeCue(cue);

  for (const item of cues) {
    const cue = new VTTCue(item.start, item.end, item.text);
    cue.snapToLines = false;
    cue.line = 92;
    cue.lineAlign = "end";
    cue.align = "center";
    track.addCue(cue);
  }

  for (const other of video.textTracks)
    if (other !== track) other.mode = "disabled";

  track.mode = "showing";
  activeVideo = video;

  console.log("[NRK] English cues:", track.cues?.length);
}

// Hide NRK's own Norwegian subtitle element, NOT the native English track.
function hideOriginalSubtitles() {
  if (document.getElementById("nrk-english-style")) return;
  const style = document.createElement("style");
  style.id = "nrk-english-style";
  style.textContent = `
    tv-player-subtitles,
    .tv-player-subtitle-text {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

// Main — original workflow with TextTrack replacing the DOM observer.
let currentRun = 0;
let lastProcessedId = null;

async function main() {
  const programId = getProgramId();
  if (!programId || programId === lastProcessedId) return;

  const run = ++currentRun;
  lastProcessedId = programId;
  const stale = () => run !== currentRun;
  stopTrack();
  stopTrack = () => {};
  translatedCues = null;
  activeVideo = null;

  let unlock = () => {};

  try {
    LoadingOverlay.show("Fetching subtitle data…");
    const [video, vttUrl] = await Promise.all([
      waitForVideo(), getVttUrl(programId)
    ]);
    if (stale()) return;

    unlock = lockVideo(video);
    LoadingOverlay.show("Downloading subtitles…");

    const vttResp = await fetch(vttUrl);
    if (!vttResp.ok) throw new Error(`VTT fetch failed: ${vttResp.status}`);

    const cues = parseVTT(await vttResp.text());
    if (!cues.length) throw new Error("No subtitle cues found");

    const lines = [...new Set(cues.flatMap(c =>
      c.text.split("\n").map(l => l.trim()).filter(Boolean)
    ))];

    LoadingOverlay.update(`Translating… (0 / ${lines.length})`);
    const cache = await buildCache(lines, (done, total) => {
      if (!stale()) LoadingOverlay.update(`Translating… (${done} / ${total})`);
    });
    if (stale()) return;

    translatedCues = cues.map(c => ({
      ...c,
      text: c.text.split("\n").map(l => cache.get(l.trim()) || l).join("\n")
    }));

    hideOriginalSubtitles();
    installTrack(document.querySelector("video") || video, translatedCues);

    stopTrack = () => {
      const track = activeVideo && [...activeVideo.textTracks]
        .find(t => t.label === TRACK_LABEL);
      if (track) track.mode = "disabled";
    };

    LoadingOverlay.hide();
  } catch (err) {
    if (!stale()) {
      console.error("[NRK]", err);
      LoadingOverlay.show(`Error: ${err.message}`);
      setTimeout(LoadingOverlay.hide, 4000);
    }
  } finally {
    unlock();
  }
}

// Original navigation handling + minimal track repair.
(function watchNavigation() {
  function check() {
    const id = getProgramId();
    if (id && id !== lastProcessedId) main();
    if (!id && lastProcessedId) {
      ++currentRun;
      stopTrack();
      translatedCues = null;
      lastProcessedId = null;
      LoadingOverlay.hide();
    }
  }

  const origPush = history.pushState.bind(history);
  history.pushState = function (...args) { origPush(...args); check(); };

  const origReplace = history.replaceState.bind(history);
  history.replaceState = function (...args) { origReplace(...args); check(); };

  window.addEventListener("popstate", check);
  window.navigation?.addEventListener("navigate", check);

  setInterval(() => {
    check();
    if (!translatedCues) return;

    const video = document.querySelector("video");
    if (!video) return;

    const track = [...video.textTracks].find(t => t.label === TRACK_LABEL);
    if (video !== activeVideo || !track || track.cues?.length !== translatedCues.length) {
      installTrack(video, translatedCues);
    } else {
      for (const other of video.textTracks)
        if (other !== track) other.mode = "disabled";
      track.mode = "showing";
    }
  }, 1000);
})();

main();
