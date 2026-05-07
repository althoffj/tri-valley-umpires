// admin.js — Overview: pending approvals, roster, admin user management
import { db } from "./firebase.js";
import { authReadyPromise, isAdmin, getCurrentUser } from "./auth.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  setDoc,
  deleteDoc,
  addDoc,
  serverTimestamp,
  query,
  orderBy,
  where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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

// ── Admin role helpers ────────────────────────────────────────────────────────

let currentAdminDoc = null;

async function loadCurrentAdminDoc() {
  const user = getCurrentUser();
  if (!user) return;
  try {
    const snap = await getDoc(doc(db, "admins", user.uid));
    currentAdminDoc = snap.exists() ? snap.data() : null;
  } catch (_) { currentAdminDoc = null; }
}

function isSuperAdmin() {
  if (!currentAdminDoc) return false;
  if (currentAdminDoc.superAdmin === true) return true;
  const roles = currentAdminDoc.roles || [];
  return roles.length === 0; // empty roles = super admin
}

// ── Announcements ─────────────────────────────────────────────────────────────

async function loadAnnouncements() {
  const listEl = document.getElementById("announcementsList");
  if (!listEl) return;

  try {
    const snap = await getDocs(
      query(collection(db, "announcements"), orderBy("createdAt", "desc"))
    );

    if (snap.empty) {
      listEl.innerHTML = '<p style="color:var(--light-text)">No announcements yet.</p>';
      return;
    }

    listEl.innerHTML = snap.docs.map(d => {
      const a  = d.data();
      const id = d.id;
      const date = a.createdAt?.toDate
        ? a.createdAt.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "—";
      const activeBadge = a.active
        ? '<span class="badge" style="background:#17351f;color:#b8f2c4">Active</span>'
        : '<span class="badge" style="background:#333;color:#999">Inactive</span>';

      return `
        <div class="document-note" style="border-left-color:${a.active ? "#7ec8f7" : "#555"};margin-bottom:12px" data-ann-id="${esc(id)}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;margin-bottom:6px">
            <strong style="color:white">${esc(a.title ?? "")}</strong>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              ${activeBadge}
              <span style="color:var(--light-text);font-size:0.8rem">${date}</span>
            </div>
          </div>
          <p style="margin:0 0 10px;white-space:pre-wrap">${esc(a.body ?? "")}</p>
          <div class="page-actions" style="margin:0">
            <button class="btn print-btn ann-toggle-btn" data-id="${esc(id)}" data-active="${a.active ? "1" : "0"}"
              style="font-size:0.8rem;padding:4px 12px">${a.active ? "Deactivate" : "Activate"}</button>
            <button class="btn ann-delete-btn" data-id="${esc(id)}"
              style="font-size:0.8rem;padding:4px 12px;background:#5a1a1a">Delete</button>
          </div>
        </div>`;
    }).join("");
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<p style="color:#ffb4b4">Error loading announcements.</p>';
  }
}

document.getElementById("addAnnouncementForm")?.addEventListener("submit", async function(e) {
  e.preventDefault();
  const title = document.getElementById("announcementTitle").value.trim();
  const body  = document.getElementById("announcementBody").value.trim();
  const btn   = this.querySelector("button[type='submit']");
  btn.disabled = true;
  setMsg("announcementPostMsg", "Posting…", "info");

  try {
    await addDoc(collection(db, "announcements"), {
      title,
      body,
      active: true,
      createdAt: serverTimestamp(),
      createdBy: getCurrentUser()?.uid ?? ""
    });
    setMsg("announcementPostMsg", "Announcement posted.", "success");
    this.reset();
    await loadAnnouncements();
  } catch (err) {
    setMsg("announcementPostMsg", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

async function toggleAnnouncement(id, currentlyActive) {
  try {
    await updateDoc(doc(db, "announcements", id), { active: !currentlyActive });
    await loadAnnouncements();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteAnnouncement(id) {
  if (!confirm("Delete this announcement? This cannot be undone.")) return;
  try {
    await deleteDoc(doc(db, "announcements", id));
    await loadAnnouncements();
  } catch (err) {
    alert(err.message);
  }
}

// ── Pending Approvals ─────────────────────────────────────────────────────────

async function loadPending() {
  const noteEl = document.getElementById("pendingNote");
  const listEl = document.getElementById("pendingList");

  try {
    const snap = await getDocs(query(
      collection(db, "umpires"),
      where("approved", "==", false),
      orderBy("submittedAt")
    ));

    if (snap.empty) {
      noteEl.textContent = "No pending approvals.";
      listEl.innerHTML = "";
      return;
    }

    noteEl.textContent = `${snap.size} umpire${snap.size !== 1 ? "s" : ""} awaiting approval.`;
    listEl.innerHTML = snap.docs.map(d => {
      const p = d.data();
      return `
        <div class="document-note" style="border-left-color:#ffcc80;margin-bottom:12px">
          <strong>${esc(p.name)}</strong> &mdash; ${esc(p.email)} &mdash; ${esc(p.phone)}<br>
          <span style="color:var(--light-text);font-size:0.85rem">
            ${esc(p.street)}, ${esc(p.city)}, ${esc(p.state)} ${esc(p.zip)}
            ${p.parentName ? ` | Parent: ${esc(p.parentName)}` : ""}
          </span>
          <div class="page-actions" style="margin-top:12px">
            <button class="btn approve-btn" data-uid="${esc(d.id)}">Approve</button>
            <button class="btn print-btn deny-btn" data-uid="${esc(d.id)}" data-name="${esc(p.name)}">Deny</button>
          </div>
          <p class="signup-message" id="pendingMsg_${esc(d.id)}"></p>
        </div>`;
    }).join("");
  } catch (err) {
    noteEl.textContent = "Failed to load pending approvals.";
    console.error(err);
  }
}

async function approveUmpire(uid) {
  const btn = document.querySelector(`.approve-btn[data-uid="${uid}"]`);
  if (btn) btn.disabled = true;
  try {
    await updateDoc(doc(db, "umpires", uid), { approved: true });
    setMsg(`pendingMsg_${uid}`, "Approved!", "success");
    setTimeout(() => loadPending(), 1200);
  } catch (err) {
    setMsg(`pendingMsg_${uid}`, err.message, "error");
    if (btn) btn.disabled = false;
  }
}

async function denyUmpire(uid, name) {
  if (!confirm(`Deny ${name}'s account?`)) return;
  try {
    await updateDoc(doc(db, "umpires", uid), { approved: false, denied: true });
    setMsg(`pendingMsg_${uid}`, "Marked as denied.", "warning");
    setTimeout(() => loadPending(), 1200);
  } catch (err) {
    setMsg(`pendingMsg_${uid}`, err.message, "error");
  }
}

// ── Roster ────────────────────────────────────────────────────────────────────

async function loadRoster() {
  const tbody = document.getElementById("rosterBody");
  try {
    const snap = await getDocs(query(collection(db, "umpires"), orderBy("lastName")));

    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:var(--light-text);text-align:center">No umpires yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = snap.docs.map(d => {
      const p = { id: d.id, ...d.data() };
      return `
        <tr>
          <td>${esc(p.name)}</td>
          <td><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></td>
          <td>${esc(p.phone || "—")}</td>
          <td style="font-size:0.85rem">${esc(p.street || "")}, ${esc(p.city || "")} ${esc(p.state || "")} ${esc(p.zip || "")}</td>
          <td>
            ${p.approved
              ? '<span class="badge badge-upcoming">Approved</span>'
              : p.denied
                ? '<span class="badge badge-cancelled">Denied</span>'
                : '<span class="badge badge-today">Pending</span>'}
          </td>
          <td>
            ${p.approved
              ? `<button class="btn print-btn revoke-btn" data-uid="${esc(p.id)}" data-name="${esc(p.name)}">Revoke</button>`
              : !p.denied
                ? `<button class="btn approve-btn" data-uid="${esc(p.id)}">Approve</button>`
                : ""}
          </td>
        </tr>`;
    }).join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:#ffb4b4">Failed to load roster.</td></tr>`;
    console.error(err);
  }
}

async function revokeUmpire(uid, name) {
  if (!confirm(`Revoke approval for ${name}?`)) return;
  try {
    await updateDoc(doc(db, "umpires", uid), { approved: false });
    loadRoster();
  } catch (err) {
    alert(err.message);
  }
}

// ── Admin Users Management ────────────────────────────────────────────────────

const ROLE_DEFS = [
  {
    key: "games",
    label: "Games",
    icon: "⚾",
    description: "Manage the game schedule — add, edit, cancel, and delete games. Sync from team calendars.",
    allowed: [
      "Add, edit, cancel, and delete games",
      "Sync games from GameChanger calendars",
      "Import city schedule",
      "Manage team calendar subscriptions",
    ],
    notAllowed: [
      "Manually assign umpires to slots (Super Admin only)",
      "Approve or deny umpire accounts",
      "Edit pay rates or system config",
    ],
  },
  {
    key: "umpires",
    label: "Umpires",
    icon: "👤",
    description: "Manage the umpire roster — approve or deny registrations and revoke access.",
    allowed: [
      "View full umpire roster",
      "Approve or deny new umpire registrations",
      "Revoke existing umpire approval",
    ],
    notAllowed: [
      "Add or remove admin users",
      "Edit pay rates or system config",
      "Manage games or facilities",
    ],
  },
  {
    key: "payroll",
    label: "Payroll",
    icon: "💵",
    description: "Access payroll summaries and mark umpire game slots as paid.",
    allowed: [
      "View payroll summary for all umpires",
      "Mark individual game slots as paid",
      "Filter by date range and umpire",
    ],
    notAllowed: [
      "Edit pay rates (requires Config role)",
      "Add or modify games",
      "Approve umpire accounts",
    ],
  },
  {
    key: "config",
    label: "Config",
    icon: "⚙️",
    description: "Edit system-wide settings including pay rates and default umpire slot types.",
    allowed: [
      "Set Plate / Field / Extra default pay rates",
      "Set default umpire slot types for game imports",
    ],
    notAllowed: [
      "Manage umpire accounts",
      "Add or delete games",
      "Manage admin users",
    ],
  },
  {
    key: "facilities",
    label: "Facilities",
    icon: "🏟",
    description: "Manage ballpark facilities, field characteristics, and field issue reports.",
    allowed: [
      "Add, edit, and delete facilities and fields",
      "Update field issue status and add admin notes",
      "View all umpire-submitted field issues",
    ],
    notAllowed: [
      "Approve umpire accounts",
      "Manage games or pay rates",
    ],
  },
  {
    key: "superAdmin",
    label: "Super Admin",
    icon: "★",
    description: "Full unrestricted access to every admin section and function.",
    allowed: [
      "All permissions above, plus:",
      "Manually assign umpires to game slots",
      "Add, edit, and remove admin users",
      "Grant or restrict roles for any admin",
    ],
    notAllowed: [],
  },
];

async function loadAdminUsers() {
  const tbody = document.getElementById("adminUsersBody");
  if (!tbody) return;

  try {
    const snap = await getDocs(collection(db, "admins"));

    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="4" style="color:var(--light-text);text-align:center">No admins found.</td></tr>`;
      return;
    }

    // For each admin, try to look up their umpire profile for name/email
    const umpireSnaps = await getDocs(collection(db, "umpires"));
    const umpireMap = {};
    umpireSnaps.forEach(d => { umpireMap[d.id] = d.data(); });

    tbody.innerHTML = snap.docs.map(d => {
      const uid  = d.id;
      const data = d.data();
      const ump  = umpireMap[uid] || {};
      const name  = ump.name  || "<em style='color:var(--light-text)'>Unknown</em>";
      const email = ump.email || "<em style='color:var(--light-text)'>—</em>";

      const isSA    = data.superAdmin === true || (data.roles || []).length === 0;
      const roles   = data.roles || [];
      const roleStr = isSA
        ? '<span class="badge" style="background:#601929;color:#fff">Super Admin</span>'
        : roles.map(r => `<span class="badge badge-extra" style="margin-right:4px">${esc(r)}</span>`).join("") || "—";

      const currentUid = getCurrentUser()?.uid;
      const isSelf = uid === currentUid;

      return `
        <tr data-admin-uid="${esc(uid)}">
          <td><span style="font-size:0.78rem;color:var(--light-text)">${esc(uid)}</span><br>${name}</td>
          <td>${email}</td>
          <td id="adminRolesCell_${esc(uid)}">${roleStr}</td>
          <td style="white-space:nowrap">
            <button class="btn print-btn edit-admin-roles-btn" data-uid="${esc(uid)}"
              style="margin-bottom:4px;display:block;width:100%">Edit Roles</button>
            ${!isSelf ? `<button class="btn delete-admin-btn" data-uid="${esc(uid)}"
              style="display:block;width:100%;background:#5a1a1a">Remove</button>` : ""}
          </td>
        </tr>`;
    }).join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:#ffb4b4">Failed to load admins.</td></tr>`;
    console.error(err);
  }
}

// ── Permission card renderer ──────────────────────────────────────────────────

function renderPermissionCards(grantedRoles, isSA, interactive = false) {
  return `<div class="perm-card-grid">` +
    ROLE_DEFS.map(def => {
      const key      = def.key;
      const granted  = isSA || (key === "superAdmin" ? isSA : grantedRoles.includes(key));
      const isSACard = key === "superAdmin";
      const dimmed   = isSA && !isSACard; // non-SA cards dimmed when SA is active

      const headerClass = granted
        ? (isSACard ? "perm-card-header perm-header-sa" : "perm-card-header perm-header-granted")
        : "perm-card-header perm-header-none";

      const statusBadge = granted
        ? `<span class="perm-badge perm-badge-granted">${isSACard && isSA ? "★ Active" : "✓ Granted"}</span>`
        : `<span class="perm-badge perm-badge-none">— Not Granted</span>`;

      const allowedHtml = def.allowed.length
        ? def.allowed.map(a => `<li class="perm-item perm-allow">✓ ${esc(a)}</li>`).join("")
        : "";
      const notAllowedHtml = def.notAllowed.length
        ? def.notAllowed.map(a => `<li class="perm-item perm-deny">✗ ${esc(a)}</li>`).join("")
        : `<li class="perm-item" style="color:var(--light-text);font-style:italic">No restrictions</li>`;

      const interactiveAttrs = interactive
        ? `role="button" tabindex="0" data-role-key="${key}"
           class="perm-card${granted ? " perm-card-granted" : ""}${isSACard ? " perm-card-sa" : ""}${dimmed ? " perm-card-dimmed" : ""} perm-card-interactive"`
        : `class="perm-card${granted ? " perm-card-granted" : ""}${isSACard ? " perm-card-sa" : ""}${dimmed ? " perm-card-dimmed" : ""}"`;

      const dimNote = dimmed
        ? `<p style="font-size:0.78rem;color:#8fc;font-style:italic;margin:4px 0 0">Included via Super Admin</p>` : "";

      return `
        <div ${interactiveAttrs}>
          <div class="${headerClass}">
            <span class="perm-card-title">${def.icon} ${esc(def.label)}</span>
            ${statusBadge}
          </div>
          <div class="perm-card-body">
            <p class="perm-desc">${esc(def.description)}</p>
            ${dimNote}
            <div class="perm-lists">
              <ul class="perm-list">
                <li class="perm-list-head">Allowed</li>
                ${allowedHtml}
              </ul>
              ${def.notAllowed.length ? `<ul class="perm-list">
                <li class="perm-list-head">Not Allowed</li>
                ${notAllowedHtml}
              </ul>` : ""}
            </div>
          </div>
        </div>`;
    }).join("") + `</div>`;
}

// ── Edit permissions modal ────────────────────────────────────────────────────

let editPermUid     = null;
let editPermGranted = new Set();
let editPermIsSA    = false;

function openEditPermissionsModal(uid) {
  editPermUid = uid;
  getDoc(doc(db, "admins", uid)).then(snap => {
    const data   = snap.exists() ? snap.data() : {};
    const roles  = data.roles || [];
    editPermIsSA = data.superAdmin === true || roles.length === 0;
    editPermGranted = new Set(editPermIsSA ? [] : roles);

    const modal = document.getElementById("editPermModal");
    const title = document.getElementById("editPermTitle");

    // Try to find name from the table
    const row  = document.querySelector(`[data-admin-uid="${uid}"]`);
    const name = row?.querySelector("td:first-child")?.textContent?.trim().split("\n").pop()?.trim() || uid;
    if (title) title.textContent = `Edit Permissions — ${name}`;

    renderEditPermModal();
    modal.style.display = "flex";
  }).catch(err => alert(err.message));
}

function renderEditPermModal() {
  const container = document.getElementById("editPermCards");
  if (!container) return;
  container.innerHTML = renderPermissionCards([...editPermGranted], editPermIsSA, true);

  // Wire card clicks
  container.querySelectorAll(".perm-card-interactive").forEach(card => {
    card.addEventListener("click",   () => togglePermCard(card.dataset.roleKey));
    card.addEventListener("keydown", e => { if (e.key === " " || e.key === "Enter") togglePermCard(card.dataset.roleKey); });
  });
}

function togglePermCard(key) {
  if (key === "superAdmin") {
    editPermIsSA = !editPermIsSA;
    if (editPermIsSA) editPermGranted.clear();
  } else {
    if (editPermIsSA) return; // SA grants everything; can't toggle individuals without removing SA
    editPermGranted.has(key) ? editPermGranted.delete(key) : editPermGranted.add(key);
  }
  renderEditPermModal();
}

async function savePermissions() {
  if (!editPermUid) return;
  const btn = document.getElementById("savePermBtn");
  btn.disabled = true;

  const roles = editPermIsSA ? [] : [...editPermGranted];
  try {
    await updateDoc(doc(db, "admins", editPermUid), {
      superAdmin: editPermIsSA,
      roles
    });
    document.getElementById("editPermModal").style.display = "none";
    await loadAdminUsers();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function removeAdmin(uid) {
  if (!confirm("Remove this admin? They will lose all admin access.")) return;
  try {
    await deleteDoc(doc(db, "admins", uid));
    await loadAdminUsers();
  } catch (err) {
    alert(err.message);
  }
}

// ── Add Admin permission state ────────────────────────────────────────────────

let addPermGranted = new Set();
let addPermIsSA    = false;

function renderAddPermCards() {
  const container = document.getElementById("addPermCards");
  if (!container) return;
  container.innerHTML = renderPermissionCards([...addPermGranted], addPermIsSA, true);
  container.querySelectorAll(".perm-card-interactive").forEach(card => {
    card.addEventListener("click",   () => toggleAddCard(card.dataset.roleKey));
    card.addEventListener("keydown", e => { if (e.key === " " || e.key === "Enter") toggleAddCard(card.dataset.roleKey); });
  });
}

function toggleAddCard(key) {
  if (key === "superAdmin") {
    addPermIsSA = !addPermIsSA;
    if (addPermIsSA) addPermGranted.clear();
  } else {
    if (addPermIsSA) return;
    addPermGranted.has(key) ? addPermGranted.delete(key) : addPermGranted.add(key);
  }
  renderAddPermCards();
}

document.getElementById("addAdminForm")?.addEventListener("submit", async function(e) {
  e.preventDefault();
  const email = document.getElementById("addAdminEmail").value.trim().toLowerCase();
  const btn   = this.querySelector("button[type='submit']");
  btn.disabled = true;
  setMsg("addAdminMessage", "Looking up umpire…", "info");

  try {
    // Look up UID from umpires collection by email
    const q = query(collection(db, "umpires"), where("email", "==", email));
    const snap = await getDocs(q);
    if (snap.empty) {
      setMsg("addAdminMessage", `No umpire found with email: ${email}`, "error");
      btn.disabled = false;
      return;
    }

    const uid = snap.docs[0].id;

    // Check if already an admin
    const existing = await getDoc(doc(db, "admins", uid));
    if (existing.exists()) {
      setMsg("addAdminMessage", "This umpire is already an admin.", "warning");
      btn.disabled = false;
      return;
    }

    const superAdminChecked = addPermIsSA;
    const selectedRoles     = superAdminChecked ? [] : [...addPermGranted];

    await setDoc(doc(db, "admins", uid), {
      superAdmin: superAdminChecked,
      roles: selectedRoles,
      addedAt: new Date().toISOString()
    });

    setMsg("addAdminMessage", `Admin added: ${email}`, "success");
    this.reset();
    addPermGranted = new Set();
    addPermIsSA    = false;
    renderAddPermCards();
    await loadAdminUsers();
  } catch (err) {
    setMsg("addAdminMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Event delegation ──────────────────────────────────────────────────────────

document.addEventListener("click", e => {
  const approveBtn = e.target.closest(".approve-btn");
  if (approveBtn) { approveUmpire(approveBtn.dataset.uid); return; }

  const denyBtn = e.target.closest(".deny-btn");
  if (denyBtn) { denyUmpire(denyBtn.dataset.uid, denyBtn.dataset.name); return; }

  const revokeBtn = e.target.closest(".revoke-btn");
  if (revokeBtn) { revokeUmpire(revokeBtn.dataset.uid, revokeBtn.dataset.name); return; }

  const editRolesBtn = e.target.closest(".edit-admin-roles-btn");
  if (editRolesBtn) { openEditPermissionsModal(editRolesBtn.dataset.uid); return; }

  const deleteAdminBtn = e.target.closest(".delete-admin-btn");
  if (deleteAdminBtn) { removeAdmin(deleteAdminBtn.dataset.uid); return; }

  const annToggle = e.target.closest(".ann-toggle-btn");
  if (annToggle) { toggleAnnouncement(annToggle.dataset.id, annToggle.dataset.active === "1"); return; }

  const annDelete = e.target.closest(".ann-delete-btn");
  if (annDelete) { deleteAnnouncement(annDelete.dataset.id); return; }

  if (e.target.id === "savePermBtn")   { savePermissions(); return; }
  if (e.target.id === "cancelPermBtn") { document.getElementById("editPermModal").style.display = "none"; return; }
  if (e.target === document.getElementById("editPermModal"))
    document.getElementById("editPermModal").style.display = "none";
});

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(async () => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display = "none";

  await loadCurrentAdminDoc();

  loadPending();
  loadRoster();

  if (isSuperAdmin()) {
    document.getElementById("announcementsSection").style.display = "";
    document.getElementById("adminUsersSection").style.display = "";
    loadAnnouncements();
    loadAdminUsers();
    renderAddPermCards();
  }
});
