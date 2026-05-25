// admin-facilities.js — Facilities CRUD with per-facility fields management
import { db } from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import { esc, setMsg, showToast, showConfirm } from "./utils.js";

import {
  collection,
  getDocs,
  getDoc,
  doc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

// In-memory cache so edit forms can read full field objects without DOM scraping
let facilitiesCache = {}; // { [facilityId]: facilityData }

// ── Dynamic row HTML helpers ──────────────────────────────────────────────────

function basepathRowHtml(label = "", distance = "") {
  return `<div class="dynamic-row" style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
    <input class="bp-label" type="text" placeholder="Label (e.g. 10U)" value="${esc(label)}" style="flex:1;min-width:60px" />
    <input class="bp-dist" type="text" placeholder="Distance (e.g. 60 ft)" value="${esc(distance)}" style="flex:2;min-width:80px" />
    <button type="button" class="remove-row-btn" title="Remove"
      style="background:#5a1a1a;color:white;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;flex-shrink:0">×</button>
  </div>`;
}

function pitchingRowHtml(type = "", distance = "", label = "") {
  const opt = (v, t) => `<option value="${v}" ${type === v ? "selected" : ""}>${t}</option>`;
  return `<div class="dynamic-row" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
    <select class="pm-type" style="flex:1;min-width:110px">
      <option value="">-- Type --</option>
      ${opt("Fixed","Fixed")}
      ${opt("Portable","Portable")}
      ${opt("Flat","Flat")}
    </select>
    <input class="pm-dist" type="text" placeholder="Distance (e.g. 44 ft)" value="${esc(distance)}" style="flex:2;min-width:80px" />
    <input class="pm-label" type="text" placeholder="Label (opt., e.g. 10U)" value="${esc(label)}" style="flex:1;min-width:70px" />
    <button type="button" class="remove-row-btn" title="Remove"
      style="background:#5a1a1a;color:white;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;flex-shrink:0">×</button>
  </div>`;
}

function addRowBtn(containerId, type) {
  return `<button type="button" class="btn print-btn add-row-btn"
    data-container="${containerId}" data-type="${type}"
    style="font-size:0.78rem;padding:3px 10px;margin-top:2px">+ Add</button>`;
}

// ── Field form section helper ─────────────────────────────────────────────────

function formSection(title) {
  return `<p style="margin:16px 0 6px;font-weight:bold;color:#aaa;font-size:0.85rem;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #333;padding-bottom:4px">${title}</p>`;
}

// ── Field form generator ──────────────────────────────────────────────────────

function fieldFormRows(prefix, fId, f = {}) {
  const p  = `${prefix}Field`;
  const id = fId;
  const chk = (key) => f[key] ? "checked" : "";
  const val = (key) => esc(f[key] || "");
  const sel = (key, opt) => opt === (f[key] || "") ? "selected" : "";

  // Backward-compat: migrate old single-value fields into arrays for rendering
  const basepaths = Array.isArray(f.basepaths) && f.basepaths.length
    ? f.basepaths
    : (f.basepathLength ? [{ label: "", distance: f.basepathLength }] : []);

  const pitchingMounds = Array.isArray(f.pitchingMounds) && f.pitchingMounds.length
    ? f.pitchingMounds
    : [
        ...(f.pitchingDistance ? [{ type: f.fixedMound ? "Fixed" : f.portableMound ? "Portable" : "", distance: f.pitchingDistance, label: "" }] : []),
      ];

  const bpContainerId = `${p}BasepathRows_${id}`;
  const pmContainerId = `${p}PitchingRows_${id}`;

  return `
    ${formSection("Basic")}
    <div class="form-row">
      <div class="form-group">
        <label for="${p}Name_${id}" style="margin-top:0">Field Name</label>
        <input type="text" id="${p}Name_${id}" value="${val("name")}" placeholder="e.g. NH-North" />
      </div>
    </div>

    ${formSection("Basepath Distances")}
    <div style="font-size:0.82rem;color:var(--light-text);margin-bottom:8px">Add one entry per basepath configuration (e.g. one for 10U, one for 12U).</div>
    <div id="${bpContainerId}">
      ${basepaths.map(b => basepathRowHtml(b.label, b.distance)).join("") || basepathRowHtml()}
    </div>
    ${addRowBtn(bpContainerId, "basepath")}

    ${formSection("Pitching Mounds")}
    <div style="font-size:0.82rem;color:var(--light-text);margin-bottom:8px">Add one entry per mound (type, distance, and optional division label).</div>
    <div id="${pmContainerId}">
      ${pitchingMounds.map(m => pitchingRowHtml(m.type, m.distance, m.label)).join("") || pitchingRowHtml()}
    </div>
    ${addRowBtn(pmContainerId, "pitching")}

    ${formSection("Fence & Outfield")}
    <div class="form-row">
      <div class="form-group">
        <label for="${p}LF_${id}" style="margin-top:0">LF Distance</label>
        <input type="text" id="${p}LF_${id}" value="${val("distanceLF")}" placeholder="e.g. 200 ft" />
      </div>
      <div class="form-group">
        <label for="${p}CF_${id}" style="margin-top:0">CF Distance</label>
        <input type="text" id="${p}CF_${id}" value="${val("distanceCF")}" placeholder="e.g. 225 ft" />
      </div>
      <div class="form-group">
        <label for="${p}RF_${id}" style="margin-top:0">RF Distance</label>
        <input type="text" id="${p}RF_${id}" value="${val("distanceRF")}" placeholder="e.g. 200 ft" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label for="${p}FenceHeight_${id}" style="margin-top:0">Fence Height</label>
        <input type="text" id="${p}FenceHeight_${id}" value="${val("fenceHeight")}" placeholder="e.g. 4 ft" />
      </div>
      <div class="form-group">
        <label for="${p}FenceType_${id}" style="margin-top:0">Fence Type</label>
        <select id="${p}FenceType_${id}">
          <option value="" ${sel("fenceType","")}>-- Select --</option>
          <option value="Permanent" ${sel("fenceType","Permanent")}>Permanent</option>
          <option value="Temporary" ${sel("fenceType","Temporary")}>Temporary</option>
          <option value="Mixed" ${sel("fenceType","Mixed")}>Mixed</option>
        </select>
      </div>
    </div>

    ${formSection("Surface")}
    <div class="form-row">
      <div class="form-group">
        <label for="${p}InfieldSurface_${id}" style="margin-top:0">Infield Surface</label>
        <select id="${p}InfieldSurface_${id}">
          <option value="" ${sel("infieldSurface","")}>-- Select --</option>
          <option value="Natural Grass" ${sel("infieldSurface","Natural Grass")}>Natural Grass</option>
          <option value="Dirt" ${sel("infieldSurface","Dirt")}>Dirt</option>
          <option value="Artificial Turf" ${sel("infieldSurface","Artificial Turf")}>Artificial Turf</option>
        </select>
      </div>
      <div class="form-group">
        <label for="${p}OutfieldSurface_${id}" style="margin-top:0">Outfield Surface</label>
        <select id="${p}OutfieldSurface_${id}">
          <option value="" ${sel("outfieldSurface","")}>-- Select --</option>
          <option value="Natural Grass" ${sel("outfieldSurface","Natural Grass")}>Natural Grass</option>
          <option value="Artificial Turf" ${sel("outfieldSurface","Artificial Turf")}>Artificial Turf</option>
        </select>
      </div>
    </div>

    ${formSection("Supported Divisions")}
    <div style="font-size:0.82rem;color:var(--light-text);margin-bottom:8px">Which age groups can play on this field? Used by the Scheduling Assistant to flag mismatches.</div>
    ${(() => {
      const divs = Array.isArray(f.supportedDivisions) ? f.supportedDivisions : [];
      const dc = (div) => divs.includes(div) ? "checked" : "";
      return `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px 24px;margin-top:8px">
        <label class="check-list-item"><input type="checkbox" id="${p}Div10U_${id}" ${dc("10U")} /> 10U</label>
        <label class="check-list-item"><input type="checkbox" id="${p}Div12U_${id}" ${dc("12U")} /> 12U</label>
        <label class="check-list-item"><input type="checkbox" id="${p}Div14U_${id}" ${dc("14U")} /> 14U</label>
        <label class="check-list-item"><input type="checkbox" id="${p}DivHSJV_${id}" ${dc("HS JV")} /> HS JV</label>
        <label class="check-list-item"><input type="checkbox" id="${p}DivHSVar_${id}" ${dc("HS Varsity")} /> HS Varsity</label>
      </div>`;
    })()}

    ${formSection("Amenities")}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;margin-top:8px">
      <label class="check-list-item"><input type="checkbox" id="${p}Concession_${id}" ${chk("concessionStand")} /> Concession Stand</label>
      <label class="check-list-item"><input type="checkbox" id="${p}PA_${id}" ${chk("paSystem")} /> PA System</label>
      <label class="check-list-item"><input type="checkbox" id="${p}Bathrooms_${id}" ${chk("bathrooms")} /> Bathrooms</label>
      <label class="check-list-item"><input type="checkbox" id="${p}FirstAid_${id}" ${chk("firstAid")} /> First Aid Kit</label>
      <label class="check-list-item"><input type="checkbox" id="${p}Portapotty_${id}" ${chk("portapotty")} /> Porta-Potty</label>
      <label class="check-list-item"><input type="checkbox" id="${p}BattingCage_${id}" ${chk("battingCage")} /> Batting Cage</label>
      <label class="check-list-item"><input type="checkbox" id="${p}Lights_${id}" ${chk("lights")} /> Lights</label>
      <label class="check-list-item"><input type="checkbox" id="${p}WarningTrack_${id}" ${chk("warningTrack")} /> Warning Track</label>
      <label class="check-list-item"><input type="checkbox" id="${p}Scoreboard_${id}" ${chk("scoreboard")} /> Scoreboard</label>
      <label class="check-list-item"><input type="checkbox" id="${p}CoveredSeating_${id}" ${chk("coveredSeating")} /> Covered/Shaded Seating</label>
    </div>

    ${formSection("Umpire Info")}
    <div class="form-row">
      <div class="form-group">
        <label for="${p}HomeDugout_${id}" style="margin-top:0">Home Dugout Side</label>
        <select id="${p}HomeDugout_${id}">
          <option value="" ${sel("homeDugoutSide","")}>-- Unknown --</option>
          <option value="1st Base" ${sel("homeDugoutSide","1st Base")}>1st Base Side</option>
          <option value="3rd Base" ${sel("homeDugoutSide","3rd Base")}>3rd Base Side</option>
        </select>
      </div>
      <div class="form-group">
        <label for="${p}Equipment_${id}" style="margin-top:0">Equipment Storage</label>
        <input type="text" id="${p}Equipment_${id}" value="${val("equipmentStorage")}" placeholder="e.g. Concession stand cabinet" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label for="${p}Sun_${id}" style="margin-top:0">Sun / Visibility Notes</label>
        <input type="text" id="${p}Sun_${id}" value="${val("sunNotes")}" placeholder="e.g. Sun in batter's eyes 4–6 PM facing west" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label for="${p}GroundRules_${id}" style="margin-top:0">Ground Rules</label>
        <textarea id="${p}GroundRules_${id}" rows="3"
          placeholder="List any special local ground rules…"
          style="width:100%;padding:10px 12px;border:1px solid #555;border-radius:6px;background:var(--field);color:#eee;font-size:0.95rem;box-sizing:border-box;resize:vertical">${val("groundRules")}</textarea>
      </div>
    </div>

    ${formSection("Active Issues")}
    <div style="font-size:0.82rem;color:var(--light-text);margin-bottom:8px">Note any current field problems to be addressed. Issues display as a warning to umpires.</div>
    <div class="form-row">
      <div class="form-group">
        <textarea id="${p}Issues_${id}" rows="3"
          placeholder="e.g. Pitching rubber is cracked and needs replacement. Infield has standing water near 2nd base."
          style="width:100%;padding:10px 12px;border:1px solid #b8860b;border-radius:6px;background:#2a2200;color:#eee;font-size:0.95rem;box-sizing:border-box;resize:vertical">${val("activeIssues")}</textarea>
      </div>
    </div>

    ${formSection("General Notes")}
    <div class="form-row">
      <div class="form-group">
        <label for="${p}Notes_${id}" style="margin-top:0">Notes</label>
        <input type="text" id="${p}Notes_${id}" value="${val("notes")}" placeholder="Any additional notes" />
      </div>
    </div>`;
}

// ── Read field form ───────────────────────────────────────────────────────────

function readFieldForm(prefix, fId) {
  const p  = `${prefix}Field`;
  const id = fId;
  const v  = (elId) => document.getElementById(elId)?.value.trim() || "";
  const c  = (elId) => document.getElementById(elId)?.checked || false;

  // Read dynamic basepath rows
  const bpContainer = document.getElementById(`${p}BasepathRows_${id}`);
  const basepaths = [...(bpContainer?.querySelectorAll(".dynamic-row") || [])].map(row => ({
    label:    row.querySelector(".bp-label")?.value.trim() || "",
    distance: row.querySelector(".bp-dist")?.value.trim()  || "",
  })).filter(b => b.distance);

  // Read dynamic pitching mound rows
  const pmContainer = document.getElementById(`${p}PitchingRows_${id}`);
  const pitchingMounds = [...(pmContainer?.querySelectorAll(".dynamic-row") || [])].map(row => ({
    type:     row.querySelector(".pm-type")?.value  || "",
    distance: row.querySelector(".pm-dist")?.value.trim() || "",
    label:    row.querySelector(".pm-label")?.value.trim() || "",
  })).filter(m => m.distance || m.type);

  // Only the divisions rendered in fieldFormRows — T-ball/6U/8U have no checkboxes in the form
  const DIVS = ["10U","12U","14U","HS JV","HS Varsity"];
  const divMap = { "10U": `${p}Div10U_${id}`, "12U": `${p}Div12U_${id}`,
                   "14U": `${p}Div14U_${id}`, "HS JV": `${p}DivHSJV_${id}`,
                   "HS Varsity": `${p}DivHSVar_${id}` };
  const supportedDivisions = DIVS.filter(d => c(divMap[d]));

  return {
    name:             v(`${p}Name_${id}`),
    // Scheduling
    supportedDivisions,
    // Measurements
    basepaths,
    pitchingMounds,
    distanceLF:       v(`${p}LF_${id}`),
    distanceCF:       v(`${p}CF_${id}`),
    distanceRF:       v(`${p}RF_${id}`),
    fenceHeight:      v(`${p}FenceHeight_${id}`),
    fenceType:        v(`${p}FenceType_${id}`),
    // Surface
    infieldSurface:   v(`${p}InfieldSurface_${id}`),
    outfieldSurface:  v(`${p}OutfieldSurface_${id}`),
    // Amenities
    concessionStand:  c(`${p}Concession_${id}`),
    bathrooms:        c(`${p}Bathrooms_${id}`),
    portapotty:       c(`${p}Portapotty_${id}`),
    lights:           c(`${p}Lights_${id}`),
    scoreboard:       c(`${p}Scoreboard_${id}`),
    paSystem:         c(`${p}PA_${id}`),
    firstAid:         c(`${p}FirstAid_${id}`),
    battingCage:      c(`${p}BattingCage_${id}`),
    warningTrack:     c(`${p}WarningTrack_${id}`),
    coveredSeating:   c(`${p}CoveredSeating_${id}`),
    // Umpire info
    homeDugoutSide:   v(`${p}HomeDugout_${id}`),
    equipmentStorage: v(`${p}Equipment_${id}`),
    sunNotes:         v(`${p}Sun_${id}`),
    groundRules:      v(`${p}GroundRules_${id}`),
    // Issues & notes
    activeIssues:     v(`${p}Issues_${id}`),
    notes:            v(`${p}Notes_${id}`),
  };
}

// ── Facilities List ───────────────────────────────────────────────────────────

async function loadFacilities() {
  const listEl = document.getElementById("facilitiesList");
  if (!listEl) return;

  try {
    const [facSnap, codesSnap] = await Promise.all([
      getDocs(collection(db, "facilities")),
      getDocs(collection(db, "facilityCodes"))
    ]);

    if (facSnap.empty) {
      listEl.innerHTML = `<p style="color:var(--light-text)">No facilities added yet. Click "Add Facility" to create one.</p>`;
      facilitiesCache = {};
      return;
    }

    const shedCodes = {};
    codesSnap.docs.forEach(d => { shedCodes[d.id] = d.data().shedCode || ""; });

    facilitiesCache = {};
    facSnap.docs.forEach(d => { facilitiesCache[d.id] = d.data(); });
    listEl.innerHTML = facSnap.docs.map(d => renderFacilityCard(d.id, d.data(), shedCodes[d.id] || "")).join("");
  } catch (err) {
    listEl.innerHTML = `<p style="color:#ffb4b4">Error loading facilities: ${esc(err.message)}</p>`;
    console.error(err);
  }
}

// ── Card display helpers ──────────────────────────────────────────────────────

function issuesBanner(text, style = "") {
  if (!text?.trim()) return "";
  return `<div style="background:#2a1a00;border:1px solid #b8860b;border-radius:6px;padding:8px 12px;margin-top:6px;${style}">
    <span style="color:#f5c842;font-weight:bold;font-size:0.8rem">⚠ Active Issues</span>
    <div style="color:#f5c842;font-size:0.85rem;margin-top:4px;white-space:pre-wrap">${esc(text)}</div>
  </div>`;
}

function fieldDivisionBadges(f) {
  const divs = Array.isArray(f.supportedDivisions) ? f.supportedDivisions : [];
  if (!divs.length) return "";
  const badges = divs.map(d =>
    `<span style="display:inline-block;background:#1a2a3a;color:#7ec8f7;border:1px solid #2a4a6a;border-radius:10px;padding:1px 8px;font-size:0.75rem;white-space:nowrap">${d}</span>`
  ).join("");
  return `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${badges}</div>`;
}

function fieldAmenityBadges(f) {
  const amenities = [
    [f.concessionStand, "Concessions"],
    [f.bathrooms,       "Bathrooms"],
    [f.portapotty,      "Porta-Potty"],
    [f.lights,          "Lights"],
    [f.scoreboard,      "Scoreboard"],
    [f.paSystem,        "PA System"],
    [f.firstAid,        "First Aid"],
    [f.battingCage,     "Batting Cage"],
    [f.warningTrack,    "Warning Track"],
    [f.coveredSeating,  "Covered Seating"],
  ].filter(([on]) => on).map(([, label]) =>
    `<span style="display:inline-block;background:#2a3a2a;color:#8fc;border:1px solid #3a5a3a;border-radius:10px;padding:1px 8px;font-size:0.75rem;white-space:nowrap">${label}</span>`
  );
  return amenities.length ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${amenities.join("")}</div>` : "";
}

function fieldInfoBlock(f) {
  const lines = [];

  // Basepath distances (array or legacy single)
  const basepaths = Array.isArray(f.basepaths) && f.basepaths.length
    ? f.basepaths
    : (f.basepathLength ? [{ label: "", distance: f.basepathLength }] : []);
  if (basepaths.length) {
    const bpStr = basepaths.map(b => b.label ? `${esc(b.label)}: ${esc(b.distance)}` : esc(b.distance)).join(", ");
    lines.push(`Basepath: ${bpStr}`);
  }

  // Pitching mounds (array or legacy single)
  const pitchingMounds = Array.isArray(f.pitchingMounds) && f.pitchingMounds.length
    ? f.pitchingMounds
    : [
        ...(f.pitchingDistance ? [{ type: f.fixedMound ? "Fixed" : f.portableMound ? "Portable" : "", distance: f.pitchingDistance, label: "" }] : [])
      ];
  if (pitchingMounds.length) {
    const pmStr = pitchingMounds.map(m => {
      const parts = [m.type, m.distance, m.label].filter(Boolean);
      return parts.join(" ");
    }).join(" · ");
    lines.push(`Pitching: ${pmStr}`);
  }

  // Fence distances
  const fences = [f.distanceLF, f.distanceCF, f.distanceRF].filter(Boolean);
  if (fences.length) lines.push(`Fences: ${fences.map(esc).join(" / ")}`);

  const fenceDetail = [
    f.fenceHeight ? `Height: ${esc(f.fenceHeight)}` : "",
    f.fenceType   ? `Type: ${esc(f.fenceType)}` : "",
  ].filter(Boolean);
  if (fenceDetail.length) lines.push(fenceDetail.join(" · "));

  // Surface
  const surf = [
    f.infieldSurface  ? `Infield: ${esc(f.infieldSurface)}`  : "",
    f.outfieldSurface ? `Outfield: ${esc(f.outfieldSurface)}` : "",
  ].filter(Boolean);
  if (surf.length) lines.push(surf.join(" · "));

  // Umpire info
  if (f.homeDugoutSide)   lines.push(`Home dugout: ${esc(f.homeDugoutSide)} side`);
  if (f.equipmentStorage) lines.push(`Equipment: ${esc(f.equipmentStorage)}`);
  if (f.sunNotes)         lines.push(`☀ ${esc(f.sunNotes)}`);

  const html = lines.map(l =>
    `<div style="font-size:0.82rem;color:var(--light-text);margin-top:2px">${l}</div>`
  ).join("");

  const groundRulesHtml = f.groundRules
    ? `<div style="font-size:0.82rem;color:#c8a;margin-top:4px"><strong style="color:#dbb">Ground rules:</strong> ${esc(f.groundRules).replace(/\n/g, "<br>")}</div>`
    : "";

  return html + groundRulesHtml;
}

// ── Facility card renderer ────────────────────────────────────────────────────

function renderFacilityCard(id, data, shedCode = "") {
  const fields  = data.fields || [];
  const mapsLink = data.googleMapsUrl
    ? `<a href="${esc(data.googleMapsUrl)}" target="_blank" rel="noopener" style="font-size:0.85rem">View on Google Maps</a>`
    : "";

  const fieldsList = fields.length
    ? `<ul class="facility-fields-list">
        ${fields.map((f, i) => `
          <li data-field-index="${i}" style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:8px 0">
            <div style="min-width:0;flex:1">
              <strong>${esc(f.name)}</strong>
              ${fieldInfoBlock(f)}
              ${fieldDivisionBadges(f)}
              ${fieldAmenityBadges(f)}
              ${f.notes ? `<div style="font-size:0.82rem;color:var(--light-text);margin-top:2px">${esc(f.notes)}</div>` : ""}
              ${issuesBanner(f.activeIssues)}
            </div>
            <span style="white-space:nowrap;flex-shrink:0;margin-left:8px">
              <button class="btn print-btn edit-field-btn"
                data-facility-id="${esc(id)}" data-field-index="${i}"
                style="font-size:0.75rem;padding:2px 8px;margin-right:4px">Edit</button>
              <button class="btn delete-field-btn"
                data-facility-id="${esc(id)}" data-field-index="${i}"
                style="font-size:0.75rem;padding:2px 8px;background:#5a1a1a">Del</button>
            </span>
          </li>`).join("")}
      </ul>`
    : `<p style="color:var(--light-text);font-size:0.88rem;margin:8px 0">No fields added yet.</p>`;

  return `
    <div class="facility-card" id="facility_${esc(id)}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
        <div style="flex:1;min-width:0">
          <h3 style="margin:0 0 4px">${esc(data.name)}</h3>
          ${data.address ? `<p style="margin:0 0 4px;color:var(--light-text);font-size:0.9rem">${esc(data.address)}</p>` : ""}
          ${mapsLink}
          ${data.notes ? `<div style="font-size:0.85rem;color:var(--light-text);margin-top:6px">${esc(data.notes)}</div>` : ""}
          ${shedCode ? `<div style="margin-top:8px;display:inline-flex;align-items:center;gap:8px;background:#1a2a1a;border:1px solid #2a6a2a;border-radius:6px;padding:6px 12px;font-size:0.9rem">🔑 <strong>Shed Code:</strong> <span style="font-family:monospace;font-size:1rem;letter-spacing:0.1em">${esc(shedCode)}</span></div>` : `<div style="margin-top:8px;font-size:0.82rem;color:var(--light-text)">🔑 No shed code set</div>`}
          ${data.externalIcsUrl
            ? `<a href="admin-field-calendar.html?facility=${esc(id)}" class="btn print-btn" style="font-size:0.8rem;padding:4px 10px;margin-top:4px;display:inline-block">📅 Import Field Calendar</a>`
            : ""}
          ${issuesBanner(data.activeIssues)}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap">
          <a href="facility-schedule.html?id=${esc(id)}" target="_blank"
            class="btn print-btn" style="font-size:0.82rem;padding:5px 12px;text-decoration:none">📅 Schedule</a>
          <button class="btn print-btn copy-schedule-link-btn" data-facility-id="${esc(id)}"
            style="font-size:0.82rem;padding:5px 12px" title="Copy shareable link to clipboard">🔗 Copy Link</button>
          <button class="btn print-btn edit-facility-btn" data-facility-id="${esc(id)}"
            style="font-size:0.82rem;padding:5px 12px">Edit</button>
          <button class="btn delete-facility-btn" data-facility-id="${esc(id)}"
            style="font-size:0.82rem;padding:5px 12px;background:#5a1a1a">Delete</button>
        </div>
      </div>

      <!-- Edit facility inline form (hidden) -->
      <div id="editFacilityForm_${esc(id)}" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid #444">
        <div class="form-row">
          <div class="form-group">
            <label for="editFacilityName_${esc(id)}">Name</label>
            <input type="text" id="editFacilityName_${esc(id)}" value="${esc(data.name)}" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="editFacilityAddress_${esc(id)}">Address</label>
            <input type="text" id="editFacilityAddress_${esc(id)}" value="${esc(data.address || "")}" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="editFacilityMaps_${esc(id)}">Google Maps URL</label>
            <input type="url" id="editFacilityMaps_${esc(id)}" value="${esc(data.googleMapsUrl || "")}" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="editFacilityIcs_${esc(id)}">External Calendar URL <span style="font-weight:normal;color:var(--light-text);font-size:0.82rem">(iCal/ICS subscription)</span></label>
            <input type="url" id="editFacilityIcs_${esc(id)}" value="${esc(data.externalIcsUrl || "")}" placeholder="webcal:// or https://..." />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="editFacilityLat_${esc(id)}" title="Overrides org-level weather coordinates for this facility">Weather Lat <span style="color:var(--light-text);font-size:0.8rem">(optional)</span></label>
            <input type="number" step="any" id="editFacilityLat_${esc(id)}" value="${esc(data.weatherLat ?? "")}" placeholder="e.g. 43.6503" />
          </div>
          <div class="form-group">
            <label for="editFacilityLon_${esc(id)}" title="Overrides org-level weather coordinates for this facility">Weather Lon <span style="color:var(--light-text);font-size:0.8rem">(optional)</span></label>
            <input type="number" step="any" id="editFacilityLon_${esc(id)}" value="${esc(data.weatherLon ?? "")}" placeholder="e.g. -96.8108" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="editFacilityNotes_${esc(id)}">Facility Notes</label>
            <input type="text" id="editFacilityNotes_${esc(id)}" value="${esc(data.notes || "")}" placeholder="General notes about this facility" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="editFacilityShedCode_${esc(id)}">🔑 Shed / Equipment Code</label>
            <input type="text" id="editFacilityShedCode_${esc(id)}" value="${esc(shedCode)}" placeholder="e.g. 1234 or B-7-2" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="editFacilityIssues_${esc(id)}" style="color:#f5c842">⚠ Active Issues</label>
            <textarea id="editFacilityIssues_${esc(id)}" rows="3"
              placeholder="Current facility-level issues to be addressed or notify umpires…"
              style="width:100%;padding:10px 12px;border:1px solid #b8860b;border-radius:6px;background:#2a2200;color:#eee;font-size:0.95rem;box-sizing:border-box;resize:vertical">${esc(data.activeIssues || "")}</textarea>
          </div>
        </div>
        <div class="page-actions" style="margin-top:12px">
          <button class="btn save-facility-edit-btn" data-facility-id="${esc(id)}"
            style="font-size:0.85rem">Save</button>
          <button class="btn print-btn cancel-facility-edit-btn" data-facility-id="${esc(id)}"
            style="font-size:0.85rem">Cancel</button>
        </div>
        <p id="editFacilityMsg_${esc(id)}" class="signup-message"></p>
      </div>

      <!-- Fields section -->
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid #444">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong style="color:#ccc;font-size:0.9rem">Fields</strong>
          <button class="btn print-btn show-add-field-btn" data-facility-id="${esc(id)}"
            style="font-size:0.78rem;padding:3px 10px">+ Add Field</button>
        </div>

        ${fieldsList}

        <!-- Add field inline form (hidden) -->
        <div id="addFieldForm_${esc(id)}" style="display:none;margin-top:12px;padding:16px;background:#1a1a1a;border-radius:6px;border:1px solid #444">
          <strong style="color:#ccc;font-size:0.9rem">New Field</strong>
          ${fieldFormRows("add", id)}
          <div class="page-actions" style="margin-top:12px">
            <button class="btn save-add-field-btn" data-facility-id="${esc(id)}"
              style="font-size:0.82rem;padding:5px 12px">Add Field</button>
            <button class="btn print-btn cancel-add-field-btn" data-facility-id="${esc(id)}"
              style="font-size:0.82rem;padding:5px 12px">Cancel</button>
          </div>
          <p id="addFieldMsg_${esc(id)}" class="signup-message"></p>
        </div>

        <!-- Edit field inline form (hidden) -->
        <div id="editFieldForm_${esc(id)}" style="display:none;margin-top:12px;padding:16px;background:#1a1a1a;border-radius:6px;border:1px solid #444">
          <strong style="color:#ccc;font-size:0.9rem">Edit Field</strong>
          <input type="hidden" id="editFieldIndex_${esc(id)}" value="" />
          ${fieldFormRows("edit", id)}
          <div class="page-actions" style="margin-top:12px">
            <button class="btn save-edit-field-btn" data-facility-id="${esc(id)}"
              style="font-size:0.82rem;padding:5px 12px">Save Field</button>
            <button class="btn print-btn cancel-edit-field-btn" data-facility-id="${esc(id)}"
              style="font-size:0.82rem;padding:5px 12px">Cancel</button>
          </div>
          <p id="editFieldMsg_${esc(id)}" class="signup-message"></p>
        </div>
      </div>
    </div>`;
}

// ── Add Facility ──────────────────────────────────────────────────────────────

document.getElementById("showAddFacilityBtn").addEventListener("click", () => {
  const form = document.getElementById("addFacilityForm");
  form.style.display = form.style.display === "none" ? "" : "none";
});

document.getElementById("cancelAddFacilityBtn").addEventListener("click", () => {
  document.getElementById("addFacilityForm").style.display = "none";
  ["facilityName","facilityAddress","facilityMapsUrl","facilityExternalIcs","facilityNotes","facilityIssues"]
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  setMsg("addFacilityMessage", "", "info");
});

document.getElementById("saveAddFacilityBtn").addEventListener("click", async () => {
  const name          = document.getElementById("facilityName").value.trim();
  const address        = document.getElementById("facilityAddress").value.trim();
  const mapsUrl        = document.getElementById("facilityMapsUrl").value.trim();
  const externalIcsUrl = document.getElementById("facilityExternalIcs")?.value.trim() || "";
  const notes          = document.getElementById("facilityNotes")?.value.trim() || "";
  const issues         = document.getElementById("facilityIssues")?.value.trim() || "";
  const shedCode       = document.getElementById("facilityShedCode")?.value.trim() || "";

  if (!name) { setMsg("addFacilityMessage", "Facility name is required.", "error"); return; }

  const btn = document.getElementById("saveAddFacilityBtn");
  btn.disabled = true;
  setMsg("addFacilityMessage", "Saving…", "info");

  try {
    const newRef = await addDoc(collection(db, "facilities"), {
      name, address, googleMapsUrl: mapsUrl, externalIcsUrl, notes, activeIssues: issues,
      fields: [], createdAt: serverTimestamp()
    });
    await setDoc(doc(db, "facilityCodes", newRef.id), { shedCode });
    setMsg("addFacilityMessage", "Facility added!", "success");
    ["facilityName","facilityAddress","facilityMapsUrl","facilityExternalIcs","facilityNotes","facilityIssues","facilityShedCode"]
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
    document.getElementById("addFacilityForm").style.display = "none";
    await loadFacilities();
  } catch (err) {
    setMsg("addFacilityMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Facility CRUD helpers ─────────────────────────────────────────────────────

async function saveFacilityEdit(facilityId) {
  const name           = document.getElementById(`editFacilityName_${facilityId}`)?.value.trim();
  const address        = document.getElementById(`editFacilityAddress_${facilityId}`)?.value.trim();
  const mapsUrl        = document.getElementById(`editFacilityMaps_${facilityId}`)?.value.trim();
  const externalIcsUrl = document.getElementById(`editFacilityIcs_${facilityId}`)?.value.trim() || "";
  const notes          = document.getElementById(`editFacilityNotes_${facilityId}`)?.value.trim() || "";
  const issues         = document.getElementById(`editFacilityIssues_${facilityId}`)?.value.trim() || "";
  const shedCode       = document.getElementById(`editFacilityShedCode_${facilityId}`)?.value.trim() || "";
  const weatherLat     = parseFloat(document.getElementById(`editFacilityLat_${facilityId}`)?.value) || null;
  const weatherLon     = parseFloat(document.getElementById(`editFacilityLon_${facilityId}`)?.value) || null;

  if (!name) {
    const msgEl = document.getElementById(`editFacilityMsg_${facilityId}`);
    if (msgEl) { msgEl.textContent = "Name is required."; msgEl.className = "signup-message error"; }
    return;
  }

  try {
    await Promise.all([
      updateDoc(doc(db, "facilities", facilityId), {
        name, address: address || "", googleMapsUrl: mapsUrl || "",
        externalIcsUrl,
        notes, activeIssues: issues,
        ...(weatherLat != null ? { weatherLat } : {}),
        ...(weatherLon != null ? { weatherLon } : {}),
      }),
      setDoc(doc(db, "facilityCodes", facilityId), { shedCode })
    ]);
    await loadFacilities();
  } catch (err) {
    const msgEl = document.getElementById(`editFacilityMsg_${facilityId}`);
    if (msgEl) { msgEl.textContent = err.message; msgEl.className = "signup-message error"; }
  }
}

async function deleteFacility(facilityId) {
  if (!await showConfirm("Permanently delete this facility and all its fields?")) return;
  try {
    await deleteDoc(doc(db, "facilities", facilityId));
    await loadFacilities();
  } catch (err) {
    showToast(err.message);
  }
}

// ── Field CRUD helpers ────────────────────────────────────────────────────────

async function addField(facilityId) {
  const field = readFieldForm("add", facilityId);

  if (!field.name) {
    const msgEl = document.getElementById(`addFieldMsg_${facilityId}`);
    if (msgEl) { msgEl.textContent = "Field name is required."; msgEl.className = "signup-message error"; }
    return;
  }

  try {
    const ref  = doc(db, "facilities", facilityId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const fields = [...(snap.data().fields || []), field];
    await updateDoc(ref, { fields });
    await loadFacilities();
  } catch (err) {
    const msgEl = document.getElementById(`addFieldMsg_${facilityId}`);
    if (msgEl) { msgEl.textContent = err.message; msgEl.className = "signup-message error"; }
  }
}

function openEditFieldForm(facilityId, fieldIndex) {
  const addForm = document.getElementById(`addFieldForm_${facilityId}`);
  if (addForm) addForm.style.display = "none";

  const editForm = document.getElementById(`editFieldForm_${facilityId}`);
  if (!editForm) return;

  const f = facilitiesCache[facilityId]?.fields?.[fieldIndex] || {};

  document.getElementById(`editFieldIndex_${facilityId}`).value = fieldIndex;

  const p  = "editField";
  const id = facilityId;
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val || ""; };
  const chk = (elId, val) => { const el = document.getElementById(elId); if (el) el.checked = !!val; };

  // Basic
  set(`${p}Name_${id}`,             f.name);
  // Fence & outfield
  set(`${p}LF_${id}`,               f.distanceLF);
  set(`${p}CF_${id}`,               f.distanceCF);
  set(`${p}RF_${id}`,               f.distanceRF);
  set(`${p}FenceHeight_${id}`,      f.fenceHeight);
  set(`${p}FenceType_${id}`,        f.fenceType);
  // Surface
  set(`${p}InfieldSurface_${id}`,   f.infieldSurface);
  set(`${p}OutfieldSurface_${id}`,  f.outfieldSurface);
  // Amenities
  chk(`${p}Concession_${id}`,       f.concessionStand);
  chk(`${p}Bathrooms_${id}`,        f.bathrooms);
  chk(`${p}Portapotty_${id}`,       f.portapotty);
  chk(`${p}Lights_${id}`,           f.lights);
  chk(`${p}Scoreboard_${id}`,       f.scoreboard);
  chk(`${p}PA_${id}`,               f.paSystem);
  chk(`${p}FirstAid_${id}`,         f.firstAid);
  chk(`${p}BattingCage_${id}`,      f.battingCage);
  chk(`${p}WarningTrack_${id}`,     f.warningTrack);
  chk(`${p}CoveredSeating_${id}`,   f.coveredSeating);
  // Umpire info
  set(`${p}HomeDugout_${id}`,       f.homeDugoutSide);
  set(`${p}Equipment_${id}`,        f.equipmentStorage);
  set(`${p}Sun_${id}`,              f.sunNotes);
  set(`${p}GroundRules_${id}`,      f.groundRules);
  // Supported divisions
  const divs = Array.isArray(f.supportedDivisions) ? f.supportedDivisions : [];
  const divIdMap = { "10U": `${p}Div10U_${id}`, "12U": `${p}Div12U_${id}`,
                     "14U": `${p}Div14U_${id}`, "HS JV": `${p}DivHSJV_${id}`,
                     "HS Varsity": `${p}DivHSVar_${id}` };
  Object.entries(divIdMap).forEach(([div, elId]) => chk(elId, divs.includes(div)));
  // Issues & notes
  set(`${p}Issues_${id}`,           f.activeIssues);
  set(`${p}Notes_${id}`,            f.notes);

  // Rebuild dynamic basepath rows from cached data
  const bpContainer = document.getElementById(`${p}BasepathRows_${id}`);
  if (bpContainer) {
    const basepaths = Array.isArray(f.basepaths) && f.basepaths.length
      ? f.basepaths
      : (f.basepathLength ? [{ label: "", distance: f.basepathLength }] : []);
    bpContainer.innerHTML = basepaths.length
      ? basepaths.map(b => basepathRowHtml(b.label, b.distance)).join("")
      : basepathRowHtml();
  }

  // Rebuild dynamic pitching mound rows from cached data
  const pmContainer = document.getElementById(`${p}PitchingRows_${id}`);
  if (pmContainer) {
    const mounds = Array.isArray(f.pitchingMounds) && f.pitchingMounds.length
      ? f.pitchingMounds
      : (f.pitchingDistance ? [{ type: f.fixedMound ? "Fixed" : f.portableMound ? "Portable" : "", distance: f.pitchingDistance, label: "" }] : []);
    pmContainer.innerHTML = mounds.length
      ? mounds.map(m => pitchingRowHtml(m.type, m.distance, m.label)).join("")
      : pitchingRowHtml();
  }

  editForm.style.display = "";
}

async function saveEditField(facilityId) {
  const indexInput = document.getElementById(`editFieldIndex_${facilityId}`);
  const msgEl      = document.getElementById(`editFieldMsg_${facilityId}`);
  const fieldIndex = parseInt(indexInput?.value, 10);
  const field      = readFieldForm("edit", facilityId);

  if (!field.name) {
    if (msgEl) { msgEl.textContent = "Field name is required."; msgEl.className = "signup-message error"; }
    return;
  }

  try {
    const ref  = doc(db, "facilities", facilityId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const fields = [...(snap.data().fields || [])];
    fields[fieldIndex] = field;
    await updateDoc(ref, { fields });
    await loadFacilities();
  } catch (err) {
    if (msgEl) { msgEl.textContent = err.message; msgEl.className = "signup-message error"; }
  }
}

async function deleteField(facilityId, fieldIndex) {
  if (!await showConfirm("Delete this field?")) return;
  try {
    const ref  = doc(db, "facilities", facilityId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const fields = [...(snap.data().fields || [])];
    fields.splice(fieldIndex, 1);
    await updateDoc(ref, { fields });
    await loadFacilities();
  } catch (err) {
    showToast(err.message);
  }
}

// ── Event delegation ──────────────────────────────────────────────────────────

document.addEventListener("click", e => {
  // Dynamic row — add
  const addRowBtnEl = e.target.closest(".add-row-btn");
  if (addRowBtnEl) {
    const container = document.getElementById(addRowBtnEl.dataset.container);
    if (container) {
      container.insertAdjacentHTML("beforeend",
        addRowBtnEl.dataset.type === "basepath" ? basepathRowHtml() : pitchingRowHtml()
      );
    }
    return;
  }

  // Dynamic row — remove
  const removeRowBtnEl = e.target.closest(".remove-row-btn");
  if (removeRowBtnEl) {
    removeRowBtnEl.closest(".dynamic-row")?.remove();
    return;
  }

  // Copy schedule link
  const copyLinkBtn = e.target.closest(".copy-schedule-link-btn");
  if (copyLinkBtn) {
    const id  = copyLinkBtn.dataset.facilityId;
    const url = `${window.location.origin}/facility-schedule.html?id=${id}`;
    navigator.clipboard.writeText(url).then(() => {
      const orig = copyLinkBtn.textContent;
      copyLinkBtn.textContent = "✓ Copied!";
      setTimeout(() => { copyLinkBtn.textContent = orig; }, 2000);
    }).catch(() => { prompt("Copy this link:", url); });
    return;
  }

  // Edit facility
  const editFacBtn = e.target.closest(".edit-facility-btn");
  if (editFacBtn) {
    const id   = editFacBtn.dataset.facilityId;
    const form = document.getElementById(`editFacilityForm_${id}`);
    if (form) form.style.display = form.style.display === "none" ? "" : "none";
    return;
  }

  const cancelFacEdit = e.target.closest(".cancel-facility-edit-btn");
  if (cancelFacEdit) {
    const form = document.getElementById(`editFacilityForm_${cancelFacEdit.dataset.facilityId}`);
    if (form) form.style.display = "none";
    return;
  }

  const saveFacEdit = e.target.closest(".save-facility-edit-btn");
  if (saveFacEdit) { saveFacilityEdit(saveFacEdit.dataset.facilityId); return; }

  const delFacBtn = e.target.closest(".delete-facility-btn");
  if (delFacBtn) { deleteFacility(delFacBtn.dataset.facilityId); return; }

  // Show add-field form
  const showAddFieldBtn = e.target.closest(".show-add-field-btn");
  if (showAddFieldBtn) {
    const id      = showAddFieldBtn.dataset.facilityId;
    const addForm = document.getElementById(`addFieldForm_${id}`);
    if (addForm) addForm.style.display = addForm.style.display === "none" ? "" : "none";
    const editForm = document.getElementById(`editFieldForm_${id}`);
    if (editForm) editForm.style.display = "none";
    return;
  }

  const cancelAddField = e.target.closest(".cancel-add-field-btn");
  if (cancelAddField) {
    const form = document.getElementById(`addFieldForm_${cancelAddField.dataset.facilityId}`);
    if (form) form.style.display = "none";
    return;
  }

  const saveAddField = e.target.closest(".save-add-field-btn");
  if (saveAddField) { addField(saveAddField.dataset.facilityId); return; }

  const editFieldBtn = e.target.closest(".edit-field-btn");
  if (editFieldBtn) {
    openEditFieldForm(editFieldBtn.dataset.facilityId, parseInt(editFieldBtn.dataset.fieldIndex, 10));
    return;
  }

  const cancelEditField = e.target.closest(".cancel-edit-field-btn");
  if (cancelEditField) {
    const form = document.getElementById(`editFieldForm_${cancelEditField.dataset.facilityId}`);
    if (form) form.style.display = "none";
    return;
  }

  const saveEditFieldBtn = e.target.closest(".save-edit-field-btn");
  if (saveEditFieldBtn) { saveEditField(saveEditFieldBtn.dataset.facilityId); return; }

  const delFieldBtn = e.target.closest(".delete-field-btn");
  if (delFieldBtn) {
    deleteField(delFieldBtn.dataset.facilityId, parseInt(delFieldBtn.dataset.fieldIndex, 10));
    return;
  }
});

// ── Field Issues (admin) ──────────────────────────────────────────────────────

let allIssues   = [];
let issueFilter = "open";

function fmtDateTime(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function severityBadge(s) {
  const styles = {
    High:   "background:#3a0a0a;color:#f88;border-color:#c0392b",
    Medium: "background:#2a2000;color:#f5c842;border-color:#b8860b",
    Low:    "background:#0a2a0a;color:#8fc;border-color:#2a6a2a",
  };
  return `<span style="${styles[s] || "background:#222;color:#aaa;border-color:#444"};border:1px solid;border-radius:10px;padding:1px 8px;font-size:0.75rem">${esc(s || "—")}</span>`;
}

function statusBadge(s) {
  const styles = {
    Open:         "background:#3a0808;color:#f88;border-color:#c0392b",
    "In Progress":"background:#2a2000;color:#f5c842;border-color:#b8860b",
    Resolved:     "background:#0a2a0a;color:#8fc;border-color:#2a6a2a",
  };
  return `<span style="${styles[s] || "background:#222;color:#aaa;border-color:#444"};border:1px solid;border-radius:10px;padding:1px 8px;font-size:0.75rem">${esc(s || "—")}</span>`;
}

async function loadFieldIssues() {
  const listEl = document.getElementById("fieldIssuesList");
  if (!listEl) return;
  try {
    const snap = await getDocs(
      query(collection(db, "fieldIssues"), orderBy("submittedAt", "desc"))
    );
    allIssues = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFieldIssues();
  } catch (err) {
    listEl.innerHTML = `<p style="color:#ffb4b4">Error: ${esc(err.message)}</p>`;
    console.error(err);
  }
}

function renderFieldIssues() {
  const listEl = document.getElementById("fieldIssuesList");
  if (!listEl) return;

  const visible = allIssues.filter(r => {
    if (issueFilter === "open")        return r.status === "Open";
    if (issueFilter === "in-progress") return r.status === "In Progress";
    return true;
  });

  if (visible.length === 0) {
    listEl.innerHTML = `<p style="color:var(--light-text)">No issues match the current filter.</p>`;
    return;
  }

  listEl.innerHTML = visible.map(r => {
    const loc = r.fieldName
      ? `${esc(r.facilityName)} — ${esc(r.fieldName)}`
      : esc(r.facilityName);

    return `
      <div class="facility-card" style="margin-bottom:12px" id="issue_${esc(r.id)}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
              ${statusBadge(r.status)}
              ${severityBadge(r.severity)}
              ${r.category ? `<span style="font-size:0.8rem;color:var(--light-text)">${esc(r.category)}</span>` : ""}
            </div>
            <strong style="font-size:1rem">${esc(r.title)}</strong>
            <div style="font-size:0.85rem;color:var(--light-text);margin-top:2px">
              ${loc} &nbsp;·&nbsp; Reported by ${esc(r.reporterName)} &nbsp;·&nbsp; ${fmtDateTime(r.submittedAt)}
            </div>
            ${r.description ? `<div style="margin-top:6px;font-size:0.9rem;color:#ccc;white-space:pre-wrap">${esc(r.description)}</div>` : ""}
            ${r.adminNotes  ? `<div style="margin-top:6px;font-size:0.85rem;color:#aaa;font-style:italic;border-left:2px solid #555;padding-left:8px">Admin notes: ${esc(r.adminNotes)}</div>` : ""}
            ${r.status === "Resolved" && r.resolvedByName
              ? `<div style="font-size:0.8rem;color:#8fc;margin-top:4px">Resolved by ${esc(r.resolvedByName)} on ${fmtDateTime(r.resolvedAt)}</div>` : ""}
          </div>
          <button class="btn print-btn toggle-issue-edit-btn" data-issue-id="${esc(r.id)}"
            style="font-size:0.78rem;padding:4px 10px;flex-shrink:0">Update</button>
        </div>

        <!-- Admin update panel (hidden) -->
        <div id="issueEdit_${esc(r.id)}" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid #444">
          <div class="form-row">
            <div class="form-group">
              <label for="issueStatus_${esc(r.id)}" style="margin-top:0">Status</label>
              <select id="issueStatus_${esc(r.id)}">
                <option value="Open"        ${r.status === "Open"         ? "selected" : ""}>Open</option>
                <option value="In Progress" ${r.status === "In Progress"  ? "selected" : ""}>In Progress</option>
                <option value="Resolved"    ${r.status === "Resolved"     ? "selected" : ""}>Resolved</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="issueAdminNotes_${esc(r.id)}" style="margin-top:0">Admin Notes</label>
              <textarea id="issueAdminNotes_${esc(r.id)}" rows="3"
                placeholder="Internal notes on the issue, actions taken, who to contact, etc."
                style="width:100%;padding:10px 12px;border:1px solid #555;border-radius:6px;background:var(--field);color:#eee;font-size:0.9rem;box-sizing:border-box;resize:vertical">${esc(r.adminNotes || "")}</textarea>
            </div>
          </div>
          <div class="page-actions" style="margin-top:8px">
            <button class="btn save-issue-btn" data-issue-id="${esc(r.id)}" style="font-size:0.85rem">Save Update</button>
            <button class="btn print-btn toggle-issue-edit-btn" data-issue-id="${esc(r.id)}" style="font-size:0.85rem">Cancel</button>
          </div>
          <p id="issueEditMsg_${esc(r.id)}" class="signup-message"></p>
        </div>
      </div>`;
  }).join("");
}

async function saveIssueUpdate(issueId) {
  const status     = document.getElementById(`issueStatus_${issueId}`)?.value;
  const adminNotes = document.getElementById(`issueAdminNotes_${issueId}`)?.value.trim() || "";
  const msgEl      = document.getElementById(`issueEditMsg_${issueId}`);

  const updates = { status, adminNotes };

  // Auto-stamp resolved fields
  if (status === "Resolved") {
    const issue = allIssues.find(r => r.id === issueId);
    if (issue?.status !== "Resolved") {
      // Only set resolvedAt/resolvedBy the first time it's resolved
      // We don't have getCurrentUser here, but we can import via auth
      updates.resolvedAt = serverTimestamp();
    }
  } else {
    updates.resolvedAt    = null;
    updates.resolvedBy    = "";
    updates.resolvedByName = "";
  }

  try {
    await updateDoc(doc(db, "fieldIssues", issueId), updates);
    if (msgEl) { msgEl.textContent = "Saved."; msgEl.className = "signup-message success"; }
    // Update local cache
    const idx = allIssues.findIndex(r => r.id === issueId);
    if (idx !== -1) Object.assign(allIssues[idx], updates);
    setTimeout(() => {
      document.getElementById(`issueEdit_${issueId}`)?.style &&
        (document.getElementById(`issueEdit_${issueId}`).style.display = "none");
      renderFieldIssues();
    }, 600);
  } catch (err) {
    if (msgEl) { msgEl.textContent = err.message; msgEl.className = "signup-message error"; }
  }
}

// Wire issue filter buttons
document.addEventListener("click", e => {
  const filterBtn = e.target.closest(".filter-btn[data-issue-filter]");
  if (filterBtn) {
    issueFilter = filterBtn.dataset.issueFilter;
    document.querySelectorAll(".filter-btn[data-issue-filter]").forEach(b => {
      b.classList.toggle("filter-active", b === filterBtn);
      b.classList.toggle("print-btn", b !== filterBtn);
    });
    renderFieldIssues();
    return;
  }

  const toggleBtn = e.target.closest(".toggle-issue-edit-btn");
  if (toggleBtn) {
    const panel = document.getElementById(`issueEdit_${toggleBtn.dataset.issueId}`);
    if (panel) panel.style.display = panel.style.display === "none" ? "" : "none";
    return;
  }

  const saveBtn = e.target.closest(".save-issue-btn");
  if (saveBtn) { saveIssueUpdate(saveBtn.dataset.issueId); return; }
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

  loadFacilities();
  loadFieldIssues();
});
