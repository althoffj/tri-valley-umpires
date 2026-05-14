// admin-alerts.js — Announcements, Broadcast (push + email), and Slack webhooks
import { db, app } from "./firebase.js";
import { authReadyPromise, isAdmin, isSuperAdmin, getCurrentUser } from "./auth.js";
import {
  collection,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  query,
  orderBy,
  serverTimestamp,
  deleteField
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

function fmtTs(ts) {
  return ts?.toDate
    ? ts.toDate().toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit"
      })
    : "—";
}

// ── Tab Switching ─────────────────────────────────────────────────────────────

document.querySelectorAll(".al-tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".al-tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".al-tab-pane").forEach(p => p.style.display = "none");
    btn.classList.add("active");
    document.getElementById(btn.dataset.pane).style.display = "";
  });
});

// ── Announcements ─────────────────────────────────────────────────────────────

async function loadAnnouncements() {
  const listEl = document.getElementById("alAnnouncementsList");
  if (!listEl) return;

  try {
    const snap = await getDocs(
      query(collection(db, "announcements"), orderBy("createdAt", "desc"))
    );

    if (snap.empty) {
      listEl.innerHTML = '<p style="color:var(--light-text)">No announcements yet.</p>';
      return;
    }

    const superAdmin = isSuperAdmin();

    listEl.innerHTML = snap.docs.map(d => {
      const a  = d.data();
      const id = d.id;

      const activeBadge = a.active
        ? '<span class="badge" style="background:#17351f;color:#b8f2c4">Active</span>'
        : '<span class="badge" style="background:#333;color:#999">Inactive</span>';

      const deleteBtn = superAdmin
        ? `<button class="btn al-ann-delete-btn" data-id="${esc(id)}"
             style="font-size:0.8rem;padding:4px 12px">Delete</button>`
        : "";

      return `
        <div class="al-ann-row" data-ann-id="${esc(id)}">
          <div class="al-ann-row-header">
            <span class="al-ann-row-title">${esc(a.title ?? "")}</span>
            <div class="al-ann-row-meta">
              ${activeBadge}
            </div>
          </div>
          <div class="al-ann-row-body">${esc(a.body ?? "")}</div>
          <div class="al-ann-dates">
            <span><strong>Created:</strong> ${fmtTs(a.createdAt)}</span>
            <span><strong>Posted:</strong> ${fmtTs(a.postedAt)}</span>
            <span><strong>Deactivated:</strong> ${fmtTs(a.deactivatedAt)}</span>
          </div>
          <div class="page-actions" style="margin:0">
            <button class="btn print-btn al-ann-toggle-btn" data-id="${esc(id)}" data-active="${a.active ? "1" : "0"}"
              style="font-size:0.8rem;padding:4px 12px">${a.active ? "Deactivate" : "Activate"}</button>
            ${deleteBtn}
          </div>
        </div>`;
    }).join("");
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<p style="color:#ffb4b4">Error loading announcements.</p>';
  }
}

async function createAnnouncement(title, body) {
  await addDoc(collection(db, "announcements"), {
    title,
    body,
    active: true,
    createdAt: serverTimestamp(),
    postedAt: serverTimestamp(),
    createdBy: getCurrentUser()?.uid ?? ""
  });
}

async function toggleAnnouncement(id, currentlyActive) {
  try {
    if (currentlyActive) {
      await updateDoc(doc(db, "announcements", id), {
        active: false,
        deactivatedAt: serverTimestamp(),
        deactivatedBy: getCurrentUser()?.uid ?? ""
      });
    } else {
      await updateDoc(doc(db, "announcements", id), {
        active: true,
        postedAt: serverTimestamp(),
        deactivatedAt: deleteField(),
        deactivatedBy: deleteField()
      });
    }
    await loadAnnouncements();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteAnnouncement(id) {
  if (!isSuperAdmin()) return;
  if (!confirm("Delete this announcement? This cannot be undone.")) return;
  try {
    await deleteDoc(doc(db, "announcements", id));
    await loadAnnouncements();
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById("alAddAnnouncementForm")?.addEventListener("submit", async function(e) {
  e.preventDefault();
  const title = document.getElementById("alAnnouncementTitle").value.trim();
  const body  = document.getElementById("alAnnouncementBody").value.trim();
  const btn   = this.querySelector("button[type='submit']");
  btn.disabled = true;
  setMsg("alAnnouncementPostMsg", "Posting…", "info");

  try {
    await createAnnouncement(title, body);
    setMsg("alAnnouncementPostMsg", "Announcement posted.", "success");
    this.reset();
    await loadAnnouncements();
  } catch (err) {
    setMsg("alAnnouncementPostMsg", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// Event delegation for announcement toggle/delete
document.addEventListener("click", e => {
  const toggleBtn = e.target.closest(".al-ann-toggle-btn");
  if (toggleBtn) {
    toggleAnnouncement(toggleBtn.dataset.id, toggleBtn.dataset.active === "1");
    return;
  }

  const deleteBtn = e.target.closest(".al-ann-delete-btn");
  if (deleteBtn) {
    deleteAnnouncement(deleteBtn.dataset.id);
    return;
  }
});

// ── Broadcast: Push Notifications ─────────────────────────────────────────────

const sendBroadcastFn = httpsCallable(getFunctions(app), "sendBroadcast");

document.getElementById("alNotifForm")?.addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn   = document.getElementById("alSendNotifBtn");
  const title = document.getElementById("alNotifTitle").value.trim();
  const body  = document.getElementById("alNotifBody").value.trim();

  btn.disabled = true;
  setMsg("alNotifMessage", "Sending…", "info");

  try {
    const slackWebhook = document.getElementById("alSlackBroadcast").value.trim();
    const result = await sendBroadcastFn({ title, body, slackWebhook });
    const { sent = 0, failed = 0, slacked = false } = result.data;
    const pushMsg = sent === 0
      ? "No umpires have notifications enabled yet."
      : `Sent to ${sent} umpire${sent !== 1 ? "s" : ""}${failed > 0 ? ` (${failed} failed)` : ""}.`;
    const slackMsg = slacked ? " Also posted to Slack." : "";
    setMsg("alNotifMessage", pushMsg + slackMsg, "success");
    this.reset();
  } catch (err) {
    setMsg("alNotifMessage", err.message || "Failed to send notification.", "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Broadcast: Email All Umpires ──────────────────────────────────────────────

const sendBroadcastEmailFn = httpsCallable(getFunctions(app), "sendBroadcastEmail");

document.getElementById("alEmailAllForm")?.addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn     = document.getElementById("alSendEmailBtn");
  const subject = document.getElementById("alEmailSubject").value.trim();
  const body    = document.getElementById("alEmailBody").value.trim();

  if (!confirm(`Send this email to all active umpires?\n\nSubject: ${subject}`)) return;

  btn.disabled = true;
  setMsg("alEmailMessage", "Sending…", "info");
  try {
    const result = await sendBroadcastEmailFn({ subject, body });
    const { sent = 0, failed = 0 } = result.data;
    const msg = sent === 0
      ? "No approved umpires found with email addresses."
      : `Sent to ${sent} umpire${sent !== 1 ? "s" : ""}${failed > 0 ? ` (${failed} failed)` : ""}.`;
    setMsg("alEmailMessage", msg, "success");
    this.reset();
  } catch (err) {
    setMsg("alEmailMessage", err.message || "Failed to send email.", "error");
  } finally {
    btn.disabled = false;
  }
});

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
        webhooks = d.webhooks;
      } else {
        // Migrate legacy format
        webhooks = [];
        const events = ["gameChanges","slotChanges","dayOfReminders","openSlots","cancellationRequests","incidentReports","tournamentSwaps"];
        if (d.jeff) webhooks.push({ id: "jeff", label: "Jeff (Admin)", url: d.jeff, events, divisions: [], active: true });
        if (d.ch10u) webhooks.push({ id: "ch10u", label: "10U Channel", url: d.ch10u, events: ["gameChanges","dayOfReminders"], divisions: ["10U"], active: true });
        if (d.ch12u) webhooks.push({ id: "ch12u", label: "12U Channel", url: d.ch12u, events: ["gameChanges","dayOfReminders"], divisions: ["12U"], active: true });
        if (d.dailySummary) webhooks.push({ id: "summary", label: "Daily Summary", url: d.dailySummary, events: ["dailySummary"], divisions: [], active: true });
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

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display = "none";
  loadAnnouncements();
  loadSlackWebhooks();
});
