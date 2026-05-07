// admin-games.js — Game management: sync, add, list, edit modal, team calendars
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
  setDoc,
  query,
  orderBy,
  serverTimestamp,
  where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let allGames     = [];
let gameFilter   = "upcoming";
let currentRates = { plate: 0, field: 0, extra: 0 };

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

// ── Facilities select population ──────────────────────────────────────────────

async function loadFacilitiesIntoSelects() {
  try {
    const snap = await getDocs(collection(db, "facilities"));
    const options = snap.docs.map(d =>
      `<option value="${esc(d.id)}">${esc(d.data().name)}</option>`
    ).join("");
    const addSel  = document.getElementById("gameFacility");
    const editSel = document.getElementById("editGameFacility");
    if (addSel)  addSel.innerHTML  = `<option value="">-- None / Other --</option>${options}`;
    if (editSel) editSel.innerHTML = `<option value="">-- None / Other --</option>${options}`;
  } catch (_) {}
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

  // Set facility select
  const editFacSel = document.getElementById("editGameFacility");
  if (editFacSel) editFacSel.value = game.facilityId || "";

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
      field:      document.getElementById("editGameField").value.trim(),
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
  const field      = document.getElementById("gameField").value.trim();
  const facilityId = document.getElementById("gameFacility")?.value || "";

  // Build slots with per-slot pay from inline inputs
  const umpireSlots = checkedTypes.map(t => {
    const payInput = document.querySelector(`.slot-pay-input[data-slot-type="${t}"]`);
    const payRate  = payInput ? (parseFloat(payInput.value) || 0) : 0;
    return { type: t, assignedUid: null, assignedName: null, payRate };
  });

  try {
    await addDoc(collection(db, "games"), {
      city, division, date, time, type, field, facilityId,
      umpireSlots,
      needsUmpires: true,
      cancelled: false,
      createdAt: serverTimestamp()
    });
    setMsg("addGameMessage", "Game added!", "success");
    this.reset();
    document.querySelectorAll("#gameUmpireTypes input").forEach(cb => cb.checked = false);
    document.querySelectorAll(".slot-pay-input").forEach(inp => { inp.disabled = true; inp.value = ""; });
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
  }
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

  loadPayRates();
  loadGames();
  loadTeamCalendars();
  loadFacilitiesIntoSelects();
});
