// earnings.js — Umpire's own earnings history
import { db, auth } from "./firebase.js";
import { authReadyPromise, isApproved, getCurrentUser } from "./auth.js";
import {
  collection,
  getDocs,
  query,
  orderBy,
  where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let earningsRows   = [];
let fromFilter     = "";
let toFilter       = "";

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

async function loadEarnings() {
  const tbody    = document.getElementById("earningsBody");
  const totalsEl = document.getElementById("earningsTotals");
  if (!tbody) return;

  const uid = getCurrentUser()?.uid;
  if (!uid) return;

  try {
    const snap = await getDocs(
      query(collection(db, "games"), orderBy("date", "asc"))
    );

    earningsRows = [];
    snap.forEach(d => {
      const g = { id: d.id, ...d.data() };
      (g.umpireSlots ?? []).forEach(slot => {
        if (slot.assignedUid !== uid) return;
        earningsRows.push({
          date:     g.date     ?? "",
          city:     g.city     ?? "",
          division: g.division ?? "",
          slotType: slot.type  ?? "",
          pay:      Number(slot.payRate ?? g.payRate ?? 0),
          paid:     slot.paid  === true
        });
      });
    });

    renderEarnings();
    wireFilters();
  } catch (err) {
    console.error(err);
    tbody.innerHTML = '<tr><td colspan="5" style="color:#ffb4b4">Error loading earnings.</td></tr>';
  }
}

function renderEarnings() {
  const tbody    = document.getElementById("earningsBody");
  const totalsEl = document.getElementById("earningsTotals");
  if (!tbody) return;

  const rows = earningsRows.filter(r => {
    if (fromFilter && r.date < fromFilter) return false;
    if (toFilter   && r.date > toFilter)   return false;
    return true;
  });

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--light-text);text-align:center">No games found.</td></tr>';
    if (totalsEl) totalsEl.textContent = "";
    return;
  }

  const totalEarned  = rows.reduce((s, r) => s + r.pay, 0);
  const totalPaid    = rows.filter(r => r.paid).reduce((s, r) => s + r.pay, 0);
  const outstanding  = totalEarned - totalPaid;

  if (totalsEl) {
    totalsEl.textContent =
      `${rows.length} game${rows.length !== 1 ? "s" : ""} — ` +
      `Earned: $${totalEarned.toFixed(2)} — ` +
      `Paid: $${totalPaid.toFixed(2)} — ` +
      `Outstanding: $${outstanding.toFixed(2)}`;
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

function wireFilters() {
  document.getElementById("earningsFilterBtn")?.addEventListener("click", () => {
    fromFilter = document.getElementById("earningsFrom").value;
    toFilter   = document.getElementById("earningsTo").value;
    renderEarnings();
  });
  document.getElementById("earningsResetBtn")?.addEventListener("click", () => {
    fromFilter = "";
    toFilter   = "";
    document.getElementById("earningsFrom").value = "";
    document.getElementById("earningsTo").value   = "";
    renderEarnings();
  });
}

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
