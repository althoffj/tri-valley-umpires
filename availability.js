// availability.js — Umpire unavailability calendar
import { db } from "./firebase.js";
import { authReadyPromise, isApproved, isCoach, getCurrentUser } from "./auth.js";
import { esc, todayISO, setMsg } from "./utils.js";

import {
  doc,
  getDoc,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

let unavailableDates = new Set(); // ISO strings "YYYY-MM-DD"
let viewYear  = new Date().getFullYear();
let viewMonth = new Date().getMonth(); // 0-indexed
let dirty     = false;

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

  // First day of month and number of days
  const firstDow  = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun
  const daysInMon = new Date(viewYear, viewMonth + 1, 0).getDate();

  // Fill leading blanks
  for (let i = 0; i < firstDow; i++) {
    html += `<div class="avail-day avail-day--filler"></div>`;
  }

  for (let d = 1; d <= daysInMon; d++) {
    const iso        = isoFromParts(viewYear, viewMonth, d);
    const isOff      = unavailableDates.has(iso);
    const isToday    = iso === today;
    const isPast     = iso < today;
    let cls = "avail-day";
    if (isOff)   cls += " avail-day--off";
    if (isToday) cls += " avail-day--today";
    if (isPast)  cls += " avail-day--past";
    html += `<div class="${cls}" data-iso="${iso}">${d}</div>`;
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
}

// ── Load from Firestore ───────────────────────────────────────────────────────

async function loadAvailability() {
  const user = getCurrentUser();
  if (!user) return;
  try {
    const snap = await getDoc(doc(db, "availability", user.uid));
    if (snap.exists()) {
      unavailableDates = new Set(snap.data().unavailableDates || []);
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
  const btn = document.getElementById("saveAvailBtn");
  btn.disabled = true;
  setMsg("Saving…", "info");
  try {
    await setDoc(doc(db, "availability", user.uid), {
      unavailableDates: Array.from(unavailableDates).sort(),
      updatedAt: new Date().toISOString()
    });
    dirty = false;
    setMsg("Saved!", "success");
    setTimeout(() => setMsg(""), 2500);
  } catch (err) {
    setMsg(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.getElementById("calGrid").addEventListener("click", e => {
  const day = e.target.closest(".avail-day");
  if (!day || !day.dataset.iso) return;
  toggleDay(day.dataset.iso);
});

document.getElementById("prevMonthBtn").addEventListener("click", () => {
  viewMonth--;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  renderCalendar();
});

document.getElementById("nextMonthBtn").addEventListener("click", () => {
  viewMonth++;
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  renderCalendar();
});

document.getElementById("saveAvailBtn").addEventListener("click", saveAvailability);

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
