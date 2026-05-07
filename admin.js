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

const ALL_ROLES = ["games", "umpires", "payroll", "config", "facilities"];

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

function openEditRolesInline(uid) {
  const cell = document.getElementById(`adminRolesCell_${uid}`);
  if (!cell) return;

  // Read current admin doc roles
  getDoc(doc(db, "admins", uid)).then(snap => {
    const data = snap.exists() ? snap.data() : {};
    const currentRoles = data.roles || [];
    const isSA = data.superAdmin === true || currentRoles.length === 0;

    const checkboxes = ALL_ROLES.map(r => `
      <label style="display:flex;align-items:center;gap:5px;font-weight:normal;margin:2px 0">
        <input type="checkbox" class="role-edit-cb" value="${r}" ${currentRoles.includes(r) ? "checked" : ""} />
        ${r}
      </label>`).join("");

    cell.innerHTML = `
      <div style="font-size:0.88rem">
        ${checkboxes}
        <label style="display:flex;align-items:center;gap:5px;font-weight:normal;margin:4px 0">
          <input type="checkbox" id="superAdminCb_${esc(uid)}" ${isSA ? "checked" : ""} />
          Super Admin
        </label>
        <div style="margin-top:8px;display:flex;gap:6px">
          <button class="btn save-admin-roles-btn" data-uid="${esc(uid)}"
            style="font-size:0.78rem;padding:4px 10px">Save</button>
          <button class="btn print-btn cancel-admin-roles-btn"
            style="font-size:0.78rem;padding:4px 10px">Cancel</button>
        </div>
      </div>`;
  }).catch(err => alert(err.message));
}

async function saveAdminRoles(uid) {
  const cell = document.getElementById(`adminRolesCell_${uid}`);
  if (!cell) return;

  const superAdminChecked = document.getElementById(`superAdminCb_${uid}`)?.checked || false;
  const selectedRoles = superAdminChecked
    ? []
    : [...cell.querySelectorAll(".role-edit-cb:checked")].map(cb => cb.value);

  try {
    await updateDoc(doc(db, "admins", uid), {
      superAdmin: superAdminChecked,
      roles: selectedRoles
    });
    await loadAdminUsers();
  } catch (err) {
    alert(err.message);
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

    const superAdminChecked = document.querySelector('[name="addAdminRole"][value="superAdmin"]')?.checked || false;
    const selectedRoles = superAdminChecked
      ? []
      : [...document.querySelectorAll('[name="addAdminRole"]:checked')]
          .map(cb => cb.value)
          .filter(v => v !== "superAdmin");

    await setDoc(doc(db, "admins", uid), {
      superAdmin: superAdminChecked,
      roles: selectedRoles,
      addedAt: new Date().toISOString()
    });

    setMsg("addAdminMessage", `Admin added: ${email}`, "success");
    this.reset();
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
  if (editRolesBtn) { openEditRolesInline(editRolesBtn.dataset.uid); return; }

  const saveRolesBtn = e.target.closest(".save-admin-roles-btn");
  if (saveRolesBtn) { saveAdminRoles(saveRolesBtn.dataset.uid); return; }

  const cancelRolesBtn = e.target.closest(".cancel-admin-roles-btn");
  if (cancelRolesBtn) { loadAdminUsers(); return; }

  const deleteAdminBtn = e.target.closest(".delete-admin-btn");
  if (deleteAdminBtn) { removeAdmin(deleteAdminBtn.dataset.uid); return; }
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
    document.getElementById("adminUsersSection").style.display = "";
    loadAdminUsers();
  }
});
