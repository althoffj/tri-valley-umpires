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
    const mySlots = uid
      ? (g.umpireSlots ?? []).filter(s => s.assignedUid === uid)
      : [];
    const allAssigned = (g.umpireSlots ?? [])
      .filter(s => s.assignedUid)
      .map(s => `<span class="badge badge-${s.type.toLowerCase()}">${s.type}</span>`)
      .join(" ");
    const dateLabel = g.date === today ? "Today" : fmtDate(g.date);
    const teams = [g.homeTeam, g.awayTeam].filter(Boolean).join(" vs ");

    return `<div style="border-left:3px solid var(--accent);padding:8px 0 8px 10px;margin-bottom:10px">
      <div style="font-size:0.78rem;color:var(--light-text)">${dateLabel}${g.time ? " · " + fmtTime(g.time) : ""}</div>
      <div style="font-weight:bold;color:white;font-size:0.9rem">${g.city ?? ""} ${g.division ?? ""}</div>
      ${teams ? `<div style="font-size:0.82rem;color:var(--light-text)">${teams}</div>` : ""}
      ${g.field ? `<div style="font-size:0.8rem;color:var(--light-text)">${g.field}</div>` : ""}
      <div style="margin-top:4px">${allAssigned || '<span style="font-size:0.78rem;color:#ffcc80">Open slots</span>'}</div>
      ${mySlots.length ? `<div style="font-size:0.78rem;color:#b8f2c4;margin-top:2px">Your slot: ${mySlots.map(s=>s.type).join(", ")}</div>` : ""}
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

onAuthStateChanged(auth, user => loadAgenda(user));
