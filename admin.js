// admin.js — Overview: pending approvals, roster, admin user management
import { app, db } from "./firebase.js";
import { authReadyPromise, isAdmin, isSuperAdmin, getCurrentUser } from "./auth.js";
import { esc, fmtTime, setMsg, csvCell } from "./utils.js";

import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  setDoc,
  deleteDoc,
  query,
  orderBy,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

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
          </span>
          ${p.parentName ? `
          <div style="background:rgba(255,200,100,0.1);border:1px solid rgba(255,200,100,0.3);border-radius:4px;padding:6px 10px;margin-top:8px;font-size:0.85rem">
            👤 <strong style="color:#ffd580">Minor — Parent/Guardian</strong><br>
            ${esc(p.parentName)}
            ${p.parentPhone ? ` · <a href="tel:${esc(p.parentPhone)}" style="color:#ffd580">${esc(p.parentPhone)}</a>` : ""}
            ${p.parentEmail ? ` · <a href="mailto:${esc(p.parentEmail)}" style="color:#ffd580">${esc(p.parentEmail)}</a>` : ""}
          </div>` : ""}
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

    const superAdmin = isSuperAdmin();

    tbody.innerHTML = snap.docs.map(d => {
      const p = { id: d.id, ...d.data() };
      const isInactive = p.active === false;
      const equipList  = (p.equipment || []).join(", ") || "—";
      const maxGames   = p.maxGamesPerWeek != null ? `Max ${p.maxGamesPerWeek}/wk` : "";
      const certsList  = (p.certifications || []).join(", ");
      const noteText   = p.notes ? `<div style="color:var(--light-text);font-size:0.78rem;margin-top:2px;font-style:italic">${esc(p.notes)}</div>` : "";
      const certHtml   = certsList ? `<div style="color:#c9a0ff;font-size:0.78rem;margin-top:2px">🎓 ${esc(certsList)}</div>` : "";
      const equipHtml  = p.equipment?.length
        ? `<div style="color:var(--light-text);font-size:0.78rem;margin-top:2px">${esc(equipList)}${maxGames ? " · " + esc(maxGames) : ""}</div>`
        : (maxGames ? `<div style="color:var(--light-text);font-size:0.78rem;margin-top:2px">${esc(maxGames)}</div>` : "");
      const parentHtml = p.parentName
        ? `<div style="background:rgba(255,200,100,0.1);border:1px solid rgba(255,200,100,0.3);border-radius:4px;padding:4px 8px;margin-top:6px;font-size:0.78rem">
             👤 <strong style="color:#ffd580">Minor</strong> — Parent: ${esc(p.parentName)}
             ${p.parentPhone ? ` · <a href="tel:${esc(p.parentPhone)}" style="color:#ffd580">${esc(p.parentPhone)}</a>` : ""}
             ${p.parentEmail ? ` · <a href="mailto:${esc(p.parentEmail)}" style="color:#ffd580">${esc(p.parentEmail)}</a>` : ""}
           </div>`
        : "";

      // Status badge
      let statusBadge;
      if (isInactive) {
        statusBadge = '<span class="badge" style="background:#333;color:#aaa">Inactive</span>';
      } else if (p.approved) {
        statusBadge = '<span class="badge badge-upcoming">Approved</span>';
      } else if (p.denied) {
        statusBadge = '<span class="badge badge-cancelled">Denied</span>';
      } else {
        statusBadge = '<span class="badge badge-today">Pending</span>';
      }

      // Action buttons
      let actionBtns = "";
      if (isInactive) {
        if (superAdmin) {
          actionBtns += `<button class="btn reactivate-umpire-btn" data-uid="${esc(p.id)}" data-name="${esc(p.name)}">Reactivate</button>`;
          actionBtns += `<button class="btn print-btn delete-umpire-btn" data-uid="${esc(p.id)}" data-name="${esc(p.name)}"
            style="background:#5a1a1a;font-size:0.78rem">Delete Account</button>`;
        }
      } else if (p.approved) {
        actionBtns += `<button class="btn print-btn revoke-btn" data-uid="${esc(p.id)}" data-name="${esc(p.name)}">Revoke</button>`;
        actionBtns += `<button class="btn print-btn set-inactive-btn" data-uid="${esc(p.id)}" data-name="${esc(p.name)}"
          style="font-size:0.78rem">Set Inactive</button>`;
      } else if (!p.denied) {
        actionBtns += `<button class="btn approve-btn" data-uid="${esc(p.id)}">Approve</button>`;
      } else {
        // Denied
        if (superAdmin) {
          actionBtns += `<button class="btn print-btn delete-umpire-btn" data-uid="${esc(p.id)}" data-name="${esc(p.name)}"
            style="background:#5a1a1a;font-size:0.78rem">Delete Account</button>`;
        }
      }
      actionBtns += `<button class="btn print-btn edit-account-btn"
        data-uid="${esc(p.id)}"
        data-firstname="${esc(p.firstName || "")}"
        data-lastname="${esc(p.lastName || "")}"
        data-email="${esc(p.email || "")}"
        data-phone="${esc(p.phone || "")}"
        data-street="${esc(p.street || "")}"
        data-city="${esc(p.city || "")}"
        data-state="${esc(p.state || "")}"
        data-zip="${esc(p.zip || "")}"
        data-certifications="${esc((p.certifications || []).join(", "))}"
        data-notes="${esc(p.notes || "")}"
        data-approved="${p.approved ? "1" : "0"}"
        data-parentname="${esc(p.parentName || "")}"
        data-parentemail="${esc(p.parentEmail || "")}"
        data-parentphone="${esc(p.parentPhone || "")}"
        style="font-size:0.8rem">Edit Account</button>`;

      return `
        <tr>
          <td>${esc(p.name)}${certHtml}${equipHtml}${noteText}${parentHtml}</td>
          <td><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></td>
          <td>${esc(p.phone || "—")}</td>
          <td style="font-size:0.85rem">${esc(p.street || "")}, ${esc(p.city || "")} ${esc(p.state || "")} ${esc(p.zip || "")}</td>
          <td>${statusBadge}</td>
          <td style="display:flex;flex-direction:column;gap:6px;align-items:flex-start">${actionBtns}</td>
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

async function setUmpireInactive(uid, name) {
  if (!confirm(`Set ${name} as inactive? They will no longer be able to sign up for games. You can reactivate them at any time.`)) return;
  try {
    await updateDoc(doc(db, "umpires", uid), { active: false });
    loadRoster();
  } catch (err) {
    alert(err.message);
  }
}

async function reactivateUmpire(uid, name) {
  if (!confirm(`Reactivate ${name}? They will be able to sign up for games again.`)) return;
  try {
    await updateDoc(doc(db, "umpires", uid), { active: true });
    loadRoster();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteUmpireAccount(uid, name) {
  if (!confirm(`PERMANENTLY DELETE ${name}'s account?\n\nThis removes their profile and Firebase sign-in credentials. This cannot be undone.`)) return;
  if (!confirm(`Are you sure? This is permanent and cannot be reversed.`)) return;
  try {
    const fns      = getFunctions(app, "us-central1");
    const deleteFn = httpsCallable(fns, "deleteUmpireAccount");
    await deleteFn({ uid });
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
      "Manually assign umpires to slots",
    ],
    notAllowed: [
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
    key: "tournaments",
    label: "Tournaments",
    icon: "🏆",
    description: "Manage tournament operations — create tournaments, link games, apply rain delays, and swap umpire field assignments.",
    allowed: [
      "Create, edit, and delete tournaments",
      "Link and unlink games to tournaments",
      "Apply rain delays to all tournament games at once",
      "Swap umpire assignments between fields",
      "Update tournament status (Scheduled / Active / Rain Delay / Complete)",
    ],
    notAllowed: [
      "Approve or deny umpire accounts",
      "Edit pay rates or system config",
      "Add or remove admin users",
    ],
  },
  {
    key: "superAdmin",
    label: "Super Admin",
    icon: "★",
    description: "Full unrestricted access to every admin section and function.",
    allowed: [
      "All permissions above, plus:",
      "Add, edit, and remove admin users",
      "Grant or restrict roles for any admin",
      "Post and manage announcements",
      "Edit umpire account details",
      "Delete umpire accounts and reactivate inactive umpires",
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
      // Non-umpire admins have name/email stored directly in their admin doc
      const name  = ump.name  || data.name  || "<em style='color:var(--light-text)'>Unknown</em>";
      const email = ump.email || data.email || "<em style='color:var(--light-text)'>—</em>";

      const isSA    = data.superAdmin === true ||
        (data.superAdmin == null && (data.roles || []).length === 0);
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
    editPermIsSA = data.superAdmin === true ||
      (data.superAdmin == null && (data.roles || []).length === 0);
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
  const name  = document.getElementById("addAdminName")?.value.trim() || "";
  const btn   = this.querySelector("button[type='submit']");
  btn.disabled = true;
  setMsg("addAdminMessage", "Looking up user…", "info");

  const superAdminChecked = addPermIsSA;
  const selectedRoles     = superAdminChecked ? [] : [...addPermGranted];

  try {
    // First check if there's a matching umpire account
    const q    = query(collection(db, "umpires"), where("email", "==", email));
    const snap = await getDocs(q);

    if (!snap.empty) {
      // Umpire exists — grant them admin access directly
      const uid = snap.docs[0].id;
      const existing = await getDoc(doc(db, "admins", uid));
      if (existing.exists()) {
        setMsg("addAdminMessage", "This user is already an admin.", "warning");
        btn.disabled = false;
        return;
      }
      await setDoc(doc(db, "admins", uid), {
        superAdmin: superAdminChecked,
        roles:      selectedRoles,
        addedAt:    new Date().toISOString()
      });
      setMsg("addAdminMessage", `Admin access granted to ${email}.`, "success");
    } else {
      // No umpire profile — use Cloud Function to create or look up Firebase Auth user
      const fns           = getFunctions(app, "us-central1");
      const createAdminFn = httpsCallable(fns, "createAdminUser");
      const result        = await createAdminFn({ email, name, superAdmin: superAdminChecked, roles: selectedRoles });
      const { isNew } = result.data;
      if (isNew) {
        setMsg("addAdminMessage", `New admin account created for ${email}. A welcome email with sign-in instructions has been sent.`, "success");
      } else {
        setMsg("addAdminMessage", `Admin access granted to ${email}. A welcome email has been sent.`, "success");
      }
    }

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

// ── Pending Coach Approvals ───────────────────────────────────────────────────

async function loadCoachPending() {
  const listEl = document.getElementById("coachPendingList");
  const noteEl = document.getElementById("coachPendingNote");
  if (!listEl) return;
  try {
    const snap = await getDocs(
      query(collection(db, "coaches"), where("approved", "==", false), orderBy("registeredAt", "asc"))
    );
    if (snap.empty) {
      noteEl.textContent = "No pending coach applications.";
      listEl.innerHTML = "";
      return;
    }
    noteEl.textContent = `${snap.size} pending`;
    listEl.innerHTML = snap.docs.map(d => {
      const c = d.data();
      return `<div class="document-note" style="margin-bottom:10px">
        <strong>${esc(c.name ?? "")}</strong> — ${esc(c.teamName ?? "")} ${esc(c.division ?? "")} · ${esc(c.city ?? "")}
        <br><span style="color:var(--light-text);font-size:0.85rem">${esc(c.email ?? "")} · ${esc(c.phone ?? "")}</span>
        <div class="page-actions" style="margin-top:8px">
          <button class="btn approve-coach-btn" data-uid="${esc(d.id)}" data-name="${esc(c.name ?? "")}">Approve</button>
          <button class="btn print-btn deny-coach-btn" data-uid="${esc(d.id)}" data-name="${esc(c.name ?? "")}">Deny</button>
        </div>
      </div>`;
    }).join("");
  } catch (err) {
    noteEl.textContent = "Error loading pending coaches.";
    console.error(err);
  }
}

async function approveCoach(uid, name) {
  if (!confirm(`Approve coach ${name}?`)) return;
  try {
    await updateDoc(doc(db, "coaches", uid), { approved: true, approvedAt: serverTimestamp() });
    await loadCoachPending();
  } catch (err) { alert(err.message); }
}

async function denyCoach(uid, name) {
  if (!confirm(`Deny and delete coach application for ${name}? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, "coaches", uid));
    await loadCoachPending();
  } catch (err) { alert(err.message); }
}

// ── Event delegation ──────────────────────────────────────────────────────────

document.addEventListener("click", e => {
  const approveBtn = e.target.closest(".approve-btn");
  if (approveBtn) { approveUmpire(approveBtn.dataset.uid); return; }

  const denyBtn = e.target.closest(".deny-btn");
  if (denyBtn) { denyUmpire(denyBtn.dataset.uid, denyBtn.dataset.name); return; }

  const approveCoachBtn = e.target.closest(".approve-coach-btn");
  if (approveCoachBtn) { approveCoach(approveCoachBtn.dataset.uid, approveCoachBtn.dataset.name); return; }

  const denyCoachBtn = e.target.closest(".deny-coach-btn");
  if (denyCoachBtn) { denyCoach(denyCoachBtn.dataset.uid, denyCoachBtn.dataset.name); return; }

  const revokeBtn = e.target.closest(".revoke-btn");
  if (revokeBtn) { revokeUmpire(revokeBtn.dataset.uid, revokeBtn.dataset.name); return; }

  const setInactiveBtn = e.target.closest(".set-inactive-btn");
  if (setInactiveBtn) { setUmpireInactive(setInactiveBtn.dataset.uid, setInactiveBtn.dataset.name); return; }

  const reactivateBtn = e.target.closest(".reactivate-umpire-btn");
  if (reactivateBtn) { reactivateUmpire(reactivateBtn.dataset.uid, reactivateBtn.dataset.name); return; }

  const deleteUmpireBtn = e.target.closest(".delete-umpire-btn");
  if (deleteUmpireBtn) { deleteUmpireAccount(deleteUmpireBtn.dataset.uid, deleteUmpireBtn.dataset.name); return; }

  const editRolesBtn = e.target.closest(".edit-admin-roles-btn");
  if (editRolesBtn) { openEditPermissionsModal(editRolesBtn.dataset.uid); return; }

  const deleteAdminBtn = e.target.closest(".delete-admin-btn");
  if (deleteAdminBtn) { removeAdmin(deleteAdminBtn.dataset.uid); return; }

  if (e.target.id === "savePermBtn")   { savePermissions(); return; }
  if (e.target.id === "cancelPermBtn") { document.getElementById("editPermModal").style.display = "none"; return; }
  if (e.target === document.getElementById("editPermModal"))
    document.getElementById("editPermModal").style.display = "none";

  const editAccountBtn = e.target.closest(".edit-account-btn");
  if (editAccountBtn) { openEditAccountModal(editAccountBtn.dataset); return; }

  if (e.target.id === "saveAccountBtn")   { saveAccountEdits(); return; }
  if (e.target.id === "cancelAccountBtn") { closeEditAccountModal(); return; }
  if (e.target === document.getElementById("editAccountModal")) closeEditAccountModal();

});

// ── Edit Account Modal ────────────────────────────────────────────────────────

let editAccountUid = null;

function openEditAccountModal(data) {
  editAccountUid = data.uid;
  document.getElementById("editAccountTitle").textContent = `Edit Account`;
  document.getElementById("editFirstName").value      = data.firstname    || "";
  document.getElementById("editLastName").value       = data.lastname     || "";
  document.getElementById("editEmail").value          = data.email        || "";
  document.getElementById("editPhone").value          = data.phone        || "";
  document.getElementById("editStreet").value         = data.street       || "";
  document.getElementById("editCity").value           = data.city         || "";
  document.getElementById("editState").value          = data.state        || "";
  document.getElementById("editZip").value            = data.zip          || "";
  document.getElementById("editCertifications").value = data.certifications || "";
  document.getElementById("editNotes").value          = data.notes        || "";
  document.getElementById("editApproved").checked     = data.approved === "1";

  // Parent fields — show section if minor (parentname present)
  const isMinor = !!(data.parentname);
  document.getElementById("editIsMinor").checked       = isMinor;
  document.getElementById("editParentSection").style.display = isMinor ? "" : "none";
  document.getElementById("editParentName").value      = data.parentname  || "";
  document.getElementById("editParentEmail").value     = data.parentemail || "";
  document.getElementById("editParentPhone").value     = data.parentphone || "";

  document.getElementById("editAccountMsg").textContent = "";
  document.getElementById("editAccountMsg").className   = "signup-message";
  const modal = document.getElementById("editAccountModal");
  modal.style.display = "flex";

  // Wire minor toggle (one-time per open — remove old listener first)
  const minorCb = document.getElementById("editIsMinor");
  minorCb.onchange = () => {
    document.getElementById("editParentSection").style.display = minorCb.checked ? "" : "none";
    if (!minorCb.checked) {
      document.getElementById("editParentName").value  = "";
      document.getElementById("editParentEmail").value = "";
      document.getElementById("editParentPhone").value = "";
    }
  };
}

function closeEditAccountModal() {
  document.getElementById("editAccountModal").style.display = "none";
  editAccountUid = null;
}

async function saveAccountEdits() {
  if (!editAccountUid) return;
  const btn = document.getElementById("saveAccountBtn");
  const msg = document.getElementById("editAccountMsg");
  btn.disabled = true;
  msg.textContent = "Saving…";
  msg.className   = "signup-message";

  const certsRaw = document.getElementById("editCertifications").value.trim();
  const certifications = certsRaw
    ? certsRaw.split(",").map(s => s.trim()).filter(Boolean)
    : [];

  try {
    const functions       = getFunctions(app, "us-central1");
    const updateAccountFn = httpsCallable(functions, "updateUmpireAccount");
    const isMinor = document.getElementById("editIsMinor").checked;
    await updateAccountFn({
      uid:            editAccountUid,
      firstName:      document.getElementById("editFirstName").value.trim(),
      lastName:       document.getElementById("editLastName").value.trim(),
      email:          document.getElementById("editEmail").value.trim().toLowerCase(),
      phone:          document.getElementById("editPhone").value.trim(),
      street:         document.getElementById("editStreet").value.trim(),
      city:           document.getElementById("editCity").value.trim(),
      state:          document.getElementById("editState").value.trim().toUpperCase(),
      zip:            document.getElementById("editZip").value.trim(),
      certifications,
      notes:          document.getElementById("editNotes").value.trim(),
      approved:       document.getElementById("editApproved").checked,
      parentName:     isMinor ? document.getElementById("editParentName").value.trim()  : "",
      parentEmail:    isMinor ? document.getElementById("editParentEmail").value.trim().toLowerCase() : "",
      parentPhone:    isMinor ? document.getElementById("editParentPhone").value.trim() : ""
    });
    msg.textContent = "Saved successfully.";
    msg.className   = "signup-message success";
    await loadRoster();
    setTimeout(closeEditAccountModal, 1200);
  } catch (err) {
    console.error(err);
    msg.textContent = err.message || "Error saving changes.";
    msg.className   = "signup-message error";
    btn.disabled    = false;
  }
}

// ── Umpire Roster Export ──────────────────────────────────────────────────────

async function exportRosterCSV() {
  const btn = document.getElementById("exportRosterBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Exporting…"; }
  try {
    const snap = await getDocs(query(collection(db, "umpires"), orderBy("lastName")));
    const headers = [
      "UID", "Last Name", "First Name", "Full Name", "Email", "Phone",
      "Street", "City", "State", "ZIP",
      "Approved", "Active", "Certifications", "Equipment", "Max Games/Week",
      "Notes", "Parent Name", "Parent Email", "Parent Phone"
    ];
    const rows = [headers.map(csvCell).join(",")];
    snap.docs.forEach(d => {
      const p = d.data();
      rows.push([
        d.id,
        p.lastName  || "",
        p.firstName || "",
        p.name      || "",
        p.email     || "",
        p.phone     || "",
        p.street    || "",
        p.city      || "",
        p.state     || "",
        p.zip       || "",
        p.approved        ? "Yes" : "No",
        p.active === false ? "No"  : "Yes",
        (p.certifications || []).join("; "),
        (p.equipment      || []).join("; "),
        p.maxGamesPerWeek != null ? p.maxGamesPerWeek : "",
        p.notes       || "",
        p.parentName  || "",
        p.parentEmail || "",
        p.parentPhone || "",
      ].map(csvCell).join(","));
    });

    const csv  = rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), {
      href: url,
      download: `umpire-roster-${new Date().toISOString().slice(0, 10)}.csv`,
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Export failed: " + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "⬇ Export CSV"; }
  }
}

document.getElementById("exportRosterBtn")?.addEventListener("click", exportRosterCSV);

// ── Quick Stats ───────────────────────────────────────────────────────────────

async function loadAdminQuickStats() {
  const cardsEl  = document.getElementById("adminStatCards");
  const todayEl  = document.getElementById("adminTodayGames");
  if (!cardsEl) return;

  const today = new Date().toISOString().slice(0, 10);
  const weekEnd = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  })();

  try {
    // Load upcoming games (today through next 7 days) + all games for payroll
    const [upcomingSnap, allGamesSnap] = await Promise.all([
      getDocs(query(collection(db, "games"),
        where("date", ">=", today),
        where("date", "<=", weekEnd),
        where("needsUmpires", "==", true),
        orderBy("date"), orderBy("time"))),
      getDocs(query(collection(db, "games"),
        where("needsUmpires", "==", true))),
    ]);

    const upcoming = upcomingSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(g => !g.cancelled);
    const todayGames = upcoming.filter(g => g.date === today);

    // Today coverage
    let todayOpen = 0, todayCovered = 0;
    todayGames.forEach(g => {
      (g.umpireSlots || []).forEach(s => {
        if (s.assignedUid) todayCovered++;
        else todayOpen++;
      });
    });

    // This week open slots (excluding today — already shown separately)
    let weekOpen = 0;
    upcoming.filter(g => g.date > today).forEach(g => {
      (g.umpireSlots || []).forEach(s => { if (!s.assignedUid) weekOpen++; });
    });

    // Outstanding payroll
    let outstanding = 0;
    allGamesSnap.docs.forEach(d => {
      const g = d.data();
      if (g.cancelled && g.cancellationType !== "rainout" && g.cancellationType !== "rescheduled") return;
      (g.umpireSlots || []).forEach(s => {
        if (s.assignedUid && !s.paid) {
          outstanding += Number(s.payRate ?? g.payRate ?? 0);
        }
      });
    });

    // Render stat cards
    const todayColor = todayOpen > 0 ? "#f0a500" : todayGames.length > 0 ? "#b8f2c4" : "var(--text)";
    const weekColor  = weekOpen  > 0 ? "#f0a500" : "var(--text)";
    const payColor   = outstanding > 0 ? "#f0a500" : "var(--text)";

    cardsEl.innerHTML = [
      { label: "Today's Games", value: todayGames.length,
        sub: todayGames.length === 0 ? "None scheduled"
           : todayOpen > 0 ? `${todayOpen} slot${todayOpen !== 1 ? "s" : ""} open`
           : "All covered ✓",
        color: todayColor },
      { label: "Open This Week", value: weekOpen,
        sub: weekOpen === 0 ? "All filled ✓" : `Next 7 days`,
        color: weekColor,
        link: "admin-games.html" },
      { label: "Outstanding Pay", value: `$${outstanding.toFixed(2)}`,
        sub: outstanding === 0 ? "All paid up" : "Unpaid umpires",
        color: payColor,
        link: "admin-payroll.html" },
    ].map(c => `
      <div class="analytics-card" style="${c.link ? "cursor:pointer" : ""}"
           ${c.link ? `onclick="location.href='${c.link}'"` : ""}>
        <div class="analytics-card-value" style="color:${c.color}">${c.value}</div>
        <div class="analytics-card-label">${c.label}</div>
        <div style="font-size:0.72rem;color:var(--light-text);margin-top:2px">${c.sub}</div>
      </div>`).join("");

    // Render today's game list
    if (todayGames.length === 0) {
      todayEl.innerHTML = "";
      return;
    }

    const rows = todayGames.map(g => {
      const time = g.time ? fmtTime(g.time) : "—";
      const slots = (g.umpireSlots || []).map(s => {
        const who = s.assignedName
          ? `<span style="color:#b8f2c4">${esc(s.assignedName)}</span>`
          : `<span style="color:#f0a500">Open</span>`;
        const cls = s.type === "Plate" ? "plate" : s.type === "Field" ? "field" : "extra";
        return `<span class="badge badge-${cls}" style="font-size:0.7rem">${esc(s.type)}</span> ${who}`;
      }).join(" &nbsp; ");
      return `<tr>
        <td style="white-space:nowrap">${esc(time)}</td>
        <td>${esc(g.division || "")}</td>
        <td>${esc(g.field || "")}</td>
        <td>${slots}</td>
      </tr>`;
    }).join("");

    todayEl.innerHTML = `
      <div style="font-size:0.8rem;color:var(--light-text);font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em">Today's Games</div>
      <div class="schedule-section" style="margin-top:0">
        <table style="font-size:0.88rem">
          <thead><tr>
            <th>Time</th><th>Division</th><th>Field</th><th>Umpires</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (err) {
    console.error("Quick stats error:", err);
    cardsEl.innerHTML = `<p style="color:var(--light-text);font-size:0.85rem">Could not load stats.</p>`;
  }
}

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

  loadAdminQuickStats();
  loadPending();
  loadCoachPending();
  loadRoster();

  if (isSuperAdmin()) {
    document.getElementById("adminUsersSection").style.display = "";
    loadAdminUsers();
    renderAddPermCards();
  }
});
