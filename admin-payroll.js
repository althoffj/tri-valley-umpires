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
      const owed        = uRows.reduce((s, r) => s + r.pay, 0);
      const paid        = uRows.filter(r => r.paid).reduce((s, r) => s + r.pay, 0);
      const outstanding = owed - paid;
      const allPaid     = outstanding === 0;
      const unpaidCount = uRows.filter(r => !r.paid).length;
      return `
        <div style="background:var(--container);border:1px solid ${allPaid ? "#2a4a2a" : "#444"};border-radius:8px;padding:14px 16px;min-width:180px;flex:1 1 180px">
          <div style="font-weight:600;margin-bottom:8px;font-size:0.95rem">${esc(name)}</div>
          <div style="font-size:0.82rem;color:var(--light-text);margin-bottom:2px">Owed: <strong style="color:var(--text)">$${owed.toFixed(2)}</strong></div>
          <div style="font-size:0.82rem;color:var(--light-text);margin-bottom:2px">Paid: <strong style="color:#6fcf97">$${paid.toFixed(2)}</strong></div>
          <div style="font-size:0.82rem;margin-bottom:10px;color:${allPaid ? "#6fcf97" : "#ffcc80"}">
            ${allPaid ? "✓ Fully paid" : `Outstanding: $${outstanding.toFixed(2)}`}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${!allPaid ? `
              <button class="btn mark-all-paid-btn" data-uid="${esc(uid)}"
                style="font-size:0.78rem;padding:4px 12px;width:100%">
                Mark All Paid (${unpaidCount})
              </button>` : ""}
            <button class="btn print-btn pay-stub-btn" data-uid="${esc(uid)}"
              style="font-size:0.78rem;padding:4px 12px;width:100%">
              📄 Pay Stub
            </button>
          </div>
        </div>`;
    });

  el.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px">${cards.join("")}</div>`;

  el.querySelectorAll(".mark-all-paid-btn").forEach(btn => {
    btn.addEventListener("click", () => markAllPaid(btn.dataset.uid));
  });
  el.querySelectorAll(".pay-stub-btn").forEach(btn => {
    btn.addEventListener("click", () => generatePayStub(btn.dataset.uid));
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

// ── Pay stub ──────────────────────────────────────────────────────────────────

function generatePayStub(uid) {
  const rows     = filteredRows().filter(r => r.uid === uid && !r.noShow);
  if (!rows.length) return;

  const name      = rows[0].umpireName;
  const owed      = rows.reduce((s, r) => s + r.pay, 0);
  const paid      = rows.filter(r => r.paid).reduce((s, r) => s + r.pay, 0);
  const balance   = owed - paid;
  const today     = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const periodFrom = payrollFromFilter ? new Date(payrollFromFilter + "T12:00:00").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "All time";
  const periodTo   = payrollToFilter   ? new Date(payrollToFilter   + "T12:00:00").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : today;

  const rateTable = [
    payRates.plate ? `Plate Umpire: $${payRates.plate.toFixed(2)}` : null,
    payRates.field ? `Field Umpire: $${payRates.field.toFixed(2)}` : null,
    payRates.extra ? `Extra: $${payRates.extra.toFixed(2)}` : null,
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");

  const gameRows = rows
    .slice()
    .sort((a, b) => a.date < b.date ? -1 : 1)
    .map(r => `
      <tr>
        <td>${fmtDate(r.date)}</td>
        <td>${r.division || "—"}</td>
        <td>${r.city || "—"}</td>
        <td>${r.field || "—"}</td>
        <td>${r.slotType}</td>
        <td class="money">$${r.pay.toFixed(2)}</td>
        <td class="${r.paid ? "paid" : "unpaid"}">${r.paid ? "Paid" : "Unpaid"}</td>
      </tr>`).join("");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pay Stub — ${name}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      color: #111;
      background: #fff;
      padding: 32px 40px;
      max-width: 760px;
      margin: 0 auto;
    }

    /* ── Header ── */
    .stub-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 3px solid #601929;
      padding-bottom: 14px;
      margin-bottom: 20px;
    }
    .org-name {
      font-size: 20px;
      font-weight: 700;
      color: #601929;
      line-height: 1.2;
    }
    .org-sub {
      font-size: 12px;
      color: #555;
      margin-top: 3px;
    }
    .stub-meta {
      text-align: right;
      font-size: 12px;
      color: #555;
    }
    .stub-meta strong { color: #111; }

    /* ── To / Period block ── */
    .stub-info {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px 24px;
      background: #f7f0f1;
      border: 1px solid #d9b8bb;
      border-radius: 6px;
      padding: 14px 18px;
      margin-bottom: 20px;
    }
    .stub-info-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #601929; margin-bottom: 3px; }
    .stub-info-value { font-size: 14px; font-weight: 600; color: #111; }

    /* ── Rate note ── */
    .rate-note {
      font-size: 11px;
      color: #555;
      margin-bottom: 16px;
    }
    .rate-note strong { color: #111; }

    /* ── Table ── */
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
      font-size: 12.5px;
    }
    thead th {
      background: #601929;
      color: #fff;
      text-align: left;
      padding: 7px 10px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    thead th.money { text-align: right; }
    tbody tr:nth-child(even) { background: #faf5f6; }
    tbody td {
      padding: 7px 10px;
      border-bottom: 1px solid #e8dde0;
      vertical-align: middle;
    }
    td.money { text-align: right; font-variant-numeric: tabular-nums; }
    td.paid   { color: #1a6b30; font-weight: 600; }
    td.unpaid { color: #8a4a00; font-weight: 600; }

    /* ── Totals ── */
    .totals {
      width: 260px;
      margin-left: auto;
      border: 1px solid #d9b8bb;
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 24px;
    }
    .totals-row {
      display: flex;
      justify-content: space-between;
      padding: 7px 14px;
      font-size: 13px;
      border-bottom: 1px solid #ead8da;
    }
    .totals-row:last-child { border-bottom: none; }
    .totals-row.total-owed  { background: #f7f0f1; }
    .totals-row.total-paid  { background: #f0f7f2; color: #1a6b30; }
    .totals-row.total-bal   { background: ${balance > 0 ? "#fff8ee" : "#f0f7f2"}; font-weight: 700; color: ${balance > 0 ? "#8a4a00" : "#1a6b30"}; }
    .totals-label { font-weight: 500; }
    .totals-amount { font-variant-numeric: tabular-nums; }

    /* ── Footer note ── */
    .stub-footer {
      border-top: 1px solid #ddd;
      padding-top: 12px;
      font-size: 11px;
      color: #777;
      line-height: 1.5;
    }

    /* ── Print button (screen only) ── */
    .print-bar {
      text-align: center;
      margin-bottom: 24px;
    }
    .print-bar button {
      background: #601929;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 9px 24px;
      font-size: 14px;
      cursor: pointer;
      font-family: inherit;
    }
    .print-bar button:hover { background: #7a2035; }

    @media print {
      body { padding: 16px; }
      .print-bar { display: none; }
      @page { margin: 1.5cm; }
    }
  </style>
</head>
<body>

  <div class="print-bar">
    <button onclick="window.print()">🖨 Print / Save as PDF</button>
  </div>

  <!-- Header -->
  <div class="stub-header">
    <div>
      <div class="org-name">Tri-Valley Baseball Umpires</div>
      <div class="org-sub">Tri-Valley Baseball Association &nbsp;·&nbsp; SD VFW Baseball</div>
      <div class="org-sub">Contact: Jeff Althoff &nbsp;·&nbsp; 605-380-0229</div>
    </div>
    <div class="stub-meta">
      <div><strong>Pay Statement</strong></div>
      <div>Generated: ${today}</div>
    </div>
  </div>

  <!-- To / Period info -->
  <div class="stub-info">
    <div>
      <div class="stub-info-label">Umpire</div>
      <div class="stub-info-value">${name}</div>
    </div>
    <div>
      <div class="stub-info-label">Pay Period</div>
      <div class="stub-info-value">${periodFrom === periodTo ? periodFrom : periodFrom + " – " + periodTo}</div>
    </div>
    <div>
      <div class="stub-info-label">Games Worked</div>
      <div class="stub-info-value">${rows.length}</div>
    </div>
    <div>
      <div class="stub-info-label">Statement Date</div>
      <div class="stub-info-value">${today}</div>
    </div>
  </div>

  ${rateTable ? `<div class="rate-note"><strong>Pay rates:</strong> ${rateTable}</div>` : ""}

  <!-- Game detail table -->
  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Division</th>
        <th>City</th>
        <th>Field</th>
        <th>Position</th>
        <th class="money">Rate</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>${gameRows}</tbody>
  </table>

  <!-- Totals -->
  <div class="totals">
    <div class="totals-row total-owed">
      <span class="totals-label">Total Earned</span>
      <span class="totals-amount">$${owed.toFixed(2)}</span>
    </div>
    <div class="totals-row total-paid">
      <span class="totals-label">Amount Paid</span>
      <span class="totals-amount">$${paid.toFixed(2)}</span>
    </div>
    <div class="totals-row total-bal">
      <span class="totals-label">${balance > 0 ? "Balance Due" : "Fully Paid"}</span>
      <span class="totals-amount">$${balance.toFixed(2)}</span>
    </div>
  </div>

  <!-- Footer -->
  <div class="stub-footer">
    <p>This document is a payment record for officiating services rendered to Tri-Valley Baseball Association.
    It is not a tax document. Please retain for your records.</p>
    <p style="margin-top:4px">Questions? Contact Jeff Althoff at 605-380-0229 or post in the Umpire Slack channel.</p>
  </div>

</body>
</html>`;

  const win = window.open("", "_blank");
  if (win) {
    win.document.write(html);
    win.document.close();
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
