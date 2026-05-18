// admin-config.js — Organization settings, Slack webhooks, push notifications
import { db, app } from "./firebase.js";
import { authReadyPromise, isAdmin, isSuperAdmin } from "./auth.js";
import { esc, setMsg, showConfirm } from "./utils.js";
import { getOrgSettings, ORG_DEFAULTS } from "./org.js";

import {
  getDoc,
  doc,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import { initSlackWebhooks, loadSlackWebhooks } from "./slack-webhooks.js";

// ── Organization Settings ─────────────────────────────────────────────────────

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
    renderDivisionTags(s.activeDivisions);
    // Brand color
    const color = s.accentColor || "#601929";
    document.getElementById("orgAccentColor").value    = color;
    document.getElementById("orgAccentColorHex").value = color;
    document.getElementById("orgColorPreview").style.background = color;
    // Logo
    const logoUrl = s.logoUrl || "logo.png";
    document.getElementById("orgLogoUrl").value = logoUrl;
    document.getElementById("orgLogoPreview").src = logoUrl;
    // City programs
    document.getElementById("orgCityPrograms").value = (Array.isArray(s.cityPrograms) ? s.cityPrograms : []).join("\n");
    // Season
    document.getElementById("orgSeasonStart").value = s.seasonStart || "";
    document.getElementById("orgSeasonEnd").value   = s.seasonEnd   || "";
    // Registration
    document.getElementById("orgRegistrationOpen").checked          = s.registrationOpen !== false;
    document.getElementById("orgRegistrationClosedMessage").value   = s.registrationClosedMessage || "";
    document.getElementById("orgRegistrationDisclaimer").value      = s.registrationDisclaimer    || "";
    toggleRegClosedMsg();
    // Coach access
    document.getElementById("orgAllowCoachShedCodes").checked = s.allowCoachShedCodes === true;
    // Division reps — populate dropdown options before rendering rows
    _repDivisions = s.activeDivisions || [];
    renderDivRepRows(Array.isArray(s.divisionReps) ? s.divisionReps : []);
    // Field use calendar
    document.getElementById("orgFieldCalendarUrl").value = s.fieldCalendarUrl || "";
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
    const activeDivisions = [...document.querySelectorAll("#divisionTagList .div-chip")]
      .map(chip => chip.dataset.value);
    if (!activeDivisions.length) {
      setMsg("orgSettingsMessage", "Add at least one active division.", "error");
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
      logoUrl: document.getElementById("orgLogoUrl").value.trim() || "logo.png",
      // City programs
      cityPrograms: document.getElementById("orgCityPrograms").value.split("\n").map(s => s.trim()).filter(Boolean),
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
      // Coach access
      allowCoachShedCodes: document.getElementById("orgAllowCoachShedCodes").checked,
      // Field use calendar
      fieldCalendarUrl: document.getElementById("orgFieldCalendarUrl").value.trim(),
      // Division reps
      divisionReps: collectDivReps(),
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
document.getElementById("orgLogoUrl").addEventListener("input", function() {
  const v = this.value.trim() || "logo.png";
  document.getElementById("orgLogoPreview").src = v;
});

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

  if (!await showConfirm(`Send this email to all active umpires?\n\nSubject: ${subject}`)) return;

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

// ── Config section tab switching ──────────────────────────────────────────────

document.querySelectorAll(".sched-sec-btn[data-cfg]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".sched-sec-btn[data-cfg]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.cfg;
    document.getElementById("cfg-tab-org").style.display   = tab === "org"   ? "" : "none";
    document.getElementById("cfg-tab-comms").style.display = tab === "comms" ? "" : "none";
  });
});

// ── Division Tag Editor ───────────────────────────────────────────────────────

function makeDivisionTag(div) {
  const chip = document.createElement("span");
  chip.dataset.value = div;
  chip.className = "div-chip";
  chip.style.cssText = "display:inline-flex;align-items:center;gap:5px;padding:5px 12px;background:var(--accent);color:#fff;border-radius:20px;font-size:0.88rem;white-space:nowrap";
  chip.innerHTML = esc(div) + ' <button type="button" title="Remove" style="background:none;border:none;color:#fff;cursor:pointer;padding:0;font-size:1.1rem;line-height:1;opacity:0.75">×</button>';
  chip.querySelector("button").addEventListener("click", () => chip.remove());
  return chip;
}

function renderDivisionTags(divisions = []) {
  const list = document.getElementById("divisionTagList");
  if (!list) return;
  list.innerHTML = "";
  divisions.forEach(div => list.appendChild(makeDivisionTag(div)));
}

function addDivisionFromInput() {
  const input = document.getElementById("newDivisionInput");
  const val = input.value.trim();
  if (!val) return;
  const existing = [...document.querySelectorAll("#divisionTagList .div-chip")].map(c => c.dataset.value);
  if (existing.includes(val)) { input.value = ""; input.focus(); return; }
  document.getElementById("divisionTagList").appendChild(makeDivisionTag(val));
  input.value = "";
  input.focus();
}

document.getElementById("addDivisionBtn").addEventListener("click", addDivisionFromInput);
document.getElementById("newDivisionInput").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); addDivisionFromInput(); }
});

// ── Division Representatives ──────────────────────────────────────────────────

const INPUT_S = "padding:7px 9px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px;font-size:0.85rem;box-sizing:border-box";

// Cached active divisions for rep row dropdowns (populated when org settings load)
let _repDivisions = [];

function makeDivRepRow(rep = {}) {
  const row = document.createElement("div");
  row.className = "div-rep-row";
  row.style.cssText = "display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:6px;margin-bottom:8px;align-items:center";
  const divOptions = '<option value="">-- Division --</option>' +
    _repDivisions.map(d => '<option value="' + esc(d) + '"' + (d === (rep.division || "") ? ' selected' : '') + '>' + esc(d) + '</option>').join("");
  row.innerHTML =
    '<select class="drDivision" style="' + INPUT_S + '">' + divOptions + '</select>' +
    '<input type="text"  class="drName"  placeholder="Rep Name" value="' + esc(rep.name  || "") + '" style="' + INPUT_S + '" />' +
    '<input type="email" class="drEmail" placeholder="Email"    value="' + esc(rep.email || "") + '" style="' + INPUT_S + '" />' +
    '<input type="tel"   class="drPhone" placeholder="Phone"    value="' + esc(rep.phone || "") + '" style="' + INPUT_S + '" />' +
    '<button type="button" class="dr-remove-btn" title="Remove" style="padding:5px 9px;background:transparent;color:#ff8a8a;border:1px solid #884444;border-radius:5px;cursor:pointer;font-size:1rem;line-height:1">×</button>';
  row.querySelector(".dr-remove-btn").addEventListener("click", () => row.remove());
  return row;
}

function renderDivRepRows(reps = []) {
  const container = document.getElementById("divRepRows");
  if (!container) return;
  container.innerHTML = "";
  if (!reps.length) { container.appendChild(makeDivRepRow()); return; } // start with one empty row
  reps.forEach(r => container.appendChild(makeDivRepRow(r)));
}

function collectDivReps() {
  return [...document.querySelectorAll("#divRepRows .div-rep-row")]
    .map(row => ({
      division: row.querySelector(".drDivision").value.trim(),
      name:     row.querySelector(".drName").value.trim(),
      email:    row.querySelector(".drEmail").value.trim(),
      phone:    row.querySelector(".drPhone").value.trim(),
    }))
    .filter(r => r.division && r.name);
}

document.getElementById("addDivRepBtn")?.addEventListener("click", () => {
  document.getElementById("divRepRows").appendChild(makeDivRepRow());
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

  // Slack webhook config is restricted to super admins
  if (isSuperAdmin()) {
    document.getElementById("slackWebhookSection").style.display = "";
    initSlackWebhooks();
    loadSlackWebhooks();
  }
});
