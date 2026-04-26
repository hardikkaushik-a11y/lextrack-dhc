/**
 * LexTrack service worker — offline support + fast updates.
 *
 * Strategy:
 *   - HTML / manifest:  NETWORK-FIRST. Always try the live version so feature
 *                       updates land instantly (was cache-first, which was
 *                       trapping people on stale builds).
 *   - Icons:            cache-first (they almost never change).
 *   - data/scraped.json: network-first with cache fallback so Ishi sees the
 *                       latest dates online and last-known when offline.
 *   - Auth'd APIs:      pass through (no caching).
 *
 * Bumping CACHE_VERSION evicts old caches on activation. The version string
 * also includes a build timestamp so each push triggers a clean refresh.
 */
const CACHE_VERSION = 'lextrack-v9-drafting';
const APP_SHELL = [
  './LexTrack-IPR-App.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL).catch(err => {
        console.warn('[sw] App shell partial cache:', err);
      }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Allow the page to ask the SW to skip waiting (used by the page-side
// updatefound handler so a fresh SW activates without a tab close).
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // HTML, manifest, root navigations → NETWORK-FIRST so updates ship instantly
  const isHtmlOrManifest =
    req.mode === 'navigate' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('/manifest.json') ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('/lextrack-dhc/');

  // Icons → cache-first (rarely change)
  const isIcon = /\/icons\//.test(url.pathname);

  // Scraped data → network-first with cache fallback
  const isScrapedData = url.host === 'raw.githubusercontent.com' && /scraped\.json/.test(url.pathname);

  if (isHtmlOrManifest) {
    event.respondWith(
      fetch(req).then(res => {
        // Update cache in background
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then(c => c || caches.match('./LexTrack-IPR-App.html')))
    );
    return;
  }

  if (isIcon) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  if (isScrapedData) {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Everything else (IK API, DeepSeek, GitHub API): pass through, no caching.
});
