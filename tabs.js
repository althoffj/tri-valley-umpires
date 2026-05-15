// tabs.js — Mobile bottom tab navigation (visible below 640px via CSS)
import { authReadyPromise, isApproved, isAdmin, isCoach } from "./auth.js";

const activePage = (() => {
  const page = window.location.pathname.split("/").pop() || "index.html";
  if (page.startsWith("admin")) return "admin";
  if (["schedule.html", "calendar.html", "availability.html"].includes(page)) return "games";
  if (["fields.html", "field-issues.html", "facility-schedule.html"].includes(page)) return "fields";
  if (["incident.html"].includes(page)) return "reports";
  if (page === "coach-portal.html") return "coach";
  return "home";
})();

function a(id, href, icon, label, active) {
  return `<a href="${href}" class="mobile-tab${active ? " active" : ""}" id="${id}">
    <span class="tab-icon">${icon}</span><span class="tab-label">${label}</span>
  </a>`;
}

function injectTabBar() {
  if (document.getElementById("mobileTabBar")) return;
  const bar = document.createElement("nav");
  bar.id        = "mobileTabBar";
  bar.className = "mobile-tabs";
  bar.setAttribute("aria-label", "Mobile navigation");
  bar.innerHTML = `
    ${a("mt-home",  "index.html",        "🏠", "Home",    activePage === "home")}
    ${a("mt-games", "schedule.html",     "⚾", "Games",   activePage === "games")}
    <a href="coach-portal.html" class="mobile-tab${activePage === "coach"   ? " active" : ""}" id="mt-coach"   style="display:none">
      <span class="tab-icon">📋</span><span class="tab-label">Portal</span>
    </a>
    <a href="fields.html"   class="mobile-tab${activePage === "fields"  ? " active" : ""}" id="mt-fields"  style="display:none">
      <span class="tab-icon">🏟</span><span class="tab-label">Fields</span>
    </a>
    <a href="incident.html" class="mobile-tab${activePage === "reports" ? " active" : ""}" id="mt-reports" style="display:none">
      <span class="tab-icon">📋</span><span class="tab-label">Reports</span>
    </a>
    <a href="admin.html"    class="mobile-tab${activePage === "admin"   ? " active" : ""}" id="mt-admin"   style="display:none">
      <span class="tab-icon">⚙️</span><span class="tab-label">Admin</span>
    </a>
    <button type="button" class="mobile-tab" id="mt-account">
      <span class="tab-icon">👤</span><span class="tab-label">Account</span>
    </button>`;
  document.body.appendChild(bar);
  document.getElementById("mt-account")?.addEventListener("click", () => {
    document.getElementById("hamburgerBtn")?.click();
  });
}

function updateTabs() {
  const coachTab = document.getElementById("mt-coach");
  const fields   = document.getElementById("mt-fields");
  const reports  = document.getElementById("mt-reports");
  const admin    = document.getElementById("mt-admin");
  if (!fields) return;

  if (isAdmin()) {
    // Admins: show Fields, Reports, and Admin; hide Coach Portal
    if (coachTab) coachTab.style.display = "none";
    fields.style.display  = "";
    reports.style.display = "";
    admin.style.display   = "";
  } else if (isApproved()) {
    // Approved umpires: show Fields and Reports; hide Coach Portal and Admin
    if (coachTab) coachTab.style.display = "none";
    fields.style.display  = "";
    reports.style.display = "";
    admin.style.display   = "none";
  } else if (isCoach()) {
    // Coaches: show Coach Portal and Fields; hide Reports and Admin
    if (coachTab) coachTab.style.display = "";
    fields.style.display  = "";
    reports.style.display = "none";
    admin.style.display   = "none";
  } else {
    // Guests: hide all role-specific tabs
    if (coachTab) coachTab.style.display = "none";
    fields.style.display  = "none";
    reports.style.display = "none";
    admin.style.display   = "none";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  injectTabBar();
  authReadyPromise.then(updateTabs);
});
