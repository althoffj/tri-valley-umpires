// utils.js — Shared utility functions used across the app.
// Import only what you need: import { esc, fmtDate, fmtTime } from "./utils.js";

import { getSeasonRange } from "./org.js";

// ── HTML escaping ─────────────────────────────────────────────────────────────

export function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Date / time formatting ────────────────────────────────────────────────────

/** Format an ISO date string (YYYY-MM-DD) as M/D/YYYY. Returns "—" for empty. */
export function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}/${y}`;
}

/** Format a 24-hour time string (HH:MM) as 12-hour AM/PM. Returns "—" for empty. */
export function fmtTime(t) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

/** Today's date as YYYY-MM-DD in local time. */
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── UI helpers ────────────────────────────────────────────────────────────────

/**
 * Set a message element's text and CSS class.
 * @param {string} id   - Element ID
 * @param {string} text - Message text
 * @param {string} type - "info" | "success" | "error"
 */
export function setMsg(id, text, type = "info") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = `signup-message ${type}`;
}

/**
 * Show a brief, non-blocking toast notification.
 * Creates a shared toast element on first call; auto-hides after 4 s.
 * @param {string} msg  - Message to display
 * @param {"error"|"success"|"info"} type
 */
export function showToast(msg, type = "error") {
  let toast = document.getElementById("__appToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "__appToast";
    Object.assign(toast.style, {
      position: "fixed", bottom: "24px", left: "50%",
      transform: "translateX(-50%)", zIndex: "99999",
      padding: "10px 22px", borderRadius: "8px",
      fontSize: "0.9rem", maxWidth: "420px", textAlign: "center",
      boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
      transition: "opacity 0.4s", pointerEvents: "none",
      color: "#fff", fontFamily: "inherit"
    });
    document.body.appendChild(toast);
  }
  const bg = type === "success" ? "#1a6b30" : type === "info" ? "#1a3a6b" : "#7a2035";
  toast.style.background = bg;
  toast.style.opacity    = "1";
  toast.textContent      = msg;
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.style.opacity = "0"; }, 4000);
}

// ── Phone formatting ──────────────────────────────────────────────────────────

/**
 * Format a raw phone string to (XXX) XXX-XXXX.
 * Pure function — returns the formatted string.
 */
export function formatPhone(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "").slice(0, 10);
  if (digits.length > 6) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length > 3) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  if (digits.length > 0) return `(${digits}`;
  return "";
}

/**
 * Format a phone <input> element's value in-place (for use as an input event handler).
 * @param {HTMLInputElement} input
 */
export function formatPhoneInput(input) {
  input.value = formatPhone(input.value);
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

/** Wrap a value in CSV double-quotes, escaping any interior quotes. */
export function csvCell(v) {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}

// ── Date range helpers ────────────────────────────────────────────────────────

/**
 * Current season date range.
 * Uses configured season dates from org settings when available;
 * falls back to the full calendar year.
 */
export function thisYearRange() {
  try { return getSeasonRange(); } catch { /* org settings not yet resolved */ }
  const y = new Date().getFullYear();
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

/** Previous calendar year date range. */
export function lastYearRange() {
  const y = new Date().getFullYear() - 1;
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}
