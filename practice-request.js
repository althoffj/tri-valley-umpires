// practice-request.js — public coach practice request form
import { db } from "./firebase.js";
import { collection, addDoc, getDocs, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { esc } from "./utils.js";

// ── Dynamic facility loading ───────────────────────────────────────────────────

async function loadFieldOptions() {
  const sel = document.getElementById("field");
  if (!sel) return;
  try {
    const snap = await getDocs(query(collection(db, "facilities"), orderBy("name")));
    if (snap.empty) return; // keep the hardcoded fallback options
    // Replace options with dynamically loaded facilities + their sub-fields
    sel.innerHTML = `<option value="">-- Select a field --</option>`;
    snap.forEach(d => {
      const fac = d.data();
      const fields = Array.isArray(fac.fields) ? fac.fields.filter(f => f.name) : [];
      if (fields.length > 1) {
        // Multiple fields at this facility — add an optgroup
        const grp = document.createElement("optgroup");
        grp.label = fac.name || d.id;
        fields.forEach(f => {
          const opt = document.createElement("option");
          opt.value       = `${fac.name} — ${f.name}`;
          opt.textContent = `${fac.name} — ${f.name}`;
          grp.appendChild(opt);
        });
        sel.appendChild(grp);
      } else if (fields.length === 1) {
        const opt = document.createElement("option");
        opt.value       = `${fac.name} — ${fields[0].name}`;
        opt.textContent = `${fac.name} — ${fields[0].name}`;
        sel.appendChild(opt);
      } else {
        // Facility with no sub-fields
        const opt = document.createElement("option");
        opt.value       = fac.name || d.id;
        opt.textContent = fac.name || d.id;
        sel.appendChild(opt);
      }
    });
    const other = document.createElement("option");
    other.value       = "Other";
    other.textContent = "Other (describe in notes)";
    sel.appendChild(other);
  } catch (err) {
    console.warn("practice-request: failed to load facilities", err);
    // Keep whatever options are already in the select
  }
}

loadFieldOptions();


// ── Recurrence toggle ─────────────────────────────────────────────────────────

document.querySelectorAll("input[name='recurrence']").forEach(radio => {
  radio.addEventListener("change", () => {
    const weekly = radio.value === "weekly";
    document.getElementById("onceDateSection").style.display     = weekly ? "none" : "";
    document.getElementById("recurringSection").style.display    = weekly ? "" : "none";
    document.getElementById("onceDate").required                 = !weekly;
    document.getElementById("recurStart").required               = weekly;
    document.getElementById("recurEnd").required                 = weekly;
  });
});

// ── Form submit ───────────────────────────────────────────────────────────────

document.getElementById("practiceReqForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = document.getElementById("submitBtn");
  const msg = document.getElementById("submitMsg");
  btn.disabled    = true;
  msg.textContent = "Submitting…";
  msg.className   = "signup-message info";

  const recType = document.querySelector("input[name='recurrence']:checked").value;
  const dows    = recType === "weekly"
    ? [...document.querySelectorAll("input[name='dow']:checked")].map(c => parseInt(c.value))
    : [];

  // Validate weekly: must have at least one day selected
  if (recType === "weekly" && dows.length === 0) {
    msg.textContent = "Please select at least one day of the week for the recurring schedule.";
    msg.className   = "signup-message error";
    btn.disabled    = false;
    return;
  }

  // Validate times
  const startTime = document.getElementById("startTime").value;
  const endTime   = document.getElementById("endTime").value;
  if (startTime && endTime && endTime <= startTime) {
    msg.textContent = "End time must be after start time.";
    msg.className   = "signup-message error";
    btn.disabled    = false;
    return;
  }

  const date = recType === "once" ? document.getElementById("onceDate").value : document.getElementById("recurStart").value;

  const payload = {
    coachName:  document.getElementById("coachName").value.trim(),
    teamName:   document.getElementById("teamName").value.trim(),
    coachEmail: document.getElementById("coachEmail").value.trim(),
    coachPhone: document.getElementById("coachPhone").value.trim(),
    field:      document.getElementById("field").value,
    startTime,
    endTime,
    date,
    recurrence: recType === "weekly" ? {
      type:      "weekly",
      daysOfWeek: dows,
      startDate: document.getElementById("recurStart").value,
      endDate:   document.getElementById("recurEnd").value,
    } : { type: "once" },
    notes:      document.getElementById("reqNotes").value.trim(),
    status:     "pending",
    submittedAt: new Date().toISOString(),
  };

  try {
    await addDoc(collection(db, "practiceRequests"), payload);
    // Show success state
    document.getElementById("practiceReqForm").style.display = "none";
    document.getElementById("successMsg").style.display      = "";
    msg.textContent = "";
  } catch (err) {
    msg.textContent = "Submission failed: " + err.message + ". Please try again or contact the administrator.";
    msg.className   = "signup-message error";
    btn.disabled    = false;
  }
});

// ── Submit another ────────────────────────────────────────────────────────────

document.getElementById("submitAnotherBtn").addEventListener("click", () => {
  document.getElementById("successMsg").style.display = "none";
  document.getElementById("practiceReqForm").style.display = "";
  document.getElementById("practiceReqForm").reset();
  document.getElementById("onceDateSection").style.display  = "";
  document.getElementById("recurringSection").style.display = "none";
});
