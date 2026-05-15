// admin-field-calendar.js — Field calendar import workflow
import { db, app }                      from "./firebase.js";
import { authReadyPromise, isAdmin }    from "./auth.js";
import { esc }                          from "./utils.js";
import {
  collection, getDocs, addDoc, doc, getDoc, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getFunctions, httpsCallable }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

const functions         = getFunctions(app);
const fetchFacilityIcs  = httpsCallable(functions, "fetchFacilityIcs");

let currentFacilityId   = "";
let currentEvents       = [];   // full event list from last fetch
let teams               = [];   // for import form

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

  // Check for ?facility= query param
  const params     = new URLSearchParams(window.location.search);
  const paramFacId = params.get("facility");

  if (paramFacId) {
    // Specific facility requested
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
    // Show facility picker — only facilities with externalIcsUrl
    document.getElementById("fcFacilityPickWrap").style.display = "";
    await loadFacilityPicker();
  }

  wireBtns();
});

async function loadFacilityPicker() {
  const sel = document.getElementById("fcFacilitySel");
  if (!sel) return;
  try {
    const snap = await getDocs(query(collection(db, "facilities"), orderBy("name")));
    const withUrl = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(f => f.externalIcsUrl);

    if (!withUrl.length) {
      sel.innerHTML = '<option value="">No facilities have an external calendar URL configured.</option>';
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
  if (!currentFacilityId) return;
  const btn    = document.getElementById("fcFetchBtn");
  const status = document.getElementById("fcFetchStatus");
  const wrap   = document.getElementById("fcResultWrap");

  btn.disabled   = true;
  status.textContent = "Fetching calendar…";
  wrap.style.display = "none";

  try {
    const result = await fetchFacilityIcs({ facilityId: currentFacilityId });
    currentEvents = result.data.events || [];
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

function formatDate(dateStr) {
  // "2026-06-15" → "Mon Jun 15"
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  } catch { return dateStr; }
}

function formatTime(t) {
  if (!t) return "—";
  try {
    const [h, m] = t.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    return `${((h % 12) || 12)}:${String(m).padStart(2,"0")} ${ampm}`;
  } catch { return t; }
}

function renderTable() {
  const tbody       = document.getElementById("fcTableBody");
  const showAll     = document.getElementById("fcShowImported").checked;
  const visible     = showAll ? currentEvents : currentEvents.filter(e => !e.alreadyImported);

  tbody.innerHTML = visible.map((ev, rowIdx) => {
    const isImported = ev.alreadyImported;
    const rowClass   = isImported ? "already-imported" : "";
    const badge      = isImported
      ? `<span class="fc-badge imported">Imported</span>`
      : `<span class="fc-badge ${ev.suggestedType}">${ev.suggestedType}</span>`;

    const timeStr = ev.time
      ? `${formatTime(ev.time)}${ev.endTime ? " – " + formatTime(ev.endTime) : ""}`
      : "All day";

    const teamSel = isImported ? "" : `
      <select class="fc-team-select" data-idx="${rowIdx}">
        ${teamOptions(ev.suggestedTeamId)}
      </select>`;

    const typeSel = isImported ? badge : `
      <select class="fc-type-select" data-idx="${rowIdx}">
        <option value="game"     ${ev.suggestedType === "game"     ? "selected" : ""}>⚾ Game</option>
        <option value="practice" ${ev.suggestedType === "practice" ? "selected" : ""}>🏋 Practice</option>
        <option value="other"    ${ev.suggestedType === "other"    ? "selected" : ""}>📅 Other</option>
      </select>`;

    const umpireCheck = isImported ? "" :
      `<input type="checkbox" class="fc-ump-cb" data-idx="${rowIdx}"${ev.suggestedType === "game" ? " checked" : ""} />`;

    const locationSub = ev.location ? `<div class="fc-sub">📍 ${esc(ev.location)}</div>` : "";
    const teamsSub = (ev.homeTeam || ev.awayTeam)
      ? `<div class="fc-sub">${esc(ev.awayTeam || "")}${ev.awayTeam && ev.homeTeam ? " @ " : ""}${esc(ev.homeTeam || "")}</div>`
      : "";

    return `<tr class="${rowClass}" data-uid="${esc(ev.uid)}">
      <td><input type="checkbox" class="fc-row-cb" data-idx="${rowIdx}" ${isImported ? "disabled" : ""} /></td>
      <td style="white-space:nowrap">${esc(formatDate(ev.date))}</td>
      <td style="white-space:nowrap;font-size:0.82rem">${timeStr}</td>
      <td>
        <div class="fc-summary">${esc(ev.summary || "(no title)")}</div>
        ${locationSub}${teamsSub}
      </td>
      <td>${typeSel}</td>
      <td>${teamSel}</td>
      <td style="text-align:center">${umpireCheck}</td>
    </tr>`;
  }).join("");

  // Wire type-change to toggle umpire checkbox default
  tbody.querySelectorAll(".fc-type-select").forEach(sel => {
    sel.addEventListener("change", () => {
      const idx   = parseInt(sel.dataset.idx);
      const umpCb = tbody.querySelector(`.fc-ump-cb[data-idx="${idx}"]`);
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
  const msgEl  = document.getElementById("fcImportMsg");
  const btn    = document.getElementById("fcImportBtn");
  const tbody  = document.getElementById("fcTableBody");
  const checked = [...document.querySelectorAll(".fc-row-cb:checked")];
  if (!checked.length) return;

  btn.disabled   = true;
  msgEl.textContent = "Importing…";
  msgEl.className   = "signup-message info";

  let imported = 0, failed = 0;

  for (const cb of checked) {
    const idx  = parseInt(cb.dataset.idx);
    const showAll = document.getElementById("fcShowImported").checked;
    const visible = showAll ? currentEvents : currentEvents.filter(e => !e.alreadyImported);
    const ev   = visible[idx];
    if (!ev || ev.alreadyImported) continue;

    const row     = cb.closest("tr");
    const typeSel = row?.querySelector(".fc-type-select");
    const teamSel = row?.querySelector(".fc-team-select");
    const umpCb   = row?.querySelector(".fc-ump-cb");

    const type       = typeSel?.value || ev.suggestedType;
    const teamOpt    = teamSel?.options[teamSel.selectedIndex];
    const teamId     = teamSel?.value || "";
    const teamName   = teamOpt?.dataset.name || teamOpt?.text || "";
    const needsUmp   = umpCb?.checked ?? false;

    try {
      if (type === "practice") {
        await addDoc(collection(db, "practices"), {
          teamName:   teamName || ev.suggestedTeamName || "",
          teamId:     teamId || ev.suggestedTeamId || "",
          date:       ev.date,
          startTime:  ev.time || "",
          endTime:    ev.endTime || "",
          field:      ev.location || "",
          facilityId: currentFacilityId,
          summary:    ev.summary || "",
          source:     "field-calendar",
          icsUid:     ev.uid,
          createdAt:  serverTimestamp(),
        });
      } else {
        // game or other → goes to games collection
        await addDoc(collection(db, "games"), {
          teamName:     teamName || ev.suggestedTeamName || "",
          teamId:       teamId || ev.suggestedTeamId || "",
          division:     "",
          date:         ev.date,
          time:         ev.time || "",
          field:        ev.location || (ev.homeTeam || ev.awayTeam ? `${ev.homeTeam} vs ${ev.awayTeam}` : ""),
          facilityId:   currentFacilityId,
          homeTeam:     ev.homeTeam || "",
          awayTeam:     ev.awayTeam || "",
          isAway:       false,
          needsUmpires: needsUmp,
          umpireSlots:  needsUmp ? [{ type: "Plate", payRate: 0 }, { type: "Field", payRate: 0 }] : [],
          cancelled:    false,
          type:         type === "other" ? "External" : "League",
          source:       "field-calendar",
          icsUid:       ev.uid,
          externalId:   ev.uid,   // also store as externalId for sync dedup
          summary:      ev.summary || "",
          createdAt:    serverTimestamp(),
        });
      }
      ev.alreadyImported = true;  // mark in memory so re-render shows it imported
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

  // Update counts
  const newCount = currentEvents.filter(e => !e.alreadyImported).length;
  document.getElementById("fcNewCount").textContent  = `${newCount} new event${newCount !== 1 ? "s" : ""} found`;
  document.getElementById("fcSkipCount").textContent =
    currentEvents.length - newCount ? `(${currentEvents.length - newCount} already imported, hidden)` : "";

  renderTable();
  btn.disabled = false;
}
