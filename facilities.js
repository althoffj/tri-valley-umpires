// facilities.js — shared facility lookup, shed-code cache, and check-in dialog
import { db } from "./firebase.js";
import {
  collection,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let _facilitiesCache = null;
let _shedCodesCache  = null;

export async function getFacilities() {
  if (_facilitiesCache) return _facilitiesCache;
  try {
    const snap = await getDocs(collection(db, "facilities"));
    _facilitiesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (_) { _facilitiesCache = []; }
  return _facilitiesCache;
}

export async function getShedCodes() {
  if (_shedCodesCache) return _shedCodesCache;
  try {
    const snap = await getDocs(collection(db, "facilityCodes"));
    _shedCodesCache = {};
    snap.docs.forEach(d => { _shedCodesCache[d.id] = d.data().shedCode || ""; });
  } catch (_) { return {}; } // don't cache on error — retry next call
  return _shedCodesCache;
}

export function matchFacility(facilities, cityName) {
  if (!cityName || !facilities.length) return null;
  const words = cityName.split(/\s+/).filter(w => w.length > 3);
  return facilities.find(f =>
    words.some(w => f.name?.toLowerCase().includes(w.toLowerCase()))
  ) || null;
}

export function showShedCodeDialog(shedCode, facilityName, gameCity, gameNotes) {
  const overlay = document.createElement("div");
  overlay.dataset.modal = "remove"; // enables swipe-down dismiss via pwa.js
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
