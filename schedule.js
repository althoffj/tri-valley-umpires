const SIGNUP_API_URL = "https://script.google.com/macros/s/AKfycbxilIe2j1MscC8fE77siFCDwZHPU3z1WLqQV-SdvHgQlWQo1rcn6RiSJtYsQfCUAKMc/exec";

// NOTE: The !SIGNUP_API_URL branches below are development-only fallbacks.
// In production this constant is always set, so those code paths are inactive.
// They exist to make local testing without a live Apps Script easier.

// JSONP requests time out after 10 seconds
const JSONP_TIMEOUT_MS = 10000;

let games = [];
let assignments = {};
let activeFilter = "all";

function jsonp(action, params = {}) {
  if (!SIGNUP_API_URL) {
    return Promise.reject(new Error("Signup form is not connected yet."));
  }

  return new Promise((resolve, reject) => {
    const callbackName = "umpireSignup_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    const script = document.createElement("script");
    const url = new URL(SIGNUP_API_URL);
    let settled = false;

    url.searchParams.set("action", action);
    url.searchParams.set("callback", callbackName);
    Object.entries(params).forEach(function(_ref) {
      var key = _ref[0], value = _ref[1];
      url.searchParams.set(key, value);
    });

    // Timeout: reject and clean up if Apps Script doesn't respond in time
    const timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      delete window[callbackName];
      script.remove();
      reject(new Error("Request timed out. Please check your connection and try again."));
    }, JSONP_TIMEOUT_MS);

    window[callbackName] = function(payload) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
      if (payload && payload.ok) {
        resolve(payload);
      } else {
        reject(new Error((payload && payload.message) || "Signup request failed."));
      }
    };

    script.onerror = function() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
      reject(new Error("Unable to reach the signup service."));
    };

    script.src = url.toString();
    document.body.appendChild(script);
  });
}

function updateSignupCount() {
  var total = games.length;
  var filled = games.filter(function(g) { return assignments[g.id] && assignments[g.id].assignedName; }).length;
  var available = total - filled;
  var countEl = document.getElementById("signupCount");
  if (countEl) {
    if (total === 0) {
      countEl.textContent = "No games loaded yet.";
    } else {
      countEl.textContent = filled + " of " + total + " games filled \u2014 " + available + " game" + (available !== 1 ? "s" : "") + " still available";
    }
  }
}

function applyFilter(game) {
  if (activeFilter === "all") return true;
  var assigned = !!(assignments[game.id] && assignments[game.id].assignedName);
  return activeFilter === "filled" ? assigned : !assigned;
}

// Returns true if the user is logged in (reads from auth.js session)
function userIsLoggedIn() {
  if (typeof isLoggedIn === "function") {
    return isLoggedIn();
  }
  // Fallback: check raw localStorage key in case auth.js isn't loaded
  try {
    return !!localStorage.getItem("umpireSession");
  } catch (e) {
    return false;
  }
}

function renderGameRows() {
  var loggedIn = userIsLoggedIn();

  document.querySelectorAll("[data-game-list]").forEach(function(tbody) {
    var city = tbody.dataset.city;
    var rows = games
      .filter(function(game) { return game.city === city && applyFilter(game); })
      .map(function(game) {
        var assignment = assignments[game.id];
        var assignedName = assignment && assignment.assignedName;
        var statusClass = assignedName ? "status-filled" : "status-needs";
        var statusText = assignedName ? "Filled by " + escapeHtml(assignedName) : "Needs umpire";

        var action;
        if (!SIGNUP_API_URL) {
          // Dev-only: no backend connected
          action = '<button type="button" class="btn locked-btn" disabled>Signup unavailable</button>';
        } else if (assignedName) {
          // Game already claimed
          action = '<button type="button" class="btn locked-btn" disabled>Locked</button>';
        } else if (!loggedIn) {
          // Not logged in — prompt to log in instead of showing the form
          action = '<a href="index.html" class="btn print-btn">Log in to sign up</a>';
        } else {
          // Logged in and game is open
          action = '<button type="button" class="btn signup-btn" data-game-id="' + game.id + '">Sign up</button>';
        }

        return [
          '<tr>',
          '  <td>' + escapeHtml(game.date) + '</td>',
          '  <td>' + escapeHtml(game.time) + '</td>',
          '  <td>' + escapeHtml(game.division) + '</td>',
          '  <td>' + escapeHtml(game.field) + '</td>',
          '  <td class="' + statusClass + '">' + statusText + '</td>',
          '  <td>' + action + '</td>',
          '</tr>'
        ].join("\n");
      })
      .join("");

    tbody.innerHTML = rows;
  });
  updateSignupCount();
}

function setMessage(message, type) {
  if (!type) type = "info";
  var messageBox = document.getElementById("signupMessage");
  messageBox.textContent = message;
  messageBox.className = "signup-message " + type;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "\x26amp;")
    .replace(/</g, "\x26lt;")
    .replace(/>/g, "\x26gt;")
    .replace(/"/g, "\x26quot;")
    .replace(/'/g, "\x26#39;");
}

function openSignupForm(gameId) {
  var game = null;
  for (var i = 0; i < games.length; i++) {
    if (games[i].id === gameId) { game = games[i]; break; }
  }
  if (!game) return;

  document.getElementById("gameId").value = game.id;
  document.getElementById("selectedGame").textContent =
    game.city + ": " + game.division + " on " + game.date + " at " + game.time + ", " + game.field;
  document.getElementById("signupForm").hidden = false;
  document.getElementById("umpireName").focus();
  setMessage("Enter the same name and email listed on your umpire acknowledgment.", "info");
}

function showLoadingState() {
  document.querySelectorAll("[data-game-list]").forEach(function(tbody) {
    tbody.innerHTML = [
      '<tr>',
      '  <td colspan="6" style="text-align:center;color:var(--light-text);padding:30px;">',
      '    Loading schedule\u2026',
      '  </td>',
      '</tr>'
    ].join("\n");
  });
}

function populateCachedSignupFields() {
  var cachedName = localStorage.getItem("umpireName");
  var cachedEmail = localStorage.getItem("umpireEmail");
  if (cachedName) document.getElementById("umpireName").value = cachedName;
  if (cachedEmail) document.getElementById("umpireEmail").value = cachedEmail;
}

function clearGames() {
  games = [];
  assignments = {};
  document.querySelectorAll("[data-game-list]").forEach(function(tbody) {
    tbody.innerHTML = "";
  });
  updateSignupCount();
}

async function loadAssignments() {
  showLoadingState();

  if (!SIGNUP_API_URL) {
    setMessage("Signup form is not connected yet. Email Jeff to claim a game.", "warning");
    renderGameRows();
    return;
  }

  try {
    var payload = await jsonp("list");
    games = payload.games || [];
    assignments = payload.assignments || {};
    renderGameRows();
    if (userIsLoggedIn()) {
      setMessage("Open games can be claimed by approved umpires only.", "info");
    } else {
      setMessage("Log in on the home page to sign up for open games.", "info");
    }
  } catch (error) {
    clearGames();
    setMessage(error.message, "error");
  }

  populateCachedSignupFields();
}

document.addEventListener("click", function(event) {
  // Game signup button
  var signupBtn = event.target.closest("[data-game-id]");
  if (signupBtn) {
    // Double-check auth at click time in case session expired mid-page
    if (!userIsLoggedIn()) {
      setMessage("You must be logged in to sign up for a game. Please log in on the home page.", "warning");
      return;
    }
    openSignupForm(signupBtn.dataset.gameId);
    return;
  }

  // Filter button
  var filterBtn = event.target.closest(".filter-btn");
  if (filterBtn) {
    var filter = filterBtn.dataset.filter;
    if (!filter) return;
    activeFilter = filter;

    // Update button styles
    document.querySelectorAll(".filter-btn").forEach(function(btn) {
      btn.style.background = btn.dataset.filter === filter
        ? "var(--accent)"
        : "#444";
    });

    renderGameRows();
  }
});

document.getElementById("cancelSignup").addEventListener("click", function() {
  document.getElementById("signupForm").hidden = true;
});

document.getElementById("signupForm").addEventListener("submit", async function(event) {
  event.preventDefault();

  // Guard: re-verify login state at submit time
  if (!userIsLoggedIn()) {
    setMessage("Your session has expired. Please log in again on the home page.", "error");
    this.hidden = true;
    return;
  }

  var submitButton = document.getElementById("submitSignup");
  var params = {
    gameId: document.getElementById("gameId").value,
    name: document.getElementById("umpireName").value.trim(),
    email: document.getElementById("umpireEmail").value.trim()
  };

  submitButton.disabled = true;
  setMessage("Checking the approved umpire list...", "info");

  try {
    var payload = await jsonp("assign", params);
    assignments[payload.game.id] = payload.game;
    renderGameRows();
    event.target.reset();
    event.target.hidden = true;
    setMessage(payload.game.assignedName + " is now assigned and the game is locked.", "success");
    populateCachedSignupFields();
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
});

loadAssignments();
