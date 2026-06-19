// schedule.js — Firestore-based schedule with multi-slot signups, badges, and pay tracking
import { getOrgSettings } from "./org.js";
import { db, auth } from "./firebase.js";
import { gamesToIcs, downloadIcs } from "./cal.js";
import { esc, fmtDate, fmtTime, todayISO, weekEndISO, showToast, showConfirm } from "./utils.js";
import { getFacilities, getShedCodes, matchFacility, showShedCodeDialog } from "./facilities.js";

import {
  authReadyPromise,
  isLoggedIn,
  isApproved,
  isAdmin,
  hasRole,
  isCoach,
  getCurrentUser,
  getCurrentProfile
} from "./auth.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  collection,
  getDocs,
  getDoc,
  addDoc,
  runTransaction,
  updateDoc,
  writeBatch,
  doc,
  query,
  orderBy,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

document.getElementById("scheduleYear").textContent = new Date().getFullYear();

let games = [];
let viewMode      = "regular";  // regular | tournament
let statusFilter  = "all";      // all | needs | filled | mine
let dateFilter    = "upcoming"; // today | week | month | upcoming | past | all | custom
let dateFrom      = "";      // YYYY-MM-DD  (custom range start)
let dateTo        = "";      // YYYY-MM-DD  (custom range end)
let cityFilter    = "";      // "" = all cities
let umpireFilter  = "";      // "" = all umpires (admin only)

// Tournaments map: id → { name, date, fields, division }
let tournamentsMap = {};
let pendingGameId   = null;
let pendingSlotType = null;
let pendingScoreGameId = null;   // game currently being scored

let _gameDayBarCache = null; // { date: "YYYY-MM-DD", data: { todayGames, facilities, shedCodes, weatherMap } }
let _renderToday     = "";   // cached todayISO() for the current render pass

// Pending cancellation requests for the current user: "gameId|slotType" → requestDocId
let pendingCancels = {};

let teamCalendars   = []; // [{name, icsUrl}]

// ── Weather ───────────────────────────────────────────────────────────────────

const CITY_COORDS = {
  "City of Crooks": { lat: 43.6503, lon: -96.8108 },
  "City of Colton": { lat: 43.7877, lon: -97.0002 }
};

// Org settings — loaded async; used for weather fallback and late-cancel window
let _orgSettings        = null;
let _lateCancelHours    = 4;   // default: 4 hrs; overwritten once scheduling config loads
let _schedConfigLoaded  = false;
getOrgSettings().then(s => { _orgSettings = s; });

const weatherCache = {}; // "city|date" → { temp, condition, wind } | null

const WMO_LABELS = {
  0: "Clear", 1: "Mainly Clear", 2: "Partly Cloudy", 3: "Overcast",
  45: "Fog", 48: "Freezing Fog",
  51: "Light Drizzle", 53: "Drizzle", 55: "Heavy Drizzle",
  61: "Light Rain", 63: "Rain", 65: "Heavy Rain",
  71: "Light Snow", 73: "Snow", 75: "Heavy Snow", 77: "Snow Grains",
  80: "Showers", 81: "Showers", 82: "Heavy Showers",
  85: "Snow Showers", 86: "Heavy Snow Showers",
  95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm"
};

const WMO_ICONS = {
  0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️",
  45: "🌫️", 48: "🌫️",
  51: "🌦️", 53: "🌦️", 55: "🌦️",
  61: "🌧️", 63: "🌧️", 65: "🌧️",
  71: "❄️", 73: "❄️", 75: "❄️", 77: "❄️",
  80: "🌦️", 81: "🌦️", 82: "🌦️",
  85: "❄️", 86: "❄️",
  95: "⛈️", 96: "⛈️", 99: "⛈️"
};

async function fetchWeather(city, date, timeStr) {
  const key = `${city}|${date}`;
  if (key in weatherCache) return weatherCache[key];

  // Use built-in city lookup, then fall back to org-configured home coords
  const coords = CITY_COORDS[city]
    ?? (_orgSettings ? { lat: _orgSettings.weatherLat, lon: _orgSettings.weatherLon } : null);
  if (!coords || coords.lat == null) return (weatherCache[key] = null);

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}` +
      `&hourly=temperature_2m,weathercode,windspeed_10m` +
      `&temperature_unit=fahrenheit&windspeed_unit=mph` +
      `&timezone=America%2FChicago&start_date=${date}&end_date=${date}`;
    const res  = await fetch(url);
    const data = await res.json();

    const times = data.hourly?.time ?? [];
    const temps = data.hourly?.temperature_2m ?? [];
    const codes = data.hourly?.weathercode ?? [];
    const winds = data.hourly?.windspeed_10m ?? [];

    // Find the index closest to game time
    const [h, m] = (timeStr || "12:00").split(":").map(Number);
    const gameMinutes = h * 60 + (m || 0);
    let best = 0, bestDiff = Infinity;
    times.forEach((t, i) => {
      const tHour = Number(t.slice(11, 13)); // parse Chicago-local hour directly from "YYYY-MM-DDTHH:mm" string
      const diff  = Math.abs(tHour * 60 - gameMinutes);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    });

    const result = {
      temp:      Math.round(temps[best] ?? 0),
      code:      codes[best] ?? 0,
      wind:      Math.round(winds[best] ?? 0),
      label:     WMO_LABELS[codes[best]] ?? "Unknown",
      icon:      WMO_ICONS[codes[best]]  ?? "🌡️"
    };
    return (weatherCache[key] = result);
  } catch {
    return (weatherCache[key] = null);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function gameDateStatus(dateISO) {
  const today = _renderToday || todayISO();
  if (dateISO < today)   return "past";
  if (dateISO === today) return "today";
  return "upcoming";
}

function dateBadge(game) {
  if (game.cancelled) return '<span class="badge badge-cancelled">Cancelled</span>';
  const s = gameDateStatus(game.date);
  return `<span class="badge badge-${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</span>`;
}

function typeBadge(type) {
  const cls = type === "Plate" ? "plate" : type === "Field" ? "field" : "extra";
  return `<span class="badge badge-${cls}">${esc(type || "—")}</span>`;
}

// ── Slot helpers ──────────────────────────────────────────────────────────────

function getSlots(game) {
  return Array.isArray(game.umpireSlots) ? game.umpireSlots : [];
}

function openSlots(game) {
  return getSlots(game).filter(s => !s.assignedUid);
}

function mySlots(game) {
  const uid = getCurrentUser()?.uid;
  return getSlots(game).filter(s => s.assignedUid === uid);
}

function allSlotsFilled(game) {
  const slots = getSlots(game);
  return slots.length > 0 && slots.every(s => s.assignedUid);
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function gameMatchesFilter(game) {
  const today = _renderToday || todayISO();

  // ── View mode ────────────────────────────────────────────────────────────
  if (viewMode === "regular"    &&  game.tournamentId) return false;
  if (viewMode === "tournament" && !game.tournamentId) return false;

  // ── Status filter ────────────────────────────────────────────────────────
  if (statusFilter === "needs"  && (game.cancelled || openSlots(game).length === 0)) return false;
  if (statusFilter === "filled" && (game.cancelled || !allSlotsFilled(game)))        return false;
  if (statusFilter === "mine"   && mySlots(game).length === 0)                       return false;

  // ── Date filter ──────────────────────────────────────────────────────────
  switch (dateFilter) {
    case "today":
      if (game.date !== today) return false;
      break;
    case "week": {
      const end = weekEndISO();
      if (game.date < today || game.date > end) return false;
      break;
    }
    case "month": {
      const [y, m] = today.split("-");
      const monthStart = `${y}-${m}-01`;
      const lastDay    = new Date(Number(y), Number(m), 0); // day 0 = last day of previous month
      const monthEnd   = `${lastDay.getFullYear()}-${String(lastDay.getMonth()+1).padStart(2,"0")}-${String(lastDay.getDate()).padStart(2,"0")}`;
      if (game.date < monthStart || game.date > monthEnd) return false;
      break;
    }
    case "upcoming":
      if (game.date < today) return false;
      break;
    case "past":
      if (game.date >= today) return false;
      break;
    case "custom":
      if (dateFrom && game.date < dateFrom) return false;
      if (dateTo   && game.date > dateTo)   return false;
      break;
    // "all" — no restriction
  }

  // ── City filter ──────────────────────────────────────────────────────────
  if (cityFilter && (game.city || "") !== cityFilter) return false;

  // ── Umpire filter (admin only) ───────────────────────────────────────────
  if (umpireFilter && !getSlots(game).some(s => s.assignedUid === umpireFilter)) return false;

  return true;
}

// ── Pay summary ───────────────────────────────────────────────────────────────

function renderPaySummary() {
  const el = document.getElementById("paySummary");
  if (!el) return;
  if (statusFilter !== "mine") { el.style.display = "none"; return; }

  const mine = games.filter(g => mySlots(g).length > 0);
  if (mine.length === 0) { el.style.display = "none"; return; }
  // Sum per-slot payRate; fall back to game-level payRate for legacy docs
  const total = mine.reduce((sum, g) => {
    return sum + mySlots(g).reduce((s, slot) => s + (Number(slot.payRate ?? g.payRate) || 0), 0);
  }, 0);
  el.textContent = `${mine.length} game${mine.length !== 1 ? "s" : ""} — estimated pay: $${total.toFixed(2)}`;
  el.style.display = "";
}

// ── Count bar ─────────────────────────────────────────────────────────────────

function renderCount() {
  const el = document.getElementById("signupCount");
  if (!el) return;

  // Visible games after all filters (same set rendered in the table)
  const visible = games.filter(g => getSlots(g).length > 0).filter(gameMatchesFilter);
  const active  = visible.filter(g => !g.cancelled);

  if (visible.length === 0) {
    el.textContent = "No games match this filter.";
    return;
  }

  const totalSlots  = active.reduce((n, g) => n + getSlots(g).length, 0);
  const filledSlots = active.reduce((n, g) => n + getSlots(g).filter(s => s.assignedUid).length, 0);
  const openSlotCount = totalSlots - filledSlots;

  // Label for active date filter
  const dateLabels = { today:"today", week:"this week", month:"this month",
    upcoming:"upcoming", past:"past", all:"all time", custom:"custom range" };
  const dateLabel = dateLabels[dateFilter] || "";
  const cityLabel = cityFilter ? ` · ${cityFilter}` : "";
  const prefix    = `${active.length} game${active.length !== 1 ? "s" : ""} ${dateLabel}${cityLabel} — `;

  el.textContent = totalSlots === 0
    ? `${active.length} game${active.length !== 1 ? "s" : ""} ${dateLabel}${cityLabel}`
    : `${prefix}${filledSlots} of ${totalSlots} slot${totalSlots !== 1 ? "s" : ""} filled, ${openSlotCount} open`;
}

// ── Game Day bar ──────────────────────────────────────────────────────────────

// Admins can pass any umpire's uid to check in on their behalf.
async function checkIn(gameId, slotType, targetUid) {
  const user = getCurrentUser();
  if (!user) return;
  const uid = targetUid || user.uid;

  // Find the matching button — umpire card uses .check-in-btn, admin card uses .admin-checkin-btn
  const btn = document.querySelector(
    `.check-in-btn[data-game-id="${gameId}"][data-slot-type="${slotType}"],` +
    `.admin-checkin-btn[data-game-id="${gameId}"][data-slot-type="${slotType}"][data-target-uid="${uid}"]`
  );
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    const gameRef = doc(db, "games", gameId);
    let updatedSlots;
    await runTransaction(db, async tx => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game not found.");
      updatedSlots = (snap.data().umpireSlots || []).map(s =>
        (s.type === slotType && s.assignedUid === uid)
          ? { ...s, checkedIn: true, checkedInAt: new Date().toISOString() }
          : s
      );
      tx.update(gameRef, { umpireSlots: updatedSlots });
    });
    const g = games.find(g => g.id === gameId);
    if (g) g.umpireSlots = updatedSlots;
    _gameDayBarCache = null;
    renderGameDayBar();

    // Show shed code dialog for the checking-in umpire (not admin proxy check-ins)
    if (!targetUid) {
      const [facilities, shedCodes] = await Promise.all([getFacilities(), getShedCodes()]);
      const game     = games.find(g => g.id === gameId);
      const facility = game ? matchFacility(facilities, game.city) : null;
      const code     = facility ? (shedCodes[facility.id] || "") : "";
      if (code || game?.notes) showShedCodeDialog(code, facility?.name || "", game?.city || "", game?.notes || "");
    }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "Check In"; }
    showToast(err.message);
  }
}

// Admin-only: assign the current admin to an open slot on any game.
async function adminAssignSelf(gameId, slotType) {
  const user    = getCurrentUser();
  const profile = getCurrentProfile();
  if (!user || !profile || !isAdmin()) return;

  const btn = document.querySelector(`.admin-assign-self-btn[data-game-id="${gameId}"][data-slot-type="${slotType}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    const gameRef = doc(db, "games", gameId);
    let updatedSlots;
    await runTransaction(db, async tx => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game not found.");
      const slots  = snap.data().umpireSlots || [];
      const slotIdx = slots.findIndex(s => s.type === slotType && !s.assignedUid);
      if (slotIdx === -1) throw new Error("That slot was just filled. Please refresh.");
      updatedSlots = slots.map((s, i) =>
        i === slotIdx ? { ...s, assignedUid: user.uid, assignedName: profile.name } : s
      );
      const allFilled = updatedSlots.every(s => s.assignedUid);
      tx.update(gameRef, { umpireSlots: updatedSlots, needsUmpires: !allFilled });
    });
    // Update local cache if the game is in the main list
    const g = games.find(g => g.id === gameId);
    if (g) g.umpireSlots = updatedSlots;
    _gameDayBarCache = null;
    renderGameDayBar();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "Assign Me"; }
    showToast(err.message);
  }
}

async function showPartnerInfo(uid, name, anchorBtn) {
  // Toggle inline info panel below the button
  const existing = anchorBtn.parentElement.querySelector(".partner-info");
  if (existing) { existing.remove(); return; }
  try {
    const snap  = await getDoc(doc(db, "umpires", uid));
    const phone = snap.exists() ? (snap.data().phone || "") : "";
    const info  = document.createElement("span");
    info.className    = "partner-info";
    info.style.cssText = "font-size:0.82rem;color:#ccc;padding:4px 10px;background:rgba(255,255,255,0.08);border-radius:6px;white-space:nowrap;display:inline-flex;align-items:center;gap:8px";
    if (phone) {
      const rawPhone = phone.replace(/\D/g, "");
      info.innerHTML = `${esc(name)} &middot; <a href="tel:+1${esc(rawPhone)}" style="color:#7ec8f7">📞 ${esc(phone)}</a>`;
    } else {
      info.textContent = name || "No info";
    }
    anchorBtn.insertAdjacentElement("afterend", info);
  } catch {
    /* ignore */
  }
}

// Admin: remove an umpire from a slot
async function adminUnassignSlot(gameId, slotType, targetUid) {
  if (!isAdmin()) return;
  if (!await showConfirm(`Remove ${slotType} umpire from this game?`)) return;
  const btn = document.querySelector(`.admin-unassign-btn[data-game-id="${gameId}"][data-slot-type="${slotType}"][data-target-uid="${targetUid}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    const gameRef = doc(db, "games", gameId);
    let updatedSlots;
    await runTransaction(db, async tx => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game not found.");
      updatedSlots = (snap.data().umpireSlots || []).map(s =>
        (s.type === slotType && s.assignedUid === targetUid)
          ? { type: s.type, payRate: s.payRate, assignedUid: null, assignedName: null,
              checkedIn: false, checkedInAt: null, paid: false, noShow: false }
          : s
      );
      tx.update(gameRef, { umpireSlots: updatedSlots, needsUmpires: true });
    });
    const g = games.find(g => g.id === gameId);
    if (g) { g.umpireSlots = updatedSlots; g.needsUmpires = true; }
    _gameDayBarCache = null;
    renderGameDayBar();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "Unassign"; }
    showToast(err.message);
  }
}

// Admin: mark a slot as no-show
async function adminNoShow(gameId, slotType, targetUid) {
  if (!isAdmin()) return;
  const btn = document.querySelector(`.admin-noshow-btn[data-game-id="${gameId}"][data-slot-type="${slotType}"][data-target-uid="${targetUid}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    const gameRef = doc(db, "games", gameId);
    let updatedSlots;
    await runTransaction(db, async tx => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game not found.");
      updatedSlots = (snap.data().umpireSlots || []).map(s =>
        (s.type === slotType && s.assignedUid === targetUid)
          ? { ...s, noShow: true, checkedIn: false }
          : s
      );
      tx.update(gameRef, { umpireSlots: updatedSlots });
    });
    const g = games.find(g => g.id === gameId);
    if (g) g.umpireSlots = updatedSlots;
    _gameDayBarCache = null;
    renderGameDayBar();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "No Show"; }
    showToast(err.message);
  }
}

// Admin: cancel a game from the gameday bar
async function adminCancelGame(gameId) {
  if (!isAdmin()) return;
  if (!await showConfirm("Cancel this game? This cannot be undone from the game day bar.")) return;
  const btn = document.querySelector(`.admin-cancel-game-btn[data-game-id="${gameId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "Cancelling…"; }
  try {
    await updateDoc(doc(db, "games", gameId), { cancelled: true });
    const g = games.find(g => g.id === gameId);
    if (g) g.cancelled = true;
    _gameDayBarCache = null;
    renderGameDayBar();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "Cancel Game"; }
    showToast(err.message);
  }
}

function slotTypeCls(type) {
  return type === "Plate" ? "plate" : type === "Field" ? "field" : "extra";
}

function gameDayWxHtml(wx) {
  if (!wx) return "";
  return `<div class="game-day-weather" title="${esc(wx.label)}">
    ${wx.icon} ${wx.temp}°F &middot; ${esc(wx.label)} &middot; ${wx.wind} mph wind
  </div>`;
}

function gameDayNotesHtml(game) {
  if (!game.notes) return "";
  return `<div style="margin:6px 0;padding:5px 10px;background:rgba(255,224,102,0.1);border-left:3px solid #ffe066;border-radius:0 4px 4px 0;font-size:0.85rem;color:#ffe066">📋 ${esc(game.notes)}</div>`;
}

function renderUmpireGameCard(game, uid, facility, shedCodes, wx) {
  const mySlot      = getSlots(game).find(s => s.assignedUid === uid);
  if (!mySlot) return "";
  const partnerSlot = getSlots(game).find(s => s.assignedUid && s.assignedUid !== uid);
  const checkedIn   = mySlot.checkedIn === true;
  const mapsUrl     = facility?.googleMapsUrl
    || `https://maps.google.com/?q=${encodeURIComponent(`${game.field || ""} ${game.city || ""}`)}`;
  const shedCode    = facility ? (shedCodes[facility.id] || "") : "";
  const shedHtml    = checkedIn && shedCode
    ? `<div class="game-day-shed-code">🔑 Shed Code: <span>${esc(shedCode)}</span></div>`
    : "";

  return `
  <div class="game-day-card" data-game-id="${esc(game.id)}">
    <div class="game-day-title">Game Day</div>
    <div class="game-day-info">
      <strong>${esc(game.city)}</strong>
      <span class="badge badge-${slotTypeCls(mySlot.type)}">${esc(mySlot.type)}</span>
      &mdash; ${esc(game.field || "")} &mdash; ${esc(game.time || "TBD")}
    </div>
    ${gameDayWxHtml(wx)}
    ${gameDayNotesHtml(game)}
    ${shedHtml}
    <div class="game-day-actions">
      <a href="${esc(mapsUrl)}" class="btn" target="_blank" rel="noopener">Directions</a>
      ${partnerSlot
        ? `<button class="btn print-btn partner-btn"
             data-uid="${esc(partnerSlot.assignedUid)}"
             data-name="${esc(partnerSlot.assignedName || "")}">Partner: ${esc(partnerSlot.assignedName || "?")}</button>`
        : `<button class="btn print-btn" disabled>No partner assigned</button>`
      }
      <a href="field-issues.html" class="btn print-btn">Report Issue</a>
      <a href="incident.html" class="btn print-btn">Incident Report</a>
      <button class="btn ${checkedIn ? "" : "print-btn"} check-in-btn"
        data-game-id="${esc(game.id)}" data-slot-type="${esc(mySlot.type)}"
        ${checkedIn ? "disabled" : ""}>
        ${checkedIn ? "✓ Checked In" : "Check In"}
      </button>
    </div>
  </div>`;
}

function renderAdminGameCard(game, facility, shedCodes, wx) {
  const slots    = getSlots(game);
  const mapsUrl  = facility?.googleMapsUrl
    || `https://maps.google.com/?q=${encodeURIComponent(`${game.field || ""} ${game.city || ""}`)}`;
  const shedCode = facility ? (shedCodes[facility.id] || "") : "";
  const shedHtml = shedCode
    ? `<div class="game-day-shed-code">🔑 Shed Code: <span>${esc(shedCode)}</span></div>`
    : "";

  const slotRows = slots.length
    ? slots.map(s => {
        const badge = `<span class="badge badge-${slotTypeCls(s.type)}">${esc(s.type)}</span>`;
        if (s.assignedUid) {
          const name       = esc(s.assignedName || s.assignedUid);
          const unassignBtn = hasRole("umpires") ? `<button class="btn print-btn admin-unassign-btn"
            data-game-id="${esc(game.id)}" data-slot-type="${esc(s.type)}"
            data-target-uid="${esc(s.assignedUid)}" style="font-size:0.78rem">Unassign</button>` : "";
          if (s.noShow) {
            return `<div class="admin-gameday-slot">
              ${badge}
              <span class="gameday-noshow-label">⚠ No Show — ${name}</span>
              ${unassignBtn}
            </div>`;
          }
          if (s.checkedIn) {
            return `<div class="admin-gameday-slot">
              ${badge}
              <span>${name}</span>
              <span style="color:#b8f2c4;font-size:0.85rem">✓ Checked In</span>
              ${unassignBtn}
            </div>`;
          }
          return `<div class="admin-gameday-slot">
            ${badge}
            <span>${name}</span>
            <button class="btn print-btn admin-checkin-btn"
              data-game-id="${esc(game.id)}" data-slot-type="${esc(s.type)}"
              data-target-uid="${esc(s.assignedUid)}">Check In</button>
            <button class="btn print-btn admin-noshow-btn"
              data-game-id="${esc(game.id)}" data-slot-type="${esc(s.type)}"
              data-target-uid="${esc(s.assignedUid)}" style="font-size:0.78rem">No Show</button>
            ${unassignBtn}
          </div>`;
        }
        return `<div class="admin-gameday-slot">
          ${badge}
          <span style="color:#ffcc80">Open</span>
          <button class="btn print-btn admin-assign-self-btn"
            data-game-id="${esc(game.id)}"
            data-slot-type="${esc(s.type)}">Assign Me</button>
        </div>`;
      }).join("")
    : `<div style="color:var(--light-text);font-size:0.85rem">No slots configured</div>`;

  return `
  <div class="game-day-card" data-game-id="${esc(game.id)}">
    <div class="game-day-title" style="background:rgba(60,20,80,0.7)">🎛 Admin — Game Day</div>
    <div class="game-day-info">
      <strong>${esc(game.city)}</strong>
      ${game.division ? `<span class="badge" style="background:#2d1a4a;color:#c9a0ff">${esc(game.division)}</span>` : ""}
      &mdash; ${esc(game.field || "")} &mdash; ${esc(game.time || "TBD")}
    </div>
    ${gameDayWxHtml(wx)}
    ${gameDayNotesHtml(game)}
    ${shedHtml}
    <div style="margin:10px 0">${slotRows}</div>
    <div class="game-day-actions">
      <a href="${esc(mapsUrl)}" class="btn" target="_blank" rel="noopener">Directions</a>
      <a href="field-issues.html" class="btn print-btn">Report Issue</a>
      <a href="incident.html" class="btn print-btn">Incident Report</a>
      <a href="admin-games.html" class="btn print-btn">Edit Game</a>
      <button class="btn print-btn admin-cancel-game-btn"
        data-game-id="${esc(game.id)}"
        style="border-color:#ff6b6b;color:#ff6b6b">Cancel Game</button>
    </div>
  </div>`;
}

function _renderGameDayBarFromCache(uid, admin) {
  const bar = document.getElementById("gameDayBar");
  if (!bar) return;
  const { todayGames, facilities, shedCodes, weatherMap } = _gameDayBarCache;
  if (todayGames.length === 0) { bar.style.display = "none"; return; }
  bar.style.display = "";
  bar.innerHTML = todayGames.map(game => {
    const facility = matchFacility(facilities, game.city);
    const wx       = weatherMap[game.id];
    return admin
      ? renderAdminGameCard(game, facility, shedCodes, wx)
      : renderUmpireGameCard(game, uid, facility, shedCodes, wx);
  }).join("");
}

async function renderGameDayBar() {
  const bar = document.getElementById("gameDayBar");
  if (!bar) return;

  const uid   = getCurrentUser()?.uid;
  const admin = isAdmin();
  if (!isLoggedIn() || (!isApproved() && !admin) || !uid) { bar.style.display = "none"; return; }

  const today = todayISO();

  // Serve from cache if already loaded today
  if (_gameDayBarCache?.date === today) {
    _renderGameDayBarFromCache(uid, admin);
    return;
  }

  // Query all today's games regardless of needsUmpires — a fully-assigned game
  // has needsUmpires=false and would otherwise be invisible to the umpire or admin.
  let todayGames;
  try {
    const snap = await getDocs(query(
      collection(db, "games"),
      where("date", "==", today),
      orderBy("time")
    ));
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(g => !g.cancelled && !g.isAway);
    // Admins see every home game today; umpires see only their own assigned home games
    todayGames = admin ? all : all.filter(g => getSlots(g).some(s => s.assignedUid === uid));
  } catch (_) {
    bar.style.display = "none";
    return;
  }

  const [facilities, shedCodes] = await Promise.all([getFacilities(), getShedCodes()]);

  const weatherMap = {};
  await Promise.all(todayGames.map(async g => {
    weatherMap[g.id] = await fetchWeather(g.city, g.date, g.time);
  }));

  _gameDayBarCache = { date: today, todayGames, facilities, shedCodes, weatherMap };
  _renderGameDayBarFromCache(uid, admin);
}

// ── Row rendering ─────────────────────────────────────────────────────────────

function buildTypesCell(game) {
  const slots = getSlots(game);
  if (!slots.length) return "—";
  return slots.map(s => typeBadge(s.type)).join(" ");
}

function buildStatusCell(game) {
  if (game.cancelled) return '<span style="color:#ffb4b4">Cancelled</span>';
  const slots = getSlots(game);
  if (!slots.length) return "—";
  const canSeeDetails = isApproved() || isAdmin() || isCoach();
  return slots.map(s => {
    const cls = s.type === "Plate" ? "plate" : s.type === "Field" ? "field" : "extra";
    const badge = `<span class="badge badge-${cls}">${esc(s.type)}</span>`;
    if (s.assignedName) {
      if (canSeeDetails) {
        const pay = s.payRate != null ? ` <span style="color:var(--light-text);font-size:0.78rem">$${Number(s.payRate).toFixed(0)}</span>` : "";
        return `<div style="margin-bottom:2px">${badge} ${esc(s.assignedName)}${pay}</div>`;
      }
      return `<div style="margin-bottom:2px">${badge} <span style="color:#b8f2c4;font-size:0.85rem">Assigned</span></div>`;
    }
    return `<div style="margin-bottom:2px">${badge} <span style="color:#ffcc80;font-size:0.85rem">Open</span></div>`;
  }).join("");
}

function buildStatusClass(game) {
  if (game.cancelled) return "";
  const slots = getSlots(game);
  const filled = slots.filter(s => s.assignedUid).length;
  if (filled === 0) return "status-needs";
  if (filled === slots.length) return "status-filled";
  return "status-needs"; // partially filled still needs more
}

function buildActionCell(game) {
  if (game.cancelled) return "—";
  if (gameDateStatus(game.date) === "past") {
    return '<span style="color:var(--light-text);font-size:0.85rem">Game over</span>';
  }

  const uid      = getCurrentUser()?.uid;
  const slots    = getSlots(game);
  const approved = isApproved() || isAdmin();
  const alreadyOnGame = uid && slots.some(s => s.assignedUid === uid);

  // Unauthenticated / non-approved visitors see no buttons — status cell already shows open/assigned
  if (!approved) return "";

  return `<div style="display:flex;flex-direction:column;gap:4px">${slots.map(slot => {
    const label = esc(slot.type);
    if (slot.assignedUid === uid) {
      return `<div style="display:flex;flex-direction:column;gap:3px">
        <button type="button" class="btn print-btn" disabled
          style="opacity:0.9;cursor:default;font-size:0.85rem">✓ Signed up: ${label}</button>
        <button type="button" class="btn contact-coordinator-btn"
          data-game-id="${esc(game.id)}" data-slot-type="${esc(slot.type)}"
          style="font-size:0.78rem;padding:3px 10px;background:transparent;border:1px solid #666;color:var(--light-text)">
          Need to cancel?</button>
      </div>`;
    }
    if (slot.assignedUid) {
      return `<button type="button" class="btn locked-btn" disabled>${label}: ${esc(slot.assignedName || "Filled")}</button>`;
    }
    if (alreadyOnGame) {
      return `<button type="button" class="btn locked-btn" disabled
        title="You already have a slot on this game">${label} — already on this game</button>`;
    }
    return `<button type="button" class="btn signup-btn"
      data-game-id="${esc(game.id)}" data-slot-type="${esc(slot.type)}">
      Sign up: ${label}</button>`;
  }).join("")}</div>`;
}

function buildGameRow(g) {
  const teams = (g.homeTeam && g.awayTeam)
    ? (g.isAway
        ? `<span style="font-size:0.72rem;background:#2a1a3a;color:#c9a0ff;border:1px solid #6b3fa0;border-radius:4px;padding:1px 5px;margin-right:4px;vertical-align:middle">AWAY</span>${esc(g.awayTeam)} <span style="color:var(--light-text)">@</span> ${esc(g.homeTeam)}`
        : `${esc(g.homeTeam)} <span style="color:var(--light-text)">vs</span> ${esc(g.awayTeam)}`)
    : "—";
  const notesRow = (g.notes && (isApproved() || isAdmin()))
    ? `<tr><td colspan="8" style="padding:0 8px 7px 14px;border-top:none">
        <span style="font-size:0.8rem;color:#ffe066">📋 ${esc(g.notes)}</span>
       </td></tr>`
    : "";
  return `
    <tr>
      <td>${esc(fmtDate(g.date))} ${dateBadge(g)}</td>
      <td>${esc(g.time || "—")}</td>
      <td>${esc(g.division || "—")}${g.tournamentId ? ' <span class="badge" style="background:#2d1a4a;color:#c9a0ff;font-size:0.72rem">🏆</span>' : ""}</td>
      <td>${teams}</td>
      <td>${buildTypesCell(g)}</td>
      <td>${esc(g.field || "—")}</td>
      <td class="${buildStatusClass(g)}">${buildStatusCell(g)}</td>
      <td style="white-space:nowrap">${buildActionCell(g)}</td>
    </tr>${notesRow}`;
}

// ── Populate city + umpire filter dropdowns from current game set ─────────────

function populateSecondaryFilters() {
  // City dropdown — unique cities across all loaded games that have slots
  const cityEl = document.getElementById("cityFilter");
  if (cityEl) {
    const cities = [...new Set(
      games.filter(g => getSlots(g).length > 0 && g.city).map(g => g.city).sort()
    )];
    const prev = cityEl.value;
    cityEl.innerHTML = `<option value="">All Cities</option>` +
      cities.map(c => `<option value="${esc(c)}"${c === prev ? " selected" : ""}>${esc(c)}</option>`).join("");
  }

  // Umpire dropdown — admin only; unique assigned umpires across all loaded games
  const umpEl = document.getElementById("umpireFilterSel");
  if (umpEl) {
    if (!isAdmin()) { umpEl.closest("#umpireFilterWrap")?.style && (umpEl.closest("#umpireFilterWrap").style.display = "none"); }
    else {
      umpEl.closest("#umpireFilterWrap").style.display = "";
      const seen = {};
      games.forEach(g => getSlots(g).forEach(s => {
        if (s.assignedUid && s.assignedName) seen[s.assignedUid] = s.assignedName;
      }));
      const prev = umpEl.value;
      const sorted = Object.entries(seen).sort((a, b) => a[1].localeCompare(b[1]));
      umpEl.innerHTML = `<option value="">All Umpires</option>` +
        sorted.map(([uid, name]) =>
          `<option value="${esc(uid)}"${uid === prev ? " selected" : ""}>${esc(name)}</option>`
        ).join("");
    }
  }
}

function renderGameRows() {
  const container = document.getElementById("gameSchedule");
  if (!container) return;

  _renderToday = todayISO(); // compute once for the entire render pass
  populateSecondaryFilters();

  if (viewMode === "tournament") {
    renderTournamentGameRows(container);
    return;
  }

  // Exclude games with no umpire slots configured — they have nothing for umpires to sign up for
  const visible = games.filter(g => getSlots(g).length > 0).filter(gameMatchesFilter);

  if (visible.length === 0) {
    container.innerHTML = `<div class="document-note"><p style="margin:0;text-align:center;color:var(--light-text)">No games match this filter.</p></div>`;
    renderCount();
    renderPaySummary();
    renderGameDayBar();
    return;
  }

  // Group by city, preserving insertion order (already sorted by date/time from Firestore)
  const cityOrder = [];
  const byCity = {};
  visible.forEach(g => {
    const city = g.city || "Other";
    if (!byCity[city]) { byCity[city] = []; cityOrder.push(city); }
    byCity[city].push(g);
  });

  const TABLE_HEAD = `
    <thead><tr>
      <th>Date</th><th>Time</th><th>Div</th><th>Teams</th>
      <th>Type</th><th>Field</th><th>Status</th><th>Action</th>
    </tr></thead>`;

  container.innerHTML = cityOrder.map(city => `
    <div class="schedule-section">
      <h2>${esc(city)}</h2>
      <table>${TABLE_HEAD}
        <tbody>${byCity[city].map(buildGameRow).join("")}</tbody>
      </table>
    </div>`).join("");

  renderCount();
  renderPaySummary();
  renderGameDayBar();
}

function renderTournamentGameRows(container) {
  const visible = games.filter(g => getSlots(g).length > 0).filter(gameMatchesFilter);

  if (visible.length === 0) {
    container.innerHTML = `<div class="document-note"><p style="margin:0;text-align:center;color:var(--light-text)">No tournament games match this filter.</p></div>`;
    renderCount();
    renderPaySummary();
    renderGameDayBar();
    return;
  }

  // Group by tournament, then bracket (field), then date+time (already sorted)
  const tOrder = [];
  const byT    = {};
  visible.forEach(g => {
    const tid  = g.tournamentId || "unknown";
    const t    = tournamentsMap[tid];
    const tKey = tid;
    if (!byT[tKey]) { byT[tKey] = { t, games: [] }; tOrder.push(tKey); }
    byT[tKey].games.push(g);
  });

  const TABLE_HEAD = `
    <thead><tr>
      <th>Date / Time</th><th>Game</th>
      <th>Field</th><th>Score</th><th>Status</th><th>Action</th>
    </tr></thead>`;

  container.innerHTML = tOrder.map(tid => {
    const { t, games: tGames } = byT[tid];
    const tName    = t ? esc(t.name) : "Tournament";
    const tDate    = t ? ` <span style="color:var(--light-text);font-size:0.85rem;font-weight:normal">· ${esc(fmtDate(t.date))}</span>` : "";
    const tDiv     = t?.division ? ` <span class="badge" style="background:#1a2a3a;color:#7ec8f7">${esc(t.division)}</span>` : "";

    // Group by bracket (field value)
    const bracketOrder = [];
    const byBracket    = {};
    tGames.forEach(g => {
      const b = g.field || "Games";
      if (!byBracket[b]) { byBracket[b] = []; bracketOrder.push(b); }
      byBracket[b].push(g);
    });

    const bracketSections = bracketOrder.map(bracket => {
      const rows = byBracket[bracket].map(g => buildTournamentGameRow(g)).join("");
      return `
        <div style="margin-bottom:16px">
          <h3 style="font-size:0.95rem;color:#c9a0ff;margin:12px 0 6px;padding:6px 10px;
                     background:rgba(100,60,180,0.12);border-left:3px solid #7c44cc;border-radius:0 4px 4px 0">
            🏟 ${esc(bracket)}
          </h3>
          <table>${TABLE_HEAD}
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join("");

    return `
      <div class="schedule-section">
        <h2>🏆 ${tName}${tDate}${tDiv}</h2>
        ${bracketSections}
      </div>`;
  }).join("");

  renderCount();
  renderPaySummary();
  renderGameDayBar();
}

function buildTournamentGameRow(g) {
  // Extract game number from notes (e.g. "Bracket 1 - Game 3")
  const noteMatch = (g.notes || "").match(/Game\s+(\d+)/i);
  const gameLabel = noteMatch ? `Game ${noteMatch[1]}` : "—";
  const ifNec     = (g.notes || "").toLowerCase().includes("if necessary")
    ? ` <span style="color:#ffd966;font-size:0.75rem">(if nec.)</span>` : "";

  const statusCell  = buildStatusCell(g);
  const statusClass = buildStatusClass(g);

  // Score display
  const hasScore   = g.homeScore != null && g.awayScore != null;
  const scoreCell  = hasScore
    ? `<strong style="color:#86efac">${esc(String(g.homeScore))}</strong>
       <span style="color:var(--light-text);margin:0 3px">–</span>
       <strong style="color:#86efac">${esc(String(g.awayScore))}</strong>`
    : `<span style="color:var(--light-text);font-size:0.82rem">—</span>`;

  // Score entry button — shown to approved umpires/admins for today's or past tournament games
  const canScore   = (isApproved() || isAdmin()) && !g.cancelled &&
                     gameDateStatus(g.date) !== "future";
  const scoreBtn   = canScore
    ? `<button type="button" class="btn print-btn score-entry-btn"
         data-game-id="${esc(g.id)}"
         style="font-size:0.78rem;padding:3px 10px;margin-left:6px">
         ${hasScore ? "✏️ Edit" : "📊 Score"}</button>`
    : "";

  // Teams line (if set)
  const teamsLine = (g.homeTeam || g.awayTeam)
    ? `<div style="font-size:0.8rem;color:var(--light-text);margin-top:2px">
         ${esc(g.homeTeam || "TBD")} <span style="margin:0 3px">vs</span> ${esc(g.awayTeam || "TBD")}
       </div>`
    : "";

  return `<tr class="${statusClass}">
    <td style="white-space:nowrap">${esc(fmtDate(g.date))}<br>
      <span style="font-size:0.8rem;color:var(--light-text)">${esc(fmtTime(g.time))}</span>
    </td>
    <td>${esc(gameLabel)}${ifNec}${teamsLine}</td>
    <td>${esc(g.subField || g.field || "—")}</td>
    <td style="white-space:nowrap">${scoreCell}${scoreBtn}</td>
    <td>${statusCell}</td>
    <td>${buildActionCell(g)}</td>
  </tr>`;
}

// ── Load from Firestore ───────────────────────────────────────────────────────

function showLoading() {
  const container = document.getElementById("gameSchedule");
  if (container) container.innerHTML = `<p style="color:var(--light-text);text-align:center;padding:30px">Loading schedule…</p>`;
}

async function loadPendingCancels() {
  const uid = getCurrentUser()?.uid;
  if (!uid || !isApproved()) { pendingCancels = {}; return; }
  try {
    const snap = await getDocs(query(
      collection(db, "cancellationRequests"),
      where("uid",    "==", uid),
      where("status", "==", "pending")
    ));
    pendingCancels = {};
    snap.forEach(d => {
      const r = d.data();
      pendingCancels[`${r.gameId}|${r.slotType}`] = d.id;
    });
  } catch (err) {
    console.error("loadPendingCancels:", err);
  }
}

async function loadGames() {
  showLoading();
  try {
    const [snap, tSnap] = await Promise.all([
      getDocs(query(
        collection(db, "games"),
        orderBy("date"),
        orderBy("time")
      )),
      getDocs(collection(db, "tournaments")),
      loadPendingCancels()
    ]);
    games = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    tournamentsMap = {};
    tSnap.forEach(d => { tournamentsMap[d.id] = { id: d.id, ...d.data() }; });
    renderGameRows();
  } catch (err) {
    const container = document.getElementById("gameSchedule");
    if (container) container.innerHTML = `<div class="document-note"><p style="color:#ffb4b4;margin:0">Failed to load schedule. Please refresh the page.</p></div>`;
    console.error("loadGames:", err);
  }
}

// ── Team calendar / conflict detection ───────────────────────────────────────

async function loadTeamCalendars() {
  try {
    const snap = await getDoc(doc(db, "config", "teamCalendars"));
    teamCalendars = snap.exists() ? (snap.data().teams || []) : [];
  } catch (_) {}
}

/**
 * Check whether the umpire's player team has a game or practice conflicting with the given game.
 * Returns { teamGame, teamPractice } — each is the conflicting doc (or null).
 * A "hard" time conflict means same date + same time.
 * A "soft" date conflict means same date, different/unknown time.
 */
async function checkPlayerTeamConflict(game) {
  const profile = getCurrentProfile();
  const playerTeam = profile?.playerTeam || "";
  if (!playerTeam) return { teamGame: null, teamPractice: null };

  const date = game.date;
  const time = game.time || "";

  // Match a calendar name against the team's calendarName or name
  const lc = s => (s || "").toLowerCase().trim();
  const nameMatches = (homeTeam, awayTeam) => {
    // Find the team config entry to get calendarName
    const teamCfg = teamCalendars.find(t => t.name === playerTeam);
    const calName = teamCfg?.calendarName || playerTeam;
    const candidates = [lc(playerTeam), lc(calName)].filter(Boolean);
    for (const c of candidates) {
      if (homeTeam && (lc(homeTeam) === c || lc(homeTeam).includes(c) || c.includes(lc(homeTeam)))) return true;
      if (awayTeam && (lc(awayTeam) === c || lc(awayTeam).includes(c) || c.includes(lc(awayTeam)))) return true;
    }
    return false;
  };

  // Fetch games and practices on the same date in parallel
  const [gamesSnap, practicesSnap] = await Promise.all([
    getDocs(query(collection(db, "games"), where("date", "==", date))),
    getDocs(query(collection(db, "practices"), where("date", "==", date))),
  ]);

  // Team game conflict
  let teamGame = null;
  for (const d of gamesSnap.docs) {
    if (d.id === game.id) continue; // skip this game itself
    const g = d.data();
    if (g.cancelled) continue;
    if (nameMatches(g.homeTeam, g.awayTeam)) {
      teamGame = { id: d.id, ...g };
      break;
    }
  }

  // Practice conflict
  let teamPractice = null;
  for (const d of practicesSnap.docs) {
    const p = d.data();
    const pTeam = p.teamName || "";
    const candidates = [lc(playerTeam), lc(teamCalendars.find(t => t.name === playerTeam)?.calendarName || "")].filter(Boolean);
    if (candidates.some(c => c && (lc(pTeam) === c || lc(pTeam).includes(c) || c.includes(lc(pTeam))))) {
      teamPractice = { id: d.id, ...p };
      break;
    }
  }

  return { teamGame, teamPractice };
}

// Legacy ICS helpers kept for any external callers
function normalizeIcsUrl(url) {
  return url.replace(/^webcal:\/\//i, "https://");
}
async function fetchICS(rawUrl) {
  const url = normalizeIcsUrl(rawUrl);
  try { const res = await fetch(url, { mode: "cors" }); if (res.ok) return await res.text(); } catch (_) {}
  try { const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`); if (res.ok) return await res.text(); } catch (_) {}
  return null;
}

// ── Signup modal ──────────────────────────────────────────────────────────────

async function openModal(gameId, slotType) {
  const game = games.find(g => g.id === gameId);
  if (!game) return;
  pendingGameId   = gameId;
  pendingSlotType = slotType;

  const slot = getSlots(game).find(s => s.type === slotType);
  const slotPay = slot?.payRate ?? game.payRate;
  const pay = slotPay ? `$${Number(slotPay).toFixed(2)}` : "TBD";
  const teams = (game.homeTeam && game.awayTeam)
    ? (game.isAway
        ? `<span style="font-size:0.72rem;background:#2a1a3a;color:#c9a0ff;border:1px solid #6b3fa0;border-radius:4px;padding:1px 5px;margin-right:4px">AWAY</span>${esc(game.awayTeam)} @ ${esc(game.homeTeam)}<br>`
        : `${esc(game.homeTeam)} vs ${esc(game.awayTeam)}<br>`)
    : "";
  const notesHtml = game.notes
    ? `<div style="margin-top:8px;padding:6px 10px;background:rgba(255,224,102,0.1);border-left:3px solid #ffe066;border-radius:0 4px 4px 0;font-size:0.88rem;color:#ffe066">📋 ${esc(game.notes)}</div>` : "";
  document.getElementById("modalGameDetail").innerHTML =
    `<strong>${esc(game.city)}</strong> &mdash; ${esc(game.division)} ${typeBadge(slotType)}<br>
     ${teams}${esc(fmtDate(game.date))} at ${esc(game.time || "TBD")} &mdash; ${esc(game.field || "TBD")}<br>
     Pay rate: <strong>${pay}</strong>${notesHtml}`;

  const msgEl = document.getElementById("signupMessage");
  msgEl.textContent = "";
  msgEl.className   = "signup-message";
  const modalEl = document.getElementById("signupModal");
  modalEl.style.display = "";
  modalEl.scrollIntoView({ behavior: "smooth", block: "center" });
  document.getElementById("confirmSignupBtn").disabled = false;

  // Conflict checks — run async after modal opens so they don't delay display
  if (isLoggedIn()) {
    const uid = getCurrentUser()?.uid;

    // 1. Hard block: already signed up for another game at the exact same date + time
    if (uid && game.date && game.time) {
      const collision = games.find(g =>
        g.id !== gameId &&
        g.date === game.date &&
        g.time === game.time &&
        !g.cancelled &&
        (g.umpireSlots || []).some(s => s.assignedUid === uid)
      );
      if (collision) {
        const colCity = collision.city ? ` (${collision.city})` : "";
        msgEl.textContent =
          `⛔ You're already assigned to another game at this time${colCity}. You cannot double-book.`;
        msgEl.className = "signup-message error";
        document.getElementById("confirmSignupBtn").disabled = true;
        return; // skip team conflict check — hard block takes precedence
      }
    }

    // 2. Player-team conflict: check Firestore for same-date team games and practices
    const { teamGame, teamPractice } = await checkPlayerTeamConflict(game);
    if (teamGame) {
      const sameTime = teamGame.time && game.time && teamGame.time === game.time;
      if (sameTime) {
        // Hard block — exact same time
        const opponent = [teamGame.homeTeam, teamGame.awayTeam].filter(Boolean).join(" vs ");
        msgEl.textContent = `⛔ Your team (${esc(getCurrentProfile()?.playerTeam || "")}) has a game at the same time${opponent ? ": " + opponent : ""}. You cannot umpire this game.`;
        msgEl.className   = "signup-message error";
        document.getElementById("confirmSignupBtn").disabled = true;
        return;
      } else {
        const timeLabel = teamGame.time ? ` at ${teamGame.time}` : "";
        const opponent  = [teamGame.homeTeam, teamGame.awayTeam].filter(Boolean).join(" vs ");
        msgEl.textContent = `⚠️ Your team has a game on this date${timeLabel}${opponent ? " (" + opponent + ")" : ""}. Confirm you're available to umpire.`;
        msgEl.className   = "signup-message warning";
      }
    }
    if (teamPractice) {
      const sameTime = teamPractice.startTime && game.time && teamPractice.startTime === game.time;
      const timeLabel = teamPractice.startTime ? ` at ${teamPractice.startTime}` : "";
      const prefix    = msgEl.textContent ? msgEl.textContent + " · " : "";
      if (sameTime && !msgEl.className.includes("error")) {
        msgEl.textContent = `${prefix}⛔ Your team has practice at the same time${timeLabel}. You cannot umpire this game.`;
        msgEl.className   = "signup-message error";
        document.getElementById("confirmSignupBtn").disabled = true;
        return;
      } else if (!msgEl.className.includes("error")) {
        msgEl.textContent = `${prefix}⚠️ Your team has practice on this date${timeLabel}. Confirm you're available to umpire.`;
        msgEl.className   = "signup-message warning";
      }
    }

    // 3. Weekly game limit — blocks if umpire has hit their self-set cap
    const profile = getCurrentProfile();
    if (uid && profile?.maxGamesPerWeek != null) {
      const [gy, gm, gd] = game.date.split("-").map(Number);
      const pivot  = new Date(gy, gm - 1, gd);
      const dow    = pivot.getDay(); // 0 = Sunday
      const wStart = new Date(pivot); wStart.setDate(pivot.getDate() - dow);
      const wEnd   = new Date(pivot); wEnd.setDate(pivot.getDate() + (6 - dow));
      const iso    = x => `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`;
      const ws = iso(wStart), we = iso(wEnd);
      const weekCount = games.filter(g =>
        g.id !== gameId &&
        !g.cancelled &&
        g.date >= ws && g.date <= we &&
        (g.umpireSlots || []).some(s => s.assignedUid === uid)
      ).length;
      if (weekCount >= profile.maxGamesPerWeek) {
        const prev = msgEl.textContent ? msgEl.textContent + " · " : "";
        msgEl.textContent = `${prev}⚠️ You've set a max of ${profile.maxGamesPerWeek} game${profile.maxGamesPerWeek !== 1 ? "s" : ""}/week — you already have ${weekCount} this week.`;
        msgEl.className   = "signup-message warning";
        document.getElementById("confirmSignupBtn").disabled = true;
      }
    }
  }
}

function closeModal() {
  document.getElementById("signupModal").style.display = "none";
  pendingGameId   = null;
  pendingSlotType = null;
}

// ── Score entry ───────────────────────────────────────────────────────────────

function openScoreEntry(gameId) {
  const g = games.find(x => x.id === gameId);
  if (!g) return;
  pendingScoreGameId = gameId;

  const noteMatch  = (g.notes || "").match(/Game\s+(\d+)/i);
  const gameLabel  = noteMatch ? `Game ${noteMatch[1]}` : "Game";
  const bracket    = g.field || "";
  const homeName   = g.homeTeam || "Home";
  const awayName   = g.awayTeam || "Away";

  document.getElementById("scoreModalDetail").textContent =
    `${bracket} · ${gameLabel} · ${fmtDate(g.date)} ${fmtTime(g.time)}`;
  document.getElementById("scoreHomeLabel").textContent = homeName;
  document.getElementById("scoreAwayLabel").textContent = awayName;
  document.getElementById("scoreHomeInput").value = g.homeScore ?? "";
  document.getElementById("scoreAwayInput").value = g.awayScore ?? "";
  document.getElementById("scoreMessage").textContent = "";
  document.getElementById("scoreMessage").className = "signup-message";
  document.getElementById("scoreModal").style.display = "";
  document.getElementById("scoreHomeInput").focus();
}

function closeScoreModal() {
  document.getElementById("scoreModal").style.display = "none";
  pendingScoreGameId = null;
}

async function saveScore() {
  const gameId = pendingScoreGameId;
  if (!gameId) return;

  const homeVal = document.getElementById("scoreHomeInput").value;
  const awayVal = document.getElementById("scoreAwayInput").value;
  const msgEl   = document.getElementById("scoreMessage");

  if (homeVal === "" || awayVal === "") {
    msgEl.className = "signup-message error";
    msgEl.textContent = "Enter both scores.";
    return;
  }
  const homeScore = parseInt(homeVal, 10);
  const awayScore = parseInt(awayVal, 10);
  if (isNaN(homeScore) || isNaN(awayScore) || homeScore < 0 || awayScore < 0) {
    msgEl.className = "signup-message error";
    msgEl.textContent = "Scores must be non-negative numbers.";
    return;
  }

  const btn = document.getElementById("confirmScoreBtn");
  btn.disabled = true;
  msgEl.className = "signup-message";
  msgEl.textContent = "Saving…";

  try {
    await updateDoc(doc(db, "games", gameId), { homeScore, awayScore });
    const g = games.find(x => x.id === gameId);
    if (g) { g.homeScore = homeScore; g.awayScore = awayScore; }
    msgEl.className = "signup-message success";
    msgEl.textContent = "Score saved!";
    // Advance teams in background; close modal immediately
    closeScoreModal();
    renderGameRows();
    advanceTeams(gameId, homeScore, awayScore).catch(err =>
      console.warn("Bracket advancement failed:", err)
    );
  } catch (err) {
    msgEl.className = "signup-message error";
    msgEl.textContent = "Failed: " + err.message;
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

// ── Bracket advancement ───────────────────────────────────────────────────────

async function advanceTeams(gameId, homeScore, awayScore) {
  const g = games.find(x => x.id === gameId);
  if (!g?.tournamentId || homeScore == null || awayScore == null) return;

  // Load tournament for bracketAdvancement rules
  const tSnap = await getDoc(doc(db, "tournaments", g.tournamentId));
  if (!tSnap.exists()) return;
  const advancement = tSnap.data().bracketAdvancement || {};
  const bracket = g.field || "";
  const rules   = advancement[bracket];
  if (!rules) return;

  const numMatch = (g.notes || "").match(/Game\s+(\d+)/i);
  if (!numMatch) return;
  const gameNum = String(parseInt(numMatch[1], 10));
  const rule    = rules[gameNum];
  if (!rule) return;

  const isTie    = homeScore === awayScore;
  const winner   = isTie ? null : (homeScore > awayScore ? (g.homeTeam || "") : (g.awayTeam || ""));
  const loser    = isTie ? null : (homeScore > awayScore ? (g.awayTeam || "") : (g.homeTeam || ""));

  // Find a game in same bracket by game number
  const bracketGames = games.filter(x =>
    x.tournamentId === g.tournamentId && x.field === bracket
  );
  function findByNum(n) {
    return bracketGames.find(x => {
      const m = (x.notes || "").match(/Game\s+(\d+)/i);
      return m && parseInt(m[1], 10) === n;
    });
  }

  const batch   = writeBatch(db);
  let   updated = 0;
  const changes = []; // for toast

  function scheduleUpdate(dest, team, slot) {
    if (!dest || !team) return;
    const field = slot === "away" ? "awayTeam" : "homeTeam";
    batch.update(doc(db, "games", dest.id), { [field]: team });
    dest[field] = team; // optimistic in-memory update
    const destNum = (dest.notes || "").match(/Game\s+(\d+)/i)?.[1] || "?";
    changes.push(`${bracket} Game ${destNum} ${slot === "away" ? "Away" : "Home"}: ${team}`);
    updated++;
  }

  if (winner && rule.winner?.game) {
    scheduleUpdate(findByNum(rule.winner.game), winner, rule.winner.slot);
  }
  if (loser && rule.loser?.game) {
    scheduleUpdate(findByNum(rule.loser.game), loser, rule.loser.slot);
  }
  // Championship "if necessary" — same teams play again
  if (rule.loser?.game && !rule.winner && rule.loser) {
    // G14/G16 scenario: loser slot means "if necessary" game gets same teams
    const ifNecGame = findByNum(rule.loser.game);
    if (ifNecGame) {
      batch.update(doc(db, "games", ifNecGame.id), {
        homeTeam: g.homeTeam || "", awayTeam: g.awayTeam || ""
      });
      ifNecGame.homeTeam = g.homeTeam || "";
      ifNecGame.awayTeam = g.awayTeam || "";
      changes.push(`${bracket} Game ${rule.loser.game} (if nec): ${g.homeTeam} vs ${g.awayTeam}`);
      updated++;
    }
  }

  if (updated > 0) {
    await batch.commit();
    showToast(`Bracket advanced: ${changes.join(" · ")}`);
    renderGameRows();
  }
}

// ── Claim slot ────────────────────────────────────────────────────────────────

async function claimSlot(gameId, slotType) {
  const user    = getCurrentUser();
  const profile = getCurrentProfile();
  if (!user || !profile) return;

  const msgEl  = document.getElementById("signupMessage");
  const btn    = document.getElementById("confirmSignupBtn");
  btn.disabled = true;
  msgEl.textContent = "Saving…";
  msgEl.className   = "signup-message info";

  try {
    const gameRef = doc(db, "games", gameId);
    let updatedSlots;

    await runTransaction(db, async tx => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game not found.");
      const data = snap.data();
      if (data.cancelled) throw new Error("This game has been cancelled.");

      const slots = data.umpireSlots || [];
      if (slots.some(s => s.assignedUid === user.uid)) throw new Error("You're already signed up for this game.");
      const slotIdx = slots.findIndex(s => s.type === slotType && !s.assignedUid);
      if (slotIdx === -1) throw new Error(`The ${slotType} slot was just claimed by someone else. Please refresh.`);

      updatedSlots = slots.map((s, i) =>
        i === slotIdx ? { ...s, assignedUid: user.uid, assignedName: profile.name } : s
      );
      const allFilled = updatedSlots.every(s => s.assignedUid);
      tx.update(gameRef, { umpireSlots: updatedSlots, needsUmpires: !allFilled });
    });

    const g = games.find(g => g.id === gameId);
    if (g) g.umpireSlots = updatedSlots;

    msgEl.textContent = "You're signed up!";
    msgEl.className   = "signup-message success";
    renderGameRows();

    // EmailJS notification — best-effort
    if (typeof emailjs !== "undefined") {
      const game = games.find(g => g.id === gameId);
      emailjs.send("service_vljauqe", "template_game_signup", {
        umpire_name:  profile.name,
        umpire_email: profile.email,
        game_date:    fmtDate(game?.date),
        game_time:    game?.time || "",
        game_city:    game?.city || "",
        game_field:   game?.field || "",
        game_type:    slotType,
        pay_rate:     game?.payRate ? `$${game.payRate}` : "TBD"
      }).catch(() => {});
    }

    setTimeout(closeModal, 1800);
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className   = "signup-message error";
    btn.disabled      = false;
    await loadGames();
  }
}

// ── Cancel slot (request-based) ───────────────────────────────────────────────

async function cancelSlot(gameId, slotType) {
  const user    = getCurrentUser();
  const profile = getCurrentProfile();
  if (!user || !profile) return;

  const key  = `${gameId}|${slotType}`;
  const game = games.find(g => g.id === gameId);
  if (!game) return;

  if (pendingCancels[key]) {
    showToast("You already have a pending cancellation request for this slot.");
    return;
  }

  // Determine whether this is a self-service cancel or requires admin approval
  const isLate = (() => {
    if (_lateCancelHours <= 0) return true; // always require approval
    try {
      const [y, mo, d]  = (game.date || "").split("-").map(Number);
      const [h, m]      = (game.time || "00:00").split(":").map(Number);
      const gameMs      = new Date(y, mo - 1, d, h, m).getTime();
      const windowMs    = _lateCancelHours * 60 * 60 * 1000;
      return (gameMs - Date.now()) < windowMs;
    } catch { return true; }
  })();

  if (isLate) {
    // Within the late-cancel window — route through admin approval
    if (!await showConfirm(`Request to cancel your ${slotType} signup? An admin must approve before you are removed.`)) return;
    try {
      const ref = await addDoc(collection(db, "cancellationRequests"), {
        gameId,
        slotType,
        uid:          user.uid,
        name:         profile.name || user.email,
        gameDate:     game.date     || "",
        gameTime:     game.time     || "",
        gameCity:     game.city     || "",
        gameDivision: game.division || "",
        gameField:    game.field    || "",
        status:       "pending",
        requestedAt:  serverTimestamp()
      });
      pendingCancels[key] = ref.id;
      renderGameRows();
    } catch (err) {
      showToast("Failed to submit cancellation request: " + err.message);
    }
  } else {
    // Outside the window — self-service cancel
    if (!await showConfirm(`Cancel your ${slotType} signup for this game? This cannot be undone.`)) return;
    try {
      const gameRef = doc(db, "games", gameId);
      let updatedSlots;
      await runTransaction(db, async tx => {
        const snap = await tx.get(gameRef);
        if (!snap.exists()) throw new Error("Game not found.");
        updatedSlots = (snap.data().umpireSlots || []).map(s =>
          s.type === slotType && s.assignedUid === user.uid
            ? { type: s.type, payRate: s.payRate ?? null }   // strip assignment fields
            : s
        );
        const needsUmpires = updatedSlots.some(s => !s.assignedUid);
        tx.update(gameRef, { umpireSlots: updatedSlots, needsUmpires });
      });
      // Update local state
      const g = games.find(x => x.id === gameId);
      if (g) { g.umpireSlots = updatedSlots; g.needsUmpires = updatedSlots.some(s => !s.assignedUid); }
      renderGameRows();
    } catch (err) {
      showToast("Failed to cancel signup: " + err.message);
    }
  }
}

// ── Withdraw cancellation request ─────────────────────────────────────────────

async function withdrawCancellation(gameId, slotType) {
  const key = `${gameId}|${slotType}`;
  const requestId = pendingCancels[key];
  if (!requestId) return;
  if (!await showConfirm("Withdraw your cancellation request? You will remain assigned to this game.")) return;

  try {
    await updateDoc(doc(db, "cancellationRequests", requestId), { status: "withdrawn" });
    delete pendingCancels[key];
    renderGameRows();
  } catch (err) {
    showToast("Failed to withdraw: " + err.message);
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.addEventListener("click", e => {
  const signupBtn = e.target.closest(".signup-btn");
  if (signupBtn) {
    if (!isLoggedIn() || !isApproved()) { window.location.href = "index.html"; return; }
    openModal(signupBtn.dataset.gameId, signupBtn.dataset.slotType);
    return;
  }

  const contactBtn = e.target.closest(".contact-coordinator-btn");
  if (contactBtn) {
    const coordName  = _orgSettings?.coordinatorName  || "the umpire coordinator";
    const coordPhone = _orgSettings?.coordinatorPhone || "";
    const coordEmail = _orgSettings?.coordinatorEmail || "";
    const contact = [coordPhone, coordEmail].filter(Boolean).join(" / ");
    showToast(
      `To cancel a game assignment, contact ${coordName}${contact ? " — " + contact : ""}.`,
      "info",
      7000
    );
    return;
  }

  const scoreEntryBtn = e.target.closest(".score-entry-btn");
  if (scoreEntryBtn) { openScoreEntry(scoreEntryBtn.dataset.gameId); return; }

  const viewModeBtn = e.target.closest(".view-mode-btn");
  if (viewModeBtn) {
    viewMode = viewModeBtn.dataset.mode;
    document.querySelectorAll(".view-mode-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.mode === viewMode)
    );
    // Hide city filter — not relevant for tournament view
    const cityWrap = document.getElementById("cityFilter")?.closest("div");
    if (cityWrap) cityWrap.style.display = viewMode === "tournament" ? "none" : "";
    renderGameRows();
    return;
  }

  const filterBtn = e.target.closest(".filter-btn");
  if (filterBtn) {
    statusFilter = filterBtn.dataset.filter;
    document.querySelectorAll(".filter-btn").forEach(b =>
      b.classList.toggle("filter-active", b.dataset.filter === statusFilter)
    );
    renderGameRows();
    return;
  }

  const dateBtn = e.target.closest(".date-filter-btn");
  if (dateBtn) {
    dateFilter = dateBtn.dataset.date;
    document.querySelectorAll(".date-filter-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.date === dateFilter)
    );
    const customRow = document.getElementById("customDateRow");
    if (customRow) customRow.style.display = dateFilter === "custom" ? "flex" : "none";
    renderGameRows();
    return;
  }

  const checkInBtn = e.target.closest(".check-in-btn");
  if (checkInBtn && !checkInBtn.disabled) {
    checkIn(checkInBtn.dataset.gameId, checkInBtn.dataset.slotType);
    return;
  }

  const adminCheckInBtn = e.target.closest(".admin-checkin-btn");
  if (adminCheckInBtn && !adminCheckInBtn.disabled) {
    checkIn(adminCheckInBtn.dataset.gameId, adminCheckInBtn.dataset.slotType, adminCheckInBtn.dataset.targetUid);
    return;
  }

  const adminAssignBtn = e.target.closest(".admin-assign-self-btn");
  if (adminAssignBtn && !adminAssignBtn.disabled) {
    adminAssignSelf(adminAssignBtn.dataset.gameId, adminAssignBtn.dataset.slotType);
    return;
  }

  const adminUnassignBtn = e.target.closest(".admin-unassign-btn");
  if (adminUnassignBtn && !adminUnassignBtn.disabled) {
    adminUnassignSlot(adminUnassignBtn.dataset.gameId, adminUnassignBtn.dataset.slotType, adminUnassignBtn.dataset.targetUid);
    return;
  }

  const adminNoShowBtn = e.target.closest(".admin-noshow-btn");
  if (adminNoShowBtn && !adminNoShowBtn.disabled) {
    adminNoShow(adminNoShowBtn.dataset.gameId, adminNoShowBtn.dataset.slotType, adminNoShowBtn.dataset.targetUid);
    return;
  }

  const adminCancelBtn = e.target.closest(".admin-cancel-game-btn");
  if (adminCancelBtn && !adminCancelBtn.disabled) {
    adminCancelGame(adminCancelBtn.dataset.gameId);
    return;
  }

  const partnerBtn = e.target.closest(".partner-btn");
  if (partnerBtn) {
    showPartnerInfo(partnerBtn.dataset.uid, partnerBtn.dataset.name, partnerBtn);
    return;
  }
});

document.getElementById("confirmSignupBtn").addEventListener("click", () => {
  if (pendingGameId && pendingSlotType) claimSlot(pendingGameId, pendingSlotType);
});

document.getElementById("confirmScoreBtn")?.addEventListener("click", saveScore);
document.getElementById("cancelScoreBtn")?.addEventListener("click", closeScoreModal);

// ── Secondary filter change listeners ────────────────────────────────────────

document.getElementById("cityFilter")?.addEventListener("change", function () {
  cityFilter = this.value;
  renderGameRows();
});

document.getElementById("umpireFilterSel")?.addEventListener("change", function () {
  umpireFilter = this.value;
  renderGameRows();
});

document.getElementById("dateFrom")?.addEventListener("change", function () {
  dateFrom = this.value;
  if (dateFilter !== "custom") {
    dateFilter = "custom";
    document.querySelectorAll(".date-filter-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.date === "custom")
    );
    const customRow = document.getElementById("customDateRow");
    if (customRow) customRow.style.display = "flex";
  }
  renderGameRows();
});

document.getElementById("dateTo")?.addEventListener("change", function () {
  dateTo = this.value;
  if (dateFilter !== "custom") {
    dateFilter = "custom";
    document.querySelectorAll(".date-filter-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.date === "custom")
    );
    const customRow = document.getElementById("customDateRow");
    if (customRow) customRow.style.display = "flex";
  }
  renderGameRows();
});

document.getElementById("cancelSignupBtn").addEventListener("click", closeModal);

// ── Calendar bar ──────────────────────────────────────────────────────────────

const BASE_URL = "https://tri-valley-baseball-umpires.web.app";

function initCalendarBar() {
  // Export currently visible games (respects active filter)
  document.getElementById("calExportBtn")?.addEventListener("click", () => {
    const visible = games.filter(g => getSlots(g).length > 0).filter(gameMatchesFilter);
    downloadIcs(visible, "tri-valley-schedule.ics", "Tri-Valley Baseball Schedule");
  });

  // Copy subscribe URL (all games endpoint)
  document.getElementById("calCopyLinkBtn")?.addEventListener("click", () => {
    navigator.clipboard.writeText(`${BASE_URL}/ics/games`).then(() => {
      const msg = document.getElementById("calCopyMsg");
      msg.style.display = ""; setTimeout(() => msg.style.display = "none", 2000);
    });
  });
}

async function initUmpireCalendar(uid) {
  const sec = document.getElementById("calUmpireSection");
  if (!sec || !uid) return;
  sec.style.display = "flex";

  async function getOrCreateToken() {
    const snap = await getDoc(doc(db, "umpires", uid));
    let token = snap.data()?.calendarToken;
    if (!token) {
      token = crypto.randomUUID();
      await updateDoc(doc(db, "umpires", uid), { calendarToken: token });
    }
    return token;
  }

  document.getElementById("calMyExportBtn")?.addEventListener("click", () => {
    const myGames = games.filter(g =>
      (g.umpireSlots || []).some(s => s.assignedUid === uid)
    );
    downloadIcs(myGames, "my-games.ics", "My Umpire Schedule");
  });

  document.getElementById("calMyCopyBtn")?.addEventListener("click", async () => {
    const token = await getOrCreateToken();
    const url   = `${BASE_URL}/ics/umpire?token=${token}`;
    navigator.clipboard.writeText(url).then(() => {
      const msg = document.getElementById("calMyCopyMsg");
      msg.style.display = ""; setTimeout(() => msg.style.display = "none", 2000);
    });
  });

  document.getElementById("calMyResetBtn")?.addEventListener("click", async () => {
    if (!await showConfirm("This will invalidate your current subscription URL. Any calendar apps using the old URL will stop updating. Generate a new URL?")) return;
    const token = crypto.randomUUID();
    await updateDoc(doc(db, "umpires", uid), { calendarToken: token });
    const url = `${BASE_URL}/ics/umpire?token=${token}`;
    navigator.clipboard.writeText(url);
    showToast("New URL generated and copied to clipboard.");
  });
}

// ── Swipe left/right on date filter bar to cycle filters ─────────────────────
// Ordered list — "custom" is intentionally excluded (it opens a date picker).
const DATE_FILTER_ORDER = ["today", "week", "month", "upcoming", "past", "all"];

function applyDateFilter(val) {
  dateFilter = val;
  document.querySelectorAll(".date-filter-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.date === val)
  );
  const customRow = document.getElementById("customDateRow");
  if (customRow) customRow.style.display = "none";
  renderGameRows();
}

(function wireFilterBarSwipe() {
  const bar = document.getElementById("dateFilterBar");
  if (!bar) return;

  const SWIPE_MIN_X  = 40;  // px horizontal travel needed
  const SWIPE_MAX_Y  = 30;  // px vertical travel before we give up
  let sfStartX = null, sfStartY = null;

  bar.addEventListener("touchstart", e => {
    sfStartX = e.touches[0].clientX;
    sfStartY = e.touches[0].clientY;
  }, { passive: true });

  bar.addEventListener("touchend", e => {
    if (sfStartX === null) return;
    const dx = e.changedTouches[0].clientX - sfStartX;
    const dy = Math.abs(e.changedTouches[0].clientY - sfStartY);
    sfStartX = sfStartY = null;

    if (Math.abs(dx) < SWIPE_MIN_X || dy > SWIPE_MAX_Y) return;

    const cur = DATE_FILTER_ORDER.indexOf(dateFilter);
    const base = cur === -1 ? 0 : cur;
    // Swipe left → next filter (forward in time); swipe right → previous
    const next = dx < 0
      ? Math.min(base + 1, DATE_FILTER_ORDER.length - 1)
      : Math.max(base - 1, 0);
    if (next !== base) applyDateFilter(DATE_FILTER_ORDER[next]);
  }, { passive: true });

  bar.addEventListener("touchcancel", () => { sfStartX = sfStartY = null; }, { passive: true });
})();

// ── Init ──────────────────────────────────────────────────────────────────────

// Load lateCancelHours from scheduling config
getDoc(doc(db, "config", "scheduling")).then(snap => {
  if (snap.exists()) _lateCancelHours = snap.data().lateCancelHours ?? 4;
}).catch(() => {});

function checkProfileCompleteness() {
  const profile = getCurrentProfile();
  if (!isApproved() || !profile) return;
  const missing = [];
  if (!profile.phone) missing.push("phone number");
  if (!profile.emergencyContactName && !profile.emergencyContactPhone) missing.push("emergency contact");
  const banner = document.getElementById("profileWarningBanner");
  if (!banner) return;
  if (!missing.length) { banner.style.display = "none"; return; }
  banner.style.display = "";
  banner.innerHTML = `
    <div class="document-note" style="border-left-color:#f5a623;margin-bottom:16px">
      <p style="margin:0;font-size:0.9rem">
        📋 <strong>Your profile is incomplete</strong> — missing: ${missing.join(" and ")}.
        Tap <strong>☰ → Edit Profile</strong> to update so coordinators and co-umpires can reach you in an emergency.
      </p>
    </div>`;
}

authReadyPromise.then(() => {
  _authReady = true;
  const myGamesBtn = document.getElementById("myGamesBtn");
  if (myGamesBtn) myGamesBtn.style.display = isLoggedIn() ? "" : "none";
  initCalendarBar();
  if (isApproved()) {
    const uid = getCurrentUser()?.uid;
    if (uid) initUmpireCalendar(uid);
    checkProfileCompleteness();
  }
  loadTeamCalendars();
  loadGames();
});

// Re-render buttons whenever auth role changes (sign in / sign out).
// Skip re-renders on silent token refreshes that don't affect role or approval.
// _authReady gates the raw listener so it doesn't fire before authReadyPromise resolves.
let _authReady   = false;
let _lastAuthKey = null;
onAuthStateChanged(auth, () => {
  if (!_authReady) return; // wait for authReadyPromise — roles not reliable yet
  const myGamesBtn = document.getElementById("myGamesBtn");
  if (myGamesBtn) myGamesBtn.style.display = isLoggedIn() ? "" : "none";
  const authKey = `${isAdmin()}:${isApproved()}:${isLoggedIn()}`;
  if (games.length > 0 && authKey !== _lastAuthKey) {
    _lastAuthKey = authKey;
    renderGameRows();
  }
});
