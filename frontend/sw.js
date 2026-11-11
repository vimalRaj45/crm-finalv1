// Salesforge System Service Worker - Dynamic Cache & API Bypass
const CACHE_NAME = "salesforge-v1";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const urlString = e.request.url;

  // Ignore non-HTTP/HTTPS requests (e.g., chrome-extension://, moz-extension://, blob:, data:)
  if (!urlString.startsWith("http:") && !urlString.startsWith("https:")) {
    return;
  }

  // Only handle GET requests for caching
  if (e.request.method !== "GET") {
    return;
  }

  const url = new URL(urlString);

  // NEVER intercept or cache API requests, SSE streams, or OAuth callbacks
  if (url.pathname.startsWith("/api/") || url.pathname.includes("/logs/stream")) {
    return;
  }

  // Network-first for HTML pages so latest UI is always loaded
  if (e.request.mode === "navigate" || e.request.headers.get("accept")?.includes("text/html")) {
    e.respondWith(
      fetch(e.request)
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Stale-while-revalidate for static assets
  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      const fetchPromise = fetch(e.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && (networkResponse.type === "basic" || networkResponse.type === "cors")) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache).catch(() => {
              // Ignore scheme or quota storage errors gracefully
            });
          }).catch(() => {});
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});

