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

// ── Facilities List ───────────────────────────────────────────────────────────

async function loadFacilities() {
  const listEl = document.getElementById("facilitiesList");
  if (!listEl) return;

  try {
    const snap = await getDocs(collection(db, "facilities"));

    if (snap.empty) {
      listEl.innerHTML = `<p style="color:var(--light-text)">No facilities added yet. Click "Add Facility" to create one.</p>`;
      return;
    }

    listEl.innerHTML = snap.docs.map(d => renderFacilityCard(d.id, d.data())).join("");
  } catch (err) {
    listEl.innerHTML = `<p style="color:#ffb4b4">Error loading facilities: ${esc(err.message)}</p>`;
    console.error(err);
  }
}

function renderFacilityCard(id, data) {
  const fields = data.fields || [];
  const mapsLink = data.googleMapsUrl
    ? `<a href="${esc(data.googleMapsUrl)}" target="_blank" rel="noopener" style="font-size:0.85rem">View on Google Maps</a>`
    : "";

  const fieldsList = fields.length
    ? `<ul class="facility-fields-list">
        ${fields.map((f, i) => `
          <li data-field-index="${i}" style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
            <span>
              <strong>${esc(f.name)}</strong>
              ${f.notes ? `<span style="color:var(--light-text);font-size:0.85rem"> — ${esc(f.notes)}</span>` : ""}
            </span>
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
        <div id="addFieldForm_${esc(id)}" style="display:none;margin-top:12px;padding:12px;background:#1a1a1a;border-radius:6px;border:1px solid #444">
          <div class="form-row">
            <div class="form-group">
              <label for="addFieldName_${esc(id)}" style="margin-top:0">Field Name</label>
              <input type="text" id="addFieldName_${esc(id)}" placeholder="e.g. NH-North" />
            </div>
            <div class="form-group">
              <label for="addFieldNotes_${esc(id)}" style="margin-top:0">Notes (optional)</label>
              <input type="text" id="addFieldNotes_${esc(id)}" placeholder="e.g. Pitching rubber: 44ft" />
            </div>
          </div>
          <div class="page-actions" style="margin-top:8px">
            <button class="btn save-add-field-btn" data-facility-id="${esc(id)}"
              style="font-size:0.82rem;padding:5px 12px">Add Field</button>
            <button class="btn print-btn cancel-add-field-btn" data-facility-id="${esc(id)}"
              style="font-size:0.82rem;padding:5px 12px">Cancel</button>
          </div>
          <p id="addFieldMsg_${esc(id)}" class="signup-message"></p>
        </div>

        <!-- Edit field inline form (hidden) -->
        <div id="editFieldForm_${esc(id)}" style="display:none;margin-top:12px;padding:12px;background:#1a1a1a;border-radius:6px;border:1px solid #444">
          <input type="hidden" id="editFieldIndex_${esc(id)}" value="" />
          <div class="form-row">
            <div class="form-group">
              <label for="editFieldName_${esc(id)}" style="margin-top:0">Field Name</label>
              <input type="text" id="editFieldName_${esc(id)}" />
            </div>
            <div class="form-group">
              <label for="editFieldNotes_${esc(id)}" style="margin-top:0">Notes</label>
              <input type="text" id="editFieldNotes_${esc(id)}" />
            </div>
          </div>
          <div class="page-actions" style="margin-top:8px">
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
      name,
      address,
      googleMapsUrl: mapsUrl,
      fields: [],
      createdAt: serverTimestamp()
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
  const name  = document.getElementById(`addFieldName_${facilityId}`)?.value.trim();
  const notes = document.getElementById(`addFieldNotes_${facilityId}`)?.value.trim();

  if (!name) {
    const msgEl = document.getElementById(`addFieldMsg_${facilityId}`);
    if (msgEl) { msgEl.textContent = "Field name is required."; msgEl.className = "signup-message error"; }
    return;
  }

  try {
    const ref  = doc(db, "facilities", facilityId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const fields = [...(snap.data().fields || []), { name, notes: notes || "" }];
    await updateDoc(ref, { fields });
    await loadFacilities();
  } catch (err) {
    const msgEl = document.getElementById(`addFieldMsg_${facilityId}`);
    if (msgEl) { msgEl.textContent = err.message; msgEl.className = "signup-message error"; }
  }
}

function openEditFieldForm(facilityId, fieldIndex, currentName, currentNotes) {
  // Hide add-field form if open
  const addForm = document.getElementById(`addFieldForm_${facilityId}`);
  if (addForm) addForm.style.display = "none";

  const editForm = document.getElementById(`editFieldForm_${facilityId}`);
  if (!editForm) return;

  document.getElementById(`editFieldIndex_${facilityId}`).value = fieldIndex;
  document.getElementById(`editFieldName_${facilityId}`).value  = currentName;
  document.getElementById(`editFieldNotes_${facilityId}`).value = currentNotes;
  editForm.style.display = "";
}

async function saveEditField(facilityId) {
  const indexInput = document.getElementById(`editFieldIndex_${facilityId}`);
  const nameInput  = document.getElementById(`editFieldName_${facilityId}`);
  const notesInput = document.getElementById(`editFieldNotes_${facilityId}`);
  const msgEl      = document.getElementById(`editFieldMsg_${facilityId}`);

  const fieldIndex = parseInt(indexInput?.value, 10);
  const name       = nameInput?.value.trim();
  const notes      = notesInput?.value.trim() || "";

  if (!name) {
    if (msgEl) { msgEl.textContent = "Field name is required."; msgEl.className = "signup-message error"; }
    return;
  }

  try {
    const ref  = doc(db, "facilities", facilityId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const fields = [...(snap.data().fields || [])];
    fields[fieldIndex] = { name, notes };
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
  // Edit facility button
  const editFacBtn = e.target.closest(".edit-facility-btn");
  if (editFacBtn) {
    const id   = editFacBtn.dataset.facilityId;
    const form = document.getElementById(`editFacilityForm_${id}`);
    if (form) form.style.display = form.style.display === "none" ? "" : "none";
    return;
  }

  // Cancel facility edit
  const cancelFacEdit = e.target.closest(".cancel-facility-edit-btn");
  if (cancelFacEdit) {
    const id   = cancelFacEdit.dataset.facilityId;
    const form = document.getElementById(`editFacilityForm_${id}`);
    if (form) form.style.display = "none";
    return;
  }

  // Save facility edit
  const saveFacEdit = e.target.closest(".save-facility-edit-btn");
  if (saveFacEdit) { saveFacilityEdit(saveFacEdit.dataset.facilityId); return; }

  // Delete facility
  const delFacBtn = e.target.closest(".delete-facility-btn");
  if (delFacBtn) { deleteFacility(delFacBtn.dataset.facilityId); return; }

  // Show add-field form
  const showAddFieldBtn = e.target.closest(".show-add-field-btn");
  if (showAddFieldBtn) {
    const id      = showAddFieldBtn.dataset.facilityId;
    const addForm = document.getElementById(`addFieldForm_${id}`);
    if (addForm) addForm.style.display = addForm.style.display === "none" ? "" : "none";
    // Hide edit-field form if open
    const editForm = document.getElementById(`editFieldForm_${id}`);
    if (editForm) editForm.style.display = "none";
    return;
  }

  // Cancel add field
  const cancelAddField = e.target.closest(".cancel-add-field-btn");
  if (cancelAddField) {
    const id = cancelAddField.dataset.facilityId;
    const form = document.getElementById(`addFieldForm_${id}`);
    if (form) form.style.display = "none";
    return;
  }

  // Save add field
  const saveAddField = e.target.closest(".save-add-field-btn");
  if (saveAddField) { addField(saveAddField.dataset.facilityId); return; }

  // Edit field button
  const editFieldBtn = e.target.closest(".edit-field-btn");
  if (editFieldBtn) {
    const id    = editFieldBtn.dataset.facilityId;
    const idx   = parseInt(editFieldBtn.dataset.fieldIndex, 10);
    // Read current values from rendered DOM
    const li    = editFieldBtn.closest("li");
    const name  = li?.querySelector("strong")?.textContent || "";
    const notes = li?.querySelector("span > span")?.textContent?.replace(/^ — /, "") || "";
    openEditFieldForm(id, idx, name, notes);
    return;
  }

  // Cancel edit field
  const cancelEditField = e.target.closest(".cancel-edit-field-btn");
  if (cancelEditField) {
    const id   = cancelEditField.dataset.facilityId;
    const form = document.getElementById(`editFieldForm_${id}`);
    if (form) form.style.display = "none";
    return;
  }

  // Save edit field
  const saveEditFieldBtn = e.target.closest(".save-edit-field-btn");
  if (saveEditFieldBtn) { saveEditField(saveEditFieldBtn.dataset.facilityId); return; }

  // Delete field
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
