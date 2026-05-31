// admin-add-game.js — standalone Add Game page
import { db } from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import { esc, fmtDate, setMsg } from "./utils.js";

import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  query,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── State ─────────────────────────────────────────────────────────────────────

let currentRates = { plate: 0, field: 0, extra: 0 };
let facilitiesData = [];
let teamsData = [];

// ── Facilities + field cascade ────────────────────────────────────────────────

async function loadFacilities() {
  try {
    const snap = await getDocs(collection(db, "facilities"));
    facilitiesData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const sel = document.getElementById("gameFacility");
    if (sel) {
      sel.innerHTML = `<option value="">-- None / Other --</option>` +
        facilitiesData.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("");
      sel.addEventListener("change", cascadeFields);
    }
  } catch (_) {}
}

function cascadeFields() {
  const facSel     = document.getElementById("gameFacility");
  const fieldSel   = document.getElementById("gameFieldSelect");
  const fieldInput = document.getElementById("gameField");
  if (!facSel || !fieldSel || !fieldInput) return;

  const facId  = facSel.value;
  const facObj = facilitiesData.find(f => f.id === facId);
  const fields = facObj?.fields || [];

  if (fields.length > 0) {
    fieldSel.innerHTML = `<option value="">-- Select field --</option>` +
      fields.map(f => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join("");
    fieldSel.style.display = "";
    fieldInput.style.display = "none";
  } else {
    fieldSel.style.display = "none";
    fieldInput.style.display = "";
  }
}

// ── Teams + cascade ───────────────────────────────────────────────────────────

async function loadTeams() {
  try {
    const snap = await getDoc(doc(db, "config/teamCalendars"));
    teamsData = snap.exists() ? (snap.data().teams || []) : [];
  } catch (_) {}
}

function cascadeTeams() {
  const division = document.getElementById("gameDivision")?.value || "";
  const filtered = division
    ? teamsData.filter(t => t.division === division).sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    : teamsData.slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const teamOpts = filtered.map(t => `<option value="${esc(t.name)}">${esc(t.name)}${t.city ? ` (${esc(t.city)})` : ""}</option>`).join("");
  const base = `<option value="">-- None --</option><option value="TBD">TBD</option>${teamOpts}<option value="__custom__">Enter custom name…</option>`;

  ["gameHomeTeamSelect", "gameAwayTeamSelect"].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = base;
    // Restore previous selection if it still exists
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  });
}

function getTeamValue(selectId, customId) {
  const sel = document.getElementById(selectId);
  if (sel?.value === "__custom__") return document.getElementById(customId)?.value.trim() || "";
  return sel?.value || "";
}

function setTeamField(selectId, customId, teamName) {
  const sel = document.getElementById(selectId);
  const inp = document.getElementById(customId);
  if (!sel || !inp) return;
  if (!teamName) { sel.value = ""; inp.style.display = "none"; return; }
  if ([...sel.options].some(o => o.value === teamName)) {
    sel.value = teamName;
    inp.style.display = "none";
  } else {
    sel.value = "__custom__";
    inp.value = teamName;
    inp.style.display = "";
  }
}

// Team/city/division change listeners are wired inside authReadyPromise.then()
// because the adminContent section starts hidden and elements don't exist until shown.

// ── City dropdown ─────────────────────────────────────────────────────────────

function populateCities() {
  const cities = [...new Set(teamsData.map(t => t.city).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const sel = document.getElementById("gameCitySelect");
  if (!sel) return;
  sel.innerHTML =
    `<option value="">-- Select city --</option>` +
    cities.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("") +
    `<option value="__custom__">Enter custom city…</option>`;
}

function getCityValue() {
  const sel = document.getElementById("gameCitySelect");
  if (sel?.value === "__custom__") return document.getElementById("gameCityCustom")?.value.trim() || "";
  return sel?.value || "";
}

function setCityField(cityName) {
  const sel = document.getElementById("gameCitySelect");
  const inp = document.getElementById("gameCityCustom");
  if (!sel || !inp) return;
  if (!cityName) { sel.value = ""; inp.style.display = "none"; return; }
  if ([...sel.options].some(o => o.value === cityName)) {
    sel.value = cityName;
    inp.style.display = "none";
  } else {
    sel.value = "__custom__";
    inp.value = cityName;
    inp.style.display = "";
  }
}

document.getElementById("gameCitySelect")?.addEventListener("change", function () {
  const inp = document.getElementById("gameCityCustom");
  if (!inp) return;
  if (this.value === "__custom__") { inp.style.display = ""; inp.focus(); }
  else                             { inp.style.display = "none"; inp.value = ""; }
});

// ── Leagues ───────────────────────────────────────────────────────────────────

async function loadLeagues() {
  try {
    const snap = await getDocs(query(collection(db, "leagues"), orderBy("name")));
    const opts = snap.docs
      .map(d => `<option value="${esc(d.data().name || d.id)}">${esc(d.data().name || d.id)}</option>`)
      .join("");
    const sel = document.getElementById("gameLeague");
    if (sel) sel.innerHTML = `<option value="">— None —</option>${opts}`;
  } catch (_) {}
}

// ── Pay rates ─────────────────────────────────────────────────────────────────

async function loadPayRates() {
  try {
    const snap = await getDoc(doc(db, "config", "payRates"));
    if (snap.exists()) {
      const r = snap.data();
      currentRates = { plate: r.plate || 0, field: r.field || 0, extra: r.extra || 0 };
      prefillSlotPays();
    }
  } catch (_) {}
}

function prefillSlotPays() {
  document.querySelectorAll(".slot-pay-input").forEach(input => {
    const type = input.dataset.slotType?.toLowerCase();
    if (!input.value && type) input.value = currentRates[type] || "";
  });
}

// ── Checkbox → enable pay input + prefill ─────────────────────────────────────

document.getElementById("gameUmpireTypes").addEventListener("change", e => {
  if (e.target.type !== "checkbox") return;
  const type     = e.target.value;
  const payInput = document.querySelector(`.slot-pay-input[data-slot-type="${type}"]`);
  if (!payInput) return;
  payInput.disabled = !e.target.checked;
  if (e.target.checked && !payInput.value) {
    payInput.value = currentRates[type.toLowerCase()] || "";
  }
});

// ── Makeup pre-fill from URL param ────────────────────────────────────────────

async function applyMakeupPrefill(gameId) {
  try {
    const snap = await getDoc(doc(db, "games", gameId));
    if (!snap.exists()) return;
    const g = snap.data();

    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el && val != null) el.value = val;
    };
    set("gameLeague",   g.league   || "");
    set("gameDivision", g.division || "");
    setCityField(g.city || "");
    set("gameTime",     g.time     || "");
    set("gameType",     g.type     || "");
    set("gameDate",     ""); // admin must pick new date

    // Cascade teams for the pre-filled division, then restore team values
    cascadeTeams();
    setTeamField("gameHomeTeamSelect", "gameHomeTeamCustom", g.homeTeam || "");
    setTeamField("gameAwayTeamSelect", "gameAwayTeamCustom", g.awayTeam || "");

    const fieldInp = document.getElementById("gameField");
    const fieldSel = document.getElementById("gameFieldSelect");
    if (fieldInp) { fieldInp.value = g.field || ""; fieldInp.style.display = ""; }
    if (fieldSel) fieldSel.style.display = "none";

    document.querySelectorAll("#gameUmpireTypes input[type=checkbox]").forEach(cb => { cb.checked = false; });
    document.querySelectorAll(".slot-pay-input").forEach(inp => { inp.disabled = true; inp.value = ""; });
    (g.umpireSlots || []).forEach(slot => {
      const cb = document.querySelector(`#gameUmpireTypes input[value="${slot.type}"]`);
      if (cb) {
        cb.checked = true;
        const payInp = document.querySelector(`.slot-pay-input[data-slot-type="${slot.type}"]`);
        if (payInp) { payInp.value = slot.payRate != null ? slot.payRate : ""; payInp.disabled = false; }
      }
    });

    const banner = document.getElementById("makeupBanner");
    if (banner) {
      banner.style.display = "";
      banner.style.borderLeftColor = "#7ec8f7";
      banner.innerHTML = `<p style="margin:0;font-size:0.9rem">ℹ️ <strong>Makeup game</strong> — pre-filled from the ${fmtDate(g.date)} rescheduled game. Set a new date and submit.</p>`;
    }
    document.getElementById("pageTitle").textContent = "Add Makeup Game";
  } catch (err) {
    console.error("applyMakeupPrefill:", err);
  }
}

// ── Form submit ───────────────────────────────────────────────────────────────

document.getElementById("addGameForm").addEventListener("submit", async function (e) {
  e.preventDefault();
  const btn = document.getElementById("addGameBtn");

  const checkedTypes = [...document.querySelectorAll("#gameUmpireTypes input:checked")].map(cb => cb.value);
  if (checkedTypes.length === 0) {
    document.getElementById("umpireTypesError").textContent = "Select at least one umpire position.";
    return;
  }
  document.getElementById("umpireTypesError").textContent = "";

  const league   = document.getElementById("gameLeague").value.trim();
  const city     = getCityValue();
  const division = document.getElementById("gameDivision").value;
  const date     = document.getElementById("gameDate").value;

  if (!date)              { setMsg("addGameMessage", "Date is required.", "error");              return; }
  if (!division)          { setMsg("addGameMessage", "Division is required.", "error");          return; }
  if (!league && !city)   { setMsg("addGameMessage", "League or city is required.", "error");    return; }

  btn.disabled = true;
  setMsg("addGameMessage", "Adding game…", "info");

  const time       = document.getElementById("gameTime").value;
  const type       = document.getElementById("gameType").value;
  const facilityId = document.getElementById("gameFacility")?.value || "";
  const fieldSel   = document.getElementById("gameFieldSelect");
  const fieldInp   = document.getElementById("gameField");
  const field      = (fieldSel?.style.display !== "none" && fieldSel?.value)
    ? fieldSel.value : (fieldInp?.value.trim() || "");
  const homeTeam   = getTeamValue("gameHomeTeamSelect", "gameHomeTeamCustom");
  const awayTeam   = getTeamValue("gameAwayTeamSelect", "gameAwayTeamCustom");
  const notes      = document.getElementById("gameNotes")?.value.trim() || "";

  const umpireSlots = checkedTypes.map(t => {
    const payInput = document.querySelector(`.slot-pay-input[data-slot-type="${t}"]`);
    return { type: t, assignedUid: null, assignedName: null, payRate: payInput ? (parseFloat(payInput.value) || 0) : 0, checkedIn: false, checkedInAt: null, paid: false, noShow: false };
  });

  try {
    const gameData = {
      league, city, division, date, time, type, field, facilityId,
      umpireSlots, needsUmpires: true, cancelled: false,
      createdAt: serverTimestamp(),
    };
    if (homeTeam) gameData.homeTeam = homeTeam;
    if (awayTeam) gameData.awayTeam = awayTeam;
    if (notes)    gameData.notes    = notes;

    await addDoc(collection(db, "games"), gameData);
    setMsg("addGameMessage", "Game added! Redirecting…", "success");
    setTimeout(() => { window.location.href = "admin-games.html"; }, 1000);
  } catch (err) {
    setMsg("addGameMessage", err.message, "error");
    btn.disabled = false;
  }
});

// ── Auth gate + init ──────────────────────────────────────────────────────────

authReadyPromise.then(async () => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display     = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display     = "none";

  await Promise.all([loadFacilities(), loadLeagues(), loadPayRates(), loadTeams()]);
  populateCities();
  cascadeTeams();

  // Wire team/city/division listeners here — elements are now in the visible DOM
  [["gameHomeTeamSelect", "gameHomeTeamCustom"], ["gameAwayTeamSelect", "gameAwayTeamCustom"]].forEach(([selId, inpId]) => {
    document.getElementById(selId)?.addEventListener("change", function () {
      const inp = document.getElementById(inpId);
      if (!inp) return;
      if (this.value === "__custom__") {
        inp.style.display = "";
        inp.focus();
      } else {
        inp.style.display = "none";
        inp.value = "";
      }
    });
  });
  document.getElementById("gameDivision")?.addEventListener("change", cascadeTeams);

  // Pre-fill from makeup param if present
  const makeup = new URLSearchParams(window.location.search).get("makeup");
  if (makeup) await applyMakeupPrefill(makeup);
});
