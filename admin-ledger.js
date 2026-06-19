// admin-ledger.js — Organizational ledger: expenses, coach pay, budget vs. actuals
import { db } from "./firebase.js";
import { authReadyPromise, isAdmin, getCurrentUser } from "./auth.js";
import { getOrgSettings } from "./org.js";
import { esc, fmtDate, todayISO, setMsg, showToast, showConfirm } from "./utils.js";

import {
  collection, getDocs, getDoc, addDoc, deleteDoc, doc, updateDoc, setDoc,
  query, orderBy, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── State ─────────────────────────────────────────────────────────────────────

let ledgerExpenses    = [];
let coachPayRecords   = [];
let budgets           = [];
let expenseCategories = [];
let coachPayRates     = { head: { base: 0, perYear: 0 }, assistant: { base: 0, perYear: 0 } };
let teamsData         = [];   // from config/teamCalendars
let allGames          = [];   // game docs for computing umpire pay
let umpirePayRows     = [];   // virtual expense rows derived from paid umpire slots
let payRatesConfig    = { plate: 0, field: 0, extra: 0, divisionRates: {} };
let seasonFilter      = "";
let teamFilter        = "";
let activeTab         = "summary";

// ── Helpers ───────────────────────────────────────────────────────────────────

function csvCell(v) { return `"${String(v ?? "").replace(/"/g, '""')}"`; }

function slugify(label) { return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); }

function categoryLabel(catId) {
  if (catId === "umpire_pay") return "Umpire Pay";
  if (catId === "coach_pay")  return "Coach Pay";
  const found = expenseCategories.find(c => c.id === catId);
  return found ? found.label : catId;
}

function computeUmpirePayRows() {
  umpirePayRows = [];
  allGames.forEach(g => {
    if (g.cancelled) return;
    (g.umpireSlots ?? []).forEach(slot => {
      if (!slot.paid || !slot.assignedUid) return;
      const paidDate = slot.paidDate || g.date || "";
      const season   = paidDate ? String(new Date(paidDate.replace(/-/g, "/")).getFullYear()) : "";
      const division = g.division || "";
      const city     = g.city || "";
      const configRate = payRatesConfig[slot.type?.toLowerCase()] ?? 0;
      const amount     = Number(slot.payRate ?? configRate);
      umpirePayRows.push({
        id:           `__umpire__${g.id}|${slot.type}|${slot.assignedUid}`,
        source:       "payroll",
        date:         paidDate,
        season,
        teamName:     division,
        division,
        category:     "umpire_pay",
        description:  `${slot.assignedName || slot.assignedUid} — ${slot.type || ""}${city ? " · " + city : ""}${g.date ? " (" + g.date + ")" : ""}`,
        amount,
        paid:         true,
        checkNumber:  slot.checkNumber || "",
        checkCleared: slot.checkCleared === true,
      });
    });
  });
}

function calcCoachPay(role, yearsOfService, paymentType) {
  if (paymentType === "parentVolunteer" || paymentType === "nonParentVolunteer") return 0;
  const rates = coachPayRates[role] ?? { base: 0, perYear: 0 };
  return rates.base + rates.perYear * (yearsOfService ?? 0);
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadAll() {
  try {
    const [
      expSnap, coachPaySnap, budgetsSnap, expCfgSnap, coachRatesSnap, teamCalSnap, orgSnap, gamesSnap, payRatesSnap,
    ] = await Promise.all([
      getDocs(query(collection(db, "ledgerExpenses"), orderBy("date", "asc"))),
      getDocs(query(collection(db, "coachPay"), orderBy("coachName", "asc"))),
      getDoc(doc(db, "config", "ledgerBudgets")),
      getDoc(doc(db, "config", "expenseConfig")),
      getDoc(doc(db, "config", "coachPayRates")),
      getDoc(doc(db, "config", "teamCalendars")),
      getDoc(doc(db, "config", "orgSettings")),
      getDocs(query(collection(db, "games"), orderBy("date", "asc"))),
      getDoc(doc(db, "config", "payRates")),
    ]);

    ledgerExpenses  = expSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    coachPayRecords = coachPaySnap.docs.map(d => ({ id: d.id, ...d.data() }));
    budgets         = budgetsSnap.exists() ? (budgetsSnap.data().budgets || []) : [];

    expenseCategories = expCfgSnap.exists()
      ? (expCfgSnap.data().categories || [])
      : [];

    if (coachRatesSnap.exists()) {
      const d = coachRatesSnap.data();
      coachPayRates = {
        head:      { base: Number(d.head?.base ?? 0),      perYear: Number(d.head?.perYear ?? 0) },
        assistant: { base: Number(d.assistant?.base ?? 0), perYear: Number(d.assistant?.perYear ?? 0) },
      };
    }

    teamsData = teamCalSnap.exists() ? (teamCalSnap.data().teams || []) : [];
    if (payRatesSnap.exists()) {
      const pr = payRatesSnap.data();
      payRatesConfig = {
        plate: Number(pr.plate ?? 0),
        field: Number(pr.field ?? 0),
        extra: Number(pr.extra ?? 0),
        divisionRates: pr.divisionRates || {},
      };
    }
    allGames  = gamesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    computeUmpirePayRows();

    // Derive current season from orgSettings.seasonStart
    const org = orgSnap.exists() ? orgSnap.data() : {};
    const currentSeason = org.seasonStart ? String(new Date(org.seasonStart).getFullYear()) : String(new Date().getFullYear());

    populateSeasonFilter(currentSeason);
    populateTeamFilter();
    populateExpenseTeamSelect();
    populateBudgetTeamSelect();
    populateExpenseCategorySelects();

    renderActiveTab();
  } catch (err) {
    console.error(err);
    showToast("Error loading ledger data: " + err.message);
  }
}

// ── Season dropdown ───────────────────────────────────────────────────────────

function populateSeasonFilter(currentSeason) {
  const sel = document.getElementById("ledgerSeasonFilter");
  if (!sel) return;

  const seasons = new Set([currentSeason]);
  ledgerExpenses.forEach(e => { if (e.season) seasons.add(e.season); });
  coachPayRecords.forEach(c => { if (c.season) seasons.add(c.season); });
  budgets.forEach(b => { if (b.season) seasons.add(b.season); });
  umpirePayRows.forEach(r => { if (r.season) seasons.add(r.season); });

  const sorted = [...seasons].sort((a, b) => b.localeCompare(a));

  // Default to the most recent season that has any data; fall back to currentSeason
  const defaultSeason = sorted[0] || currentSeason;

  sel.innerHTML = '<option value="">All seasons</option>' +
    sorted.map(s => `<option value="${esc(s)}" ${s === defaultSeason ? "selected" : ""}>${esc(s)}</option>`).join("");

  seasonFilter = defaultSeason;
}

// ── Team dropdown ─────────────────────────────────────────────────────────────

function teamList() {
  const names = new Set();
  teamsData.forEach(t => { if (t.name) names.add(t.name); });
  ledgerExpenses.forEach(e => { if (e.teamName) names.add(e.teamName); });
  coachPayRecords.forEach(c => { if (c.teamName) names.add(c.teamName); });
  umpirePayRows.forEach(r => { if (r.teamName) names.add(r.teamName); });
  return [...names].sort((a, b) => a.localeCompare(b));
}

function populateTeamFilter() {
  const sel = document.getElementById("ledgerTeamFilter");
  if (!sel) return;
  sel.innerHTML = '<option value="">All teams</option>' +
    teamList().map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
}

function populateExpenseTeamSelect() {
  const sel = document.getElementById("expenseTeam");
  if (!sel) return;
  sel.innerHTML = '<option value="">Org-Wide</option>' +
    teamList().map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
}

function populateBudgetTeamSelect() {
  const sel = document.getElementById("budgetTeam");
  if (!sel) return;
  sel.innerHTML = '<option value="">Org-Wide</option>' +
    teamList().map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
}

function populateExpenseCategorySelects() {
  ["expenseCategory", "budgetCategory"].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '<option value="">— Select —</option>' +
      expenseCategories.map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("");
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function showTab(tab) {
  activeTab = tab;
  ["summary", "coach", "expenses"].forEach(t => {
    const panel = document.getElementById(`ledger-tab-${t}`);
    if (panel) panel.style.display = t === tab ? "" : "none";
    document.querySelector(`[data-ledger-tab="${t}"]`)
      ?.classList.toggle("active", t === tab);
  });
  renderActiveTab();
}

function renderActiveTab() {
  if (activeTab === "summary")  renderSummary();
  if (activeTab === "coach")    renderCoachPay();
  if (activeTab === "expenses") renderExpenses();
}

// ── Filter helpers ────────────────────────────────────────────────────────────

function filteredExpenses() {
  const manual = ledgerExpenses.filter(e => {
    if (seasonFilter && e.season !== seasonFilter) return false;
    if (teamFilter && e.teamName !== teamFilter)   return false;
    return true;
  });
  const umpire = umpirePayRows.filter(r => {
    if (seasonFilter && r.season !== seasonFilter) return false;
    if (teamFilter && r.teamName !== teamFilter)   return false;
    return true;
  });
  return [...manual, ...umpire].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

function filteredCoachPay() {
  return coachPayRecords.filter(c => {
    if (seasonFilter && c.season !== seasonFilter) return false;
    if (teamFilter && c.teamName !== teamFilter)   return false;
    return true;
  });
}

function filteredBudgets() {
  return budgets.filter(b => {
    if (seasonFilter && b.season !== seasonFilter) return false;
    if (teamFilter && b.teamName !== teamFilter)   return false;
    return true;
  });
}

// ── Summary tab ───────────────────────────────────────────────────────────────

function renderSummary() {
  const wrap = document.getElementById("summaryTableWrap");
  if (!wrap) return;

  const expenses  = filteredExpenses();
  const coachPays = filteredCoachPay();
  const budgetSet = filteredBudgets();

  // Build unique (teamName, category) rows from all three sources
  const keyMap = new Map(); // key → { teamName, category, budget, actual }

  function ensureKey(teamName, category) {
    const key = `${teamName}|||${category}`;
    if (!keyMap.has(key)) keyMap.set(key, { teamName, category, budget: 0, actual: 0 });
    return keyMap.get(key);
  }

  expenses.forEach(e => {
    const row = ensureKey(e.teamName || "", e.category || "");
    row.actual += Number(e.amount) || 0;
  });

  coachPays.forEach(c => {
    const row = ensureKey(c.teamName || "", "coach_pay");
    row.actual += Number(c.calculatedPay) || 0;
  });

  budgetSet.forEach(b => {
    const row = ensureKey(b.teamName || "", b.category || "");
    row.budget = Number(b.amount) || 0;
  });

  if (keyMap.size === 0) {
    wrap.innerHTML = `<p style="color:var(--light-text)">No data for the selected season/team.</p>`;
    return;
  }

  const rows = [...keyMap.values()].sort((a, b) => {
    const tn = a.teamName.localeCompare(b.teamName);
    return tn !== 0 ? tn : a.category.localeCompare(b.category);
  });

  const totalBudget  = rows.reduce((s, r) => s + r.budget, 0);
  const totalActual  = rows.reduce((s, r) => s + r.actual, 0);
  const totalVariance = totalBudget > 0 ? totalBudget - totalActual : null;

  wrap.innerHTML = `
    <div style="overflow-x:auto">
      <table class="payroll-table" style="width:100%;min-width:480px">
        <thead>
          <tr>
            <th>Team</th>
            <th>Category</th>
            <th style="text-align:right">Budgeted</th>
            <th style="text-align:right">Actual</th>
            <th style="text-align:right">Variance</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => {
            const variance = r.budget > 0 ? r.budget - r.actual : null;
            const varColor = variance === null ? "var(--light-text)" : variance >= 0 ? "#6fcf97" : "#ff8a8a";
            const varText  = variance === null ? "—" : `$${variance.toFixed(2)}`;
            const catLabel = r.category === "coach_pay" ? "Coach Pay" : categoryLabel(r.category);
            return `<tr>
              <td>${esc(r.teamName || "Org-Wide")}</td>
              <td>${esc(catLabel)}</td>
              <td style="text-align:right">${r.budget > 0 ? `$${r.budget.toFixed(2)}` : '<span style="color:var(--light-text)">—</span>'}</td>
              <td style="text-align:right">$${r.actual.toFixed(2)}</td>
              <td style="text-align:right;color:${varColor}">${varText}</td>
              <td style="white-space:nowrap">
                <button class="btn print-btn set-budget-inline-btn"
                  data-team="${esc(r.teamName)}" data-category="${esc(r.category)}"
                  data-budget="${r.budget}"
                  style="font-size:0.75rem;padding:3px 8px">✏ Budget</button>
              </td>
            </tr>`;
          }).join("")}
        </tbody>
        <tfoot>
          <tr style="font-weight:600;border-top:2px solid #555">
            <td colspan="2">Total</td>
            <td style="text-align:right">${totalBudget > 0 ? `$${totalBudget.toFixed(2)}` : "—"}</td>
            <td style="text-align:right">$${totalActual.toFixed(2)}</td>
            <td style="text-align:right;color:${totalVariance === null ? "var(--light-text)" : totalVariance >= 0 ? "#6fcf97" : "#ff8a8a"}">
              ${totalVariance === null ? "—" : `$${totalVariance.toFixed(2)}`}
            </td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>`;

  wrap.querySelectorAll(".set-budget-inline-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      openBudgetModal(btn.dataset.team, btn.dataset.category, Number(btn.dataset.budget));
    });
  });
}

// ── Coach Pay tab ─────────────────────────────────────────────────────────────

function renderCoachPay() {
  const wrap = document.getElementById("coachPayTableWrap");
  if (!wrap) return;

  const records = filteredCoachPay();
  const genBtn  = document.getElementById("generateCoachPayBtn");

  if (!records.length) {
    wrap.innerHTML = `<p style="color:var(--light-text)">No coach pay records for the selected season/team. Click <strong>⚙ Generate Records</strong> to create them.</p>`;
    if (genBtn) genBtn.style.display = "";
    return;
  }
  if (genBtn) genBtn.style.display = "";

  wrap.innerHTML = `
    <div style="overflow-x:auto">
      <table class="payroll-table" style="width:100%;min-width:700px">
        <thead>
          <tr>
            <th>Coach</th>
            <th>Team</th>
            <th>Div</th>
            <th>Role</th>
            <th>Yrs</th>
            <th>Pay Type</th>
            <th style="text-align:right">Calc. Pay</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${records.map(c => {
            const isVolunteer = c.paymentType === "parentVolunteer" || c.paymentType === "nonParentVolunteer";
            const paidBadge = c.paid
              ? c.checkCleared
                ? `<span class="badge" style="background:#0d3030;color:#7ef7d8">✓ Cleared</span>${c.checkNumber ? `<div style="font-size:0.73rem;color:var(--light-text);margin-top:2px">Check #${esc(c.checkNumber)}</div>` : ""}`
                : `<span class="badge" style="background:#17351f;color:#b8f2c4">Paid</span>${c.checkNumber ? `<div style="font-size:0.73rem;color:var(--light-text);margin-top:2px">Check #${esc(c.checkNumber)}</div>` : ""}`
              : isVolunteer
                ? `<span class="badge" style="background:#2a2a2a;color:#aaa">Volunteer</span>`
                : `<span class="badge" style="background:#4a2c00;color:#ffcc80">Unpaid</span>`;

            const payTypeOpts = [
              { v: "paid",               l: "Paid" },
              { v: "parentPaid",         l: "Parent Paid" },
              { v: "parentVolunteer",    l: "Parent Volunteer" },
              { v: "nonParentVolunteer", l: "Non-Parent Volunteer" },
            ].map(o => `<option value="${o.v}" ${c.paymentType === o.v ? "selected" : ""}>${o.l}</option>`).join("");

            const markPaidBtn = !isVolunteer && !c.paid
              ? `<button class="btn coach-mark-paid-btn" data-id="${esc(c.id)}" style="font-size:0.78rem;padding:3px 10px">Mark Paid</button>`
              : "";
            const unmarkBtn = c.paid
              ? `<button class="btn print-btn coach-unmark-btn" data-id="${esc(c.id)}" style="font-size:0.78rem;padding:3px 10px">Unmark</button>`
              : "";
            const clearedBtn = c.paid
              ? `<button class="btn print-btn coach-cleared-btn" data-id="${esc(c.id)}" style="font-size:0.78rem;padding:3px 8px">${c.checkCleared ? "Unmark Cleared" : "Mark Cleared"}</button>`
              : "";

            return `<tr>
              <td>${esc(c.coachName)}</td>
              <td style="font-size:0.85rem">${esc(c.teamName || "—")}</td>
              <td style="font-size:0.85rem">${esc(c.division || "—")}</td>
              <td style="font-size:0.85rem;text-transform:capitalize">${esc(c.role || "—")}</td>
              <td style="text-align:center">${c.yearsOfService ?? 0}</td>
              <td>
                <select class="coach-pay-type-sel" data-id="${esc(c.id)}"
                  style="padding:4px 6px;font-size:0.82rem;background:var(--field);color:var(--text);border:1px solid #555;border-radius:4px">
                  ${payTypeOpts}
                </select>
              </td>
              <td style="text-align:right">$${(c.calculatedPay ?? 0).toFixed(2)}</td>
              <td>${paidBadge}</td>
              <td style="white-space:nowrap;display:flex;gap:4px;flex-wrap:wrap">
                ${markPaidBtn}${unmarkBtn}${clearedBtn}
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;

  // Pay type change
  wrap.querySelectorAll(".coach-pay-type-sel").forEach(sel => {
    sel.addEventListener("change", () => updateCoachPayType(sel.dataset.id, sel.value));
  });

  wrap.querySelectorAll(".coach-mark-paid-btn").forEach(btn => {
    btn.addEventListener("click", () => openLedgerMarkPaidModal("coach", btn.dataset.id));
  });

  wrap.querySelectorAll(".coach-unmark-btn").forEach(btn => {
    btn.addEventListener("click", () => unmarkCoachPaid(btn.dataset.id));
  });

  wrap.querySelectorAll(".coach-cleared-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleCoachCleared(btn.dataset.id));
  });
}

async function updateCoachPayType(id, paymentType) {
  const rec = coachPayRecords.find(c => c.id === id);
  if (!rec) return;
  const isVolunteer = paymentType === "parentVolunteer" || paymentType === "nonParentVolunteer";
  const calculatedPay = isVolunteer ? 0 : calcCoachPay(rec.role, rec.yearsOfService, paymentType);
  try {
    await updateDoc(doc(db, "coachPay", id), { paymentType, calculatedPay });
    rec.paymentType   = paymentType;
    rec.calculatedPay = calculatedPay;
    renderCoachPay();
  } catch (err) {
    showToast("Error updating pay type: " + err.message);
  }
}

async function unmarkCoachPaid(id) {
  try {
    await updateDoc(doc(db, "coachPay", id), { paid: false, checkNumber: "", checkCleared: false });
    const rec = coachPayRecords.find(c => c.id === id);
    if (rec) { rec.paid = false; rec.checkNumber = ""; rec.checkCleared = false; }
    renderCoachPay();
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

async function toggleCoachCleared(id) {
  const rec = coachPayRecords.find(c => c.id === id);
  if (!rec || !rec.paid) return;
  const newCleared = !rec.checkCleared;
  try {
    await updateDoc(doc(db, "coachPay", id), { checkCleared: newCleared });
    rec.checkCleared = newCleared;
    renderCoachPay();
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

// ── Generate Coach Pay Records ────────────────────────────────────────────────

async function generateCoachPayRecords() {
  if (!seasonFilter) {
    showToast("Please select a season before generating records.");
    return;
  }

  const existing = coachPayRecords.filter(c => c.season === seasonFilter);
  if (existing.length > 0) {
    const ok = await showConfirm(`${existing.length} record(s) already exist for ${seasonFilter}. Add missing ones only?`);
    if (!ok) return;
  }

  const genBtn = document.getElementById("generateCoachPayBtn");
  if (genBtn) { genBtn.disabled = true; genBtn.textContent = "Generating…"; }

  try {
    // Load all coaches
    const coachSnap = await getDocs(query(collection(db, "coaches")));
    const coaches   = coachSnap.docs
      .map(d => ({ uid: d.id, ...d.data() }))
      .filter(c => c.active !== false);

    if (!coaches.length) {
      showToast("No active coaches found.");
      return;
    }

    // Build team membership from teamCalendars
    const coachTeamMap = new Map(); // uid → [{ teamName, division, role }]
    teamsData.forEach(team => {
      (team.coaches || []).forEach(coach => {
        if (!coach.uid) return;
        if (!coachTeamMap.has(coach.uid)) coachTeamMap.set(coach.uid, []);
        coachTeamMap.get(coach.uid).push({
          teamName: team.name || "",
          division: team.division || "",
          role:     coach.role || "assistant",
        });
      });
    });

    const existingKeys = new Set(existing.map(c => `${c.coachUid}|||${c.teamName}`));
    const uid = getCurrentUser()?.uid || "";
    const season = seasonFilter;

    const newDocs = [];
    coaches.forEach(coach => {
      const teamEntries = coachTeamMap.get(coach.uid) || [{ teamName: "", division: "", role: "assistant" }];
      teamEntries.forEach(entry => {
        const key = `${coach.uid}|||${entry.teamName}`;
        if (existingKeys.has(key)) return;
        const yearsOfService = coach.yearsOfService ?? 0;
        const paymentType    = "paid";
        const calculatedPay  = calcCoachPay(entry.role, yearsOfService, paymentType);
        newDocs.push({
          season,
          coachUid:       coach.uid,
          coachName:      coach.name || (coach.firstName + " " + coach.lastName).trim() || coach.uid,
          teamName:       entry.teamName,
          division:       entry.division,
          role:           entry.role,
          yearsOfService,
          calculatedPay,
          paymentType,
          paid:           false,
          checkNumber:    "",
          checkCleared:   false,
          notes:          "",
          createdAt:      serverTimestamp(),
          createdBy:      uid,
        });
      });
    });

    if (!newDocs.length) {
      showToast("All coach pay records already exist for this season.");
      return;
    }

    // Write in batches
    const results = await Promise.all(newDocs.map(d => addDoc(collection(db, "coachPay"), d)));
    results.forEach((ref, i) => coachPayRecords.push({ id: ref.id, ...newDocs[i], createdAt: null }));
    coachPayRecords.sort((a, b) => a.coachName.localeCompare(b.coachName));

    showToast(`✓ Created ${newDocs.length} coach pay record${newDocs.length !== 1 ? "s" : ""}.`);
    renderCoachPay();
  } catch (err) {
    console.error(err);
    showToast("Error generating records: " + err.message);
  } finally {
    if (genBtn) { genBtn.disabled = false; genBtn.textContent = "⚙ Generate Records"; }
  }
}

// ── Expenses tab ──────────────────────────────────────────────────────────────

function renderExpenses() {
  const wrap = document.getElementById("expenseTableWrap");
  if (!wrap) return;

  const expenses = filteredExpenses();

  if (!expenses.length) {
    wrap.innerHTML = `<p style="color:var(--light-text)">No expenses for the selected season/team.</p>`;
    return;
  }

  const total     = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const totalPaid = expenses.filter(e => e.paid).reduce((s, e) => s + (Number(e.amount) || 0), 0);

  wrap.innerHTML = `
    <p style="font-size:0.85rem;color:var(--light-text);margin-bottom:10px">
      ${expenses.length} expense${expenses.length !== 1 ? "s" : ""} &nbsp;·&nbsp;
      Total: <strong style="color:var(--text)">$${total.toFixed(2)}</strong> &nbsp;·&nbsp;
      Paid: <strong style="color:#6fcf97">$${totalPaid.toFixed(2)}</strong>
    </p>
    <div style="overflow-x:auto">
      <table class="payroll-table" style="width:100%;min-width:640px">
        <thead>
          <tr>
            <th>Date</th>
            <th>Team</th>
            <th>Category</th>
            <th>Description</th>
            <th style="text-align:right">Amount</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${expenses.map(e => {
            const isPayroll = e.source === "payroll";
            const paidBadge = !e.paid
              ? `<span class="badge" style="background:#4a2c00;color:#ffcc80">Unpaid</span>`
              : e.checkCleared
                ? `<span class="badge" style="background:#0d3030;color:#7ef7d8">✓ Cleared</span>${e.checkNumber ? `<div style="font-size:0.73rem;color:var(--light-text);margin-top:2px">Check #${esc(e.checkNumber)}</div>` : ""}`
                : `<span class="badge" style="background:#17351f;color:#b8f2c4">Paid</span>${e.checkNumber ? `<div style="font-size:0.73rem;color:var(--light-text);margin-top:2px">Check #${esc(e.checkNumber)}</div>` : ""}`;

            const actions = isPayroll
              ? `<a href="admin-payroll.html" style="font-size:0.78rem;color:#8ab4f8;white-space:nowrap">→ Payroll</a>`
              : (() => {
                  const editBtn     = `<button class="btn print-btn exp-edit-btn" data-id="${esc(e.id)}" style="font-size:0.78rem;padding:3px 8px">✏</button>`;
                  const deleteBtn   = `<button class="btn print-btn exp-delete-btn" data-id="${esc(e.id)}" style="font-size:0.78rem;padding:3px 8px;color:#ff8a8a;border-color:#ff8a8a">🗑</button>`;
                  const markPaidBtn = !e.paid
                    ? `<button class="btn exp-mark-paid-btn" data-id="${esc(e.id)}" style="font-size:0.78rem;padding:3px 8px">Paid</button>`
                    : `<button class="btn print-btn exp-unmark-btn" data-id="${esc(e.id)}" style="font-size:0.78rem;padding:3px 8px">Unmark</button>`;
                  const clearedBtn  = e.paid
                    ? `<button class="btn print-btn exp-cleared-btn" data-id="${esc(e.id)}" style="font-size:0.78rem;padding:3px 6px">${e.checkCleared ? "Unmark Clr" : "Cleared"}</button>`
                    : "";
                  return `${markPaidBtn}${clearedBtn}${editBtn}${deleteBtn}`;
                })();

            return `<tr>
              <td style="font-size:0.85rem;white-space:nowrap">${esc(fmtDate(e.date))}</td>
              <td style="font-size:0.85rem">${esc(e.teamName || "Org-Wide")}</td>
              <td style="font-size:0.85rem">${esc(categoryLabel(e.category))}</td>
              <td style="font-size:0.85rem">${esc(e.description || "")}</td>
              <td style="text-align:right">$${(Number(e.amount) || 0).toFixed(2)}</td>
              <td>${paidBadge}</td>
              <td style="white-space:nowrap;display:flex;gap:4px;flex-wrap:wrap;align-items:center">${actions}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;

  wrap.querySelectorAll(".exp-mark-paid-btn").forEach(btn => {
    btn.addEventListener("click", () => openLedgerMarkPaidModal("expense", btn.dataset.id));
  });
  wrap.querySelectorAll(".exp-unmark-btn").forEach(btn => {
    btn.addEventListener("click", () => unmarkExpensePaid(btn.dataset.id));
  });
  wrap.querySelectorAll(".exp-cleared-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleExpenseCleared(btn.dataset.id));
  });
  wrap.querySelectorAll(".exp-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => openExpenseModal(btn.dataset.id));
  });
  wrap.querySelectorAll(".exp-delete-btn").forEach(btn => {
    btn.addEventListener("click", () => deleteExpense(btn.dataset.id));
  });
}

async function unmarkExpensePaid(id) {
  try {
    await updateDoc(doc(db, "ledgerExpenses", id), { paid: false, checkNumber: "", checkCleared: false });
    const e = ledgerExpenses.find(x => x.id === id);
    if (e) { e.paid = false; e.checkNumber = ""; e.checkCleared = false; }
    renderActiveTab();
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

async function toggleExpenseCleared(id) {
  const e = ledgerExpenses.find(x => x.id === id);
  if (!e || !e.paid) return;
  const newCleared = !e.checkCleared;
  try {
    await updateDoc(doc(db, "ledgerExpenses", id), { checkCleared: newCleared });
    e.checkCleared = newCleared;
    renderActiveTab();
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

async function deleteExpense(id) {
  const e = ledgerExpenses.find(x => x.id === id);
  if (!e) return;
  const ok = await showConfirm(`Delete expense: ${categoryLabel(e.category)}${e.description ? " — " + e.description : ""} ($${(Number(e.amount) || 0).toFixed(2)})?`);
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "ledgerExpenses", id));
    ledgerExpenses = ledgerExpenses.filter(x => x.id !== id);
    renderActiveTab();
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

// ── Mark Paid modal (shared for coach + expense) ──────────────────────────────

let _ledgerPayModal = { type: null, id: null }; // type: "coach" | "expense"

function openLedgerMarkPaidModal(type, id) {
  _ledgerPayModal = { type, id };
  const modal = document.getElementById("ledgerMarkPaidModal");
  const input = document.getElementById("ledgerMarkPaidCheckNumber");
  const label = document.getElementById("ledgerMarkPaidContextLabel");
  if (!modal || !input || !label) return;
  input.value = "";

  if (type === "coach") {
    const rec = coachPayRecords.find(c => c.id === id);
    label.textContent = rec ? `${rec.coachName} — ${rec.teamName || "Org-Wide"} (${rec.season})` : "Mark coach as paid";
  } else {
    const e = ledgerExpenses.find(x => x.id === id);
    label.textContent = e ? `${categoryLabel(e.category)}${e.description ? " — " + e.description : ""} — $${(Number(e.amount) || 0).toFixed(2)}` : "Mark expense as paid";
  }

  modal.style.display = "";
  input.focus();
}

function closeLedgerMarkPaidModal() {
  document.getElementById("ledgerMarkPaidModal").style.display = "none";
  _ledgerPayModal = { type: null, id: null };
}

async function commitLedgerMarkPaid() {
  const checkNumber = document.getElementById("ledgerMarkPaidCheckNumber")?.value.trim() || "";
  const { type, id } = _ledgerPayModal;
  closeLedgerMarkPaidModal();
  if (!type || !id) return;

  try {
    if (type === "coach") {
      const updates = { paid: true, checkNumber: checkNumber || "" };
      await updateDoc(doc(db, "coachPay", id), updates);
      const rec = coachPayRecords.find(c => c.id === id);
      if (rec) { rec.paid = true; rec.checkNumber = checkNumber; }
      renderCoachPay();
    } else {
      const updates = { paid: true, checkNumber: checkNumber || "" };
      await updateDoc(doc(db, "ledgerExpenses", id), updates);
      const e = ledgerExpenses.find(x => x.id === id);
      if (e) { e.paid = true; e.checkNumber = checkNumber; }
      renderExpenses();
    }
  } catch (err) {
    showToast("Error marking paid: " + err.message);
  }
}

function wireLedgerMarkPaidModal() {
  document.getElementById("ledgerMarkPaidConfirmBtn")?.addEventListener("click", commitLedgerMarkPaid);
  document.getElementById("ledgerMarkPaidCancelBtn")?.addEventListener("click", closeLedgerMarkPaidModal);
  document.getElementById("ledgerMarkPaidCheckNumber")?.addEventListener("keydown", e => {
    if (e.key === "Enter")  { e.preventDefault(); commitLedgerMarkPaid(); }
    if (e.key === "Escape") { e.preventDefault(); closeLedgerMarkPaidModal(); }
  });
  document.getElementById("ledgerMarkPaidModal")?.addEventListener("click", e => {
    if (e.target === e.currentTarget) closeLedgerMarkPaidModal();
  });
}

// ── Add/Edit Expense modal ────────────────────────────────────────────────────

function openExpenseModal(editId = null) {
  const modal    = document.getElementById("expenseModal");
  const titleEl  = document.getElementById("expenseModalTitle");
  const saveBtn  = document.getElementById("expenseModalSaveBtn");
  const editIdEl = document.getElementById("expenseEditId");
  if (!modal) return;

  document.getElementById("expenseModalMsg")?.setAttribute("style", "margin:0;flex:1");
  setMsg("expenseModalMsg", "", "info");

  if (editId) {
    const e = ledgerExpenses.find(x => x.id === editId);
    if (!e) return;
    titleEl.textContent       = "Edit Expense";
    saveBtn.textContent       = "Save Changes";
    editIdEl.value            = editId;
    document.getElementById("expenseDate").value        = e.date || "";
    document.getElementById("expenseAmount").value      = e.amount || "";
    document.getElementById("expenseTeam").value        = e.teamName || "";
    document.getElementById("expenseCategory").value   = e.category || "";
    document.getElementById("expenseDescription").value = e.description || "";
    document.getElementById("expenseNotes").value       = e.notes || "";
  } else {
    titleEl.textContent       = "Add Expense";
    saveBtn.textContent       = "Add Expense";
    editIdEl.value            = "";
    document.getElementById("expenseDate").value        = todayISO();
    document.getElementById("expenseAmount").value      = "";
    document.getElementById("expenseTeam").value        = "";
    document.getElementById("expenseCategory").value   = "";
    document.getElementById("expenseDescription").value = "";
    document.getElementById("expenseNotes").value       = "";
  }

  modal.style.display = "";
}

function closeExpenseModal() {
  document.getElementById("expenseModal").style.display = "none";
}

async function saveExpense() {
  const editId      = document.getElementById("expenseEditId")?.value;
  const date        = document.getElementById("expenseDate")?.value;
  const amount      = parseFloat(document.getElementById("expenseAmount")?.value);
  const teamName    = document.getElementById("expenseTeam")?.value || "";
  const category    = document.getElementById("expenseCategory")?.value;
  const description = document.getElementById("expenseDescription")?.value.trim();
  const notes       = document.getElementById("expenseNotes")?.value.trim();

  if (!date || isNaN(amount) || amount < 0) {
    setMsg("expenseModalMsg", "Date and a valid amount are required.", "error");
    return;
  }
  if (!category) {
    setMsg("expenseModalMsg", "Please select a category.", "error");
    return;
  }

  const btn = document.getElementById("expenseModalSaveBtn");
  btn.disabled = true;
  setMsg("expenseModalMsg", "Saving…", "info");

  // Derive division from teamsData
  const matchedTeam = teamsData.find(t => t.name === teamName);
  const division = matchedTeam?.division || "";

  const season = seasonFilter || String(new Date(date).getFullYear());

  const coreData = { season, date, teamName, division, category, description, amount, notes: notes || "" };

  try {
    if (editId) {
      // Only update editable fields — never overwrite paid/checkNumber/checkCleared on edit
      await updateDoc(doc(db, "ledgerExpenses", editId), coreData);
      const idx = ledgerExpenses.findIndex(x => x.id === editId);
      if (idx !== -1) ledgerExpenses[idx] = { ...ledgerExpenses[idx], ...coreData };
    } else {
      const uid = getCurrentUser()?.uid || "";
      const newData = { ...coreData, paid: false, checkNumber: "", checkCleared: false };
      const ref = await addDoc(collection(db, "ledgerExpenses"), { ...newData, createdAt: serverTimestamp(), createdBy: uid });
      ledgerExpenses.push({ id: ref.id, ...newData, createdAt: null });
      ledgerExpenses.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    }
    closeExpenseModal();
    renderActiveTab();
  } catch (err) {
    setMsg("expenseModalMsg", err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

function wireExpenseModal() {
  document.getElementById("expenseModalSaveBtn")?.addEventListener("click", saveExpense);
  document.getElementById("expenseModalCancelBtn")?.addEventListener("click", closeExpenseModal);
  document.getElementById("expenseModal")?.addEventListener("click", e => {
    if (e.target === e.currentTarget) closeExpenseModal();
  });
  document.getElementById("addExpenseBtn")?.addEventListener("click", () => openExpenseModal());
}

// ── Budget modal ──────────────────────────────────────────────────────────────

function openBudgetModal(teamName = "", category = "", currentAmount = 0) {
  const modal = document.getElementById("budgetModal");
  if (!modal) return;
  setMsg("budgetModalMsg", "", "info");
  document.getElementById("budgetTeam").value     = teamName;
  document.getElementById("budgetCategory").value = category;
  document.getElementById("budgetAmount").value   = currentAmount > 0 ? currentAmount : "";
  modal.style.display = "";
  document.getElementById("budgetAmount")?.focus();
}

function closeBudgetModal() {
  document.getElementById("budgetModal").style.display = "none";
}

async function saveBudget() {
  const teamName = document.getElementById("budgetTeam")?.value || "";
  const category = document.getElementById("budgetCategory")?.value;
  const amount   = parseFloat(document.getElementById("budgetAmount")?.value);

  if (!category) { setMsg("budgetModalMsg", "Please select a category.", "error"); return; }
  if (isNaN(amount) || amount < 0) { setMsg("budgetModalMsg", "Please enter a valid amount.", "error"); return; }

  const btn = document.getElementById("budgetModalSaveBtn");
  btn.disabled = true;
  setMsg("budgetModalMsg", "Saving…", "info");

  const season = seasonFilter || String(new Date().getFullYear());
  const existIdx = budgets.findIndex(b => b.season === season && b.teamName === teamName && b.category === category);

  if (existIdx !== -1) {
    budgets[existIdx].amount = amount;
  } else {
    budgets.push({ id: crypto.randomUUID(), season, teamName, category, amount });
  }

  try {
    await setDoc(doc(db, "config", "ledgerBudgets"), { budgets });
    closeBudgetModal();
    renderSummary();
  } catch (err) {
    setMsg("budgetModalMsg", err.message, "error");
    // Revert optimistic update
    if (existIdx !== -1) {
      budgets[existIdx].amount = budgets[existIdx].amount; // already updated, leave it
    } else {
      budgets.pop();
    }
  } finally {
    btn.disabled = false;
  }
}

function wireBudgetModal() {
  document.getElementById("budgetModalSaveBtn")?.addEventListener("click", saveBudget);
  document.getElementById("budgetModalCancelBtn")?.addEventListener("click", closeBudgetModal);
  document.getElementById("addBudgetBtn")?.addEventListener("click", () => openBudgetModal());
  document.getElementById("budgetModal")?.addEventListener("click", e => {
    if (e.target === e.currentTarget) closeBudgetModal();
  });
}

// ── CSV export ────────────────────────────────────────────────────────────────

function exportCSV() {
  if (activeTab === "coach") {
    const rows    = filteredCoachPay();
    const headers = ["Coach", "Team", "Division", "Role", "Yrs of Service", "Pay Type", "Calc. Pay", "Paid", "Check #", "Cleared"];
    const lines   = [
      headers.join(","),
      ...rows.map(r => [
        csvCell(r.coachName),
        csvCell(r.teamName || "Org-Wide"),
        csvCell(r.division || ""),
        csvCell(r.role || ""),
        r.yearsOfService ?? 0,
        csvCell(r.paymentType || ""),
        (r.calculatedPay ?? 0).toFixed(2),
        r.paid ? "Yes" : "No",
        csvCell(r.checkNumber || ""),
        r.paid && r.checkCleared ? "Yes" : "No",
      ].join(","))
    ];
    downloadCSV(lines, `coach-pay-${seasonFilter || "all"}.csv`);
  } else if (activeTab === "expenses") {
    const rows    = filteredExpenses();
    const headers = ["Date", "Team", "Division", "Category", "Description", "Amount", "Paid", "Check #", "Cleared"];
    const lines   = [
      headers.join(","),
      ...rows.map(e => [
        e.date || "",
        csvCell(e.teamName || "Org-Wide"),
        csvCell(e.division || ""),
        csvCell(categoryLabel(e.category)),
        csvCell(e.description || ""),
        (Number(e.amount) || 0).toFixed(2),
        e.paid ? "Yes" : "No",
        csvCell(e.checkNumber || ""),
        e.paid && e.checkCleared ? "Yes" : "No",
      ].join(","))
    ];
    downloadCSV(lines, `expenses-${seasonFilter || "all"}.csv`);
  } else {
    // Summary tab — export the aggregated summary
    const expenses  = filteredExpenses();
    const coachPays = filteredCoachPay();
    const budgetSet = filteredBudgets();
    const keyMap    = new Map();
    function ensureKey(teamName, category) {
      const key = `${teamName}|||${category}`;
      if (!keyMap.has(key)) keyMap.set(key, { teamName, category, budget: 0, actual: 0 });
      return keyMap.get(key);
    }
    expenses.forEach(e => { ensureKey(e.teamName || "", e.category || "").actual += Number(e.amount) || 0; });
    coachPays.forEach(c => { ensureKey(c.teamName || "", "coach_pay").actual += Number(c.calculatedPay) || 0; });
    budgetSet.forEach(b => { ensureKey(b.teamName || "", b.category || "").budget = Number(b.amount) || 0; });
    const rows = [...keyMap.values()].sort((a, b) => a.teamName.localeCompare(b.teamName) || a.category.localeCompare(b.category));
    const headers = ["Team", "Category", "Budgeted", "Actual", "Variance"];
    const lines = [
      headers.join(","),
      ...rows.map(r => {
        const variance = r.budget > 0 ? (r.budget - r.actual).toFixed(2) : "";
        const catLabel = r.category === "coach_pay" ? "Coach Pay" : categoryLabel(r.category);
        return [
          csvCell(r.teamName || "Org-Wide"),
          csvCell(catLabel),
          r.budget > 0 ? r.budget.toFixed(2) : "",
          r.actual.toFixed(2),
          variance,
        ].join(",");
      }),
    ];
    downloadCSV(lines, `ledger-summary-${seasonFilter || "all"}.csv`);
  }
}

function downloadCSV(lines, filename) {
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── Wire toolbar ──────────────────────────────────────────────────────────────

function wireToolbar() {
  document.getElementById("ledgerSeasonFilter")?.addEventListener("change", e => {
    seasonFilter = e.target.value;
    renderActiveTab();
  });
  document.getElementById("ledgerTeamFilter")?.addEventListener("change", e => {
    teamFilter = e.target.value;
    renderActiveTab();
  });
  document.getElementById("ledgerExportCsvBtn")?.addEventListener("click", exportCSV);
}

function wireTabNav() {
  document.getElementById("ledgerSecNav")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-ledger-tab]");
    if (!btn) return;
    showTab(btn.dataset.ledgerTab);
  });
  document.getElementById("generateCoachPayBtn")?.addEventListener("click", generateCoachPayRecords);
}

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display     = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display     = "none";

  wireLedgerMarkPaidModal();
  wireExpenseModal();
  wireBudgetModal();
  wireToolbar();
  wireTabNav();
  loadAll();
});
