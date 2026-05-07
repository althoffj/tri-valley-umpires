const SPREADSHEET_ID = "1nco-hg12C8qT5nXwPrFxRL1aDg4PQyUat8Ntpxd1KW8";
const UMPIRES_SHEET_NAME = "Umpires";
const GAMES_SHEET_NAME = "Games";

const GAME_COLUMNS = [
  "GameId",
  "City",
  "Date",
  "Time",
  "Division",
  "Field",
  "AssignedName",
  "AssignedEmail",
  "AssignedAt"
];

const ACKNOWLEDGMENT_COLUMNS = [
  "Timestamp",
  "Name",
  "Email",
  "Phone",
  "Signature",
  "ParentName",
  "ParentEmail",
  "ParentPhone",
  "Password",
  "Approved"
];

// Each entry: [GameId, City, Date (plain text), Time (plain text), Division, Field]
//
// GameIds now include a sequence suffix (-1, -2, …) so two games on the same
// date and at the same time each get their own unique row and signup slot.
// Date and Time are stored as plain text strings (apostrophe-prefixed in the
// sheet via setValues) so Google Sheets never auto-converts them into Date
// serial numbers.
const INITIAL_GAMES = [
  ["crooks-12u-2026-05-13-1", "City of Crooks", "Wednesday, May 13", "6:30 PM", "12U", "NH-North"],
  ["crooks-12u-2026-05-20-1", "City of Crooks", "Wednesday, May 20", "6:30 PM", "12U", "NH-North"],
  ["crooks-12u-2026-05-27-1", "City of Crooks", "Wednesday, May 27", "6:30 PM", "12U", "NH-North"],
  ["colton-10u-2026-05-11-1", "City of Colton", "Monday, May 11",    "6:30 PM", "10U", "West"],
  ["colton-10u-2026-05-13-1", "City of Colton", "Wednesday, May 13", "6:30 PM", "10U", "West"],
  ["colton-10u-2026-05-18-1", "City of Colton", "Monday, May 18",    "6:30 PM", "10U", "West"],
  ["colton-10u-2026-05-20-1", "City of Colton", "Wednesday, May 20", "6:30 PM", "10U", "West"],
  ["colton-10u-2026-05-27-1", "City of Colton", "Wednesday, May 27", "6:30 PM", "10U", "East"],
  ["colton-10u-2026-05-27-2", "City of Colton", "Wednesday, May 27", "6:30 PM", "10U", "West"]
];

// FIX: Removed doPost(). The site uses JSONP (GET requests) exclusively —
// doPost was never reachable from form.html or any other page, because JSONP
// injects a <script> tag which always triggers a GET. All form submissions are
// handled by the submitAcknowledgment branch inside doGet below.

function doGet(event) {
  const params = event.parameter || {};
  const callback = params.callback || "callback";

  try {
    var payload;
    var action = params.action || "list";

    if (action === "assign") {
      payload = assignGame(params);
    } else if (action === "login") {
      payload = login(params);
    } else if (action === "resetPassword") {
      payload = resetPassword(params);
    } else if (action === "submitAcknowledgment") {
      payload = submitAcknowledgment(params);
    } else {
      payload = listGames();
    }

    return jsonp(callback, payload);
  } catch (error) {
    Logger.log("doGet error [action=" + (params.action || "list") + "]: " + error.message);
    return jsonp(callback, { ok: false, message: error.message });
  }
}

function login(params) {
  var name = clean(params.name);
  var email = clean(params.email).toLowerCase();
  var password = clean(params.password);

  if (!name || !email || !password) {
    return { ok: false, message: "Name, email, and password are required." };
  }

  var sheet = getOrCreateSheet(UMPIRES_SHEET_NAME, ACKNOWLEDGMENT_COLUMNS);
  var values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return { ok: false, message: "No umpire records found." };
  }

  var headers = values[0].map(function(h) { return normalizeHeader(h); });
  var nameIdx = findHeaderIndex(headers, ["name", "umpire name", "umpire full name", "full name"]);
  var emailIdx = findHeaderIndex(headers, ["email", "email address", "umpire email", "umpire email address"]);
  var passwordIdx = findHeaderIndex(headers, ["password", "umpire password"]);
  var approvedIdx = findHeaderIndex(headers, ["approved"]);
  var foundRow = null;

  if (nameIdx === -1 || emailIdx === -1 || passwordIdx === -1) {
    return { ok: false, message: "Unable to find credential columns in the sheet." };
  }

  // FIX: normalize() already collapses internal whitespace via replace(/\s+/g, " ").
  // Using it consistently on both the stored value and the incoming value means
  // "Jeff  Althoff" in the sheet matches "Jeff Althoff" from the login form.
  var requestedName = normalize(name);
  var requestedEmail = email.toLowerCase();

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var rowName = normalize(clean(row[nameIdx]));
    var rowEmail = clean(row[emailIdx]).toLowerCase();
    var rowPassword = clean(row[passwordIdx]);

    if (rowName === requestedName && rowEmail === requestedEmail && rowPassword === password) {
      foundRow = row;
      break;
    }
  }

  if (!foundRow) {
    Logger.log("login: no match for name=" + requestedName + " email=" + requestedEmail);
    return {
      ok: false,
      message: "You do not have a valid account. Please complete the acknowledgment form at https://althoffj.github.io/tri-valley-umpires/form.html to register."
    };
  }

  // Check if the umpire has been approved by an administrator
  if (approvedIdx !== -1) {
    var approved = clean(foundRow[approvedIdx]).toLowerCase();
    if (approved !== "yes") {
      return {
        ok: false,
        message: "Your account has not yet been approved by an administrator. Please wait for approval before signing up for games."
      };
    }
  }

  Logger.log("login: success for " + requestedEmail);
  return { ok: true };
}

function resetPassword(params) {
  var name = clean(params.name);
  var email = clean(params.email).toLowerCase();
  var currentPassword = clean(params.currentPassword);
  var newPassword = clean(params.newPassword);

  if (!name || !email || !currentPassword || !newPassword) {
    return { ok: false, message: "Name, email, current password, and new password are required." };
  }

  if (newPassword.length < 6) {
    return { ok: false, message: "New password must be at least 6 characters." };
  }

  var sheet = getOrCreateSheet(UMPIRES_SHEET_NAME, ACKNOWLEDGMENT_COLUMNS);
  var values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return { ok: false, message: "No umpire records found. Did you complete the acknowledgment form?" };
  }

  var headers = values[0].map(function(h) { return normalizeHeader(h); });
  var nameIdx = findHeaderIndex(headers, ["name", "umpire name", "umpire full name", "full name"]);
  var emailIdx = findHeaderIndex(headers, ["email", "email address", "umpire email", "umpire email address"]);
  var passwordIdx = findHeaderIndex(headers, ["password", "umpire password"]);

  if (nameIdx === -1 || emailIdx === -1 || passwordIdx === -1) {
    return { ok: false, message: "Unable to find credential columns in the sheet." };
  }

  var requestedName = normalize(name);
  var requestedEmail = email.toLowerCase();
  var foundRowIndex = -1;

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var rowName = normalize(clean(row[nameIdx]));
    var rowEmail = clean(row[emailIdx]).toLowerCase();
    var rowPassword = clean(row[passwordIdx]);

    if (rowName === requestedName && rowEmail === requestedEmail && rowPassword === currentPassword) {
      foundRowIndex = i;
      break;
    }
  }

  if (foundRowIndex === -1) {
    return { ok: false, message: "Name, email, or current password do not match our records. If you have forgotten your password, please contact the league administrator to have it reset." };
  }

  var rowNumber = foundRowIndex + 1;
  var columnNumber = passwordIdx + 1;
  sheet.getRange(rowNumber, columnNumber).setValue(newPassword);

  Logger.log("resetPassword: updated for " + requestedEmail);
  return { ok: true, message: "Password has been updated successfully. You can now log in with your new password." };
}

function submitAcknowledgment(params) {
  try {
    Logger.log("submitAcknowledgment: received for " + clean(params.email));

    var sheet = getOrCreateSheet(UMPIRES_SHEET_NAME, ACKNOWLEDGMENT_COLUMNS);

    sheet.appendRow([
      new Date(),
      clean(params.name),
      clean(params.email),
      clean(params.phone),
      clean(params.signature),
      clean(params.parent_name),
      clean(params.parent_email),
      clean(params.parent_phone),
      clean(params.password),
      "No"  // Approved — must be set to "Yes" by an administrator
    ]);

    Logger.log("submitAcknowledgment: row written for " + clean(params.email));
    return { ok: true, message: "Acknowledgment recorded." };
  } catch (error) {
    Logger.log("submitAcknowledgment error: " + error.message);
    return { ok: false, message: "Failed to save acknowledgment: " + error.message };
  }
}

function listGames() {
  const sheet = getGamesSheet();
  const values = sheet.getDataRange().getValues();
  const games = [];
  const assignments = {};

  values.slice(1).forEach((row) => {
    const game = rowToGame(row);
    if (game.id) {
      games.push(game);
      if (game.assignedName) {
        assignments[game.id] = game;
      }
    }
  });

  return { ok: true, games, assignments };
}

function assignGame(params) {
  const gameId = clean(params.gameId);
  const name = clean(params.name);
  const email = clean(params.email).toLowerCase();

  if (!gameId || !name || !email) {
    throw new Error("Name and email are required.");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const umpire = findApprovedUmpire(name, email);
    if (!umpire) {
      throw new Error("That name and email are not listed as an approved umpire.");
    }

    const sheet = getGamesSheet();
    const values = sheet.getDataRange().getValues();
    const rowIndex = values.findIndex((row, index) => index > 0 && row[0] === gameId);

    if (rowIndex === -1) {
      throw new Error("That game is not available for signup.");
    }

    const assignedName = clean(values[rowIndex][6]);
    if (assignedName) {
      throw new Error(`This game is already filled by ${assignedName}.`);
    }

    const rowNumber = rowIndex + 1;
    sheet.getRange(rowNumber, 7, 1, 3).setValues([[
      umpire.name,
      umpire.email,
      new Date()
    ]]);

    Logger.log("assignGame: " + umpire.email + " assigned to " + gameId);
    return {
      ok: true,
      game: {
        id: gameId,
        assignedName: umpire.name,
        assignedEmail: umpire.email
      }
    };
  } finally {
    lock.releaseLock();
  }
}

function findApprovedUmpire(name, email) {
  const roster = getUmpireRoster();
  const requestedName = normalize(name);
  const requestedEmail = email.toLowerCase();

  for (const umpire of roster) {
    if (normalize(umpire.name) === requestedName && umpire.email.toLowerCase() === requestedEmail) {
      return umpire;
    }
  }

  return null;
}

function getUmpireRoster() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(UMPIRES_SHEET_NAME);

  if (!sheet) {
    throw new Error("The Umpires sheet was not found.");
  }

  const roster = readRosterFromSheet(sheet);
  if (!roster.length) {
    throw new Error("No approved umpires were found in the Umpires sheet.");
  }

  return roster;
}

function readRosterFromSheet(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return [];
  }

  const headers = values[0].map((header) => normalizeHeader(header));
  const nameIndex = findHeaderIndex(headers, ["name", "umpire name", "umpire full name", "full name"]);
  const emailIndex = findHeaderIndex(headers, ["email", "email address", "umpire email", "umpire email address"]);
  const approvedIndex = findHeaderIndex(headers, ["approved"]);

  if (nameIndex === -1 || emailIndex === -1) {
    return [];
  }

  // Deduplicate: iterate from bottom to top so the most recent submission
  // per email address wins. Only include umpires who have been approved.
  const seen = {};
  for (let i = values.length - 1; i >= 1; i--) {
    const row = values[i];
    const name = clean(row[nameIndex]);
    const email = clean(row[emailIndex]).toLowerCase();

    if (approvedIndex !== -1) {
      const approved = clean(row[approvedIndex]).toLowerCase();
      if (approved !== "yes") continue;
    }

    if (name && email && !seen[email]) {
      seen[email] = { name, email };
    }
  }

  return Object.values(seen);
}

function findHeaderIndex(headers, exactMatches) {
  const exactIndex = headers.findIndex((header) => exactMatches.includes(header));
  if (exactIndex !== -1) {
    return exactIndex;
  }

  return headers.findIndex((header) => {
    const compact = header.replace(/[^a-z]/g, "");
    return exactMatches.some((match) => compact === match.replace(/[^a-z]/g, ""));
  });
}

function getGamesSheet() {
  const sheet = getOrCreateSheet(GAMES_SHEET_NAME, GAME_COLUMNS);
  const existingIds = sheet
    .getDataRange()
    .getValues()
    .slice(1)
    .map((row) => row[0]);

  INITIAL_GAMES.forEach((game) => {
    if (!existingIds.includes(game[0])) {
      const lastRow = sheet.getLastRow() + 1;
      sheet.getRange(lastRow, 1, 1, 9).setValues([[
        game[0],          // GameId
        game[1],          // City
        "'" + game[2],    // Date  — apostrophe forces plain-text storage
        "'" + game[3],    // Time  — apostrophe forces plain-text storage
        game[4],          // Division
        game[5],          // Field
        "",               // AssignedName
        "",               // AssignedEmail
        ""                // AssignedAt
      ]]);
    }
  });

  return sheet;
}

function getOrCreateSheet(name, headers) {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = spreadsheet.getSheetByName(name);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
  }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  } else {
    const existingColumns = sheet.getLastColumn();
    if (existingColumns < headers.length) {
      for (let col = existingColumns + 1; col <= headers.length; col++) {
        sheet.getRange(1, col).setValue(headers[col - 1]);
      }
    }
  }

  return sheet;
}

function rowToGame(row) {
  return {
    id:            clean(row[0]),
    city:          clean(row[1]),
    date:          formatSheetDate(row[2]),
    time:          formatSheetTime(row[3]),
    division:      clean(row[4]),
    field:         clean(row[5]),
    assignedName:  clean(row[6]),
    assignedEmail: clean(row[7])
  };
}

function formatSheetDate(value) {
  if (value instanceof Date && !isNaN(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "EEEE, MMMM d");
  }
  return clean(value).replace(/^'/, "");
}

function formatSheetTime(value) {
  if (value instanceof Date && !isNaN(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "h:mm a");
  }
  return clean(value).replace(/^'/, "");
}

function clean(value) {
  return String(value || "").trim();
}

// FIX: normalize() collapses ALL internal whitespace (not just leading/trailing)
// so "Jeff  Althoff" (double space, possibly stored from an early form submission)
// matches "Jeff Althoff" entered at login. clean() handles leading/trailing;
// the replace handles runs of spaces, tabs, or newlines between words.
function normalize(value) {
  return clean(value).toLowerCase().replace(/\s+/g, " ");
}

function normalizeHeader(value) {
  return normalize(value).replace(/\*/g, "");
}

function jsonp(callback, payload) {
  const safeCallback = callback.replace(/[^\w$.]/g, "");
  return ContentService
    .createTextOutput(`${safeCallback}(${JSON.stringify(payload)});`)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}
