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
  renderDivisionBreakdown(games);
  renderYoY();
  renderWeeklyChart(games);
}

// ── Stat cards ─────────────────────────────────────────────────────────────

function renderStatCards(games) {
  let totalSlots = 0, filledSlots = 0, openSlots = 0;
  let totalEarned = 0, totalPaid = 0;
  let totalNoShows = 0, totalCheckedIn = 0, totalBillable = 0;
  const umpireSet = new Set();

  games.forEach(g => {
    const isRainout = g.cancelled && g.cancellationType === "rainout";
    (g.umpireSlots || []).forEach(s => {
      totalSlots++;
      if (s.assignedUid) {
        filledSlots++;
        umpireSet.add(s.assignedUid);
        if (s.noShow) {
          totalNoShows++;
        } else {
          totalBillable++;
          if (s.checkedIn) totalCheckedIn++;
          // Only count pay for non-rainout, non-no-show slots (matches payroll page)
          if (!isRainout) {
            const pay = Number(s.payRate ?? g.payRate ?? 0);
            totalEarned += pay;
            if (s.paid) totalPaid += pay;
          }
        }
      } else if (!g.cancelled) {
        openSlots++;
      }
    });
  });

  const fillRate     = totalSlots ? Math.round((filledSlots / totalSlots) * 100) : 0;
  const checkInRate  = totalBillable ? Math.round((totalCheckedIn / totalBillable) * 100) : 0;
  const outstanding  = totalEarned - totalPaid;
  const cancelled    = games.filter(g => g.cancelled);
  const rainouts     = cancelled.filter(g => g.cancellationType === "rainout").length;
  const hardCancel   = cancelled.filter(g => g.cancellationType !== "rainout" && g.cancellationType !== "rescheduled").length;

  const cards = [
    { label: "Active Games",    value: games.filter(g => !g.cancelled).length },
    { label: "Slots Filled",    value: `${filledSlots} / ${totalSlots}` },
    { label: "Fill Rate",       value: `${fillRate}%`,
      style: fillRate < 80 ? "color:#f0a500" : fillRate === 100 ? "color:#b8f2c4" : "" },
    { label: "Open Slots",      value: openSlots,
      style: openSlots > 0 ? "color:#f0a500" : "color:#b8f2c4" },
    { label: "No Shows",        value: totalNoShows,
      style: totalNoShows > 0 ? "color:#f87171" : "color:#b8f2c4" },
    { label: "Check-In Rate",   value: totalBillable ? `${checkInRate}%` : "—",
      style: checkInRate < 70 ? "color:#f0a500" : checkInRate === 100 ? "color:#b8f2c4" : "" },
    { label: "Active Umpires",  value: umpireSet.size },
    { label: "Total Earned",    value: `$${totalEarned.toFixed(2)}` },
    { label: "Total Paid",      value: `$${totalPaid.toFixed(2)}` },
    { label: "Outstanding",     value: `$${outstanding.toFixed(2)}`,
      style: outstanding > 0 ? "color:#f0a500" : "" },
    { label: "Rainouts",        value: rainouts,
      style: rainouts > 0 ? "color:#60a5fa" : "" },
    { label: "Cancelled",       value: hardCancel,
      style: hardCancel > 0 ? "color:#f87171" : "" },
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
    const isRainout = g.cancelled && g.cancellationType === "rainout";
    (g.umpireSlots || []).forEach(s => {
      if (!s.assignedUid) return;
      if (!stats[s.assignedUid]) {
        stats[s.assignedUid] = {
          name: s.assignedName || "Unknown",
          games: 0, plate: 0, field: 0, extra: 0,
          noShows: 0, checkedIn: 0,
          earned: 0, paid: 0,
        };
      }
      const st   = stats[s.assignedUid];
      const type = (s.type || "").toLowerCase();

      if (s.noShow) {
        st.noShows++;
        return; // no-shows don't count toward games or pay
      }

      st.games++;
      if (type === "plate")      st.plate++;
      else if (type === "field") st.field++;
      else                       st.extra++;

      if (s.checkedIn) st.checkedIn++;

      // Pay only for non-rainout games (matches payroll page)
      if (!isRainout) {
        const pay = Number(s.payRate ?? g.payRate ?? 0);
        st.earned += pay;
        if (s.paid) st.paid += pay;
      }
    });
  });

  // Update header
  const thead = document.querySelector("#leaderboardTable thead tr");
  if (thead) {
    thead.innerHTML = `
      <th>Umpire</th>
      <th>Games</th>
      <th>Plate</th>
      <th>Field</th>
      <th>Extra</th>
      <th>No Shows</th>
      <th>Check-In %</th>
      <th>Earned</th>
      <th>Paid</th>
      <th>Outstanding</th>`;
  }

  const rows = Object.entries(stats)
    .sort((a, b) => b[1].games - a[1].games)
    .map(([, s]) => {
      const outstanding  = s.earned - s.paid;
      const checkInRate  = s.games ? Math.round((s.checkedIn / s.games) * 100) : 0;
      const ciColor      = checkInRate < 70 ? "#f0a500" : checkInRate === 100 ? "#b8f2c4" : "var(--text)";
      const nsColor      = s.noShows > 0 ? "#f87171" : "var(--light-text)";
      return `<tr>
        <td>${esc(s.name)}</td>
        <td>${s.games}</td>
        <td>${s.plate}</td>
        <td>${s.field}</td>
        <td>${s.extra || "—"}</td>
        <td style="color:${nsColor}">${s.noShows || "—"}</td>
        <td style="color:${ciColor}">${s.games ? checkInRate + "%" : "—"}</td>
        <td>$${s.earned.toFixed(2)}</td>
        <td>$${s.paid.toFixed(2)}</td>
        <td style="color:${outstanding > 0 ? "#f0a500" : "var(--light-text)"}">$${outstanding.toFixed(2)}</td>
      </tr>`;
    });

  const tbody = document.getElementById("leaderboardBody");
  tbody.innerHTML = rows.length
    ? rows.join("")
    : `<tr><td colspan="10" style="color:var(--light-text);text-align:center">No games with assigned umpires yet.</td></tr>`;
}

// ── Division breakdown ─────────────────────────────────────────────────────

function renderDivisionBreakdown(games) {
  const tbody = document.getElementById("divisionBody");
  if (!tbody) return;

  const divStats = {};
  const DIV_ORDER = ["T-ball", "6U", "8U", "10U", "12U", "14U", "HS JV", "HS Varsity"];

  games.forEach(g => {
    const div = g.division || "Unknown";
    if (!divStats[div]) divStats[div] = { games: 0, slots: 0, filled: 0, open: 0, cancelled: 0, earned: 0 };
    const s = divStats[div];
    if (g.cancelled && g.cancellationType !== "rainout" && g.cancellationType !== "rescheduled") {
      s.cancelled++;
      return;
    }
    s.games++;
    (g.umpireSlots || []).forEach(slot => {
      s.slots++;
      if (slot.assignedUid) {
        s.filled++;
        s.earned += Number(slot.payRate ?? 0);
      } else {
        s.open++;
      }
    });
  });

  const divs = Object.keys(divStats).sort((a, b) => {
    const ai = DIV_ORDER.indexOf(a);
    const bi = DIV_ORDER.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });

  if (!divs.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:var(--light-text);text-align:center">No data.</td></tr>`;
    return;
  }

  tbody.innerHTML = divs.map(div => {
    const s       = divStats[div];
    const fillPct = s.slots ? Math.round((s.filled / s.slots) * 100) : 0;
    const fillColor = fillPct < 80 ? "#f0a500" : fillPct === 100 ? "#b8f2c4" : "";
    return `<tr>
      <td><strong>${esc(div)}</strong></td>
      <td>${s.games}</td>
      <td>${s.slots}</td>
      <td>${s.filled}</td>
      <td style="color:${fillColor}">${s.slots ? fillPct + "%" : "—"}</td>
      <td style="color:${s.open > 0 ? "#f0a500" : ""}">${s.open}</td>
      <td style="color:${s.cancelled > 0 ? "#f87171" : "var(--light-text)"}">${s.cancelled}</td>
      <td>$${s.earned.toFixed(2)}</td>
    </tr>`;
  }).join("");
}

// ── Year-over-year comparison ──────────────────────────────────────────────

function calcYearStats(year) {
  const games = allGames.filter(g => {
    if (!g.date || !g.date.startsWith(year)) return false;
    if (g.cancelled && g.cancellationType !== "rainout" && g.cancellationType !== "rescheduled") return false;
    return true;
  });
  let slots = 0, filled = 0, earned = 0, paid = 0, noShows = 0, checkedIn = 0, billable = 0;
  const umpires = new Set();
  games.forEach(g => {
    const isRainout = g.cancelled && g.cancellationType === "rainout";
    (g.umpireSlots || []).forEach(s => {
      slots++;
      if (s.assignedUid) {
        filled++;
        umpires.add(s.assignedUid);
        if (s.noShow) {
          noShows++;
        } else {
          billable++;
          if (s.checkedIn) checkedIn++;
          if (!isRainout) {
            const pay = Number(s.payRate ?? 0);
            earned += pay;
            if (s.paid) paid += pay;
          }
        }
      }
    });
  });
  return {
    games:       games.filter(g => !g.cancelled).length,
    fillRate:    slots ? Math.round((filled / slots) * 100) : 0,
    open:        slots - filled,
    outstanding: earned - paid,
    umpires:     umpires.size,
    earned,
    noShows,
    checkInRate: billable ? Math.round((checkedIn / billable) * 100) : 0,
  };
}

function delta(curr, prev, lowerIsBetter = false) {
  if (prev === 0) return "";
  const diff = curr - prev;
  if (diff === 0) return `<span style="color:var(--light-text);font-size:0.75rem"> →</span>`;
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  const sign = diff > 0 ? "+" : "";
  return `<span style="color:${good ? "#b8f2c4" : "#f0a500"};font-size:0.75rem"> ${sign}${diff}</span>`;
}

function deltaFmt(curr, prev, format = v => v, lowerIsBetter = false) {
  const diff = curr - prev;
  if (diff === 0) return `<span style="color:var(--light-text);font-size:0.75rem"> →</span>`;
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  const sign = diff > 0 ? "+" : "";
  return `<span style="color:${good ? "#b8f2c4" : "#f0a500"};font-size:0.75rem"> ${sign}${format(diff)}</span>`;
}

function renderYoY() {
  const cardsEl = document.getElementById("yoyCards");
  const noteEl  = document.getElementById("yoyNote");
  if (!cardsEl) return;

  if (yearFilter === "all") {
    cardsEl.innerHTML = "";
    if (noteEl) noteEl.textContent = "Select a specific year to see year-over-year comparison.";
    return;
  }

  const currYear = String(yearFilter);
  const prevYear = String(Number(currYear) - 1);
  const curr = calcYearStats(currYear);
  const prev = calcYearStats(prevYear);
  const hasPrev = allGames.some(g => (g.date || "").startsWith(prevYear));

  if (!hasPrev) {
    cardsEl.innerHTML = "";
    if (noteEl) noteEl.textContent = `No ${prevYear} data available for comparison.`;
    return;
  }

  if (noteEl) noteEl.textContent = `${currYear} vs ${prevYear}`;

  const metrics = [
    { label: "Games",         curr: curr.games,        prev: prev.games,        fmt: v => v,                             lower: false },
    { label: "Fill Rate",     curr: curr.fillRate,     prev: prev.fillRate,     fmt: v => `${Math.abs(v)}%`,             lower: false },
    { label: "Open Slots",    curr: curr.open,         prev: prev.open,         fmt: v => v,                             lower: true  },
    { label: "No Shows",      curr: curr.noShows,      prev: prev.noShows,      fmt: v => v,                             lower: true  },
    { label: "Check-In Rate", curr: curr.checkInRate,  prev: prev.checkInRate,  fmt: v => `${Math.abs(v)}%`,             lower: false },
    { label: "Outstanding",   curr: curr.outstanding,  prev: prev.outstanding,  fmt: v => `$${Math.abs(v).toFixed(0)}`,  lower: true  },
    { label: "Umpires",       curr: curr.umpires,      prev: prev.umpires,      fmt: v => v,                             lower: false },
    { label: "Earned",        curr: curr.earned,       prev: prev.earned,       fmt: v => `$${Math.abs(v).toFixed(0)}`,  lower: false },
  ];

  cardsEl.innerHTML = metrics.map(m => {
    const dStr    = deltaFmt(m.curr, m.prev, m.fmt, m.lower);
    const fmtVal  = v => (m.label === "Fill Rate") ? `${v}%`
                       : (m.label === "Outstanding" || m.label === "Earned") ? `$${v.toFixed(2)}`
                       : v;
    return `<div class="analytics-card">
      <div class="analytics-card-value">${fmtVal(m.curr)}${dStr}</div>
      <div class="analytics-card-label">${m.label}
        <span style="color:var(--light-text);font-size:0.7rem">(${prevYear}: ${fmtVal(m.prev)})</span>
      </div>
    </div>`;
  }).join("");
}

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
  return `${copy.getFullYear()}-${String(copy.getMonth() + 1).padStart(2, "0")}-${String(copy.getDate()).padStart(2, "0")}`;
}

function fmtWeek(iso) {
  const [, m, day] = iso.split("-");
  return `${parseInt(m)}/${parseInt(day)}`;
}

init();
