// incident.js — submit incident reports against games the umpire worked
import { db } from "./firebase.js";
import {
  authReadyPromise,
  isApproved,
  isAdmin,
  getCurrentUser,
  getCurrentProfile
} from "./auth.js";
import {
  collection,
  addDoc,
  getDocs,
  query,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(dateISO) {
  if (!dateISO) return "—";
  const [y, m, d] = dateISO.split("-");
  return `${m}/${d}/${y}`;
}

function val(id) { return (document.getElementById(id)?.value || "").trim(); }

function setMsg(text, type = "info") {
  const el = document.getElementById("incidentMessage");
  if (!el) return;
  el.textContent = text;
  el.className = `signup-message ${type}`;
}

function fieldError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg;
}

function clearErrors() {
  [
    "gameSelectError", "incidentTypeError", "descriptionError",
    "ejectedRoleError", "ejectionReasonError",
    "injuredPartyError", "injuryDescriptionError",
    "conditionTypeError"
  ].forEach(id => fieldError(id, ""));
}

// ── Show / hide type-specific sections ───────────────────────────────────────

function updateTypeFields(type) {
  document.getElementById("ejectionFields").style.display = type === "Ejection"          ? "" : "none";
  document.getElementById("injuryFields").style.display   = type === "Injury"             ? "" : "none";
  document.getElementById("unsafeFields").style.display   = type === "Unsafe Conditions"  ? "" : "none";
}

// ── Load games the umpire has worked ─────────────────────────────────────────

async function loadMyGames() {
  const user = getCurrentUser();
  if (!user) return;

  const sel = document.getElementById("gameSelect");
  if (!sel) return;

  try {
    const snap = await getDocs(
      query(collection(db, "games"), orderBy("date", "desc"))
    );

    const myGames = [];
    snap.forEach(d => {
      const g = { id: d.id, ...d.data() };
      // Admins can file reports for any game; umpires only see their own assigned games
      if (isAdmin() || (g.umpireSlots ?? []).some(s => s.assignedUid === user.uid)) {
        myGames.push(g);
      }
    });

    if (myGames.length === 0) {
      sel.innerHTML = '<option value="">No games found — you haven\'t worked any games yet.</option>';
      return;
    }

    sel.innerHTML = '<option value="">-- Select a game --</option>' +
      myGames.map(g => {
        const teams = [g.homeTeam, g.awayTeam].filter(Boolean).join(" vs ");
        const label = `${fmtDate(g.date)} — ${g.city ?? ""} ${g.division ?? ""}${teams ? " · " + teams : ""}`;
        return `<option value="${esc(g.id)}"
          data-date="${esc(g.date)}"
          data-city="${esc(g.city ?? "")}"
          data-division="${esc(g.division ?? "")}">${esc(label)}</option>`;
      }).join("");
  } catch (err) {
    sel.innerHTML = '<option value="">Error loading games</option>';
    console.error(err);
  }
}

// ── Submit ────────────────────────────────────────────────────────────────────

async function handleSubmit(e) {
  e.preventDefault();
  clearErrors();

  const gameSelect   = document.getElementById("gameSelect");
  const incidentType = document.getElementById("incidentType");
  const description  = document.getElementById("description");
  const type         = incidentType.value;

  let valid = true;
  if (!gameSelect.value)         { fieldError("gameSelectError",   "Please select a game.");           valid = false; }
  if (!type)                     { fieldError("incidentTypeError", "Please select an incident type."); valid = false; }
  if (!description.value.trim()) { fieldError("descriptionError",  "Please describe the incident.");   valid = false; }

  // Type-specific validation
  if (type === "Ejection") {
    if (!val("ejectedRole"))    { fieldError("ejectedRoleError",    "Please select the role.");          valid = false; }
    if (!val("ejectionReason")) { fieldError("ejectionReasonError", "Please enter the ejection reason."); valid = false; }
  }
  if (type === "Injury") {
    if (!val("injuredParty"))       { fieldError("injuredPartyError",       "Please select who was injured."); valid = false; }
    if (!val("injuryDescription"))  { fieldError("injuryDescriptionError",  "Please describe the injury.");    valid = false; }
  }
  if (type === "Unsafe Conditions") {
    if (!val("conditionType")) { fieldError("conditionTypeError", "Please describe the unsafe condition."); valid = false; }
  }

  if (!valid) return;

  const user        = getCurrentUser();
  const profile     = getCurrentProfile();
  const selectedOpt = gameSelect.options[gameSelect.selectedIndex];

  const btn = document.getElementById("submitIncidentBtn");
  btn.disabled = true;
  setMsg("Submitting…", "info");

  // Build base report
  const report = {
    gameId:          gameSelect.value,
    gameDate:        selectedOpt.dataset.date     ?? "",
    gameCity:        selectedOpt.dataset.city     ?? "",
    gameDivision:    selectedOpt.dataset.division ?? "",
    incidentType:    type,
    involvedParties: val("involvedParties"),
    description:     description.value.trim(),
    reportedBy:      user.uid,
    reporterName:    profile
      ? `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim() || (profile.name ?? user.email)
      : user.email,
    submittedAt: serverTimestamp()
  };

  // Attach type-specific structured fields
  if (type === "Ejection") {
    report.ejection = {
      role:   val("ejectedRole"),
      name:   val("ejectedName"),
      team:   val("ejectedTeam"),
      reason: val("ejectionReason")
    };
  }
  if (type === "Injury") {
    report.injury = {
      party:       val("injuredParty"),
      name:        val("injuredName"),
      team:        val("injuredTeam"),
      description: val("injuryDescription"),
      emsCalled:   document.getElementById("emsCalled")?.value || "No"
    };
  }
  if (type === "Unsafe Conditions") {
    report.unsafeConditions = {
      conditionType:  val("conditionType"),
      gameStatus:     document.getElementById("gameSuspended")?.value || "Continued"
    };
  }

  try {
    await addDoc(collection(db, "incidentReports"), report);
    setMsg("Report submitted. An administrator will review it.", "success");
    document.getElementById("incidentForm").reset();
    updateTypeFields("");
    await loadMyGames();
  } catch (err) {
    console.error(err);
    setMsg("Error submitting report. Please try again.", "error");
    btn.disabled = false;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await authReadyPromise;
  if (!isApproved()) return;
  await loadMyGames();

  document.getElementById("incidentType")?.addEventListener("change", function () {
    updateTypeFields(this.value);
  });

  document.getElementById("incidentForm")?.addEventListener("submit", handleSubmit);
}

init();
