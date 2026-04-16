// Service Worker for 数学阅读 PWA
// Bump CACHE_VERSION to invalidate old caches on deploy.
const CACHE_VERSION = 'math-reader-v1';
const APP_SHELL_CACHE = CACHE_VERSION + '-shell';
const RUNTIME_CACHE = CACHE_VERSION + '-runtime';

// App shell: files that should be available offline on first load.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-infinity-white.svg'
];

// Third-party libs loaded from CDN that the app needs to run offline.
// Listed here so they're cached opaquely at install time.
const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/contrib/auto-render.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_SHELL_CACHE);
    // Cache local shell first (must succeed).
    await cache.addAll(APP_SHELL);
    // Cache CDN assets; individual failures should not abort install.
    await Promise.all(CDN_ASSETS.map(async (url) => {
      try {
        const res = await fetch(url, { mode: 'no-cors' });
        await cache.put(url, res);
      } catch (e) {
        // Network may be offline at install time; skip this asset.
      }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from older versions.
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k !== APP_SHELL_CACHE && k !== RUNTIME_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Decide whether a request should be handled by the SW at all.
// Skip non-GET (POST to R2, etc.) and non-http(s) schemes (chrome-extension, blob, data).
function shouldHandle(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // Never intercept requests to Cloudflare R2 (used for user data sync).
  // The R2 endpoint hostname varies per user, but all R2 S3 endpoints share
  // this suffix. Also skip user-custom R2 domains by matching common markers.
  if (url.hostname.endsWith('.r2.cloudflarestorage.com')) return false;
  return true;
}

// Navigation requests: network-first, fall back to cached index.html.
// This lets users always get the newest app when online while staying
// usable offline.
async function handleNavigate(request) {
  try {
    const fresh = await fetch(request);
    const cache = await caches.open(APP_SHELL_CACHE);
    cache.put('./index.html', fresh.clone()).catch(() => {});
    return fresh;
  } catch (e) {
    const cache = await caches.open(APP_SHELL_CACHE);
    const cached = await cache.match('./index.html') || await cache.match('./');
    if (cached) return cached;
    throw e;
  }
}

// Static assets: cache-first, fall back to network and cache runtime.
async function handleAsset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    // Only cache successful / opaque responses.
    if (fresh && (fresh.ok || fresh.type === 'opaque')) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    // Last-ditch: return a cached match of the same URL without query string.
    const url = new URL(request.url);
    const bare = await caches.match(url.origin + url.pathname);
    if (bare) return bare;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!shouldHandle(request)) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request));
    return;
  }

  event.respondWith(handleAsset(request));
});

// Optional: allow page to trigger immediate activation of a new SW.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
