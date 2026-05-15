// coach-portal.js — Coach dashboard
import { db } from "./firebase.js";
import { authReadyPromise, isCoach, isAdmin, getCurrentUser, getCurrentCoachProfile } from "./auth.js";
import {
  collection, getDocs, addDoc, query, orderBy, where, serverTimestamp, limit
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

function fmtDate(dateISO) {
  if (!dateISO) return "—";
  const [y, m, d] = dateISO.split("-");
  return `${m}/${d}/${y}`;
}

function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hr   = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

function val(id) { return (document.getElementById(id)?.value || "").trim(); }

function fieldError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg;
}

function setMsg(id, text, type = "info") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = `signup-message ${type}`;
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

let allGames = [];
let showAll  = false;

async function loadSchedule() {
  const listEl = document.getElementById("cpScheduleList");
  if (!listEl) return;

  try {
    const snap = await getDocs(query(collection(db, "games"), orderBy("date", "desc"), orderBy("time")));
    const year  = new Date().getFullYear();
    allGames = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(g => (g.date || "").startsWith(String(year)));

    renderSchedule();
  } catch (err) {
    listEl.innerHTML = `<div class="document-note"><p style="color:#ffb4b4;margin:0">Failed to load schedule. Please refresh.</p></div>`;
    console.error(err);
  }
}

function renderSchedule() {
  const listEl = document.getElementById("cpScheduleList");
  if (!listEl) return;

  const profile  = getCurrentCoachProfile();
  const myDiv    = profile?.division ?? null;

  const visible = showAll ? allGames : allGames.filter(g => !myDiv || g.division === myDiv);

  if (visible.length === 0) {
    listEl.innerHTML = `<div class="document-note"><p style="margin:0;color:var(--light-text);text-align:center">No games found${!showAll && myDiv ? ` for ${myDiv}` : ""}.</p></div>`;
    return;
  }

  listEl.innerHTML = visible.map(g => {
    const slots = Array.isArray(g.umpireSlots) ? g.umpireSlots : [];
    const slotHtml = slots.length
      ? slots.map(s => {
          const assigned = !!s.assignedUid;
          const cls = assigned ? "assigned" : "open";
          const label = assigned
            ? (s.assignedName || "Assigned")
            : `Open — ${esc(s.type || "")}`;
          return `<span class="umpire-chip ${cls}" style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:0.78rem;margin:2px;background:${assigned ? "rgba(184,242,196,0.15)" : "rgba(255,200,100,0.12)"};border:1px solid ${assigned ? "#b8f2c4" : "#ffcc80"};color:${assigned ? "#b8f2c4" : "#ffcc80"}">${esc(label)}</span>`
        }).join("")
      : `<span style="color:var(--light-text);font-size:0.82rem">No umpire slots configured</span>`;

    const cancelled = g.cancelled
      ? `<span class="badge badge-cancelled" style="margin-left:6px">Cancelled</span>` : "";

    return `<div class="document-note" style="margin-bottom:10px;${g.cancelled ? "opacity:0.6" : ""}">
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:4px">
        <strong style="font-size:0.95rem">${esc(fmtDate(g.date))}</strong>
        ${g.time ? `<span style="color:var(--light-text);font-size:0.85rem">${esc(fmtTime(g.time))}</span>` : ""}
        <span class="badge" style="background:#1a2a1a;color:#c9a0ff;border:1px solid #6b3fa0">${esc(g.division || "—")}</span>
        ${cancelled}
      </div>
      <div style="font-size:0.9rem;margin-bottom:4px">
        ${g.homeTeam && g.awayTeam ? `${esc(g.homeTeam)} <span style="color:var(--light-text)">vs</span> ${esc(g.awayTeam)}` : "—"}
      </div>
      <div style="font-size:0.82rem;color:var(--light-text);margin-bottom:6px">${esc(g.facility || g.field || "—")}</div>
      <div>${slotHtml}</div>
    </div>`;
  }).join("");
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
  loadSchedule();

  document.getElementById("cpUmpireRequestForm")?.addEventListener("submit",   submitUmpireRequest);
  document.getElementById("cpPracticeRequestForm")?.addEventListener("submit", submitPracticeRequest);
});
