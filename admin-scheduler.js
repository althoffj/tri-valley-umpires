// admin-scheduler.js — Scheduling Assistant: teams, calendar/CSV import, calendar view, practices
import { db, app }                       from "./firebase.js";
import { authReadyPromise, isAdmin }      from "./auth.js";
import { getFunctions, httpsCallable }    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import {
  collection, getDocs, getDoc, addDoc, setDoc, updateDoc, deleteDoc,
  doc, query, where, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const fns       = getFunctions(app);
const previewFn = httpsCallable(fns, "previewCalendarImport");
const commitFn  = httpsCallable(fns, "commitCalendarImport");

// ── State ─────────────────────────────────────────────────────────────────────

let teams        = [];   // [{name, division, city, icsUrl, color, needsUmpireForHome}]
let activeSection = "teams";
let importMode   = "calendar";

// Import preview state
let readyItems     = [];
let conflictItems  = [];
let duplicateItems = [];
let warningItems   = [];
let activeTab      = "ready";

// Calendar state
let calYear, calMonth;
const now = new Date();
calYear  = now.getFullYear();
calMonth = now.getMonth(); // 0-based

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}/${y}`;
}

function fmt12(t) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,"0")} ${h >= 12 ? "PM" : "AM"}`;
}

function issueBadge(issue) {
  return `<span class="sched-issue-badge" style="background:${issue.color}22;color:${issue.color};border-color:${issue.color}44">${esc(issue.label)}</span>`;
}

function sourceLabel(game) {
  const icon = game.sourceType === "google" ? "📅" : game.source === "csv" ? "📄" : "🎮";
  return `<span style="color:var(--light-text);font-size:0.8rem">${icon} ${esc(game.sourceLabel || game.source || "")}</span>`;
}

function gameRowCells(game) {
  return `
    <td>${esc(fmtDate(game.date))}</td>
    <td>${esc(fmt12(game.time))}</td>
    <td>${esc(game.field || "—")}</td>
    <td>${esc(game.division || "—")}</td>
    <td>${esc(game.city || "—")}</td>
    <td>${esc(game.homeTeam && game.awayTeam
      ? `${game.awayTeam} @ ${game.homeTeam}` : game.homeTeam || game.awayTeam || "—")}</td>
    <td>${sourceLabel(game)}</td>`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

/** Find team color by matching homeTeam or awayTeam name */
function teamColor(game) {
  if (!teams.length) return "var(--accent)";
  const lc = (s) => (s || "").toLowerCase();
  const home = lc(game.homeTeam);
  const tm   = teams.find(t =>
    home && (lc(t.name).includes(home) || home.includes(lc(t.name)))
  ) || teams.find(t => {
    const away = lc(game.awayTeam);
    return away && (lc(t.name).includes(away) || away.includes(lc(t.name)));
  });
  return tm ? tm.color : "var(--accent)";
}

/** Return team object whose home game this is, or null */
function findHomeTeam(homeTeamName) {
  if (!homeTeamName) return null;
  const lc = (s) => (s || "").toLowerCase();
  return teams.find(t => {
    const tn = lc(t.name);
    const ht = lc(homeTeamName);
    return tn.includes(ht) || ht.includes(tn);
  }) || null;
}

// ── Section navigation ────────────────────────────────────────────────────────

function switchSection(section) {
  activeSection = section;
  document.querySelectorAll(".sched-sec-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.section === section);
  });
  ["teams","import","calendar","practices"].forEach(s => {
    const el = document.getElementById(`sec-${s}`);
    if (el) el.style.display = s === section ? "" : "none";
  });
  // Lazy load section data
  if (section === "calendar") loadCalendar();
  if (section === "practices") loadPractices();
}

document.querySelectorAll(".sched-sec-btn").forEach(btn => {
  btn.addEventListener("click", () => switchSection(btn.dataset.section));
});

// ── Import mode toggle ────────────────────────────────────────────────────────

document.querySelectorAll(".import-mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    importMode = btn.dataset.mode;
    document.querySelectorAll(".import-mode-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.mode === importMode);
      b.classList.toggle("print-btn", b.dataset.mode !== importMode);
    });
    document.getElementById("importModeCalendar").style.display = importMode === "calendar" ? "" : "none";
    document.getElementById("importModeCsv").style.display      = importMode === "csv"      ? "" : "none";
    // Reset preview
    document.getElementById("previewSummary").style.display = "none";
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  TEAMS SECTION
// ══════════════════════════════════════════════════════════════════════════════

async function loadTeams() {
  try {
    const snap = await getDoc(doc(db, "config/teamCalendars"));
    teams = snap.exists() ? (snap.data().teams || []) : [];
  } catch {
    teams = [];
  }
  renderTeamList();
}

async function saveTeams(showMsg) {
  await setDoc(doc(db, "config/teamCalendars"), { teams }, { merge: true });
  if (showMsg) {
    const msg = document.getElementById("teamFormMsg");
    msg.textContent = "✓ Saved.";
    msg.className = "signup-message success";
    setTimeout(() => { msg.textContent = ""; msg.className = "signup-message"; }, 2000);
  }
}

function renderTeamList() {
  const el = document.getElementById("teamList");
  if (!el) return;
  if (!teams.length) {
    el.innerHTML = `<p style="color:var(--light-text);margin-bottom:12px">No teams configured yet. Add your first team below.</p>`;
    return;
  }
  el.innerHTML = teams.map((t, i) => `
    <div class="team-row">
      <span class="team-color-swatch" style="background:${esc(t.color || "#601929")}"></span>
      <span class="team-row-name">${esc(t.name)}</span>
      <span class="team-row-meta">${esc(t.division || "")}${t.city ? " · " + esc(t.city) : ""}</span>
      ${t.needsUmpireForHome ? `<span class="team-needs-ump">⚾ Needs umpire</span>` : ""}
      ${t.icsUrl ? `<span style="color:var(--light-text);font-size:0.78rem">📅 iCal linked</span>` : ""}
      <div style="margin-left:auto;display:flex;gap:6px">
        <button type="button" class="btn print-btn team-edit-btn" data-idx="${i}" style="padding:4px 10px;font-size:0.82rem">Edit</button>
        <button type="button" class="btn print-btn team-delete-btn" data-idx="${i}" style="padding:4px 10px;font-size:0.82rem;color:#ff8a8a;border-color:#ff8a8a">Delete</button>
      </div>
    </div>`).join("");

  el.querySelectorAll(".team-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => startEditTeam(parseInt(btn.dataset.idx)));
  });
  el.querySelectorAll(".team-delete-btn").forEach(btn => {
    btn.addEventListener("click", () => deleteTeam(parseInt(btn.dataset.idx)));
  });
}

function startEditTeam(idx) {
  const t = teams[idx];
  document.getElementById("teamEditIndex").value = idx;
  document.getElementById("tName").value         = t.name || "";
  document.getElementById("tDivision").value     = t.division || "";
  document.getElementById("tCity").value         = t.city || "";
  document.getElementById("tColor").value        = t.color || "#601929";
  document.getElementById("tIcsUrl").value       = t.icsUrl || "";
  document.getElementById("tNeedsUmpire").checked = !!t.needsUmpireForHome;
  document.getElementById("teamFormTitle").textContent = "Edit Team";
  document.getElementById("teamFormSubmitBtn").textContent = "Save Changes";
  document.getElementById("teamFormCancelBtn").style.display = "";
  document.getElementById("tName").focus();
  document.getElementById("teamFormWrap").scrollIntoView({ behavior: "smooth" });
}

function cancelEditTeam() {
  document.getElementById("teamEditIndex").value = "";
  document.getElementById("teamForm").reset();
  document.getElementById("tColor").value = "#601929";
  document.getElementById("teamFormTitle").textContent = "Add Team";
  document.getElementById("teamFormSubmitBtn").textContent = "Add Team";
  document.getElementById("teamFormCancelBtn").style.display = "none";
  document.getElementById("teamFormMsg").textContent = "";
  document.getElementById("teamFormMsg").className = "signup-message";
}

async function deleteTeam(idx) {
  if (!confirm(`Delete team "${teams[idx].name}"?`)) return;
  teams.splice(idx, 1);
  renderTeamList();
  await saveTeams(false);
}

document.getElementById("teamFormCancelBtn").addEventListener("click", cancelEditTeam);

document.getElementById("teamForm").addEventListener("submit", async e => {
  e.preventDefault();
  const msg = document.getElementById("teamFormMsg");
  const teamData = {
    name:              document.getElementById("tName").value.trim(),
    division:          document.getElementById("tDivision").value,
    city:              document.getElementById("tCity").value,
    color:             document.getElementById("tColor").value,
    icsUrl:            document.getElementById("tIcsUrl").value.trim(),
    needsUmpireForHome: document.getElementById("tNeedsUmpire").checked,
  };
  if (!teamData.name) return;

  const editIdx = document.getElementById("teamEditIndex").value;
  if (editIdx !== "") {
    teams[parseInt(editIdx)] = teamData;
  } else {
    teams.push(teamData);
  }

  try {
    msg.textContent = "Saving…";
    msg.className   = "signup-message info";
    await saveTeams(false);
    msg.textContent = "✓ Team saved.";
    msg.className   = "signup-message success";
    cancelEditTeam();
    renderTeamList();
    setTimeout(() => { msg.textContent = ""; msg.className = "signup-message"; }, 2000);
  } catch (err) {
    msg.textContent = "Error: " + err.message;
    msg.className   = "signup-message error";
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  IMPORT — shared preview helpers
// ══════════════════════════════════════════════════════════════════════════════

function countApproved() {
  return readyItems.filter(r => r.approved).length
       + conflictItems.filter(r => r.approved).length;
}

function updateApprovedCount() {
  const n   = countApproved();
  const el  = document.getElementById("approvedCount");
  const btn = document.getElementById("commitBtn");
  const bar = document.getElementById("commitActions");
  if (el)  el.textContent  = n === 0 ? "No games approved yet." : `${n} game${n !== 1 ? "s" : ""} approved`;
  if (btn) btn.disabled    = n === 0;
  if (bar) bar.style.display = "";
}

function renderReady() {
  const panel = document.getElementById("tabReady");
  if (!readyItems.length) {
    panel.innerHTML = `<p style="color:var(--light-text);padding:16px 0">No conflict-free games found.</p>`;
    return;
  }
  const allApproved = readyItems.every(r => r.approved);
  panel.innerHTML = `
    <div class="page-actions" style="margin-bottom:8px">
      <button type="button" class="btn" id="approveAllReadyBtn">${allApproved ? "Unapprove All" : "Approve All"}</button>
      <button type="button" class="btn print-btn" id="skipAllReadyBtn">Skip All</button>
    </div>
    <div class="schedule-section" style="margin-top:0">
      <table>
        <thead><tr>
          <th>Date</th><th>Time</th><th>Field</th><th>Div</th><th>City</th>
          <th>Teams</th><th>Source</th><th>Umpire?</th><th>Action</th>
        </tr></thead>
        <tbody id="readyBody"></tbody>
      </table>
    </div>`;

  const tbody = document.getElementById("readyBody");
  tbody.innerHTML = readyItems.map((item, i) => {
    const ht = findHomeTeam(item.game.homeTeam);
    const needsU = ht?.needsUmpireForHome || item.game.needsUmpires;
    return `
    <tr class="${item.approved ? "sched-row-approved" : ""}">
      ${gameRowCells(item.game)}
      <td>
        <label style="display:flex;align-items:center;gap:4px;font-size:0.82rem;cursor:pointer;font-weight:normal">
          <input type="checkbox" class="ready-umpire-chk" data-idx="${i}" ${needsU ? "checked" : ""} />
          <span style="font-size:0.78rem">⚾</span>
        </label>
      </td>
      <td>
        <button type="button" class="btn ${item.approved ? "" : "print-btn"} ready-toggle-btn" data-idx="${i}">
          ${item.approved ? "✓ Approved" : "Approve"}
        </button>
      </td>
    </tr>`;
  }).join("");

  document.getElementById("approveAllReadyBtn").addEventListener("click", () => {
    const newVal = !readyItems.every(r => r.approved);
    readyItems.forEach(r => r.approved = newVal);
    renderReady(); updateApprovedCount();
  });
  document.getElementById("skipAllReadyBtn").addEventListener("click", () => {
    readyItems.forEach(r => r.approved = false);
    renderReady(); updateApprovedCount();
  });
  tbody.querySelectorAll(".ready-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      readyItems[parseInt(btn.dataset.idx)].approved ^= true;
      renderReady(); updateApprovedCount();
    });
  });
  tbody.querySelectorAll(".ready-umpire-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      readyItems[parseInt(chk.dataset.idx)].game.needsUmpires = chk.checked;
    });
  });
}

function renderConflicts() {
  const panel = document.getElementById("tabConflicts");
  if (!conflictItems.length) {
    panel.innerHTML = `<p style="color:var(--light-text);padding:16px 0">No conflicts detected.</p>`;
    return;
  }
  panel.innerHTML = `
    <div class="document-note" style="margin-bottom:16px">
      <p style="margin:0">Each game below has at least one issue. Review, edit, approve anyway, or skip.</p>
    </div>
    <div id="conflictRows"></div>`;

  const container = document.getElementById("conflictRows");
  container.innerHTML = conflictItems.map((item, i) => {
    const game = item.edited ? { ...item.game, ...item.editedFields } : item.game;
    const ht   = findHomeTeam(game.homeTeam);
    const needsU = ht?.needsUmpireForHome || game.needsUmpires;
    return `
    <div class="sched-conflict-card ${item.approved ? "sched-row-approved" : ""}" data-conflict-idx="${i}">
      <div class="sched-conflict-header">
        <div>
          <strong>${esc(fmtDate(game.date))}</strong>
          <span style="color:var(--light-text);margin-left:8px">${esc(fmt12(game.time))}</span>
          <span style="margin-left:8px">${esc(game.field || "—")}</span>
          <span style="color:var(--light-text);margin-left:8px">${esc(game.division || "")} · ${esc(game.city || "")}</span>
          ${item.edited ? '<span class="sched-edited-badge">edited</span>' : ""}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <label style="display:flex;align-items:center;gap:4px;font-size:0.82rem;cursor:pointer;font-weight:normal">
            <input type="checkbox" class="conflict-umpire-chk" data-idx="${i}" ${needsU ? "checked" : ""} />
            <span style="font-size:0.78rem">⚾ Umpire</span>
          </label>
          <button type="button" class="btn print-btn conflict-edit-btn" data-idx="${i}">✏ Edit</button>
          <button type="button" class="btn ${item.approved ? "" : "print-btn"} conflict-approve-btn" data-idx="${i}">
            ${item.approved ? "✓ Approved" : "Approve Anyway"}
          </button>
          <button type="button" class="btn print-btn conflict-skip-btn" data-idx="${i}">Skip</button>
        </div>
      </div>
      <div class="sched-issue-list">
        ${item.issues.map(issue => `
          <div class="sched-issue-row">
            ${issueBadge(issue)}
            ${issue.with ? `<span style="color:var(--light-text);font-size:0.82rem">
              Existing: ${esc(fmtDate(issue.with.date))} ${esc(fmt12(issue.with.time))} — ${esc(issue.with.field || "")} ${esc(issue.with.division || "")} ${esc(issue.with.city || "")}
            </span>` : ""}
          </div>`).join("")}
      </div>
      <div class="sched-edit-panel" id="editPanel_${i}" style="display:none">
        <div class="form-row" style="flex-wrap:wrap;gap:8px;margin-top:0">
          <div class="form-group form-group--sm">
            <label>Date</label>
            <input type="date" class="edit-date" data-idx="${i}" value="${esc(game.date)}" />
          </div>
          <div class="form-group form-group--sm">
            <label>Time</label>
            <input type="time" class="edit-time" data-idx="${i}" value="${esc(game.time)}" />
          </div>
          <div class="form-group">
            <label>Field</label>
            <input type="text" class="edit-field" data-idx="${i}" value="${esc(game.field)}" placeholder="e.g. NH-North" />
          </div>
          <div class="form-group form-group--sm">
            <label>Division</label>
            <select class="edit-division" data-idx="${i}">
              ${["10U","12U","14U","HS JV","HS Varsity"].map(d =>
                `<option value="${d}" ${game.division === d ? "selected" : ""}>${d}</option>`
              ).join("")}
            </select>
          </div>
          <div class="form-group">
            <label>City / League</label>
            <select class="edit-city" data-idx="${i}">
              <option value="City of Crooks" ${game.city === "City of Crooks" ? "selected" : ""}>City of Crooks</option>
              <option value="City of Colton" ${game.city === "City of Colton" ? "selected" : ""}>City of Colton</option>
            </select>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button type="button" class="btn" data-action="save-edit" data-idx="${i}">Save &amp; Approve</button>
          <button type="button" class="btn print-btn" data-action="cancel-edit" data-idx="${i}">Cancel</button>
        </div>
      </div>
    </div>`;
  }).join("");

  container.querySelectorAll(".conflict-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const panel = document.getElementById(`editPanel_${btn.dataset.idx}`);
      panel.style.display = panel.style.display === "none" ? "" : "none";
    });
  });
  container.querySelectorAll(".conflict-approve-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      conflictItems[parseInt(btn.dataset.idx)].approved ^= true;
      renderConflicts(); updateApprovedCount();
    });
  });
  container.querySelectorAll(".conflict-skip-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      conflictItems[parseInt(btn.dataset.idx)].approved = false;
      renderConflicts(); updateApprovedCount();
    });
  });
  container.querySelectorAll(".conflict-umpire-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      conflictItems[parseInt(chk.dataset.idx)].game.needsUmpires = chk.checked;
    });
  });
  container.querySelectorAll("[data-action='save-edit']").forEach(btn => {
    btn.addEventListener("click", () => {
      const i    = parseInt(btn.dataset.idx);
      conflictItems[i].editedFields = {
        date:     container.querySelector(`.edit-date[data-idx="${i}"]`).value,
        time:     container.querySelector(`.edit-time[data-idx="${i}"]`).value,
        field:    container.querySelector(`.edit-field[data-idx="${i}"]`).value.trim(),
        division: container.querySelector(`.edit-division[data-idx="${i}"]`).value,
        city:     container.querySelector(`.edit-city[data-idx="${i}"]`).value,
      };
      conflictItems[i].edited   = true;
      conflictItems[i].approved = true;
      renderConflicts(); updateApprovedCount();
    });
  });
  container.querySelectorAll("[data-action='cancel-edit']").forEach(btn => {
    btn.addEventListener("click", () => {
      document.getElementById(`editPanel_${btn.dataset.idx}`).style.display = "none";
    });
  });
}

function renderDuplicates() {
  const panel = document.getElementById("tabDuplicates");
  if (!duplicateItems.length) {
    panel.innerHTML = `<p style="color:var(--light-text);padding:16px 0">No duplicates found.</p>`;
    return;
  }
  panel.innerHTML = `
    <p style="color:var(--light-text);font-size:0.88rem;margin-bottom:8px">These games are already in the schedule.</p>
    <div class="schedule-section" style="margin-top:0">
      <table>
        <thead><tr><th>Date</th><th>Time</th><th>Field</th><th>Div</th><th>City</th><th>Teams</th><th>Source</th></tr></thead>
        <tbody>${duplicateItems.map(item => `<tr style="opacity:0.5">${gameRowCells(item)}</tr>`).join("")}</tbody>
      </table>
    </div>`;
}

function renderWarnings() {
  const panel = document.getElementById("tabWarnings");
  if (!warningItems.length) {
    panel.innerHTML = `<p style="color:var(--light-text);padding:16px 0">No fetch warnings.</p>`;
    return;
  }
  panel.innerHTML = warningItems.map(w => `
    <div style="background:#2a1a00;border:1px solid #b8860b;border-radius:6px;padding:10px 14px;margin-bottom:8px">
      <strong>${esc(w.source)}</strong>
      <div style="color:#ccc;font-size:0.85rem;margin-top:4px">${esc(w.message)}</div>
    </div>`).join("");
}

function renderTabs() {
  const tabs = [
    { id: "ready",      label: "Ready",      count: readyItems.length,     color: "#4caf50" },
    { id: "conflicts",  label: "Conflicts",  count: conflictItems.length,  color: "#e53935" },
    { id: "duplicates", label: "Duplicates", count: duplicateItems.length, color: "var(--light-text)" },
    { id: "warnings",   label: "Warnings",   count: warningItems.length,   color: "#f57c00" },
  ];
  document.getElementById("schedulerTabs").innerHTML = tabs.map(t => `
    <button type="button" class="scheduler-tab-btn ${activeTab === t.id ? "active" : ""}" data-tab="${t.id}">
      ${t.label}
      <span style="background:${activeTab===t.id ? t.color : "#444"};color:${activeTab===t.id ? "#fff" : "#aaa"};
                   border-radius:10px;padding:1px 7px;font-size:0.78rem;margin-left:4px">${t.count}</span>
    </button>`).join("");

  document.querySelectorAll(".scheduler-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      renderTabs();
      showActivePanel();
    });
  });
}

function showActivePanel() {
  ["ready","conflicts","duplicates","warnings"].forEach(id => {
    const el = document.getElementById(`tab${id.charAt(0).toUpperCase()+id.slice(1)}`);
    if (el) el.style.display = id === activeTab ? "" : "none";
  });
  if (activeTab === "ready")      renderReady();
  if (activeTab === "conflicts")  renderConflicts();
  if (activeTab === "duplicates") renderDuplicates();
  if (activeTab === "warnings")   renderWarnings();
}

function renderSummaryBar() {
  const readyApproved    = readyItems.filter(r => r.approved).length;
  const conflictApproved = conflictItems.filter(r => r.approved).length;
  document.getElementById("summaryBar").innerHTML = `
    <div class="sched-summary-item" style="color:#4caf50">
      <strong>${readyItems.length}</strong> clean
      ${readyApproved ? `<span style="color:var(--light-text);font-size:0.8rem">(${readyApproved} approved)</span>` : ""}
    </div>
    <div class="sched-summary-item" style="color:#e53935">
      <strong>${conflictItems.length}</strong> conflict${conflictItems.length !== 1 ? "s" : ""}
      ${conflictApproved ? `<span style="color:var(--light-text);font-size:0.8rem">(${conflictApproved} approved)</span>` : ""}
    </div>
    <div class="sched-summary-item" style="color:var(--light-text)">
      <strong>${duplicateItems.length}</strong> duplicate${duplicateItems.length !== 1 ? "s" : ""}
    </div>
    ${warningItems.length ? `<div class="sched-summary-item" style="color:#f57c00">
      <strong>${warningItems.length}</strong> fetch warning${warningItems.length !== 1 ? "s" : ""}
    </div>` : ""}`;
}

/** Show umpire-prompt banner for teams that have needsUmpireForHome */
function updateUmpirePromptBanner() {
  const allGames = [
    ...readyItems.map(r => r.game),
    ...conflictItems.map(c => c.game),
  ];
  const matchedTeams = new Set();
  allGames.forEach(g => {
    const t = findHomeTeam(g.homeTeam);
    if (t?.needsUmpireForHome) matchedTeams.add(t.name);
  });

  const banner = document.getElementById("umpirePromptBanner");
  if (!banner) return;
  if (!matchedTeams.size) { banner.style.display = "none"; return; }

  banner.style.display = "";
  document.getElementById("umpirePromptText").innerHTML =
    `Home games for <strong>${[...matchedTeams].join(", ")}</strong> are pre-checked for umpire assignment. Uncheck the ⚾ checkbox on any game to skip.`;
  // Pre-check needsUmpires on matching games
  allGames.forEach(g => {
    const t = findHomeTeam(g.homeTeam);
    if (t?.needsUmpireForHome) g.needsUmpires = true;
  });
}

function showPreview() {
  activeTab = readyItems.length ? "ready" : conflictItems.length ? "conflicts" : "duplicates";
  const total = readyItems.length + conflictItems.length + duplicateItems.length;
  if (total === 0 && warningItems.length === 0) return false;
  document.getElementById("previewSummary").style.display = "";
  updateUmpirePromptBanner();
  renderSummaryBar();
  renderTabs();
  showActivePanel();
  updateApprovedCount();
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
//  IMPORT — Calendar mode (calls cloud function)
// ══════════════════════════════════════════════════════════════════════════════

document.getElementById("fetchBtn").addEventListener("click", async () => {
  const btn = document.getElementById("fetchBtn");
  const msg = document.getElementById("fetchMessage");
  btn.disabled    = true;
  msg.textContent = "Fetching calendars and checking for conflicts…";
  msg.className   = "signup-message info";
  document.getElementById("previewSummary").style.display = "none";

  try {
    const result = await previewFn();
    const data   = result.data;
    readyItems     = (data.ready      || []).map(g => ({ game: g, approved: false, edited: false, editedFields: {} }));
    conflictItems  = (data.conflicts  || []).map(c => ({ ...c,   approved: false, edited: false, editedFields: {} }));
    duplicateItems = data.duplicates  || [];
    warningItems   = data.warnings    || [];

    if (!showPreview()) {
      msg.textContent = "No new games found in any calendar source.";
      msg.className   = "signup-message info";
    } else {
      msg.textContent = "";
    }
  } catch (err) {
    msg.textContent = "Error: " + (err.message || "Failed to fetch calendars.");
    msg.className   = "signup-message error";
  } finally {
    btn.disabled = false;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  IMPORT — CSV mode
// ══════════════════════════════════════════════════════════════════════════════

// Drag-and-drop on CSV dropzone
const csvDropzone  = document.getElementById("csvDropzone");
const csvFileInput = document.getElementById("csvFileInput");
let parsedCsvGames = [];

csvDropzone.addEventListener("click", () => csvFileInput.click());
csvDropzone.addEventListener("dragover", e => { e.preventDefault(); csvDropzone.classList.add("drag-over"); });
csvDropzone.addEventListener("dragleave", () => csvDropzone.classList.remove("drag-over"));
csvDropzone.addEventListener("drop", e => {
  e.preventDefault();
  csvDropzone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) handleCsvFile(file);
});
csvFileInput.addEventListener("change", e => {
  if (e.target.files[0]) handleCsvFile(e.target.files[0]);
});

function handleCsvFile(file) {
  document.getElementById("csvDropLabel").style.display = "none";
  document.getElementById("csvFileSelected").style.display = "";
  document.getElementById("csvFileName").textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    parsedCsvGames = parseCSV(e.target.result);
    const msg = document.getElementById("csvMessage");
    if (!parsedCsvGames.length) {
      msg.textContent = "No valid rows found in the CSV. Check the format and try again.";
      msg.className   = "signup-message error";
    } else {
      msg.textContent = `${parsedCsvGames.length} game${parsedCsvGames.length !== 1 ? "s" : ""} parsed — ready to preview.`;
      msg.className   = "signup-message info";
    }
  };
  reader.readAsText(file);
}

/**
 * Parse a CSV string into game objects.
 * Accepts flexible column order; header row required.
 * Handles common date/time formats.
 */
function parseCSV(text) {
  const lines  = text.replace(/\r\n?/g, "\n").split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];

  // Normalize header
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
  const col = name => headers.indexOf(name);

  const idxDate   = Math.max(col("date"), col("gamedate"));
  const idxTime   = Math.max(col("time"), col("gametime"), col("starttime"));
  const idxDiv    = Math.max(col("division"), col("div"), col("age"), col("agedivision"));
  const idxCity   = Math.max(col("city"), col("league"), col("cityleague"));
  const idxField  = Math.max(col("field"), col("fieldlocation"), col("location"));
  const idxHome   = Math.max(col("hometeam"), col("home"));
  const idxAway   = Math.max(col("awayteam"), col("away"), col("visitor"), col("visitingteam"));
  const idxType   = Math.max(col("gametype"), col("type"));

  const games = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCSVRow(lines[i]);
    if (cells.length < 2) continue;

    const rawDate = idxDate >= 0 ? cells[idxDate]?.trim() : "";
    const isoDate = normalizeDate(rawDate);
    if (!isoDate) continue; // skip rows with no parseable date

    const rawTime = idxTime >= 0 ? cells[idxTime]?.trim() : "";
    const isoTime = normalizeTime(rawTime);

    games.push({
      source:      "csv",
      sourceLabel: "CSV Import",
      sourceType:  "csv",
      externalId:  null,
      date:        isoDate,
      time:        isoTime || "",
      division:    idxDiv  >= 0 ? (cells[idxDiv]?.trim()  || "")  : "",
      city:        idxCity >= 0 ? (cells[idxCity]?.trim() || "")  : "",
      field:       idxField >= 0 ? (cells[idxField]?.trim() || "") : "",
      homeTeam:    idxHome >= 0 ? (cells[idxHome]?.trim()  || "") : "",
      awayTeam:    idxAway >= 0 ? (cells[idxAway]?.trim()  || "") : "",
      gameType:    idxType >= 0 ? (cells[idxType]?.trim()  || "Regular") : "Regular",
      needsUmpires: false,
      cancelled:   false,
      umpireSlots: [],
    });
  }
  return games;
}

function splitCSVRow(line) {
  const result = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && (i === 0 || line[i-1] !== "\\")) { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { result.push(cur); cur = ""; }
    else cur += ch;
  }
  result.push(cur);
  return result;
}

function normalizeDate(s) {
  if (!s) return "";
  // YYYY-MM-DD already good
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // M/D/YYYY or MM/DD/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2,"0")}-${String(m[2]).padStart(2,"0")}`;
  return "";
}

function normalizeTime(s) {
  if (!s) return "";
  // HH:MM already
  if (/^\d{2}:\d{2}$/.test(s)) return s;
  // H:MM AM/PM
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m) {
    let h = parseInt(m[1]);
    const mins = m[2];
    const pm   = m[3].toUpperCase() === "PM";
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return `${String(h).padStart(2,"0")}:${mins}`;
  }
  return "";
}

// Client-side conflict check for CSV games
async function previewCSVGames() {
  const msg = document.getElementById("csvMessage");
  const btn = document.getElementById("csvPreviewBtn");
  btn.disabled    = true;
  msg.textContent = "Loading existing games and checking conflicts…";
  msg.className   = "signup-message info";
  document.getElementById("previewSummary").style.display = "none";

  try {
    // Load existing games from Firestore
    const [gamesSnap, configSnap] = await Promise.all([
      getDocs(collection(db, "games")),
      getDoc(doc(db, "config/scheduling")),
    ]);
    const existingGames    = gamesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const existingExtIdSet = new Set(existingGames.map(g => g.externalId).filter(Boolean));
    const schedCfg         = configSnap.exists() ? configSnap.data() : {};
    const durMap           = schedCfg.gameDurationMinutes || { "10U": 90, "12U": 90, "14U": 120, "HS JV": 120, "HS Varsity": 150, default: 90 };
    const lateStartMins    = timeToMins(schedCfg.lateStartCutoff || "19:30");

    const today = todayISO();
    readyItems     = [];
    conflictItems  = [];
    duplicateItems = [];
    warningItems   = [];

    for (const game of parsedCsvGames) {
      if (!game.date || game.date < today) {
        duplicateItems.push({ ...game, _reason: "Past date" });
        continue;
      }
      // Build synthetic externalId from date+time+field for dedup
      const syntheticId = `csv-${game.date}-${game.time}-${(game.field||"").replace(/\s/g,"")}-${(game.city||"").replace(/\s/g,"")}`;
      const dupCheck = existingGames.find(g =>
        g.date === game.date && g.time === game.time &&
        (g.field||"").toLowerCase() === (game.field||"").toLowerCase() &&
        (g.city||"").toLowerCase()  === (game.city||"").toLowerCase()
      );
      if (dupCheck) {
        duplicateItems.push({ ...game, _reason: "Already in schedule" });
        continue;
      }

      const issues = [];

      // Field time overlap
      for (const ex of existingGames) {
        if (!ex.cancelled && gamesOverlapLocal(game, ex, durMap)) {
          issues.push({ type: "field_overlap", label: "Field time overlap", color: "#e53935",
            with: { id: ex.id, date: ex.date, time: ex.time, field: ex.field, division: ex.division, city: ex.city } });
        }
      }
      // Batch overlap
      for (const other of [...readyItems.map(r => r.game), ...conflictItems.map(c => c.game)]) {
        if (other && gamesOverlapLocal(game, other, durMap)) {
          issues.push({ type: "batch_overlap", label: "Overlaps another incoming game", color: "#e53935",
            with: { date: other.date, time: other.time, field: other.field, division: other.division } });
          break;
        }
      }

      if (issues.length === 0) readyItems.push({ game, approved: false, edited: false, editedFields: {} });
      else                     conflictItems.push({ game, issues, approved: false, edited: false, editedFields: {} });
    }

    if (!showPreview()) {
      msg.textContent = "No new games found — all rows were duplicates or past dates.";
      msg.className   = "signup-message info";
    } else {
      msg.textContent = "";
    }
  } catch (err) {
    msg.textContent = "Error: " + err.message;
    msg.className   = "signup-message error";
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("csvPreviewBtn").addEventListener("click", previewCSVGames);

function timeToMins(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

function gamesOverlapLocal(g1, g2, durMap) {
  if (g1.date !== g2.date) return false;
  const f1 = (g1.field || "").trim().toLowerCase();
  const f2 = (g2.field || "").trim().toLowerCase();
  if (!f1 || !f2 || f1 !== f2) return false;
  const s1 = timeToMins(g1.time);
  const s2 = timeToMins(g2.time);
  if (s1 === null || s2 === null) return false;
  const d1 = durMap[g1.division] ?? durMap["default"] ?? 90;
  const d2 = durMap[g2.division] ?? durMap["default"] ?? 90;
  return s1 < s2 + d2 && s2 < s1 + d1;
}

// ══════════════════════════════════════════════════════════════════════════════
//  IMPORT — Commit (shared)
// ══════════════════════════════════════════════════════════════════════════════

document.getElementById("commitBtn").addEventListener("click", async () => {
  const btn = document.getElementById("commitBtn");
  const msg = document.getElementById("commitMessage");

  const approved = [
    ...readyItems.filter(r => r.approved).map(r => r.game),
    ...conflictItems.filter(r => r.approved).map(r =>
      r.edited ? { ...r.game, ...r.editedFields } : r.game
    ),
  ];

  if (!approved.length) {
    msg.textContent = "No games approved — nothing to import.";
    msg.className   = "signup-message error";
    return;
  }
  if (!confirm(`Import ${approved.length} approved game${approved.length !== 1 ? "s" : ""} into the schedule?`)) return;

  btn.disabled    = true;
  msg.textContent = "Importing…";
  msg.className   = "signup-message info";

  try {
    const result = await commitFn({ games: approved });
    const added  = result.data.added || 0;
    msg.textContent = `✓ ${added} game${added !== 1 ? "s" : ""} added to the schedule.`;
    msg.className   = "signup-message success";

    // Remove committed games from local state
    const committed = new Set(approved.map(g => JSON.stringify({ d: g.date, t: g.time, f: g.field, c: g.city })));
    const keep = item => !committed.has(JSON.stringify({ d: item.game.date, t: item.game.time, f: item.game.field, c: item.game.city }));
    readyItems    = readyItems.filter(keep);
    conflictItems = conflictItems.filter(keep);
    renderSummaryBar();
    renderTabs();
    showActivePanel();
    updateApprovedCount();
  } catch (err) {
    msg.textContent = "Import failed: " + (err.message || "Unknown error.");
    msg.className   = "signup-message error";
  } finally {
    btn.disabled = false;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  CALENDAR SECTION
// ══════════════════════════════════════════════════════════════════════════════

const MONTH_NAMES = ["January","February","March","April","May","June",
                     "July","August","September","October","November","December"];
const DOW_LABELS  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

async function loadCalendar() {
  const label = document.getElementById("calMonthLabel");
  if (label) label.textContent = `${MONTH_NAMES[calMonth]} ${calYear}`;
  renderCalendarLegend();
  await renderCalendarGrid();
}

function renderCalendarLegend() {
  const el = document.getElementById("calLegend");
  if (!el) return;
  if (!teams.length) { el.innerHTML = ""; return; }
  el.innerHTML = teams.map(t =>
    `<span style="display:flex;align-items:center;gap:4px">
       <span style="width:12px;height:12px;border-radius:2px;background:${esc(t.color)};flex-shrink:0"></span>
       ${esc(t.name)}
     </span>`
  ).join("") + `<span style="display:flex;align-items:center;gap:4px">
    <span style="width:12px;height:12px;border-radius:2px;background:#5b8dd9;flex-shrink:0"></span>
    Practice
  </span>`;
}

async function renderCalendarGrid() {
  const grid = document.getElementById("calGrid");
  if (!grid) return;
  grid.innerHTML = `<p style="color:var(--light-text)">Loading…</p>`;

  const showGames     = document.getElementById("calShowGames")?.checked ?? true;
  const showPractices = document.getElementById("calShowPractices")?.checked ?? true;

  // Date range for the full grid (6 weeks)
  const firstOfMonth = new Date(calYear, calMonth, 1);
  const gridStart    = new Date(firstOfMonth);
  gridStart.setDate(1 - firstOfMonth.getDay()); // back to Sunday

  const lastOfMonth  = new Date(calYear, calMonth + 1, 0);
  const gridEnd      = new Date(lastOfMonth);
  gridEnd.setDate(lastOfMonth.getDate() + (6 - lastOfMonth.getDay())); // forward to Saturday

  const startISO = isoFromDate(gridStart);
  const endISO   = isoFromDate(gridEnd);

  try {
    const [gamesSnap, practicesSnap] = await Promise.all([
      getDocs(query(collection(db, "games"),
        where("date", ">=", startISO),
        where("date", "<=", endISO),
        orderBy("date"), orderBy("time"))),
      getDocs(query(collection(db, "practices"),
        where("date", ">=", startISO),
        where("date", "<=", endISO))),
    ]);

    // Build day → items map
    const dayMap = {}; // "YYYY-MM-DD" → { games: [], practices: [] }
    if (showGames) {
      gamesSnap.docs.forEach(d => {
        const g = { id: d.id, ...d.data() };
        if (g.cancelled) return;
        if (!dayMap[g.date]) dayMap[g.date] = { games: [], practices: [] };
        dayMap[g.date].games.push(g);
      });
    }
    if (showPractices) {
      practicesSnap.docs.forEach(d => {
        const p = { id: d.id, ...d.data() };
        if (!dayMap[p.date]) dayMap[p.date] = { games: [], practices: [] };
        dayMap[p.date].practices.push(p);
      });
    }

    const todayISO_ = todayISO();
    let html = `<div class="cal-month-grid">`;
    // Header row
    html += DOW_LABELS.map(d => `<div class="cal-dow-header">${d}</div>`).join("");

    // Day cells
    const cur = new Date(gridStart);
    while (cur <= gridEnd) {
      const iso = isoFromDate(cur);
      const isThisMonth = cur.getMonth() === calMonth;
      const isToday     = iso === todayISO_;
      const items       = dayMap[iso] || { games: [], practices: [] };

      html += `<div class="cal-month-cell ${!isThisMonth ? "cal-other-month" : ""} ${isToday ? "cal-today" : ""}">`;
      html += `<div class="${isToday ? "cal-today-num" : "cal-day-num"}">${cur.getDate()}</div>`;

      // Game cards
      items.games.slice(0, 3).forEach(g => {
        const color = teamColor(g);
        const slots = g.umpireSlots || [];
        const assigned = slots.filter(s => s.assignedUid).length;
        const total    = slots.length;
        const label    = g.homeTeam && g.awayTeam
          ? `${g.awayTeam.split(" ").pop()} @ ${g.homeTeam.split(" ").pop()}`
          : (g.homeTeam || g.division || "Game");
        html += `<div class="cal-card" style="border-left-color:${color}" title="${esc(g.homeTeam||"")} vs ${esc(g.awayTeam||"")} · ${g.city||""} · ${g.field||""}">
          <div style="font-size:0.7rem;color:var(--light-text)">${g.time ? fmt12(g.time).replace(":00","") : ""} ${esc(g.division || "")}</div>
          <div style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(label)}</div>
          ${total ? `<div style="font-size:0.68rem;color:${assigned===total?"#6fcf97":"#ffcc80"}">${assigned}/${total} ump</div>` : ""}
        </div>`;
      });
      if (items.games.length > 3) {
        html += `<div style="font-size:0.7rem;color:var(--light-text);padding:1px 4px">+${items.games.length - 3} more</div>`;
      }

      // Practice cards
      items.practices.slice(0, 2).forEach(p => {
        html += `<div class="cal-card" style="border-left-color:#5b8dd9" title="Practice: ${esc(p.teamName||"")} · ${p.field||""}">
          <div style="font-size:0.7rem;color:#8ab4f8">${p.startTime ? fmt12(p.startTime).replace(":00","") : "Practice"}</div>
          <div style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:0.78rem">${esc(p.teamName||"Practice")}</div>
        </div>`;
      });
      if (items.practices.length > 2) {
        html += `<div style="font-size:0.7rem;color:#8ab4f8;padding:1px 4px">+${items.practices.length - 2} more</div>`;
      }

      html += `</div>`;
      cur.setDate(cur.getDate() + 1);
    }
    html += `</div>`;
    grid.innerHTML = html;
  } catch (err) {
    grid.innerHTML = `<p style="color:#ff8a8a">Error loading calendar: ${esc(err.message)}</p>`;
  }
}

function isoFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// Calendar nav
document.getElementById("calPrevBtn").addEventListener("click", () => {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  loadCalendar();
});
document.getElementById("calNextBtn").addEventListener("click", () => {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  loadCalendar();
});
document.getElementById("calTodayBtn").addEventListener("click", () => {
  const n = new Date();
  calYear = n.getFullYear(); calMonth = n.getMonth();
  loadCalendar();
});
document.getElementById("calShowGames").addEventListener("change", () => renderCalendarGrid());
document.getElementById("calShowPractices").addEventListener("change", () => renderCalendarGrid());

// ══════════════════════════════════════════════════════════════════════════════
//  PRACTICES SECTION
// ══════════════════════════════════════════════════════════════════════════════

async function loadPractices() {
  const today = todayISO();
  try {
    const [pendingSnap, approvedSnap] = await Promise.all([
      getDocs(query(collection(db, "practiceRequests"),
        where("status", "==", "pending"),
        orderBy("date"), orderBy("startTime"))),
      getDocs(query(collection(db, "practices"),
        where("date", ">=", today),
        orderBy("date"), orderBy("startTime"))),
    ]);
    renderPendingList(pendingSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    renderApprovedList(approvedSnap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    document.getElementById("pendingPracticesList").innerHTML =
      `<p style="color:#ff8a8a">Error: ${esc(err.message)}</p>`;
  }
}

function recurrenceLabel(req) {
  if (!req.recurrence || req.recurrence.type === "once") return "One-time";
  const days = (req.recurrence.daysOfWeek || []).map(d =>
    ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d] || "?"
  ).join(", ");
  return `Weekly (${days}) · ${fmtDate(req.recurrence.startDate)} – ${fmtDate(req.recurrence.endDate)}`;
}

function renderPendingList(requests) {
  const el = document.getElementById("pendingPracticesList");
  if (!requests.length) {
    el.innerHTML = `<p style="color:var(--light-text)">No pending requests.</p>`;
    return;
  }
  el.innerHTML = requests.map(req => `
    <div class="practice-req-card pending" data-id="${esc(req.id)}">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <div>
          <strong>${esc(req.teamName || "Unknown Team")}</strong>
          <span style="color:var(--light-text);margin-left:8px;font-size:0.85rem">${esc(req.coachName || "")}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button type="button" class="btn practice-approve-btn" data-id="${esc(req.id)}" style="padding:4px 12px;font-size:0.85rem">✓ Approve</button>
          <button type="button" class="btn print-btn practice-deny-btn" data-id="${esc(req.id)}" style="padding:4px 12px;font-size:0.85rem;color:#ff8a8a;border-color:#ff8a8a">✗ Deny</button>
        </div>
      </div>
      <div style="font-size:0.88rem;color:var(--light-text)">
        <span>📅 ${esc(fmtDate(req.date))}</span>
        <span style="margin-left:12px">⏰ ${esc(req.startTime ? fmt12(req.startTime) : "—")} – ${esc(req.endTime ? fmt12(req.endTime) : "—")}</span>
        <span style="margin-left:12px">🏟 ${esc(req.field || "—")}</span>
      </div>
      <div style="font-size:0.85rem;margin-top:4px;color:var(--light-text)">
        🔄 ${esc(recurrenceLabel(req))}
      </div>
      ${req.notes ? `<div style="margin-top:6px;font-size:0.85rem;color:#ccc;white-space:pre-wrap">${esc(req.notes)}</div>` : ""}
      <div id="conflictCheck_${esc(req.id)}" style="margin-top:8px"></div>
      <p class="signup-message" id="practiceMsg_${esc(req.id)}" aria-live="polite"></p>
    </div>`).join("");

  el.querySelectorAll(".practice-approve-btn").forEach(btn => {
    btn.addEventListener("click", () => approvePracticeRequest(btn.dataset.id));
  });
  el.querySelectorAll(".practice-deny-btn").forEach(btn => {
    btn.addEventListener("click", () => denyPracticeRequest(btn.dataset.id));
  });

  // Check conflicts for each pending request
  requests.forEach(req => checkPracticeConflict(req));
}

function renderApprovedList(practices) {
  const el = document.getElementById("approvedPracticesList");
  if (!practices.length) {
    el.innerHTML = `<p style="color:var(--light-text)">No upcoming approved practices.</p>`;
    return;
  }
  el.innerHTML = `
    <div class="schedule-section" style="margin-top:0">
      <table>
        <thead><tr>
          <th>Date</th><th>Time</th><th>Team</th><th>Field</th><th>Coach</th><th>Recurrence</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${practices.map(p => `
          <tr>
            <td>${esc(fmtDate(p.date))}</td>
            <td>${esc(p.startTime ? fmt12(p.startTime) : "—")} – ${esc(p.endTime ? fmt12(p.endTime) : "—")}</td>
            <td>${esc(p.teamName || "—")}</td>
            <td>${esc(p.field || "—")}</td>
            <td>${esc(p.coachName || "—")}</td>
            <td style="font-size:0.82rem">${esc(recurrenceLabel(p))}</td>
            <td>
              <button type="button" class="btn print-btn practice-cancel-btn" data-id="${esc(p.id)}"
                style="padding:3px 8px;font-size:0.8rem;color:#ff8a8a;border-color:#ff8a8a">Cancel</button>
            </td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;

  el.querySelectorAll(".practice-cancel-btn").forEach(btn => {
    btn.addEventListener("click", () => cancelPractice(btn.dataset.id));
  });
}

async function checkPracticeConflict(req) {
  const el = document.getElementById(`conflictCheck_${req.id}`);
  if (!el) return;
  try {
    const snap = await getDocs(query(collection(db, "games"),
      where("date", "==", req.date),
      where("cancelled", "==", false)));
    const conflicting = snap.docs.filter(d => {
      const g = d.data();
      if ((g.field || "").toLowerCase() !== (req.field || "").toLowerCase()) return false;
      // Time overlap check
      const gs = timeToMins(g.time);
      const ge = gs !== null ? gs + 90 : null;
      const ps = timeToMins(req.startTime);
      const pe = timeToMins(req.endTime);
      if (gs === null || ps === null || pe === null) return false;
      return ps < (ge || gs + 90) && gs < pe;
    });
    if (conflicting.length) {
      el.innerHTML = `<div style="color:#ff8a8a;font-size:0.82rem">⚠ Field conflict: ${conflicting.length} game${conflicting.length !== 1 ? "s" : ""} on this field at this time.</div>`;
    } else {
      el.innerHTML = `<div style="color:#6fcf97;font-size:0.82rem">✓ No field conflicts detected.</div>`;
    }
  } catch { /* silent */ }
}

async function approvePracticeRequest(id) {
  const msg = document.getElementById(`practiceMsg_${id}`);
  if (msg) { msg.textContent = "Approving…"; msg.className = "signup-message info"; }
  try {
    const reqDoc = await getDoc(doc(db, "practiceRequests", id));
    if (!reqDoc.exists()) throw new Error("Request not found.");
    const req  = reqDoc.data();
    const dates = expandRecurrence(req);

    // Write approved practices (one per date)
    for (const date of dates) {
      await addDoc(collection(db, "practices"), {
        requestId:   id,
        teamName:    req.teamName    || "",
        coachName:   req.coachName   || "",
        coachEmail:  req.coachEmail  || "",
        coachPhone:  req.coachPhone  || "",
        field:       req.field       || "",
        date,
        startTime:   req.startTime   || "",
        endTime:     req.endTime     || "",
        notes:       req.notes       || "",
        recurrence:  req.recurrence  || { type: "once" },
        approvedAt:  new Date().toISOString(),
      });
    }
    await updateDoc(doc(db, "practiceRequests", id), { status: "approved" });
    await loadPractices();
  } catch (err) {
    if (msg) { msg.textContent = "Error: " + err.message; msg.className = "signup-message error"; }
  }
}

async function denyPracticeRequest(id) {
  if (!confirm("Deny this practice request?")) return;
  const msg = document.getElementById(`practiceMsg_${id}`);
  if (msg) { msg.textContent = "Denying…"; msg.className = "signup-message info"; }
  try {
    await updateDoc(doc(db, "practiceRequests", id), { status: "denied" });
    await loadPractices();
  } catch (err) {
    if (msg) { msg.textContent = "Error: " + err.message; msg.className = "signup-message error"; }
  }
}

async function cancelPractice(id) {
  if (!confirm("Cancel this approved practice?")) return;
  try {
    await deleteDoc(doc(db, "practices", id));
    await loadPractices();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

/** Expand a practice request into individual date strings */
function expandRecurrence(req) {
  const rec = req.recurrence || { type: "once" };
  if (rec.type !== "weekly" || !rec.startDate || !rec.endDate || !rec.daysOfWeek?.length) {
    return [req.date];
  }
  const dates = [];
  const cur   = new Date(rec.startDate + "T12:00:00");
  const end   = new Date(rec.endDate   + "T12:00:00");
  const dows  = new Set(rec.daysOfWeek.map(Number));
  while (cur <= end) {
    if (dows.has(cur.getDay())) dates.push(isoFromDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

document.getElementById("refreshPracticesBtn").addEventListener("click", loadPractices);

// ══════════════════════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════════════════════

authReadyPromise.then(async () => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display     = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display     = "none";

  // Load teams first (needed by all sections)
  await loadTeams();
  // Teams section is default active — already rendered by loadTeams()
});
