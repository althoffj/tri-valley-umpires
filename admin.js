// admin.js — Overview dashboard: stats, pending queues, open issues
import { db } from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import { esc, fmtTime, setMsg, showToast, showConfirm } from "./utils.js";

import {
  collection,
  getDocs,
  doc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  where,
  limit,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Pending Umpire Approvals ──────────────────────────────────────────────────

async function loadPending() {
  const noteEl = document.getElementById("pendingNote");
  const listEl = document.getElementById("pendingList");
  if (!listEl) return;

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
      // Support new parents[] array as well as flat parentName for older profiles
      const parents = Array.isArray(p.parents) && p.parents.length ? p.parents
        : p.parentName ? [{ name: p.parentName, phone: p.parentPhone || "", email: p.parentEmail || "" }]
        : [];
      const parentHtml = parents.length ? `
        <div style="background:rgba(255,200,100,0.1);border:1px solid rgba(255,200,100,0.3);border-radius:4px;padding:6px 10px;margin-top:8px;font-size:0.85rem">
          👤 <strong style="color:#ffd580">Minor — Parent/Guardian${parents.length > 1 ? "s" : ""}</strong>
          ${parents.map(par => `
            <div style="margin-top:4px">${esc(par.name)}
              ${par.phone ? ` · <a href="tel:${esc(par.phone)}" style="color:#ffd580">${esc(par.phone)}</a>` : ""}
              ${par.email ? ` · <a href="mailto:${esc(par.email)}" style="color:#ffd580">${esc(par.email)}</a>` : ""}
            </div>`).join("")}
        </div>` : "";
      return `
        <div class="document-note" style="border-left-color:#ffcc80;margin-bottom:12px">
          <strong>${esc(p.name)}</strong> &mdash; ${esc(p.email)} &mdash; ${esc(p.phone)}<br>
          <span style="color:var(--light-text);font-size:0.85rem">
            ${esc(p.street)}, ${esc(p.city)}, ${esc(p.state)} ${esc(p.zip)}
          </span>
          ${parentHtml}
          <div class="page-actions" style="margin-top:12px">
            <button class="btn approve-btn" data-uid="${esc(d.id)}">Approve</button>
            <button class="btn print-btn deny-btn" data-uid="${esc(d.id)}" data-name="${esc(p.name)}">Deny</button>
          </div>
          <p class="signup-message" id="pendingMsg_${esc(d.id)}"></p>
        </div>`;
    }).join("");
  } catch (err) {
    if (noteEl) noteEl.textContent = "Failed to load pending approvals.";
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
  if (!await showConfirm(`Deny ${name}'s account?`)) return;
  try {
    await updateDoc(doc(db, "umpires", uid), { approved: false, denied: true });
    setMsg(`pendingMsg_${uid}`, "Marked as denied.", "warning");
    setTimeout(() => loadPending(), 1200);
  } catch (err) {
    setMsg(`pendingMsg_${uid}`, err.message, "error");
  }
}

// ── Pending Coach Approvals ───────────────────────────────────────────────────

async function loadCoachPending() {
  const listEl = document.getElementById("coachPendingList");
  const noteEl = document.getElementById("coachPendingNote");
  if (!listEl) return;
  try {
    // Single-field filter only; sort client-side to avoid composite index requirement
    const snap = await getDocs(
      query(collection(db, "coaches"), where("approved", "==", false))
    );
    const docs = snap.docs.sort((a, b) => {
      const aTs = a.data().registeredAt?.seconds ?? 0;
      const bTs = b.data().registeredAt?.seconds ?? 0;
      return aTs - bTs;
    });
    if (docs.length === 0) {
      noteEl.textContent = "No pending coach applications.";
      listEl.innerHTML = "";
      return;
    }
    noteEl.textContent = `${docs.length} pending`;
    listEl.innerHTML = docs.map(d => {
      const c = d.data();
      return `<div class="document-note" style="margin-bottom:10px">
        <strong>${esc(c.name ?? "")}</strong> — ${esc(c.teamName ?? "")} ${esc(c.division ?? "")} · ${esc(c.city ?? "")}
        <br><span style="color:var(--light-text);font-size:0.85rem">${esc(c.email ?? "")} · ${esc(c.phone ?? "")}</span>
        <div class="page-actions" style="margin-top:8px">
          <button class="btn approve-coach-btn" data-uid="${esc(d.id)}" data-name="${esc(c.name ?? "")}">Approve</button>
          <button class="btn print-btn deny-coach-btn" data-uid="${esc(d.id)}" data-name="${esc(c.name ?? "")}">Deny</button>
        </div>
      </div>`;
    }).join("");
  } catch (err) {
    if (noteEl) noteEl.textContent = "Error loading pending coaches.";
    console.error(err);
  }
}

async function approveCoach(uid, name) {
  if (!await showConfirm(`Approve coach ${name}?`)) return;
  try {
    await updateDoc(doc(db, "coaches", uid), { approved: true, approvedAt: serverTimestamp() });
    await loadCoachPending();
  } catch (err) { showToast(err.message); }
}

async function denyCoach(uid, name) {
  if (!await showConfirm(`Deny and delete coach application for ${name}? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, "coaches", uid));
    await loadCoachPending();
  } catch (err) { showToast(err.message); }
}

// ── Pending Call-Up Requests ──────────────────────────────────────────────────

async function loadCallupPending() {
  const listEl = document.getElementById("callupPendingList");
  const noteEl = document.getElementById("callupPendingNote");
  const badge  = document.getElementById("callupPendingBadge");
  if (!listEl) return;
  try {
    // Single-field filter only; sort client-side to avoid composite index requirement
    const snap = await getDocs(
      query(collection(db, "callupRequests"), where("status", "==", "pending"))
    );
    const docs = snap.docs.sort((a, b) => {
      const aTs = a.data().requestedAt?.seconds ?? 0;
      const bTs = b.data().requestedAt?.seconds ?? 0;
      return aTs - bTs;
    });
    if (badge) {
      badge.textContent   = docs.length || "";
      badge.style.display = docs.length ? "" : "none";
    }
    if (docs.length === 0) {
      noteEl.textContent = "No pending call-up requests.";
      listEl.innerHTML = "";
      return;
    }
    noteEl.textContent = `${docs.length} pending`;
    listEl.innerHTML = docs.map(d => {
      const r = d.data();
      const dateLine = r.gameDate
        ? `<span style="color:var(--light-text);font-size:0.82rem">📅 ${esc(r.gameDate)}</span> · ` : "";
      return `<div class="document-note" style="margin-bottom:10px">
        <div style="margin-bottom:4px">
          <strong>${esc(r.playerFirstName)} ${esc(r.playerLastName)}</strong>
          ${r.playerNumber   ? `<span style="color:var(--light-text);font-size:0.85rem"> #${esc(r.playerNumber)}</span>` : ""}
          ${r.playerPosition ? `<span style="color:var(--light-text);font-size:0.85rem"> · ${esc(r.playerPosition)}</span>` : ""}
        </div>
        <div style="font-size:0.85rem;margin-bottom:4px">
          ${dateLine}
          <strong>${esc(r.requestingTeamName)}</strong> → <strong>${esc(r.homeTeamName)}</strong>
        </div>
        <div style="font-size:0.85rem;color:var(--light-text);margin-bottom:8px">${esc(r.reason || "")}</div>
        <div class="page-actions" style="margin-top:0">
          <button class="btn callup-approve-btn"
            data-id="${esc(d.id)}" style="font-size:0.85rem;padding:5px 14px;background:#1a5a2a;border-color:#2a7a3a">
            ✓ Approve
          </button>
          <button class="btn print-btn callup-decline-btn"
            data-id="${esc(d.id)}" style="font-size:0.85rem;padding:5px 14px;color:#ffb4b4;border-color:#7a2a2a">
            ✗ Decline
          </button>
        </div>
      </div>`;
    }).join("");
  } catch (err) {
    if (noteEl) noteEl.textContent = "Error loading call-up requests.";
    console.error(err);
  }
}

async function adminOverrideCallup(id, status) {
  const label = status === "approved" ? "approve" : "decline";
  if (!await showConfirm(`Admin ${label} this call-up request?`)) return;
  try {
    await updateDoc(doc(db, "callupRequests", id), {
      status,
      responseNote: "[Admin override]",
      respondedAt:  serverTimestamp(),
    });
    loadCallupPending();
  } catch (err) { showToast("Error: " + err.message); }
}

// ── Open Incident Reports ─────────────────────────────────────────────────────

async function loadIncidentsPending() {
  const listEl = document.getElementById("incidentPendingList");
  const noteEl = document.getElementById("incidentPendingNote");
  const badge  = document.getElementById("incidentPendingBadge");
  if (!listEl) return;
  try {
    // Fetch recent incidents ordered by date; filter open/no-status client-side
    // (avoids composite index on status + submittedAt)
    const legacySnap = await getDocs(query(
      collection(db, "incidentReports"),
      orderBy("submittedAt", "desc"),
      limit(50)
    ));
    const openDocs = legacySnap.docs.filter(d => {
      const s = d.data().status;
      return !s || s === "open";
    });
    if (badge) {
      badge.textContent   = openDocs.length || "";
      badge.style.display = openDocs.length ? "" : "none";
    }
    if (openDocs.length === 0) {
      noteEl.textContent = "No open incident reports.";
      listEl.innerHTML   = "";
      return;
    }
    noteEl.textContent = `${openDocs.length} open`;
    listEl.innerHTML = openDocs.map(d => {
      const r    = d.data();
      const typeColor = r.incidentType === "Ejection"          ? "#ff9999"
                      : r.incidentType === "Injury"            ? "#ffcc80"
                      : r.incidentType === "Unsafe Conditions" ? "#ffe066"
                      : "#f7c87e";
      const gameLine  = [r.gameDate, r.gameCity, r.gameDivision].filter(Boolean).join(" · ");
      const submitted = r.submittedAt?.toDate
        ? r.submittedAt.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : "";
      return `<div class="document-note" style="border-left-color:${typeColor};margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px">
          <strong style="color:${typeColor}">${esc(r.incidentType || "Incident")}</strong>
          <span style="color:var(--light-text);font-size:0.82rem">${esc(submitted)}</span>
        </div>
        <div style="font-size:0.85rem;color:var(--light-text)">By: ${esc(r.reporterName || "")}</div>
        ${gameLine ? `<div style="font-size:0.85rem;margin-top:2px">${esc(gameLine)}</div>` : ""}
        <div class="page-actions" style="margin-top:8px">
          <a href="admin-incidents.html" class="btn print-btn" style="font-size:0.82rem;padding:4px 12px">Review →</a>
        </div>
      </div>`;
    }).join("");
  } catch (err) {
    if (noteEl) noteEl.textContent = "Error loading.";
    console.error(err);
  }
}

// ── Open Field Issues ─────────────────────────────────────────────────────────

async function loadFieldIssuesPending() {
  const listEl = document.getElementById("fieldIssuesPendingList");
  const noteEl = document.getElementById("fieldIssuesPendingNote");
  const badge  = document.getElementById("fieldIssuesBadge");
  if (!listEl) return;
  try {
    // Fetch recent field issues ordered by date; filter non-resolved client-side
    // (avoids needing a composite index on status + submittedAt)
    const snap = await getDocs(query(
      collection(db, "fieldIssues"),
      orderBy("submittedAt", "desc"),
      limit(100)
    ));
    const issues = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => r.status !== "Resolved");

    if (badge) {
      badge.textContent   = issues.length || "";
      badge.style.display = issues.length ? "" : "none";
    }
    if (issues.length === 0) {
      noteEl.textContent = "No open field issues.";
      listEl.innerHTML   = "";
      return;
    }
    noteEl.textContent = `${issues.length} open`;
    listEl.innerHTML = issues.map(r => {
      const severityColor = r.severity === "Safety Hazard" ? "#ff9999"
                          : r.severity === "Major"         ? "#ffcc80"
                          : "#fde68a";
      const statusColor   = r.status === "In Progress"     ? "#8ab4f8" : "#fde68a";
      const loc = r.fieldName
        ? `${esc(r.facilityName || "")} — ${esc(r.fieldName)}`
        : esc(r.facilityName || "");
      const submitted = r.submittedAt?.toDate
        ? r.submittedAt.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : "";
      return `<div class="document-note" style="border-left-color:${severityColor};margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px">
          <div>
            <span style="color:${statusColor};font-size:0.75rem;font-weight:700;border:1px solid ${statusColor};
              border-radius:3px;padding:1px 6px;margin-right:6px">${esc(r.status || "Open")}</span>
            ${r.severity ? `<span style="color:${severityColor};font-size:0.75rem;font-weight:600;margin-right:6px">${esc(r.severity)}</span>` : ""}
            <strong>${esc(r.title || "Field Issue")}</strong>
          </div>
          <span style="color:var(--light-text);font-size:0.82rem">${esc(submitted)}</span>
        </div>
        ${loc ? `<div style="font-size:0.85rem;color:var(--light-text);margin-top:3px">${loc}</div>` : ""}
        <div style="font-size:0.85rem;color:var(--light-text)">Reported by ${esc(r.reporterName || "")}</div>
        ${r.description ? `<div style="font-size:0.85rem;margin-top:4px;color:#ccc">${esc(r.description.length > 120 ? r.description.slice(0, 120) + "…" : r.description)}</div>` : ""}
        <div class="page-actions" style="margin-top:8px">
          <a href="admin-facilities.html" class="btn print-btn" style="font-size:0.82rem;padding:4px 12px">Review →</a>
        </div>
      </div>`;
    }).join("");
  } catch (err) {
    if (noteEl) noteEl.textContent = "Error loading field issues.";
    console.error(err);
  }
}

// ── Quick Stats ───────────────────────────────────────────────────────────────

async function loadAdminQuickStats() {
  const cardsEl = document.getElementById("adminStatCards");
  const todayEl = document.getElementById("adminTodayGames");
  if (!cardsEl) return;

  // Use local date (not UTC) so "today" matches the user's wall-clock date
  const localDate = d => {
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const today = localDate(new Date());
  const weekEnd = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return localDate(d);
  })();

  try {
    // Single-field orderBy("date") only — no composite index required.
    // Filter date <= weekEnd and sort by time client-side.
    const [upcomingSnap, allGamesSnap] = await Promise.all([
      getDocs(query(collection(db, "games"),
        where("date", ">=", today),
        orderBy("date"))),
      getDocs(query(collection(db, "games"),
        where("date", ">=", `${new Date().getFullYear()}-01-01`),
        orderBy("date"))),
    ]);

    const upcoming = upcomingSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(g => g.date <= weekEnd && !g.cancelled && g.needsUmpires !== false)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time || "").localeCompare(b.time || "")));
    const todayGames = upcoming.filter(g => g.date === today);

    // Today coverage
    let todayOpen = 0, todayCovered = 0;
    todayGames.forEach(g => {
      (g.umpireSlots || []).forEach(s => {
        if (s.assignedUid) todayCovered++; else todayOpen++;
      });
    });

    // This week: total games + open slots (excluding today)
    const weekGames = upcoming.filter(g => g.date > today);
    let weekOpen = 0;
    weekGames.forEach(g => {
      (g.umpireSlots || []).forEach(s => { if (!s.assignedUid) weekOpen++; });
    });

    // Outstanding payroll
    let outstanding = 0;
    allGamesSnap.docs.forEach(d => {
      const g = d.data();
      if (g.cancelled && g.cancellationType !== "rainout" && g.cancellationType !== "rescheduled") return;
      (g.umpireSlots || []).forEach(s => {
        if (s.assignedUid && !s.paid) outstanding += Number(s.payRate ?? g.payRate ?? 0);
      });
    });

    const todayColor = todayOpen > 0 ? "#f0a500" : todayGames.length > 0 ? "#b8f2c4" : "var(--text)";
    const weekColor  = weekOpen  > 0 ? "#f0a500" : weekGames.length > 0 ? "#b8f2c4" : "var(--text)";
    const payColor   = outstanding > 0 ? "#f0a500" : "var(--text)";

    cardsEl.innerHTML = [
      { label: "Today's Games",   value: todayGames.length,
        sub: todayGames.length === 0 ? "None scheduled"
           : todayOpen > 0 ? `${todayOpen} slot${todayOpen !== 1 ? "s" : ""} open`
           : "All covered ✓",
        color: todayColor },
      { label: "Games This Week", value: weekGames.length,
        sub: weekGames.length === 0 ? "None scheduled"
           : weekOpen > 0 ? `${weekOpen} slot${weekOpen !== 1 ? "s" : ""} open`
           : "All covered ✓",
        color: weekColor, link: "admin-games.html" },
      { label: "Outstanding Pay", value: `$${outstanding.toFixed(2)}`,
        sub: outstanding === 0 ? "All paid up" : "Unpaid umpires",
        color: payColor, link: "admin-payroll.html" },
    ].map(c => `
      <div class="analytics-card" style="${c.link ? "cursor:pointer" : ""}"
           ${c.link ? `onclick="location.href='${c.link}'"` : ""}>
        <div class="analytics-card-value" style="color:${c.color}">${c.value}</div>
        <div class="analytics-card-label">${c.label}</div>
        <div style="font-size:0.72rem;color:var(--light-text);margin-top:2px">${c.sub}</div>
      </div>`).join("");

    if (todayGames.length === 0) { todayEl.innerHTML = ""; return; }

    const rows = todayGames.map(g => {
      const time  = g.time ? fmtTime(g.time) : "—";
      const slots = (g.umpireSlots || []).map(s => {
        const who = s.assignedName
          ? `<span style="color:#b8f2c4">${esc(s.assignedName)}</span>`
          : `<span style="color:#f0a500">Open</span>`;
        const cls = s.type === "Plate" ? "plate" : s.type === "Field" ? "field" : "extra";
        return `<span class="badge badge-${cls}" style="font-size:0.7rem">${esc(s.type)}</span> ${who}`;
      }).join(" &nbsp; ");
      return `<tr>
        <td style="white-space:nowrap">${esc(time)}</td>
        <td>${esc(g.division || "")}</td>
        <td>${esc(g.field || "")}</td>
        <td>${slots}</td>
      </tr>`;
    }).join("");

    todayEl.innerHTML = `
      <div style="font-size:0.8rem;color:var(--light-text);font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em">Today's Games</div>
      <div class="schedule-section" style="margin-top:0">
        <table style="font-size:0.88rem">
          <thead><tr><th>Time</th><th>Division</th><th>Field</th><th>Umpires</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (err) {
    console.error("Quick stats error:", err);
    cardsEl.innerHTML = `<p style="color:var(--light-text);font-size:0.85rem">Could not load stats.</p>`;
  }
}

// ── Event delegation ──────────────────────────────────────────────────────────

document.addEventListener("click", e => {
  const approveBtn = e.target.closest(".approve-btn");
  if (approveBtn) { approveUmpire(approveBtn.dataset.uid); return; }

  const denyBtn = e.target.closest(".deny-btn");
  if (denyBtn) { denyUmpire(denyBtn.dataset.uid, denyBtn.dataset.name); return; }

  const approveCoachBtn = e.target.closest(".approve-coach-btn");
  if (approveCoachBtn) { approveCoach(approveCoachBtn.dataset.uid, approveCoachBtn.dataset.name); return; }

  const denyCoachBtn = e.target.closest(".deny-coach-btn");
  if (denyCoachBtn) { denyCoach(denyCoachBtn.dataset.uid, denyCoachBtn.dataset.name); return; }

  const callupApproveBtn = e.target.closest(".callup-approve-btn");
  if (callupApproveBtn) { adminOverrideCallup(callupApproveBtn.dataset.id, "approved"); return; }

  const callupDeclineBtn = e.target.closest(".callup-decline-btn");
  if (callupDeclineBtn) { adminOverrideCallup(callupDeclineBtn.dataset.id, "declined"); return; }
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

  loadAdminQuickStats();
  loadPending();
  loadCoachPending();
  loadCallupPending();
  loadIncidentsPending();
  loadFieldIssuesPending();
});
