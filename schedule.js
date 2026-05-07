// schedule.js — Firestore-based schedule with signups, badges, and pay tracking
import { db } from "./firebase.js";
import {
  authReadyPromise,
  isLoggedIn,
  isApproved,
  getCurrentUser,
  getCurrentProfile
} from "./auth.js";
import {
  collection,
  getDocs,
  runTransaction,
  doc,
  query,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let games = [];
let activeFilter = "all";
let pendingGameId = null;

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

// ── Filtering ─────────────────────────────────────────────────────────────────

function gameMatchesFilter(game) {
  const uid = getCurrentUser()?.uid;
  switch (activeFilter) {
    case "needs": return !game.cancelled && !game.assignedUid;
    case "filled": return !game.cancelled && !!game.assignedUid;
    case "mine":  return game.assignedUid === uid;
    default:      return true;
  }
}

// ── Pay summary ───────────────────────────────────────────────────────────────

function renderPaySummary() {
  const el = document.getElementById("paySummary");
  if (!el) return;
  if (activeFilter !== "mine") { el.style.display = "none"; return; }

  const uid = getCurrentUser()?.uid;
  const mine = games.filter(g => g.assignedUid === uid);
  const total = mine.reduce((sum, g) => sum + (Number(g.payRate) || 0), 0);
  if (mine.length === 0) { el.style.display = "none"; return; }
  el.textContent = `${mine.length} game${mine.length !== 1 ? "s" : ""} — estimated pay: $${total.toFixed(2)}`;
  el.style.display = "";
}

// ── Count bar ─────────────────────────────────────────────────────────────────

function renderCount() {
  const el = document.getElementById("signupCount");
  if (!el) return;
  const active = games.filter(g => !g.cancelled);
  const filled = active.filter(g => g.assignedUid).length;
  const avail  = active.length - filled;
  el.textContent = active.length === 0
    ? "No games loaded yet."
    : `${filled} of ${active.length} games filled — ${avail} game${avail !== 1 ? "s" : ""} still available`;
}

// ── Row rendering ─────────────────────────────────────────────────────────────

function buildActionCell(game) {
  if (game.cancelled) return "—";
  if (gameDateStatus(game.date) === "past") {
    return '<span style="color:var(--light-text);font-size:0.85rem">Game over</span>';
  }

  const uid = getCurrentUser()?.uid;
  if (game.assignedUid) {
    if (game.assignedUid === uid) {
      return `<button type="button" class="btn print-btn cancel-btn" data-game-id="${esc(game.id)}">Cancel Signup</button>`;
    }
    return '<button type="button" class="btn locked-btn" disabled>Filled</button>';
  }

  if (!isLoggedIn() || !isApproved()) {
    return '<a href="index.html" class="btn print-btn">Log in to sign up</a>';
  }

  return `<button type="button" class="btn signup-btn" data-game-id="${esc(game.id)}">Sign up</button>`;
}

function buildStatusCell(game) {
  if (game.cancelled) return '<span style="color:#ffb4b4">Cancelled</span>';
  if (game.assignedUid) return `Filled — ${esc(game.assignedName || "Unknown")}`;
  return "Needs umpire";
}

function renderGameRows() {
  document.querySelectorAll("[data-game-list]").forEach(tbody => {
    const city = tbody.dataset.city;
    const visible = games.filter(g => g.city === city && gameMatchesFilter(g));

    if (visible.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--light-text);padding:20px">No games match this filter.</td></tr>`;
      return;
    }

    tbody.innerHTML = visible.map(g => `
      <tr>
        <td>${esc(fmtDate(g.date))} ${dateBadge(g)}</td>
        <td>${esc(g.time || "—")}</td>
        <td>${esc(g.division || "—")}</td>
        <td>${typeBadge(g.umpireType)}</td>
        <td>${esc(g.field || "—")}</td>
        <td class="${g.cancelled ? "" : g.assignedUid ? "status-filled" : "status-needs"}">${buildStatusCell(g)}</td>
        <td>${buildActionCell(g)}</td>
      </tr>`).join("");
  });

  renderCount();
  renderPaySummary();
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
    const q = query(collection(db, "games"), orderBy("date"), orderBy("time"));
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

// ── Signup modal ──────────────────────────────────────────────────────────────

function openModal(gameId) {
  const game = games.find(g => g.id === gameId);
  if (!game) return;
  pendingGameId = gameId;

  const pay = game.payRate ? `$${Number(game.payRate).toFixed(2)}` : "TBD";
  document.getElementById("modalGameDetail").innerHTML =
    `<strong>${esc(game.city)}</strong> &mdash; ${esc(game.division)} ${typeBadge(game.umpireType)}<br>
     ${esc(fmtDate(game.date))} at ${esc(game.time || "TBD")} &mdash; ${esc(game.field || "TBD")}<br>
     Pay rate: <strong>${pay}</strong>`;

  const msgEl = document.getElementById("signupMessage");
  msgEl.textContent = "";
  msgEl.className   = "signup-message";
  document.getElementById("signupModal").style.display = "";
  document.getElementById("confirmSignupBtn").disabled = false;
}

function closeModal() {
  document.getElementById("signupModal").style.display = "none";
  pendingGameId = null;
}

// ── Claim game ────────────────────────────────────────────────────────────────

async function claimGame(gameId) {
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
    await runTransaction(db, async tx => {
      const snap = await tx.get(gameRef);
      if (!snap.exists())   throw new Error("Game not found.");
      const data = snap.data();
      if (data.cancelled)   throw new Error("This game has been cancelled.");
      if (data.assignedUid) throw new Error("This game was just claimed by someone else. Please refresh.");
      tx.update(gameRef, {
        assignedUid:  user.uid,
        assignedName: profile.name,
        claimedAt:    serverTimestamp()
      });
    });

    const g = games.find(g => g.id === gameId);
    if (g) { g.assignedUid = user.uid; g.assignedName = profile.name; }

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
        game_type:    game?.umpireType || "",
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

// ── Cancel signup ─────────────────────────────────────────────────────────────

async function cancelSignup(gameId) {
  const user = getCurrentUser();
  if (!user) return;
  if (!confirm("Cancel your signup for this game?")) return;

  try {
    const gameRef = doc(db, "games", gameId);
    await runTransaction(db, async tx => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game not found.");
      const data = snap.data();
      if (data.assignedUid !== user.uid) throw new Error("You are not signed up for this game.");
      tx.update(gameRef, { assignedUid: null, assignedName: null, claimedAt: null });
    });
    const g = games.find(g => g.id === gameId);
    if (g) { g.assignedUid = null; g.assignedName = null; }
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
    openModal(signupBtn.dataset.gameId);
    return;
  }

  const cancelBtn = e.target.closest(".cancel-btn");
  if (cancelBtn) { cancelSignup(cancelBtn.dataset.gameId); return; }

  const filterBtn = e.target.closest(".filter-btn");
  if (filterBtn) {
    activeFilter = filterBtn.dataset.filter;
    document.querySelectorAll(".filter-btn").forEach(b =>
      b.classList.toggle("filter-active", b.dataset.filter === activeFilter)
    );
    renderGameRows();
  }
});

document.getElementById("confirmSignupBtn").addEventListener("click", () => {
  if (pendingGameId) claimGame(pendingGameId);
});

document.getElementById("cancelSignupBtn").addEventListener("click", closeModal);

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  const myGamesBtn = document.getElementById("myGamesBtn");
  if (myGamesBtn) myGamesBtn.style.display = isLoggedIn() ? "" : "none";
  loadGames();
});
