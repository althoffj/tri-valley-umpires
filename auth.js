// auth.js — Firebase Authentication + session management
import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Module-level state — populated by onAuthStateChanged
let currentUser    = null;
let currentProfile = null; // umpires/{uid} document data
let currentIsAdmin = false;
let authReady      = false;

// Resolves once the initial auth state check completes (used by other pages
// to await auth before deciding whether to redirect)
let authReadyResolve;
export const authReadyPromise = new Promise(resolve => { authReadyResolve = resolve; });

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    try {
      const [umpireSnap, adminSnap] = await Promise.all([
        getDoc(doc(db, "umpires", user.uid)),
        getDoc(doc(db, "admins", user.uid))
      ]);
      currentProfile = umpireSnap.exists() ? umpireSnap.data() : null;
      currentIsAdmin = adminSnap.exists();
    } catch (e) {
      currentProfile = null;
      currentIsAdmin = false;
    }
  } else {
    currentUser    = null;
    currentProfile = null;
    currentIsAdmin = false;
  }
  authReady = true;
  authReadyResolve();
  applyAuthGate();
});

// ── Public API ───────────────────────────────────────────────────────────────

export function isLoggedIn() {
  return currentUser !== null;
}

export function isApproved() {
  return currentProfile && currentProfile.approved === true;
}

export function isAdmin() {
  return currentIsAdmin;
}

export function getLoggedInName() {
  if (currentProfile?.name) return currentProfile.name;
  if (currentUser?.displayName) return currentUser.displayName;
  if (currentUser?.email) return currentUser.email;
  return null;
}

export function getCurrentUser() {
  return currentUser;
}

export function getCurrentProfile() {
  return currentProfile;
}

export async function login(email, password) {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const snap = await getDoc(doc(db, "umpires", credential.user.uid));

  if (!snap.exists()) {
    await signOut(auth);
    throw new Error("Account profile not found. Please contact the league administrator.");
  }

  const profile = snap.data();
  if (profile.approved === false) {
    await signOut(auth);
    throw new Error("Your account has not yet been approved by an administrator. Please wait for approval before signing in.");
  }

  currentProfile = profile;
  return credential;
}

export async function logout() {
  await signOut(auth);
}

export async function sendResetEmail(email) {
  await sendPasswordResetEmail(auth, email);
}

export async function checkIsAdmin(uid) {
  const snap = await getDoc(doc(db, "admins", uid));
  return snap.exists();
}

// ── DOM gating ───────────────────────────────────────────────────────────────

export function applyAuthGate() {
  const loggedIn = isLoggedIn();
  const name     = getLoggedInName();

  document.querySelectorAll("[data-auth-required]").forEach(el => {
    el.style.display = loggedIn ? "" : "none";
  });

  document.querySelectorAll("[data-auth-guest]").forEach(el => {
    el.style.display = loggedIn ? "none" : "";
  });

  document.querySelectorAll("[data-auth-name]").forEach(el => {
    el.textContent = name || "";
  });

  // Show admin nav link only for admins
  document.querySelectorAll("[data-auth-admin]").forEach(el => {
    el.style.display = (loggedIn && isAdmin()) ? "" : "none";
  });
}

// Run on every page load to set initial state before auth resolves
document.addEventListener("DOMContentLoaded", applyAuthGate);
