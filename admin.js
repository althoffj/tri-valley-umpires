// admin.js — admin panel: approvals, roster, game management, pay rates, notifications
import { db, app } from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
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
  where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let allGames      = [];
let allUmpires    = [];
let gameFilter    = "upcoming";
let currentRates  = { plate: 0, field: 0, extra: 0 }; // cached for Add Game form

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
  return `<span class="badge badge-${cls}">${esc(slot.type)}</span>${pay}${filled}`;
}

// ── Pending Approvals ─────────────────────────────────────────────────────────

async function loadPending() {
  const noteEl = document.getElementById("pendingNote");
  const listEl = document.getElementById("pendingList");

  try {
    const snap = await getDocs(query(
      collection(db, "umpires"),
      where("approved", "==", false),
      orderBy("submittedAt")
    ));

    if (snap.empty) {
      noteEl.textContent = "No pending approvals.";
      listEl.innerHTML = "";
      return;
    }

    noteEl.textContent = `${snap.size} umpire${snap.size !== 1 ? "s" : ""} awaiting approval.`;
    listEl.innerHTML = snap.docs.map(d => {
      const p = d.data();
      return `
        <div class="document-note" style="border-left-color:#ffcc80;margin-bottom:12px">
          <strong>${esc(p.name)}</strong> &mdash; ${esc(p.email)} &mdash; ${esc(p.phone)}<br>
          <span style="color:var(--light-text);font-size:0.85rem">
            ${esc(p.street)}, ${esc(p.city)}, ${esc(p.state)} ${esc(p.zip)}
            ${p.parentName ? ` | Parent: ${esc(p.parentName)}` : ""}
          </span>
          <div class="page-actions" style="margin-top:12px">
            <button class="btn approve-btn" data-uid="${esc(d.id)}">Approve</button>
            <button class="btn print-btn deny-btn" data-uid="${esc(d.id)}" data-name="${esc(p.name)}">Deny</button>
          </div>
          <p class="signup-message" id="pendingMsg_${esc(d.id)}"></p>
        </div>`;
    }).join("");
  } catch (err) {
    noteEl.textContent = "Failed to load pending approvals.";
    console.error(err);
  }
}

async function approveUmpire(uid) {
  const btn = document.querySelector(`.approve-btn[data-uid="${uid}"]`);
  if (btn) btn.disabled = true;
  try {
    await updateDoc(doc(db, "umpires", uid), { approved: true });
    setMsg(`pendingMsg_${uid}`, "Approved!", "success");
    setTimeout(() => loadPending(), 1200);
  } catch (err) {
    setMsg(`pendingMsg_${uid}`, err.message, "error");
    if (btn) btn.disabled = false;
  }
}

async function denyUmpire(uid, name) {
  if (!confirm(`Deny ${name}'s account?`)) return;
  try {
    await updateDoc(doc(db, "umpires", uid), { approved: false, denied: true });
    setMsg(`pendingMsg_${uid}`, "Marked as denied.", "warning");
    setTimeout(() => loadPending(), 1200);
  } catch (err) {
    setMsg(`pendingMsg_${uid}`, err.message, "error");
  }
}

// ── Roster ────────────────────────────────────────────────────────────────────

async function loadRoster() {
  const tbody = document.getElementById("rosterBody");
  try {
    const snap = await getDocs(query(collection(db, "umpires"), orderBy("lastName")));
    allUmpires = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:var(--light-text);text-align:center">No umpires yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = allUmpires.map(p => `
      <tr>
        <td>${esc(p.name)}</td>
        <td><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></td>
        <td>${esc(p.phone || "—")}</td>
        <td style="font-size:0.85rem">${esc(p.street || "")}, ${esc(p.city || "")} ${esc(p.state || "")} ${esc(p.zip || "")}</td>
        <td>
          ${p.approved
            ? '<span class="badge badge-upcoming">Approved</span>'
            : p.denied
              ? '<span class="badge badge-cancelled">Denied</span>'
              : '<span class="badge badge-today">Pending</span>'}
        </td>
        <td>
          ${p.approved
            ? `<button class="btn print-btn revoke-btn" data-uid="${esc(p.id)}" data-name="${esc(p.name)}">Revoke</button>`
            : !p.denied
              ? `<button class="btn approve-btn" data-uid="${esc(p.id)}">Approve</button>`
              : ""}
        </td>
      </tr>`).join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:#ffb4b4">Failed to load roster.</td></tr>`;
    console.error(err);
  }
}

async function revokeUmpire(uid, name) {
  if (!confirm(`Revoke approval for ${name}?`)) return;
  try {
    await updateDoc(doc(db, "umpires", uid), { approved: false });
    loadRoster();
  } catch (err) {
    alert(err.message);
  }
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
    tbody.innerHTML = `<tr><td colspan="9" style="color:#ffb4b4">Failed to load games.</td></tr>`;
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
    tbody.innerHTML = `<tr><td colspan="9" style="color:var(--light-text);text-align:center;padding:20px">No games.</td></tr>`;
    return;
  }

  tbody.innerHTML = visible.map(g => {
    const slots = g.umpireSlots || [];
    const teams = (g.homeTeam && g.awayTeam)
      ? `<div style="font-size:0.8rem;color:var(--light-text)">${esc(g.homeTeam)} vs ${esc(g.awayTeam)}</div>` : "";
    const slotHtml = slots.length
      ? slots.map((s, i) => `
          <div style="display:flex;align-items:center;gap:6px;${i > 0 ? "margin-top:4px" : ""}">
            ${slotBadge(s)}
            ${s.assignedUid && !g.cancelled
              ? `<button class="btn print-btn unassign-btn" style="font-size:0.75rem;padding:3px 8px"
                   data-game-id="${esc(g.id)}" data-slot-type="${esc(s.type)}">Unassign</button>`
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
  document.getElementById("editGameField").value     = game.field || "";
  document.getElementById("editHomeTeam").value      = game.homeTeam || "";
  document.getElementById("editAwayTeam").value      = game.awayTeam || "";

  // Render per-slot pay inputs from existing slots
  const slotsDiv = document.getElementById("editSlotPays");
  const slots = game.umpireSlots || [];
  slotsDiv.innerHTML = slots.map(s => {
    const cls = s.type === "Plate" ? "plate" : s.type === "Field" ? "field" : "extra";
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span class="badge badge-${cls}">${esc(s.type)}</span>
      ${s.assignedName ? `<span style="font-size:0.85rem;color:var(--light-text)">→ ${esc(s.assignedName)}</span>` : ""}
      <label style="margin:0;font-weight:normal;font-size:0.85rem">Pay $</label>
      <input type="number" min="0" step="0.01" value="${s.payRate != null ? s.payRate : ""}"
        class="edit-slot-pay" data-slot-type="${esc(s.type)}"
        style="width:70px;padding:4px 6px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:4px" />
    </div>`;
  }).join("") || '<span style="color:var(--light-text);font-size:0.85rem">No umpire slots</span>';

  setMsg("editGameMessage", "", "info");
  modal.style.display = "flex";
}

async function saveGameEdit() {
  const gameId = document.getElementById("editGameId").value;
  const btn    = document.getElementById("saveEditGameBtn");
  btn.disabled = true;
  setMsg("editGameMessage", "Saving…", "info");

  try {
    const updates = {
      city:      document.getElementById("editGameCity").value,
      division:  document.getElementById("editGameDivision").value,
      date:      document.getElementById("editGameDate").value,
      time:      document.getElementById("editGameTime").value,
      type:      document.getElementById("editGameType").value,
      field:     document.getElementById("editGameField").value.trim(),
      homeTeam:  document.getElementById("editHomeTeam").value.trim(),
      awayTeam:  document.getElementById("editAwayTeam").value.trim(),
      needsUmpires: true,
    };

    // Update per-slot pay rates
    const gameRef = doc(db, "games", gameId);
    const snap    = await getDoc(gameRef);
    if (snap.exists()) {
      const payInputs = document.querySelectorAll(".edit-slot-pay");
      const slots = (snap.data().umpireSlots || []).map(s => {
        const input = [...payInputs].find(i => i.dataset.slotType === s.type);
        return input ? { ...s, payRate: parseFloat(input.value) || 0 } : s;
      });
      updates.umpireSlots = slots;
    }

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

  const city     = document.getElementById("gameCity").value;
  const division = document.getElementById("gameDivision").value;
  const date     = document.getElementById("gameDate").value;
  const time     = document.getElementById("gameTime").value;
  const type     = document.getElementById("gameType").value;
  const field    = document.getElementById("gameField").value.trim();

  // Build slots with per-slot pay from inline inputs
  const umpireSlots = checkedTypes.map(t => {
    const payInput = document.querySelector(`.slot-pay-input[data-slot-type="${t}"]`);
    const payRate  = payInput ? (parseFloat(payInput.value) || 0) : 0;
    return { type: t, assignedUid: null, assignedName: null, payRate };
  });

  try {
    await addDoc(collection(db, "games"), {
      city, division, date, time, type, field,
      umpireSlots,
      needsUmpires: true,
      cancelled: false,
      createdAt: serverTimestamp()
    });
    setMsg("addGameMessage", "Game added!", "success");
    this.reset();
    document.querySelectorAll("#gameUmpireTypes input").forEach(cb => cb.checked = false);
    await loadGames();
  } catch (err) {
    setMsg("addGameMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
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
        <button class="btn print-btn edit-team-btn" data-index="${i}" style="flex-shrink:0">Edit</button>
        <button class="btn print-btn remove-team-btn" data-index="${i}" style="flex-shrink:0">Remove</button>
      </div>`).join("");
  } catch (err) {
    listEl.innerHTML = `<p style="color:#ffb4b4">Failed to load teams.</p>`;
  }
}

async function addTeam(name, icsUrl) {
  const { setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
  const snap = await getDoc(doc(db, "config", "teamCalendars"));
  const teams = snap.exists() ? (snap.data().teams || []) : [];
  const normalizedUrl = icsUrl.replace(/^webcal:\/\//i, "https://");
  teams.push({ name, icsUrl: normalizedUrl });
  await setDoc(doc(db, "config", "teamCalendars"), { teams });
}

async function removeTeam(index) {
  const { setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
  const snap = await getDoc(doc(db, "config", "teamCalendars"));
  const teams = snap.exists() ? (snap.data().teams || []) : [];
  teams.splice(index, 1);
  await setDoc(doc(db, "config", "teamCalendars"), { teams });
}

async function saveTeam(index, name, icsUrl) {
  const { setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
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
        style="width:100%;padding:6px 8px;background:var(--card-bg);color:var(--text);border:1px solid #555;border-radius:4px" />
      <input type="url" class="team-edit-url" value="${esc(currentUrl)}"
        style="width:100%;padding:6px 8px;background:var(--card-bg);color:var(--text);border:1px solid #555;border-radius:4px;font-size:0.82rem" />
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

// ── Calendar Sync (via Cloud Function — avoids GameChanger CORS block) ────────

async function syncGamesFromCalendars() {
  const btn = document.getElementById("syncCalBtn");
  btn.disabled = true;
  setMsg("syncCalMessage", "Syncing calendars…", "info");
  try {
    const functions   = getFunctions(app, "us-central1");
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

document.getElementById("syncCalBtn").addEventListener("click", syncGamesFromCalendars);

document.getElementById("importScheduleBtn").addEventListener("click", async () => {
  const btn = document.getElementById("importScheduleBtn");
  btn.disabled = true;
  setMsg("syncCalMessage", "Importing city schedule…", "info");
  try {
    const functions         = getFunctions(app, "us-central1");
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

// ── Pay rates ─────────────────────────────────────────────────────────────────

async function loadPayRates() {
  try {
    const snap = await getDoc(doc(db, "config", "payRates"));
    if (snap.exists()) {
      const r = snap.data();
      currentRates = { plate: r.plate || 0, field: r.field || 0, extra: r.extra || 0 };
      document.getElementById("ratePlate").value = r.plate || "";
      document.getElementById("rateField").value  = r.field  || "";
      document.getElementById("rateExtra").value  = r.extra  || "";
      // Pre-fill slot pay inputs in Add Game form
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

document.getElementById("payRatesForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  try {
    const { setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    await setDoc(doc(db, "config", "payRates"), {
      plate: parseFloat(document.getElementById("ratePlate").value) || 0,
      field: parseFloat(document.getElementById("rateField").value)  || 0,
      extra: parseFloat(document.getElementById("rateExtra").value)  || 0
    });
    setMsg("payRatesMessage", "Pay rates saved.", "success");
  } catch (err) {
    setMsg("payRatesMessage", err.message, "error");
  }
});

// ── Push notifications ────────────────────────────────────────────────────────

document.getElementById("notifForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn   = document.getElementById("sendNotifBtn");
  const title = document.getElementById("notifTitle").value.trim();
  const body  = document.getElementById("notifBody").value.trim();

  btn.disabled = true;
  setMsg("notifMessage", "Sending notifications…", "info");

  try {
    if (typeof emailjs !== "undefined") {
      emailjs.init("H9Z9Qz-HB-PehAQjp");
      const roster = allUmpires.filter(u => u.approved && u.email);
      await Promise.allSettled(roster.map(u =>
        emailjs.send("service_vljauqe", "template_notification", {
          to_name:     u.name,
          to_email:    u.email,
          notif_title: title,
          notif_body:  body
        })
      ));
    }
    setMsg("notifMessage", `Notification sent to ${allUmpires.filter(u => u.approved).length} umpires.`, "success");
    this.reset();
  } catch (err) {
    setMsg("notifMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Event delegation ──────────────────────────────────────────────────────────

document.addEventListener("click", e => {
  const approveBtn = e.target.closest(".approve-btn");
  if (approveBtn) { approveUmpire(approveBtn.dataset.uid); return; }

  const denyBtn = e.target.closest(".deny-btn");
  if (denyBtn) { denyUmpire(denyBtn.dataset.uid, denyBtn.dataset.name); return; }

  const revokeBtn = e.target.closest(".revoke-btn");
  if (revokeBtn) { revokeUmpire(revokeBtn.dataset.uid, revokeBtn.dataset.name); return; }

  const editGameBtn = e.target.closest(".edit-game-btn");
  if (editGameBtn) { openEditModal(editGameBtn.dataset.gameId); return; }

  const cancelGameBtn = e.target.closest(".cancel-game-btn");
  if (cancelGameBtn) { cancelGame(cancelGameBtn.dataset.gameId); return; }

  const deleteGameBtn = e.target.closest(".delete-game-btn");
  if (deleteGameBtn) { deleteGame(deleteGameBtn.dataset.gameId); return; }

  const unassignBtn = e.target.closest(".unassign-btn");
  if (unassignBtn) { unassignSlot(unassignBtn.dataset.gameId, unassignBtn.dataset.slotType); return; }

  const editTeamBtn = e.target.closest(".edit-team-btn");
  if (editTeamBtn) {
    const i = Number(editTeamBtn.dataset.index);
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
  if (cancelEditTeamBtn) {
    loadTeamCalendars();
    return;
  }

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

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display = "none";

  loadPending();
  loadRoster();
  loadGames();
  loadPayRates();
  loadTeamCalendars();
  loadIncidents();
});

// ── Incident Reports ──────────────────────────────────────────────────────────

async function loadIncidents() {
  const listEl = document.getElementById("incidentList");
  const noteEl = document.getElementById("incidentNote");
  if (!listEl) return;

  try {
    const snap = await getDocs(
      query(collection(db, "incidentReports"), orderBy("submittedAt", "desc"))
    );

    if (snap.empty) {
      noteEl.textContent = "No incident reports submitted yet.";
      listEl.innerHTML = "";
      return;
    }

    noteEl.textContent = `${snap.size} report${snap.size === 1 ? "" : "s"} on file.`;

    listEl.innerHTML = snap.docs.map(d => {
      const r = d.data();
      const date = r.submittedAt?.toDate
        ? r.submittedAt.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
        : "—";
      const gameLabel = [r.gameDate ? r.gameDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1") : "", r.gameCity, r.gameDivision].filter(Boolean).join(" · ");
      return `
        <div class="document-note" style="border-left-color:#f7c87e;margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
            <strong style="color:white">${esc(r.incidentType ?? "Incident")}</strong>
            <span style="color:var(--light-text);font-size:0.85rem">${esc(date)}</span>
          </div>
          <p style="margin:0 0 4px"><span style="color:var(--light-text)">Reported by:</span> ${esc(r.reporterName ?? "")}</p>
          ${gameLabel ? `<p style="margin:0 0 4px"><span style="color:var(--light-text)">Game:</span> ${esc(gameLabel)}</p>` : ""}
          ${r.involvedParties ? `<p style="margin:0 0 4px"><span style="color:var(--light-text)">Involved:</span> ${esc(r.involvedParties)}</p>` : ""}
          <p style="margin:8px 0 0;white-space:pre-wrap">${esc(r.description ?? "")}</p>
        </div>`;
    }).join("");
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<p style="color:#ffb4b4">Error loading incident reports.</p>';
  }
}
