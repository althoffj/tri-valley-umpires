// auth.js — Firebase Authentication + session management + hamburger auth UI
import { auth, db, messaging } from "./firebase.js";
import { esc } from "./utils.js";
import { isPWAMode, isMobileDevice, isIOS, canInstall, triggerInstall } from "./pwa.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  sendEmailVerification,
  GoogleAuthProvider,
  signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getToken } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

// FCM VAPID key — get from Firebase Console → Project Settings → Cloud Messaging → Web Push certificates
const VAPID_KEY = "BL1MIZe0gFZgqyejUIykGfqeKTk6cG19mGL_T9VCkSpeht2BhX9hq_-L1XQVQrh4jZZ3wAoCz7_RgKNVIwzUM8g";

// Module-level state — populated by onAuthStateChanged
let currentUser    = null;
let currentProfile = null; // umpires/{uid} document data
let currentIsAdmin = false;
let currentAdminDoc = null; // admins/{uid} document data
let currentCoachDoc = null; // coaches/{uid} document data
let _skipAuthFetch = false; // set by login()/googleSignIn() to avoid duplicate Firestore reads

// Return a fresh NodeList of auth-gated elements each call.
// Memoizing is unsafe: onAuthStateChanged can fire before DOMContentLoaded,
// so a cached result captured at module init may contain empty NodeLists.
function getAuthEls() {
  return {
    required: document.querySelectorAll("[data-auth-required]"),
    guest:    document.querySelectorAll("[data-auth-guest]"),
    approved: document.querySelectorAll("[data-auth-approved]"),
    name:     document.querySelectorAll("[data-auth-name]"),
    admin:    document.querySelectorAll("[data-auth-admin]"),
    coach:    document.querySelectorAll("[data-auth-coach]"),
  };
}

// Resolves once the initial auth state check completes
let authReadyResolve;
let _authResolved = false;
export const authReadyPromise = new Promise(resolve => { authReadyResolve = resolve; });

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    if (_skipAuthFetch) {
      _skipAuthFetch = false;
      // profiles already populated by login() or googleSignIn()
    } else {
      try {
        const [umpireSnap, adminSnap, coachSnap] = await Promise.all([
          getDoc(doc(db, "umpires", user.uid)),
          getDoc(doc(db, "admins", user.uid)),
          getDoc(doc(db, "coaches", user.uid))
        ]);
        currentProfile  = umpireSnap.exists() ? umpireSnap.data() : null;
        currentIsAdmin  = adminSnap.exists();
        currentAdminDoc = adminSnap.exists() ? adminSnap.data() : null;
        currentCoachDoc = coachSnap.exists() ? coachSnap.data() : null;
      } catch {
        currentProfile  = null;
        currentIsAdmin  = false;
        currentCoachDoc = null;
      }
    }
  } else {
    currentUser     = null;
    currentProfile  = null;
    currentIsAdmin  = false;
    currentAdminDoc = null;
    currentCoachDoc = null;
  }
  if (!_authResolved) { _authResolved = true; authReadyResolve(); }
  applyAuthGate();
});

// ── Public API ───────────────────────────────────────────────────────────────

export function isLoggedIn()   { return currentUser !== null; }
export function isApproved()   { return (currentProfile?.approved === true && currentProfile?.active !== false) || currentIsAdmin; }
export function isAdmin()      { return currentIsAdmin; }
export function isSuperAdmin() {
  if (!currentIsAdmin) return false;
  if (currentAdminDoc?.superAdmin === true)  return true;
  if (currentAdminDoc?.superAdmin === false) return false;
  // superAdmin field absent → legacy account; empty roles = super admin
  return (currentAdminDoc?.roles || []).length === 0;
}
export function isCoach() {
  // A coach is NOT also an umpire or admin — coach is a distinct role
  if (currentIsAdmin || currentProfile?.approved === true) return false;
  return currentCoachDoc?.approved === true && currentCoachDoc?.active !== false;
}
export function getCurrentUser()    { return currentUser; }
export function getCurrentProfile() { return currentProfile; }
export function getCurrentCoachProfile() { return currentCoachDoc; }

export function getLoggedInName() {
  return currentProfile?.name || currentUser?.displayName || currentUser?.email || null;
}

// ── Login event logger (fire-and-forget, non-blocking) ────────────────────────

function _logLogin(user, method) {
  try {
    const role = currentIsAdmin ? "admin" : currentCoachDoc ? "coach" : "umpire";
    const name = currentProfile?.name || currentCoachDoc?.name || user.displayName || "";
    addDoc(collection(db, "loginHistory"), {
      uid:       user.uid,
      email:     user.email || "",
      name,
      role,
      method,          // "email" | "google"
      userAgent: navigator.userAgent,
      loginAt:   serverTimestamp(),
    }).catch(() => {}); // swallow errors — login tracking is non-critical
  } catch (_) {}
}

/**
 * Shared profile resolution for login() and googleSignIn().
 * Throws if the account is inactive/unapproved or has no profile.
 * Returns the credential on success; may redirect for new Google users.
 */
async function _resolveProfilesAfterSignIn(credential, umpireSnap, adminSnap, coachSnap, method) {
  const user = credential.user;

  if (adminSnap.exists()) {
    currentProfile  = umpireSnap.exists() ? umpireSnap.data() : null;
    currentIsAdmin  = true;
    currentAdminDoc = adminSnap.data();
    _logLogin(user, method);
    return credential;
  }

  if (umpireSnap.exists()) {
    const profile = umpireSnap.data();
    if (profile.approved === false) { _skipAuthFetch = false; await signOut(auth); throw new Error("Your account has not yet been approved. Please wait for administrator approval."); }
    if (profile.active === false)   { _skipAuthFetch = false; await signOut(auth); throw new Error("Your account has been deactivated. Please contact the league administrator."); }
    currentProfile = profile;
    _logLogin(user, method);
    return credential;
  }

  if (coachSnap.exists()) {
    const coach = coachSnap.data();
    if (coach.approved === false) { _skipAuthFetch = false; await signOut(auth); throw new Error("Your coach account is pending approval. Please wait for administrator approval."); }
    if (coach.active === false)   { _skipAuthFetch = false; await signOut(auth); throw new Error("Your coach account has been deactivated. Please contact the league administrator."); }
    currentCoachDoc = coach;
    _logLogin(user, method);
    return credential;
  }

  // No profile found
  _skipAuthFetch = false;
  if (method === "google") {
    // New Google user — redirect to registration
    window.location.href = "coach-form.html?google=1";
    return credential; // navigation is in-flight; won't reach callers
  }
  await signOut(auth);
  throw new Error("Account profile not found. Please contact the league administrator.");
}

export async function login(email, password) {
  // Set flag BEFORE the await so onAuthStateChanged (which can fire in the same
  // microtask flush when the sign-in resolves) always sees it and skips its own
  // redundant Firestore fetch.  Clear it on failure so the flag doesn't stick.
  _skipAuthFetch = true;
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const [umpireSnap, adminSnap, coachSnap] = await Promise.all([
      getDoc(doc(db, "umpires", credential.user.uid)),
      getDoc(doc(db, "admins", credential.user.uid)),
      getDoc(doc(db, "coaches", credential.user.uid))
    ]);
    return _resolveProfilesAfterSignIn(credential, umpireSnap, adminSnap, coachSnap, "email");
  } catch (err) {
    _skipAuthFetch = false;
    throw err;
  }
}

export async function logout() { await signOut(auth); }

export async function sendResetEmail(email) { await sendPasswordResetEmail(auth, email); }

export async function googleSignIn() {
  const provider = new GoogleAuthProvider();
  // Set flag BEFORE the await for the same reason as login() above.
  _skipAuthFetch = true;
  try {
    const credential = await signInWithPopup(auth, provider);
    const [umpireSnap, adminSnap, coachSnap] = await Promise.all([
      getDoc(doc(db, "umpires", credential.user.uid)),
      getDoc(doc(db, "admins", credential.user.uid)),
      getDoc(doc(db, "coaches", credential.user.uid))
    ]);
    return _resolveProfilesAfterSignIn(credential, umpireSnap, adminSnap, coachSnap, "google");
  } catch (err) {
    _skipAuthFetch = false;
    throw err;
  }
}

export async function updateProfile(fields) {
  if (!currentUser) throw new Error("Not signed in.");
  await updateDoc(doc(db, "umpires", currentUser.uid), fields);
  currentProfile = { ...currentProfile, ...fields };
}

export async function updateCoachProfile(fields) {
  if (!currentUser) throw new Error("Not signed in.");
  await updateDoc(doc(db, "coaches", currentUser.uid), fields);
  currentCoachDoc = { ...currentCoachDoc, ...fields };
}

export async function requestNotificationPermission() {
  if (!messaging) return "unsupported";
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return "denied";
    const token = await getToken(messaging, { vapidKey: VAPID_KEY });
    if (!token) return "no-token";
    await setDoc(doc(db, "notifications", currentUser.uid), { token, updatedAt: new Date().toISOString() });
    return "granted";
  } catch {
    return "error";
  }
}

// ── DOM gating ───────────────────────────────────────────────────────────────

export function applyAuthGate() {
  const loggedIn = isLoggedIn();
  const approved = isApproved();
  const name     = getLoggedInName();

  const els = getAuthEls();
  els.required.forEach(el => { el.style.display = loggedIn ? "" : "none"; });
  els.guest.forEach(el    => { el.style.display = loggedIn ? "none" : ""; });
  els.approved.forEach(el => { el.style.display = (loggedIn && approved) ? "" : "none"; });
  els.name.forEach(el     => { el.textContent   = name || ""; });
  els.admin.forEach(el    => { el.style.display = (loggedIn && isAdmin()) ? "" : "none"; });
  els.coach.forEach(el    => { el.style.display = (loggedIn && isCoach()) ? "" : "none"; });

  // Sync hamburger dropdown to new auth state
  updateDropdownState();
  // Signal nav.js (and any other listeners) that auth state has changed
  document.dispatchEvent(new CustomEvent("tvbu:authchanged"));
}

// ── Auth dropdown ─────────────────────────────────────────────────────────────

function showView(viewId) {
  ["authLoginView","authResetView","authSignedInView","authProfileView","authCoachProfileView"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === viewId ? "" : "none";
  });
}

function closeDropdown() {
  document.getElementById("authDropdown")?.classList.remove("open");
  document.getElementById("authOverlay")?.classList.remove("open");
}

async function updateNotifButton() {
  const btn = document.getElementById("hmNotifBtn");
  if (!btn) return;

  // Hide if messaging not supported or not signed in
  if (!messaging || !isLoggedIn()) {
    btn.style.display = "none";
    return;
  }

  const perm = Notification?.permission;
  if (perm === "denied") {
    btn.style.display = "";
    btn.textContent   = "Notifications Blocked";
    btn.disabled      = true;
    return;
  }

  // Check if token already saved
  try {
    const snap = await getDoc(doc(db, "notifications", currentUser.uid));
    if (snap.exists() && snap.data().token) {
      btn.style.display = "";
      btn.textContent   = "Notifications Enabled ✓";
      btn.disabled      = true;
      return;
    }
  } catch { /* ignore */ }

  btn.style.display = "";
  btn.textContent   = "Enable Notifications";
  btn.disabled      = false;
}

function updateInstallButton() {
  const installBtn = document.getElementById("hmInstallBtn");
  const iosMsg     = document.getElementById("hmIOSInstallMsg");
  if (!installBtn || !iosMsg) return;

  if (!isLoggedIn() || !canInstall()) {
    installBtn.style.display = "none";
    iosMsg.style.display     = "none";
    return;
  }

  if (isIOS()) {
    installBtn.style.display = "none";
    iosMsg.style.display     = "";
  } else {
    installBtn.style.display = "";
    iosMsg.style.display     = "none";
  }
}

function updateDropdownState() {
  const dropdown = document.getElementById("authDropdown");
  if (!dropdown) return;
  if (isLoggedIn()) {
    const nameEl = document.getElementById("authDropdownName");
    if (nameEl) nameEl.textContent = getLoggedInName() || "";
    // Only switch views if currently on a guest view (don't disrupt profile edit)
    const loginView = document.getElementById("authLoginView");
    const resetView = document.getElementById("authResetView");
    if (loginView?.style.display !== "none" || resetView?.style.display !== "none") {
      showView("authSignedInView");
    }
    // Show Admin Panel link only for admins
    const adminLink = document.getElementById("hmAdminLink");
    if (adminLink) adminLink.style.display = isAdmin() ? "" : "none";
    // Show Coach Portal link for coaches
    const coachPortalLink = document.getElementById("hmCoachPortalLink");
    if (coachPortalLink) coachPortalLink.style.display = isCoach() ? "" : "none";
    // Show My Earnings link for approved umpires and admins
    const earningsLink = document.getElementById("hmEarningsLink");
    if (earningsLink) earningsLink.style.display = (isApproved() || isAdmin()) ? "" : "none";
    // Show Calendar link for approved umpires and admins
    const calLink = document.getElementById("hmCalendarLink");
    if (calLink) calLink.style.display = (isApproved() || isAdmin()) ? "" : "none";
    // Prompt unverified users to verify their email
    const verifyBtn = document.getElementById("hmVerifyEmailBtn");
    if (verifyBtn) verifyBtn.style.display = (currentUser && !currentUser.emailVerified) ? "" : "none";
  } else {
    showView("authLoginView");
    const adminLink = document.getElementById("hmAdminLink");
    if (adminLink) adminLink.style.display = "none";
    const coachPortalLink = document.getElementById("hmCoachPortalLink");
    if (coachPortalLink) coachPortalLink.style.display = "none";
    const earningsLink = document.getElementById("hmEarningsLink");
    if (earningsLink) earningsLink.style.display = "none";
    const calLink = document.getElementById("hmCalendarLink");
    if (calLink) calLink.style.display = "none";
  }
  updateInstallButton();
  updateNotifButton();
}

function initAuthUI() {
  // Inject hamburger button into .header
  const header = document.querySelector(".header");
  if (header && !document.getElementById("hamburgerBtn")) {
    const btn = document.createElement("button");
    btn.id        = "hamburgerBtn";
    btn.className = "hamburger-btn";
    btn.setAttribute("aria-label", "Account menu");
    btn.textContent = "☰";
    header.appendChild(btn);
  }

  // Inject overlay
  if (!document.getElementById("authOverlay")) {
    const overlay = document.createElement("div");
    overlay.id        = "authOverlay";
    overlay.className = "auth-overlay";
    document.body.appendChild(overlay);
  }

  // Inject dropdown panel
  if (!document.getElementById("authDropdown")) {
    const panel = document.createElement("div");
    panel.id        = "authDropdown";
    panel.className = "auth-dropdown";
    panel.innerHTML = `
      <!-- Sign-in view -->
      <div id="authLoginView">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
          <strong style="font-size:1.05rem">Sign In</strong>
          <button class="auth-dropdown-close" id="authCloseBtn" aria-label="Close">&#x2715;</button>
        </div>
        <button type="button" id="hmGoogleBtn"
          style="width:100%;display:flex;align-items:center;justify-content:center;gap:10px;padding:11px 16px;border:1px solid #555;border-radius:8px;background:#fff;color:#222;font-size:0.95rem;font-weight:500;cursor:pointer;margin-bottom:16px">
          <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/><path fill="#FBBC05" d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.962L3.964 6.294C4.672 4.167 6.656 3.58 9 3.58z"/></svg>
          Continue with Google
        </button>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
          <hr style="flex:1;border:none;border-top:1px solid #444" />
          <span style="color:var(--light-text);font-size:0.8rem">or</span>
          <hr style="flex:1;border:none;border-top:1px solid #444" />
        </div>
        <form id="hmLoginForm" novalidate>
          <label for="hmEmail">Email</label>
          <input type="email" id="hmEmail" autocomplete="email" required />
          <label for="hmPassword">Password</label>
          <input type="password" id="hmPassword" autocomplete="current-password" required />
          <div style="margin-top:16px">
            <button type="submit" class="btn" style="width:100%">Sign In</button>
          </div>
          <p id="hmLoginMsg" class="signup-message" style="min-height:1.4em;margin-top:8px" aria-live="polite"></p>
        </form>
        <button type="button" class="btn print-btn" id="hmForgotBtn" style="width:100%;margin-top:4px;font-size:0.85rem">Forgot Password?</button>
      </div>

      <!-- Reset password view -->
      <div id="authResetView" style="display:none">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
          <strong style="font-size:1.05rem">Reset Password</strong>
          <button class="auth-dropdown-close" id="authResetCloseBtn" aria-label="Close">&#x2715;</button>
        </div>
        <form id="hmResetForm" novalidate>
          <label for="hmResetEmail">Email</label>
          <input type="email" id="hmResetEmail" autocomplete="email" required />
          <div style="margin-top:16px;display:flex;gap:8px">
            <button type="submit" class="btn" style="flex:1">Send Reset Email</button>
            <button type="button" class="btn print-btn" id="hmBackToLoginBtn">Back</button>
          </div>
          <p id="hmResetMsg" class="signup-message" style="min-height:1.4em;margin-top:8px" aria-live="polite"></p>
        </form>
      </div>

      <!-- Signed-in view -->
      <div id="authSignedInView" style="display:none">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
          <strong id="authDropdownName" style="font-size:1rem;word-break:break-word;flex:1;padding-right:8px"></strong>
          <button class="auth-dropdown-close" id="authSignedInCloseBtn" aria-label="Close">&#x2715;</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <a id="hmAdminLink" href="admin.html" class="btn print-btn" style="width:100%;display:none;text-align:center">Admin Panel</a>
          <a id="hmCoachPortalLink" href="coach-portal.html" class="btn print-btn" style="width:100%;display:none;text-align:center">Coach Portal</a>
          <a id="hmEarningsLink" href="earnings.html" class="btn print-btn" style="width:100%;display:none;text-align:center">My Earnings</a>
          <a id="hmCalendarLink" href="calendar.html" class="btn print-btn" style="width:100%;display:none;text-align:center">Calendar</a>
          <button type="button" class="btn print-btn" id="hmInstallBtn" style="width:100%;display:none">Install App</button>
          <div id="hmIOSInstallMsg" style="display:none;font-size:0.82rem;color:#ccc;padding:8px 10px;background:rgba(255,255,255,0.07);border-radius:8px;line-height:1.5;text-align:center">
            Tap <strong>Share</strong> (&#8679;) then <strong>"Add to Home Screen"</strong> to install.
          </div>
          <button type="button" class="btn print-btn" id="hmNotifBtn" style="width:100%;display:none">Enable Notifications</button>
          <button type="button" class="btn print-btn" id="hmVerifyEmailBtn" style="width:100%;display:none;border-color:#ffe066;color:#ffe066">Verify Email Address</button>
          <button type="button" class="btn print-btn" id="hmEditProfileBtn" style="width:100%">Edit Profile</button>
          <button type="button" class="btn print-btn" id="hmLogoutBtn" style="width:100%">Sign Out</button>
        </div>
      </div>

      <!-- Profile edit view -->
      <div id="authProfileView" style="display:none">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
          <strong style="font-size:1.05rem">Edit Profile</strong>
          <button class="auth-dropdown-close" id="authProfileBackBtn" aria-label="Back">&#x2715;</button>
        </div>
        <form id="hmProfileForm" novalidate>
          <label for="profileName">Name</label>
          <input type="text" id="profileName" autocomplete="name" />
          <label for="profilePhone">Phone</label>
          <input type="tel" id="profilePhone" autocomplete="tel" placeholder="(605) 555-1234" />
          <label for="profileEmailDisplay">Email (read-only)</label>
          <input type="email" id="profileEmailDisplay" readonly style="opacity:0.55;cursor:not-allowed" />
          <label for="profileStreet">Street Address</label>
          <input type="text" id="profileStreet" autocomplete="address-line1" />
          <div style="display:flex;gap:8px;margin-top:8px">
            <div style="flex:1">
              <label for="profileCity" style="margin-top:0">City</label>
              <input type="text" id="profileCity" autocomplete="address-level2" />
            </div>
            <div style="width:52px">
              <label for="profileStateInput" style="margin-top:0">State</label>
              <input type="text" id="profileStateInput" maxlength="2" autocomplete="address-level1"
                style="text-transform:uppercase;width:100%" />
            </div>
            <div style="width:72px">
              <label for="profileZip" style="margin-top:0">ZIP</label>
              <input type="text" id="profileZip" maxlength="10" autocomplete="postal-code"
                style="width:100%" />
            </div>
          </div>
          <div style="margin-top:14px">
            <label for="profileMaxGames" style="margin-bottom:4px">Max games per week <span style="color:var(--light-text);font-weight:normal">(optional)</span></label>
            <input type="number" id="profileMaxGames" min="0" max="14" step="1" placeholder="e.g. 3"
              style="width:80px;padding:8px 10px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px" />
          </div>

          <div style="margin-top:14px">
            <label style="margin-bottom:6px">Equipment <span style="color:var(--light-text);font-weight:normal">(check all you own)</span></label>
            <div id="profileEquipment" style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:0.9rem">
              <label style="font-weight:normal;display:flex;align-items:center;gap:6px"><input type="checkbox" value="Chest Protector" /> Chest Protector</label>
              <label style="font-weight:normal;display:flex;align-items:center;gap:6px"><input type="checkbox" value="Mask" /> Mask</label>
              <label style="font-weight:normal;display:flex;align-items:center;gap:6px"><input type="checkbox" value="Ball Bag" /> Ball Bag</label>
              <label style="font-weight:normal;display:flex;align-items:center;gap:6px"><input type="checkbox" value="Plate Shoes" /> Plate Shoes</label>
              <label style="font-weight:normal;display:flex;align-items:center;gap:6px"><input type="checkbox" value="Base Shoes" /> Base Shoes</label>
              <label style="font-weight:normal;display:flex;align-items:center;gap:6px"><input type="checkbox" value="Shin Guards" /> Shin Guards</label>
            </div>
          </div>

          <div style="margin-top:14px">
            <label for="profileCertifications">Certifications <span style="color:var(--light-text);font-weight:normal">(optional)</span></label>
            <input type="text" id="profileCertifications" placeholder="e.g. NFHS Level 1, BPF Certified"
              style="width:100%;padding:8px 10px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px;font-size:0.9rem;box-sizing:border-box" />
          </div>

          <div style="margin-top:14px">
            <label for="profileNotes">Notes for admin <span style="color:var(--light-text);font-weight:normal">(optional)</span></label>
            <textarea id="profileNotes" rows="2" placeholder="e.g. Prefer weeknight games, available all summer…"
              style="width:100%;padding:8px 10px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px;font-size:0.9rem;box-sizing:border-box;resize:vertical;font-family:inherit"></textarea>
          </div>

          <div style="margin-top:18px;padding-top:14px;border-top:1px solid #444">
            <div style="font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--light-text);margin-bottom:10px">Emergency Contact</div>
            <div style="display:flex;gap:8px">
              <div style="flex:2">
                <label for="profileEmergencyName" style="margin-top:0">Name <span style="color:var(--light-text);font-weight:normal">(optional)</span></label>
                <input type="text" id="profileEmergencyName" placeholder="e.g. Jane Smith"
                  style="width:100%;padding:8px 10px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px;font-size:0.9rem;box-sizing:border-box" />
              </div>
              <div style="flex:1.4">
                <label for="profileEmergencyPhone" style="margin-top:0">Phone <span style="color:var(--light-text);font-weight:normal">(optional)</span></label>
                <input type="tel" id="profileEmergencyPhone" placeholder="(605) 555-1234"
                  style="width:100%;padding:8px 10px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px;font-size:0.9rem;box-sizing:border-box" />
              </div>
            </div>
          </div>

          <div style="margin-top:14px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <div style="font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--light-text)">Parent / Guardian <span style="color:var(--light-text);font-weight:normal;text-transform:none;letter-spacing:0">(if under 18)</span></div>
              <button type="button" id="profileAddParentBtn"
                style="font-size:0.78rem;padding:3px 10px;background:transparent;color:#7ec8f7;border:1px solid #7ec8f7;border-radius:5px;cursor:pointer">+ Add</button>
            </div>
            <div id="profileParentsContainer"></div>
          </div>

          <div style="margin-top:16px">
            <button type="submit" class="btn" style="width:100%">Save Changes</button>
          </div>
          <p id="hmProfileMsg" class="signup-message" style="min-height:1.4em;margin-top:8px" aria-live="polite"></p>
        </form>
      </div>

      <!-- Coach profile edit view -->
      <div id="authCoachProfileView" style="display:none">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
          <strong style="font-size:1.05rem">Edit Profile</strong>
          <button class="auth-dropdown-close" id="authCoachProfileBackBtn" aria-label="Back">&#x2715;</button>
        </div>
        <form id="hmCoachProfileForm" novalidate>
          <label for="coachProfileName">Name</label>
          <input type="text" id="coachProfileName" autocomplete="name" />
          <label for="coachProfilePhone">Phone</label>
          <input type="tel" id="coachProfilePhone" autocomplete="tel" placeholder="(605) 555-1234" />
          <label for="coachProfileEmailDisplay">Email (read-only)</label>
          <input type="email" id="coachProfileEmailDisplay" readonly style="opacity:0.55;cursor:not-allowed" />
          <label for="coachProfileTeamName">Team Name</label>
          <input type="text" id="coachProfileTeamName" placeholder="e.g. Crooks 10U Red" />
          <label for="coachProfileDivision">Division</label>
          <input type="text" id="coachProfileDivision" placeholder="e.g. 10U" />
          <label for="coachProfileCity">City</label>
          <input type="text" id="coachProfileCity" placeholder="e.g. Crooks" />
          <div style="margin-top:16px">
            <button type="submit" class="btn" style="width:100%">Save Changes</button>
          </div>
          <p id="hmCoachProfileMsg" class="signup-message" style="min-height:1.4em;margin-top:8px" aria-live="polite"></p>
        </form>
      </div>`;
    document.body.appendChild(panel);
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  document.getElementById("hamburgerBtn")?.addEventListener("click", () => {
    document.getElementById("authDropdown").classList.add("open");
    document.getElementById("authOverlay").classList.add("open");
  });
  document.getElementById("authOverlay")?.addEventListener("click", closeDropdown);

  // All close/back buttons
  ["authCloseBtn","authResetCloseBtn","authSignedInCloseBtn"].forEach(id => {
    document.getElementById(id)?.addEventListener("click", closeDropdown);
  });
  document.getElementById("authProfileBackBtn")?.addEventListener("click", () => showView("authSignedInView"));
  document.getElementById("authCoachProfileBackBtn")?.addEventListener("click", () => showView("authSignedInView"));

  document.getElementById("hmForgotBtn")?.addEventListener("click", () => {
    document.getElementById("hmResetMsg").textContent = "";
    showView("authResetView");
  });
  document.getElementById("hmBackToLoginBtn")?.addEventListener("click", () => {
    document.getElementById("hmLoginMsg").textContent = "";
    showView("authLoginView");
  });

  // Google sign-in button
  document.getElementById("hmGoogleBtn")?.addEventListener("click", async () => {
    const msg = document.getElementById("hmLoginMsg");
    const btn = document.getElementById("hmGoogleBtn");
    btn.disabled    = true;
    msg.textContent = "Signing in with Google…";
    msg.className   = "signup-message info";
    try {
      await googleSignIn();
      msg.textContent = "";
      closeDropdown();
    } catch (err) {
      msg.textContent = err.message;
      msg.className   = "signup-message error";
      btn.disabled    = false;
    }
  });

  // Sign-in form
  document.getElementById("hmLoginForm")?.addEventListener("submit", async function(e) {
    e.preventDefault();
    const email    = document.getElementById("hmEmail").value.trim();
    const password = document.getElementById("hmPassword").value;
    const msg = document.getElementById("hmLoginMsg");
    const btn = this.querySelector("button[type=submit]");
    btn.disabled    = true;
    msg.textContent = "Signing in…";
    msg.className   = "signup-message info";
    try {
      await login(email, password);
      msg.textContent = "";
      this.reset();
      closeDropdown();
    } catch (err) {
      msg.textContent = err.message;
      msg.className   = "signup-message error";
    } finally {
      btn.disabled = false;
    }
  });

  // Reset form
  document.getElementById("hmResetForm")?.addEventListener("submit", async function(e) {
    e.preventDefault();
    const email = document.getElementById("hmResetEmail").value.trim();
    const msg = document.getElementById("hmResetMsg");
    const btn = this.querySelector("button[type=submit]");
    btn.disabled    = true;
    msg.textContent = "Sending…";
    msg.className   = "signup-message info";
    try {
      await sendResetEmail(email);
      msg.textContent = "Reset email sent! Check your inbox.";
      msg.className   = "signup-message success";
      this.reset();
    } catch {
      msg.textContent = "Failed to send reset email. Please try again.";
      msg.className   = "signup-message error";
    } finally {
      btn.disabled = false;
    }
  });

  // Enable Notifications button
  document.getElementById("hmNotifBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("hmNotifBtn");
    btn.disabled    = true;
    btn.textContent = "Requesting…";
    const result = await requestNotificationPermission();
    if (result === "granted") {
      btn.textContent = "Notifications Enabled ✓";
    } else if (result === "denied") {
      btn.textContent = "Notifications Blocked";
    } else {
      btn.textContent = "Enable Notifications";
      btn.disabled    = false;
    }
  });

  // Verify email button
  document.getElementById("hmVerifyEmailBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("hmVerifyEmailBtn");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      await sendEmailVerification(currentUser);
      btn.textContent = "Verification email sent ✓";
    } catch (err) {
      btn.textContent = err.code === "auth/too-many-requests"
        ? "Too many requests — try again later"
        : "Failed to send — try again";
      btn.disabled = false;
      setTimeout(() => { btn.textContent = orig; }, 4000);
    }
  });

  // Install App button (Android/Chrome)
  document.getElementById("hmInstallBtn")?.addEventListener("click", async () => {
    const accepted = await triggerInstall();
    if (accepted) updateInstallButton();
  });

  // Re-evaluate install button visibility when prompt becomes available or fires
  window.addEventListener("pwa-install-available", updateInstallButton);
  window.addEventListener("pwa-installed", updateInstallButton);

  // Sign out
  document.getElementById("hmLogoutBtn")?.addEventListener("click", async () => {
    await logout();
    closeDropdown();
  });

  // Open profile edit
  document.getElementById("hmEditProfileBtn")?.addEventListener("click", () => {
    const user = getCurrentUser();

    // Coach profile edit branch
    if (isCoach()) {
      const coach = getCurrentCoachProfile();
      if (!coach) return;
      document.getElementById("coachProfileName").value         = coach.name     || "";
      document.getElementById("coachProfilePhone").value        = coach.phone    || "";
      document.getElementById("coachProfileEmailDisplay").value = user?.email    || "";
      document.getElementById("coachProfileTeamName").value     = coach.teamName || "";
      document.getElementById("coachProfileDivision").value     = coach.division || "";
      document.getElementById("coachProfileCity").value         = coach.city     || "";
      document.getElementById("hmCoachProfileMsg").textContent  = "";
      showView("authCoachProfileView");
      return;
    }

    const profile = getCurrentProfile();
    if (!profile) return;
    document.getElementById("profileName").value        = profile.name || "";
    document.getElementById("profilePhone").value       = profile.phone || "";
    document.getElementById("profileEmailDisplay").value = user?.email || "";
    document.getElementById("profileStreet").value      = profile.street || "";
    document.getElementById("profileCity").value        = profile.city || "";
    document.getElementById("profileStateInput").value  = profile.state || "";
    document.getElementById("profileZip").value         = profile.zip || "";
    document.getElementById("profileMaxGames").value       = profile.maxGamesPerWeek != null ? profile.maxGamesPerWeek : "";
    document.getElementById("profileCertifications").value  = (profile.certifications || []).join(", ");
    document.getElementById("profileNotes").value           = profile.notes || "";
    const parents = normalizeParents(profile);
    renderProfileParents(parents);
    // Emergency contact: prefer first parent, fall back to saved emergency contact
    const firstParent = parents[0];
    document.getElementById("profileEmergencyName").value  = firstParent?.name  || profile.emergencyContactName  || "";
    document.getElementById("profileEmergencyPhone").value = firstParent?.phone || profile.emergencyContactPhone || "";
    // Populate equipment checkboxes
    const owned = new Set(profile.equipment || []);
    document.querySelectorAll("#profileEquipment input[type=checkbox]").forEach(cb => {
      cb.checked = owned.has(cb.value);
    });
    document.getElementById("hmProfileMsg").textContent = "";
    showView("authProfileView");
  });

  // ── Parent / Guardian dynamic list ─────────────────────────────────────────
  const INPUT_STYLE = "width:100%;padding:7px 9px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px;font-size:0.88rem;box-sizing:border-box";

  function normalizeParents(profile) {
    if (Array.isArray(profile.parents) && profile.parents.length) return profile.parents;
    if (profile.parentName) return [{ name: profile.parentName, email: profile.parentEmail || "", phone: profile.parentPhone || "" }];
    return [];
  }

  function makeProfileParentRow(p = {}) {
    const row = document.createElement("div");
    row.className = "profile-parent-row";
    row.style.cssText = "display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:6px;margin-bottom:8px;align-items:center";
    row.innerHTML = `
      <input type="text"  class="ppr-name"  placeholder="Name"            value="${esc(p.name  || "")}" style="${INPUT_STYLE}" />
      <input type="tel"   class="ppr-phone" placeholder="Phone"           value="${esc(p.phone || "")}" style="${INPUT_STYLE}" />
      <input type="email" class="ppr-email" placeholder="Email (optional)" value="${esc(p.email || "")}" style="${INPUT_STYLE}" />
      <button type="button" class="ppr-remove" title="Remove parent"
        style="padding:4px 8px;background:transparent;color:#ff8a8a;border:1px solid #884444;border-radius:5px;cursor:pointer;font-size:1rem;line-height:1;flex-shrink:0">×</button>`;
    return row;
  }

  function renderProfileParents(parents) {
    const c = document.getElementById("profileParentsContainer");
    if (!c) return;
    c.innerHTML = "";
    (parents.length ? parents : [{}]).forEach(p => c.appendChild(makeProfileParentRow(p)));
    updateRemoveBtns();
  }

  function updateRemoveBtns() {
    const rows = document.querySelectorAll("#profileParentsContainer .profile-parent-row");
    rows.forEach(row => {
      row.querySelector(".ppr-remove").style.visibility = rows.length > 1 ? "" : "hidden";
    });
  }

  function syncFirstParentToEmergency() {
    const first = document.querySelector("#profileParentsContainer .profile-parent-row");
    if (!first) return;
    const name  = first.querySelector(".ppr-name").value.trim();
    const phone = first.querySelector(".ppr-phone").value.trim();
    if (!name) return;
    const eName  = document.getElementById("profileEmergencyName");
    const ePhone = document.getElementById("profileEmergencyPhone");
    if (eName)  eName.value  = name;
    if (ePhone) ePhone.value = phone;
  }

  function collectProfileParents() {
    return [...document.querySelectorAll("#profileParentsContainer .profile-parent-row")]
      .map(row => ({
        name:  row.querySelector(".ppr-name").value.trim(),
        phone: row.querySelector(".ppr-phone").value.trim(),
        email: row.querySelector(".ppr-email").value.trim(),
      }))
      .filter(p => p.name || p.phone);
  }

  document.getElementById("profileParentsContainer")?.addEventListener("input", e => {
    if (e.target.matches(".ppr-name, .ppr-phone")) syncFirstParentToEmergency();
  });
  document.getElementById("profileParentsContainer")?.addEventListener("click", e => {
    if (!e.target.matches(".ppr-remove")) return;
    const rows = document.querySelectorAll("#profileParentsContainer .profile-parent-row");
    if (rows.length > 1) {
      e.target.closest(".profile-parent-row").remove();
      updateRemoveBtns();
      syncFirstParentToEmergency();
    }
  });
  document.getElementById("profileAddParentBtn")?.addEventListener("click", () => {
    document.getElementById("profileParentsContainer").appendChild(makeProfileParentRow());
    updateRemoveBtns();
  });

  // Save profile
  document.getElementById("hmProfileForm")?.addEventListener("submit", async function(e) {
    e.preventDefault();
    const msg = document.getElementById("hmProfileMsg");
    const btn = this.querySelector("button[type=submit]");
    btn.disabled    = true;
    msg.textContent = "Saving…";
    msg.className   = "signup-message info";
    try {
      const maxVal = document.getElementById("profileMaxGames").value.trim();
      const equipment = [...document.querySelectorAll("#profileEquipment input[type=checkbox]")]
        .filter(cb => cb.checked).map(cb => cb.value);
      const certsRaw = document.getElementById("profileCertifications").value.trim();
      const certifications = certsRaw
        ? certsRaw.split(",").map(s => s.trim()).filter(Boolean)
        : [];
      const savedParents = collectProfileParents();
      const firstParent  = savedParents[0] || null;
      const fields = {
        name:            document.getElementById("profileName").value.trim(),
        phone:           document.getElementById("profilePhone").value.trim(),
        street:          document.getElementById("profileStreet").value.trim(),
        city:            document.getElementById("profileCity").value.trim(),
        state:           document.getElementById("profileStateInput").value.trim().toUpperCase(),
        zip:             document.getElementById("profileZip").value.trim(),
        maxGamesPerWeek: maxVal !== "" ? parseInt(maxVal, 10) : null,
        equipment,
        certifications,
        notes:           document.getElementById("profileNotes").value.trim(),
        parents:         savedParents,
        // Backward-compat flat fields = first parent (or empty)
        parentName:      firstParent?.name  || "",
        parentPhone:     firstParent?.phone || "",
        parentEmail:     firstParent?.email || "",
        // First parent is always the emergency contact if any parent is set
        emergencyContactName:  firstParent?.name
                               || document.getElementById("profileEmergencyName").value.trim(),
        emergencyContactPhone: firstParent?.phone
                               || document.getElementById("profileEmergencyPhone").value.trim(),
      };
      await updateProfile(fields);
      msg.textContent = "Profile updated!";
      msg.className   = "signup-message success";
      document.querySelectorAll("[data-auth-name]").forEach(el => el.textContent = fields.name);
      document.getElementById("authDropdownName").textContent = fields.name;
      setTimeout(() => showView("authSignedInView"), 1000);
    } catch (err) {
      msg.textContent = err.message;
      msg.className   = "signup-message error";
    } finally {
      btn.disabled = false;
    }
  });

  // Save coach profile
  document.getElementById("hmCoachProfileForm")?.addEventListener("submit", async function(e) {
    e.preventDefault();
    const msg = document.getElementById("hmCoachProfileMsg");
    const btn = this.querySelector("button[type=submit]");
    btn.disabled    = true;
    msg.textContent = "Saving…";
    msg.className   = "signup-message info";
    try {
      const fields = {
        name:     document.getElementById("coachProfileName").value.trim(),
        phone:    document.getElementById("coachProfilePhone").value.trim(),
        teamName: document.getElementById("coachProfileTeamName").value.trim(),
        division: document.getElementById("coachProfileDivision").value.trim(),
        city:     document.getElementById("coachProfileCity").value.trim(),
      };
      await updateCoachProfile(fields);
      msg.textContent = "Profile updated!";
      msg.className   = "signup-message success";
      document.querySelectorAll("[data-auth-name]").forEach(el => el.textContent = fields.name);
      document.getElementById("authDropdownName").textContent = fields.name;
      setTimeout(() => showView("authSignedInView"), 1000);
    } catch (err) {
      msg.textContent = err.message;
      msg.className   = "signup-message error";
    } finally {
      btn.disabled = false;
    }
  });

  // Set initial dropdown state once auth settles
  authReadyPromise.then(updateDropdownState);
}

// Run on page load
document.addEventListener("DOMContentLoaded", () => {
  applyAuthGate();
  initAuthUI();
});
