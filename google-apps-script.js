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
  "Password"
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

function doPost(event) {
  try {
    const data = JSON.parse(event.postData.contents);
    const sheet = getOrCreateSheet(UMPIRES_SHEET_NAME, ACKNOWLEDGMENT_COLUMNS);

    sheet.appendRow([
      new Date(),
      clean(data.name),
      clean(data.email),
      clean(data.phone),
      clean(data.signature),
      clean(data.parent_name),
      clean(data.parent_email),
      clean(data.parent_phone),
      clean(data.password)
    ]);

    return ContentService.createTextOutput("Success")
      .setMimeType(ContentService.MimeType.TEXT);
  } catch (error) {
    return ContentService.createTextOutput("Error: " + error)
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

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
    } else {
      payload = listGames();
    }

    return jsonp(callback, payload);
  } catch (error) {
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

  if (nameIdx === -1 || emailIdx === -1 || passwordIdx === -1) {
    return { ok: false, message: "Unable to find credential columns in the sheet." };
  }

  var requestedName = normalize(name);
  var requestedEmail = email.toLowerCase();

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var rowName = normalize(clean(row[nameIdx]));
    var rowEmail = clean(row[emailIdx]).toLowerCase();
    var rowPassword = clean(row[passwordIdx]);

    if (rowName === requestedName && rowEmail === requestedEmail && rowPassword === password) {
      return { ok: true };
    }
  }

  return { ok: false, message: "Name, email, or password do not match. Did you complete the acknowledgment form?" };
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

  if (nameIndex === -1 || emailIndex === -1) {
    return [];
  }

  // Deduplicate: iterate from bottom to top so the most recent submission
  // per email address wins. This handles umpires who re-submit the form.
  const seen = {};
  for (let i = values.length - 1; i >= 1; i--) {
    const row = values[i];
    const name = clean(row[nameIndex]);
    const email = clean(row[emailIndex]).toLowerCase();
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
      // Write date and time as plain text by prepending an apostrophe via
      // setValues on a single row. This prevents Google Sheets from
      // auto-converting "Wednesday, May 13" or "6:30 PM" into a Date serial.
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
  }

  return sheet;
}

// rowToGame reads date and time from the sheet. If Sheets stored a Date object
// (from old rows written before this fix), it formats it back to readable
// strings rather than returning a raw serial number.
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

// If the cell holds a JS Date (Sheets auto-converted it), format it as
// "Weekday, Month Day". If it's already a plain string, return it as-is.
function formatSheetDate(value) {
  if (value instanceof Date && !isNaN(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "EEEE, MMMM d");
  }
  // Strip the leading apostrophe that was written to force plain-text storage
  return clean(value).replace(/^'/, "");
}

// If the cell holds a JS Date (Sheets auto-converted it), format it as
// "h:mm a" (e.g. "6:30 PM"). If it's already a plain string, return it as-is.
function formatSheetTime(value) {
  if (value instanceof Date && !isNaN(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "h:mm a");
  }
  return clean(value).replace(/^'/, "");
}

function clean(value) {
  return String(value || "").trim();
}

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
