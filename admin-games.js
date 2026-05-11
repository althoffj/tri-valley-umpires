// admin-games.js — Game management: sync, add, list, edit modal, team calendars
import { db, app } from "./firebase.js";
import { authReadyPromise, isAdmin, isSuperAdmin } from "./auth.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  addDoc,
  deleteDoc,
  setDoc,
  query,
  orderBy,
  serverTimestamp,
  where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let allGames      = [];
let gameFilter    = "upcoming";
let currentRates  = { plate: 0, field: 0, extra: 0 };
let facilitiesData = []; // [{ id, name, fields:[{name,notes}] }]

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

function fmtDate(dateISO) {
  if (!dateISO) return "—";
  const [y, m, d] = dateISO.split("-");
  return `${m}/${d}/${y}`;
}

function fmtTime(timeStr) {
  if (!timeStr) return "—";
  const [h, m] = timeStr.split(":");
  const hr = parseInt(h, 10);
  const ampm = hr >= 12 ? "PM" : "AM";
  return `${hr % 12 || 12}:${m} ${ampm}`;
}

function setMsg(id, text, type = "info") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = `signup-message ${type}`;
}

function slotBadge(slot) {
  const cls = slot.type === "Plate" ? "plate" : slot.type === "Field" ? "field" : "extra";
  const pay = slot.payRate != null
    ? ` <span style="color:var(--light-text);font-size:0.78rem">$${Number(slot.payRate).toFixed(0)}</span>` : "";
  const filled = slot.assignedName
    ? ` <span style="color:var(--light-text);font-size:0.8rem">→ ${esc(slot.assignedName)}</span>` : "";
  const checkinBadge = slot.assignedUid
    ? slot.checkedIn
      ? ` <span style="font-size:0.72rem;background:#17351f;color:#b8f2c4;border-radius:4px;padding:1px 6px"
             title="${slot.checkedInAt ? "Checked in " + new Date(slot.checkedInAt).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}) : "Checked in"}">✓ In</span>`
      : ` <span style="font-size:0.72rem;background:#3a2800;color:#ffcc80;border-radius:4px;padding:1px 6px">Not checked in</span>`
    : "";
  return `<span class="badge badge-${cls}">${esc(slot.type)}</span>${pay}${filled}${checkinBadge}`;
}

// ── Facilities select population + field cascade ──────────────────────────────

async function loadFacilitiesIntoSelects() {
  try {
    const snap = await getDocs(collection(db, "facilities"));
    facilitiesData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const options = facilitiesData.map(f =>
      `<option value="${esc(f.id)}">${esc(f.name)}</option>`
    ).join("");
    const addSel  = document.getElementById("gameFacility");
    const editSel = document.getElementById("editGameFacility");
    if (addSel)  addSel.innerHTML  = `<option value="">-- None / Other --</option>${options}`;
    if (editSel) editSel.innerHTML = `<option value="">-- None / Other --</option>${options}`;

    // Wire cascade listeners
    addSel?.addEventListener("change",  () => cascadeFields("gameFacility",     "gameFieldSelect",     "gameField"));
    editSel?.addEventListener("change", () => cascadeFields("editGameFacility", "editGameFieldSelect", "editGameField"));
  } catch (_) {}
}

function cascadeFields(facSelId, fieldSelId, fieldInputId) {
  const facSel     = document.getElementById(facSelId);
  const fieldSel   = document.getElementById(fieldSelId);
  const fieldInput = document.getElementById(fieldInputId);
  if (!facSel || !fieldSel || !fieldInput) return;

  const fac    = facilitiesData.find(f => f.id === facSel.value);
  const fields = (fac?.fields || []).filter(f => f.name);

  if (fields.length > 0) {
    fieldSel.innerHTML =
      `<option value="">-- Select Field --</option>` +
      fields.map(f => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join("") +
      `<option value="__other__">Other / Enter manually…</option>`;
    fieldSel.style.display = "";
    fieldInput.style.display = "none";
    fieldInput.value = "";

    fieldSel.onchange = () => {
      if (fieldSel.value === "__other__") {
        fieldInput.style.display = "";
        fieldInput.focus();
      } else {
        fieldInput.style.display = "none";
        fieldInput.value = "";
      }
    };
  } else {
    fieldSel.style.display = "none";
    fieldInput.style.display = "";
  }
}

function getFieldValue(fieldSelId, fieldInputId) {
  const sel   = document.getElementById(fieldSelId);
  const input = document.getElementById(fieldInputId);
  if (sel && sel.style.display !== "none" && sel.value && sel.value !== "__other__") {
    return sel.value;
  }
  return input?.value.trim() || "";
}

// ── Games ─────────────────────────────────────────────────────────────────────

async function loadGames() {
  const tbody = document.getElementById("adminGameBody");
  try {
    const q = query(collection(db, "games"), where("needsUmpires", "==", true), orderBy("date"), orderBy("time"));
    const snap = await getDocs(q);
    allGames = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAdminGames();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:#ffb4b4">Failed to load games.</td></tr>`;
    console.error(err);
  }
}

function renderAdminGames() {
  const tbody = document.getElementById("adminGameBody");
  const today = todayISO();
  const visible = allGames.filter(g =>
    gameFilter === "all" || (!g.cancelled && g.date >= today)
  );

  if (visible.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:var(--light-text);text-align:center;padding:20px">No games.</td></tr>`;
    return;
  }

  tbody.innerHTML = visible.map(g => {
    const slots = g.umpireSlots || [];
    const teams = (g.homeTeam && g.awayTeam)
      ? `<div style="font-size:0.8rem;color:var(--light-text)">${esc(g.homeTeam)} vs ${esc(g.awayTeam)}</div>` : "";
    const canAssign = isSuperAdmin() && !g.cancelled;
    const slotHtml = slots.length
      ? slots.map((s, i) => `
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;${i > 0 ? "margin-top:4px" : ""}">
            ${slotBadge(s)}
            ${s.assignedUid
              ? `<button class="btn print-btn unassign-btn" style="font-size:0.75rem;padding:3px 8px"
                   data-game-id="${esc(g.id)}" data-slot-type="${esc(s.type)}">Unassign</button>`
              : canAssign
                ? `<button class="btn print-btn assign-btn" style="font-size:0.75rem;padding:3px 8px"
                     data-game-id="${esc(g.id)}" data-slot-type="${esc(s.type)}">Assign</button>`
                : ""}
          </div>`).join("")
      : "—";

    const changeWarning = g.possibleChange
      ? `<div style="color:#ffcc80;font-size:0.78rem;margin-top:4px">⚠ GameChanger event missing — verify with city</div>` : "";
    const linkedBadge = g.icsLinks?.length
      ? `<div style="color:var(--light-text);font-size:0.72rem;margin-top:2px">GC linked</div>` : "";

    return `
    <tr style="${g.cancelled ? "opacity:0.55" : ""}${g.possibleChange ? ";background:rgba(255,204,0,0.06)" : ""}">
      <td>${esc(fmtDate(g.date))}</td>
      <td>${esc(fmtTime(g.time))}</td>
      <td>${esc(g.city || "—")}${teams}</td>
      <td>${esc(g.division || "—")}</td>
      <td>${esc(g.type || "—")}</td>
      <td>${esc(g.field || "—")}${linkedBadge}</td>
      <td>${g.cancelled ? '<span style="color:#ffb4b4">Cancelled</span>' : slotHtml}${changeWarning}</td>
      <td style="white-space:nowrap;vertical-align:top">
        ${g.cancelled ? "" : `
          <button class="btn print-btn edit-game-btn" style="margin-bottom:4px;display:block;width:100%"
            data-game-id="${esc(g.id)}">Edit</button>
          <button class="btn print-btn cancel-game-btn" style="margin-bottom:4px;display:block;width:100%"
            data-game-id="${esc(g.id)}">Cancel</button>`}
        <button class="btn delete-game-btn" style="display:block;width:100%;background:#5a1a1a"
          data-game-id="${esc(g.id)}">Delete</button>
      </td>
    </tr>`;
  }).join("");
}

async function cancelGame(gameId) {
  const game = allGames.find(g => g.id === gameId);
  if (!game) return;
  if (!confirm(`Cancel the game on ${fmtDate(game.date)} at ${game.city}?`)) return;
  try {
    await updateDoc(doc(db, "games", gameId), { cancelled: true, cancelledAt: serverTimestamp() });
    const g = allGames.find(g => g.id === gameId);
    if (g) g.cancelled = true;
    renderAdminGames();
  } catch (err) {
    alert(err.message);
  }
}

async function unassignSlot(gameId, slotType) {
  if (!confirm(`Remove the umpire from the ${slotType} slot?`)) return;
  try {
    const gameRef = doc(db, "games", gameId);
    const snap = await getDoc(gameRef);
    if (!snap.exists()) return;
    const slots = (snap.data().umpireSlots || []).map(s =>
      s.type === slotType ? { ...s, assignedUid: null, assignedName: null } : s
    );
    await updateDoc(gameRef, { umpireSlots: slots });
    const g = allGames.find(g => g.id === gameId);
    if (g) g.umpireSlots = slots;
    renderAdminGames();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteGame(gameId) {
  const game = allGames.find(g => g.id === gameId);
  if (!game) return;
  if (!confirm(`Permanently delete the game on ${fmtDate(game.date)} at ${game.city}?\nThis cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, "games", gameId));
    allGames = allGames.filter(g => g.id !== gameId);
    renderAdminGames();
  } catch (err) {
    alert(err.message);
  }
}

function openEditModal(gameId) {
  const game = allGames.find(g => g.id === gameId);
  if (!game) return;
  const modal = document.getElementById("editGameModal");

  document.getElementById("editGameId").value        = gameId;
  document.getElementById("editGameCity").value      = game.city || "";
  document.getElementById("editGameDivision").value  = game.division || "";
  document.getElementById("editGameDate").value      = game.date || "";
  document.getElementById("editGameTime").value      = game.time || "";
  document.getElementById("editGameType").value      = game.type || "Regular";
  document.getElementById("editHomeTeam").value      = game.homeTeam || "";
  document.getElementById("editAwayTeam").value      = game.awayTeam || "";

  // Set facility select and trigger field cascade
  const editFacSel = document.getElementById("editGameFacility");
  if (editFacSel) {
    editFacSel.value = game.facilityId || "";
    cascadeFields("editGameFacility", "editGameFieldSelect", "editGameField");
    // After cascade, restore saved field value into the active control
    const fieldSel = document.getElementById("editGameFieldSelect");
    if (fieldSel && fieldSel.style.display !== "none") {
      const matchOpt = [...fieldSel.options].find(o => o.value === (game.field || ""));
      if (matchOpt) {
        fieldSel.value = game.field;
      } else if (game.field) {
        fieldSel.value = "__other__";
        const fi = document.getElementById("editGameField");
        if (fi) { fi.style.display = ""; fi.value = game.field; }
      }
    } else {
      document.getElementById("editGameField").value = game.field || "";
    }
  }

  // Render slot-type checkboxes + pay inputs
  const slotsDiv  = document.getElementById("editSlotPays");
  const slots      = game.umpireSlots || [];
  const slotMap    = Object.fromEntries(slots.map(s => [s.type, s]));
  const slotTypes  = ["Plate", "Field", "Extra"];
  slotsDiv.innerHTML = `<div style="display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:6px 10px">` +
    slotTypes.map(t => {
      const s   = slotMap[t];
      const cls = t === "Plate" ? "plate" : t === "Field" ? "field" : "extra";
      const nameLabel = s?.assignedName
        ? `<span style="font-size:0.82rem;color:var(--light-text)">→ ${esc(s.assignedName)}</span>` : `<span></span>`;
      return `
        <label style="font-weight:normal;display:flex;align-items:center;gap:6px;margin:0">
          <input type="checkbox" class="edit-slot-check" value="${t}" ${s ? "checked" : ""} />
          <span class="badge badge-${cls}">${t}</span>
        </label>
        ${nameLabel}
        <input type="number" min="0" step="0.01" value="${s?.payRate != null ? s.payRate : ""}"
          class="edit-slot-pay" data-slot-type="${t}"
          ${!s ? "disabled" : ""}
          style="width:70px;padding:4px 6px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:4px" />`;
    }).join("") + `</div>
    <p style="font-size:0.8rem;color:var(--light-text);margin-top:8px">Unchecking a slot type with an assigned umpire will clear that assignment.</p>`;

  // Wire checkboxes to enable/disable pay inputs
  slotsDiv.querySelectorAll(".edit-slot-check").forEach(cb => {
    cb.addEventListener("change", () => {
      const pay = slotsDiv.querySelector(`.edit-slot-pay[data-slot-type="${cb.value}"]`);
      if (pay) pay.disabled = !cb.checked;
    });
  });

  setMsg("editGameMessage", "", "info");
  modal.style.display = "flex";
}

async function saveGameEdit() {
  const gameId = document.getElementById("editGameId").value;
  const btn    = document.getElementById("saveEditGameBtn");
  btn.disabled = true;
  setMsg("editGameMessage", "Saving…", "info");

  try {
    const facilityId = document.getElementById("editGameFacility")?.value || "";
    const updates = {
      city:       document.getElementById("editGameCity").value,
      division:   document.getElementById("editGameDivision").value,
      date:       document.getElementById("editGameDate").value,
      time:       document.getElementById("editGameTime").value,
      type:       document.getElementById("editGameType").value,
      field:      getFieldValue("editGameFieldSelect", "editGameField"),
      homeTeam:   document.getElementById("editHomeTeam").value.trim(),
      awayTeam:   document.getElementById("editAwayTeam").value.trim(),
      facilityId: facilityId,
      needsUmpires: true,
    };

    // Rebuild umpire slots from checkboxes + pay inputs
    const gameRef   = doc(db, "games", gameId);
    const snap      = await getDoc(gameRef);
    const existing  = snap.exists() ? (snap.data().umpireSlots || []) : [];
    const slotMap   = Object.fromEntries(existing.map(s => [s.type, s]));
    const slotsDiv  = document.getElementById("editSlotPays");
    const newSlots  = [];
    slotsDiv.querySelectorAll(".edit-slot-check").forEach(cb => {
      if (!cb.checked) return;
      const payInput = slotsDiv.querySelector(`.edit-slot-pay[data-slot-type="${cb.value}"]`);
      const payRate  = parseFloat(payInput?.value) || 0;
      const prev     = slotMap[cb.value];
      newSlots.push({
        type:        cb.value,
        payRate,
        assignedUid:  prev?.assignedUid  ?? null,
        assignedName: prev?.assignedName ?? null,
        paid:         prev?.paid         ?? false
      });
    });
    updates.umpireSlots = newSlots;

    await updateDoc(gameRef, updates);
    const g = allGames.find(g => g.id === gameId);
    if (g) Object.assign(g, updates);
    setMsg("editGameMessage", "Saved!", "success");
    setTimeout(() => {
      document.getElementById("editGameModal").style.display = "none";
      renderAdminGames();
    }, 800);
  } catch (err) {
    setMsg("editGameMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// ── Assign umpire modal ───────────────────────────────────────────────────────

let approvedUmpires   = []; // { uid, name, email }
let umpireUnavailable = {}; // { [uid]: Set<string> } — loaded per assign-modal open
let assignTarget      = null; // { gameId, slotType }

async function loadApprovedUmpires() {
  if (approvedUmpires.length) return;
  try {
    const snap = await getDocs(query(collection(db, "umpires"), where("approved", "==", true), orderBy("name")));
    approvedUmpires = snap.docs.map(d => ({
      uid:   d.id,
      name:  d.data().name  || d.data().displayName || "",
      email: d.data().email || "",
    }));
  } catch (err) {
    console.error("loadApprovedUmpires:", err);
  }
}

async function loadAllAvailability() {
  try {
    const snap = await getDocs(collection(db, "availability"));
    umpireUnavailable = {};
    snap.forEach(d => {
      umpireUnavailable[d.id] = new Set(d.data().unavailableDates || []);
    });
  } catch (err) {
    console.error("loadAllAvailability:", err);
    umpireUnavailable = {};
  }
}

function renderAssignList(filter = "") {
  const list    = document.getElementById("assignUmpireList");
  const lower   = filter.toLowerCase();
  const gameDate = assignTarget?.gameDate || "";
  const shown   = approvedUmpires.filter(u =>
    !filter || u.name.toLowerCase().includes(lower) || u.email.toLowerCase().includes(lower)
  );

  if (!shown.length) {
    list.innerHTML = `<p style="padding:12px 16px;color:var(--light-text);margin:0">No matching umpires.</p>`;
    return;
  }

  const gameTime = assignTarget?.gameTime || "";
  list.innerHTML = shown.map(u => {
    const unavail   = gameDate && umpireUnavailable[u.uid]?.has(gameDate);
    // Check if umpire is already assigned to a different game at the exact same date + time
    const conflict  = gameDate && gameTime && allGames.some(g =>
      g.id !== assignTarget?.gameId &&
      g.date === gameDate &&
      g.time === gameTime &&
      !g.cancelled &&
      (g.umpireSlots || []).some(s => s.assignedUid === u.uid)
    );
    const badges = [
      unavail  ? `<span style="font-size:0.75rem;color:#fca;background:#5a2000;border-radius:4px;padding:2px 7px">Unavailable</span>` : "",
      conflict ? `<span style="font-size:0.75rem;color:#f88;background:#4a0000;border-radius:4px;padding:2px 7px">Conflict</span>` : "",
    ].filter(Boolean).join(" ");
    return `
    <div class="assign-umpire-row" data-uid="${esc(u.uid)}" data-name="${esc(u.name)}"
      style="padding:10px 16px;cursor:pointer;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-weight:bold;display:flex;align-items:center;flex-wrap:wrap;gap:4px">${esc(u.name)}${badges ? ` ${badges}` : ""}</div>
        ${u.email ? `<div style="font-size:0.8rem;color:var(--light-text)">${esc(u.email)}</div>` : ""}
      </div>
      <button class="btn print-btn" style="font-size:0.8rem;padding:4px 12px;flex-shrink:0">Assign</button>
    </div>`;
  }).join("");
}

async function openAssignModal(gameId, slotType) {
  const game = allGames.find(g => g.id === gameId);
  assignTarget = { gameId, slotType, gameDate: game?.date || "", gameTime: game?.time || "" };
  const label = document.getElementById("assignSlotLabel");
  if (label && game) {
    label.textContent = `${slotType} slot — ${game.city || ""} ${fmtDate(game.date)} ${fmtTime(game.time)}`;
  }
  document.getElementById("assignSearch").value = "";
  document.getElementById("assignMessage").textContent = "";

  await Promise.all([loadApprovedUmpires(), loadAllAvailability()]);
  renderAssignList();
  document.getElementById("assignModal").style.display = "flex";
  document.getElementById("assignSearch").focus();
}

async function doAssign(uid, name) {
  if (!assignTarget) return;
  const { gameId, slotType } = assignTarget;
  const msgEl = document.getElementById("assignMessage");
  msgEl.textContent = "Saving…";
  msgEl.className   = "signup-message info";

  try {
    const gameRef = doc(db, "games", gameId);
    const snap    = await getDoc(gameRef);
    if (!snap.exists()) throw new Error("Game not found.");
    const slots = (snap.data().umpireSlots || []).map(s =>
      s.type === slotType ? { ...s, assignedUid: uid, assignedName: name } : s
    );
    await updateDoc(gameRef, { umpireSlots: slots });
    const g = allGames.find(g => g.id === gameId);
    if (g) g.umpireSlots = slots;
    document.getElementById("assignModal").style.display = "none";
    renderAdminGames();
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className   = "signup-message error";
  }
}

document.getElementById("assignSearch").addEventListener("input", function () {
  renderAssignList(this.value);
});

document.getElementById("assignUmpireList").addEventListener("click", e => {
  const row = e.target.closest(".assign-umpire-row");
  if (!row) return;
  doAssign(row.dataset.uid, row.dataset.name);
});

document.getElementById("cancelAssignBtn").addEventListener("click", () => {
  document.getElementById("assignModal").style.display = "none";
});

document.getElementById("assignModal").addEventListener("click", e => {
  if (e.target === document.getElementById("assignModal"))
    document.getElementById("assignModal").style.display = "none";
});

// ── Add game form ─────────────────────────────────────────────────────────────

document.getElementById("addGameForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn = document.getElementById("addGameBtn");

  const checkedTypes = [...document.querySelectorAll("#gameUmpireTypes input:checked")].map(cb => cb.value);
  if (checkedTypes.length === 0) {
    document.getElementById("umpireTypesError").textContent = "Select at least one umpire position.";
    return;
  }
  document.getElementById("umpireTypesError").textContent = "";

  btn.disabled = true;
  setMsg("addGameMessage", "Adding game…", "info");

  const city       = document.getElementById("gameCity").value;
  const division   = document.getElementById("gameDivision").value;
  const date       = document.getElementById("gameDate").value;
  const time       = document.getElementById("gameTime").value;
  const type       = document.getElementById("gameType").value;
  const field      = getFieldValue("gameFieldSelect", "gameField");
  const facilityId = document.getElementById("gameFacility")?.value || "";
  const homeTeam   = document.getElementById("gameHomeTeam")?.value.trim() || "";
  const awayTeam   = document.getElementById("gameAwayTeam")?.value.trim() || "";

  // Build slots with per-slot pay from inline inputs
  const umpireSlots = checkedTypes.map(t => {
    const payInput = document.querySelector(`.slot-pay-input[data-slot-type="${t}"]`);
    const payRate  = payInput ? (parseFloat(payInput.value) || 0) : 0;
    return { type: t, assignedUid: null, assignedName: null, payRate };
  });

  try {
    const gameData = {
      city, division, date, time, type, field, facilityId,
      umpireSlots,
      needsUmpires: true,
      cancelled: false,
      createdAt: serverTimestamp()
    };
    if (homeTeam) gameData.homeTeam = homeTeam;
    if (awayTeam) gameData.awayTeam = awayTeam;
    await addDoc(collection(db, "games"), gameData);
    setMsg("addGameMessage", "Game added!", "success");
    this.reset();
    // Reset field cascade back to text input
    const fieldSel = document.getElementById("gameFieldSelect");
    if (fieldSel) fieldSel.style.display = "none";
    const fieldInp = document.getElementById("gameField");
    if (fieldInp) fieldInp.style.display = "";
    document.querySelectorAll("#gameUmpireTypes input[type=checkbox]").forEach(cb => cb.checked = false);
    document.querySelectorAll(".slot-pay-input").forEach(inp => { inp.disabled = true; inp.value = ""; });
    const homeTeamInp = document.getElementById("gameHomeTeam");
    if (homeTeamInp) homeTeamInp.value = "";
    const awayTeamInp = document.getElementById("gameAwayTeam");
    if (awayTeamInp) awayTeamInp.value = "";
    await loadGames();
  } catch (err) {
    setMsg("addGameMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Pay rates (load only for pre-filling Add Game form) ───────────────────────

async function loadPayRates() {
  try {
    const snap = await getDoc(doc(db, "config", "payRates"));
    if (snap.exists()) {
      const r = snap.data();
      currentRates = { plate: r.plate || 0, field: r.field || 0, extra: r.extra || 0 };
      prefillSlotPays();
    }
  } catch (_) {}
}

function prefillSlotPays() {
  const map = { Plate: currentRates.plate, Field: currentRates.field, Extra: currentRates.extra };
  document.querySelectorAll(".slot-pay-input").forEach(input => {
    if (!input.value) input.value = map[input.dataset.slotType] || "";
  });
}

// Pre-fill slot pay inputs when a checkbox is checked
document.getElementById("gameUmpireTypes").addEventListener("change", e => {
  if (e.target.type !== "checkbox") return;
  const type     = e.target.value;
  const payInput = document.querySelector(`.slot-pay-input[data-slot-type="${type}"]`);
  if (!payInput) return;
  if (e.target.checked && !payInput.value) {
    payInput.value = currentRates[type.toLowerCase()] || "";
  }
  payInput.disabled = !e.target.checked;
});

// ── Team Calendars ────────────────────────────────────────────────────────────

async function loadTeamCalendars() {
  const listEl = document.getElementById("teamCalendarList");
  try {
    const snap = await getDoc(doc(db, "config", "teamCalendars"));
    const teams = snap.exists() ? (snap.data().teams || []) : [];

    if (teams.length === 0) {
      listEl.innerHTML = `<p class="schedule-source">No teams added yet.</p>`;
      return;
    }

    listEl.innerHTML = teams.map((t, i) => `
      <div data-team-row="${i}" style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #444">
        <span style="flex:1"><strong>${esc(t.name)}</strong><br>
          <span style="color:var(--light-text);font-size:0.82rem;word-break:break-all">${esc(t.icsUrl)}</span>
        </span>
        <button class="btn print-btn sync-team-btn" data-index="${i}" style="flex-shrink:0">Sync</button>
        <button class="btn print-btn edit-team-btn" data-index="${i}" style="flex-shrink:0">Edit</button>
        <button class="btn print-btn remove-team-btn" data-index="${i}" style="flex-shrink:0">Remove</button>
      </div>`).join("");
  } catch (err) {
    listEl.innerHTML = `<p style="color:#ffb4b4">Failed to load teams.</p>`;
  }
}

async function addTeam(name, icsUrl) {
  const snap = await getDoc(doc(db, "config", "teamCalendars"));
  const teams = snap.exists() ? (snap.data().teams || []) : [];
  const normalizedUrl = icsUrl.replace(/^webcal:\/\//i, "https://");
  teams.push({ name, icsUrl: normalizedUrl });
  await setDoc(doc(db, "config", "teamCalendars"), { teams });
}

async function removeTeam(index) {
  const snap = await getDoc(doc(db, "config", "teamCalendars"));
  const teams = snap.exists() ? (snap.data().teams || []) : [];
  teams.splice(index, 1);
  await setDoc(doc(db, "config", "teamCalendars"), { teams });
}

async function saveTeam(index, name, icsUrl) {
  const snap = await getDoc(doc(db, "config", "teamCalendars"));
  const teams = snap.exists() ? (snap.data().teams || []) : [];
  teams[index] = { name, icsUrl: icsUrl.replace(/^webcal:\/\//i, "https://") };
  await setDoc(doc(db, "config", "teamCalendars"), { teams });
}

function showTeamEditRow(index, currentName, currentUrl) {
  const row = document.querySelector(`[data-team-row="${index}"]`);
  if (!row) return;
  row.innerHTML = `
    <div style="flex:1;display:flex;flex-direction:column;gap:6px">
      <input type="text" class="team-edit-name" value="${esc(currentName)}"
        style="width:100%;padding:6px 8px;background:var(--card-bg,#2b2b2b);color:var(--text);border:1px solid #555;border-radius:4px" />
      <input type="url" class="team-edit-url" value="${esc(currentUrl)}"
        style="width:100%;padding:6px 8px;background:var(--card-bg,#2b2b2b);color:var(--text);border:1px solid #555;border-radius:4px;font-size:0.82rem" />
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0">
      <button class="btn save-team-btn" data-index="${index}">Save</button>
      <button class="btn print-btn cancel-edit-team-btn" data-index="${index}">Cancel</button>
    </div>`;
}

document.getElementById("addTeamForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn  = document.getElementById("addTeamBtn");
  const name = document.getElementById("teamName").value.trim();
  const url  = document.getElementById("teamIcsUrl").value.trim();
  btn.disabled = true;
  setMsg("addTeamMessage", "Saving…", "info");
  try {
    await addTeam(name, url);
    setMsg("addTeamMessage", "Team added!", "success");
    this.reset();
    await loadTeamCalendars();
  } catch (err) {
    setMsg("addTeamMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Calendar Sync ─────────────────────────────────────────────────────────────

async function syncGamesFromCalendars() {
  const btn = document.getElementById("syncCalBtn");
  btn.disabled = true;
  setMsg("syncCalMessage", "Syncing calendars…", "info");
  try {
    const functions    = getFunctions(app, "us-central1");
    const syncGamesNow = httpsCallable(functions, "syncGamesNow");
    const { data } = await syncGamesNow();
    const parts = [];
    if (data.linked)  parts.push(`${data.linked} game${data.linked !== 1 ? "s" : ""} linked to GameChanger`);
    if (data.flagged) parts.push(`${data.flagged} possible change${data.flagged !== 1 ? "s" : ""} flagged`);
    if (data.failed)  parts.push(`${data.failed} feed${data.failed !== 1 ? "s" : ""} failed`);
    setMsg("syncCalMessage", parts.length ? `Sync: ${parts.join(", ")}.` : "Sync complete — nothing new.", data.flagged > 0 ? "warning" : "success");
    if (data.linked || data.flagged) await loadGames();
  } catch (err) {
    setMsg("syncCalMessage", `Error: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

async function syncTeamNow(teamIndex) {
  const functions = getFunctions(app, "us-central1");
  const callable  = httpsCallable(functions, "syncTeamNow");
  const { data }  = await callable({ teamIndex });
  return data;
}

document.getElementById("syncCalBtn").addEventListener("click", syncGamesFromCalendars);

document.getElementById("importScheduleBtn").addEventListener("click", async () => {
  const btn = document.getElementById("importScheduleBtn");
  btn.disabled = true;
  setMsg("syncCalMessage", "Importing city schedule…", "info");
  try {
    const functions          = getFunctions(app, "us-central1");
    const importCitySchedule = httpsCallable(functions, "importCitySchedule");
    const { data } = await importCitySchedule();
    const msg = `Imported: ${data.added} game${data.added !== 1 ? "s" : ""} added${data.skipped ? `, ${data.skipped} already existed` : ""}.`;
    setMsg("syncCalMessage", msg, data.added > 0 ? "success" : "info");
    if (data.added > 0) await loadGames();
  } catch (err) {
    setMsg("syncCalMessage", `Error: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Edit modal wiring ─────────────────────────────────────────────────────────

document.getElementById("saveEditGameBtn").addEventListener("click", saveGameEdit);
document.getElementById("cancelEditGameBtn").addEventListener("click", () => {
  document.getElementById("editGameModal").style.display = "none";
});
document.getElementById("editGameModal").addEventListener("click", e => {
  if (e.target === document.getElementById("editGameModal"))
    document.getElementById("editGameModal").style.display = "none";
});

// ── Event delegation ──────────────────────────────────────────────────────────

document.addEventListener("click", e => {
  const editGameBtn = e.target.closest(".edit-game-btn");
  if (editGameBtn) { openEditModal(editGameBtn.dataset.gameId); return; }

  const cancelGameBtn = e.target.closest(".cancel-game-btn");
  if (cancelGameBtn) { cancelGame(cancelGameBtn.dataset.gameId); return; }

  const deleteGameBtn = e.target.closest(".delete-game-btn");
  if (deleteGameBtn) { deleteGame(deleteGameBtn.dataset.gameId); return; }

  const unassignBtn = e.target.closest(".unassign-btn");
  if (unassignBtn) { unassignSlot(unassignBtn.dataset.gameId, unassignBtn.dataset.slotType); return; }

  const assignBtn = e.target.closest(".assign-btn");
  if (assignBtn) { openAssignModal(assignBtn.dataset.gameId, assignBtn.dataset.slotType); return; }

  const syncTeamBtn = e.target.closest(".sync-team-btn");
  if (syncTeamBtn) {
    const index = Number(syncTeamBtn.dataset.index);
    syncTeamBtn.disabled = true;
    syncTeamBtn.textContent = "Syncing…";
    const msgEl = document.getElementById("syncCalMessage");
    if (msgEl) { msgEl.textContent = "Syncing team…"; msgEl.className = "signup-message info"; }
    syncTeamNow(index)
      .then(r => {
        if (msgEl) { msgEl.textContent = `Done — ${r.added ?? 0} added, ${r.linked ?? 0} linked.`; msgEl.className = "signup-message success"; }
      })
      .catch(err => {
        if (msgEl) { msgEl.textContent = `Error: ${err.message}`; msgEl.className = "signup-message error"; }
      })
      .finally(() => { syncTeamBtn.disabled = false; syncTeamBtn.textContent = "Sync"; });
    return;
  }

  const editTeamBtn = e.target.closest(".edit-team-btn");
  if (editTeamBtn) {
    const i   = Number(editTeamBtn.dataset.index);
    const row = document.querySelector(`[data-team-row="${i}"]`);
    const name = row.querySelector("strong")?.textContent || "";
    const url  = row.querySelector("span > span")?.textContent || "";
    showTeamEditRow(i, name, url);
    return;
  }

  const saveTeamBtn = e.target.closest(".save-team-btn");
  if (saveTeamBtn) {
    const i    = Number(saveTeamBtn.dataset.index);
    const row  = document.querySelector(`[data-team-row="${i}"]`);
    const name = row.querySelector(".team-edit-name").value.trim();
    const url  = row.querySelector(".team-edit-url").value.trim();
    if (!name || !url) { alert("Name and URL are required."); return; }
    saveTeamBtn.disabled = true;
    saveTeam(i, name, url).then(loadTeamCalendars).catch(err => { alert(err.message); saveTeamBtn.disabled = false; });
    return;
  }

  const cancelEditTeamBtn = e.target.closest(".cancel-edit-team-btn");
  if (cancelEditTeamBtn) { loadTeamCalendars(); return; }

  const removeTeamBtn = e.target.closest(".remove-team-btn");
  if (removeTeamBtn) {
    if (!confirm("Remove this team?")) return;
    removeTeam(Number(removeTeamBtn.dataset.index)).then(loadTeamCalendars).catch(err => alert(err.message));
    return;
  }

  const filterBtn = e.target.closest(".filter-btn");
  if (filterBtn) {
    gameFilter = filterBtn.dataset.filter;
    document.querySelectorAll(".filter-btn").forEach(b =>
      b.classList.toggle("filter-active", b.dataset.filter === gameFilter)
    );
    renderAdminGames();
    return;
  }

  const approveCancelBtn = e.target.closest(".approve-cancel-btn");
  if (approveCancelBtn) {
    approveCancellation(
      approveCancelBtn.dataset.requestId,
      approveCancelBtn.dataset.gameId,
      approveCancelBtn.dataset.slotType,
      approveCancelBtn.dataset.uid
    );
    return;
  }

  const denyCancelBtn = e.target.closest(".deny-cancel-btn");
  if (denyCancelBtn) { denyCancellation(denyCancelBtn.dataset.requestId); return; }
});

// ── Cancellation requests ─────────────────────────────────────────────────────

let pendingCancellations = []; // [{ id, ...data }]

async function loadPendingCancellations() {
  try {
    const snap = await getDocs(query(
      collection(db, "cancellationRequests"),
      where("status", "==", "pending"),
      orderBy("requestedAt")
    ));
    pendingCancellations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error("loadPendingCancellations:", err);
    pendingCancellations = [];
  }
  renderPendingCancellations();
}

function renderPendingCancellations() {
  const section = document.getElementById("pendingCancellationsSection");
  const list    = document.getElementById("pendingCancellationsList");
  if (!section || !list) return;

  if (pendingCancellations.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";
  list.innerHTML = pendingCancellations.map(r => {
    const gameDate = r.gameDate ? fmtDate(r.gameDate) : "Unknown date";
    const gameTime = r.gameTime ? fmtTime(r.gameTime) : "";
    const label    = [r.gameCity, r.gameDivision, r.gameField].filter(Boolean).join(" · ");
    return `
    <div class="cancellation-request-row" style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid #333">
      <div>
        <div style="font-weight:bold">${esc(r.name || r.uid)}</div>
        <div style="color:var(--light-text);font-size:0.88rem;margin-top:2px">
          ${esc(r.slotType)} slot &mdash; ${esc(gameDate)}${gameTime ? " at " + esc(gameTime) : ""}
          ${label ? `&mdash; ${esc(label)}` : ""}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button class="btn approve-cancel-btn" style="background:#17351f;color:#b8f2c4;font-size:0.85rem;padding:5px 14px"
          data-request-id="${esc(r.id)}"
          data-game-id="${esc(r.gameId)}"
          data-slot-type="${esc(r.slotType)}"
          data-uid="${esc(r.uid)}">Approve</button>
        <button class="btn print-btn deny-cancel-btn" style="font-size:0.85rem;padding:5px 14px"
          data-request-id="${esc(r.id)}">Deny</button>
      </div>
    </div>`;
  }).join("");
}

async function approveCancellation(requestId, gameId, slotType, uid) {
  if (!confirm("Approve this cancellation? The umpire will be removed from the slot.")) return;
  try {
    // Remove umpire from the game slot
    const gameRef = doc(db, "games", gameId);
    const snap    = await getDoc(gameRef);
    if (!snap.exists()) throw new Error("Game not found.");
    const slots = (snap.data().umpireSlots || []).map(s =>
      s.type === slotType && s.assignedUid === uid
        ? { ...s, assignedUid: null, assignedName: null }
        : s
    );
    await updateDoc(gameRef, { umpireSlots: slots });

    // Update request status
    await updateDoc(doc(db, "cancellationRequests", requestId), {
      status:     "approved",
      resolvedAt: serverTimestamp()
    });

    // Update local allGames cache
    const g = allGames.find(g => g.id === gameId);
    if (g) g.umpireSlots = slots;

    // Remove from local list and re-render both
    pendingCancellations = pendingCancellations.filter(r => r.id !== requestId);
    renderPendingCancellations();
    renderAdminGames();
  } catch (err) {
    alert("Failed to approve: " + err.message);
  }
}

async function denyCancellation(requestId) {
  if (!confirm("Deny this cancellation request? The umpire will remain assigned.")) return;
  try {
    await updateDoc(doc(db, "cancellationRequests", requestId), {
      status:     "denied",
      resolvedAt: serverTimestamp()
    });
    pendingCancellations = pendingCancellations.filter(r => r.id !== requestId);
    renderPendingCancellations();
  } catch (err) {
    alert("Failed to deny: " + err.message);
  }
}

// Wire approve/deny via event delegation (add to existing document listener below)

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display = "none";

  loadPayRates();
  loadGames();
  loadTeamCalendars();
  loadFacilitiesIntoSelects();
  loadPendingCancellations();
});
