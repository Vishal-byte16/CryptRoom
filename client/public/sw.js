// Minimal service worker: exists only to satisfy PWA installability criteria.
// Deliberately does NOT cache API/socket traffic or room pages — this app's
// privacy model depends on nothing persisting, so we keep the cache to the
// static app shell only and always prefer the network.
const CACHE = "cryptroom-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Never touch API, tRPC, or realtime traffic — network only, no caching.
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        const copy = response.clone();
        if (SHELL.includes(url.pathname)) caches.open(CACHE).then(cache => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request))
  );
});
