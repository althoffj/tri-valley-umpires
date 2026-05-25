// admin-incidents.js — view and manage incident reports
import { db } from "./firebase.js";
import { authReadyPromise, isAdmin, getCurrentUser } from "./auth.js";
import { esc, fmtDate, setMsg } from "./utils.js";

import {
  collection,
  getDocs,
  doc,
  updateDoc,
  query,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_LABELS = { open: "Open", reviewed: "Reviewed", closed: "Closed" };
const STATUS_COLORS = { open: "#60a5fa", reviewed: "#fbbf24", closed: "#6ee7b7" };

function statusBadge(status) {
  const s    = status || "open";
  const color = STATUS_COLORS[s] || "#ccc";
  const label = STATUS_LABELS[s] || s;
  return `<span style="display:inline-block;padding:2px 10px;border-radius:10px;font-size:0.75rem;font-weight:700;background:${color}22;color:${color};border:1px solid ${color}55">${esc(label)}</span>`;
}

// ── Filter state ─────────────────────────────────────────────────────────────

let incidentFilter = "open";
let allIncidents   = []; // [{ id, data }]

function renderIncidents() {
  const listEl = document.getElementById("incidentList");
  const noteEl = document.getElementById("incidentNote");
  if (!listEl) return;

  const filtered = incidentFilter === "all"
    ? allIncidents
    : allIncidents.filter(({ data: r }) => (r.status || "open") === incidentFilter);

  const total = allIncidents.length;
  if (total === 0) {
    noteEl.textContent = "No incident reports submitted yet.";
    listEl.innerHTML   = "";
    return;
  }

  if (incidentFilter === "all") {
    noteEl.textContent = `${total} report${total === 1 ? "" : "s"} on file.`;
  } else {
    noteEl.textContent = `${filtered.length} ${incidentFilter} report${filtered.length === 1 ? "" : "s"} (${total} total).`;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = `<p style="color:var(--light-text)">No ${incidentFilter} reports.</p>`;
    return;
  }

  listEl.innerHTML = filtered.map(({ id: rid, data: r }) => {

      const submitted = r.submittedAt?.toDate
        ? r.submittedAt.toDate().toLocaleDateString("en-US", {
            month: "short", day: "numeric", year: "numeric",
            hour: "numeric", minute: "2-digit",
          })
        : "—";

      const reviewed = r.reviewedAt?.toDate
        ? r.reviewedAt.toDate().toLocaleDateString("en-US", {
            month: "short", day: "numeric", year: "numeric",
            hour: "numeric", minute: "2-digit",
          })
        : null;

      const gameInfo = [
        r.gameDate ? fmtDate(r.gameDate) : "",
        r.gameCity,
        r.gameDivision,
      ].filter(Boolean).join(" · ");

      const structuredLines = [];
      if (r.ejection) {
        const ej = r.ejection;
        if (ej.role)   structuredLines.push(`Ejected: ${esc(ej.role)}${ej.name ? " — " + esc(ej.name) : ""}${ej.team ? " (" + esc(ej.team) + ")" : ""}`);
        if (ej.reason) structuredLines.push(`Reason: ${esc(ej.reason)}`);
      }
      if (r.injury) {
        const inj = r.injury;
        if (inj.party)       structuredLines.push(`Injured: ${esc(inj.party)}${inj.name ? " — " + esc(inj.name) : ""}${inj.team ? " (" + esc(inj.team) + ")" : ""}`);
        if (inj.description) structuredLines.push(`Injury: ${esc(inj.description)}`);
        structuredLines.push(`EMS called: ${esc(inj.emsCalled || "No")}`);
      }
      if (r.unsafeConditions) {
        const uc = r.unsafeConditions;
        if (uc.conditionType) structuredLines.push(`Condition: ${esc(uc.conditionType)}`);
        if (uc.gameStatus)    structuredLines.push(`Game status: ${esc(uc.gameStatus)}`);
      }

      const typeColor = r.incidentType === "Ejection"          ? "#ff9999"
                      : r.incidentType === "Injury"            ? "#ffcc80"
                      : r.incidentType === "Unsafe Conditions" ? "#ffe066"
                      : "#f7c87e";

      const curStatus = r.status || "open";
      const statusOpts = ["open", "reviewed", "closed"]
        .map(s => `<option value="${s}"${curStatus === s ? " selected" : ""}>${STATUS_LABELS[s]}</option>`)
        .join("");

      return `
        <div class="document-note incident-card" data-id="${esc(rid)}"
             style="border-left-color:${typeColor};margin-bottom:16px">
          <!-- ── Header row ────────────────────────────────────────── -->
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
            <div style="display:flex;align-items:center;gap:10px">
              <strong style="color:${typeColor}">${esc(r.incidentType ?? "Incident")}</strong>
              ${statusBadge(curStatus)}
            </div>
            <span style="color:var(--light-text);font-size:0.85rem">${esc(submitted)}</span>
          </div>

          <!-- ── Report body ───────────────────────────────────────── -->
          <p style="margin:0 0 4px"><span style="color:var(--light-text)">Reported by:</span> ${esc(r.reporterName ?? "")}</p>
          ${gameInfo ? `<p style="margin:0 0 4px"><span style="color:var(--light-text)">Game:</span> ${esc(gameInfo)}</p>` : ""}
          ${structuredLines.map(l => `<p style="margin:0 0 3px;font-size:0.92rem">${l}</p>`).join("")}
          ${r.involvedParties ? `<p style="margin:0 0 4px"><span style="color:var(--light-text)">Involved:</span> ${esc(r.involvedParties)}</p>` : ""}
          <p style="margin:8px 0 0;white-space:pre-wrap">${esc(r.description ?? "")}</p>

          ${Array.isArray(r.photoUrls) && r.photoUrls.length > 0
            ? `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
                ${r.photoUrls.map(url => `<a href="${esc(url)}" target="_blank" rel="noopener">
                  <img src="${esc(url)}" alt="Incident photo"
                    style="width:100px;height:100px;object-fit:cover;border-radius:6px;border:1px solid #555;cursor:pointer" />
                </a>`).join("")}
               </div>`
            : ""}

          <!-- ── Admin resolution panel ────────────────────────────── -->
          <details style="margin-top:16px" class="incident-resolve">
            <summary style="cursor:pointer;color:var(--light-text);font-size:0.88rem;user-select:none;list-style:none">
              ▸ Admin Notes${r.adminNotes ? " (has notes)" : ""}
              ${reviewed ? `<span style="margin-left:8px;font-size:0.8rem">Last updated ${esc(reviewed)}${r.reviewedByName ? " by " + esc(r.reviewedByName) : ""}</span>` : ""}
            </summary>
            <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <label style="font-size:0.88rem;color:var(--light-text)">Status:</label>
                <select class="incident-status-sel"
                  style="padding:6px 10px;border:1px solid #555;border-radius:6px;background:var(--field);color:#eee;font-size:0.9rem">
                  ${statusOpts}
                </select>
              </div>
              <div>
                <label style="font-size:0.88rem;color:var(--light-text)">Admin Notes:</label>
                <textarea class="incident-notes-ta" rows="3"
                  style="width:100%;margin-top:4px;padding:8px 10px;border:1px solid #555;border-radius:6px;background:var(--field);color:#eee;font-size:0.9rem;box-sizing:border-box;resize:vertical;font-family:inherit"
                  placeholder="Internal notes visible only to admins…">${esc(r.adminNotes || "")}</textarea>
              </div>
              <div style="display:flex;align-items:center;gap:10px">
                <button type="button" class="btn incident-save-btn"
                        style="font-size:0.85rem;padding:6px 14px">Save</button>
                <span class="incident-save-msg" style="font-size:0.82rem;color:var(--light-text)"></span>
              </div>
            </div>
          </details>
        </div>`;
    }).join("");

  // Wire up save buttons
  listEl.querySelectorAll(".incident-save-btn").forEach(btn => {
    btn.addEventListener("click", () => saveIncidentUpdate(btn));
  });
}

// ── Load from Firestore ───────────────────────────────────────────────────────

async function loadIncidents() {
  const listEl = document.getElementById("incidentList");
  if (!listEl) return;
  listEl.innerHTML = '<p style="color:var(--light-text)">Loading reports…</p>';

  try {
    const snap = await getDocs(
      query(collection(db, "incidentReports"), orderBy("submittedAt", "desc"))
    );
    allIncidents = snap.docs.map(d => ({ id: d.id, data: d.data() }));
    renderIncidents();
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<p style="color:#ffb4b4">Error loading incident reports.</p>';
  }
}

// ── Save status + admin notes ─────────────────────────────────────────────────

async function saveIncidentUpdate(btn) {
  const card    = btn.closest(".incident-card");
  const id      = card?.dataset.id;
  const statusEl = card?.querySelector(".incident-status-sel");
  const notesEl  = card?.querySelector(".incident-notes-ta");
  const msgEl    = card?.querySelector(".incident-save-msg");
  if (!id || !statusEl) return;

  const status     = statusEl.value;
  const adminNotes = notesEl?.value.trim() || "";
  const user       = getCurrentUser();

  btn.disabled = true;
  if (msgEl) msgEl.textContent = "Saving…";

  try {
    await updateDoc(doc(db, "incidentReports", id), {
      status,
      adminNotes,
      reviewedAt:       serverTimestamp(),
      reviewedBy:       user?.uid    || null,
      reviewedByName:   user?.displayName || null,
    });
    if (msgEl) {
      msgEl.textContent = "Saved ✓";
      setTimeout(() => { if (msgEl) msgEl.textContent = ""; }, 3000);
    }
    // Update in-memory cache so filter tabs reflect the new status instantly
    const cached = allIncidents.find(x => x.id === id);
    if (cached) { cached.data.status = status; cached.data.adminNotes = adminNotes; }

    // Update the badge in-place
    const badge = card?.querySelector(".incident-card > div:first-child span:last-child");
    if (badge) badge.outerHTML = statusBadge(status);

    // Update the summary line
    const summary = card?.querySelector("details.incident-resolve summary");
    if (summary) {
      const noteHint = adminNotes ? " (has notes)" : "";
      const now = new Date().toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit",
      });
      const nameStr = user?.displayName ? ` by ${user.displayName}` : "";
      summary.innerHTML = `▸ Admin Notes${noteHint} <span style="margin-left:8px;font-size:0.8rem">Last updated ${esc(now)}${esc(nameStr)}</span>`;
    }
  } catch (err) {
    console.error(err);
    if (msgEl) msgEl.textContent = "Error saving.";
  } finally {
    btn.disabled = false;
  }
}

// ── Filter button wiring ──────────────────────────────────────────────────────

document.querySelectorAll(".incident-filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    incidentFilter = btn.dataset.filter;
    document.querySelectorAll(".incident-filter-btn").forEach(b =>
      b.classList.toggle("active", b === btn)
    );
    renderIncidents();
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display     = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display     = "none";
  loadIncidents();
});
