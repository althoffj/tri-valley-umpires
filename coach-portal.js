// coach-portal.js — Coach dashboard
import { db } from "./firebase.js";
import { authReadyPromise, isCoach, isAdmin, getCurrentUser, getCurrentCoachProfile } from "./auth.js";
import { esc, fmtDate, fmtTime, setMsg } from "./utils.js";
import { getOrgSettings } from "./org.js";

import {
  collection, getDocs, addDoc, query, orderBy, where, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function val(id) { return (document.getElementById(id)?.value || "").trim(); }

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function fieldError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg;
}

// ── Tab switching ─────────────────────────────────────────────────────────────

let myRequestsLoaded = false;

function setupTabs() {
  document.querySelectorAll(".cp-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".cp-tab-btn").forEach(b => b.classList.remove("tab-active"));
      document.querySelectorAll(".cp-tab-pane").forEach(p => { p.style.display = "none"; });
      btn.classList.add("tab-active");
      const pane = document.getElementById(`cpPane-${btn.dataset.pane}`);
      if (pane) pane.style.display = "";
      // Lazy-load My Requests on first open
      if (btn.dataset.pane === "myRequests" && !myRequestsLoaded) {
        myRequestsLoaded = true;
        loadMyRequests();
      }
    });
  });
}

// ── Schedule ──────────────────────────────────────────────────────────────────

let allGames     = [];
let myPractices  = [];
let showAll      = false;

async function loadSchedule() {
  const listEl = document.getElementById("cpScheduleList");
  if (!listEl) return;

  const uid  = getCurrentUser()?.uid;
  const year = new Date().getFullYear();

  try {
    const [gamesSnap, practiceSnap] = await Promise.all([
      getDocs(query(collection(db, "games"), orderBy("date", "desc"), orderBy("time"))),
      uid
        ? getDocs(query(collection(db, "practiceRequests"),
            where("submittedBy", "==", uid),
            where("status", "==", "approved"),
            orderBy("date")))
        : Promise.resolve({ docs: [] }),
    ]);

    allGames = gamesSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(g => (g.date || "").startsWith(String(year)));

    myPractices = practiceSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    renderSchedule();
  } catch (err) {
    listEl.innerHTML = `<div class="document-note"><p style="color:#ffb4b4;margin:0">Failed to load schedule. Please refresh.</p></div>`;
    console.error(err);
  }
}

function buildSlotHtml(g) {
  const slots = Array.isArray(g.umpireSlots) ? g.umpireSlots : [];

  if (!slots.length) {
    return `<span style="color:var(--light-text);font-size:0.82rem">No umpire slots configured</span>`;
  }

  return slots.map(s => {
    const assigned = !!s.assignedUid;
    const label    = assigned ? (s.assignedName || "Assigned") : `Open — ${esc(s.type || "")}`;
    const bgColor  = assigned ? "rgba(184,242,196,0.15)" : "rgba(255,200,100,0.12)";
    const border   = assigned ? "#b8f2c4" : "#ffcc80";
    const color    = assigned ? "#b8f2c4" : "#ffcc80";

    return `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:12px;font-size:0.78rem;margin:2px;background:${bgColor};border:1px solid ${border};color:${color}">${esc(label)}</span>`;
  }).join("");
}

function buildGameCard(g) {
  const today    = todayISO();
  const isToday  = g.date === today;
  const cancelled = g.cancelled
    ? `<span class="badge badge-cancelled" style="margin-left:6px">Cancelled</span>` : "";
  const todayBadge = isToday && !g.cancelled
    ? `<span style="margin-left:6px;font-size:0.72rem;font-weight:700;background:#1a3a1a;color:#b8f2c4;border:1px solid #2a5a2a;border-radius:4px;padding:1px 7px">TODAY</span>`
    : "";
  const borderStyle = isToday && !g.cancelled ? "border-left-color:#b8f2c4" : "";

  return `<div class="document-note" style="margin-bottom:10px;${g.cancelled ? "opacity:0.6" : ""}${borderStyle}">
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:4px">
      <strong style="font-size:0.95rem">${esc(fmtDate(g.date))}</strong>
      ${g.time ? `<span style="color:var(--light-text);font-size:0.85rem">${esc(fmtTime(g.time))}</span>` : ""}
      <span class="badge" style="background:#1a2a1a;color:#c9a0ff;border:1px solid #6b3fa0">${esc(g.division || "—")}</span>
      ${todayBadge}${cancelled}
    </div>
    <div style="font-size:0.9rem;margin-bottom:4px">
      ${g.homeTeam && g.awayTeam ? `${esc(g.homeTeam)} <span style="color:var(--light-text)">vs</span> ${esc(g.awayTeam)}` : "—"}
    </div>
    <div style="font-size:0.82rem;color:var(--light-text);margin-bottom:6px">${esc(g.facility || g.field || "—")}</div>
    <div>${buildSlotHtml(g)}</div>
  </div>`;
}

function renderSchedule() {
  const listEl = document.getElementById("cpScheduleList");
  if (!listEl) return;

  const profile = getCurrentCoachProfile();
  const myDiv   = profile?.division ?? null;
  const today   = todayISO();

  const visible = showAll ? allGames : allGames.filter(g => !myDiv || g.division === myDiv);

  // Split into upcoming (today+) and past
  const upcoming = visible.filter(g => (g.date || "") >= today).reverse(); // asc
  const past     = visible.filter(g => (g.date || "") <  today);           // already desc

  let html = "";

  // ── Upcoming ──────────────────────────────────────────────────────────────
  if (upcoming.length === 0 && past.length === 0) {
    html += `<div class="document-note"><p style="margin:0;color:var(--light-text);text-align:center">No games found${!showAll && myDiv ? ` for ${myDiv}` : ""}.</p></div>`;
  } else {
    if (upcoming.length) {
      html += upcoming.map(buildGameCard).join("");
    } else {
      html += `<p style="color:var(--light-text);font-size:0.88rem">No upcoming games.</p>`;
    }

    // ── Past (collapsible) ──────────────────────────────────────────────────
    if (past.length) {
      html += `
        <details style="margin-top:16px">
          <summary style="cursor:pointer;color:var(--light-text);font-size:0.88rem;user-select:none;list-style:none;padding:8px 0">
            ▸ Past Games (${past.length})
          </summary>
          <div style="margin-top:8px">
            ${past.map(buildGameCard).join("")}
          </div>
        </details>`;
    }
  }

  // ── Approved Practices ────────────────────────────────────────────────────
  if (myPractices.length) {
    html += `<h3 style="margin:20px 0 10px;font-size:1rem">My Approved Practices</h3>`;
    html += myPractices.map(p => `
      <div class="document-note" style="margin-bottom:10px;border-left:3px solid #5b8dd9">
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:4px">
          <strong style="font-size:0.95rem">${esc(fmtDate(p.date))}</strong>
          ${p.startTime ? `<span style="color:var(--light-text);font-size:0.85rem">${esc(fmtTime(p.startTime))}${p.endTime ? " – " + esc(fmtTime(p.endTime)) : ""}</span>` : ""}
          <span style="font-size:0.75rem;background:#1a2a4a;color:#8ab4f8;border:1px solid #2a4a8a;border-radius:4px;padding:1px 6px">Practice ✓</span>
        </div>
        <div style="font-size:0.9rem;margin-bottom:2px">${esc(p.teamName || "—")}</div>
        <div style="font-size:0.82rem;color:var(--light-text)">${esc(p.location || "—")}</div>
        ${p.notes ? `<div style="font-size:0.82rem;color:#ccc;margin-top:4px">${esc(p.notes)}</div>` : ""}
      </div>`).join("");
  }

  listEl.innerHTML = html;
}

// ── Umpire Request ────────────────────────────────────────────────────────────

async function submitUmpireRequest(e) {
  e.preventDefault();

  ["cpUrDate","cpUrTime","cpUrLocation","cpUrDivision","cpUrHomeTeam",
   "cpUrAwayTeam","cpUrUmpiresNeeded","cpContactName1","cpContactPhone1"]
    .forEach(id => fieldError(`${id}Error`, ""));

  const date          = val("cpUrDate");
  const time          = val("cpUrTime");
  const location      = val("cpUrLocation");
  const division      = val("cpUrDivision");
  const homeTeam      = val("cpUrHomeTeam");
  const awayTeam      = val("cpUrAwayTeam");
  const umpiresNeeded = val("cpUrUmpiresNeeded");
  const notes         = val("cpUrNotes");
  const contactName   = val("cpContactName1");
  const contactPhone  = val("cpContactPhone1");

  let valid = true;
  if (!date)          { fieldError("cpUrDateError",          "Date is required.");               valid = false; }
  if (!time)          { fieldError("cpUrTimeError",          "Time is required.");               valid = false; }
  if (!location)      { fieldError("cpUrLocationError",      "Facility / Location is required."); valid = false; }
  if (!division)      { fieldError("cpUrDivisionError",      "Please select a division.");       valid = false; }
  if (!homeTeam)      { fieldError("cpUrHomeTeamError",      "Home team is required.");          valid = false; }
  if (!awayTeam)      { fieldError("cpUrAwayTeamError",      "Away team is required.");          valid = false; }
  if (!umpiresNeeded) { fieldError("cpUrUmpiresNeededError", "Please select number needed.");    valid = false; }
  if (!contactName)   { fieldError("cpContactName1Error",    "Contact name is required.");       valid = false; }
  if (!contactPhone)  { fieldError("cpContactPhone1Error",   "Contact phone is required.");      valid = false; }
  if (!valid) return;

  const btn = document.getElementById("cpSubmitUmpireRequestBtn");
  btn.disabled = true;
  setMsg("cpUmpireRequestMessage", "Submitting…", "info");

  try {
    await addDoc(collection(db, "umpireRequests"), {
      date, time, location, division, homeTeam, awayTeam,
      umpiresNeeded: Number(umpiresNeeded),
      notes,
      contactName, contactPhone,
      submittedBy:     getCurrentUser()?.uid ?? null,
      submittedByName: getCurrentCoachProfile()?.name ?? null,
      teamName:        getCurrentCoachProfile()?.teamName ?? null,
      status:          "pending",
      createdAt:       serverTimestamp()
    });
    setMsg("cpUmpireRequestMessage", "Request submitted! An administrator will follow up with you.", "success");
    document.getElementById("cpUmpireRequestForm").reset();
    // Re-fill contact info from profile
    prefillForms();
  } catch (err) {
    console.error(err);
    setMsg("cpUmpireRequestMessage", "Error submitting request. Please try again.", "error");
  } finally {
    btn.disabled = false;
  }
}

// ── Practice Request ──────────────────────────────────────────────────────────

async function submitPracticeRequest(e) {
  e.preventDefault();

  ["cpPrDate","cpPrStartTime","cpPrEndTime","cpPrLocation","cpTeamName",
   "cpPrDivision","cpContactName2","cpContactPhone2"]
    .forEach(id => fieldError(`${id}Error`, ""));

  const date            = val("cpPrDate");
  const startTime       = val("cpPrStartTime");
  const endTime         = val("cpPrEndTime");
  const location        = val("cpPrLocation");
  const teamName        = val("cpTeamName");
  const division        = val("cpPrDivision");
  const expectedPlayers = document.getElementById("cpPrExpectedPlayers")?.value?.trim() || "";
  const notes           = val("cpPrNotes");
  const contactName     = val("cpContactName2");
  const contactPhone    = val("cpContactPhone2");

  let valid = true;
  if (!date)        { fieldError("cpPrDateError",        "Date is required.");               valid = false; }
  if (!startTime)   { fieldError("cpPrStartTimeError",   "Start time is required.");         valid = false; }
  if (!endTime)     { fieldError("cpPrEndTimeError",     "End time is required.");           valid = false; }
  if (!location)    { fieldError("cpPrLocationError",    "Facility / Location is required."); valid = false; }
  if (!teamName)    { fieldError("cpTeamNameError",      "Team name is required.");          valid = false; }
  if (!division)    { fieldError("cpPrDivisionError",    "Please select a division.");       valid = false; }
  if (!contactName) { fieldError("cpContactName2Error",  "Contact name is required.");       valid = false; }
  if (!contactPhone){ fieldError("cpContactPhone2Error", "Contact phone is required.");      valid = false; }
  if (!valid) return;

  const btn = document.getElementById("cpSubmitPracticeRequestBtn");
  btn.disabled = true;
  setMsg("cpPracticeRequestMessage", "Submitting…", "info");

  const payload = {
    date, startTime, endTime, location, teamName, division,
    notes, contactName, contactPhone,
    submittedBy:     getCurrentUser()?.uid ?? null,
    submittedByName: getCurrentCoachProfile()?.name ?? null,
    status:          "pending",
    createdAt:       serverTimestamp()
  };
  if (expectedPlayers) payload.expectedPlayers = Number(expectedPlayers);

  try {
    await addDoc(collection(db, "practiceRequests"), payload);
    setMsg("cpPracticeRequestMessage", "Practice request submitted! An administrator will confirm availability.", "success");
    document.getElementById("cpPracticeRequestForm").reset();
    prefillForms();
  } catch (err) {
    console.error(err);
    setMsg("cpPracticeRequestMessage", "Error submitting request. Please try again.", "error");
  } finally {
    btn.disabled = false;
  }
}

// ── Division rep card ─────────────────────────────────────────────────────────

async function showDivisionRep() {
  const profile = getCurrentCoachProfile();
  if (!profile?.division) return;
  const el = document.getElementById("cpDivRepCard");
  if (!el) return;
  try {
    const settings = await getOrgSettings();
    const reps = Array.isArray(settings.divisionReps) ? settings.divisionReps : [];
    const rep = reps.find(r => r.division === profile.division);
    if (!rep) { el.style.display = "none"; return; }
    el.style.display = "";
    el.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start">
        <div>
          <div style="font-weight:600;margin-bottom:2px">${esc(rep.name)}</div>
          <div style="font-size:0.82rem;color:var(--light-text)">${esc(profile.division)} Representative</div>
        </div>
        <div style="margin-left:auto;display:flex;flex-direction:column;gap:4px;font-size:0.85rem;text-align:right">
          ${rep.email ? `<a href="mailto:${esc(rep.email)}" style="color:var(--accent)">${esc(rep.email)}</a>` : ""}
          ${rep.phone ? `<a href="tel:${esc(rep.phone.replace(/\D/g,""))}" style="color:var(--light-text)">${esc(rep.phone)}</a>` : ""}
        </div>
      </div>`;
  } catch (_) { el.style.display = "none"; }
}

// ── Pre-fill forms from coach profile ────────────────────────────────────────

function prefillForms() {
  const profile = getCurrentCoachProfile();
  if (!profile) return;

  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = v || "";
  };

  setVal("cpContactName1",  profile.name  || "");
  setVal("cpContactPhone1", profile.phone || "");
  setVal("cpTeamName",      profile.teamName || "");
  setVal("cpContactName2",  profile.name  || "");
  setVal("cpContactPhone2", profile.phone || "");

  // Pre-select division in practice form if not yet chosen
  const prDiv = document.getElementById("cpPrDivision");
  if (prDiv && !prDiv.value && profile.division) prDiv.value = profile.division;
  const urDiv = document.getElementById("cpUrDivision");
  if (urDiv && !urDiv.value && profile.division) urDiv.value = profile.division;
}

// ── My Requests ───────────────────────────────────────────────────────────────

function statusPill(status) {
  const map = {
    pending:  { bg: "rgba(255,200,100,0.12)", border: "#ffcc80", color: "#ffcc80", label: "Pending" },
    approved: { bg: "rgba(111,207,151,0.12)", border: "#6fcf97", color: "#6fcf97", label: "Approved" },
    denied:   { bg: "rgba(235,87,87,0.12)",   border: "#eb5757", color: "#eb5757", label: "Denied" },
  };
  const s = map[status] || map.pending;
  return `<span style="padding:2px 10px;border-radius:12px;font-size:0.78rem;background:${s.bg};border:1px solid ${s.border};color:${s.color}">${s.label}</span>`;
}

async function loadMyRequests() {
  const el = document.getElementById("cpMyRequestsList");
  if (!el) return;
  const uid = getCurrentUser()?.uid;
  if (!uid) { el.innerHTML = `<p style="color:var(--light-text)">Sign in to see your requests.</p>`; return; }

  el.innerHTML = `<p style="color:var(--light-text);text-align:center;padding:20px">Loading…</p>`;

  try {
    const [umpireSnap, practiceSnap] = await Promise.all([
      getDocs(query(collection(db, "umpireRequests"),  where("submittedBy", "==", uid), orderBy("createdAt", "desc"), limit(50))),
      getDocs(query(collection(db, "practiceRequests"), where("submittedBy", "==", uid), orderBy("createdAt", "desc"), limit(50))),
    ]);

    const umpireReqs  = umpireSnap.docs.map(d  => ({ id: d.id,  ...d.data() }));
    const practiceReqs = practiceSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (!umpireReqs.length && !practiceReqs.length) {
      el.innerHTML = `<div class="document-note"><p style="margin:0;color:var(--light-text)">No requests submitted yet. Use the Request Umpire or Request Practice tabs to get started.</p></div>`;
      return;
    }

    let html = "";

    if (umpireReqs.length) {
      html += `<h3 style="margin:0 0 12px">Umpire Requests</h3>`;
      html += umpireReqs.map(r => `
        <div class="document-note" style="margin-bottom:10px">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:6px">
            <div>
              <strong>${esc(fmtDate(r.date))}${r.time ? " · " + esc(fmtTime(r.time)) : ""}</strong>
              <span style="color:var(--light-text);font-size:0.85rem;margin-left:8px">${esc(r.division || "")}</span>
            </div>
            ${statusPill(r.status)}
          </div>
          <div style="font-size:0.9rem;margin-bottom:2px">${esc(r.homeTeam || "—")} <span style="color:var(--light-text)">vs</span> ${esc(r.awayTeam || "—")}</div>
          <div style="font-size:0.82rem;color:var(--light-text)">${esc(r.location || "—")} · ${r.umpiresNeeded || 1} umpire${r.umpiresNeeded !== 1 ? "s" : ""} needed</div>
          ${r.adminNote ? `<div style="font-size:0.82rem;color:#8ab4f8;margin-top:6px">📝 Admin note: ${esc(r.adminNote)}</div>` : ""}
        </div>`).join("");
    }

    if (practiceReqs.length) {
      html += `<h3 style="margin:${umpireReqs.length ? "20px" : "0"} 0 12px">Practice Requests</h3>`;
      html += practiceReqs.map(r => `
        <div class="document-note" style="margin-bottom:10px">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:6px">
            <div>
              <strong>${esc(fmtDate(r.date))}${r.startTime ? " · " + esc(fmtTime(r.startTime)) : ""}${r.endTime ? " – " + esc(fmtTime(r.endTime)) : ""}</strong>
              <span style="color:var(--light-text);font-size:0.85rem;margin-left:8px">${esc(r.division || "")}</span>
            </div>
            ${statusPill(r.status)}
          </div>
          <div style="font-size:0.9rem;margin-bottom:2px">${esc(r.teamName || "—")}</div>
          <div style="font-size:0.82rem;color:var(--light-text)">${esc(r.location || "—")}</div>
          ${r.adminNote ? `<div style="font-size:0.82rem;color:#8ab4f8;margin-top:6px">📝 Admin note: ${esc(r.adminNote)}</div>` : ""}
        </div>`).join("");
    }

    el.innerHTML = html;
  } catch (err) {
    console.error("loadMyRequests:", err);
    el.innerHTML = `<div class="document-note"><p style="color:#ffb4b4;margin:0">Failed to load requests. Please refresh.</p></div>`;
  }
}

// ── Division filter buttons ───────────────────────────────────────────────────

function setupDivisionFilter() {
  document.getElementById("cpShowAllBtn")?.addEventListener("click", () => {
    showAll = true;
    renderSchedule();
  });
  document.getElementById("cpMyDivBtn")?.addEventListener("click", () => {
    showAll = false;
    renderSchedule();
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  const adminContent = document.getElementById("cpAdminContent");
  const noAccess     = document.getElementById("cpNoAccess");

  if (!isCoach() && !isAdmin()) {
    if (adminContent) adminContent.style.display = "none";
    if (noAccess)     noAccess.style.display = "";
    return;
  }

  if (adminContent) adminContent.style.display = "";
  if (noAccess)     noAccess.style.display = "none";

  setupTabs();
  setupDivisionFilter();
  prefillForms();
  showDivisionRep();
  loadSchedule();

  document.getElementById("cpUmpireRequestForm")?.addEventListener("submit",   submitUmpireRequest);
  document.getElementById("cpPracticeRequestForm")?.addEventListener("submit", submitPracticeRequest);
});
