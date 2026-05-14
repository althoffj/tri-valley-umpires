// calendar.js — Public umpire calendar: month + list views, filters, practices
import { db, auth } from "./firebase.js";
import { isApproved, getCurrentUser } from "./auth.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  collection, getDocs, query, orderBy, where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── State ─────────────────────────────────────────────────────────────────────
let allGames     = [];
let allPractices = [];
let calView      = "month";
let calYear      = new Date().getFullYear();
let calMonth     = new Date().getMonth(); // 0-based
let currentUid   = null;
let showMineOnly = false;

let filterDivision = "";
let filterCity     = "";
let filterField    = "";

const MAX_CELL = 4; // max items per month cell; games fill first

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function isoOf(y, m, d) {
  return `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
}

function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,"0")} ${h >= 12 ? "PM" : "AM"}`;
}

function esc(v) {
  return String(v ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function isMyGame(g) {
  return !!(currentUid && (g.umpireSlots ?? []).some(s => s.assignedUid === currentUid));
}

// ── Filter logic ──────────────────────────────────────────────────────────────

function filterGame(g) {
  if (showMineOnly && !isMyGame(g)) return false;
  if (filterDivision && g.division !== filterDivision) return false;
  if (filterCity     && g.city     !== filterCity)     return false;
  if (filterField    && g.field    !== filterField)    return false;
  return true;
}

function filterPractice(p) {
  if (filterDivision && p.division !== filterDivision) return false;
  if (filterField    && p.field    !== filterField)    return false;
  return true;
}

function visibleGames()     { return allGames.filter(filterGame); }
function visiblePractices() { return allPractices.filter(filterPractice); }

// ── Filter UI ─────────────────────────────────────────────────────────────────

function updateFilterCount() {
  const active = [filterDivision, filterCity, filterField].filter(Boolean).length
               + (showMineOnly ? 1 : 0);
  const el = document.getElementById("calFilterCount");
  if (el) el.textContent = active ? `${active} filter${active !== 1 ? "s" : ""} active` : "";
}

function populateFilterSelects() {
  // Division
  const divs = [...new Set(allGames.map(g => g.division).filter(Boolean))].sort();
  const divSel = document.getElementById("calFilterDivision");
  if (divSel) {
    const cur = divSel.value;
    divSel.innerHTML = '<option value="">All Divisions</option>' +
      divs.map(d => `<option value="${esc(d)}"${d===cur?" selected":""}>${esc(d)}</option>`).join("");
  }

  // City / League
  const cities = [...new Set(allGames.map(g => g.city).filter(Boolean))].sort();
  const citySel = document.getElementById("calFilterCity");
  if (citySel) {
    const cur = citySel.value;
    citySel.innerHTML = '<option value="">All Leagues</option>' +
      cities.map(c => `<option value="${esc(c)}"${c===cur?" selected":""}>${esc(c)}</option>`).join("");
  }

  // Field
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

function gamesForDate(iso)     { return visibleGames().filter(g => g.date === iso); }
function practicesForDate(iso) { return visiblePractices().filter(p => p.date === iso); }

function renderMonth() {
  const today = todayISO();
  const firstDay  = new Date(calYear, calMonth, 1);
  const lastDay   = new Date(calYear, calMonth + 1, 0);
  const startDOW  = firstDay.getDay();
  const totalDays = lastDay.getDate();

  let html = `<div class="cal-month-grid">
    <div class="cal-dow-header">Sun</div><div class="cal-dow-header">Mon</div>
    <div class="cal-dow-header">Tue</div><div class="cal-dow-header">Wed</div>
    <div class="cal-dow-header">Thu</div><div class="cal-dow-header">Fri</div>
    <div class="cal-dow-header">Sat</div>`;

  for (let i = 0; i < startDOW; i++) html += `<div class="cal-month-cell cal-other-month"></div>`;

  for (let d = 1; d <= totalDays; d++) {
    const iso      = isoOf(calYear, calMonth, d);
    const isToday  = iso === today;
    const games    = gamesForDate(iso);
    const practices = practicesForDate(iso);

    // Games take priority; practices fill remaining cell space
    const gamesToShow     = games.slice(0, Math.min(games.length, MAX_CELL));
    const practiceSlots   = Math.max(0, MAX_CELL - gamesToShow.length);
    const practicesToShow = practices.slice(0, practiceSlots);

    html += `<div class="cal-month-cell${isToday ? " cal-today" : ""}" data-date="${iso}">
      <div class="cal-day-num${isToday ? " cal-today-num" : ""}">${d}</div>`;

    gamesToShow.forEach(g => {
      const mine    = isMyGame(g);
      const isMuted = g.cancelled && (g.cancellationType === "rainout" || g.cancellationType === "rescheduled");
      const isCancel = g.cancelled && !isMuted;
      const mutedIcon = g.cancellationType === "rainout" ? "🌧" : "🔄";
      const color = mine ? "#b8f2c4" : "var(--accent)";
      if (isCancel) return; // outright cancelled — skip from month
      html += `<div class="cal-card${mine ? " cal-card-mine" : ""}"
        style="border-left-color:${color}${isMuted ? ";opacity:0.5;border-style:dashed" : ""}"
        title="${isMuted ? (g.cancellationType === "rainout" ? "Rain Out" : "Rescheduled") + " · " : ""}${esc(g.city||"")} ${esc(g.division||"")} · ${g.field||""}">
        <div style="font-size:0.7rem;color:var(--light-text)">${isMuted ? mutedIcon+" " : ""}${g.time ? fmtTime(g.time).replace(":00","") : ""} ${esc(g.division||"")}</div>
        <div style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(g.city||"Game")}</div>
        ${mine ? `<div style="font-size:0.65rem;color:#b8f2c4">★ Yours</div>` : ""}
      </div>`;
    });

    if (games.filter(g => !g.cancelled || g.cancellationType === "rainout" || g.cancellationType === "rescheduled").length > gamesToShow.length) {
      html += `<div style="font-size:0.7rem;color:var(--light-text);padding:1px 4px">+more</div>`;
    }

    practicesToShow.forEach(p => {
      html += `<div class="cal-card practice"
        style="border-left-color:#5b8dd9"
        title="Practice: ${esc(p.teamName||"")} · ${p.field||""}">
        <div style="font-size:0.7rem;color:#8ab4f8">${p.startTime ? fmtTime(p.startTime).replace(":00","") : "Practice"}</div>
        <div style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:0.78rem">${esc(p.teamName||"Practice")}</div>
      </div>`;
    });

    html += `</div>`;
  }

  const trailing = (7 - ((startDOW + totalDays) % 7)) % 7;
  for (let i = 0; i < trailing; i++) html += `<div class="cal-month-cell cal-other-month"></div>`;
  html += `</div>`;

  document.getElementById("calView").innerHTML = html;
}

// ── List view ─────────────────────────────────────────────────────────────────

function renderList() {
  const games     = visibleGames();
  const practices = visiblePractices();
  const today     = todayISO();

  // Build a map of date → {games, practices}
  const byDate = {};
  const addItem = (iso, type, item) => {
    if (!byDate[iso]) byDate[iso] = { games:[], practices:[] };
    byDate[iso][type].push(item);
  };

  // Only show current month
  const yyyyMM = `${calYear}-${String(calMonth+1).padStart(2,"0")}`;
  games.forEach(g => { if (g.date?.startsWith(yyyyMM)) addItem(g.date, "games", g); });
  practices.forEach(p => { if (p.date?.startsWith(yyyyMM)) addItem(p.date, "practices", p); });

  const dates = Object.keys(byDate).sort();

  if (!dates.length) {
    document.getElementById("calView").innerHTML =
      `<p class="cal-list-empty">No games or practices this month.</p>`;
    return;
  }

  let html = "";
  dates.forEach(iso => {
    const { games: dGames, practices: dPractices } = byDate[iso];
    const [y, m, d] = iso.split("-").map(Number);
    const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(y,m-1,d).getDay()];
    const isToday = iso === today;

    html += `<div class="cal-list-section">
      <div class="cal-list-date-header${isToday ? "" : ""}">
        ${dow}, ${m}/${d}/${y}${isToday ? " <span style=\"color:#b8f2c4;font-size:0.75rem\">● Today</span>" : ""}
      </div>`;

    // Games (sorted by time)
    dGames.sort((a,b) => (a.time||"").localeCompare(b.time||""));
    dGames.forEach(g => {
      const mine    = isMyGame(g);
      const isMuted = g.cancelled && (g.cancellationType === "rainout" || g.cancellationType === "rescheduled");
      const isCancel = g.cancelled && !isMuted;
      const mutedIcon = g.cancellationType === "rainout" ? "🌧 " : g.cancellationType === "rescheduled" ? "🔄 " : "";
      const cancelIcon = isCancel ? "⛔ " : "";
      const badge = isCancel ? "cancelled" : "game";
      const teams = [g.homeTeam, g.awayTeam].filter(Boolean).join(" vs ");

      html += `<div class="cal-list-item${isMuted ? " cal-cancelled-muted" : ""}${isCancel ? " cal-cancelled-muted" : ""}">
        <div class="cal-list-time">${g.time ? fmtTime(g.time) : "—"}</div>
        <div class="cal-list-body">
          <div class="cal-list-primary">
            <span class="cal-list-badge ${badge}">${cancelIcon}${mutedIcon}${isCancel ? "Cancelled" : "Game"}</span>
            ${mine ? `<span style="font-size:0.75rem;color:#b8f2c4">★ Your game</span>` : ""}
          </div>
          <div style="font-weight:600">${esc(g.city||"")} <span style="color:var(--light-text);font-weight:normal">${esc(g.division||"")}</span></div>
          ${teams ? `<div class="cal-list-meta">${esc(teams)}</div>` : ""}
          ${g.field ? `<div class="cal-list-meta">📍 ${esc(g.field)}</div>` : ""}
          ${(g.umpireSlots||[]).length ? `<div class="cal-list-meta">${(g.umpireSlots||[]).map(s => {
            const cls = s.type === "Plate" ? "plate" : s.type === "Field" ? "field" : "extra";
            const who = s.assignedName
              ? `<span style="color:var(--light-text)"> → ${esc(s.assignedName)}</span>`
              : `<span style="color:#ffcc80"> Open</span>`;
            return `<span class="badge badge-${cls}">${s.type}</span>${who}`;
          }).join(" ")}</div>` : ""}
        </div>
      </div>`;
    });

    // Practices
    dPractices.sort((a,b) => (a.startTime||"").localeCompare(b.startTime||""));
    dPractices.forEach(p => {
      html += `<div class="cal-list-item">
        <div class="cal-list-time">${p.startTime ? fmtTime(p.startTime) : "—"}</div>
        <div class="cal-list-body">
          <div class="cal-list-primary">
            <span class="cal-list-badge practice">Practice</span>
          </div>
          <div style="font-weight:600">${esc(p.teamName||"Practice")}</div>
          ${p.field ? `<div class="cal-list-meta">📍 ${esc(p.field)}</div>` : ""}
          ${p.division ? `<div class="cal-list-meta">${esc(p.division)}</div>` : ""}
        </div>
      </div>`;
    });

    html += `</div>`;
  });

  document.getElementById("calView").innerHTML = html;
}

// ── Navigation ────────────────────────────────────────────────────────────────

function updateMonthLabel() {
  const label = new Date(calYear, calMonth, 1)
    .toLocaleDateString("en-US", { month:"long", year:"numeric" });
  document.getElementById("calLabel").textContent = label;
}

function render() {
  updateMonthLabel();
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

async function loadData() {
  try {
    const [gamesSnap, practicesSnap] = await Promise.all([
      getDocs(query(collection(db, "games"), orderBy("date"), orderBy("time"))),
      isApproved()
        ? getDocs(query(collection(db, "practices"), orderBy("date"), orderBy("startTime")))
        : Promise.resolve({ docs: [] }),
    ]);

    allGames     = gamesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    allPractices = practicesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    populateFilterSelects();
    updateFilterCount();
    render();
  } catch (err) {
    console.error(err);
    document.getElementById("calView").innerHTML =
      `<div class="document-note"><p style="color:#ffb4b4">Error loading calendar.</p></div>`;
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

document.getElementById("calFilterCity")?.addEventListener("change", e => {
  filterCity = e.target.value;
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
  filterCity     = "";
  filterField    = "";
  showMineOnly   = false;
  const divSel = document.getElementById("calFilterDivision");
  const citySel = document.getElementById("calFilterCity");
  const fieldSel = document.getElementById("calFilterField");
  if (divSel)   divSel.value   = "";
  if (citySel)  citySel.value  = "";
  if (fieldSel) fieldSel.value = "";
  updateMyGamesBtn();
  updateFilterCount();
  render();
});

onAuthStateChanged(auth, user => {
  currentUid = user?.uid ?? null;
  const btn = document.getElementById("calMyGamesBtn");
  if (btn) btn.style.display = currentUid ? "" : "none";
  updateMyGamesBtn();
  // Reload to pick up practices if just signed in as approved umpire
  loadData();
});
