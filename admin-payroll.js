// admin-payroll.js — Payroll summary with per-umpire grouping and mark-paid
import { db, app } from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import { getOrgSettings, getSeasonRange } from "./org.js";
import { esc, fmtDate, fmtTime, todayISO, setMsg, thisYearRange, lastYearRange, showToast, showConfirm } from "./utils.js";

import {
  collection, getDocs, getDoc, addDoc, deleteDoc, doc, updateDoc, writeBatch, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── State ─────────────────────────────────────────────────────────────────────

let payrollRows       = [];
let payRates          = { plate: 0, field: 0, extra: 0 };
let payrollFromFilter = "";
let payrollToFilter   = "";
let payrollUmpireFilter = "";  // uid of selected umpire, "" = all
let manualPayEntries  = [];
let divisionPayRates  = {};   // { "10U": 40, "12U": 45, ... }
let umpireList        = [];   // [{ uid, name }] for the umpire dropdown

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadPayroll() {
  const tbody = document.getElementById("payrollBody");
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="color:var(--light-text);text-align:center">Loading…</td></tr>';

  // Ensure org settings (season dates) are resolved before computing default filter
  await getOrgSettings().catch(() => {});

  try {
    const [gamesSnap, ratesSnap, manualSnap] = await Promise.all([
      getDocs(query(collection(db, "games"), orderBy("date", "asc"))),
      getDoc(doc(db, "config", "payRates")),
      getDocs(query(collection(db, "manualPay"), orderBy("date", "asc"))),
    ]);

    if (ratesSnap.exists()) {
      const r = ratesSnap.data();
      payRates = { plate: Number(r.plate ?? 0), field: Number(r.field ?? 0), extra: Number(r.extra ?? 0) };
      divisionPayRates = r.divisionRates || {};
    }

    payrollRows = [];
    gamesSnap.forEach(d => {
      const g = { id: d.id, ...d.data() };
      // Skip all cancelled games — rainouts retain umpire assignments for history but are not paid
      if (g.cancelled) return;
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
          paid:       slot.paid      === true,
          checkedIn:  slot.checkedIn === true,
          noShow:     slot.noShow    === true,
        });
      });
    });

    manualPayEntries = manualSnap.docs.map(d => ({ id: d.id, ...d.data() }));

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

function filteredRows(ignoreUmpireFilter = false) {
  return payrollRows.filter(r => {
    if (payrollFromFilter && r.date < payrollFromFilter) return false;
    if (payrollToFilter   && r.date > payrollToFilter)   return false;
    if (!ignoreUmpireFilter && payrollUmpireFilter && r.uid !== payrollUmpireFilter) return false;
    return true;
  });
}

function renderAll() {
  renderSummary();
  renderDetailTable();
  renderManualPay();
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
      const isFiltered  = payrollUmpireFilter === uid;
      return `
        <div style="background:var(--container);border:2px solid ${isFiltered ? "var(--accent)" : (allPaid ? "#2a4a2a" : "#444")};border-radius:8px;padding:14px 16px;min-width:180px;flex:1 1 180px;cursor:pointer"
          class="umpire-card" data-uid="${esc(uid)}">
          <div style="font-weight:600;margin-bottom:8px;font-size:0.95rem;display:flex;align-items:center;gap:6px">
            ${esc(name)}
            ${isFiltered ? '<span style="font-size:0.72rem;background:var(--accent);color:#fff;border-radius:4px;padding:1px 6px">filtered</span>' : ""}
          </div>
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
              📄 Print Stub
            </button>
            <button class="btn print-btn email-stub-btn" data-uid="${esc(uid)}"
              style="font-size:0.78rem;padding:4px 12px;width:100%">
              ✉️ Email Stub
            </button>
          </div>
        </div>`;
    });

  el.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px">${cards.join("")}</div>`;

  // Card click → filter detail table
  el.querySelectorAll(".umpire-card").forEach(card => {
    card.addEventListener("click", e => {
      if (e.target.closest("button")) return; // let buttons work normally
      const uid = card.dataset.uid;
      payrollUmpireFilter = payrollUmpireFilter === uid ? "" : uid;
      renderAll();
    });
  });
  el.querySelectorAll(".mark-all-paid-btn").forEach(btn => {
    btn.addEventListener("click", () => markAllPaid(btn.dataset.uid));
  });
  el.querySelectorAll(".pay-stub-btn").forEach(btn => {
    btn.addEventListener("click", () => generatePayStub(btn.dataset.uid));
  });
  el.querySelectorAll(".email-stub-btn").forEach(btn => {
    btn.addEventListener("click", () => emailPayStub(btn));
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
    // Fetch all game docs in parallel, then commit all updates as a single batch
    const gameIds = Object.keys(byGame);
    const refs    = gameIds.map(id => doc(db, "games", id));
    const snaps   = await Promise.all(refs.map(ref => getDoc(ref)));

    const batch = writeBatch(db);
    snaps.forEach((snap, i) => {
      if (!snap.exists()) return;
      const gameRows = byGame[gameIds[i]];
      const slots = (snap.data().umpireSlots ?? []).map(s => {
        const match = gameRows.find(r => r.slotType === s.type && r.uid === s.assignedUid);
        return match ? { ...s, paid: true } : s;
      });
      batch.update(refs[i], { umpireSlots: slots });
    });
    await batch.commit();

    // Update local state
    rows.forEach(r => { r.paid = true; });
    renderAll();
  } catch (err) {
    console.error(err);
    showToast("Error marking paid: " + err.message);
  }
}

// ── Detail table ──────────────────────────────────────────────────────────────

function renderDetailTable() {
  const tbody    = document.getElementById("payrollBody");
  const totalsEl = document.getElementById("payrollTotals");
  if (!tbody) return;

  // Show/update umpire filter banner
  let filterBanner = document.getElementById("payrollUmpireFilterBanner");
  if (!filterBanner) {
    filterBanner = document.createElement("div");
    filterBanner.id = "payrollUmpireFilterBanner";
    tbody.closest("table")?.parentElement?.insertBefore(filterBanner, tbody.closest("table"));
  }
  if (payrollUmpireFilter) {
    const allUmpireRows = filteredRows(true);
    const name = allUmpireRows.find(r => r.uid === payrollUmpireFilter)?.umpireName || payrollUmpireFilter;
    filterBanner.innerHTML = `<p style="font-size:0.88rem;color:var(--light-text);margin:0 0 8px">
      Showing: <strong style="color:var(--text)">${esc(name)}</strong>
      &nbsp;<button id="clearUmpireFilterBtn" class="btn print-btn" style="font-size:0.75rem;padding:2px 8px">× Show All</button>
    </p>`;
    document.getElementById("clearUmpireFilterBtn")?.addEventListener("click", () => {
      payrollUmpireFilter = ""; renderAll();
    });
  } else {
    filterBanner.innerHTML = "";
  }

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
    tbody.innerHTML = '<tr><td colspan="8" style="color:var(--light-text);text-align:center">No payroll records for this period.</td></tr>';
    return;
  }

  // Update header column count
  const thead = document.querySelector("#payrollTable thead tr");
  if (thead && !thead.querySelector("th[data-checkin-col]")) {
    const slotTh = [...thead.querySelectorAll("th")].find(th => th.textContent === "Slot");
    if (slotTh) {
      const ciTh = document.createElement("th");
      ciTh.textContent = "Check-In";
      ciTh.setAttribute("data-checkin-col", "1");
      slotTh.insertAdjacentElement("afterend", ciTh);
    }
  }

  tbody.innerHTML = rows.map(r => {
    if (r.noShow) {
      return `<tr style="opacity:0.5">
        <td>${esc(r.umpireName)}</td>
        <td>${esc(fmtDate(r.date))}</td>
        <td>${esc(r.city)}<br><span style="font-size:0.82rem;color:var(--light-text)">${esc(r.division)}</span></td>
        <td>${esc(r.field || "—")}</td>
        <td><span class="badge badge-${(r.slotType||"").toLowerCase()}">${esc(r.slotType)}</span></td>
        <td>—</td>
        <td style="color:var(--light-text)">$0.00</td>
        <td><span class="badge" style="background:#3a1010;color:#ffb4b4">No Show</span></td>
      </tr>`;
    }
    const checkedInCell = r.checkedIn
      ? `<span style="color:#6fcf97;font-size:0.88rem">✅</span>`
      : `<span style="color:var(--light-text);font-size:0.88rem">—</span>`;
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
      <td style="text-align:center">${checkedInCell}</td>
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
    showToast("Error updating paid status.");
  }
}

// ── Pay stub ──────────────────────────────────────────────────────────────────

async function generatePayStub(uid) {
  const rows     = filteredRows().filter(r => r.uid === uid && !r.noShow);
  if (!rows.length) return;

  const org  = await getOrgSettings();
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

  const brand = org.accentColor || "#601929";

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
      border-bottom: 3px solid ${brand};
      padding-bottom: 14px;
      margin-bottom: 20px;
    }
    .org-name {
      font-size: 20px;
      font-weight: 700;
      color: ${brand};
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
    .stub-info-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: ${brand}; margin-bottom: 3px; }
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
      background: ${brand};
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
      background: ${brand};
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 9px 24px;
      font-size: 14px;
      cursor: pointer;
      font-family: inherit;
    }
    .print-bar button:hover { filter: brightness(0.85); }

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
      <div class="org-name">${esc(org.orgName || "")}</div>
      <div class="org-sub">${esc(org.assocName || "")}</div>
      <div class="org-sub">Contact: ${esc(org.coordinatorName || "")} &nbsp;·&nbsp; ${esc(org.coordinatorPhone || "")}</div>
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
    <p>This document is a payment record for officiating services rendered to ${esc(org.assocName || "")}.
    It is not a tax document. Please retain for your records.</p>
    <p style="margin-top:4px">Questions? Contact ${esc(org.coordinatorName || "")} at ${esc(org.coordinatorPhone || "")} or post in the Umpire Slack channel.</p>
  </div>

</body>
</html>`;

  const win = window.open("", "_blank");
  if (win) {
    win.document.write(html);
    win.document.close();
  }
}

// ── Email pay stub ────────────────────────────────────────────────────────────

async function emailPayStub(btn) {
  const uid = btn.dataset.uid;
  if (!uid) return;

  btn.disabled    = true;
  btn.textContent = "Sending…";

  try {
    const fns         = getFunctions(app, "us-central1");
    const emailStubFn = httpsCallable(fns, "emailPayStub");
    const result      = await emailStubFn({
      uid,
      fromDate: payrollFromFilter || null,
      toDate:   payrollToFilter   || null,
    });
    showToast(`✉️ Pay stub emailed to ${result.data.to}`);
  } catch (err) {
    showToast("Error sending email: " + (err.message || err.code));
  } finally {
    btn.disabled    = false;
    btn.textContent = "✉️ Email Stub";
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
  const today = todayISO();
  a.href = url; a.download = `payroll-${today}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── Wire filters ──────────────────────────────────────────────────────────────

function wireFilters() {
  document.getElementById("payrollFilterBtn")?.addEventListener("click", () => {
    payrollFromFilter = document.getElementById("payrollFrom").value;
    payrollToFilter   = document.getElementById("payrollTo").value;
    payrollUmpireFilter = "";
    renderAll();
  });
  document.getElementById("payrollResetBtn")?.addEventListener("click", () => {
    payrollFromFilter = payrollToFilter = "";
    payrollUmpireFilter = "";
    document.getElementById("payrollFrom").value = "";
    document.getElementById("payrollTo").value   = "";
    renderAll();
  });
  document.getElementById("payrollThisYearBtn")?.addEventListener("click", () => {
    const r = thisYearRange();
    payrollFromFilter = r.from; payrollToFilter = r.to;
    payrollUmpireFilter = "";
    document.getElementById("payrollFrom").value = r.from;
    document.getElementById("payrollTo").value   = r.to;
    renderAll();
  });
  document.getElementById("payrollLastYearBtn")?.addEventListener("click", () => {
    const r = lastYearRange();
    payrollFromFilter = r.from; payrollToFilter = r.to;
    payrollUmpireFilter = "";
    document.getElementById("payrollFrom").value = r.from;
    document.getElementById("payrollTo").value   = r.to;
    renderAll();
  });
  document.getElementById("exportCsvBtn")?.addEventListener("click", exportCSV);
}

// ── Manual Pay ────────────────────────────────────────────────────────────────

function renderManualPay() {
  const tbody    = document.getElementById("manualPayBody");
  const totalsEl = document.getElementById("manualPayTotals");
  if (!tbody) return;

  // Apply same date filter as main payroll
  const rows = manualPayEntries.filter(r => {
    if (payrollFromFilter && r.date < payrollFromFilter) return false;
    if (payrollToFilter   && r.date > payrollToFilter)   return false;
    return true;
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--light-text);text-align:center">No unscheduled pay entries.</td></tr>';
    if (totalsEl) totalsEl.textContent = "";
    return;
  }

  const totalAmt  = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const paidAmt   = rows.filter(r => r.paid).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const unpaidAmt = totalAmt - paidAmt;
  if (totalsEl) totalsEl.textContent =
    `${rows.length} entr${rows.length === 1 ? "y" : "ies"} · Total: $${totalAmt.toFixed(2)} · Paid: $${paidAmt.toFixed(2)} · Unpaid: $${unpaidAmt.toFixed(2)}`;

  tbody.innerHTML = rows.map(r => {
    const paidBadge = r.paid
      ? '<span class="badge badge-upcoming" style="font-size:0.72rem">Paid</span>'
      : '<span class="badge badge-today" style="font-size:0.72rem">Unpaid</span>';
    const paidBtn = r.paid
      ? '<button class="btn print-btn mp-unpay-btn" data-id="' + esc(r.id) + '" style="font-size:0.75rem;padding:3px 8px">Unmark</button>'
      : '<button class="btn mp-pay-btn" data-id="' + esc(r.id) + '" style="font-size:0.75rem;padding:3px 8px">Mark Paid</button>';
    return '<tr>' +
      '<td style="font-size:0.85rem">' + esc(r.date || "—") + '</td>' +
      '<td>' + esc(r.division || "—") + '</td>' +
      '<td>' + esc(r.umpireName || "—") + '</td>' +
      '<td>$' + (Number(r.amount) || 0).toFixed(2) + '</td>' +
      '<td style="font-size:0.82rem;color:var(--light-text)">' + esc(r.notes || "") + '</td>' +
      '<td>' + paidBadge + '</td>' +
      '<td style="display:flex;gap:4px">' + paidBtn +
        '<button class="btn print-btn mp-delete-btn" data-id="' + esc(r.id) + '" style="font-size:0.75rem;padding:3px 8px;color:#ff8a8a;border-color:#ff8a8a">Delete</button>' +
      '</td>' +
    '</tr>';
  }).join("");
}

async function loadUmpireList() {
  if (umpireList.length) return;
  try {
    const snap = await getDocs(query(collection(db, "umpires"), orderBy("lastName")));
    umpireList = snap.docs
      .map(d => ({ uid: d.id, name: d.data().name || (d.data().firstName + " " + d.data().lastName).trim() }))
      .filter(u => u.name);
  } catch { /* non-fatal */ }
}

function populateUmpireSelect() {
  const sel = document.getElementById("mpUmpire");
  if (!sel) return;
  sel.innerHTML = '<option value="">— Select umpire —</option>' +
    umpireList.map(u => '<option value="' + esc(u.uid) + '">' + esc(u.name) + '</option>').join("");
}

document.getElementById("mpDivision")?.addEventListener("change", function() {
  const rate = divisionPayRates[this.value];
  const amtEl = document.getElementById("mpAmount");
  if (amtEl && rate != null) amtEl.value = rate.toFixed(2);
});

document.getElementById("addManualPayBtn")?.addEventListener("click", async () => {
  await loadUmpireList();
  populateUmpireSelect();
  document.getElementById("mpDate").value       = todayISO();
  document.getElementById("mpDivision").value   = "";
  document.getElementById("mpUmpire").value     = "";
  document.getElementById("mpAmount").value     = "";
  document.getElementById("mpPaid").checked     = false;
  document.getElementById("mpNotes").value      = "";
  setMsg("manualPayMsg", "", "info");
  document.getElementById("manualPayModal").style.display = "flex";
});

document.getElementById("cancelManualPayBtn")?.addEventListener("click", () => {
  document.getElementById("manualPayModal").style.display = "none";
});

document.getElementById("saveManualPayBtn")?.addEventListener("click", async () => {
  const date      = document.getElementById("mpDate").value;
  const division  = document.getElementById("mpDivision").value;
  const umpireUid = document.getElementById("mpUmpire").value;
  const amount    = parseFloat(document.getElementById("mpAmount").value);
  const paid      = document.getElementById("mpPaid").checked;
  const notes     = document.getElementById("mpNotes").value.trim();

  if (!date || !division || isNaN(amount)) {
    setMsg("manualPayMsg", "Date, division, and amount are required.", "error"); return;
  }
  const umpire = umpireList.find(u => u.uid === umpireUid);
  const resolvedUmpireName = umpireUid ? (umpire?.name || umpireUid) : "Unknown / On-site";
  const btn = document.getElementById("saveManualPayBtn");
  btn.disabled = true;
  setMsg("manualPayMsg", "Saving…", "info");
  try {
    const ref = await addDoc(collection(db, "manualPay"), {
      date, division,
      umpireUid: umpireUid || null,
      umpireName: resolvedUmpireName,
      amount,
      paid,
      paidAt: paid ? serverTimestamp() : null,
      notes,
      createdAt: serverTimestamp(),
    });
    manualPayEntries.push({ id: ref.id, date, division, umpireUid: umpireUid || null, umpireName: resolvedUmpireName, amount, paid, notes });
    manualPayEntries.sort((a, b) => a.date.localeCompare(b.date));
    document.getElementById("manualPayModal").style.display = "none";
    renderManualPay();
  } catch (err) {
    setMsg("manualPayMsg", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("manualPayBody")?.addEventListener("click", async e => {
  const payBtn    = e.target.closest(".mp-pay-btn");
  const unpayBtn  = e.target.closest(".mp-unpay-btn");
  const deleteBtn = e.target.closest(".mp-delete-btn");

  if (payBtn || unpayBtn) {
    const id   = (payBtn || unpayBtn).dataset.id;
    const paid = !!payBtn;
    try {
      await updateDoc(doc(db, "manualPay", id), { paid, paidAt: paid ? serverTimestamp() : null });
      const entry = manualPayEntries.find(r => r.id === id);
      if (entry) entry.paid = paid;
      renderManualPay();
    } catch (err) { showToast(err.message); }
    return;
  }
  if (deleteBtn) {
    const id = deleteBtn.dataset.id;
    const entry = manualPayEntries.find(r => r.id === id);
    if (!entry || !await showConfirm(`Delete pay entry for ${entry.umpireName} on ${entry.date}?`)) return;
    try {
      await deleteDoc(doc(db, "manualPay", id));
      manualPayEntries = manualPayEntries.filter(r => r.id !== id);
      renderManualPay();
    } catch (err) { showToast(err.message); }
  }
});

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
