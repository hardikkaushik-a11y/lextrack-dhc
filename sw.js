/**
 * LexTrack service worker — offline support.
 *
 * Strategy:
 *   - Pre-cache the app shell (HTML, manifest, icons) on install.
 *   - For app-shell requests: cache-first (instant load, works offline).
 *   - For data requests (scraped.json, IK API, DeepSeek, GitHub API):
 *     network-first with cache fallback so Ishi sees the latest data
 *     when online but still gets the last-known data when offline.
 */
const CACHE_VERSION = 'lextrack-v3';
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
        // Some assets may not exist yet (e.g. before icons are generated);
        // don't fail install — partial cache is fine.
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

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // App shell: cache-first
  const isAppShell = APP_SHELL.some(p => url.pathname.endsWith(p.replace('./', '/')))
    || url.pathname.endsWith('/LexTrack-IPR-App.html')
    || url.pathname === '/' || url.pathname.endsWith('/lextrack-dhc/');

  // Data requests we want to cache for offline (scraped data + GitHub raw):
  const isData = url.host === 'raw.githubusercontent.com';

  if (isAppShell) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        // Update cache in background
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match('./LexTrack-IPR-App.html')))
    );
    return;
  }

  if (isData) {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Everything else (IK API, DeepSeek, GitHub API): network-only.
  // Don't cache because they're authenticated calls or rapidly stale.
});
