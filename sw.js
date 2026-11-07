/* Offline shell for Quran Cross-References. */

const VERSION = 'qcr-v14';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './gate.css',
  './gate.js',
  './manifest.json',
  './src/app.js',
  './src/arcs.js',
  './src/ui.js',
  './src/data.js',
  './data/quran.json',
  './data/links.json',
  './data/links-shia.json',
  './data/degree-shia.json',
  './data/meta-shia.json',
  './data/meta-sunni.json',
  './data/translation-pickthall.json',
  './data/translation-yusufali.json',
  './data/translation-qarai.json',
  './data/translation-sarwar.json',
  './public/favicon.svg',
  './public/fonts/amiri-quran-arabic.woff2',
  './public/fonts/amiri-quran-latin.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(ASSETS.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); } catch { /* keep the rest */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(VERSION);
        cache.put('./index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Code must never be stale: network-first for the shell, cache-first only
  // for the large data and font files.
  if (/\.(?:html|js|css)$/i.test(url.pathname)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'reload' });
        if (fresh.ok) {
          const cache = await caches.open(VERSION);
          cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch {
        return (await caches.match(req)) || new Response('', { status: 504 });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh.ok) {
        const cache = await caches.open(VERSION);
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch {
      return new Response('', { status: 504 });
    }
  })());
});
