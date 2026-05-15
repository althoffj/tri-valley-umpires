import { esc, fmtDate, fmtTime, fmtTime as fmt12, todayISO } from "./utils.js";
// facility-schedule.js — Public shareable facility field schedule
// No auth required. Calls getFacilitySchedule cloud function.

const FUNCTIONS_BASE = "https://us-central1-tri-valley-baseball-umpires.cloudfunctions.net";

// ── URL params ────────────────────────────────────────────────────────────────

const params     = new URLSearchParams(window.location.search);
const facilityId = params.get("id");

const now = new Date();
let year  = parseInt(params.get("year"))  || now.getFullYear();
let month = parseInt(params.get("month")) || (now.getMonth() + 1); // 1-based

// ── State ─────────────────────────────────────────────────────────────────────

let facilityData   = null;
let allGames       = [];
let allPractices   = [];
let calView        = "list";
let filterField    = "";
let filterType     = "";
let filterDiv      = "";

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function fmtDateLong(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

const MONTH_NAMES = ["January","February","March","April","May","June",
                     "July","August","September","October","November","December"];
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadSchedule() {
  if (!facilityId) {
    showError("No facility ID in URL. Use a link provided by the Tri-Valley Baseball Umpires admin.");
    return;
  }

  try {
    const url = `${FUNCTIONS_BASE}/getFacilitySchedule?facilityId=${encodeURIComponent(facilityId)}&year=${year}&month=${month}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      showError(body.error || `Server error ${resp.status}`);
      return;
    }
    const data = await resp.json();
    facilityData = data.facility;
    allGames     = data.games     || [];
    allPractices = data.practices || [];

    document.title = `${facilityData.name} Schedule — Tri-Valley Baseball`;
    renderFacilityInfo();
    populateFieldFilter();
    render();

    document.getElementById("loadingState").style.display  = "none";
    document.getElementById("scheduleContent").style.display = "";
  } catch (err) {
    showError("Failed to load schedule: " + err.message);
  }
}

function showError(msg) {
  document.getElementById("loadingState").style.display  = "none";
  document.getElementById("errorState").style.display    = "";
  document.getElementById("errorMsg").textContent        = msg;
}

// ── Render facility info ──────────────────────────────────────────────────────

function renderFacilityInfo() {
  const f   = facilityData;
  const map = f.googleMapsUrl
    ? ` · <a href="${esc(f.googleMapsUrl)}" target="_blank" rel="noopener" style="color:var(--accent)">View on Google Maps</a>`
    : "";
  const fields = (f.fields || []).map(fl => esc(fl.name)).join(" · ");
  document.getElementById("facilityInfo").innerHTML = `
    <h2 class="fs-facility-name">${esc(f.name)}</h2>
    ${f.address ? `<div class="fs-facility-meta">${esc(f.address)}${map}</div>` : ""}
    ${fields ? `<div style="margin-top:6px;font-size:0.82rem;color:var(--light-text)">Fields: ${fields}</div>` : ""}
    ${f.notes ? `<div style="margin-top:6px;font-size:0.85rem;color:#ccc">${esc(f.notes)}</div>` : ""}
  `;
}

// ── Populate field filter ─────────────────────────────────────────────────────

function populateFieldFilter() {
  const sel = document.getElementById("fsFilterField");
  const fields = new Set();
  allGames.forEach(g => { if (g.field) fields.add(g.field); });
  allPractices.forEach(p => { if (p.field) fields.add(p.field); });
  sel.innerHTML = '<option value="">All Fields</option>' +
    [...fields].sort().map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join("");
}

// ── Filter helpers ────────────────────────────────────────────────────────────

function visibleGames() {
  if (filterType === "practice") return [];
  return allGames.filter(g => {
    if (filterField && g.field !== filterField) return false;
    if (filterDiv   && g.division !== filterDiv) return false;
    return true;
  });
}

function visiblePractices() {
  if (filterType === "game") return [];
  return allPractices.filter(p => {
    if (filterField && p.field !== filterField) return false;
    if (filterDiv   && p.division !== filterDiv) return false;
    return true;
  });
}

function updateFilterCount() {
  const active = [filterField, filterType, filterDiv].filter(Boolean).length;
  const el = document.getElementById("fsFilterCount");
  if (el) el.textContent = active ? `${active} filter${active !== 1 ? "s" : ""} active` : "";
}

// ── Main render dispatcher ────────────────────────────────────────────────────

function render() {
  document.getElementById("monthLabel").textContent = `${MONTH_NAMES[month - 1]} ${year}`;
  updateFilterCount();
  if (calView === "month") renderMonthView();
  else                     renderListView();
}

// ── List view ─────────────────────────────────────────────────────────────────

function renderListView() {
  const el = document.getElementById("fsListView");

  const mm = String(month).padStart(2, "0");
  const firstISO = `${year}-${mm}-01`;
  const lastDay  = new Date(year, month, 0).getDate();
  const lastISO  = `${year}-${mm}-${String(lastDay).padStart(2,"0")}`;

  const games     = visibleGames().filter(g => g.date >= firstISO && g.date <= lastISO);
  const practices = visiblePractices().filter(p => p.date >= firstISO && p.date <= lastISO);

  // Combine and sort by date + time
  const items = [
    ...games.map(g => ({ ...g, _kind: "game" })),
    ...practices.map(p => ({ ...p, _kind: "practice", time: p.startTime })),
  ].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.time || "") < (b.time || "") ? -1 : 1;
  });

  if (!items.length) {
    el.innerHTML = `<div class="cal-list-empty">No games or practices scheduled for ${MONTH_NAMES[month-1]} ${year}.</div>`;
    return;
  }

  // Group by date
  const byDate = {};
  items.forEach(item => {
    if (!byDate[item.date]) byDate[item.date] = [];
    byDate[item.date].push(item);
  });

  el.innerHTML = Object.keys(byDate).sort().map(date => {
    const dayItems = byDate[date];
    const rows = dayItems.map(item => {
      if (item._kind === "game") {
        const isCancelled = item.cancelled;
        const cancelIcon  = item.cancellationType === "rainout" ? "🌧" : item.cancellationType === "rescheduled" ? "🔄" : "⛔";
        const badgeClass  = isCancelled ? "cancelled" : "game";
        const badgeLabel  = isCancelled
          ? `${cancelIcon} ${item.cancellationType || "Cancelled"}`
          : `⚾ ${item.gameType || "Game"}`;
        const teams = item.homeTeam && item.awayTeam
          ? `${esc(item.awayTeam)} @ ${esc(item.homeTeam)}`
          : esc(item.homeTeam || item.awayTeam || "TBD");
        return `<div class="cal-list-item" style="${isCancelled ? "opacity:0.55" : ""}">
          <div class="cal-list-time">${item.time ? fmt12(item.time) : "TBD"}</div>
          <div class="cal-list-badge ${badgeClass}">${badgeLabel}</div>
          <div class="cal-list-body">
            <div class="cal-list-primary">${teams}</div>
            <div class="cal-list-meta">${esc(item.division || "")}${item.field ? " · " + esc(item.field) : ""}${item.city ? " · " + esc(item.city) : ""}</div>
          </div>
        </div>`;
      } else {
        const timeStr = item.startTime
          ? `${fmt12(item.startTime)}${item.endTime ? " – " + fmt12(item.endTime) : ""}`
          : "TBD";
        return `<div class="cal-list-item">
          <div class="cal-list-time">${timeStr}</div>
          <div class="cal-list-badge practice">🏃 Practice</div>
          <div class="cal-list-body">
            <div class="cal-list-primary">${esc(item.teamName || "Practice")}</div>
            <div class="cal-list-meta">${esc(item.division || "")}${item.field ? " · " + esc(item.field) : ""}</div>
          </div>
        </div>`;
      }
    }).join("");

    return `<div class="cal-list-section">
      <div class="cal-list-date-header">${fmtDateLong(date)}</div>
      ${rows}
    </div>`;
  }).join("");
}

// ── Month view ────────────────────────────────────────────────────────────────

function renderMonthView() {
  const el = document.getElementById("fsMonthView");

  const games     = visibleGames();
  const practices = visiblePractices();

  const firstOfMonth = new Date(year, month - 1, 1);
  const gridStart    = new Date(firstOfMonth);
  gridStart.setDate(1 - firstOfMonth.getDay());
  const lastOfMonth  = new Date(year, month, 0);
  const gridEnd      = new Date(lastOfMonth);
  gridEnd.setDate(lastOfMonth.getDate() + (6 - lastOfMonth.getDay()));

  // Day map
  const dayMap = {};
  games.forEach(g => {
    if (!dayMap[g.date]) dayMap[g.date] = { games: [], practices: [] };
    dayMap[g.date].games.push(g);
  });
  practices.forEach(p => {
    if (!dayMap[p.date]) dayMap[p.date] = { games: [], practices: [] };
    dayMap[p.date].practices.push(p);
  });

  const todayStr = todayISO();
  let html = `<div class="cal-month-grid">`;
  html += DOW.map(d => `<div class="cal-dow-header">${d}</div>`).join("");

  const cur = new Date(gridStart);
  while (cur <= gridEnd) {
    const iso       = isoFromDate(cur);
    const otherMon  = cur.getMonth() !== (month - 1);
    const isToday   = iso === todayStr;
    const items     = dayMap[iso] || { games: [], practices: [] };

    // Games get priority: fill up to MAX_CELL; practices take the remainder
    const MAX_CELL      = 4;
    const gamesToShow   = items.games.slice(0, Math.min(items.games.length, MAX_CELL));
    const practiceSlots = Math.max(0, MAX_CELL - gamesToShow.length);
    const practicesToShow = items.practices.slice(0, practiceSlots);

    const cellClasses = ["cal-month-cell", otherMon ? "cal-other-month" : "", isToday ? "cal-today" : ""].filter(Boolean).join(" ");
    html += `<div class="${cellClasses}">`;
    html += `<div class="${isToday ? "cal-today-num" : "cal-day-num"}">${cur.getDate()}</div>`;

    gamesToShow.forEach(g => {
      const isCancelled = g.cancelled;
      const cancelIcon  = g.cancellationType === "rainout" ? "🌧" : g.cancellationType === "rescheduled" ? "🔄" : "";
      const teams = g.homeTeam && g.awayTeam
        ? `${g.awayTeam.split(" ").pop()} @ ${g.homeTeam.split(" ").pop()}`
        : (g.homeTeam || g.division || "Game");
      html += `<div class="cal-card${isCancelled ? " cancelled" : ""}" style="border-left-color:#601929"
        title="${isCancelled ? (g.cancellationType || "Cancelled") + " · " : ""}${esc(teams)} · ${esc(g.field||"")}">
        <div style="color:var(--light-text)">${cancelIcon ? cancelIcon + " " : ""}${g.time ? fmt12(g.time).replace(":00","") : ""} ${esc(g.division||"")}</div>
        <div style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(teams)}</div>
      </div>`;
    });
    if (items.games.length > gamesToShow.length) {
      const more = items.games.length - gamesToShow.length;
      html += `<div style="font-size:0.65rem;color:var(--light-text)">+${more} more game${more !== 1 ? "s" : ""}</div>`;
    }

    practicesToShow.forEach(p => {
      html += `<div class="cal-card practice"
        title="Practice: ${esc(p.teamName||"")} · ${esc(p.field||"")}">
        <div style="color:#8ab4f8">${p.startTime ? fmt12(p.startTime).replace(":00","") : "Practice"}</div>
        <div style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--light-text)">${esc(p.teamName||"Practice")}</div>
      </div>`;
    });
    if (items.practices.length > practicesToShow.length) {
      const more = items.practices.length - practicesToShow.length;
      html += `<div style="font-size:0.65rem;color:#8ab4f8">+${more} practice${more !== 1 ? "s" : ""}</div>`;
    }

    html += `</div>`;
    cur.setDate(cur.getDate() + 1);
  }
  html += `</div>`;
  el.innerHTML = html;
}

// ── Month navigation ──────────────────────────────────────────────────────────

document.getElementById("prevMonthBtn").addEventListener("click", () => {
  month--;
  if (month < 1) { month = 12; year--; }
  loadSchedule();
});
document.getElementById("nextMonthBtn").addEventListener("click", () => {
  month++;
  if (month > 12) { month = 1; year++; }
  loadSchedule();
});
document.getElementById("todayBtn").addEventListener("click", () => {
  const n = new Date();
  year = n.getFullYear(); month = n.getMonth() + 1;
  loadSchedule();
});

// ── View toggle ───────────────────────────────────────────────────────────────

document.querySelectorAll(".cal-view-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    calView = btn.dataset.view;
    document.querySelectorAll(".cal-view-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.view === calView);
    });
    document.getElementById("fsMonthView").style.display = calView === "month" ? "" : "none";
    document.getElementById("fsListView").style.display  = calView === "list"  ? "" : "none";
    render();
  });
});

// ── Filters ───────────────────────────────────────────────────────────────────

function reRender() { render(); }

document.getElementById("fsFilterField").addEventListener("change", e => { filterField = e.target.value; reRender(); });
document.getElementById("fsFilterType").addEventListener("change",  e => { filterType  = e.target.value; reRender(); });
document.getElementById("fsFilterDiv").addEventListener("change",   e => { filterDiv   = e.target.value; reRender(); });
document.getElementById("fsClearFiltersBtn").addEventListener("click", () => {
  filterField = filterType = filterDiv = "";
  document.getElementById("fsFilterField").value = "";
  document.getElementById("fsFilterType").value  = "";
  document.getElementById("fsFilterDiv").value   = "";
  reRender();
});

// ── Init ──────────────────────────────────────────────────────────────────────

loadSchedule();
