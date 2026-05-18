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
    document.querySelectorAll(".org-division-cb").forEach(cb => {
      cb.checked = s.activeDivisions.includes(cb.value);
    });
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
