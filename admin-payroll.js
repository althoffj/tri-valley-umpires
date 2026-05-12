// admin-payroll.js — Payroll summary, umpire requests, incident reports
import { db } from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function setMsg(id, text, type = "info") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = `signup-message ${type}`;
}

// ── Payroll Summary ───────────────────────────────────────────────────────────

let payrollRows       = [];
let payrollFromFilter = "";
let payrollToFilter   = "";

async function loadPayroll() {
  const tbody    = document.getElementById("payrollBody");
  const totalsEl = document.getElementById("payrollTotals");
  if (!tbody) return;

  try {
    const snap = await getDocs(query(collection(db, "games"), orderBy("date", "asc")));

    payrollRows = [];
    snap.forEach(d => {
      const g = { id: d.id, ...d.data() };
      (g.umpireSlots ?? []).forEach(slot => {
        if (!slot.assignedUid) return;
        payrollRows.push({
          gameId:     g.id,
          slotType:   slot.type,
          uid:        slot.assignedUid,
          umpireName: slot.assignedName ?? slot.assignedUid,
          date:       g.date ?? "",
          city:       g.city ?? "",
          division:   g.division ?? "",
          pay:        Number(slot.payRate ?? g.payRate ?? 0),
          paid:       slot.paid === true,
          noShow:     slot.noShow === true
        });
      });
    });

    renderPayrollTable();
    wirePayrollFilters();
  } catch (err) {
    console.error(err);
    tbody.innerHTML = '<tr><td colspan="6" style="color:#ffb4b4">Error loading payroll.</td></tr>';
  }
}

function renderPayrollTable() {
  const tbody    = document.getElementById("payrollBody");
  const totalsEl = document.getElementById("payrollTotals");
  if (!tbody) return;

  const rows = payrollRows.filter(r => {
    if (payrollFromFilter && r.date < payrollFromFilter) return false;
    if (payrollToFilter   && r.date > payrollToFilter)   return false;
    return true;
  });

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--light-text);text-align:center">No payroll records found.</td></tr>';
    if (totalsEl) totalsEl.textContent = "";
    return;
  }

  // No-shows are excluded from financial totals
  const billable     = rows.filter(r => !r.noShow);
  const noShowCount  = rows.length - billable.length;
  const totalOwed    = billable.reduce((s, r) => s + r.pay, 0);
  const totalPaid    = billable.filter(r => r.paid).reduce((s, r) => s + r.pay, 0);
  const outstanding  = totalOwed - totalPaid;
  if (totalsEl) {
    const noShowNote = noShowCount > 0 ? ` — ${noShowCount} no-show${noShowCount !== 1 ? "s" : ""} excluded` : "";
    totalsEl.textContent =
      `Total: $${totalOwed.toFixed(2)} — Paid: $${totalPaid.toFixed(2)} — Outstanding: $${outstanding.toFixed(2)}${noShowNote}`;
  }

  tbody.innerHTML = rows.map(r => {
    if (r.noShow) {
      return `<tr style="opacity:0.55">
        <td>${esc(r.umpireName)}</td>
        <td>${esc(fmtDate(r.date))}</td>
        <td>${esc(r.city)}<br><span style="color:var(--light-text);font-size:0.85rem">${esc(r.division)}</span></td>
        <td><span class="badge badge-${r.slotType.toLowerCase()}">${esc(r.slotType)}</span></td>
        <td style="color:var(--light-text)">$0.00</td>
        <td><span class="badge" style="background:#3a1010;color:#ffb4b4">No Show</span></td>
      </tr>`;
    }
    const paidBadge = r.paid
      ? `<span class="badge" style="background:#17351f;color:#b8f2c4">Paid</span>`
      : `<span class="badge" style="background:#4a2c00;color:#ffcc80">Unpaid</span>`;
    const toggleBtn = `<button class="btn ${r.paid ? "print-btn" : ""} payroll-toggle-btn"
        data-game-id="${esc(r.gameId)}" data-slot-type="${esc(r.slotType)}" data-uid="${esc(r.uid)}"
        style="font-size:0.78rem;padding:3px 10px;margin-left:8px">
        ${r.paid ? "Mark Unpaid" : "Mark Paid"}
      </button>`;
    return `<tr>
      <td>${esc(r.umpireName)}</td>
      <td>${esc(fmtDate(r.date))}</td>
      <td>${esc(r.city)}<br><span style="color:var(--light-text);font-size:0.85rem">${esc(r.division)}</span></td>
      <td><span class="badge badge-${r.slotType.toLowerCase()}">${esc(r.slotType)}</span></td>
      <td>$${r.pay.toFixed(2)}</td>
      <td style="white-space:nowrap">${paidBadge}${toggleBtn}</td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll(".payroll-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () =>
      togglePaid(btn.dataset.gameId, btn.dataset.slotType, btn.dataset.uid)
    );
  });
}

async function togglePaid(gameId, slotType, uid) {
  const ref = doc(db, "games", gameId);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const slots = (snap.data().umpireSlots ?? []).map(s => {
      if (s.type === slotType && s.assignedUid === uid) {
        return { ...s, paid: !s.paid };
      }
      return s;
    });
    await updateDoc(ref, { umpireSlots: slots });

    const row = payrollRows.find(r => r.gameId === gameId && r.slotType === slotType && r.uid === uid);
    if (row) row.paid = !row.paid;
    renderPayrollTable();
  } catch (err) {
    console.error(err);
    alert("Error updating paid status.");
  }
}

function wirePayrollFilters() {
  document.getElementById("payrollFilterBtn")?.addEventListener("click", () => {
    payrollFromFilter = document.getElementById("payrollFrom").value;
    payrollToFilter   = document.getElementById("payrollTo").value;
    renderPayrollTable();
  });
  document.getElementById("payrollResetBtn")?.addEventListener("click", () => {
    payrollFromFilter = "";
    payrollToFilter   = "";
    document.getElementById("payrollFrom").value = "";
    document.getElementById("payrollTo").value   = "";
    renderPayrollTable();
  });
  document.getElementById("exportCsvBtn")?.addEventListener("click", exportCSV);
}

function exportCSV() {
  const rows = payrollRows.filter(r => {
    if (payrollFromFilter && r.date < payrollFromFilter) return false;
    if (payrollToFilter   && r.date > payrollToFilter)   return false;
    return true;
  });

  const headers = ["Umpire", "Date", "City", "Division", "Slot", "Pay", "Paid", "No Show"];
  const lines = [
    headers.join(","),
    ...rows.map(r => [
      `"${r.umpireName.replace(/"/g, '""')}"`,
      fmtDate(r.date),
      `"${r.city.replace(/"/g, '""')}"`,
      `"${r.division.replace(/"/g, '""')}"`,
      r.slotType,
      r.noShow ? "0.00" : r.pay.toFixed(2),
      r.noShow ? "N/A" : (r.paid ? "Yes" : "No"),
      r.noShow ? "Yes" : "No"
    ].join(","))
  ];

  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10);
  a.href     = url;
  a.download = `payroll-${today}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Umpire Requests ───────────────────────────────────────────────────────────

async function loadUmpireRequests() {
  const listEl = document.getElementById("requestList");
  const noteEl = document.getElementById("requestNote");
  if (!listEl) return;

  try {
    const snap = await getDocs(
      query(collection(db, "umpireRequests"), orderBy("submittedAt", "desc"))
    );

    if (snap.empty) {
      noteEl.textContent = "No umpire requests submitted yet.";
      listEl.innerHTML = "";
      return;
    }

    const pending = snap.docs.filter(d => d.data().status === "pending");
    noteEl.textContent = `${snap.size} total request${snap.size === 1 ? "" : "s"} — ${pending.length} pending.`;

    listEl.innerHTML = snap.docs.map(d => {
      const r  = d.data();
      const id = d.id;
      const positions = (r.positions ?? []).map(p => `${p.type} ($${p.pay})`).join(", ") || "—";
      const statusBadge = {
        pending:  '<span class="badge" style="background:#4a2c00;color:#ffcc80">Pending</span>',
        approved: '<span class="badge" style="background:#17351f;color:#b8f2c4">Approved</span>',
        denied:   '<span class="badge" style="background:#5a1a1a;color:#ffb4b4">Denied</span>'
      }[r.status] ?? r.status;

      const actionBtns = r.status === "pending"
        ? `<button class="btn req-approve-btn" data-id="${esc(id)}" style="font-size:0.8rem;padding:5px 12px">Approve</button>
           <button class="btn print-btn req-deny-btn" data-id="${esc(id)}" style="font-size:0.8rem;padding:5px 12px">Deny</button>`
        : "";

      return `
        <div class="document-note" style="border-left-color:#7ec8f7;margin-bottom:16px" data-request-id="${esc(id)}">
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px">
            <strong style="color:white">${esc(r.homeTeam ?? "?")} vs ${esc(r.awayTeam ?? "?")} — ${esc(r.division ?? "")}</strong>
            ${statusBadge}
          </div>
          <p style="margin:0 0 3px"><span style="color:var(--light-text)">Date / Time:</span> ${esc(fmtDate(r.date))} at ${esc(fmtTime(r.time))}</p>
          <p style="margin:0 0 3px"><span style="color:var(--light-text)">Location:</span> ${esc(r.location ?? "")}</p>
          <p style="margin:0 0 3px"><span style="color:var(--light-text)">Positions:</span> ${esc(positions)}</p>
          <p style="margin:0 0 3px"><span style="color:var(--light-text)">Coach:</span> ${esc(r.coachName ?? "")} — ${esc(r.coachEmail ?? "")} — ${esc(r.coachPhone ?? "")}</p>
          ${r.notes ? `<p style="margin:4px 0 0;color:var(--light-text);font-size:0.9rem">${esc(r.notes)}</p>` : ""}
          ${actionBtns ? `<div class="page-actions" style="margin-top:12px;margin-bottom:0">${actionBtns}</div>` : ""}
          <p class="signup-message req-status-msg" style="margin:6px 0 0;min-height:0"></p>
        </div>`;
    }).join("");

    listEl.querySelectorAll(".req-approve-btn").forEach(btn => {
      btn.addEventListener("click", () => handleRequestAction(btn.dataset.id, "approved"));
    });
    listEl.querySelectorAll(".req-deny-btn").forEach(btn => {
      btn.addEventListener("click", () => handleRequestAction(btn.dataset.id, "denied"));
    });
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<p style="color:#ffb4b4">Error loading umpire requests.</p>';
  }
}

async function handleRequestAction(requestId, newStatus) {
  const card  = document.querySelector(`[data-request-id="${requestId}"]`);
  const msgEl = card?.querySelector(".req-status-msg");
  if (msgEl) { msgEl.textContent = "Saving…"; msgEl.className = "signup-message req-status-msg info"; }

  try {
    await updateDoc(doc(db, "umpireRequests", requestId), { status: newStatus });
    if (msgEl) {
      msgEl.textContent = newStatus === "approved"
        ? "Approved — remember to add the game to the schedule."
        : "Denied.";
      msgEl.className = `signup-message req-status-msg ${newStatus === "approved" ? "success" : "warning"}`;
    }
    card?.querySelectorAll(".req-approve-btn, .req-deny-btn").forEach(b => b.remove());
    const badgeEl = card?.querySelector(".badge");
    if (badgeEl) {
      badgeEl.textContent = newStatus === "approved" ? "Approved" : "Denied";
      badgeEl.style.background = newStatus === "approved" ? "#17351f" : "#5a1a1a";
      badgeEl.style.color      = newStatus === "approved" ? "#b8f2c4" : "#ffb4b4";
    }
  } catch (err) {
    console.error(err);
    if (msgEl) { msgEl.textContent = "Error saving."; msgEl.className = "signup-message req-status-msg error"; }
  }
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

  loadPayroll();
  loadUmpireRequests();
});
