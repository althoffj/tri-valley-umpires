// form.js — Acknowledgment form: Firebase account creation + Firestore profile
import { auth, db } from "./firebase.js";
import {
  createUserWithEmailAndPassword,
  updateProfile,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

emailjs.init("H9Z9Qz-HB-PehAQjp");

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

  if (data.password.length < 6) {
    showError("passwordError", "Password must be at least 6 characters."); valid = false;
  } else clearError("passwordError");

  if (!data.signature.trim()) {
    showError("signatureError", "Electronic signature is required."); valid = false;
  } else clearError("signatureError");

  if (data.parentEmail && !EMAIL_RE.test(data.parentEmail)) {
    showError("parentEmailError", "Please enter a valid parent email address."); valid = false;
  } else clearError("parentEmailError");

  return valid;
}

// ── Phone formatting ─────────────────────────────────────────────────────────

function formatPhone(input) {
  const digits = input.value.replace(/\D/g, "").slice(0, 10);
  let formatted = digits;
  if (digits.length > 6)      formatted = `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  else if (digits.length > 3) formatted = `(${digits.slice(0,3)}) ${digits.slice(3)}`;
  else if (digits.length > 0) formatted = `(${digits}`;
  input.value = formatted;
}

document.getElementById("phone").addEventListener("input", function() { formatPhone(this); });
document.getElementById("parent_phone").addEventListener("input", function() { formatPhone(this); });

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

  const turnstileResponse = document.querySelector("[name='cf-turnstile-response']")?.value;
  if (!turnstileResponse) {
    alert("Please complete the security check before submitting.");
    return;
  }

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
    parentName:  document.getElementById("parent_name").value.trim(),
    parentEmail: document.getElementById("parent_email").value.trim().toLowerCase(),
    parentPhone: document.getElementById("parent_phone").value.trim()
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
    // 1. Create Firebase Auth account
    userCredential = await createUserWithEmailAndPassword(auth, data.email, data.password);
    await updateProfile(userCredential.user, { displayName: fullName });

    // 2. Write Firestore profile
    await setDoc(doc(db, "umpires", userCredential.user.uid), {
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
      parentName:  data.parentName  || "",
      parentEmail: data.parentEmail || "",
      parentPhone: data.parentPhone || "",
      approved:    false,
      submittedAt: serverTimestamp()
    });

    // 3. Sign out immediately — user must be approved before logging in
    await signOut(auth);

  } catch (err) {
    // Roll back Auth account if Firestore write already failed
    if (userCredential?.user) {
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
    if (window.turnstile) turnstile.reset();
    return;
  }

  // 4. Send EmailJS notifications (best-effort — don't block on failure)
  const emailData = {
    name:           fullName,
    email:          data.email,
    phone:          data.phone,
    address:        `${data.street}, ${data.city}, ${data.state} ${data.zip}`,
    signature:      data.signature,
    parent_name:    data.parentName  || "N/A",
    parent_email:   data.parentEmail || "",
    parent_phone:   data.parentPhone || "",
    datetime:       new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }),
    main_page_link: "https://tri-valley-baseball-umpires.web.app"
  };

  try { await emailjs.send("service_vljauqe", "template_om0629c", emailData); } catch (_) {}

  if (data.parentEmail) {
    try { await emailjs.send("service_vljauqe", "template_n8kehkc", emailData); } catch (_) {}
  }

  if (window.turnstile) turnstile.reset();

  msgEl.textContent = `Thank you, ${fullName}! Your acknowledgment has been recorded. You'll receive confirmation once an administrator approves your account — this typically takes 1–2 days.`;
  msgEl.className   = "signup-message success";
  this.reset();
  submitBtn.disabled    = false;
  submitBtn.textContent = "Submit Official Acknowledgment";
});
