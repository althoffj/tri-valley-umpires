// firebase-messaging-sw.js — FCM background message handler + app shell cache
// This file must be at the root of the site (same origin as the app).

importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

// ── App Shell Caching ─────────────────────────────────────────────────────────
// Bump CACHE_NAME whenever you want to force all clients to drop the old cache.
const CACHE_NAME = "tvu-shell-v5";

// Only truly-static, never-versioned assets go here.
// JS/CSS files are referenced with ?v=N query strings in HTML, so they never
// hit the unversioned cached path — no benefit caching them here, and it
// actively causes stale-content bugs when they are cached.
const OFFLINE_ASSETS = [
  "/",
  "/index.html",
  "/logo.png",
  "/manifest.json",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(OFFLINE_ASSETS))
  );
  // Take control immediately — don't wait for existing tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  // Delete every cache except the current one.
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  // Claim all open clients so this SW controls them without a reload.
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only intercept same-origin requests.
  if (url.origin !== self.location.origin) return;

  // ── Navigation (HTML pages) — network-first ────────────────────────────────
  // Always try the network so the user gets the latest HTML.
  // On failure (offline), fall back to the cached index.html shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Cache the fresh page for offline fallback.
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
          return response;
        })
        .catch(() =>
          caches.match(request).then(r => r || caches.match("/index.html"))
        )
    );
    return;
  }

  // ── Versioned JS/CSS (?v=) — network-first, no caching ────────────────────
  // These change on every deploy; never serve them from cache.
  if (url.search.includes("v=")) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  // ── Static offline assets (logo, manifest) — cache-first ──────────────────
  if (OFFLINE_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request))
    );
    return;
  }

  // All other same-origin requests: network-first, cache as fallback.
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

// ── Notify open tabs when this SW becomes active ───────────────────────────
// pwa.js listens for this message and reloads the page.
self.addEventListener("activate", () => {
  self.clients.matchAll({ type: "window" }).then(clients => {
    clients.forEach(client => client.postMessage({ type: "SW_ACTIVATED" }));
  });
});

// ── FCM ────────────────────────────────────────────────────────────────────
// Must match the config in firebase.js
firebase.initializeApp({
  apiKey:            "AIzaSyBGVJap9DNKsulP_GZHP7lkYv9BxlKJK3o",
  authDomain:        "tri-valley-baseball-umpires.firebaseapp.com",
  projectId:         "tri-valley-baseball-umpires",
  storageBucket:     "tri-valley-baseball-umpires.firebasestorage.app",
  messagingSenderId: "1094604898891",
  appId:             "1:1094604898891:web:b0554f8098deac98d043ce"
});

const messaging = firebase.messaging();

// Show notification when app is in background.
messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification ?? {};
  self.registration.showNotification(title || "Tri-Valley Umpires", {
    body: body || "",
    icon: "/logo.png"
  });
});
