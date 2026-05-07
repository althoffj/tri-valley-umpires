// admin.js — admin panel: approvals, roster, game management, pay rates, notifications
import { db } from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  addDoc,
  query,
  orderBy,
  serverTimestamp,
  where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let allGames   = [];
let allUmpires = [];
let gameFilter = "upcoming";

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
  const filled = slot.assignedName
    ? ` <span style="color:var(--light-text);font-size:0.8rem">→ ${esc(slot.assignedName)}</span>`
    : "";
  return `<span class="badge badge-${cls}">${esc(slot.type)}</span>${filled}`;
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
    const q = query(collection(db, "games"), orderBy("date"), orderBy("time"));
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

    return `
    <tr style="${g.cancelled ? "opacity:0.55" : ""}">
      <td>${esc(fmtDate(g.date))}</td>
      <td>${esc(fmtTime(g.time))}</td>
      <td>${esc(g.city || "—")}</td>
      <td>${esc(g.division || "—")}</td>
      <td>${esc(g.type || "—")}</td>
      <td>${esc(g.field || "—")}</td>
      <td>${g.payRate ? `$${Number(g.payRate).toFixed(2)}` : "—"}</td>
      <td>${g.cancelled ? '<span style="color:#ffb4b4">Cancelled</span>' : slotHtml}</td>
      <td>
        ${g.cancelled
          ? ""
          : `<button class="btn print-btn cancel-game-btn" data-game-id="${esc(g.id)}">Cancel Game</button>`}
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

  const city    = document.getElementById("gameCity").value;
  const division = document.getElementById("gameDivision").value;
  const date    = document.getElementById("gameDate").value;
  const time    = document.getElementById("gameTime").value;
  const type    = document.getElementById("gameType").value;
  const field   = document.getElementById("gameField").value.trim();
  const payRate = parseFloat(document.getElementById("gamePayRate").value) || 0;

  const umpireSlots = checkedTypes.map(t => ({ type: t, assignedUid: null, assignedName: null }));

  try {
    await addDoc(collection(db, "games"), {
      city, division, date, time, type, field, payRate,
      umpireSlots,
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

// ── Calendar Sync ─────────────────────────────────────────────────────────────

function normalizeIcsUrl(url) {
  return url.replace(/^webcal:\/\//i, "https://");
}

async function fetchICS(rawUrl) {
  const url = normalizeIcsUrl(rawUrl);
  try {
    const res = await fetch(url, { mode: "cors" });
    if (res.ok) return await res.text();
  } catch (_) {}
  try {
    const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`);
    if (res.ok) return await res.text();
  } catch (_) {}
  return null;
}

function parseVEvents(icsText) {
  const events = [];
  const blocks = icsText.split(/BEGIN:VEVENT/i);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const get = key => {
      // handles folded lines and optional param segments before the colon
      const re = new RegExp(`^${key}[^:\r\n]*:([^\r\n]+)`, "im");
      const m = block.match(re);
      return m ? m[1].trim() : "";
    };
    const dtstart  = get("DTSTART");
    const location = get("LOCATION");
    const uid      = get("UID");

    const dateM = dtstart.match(/(\d{4})(\d{2})(\d{2})/);
    if (!dateM) continue;
    const date = `${dateM[1]}-${dateM[2]}-${dateM[3]}`;

    const timeM = dtstart.match(/T(\d{2})(\d{2})/);
    const time  = timeM ? `${timeM[1]}:${timeM[2]}` : "";

    events.push({ date, time, location, uid });
  }
  return events;
}

async function syncGamesFromCalendars() {
  const btn   = document.getElementById("syncCalBtn");
  const msgEl = document.getElementById("syncCalMessage");
  btn.disabled = true;
  setMsg("syncCalMessage", "Fetching calendars…", "info");

  try {
    const { setDoc: _setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

    const teamsSnap = await getDoc(doc(db, "config", "teamCalendars"));
    const teams = teamsSnap.exists() ? (teamsSnap.data().teams || []) : [];
    const relevantTeams = teams.filter(t => /10U|12U/i.test(t.name));

    if (relevantTeams.length === 0) {
      setMsg("syncCalMessage", "No 10U or 12U teams are configured under Team Calendars.", "warning");
      btn.disabled = false;
      return;
    }

    const existingSnap = await getDocs(collection(db, "games"));
    const existingUids = new Set(existingSnap.docs.map(d => d.data().externalId).filter(Boolean));

    const ratesSnap = await getDoc(doc(db, "config", "payRates"));
    const rates = ratesSnap.exists() ? ratesSnap.data() : {};
    const defaultPay = rates.plate || 0;

    const today = todayISO();
    let added = 0, skipped = 0, failed = 0;

    for (const team of relevantTeams) {
      const icsText = await fetchICS(team.icsUrl);
      if (!icsText) { failed++; continue; }

      const division = /10U/i.test(team.name) ? "10U" : "12U";
      const events   = parseVEvents(icsText);

      for (const ev of events) {
        if (ev.date < today) continue;

        let city = null;
        if (/crooks,\s*sd/i.test(ev.location))  city = "City of Crooks";
        if (/colton,\s*sd/i.test(ev.location))   city = "City of Colton";
        if (!city) continue;

        if (ev.uid && existingUids.has(ev.uid)) continue;

        await addDoc(collection(db, "games"), {
          city,
          division,
          date:    ev.date,
          time:    ev.time,
          type:    "Regular",
          field:   ev.location,
          payRate: defaultPay,
          umpireSlots: [
            { type: "Plate", assignedUid: null, assignedName: null },
            { type: "Field", assignedUid: null, assignedName: null }
          ],
          cancelled:  false,
          externalId: ev.uid || null,
          source:     "calendar",
          createdAt:  serverTimestamp()
        });

        if (ev.uid) existingUids.add(ev.uid);
        added++;
      }
    }

    const parts = [`${added} game${added !== 1 ? "s" : ""} added`];
    if (failed) parts.push(`${failed} feed${failed !== 1 ? "s" : ""} could not be fetched`);
    setMsg("syncCalMessage", `Sync complete: ${parts.join(", ")}.`, added > 0 ? "success" : "info");
    if (added > 0) await loadGames();
  } catch (err) {
    setMsg("syncCalMessage", `Error: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("syncCalBtn").addEventListener("click", syncGamesFromCalendars);

// ── Pay rates ─────────────────────────────────────────────────────────────────

async function loadPayRates() {
  try {
    const snap = await getDoc(doc(db, "config", "payRates"));
    if (snap.exists()) {
      const r = snap.data();
      document.getElementById("ratePlate").value = r.plate || "";
      document.getElementById("rateField").value  = r.field  || "";
      document.getElementById("rateExtra").value  = r.extra  || "";
    }
  } catch (_) {}
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

  const cancelGameBtn = e.target.closest(".cancel-game-btn");
  if (cancelGameBtn) { cancelGame(cancelGameBtn.dataset.gameId); return; }

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
});
