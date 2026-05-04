const SIGNUP_API_URL = "https://script.google.com/macros/s/AKfycbxoH4XvI0yhcxrLTxyIGdd2pL1zoJDa3WcitLawK55-LjQacjZ_-okvACss4xQuq1U/exec";

const games = [
  {
    id: "crooks-12u-2026-05-13",
    city: "City of Crooks",
    date: "Wednesday, May 13",
    time: "6:30 PM",
    division: "12U",
    field: "NH-North"
  },
  {
    id: "crooks-12u-2026-05-20",
    city: "City of Crooks",
    date: "Wednesday, May 20",
    time: "6:30 PM",
    division: "12U",
    field: "NH-North"
  },
  {
    id: "crooks-12u-2026-05-27",
    city: "City of Crooks",
    date: "Wednesday, May 27",
    time: "6:30 PM",
    division: "12U",
    field: "NH-North"
  },
  {
    id: "colton-10u-2026-05-11",
    city: "City of Colton",
    date: "Monday, May 11",
    time: "6:30 PM",
    division: "10U",
    field: "West"
  },
  {
    id: "colton-10u-2026-05-13",
    city: "City of Colton",
    date: "Wednesday, May 13",
    time: "6:30 PM",
    division: "10U",
    field: "West"
  },
  {
    id: "colton-10u-2026-05-18",
    city: "City of Colton",
    date: "Monday, May 18",
    time: "6:30 PM",
    division: "10U",
    field: "West"
  },
  {
    id: "colton-10u-2026-05-20",
    city: "City of Colton",
    date: "Wednesday, May 20",
    time: "6:30 PM",
    division: "10U",
    field: "West"
  },
  {
    id: "colton-10u-2026-05-27",
    city: "City of Colton",
    date: "Wednesday, May 27",
    time: "6:30 PM",
    division: "10U",
    field: "East & West"
  }
];

let assignments = {};

function jsonp(action, params = {}) {
  if (!SIGNUP_API_URL) {
    return Promise.reject(new Error("Signup form is not connected yet."));
  }

  return new Promise((resolve, reject) => {
    const callbackName = `umpireSignup_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const url = new URL(SIGNUP_API_URL);

    url.searchParams.set("action", action);
    url.searchParams.set("callback", callbackName);
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    window[callbackName] = (payload) => {
      delete window[callbackName];
      script.remove();
      if (payload && payload.ok) {
        resolve(payload);
      } else {
        reject(new Error((payload && payload.message) || "Signup request failed."));
      }
    };

    script.onerror = () => {
      delete window[callbackName];
      script.remove();
      reject(new Error("Unable to reach the signup service."));
    };

    script.src = url.toString();
    document.body.appendChild(script);
  });
}

function renderGameRows() {
  document.querySelectorAll("[data-game-list]").forEach((tbody) => {
    const city = tbody.dataset.city;
    const rows = games
      .filter((game) => game.city === city)
      .map((game) => {
        const assignment = assignments[game.id];
        const assignedName = assignment && assignment.assignedName;
        const statusClass = assignedName ? "status-filled" : "status-needs";
        const statusText = assignedName ? `Filled by ${escapeHtml(assignedName)}` : "Needs umpire";
        const action = !SIGNUP_API_URL
          ? `<button type="button" class="btn locked-btn" disabled>Signup unavailable</button>`
          : assignedName
          ? `<button type="button" class="btn locked-btn" disabled>Locked</button>`
          : `<button type="button" class="btn signup-btn" data-game-id="${game.id}">Sign up</button>`;

        return `
          <tr>
            <td>${escapeHtml(game.date)}</td>
            <td>${escapeHtml(game.time)}</td>
            <td>${escapeHtml(game.division)}</td>
            <td>${escapeHtml(game.field)}</td>
            <td class="${statusClass}">${statusText}</td>
            <td>${action}</td>
          </tr>
        `;
      })
      .join("");

    tbody.innerHTML = rows;
  });
}

function setMessage(message, type = "info") {
  const messageBox = document.getElementById("signupMessage");
  messageBox.textContent = message;
  messageBox.className = `signup-message ${type}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function openSignupForm(gameId) {
  const game = games.find((candidate) => candidate.id === gameId);
  if (!game) return;

  document.getElementById("gameId").value = game.id;
  document.getElementById("selectedGame").textContent =
    `${game.city}: ${game.division} on ${game.date} at ${game.time}, ${game.field}`;
  document.getElementById("signupForm").hidden = false;
  document.getElementById("umpireName").focus();
  setMessage("Enter the same name and email listed on your umpire acknowledgment.", "info");
}

async function loadAssignments() {
  if (!SIGNUP_API_URL) {
    renderGameRows();
    setMessage("Signup form is not connected yet. Email Jeff to claim a game.", "warning");
    return;
  }

  try {
    const payload = await jsonp("list");
    assignments = payload.assignments || {};
    renderGameRows();
    setMessage("Open games can be claimed by approved umpires only.", "info");
  } catch (error) {
    renderGameRows();
    setMessage(error.message, "error");
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-game-id]");
  if (!button) return;
  openSignupForm(button.dataset.gameId);
});

document.getElementById("cancelSignup").addEventListener("click", () => {
  document.getElementById("signupForm").hidden = true;
});

document.getElementById("signupForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const submitButton = document.getElementById("submitSignup");
  const params = {
    gameId: document.getElementById("gameId").value,
    name: document.getElementById("umpireName").value.trim(),
    email: document.getElementById("umpireEmail").value.trim()
  };

  submitButton.disabled = true;
  setMessage("Checking the approved umpire list...", "info");

  try {
    const payload = await jsonp("assign", params);
    assignments[payload.game.id] = payload.game;
    renderGameRows();
    event.target.reset();
    event.target.hidden = true;
    setMessage(`${payload.game.assignedName} is now assigned and the game is locked.`, "success");
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
});

loadAssignments();
