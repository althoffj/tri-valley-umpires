// admin-scheduler.js — Scheduling Assistant: teams, calendar/CSV import, calendar view, practices
import { db, app }                       from "./firebase.js";
import { authReadyPromise, isAdmin }      from "./auth.js";
import { getFunctions, httpsCallable }    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import {
  collection, getDocs, getDoc, addDoc, setDoc, updateDoc, deleteDoc,
  doc, query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const fns       = getFunctions(app);
const previewFn = httpsCallable(fns, "previewCalendarImport");
const commitFn  = httpsCallable(fns, "commitCalendarImport");

// ── State ─────────────────────────────────────────────────────────────────────

let teams        = [];   // [{name, division, city, icsUrl, color, needsUmpireForHome}]
let activeSection = "teams";
let importMode   = "calendar";

// Import preview state
let readyItems     = [];
let conflictItems  = [];
let duplicateItems = [];
let warningItems   = [];
let activeTab      = "ready";

// Calendar state
let calYear, calMonth, calView = "month";
const now = new Date();
calYear  = now.getFullYear();
calMonth = now.getMonth(); // 0-based

// Game data cache for current calendar period
let calGamesCache = []; // [{id, ...gameData}]
let calPracticesCache = [];

// Availability & cancellation overlay data (loaded with calendar)
let calUnavailByDate   = {}; // { "YYYY-MM-DD": count }
let calPendingCancelIds = new Set(); // Set of gameIds with pending cancellations

// Calendar filter state
let calFilterDivision = "";
let calFilterCity     = "";
let calFilterField    = "";

function filterGame(g) {
  if (calFilterDivision && g.division !== calFilterDivision) return false;
  if (calFilterCity     && g.city     !== calFilterCity)     return false;
  if (calFilterField    && g.field    !== calFilterField)    return false;
  return true;
}
function filterPractice(p) {
  if (calFilterDivision && p.division !== calFilterDivision) return false;
  if (calFilterField    && p.field    !== calFilterField)    return false;
  return true;
}
function updateFilterCount() {
  const active = [calFilterDivision, calFilterCity, calFilterField].filter(Boolean).length;
  const el = document.getElementById("calFilterCount");
  if (el) el.textContent = active ? `${active} filter${active !== 1 ? "s" : ""} active` : "";
}
function populateFieldFilter() {
  const sel = document.getElementById("calFilterField");
  if (!sel) return;
  const fields = new Set();
  calGamesCache.forEach(g => { if (g.field) fields.add(g.field); });
  calPracticesCache.forEach(p => { if (p.field) fields.add(p.field); });
  const current = sel.value;
  sel.innerHTML = '<option value="">All Fields</option>' +
    [...fields].sort().map(f => `<option value="${esc(f)}"${f === current ? " selected" : ""}>${esc(f)}</option>`).join("");
  if (current && !fields.has(current)) calFilterField = ""; // reset if field no longer visible
}

// ── League state ─────────────────────────────────────────────────────────────
let leagues              = []; // [{ id, name, division, websiteUrl, notes, contacts, homeLocations }]
let facilitiesForLeagues = []; // [{ id, name, address }]

// ── Settings constants ────────────────────────────────────────────────────────
const SCHED_DEFAULTS = { "10U": 90, "12U": 90, "14U": 120, "HS JV": 120, "HS Varsity": 150, default: 90 };
const DUR_IDS = {
  "10U": "sDur10U", "12U": "sDur12U", "14U": "sDur14U",
  "HS JV": "sDurHSJV", "HS Varsity": "sDurHSVar", default: "sDurDefault"
};

// ── Umpire assign state ───────────────────────────────────────────────────────
let schedApprovedUmpires   = []; // { uid, name, email }
let schedUmpireUnavailable = {}; // { uid: Set<"YYYY-MM-DD"> }
let schedAssignTarget      = null; // { gameId, slotType, gameDate, gameTime }
// The game object currently open in the edit modal (refreshed after slot changes)
let seCurrentGame          = null;
// The practice object currently open in the practice edit modal
let peCurrentPractice      = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}/${y}`;
}

function fmt12(t) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,"0")} ${h >= 12 ? "PM" : "AM"}`;
}

function issueBadge(issue) {
  return `<span class="sched-issue-badge" style="background:${issue.color}22;color:${issue.color};border-color:${issue.color}44">${esc(issue.label)}</span>`;
}

function sourceLabel(game) {
  const icon = game.sourceType === "google" ? "📅" : game.source === "csv" ? "📄" : "🎮";
  return `<span style="color:var(--light-text);font-size:0.8rem">${icon} ${esc(game.sourceLabel || game.source || "")}</span>`;
}

function gameRowCells(game) {
  return `
    <td>${esc(fmtDate(game.date))}</td>
    <td>${esc(fmt12(game.time))}</td>
    <td>${esc(game.field || "—")}</td>
    <td>${esc(game.division || "—")}</td>
    <td>${esc(game.city || "—")}</td>
    <td>${esc(game.homeTeam && game.awayTeam
      ? `${game.awayTeam} @ ${game.homeTeam}` : game.homeTeam || game.awayTeam || "—")}</td>
    <td>${sourceLabel(game)}</td>`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

/** Find team color by matching homeTeam or awayTeam name */
function teamColor(game) {
  if (!teams.length) return "var(--accent)";
  const lc = (s) => (s || "").toLowerCase();
  const home = lc(game.homeTeam);
  const tm   = teams.find(t =>
    home && (lc(t.name).includes(home) || home.includes(lc(t.name)))
  ) || teams.find(t => {
    const away = lc(game.awayTeam);
    return away && (lc(t.name).includes(away) || away.includes(lc(t.name)));
  });
  return tm ? tm.color : "var(--accent)";
}

/** Return team object whose home game this is, or null */
function findHomeTeam(homeTeamName) {
  if (!homeTeamName) return null;
  const lc = (s) => (s || "").toLowerCase();
  return teams.find(t => {
    const tn = lc(t.name);
    const ht = lc(homeTeamName);
    return tn.includes(ht) || ht.includes(tn);
  }) || null;
}

// ── Section navigation ────────────────────────────────────────────────────────

function switchSection(section) {
  activeSection = section;
  document.querySelectorAll(".sched-sec-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.section === section);
  });
  ["teams","leagues","import","calendar","practices","settings"].forEach(s => {
    const el = document.getElementById(`sec-${s}`);
    if (el) el.style.display = s === section ? "" : "none";
  });
  // Lazy load section data
  if (section === "leagues")   loadLeagues();
  if (section === "calendar")  loadCalendar();
  if (section === "practices") loadPractices();
  if (section === "settings")  loadSettings();
}

// Expose for inline onclick in import section note link
window.switchSectionPublic = switchSection;

document.querySelectorAll(".sched-sec-btn").forEach(btn => {
  btn.addEventListener("click", () => switchSection(btn.dataset.section));
});

// ── Import mode toggle ────────────────────────────────────────────────────────

document.querySelectorAll(".import-mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    importMode = btn.dataset.mode;
    document.querySelectorAll(".import-mode-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.mode === importMode);
      b.classList.toggle("print-btn", b.dataset.mode !== importMode);
    });
    document.getElementById("importModeCalendar").style.display = importMode === "calendar" ? "" : "none";
    document.getElementById("importModeCsv").style.display      = importMode === "csv"      ? "" : "none";
    // Reset preview
    document.getElementById("previewSummary").style.display = "none";
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  SETTINGS SECTION
// ══════════════════════════════════════════════════════════════════════════════

function setSettingsMsg(id, text, type = "info") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = `signup-message ${type}`;
}

async function loadSettings() {
  try {
    const [ratesSnap, schedSnap] = await Promise.all([
      getDoc(doc(db, "config", "payRates")),
      getDoc(doc(db, "config", "scheduling")),
    ]);
    if (ratesSnap.exists()) {
      const r = ratesSnap.data();
      document.getElementById("sRatePlate").value = r.plate ?? "";
      document.getElementById("sRateField").value = r.field  ?? "";
      document.getElementById("sRateExtra").value = r.extra  ?? "";
      const defaults = r.defaultSlotTypes ?? [];
      document.getElementById("sSlotPlate").checked = defaults.includes("Plate");
      document.getElementById("sSlotField").checked = defaults.includes("Field");
      document.getElementById("sSlotExtra").checked = defaults.includes("Extra");
    }
    if (schedSnap.exists()) {
      const d = schedSnap.data();
      const dur = d.gameDurationMinutes || {};
      Object.entries(DUR_IDS).forEach(([div, elId]) => {
        const el = document.getElementById(elId);
        if (el) el.value = dur[div] ?? SCHED_DEFAULTS[div] ?? 90;
      });
      const cutoffEl = document.getElementById("sLateStartCutoff");
      if (cutoffEl) cutoffEl.value = d.lateStartCutoff ?? "19:30";
    }
  } catch (err) {
    console.error("loadSettings:", err);
  }
}

document.getElementById("sPayRatesForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn = this.querySelector("button[type='submit']");
  btn.disabled = true;
  setSettingsMsg("sPayRatesMsg", "Saving…", "info");
  try {
    const snap = await getDoc(doc(db, "config", "payRates"));
    const existing = snap.exists() ? snap.data() : {};
    await setDoc(doc(db, "config", "payRates"), {
      ...existing,
      plate: parseFloat(document.getElementById("sRatePlate").value) || 0,
      field: parseFloat(document.getElementById("sRateField").value)  || 0,
      extra: parseFloat(document.getElementById("sRateExtra").value)  || 0,
    });
    setSettingsMsg("sPayRatesMsg", "Pay rates saved.", "success");
  } catch (err) {
    setSettingsMsg("sPayRatesMsg", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("sSlotTypesForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn = this.querySelector("button[type='submit']");
  btn.disabled = true;
  setSettingsMsg("sSlotTypesMsg", "Saving…", "info");
  try {
    const selected = ["Plate", "Field", "Extra"].filter(t =>
      document.getElementById(`sSlot${t}`).checked
    );
    const snap = await getDoc(doc(db, "config", "payRates"));
    const existing = snap.exists() ? snap.data() : {};
    await setDoc(doc(db, "config", "payRates"), { ...existing, defaultSlotTypes: selected });
    setSettingsMsg("sSlotTypesMsg", "Default slot types saved.", "success");
  } catch (err) {
    setSettingsMsg("sSlotTypesMsg", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("sSchedulingForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn = this.querySelector("button[type='submit']");
  btn.disabled = true;
  setSettingsMsg("sSchedulingMsg", "Saving…", "info");
  try {
    const gameDurationMinutes = {};
    Object.entries(DUR_IDS).forEach(([div, elId]) => {
      const val = parseInt(document.getElementById(elId)?.value);
      gameDurationMinutes[div] = isNaN(val) ? SCHED_DEFAULTS[div] : val;
    });
    const lateStartCutoff = document.getElementById("sLateStartCutoff").value || "19:30";
    await setDoc(doc(db, "config", "scheduling"), { gameDurationMinutes, lateStartCutoff });
    setSettingsMsg("sSchedulingMsg", "Scheduling rules saved.", "success");
  } catch (err) {
    setSettingsMsg("sSchedulingMsg", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  TEAMS SECTION
// ══════════════════════════════════════════════════════════════════════════════

let teamCoaches = []; // approved coaches for team-form dropdown

async function loadTeams() {
  try {
    const [teamsSnap, leaguesSnap, coachesSnap] = await Promise.all([
      getDoc(doc(db, "config/teamCalendars")),
      getDocs(query(collection(db, "leagues"), orderBy("name"))),
      getDocs(query(collection(db, "coaches"), where("approved", "==", true), orderBy("name"))),
    ]);
    teams        = teamsSnap.exists() ? (teamsSnap.data().teams || []) : [];
    leagues      = leaguesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    teamCoaches  = coachesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    teams = [];
  }
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
      ${t.leagueName ? `<span style="font-size:0.75rem;color:#8ab4f8;background:rgba(91,141,217,0.12);border:1px solid rgba(91,141,217,0.3);border-radius:4px;padding:1px 6px">🏆 ${esc(t.leagueName)}</span>` : ""}
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
  const leagueSel = document.getElementById("tLeague");
  if (leagueSel) leagueSel.value = t.leagueId || "";
  populateCoachSelector(t.coachId || "");
  document.getElementById("teamFormTitle").textContent = "Edit Team";
  document.getElementById("teamFormSubmitBtn").textContent = "Save Changes";
  document.getElementById("teamFormCancelBtn").style.display = "";
  document.getElementById("tName").focus();
  document.getElementById("teamFormWrap").scrollIntoView({ behavior: "smooth" });
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
}

async function deleteTeam(idx) {
  if (!confirm(`Delete team "${teams[idx].name}"?`)) return;
  teams.splice(idx, 1);
  renderTeamList();
  await saveTeams(false);
}

document.getElementById("teamFormCancelBtn").addEventListener("click", cancelEditTeam);

document.getElementById("teamForm").addEventListener("submit", async e => {
  e.preventDefault();
  const msg = document.getElementById("teamFormMsg");
  const leagueId  = document.getElementById("tLeague")?.value || "";
  const leagueObj = leagues.find(l => l.id === leagueId);
  const coachId   = document.getElementById("tCoach")?.value || "";
  const coachObj  = teamCoaches.find(c => c.id === coachId);
  const teamData = {
    name:               document.getElementById("tName").value.trim(),
    division:           document.getElementById("tDivision").value,
    city:               document.getElementById("tCity").value,
    color:              document.getElementById("tColor").value,
    icsUrl:             document.getElementById("tIcsUrl").value.trim(),
    needsUmpireForHome: document.getElementById("tNeedsUmpire").checked,
    leagueId,
    leagueName:         leagueObj?.name || "",
    coachId,
    coachName:          coachObj?.name || "",
    coachEmail:         coachObj?.email || "",
    coachPhone:         coachObj?.phone || "",
  };
  if (!teamData.name) return;

  const editIdx = document.getElementById("teamEditIndex").value;
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
  const sel = document.getElementById("tLeague");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— No league —</option>' +
    leagues.map(l =>
      `<option value="${esc(l.id)}"${l.id === current ? " selected" : ""}>` +
      `${esc(l.name)}${l.division ? " (" + esc(l.division) + ")" : ""}</option>`
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
  if (!l || !confirm(`Delete league "${l.name}"?\n\nTeams assigned to this league will be unlinked.`)) return;
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
    alert("Delete failed: " + err.message);
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
//  IMPORT — shared preview helpers
// ══════════════════════════════════════════════════════════════════════════════

function countApproved() {
  return readyItems.filter(r => r.approved).length
       + conflictItems.filter(r => r.approved).length;
}

function updateApprovedCount() {
  const n   = countApproved();
  const el  = document.getElementById("approvedCount");
  const btn = document.getElementById("commitBtn");
  const bar = document.getElementById("commitActions");
  if (el)  el.textContent  = n === 0 ? "No games approved yet." : `${n} game${n !== 1 ? "s" : ""} approved`;
  if (btn) btn.disabled    = n === 0;
  if (bar) bar.style.display = "";
}

function renderReady() {
  const panel = document.getElementById("tabReady");
  if (!readyItems.length) {
    panel.innerHTML = `<p style="color:var(--light-text);padding:16px 0">No conflict-free games found.</p>`;
    return;
  }
  const allApproved = readyItems.every(r => r.approved);
  panel.innerHTML = `
    <div class="page-actions" style="margin-bottom:8px">
      <button type="button" class="btn" id="approveAllReadyBtn">${allApproved ? "Unapprove All" : "Approve All"}</button>
      <button type="button" class="btn print-btn" id="skipAllReadyBtn">Skip All</button>
    </div>
    <div class="schedule-section" style="margin-top:0">
      <table>
        <thead><tr>
          <th>Date</th><th>Time</th><th>Field</th><th>Div</th><th>City</th>
          <th>Teams</th><th>Source</th><th>Umpire?</th><th>Action</th>
        </tr></thead>
        <tbody id="readyBody"></tbody>
      </table>
    </div>`;

  const tbody = document.getElementById("readyBody");
  tbody.innerHTML = readyItems.map((item, i) => {
    const ht = findHomeTeam(item.game.homeTeam);
    const needsU = ht?.needsUmpireForHome || item.game.needsUmpires;
    return `
    <tr class="${item.approved ? "sched-row-approved" : ""}">
      ${gameRowCells(item.game)}
      <td>
        <label style="display:flex;align-items:center;gap:4px;font-size:0.82rem;cursor:pointer;font-weight:normal">
          <input type="checkbox" class="ready-umpire-chk" data-idx="${i}" ${needsU ? "checked" : ""} />
          <span style="font-size:0.78rem">⚾</span>
        </label>
      </td>
      <td>
        <button type="button" class="btn ${item.approved ? "" : "print-btn"} ready-toggle-btn" data-idx="${i}">
          ${item.approved ? "✓ Approved" : "Approve"}
        </button>
      </td>
    </tr>`;
  }).join("");

  document.getElementById("approveAllReadyBtn").addEventListener("click", () => {
    const newVal = !readyItems.every(r => r.approved);
    readyItems.forEach(r => r.approved = newVal);
    renderReady(); updateApprovedCount();
  });
  document.getElementById("skipAllReadyBtn").addEventListener("click", () => {
    readyItems.forEach(r => r.approved = false);
    renderReady(); updateApprovedCount();
  });
  tbody.querySelectorAll(".ready-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      readyItems[parseInt(btn.dataset.idx)].approved ^= true;
      renderReady(); updateApprovedCount();
    });
  });
  tbody.querySelectorAll(".ready-umpire-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      readyItems[parseInt(chk.dataset.idx)].game.needsUmpires = chk.checked;
    });
  });
}

function renderConflicts() {
  const panel = document.getElementById("tabConflicts");
  if (!conflictItems.length) {
    panel.innerHTML = `<p style="color:var(--light-text);padding:16px 0">No conflicts detected.</p>`;
    return;
  }
  panel.innerHTML = `
    <div class="document-note" style="margin-bottom:16px">
      <p style="margin:0">Each game below has at least one issue. Review, edit, approve anyway, or skip.</p>
    </div>
    <div id="conflictRows"></div>`;

  const container = document.getElementById("conflictRows");
  container.innerHTML = conflictItems.map((item, i) => {
    const game = item.edited ? { ...item.game, ...item.editedFields } : item.game;
    const ht   = findHomeTeam(game.homeTeam);
    const needsU = ht?.needsUmpireForHome || game.needsUmpires;
    return `
    <div class="sched-conflict-card ${item.approved ? "sched-row-approved" : ""}" data-conflict-idx="${i}">
      <div class="sched-conflict-header">
        <div>
          <strong>${esc(fmtDate(game.date))}</strong>
          <span style="color:var(--light-text);margin-left:8px">${esc(fmt12(game.time))}</span>
          <span style="margin-left:8px">${esc(game.field || "—")}</span>
          <span style="color:var(--light-text);margin-left:8px">${esc(game.division || "")} · ${esc(game.city || "")}</span>
          ${item.edited ? '<span class="sched-edited-badge">edited</span>' : ""}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <label style="display:flex;align-items:center;gap:4px;font-size:0.82rem;cursor:pointer;font-weight:normal">
            <input type="checkbox" class="conflict-umpire-chk" data-idx="${i}" ${needsU ? "checked" : ""} />
            <span style="font-size:0.78rem">⚾ Umpire</span>
          </label>
          <button type="button" class="btn print-btn conflict-edit-btn" data-idx="${i}">✏ Edit</button>
          <button type="button" class="btn ${item.approved ? "" : "print-btn"} conflict-approve-btn" data-idx="${i}">
            ${item.approved ? "✓ Approved" : "Approve Anyway"}
          </button>
          <button type="button" class="btn print-btn conflict-skip-btn" data-idx="${i}">Skip</button>
        </div>
      </div>
      <div class="sched-issue-list">
        ${item.issues.map(issue => `
          <div class="sched-issue-row">
            ${issueBadge(issue)}
            ${issue.with ? `<span style="color:var(--light-text);font-size:0.82rem">
              Existing: ${esc(fmtDate(issue.with.date))} ${esc(fmt12(issue.with.time))} — ${esc(issue.with.field || "")} ${esc(issue.with.division || "")} ${esc(issue.with.city || "")}
            </span>` : ""}
          </div>`).join("")}
      </div>
      <div class="sched-edit-panel" id="editPanel_${i}" style="display:none">
        <div class="form-row" style="flex-wrap:wrap;gap:8px;margin-top:0">
          <div class="form-group form-group--sm">
            <label>Date</label>
            <input type="date" class="edit-date" data-idx="${i}" value="${esc(game.date)}" />
          </div>
          <div class="form-group form-group--sm">
            <label>Time</label>
            <input type="time" class="edit-time" data-idx="${i}" value="${esc(game.time)}" />
          </div>
          <div class="form-group">
            <label>Field</label>
            <input type="text" class="edit-field" data-idx="${i}" value="${esc(game.field)}" placeholder="e.g. NH-North" />
          </div>
          <div class="form-group form-group--sm">
            <label>Division</label>
            <select class="edit-division" data-idx="${i}">
              ${["10U","12U","14U","HS JV","HS Varsity"].map(d =>
                `<option value="${d}" ${game.division === d ? "selected" : ""}>${d}</option>`
              ).join("")}
            </select>
          </div>
          <div class="form-group">
            <label>City / League</label>
            <select class="edit-city" data-idx="${i}">
              <option value="City of Crooks" ${game.city === "City of Crooks" ? "selected" : ""}>City of Crooks</option>
              <option value="City of Colton" ${game.city === "City of Colton" ? "selected" : ""}>City of Colton</option>
            </select>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button type="button" class="btn" data-action="save-edit" data-idx="${i}">Save &amp; Approve</button>
          <button type="button" class="btn print-btn" data-action="cancel-edit" data-idx="${i}">Cancel</button>
        </div>
      </div>
    </div>`;
  }).join("");

  container.querySelectorAll(".conflict-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const panel = document.getElementById(`editPanel_${btn.dataset.idx}`);
      panel.style.display = panel.style.display === "none" ? "" : "none";
    });
  });
  container.querySelectorAll(".conflict-approve-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      conflictItems[parseInt(btn.dataset.idx)].approved ^= true;
      renderConflicts(); updateApprovedCount();
    });
  });
  container.querySelectorAll(".conflict-skip-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      conflictItems[parseInt(btn.dataset.idx)].approved = false;
      renderConflicts(); updateApprovedCount();
    });
  });
  container.querySelectorAll(".conflict-umpire-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      conflictItems[parseInt(chk.dataset.idx)].game.needsUmpires = chk.checked;
    });
  });
  container.querySelectorAll("[data-action='save-edit']").forEach(btn => {
    btn.addEventListener("click", () => {
      const i    = parseInt(btn.dataset.idx);
      conflictItems[i].editedFields = {
        date:     container.querySelector(`.edit-date[data-idx="${i}"]`).value,
        time:     container.querySelector(`.edit-time[data-idx="${i}"]`).value,
        field:    container.querySelector(`.edit-field[data-idx="${i}"]`).value.trim(),
        division: container.querySelector(`.edit-division[data-idx="${i}"]`).value,
        city:     container.querySelector(`.edit-city[data-idx="${i}"]`).value,
      };
      conflictItems[i].edited   = true;
      conflictItems[i].approved = true;
      renderConflicts(); updateApprovedCount();
    });
  });
  container.querySelectorAll("[data-action='cancel-edit']").forEach(btn => {
    btn.addEventListener("click", () => {
      document.getElementById(`editPanel_${btn.dataset.idx}`).style.display = "none";
    });
  });
}

function renderDuplicates() {
  const panel = document.getElementById("tabDuplicates");
  if (!duplicateItems.length) {
    panel.innerHTML = `<p style="color:var(--light-text);padding:16px 0">No duplicates found.</p>`;
    return;
  }
  panel.innerHTML = `
    <p style="color:var(--light-text);font-size:0.88rem;margin-bottom:8px">These games are already in the schedule.</p>
    <div class="schedule-section" style="margin-top:0">
      <table>
        <thead><tr><th>Date</th><th>Time</th><th>Field</th><th>Div</th><th>City</th><th>Teams</th><th>Source</th></tr></thead>
        <tbody>${duplicateItems.map(item => `<tr style="opacity:0.5">${gameRowCells(item)}</tr>`).join("")}</tbody>
      </table>
    </div>`;
}

function renderWarnings() {
  const panel = document.getElementById("tabWarnings");
  if (!warningItems.length) {
    panel.innerHTML = `<p style="color:var(--light-text);padding:16px 0">No fetch warnings.</p>`;
    return;
  }
  panel.innerHTML = warningItems.map(w => `
    <div style="background:#2a1a00;border:1px solid #b8860b;border-radius:6px;padding:10px 14px;margin-bottom:8px">
      <strong>${esc(w.source)}</strong>
      <div style="color:#ccc;font-size:0.85rem;margin-top:4px">${esc(w.message)}</div>
    </div>`).join("");
}

function renderTabs() {
  const tabs = [
    { id: "ready",      label: "Ready",      count: readyItems.length,     color: "#4caf50" },
    { id: "conflicts",  label: "Conflicts",  count: conflictItems.length,  color: "#e53935" },
    { id: "duplicates", label: "Duplicates", count: duplicateItems.length, color: "var(--light-text)" },
    { id: "warnings",   label: "Warnings",   count: warningItems.length,   color: "#f57c00" },
  ];
  document.getElementById("schedulerTabs").innerHTML = tabs.map(t => `
    <button type="button" class="scheduler-tab-btn ${activeTab === t.id ? "active" : ""}" data-tab="${t.id}">
      ${t.label}
      <span style="background:${activeTab===t.id ? t.color : "#444"};color:${activeTab===t.id ? "#fff" : "#aaa"};
                   border-radius:10px;padding:1px 7px;font-size:0.78rem;margin-left:4px">${t.count}</span>
    </button>`).join("");

  document.querySelectorAll(".scheduler-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      renderTabs();
      showActivePanel();
    });
  });
}

function showActivePanel() {
  ["ready","conflicts","duplicates","warnings"].forEach(id => {
    const el = document.getElementById(`tab${id.charAt(0).toUpperCase()+id.slice(1)}`);
    if (el) el.style.display = id === activeTab ? "" : "none";
  });
  if (activeTab === "ready")      renderReady();
  if (activeTab === "conflicts")  renderConflicts();
  if (activeTab === "duplicates") renderDuplicates();
  if (activeTab === "warnings")   renderWarnings();
}

function renderSummaryBar() {
  const readyApproved    = readyItems.filter(r => r.approved).length;
  const conflictApproved = conflictItems.filter(r => r.approved).length;
  document.getElementById("summaryBar").innerHTML = `
    <div class="sched-summary-item" style="color:#4caf50">
      <strong>${readyItems.length}</strong> clean
      ${readyApproved ? `<span style="color:var(--light-text);font-size:0.8rem">(${readyApproved} approved)</span>` : ""}
    </div>
    <div class="sched-summary-item" style="color:#e53935">
      <strong>${conflictItems.length}</strong> conflict${conflictItems.length !== 1 ? "s" : ""}
      ${conflictApproved ? `<span style="color:var(--light-text);font-size:0.8rem">(${conflictApproved} approved)</span>` : ""}
    </div>
    <div class="sched-summary-item" style="color:var(--light-text)">
      <strong>${duplicateItems.length}</strong> duplicate${duplicateItems.length !== 1 ? "s" : ""}
    </div>
    ${warningItems.length ? `<div class="sched-summary-item" style="color:#f57c00">
      <strong>${warningItems.length}</strong> fetch warning${warningItems.length !== 1 ? "s" : ""}
    </div>` : ""}`;
}

/** Show umpire-prompt banner for teams that have needsUmpireForHome */
function updateUmpirePromptBanner() {
  const allGames = [
    ...readyItems.map(r => r.game),
    ...conflictItems.map(c => c.game),
  ];
  const matchedTeams = new Set();
  allGames.forEach(g => {
    const t = findHomeTeam(g.homeTeam);
    if (t?.needsUmpireForHome) matchedTeams.add(t.name);
  });

  const banner = document.getElementById("umpirePromptBanner");
  if (!banner) return;
  if (!matchedTeams.size) { banner.style.display = "none"; return; }

  banner.style.display = "";
  document.getElementById("umpirePromptText").innerHTML =
    `Home games for <strong>${[...matchedTeams].join(", ")}</strong> are pre-checked for umpire assignment. Uncheck the ⚾ checkbox on any game to skip.`;
  // Pre-check needsUmpires on matching games
  allGames.forEach(g => {
    const t = findHomeTeam(g.homeTeam);
    if (t?.needsUmpireForHome) g.needsUmpires = true;
  });
}

function showPreview() {
  activeTab = readyItems.length ? "ready" : conflictItems.length ? "conflicts" : "duplicates";
  const total = readyItems.length + conflictItems.length + duplicateItems.length;
  if (total === 0 && warningItems.length === 0) return false;
  document.getElementById("previewSummary").style.display = "";
  updateUmpirePromptBanner();
  renderSummaryBar();
  renderTabs();
  showActivePanel();
  updateApprovedCount();
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
//  IMPORT — Calendar mode (calls cloud function)
// ══════════════════════════════════════════════════════════════════════════════

document.getElementById("fetchBtn").addEventListener("click", async () => {
  const btn = document.getElementById("fetchBtn");
  const msg = document.getElementById("fetchMessage");
  btn.disabled    = true;
  msg.textContent = "Fetching calendars and checking for conflicts…";
  msg.className   = "signup-message info";
  document.getElementById("previewSummary").style.display = "none";

  try {
    const result = await previewFn();
    const data   = result.data;
    readyItems     = (data.ready      || []).map(g => ({ game: g, approved: false, edited: false, editedFields: {} }));
    conflictItems  = (data.conflicts  || []).map(c => ({ ...c,   approved: false, edited: false, editedFields: {} }));
    duplicateItems = data.duplicates  || [];
    warningItems   = data.warnings    || [];

    if (!showPreview()) {
      msg.textContent = "No new games found in any calendar source.";
      msg.className   = "signup-message info";
    } else {
      msg.textContent = "";
    }
  } catch (err) {
    msg.textContent = "Error: " + (err.message || "Failed to fetch calendars.");
    msg.className   = "signup-message error";
  } finally {
    btn.disabled = false;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  IMPORT — CSV mode
// ══════════════════════════════════════════════════════════════════════════════

// Drag-and-drop on CSV dropzone
const csvDropzone  = document.getElementById("csvDropzone");
const csvFileInput = document.getElementById("csvFileInput");
let parsedCsvGames = [];

csvDropzone.addEventListener("click", () => csvFileInput.click());
csvDropzone.addEventListener("dragover", e => { e.preventDefault(); csvDropzone.classList.add("drag-over"); });
csvDropzone.addEventListener("dragleave", () => csvDropzone.classList.remove("drag-over"));
csvDropzone.addEventListener("drop", e => {
  e.preventDefault();
  csvDropzone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) handleCsvFile(file);
});
csvFileInput.addEventListener("change", e => {
  if (e.target.files[0]) handleCsvFile(e.target.files[0]);
});

function handleCsvFile(file) {
  document.getElementById("csvDropLabel").style.display = "none";
  document.getElementById("csvFileSelected").style.display = "";
  document.getElementById("csvFileName").textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    parsedCsvGames = parseCSV(e.target.result);
    const msg = document.getElementById("csvMessage");
    if (!parsedCsvGames.length) {
      msg.textContent = "No valid rows found in the CSV. Check the format and try again.";
      msg.className   = "signup-message error";
    } else {
      msg.textContent = `${parsedCsvGames.length} game${parsedCsvGames.length !== 1 ? "s" : ""} parsed — ready to preview.`;
      msg.className   = "signup-message info";
    }
  };
  reader.readAsText(file);
}

/**
 * Parse a CSV string into game objects.
 * Accepts flexible column order; header row required.
 * Handles common date/time formats.
 */
function parseCSV(text) {
  const lines  = text.replace(/\r\n?/g, "\n").split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];

  // Normalize header
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
  const col = name => headers.indexOf(name);

  const idxDate   = Math.max(col("date"), col("gamedate"));
  const idxTime   = Math.max(col("time"), col("gametime"), col("starttime"));
  const idxDiv    = Math.max(col("division"), col("div"), col("age"), col("agedivision"));
  const idxCity   = Math.max(col("city"), col("league"), col("cityleague"));
  const idxField  = Math.max(col("field"), col("fieldlocation"), col("location"));
  const idxHome   = Math.max(col("hometeam"), col("home"));
  const idxAway   = Math.max(col("awayteam"), col("away"), col("visitor"), col("visitingteam"));
  const idxType   = Math.max(col("gametype"), col("type"));

  const games = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCSVRow(lines[i]);
    if (cells.length < 2) continue;

    const rawDate = idxDate >= 0 ? cells[idxDate]?.trim() : "";
    const isoDate = normalizeDate(rawDate);
    if (!isoDate) continue; // skip rows with no parseable date

    const rawTime = idxTime >= 0 ? cells[idxTime]?.trim() : "";
    const isoTime = normalizeTime(rawTime);

    games.push({
      source:      "csv",
      sourceLabel: "CSV Import",
      sourceType:  "csv",
      externalId:  null,
      date:        isoDate,
      time:        isoTime || "",
      division:    idxDiv  >= 0 ? (cells[idxDiv]?.trim()  || "")  : "",
      city:        idxCity >= 0 ? (cells[idxCity]?.trim() || "")  : "",
      field:       idxField >= 0 ? (cells[idxField]?.trim() || "") : "",
      homeTeam:    idxHome >= 0 ? (cells[idxHome]?.trim()  || "") : "",
      awayTeam:    idxAway >= 0 ? (cells[idxAway]?.trim()  || "") : "",
      gameType:    idxType >= 0 ? (cells[idxType]?.trim()  || "Regular") : "Regular",
      needsUmpires: false,
      cancelled:   false,
      umpireSlots: [],
    });
  }
  return games;
}

function splitCSVRow(line) {
  const result = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && (i === 0 || line[i-1] !== "\\")) { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { result.push(cur); cur = ""; }
    else cur += ch;
  }
  result.push(cur);
  return result;
}

function normalizeDate(s) {
  if (!s) return "";
  // YYYY-MM-DD already good
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // M/D/YYYY or MM/DD/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2,"0")}-${String(m[2]).padStart(2,"0")}`;
  return "";
}

function normalizeTime(s) {
  if (!s) return "";
  // HH:MM already
  if (/^\d{2}:\d{2}$/.test(s)) return s;
  // H:MM AM/PM
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m) {
    let h = parseInt(m[1]);
    const mins = m[2];
    const pm   = m[3].toUpperCase() === "PM";
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return `${String(h).padStart(2,"0")}:${mins}`;
  }
  return "";
}

// Client-side conflict check for CSV games
async function previewCSVGames() {
  const msg = document.getElementById("csvMessage");
  const btn = document.getElementById("csvPreviewBtn");
  btn.disabled    = true;
  msg.textContent = "Loading existing games and checking conflicts…";
  msg.className   = "signup-message info";
  document.getElementById("previewSummary").style.display = "none";

  try {
    // Load existing games, scheduling config, and facilities in parallel
    const [gamesSnap, configSnap, facilitiesSnap] = await Promise.all([
      getDocs(collection(db, "games")),
      getDoc(doc(db, "config/scheduling")),
      getDocs(collection(db, "facilities")),
    ]);
    const existingGames = gamesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const schedCfg      = configSnap.exists() ? configSnap.data() : {};
    const durMap        = schedCfg.gameDurationMinutes || { "10U": 90, "12U": 90, "14U": 120, "HS JV": 120, "HS Varsity": 150, default: 90 };
    const lateStartMins = timeToMins(schedCfg.lateStartCutoff || "19:30");

    // Build field index: fieldName.toLowerCase() → { lights, supportedDivisions }
    const fieldIndex = {};
    facilitiesSnap.docs.forEach(d => {
      (d.data().fields || []).forEach(f => {
        if (f.name) fieldIndex[f.name.trim().toLowerCase()] = f;
      });
    });

    const today = todayISO();
    readyItems     = [];
    conflictItems  = [];
    duplicateItems = [];
    warningItems   = [];

    for (const game of parsedCsvGames) {
      if (!game.date || game.date < today) {
        duplicateItems.push({ ...game, _reason: "Past date" });
        continue;
      }
      // Dedup: same date + time + field + city
      const dupCheck = existingGames.find(g =>
        g.date === game.date && g.time === game.time &&
        (g.field||"").toLowerCase() === (game.field||"").toLowerCase() &&
        (g.city||"").toLowerCase()  === (game.city||"").toLowerCase()
      );
      if (dupCheck) {
        duplicateItems.push({ ...game, _reason: "Already in schedule" });
        continue;
      }

      const issues   = [];
      const fieldKey = (game.field || "").trim().toLowerCase();
      const fieldObj = fieldIndex[fieldKey] || null;

      // 1. Field time overlap vs existing games
      for (const ex of existingGames) {
        if (!ex.cancelled && gamesOverlapLocal(game, ex, durMap)) {
          issues.push({ type: "field_overlap", label: "Field time overlap", color: "#e53935",
            with: { id: ex.id, date: ex.date, time: ex.time, field: ex.field, division: ex.division, city: ex.city } });
        }
      }
      // 2. Batch overlap vs other incoming games
      for (const other of [...readyItems.map(r => r.game), ...conflictItems.map(c => c.game)]) {
        if (other && gamesOverlapLocal(game, other, durMap)) {
          issues.push({ type: "batch_overlap", label: "Overlaps another incoming game", color: "#e53935",
            with: { date: other.date, time: other.time, field: other.field, division: other.division } });
          break;
        }
      }
      // 3. No lights / late start
      if (game.time && fieldObj !== null && !fieldObj.lights) {
        const startMin = timeToMins(game.time);
        if (startMin !== null && startMin > lateStartMins) {
          issues.push({ type: "no_lights",
            label: `Starts after ${schedCfg.lateStartCutoff || "19:30"} — field has no lights`,
            color: "#f57c00" });
        }
      }
      // 4. Division mismatch
      if (fieldObj) {
        const supported = fieldObj.supportedDivisions || [];
        if (supported.length && game.division && !supported.includes(game.division)) {
          issues.push({ type: "division_mismatch",
            label: `${game.division} not in supported divisions for ${game.field} (${supported.join(", ")})`,
            color: "#f9a825" });
        }
      }

      if (issues.length === 0) readyItems.push({ game, approved: false, edited: false, editedFields: {} });
      else                     conflictItems.push({ game, issues, approved: false, edited: false, editedFields: {} });
    }

    if (!showPreview()) {
      msg.textContent = "No new games found — all rows were duplicates or past dates.";
      msg.className   = "signup-message info";
    } else {
      msg.textContent = "";
    }
  } catch (err) {
    msg.textContent = "Error: " + err.message;
    msg.className   = "signup-message error";
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("csvPreviewBtn").addEventListener("click", previewCSVGames);

function timeToMins(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

function gamesOverlapLocal(g1, g2, durMap) {
  if (g1.date !== g2.date) return false;
  const f1 = (g1.field || "").trim().toLowerCase();
  const f2 = (g2.field || "").trim().toLowerCase();
  if (!f1 || !f2 || f1 !== f2) return false;
  const s1 = timeToMins(g1.time);
  const s2 = timeToMins(g2.time);
  if (s1 === null || s2 === null) return false;
  const d1 = durMap[g1.division] ?? durMap["default"] ?? 90;
  const d2 = durMap[g2.division] ?? durMap["default"] ?? 90;
  return s1 < s2 + d2 && s2 < s1 + d1;
}

// ══════════════════════════════════════════════════════════════════════════════
//  IMPORT — Commit (shared)
// ══════════════════════════════════════════════════════════════════════════════

document.getElementById("commitBtn").addEventListener("click", async () => {
  const btn = document.getElementById("commitBtn");
  const msg = document.getElementById("commitMessage");

  const approved = [
    ...readyItems.filter(r => r.approved).map(r => r.game),
    ...conflictItems.filter(r => r.approved).map(r =>
      r.edited ? { ...r.game, ...r.editedFields } : r.game
    ),
  ];

  if (!approved.length) {
    msg.textContent = "No games approved — nothing to import.";
    msg.className   = "signup-message error";
    return;
  }
  if (!confirm(`Import ${approved.length} approved game${approved.length !== 1 ? "s" : ""} into the schedule?`)) return;

  btn.disabled    = true;
  msg.textContent = "Importing…";
  msg.className   = "signup-message info";

  try {
    const result = await commitFn({ games: approved });
    const added  = result.data.added || 0;
    msg.textContent = `✓ ${added} game${added !== 1 ? "s" : ""} added to the schedule.`;
    msg.className   = "signup-message success";

    // Remove committed games from local state
    const committed = new Set(approved.map(g => JSON.stringify({ d: g.date, t: g.time, f: g.field, c: g.city })));
    const keep = item => !committed.has(JSON.stringify({ d: item.game.date, t: item.game.time, f: item.game.field, c: item.game.city }));
    readyItems    = readyItems.filter(keep);
    conflictItems = conflictItems.filter(keep);
    renderSummaryBar();
    renderTabs();
    showActivePanel();
    updateApprovedCount();
  } catch (err) {
    msg.textContent = "Import failed: " + (err.message || "Unknown error.");
    msg.className   = "signup-message error";
  } finally {
    btn.disabled = false;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  UMPIRE ASSIGN FLOW (used from game edit modal)
// ══════════════════════════════════════════════════════════════════════════════

async function loadSchedApprovedUmpires() {
  if (schedApprovedUmpires.length) return;
  try {
    const snap = await getDocs(query(
      collection(db, "umpires"),
      where("approved", "==", true),
      orderBy("name")
    ));
    schedApprovedUmpires = snap.docs.map(d => ({
      uid:   d.id,
      name:  d.data().name  || d.data().displayName || "",
      email: d.data().email || "",
    }));
  } catch (err) {
    console.error("loadSchedApprovedUmpires:", err);
  }
}

async function loadSchedAllAvailability() {
  try {
    const snap = await getDocs(collection(db, "availability"));
    schedUmpireUnavailable = {};
    snap.forEach(d => {
      schedUmpireUnavailable[d.id] = new Set(d.data().unavailableDates || []);
    });
  } catch (err) {
    console.error("loadSchedAllAvailability:", err);
    schedUmpireUnavailable = {};
  }
}

function renderSchedAssignList(filter = "") {
  const list      = document.getElementById("schedAssignList");
  const lower     = filter.toLowerCase();
  const gameDate  = schedAssignTarget?.gameDate  || "";
  const gameTime  = schedAssignTarget?.gameTime  || "";
  const gameId    = schedAssignTarget?.gameId    || "";
  const shown = schedApprovedUmpires.filter(u =>
    !filter || u.name.toLowerCase().includes(lower) || u.email.toLowerCase().includes(lower)
  );

  if (!shown.length) {
    list.innerHTML = `<p style="padding:12px 16px;color:var(--light-text);margin:0">No matching umpires.</p>`;
    return;
  }

  list.innerHTML = shown.map(u => {
    const unavail  = gameDate && schedUmpireUnavailable[u.uid]?.has(gameDate);
    const conflict = gameDate && gameTime && calGamesCache.some(g =>
      g.id !== gameId &&
      g.date === gameDate && g.time === gameTime &&
      !g.cancelled &&
      (g.umpireSlots || []).some(s => s.assignedUid === u.uid)
    );
    const badges = [
      unavail  ? `<span style="font-size:0.75rem;color:#fca;background:#5a2000;border-radius:4px;padding:2px 7px">Unavailable</span>` : "",
      conflict ? `<span style="font-size:0.75rem;color:#f88;background:#4a0000;border-radius:4px;padding:2px 7px">Conflict</span>`    : "",
    ].filter(Boolean).join(" ");
    return `
    <div class="assign-umpire-row" data-uid="${esc(u.uid)}" data-name="${esc(u.name)}"
      style="padding:10px 16px;cursor:pointer;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-weight:bold;display:flex;align-items:center;flex-wrap:wrap;gap:4px">${esc(u.name)}${badges ? ` ${badges}` : ""}</div>
        ${u.email ? `<div style="font-size:0.8rem;color:var(--light-text)">${esc(u.email)}</div>` : ""}
      </div>
      <button class="btn print-btn" style="font-size:0.8rem;padding:4px 12px;flex-shrink:0">Assign</button>
    </div>`;
  }).join("");
}

async function openSchedAssignModal(gameId, slotType) {
  schedAssignTarget = {
    gameId,
    slotType,
    gameDate: seCurrentGame?.date || "",
    gameTime: seCurrentGame?.time || "",
  };
  document.getElementById("schedAssignLabel").textContent =
    `${slotType} slot — ${seCurrentGame?.city || ""} ${fmtDate(seCurrentGame?.date)} ${fmt12(seCurrentGame?.time)}`;
  document.getElementById("schedAssignSearch").value = "";
  document.getElementById("schedAssignMsg").textContent = "";

  await Promise.all([loadSchedApprovedUmpires(), loadSchedAllAvailability()]);
  renderSchedAssignList();
  document.getElementById("schedAssignModal").style.display = "flex";
  document.getElementById("schedAssignSearch").focus();
}

async function doSchedAssign(uid, name) {
  if (!schedAssignTarget) return;
  const { gameId, slotType } = schedAssignTarget;
  const msgEl = document.getElementById("schedAssignMsg");
  msgEl.textContent = "Saving…";
  msgEl.className   = "signup-message info";
  try {
    const gameRef = doc(db, "games", gameId);
    const snap    = await getDoc(gameRef);
    if (!snap.exists()) throw new Error("Game not found.");
    const slots = (snap.data().umpireSlots || []).map(s =>
      s.type === slotType ? { ...s, assignedUid: uid, assignedName: name } : s
    );
    await updateDoc(gameRef, { umpireSlots: slots });
    // Update local cache and reopen edit modal with refreshed data
    if (seCurrentGame) seCurrentGame.umpireSlots = slots;
    const idx = calGamesCache.findIndex(g => g.id === gameId);
    if (idx >= 0) calGamesCache[idx].umpireSlots = slots;
    document.getElementById("schedAssignModal").style.display = "none";
    renderSeSlots();
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className   = "signup-message error";
  }
}

async function unassignSchedSlot(gameId, slotType) {
  if (!confirm(`Remove the umpire from the ${slotType} slot?`)) return;
  try {
    const gameRef = doc(db, "games", gameId);
    const snap    = await getDoc(gameRef);
    if (!snap.exists()) return;
    const slots = (snap.data().umpireSlots || []).map(s =>
      s.type === slotType ? { ...s, assignedUid: null, assignedName: null } : s
    );
    await updateDoc(gameRef, { umpireSlots: slots });
    if (seCurrentGame) seCurrentGame.umpireSlots = slots;
    const idx = calGamesCache.findIndex(g => g.id === gameId);
    if (idx >= 0) calGamesCache[idx].umpireSlots = slots;
    renderSeSlots();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

/** Render the current umpire slots inside the game edit modal */
function renderSeSlots() {
  const el = document.getElementById("seSlotList");
  if (!el || !seCurrentGame) return;
  const slots    = seCurrentGame.umpireSlots || [];
  const gameId   = seCurrentGame.id;
  const canEdit  = !seCurrentGame.cancelled;

  if (!slots.length) {
    el.innerHTML = `<p style="padding:10px 14px;color:var(--light-text);margin:0;font-size:0.88rem">No umpire slots — toggle "Needs umpire assignment" and save first.</p>`;
    return;
  }

  el.innerHTML = slots.map(s => {
    const cls       = s.type === "Plate" ? "plate" : s.type === "Field" ? "field" : "extra";
    const assigned  = s.assignedName || "";
    const checkIn   = s.checkedIn
      ? `<span style="font-size:0.72rem;background:#17351f;color:#b8f2c4;border-radius:4px;padding:1px 6px">✓ In</span>`
      : (s.assignedUid ? `<span style="font-size:0.72rem;background:#3a2800;color:#ffcc80;border-radius:4px;padding:1px 6px">Not in</span>` : "");
    return `
    <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #333;flex-wrap:wrap">
      <span class="badge badge-${cls}">${esc(s.type)}</span>
      ${s.payRate != null ? `<span style="color:var(--light-text);font-size:0.82rem">$${Number(s.payRate).toFixed(0)}</span>` : ""}
      ${assigned
        ? `<span style="font-size:0.85rem">→ <strong>${esc(assigned)}</strong></span>${checkIn}`
        : `<span style="color:var(--light-text);font-size:0.82rem">Unassigned</span>`}
      <div style="margin-left:auto;display:flex;gap:6px">
        ${assigned && canEdit
          ? `<button type="button" class="btn print-btn se-unassign-btn" data-game-id="${esc(gameId)}" data-slot-type="${esc(s.type)}"
               style="font-size:0.78rem;padding:3px 8px">Unassign</button>`
          : ""}
        ${canEdit
          ? `<button type="button" class="btn print-btn se-assign-btn" data-game-id="${esc(gameId)}" data-slot-type="${esc(s.type)}"
               style="font-size:0.78rem;padding:3px 8px">Assign</button>`
          : ""}
      </div>
    </div>`;
  }).join("");

  // Wire slot buttons
  el.querySelectorAll(".se-assign-btn").forEach(btn => {
    btn.addEventListener("click", () => openSchedAssignModal(btn.dataset.gameId, btn.dataset.slotType));
  });
  el.querySelectorAll(".se-unassign-btn").forEach(btn => {
    btn.addEventListener("click", () => unassignSchedSlot(btn.dataset.gameId, btn.dataset.slotType));
  });
}

// Wire assign modal search + list + cancel
document.getElementById("schedAssignSearch").addEventListener("input", function() {
  renderSchedAssignList(this.value);
});
document.getElementById("schedAssignList").addEventListener("click", e => {
  const row = e.target.closest(".assign-umpire-row");
  if (!row) return;
  doSchedAssign(row.dataset.uid, row.dataset.name);
});
document.getElementById("schedAssignCancelBtn").addEventListener("click", () => {
  document.getElementById("schedAssignModal").style.display = "none";
});
document.getElementById("schedAssignModal").addEventListener("click", e => {
  if (e.target === document.getElementById("schedAssignModal"))
    document.getElementById("schedAssignModal").style.display = "none";
});

// ══════════════════════════════════════════════════════════════════════════════
//  CALENDAR SECTION
// ══════════════════════════════════════════════════════════════════════════════

const MONTH_NAMES = ["January","February","March","April","May","June",
                     "July","August","September","October","November","December"];
const DOW_LABELS  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

async function loadCalendar() {
  const label = document.getElementById("calMonthLabel");
  if (label) label.textContent = `${MONTH_NAMES[calMonth]} ${calYear}`;
  renderCalendarLegend();
  await fetchCalendarData();
  if (calView === "month") renderMonthView();
  else                     renderListView();
}

async function fetchCalendarData() {
  const firstOfMonth = new Date(calYear, calMonth, 1);
  const gridStart    = new Date(firstOfMonth);
  gridStart.setDate(1 - firstOfMonth.getDay());
  const lastOfMonth  = new Date(calYear, calMonth + 1, 0);
  const gridEnd      = new Date(lastOfMonth);
  gridEnd.setDate(lastOfMonth.getDate() + (6 - lastOfMonth.getDay()));
  const startISO = isoFromDate(gridStart);
  const endISO   = isoFromDate(gridEnd);

  const [gamesSnap, practicesSnap, availSnap, cancelSnap] = await Promise.all([
    getDocs(query(collection(db, "games"),
      where("date", ">=", startISO), where("date", "<=", endISO),
      orderBy("date"), orderBy("time"))),
    getDocs(query(collection(db, "practices"),
      where("date", ">=", startISO), where("date", "<=", endISO))),
    getDocs(collection(db, "availability")),
    getDocs(query(collection(db, "cancellationRequests"), where("status", "==", "pending"))),
  ]);
  calGamesCache     = gamesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  calPracticesCache = practicesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Build availability overlay: date → count of umpires marked unavailable
  calUnavailByDate = {};
  availSnap.forEach(d => {
    (d.data().unavailableDates || []).forEach(dateStr => {
      if (dateStr >= startISO && dateStr <= endISO) {
        calUnavailByDate[dateStr] = (calUnavailByDate[dateStr] || 0) + 1;
      }
    });
  });

  // Build pending-cancellation set: gameIds that have pending cancellation requests
  calPendingCancelIds = new Set(cancelSnap.docs.map(d => d.data().gameId).filter(Boolean));

  // Rebuild field filter options from fresh data
  populateFieldFilter();
}

function renderCalendarLegend() {
  const el = document.getElementById("calLegend");
  if (!el) return;
  if (!teams.length) { el.innerHTML = ""; return; }
  el.innerHTML = teams.map(t =>
    `<span style="display:flex;align-items:center;gap:4px">
       <span style="width:12px;height:12px;border-radius:2px;background:${esc(t.color)};flex-shrink:0"></span>
       ${esc(t.name)}
     </span>`
  ).join("") + `<span style="display:flex;align-items:center;gap:4px">
    <span style="width:12px;height:12px;border-radius:2px;background:#5b8dd9;flex-shrink:0"></span>
    Practice
  </span>`;
}

function renderMonthView() {
  const grid = document.getElementById("calMonthView");
  if (!grid) return;

  const showGames     = document.getElementById("calShowGames")?.checked ?? true;
  const showPractices = document.getElementById("calShowPractices")?.checked ?? true;

  const firstOfMonth = new Date(calYear, calMonth, 1);
  const gridStart    = new Date(firstOfMonth);
  gridStart.setDate(1 - firstOfMonth.getDay());
  const lastOfMonth  = new Date(calYear, calMonth + 1, 0);
  const gridEnd      = new Date(lastOfMonth);
  gridEnd.setDate(lastOfMonth.getDate() + (6 - lastOfMonth.getDay()));

  // Build day → items map from cache
  const dayMap = {};
  if (showGames) {
    calGamesCache.forEach(g => {
      // Only hide outright-cancelled games; show rainout/rescheduled as muted cards
      if (g.cancelled && g.cancellationType !== "rainout" && g.cancellationType !== "rescheduled") return;
      if (!filterGame(g)) return;
      if (!dayMap[g.date]) dayMap[g.date] = { games: [], practices: [] };
      dayMap[g.date].games.push(g);
    });
  }
  if (showPractices) {
    calPracticesCache.forEach(p => {
      if (!filterPractice(p)) return;
      if (!dayMap[p.date]) dayMap[p.date] = { games: [], practices: [] };
      dayMap[p.date].practices.push(p);
    });
  }
  updateFilterCount();

  const todayISO_ = todayISO();
  // Collect game data keyed by a card ID so we can open edit modal on click
  const gameById = {};
  calGamesCache.forEach(g => { gameById[g.id] = g; });

  let html = `<div class="cal-month-grid">`;
  html += DOW_LABELS.map(d => `<div class="cal-dow-header">${d}</div>`).join("");

  const cur = new Date(gridStart);
  while (cur <= gridEnd) {
    const iso = isoFromDate(cur);
    const isThisMonth = cur.getMonth() === calMonth;
    const isToday     = iso === todayISO_;
    const items       = dayMap[iso] || { games: [], practices: [] };

    html += `<div class="cal-month-cell ${!isThisMonth ? "cal-other-month" : ""} ${isToday ? "cal-today" : ""}">`;
    const unavailCount = calUnavailByDate[iso] || 0;
    html += `<div style="display:flex;align-items:center;justify-content:space-between">
      <div class="${isToday ? "cal-today-num" : "cal-day-num"}">${cur.getDate()}</div>
      ${unavailCount ? `<div title="${unavailCount} umpire${unavailCount !== 1 ? "s" : ""} unavailable" style="font-size:0.62rem;color:#fca;padding:1px 4px;background:#5a200033;border-radius:3px">${unavailCount} out</div>` : ""}
    </div>`;

    // Games always get priority: fill up to MAX_CELL slots; practices take whatever remains.
    const MAX_CELL      = 4;
    const gamesToShow   = items.games.slice(0, Math.min(items.games.length, MAX_CELL));
    const practiceSlots = Math.max(0, MAX_CELL - gamesToShow.length);
    const practicesToShow = items.practices.slice(0, practiceSlots);

    // Game cards (clickable → edit)
    gamesToShow.forEach(g => {
      const color    = teamColor(g);
      const slots    = g.umpireSlots || [];
      const assigned = slots.filter(s => s.assignedUid).length;
      const total    = slots.length;
      const label    = g.homeTeam && g.awayTeam
        ? `${g.awayTeam.split(" ").pop()} @ ${g.homeTeam.split(" ").pop()}`
        : (g.homeTeam || g.division || "Game");
      const hasPendingCancel = calPendingCancelIds.has(g.id);
      const isMuted = g.cancelled && (g.cancellationType === "rainout" || g.cancellationType === "rescheduled");
      const mutedIcon = g.cancellationType === "rainout" ? "🌧" : "🔄";
      html += `<div class="cal-card cal-card-clickable" data-game-id="${esc(g.id)}"
          style="border-left-color:${color};cursor:pointer${isMuted ? ";opacity:0.5;border-style:dashed" : ""}${hasPendingCancel ? ";outline:1px solid #f57c00" : ""}"
          title="${isMuted ? (g.cancellationType === "rainout" ? "Rain Out" : "Rescheduled") + " · " : "Click to edit · "}${esc(g.homeTeam||"")} vs ${esc(g.awayTeam||"")} · ${g.city||""} · ${g.field||""}">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div style="font-size:0.7rem;color:var(--light-text)">${isMuted ? mutedIcon : ""} ${g.time ? fmt12(g.time).replace(":00","") : ""} ${esc(g.division || "")}</div>
            ${hasPendingCancel ? `<span title="Pending cancellation request" style="font-size:0.65rem;color:#f57c00">⚠</span>` : ""}
          </div>
          <div style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(label)}</div>
          ${total && !isMuted ? `<div style="font-size:0.68rem;color:${assigned===total?"#6fcf97":"#ffcc80"}">${assigned}/${total} ump</div>` : ""}
        </div>`;
    });
    if (items.games.length > gamesToShow.length) {
      html += `<div style="font-size:0.7rem;color:var(--light-text);padding:1px 4px">+${items.games.length - gamesToShow.length} more game${items.games.length - gamesToShow.length !== 1 ? "s" : ""}</div>`;
    }

    // Practice cards (fill remaining cell space after games)
    practicesToShow.forEach(p => {
      html += `<div class="cal-card cal-practice-clickable" data-practice-id="${esc(p.id)}" style="border-left-color:#5b8dd9;cursor:pointer"
          title="Practice: ${esc(p.teamName||"")} · ${p.field||""} — click to edit">
          <div style="font-size:0.7rem;color:#8ab4f8">${p.startTime ? fmt12(p.startTime).replace(":00","") : "Practice"}</div>
          <div style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:0.78rem">${esc(p.teamName||"Practice")}</div>
        </div>`;
    });
    if (items.practices.length > practicesToShow.length) {
      const hiddenPractices = items.practices.length - practicesToShow.length;
      html += `<div style="font-size:0.7rem;color:#8ab4f8;padding:1px 4px">+${hiddenPractices} practice${hiddenPractices !== 1 ? "s" : ""}</div>`;
    }

    html += `</div>`;
    cur.setDate(cur.getDate() + 1);
  }
  html += `</div>`;
  grid.innerHTML = html;

  // Wire click handlers on game cards
  grid.querySelectorAll(".cal-card-clickable").forEach(card => {
    card.addEventListener("click", () => {
      const g = gameById[card.dataset.gameId];
      if (g) openGameEditModal(g);
    });
  });

  // Wire click handlers on practice cards
  const practiceByIdMonth = {};
  calPracticesCache.forEach(p => { practiceByIdMonth[p.id] = p; });
  grid.querySelectorAll(".cal-practice-clickable").forEach(card => {
    card.addEventListener("click", () => {
      const p = practiceByIdMonth[card.dataset.practiceId];
      if (p) openPracticeEditModal(p);
    });
  });
}

function renderListView() {
  const el = document.getElementById("calListContent");
  if (!el) return;

  const showGames     = document.getElementById("calShowGames")?.checked ?? true;
  const showPractices = document.getElementById("calShowPractices")?.checked ?? true;

  const firstOfMonth = isoFromDate(new Date(calYear, calMonth, 1));
  const lastOfMonth  = isoFromDate(new Date(calYear, calMonth + 1, 0));

  const games = showGames
    ? calGamesCache.filter(g => {
        if (g.cancelled && g.cancellationType !== "rainout" && g.cancellationType !== "rescheduled") return false;
        if (!filterGame(g)) return false;
        return g.date >= firstOfMonth && g.date <= lastOfMonth;
      })
    : [];
  const practices = showPractices
    ? calPracticesCache.filter(p =>
        filterPractice(p) && p.date >= firstOfMonth && p.date <= lastOfMonth)
    : [];
  updateFilterCount();

  if (!games.length && !practices.length) {
    el.innerHTML = `<p style="color:var(--light-text)">No games or practices for ${MONTH_NAMES[calMonth]} ${calYear}.</p>`;
    return;
  }

  // Combine and sort by date + time
  const all = [
    ...games.map(g => ({ ...g, _type: "game" })),
    ...practices.map(p => ({ ...p, _type: "practice", time: p.startTime })),
  ].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.time || "") < (b.time || "") ? -1 : 1;
  });

  el.innerHTML = `
    <div class="schedule-section" style="margin-top:0">
      <table>
        <thead><tr>
          <th>Date</th><th>Time</th><th>Type</th><th>Division</th>
          <th>Teams / Team</th><th>City</th><th>Field</th><th>Umpires</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${all.map(item => {
            if (item._type === "game") {
              const color    = teamColor(item);
              const slots    = item.umpireSlots || [];
              const assigned = slots.filter(s => s.assignedUid).length;
              const total    = slots.length;
              const teams_   = item.homeTeam && item.awayTeam
                ? `${item.awayTeam} @ ${item.homeTeam}`
                : (item.homeTeam || item.awayTeam || "—");
              const pendingCancelRow = calPendingCancelIds.has(item.id);
              const isMuted = item.cancelled && (item.cancellationType === "rainout" || item.cancellationType === "rescheduled");
              const cancelIcon = item.cancellationType === "rainout" ? "🌧" : item.cancellationType === "rescheduled" ? "🔄" : "";
              const rowStyle = isMuted
                ? 'style="opacity:0.55;background:rgba(100,100,100,0.04)"'
                : pendingCancelRow ? 'style="background:rgba(245,124,0,0.06)"' : "";
              return `<tr ${rowStyle}>
                <td>${esc(fmtDate(item.date))}</td>
                <td>${esc(fmt12(item.time))}</td>
                <td><span style="width:10px;height:10px;background:${color};border-radius:2px;display:inline-block;margin-right:4px;vertical-align:middle"></span>${cancelIcon ? `<span style="margin-right:4px">${cancelIcon}</span>` : ""}${esc(item.gameType || "Regular")}</td>
                <td>${esc(item.division || "—")}</td>
                <td>${esc(teams_)}</td>
                <td>${esc(item.city || "—")}</td>
                <td>${esc(item.field || "—")}</td>
                <td style="color:${assigned===total&&total&&!isMuted?"#6fcf97":"#ffcc80"}">${isMuted ? cancelIcon || "—" : total ? `${assigned}/${total}` : "—"}${pendingCancelRow ? ` <span title="Pending cancellation" style="color:#f57c00;font-size:0.8rem">⚠</span>` : ""}</td>
                <td>
                  <button type="button" class="btn print-btn list-edit-btn" data-game-id="${esc(item.id)}"
                    style="padding:3px 8px;font-size:0.8rem">Edit</button>
                </td>
              </tr>`;
            } else {
              return `<tr style="opacity:0.8">
                <td>${esc(fmtDate(item.date))}</td>
                <td>${esc(item.startTime ? fmt12(item.startTime) : "—")} – ${esc(item.endTime ? fmt12(item.endTime) : "—")}</td>
                <td><span style="font-size:0.75rem;background:#1a2a4a;color:#8ab4f8;border:1px solid #2a4a8a;border-radius:3px;padding:1px 5px">Practice</span></td>
                <td>${esc(item.division || "—")}</td>
                <td>${esc(item.teamName || "—")}</td>
                <td>—</td>
                <td>${esc(item.field || "—")}</td>
                <td>—</td>
                <td>
                  <button type="button" class="btn print-btn list-practice-edit-btn" data-practice-id="${esc(item.id)}"
                    style="padding:3px 8px;font-size:0.8rem">Edit</button>
                </td>
              </tr>`;
            }
          }).join("")}
        </tbody>
      </table>
    </div>`;

  // Wire game edit buttons
  const gameById = {};
  calGamesCache.forEach(g => { gameById[g.id] = g; });
  el.querySelectorAll(".list-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const g = gameById[btn.dataset.gameId];
      if (g) openGameEditModal(g);
    });
  });

  // Wire practice edit buttons
  const practiceByIdList = {};
  calPracticesCache.forEach(p => { practiceByIdList[p.id] = p; });
  el.querySelectorAll(".list-practice-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = practiceByIdList[btn.dataset.practiceId];
      if (p) openPracticeEditModal(p);
    });
  });
}

function isoFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// Calendar nav
document.getElementById("calPrevBtn").addEventListener("click", () => {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  loadCalendar();
});
document.getElementById("calNextBtn").addEventListener("click", () => {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  loadCalendar();
});
document.getElementById("calTodayBtn").addEventListener("click", () => {
  const n = new Date();
  calYear = n.getFullYear(); calMonth = n.getMonth();
  loadCalendar();
});
document.getElementById("calShowGames").addEventListener("change", () =>
  calView === "month" ? renderMonthView() : renderListView());
document.getElementById("calShowPractices").addEventListener("change", () =>
  calView === "month" ? renderMonthView() : renderListView());

// Filter bar
function reRender() { calView === "month" ? renderMonthView() : renderListView(); }
document.getElementById("calFilterDiv").addEventListener("change", e => { calFilterDivision = e.target.value; reRender(); });
document.getElementById("calFilterCity").addEventListener("change", e => { calFilterCity = e.target.value; reRender(); });
document.getElementById("calFilterField").addEventListener("change", e => { calFilterField = e.target.value; reRender(); });
document.getElementById("calClearFiltersBtn").addEventListener("click", () => {
  calFilterDivision = calFilterCity = calFilterField = "";
  document.getElementById("calFilterDiv").value   = "";
  document.getElementById("calFilterCity").value  = "";
  document.getElementById("calFilterField").value = "";
  reRender();
});

// View toggle (month / list)
document.querySelectorAll(".cal-view-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    calView = btn.dataset.view;
    document.querySelectorAll(".cal-view-btn").forEach(b => {
      const isActive = b.dataset.view === calView;
      b.style.background   = isActive ? "var(--accent)" : "transparent";
      b.style.color        = isActive ? "white" : "var(--light-text)";
    });
    document.getElementById("calMonthView").style.display = calView === "month" ? "" : "none";
    document.getElementById("calListView").style.display  = calView === "list"  ? "" : "none";
    if (calView === "month") renderMonthView();
    else                     renderListView();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  GAME EDIT MODAL (calendar / list view)
// ══════════════════════════════════════════════════════════════════════════════

function openGameEditModal(game) {
  const modal = document.getElementById("schedGameEditModal");
  if (!modal) return;

  seCurrentGame = game; // keep reference for slot management

  document.getElementById("seGameId").value         = game.id;
  document.getElementById("seDate").value           = game.date        || "";
  document.getElementById("seTime").value           = game.time        || "";
  document.getElementById("seDivision").value       = game.division    || "10U";
  document.getElementById("seCity").value           = game.city        || "City of Crooks";
  document.getElementById("seField").value          = game.field       || "";
  document.getElementById("seGameType").value       = game.gameType    || "Regular";
  document.getElementById("seHomeTeam").value       = game.homeTeam    || "";
  document.getElementById("seAwayTeam").value       = game.awayTeam    || "";
  document.getElementById("seIsAway").checked       = !!game.isAway;
  document.getElementById("seNeedsUmpires").checked = !!game.needsUmpires;
  document.getElementById("seNotes").value          = game.notes       || "";
  document.getElementById("seGameMsg").textContent  = "";
  document.getElementById("seGameMsg").className    = "signup-message";

  renderSeSlots();
  modal.style.display = "flex";
}

function closeGameEditModal() {
  const modal = document.getElementById("schedGameEditModal");
  if (modal) modal.style.display = "none";
}

document.getElementById("seGameCancelBtn").addEventListener("click", closeGameEditModal);
document.getElementById("schedGameEditModal").addEventListener("click", e => {
  if (e.target === document.getElementById("schedGameEditModal")) closeGameEditModal();
});

document.getElementById("seGameSaveBtn").addEventListener("click", async () => {
  const btn = document.getElementById("seGameSaveBtn");
  const msg = document.getElementById("seGameMsg");
  const id  = document.getElementById("seGameId").value;
  if (!id) return;

  btn.disabled    = true;
  msg.textContent = "Saving…";
  msg.className   = "signup-message info";

  try {
    const updates = {
      date:         document.getElementById("seDate").value,
      time:         document.getElementById("seTime").value,
      division:     document.getElementById("seDivision").value,
      city:         document.getElementById("seCity").value,
      field:        document.getElementById("seField").value.trim(),
      gameType:     document.getElementById("seGameType").value,
      homeTeam:     document.getElementById("seHomeTeam").value.trim(),
      awayTeam:     document.getElementById("seAwayTeam").value.trim(),
      isAway:       document.getElementById("seIsAway").checked,
      needsUmpires: document.getElementById("seNeedsUmpires").checked,
      notes:        document.getElementById("seNotes").value.trim(),
    };
    await updateDoc(doc(db, "games", id), updates);
    // Keep seCurrentGame in sync so slot list reflects latest field values
    if (seCurrentGame) Object.assign(seCurrentGame, updates);
    msg.textContent = "✓ Saved.";
    msg.className   = "signup-message success";
    // Refresh calendar in background then close
    setTimeout(async () => {
      closeGameEditModal();
      await fetchCalendarData();
      if (calView === "month") renderMonthView();
      else                     renderListView();
    }, 600);
  } catch (err) {
    msg.textContent = "Error: " + err.message;
    msg.className   = "signup-message error";
    btn.disabled    = false;
  }
});

document.getElementById("seGameDeleteBtn").addEventListener("click", async () => {
  const id = document.getElementById("seGameId").value;
  if (!id) return;
  if (!confirm("Delete this game? This cannot be undone.")) return;

  const msg = document.getElementById("seGameMsg");
  msg.textContent = "Deleting…";
  msg.className   = "signup-message info";

  try {
    await deleteDoc(doc(db, "games", id));
    closeGameEditModal();
    await fetchCalendarData();
    if (calView === "month") renderMonthView();
    else                     renderListView();
  } catch (err) {
    msg.textContent = "Error: " + err.message;
    msg.className   = "signup-message error";
  }
});

document.getElementById("seConvertToPracticeBtn").addEventListener("click", async () => {
  const game = seCurrentGame;
  if (!game) return;
  const info = [fmtDate(game.date), game.time ? fmt12(game.time) : "", game.city, game.division]
    .filter(Boolean).join(" · ");
  if (!confirm(`Convert "${info}" to a practice?\n\nIt will be removed from the game list and shown on the calendar as a practice.`)) return;

  const btn = document.getElementById("seConvertToPracticeBtn");
  const msg = document.getElementById("seGameMsg");
  btn.disabled = true;
  msg.textContent = "Converting…";
  msg.className = "signup-message info";

  try {
    // Add to practices collection
    await addDoc(collection(db, "practices"), {
      teamName:   game.homeTeam || game.awayTeam || game.teamName || game.division || "",
      division:   game.division || "",
      date:       game.date,
      startTime:  game.time || "",
      endTime:    "",
      field:      game.field || "",
      source:     "calendar",
      ...(game.externalId ? { externalId: game.externalId } : {}),
      createdAt:  serverTimestamp(),
    });
    // Remove from games collection
    await deleteDoc(doc(db, "games", game.id));
    closeGameEditModal();
    // Reload full calendar data to pick up the new practice entry
    await loadCalendar();
  } catch (err) {
    msg.textContent = "Error: " + err.message;
    msg.className = "signup-message error";
    btn.disabled = false;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  PRACTICE EDIT MODAL
// ══════════════════════════════════════════════════════════════════════════════

function openPracticeEditModal(p) {
  peCurrentPractice = p;
  document.getElementById("peId").value        = p.id;
  document.getElementById("peDate").value      = p.date || "";
  document.getElementById("peDivision").value  = p.division || "";
  document.getElementById("peStartTime").value = p.startTime || "";
  document.getElementById("peEndTime").value   = p.endTime || "";
  document.getElementById("peTeamName").value  = p.teamName || "";
  document.getElementById("peField").value     = p.field || "";
  const msg = document.getElementById("pePracticeMsg");
  msg.textContent = ""; msg.className = "signup-message";
  document.getElementById("peConvertToGameBtn").disabled = false;
  document.getElementById("practiceEditModal").style.display = "flex";
}

function closePracticeEditModal() {
  document.getElementById("practiceEditModal").style.display = "none";
  peCurrentPractice = null;
}

document.getElementById("peCancelBtn").addEventListener("click", closePracticeEditModal);

document.getElementById("peSaveBtn").addEventListener("click", async () => {
  const p = peCurrentPractice;
  if (!p) return;
  const msg = document.getElementById("pePracticeMsg");
  msg.textContent = "Saving…"; msg.className = "signup-message info";

  const updates = {
    date:      document.getElementById("peDate").value,
    division:  document.getElementById("peDivision").value,
    startTime: document.getElementById("peStartTime").value,
    endTime:   document.getElementById("peEndTime").value,
    teamName:  document.getElementById("peTeamName").value.trim(),
    field:     document.getElementById("peField").value.trim(),
  };

  try {
    await updateDoc(doc(db, "practices", p.id), updates);
    closePracticeEditModal();
    await loadCalendar();
    if (document.getElementById("sec-practices")?.style.display !== "none") loadPractices();
  } catch (err) {
    msg.textContent = "Error: " + err.message;
    msg.className = "signup-message error";
  }
});

document.getElementById("peConvertToGameBtn").addEventListener("click", async () => {
  const p = peCurrentPractice;
  if (!p) return;
  const info = [fmtDate(p.date), p.startTime ? fmt12(p.startTime) : "", p.teamName, p.division]
    .filter(Boolean).join(" · ");
  if (!confirm(`Convert "${info}" to a game?\n\nIt will be removed from practices and added to the game list.`)) return;

  const btn = document.getElementById("peConvertToGameBtn");
  const msg = document.getElementById("pePracticeMsg");
  btn.disabled = true;
  msg.textContent = "Converting…"; msg.className = "signup-message info";

  try {
    await addDoc(collection(db, "games"), {
      date:         p.date,
      time:         p.startTime || "",
      division:     p.division || "",
      field:        p.field || "",
      homeTeam:     p.teamName || "",
      awayTeam:     "",
      gameType:     "Regular",
      city:         "",
      needsUmpires: false,
      cancelled:    false,
      umpireSlots:  [],
      source:       "calendar",
      ...(p.externalId ? { externalId: p.externalId } : {}),
      createdAt:    serverTimestamp(),
    });
    await deleteDoc(doc(db, "practices", p.id));
    closePracticeEditModal();
    await loadCalendar();
    if (document.getElementById("sec-practices")?.style.display !== "none") loadPractices();
  } catch (err) {
    msg.textContent = "Error: " + err.message;
    msg.className = "signup-message error";
    btn.disabled = false;
  }
});

document.getElementById("peDeleteBtn").addEventListener("click", async () => {
  const p = peCurrentPractice;
  if (!p) return;
  const info = [fmtDate(p.date), p.teamName].filter(Boolean).join(" · ");
  if (!confirm(`Delete practice "${info}"?\n\nThis cannot be undone.`)) return;

  const msg = document.getElementById("pePracticeMsg");
  msg.textContent = "Deleting…"; msg.className = "signup-message info";

  try {
    await deleteDoc(doc(db, "practices", p.id));
    closePracticeEditModal();
    await loadCalendar();
    if (document.getElementById("sec-practices")?.style.display !== "none") loadPractices();
  } catch (err) {
    msg.textContent = "Error: " + err.message;
    msg.className = "signup-message error";
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  PRACTICES SECTION
// ══════════════════════════════════════════════════════════════════════════════

async function loadPractices() {
  const today = todayISO();
  try {
    const [pendingSnap, approvedSnap] = await Promise.all([
      getDocs(query(collection(db, "practiceRequests"),
        where("status", "==", "pending"),
        orderBy("date"), orderBy("startTime"))),
      getDocs(query(collection(db, "practices"),
        where("date", ">=", today),
        orderBy("date"), orderBy("startTime"))),
    ]);
    renderPendingList(pendingSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    renderApprovedList(approvedSnap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    document.getElementById("pendingPracticesList").innerHTML =
      `<p style="color:#ff8a8a">Error: ${esc(err.message)}</p>`;
  }
}

function recurrenceLabel(req) {
  if (!req.recurrence || req.recurrence.type === "once") return "One-time";
  const days = (req.recurrence.daysOfWeek || []).map(d =>
    ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d] || "?"
  ).join(", ");
  return `Weekly (${days}) · ${fmtDate(req.recurrence.startDate)} – ${fmtDate(req.recurrence.endDate)}`;
}

function renderPendingList(requests) {
  const el = document.getElementById("pendingPracticesList");
  if (!requests.length) {
    el.innerHTML = `<p style="color:var(--light-text)">No pending requests.</p>`;
    return;
  }
  el.innerHTML = requests.map(req => `
    <div class="practice-req-card pending" data-id="${esc(req.id)}">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <div>
          <strong>${esc(req.teamName || "Unknown Team")}</strong>
          <span style="color:var(--light-text);margin-left:8px;font-size:0.85rem">${esc(req.coachName || "")}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button type="button" class="btn practice-approve-btn" data-id="${esc(req.id)}" style="padding:4px 12px;font-size:0.85rem">✓ Approve</button>
          <button type="button" class="btn print-btn practice-deny-btn" data-id="${esc(req.id)}" style="padding:4px 12px;font-size:0.85rem;color:#ff8a8a;border-color:#ff8a8a">✗ Deny</button>
        </div>
      </div>
      <div style="font-size:0.88rem;color:var(--light-text)">
        <span>📅 ${esc(fmtDate(req.date))}</span>
        <span style="margin-left:12px">⏰ ${esc(req.startTime ? fmt12(req.startTime) : "—")} – ${esc(req.endTime ? fmt12(req.endTime) : "—")}</span>
        <span style="margin-left:12px">🏟 ${esc(req.field || "—")}</span>
      </div>
      <div style="font-size:0.85rem;margin-top:4px;color:var(--light-text)">
        🔄 ${esc(recurrenceLabel(req))}
      </div>
      ${req.notes ? `<div style="margin-top:6px;font-size:0.85rem;color:#ccc;white-space:pre-wrap">${esc(req.notes)}</div>` : ""}
      <div id="conflictCheck_${esc(req.id)}" style="margin-top:8px"></div>
      <p class="signup-message" id="practiceMsg_${esc(req.id)}" aria-live="polite"></p>
    </div>`).join("");

  el.querySelectorAll(".practice-approve-btn").forEach(btn => {
    btn.addEventListener("click", () => approvePracticeRequest(btn.dataset.id));
  });
  el.querySelectorAll(".practice-deny-btn").forEach(btn => {
    btn.addEventListener("click", () => denyPracticeRequest(btn.dataset.id));
  });

  // Check conflicts for each pending request
  requests.forEach(req => checkPracticeConflict(req));
}

function renderApprovedList(practices) {
  const el = document.getElementById("approvedPracticesList");
  if (!practices.length) {
    el.innerHTML = `<p style="color:var(--light-text)">No upcoming approved practices.</p>`;
    return;
  }
  el.innerHTML = `
    <div class="schedule-section" style="margin-top:0">
      <table>
        <thead><tr>
          <th>Date</th><th>Time</th><th>Team</th><th>Field</th><th>Coach</th><th>Recurrence</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${practices.map(p => `
          <tr>
            <td>${esc(fmtDate(p.date))}</td>
            <td>${esc(p.startTime ? fmt12(p.startTime) : "—")} – ${esc(p.endTime ? fmt12(p.endTime) : "—")}</td>
            <td>${esc(p.teamName || "—")}</td>
            <td>${esc(p.field || "—")}</td>
            <td>${esc(p.coachName || "—")}</td>
            <td style="font-size:0.82rem">${esc(recurrenceLabel(p))}</td>
            <td style="white-space:nowrap">
              <button type="button" class="btn print-btn practice-edit-btn" data-id="${esc(p.id)}"
                style="padding:3px 8px;font-size:0.8rem;margin-right:4px">Edit</button>
              <button type="button" class="btn print-btn practice-cancel-btn" data-id="${esc(p.id)}"
                style="padding:3px 8px;font-size:0.8rem;color:#ff8a8a;border-color:#ff8a8a">Cancel</button>
            </td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;

  el.querySelectorAll(".practice-edit-btn").forEach(btn => {
    const p = practices.find(x => x.id === btn.dataset.id);
    btn.addEventListener("click", () => { if (p) openPracticeEditModal(p); });
  });
  el.querySelectorAll(".practice-cancel-btn").forEach(btn => {
    btn.addEventListener("click", () => cancelPractice(btn.dataset.id));
  });
}

async function checkPracticeConflict(req) {
  const el = document.getElementById(`conflictCheck_${req.id}`);
  if (!el) return;
  try {
    const snap = await getDocs(query(collection(db, "games"),
      where("date", "==", req.date),
      where("cancelled", "==", false)));
    const conflicting = snap.docs.filter(d => {
      const g = d.data();
      if ((g.field || "").toLowerCase() !== (req.field || "").toLowerCase()) return false;
      // Time overlap check
      const gs = timeToMins(g.time);
      const ge = gs !== null ? gs + 90 : null;
      const ps = timeToMins(req.startTime);
      const pe = timeToMins(req.endTime);
      if (gs === null || ps === null || pe === null) return false;
      return ps < (ge || gs + 90) && gs < pe;
    });
    if (conflicting.length) {
      el.innerHTML = `<div style="color:#ff8a8a;font-size:0.82rem">⚠ Field conflict: ${conflicting.length} game${conflicting.length !== 1 ? "s" : ""} on this field at this time.</div>`;
    } else {
      el.innerHTML = `<div style="color:#6fcf97;font-size:0.82rem">✓ No field conflicts detected.</div>`;
    }
  } catch { /* silent */ }
}

async function approvePracticeRequest(id) {
  const msg = document.getElementById(`practiceMsg_${id}`);
  if (msg) { msg.textContent = "Approving…"; msg.className = "signup-message info"; }
  try {
    const reqDoc = await getDoc(doc(db, "practiceRequests", id));
    if (!reqDoc.exists()) throw new Error("Request not found.");
    const req  = reqDoc.data();
    const dates = expandRecurrence(req);

    // Write approved practices (one per date)
    for (const date of dates) {
      await addDoc(collection(db, "practices"), {
        requestId:   id,
        teamName:    req.teamName    || "",
        coachName:   req.coachName   || "",
        coachEmail:  req.coachEmail  || "",
        coachPhone:  req.coachPhone  || "",
        field:       req.field       || "",
        date,
        startTime:   req.startTime   || "",
        endTime:     req.endTime     || "",
        notes:       req.notes       || "",
        recurrence:  req.recurrence  || { type: "once" },
        approvedAt:  new Date().toISOString(),
      });
    }
    await updateDoc(doc(db, "practiceRequests", id), { status: "approved" });
    await loadPractices();
  } catch (err) {
    if (msg) { msg.textContent = "Error: " + err.message; msg.className = "signup-message error"; }
  }
}

async function denyPracticeRequest(id) {
  if (!confirm("Deny this practice request?")) return;
  const msg = document.getElementById(`practiceMsg_${id}`);
  if (msg) { msg.textContent = "Denying…"; msg.className = "signup-message info"; }
  try {
    await updateDoc(doc(db, "practiceRequests", id), { status: "denied" });
    await loadPractices();
  } catch (err) {
    if (msg) { msg.textContent = "Error: " + err.message; msg.className = "signup-message error"; }
  }
}

async function cancelPractice(id) {
  if (!confirm("Cancel this approved practice?")) return;
  try {
    await deleteDoc(doc(db, "practices", id));
    await loadPractices();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

/** Expand a practice request into individual date strings */
function expandRecurrence(req) {
  const rec = req.recurrence || { type: "once" };
  if (rec.type !== "weekly" || !rec.startDate || !rec.endDate || !rec.daysOfWeek?.length) {
    return [req.date];
  }
  const dates = [];
  const cur   = new Date(rec.startDate + "T12:00:00");
  const end   = new Date(rec.endDate   + "T12:00:00");
  const dows  = new Set(rec.daysOfWeek.map(Number));
  while (cur <= end) {
    if (dows.has(cur.getDay())) dates.push(isoFromDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

document.getElementById("refreshPracticesBtn").addEventListener("click", loadPractices);

// ── Add Practice Directly ────────────────────────────────────────────────────
document.getElementById("addPracticeForm").addEventListener("submit", async e => {
  e.preventDefault();
  const msgEl = document.getElementById("addPracticeMsg");
  const btn   = e.target.querySelector("button[type=submit]");
  const teamName  = document.getElementById("apTeamName").value.trim();
  const date      = document.getElementById("apDate").value;
  const startTime = document.getElementById("apStartTime").value;
  const endTime   = document.getElementById("apEndTime").value;
  const field     = document.getElementById("apField").value.trim();
  const notes     = document.getElementById("apNotes").value.trim();

  if (!teamName || !date) {
    msgEl.textContent = "Team name and date are required.";
    msgEl.className   = "signup-message error";
    return;
  }

  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Saving…";
  msgEl.textContent = "";
  msgEl.className   = "signup-message";

  try {
    await addDoc(collection(db, "practices"), {
      teamName,
      date,
      startTime: startTime || "",
      endTime:   endTime   || "",
      field:     field     || "",
      notes:     notes     || "",
      source:    "admin",
      createdAt: serverTimestamp(),
    });
    msgEl.textContent = `✓ Practice added for ${teamName} on ${date}.`;
    msgEl.className   = "signup-message success";
    e.target.reset();
    // Reload the approved list so new entry appears immediately
    await loadPractices();
  } catch (err) {
    msgEl.textContent = `Error: ${err.message}`;
    msgEl.className   = "signup-message error";
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
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

  // Load teams first (needed by all sections)
  await loadTeams();
  // Teams section is default active — already rendered by loadTeams()
});
