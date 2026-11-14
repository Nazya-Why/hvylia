import { apiUrl } from './config.js';
// Бібліотека користувача: лайки, плейлисти, історія. Зберігається локально + синхронізується з сервером.
const KEY = 'hv.lib.v1', SKEY = 'hv.settings.v1';
const blank = () => ({ likes: [], playlists: [], albums: [], savedPlaylists: [], artists: [], history: [], searches: [], contexts: [], updatedAt: 0 });

function load() {
  try { return Object.assign(blank(), JSON.parse(localStorage.getItem(KEY)) || {}); } catch { return blank(); }
}
export const lib = load();
export const settings = Object.assign({ autoplay: true, sync: true, prefetch: true }, (() => { try { return JSON.parse(localStorage.getItem(SKEY)) || {}; } catch { return {}; } })());
let likeIds = new Set(lib.likes.map(t => t.id));

const subs = new Set();
export const subscribe = fn => (subs.add(fn), () => subs.delete(fn));
const emit = what => subs.forEach(f => { try { f(what); } catch (e) { console.error(e); } });

let saveT, syncT;
export function commit(what = 'lib', sync = true) {
  lib.updatedAt = Date.now();
  clearTimeout(saveT);
  saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(lib)); } catch {} }, 250);
  if (sync && settings.sync) { clearTimeout(syncT); syncT = setTimeout(push, 2000); }
  emit(what);
}
export function saveSettings() { localStorage.setItem(SKEY, JSON.stringify(settings)); emit('settings'); }

let syncState = 'idle';
export const getSync = () => syncState;
async function push() {
  try {
    const r = await fetch(apiUrl('/library'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lib) });
    const j = await r.json();
    syncState = 'ok';
    if (j.stale) await pull();
  } catch { syncState = 'offline'; }
}
export async function pull() {
  if (!settings.sync) return;
  try {
    const remote = await (await fetch(apiUrl('/library'), { cache: 'no-store' })).json();
    syncState = 'ok';
    if ((remote.updatedAt || 0) > lib.updatedAt) {
      Object.keys(lib).forEach(k => delete lib[k]);
      Object.assign(lib, blank(), remote);
      likeIds = new Set(lib.likes.map(t => t.id));
      localStorage.setItem(KEY, JSON.stringify(lib));
      emit('all');
    } else if (lib.updatedAt > (remote.updatedAt || 0)) push();
  } catch { syncState = 'offline'; }
}
window.addEventListener('pagehide', () => { try { localStorage.setItem(KEY, JSON.stringify(lib)); } catch {} });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pull(); });

export const slim = t => ({ id: t.id, title: t.title, artists: t.artists || [], album: t.album || null, duration: t.duration || 0, thumb: t.thumb, art: t.art, explicit: !!t.explicit, video: !!t.video });
const slimItem = it => ({ kind: it.kind, id: it.id, title: it.title, subtitle: it.subtitle || '', thumb: it.thumb, art: it.art, at: Date.now() });

/* ── лайки ── */
export const isLiked = id => likeIds.has(id);
export function toggleLike(t) {
  if (likeIds.has(t.id)) { likeIds.delete(t.id); lib.likes = lib.likes.filter(x => x.id !== t.id); }
  else { likeIds.add(t.id); lib.likes.unshift({ ...slim(t), at: Date.now() }); }
  commit('likes');
  return likeIds.has(t.id);
}

/* ── історія ── */
export function addHistory(t) {
  lib.history = [{ ...slim(t), at: Date.now() }, ...lib.history.filter(x => x.id !== t.id)].slice(0, 300);
  commit('history');
}
export function clearHistory() { lib.history = []; commit('history'); }
export function addSearch(q) {
  q = q.trim(); if (!q) return;
  lib.searches = [q, ...lib.searches.filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 15);
  commit('searches');
}
export function removeSearch(q) { lib.searches = lib.searches.filter(x => x !== q); commit('searches'); }
export function addContext(c) {
  if (!c || !c.route) return;
  lib.contexts = [{ ...c, at: Date.now() }, ...lib.contexts.filter(x => x.route !== c.route)].slice(0, 12);
  commit('contexts', false);
}

/* ── збережені альбоми / плейлисти / виконавці ── */
const bucket = kind => kind === 'album' ? 'albums' : kind === 'artist' ? 'artists' : 'savedPlaylists';
export const isSaved = (kind, id) => lib[bucket(kind)].some(x => x.id === id);
export function toggleSaved(item) {
  const b = bucket(item.kind);
  if (isSaved(item.kind, item.id)) lib[b] = lib[b].filter(x => x.id !== item.id);
  else lib[b].unshift(slimItem(item));
  commit('saved');
  return isSaved(item.kind, item.id);
}

/* ── власні плейлисти ── */
const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const getPlaylist = id => lib.playlists.find(p => p.id === id);
export function createPlaylist(name, tracks = []) {
  const p = { id: uid(), name: name || 'Мій плейлист', tracks: tracks.map(slim), createdAt: Date.now(), updatedAt: Date.now() };
  lib.playlists.unshift(p);
  commit('playlists');
  return p;
}
export function renamePlaylist(id, name) { const p = getPlaylist(id); if (p) { p.name = name; p.updatedAt = Date.now(); commit('playlists'); } }
export function deletePlaylist(id) { lib.playlists = lib.playlists.filter(p => p.id !== id); commit('playlists'); }
export function addToPlaylist(id, tracks) {
  const p = getPlaylist(id); if (!p) return 0;
  const have = new Set(p.tracks.map(t => t.id));
  const add = tracks.filter(t => !have.has(t.id)).map(slim);
  p.tracks.push(...add); p.updatedAt = Date.now();
  // підняти плейлист нагору
  lib.playlists = [p, ...lib.playlists.filter(x => x !== p)];
  commit('playlists');
  return add.length;
}
export function removeFromPlaylist(id, index) { const p = getPlaylist(id); if (p) { p.tracks.splice(index, 1); p.updatedAt = Date.now(); commit('playlists'); } }
export function movePlaylistTrack(id, from, to) {
  const p = getPlaylist(id); if (!p || from === to) return;
  const [t] = p.tracks.splice(from, 1); p.tracks.splice(to, 0, t); p.updatedAt = Date.now(); commit('playlists');
}

/* ── рекомендації: насіння з історії ── */
export function topArtists(n = 4) {
  const score = new Map();
  lib.history.slice(0, 150).forEach((t, i) => {
    const a = t.artists?.[0]; if (!a?.name) return;
    const k = a.id || a.name;
    const s = score.get(k) || { artist: a, n: 0, seed: t };
    s.n += 1 + (150 - i) / 150; score.set(k, s);
  });
  lib.likes.slice(0, 50).forEach(t => { const a = t.artists?.[0]; if (!a?.name) return; const k = a.id || a.name; const s = score.get(k) || { artist: a, n: 0, seed: t }; s.n += 1.5; score.set(k, s); });
  return [...score.values()].sort((a, b) => b.n - a.n).slice(0, n);
}
export function mixSeeds() {
  const ids = [];
  for (const t of lib.history) { if (!ids.includes(t.id)) ids.push(t.id); if (ids.length >= 4) break; }
  const likes = lib.likes.slice(0, 30);
  for (let i = 0; i < 2 && likes.length; i++) { const t = likes[Math.floor(Math.random() * likes.length)]; if (!ids.includes(t.id)) ids.push(t.id); }
  return ids;
}

export function exportJSON() { return JSON.stringify(lib, null, 1); }
export function importJSON(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || !Array.isArray(data.likes)) throw new Error('bad');
  Object.keys(lib).forEach(k => delete lib[k]);
  Object.assign(lib, blank(), data);
  likeIds = new Set(lib.likes.map(t => t.id));
  commit('all');
}
