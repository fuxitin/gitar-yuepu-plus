// Simple cache-first service worker for offline viewing.
const CACHE = "gtv-cache-v13";
const ASSETS = [
  "./styles.css?v=13",
  "./app.js?v=13",
  "./manifest.webmanifest?v=13",
  "./assets/icon-192.png",
  "./assets/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only handle same-origin GET.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const accept = req.headers.get("accept") || "";
  const isHtml = req.mode === "navigate" || accept.includes("text/html");

  event.respondWith(
    (isHtml
      ? fetch(req)
          .then((resp) => {
            const copy = resp.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
            return resp;
          })
          .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
      : caches.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req).then((resp) => {
            const copy = resp.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
            return resp;
          });
        }))
  );
});
