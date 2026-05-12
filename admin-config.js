// admin-config.js — Pay rates, default slot types, Slack webhooks, push notifications
import { db, app } from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import {
  getDoc,
  doc,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setMsg(id, text, type = "info") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = `signup-message ${type}`;
}

// ── Pay Rates ─────────────────────────────────────────────────────────────────

async function loadPayRates() {
  try {
    const snap = await getDoc(doc(db, "config", "payRates"));
    if (snap.exists()) {
      const r = snap.data();
      document.getElementById("ratePlate").value = r.plate ?? "";
      document.getElementById("rateField").value  = r.field  ?? "";
      document.getElementById("rateExtra").value  = r.extra  ?? "";

      // Load defaultSlotTypes checkboxes
      const defaults = r.defaultSlotTypes ?? [];
      document.getElementById("defaultSlotPlate").checked = defaults.includes("Plate");
      document.getElementById("defaultSlotField").checked = defaults.includes("Field");
      document.getElementById("defaultSlotExtra").checked = defaults.includes("Extra");
    }
  } catch (err) {
    console.error("Failed to load pay rates:", err);
  }
}

document.getElementById("payRatesForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn = this.querySelector("button[type='submit']");
  btn.disabled = true;
  setMsg("payRatesMessage", "Saving…", "info");
  try {
    const snap = await getDoc(doc(db, "config", "payRates"));
    const existing = snap.exists() ? snap.data() : {};
    await setDoc(doc(db, "config", "payRates"), {
      ...existing,
      plate: parseFloat(document.getElementById("ratePlate").value) || 0,
      field: parseFloat(document.getElementById("rateField").value)  || 0,
      extra: parseFloat(document.getElementById("rateExtra").value)  || 0
    });
    setMsg("payRatesMessage", "Pay rates saved.", "success");
  } catch (err) {
    setMsg("payRatesMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Default Slot Types ────────────────────────────────────────────────────────

document.getElementById("defaultSlotTypesForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn = this.querySelector("button[type='submit']");
  btn.disabled = true;
  setMsg("defaultSlotTypesMessage", "Saving…", "info");
  try {
    const selected = ["Plate", "Field", "Extra"].filter(t =>
      document.getElementById(`defaultSlot${t}`).checked
    );
    const snap = await getDoc(doc(db, "config", "payRates"));
    const existing = snap.exists() ? snap.data() : {};
    await setDoc(doc(db, "config", "payRates"), {
      ...existing,
      defaultSlotTypes: selected
    });
    setMsg("defaultSlotTypesMessage", "Default slot types saved.", "success");
  } catch (err) {
    setMsg("defaultSlotTypesMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Scheduling Rules ──────────────────────────────────────────────────────────

const SCHEDULING_DEFAULTS = { "10U": 90, "12U": 90, "14U": 120, "HS JV": 120, "HS Varsity": 150, default: 90 };
const DUR_IDS = { "10U": "dur10U", "12U": "dur12U", "14U": "dur14U", "HS JV": "durHSJV", "HS Varsity": "durHSVar", default: "durDefault" };

async function loadSchedulingConfig() {
  try {
    const snap = await getDoc(doc(db, "config", "scheduling"));
    const d = snap.exists() ? snap.data() : {};
    const dur = d.gameDurationMinutes || {};
    Object.entries(DUR_IDS).forEach(([div, elId]) => {
      const el = document.getElementById(elId);
      if (el) el.value = dur[div] ?? SCHEDULING_DEFAULTS[div] ?? 90;
    });
    const cutoffEl = document.getElementById("lateStartCutoff");
    if (cutoffEl) cutoffEl.value = d.lateStartCutoff ?? "19:30";
  } catch (_) {}
}

document.getElementById("schedulingConfigForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn = this.querySelector("button[type='submit']");
  btn.disabled = true;
  setMsg("schedulingConfigMessage", "Saving…", "info");
  try {
    const gameDurationMinutes = {};
    Object.entries(DUR_IDS).forEach(([div, elId]) => {
      const val = parseInt(document.getElementById(elId)?.value);
      gameDurationMinutes[div] = isNaN(val) ? SCHEDULING_DEFAULTS[div] : val;
    });
    const lateStartCutoff = document.getElementById("lateStartCutoff").value || "19:30";
    await setDoc(doc(db, "config", "scheduling"), { gameDurationMinutes, lateStartCutoff });
    setMsg("schedulingConfigMessage", "Scheduling rules saved.", "success");
  } catch (err) {
    setMsg("schedulingConfigMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Slack Webhooks ────────────────────────────────────────────────────────────

async function loadSlackWebhooks() {
  try {
    const snap = await getDoc(doc(db, "config", "slackWebhooks"));
    if (snap.exists()) {
      const d = snap.data();
      document.getElementById("slackJeff").value         = d.jeff         || "";
      document.getElementById("slack10u").value          = d.ch10u        || "";
      document.getElementById("slack12u").value          = d.ch12u        || "";
      document.getElementById("slackDailySummary").value = d.dailySummary || "";
      document.getElementById("slackBroadcast").value    = d.broadcast    || "";
    }
  } catch (_) {}
}

document.getElementById("slackWebhooksForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn = this.querySelector("button[type='submit']");
  btn.disabled = true;
  setMsg("slackWebhooksMessage", "Saving…", "info");
  try {
    await setDoc(doc(db, "config", "slackWebhooks"), {
      jeff:         document.getElementById("slackJeff").value.trim(),
      ch10u:        document.getElementById("slack10u").value.trim(),
      ch12u:        document.getElementById("slack12u").value.trim(),
      dailySummary: document.getElementById("slackDailySummary").value.trim(),
      broadcast:    document.getElementById("slackBroadcast").value.trim()
    });
    setMsg("slackWebhooksMessage", "Webhooks saved.", "success");
  } catch (err) {
    setMsg("slackWebhooksMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Slack Manual Triggers ─────────────────────────────────────────────────────

const triggerDayOfRemindersFn  = httpsCallable(getFunctions(app), "triggerDayOfReminders");
const triggerDailyGameSummaryFn = httpsCallable(getFunctions(app), "triggerDailyGameSummary");

async function runSlackTrigger(fn, btnId, label) {
  const btn = document.getElementById(btnId);
  btn.disabled = true;
  setMsg("slackTriggerMessage", `Sending ${label}…`, "info");
  try {
    const result = await fn();
    const d = result.data ?? {};
    if (d.sent === false) {
      setMsg("slackTriggerMessage", `${label}: ${d.reason ?? "No webhook configured."}`, "error");
    } else {
      const detail = d.games != null ? ` (${d.games} game${d.games !== 1 ? "s" : ""})` : (d.sent != null ? ` (${d.sent} game${d.sent !== 1 ? "s" : ""})` : "");
      setMsg("slackTriggerMessage", `✓ ${label} sent${detail}.`, "success");
    }
  } catch (err) {
    setMsg("slackTriggerMessage", err.message || `Failed to send ${label}.`, "error");
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("triggerRemindersBtn").addEventListener("click", () =>
  runSlackTrigger(triggerDayOfRemindersFn, "triggerRemindersBtn", "Day-of Reminders")
);

document.getElementById("triggerSummaryBtn").addEventListener("click", () =>
  runSlackTrigger(triggerDailyGameSummaryFn, "triggerSummaryBtn", "Daily Summary")
);

// ── Push Notifications ────────────────────────────────────────────────────────

const sendBroadcastFn = httpsCallable(getFunctions(app), "sendBroadcast");

document.getElementById("notifForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn   = document.getElementById("sendNotifBtn");
  const title = document.getElementById("notifTitle").value.trim();
  const body  = document.getElementById("notifBody").value.trim();

  btn.disabled = true;
  setMsg("notifMessage", "Sending…", "info");

  try {
    const slackWebhook = document.getElementById("slackBroadcast").value.trim();
    const result = await sendBroadcastFn({ title, body, slackWebhook });
    const { sent = 0, failed = 0, slacked = false } = result.data;
    const pushMsg = sent === 0
      ? "No umpires have notifications enabled yet."
      : `Sent to ${sent} umpire${sent !== 1 ? "s" : ""}${failed > 0 ? ` (${failed} failed)` : ""}.`;
    const slackMsg = slacked ? " Also posted to Slack." : "";
    setMsg("notifMessage", pushMsg + slackMsg, "success");
    this.reset();
  } catch (err) {
    setMsg("notifMessage", err.message || "Failed to send notification.", "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Email All Umpires ─────────────────────────────────────────────────────────

const sendBroadcastEmailFn = httpsCallable(getFunctions(app), "sendBroadcastEmail");

document.getElementById("emailAllForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn     = document.getElementById("sendEmailAllBtn");
  const subject = document.getElementById("emailAllSubject").value.trim();
  const body    = document.getElementById("emailAllBody").value.trim();

  if (!confirm(`Send this email to all active umpires?\n\nSubject: ${subject}`)) return;

  btn.disabled = true;
  setMsg("emailAllMessage", "Sending…", "info");
  try {
    const result = await sendBroadcastEmailFn({ subject, body });
    const { sent = 0, failed = 0 } = result.data;
    const msg = sent === 0
      ? "No approved umpires found with email addresses."
      : `Sent to ${sent} umpire${sent !== 1 ? "s" : ""}${failed > 0 ? ` (${failed} failed)` : ""}.`;
    setMsg("emailAllMessage", msg, "success");
    this.reset();
  } catch (err) {
    setMsg("emailAllMessage", err.message || "Failed to send email.", "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display = "none";

  loadPayRates();
  loadSchedulingConfig();
  loadSlackWebhooks();
});
