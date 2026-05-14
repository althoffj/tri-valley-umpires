// admin-users.js — Umpire directory + admin account & permissions management

import { app, db } from "./firebase.js";
import { authReadyPromise, isAdmin, getCurrentUser } from "./auth.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import {
  collection, getDocs, getDoc, doc,
  updateDoc, setDoc, deleteDoc, addDoc,
  serverTimestamp, query, orderBy, where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  const snap = await getDoc(doc(db, "admins", user.uid)).catch(() => null);
  currentAdminDoc = snap?.exists() ? snap.data() : {};
}

function isSuperAdmin() {
  if (!currentAdminDoc) return false;
  if (currentAdminDoc.superAdmin === true)  return true;
  if (currentAdminDoc.superAdmin === false) return false;
  return (currentAdminDoc.roles || []).length === 0;
}

// ── Section switching ─────────────────────────────────────────────────────────

const SECTIONS = ["umpires", "admins"];

function switchSection(name) {
  SECTIONS.forEach(s => {
    const el  = document.getElementById(`sec-${s}`);
    const btn = document.querySelector(`.sched-sec-btn[data-section="${s}"]`);
    if (el)  el.style.display  = s === name ? ""     : "none";
    if (btn) btn.classList.toggle("active", s === name);
  });

  if (name === "umpires" && !rosterLoaded) { loadRoster(); loadPending(); }
  if (name === "admins"  && isSuperAdmin() && !adminsLoaded) {
    loadAdminUsers();
    renderAddPermCards();
    adminsLoaded = true;
  }
}

document.querySelectorAll(".sched-sec-btn[data-section]").forEach(btn => {
  btn.addEventListener("click", () => switchSection(btn.dataset.section));
});

let rosterLoaded = false;
let adminsLoaded = false;

// ── Pending Approvals ─────────────────────────────────────────────────────────

async function loadPending() {
  const noteEl = document.getElementById("pendingNote");
  const listEl = document.getElementById("pendingList");
  try {
    const snap = await getDocs(query(
      collection(db, "umpires"),
      where("approved", "==", false),
      where("denied",   "==", false)
    ));
    if (snap.empty) {
      noteEl.textContent = "No pending approvals.";
      listEl.innerHTML   = "";
      document.getElementById("pendingSection").style.display = "none";
      return;
    }
    noteEl.textContent = `${snap.size} umpire${snap.size !== 1 ? "s" : ""} awaiting approval.`;
    listEl.innerHTML = snap.docs.map(d => {
      const p = { id: d.id, ...d.data() };
      return `<div class="document-note" style="margin-bottom:12px">
        <strong>${esc(p.name || p.firstName + " " + p.lastName)}</strong>
        <span style="color:var(--light-text);font-size:0.85rem;margin-left:8px">${esc(p.email || "")}</span>
        ${p.phone ? `<span style="color:var(--light-text);font-size:0.85rem;margin-left:8px">${esc(p.phone)}</span>` : ""}
        <br><span style="font-size:0.82rem;color:#aaa">${esc(p.street || "")}${p.city ? ", " + p.city : ""} ${esc(p.state || "")} ${esc(p.zip || "")}</span>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn approve-btn" data-uid="${esc(p.id)}">✓ Approve</button>
          <button class="btn print-btn deny-btn" data-uid="${esc(p.id)}" data-name="${esc(p.name || "")}"
            style="color:#ff8a8a;border-color:#ff8a8a">✗ Deny</button>
        </div>
        <p class="signup-message" id="pendingMsg_${esc(p.id)}" aria-live="polite"></p>
      </div>`;
    }).join("");
  } catch (err) {
    if (noteEl) noteEl.textContent = "Failed to load pending approvals.";
  }
}

async function approveUmpire(uid) {
  try {
    await updateDoc(doc(db, "umpires", uid), { approved: true, denied: false });
    setMsg(`pendingMsg_${uid}`, "Approved!", "success");
    setTimeout(loadPending, 1000);
    loadRoster();
  } catch (err) {
    setMsg(`pendingMsg_${uid}`, err.message, "error");
  }
}

async function denyUmpire(uid, name) {
  if (!confirm(`Deny ${name}?`)) return;
  try {
    await updateDoc(doc(db, "umpires", uid), { denied: true });
    setMsg(`pendingMsg_${uid}`, "Marked as denied.", "warning");
    setTimeout(loadPending, 1000);
    loadRoster();
  } catch (err) {
    setMsg(`pendingMsg_${uid}`, err.message, "error");
  }
}

// ── Roster ────────────────────────────────────────────────────────────────────

let allUmpires   = [];
let authStatusMap = {}; // uid → { lastSignInTime, emailVerified, hasPassword, noAuthAccount }

async function loadRoster() {
  const tbody = document.getElementById("rosterBody");
  try {
    const snap = await getDocs(query(collection(db, "umpires"), orderBy("lastName")));
    allUmpires = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    rosterLoaded = true;
    renderRoster();
    // Load auth status in background — re-renders when done
    loadAuthStatus();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="color:#ffb4b4">Failed to load roster: ${esc(err.message)}</td></tr>`;
  }
}

async function loadAuthStatus() {
  try {
    const fns    = getFunctions(app, "us-central1");
    const result = await httpsCallable(fns, "getUmpireAuthStatus")({});
    authStatusMap = result.data || {};
    renderRoster();
  } catch (_) { /* non-fatal */ }
}

function renderRoster() {
  const tbody    = document.getElementById("rosterBody");
  const countEl  = document.getElementById("rosterCount");
  const search   = (document.getElementById("rosterSearch")?.value || "").toLowerCase();
  const statusF  = document.getElementById("rosterFilterStatus")?.value || "";
  const superAdmin = isSuperAdmin();

  let filtered = allUmpires.filter(p => {
    // Status filter
    if (statusF === "approved"  && !(p.approved && p.active !== false)) return false;
    if (statusF === "pending"   && !(p.approved === false && !p.denied)) return false;
    if (statusF === "denied"    && !p.denied)     return false;
    if (statusF === "inactive"  && p.active !== false) return false;
    // Text search
    if (search) {
      const haystack = `${p.name||""} ${p.firstName||""} ${p.lastName||""} ${p.email||""}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  if (countEl) countEl.textContent = `${filtered.length} of ${allUmpires.length} umpire${allUmpires.length !== 1 ? "s" : ""}`;

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--light-text);text-align:center">No umpires match.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(p => {
    const isInactive = p.active === false;
    const certsList  = (p.certifications || []).join(", ");
    const noteText   = p.notes ? `<div style="color:var(--light-text);font-size:0.78rem;margin-top:2px;font-style:italic">${esc(p.notes)}</div>` : "";
    const certHtml   = certsList ? `<div style="color:#c9a0ff;font-size:0.78rem;margin-top:2px">🎓 ${esc(certsList)}</div>` : "";
    const maxGames   = p.maxGamesPerWeek != null ? `Max ${p.maxGamesPerWeek}/wk` : "";
    const equipList  = (p.equipment || []).join(", ") || "";
    const equipHtml  = equipList
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

    // Auth status indicator (from Firebase Auth metadata)
    const auth = authStatusMap[p.id];
    let authBadge = "";
    if (auth) {
      if (auth.noAuthAccount) {
        authBadge = `<div style="font-size:0.72rem;color:#ff8a8a;margin-top:4px">⚠ No auth account</div>`;
      } else if (!auth.lastSignInTime) {
        const pwNote = auth.hasPassword ? "" : " · no password set";
        authBadge = `<div style="font-size:0.72rem;color:#ffb347;margin-top:4px">⚠ Never signed in${pwNote}</div>`;
      } else {
        const dt   = new Date(auth.lastSignInTime);
        const days = Math.floor((Date.now() - dt.getTime()) / 86400000);
        const lbl  = days === 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;
        authBadge  = `<div style="font-size:0.72rem;color:var(--light-text);margin-top:4px">Last login: ${lbl}</div>`;
      }
    }

    // Action buttons
    let actionBtns = "";
    if (isInactive) {
      if (superAdmin) {
        actionBtns += `<button class="btn reactivate-umpire-btn" data-uid="${esc(p.id)}" data-name="${esc(p.name||"")}">Reactivate</button>`;
        actionBtns += `<button class="btn print-btn delete-umpire-btn" data-uid="${esc(p.id)}" data-name="${esc(p.name||"")}"
          style="background:#5a1a1a;font-size:0.78rem">Delete</button>`;
      }
    } else if (p.approved) {
      actionBtns += `<button class="btn print-btn revoke-btn" data-uid="${esc(p.id)}" data-name="${esc(p.name||"")}">Revoke</button>`;
      actionBtns += `<button class="btn print-btn set-inactive-btn" data-uid="${esc(p.id)}" data-name="${esc(p.name||"")}"
        style="font-size:0.78rem">Set Inactive</button>`;
    } else if (!p.denied) {
      actionBtns += `<button class="btn approve-btn" data-uid="${esc(p.id)}">✓ Approve</button>`;
      actionBtns += `<button class="btn print-btn deny-btn" data-uid="${esc(p.id)}" data-name="${esc(p.name||"")}"
        style="color:#ff8a8a;border-color:#ff8a8a;font-size:0.78rem">✗ Deny</button>`;
    } else if (superAdmin) {
      actionBtns += `<button class="btn print-btn delete-umpire-btn" data-uid="${esc(p.id)}" data-name="${esc(p.name||"")}"
        style="background:#5a1a1a;font-size:0.78rem">Delete</button>`;
    }
    if (superAdmin) {
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
        style="font-size:0.78rem">Edit</button>`;
    }

    return `<tr>
      <td>${esc(p.name || `${p.firstName||""} ${p.lastName||""}`)}${certHtml}${equipHtml}${noteText}${parentHtml}</td>
      <td><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></td>
      <td>${esc(p.phone || "—")}</td>
      <td style="font-size:0.85rem">${[p.street, p.city, p.state, p.zip].filter(Boolean).join(", ") || "—"}</td>
      <td>${statusBadge}${authBadge}</td>
      <td style="display:flex;flex-direction:column;gap:6px;align-items:flex-start">${actionBtns}</td>
    </tr>`;
  }).join("");
}

// Roster action handlers
async function revokeUmpire(uid, name) {
  if (!confirm(`Revoke approval for ${name}?`)) return;
  try { await updateDoc(doc(db, "umpires", uid), { approved: false }); loadRoster(); }
  catch (err) { alert(err.message); }
}
async function setUmpireInactive(uid, name) {
  if (!confirm(`Set ${name} as inactive? They can no longer sign up for games. You can reactivate them at any time.`)) return;
  try { await updateDoc(doc(db, "umpires", uid), { active: false }); loadRoster(); }
  catch (err) { alert(err.message); }
}
async function reactivateUmpire(uid, name) {
  if (!confirm(`Reactivate ${name}?`)) return;
  try { await updateDoc(doc(db, "umpires", uid), { active: true }); loadRoster(); }
  catch (err) { alert(err.message); }
}
async function deleteUmpireAccount(uid, name) {
  if (!confirm(`PERMANENTLY DELETE ${name}'s account?\n\nThis removes their profile and Firebase sign-in credentials. This cannot be undone.`)) return;
  if (!confirm(`Final confirmation: permanently delete ${name}?`)) return;
  try {
    const fns = getFunctions(app, "us-central1");
    await httpsCallable(fns, "deleteUmpireAccount")({ uid });
    loadRoster();
  } catch (err) { alert(err.message); }
}

// ── CSV Export ────────────────────────────────────────────────────────────────

function csvCell(v) { return `"${String(v ?? "").replace(/"/g, '""')}"`; }

async function exportRosterCSV() {
  const btn = document.getElementById("exportRosterBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Exporting…"; }
  try {
    const snap = await getDocs(query(collection(db, "umpires"), orderBy("lastName")));
    const headers = [
      "UID","Last Name","First Name","Full Name","Email","Phone",
      "Street","City","State","ZIP","Approved","Active","Certifications",
      "Equipment","Max Games/Week","Notes","Parent Name","Parent Email","Parent Phone"
    ];
    const rows = [headers.map(csvCell).join(",")];
    snap.docs.forEach(d => {
      const p = d.data();
      rows.push([
        d.id, p.lastName||"", p.firstName||"", p.name||"", p.email||"", p.phone||"",
        p.street||"", p.city||"", p.state||"", p.zip||"",
        p.approved?"Yes":"No", p.active===false?"No":"Yes",
        (p.certifications||[]).join("; "), (p.equipment||[]).join("; "),
        p.maxGamesPerWeek??""  , p.notes||"",
        p.parentName||"", p.parentEmail||"", p.parentPhone||""
      ].map(csvCell).join(","));
    });
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), {
      href: url,
      download: `umpire-roster-${new Date().toISOString().slice(0,10)}.csv`
    });
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  } catch (err) { alert("Export failed: " + err.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "⬇ Export CSV"; } }
}

document.getElementById("exportRosterBtn")?.addEventListener("click", exportRosterCSV);
document.getElementById("rosterSearch")?.addEventListener("input",    renderRoster);
document.getElementById("rosterFilterStatus")?.addEventListener("change", renderRoster);

// ── Admin Users Management ────────────────────────────────────────────────────

const ROLE_DEFS = [
  {
    key: "games", label: "Games", icon: "⚾",
    description: "Manage the game schedule — add, edit, cancel, and delete games. Sync from team calendars.",
    allowed: ["Add, edit, cancel, and delete games","Sync games from GameChanger calendars","Import city schedule","Manage team calendar subscriptions","Manually assign umpires to slots"],
    notAllowed: ["Approve or deny umpire accounts","Edit pay rates or system config"],
  },
  {
    key: "umpires", label: "Umpires", icon: "👤",
    description: "Manage the umpire roster — approve or deny registrations and revoke access.",
    allowed: ["View full umpire roster","Approve or deny new umpire registrations","Revoke existing umpire approval"],
    notAllowed: ["Add or remove admin users","Edit pay rates or system config","Manage games or facilities"],
  },
  {
    key: "payroll", label: "Payroll", icon: "💵",
    description: "Access payroll summaries and mark umpire game slots as paid.",
    allowed: ["View payroll summary for all umpires","Mark individual game slots as paid","Filter by date range and umpire"],
    notAllowed: ["Edit pay rates (requires Config role)","Add or modify games","Approve umpire accounts"],
  },
  {
    key: "config", label: "Config", icon: "⚙️",
    description: "Edit system-wide settings including pay rates and default umpire slot types.",
    allowed: ["Set Plate / Field / Extra default pay rates","Set default umpire slot types for game imports"],
    notAllowed: ["Manage umpire accounts","Add or delete games","Manage admin users"],
  },
  {
    key: "facilities", label: "Facilities", icon: "🏟",
    description: "Manage ballpark facilities, field characteristics, and field issue reports.",
    allowed: ["Add, edit, and delete facilities and fields","Update field issue status and add admin notes","View all umpire-submitted field issues"],
    notAllowed: ["Approve umpire accounts","Manage games or pay rates"],
  },
  {
    key: "tournaments", label: "Tournaments", icon: "🏆",
    description: "Manage tournament operations — create tournaments, link games, and swap umpire assignments.",
    allowed: ["Create, edit, and delete tournaments","Link and unlink games to tournaments","Apply rain delays","Swap umpire assignments between fields","Update tournament status"],
    notAllowed: ["Approve or deny umpire accounts","Edit pay rates or system config","Add or remove admin users"],
  },
  {
    key: "superAdmin", label: "Super Admin", icon: "★",
    description: "Full unrestricted access to every admin section and function.",
    allowed: ["All permissions above, plus:","Add, edit, and remove admin users","Grant or restrict roles for any admin","Post and manage announcements","Edit umpire account details","Delete umpire accounts and reactivate inactive umpires"],
    notAllowed: [],
  },
];

async function loadAdminUsers() {
  const tbody = document.getElementById("adminUsersBody");
  if (!tbody) return;
  try {
    // Fetch admins + all umpire profiles in parallel (one query each, not N+1)
    const [adminSnap, umpireSnap] = await Promise.all([
      getDocs(collection(db, "admins")),
      getDocs(collection(db, "umpires")),
    ]);

    if (adminSnap.empty) {
      tbody.innerHTML = `<tr><td colspan="4" style="color:var(--light-text);text-align:center">No admin accounts found.</td></tr>`;
      return;
    }

    // Build umpire lookup map
    const umpireMap = {};
    umpireSnap.forEach(d => { umpireMap[d.id] = d.data(); });

    const currentUid = getCurrentUser()?.uid;

    tbody.innerHTML = adminSnap.docs.map(d => {
      const uid  = d.id;
      const data = d.data();
      const ump  = umpireMap[uid] || {};

      // Name: prefer umpire profile, fallback to value stored on admin doc (createAdminUser stores it there)
      const name  = ump.name  || (ump.firstName ? `${ump.firstName} ${ump.lastName||""}`.trim() : "")
                    || data.name  || `<em style="color:var(--light-text)">Unknown</em>`;
      // Email: same fallback chain
      const email = ump.email || data.email || `<em style="color:var(--light-text)">—</em>`;

      const isSA = data.superAdmin === true || (data.superAdmin == null && (data.roles || []).length === 0);
      const roles = data.roles || [];
      const roleBadges = isSA
        ? `<span class="badge" style="background:#601929;color:#fff">★ Super Admin</span>`
        : roles.map(r => `<span class="badge badge-extra" style="margin-right:4px">${esc(r)}</span>`).join("") || `<span style="color:var(--light-text);font-size:0.82rem">No roles</span>`;

      const isSelf = uid === currentUid;

      return `<tr data-admin-uid="${esc(uid)}">
        <td>
          <div>${name}</div>
          <div style="font-size:0.72rem;color:var(--light-text);font-family:monospace;margin-top:2px">${esc(uid)}</div>
        </td>
        <td style="font-size:0.85rem">${email}</td>
        <td>${roleBadges}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-start">
          <button class="btn print-btn edit-admin-roles-btn" data-uid="${esc(uid)}" style="font-size:0.8rem">Edit Permissions</button>
          ${!isSelf ? `<button class="btn print-btn delete-admin-btn" data-uid="${esc(uid)}" style="font-size:0.78rem;color:#ff8a8a;border-color:#ff8a8a">Remove</button>` : `<span style="font-size:0.75rem;color:var(--light-text)">(you)</span>`}
        </td>
      </tr>`;
    }).join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:#ffb4b4">Failed to load admins: ${esc(err.message)}</td></tr>`;
  }
}

// ── Permission card renderer ──────────────────────────────────────────────────

function renderPermissionCards(grantedRoles, isSA, interactive = false) {
  return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">` +
    ROLE_DEFS.map(def => {
      const key       = def.key;
      const isSACard  = key === "superAdmin";
      const granted   = isSA || (isSACard ? isSA : grantedRoles.includes(key));
      const tabIdx    = interactive ? 0 : -1;
      return `<div class="perm-card${interactive ? " perm-card-interactive" : ""}${granted ? " perm-card-granted" : ""}"
          data-role-key="${esc(key)}"
          ${interactive ? `role="checkbox" aria-checked="${granted}" tabindex="${tabIdx}"` : ""}>
          <div class="perm-card-header">
            <span class="perm-card-icon">${def.icon}</span>
            <span class="perm-card-label">${esc(def.label)}</span>
            ${granted ? `<span class="perm-card-check">✓</span>` : ""}
          </div>
          <div class="perm-card-desc">${esc(def.description)}</div>
          ${def.allowed.length ? `<ul class="perm-card-list allowed">${def.allowed.map(a => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
          ${def.notAllowed.length ? `<ul class="perm-card-list denied">${def.notAllowed.map(a => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
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
    editPermIsSA    = data.superAdmin === true || (data.superAdmin == null && roles.length === 0);
    editPermGranted = new Set(editPermIsSA ? [] : roles);

    const row  = document.querySelector(`[data-admin-uid="${uid}"]`);
    const name = row?.querySelector("td:first-child")?.textContent?.trim() || uid;
    const titleEl = document.getElementById("editPermTitle");
    if (titleEl) titleEl.textContent = `Edit Permissions — ${name}`;

    renderEditPermModal();
    document.getElementById("editPermModal").style.display = "flex";
  }).catch(err => alert(err.message));
}

function renderEditPermModal() {
  const container = document.getElementById("editPermCards");
  if (!container) return;
  container.innerHTML = renderPermissionCards([...editPermGranted], editPermIsSA, true);
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
    if (editPermIsSA) return;
    editPermGranted.has(key) ? editPermGranted.delete(key) : editPermGranted.add(key);
  }
  renderEditPermModal();
}

async function savePermissions() {
  if (!editPermUid) return;
  const btn = document.getElementById("savePermBtn");
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "admins", editPermUid), {
      superAdmin: editPermIsSA,
      roles: editPermIsSA ? [] : [...editPermGranted]
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
  if (!confirm("Remove this admin? They will lose all admin access immediately.")) return;
  try { await deleteDoc(doc(db, "admins", uid)); await loadAdminUsers(); }
  catch (err) { alert(err.message); }
}

// ── Add Admin ─────────────────────────────────────────────────────────────────

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

  try {
    const q    = query(collection(db, "umpires"), where("email", "==", email));
    const snap = await getDocs(q);

    if (!snap.empty) {
      const uid      = snap.docs[0].id;
      const existing = await getDoc(doc(db, "admins", uid));
      if (existing.exists()) {
        setMsg("addAdminMessage", "This user is already an admin.", "warning");
        btn.disabled = false;
        return;
      }
      await setDoc(doc(db, "admins", uid), {
        superAdmin: addPermIsSA,
        roles:      addPermIsSA ? [] : [...addPermGranted],
        addedAt:    new Date().toISOString()
      });
      setMsg("addAdminMessage", `Admin access granted to ${email}.`, "success");
    } else {
      const fns    = getFunctions(app, "us-central1");
      const result = await httpsCallable(fns, "createAdminUser")({ email, name, superAdmin: addPermIsSA, roles: addPermIsSA ? [] : [...addPermGranted] });
      const { isNew } = result.data;
      setMsg("addAdminMessage",
        isNew ? `New admin account created for ${email}. A welcome email with sign-in instructions has been sent.`
              : `Admin access granted to ${email}. A welcome email has been sent.`,
        "success");
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
  document.getElementById("editApproved").checked     = data.approved     === "1";

  const isMinor = !!(data.parentname);
  document.getElementById("editIsMinor").checked                       = isMinor;
  document.getElementById("editParentSection").style.display           = isMinor ? "" : "none";
  document.getElementById("editParentName").value                      = data.parentname  || "";
  document.getElementById("editParentEmail").value                     = data.parentemail || "";
  document.getElementById("editParentPhone").value                     = data.parentphone || "";
  document.getElementById("editAccountMsg").textContent                = "";
  document.getElementById("editAccountMsg").className                  = "signup-message";
  document.getElementById("editAccountModal").style.display            = "flex";

  document.getElementById("editIsMinor").onchange = () => {
    const checked = document.getElementById("editIsMinor").checked;
    document.getElementById("editParentSection").style.display = checked ? "" : "none";
    if (!checked) {
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
  msg.textContent = "Saving…"; msg.className = "signup-message";

  const certsRaw = document.getElementById("editCertifications").value.trim();
  const certifications = certsRaw ? certsRaw.split(",").map(s => s.trim()).filter(Boolean) : [];
  const isMinor = document.getElementById("editIsMinor").checked;

  try {
    await httpsCallable(getFunctions(app, "us-central1"), "updateUmpireAccount")({
      uid:           editAccountUid,
      firstName:     document.getElementById("editFirstName").value.trim(),
      lastName:      document.getElementById("editLastName").value.trim(),
      email:         document.getElementById("editEmail").value.trim().toLowerCase(),
      phone:         document.getElementById("editPhone").value.trim(),
      street:        document.getElementById("editStreet").value.trim(),
      city:          document.getElementById("editCity").value.trim(),
      state:         document.getElementById("editState").value.trim().toUpperCase(),
      zip:           document.getElementById("editZip").value.trim(),
      certifications,
      notes:         document.getElementById("editNotes").value.trim(),
      approved:      document.getElementById("editApproved").checked,
      parentName:    isMinor ? document.getElementById("editParentName").value.trim()              : "",
      parentEmail:   isMinor ? document.getElementById("editParentEmail").value.trim().toLowerCase(): "",
      parentPhone:   isMinor ? document.getElementById("editParentPhone").value.trim()             : "",
    });
    msg.textContent = "Saved successfully."; msg.className = "signup-message success";
    await loadRoster();
    setTimeout(closeEditAccountModal, 1200);
  } catch (err) {
    msg.textContent = err.message || "Error saving changes."; msg.className = "signup-message error";
    btn.disabled = false;
  }
}

// ── Event delegation ──────────────────────────────────────────────────────────

document.addEventListener("click", e => {
  const approveBtn    = e.target.closest(".approve-btn");
  if (approveBtn)    { approveUmpire(approveBtn.dataset.uid); return; }

  const denyBtn       = e.target.closest(".deny-btn");
  if (denyBtn)       { denyUmpire(denyBtn.dataset.uid, denyBtn.dataset.name); return; }

  const revokeBtn     = e.target.closest(".revoke-btn");
  if (revokeBtn)     { revokeUmpire(revokeBtn.dataset.uid, revokeBtn.dataset.name); return; }

  const inactiveBtn   = e.target.closest(".set-inactive-btn");
  if (inactiveBtn)   { setUmpireInactive(inactiveBtn.dataset.uid, inactiveBtn.dataset.name); return; }

  const reactivateBtn = e.target.closest(".reactivate-umpire-btn");
  if (reactivateBtn) { reactivateUmpire(reactivateBtn.dataset.uid, reactivateBtn.dataset.name); return; }

  const deleteUmpBtn  = e.target.closest(".delete-umpire-btn");
  if (deleteUmpBtn)  { deleteUmpireAccount(deleteUmpBtn.dataset.uid, deleteUmpBtn.dataset.name); return; }

  const editRolesBtn  = e.target.closest(".edit-admin-roles-btn");
  if (editRolesBtn)  { openEditPermissionsModal(editRolesBtn.dataset.uid); return; }

  const delAdminBtn   = e.target.closest(".delete-admin-btn");
  if (delAdminBtn)   { removeAdmin(delAdminBtn.dataset.uid); return; }

  const editAccBtn    = e.target.closest(".edit-account-btn");
  if (editAccBtn)    { openEditAccountModal(editAccBtn.dataset); return; }

  if (e.target.id === "savePermBtn")     { savePermissions(); return; }
  if (e.target.id === "cancelPermBtn")   { document.getElementById("editPermModal").style.display = "none"; return; }
  if (e.target.id === "saveAccountBtn")  { saveAccountEdits(); return; }
  if (e.target.id === "cancelAccountBtn"){ closeEditAccountModal(); return; }

  if (e.target === document.getElementById("editPermModal"))    document.getElementById("editPermModal").style.display    = "none";
  if (e.target === document.getElementById("editAccountModal")) closeEditAccountModal();
});

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(async () => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display     = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display     = "none";

  await loadCurrentAdminDoc();

  // Default section: Umpires
  switchSection("umpires");

  // Hide Admins tab for non-super-admins
  if (!isSuperAdmin()) {
    const adminBtn = document.querySelector('.sched-sec-btn[data-section="admins"]');
    if (adminBtn) adminBtn.style.display = "none";
  }
});
