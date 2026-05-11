// firebase-messaging-sw.js — FCM background message handler + app shell cache
// This file must be at the root of the site (same origin as the app).

importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

// ── App Shell Caching ─────────────────────────────────────────────────────────

const CACHE_NAME = "tvu-shell-v2";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/firebase.js",
  "/auth.js",
  "/pwa.js",
  "/logo.png",
  "/manifest.json",
  "/schedule.html",
  "/fields.html",
  "/calendar.html",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Navigation: network-first, fall back to index.html for offline
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Static shell assets: cache-first
  if (SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request))
    );
  }
});

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

// Show notification when app is in background
messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification ?? {};
  self.registration.showNotification(title || "Tri-Valley Umpires", {
    body: body || "",
    icon: "/logo.png"
  });
});
