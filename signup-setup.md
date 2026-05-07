# Umpire Signup Setup

The schedule page uses `schedule.js` for the public UI and
`google-apps-script.js` as the Google Sheets write bridge.

## Security Considerations

1. **Passwords are stored in plaintext** in the Google Sheet. This is an
   inherent limitation of using a static GitHub Pages site with Google Sheets
   as a backend — there is no server-side code available to hash passwords.
2. **Passwords travel in URL query parameters** during login because JSONP is
   required for GitHub Pages → Google Apps Script communication (no CORS
   support on the Apps Script side). This means passwords appear in browser
   history and server access logs.
3. **Umpires should use a unique password** that is not reused with any other
   service.
4. A backend proxy server would be required to fully mitigate these issues.
   This is a known architectural limitation of the static-site approach.

## Google Sheet

`https://docs.google.com/spreadsheets/d/1nco-hg12C8qT5nXwPrFxRL1aDg4PQyUat8Ntpxd1KW8/edit`

### Umpires

The `Umpires` tab serves two purposes:
1. **Acknowledgment submissions** — appended via `doPost` with columns:
   `Timestamp | Name | Email | Phone | Signature | ParentName | ParentEmail | ParentPhone | Password`
2. **Approved umpire roster** — the signup flow validates against this same tab.
   The header row must include a recognizable name column and email column.

Recognized name headers: `Name`, `Full Name`, `Umpire Name`, `Umpire Full Name`
Recognized email headers: `Email`, `Email Address`, `Umpire Email`, `Umpire Email Address`

Only umpires listed in `Umpires` can claim a game.

### Games

**This is the dynamic game list.** Games are no longer hardcoded in JavaScript.
Instead, the Apps Script reads the `Games` tab and returns the full list to the
frontend. This means you can **add, edit, or remove games directly in the
spreadsheet** and they will appear on the schedule page automatically.

The generated columns are:

| GameId | City | Date | Time | Division | Field | AssignedName | AssignedEmail | AssignedAt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

**To add new games (e.g. June games):**
1. Open the Google Sheet
2. Go to the `Games` tab
3. Add a new row below the existing data with the game details
4. Leave `AssignedName`, `AssignedEmail`, and `AssignedAt` blank
5. The schedule page will pick up the new game on next load

**Initial seed games** are defined in `INITIAL_GAMES` in the Apps Script.
These are automatically inserted when the sheet is first created or if a
GameId doesn't already exist. After that, all game management happens in
the spreadsheet.

## Apps Script

1. Open the Google Sheet.
2. Go to `Extensions > Apps Script`.
3. Replace the existing script contents with `google-apps-script.js`, or merge
   its `doGet` signup functions into the existing project while keeping the
   updated `doPost` acknowledgment handler.
4. Deploy as a web app.
5. Set access to `Anyone`.
6. Copy the web app URL.
7. Paste that URL into `SIGNUP_API_URL` in `schedule.js` and `APPS_SCRIPT_URL` in `form.html`.

Current web app URL:

`https://script.google.com/macros/s/AKfycbxSq4Oqrcg1GNvGpNmqU-T7X0tORYma7n-5e79UVNfF7sDBNbbIauMlyC4cl73NFH0/exec`

Current deployment ID:

`AKfycbxSq4Oqrcg1GNvGpNmqU-T7X0tORYma7n-5e79UVNfF7sDBNbbIauMlyC4cl73NFH0`

The script intentionally contains both entrypoints:

- `doPost` records acknowledgment form submissions in `Umpires`.
- `doGet` handles:
  - `action=list` — returns `{ games: [...], assignments: {...} }` where
    `games` is the full game list from the sheet and `assignments` maps
    game IDs to their filled status
  - `action=assign` — validates and assigns an umpire to a game

The public page uses JSONP so it can read and write from a static GitHub Pages
site without browser CORS issues. The Apps Script still validates every signup
against the approved umpire roster and uses a script lock so two umpires cannot
claim the same open game at the same time.

## localStorage Caching

The acknowledgment form (`form.html`) saves the umpire's name and email to
`localStorage` on successful submission. The schedule page reads these values
on load and pre-fills the signup form, so umpires don't need to re-enter their
information. Keys used:
- `umpireName` — Umpire's full name
- `umpireEmail` — Umpire's email address