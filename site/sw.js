/* LuftM PWA service worker. Bump CACHE_VERSION when releasing a changed app shell. */
const CACHE_VERSION = 'luftm-pages-v1';
const CACHE_NAME = `${CACHE_VERSION}-shell`;
const APP_SCOPE = self.registration.scope;
const APP_SHELL = [
  new URL('./', APP_SCOPE).href,
  new URL('./index.html', APP_SCOPE).href,
  new URL('./manifest.webmanifest', APP_SCOPE).href,
  new URL('./luftm-cost-calculator.js', APP_SCOPE).href,
  new URL('./icons/icon-192.png', APP_SCOPE).href,
  new URL('./icons/icon-512.png', APP_SCOPE).href,
  new URL('./icons/icon-maskable-512.png', APP_SCOPE).href
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('luftm-pages-') && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  // Do not cache weather APIs or any other cross-origin data requests.
  if (requestUrl.origin !== self.location.origin) return;
  if (!requestUrl.href.startsWith(APP_SCOPE)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(new URL('./index.html', APP_SCOPE).href, response.clone());
        }
        return response;
      } catch {
        return (await caches.match(new URL('./index.html', APP_SCOPE).href)) ||
          new Response('LuftM is offline. Reconnect to refresh the weather forecast.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request).then(async (response) => {
      if (response && response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    }).catch(() => null);
    return cached || await network || new Response('', { status: 504 });
  })());
});
