// index.js — agenda panel: today's games for all; this week's assigned games for signed-in umpires

// ── Season year ───────────────────────────────────────────────────────────────
const SEASON_YEAR = new Date().getFullYear();
document.querySelectorAll("#seasonYear, .season-year").forEach(el => {
  el.textContent = SEASON_YEAR;
});
// Title updated by org.js once org settings load; set a safe default now
document.title = `Tri-Valley Baseball Umpires - ${SEASON_YEAR}`;
import { db } from "./firebase.js";
import { getOrgSettings } from "./org.js";
import { esc, fmtTime, todayISO, weekEndISO, showToast } from "./utils.js";
import { getFacilities, getShedCodes, matchFacility, showShedCodeDialog } from "./facilities.js";

// Refresh title with org name once settings resolve
getOrgSettings().then(s => {
  document.title = `${s.orgName} - ${SEASON_YEAR}`;
});
import {
  isApproved,
  isAdmin,
  getCurrentUser,
  authReadyPromise,
} from "./auth.js";
import {
  collection,
  doc,
  getDocs,
  runTransaction,
  query,
  orderBy,
  where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Module-level state (needed so click handlers can re-render) ───────────────
let _games    = [];
let _uid      = null;
let _approved = false;

// ── Check-in ──────────────────────────────────────────────────────────────────
async function checkIn(gameId, slotType) {
  const user = getCurrentUser();
  if (!user) return;

  const btn = document.querySelector(
    `.agenda-checkin-btn[data-game-id="${gameId}"][data-slot-type="${slotType}"]`
  );
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }

  try {
    const gameRef = doc(db, "games", gameId);
    let updatedSlots;
    await runTransaction(db, async tx => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game not found.");
      updatedSlots = (snap.data().umpireSlots || []).map(s =>
        (s.type === slotType && s.assignedUid === user.uid)
          ? { ...s, checkedIn: true, checkedInAt: new Date().toISOString() }
          : s
      );
      tx.update(gameRef, { umpireSlots: updatedSlots });
    });

    // Update local cache and re-render
    const g = _games.find(g => g.id === gameId);
    if (g) g.umpireSlots = updatedSlots;
    renderAgenda(_games, _uid, _approved);

    // Show shed code dialog
    const [facilities, shedCodes] = await Promise.all([getFacilities(), getShedCodes()]);
    const game     = _games.find(g => g.id === gameId);
    const facility = game ? matchFacility(facilities, game.city) : null;
    const code     = facility ? (shedCodes[facility.id] || "") : "";
    if (code || game?.notes) showShedCodeDialog(code, facility?.name || "", game?.city || "", game?.notes || "");

  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "Check In"; }
    showToast(err.message);
  }
}

// ── Announcements ─────────────────────────────────────────────────────────────
async function loadAnnouncements() {
  const banner = document.getElementById("announcementBanner");
  if (!banner) return;
  try {
    const snap = await getDocs(
      query(collection(db, "announcements"), orderBy("createdAt", "desc"))
    );
    const active = snap.docs.filter(d => d.data().active);
    if (!active.length) { banner.style.display = "none"; return; }
    banner.style.display = "";
    banner.innerHTML = `<h2 style="margin-top:0">Messages &amp; Alerts</h2>` +
      active.map(d => {
        const a = d.data();
        return `<div class="document-note" style="border-left-color:#7ec8f7;margin-bottom:12px">
          <strong style="color:white;display:block;margin-bottom:4px">${esc(a.title)}</strong>
          <p style="margin:0;white-space:pre-wrap">${esc(a.body)}</p>
        </div>`;
      }).join("");
  } catch (_) {
    banner.style.display = "none";
  }
}

// fmtDate here intentionally uses "Dow M/D" format for the agenda view, not the M/D/YYYY
// used by utils.fmtDate. Both are in scope; this one shadows the import deliberately.
function fmtDate(iso) {
  if (!iso) return "";
  const [y, mo, d] = iso.split("-");
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const dt = new Date(Number(y), Number(mo)-1, Number(d));
  return `${days[dt.getDay()]} ${mo}/${d}`;
}

// ── Render agenda ─────────────────────────────────────────────────────────────
function renderAgenda(games, uid, approved) {
  const listEl = document.getElementById("agendaList");
  if (!listEl) return;

  const today = todayISO();

  if (!games.length) {
    const admin = isAdmin();
    const empty = admin
      ? "No home games with open slots today."
      : (uid && approved ? "No games assigned to you this week." : "No games scheduled for today.");
    listEl.innerHTML = `<p style="color:var(--light-text);margin:0">${empty}</p>`;
    return;
  }

  listEl.innerHTML = games.map(g => {
    const slots      = g.umpireSlots ?? [];
    const isToday    = g.date === today;
    const dateLabel  = isToday ? "Today" : fmtDate(g.date);
    const teams      = (g.homeTeam && g.awayTeam)
      ? (g.isAway ? `${g.awayTeam} @ ${g.homeTeam}` : `${g.homeTeam} vs ${g.awayTeam}`)
      : (g.homeTeam || g.awayTeam || "");
    const accent     = uid && slots.some(s => s.assignedUid === uid) ? "#b8f2c4" : "var(--accent)";

    const slotRows = slots.map(s => {
      const cls   = s.type === "Plate" ? "plate" : s.type === "Field" ? "field" : "extra";
      const badge = `<span class="badge badge-${cls}">${s.type}</span>`;

      // Never expose umpire names or pay rates to guests / unapproved viewers
      if (!approved) {
        const status = s.assignedUid
          ? `<span style="color:#b8f2c4;font-size:0.85rem">Assigned</span>`
          : `<span style="color:#ffcc80;font-size:0.82rem">Open</span>`;
        return `<div>${badge} ${status}</div>`;
      }

      const pay  = s.payRate != null ? ` <span style="color:var(--light-text);font-size:0.75rem">$${Number(s.payRate).toFixed(0)}</span>` : "";
      const isMe = uid && s.assignedUid === uid;

      // Check-in button: only on today's game, for my assigned slot, if not yet checked in
      let checkInBtn = "";
      if (isMe && isToday && !s.checkedIn) {
        checkInBtn = `<button class="btn print-btn agenda-checkin-btn"
          data-game-id="${esc(g.id)}" data-slot-type="${esc(s.type)}"
          style="font-size:0.75rem;padding:3px 10px;margin-left:8px">Check In</button>`;
      } else if (isMe && isToday && s.checkedIn) {
        checkInBtn = `<span style="color:#6ee7b7;font-size:0.8rem;margin-left:8px">✓ Checked In</span>`;
      }

      if (s.assignedName) {
        return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px">
          ${badge}
          ${isMe
            ? `<strong style="color:#b8f2c4">${esc(s.assignedName)} (you)</strong>`
            : esc(s.assignedName)}
          ${pay}${checkInBtn}
        </div>`;
      }
      return `<div>${badge} <span style="color:#ffcc80;font-size:0.82rem">Open</span></div>`;
    }).join("");

    return `<div style="border-left:3px solid ${accent};padding:8px 0 8px 10px;margin-bottom:10px">
      <div style="font-size:0.78rem;color:var(--light-text)">${dateLabel}${g.time ? " · " + fmtTime(g.time) : ""}</div>
      <div style="font-weight:bold;color:white;font-size:0.9rem">${esc(g.city ?? "")} ${esc(g.division ?? "")}</div>
      ${teams ? `<div style="font-size:0.82rem;color:var(--light-text)">${g.isAway ? '<span style="font-size:0.7rem;background:#2a1a3a;color:#c9a0ff;border:1px solid #6b3fa0;border-radius:4px;padding:1px 5px;margin-right:4px">AWAY</span>' : ""}${esc(teams)}</div>` : ""}
      ${g.field ? `<div style="font-size:0.8rem;color:var(--light-text)">${esc(g.field)}</div>` : ""}
      <div style="margin-top:5px;font-size:0.85rem">${slotRows || '<span style="color:var(--light-text);font-size:0.82rem">No umpire slots</span>'}</div>
    </div>`;
  }).join("");
}

// ── Load agenda ───────────────────────────────────────────────────────────────
async function loadAgenda(user) {
  const listEl  = document.getElementById("agendaList");
  const titleEl = document.getElementById("agendaTitle");
  if (!listEl) return;
  listEl.textContent = "Loading…";

  const today   = todayISO();
  const weekEnd = weekEndISO();
  const uid     = user?.uid ?? null;
  const admin   = isAdmin();
  const approved = isApproved();

  _uid      = uid;
  _approved = approved || admin;

  try {
    let games = [];

    if (uid && admin) {
      // Admins: all of today's games (home first, then away)
      if (titleEl) titleEl.textContent = "Today's Games";
      const snap = await getDocs(
        query(collection(db, "games"),
          where("date", "==", today))
      );
      snap.forEach(d => {
        const g = { id: d.id, ...d.data() };
        if (g.cancelled) return;
        games.push(g);
      });
    } else if (uid && approved) {
      // Approved umpires: their assigned games this week + all of today
      if (titleEl) titleEl.textContent = "Your Games This Week";
      const snap = await getDocs(
        query(collection(db, "games"),
          where("date", ">=", today),
          where("date", "<=", weekEnd),
          orderBy("date"), orderBy("time"))
      );
      snap.forEach(d => {
        const g = { id: d.id, ...d.data() };
        if (g.cancelled) return;
        const slots = g.umpireSlots ?? [];
        if (slots.some(s => s.assignedUid === uid) || g.date === today) {
          games.push(g);
        }
      });
    } else {
      // Guest / pending: today's games only
      if (titleEl) titleEl.textContent = "Today's Games";
      const snap = await getDocs(
        query(collection(db, "games"),
          where("needsUmpires", "==", true),
          where("date", "==", today),
          orderBy("time"))
      );
      snap.forEach(d => games.push({ id: d.id, ...d.data() }));
    }

    // Home games first, then away games; preserve date/time order within each group
    games.sort((a, b) => {
      const aAway = a.isAway ? 1 : 0;
      const bAway = b.isAway ? 1 : 0;
      if (aAway !== bAway) return aAway - bAway;
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.time || "") < (b.time || "") ? -1 : 1;
    });
    _games = games;
    renderAgenda(_games, _uid, _approved);
  } catch (err) {
    console.error(err);
    if (listEl) listEl.textContent = "Unable to load games.";
  }
}

// ── Click delegation for check-in buttons ────────────────────────────────────
document.getElementById("agendaList")?.addEventListener("click", e => {
  const btn = e.target.closest(".agenda-checkin-btn");
  if (btn && !btn.disabled) {
    checkIn(btn.dataset.gameId, btn.dataset.slotType);
  }
});

// ── Auth listener ─────────────────────────────────────────────────────────────
// Use authReadyPromise so isAdmin() / isApproved() are set before loadAgenda runs.
// auth.js does async Firestore lookups inside its own onAuthStateChanged handler;
// raw onAuthStateChanged here would fire before those lookups finish, so isAdmin()
// would return false and the widget would show the guest/umpire view instead.
authReadyPromise.then(() => {
  const user = getCurrentUser();
  loadAgenda(user);
  if (user) loadAnnouncements();
});
