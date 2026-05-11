// tabs.js — Mobile bottom tab navigation (visible below 640px via CSS)
import { authReadyPromise, isApproved, isAdmin } from "./auth.js";

const activePage = (() => {
  const page = window.location.pathname.split("/").pop() || "index.html";
  if (page.startsWith("admin")) return "admin";
  if (["schedule.html", "calendar.html", "availability.html"].includes(page)) return "games";
  if (["fields.html", "field-issues.html"].includes(page)) return "fields";
  if (["incident.html", "field-issues.html"].includes(page)) return "reports";
  return "home";
})();

function a(id, href, label, active) {
  return `<a href="${href}" class="mobile-tab${active ? " active" : ""}" id="${id}"><span>${label}</span></a>`;
}

function injectTabBar() {
  if (document.getElementById("mobileTabBar")) return;
  const bar = document.createElement("nav");
  bar.id        = "mobileTabBar";
  bar.className = "mobile-tabs";
  bar.setAttribute("aria-label", "Mobile navigation");
  bar.innerHTML = `
    ${a("mt-home",  "index.html",    "Home",  activePage === "home")}
    ${a("mt-games", "schedule.html", "Games", activePage === "games")}
    <a href="fields.html"   class="mobile-tab${activePage === "fields"   ? " active" : ""}" id="mt-fields"   style="display:none"><span>Fields</span></a>
    <a href="incident.html" class="mobile-tab${activePage === "reports"  ? " active" : ""}" id="mt-reports"  style="display:none"><span>Reports</span></a>
    <a href="admin.html"    class="mobile-tab${activePage === "admin"    ? " active" : ""}" id="mt-admin"    style="display:none"><span>Admin</span></a>
    <button type="button" class="mobile-tab" id="mt-account"><span>Account</span></button>`;
  document.body.appendChild(bar);
  document.getElementById("mt-account")?.addEventListener("click", () => {
    document.getElementById("hamburgerBtn")?.click();
  });
}

function updateTabs() {
  const fields  = document.getElementById("mt-fields");
  const reports = document.getElementById("mt-reports");
  const admin   = document.getElementById("mt-admin");
  if (!fields) return;
  if (isAdmin()) {
    fields.style.display  = "";
    reports.style.display = "none";
    admin.style.display   = "";
  } else if (isApproved()) {
    fields.style.display  = "";
    reports.style.display = "";
    admin.style.display   = "none";
  } else {
    fields.style.display  = "none";
    reports.style.display = "none";
    admin.style.display   = "none";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  injectTabBar();
  authReadyPromise.then(updateTabs);
});
