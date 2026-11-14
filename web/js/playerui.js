// Міні-плеєр, повноекранний плеєр, текст пісні, черга.
import * as pl from './player.js';
import * as store from './store.js';
import { api } from './api.js';
import { $, $$, esc, fmt, img, sz, artistsText, dominant, markPlaying, pushOverlay, closeOverlay, sheet, toast, row, reg, sortable, haptic, icon } from './ui.js';

const { P, audio } = pl;
const mini = $('#mini'), player = $('#player');
const el = id => document.getElementById(id);
let openState = false, panel = null;
let trackMenu = () => {};
export function setTrackMenu(fn) { trackMenu = fn; }

/* ─────────── оновлення UI ─────────── */
function setIcon(btn, name) { const u = btn.querySelector('use'); if (u && u.getAttribute('href') !== '#i-' + name) u.setAttribute('href', '#i-' + name); }

let lastArt = '';
pl.on('track', t => {
  if (!t) return;
  mini.hidden = false;
  document.body.classList.add('has-mini');
  el('mini-t').textContent = t.title;
  el('mini-s').textContent = artistsText(t);
  el('pl-ctx').textContent = P.ctx?.title || 'Твоя музика';
  const title = el('pl-title');
  title.textContent = t.title;
  title.parentElement.classList.remove('marq');
  requestAnimationFrame(() => {
    const over = title.scrollWidth - title.parentElement.clientWidth;
    if (over > 4) { title.parentElement.style.setProperty('--mx', `-${over + 40}px`); title.parentElement.style.setProperty('--md', `${Math.max(6, over / 25)}s`); title.parentElement.classList.add('marq'); }
  });
  const a = el('pl-artist');
  a.textContent = artistsText(t) || '—';
  const aid = t.artists?.find(x => x.id)?.id;
  if (aid) a.setAttribute('href', `#/artist/${aid}`); else a.removeAttribute('href');
  const u = t.art || t.thumb;
  if (u !== lastArt) {
    lastArt = u;
    el('mini-img').src = sz(u, 44);
    const big = el('pl-img');
    big.onerror = () => { if (big.src.includes('maxresdefault')) big.src = big.src.replace('maxresdefault', 'hqdefault'); };
    big.src = sz(u, 460);
    el('pl-bgimg').src = sz(u, 120);
    dominant(u).then(c => { if (c && lastArt === u) document.documentElement.style.setProperty('--dyn', c); });
  }
  updateLike();
  markPlaying(t.id);
  if (panel === 'lyr') loadLyrics();
  if (panel === 'que') renderQueue();
});

pl.on('state', () => {
  const playing = P.playing;
  document.body.classList.toggle('playing', playing && !audio.paused);
  document.body.classList.toggle('loading', P.loading && playing);
  player.classList.toggle('playing-now', playing);
  setIcon($('[data-mini="toggle"]'), playing ? 'pause' : 'play');
  setIcon($('.pc-play'), playing ? 'pause' : 'play');
  $$('[data-p="shuffle"]').forEach(b => b.classList.toggle('on', P.shuffle));
  $$('[data-p="repeat"]').forEach(b => { b.classList.toggle('on', P.repeat !== 'off'); setIcon(b, P.repeat === 'one' ? 'repeat1' : 'repeat'); });
  $('[data-p="autoplay"]').classList.toggle('on', store.settings.autoplay);
  if (playing) tick();
});
pl.on('queue', () => { if (panel === 'que') renderQueue(); });
pl.on('time', () => { if (!rafOn) paintTime(); });
pl.on('error', t => toast(`Не вдалося відтворити «${t.title}» — далі`));
pl.on('sleep', () => {
  const l = el('sleep-l');
  const b = $('[data-p="sleep"]');
  if (P.sleepAt) { b.classList.add('on'); l.textContent = `${Math.ceil((P.sleepAt - Date.now()) / 60e3)} хв`; }
  else if (P.sleepEnd) { b.classList.add('on'); l.textContent = 'Кінець треку'; }
  else { b.classList.remove('on'); l.textContent = 'Таймер'; }
});
setInterval(() => { if (P.sleepAt) el('sleep-l').textContent = `${Math.ceil((P.sleepAt - Date.now()) / 60e3)} хв`; }, 30e3);

function updateLike() {
  const t = pl.cur(); if (!t) return;
  const liked = store.isLiked(t.id);
  [$('[data-mini="like"]'), $('.pl-like')].forEach(b => { b.classList.toggle('liked', liked); setIcon(b, liked ? 'heart-f' : 'heart'); });
}
store.subscribe(w => { if (w === 'likes' || w === 'all') updateLike(); if (w === 'settings') $('[data-p="autoplay"]').classList.toggle('on', store.settings.autoplay); });

/* ─────────── час / прогрес ─────────── */
const fill = el('seek-fill'), buf = el('seek-buf'), thumb = el('seek-thumb'), miniProg = el('mini-prog');
let seeking = null, rafOn = false;
function paintTime() {
  const d = pl.duration(), p = seeking != null ? seeking : pl.position();
  const r = d ? Math.min(1, p / d) : 0;
  miniProg.style.transform = `scaleX(${r})`;
  if (!openState) return;
  fill.style.transform = `scaleX(${r})`;
  thumb.style.left = `${r * 100}%`;
  buf.style.transform = `scaleX(${pl.buffered()})`;
  el('t-cur').textContent = fmt(p);
  el('t-dur').textContent = d ? fmt(d) : '–:––';
  if (panel === 'lyr') syncLyrics(p);
}
function tick() {
  if (rafOn) return;
  rafOn = true;
  const loop = () => {
    if (!P.playing || document.hidden) { rafOn = false; paintTime(); return; }
    paintTime();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && P.playing) tick(); });

// перемотування
const seekEl = el('seek');
seekEl.addEventListener('pointerdown', e => {
  const d = pl.duration(); if (!d) return;
  seekEl.setPointerCapture(e.pointerId);
  seekEl.classList.add('active');
  const rect = seekEl.getBoundingClientRect();
  const at = x => Math.max(0, Math.min(1, (x - rect.left) / rect.width)) * d;
  seeking = at(e.clientX); paintTime();
  const mv = ev => { seeking = at(ev.clientX); paintTime(); };
  const up = () => {
    seekEl.removeEventListener('pointermove', mv); seekEl.removeEventListener('pointerup', up); seekEl.removeEventListener('pointercancel', up);
    seekEl.classList.remove('active');
    pl.seek(seeking); seeking = null; paintTime();
  };
  seekEl.addEventListener('pointermove', mv); seekEl.addEventListener('pointerup', up); seekEl.addEventListener('pointercancel', up);
});

/* ─────────── відкриття / закриття ─────────── */
const closeFn = () => {
  openState = false;
  player.classList.remove('open');
  player.setAttribute('aria-hidden', 'true');
  if (panel) { $('#' + panel).classList.remove('open'); panel = null; }
  document.querySelector('meta[name=theme-color]').content = '#09090d';
};
export function openPlayer() {
  if (openState || !pl.cur()) return;
  openState = true;
  player.style.transform = '';
  player.classList.add('open');
  player.setAttribute('aria-hidden', 'false');
  pushOverlay(closeFn);
  paintTime();
  if (P.playing) tick();
}
export const closePlayer = () => { if (openState) closeOverlay(closeFn); };
export const isOpen = () => openState;

function openPanel(id) {
  if (panel === id) return;
  if (panel) { $('#' + panel).classList.remove('open'); }
  const close = () => { $('#' + id).classList.remove('open'); if (panel === id) panel = null; };
  panel = id;
  $('#' + id).classList.add('open');
  pushOverlay(close);
  panelClose = close;
  if (id === 'lyr') loadLyrics();
  if (id === 'que') renderQueue();
}
let panelClose = null;

/* ─────────── обробники кнопок ─────────── */
mini.addEventListener('click', e => {
  const b = e.target.closest('[data-mini]');
  if (b?.dataset.mini === 'toggle') { haptic(); pl.toggle(); return; }
  if (b?.dataset.mini === 'like') { const t = pl.cur(); if (t) { const v = store.toggleLike(t); haptic(); toast(v ? 'Додано в «Улюблені»' : 'Прибрано з «Улюблених»'); } return; }
  if (!mini.dataset.swiped) openPlayer();
});

player.addEventListener('click', e => {
  const b = e.target.closest('[data-p]'); if (!b) return;
  const t = pl.cur();
  switch (b.dataset.p) {
    case 'close': closePlayer(); break;
    case 'toggle': haptic(); pl.toggle(); break;
    case 'next': haptic(); pl.next(); break;
    case 'prev': haptic(); pl.prev(); break;
    case 'shuffle': pl.setShuffle(!P.shuffle); toast(P.shuffle ? 'Перемішування увімкнено' : 'Перемішування вимкнено'); break;
    case 'repeat': { const r = pl.cycleRepeat(); toast(r === 'all' ? 'Повтор усієї черги' : r === 'one' ? 'Повтор треку' : 'Повтор вимкнено'); break; }
    case 'like': if (t) { const v = store.toggleLike(t); b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); haptic(12); toast(v ? 'Додано в «Улюблені»' : 'Прибрано з «Улюблених»'); } break;
    case 'more': if (t) trackMenu(t, { fromPlayer: true }); break;
    case 'lyrics': openPanel('lyr'); break;
    case 'queue': openPanel('que'); break;
    case 'panel-close': if (panelClose) closeOverlay(panelClose); break;
    case 'share': if (t) share(t); break;
    case 'sleep': sleepMenu(); break;
    case 'autoplay': store.settings.autoplay = !store.settings.autoplay; store.saveSettings(); toast(store.settings.autoplay ? 'Автопідбір схожих треків увімкнено' : 'Автопідбір вимкнено'); break;
  }
});
export function share(t) {
  const url = `https://music.youtube.com/watch?v=${t.id}`;
  if (navigator.share) navigator.share({ title: t.title, text: `${t.title} — ${artistsText(t)}`, url }).catch(() => {});
  else navigator.clipboard?.writeText(url).then(() => toast('Посилання скопійовано'));
}
function sleepMenu() {
  const set = v => { pl.setSleep(v); toast(v === 0 ? 'Таймер вимкнено' : v === 'end' ? 'Зупиню після цього треку' : `Зупиню через ${v} хв`); };
  sheet({
    title: 'Таймер сну',
    items: [
      ...[5, 15, 30, 45, 60, 90].map(m => ({ icon: 'moon', label: `${m} хвилин`, fn: () => set(m) })),
      { icon: 'clock', label: 'До кінця треку', fn: () => set('end') },
      (P.sleepAt || P.sleepEnd) && { icon: 'close', label: 'Вимкнути таймер', fn: () => set(0), danger: true },
    ],
  });
}

/* ─────────── жести ─────────── */
// свайп униз — згорнути плеєр
(() => {
  let y0 = null, x0 = 0, dy = 0, t0 = 0, mode = null;
  const area = $('.pl-inner');
  area.addEventListener('touchstart', e => {
    if (e.target.closest('.seek, .pl-ctrls, .pl-foot')) return;
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; dy = 0; t0 = Date.now(); mode = null;
  }, { passive: true });
  area.addEventListener('touchmove', e => {
    if (y0 == null) return;
    const dx = e.touches[0].clientX - x0; dy = e.touches[0].clientY - y0;
    if (!mode) { if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) mode = 'v'; else if (Math.abs(dx) > 8) mode = 'h'; }
    if (mode === 'v' && dy > 0) { player.classList.add('drag'); player.style.transform = `translate3d(0,${dy}px,0)`; }
    if (mode === 'h' && e.target.closest('.pl-stage')) { const art = el('pl-art'); art.classList.add('swipe'); art.style.transform = `translate3d(${dx}px,0,0) rotate(${dx / 40}deg)`; art.dataset.dx = dx; }
  }, { passive: true });
  area.addEventListener('touchend', () => {
    if (y0 == null) return;
    y0 = null;
    player.classList.remove('drag');
    if (mode === 'v') {
      const v = dy / Math.max(1, Date.now() - t0);
      player.style.transform = '';
      if (dy > 140 || (dy > 50 && v > 0.6)) closePlayer();
    }
    const art = el('pl-art');
    if (mode === 'h' && art.dataset.dx) {
      const dx = +art.dataset.dx; delete art.dataset.dx;
      art.classList.remove('swipe');
      if (Math.abs(dx) > 80) {
        art.style.transform = `translate3d(${dx > 0 ? 120 : -120}%,0,0)`; art.style.opacity = '0';
        haptic();
        setTimeout(() => {
          dx < 0 ? pl.next() : pl.prev();
          art.classList.add('swipe');
          art.style.transform = `translate3d(${dx > 0 ? -60 : 60}%,0,0)`;
          requestAnimationFrame(() => requestAnimationFrame(() => { art.classList.remove('swipe'); art.style.transform = ''; art.style.opacity = ''; }));
        }, 160);
      } else art.style.transform = '';
    }
    mode = null;
  });
})();
// свайп міні-плеєра вліво/вправо — перемкнути трек
(() => {
  let x0 = null, y0 = 0, dx = 0, mode = null;
  const body = $('.mini-body');
  mini.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; mode = null; delete mini.dataset.swiped; }, { passive: true });
  mini.addEventListener('touchmove', e => {
    if (x0 == null) return;
    dx = e.touches[0].clientX - x0;
    const dyy = e.touches[0].clientY - y0;
    if (!mode) { if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dyy)) mode = 'h'; else if (Math.abs(dyy) > 10) mode = 'v'; }
    if (mode === 'h') { body.style.transition = 'none'; body.style.transform = `translate3d(${dx}px,0,0)`; body.style.opacity = String(1 - Math.min(0.6, Math.abs(dx) / 300)); }
  }, { passive: true });
  mini.addEventListener('touchend', () => {
    if (x0 == null) return; x0 = null;
    body.style.transition = 'transform .25s, opacity .25s';
    if (mode === 'h') {
      mini.dataset.swiped = '1'; setTimeout(() => delete mini.dataset.swiped, 400);
      if (Math.abs(dx) > 70) { haptic(); dx < 0 ? pl.next() : pl.prev(); }
    }
    body.style.transform = ''; body.style.opacity = '';
    if (mode === 'v' && dx === 0) { /* свайп вгору відкриває плеєр */ }
    mode = null;
  });
  // свайп вгору
  let sy = null;
  mini.addEventListener('touchstart', e => { sy = e.touches[0].clientY; }, { passive: true });
  mini.addEventListener('touchend', e => { if (sy != null && sy - (e.changedTouches[0]?.clientY ?? sy) > 40) openPlayer(); sy = null; });
})();

/* ─────────── текст пісні ─────────── */
let lyr = { id: null, data: null, lines: [], idx: -1, userScroll: 0 };
const lyrBody = el('lyr-body');
async function loadLyrics() {
  const t = pl.cur(); if (!t) return;
  el('lyr-sub').textContent = `${t.title} • ${artistsText(t)}`;
  if (lyr.id === t.id) return;
  lyr = { id: t.id, data: null, lines: [], idx: -1, userScroll: 0 };
  lyrBody.innerHTML = '<div class="ly-msg">Завантаження тексту…</div>';
  let d = null;
  try { d = await api(`/lyrics/${t.id}`, { ttl: 864e5 }); } catch {}
  if (lyr.id !== t.id) return;
  lyr.data = d;
  if (!d) { lyrBody.innerHTML = '<div class="ly-msg">Для цього треку текст не знайдено 🎧</div>'; return; }
  if (d.synced) {
    lyrBody.innerHTML = d.lines.map((l, i) => `<p class="ly" data-i="${i}" data-t="${l.t}">${esc(l.text || '♪')}</p>`).join('') + (d.source ? `<p class="ly-src">${esc(d.source)}</p>` : '');
    lyr.lines = $$('.ly', lyrBody);
    syncLyrics(pl.position());
  } else {
    lyrBody.innerHTML = `<div class="ly-plain">${esc(d.text)}</div>${d.source ? `<p class="ly-src">${esc(d.source)}</p>` : ''}`;
  }
}
function syncLyrics(pos) {
  if (!lyr.data?.synced || !lyr.lines.length) return;
  const ms = pos * 1000 + 250;
  const L = lyr.data.lines;
  let lo = 0, hi = L.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].t <= ms) { i = m; lo = m + 1; } else hi = m - 1; }
  if (i === lyr.idx) return;
  lyr.lines[lyr.idx]?.classList.remove('on');
  lyr.lines.forEach((p, j) => p.classList.toggle('past', j < i));
  lyr.idx = i;
  const cur = lyr.lines[i];
  if (cur) {
    cur.classList.add('on');
    if (Date.now() - lyr.userScroll > 3500) lyrBody.scrollTo({ top: cur.offsetTop - lyrBody.clientHeight * 0.32, behavior: 'smooth' });
  }
}
lyrBody.addEventListener('touchmove', () => { lyr.userScroll = Date.now(); }, { passive: true });
lyrBody.addEventListener('click', e => {
  const p = e.target.closest('.ly'); if (!p) return;
  pl.seek(+p.dataset.t / 1000); lyr.userScroll = 0; if (!P.playing) pl.toggle();
});

/* ─────────── черга ─────────── */
const queBody = el('que-body');
function renderQueue() {
  const t = pl.cur();
  el('que-sub').textContent = P.ctx?.title ? `Відтворюється з: ${P.ctx.title}` : '';
  if (!t) { queBody.innerHTML = '<div class="ly-msg">Черга порожня</div>'; return; }
  const upcoming = P.queue.slice(P.index + 1, P.index + 151);
  const lid = reg(P.queue, P.ctx);
  const nowL = reg([t], P.ctx);
  queBody.innerHTML = `<div class="que-sec">Зараз грає</div>${row(t, 0, nowL)}
    <div class="que-sec"><span>Далі${upcoming.some(x => x._r) ? ' • з автопідбором' : ''}</span>${upcoming.length ? '<button data-qclear>Очистити</button>' : ''}</div>
    <div class="que-list">${upcoming.map((x, j) => row(x, P.index + 1 + j, lid, { drag: true, remove: true })).join('') || '<div class="ly-msg" style="padding:30px">Більше нічого — увімкни автопідбір</div>'}</div>`;
}
queBody.addEventListener('click', e => {
  if (e.target.closest('[data-qclear]')) { pl.clearUpNext(); return; }
  const r = e.target.closest('.row'); if (!r) return;
  const i = +r.dataset.i;
  if (e.target.closest('[data-rm]')) { pl.removeAt(i); haptic(); return; }
  if (e.target.closest('[data-drag]')) return;
  if (r.closest('.que-list')) pl.jump(i);
});
sortable(queBody, (from, to) => pl.move(P.index + 1 + from, P.index + 1 + to));

export function init() {
  pl.init();
  if (!pl.cur()) { mini.hidden = true; document.body.classList.remove('has-mini'); }
  paintTime();
}
