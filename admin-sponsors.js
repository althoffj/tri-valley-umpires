// admin-sponsors.js — Sponsor management
import { db, storage }           from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import { esc, setMsg, showConfirm }  from "./utils.js";

import {
  collection, getDocs, getDoc, addDoc, setDoc, deleteDoc,
  doc, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

// ── State ─────────────────────────────────────────────────────────────────────

let sponsors = [];   // loaded from "sponsors" collection
let teams    = [];   // loaded from config/teamCalendars for assignment UI

// Pending logo state while editing
let pendingLogoFile     = null;  // File object to upload on save
let pendingLogoRemove   = false; // true if existing logo should be removed
let currentLogoUrl      = "";    // existing logo download URL for the sponsor being edited
let currentLogoPath     = "";    // existing logo storage path (e.g. "sponsor-logos/docId.png")

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadAll() {
  const [sponsorSnap, teamSnap] = await Promise.all([
    getDocs(query(collection(db, "sponsors"), orderBy("name"))),
    getDoc(doc(db, "config/teamCalendars")).catch(() => null),
  ]);
  sponsors = sponsorSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  teams    = teamSnap?.exists() ? (teamSnap.data().teams || []) : [];
  // Ensure every team has a stable id (may have been added before sponsor feature)
  teams.forEach(t => { if (!t.id) t.id = `t_${t.name.replace(/\W+/g,"_").toLowerCase()}`; });
  renderSponsorList();
}

// ── Render list ───────────────────────────────────────────────────────────────

function totalAmount(sponsor) {
  const fromTeams = (sponsor.teamAssignments || [])
    .reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
  return fromTeams || parseFloat(sponsor.totalAmount) || 0;
}

function renderSponsorList() {
  const el = document.getElementById("sponsorList");
  if (!el) return;
  if (!sponsors.length) {
    el.innerHTML = `<p style="color:var(--light-text)">No sponsors yet. Click <strong>+ Add Sponsor</strong> to get started.</p>`;
    return;
  }
  el.innerHTML = sponsors.map(sp => {
    const logoEl = sp.logoUrl
      ? `<img class="sponsor-logo-thumb" src="${esc(sp.logoUrl)}" alt="${esc(sp.name)} logo" />`
      : `<div class="sponsor-logo-placeholder">🏢</div>`;

    const total = totalAmount(sp);
    const teamTags = (sp.teamAssignments || []).map(a =>
      `<span class="sponsor-tag team">${esc(a.teamName)}</span>`
    ).join("");
    const inactiveTag = sp.active === false
      ? `<span class="sponsor-tag inactive">Inactive</span>` : "";
    const meta = [
      sp.city ? esc(sp.city) + (sp.state ? ", " + esc(sp.state) : "") : "",
      sp.contactName ? esc(sp.contactName) : "",
      sp.contactEmail ? `<a href="mailto:${esc(sp.contactEmail)}" style="color:#8ab4f8">${esc(sp.contactEmail)}</a>` : "",
    ].filter(Boolean).join(" &nbsp;·&nbsp; ");

    return `<div class="sponsor-card" id="spCard_${esc(sp.id)}">
      ${logoEl}
      <div class="sponsor-card-body">
        <div class="sponsor-card-name">${esc(sp.name)}
          ${total > 0 ? `<span style="font-size:0.85rem;font-weight:normal;color:#86efac;margin-left:8px">$${total.toLocaleString()}</span>` : ""}
        </div>
        ${meta ? `<div class="sponsor-card-meta">${meta}</div>` : ""}
        <div class="sponsor-card-tags">${inactiveTag}${teamTags}</div>
      </div>
      <div style="flex-shrink:0;display:flex;flex-direction:column;gap:6px;align-items:flex-end">
        <button class="btn print-btn sp-edit-btn" data-id="${esc(sp.id)}"
          style="font-size:0.8rem;padding:5px 12px">Edit</button>
      </div>
    </div>`;
  }).join("");

  el.querySelectorAll(".sp-edit-btn").forEach(btn =>
    btn.addEventListener("click", () => openEdit(btn.dataset.id))
  );
}

// ── Edit form ─────────────────────────────────────────────────────────────────

function openEdit(id) {
  const sp = id ? sponsors.find(s => s.id === id) : null;

  document.getElementById("sponsorEditTitle").textContent = sp ? "Edit Sponsor" : "Add Sponsor";
  document.getElementById("sponsorEditId").value   = sp?.id    || "";
  document.getElementById("spName").value          = sp?.name  || "";
  document.getElementById("spActive").checked      = sp?.active !== false;
  document.getElementById("spWebsite").value       = sp?.website     || "";
  document.getElementById("spPhone").value         = sp?.phone       || "";
  document.getElementById("spAddress").value       = sp?.address     || "";
  document.getElementById("spCity").value          = sp?.city        || "";
  document.getElementById("spState").value         = sp?.state       || "";
  document.getElementById("spZip").value           = sp?.zip         || "";
  document.getElementById("spContactName").value   = sp?.contactName  || "";
  document.getElementById("spContactTitle").value  = sp?.contactTitle || "";
  document.getElementById("spContactPhone").value  = sp?.contactPhone || "";
  document.getElementById("spContactEmail").value  = sp?.contactEmail || "";
  document.getElementById("spNotes").value         = sp?.notes       || "";
  document.getElementById("sponsorDeleteBtn").style.display = sp ? "" : "none";
  setMsg("sponsorEditMsg", "", "");

  // Logo state
  pendingLogoFile   = null;
  pendingLogoRemove = false;
  currentLogoUrl    = sp?.logoUrl  || "";
  currentLogoPath   = sp?.logoPath || "";
  document.getElementById("spLogoFile").value = "";
  setMsg("logoUploadMsg", "", "");
  updateLogoPreview(currentLogoUrl);

  // Team assignments
  buildTeamAssignRows(sp?.teamAssignments || []);
  populateTeamSelector(sp?.teamAssignments || []);

  // History
  buildHistoryRows(sp?.history || []);

  const panel = document.getElementById("sponsorEditPanel");
  panel.style.display = "";
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeSponsorEdit() {
  document.getElementById("sponsorEditPanel").style.display = "none";
  setMsg("sponsorEditMsg", "", "");
}

// ── Logo ──────────────────────────────────────────────────────────────────────

function updateLogoPreview(url) {
  const wrap = document.getElementById("logoPreviewWrap");
  const img  = document.getElementById("logoPreviewImg");
  if (url) {
    img.src          = url;
    wrap.style.display = "";
  } else {
    wrap.style.display = "none";
  }
}

document.getElementById("spLogoFile").addEventListener("change", function() {
  const file = this.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    setMsg("logoUploadMsg", "File too large — max 2 MB.", "error");
    this.value = "";
    return;
  }
  pendingLogoFile   = file;
  pendingLogoRemove = false;
  setMsg("logoUploadMsg", `${file.name} selected — will upload on save.`, "info");
  // Show local preview immediately
  const reader = new FileReader();
  reader.onload = e => updateLogoPreview(e.target.result);
  reader.readAsDataURL(file);
});

document.getElementById("removeLogoBtn").addEventListener("click", () => {
  pendingLogoFile   = null;
  pendingLogoRemove = true;
  currentLogoUrl    = "";
  document.getElementById("spLogoFile").value = "";
  setMsg("logoUploadMsg", "Logo will be removed on save.", "info");
  updateLogoPreview("");
});

// ── Team assignments ──────────────────────────────────────────────────────────

function populateTeamSelector(assigned) {
  const sel = document.getElementById("spAddTeamSel");
  if (!sel) return;
  const assignedIds = new Set(assigned.map(a => a.teamId));
  sel.innerHTML = `<option value="">— Add a team —</option>` +
    teams
      .filter(t => !assignedIds.has(t.id))
      .map(t => `<option value="${esc(t.id)}">${esc(t.name)}${t.division ? " (" + esc(t.division) + ")" : ""}</option>`)
      .join("");
}

function getTeamAssignRows() {
  return [...document.querySelectorAll("#spTeamAssignWrap .sponsor-team-row")]
    .map(row => ({
      teamId:   row.dataset.teamId   || "",
      teamName: row.dataset.teamName || "",
      amount:   parseFloat(row.querySelector(".sp-team-amount")?.value || "0") || 0,
    }))
    .filter(a => a.teamId);
}

function buildTeamAssignRows(assignments) {
  const wrap = document.getElementById("spTeamAssignWrap");
  const hint = document.getElementById("spTeamAssignHint");
  if (!wrap) return;
  wrap.innerHTML = "";
  assignments.forEach(a => addTeamAssignRow(a));
  hint.style.display = assignments.length ? "none" : "";
}

function addTeamAssignRow(assignment) {
  const wrap = document.getElementById("spTeamAssignWrap");
  const hint = document.getElementById("spTeamAssignHint");
  hint.style.display = "none";
  const row = document.createElement("div");
  row.className = "sponsor-team-row";
  row.dataset.teamId   = assignment.teamId;
  row.dataset.teamName = assignment.teamName;
  row.innerHTML = `
    <span style="flex:1;font-weight:500">${esc(assignment.teamName)}</span>
    <label style="display:flex;align-items:center;gap:6px;font-weight:normal;font-size:0.88rem;color:var(--light-text)">
      Amount
      <input class="sp-team-amount" type="number" min="0" step="0.01"
        value="${assignment.amount ?? ""}"
        placeholder="0.00"
        style="width:100px;padding:6px 10px;background:var(--container);color:var(--text);border:1px solid #555;border-radius:6px;font-size:0.9rem" />
    </label>
    <button type="button" class="btn print-btn sp-remove-team-btn"
      style="padding:5px 10px;font-size:0.82rem">Remove</button>`;
  row.querySelector(".sp-remove-team-btn").addEventListener("click", () => {
    row.remove();
    populateTeamSelector(getTeamAssignRows());
    if (!wrap.querySelectorAll(".sponsor-team-row").length)
      hint.style.display = "";
  });
  wrap.appendChild(row);
}

document.getElementById("spAddTeamBtn").addEventListener("click", () => {
  const sel = document.getElementById("spAddTeamSel");
  const teamId = sel.value;
  if (!teamId) return;
  const team = teams.find(t => t.id === teamId);
  if (!team) return;
  addTeamAssignRow({ teamId, teamName: team.name, amount: null });
  populateTeamSelector(getTeamAssignRows());
  sel.value = "";
});

// ── History ───────────────────────────────────────────────────────────────────

function buildHistoryRows(history) {
  const wrap = document.getElementById("spHistoryWrap");
  const hint = document.getElementById("spHistoryHint");
  if (!wrap) return;
  wrap.innerHTML = "";
  // Sort descending by year
  [...history].sort((a, b) => b.year - a.year).forEach(h => addHistoryRow(h));
  hint.style.display = history.length ? "none" : "";
}

function addHistoryRow(entry = {}) {
  const wrap = document.getElementById("spHistoryWrap");
  const hint = document.getElementById("spHistoryHint");
  hint.style.display = "none";
  const row = document.createElement("div");
  row.className = "sponsor-history-row";
  const inp = (cls, type, ph, val, width) =>
    `<input class="${cls}" type="${type}" placeholder="${ph}" value="${esc(String(val || ""))}"
      style="${width ? `width:${width};` : "flex:1;"}min-width:80px;padding:7px 10px;
      background:var(--field);color:var(--text);border:1px solid #555;border-radius:6px;font-size:0.88rem" />`;
  row.innerHTML =
    inp("sh-year",   "number", "Year",   entry.year   || new Date().getFullYear(), "90px") +
    inp("sh-amount", "number", "Amount", entry.amount || "", "120px") +
    inp("sh-notes",  "text",   "Notes (optional)", entry.notes || "") +
    `<button type="button" class="btn print-btn sp-remove-history-btn"
       style="flex-shrink:0;padding:7px 10px;font-size:0.85rem">✕</button>`;
  row.querySelector(".sp-remove-history-btn").addEventListener("click", () => {
    row.remove();
    if (!wrap.querySelectorAll(".sponsor-history-row").length)
      hint.style.display = "";
  });
  wrap.appendChild(row);
}

function getHistoryRows() {
  return [...document.querySelectorAll("#spHistoryWrap .sponsor-history-row")]
    .map(row => ({
      year:   parseInt(row.querySelector(".sh-year")?.value   || "0") || 0,
      amount: parseFloat(row.querySelector(".sh-amount")?.value || "0") || 0,
      notes:  row.querySelector(".sh-notes")?.value.trim() || "",
    }))
    .filter(h => h.year > 0);
}

document.getElementById("spAddHistoryBtn").addEventListener("click", () => addHistoryRow());

// ── Save ──────────────────────────────────────────────────────────────────────

document.getElementById("sponsorSaveBtn").addEventListener("click", async () => {
  const name = document.getElementById("spName").value.trim();
  if (!name) {
    setMsg("sponsorEditMsg", "Business name is required.", "error"); return;
  }

  const btn = document.getElementById("sponsorSaveBtn");
  btn.disabled = true;
  setMsg("sponsorEditMsg", "Saving…", "info");

  try {
    const editId       = document.getElementById("sponsorEditId").value;
    const teamAssign   = getTeamAssignRows();
    const history      = getHistoryRows();

    // Determine final logo URL + path
    let logoUrl  = currentLogoUrl;
    let logoPath = currentLogoPath;

    if (pendingLogoFile) {
      // Upload new logo — delete old one first (by path, not URL)
      if (currentLogoPath) {
        try { await deleteObject(ref(storage, currentLogoPath)); } catch { /* ignore */ }
      }
      setMsg("sponsorEditMsg", "Uploading logo…", "info");
      const ext    = pendingLogoFile.name.split(".").pop().toLowerCase();
      const docId  = editId || `sp_${Date.now()}`;
      logoPath     = `sponsor-logos/${docId}.${ext}`;
      const logoRef = ref(storage, logoPath);
      await uploadBytes(logoRef, pendingLogoFile);
      logoUrl = await getDownloadURL(logoRef);
    } else if (pendingLogoRemove && currentLogoPath) {
      // Remove logo — delete by path
      try { await deleteObject(ref(storage, currentLogoPath)); } catch { /* ignore */ }
      logoUrl  = "";
      logoPath = "";
    }

    setMsg("sponsorEditMsg", "Saving…", "info");

    const data = {
      name,
      active:       document.getElementById("spActive").checked,
      website:      document.getElementById("spWebsite").value.trim(),
      phone:        document.getElementById("spPhone").value.trim(),
      address:      document.getElementById("spAddress").value.trim(),
      city:         document.getElementById("spCity").value.trim(),
      state:        document.getElementById("spState").value.trim().toUpperCase(),
      zip:          document.getElementById("spZip").value.trim(),
      contactName:  document.getElementById("spContactName").value.trim(),
      contactTitle: document.getElementById("spContactTitle").value.trim(),
      contactPhone: document.getElementById("spContactPhone").value.trim(),
      contactEmail: document.getElementById("spContactEmail").value.trim(),
      notes:        document.getElementById("spNotes").value.trim(),
      logoUrl,
      logoPath,
      teamAssignments: teamAssign,
      teamIds: teamAssign.map(a => a.teamId),
      history,
      updatedAt: serverTimestamp(),
    };

    if (editId) {
      await setDoc(doc(db, "sponsors", editId), data, { merge: true });
      const idx = sponsors.findIndex(s => s.id === editId);
      if (idx >= 0) sponsors[idx] = { id: editId, ...data };
    } else {
      data.createdAt = serverTimestamp();
      const docRef = await addDoc(collection(db, "sponsors"), data);
      sponsors.push({ id: docRef.id, ...data });
      // Re-sort by name
      sponsors.sort((a, b) => a.name.localeCompare(b.name));
    }

    setMsg("sponsorEditMsg", "✓ Sponsor saved.", "success");
    renderSponsorList();
    setTimeout(closeSponsorEdit, 900);
  } catch (err) {
    setMsg("sponsorEditMsg", "Error: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Delete ────────────────────────────────────────────────────────────────────

document.getElementById("sponsorDeleteBtn").addEventListener("click", async () => {
  const id = document.getElementById("sponsorEditId").value;
  const sp = sponsors.find(s => s.id === id);
  if (!sp || !await showConfirm(`Delete sponsor "${sp.name}"?\n\nThis cannot be undone.`)) return;

  setMsg("sponsorEditMsg", "Deleting…", "info");
  try {
    if (sp.logoPath) {
      try { await deleteObject(ref(storage, sp.logoPath)); } catch { /* ignore */ }
    } else if (sp.logoUrl) {
      // Legacy: sponsors saved before logoPath was stored — fall back to URL
      try { await deleteObject(ref(storage, sp.logoUrl)); } catch { /* ignore */ }
    }
    await deleteDoc(doc(db, "sponsors", id));
    sponsors = sponsors.filter(s => s.id !== id);
    renderSponsorList();
    closeSponsorEdit();
  } catch (err) {
    setMsg("sponsorEditMsg", "Delete failed: " + err.message, "error");
  }
});

// ── Wire buttons ──────────────────────────────────────────────────────────────

document.getElementById("addSponsorBtn").addEventListener("click", () => openEdit(null));
document.getElementById("sponsorCancelBtn").addEventListener("click", closeSponsorEdit);

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(async () => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display     = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display     = "none";
  await loadAll();
});
