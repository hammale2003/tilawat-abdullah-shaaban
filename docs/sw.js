/* App shell only. Audio is never cached or even intercepted here: the mp3s
 * are served from this same origin (audio/), and a service worker sitting in
 * front of media Range requests is what breaks seeking and lock-screen
 * playback on iOS. Saved recitations live as Blobs in IndexedDB instead. */

const CACHE = 'shaaban-shell-v3';

const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'privacy.html',
  'manifest.webmanifest',
  'catalog.json',
  'art.png',
  'surahs.json',
  'fonts/plex-regular.woff2',
  'fonts/plex-medium.woff2',
  'fonts/plex-semibold.woff2',
  'fonts/amiri-regular.woff2',
  'fonts/amiri-bold.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // 'reload' skips the HTTP cache, so a new version never installs yesterday's files.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Audio goes straight to the network, untouched, Range header and all.
  if (req.headers.has('range') || req.destination === 'audio' ||
      url.pathname.includes('/audio/')) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
