// admin-games.js — Game management: sync, add, list, edit modal, team calendars
import { db, app } from "./firebase.js";
import { authReadyPromise, isAdmin, isSuperAdmin } from "./auth.js";
import { esc, fmtDate, fmtTime, todayISO, setMsg, showToast, showConfirm } from "./utils.js";

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
  query,
  orderBy,
  serverTimestamp,
  where,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let allGames       = [];
let gameFilter     = "upcoming";
let currentRates   = { plate: 0, field: 0, extra: 0 };
let facilitiesData = []; // [{ id, name, fields:[{name,notes}] }]
let leaguesData    = []; // [{ id, name }] from leagues collection

// Active filter state
let gfFrom     = "";
let gfTo       = "";
let gfLeague   = "";
let gfDivision = "";
let gfTeam     = "";
let gfFacility = "";
let gfField    = "";
let gfUmpire   = "";

// ── Helpers ───────────────────────────────────────────────────────────────────

function cancelledLabel(g) {
  const type  = g.cancellationType || "cancelled";
  const notes = g.cancelNotes ? `<div style="color:var(--light-text);font-size:0.78rem;margin-top:3px;font-style:italic">${esc(g.cancelNotes)}</div>` : "";
  if (type === "rainout")     return `<span style="color:#8ab4f8">🌧 Rain Out</span>${notes}`;
  if (type === "rescheduled") return `<span style="color:#ffcc80">🔄 Rescheduled</span>${notes}`;
  return `<span style="color:#ffb4b4">⛔ Cancelled</span>${notes}`;
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
    const q = query(collection(db, "games"), orderBy("date"), orderBy("time"));
    const snap = await getDocs(q);
    allGames = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAdminGames();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:#ffb4b4">Failed to load games.</td></tr>`;
    console.error(err);
  }
}

function applyGameFilters() {
  const today = todayISO();
  return allGames.filter(g => {
    // Status filter
    if (gameFilter === "upcoming" && (g.cancelled || g.date < today)) return false;
    // Date range
    if (gfFrom && g.date < gfFrom) return false;
    if (gfTo   && g.date > gfTo)   return false;
    // League/program filter (check g.league first; fall back to g.city for old records)
    if (gfLeague && (g.league || g.city || "") !== gfLeague) return false;
    // Division
    if (gfDivision && (g.division || "") !== gfDivision) return false;
    // Team — match teamName, homeTeam, or awayTeam
    if (gfTeam) {
      const haystack = [g.teamName, g.homeTeam, g.awayTeam].map(v => (v||"").toLowerCase());
      if (!haystack.includes(gfTeam.toLowerCase())) return false;
    }
    // Facility
    if (gfFacility && (g.facilityId || "") !== gfFacility) return false;
    // Field
    if (gfField && (g.field || "") !== gfField) return false;
    // Umpire need
    if (gfUmpire === "needs") {
      if (!g.needsUmpires || g.cancelled) return false;
      const hasOpenSlot = (g.umpireSlots ?? []).some(s => !s.assignedUid);
      if (!hasOpenSlot) return false;
    }
    if (gfUmpire === "ref"   && g.needsUmpires !== false)           return false;
    return true;
  });
}

function buildFilterDropdowns() {
  const leagues   = [...new Set(allGames.map(g => g.league || g.city || "").filter(Boolean))].sort();
  const divisions = [...new Set(allGames.map(g => g.division || "").filter(Boolean))].sort();
  const teams     = [...new Set(
    allGames.flatMap(g => [g.teamName, g.homeTeam, g.awayTeam].filter(Boolean))
  )].sort();
  const facilities = facilitiesData.map(f => ({ id: f.id, name: f.name }));
  const fields    = [...new Set(allGames.map(g => g.field || "").filter(Boolean))].sort();

  const populate = (selId, items, valKey, labelKey) => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    const cur = sel.value;
    const first = sel.options[0].outerHTML;
    sel.innerHTML = first + items.map(it =>
      `<option value="${esc(valKey ? it[valKey] : it)}">${esc(labelKey ? it[labelKey] : it)}</option>`
    ).join("");
    sel.value = cur; // restore selection if still valid
  };

  populate("gfLeague",   leagues,    null,  null);
  populate("gfDivision", divisions,  null,  null);
  populate("gfTeam",     teams,      null,  null);
  populate("gfFacility", facilities, "id",  "name");
  populate("gfField",    fields,     null,  null);
}

function renderAdminGames() {
  const tbody = document.getElementById("adminGameBody");
  buildFilterDropdowns();
  const visible = applyGameFilters();

  const countEl = document.getElementById("gfCount");
  if (countEl) countEl.textContent = `${visible.length} game${visible.length !== 1 ? "s" : ""}`;

  if (visible.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:var(--light-text);text-align:center;padding:20px">No games match the current filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = visible.map(g => {
    const slots = g.umpireSlots || [];

    // Home/Away indicator + teams line
    const hasTeams = g.homeTeam || g.awayTeam;
    let locationBadge = "";
    if (hasTeams) {
      if (g.isAway === true) {
        locationBadge = `<span style="font-size:0.7rem;background:#2a1a3a;color:#c9a0ff;border:1px solid #6b3fa0;border-radius:4px;padding:1px 5px;margin-right:4px">AWAY</span>`;
      } else if (g.isAway === false) {
        locationBadge = `<span style="font-size:0.7rem;background:rgba(22,101,52,0.4);color:#86efac;border:1px solid #166534;border-radius:4px;padding:1px 5px;margin-right:4px">HOME</span>`;
      }
    }
    const teamsLine = hasTeams
      ? `<div style="font-size:0.8rem;color:var(--light-text)">${locationBadge}${esc(g.homeTeam||"")}${g.homeTeam && g.awayTeam ? (g.isAway ? " @ " : " vs ") : ""}${esc(g.awayTeam||"")}</div>`
      : "";

    // League + city badge
    const leagueParts = [g.league, g.city].filter(Boolean);
    const leagueBadge = leagueParts.length
      ? `<div style="font-size:0.72rem;color:#8ab4f8;margin-top:2px">${leagueParts.map(esc).join(" · ")}</div>`
      : "";

    const canAssign = isAdmin() && !g.cancelled;
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
    const notesHtml = g.notes
      ? `<div style="color:#ffe066;font-size:0.78rem;margin-top:4px" title="Admin notes">📋 ${esc(g.notes)}</div>` : "";

    const openSlotCount = !g.cancelled ? (g.umpireSlots || []).filter(s => !s.assignedUid).length : 0;
    const notifyBtn = openSlotCount > 0
      ? `<button class="btn print-btn notify-slots-btn" style="margin-bottom:4px;display:block;width:100%;font-size:0.8rem"
           data-game-id="${esc(g.id)}">Notify (${openSlotCount} open)</button>`
      : "";

    const cancelTint = g.cancelled
      ? (g.cancellationType === "rainout"     ? ";background:rgba(100,150,255,0.05)"
       : g.cancellationType === "rescheduled" ? ";background:rgba(255,204,0,0.04)"
       : "")
      : "";

    return `
    <tr style="${g.cancelled ? "opacity:0.6" : ""}${g.possibleChange ? ";background:rgba(255,204,0,0.06)" : ""}${cancelTint}">
      <td>${esc(fmtDate(g.date))}</td>
      <td>${esc(fmtTime(g.time))}</td>
      <td>${teamsLine}${leagueBadge}</td>
      <td>${esc(g.division || "—")}</td>
      <td>${esc(g.type || "—")}</td>
      <td>${esc(g.field || "—")}${linkedBadge}</td>
      <td>${g.cancelled ? cancelledLabel(g) : slotHtml}${changeWarning}${notesHtml}</td>
      <td style="white-space:nowrap;vertical-align:top">
        ${g.cancelled
          ? (g.cancellationType === "rescheduled"
              ? `<button class="btn print-btn makeup-btn" style="margin-bottom:4px;display:block;width:100%;font-size:0.8rem"
                   data-game-id="${esc(g.id)}">📅 Schedule Makeup</button>`
              : "")
          : `
          <button class="btn print-btn edit-game-btn" style="margin-bottom:4px;display:block;width:100%"
            data-game-id="${esc(g.id)}">Edit</button>
          <button class="btn print-btn cancel-game-btn" style="margin-bottom:4px;display:block;width:100%"
            data-game-id="${esc(g.id)}">Cancel</button>
          ${notifyBtn}`}
        <button class="btn delete-game-btn" style="display:block;width:100%;background:#5a1a1a"
          data-game-id="${esc(g.id)}">Delete</button>
      </td>
    </tr>`;
  }).join("");
}

// ── Cancel / Rainout / Reschedule modal ──────────────────────────────────────

function openCancelModal(gameId) {
  const game = allGames.find(g => g.id === gameId);
  if (!game) return;
  document.getElementById("cancelGameId").value    = gameId;
  document.getElementById("cancelGameInfo").textContent =
    `${fmtDate(game.date)} at ${fmtTime(game.time)} — ${[game.league, game.city].filter(Boolean).join(" · ")}${game.division ? " · " + game.division : ""}`;
  document.getElementById("cancelNotes").value     = "";
  document.getElementById("cancelGameMsg").textContent = "";
  document.getElementById("cancelGameMsg").className   = "signup-message";
  // Reset radio to first option
  document.querySelector('input[name="cancelType"][value="cancelled"]').checked = true;
  document.getElementById("rescheduleNote").style.display = "none";
  document.getElementById("cancelGameModal").style.display = "flex";
}

// ── Schedule Makeup ───────────────────────────────────────────────────────────

function scheduleMakeup(gameId) {
  const g = allGames.find(g => g.id === gameId);
  if (!g) return;
  // Scroll to the Add Game form
  const formEl = document.getElementById("addGameForm");
  formEl?.scrollIntoView({ behavior: "smooth", block: "start" });
  // Pre-fill matching fields; leave date blank so admin must pick the new date
  const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
  set("gameLeague",   g.league   || "");
  set("gameCity",     g.city     || "");
  set("gameDivision", g.division || "");
  set("gameTime",     g.time     || "");
  set("gameType",     g.type     || "");
  set("gameHomeTeam", g.homeTeam || "");
  set("gameAwayTeam", g.awayTeam || "");
  set("gameDate",     "");  // must be chosen by admin
  // Field text input
  const fieldInp = document.getElementById("gameField");
  const fieldSel = document.getElementById("gameFieldSelect");
  if (fieldInp) { fieldInp.value = g.field || ""; fieldInp.style.display = ""; }
  if (fieldSel) fieldSel.style.display = "none";
  // Restore umpire slot checkboxes + pay rates from original game
  document.querySelectorAll("#gameUmpireTypes input[type=checkbox]").forEach(cb => { cb.checked = false; });
  document.querySelectorAll(".slot-pay-input").forEach(inp => { inp.disabled = true; inp.value = ""; });
  (g.umpireSlots || []).forEach(slot => {
    const cb = document.querySelector(`#gameUmpireTypes input[value="${slot.type}"]`);
    if (cb) {
      cb.checked = true;
      const payInp = document.querySelector(`.slot-pay-input[data-slot-type="${slot.type}"]`);
      if (payInp) { payInp.value = slot.payRate != null ? slot.payRate : ""; payInp.disabled = false; }
    }
  });
  setMsg("addGameMessage", `ℹ Makeup game pre-filled from ${fmtDate(g.date)} rescheduled game — set a new date and submit.`, "info");
}

// Show/hide the reschedule note when radio changes
document.querySelectorAll('input[name="cancelType"]').forEach(radio => {
  radio.addEventListener("change", () => {
    document.getElementById("rescheduleNote").style.display =
      document.querySelector('input[name="cancelType"]:checked')?.value === "rescheduled" ? "" : "none";
  });
});

document.getElementById("confirmCancelBtn").addEventListener("click", async () => {
  const gameId = document.getElementById("cancelGameId").value;
  const type   = document.querySelector('input[name="cancelType"]:checked')?.value || "cancelled";
  const notes  = document.getElementById("cancelNotes").value.trim();
  const btn    = document.getElementById("confirmCancelBtn");
  const msgEl  = document.getElementById("cancelGameMsg");
  btn.disabled    = true;
  msgEl.textContent = "Cancelling…";
  msgEl.className   = "signup-message info";
  try {
    await updateDoc(doc(db, "games", gameId), {
      cancelled:        true,
      cancelledAt:      serverTimestamp(),
      cancellationType: type,
      ...(notes ? { cancelNotes: notes } : {}),
    });
    // Fire-and-forget: push + Slack notification to any assigned umpires
    const game = allGames.find(g => g.id === gameId);
    const assignedCount = (game?.umpireSlots || []).filter(s => s.assignedUid).length;
    if (assignedCount > 0) {
      try {
        const notifyCancelFn = httpsCallable(getFunctions(app, "us-central1"), "notifyGameCancellation");
        notifyCancelFn({ gameId, type, notes }).catch(() => {});
      } catch (_) {}
    }
    if (game) { game.cancelled = true; game.cancellationType = type; if (notes) game.cancelNotes = notes; }
    document.getElementById("cancelGameModal").style.display = "none";
    renderAdminGames();
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className   = "signup-message error";
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("closeCancelModalBtn").addEventListener("click", () => {
  document.getElementById("cancelGameModal").style.display = "none";
});
document.getElementById("cancelGameModal").addEventListener("click", e => {
  if (e.target === document.getElementById("cancelGameModal"))
    document.getElementById("cancelGameModal").style.display = "none";
});

async function unassignSlot(gameId, slotType) {
  if (!await showConfirm(`Remove the umpire from the ${slotType} slot?`)) return;
  try {
    const gameRef = doc(db, "games", gameId);
    let updatedSlots;
    await runTransaction(db, async tx => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game not found.");
      updatedSlots = (snap.data().umpireSlots || []).map(s =>
        s.type === slotType ? { type: s.type, payRate: s.payRate ?? 0 } : s
      );
      tx.update(gameRef, { umpireSlots: updatedSlots, needsUmpires: true });
    });
    const g = allGames.find(g => g.id === gameId);
    if (g) { g.umpireSlots = updatedSlots; g.needsUmpires = true; }
    renderAdminGames();
  } catch (err) {
    showToast(err.message);
  }
}

async function notifyOpenSlots(gameId) {
  const game = allGames.find(g => g.id === gameId);
  if (!game) return;
  const open = (game.umpireSlots || []).filter(s => !s.assignedUid);
  if (open.length === 0) { showToast("No open slots on this game."); return; }
  const slotTypes = open.map(s => s.type).join(", ");
  const label = `${fmtDate(game.date)} at ${fmtTime(game.time)} — ${[game.league, game.city].filter(Boolean).join(" · ")} ${game.division || ""}${game.field ? " · " + game.field : ""}`;
  if (!await showConfirm(`Send Slack + push notification to all umpires about open slots?\n\n${label}\nOpen: ${slotTypes}`)) return;

  try {
    const functions  = getFunctions(app, "us-central1");
    const notifyFn   = httpsCallable(functions, "notifyOpenSlots");
    await notifyFn({ gameId });
    const btnEl = document.querySelector(`.notify-slots-btn[data-game-id="${gameId}"]`);
    if (btnEl) { btnEl.textContent = "Notified ✓"; btnEl.disabled = true; }
  } catch (err) {
    showToast("Notification failed: " + err.message);
  }
}

async function deleteGame(gameId) {
  const game = allGames.find(g => g.id === gameId);
  if (!game) return;
  if (!await showConfirm(`Permanently delete the game on ${fmtDate(game.date)} at ${[game.league, game.city].filter(Boolean).join(" · ") || ""}?\nThis cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, "games", gameId));
    allGames = allGames.filter(g => g.id !== gameId);
    renderAdminGames();
  } catch (err) {
    showToast(err.message);
  }
}

function openEditModal(gameId) {
  const game = allGames.find(g => g.id === gameId);
  if (!game) return;
  const modal = document.getElementById("editGameModal");

  document.getElementById("editGameId").value        = gameId;
  document.getElementById("editGameLeague").value    = game.league || "";
  document.getElementById("editGameCity").value      = game.city || "";
  document.getElementById("editGameDivision").value  = game.division || "";
  document.getElementById("editGameDate").value      = game.date || "";
  document.getElementById("editGameTime").value      = game.time || "";
  document.getElementById("editGameType").value      = game.type || "Regular";
  document.getElementById("editHomeTeam").value      = game.homeTeam || "";
  document.getElementById("editAwayTeam").value      = game.awayTeam || "";
  document.getElementById("editIsAway").checked      = game.isAway === true;
  document.getElementById("editGameNotes").value     = game.notes || "";

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
  const gameId   = document.getElementById("editGameId").value;
  const btn      = document.getElementById("saveEditGameBtn");
  const date     = document.getElementById("editGameDate").value;
  const division = document.getElementById("editGameDivision").value;
  const league   = document.getElementById("editGameLeague").value.trim();
  const city     = document.getElementById("editGameCity").value.trim();

  if (!date)     { setMsg("editGameMessage", "Date is required.", "error"); return; }
  if (!division) { setMsg("editGameMessage", "Division is required.", "error"); return; }
  if (!league && !city) { setMsg("editGameMessage", "League or city is required.", "error"); return; }

  btn.disabled = true;
  setMsg("editGameMessage", "Saving…", "info");

  try {
    const facilityId = document.getElementById("editGameFacility")?.value || "";
    const updates = {
      league,
      city,
      division,
      date,
      time:       document.getElementById("editGameTime").value,
      type:       document.getElementById("editGameType").value,
      field:      getFieldValue("editGameFieldSelect", "editGameField"),
      homeTeam:   document.getElementById("editHomeTeam").value.trim(),
      awayTeam:   document.getElementById("editAwayTeam").value.trim(),
      isAway:     document.getElementById("editIsAway").checked,
      facilityId: facilityId,
      needsUmpires: true,
      notes:      document.getElementById("editGameNotes").value.trim(),
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
    label.textContent = `${slotType} slot — ${[game.league, game.city].filter(Boolean).join(" · ")} ${fmtDate(game.date)} ${fmtTime(game.time)}`;
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
    let updatedSlots;
    await runTransaction(db, async tx => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game not found.");
      const current = snap.data().umpireSlots || [];
      const target  = current.find(s => s.type === slotType);
      if (target?.assignedUid && target.assignedUid !== uid) {
        throw new Error("Slot was just assigned to someone else. Refresh and try again.");
      }
      updatedSlots = current.map(s =>
        s.type === slotType ? { ...s, assignedUid: uid, assignedName: name } : s
      );
      const needsUmpires = updatedSlots.some(s => !s.assignedUid);
      tx.update(gameRef, { umpireSlots: updatedSlots, needsUmpires });
    });
    const g = allGames.find(g => g.id === gameId);
    if (g) { g.umpireSlots = updatedSlots; g.needsUmpires = updatedSlots.some(s => !s.assignedUid); }
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

  const league   = document.getElementById("gameLeague").value.trim();
  const city     = document.getElementById("gameCity").value.trim();
  const division = document.getElementById("gameDivision").value;
  const date     = document.getElementById("gameDate").value;

  if (!date)     { setMsg("addGameMessage", "Date is required.", "error"); return; }
  if (!division) { setMsg("addGameMessage", "Division is required.", "error"); return; }
  if (!league && !city) { setMsg("addGameMessage", "League or city is required.", "error"); return; }

  btn.disabled = true;
  setMsg("addGameMessage", "Adding game…", "info");
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
      league, city, division, date, time, type, field, facilityId,
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

async function loadLeagues() {
  try {
    const snap = await getDocs(query(collection(db, "leagues"), orderBy("name")));
    leaguesData = snap.docs.map(d => ({ id: d.id, name: d.data().name || d.id }));
  } catch (_) {
    leaguesData = [];
  }
  populateLeagueSelects();
}

function populateLeagueSelects() {
  const opts = leaguesData.map(l => `<option value="${esc(l.name)}">${esc(l.name)}</option>`).join("");
  ["gameLeague", "editGameLeague"].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = `<option value="">— None —</option>${opts}`;
    if (cur) sel.value = cur;
  });
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
  if (cancelGameBtn) { openCancelModal(cancelGameBtn.dataset.gameId); return; }

  const deleteGameBtn = e.target.closest(".delete-game-btn");
  if (deleteGameBtn) { deleteGame(deleteGameBtn.dataset.gameId); return; }

  const unassignBtn = e.target.closest(".unassign-btn");
  if (unassignBtn) { unassignSlot(unassignBtn.dataset.gameId, unassignBtn.dataset.slotType); return; }

  const assignBtn = e.target.closest(".assign-btn");
  if (assignBtn) { openAssignModal(assignBtn.dataset.gameId, assignBtn.dataset.slotType); return; }

  const notifyBtn = e.target.closest(".notify-slots-btn");
  if (notifyBtn) { notifyOpenSlots(notifyBtn.dataset.gameId); return; }

  const makeupBtn = e.target.closest(".makeup-btn");
  if (makeupBtn) { scheduleMakeup(makeupBtn.dataset.gameId); return; }

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
  if (!await showConfirm("Approve this cancellation? The umpire will be removed from the slot.")) return;
  try {
    // Use a transaction so needsUmpires is set atomically with the slot change
    const gameRef = doc(db, "games", gameId);
    let updatedSlots;
    await runTransaction(db, async tx => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game not found.");
      updatedSlots = (snap.data().umpireSlots || []).map(s =>
        s.type === slotType && s.assignedUid === uid
          ? { type: s.type, payRate: s.payRate }   // strip all assignment fields
          : s
      );
      tx.update(gameRef, { umpireSlots: updatedSlots, needsUmpires: true });
    });

    // Update request status
    await updateDoc(doc(db, "cancellationRequests", requestId), {
      status:     "approved",
      resolvedAt: serverTimestamp()
    });

    // Update local allGames cache
    const g = allGames.find(g => g.id === gameId);
    if (g) { g.umpireSlots = updatedSlots; g.needsUmpires = true; }

    // Remove from local list and re-render both
    pendingCancellations = pendingCancellations.filter(r => r.id !== requestId);
    renderPendingCancellations();
    renderAdminGames();
  } catch (err) {
    showToast("Failed to approve: " + err.message);
  }
}

async function denyCancellation(requestId) {
  if (!await showConfirm("Deny this cancellation request? The umpire will remain assigned.")) return;
  try {
    await updateDoc(doc(db, "cancellationRequests", requestId), {
      status:     "denied",
      resolvedAt: serverTimestamp()
    });
    pendingCancellations = pendingCancellations.filter(r => r.id !== requestId);
    renderPendingCancellations();
  } catch (err) {
    showToast("Failed to deny: " + err.message);
  }
}

// Wire approve/deny via event delegation (add to existing document listener below)

// ── Game filter controls ──────────────────────────────────────────────────────

function wireGameFilters() {
  const onChange = () => renderAdminGames();

  document.getElementById("gfFrom")?.addEventListener("change",   e => { gfFrom     = e.target.value; onChange(); });
  document.getElementById("gfTo")?.addEventListener("change",     e => { gfTo       = e.target.value; onChange(); });
  document.getElementById("gfLeague")?.addEventListener("change", e => { gfLeague   = e.target.value; onChange(); });
  document.getElementById("gfDivision")?.addEventListener("change",e => { gfDivision = e.target.value; onChange(); });
  document.getElementById("gfTeam")?.addEventListener("change",   e => { gfTeam     = e.target.value; onChange(); });
  document.getElementById("gfFacility")?.addEventListener("change",e => { gfFacility = e.target.value; onChange(); });
  document.getElementById("gfField")?.addEventListener("change",  e => { gfField    = e.target.value; onChange(); });
  document.getElementById("gfUmpire")?.addEventListener("change", e => { gfUmpire   = e.target.value; onChange(); });

  document.getElementById("gfResetBtn")?.addEventListener("click", () => {
    gfFrom = gfTo = gfLeague = gfDivision = gfTeam = gfFacility = gfField = gfUmpire = "";
    ["gfFrom","gfTo","gfLeague","gfDivision","gfTeam","gfFacility","gfField","gfUmpire"]
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
    renderAdminGames();
  });
}

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
  loadLeagues();
  loadGames();
  loadFacilitiesIntoSelects();
  loadPendingCancellations();
  wireGameFilters();
});
