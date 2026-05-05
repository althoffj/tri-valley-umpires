// Authentication for Tri-Valley Umpires Portal
// Uses localStorage to persist login session
// Validates against Google Sheets via JSONP
//
// SECURITY NOTE: The login() function passes the password as a URL query
// parameter because JSONP is required for GitHub Pages → Google Apps Script
// communication (no CORS support on the Apps Script side). This means the
// password will appear in browser history and server access logs. A backend
// proxy would eliminate this risk but is not available in this static-site
// architecture. Umpires should use a unique password not shared with other
// services.

const AUTH_API_URL = "https://script.google.com/macros/s/AKfycbxilIe2j1MscC8fE77siFCDwZHPU3z1WLqQV-SdvHgQlWQo1rcn6RiSJtYsQfCUAKMc/exec";

const AUTH_STORAGE_KEY = "umpireSession";

// Sessions expire after 30 days of inactivity
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

// JSONP login requests time out after 10 seconds
const JSONP_TIMEOUT_MS = 10000;

function getSession() {
  try {
    var raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    var session = JSON.parse(raw);

    // Expire stale sessions
    if (session && session.loggedInAt) {
      var age = Date.now() - new Date(session.loggedInAt).getTime();
      if (age > SESSION_MAX_AGE_MS) {
        clearSession();
        return null;
      }
    }

    return session;
  } catch (e) {
    return null;
  }
}

function setSession(name, email) {
  var session = {
    name: name,
    email: email,
    loggedInAt: new Date().toISOString()
  };
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

function isLoggedIn() {
  return getSession() !== null;
}

function getLoggedInName() {
  var s = getSession();
  return s ? s.name : null;
}

function login(name, email, password) {
  return new Promise(function(resolve, reject) {
    var callbackName = "umpireLogin_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    var script = document.createElement("script");
    var url = new URL(AUTH_API_URL);
    var settled = false;

    url.searchParams.set("action", "login");
    url.searchParams.set("callback", callbackName);
    url.searchParams.set("name", name);
    url.searchParams.set("email", email);
    url.searchParams.set("password", password);

    // Timeout: if the Apps Script doesn't respond in time, reject cleanly
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      delete window[callbackName];
      script.remove();
      reject(new Error("Login timed out. Please check your connection and try again."));
    }, JSONP_TIMEOUT_MS);

    window[callbackName] = function(payload) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
      if (payload && payload.ok) {
        setSession(name, email);
        resolve(payload);
      } else {
        reject(new Error((payload && payload.message) || "Login failed."));
      }
    };

    script.onerror = function() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
      reject(new Error("Unable to reach the login service."));
    };

    script.src = url.toString();
    document.body.appendChild(script);
  });
}

function logout() {
  clearSession();
}

// Show/hide elements based on login state
function applyAuthGate() {
  var loggedIn = isLoggedIn();
  var name = getLoggedInName();

  document.querySelectorAll("[data-auth-required]").forEach(function(el) {
    el.style.display = loggedIn ? "" : "none";
  });

  document.querySelectorAll("[data-auth-guest]").forEach(function(el) {
    el.style.display = loggedIn ? "none" : "";
  });

  document.querySelectorAll("[data-auth-name]").forEach(function(el) {
    el.textContent = name || "";
  });
}

// Run on every page load
document.addEventListener("DOMContentLoaded", applyAuthGate);
