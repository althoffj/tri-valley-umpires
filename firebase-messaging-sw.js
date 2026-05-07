// firebase-messaging-sw.js — FCM background message handler
// This file must be at the root of the site (same origin as the app).

importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

// Must match the config in firebase.js
firebase.initializeApp({
  apiKey:            "REPLACE_WITH_API_KEY",
  authDomain:        "REPLACE_WITH_AUTH_DOMAIN",
  projectId:         "REPLACE_WITH_PROJECT_ID",
  storageBucket:     "REPLACE_WITH_STORAGE_BUCKET",
  messagingSenderId: "REPLACE_WITH_MESSAGING_SENDER_ID",
  appId:             "REPLACE_WITH_APP_ID"
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
