// request-umpire.js — public coach form to request umpire coverage
import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  addDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

emailjs.init("H9Z9Qz-HB-PehAQjp");

// ── Facilities cascade ────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let facilitiesData = [];

async function loadFacilities() {
  const facSel = document.getElementById("reqFacility");
  if (!facSel) return;
  try {
    const snap = await getDocs(collection(db, "facilities"));
    facilitiesData = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => a.name.localeCompare(b.name));
    facSel.innerHTML = `<option value="">-- Select facility --</option>` +
      facilitiesData.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("") +
      `<option value="__other__">Other / Not listed…</option>`;
  } catch (e) {
    facSel.innerHTML = `<option value="">-- Could not load facilities --</option>`;
    console.error("loadFacilities:", e);
  }
  facSel.addEventListener("change", cascadeFields);
}

function cascadeFields() {
  const facId    = document.getElementById("reqFacility")?.value;
  const fieldSel = document.getElementById("reqFieldSelect");
  const fieldOther = document.getElementById("reqFieldOther");
  if (!fieldSel || !fieldOther) return;

  if (facId === "__other__") {
    fieldSel.style.display = "none";
    fieldOther.style.display = "";
    fieldOther.placeholder = "Facility name / field";
    return;
  }

  const fac    = facilitiesData.find(f => f.id === facId);
  const fields = (fac?.fields || []).filter(f => f.name);

  if (fields.length > 0) {
    fieldSel.innerHTML = `<option value="">-- Any / All fields --</option>` +
      fields.map(f => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join("") +
      `<option value="__other__">Other / Enter manually…</option>`;
    fieldSel.style.display = "";
    fieldOther.style.display = "none";
    fieldOther.value = "";

    fieldSel.onchange = () => {
      if (fieldSel.value === "__other__") {
        fieldOther.style.display = "";
        fieldOther.placeholder = "Field name";
        fieldOther.focus();
      } else {
        fieldOther.style.display = "none";
        fieldOther.value = "";
      }
    };
  } else {
    fieldSel.style.display = "none";
    fieldOther.style.display = "";
    fieldOther.placeholder = "Field name (optional)";
  }
}

function getLocationStrings() {
  const facId  = document.getElementById("reqFacility")?.value;
  const fieldSel = document.getElementById("reqFieldSelect");
  const fieldOther = document.getElementById("reqFieldOther");

  if (facId === "__other__") {
    const text = fieldOther?.value.trim() || "";
    return { facilityId: "", facilityName: text, fieldName: "", location: text };
  }

  const fac = facilitiesData.find(f => f.id === facId);
  const facilityName = fac?.name || "";
  const fieldName = (fieldSel?.style.display !== "none" && fieldSel?.value && fieldSel.value !== "__other__")
    ? fieldSel.value
    : (fieldOther?.value.trim() || "");

  const location = fieldName ? `${facilityName} — ${fieldName}` : facilityName;
  return { facilityId: facId || "", facilityName, fieldName, location };
}

loadFacilities();

function setMsg(text, type = "info") {
  const el = document.getElementById("requestMessage");
  if (!el) return;
  el.textContent = text;
  el.className = `signup-message ${type}`;
}

function fieldError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg;
}

function clearErrors() {
  ["reqDateError","reqTimeError","reqLocationError","reqHomeTeamError","reqAwayTeamError",
   "reqDivisionError","reqPositionsError","coachNameError","coachEmailError","coachPhoneError"
  ].forEach(id => fieldError(id, ""));
}

function fmtTime(t) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${period}`;
}

function fmtDate(dateISO) {
  if (!dateISO) return "—";
  const [y, mo, d] = dateISO.split("-");
  return `${mo}/${d}/${y}`;
}

// Phone formatting
document.getElementById("coachPhone")?.addEventListener("input", function () {
  const digits = this.value.replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) { this.value = digits; return; }
  if (digits.length <= 6) { this.value = `(${digits.slice(0,3)}) ${digits.slice(3)}`; return; }
  this.value = `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
});

// Enable/disable pay inputs when checkboxes change
["needPlate","needField"].forEach(id => {
  document.getElementById(id)?.addEventListener("change", function () {
    const payId = id === "needPlate" ? "payPlate" : "payField";
    const payEl = document.getElementById(payId);
    if (!payEl) return;
    payEl.disabled = !this.checked;
    if (this.checked && !payEl.value) {
      payEl.value = id === "needPlate" ? 40 : 30;
    }
  });
});

document.getElementById("requestForm")?.addEventListener("submit", async function (e) {
  e.preventDefault();
  clearErrors();

  const date     = document.getElementById("reqDate").value;
  const time     = document.getElementById("reqTime").value;
  const { facilityId, facilityName, fieldName, location } = getLocationStrings();
  const homeTeam = document.getElementById("reqHomeTeam").value.trim();
  const awayTeam = document.getElementById("reqAwayTeam").value.trim();
  const division = document.getElementById("reqDivision").value;
  const needPlate = document.getElementById("needPlate").checked;
  const needField = document.getElementById("needField").checked;
  const payPlate  = parseFloat(document.getElementById("payPlate").value) || 40;
  const payField  = parseFloat(document.getElementById("payField").value) || 30;
  const coachName  = document.getElementById("coachName").value.trim();
  const coachEmail = document.getElementById("coachEmail").value.trim();
  const coachPhone = document.getElementById("coachPhone").value.trim();
  const notes      = document.getElementById("reqNotes").value.trim();

  let valid = true;
  if (!date)     { fieldError("reqDateError",     "Please select a date."); valid = false; }
  if (!time)     { fieldError("reqTimeError",     "Please select a time."); valid = false; }
  if (!location) { fieldError("reqLocationError", "Please select a facility."); valid = false; }
  if (!homeTeam) { fieldError("reqHomeTeamError", "Home team is required."); valid = false; }
  if (!awayTeam) { fieldError("reqAwayTeamError", "Visiting team is required."); valid = false; }
  if (!division) { fieldError("reqDivisionError", "Please select a division."); valid = false; }
  if (!needPlate && !needField) { fieldError("reqPositionsError", "Select at least one umpire position."); valid = false; }
  if (!coachName)  { fieldError("coachNameError",  "Coach name is required."); valid = false; }
  if (!coachEmail) { fieldError("coachEmailError", "Coach email is required."); valid = false; }
  if (!coachPhone) { fieldError("coachPhoneError", "Coach phone is required."); valid = false; }
  if (!valid) return;

  const btn = document.getElementById("submitRequestBtn");
  btn.disabled = true;
  setMsg("Submitting request…", "info");

  const positions = [];
  if (needPlate) positions.push({ type: "Plate", pay: payPlate });
  if (needField) positions.push({ type: "Field", pay: payField });

  try {
    await addDoc(collection(db, "umpireRequests"), {
      date, time,
      facilityId, facilityName, fieldName,
      location,   // derived display string for emails and admin view
      homeTeam, awayTeam, division,
      positions,
      coachName, coachEmail, coachPhone, notes,
      status: "pending",
      submittedAt: serverTimestamp()
    });

    // Confirmation email to coach (best-effort)
    try {
      const posStr = positions.map(p => `${p.type} ($${p.pay})`).join(", ");
      await emailjs.send("service_vljauqe", "template_request_confirm", {
        to_name:    coachName,
        to_email:   coachEmail,
        game_date:  fmtDate(date),
        game_time:  fmtTime(time),
        location,
        home_team:  homeTeam,
        away_team:  awayTeam,
        division,
        positions:  posStr
      });
    } catch (_) { /* email failure doesn't block submission */ }

    // Admin notification (best-effort)
    try {
      const posStr = positions.map(p => `${p.type} ($${p.pay})`).join(", ");
      await emailjs.send("service_vljauqe", "template_request_admin", {
        game_date:  fmtDate(date),
        game_time:  fmtTime(time),
        location,
        home_team:  homeTeam,
        away_team:  awayTeam,
        division,
        positions:  posStr,
        coach_name:  coachName,
        coach_email: coachEmail,
        coach_phone: coachPhone,
        notes
      });
    } catch (_) {}

    setMsg("Request submitted! You'll receive a confirmation email. An administrator will follow up to confirm availability.", "success");
    document.getElementById("requestForm").reset();
    // Re-init cascade after reset
    document.getElementById("reqFieldSelect").style.display = "none";
    document.getElementById("reqFieldOther").style.display = "";
    document.getElementById("reqFieldOther").placeholder = "Field name (optional)";
  } catch (err) {
    console.error(err);
    setMsg("Error submitting request. Please try again or contact Jeff Althoff at 605-380-0229.", "error");
    btn.disabled = false;
  }
});
