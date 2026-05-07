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

// ── Field form helpers ────────────────────────────────────────────────────────

// Generates the inner rows of an add or edit field form.
// prefix: "add" | "edit", fId: facility id, f: existing field data (or null)
function fieldFormRows(prefix, fId, f = {}) {
  const p = `${prefix}Field`;
  const id = fId;
  const chk = (key) => f[key] ? "checked" : "";
  const val = (key) => esc(f[key] || "");

  return `
    <div class="form-row">
      <div class="form-group">
        <label for="${p}Name_${id}" style="margin-top:0">Field Name</label>
        <input type="text" id="${p}Name_${id}" value="${val("name")}" placeholder="e.g. NH-North" />
      </div>
    </div>

    <div class="form-row" style="margin-top:12px">
      <div class="form-group">
        <label style="margin-top:0;margin-bottom:4px">Amenities</label>
        <div class="check-list" style="margin-top:4px">
          <label><input type="checkbox" id="${p}Concession_${id}" ${chk("concessionStand")} /> Concession Stand</label>
          <label><input type="checkbox" id="${p}Bathrooms_${id}" ${chk("bathrooms")} /> Bathrooms</label>
          <label><input type="checkbox" id="${p}Portapotty_${id}" ${chk("portapotty")} /> Porta-Potty</label>
          <label><input type="checkbox" id="${p}Lights_${id}" ${chk("lights")} /> Lights</label>
          <label><input type="checkbox" id="${p}Scoreboard_${id}" ${chk("scoreboard")} /> Scoreboard</label>
        </div>
      </div>
      <div class="form-group">
        <label style="margin-top:0;margin-bottom:4px">Pitching Mound</label>
        <div class="check-list" style="margin-top:4px">
          <label><input type="checkbox" id="${p}FixedMound_${id}" ${chk("fixedMound")} /> Fixed Mound</label>
          <label><input type="checkbox" id="${p}PortableMound_${id}" ${chk("portableMound")} /> Portable Mound</label>
        </div>
      </div>
    </div>

    <div class="form-row" style="margin-top:12px">
      <div class="form-group">
        <label for="${p}Basepath_${id}" style="margin-top:0">Basepath Length</label>
        <input type="text" id="${p}Basepath_${id}" value="${val("basepathLength")}" placeholder="e.g. 60 ft" />
      </div>
      <div class="form-group">
        <label for="${p}Pitching_${id}" style="margin-top:0">Pitching Distance</label>
        <input type="text" id="${p}Pitching_${id}" value="${val("pitchingDistance")}" placeholder="e.g. 44 ft" />
      </div>
    </div>

    <div class="form-row" style="margin-top:4px">
      <div class="form-group">
        <label for="${p}Dimensions_${id}" style="margin-top:0">Field Dimensions</label>
        <input type="text" id="${p}Dimensions_${id}" value="${val("fieldDimensions")}" placeholder="e.g. 200ft LF, 225ft CF" />
      </div>
    </div>

    <div class="form-row" style="margin-top:4px">
      <div class="form-group">
        <label for="${p}Notes_${id}" style="margin-top:0">Notes</label>
        <input type="text" id="${p}Notes_${id}" value="${val("notes")}" placeholder="Any additional notes" />
      </div>
    </div>`;
}

// Reads all field form inputs and returns a field data object
function readFieldForm(prefix, fId) {
  const p  = `${prefix}Field`;
  const id = fId;
  const v  = (elId) => document.getElementById(elId)?.value.trim() || "";
  const c  = (elId) => document.getElementById(elId)?.checked || false;

  return {
    name:             v(`${p}Name_${id}`),
    concessionStand:  c(`${p}Concession_${id}`),
    bathrooms:        c(`${p}Bathrooms_${id}`),
    portapotty:       c(`${p}Portapotty_${id}`),
    lights:           c(`${p}Lights_${id}`),
    scoreboard:       c(`${p}Scoreboard_${id}`),
    fixedMound:       c(`${p}FixedMound_${id}`),
    portableMound:    c(`${p}PortableMound_${id}`),
    basepathLength:   v(`${p}Basepath_${id}`),
    pitchingDistance: v(`${p}Pitching_${id}`),
    fieldDimensions:  v(`${p}Dimensions_${id}`),
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

// Renders amenity badge chips for a field
function fieldAmenityBadges(f) {
  const items = [
    [f.concessionStand,  "Concessions"],
    [f.bathrooms,        "Bathrooms"],
    [f.portapotty,       "Porta-Potty"],
    [f.lights,           "Lights"],
    [f.scoreboard,       "Scoreboard"],
    [f.fixedMound,       "Fixed Mound"],
    [f.portableMound,    "Portable Mound"],
  ].filter(([on]) => on).map(([, label]) =>
    `<span style="display:inline-block;background:#2a3a2a;color:#8fc;border:1px solid #3a5a3a;border-radius:10px;padding:1px 8px;font-size:0.75rem;white-space:nowrap">${label}</span>`
  );
  return items.length ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${items.join("")}</div>` : "";
}

// Renders measurement line for a field
function fieldMeasurements(f) {
  const parts = [];
  if (f.basepathLength)   parts.push(`Basepath: ${esc(f.basepathLength)}`);
  if (f.pitchingDistance) parts.push(`Pitching: ${esc(f.pitchingDistance)}`);
  if (f.fieldDimensions)  parts.push(esc(f.fieldDimensions));
  return parts.length
    ? `<div style="font-size:0.82rem;color:var(--light-text);margin-top:3px">${parts.join(" · ")}</div>`
    : "";
}

function renderFacilityCard(id, data) {
  const fields  = data.fields || [];
  const mapsLink = data.googleMapsUrl
    ? `<a href="${esc(data.googleMapsUrl)}" target="_blank" rel="noopener" style="font-size:0.85rem">View on Google Maps</a>`
    : "";

  const fieldsList = fields.length
    ? `<ul class="facility-fields-list">
        ${fields.map((f, i) => `
          <li data-field-index="${i}" style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:8px 0">
            <div style="min-width:0">
              <strong>${esc(f.name)}</strong>
              ${fieldMeasurements(f)}
              ${fieldAmenityBadges(f)}
              ${f.notes ? `<div style="font-size:0.82rem;color:var(--light-text);margin-top:2px">${esc(f.notes)}</div>` : ""}
            </div>
            <span style="white-space:nowrap;flex-shrink:0">
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
        <div>
          <h3 style="margin:0 0 4px">${esc(data.name)}</h3>
          ${data.address ? `<p style="margin:0 0 4px;color:var(--light-text);font-size:0.9rem">${esc(data.address)}</p>` : ""}
          ${mapsLink}
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
  document.getElementById("facilityName").value    = "";
  document.getElementById("facilityAddress").value = "";
  document.getElementById("facilityMapsUrl").value = "";
  setMsg("addFacilityMessage", "", "info");
});

document.getElementById("saveAddFacilityBtn").addEventListener("click", async () => {
  const name    = document.getElementById("facilityName").value.trim();
  const address = document.getElementById("facilityAddress").value.trim();
  const mapsUrl = document.getElementById("facilityMapsUrl").value.trim();

  if (!name) { setMsg("addFacilityMessage", "Facility name is required.", "error"); return; }

  const btn = document.getElementById("saveAddFacilityBtn");
  btn.disabled = true;
  setMsg("addFacilityMessage", "Saving…", "info");

  try {
    await addDoc(collection(db, "facilities"), {
      name, address, googleMapsUrl: mapsUrl, fields: [], createdAt: serverTimestamp()
    });
    setMsg("addFacilityMessage", "Facility added!", "success");
    document.getElementById("facilityName").value    = "";
    document.getElementById("facilityAddress").value = "";
    document.getElementById("facilityMapsUrl").value = "";
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

  if (!name) {
    const msgEl = document.getElementById(`editFacilityMsg_${facilityId}`);
    if (msgEl) { msgEl.textContent = "Name is required."; msgEl.className = "signup-message error"; }
    return;
  }

  try {
    await updateDoc(doc(db, "facilities", facilityId), {
      name, address: address || "", googleMapsUrl: mapsUrl || ""
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
  // Hide add-field form if open
  const addForm = document.getElementById(`addFieldForm_${facilityId}`);
  if (addForm) addForm.style.display = "none";

  const editForm = document.getElementById(`editFieldForm_${facilityId}`);
  if (!editForm) return;

  // Use cached facility data to populate the form
  const cachedData = facilitiesCache[facilityId];
  const f = cachedData?.fields?.[fieldIndex] || {};

  document.getElementById(`editFieldIndex_${facilityId}`).value = fieldIndex;

  // Populate each field — use element IDs from fieldFormRows("edit", ...)
  const p  = "editField";
  const id = facilityId;
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val || ""; };
  const chk = (elId, val) => { const el = document.getElementById(elId); if (el) el.checked = !!val; };

  set(`${p}Name_${id}`,       f.name);
  set(`${p}Basepath_${id}`,   f.basepathLength);
  set(`${p}Pitching_${id}`,   f.pitchingDistance);
  set(`${p}Dimensions_${id}`, f.fieldDimensions);
  set(`${p}Notes_${id}`,      f.notes);

  chk(`${p}Concession_${id}`,   f.concessionStand);
  chk(`${p}Bathrooms_${id}`,    f.bathrooms);
  chk(`${p}Portapotty_${id}`,   f.portapotty);
  chk(`${p}Lights_${id}`,       f.lights);
  chk(`${p}Scoreboard_${id}`,   f.scoreboard);
  chk(`${p}FixedMound_${id}`,   f.fixedMound);
  chk(`${p}PortableMound_${id}`, f.portableMound);

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
  const editFacBtn = e.target.closest(".edit-facility-btn");
  if (editFacBtn) {
    const id   = editFacBtn.dataset.facilityId;
    const form = document.getElementById(`editFacilityForm_${id}`);
    if (form) form.style.display = form.style.display === "none" ? "" : "none";
    return;
  }

  const cancelFacEdit = e.target.closest(".cancel-facility-edit-btn");
  if (cancelFacEdit) {
    const id   = cancelFacEdit.dataset.facilityId;
    const form = document.getElementById(`editFacilityForm_${id}`);
    if (form) form.style.display = "none";
    return;
  }

  const saveFacEdit = e.target.closest(".save-facility-edit-btn");
  if (saveFacEdit) { saveFacilityEdit(saveFacEdit.dataset.facilityId); return; }

  const delFacBtn = e.target.closest(".delete-facility-btn");
  if (delFacBtn) { deleteFacility(delFacBtn.dataset.facilityId); return; }

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
    const id = cancelAddField.dataset.facilityId;
    const form = document.getElementById(`addFieldForm_${id}`);
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
    const id   = cancelEditField.dataset.facilityId;
    const form = document.getElementById(`editFieldForm_${id}`);
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
