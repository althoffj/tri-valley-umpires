const SIGNUP_API_URL = "https://script.google.com/macros/s/AKfycbxilIe2j1MscC8fE77siFCDwZHPU3z1WLqQV-SdvHgQlWQo1rcn6RiSJtYsQfCUAKMc/exec";

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

    url.searchParams.set("action", action);
    url.searchParams.set("callback", callbackName);
    Object.entries(params).forEach(function(_ref) {
      var key = _ref[0], value = _ref[1];
      url.searchParams.set(key, value);
    });

    window[callbackName] = function(payload) {
      delete window[callbackName];
      script.remove();
      if (payload && payload.ok) {
        resolve(payload);
      } else {
        reject(new Error((payload && payload.message) || "Signup request failed."));
      }
    };

    script.onerror = function() {
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

function renderGameRows() {
  document.querySelectorAll("[data-game-list]").forEach(function(tbody) {
    var city = tbody.dataset.city;
    var rows = games
      .filter(function(game) { return game.city === city && applyFilter(game); })
      .map(function(game) {
        var assignment = assignments[game.id];
        var assignedName = assignment && assignment.assignedName;
        var statusClass = assignedName ? "status-filled" : "status-needs";
        var statusText = assignedName ? "Filled by " + escapeHtml(assignedName) : "Needs umpire";
        var action = !SIGNUP_API_URL
          ? '<button type="button" class="btn locked-btn" disabled>Signup unavailable</button>'
          : assignedName
          ? '<button type="button" class="btn locked-btn" disabled>Locked</button>'
          : '<button type="button" class="btn signup-btn" data-game-id="' + game.id + '">Sign up</button>';

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
    setMessage("Open games can be claimed by approved umpires only.", "info");
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