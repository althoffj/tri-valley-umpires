// slack-webhooks.js — Shared Slack webhook management (admin-config + admin-alerts)
// Requires the page to include the standard webhook HTML elements:
//   #slackWebhookList, #addWebhookBtn, #webhookEditPanel, #webhookEditTitle,
//   #webhookEditId, #webhookLabel, #webhookUrl, #webhookActive, #webhookDeleteBtn,
//   #webhookEditMessage, .webhook-event-cb, .webhook-div-cb,
//   #webhookSaveBtn, #webhookCancelBtn,
//   #slackTriggerMessage, #triggerRemindersBtn, #triggerSummaryBtn
import { db, app } from "./firebase.js";
import { esc, setMsg, showConfirm } from "./utils.js";
import {
  doc,
  getDoc,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

const EVENT_LABELS = {
  gameChanges:          "Game changes",
  slotChanges:          "Slot signups & cancellations",
  dayOfReminders:       "Day-of reminders",
  dailySummary:         "Daily summary",
  openSlots:            "Open slot alerts",
  cancellationRequests: "Cancellation requests",
  incidentReports:      "Incident reports",
  tournamentSwaps:      "Tournament field swaps",
  coachRegistration:    "Coach registrations",
  umpireRequests:       "Coach umpire requests",
  practiceRequests:     "Practice requests",
};

let webhooks = [];

function maskUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 3) {
      return `…/${parts[parts.length - 2].slice(0,4)}…/${parts[parts.length - 1].slice(0,6)}…`;
    }
    return url.slice(0, 40) + "…";
  } catch { return url.slice(0, 40) + "…"; }
}

function renderWebhookList() {
  const el = document.getElementById("slackWebhookList");
  if (!el) return;
  if (!webhooks.length) {
    el.innerHTML = `<p style="color:var(--light-text)">No webhooks configured yet. Click <strong>+ Add Webhook</strong> to get started.</p>`;
    return;
  }
  el.innerHTML = webhooks.map(w => {
    const eventTags = (w.events || []).map(e =>
      `<span class="webhook-tag">${EVENT_LABELS[e] || e}</span>`
    ).join("");
    const divTags = (w.divisions || []).length
      ? (w.divisions || []).map(d => `<span class="webhook-tag div-tag">${esc(d)}</span>`).join("")
      : `<span class="webhook-tag div-tag">All divisions</span>`;
    const inactiveTag = w.active === false ? `<span class="webhook-tag inactive">Inactive</span>` : "";
    const homeUmpTag  = w.homeUmpireOnly ? `<span class="webhook-tag">Home+umpire only</span>` : "";
    return `<div class="webhook-card">
      <div class="webhook-card-info">
        <div class="webhook-card-label">${esc(w.label || w.id)}</div>
        <div class="webhook-card-url">${esc(maskUrl(w.url))}</div>
        <div class="webhook-card-tags">${inactiveTag}${homeUmpTag}${divTags}${eventTags}</div>
      </div>
      <button class="btn print-btn webhook-edit-btn" data-id="${esc(w.id)}"
        style="font-size:0.8rem;padding:5px 12px;flex-shrink:0">Edit</button>
    </div>`;
  }).join("");

  el.querySelectorAll(".webhook-edit-btn").forEach(btn =>
    btn.addEventListener("click", () => openWebhookEdit(btn.dataset.id))
  );
}

function openWebhookEdit(id) {
  const w = id ? webhooks.find(x => x.id === id) : null;
  const panel = document.getElementById("webhookEditPanel");
  document.getElementById("webhookEditTitle").textContent = w ? "Edit Webhook" : "Add Webhook";
  document.getElementById("webhookEditId").value   = w?.id    || "";
  document.getElementById("webhookLabel").value    = w?.label || "";
  document.getElementById("webhookUrl").value      = w?.url   || "";
  document.getElementById("webhookActive").checked = w?.active !== false;
  const homeUmpEl = document.getElementById("webhookHomeUmpireOnly");
  if (homeUmpEl) homeUmpEl.checked = !!(w && w.homeUmpireOnly);
  document.getElementById("webhookDeleteBtn").style.display = w ? "" : "none";
  setMsg("webhookEditMessage", "", "info");

  document.querySelectorAll(".webhook-event-cb").forEach(cb => {
    cb.checked = w ? (w.events || []).includes(cb.value) : false;
  });
  document.querySelectorAll(".webhook-div-cb").forEach(cb => {
    cb.checked = w ? (w.divisions || []).includes(cb.value) : false;
  });

  panel.style.display = "";
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeWebhookEdit() {
  document.getElementById("webhookEditPanel").style.display = "none";
  setMsg("webhookEditMessage", "", "info");
}

async function saveWebhooks() {
  await setDoc(doc(db, "config", "slackWebhooks"), { webhooks });
}

export async function loadSlackWebhooks() {
  try {
    const snap = await getDoc(doc(db, "config", "slackWebhooks"));
    if (snap.exists()) {
      const d = snap.data();
      if (Array.isArray(d.webhooks)) {
        webhooks = d.webhooks;
      } else {
        // Migrate legacy format to new format automatically
        webhooks = [];
        const events = ["gameChanges","slotChanges","dayOfReminders","openSlots","cancellationRequests","incidentReports","tournamentSwaps"];
        if (d.jeff)         webhooks.push({ id: "jeff",    label: "Jeff (Admin)",    url: d.jeff,         events,                                         divisions: [], active: true });
        if (d.ch10u)        webhooks.push({ id: "ch10u",   label: "10U Channel",     url: d.ch10u,        events: ["gameChanges","dayOfReminders"],        divisions: ["10U"], active: true });
        if (d.ch12u)        webhooks.push({ id: "ch12u",   label: "12U Channel",     url: d.ch12u,        events: ["gameChanges","dayOfReminders"],        divisions: ["12U"], active: true });
        if (d.dailySummary) webhooks.push({ id: "summary", label: "Daily Summary",   url: d.dailySummary, events: ["dailySummary"],                        divisions: [], active: true });
        if (webhooks.length) await saveWebhooks().catch(() => {});
      }
    }
  } catch (_) {}
  renderWebhookList();
}

// ── Slack Manual Triggers ─────────────────────────────────────────────────────

const triggerDayOfRemindersFn   = httpsCallable(getFunctions(app), "triggerDayOfReminders");
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
      const detail = d.games != null
        ? ` (${d.games} game${d.games !== 1 ? "s" : ""})`
        : (d.sent != null ? ` (${d.sent} game${d.sent !== 1 ? "s" : ""})` : "");
      setMsg("slackTriggerMessage", `✓ ${label} sent${detail}.`, "success");
    }
  } catch (err) {
    setMsg("slackTriggerMessage", err.message || `Failed to send ${label}.`, "error");
  } finally {
    btn.disabled = false;
  }
}

// ── Wire up all event listeners ───────────────────────────────────────────────

export function initSlackWebhooks() {
  document.getElementById("addWebhookBtn")?.addEventListener("click", () => openWebhookEdit(null));
  document.getElementById("webhookCancelBtn")?.addEventListener("click", closeWebhookEdit);

  document.getElementById("webhookSaveBtn")?.addEventListener("click", async () => {
    const id    = document.getElementById("webhookEditId").value.trim();
    const label = document.getElementById("webhookLabel").value.trim();
    const url   = document.getElementById("webhookUrl").value.trim();

    if (!label) { setMsg("webhookEditMessage", "Label is required.", "error"); return; }
    if (!url)   { setMsg("webhookEditMessage", "Webhook URL is required.", "error"); return; }
    try { new URL(url); } catch {
      setMsg("webhookEditMessage", "Invalid URL.", "error"); return;
    }

    const events         = [...document.querySelectorAll(".webhook-event-cb:checked")].map(cb => cb.value);
    const divisions      = [...document.querySelectorAll(".webhook-div-cb:checked")].map(cb => cb.value);
    const active         = document.getElementById("webhookActive").checked;
    const homeUmpireOnly = !!(document.getElementById("webhookHomeUmpireOnly")?.checked);

    const newId = id || `wh_${Date.now()}`;
    const entry = { id: newId, label, url, events, divisions, active, homeUmpireOnly };

    if (id) {
      const idx = webhooks.findIndex(w => w.id === id);
      if (idx >= 0) webhooks[idx] = entry; else webhooks.push(entry);
    } else {
      webhooks.push(entry);
    }

    setMsg("webhookEditMessage", "Saving…", "info");
    try {
      await saveWebhooks();
      setMsg("webhookEditMessage", "Saved.", "success");
      renderWebhookList();
      setTimeout(closeWebhookEdit, 800);
    } catch (err) {
      setMsg("webhookEditMessage", err.message, "error");
    }
  });

  document.getElementById("webhookDeleteBtn")?.addEventListener("click", async () => {
    const id = document.getElementById("webhookEditId").value;
    const w  = webhooks.find(x => x.id === id);
    if (!w || !await showConfirm(`Delete webhook "${w.label}"?`)) return;
    webhooks = webhooks.filter(x => x.id !== id);
    setMsg("webhookEditMessage", "Deleting…", "info");
    try {
      await saveWebhooks();
      renderWebhookList();
      closeWebhookEdit();
    } catch (err) {
      setMsg("webhookEditMessage", err.message, "error");
    }
  });

  document.getElementById("triggerRemindersBtn")?.addEventListener("click", () =>
    runSlackTrigger(triggerDayOfRemindersFn, "triggerRemindersBtn", "Day-of Reminders")
  );

  document.getElementById("triggerSummaryBtn")?.addEventListener("click", () =>
    runSlackTrigger(triggerDailyGameSummaryFn, "triggerSummaryBtn", "Daily Summary")
  );
}
