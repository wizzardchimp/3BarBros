/* 3BarBros service worker — lets the app open with no signal.
 * Network-first for this site's own files (so a new release is picked up straight away) with the cached copy
 * as the fallback. It never touches requests to other sites, so the Google Sheet API is always live.
 * Keep VERSION equal to LOGIC_VERSION in logic.js (tests/version.test.js checks this). */
const VERSION = '2026-11-27.1';
const CACHE = '3bb-' + VERSION;
const SHELL = ['./', 'index.html', 'logic.js?v=' + VERSION, 'manifest.webmanifest', 'bump.png', 'icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('timeout')), ms); p.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); }); });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // API and anything external: straight to the network
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await withTimeout(fetch(req), 4000);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreVary: true }) || (req.mode === 'navigate' ? await cache.match('index.html') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
