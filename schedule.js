// schedule.js — Firestore-based schedule with multi-slot signups, badges, and pay tracking
import { db, auth } from "./firebase.js";
import {
  authReadyPromise,
  isLoggedIn,
  isApproved,
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
  runTransaction,
  updateDoc,
  doc,
  query,
  orderBy,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let games = [];
let activeFilter    = "all";
let pendingGameId   = null;
let pendingSlotType = null;

// Cache: team name → Set of ISO date strings with games
const teamGameDates = {};
let teamCalendars   = []; // [{name, icsUrl}]

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function gameDateStatus(dateISO) {
  const today = todayISO();
  if (dateISO < today)   return "past";
  if (dateISO === today) return "today";
  return "upcoming";
}

function fmtDate(dateISO) {
  if (!dateISO) return "—";
  const [y, m, d] = dateISO.split("-");
  return `${m}/${d}/${y}`;
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
  switch (activeFilter) {
    case "needs":  return !game.cancelled && openSlots(game).length > 0;
    case "filled": return !game.cancelled && allSlotsFilled(game);
    case "mine":   return mySlots(game).length > 0;
    default:       return true;
  }
}

// ── Pay summary ───────────────────────────────────────────────────────────────

function renderPaySummary() {
  const el = document.getElementById("paySummary");
  if (!el) return;
  if (activeFilter !== "mine") { el.style.display = "none"; return; }

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
  const active     = games.filter(g => !g.cancelled);
  const totalSlots = active.reduce((n, g) => n + getSlots(g).length, 0);
  const filledSlots = active.reduce((n, g) => n + getSlots(g).filter(s => s.assignedUid).length, 0);
  const openSlotCount = totalSlots - filledSlots;
  el.textContent = totalSlots === 0
    ? "No games loaded yet."
    : `${filledSlots} of ${totalSlots} slot${totalSlots !== 1 ? "s" : ""} filled — ${openSlotCount} still available`;
}

// ── Game Day bar ──────────────────────────────────────────────────────────────

let facilitiesCache = null;

async function getFacilities() {
  if (facilitiesCache) return facilitiesCache;
  try {
    const snap = await getDocs(collection(db, "facilities"));
    facilitiesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (_) { facilitiesCache = []; }
  return facilitiesCache;
}

function matchFacility(facilities, cityName) {
  if (!cityName || !facilities.length) return null;
  // Match on any word > 3 chars from the game city name against facility name
  const words = cityName.split(/\s+/).filter(w => w.length > 3);
  return facilities.find(f =>
    words.some(w => f.name?.toLowerCase().includes(w.toLowerCase()))
  ) || null;
}

async function checkIn(gameId, slotType) {
  const user = getCurrentUser();
  if (!user) return;
  const btn = document.querySelector(`.check-in-btn[data-game-id="${gameId}"][data-slot-type="${slotType}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    const gameRef = doc(db, "games", gameId);
    const snap    = await getDoc(gameRef);
    if (!snap.exists()) throw new Error("Game not found.");
    const slots = (snap.data().umpireSlots || []).map(s =>
      (s.type === slotType && s.assignedUid === user.uid)
        ? { ...s, checkedIn: true, checkedInAt: new Date().toISOString() }
        : s
    );
    await updateDoc(gameRef, { umpireSlots: slots });
    const g = games.find(g => g.id === gameId);
    if (g) g.umpireSlots = slots;
    if (btn) { btn.textContent = "✓ Checked In"; btn.className = "btn check-in-btn"; }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "Check In"; }
    alert(err.message);
  }
}

async function showPartnerInfo(uid, name, anchorBtn) {
  // Show inline below the button
  const existing = anchorBtn.parentElement.querySelector(".partner-info");
  if (existing) { existing.remove(); return; }
  try {
    const snap = await getDoc(doc(db, "umpires", uid));
    const phone = snap.exists() ? (snap.data().phone || "") : "";
    const info  = document.createElement("span");
    info.className   = "partner-info";
    info.style.cssText = "font-size:0.82rem;color:#ccc;padding:4px 10px;background:rgba(255,255,255,0.08);border-radius:6px;white-space:nowrap";
    info.textContent = phone ? `${name} · ${phone}` : name || "No info";
    anchorBtn.insertAdjacentElement("afterend", info);
  } catch {
    /* ignore */
  }
}

async function renderGameDayBar() {
  const bar = document.getElementById("gameDayBar");
  if (!bar) return;

  const uid = getCurrentUser()?.uid;
  if (!isLoggedIn() || !isApproved() || !uid) { bar.style.display = "none"; return; }

  const today      = todayISO();
  const todayGames = games.filter(g =>
    g.date === today && !g.cancelled && getSlots(g).some(s => s.assignedUid === uid)
  );

  if (todayGames.length === 0) { bar.style.display = "none"; return; }

  const facilities = await getFacilities();

  bar.style.display = "";
  bar.innerHTML = todayGames.map(game => {
    const mySlot      = getSlots(game).find(s => s.assignedUid === uid);
    const partnerSlot = getSlots(game).find(s => s.assignedUid && s.assignedUid !== uid);
    const facility    = matchFacility(facilities, game.city);
    const mapsUrl     = facility?.googleMapsUrl
      || `https://maps.google.com/?q=${encodeURIComponent(`${game.field || ""} ${game.city || ""}`)}`;
    const checkedIn   = mySlot?.checkedIn === true;
    const typeCls     = mySlot?.type === "Plate" ? "plate" : mySlot?.type === "Field" ? "field" : "extra";

    return `
    <div class="game-day-card" data-game-id="${esc(game.id)}">
      <div class="game-day-title">Game Day</div>
      <div class="game-day-info">
        <strong>${esc(game.city)}</strong>
        <span class="badge badge-${typeCls}">${esc(mySlot?.type || "")}</span>
        &mdash; ${esc(game.field || "")} &mdash; ${esc(game.time || "TBD")}
      </div>
      <div class="game-day-actions">
        <a href="${esc(mapsUrl)}" class="btn" target="_blank" rel="noopener">Directions</a>
        ${partnerSlot
          ? `<button class="btn print-btn partner-btn"
               data-uid="${esc(partnerSlot.assignedUid)}"
               data-name="${esc(partnerSlot.assignedName || "")}">Partner: ${esc(partnerSlot.assignedName || "?")}</button>`
          : `<button class="btn print-btn" disabled>No partner assigned</button>`
        }
        <a href="field-issues.html" class="btn print-btn">Report Issue</a>
        <button class="btn ${checkedIn ? "" : "print-btn"} check-in-btn"
          data-game-id="${esc(game.id)}" data-slot-type="${esc(mySlot?.type || "")}"
          ${checkedIn ? "disabled" : ""}>
          ${checkedIn ? "✓ Checked In" : "Check In"}
        </button>
      </div>
    </div>`;
  }).join("");
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
  return slots.map(s => {
    const cls = s.type === "Plate" ? "plate" : s.type === "Field" ? "field" : "extra";
    const badge = `<span class="badge badge-${cls}">${esc(s.type)}</span>`;
    if (s.assignedName) {
      const pay = s.payRate != null ? ` <span style="color:var(--light-text);font-size:0.78rem">$${Number(s.payRate).toFixed(0)}</span>` : "";
      return `<div style="margin-bottom:2px">${badge} ${esc(s.assignedName)}${pay}</div>`;
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
  const loggedIn = isLoggedIn() && isApproved();
  const alreadyOnGame = uid && slots.some(s => s.assignedUid === uid);

  return `<div style="display:flex;flex-direction:column;gap:4px">${slots.map(slot => {
    const label = esc(slot.type);
    if (slot.assignedUid === uid) {
      return `<button type="button" class="btn print-btn cancel-btn"
        data-game-id="${esc(game.id)}" data-slot-type="${esc(slot.type)}">
        Cancel — ${label} (you)</button>`;
    }
    if (slot.assignedUid) {
      return `<button type="button" class="btn locked-btn" disabled>${label}: ${esc(slot.assignedName || "Filled")}</button>`;
    }
    if (!loggedIn) {
      return `<a href="index.html" class="btn print-btn">Sign up: ${label}</a>`;
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

function renderGameRows() {
  document.querySelectorAll("[data-game-list]").forEach(tbody => {
    const city = tbody.dataset.city;
    const visible = games.filter(g => g.city === city && gameMatchesFilter(g));

    if (visible.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--light-text);padding:20px">No games match this filter.</td></tr>`;
      return;
    }

    tbody.innerHTML = visible.map(g => {
      const teams = (g.homeTeam && g.awayTeam)
        ? `${esc(g.homeTeam)} <span style="color:var(--light-text)">vs</span> ${esc(g.awayTeam)}`
        : "—";
      return `
      <tr>
        <td>${esc(fmtDate(g.date))} ${dateBadge(g)}</td>
        <td>${esc(g.time || "—")}</td>
        <td>${esc(g.division || "—")}</td>
        <td>${teams}</td>
        <td>${buildTypesCell(g)}</td>
        <td>${esc(g.field || "—")}</td>
        <td class="${buildStatusClass(g)}">${buildStatusCell(g)}</td>
        <td style="white-space:nowrap">${buildActionCell(g)}</td>
      </tr>`;
    }).join("");
  });

  renderCount();
  renderPaySummary();
  renderGameDayBar();
}

// ── Load from Firestore ───────────────────────────────────────────────────────

function showLoading() {
  document.querySelectorAll("[data-game-list]").forEach(tbody => {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--light-text);padding:30px">Loading schedule…</td></tr>`;
  });
}

async function loadGames() {
  showLoading();
  try {
    const q = query(
      collection(db, "games"),
      where("needsUmpires", "==", true),
      orderBy("date"),
      orderBy("time")
    );
    const snap = await getDocs(q);
    games = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderGameRows();
  } catch (err) {
    document.querySelectorAll("[data-game-list]").forEach(tbody => {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#ffb4b4;padding:20px">Failed to load schedule. Please refresh the page.</td></tr>`;
    });
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

function normalizeIcsUrl(url) {
  return url.replace(/^webcal:\/\//i, "https://");
}

async function fetchICS(rawUrl) {
  const url = normalizeIcsUrl(rawUrl);
  // Try direct fetch first; fall back to CORS proxy if blocked
  try {
    const res = await fetch(url, { mode: "cors" });
    if (res.ok) return await res.text();
  } catch (_) {}
  try {
    const proxy = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxy);
    if (res.ok) return await res.text();
  } catch (_) {}
  return null;
}

function parseICSdates(icsText) {
  const dates = new Set();
  const re = /DTSTART[^:]*:(\d{4})(\d{2})(\d{2})/g;
  let m;
  while ((m = re.exec(icsText)) !== null) {
    dates.add(`${m[1]}-${m[2]}-${m[3]}`);
  }
  return dates;
}

async function getTeamDatesForGame(gameDate) {
  const profile = getCurrentProfile();
  const teamsPlayed = profile?.teamsPlayed || [];
  if (!teamsPlayed.length || !teamCalendars.length) return [];

  const conflictingTeams = [];

  await Promise.all(teamsPlayed.map(async teamName => {
    const cal = teamCalendars.find(t => t.name === teamName);
    if (!cal) return;

    // Use cached dates if available
    if (!teamGameDates[teamName]) {
      const icsText = await fetchICS(cal.icsUrl);
      teamGameDates[teamName] = icsText ? parseICSdates(icsText) : new Set();
    }

    if (teamGameDates[teamName].has(gameDate)) {
      conflictingTeams.push(teamName);
    }
  }));

  return conflictingTeams;
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
    ? `${esc(game.homeTeam)} vs ${esc(game.awayTeam)}<br>` : "";
  document.getElementById("modalGameDetail").innerHTML =
    `<strong>${esc(game.city)}</strong> &mdash; ${esc(game.division)} ${typeBadge(slotType)}<br>
     ${teams}${esc(fmtDate(game.date))} at ${esc(game.time || "TBD")} &mdash; ${esc(game.field || "TBD")}<br>
     Pay rate: <strong>${pay}</strong>`;

  const msgEl = document.getElementById("signupMessage");
  msgEl.textContent = "";
  msgEl.className   = "signup-message";
  document.getElementById("signupModal").style.display = "";
  document.getElementById("confirmSignupBtn").disabled = false;

  // Conflict check — runs async after modal opens so it doesn't delay display
  if (isLoggedIn()) {
    const conflicts = await getTeamDatesForGame(game.date);
    if (conflicts.length > 0) {
      msgEl.textContent = `⚠️ Possible conflict — ${conflicts.join(", ")} may have a game on this date. Verify your availability before confirming.`;
      msgEl.className   = "signup-message warning";
    }
  }
}

function closeModal() {
  document.getElementById("signupModal").style.display = "none";
  pendingGameId   = null;
  pendingSlotType = null;
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
      tx.update(gameRef, { umpireSlots: updatedSlots });
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

// ── Cancel slot ───────────────────────────────────────────────────────────────

async function cancelSlot(gameId, slotType) {
  const user = getCurrentUser();
  if (!user) return;
  if (!confirm(`Cancel your ${slotType} signup for this game?`)) return;

  try {
    const gameRef = doc(db, "games", gameId);
    let updatedSlots;

    await runTransaction(db, async tx => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game not found.");
      const slots = snap.data().umpireSlots || [];
      const slotIdx = slots.findIndex(s => s.type === slotType && s.assignedUid === user.uid);
      if (slotIdx === -1) throw new Error("You are not signed up for this slot.");
      updatedSlots = slots.map((s, i) =>
        i === slotIdx ? { ...s, assignedUid: null, assignedName: null } : s
      );
      tx.update(gameRef, { umpireSlots: updatedSlots });
    });

    const g = games.find(g => g.id === gameId);
    if (g) g.umpireSlots = updatedSlots;
    renderGameRows();
  } catch (err) {
    alert(err.message);
    await loadGames();
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

  const cancelBtn = e.target.closest(".cancel-btn");
  if (cancelBtn) { cancelSlot(cancelBtn.dataset.gameId, cancelBtn.dataset.slotType); return; }

  const filterBtn = e.target.closest(".filter-btn");
  if (filterBtn) {
    activeFilter = filterBtn.dataset.filter;
    document.querySelectorAll(".filter-btn").forEach(b =>
      b.classList.toggle("filter-active", b.dataset.filter === activeFilter)
    );
    renderGameRows();
    return;
  }

  const checkInBtn = e.target.closest(".check-in-btn");
  if (checkInBtn && !checkInBtn.disabled) {
    checkIn(checkInBtn.dataset.gameId, checkInBtn.dataset.slotType);
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

document.getElementById("cancelSignupBtn").addEventListener("click", closeModal);

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  const myGamesBtn = document.getElementById("myGamesBtn");
  if (myGamesBtn) myGamesBtn.style.display = isLoggedIn() ? "" : "none";
  loadTeamCalendars();
  loadGames();
});

// Re-render buttons whenever auth state changes (sign in / sign out / token refresh)
// so signup buttons appear immediately without requiring a page reload.
onAuthStateChanged(auth, () => {
  const myGamesBtn = document.getElementById("myGamesBtn");
  if (myGamesBtn) myGamesBtn.style.display = isLoggedIn() ? "" : "none";
  if (games.length > 0) renderGameRows();
});
