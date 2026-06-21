/* MM2 Trade Calculator — service worker
 * Cache-first app shell for instant repeat loads + offline; network-first for the live data
 * files so values stay fresh, with a cached fallback when offline. Safe to omit entirely:
 * the app is fully self-contained and works without this file (it just won't be installable
 * or offline-cached when hosted). Bump CACHE to invalidate old caches on deploy.
 */
const CACHE = "mm2-calc-v3";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./og-image.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // live data (values.json / history.json / CHANGELOG.md) → network-first, fall back to cache
  if (/values\.json|history\.json|CHANGELOG\.md/i.test(url.pathname)) {
    e.respondWith(
      fetch(req)
        .then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return res; })
        .catch(() => caches.match(req))
    );
    return;
  }

  // everything else → cache-first, then network (and cache the result)
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req)
        .then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return res; })
        .catch(() => hit)
    )
  );
});
