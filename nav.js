// nav.js — Dynamic top navigation, auth-aware, single source of truth
import { authReadyPromise, isApproved, isAdmin, isCoach } from "./auth.js";
import { getOrgSettings } from "./org.js";

// Kick off org settings fetch immediately so data-org-* elements are patched ASAP
getOrgSettings();

// ── Current page & section detection ─────────────────────────────────────

const page = window.location.pathname.split("/").pop() || "index.html";

const section = (() => {
  if (["schedule.html", "calendar.html", "availability.html"].includes(page)) return "games";
  if (["fields.html", "facility-schedule.html"].includes(page)) return "fields";
  if (["incident.html", "field-issues.html"].includes(page)) return "reports";
  if (["expectations.html", "principles_of_umpiring.html", "rule_breakdown.html",
       "pregame-meeting.html", "training.html"].includes(page)) return "training";
  if (["coach-portal.html", "coach-callup.html"].includes(page)) return "coach";
  if (["form.html", "coach-form.html"].includes(page)) return "join";
  if (["request-umpire.html", "practice-request.html"].includes(page)) return "request";
  if (page.startsWith("admin")) return "admin";
  return "home";
})();

// ── HTML helpers ──────────────────────────────────────────────────────────

function navLink(href, label) {
  const active = href === page ? ' class="active"' : "";
  return `<a href="${href}"${active}>${label}</a>`;
}

function navTrigger(sec, label, items) {
  const active = section === sec ? " active" : "";
  return `
    <div class="nav-section">
      <button class="nav-trigger${active}" data-section="${sec}"
              aria-haspopup="true" aria-expanded="false">
        ${label}<span class="nav-caret" aria-hidden="true">▾</span>
      </button>
      <div class="nav-dropdown" role="menu">
        ${items}
      </div>
    </div>`;
}

// ── Nav templates ─────────────────────────────────────────────────────────

function trainingDropdown() {
  return navTrigger("training", "Training",
    navLink("training.html",              "Training Overview") +
    navLink("expectations.html",          "Expectations") +
    navLink("principles_of_umpiring.html","Principles") +
    navLink("rule_breakdown.html",        "Rules") +
    navLink("pregame-meeting.html",       "Plate Meeting")
  );
}

function fieldsDropdown() {
  return navTrigger("fields", "Fields",
    navLink("fields.html",            "Field Directory") +
    navLink("facility-schedule.html", "Field Schedule")
  );
}

function reportsDropdown() {
  return navTrigger("reports", "Reports",
    navLink("incident.html",     "Incident Report") +
    navLink("field-issues.html", "Field Issues")
  );
}

// Guest: public visitors, prospective umpires, and coaches without an account
function guestNav() {
  return `
    ${navLink("index.html", "Home")}
    ${trainingDropdown()}
    ${navLink("fields.html", "Fields")}
    ${navTrigger("join", "Join",
      navLink("form.html",        "Become an Umpire") +
      navLink("coach-form.html",  "Register as a Coach")
    )}
    ${navTrigger("request", "Request",
      navLink("request-umpire.html",  "Request an Umpire") +
      navLink("practice-request.html","Request Practice Time")
    )}
  `;
}

function requestDropdown() {
  return navTrigger("request", "Request",
    navLink("request-umpire.html",   "Request an Umpire") +
    navLink("practice-request.html", "Request Practice Time")
  );
}

// Approved umpire: schedule, signups, fields, reporting, training
function umpireNav() {
  return `
    ${navLink("index.html", "Home")}
    ${navTrigger("games", "Games",
      navLink("schedule.html",    "Schedule &amp; Signups") +
      navLink("calendar.html",    "Calendar") +
      navLink("availability.html","My Availability")
    )}
    ${fieldsDropdown()}
    ${reportsDropdown()}
    ${trainingDropdown()}
    ${requestDropdown()}
  `;
}

// Admin: same top nav as umpire — Admin Panel is in the hamburger menu
function adminNav() {
  return umpireNav();
}

// Coach: portal-centric nav with fields access and reporting
function coachNav() {
  return `
    ${navLink("index.html",        "Home")}
    ${navTrigger("coach", "Coach",
      navLink("coach-portal.html", "Coach Portal") +
      navLink("coach-callup.html", "Player Call-Ups")
    )}
    ${fieldsDropdown()}
    ${reportsDropdown()}
    ${trainingDropdown()}
    ${requestDropdown()}
  `;
}

// ── Build & inject ────────────────────────────────────────────────────────

function buildNav() {
  const nav = document.getElementById("mainNav");
  if (!nav) return;

  nav.innerHTML = isAdmin()
    ? adminNav()
    : isCoach()
      ? coachNav()
      : isApproved()
        ? umpireNav()
        : guestNav();

  setupDropdowns(nav);

  // Inject "← Main Site" into admin subnavs so admins can always return home
  if (section === "admin") {
    const subnav = document.querySelector(".admin-subnav");
    if (subnav && !subnav.querySelector(".admin-subnav-back")) {
      const a = document.createElement("a");
      a.href      = "index.html";
      a.className = "admin-subnav-back";
      a.textContent = "← Main Site";
      subnav.appendChild(a);
    }
  }
}

// ── Dropdown interaction ──────────────────────────────────────────────────

let docListenersBound = false;

function setupDropdowns(nav) {
  nav.querySelectorAll(".nav-section").forEach(sec => {
    const trigger  = sec.querySelector(".nav-trigger");
    const dropdown = sec.querySelector(".nav-dropdown");
    if (!trigger || !dropdown) return;

    trigger.addEventListener("click", () => {
      const wasOpen = dropdown.classList.contains("open");
      closeAll(nav);
      if (!wasOpen) {
        dropdown.classList.add("open");
        trigger.setAttribute("aria-expanded", "true");
      }
    });

    trigger.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        trigger.click();
      }
      if (e.key === "Escape") closeAll(nav);
    });
  });

  // Bind document-level listeners only once (survives nav rebuilds)
  if (!docListenersBound) {
    docListenersBound = true;
    document.addEventListener("click", e => {
      const n = document.getElementById("mainNav");
      if (n && !e.target.closest(".nav-section")) closeAll(n);
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        const n = document.getElementById("mainNav");
        if (n) closeAll(n);
      }
    });
  }
}

function closeAll(nav) {
  nav.querySelectorAll(".nav-dropdown.open").forEach(d => d.classList.remove("open"));
  nav.querySelectorAll(".nav-trigger[aria-expanded='true']")
     .forEach(t => t.setAttribute("aria-expanded", "false"));
}

// Initial render — wait for auth state to resolve first
authReadyPromise.then(buildNav);

// Re-render whenever auth state changes (sign-in / sign-out)
document.addEventListener("tvbu:authchanged", buildNav);
