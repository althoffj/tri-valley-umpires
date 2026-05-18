// coach-callup.js — Player call-up portal for coaches
import { db }                           from "./firebase.js";
import { authReadyPromise, getCurrentUser } from "./auth.js";
import { esc }                          from "./utils.js";

import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc,
  query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Division ordering ─────────────────────────────────────────────────────────

const DIV_ORDER = ["T-ball", "6U", "8U", "10U", "12U", "14U", "HS JV", "HS Varsity"];
function divIdx(d) { return DIV_ORDER.indexOf(d); }

// A player from sourceDivision is eligible to play for targetDivision
// if source is the same level or younger (lower index)
function isEligible(sourceDivision, targetDivision) {
  const si = divIdx(sourceDivision), ti = divIdx(targetDivision);
  return si !== -1 && ti !== -1 && si <= ti;
}

// ── State ─────────────────────────────────────────────────────────────────────

let currentUid  = "";
let myTeams     = [];          // teams this coach coaches (usually 1)
let allTeams    = [];          // all teams
let eligibleTeams = [];        // teams from which players may be called up
let rostersByTeam = {};        // {teamId: [players]}
let outgoing    = [];          // requests I sent
let incoming    = [];          // requests for my players
let pendingRequest = null;     // {player, team} being confirmed in modal
let activeTab   = "find";

// ── Tab switching ─────────────────────────────────────────────────────────────

document.querySelectorAll(".callup-tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".callup-tab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeTab = btn.dataset.tab;
    document.querySelectorAll("[id^='cuPane-']").forEach(p => p.style.display = "none");
    document.getElementById(`cuPane-${activeTab}`).style.display = "";
    if (activeTab === "outgoing") renderOutgoing();
    if (activeTab === "incoming") renderIncoming();
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US",
    { weekday: "short", month: "short", day: "numeric" });
}

function statusPill(status) {
  return `<span class="cu-status-pill ${status}">${status.charAt(0).toUpperCase() + status.slice(1)}</span>`;
}

// ── Load data ─────────────────────────────────────────────────────────────────

async function loadAll() {
  // Teams
  const teamsSnap = await getDoc(doc(db, "config/teamCalendars"));
  allTeams = teamsSnap.exists() ? (teamsSnap.data().teams || []) : [];

  myTeams = allTeams.filter(t => t.coachId === currentUid);

  if (!myTeams.length) {
    document.getElementById("cuContent").style.display = "none";
    document.getElementById("cuNoTeam").style.display = "";
    return;
  }
  document.getElementById("cuContent").style.display = "";

  // Teams this coach's players can be called UP FROM are same or younger division
  // Teams this coach can CALL UP TO are their own teams
  // We show players from other teams who are <= my team's division
  const myDivIndices = myTeams.map(t => divIdx(t.division));
  const maxMyDiv = Math.max(...myDivIndices);

  eligibleTeams = allTeams.filter(t => {
    if (myTeams.some(m => m.id === t.id)) return false;         // exclude own team(s)
    if (divIdx(t.division) > maxMyDiv) return false;             // too old a division
    // Same division + same league → competitors; call-ups not permitted
    if (myTeams.some(m =>
      m.division === t.division &&
      m.leagueId && t.leagueId &&
      m.leagueId === t.leagueId
    )) return false;
    return true;
  });

  // Build division filter options
  const divs = [...new Set(eligibleTeams.map(t => t.division))]
    .sort((a, b) => divIdx(a) - divIdx(b));
  const divSel = document.getElementById("cuFilterDiv");
  divSel.innerHTML = '<option value="">All eligible divisions</option>' +
    divs.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join("");

  // Load rosters for eligible teams that have a roster
  const rosterIds = eligibleTeams.map(t => t.id).filter(Boolean);
  const rosterPromises = rosterIds.map(id =>
    getDoc(doc(db, "rosters", id)).then(s => ({ id, players: s.exists() ? (s.data().players || []) : [] }))
  );
  const rosterResults = await Promise.all(rosterPromises);
  rostersByTeam = {};
  rosterResults.forEach(r => { if (r.players.length) rostersByTeam[r.id] = r.players; });

  // Load outgoing requests (requests I made)
  const outSnap = await getDocs(query(
    collection(db, "callupRequests"),
    where("requestingCoachId", "==", currentUid),
    orderBy("requestedAt", "desc")
  ));
  outgoing = outSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Load incoming requests (requests for my team's players)
  const incSnap = await getDocs(query(
    collection(db, "callupRequests"),
    where("homeCoachId", "==", currentUid),
    orderBy("requestedAt", "desc")
  ));
  incoming = incSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  updateBadges();
  renderPlayerBrowse();
  wireFilters();
}

function updateBadges() {
  const pendingOut = outgoing.filter(r => r.status === "pending").length;
  const pendingInc = incoming.filter(r => r.status === "pending").length;

  const outBadge = document.getElementById("cuOutgoingBadge");
  outBadge.textContent = pendingOut;
  outBadge.style.display = pendingOut ? "" : "none";

  const incBadge = document.getElementById("cuIncomingBadge");
  incBadge.textContent = pendingInc;
  incBadge.style.display = pendingInc ? "" : "none";
}

// ── Player Browse ─────────────────────────────────────────────────────────────

function wireFilters() {
  document.getElementById("cuFilterDiv").addEventListener("change", renderPlayerBrowse);
  document.getElementById("cuFilterPos").addEventListener("change", renderPlayerBrowse);
  document.getElementById("cuSearchName").addEventListener("input", renderPlayerBrowse);
}

function renderPlayerBrowse() {
  const divFilter = document.getElementById("cuFilterDiv").value;
  const posFilter = document.getElementById("cuFilterPos").value;
  const nameFilter = document.getElementById("cuSearchName").value.toLowerCase();
  const wrap = document.getElementById("cuPlayerBrowse");

  // Build set of already-requested player IDs (pending or approved) to dim them
  const requestedSet = new Set(outgoing
    .filter(r => r.status === "pending" || r.status === "approved")
    .map(r => r.playerId));

  let teamsToShow = eligibleTeams.filter(t => rostersByTeam[t.id]?.length);
  if (divFilter) teamsToShow = teamsToShow.filter(t => t.division === divFilter);

  const sections = teamsToShow.map(team => {
    let players = rostersByTeam[team.id] || [];
    if (posFilter) players = players.filter(p => p.position === posFilter);
    if (nameFilter) players = players.filter(p =>
      `${p.firstName} ${p.lastName}`.toLowerCase().includes(nameFilter)
    );
    if (!players.length) return "";

    // Sort by number then last name
    players = [...players].sort((a, b) => {
      const na = parseInt(a.number) || 999, nb = parseInt(b.number) || 999;
      return na !== nb ? na - nb : (a.lastName || "").localeCompare(b.lastName || "");
    });

    const swatch = team.color ? `<span class="cu-team-swatch" style="background:${esc(team.color)}"></span>` : "";
    const divBadge = team.division ? `<span class="cu-team-div">${esc(team.division)}</span>` : "";

    const cards = players.map(p => {
      const alreadyRequested = requestedSet.has(p.id);
      const numLabel = p.number ? p.number : "—";
      return `
        <div class="cu-player-card${alreadyRequested ? '" style="opacity:0.5' : ''}">
          <div class="cu-player-num">${esc(numLabel)}</div>
          <div>
            <div class="cu-player-name">${esc(p.firstName)} ${esc(p.lastName)}</div>
            <div class="cu-player-pos">${esc(p.position || "—")}${p.notes ? " · " + esc(p.notes) : ""}</div>
          </div>
          ${alreadyRequested
            ? `<span style="margin-left:auto;font-size:0.75rem;color:#8ab4f8">Requested</span>`
            : `<button class="cu-request-btn" data-player-id="${esc(p.id)}" data-team-id="${esc(team.id)}">Request</button>`}
        </div>`;
    }).join("");

    return `
      <div class="cu-team-group">
        <div class="cu-team-header">
          ${swatch}
          <span class="cu-team-name">${esc(team.name)}</span>
          ${divBadge}
          ${team.coachName ? `<span style="font-size:0.82rem;color:var(--light-text)">Coach: ${esc(team.coachName)}</span>` : ""}
        </div>
        <div class="cu-player-grid">${cards}</div>
      </div>`;
  }).join("");

  if (!sections.trim()) {
    wrap.innerHTML = `<p style="color:var(--light-text)">No eligible players found matching your filters.</p>`;
    return;
  }
  wrap.innerHTML = sections;

  // Wire request buttons
  wrap.querySelectorAll(".cu-request-btn").forEach(btn => {
    btn.addEventListener("click", () => openRequestModal(btn.dataset.playerId, btn.dataset.teamId));
  });
}

// ── Request Modal ─────────────────────────────────────────────────────────────

function openRequestModal(playerId, teamId) {
  const team = eligibleTeams.find(t => t.id === teamId);
  const players = rostersByTeam[teamId] || [];
  const player = players.find(p => p.id === playerId);
  if (!team || !player) return;

  pendingRequest = { player, team };

  document.getElementById("cuModalPlayerInfo").innerHTML = `
    <div style="margin-bottom:6px">
      <strong>${esc(player.firstName)} ${esc(player.lastName)}</strong>
      ${player.number ? `<span style="color:var(--light-text);margin-left:6px">#${esc(player.number)}</span>` : ""}
      ${player.position ? `<span style="color:var(--light-text);margin-left:6px">${esc(player.position)}</span>` : ""}
    </div>
    <div style="font-size:0.85rem;color:var(--light-text)">
      From: <strong style="color:var(--text)">${esc(team.name)}</strong> (${esc(team.division)})
    </div>`;

  // Show team selector only when coach coaches multiple teams
  const teamGroup = document.getElementById("cuReqTeamGroup");
  const teamSel   = document.getElementById("cuReqTeamSel");
  if (myTeams.length > 1) {
    teamSel.innerHTML = myTeams.map(t =>
      `<option value="${esc(t.id)}">${esc(t.name)} (${esc(t.division)})</option>`
    ).join("");
    teamGroup.style.display = "";
  } else {
    teamGroup.style.display = "none";
  }

  document.getElementById("cuReqReason").value = "";
  document.getElementById("cuReqDate").value = "";
  document.getElementById("cuModalMsg").textContent = "";
  document.getElementById("cuModalMsg").className = "signup-message";
  document.getElementById("cuModalOverlay").style.display = "";
  document.getElementById("cuReqDate").focus();
}

document.getElementById("cuModalCancelBtn").addEventListener("click", closeRequestModal);
document.getElementById("cuModalOverlay").addEventListener("click", e => {
  if (e.target === document.getElementById("cuModalOverlay")) closeRequestModal();
});

function closeRequestModal() {
  document.getElementById("cuModalOverlay").style.display = "none";
  pendingRequest = null;
}

document.getElementById("cuModalSubmitBtn").addEventListener("click", async () => {
  if (!pendingRequest) return;
  const reason = document.getElementById("cuReqReason").value.trim();
  if (!reason) {
    document.getElementById("cuReqReason").focus();
    return;
  }
  const msgEl = document.getElementById("cuModalMsg");
  const btn   = document.getElementById("cuModalSubmitBtn");
  btn.disabled = true;
  msgEl.textContent = "Sending…";
  msgEl.className   = "signup-message info";

  const { player, team: homeTeam } = pendingRequest;
  // Resolve requesting team — use selector when coaching multiple teams
  const selTeamId = document.getElementById("cuReqTeamSel").value;
  const myTeam = (myTeams.length > 1 && selTeamId)
    ? myTeams.find(t => t.id === selTeamId) || myTeams[0]
    : myTeams[0];
  try {
    await addDoc(collection(db, "callupRequests"), {
      requestingCoachId:   currentUid,
      requestingCoachName: myTeam?.coachName || "",
      requestingCoachEmail:myTeam?.coachEmail || "",
      requestingTeamId:    myTeam?.id || "",
      requestingTeamName:  myTeam?.name || "",
      requestingTeamDiv:   myTeam?.division || "",
      homeCoachId:         homeTeam.coachId || "",
      homeCoachName:       homeTeam.coachName || "",
      homeCoachEmail:      homeTeam.coachEmail || "",
      homeTeamId:          homeTeam.id,
      homeTeamName:        homeTeam.name,
      homeTeamDiv:         homeTeam.division,
      playerId:            player.id,
      playerFirstName:     player.firstName,
      playerLastName:      player.lastName,
      playerNumber:        player.number || "",
      playerPosition:      player.position || "",
      gameDate:            document.getElementById("cuReqDate").value || "",
      reason,
      status:              "pending",
      requestedAt:         serverTimestamp(),
      respondedAt:         null,
      responseNote:        "",
    });

    msgEl.textContent = "✓ Request sent!";
    msgEl.className   = "signup-message success";
    setTimeout(() => {
      closeRequestModal();
      // Reload data to reflect new request
      loadAll();
    }, 900);
  } catch (err) {
    msgEl.textContent = "Error: " + (err.message || String(err));
    msgEl.className   = "signup-message error";
    btn.disabled = false;
  }
});

// ── Outgoing Requests ─────────────────────────────────────────────────────────

function renderOutgoing() {
  const el = document.getElementById("cuOutgoingList");
  if (!outgoing.length) {
    el.innerHTML = `<div class="document-note"><p style="margin:0">You haven't made any call-up requests yet. Use <strong>Find Players</strong> to get started.</p></div>`;
    return;
  }
  el.innerHTML = outgoing.map(r => `
    <div class="cu-request-row">
      <div class="cu-request-info">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
          <strong>${esc(r.playerFirstName)} ${esc(r.playerLastName)}</strong>
          ${r.playerNumber ? `<span style="color:var(--light-text);font-size:0.85rem">#${esc(r.playerNumber)}</span>` : ""}
          ${r.playerPosition ? `<span style="color:var(--light-text);font-size:0.85rem">${esc(r.playerPosition)}</span>` : ""}
          ${statusPill(r.status)}
        </div>
        <div style="font-size:0.85rem;color:var(--light-text)">
          From: <strong style="color:var(--text)">${esc(r.homeTeamName)}</strong> (${esc(r.homeTeamDiv || "")})
          · Coach: ${esc(r.homeCoachName || "—")}
        </div>
        ${r.gameDate ? `<div style="font-size:0.85rem;color:var(--light-text);margin-top:2px">📅 ${formatDate(r.gameDate)}</div>` : ""}
        ${r.reason ? `<div style="font-size:0.85rem;margin-top:4px">${esc(r.reason)}</div>` : ""}
        ${r.responseNote ? `<div style="font-size:0.85rem;color:#8ab4f8;margin-top:4px;font-style:italic">Response: "${esc(r.responseNote)}"</div>` : ""}
        <div style="font-size:0.78rem;color:var(--light-text);margin-top:4px">
          Requested ${r.requestedAt?.toDate?.()?.toLocaleDateString() || ""}
        </div>
      </div>
      ${r.status === "pending" ? `
        <button type="button" class="btn print-btn cu-withdraw-btn" data-id="${esc(r.id)}"
          style="font-size:0.82rem;padding:5px 12px;color:#ffb4b4;border-color:#7a2a2a;align-self:flex-start">
          Withdraw
        </button>` : ""}
    </div>`).join("");

  el.querySelectorAll(".cu-withdraw-btn").forEach(btn => {
    btn.addEventListener("click", () => withdrawRequest(btn.dataset.id));
  });
}

async function withdrawRequest(id) {
  if (!confirm("Withdraw this call-up request?")) return;
  try {
    await updateDoc(doc(db, "callupRequests", id), {
      status: "withdrawn",
      respondedAt: serverTimestamp(),
    });
    outgoing = outgoing.map(r => r.id === id ? { ...r, status: "withdrawn" } : r);
    updateBadges();
    renderOutgoing();
    renderPlayerBrowse(); // refresh "Requested" dim state
  } catch (err) {
    alert("Error: " + err.message);
  }
}

// ── Incoming Requests ─────────────────────────────────────────────────────────

function renderIncoming() {
  const el = document.getElementById("cuIncomingList");
  if (!incoming.length) {
    el.innerHTML = `<div class="document-note"><p style="margin:0">No call-up requests for your team's players yet.</p></div>`;
    return;
  }
  el.innerHTML = incoming.map(r => `
    <div class="cu-request-row">
      <div class="cu-request-info">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
          <strong>${esc(r.playerFirstName)} ${esc(r.playerLastName)}</strong>
          ${r.playerNumber ? `<span style="color:var(--light-text);font-size:0.85rem">#${esc(r.playerNumber)}</span>` : ""}
          ${r.playerPosition ? `<span style="color:var(--light-text);font-size:0.85rem">${esc(r.playerPosition)}</span>` : ""}
          ${statusPill(r.status)}
        </div>
        <div style="font-size:0.85rem;color:var(--light-text)">
          Requested by: <strong style="color:var(--text)">${esc(r.requestingTeamName)}</strong>
          · Coach: ${esc(r.requestingCoachName || "—")}
        </div>
        ${r.gameDate ? `<div style="font-size:0.85rem;color:var(--light-text);margin-top:2px">📅 ${formatDate(r.gameDate)}</div>` : ""}
        ${r.reason ? `<div style="font-size:0.85rem;margin-top:4px">${esc(r.reason)}</div>` : ""}
        ${r.responseNote ? `<div style="font-size:0.85rem;color:#8ab4f8;margin-top:4px;font-style:italic">Your response: "${esc(r.responseNote)}"</div>` : ""}
        <div style="font-size:0.78rem;color:var(--light-text);margin-top:4px">
          Requested ${r.requestedAt?.toDate?.()?.toLocaleDateString() || ""}
        </div>
      </div>
      ${r.status === "pending" ? `
        <button type="button" class="btn cu-respond-btn" data-id="${esc(r.id)}"
          style="font-size:0.82rem;padding:5px 14px;align-self:flex-start">
          Respond
        </button>` : ""}
    </div>`).join("");

  el.querySelectorAll(".cu-respond-btn").forEach(btn => {
    btn.addEventListener("click", () => openRespondModal(btn.dataset.id));
  });
}

// ── Respond Modal ─────────────────────────────────────────────────────────────

function openRespondModal(requestId) {
  const r = incoming.find(x => x.id === requestId);
  if (!r) return;
  document.getElementById("cuRespondId").value = requestId;
  document.getElementById("cuRespondInfo").innerHTML = `
    <div style="margin-bottom:6px">
      <strong>${esc(r.playerFirstName)} ${esc(r.playerLastName)}</strong>
      ${r.playerNumber ? `<span style="color:var(--light-text);margin-left:6px">#${esc(r.playerNumber)}</span>` : ""}
      requested by <strong>${esc(r.requestingTeamName)}</strong>
    </div>
    ${r.gameDate ? `<div style="font-size:0.85rem;color:var(--light-text)">📅 ${formatDate(r.gameDate)}</div>` : ""}
    ${r.reason ? `<div style="font-size:0.85rem;margin-top:4px">${esc(r.reason)}</div>` : ""}`;
  document.getElementById("cuRespondNote").value = "";
  document.getElementById("cuRespondMsg").textContent = "";
  document.getElementById("cuRespondMsg").className = "signup-message";
  document.getElementById("cuRespondOverlay").style.display = "";
}

document.getElementById("cuRespondCancelBtn").addEventListener("click", () => {
  document.getElementById("cuRespondOverlay").style.display = "none";
});
document.getElementById("cuRespondOverlay").addEventListener("click", e => {
  if (e.target === document.getElementById("cuRespondOverlay"))
    document.getElementById("cuRespondOverlay").style.display = "none";
});

async function respondToRequest(status) {
  const id   = document.getElementById("cuRespondId").value;
  const note = document.getElementById("cuRespondNote").value.trim();
  const msgEl = document.getElementById("cuRespondMsg");
  const approveBtn = document.getElementById("cuApproveBtn");
  const declineBtn = document.getElementById("cuDeclineBtn");
  [approveBtn, declineBtn].forEach(b => b.disabled = true);
  msgEl.textContent = "Saving…";
  msgEl.className   = "signup-message info";
  try {
    await updateDoc(doc(db, "callupRequests", id), {
      status,
      responseNote: note,
      respondedAt:  serverTimestamp(),
    });
    incoming = incoming.map(r => r.id === id ? { ...r, status, responseNote: note } : r);
    updateBadges();
    document.getElementById("cuRespondOverlay").style.display = "none";
    renderIncoming();
  } catch (err) {
    msgEl.textContent = "Error: " + err.message;
    msgEl.className   = "signup-message error";
    [approveBtn, declineBtn].forEach(b => b.disabled = false);
  }
}

document.getElementById("cuApproveBtn").addEventListener("click", () => respondToRequest("approved"));
document.getElementById("cuDeclineBtn").addEventListener("click", () => respondToRequest("declined"));

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  const user = getCurrentUser();
  if (!user) {
    document.getElementById("cuContent").style.display = "none";
    document.getElementById("cuNoAccess").style.display = "";
    return;
  }

  // Check coaches collection
  getDoc(doc(db, "coaches", user.uid)).then(snap => {
    if (!snap.exists() || snap.data().approved !== true) {
      document.getElementById("cuContent").style.display = "none";
      document.getElementById("cuNoAccess").style.display = "";
      return;
    }
    currentUid = user.uid;
    loadAll();
  });
});
