// ─── DosePing Service Worker ──────────────────────────────────────────────
// Runs in the background even when the tab is closed.
// Checks for medicine reminders every minute via periodic sync or fallback.

const SW_VERSION = "doseping-v1";
const API_BASE   = "https://doseping.onrender.com/api";

// ── Install & activate ────────────────────────────────────────────────────
self.addEventListener("install",  e => { self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(self.clients.claim()); });

// ── Message from main page ────────────────────────────────────────────────
// The page sends { type: "START_REMINDERS", token: "..." } after login
self.addEventListener("message", e => {
  if (e.data?.type === "START_REMINDERS") {
    authToken = e.data.token;
    // Kick off an immediate check
    checkReminders();
  }
  if (e.data?.type === "STOP_REMINDERS") {
    authToken = null;
  }
});

let authToken = null;

// ── Periodic check via setInterval inside SW ─────────────────────────────
// Service workers can't use setInterval directly for long periods,
// so we use a self-posting message trick for reliable 60s intervals.
let reminderInterval = null;

self.addEventListener("activate", () => {
  if (reminderInterval) clearInterval(reminderInterval);
  reminderInterval = setInterval(() => {
    if (authToken) checkReminders();
  }, 60 * 1000);
});

// ── Background Sync fallback ──────────────────────────────────────────────
self.addEventListener("periodicsync", e => {
  if (e.tag === "check-reminders") {
    e.waitUntil(checkReminders());
  }
});

// ── Notification click ────────────────────────────────────────────────────
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      if (clients.length > 0) {
        clients[0].focus();
        clients[0].postMessage({ type: "ALARM", med: e.notification.data });
      } else {
        self.clients.openWindow("/");
      }
    })
  );
});

// ── Core reminder check ────────────────────────────────────────────────────
const _fired = new Set();

async function checkReminders() {
  if (!authToken) return;
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 10000);
    const deviceTime = new Date().getHours().toString().padStart(2,"0")+":"+new Date().getMinutes().toString().padStart(2,"0");
    const res        = await fetch(API_BASE + "/reminders/check?time=" + deviceTime, {
      headers: { "Authorization": "Bearer " + authToken },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) return;

    const data = await res.json();
    const minute = new Date().toISOString().slice(0, 16);

    for (const med of (data.due || [])) {
      const key = `${med.id}-${minute}`;
      if (_fired.has(key)) continue;
      _fired.add(key);
      if (_fired.size > 200) {
        const first = _fired.values().next().value;
        _fired.delete(first);
      }

      // Show notification from service worker
      // This works even when the tab is in background/closed
      await self.registration.showNotification("💊 " + med.name, {
        body:    `Time to take ${med.dosage}`,
        icon:    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%237c6af7'/%3E%3Ctext x='32' y='42' text-anchor='middle' font-size='32'%3E💊%3C/text%3E%3C/svg%3E",
        badge:   "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%237c6af7'/%3E%3C/svg%3E",
        tag:     key,
        renotify: true,
        requireInteraction: true,
        vibrate: [200, 100, 200, 100, 200],
        data:    med,
        actions: [
          { action: "taken",  title: "✓ Taken" },
          { action: "snooze", title: "⏰ Snooze 5 min" }
        ]
      });

      // Also tell the open tab (if any) to play the alarm sound
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        client.postMessage({ type: "ALARM", med });
      }
    }
  } catch {}
}

let authToken = null;

// ── Periodic check via setInterval inside SW ─────────────────────────────
// Service workers can't use setInterval directly for long periods,
// so we use a self-posting message trick for reliable 60s intervals.
let reminderInterval = null;

self.addEventListener("activate", () => {
  if (reminderInterval) clearInterval(reminderInterval);
  reminderInterval = setInterval(() => {
    if (authToken) checkReminders();
  }, 60 * 1000);
});

// ── Background Sync fallback ──────────────────────────────────────────────
self.addEventListener("periodicsync", e => {
  if (e.tag === "check-reminders") {
    e.waitUntil(checkReminders());
  }
});

// ── Notification click ────────────────────────────────────────────────────
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      if (clients.length > 0) {
        clients[0].focus();
        clients[0].postMessage({ type: "ALARM", med: e.notification.data });
      } else {
        self.clients.openWindow("/");
      }
    })
  );
});

// ── Core reminder check ────────────────────────────────────────────────────
const _fired = new Set();

async function checkReminders() {
  if (!authToken) return;
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 10000);
    const res        = await fetch(API_BASE + "/reminders/check", {
      headers: { "Authorization": "Bearer " + authToken },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) return;

    const data = await res.json();
    const minute = new Date().toISOString().slice(0, 16);

    for (const med of (data.due || [])) {
      const key = `${med.id}-${minute}`;
      if (_fired.has(key)) continue;
      _fired.add(key);
      if (_fired.size > 200) {
        const first = _fired.values().next().value;
        _fired.delete(first);
      }

      // Show notification from service worker
      // This works even when the tab is in background/closed
      await self.registration.showNotification("💊 " + med.name, {
        body:    `Time to take ${med.dosage}`,
        icon:    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%237c6af7'/%3E%3Ctext x='32' y='42' text-anchor='middle' font-size='32'%3E💊%3C/text%3E%3C/svg%3E",
        badge:   "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%237c6af7'/%3E%3C/svg%3E",
        tag:     key,
        renotify: true,
        requireInteraction: true,
        vibrate: [200, 100, 200, 100, 200],
        data:    med,
        actions: [
          { action: "taken",  title: "✓ Taken" },
          { action: "snooze", title: "⏰ Snooze 5 min" }
        ]
      });

      // Also tell the open tab (if any) to play the alarm sound
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        client.postMessage({ type: "ALARM", med });
      }
    }
  } catch {}
}
