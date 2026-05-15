// org.js — Organization settings: fetch once, patch data-org-* attributes site-wide
import { db } from "./firebase.js";
import {
  getDoc,
  doc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Defaults ──────────────────────────────────────────────────────────────────

export const ORG_DEFAULTS = {
  // Identity
  orgName:          "Tri-Valley Baseball Umpires",
  assocName:        "Tri-Valley Baseball Association",
  assocUrl:         "https://www.trivalleyball.com",
  homeHeading:      "Welcome Umpires!",

  // Coordinator
  coordinatorName:  "Jeff Althoff",
  coordinatorPhone: "605-380-0229",
  coordinatorEmail: "althoff.jeff@gmail.com",
  slackInviteUrl:   "https://join.slack.com/t/trivalleybase-tfa3350/shared_invite/zt-3ww1egxv7-rS61yDq0LX_Jfhyr5TrlUA",

  // Divisions
  activeDivisions:  ["8U", "10U", "12U", "14U", "HS JV", "HS Varsity"],

  // Branding
  accentColor:      "#601929",

  // Season
  seasonStart:      "",   // "YYYY-MM-DD" — empty = Jan 1 of current year
  seasonEnd:        "",   // "YYYY-MM-DD" — empty = Dec 31 of current year

  // Registration
  registrationOpen: true,
  registrationClosedMessage: "Umpire registration is currently closed for the season. Please check back later.",
  registrationDisclaimer:    "Before submitting this form, review the official expectations PDF. The PDF is the source of truth for the rules and expectations you are acknowledging.",

  // Weather (lat/lon used as fallback for unknown cities)
  weatherLat: 43.68,
  weatherLon: -96.96,

  // Timezone (IANA, e.g. "America/Chicago")
  timezone: "America/Chicago",
};

// ── Module state ──────────────────────────────────────────────────────────────

let _settings = null;
let _promise  = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch org settings (cached after first call).
 * Side-effect: patches data-org-* elements in the DOM.
 */
export function getOrgSettings() {
  if (_promise) return _promise;
  _promise = getDoc(doc(db, "config", "orgSettings"))
    .then(snap => {
      _settings = snap.exists()
        ? { ...ORG_DEFAULTS, ...snap.data() }
        : { ...ORG_DEFAULTS };
      // Ensure activeDivisions is always an array
      if (!Array.isArray(_settings.activeDivisions)) {
        _settings.activeDivisions = ORG_DEFAULTS.activeDivisions;
      }
    })
    .catch(() => {
      _settings = { ...ORG_DEFAULTS };
    })
    .then(() => {
      _applyToDOM();
      return _settings;
    });
  return _promise;
}

/** Synchronous accessor — safe to call before resolution (returns default). */
export function orgSetting(key) {
  return _settings?.[key] ?? ORG_DEFAULTS[key] ?? "";
}

/**
 * Returns the active season date range.
 * Falls back to Jan 1 – Dec 31 of the current year if not configured.
 */
export function getSeasonRange() {
  const s = _settings ?? ORG_DEFAULTS;
  const y = new Date().getFullYear();
  return {
    from: s.seasonStart || `${y}-01-01`,
    to:   s.seasonEnd   || `${y}-12-31`,
  };
}

/** Returns the configured IANA timezone string. */
export function getTimezone() {
  return (_settings ?? ORG_DEFAULTS).timezone || "America/Chicago";
}

/**
 * Returns today's date as a YYYY-MM-DD string in the org's configured timezone.
 * Falls back to local date if Intl is unavailable.
 */
export function todayInTimezone() {
  try {
    const tz = getTimezone();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const p = {};
    parts.forEach(({ type, value }) => { p[type] = value; });
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
}

// ── Color helpers ─────────────────────────────────────────────────────────────

function darkenHex(hex, factor) {
  const h = hex.replace(/^#/, "");
  if (h.length !== 6) return hex;
  const r = Math.max(0, Math.floor(parseInt(h.slice(0, 2), 16) * (1 - factor)));
  const g = Math.max(0, Math.floor(parseInt(h.slice(2, 4), 16) * (1 - factor)));
  const b = Math.max(0, Math.floor(parseInt(h.slice(4, 6), 16) * (1 - factor)));
  return `#${[r, g, b].map(x => x.toString(16).padStart(2, "0")).join("")}`;
}

// ── DOM patcher ───────────────────────────────────────────────────────────────

function _applyToDOM() {
  const s = _settings;
  if (!s) return;

  // ── Text content ─────────────────────────────────────────────────────────
  document.querySelectorAll("[data-org-text]").forEach(el => {
    const val = s[el.dataset.orgText];
    if (val !== undefined) el.textContent = val;
  });

  // ── Href updates ─────────────────────────────────────────────────────────
  document.querySelectorAll("[data-org-href]").forEach(el => {
    const key = el.dataset.orgHref;
    const val = s[key];
    if (val === undefined) return;
    if (key === "coordinatorEmail") {
      el.href = `mailto:${val}`;
    } else if (key === "coordinatorPhone") {
      el.href = `tel:${val.replace(/\D/g, "")}`;
    } else {
      el.href = val;
    }
  });

  // ── Division selects — repopulate options ─────────────────────────────────
  document.querySelectorAll("[data-org-divisions]").forEach(sel => {
    const placeholder = sel.querySelector('option[value=""]');
    const current     = sel.value;
    sel.innerHTML = "";
    if (placeholder) sel.appendChild(placeholder.cloneNode(true));
    (s.activeDivisions || []).forEach(div => {
      const opt = document.createElement("option");
      opt.value = opt.textContent = div;
      sel.appendChild(opt);
    });
    // Restore selected value if still valid
    if (current) sel.value = current;
  });

  // ── Brand color ───────────────────────────────────────────────────────────
  if (s.accentColor) {
    document.documentElement.style.setProperty("--accent",       s.accentColor);
    document.documentElement.style.setProperty("--accent-hover", darkenHex(s.accentColor, 0.2));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = s.accentColor;
  }

  // ── Page title ────────────────────────────────────────────────────────────
  document.title = document.title
    .replace(/Tri-Valley Baseball Umpires/g, s.orgName)
    .replace(/Tri-Valley Baseball/g,         s.assocName)
    .replace(/Tri-Valley/g,                  s.assocName);
}

// Auto-run on import
getOrgSettings();
