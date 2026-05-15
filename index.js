// index.js — agenda panel: today's games for all; this week's assigned games for signed-in umpires

// ── Season year ───────────────────────────────────────────────────────────────
const SEASON_YEAR = new Date().getFullYear();
document.querySelectorAll("#seasonYear, .season-year").forEach(el => {
  el.textContent = SEASON_YEAR;
});
// Title updated by org.js once org settings load; set a safe default now
document.title = `Tri-Valley Baseball Umpires - ${SEASON_YEAR}`;
import { db, auth } from "./firebase.js";
import { getOrgSettings } from "./org.js";
import { esc, fmtDate, fmtTime, todayISO } from "./utils.js";

// Refresh title with org name once settings resolve
getOrgSettings().then(s => {
  document.title = `${s.orgName} - ${SEASON_YEAR}`;
});
import {
  isApproved,
  isAdmin
} from "./auth.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  collection,
  getDocs,
  query,
  orderBy,
  where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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
    const slots = g.umpireSlots ?? [];
    const dateLabel = g.date === today ? "Today" : fmtDate(g.date);
    const teams = (g.homeTeam && g.awayTeam)
      ? (g.isAway ? `${g.awayTeam} @ ${g.homeTeam}` : `${g.homeTeam} vs ${g.awayTeam}`)
      : (g.homeTeam || g.awayTeam || "");
    const accent = uid && slots.some(s => s.assignedUid === uid) ? "#b8f2c4" : "var(--accent)";

    const slotRows = slots.map(s => {
      const cls = s.type === "Plate" ? "plate" : s.type === "Field" ? "field" : "extra";
      const badge = `<span class="badge badge-${cls}">${s.type}</span>`;
      // Never expose umpire names or pay rates to guests / unapproved viewers
      if (!approved) {
        const status = s.assignedUid
          ? `<span style="color:#b8f2c4;font-size:0.85rem">Assigned</span>`
          : `<span style="color:#ffcc80;font-size:0.82rem">Open</span>`;
        return `<div>${badge} ${status}</div>`;
      }
      const pay = s.payRate != null ? ` <span style="color:var(--light-text);font-size:0.75rem">$${Number(s.payRate).toFixed(0)}</span>` : "";
      const isMe = uid && s.assignedUid === uid;
      if (s.assignedName) {
        return `<div>${badge} ${isMe ? `<strong style="color:#b8f2c4">${s.assignedName} (you)</strong>` : s.assignedName}${pay}</div>`;
      }
      return `<div>${badge} <span style="color:#ffcc80;font-size:0.82rem">Open</span></div>`;
    }).join("");

    return `<div style="border-left:3px solid ${accent};padding:8px 0 8px 10px;margin-bottom:10px">
      <div style="font-size:0.78rem;color:var(--light-text)">${dateLabel}${g.time ? " · " + fmtTime(g.time) : ""}</div>
      <div style="font-weight:bold;color:white;font-size:0.9rem">${g.city ?? ""} ${g.division ?? ""}</div>
      ${teams ? `<div style="font-size:0.82rem;color:var(--light-text)">${g.isAway ? '<span style="font-size:0.7rem;background:#2a1a3a;color:#c9a0ff;border:1px solid #6b3fa0;border-radius:4px;padding:1px 5px;margin-right:4px">AWAY</span>' : ""}${teams}</div>` : ""}
      ${g.field ? `<div style="font-size:0.8rem;color:var(--light-text)">${g.field}</div>` : ""}
      <div style="margin-top:5px;font-size:0.85rem">${slotRows || '<span style="color:var(--light-text);font-size:0.82rem">No umpire slots</span>'}</div>
    </div>`;
  }).join("");
}

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

  try {
    let games = [];

    if (uid && admin) {
      // Admins: today's HOME games with at least one open slot
      // Query all today's games (no needsUmpires filter — avoids missing fully-assigned games)
      if (titleEl) titleEl.textContent = "Today's Home Games";
      const snap = await getDocs(
        query(collection(db, "games"),
          where("date", "==", today),
          orderBy("time"))
      );
      snap.forEach(d => {
        const g = { id: d.id, ...d.data() };
        if (g.cancelled) return;
        if (g.isAway) return;                                        // home games only
        const slots = g.umpireSlots ?? [];
        if (slots.length === 0) return;                              // must have slots configured
        if (!slots.some(s => !s.assignedUid)) return;               // at least one open slot
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

    renderAgenda(games, uid, approved || admin);
  } catch (err) {
    console.error(err);
    if (listEl) listEl.textContent = "Unable to load games.";
  }
}

onAuthStateChanged(auth, user => {
  loadAgenda(user);
  if (user) loadAnnouncements();
});
