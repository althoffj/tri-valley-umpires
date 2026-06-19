// admin-tournament.js — Tournament management (create, rain delay, field swap)
import { db, app } from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import {
  collection, getDocs, getDoc, addDoc, doc, updateDoc, deleteDoc, writeBatch,
  query, orderBy, serverTimestamp, where, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import { esc, fmtDate, fmtTime, setMsg, showToast, showConfirm } from "./utils.js";

const fns         = getFunctions(app, "us-central1");
const notifySwap  = httpsCallable(fns, "notifyTournamentSwap");

// ── State ─────────────────────────────────────────────────────────────────────

let allTournaments = [];
let allGames       = [];
let allFacilities  = [];   // [{ id, name, fields: [{name}] }]
let allTeams       = [];   // [{ id, name, division, ... }] from config/teamCalendars
let expandedTid    = null;

// Umpire assignment state
let approvedUmpires    = [];   // { uid, name, email }
let umpireUnavailable  = {};   // { [uid]: Set<string> }
let _assignTarget      = null; // { gameId, slotType, gameDate, gameTime }

// Participant import state
let _importModal     = null;
let _importTid       = null;
let _rawRows         = [];
let _importHasHeader = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function addMinutesToTime(timeStr, minutes) {
  if (!timeStr) return timeStr;
  const [h, m] = timeStr.split(":").map(Number);
  const total  = h * 60 + m + minutes;
  const nh     = Math.floor(total / 60) % 24;
  const nm     = total % 60;
  return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
}

function statusBadgeHtml(status) {
  const map = {
    scheduled:    { bg: "#1a2a3a", color: "#7ec8f7",  label: "Scheduled"   },
    active:       { bg: "#17351f", color: "#b8f2c4",  label: "Active"      },
    "rain-delay": { bg: "#4a3a00", color: "#ffd966",  label: "Rain Delay"  },
    complete:     { bg: "#333",    color: "#aaa",      label: "Complete"    }
  };
  const s = map[status] || map.scheduled;
  return `<span class="badge" style="background:${s.bg};color:${s.color}">${s.label}</span>`;
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadAll() {
  const [tSnap, gSnap, fSnap, tcSnap] = await Promise.all([
    getDocs(query(collection(db, "tournaments"), orderBy("date", "desc"))),
    getDocs(query(collection(db, "games"), orderBy("date", "asc"))),
    getDocs(collection(db, "facilities")),
    getDoc(doc(db, "config", "teamCalendars"))
  ]);
  allTournaments = tSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  allGames       = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  allFacilities  = fSnap.docs.map(d => ({ id: d.id, ...d.data() }))
                            .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  allTeams = tcSnap.exists()
    ? (tcSnap.data().teams || []).sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    : [];
  render();
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  const el = document.getElementById("tournamentList");
  if (!allTournaments.length) {
    el.innerHTML = `<p style="color:var(--light-text)">No tournaments yet. Create one above.</p>`;
    return;
  }
  el.innerHTML = allTournaments.map(t => renderCard(t)).join("");
}

function renderCard(t) {
  const linked   = allGames.filter(g => g.tournamentId === t.id);
  const expanded = expandedTid === t.id;

  return `
    <div class="document-note" style="margin-bottom:12px${expanded ? ";border-left-color:#7ec8f7" : ""}">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div>
          <strong style="color:white;font-size:1.05rem">🏆 ${esc(t.name)}</strong>
          <div style="color:var(--light-text);font-size:0.85rem;margin-top:3px">
            ${esc(fmtDate(t.date))}
            ${t.location ? " · " + esc(t.location) : ""}
            ${t.division ? " · " + esc(t.division) : ""}
            · ${linked.length} game${linked.length !== 1 ? "s" : ""}
            ${t.fields?.length ? " · Fields: " + esc(t.fields.join(", ")) : ""}
          </div>
          ${t.notes ? `<div style="color:var(--light-text);font-size:0.82rem;margin-top:2px;font-style:italic">${esc(t.notes)}</div>` : ""}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${statusBadgeHtml(t.status || "scheduled")}
          <button class="btn print-btn tournament-expand-btn" data-tid="${esc(t.id)}"
            style="font-size:0.8rem;padding:4px 12px">${expanded ? "▲ Collapse" : "▼ Manage"}</button>
          <button class="btn print-btn tournament-print-btn" data-tid="${esc(t.id)}"
            style="font-size:0.8rem;padding:4px 12px">🖨 Print</button>
          <button class="btn tournament-delete-btn" data-tid="${esc(t.id)}"
            style="font-size:0.8rem;padding:4px 12px;background:#5a1a1a">Delete</button>
        </div>
      </div>
      ${expanded ? renderDetail(t, linked) : ""}
    </div>`;
}

// ── Bracket Field Assignments ─────────────────────────────────────────────────

function renderBracketFieldAssignments(t, linked) {
  // Detect distinct bracket labels from the linked games' field values
  const bracketNames = [...new Set(linked.map(g => g.field || "").filter(Boolean))].sort();
  if (!bracketNames.length) return "";

  // Build facility + field option lists
  const facOptions = allFacilities.map(f =>
    `<option value="${esc(f.id)}">${esc(f.name)}</option>`
  ).join("");

  const bracketRows = bracketNames.map(bracket => {
    const gamesInBracket  = linked.filter(g => g.field === bracket);
    const currentFacilityId = gamesInBracket[0]?.facilityId || "";
    const currentFacility   = allFacilities.find(f => f.id === currentFacilityId);

    const fieldOpts    = buildFieldOptions(currentFacilityId);
    const currentSubField = gamesInBracket[0]?.subField || "";

    const inputStyle = `padding:5px 8px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:5px;font-size:0.85rem;width:100%;box-sizing:border-box`;

    return `
    <tr>
      <td style="padding:6px 10px;white-space:nowrap">
        <div style="display:flex;align-items:center;gap:6px">
          <input type="text" class="bracket-rename-input"
            data-tid="${esc(t.id)}" data-old-bracket="${esc(bracket)}"
            value="${esc(bracket)}"
            style="${inputStyle};width:140px;font-weight:bold" />
          <button class="btn print-btn bracket-rename-btn"
            data-tid="${esc(t.id)}" data-old-bracket="${esc(bracket)}"
            style="font-size:0.75rem;padding:3px 10px;white-space:nowrap">Rename</button>
        </div>
      </td>
      <td style="padding:6px 8px">
        <select class="bracket-fac-select"
          data-tid="${esc(t.id)}" data-bracket="${esc(bracket)}"
          style="width:100%;padding:6px 8px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px;font-size:0.88rem">
          <option value="">— Facility —</option>
          ${facOptions}
        </select>
      </td>
      <td style="padding:6px 8px">
        <select class="bracket-field-select"
          data-tid="${esc(t.id)}" data-bracket="${esc(bracket)}"
          style="width:100%;padding:6px 8px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px;font-size:0.88rem">
          <option value="">— Field —</option>
          ${fieldOpts}
        </select>
      </td>
      <td style="padding:6px 8px;white-space:nowrap">
        <span style="color:var(--light-text);font-size:0.82rem">
          ${currentFacility ? esc(currentFacility.name) : "—"}
          ${currentSubField ? " · " + esc(currentSubField) : ""}
        </span>
      </td>
      <td style="padding:6px 8px">
        <button class="btn bracket-field-apply-btn"
          data-tid="${esc(t.id)}" data-bracket="${esc(bracket)}"
          style="font-size:0.8rem;padding:4px 14px">Apply</button>
      </td>
    </tr>`;
  }).join("");

  return `
    <div style="margin-bottom:16px;padding:14px;background:rgba(100,180,255,0.05);border:1px solid #2a4a6a;border-radius:8px">
      <div style="color:#7ec8f7;font-size:0.82rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">
        🏟 Bracket Names &amp; Field Assignments
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="color:var(--light-text);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.04em">
              <th style="text-align:left;padding:4px 10px">Bracket Name</th>
              <th style="text-align:left;padding:4px 8px">Facility</th>
              <th style="text-align:left;padding:4px 8px">Field</th>
              <th style="text-align:left;padding:4px 8px">Current</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${bracketRows}</tbody>
        </table>
      </div>
      <p id="bracketFieldMsg_${esc(t.id)}" class="signup-message" style="margin:6px 0 0;min-height:0"></p>
    </div>`;
}

function buildFieldOptions(facilityId) {
  if (!facilityId) return "";
  const fac = allFacilities.find(f => f.id === facilityId);
  if (!fac?.fields?.length) return "";
  return fac.fields
    .filter(f => f.name)
    .map(f => `<option value="${esc(f.name)}">${esc(f.name)}</option>`)
    .join("");
}

async function assignBracketField(tid, bracket) {
  const t = allTournaments.find(x => x.id === tid);
  if (!t) return;

  // Read selected facility + field from the dropdowns
  const facSel   = document.querySelector(`.bracket-fac-select[data-tid="${tid}"][data-bracket="${bracket}"]`);
  const fieldSel = document.querySelector(`.bracket-field-select[data-tid="${tid}"][data-bracket="${bracket}"]`);
  const facilityId = facSel?.value  || "";
  const subField   = fieldSel?.value || "";

  if (!facilityId && !subField) {
    setMsg(`bracketFieldMsg_${tid}`, "Select a facility or field first.", "warning");
    return;
  }

  const games = allGames.filter(g => g.tournamentId === tid && g.field === bracket);
  if (!games.length) {
    setMsg(`bracketFieldMsg_${tid}`, "No games found for this bracket.", "warning");
    return;
  }

  const fac = allFacilities.find(f => f.id === facilityId);
  const confirmMsg = `Apply to all ${games.length} games in ${bracket}?\n\n` +
    `Facility: ${fac ? fac.name : "(unchanged)"}\n` +
    `Field: ${subField || "(unchanged)"}`;
  if (!await showConfirm(confirmMsg)) return;

  setMsg(`bracketFieldMsg_${tid}`, "Saving…", "info");

  try {
    const batch   = writeBatch(db);
    const updates = {};
    if (facilityId) updates.facilityId = facilityId;
    if (subField)   updates.subField   = subField;

    games.forEach(g => {
      batch.update(doc(db, "games", g.id), updates);
    });
    await batch.commit();

    // Update in-memory
    games.forEach(g => { Object.assign(g, updates); });

    const facName = fac ? fac.name : "";
    const label   = [facName, subField].filter(Boolean).join(" · ");
    setMsg(`bracketFieldMsg_${tid}`, `✓ ${games.length} games in ${bracket} updated to ${label || "—"}.`, "success");
    render();
  } catch (err) {
    console.error(err);
    setMsg(`bracketFieldMsg_${tid}`, "Failed: " + err.message, "error");
  }
}

async function renameBracket(tid, oldName, newName) {
  newName = newName.trim();
  if (!newName || newName === oldName) return;

  const t      = allTournaments.find(x => x.id === tid);
  const linked = allGames.filter(g => g.tournamentId === tid && g.field === oldName);
  if (!t) return;

  if (!await showConfirm(
    `Rename "${oldName}" → "${newName}"?\n\nThis will update all ${linked.length} game(s), participants, and bracket advancement rules.`
  )) return;

  setMsg(`bracketFieldMsg_${tid}`, "Renaming…", "info");

  try {
    const batch = writeBatch(db);

    // 1. Update all games in this bracket
    linked.forEach(g => {
      batch.update(doc(db, "games", g.id), { field: newName });
      g.field = newName;
    });

    // 2. Update tournament document — fields array, bracketAdvancement keys, participants
    const tUpdates = {};

    // fields array
    const oldFields = t.fields || [];
    tUpdates.fields = oldFields.map(f => f === oldName ? newName : f);

    // bracketAdvancement
    if (t.bracketAdvancement?.[oldName]) {
      const adv = { ...(t.bracketAdvancement || {}) };
      adv[newName] = adv[oldName];
      delete adv[oldName];
      tUpdates.bracketAdvancement = adv;
      t.bracketAdvancement = adv;
    }

    // participants
    if ((t.participants || []).some(p => p.bracket === oldName)) {
      tUpdates.participants = (t.participants || []).map(p =>
        p.bracket === oldName ? { ...p, bracket: newName } : p
      );
      t.participants = tUpdates.participants;
    }

    batch.update(doc(db, "tournaments", tid), tUpdates);
    t.fields = tUpdates.fields;
    await batch.commit();

    setMsg(`bracketFieldMsg_${tid}`, `✓ Renamed "${oldName}" to "${newName}".`, "success");
    render();
  } catch (err) {
    console.error(err);
    setMsg(`bracketFieldMsg_${tid}`, "Failed: " + err.message, "error");
  }
}

// ── Team Assignments ──────────────────────────────────────────────────────────

function renderTeamAssignments(t, linked) {
  if (!linked.length) return "";

  // Build a shared datalist id scoped to this tournament
  const dlId = `teamDl_${t.id}`;
  // Include both the global teams list and any tournament participants in the datalist
  const dlNames = [...new Set([
    ...allTeams.map(tm => tm.name),
    ...(t.participants || []).map(p => p.teamName)
  ].filter(Boolean))].sort();
  const datalist = `<datalist id="${esc(dlId)}">${dlNames.map(n => `<option value="${esc(n)}">`).join("")}</datalist>`;

  // Group by bracket
  const bracketOrder = [];
  const byBracket    = {};
  linked.forEach(g => {
    const b = g.field || "Games";
    if (!byBracket[b]) { byBracket[b] = []; bracketOrder.push(b); }
    byBracket[b].push(g);
  });

  const inputStyle = `
    padding:5px 8px;background:var(--field);color:var(--text);
    border:1px solid #555;border-radius:5px;font-size:0.85rem;width:100%;box-sizing:border-box`;

  const bracketSections = bracketOrder.map(bracket => {
    const bGames = [...byBracket[bracket]].sort((a, b) => {
      // Sort by game number extracted from notes
      const numA = parseInt((a.notes || "").match(/Game\s+(\d+)/i)?.[1] || "999");
      const numB = parseInt((b.notes || "").match(/Game\s+(\d+)/i)?.[1] || "999");
      return numA - numB || (a.date || "").localeCompare(b.date || "") || (a.time || "").localeCompare(b.time || "");
    });

    const rows = bGames.map(g => {
      const noteMatch = (g.notes || "").match(/Game\s+(\d+)/i);
      const gameLabel = noteMatch ? `Game ${noteMatch[1]}` : "—";
      const ifNec     = (g.notes || "").toLowerCase().includes("if necessary")
        ? ` <span style="color:#ffd966;font-size:0.72rem">(if nec.)</span>` : "";
      const dateTime  = `${esc(fmtDate(g.date))} ${esc(fmtTime(g.time))}`;

      return `<tr>
        <td style="white-space:nowrap;font-size:0.82rem;color:var(--light-text);padding:6px 8px">
          ${esc(gameLabel)}${ifNec}<br>
          <span style="font-size:0.75rem">${dateTime}</span>
        </td>
        <td style="padding:4px 6px;min-width:160px">
          <input type="text" list="${esc(dlId)}"
            class="team-input-home" data-gid="${esc(g.id)}" data-tid="${esc(t.id)}"
            placeholder="Home team…"
            value="${esc(g.homeTeam || "")}"
            style="${inputStyle}" />
        </td>
        <td style="padding:4px 6px;color:var(--light-text);font-size:0.8rem;text-align:center">vs</td>
        <td style="padding:4px 6px;min-width:160px">
          <input type="text" list="${esc(dlId)}"
            class="team-input-away" data-gid="${esc(g.id)}" data-tid="${esc(t.id)}"
            placeholder="Away team…"
            value="${esc(g.awayTeam || "")}"
            style="${inputStyle}" />
        </td>
        <td style="padding:4px 8px;white-space:nowrap">
          <button class="btn print-btn team-save-btn"
            data-gid="${esc(g.id)}" data-tid="${esc(t.id)}"
            style="font-size:0.78rem;padding:4px 12px">Save</button>
          <span class="team-save-status" data-gid="${esc(g.id)}"
            style="font-size:0.75rem;margin-left:6px;display:none"></span>
        </td>
      </tr>`;
    }).join("");

    return `
      <div style="margin-bottom:14px">
        <div style="font-size:0.82rem;font-weight:600;color:#c9a0ff;margin-bottom:6px;
                    padding:4px 10px;background:rgba(100,60,180,0.1);border-left:3px solid #7c44cc;
                    border-radius:0 4px 4px 0">
          🏟 ${esc(bracket)}
        </div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="color:var(--light-text);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em">
                <th style="text-align:left;padding:4px 8px">Game</th>
                <th style="text-align:left;padding:4px 6px">Home Team</th>
                <th></th>
                <th style="text-align:left;padding:4px 6px">Away Team</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join("");

  return `
    ${datalist}
    <div style="margin-bottom:16px;padding:14px;background:rgba(180,255,150,0.04);border:1px solid #2a4a2a;border-radius:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px">
        <div style="color:#86efac;font-size:0.82rem;text-transform:uppercase;letter-spacing:0.05em">
          👕 Team Seedings
        </div>
        <button class="btn print-btn team-save-all-btn" data-tid="${esc(t.id)}"
          style="font-size:0.8rem;padding:4px 14px">Save All</button>
      </div>
      ${bracketSections}
      <p id="teamAssignMsg_${esc(t.id)}" class="signup-message" style="margin:4px 0 0;min-height:0"></p>
    </div>`;
}

async function saveGameTeams(tid, gameId, homeTeam, awayTeam) {
  const g = allGames.find(x => x.id === gameId);
  if (!g) return;
  try {
    await updateDoc(doc(db, "games", gameId), { homeTeam: homeTeam.trim(), awayTeam: awayTeam.trim() });
    g.homeTeam = homeTeam.trim();
    g.awayTeam = awayTeam.trim();
    return true;
  } catch (err) {
    console.error("saveGameTeams:", err);
    throw err;
  }
}

// ── Umpire management ─────────────────────────────────────────────────────────

async function loadApprovedUmpires() {
  if (approvedUmpires.length) return;
  try {
    const snap = await getDocs(query(collection(db, "umpires"), where("approved", "==", true), orderBy("name")));
    approvedUmpires = snap.docs.map(d => ({
      uid:   d.id,
      name:  d.data().name  || "",
      email: d.data().email || "",
      phone: d.data().phone || "",
    }));
  } catch (err) { console.error("loadApprovedUmpires:", err); }
}

async function loadAllAvailability() {
  try {
    const snap = await getDocs(collection(db, "availability"));
    umpireUnavailable = {};
    snap.forEach(d => { umpireUnavailable[d.id] = new Set(d.data().unavailableDates || []); });
  } catch (err) { console.error("loadAllAvailability:", err); }
}

function renderUmpireManagement(t, linked) {
  if (!linked.length) return "";

  const sorted = [...linked].sort((a, b) =>
    (a.date || "").localeCompare(b.date || "") ||
    (a.time || "").localeCompare(b.time || "")
  );

  const slotBg = { Plate: "#1a2a3a", Field: "#1a2a1a", Extra: "#2a1a2a" };
  const slotColor = { Plate: "#7ec8f7", Field: "#86efac", Extra: "#c4b5fd" };

  const gameRows = sorted.map(g => {
    const noteMatch  = (g.notes || "").match(/Game\s+(\d+)/i);
    const gameLabel  = noteMatch ? `Game ${noteMatch[1]}` : "—";
    const ifNec      = (g.notes || "").toLowerCase().includes("if necessary");
    const slots      = g.umpireSlots || [];
    const matchup    = (g.homeTeam || g.awayTeam)
      ? `${esc(g.homeTeam || "TBD")} <span style="color:var(--light-text)">vs</span> ${esc(g.awayTeam || "TBD")}`
      : `<span style="color:var(--light-text)">Teams TBD</span>`;

    const slotBtns = slots.length
      ? slots.map(s => {
          const color = slotColor[s.type] || "#aaa";
          const bg    = slotBg[s.type]    || "#1a1a1a";
          const badge = `<span class="badge" style="background:${bg};color:${color}">${esc(s.type)}</span>`;
          if (s.assignedUid) {
            return `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              ${badge}
              <span style="font-weight:bold;font-size:0.88rem">${esc(s.assignedName || s.assignedUid)}</span>
              <button class="btn print-btn tm-unassign-btn"
                data-gid="${esc(g.id)}" data-slot="${esc(s.type)}" data-uid="${esc(s.assignedUid)}"
                style="font-size:0.75rem;padding:2px 8px">Unassign</button>
            </div>`;
          }
          return `<div style="display:flex;align-items:center;gap:6px">
            ${badge}
            <span style="color:var(--light-text);font-size:0.85rem">Open</span>
            <button class="btn tm-assign-btn"
              data-gid="${esc(g.id)}" data-slot="${esc(s.type)}"
              data-date="${esc(g.date || "")}" data-time="${esc(g.time || "")}"
              style="font-size:0.75rem;padding:2px 10px">Assign</button>
          </div>`;
        }).join("")
      : `<span style="color:var(--light-text);font-size:0.82rem">No slots configured</span>`;

    const openCount = slots.filter(s => !s.assignedUid && !g.cancelled).length;
    const statusDot = g.cancelled
      ? `<span style="color:#f87171;font-size:0.75rem">Cancelled</span>`
      : openCount > 0
        ? `<span style="color:#fbbf24;font-size:0.75rem">⚠ ${openCount} open</span>`
        : slots.length > 0
          ? `<span style="color:#86efac;font-size:0.75rem">✓ Filled</span>`
          : "";

    return `
      <div style="padding:12px 14px;border-bottom:1px solid #333;display:grid;
                  grid-template-columns:110px 1fr 1fr;gap:12px;align-items:start">
        <div>
          <div style="font-size:0.82rem;color:var(--light-text)">${esc(fmtDate(g.date))}</div>
          <div style="font-weight:bold">${esc(fmtTime(g.time))}</div>
          <div style="font-size:0.78rem;color:var(--light-text);margin-top:2px">
            ${g.field ? `<span class="badge" style="background:#1a2a3a;color:#7ec8f7;font-size:0.72rem">${esc(g.field)}</span>` : ""}
            ${esc(gameLabel)}${ifNec ? ' <em style="color:#ffd966">(if nec.)</em>' : ""}
          </div>
          <div style="margin-top:4px">${statusDot}</div>
        </div>
        <div>
          <div style="font-size:0.88rem;margin-bottom:4px">${matchup}</div>
          <div style="font-size:0.78rem;color:var(--light-text)">${esc(g.city || "")} ${esc(g.division || "")}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px">${slotBtns}</div>
      </div>`;
  }).join("");

  const openTotal = linked.filter(g => !g.cancelled)
    .reduce((n, g) => n + (g.umpireSlots || []).filter(s => !s.assignedUid).length, 0);
  const totalSlots = linked.filter(g => !g.cancelled)
    .reduce((n, g) => n + (g.umpireSlots || []).length, 0);

  return `
    <div style="margin-bottom:16px;border:1px solid #2a4a2a;border-radius:8px;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;
                  padding:12px 14px;background:rgba(134,239,172,0.06)">
        <div style="color:#86efac;font-size:0.82rem;text-transform:uppercase;letter-spacing:0.05em">
          🧑‍⚖️ Umpire Assignments
        </div>
        <span style="font-size:0.82rem;color:var(--light-text)">
          ${totalSlots - openTotal} / ${totalSlots} slots filled
        </span>
      </div>
      <div>${gameRows || `<p style="padding:14px;color:var(--light-text);margin:0">No games linked yet.</p>`}</div>
      <p id="tmUmpireMsg_${esc(t.id)}" class="signup-message" style="margin:6px 14px;min-height:0"></p>
    </div>`;
}

function renderAssignModalList(filter = "") {
  const list  = document.getElementById("tmAssignList");
  if (!list) return;
  const lower = filter.toLowerCase();
  const date  = _assignTarget?.gameDate || "";
  const time  = _assignTarget?.gameTime || "";
  const shown = approvedUmpires.filter(u =>
    !filter || u.name.toLowerCase().includes(lower) || u.email.toLowerCase().includes(lower)
  );
  if (!shown.length) {
    list.innerHTML = `<p style="padding:12px 16px;color:var(--light-text);margin:0">No matching umpires.</p>`;
    return;
  }
  list.innerHTML = shown.map(u => {
    const unavail  = date && umpireUnavailable[u.uid]?.has(date);
    const conflict = date && time && allGames.some(g =>
      g.id !== _assignTarget?.gameId && g.date === date && g.time === time &&
      !g.cancelled && (g.umpireSlots || []).some(s => s.assignedUid === u.uid)
    );
    const badges = [
      unavail  ? `<span style="font-size:0.75rem;color:#fca;background:#5a2000;border-radius:4px;padding:2px 7px">Unavailable</span>` : "",
      conflict ? `<span style="font-size:0.75rem;color:#f88;background:#4a0000;border-radius:4px;padding:2px 7px">Conflict</span>` : "",
    ].filter(Boolean).join(" ");
    return `
      <div class="tm-assign-row" data-uid="${esc(u.uid)}" data-name="${esc(u.name)}"
        style="padding:10px 16px;cursor:pointer;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-weight:bold;display:flex;align-items:center;flex-wrap:wrap;gap:4px">
            ${esc(u.name)}${badges ? ` ${badges}` : ""}
          </div>
          ${u.email ? `<div style="font-size:0.8rem;color:var(--light-text)">${esc(u.email)}</div>` : ""}
        </div>
        <button class="btn print-btn" style="font-size:0.8rem;padding:4px 12px;flex-shrink:0">Assign</button>
      </div>`;
  }).join("");
}

async function openTmAssignModal(gameId, slotType, gameDate, gameTime) {
  _assignTarget = { gameId, slotType, gameDate, gameTime };
  const game = allGames.find(g => g.id === gameId);
  const noteMatch = (game?.notes || "").match(/Game\s+(\d+)/i);
  const label = [
    noteMatch ? `Game ${noteMatch[1]}` : "",
    slotType,
    game ? `${fmtDate(game.date)} ${fmtTime(game.time)}` : "",
    game?.city || "",
  ].filter(Boolean).join(" · ");
  const labelEl = document.getElementById("tmAssignLabel");
  if (labelEl) labelEl.textContent = label;
  const msgEl = document.getElementById("tmAssignMsg");
  if (msgEl) { msgEl.textContent = ""; msgEl.className = "signup-message"; }
  document.getElementById("tmAssignSearch").value = "";
  await Promise.all([loadApprovedUmpires(), loadAllAvailability()]);
  renderAssignModalList();
  document.getElementById("tmAssignModal").style.display = "flex";
  document.getElementById("tmAssignSearch").focus();
}

async function doTmAssign(uid, name) {
  if (!_assignTarget) return;
  const { gameId, slotType } = _assignTarget;
  const msgEl = document.getElementById("tmAssignMsg");
  if (msgEl) { msgEl.textContent = "Saving…"; msgEl.className = "signup-message info"; }
  try {
    const gameRef = doc(db, "games", gameId);
    let updatedSlots;
    await runTransaction(db, async tx => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game not found.");
      const current = snap.data().umpireSlots || [];
      const target  = current.find(s => s.type === slotType);
      if (target?.assignedUid && target.assignedUid !== uid) {
        throw new Error("Slot was just assigned to someone else. Refresh and try again.");
      }
      updatedSlots = current.map(s =>
        s.type === slotType ? { ...s, assignedUid: uid, assignedName: name } : s
      );
      tx.update(gameRef, { umpireSlots: updatedSlots, needsUmpires: updatedSlots.some(s => !s.assignedUid) });
    });
    const g = allGames.find(g => g.id === gameId);
    if (g) { g.umpireSlots = updatedSlots; g.needsUmpires = updatedSlots.some(s => !s.assignedUid); }
    document.getElementById("tmAssignModal").style.display = "none";
    render();
  } catch (err) {
    if (msgEl) { msgEl.textContent = err.message; msgEl.className = "signup-message error"; }
  }
}

async function doTmUnassign(gameId, slotType, targetUid) {
  if (!await showConfirm(`Unassign ${slotType} umpire from this game?`)) return;
  try {
    const gameRef = doc(db, "games", gameId);
    let updatedSlots;
    await runTransaction(db, async tx => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game not found.");
      updatedSlots = (snap.data().umpireSlots || []).map(s =>
        (s.type === slotType && s.assignedUid === targetUid)
          ? { type: s.type, payRate: s.payRate ?? null, assignedUid: null, assignedName: null, checkedIn: false, checkedInAt: null, paid: false, noShow: false }
          : s
      );
      tx.update(gameRef, { umpireSlots: updatedSlots, needsUmpires: true });
    });
    const g = allGames.find(g => g.id === gameId);
    if (g) { g.umpireSlots = updatedSlots; g.needsUmpires = true; }
    render();
  } catch (err) {
    showToast("Failed to unassign: " + err.message);
  }
}

function renderDetail(t, linked) {
  const tid = t.id;

  // Status buttons
  const statusBtns = [
    { key: "scheduled",    label: "Scheduled"   },
    { key: "active",       label: "Active"       },
    { key: "rain-delay",   label: "Rain Delay"  },
    { key: "complete",     label: "Complete"     }
  ].map(({ key, label }) => {
    const cur = (t.status || "scheduled") === key;
    return `<button class="btn ${cur ? "" : "print-btn"} tournament-status-btn"
      data-tid="${esc(tid)}" data-status="${key}"
      style="font-size:0.8rem;padding:4px 12px" ${cur ? "disabled" : ""}>${label}</button>`;
  }).join("");

  // Game rows — sorted by time
  const sorted = [...linked].sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  const gameRows = sorted.length
    ? sorted.map(g => {
        const umpires = (g.umpireSlots || []).map(s =>
          s.assignedName
            ? `${s.type}: <strong>${esc(s.assignedName)}</strong>`
            : `${s.type}: <em style="color:var(--light-text)">unassigned</em>`
        ).join(" · ") || `<em style="color:var(--light-text)">No slots</em>`;

        return `<tr>
          <td style="text-align:center">
            <input type="checkbox" class="swap-select" data-gid="${esc(g.id)}" data-tid="${esc(tid)}"
              style="width:16px;height:16px;cursor:pointer">
          </td>
          <td style="white-space:nowrap">${esc(fmtTime(g.time))}</td>
          <td>${esc(g.field || "—")}</td>
          <td style="font-size:0.85rem">${esc(g.city || "")} ${esc(g.division || "")}</td>
          <td style="font-size:0.85rem">${umpires}</td>
          <td>
            <button class="btn print-btn tournament-unlink-btn" data-gid="${esc(g.id)}" data-tid="${esc(tid)}"
              style="font-size:0.75rem;padding:2px 8px">Unlink</button>
          </td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" style="color:var(--light-text);text-align:center;padding:12px">No games linked yet. Add games below.</td></tr>`;

  // Linkable games — same date, not already in a tournament, not cancelled
  const linkable = allGames.filter(g =>
    g.date === t.date && !g.tournamentId && !g.cancelled
  );
  const linkOptions = linkable.length
    ? linkable.map(g =>
        `<option value="${esc(g.id)}">${esc(fmtDate(g.date))} ${esc(fmtTime(g.time))} — ${esc(g.city || "")} ${esc(g.division || "")}${g.field ? " · " + esc(g.field) : ""}</option>`
      ).join("")
    : "";

  const rainTotal = t.rainDelayMinutes || 0;

  // Section jump nav items
  const jumpLinks = [
    { anchor: `ts-status-${tid}`,   icon: "📋", label: "Status"         },
    { anchor: `ts-rain-${tid}`,     icon: "⛈",  label: "Rain Delay"    },
    { anchor: `ts-umpires-${tid}`,  icon: "🧑‍⚖️", label: "Umpires"      },
    { anchor: `ts-teams-${tid}`,    icon: "👥",  label: "Teams"         },
    { anchor: `ts-bracketf-${tid}`, icon: "🏟",  label: "Bracket Fields"},
    { anchor: `ts-seedings-${tid}`, icon: "👕",  label: "Seedings"      },
    { anchor: `ts-flow-${tid}`,     icon: "🔀",  label: "Bracket Flow"  },
    { anchor: `ts-rules-${tid}`,    icon: "📜",  label: "Rules"         },
    { anchor: `ts-games-${tid}`,    icon: "⚾",  label: "Games"         },
  ].map(({ anchor, icon, label }) =>
    `<a href="#${anchor}"
       style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;
              background:rgba(255,255,255,0.05);border:1px solid #444;border-radius:20px;
              color:var(--light-text);font-size:0.78rem;text-decoration:none;white-space:nowrap;
              transition:background 0.15s"
       onmouseover="this.style.background='rgba(255,255,255,0.12)'"
       onmouseout="this.style.background='rgba(255,255,255,0.05)'">${icon} ${label}</a>`
  ).join("");

  return `
    <hr style="border-color:#444;margin:16px 0">

    <!-- Section jump nav -->
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px;padding:10px 12px;
                background:#111;border:1px solid #333;border-radius:8px">
      <span style="font-size:0.75rem;color:var(--light-text);align-self:center;margin-right:4px;white-space:nowrap">Jump to:</span>
      ${jumpLinks}
    </div>

    <!-- Status -->
    <div id="ts-status-${esc(tid)}" style="margin-bottom:16px;scroll-margin-top:16px">
      <div style="color:var(--light-text);font-size:0.82rem;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em">📋 Tournament Status</div>
      <div class="page-actions" style="margin:0;flex-wrap:wrap;gap:6px">${statusBtns}</div>
    </div>

    <!-- Rain Delay -->
    <div id="ts-rain-${esc(tid)}" style="margin-bottom:16px;scroll-margin-top:16px;padding:14px;background:rgba(255,217,102,0.06);border:1px solid #5a4a00;border-radius:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px">
        <div>
          <strong style="color:#ffd966">⛈ Rain Delay</strong>
          <span style="color:var(--light-text);font-size:0.85rem;margin-left:10px">
            ${rainTotal > 0 ? `${rainTotal} min added to all game times` : "No delay applied yet"}
          </span>
        </div>
        ${rainTotal > 0
          ? `<button class="btn print-btn tournament-reset-delay-btn" data-tid="${esc(tid)}"
               style="font-size:0.8rem;padding:4px 10px">↩ Restore Original Times</button>`
          : ""}
      </div>
      <div class="page-actions" style="margin:0;gap:6px">
        <button class="btn print-btn tournament-delay-btn" data-tid="${esc(tid)}" data-minutes="15"
          style="font-size:0.85rem;padding:5px 14px">+15 min</button>
        <button class="btn print-btn tournament-delay-btn" data-tid="${esc(tid)}" data-minutes="30"
          style="font-size:0.85rem;padding:5px 14px">+30 min</button>
        <button class="btn print-btn tournament-delay-btn" data-tid="${esc(tid)}" data-minutes="60"
          style="font-size:0.85rem;padding:5px 14px">+60 min</button>
      </div>
      <p id="delayMsg_${esc(tid)}" class="signup-message" style="margin:6px 0 0;min-height:0"></p>
    </div>

    <!-- Umpire Assignments -->
    <div id="ts-umpires-${esc(tid)}" style="scroll-margin-top:16px">
      ${renderUmpireManagement(t, linked)}
    </div>

    <!-- Participants -->
    <div id="ts-teams-${esc(tid)}" style="scroll-margin-top:16px">
      ${renderParticipants(t, linked)}
    </div>

    <!-- Bracket Field Assignments -->
    <div id="ts-bracketf-${esc(tid)}" style="scroll-margin-top:16px">
      ${renderBracketFieldAssignments(t, linked)}
    </div>

    <!-- Team Seedings -->
    <div id="ts-seedings-${esc(tid)}" style="scroll-margin-top:16px">
      ${renderTeamAssignments(t, linked)}
    </div>

    <!-- Bracket Flow -->
    <div id="ts-flow-${esc(tid)}" style="scroll-margin-top:16px">
      ${renderBracketFlow(t, linked)}
    </div>

    <!-- Tournament Rules -->
    <div id="ts-rules-${esc(tid)}" style="scroll-margin-top:16px">
      ${renderRulesEditor(t)}
    </div>

    <!-- Games + Swap -->
    <div id="ts-games-${esc(tid)}" style="margin-bottom:12px;scroll-margin-top:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <strong>⚾ Linked Games (${linked.length})</strong>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="color:var(--light-text);font-size:0.82rem">Check 2 games, then:</span>
          <button class="btn tournament-swap-btn" data-tid="${esc(tid)}"
            style="font-size:0.82rem;padding:5px 14px">⇄ Swap Umpires</button>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th style="width:32px"></th>
              <th>Time</th>
              <th>Field</th>
              <th>Game</th>
              <th>Umpire Assignments</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${gameRows}</tbody>
        </table>
      </div>
      <p id="swapMsg_${esc(tid)}" class="signup-message" style="margin:6px 0 0;min-height:0"></p>
    </div>

    <!-- Link a game -->
    ${linkable.length ? `
    <div style="padding:14px;background:#1a1a1a;border-radius:8px;border:1px solid #444">
      <div style="color:var(--light-text);font-size:0.82rem;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.04em">Add Existing Game to Tournament</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select id="linkGameSelect_${esc(tid)}"
          style="flex:1;min-width:200px;padding:8px 10px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px">
          <option value="">-- Select game --</option>
          ${linkOptions}
        </select>
        <button class="btn tournament-link-btn" data-tid="${esc(tid)}"
          style="font-size:0.85rem;padding:6px 14px">Add</button>
      </div>
    </div>` : ""}
    ${!linkable.length && !linked.length ? `<p style="color:var(--light-text);font-size:0.85rem;margin-top:8px">No unlinked games on ${esc(fmtDate(t.date))}. Add games for this date on the <a href="admin-games.html">Games</a> page first.</p>` : ""}
    <p id="tournamentMsg_${esc(tid)}" class="signup-message" style="margin:8px 0 0;min-height:0"></p>
  `;
}

// ── Create Tournament ─────────────────────────────────────────────────────────

async function createTournament(e) {
  e.preventDefault();
  const name     = document.getElementById("tName").value.trim();
  const date     = document.getElementById("tDate").value;
  const location = document.getElementById("tLocation").value.trim();
  const division = document.getElementById("tDivision").value;
  const fieldsRaw = document.getElementById("tFields").value;
  const notes    = document.getElementById("tNotes").value.trim();

  if (!name || !date) {
    setMsg("createTournamentMsg", "Name and date are required.", "error");
    return;
  }

  const fields = fieldsRaw.split(",").map(f => f.trim()).filter(Boolean);

  setMsg("createTournamentMsg", "Creating…", "info");
  try {
    const ref = await addDoc(collection(db, "tournaments"), {
      name, date, location, division, fields, notes,
      status: "scheduled",
      rainDelayMinutes: 0,
      originalTimes: {},
      createdAt: serverTimestamp()
    });
    e.target.reset();
    setMsg("createTournamentMsg", `Tournament "${name}" created.`, "success");
    // Optimistically add + expand, then switch to Manage tab
    allTournaments.unshift({ id: ref.id, name, date, location, division, fields, notes, status: "scheduled", rainDelayMinutes: 0, originalTimes: {} });
    expandedTid = ref.id;
    render();
    setTimeout(() => switchTournTab("manage"), 800);
  } catch (err) {
    console.error(err);
    setMsg("createTournamentMsg", err.message, "error");
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

async function setStatus(tid, status) {
  try {
    await updateDoc(doc(db, "tournaments", tid), { status });
    const t = allTournaments.find(x => x.id === tid);
    if (t) t.status = status;
    render();
  } catch (err) {
    console.error(err);
    showToast("Failed to update status: " + err.message);
  }
}

// ── Rain Delay ────────────────────────────────────────────────────────────────

async function applyDelay(tid, minutes) {
  const t      = allTournaments.find(x => x.id === tid);
  const linked = allGames.filter(g => g.tournamentId === tid && !g.cancelled);
  if (!t) return;

  if (!linked.length) {
    setMsg(`delayMsg_${tid}`, "No linked games to delay.", "warning");
    return;
  }

  setMsg(`delayMsg_${tid}`, "Applying delay…", "info");

  try {
    // Snapshot original times before first delay
    const origTimes = { ...(t.originalTimes || {}) };
    linked.forEach(g => {
      if (!origTimes[g.id]) origTimes[g.id] = g.time || "";
    });

    const planned = linked.map(g => ({
      game:    g,
      newTime: addMinutesToTime(g.time || "09:00", minutes),
      ref:     doc(db, "games", g.id)
    }));

    const newDelay  = (t.rainDelayMinutes || 0) + minutes;
    const rainBatch = writeBatch(db);
    planned.forEach(p => rainBatch.update(p.ref, { time: p.newTime }));
    rainBatch.update(doc(db, "tournaments", tid), {
      rainDelayMinutes: newDelay,
      originalTimes: origTimes,
    });
    await rainBatch.commit();

    // Mutate in-memory only after all writes succeed
    planned.forEach(p => { p.game.time = p.newTime; });
    t.rainDelayMinutes = newDelay;
    t.originalTimes    = origTimes;

    setMsg(`delayMsg_${tid}`,
      `+${minutes} min applied to ${linked.length} game${linked.length !== 1 ? "s" : ""}.`,
      "success");
    render();
  } catch (err) {
    console.error(err);
    setMsg(`delayMsg_${tid}`, "Failed: " + err.message, "error");
  }
}

// ── Reset Delay ───────────────────────────────────────────────────────────────

async function resetDelay(tid) {
  const t = allTournaments.find(x => x.id === tid);
  if (!t || !t.originalTimes || !Object.keys(t.originalTimes).length) return;
  if (!await showConfirm("Restore all linked games to their original start times?")) return;

  const linked = allGames.filter(g => g.tournamentId === tid);
  setMsg(`delayMsg_${tid}`, "Resetting…", "info");

  try {
    const resetBatch  = writeBatch(db);
    const restorations = [];
    linked.forEach(g => {
      const orig = t.originalTimes[g.id];
      if (!orig) return;
      restorations.push({ g, orig });
      resetBatch.update(doc(db, "games", g.id), { time: orig });
    });
    resetBatch.update(doc(db, "tournaments", tid), { rainDelayMinutes: 0, originalTimes: {} });
    await resetBatch.commit();

    // Mutate in-memory only after the batch succeeds
    restorations.forEach(({ g, orig }) => { g.time = orig; });
    t.rainDelayMinutes = 0;
    t.originalTimes    = {};
    setMsg(`delayMsg_${tid}`, "All times restored to original.", "success");
    render();
  } catch (err) {
    console.error(err);
    setMsg(`delayMsg_${tid}`, "Failed: " + err.message, "error");
  }
}

// ── Swap Umpires ──────────────────────────────────────────────────────────────

async function swapUmpires(tid, gid1, gid2) {
  const g1 = allGames.find(g => g.id === gid1);
  const g2 = allGames.find(g => g.id === gid2);
  const t  = allTournaments.find(x => x.id === tid);
  if (!g1 || !g2 || !t) return;

  const slots1 = g1.umpireSlots || [];
  const slots2 = g2.umpireSlots || [];

  const label1 = `${fmtTime(g1.time)} ${g1.field ? "· " + g1.field : ""}`.trim();
  const label2 = `${fmtTime(g2.time)} ${g2.field ? "· " + g2.field : ""}`.trim();

  if (!await showConfirm(`Swap all umpire assignments between:\n\n  ${label1}\n  ${label2}\n\nAffected umpires will receive a push notification. Proceed?`)) return;

  setMsg(`swapMsg_${tid}`, "Swapping…", "info");

  try {
    const swapBatch = writeBatch(db);
    swapBatch.update(doc(db, "games", gid1), { umpireSlots: slots2 });
    swapBatch.update(doc(db, "games", gid2), { umpireSlots: slots1 });
    await swapBatch.commit();

    // Update in-memory
    g1.umpireSlots = slots2;
    g2.umpireSlots = slots1;

    // Notify via Cloud Function (non-critical)
    notifySwap({
      tournamentId:   tid,
      tournamentName: t.name,
      game1:  { id: gid1, field: g1.field || "", time: label1 },
      game2:  { id: gid2, field: g2.field || "", time: label2 },
      // After the swap, game1 has slots2 and game2 has slots1
      umpires1: slots2.filter(s => s.assignedUid).map(s => ({ uid: s.assignedUid, name: s.assignedName || "" })),
      umpires2: slots1.filter(s => s.assignedUid).map(s => ({ uid: s.assignedUid, name: s.assignedName || "" }))
    }).catch(err => console.warn("Swap notification failed:", err));

    // Uncheck all checkboxes for this tournament
    document.querySelectorAll(`.swap-select[data-tid="${tid}"]`)
      .forEach(cb => { cb.checked = false; });

    setMsg(`swapMsg_${tid}`, "Assignments swapped. Notifications sent.", "success");
    render();
  } catch (err) {
    console.error(err);
    setMsg(`swapMsg_${tid}`, "Failed: " + err.message, "error");
  }
}

// ── Link / Unlink Games ───────────────────────────────────────────────────────

async function linkGame(tid, gameId) {
  if (!gameId) {
    setMsg(`tournamentMsg_${tid}`, "Select a game to add.", "warning");
    return;
  }
  try {
    await updateDoc(doc(db, "games", gameId), { tournamentId: tid });
    const g = allGames.find(x => x.id === gameId);
    if (g) g.tournamentId = tid;
    render();
  } catch (err) {
    console.error(err);
    showToast("Failed to link game: " + err.message);
  }
}

async function unlinkGame(gameId, tid) {
  if (!await showConfirm("Remove this game from the tournament? The game itself will not be deleted.")) return;
  try {
    await updateDoc(doc(db, "games", gameId), { tournamentId: null });
    const g = allGames.find(x => x.id === gameId);
    if (g) g.tournamentId = null;
    render();
  } catch (err) {
    console.error(err);
    showToast("Failed to unlink game: " + err.message);
  }
}

// ── Delete Tournament ─────────────────────────────────────────────────────────

async function deleteTournament(tid) {
  const t      = allTournaments.find(x => x.id === tid);
  const linked = allGames.filter(g => g.tournamentId === tid);
  if (!t) return;

  const msg = `Delete tournament "${t.name}"?${linked.length
    ? `\n\n${linked.length} linked game${linked.length !== 1 ? "s" : ""} will be unlinked (not deleted).`
    : ""}`;
  if (!await showConfirm(msg)) return;

  try {
    // Unlink all games first
    await Promise.all(linked.map(g =>
      updateDoc(doc(db, "games", g.id), { tournamentId: null })
    ));
    linked.forEach(g => { g.tournamentId = null; });

    await deleteDoc(doc(db, "tournaments", tid));
    allTournaments = allTournaments.filter(x => x.id !== tid);
    if (expandedTid === tid) expandedTid = null;
    render();
  } catch (err) {
    console.error(err);
    showToast("Failed to delete tournament: " + err.message);
  }
}

// ── Participants ──────────────────────────────────────────────────────────────

// Seed-to-game matchup maps (home seed, away seed) for each first-round game
const SEED_MATCHUPS = {
  "8-team-de": [
    // [gameNum, homeSeed, awaySeed]
    [1, 1, 8],
    [2, 4, 5],
    [3, 2, 7],
    [4, 3, 6],
  ],
  "9-team-de": [
    [1, 8, 9],      // play-in
    [2, 2, 7],
    [3, 3, 6],
    [4, 4, 5],
    [5, 1, null],   // null = W(G1), set after G1 played
  ]
};

function renderParticipants(t, linked) {
  const participants = t.participants || [];
  const brackets     = [...new Set(linked.map(g => g.field || "").filter(Boolean))].sort();

  // Sort participants: bracket → seed
  const sorted = [...participants].sort((a, b) =>
    (a.bracket || "").localeCompare(b.bracket || "") ||
    (a.seed || 99) - (b.seed || 99)
  );

  const teamOpts = allTeams.map(tm =>
    `<option value="${esc(tm.name)}">`
  ).join("");

  const inSel = `padding:4px 6px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:5px;font-size:0.82rem;box-sizing:border-box`;

  // Participant rows
  const rows = sorted.length ? sorted.map((p, i) => `
    <tr>
      <td style="white-space:nowrap;font-size:0.82rem">
        <select class="participant-bracket-sel"
          data-tid="${esc(t.id)}" data-idx="${i}"
          style="${inSel};width:100px">
          ${brackets.map(b => `<option value="${esc(b)}"${b === p.bracket ? " selected" : ""}>${esc(b)}</option>`).join("")}
          ${!brackets.includes(p.bracket) && p.bracket ? `<option value="${esc(p.bracket)}" selected>${esc(p.bracket)}</option>` : ""}
          ${!p.bracket ? `<option value="" selected>—</option>` : ""}
        </select>
        <input type="number" class="participant-seed-inp"
          data-tid="${esc(t.id)}" data-idx="${i}"
          min="1" max="99" value="${p.seed || ""}" placeholder="#"
          style="${inSel};width:50px;text-align:center;margin-left:4px" />
      </td>
      <td style="font-weight:bold">${esc(p.teamName || "—")}</td>
      <td style="font-size:0.85rem">${esc(p.coachName || "—")}</td>
      <td style="font-size:0.82rem">
        ${p.coachPhone ? `<a href="tel:${esc(p.coachPhone)}" style="color:#ffd580">${esc(p.coachPhone)}</a>` : ""}
        ${p.coachPhone && p.coachEmail ? "<br>" : ""}
        ${p.coachEmail ? `<a href="mailto:${esc(p.coachEmail)}" style="color:#7ec8f7;font-size:0.78rem">${esc(p.coachEmail)}</a>` : ""}
        ${!p.coachPhone && !p.coachEmail ? `<span style="color:var(--light-text)">—</span>` : ""}
      </td>
      <td style="white-space:nowrap">
        <button class="btn participant-save-btn"
          data-tid="${esc(t.id)}" data-idx="${i}"
          style="font-size:0.75rem;padding:2px 8px">Save</button>
        <button class="btn print-btn participant-remove-btn"
          data-tid="${esc(t.id)}" data-idx="${i}"
          style="font-size:0.75rem;padding:2px 8px;margin-left:4px">Remove</button>
      </td>
    </tr>`) .join("") : `
    <tr><td colspan="5" style="color:var(--light-text);text-align:center;padding:10px;font-size:0.85rem">
      No teams added yet.
    </td></tr>`;

  const bracketOpts = brackets.map(b =>
    `<option value="${esc(b)}">${esc(b)}</option>`
  ).join("");

  const inputStyle = `padding:6px 8px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:5px;font-size:0.85rem;width:100%;box-sizing:border-box`;

  return `
    <datalist id="participantTeamDl_${esc(t.id)}">${teamOpts}</datalist>
    <div style="margin-bottom:16px;padding:14px;background:rgba(120,120,255,0.04);border:1px solid #2a2a5a;border-radius:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px">
        <div style="color:#c4b5fd;font-size:0.82rem;text-transform:uppercase;letter-spacing:0.05em">
          👥 Participating Teams (${participants.length})
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn print-btn participant-import-btn" data-tid="${esc(t.id)}"
            style="font-size:0.8rem;padding:4px 14px">📥 Import from Spreadsheet</button>
          <button class="btn print-btn participant-apply-seeds-btn" data-tid="${esc(t.id)}"
            style="font-size:0.8rem;padding:4px 14px" title="Set round 1 game teams from seed assignments">
            🌱 Apply Seeds to Games
          </button>
        </div>
      </div>

      <div style="overflow-x:auto;margin-bottom:14px">
        <table>
          <thead><tr style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--light-text)">
            <th>Bracket / Seed</th><th>Team Name</th><th>Coach</th><th>Contact</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <!-- Add team form -->
      <details style="margin-top:4px">
        <summary style="cursor:pointer;color:#c4b5fd;font-size:0.85rem;user-select:none;list-style:none;display:flex;align-items:center;gap:6px">
          <span>＋ Add Team</span>
        </summary>
        <div style="margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:8px 16px">
          <div>
            <label style="font-size:0.78rem;color:var(--light-text);display:block;margin-bottom:3px">Team Name *</label>
            <input type="text" id="pt_teamName_${esc(t.id)}" list="participantTeamDl_${esc(t.id)}"
              placeholder="Select or type team name…" style="${inputStyle}" />
          </div>
          <div style="display:flex;gap:8px">
            <div style="flex:1">
              <label style="font-size:0.78rem;color:var(--light-text);display:block;margin-bottom:3px">Bracket *</label>
              <select id="pt_bracket_${esc(t.id)}" style="${inputStyle}">
                ${bracketOpts || `<option value="">—</option>`}
              </select>
            </div>
            <div style="width:70px">
              <label style="font-size:0.78rem;color:var(--light-text);display:block;margin-bottom:3px">Seed *</label>
              <input type="number" id="pt_seed_${esc(t.id)}" min="1" max="9" placeholder="#"
                style="${inputStyle};text-align:center" />
            </div>
          </div>
          <div>
            <label style="font-size:0.78rem;color:var(--light-text);display:block;margin-bottom:3px">Coach Name</label>
            <input type="text" id="pt_coachName_${esc(t.id)}" placeholder="Coach full name"
              style="${inputStyle}" />
          </div>
          <div style="display:flex;gap:8px">
            <div style="flex:1">
              <label style="font-size:0.78rem;color:var(--light-text);display:block;margin-bottom:3px">Phone</label>
              <input type="tel" id="pt_coachPhone_${esc(t.id)}" placeholder="605-555-0100"
                style="${inputStyle}" />
            </div>
            <div style="flex:1">
              <label style="font-size:0.78rem;color:var(--light-text);display:block;margin-bottom:3px">Email</label>
              <input type="email" id="pt_coachEmail_${esc(t.id)}" placeholder="coach@email.com"
                style="${inputStyle}" />
            </div>
          </div>
        </div>
        <div class="page-actions" style="margin-top:10px">
          <button class="btn participant-add-btn" data-tid="${esc(t.id)}"
            style="font-size:0.85rem;padding:6px 18px">Add Team</button>
        </div>
        <p id="participantMsg_${esc(t.id)}" class="signup-message" style="margin:4px 0 0;min-height:0"></p>
      </details>

      <p id="seedApplyMsg_${esc(t.id)}" class="signup-message" style="margin:8px 0 0;min-height:0"></p>
    </div>`;
}

async function addParticipant(tid) {
  const t = allTournaments.find(x => x.id === tid);
  if (!t) return;

  const teamName  = document.getElementById(`pt_teamName_${tid}`)?.value.trim();
  const bracket   = document.getElementById(`pt_bracket_${tid}`)?.value;
  const seed      = parseInt(document.getElementById(`pt_seed_${tid}`)?.value || "0", 10);
  const coachName = document.getElementById(`pt_coachName_${tid}`)?.value.trim();
  const coachPhone= document.getElementById(`pt_coachPhone_${tid}`)?.value.trim();
  const coachEmail= document.getElementById(`pt_coachEmail_${tid}`)?.value.trim();
  const msgEl     = document.getElementById(`participantMsg_${tid}`);

  if (!teamName) { setMsg(`participantMsg_${tid}`, "Team name is required.", "warning"); return; }

  const existing = t.participants || [];
  // Only check for duplicate bracket+seed when both are set
  if (bracket && seed > 0 && existing.some(p => p.bracket === bracket && p.seed === seed)) {
    setMsg(`participantMsg_${tid}`, `${bracket} already has a Seed ${seed}. Remove that team first.`, "warning");
    return;
  }

  const newEntry = { teamName, bracket, seed, coachName, coachPhone, coachEmail };
  const updated  = [...existing, newEntry];

  setMsg(`participantMsg_${tid}`, "Saving…", "info");
  try {
    await updateDoc(doc(db, "tournaments", tid), { participants: updated });
    t.participants = updated;
    render();
  } catch (err) {
    setMsg(`participantMsg_${tid}`, "Failed: " + err.message, "error");
  }
}

async function removeParticipant(tid, idx) {
  const t = allTournaments.find(x => x.id === tid);
  if (!t) return;
  const sorted = [...(t.participants || [])].sort((a, b) =>
    (a.bracket || "").localeCompare(b.bracket || "") || (a.seed || 99) - (b.seed || 99)
  );
  const toRemove = sorted[idx];
  if (!toRemove) return;
  if (!await showConfirm(`Remove ${toRemove.teamName} from ${toRemove.bracket} Seed ${toRemove.seed}?`)) return;

  const updated = (t.participants || []).filter(p =>
    !(p.bracket === toRemove.bracket && p.seed === toRemove.seed && p.teamName === toRemove.teamName)
  );
  try {
    await updateDoc(doc(db, "tournaments", tid), { participants: updated });
    t.participants = updated;
    render();
  } catch (err) {
    showToast("Failed to remove: " + err.message);
  }
}

async function updateParticipant(tid, idx) {
  const t = allTournaments.find(x => x.id === tid);
  if (!t) return;

  const sorted = [...(t.participants || [])].sort((a, b) =>
    (a.bracket || "").localeCompare(b.bracket || "") || (a.seed || 99) - (b.seed || 99)
  );
  const original = sorted[idx];
  if (!original) return;

  const bracketEl = document.querySelector(`.participant-bracket-sel[data-tid="${tid}"][data-idx="${idx}"]`);
  const seedEl    = document.querySelector(`.participant-seed-inp[data-tid="${tid}"][data-idx="${idx}"]`);
  const saveBtn   = document.querySelector(`.participant-save-btn[data-tid="${tid}"][data-idx="${idx}"]`);

  const newBracket = bracketEl?.value || original.bracket;
  const newSeed    = parseInt(seedEl?.value || "0", 10) || original.seed;

  // Check for duplicate bracket+seed (excluding self)
  const conflict = (t.participants || []).find(p =>
    p !== original &&
    p.bracket === newBracket && p.seed === newSeed &&
    p.teamName !== original.teamName
  );
  if (conflict) {
    setMsg(`participantMsg_${tid}`, `${newBracket} Seed ${newSeed} is already taken by ${conflict.teamName}.`, "warning");
    return;
  }

  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
  try {
    const updated = (t.participants || []).map(p =>
      (p.bracket === original.bracket && p.seed === original.seed && p.teamName === original.teamName)
        ? { ...p, bracket: newBracket, seed: newSeed }
        : p
    );
    await updateDoc(doc(db, "tournaments", tid), { participants: updated });
    t.participants = updated;
    render();
  } catch (err) {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
    setMsg(`participantMsg_${tid}`, "Failed: " + err.message, "error");
  }
}

async function applySeedsToGames(tid) {
  const t      = allTournaments.find(x => x.id === tid);
  const linked = allGames.filter(g => g.tournamentId === tid);
  if (!t || !linked.length) return;

  const participants = t.participants || [];
  if (!participants.length) {
    setMsg(`seedApplyMsg_${tid}`, "Add teams first before applying seeds.", "warning");
    return;
  }

  const brackets = [...new Set(linked.map(g => g.field || "").filter(Boolean))].sort();
  const batch    = writeBatch(db);
  const changes  = [];

  brackets.forEach(bracket => {
    const templateKey = detectTemplate(bracket, linked);
    const matchups    = SEED_MATCHUPS[templateKey] || [];
    const bParticipants = participants.filter(p => p.bracket === bracket);

    function teamBySeed(seed) {
      return bParticipants.find(p => p.seed === seed)?.teamName || "";
    }

    const bGames = linked.filter(g => g.field === bracket);

    matchups.forEach(([gameNum, homeSeed, awaySeed]) => {
      const g = bGames.find(x => {
        const m = (x.notes || "").match(/Game\s+(\d+)/i);
        return m && parseInt(m[1], 10) === gameNum;
      });
      if (!g) return;

      const homeTeam = teamBySeed(homeSeed) || g.homeTeam || "";
      const awayTeam = awaySeed ? (teamBySeed(awaySeed) || g.awayTeam || "") : (g.awayTeam || "W(G1)");

      if (homeTeam || awayTeam) {
        batch.update(doc(db, "games", g.id), { homeTeam, awayTeam });
        g.homeTeam = homeTeam;
        g.awayTeam = awayTeam;
        if (homeTeam || awayTeam) {
          changes.push(`${bracket} G${gameNum}: ${homeTeam || "?"} vs ${awayTeam || "?"}`);
        }
      }
    });
  });

  if (!changes.length) {
    setMsg(`seedApplyMsg_${tid}`, "No matching games found for these seeds.", "warning");
    return;
  }

  setMsg(`seedApplyMsg_${tid}`, "Applying…", "info");
  try {
    await batch.commit();
    setMsg(`seedApplyMsg_${tid}`, `✓ ${changes.length} game${changes.length !== 1 ? "s" : ""} updated.`, "success");
    render();
  } catch (err) {
    setMsg(`seedApplyMsg_${tid}`, "Failed: " + err.message, "error");
  }
}

// ── Participant Import from Spreadsheet ──────────────────────────────────────

function loadSheetJS() {
  return new Promise((resolve, reject) => {
    if (window.XLSX) { resolve(window.XLSX); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload  = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error("Failed to load SheetJS"));
    document.head.appendChild(s);
  });
}

function parseCSVText(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = []; let inQ = false, cur = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) { row.push(cur); cur = ""; }
      else cur += ch;
    }
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function autoDetectCols(headers) {
  const h = headers.map(c => (c || "").toLowerCase().trim());
  function find(...kws) {
    for (const kw of kws) {
      const i = h.findIndex(c => c.includes(kw));
      if (i >= 0) return i;
    }
    return -1;
  }
  return {
    team:    find("team", "club", "program"),
    coach:   find("coach", "contact", "name"),
    phone:   find("phone", "cell", "mobile"),
    email:   find("email", "mail"),
    bracket: find("bracket", "pool"),
    seed:    find("seed", "rank"),
  };
}

// Handles Minndak "carried-forward team name" style as well as standard one-row-per-team
function parseIntoTeams(dataRows, colMap) {
  const teams = [];
  let last = null;
  for (const row of dataRows) {
    const get = i => i >= 0 ? (row[i] || "").toString().trim() : "";
    const teamName = get(colMap.team);
    const coach    = get(colMap.coach);
    const phone    = get(colMap.phone);
    const email    = get(colMap.email);
    const bracket  = get(colMap.bracket);
    const seed     = parseInt(get(colMap.seed), 10) || 0;

    if (!teamName && !coach && !phone && !email) continue;

    if (teamName) {
      last = { teamName, coachName: coach, coachPhone: phone, coachEmail: email, bracket, seed };
      teams.push(last);
    } else if (last) {
      // Secondary coach row — fill only if primary is blank
      if (!last.coachName  && coach) last.coachName  = coach;
      if (!last.coachPhone && phone) last.coachPhone = phone;
      if (!last.coachEmail && email) last.coachEmail = email;
    }
  }
  return teams;
}

function ensureImportModal() {
  if (_importModal) return;
  _importModal = document.createElement("div");
  _importModal.style.cssText = `
    display:none;position:fixed;inset:0;z-index:9999;
    background:rgba(0,0,0,0.82);overflow-y:auto;
    align-items:flex-start;justify-content:center;padding:32px 16px`;

  const inp = `padding:7px 10px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px;font-size:0.88rem;width:100%;box-sizing:border-box`;
  const selStyle = `padding:5px 8px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:5px;font-size:0.85rem;width:100%`;

  _importModal.innerHTML = `
    <div style="background:#1e1e1e;border:1px solid #555;border-radius:12px;
                padding:24px 28px;width:100%;max-width:700px">
      <h3 style="margin:0 0 4px;color:white">📥 Import Participants</h3>
      <p style="color:var(--light-text);font-size:0.85rem;margin:0 0 16px" id="impSubtitle"></p>

      <!-- Source tabs -->
      <div style="display:flex;gap:4px;margin-bottom:14px">
        <button id="impTabUrl"  class="btn"           style="font-size:0.82rem;padding:5px 14px">🔗 Google Sheets URL</button>
        <button id="impTabCsv"  class="btn print-btn" style="font-size:0.82rem;padding:5px 14px">📄 CSV File</button>
        <button id="impTabXlsx" class="btn print-btn" style="font-size:0.82rem;padding:5px 14px">📊 Excel (.xlsx)</button>
      </div>

      <div id="impPaneUrl">
        <p style="color:var(--light-text);font-size:0.82rem;margin:0 0 8px">
          In Google Sheets: <em>File → Share → Publish to web</em>, select CSV format, then paste the link below.
          HTML-format links are also converted automatically.
        </p>
        <div style="display:flex;gap:8px">
          <input id="impUrlInput" type="url" placeholder="https://docs.google.com/spreadsheets/d/e/…"
            style="${inp}" />
          <button id="impFetchBtn" class="btn" style="white-space:nowrap;padding:7px 16px;font-size:0.88rem">Fetch</button>
        </div>
      </div>
      <div id="impPaneCsv" style="display:none">
        <label style="font-size:0.88rem;color:var(--light-text)">Select a .csv file:</label>
        <input id="impCsvFile" type="file" accept=".csv,.txt"
          style="display:block;margin-top:8px;color:var(--text);font-size:0.88rem" />
      </div>
      <div id="impPaneXlsx" style="display:none">
        <label style="font-size:0.88rem;color:var(--light-text)">Select an Excel file (.xlsx / .xls):</label>
        <input id="impXlsxFile" type="file" accept=".xlsx,.xls"
          style="display:block;margin-top:8px;color:var(--text);font-size:0.88rem" />
      </div>

      <p id="impFetchStatus" style="font-size:0.85rem;margin:8px 0 0;min-height:18px"></p>

      <!-- Column mapping -->
      <div id="impColMap" style="display:none;margin-top:14px">
        <div style="color:#7ec8f7;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">
          Column Mapping
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px 14px;margin-bottom:10px" id="impColGrid"></div>
        <button id="impPreviewBtn" class="btn print-btn" style="font-size:0.85rem;padding:5px 14px">👁 Preview</button>
      </div>

      <!-- Preview + bracket assignment -->
      <div id="impPreview" style="display:none;margin-top:14px">
        <div style="color:#86efac;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">
          Preview — assign brackets &amp; seeds before importing
        </div>
        <div id="impQuickBtns" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"></div>
        <div style="overflow-x:auto;max-height:300px;overflow-y:auto">
          <table id="impPreviewTable" style="width:100%;border-collapse:collapse;font-size:0.82rem"></table>
        </div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">
        <button id="impConfirmBtn" class="btn" style="padding:8px 22px;display:none">📥 Import</button>
        <button id="impCloseBtn"   class="btn print-btn" style="padding:8px 18px">Close</button>
      </div>
      <p id="impStatus" style="font-size:0.82rem;margin:8px 0 0;min-height:0"></p>
    </div>`;
  document.body.appendChild(_importModal);
  wireImportModal();
}

function wireImportModal() {
  function switchTab(name) {
    ["Url","Csv","Xlsx"].forEach(t => {
      document.getElementById(`impTab${t}`).className        = t === name ? "btn" : "btn print-btn";
      document.getElementById(`impPane${t}`).style.display   = t === name ? "" : "none";
    });
  }
  document.getElementById("impTabUrl").addEventListener("click",   () => switchTab("Url"));
  document.getElementById("impTabCsv").addEventListener("click",   () => switchTab("Csv"));
  document.getElementById("impTabXlsx").addEventListener("click",  () => switchTab("Xlsx"));
  document.getElementById("impFetchBtn").addEventListener("click",  impHandleFetch);
  document.getElementById("impCsvFile").addEventListener("change",  impHandleCsvFile);
  document.getElementById("impXlsxFile").addEventListener("change", impHandleXlsxFile);
  document.getElementById("impPreviewBtn").addEventListener("click", impBuildPreview);
  document.getElementById("impConfirmBtn").addEventListener("click", impConfirm);
  document.getElementById("impCloseBtn").addEventListener("click",  closeImportModal);
}

function openImportModal(tid) {
  ensureImportModal();
  _importTid = tid; _rawRows = []; _importHasHeader = false;
  const t = allTournaments.find(x => x.id === tid);
  document.getElementById("impSubtitle").textContent    = t ? t.name : "";
  document.getElementById("impFetchStatus").textContent = "";
  document.getElementById("impStatus").textContent      = "";
  document.getElementById("impColMap").style.display    = "none";
  document.getElementById("impPreview").style.display   = "none";
  document.getElementById("impConfirmBtn").style.display = "none";
  document.getElementById("impUrlInput").value          = "";
  _importModal.style.display = "flex";
}

function closeImportModal() {
  if (_importModal) _importModal.style.display = "none";
}

function impSetStatus(msg, color) {
  const el = document.getElementById("impFetchStatus");
  if (el) { el.textContent = msg; el.style.color = color || "var(--light-text)"; }
}

async function impHandleFetch() {
  let url = (document.getElementById("impUrlInput")?.value || "").trim();
  if (!url) { impSetStatus("Enter a URL first.", "#ffb4b4"); return; }

  // Convert pubhtml → CSV export URL
  if (url.includes("/pubhtml")) {
    url = url.replace("/pubhtml", "/pub");
    try {
      const u = new URL(url);
      u.searchParams.delete("widget");
      u.searchParams.delete("headers");
      if (!u.searchParams.has("output")) u.searchParams.set("output", "csv");
      url = u.toString();
    } catch {
      // fallback: regex approach
      url = url.replace(/[?&]widget=[^&]*/g, "").replace(/[?&]headers=[^&]*/g, "");
      if (!url.includes("output=")) url += (url.includes("?") ? "&" : "?") + "output=csv";
    }
  }

  impSetStatus("Fetching…", "#aaa");
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    impProcessText(await resp.text());
  } catch (err) {
    impSetStatus(`Fetch failed: ${err.message}. Try downloading as CSV instead.`, "#ffb4b4");
  }
}

async function impHandleCsvFile(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  impSetStatus("Reading…", "#aaa");
  impProcessText(await f.text());
}

async function impHandleXlsxFile(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  impSetStatus("Loading Excel parser…", "#aaa");
  try {
    const XLSX = await loadSheetJS();
    const wb   = XLSX.read(await f.arrayBuffer(), { type: "array" });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    impProcessRows(XLSX.utils.sheet_to_array(ws, { defval: "" }));
  } catch (err) {
    impSetStatus("Error: " + err.message, "#ffb4b4");
  }
}

function impProcessText(text) { impProcessRows(parseCSVText(text)); }

function impProcessRows(rows) {
  const clean = rows.filter(r => r.some(c => (c || "").toString().trim()));
  if (!clean.length) { impSetStatus("No data found.", "#ffb4b4"); return; }
  const first = clean[0].map(c => (c || "").toString().trim().toLowerCase());
  _importHasHeader = first.some(c => ["team","name","email","phone","coach","bracket","seed"].some(kw => c.includes(kw)));
  _rawRows = clean;
  const dataCount = clean.length - (_importHasHeader ? 1 : 0);
  impSetStatus(`✓ ${dataCount} data rows loaded.`, "#86efac");
  impShowColMap();
}

function impShowColMap() {
  const headers  = _importHasHeader
    ? _rawRows[0].map(c => (c || "").toString().trim())
    : _rawRows[0].map((_, i) => `Column ${i + 1}`);
  const detected = autoDetectCols(headers);
  const noneOpt  = `<option value="-1">— none —</option>`;

  function sel(id, label, detIdx) {
    return `
      <div>
        <label style="font-size:0.78rem;color:var(--light-text);display:block;margin-bottom:3px">${label}</label>
        <select id="${id}" style="padding:5px 8px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:5px;font-size:0.85rem;width:100%">
          ${noneOpt}
          ${headers.map((h, i) => `<option value="${i}"${i === detIdx ? " selected" : ""}>${i+1}. ${esc(h)}</option>`).join("")}
        </select>
      </div>`;
  }
  document.getElementById("impColGrid").innerHTML =
    sel("impColTeam",    "Team Name *",   detected.team)    +
    sel("impColCoach",   "Coach Name",    detected.coach)   +
    sel("impColPhone",   "Phone",         detected.phone)   +
    sel("impColEmail",   "Email",         detected.email)   +
    sel("impColBracket", "Bracket (opt)", detected.bracket) +
    sel("impColSeed",    "Seed (opt)",    detected.seed);

  document.getElementById("impColMap").style.display    = "";
  document.getElementById("impPreview").style.display   = "none";
  document.getElementById("impConfirmBtn").style.display = "none";
}

function impBuildPreview() {
  const g = id => parseInt(document.getElementById(id)?.value || "-1", 10);
  const colMap = { team: g("impColTeam"), coach: g("impColCoach"), phone: g("impColPhone"),
                   email: g("impColEmail"), bracket: g("impColBracket"), seed: g("impColSeed") };

  if (colMap.team < 0) {
    document.getElementById("impStatus").textContent = "Select at least the Team Name column."; return;
  }
  const dataRows = _importHasHeader ? _rawRows.slice(1) : _rawRows;
  const teams    = parseIntoTeams(dataRows, colMap);
  if (!teams.length) {
    document.getElementById("impStatus").textContent = "No teams detected. Check column mapping."; return;
  }
  document.getElementById("impStatus").textContent = "";

  const linked   = allGames.filter(g => g.tournamentId === _importTid);
  const brackets = [...new Set(linked.map(g => g.field || "").filter(Boolean))].sort();

  // Quick-assign buttons
  const quickHtml = [
    ...brackets.map(b =>
      `<button type="button" class="btn print-btn imp-quick-all" data-qb="${esc(b)}"
        style="font-size:0.78rem;padding:3px 10px">All → ${esc(b)}</button>`),
    `<button type="button" class="btn print-btn" id="impAutoDistBtn"
      style="font-size:0.78rem;padding:3px 10px">⚡ Auto-Distribute</button>`
  ].join("");
  const quickEl = document.getElementById("impQuickBtns");
  quickEl.innerHTML = quickHtml;
  quickEl.onclick = (e) => {
    const qb = e.target.closest(".imp-quick-all")?.dataset.qb;
    if (qb) {
      [...document.querySelectorAll(".imp-sel-bracket")].forEach((s, i) => {
        s.value = qb;
        const seed = document.querySelectorAll(".imp-inp-seed")[i];
        if (seed) seed.value = i + 1;
      });
      return;
    }
    if (e.target.id === "impAutoDistBtn") {
      const sels = [...document.querySelectorAll(".imp-sel-bracket")];
      const inps = [...document.querySelectorAll(".imp-inp-seed")];
      const n    = sels.length;
      sels.forEach((s, i) => {
        if (brackets.length === 3 && n === 25) {
          if (i < 8)       { s.value = brackets[0]; inps[i].value = i + 1; }
          else if (i < 16) { s.value = brackets[1]; inps[i].value = i - 7; }
          else             { s.value = brackets[2]; inps[i].value = i - 15; }
        } else {
          const per = Math.ceil(n / Math.max(brackets.length, 1));
          const bi  = Math.min(Math.floor(i / per), brackets.length - 1);
          s.value = brackets[bi] || "";
          inps[i].value = (i % per) + 1;
        }
      });
    }
  };

  // Build preview table
  const tdS  = "padding:4px 8px;border-bottom:1px solid #222";
  const inpS = "padding:3px 5px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:4px;font-size:0.8rem";

  const thead = `
    <thead>
      <tr style="color:var(--light-text);font-size:0.75rem;text-transform:uppercase">
        <th style="padding:4px 8px;text-align:left">Team</th>
        <th style="padding:4px 8px;text-align:left">Bracket</th>
        <th style="padding:4px 8px;text-align:left;width:60px">Seed</th>
        <th style="padding:4px 8px;text-align:left">Coach</th>
        <th style="padding:4px 8px;text-align:left">Phone</th>
      </tr>
    </thead>`;

  const tbody = teams.map((team, i) => {
    const bracketOpts =
      `<option value="">— unset —</option>` +
      brackets.map(b => `<option value="${esc(b)}"${team.bracket === b ? " selected" : ""}>${esc(b)}</option>`).join("") +
      (team.bracket && !brackets.includes(team.bracket)
        ? `<option value="${esc(team.bracket)}" selected>${esc(team.bracket)}</option>` : "");
    return `
      <tr>
        <td style="${tdS}">${esc(team.teamName)}</td>
        <td style="${tdS};min-width:100px">
          <select class="imp-sel-bracket" data-idx="${i}" style="${inpS};min-width:100px">${bracketOpts}</select>
        </td>
        <td style="${tdS}">
          <input type="number" class="imp-inp-seed" data-idx="${i}" min="1" max="9"
            value="${team.seed || ""}" style="${inpS};width:52px;text-align:center" />
        </td>
        <td style="${tdS}">${esc(team.coachName || "")}</td>
        <td style="${tdS};color:var(--light-text);font-size:0.78rem">${esc(team.coachPhone || "")}</td>
      </tr>`;
  }).join("");

  document.getElementById("impPreviewTable").innerHTML = thead + `<tbody>${tbody}</tbody>`;
  _importModal._parsedTeams = teams;
  document.getElementById("impPreview").style.display = "";
  const cb = document.getElementById("impConfirmBtn");
  cb.textContent     = `📥 Import ${teams.length} Teams`;
  cb.style.display   = "";
}

async function impConfirm() {
  const teams = _importModal._parsedTeams;
  if (!teams?.length) return;

  const bracketSels = [...document.querySelectorAll(".imp-sel-bracket")];
  const seedInputs  = [...document.querySelectorAll(".imp-inp-seed")];
  const participants = [];

  teams.forEach((team, i) => {
    const bracket = bracketSels[i]?.value || "";
    const seed    = parseInt(seedInputs[i]?.value || "0", 10);
    participants.push({
      teamName: team.teamName, bracket, seed: seed || 0,
      coachName: team.coachName || "", coachPhone: team.coachPhone || "", coachEmail: team.coachEmail || "",
    });
  });


  const t = allTournaments.find(x => x.id === _importTid);
  if ((t?.participants || []).length) {
    if (!await showConfirm(
      `This tournament already has ${t.participants.length} participant(s).\nReplace all with these ${participants.length} teams?`
    )) return;
  }

  const confirmBtn = document.getElementById("impConfirmBtn");
  confirmBtn.disabled = true;
  document.getElementById("impStatus").textContent = "Saving…";
  try {
    await updateDoc(doc(db, "tournaments", _importTid), { participants });
    if (t) t.participants = participants;
    document.getElementById("impStatus").textContent = `✓ ${participants.length} participants imported.`;
    setTimeout(() => { closeImportModal(); render(); }, 800);
  } catch (err) {
    document.getElementById("impStatus").textContent = "Failed: " + err.message;
    confirmBtn.disabled = false;
  }
}

// ── Bracket Flow / Advancement ───────────────────────────────────────────────

// Bracket advancement templates derived from the 2026 8U spreadsheet column/row positions.
// Keys are game numbers; winner/loser specify which game number and home/away slot.
// Resize maps for switching bracket size without manual restructuring.
// Derived from the structural analysis in BRACKET_TEMPLATES below.
//
// 9→8: Delete 9DE G1 (play-in) and G8 (extra LB game from the bye structure).
//       Renumber the remaining 15 games to 8DE positions.
// 8→9: Reverse — renumber the 15 existing games and create 2 new game slots
//       (G1 play-in and G8) whose times default to nearby existing games.
const RESIZE_MAPS = {
  "9to8": {
    toDelete: [1, 8],
    remap: { 5:1, 4:2, 2:3, 3:4, 6:5, 7:6, 10:7, 9:8, 12:9, 11:10, 13:11, 14:12, 15:13, 16:14, 17:15 }
  },
  "8to9": {
    toCreate: [1, 8],   // 9DE game numbers for the 2 new slots
    remap: { 1:5, 2:4, 3:2, 4:3, 5:6, 6:7, 7:10, 8:9, 9:12, 10:11, 11:13, 12:14, 13:15, 14:16, 15:17 }
  }
};

const BRACKET_TEMPLATES = {
  "8-team-de": {
    1:  { w: [7,"home"], l: [5,"home"]  },
    2:  { w: [7,"away"], l: [5,"away"]  },
    3:  { w: [8,"home"], l: [6,"home"]  },
    4:  { w: [8,"away"], l: [6,"away"]  },
    5:  { w: [9,"away"], l: null        },   // G5=L(G1)vL(G2), W→G9
    6:  { w: [10,"away"],l: null        },   // G6=L(G3)vL(G4), W→G10
    7:  { w: [11,"home"],l: [9,"home"]  },   // G7=W(G1)vW(G2)
    8:  { w: [11,"away"],l: [10,"home"] },   // G8=W(G3)vW(G4)
    9:  { w: [12,"home"],l: null        },   // G9=L(G7)vW(G5)
    10: { w: [12,"away"],l: null        },   // G10=L(G8)vW(G6)
    11: { w: [14,"home"],l: [13,"home"] },   // G11=W bracket final
    12: { w: [13,"away"],l: null        },
    13: { w: [14,"away"],l: null        },   // G13=L bracket final
    14: { w: null,        l: [15,"home"]},   // G14=championship; if nec → G15 same teams
    15: { w: null,        l: null       },
  },
  "9-team-de": {
    1:  { w: [5,"away"],  l: [6,"home"]  },  // play-in #8v#9
    2:  { w: [9,"home"],  l: [7,"home"]  },
    3:  { w: [9,"away"],  l: [7,"away"]  },
    4:  { w: [10,"away"], l: [6,"away"]  },
    5:  { w: [10,"home"], l: [8,"away"]  },  // #1 bye vs W(G1)
    6:  { w: [8,"home"],  l: null        },  // L(G1)vL(G4)
    7:  { w: [11,"home"], l: null        },  // L(G2)vL(G3)
    8:  { w: [12,"home"], l: null        },  // W(G6)vL(G5)
    9:  { w: [13,"home"], l: [12,"away"] },  // W bracket R2 top
    10: { w: [13,"away"], l: [11,"away"] },  // W bracket R2 bottom
    11: { w: [14,"home"], l: null        },
    12: { w: [14,"away"], l: null        },
    13: { w: [16,"home"], l: [15,"home"] },  // W bracket final
    14: { w: [15,"away"], l: null        },  // L bracket semi
    15: { w: [16,"away"], l: null        },  // L bracket final
    16: { w: null,         l: [17,"home"]},  // championship; if nec → G17 same teams
    17: { w: null,         l: null        },
  }
};

function detectTemplate(bracketName, linkedGames) {
  // Primary: detect from actual game numbers (9DE goes up to G17, 8DE tops at G15)
  const bracketGames = (linkedGames || []).filter(g => g.field === bracketName);
  const maxNum = Math.max(0, ...bracketGames.map(g => {
    const m = (g.notes || "").match(/Game\s+(\d+)/i);
    return m ? parseInt(m[1]) : 0;
  }));
  if (maxNum > 15) return "9-team-de";
  if (maxNum > 0) return "8-team-de";
  // Fallback: name heuristics
  const name = (bracketName || "").toLowerCase();
  if (name.includes("3") || name.includes("bronze") || name.includes("9")) return "9-team-de";
  return "8-team-de";
}

function renderBracketFlow(t, linked) {
  if (!linked.length) return "";
  const brackets = [...new Set(linked.map(g => g.field || "").filter(Boolean))].sort();
  if (!brackets.length) return "";

  const isSetUp = t.bracketAdvancement && Object.keys(t.bracketAdvancement).length > 0;

  const summary = isSetUp ? brackets.map(bracket => {
    const rules = t.bracketAdvancement[bracket] || {};
    const gameCount = Object.keys(rules).length;
    return `<span style="color:#86efac;font-size:0.82rem">✓ ${esc(bracket)} (${gameCount} games configured)</span>`;
  }).join("  &nbsp;·&nbsp;  ") : `<span style="color:var(--light-text);font-size:0.82rem">Not configured — click Apply to set up.</span>`;

  // Per-bracket size indicator + resize button
  const resizeRows = brackets.map(bracket => {
    const bGames  = linked.filter(g => g.field === bracket);
    const tmpl    = detectTemplate(bracket, linked);
    const sizeLabel = tmpl === "9-team-de" ? "9-team DE · 17 games" : "8-team DE · 15 games";
    const btnLabel  = tmpl === "9-team-de" ? "Convert → 8-team DE ↓" : "Convert → 9-team DE ↑";
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:5px 0;
                  border-bottom:1px solid #1a3a1a;flex-wrap:wrap">
        <span style="font-size:0.82rem;color:#c4b5fd;min-width:110px">${esc(bracket)}</span>
        <span style="font-size:0.82rem;color:var(--light-text);flex:1">${sizeLabel}</span>
        <button class="btn print-btn bracket-resize-btn"
          data-tid="${esc(t.id)}" data-bracket="${esc(bracket)}"
          style="font-size:0.75rem;padding:3px 12px;white-space:nowrap">${btnLabel}</button>
      </div>`;
  }).join("");

  return `
    <div style="margin-bottom:16px;padding:14px;background:rgba(100,255,180,0.04);border:1px solid #1a4a2a;border-radius:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <div style="color:#86efac;font-size:0.82rem;text-transform:uppercase;letter-spacing:0.05em">
          🔀 Bracket Flow (Auto-Advancement)
        </div>
        <button class="btn print-btn bracket-flow-setup-btn" data-tid="${esc(t.id)}"
          style="font-size:0.8rem;padding:4px 14px">
          ${isSetUp ? "↺ Reapply Standard Rules" : "Apply Standard DE Bracket Rules"}
        </button>
      </div>
      <div style="margin-bottom:8px">${summary}</div>
      ${resizeRows ? `
      <div style="margin:10px 0 4px;padding:10px 12px;background:rgba(0,0,0,0.2);border-radius:6px;border:1px solid #1a3a1a">
        <div style="color:var(--light-text);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">
          Bracket Size — change if a team drops out or is added
        </div>
        ${resizeRows}
      </div>` : ""}
      <p style="color:var(--light-text);font-size:0.78rem;margin:8px 0 0">
        When a score is saved, teams automatically advance to their next games.
        Structure is auto-detected per bracket (8-team or 9-team double-elimination).
      </p>
      <p id="bracketFlowMsg_${esc(t.id)}" class="signup-message" style="margin:4px 0 0;min-height:0"></p>
    </div>`;
}

async function setupBracketAdvancement(tid) {
  const t      = allTournaments.find(x => x.id === tid);
  const linked = allGames.filter(g => g.tournamentId === tid);
  if (!t) return;

  const brackets = [...new Set(linked.map(g => g.field || "").filter(Boolean))].sort();
  if (!brackets.length) {
    setMsg(`bracketFlowMsg_${tid}`, "No brackets found — add games first.", "warning");
    return;
  }

  const bracketAdvancement = {};
  brackets.forEach(bracket => {
    const template = BRACKET_TEMPLATES[detectTemplate(bracket, linked)];
    // Convert number-keyed template to string keys for Firestore
    bracketAdvancement[bracket] = {};
    Object.entries(template).forEach(([num, rule]) => {
      bracketAdvancement[bracket][num] = {
        winner: rule.w ? { game: rule.w[0], slot: rule.w[1] } : null,
        loser:  rule.l ? { game: rule.l[0], slot: rule.l[1] } : null,
      };
    });
  });

  setMsg(`bracketFlowMsg_${tid}`, "Saving…", "info");
  try {
    await updateDoc(doc(db, "tournaments", tid), { bracketAdvancement });
    t.bracketAdvancement = bracketAdvancement;
    setMsg(`bracketFlowMsg_${tid}`, "✓ Bracket advancement rules saved.", "success");
    render();
  } catch (err) {
    console.error(err);
    setMsg(`bracketFlowMsg_${tid}`, "Failed: " + err.message, "error");
  }
}

// ── Bracket Resize (9↔8 team DE) ─────────────────────────────────────────────

async function resizeBracket(tid, bracketName) {
  const t      = allTournaments.find(x => x.id === tid);
  const linked = allGames.filter(g => g.tournamentId === tid);
  if (!t) return;

  const msgId          = `bracketFlowMsg_${tid}`;
  const currentTemplate = detectTemplate(bracketName, linked);
  if (currentTemplate !== "8-team-de" && currentTemplate !== "9-team-de") {
    setMsg(msgId, "Cannot resize: unrecognized bracket format.", "error");
    return;
  }

  const direction   = currentTemplate === "9-team-de" ? "9to8" : "8to9";
  const fromLabel   = currentTemplate === "9-team-de" ? "9-team DE" : "8-team DE";
  const toLabel     = direction === "9to8" ? "8-team DE (15 games)" : "9-team DE (17 games)";
  const actionLine  = direction === "9to8"
    ? "Delete G1 (play-in) and G8 (extra losers-bracket game)"
    : "Add 2 new game slots — G1 (play-in) and G8 (adjust times after)";

  if (t.status === "active") {
    if (!await showConfirm(
      `⚠️ This tournament is currently marked Active.\n\nAre you sure you want to resize the ${bracketName} bracket while the tournament is underway?`
    )) return;
  }

  if (!await showConfirm(
    `Convert "${bracketName}" from ${fromLabel} → ${toLabel}?\n\n` +
    `• ${actionLine}\n` +
    `• Renumber ${direction === "9to8" ? "15 remaining" : "15 existing"} games\n` +
    `• Team assignments cleared — click "Apply Seeds to Games" after\n` +
    `• Bracket advancement cleared — click "Apply Standard DE Bracket Rules" after`
  )) return;

  setMsg(msgId, "Resizing…", "info");

  const bGames = linked.filter(g => g.field === bracketName);
  const byNum  = {};
  bGames.forEach(g => {
    const m = (g.notes || "").match(/Game\s+(\d+)/i);
    if (m) byNum[parseInt(m[1])] = g;
  });

  try {
    if (direction === "9to8") {
      await doResize9to8(tid, bracketName, t, byNum, msgId);
    } else {
      await doResize8to9(tid, bracketName, t, bGames, byNum, msgId);
    }
  } catch (err) {
    console.error("resizeBracket:", err);
    setMsg(msgId, "Failed: " + err.message, "error");
  }
}

async function doResize9to8(tid, bracketName, t, byNum, msgId) {
  const { toDelete, remap } = RESIZE_MAPS["9to8"];
  const batch = writeBatch(db);

  for (const n of toDelete) {
    if (byNum[n]) batch.delete(doc(db, "games", byNum[n].id));
  }

  for (const [fromStr, toNum] of Object.entries(remap)) {
    const g = byNum[Number(fromStr)];
    if (!g) continue;
    const newNotes = (g.notes || "").replace(/Game\s+\d+/i, `Game ${toNum}`);
    batch.update(doc(db, "games", g.id), { notes: newNotes, homeTeam: "", awayTeam: "" });
  }

  const updatedAdv = { ...(t.bracketAdvancement || {}) };
  delete updatedAdv[bracketName];
  batch.update(doc(db, "tournaments", tid), { bracketAdvancement: updatedAdv });

  await batch.commit();

  // Sync in-memory
  for (const n of toDelete) {
    if (byNum[n]) {
      const idx = allGames.findIndex(g => g.id === byNum[n].id);
      if (idx >= 0) allGames.splice(idx, 1);
    }
  }
  for (const [fromStr, toNum] of Object.entries(remap)) {
    const g = byNum[Number(fromStr)];
    if (g) {
      g.notes = (g.notes || "").replace(/Game\s+\d+/i, `Game ${toNum}`);
      g.homeTeam = ""; g.awayTeam = "";
    }
  }
  t.bracketAdvancement = updatedAdv;

  setMsg(msgId, `✓ ${bracketName} converted to 8-team DE. Apply standard bracket rules, then apply seeds.`, "success");
  render();
}

async function doResize8to9(tid, bracketName, t, bGames, byNum, msgId) {
  const { toCreate, remap } = RESIZE_MAPS["8to9"];
  const batch = writeBatch(db);

  // Renumber the 15 existing games
  for (const [fromStr, toNum] of Object.entries(remap)) {
    const g = byNum[Number(fromStr)];
    if (!g) continue;
    const newNotes = (g.notes || "").replace(/Game\s+\d+/i, `Game ${toNum}`);
    batch.update(doc(db, "games", g.id), { notes: newNotes, homeTeam: "", awayTeam: "" });
  }

  // Clone metadata from an existing game (sorted earliest by time)
  const template = [...bGames].sort((a, b) => (a.time || "").localeCompare(b.time || ""))[0];
  const blankSlots = (template?.umpireSlots || []).map(s => ({
    type: s.type, payRate: s.payRate ?? null,
    assignedUid: null, assignedName: null,
    checkedIn: false, checkedInAt: null, paid: false, noShow: false,
  }));
  const notesSuffix = (template?.notes || "").replace(/Game\s+\d+\s*/i, "").trim();

  function makeGame(gameNum, time) {
    return {
      date:         template?.date  || t.date,
      time,
      city:         template?.city  || "",
      division:     template?.division || t.division || "",
      field:        bracketName,
      facilityId:   template?.facilityId || "",
      subField:     template?.subField   || "",
      notes:        `Game ${gameNum}${notesSuffix ? " " + notesSuffix : ""}`,
      tournamentId: tid,
      homeTeam: "", awayTeam: "",
      umpireSlots:  blankSlots,
      needsUmpires: blankSlots.length > 0,
      cancelled:    false,
    };
  }

  // G1 play-in: same time as the earliest WB R1 game (old 8DE G1, now renaming to G5)
  const g1Time = byNum[1]?.time || template?.time || "08:00";
  // G8: same time as old 8DE G8 (renaming to G9) — adjacent slot in the schedule
  const g8Time = byNum[8]?.time || byNum[7]?.time || template?.time || "10:00";

  const g1Ref = doc(collection(db, "games"));
  const g8Ref = doc(collection(db, "games"));
  batch.set(g1Ref, makeGame(1, g1Time));
  batch.set(g8Ref, makeGame(8, g8Time));

  const updatedAdv = { ...(t.bracketAdvancement || {}) };
  delete updatedAdv[bracketName];
  batch.update(doc(db, "tournaments", tid), { bracketAdvancement: updatedAdv });

  await batch.commit();

  // Sync in-memory
  for (const [fromStr, toNum] of Object.entries(remap)) {
    const g = byNum[Number(fromStr)];
    if (g) {
      g.notes = (g.notes || "").replace(/Game\s+\d+/i, `Game ${toNum}`);
      g.homeTeam = ""; g.awayTeam = "";
    }
  }
  const g1Data = makeGame(1, g1Time);
  const g8Data = makeGame(8, g8Time);
  allGames.push({ id: g1Ref.id, ...g1Data });
  allGames.push({ id: g8Ref.id, ...g8Data });
  t.bracketAdvancement = updatedAdv;

  setMsg(msgId, `✓ ${bracketName} converted to 9-team DE. G1 and G8 created — adjust their times if needed, then apply standard bracket rules and seeds.`, "success");
  render();
}

// ── Tournament Rules ──────────────────────────────────────────────────────────

// Default rules pre-loaded for 8U Minndak tournaments
const DEFAULT_RULES_8U = `5-inning game or 1 hour, whichever comes first. No new inning after 1 hour — complete the started inning unless the home team is ahead.
Only a maximum of 9 players on defense for tournament games.
Higher seed is the home team, except for the championship game — winner's bracket team is home.
6 pitches per at-bat. If the batter does not swing at the last pitch, the batter is out (unless the pitch was so bad there was no chance to hit it — grant another pitch).
15-run rule after 3 innings, 10-run rule after 4 innings.`;

function renderRulesEditor(t) {
  const rules    = t.rules || "";
  const hasRules = rules.trim().length > 0;
  const ta_style = `width:100%;min-height:130px;padding:10px;
    background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px;
    font-family:inherit;font-size:0.88rem;box-sizing:border-box;resize:vertical;line-height:1.5`;

  return `
    <div style="margin-bottom:16px;padding:14px;background:rgba(255,230,150,0.04);border:1px solid #3a3010;border-radius:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px">
        <div style="color:#ffd966;font-size:0.82rem;text-transform:uppercase;letter-spacing:0.05em">
          📋 Tournament Rules
        </div>
        <div style="display:flex;gap:8px">
          ${!hasRules ? `
          <button class="btn print-btn rules-prefill-btn" data-tid="${esc(t.id)}"
            style="font-size:0.78rem;padding:3px 12px">Load 8U Defaults</button>` : ""}
          <button class="btn rules-save-btn" data-tid="${esc(t.id)}"
            style="font-size:0.8rem;padding:4px 16px">Save Rules</button>
        </div>
      </div>
      <p style="color:var(--light-text);font-size:0.78rem;margin:0 0 8px">
        One rule per line. These will appear on the public tournament page.
      </p>
      <textarea id="rulesTextarea_${esc(t.id)}" style="${ta_style}"
        placeholder="Enter each rule on its own line…">${esc(rules)}</textarea>
      <p id="rulesMsg_${esc(t.id)}" class="signup-message" style="margin:6px 0 0;min-height:0"></p>
    </div>`;
}

async function saveRules(tid) {
  const t  = allTournaments.find(x => x.id === tid);
  if (!t) return;
  const rules = document.getElementById(`rulesTextarea_${tid}`)?.value || "";
  setMsg(`rulesMsg_${tid}`, "Saving…", "info");
  try {
    await updateDoc(doc(db, "tournaments", tid), { rules });
    t.rules = rules;
    setMsg(`rulesMsg_${tid}`, "✓ Rules saved.", "success");
    render();
  } catch (err) {
    setMsg(`rulesMsg_${tid}`, "Failed: " + err.message, "error");
  }
}

function prefillDefaultRules(tid) {
  const ta = document.getElementById(`rulesTextarea_${tid}`);
  if (ta) ta.value = DEFAULT_RULES_8U;
}

// ── Print System ─────────────────────────────────────────────────────────────

// Print modal element (created once, reused)
let _printModal = null;
let _printTid   = null;

function ensurePrintModal() {
  if (_printModal) return;
  _printModal = document.createElement("div");
  _printModal.id = "tournamentPrintModal";
  _printModal.style.cssText = `
    display:none;position:fixed;inset:0;z-index:9999;
    background:rgba(0,0,0,0.75);overflow-y:auto;
    display:none;align-items:flex-start;justify-content:center;padding:40px 16px`;
  _printModal.innerHTML = `
    <div style="background:#1e1e1e;border:1px solid #555;border-radius:12px;
                padding:24px 28px;width:100%;max-width:560px;position:relative">
      <h3 style="margin:0 0 4px;color:white">🖨 Print Bracket</h3>
      <p style="color:var(--light-text);font-size:0.85rem;margin:0 0 18px" id="printModalSubtitle"></p>

      <div style="margin-bottom:16px">
        <div style="color:var(--light-text);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Brackets to print</div>
        <div id="printBracketChecks" style="display:flex;flex-wrap:wrap;gap:8px"></div>
      </div>

      <div style="margin-bottom:20px">
        <div style="color:var(--light-text);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">Columns to include</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 20px">
          ${[
            ["opt-times",   "Game times",          true ],
            ["opt-teams",   "Team names",           true ],
            ["opt-fields",  "Field assignments",    true ],
            ["opt-umpire",  "Assigned umpire",      true ],
            ["opt-contact", "Umpire contact info",  false],
            ["opt-advance", "W/L advancement",      true ],
            ["opt-scores",  "Score lines (blank)",  false],
            ["opt-outcome", "Outcome / winner",     false],
            ["opt-notes",   "Game notes",           false],
          ].map(([id, label, checked]) => `
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:0.9rem">
              <input type="checkbox" id="${id}" ${checked ? "checked" : ""}
                style="width:15px;height:15px;accent-color:#7ec8f7;cursor:pointer">
              ${label}
            </label>`).join("")}
        </div>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button id="printModalGenBtn" class="btn" style="padding:8px 22px">
          Generate &amp; Print
        </button>
        <button id="printModalCloseBtn" class="btn print-btn" style="padding:8px 18px">
          Cancel
        </button>
      </div>
      <p id="printModalStatus" style="color:var(--light-text);font-size:0.82rem;margin:10px 0 0;min-height:0"></p>
    </div>`;
  document.body.appendChild(_printModal);

  document.getElementById("printModalCloseBtn").addEventListener("click", closePrintModal);
  document.getElementById("printModalGenBtn").addEventListener("click", generateAndPrint);
}

function openPrintModal(tid) {
  ensurePrintModal();
  _printTid = tid;
  const t      = allTournaments.find(x => x.id === tid);
  const linked = allGames.filter(g => g.tournamentId === tid);

  document.getElementById("printModalSubtitle").textContent =
    t ? `${t.name}  ·  ${fmtDate(t.date)}` : "";
  document.getElementById("printModalStatus").textContent = "";

  // Build bracket checkboxes
  const brackets = [...new Set(linked.map(g => g.field || "Games").filter(Boolean))].sort();
  const checksEl = document.getElementById("printBracketChecks");
  checksEl.innerHTML = [
    `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.88rem">
       <input type="checkbox" id="pBracket_ALL" checked style="width:14px;height:14px;accent-color:#7ec8f7">
       <strong>All Brackets</strong>
     </label>`,
    ...brackets.map(b => `
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.88rem">
        <input type="checkbox" class="pBracketCheck" value="${esc(b)}" checked
          style="width:14px;height:14px;accent-color:#7ec8f7">
        ${esc(b)}
      </label>`)
  ].join("");

  // "All Brackets" toggles the rest
  document.getElementById("pBracket_ALL").addEventListener("change", function () {
    document.querySelectorAll(".pBracketCheck").forEach(cb => { cb.checked = this.checked; });
  });

  _printModal.style.display = "flex";
}

function closePrintModal() {
  if (_printModal) _printModal.style.display = "none";
}

async function generateAndPrint() {
  const tid = _printTid;
  if (!tid) return;

  const t      = allTournaments.find(x => x.id === tid);
  const linked = allGames.filter(g => g.tournamentId === tid);

  // Collect selected brackets
  const selectedBrackets = new Set(
    [...document.querySelectorAll(".pBracketCheck:checked")].map(cb => cb.value)
  );
  if (!selectedBrackets.size) {
    document.getElementById("printModalStatus").textContent = "Select at least one bracket.";
    return;
  }

  // Collect options
  const opts = {
    times:   document.getElementById("opt-times").checked,
    teams:   document.getElementById("opt-teams").checked,
    fields:  document.getElementById("opt-fields").checked,
    umpire:  document.getElementById("opt-umpire").checked,
    contact: document.getElementById("opt-contact").checked,
    advance: document.getElementById("opt-advance").checked,
    scores:  document.getElementById("opt-scores").checked,
    outcome: document.getElementById("opt-outcome").checked,
    notes:   document.getElementById("opt-notes").checked,
  };

  // If contact info needed, load umpire profiles
  let umpireProfiles = {};
  if (opts.contact || opts.umpire) {
    document.getElementById("printModalStatus").textContent = "Loading umpire info…";
    const assignedUids = [...new Set(
      linked.flatMap(g => (g.umpireSlots || []).map(s => s.assignedUid).filter(Boolean))
    )];
    try {
      const fetches = assignedUids.map(uid =>
        getDoc(doc(db, "umpires", uid))
          .then(snap => snap.exists() ? { uid, ...snap.data() } : { uid })
          .catch(() => ({ uid }))
      );
      const profiles = await Promise.all(fetches);
      profiles.forEach(p => { umpireProfiles[p.uid] = p; });
    } catch (err) {
      console.warn("Could not load umpire profiles:", err);
    }
  }

  document.getElementById("printModalStatus").textContent = "Opening print window…";

  // Build and open print window
  const html = buildPrintHtml(t, linked, selectedBrackets, opts, umpireProfiles);
  const win  = window.open("", "_blank", "width=900,height=700");
  if (!win) {
    document.getElementById("printModalStatus").textContent =
      "Pop-up blocked — please allow pop-ups for this site.";
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 600);

  closePrintModal();
}

function buildPrintHtml(t, linked, selectedBrackets, opts, umpireProfiles) {
  const tName   = t ? t.name   : "Tournament";
  const tDate   = t ? fmtDate(t.date) : "";
  const tDiv    = t?.division  || "";
  const tNotes  = t?.notes     || "";

  // Group games by bracket, filter to selected, sort by game number
  const bracketOrder = [...new Set(linked.map(g => g.field || "Games").filter(Boolean))].sort();
  const filteredBrackets = bracketOrder.filter(b => selectedBrackets.has(b));

  // Build column headers
  const cols = [];
  cols.push({ key: "game",    label: "Game"   });
  if (opts.times)   cols.push({ key: "time",    label: "Date / Time" });
  if (opts.teams)   cols.push({ key: "home",    label: "Home Team"   });
  if (opts.teams)   cols.push({ key: "away",    label: "Away Team"   });
  if (opts.fields)  cols.push({ key: "field",   label: "Field"       });
  if (opts.umpire)  cols.push({ key: "umpire",  label: "Umpire"      });
  if (opts.contact) cols.push({ key: "contact", label: "Contact"     });
  if (opts.advance) cols.push({ key: "advance", label: "W / L →"     });
  if (opts.scores)  cols.push({ key: "scoreH",  label: "Score (H)"   });
  if (opts.scores)  cols.push({ key: "scoreA",  label: "Score (A)"   });
  if (opts.outcome) cols.push({ key: "outcome", label: "Winner"      });
  if (opts.notes)   cols.push({ key: "notes",   label: "Notes"       });

  const thRow = cols.map(c => `<th>${c.label}</th>`).join("");

  const bracketTables = filteredBrackets.map(bracket => {
    const bGames = linked
      .filter(g => (g.field || "Games") === bracket)
      .sort((a, b) => {
        const nA = parseInt((a.notes || "").match(/Game\s+(\d+)/i)?.[1] || "999");
        const nB = parseInt((b.notes || "").match(/Game\s+(\d+)/i)?.[1] || "999");
        return nA - nB || (a.date || "").localeCompare(b.date || "") || (a.time || "").localeCompare(b.time || "");
      });

    const bAdvRules = (t?.bracketAdvancement || {})[bracket] || {};

    const rows = bGames.map(g => {
      const numMatch  = (g.notes || "").match(/Game\s+(\d+)/i);
      const gameNum   = numMatch ? parseInt(numMatch[1], 10) : null;
      const gameLabel = gameNum ? `Game ${gameNum}` : "—";
      const ifNec     = (g.notes || "").toLowerCase().includes("if necessary") ? "*" : "";
      const slot      = (g.umpireSlots || [])[0];
      const assignedUid  = slot?.assignedUid  || null;
      const assignedName = slot?.assignedName || "—";
      const profile   = assignedUid ? (umpireProfiles[assignedUid] || {}) : {};
      const phone     = profile.phone || "";
      const email     = profile.email || "";
      const contact   = [phone, email].filter(Boolean).join("  ·  ") || "—";
      const subField  = g.subField || g.field || "—";
      const cancelled = g.cancelled ? " (CANCELLED)" : "";

      // Advancement text for print
      const rule    = gameNum ? bAdvRules[String(gameNum)] : null;
      const wG      = rule?.winner?.game;
      const lG      = rule?.loser?.game;
      const advText = [
        wG ? `W → Game ${wG}` : "",
        lG ? `L → Game ${lG}` : "",
      ].filter(Boolean).join("  /  ") || "—";

      const cells = cols.map(c => {
        switch (c.key) {
          case "game":    return `<td>${gameLabel}${ifNec}${cancelled}</td>`;
          case "time":    return `<td>${fmtDate(g.date)}<br><span class="light">${fmtTime(g.time)}</span></td>`;
          case "home":    return `<td>${g.homeTeam || "TBD"}</td>`;
          case "away":    return `<td>${g.awayTeam || "TBD"}</td>`;
          case "field":   return `<td>${subField}</td>`;
          case "umpire":  return `<td>${assignedName}</td>`;
          case "contact": return `<td class="light small">${contact}</td>`;
          case "advance": return `<td class="light small">${advText}</td>`;
          case "scoreH":  return `<td class="write-in"></td>`;
          case "scoreA":  return `<td class="write-in"></td>`;
          case "outcome": return `<td class="write-in wide"></td>`;
          case "notes":   return `<td class="light small">${g.notes || ""}</td>`;
          default:        return `<td></td>`;
        }
      }).join("");

      const rowClass = g.cancelled ? ' class="cancelled"' : "";
      return `<tr${rowClass}>${cells}</tr>`;
    }).join("");

    return `
      <div class="bracket-section">
        <h3>${bracket}</h3>
        <table>
          <thead><tr>${thRow}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${filteredBrackets.indexOf(bracket) < filteredBrackets.length - 1
          ? '<div class="page-break"></div>' : ""}
      </div>`;
  }).join("");

  const footerNote = opts.scores || opts.outcome
    ? `<p class="footer-note">* If necessary game — played only if required by bracket advancement.</p>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${tName} — Bracket</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      font-size: 13px; color: #111; background: white; margin: 0; padding: 24px 32px;
    }
    header { border-bottom: 2px solid #601929; padding-bottom: 12px; margin-bottom: 20px; }
    header h1 { margin: 0 0 4px; font-size: 1.5rem; color: #601929; }
    header .meta { color: #555; font-size: 0.88rem; }
    h3 {
      margin: 0 0 10px; font-size: 1rem; color: #601929;
      border-left: 4px solid #601929; padding-left: 10px;
    }
    table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
    th {
      background: #601929; color: white; text-align: left;
      padding: 7px 10px; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em;
    }
    td {
      padding: 7px 10px; border-bottom: 1px solid #ddd; vertical-align: top;
      font-size: 0.88rem;
    }
    tr:last-child td { border-bottom: 2px solid #601929; }
    tr.cancelled td { color: #999; text-decoration: line-through; }
    .light  { color: #555; }
    .small  { font-size: 0.78rem; }
    .write-in { min-width: 70px; }
    .wide { min-width: 120px; }
    .bracket-section { margin-bottom: 28px; }
    .page-break { page-break-after: always; height: 0; }
    .footer-note { color: #777; font-size: 0.8rem; margin-top: 6px; }
    footer { margin-top: 24px; border-top: 1px solid #ccc; padding-top: 8px;
             color: #888; font-size: 0.78rem; text-align: right; }
    @media print {
      body { padding: 12px 18px; }
      header { page-break-after: avoid; }
      .bracket-section { page-break-inside: avoid; }
      .page-break { page-break-after: always; }
      @page { margin: 0.6in 0.5in; }
    }
  </style>
</head>
<body>
  <header>
    <h1>🏆 ${tName}</h1>
    <div class="meta">
      ${[tDate, tDiv, t?.location].filter(Boolean).join("  ·  ")}
      ${tNotes ? `<br><em>${tNotes}</em>` : ""}
    </div>
  </header>

  ${bracketTables}
  ${footerNote}

  <footer>
    Printed ${new Date().toLocaleString()}
    ${opts.scores || opts.outcome ? "  ·  * = if necessary" : ""}
  </footer>
</body>
</html>`;
}

// ── Event Delegation ──────────────────────────────────────────────────────────

document.addEventListener("click", async (e) => {
  // Umpire assign modal — open
  const tmAssignBtn = e.target.closest(".tm-assign-btn");
  if (tmAssignBtn) {
    await openTmAssignModal(
      tmAssignBtn.dataset.gid, tmAssignBtn.dataset.slot,
      tmAssignBtn.dataset.date, tmAssignBtn.dataset.time
    );
    return;
  }

  // Umpire assign modal — pick a row
  const tmAssignRow = e.target.closest(".tm-assign-row");
  if (tmAssignRow) {
    await doTmAssign(tmAssignRow.dataset.uid, tmAssignRow.dataset.name);
    return;
  }

  // Umpire assign modal — close
  if (e.target.id === "tmAssignModal" || e.target.closest("#tmAssignCloseBtn")) {
    document.getElementById("tmAssignModal").style.display = "none";
    return;
  }

  // Umpire unassign
  const tmUnassignBtn = e.target.closest(".tm-unassign-btn");
  if (tmUnassignBtn) {
    await doTmUnassign(tmUnassignBtn.dataset.gid, tmUnassignBtn.dataset.slot, tmUnassignBtn.dataset.uid);
    return;
  }

  const expandBtn = e.target.closest(".tournament-expand-btn");
  if (expandBtn) {
    const tid = expandBtn.dataset.tid;
    expandedTid = expandedTid === tid ? null : tid;
    render();
    return;
  }

  const printBtn = e.target.closest(".tournament-print-btn");
  if (printBtn) { openPrintModal(printBtn.dataset.tid); return; }

  const deleteBtn = e.target.closest(".tournament-delete-btn");
  if (deleteBtn) { await deleteTournament(deleteBtn.dataset.tid); return; }

  const statusBtn = e.target.closest(".tournament-status-btn");
  if (statusBtn) { await setStatus(statusBtn.dataset.tid, statusBtn.dataset.status); return; }

  const delayBtn = e.target.closest(".tournament-delay-btn");
  if (delayBtn) {
    await applyDelay(delayBtn.dataset.tid, parseInt(delayBtn.dataset.minutes, 10));
    return;
  }

  const resetBtn = e.target.closest(".tournament-reset-delay-btn");
  if (resetBtn) { await resetDelay(resetBtn.dataset.tid); return; }

  const swapBtn = e.target.closest(".tournament-swap-btn");
  if (swapBtn) {
    const tid     = swapBtn.dataset.tid;
    const checked = [...document.querySelectorAll(`.swap-select[data-tid="${tid}"]:checked`)];
    if (checked.length !== 2) {
      setMsg(`swapMsg_${tid}`, "Check exactly 2 games to swap, then click Swap.", "warning");
      return;
    }
    await swapUmpires(tid, checked[0].dataset.gid, checked[1].dataset.gid);
    return;
  }

  const linkBtn = e.target.closest(".tournament-link-btn");
  if (linkBtn) {
    const tid    = linkBtn.dataset.tid;
    const select = document.getElementById(`linkGameSelect_${tid}`);
    await linkGame(tid, select?.value || "");
    return;
  }

  const unlinkBtn = e.target.closest(".tournament-unlink-btn");
  if (unlinkBtn) {
    await unlinkGame(unlinkBtn.dataset.gid, unlinkBtn.dataset.tid);
    return;
  }

  const bracketRenameBtn = e.target.closest(".bracket-rename-btn");
  if (bracketRenameBtn) {
    const { tid, oldBracket } = bracketRenameBtn.dataset;
    const input = document.querySelector(`.bracket-rename-input[data-tid="${tid}"][data-old-bracket="${oldBracket}"]`);
    await renameBracket(tid, oldBracket, input?.value || oldBracket);
    return;
  }

  const bracketApplyBtn = e.target.closest(".bracket-field-apply-btn");
  if (bracketApplyBtn) {
    await assignBracketField(bracketApplyBtn.dataset.tid, bracketApplyBtn.dataset.bracket);
    return;
  }

  const bracketFlowSetupBtn = e.target.closest(".bracket-flow-setup-btn");
  if (bracketFlowSetupBtn) {
    await setupBracketAdvancement(bracketFlowSetupBtn.dataset.tid);
    return;
  }

  const bracketResizeBtn = e.target.closest(".bracket-resize-btn");
  if (bracketResizeBtn) {
    await resizeBracket(bracketResizeBtn.dataset.tid, bracketResizeBtn.dataset.bracket);
    return;
  }

  const rulesSaveBtn = e.target.closest(".rules-save-btn");
  if (rulesSaveBtn) { await saveRules(rulesSaveBtn.dataset.tid); return; }

  const rulesPrefillBtn = e.target.closest(".rules-prefill-btn");
  if (rulesPrefillBtn) { prefillDefaultRules(rulesPrefillBtn.dataset.tid); return; }

  const participantImportBtn = e.target.closest(".participant-import-btn");
  if (participantImportBtn) { openImportModal(participantImportBtn.dataset.tid); return; }

  const participantAddBtn = e.target.closest(".participant-add-btn");
  if (participantAddBtn) { await addParticipant(participantAddBtn.dataset.tid); return; }

  const participantSaveBtn = e.target.closest(".participant-save-btn");
  if (participantSaveBtn) {
    await updateParticipant(participantSaveBtn.dataset.tid, parseInt(participantSaveBtn.dataset.idx, 10));
    return;
  }

  const participantRemoveBtn = e.target.closest(".participant-remove-btn");
  if (participantRemoveBtn) {
    await removeParticipant(participantRemoveBtn.dataset.tid, parseInt(participantRemoveBtn.dataset.idx, 10));
    return;
  }

  const participantSeedsBtn = e.target.closest(".participant-apply-seeds-btn");
  if (participantSeedsBtn) { await applySeedsToGames(participantSeedsBtn.dataset.tid); return; }

  // Save a single game's teams
  const teamSaveBtn = e.target.closest(".team-save-btn");
  if (teamSaveBtn) {
    const { tid, gid } = teamSaveBtn.dataset;
    const homeEl = document.querySelector(`.team-input-home[data-gid="${gid}"]`);
    const awayEl = document.querySelector(`.team-input-away[data-gid="${gid}"]`);
    const statusEl = document.querySelector(`.team-save-status[data-gid="${gid}"]`);
    teamSaveBtn.disabled = true;
    if (statusEl) { statusEl.style.display = ""; statusEl.textContent = "Saving…"; statusEl.style.color = "#aaa"; }
    try {
      await saveGameTeams(tid, gid, homeEl?.value || "", awayEl?.value || "");
      if (statusEl) { statusEl.textContent = "✓ Saved"; statusEl.style.color = "#86efac"; }
      setTimeout(() => { if (statusEl) statusEl.style.display = "none"; }, 2000);
    } catch (err) {
      if (statusEl) { statusEl.textContent = "Error"; statusEl.style.color = "#ffb4b4"; }
    } finally {
      teamSaveBtn.disabled = false;
    }
    return;
  }

  // Save ALL games' teams in a tournament at once
  const teamSaveAllBtn = e.target.closest(".team-save-all-btn");
  if (teamSaveAllBtn) {
    const tid     = teamSaveAllBtn.dataset.tid;
    const msgEl   = document.getElementById(`teamAssignMsg_${tid}`);
    const allRows = document.querySelectorAll(`.team-input-home[data-tid="${tid}"]`);
    teamSaveAllBtn.disabled = true;
    setMsg(`teamAssignMsg_${tid}`, "Saving…", "info");
    try {
      const batch   = writeBatch(db);
      let   count   = 0;
      allRows.forEach(homeEl => {
        const gid    = homeEl.dataset.gid;
        const awayEl = document.querySelector(`.team-input-away[data-gid="${gid}"]`);
        const home   = (homeEl.value || "").trim();
        const away   = (awayEl?.value || "").trim();
        batch.update(doc(db, "games", gid), { homeTeam: home, awayTeam: away });
        const g = allGames.find(x => x.id === gid);
        if (g) { g.homeTeam = home; g.awayTeam = away; }
        count++;
      });
      await batch.commit();
      setMsg(`teamAssignMsg_${tid}`, `✓ ${count} games updated.`, "success");
    } catch (err) {
      console.error(err);
      setMsg(`teamAssignMsg_${tid}`, "Failed: " + err.message, "error");
    } finally {
      teamSaveAllBtn.disabled = false;
    }
    return;
  }
});

// Cascade facility → field options when facility dropdown changes
document.addEventListener("change", (e) => {
  const facSel = e.target.closest(".bracket-fac-select");
  if (!facSel) return;
  const { tid, bracket } = facSel.dataset;
  const fieldSel = document.querySelector(`.bracket-field-select[data-tid="${tid}"][data-bracket="${bracket}"]`);
  if (!fieldSel) return;
  const opts = buildFieldOptions(facSel.value);
  fieldSel.innerHTML = `<option value="">— Field —</option>${opts}`;
});

document.getElementById("tmAssignSearch")?.addEventListener("input", function () {
  renderAssignModalList(this.value);
});

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTournTab(tab) {
  document.querySelectorAll(".sched-sec-btn[data-tourn]").forEach(b =>
    b.classList.toggle("active", b.dataset.tourn === tab)
  );
  document.getElementById("tourn-tab-manage").style.display = tab === "manage" ? "" : "none";
  document.getElementById("tourn-tab-create").style.display = tab === "create" ? "" : "none";
}

document.querySelectorAll(".sched-sec-btn[data-tourn]").forEach(btn =>
  btn.addEventListener("click", () => switchTournTab(btn.dataset.tourn))
);

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await authReadyPromise;
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display = "none";

  // Default to Manage tab
  switchTournTab("manage");

  document.getElementById("createTournamentForm")?.addEventListener("submit", createTournament);

  try {
    await loadAll();
  } catch (err) {
    console.error(err);
    document.getElementById("tournamentList").innerHTML =
      `<p style="color:#ffb4b4">Failed to load tournaments: ${esc(err.message)}</p>`;
  }
}

init();
