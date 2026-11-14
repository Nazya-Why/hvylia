// Аудіо-рушій: черга, перемішування, повтор, автопідбір, попереднє завантаження,
// Media Session (керування з екрана блокування / навушників).
import { api } from './api.js';
import * as store from './store.js';
import { sz, artistsText } from './ui.js';

export const audio = document.getElementById('audio');
const bus = new EventTarget();
export const on = (type, fn) => bus.addEventListener(type, e => fn(e.detail));
const emit = (type, d) => bus.dispatchEvent(new CustomEvent(type, { detail: d }));

export const P = {
  queue: [], index: -1, orig: null,
  shuffle: false, repeat: 'off', // off | all | one
  ctx: null, playing: false, loading: false,
  sleepAt: 0, sleepEnd: false,
};
export const cur = () => P.queue[P.index] || null;

const PKEY = 'hv.player.v1';
let loadedId = null, recorded = null, retry = 0, pendingAt = 0, watchdog = 0;

/* ─────────── збереження стану ─────────── */
let persistT = 0;
function persist(now = false) {
  const run = () => {
    const start = Math.max(0, P.index - 30);
    const data = {
      queue: P.queue.slice(start, P.index + 200).map(store.slim), index: P.index - start,
      pos: audio.currentTime || pendingAt || 0, shuffle: P.shuffle, repeat: P.repeat, ctx: P.ctx,
    };
    try { localStorage.setItem(PKEY, JSON.stringify(data)); } catch {}
  };
  clearTimeout(persistT);
  if (now) run(); else persistT = setTimeout(run, 400);
}
function restore() {
  try {
    const d = JSON.parse(localStorage.getItem(PKEY));
    if (!d?.queue?.length) return;
    Object.assign(P, { queue: d.queue, index: Math.min(d.index, d.queue.length - 1), shuffle: !!d.shuffle, repeat: d.repeat || 'off', ctx: d.ctx });
    pendingAt = d.pos || 0;
  } catch {}
}
window.addEventListener('pagehide', () => persist(true));
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && persist(true));

/* ─────────── попереднє завантаження ─────────── */
const blobs = new Map(); // id → { ctrl, url, p }
const sentServer = new Map();
function serverPrefetch() {
  const now = Date.now();
  const pick = (a, b) => P.queue.slice(a, b).map(t => t.id).filter(id => !(sentServer.get(id) > now - 20 * 60e3));
  const dl = pick(P.index + 1, P.index + 4), rs = pick(P.index + 4, P.index + 7);
  [...dl, ...rs].forEach(id => sentServer.set(id, now));
  if (dl.length) fetch(`/api/prefetch?ids=${dl.join(',')}`, { method: 'POST' }).catch(() => {});
  if (rs.length) fetch(`/api/prefetch?ids=${rs.join(',')}&mode=resolve`, { method: 'POST' }).catch(() => {});
  if (sentServer.size > 500) sentServer.clear();
}
let nbT = 0, nbRun = 0;
function scheduleNeighbors(delay = 1200) {
  serverPrefetch();
  clearTimeout(nbT);
  nbT = setTimeout(neighbors, delay);
}
async function neighbors() {
  if (!store.settings.prefetch) return;
  const run = ++nbRun;
  const c = cur();
  const keep = new Set();
  if (c) keep.add(c.id);
  const prev = P.queue[P.index - 1];
  if (prev && blobs.get(prev.id)?.url) keep.add(prev.id);
  const saveData = navigator.connection?.saveData;
  const want = [P.queue[P.index + 1], saveData ? null : P.queue[P.index + 2]]
    .filter(t => t && (!t.duration || t.duration < 900));
  want.forEach(t => keep.add(t.id));
  for (const [id, b] of blobs) {
    if (keep.has(id) || audio.src === b.url) continue;
    b.ctrl.abort(); if (b.url) URL.revokeObjectURL(b.url); blobs.delete(id);
  }
  for (const t of want) {
    if (run !== nbRun) return;
    const ex = blobs.get(t.id);
    if (ex) { await ex.p; continue; }
    const ctrl = new AbortController();
    const e = { ctrl, url: null };
    e.p = fetch(`/api/stream/${t.id}?full=1`, { signal: ctrl.signal })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(b => { if (b.size > 20000) e.url = URL.createObjectURL(b); else blobs.delete(t.id); })
      .catch(() => blobs.delete(t.id));
    blobs.set(t.id, e);
    await e.p;
  }
}
const srcFor = id => blobs.get(id)?.url || `/api/stream/${id}`;

/* ─────────── завантаження треку ─────────── */
function load(t, autoplay = true, at = 0) {
  if (!t) return;
  loadedId = t.id; retry = 0; recorded = null;
  audio.src = srcFor(t.id);
  if (at > 1) {
    const s = () => { try { audio.currentTime = at; } catch {} };
    audio.addEventListener('loadedmetadata', s, { once: true });
  }
  P.loading = true;
  pendingAt = 0;
  if (autoplay) {
    audio.play().catch(err => { if (err.name === 'NotAllowedError') { P.playing = false; P.loading = false; emit('state'); } });
    P.playing = true;
  }
  clearTimeout(watchdog);
  watchdog = setTimeout(() => { if (P.loading && P.playing && loadedId === t.id) onError(true); }, 20000);
  mediaMeta(t);
  emit('track', t); emit('state');
  scheduleNeighbors(audio.src.startsWith('blob:') ? 400 : 2500);
  ensureRadio();
  persist();
}

/* ─────────── публічне API ─────────── */
export function playList(tracks, i = 0, ctx = null, opts = {}) {
  tracks = tracks.filter(Boolean);
  if (!tracks.length) return;
  if (opts.shuffle) { P.shuffle = true; i = Math.floor(Math.random() * tracks.length); }
  P.queue = tracks.slice(); P.index = Math.max(0, Math.min(i, tracks.length - 1)); P.orig = null; P.ctx = ctx;
  P.radioFrom = opts.radio ? tracks[0].id : null;
  if (P.shuffle) shuffleRest();
  load(cur());
  if (ctx) store.addContext(ctx);
  emit('queue');
}
export function playTrack(t, ctx) {
  playList([t], 0, ctx || { title: t.title, kind: 'radio' }, { radio: true });
}
export function toggle() {
  if (!cur()) return;
  if (loadedId !== cur().id) { load(cur(), true, pendingAt); return; }
  if (audio.paused) { audio.play().catch(() => {}); P.playing = true; } else { audio.pause(); P.playing = false; }
  emit('state');
}
export function play() { if (audio.paused) toggle(); }
export function pause() { if (!audio.paused) { audio.pause(); } P.playing = false; emit('state'); }
export function seek(sec) {
  if (!cur()) return;
  if (loadedId !== cur().id) { pendingAt = sec; emit('time'); return; }
  try { audio.currentTime = Math.max(0, sec); } catch {}
  emit('time');
  posState();
}
export function next(auto = false) {
  if (!P.queue.length) return;
  if (auto === true && P.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  if (auto === true && P.sleepEnd) { P.sleepEnd = false; P.sleepAt = 0; pause(); emit('sleep'); return; }
  if (P.index < P.queue.length - 1) P.index++;
  else if (P.repeat === 'all') P.index = 0;
  else if (radioP) { radioP.then(() => { if (P.index < P.queue.length - 1) next(auto); }); return; }
  else { pause(); audio.currentTime = 0; return; }
  load(cur());
  emit('queue');
}
export function prev() {
  if (!cur()) return;
  if (audio.currentTime > 3 || P.index === 0) { seek(0); if (audio.paused) toggle(); return; }
  P.index--;
  load(cur());
  emit('queue');
}
export function jump(i) {
  if (i < 0 || i >= P.queue.length) return;
  P.index = i; load(cur()); emit('queue');
}

function shuffleRest() {
  P.orig = P.queue.slice();
  const c = cur();
  const rest = P.queue.filter((_, j) => j !== P.index);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  P.queue = [c, ...rest]; P.index = 0;
}
export function setShuffle(onn) {
  P.shuffle = onn;
  if (!P.queue.length) { emit('state'); return; }
  if (onn) shuffleRest();
  else if (P.orig) {
    const c = cur();
    const ids = new Set(P.orig.map(t => t.id));
    P.queue = [...P.orig, ...P.queue.filter(t => !ids.has(t.id))];
    P.index = Math.max(0, P.queue.findIndex(t => t.id === c.id));
    P.orig = null;
  }
  emit('queue'); emit('state'); scheduleNeighbors(800); persist();
}
export function cycleRepeat() {
  P.repeat = P.repeat === 'off' ? 'all' : P.repeat === 'all' ? 'one' : 'off';
  emit('state'); persist();
  return P.repeat;
}
export function addNext(tracks) {
  tracks = [].concat(tracks).map(t => ({ ...store.slim(t), _q: 1 }));
  if (!cur()) { playList(tracks, 0, { title: 'Черга' }); return; }
  P.queue.splice(P.index + 1, 0, ...tracks);
  emit('queue'); scheduleNeighbors(800); persist();
}
export function addQueue(tracks) {
  tracks = [].concat(tracks).map(t => ({ ...store.slim(t), _q: 1 }));
  if (!cur()) { playList(tracks, 0, { title: 'Черга' }); return; }
  let at = P.index + 1;
  while (at < P.queue.length && P.queue[at]._q) at++;
  P.queue.splice(at, 0, ...tracks);
  emit('queue'); scheduleNeighbors(800); persist();
}
export function removeAt(i) {
  if (i === P.index) { P.queue.splice(i, 1); if (P.index >= P.queue.length) P.index = P.queue.length - 1; if (cur()) load(cur(), P.playing); else pause(); }
  else { P.queue.splice(i, 1); if (i < P.index) P.index--; }
  emit('queue'); persist();
}
export function move(from, to) {
  if (from === to) return;
  const [t] = P.queue.splice(from, 1);
  P.queue.splice(to, 0, t);
  if (from === P.index) P.index = to;
  else if (from < P.index && to >= P.index) P.index--;
  else if (from > P.index && to <= P.index) P.index++;
  emit('queue'); scheduleNeighbors(800); persist();
}
export function clearUpNext() {
  P.queue = P.queue.slice(0, P.index + 1); P.orig = null;
  emit('queue'); persist();
}
export function setSleep(min) {
  P.sleepEnd = min === 'end';
  P.sleepAt = typeof min === 'number' && min > 0 ? Date.now() + min * 60e3 : 0;
  emit('sleep');
}

/* ─────────── автопідбір (нескінченне радіо) ─────────── */
let radioP = null;
const radioSeeds = new Set();
function ensureRadio() {
  if (!store.settings.autoplay || P.repeat !== 'off' || radioP) return;
  if (P.queue.length - P.index > 3) return;
  const seed = P.queue[P.queue.length - 1] || cur();
  if (!seed || radioSeeds.has(seed.id + ':' + P.queue.length)) return;
  radioSeeds.add(seed.id + ':' + P.queue.length);
  radioP = api(`/radio/${seed.id}`, { ttl: 30 * 60e3 }).then(d => {
    const have = new Set(P.queue.map(t => t.id));
    const add = (d.tracks || []).filter(t => !have.has(t.id)).slice(0, 25).map(t => ({ ...t, _r: 1 }));
    if (add.length) {
      P.queue.push(...add);
      if (P.orig) P.orig.push(...add);
      emit('queue'); scheduleNeighbors(600); persist();
    }
  }).catch(() => {}).finally(() => { radioP = null; });
}

/* ─────────── події аудіо ─────────── */
function onError(stalled = false) {
  const t = cur(); if (!t || !audio.src) return;
  const b = blobs.get(t.id);
  const at = audio.currentTime || 0;
  if (b && audio.src === b.url) {
    blobs.delete(t.id); URL.revokeObjectURL(b.url);
    audio.src = `/api/stream/${t.id}`;
  } else if (retry++ < 1) {
    audio.src = `/api/stream/${t.id}?r=${Date.now()}`;
  } else {
    emit('error', t);
    P.loading = false;
    setTimeout(() => next('skip'), 500);
    return;
  }
  if (at > 1) audio.addEventListener('loadedmetadata', () => { audio.currentTime = at; }, { once: true });
  if (P.playing || stalled) audio.play().catch(() => {});
}
audio.addEventListener('error', () => onError());
audio.addEventListener('playing', () => {
  P.playing = true; P.loading = false; clearTimeout(watchdog);
  document.body.classList.remove('loading');
  emit('state'); posState();
});
audio.addEventListener('waiting', () => { P.loading = true; emit('state'); });
audio.addEventListener('canplay', () => { if (P.loading && audio.paused && !P.playing) { P.loading = false; emit('state'); } });
audio.addEventListener('pause', () => { if (!audio.ended) { P.playing = false; emit('state'); persist(); } });
audio.addEventListener('ended', () => next(true));
audio.addEventListener('durationchange', () => { emit('time'); posState(); });
let lastT = 0;
audio.addEventListener('timeupdate', () => {
  const t = cur();
  if (t && recorded !== t.id && audio.currentTime > 8) { recorded = t.id; store.addHistory(t); }
  if (P.sleepAt && Date.now() >= P.sleepAt) { P.sleepAt = 0; pause(); emit('sleep'); }
  const now = Date.now();
  if (now - lastT > 4000) { lastT = now; persist(); posState(); }
  emit('time');
});

/* ─────────── Media Session ─────────── */
const ms = navigator.mediaSession;
function mediaMeta(t) {
  if (!ms) return;
  const u = t.art || t.thumb;
  try {
    ms.metadata = new MediaMetadata({
      title: t.title, artist: artistsText(t), album: t.album?.name || P.ctx?.title || '',
      artwork: u ? [{ src: sz(u, 96), sizes: '96x96' }, { src: sz(u, 180), sizes: '256x256' }, { src: sz(u, 360), sizes: '512x512' }].map(a => ({ ...a, src: new URL(a.src, location.href).href })) : [],
    });
  } catch {}
}
function posState() {
  if (!ms?.setPositionState) return;
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  try { ms.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime, d) }); } catch {}
}
if (ms) {
  const h = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
  h('play', () => play());
  h('pause', () => pause());
  h('stop', () => pause());
  h('previoustrack', () => prev());
  h('nexttrack', () => next());
  h('seekto', e => seek(e.seekTime));
}
on('state', () => { if (ms) ms.playbackState = P.playing ? 'playing' : 'paused'; });

export const duration = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : cur()?.duration || 0);
export const position = () => (loadedId === cur()?.id ? audio.currentTime : pendingAt) || 0;
export function buffered() {
  const d = duration(); if (!d) return 0;
  if (audio.src.startsWith('blob:')) return 1;
  const b = audio.buffered;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= audio.currentTime + 1 && b.end(i) >= audio.currentTime) return b.end(i) / d;
  return 0;
}

export function init() {
  restore();
  if (cur()) { mediaMeta(cur()); emit('track', cur()); emit('queue'); emit('state'); }
}
