// calendar.js — month/week/day calendar views backed by Firestore games
import { db, auth } from "./firebase.js";
import { isApproved, getCurrentUser } from "./auth.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  collection, getDocs, query, orderBy, where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── State ─────────────────────────────────────────────────────────────────────
let allGames  = [];   // all fetched game docs
let view      = "month";
let cursor    = new Date(); // anchor date for current view
cursor.setHours(0,0,0,0);
let currentUid = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayISO() {
  const d = new Date();
  return isoOf(d);
}

function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
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

function gamesOnDate(iso) {
  return allGames.filter(g => g.date === iso);
}

function isMyGame(g) {
  return currentUid && (g.umpireSlots ?? []).some(s => s.assignedUid === currentUid);
}

// ── Game card (shared across views) ──────────────────────────────────────────

function gameCard(g, compact = false) {
  const mine = isMyGame(g);
  const slots = (g.umpireSlots ?? []).map(s =>
    `<span class="badge badge-${s.type.toLowerCase()}">${s.type}</span>`
  ).join(" ");
  const teams = [g.homeTeam, g.awayTeam].filter(Boolean).join(" vs ");
  const border = mine ? "#b8f2c4" : "var(--accent)";

  if (compact) {
    return `<div class="cal-card${mine ? " cal-card-mine" : ""}" style="border-left-color:${border}">
      <span style="font-size:0.75rem;color:var(--light-text)">${fmtTime(g.time)}</span>
      <span style="font-weight:bold;font-size:0.8rem;color:white"> ${esc(g.city ?? "")} ${esc(g.division ?? "")}</span>
    </div>`;
  }

  return `<div class="cal-card${mine ? " cal-card-mine" : ""}" style="border-left-color:${border};margin-bottom:10px">
    <div style="font-size:0.82rem;color:var(--light-text)">${fmtTime(g.time)}${g.field ? " · " + esc(g.field) : ""}</div>
    <div style="font-weight:bold;color:white">${esc(g.city ?? "")} <span style="color:var(--light-text)">${esc(g.division ?? "")}</span></div>
    ${teams ? `<div style="font-size:0.85rem;color:var(--light-text)">${esc(teams)}</div>` : ""}
    <div style="margin-top:4px">${slots || '<span style="font-size:0.78rem;color:#ffcc80">Open</span>'}</div>
    ${mine ? `<div style="font-size:0.78rem;color:#b8f2c4">Your game</div>` : ""}
    <a href="schedule.html" style="font-size:0.78rem">Sign up / details &rarr;</a>
  </div>`;
}

// ── Month view ────────────────────────────────────────────────────────────────

function renderMonth() {
  const year  = cursor.getFullYear();
  const month = cursor.getMonth();
  const today = todayISO();

  const label = cursor.toLocaleDateString("en-US", { month:"long", year:"numeric" });
  document.getElementById("calLabel").textContent = label;

  const firstDay  = new Date(year, month, 1);
  const lastDay   = new Date(year, month+1, 0);
  const startDOW  = firstDay.getDay(); // 0=Sun
  const totalDays = lastDay.getDate();

  let html = `<div class="cal-month-grid">
    <div class="cal-dow-header">Sun</div>
    <div class="cal-dow-header">Mon</div>
    <div class="cal-dow-header">Tue</div>
    <div class="cal-dow-header">Wed</div>
    <div class="cal-dow-header">Thu</div>
    <div class="cal-dow-header">Fri</div>
    <div class="cal-dow-header">Sat</div>`;

  // Leading blank cells
  for (let i = 0; i < startDOW; i++) html += `<div class="cal-month-cell cal-other-month"></div>`;

  for (let d = 1; d <= totalDays; d++) {
    const iso    = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const games  = gamesOnDate(iso);
    const isToday = iso === today;
    const hasMyGame = games.some(isMyGame);

    html += `<div class="cal-month-cell${isToday ? " cal-today" : ""}" data-date="${iso}" style="cursor:${games.length ? "pointer" : "default"}">
      <div class="cal-day-num${isToday ? " cal-today-num" : ""}">${d}</div>
      ${games.slice(0, 3).map(g => gameCard(g, true)).join("")}
      ${games.length > 3 ? `<div style="font-size:0.72rem;color:var(--light-text)">+${games.length-3} more</div>` : ""}
    </div>`;
  }

  // Trailing blank cells to complete grid
  const trailing = (7 - ((startDOW + totalDays) % 7)) % 7;
  for (let i = 0; i < trailing; i++) html += `<div class="cal-month-cell cal-other-month"></div>`;

  html += `</div>`;
  document.getElementById("calView").innerHTML = html;

  // Click a day → switch to day view
  document.querySelectorAll(".cal-month-cell[data-date]").forEach(cell => {
    cell.addEventListener("click", () => {
      const [y,m,d] = cell.dataset.date.split("-").map(Number);
      cursor = new Date(y, m-1, d);
      setView("day");
    });
  });
}

// ── Week view ─────────────────────────────────────────────────────────────────

function renderWeek() {
  const today = todayISO();
  // Start of week (Sunday)
  const sun = new Date(cursor);
  sun.setDate(cursor.getDate() - cursor.getDay());

  const days = Array.from({length:7}, (_,i) => {
    const d = new Date(sun);
    d.setDate(sun.getDate() + i);
    return d;
  });

  const start = days[0].toLocaleDateString("en-US", {month:"short", day:"numeric"});
  const end   = days[6].toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"});
  document.getElementById("calLabel").textContent = `${start} – ${end}`;

  const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

  let html = `<div class="cal-week-grid">`;
  days.forEach(d => {
    const iso    = isoOf(d);
    const games  = gamesOnDate(iso);
    const isToday = iso === today;
    html += `<div class="cal-week-col${isToday ? " cal-today-col" : ""}">
      <div class="cal-week-header">${dayNames[d.getDay()]} <span class="${isToday ? "cal-today-num" : ""}">${d.getDate()}</span></div>
      <div class="cal-week-body">
        ${games.length ? games.map(g => gameCard(g, false)).join("") : `<span style="color:var(--light-text);font-size:0.8rem">No games</span>`}
      </div>
    </div>`;
  });
  html += `</div>`;
  document.getElementById("calView").innerHTML = html;
}

// ── Day view ──────────────────────────────────────────────────────────────────

function renderDay() {
  const iso   = isoOf(cursor);
  const today = todayISO();
  const label = cursor.toLocaleDateString("en-US", {weekday:"long", month:"long", day:"numeric", year:"numeric"});
  document.getElementById("calLabel").textContent = label;

  const games = gamesOnDate(iso);
  let html;
  if (!games.length) {
    html = `<div class="document-note"><p>No games scheduled for this day.</p></div>`;
  } else {
    html = `<div style="max-width:600px">${games.map(g => gameCard(g, false)).join("")}</div>`;
  }
  document.getElementById("calView").innerHTML = html;
}

// ── Navigation ────────────────────────────────────────────────────────────────

function setView(v) {
  view = v;
  document.querySelectorAll(".cal-tab-btn").forEach(b => {
    b.classList.toggle("filter-active", b.dataset.view === v);
    b.classList.toggle("print-btn",     b.dataset.view !== v);
  });
  render();
}

function navigate(dir) {
  if (view === "month") {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
  } else if (view === "week") {
    cursor.setDate(cursor.getDate() + dir * 7);
  } else {
    cursor.setDate(cursor.getDate() + dir);
  }
  render();
}

function render() {
  if (view === "month")      renderMonth();
  else if (view === "week")  renderWeek();
  else                       renderDay();
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function loadGames() {
  try {
    const snap = await getDocs(
      query(collection(db, "games"), orderBy("date"), orderBy("time"))
    );
    allGames = [];
    snap.forEach(d => allGames.push({ id: d.id, ...d.data() }));
    render();
  } catch (err) {
    console.error(err);
    document.getElementById("calView").innerHTML =
      `<div class="document-note"><p style="color:#ffb4b4">Error loading games.</p></div>`;
  }
}

document.getElementById("calPrev").addEventListener("click",  () => navigate(-1));
document.getElementById("calNext").addEventListener("click",  () => navigate(1));
document.getElementById("calToday").addEventListener("click", () => {
  cursor = new Date(); cursor.setHours(0,0,0,0); render();
});
document.querySelectorAll(".cal-tab-btn").forEach(b =>
  b.addEventListener("click", () => setView(b.dataset.view))
);

onAuthStateChanged(auth, user => {
  currentUid = user?.uid ?? null;
  render(); // re-render with my-game highlighting
});

loadGames();
