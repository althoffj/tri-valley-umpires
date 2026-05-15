// admin-field-calendar.js — Field calendar import workflow
import { db, app }                      from "./firebase.js";
import { authReadyPromise, isAdmin }    from "./auth.js";
import { esc }                          from "./utils.js";
import {
  collection, getDocs, addDoc, doc, getDoc, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getFunctions, httpsCallable }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

const functions        = getFunctions(app);
const fetchFacilityIcs = httpsCallable(functions, "fetchFacilityIcs");
const fetchOrgIcs      = httpsCallable(functions, "fetchOrgIcs");

// ── State ─────────────────────────────────────────────────────────────────────

let currentFacilityId = "";   // empty = org-level mode
let currentEvents     = [];   // full event list from last fetch
let allFacilities     = [];   // [{id, name}] — populated in org mode for facility selector
let teams             = [];   // for import form
let isOrgMode         = false;

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(async () => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display     = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display     = "none";

  // Load teams for import form
  try {
    const snap = await getDoc(doc(db, "config/teamCalendars"));
    teams = snap.exists() ? (snap.data().teams || []) : [];
  } catch { teams = []; }

  const params     = new URLSearchParams(window.location.search);
  const paramFacId = params.get("facility");

  if (paramFacId) {
    // ── Per-facility mode ──────────────────────────────────────────────────────
    isOrgMode         = false;
    currentFacilityId = paramFacId;
    try {
      const facDoc = await getDoc(doc(db, "facilities", paramFacId));
      const name   = facDoc.exists() ? (facDoc.data().name || paramFacId) : paramFacId;
      const hasUrl = facDoc.exists() && !!facDoc.data().externalIcsUrl;
      document.getElementById("fcFacilityName").textContent = name;
      const btn = document.getElementById("fcFetchBtn");
      btn.disabled = !hasUrl;
      if (!hasUrl) {
        document.getElementById("fcFetchStatus").textContent =
          "No external calendar URL configured for this facility. Add one in Facilities settings.";
      }
    } catch {
      document.getElementById("fcFacilityName").textContent = "Unknown facility";
    }
  } else {
    // ── Org-calendar mode ──────────────────────────────────────────────────────
    isOrgMode = true;

    // Check if org calendar URL is configured
    let hasOrgUrl = false;
    try {
      const orgDoc = await getDoc(doc(db, "config/orgSettings"));
      hasOrgUrl = orgDoc.exists() && !!orgDoc.data().fieldCalendarUrl;
    } catch {}

    if (hasOrgUrl) {
      document.getElementById("fcFacilityName").textContent = "All Facilities — Org Calendar";
      document.getElementById("fcFetchBtn").disabled = false;
    } else {
      // Fall back to per-facility picker
      isOrgMode = false;
      document.getElementById("fcFacilityPickWrap").style.display = "";
      await loadFacilityPicker();
    }
  }

  updateFacilityColumnVisibility();
  wireBtns();
});

// ── Facility picker (per-facility fallback) ───────────────────────────────────

async function loadFacilityPicker() {
  const sel = document.getElementById("fcFacilitySel");
  if (!sel) return;
  try {
    const snap    = await getDocs(query(collection(db, "facilities"), orderBy("name")));
    const withUrl = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(f => f.externalIcsUrl);
    if (!withUrl.length) {
      sel.innerHTML = '<option value="">No facilities have an external calendar URL — configure one in Facilities or set the org calendar in Config.</option>';
      return;
    }
    sel.innerHTML = '<option value="">— Select a facility —</option>' +
      withUrl.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("");
    sel.addEventListener("change", () => {
      currentFacilityId = sel.value;
      document.getElementById("fcFacilityName").textContent =
        sel.options[sel.selectedIndex]?.text || "";
      document.getElementById("fcFetchBtn").disabled = !currentFacilityId;
      document.getElementById("fcResultWrap").style.display = "none";
    });
  } catch {
    sel.innerHTML = '<option value="">Failed to load facilities.</option>';
  }
}

// ── Facility column ───────────────────────────────────────────────────────────

function updateFacilityColumnVisibility() {
  // Show/hide the Facility column header based on mode
  const th = document.getElementById("fcFacilityTh");
  if (th) th.style.display = isOrgMode ? "" : "none";
}

// ── Wire buttons ──────────────────────────────────────────────────────────────

function wireBtns() {
  document.getElementById("fcFetchBtn").addEventListener("click", doFetch);
  document.getElementById("fcSelectAll").addEventListener("change", e => {
    document.querySelectorAll(".fc-row-cb:not(:disabled)").forEach(cb => {
      cb.checked = e.target.checked;
    });
    updateImportCount();
  });
  document.getElementById("fcShowImported").addEventListener("change", () => renderTable());
  document.getElementById("fcImportBtn").addEventListener("click", doImport);
  document.getElementById("fcTableBody").addEventListener("change", updateImportCount);
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function doFetch() {
  const btn    = document.getElementById("fcFetchBtn");
  const status = document.getElementById("fcFetchStatus");
  const wrap   = document.getElementById("fcResultWrap");

  btn.disabled       = true;
  status.textContent = "Fetching calendar…";
  wrap.style.display = "none";

  try {
    let result;
    if (isOrgMode) {
      result = await fetchOrgIcs({});
      allFacilities = result.data.facilities || [];
    } else {
      if (!currentFacilityId) return;
      result = await fetchFacilityIcs({ facilityId: currentFacilityId });
      allFacilities = [];
    }

    currentEvents   = result.data.events || [];
    const newCount  = result.data.newCount ?? currentEvents.filter(e => !e.alreadyImported).length;
    const skipCount = currentEvents.length - newCount;

    document.getElementById("fcNewCount").textContent  = `${newCount} new event${newCount !== 1 ? "s" : ""} found`;
    document.getElementById("fcSkipCount").textContent = skipCount ? `(${skipCount} already imported, hidden)` : "";
    status.textContent = "";

    renderTable();
    wrap.style.display = "";
  } catch (err) {
    status.textContent = "Error: " + (err.message || String(err));
  } finally {
    btn.disabled = false;
  }
}

// ── Table rendering ───────────────────────────────────────────────────────────

function teamOptions(selectedId = "") {
  const none = `<option value="">— None / External —</option>`;
  return none + teams.map(t =>
    `<option value="${esc(t.id || "")}" data-name="${esc(t.name)}"${(t.id || "") === selectedId ? " selected" : ""}>${esc(t.name)}</option>`
  ).join("");
}

function facilityOptions(selectedId = "") {
  const none = `<option value="">— Unassigned —</option>`;
  return none + allFacilities.map(f =>
    `<option value="${esc(f.id)}"${f.id === selectedId ? " selected" : ""}>${esc(f.name)}</option>`
  ).join("");
}

function formatDate(dateStr) {
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US",
      { weekday: "short", month: "short", day: "numeric" });
  } catch { return dateStr; }
}

function formatTime(t) {
  if (!t) return "—";
  try {
    const [h, m] = t.split(":").map(Number);
    return `${((h % 12) || 12)}:${String(m).padStart(2,"0")} ${h >= 12 ? "PM" : "AM"}`;
  } catch { return t; }
}

function renderTable() {
  const tbody   = document.getElementById("fcTableBody");
  const showAll = document.getElementById("fcShowImported").checked;
  const visible = showAll ? currentEvents : currentEvents.filter(e => !e.alreadyImported);

  // Ensure facility column header visibility matches current mode
  updateFacilityColumnVisibility();

  tbody.innerHTML = visible.map((ev, rowIdx) => {
    const isImported = ev.alreadyImported;
    const rowClass   = isImported ? "already-imported" : "";

    const badge = isImported
      ? `<span class="fc-badge imported">Imported</span>`
      : `<span class="fc-badge ${ev.suggestedType}">${ev.suggestedType}</span>`;

    const timeStr = ev.time
      ? `${formatTime(ev.time)}${ev.endTime ? " – " + formatTime(ev.endTime) : ""}`
      : "All day";

    const typeSel = isImported ? badge : `
      <select class="fc-type-select" data-idx="${rowIdx}">
        <option value="game"     ${ev.suggestedType === "game"     ? "selected" : ""}>⚾ Game</option>
        <option value="practice" ${ev.suggestedType === "practice" ? "selected" : ""}>🏋 Practice</option>
        <option value="other"    ${ev.suggestedType === "other"    ? "selected" : ""}>📅 Other</option>
      </select>`;

    const teamSel = isImported ? "" : `
      <select class="fc-team-select" data-idx="${rowIdx}">
        ${teamOptions(ev.suggestedTeamId)}
      </select>`;

    const umpCb = isImported ? "" :
      `<input type="checkbox" class="fc-ump-cb" data-idx="${rowIdx}"${ev.suggestedType === "game" ? " checked" : ""} />`;

    // Facility column — only rendered in org mode
    let facilityCell = "";
    if (isOrgMode) {
      if (isImported) {
        facilityCell = `<td style="white-space:nowrap;font-size:0.82rem">${esc(ev.detectedFacilityName || "—")}</td>`;
      } else {
        const facLabel = ev.detectedFacilityName
          ? `<div style="font-size:0.75rem;color:#86efac;margin-bottom:4px">✓ ${esc(ev.detectedFacilityName)}${ev.detectedFieldName ? " · " + esc(ev.detectedFieldName) : ""}</div>`
          : `<div style="font-size:0.75rem;color:#ffb4b4;margin-bottom:4px">⚠ Not matched</div>`;
        facilityCell = `<td>
          ${facLabel}
          <select class="fc-fac-select" data-idx="${rowIdx}" style="font-size:0.82rem;padding:4px 6px;background:var(--field);color:var(--text);border:1px solid #555;border-radius:5px;width:100%">
            ${facilityOptions(ev.detectedFacilityId)}
          </select>
        </td>`;
      }
    }

    // Sub-lines under summary
    const divSub = (ev.division || ev.opponent)
      ? `<div class="fc-sub">${ev.division ? esc(ev.division) + " · " : ""}${ev.opponent ? "vs " + esc(ev.opponent) : ""}</div>`
      : "";
    const locSub = ev.location ? `<div class="fc-sub">📍 ${esc(ev.location)}</div>` : "";

    return `<tr class="${rowClass}" data-uid="${esc(ev.uid)}">
      <td><input type="checkbox" class="fc-row-cb" data-idx="${rowIdx}" ${isImported ? "disabled" : ""} /></td>
      <td style="white-space:nowrap">${esc(formatDate(ev.date))}</td>
      <td style="white-space:nowrap;font-size:0.82rem">${timeStr}</td>
      <td>
        <div class="fc-summary">${esc(ev.summary || "(no title)")}</div>
        ${divSub}${locSub}
      </td>
      ${facilityCell}
      <td>${typeSel}</td>
      <td>${teamSel}</td>
      <td style="text-align:center">${umpCb}</td>
    </tr>`;
  }).join("");

  // Wire type-change → toggle umpire default
  tbody.querySelectorAll(".fc-type-select").forEach(sel => {
    sel.addEventListener("change", () => {
      const umpCb = tbody.querySelector(`.fc-ump-cb[data-idx="${sel.dataset.idx}"]`);
      if (umpCb) umpCb.checked = (sel.value === "game");
    });
  });

  updateImportCount();
}

function updateImportCount() {
  const selected = document.querySelectorAll(".fc-row-cb:checked").length;
  document.getElementById("fcImportCount").textContent = `${selected} selected`;
  document.getElementById("fcImportBtn").disabled = selected === 0;
}

// ── Import ────────────────────────────────────────────────────────────────────

async function doImport() {
  const msgEl   = document.getElementById("fcImportMsg");
  const btn     = document.getElementById("fcImportBtn");
  const tbody   = document.getElementById("fcTableBody");
  const checked = [...document.querySelectorAll(".fc-row-cb:checked")];
  if (!checked.length) return;

  btn.disabled      = true;
  msgEl.textContent = "Importing…";
  msgEl.className   = "signup-message info";

  const showAll = document.getElementById("fcShowImported").checked;
  const visible = showAll ? currentEvents : currentEvents.filter(e => !e.alreadyImported);

  let imported = 0, failed = 0;

  for (const cb of checked) {
    const idx = parseInt(cb.dataset.idx);
    const ev  = visible[idx];
    if (!ev || ev.alreadyImported) continue;

    const row     = cb.closest("tr");
    const typeSel = row?.querySelector(".fc-type-select");
    const teamSel = row?.querySelector(".fc-team-select");
    const facSel  = row?.querySelector(".fc-fac-select");
    const umpCb   = row?.querySelector(".fc-ump-cb");

    const type      = typeSel?.value || ev.suggestedType;
    const teamOpt   = teamSel?.options[teamSel.selectedIndex];
    const teamId    = teamSel?.value || "";
    const teamName  = teamOpt?.dataset.name || (teamOpt?.value ? teamOpt.text : "") || ev.suggestedTeamName || "";
    const needsUmp  = umpCb?.checked ?? false;

    // Resolve facilityId: from per-row selector (org mode) or page-level (facility mode)
    const facilityId = facSel?.value || ev.detectedFacilityId || currentFacilityId || "";
    const facilityName = facSel
      ? (facSel.options[facSel.selectedIndex]?.text || "")
      : (ev.detectedFacilityName || "");

    // Derive a field name for practices: use detected field name or facility name
    const fieldStr = ev.detectedFieldName || facilityName || ev.location || "";

    try {
      if (type === "practice") {
        await addDoc(collection(db, "practices"), {
          teamName:   teamName,
          teamId:     teamId,
          date:       ev.date,
          startTime:  ev.time    || "",
          endTime:    ev.endTime || "",
          field:      fieldStr,
          facilityId,
          summary:    ev.summary || "",
          division:   ev.division || "",
          source:     "field-calendar",
          icsUid:     ev.uid,
          externalId: ev.uid,
          createdAt:  serverTimestamp(),
        });
      } else {
        // game or other → games collection
        await addDoc(collection(db, "games"), {
          teamName:     teamName,
          teamId:       teamId,
          division:     ev.division || "",
          date:         ev.date,
          time:         ev.time    || "",
          field:        fieldStr,
          facilityId,
          homeTeam:     ev.homeTeam  || "",
          awayTeam:     ev.opponent  || ev.awayTeam || "",
          isAway:       false,
          needsUmpires: needsUmp,
          umpireSlots:  needsUmp ? [{ type: "Plate", payRate: 0 }, { type: "Field", payRate: 0 }] : [],
          cancelled:    false,
          type:         type === "other" ? "External" : "League",
          source:       "field-calendar",
          icsUid:       ev.uid,
          externalId:   ev.uid,
          summary:      ev.summary || "",
          createdAt:    serverTimestamp(),
        });
      }
      ev.alreadyImported = true;
      imported++;
    } catch (err) {
      console.error("Import error:", err);
      failed++;
    }
  }

  msgEl.textContent = failed
    ? `✓ Imported ${imported}. ${failed} failed — check console.`
    : `✓ ${imported} event${imported !== 1 ? "s" : ""} imported successfully.`;
  msgEl.className = failed ? "signup-message error" : "signup-message success";

  const newCount = currentEvents.filter(e => !e.alreadyImported).length;
  document.getElementById("fcNewCount").textContent  = `${newCount} new event${newCount !== 1 ? "s" : ""} found`;
  document.getElementById("fcSkipCount").textContent =
    currentEvents.length - newCount ? `(${currentEvents.length - newCount} already imported, hidden)` : "";

  renderTable();
  btn.disabled = false;
}
