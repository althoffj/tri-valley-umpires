// admin-callup.js — Admin view of all player call-up requests + admin create
import { db }                        from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import { esc }                       from "./utils.js";

import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc,
  query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let allRequests = [];
let allTeams    = [];

// Roster cache keyed by teamId — loaded on demand in the create modal
const rosterCache = {};

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

function teamOpts(excludeId = "") {
  return '<option value="">— Select team —</option>' +
    allTeams
      .filter(t => t.id && t.id !== excludeId)
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      .map(t => `<option value="${esc(t.id)}">${esc(t.name)}${t.division ? ` (${esc(t.division)})` : ""}</option>`)
      .join("");
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
        ${r.createdByAdmin ? `<div style="margin-top:4px"><span class="acu-admin-badge">Admin created</span></div>` : ""}
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

// ── Override / respond modal ──────────────────────────────────────────────────

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

// ── Create Call-Up modal ──────────────────────────────────────────────────────

function openCreateModal() {
  const opts = teamOpts();
  document.getElementById("acuCreateHomeTeam").innerHTML = opts;
  document.getElementById("acuCreateReqTeam").innerHTML  = opts;

  const playerSel = document.getElementById("acuCreatePlayer");
  playerSel.innerHTML  = '<option value="">— Select a team first —</option>';
  playerSel.disabled   = true;

  document.getElementById("acuCreateDate").value   = "";
  document.getElementById("acuCreateReason").value = "";
  document.getElementById("acuCreateNote").value   = "";

  const msgEl = document.getElementById("acuCreateMsg");
  msgEl.textContent = "";
  msgEl.className   = "signup-message";

  document.getElementById("acuCreateSubmitBtn").disabled = false;
  document.getElementById("acuCreateOverlay").style.display = "flex";
}

function closeCreateModal() {
  document.getElementById("acuCreateOverlay").style.display = "none";
}

document.getElementById("acuOpenCreateBtn").addEventListener("click", openCreateModal);
document.getElementById("acuCreateCancelBtn").addEventListener("click", closeCreateModal);
document.getElementById("acuCreateOverlay").addEventListener("click", e => {
  if (e.target === document.getElementById("acuCreateOverlay")) closeCreateModal();
});

// When admin picks the player's team, load that team's roster
document.getElementById("acuCreateHomeTeam").addEventListener("change", async function () {
  const teamId    = this.value;
  const playerSel = document.getElementById("acuCreatePlayer");

  // Remove the picked home team from the calling-up team select
  const reqSel = document.getElementById("acuCreateReqTeam");
  reqSel.innerHTML = teamOpts(teamId);

  if (!teamId) {
    playerSel.innerHTML = '<option value="">— Select a team first —</option>';
    playerSel.disabled  = true;
    return;
  }

  playerSel.innerHTML = '<option value="">Loading roster…</option>';
  playerSel.disabled  = true;

  try {
    if (!rosterCache[teamId]) {
      const snap = await getDoc(doc(db, "rosters", teamId));
      rosterCache[teamId] = snap.exists() ? (snap.data().players || []) : [];
    }
    const players = rosterCache[teamId];

    if (!players.length) {
      playerSel.innerHTML = '<option value="">No players on this team\'s roster</option>';
      return;
    }

    const sorted = [...players].sort((a, b) => {
      const na = parseInt(a.number) || 999, nb = parseInt(b.number) || 999;
      return na !== nb ? na - nb : (a.lastName || "").localeCompare(b.lastName || "");
    });

    playerSel.innerHTML = '<option value="">— Select player —</option>' +
      sorted.map(p =>
        `<option value="${esc(p.id)}"
          data-first="${esc(p.firstName || "")}"
          data-last="${esc(p.lastName || "")}"
          data-num="${esc(p.number || "")}"
          data-pos="${esc(p.position || "")}">#${p.number || "—"} ${esc(p.firstName)} ${esc(p.lastName)}${p.position ? ` — ${esc(p.position)}` : ""}</option>`
      ).join("");

    playerSel.disabled = false;
  } catch (err) {
    playerSel.innerHTML = '<option value="">Error loading roster</option>';
  }
});

// ── Submit create ─────────────────────────────────────────────────────────────

document.getElementById("acuCreateSubmitBtn").addEventListener("click", async () => {
  const homeTeamId = document.getElementById("acuCreateHomeTeam").value;
  const playerId   = document.getElementById("acuCreatePlayer").value;
  const reqTeamId  = document.getElementById("acuCreateReqTeam").value;
  const gameDate   = document.getElementById("acuCreateDate").value;
  const reason     = document.getElementById("acuCreateReason").value.trim();
  const note       = document.getElementById("acuCreateNote").value.trim();
  const msgEl      = document.getElementById("acuCreateMsg");
  const btn        = document.getElementById("acuCreateSubmitBtn");

  // Validation
  if (!homeTeamId) {
    msgEl.textContent = "Select the player's team.";
    msgEl.className = "signup-message error";
    return;
  }
  if (!playerId) {
    msgEl.textContent = "Select a player.";
    msgEl.className = "signup-message error";
    return;
  }
  if (!reqTeamId) {
    msgEl.textContent = "Select the calling-up team.";
    msgEl.className = "signup-message error";
    return;
  }
  if (!reason) {
    msgEl.textContent = "Reason is required.";
    msgEl.className = "signup-message error";
    document.getElementById("acuCreateReason").focus();
    return;
  }

  const homeTeam = allTeams.find(t => t.id === homeTeamId);
  const reqTeam  = allTeams.find(t => t.id === reqTeamId);
  const players  = rosterCache[homeTeamId] || [];
  const player   = players.find(p => p.id === playerId);

  if (!homeTeam || !reqTeam || !player) {
    msgEl.textContent = "Invalid selection — please try again.";
    msgEl.className = "signup-message error";
    return;
  }

  btn.disabled = true;
  msgEl.textContent = "Creating…";
  msgEl.className = "signup-message info";

  try {
    const now = serverTimestamp();
    const newDoc = await addDoc(collection(db, "callupRequests"), {
      // Requesting side — use the team's assigned coach info
      requestingCoachId:    reqTeam.coachId    || "",
      requestingCoachName:  reqTeam.coachName  || "",
      requestingCoachEmail: reqTeam.coachEmail || "",
      requestingTeamId:     reqTeam.id,
      requestingTeamName:   reqTeam.name,
      requestingTeamDiv:    reqTeam.division   || "",
      // Home team (player's team)
      homeCoachId:          homeTeam.coachId    || "",
      homeCoachName:        homeTeam.coachName  || "",
      homeCoachEmail:       homeTeam.coachEmail || "",
      homeTeamId:           homeTeam.id,
      homeTeamName:         homeTeam.name,
      homeTeamDiv:          homeTeam.division   || "",
      // Player
      playerId:             player.id,
      playerFirstName:      player.firstName    || "",
      playerLastName:       player.lastName     || "",
      playerNumber:         player.number       || "",
      playerPosition:       player.position     || "",
      // Details
      gameDate:             gameDate            || "",
      reason,
      // Auto-approved since admin is creating it
      status:               "approved",
      responseNote:         note ? `[Admin] ${note}` : "[Admin created]",
      createdByAdmin:       true,
      requestedAt:          now,
      respondedAt:          now,
    });

    // Optimistically prepend to local list
    allRequests.unshift({
      id:                   newDoc.id,
      requestingCoachId:    reqTeam.coachId    || "",
      requestingCoachName:  reqTeam.coachName  || "",
      requestingTeamId:     reqTeam.id,
      requestingTeamName:   reqTeam.name,
      requestingTeamDiv:    reqTeam.division   || "",
      homeCoachId:          homeTeam.coachId    || "",
      homeCoachName:        homeTeam.coachName  || "",
      homeTeamId:           homeTeam.id,
      homeTeamName:         homeTeam.name,
      homeTeamDiv:          homeTeam.division   || "",
      playerId:             player.id,
      playerFirstName:      player.firstName    || "",
      playerLastName:       player.lastName     || "",
      playerNumber:         player.number       || "",
      playerPosition:       player.position     || "",
      gameDate:             gameDate            || "",
      reason,
      status:               "approved",
      responseNote:         note ? `[Admin] ${note}` : "[Admin created]",
      createdByAdmin:       true,
    });

    // Update team filter options
    const teamSel = document.getElementById("acuFilterTeam");
    const teamNames = [...new Set([
      ...allRequests.map(r => r.homeTeamName),
      ...allRequests.map(r => r.requestingTeamName),
    ])].filter(Boolean).sort();
    teamSel.innerHTML = '<option value="">All teams</option>' +
      teamNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");

    msgEl.textContent = "✓ Call-up created and approved.";
    msgEl.className = "signup-message success";
    setTimeout(() => {
      closeCreateModal();
      renderTable();
    }, 900);
  } catch (err) {
    msgEl.textContent = "Error: " + (err.message || String(err));
    msgEl.className = "signup-message error";
    btn.disabled = false;
  }
});

// ── Filters ───────────────────────────────────────────────────────────────────

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
