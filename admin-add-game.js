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
      fields.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join("");
    fieldSel.style.display = "";
    fieldInput.style.display = "none";
  } else {
    fieldSel.style.display = "none";
    fieldInput.style.display = "";
  }
}

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
    set("gameCity",     g.city     || "");
    set("gameDivision", g.division || "");
    set("gameTime",     g.time     || "");
    set("gameType",     g.type     || "");
    set("gameHomeTeam", g.homeTeam || "");
    set("gameAwayTeam", g.awayTeam || "");
    set("gameDate",     ""); // admin must pick new date

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
  const city     = document.getElementById("gameCity").value.trim();
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
  const homeTeam   = document.getElementById("gameHomeTeam")?.value.trim() || "";
  const awayTeam   = document.getElementById("gameAwayTeam")?.value.trim() || "";
  const notes      = document.getElementById("gameNotes")?.value.trim() || "";

  const umpireSlots = checkedTypes.map(t => {
    const payInput = document.querySelector(`.slot-pay-input[data-slot-type="${t}"]`);
    return { type: t, assignedUid: null, assignedName: null, payRate: payInput ? (parseFloat(payInput.value) || 0) : 0 };
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

  await Promise.all([loadFacilities(), loadLeagues(), loadPayRates()]);

  // Pre-fill from makeup param if present
  const makeup = new URLSearchParams(window.location.search).get("makeup");
  if (makeup) await applyMakeupPrefill(makeup);
});
