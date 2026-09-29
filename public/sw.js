// DosePing service worker: makes the app installable and usable offline.
// Note: a service worker cannot poll on a timer while the app is closed (browsers stop it when idle).
// Reminders while the app is closed need Web Push (see README, "Next step").

const VERSION = "doseping-v2";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.origin !== location.origin) return;      // CDN fonts/scripts: let the browser handle them
  if (url.pathname.startsWith("/api/")) return;    // never cache API responses (private health data)

  // App shell: network first, fall back to cache when offline
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("/")))
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      if (clients.length) {
        clients[0].focus();
        clients[0].postMessage({ type: "ALARM", med: e.notification.data });
      } else {
        return self.clients.openWindow("/");
      }
    })
  );
});
