// earnings.js — Umpire's own earnings history
import { db }                           from "./firebase.js";
import { authReadyPromise, isApproved, getCurrentUser } from "./auth.js";
import {
  collection, getDocs, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let allRows    = [];   // all assigned, non-cancelled slots
let fromFilter = "";
let toFilter   = "";

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return "—";
  return iso.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1");
}

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function thisYearRange() {
  const y = new Date().getFullYear();
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

function lastYearRange() {
  const y = new Date().getFullYear() - 1;
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

// ── Load ───────────────────────────────────────────────────────────────────

async function loadEarnings() {
  const tbody = document.getElementById("earningsBody");
  if (!tbody) return;

  const uid = getCurrentUser()?.uid;
  if (!uid) return;

  try {
    const snap = await getDocs(
      query(collection(db, "games"), orderBy("date", "asc"))
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

    // Default to current year on first load
    const { from, to } = thisYearRange();
    fromFilter = from;
    toFilter   = to;
    const fromEl = document.getElementById("earningsFrom");
    const toEl   = document.getElementById("earningsTo");
    if (fromEl) fromEl.value = from;
    if (toEl)   toEl.value   = to;

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
  fromFilter = from;
  toFilter   = to;
  const fromEl = document.getElementById("earningsFrom");
  const toEl   = document.getElementById("earningsTo");
  if (fromEl) fromEl.value = from;
  if (toEl)   toEl.value   = to;
  renderEarnings();
}

function wireControls() {
  document.getElementById("earningsFilterBtn")?.addEventListener("click", () => {
    fromFilter = document.getElementById("earningsFrom").value;
    toFilter   = document.getElementById("earningsTo").value;
    renderEarnings();
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
        applyYearRange("", "");
        const fromEl = document.getElementById("earningsFrom");
        const toEl   = document.getElementById("earningsTo");
        if (fromEl) fromEl.value = "";
        if (toEl)   toEl.value   = "";
      }
    });
  });
}

// ── Init ───────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  if (!isApproved()) {
    document.getElementById("earningsContent").style.display = "none";
    document.getElementById("earningsGuest").style.display   = "";
    return;
  }
  document.getElementById("earningsContent").style.display = "";
  document.getElementById("earningsGuest").style.display   = "none";
  loadEarnings();
});
