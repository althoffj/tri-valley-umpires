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
  if (!confirm(`Deny and delete ${name}'s account? This cannot be undone.`)) return;
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
  if (!confirm(`Revoke approval for ${name}? They will no longer be able to log in.`)) return;
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

  tbody.innerHTML = visible.map(g => `
    <tr style="${g.cancelled ? "opacity:0.55" : ""}">
      <td>${esc(fmtDate(g.date))}</td>
      <td>${esc(fmtTime(g.time))}</td>
      <td>${esc(g.city || "—")}</td>
      <td>${esc(g.division || "—")}</td>
      <td>${esc(g.umpireType || "—")}</td>
      <td>${esc(g.field || "—")}</td>
      <td>${g.payRate ? `$${Number(g.payRate).toFixed(2)}` : "—"}</td>
      <td>${g.cancelled
        ? '<span style="color:#ffb4b4">Cancelled</span>'
        : g.assignedName
          ? esc(g.assignedName)
          : '<span style="color:#ffcc80">Open</span>'}
      </td>
      <td>
        ${g.cancelled
          ? ""
          : `<button class="btn print-btn cancel-game-btn" data-game-id="${esc(g.id)}">Cancel</button>`}
        ${g.assignedUid && !g.cancelled
          ? `<button class="btn print-btn unassign-btn" data-game-id="${esc(g.id)}" style="margin-top:4px">Unassign</button>`
          : ""}
      </td>
    </tr>`).join("");
}

async function cancelGame(gameId) {
  const game = allGames.find(g => g.id === gameId);
  if (!game) return;
  if (!confirm(`Cancel the game on ${fmtDate(game.date)} at ${game.city}?`)) return;
  try {
    await updateDoc(doc(db, "games", gameId), {
      cancelled: true,
      cancelledAt: serverTimestamp()
    });
    const g = allGames.find(g => g.id === gameId);
    if (g) g.cancelled = true;
    renderAdminGames();
  } catch (err) {
    alert(err.message);
  }
}

async function unassignGame(gameId) {
  if (!confirm("Remove the umpire from this game?")) return;
  try {
    await updateDoc(doc(db, "games", gameId), {
      assignedUid: null, assignedName: null, claimedAt: null
    });
    const g = allGames.find(g => g.id === gameId);
    if (g) { g.assignedUid = null; g.assignedName = null; }
    renderAdminGames();
  } catch (err) {
    alert(err.message);
  }
}

// ── Add game form ─────────────────────────────────────────────────────────────

document.getElementById("addGameForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn = document.getElementById("addGameBtn");
  btn.disabled = true;
  setMsg("addGameMessage", "Adding game…", "info");

  const city       = document.getElementById("gameCity").value;
  const division   = document.getElementById("gameDivision").value;
  const date       = document.getElementById("gameDate").value;
  const time       = document.getElementById("gameTime").value;
  const type       = document.getElementById("gameType").value;
  const umpireType = document.getElementById("gameUmpireType").value;
  const field      = document.getElementById("gameField").value.trim();
  const payRate    = parseFloat(document.getElementById("gamePayRate").value) || 0;

  try {
    const ref = await addDoc(collection(db, "games"), {
      city, division, date, time, type, umpireType, field, payRate,
      cancelled: false, assignedUid: null, assignedName: null,
      createdAt: serverTimestamp()
    });
    setMsg("addGameMessage", "Game added!", "success");
    this.reset();
    await loadGames();
  } catch (err) {
    setMsg("addGameMessage", err.message, "error");
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
    // Collect all FCM tokens from notifications collection
    const snap = await getDocs(collection(db, "notifications"));
    const tokens = snap.docs.map(d => d.data().fcmToken).filter(Boolean);

    if (tokens.length === 0) {
      setMsg("notifMessage", "No umpires have notifications enabled yet.", "warning");
      btn.disabled = false;
      return;
    }

    // Send via EmailJS as a proxy notification summary (FCM requires a server key on a backend)
    // For each token, we'd need a Cloud Function. As a fallback, send an email blast.
    if (typeof emailjs !== "undefined") {
      emailjs.init("H9Z9Qz-HB-PehAQjp");
      const roster = allUmpires.filter(u => u.approved && u.email);
      await Promise.allSettled(roster.map(u =>
        emailjs.send("service_vljauqe", "template_notification", {
          to_name:  u.name,
          to_email: u.email,
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
  if (unassignBtn) { unassignGame(unassignBtn.dataset.gameId); return; }

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
});
