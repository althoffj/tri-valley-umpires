// admin-tournament.js — Tournament management (create, rain delay, field swap)
import { db } from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import {
  collection, getDocs, addDoc, doc, updateDoc, deleteDoc,
  query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import { esc, fmtDate, fmtTime, setMsg, showToast } from "./utils.js";

const fns         = getFunctions();
const notifySwap  = httpsCallable(fns, "notifyTournamentSwap");

// ── State ─────────────────────────────────────────────────────────────────────

let allTournaments = [];
let allGames       = [];
let expandedTid    = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function addMinutesToTime(timeStr, minutes) {
  if (!timeStr) return timeStr;
  const [h, m] = timeStr.split(":").map(Number);
  const total  = h * 60 + m + minutes;
  const nh     = Math.floor(total / 60) % 24;
  const nm     = total % 60;
  return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
}

function statusBadgeHtml(status) {
  const map = {
    scheduled:    { bg: "#1a2a3a", color: "#7ec8f7",  label: "Scheduled"   },
    active:       { bg: "#17351f", color: "#b8f2c4",  label: "Active"      },
    "rain-delay": { bg: "#4a3a00", color: "#ffd966",  label: "Rain Delay"  },
    complete:     { bg: "#333",    color: "#aaa",      label: "Complete"    }
  };
  const s = map[status] || map.scheduled;
  return `<span class="badge" style="background:${s.bg};color:${s.color}">${s.label}</span>`;
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadAll() {
  const [tSnap, gSnap] = await Promise.all([
    getDocs(query(collection(db, "tournaments"), orderBy("date", "desc"))),
    getDocs(query(collection(db, "games"), orderBy("date", "asc")))
  ]);
  allTournaments = tSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  allGames       = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  render();
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  const el = document.getElementById("tournamentList");
  if (!allTournaments.length) {
    el.innerHTML = `<p style="color:var(--light-text)">No tournaments yet. Create one above.</p>`;
    return;
  }
  el.innerHTML = allTournaments.map(t => renderCard(t)).join("");
}

function renderCard(t) {
  const linked   = allGames.filter(g => g.tournamentId === t.id);
  const expanded = expandedTid === t.id;

  return `
    <div class="document-note" style="margin-bottom:12px${expanded ? ";border-left-color:#7ec8f7" : ""}">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div>
          <strong style="color:white;font-size:1.05rem">🏆 ${esc(t.name)}</strong>
          <div style="color:var(--light-text);font-size:0.85rem;margin-top:3px">
            ${esc(fmtDate(t.date))}
            ${t.location ? " · " + esc(t.location) : ""}
            ${t.division ? " · " + esc(t.division) : ""}
            · ${linked.length} game${linked.length !== 1 ? "s" : ""}
            ${t.fields?.length ? " · Fields: " + esc(t.fields.join(", ")) : ""}
          </div>
          ${t.notes ? `<div style="color:var(--light-text);font-size:0.82rem;margin-top:2px;font-style:italic">${esc(t.notes)}</div>` : ""}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${statusBadgeHtml(t.status || "scheduled")}
          <button class="btn print-btn tournament-expand-btn" data-tid="${esc(t.id)}"
            style="font-size:0.8rem;padding:4px 12px">${expanded ? "▲ Collapse" : "▼ Manage"}</button>
          <button class="btn tournament-delete-btn" data-tid="${esc(t.id)}"
            style="font-size:0.8rem;padding:4px 12px;background:#5a1a1a">Delete</button>
        </div>
      </div>
      ${expanded ? renderDetail(t, linked) : ""}
    </div>`;
}

function renderDetail(t, linked) {
  const tid = t.id;

  // Status buttons
  const statusBtns = [
    { key: "scheduled",    label: "Scheduled"   },
    { key: "active",       label: "Active"       },
    { key: "rain-delay",   label: "Rain Delay"  },
    { key: "complete",     label: "Complete"     }
  ].map(({ key, label }) => {
    const cur = (t.status || "scheduled") === key;
    return `<button class="btn ${cur ? "" : "print-btn"} tournament-status-btn"
      data-tid="${esc(tid)}" data-status="${key}"
      style="font-size:0.8rem;padding:4px 12px" ${cur ? "disabled" : ""}>${label}</button>`;
  }).join("");

  // Game rows — sorted by time
  const sorted = [...linked].sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  const gameRows = sorted.length
    ? sorted.map(g => {
        const umpires = (g.umpireSlots || []).map(s =>
          s.assignedName
            ? `${s.type}: <strong>${esc(s.assignedName)}</strong>`
            : `${s.type}: <em style="color:var(--light-text)">unassigned</em>`
        ).join(" · ") || `<em style="color:var(--light-text)">No slots</em>`;

        return `<tr>
          <td style="text-align:center">
            <input type="checkbox" class="swap-select" data-gid="${esc(g.id)}" data-tid="${esc(tid)}"
              style="width:16px;height:16px;cursor:pointer">
          </td>
          <td style="white-space:nowrap">${esc(fmtTime(g.time))}</td>
          <td>${esc(g.field || "—")}</td>
          <td style="font-size:0.85rem">${esc(g.city || "")} ${esc(g.division || "")}</td>
          <td style="font-size:0.85rem">${umpires}</td>
          <td>
            <button class="btn print-btn tournament-unlink-btn" data-gid="${esc(g.id)}" data-tid="${esc(tid)}"
              style="font-size:0.75rem;padding:2px 8px">Unlink</button>
          </td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" style="color:var(--light-text);text-align:center;padding:12px">No games linked yet. Add games below.</td></tr>`;

  // Linkable games — same date, not already in a tournament, not cancelled
  const linkable = allGames.filter(g =>
    g.date === t.date && !g.tournamentId && !g.cancelled
  );
  const linkOptions = linkable.length
    ? linkable.map(g =>
        `<option value="${esc(g.id)}">${esc(fmtDate(g.date))} ${esc(fmtTime(g.time))} — ${esc(g.city || "")} ${esc(g.division || "")}${g.field ? " · " + esc(g.field) : ""}</option>`
      ).join("")
    : "";

  const rainTotal = t.rainDelayMinutes || 0;

  return `
    <hr style="border-color:#444;margin:16px 0">

    <!-- Status -->
    <div style="margin-bottom:16px">
      <div style="color:var(--light-text);font-size:0.82rem;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em">Tournament Status</div>
      <div class="page-actions" style="margin:0;flex-wrap:wrap;gap:6px">${statusBtns}</div>
    </div>

    <!-- Rain Delay -->
    <div style="margin-bottom:16px;padding:14px;background:rgba(255,217,102,0.06);border:1px solid #5a4a00;border-radius:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px">
        <div>
          <strong style="color:#ffd966">⛈ Rain Delay</strong>
          <span style="color:var(--light-text);font-size:0.85rem;margin-left:10px">
            ${rainTotal > 0 ? `${rainTotal} min added to all game times` : "No delay applied yet"}
          </span>
        </div>
        ${rainTotal > 0
          ? `<button class="btn print-btn tournament-reset-delay-btn" data-tid="${esc(tid)}"
               style="font-size:0.8rem;padding:4px 10px">↩ Restore Original Times</button>`
          : ""}
      </div>
      <div class="page-actions" style="margin:0;gap:6px">
        <button class="btn print-btn tournament-delay-btn" data-tid="${esc(tid)}" data-minutes="15"
          style="font-size:0.85rem;padding:5px 14px">+15 min</button>
        <button class="btn print-btn tournament-delay-btn" data-tid="${esc(tid)}" data-minutes="30"
          style="font-size:0.85rem;padding:5px 14px">+30 min</button>
        <button class="btn print-btn tournament-delay-btn" data-tid="${esc(tid)}" data-minutes="60"
          style="font-size:0.85rem;padding:5px 14px">+60 min</button>
      </div>
      <p id="delayMsg_${esc(tid)}" class="signup-message" style="margin:6px 0 0;min-height:0"></p>
    </div>

    <!-- Games + Swap -->
    <div style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <strong>Linked Games (${linked.length})</strong>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="color:var(--light-text);font-size:0.82rem">Check 2 games, then:</span>
          <button class="btn tournament-swap-btn" data-tid="${esc(tid)}"
            style="font-size:0.82rem;padding:5px 14px">⇄ Swap Umpires</button>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th style="width:32px"></th>
              <th>Time</th>
              <th>Field</th>
              <th>Game</th>
              <th>Umpire Assignments</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${gameRows}</tbody>
        </table>
      </div>
      <p id="swapMsg_${esc(tid)}" class="signup-message" style="margin:6px 0 0;min-height:0"></p>
    </div>

    <!-- Link a game -->
    ${linkable.length ? `
    <div style="padding:14px;background:#1a1a1a;border-radius:8px;border:1px solid #444">
      <div style="color:var(--light-text);font-size:0.82rem;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.04em">Add Existing Game to Tournament</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select id="linkGameSelect_${esc(tid)}"
          style="flex:1;min-width:200px;padding:8px 10px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px">
          <option value="">-- Select game --</option>
          ${linkOptions}
        </select>
        <button class="btn tournament-link-btn" data-tid="${esc(tid)}"
          style="font-size:0.85rem;padding:6px 14px">Add</button>
      </div>
    </div>` : ""}
    ${!linkable.length && !linked.length ? `<p style="color:var(--light-text);font-size:0.85rem;margin-top:8px">No unlinked games on ${esc(fmtDate(t.date))}. Add games for this date on the <a href="admin-games.html">Games</a> page first.</p>` : ""}
    <p id="tournamentMsg_${esc(tid)}" class="signup-message" style="margin:8px 0 0;min-height:0"></p>
  `;
}

// ── Create Tournament ─────────────────────────────────────────────────────────

async function createTournament(e) {
  e.preventDefault();
  const name     = document.getElementById("tName").value.trim();
  const date     = document.getElementById("tDate").value;
  const location = document.getElementById("tLocation").value.trim();
  const division = document.getElementById("tDivision").value;
  const fieldsRaw = document.getElementById("tFields").value;
  const notes    = document.getElementById("tNotes").value.trim();

  if (!name || !date) {
    setMsg("createTournamentMsg", "Name and date are required.", "error");
    return;
  }

  const fields = fieldsRaw.split(",").map(f => f.trim()).filter(Boolean);

  setMsg("createTournamentMsg", "Creating…", "info");
  try {
    const ref = await addDoc(collection(db, "tournaments"), {
      name, date, location, division, fields, notes,
      status: "scheduled",
      rainDelayMinutes: 0,
      originalTimes: {},
      createdAt: serverTimestamp()
    });
    e.target.reset();
    setMsg("createTournamentMsg", `Tournament "${name}" created.`, "success");
    // Optimistically add + expand
    allTournaments.unshift({ id: ref.id, name, date, location, division, fields, notes, status: "scheduled", rainDelayMinutes: 0, originalTimes: {} });
    expandedTid = ref.id;
    render();
  } catch (err) {
    console.error(err);
    setMsg("createTournamentMsg", err.message, "error");
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

async function setStatus(tid, status) {
  try {
    await updateDoc(doc(db, "tournaments", tid), { status });
    const t = allTournaments.find(x => x.id === tid);
    if (t) t.status = status;
    render();
  } catch (err) {
    console.error(err);
    showToast("Failed to update status: " + err.message);
  }
}

// ── Rain Delay ────────────────────────────────────────────────────────────────

async function applyDelay(tid, minutes) {
  const t      = allTournaments.find(x => x.id === tid);
  const linked = allGames.filter(g => g.tournamentId === tid && !g.cancelled);
  if (!t) return;

  if (!linked.length) {
    setMsg(`delayMsg_${tid}`, "No linked games to delay.", "warning");
    return;
  }

  setMsg(`delayMsg_${tid}`, "Applying delay…", "info");

  try {
    // Snapshot original times before first delay
    const origTimes = { ...(t.originalTimes || {}) };
    linked.forEach(g => {
      if (!origTimes[g.id]) origTimes[g.id] = g.time || "";
    });

    const updates = linked.map(g => {
      const newTime = addMinutesToTime(g.time || "09:00", minutes);
      g.time = newTime;
      return updateDoc(doc(db, "games", g.id), { time: newTime });
    });

    const newDelay = (t.rainDelayMinutes || 0) + minutes;
    await Promise.all([
      ...updates,
      updateDoc(doc(db, "tournaments", tid), {
        rainDelayMinutes: newDelay,
        originalTimes: origTimes
      })
    ]);

    t.rainDelayMinutes = newDelay;
    t.originalTimes    = origTimes;

    setMsg(`delayMsg_${tid}`,
      `+${minutes} min applied to ${linked.length} game${linked.length !== 1 ? "s" : ""}.`,
      "success");
    render();
  } catch (err) {
    console.error(err);
    setMsg(`delayMsg_${tid}`, "Failed: " + err.message, "error");
  }
}

// ── Reset Delay ───────────────────────────────────────────────────────────────

async function resetDelay(tid) {
  const t = allTournaments.find(x => x.id === tid);
  if (!t || !t.originalTimes || !Object.keys(t.originalTimes).length) return;
  if (!confirm("Restore all linked games to their original start times?")) return;

  const linked = allGames.filter(g => g.tournamentId === tid);
  setMsg(`delayMsg_${tid}`, "Resetting…", "info");

  try {
    const updates = linked.map(g => {
      const orig = t.originalTimes[g.id];
      if (!orig) return Promise.resolve();
      g.time = orig;
      return updateDoc(doc(db, "games", g.id), { time: orig });
    });

    await Promise.all([
      ...updates,
      updateDoc(doc(db, "tournaments", tid), { rainDelayMinutes: 0, originalTimes: {} })
    ]);

    t.rainDelayMinutes = 0;
    t.originalTimes    = {};
    setMsg(`delayMsg_${tid}`, "All times restored to original.", "success");
    render();
  } catch (err) {
    console.error(err);
    setMsg(`delayMsg_${tid}`, "Failed: " + err.message, "error");
  }
}

// ── Swap Umpires ──────────────────────────────────────────────────────────────

async function swapUmpires(tid, gid1, gid2) {
  const g1 = allGames.find(g => g.id === gid1);
  const g2 = allGames.find(g => g.id === gid2);
  const t  = allTournaments.find(x => x.id === tid);
  if (!g1 || !g2 || !t) return;

  const slots1 = g1.umpireSlots || [];
  const slots2 = g2.umpireSlots || [];

  const label1 = `${fmtTime(g1.time)} ${g1.field ? "· " + g1.field : ""}`.trim();
  const label2 = `${fmtTime(g2.time)} ${g2.field ? "· " + g2.field : ""}`.trim();

  if (!confirm(`Swap all umpire assignments between:\n\n  ${label1}\n  ${label2}\n\nAffected umpires will receive a push notification. Proceed?`)) return;

  setMsg(`swapMsg_${tid}`, "Swapping…", "info");

  try {
    await Promise.all([
      updateDoc(doc(db, "games", gid1), { umpireSlots: slots2 }),
      updateDoc(doc(db, "games", gid2), { umpireSlots: slots1 })
    ]);

    // Update in-memory
    g1.umpireSlots = slots2;
    g2.umpireSlots = slots1;

    // Notify via Cloud Function (non-critical)
    notifySwap({
      tournamentId:   tid,
      tournamentName: t.name,
      game1:  { id: gid1, field: g1.field || "", time: label1 },
      game2:  { id: gid2, field: g2.field || "", time: label2 },
      umpires1: slots1.filter(s => s.assignedUid).map(s => ({ uid: s.assignedUid, name: s.assignedName || "" })),
      umpires2: slots2.filter(s => s.assignedUid).map(s => ({ uid: s.assignedUid, name: s.assignedName || "" }))
    }).catch(err => console.warn("Swap notification failed:", err));

    // Uncheck all checkboxes for this tournament
    document.querySelectorAll(`.swap-select[data-tid="${tid}"]`)
      .forEach(cb => { cb.checked = false; });

    setMsg(`swapMsg_${tid}`, "Assignments swapped. Notifications sent.", "success");
    render();
  } catch (err) {
    console.error(err);
    setMsg(`swapMsg_${tid}`, "Failed: " + err.message, "error");
  }
}

// ── Link / Unlink Games ───────────────────────────────────────────────────────

async function linkGame(tid, gameId) {
  if (!gameId) {
    setMsg(`tournamentMsg_${tid}`, "Select a game to add.", "warning");
    return;
  }
  try {
    await updateDoc(doc(db, "games", gameId), { tournamentId: tid });
    const g = allGames.find(x => x.id === gameId);
    if (g) g.tournamentId = tid;
    render();
  } catch (err) {
    console.error(err);
    showToast("Failed to link game: " + err.message);
  }
}

async function unlinkGame(gameId, tid) {
  if (!confirm("Remove this game from the tournament? The game itself will not be deleted.")) return;
  try {
    await updateDoc(doc(db, "games", gameId), { tournamentId: null });
    const g = allGames.find(x => x.id === gameId);
    if (g) g.tournamentId = null;
    render();
  } catch (err) {
    console.error(err);
    showToast("Failed to unlink game: " + err.message);
  }
}

// ── Delete Tournament ─────────────────────────────────────────────────────────

async function deleteTournament(tid) {
  const t      = allTournaments.find(x => x.id === tid);
  const linked = allGames.filter(g => g.tournamentId === tid);
  if (!t) return;

  const msg = `Delete tournament "${t.name}"?${linked.length
    ? `\n\n${linked.length} linked game${linked.length !== 1 ? "s" : ""} will be unlinked (not deleted).`
    : ""}`;
  if (!confirm(msg)) return;

  try {
    // Unlink all games first
    await Promise.all(linked.map(g =>
      updateDoc(doc(db, "games", g.id), { tournamentId: null })
    ));
    linked.forEach(g => { g.tournamentId = null; });

    await deleteDoc(doc(db, "tournaments", tid));
    allTournaments = allTournaments.filter(x => x.id !== tid);
    if (expandedTid === tid) expandedTid = null;
    render();
  } catch (err) {
    console.error(err);
    showToast("Failed to delete tournament: " + err.message);
  }
}

// ── Event Delegation ──────────────────────────────────────────────────────────

document.addEventListener("click", async (e) => {
  const expandBtn = e.target.closest(".tournament-expand-btn");
  if (expandBtn) {
    const tid = expandBtn.dataset.tid;
    expandedTid = expandedTid === tid ? null : tid;
    render();
    return;
  }

  const deleteBtn = e.target.closest(".tournament-delete-btn");
  if (deleteBtn) { await deleteTournament(deleteBtn.dataset.tid); return; }

  const statusBtn = e.target.closest(".tournament-status-btn");
  if (statusBtn) { await setStatus(statusBtn.dataset.tid, statusBtn.dataset.status); return; }

  const delayBtn = e.target.closest(".tournament-delay-btn");
  if (delayBtn) {
    await applyDelay(delayBtn.dataset.tid, parseInt(delayBtn.dataset.minutes, 10));
    return;
  }

  const resetBtn = e.target.closest(".tournament-reset-delay-btn");
  if (resetBtn) { await resetDelay(resetBtn.dataset.tid); return; }

  const swapBtn = e.target.closest(".tournament-swap-btn");
  if (swapBtn) {
    const tid     = swapBtn.dataset.tid;
    const checked = [...document.querySelectorAll(`.swap-select[data-tid="${tid}"]:checked`)];
    if (checked.length !== 2) {
      setMsg(`swapMsg_${tid}`, "Check exactly 2 games to swap, then click Swap.", "warning");
      return;
    }
    await swapUmpires(tid, checked[0].dataset.gid, checked[1].dataset.gid);
    return;
  }

  const linkBtn = e.target.closest(".tournament-link-btn");
  if (linkBtn) {
    const tid    = linkBtn.dataset.tid;
    const select = document.getElementById(`linkGameSelect_${tid}`);
    await linkGame(tid, select?.value || "");
    return;
  }

  const unlinkBtn = e.target.closest(".tournament-unlink-btn");
  if (unlinkBtn) {
    await unlinkGame(unlinkBtn.dataset.gid, unlinkBtn.dataset.tid);
    return;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await authReadyPromise;
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display = "none";

  document.getElementById("createTournamentForm")?.addEventListener("submit", createTournament);

  try {
    await loadAll();
  } catch (err) {
    console.error(err);
    document.getElementById("tournamentList").innerHTML =
      `<p style="color:#ffb4b4">Failed to load tournaments: ${err.message}</p>`;
  }
}

init();
