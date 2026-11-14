// Де живе сервер.
// • Якщо сайт відкрито з самого сервера (ПК / локальна мережа) — API на тому ж домені.
// • Якщо сайт відкрито з GitHub Pages — адресу сервера (тунель) беремо із секретного gist,
//   який сервер оновлює при кожному запуску. Ключ доступу зберігається лише на пристрої.
const LS = 'hv.server.v1';
export const remote = /github\.io$/.test(location.hostname) || new URLSearchParams(location.search).has('remote');
let cfg = {};
try { cfg = JSON.parse(localStorage.getItem(LS)) || {}; } catch {}
let base = remote ? (cfg.base || '') : '';

const save = () => localStorage.setItem(LS, JSON.stringify(cfg));
export const getCfg = () => ({ ...cfg });

export function apiUrl(p) {
  let u = base + '/api' + p;
  if (remote && cfg.key) u += (u.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(cfg.key);
  return u;
}

/** Розбирає посилання налаштування: #/setup?g=<gist>&k=<key>[&s=<server>] */
export function takeSetupFromUrl() {
  const m = location.hash.match(/^#\/setup\?(.*)$/);
  if (!m) return false;
  const p = new URLSearchParams(m[1]);
  if (p.get('k')) cfg.key = p.get('k');
  if (p.get('g')) cfg.gist = p.get('g');
  if (p.get('s')) cfg.base = p.get('s').replace(/\/+$/, '');
  save();
  history.replaceState(null, '', location.pathname + location.search + '#/');
  return true;
}
export function setManual(link) {
  const m = String(link).match(/#\/setup\?(.*)$/);
  if (!m) return false;
  location.hash = '#/setup?' + m[1];
  takeSetupFromUrl();
  return true;
}

async function ping(b, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${b}/api/health?k=${encodeURIComponent(cfg.key || '')}`, { signal: ctl.signal, cache: 'no-store' });
    return r.ok;
  } catch { return false; } finally { clearTimeout(t); }
}
async function fromGist() {
  if (!cfg.gist) return null;
  try {
    const r = await fetch(`https://api.github.com/gists/${cfg.gist}`, { cache: 'no-store' });
    const g = await r.json();
    const f = Object.values(g.files || {}).find(x => x.filename === 'hvylia.json');
    return f ? JSON.parse(f.content).url?.replace(/\/+$/, '') : null;
  } catch { return null; }
}

/** 'ok' | 'setup' (немає налаштувань) | 'offline' (сервер не відповідає) */
export async function connect() {
  if (!remote) return 'ok';
  takeSetupFromUrl();
  if (!cfg.key || (!cfg.gist && !cfg.base)) return 'setup';
  if (cfg.base && await ping(cfg.base, 3500)) { base = cfg.base; return 'ok'; }
  const fresh = await fromGist();
  if (fresh && fresh !== cfg.base && await ping(fresh)) { cfg.base = base = fresh; save(); return 'ok'; }
  base = cfg.base || fresh || '';
  return 'offline';
}
