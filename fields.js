// fields.js — Dynamic facility/field info loaded from Firestore
import { db } from "./firebase.js";
import { authReadyPromise, isApproved, isAdmin } from "./auth.js";
import {
  collection,
  getDocs,
  doc,
  getDoc,
  orderBy,
  query
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Weather ───────────────────────────────────────────────────────────────────

const CITY_COORDS = {
  "Crooks": { lat: 43.6503, lon: -96.8108 },
  "Colton": { lat: 43.7877, lon: -97.0002 }
};

const WMO_LABELS = {
  0: "Clear", 1: "Mainly Clear", 2: "Partly Cloudy", 3: "Overcast",
  45: "Fog", 48: "Freezing Fog",
  51: "Light Drizzle", 53: "Drizzle", 55: "Heavy Drizzle",
  61: "Light Rain", 63: "Rain", 65: "Heavy Rain",
  71: "Light Snow", 73: "Snow", 75: "Heavy Snow", 77: "Snow Grains",
  80: "Showers", 81: "Showers", 82: "Heavy Showers",
  85: "Snow Showers", 86: "Heavy Snow Showers",
  95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm"
};

const WMO_ICONS = {
  0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️",
  45: "🌫️", 48: "🌫️",
  51: "🌦️", 53: "🌦️", 55: "🌦️",
  61: "🌧️", 63: "🌧️", 65: "🌧️",
  71: "❄️", 73: "❄️", 75: "❄️", 77: "❄️",
  80: "🌦️", 81: "🌦️", 82: "🌦️",
  85: "❄️", 86: "❄️",
  95: "⛈️", 96: "⛈️", 99: "⛈️"
};

async function fetchCurrentWeather(facilityName, address) {
  const text    = `${facilityName} ${address || ""}`.toLowerCase();
  const cityKey = Object.keys(CITY_COORDS).find(c => text.includes(c.toLowerCase()));
  if (!cityKey) return null;

  const { lat, lon } = CITY_COORDS[cityKey];
  try {
    const url  = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code,wind_speed_10m` +
      `&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=America%2FChicago`;
    const res  = await fetch(url);
    const data = await res.json();
    const cur  = data.current;
    if (!cur) return null;
    const code = cur.weather_code ?? 0;
    return {
      temp:  Math.round(cur.temperature_2m ?? 0),
      code,
      wind:  Math.round(cur.wind_speed_10m ?? 0),
      label: WMO_LABELS[code] ?? "Unknown",
      icon:  WMO_ICONS[code]  ?? "🌡️"
    };
  } catch {
    return null;
  }
}

// ── Render helpers ────────────────────────────────────────────────────────────

function row(label, value) {
  if (!value && value !== 0) return "";
  return `<tr><th>${esc(label)}</th><td>${value}</td></tr>`;
}

function badge(label, yes) {
  if (!yes) return "";
  return `<span style="display:inline-block;background:#1a3a1a;color:#8fc;border:1px solid #2a6a2a;border-radius:10px;padding:1px 9px;font-size:0.78rem;margin:2px 3px 2px 0">${esc(label)}</span>`;
}

function issuesBanner(text) {
  if (!text) return "";
  return `<div style="background:#2a2000;border:1px solid #b8860b;border-radius:6px;padding:10px 14px;margin-bottom:12px;color:#f5c842;font-size:0.9rem">
    <strong>⚠ Active Issues:</strong> ${esc(text)}
  </div>`;
}

function renderBasepaths(field) {
  const rows = Array.isArray(field.basepaths) && field.basepaths.length
    ? field.basepaths
    : (field.basepathLength ? [{ label: "", distance: field.basepathLength }] : []);
  if (!rows.length) return "";
  if (rows.length === 1) return row("Base Paths", esc(rows[0].label ? `${rows[0].label}: ${rows[0].distance}` : rows[0].distance));
  const list = rows.map(b => b.label ? `${esc(b.label)}: ${esc(b.distance)}` : esc(b.distance)).join("<br>");
  return row("Base Paths", list);
}

function renderPitching(field) {
  const mounds = Array.isArray(field.pitchingMounds) && field.pitchingMounds.length
    ? field.pitchingMounds
    : (field.pitchingDistance ? [{
        type: field.fixedMound ? "Fixed" : field.portableMound ? "Portable" : field.flatMound ? "Flat" : "",
        distance: field.pitchingDistance,
        label: ""
      }] : []);
  if (!mounds.length) return "";
  if (mounds.length === 1) {
    const m = mounds[0];
    const parts = [m.distance, m.type, m.label].filter(Boolean);
    return row("Pitching", parts.join(" · "));
  }
  const list = mounds.map(m => {
    const parts = [m.distance, m.type, m.label].filter(Boolean);
    return parts.join(" · ");
  }).join("<br>");
  return row("Pitching", list);
}

function renderFences(field) {
  const parts = [];
  if (field.fenceLF)  parts.push(`LF: ${esc(field.fenceLF)}`);
  if (field.fenceCF)  parts.push(`CF: ${esc(field.fenceCF)}`);
  if (field.fenceRF)  parts.push(`RF: ${esc(field.fenceRF)}`);
  if (!parts.length)  return "";
  let val = parts.join(" &nbsp;|&nbsp; ");
  if (field.fenceHeight) val += `<br><span style="font-size:0.85rem;color:#aaa">Height: ${esc(field.fenceHeight)}</span>`;
  if (field.fenceType)   val += `<br><span style="font-size:0.85rem;color:#aaa">Type: ${esc(field.fenceType)}</span>`;
  return row("Fence Distances", val);
}

function renderAmenityBadges(field) {
  const items = [
    badge("Concession Stand", field.concessionStand),
    badge("Restrooms",        field.bathrooms),
    badge("Porta-Potty",      field.portapotty),
    badge("Lights",           field.lights),
    badge("Scoreboard",       field.scoreboard),
    badge("PA System",        field.paSystem),
    badge("Batting Cage",     field.battingCage),
    badge("Warning Track",    field.warningTrack),
    badge("Covered Seating",  field.coveredSeating),
    badge("First Aid",        field.firstAid),
  ].filter(Boolean).join("");
  return items ? `<tr><th>Amenities</th><td>${items}</td></tr>` : "";
}

function renderSurfaces(field) {
  const parts = [];
  if (field.infieldSurface)  parts.push(`Infield: ${esc(field.infieldSurface)}`);
  if (field.outfieldSurface) parts.push(`Outfield: ${esc(field.outfieldSurface)}`);
  return parts.length ? row("Surface", parts.join(" &nbsp;|&nbsp; ")) : "";
}

function renderFieldCard(field, mapsUrl) {
  const dimensions = [
    field.dimensionLF  ? `LF ${esc(field.dimensionLF)}`  : "",
    field.dimensionCF  ? `CF ${esc(field.dimensionCF)}`  : "",
    field.dimensionRF  ? `RF ${esc(field.dimensionRF)}`  : "",
  ].filter(Boolean).join(" / ");

  const dugouts = field.homeDugoutSide
    ? `Home: ${esc(field.homeDugoutSide)} side`
    : "";

  return `
    <div class="schedule-section" style="flex:1;min-width:260px;margin-top:0">
      <h3 style="margin-top:12px;margin-bottom:8px">${esc(field.name)}</h3>
      ${issuesBanner(field.activeIssues)}
      <table>
        <tbody>
          ${row("Division", field.division ? esc(field.division) : "")}
          ${renderBasepaths(field)}
          ${renderPitching(field)}
          ${renderFences(field)}
          ${dimensions ? row("Dimensions", dimensions) : ""}
          ${renderSurfaces(field)}
          ${dugouts ? row("Dugouts", dugouts) : ""}
          ${renderAmenityBadges(field)}
          ${field.equipmentStorage ? row("Equipment", esc(field.equipmentStorage)) : ""}
          ${field.sunNotes        ? row("Sun/Visibility", esc(field.sunNotes))      : ""}
          ${field.groundRules     ? row("Ground Rules", esc(field.groundRules))     : ""}
          ${field.notes           ? row("Notes", esc(field.notes))                  : ""}
        </tbody>
      </table>
      ${mapsUrl ? `<div class="page-actions" style="margin-top:0">
        <a href="${esc(mapsUrl)}" target="_blank" class="btn print-btn">Open in Google Maps</a>
      </div>` : ""}
    </div>`;
}

function renderFacility(facility, weather) {
  const fieldsHtml = (facility.fields || [])
    .filter(f => f.name)
    .map(f => renderFieldCard(f, facility.googleMapsUrl))
    .join("");

  const addressLine = facility.address
    ? `<p><strong>Address:</strong> ${esc(facility.address)}</p>` : "";
  const notesLine = facility.notes
    ? `<p style="margin-bottom:0"><strong>Notes:</strong> ${esc(facility.notes)}</p>` : "";
  const shedCodeHtml = facility.shedCode
    ? `<div style="margin-top:8px;display:inline-flex;align-items:center;gap:8px;background:#1a2a1a;border:1px solid #2a6a2a;border-radius:6px;padding:8px 14px">
         🔑 <strong>Shed Code:</strong> <span style="font-family:monospace;font-size:1.1rem;letter-spacing:0.12em">${esc(facility.shedCode)}</span>
       </div>`
    : "";
  const weatherHtml = weather
    ? `<div style="display:inline-flex;align-items:center;gap:8px;background:#1a1a2a;border:1px solid #3a3a5a;border-radius:6px;padding:8px 14px;margin-top:8px;font-size:0.9rem">
         <span style="font-size:1.3rem">${weather.icon}</span>
         <span><strong>${esc(weather.label)}</strong> · ${weather.temp}°F · Wind ${weather.wind} mph</span>
       </div>`
    : "";

  return `
    <h2 style="margin-top:48px">${esc(facility.name)}</h2>
    ${issuesBanner(facility.activeIssues)}
    ${(addressLine || notesLine || shedCodeHtml || weatherHtml)
      ? `<div class="document-note">${addressLine}${notesLine}${shedCodeHtml ? `<div style="margin-top:${(addressLine || notesLine) ? "8px" : "0"}">${shedCodeHtml}</div>` : ""}${weatherHtml ? `<div style="margin-top:${(addressLine || notesLine || shedCodeHtml) ? "8px" : "0"}">${weatherHtml}</div>` : ""}</div>`
      : ""}
    ${fieldsHtml ? `<div class="form-row" style="gap:24px;flex-wrap:wrap;align-items:stretch">${fieldsHtml}</div>` : ""}`;
}

// ── Load and render ───────────────────────────────────────────────────────────

async function loadFacilities() {
  const container = document.getElementById("facilitiesContent");
  if (!container) return;

  try {
    await authReadyPromise;
    const canSeeCodes = isApproved() || isAdmin();

    const [facSnap, codesSnap] = await Promise.all([
      getDocs(query(collection(db, "facilities"), orderBy("name"))),
      canSeeCodes ? getDocs(collection(db, "facilityCodes")) : Promise.resolve(null)
    ]);

    if (facSnap.empty) {
      container.innerHTML = `<p style="color:var(--light-text)">No facilities have been added yet.</p>`;
      return;
    }

    const shedCodes = {};
    if (codesSnap) codesSnap.docs.forEach(d => { shedCodes[d.id] = d.data().shedCode || ""; });

    const facilities = facSnap.docs.map(d => ({ id: d.id, ...d.data(), shedCode: shedCodes[d.id] || "" }));

    const weatherResults = await Promise.all(
      facilities.map(f => fetchCurrentWeather(f.name, f.address || ""))
    );

    container.innerHTML = facilities
      .map((f, i) => renderFacility(f, weatherResults[i]))
      .join("");
  } catch (e) {
    container.innerHTML = `<p style="color:#ffb4b4">Error loading facilities: ${esc(e.message)}</p>`;
    console.error(e);
  }
}

loadFacilities();
