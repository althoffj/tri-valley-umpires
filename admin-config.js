// admin-config.js — Organization settings, Slack webhooks, push notifications
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

// ── Organization Settings ─────────────────────────────────────────────────────

const ORG_DEFAULTS = {
  orgName:                    "Tri-Valley Baseball Umpires",
  assocName:                  "Tri-Valley Baseball Association",
  assocUrl:                   "https://www.trivalleyball.com",
  homeHeading:                "Welcome Umpires!",
  coordinatorName:            "Jeff Althoff",
  coordinatorPhone:           "605-380-0229",
  coordinatorEmail:           "althoff.jeff@gmail.com",
  slackInviteUrl:             "https://join.slack.com/t/trivalleybase-tfa3350/shared_invite/zt-3ww1egxv7-rS61yDq0LX_Jfhyr5TrlUA",
  activeDivisions:            ["8U", "10U", "12U", "14U", "HS JV", "HS Varsity"],
  accentColor:                "#601929",
  seasonStart:                "",
  seasonEnd:                  "",
  registrationOpen:           true,
  registrationClosedMessage:  "Umpire registration is currently closed for the season. Please check back later.",
  registrationDisclaimer:     "Before submitting this form, review the official expectations PDF. The PDF is the source of truth for the rules and expectations you are acknowledging.",
  weatherLat:                 43.68,
  weatherLon:                 -96.96,
  timezone:                   "America/Chicago",
};

async function loadOrgSettings() {
  try {
    const snap = await getDoc(doc(db, "config", "orgSettings"));
    const s = snap.exists() ? { ...ORG_DEFAULTS, ...snap.data() } : { ...ORG_DEFAULTS };
    if (!Array.isArray(s.activeDivisions)) s.activeDivisions = ORG_DEFAULTS.activeDivisions;

    // Identity
    document.getElementById("orgName").value          = s.orgName;
    document.getElementById("homeHeading").value      = s.homeHeading;
    document.getElementById("assocName").value        = s.assocName;
    document.getElementById("assocUrl").value         = s.assocUrl;
    // Coordinator
    document.getElementById("coordinatorName").value  = s.coordinatorName;
    document.getElementById("coordinatorPhone").value = s.coordinatorPhone;
    document.getElementById("coordinatorEmail").value = s.coordinatorEmail;
    document.getElementById("slackInviteUrl").value   = s.slackInviteUrl;
    // Divisions
    document.querySelectorAll(".org-division-cb").forEach(cb => {
      cb.checked = s.activeDivisions.includes(cb.value);
    });
    // Brand color
    const color = s.accentColor || "#601929";
    document.getElementById("orgAccentColor").value    = color;
    document.getElementById("orgAccentColorHex").value = color;
    document.getElementById("orgColorPreview").style.background = color;
    // Season
    document.getElementById("orgSeasonStart").value = s.seasonStart || "";
    document.getElementById("orgSeasonEnd").value   = s.seasonEnd   || "";
    // Registration
    document.getElementById("orgRegistrationOpen").checked          = s.registrationOpen !== false;
    document.getElementById("orgRegistrationClosedMessage").value   = s.registrationClosedMessage || "";
    document.getElementById("orgRegistrationDisclaimer").value      = s.registrationDisclaimer    || "";
    toggleRegClosedMsg();
    // Technical
    document.getElementById("orgWeatherLat").value = s.weatherLat ?? "";
    document.getElementById("orgWeatherLon").value = s.weatherLon ?? "";
    const tzSel = document.getElementById("orgTimezone");
    if (tzSel) tzSel.value = s.timezone || "America/Chicago";
  } catch (e) {
    setMsg("orgSettingsMessage", "Failed to load organization settings.", "error");
  }
}

function toggleRegClosedMsg() {
  const open  = document.getElementById("orgRegistrationOpen")?.checked;
  const group = document.getElementById("orgRegClosedMsgGroup");
  if (group) group.style.display = open ? "none" : "";
}

async function saveOrgSettings() {
  const btn = document.getElementById("saveOrgSettingsBtn");
  btn.disabled = true;
  setMsg("orgSettingsMessage", "Saving…", "info");
  try {
    const activeDivisions = [...document.querySelectorAll(".org-division-cb:checked")]
      .map(cb => cb.value);
    if (!activeDivisions.length) {
      setMsg("orgSettingsMessage", "Select at least one active division.", "error");
      btn.disabled = false;
      return;
    }

    const hexVal = (document.getElementById("orgAccentColorHex").value.trim() || "#601929").replace(/[^#0-9a-fA-F]/g, "");
    const accentColor = /^#[0-9a-fA-F]{6}$/.test(hexVal) ? hexVal
      : document.getElementById("orgAccentColor").value || "#601929";

    const data = {
      // Identity
      orgName:          document.getElementById("orgName").value.trim()          || ORG_DEFAULTS.orgName,
      homeHeading:      document.getElementById("homeHeading").value.trim()      || ORG_DEFAULTS.homeHeading,
      assocName:        document.getElementById("assocName").value.trim()        || ORG_DEFAULTS.assocName,
      assocUrl:         document.getElementById("assocUrl").value.trim()         || ORG_DEFAULTS.assocUrl,
      // Coordinator
      coordinatorName:  document.getElementById("coordinatorName").value.trim()  || ORG_DEFAULTS.coordinatorName,
      coordinatorPhone: document.getElementById("coordinatorPhone").value.trim() || ORG_DEFAULTS.coordinatorPhone,
      coordinatorEmail: document.getElementById("coordinatorEmail").value.trim() || ORG_DEFAULTS.coordinatorEmail,
      slackInviteUrl:   document.getElementById("slackInviteUrl").value.trim()   || ORG_DEFAULTS.slackInviteUrl,
      // Divisions
      activeDivisions,
      // Brand
      accentColor,
      // Season
      seasonStart: document.getElementById("orgSeasonStart").value || "",
      seasonEnd:   document.getElementById("orgSeasonEnd").value   || "",
      // Registration
      registrationOpen:          document.getElementById("orgRegistrationOpen").checked,
      registrationClosedMessage: document.getElementById("orgRegistrationClosedMessage").value.trim() || ORG_DEFAULTS.registrationClosedMessage,
      registrationDisclaimer:    document.getElementById("orgRegistrationDisclaimer").value.trim()    || ORG_DEFAULTS.registrationDisclaimer,
      // Technical
      weatherLat: parseFloat(document.getElementById("orgWeatherLat").value) || ORG_DEFAULTS.weatherLat,
      weatherLon: parseFloat(document.getElementById("orgWeatherLon").value) || ORG_DEFAULTS.weatherLon,
      timezone:   document.getElementById("orgTimezone").value                || ORG_DEFAULTS.timezone,
    };
    await setDoc(doc(db, "config", "orgSettings"), data);
    setMsg("orgSettingsMessage", "✓ Organization settings saved.", "success");
  } catch (e) {
    setMsg("orgSettingsMessage", "Failed to save: " + (e.message || "Unknown error"), "error");
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("saveOrgSettingsBtn").addEventListener("click", saveOrgSettings);

// Color picker ↔ hex input sync
document.getElementById("orgAccentColor").addEventListener("input", function() {
  document.getElementById("orgAccentColorHex").value = this.value;
  document.getElementById("orgColorPreview").style.background = this.value;
});
document.getElementById("orgAccentColorHex").addEventListener("input", function() {
  const v = this.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) {
    document.getElementById("orgAccentColor").value = v;
    document.getElementById("orgColorPreview").style.background = v;
  }
});
document.getElementById("orgRegistrationOpen").addEventListener("change", toggleRegClosedMsg);

// ── Slack Webhooks ────────────────────────────────────────────────────────────

const EVENT_LABELS = {
  gameChanges:          "Game changes",
  slotChanges:          "Slot signups & cancellations",
  dayOfReminders:       "Day-of reminders",
  dailySummary:         "Daily summary",
  openSlots:            "Open slot alerts",
  cancellationRequests: "Cancellation requests",
  incidentReports:      "Incident reports",
  tournamentSwaps:      "Tournament field swaps",
};

let webhooks = []; // in-memory copy of the webhooks array

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
    return `<div class="webhook-card">
      <div class="webhook-card-info">
        <div class="webhook-card-label">${esc(w.label || w.id)}</div>
        <div class="webhook-card-url">${esc(maskUrl(w.url))}</div>
        <div class="webhook-card-tags">${inactiveTag}${divTags}${eventTags}</div>
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
  document.getElementById("webhookDeleteBtn").style.display = w ? "" : "none";
  setMsg("webhookEditMessage", "", "info");

  // Reset checkboxes
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

document.getElementById("addWebhookBtn").addEventListener("click", () => openWebhookEdit(null));
document.getElementById("webhookCancelBtn").addEventListener("click", closeWebhookEdit);

document.getElementById("webhookSaveBtn").addEventListener("click", async () => {
  const id    = document.getElementById("webhookEditId").value.trim();
  const label = document.getElementById("webhookLabel").value.trim();
  const url   = document.getElementById("webhookUrl").value.trim();

  if (!label) { setMsg("webhookEditMessage", "Label is required.", "error"); return; }
  if (!url)   { setMsg("webhookEditMessage", "Webhook URL is required.", "error"); return; }
  try { new URL(url); } catch {
    setMsg("webhookEditMessage", "Invalid URL.", "error"); return;
  }

  const events    = [...document.querySelectorAll(".webhook-event-cb:checked")].map(cb => cb.value);
  const divisions = [...document.querySelectorAll(".webhook-div-cb:checked")].map(cb => cb.value);
  const active    = document.getElementById("webhookActive").checked;

  const newId = id || `wh_${Date.now()}`;
  const entry = { id: newId, label, url, events, divisions, active };

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

document.getElementById("webhookDeleteBtn").addEventListener("click", async () => {
  const id = document.getElementById("webhookEditId").value;
  const w  = webhooks.find(x => x.id === id);
  if (!w || !confirm(`Delete webhook "${w.label}"?`)) return;
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

async function loadSlackWebhooks() {
  try {
    const snap = await getDoc(doc(db, "config", "slackWebhooks"));
    if (snap.exists()) {
      const d = snap.data();
      if (Array.isArray(d.webhooks)) {
        // New format
        webhooks = d.webhooks;
      } else {
        // Migrate legacy format to new format automatically
        webhooks = [];
        const events = ["gameChanges","slotChanges","dayOfReminders","openSlots","cancellationRequests","incidentReports","tournamentSwaps"];
        if (d.jeff) webhooks.push({ id: "jeff", label: "Jeff (Admin)", url: d.jeff, events, divisions: [], active: true });
        if (d.ch10u) webhooks.push({ id: "ch10u", label: "10U Channel", url: d.ch10u, events: ["gameChanges","dayOfReminders"], divisions: ["10U"], active: true });
        if (d.ch12u) webhooks.push({ id: "ch12u", label: "12U Channel", url: d.ch12u, events: ["gameChanges","dayOfReminders"], divisions: ["12U"], active: true });
        if (d.dailySummary) webhooks.push({ id: "summary", label: "Daily Summary", url: d.dailySummary, events: ["dailySummary"], divisions: [], active: true });
        // Save migrated data back
        if (webhooks.length) await saveWebhooks().catch(() => {});
      }
    }
  } catch (_) {}
  renderWebhookList();
}

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

  loadOrgSettings();
  loadSlackWebhooks();
});
