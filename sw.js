// Offline support: always try the network first (so updates show up right away),
// fall back to the cached copy when offline or the network is too slow.
const CACHE = 'questlog-v4';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache so we never store stale files
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const fromNetwork = fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      });
      const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
      try {
        const res = await Promise.race([fromNetwork, timeout]);
        if (res) return res;
      } catch (e) { /* offline */ }
      const cached = await cache.match(req, { ignoreSearch: true });
      return cached || fromNetwork;
    }),
  );
});
