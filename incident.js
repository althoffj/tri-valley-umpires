// incident.js — submit incident reports against games the umpire worked
import { db } from "./firebase.js";
import {
  authReadyPromise,
  isApproved,
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
  ["gameSelectError", "incidentTypeError", "descriptionError"].forEach(id => fieldError(id, ""));
}

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
      if ((g.umpireSlots ?? []).some(s => s.assignedUid === user.uid)) {
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

async function handleSubmit(e) {
  e.preventDefault();
  clearErrors();

  const gameSelect      = document.getElementById("gameSelect");
  const incidentType    = document.getElementById("incidentType");
  const description     = document.getElementById("description");
  const involvedParties = document.getElementById("involvedParties");

  let valid = true;
  if (!gameSelect.value)         { fieldError("gameSelectError",   "Please select a game.");           valid = false; }
  if (!incidentType.value)       { fieldError("incidentTypeError", "Please select an incident type."); valid = false; }
  if (!description.value.trim()) { fieldError("descriptionError",  "Please describe the incident.");   valid = false; }
  if (!valid) return;

  const user        = getCurrentUser();
  const profile     = getCurrentProfile();
  const selectedOpt = gameSelect.options[gameSelect.selectedIndex];

  const btn = document.getElementById("submitIncidentBtn");
  btn.disabled = true;
  setMsg("Submitting…", "info");

  try {
    await addDoc(collection(db, "incidentReports"), {
      gameId:          gameSelect.value,
      gameDate:        selectedOpt.dataset.date     ?? "",
      gameCity:        selectedOpt.dataset.city     ?? "",
      gameDivision:    selectedOpt.dataset.division ?? "",
      incidentType:    incidentType.value,
      involvedParties: involvedParties.value.trim(),
      description:     description.value.trim(),
      reportedBy:      user.uid,
      reporterName:    profile
        ? `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim()
        : user.email,
      submittedAt: serverTimestamp()
    });

    setMsg("Report submitted. An administrator will review it.", "success");
    document.getElementById("incidentForm").reset();
    await loadMyGames();
  } catch (err) {
    console.error(err);
    setMsg("Error submitting report. Please try again.", "error");
    btn.disabled = false;
  }
}

async function init() {
  await authReadyPromise;
  if (!isApproved()) return;
  await loadMyGames();
  document.getElementById("incidentForm")?.addEventListener("submit", handleSubmit);
}

init();
