// admin-users.js — Umpire directory + admin account & permissions management

import { app, db } from "./firebase.js";
import { authReadyPromise, isAdmin, isSuperAdmin, getCurrentUser } from "./auth.js";
import { esc, todayISO, setMsg, csvCell, showToast, showConfirm } from "./utils.js";

import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import {
  collection, getDocs, getDoc, doc,
  updateDoc, setDoc, deleteDoc, addDoc,
  serverTimestamp, query, orderBy, where, limit
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Admin role helpers ────────────────────────────────────────────────────────

let currentAdminDoc = null;

async function loadCurrentAdminDoc() {
  const user = getCurrentUser();
  if (!user) return;
  const snap = await getDoc(doc(db, "admins", user.uid)).catch(() => null);
  currentAdminDoc = snap?.exists() ? snap.data() : {};
}

// ── Section switching ─────────────────────────────────────────────────────────

const SECTIONS = ["umpires", "coaches", "admins", "login-history"];

function switchSection(name) {
  SECTIONS.forEach(s => {
    const el  = document.getElementById(`sec-${s}`);
    const btn = document.querySelector(`.sched-sec-btn[data-section="${s}"]`);
    if (el)  el.style.display  = s === name ? ""     : "none";
    if (btn) btn.classList.toggle("active", s === name);
  });

  if (name === "umpires" && !rosterLoaded)  { loadRoster(); loadPending(); }
  if (name === "coaches" && !coachesLoaded) { loadCoachRoster(); loadCoachPending(); coachesLoaded = true; }
  if (name === "admins"  && isSuperAdmin() && !adminsLoaded) {
    loadAdminUsers();
    renderAddPermCards();
    adminsLoaded = true;
  }
  if (name === "login-history" && !loginHistoryLoaded) { loadLoginHistory(); loginHistoryLoaded = true; }
}

document.querySelectorAll(".sched-sec-btn[data-section]").forEach(btn => {
  btn.addEventListener("click", () => switchSection(btn.dataset.section));
});

let rosterLoaded       = false;
let coachesLoaded      = false;
let adminsLoaded       = false;
let loginHistoryLoaded = false;

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
    const idx = allUmpires.findIndex(u => u.id === uid);
    if (idx !== -1) allUmpires[idx] = { ...allUmpires[idx], approved: true, denied: false };
    renderRoster();
  } catch (err) {
    setMsg(`pendingMsg_${uid}`, err.message, "error");
  }
}

async function denyUmpire(uid, name) {
  if (!await showConfirm(`Deny ${name}?`)) return;
  try {
    await updateDoc(doc(db, "umpires", uid), { denied: true });
    setMsg(`pendingMsg_${uid}`, "Marked as denied.", "warning");
    setTimeout(loadPending, 1000);
    const idx = allUmpires.findIndex(u => u.id === uid);
    if (idx !== -1) allUmpires[idx] = { ...allUmpires[idx], denied: true };
    renderRoster();
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
    const allParents = normalizeParents(p);
    const parentHtml = allParents.length
      ? `<div style="background:rgba(255,200,100,0.1);border:1px solid rgba(255,200,100,0.3);border-radius:4px;padding:4px 8px;margin-top:6px;font-size:0.78rem">
           👤 <strong style="color:#ffd580">Minor</strong>
           ${allParents.map(par => `
             <div style="margin-top:3px">
               ${esc(par.name || "—")}
               ${par.phone ? ` · <a href="tel:${esc(par.phone)}" style="color:#ffd580">${esc(par.phone)}</a>` : ""}
               ${par.email ? ` · <a href="mailto:${esc(par.email)}" style="color:#ffd580">${esc(par.email)}</a>` : ""}
             </div>`).join("")}
         </div>`
      : "";
    const emergencyHtml = p.emergencyContactName
      ? `<div style="background:rgba(255,80,80,0.07);border:1px solid rgba(255,80,80,0.2);border-radius:4px;padding:4px 8px;margin-top:4px;font-size:0.78rem">
           🆘 Emergency: ${esc(p.emergencyContactName)}
           ${p.emergencyContactPhone ? ` · <a href="tel:${esc(p.emergencyContactPhone)}" style="color:#ff9999">${esc(p.emergencyContactPhone)}</a>` : ""}
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
        style="font-size:0.78rem">Edit</button>`;
    }

    return `<tr>
      <td>${esc(p.name || `${p.firstName||""} ${p.lastName||""}`)}${certHtml}${equipHtml}${noteText}${parentHtml}${emergencyHtml}</td>
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
  if (!await showConfirm(`Revoke approval for ${name}?`)) return;
  try {
    await updateDoc(doc(db, "umpires", uid), { approved: false });
    const idx = allUmpires.findIndex(u => u.id === uid);
    if (idx !== -1) allUmpires[idx] = { ...allUmpires[idx], approved: false };
    renderRoster();
  } catch (err) { showToast(err.message); }
}
async function setUmpireInactive(uid, name) {
  if (!await showConfirm(`Set ${name} as inactive? They can no longer sign up for games. You can reactivate them at any time.`)) return;
  try {
    await updateDoc(doc(db, "umpires", uid), { active: false });
    const idx = allUmpires.findIndex(u => u.id === uid);
    if (idx !== -1) allUmpires[idx] = { ...allUmpires[idx], active: false };
    renderRoster();
  } catch (err) { showToast(err.message); }
}
async function reactivateUmpire(uid, name) {
  if (!await showConfirm(`Reactivate ${name}?`)) return;
  try {
    await updateDoc(doc(db, "umpires", uid), { active: true });
    const idx = allUmpires.findIndex(u => u.id === uid);
    if (idx !== -1) allUmpires[idx] = { ...allUmpires[idx], active: true };
    renderRoster();
  } catch (err) { showToast(err.message); }
}
async function deleteUmpireAccount(uid, name) {
  if (!await showConfirm(`PERMANENTLY DELETE ${name}'s account?\n\nThis removes their profile and Firebase sign-in credentials. This cannot be undone.`)) return;
  if (!await showConfirm(`Final confirmation: permanently delete ${name}?`)) return;
  try {
    const fns = getFunctions(app, "us-central1");
    await httpsCallable(fns, "deleteUmpireAccount")({ uid });
    allUmpires = allUmpires.filter(u => u.id !== uid);
    renderRoster();
  } catch (err) { showToast(err.message); }
}

// ── CSV Export ────────────────────────────────────────────────────────────────

async function exportRosterCSV() {
  const btn = document.getElementById("exportRosterBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Exporting…"; }
  try {
    const snap = await getDocs(query(collection(db, "umpires"), orderBy("lastName")));
    const headers = [
      "UID","Last Name","First Name","Full Name","Email","Phone",
      "Street","City","State","ZIP","Approved","Active","Certifications",
      "Equipment","Max Games/Week","Notes",
      "Emergency Contact Name","Emergency Contact Phone",
      "Parent Name","Parent Email","Parent Phone"
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
        p.emergencyContactName||"", p.emergencyContactPhone||"",
        // All parents as semicolon-delimited "Name (phone, email)" entries
        normalizeParents(p).map(par =>
          [par.name, par.phone, par.email].filter(Boolean).join(", ")
        ).join("; ")
      ].map(csvCell).join(","));
    });
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), {
      href: url,
      download: `umpire-roster-${todayISO()}.csv`
    });
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  } catch (err) { showToast("Export failed: " + err.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "⬇ Export CSV"; } }
}

document.getElementById("exportRosterBtn")?.addEventListener("click", exportRosterCSV);
document.getElementById("rosterSearch")?.addEventListener("input",    renderRoster);
document.getElementById("rosterFilterStatus")?.addEventListener("change", renderRoster);

// ── Create Umpire ─────────────────────────────────────────────────────────────

const createUmpireAccountFn = httpsCallable(getFunctions(app), "createUmpireAccount");

function openCreateUmpireModal() {
  ["cuFirstName","cuLastName","cuEmail","cuPhone"].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  setMsg("createUmpireMsg", "", "info");
  document.getElementById("createUmpireModal").style.display = "flex";
}

function closeCreateUmpireModal() {
  document.getElementById("createUmpireModal").style.display = "none";
}

document.getElementById("addUmpireBtn")?.addEventListener("click", openCreateUmpireModal);
document.getElementById("cancelCreateUmpireBtn")?.addEventListener("click", closeCreateUmpireModal);
document.getElementById("createUmpireModal")?.addEventListener("click", e => {
  if (e.target === document.getElementById("createUmpireModal")) closeCreateUmpireModal();
});

document.getElementById("saveCreateUmpireBtn")?.addEventListener("click", async () => {
  const firstName = document.getElementById("cuFirstName").value.trim();
  const lastName  = document.getElementById("cuLastName").value.trim();
  const email     = document.getElementById("cuEmail").value.trim();
  const phone     = document.getElementById("cuPhone").value.trim();
  if (!firstName || !lastName || !email) {
    setMsg("createUmpireMsg", "First name, last name, and email are required.", "error"); return;
  }
  const btn = document.getElementById("saveCreateUmpireBtn");
  btn.disabled = true;
  setMsg("createUmpireMsg", "Creating account…", "info");
  try {
    const result = await createUmpireAccountFn({ firstName, lastName, email, phone });
    const { isNew } = result.data;
    setMsg("createUmpireMsg",
      isNew ? `✓ Account created. A password-setup email has been sent to ${email}.`
            : `✓ Existing user linked as umpire.`,
      "success");
    await loadRoster();
    setTimeout(closeCreateUmpireModal, 2000);
  } catch (err) {
    setMsg("createUmpireMsg", err.message || "Failed to create account.", "error");
  } finally { btn.disabled = false; }
});

// ── Create Coach ──────────────────────────────────────────────────────────────

const createCoachAccountFn = httpsCallable(getFunctions(app), "createCoachAccount");

// Teams cache for the coach team dropdown
let _coachTeamList = [];  // [{id, name, division, city, coaches:[{uid,role}]}]
let _coachTeamMap  = {}; // { coachUid: ["Team A (12U)", ...] }

async function loadCoachTeamList() {
  if (_coachTeamList.length) return;          // already loaded
  try {
    const snap = await getDoc(doc(db, "config/teamCalendars"));
    const raw  = snap.exists() ? (snap.data().teams || []) : [];
    _coachTeamList = raw
      .filter(t => t.name)
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  } catch { /* non-fatal — select stays empty */ }
  _buildCoachTeamMap();
}

function _buildCoachTeamMap() {
  _coachTeamMap = {};
  _coachTeamList.forEach(t => {
    const label = t.name + (t.division ? ` (${t.division})` : "");
    // New format: coaches[] array
    const coaches = Array.isArray(t.coaches) ? t.coaches : [];
    coaches.forEach(c => {
      if (!c.uid) return;
      if (!_coachTeamMap[c.uid]) _coachTeamMap[c.uid] = [];
      _coachTeamMap[c.uid].push(label);
    });
    // Legacy format: coachId
    if (!coaches.length && t.coachId) {
      if (!_coachTeamMap[t.coachId]) _coachTeamMap[t.coachId] = [];
      _coachTeamMap[t.coachId].push(label);
    }
  });
}

function populateCoachTeamSelect() {
  const sel = document.getElementById("ccTeam");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— Select a team —</option>';
  _coachTeamList.forEach(t => {
    const opt = document.createElement("option");
    opt.value       = t.name;
    opt.textContent = t.name + (t.division ? " (" + t.division + ")" : "");
    opt.dataset.division = t.division || "";
    opt.dataset.city     = t.city     || "";
    sel.appendChild(opt);
  });
  if (current) sel.value = current;
}

// Auto-fill division + city when a team is chosen
document.getElementById("ccTeam")?.addEventListener("change", function() {
  const selected = this.options[this.selectedIndex];
  if (!selected || !selected.value) return;
  const divSel  = document.getElementById("ccDivision");
  const citySel = document.getElementById("ccCity");
  if (divSel  && selected.dataset.division) divSel.value  = selected.dataset.division;
  if (citySel && selected.dataset.city)     citySel.value = selected.dataset.city;
});

function updateCreateCoachSignInUI() {
  const allow      = document.getElementById("ccAllowSignIn")?.checked !== false;
  const emailInput = document.getElementById("ccEmail");
  const emailLabel = document.getElementById("ccEmailLabel");
  const noteText   = document.getElementById("ccModalNoteText");
  if (emailInput) {
    emailInput.required = allow;
    emailInput.closest("div,form")?.querySelectorAll("label[for='ccEmail']");
  }
  if (emailLabel) emailLabel.textContent = allow ? "Email *" : "Email (optional)";
  if (noteText) noteText.textContent = allow
    ? "Creates a Firebase account and an approved coach profile. A password-setup email is sent so they can sign in to the Coach Portal."
    : "Adds a coach record for contact and scheduling purposes. No sign-in account will be created.";
}

async function openCreateCoachModal() {
  ["ccFirstName","ccLastName","ccEmail","ccPhone","ccCity"].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  const divEl   = document.getElementById("ccDivision"); if (divEl)   divEl.value   = "";
  const allowEl = document.getElementById("ccAllowSignIn"); if (allowEl) allowEl.checked = true;
  await loadCoachTeamList();
  populateCoachTeamSelect();
  document.getElementById("ccTeam").value = "";
  updateCreateCoachSignInUI();
  setMsg("createCoachMsg", "", "info");
  document.getElementById("createCoachModal").style.display = "flex";
}

function closeCreateCoachModal() {
  document.getElementById("createCoachModal").style.display = "none";
}

document.getElementById("ccAllowSignIn")?.addEventListener("change", updateCreateCoachSignInUI);
document.getElementById("addCoachBtn")?.addEventListener("click", openCreateCoachModal);
document.getElementById("cancelCreateCoachBtn")?.addEventListener("click", closeCreateCoachModal);
document.getElementById("createCoachModal")?.addEventListener("click", e => {
  if (e.target === document.getElementById("createCoachModal")) closeCreateCoachModal();
});

document.getElementById("saveCreateCoachBtn")?.addEventListener("click", async () => {
  const firstName   = document.getElementById("ccFirstName").value.trim();
  const lastName    = document.getElementById("ccLastName").value.trim();
  const email       = document.getElementById("ccEmail").value.trim();
  const phone       = document.getElementById("ccPhone").value.trim();
  const teamName    = document.getElementById("ccTeam").value;
  const division    = document.getElementById("ccDivision").value;
  const city        = document.getElementById("ccCity").value;
  const allowSignIn = document.getElementById("ccAllowSignIn")?.checked !== false;

  if (!firstName || !lastName) {
    setMsg("createCoachMsg", "First name and last name are required.", "error"); return;
  }
  if (allowSignIn && !email) {
    setMsg("createCoachMsg", "Email is required when sign-in is enabled.", "error"); return;
  }

  const btn = document.getElementById("saveCreateCoachBtn");
  btn.disabled = true;

  if (allowSignIn) {
    // Create Firebase Auth account via cloud function
    setMsg("createCoachMsg", "Creating account…", "info");
    try {
      const result = await createCoachAccountFn({ firstName, lastName, email, phone, teamName, division, city });
      const { isNew, emailSent } = result.data;
      setMsg("createCoachMsg",
        isNew
          ? (emailSent
              ? `✓ Account created. A password-setup email has been sent to ${email}.`
              : `✓ Account created, but the welcome email failed to send. Share the portal link manually: ${email}`)
          : `✓ Existing user linked as coach.`,
        "success");
      await loadCoachRoster();
      setTimeout(closeCreateCoachModal, 2000);
    } catch (err) {
      setMsg("createCoachMsg", err.message || "Failed to create account.", "error");
    } finally { btn.disabled = false; }
  } else {
    // No sign-in account — write coach record directly to Firestore
    setMsg("createCoachMsg", "Saving…", "info");
    try {
      await addDoc(collection(db, "coaches"), {
        name: [firstName, lastName].filter(Boolean).join(" "),
        email, phone, teamName, division, city,
        approved: true,
        active: true,
        allowSignIn: false,
        createdAt: serverTimestamp(),
      });
      setMsg("createCoachMsg", "✓ Coach added.", "success");
      await loadCoachRoster();
      setTimeout(closeCreateCoachModal, 1500);
    } catch (err) {
      setMsg("createCoachMsg", err.message || "Failed to save.", "error");
    } finally { btn.disabled = false; }
  }
});

// ── Export Coach CSV ──────────────────────────────────────────────────────────

async function exportCoachCSV() {
  const btn = document.getElementById("exportCoachBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Exporting…"; }
  try {
    const snap = await getDocs(query(collection(db, "coaches"), orderBy("name")));
    const headers = ["UID","Name","Email","Phone","Team","Division","City","Approved","Active"];
    const rows = [headers.map(csvCell).join(",")];
    snap.docs.forEach(d => {
      const c = d.data();
      rows.push([
        d.id, c.name||"", c.email||"", c.phone||"",
        c.teamName||"", c.division||"", c.city||"",
        c.approved?"Yes":"No", c.active===false?"No":"Yes"
      ].map(csvCell).join(","));
    });
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), {
      href: url, download: `coach-directory-${todayISO()}.csv`
    });
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  } catch (err) { showToast("Export failed: " + err.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "⬇ Export CSV"; } }
}

document.getElementById("exportCoachBtn")?.addEventListener("click", exportCoachCSV);

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
    const adminSnap = await getDocs(collection(db, "admins"));

    if (adminSnap.empty) {
      tbody.innerHTML = `<tr><td colspan="4" style="color:var(--light-text);text-align:center">No admin accounts found.</td></tr>`;
      return;
    }

    // Fetch only the umpire docs for known admin UIDs — avoids reading the full collection
    const adminUids   = adminSnap.docs.map(d => d.id);
    const umpireSnaps = await Promise.all(adminUids.map(uid => getDoc(doc(db, "umpires", uid))));
    const umpireMap   = {};
    umpireSnaps.forEach((s, i) => { if (s.exists()) umpireMap[adminUids[i]] = s.data(); });

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

let editPermUid                = null;
let editPermGranted            = new Set();
let editPermIsSA               = false;
let _editPermListenerAttached  = false;

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

    // Attach delegated listener once — survives innerHTML re-renders
    if (!_editPermListenerAttached) {
      const c = document.getElementById("editPermCards");
      if (c) {
        c.addEventListener("click", e => {
          const card = e.target.closest(".perm-card-interactive");
          if (card) togglePermCard(card.dataset.roleKey);
        });
        c.addEventListener("keydown", e => {
          if (e.key !== " " && e.key !== "Enter") return;
          const card = e.target.closest(".perm-card-interactive");
          if (card) { e.preventDefault(); togglePermCard(card.dataset.roleKey); }
        });
        _editPermListenerAttached = true;
      }
    }

    document.getElementById("editPermModal").style.display = "flex";
  }).catch(err => showToast(err.message));
}

function renderEditPermModal() {
  const container = document.getElementById("editPermCards");
  if (!container) return;
  container.innerHTML = renderPermissionCards([...editPermGranted], editPermIsSA, true);
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
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function removeAdmin(uid) {
  if (!await showConfirm("Remove this admin? They will lose all admin access immediately.")) return;
  try { await deleteDoc(doc(db, "admins", uid)); await loadAdminUsers(); }
  catch (err) { showToast(err.message); }
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

// ── Parent list helpers for the edit modal ───────────────────────────────────

function normalizeParents(p) {
  if (Array.isArray(p.parents) && p.parents.length) return p.parents;
  if (p.parentName) return [{ name: p.parentName, email: p.parentEmail || "", phone: p.parentPhone || "" }];
  return [];
}

function makeEditParentRow(par = {}) {
  const S = "width:100%;padding:7px 9px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px;font-size:0.88rem;box-sizing:border-box";
  const row = document.createElement("div");
  row.className = "edit-parent-row";
  row.style.cssText = "display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:6px;margin-bottom:8px;align-items:center";
  row.innerHTML = `
    <input type="text"  class="epr-name"  placeholder="Name"             value="${(par.name  || "").replace(/"/g,'&quot;')}" style="${S}" />
    <input type="tel"   class="epr-phone" placeholder="Phone"            value="${(par.phone || "").replace(/"/g,'&quot;')}" style="${S}" />
    <input type="email" class="epr-email" placeholder="Email (optional)" value="${(par.email || "").replace(/"/g,'&quot;')}" style="${S}" />
    <button type="button" class="epr-remove" title="Remove"
      style="padding:4px 8px;background:transparent;color:#ff8a8a;border:1px solid #884444;border-radius:5px;cursor:pointer;font-size:1rem;line-height:1;flex-shrink:0">×</button>`;
  return row;
}

function renderEditParents(parents) {
  const c = document.getElementById("editParentsContainer");
  if (!c) return;
  c.innerHTML = "";
  (parents.length ? parents : [{}]).forEach(par => c.appendChild(makeEditParentRow(par)));
  updateEditRemoveBtns();
}

function updateEditRemoveBtns() {
  const rows = document.querySelectorAll("#editParentsContainer .edit-parent-row");
  rows.forEach(row => {
    row.querySelector(".epr-remove").style.visibility = rows.length > 1 ? "" : "hidden";
  });
}

function syncFirstEditParentToEmergency() {
  if (!document.getElementById("editIsMinor")?.checked) return;
  const first = document.querySelector("#editParentsContainer .edit-parent-row");
  if (!first) return;
  const name  = first.querySelector(".epr-name").value.trim();
  const phone = first.querySelector(".epr-phone").value.trim();
  if (name)  document.getElementById("editEmergencyName").value  = name;
  if (phone) document.getElementById("editEmergencyPhone").value = phone;
}

function collectEditParents() {
  return [...document.querySelectorAll("#editParentsContainer .edit-parent-row")]
    .map(row => ({
      name:  row.querySelector(".epr-name").value.trim(),
      phone: row.querySelector(".epr-phone").value.trim(),
      email: row.querySelector(".epr-email").value.trim(),
    }))
    .filter(par => par.name || par.phone);
}

// Wire parent container events once (survives modal re-opens)
document.getElementById("editParentsContainer")?.addEventListener("input", e => {
  if (e.target.matches(".epr-name, .epr-phone")) syncFirstEditParentToEmergency();
});
document.getElementById("editParentsContainer")?.addEventListener("click", e => {
  if (!e.target.matches(".epr-remove")) return;
  const rows = document.querySelectorAll("#editParentsContainer .edit-parent-row");
  if (rows.length > 1) {
    e.target.closest(".edit-parent-row").remove();
    updateEditRemoveBtns();
    syncFirstEditParentToEmergency();
  }
});
document.getElementById("editAddParentBtn")?.addEventListener("click", () => {
  document.getElementById("editParentsContainer").appendChild(makeEditParentRow());
  updateEditRemoveBtns();
});

// ── Open edit modal (lookup full profile from allUmpires by UID) ─────────────

function openEditAccountModal(uid) {
  const p = allUmpires.find(u => u.id === uid);
  if (!p) return;
  editAccountUid = uid;

  document.getElementById("editAccountTitle").textContent = "Edit Account";
  document.getElementById("editFirstName").value      = p.firstName || "";
  document.getElementById("editLastName").value       = p.lastName  || "";
  document.getElementById("editEmail").value          = p.email     || "";
  document.getElementById("editPhone").value          = p.phone     || "";
  document.getElementById("editStreet").value         = p.street    || "";
  document.getElementById("editCity").value           = p.city      || "";
  document.getElementById("editState").value          = p.state     || "";
  document.getElementById("editZip").value            = p.zip       || "";
  document.getElementById("editCertifications").value = (p.certifications || []).join(", ");
  document.getElementById("editNotes").value          = p.notes     || "";
  document.getElementById("editApproved").checked     = p.approved  === true;

  const parents = normalizeParents(p);
  const isMinor = parents.length > 0;
  document.getElementById("editIsMinor").checked                    = isMinor;
  document.getElementById("editParentSection").style.display        = isMinor ? "" : "none";
  renderEditParents(parents);

  // Emergency contact: first parent wins for minors
  const firstPar = parents[0];
  document.getElementById("editEmergencyName").value  = firstPar?.name  || p.emergencyContactName  || "";
  document.getElementById("editEmergencyPhone").value = firstPar?.phone || p.emergencyContactPhone || "";

  document.getElementById("editAccountMsg").textContent = "";
  document.getElementById("editAccountMsg").className   = "signup-message";
  document.getElementById("editAccountModal").style.display = "flex";

  document.getElementById("editIsMinor").onchange = () => {
    const checked = document.getElementById("editIsMinor").checked;
    document.getElementById("editParentSection").style.display = checked ? "" : "none";
    if (!checked) {
      renderEditParents([]);
    } else if (!document.querySelectorAll("#editParentsContainer .edit-parent-row").length) {
      renderEditParents([{}]);
    }
    syncFirstEditParentToEmergency();
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
      ...(() => {
        const eParents   = isMinor ? collectEditParents() : [];
        const firstEPar  = eParents[0] || null;
        return {
          parents:    eParents,
          parentName:  firstEPar?.name  || "",
          parentEmail: firstEPar?.email || "",
          parentPhone: firstEPar?.phone || "",
          emergencyContactName:  firstEPar?.name  || document.getElementById("editEmergencyName").value.trim(),
          emergencyContactPhone: firstEPar?.phone || document.getElementById("editEmergencyPhone").value.trim(),
        };
      })(),
    });
    msg.textContent = "Saved successfully."; msg.className = "signup-message success";
    // Update the local cache in place — avoids re-fetching the full collection
    const eParents  = isMinor ? collectEditParents() : [];
    const firstEPar = eParents[0] || null;
    const updatedFields = {
      firstName:             document.getElementById("editFirstName").value.trim(),
      lastName:              document.getElementById("editLastName").value.trim(),
      email:                 document.getElementById("editEmail").value.trim().toLowerCase(),
      phone:                 document.getElementById("editPhone").value.trim(),
      street:                document.getElementById("editStreet").value.trim(),
      city:                  document.getElementById("editCity").value.trim(),
      state:                 document.getElementById("editState").value.trim().toUpperCase(),
      zip:                   document.getElementById("editZip").value.trim(),
      certifications,
      notes:                 document.getElementById("editNotes").value.trim(),
      approved:              document.getElementById("editApproved").checked,
      parents:               eParents,
      parentName:            firstEPar?.name  || "",
      parentEmail:           firstEPar?.email || "",
      parentPhone:           firstEPar?.phone || "",
      emergencyContactName:  firstEPar?.name  || document.getElementById("editEmergencyName").value.trim(),
      emergencyContactPhone: firstEPar?.phone || document.getElementById("editEmergencyPhone").value.trim(),
    };
    updatedFields.name = [updatedFields.firstName, updatedFields.lastName].filter(Boolean).join(" ");
    const idx = allUmpires.findIndex(u => u.id === editAccountUid);
    if (idx !== -1) allUmpires[idx] = { ...allUmpires[idx], ...updatedFields };
    renderRoster();
    setTimeout(closeEditAccountModal, 1200);
  } catch (err) {
    msg.textContent = err.message || "Error saving changes."; msg.className = "signup-message error";
    btn.disabled = false;
  }
}

// ── Coaches ───────────────────────────────────────────────────────────────────

let allCoaches = [];

async function loadCoachPending() {
  const noteEl = document.getElementById("coachPendingNote");
  const listEl = document.getElementById("coachPendingList");
  const sectEl = document.getElementById("coachPendingSection");
  if (!listEl) return;
  try {
    const snap = await getDocs(query(
      collection(db, "coaches"),
      where("approved", "==", false)
    ));
    if (snap.empty) {
      if (noteEl) noteEl.textContent = "No pending coach approvals.";
      if (listEl) listEl.innerHTML   = "";
      if (sectEl) sectEl.style.display = "none";
      return;
    }
    if (sectEl) sectEl.style.display = "";
    if (noteEl) noteEl.textContent = `${snap.size} coach${snap.size !== 1 ? "es" : ""} awaiting approval.`;
    listEl.innerHTML = snap.docs.map(d => {
      const c = { id: d.id, ...d.data() };
      return `<div class="document-note" style="margin-bottom:12px">
        <strong>${esc(c.name || "")}</strong>
        <span style="color:var(--light-text);font-size:0.85rem;margin-left:8px">${esc(c.email || "")}</span>
        ${c.phone ? `<span style="color:var(--light-text);font-size:0.85rem;margin-left:8px">${esc(c.phone)}</span>` : ""}
        <br><span style="font-size:0.82rem;color:#aaa">${esc(c.teamName || "")} · ${esc(c.division || "")} · ${esc(c.city || "")}</span>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn approve-coach-pending-btn" data-uid="${esc(c.id)}" data-name="${esc(c.name || "")}">✓ Approve</button>
          <button class="btn print-btn deny-coach-pending-btn" data-uid="${esc(c.id)}" data-name="${esc(c.name || "")}"
            style="color:#ff8a8a;border-color:#ff8a8a">✗ Deny</button>
        </div>
        <p class="signup-message" id="coachPendingMsg_${esc(c.id)}" aria-live="polite"></p>
      </div>`;
    }).join("");
  } catch (err) {
    if (noteEl) noteEl.textContent = "Failed to load pending coaches.";
    console.error(err);
  }
}

async function approveCoachPending(uid, name) {
  try {
    await updateDoc(doc(db, "coaches", uid), { approved: true, approvedAt: serverTimestamp() });
    setMsg(`coachPendingMsg_${uid}`, "Approved!", "success");
    setTimeout(() => { loadCoachPending(); loadCoachRoster(); }, 1000);
  } catch (err) {
    setMsg(`coachPendingMsg_${uid}`, err.message, "error");
  }
}

async function denyCoachPending(uid, name) {
  if (!await showConfirm(`Deny and remove coach application for ${name}? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, "coaches", uid));
    setMsg(`coachPendingMsg_${uid}`, "Removed.", "warning");
    setTimeout(loadCoachPending, 800);
  } catch (err) {
    setMsg(`coachPendingMsg_${uid}`, err.message, "error");
  }
}

async function loadCoachRoster() {
  const tbody = document.getElementById("coachBody");
  try {
    const [snap] = await Promise.all([
      getDocs(query(collection(db, "coaches"), orderBy("name"))),
      loadCoachTeamList(),   // ensures _coachTeamMap is populated
    ]);
    allCoaches = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderCoachRoster();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="color:#ffb4b4">Failed to load coaches: ${esc(err.message)}</td></tr>`;
  }
}

function renderCoachRoster() {
  const tbody   = document.getElementById("coachBody");
  const countEl = document.getElementById("coachCount");
  if (!tbody) return;

  const search   = (document.getElementById("coachSearch")?.value || "").toLowerCase();
  const statusF  = document.getElementById("coachFilterStatus")?.value || "";
  const divF     = document.getElementById("coachFilterDivision")?.value || "";

  const filtered = allCoaches.filter(c => {
    if (statusF === "approved" && !(c.approved && c.active !== false))  return false;
    if (statusF === "pending"  && c.approved !== false)                 return false;
    if (statusF === "inactive" && c.active !== false)                   return false;
    if (divF && c.division !== divF)                                    return false;
    if (search) {
      const hay = `${c.name||""} ${c.email||""} ${c.teamName||""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  if (countEl) countEl.textContent = `${filtered.length} of ${allCoaches.length} coach${allCoaches.length !== 1 ? "es" : ""}`;

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--light-text);text-align:center">No coaches match.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(c => {
    const isInactive = c.active === false;
    const isPending  = c.approved === false;
    let statusBadge;
    if (isInactive)    statusBadge = `<span class="badge" style="background:#3a2a0a;color:#ffcc66">Inactive</span>`;
    else if (isPending) statusBadge = `<span class="badge" style="background:#1a2a3a;color:#7ec8f7">Pending</span>`;
    else               statusBadge = `<span class="badge" style="background:#17351f;color:#b8f2c4">Approved</span>`;

    const actions = [];
    actions.push(`<button class="btn print-btn edit-coach-btn"
      data-uid="${esc(c.id)}"
      data-name="${esc(c.name||"")}"
      data-email="${esc(c.email||"")}"
      data-phone="${esc(c.phone||"")}"
      data-team="${esc(c.teamName||"")}"
      data-division="${esc(c.division||"")}"
      data-city="${esc(c.city||"")}"
      data-approved="${c.approved ? "1" : "0"}"
      data-allow-sign-in="${c.allowSignIn === false ? "0" : "1"}"
      style="font-size:0.78rem;padding:3px 10px">Edit</button>`);

    if (!isPending && !isInactive) {
      actions.push(`<button class="btn print-btn deactivate-coach-btn" data-uid="${esc(c.id)}" data-name="${esc(c.name||"")}"
        style="font-size:0.78rem;padding:3px 10px">Deactivate</button>`);
    } else if (isInactive) {
      actions.push(`<button class="btn reactivate-coach-btn" data-uid="${esc(c.id)}" data-name="${esc(c.name||"")}"
        style="font-size:0.78rem;padding:3px 10px">Reactivate</button>`);
    }
    actions.push(`<button class="btn delete-coach-btn" data-uid="${esc(c.id)}" data-name="${esc(c.name||"")}"
      style="font-size:0.78rem;padding:3px 10px;background:#5a1a1a">Delete</button>`);

    const assignedTeams = _coachTeamMap[c.id] || [];
    const teamCell = assignedTeams.length
      ? assignedTeams.map(t => `<span style="display:inline-block;background:#1a2a1a;color:#b8f2c4;border-radius:4px;padding:1px 6px;font-size:0.78rem;margin:1px 2px 1px 0">${esc(t)}</span>`).join("")
      : `<span style="color:var(--light-text)">${esc(c.teamName||"—")}</span>`;

    return `<tr style="${isInactive ? "opacity:0.55" : ""}">
      <td><strong>${esc(c.name||"")}</strong></td>
      <td>${teamCell}</td>
      <td>${esc(c.division||"—")}</td>
      <td>${esc(c.city||"—")}</td>
      <td style="font-size:0.85rem">${esc(c.email||"")}<br><span style="color:var(--light-text)">${esc(c.phone||"")}</span></td>
      <td>${statusBadge}</td>
      <td><div style="display:flex;gap:4px;flex-wrap:wrap">${actions.join("")}</div></td>
    </tr>`;
  }).join("");
}

// Coach filters
document.getElementById("coachSearch")?.addEventListener("input", renderCoachRoster);
document.getElementById("coachFilterStatus")?.addEventListener("change", renderCoachRoster);
document.getElementById("coachFilterDivision")?.addEventListener("change", renderCoachRoster);

// Edit coach modal
let editingCoachUid = null;
let _editCoachOriginalAllowSignIn = true;  // true = has auth account, false = no auth account

function updateEditCoachSignInUI() {
  const allowEl    = document.getElementById("editCoachAllowSignIn");
  const emailInput = document.getElementById("editCoachEmail");
  const emailLabel = document.getElementById("editCoachEmailLabel");
  const noteEl     = document.getElementById("editCoachSignInNote");
  if (!allowEl) return;

  const allow = allowEl.checked;

  if (_editCoachOriginalAllowSignIn) {
    // Coach has a Firebase Auth account — email is always readonly; note explains it
    if (emailInput) { emailInput.readOnly = true; emailInput.required = false; emailInput.style.opacity = "0.6"; }
    if (emailLabel) emailLabel.textContent = "Email (account email — read-only)";
    if (noteEl) noteEl.textContent = allow
      ? "This coach has a portal account. Sign-in is enabled."
      : "Disabling sign-in will prevent this coach from logging in. Their account will remain in Firebase.";
  } else {
    // Coach has no auth account — email is editable; requirement depends on toggle
    if (emailInput) { emailInput.readOnly = false; emailInput.required = allow; emailInput.style.opacity = ""; }
    if (emailLabel) emailLabel.textContent = allow ? "Email *" : "Email (optional)";
    if (noteEl) noteEl.textContent = allow
      ? "Enabling sign-in will create a Firebase account. A password-setup email will be sent on save."
      : "No sign-in account. Coach is for contact and scheduling purposes only.";
  }
}

function openEditCoachModal(data) {
  editingCoachUid = data.uid;
  _editCoachOriginalAllowSignIn = data.allowSignIn !== "0";

  const [firstName, ...rest] = (data.name || "").split(" ");
  document.getElementById("editCoachUid").value         = data.uid;
  document.getElementById("editCoachFirstName").value   = firstName || "";
  document.getElementById("editCoachLastName").value    = rest.join(" ") || "";
  document.getElementById("editCoachEmail").value       = data.email || "";
  document.getElementById("editCoachPhone").value       = data.phone || "";
  document.getElementById("editCoachTeam").value        = data.team  || "";
  document.getElementById("editCoachDivision").value    = data.division || "";
  document.getElementById("editCoachCity").value        = data.city  || "";
  document.getElementById("editCoachApproved").checked  = data.approved === "1";

  const allowEl = document.getElementById("editCoachAllowSignIn");
  if (allowEl) allowEl.checked = _editCoachOriginalAllowSignIn;

  updateEditCoachSignInUI();

  document.getElementById("editCoachMsg").textContent   = "";
  const modal = document.getElementById("editCoachModal");
  modal.style.display = "flex";
}

function closeEditCoachModal() {
  document.getElementById("editCoachModal").style.display = "none";
  editingCoachUid = null;
}

document.getElementById("editCoachAllowSignIn")?.addEventListener("change", updateEditCoachSignInUI);

async function saveCoachEdits() {
  let docUid = editingCoachUid;
  if (!docUid) return;
  const btn  = document.getElementById("saveCoachBtn");
  const msg  = document.getElementById("editCoachMsg");
  btn.disabled = true;
  msg.textContent = "Saving…"; msg.className = "signup-message info";

  const first      = document.getElementById("editCoachFirstName").value.trim();
  const last       = document.getElementById("editCoachLastName").value.trim();
  const approved   = document.getElementById("editCoachApproved").checked;
  const allowSignIn = document.getElementById("editCoachAllowSignIn")?.checked !== false;

  // Validate: if enabling sign-in for a no-account coach, email is required
  if (!_editCoachOriginalAllowSignIn && allowSignIn) {
    const email = document.getElementById("editCoachEmail").value.trim();
    if (!email) {
      msg.textContent = "Email is required to enable sign-in."; msg.className = "signup-message error";
      btn.disabled = false;
      return;
    }
  }

  try {
    const updates = {
      name:       [first, last].filter(Boolean).join(" "),
      phone:      document.getElementById("editCoachPhone").value.trim(),
      teamName:   document.getElementById("editCoachTeam").value.trim(),
      division:   document.getElementById("editCoachDivision").value,
      city:       document.getElementById("editCoachCity").value.trim(),
      approved,
      allowSignIn,
    };
    if (approved) updates.approvedAt = serverTimestamp();

    // Only update email when coach has no auth account (auth-account email is managed by Firebase)
    if (!_editCoachOriginalAllowSignIn) {
      updates.email = document.getElementById("editCoachEmail").value.trim();
    }

    // If enabling sign-in for a previously no-account coach, create the account via cloud function
    if (!_editCoachOriginalAllowSignIn && allowSignIn) {
      msg.textContent = "Creating sign-in account…"; msg.className = "signup-message info";
      const fns = getFunctions(app, "us-central1");
      const fnResult = await httpsCallable(fns, "createCoachAccount")({
        firstName: first,
        lastName:  last,
        email:     updates.email,
        phone:     updates.phone,
        teamName:  updates.teamName,
        division:  updates.division,
        city:      updates.city,
        existingDocId: docUid,
      });
      // Function migrated coaches/{existingDocId} → coaches/{authUid}; target the new doc for updateDoc
      docUid = fnResult.data.uid;
    }

    await updateDoc(doc(db, "coaches", docUid), updates);
    msg.textContent = "Saved!"; msg.className = "signup-message success";
    await loadCoachRoster();
    setTimeout(closeEditCoachModal, 1000);
  } catch (err) {
    msg.textContent = err.message; msg.className = "signup-message error";
  } finally {
    btn.disabled = false;
  }
}

async function deactivateCoach(uid, name) {
  if (!await showConfirm(`Deactivate ${name}? They will no longer be able to sign in.`)) return;
  try {
    await updateDoc(doc(db, "coaches", uid), { active: false });
    loadCoachRoster();
  } catch (err) { showToast(err.message); }
}

async function reactivateCoach(uid, name) {
  if (!await showConfirm(`Reactivate ${name}?`)) return;
  try {
    await updateDoc(doc(db, "coaches", uid), { active: true });
    loadCoachRoster();
  } catch (err) { showToast(err.message); }
}

async function deleteCoach(uid, name) {
  if (!await showConfirm(`Permanently delete coach account for ${name}? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, "coaches", uid));
    loadCoachRoster();
    loadCoachPending();
  } catch (err) { showToast(err.message); }
}

document.getElementById("saveCoachBtn")?.addEventListener("click", saveCoachEdits);
document.getElementById("cancelCoachBtn")?.addEventListener("click", closeEditCoachModal);
document.getElementById("editCoachModal")?.addEventListener("click", e => {
  if (e.target === document.getElementById("editCoachModal")) closeEditCoachModal();
});

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
  if (editAccBtn)    { openEditAccountModal(editAccBtn.dataset.uid); return; }

  const appCoachBtn = e.target.closest(".approve-coach-pending-btn");
  if (appCoachBtn)  { approveCoachPending(appCoachBtn.dataset.uid, appCoachBtn.dataset.name); return; }

  const denyCoachBtn = e.target.closest(".deny-coach-pending-btn");
  if (denyCoachBtn) { denyCoachPending(denyCoachBtn.dataset.uid, denyCoachBtn.dataset.name); return; }

  const editCoachBtn = e.target.closest(".edit-coach-btn");
  if (editCoachBtn) { openEditCoachModal(editCoachBtn.dataset); return; }

  const deactCoachBtn = e.target.closest(".deactivate-coach-btn");
  if (deactCoachBtn){ deactivateCoach(deactCoachBtn.dataset.uid, deactCoachBtn.dataset.name); return; }

  const reactCoachBtn = e.target.closest(".reactivate-coach-btn");
  if (reactCoachBtn){ reactivateCoach(reactCoachBtn.dataset.uid, reactCoachBtn.dataset.name); return; }

  const delCoachBtn  = e.target.closest(".delete-coach-btn");
  if (delCoachBtn)  { deleteCoach(delCoachBtn.dataset.uid, delCoachBtn.dataset.name); return; }

  if (e.target.id === "savePermBtn")     { savePermissions(); return; }
  if (e.target.id === "cancelPermBtn")   { document.getElementById("editPermModal").style.display = "none"; return; }
  if (e.target.id === "saveAccountBtn")  { saveAccountEdits(); return; }
  if (e.target.id === "cancelAccountBtn"){ closeEditAccountModal(); return; }

  if (e.target === document.getElementById("editPermModal"))    document.getElementById("editPermModal").style.display    = "none";
  if (e.target === document.getElementById("editAccountModal")) closeEditAccountModal();
});

// ── Login History ─────────────────────────────────────────────────────────────

let _lhAll = [];   // full fetched set, filtered client-side

async function loadLoginHistory() {
  const tbody = document.getElementById("lhTableBody");
  const note  = document.getElementById("lhNote");
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="6" style="color:var(--light-text);text-align:center;padding:20px">Loading…</td></tr>`;
  try {
    const snap = await getDocs(query(
      collection(db, "loginHistory"),
      orderBy("loginAt", "desc"),
      limit(200)
    ));
    _lhAll = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderLoginHistory();
    if (note) note.textContent = `${_lhAll.length} most recent login${_lhAll.length !== 1 ? "s" : ""} shown.`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:#ffb4b4;text-align:center;padding:20px">Error loading login history.</td></tr>`;
    console.error(err);
  }
}

function renderLoginHistory() {
  const tbody  = document.getElementById("lhTableBody");
  const role   = document.getElementById("lhFilterRole")?.value || "";
  if (!tbody) return;

  const rows = _lhAll.filter(r => !role || r.role === role);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--light-text);text-align:center;padding:20px">No login records found.</td></tr>`;
    return;
  }

  const roleColor = r => r === "admin" ? "#c4a8f0" : r === "coach" ? "#8ab4f8" : "#86efac";
  const methodIcon = m => m === "google" ? "🔵 Google" : "📧 Email";
  const shortUA = ua => {
    if (!ua) return "—";
    if (/iPhone|iPad/.test(ua))  return "iOS";
    if (/Android/.test(ua))      return "Android";
    if (/Mac/.test(ua))          return "macOS";
    if (/Windows/.test(ua))      return "Windows";
    return ua.slice(0, 30);
  };

  tbody.innerHTML = rows.map(r => {
    const dt = r.loginAt?.toDate
      ? r.loginAt.toDate().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
      : "—";
    return `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #222;white-space:nowrap;color:var(--light-text);font-size:0.82rem">${esc(dt)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #222;font-weight:600">${esc(r.name || "—")}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #222;color:var(--light-text);font-size:0.82rem">${esc(r.email || "—")}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #222">
        <span style="font-size:0.75rem;font-weight:700;color:${roleColor(r.role)}">${esc(r.role || "—")}</span>
      </td>
      <td style="padding:8px 10px;border-bottom:1px solid #222;font-size:0.82rem">${methodIcon(r.method)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #222;color:var(--light-text);font-size:0.78rem">${esc(shortUA(r.userAgent))}</td>
    </tr>`;
  }).join("");
}

document.getElementById("lhRefreshBtn")?.addEventListener("click", loadLoginHistory);
document.getElementById("lhFilterRole")?.addEventListener("change", renderLoginHistory);

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
