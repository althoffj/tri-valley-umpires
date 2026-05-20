// availability.js — Umpire unavailability calendar
import { db } from "./firebase.js";
import { authReadyPromise, isApproved, isCoach, getCurrentUser } from "./auth.js";
import { esc, todayISO, setMsg } from "./utils.js";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  query,
  where,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const DAYS   = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

let unavailableDates = new Set(); // ISO strings "YYYY-MM-DD"
// assigned games for the current uid: date → [{ slotType }]
let assignedByDate   = {};
let viewYear  = new Date().getFullYear();
let viewMonth = new Date().getMonth(); // 0-indexed
let dirty     = false;
let saveTimer = null;

function isoFromParts(y, m, d) {
  return `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
}

// ── Render calendar ───────────────────────────────────────────────────────────

function renderCalendar() {
  document.getElementById("monthLabel").textContent = `${MONTHS[viewMonth]} ${viewYear}`;

  const grid  = document.getElementById("calGrid");
  const today = todayISO();

  // Day-of-week headers
  let html = DAYS.map(d =>
    `<div class="avail-header">${d}</div>`
  ).join("");

  const firstDow  = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMon = new Date(viewYear, viewMonth + 1, 0).getDate();

  for (let i = 0; i < firstDow; i++) {
    html += `<div class="avail-day avail-day--filler"></div>`;
  }

  for (let d = 1; d <= daysInMon; d++) {
    const iso     = isoFromParts(viewYear, viewMonth, d);
    const isOff   = unavailableDates.has(iso);
    const isToday = iso === today;
    const isPast  = iso < today;
    const slots   = assignedByDate[iso] || [];

    let cls = "avail-day";
    if (isOff)     cls += " avail-day--off";
    if (isToday)   cls += " avail-day--today";
    if (isPast)    cls += " avail-day--past";
    if (slots.length) cls += " avail-day--has-game";

    // Game badges: one dot per assigned slot
    const badges = slots.map(s => {
      const isPlate = s.slotType === "Plate";
      return `<span class="avail-game-dot${isPlate ? " avail-game-dot--plate" : ""}"
        title="${esc(s.slotType)} — ${esc(s.division || "")} ${esc(s.city || "")}"></span>`;
    }).join("");

    html += `<div class="${cls}" data-iso="${iso}" title="${slots.length ? slots.map(s => `${s.slotType}: ${s.division || ""} ${s.city || ""}`.trim()).join(", ") : ""}">
      <span class="avail-day-num">${d}</span>
      ${badges ? `<div class="avail-dots">${badges}</div>` : ""}
    </div>`;
  }

  grid.innerHTML = html;
}

// ── Toggle a day ──────────────────────────────────────────────────────────────

function toggleDay(iso) {
  if (iso < todayISO()) return; // can't mark past dates
  if (unavailableDates.has(iso)) {
    unavailableDates.delete(iso);
  } else {
    unavailableDates.add(iso);
  }
  dirty = true;
  renderCalendar();
  scheduleSave();
}

// ── Auto-save (debounced 1.5 s) ───────────────────────────────────────────────

function scheduleSave() {
  clearTimeout(saveTimer);
  const msgEl = document.getElementById("availMsg");
  if (msgEl) { msgEl.textContent = ""; msgEl.className = "signup-message"; }
  saveTimer = setTimeout(saveAvailability, 1500);
}

// ── Clear current month ───────────────────────────────────────────────────────

function clearMonth() {
  const firstISO = isoFromParts(viewYear, viewMonth, 1);
  const lastISO  = isoFromParts(viewYear, viewMonth,
    new Date(viewYear, viewMonth + 1, 0).getDate());
  let changed = false;
  unavailableDates.forEach(iso => {
    if (iso >= firstISO && iso <= lastISO) { unavailableDates.delete(iso); changed = true; }
  });
  if (changed) { dirty = true; renderCalendar(); scheduleSave(); }
}

// ── Load assigned games for visible month ────────────────────────────────────

async function loadAssignedGames(uid) {
  const firstISO = isoFromParts(viewYear, viewMonth, 1);
  const lastISO  = isoFromParts(viewYear, viewMonth,
    new Date(viewYear, viewMonth + 1, 0).getDate());

  try {
    const snap = await getDocs(query(
      collection(db, "games"),
      where("date", ">=", firstISO),
      where("date", "<=", lastISO),
      orderBy("date")
    ));
    assignedByDate = {};
    snap.forEach(d => {
      const g = d.data();
      if (g.cancelled) return;
      (g.umpireSlots || []).forEach(s => {
        if (s.assignedUid !== uid) return;
        if (!assignedByDate[g.date]) assignedByDate[g.date] = [];
        assignedByDate[g.date].push({
          slotType: s.type || "?",
          division: g.division || "",
          city:     g.city || "",
        });
      });
    });
  } catch (err) {
    console.error("loadAssignedGames:", err);
  }
}

// ── Load from Firestore ───────────────────────────────────────────────────────

async function loadAvailability() {
  const user = getCurrentUser();
  if (!user) return;
  try {
    const [snapAvail] = await Promise.all([
      getDoc(doc(db, "availability", user.uid)),
      loadAssignedGames(user.uid),
    ]);
    if (snapAvail.exists()) {
      unavailableDates = new Set(snapAvail.data().unavailableDates || []);
    }
  } catch (err) {
    console.error("loadAvailability:", err);
  }
  renderCalendar();
}

// ── Save to Firestore ─────────────────────────────────────────────────────────

async function saveAvailability() {
  const user = getCurrentUser();
  if (!user) return;
  const btn   = document.getElementById("saveAvailBtn");
  const msgEl = document.getElementById("availMsg");
  if (btn) btn.disabled = true;
  setMsg("availMsg", "Saving…", "info");
  try {
    await setDoc(doc(db, "availability", user.uid), {
      unavailableDates: Array.from(unavailableDates).sort(),
      updatedAt: new Date().toISOString()
    });
    dirty = false;
    setMsg("availMsg", "Saved!", "success");
    setTimeout(() => setMsg("availMsg", ""), 2500);
  } catch (err) {
    setMsg("availMsg", err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.getElementById("calGrid").addEventListener("click", e => {
  const day = e.target.closest(".avail-day");
  if (!day || !day.dataset.iso) return;
  toggleDay(day.dataset.iso);
});

document.getElementById("prevMonthBtn").addEventListener("click", async () => {
  viewMonth--;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  const user = getCurrentUser();
  if (user) await loadAssignedGames(user.uid);
  renderCalendar();
});

document.getElementById("nextMonthBtn").addEventListener("click", async () => {
  viewMonth++;
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  const user = getCurrentUser();
  if (user) await loadAssignedGames(user.uid);
  renderCalendar();
});

document.getElementById("saveAvailBtn").addEventListener("click", () => {
  clearTimeout(saveTimer);
  saveAvailability();
});

document.getElementById("clearMonthBtn")?.addEventListener("click", clearMonth);

// Warn before leaving with unsaved changes
window.addEventListener("beforeunload", e => {
  if (dirty) { e.preventDefault(); e.returnValue = ""; }
});

// ── Auth gate ─────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  if (!isApproved()) {
    const guestEl = document.getElementById("availGuestMsg");
    if (guestEl && isCoach()) {
      guestEl.innerHTML = `<div class="document-note">
        <p>Availability tracking is for umpires only. Visit your <a href="coach-portal.html">Coach Portal</a> to manage your games.</p>
      </div>`;
    }
    document.getElementById("availContent").style.display    = "none";
    document.getElementById("availGuestMsg").style.display   = "";
    return;
  }
  document.getElementById("availContent").style.display  = "";
  document.getElementById("availGuestMsg").style.display = "none";
  loadAvailability();
});
