const CACHE_NAME = 'metapi-shell-v2';
const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/logo.png',
  '/favicon.png',
  '/favicon-64.png',
];
const APP_SHELL_PATHS = new Set(APP_SHELL);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key !== CACHE_NAME)
        .map((key) => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (requestUrl.pathname.startsWith('/api/') || requestUrl.pathname.startsWith('/v1/')) {
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/')),
    );
    return;
  }

  if (requestUrl.pathname.startsWith('/assets/') || requestUrl.pathname === '/sw.js') {
    return;
  }

  if (!APP_SHELL_PATHS.has(requestUrl.pathname)) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') return response;
        const cloned = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
        return response;
      });
    }),
  );
});
