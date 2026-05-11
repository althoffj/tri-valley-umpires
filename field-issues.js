// field-issues.js — Submit field issue reports; view own submissions
import { db } from "./firebase.js";
import { authReadyPromise, isApproved, isAdmin, getCurrentUser } from "./auth.js";
import {
  collection,
  getDocs,
  addDoc,
  query,
  where,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function setMsg(id, text, type = "info") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = `signup-message ${type}`;
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function severityBadge(s) {
  const color = s === "High" ? "#c0392b" : s === "Medium" ? "#b8860b" : "#2a6a2a";
  const bg    = s === "High" ? "#3a0a0a" : s === "Medium" ? "#2a2000" : "#0a2a0a";
  return `<span style="background:${bg};color:${s === "High" ? "#f88" : s === "Medium" ? "#f5c842" : "#8fc"};border-radius:10px;padding:1px 8px;font-size:0.75rem;border:1px solid ${color}">${esc(s)}</span>`;
}

function statusBadge(s) {
  const map = {
    "Open":        ["#3a0808","#f88","#c0392b"],
    "In Progress": ["#2a2000","#f5c842","#b8860b"],
    "Resolved":    ["#0a2a0a","#8fc","#2a6a2a"],
  };
  const [bg, color, border] = map[s] || ["#222","#aaa","#444"];
  return `<span style="background:${bg};color:${color};border:1px solid ${border};border-radius:10px;padding:1px 8px;font-size:0.75rem">${esc(s)}</span>`;
}

// ── Facilities load + field cascade ──────────────────────────────────────────

let facilitiesData = [];

async function loadFacilities() {
  try {
    const snap = await getDocs(collection(db, "facilities"));
    facilitiesData = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const facSel = document.getElementById("issueFacility");
    if (!facSel) return;
    facSel.innerHTML = `<option value="">-- Select facility --</option>` +
      facilitiesData.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("");

    facSel.addEventListener("change", cascadeFields);
  } catch (e) {
    console.error("loadFacilities:", e);
  }
}

function cascadeFields() {
  const facId   = document.getElementById("issueFacility")?.value;
  const fieldSel = document.getElementById("issueFieldSelect");
  if (!fieldSel) return;

  const fac    = facilitiesData.find(f => f.id === facId);
  const fields = (fac?.fields || []).filter(f => f.name);

  fieldSel.innerHTML = `<option value="">-- General / Whole Complex --</option>` +
    fields.map(f => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join("");
}

// ── Submit form ───────────────────────────────────────────────────────────────

document.getElementById("fieldIssueForm").addEventListener("submit", async function(e) {
  e.preventDefault();

  const facilityId   = document.getElementById("issueFacility").value;
  const fieldName    = document.getElementById("issueFieldSelect").value;
  const severity     = document.getElementById("issueSeverity").value;
  const category     = document.getElementById("issueCategory").value;
  const title        = document.getElementById("issueTitle").value.trim();
  const description  = document.getElementById("issueDescription").value.trim();

  // Validate
  let valid = true;
  const err = (id, msg) => { document.getElementById(id).textContent = msg; valid = false; };
  const clr = (id)       => { document.getElementById(id).textContent = ""; };

  facilityId ? clr("issueFacilityError") : err("issueFacilityError", "Select a facility.");
  severity   ? clr("issueSeverityError")  : err("issueSeverityError",  "Select a severity level.");
  title      ? clr("issueTitleError")     : err("issueTitleError",     "Enter a short description.");

  // If not signed in, reporter name is required
  const user = getCurrentUser();
  if (!user) {
    const rName = document.getElementById("reporterName")?.value.trim() || "";
    rName ? clr("reporterNameError") : err("reporterNameError", "Please enter your name.");
  }

  if (!valid) return;

  const btn = document.getElementById("submitIssueBtn");
  btn.disabled = true;
  setMsg("issueFormMessage", "Submitting…", "info");

  try {
    const fac          = facilitiesData.find(f => f.id === facilityId);
    const enteredName  = document.getElementById("reporterName")?.value.trim() || "";
    const enteredContact = document.getElementById("reporterContact")?.value.trim() || "";

    await addDoc(collection(db, "fieldIssues"), {
      facilityId,
      facilityName:  fac?.name || "",
      fieldName:     fieldName || "",
      severity,
      category:      category || "",
      title,
      description,
      status:        "Open",
      reportedBy:    user?.uid || null,
      reporterName:  user ? (user.displayName || user.email || "") : enteredName,
      reporterContact: !user ? enteredContact : "",
      submittedAt:   serverTimestamp(),
      adminNotes:    "",
      resolvedAt:    null,
      resolvedBy:    "",
      resolvedByName:"",
    });

    setMsg("issueFormMessage", "Report submitted. Thank you!", "success");
    this.reset();
    document.getElementById("issueFieldSelect").innerHTML =
      `<option value="">-- General / Whole Complex --</option>`;
    if (user) await loadMyIssues();
  } catch (err) {
    setMsg("issueFormMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── My issues list ────────────────────────────────────────────────────────────

async function loadMyIssues() {
  const listEl = document.getElementById("myIssuesList");
  if (!listEl) return;

  try {
    const user = getCurrentUser();
    if (!user) return;

    const q    = query(
      collection(db, "fieldIssues"),
      where("reportedBy", "==", user.uid),
      orderBy("submittedAt", "desc")
    );
    const snap = await getDocs(q);

    if (snap.empty) {
      listEl.innerHTML = `<p style="color:var(--light-text)">You have not submitted any field issue reports yet.</p>`;
      return;
    }

    listEl.innerHTML = `<div class="schedule-section"><table>
      <thead><tr>
        <th>Date</th><th>Facility / Field</th><th>Issue</th><th>Severity</th><th>Status</th>
      </tr></thead>
      <tbody>
        ${snap.docs.map(d => {
          const r = d.data();
          const loc = r.fieldName ? `${esc(r.facilityName)} — ${esc(r.fieldName)}` : esc(r.facilityName);
          const adminNote = r.adminNotes
            ? `<div style="font-size:0.8rem;color:#aaa;margin-top:4px;font-style:italic">Admin: ${esc(r.adminNotes)}</div>` : "";
          return `<tr>
            <td style="white-space:nowrap">${fmtDate(r.submittedAt)}</td>
            <td>${loc}</td>
            <td>
              <div>${esc(r.title)}</div>
              ${r.category ? `<div style="font-size:0.8rem;color:var(--light-text)">${esc(r.category)}</div>` : ""}
              ${adminNote}
            </td>
            <td>${severityBadge(r.severity)}</td>
            <td>${statusBadge(r.status)}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table></div>`;
  } catch (err) {
    listEl.innerHTML = `<p style="color:#ffb4b4">Error loading issues: ${esc(err.message)}</p>`;
    console.error(err);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  const user = getCurrentUser();

  // Show reporter name fields for non-logged-in visitors
  const reporterSection = document.getElementById("reporterSection");
  if (!user && reporterSection) reporterSection.style.display = "";

  // Always load facilities (form is public)
  loadFacilities();

  // My Issues section only visible when signed in
  const mySection = document.getElementById("myIssuesSection");
  if (user && mySection) {
    mySection.style.display = "";
    loadMyIssues();
  }
});
