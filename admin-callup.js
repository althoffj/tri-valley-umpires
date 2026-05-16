// admin-callup.js — Admin view of all player call-up requests
import { db }                        from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import { esc }                       from "./utils.js";

import {
  collection, doc, getDoc, getDocs, updateDoc, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let allRequests = [];
let allTeams    = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusPill(status) {
  return `<span class="acu-status-pill ${status}">${status.charAt(0).toUpperCase() + status.slice(1)}</span>`;
}

function formatDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US",
    { month: "short", day: "numeric", year: "numeric" });
}

// ── Load & render ─────────────────────────────────────────────────────────────

async function loadAll() {
  const [reqSnap, teamsSnap] = await Promise.all([
    getDocs(query(collection(db, "callupRequests"), orderBy("requestedAt", "desc"))),
    getDoc(doc(db, "config/teamCalendars")),
  ]);

  allRequests = reqSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  allTeams = teamsSnap.exists() ? (teamsSnap.data().teams || []) : [];

  // Populate team filter
  const teamSel = document.getElementById("acuFilterTeam");
  const teamNames = [...new Set([
    ...allRequests.map(r => r.homeTeamName),
    ...allRequests.map(r => r.requestingTeamName),
  ])].filter(Boolean).sort();
  teamSel.innerHTML = '<option value="">All teams</option>' +
    teamNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");

  renderTable();
}

function renderTable() {
  const statusFilter = document.getElementById("acuFilterStatus").value;
  const teamFilter   = document.getElementById("acuFilterTeam").value;
  const tbody        = document.getElementById("acuTableBody");

  let rows = allRequests;
  if (statusFilter) rows = rows.filter(r => r.status === statusFilter);
  if (teamFilter)   rows = rows.filter(r =>
    r.homeTeamName === teamFilter || r.requestingTeamName === teamFilter);

  document.getElementById("acuCount").textContent =
    `${rows.length} request${rows.length !== 1 ? "s" : ""}`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:var(--light-text);text-align:center;padding:24px">No requests match the current filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>
        <strong>${esc(r.playerFirstName)} ${esc(r.playerLastName)}</strong>
        ${r.playerNumber ? `<br><span style="color:var(--light-text);font-size:0.8rem">#${esc(r.playerNumber)}${r.playerPosition ? " · " + esc(r.playerPosition) : ""}</span>` : ""}
      </td>
      <td>
        <div>${esc(r.homeTeamName)}</div>
        <div style="font-size:0.8rem;color:var(--light-text)">${esc(r.homeTeamDiv || "")}</div>
        <div style="font-size:0.8rem;color:var(--light-text)">${esc(r.homeCoachName || "")}</div>
      </td>
      <td>
        <div>${esc(r.requestingTeamName)}</div>
        <div style="font-size:0.8rem;color:var(--light-text)">${esc(r.requestingTeamDiv || "")}</div>
        <div style="font-size:0.8rem;color:var(--light-text)">${esc(r.requestingCoachName || "")}</div>
      </td>
      <td style="white-space:nowrap">${formatDate(r.gameDate)}</td>
      <td style="max-width:200px">
        <div style="font-size:0.85rem">${esc(r.reason || "—")}</div>
        ${r.responseNote ? `<div style="font-size:0.8rem;color:#8ab4f8;margin-top:3px;font-style:italic">"${esc(r.responseNote)}"</div>` : ""}
      </td>
      <td>${statusPill(r.status)}</td>
      <td style="white-space:nowrap;font-size:0.8rem;color:var(--light-text)">
        ${r.requestedAt?.toDate?.()?.toLocaleDateString() || "—"}
        ${r.respondedAt?.toDate?.() ? `<br>→ ${r.respondedAt.toDate().toLocaleDateString()}` : ""}
      </td>
      <td>
        ${r.status === "pending" ? `
          <button type="button" class="btn print-btn acu-admin-respond-btn" data-id="${esc(r.id)}"
            style="font-size:0.8rem;padding:4px 10px">Override</button>` : ""}
      </td>
    </tr>`).join("");

  tbody.querySelectorAll(".acu-admin-respond-btn").forEach(btn => {
    btn.addEventListener("click", () => openRespondModal(btn.dataset.id));
  });
}

// ── Respond modal ─────────────────────────────────────────────────────────────

function openRespondModal(id) {
  const r = allRequests.find(x => x.id === id);
  if (!r) return;
  document.getElementById("acuRespondId").value = id;
  document.getElementById("acuRespondInfo").innerHTML = `
    <strong>${esc(r.playerFirstName)} ${esc(r.playerLastName)}</strong>
    from <strong>${esc(r.homeTeamName)}</strong>
    → requested by <strong>${esc(r.requestingTeamName)}</strong><br>
    ${r.reason ? `<span style="color:var(--light-text);font-size:0.85rem">${esc(r.reason)}</span>` : ""}`;
  document.getElementById("acuRespondNote").value = "";
  document.getElementById("acuRespondMsg").textContent = "";
  document.getElementById("acuRespondMsg").className = "signup-message";
  document.getElementById("acuRespondOverlay").style.display = "flex";
}

async function adminRespond(status) {
  const id   = document.getElementById("acuRespondId").value;
  const note = document.getElementById("acuRespondNote").value.trim();
  const msgEl = document.getElementById("acuRespondMsg");
  const aBtns = [document.getElementById("acuApproveBtn"), document.getElementById("acuDeclineBtn")];
  aBtns.forEach(b => b.disabled = true);
  msgEl.textContent = "Saving…"; msgEl.className = "signup-message info";
  try {
    await updateDoc(doc(db, "callupRequests", id), {
      status,
      responseNote: note ? `[Admin] ${note}` : `[Admin override]`,
      respondedAt:  serverTimestamp(),
    });
    allRequests = allRequests.map(r => r.id === id
      ? { ...r, status, responseNote: note ? `[Admin] ${note}` : "[Admin override]" }
      : r);
    document.getElementById("acuRespondOverlay").style.display = "none";
    renderTable();
  } catch (err) {
    msgEl.textContent = "Error: " + err.message; msgEl.className = "signup-message error";
    aBtns.forEach(b => b.disabled = false);
  }
}

document.getElementById("acuApproveBtn").addEventListener("click", () => adminRespond("approved"));
document.getElementById("acuDeclineBtn").addEventListener("click",  () => adminRespond("declined"));
document.getElementById("acuRespondCancelBtn").addEventListener("click", () => {
  document.getElementById("acuRespondOverlay").style.display = "none";
});

document.getElementById("acuFilterStatus").addEventListener("change", renderTable);
document.getElementById("acuFilterTeam").addEventListener("change",   renderTable);

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display = "none";
  loadAll();
});
