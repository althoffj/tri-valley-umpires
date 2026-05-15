// coach-form.js — Coach registration
import { auth, db } from "./firebase.js";
import { authReadyPromise, isCoach, isAdmin, isApproved, getCurrentUser } from "./auth.js";
import { esc, setMsg, formatPhone } from "./utils.js";

import {
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

function fieldError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg;
}

function clearErrors() {
  ["cfFirstNameError","cfLastNameError","cfEmailError","cfPhoneError",
   "cfTeamNameError","cfDivisionError","cfCityError","cfPasswordError"]
    .forEach(id => fieldError(id, ""));
}

function val(id) { return (document.getElementById(id)?.value || "").trim(); }

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  // Redirect already-authenticated users to appropriate page
  if (isAdmin()) { window.location.href = "admin.html"; return; }
  if (isApproved()) { window.location.href = "schedule.html"; return; }
  if (isCoach()) { window.location.href = "coach-portal.html"; return; }

  const isGoogle = new URLSearchParams(window.location.search).has("google");

  if (isGoogle) {
    // Arriving via Google sign-in — hide password field, pre-fill email
    const passwordSection = document.getElementById("cfPasswordSection");
    if (passwordSection) passwordSection.style.display = "none";
    const passwordInput = document.getElementById("cfPassword");
    if (passwordInput) passwordInput.removeAttribute("required");

    const user = getCurrentUser();
    if (user?.email) {
      const emailInput = document.getElementById("cfEmail");
      if (emailInput) {
        emailInput.value = user.email;
        emailInput.readOnly = true;
        emailInput.style.opacity = "0.6";
      }
      // Pre-fill name from Google display name if available
      if (user.displayName) {
        const parts = user.displayName.split(" ");
        const firstInput = document.getElementById("cfFirstName");
        const lastInput  = document.getElementById("cfLastName");
        if (firstInput && !firstInput.value) firstInput.value = parts[0] || "";
        if (lastInput  && !lastInput.value)  lastInput.value  = parts.slice(1).join(" ") || "";
      }
    }
  }

  // Phone formatting
  const phoneInput = document.getElementById("cfPhone");
  phoneInput?.addEventListener("input", function() {
    const digits = this.value.replace(/\D/g, "").slice(0, 10);
    if (digits.length === 0) return;
    let formatted = digits;
    if (digits.length >= 4) formatted = `(${digits.slice(0,3)}) ${digits.slice(3)}`;
    if (digits.length >= 7) formatted = `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
    this.value = formatted;
  });

  // Form submit
  document.getElementById("coachForm")?.addEventListener("submit", async function(e) {
    e.preventDefault();
    clearErrors();

    const firstName = val("cfFirstName");
    const lastName  = val("cfLastName");
    const email     = val("cfEmail");
    const phone     = formatPhone(val("cfPhone"));
    const teamName  = val("cfTeamName");
    const division  = val("cfDivision");
    const city      = val("cfCity");
    const password  = val("cfPassword");

    let valid = true;
    if (!firstName)  { fieldError("cfFirstNameError", "First name is required."); valid = false; }
    if (!lastName)   { fieldError("cfLastNameError",  "Last name is required.");  valid = false; }
    if (!email)      { fieldError("cfEmailError",     "Email is required.");       valid = false; }
    if (!phone || phone.replace(/\D/g,"").length < 10)
                     { fieldError("cfPhoneError",     "Please enter a valid 10-digit phone number."); valid = false; }
    if (!teamName)   { fieldError("cfTeamNameError",  "Team name is required.");  valid = false; }
    if (!division)   { fieldError("cfDivisionError",  "Please select a division."); valid = false; }
    if (!city)       { fieldError("cfCityError",      "City / Program is required."); valid = false; }

    const isGoogle = new URLSearchParams(window.location.search).has("google");
    if (!isGoogle && password.length < 6) {
      fieldError("cfPasswordError", "Password must be at least 6 characters.");
      valid = false;
    }

    if (!valid) return;

    const btn = document.getElementById("cfSubmitBtn");
    btn.disabled = true;
    setMsg("Submitting registration…", "info");

    const coachData = {
      name:         `${firstName} ${lastName}`,
      email,
      phone,
      teamName,
      division,
      city,
      approved:     false,
      active:       true,
      role:         "coach",
      registeredAt: serverTimestamp()
    };

    try {
      let uid;
      if (isGoogle) {
        // Already authenticated via Google — just write the Firestore doc
        const user = getCurrentUser();
        if (!user) { setMsg("Session expired. Please sign in again.", "error"); btn.disabled = false; return; }
        uid = user.uid;
        await setDoc(doc(db, "coaches", uid), coachData);
      } else {
        // Create new Firebase Auth account
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        uid = credential.user.uid;
        await setDoc(doc(db, "coaches", uid), coachData);
      }

      setMsg("Registration submitted! You will be notified once approved.", "success");
      document.getElementById("coachForm").reset();
      document.getElementById("cfSubmitBtn").style.display = "none";
    } catch (err) {
      let msg = err.message;
      if (err.code === "auth/email-already-in-use") {
        msg = "An account with this email already exists. Please sign in instead.";
      } else if (err.code === "auth/weak-password") {
        msg = "Password is too weak. Please use at least 6 characters.";
      }
      setMsg(msg, "error");
      btn.disabled = false;
    }
  });
});
