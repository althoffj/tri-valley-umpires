// admin-teams.js — Teams & Leagues management
import { db }                             from "./firebase.js";
import { authReadyPromise, isAdmin }      from "./auth.js";
import { esc, showToast, showConfirm } from "./utils.js";

import {
  collection, getDocs, getDoc, addDoc, setDoc, updateDoc, deleteDoc,
  doc, query, where, orderBy, arrayUnion, arrayRemove, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── State ─────────────────────────────────────────────────────────────────────

let teams                = [];   // [{id, name, division, city, icsUrl, color, needsUmpireForHome, ...}]
let leagues              = [];   // [{id, name, division, websiteUrl, notes, contacts, homeLocations}]
let facilitiesForLeagues = [];   // [{id, name, address}]
let teamCoaches          = [];   // approved coaches for team-form dropdown
let allSponsors          = [];   // all sponsors (for assign dropdown)
let rosterPlayers        = [];   // [{id, number, firstName, lastName, position, notes}] for team in edit
let activeSection        = "teams";

// Generate a stable ID for a team from its name
function makeTeamId(name) {
  return "t_" + name.replace(/\W+/g, "_").toLowerCase().replace(/^_|_$/g, "");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Section navigation ────────────────────────────────────────────────────────

function switchSection(section) {
  activeSection = section;
  document.querySelectorAll(".sched-sec-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.section === section);
  });
  ["teams","leagues"].forEach(s => {
    const el = document.getElementById(`sec-${s}`);
    if (el) el.style.display = s === section ? "" : "none";
  });
  if (section === "leagues") loadLeagues();
}

document.querySelectorAll(".sched-sec-btn").forEach(btn => {
  btn.addEventListener("click", () => switchSection(btn.dataset.section));
});

// ══════════════════════════════════════════════════════════════════════════════
//  TEAMS SECTION
// ══════════════════════════════════════════════════════════════════════════════

async function loadTeams() {
  // Fetch teams independently so leagues/coaches failures never wipe team data
  try {
    const teamsSnap = await getDoc(doc(db, "config/teamCalendars"));
    teams = teamsSnap.exists() ? (teamsSnap.data().teams || []) : [];
  } catch {
    teams = [];
  }
  // Leagues fetch — failure is isolated
  try {
    const leaguesSnap = await getDocs(query(collection(db, "leagues"), orderBy("name")));
    leagues = leaguesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    leagues = [];
  }
  // Coaches fetch — a missing composite index should not break the team list
  try {
    const coachesSnap = await getDocs(query(collection(db, "coaches"), where("approved", "==", true)));
    teamCoaches = coachesSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  } catch {
    teamCoaches = [];
  }
  // Sponsors fetch — for team-side assignment
  try {
    const sponsorsSnap = await getDocs(query(collection(db, "sponsors"), orderBy("name")));
    allSponsors = sponsorsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    allSponsors = [];
  }
  // Ensure every team has a stable id
  let needResave = false;
  teams.forEach(t => {
    if (!t.id) { t.id = makeTeamId(t.name); needResave = true; }
  });
  if (needResave) await saveTeams(false);

  renderTeamList();
  populateLeagueSelector();
  populateCoachSelector();
}

async function saveTeams(showMsg) {
  await setDoc(doc(db, "config/teamCalendars"), { teams }, { merge: true });
  if (showMsg) {
    const msg = document.getElementById("teamFormMsg");
    msg.textContent = "✓ Saved.";
    msg.className = "signup-message success";
    setTimeout(() => { msg.textContent = ""; msg.className = "signup-message"; }, 2000);
  }
}

function renderTeamList() {
  const el = document.getElementById("teamList");
  if (!el) return;
  if (!teams.length) {
    el.innerHTML = `<p style="color:var(--light-text);margin-bottom:12px">No teams configured yet. Add your first team below.</p>`;
    return;
  }
  el.innerHTML = teams.map((t, i) => `
    <div class="team-row">
      <span class="team-color-swatch" style="background:${esc(t.color || "#601929")}"></span>
      <span class="team-row-name">${esc(t.name)}</span>
      <span class="team-row-meta">${esc(t.division || "")}${t.city ? " · " + esc(t.city) : ""}${t.coachName ? " · Coach: " + esc(t.coachName) : ""}</span>
      ${t.needsUmpireForHome ? `<span class="team-needs-ump">⚾ Needs umpire</span>` : ""}
      ${(t.leagueNames || (t.leagueName ? [t.leagueName] : [])).map(n => `<span style="font-size:0.75rem;color:#8ab4f8;background:rgba(91,141,217,0.12);border:1px solid rgba(91,141,217,0.3);border-radius:4px;padding:1px 6px">🏆 ${esc(n)}</span>`).join("")}
      ${t.icsUrl ? `<span style="color:var(--light-text);font-size:0.78rem">📅 iCal linked</span>` : ""}
      <div style="margin-left:auto;display:flex;gap:6px">
        <button type="button" class="btn print-btn team-edit-btn" data-idx="${i}" style="padding:4px 10px;font-size:0.82rem">Edit</button>
        <button type="button" class="btn print-btn team-delete-btn" data-idx="${i}" style="padding:4px 10px;font-size:0.82rem;color:#ff8a8a;border-color:#ff8a8a">Delete</button>
      </div>
    </div>`).join("");

  el.querySelectorAll(".team-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => startEditTeam(parseInt(btn.dataset.idx)));
  });
  el.querySelectorAll(".team-delete-btn").forEach(btn => {
    btn.addEventListener("click", () => deleteTeam(parseInt(btn.dataset.idx)));
  });
}

function startEditTeam(idx) {
  const t = teams[idx];
  document.getElementById("teamEditIndex").value = idx;
  document.getElementById("tName").value         = t.name || "";
  document.getElementById("tDivision").value     = t.division || "";
  document.getElementById("tCity").value         = t.city || "";
  document.getElementById("tColor").value        = t.color || "#601929";
  document.getElementById("tIcsUrl").value       = t.icsUrl || "";
  document.getElementById("tNeedsUmpire").checked = !!t.needsUmpireForHome;
  // Support new leagueIds array or fall back to legacy single leagueId
  const selectedLeagueIds = Array.isArray(t.leagueIds) ? t.leagueIds : (t.leagueId ? [t.leagueId] : []);
  document.querySelectorAll("#tLeagueCheckboxes .league-select-cb").forEach(cb => {
    cb.checked = selectedLeagueIds.includes(cb.value);
  });
  populateCoachSelector(t.coachId || "");
  document.getElementById("teamFormTitle").textContent = "Edit Team";
  document.getElementById("teamFormSubmitBtn").textContent = "Save Changes";
  document.getElementById("teamFormCancelBtn").style.display = "";
  document.getElementById("tName").focus();
  document.getElementById("teamFormWrap").scrollIntoView({ behavior: "smooth" });
  // Show roster and sponsor sections for existing teams with a stable ID
  if (t.id) {
    const rosterSec = document.getElementById("tRosterSection");
    if (rosterSec) rosterSec.style.display = "";
    loadRosterForTeam(t.id);
    const sponsorSec = document.getElementById("tSponsorSection");
    if (sponsorSec) sponsorSec.style.display = "";
    loadSponsorsForTeam(t.id);
  }
}

function cancelEditTeam() {
  document.getElementById("teamEditIndex").value = "";
  document.getElementById("teamForm").reset();
  document.getElementById("tColor").value = "#601929";
  document.getElementById("teamFormTitle").textContent = "Add Team";
  document.getElementById("teamFormSubmitBtn").textContent = "Add Team";
  document.getElementById("teamFormCancelBtn").style.display = "none";
  document.getElementById("teamFormMsg").textContent = "";
  document.getElementById("teamFormMsg").className = "signup-message";
  hideRosterSection();
  hideSponsorSection();
  // Hide and clear the add-player form if open
  const playerForm = document.getElementById("tPlayerFormWrap");
  if (playerForm) playerForm.style.display = "none";
}

// ── Roster management ─────────────────────────────────────────────────────────

function hideRosterSection() {
  const sec = document.getElementById("tRosterSection");
  if (sec) sec.style.display = "none";
  rosterPlayers = [];
}

async function loadRosterForTeam(teamId) {
  const listEl = document.getElementById("tRosterList");
  const countEl = document.getElementById("tRosterCount");
  if (!listEl) return;

  listEl.innerHTML = `<p style="color:var(--light-text);font-size:0.85rem;margin:0">Loading…</p>`;

  try {
    const snap = await getDoc(doc(db, "rosters", teamId));
    rosterPlayers = snap.exists() ? (snap.data().players || []) : [];
  } catch {
    rosterPlayers = [];
  }

  renderRosterTable(countEl);
}

function renderRosterTable(countEl) {
  countEl = countEl || document.getElementById("tRosterCount");
  const listEl = document.getElementById("tRosterList");
  if (!listEl) return;

  const count = rosterPlayers.length;
  if (countEl) countEl.textContent = count ? ` — ${count} player${count !== 1 ? "s" : ""}` : "";

  if (!count) {
    listEl.innerHTML = `<p style="color:var(--light-text);font-size:0.85rem;margin:0">No players on this roster yet. Click "+ Add Player" to start.</p>`;
    return;
  }

  // Sort: by number (numeric) then last name
  const sorted = [...rosterPlayers].sort((a, b) => {
    const numA = parseInt(a.number) || 999, numB = parseInt(b.number) || 999;
    if (numA !== numB) return numA - numB;
    return (a.lastName || "").localeCompare(b.lastName || "");
  });

  listEl.innerHTML = `
    <table class="roster-table">
      <thead>
        <tr>
          <th class="roster-num">#</th>
          <th>Name</th>
          <th class="roster-pos">Pos</th>
          <th>Notes</th>
          <th style="width:56px"></th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(p => `
          <tr data-player-id="${esc(p.id)}">
            <td class="roster-num">${esc(p.number || "—")}</td>
            <td><strong>${esc(p.firstName)} ${esc(p.lastName)}</strong></td>
            <td class="roster-pos">${esc(p.position || "—")}</td>
            <td class="roster-notes">${esc(p.notes || "")}</td>
            <td><button type="button" class="roster-del-btn" data-player-id="${esc(p.id)}">Remove</button></td>
          </tr>`).join("")}
      </tbody>
    </table>`;

  listEl.querySelectorAll(".roster-del-btn").forEach(btn => {
    btn.addEventListener("click", () => removeRosterPlayer(btn.dataset.playerId));
  });
}

function removeRosterPlayer(playerId) {
  rosterPlayers = rosterPlayers.filter(p => p.id !== playerId);
  renderRosterTable();
}

async function saveRosterForTeam(teamId) {
  const msgEl = document.getElementById("tRosterMsg");
  const btn   = document.getElementById("tSaveRosterBtn");
  if (!teamId) return;
  btn.disabled = true;
  msgEl.textContent = "Saving…";
  msgEl.className   = "signup-message info";
  try {
    await setDoc(doc(db, "rosters", teamId), {
      players:   rosterPlayers,
      updatedAt: serverTimestamp(),
    });
    msgEl.textContent = `✓ Roster saved (${rosterPlayers.length} player${rosterPlayers.length !== 1 ? "s" : ""}).`;
    msgEl.className   = "signup-message success";
    setTimeout(() => { msgEl.textContent = ""; msgEl.className = "signup-message"; }, 2500);
  } catch (err) {
    msgEl.textContent = "Error: " + err.message;
    msgEl.className   = "signup-message error";
  } finally {
    btn.disabled = false;
  }
}

// Wire roster buttons
document.getElementById("tAddPlayerBtn")?.addEventListener("click", () => {
  document.getElementById("tPlayerFormWrap").style.display = "";
  document.getElementById("tPlayerFirst").focus();
});

document.getElementById("tCancelPlayerBtn")?.addEventListener("click", () => {
  document.getElementById("tPlayerFormWrap").style.display = "none";
  ["tPlayerNumber","tPlayerFirst","tPlayerLast","tPlayerNotes"].forEach(id => {
    document.getElementById(id).value = "";
  });
  document.getElementById("tPlayerPosition").value = "";
});

document.getElementById("tSavePlayerBtn")?.addEventListener("click", () => {
  const first = document.getElementById("tPlayerFirst").value.trim();
  const last  = document.getElementById("tPlayerLast").value.trim();
  if (!first && !last) {
    document.getElementById("tPlayerFirst").focus();
    return;
  }
  const player = {
    id:        crypto.randomUUID(),
    number:    document.getElementById("tPlayerNumber").value.trim(),
    firstName: first,
    lastName:  last,
    position:  document.getElementById("tPlayerPosition").value,
    notes:     document.getElementById("tPlayerNotes").value.trim(),
  };
  rosterPlayers.push(player);
  renderRosterTable();
  // Clear and hide form
  ["tPlayerNumber","tPlayerFirst","tPlayerLast","tPlayerNotes"].forEach(id => {
    document.getElementById(id).value = "";
  });
  document.getElementById("tPlayerPosition").value = "";
  document.getElementById("tPlayerFormWrap").style.display = "none";
});

// Allow pressing Enter in the add-player form to submit
document.getElementById("tPlayerFormWrap")?.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("tSavePlayerBtn").click();
  }
});

document.getElementById("tSaveRosterBtn")?.addEventListener("click", () => {
  const teamIdx = document.getElementById("teamEditIndex").value;
  if (teamIdx === "") return;
  const team = teams[parseInt(teamIdx)];
  if (team?.id) saveRosterForTeam(team.id);
});

// ── Team-side sponsor management ──────────────────────────────────────────────

function hideSponsorSection() {
  const sec = document.getElementById("tSponsorSection");
  if (sec) sec.style.display = "none";
}

async function loadSponsorsForTeam(teamId) {
  const listEl = document.getElementById("tSponsorList");
  const selEl  = document.getElementById("tAddSponsorSel");
  if (!listEl || !selEl) return;

  listEl.innerHTML = `<p style="color:var(--light-text);font-size:0.85rem;margin:0">Loading…</p>`;

  let assigned = [];
  try {
    const snap = await getDocs(query(
      collection(db, "sponsors"),
      where("teamIds", "array-contains", teamId)
    ));
    assigned = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    assigned = [];
  }

  // Render assigned sponsor chips
  if (!assigned.length) {
    listEl.innerHTML = `<p style="color:var(--light-text);font-size:0.85rem;margin:0">No sponsors assigned yet.</p>`;
  } else {
    listEl.innerHTML = assigned.map(sp => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#1e2a3a;border-radius:6px;border:1px solid #2a3a4a">
        ${sp.logoUrl
          ? `<img src="${esc(sp.logoUrl)}" alt="" style="width:28px;height:28px;object-fit:contain;border-radius:4px;background:#111;border:1px solid #333;flex-shrink:0" />`
          : `<span style="font-size:1rem">🏢</span>`}
        <span style="font-size:0.9rem;font-weight:600">${esc(sp.name)}</span>
        ${!sp.active ? `<span style="font-size:0.72rem;color:#ffb4b4;background:#3a1a1a;border-radius:4px;padding:1px 6px">Inactive</span>` : ""}
        <button type="button" class="ts-unassign-btn" data-sponsor-id="${esc(sp.id)}" data-team-id="${esc(teamId)}"
          style="margin-left:auto;font-size:0.8rem;padding:3px 8px;background:transparent;color:#ff8a8a;border:1px solid #ff6a6a;border-radius:4px;cursor:pointer">
          Unassign
        </button>
      </div>`).join("");

    listEl.querySelectorAll(".ts-unassign-btn").forEach(btn => {
      btn.addEventListener("click", () => unassignSponsorFromTeam(btn.dataset.sponsorId, btn.dataset.teamId));
    });
  }

  // Populate assign dropdown with unassigned sponsors
  const assignedIds = new Set(assigned.map(s => s.id));
  const unassigned = allSponsors.filter(s => !assignedIds.has(s.id));
  selEl.innerHTML = '<option value="">— Assign a sponsor —</option>' +
    unassigned.map(s =>
      `<option value="${esc(s.id)}">${esc(s.name)}${!s.active ? " (inactive)" : ""}</option>`
    ).join("");
}

async function assignSponsorToTeam(sponsorId, teamId, teamName) {
  const msgEl = document.getElementById("tSponsorMsg");
  if (!sponsorId || !teamId) return;
  try {
    msgEl.textContent = "Assigning…";
    msgEl.className   = "signup-message info";
    // Add to sponsor's teamIds array and teamAssignments (amount 0 by default)
    const sponsorRef = doc(db, "sponsors", sponsorId);
    const sponsorSnap = await getDoc(sponsorRef);
    if (!sponsorSnap.exists()) throw new Error("Sponsor not found.");
    const sponsorData = sponsorSnap.data();
    const existing = (sponsorData.teamAssignments || []).find(a => a.teamId === teamId);
    if (!existing) {
      await updateDoc(sponsorRef, {
        teamIds: arrayUnion(teamId),
        teamAssignments: arrayUnion({ teamId, teamName, amount: 0 }),
      });
    }
    // Refresh sponsor data cache
    const updSnap = await getDocs(query(collection(db, "sponsors"), orderBy("name")));
    allSponsors = updSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    msgEl.textContent = "✓ Assigned.";
    msgEl.className   = "signup-message success";
    setTimeout(() => { msgEl.textContent = ""; msgEl.className = "signup-message"; }, 2000);
    await loadSponsorsForTeam(teamId);
    document.getElementById("tAddSponsorSel").value = "";
  } catch (err) {
    msgEl.textContent = "Error: " + err.message;
    msgEl.className   = "signup-message error";
  }
}

async function unassignSponsorFromTeam(sponsorId, teamId) {
  if (!await showConfirm("Remove this sponsor from the team?")) return;
  const msgEl = document.getElementById("tSponsorMsg");
  try {
    msgEl.textContent = "Removing…";
    msgEl.className   = "signup-message info";
    const sponsorRef  = doc(db, "sponsors", sponsorId);
    const sponsorSnap = await getDoc(sponsorRef);
    if (!sponsorSnap.exists()) throw new Error("Sponsor not found.");
    const sponsorData = sponsorSnap.data();
    const assignment  = (sponsorData.teamAssignments || []).find(a => a.teamId === teamId);
    const updates = { teamIds: arrayRemove(teamId) };
    if (assignment) updates.teamAssignments = arrayRemove(assignment);
    await updateDoc(sponsorRef, updates);
    // Refresh sponsor data cache
    const updSnap = await getDocs(query(collection(db, "sponsors"), orderBy("name")));
    allSponsors = updSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    msgEl.textContent = "✓ Removed.";
    msgEl.className   = "signup-message success";
    setTimeout(() => { msgEl.textContent = ""; msgEl.className = "signup-message"; }, 2000);
    await loadSponsorsForTeam(teamId);
  } catch (err) {
    msgEl.textContent = "Error: " + err.message;
    msgEl.className   = "signup-message error";
  }
}

document.getElementById("tAddSponsorBtn")?.addEventListener("click", () => {
  const teamIdx = document.getElementById("teamEditIndex").value;
  if (teamIdx === "") return;
  const team = teams[parseInt(teamIdx)];
  const sponsorId = document.getElementById("tAddSponsorSel")?.value;
  if (!sponsorId || !team?.id) return;
  assignSponsorToTeam(sponsorId, team.id, team.name);
});

async function deleteTeam(idx) {
  if (!await showConfirm(`Delete team "${teams[idx].name}"?`)) return;
  teams.splice(idx, 1);
  renderTeamList();
  await saveTeams(false);
}

document.getElementById("teamFormCancelBtn").addEventListener("click", cancelEditTeam);

document.getElementById("teamForm").addEventListener("submit", async e => {
  e.preventDefault();
  const msg = document.getElementById("teamFormMsg");
  const checkedLeagues = [...document.querySelectorAll("#tLeagueCheckboxes .league-select-cb:checked")]
    .map(cb => ({ id: cb.value, name: cb.dataset.name || "" }));
  const leagueIds   = checkedLeagues.map(l => l.id);
  const leagueNames = checkedLeagues.map(l => l.name);
  const coachId   = document.getElementById("tCoach")?.value || "";
  const coachObj  = teamCoaches.find(c => c.id === coachId);
  const nameVal  = document.getElementById("tName").value.trim();
  if (!nameVal) return;
  const editIdx  = document.getElementById("teamEditIndex").value;
  // Preserve existing stable ID on edit; generate for new teams
  const existingId = editIdx !== "" ? (teams[parseInt(editIdx)].id || makeTeamId(nameVal)) : makeTeamId(nameVal);
  const teamData = {
    id:                 existingId,
    name:               nameVal,
    division:           document.getElementById("tDivision").value,
    city:               document.getElementById("tCity").value,
    color:              document.getElementById("tColor").value,
    icsUrl:             document.getElementById("tIcsUrl").value.trim(),
    needsUmpireForHome: document.getElementById("tNeedsUmpire").checked,
    leagueIds,
    leagueNames,
    leagueId:           leagueIds[0]   || "",
    leagueName:         leagueNames[0] || "",
    coachId,
    coachName:          coachObj?.name || "",
    coachEmail:         coachObj?.email || "",
    coachPhone:         coachObj?.phone || "",
  };

  if (editIdx !== "") {
    teams[parseInt(editIdx)] = teamData;
  } else {
    teams.push(teamData);
  }

  try {
    msg.textContent = "Saving…";
    msg.className   = "signup-message info";
    await saveTeams(false);
    msg.textContent = "✓ Team saved.";
    msg.className   = "signup-message success";
    cancelEditTeam();
    renderTeamList();
    // Refresh sponsor list in case it was open
    hideSponsorSection();
    setTimeout(() => { msg.textContent = ""; msg.className = "signup-message"; }, 2000);
  } catch (err) {
    msg.textContent = "Error: " + err.message;
    msg.className   = "signup-message error";
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  LEAGUES SECTION
// ══════════════════════════════════════════════════════════════════════════════

async function loadLeagues() {
  try {
    const [leaguesSnap, facSnap] = await Promise.all([
      getDocs(query(collection(db, "leagues"), orderBy("name"))),
      getDocs(collection(db, "facilities")),
    ]);
    leagues              = leaguesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    facilitiesForLeagues = facSnap.docs.map(d => ({ id: d.id, name: d.data().name || "", address: d.data().address || "" }));
  } catch (err) {
    leagues = []; facilitiesForLeagues = [];
    console.error("loadLeagues:", err);
  }
  renderLeagueList();
  populateLeagueLocations();
  populateLeagueSelector();
}

function populateLeagueSelector() {
  const wrap = document.getElementById("tLeagueCheckboxes");
  if (!wrap) return;
  const emptyMsg = document.getElementById("tLeagueEmpty");
  if (!leagues.length) {
    wrap.innerHTML = '<span style="color:var(--light-text);font-size:0.85rem" id="tLeagueEmpty">No leagues available</span>';
    return;
  }
  wrap.innerHTML = leagues.map(l =>
    `<label style="display:flex;align-items:center;gap:6px;font-weight:normal;cursor:pointer;white-space:nowrap">
       <input type="checkbox" class="league-select-cb" value="${esc(l.id)}" data-name="${esc(l.name)}" />
       ${esc(l.name)}${l.division ? ` <span style="color:var(--light-text);font-size:0.8rem">(${esc(l.division)})</span>` : ""}
     </label>`
  ).join("");
}

function populateCoachSelector(selectedId = "") {
  const sel = document.getElementById("tCoach");
  if (!sel) return;
  sel.innerHTML = '<option value="">— No coach assigned —</option>' +
    teamCoaches.map(c =>
      `<option value="${esc(c.id)}"${c.id === selectedId ? " selected" : ""}>${esc(c.name)}${c.teamName ? " (" + esc(c.teamName) + ")" : ""}</option>`
    ).join("");
}

function populateLeagueLocations(checkedIds = []) {
  const wrap = document.getElementById("lLocationsWrap");
  if (!wrap) return;
  if (!facilitiesForLeagues.length) {
    wrap.innerHTML = `<p style="color:var(--light-text);font-size:0.85rem;margin:0">No facilities configured yet — add some in the <a href="admin-facilities.html" style="color:#8ab4f8">Facilities</a> page first.</p>`;
    return;
  }
  wrap.innerHTML = facilitiesForLeagues.map(f =>
    `<label style="display:flex;align-items:center;gap:6px;font-weight:normal;cursor:pointer;padding:3px 0;min-width:180px">
       <input type="checkbox" class="league-location-cb" value="${esc(f.id)}" data-name="${esc(f.name)}"${checkedIds.includes(f.id) ? " checked" : ""} />
       <span>${esc(f.name)}${f.address ? `<span style="color:var(--light-text);font-size:0.8rem;margin-left:4px">${esc(f.address)}</span>` : ""}</span>
     </label>`
  ).join("");
}

function renderLeagueList() {
  const el = document.getElementById("leagueList");
  if (!el) return;
  if (!leagues.length) {
    el.innerHTML = `<p style="color:var(--light-text)">No leagues configured yet. Add your first league below.</p>`;
    return;
  }
  el.innerHTML = leagues.map(l => {
    const divBadge = l.division
      ? `<span style="font-size:0.75rem;background:rgba(96,25,41,0.3);border:1px solid #601929;border-radius:4px;padding:1px 6px;color:#ffb0b0">${esc(l.division)}</span>`
      : "";
    const websiteLink = l.websiteUrl
      ? `<a href="${esc(l.websiteUrl)}" target="_blank" rel="noopener" style="font-size:0.85rem;color:#8ab4f8">${esc(l.websiteUrl)}</a>`
      : "";
    const locations = (l.homeLocations || []).map(loc => esc(loc.facilityName)).join(" · ");
    const contacts = (l.contacts || []).map(c => `
      <div style="display:flex;gap:12px;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid #2a2a2a;font-size:0.85rem;align-items:baseline">
        <div>
          <strong>${esc(c.name)}</strong>
          ${c.role ? `<span style="color:var(--light-text);margin-left:6px;font-size:0.8rem">${esc(c.role)}</span>` : ""}
        </div>
        ${c.email ? `<a href="mailto:${esc(c.email)}" style="color:#8ab4f8">${esc(c.email)}</a>` : ""}
        ${c.phone ? `<a href="tel:${esc(c.phone.replace(/\D/g,""))}" style="color:var(--text)">${esc(c.phone)}</a>` : ""}
      </div>`).join("");
    return `
      <div class="team-row" style="flex-direction:column;align-items:stretch;gap:0;padding:16px;margin-bottom:12px" id="leagueCard_${esc(l.id)}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
              <strong style="font-size:1rem">🏆 ${esc(l.name)}</strong>
              ${divBadge}
            </div>
            ${websiteLink ? `<div style="margin-bottom:4px">${websiteLink}</div>` : ""}
            ${locations   ? `<div style="font-size:0.82rem;color:var(--light-text);margin-bottom:4px">🏟 Home at: ${locations}</div>` : ""}
            ${l.notes     ? `<div style="font-size:0.85rem;color:#ccc;margin-top:2px">${esc(l.notes)}</div>` : ""}
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button class="btn print-btn league-edit-btn" data-id="${esc(l.id)}"
              style="font-size:0.82rem;padding:5px 10px">Edit</button>
            <button class="btn league-delete-btn" data-id="${esc(l.id)}"
              style="font-size:0.82rem;padding:5px 10px;background:#5a1a1a">Delete</button>
          </div>
        </div>
        ${contacts ? `
          <div style="margin-top:12px">
            <div style="font-size:0.75rem;font-weight:700;color:var(--light-text);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:2px">Contacts</div>
            ${contacts}
          </div>` : ""}
      </div>`;
  }).join("");

  el.querySelectorAll(".league-edit-btn").forEach(btn =>
    btn.addEventListener("click", () => startEditLeague(btn.dataset.id)));
  el.querySelectorAll(".league-delete-btn").forEach(btn =>
    btn.addEventListener("click", () => deleteLeague(btn.dataset.id)));
}

function addLeagueContactRow(contact = {}) {
  const wrap = document.getElementById("lContactsWrap");
  if (!wrap) return;
  document.getElementById("lContactsHint").style.display = "none";
  const row = document.createElement("div");
  row.className = "league-contact-row";
  row.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;padding:10px;background:rgba(255,255,255,0.03);border:1px solid #333;border-radius:6px;align-items:flex-start";
  const inp = (cls, type, ph, val) =>
    `<input class="${cls}" type="${type}" placeholder="${ph}" value="${esc(val || "")}"
      style="flex:1;min-width:130px;padding:7px 10px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px;font-size:0.88rem" />`;
  row.innerHTML =
    inp("lc-name",  "text",  "Name *",               contact.name  || "") +
    inp("lc-role",  "text",  "Role (e.g. Director)",  contact.role  || "") +
    inp("lc-email", "email", "Email",                 contact.email || "") +
    inp("lc-phone", "tel",   "Phone",                 contact.phone || "") +
    `<button type="button" class="btn print-btn remove-contact-row-btn"
       style="flex-shrink:0;padding:7px 10px;font-size:0.85rem;align-self:flex-start">✕</button>`;
  row.querySelector(".remove-contact-row-btn").addEventListener("click", () => {
    row.remove();
    if (!document.querySelectorAll("#lContactsWrap .league-contact-row").length)
      document.getElementById("lContactsHint").style.display = "";
  });
  wrap.appendChild(row);
}

function getLeagueContactRows() {
  return [...document.querySelectorAll("#lContactsWrap .league-contact-row")]
    .map(row => ({
      name:  row.querySelector(".lc-name")?.value.trim()  || "",
      role:  row.querySelector(".lc-role")?.value.trim()  || "",
      email: row.querySelector(".lc-email")?.value.trim() || "",
      phone: row.querySelector(".lc-phone")?.value.trim() || "",
    }))
    .filter(c => c.name || c.email || c.phone);
}

function resetLeagueForm() {
  document.getElementById("leagueEditId").value      = "";
  document.getElementById("leagueForm").reset();
  document.getElementById("lContactsWrap").innerHTML = "";
  document.getElementById("lContactsHint").style.display = "";
  document.getElementById("leagueFormTitle").textContent      = "Add League";
  document.getElementById("leagueFormSubmitBtn").textContent  = "Add League";
  document.getElementById("leagueFormCancelBtn").style.display = "none";
  document.getElementById("leagueFormMsg").textContent = "";
  document.getElementById("leagueFormMsg").className   = "signup-message";
  populateLeagueLocations();
}

function startEditLeague(id) {
  const l = leagues.find(x => x.id === id);
  if (!l) return;
  document.getElementById("leagueEditId").value = id;
  document.getElementById("lName").value         = l.name      || "";
  document.getElementById("lDivision").value     = l.division  || "";
  document.getElementById("lWebsite").value      = l.websiteUrl || "";
  document.getElementById("lNotes").value        = l.notes     || "";
  // Contacts
  document.getElementById("lContactsWrap").innerHTML = "";
  (l.contacts || []).forEach(c => addLeagueContactRow(c));
  document.getElementById("lContactsHint").style.display =
    (l.contacts || []).length ? "none" : "";
  // Home locations
  const checkedIds = (l.homeLocations || []).map(loc => loc.facilityId);
  populateLeagueLocations(checkedIds);
  document.getElementById("leagueFormTitle").textContent     = "Edit League";
  document.getElementById("leagueFormSubmitBtn").textContent = "Save Changes";
  document.getElementById("leagueFormCancelBtn").style.display = "";
  document.getElementById("leagueFormWrap").scrollIntoView({ behavior: "smooth" });
}

async function deleteLeague(id) {
  const l = leagues.find(x => x.id === id);
  if (!l || !await showConfirm(`Delete league "${l.name}"?\n\nTeams assigned to this league will be unlinked.`)) return;
  try {
    await deleteDoc(doc(db, "leagues", id));
    // Unlink teams that referenced this league
    const anyLinked = teams.some(t => t.leagueId === id);
    if (anyLinked) {
      teams.forEach(t => { if (t.leagueId === id) { t.leagueId = ""; t.leagueName = ""; } });
      await saveTeams(false);
      renderTeamList();
    }
    leagues = leagues.filter(x => x.id !== id);
    renderLeagueList();
    populateLeagueSelector();
  } catch (err) {
    showToast("Delete failed: " + err.message);
  }
}

document.getElementById("addLeagueContactBtn").addEventListener("click", () => addLeagueContactRow());
document.getElementById("leagueFormCancelBtn").addEventListener("click", resetLeagueForm);

document.getElementById("leagueForm").addEventListener("submit", async e => {
  e.preventDefault();
  const msg     = document.getElementById("leagueFormMsg");
  const editId  = document.getElementById("leagueEditId").value;
  const contacts = getLeagueContactRows();
  const homeLocations = [...document.querySelectorAll("#lLocationsWrap .league-location-cb:checked")]
    .map(cb => ({ facilityId: cb.value, facilityName: cb.dataset.name }));
  const data = {
    name:          document.getElementById("lName").value.trim(),
    division:      document.getElementById("lDivision").value,
    websiteUrl:    document.getElementById("lWebsite").value.trim(),
    notes:         document.getElementById("lNotes").value.trim(),
    contacts,
    homeLocations,
  };
  if (!data.name) return;
  msg.textContent = "Saving…";
  msg.className   = "signup-message info";
  try {
    if (editId) {
      await setDoc(doc(db, "leagues", editId), { ...data, updatedAt: serverTimestamp() }, { merge: true });
      const idx = leagues.findIndex(l => l.id === editId);
      if (idx >= 0) leagues[idx] = { id: editId, ...data };
      // Update denormalized leagueName on affected teams
      const nameChanged = teams.some(t => t.leagueId === editId && t.leagueName !== data.name);
      if (nameChanged) {
        teams.forEach(t => { if (t.leagueId === editId) t.leagueName = data.name; });
        await saveTeams(false);
        renderTeamList();
      }
    } else {
      const ref = await addDoc(collection(db, "leagues"), { ...data, createdAt: serverTimestamp() });
      leagues.push({ id: ref.id, ...data });
    }
    msg.textContent = "✓ League saved.";
    msg.className   = "signup-message success";
    resetLeagueForm();
    renderLeagueList();
    populateLeagueSelector();
    setTimeout(() => { msg.textContent = ""; msg.className = "signup-message"; }, 2500);
  } catch (err) {
    msg.textContent = "Error: " + err.message;
    msg.className   = "signup-message error";
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════════════════════

authReadyPromise.then(async () => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display     = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display     = "none";

  await loadTeams();
});
