// firebase-messaging-sw.js — FCM background message handler
// This file must be at the root of the site (same origin as the app).

importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

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
