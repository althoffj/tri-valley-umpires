// admin-analytics.js — Season Analytics
import { db }                        from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import { esc } from "./utils.js";

import { collection, getDocs, query, orderBy }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let allGames   = [];
let allUmpires = {};
let yearFilter = String(new Date().getFullYear()); // default to current year

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  await authReadyPromise;
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display = "block";
    return;
  }
  document.getElementById("adminContent").style.display = "block";

  const [gamesSnap, umpiresSnap] = await Promise.all([
    getDocs(query(collection(db, "games"), orderBy("date", "asc"))),
    getDocs(collection(db, "umpires"))
  ]);

  allGames = gamesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  umpiresSnap.docs.forEach(d => { allUmpires[d.id] = d.data(); });

  // Populate year selector from data
  const years = [...new Set(
    allGames
      .filter(g => g.date)
      .map(g => g.date.slice(0, 4))
  )].sort((a, b) => b.localeCompare(a));

  const sel = document.getElementById("analyticsYear");
  years.forEach(y => {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    if (y === yearFilter) opt.selected = true;
    sel.insertBefore(opt, sel.querySelector("option[value='all']"));
  });
  // If current year isn't in the data yet, fall back to All Time
  if (!years.includes(yearFilter)) {
    yearFilter = "all";
    sel.value = "all";
  }

  sel.addEventListener("change", () => {
    yearFilter = sel.value;
    render();
  });

  render();
}

// ── Filtered games ─────────────────────────────────────────────────────────

function filteredGames() {
  return allGames.filter(g => {
    // Exclude hard-cancelled games (not rainouts/reschedules — those may have umpires)
    if (g.cancelled && g.cancellationType !== "rainout" && g.cancellationType !== "rescheduled") return false;
    if (yearFilter !== "all" && (!g.date || !g.date.startsWith(yearFilter))) return false;
    return true;
  });
}

// ── Render all sections ────────────────────────────────────────────────────

function render() {
  const games = filteredGames();
  const label = yearFilter === "all" ? "all time" : yearFilter;
  const note  = document.getElementById("analyticsNote");
  const activeGames = games.filter(g => !g.cancelled);
  note.textContent = `${activeGames.length} active game${activeGames.length !== 1 ? "s" : ""} · ${Object.keys(allUmpires).length} umpires · ${label}`;

  renderStatCards(games);
  renderLeaderboard(games);
  renderWeeklyChart(games);
}

// ── Stat cards ─────────────────────────────────────────────────────────────

function renderStatCards(games) {
  let totalSlots = 0, filledSlots = 0, openSlots = 0;
  let totalEarned = 0, totalPaid = 0;
  const umpireSet = new Set();

  games.forEach(g => {
    (g.umpireSlots || []).forEach(s => {
      totalSlots++;
      if (s.assignedUid) {
        filledSlots++;
        umpireSet.add(s.assignedUid);
        const pay = Number(s.payRate ?? g.payRate ?? 0);
        totalEarned += pay;
        if (s.paid) totalPaid += pay;
      } else if (!g.cancelled) {
        openSlots++;
      }
    });
  });

  const fillRate    = totalSlots ? Math.round((filledSlots / totalSlots) * 100) : 0;
  const outstanding = totalEarned - totalPaid;

  const cards = [
    { label: "Active Games",    value: games.filter(g => !g.cancelled).length },
    { label: "Slots Filled",    value: `${filledSlots} / ${totalSlots}` },
    { label: "Fill Rate",       value: `${fillRate}%`,
      style: fillRate < 80 ? "color:#f0a500" : fillRate === 100 ? "color:#b8f2c4" : "" },
    { label: "Open Slots",      value: openSlots,
      style: openSlots > 0 ? "color:#f0a500" : "color:#b8f2c4" },
    { label: "Active Umpires",  value: umpireSet.size },
    { label: "Total Earned",    value: `$${totalEarned.toFixed(2)}` },
    { label: "Total Paid",      value: `$${totalPaid.toFixed(2)}` },
    { label: "Outstanding",     value: `$${outstanding.toFixed(2)}`,
      style: outstanding > 0 ? "color:#f0a500" : "" },
  ];

  document.getElementById("statCards").innerHTML = cards.map(c =>
    `<div class="analytics-card">
      <div class="analytics-card-value" style="${c.style || ""}">${c.value}</div>
      <div class="analytics-card-label">${c.label}</div>
    </div>`
  ).join("");
}

// ── Umpire leaderboard ─────────────────────────────────────────────────────

function renderLeaderboard(games) {
  const stats = {};

  games.forEach(g => {
    (g.umpireSlots || []).forEach(s => {
      if (!s.assignedUid) return;
      if (!stats[s.assignedUid]) {
        stats[s.assignedUid] = { name: s.assignedName || "Unknown", games: 0, plate: 0, field: 0, extra: 0, earned: 0, paid: 0 };
      }
      const st  = stats[s.assignedUid];
      const pay = Number(s.payRate ?? g.payRate ?? 0);
      st.games++;
      const type = (s.type || "").toLowerCase();
      if (type === "plate")      st.plate++;
      else if (type === "field") st.field++;
      else                       st.extra++;
      st.earned += pay;
      if (s.paid) st.paid += pay;
    });
  });

  const rows = Object.entries(stats)
    .sort((a, b) => b[1].games - a[1].games)
    .map(([, s]) => {
      const outstanding = s.earned - s.paid;
      return `<tr>
        <td>${esc(s.name)}</td>
        <td>${s.games}</td>
        <td>${s.plate}</td>
        <td>${s.field}</td>
        <td>${s.extra}</td>
        <td>$${s.earned.toFixed(2)}</td>
        <td>$${s.paid.toFixed(2)}</td>
        <td style="color:${outstanding > 0 ? "#f0a500" : "var(--light-text)"}">$${outstanding.toFixed(2)}</td>
      </tr>`;
    });

  const tbody = document.getElementById("leaderboardBody");
  tbody.innerHTML = rows.length
    ? rows.join("")
    : `<tr><td colspan="8" style="color:var(--light-text);text-align:center">No games with assigned umpires yet.</td></tr>`;
}

// ── Weekly bar chart ───────────────────────────────────────────────────────

function renderWeeklyChart(games) {
  const weeks = {};
  games.forEach(g => {
    if (!g.date) return;
    const d      = new Date(g.date + "T12:00:00");
    const monday = getMondayISO(d);
    weeks[monday] = (weeks[monday] || 0) + 1;
  });

  const sorted = Object.entries(weeks).sort((a, b) => a[0].localeCompare(b[0]));
  if (!sorted.length) {
    document.getElementById("weeklyChart").innerHTML = `<p style="color:var(--light-text)">No game data for this period.</p>`;
    return;
  }

  const max  = Math.max(...sorted.map(([, n]) => n));
  const bars = sorted.map(([monday, count]) => {
    const pct   = max ? Math.round((count / max) * 100) : 0;
    const label = fmtWeek(monday);
    return `<div class="bar-group">
      <div class="bar-wrap">
        <div class="bar" style="height:${pct}%" title="${count} games"></div>
      </div>
      <div class="bar-count">${count}</div>
      <div class="bar-label">${label}</div>
    </div>`;
  }).join("");

  document.getElementById("weeklyChart").innerHTML = `<div class="bar-chart-inner">${bars}</div>`;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getMondayISO(d) {
  const copy = new Date(d);
  const day  = copy.getDay();
  copy.setDate(copy.getDate() + (day === 0 ? -6 : 1 - day));
  return copy.toISOString().slice(0, 10);
}

function fmtWeek(iso) {
  const [, m, day] = iso.split("-");
  return `${parseInt(m)}/${parseInt(day)}`;
}

init();
