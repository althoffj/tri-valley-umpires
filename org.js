// org.js — Organization settings: fetch once, patch data-org-text / data-org-href attributes site-wide
import { db } from "./firebase.js";
import {
  getDoc,
  doc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Defaults (what ships out of the box) ─────────────────────────────────────

export const ORG_DEFAULTS = {
  orgName:          "Tri-Valley Baseball Umpires",
  assocName:        "Tri-Valley Baseball Association",
  assocUrl:         "https://www.trivalleyball.com",
  homeHeading:      "Welcome Umpires!",
  coordinatorName:  "Jeff Althoff",
  coordinatorPhone: "605-380-0229",
  coordinatorEmail: "althoff.jeff@gmail.com",
  slackInviteUrl:   "https://join.slack.com/t/trivalleybase-tfa3350/shared_invite/zt-3ww1egxv7-rS61yDq0LX_Jfhyr5TrlUA",
};

// ── Module state ──────────────────────────────────────────────────────────────

let _settings = null;
let _promise  = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch org settings (cached after first call).
 * Resolves to the merged settings object.
 * Side-effect: patches data-org-text / data-org-href elements in the DOM.
 */
export function getOrgSettings() {
  if (_promise) return _promise;
  _promise = getDoc(doc(db, "config", "orgSettings"))
    .then(snap => {
      _settings = snap.exists()
        ? { ...ORG_DEFAULTS, ...snap.data() }
        : { ...ORG_DEFAULTS };
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

/**
 * Synchronous accessor — returns a setting value after getOrgSettings() has resolved,
 * falling back to the default. Safe to call before resolution (returns default).
 */
export function orgSetting(key) {
  return _settings?.[key] ?? ORG_DEFAULTS[key] ?? "";
}

// ── DOM patcher ───────────────────────────────────────────────────────────────

function _applyToDOM() {
  const s = _settings;
  if (!s) return;

  // data-org-text="key"  → element.textContent = settings[key]
  document.querySelectorAll("[data-org-text]").forEach(el => {
    const val = s[el.dataset.orgText];
    if (val !== undefined) el.textContent = val;
  });

  // data-org-href="key"  → element.href = (computed value)
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

  // Update document.title — replace known hardcoded org strings
  document.title = document.title
    .replace(/Tri-Valley Baseball Umpires/g, s.orgName)
    .replace(/Tri-Valley Baseball/g,         s.assocName)
    .replace(/Tri-Valley/g,                  s.assocName);
}

// Auto-run on import so any page that loads org.js gets patched automatically
getOrgSettings();
