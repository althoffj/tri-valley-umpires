// admin-incidents.js — view all incident reports
import { db } from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import { esc, fmtDate, setMsg } from "./utils.js";

import {
  collection,
  getDocs,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

async function loadIncidents() {
  const listEl = document.getElementById("incidentList");
  const noteEl = document.getElementById("incidentNote");
  if (!listEl) return;

  try {
    const snap = await getDocs(
      query(collection(db, "incidentReports"), orderBy("submittedAt", "desc"))
    );

    if (snap.empty) {
      noteEl.textContent = "No incident reports submitted yet.";
      listEl.innerHTML = "";
      return;
    }

    noteEl.textContent = `${snap.size} report${snap.size === 1 ? "" : "s"} on file.`;

    listEl.innerHTML = snap.docs.map(d => {
      const r = d.data();
      const date = r.submittedAt?.toDate
        ? r.submittedAt.toDate().toLocaleDateString("en-US", {
            month: "short", day: "numeric", year: "numeric",
            hour: "numeric", minute: "2-digit"
          })
        : "—";
      const gameLabel = [
        r.gameDate ? fmtDate(r.gameDate) : "",
        r.gameCity,
        r.gameDivision
      ].filter(Boolean).join(" · ");

      // Build structured detail lines based on incident type
      const structuredLines = [];
      if (r.ejection) {
        const ej = r.ejection;
        if (ej.role)   structuredLines.push(`Ejected: ${esc(ej.role)}${ej.name ? " — " + esc(ej.name) : ""}${ej.team ? " (" + esc(ej.team) + ")" : ""}`);
        if (ej.reason) structuredLines.push(`Reason: ${esc(ej.reason)}`);
      }
      if (r.injury) {
        const inj = r.injury;
        if (inj.party)       structuredLines.push(`Injured: ${esc(inj.party)}${inj.name ? " — " + esc(inj.name) : ""}${inj.team ? " (" + esc(inj.team) + ")" : ""}`);
        if (inj.description) structuredLines.push(`Injury: ${esc(inj.description)}`);
        structuredLines.push(`EMS called: ${esc(inj.emsCalled || "No")}`);
      }
      if (r.unsafeConditions) {
        const uc = r.unsafeConditions;
        if (uc.conditionType) structuredLines.push(`Condition: ${esc(uc.conditionType)}`);
        if (uc.gameStatus)    structuredLines.push(`Game status: ${esc(uc.gameStatus)}`);
      }

      const typeColor = r.incidentType === "Ejection"          ? "#ff9999"
                      : r.incidentType === "Injury"            ? "#ffcc80"
                      : r.incidentType === "Unsafe Conditions" ? "#ffe066"
                      : "#f7c87e";

      return `
        <div class="document-note" style="border-left-color:${typeColor};margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
            <strong style="color:${typeColor}">${esc(r.incidentType ?? "Incident")}</strong>
            <span style="color:var(--light-text);font-size:0.85rem">${esc(date)}</span>
          </div>
          <p style="margin:0 0 4px"><span style="color:var(--light-text)">Reported by:</span> ${esc(r.reporterName ?? "")}</p>
          ${gameLabel ? `<p style="margin:0 0 4px"><span style="color:var(--light-text)">Game:</span> ${esc(gameLabel)}</p>` : ""}
          ${structuredLines.map(l => `<p style="margin:0 0 3px;font-size:0.92rem">${l}</p>`).join("")}
          ${r.involvedParties ? `<p style="margin:0 0 4px"><span style="color:var(--light-text)">Involved:</span> ${esc(r.involvedParties)}</p>` : ""}
          <p style="margin:8px 0 0;white-space:pre-wrap">${esc(r.description ?? "")}</p>
          ${Array.isArray(r.photoUrls) && r.photoUrls.length > 0
            ? `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
                ${r.photoUrls.map(url => `<a href="${esc(url)}" target="_blank" rel="noopener">
                  <img src="${esc(url)}" alt="Incident photo"
                    style="width:100px;height:100px;object-fit:cover;border-radius:6px;border:1px solid #555;cursor:pointer" />
                </a>`).join("")}
               </div>`
            : ""}
        </div>`;
    }).join("");
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<p style="color:#ffb4b4">Error loading incident reports.</p>';
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display = "none";
  loadIncidents();
});
