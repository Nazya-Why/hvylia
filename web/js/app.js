// Хвиля — роутер і сторінки.
import * as pl from './player.js';
import * as store from './store.js';
import { api, peek, q } from './api.js';
import * as ui from './ui.js';
import * as pui from './playerui.js';

const { $, $$, esc, icon, img, sz, row, card, itemRow, reg, getList, sheet, promptSheet, toast, artistsText, fmtLong, tracksWord, dominant, haptic, trackHead, skelRows, skelCards } = ui;
const lib = store.lib;
const view = $('#view');

/* ═════════════════════════ роутер ═════════════════════════ */
const cache = new Map();
let current = null, byLink = false, lastRoot = 'home';

const routes = [
  [/^$/, homePage, 'home'],
  [/^search$/, searchPage, 'search'],
  [/^library$/, libraryPage, 'library'],
  [/^artist\/(.+)$/, artistPage],
  [/^album\/(.+)$/, albumPage],
  [/^playlist\/(.+)$/, ytPlaylistPage],
  [/^my\/(.+)$/, myPlaylistPage],
  [/^liked$/, likedPage],
  [/^history$/, historyPage],
  [/^radio\/(.+)$/, radioPage],
  [/^mix$/, mixPage],
  [/^settings$/, settingsPage],
];

function parse() {
  const h = decodeURI(location.hash.replace(/^#\/?/, ''));
  const [path, qs] = h.split('?');
  return { key: h, path, params: new URLSearchParams(qs || '') };
}
export function go(href) {
  byLink = true;
  if (ui.hasOverlays()) { ui.closeAllOverlays(); history.replaceState(null, '', href); render(); return; }
  const now = '#/' + location.hash.replace(/^#\/?/, '');
  if (now === href) { render(); return; }
  location.hash = href;
}
function back() { if (history.length > 1) history.back(); else go('#/'); }

window.addEventListener('popstate', () => { ui.handlePop(); });
window.addEventListener('hashchange', () => render());

function render() {
  const r = parse();
  const viaLink = byLink; byLink = false;
  if (current) current.scroll = scrollY;
  let fn = null, root = null, m = null;
  for (const [re, f, rt] of routes) { m = r.path.match(re); if (m) { fn = f; root = rt; break; } }
  if (!fn) { go('#/'); return; }
  if (root) {
    if (viaLink && current?.root === root && current.key === r.key) { scrollTo({ top: 0, behavior: 'smooth' }); if (root === 'search') $('.s-input', current.el)?.focus(); return; }
    lastRoot = root;
  }
  let entry = cache.get(r.key);
  const fresh = !entry || entry.dirty || (viaLink && !root && entry.stale);
  if (fresh) {
    if (entry?.cleanup) entry.cleanup();
    const el = document.createElement('div');
    el.className = 'page';
    entry = { key: r.key, el, scroll: 0, root };
    cache.set(r.key, entry);
    const res = fn(el, m.slice(1).map(decodeURIComponent), r.params) || {};
    Object.assign(entry, res);
  } else {
    cache.delete(r.key); cache.set(r.key, entry);
    if (entry.needsUpdate) { entry.needsUpdate = false; entry.update(); }
    if (entry.onShow) entry.onShow();
  }
  // обмеження кешу сторінок
  if (cache.size > 18) for (const [k, e] of cache) { if (!e.root && e !== entry) { e.cleanup?.(); cache.delete(k); if (cache.size <= 18) break; } }
  current = entry;
  view.replaceChildren(entry.el);
  if (!root && viaLink) { entry.el.classList.remove('enter'); void entry.el.offsetWidth; entry.el.classList.add('enter'); }
  const y = viaLink && !root ? 0 : entry.scroll;
  scrollTo(0, y);
  requestAnimationFrame(() => scrollTo(0, y));
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === lastRoot));
  onScroll();
}

// заголовок, що проявляється під час прокрутки
let scT = false;
function onScroll() {
  if (scT) return; scT = true;
  requestAnimationFrame(() => {
    scT = false;
    const tb = current?.el.querySelector('.topbar'); if (!tb) return;
    const hero = current.el.querySelector('.hero, .ahero');
    const h = hero ? hero.offsetHeight : 200;
    const p = Math.min(1, Math.max(0, (scrollY - h * 0.45) / (h * 0.35)));
    tb.style.setProperty('--p', p.toFixed(3));
  });
}
addEventListener('scroll', onScroll, { passive: true });

store.subscribe(what => {
  for (const e of cache.values()) {
    if (!e.live || (e.live !== true && !e.live.includes(what) && what !== 'all')) continue;
    if (e === current) e.update?.(); else if (e.update) e.needsUpdate = true; else e.dirty = true;
  }
});

/* ═════════════════════════ глобальні кліки ═════════════════════════ */
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#/"]');
  if (a && !e.target.closest('[data-row]')) { e.preventDefault(); haptic(4); go(a.getAttribute('href')); return; }
  const r = e.target.closest('[data-row]');
  if (r && !e.target.closest('#player')) {
    e.preventDefault();
    const L = getList(r.dataset.list); if (!L) return;
    const i = +r.dataset.i, t = L.tracks[i]; if (!t) return;
    if (e.target.closest('[data-more]')) { trackMenu(t, L.ctx?.menu ? L.ctx.menu(i) : {}); return; }
    if (e.target.closest('[data-drag], [data-rm]')) return;
    haptic(4);
    playFrom(L, i);
  }
});
function playFrom(L, i) {
  const t = L.tracks[i];
  if (pl.cur()?.id === t.id) { if (!pl.P.playing) pl.toggle(); pui.openPlayer(); return; }
  const ctx = L.ctx ? { title: L.ctx.title, route: L.ctx.route, thumb: L.ctx.thumb, kind: L.ctx.kind } : null;
  if (L.ctx?.single) pl.playTrack(t, { ...(ctx || {}), title: ctx?.title || t.title, route: null });
  else pl.playList(L.tracks, i, ctx);
}
let longT = 0;
document.addEventListener('touchstart', e => {
  const r = e.target.closest('[data-row]'); if (!r || e.target.closest('#player')) return;
  clearTimeout(longT);
  longT = setTimeout(() => {
    const L = getList(r.dataset.list); const t = L?.tracks[+r.dataset.i]; if (!t) return;
    haptic(15); r.dataset.long = '1'; trackMenu(t, L.ctx?.menu ? L.ctx.menu(+r.dataset.i) : {});
  }, 520);
}, { passive: true });
['touchend', 'touchmove', 'touchcancel'].forEach(ev => document.addEventListener(ev, () => clearTimeout(longT), { passive: true }));
document.addEventListener('click', e => { const r = e.target.closest('[data-long]'); if (r) { delete r.dataset.long; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
document.addEventListener('contextmenu', e => { if (e.target.closest('[data-row]')) e.preventDefault(); });

/* ═════════════════════════ меню треку ═════════════════════════ */
function trackMenu(t, o = {}) {
  const liked = store.isLiked(t.id);
  const artist = t.artists?.find(a => a.id);
  sheet({
    head: trackHead(t),
    items: [
      !o.fromPlayer && { icon: 'pl-next', label: 'Відтворити наступним', fn: () => { pl.addNext(t); toast('Відтвориться наступним'); } },
      !o.fromPlayer && { icon: 'q-add', label: 'Додати в чергу', fn: () => { pl.addQueue(t); toast('Додано в чергу'); } },
      { icon: liked ? 'heart-f' : 'heart', label: liked ? 'Прибрати з «Улюблених»' : 'Додати в «Улюблені»', on: liked, fn: () => toast(store.toggleLike(t) ? 'Додано в «Улюблені»' : 'Прибрано з «Улюблених»') },
      { icon: 'pl-add', label: 'Додати в плейлист', fn: () => addToPlaylistSheet([t]) },
      o.playlistId && { icon: 'trash', label: 'Прибрати з цього плейлиста', danger: true, fn: () => { store.removeFromPlaylist(o.playlistId, o.index); toast('Прибрано з плейлиста'); } },
      { icon: 'radio', label: 'Радіо на основі треку', fn: () => go(`#/radio/${t.id}`) },
      artist && { icon: 'person', label: `Виконавець: ${artist.name}`, fn: () => go(`#/artist/${artist.id}`) },
      t.album?.id && { icon: 'album', label: `Альбом: ${t.album.name}`, fn: () => go(`#/album/${t.album.id}`) },
      { icon: 'share', label: 'Поділитися', fn: () => pui.share(t) },
    ],
  });
}
pui.setTrackMenu(trackMenu);

function addToPlaylistSheet(tracks) {
  sheet({
    title: 'Додати в плейлист',
    items: [
      { icon: 'plus', label: 'Новий плейлист', fn: async () => {
        const name = await promptSheet({ title: 'Назва плейлиста', placeholder: 'Мій плейлист', ok: 'Створити' });
        if (!name) return;
        store.createPlaylist(name, tracks); toast(`Створено «${name}»`);
      } },
      ...lib.playlists.map(p => ({ icon: 'queue', label: `${p.name} (${p.tracks.length})`, fn: () => {
        const n = store.addToPlaylist(p.id, tracks);
        toast(n ? `Додано в «${p.name}»` : 'Вже є в цьому плейлисті');
      } })),
    ],
  });
}

/* ═════════════════════════ спільні шматки ═════════════════════════ */
const topbar = (title, menu = true) => `<div class="topbar"><button class="tb-btn" data-back aria-label="Назад">${icon('back')}</button><div class="tb-title">${esc(title)}</div>${menu ? `<button class="tb-btn" data-menu aria-label="Меню">${icon('more-h')}</button>` : '<span class="tb-btn" style="background:none"></span>'}</div>`;
const errBox = (msg, retry) => `<div class="err">${esc(msg)}<br><button class="obtn" data-retry>Спробувати ще</button></div>`;
const section = (title, inner, more = '', kicker = '') => `<section class="sec"><div class="sec-h"><div>${kicker ? `<div class="sec-k">${esc(kicker)}</div>` : ''}<h2 class="sec-t">${esc(title)}</h2></div>${more}</div>${inner}</section>`;
const cardsRow = (items, o) => {
  const tracks = items.filter(x => x.kind === 'track');
  const lid = reg(tracks, { single: true, title: o?.title });
  let ti = 0;
  return `<div class="hs">${items.map(it => card(it, lid, it.kind === 'track' ? ti++ : 0, o)).join('')}</div>`;
};
function collage(tracks) {
  const arts = [...new Set(tracks.map(t => t.art || t.thumb).filter(Boolean))].slice(0, 4);
  if (arts.length < 4) return arts[0] ? img(arts[0], 250, true) : `<div class="liked-art" style="width:100%;height:100%;background:linear-gradient(135deg,#3a3550,#1d1b29)">${icon('note')}</div>`;
  return arts.map(u => img(u, 125, true)).join('');
}
const playStateEls = new WeakSet();
function ctxPlayState(el, route) {
  const upd = () => {
    const b = el.querySelector('[data-play]'); if (!b) return;
    const mine = pl.P.ctx?.route === route && pl.P.playing;
    b.querySelector('use').setAttribute('href', mine ? '#i-pause' : '#i-play');
  };
  upd();
  if (playStateEls.has(el)) return;
  playStateEls.add(el);
  pl.on('state', upd); pl.on('track', upd);
}

/** Сторінка-колекція (альбом, плейлист, мікс…) */
function collection(el, o) {
  const route = location.hash;
  const ctx = { title: o.title, kind: o.kind, route, thumb: o.thumb || o.art, menu: o.menu };
  const lid = reg(o.tracks, ctx);
  const total = o.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const meta = [o.meta, o.tracks.length ? tracksWord(o.tracks.length) : '', total ? fmtLong(total) : ''].filter(Boolean).join(' • ');
  el.innerHTML = `${topbar(o.title, !!o.onMenu)}
    <section class="hero"><div class="hero-art${o.collage ? ' collage' : ''}">${o.artHtml || img(o.art || o.thumb, 250, true)}</div>
      <h1 class="hero-t">${esc(o.title)}</h1>
      ${o.sub ? `<div class="hero-s">${o.sub}</div>` : ''}
      ${meta ? `<div class="hero-d">${esc(meta)}</div>` : ''}
      ${o.desc ? `<p class="hero-d">${esc(o.desc)}</p>` : ''}
    </section>
    <div class="actions">${o.save ? `<button class="abtn${store.isSaved(o.save.kind, o.save.id) ? ' on' : ''}" data-save aria-label="Зберегти">${icon(store.isSaved(o.save.kind, o.save.id) ? 'heart-f' : 'heart')}</button>` : ''}
      ${o.extra || ''}<button class="abtn" data-addall aria-label="Додати в плейлист">${icon('pl-add')}</button>
      <span class="grow"></span>
      ${o.tracks.length ? `<button class="abtn" data-shuffle aria-label="Перемішати">${icon('shuffle')}</button><button class="pbtn" data-play aria-label="Відтворити">${icon('play')}</button>` : ''}
    </div>
    <div class="list">${o.tracks.map((t, i) => row(t, i, lid, { num: o.num, drag: o.drag })).join('') || o.empty || ''}</div>
    ${o.after || ''}`;
  dominant(o.art || o.thumb).then(c => c && el.style.setProperty('--pc', c));
  el.querySelector('[data-back]').onclick = back;
  if (o.onMenu) el.querySelector('[data-menu]').onclick = o.onMenu;
  el.querySelector('[data-play]')?.addEventListener('click', () => {
    haptic();
    if (pl.P.ctx?.route === route && pl.cur()) { pl.toggle(); return; }
    pl.playList(o.tracks, 0, ctx, { shuffle: false });
    if (pl.P.shuffle) pl.setShuffle(false);
  });
  el.querySelector('[data-shuffle]')?.addEventListener('click', () => { haptic(); pl.playList(o.tracks, 0, ctx, { shuffle: true }); toast('Перемішане відтворення'); });
  el.querySelector('[data-addall]').onclick = () => o.tracks.length ? addToPlaylistSheet(o.tracks) : toast('Немає треків');
  el.querySelector('[data-save]')?.addEventListener('click', e => {
    const v = store.toggleSaved(o.save);
    const b = e.currentTarget; b.classList.toggle('on', v); b.querySelector('use').setAttribute('href', v ? '#i-heart-f' : '#i-heart');
    haptic(); toast(v ? 'Збережено в бібліотеку' : 'Прибрано з бібліотеки');
  });
  ctxPlayState(el, route);
}

function loading(el, title) {
  el.innerHTML = `${topbar(title || '', false)}<section class="hero"><div class="hero-art sk"></div><div class="sk" style="height:24px;width:60%;margin-top:22px"></div><div class="sk" style="height:12px;width:40%;margin-top:12px"></div></section><div class="list">${skelRows(8)}</div>`;
  el.querySelector('[data-back]').onclick = back;
}
async function loadInto(el, title, fetcher, draw) {
  const cachedV = fetcher.peek?.();
  if (!cachedV) loading(el, title);
  try { draw(cachedV || await fetcher()); }
  catch (e) {
    console.error(e);
    el.innerHTML = `${topbar(title || '', false)}<div style="height:30vh"></div>${errBox('Не вдалося завантажити. Перевір зʼєднання з сервером.')}`;
    el.querySelector('[data-back]').onclick = back;
    el.querySelector('[data-retry]').onclick = () => loadInto(el, title, fetcher, draw);
  }
}
const F = (path, o) => Object.assign(() => api(path, o), { peek: () => peek(path) });

/* ═════════════════════════ ГОЛОВНА ═════════════════════════ */
const TR = { 'Quick picks': 'Швидкий вибір', "Today's biggest hits": 'Найбільші хіти сьогодні', 'Trending': 'У тренді', 'Moods & moments': 'Настрої', 'Genres': 'Жанри', 'Recommended albums': 'Рекомендовані альбоми', 'Recommended playlists': 'Рекомендовані плейлисти', 'New releases': 'Нові релізи', 'Party music': 'Для вечірки', 'Ukrainian hits': 'Українські хіти', 'All hits': 'Усі хіти', 'Featured playlists for you': 'Плейлисти для тебе', "It's autumn": 'Осінній настрій', "It's winter": 'Зимовий настрій', "It's summer": 'Літній настрій', "It's spring": 'Весняний настрій', 'Trending songs for you': 'У тренді', 'Charts': 'Чарти', 'Recommended music videos': 'Рекомендовані кліпи', 'Listen again': 'Послухати знову', 'Mixed for you': 'Мікси для тебе', 'Long listening': 'Для довгого прослуховування', 'From the community': 'Від спільноти', 'Forgotten favorites': 'Забуті улюблені', 'Covers and remixes': 'Кавери та ремікси', 'Live performances': 'Живі виступи', 'Music videos for you': 'Кліпи для тебе', 'Albums for you': 'Альбоми для тебе', 'Workout': 'Для тренувань', 'Relax': 'Відпочинок', 'Energize': 'Енергія', 'Focus': 'Зосередження', 'Sleep': 'Сон', 'Romance': 'Романтика', 'Feel good': 'Гарний настрій', 'Sad': 'Сумне', 'Commute': 'У дорозі', 'Party': 'Вечірка' };
const tr = s => TR[s] || s;
function greet() { const h = new Date().getHours(); return h < 5 ? 'Доброї ночі' : h < 12 ? 'Доброго ранку' : h < 18 ? 'Доброго дня' : h < 23 ? 'Доброго вечора' : 'Доброї ночі'; }
const MIXG = ['linear-gradient(135deg,#7b5cff,#2b1a6e)', 'linear-gradient(135deg,#ff6fae,#6a1b4d)', 'linear-gradient(135deg,#29c5a8,#0d4d5c)', 'linear-gradient(135deg,#ffb44d,#8a3a12)', 'linear-gradient(135deg,#4da3ff,#1a2f7a)'];

function homePage(el) {
  el.innerHTML = `<div class="glow"></div>
    <header class="hdr"><h1 class="h-title" id="greet">${greet()}</h1><div class="h-actions"><a class="ibtn" href="#/history" aria-label="Історія">${icon('clock')}</a><a class="ibtn" href="#/settings" aria-label="Налаштування">${icon('gear')}</a></div></header>
    <div data-short></div><div data-personal></div><div data-yt>${section('Завантаження…', skelCards(4))}</div>`;
  const short = el.querySelector('[data-short]'), personal = el.querySelector('[data-personal]'), yt = el.querySelector('[data-yt]');

  function drawShort() {
    const items = [`<a class="sc" href="#/liked"><div class="sc-art liked-art">${icon('heart-f')}</div><div class="sc-t">Улюблені треки</div></a>`];
    const seen = new Set(['#/liked']);
    for (const c of lib.contexts) {
      if (items.length >= 6) break;
      if (!c.route || seen.has(c.route)) continue; seen.add(c.route);
      items.push(`<a class="sc" href="${esc(c.route)}"><div class="sc-art">${img(c.thumb, 56)}</div><div class="sc-t">${esc(c.title)}</div></a>`);
    }
    if (items.length < 2) items.push(`<a class="sc" href="#/history"><div class="sc-art hist-art">${icon('clock')}</div><div class="sc-t">Нещодавно прослухані</div></a>`);
    short.innerHTML = `<div class="sc-grid">${items.join('')}</div>`;
  }

  let mixData = null;
  function drawPersonal() {
    let html = '';
    const hist = lib.history.slice(0, 16);
    if (hist.length) {
      const lid = reg(hist, { single: true, title: 'Нещодавно прослухані' });
      html += section('Нещодавно прослухані', `<div class="hs">${hist.map((t, i) => card({ kind: 'track', ...t }, lid, i)).join('')}</div>`, '<a class="sec-more" href="#/history">Усі</a>');
    }
    const tops = store.topArtists(4);
    if (lib.history.length || lib.likes.length) {
      const mixCards = [`<a class="card mixc" href="#/mix"><div class="c-art" style="--mg:${MIXG[0]}">${mixData?.[0] ? img(mixData[0].art, 148) : ''}<span class="mix-tag">${icon('spark')}</span><div class="mix-cover"><small>Хвиля</small><b>Твій мікс</b></div></div><div class="c-t">Твій мікс</div><div class="c-s">Оновлюється щодня</div></a>`];
      tops.forEach((a, i) => {
        mixCards.push(`<a class="card mixc" href="#/radio/${a.seed.id}?t=${encodeURIComponent('Мікс: ' + a.artist.name)}"><div class="c-art" style="--mg:${MIXG[(i + 1) % MIXG.length]}">${img(a.seed.art || a.seed.thumb, 148)}<span class="mix-tag">${icon('radio')}</span><div class="mix-cover"><small>Мікс</small><b>${esc(a.artist.name)}</b></div></div><div class="c-t">Мікс: ${esc(a.artist.name)}</div><div class="c-s">${esc(a.artist.name)} і схожі</div></a>`);
      });
      html += section('Створено для тебе', `<div class="hs">${mixCards.join('')}</div>`);
      if (mixData?.length) {
        const picks = mixData.slice(0, 20);
        const lid = reg(picks, { title: 'Твій мікс', route: '#/mix', kind: 'mix' });
        html += section('Підібрано для тебе', `<div class="qp">${picks.map((t, i) => row(t, i, lid)).join('')}</div>`, '<a class="sec-more" href="#/mix">Більше</a>', 'На основі того, що ти слухаєш');
      }
    }
    personal.innerHTML = html;
  }
  async function loadMix() {
    const seeds = store.mixSeeds();
    if (!seeds.length) return;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('hv.mix')); } catch {}
    if (saved && Date.now() - saved.at < 3 * 3600e3 && saved.tracks?.length) { mixData = saved.tracks; drawPersonal(); return; }
    try {
      const d = await api(`/mix?seeds=${seeds.join(',')}`);
      mixData = d.tracks;
      localStorage.setItem('hv.mix', JSON.stringify({ at: Date.now(), seeds, tracks: d.tracks }));
      drawPersonal();
    } catch {}
  }
  function drawYT(sections) {
    yt.innerHTML = sections.map(s => {
      const allTracks = s.items.every(x => x.kind === 'track');
      if (allTracks) {
        const lid = reg(s.items, { single: true, title: tr(s.title) });
        return section(tr(s.title), `<div class="qp">${s.items.map((t, i) => row(t, i, lid)).join('')}</div>`);
      }
      return section(tr(s.title), cardsRow(s.items, { title: tr(s.title) }));
    }).join('');
  }
  const loadYT = async () => {
    const p = peek('/home');
    if (p) drawYT(p);
    try { drawYT(await api('/home', { ttl: 30 * 60e3, persist: true })); }
    catch { if (!p) { yt.innerHTML = errBox('Немає звʼязку з сервером'); yt.querySelector('[data-retry]').onclick = loadYT; } }
  };
  drawShort(); drawPersonal(); loadMix(); loadYT();
  return {
    live: ['history', 'likes', 'contexts', 'all'],
    update() { drawShort(); drawPersonal(); },
    onShow() { el.querySelector('#greet').textContent = greet(); },
  };
}

/* ═════════════════════════ ПОШУК ═════════════════════════ */
const TILES = [
  ['Українські хіти', 'українські хіти 2026', '#e8434f', '#7b1fa2'], ['Поп', 'pop hits', '#ff7a45', '#d63384'], ['Хіп-хоп', 'hip hop', '#6b4bff', '#1e3a8a'],
  ['Рок', 'rock classics', '#c0392b', '#2c1a1a'], ['Електроніка', 'electronic music', '#00b4d8', '#3a0ca3'], ['Чіл', 'chill vibes', '#2ec4b6', '#1b4965'],
  ['Lo-fi', 'lofi beats', '#9d4edd', '#3c096c'], ['Фонк', 'phonk', '#ff006e', '#3a0ca3'], ['Для тренувань', 'workout music', '#f77f00', '#9e0059'],
  ['Інді', 'indie', '#52b788', '#2d6a4f'], ['Джаз', 'jazz', '#b08968', '#3d2c1e'], ['Класика', 'classical music', '#6c757d', '#1b263b'],
  ['Реп UA', 'український реп', '#ffbe0b', '#e85d04'], ['Сон', 'sleep music', '#5e60ce', '#14213d'], ['Романтика', 'romantic songs', '#ff4d6d', '#590d22'], ['Ретро', '80s hits', '#f15bb5', '#00bbf9'],
];
const FILTERS = [['', 'Усе'], ['songs', 'Пісні'], ['artists', 'Виконавці'], ['albums', 'Альбоми'], ['playlists', 'Плейлисти'], ['videos', 'Кліпи']];

function searchPage(el) {
  el.innerHTML = `<div class="s-head"><h1 class="h-title">Пошук</h1>
      <div class="s-bar"><label class="s-box">${icon('search')}<input class="s-input" type="search" placeholder="Що хочеш послухати?" enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"><button class="s-clear" type="button" hidden aria-label="Очистити">${icon('close')}</button></label><button class="s-cancel" type="button">Скасувати</button></div>
      <div class="sugg" hidden></div></div>
    <div data-out></div>`;
  const inp = el.querySelector('.s-input'), clr = el.querySelector('.s-clear'), sug = el.querySelector('.sugg'), out = el.querySelector('[data-out]');
  let query = '', filter = '', sugT = 0, srT = 0, seq = 0;

  function drawEmpty() {
    const rec = lib.searches.slice(0, 8);
    out.innerHTML = (rec.length ? `<div class="recent-h"><b>Нещодавні запити</b><button data-clear-rec>Очистити</button></div>
        <div class="list">${rec.map(s => `<div class="row" data-q="${esc(s)}"><div class="r-art" style="display:grid;place-items:center;background:var(--card)">${icon('clock')}</div><div class="r-main"><div class="r-t">${esc(s)}</div></div><button class="r-more" data-rmq="${esc(s)}">${icon('close')}</button></div>`).join('')}</div>` : '')
      + section('Огляд', `<div class="tiles">${TILES.map(([l, qq, a, b]) => `<button class="tile" style="--tg:linear-gradient(135deg,${a},${b})" data-q="${esc(qq)}">${esc(l)}<i>${icon('note')}</i></button>`).join('')}</div>`);
  }
  function chips() { return `<div class="chips">${FILTERS.map(([k, l]) => `<button class="chip${k === filter ? ' on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>`; }
  async function doSearch(qq, f = filter) {
    query = qq.trim(); filter = f;
    if (!query) { drawEmpty(); return; }
    const my = ++seq;
    const path = `/search?q=${q(query)}${f ? `&filter=${f}` : ''}`;
    const pk = peek(path);
    if (!pk) out.innerHTML = chips() + `<div class="list">${skelRows(7)}</div>`;
    try {
      const d = pk || await api(path, { ttl: 15 * 60e3 });
      if (my !== seq) return;
      out.innerHTML = chips() + (f ? drawFiltered(d.items || [], f) : drawAll(d));
    } catch { if (my === seq) { out.innerHTML = chips() + errBox('Пошук не вдався'); out.querySelector('[data-retry]').onclick = () => doSearch(query, f); } }
  }
  function drawAll(d) {
    let h = '';
    const ctxS = { single: true, title: `Пошук: ${query}` };
    if (d.top) {
      const t = d.top;
      const kindL = { artist: 'Виконавець', album: 'Альбом', playlist: 'Плейлист', track: 'Трек' }[t.kind];
      const lid = t.kind === 'track' ? reg([t], ctxS) : '';
      const attrs = t.kind === 'track' ? `data-row data-list="${lid}" data-i="0" data-id="${esc(t.id)}"` : `href="${ui.hrefFor(t)}"`;
      h += `<div class="sec"><div class="sec-h"><h2 class="sec-t">Найкращий результат</h2></div><a class="top-card" ${attrs}><div class="r-art${t.kind === 'artist' ? ' round' : ''}">${img(t.art || t.thumb, 96)}</div><div class="tc-row"><div style="min-width:0"><div class="tc-t">${esc(t.title)}</div><div class="tc-s">${esc(kindL)}${t.kind === 'track' ? ' • ' + esc(artistsText(t)) : ''}</div></div><span class="pbtn" style="width:48px;height:48px">${icon(t.kind === 'track' ? 'play' : 'right')}</span></div></a></div>`;
    }
    if (d.songs?.length) {
      const songs = d.songs.slice(0, 5); const lid = reg(songs, ctxS);
      h += section('Пісні', `<div class="list">${songs.map((t, i) => row(t, i, lid)).join('')}</div>`, '<button class="sec-more" data-f="songs">Усі</button>');
    }
    if (d.artists?.length) h += section('Виконавці', cardsRow(d.artists.slice(0, 10)), '<button class="sec-more" data-f="artists">Усі</button>');
    if (d.albums?.length) h += section('Альбоми', cardsRow(d.albums.slice(0, 10)), '<button class="sec-more" data-f="albums">Усі</button>');
    if (d.playlists?.length) h += section('Плейлисти', cardsRow(d.playlists.slice(0, 10)), '<button class="sec-more" data-f="playlists">Усі</button>');
    if (d.videos?.length) { const v = d.videos.slice(0, 4); const lid = reg(v, ctxS); h += section('Кліпи', `<div class="list">${v.map((t, i) => row(t, i, lid)).join('')}</div>`, '<button class="sec-more" data-f="videos">Усі</button>'); }
    return h || `<div class="empty">${icon('search')}<b>Нічого не знайдено</b>Спробуй інший запит</div>`;
  }
  function drawFiltered(items, f) {
    if (!items.length) return `<div class="empty">${icon('search')}<b>Нічого не знайдено</b></div>`;
    if (f === 'songs' || f === 'videos') { const lid = reg(items, { single: true, title: `Пошук: ${query}` }); return `<div class="list">${items.map((t, i) => row(t, i, lid, { album: f === 'songs' })).join('')}</div>`; }
    return `<div class="list">${items.map(it => itemRow(it)).join('')}</div>`;
  }
  async function suggest(qq) {
    if (!qq.trim()) { sug.hidden = true; return; }
    try {
      const s = await api(`/suggest?q=${q(qq)}`, { ttl: 3600e3 });
      if (inp.value !== qq) return;
      sug.innerHTML = s.slice(0, 6).map(x => `<button data-q="${esc(x)}">${icon('search')}${esc(x)}</button>`).join('');
      sug.hidden = !s.length || document.activeElement !== inp;
    } catch {}
  }
  inp.addEventListener('input', () => {
    const v = inp.value;
    clr.hidden = !v;
    clearTimeout(sugT); clearTimeout(srT);
    sugT = setTimeout(() => suggest(v), 90);
    srT = setTimeout(() => doSearch(v, ''), v.length < 3 ? 650 : 380);
    if (!v) { sug.hidden = true; doSearch(''); }
  });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(srT); store.addSearch(inp.value); inp.blur(); doSearch(inp.value, filter); } });
  inp.addEventListener('focus', () => { document.body.classList.add('s-focus'); if (inp.value) suggest(inp.value); });
  inp.addEventListener('blur', () => setTimeout(() => { document.body.classList.remove('s-focus'); sug.hidden = true; }, 150));
  clr.onclick = () => { inp.value = ''; clr.hidden = true; sug.hidden = true; doSearch(''); inp.focus(); };
  el.querySelector('.s-cancel').onclick = () => { inp.value = ''; clr.hidden = true; inp.blur(); doSearch(''); };
  el.addEventListener('click', e => {
    const qb = e.target.closest('[data-q]');
    const rm = e.target.closest('[data-rmq]');
    if (rm) { e.stopPropagation(); store.removeSearch(rm.dataset.rmq); drawEmpty(); return; }
    if (e.target.closest('[data-clear-rec]')) { lib.searches = []; store.commit('searches'); drawEmpty(); return; }
    if (qb) { inp.value = qb.dataset.q; clr.hidden = false; sug.hidden = true; inp.blur(); store.addSearch(qb.dataset.q); clearTimeout(srT); doSearch(qb.dataset.q, ''); scrollTo(0, 0); return; }
    const fb = e.target.closest('[data-f]');
    if (fb) { doSearch(query, fb.dataset.f); scrollTo(0, 0); return; }
    if (query && (e.target.closest('[data-row]') || e.target.closest('a[href^="#/"]'))) store.addSearch(query);
  });
  drawEmpty();
  return { onShow() {} };
}

/* ═════════════════════════ БІБЛІОТЕКА ═════════════════════════ */
function libraryPage(el) {
  let f = '';
  function draw() {
    const L = [];
    const plRows = lib.playlists.map(p => ({ at: p.updatedAt, html: itemRow({ kind: 'playlist', title: p.name }, { artHtml: `<div class="hero-art collage" style="width:100%;height:100%;box-shadow:none;border-radius:0">${collage(p.tracks)}</div>`, sub: `Плейлист • ${tracksWord(p.tracks.length)}` }).replace('href="#/playlist/undefined"', `href="#/my/${p.id}"`), k: 'playlists' }));
    const sp = lib.savedPlaylists.map(p => ({ at: p.at, html: itemRow(p), k: 'playlists' }));
    const al = lib.albums.map(p => ({ at: p.at, html: itemRow(p), k: 'albums' }));
    const ar = lib.artists.map(p => ({ at: p.at, html: itemRow(p), k: 'artists' }));
    let items = [...plRows, ...sp, ...al, ...ar];
    if (f) items = items.filter(x => x.k === f);
    items.sort((a, b) => (b.at || 0) - (a.at || 0));
    if (!f || f === 'playlists') {
      L.push(`<a class="row" href="#/liked"><div class="r-art lg liked-art">${icon('heart-f')}</div><div class="r-main"><div class="r-t">Улюблені треки</div><div class="r-s"><span>Плейлист • ${tracksWord(lib.likes.length)}</span></div></div>${icon('right', 'r-chev')}</a>`);
      if (!f) L.push(`<a class="row" href="#/history"><div class="r-art lg hist-art">${icon('clock')}</div><div class="r-main"><div class="r-t">Нещодавно прослухані</div><div class="r-s"><span>${tracksWord(lib.history.length)}</span></div></div>${icon('right', 'r-chev')}</a>`);
    }
    L.push(...items.map(x => x.html));
    const chips = [['', 'Усе'], ['playlists', 'Плейлисти'], ['albums', 'Альбоми'], ['artists', 'Виконавці']];
    el.innerHTML = `<div class="lib-head"><header class="hdr"><h1 class="h-title">Бібліотека</h1><div class="h-actions"><button class="ibtn" data-new aria-label="Створити">${icon('plus')}</button><a class="ibtn" href="#/settings">${icon('gear')}</a></div></header>
      <div class="chips">${chips.map(([k, l]) => `<button class="chip${k === f ? ' on' : ''}" data-lf="${k}">${l}</button>`).join('')}</div></div>
      <div class="list">${L.join('')}</div>
      ${items.length === 0 && !lib.likes.length ? `<div class="empty">${icon('lib')}<b>Тут буде твоя музика</b>Став ♥ трекам, зберігай альбоми та створюй плейлисти<br><button class="obtn" data-new>Створити плейлист</button></div>` : ''}`;
  }
  el.addEventListener('click', e => {
    const c = e.target.closest('[data-lf]'); if (c) { f = c.dataset.lf; draw(); return; }
    if (e.target.closest('[data-new]')) newMenu();
  });
  draw();
  return { live: true, update: draw };
}
function newMenu() {
  sheet({
    title: 'Створити',
    items: [
      { icon: 'plus', label: 'Новий плейлист', fn: async () => {
        const name = await promptSheet({ title: 'Назва плейлиста', placeholder: 'Мій плейлист', ok: 'Створити' });
        if (name) { const p = store.createPlaylist(name); go(`#/my/${p.id}`); }
      } },
      { icon: 'link', label: 'Імпорт плейлиста з YouTube', fn: importYT },
      { icon: 'ul', label: 'Відновити бібліотеку з файлу', fn: importFile },
    ],
  });
}
async function importYT() {
  const url = await promptSheet({ title: 'Посилання на плейлист YouTube / YT Music', placeholder: 'https://youtube.com/playlist?list=…', ok: 'Імпорт' });
  if (!url) return;
  const m = url.match(/[?&]list=([\w-]+)/) || url.match(/^([\w-]{12,})$/);
  if (!m) { toast('Не схоже на посилання на плейлист'); return; }
  toast('Імпортую…');
  try {
    const d = await api(`/playlist/${m[1]}`);
    const p = store.createPlaylist(d.title || 'Імпортований плейлист', d.tracks);
    toast(`Імпортовано ${tracksWord(d.tracks.length)}`);
    go(`#/my/${p.id}`);
  } catch { toast('Не вдалося імпортувати плейлист'); }
}

/* ═════════════════════════ ВИКОНАВЕЦЬ ═════════════════════════ */
function artistPage(el, [id]) {
  loadInto(el, '', F(`/artist/${id}`, { ttl: 3600e3 }), a => {
    const route = location.hash;
    const ctx = { title: a.name, kind: 'artist', route, thumb: a.thumb };
    const lid = reg(a.songs, ctx);
    const saveItem = { kind: 'artist', id, title: a.name, subtitle: 'Виконавець', thumb: a.thumb, art: a.art };
    const followed = store.isSaved('artist', id);
    el.innerHTML = `${topbar(a.name, false)}
      <div class="ahero">${img(a.art || a.thumb, 400, true)}<h1 class="ah-name">${esc(a.name)}</h1></div>
      ${a.subscribers ? `<div class="ah-meta">${esc(a.subscribers)} підписників</div>` : ''}
      <div class="actions" style="padding-left:16px"><button class="obtn${followed ? ' on' : ''}" data-follow>${followed ? 'Відстежується' : 'Стежити'}</button>
        ${a.songs[0] ? `<button class="abtn" data-radio aria-label="Радіо">${icon('radio')}</button>` : ''}
        <span class="grow"></span>${a.songs.length ? `<button class="abtn" data-shuffle>${icon('shuffle')}</button><button class="pbtn" data-play>${icon('play')}</button>` : ''}</div>
      ${a.songs.length ? section('Популярні', `<div class="list">${a.songs.map((t, i) => row(t, i, lid, { num: true })).join('')}</div>`, a.songsPlaylist ? `<a class="sec-more" href="#/playlist/${a.songsPlaylist}">Усі пісні</a>` : '') : ''}
      ${a.albums.length ? section('Альбоми', cardsRow(a.albums)) : ''}
      ${a.singles.length ? section('Сингли та EP', cardsRow(a.singles)) : ''}
      ${a.videos.length ? section('Кліпи', cardsRow(a.videos, { title: a.name })) : ''}
      ${a.playlists.length ? section('Плейлисти', cardsRow(a.playlists)) : ''}
      ${a.related.length ? section('Схожі виконавці', cardsRow(a.related)) : ''}
      ${a.description ? `<div class="about" data-about><b>Про виконавця</b><p>${esc(a.description)}</p></div>` : ''}`;
    dominant(a.thumb).then(c => c && el.style.setProperty('--pc', c));
    el.querySelector('[data-back]').onclick = back;
    el.querySelector('[data-play]')?.addEventListener('click', () => { haptic(); if (pl.P.ctx?.route === route && pl.cur()) pl.toggle(); else pl.playList(a.songs, 0, ctx); });
    el.querySelector('[data-shuffle]')?.addEventListener('click', () => { haptic(); pl.playList(a.songs, 0, ctx, { shuffle: true }); });
    el.querySelector('[data-radio]')?.addEventListener('click', () => go(`#/radio/${a.songs[0].id}?t=${encodeURIComponent('Радіо: ' + a.name)}`));
    el.querySelector('[data-follow]').onclick = e => { const v = store.toggleSaved(saveItem); e.currentTarget.classList.toggle('on', v); e.currentTarget.textContent = v ? 'Відстежується' : 'Стежити'; haptic(); };
    el.querySelector('[data-about]')?.addEventListener('click', e => e.currentTarget.classList.toggle('open'));
    ctxPlayState(el, route);
  });
}

/* ═════════════════════════ АЛЬБОМ / ПЛЕЙЛИСТ ═════════════════════════ */
function albumPage(el, [id]) {
  loadInto(el, '', F(`/album/${id}`, { ttl: 6 * 3600e3 }), a => {
    const art = a.artists?.[0];
    collection(el, {
      title: a.title, kind: 'album', art: a.art, thumb: a.thumb, tracks: a.tracks, num: true,
      sub: `${art?.id ? `<a href="#/artist/${art.id}">${esc(a.artists.map(x => x.name).join(', '))}</a>` : esc(a.artists?.map(x => x.name).join(', ') || '')}`,
      meta: [a.type, a.year].filter(Boolean).join(' • '),
      save: { kind: 'album', id, title: a.title, subtitle: [a.artists?.map(x => x.name).join(', '), a.year].filter(Boolean).join(' • '), thumb: a.thumb, art: a.art },
    });
  });
}
function ytPlaylistPage(el, [id]) {
  loadInto(el, '', F(`/playlist/${id}`, { ttl: 30 * 60e3 }), p => {
    collection(el, {
      title: p.title, kind: 'playlist', art: p.art, thumb: p.thumb, tracks: p.tracks,
      sub: p.author ? `<span>${esc(p.author)}</span>` : '', desc: p.description,
      save: { kind: 'playlist', id, title: p.title, subtitle: p.author || '', thumb: p.thumb, art: p.art },
      onMenu: () => sheet({ title: p.title, items: [
        { icon: 'dl', label: 'Скопіювати в мої плейлисти', fn: () => { const np = store.createPlaylist(p.title, p.tracks); toast('Скопійовано'); go(`#/my/${np.id}`); } },
        { icon: 'q-add', label: 'Додати все в чергу', fn: () => { pl.addQueue(p.tracks); toast('Додано в чергу'); } },
      ] }),
    });
  });
}

/* ═════════════════════════ МОЇ ПЛЕЙЛИСТИ ═════════════════════════ */
function myPlaylistPage(el, [id]) {
  let edit = false;
  function draw() {
    const p = store.getPlaylist(id);
    if (!p) { el.innerHTML = `${topbar('', false)}<div class="empty" style="padding-top:30vh">${icon('queue')}<b>Плейлист не знайдено</b></div>`; el.querySelector('[data-back]').onclick = back; return; }
    const sc = scrollY;
    collection(el, {
      title: p.name, kind: 'my', tracks: p.tracks, collage: p.tracks.length >= 4 && new Set(p.tracks.map(t => t.art || t.thumb)).size >= 4, artHtml: collage(p.tracks),
      art: p.tracks[0]?.art, thumb: p.tracks[0]?.thumb, drag: edit,
      sub: `<span>Мій плейлист</span>`,
      extra: `<button class="abtn${edit ? ' acc' : ''}" data-edit aria-label="Редагувати">${icon(edit ? 'check' : 'edit')}</button>`,
      menu: i => ({ playlistId: id, index: i }),
      empty: `<div class="empty">${icon('note')}<b>Поки порожньо</b>Додавай треки через меню «⋯» → «Додати в плейлист»<br><a class="obtn" href="#/search">Знайти треки</a></div>`,
      onMenu: () => sheet({ title: p.name, items: [
        { icon: 'edit', label: 'Перейменувати', fn: async () => { const n = await promptSheet({ title: 'Нова назва', value: p.name }); if (n) store.renamePlaylist(id, n); } },
        { icon: 'drag', label: edit ? 'Завершити редагування' : 'Змінити порядок', fn: () => { edit = !edit; draw(); } },
        { icon: 'q-add', label: 'Додати все в чергу', fn: () => { pl.addQueue(p.tracks); toast('Додано в чергу'); } },
        { icon: 'trash', label: 'Видалити плейлист', danger: true, fn: () => sheet({ title: `Видалити «${p.name}»?`, items: [{ icon: 'trash', label: 'Так, видалити', danger: true, fn: () => { store.deletePlaylist(id); toast('Плейлист видалено'); back(); } }, { icon: 'close', label: 'Скасувати' }] }) },
      ] }),
    });
    el.querySelector('[data-edit]').onclick = () => { edit = !edit; draw(); };
    if (edit) { const list = el.querySelector('.list'); ui.sortable(list, (a, b) => store.movePlaylistTrack(id, a, b)); }
    requestAnimationFrame(() => { if (Math.abs(scrollY - sc) > 2) scrollTo(0, sc); });
  }
  draw();
  return { live: ['playlists', 'all'], update: draw };
}
function likedPage(el) {
  const draw = () => {
    collection(el, {
      title: 'Улюблені треки', kind: 'liked', tracks: lib.likes, artHtml: `<div class="liked-art" style="width:100%;height:100%">${icon('heart-f')}</div>`,
      sub: '<span>Твої ♥</span>',
      empty: `<div class="empty">${icon('heart')}<b>Тут зʼявляться треки, які сподобались</b>Натискай ♥ у плеєрі або в меню треку</div>`,
    });
    el.style.setProperty('--pc', '#5b3fd6');
  };
  draw();
  return { live: ['likes', 'all'], update: draw };
}
function historyPage(el) {
  const draw = () => {
    collection(el, {
      title: 'Нещодавно прослухані', kind: 'history', tracks: lib.history, artHtml: `<div class="hist-art" style="width:100%;height:100%">${icon('clock')}</div>`,
      empty: `<div class="empty">${icon('clock')}<b>Історія порожня</b>Увімкни будь-який трек</div>`,
      onMenu: () => sheet({ title: 'Історія', items: [{ icon: 'trash', label: 'Очистити історію', danger: true, fn: () => { store.clearHistory(); toast('Історію очищено'); } }] }),
    });
    el.style.setProperty('--pc', '#1f5a7a');
  };
  draw();
  return { live: ['history', 'all'], update: draw };
}

/* ═════════════════════════ РАДІО / МІКС ═════════════════════════ */
function radioPage(el, [id], params) {
  loadInto(el, '', F(`/radio/${id}`, { ttl: 30 * 60e3 }), d => {
    const first = d.tracks[0];
    const title = params.get('t') || (first ? `Радіо: ${first.title}` : 'Радіо');
    collection(el, { title, kind: 'radio', tracks: d.tracks, art: first?.art, thumb: first?.thumb, sub: `<span>${icon('radio')} Безкінечний підбір схожих треків</span>` });
  });
}
function mixPage(el) {
  const seeds = store.mixSeeds();
  if (!seeds.length) { el.innerHTML = `${topbar('Твій мікс', false)}<div class="empty" style="padding-top:28vh">${icon('spark')}<b>Послухай кілька треків</b>і тут зʼявиться мікс саме для тебе</div>`; el.querySelector('[data-back]').onclick = back; return; }
  const fetcher = Object.assign(async () => {
    let saved = null; try { saved = JSON.parse(localStorage.getItem('hv.mix')); } catch {}
    if (saved && Date.now() - saved.at < 3 * 3600e3 && saved.tracks?.length) return saved;
    const d = await api(`/mix?seeds=${seeds.join(',')}`);
    localStorage.setItem('hv.mix', JSON.stringify({ at: Date.now(), seeds, tracks: d.tracks }));
    return d;
  }, {});
  loadInto(el, 'Твій мікс', fetcher, d => {
    collection(el, {
      title: 'Твій мікс', kind: 'mix', tracks: d.tracks, art: d.tracks[0]?.art, thumb: d.tracks[0]?.thumb,
      artHtml: `<div class="c-art" style="width:100%;height:100%;border-radius:0;--mg:${MIXG[0]};background:var(--mg)">${d.tracks[0] ? img(d.tracks[0].art, 250, true) : ''}<div class="mix-cover"><small>Хвиля</small><b style="font-size:26px">Твій мікс</b></div></div>`,
      sub: `<span>${icon('spark')} Підібрано на основі твоєї історії та вподобань</span>`,
      onMenu: () => sheet({ title: 'Твій мікс', items: [{ icon: 'sync', label: 'Оновити мікс', fn: () => { localStorage.removeItem('hv.mix'); cache.delete(parse().key); render(); } }] }),
    });
  });
}

/* ═════════════════════════ НАЛАШТУВАННЯ ═════════════════════════ */
function settingsPage(el) {
  const s = store.settings;
  const sw = (k, t, d) => `<button class="set-row" data-sw="${k}">${icon(k === 'autoplay' ? 'radio' : k === 'prefetch' ? 'dl' : 'sync')}<div><b>${t}</b><small>${d}</small></div><span class="sw${s[k] ? ' on' : ''}"></span></button>`;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  el.innerHTML = `${topbar('Налаштування', false)}<div style="padding:calc(var(--st) + 60px) 16px 0"><h1 class="h-title">Налаштування</h1></div>
    <div class="set-group">
      ${sw('autoplay', 'Автопідбір', 'Коли черга закінчується — грати схожі треки')}
      ${sw('prefetch', 'Миттєве перемикання', 'Наперед завантажувати 2 наступні треки')}
      ${sw('sync', 'Синхронізація', 'Зберігати бібліотеку на сервері (між пристроями)')}
    </div>
    <div class="set-group">
      <button class="set-row" data-act="export">${icon('dl')}<div><b>Експорт бібліотеки</b><small>Зберегти лайки й плейлисти у файл</small></div></button>
      <button class="set-row" data-act="import">${icon('ul')}<div><b>Імпорт бібліотеки</b><small>Відновити з файлу</small></div></button>
      <button class="set-row" data-act="yt">${icon('link')}<div><b>Імпорт плейлиста YouTube</b><small>За посиланням</small></div></button>
    </div>
    <div class="set-group">
      <button class="set-row" data-act="hist">${icon('clock')}<div><b>Очистити історію</b><small>${tracksWord(lib.history.length)}</small></div></button>
      <button class="set-row" data-act="srch">${icon('search')}<div><b>Очистити історію пошуку</b></div></button>
    </div>
    ${standalone ? '' : `<div class="set-group"><div class="set-row">${icon('spark')}<div><b>Встанови на головний екран</b><small>iPhone: «Поділитися» → «На екран Додому». Android: меню ⋮ → «Додати на головний екран».</small></div></div></div>`}
    <p class="set-note">Хвиля • особистий плеєр на основі YouTube Music. Лайків: ${lib.likes.length}, плейлистів: ${lib.playlists.length}.</p>`;
  el.querySelector('[data-back]').onclick = back;
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-sw]');
    if (b) { const k = b.dataset.sw; s[k] = !s[k]; store.saveSettings(); b.querySelector('.sw').classList.toggle('on', s[k]); haptic(); if (k === 'sync' && s[k]) store.pull(); return; }
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'export') {
      const blob = new Blob([store.exportJSON()], { type: 'application/json' });
      const u = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = u; link.download = `hvylia-${new Date().toISOString().slice(0, 10)}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(u), 5000);
    }
    if (a === 'import') importFile();
    if (a === 'yt') importYT();
    if (a === 'hist') { store.clearHistory(); toast('Історію очищено'); }
    if (a === 'srch') { lib.searches = []; store.commit('searches'); toast('Історію пошуку очищено'); }
  });
}
function importFile() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = async () => {
    try { store.importJSON(await inp.files[0].text()); toast('Бібліотеку відновлено'); }
    catch { toast('Файл не підходить'); }
  };
  inp.click();
}

/* ═════════════════════════ старт ═════════════════════════ */
pui.init();
render();
store.pull();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
