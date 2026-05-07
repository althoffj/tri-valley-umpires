// firebase.js — shared Firebase initialization
// Replace the firebaseConfig values with your project's config from:
// Firebase Console → Project Settings → Your apps → Web app → SDK setup

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getMessaging, isSupported } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

const firebaseConfig = {
  apiKey:            "REPLACE_WITH_API_KEY",
  authDomain:        "REPLACE_WITH_AUTH_DOMAIN",
  projectId:         "REPLACE_WITH_PROJECT_ID",
  storageBucket:     "REPLACE_WITH_STORAGE_BUCKET",
  messagingSenderId: "REPLACE_WITH_MESSAGING_SENDER_ID",
  appId:             "REPLACE_WITH_APP_ID"
};

const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);

// Messaging is only supported in browsers that allow service workers
export const messaging = await isSupported().then(yes => yes ? getMessaging(app) : null);
