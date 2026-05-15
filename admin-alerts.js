// admin-alerts.js — Announcements, Broadcast (push + email), and Slack webhooks
import { db, app } from "./firebase.js";
import { authReadyPromise, isAdmin, isSuperAdmin, getCurrentUser } from "./auth.js";
import { esc, setMsg, showToast, showConfirm } from "./utils.js";

import {
  collection,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  query,
  orderBy,
  serverTimestamp,
  deleteField
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import { initSlackWebhooks, loadSlackWebhooks } from "./slack-webhooks.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    showToast(err.message);
  }
}

async function deleteAnnouncement(id) {
  if (!isSuperAdmin()) return;
  if (!await showConfirm("Delete this announcement? This cannot be undone.")) return;
  try {
    await deleteDoc(doc(db, "announcements", id));
    await loadAnnouncements();
  } catch (err) {
    showToast(err.message);
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

  if (!await showConfirm(`Send this email to all active umpires?\n\nSubject: ${subject}`)) return;

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

  // Slack webhook config is restricted to super admins
  if (isSuperAdmin()) {
    initSlackWebhooks();
    loadSlackWebhooks();
  } else {
    // Hide the Slack tab for non-super-admins
    document.querySelector('.al-tab-btn[data-pane="alPaneSlack"]')?.remove();
    document.getElementById("alPaneSlack")?.remove();
  }
});
