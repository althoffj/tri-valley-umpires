// admin-payroll.js — Payroll summary with per-umpire grouping and mark-paid
import { db } from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import {
  collection, getDocs, getDoc, doc, updateDoc, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fmtDate(iso) {
  if (!iso) return "—";
  return iso.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1");
}
function fmtTime(t) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
function thisYearRange() {
  const y = new Date().getFullYear();
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}
function lastYearRange() {
  const y = new Date().getFullYear() - 1;
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

// ── State ─────────────────────────────────────────────────────────────────────

let payrollRows       = [];
let payRates          = { plate: 0, field: 0, extra: 0 };
let payrollFromFilter = "";
let payrollToFilter   = "";

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadPayroll() {
  const tbody = document.getElementById("payrollBody");
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="color:var(--light-text);text-align:center">Loading…</td></tr>';

  try {
    const [gamesSnap, ratesSnap] = await Promise.all([
      getDocs(query(collection(db, "games"), orderBy("date", "asc"))),
      getDoc(doc(db, "config", "payRates")),
    ]);

    if (ratesSnap.exists()) {
      const r = ratesSnap.data();
      payRates = { plate: Number(r.plate ?? 0), field: Number(r.field ?? 0), extra: Number(r.extra ?? 0) };
    }

    payrollRows = [];
    gamesSnap.forEach(d => {
      const g = { id: d.id, ...d.data() };
      // Skip hard-cancelled games
      if (g.cancelled && g.cancellationType !== "rainout" && g.cancellationType !== "rescheduled") return;
      (g.umpireSlots ?? []).forEach(slot => {
        if (!slot.assignedUid) return;
        // Determine pay: use stored payRate on slot first, then look up from config by type
        const configRate = payRates[slot.type?.toLowerCase()] ?? 0;
        const pay = Number(slot.payRate ?? configRate);
        payrollRows.push({
          gameId:     g.id,
          slotType:   slot.type ?? "—",
          uid:        slot.assignedUid,
          umpireName: slot.assignedName ?? slot.assignedUid,
          date:       g.date ?? "",
          city:       g.city ?? "",
          division:   g.division ?? "",
          field:      g.field ?? "",
          pay,
          paid:       slot.paid === true,
          noShow:     slot.noShow === true,
        });
      });
    });

    // Default to this year on first load
    if (!payrollFromFilter && !payrollToFilter) {
      const yr = thisYearRange();
      payrollFromFilter = yr.from;
      payrollToFilter   = yr.to;
      document.getElementById("payrollFrom").value = yr.from;
      document.getElementById("payrollTo").value   = yr.to;
    }

    renderAll();
  } catch (err) {
    console.error(err);
    tbody.innerHTML = '<tr><td colspan="7" style="color:#ffb4b4">Error loading payroll.</td></tr>';
  }
}

// ── Filter helpers ────────────────────────────────────────────────────────────

function filteredRows() {
  return payrollRows.filter(r => {
    if (payrollFromFilter && r.date < payrollFromFilter) return false;
    if (payrollToFilter   && r.date > payrollToFilter)   return false;
    return true;
  });
}

function renderAll() {
  renderSummary();
  renderDetailTable();
}

// ── Per-umpire summary ────────────────────────────────────────────────────────

function renderSummary() {
  const el = document.getElementById("payrollSummary");
  if (!el) return;

  const rows    = filteredRows();
  const billable = rows.filter(r => !r.noShow);

  if (!billable.length) {
    el.innerHTML = "";
    return;
  }

  // Group by uid
  const byUmpire = {};
  billable.forEach(r => {
    if (!byUmpire[r.uid]) byUmpire[r.uid] = { name: r.umpireName, rows: [] };
    byUmpire[r.uid].rows.push(r);
  });

  const cards = Object.entries(byUmpire)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .map(([uid, { name, rows: uRows }]) => {
      const owed       = uRows.reduce((s, r) => s + r.pay, 0);
      const paid       = uRows.filter(r => r.paid).reduce((s, r) => s + r.pay, 0);
      const outstanding = owed - paid;
      const allPaid    = outstanding === 0;
      const unpaidCount = uRows.filter(r => !r.paid).length;
      return `
        <div style="background:var(--container);border:1px solid ${allPaid ? "#2a4a2a" : "#444"};border-radius:8px;padding:14px 16px;min-width:180px;flex:1 1 180px">
          <div style="font-weight:600;margin-bottom:8px;font-size:0.95rem">${esc(name)}</div>
          <div style="font-size:0.82rem;color:var(--light-text);margin-bottom:2px">Owed: <strong style="color:var(--text)">$${owed.toFixed(2)}</strong></div>
          <div style="font-size:0.82rem;color:var(--light-text);margin-bottom:2px">Paid: <strong style="color:#6fcf97">$${paid.toFixed(2)}</strong></div>
          <div style="font-size:0.82rem;margin-bottom:10px;color:${allPaid ? "#6fcf97" : "#ffcc80"}">
            ${allPaid ? "✓ Fully paid" : `Outstanding: $${outstanding.toFixed(2)}`}
          </div>
          ${!allPaid ? `
            <button class="btn mark-all-paid-btn" data-uid="${esc(uid)}"
              style="font-size:0.78rem;padding:4px 12px;width:100%">
              Mark All Paid (${unpaidCount})
            </button>` : ""}
        </div>`;
    });

  el.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px">${cards.join("")}</div>`;

  el.querySelectorAll(".mark-all-paid-btn").forEach(btn => {
    btn.addEventListener("click", () => markAllPaid(btn.dataset.uid));
  });
}

async function markAllPaid(uid) {
  const rows = filteredRows().filter(r => r.uid === uid && !r.paid && !r.noShow);
  if (!rows.length) return;

  // Group by gameId so we only write each game doc once
  const byGame = {};
  rows.forEach(r => {
    if (!byGame[r.gameId]) byGame[r.gameId] = [];
    byGame[r.gameId].push(r);
  });

  try {
    for (const [gameId, gameRows] of Object.entries(byGame)) {
      const ref  = doc(db, "games", gameId);
      const snap = await getDoc(ref);
      if (!snap.exists()) continue;
      const slots = (snap.data().umpireSlots ?? []).map(s => {
        const match = gameRows.find(r => r.slotType === s.type && r.uid === s.assignedUid);
        return match ? { ...s, paid: true } : s;
      });
      await updateDoc(ref, { umpireSlots: slots });
    }
    // Update local state
    rows.forEach(r => { r.paid = true; });
    renderAll();
  } catch (err) {
    console.error(err);
    alert("Error marking paid: " + err.message);
  }
}

// ── Detail table ──────────────────────────────────────────────────────────────

function renderDetailTable() {
  const tbody    = document.getElementById("payrollBody");
  const totalsEl = document.getElementById("payrollTotals");
  if (!tbody) return;

  const rows     = filteredRows();
  const billable = rows.filter(r => !r.noShow);
  const noShows  = rows.length - billable.length;
  const totalOwed       = billable.reduce((s, r) => s + r.pay, 0);
  const totalPaid       = billable.filter(r => r.paid).reduce((s, r) => s + r.pay, 0);
  const outstanding     = totalOwed - totalPaid;

  if (totalsEl) {
    const noShowNote = noShows > 0 ? ` — ${noShows} no-show${noShows !== 1 ? "s" : ""} excluded` : "";
    totalsEl.innerHTML = rows.length === 0
      ? ""
      : `Total owed: <strong>$${totalOwed.toFixed(2)}</strong> &nbsp;·&nbsp; ` +
        `Paid: <strong style="color:#6fcf97">$${totalPaid.toFixed(2)}</strong> &nbsp;·&nbsp; ` +
        `Outstanding: <strong style="color:${outstanding > 0 ? "#ffcc80" : "#6fcf97"}">$${outstanding.toFixed(2)}</strong>${noShowNote}`;
  }

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--light-text);text-align:center">No payroll records for this period.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    if (r.noShow) {
      return `<tr style="opacity:0.5">
        <td>${esc(r.umpireName)}</td>
        <td>${esc(fmtDate(r.date))}</td>
        <td>${esc(r.city)}<br><span style="font-size:0.82rem;color:var(--light-text)">${esc(r.division)}</span></td>
        <td>${esc(r.field || "—")}</td>
        <td><span class="badge badge-${(r.slotType||"").toLowerCase()}">${esc(r.slotType)}</span></td>
        <td style="color:var(--light-text)">$0.00</td>
        <td><span class="badge" style="background:#3a1010;color:#ffb4b4">No Show</span></td>
      </tr>`;
    }
    const paidBadge = r.paid
      ? `<span class="badge" style="background:#17351f;color:#b8f2c4">Paid</span>`
      : `<span class="badge" style="background:#4a2c00;color:#ffcc80">Unpaid</span>`;
    const toggleBtn = `<button class="btn ${r.paid ? "print-btn" : ""} payroll-toggle-btn"
        data-game-id="${esc(r.gameId)}" data-slot-type="${esc(r.slotType)}" data-uid="${esc(r.uid)}"
        style="font-size:0.78rem;padding:3px 10px;margin-left:6px">
        ${r.paid ? "Unmark" : "Mark Paid"}
      </button>`;
    return `<tr>
      <td>${esc(r.umpireName)}</td>
      <td>${esc(fmtDate(r.date))}</td>
      <td>${esc(r.city)}<br><span style="font-size:0.82rem;color:var(--light-text)">${esc(r.division)}</span></td>
      <td style="font-size:0.85rem;color:var(--light-text)">${esc(r.field || "—")}</td>
      <td><span class="badge badge-${(r.slotType||"").toLowerCase()}">${esc(r.slotType)}</span></td>
      <td>$${r.pay.toFixed(2)}</td>
      <td style="white-space:nowrap">${paidBadge}${toggleBtn}</td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll(".payroll-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () =>
      togglePaid(btn.dataset.gameId, btn.dataset.slotType, btn.dataset.uid));
  });
}

async function togglePaid(gameId, slotType, uid) {
  const ref = doc(db, "games", gameId);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const slots = (snap.data().umpireSlots ?? []).map(s =>
      (s.type === slotType && s.assignedUid === uid) ? { ...s, paid: !s.paid } : s
    );
    await updateDoc(ref, { umpireSlots: slots });
    const row = payrollRows.find(r => r.gameId === gameId && r.slotType === slotType && r.uid === uid);
    if (row) row.paid = !row.paid;
    renderAll();
  } catch (err) {
    console.error(err);
    alert("Error updating paid status.");
  }
}

// ── CSV export ────────────────────────────────────────────────────────────────

function exportCSV() {
  const rows    = filteredRows();
  const headers = ["Umpire", "Date", "City", "Division", "Field", "Slot", "Pay", "Paid", "No Show"];
  const lines   = [
    headers.join(","),
    ...rows.map(r => [
      `"${(r.umpireName || "").replace(/"/g, '""')}"`,
      fmtDate(r.date),
      `"${(r.city || "").replace(/"/g, '""')}"`,
      `"${(r.division || "").replace(/"/g, '""')}"`,
      `"${(r.field || "").replace(/"/g, '""')}"`,
      r.slotType,
      r.noShow ? "0.00" : r.pay.toFixed(2),
      r.noShow ? "N/A" : (r.paid ? "Yes" : "No"),
      r.noShow ? "Yes" : "No",
    ].join(","))
  ];
  const blob  = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = `payroll-${today}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── Wire filters ──────────────────────────────────────────────────────────────

function wireFilters() {
  document.getElementById("payrollFilterBtn")?.addEventListener("click", () => {
    payrollFromFilter = document.getElementById("payrollFrom").value;
    payrollToFilter   = document.getElementById("payrollTo").value;
    renderAll();
  });
  document.getElementById("payrollResetBtn")?.addEventListener("click", () => {
    payrollFromFilter = payrollToFilter = "";
    document.getElementById("payrollFrom").value = "";
    document.getElementById("payrollTo").value   = "";
    renderAll();
  });
  document.getElementById("payrollThisYearBtn")?.addEventListener("click", () => {
    const r = thisYearRange();
    payrollFromFilter = r.from; payrollToFilter = r.to;
    document.getElementById("payrollFrom").value = r.from;
    document.getElementById("payrollTo").value   = r.to;
    renderAll();
  });
  document.getElementById("payrollLastYearBtn")?.addEventListener("click", () => {
    const r = lastYearRange();
    payrollFromFilter = r.from; payrollToFilter = r.to;
    document.getElementById("payrollFrom").value = r.from;
    document.getElementById("payrollTo").value   = r.to;
    renderAll();
  });
  document.getElementById("exportCsvBtn")?.addEventListener("click", exportCSV);
}

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display = "none";

  wireFilters();
  loadPayroll();
});
