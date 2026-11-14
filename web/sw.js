// Service worker: миттєвий запуск оболонки та кеш обкладинок. Аудіо не кешується тут (його кешує сервер і плеєр).
const V = 'hv-v1';
const SHELL = ['./', 'index.html', 'app.css', 'js/app.js', 'js/player.js', 'js/playerui.js', 'js/ui.js', 'js/store.js', 'js/api.js', 'manifest.webmanifest', 'icons/icon-192.png'];
const IMG = 'hv-img';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== IMG).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trimImages() {
  const c = await caches.open(IMG);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - 600; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/')) return; // API та аудіо — завжди мережа
    // stale-while-revalidate для оболонки
    e.respondWith(caches.open(V).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (/googleusercontent\.com|ggpht\.com|ytimg\.com/.test(url.hostname) && req.destination === 'image') {
    e.respondWith(caches.open(IMG).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok || r.type === 'opaque') { c.put(req, r.clone()); if (Math.random() < 0.05) trimImages(); }
      return r;
    }).catch(() => fetch(req)));
  }
});
