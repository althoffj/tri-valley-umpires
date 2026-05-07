// index.js — home page login, logout, and password reset
import { authReadyPromise, login, logout, sendResetEmail } from "./auth.js";

// ── Login ─────────────────────────────────────────────────────────────────────

document.getElementById("loginForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const email    = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const msgEl    = document.getElementById("loginMessage");
  const btn      = document.getElementById("loginBtn");

  btn.disabled      = true;
  msgEl.textContent = "Logging in…";
  msgEl.className   = "signup-message info";

  try {
    await login(email, password);
    msgEl.textContent = "Login successful!";
    msgEl.className   = "signup-message success";
    this.reset();
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className   = "signup-message error";
  } finally {
    btn.disabled = false;
  }
});

// ── Logout ────────────────────────────────────────────────────────────────────

document.getElementById("logoutBtn").addEventListener("click", () => logout());

// ── Password reset toggle ─────────────────────────────────────────────────────

document.getElementById("showResetBtn").addEventListener("click", () => {
  document.getElementById("loginForm").hidden = true;
  document.getElementById("resetForm").hidden = false;
  document.getElementById("resetMessage").textContent = "";
});

document.getElementById("cancelResetBtn").addEventListener("click", () => {
  document.getElementById("resetForm").hidden = true;
  document.getElementById("loginForm").hidden = false;
  document.getElementById("resetMessage").textContent = "";
});

// ── Password reset submit ─────────────────────────────────────────────────────

document.getElementById("resetForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const email  = document.getElementById("resetEmail").value.trim();
  const msgEl  = document.getElementById("resetMessage");
  const btn    = document.getElementById("resetBtn");

  btn.disabled      = true;
  msgEl.textContent = "Sending…";
  msgEl.className   = "signup-message info";

  try {
    await sendResetEmail(email);
    msgEl.textContent = "Reset email sent! Check your inbox and follow the link to set a new password.";
    msgEl.className   = "signup-message success";
    this.reset();
  } catch (err) {
    const friendly = err.code === "auth/user-not-found"
      ? "No account found with that email address."
      : "Failed to send reset email. Please try again.";
    msgEl.textContent = friendly;
    msgEl.className   = "signup-message error";
  } finally {
    btn.disabled = false;
  }
});
