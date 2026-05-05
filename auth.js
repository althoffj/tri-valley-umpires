// Authentication for Tri-Valley Umpires Portal
// Uses localStorage to persist login session
// Validates against Google Sheets via JSONP

const AUTH_API_URL = "https://script.google.com/macros/s/AKfycbxilIe2j1MscC8fE77siFCDwZHPU3z1WLqQV-SdvHgQlWQo1rcn6RiSJtYsQfCUAKMc/exec";

const AUTH_STORAGE_KEY = "umpireSession";

function getSession() {
  try {
    var raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
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

function getLoggedInEmail() {
  var s = getSession();
  return s ? s.email : null;
}

function login(name, email, password) {
  return new Promise(function(resolve, reject) {
    var callbackName = "umpireLogin_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    var script = document.createElement("script");
    var url = new URL(AUTH_API_URL);

    url.searchParams.set("action", "login");
    url.searchParams.set("callback", callbackName);
    url.searchParams.set("name", name);
    url.searchParams.set("email", email);
    url.searchParams.set("password", password);

    window[callbackName] = function(payload) {
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