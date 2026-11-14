import { apiUrl } from './config.js';
// Спільні UI-утиліти: іконки, шаблони рядків/карток, шторки, тости, колір обкладинки.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const icon = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
export function fmt(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
}
export function fmtLong(s) {
  const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60);
  return h ? `${h} год ${m} хв` : `${m} хв`;
}
export function plural(n, a, b, c) {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c}`;
}
export const tracksWord = n => plural(n, 'трек', 'треки', 'треків');
export const artistsText = t => (t?.artists || []).map(a => a.name).join(', ');

/* ── зображення потрібного розміру ── */
const DPR = Math.min(window.devicePixelRatio || 1, 3);
const STEPS = [120, 240, 360, 544, 720, 1080];
export function sz(u, css = 60) {
  if (!u) return '';
  const px = STEPS.find(s => s >= css * DPR) || 1080;
  if (/googleusercontent|ggpht/.test(u)) {
    if (/=w\d+-h\d+/.test(u)) return u.replace(/=w\d+-h\d+[^&]*$/, `=w${px}-h${px}-l90-rj`);
    if (/=s\d+/.test(u)) return u.replace(/=s\d+[^&]*$/, `=s${px}`);
    return u;
  }
  if (u.includes('i.ytimg.com')) return px <= 240 ? u.replace(/\/[a-z]*default\.jpg.*/, '/mqdefault.jpg') : u;
  return u;
}
export function img(u, css = 60, eager = false) {
  if (!u) return `<div class="ph">${icon('note')}</div>`;
  const src = sz(u, css);
  const fb = src.includes('maxresdefault') ? ` data-fb="${esc(src.replace('maxresdefault', 'hqdefault'))}" onerror="if(this.dataset.fb){this.src=this.dataset.fb;this.dataset.fb=''}"` : '';
  return `<img src="${esc(src)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" alt=""${fb}>`;
}

/* ── реєстр списків для делегування подій ── */
const lists = new Map(); let lid = 0;
export function reg(tracks, ctx) {
  const id = 'l' + (++lid);
  lists.set(id, { tracks, ctx });
  if (lists.size > 500) lists.delete(lists.keys().next().value);
  return id;
}
export const getList = id => lists.get(id);

export let currentId = null;
export function markPlaying(id) {
  currentId = id;
  $$('.row.on').forEach(r => r.classList.remove('on'));
  if (id) $$(`.row[data-id="${id}"]`).forEach(r => r.classList.add('on'));
}

const EQ = '<span class="eq"><i></i><i></i><i></i></span>';
export function row(t, i, list, o = {}) {
  const sub = [o.album && t.album?.name ? `${artistsText(t)} • ${t.album.name}` : artistsText(t)];
  if (o.dur && t.duration) sub.push(fmt(t.duration));
  const lead = o.num
    ? `<div class="r-num"><span>${o.num === true ? i + 1 : o.num}</span>${EQ}</div>`
    : `<div class="r-art">${img(t.thumb || t.art, 48)}${EQ}</div>`;
  return `<div class="row${currentId === t.id ? ' on' : ''}" data-row data-list="${list}" data-i="${i}" data-id="${esc(t.id)}">
    ${o.drag ? `<span class="drag-h" data-drag>${icon('drag')}</span>` : ''}${lead}
    <div class="r-main"><div class="r-t">${esc(t.title)}</div><div class="r-s">${t.explicit ? '<i class="ex">E</i>' : ''}<span>${esc(sub.join(' • '))}</span></div></div>
    ${o.remove ? `<button class="r-more" data-rm aria-label="Прибрати">${icon('close')}</button>` : `<button class="r-more" data-more aria-label="Більше">${icon('more')}</button>`}
  </div>`;
}
export function itemRow(it, o = {}) {
  const round = it.kind === 'artist';
  const sub = it.kind === 'artist' ? 'Виконавець' : it.kind === 'album' ? (it.subtitle || 'Альбом') : (it.subtitle ? `Плейлист • ${it.subtitle}` : 'Плейлист');
  return `<a class="row" href="${hrefFor(it)}">
    <div class="r-art lg${round ? ' round' : ''}">${o.artHtml || img(it.thumb || it.art, 60)}</div>
    <div class="r-main"><div class="r-t">${esc(it.title)}</div><div class="r-s"><span>${esc(o.sub || sub)}</span></div></div>
    ${icon('right', 'r-chev')}
  </a>`;
}
export function hrefFor(it) {
  if (!it.id) return '#/search';
  if (it.kind === 'album') return `#/album/${encodeURIComponent(it.id)}`;
  if (it.kind === 'artist') return `#/artist/${encodeURIComponent(it.id)}`;
  if (it.kind === 'playlist') return `#/playlist/${encodeURIComponent(it.id)}`;
  return '#/';
}
export function card(it, list, i, o = {}) {
  const round = it.kind === 'artist';
  let sub = it.subtitle;
  if (it.kind === 'track') sub = artistsText(it);
  else if (it.kind === 'album') sub = [it.artists?.map(a => a.name).join(', '), it.subtitle].filter(Boolean).join(' • ') || 'Альбом';
  const attrs = it.kind === 'track' ? `data-row data-list="${list}" data-i="${i}" data-id="${esc(it.id)}"` : `href="${hrefFor(it)}"`;
  return `<a class="card${round ? ' round' : ''}${o.lg ? ' lg' : ''}" ${attrs}>
    <div class="c-art">${img(it.art || it.thumb, o.lg ? 172 : 148)}</div>
    <div class="c-t">${esc(it.title)}</div>${sub ? `<div class="c-s">${esc(sub)}</div>` : ''}
  </a>`;
}
export const skelRows = (n = 8) => Array.from({ length: n }, () => '<div class="sk-row"><div class="sk a"></div><div style="flex:1"><div class="sk b"></div><div class="sk c"></div></div></div>').join('');
export const skelCards = (n = 4) => `<div class="hs">${Array.from({ length: n }, () => '<div class="card"><div class="c-art sk"></div><div class="sk" style="height:12px;margin-top:10px;width:80%"></div></div>').join('')}</div>`;

/* ── оверлеї та кнопка «Назад» на Android ── */
const overlays = [];
let ignorePop = 0;
export function pushOverlay(close) {
  overlays.push(close);
  history.pushState({ ov: overlays.length }, '');
}
const popWaiters = [];
export function closeOverlay(close) {
  const i = overlays.lastIndexOf(close);
  if (i < 0) return Promise.resolve();
  overlays.splice(i, 1);
  close();
  ignorePop++;
  history.back();
  return new Promise(r => {
    let done = false;
    const fin = () => { if (!done) { done = true; r(); } };
    popWaiters.push(fin);
    setTimeout(fin, 350);
  });
}
export function closeAllOverlays() {
  const n = overlays.length;
  while (overlays.length) overlays.pop()();
  return n;
}
export const hasOverlays = () => overlays.length > 0;
/** Викликається з popstate. true — подію оброблено оверлеєм. */
export function handlePop() {
  if (ignorePop) { ignorePop--; popWaiters.shift()?.(); return true; }
  if (overlays.length) { overlays.pop()(); return true; }
  return false;
}

/* ── шторка дій ── */
export function sheet({ head = '', title = '', items = [], body = '', onOpen } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-bg"></div><div class="sheet"><div class="sh-handle"></div>${head}${title ? `<div class="sh-title">${esc(title)}</div>` : ''}${body}
    ${items.filter(Boolean).map((it, i) => `<button class="sh-item${it.danger ? ' danger' : ''}${it.on ? ' on' : ''}" data-i="${i}">${icon(it.icon || 'right')}<span>${esc(it.label)}</span></button>`).join('')}</div>`;
  document.body.appendChild(wrap);
  const sh = wrap.querySelector('.sheet');
  const real = items.filter(Boolean);
  let closed = false;
  const doClose = () => {
    if (closed) return; closed = true;
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 320);
  };
  const close = () => closeOverlay(doClose);
  pushOverlay(doClose);
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
  wrap.querySelector('.sheet-bg').onclick = close;
  sh.addEventListener('click', e => {
    const b = e.target.closest('.sh-item'); if (!b) return;
    const it = real[+b.dataset.i];
    close().then(() => it.fn?.());
  });
  // свайп вниз для закриття
  let y0 = null, dy = 0;
  sh.addEventListener('touchstart', e => { if (sh.scrollTop <= 0) { y0 = e.touches[0].clientY; dy = 0; } }, { passive: true });
  sh.addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (dy > 0) { sh.style.transition = 'none'; sh.style.transform = `translate3d(0,${dy}px,0)`; }
  }, { passive: true });
  sh.addEventListener('touchend', () => {
    if (y0 == null) return; y0 = null;
    sh.style.transition = ''; sh.style.transform = '';
    if (dy > 90) close();
  });
  onOpen?.(wrap, close);
  return close;
}

export function promptSheet({ title, value = '', placeholder = '', ok = 'Готово' }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const close = sheet({
      title,
      body: `<form class="sh-form"><input name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" maxlength="120" enterkeyhint="done"><div class="sh-btns"><button type="button" data-x>Скасувати</button><button class="pri" type="submit">${esc(ok)}</button></div></form>`,
      onOpen(wrap, close) {
        const f = wrap.querySelector('form'), inp = f.v;
        setTimeout(() => { inp.focus(); inp.select(); }, 280);
        f.onsubmit = e => { e.preventDefault(); const v = inp.value.trim(); finish(v || null); close(); };
        f.querySelector('[data-x]').onclick = () => { finish(null); close(); };
        new MutationObserver((_, o) => { if (!wrap.isConnected) { finish(null); o.disconnect(); } }).observe(document.body, { childList: true });
      }
    });
  });
}

export const trackHead = t => `<div class="sh-head"><div class="r-art">${img(t.thumb || t.art, 50)}</div><div style="min-width:0"><b>${esc(t.title)}</b><small>${esc(artistsText(t))}</small></div></div>`;

/* ── тост ── */
let toastT;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ── домінантний колір обкладинки ── */
const colors = new Map();
export function dominant(u) {
  if (!u) return Promise.resolve(null);
  const key = sz(u, 40);
  if (colors.has(key)) return colors.get(key);
  const p = new Promise(res => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.decoding = 'async';
    im.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 16;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(im, 0, 0, 16, 16);
        const d = x.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const R = d[i], G = d[i + 1], B = d[i + 2];
          const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
          const sat = mx ? (mx - mn) / mx : 0, lum = (mx + mn) / 510;
          const wt = 0.08 + sat * sat * 3 * (lum > 0.08 && lum < 0.92 ? 1 : 0.15);
          r += R * wt; g += G * wt; b += B * wt; w += wt;
        }
        res(tone(r / w, g / w, b / w));
      } catch { res(null); }
    };
    im.onerror = () => res(null);
    im.src = apiUrl('/img?u=' + encodeURIComponent(key));
  });
  colors.set(key, p);
  return p;
}
function tone(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  s = Math.min(0.75, Math.max(s, s > 0.08 ? 0.38 : s));
  const L = Math.min(0.42, Math.max(0.26, l * 0.8));
  return `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(L * 100)}%)`;
}

/* ── «потягни, щоб перемістити» ── */
export function sortable(container, onMove) {
  container.addEventListener('pointerdown', e => {
    const h = e.target.closest('[data-drag]'); if (!h) return;
    const rowEl = h.closest('.row'); if (!rowEl) return;
    e.preventDefault();
    const rows = $$('.row', container).filter(r => r.parentElement === rowEl.parentElement);
    const from = rows.indexOf(rowEl);
    const hgt = rowEl.offsetHeight;
    const y0 = e.clientY;
    let to = from;
    rowEl.classList.add('dragging');
    rows.forEach(r => r !== rowEl && r.classList.add('shift'));
    h.setPointerCapture(e.pointerId);
    const move = ev => {
      const dy = ev.clientY - y0;
      rowEl.style.transform = `translate3d(0,${dy}px,0)`;
      to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / hgt)));
      rows.forEach((r, i) => {
        if (r === rowEl) return;
        let s = 0;
        if (from < to && i > from && i <= to) s = -hgt;
        if (from > to && i < from && i >= to) s = hgt;
        r.style.transform = s ? `translate3d(0,${s}px,0)` : '';
      });
    };
    const up = () => {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', up);
      rows.forEach(r => { r.style.transform = ''; r.classList.remove('shift', 'dragging'); });
      if (to !== from) onMove(from, to);
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  });
}

export function haptic(ms = 8) { try { navigator.vibrate?.(ms); } catch {} }
