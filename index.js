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
import { esc, fmtTime, todayISO, showToast } from "./utils.js";

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

// ── Facility / shed-code cache ────────────────────────────────────────────────
let _facilitiesCache = null;
let _shedCodesCache  = null;

async function getFacilities() {
  if (_facilitiesCache) return _facilitiesCache;
  try {
    const snap = await getDocs(collection(db, "facilities"));
    _facilitiesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (_) { _facilitiesCache = []; }
  return _facilitiesCache;
}

async function getShedCodes() {
  if (_shedCodesCache) return _shedCodesCache;
  try {
    const snap = await getDocs(collection(db, "facilityCodes"));
    _shedCodesCache = {};
    snap.docs.forEach(d => { _shedCodesCache[d.id] = d.data().shedCode || ""; });
  } catch (_) { return {}; } // don't cache on error — retry next call
  return _shedCodesCache;
}

function matchFacility(facilities, cityName) {
  if (!cityName || !facilities.length) return null;
  const words = cityName.split(/\s+/).filter(w => w.length > 3);
  return facilities.find(f =>
    words.some(w => f.name?.toLowerCase().includes(w.toLowerCase()))
  ) || null;
}

// ── Shed code dialog ──────────────────────────────────────────────────────────
function showShedCodeDialog(shedCode, facilityName, gameCity, gameNotes) {
  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed", "inset:0", "background:rgba(0,0,0,0.65)",
    "z-index:99998", "display:flex", "align-items:center", "justify-content:center",
    "padding:16px"
  ].join(";");

  const box = document.createElement("div");
  box.style.cssText = [
    "background:#1e1e2e", "color:#e8e8f0", "padding:32px 28px",
    "border-radius:14px", "max-width:380px", "width:100%",
    "box-shadow:0 8px 32px rgba(0,0,0,0.55)", "font-family:inherit",
    "text-align:center"
  ].join(";");

  const title = document.createElement("p");
  title.style.cssText = "margin:0 0 6px;font-size:1rem;color:var(--light-text,#aaa)";
  title.textContent = "✓ Checked In";

  const loc = document.createElement("p");
  loc.style.cssText = "margin:0 0 20px;font-size:0.9rem;color:var(--light-text,#aaa)";
  loc.textContent = facilityName || gameCity || "";

  const label = document.createElement("p");
  label.style.cssText = "margin:0 0 8px;font-size:0.85rem;color:var(--light-text,#aaa);letter-spacing:0.04em;text-transform:uppercase";
  label.textContent = "🔑 Shed Code";

  const codeEl = document.createElement("div");
  codeEl.style.cssText = [
    "font-size:2.4rem", "font-weight:700", "letter-spacing:0.12em",
    "color:#f0a500", "margin:0 0 28px",
    "padding:14px 20px", "background:rgba(240,165,0,0.1)",
    "border:2px solid rgba(240,165,0,0.35)", "border-radius:10px",
    "user-select:all"
  ].join(";");
  codeEl.textContent = shedCode;

  const dismissBtn = document.createElement("button");
  dismissBtn.textContent   = "Got It";
  dismissBtn.className     = "btn";
  dismissBtn.style.cssText = "width:100%;padding:10px;font-size:1rem";

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) { if (e.key === "Escape" || e.key === "Enter") close(); }
  dismissBtn.addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);

  const children = [title];
  if (loc.textContent) children.push(loc);
  children.push(label, codeEl);

  if (gameNotes) {
    const notesEl = document.createElement("div");
    notesEl.style.cssText = [
      "text-align:left", "background:rgba(255,255,255,0.05)",
      "border:1px solid #444", "border-radius:8px",
      "padding:12px 14px", "margin:0 0 20px",
      "font-size:0.88rem", "color:#e8e8f0", "white-space:pre-wrap", "word-break:break-word"
    ].join(";");
    const notesLabel = document.createElement("div");
    notesLabel.style.cssText = "font-size:0.75rem;color:var(--light-text,#aaa);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px";
    notesLabel.textContent = "📋 Game Notes";
    const notesText = document.createElement("div");
    notesText.textContent = gameNotes;
    notesEl.append(notesLabel, notesText);
    children.push(notesEl);
  }

  children.push(dismissBtn);
  box.append(...children);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  dismissBtn.focus();
}

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

function weekEndISO() {
  const d = new Date();
  d.setDate(d.getDate() + 6);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

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
