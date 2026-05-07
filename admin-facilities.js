// admin-facilities.js — Facilities CRUD with per-facility fields management
import { db } from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setMsg(id, text, type = "info") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = `signup-message ${type}`;
}

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

    ${formSection("Amenities")}
    <div class="form-row">
      <div class="form-group">
        <div class="check-list" style="margin-top:4px">
          <label><input type="checkbox" id="${p}Concession_${id}" ${chk("concessionStand")} /> Concession Stand</label>
          <label><input type="checkbox" id="${p}Bathrooms_${id}" ${chk("bathrooms")} /> Bathrooms</label>
          <label><input type="checkbox" id="${p}Portapotty_${id}" ${chk("portapotty")} /> Porta-Potty</label>
          <label><input type="checkbox" id="${p}Lights_${id}" ${chk("lights")} /> Lights</label>
          <label><input type="checkbox" id="${p}Scoreboard_${id}" ${chk("scoreboard")} /> Scoreboard</label>
        </div>
      </div>
      <div class="form-group">
        <div class="check-list" style="margin-top:4px">
          <label><input type="checkbox" id="${p}PA_${id}" ${chk("paSystem")} /> PA System</label>
          <label><input type="checkbox" id="${p}FirstAid_${id}" ${chk("firstAid")} /> First Aid Kit</label>
          <label><input type="checkbox" id="${p}BattingCage_${id}" ${chk("battingCage")} /> Batting Cage</label>
          <label><input type="checkbox" id="${p}WarningTrack_${id}" ${chk("warningTrack")} /> Warning Track</label>
          <label><input type="checkbox" id="${p}CoveredSeating_${id}" ${chk("coveredSeating")} /> Covered/Shaded Seating</label>
        </div>
      </div>
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

  return {
    name:             v(`${p}Name_${id}`),
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
    const snap = await getDocs(collection(db, "facilities"));

    if (snap.empty) {
      listEl.innerHTML = `<p style="color:var(--light-text)">No facilities added yet. Click "Add Facility" to create one.</p>`;
      facilitiesCache = {};
      return;
    }

    facilitiesCache = {};
    snap.docs.forEach(d => { facilitiesCache[d.id] = d.data(); });
    listEl.innerHTML = snap.docs.map(d => renderFacilityCard(d.id, d.data())).join("");
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

function renderFacilityCard(id, data) {
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
          ${issuesBanner(data.activeIssues)}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
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
            <label for="editFacilityNotes_${esc(id)}">Facility Notes</label>
            <input type="text" id="editFacilityNotes_${esc(id)}" value="${esc(data.notes || "")}" placeholder="General notes about this facility" />
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
  ["facilityName","facilityAddress","facilityMapsUrl","facilityNotes","facilityIssues"]
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  setMsg("addFacilityMessage", "", "info");
});

document.getElementById("saveAddFacilityBtn").addEventListener("click", async () => {
  const name    = document.getElementById("facilityName").value.trim();
  const address = document.getElementById("facilityAddress").value.trim();
  const mapsUrl = document.getElementById("facilityMapsUrl").value.trim();
  const notes   = document.getElementById("facilityNotes")?.value.trim() || "";
  const issues  = document.getElementById("facilityIssues")?.value.trim() || "";

  if (!name) { setMsg("addFacilityMessage", "Facility name is required.", "error"); return; }

  const btn = document.getElementById("saveAddFacilityBtn");
  btn.disabled = true;
  setMsg("addFacilityMessage", "Saving…", "info");

  try {
    await addDoc(collection(db, "facilities"), {
      name, address, googleMapsUrl: mapsUrl, notes, activeIssues: issues,
      fields: [], createdAt: serverTimestamp()
    });
    setMsg("addFacilityMessage", "Facility added!", "success");
    ["facilityName","facilityAddress","facilityMapsUrl","facilityNotes","facilityIssues"]
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
  const name    = document.getElementById(`editFacilityName_${facilityId}`)?.value.trim();
  const address = document.getElementById(`editFacilityAddress_${facilityId}`)?.value.trim();
  const mapsUrl = document.getElementById(`editFacilityMaps_${facilityId}`)?.value.trim();
  const notes   = document.getElementById(`editFacilityNotes_${facilityId}`)?.value.trim() || "";
  const issues  = document.getElementById(`editFacilityIssues_${facilityId}`)?.value.trim() || "";

  if (!name) {
    const msgEl = document.getElementById(`editFacilityMsg_${facilityId}`);
    if (msgEl) { msgEl.textContent = "Name is required."; msgEl.className = "signup-message error"; }
    return;
  }

  try {
    await updateDoc(doc(db, "facilities", facilityId), {
      name, address: address || "", googleMapsUrl: mapsUrl || "",
      notes, activeIssues: issues
    });
    await loadFacilities();
  } catch (err) {
    const msgEl = document.getElementById(`editFacilityMsg_${facilityId}`);
    if (msgEl) { msgEl.textContent = err.message; msgEl.className = "signup-message error"; }
  }
}

async function deleteFacility(facilityId) {
  if (!confirm("Permanently delete this facility and all its fields?")) return;
  try {
    await deleteDoc(doc(db, "facilities", facilityId));
    await loadFacilities();
  } catch (err) {
    alert(err.message);
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
  if (!confirm("Delete this field?")) return;
  try {
    const ref  = doc(db, "facilities", facilityId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const fields = [...(snap.data().fields || [])];
    fields.splice(fieldIndex, 1);
    await updateDoc(ref, { fields });
    await loadFacilities();
  } catch (err) {
    alert(err.message);
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
});
