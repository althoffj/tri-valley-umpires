// nav.js — Dynamic top navigation, auth-aware, single source of truth
import { authReadyPromise, isApproved, isAdmin, isCoach } from "./auth.js";

// ── Current page & section detection ─────────────────────────────────────

const page = window.location.pathname.split("/").pop() || "index.html";

const section = (() => {
  if (["schedule.html", "calendar.html", "availability.html"].includes(page)) return "games";
  if (["fields.html", "field-issues.html"].includes(page)) return "fields";
  if (["incident.html"].includes(page)) return "reports";
  if (["expectations.html", "principles_of_umpiring.html", "rule_breakdown.html",
       "pregame-meeting.html", "training.html"].includes(page)) return "training";
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

function guestNav() {
  return `
    ${navLink("index.html", "Home")}
    ${trainingDropdown()}
    ${navLink("fields.html",          "Fields")}
    ${navLink("form.html",            "Become an Umpire")}
    ${navLink("request-umpire.html",  "Request Umpire")}
  `;
}

function umpireNav() {
  return `
    ${navLink("index.html", "Home")}
    ${navTrigger("games", "Games",
      navLink("schedule.html",    "Schedule &amp; Signups") +
      navLink("calendar.html",    "Calendar") +
      navLink("availability.html","My Availability")
    )}
    ${navTrigger("fields", "Fields",
      navLink("fields.html",      "Field Directory") +
      navLink("field-issues.html","Report Field Issue")
    )}
    ${navTrigger("reports", "Reports",
      navLink("incident.html",    "Incident Report") +
      navLink("field-issues.html","Field Issues")
    )}
    ${trainingDropdown()}
  `;
}

// Admin uses the same top nav as umpire — Admin Panel is in the hamburger
function adminNav() {
  return umpireNav();
}

function coachNav() {
  return `<div class="nav-links">
    ${navLink("index.html",        "Home")}
    ${navLink("coach-portal.html", "Coach Portal")}
    ${navLink("schedule.html",     "Schedule")}
    ${navLink("incident.html",     "Incident Report")}
    ${navLink("field-issues.html", "Field Issues")}
  </div>`;
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
