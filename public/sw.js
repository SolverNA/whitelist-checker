// Версия подставляется при сборке на Vercel (см. stamp.js).
// Если хостинг без сборки, меняйте значение вручную при каждом обновлении сайта.
const VERSION = '__BUILD__';
const CACHE = 'wl-shell-' + VERSION;

const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

const abs = (u) => new URL(u, self.registration.scope).href;
const INDEX = abs('index.html');
const keyOf = (req) => {
  const u = new URL(req.url);
  return u.origin + u.pathname;
};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // кладём всё или ничего: частично скачанная оболочка хуже, чем старая версия
    await Promise.all(SHELL.map(async (u) => {
      const res = await fetch(new Request(abs(u), { cache: 'reload' }));
      if (!res.ok) throw new Error(u + ' ' + res.status);
      await cache.put(abs(u), res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('wl-shell-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Оболочка отдаётся из кеша сразу, без ожидания сети: при белых списках
// и обрывах связи запрос к сети может висеть десятки секунд.
// Свежая версия приезжает через новый sw.js (он не кешируется).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return;
  event.respondWith(handle(req));
});

async function handle(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(keyOf(req));
  if (hit) return hit;
  try {
    return await fetch(req);
  } catch (err) {
    if (req.mode === 'navigate') {
      const index = await cache.match(INDEX);
      if (index) return index;
    }
    throw err;
  }
}
