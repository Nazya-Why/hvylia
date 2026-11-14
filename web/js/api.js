import { apiUrl } from './config.js';
// Тонкий клієнт до бекенду з кешем у пам'яті та локальним «stale» кешем для миттєвого старту.
const mem = new Map();
const LS = 'hv.c:';

export function peek(path) {
  const m = mem.get(path);
  if (m?.v) return m.v;
  try { const s = JSON.parse(localStorage.getItem(LS + path)); if (s) return s.v; } catch {}
  return null;
}

export function api(path, { ttl = 10 * 60e3, persist = false } = {}) {
  const hit = mem.get(path);
  if (hit?.v && Date.now() - hit.t < ttl) return Promise.resolve(hit.v);
  if (hit?.p) return hit.p;
  const p = fetch(apiUrl(path)).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(v => {
    mem.set(path, { v, t: Date.now() });
    if (persist) { try { localStorage.setItem(LS + path, JSON.stringify({ v, t: Date.now() })); } catch {} }
    return v;
  }).catch(e => {
    if (hit?.v) { mem.set(path, hit); return hit.v; }
    mem.delete(path);
    throw e;
  });
  mem.set(path, { ...(hit || {}), p });
  if (mem.size > 400) mem.delete(mem.keys().next().value);
  return p;
}

export const q = s => encodeURIComponent(s);
