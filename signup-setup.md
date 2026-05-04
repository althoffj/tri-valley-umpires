# Umpire Signup Setup

The schedule page uses `schedule.js` for the public UI and
`google-apps-script.js` as the Google Sheets write bridge.

## Google Sheet

Use the existing acknowledgment response Google Sheet:

`https://docs.google.com/spreadsheets/d/1nco-hg12C8qT5nXwPrFxRL1aDg4PQyUat8Ntpxd1KW8/edit`

### Umpires

The `Umpires` tab is used for both acknowledgment submissions and the approved
umpire roster.

Acknowledgment submissions are appended with these columns:

| Timestamp | Name | Email | Phone | Signature | ParentName | ParentEmail | ParentPhone |
| --- | --- | --- | --- | --- | --- | --- | --- |

The signup flow validates against the same `Umpires` tab. The header row must
include a recognizable name column and email column.

Recognized name headers include `Name`, `Full Name`, `Umpire Name`, and
`Umpire Full Name`. Recognized email headers include `Email`, `Email Address`,
`Umpire Email`, and `Umpire Email Address`.

Only umpires listed in `Umpires` can claim a game. The signup form validates by
exact normalized name and exact email address.

### Games

This tab can be blank. The Apps Script creates the header row and the current
10U/12U May games automatically.

The generated columns are:

| GameId | City | Date | Time | Division | Field | AssignedName | AssignedEmail | AssignedAt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

Once `AssignedName` is set, the public schedule shows the umpire name and locks
the game.

## Apps Script

1. Open the Google Sheet.
2. Go to `Extensions > Apps Script`.
3. Replace the existing script contents with `google-apps-script.js`, or merge
   its `doGet` signup functions into the existing project while keeping the
   updated `doPost` acknowledgment handler.
4. Deploy as a web app.
5. Set access to `Anyone`.
6. Copy the web app URL.
7. Paste that URL into `SIGNUP_API_URL` in `schedule.js`.

Current web app URL:

`https://script.google.com/macros/s/AKfycbxoH4XvI0yhcxrLTxyIGdd2pL1zoJDa3WcitLawK55-LjQacjZ_-okvACss4xQuq1U/exec`

Current deployment ID:

`AKfycbxoH4XvI0yhcxrLTxyIGdd2pL1zoJDa3WcitLawK55-LjQacjZ_-okvACss4xQuq1U`

The script intentionally contains both entrypoints:

- `doPost` records acknowledgment form submissions in `Umpires`.
- `doGet` handles schedule reads and game signup requests.

The public page uses JSONP so it can read and write from a static GitHub Pages
site without browser CORS issues. The Apps Script still validates every signup
against the approved umpire roster and uses a script lock so two umpires cannot
claim the same open game at the same time.
