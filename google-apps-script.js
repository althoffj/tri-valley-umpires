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
  "ParentPhone"
];

const INITIAL_GAMES = [
  ["crooks-12u-2026-05-13", "City of Crooks", "Wednesday, May 13", "6:30 PM", "12U", "NH-North"],
  ["crooks-12u-2026-05-20", "City of Crooks", "Wednesday, May 20", "6:30 PM", "12U", "NH-North"],
  ["crooks-12u-2026-05-27", "City of Crooks", "Wednesday, May 27", "6:30 PM", "12U", "NH-North"],
  ["colton-10u-2026-05-11", "City of Colton", "Monday, May 11", "6:30 PM", "10U", "West"],
  ["colton-10u-2026-05-13", "City of Colton", "Wednesday, May 13", "6:30 PM", "10U", "West"],
  ["colton-10u-2026-05-18", "City of Colton", "Monday, May 18", "6:30 PM", "10U", "West"],
  ["colton-10u-2026-05-20", "City of Colton", "Wednesday, May 20", "6:30 PM", "10U", "West"],
  ["colton-10u-2026-05-27", "City of Colton", "Wednesday, May 27", "6:30 PM", "10U", "East & West"]
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
      clean(data.parent_phone)
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
    const action = params.action || "list";
    const payload = action === "assign" ? assignGame(params) : listGames();
    return jsonp(callback, payload);
  } catch (error) {
    return jsonp(callback, { ok: false, message: error.message });
  }
}

function listGames() {
  const sheet = getGamesSheet();
  const values = sheet.getDataRange().getValues();
  const assignments = {};

  values.slice(1).forEach((row) => {
    const game = rowToGame(row);
    if (game.assignedName) {
      assignments[game.id] = game;
    }
  });

  return { ok: true, assignments };
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

  return values
    .slice(1)
    .map((row) => ({
      name: clean(row[nameIndex]),
      email: clean(row[emailIndex]).toLowerCase()
    }))
    .filter((umpire) => umpire.name && umpire.email);
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
      sheet.appendRow([...game, "", "", ""]);
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

function rowToGame(row) {
  return {
    id: clean(row[0]),
    city: clean(row[1]),
    date: clean(row[2]),
    time: clean(row[3]),
    division: clean(row[4]),
    field: clean(row[5]),
    assignedName: clean(row[6]),
    assignedEmail: clean(row[7])
  };
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
