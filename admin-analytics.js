import { db }        from "./firebase.js";
import { isAdmin }   from "./auth.js";
import { collection, getDocs, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

async function init() {
  const ok = await isAdmin();
  if (!ok) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display = "block";
    return;
  }
  document.getElementById("adminContent").style.display = "block";

  const [gamesSnap, umpiresSnap] = await Promise.all([
    getDocs(query(collection(db, "games"), orderBy("date", "asc"))),
    getDocs(collection(db, "umpires"))
  ]);

  const games   = gamesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const umpires = {};
  umpiresSnap.docs.forEach(d => { umpires[d.id] = d.data(); });

  const note = document.getElementById("analyticsNote");
  const activeGames = games.filter(g => !g.cancelled && g.needsUmpires);
  note.textContent = `${activeGames.length} active game${activeGames.length !== 1 ? "s" : ""} · ${Object.keys(umpires).length} umpires`;

  renderStatCards(activeGames);
  renderLeaderboard(activeGames, umpires);
  renderWeeklyChart(activeGames);
}

/* ── Stat cards ─────────────────────────────────────────────────── */
function renderStatCards(games) {
  let totalSlots = 0, filledSlots = 0, totalEarned = 0, totalPaid = 0;
  const umpireSet = new Set();

  games.forEach(g => {
    (g.umpireSlots || []).forEach(s => {
      totalSlots++;
      if (s.assignedUid) {
        filledSlots++;
        umpireSet.add(s.assignedUid);
        const pay = s.payRate ?? g.payRate ?? 0;
        totalEarned += pay;
        if (s.paid) totalPaid += pay;
      }
    });
  });

  const fillRate = totalSlots ? Math.round((filledSlots / totalSlots) * 100) : 0;
  const outstanding = totalEarned - totalPaid;

  const cards = [
    { label: "Total Games",       value: games.length },
    { label: "Slots Filled",      value: `${filledSlots} / ${totalSlots}` },
    { label: "Fill Rate",         value: `${fillRate}%` },
    { label: "Active Umpires",    value: umpireSet.size },
    { label: "Total Earned",      value: `$${totalEarned.toFixed(2)}` },
    { label: "Total Paid",        value: `$${totalPaid.toFixed(2)}` },
    { label: "Outstanding",       value: `$${outstanding.toFixed(2)}` },
  ];

  document.getElementById("statCards").innerHTML = cards
    .map(c => `<div class="analytics-card"><div class="analytics-card-value">${c.value}</div><div class="analytics-card-label">${c.label}</div></div>`)
    .join("");
}

/* ── Umpire leaderboard ─────────────────────────────────────────── */
function renderLeaderboard(games, umpires) {
  const stats = {};

  games.forEach(g => {
    (g.umpireSlots || []).forEach(s => {
      if (!s.assignedUid) return;
      if (!stats[s.assignedUid]) {
        stats[s.assignedUid] = { name: s.assignedName || "Unknown", games: 0, plate: 0, field: 0, extra: 0, earned: 0, paid: 0 };
      }
      const st = stats[s.assignedUid];
      const pay = s.payRate ?? g.payRate ?? 0;
      st.games++;
      const type = (s.type || "").toLowerCase();
      if (type === "plate")  st.plate++;
      else if (type === "field") st.field++;
      else st.extra++;
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

/* ── Weekly bar chart ───────────────────────────────────────────── */
function renderWeeklyChart(games) {
  const weeks = {};
  games.forEach(g => {
    if (!g.date) return;
    const d = new Date(g.date + "T12:00:00");
    const monday = getMondayISO(d);
    weeks[monday] = (weeks[monday] || 0) + 1;
  });

  const sorted = Object.entries(weeks).sort((a, b) => a[0].localeCompare(b[0]));
  if (!sorted.length) {
    document.getElementById("weeklyChart").innerHTML = `<p style="color:var(--light-text)">No game data yet.</p>`;
    return;
  }

  const max = Math.max(...sorted.map(([, n]) => n));

  const bars = sorted.map(([monday, count]) => {
    const pct = max ? Math.round((count / max) * 100) : 0;
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

/* ── Helpers ────────────────────────────────────────────────────── */
function getMondayISO(d) {
  const copy = new Date(d);
  const day = copy.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  copy.setDate(copy.getDate() + diff);
  return copy.toISOString().slice(0, 10);
}

function fmtWeek(iso) {
  const [, m, day] = iso.split("-");
  return `${parseInt(m)}/${parseInt(day)}`;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

init();
