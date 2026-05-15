// calendar.js — Public umpire calendar: month + list views, filters, practices
import { db, auth } from "./firebase.js";
import { isApproved, isAdmin, getCurrentUser } from "./auth.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { esc, fmtTime, todayISO } from "./utils.js";

import {
  collection, getDocs, getDoc, query, orderBy, doc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── State ─────────────────────────────────────────────────────────────────────
let allGames      = [];
let allPractices  = [];
let allLeagues    = [];   // [{ id, name, ... }] from leagues collection
let cityLeagueMap = {};   // { "City of Crooks": "leagueId", ... } built from teams

let calView      = "month";
let calYear      = new Date().getFullYear();
let calMonth     = new Date().getMonth(); // 0-based
let currentUid   = null;
let showMineOnly = false;
let showGames     = true;
let showPractices = true;

let filterDivision = "";
let filterTown     = "";   // filters on g.city (the city program)
let filterLeague   = "";   // filters on the competitive league via cityLeagueMap
let filterField    = "";

const MAX_CELL = 4;

const MONTH_NAMES = ["January","February","March","April","May","June",
                     "July","August","September","October","November","December"];
const DOW_LABELS  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoFromDate(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(y, m-1, d).getDay()];
  return `${dow}, ${m}/${d}/${y}`;
}

function isMyGame(g) {
  return !!(currentUid && (g.umpireSlots ?? []).some(s => s.assignedUid === currentUid));
}

// ── Filter logic ──────────────────────────────────────────────────────────────

function filterGame(g) {
  if (showMineOnly && !isMyGame(g)) return false;
  if (filterDivision && g.division !== filterDivision) return false;
  if (filterTown     && g.city     !== filterTown)     return false;
  if (filterLeague) {
    const gameLeagueId = cityLeagueMap[g.city];
    if (gameLeagueId !== filterLeague) return false;
  }
  if (filterField    && g.field    !== filterField)    return false;
  return true;
}

function filterPractice(p) {
  if (filterDivision && p.division !== filterDivision) return false;
  if (filterField    && p.field    !== filterField)    return false;
  return true;
}

function visibleGames()     { return showGames     ? allGames.filter(filterGame)         : []; }
function visiblePractices() { return showPractices ? allPractices.filter(filterPractice) : []; }

// ── Filter UI ─────────────────────────────────────────────────────────────────

function updateFilterCount() {
  const active = [filterDivision, filterTown, filterLeague, filterField].filter(Boolean).length
               + (showMineOnly ? 1 : 0);
  const el = document.getElementById("calFilterCount");
  if (el) el.textContent = active ? `${active} filter${active !== 1 ? "s" : ""} active` : "";
}

function populateFilterSelects() {
  // Division (games + practices)
  const divs = [...new Set([
    ...allGames.map(g => g.division),
    ...allPractices.map(p => p.division),
  ].filter(Boolean))].sort();
  const divSel = document.getElementById("calFilterDivision");
  if (divSel) {
    const cur = divSel.value;
    divSel.innerHTML = '<option value="">All Divisions</option>' +
      divs.map(d => `<option value="${esc(d)}"${d===cur?" selected":""}>${esc(d)}</option>`).join("");
  }

  // Town: unique g.city values (the city program)
  const towns = [...new Set(allGames.map(g => g.city).filter(Boolean))].sort();
  const townSel = document.getElementById("calFilterTown");
  if (townSel) {
    const cur = townSel.value;
    townSel.innerHTML = '<option value="">All Towns</option>' +
      towns.map(c => `<option value="${esc(c)}"${c===cur?" selected":""}>${esc(c)}</option>`).join("");
  }

  // League: only leagues that have at least one game (via cityLeagueMap)
  const leagueSel = document.getElementById("calFilterLeague");
  if (leagueSel) {
    const cur = leagueSel.value;
    const representedIds = new Set(allGames.map(g => cityLeagueMap[g.city]).filter(Boolean));
    const activeLeagues  = allLeagues.filter(l => representedIds.has(l.id));
    leagueSel.innerHTML = '<option value="">All Leagues</option>' +
      activeLeagues.map(l => `<option value="${esc(l.id)}"${l.id===cur?" selected":""}>${esc(l.name)}</option>`).join("");
    // Show/hide the league filter depending on whether any leagues are present
    leagueSel.style.display = activeLeagues.length ? "" : "none";
  }

  // Field (games + practices)
  const fields = [...new Set([
    ...allGames.map(g => g.field),
    ...allPractices.map(p => p.field),
  ].filter(Boolean))].sort();
  const fieldSel = document.getElementById("calFilterField");
  if (fieldSel) {
    const cur = fieldSel.value;
    fieldSel.innerHTML = '<option value="">All Fields</option>' +
      fields.map(f => `<option value="${esc(f)}"${f===cur?" selected":""}>${esc(f)}</option>`).join("");
  }
}

// ── Month view ────────────────────────────────────────────────────────────────

function renderMonth() {
  const grid = document.getElementById("calMonthView");
  if (!grid) return;

  const today = todayISO();

  // Build full-week grid (includes greyed days from adjacent months)
  const firstOfMonth = new Date(calYear, calMonth, 1);
  const gridStart    = new Date(firstOfMonth);
  gridStart.setDate(1 - firstOfMonth.getDay());
  const lastOfMonth  = new Date(calYear, calMonth + 1, 0);
  const gridEnd      = new Date(lastOfMonth);
  gridEnd.setDate(lastOfMonth.getDate() + (6 - lastOfMonth.getDay()));

  // Build date → {games, practices} map for visible items
  const dayMap = {};
  visibleGames().forEach(g => {
    if (g.cancelled && g.cancellationType !== "rainout" && g.cancellationType !== "rescheduled") return;
    if (!dayMap[g.date]) dayMap[g.date] = { games: [], practices: [] };
    dayMap[g.date].games.push(g);
  });
  visiblePractices().forEach(p => {
    if (!dayMap[p.date]) dayMap[p.date] = { games: [], practices: [] };
    dayMap[p.date].practices.push(p);
  });

  let html = `<div class="cal-month-grid">`;
  html += DOW_LABELS.map(d => `<div class="cal-dow-header">${d}</div>`).join("");

  const cur = new Date(gridStart);
  while (cur <= gridEnd) {
    const iso          = isoFromDate(cur);
    const isThisMonth  = cur.getMonth() === calMonth;
    const isToday      = iso === today;
    const items        = dayMap[iso] || { games: [], practices: [] };

    html += `<div class="cal-month-cell${!isThisMonth ? " cal-other-month" : ""}${isToday ? " cal-today" : ""}" data-date="${iso}">`;
    html += `<div class="cal-day-num${isToday ? " cal-today-num" : ""}">${cur.getDate()}</div>`;

    const gamesToShow     = items.games.slice(0, Math.min(items.games.length, MAX_CELL));
    const practiceSlots   = Math.max(0, MAX_CELL - gamesToShow.length);
    const practicesToShow = items.practices.slice(0, practiceSlots);

    gamesToShow.forEach(g => {
      const mine      = isMyGame(g);
      const isMuted   = g.cancelled && (g.cancellationType === "rainout" || g.cancellationType === "rescheduled");
      const mutedIcon = g.cancellationType === "rainout" ? "🌧" : "🔄";
      const isAway    = g.isAway === true;
      const isRef     = g.source === "calendar" && !g.needsUmpires;
      const color     = mine ? "#b8f2c4" : isAway ? "#f59e42" : isRef ? "#8888aa" : "var(--accent)";
      const assigned  = (g.umpireSlots||[]).filter(s => s.assignedUid).length;
      const total     = (g.umpireSlots||[]).length;
      const awayLabel = isAway ? `<div style="font-size:0.62rem;color:#f59e42">↗ Away</div>` : "";
      html += `<div class="cal-card${mine ? " cal-card-mine" : ""}${isRef ? " cal-card-ref" : ""}"
        data-game-id="${esc(g.id)}"
        style="border-left-color:${color}${isMuted ? ";opacity:0.5;border-style:dashed" : ""}${isRef ? ";opacity:0.7" : ""};cursor:pointer"
        title="Click for details">
        <div style="font-size:0.7rem;color:var(--light-text)">${isMuted ? mutedIcon+" " : ""}${g.time ? fmtTime(g.time).replace(":00","") : ""} ${esc(g.division||"")}</div>
        <div style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(g.city||"Game")}</div>
        ${awayLabel}${mine ? `<div style="font-size:0.65rem;color:#b8f2c4">★ Yours</div>` : ""}
        ${total && !isMuted ? `<div style="font-size:0.68rem;color:${assigned===total?"#6fcf97":"#ffcc80"}">${assigned}/${total} ump</div>` : ""}
      </div>`;
    });

    const hiddenGames = items.games.filter(g =>
      !g.cancelled || g.cancellationType === "rainout" || g.cancellationType === "rescheduled"
    ).length - gamesToShow.length;
    if (hiddenGames > 0) {
      html += `<div style="font-size:0.7rem;color:var(--light-text);padding:1px 4px">+${hiddenGames} more game${hiddenGames !== 1 ? "s" : ""}</div>`;
    }

    practicesToShow.forEach(p => {
      html += `<div class="cal-card practice"
        data-practice-id="${esc(p.id)}"
        style="border-left-color:#5b8dd9;cursor:pointer"
        title="Click for details">
        <div style="font-size:0.7rem;color:#8ab4f8">${p.startTime ? fmtTime(p.startTime).replace(":00","") : "Practice"}</div>
        <div style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:0.78rem">${esc(p.teamName||"Practice")}</div>
      </div>`;
    });

    const hiddenPractices = items.practices.length - practicesToShow.length;
    if (hiddenPractices > 0) {
      html += `<div style="font-size:0.7rem;color:#8ab4f8;padding:1px 4px">+${hiddenPractices} practice${hiddenPractices !== 1 ? "s" : ""}</div>`;
    }

    html += `</div>`;
    cur.setDate(cur.getDate() + 1);
  }

  html += `</div>`;
  grid.innerHTML = html;
}

// ── List view ─────────────────────────────────────────────────────────────────

function renderList() {
  const el = document.getElementById("calListView");
  if (!el) return;

  const today      = todayISO();
  const yyyyMM     = `${calYear}-${String(calMonth+1).padStart(2,"0")}`;
  const games      = visibleGames().filter(g => g.date?.startsWith(yyyyMM));
  const practices  = visiblePractices().filter(p => p.date?.startsWith(yyyyMM));

  if (!games.length && !practices.length) {
    el.innerHTML = `<p class="cal-list-empty">No games or practices for ${MONTH_NAMES[calMonth]} ${calYear}.</p>`;
    return;
  }

  // Build date → {games, practices} map
  const byDate = {};
  games.forEach(g => {
    if (!byDate[g.date]) byDate[g.date] = { games: [], practices: [] };
    byDate[g.date].games.push(g);
  });
  practices.forEach(p => {
    if (!byDate[p.date]) byDate[p.date] = { games: [], practices: [] };
    byDate[p.date].practices.push(p);
  });

  const dates = Object.keys(byDate).sort();
  let html = "";

  dates.forEach(iso => {
    const { games: dGames, practices: dPractices } = byDate[iso];
    const [y, m, d] = iso.split("-").map(Number);
    const dow = DOW_LABELS[new Date(y, m-1, d).getDay()];
    const isToday = iso === today;

    html += `<div class="cal-list-section">
      <div class="cal-list-date-header">
        ${dow}, ${m}/${d}/${y}${isToday ? ` <span style="color:#b8f2c4;font-size:0.75rem">● Today</span>` : ""}
      </div>`;

    dGames.sort((a,b) => (a.time||"").localeCompare(b.time||""));
    dGames.forEach(g => {
      const mine      = isMyGame(g);
      const isMuted   = g.cancelled && (g.cancellationType === "rainout" || g.cancellationType === "rescheduled");
      const isCancel  = g.cancelled && !isMuted;
      const mutedIcon = g.cancellationType === "rainout" ? "🌧 " : g.cancellationType === "rescheduled" ? "🔄 " : "";
      const cancelIcon = isCancel ? "⛔ " : "";
      const isAway    = g.isAway === true;
      const isRef     = g.source === "calendar" && !g.needsUmpires;
      const badge     = isCancel ? "cancelled" : isAway ? "away" : isRef ? "ref" : "game";
      const badgeLabel = isCancel ? "Cancelled" : isAway ? "↗ Away" : isRef ? "Ref" : "Game";
      const teams     = [g.homeTeam, g.awayTeam].filter(Boolean).join(" vs ");
      const assigned  = (g.umpireSlots||[]).filter(s => s.assignedUid).length;
      const total     = (g.umpireSlots||[]).length;

      html += `<div class="cal-list-item${isMuted ? " cal-cancelled-muted" : ""}${isCancel ? " cal-cancelled-muted" : ""}${isRef ? " cal-ref-item" : ""}"
        data-game-id="${esc(g.id)}" style="cursor:pointer">
        <div class="cal-list-time">${g.time ? fmtTime(g.time) : "—"}</div>
        <div class="cal-list-body">
          <div class="cal-list-primary">
            <span class="cal-list-badge ${badge}">${cancelIcon}${mutedIcon}${badgeLabel}</span>
            ${mine ? `<span style="font-size:0.75rem;color:#b8f2c4">★ Your game</span>` : ""}
            ${total && !isCancel && !isMuted ? `<span style="font-size:0.75rem;color:${assigned===total?"#6fcf97":"#ffcc80"}">${assigned}/${total} ump</span>` : ""}
          </div>
          <div style="font-weight:600">${esc(g.city||"")} <span style="color:var(--light-text);font-weight:normal">${esc(g.division||"")}</span></div>
          ${teams ? `<div class="cal-list-meta">${esc(teams)}</div>` : ""}
          ${g.field ? `<div class="cal-list-meta">📍 ${esc(g.field)}</div>` : ""}
          ${total ? `<div class="cal-list-meta">${(g.umpireSlots||[]).map(s => {
            const cls = s.type === "Plate" ? "plate" : s.type === "Field" ? "field" : "extra";
            const who = s.assignedName
              ? `<span style="color:var(--light-text)"> → ${esc(s.assignedName)}</span>`
              : `<span style="color:#ffcc80"> Open</span>`;
            return `<span class="badge badge-${cls}">${esc(s.type)}</span>${who}`;
          }).join(" ")}</div>` : ""}
        </div>
      </div>`;
    });

    dPractices.sort((a,b) => (a.startTime||"").localeCompare(b.startTime||""));
    dPractices.forEach(p => {
      html += `<div class="cal-list-item" data-practice-id="${esc(p.id)}" style="cursor:pointer">
        <div class="cal-list-time">${p.startTime ? fmtTime(p.startTime) : "—"}</div>
        <div class="cal-list-body">
          <div class="cal-list-primary">
            <span class="cal-list-badge practice">Practice</span>
          </div>
          <div style="font-weight:600">${esc(p.teamName||"Practice")}</div>
          ${p.division ? `<div class="cal-list-meta">${esc(p.division)}</div>` : ""}
          ${p.field ? `<div class="cal-list-meta">📍 ${esc(p.field)}</div>` : ""}
          ${p.notes ? `<div class="cal-list-meta" style="color:var(--light-text)">${esc(p.notes)}</div>` : ""}
        </div>
      </div>`;
    });

    html += `</div>`;
  });

  el.innerHTML = html;
}

// ── Navigation ────────────────────────────────────────────────────────────────

function updateMonthLabel() {
  const label = new Date(calYear, calMonth, 1)
    .toLocaleDateString("en-US", { month:"long", year:"numeric" });
  document.getElementById("calLabel").textContent = label;
}

function render() {
  updateMonthLabel();
  const monthEl = document.getElementById("calMonthView");
  const listEl  = document.getElementById("calListView");
  if (monthEl) monthEl.style.display = calView === "month" ? "" : "none";
  if (listEl)  listEl.style.display  = calView === "list"  ? "" : "none";
  if (calView === "month") renderMonth();
  else                     renderList();
}

function navigate(dir) {
  calMonth += dir;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  if (calMonth < 0)  { calMonth = 11; calYear--; }
  render();
}

// ── My Games toggle ───────────────────────────────────────────────────────────

function updateMyGamesBtn() {
  const btn = document.getElementById("calMyGamesBtn");
  if (!btn) return;
  btn.textContent = showMineOnly ? "★ My Games" : "All Games";
  btn.classList.toggle("filter-active", showMineOnly);
  btn.classList.toggle("print-btn",     !showMineOnly);
}

// ── Init ──────────────────────────────────────────────────────────────────────

// ── Detail modal ──────────────────────────────────────────────────────────────

function openDetailModal(html) {
  const content = document.getElementById("calDetailContent");
  const modal   = document.getElementById("calDetailModal");
  if (!content || !modal) return;
  content.innerHTML = html;
  modal.style.display = "flex";
  document.body.style.overflow = "hidden";
}

function closeDetailModal() {
  const modal = document.getElementById("calDetailModal");
  if (modal) modal.style.display = "none";
  document.body.style.overflow = "";
}

function openGameDetail(gameId) {
  const g = allGames.find(x => x.id === gameId);
  if (!g) return;

  const admin    = isAdmin();
  const approved = isApproved() || admin;
  const mine     = isMyGame(g);
  const isAway   = g.isAway === true;
  const isMuted  = g.cancelled && (g.cancellationType === "rainout" || g.cancellationType === "rescheduled");
  const isCancel = g.cancelled && !isMuted;
  const teams    = g.homeTeam && g.awayTeam
    ? (isAway ? `${esc(g.awayTeam)} <span style="color:var(--light-text)">@</span> ${esc(g.homeTeam)}`
              : `${esc(g.homeTeam)} <span style="color:var(--light-text)">vs</span> ${esc(g.awayTeam)}`)
    : esc(g.homeTeam || g.awayTeam || "");

  let statusBadge;
  if (isCancel)      statusBadge = `<span class="badge" style="background:#5a1a1a;color:#ffb4b4">⛔ Cancelled</span>`;
  else if (isMuted)  statusBadge = `<span class="badge" style="background:#3a2a00;color:#ffcc80">${g.cancellationType === "rainout" ? "🌧 Rain Out" : "🔄 Rescheduled"}</span>`;
  else if (g.date >= todayISO()) statusBadge = `<span class="badge" style="background:#17351f;color:#b8f2c4">Upcoming</span>`;
  else               statusBadge = `<span class="badge" style="background:#2a2a2a;color:#aaa">Past</span>`;

  const slots = g.umpireSlots || [];
  const slotsHtml = slots.length ? `
    <div style="margin-top:14px;border-top:1px solid #333;padding-top:12px">
      <div style="font-size:0.78rem;color:var(--light-text);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Umpire Slots</div>
      ${slots.map(s => {
        const cls = s.type === "Plate" ? "plate" : s.type === "Field" ? "field" : "extra";
        const who = s.assignedUid
          ? (approved
              ? `<span style="color:#b8f2c4">→ ${esc(s.assignedName || "Assigned")}</span>`
              : `<span style="color:#b8f2c4">Filled</span>`)
          : `<span style="color:#ffcc80">Open</span>`;
        const pay = (admin && s.payRate) ? `<span style="color:var(--light-text);font-size:0.78rem;margin-left:auto">$${s.payRate}</span>` : "";
        return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span class="badge badge-${cls}">${esc(s.type)}</span>${who}${pay}
        </div>`;
      }).join("")}
    </div>` : "";

  const row = (label, val) => val
    ? `<div style="display:flex;gap:12px;margin-bottom:7px">
        <span style="color:var(--light-text);font-size:0.82rem;min-width:72px;padding-top:1px">${label}</span>
        <span>${val}</span>
       </div>`
    : "";

  const html = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px">
      <div>
        <h3 style="margin:0 0 6px;font-size:1.1rem">${esc(g.division || "Game")}</h3>
        ${statusBadge}${mine ? ` <span style="font-size:0.78rem;color:#b8f2c4">★ Your game</span>` : ""}
      </div>
      ${admin ? `<a href="admin-games.html" class="btn print-btn" style="font-size:0.8rem;padding:5px 12px;white-space:nowrap;flex-shrink:0">Edit →</a>` : ""}
    </div>
    ${row("Date",    fmtDate(g.date))}
    ${row("Time",    g.time ? fmtTime(g.time) : "")}
    ${row("Program", g.city)}
    ${teams ? row("Teams", teams) : ""}
    ${row("Field",   g.field)}
    ${slotsHtml}`;

  openDetailModal(html);
}

function openPracticeDetail(practiceId) {
  const p = allPractices.find(x => x.id === practiceId);
  if (!p) return;

  const admin = isAdmin();

  const row = (label, val) => val
    ? `<div style="display:flex;gap:12px;margin-bottom:7px">
        <span style="color:var(--light-text);font-size:0.82rem;min-width:72px;padding-top:1px">${label}</span>
        <span>${val}</span>
       </div>`
    : "";

  const timeRange = p.startTime
    ? fmtTime(p.startTime) + (p.endTime ? ` – ${fmtTime(p.endTime)}` : "")
    : "";

  const html = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px">
      <div>
        <h3 style="margin:0 0 6px;font-size:1.1rem">Practice</h3>
        <span class="cal-list-badge practice" style="font-size:0.8rem">Practice</span>
      </div>
      ${admin ? `<a href="admin-scheduler.html" class="btn print-btn" style="font-size:0.8rem;padding:5px 12px;white-space:nowrap;flex-shrink:0">Manage →</a>` : ""}
    </div>
    ${row("Team",     p.teamName)}
    ${row("Date",     fmtDate(p.date))}
    ${row("Time",     timeRange)}
    ${row("Division", p.division)}
    ${row("Field",    p.field)}
    ${p.notes ? `<div style="margin-top:10px;padding:10px;background:#1a1a2a;border-radius:6px;font-size:0.88rem;color:var(--light-text)">${esc(p.notes)}</div>` : ""}`;

  openDetailModal(html);
}

async function loadData() {
  try {
    const fetches = [
      getDocs(query(collection(db, "games"), orderBy("date"), orderBy("time"))),
      getDocs(collection(db, "leagues")),
      isApproved()
        ? getDocs(query(collection(db, "practices"), orderBy("date"), orderBy("startTime")))
        : Promise.resolve({ docs: [] }),
    ];
    // Load teams for city→league mapping only when signed in (config requires auth)
    if (currentUid) fetches.push(getDoc(doc(db, "config", "teamCalendars")));

    const results     = await Promise.all(fetches);
    allGames          = results[0].docs.map(d => ({ id: d.id, ...d.data() }));
    allLeagues        = results[1].docs.map(d => ({ id: d.id, ...d.data() }));
    allPractices      = results[2].docs.map(d => ({ id: d.id, ...d.data() }));

    // Build city → leagueId map from team configs (only available when authed)
    cityLeagueMap = {};
    if (currentUid && results[3]) {
      const teams = results[3].exists() ? (results[3].data().teams || []) : [];
      teams.forEach(t => { if (t.leagueId && t.city) cityLeagueMap[t.city] = t.leagueId; });
    }

    populateFilterSelects();
    updateFilterCount();
    render();
  } catch (err) {
    console.error(err);
    const el = document.getElementById("calMonthView") || document.getElementById("calListView");
    if (el) el.innerHTML = `<div class="document-note"><p style="color:#ffb4b4">Error loading calendar.</p></div>`;
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.getElementById("calPrev").addEventListener("click",  () => navigate(-1));
document.getElementById("calNext").addEventListener("click",  () => navigate(1));
document.getElementById("calToday").addEventListener("click", () => {
  const now = new Date();
  calYear  = now.getFullYear();
  calMonth = now.getMonth();
  render();
});

document.querySelectorAll(".cal-view-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    calView = btn.dataset.view;
    document.querySelectorAll(".cal-view-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.view === calView);
    });
    render();
  });
});

document.getElementById("calShowGames")?.addEventListener("change", e => {
  showGames = e.target.checked;
  updateFilterCount();
  render();
});

document.getElementById("calShowPractices")?.addEventListener("change", e => {
  showPractices = e.target.checked;
  updateFilterCount();
  render();
});

document.getElementById("calMyGamesBtn")?.addEventListener("click", () => {
  showMineOnly = !showMineOnly;
  updateMyGamesBtn();
  updateFilterCount();
  render();
});

document.getElementById("calFilterDivision")?.addEventListener("change", e => {
  filterDivision = e.target.value;
  updateFilterCount();
  render();
});

document.getElementById("calFilterTown")?.addEventListener("change", e => {
  filterTown = e.target.value;
  updateFilterCount();
  render();
});

document.getElementById("calFilterLeague")?.addEventListener("change", e => {
  filterLeague = e.target.value;
  updateFilterCount();
  render();
});

document.getElementById("calFilterField")?.addEventListener("change", e => {
  filterField = e.target.value;
  updateFilterCount();
  render();
});

document.getElementById("calFilterReset")?.addEventListener("click", () => {
  filterDivision = "";
  filterTown     = "";
  filterLeague   = "";
  filterField    = "";
  showMineOnly   = false;
  showGames      = true;
  showPractices  = true;
  const divSel    = document.getElementById("calFilterDivision");
  const townSel   = document.getElementById("calFilterTown");
  const leagueSel = document.getElementById("calFilterLeague");
  const fieldSel  = document.getElementById("calFilterField");
  const gamesCb   = document.getElementById("calShowGames");
  const pracCb    = document.getElementById("calShowPractices");
  if (divSel)    divSel.value    = "";
  if (townSel)   townSel.value   = "";
  if (leagueSel) leagueSel.value = "";
  if (fieldSel)  fieldSel.value  = "";
  if (gamesCb)   gamesCb.checked  = true;
  if (pracCb)    pracCb.checked   = true;
  updateMyGamesBtn();
  updateFilterCount();
  render();
});

// ── Delegated click handlers for game/practice detail modal ──────────────────

function handleCalClick(e) {
  const gameCard     = e.target.closest("[data-game-id]");
  const practiceCard = e.target.closest("[data-practice-id]");
  if (gameCard)     openGameDetail(gameCard.dataset.gameId);
  if (practiceCard) openPracticeDetail(practiceCard.dataset.practiceId);
}

document.getElementById("calMonthView")?.addEventListener("click", handleCalClick);
document.getElementById("calListView")?.addEventListener("click",  handleCalClick);

// Modal close: × button, backdrop click, Escape key
document.getElementById("calDetailClose")?.addEventListener("click", closeDetailModal);
document.getElementById("calDetailModal")?.addEventListener("click", e => {
  if (e.target === e.currentTarget) closeDetailModal();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeDetailModal();
});

onAuthStateChanged(auth, user => {
  currentUid = user?.uid ?? null;
  const btn = document.getElementById("calMyGamesBtn");
  if (btn) btn.style.display = currentUid ? "" : "none";
  updateMyGamesBtn();
  loadData();
});
