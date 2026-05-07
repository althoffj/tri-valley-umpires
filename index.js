// index.js — agenda panel: today's games for all; this week's assigned games for signed-in umpires
import { db, auth } from "./firebase.js";
import {
  isApproved
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
    banner.innerHTML = active.map(d => {
      const a = d.data();
      return `<div class="document-note" style="border-left-color:#7ec8f7;margin-bottom:12px">
        <strong style="color:white;display:block;margin-bottom:4px">${a.title ?? ""}</strong>
        <p style="margin:0;white-space:pre-wrap">${a.body ?? ""}</p>
      </div>`;
    }).join("");
  } catch (_) {
    banner.style.display = "none";
  }
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function weekEndISO() {
  const d = new Date();
  d.setDate(d.getDate() + 6);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,"0")} ${h >= 12 ? "PM" : "AM"}`;
}

function fmtDate(iso) {
  if (!iso) return "";
  const [y, mo, d] = iso.split("-");
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const dt = new Date(Number(y), Number(mo)-1, Number(d));
  return `${days[dt.getDay()]} ${mo}/${d}`;
}

function renderAgenda(games, uid, approved) {
  const listEl  = document.getElementById("agendaList");
  const titleEl = document.getElementById("agendaTitle");
  if (!listEl) return;

  const today = todayISO();
  titleEl.textContent = (uid && approved) ? "Your Games This Week" : "Today's Games";

  if (!games.length) {
    listEl.innerHTML = `<p style="color:var(--light-text);margin:0">${uid && approved ? "No games assigned to you this week." : "No games scheduled for today."}</p>`;
    return;
  }

  listEl.innerHTML = games.map(g => {
    const slots = g.umpireSlots ?? [];
    const dateLabel = g.date === today ? "Today" : fmtDate(g.date);
    const teams = [g.homeTeam, g.awayTeam].filter(Boolean).join(" vs ");
    const accent = uid && slots.some(s => s.assignedUid === uid) ? "#b8f2c4" : "var(--accent)";

    const slotRows = slots.map(s => {
      const cls = s.type === "Plate" ? "plate" : s.type === "Field" ? "field" : "extra";
      const badge = `<span class="badge badge-${cls}">${s.type}</span>`;
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
      ${teams ? `<div style="font-size:0.82rem;color:var(--light-text)">${teams}</div>` : ""}
      ${g.field ? `<div style="font-size:0.8rem;color:var(--light-text)">${g.field}</div>` : ""}
      <div style="margin-top:5px;font-size:0.85rem">${slotRows || '<span style="color:var(--light-text);font-size:0.82rem">No umpire slots</span>'}</div>
    </div>`;
  }).join("");
}

async function loadAgenda(user) {
  const listEl = document.getElementById("agendaList");
  if (!listEl) return;
  listEl.textContent = "Loading…";

  const today    = todayISO();
  const weekEnd  = weekEndISO();
  const uid      = user?.uid ?? null;
  const approved = isApproved();

  try {
    let games = [];

    if (uid && approved) {
      // Show all games this week; highlight ones where user is assigned
      const snap = await getDocs(
        query(collection(db, "games"),
          where("needsUmpires", "==", true),
          where("date", ">=", today),
          where("date", "<=", weekEnd),
          orderBy("date"), orderBy("time"))
      );
      snap.forEach(d => {
        const g = { id: d.id, ...d.data() };
        const slots = g.umpireSlots ?? [];
        if (slots.some(s => s.assignedUid === uid) || g.date === today) {
          games.push(g);
        }
      });
    } else {
      // Guest / pending: today's games only
      const snap = await getDocs(
        query(collection(db, "games"),
          where("needsUmpires", "==", true),
          where("date", "==", today),
          orderBy("time"))
      );
      snap.forEach(d => games.push({ id: d.id, ...d.data() }));
    }

    renderAgenda(games, uid, approved);
  } catch (err) {
    console.error(err);
    if (listEl) listEl.textContent = "Unable to load games.";
  }
}

onAuthStateChanged(auth, user => {
  loadAgenda(user);
  if (user) loadAnnouncements();
});
