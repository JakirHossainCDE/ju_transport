const CACHE = "ju-transport-v2026-10-08-guest-2";
const FILES = [
  "./",
  "index.html",
  "timetable.html",
  "css/style.css",
  "js/theme.js",
  "js/main.js",
  "js/core.js",
  "js/live-tracking.js",
  "js/tracking-api.js",
  "js/tracking-core.js",
  "data/routes.json",
  "vendor/leaflet/leaflet.js",
  "vendor/leaflet/leaflet.css",
  "assets/icon.svg",
  "manifest.webmanifest",
  "vendor/fonts/NotoSansBengali-Regular.ttf",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("ju-transport-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin)
    return;
  // Configuration and live positions must never be served from an offline cache.
  if (url.pathname.endsWith("/data/tracking-config.json")) return;
  const scope = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scope)) return;
  const key = new Request(url.origin + url.pathname);
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(
            caches.open(CACHE).then((cache) => cache.put(key, copy)),
          );
        }
        return response;
      })
      .catch(
        async () =>
          (await caches.match(key)) ||
          (event.request.mode === "navigate"
            ? caches.match(new URL("index.html", self.registration.scope).href)
            : undefined) ||
          Response.error(),
      ),
  );
});
