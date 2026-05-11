// admin-scheduler.js — Scheduling Assistant: calendar import preview + conflict review
import { app }                        from "./firebase.js";
import { authReadyPromise, isAdmin }  from "./auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

const fns                = getFunctions(app);
const previewFn          = httpsCallable(fns, "previewCalendarImport");
const commitFn           = httpsCallable(fns, "commitCalendarImport");

// ── State ─────────────────────────────────────────────────────────────────────

// Each entry: { game, approved: bool, edited: bool, editedFields: {} }
let readyItems     = [];
let conflictItems  = [];   // { game, issues[], approved, edited, editedFields }
let duplicateItems = [];
let warningItems   = [];

let activeTab = "ready";

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
  const ampm = h >= 12 ? "PM" : "AM";
  const hr   = h % 12 || 12;
  return `${hr}:${String(m).padStart(2,"0")} ${ampm}`;
}

function issueBadge(issue) {
  return `<span class="sched-issue-badge" style="background:${issue.color}22;color:${issue.color};border-color:${issue.color}44">${esc(issue.label)}</span>`;
}

function sourceLabel(game) {
  const icon = game.sourceType === "google" ? "📅" : "🎮";
  return `<span style="color:var(--light-text);font-size:0.8rem">${icon} ${esc(game.sourceLabel || game.source || "")}</span>`;
}

function gameRowCells(game) {
  return `
    <td>${esc(fmtDate(game.date))}</td>
    <td>${esc(fmt12(game.time))}</td>
    <td>${esc(game.field || "—")}</td>
    <td>${esc(game.division || "—")}</td>
    <td>${esc(game.city || "—")}</td>
    <td>${esc(game.homeTeam && game.awayTeam ? `${game.awayTeam} @ ${game.homeTeam}` : game.homeTeam || game.awayTeam || "—")}</td>
    <td>${sourceLabel(game)}</td>`;
}

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

// ── Ready tab ─────────────────────────────────────────────────────────────────

function renderReady() {
  const panel = document.getElementById("tabReady");
  if (!readyItems.length) {
    panel.innerHTML = `<p style="color:var(--light-text);padding:16px 0">No conflict-free games found in the calendars.</p>`;
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
          <th>Teams</th><th>Source</th><th>Action</th>
        </tr></thead>
        <tbody id="readyBody"></tbody>
      </table>
    </div>`;

  const tbody = document.getElementById("readyBody");
  tbody.innerHTML = readyItems.map((item, i) => `
    <tr class="${item.approved ? "sched-row-approved" : ""}">
      ${gameRowCells(item.game)}
      <td>
        <button type="button" class="btn ${item.approved ? "" : "print-btn"} ready-toggle-btn" data-idx="${i}">
          ${item.approved ? "✓ Approved" : "Approve"}
        </button>
      </td>
    </tr>`).join("");

  document.getElementById("approveAllReadyBtn").addEventListener("click", () => {
    const newVal = !readyItems.every(r => r.approved);
    readyItems.forEach(r => r.approved = newVal);
    renderReady();
    updateApprovedCount();
  });
  document.getElementById("skipAllReadyBtn").addEventListener("click", () => {
    readyItems.forEach(r => r.approved = false);
    renderReady();
    updateApprovedCount();
  });
  tbody.querySelectorAll(".ready-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.idx);
      readyItems[i].approved = !readyItems[i].approved;
      renderReady();
      updateApprovedCount();
    });
  });
}

// ── Conflicts tab ─────────────────────────────────────────────────────────────

function renderConflicts() {
  const panel = document.getElementById("tabConflicts");
  if (!conflictItems.length) {
    panel.innerHTML = `<p style="color:var(--light-text);padding:16px 0">No conflicts detected.</p>`;
    return;
  }

  panel.innerHTML = `
    <div class="document-note" style="margin-bottom:16px">
      <p style="margin:0">Each game below has at least one issue. Review the issue, then choose to approve as-is, edit before approving, or skip.</p>
    </div>
    <div id="conflictRows"></div>`;

  const container = document.getElementById("conflictRows");
  container.innerHTML = conflictItems.map((item, i) => {
    const game = item.edited ? { ...item.game, ...item.editedFields } : item.game;
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
      <!-- Inline edit panel -->
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

  // Wire events
  container.querySelectorAll(".conflict-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const i     = parseInt(btn.dataset.idx);
      const panel = document.getElementById(`editPanel_${i}`);
      panel.style.display = panel.style.display === "none" ? "" : "none";
    });
  });
  container.querySelectorAll(".conflict-approve-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.idx);
      conflictItems[i].approved = !conflictItems[i].approved;
      renderConflicts();
      updateApprovedCount();
    });
  });
  container.querySelectorAll(".conflict-skip-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.idx);
      conflictItems[i].approved = false;
      renderConflicts();
      updateApprovedCount();
    });
  });
  container.querySelectorAll("[data-action='save-edit']").forEach(btn => {
    btn.addEventListener("click", () => {
      const i    = parseInt(btn.dataset.idx);
      const item = conflictItems[i];
      item.editedFields = {
        date:     container.querySelector(`.edit-date[data-idx="${i}"]`).value,
        time:     container.querySelector(`.edit-time[data-idx="${i}"]`).value,
        field:    container.querySelector(`.edit-field[data-idx="${i}"]`).value.trim(),
        division: container.querySelector(`.edit-division[data-idx="${i}"]`).value,
        city:     container.querySelector(`.edit-city[data-idx="${i}"]`).value,
      };
      item.edited   = true;
      item.approved = true;
      renderConflicts();
      updateApprovedCount();
    });
  });
  container.querySelectorAll("[data-action='cancel-edit']").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.idx);
      document.getElementById(`editPanel_${i}`).style.display = "none";
    });
  });
}

// ── Duplicates tab ────────────────────────────────────────────────────────────

function renderDuplicates() {
  const panel = document.getElementById("tabDuplicates");
  if (!duplicateItems.length) {
    panel.innerHTML = `<p style="color:var(--light-text);padding:16px 0">No duplicates found.</p>`;
    return;
  }
  panel.innerHTML = `
    <p style="color:var(--light-text);font-size:0.88rem;margin-bottom:8px">These games are already in the schedule and will not be imported again.</p>
    <div class="schedule-section" style="margin-top:0">
      <table>
        <thead><tr><th>Date</th><th>Time</th><th>Field</th><th>Div</th><th>City</th><th>Teams</th><th>Source</th></tr></thead>
        <tbody>${duplicateItems.map(item => `<tr style="opacity:0.5">${gameRowCells(item)}</tr>`).join("")}</tbody>
      </table>
    </div>`;
}

// ── Warnings tab ──────────────────────────────────────────────────────────────

function renderWarnings() {
  const panel = document.getElementById("tabWarnings");
  if (!warningItems.length) {
    panel.innerHTML = `<p style="color:var(--light-text);padding:16px 0">No fetch warnings.</p>`;
    return;
  }
  panel.innerHTML = `
    <p style="color:var(--light-text);font-size:0.88rem;margin-bottom:8px">These calendar sources could not be fetched.</p>
    ${warningItems.map(w => `
      <div style="background:#2a1a00;border:1px solid #b8860b;border-radius:6px;padding:10px 14px;margin-bottom:8px">
        <strong>${esc(w.source)}</strong>
        <div style="color:#ccc;font-size:0.85rem;margin-top:4px">${esc(w.message)}</div>
      </div>`).join("")}`;
}

// ── Tab system ────────────────────────────────────────────────────────────────

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
  // Render active panel
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

// ── Fetch ─────────────────────────────────────────────────────────────────────

document.getElementById("fetchBtn").addEventListener("click", async () => {
  const btn = document.getElementById("fetchBtn");
  const msg = document.getElementById("fetchMessage");
  btn.disabled    = true;
  msg.textContent = "Fetching calendars and checking for conflicts…";
  msg.className   = "signup-message info";

  try {
    const result = await previewFn();
    const data   = result.data;

    readyItems     = (data.ready      || []).map(g  => ({ game: g,  approved: false, edited: false, editedFields: {} }));
    conflictItems  = (data.conflicts  || []).map(c  => ({ ...c,     approved: false, edited: false, editedFields: {} }));
    duplicateItems = data.duplicates  || [];
    warningItems   = data.warnings    || [];

    activeTab = readyItems.length ? "ready" : conflictItems.length ? "conflicts" : "duplicates";

    const total = readyItems.length + conflictItems.length + duplicateItems.length;
    if (total === 0 && warningItems.length === 0) {
      msg.textContent = "No new games found in any calendar source.";
      msg.className   = "signup-message info";
      document.getElementById("previewSummary").style.display = "none";
    } else {
      msg.textContent = "";
      document.getElementById("previewSummary").style.display = "";
      renderSummaryBar();
      renderTabs();
      showActivePanel();
      updateApprovedCount();
    }
  } catch (err) {
    msg.textContent = "Error: " + (err.message || "Failed to fetch calendars.");
    msg.className   = "signup-message error";
  } finally {
    btn.disabled = false;
  }
});

// ── Commit ────────────────────────────────────────────────────────────────────

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
    msg.textContent = "No games are approved — nothing to import.";
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

    // Remove committed games from local state so they're gone on next preview
    const importedExtIds = new Set(approved.map(g => g.externalId).filter(Boolean));
    readyItems    = readyItems.filter(r => !importedExtIds.has(r.game.externalId));
    conflictItems = conflictItems.filter(r => !importedExtIds.has(r.game.externalId));
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

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display     = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display     = "none";
});
