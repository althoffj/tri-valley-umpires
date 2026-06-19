// form.js — Acknowledgment form: Firebase account creation + Firestore profile
import { auth, db } from "./firebase.js";
import { authReadyPromise, isApproved, isAdmin, isCoach, isLoggedIn } from "./auth.js";
import { getOrgSettings } from "./org.js";
import { esc, formatPhoneInput } from "./utils.js";

// Redirect already-authenticated users to their appropriate portal.
// Skip this check for the Google sign-in flow (?google=1) — in that case the
// user is authenticated but has no umpire profile yet and must complete the form.
authReadyPromise.then(() => {
  if (new URLSearchParams(window.location.search).has("google")) return;
  if (isAdmin())    { window.location.href = "admin.html";        return; }
  if (isApproved()) { window.location.href = "schedule.html";     return; }
  if (isCoach())    { window.location.href = "coach-portal.html"; return; }
  if (isLoggedIn()) { window.location.href = "index.html";        return; } // pending approval
});

import {
  createUserWithEmailAndPassword,
  updateProfile,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  setDoc,
  getDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Registration gate + disclaimer ────────────────────────────────────────────
getOrgSettings().then(s => {
  // Disclaimer text
  const disclaimerEl = document.getElementById("registrationDisclaimerNote");
  if (disclaimerEl && s.registrationDisclaimer) {
    disclaimerEl.textContent = s.registrationDisclaimer;
  }

  // Registration open/closed
  if (s.registrationOpen === false) {
    const form    = document.getElementById("umpireForm");
    const msg     = s.registrationClosedMessage || "Umpire registration is currently closed.";
    const notice  = document.createElement("div");
    notice.className = "document-note";
    notice.style.borderLeftColor = "#ffcc80";
    notice.innerHTML = `<p style="margin:0"><strong>Registration Closed</strong><br />${esc(msg)}</p>`;
    if (form) {
      form.style.display = "none";
      form.parentNode.insertBefore(notice, form);
    }
  }
});

// ── Google Sign-In mode ───────────────────────────────────────────────────────
// When arriving from googleSignIn() redirect (form.html?google=1), the user is
// already authenticated via Google. Pre-fill their info, hide the password
// field, and skip createUserWithEmailAndPassword on submit.

let googleUser = null;

if (new URLSearchParams(window.location.search).has("google")) {
  const unsub = onAuthStateChanged(auth, user => {
    unsub(); // one-shot
    if (!user) { window.location.href = "index.html"; return; }
    googleUser = user;

    // Pre-fill name from Google display name
    const parts     = (user.displayName || "").trim().split(/\s+/);
    const firstName = parts[0] || "";
    const lastName  = parts.slice(1).join(" ");
    const fnEl = document.getElementById("firstName");
    const lnEl = document.getElementById("lastName");
    if (fnEl) { fnEl.value = firstName; }
    if (lnEl) { lnEl.value = lastName;  }

    // Lock email (already belongs to the Google account)
    const emailEl = document.getElementById("email");
    if (emailEl) {
      emailEl.value    = user.email || "";
      emailEl.readOnly = true;
      emailEl.style.cssText += ";opacity:0.6;cursor:not-allowed";
    }

    // Hide password field (Google account already exists)
    ["label[for='password']", "#password", "#passwordError"].forEach(sel => {
      const el = document.querySelector(sel);
      if (el) el.style.display = "none";
    });

    // Inject banner above the form fields
    const banner = document.createElement("div");
    banner.className = "document-note";
    banner.style.borderLeftColor = "#4285F4";
    banner.innerHTML = `<p style="margin:0">
      <strong>Continuing with Google</strong> — signed in as
      <strong>${user.email}</strong>. Complete this form to register as an umpire.
      Your account will be active immediately after you complete this form.
    </p>`;
    const form = document.getElementById("umpireForm");
    if (form) form.prepend(banner);
  });
}

// ── Load team checkboxes ─────────────────────────────────────────────────────

(async function loadTeams() {
  const container = document.getElementById("teamCheckboxes");
  try {
    const snap = await getDoc(doc(db, "config", "teamCalendars"));
    const teams = snap.exists() ? (snap.data().teams || []) : [];
    if (teams.length === 0) {
      container.innerHTML = `<span style="color:var(--light-text);font-size:0.9rem">No teams configured yet.</span>`;
      return;
    }
    container.innerHTML = teams.map((t, i) => `
      <label style="font-weight:normal;display:flex;align-items:center;gap:6px;margin:0">
        <input type="checkbox" name="teamAffiliation" value="${esc(t.name)}" />
        ${esc(t.name)}
      </label>`).join("");
  } catch (_) {
    container.innerHTML = `<span style="color:var(--light-text);font-size:0.9rem">Could not load teams.</span>`;
  }
})();

// ── Validation helpers ───────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ZIP_RE   = /^\d{5}(-\d{4})?$/;

function showError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg;
}

function clearError(id) {
  showError(id, "");
}

function validateForm(data) {
  let valid = true;

  if (!data.firstName.trim()) { showError("firstNameError", "First name is required."); valid = false; } else clearError("firstNameError");
  if (!data.lastName.trim())  { showError("lastNameError",  "Last name is required.");  valid = false; } else clearError("lastNameError");

  if (!data.email) {
    showError("emailError", "Email is required."); valid = false;
  } else if (!EMAIL_RE.test(data.email)) {
    showError("emailError", "Please enter a valid email address."); valid = false;
  } else clearError("emailError");

  const rawPhone = data.phone.replace(/\D/g, "");
  if (!rawPhone) {
    showError("phoneError", "Phone number is required."); valid = false;
  } else if (rawPhone.length !== 10) {
    showError("phoneError", "Please enter a 10-digit phone number."); valid = false;
  } else clearError("phoneError");

  if (!data.street.trim()) { showError("streetError", "Street address is required."); valid = false; } else clearError("streetError");
  if (!data.city.trim())   { showError("cityError",   "City is required.");           valid = false; } else clearError("cityError");
  if (!data.state)         { showError("stateError",  "State is required.");          valid = false; } else clearError("stateError");

  if (!data.zip) {
    showError("zipError", "ZIP code is required."); valid = false;
  } else if (!ZIP_RE.test(data.zip)) {
    showError("zipError", "Enter a valid ZIP code (e.g. 57001)."); valid = false;
  } else clearError("zipError");

  if (!googleUser && data.password.length < 6) {
    showError("passwordError", "Password must be at least 6 characters."); valid = false;
  } else clearError("passwordError");

  if (!data.signature.trim()) {
    showError("signatureError", "Electronic signature is required."); valid = false;
  } else clearError("signatureError");

  // Validate each parent's email (optional field, but must be valid if filled)
  let parentEmailValid = true;
  document.querySelectorAll("#parentsContainer .form-parent-row").forEach(row => {
    const emailEl = row.querySelector(".fpr-email");
    const errEl   = row.querySelector(".fpr-email-error");
    if (emailEl.value && !EMAIL_RE.test(emailEl.value)) {
      errEl.textContent = "Please enter a valid email address.";
      parentEmailValid = false;
    } else {
      errEl.textContent = "";
    }
  });
  if (!parentEmailValid) valid = false;

  return valid;
}

// ── Dynamic parent row helpers ────────────────────────────────────────────────

function makeParentRow(p = {}) {
  const row = document.createElement("div");
  row.className = "form-parent-row";
  row.style.cssText = "display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;margin-bottom:10px;align-items:start";
  row.innerHTML = `
    <div>
      <input type="text"  class="fpr-name"  placeholder="Name"             value="${(p.name  || "").replace(/"/g,'&quot;')}" autocomplete="name" />
    </div>
    <div>
      <input type="tel"   class="fpr-phone" placeholder="(605) 555-1234"   value="${(p.phone || "").replace(/"/g,'&quot;')}" maxlength="14" autocomplete="tel" />
    </div>
    <div>
      <input type="email" class="fpr-email" placeholder="Email (optional)"  value="${(p.email || "").replace(/"/g,'&quot;')}" autocomplete="email" />
      <p class="field-error fpr-email-error"></p>
    </div>
    <button type="button" class="fpr-remove" title="Remove"
      style="padding:6px 8px;background:transparent;color:#ff8a8a;border:1px solid #884444;border-radius:5px;cursor:pointer;font-size:1rem;line-height:1;align-self:start">×</button>`;
  // Phone formatting on the tel input
  row.querySelector(".fpr-phone").addEventListener("input", function() { formatPhoneInput(this); });
  return row;
}

function updateParentRemoveBtns() {
  const rows = document.querySelectorAll("#parentsContainer .form-parent-row");
  rows.forEach(row => {
    row.querySelector(".fpr-remove").style.visibility = rows.length > 1 ? "" : "hidden";
  });
}

function collectParents() {
  return [...document.querySelectorAll("#parentsContainer .form-parent-row")]
    .map(row => ({
      name:  row.querySelector(".fpr-name").value.trim(),
      phone: row.querySelector(".fpr-phone").value.trim(),
      email: row.querySelector(".fpr-email").value.trim().toLowerCase(),
    }))
    .filter(p => p.name || p.phone);
}

// Seed with one empty row on load
const _parentsContainer = document.getElementById("parentsContainer");
if (_parentsContainer) {
  _parentsContainer.appendChild(makeParentRow());
  updateParentRemoveBtns();
}

document.getElementById("addParentBtn")?.addEventListener("click", () => {
  document.getElementById("parentsContainer").appendChild(makeParentRow());
  updateParentRemoveBtns();
});

document.getElementById("parentsContainer")?.addEventListener("click", e => {
  if (!e.target.matches(".fpr-remove")) return;
  const rows = document.querySelectorAll("#parentsContainer .form-parent-row");
  if (rows.length > 1) {
    e.target.closest(".form-parent-row").remove();
    updateParentRemoveBtns();
  }
});

// ── Phone formatting ─────────────────────────────────────────────────────────

document.getElementById("phone").addEventListener("input", function() { formatPhoneInput(this); });

// Inline email validation on blur
document.getElementById("email").addEventListener("blur", function() {
  if (this.value && !EMAIL_RE.test(this.value)) {
    showError("emailError", "Please enter a valid email address.");
  } else {
    clearError("emailError");
  }
});

// ── Form submit ──────────────────────────────────────────────────────────────

document.getElementById("umpireForm").addEventListener("submit", async function(e) {
  e.preventDefault();

  const data = {
    firstName:   document.getElementById("firstName").value.trim(),
    lastName:    document.getElementById("lastName").value.trim(),
    email:       document.getElementById("email").value.trim().toLowerCase(),
    phone:       document.getElementById("phone").value.trim(),
    street:      document.getElementById("street").value.trim(),
    city:        document.getElementById("city").value.trim(),
    state:       document.getElementById("state").value,
    zip:         document.getElementById("zip").value.trim(),
    password:    document.getElementById("password").value,
    signature:   document.getElementById("signature").value.trim(),
  };

  if (!validateForm(data)) return;

  const fullName = `${data.firstName} ${data.lastName}`;
  const submitBtn = document.getElementById("submitBtn");
  const msgEl     = document.getElementById("formMessage");

  submitBtn.disabled  = true;
  submitBtn.textContent = "Submitting...";
  msgEl.textContent   = "";
  msgEl.className     = "signup-message";

  let userCredential = null;

  try {
    let uid;

    if (googleUser) {
      // Google path — auth account already exists; just use the existing UID
      uid = googleUser.uid;
    } else {
      // Email/password path — create the Firebase Auth account
      userCredential = await createUserWithEmailAndPassword(auth, data.email, data.password);
      await updateProfile(userCredential.user, { displayName: fullName });
      uid = userCredential.user.uid;
    }

    // Collect parents from dynamic rows
    const parents     = collectParents();
    const firstParent = parents[0] || null;

    // Write Firestore profile
    await setDoc(doc(db, "umpires", uid), {
      name:        fullName,
      firstName:   data.firstName,
      lastName:    data.lastName,
      email:       data.email,
      phone:       data.phone,
      street:      data.street,
      city:        data.city,
      state:       data.state,
      zip:         data.zip,
      signature:   data.signature,
      parents:     parents,
      parentName:  firstParent?.name  || "",
      parentEmail: firstParent?.email || "",
      parentPhone: firstParent?.phone || "",
      // If a parent/guardian is provided, they are automatically the emergency contact
      emergencyContactName:  firstParent?.name  || "",
      emergencyContactPhone: firstParent?.phone || "",
      teamsPlayed: [...document.querySelectorAll("[name='teamAffiliation']:checked")].map(cb => cb.value),
      approved:    true,
      submittedAt: serverTimestamp()
    });

    // Registration email notifications are sent server-side via the
    // onUmpireRegistered Cloud Function triggered by the Firestore write above.

  } catch (err) {
    // Roll back only for email/password path (Google account must not be deleted)
    if (!googleUser && userCredential?.user) {
      try { await userCredential.user.delete(); } catch (_) {}
    }

    let friendlyMsg = "We encountered an issue saving your acknowledgment. Please try again.";
    if (err.code === "auth/email-already-in-use") {
      friendlyMsg = "An account with that email already exists. Log in on the home page.";
    } else if (err.code === "auth/weak-password") {
      friendlyMsg = "Password must be at least 6 characters.";
    }

    msgEl.textContent = friendlyMsg;
    msgEl.className   = "signup-message error";
    submitBtn.disabled    = false;
    submitBtn.textContent = "Submit Official Acknowledgment";
    return;
  }

  msgEl.textContent = `Thank you, ${fullName}! Your acknowledgment has been recorded. Your account is now active — redirecting you to the schedule…`;
  msgEl.className   = "signup-message success";
  this.reset();
  submitBtn.disabled    = false;
  submitBtn.textContent = "Submit Official Acknowledgment";
  setTimeout(() => { window.location.href = "schedule.html"; }, 2000);
});
