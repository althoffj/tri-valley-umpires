// earnings.js — Umpire's own earnings history
import { db }                           from "./firebase.js";
import { authReadyPromise, isApproved, isCoach, getCurrentUser } from "./auth.js";
import { esc, fmtDate, fmtTime, setMsg, thisYearRange, lastYearRange } from "./utils.js";

import {
  collection, getDocs, query, orderBy, where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let allRows    = [];   // all assigned, non-cancelled slots
let fromFilter = "";
let toFilter   = "";

// ── Helpers ────────────────────────────────────────────────────────────────

// ── Load ───────────────────────────────────────────────────────────────────

async function loadEarnings(fromDate, toDate) {
  const tbody = document.getElementById("earningsBody");
  if (!tbody) return;

  const uid = getCurrentUser()?.uid;
  if (!uid) return;

  // Default to current year if no range given
  if (!fromDate || !toDate) {
    const yr = thisYearRange();
    fromDate = yr.from;
    toDate   = yr.to;
  }

  try {
    const snap = await getDocs(
      query(collection(db, "games"),
        where("date", ">=", fromDate),
        where("date", "<=", toDate),
        orderBy("date", "asc"))
    );

    allRows = [];
    snap.forEach(d => {
      const g = { id: d.id, ...d.data() };
      // Skip fully-cancelled games (rainout/rescheduled could be replayed — keep those)
      if (g.cancelled && g.cancellationType !== "rainout" && g.cancellationType !== "rescheduled") return;
      (g.umpireSlots ?? []).forEach(slot => {
        if (slot.assignedUid !== uid) return;
        allRows.push({
          date:       g.date     ?? "",
          city:       g.city     ?? "",
          division:   g.division ?? "",
          field:      g.field    ?? "",
          slotType:   slot.type  ?? "",
          pay:        Number(slot.payRate ?? g.payRate ?? 0),
          paid:       slot.paid === true,
          cancelled:  !!g.cancelled,
        });
      });
    });

    fromFilter = fromDate;
    toFilter   = toDate;
    const fromEl = document.getElementById("earningsFrom");
    const toEl   = document.getElementById("earningsTo");
    if (fromEl) fromEl.value = fromDate;
    if (toEl)   toEl.value   = toDate;

    renderEarnings();
    wireControls();
  } catch (err) {
    console.error(err);
    tbody.innerHTML = '<tr><td colspan="5" style="color:#ffb4b4">Error loading earnings.</td></tr>';
  }
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderEarnings() {
  const tbody    = document.getElementById("earningsBody");
  const cardsEl  = document.getElementById("earningsSummaryCards");
  if (!tbody) return;

  const rows = allRows.filter(r => {
    if (fromFilter && r.date < fromFilter) return false;
    if (toFilter   && r.date > toFilter)   return false;
    return true;
  });

  // Summary cards
  if (cardsEl) {
    const earned      = rows.reduce((s, r) => s + r.pay, 0);
    const paid        = rows.filter(r => r.paid).reduce((s, r) => s + r.pay, 0);
    const outstanding = earned - paid;
    const plate       = rows.filter(r => r.slotType === "Plate").length;
    const field       = rows.filter(r => r.slotType === "Field").length;

    const cards = [
      { label: "Games",       value: rows.length },
      { label: "Plate",       value: plate },
      { label: "Field",       value: field },
      { label: "Earned",      value: `$${earned.toFixed(2)}` },
      { label: "Paid",        value: `$${paid.toFixed(2)}` },
      { label: "Outstanding", value: `$${outstanding.toFixed(2)}`,
        style: outstanding > 0 ? "color:#f0a500" : "" },
    ];
    cardsEl.innerHTML = cards.map(c =>
      `<div class="analytics-card">
        <div class="analytics-card-value" style="${c.style || ""}">${c.value}</div>
        <div class="analytics-card-label">${c.label}</div>
      </div>`
    ).join("");
  }

  // Table rows
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--light-text);text-align:center">No games in this date range.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const cls = r.slotType === "Plate" ? "plate" : r.slotType === "Field" ? "field" : "extra";
    const paidBadge = r.paid
      ? `<span class="badge" style="background:#17351f;color:#b8f2c4">Paid</span>`
      : `<span class="badge" style="background:#4a2c00;color:#ffcc80">Pending</span>`;
    return `<tr>
      <td>${esc(fmtDate(r.date))}</td>
      <td>${esc(r.city)}<br><span style="color:var(--light-text);font-size:0.85rem">${esc(r.division)}</span></td>
      <td><span class="badge badge-${cls}">${esc(r.slotType)}</span></td>
      <td>$${r.pay.toFixed(2)}</td>
      <td>${paidBadge}</td>
    </tr>`;
  }).join("");
}

// ── CSV export ─────────────────────────────────────────────────────────────

function exportCSV() {
  const rows = allRows.filter(r => {
    if (fromFilter && r.date < fromFilter) return false;
    if (toFilter   && r.date > toFilter)   return false;
    return true;
  });
  if (!rows.length) return;

  const header = ["Date", "City", "Division", "Field", "Slot", "Pay", "Status"];
  const lines  = [
    header.join(","),
    ...rows.map(r => [
      r.date,
      `"${r.city.replace(/"/g, '""')}"`,
      r.division,
      `"${r.field.replace(/"/g, '""')}"`,
      r.slotType,
      r.pay.toFixed(2),
      r.paid ? "Paid" : "Pending",
    ].join(","))
  ];

  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  const fromLabel = fromFilter ? fromFilter.slice(0, 4) : "all";
  a.href     = url;
  a.download = `earnings-${fromLabel}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Controls ───────────────────────────────────────────────────────────────

function applyYearRange(from, to) {
  // Re-query Firestore with the new date range
  loadEarnings(from, to);
}

function wireControls() {
  document.getElementById("earningsFilterBtn")?.addEventListener("click", () => {
    const from = document.getElementById("earningsFrom").value;
    const to   = document.getElementById("earningsTo").value;
    loadEarnings(from || "2000-01-01", to || `${new Date().getFullYear()}-12-31`);
  });

  document.getElementById("earningsExportBtn")?.addEventListener("click", exportCSV);

  document.querySelectorAll(".earnings-year-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const which = btn.dataset.year;
      if (which === "current") {
        const r = thisYearRange();
        applyYearRange(r.from, r.to);
      } else if (which === "last") {
        const r = lastYearRange();
        applyYearRange(r.from, r.to);
      } else {
        loadEarnings("2000-01-01", `${new Date().getFullYear()}-12-31`);
      }
    });
  });
}

// ── Init ───────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  if (!isApproved()) {
    const guestEl = document.getElementById("earningsGuest");
    if (guestEl && isCoach()) {
      guestEl.innerHTML = `<div class="document-note">
        <p>Earnings tracking is for umpires only. Visit your <a href="coach-portal.html">Coach Portal</a> to manage your games.</p>
      </div>`;
    }
    document.getElementById("earningsContent").style.display = "none";
    document.getElementById("earningsGuest").style.display   = "";
    return;
  }
  document.getElementById("earningsContent").style.display = "";
  document.getElementById("earningsGuest").style.display   = "none";
  loadEarnings();
});
