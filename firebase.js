// firebase.js — shared Firebase initialization
// Replace the firebaseConfig values with your project's config from:
// Firebase Console → Project Settings → Your apps → Web app → SDK setup

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getMessaging, isSupported } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

const firebaseConfig = {
  apiKey:            "AIzaSyBGVJap9DNKsulP_GZHP7lkYv9BxlKJK3o",
  authDomain:        "tri-valley-baseball-umpires.firebaseapp.com",
  projectId:         "tri-valley-baseball-umpires",
  storageBucket:     "tri-valley-baseball-umpires.firebasestorage.app",
  messagingSenderId: "1094604898891",
  appId:             "1:1094604898891:web:b0554f8098deac98d043ce"
};

export const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);

// Messaging is only supported in browsers that allow service workers
export const messaging = await isSupported().then(yes => yes ? getMessaging(app) : null);
