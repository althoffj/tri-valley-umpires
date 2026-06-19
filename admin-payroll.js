// admin-payroll.js — Payroll summary with per-umpire grouping and mark-paid
import { db, app } from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import { getOrgSettings, getSeasonRange } from "./org.js";
import { esc, fmtDate, fmtTime, todayISO, setMsg, thisYearRange, lastYearRange, showToast, showConfirm } from "./utils.js";

import {
  collection, getDocs, getDoc, addDoc, deleteDoc, doc, updateDoc, writeBatch, query, orderBy, serverTimestamp, runTransaction
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
let selectedRowKeys   = new Set(); // "gameId|slotType|uid" keys for bulk print
let activePayrollTab  = "detail"; // "detail" | "checks"
let checkRegisterFilter = "all";  // "all" | "outstanding" | "cleared"

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
          gameId:      g.id,
          slotType:    slot.type ?? "—",
          uid:         slot.assignedUid,
          umpireName:  slot.assignedName ?? slot.assignedUid,
          date:        g.date ?? "",
          city:        g.city ?? "",
          division:    g.division ?? "",
          field:       g.field ?? "",
          pay,
          paid:         slot.paid         === true,
          checkedIn:    slot.checkedIn    === true,
          noShow:       slot.noShow       === true,
          checkNumber:  slot.checkNumber  || "",
          checkCleared: slot.checkCleared === true,
          paidDate:     slot.paidDate     || "",
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
              <button class="btn cut-payment-btn" data-uid="${esc(uid)}"
                style="font-size:0.78rem;padding:4px 12px;width:100%">
                ✂ Cut Payment
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
  el.querySelectorAll(".cut-payment-btn").forEach(btn => {
    btn.addEventListener("click", () => openCutPaymentModal(btn.dataset.uid));
  });
  el.querySelectorAll(".pay-stub-btn").forEach(btn => {
    btn.addEventListener("click", () => generatePayStub(btn.dataset.uid));
  });
  el.querySelectorAll(".email-stub-btn").forEach(btn => {
    btn.addEventListener("click", () => emailPayStub(btn));
  });
}

// ── Mark-Paid modal (check number entry) ──────────────────────────────────────

let _payModal = { gameId: null, slotType: null, uid: null, allForUid: null };

function openPayModal(gameId, slotType, uid) {
  _payModal = { gameId, slotType, uid, allForUid: null };
  _showPayModal();
}

function openPayAllModal(uid) {
  _payModal = { gameId: null, slotType: null, uid, allForUid: uid };
  _showPayModal();
}

function _showPayModal() {
  const modal = document.getElementById("markPaidModal");
  const input = document.getElementById("markPaidCheckNumber");
  const label = document.getElementById("markPaidContextLabel");
  if (!modal || !input || !label) return;

  input.value = "";

  if (_payModal.allForUid) {
    const rows = filteredRows().filter(r => r.uid === _payModal.allForUid && !r.paid && !r.noShow);
    const name = rows[0]?.umpireName || _payModal.allForUid;
    label.textContent = `Mark all ${rows.length} unpaid slot${rows.length !== 1 ? "s" : ""} paid for ${name}`;
  } else {
    const row = payrollRows.find(r =>
      r.gameId === _payModal.gameId && r.slotType === _payModal.slotType && r.uid === _payModal.uid
    );
    label.textContent = row
      ? `${row.umpireName} — ${fmtDate(row.date)} (${row.slotType})`
      : "Mark as paid";
  }

  modal.style.display = "";
  input.focus();
}

function closePayModal() {
  document.getElementById("markPaidModal").style.display = "none";
  _payModal = { gameId: null, slotType: null, uid: null, allForUid: null };
}

async function commitPayModal() {
  const checkNumber = document.getElementById("markPaidCheckNumber")?.value.trim() || "";
  closePayModal();
  if (_payModal.allForUid !== null) {
    await markAllPaid(_payModal.allForUid, checkNumber);
  } else {
    await togglePaid(_payModal.gameId, _payModal.slotType, _payModal.uid, checkNumber);
  }
}

function wirePayModal() {
  document.getElementById("markPaidConfirmBtn")?.addEventListener("click", commitPayModal);
  document.getElementById("markPaidCancelBtn")?.addEventListener("click", closePayModal);
  document.getElementById("markPaidCheckNumber")?.addEventListener("keydown", e => {
    if (e.key === "Enter")  { e.preventDefault(); commitPayModal(); }
    if (e.key === "Escape") { e.preventDefault(); closePayModal(); }
  });
  document.getElementById("markPaidModal")?.addEventListener("click", e => {
    if (e.target === e.currentTarget) closePayModal();
  });
}

async function markAllPaid(uid, checkNumber = "") {
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
        if (!match) return s;
        const updated = { ...s, paid: true, paidDate: todayISO() };
        if (checkNumber) updated.checkNumber = checkNumber; else delete updated.checkNumber;
        return updated;
      });
      batch.update(refs[i], { umpireSlots: slots });
    });
    await batch.commit();

    // Update local state
    rows.forEach(r => { r.paid = true; r.checkNumber = checkNumber; r.paidDate = todayISO(); });
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
    tbody.innerHTML = '<tr><td colspan="9" style="color:var(--light-text);text-align:center">No payroll records for this period.</td></tr>';
    updateBulkPrintBtn();
    return;
  }

  // Ensure thead has checkbox + check-in columns (idempotent)
  const thead = document.querySelector("#payrollTable thead tr");
  if (thead && !thead.querySelector("th[data-cb-col]")) {
    const cbTh = document.createElement("th");
    cbTh.setAttribute("data-cb-col", "1");
    cbTh.style.width = "32px";
    cbTh.innerHTML = `<input type="checkbox" id="payrollSelectAll" title="Select all" style="cursor:pointer" />`;
    thead.prepend(cbTh);
  }
  if (thead && !thead.querySelector("th[data-checkin-col]")) {
    const slotTh = [...thead.querySelectorAll("th")].find(th => th.textContent === "Slot");
    if (slotTh) {
      const ciTh = document.createElement("th");
      ciTh.textContent = "Check-In";
      ciTh.setAttribute("data-checkin-col", "1");
      slotTh.insertAdjacentElement("afterend", ciTh);
    }
  }

  // Prune selectedRowKeys to only keys still visible
  const visibleKeys = new Set(
    rows.filter(r => !r.noShow).map(r => `${r.gameId}|${r.slotType}|${r.uid}`)
  );
  for (const k of [...selectedRowKeys]) { if (!visibleKeys.has(k)) selectedRowKeys.delete(k); }

  tbody.innerHTML = rows.map(r => {
    const rowKey = `${r.gameId}|${r.slotType}|${r.uid}`;
    if (r.noShow) {
      return `<tr style="opacity:0.5">
        <td></td>
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
    const isChecked = selectedRowKeys.has(rowKey);
    const checkedInCell = r.checkedIn
      ? `<span style="color:#6fcf97;font-size:0.88rem">✅</span>`
      : `<span style="color:var(--light-text);font-size:0.88rem">—</span>`;
    const checkNumLabel = r.paid && r.checkNumber
      ? `<div style="font-size:0.73rem;color:var(--light-text);margin-top:2px">Check #${esc(r.checkNumber)}</div>`
      : "";
    const paidBadge = r.paid
      ? r.checkCleared
        ? `<span class="badge" style="background:#0d3030;color:#7ef7d8">✓ Cleared</span>${checkNumLabel}`
        : `<span class="badge" style="background:#17351f;color:#b8f2c4">Paid</span>${checkNumLabel}`
      : `<span class="badge" style="background:#4a2c00;color:#ffcc80">Unpaid</span>`;
    const toggleBtn = `<button class="btn ${r.paid ? "print-btn" : ""} payroll-toggle-btn"
        data-game-id="${esc(r.gameId)}" data-slot-type="${esc(r.slotType)}" data-uid="${esc(r.uid)}"
        style="font-size:0.78rem;padding:3px 10px;margin-left:6px">
        ${r.paid ? "Unmark" : "Mark Paid"}
      </button>`;
    const clearedBtn = r.paid
      ? `<button class="btn print-btn payroll-cleared-btn"
          data-game-id="${esc(r.gameId)}" data-slot-type="${esc(r.slotType)}" data-uid="${esc(r.uid)}"
          style="font-size:0.78rem;padding:3px 10px;margin-left:4px">
          ${r.checkCleared ? "Unmark Cleared" : "Mark Cleared"}
        </button>`
      : "";
    return `<tr class="${isChecked ? "payroll-row-selected" : ""}">
      <td style="text-align:center;padding:4px 8px">
        <input type="checkbox" class="payroll-row-cb" data-key="${esc(rowKey)}"${isChecked ? " checked" : ""} style="cursor:pointer" />
      </td>
      <td>${esc(r.umpireName)}</td>
      <td>${esc(fmtDate(r.date))}</td>
      <td>${esc(r.city)}<br><span style="font-size:0.82rem;color:var(--light-text)">${esc(r.division)}</span></td>
      <td style="font-size:0.85rem;color:var(--light-text)">${esc(r.field || "—")}</td>
      <td><span class="badge badge-${(r.slotType||"").toLowerCase()}">${esc(r.slotType)}</span></td>
      <td style="text-align:center">${checkedInCell}</td>
      <td>$${r.pay.toFixed(2)}</td>
      <td style="white-space:nowrap">${paidBadge}${toggleBtn}${clearedBtn}</td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll(".payroll-cleared-btn").forEach(btn => {
    btn.addEventListener("click", () =>
      toggleCleared(btn.dataset.gameId, btn.dataset.slotType, btn.dataset.uid));
  });

  tbody.querySelectorAll(".payroll-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const row = payrollRows.find(r =>
        r.gameId === btn.dataset.gameId && r.slotType === btn.dataset.slotType && r.uid === btn.dataset.uid
      );
      if (row?.paid) {
        togglePaid(btn.dataset.gameId, btn.dataset.slotType, btn.dataset.uid);
      } else {
        openPayModal(btn.dataset.gameId, btn.dataset.slotType, btn.dataset.uid);
      }
    });
  });

  // ── Checkboxes ──
  tbody.querySelectorAll(".payroll-row-cb").forEach(cb => {
    cb.addEventListener("change", () => {
      if (cb.checked) selectedRowKeys.add(cb.dataset.key);
      else selectedRowKeys.delete(cb.dataset.key);
      cb.closest("tr")?.classList.toggle("payroll-row-selected", cb.checked);
      syncSelectAllCheckbox();
      updateBulkPrintBtn();
    });
  });

  // Select-All checkbox
  const selectAll = document.getElementById("payrollSelectAll");
  if (selectAll) {
    selectAll.addEventListener("change", () => {
      const cbs = tbody.querySelectorAll(".payroll-row-cb");
      cbs.forEach(cb => {
        cb.checked = selectAll.checked;
        if (selectAll.checked) selectedRowKeys.add(cb.dataset.key);
        else selectedRowKeys.delete(cb.dataset.key);
        cb.closest("tr")?.classList.toggle("payroll-row-selected", selectAll.checked);
      });
      updateBulkPrintBtn();
    });
  }
  syncSelectAllCheckbox();
  updateBulkPrintBtn();
}

function syncSelectAllCheckbox() {
  const selectAll = document.getElementById("payrollSelectAll");
  if (!selectAll) return;
  const cbs = [...document.querySelectorAll("#payrollBody .payroll-row-cb")];
  if (!cbs.length) { selectAll.checked = false; selectAll.indeterminate = false; return; }
  const checkedCount = cbs.filter(c => c.checked).length;
  selectAll.checked       = checkedCount === cbs.length;
  selectAll.indeterminate = checkedCount > 0 && checkedCount < cbs.length;
}

function updateBulkPrintBtn() {
  const btn = document.getElementById("bulkPrintSelectedBtn");
  if (!btn) return;
  const n = selectedRowKeys.size;
  btn.textContent = n > 0 ? `🖨 Print Selected (${n})` : "🖨 Print Selected";
  btn.disabled    = n === 0;
  btn.style.opacity = n === 0 ? "0.45" : "";
}

async function togglePaid(gameId, slotType, uid, checkNumber = "") {
  const ref = doc(db, "games", gameId);
  try {
    let newPaid;
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const slots = (snap.data().umpireSlots ?? []).map(s => {
        if (s.type === slotType && s.assignedUid === uid) {
          newPaid = !s.paid;
          const updated = { ...s, paid: newPaid };
          if (newPaid) {
            updated.paidDate = todayISO();
            if (checkNumber) updated.checkNumber = checkNumber; else delete updated.checkNumber;
          } else {
            delete updated.checkNumber;
            delete updated.checkCleared;
            delete updated.paidDate;
          }
          return updated;
        }
        return s;
      });
      tx.update(ref, { umpireSlots: slots });
    });
    if (newPaid !== undefined) {
      const row = payrollRows.find(r => r.gameId === gameId && r.slotType === slotType && r.uid === uid);
      if (row) { row.paid = newPaid; row.checkNumber = newPaid ? checkNumber : ""; row.paidDate = newPaid ? todayISO() : ""; if (!newPaid) row.checkCleared = false; }
      renderAll();
    }
  } catch (err) {
    console.error(err);
    showToast("Error updating paid status.");
  }
}

async function toggleCleared(gameId, slotType, uid) {
  const ref = doc(db, "games", gameId);
  try {
    let newCleared;
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const slots = (snap.data().umpireSlots ?? []).map(s => {
        if (s.type === slotType && s.assignedUid === uid && s.paid) {
          newCleared = !s.checkCleared;
          const updated = { ...s, checkCleared: newCleared };
          if (!newCleared) delete updated.checkCleared;
          return updated;
        }
        return s;
      });
      tx.update(ref, { umpireSlots: slots });
    });
    if (newCleared !== undefined) {
      const row = payrollRows.find(r => r.gameId === gameId && r.slotType === slotType && r.uid === uid);
      if (row) row.checkCleared = newCleared;
      renderAll();
    }
  } catch (err) {
    console.error(err);
    showToast("Error updating cleared status.");
  }
}

// ── Cut Payment modal ─────────────────────────────────────────────────────────

let _cpUid      = "";
let _cpRows     = [];       // all unpaid non-noShow rows for this umpire
let _cpSelected = new Set();// rowKeys selected for this payment

function openCutPaymentModal(uid) {
  _cpUid  = uid;
  _cpRows = filteredRows().filter(r => r.uid === uid && !r.noShow && !r.paid);

  if (!_cpRows.length) { showToast("No unpaid games for this umpire in the current date range."); return; }

  // Pre-select checked-in games
  _cpSelected = new Set(_cpRows.filter(r => r.checkedIn).map(cpRowKey));

  const modal   = document.getElementById("cutPaymentModal");
  const nameEl  = document.getElementById("cpUmpireName");
  const checkEl = document.getElementById("cpCheckNumber");
  const msgEl   = document.getElementById("cpMsg");
  if (!modal) return;

  nameEl.textContent = _cpRows[0]?.umpireName || "";
  checkEl.value      = "";
  if (msgEl) { msgEl.textContent = ""; msgEl.className = "signup-message"; }

  renderCutPayList();
  modal.style.display = "";
  checkEl.focus();
}

function cpRowKey(r) { return `${r.gameId}|${r.slotType}|${r.uid}`; }

function renderCutPayList() {
  const wrap    = document.getElementById("cpGameList");
  const totalEl = document.getElementById("cpSelectedTotal");
  if (!wrap) return;

  const sorted = _cpRows.slice().sort((a, b) => a.date < b.date ? -1 : 1);

  wrap.innerHTML = sorted.map(r => {
    const key       = cpRowKey(r);
    const checked   = _cpSelected.has(key);
    const statusTag = r.checkedIn
      ? `<span style="color:#6fcf97;font-size:0.8rem">✅ Checked In</span>`
      : `<span style="color:#aaa;font-size:0.8rem">Assigned</span>`;
    return `<label style="display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:6px;cursor:pointer;
              background:${checked ? "rgba(96,25,41,0.18)" : "transparent"};
              border:1px solid ${checked ? "rgba(96,25,41,0.4)" : "#333"};margin-bottom:6px">
      <input type="checkbox" class="cp-game-cb" data-key="${esc(key)}"${checked ? " checked" : ""}
        style="flex-shrink:0;width:16px;height:16px;cursor:pointer" />
      <div style="flex:1;min-width:0">
        <div style="font-size:0.88rem;font-weight:600">${esc(fmtDate(r.date))}
          <span class="badge badge-${(r.slotType||"").toLowerCase()}" style="font-size:0.7rem;margin-left:4px">${esc(r.slotType)}</span>
        </div>
        <div style="font-size:0.78rem;color:var(--light-text)">${esc(r.city || "—")} · ${esc(r.division || "—")}${r.field ? " · " + esc(r.field) : ""}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-weight:600;font-size:0.9rem">$${r.pay.toFixed(2)}</div>
        <div>${statusTag}</div>
      </div>
    </label>`;
  }).join("");

  wrap.querySelectorAll(".cp-game-cb").forEach(cb => {
    cb.addEventListener("change", () => {
      if (cb.checked) _cpSelected.add(cb.dataset.key);
      else _cpSelected.delete(cb.dataset.key);
      // Update row background
      cb.closest("label").style.background = cb.checked ? "rgba(96,25,41,0.18)" : "transparent";
      cb.closest("label").style.border     = `1px solid ${cb.checked ? "rgba(96,25,41,0.4)" : "#333"}`;
      updateCpTotal();
    });
  });

  updateCpTotal();
}

function updateCpTotal() {
  const totalEl = document.getElementById("cpSelectedTotal");
  const saveBtn = document.getElementById("cpSaveBtn");
  const selectedRows = _cpRows.filter(r => _cpSelected.has(cpRowKey(r)));
  const total = selectedRows.reduce((s, r) => s + r.pay, 0);
  const n     = selectedRows.length;
  if (totalEl) totalEl.textContent = n === 0
    ? "No games selected"
    : `${n} game${n !== 1 ? "s" : ""} selected · $${total.toFixed(2)}`;
  if (saveBtn) saveBtn.disabled = n === 0;
}

function closeCutPaymentModal() {
  document.getElementById("cutPaymentModal").style.display = "none";
  _cpUid = ""; _cpRows = []; _cpSelected = new Set();
}

async function saveCutPayment() {
  const checkNumber = (document.getElementById("cpCheckNumber")?.value || "").trim();
  const toMark      = _cpRows.filter(r => _cpSelected.has(cpRowKey(r)));
  if (!toMark.length) return;

  const saveBtn = document.getElementById("cpSaveBtn");
  const msgEl   = document.getElementById("cpMsg");
  saveBtn.disabled = true;
  if (msgEl) { msgEl.textContent = "Saving…"; msgEl.className = "signup-message info"; }

  try {
    // Mark each selected slot as paid in a single batch
    const batch = writeBatch(db);
    for (const r of toMark) {
      const gameRef  = doc(db, "games", r.gameId);
      const gameSnap = await getDoc(gameRef);
      if (!gameSnap.exists()) continue;
      const slots = (gameSnap.data().umpireSlots || []).map(s => {
        if (s.type === r.slotType && s.assignedUid === r.uid) {
          const u = { ...s, paid: true, paidDate: todayISO() };
          if (checkNumber) u.checkNumber = checkNumber; else delete u.checkNumber;
          return u;
        }
        return s;
      });
      batch.update(gameRef, { umpireSlots: slots });
      // Update local cache
      r.paid = true;
      r.checkNumber = checkNumber;
      r.paidDate = todayISO();
    }
    await batch.commit();

    // Re-render the summary/table
    renderAll();

    // Print the stub immediately
    const org = await getOrgSettings();
    const allUmpireRows = filteredRows().filter(r2 => r2.uid === _cpUid && !r2.noShow);
    closeCutPaymentModal();
    openStubWindow([{ name: allUmpireRows[0]?.umpireName || "", rows: allUmpireRows }], org);
  } catch (err) {
    if (msgEl) { msgEl.textContent = "Error: " + err.message; msgEl.className = "signup-message error"; }
    saveBtn.disabled = false;
  }
}

function wireCutPaymentModal() {
  document.getElementById("cpSaveBtn")?.addEventListener("click", saveCutPayment);
  document.getElementById("cpCancelBtn")?.addEventListener("click", closeCutPaymentModal);
  document.getElementById("cpCheckNumber")?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); saveCutPayment(); }
    if (e.key === "Escape") { e.preventDefault(); closeCutPaymentModal(); }
  });
  document.getElementById("cutPaymentModal")?.addEventListener("click", e => {
    if (e.target === e.currentTarget) closeCutPaymentModal();
  });
}

// ── Pay stub ──────────────────────────────────────────────────────────────────

/** Shared CSS for stub pages (brand colour injected). */
function stubStyles(brand) {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px; color: #111; background: #fff;
      padding: 32px 40px; max-width: 760px; margin: 0 auto;
    }
    .stub-page { page-break-after: always; padding-bottom: 32px; margin-bottom: 32px; border-bottom: 2px dashed #ccc; }
    .stub-page:last-child { page-break-after: auto; border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
    .stub-header {
      display: flex; justify-content: space-between; align-items: flex-start;
      border-bottom: 3px solid ${brand}; padding-bottom: 14px; margin-bottom: 20px;
    }
    .org-name { font-size: 20px; font-weight: 700; color: ${brand}; line-height: 1.2; }
    .org-sub  { font-size: 12px; color: #555; margin-top: 3px; }
    .stub-meta { text-align: right; font-size: 12px; color: #555; }
    .stub-meta strong { color: #111; }
    .stub-info {
      display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px;
      background: #f7f0f1; border: 1px solid #d9b8bb; border-radius: 6px;
      padding: 14px 18px; margin-bottom: 20px;
    }
    .stub-info-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: ${brand}; margin-bottom: 3px; }
    .stub-info-value { font-size: 14px; font-weight: 600; color: #111; }
    .rate-note { font-size: 11px; color: #555; margin-bottom: 16px; }
    .rate-note strong { color: #111; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12.5px; }
    thead th { background: ${brand}; color: #fff; text-align: left; padding: 7px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
    thead th.money { text-align: right; }
    tbody tr:nth-child(even) { background: #faf5f6; }
    tbody td { padding: 7px 10px; border-bottom: 1px solid #e8dde0; vertical-align: middle; }
    td.money  { text-align: right; font-variant-numeric: tabular-nums; }
    td.paid   { color: #1a6b30; font-weight: 600; }
    td.unpaid { color: #8a4a00; font-weight: 600; }
    .totals { width: 260px; margin-left: auto; border: 1px solid #d9b8bb; border-radius: 6px; overflow: hidden; margin-bottom: 24px; }
    .totals-row { display: flex; justify-content: space-between; padding: 7px 14px; font-size: 13px; border-bottom: 1px solid #ead8da; }
    .totals-row:last-child { border-bottom: none; }
    .totals-row.total-owed { background: #f7f0f1; }
    .totals-row.total-paid { background: #f0f7f2; color: #1a6b30; }
    .totals-label  { font-weight: 500; }
    .totals-amount { font-variant-numeric: tabular-nums; }
    .stub-footer { border-top: 1px solid #ddd; padding-top: 12px; font-size: 11px; color: #777; line-height: 1.5; }
    .print-bar { text-align: center; margin-bottom: 24px; }
    .print-bar button {
      background: ${brand}; color: #fff; border: none; border-radius: 6px;
      padding: 9px 24px; font-size: 14px; cursor: pointer; font-family: inherit;
    }
    .print-bar button:hover { filter: brightness(0.85); }
    @media print {
      body { padding: 16px; }
      .print-bar { display: none; }
      .stub-page { border-bottom: none; padding-bottom: 0; margin-bottom: 0; }
      @page { margin: 1.5cm; }
    }`;
}

/** Build the inner HTML fragment for one umpire's stub (no html/head/body tags). */
function buildStubFragment(name, rows, org, periodFrom, periodTo, rateTable) {
  const today   = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const owed    = rows.reduce((s, r) => s + r.pay, 0);
  const paid    = rows.filter(r => r.paid).reduce((s, r) => s + r.pay, 0);
  const balance = owed - paid;

  const gameRows = rows
    .slice()
    .sort((a, b) => a.date < b.date ? -1 : 1)
    .map(r => `
      <tr>
        <td>${fmtDate(r.date)}</td>
        <td>${esc(r.division) || "—"}</td>
        <td>${esc(r.city) || "—"}</td>
        <td>${esc(r.field) || "—"}</td>
        <td>${esc(r.slotType)}</td>
        <td class="money">$${r.pay.toFixed(2)}</td>
        <td class="${r.paid ? "paid" : "unpaid"}">${r.paid ? (r.checkCleared ? "✓ Cleared" : "Paid") : "Unpaid"}${r.paid && r.checkNumber ? `<br><span style="font-size:0.75em;font-weight:normal">#${esc(r.checkNumber)}</span>` : ""}</td>
      </tr>`).join("");

  const balColor = balance > 0 ? "#8a4a00" : "#1a6b30";
  const balBg    = balance > 0 ? "#fff8ee" : "#f0f7f2";

  return `
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
  <div class="stub-info">
    <div><div class="stub-info-label">Umpire</div><div class="stub-info-value">${esc(name)}</div></div>
    <div><div class="stub-info-label">Pay Period</div><div class="stub-info-value">${periodFrom === periodTo ? periodFrom : periodFrom + " – " + periodTo}</div></div>
    <div><div class="stub-info-label">Games Worked</div><div class="stub-info-value">${rows.length}</div></div>
    <div><div class="stub-info-label">Statement Date</div><div class="stub-info-value">${today}</div></div>
  </div>
  ${rateTable ? `<div class="rate-note"><strong>Pay rates:</strong> ${rateTable}</div>` : ""}
  <table>
    <thead><tr>
      <th>Date</th><th>Division</th><th>City</th><th>Field</th><th>Position</th>
      <th class="money">Rate</th><th>Status</th>
    </tr></thead>
    <tbody>${gameRows}</tbody>
  </table>
  <div class="totals">
    <div class="totals-row total-owed"><span class="totals-label">Total Earned</span><span class="totals-amount">$${owed.toFixed(2)}</span></div>
    <div class="totals-row total-paid"><span class="totals-label">Amount Paid</span><span class="totals-amount">$${paid.toFixed(2)}</span></div>
    <div class="totals-row" style="background:${balBg};font-weight:700;color:${balColor}">
      <span class="totals-label">${balance > 0 ? "Balance Due" : "Fully Paid"}</span>
      <span class="totals-amount">$${balance.toFixed(2)}</span>
    </div>
  </div>
  <div class="stub-footer">
    <p>This document is a payment record for officiating services rendered to ${esc(org.assocName || "")}. It is not a tax document. Please retain for your records.</p>
    <p style="margin-top:4px">Questions? Contact ${esc(org.coordinatorName || "")} at ${esc(org.coordinatorPhone || "")} or post in the Umpire Slack channel.</p>
  </div>`;
}

/** Open a print window with one or more stubs (one per umpire). */
function openStubWindow(umpireGroups, org) {
  const brand = org.accentColor || "#601929";
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const periodFrom = payrollFromFilter
    ? new Date(payrollFromFilter + "T12:00:00").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : "All time";
  const periodTo = payrollToFilter
    ? new Date(payrollToFilter + "T12:00:00").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : today;
  const rateTable = [
    payRates.plate ? `Plate Umpire: $${payRates.plate.toFixed(2)}` : null,
    payRates.field ? `Field Umpire: $${payRates.field.toFixed(2)}` : null,
    payRates.extra ? `Extra: $${payRates.extra.toFixed(2)}` : null,
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");

  const titleNames = umpireGroups.map(g => g.name).join(", ");
  const stubs = umpireGroups.map(({ name, rows }) =>
    `<div class="stub-page">${buildStubFragment(name, rows, org, periodFrom, periodTo, rateTable)}</div>`
  ).join("\n");

  const count = umpireGroups.length;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pay Stub${count > 1 ? "s" : ""} — ${esc(titleNames)}</title>
  <style>${stubStyles(brand)}</style>
</head>
<body>
  <div class="print-bar">
    <button onclick="window.print()">🖨 Print / Save as PDF${count > 1 ? ` (${count} stubs)` : ""}</button>
  </div>
  ${stubs}
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  // Blob URLs don't inherit the parent page's CSP, so the inline onclick in the HTML works.
  // Revoke after a short delay to ensure the browser has loaded the content.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function generatePayStub(uid) {
  const rows = filteredRows().filter(r => r.uid === uid && !r.noShow);
  if (!rows.length) return;
  const org = await getOrgSettings();
  openStubWindow([{ name: rows[0].umpireName, rows }], org);
}

/** Print stubs for all umpires visible in the current date filter. */
async function bulkPrintAll() {
  const billable = filteredRows(true).filter(r => !r.noShow);
  if (!billable.length) { showToast("No billable rows in the current date range."); return; }
  const byUmpire = new Map();
  billable.forEach(r => {
    if (!byUmpire.has(r.uid)) byUmpire.set(r.uid, { name: r.umpireName, rows: [] });
    byUmpire.get(r.uid).rows.push(r);
  });
  const groups = [...byUmpire.values()].sort((a, b) => a.name.localeCompare(b.name));
  const org = await getOrgSettings();
  openStubWindow(groups, org);
}

/** Print stubs only for checked rows, grouped by umpire. */
async function bulkPrintSelected() {
  if (!selectedRowKeys.size) { showToast("No rows selected."); return; }
  const selected = filteredRows().filter(r => !r.noShow && selectedRowKeys.has(`${r.gameId}|${r.slotType}|${r.uid}`));
  if (!selected.length) { showToast("No billable rows among the selection."); return; }
  const byUmpire = new Map();
  selected.forEach(r => {
    if (!byUmpire.has(r.uid)) byUmpire.set(r.uid, { name: r.umpireName, rows: [] });
    byUmpire.get(r.uid).rows.push(r);
  });
  const groups = [...byUmpire.values()].sort((a, b) => a.name.localeCompare(b.name));
  const org = await getOrgSettings();
  openStubWindow(groups, org);
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

// ── Check Register ────────────────────────────────────────────────────────────

function buildCheckGroups() {
  let paid = payrollRows.filter(r => r.paid && !r.noShow);
  if (payrollFromFilter) paid = paid.filter(r => (r.paidDate || r.date) >= payrollFromFilter);
  if (payrollToFilter)   paid = paid.filter(r => (r.paidDate || r.date) <= payrollToFilter);

  const groups = new Map();
  paid.forEach(r => {
    const key = r.checkNumber
      ? `${r.uid}|check|${r.checkNumber}`
      : `${r.uid}|cash|${r.paidDate || r.date}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        checkNumber:  r.checkNumber || "",
        paymentType:  r.checkNumber ? "Check" : "Cash",
        umpireName:   r.umpireName,
        uid:          r.uid,
        paidDate:     r.paidDate || r.date || "",
        divisions:    new Set(),
        amount:       0,
        rows:         [],
        allCleared:   true,
      });
    }
    const g = groups.get(key);
    g.amount += r.pay;
    g.divisions.add(r.division || "—");
    g.rows.push(r);
    if (!r.checkCleared) g.allCleared = false;
  });

  return [...groups.values()].sort((a, b) =>
    (b.paidDate || "").localeCompare(a.paidDate || "") ||
    a.umpireName.localeCompare(b.umpireName)
  );
}

function showPayrollTab(tab) {
  activePayrollTab = tab;
  ["detail", "checks"].forEach(t => {
    const panel = document.getElementById(`payroll-tab-${t}`);
    if (panel) panel.style.display = t === tab ? "" : "none";
    document.querySelector(`[data-payroll-tab="${t}"]`)?.classList.toggle("active", t === tab);
  });
  if (tab === "checks") renderCheckRegister();
}

function renderCheckRegister() {
  const wrap = document.getElementById("checkRegisterWrap");
  if (!wrap) return;

  let groups = buildCheckGroups();

  if (checkRegisterFilter === "outstanding") groups = groups.filter(g => !g.allCleared && g.paymentType === "Check");
  if (checkRegisterFilter === "cleared")     groups = groups.filter(g => g.allCleared || g.paymentType === "Cash");

  document.querySelectorAll("[data-check-filter]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.checkFilter === checkRegisterFilter);
  });

  if (!groups.length) {
    wrap.innerHTML = `<p style="color:var(--light-text)">No payments for the selected period.</p>`;
    return;
  }

  const totalAmount  = groups.reduce((s, g) => s + g.amount, 0);
  const checkCount   = groups.filter(g => g.paymentType === "Check").length;
  const clearedCount = groups.filter(g => g.allCleared || g.paymentType === "Cash").length;

  const rows = groups.flatMap(g => {
    const isCash = g.paymentType === "Cash";
    const statusBadge = isCash
      ? `<span class="badge" style="background:#17351f;color:#b8f2c4">Cash / Paid</span>`
      : g.allCleared
        ? `<span class="badge" style="background:#0d3030;color:#7ef7d8">✓ Cleared</span>`
        : `<span class="badge" style="background:#4a2c00;color:#ffcc80">Outstanding</span>`;
    const clearedBtn = !isCash
      ? `<button class="btn print-btn check-toggle-cleared-btn" data-group-key="${esc(g.key)}"
          style="font-size:0.78rem;padding:3px 8px;margin-left:4px">
          ${g.allCleared ? "Unmark" : "Mark Cleared"}
        </button>`
      : "";

    // Header row for this check
    const headerRow = `<tr style="background:rgba(255,255,255,0.04);border-top:2px solid #444">
      <td style="white-space:nowrap;font-weight:600">${esc(fmtDate(g.paidDate))}</td>
      <td style="font-weight:600">${g.checkNumber ? `#${esc(g.checkNumber)}` : '<span style="color:var(--light-text);font-weight:normal">Cash</span>'}</td>
      <td style="font-size:0.85rem">${esc(g.paymentType)}</td>
      <td style="font-weight:600">${esc(g.umpireName)}</td>
      <td></td>
      <td></td>
      <td style="text-align:right;font-weight:600">$${g.amount.toFixed(2)}</td>
      <td style="white-space:nowrap">${statusBadge}${clearedBtn}</td>
    </tr>`;

    // One sub-row per game
    const gameRows = g.rows
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(r => `<tr style="background:rgba(0,0,0,0.15)">
        <td style="padding-left:28px;font-size:0.83rem;color:var(--light-text)">${esc(fmtDate(r.date))}</td>
        <td></td>
        <td></td>
        <td style="font-size:0.83rem;color:var(--light-text)">${esc(r.city || "—")}</td>
        <td style="font-size:0.83rem;color:var(--light-text)">${esc(r.division || "—")}</td>
        <td style="text-align:center">
          <span class="badge badge-${(r.slotType||"").toLowerCase()}" style="font-size:0.72rem">${esc(r.slotType)}</span>
        </td>
        <td style="text-align:right;font-size:0.83rem">$${r.pay.toFixed(2)}</td>
        <td></td>
      </tr>`).join("");

    return headerRow + gameRows;
  });

  wrap.innerHTML = `
    <p style="font-size:0.88rem;color:var(--light-text);margin:0 0 12px">
      ${groups.length} payment${groups.length !== 1 ? "s" : ""} &nbsp;·&nbsp;
      ${checkCount} check${checkCount !== 1 ? "s" : ""} &nbsp;·&nbsp;
      Total: <strong style="color:var(--text)">$${totalAmount.toFixed(2)}</strong> &nbsp;·&nbsp;
      Cleared: <strong style="color:#6fcf97">${clearedCount}</strong> of ${groups.length}
    </p>
    <div style="overflow-x:auto">
      <table class="payroll-table" style="width:100%;min-width:680px">
        <thead>
          <tr>
            <th>Date Cut</th>
            <th>Check #</th>
            <th>Type</th>
            <th>Umpire / City</th>
            <th>Division</th>
            <th style="text-align:center">Slot</th>
            <th style="text-align:right">Amount</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>
    <p style="font-size:0.78rem;color:var(--light-text);margin-top:8px">Use QuickBooks (.iif) export for QB Desktop; CSV export for QB Online or other accounting software.</p>`;

  wrap.querySelectorAll(".check-toggle-cleared-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleGroupCleared(btn.dataset.groupKey));
  });
}

async function toggleGroupCleared(groupKey) {
  const groups = buildCheckGroups();
  const g = groups.find(x => x.key === groupKey);
  if (!g) return;

  const newCleared = !g.allCleared;
  const byGame = {};
  g.rows.forEach(r => {
    if (!byGame[r.gameId]) byGame[r.gameId] = [];
    byGame[r.gameId].push(r);
  });

  try {
    const gameIds = Object.keys(byGame);
    const refs    = gameIds.map(id => doc(db, "games", id));
    const snaps   = await Promise.all(refs.map(ref => getDoc(ref)));

    const batch = writeBatch(db);
    snaps.forEach((snap, i) => {
      if (!snap.exists()) return;
      const gameRows = byGame[gameIds[i]];
      const slots = (snap.data().umpireSlots ?? []).map(s => {
        const match = gameRows.find(r => r.slotType === s.type && r.uid === s.assignedUid);
        if (!match) return s;
        const updated = { ...s, checkCleared: newCleared };
        if (!newCleared) delete updated.checkCleared;
        return updated;
      });
      batch.update(refs[i], { umpireSlots: slots });
    });
    await batch.commit();

    g.rows.forEach(r => { r.checkCleared = newCleared; });
    renderAll();
    renderCheckRegister();
  } catch (err) {
    console.error(err);
    showToast("Error updating cleared status.");
  }
}

function iifDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

function exportCheckRegisterCSV() {
  const groups  = buildCheckGroups();
  const headers = ["Row Type", "Date Cut", "Check Number", "Payment Type", "Umpire", "Game Date", "City", "Division", "Slot", "Amount", "Cleared"];
  const lines   = [headers.join(",")];

  groups.forEach(g => {
    const cleared = (g.allCleared || g.paymentType === "Cash") ? "Yes" : "No";
    // Summary row for the check
    lines.push([
      "Check",
      g.paidDate ? fmtDate(g.paidDate) : "",
      csvCell(g.checkNumber || ""),
      csvCell(g.paymentType),
      csvCell(g.umpireName),
      "", "", "", "",
      g.amount.toFixed(2),
      cleared,
    ].join(","));
    // One detail row per game
    g.rows.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach(r => {
      lines.push([
        "Game",
        "",
        csvCell(g.checkNumber || ""),
        "",
        csvCell(g.umpireName),
        fmtDate(r.date),
        csvCell(r.city || ""),
        csvCell(r.division || ""),
        csvCell(r.slotType),
        r.pay.toFixed(2),
        "",
      ].join(","));
    });
  });
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = `check-register-${todayISO()}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function exportCheckRegisterIIF() {
  const groups = buildCheckGroups();
  const lines  = [
    "!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR\tTOPRINT",
    "!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR",
    "!ENDTRNS",
  ];

  groups.forEach(g => {
    const date     = iifDate(g.paidDate || todayISO());
    const trnsType = g.checkNumber ? "CHECK" : "CASH";
    const divs     = [...g.divisions].join(", ");
    const memo     = `Umpire Pay - ${divs} - ${g.rows.length} game${g.rows.length !== 1 ? "s" : ""}`;
    const cleared  = (g.allCleared || g.paymentType === "Cash") ? "Y" : "N";
    const docNum   = g.checkNumber || "";

    lines.push(`TRNS\t\t${trnsType}\t${date}\tChecking\t${g.umpireName}\t-${g.amount.toFixed(2)}\t${docNum}\t${memo}\t${cleared}\tN`);
    lines.push(`SPL\t\t${trnsType}\t${date}\tUmpire Pay\t${g.umpireName}\t${g.amount.toFixed(2)}\t${docNum}\t${memo}\t${cleared}`);
    lines.push("ENDTRNS");
  });

  const blob = new Blob([lines.join("\r\n")], { type: "text/plain;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = `umpire-checks-${todayISO()}.iif`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── CSV export ────────────────────────────────────────────────────────────────

// Wrap a value in double-quotes and escape any embedded double-quotes (RFC 4180).
function csvCell(v) { return `"${String(v || "").replace(/"/g, '""')}"`; }

function exportCSV() {
  const rows    = filteredRows();
  const headers = ["Umpire", "Date", "City", "Division", "Field", "Slot", "Pay", "Paid", "Check #", "Cleared", "No Show"];
  const lines   = [
    headers.join(","),
    ...rows.map(r => [
      csvCell(r.umpireName),
      fmtDate(r.date),
      csvCell(r.city),
      csvCell(r.division),
      csvCell(r.field),
      r.slotType,
      r.noShow ? "0.00" : r.pay.toFixed(2),
      r.noShow ? "N/A" : (r.paid ? "Yes" : "No"),
      r.noShow ? "" : csvCell(r.checkNumber || ""),
      r.noShow ? "" : (r.paid && r.checkCleared ? "Yes" : "No"),
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
  document.getElementById("bulkPrintAllBtn")?.addEventListener("click", bulkPrintAll);
  document.getElementById("bulkPrintSelectedBtn")?.addEventListener("click", bulkPrintSelected);
  document.getElementById("exportCheckCsvBtn")?.addEventListener("click", exportCheckRegisterCSV);
  document.getElementById("exportCheckIIFBtn")?.addEventListener("click", exportCheckRegisterIIF);
  document.getElementById("payrollTabNav")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-payroll-tab]");
    if (btn) showPayrollTab(btn.dataset.payrollTab);
  });
  document.getElementById("payroll-tab-checks")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-check-filter]");
    if (!btn) return;
    checkRegisterFilter = btn.dataset.checkFilter;
    renderCheckRegister();
  });
  wireCutPaymentModal();
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

  wirePayModal();
  wireFilters();
  loadPayroll();
});
