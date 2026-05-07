# Tri-Valley Umpires — Implementation Plan
_Synthesized from platform review + vision documents. Current as of May 2026._

---

## Current Platform State

### Already Built
| Feature | Status |
|---|---|
| Firebase Auth (email/password), hamburger auth menu | ✅ Done |
| Umpire registration + approval workflow | ✅ Done |
| Game schedule with slot claim/release | ✅ Done |
| Admin: games (add/edit/cancel/delete/sync/import/assign) | ✅ Done |
| Admin: umpire roster (approve/deny/revoke) | ✅ Done |
| Admin: payroll (mark paid, date filter) | ✅ Done |
| Admin: facilities + field detail management | ✅ Done |
| Admin: config (pay rates, default slot types) | ✅ Done |
| Admin: permission cards (role management) | ✅ Done |
| Admin: super admin manual umpire assignment | ✅ Done |
| Field issues (submit + admin tracking) | ✅ Done |
| Incident reports | ✅ Done |
| Calendar (day/week/month) | ✅ Done |
| Fields page (dynamic from Firestore) | ✅ Done |
| Coach umpire request form + admin review | ✅ Done |
| Slack webhook integration (game events, day-of reminders) | ✅ Done |
| FCM service worker (background push infrastructure) | ✅ Done |

### Not Yet Built
- PWA web manifest + installability
- Push notification permission UI (token request/save)
- Umpire availability management
- Day-of quick actions (GPS, contact partner, check-in)
- Mobile bottom tab navigation
- Admin announcements / broadcast
- Umpire check-in per game slot
- Weather integration
- Google Sign-In
- Payroll export (CSV)
- Enhanced incident types (ejections, injuries, photos)

---

## Architecture Decision: React vs. Stay Vanilla

**Recommendation: Stay in vanilla JS for now. Do not migrate to React yet.**

Reasons:
- Platform is fully operational today. React migration = full rewrite with no user-visible gain.
- Every feature in Tiers 1–3 below can be built cleanly in the current stack.
- Admin-heavy workflows (tables, modals, forms) are already well-served by the current approach.
- React migration makes sense when: the team expands, complexity forces component reuse across pages at scale, or a Flutter companion app needs a shared API layer.

**Revisit React when:**
- Active umpire count exceeds ~30 and the codebase feels unmanageable
- Component reuse across pages becomes a significant maintenance burden
- A dedicated front-end developer joins the project

**Flutter:** Not being pursued. Long-term mobile strategy is a native React framework (React Native or a PWA built on the React platform), sharing the same Firebase backend.

---

## Implementation Tiers

---

### TIER 1 — High Value, Low Effort
_Can be built in the current stack. Immediate user impact._

---

#### T1-A: PWA Installability
**Goal:** Umpires can "Add to Home Screen" and launch the site like a native app.

**Files:**
- `manifest.json` (new) — app name, icons, theme color, `display: standalone`
- `sw.js` (new) — app shell caching (HTML, CSS, JS, logo); Network First for Firestore data
- All HTML pages — add `<link rel="manifest">` and `<meta name="theme-color">`
- `firebase.json` — register SW in a `pwa.js` init module; update headers to cache manifest

**Scope:**
- Static asset caching (styles.css, auth.js, firebase.js, logo.png)
- Offline fallback page for when network is unavailable
- No IndexedDB complexity yet — just app shell + static caching
- The existing `firebase-messaging-sw.js` handles FCM; `sw.js` handles app caching (separate scopes or combined)

**Notes:** `firebase-messaging-sw.js` must remain at root. The new `sw.js` can be a separate registration or they can be merged into one combined service worker.

---

#### T1-B: Push Notification Permission UI
**Goal:** Umpires can opt in to push notifications from the app. Admins can send broadcasts.

**Infrastructure already exists:** `firebase-messaging-sw.js`, `notifications/{uid}` Firestore collection, FCM token storage pattern.

**Umpire side — files:**
- `auth.js` — add `requestNotificationPermission()` that calls `getToken(messaging, { vapidKey })`, saves to `notifications/{uid}`
- Hamburger menu / account section in `index.html` — "Enable Push Notifications" button, shows current status

**Admin side — files:**
- `admin-config.html` + `admin-config.js` — add "Send Broadcast Notification" form (title + body)
- Cloud Function `sendBroadcast` — reads all `notifications` docs, calls FCM `sendEachForMulticast`

**Notification types to support:**
- Admin broadcast (manual)
- Game cancellation (already wired in Slack functions — add FCM send there)
- Day-of reminder (already wired — add FCM there)
- New game added (for umpires who want to know)

---

#### T1-C: Umpire Availability Management
**Goal:** Umpires mark dates they're unavailable. Admin sees availability when assigning.

**Firestore:** `availability/{uid}` → `{ unavailableDates: ["2026-06-01", "2026-06-07", ...] }` or date ranges `{ ranges: [{ from, to, reason }] }`

**New files:**
- `availability.html` — calendar-style UI for selecting unavailable dates
- `availability.js` — load/save availability; month view with toggle-able days

**Admin integration:**
- `admin-games.js` — in the assign modal, load the target umpire's availability. If the game date is in their unavailable list, show a warning badge (not a block — admin can override).

**Nav:** Add "Availability" link to all nav bars for `data-auth-approved` users.

---

#### T1-D: Day-of Quick Actions
**Goal:** When an umpire has a game today, give them fast access to the critical actions they need at the field.

**Implementation:** On `schedule.html`, after loading games, detect if the current user has an assigned slot on a game today. If so, render a sticky "Game Day" bar above the schedule:

```
[ 📍 Directions ]  [ 📞 Partner ]  [ ⚠ Report Issue ]  [ ✓ Check In ]
```

- **Directions** — links to the facility Google Maps URL from Firestore
- **Partner** — shows phone number of the other assigned umpire (requires umpires/{uid} lookup)
- **Report Issue** — links to `field-issues.html` pre-filled with the game's facility
- **Check In** — writes `checkedIn: true` + timestamp to the umpire's slot

**Firestore schema change:** Add `checkedIn: boolean` and `checkedInAt: timestamp` to each slot object in `games/{gameId}.umpireSlots[]`.

**Files:** `schedule.js`, `schedule.html`

---

#### T1-E: Mobile Bottom Tab Navigation
**Goal:** On small screens, replace the horizontal nav link bar with a thumb-friendly bottom tab bar.

**Tabs (umpire):**
```
Home | Schedule | Fields | Reports | Account
```

**Tabs (admin):**
```
Home | Schedule | Fields | Admin | Account
```

**Implementation:**
- Add `.mobile-tabs` fixed-bottom bar in `styles.css` (hidden above 640px breakpoint)
- The existing top nav stays for desktop
- Each tab maps to an existing page; active tab highlighted
- Auth-aware: Reports and Fields only visible when approved
- Add to all pages via a shared HTML pattern (or a small `tabs.js` that injects it)

**Files:** `styles.css`, `tabs.js` (new — injects tab bar based on current page), all HTML pages

---

### TIER 2 — Operational Enhancements
_Meaningful for day-to-day operations. Moderate effort._

---

#### T2-A: Admin Announcements / Broadcast
**Goal:** Super admin posts announcements visible to all approved umpires on the home page.

**Firestore:** `announcements` collection — `{ title, body, postedBy, postedAt, active: true }`

**Admin side:**
- `admin.html` — new "Announcements" section (super admin only)
- Post/edit/delete announcements
- Optional: trigger push notification on post

**Umpire side:**
- `index.js` — load active announcements, render above the agenda panel
- Style as a yellow banner for important notices, standard cards otherwise

**Files:** `admin.html`, `admin.js`, `index.html`, `index.js`, `firestore.rules` (add `announcements` collection)

---

#### T2-B: Payroll CSV Export
**Goal:** Admin can export payroll data as CSV for external processing.

**Implementation:** In `admin-payroll.js`, add an "Export CSV" button that generates a CSV from the currently-filtered payroll data (already loaded in memory) using a Blob download. No server call needed.

**Columns:** Umpire Name, Date, City, Division, Slot Type, Pay Rate, Paid (Yes/No)

**Files:** `admin-payroll.js`, `admin-payroll.html`

---

#### T2-C: Umpire Check-In (game slot)
**Goal:** Umpires confirm arrival at the field. Admins see real-time check-in status.

Already described in T1-D above. The schedule.js quick action implements the umpire side. This item covers the admin side:

**Admin side:**
- `admin-games.js` / `renderAdminGames()` — show check-in status badge per slot (checked-in / not yet)
- Helpful for day-of visibility: which umpires have arrived

---

#### T2-D: Enhanced Incident Reports
**Goal:** Capture ejection and injury incidents with structured fields. Support photo attachments.

**New incident categories and fields:**
- Ejection: ejected party (player/coach/manager), team, reason
- Injury: type of injury, player/umpire affected, EMS called (yes/no)
- Unsafe Conditions: condition type, game suspended (yes/no)
- Current categories remain for general incidents

**Photo attachments:**
- Add Firebase Storage (`firebase-storage.js`)
- File input on `incident.html` — upload up to 3 photos
- Store URLs in incident doc: `photoUrls: [...]`
- Admin view shows photo thumbnails

**Files:** `incident.html`, `incident.js`, `firestore.rules` (Firebase Storage rules), new `firebase-storage.js`

---

#### T2-E: Umpire Earnings Summary Page
**Goal:** Each umpire can see their own earnings for the season — not just what admin sees.

**New page:** `earnings.html` + `earnings.js`
- Shows all games where the umpire has an assigned slot
- Columns: Date, City, Division, Slot, Pay Rate, Paid status
- Season total, paid total, unpaid total
- Auth-gated: approved umpires only; shows only their own data

**Files:** `earnings.html` (new), `earnings.js` (new); add nav link for approved umpires

---

### TIER 3 — Platform Features
_Valuable but larger scope. Plan carefully before starting._

---

#### T3-A: Google Sign-In
**Goal:** Umpires can register/sign in with Google.

**Considerations:**
- Existing umpires registered with email/password — they keep their accounts
- New Google users need to complete the registration form (`form.html`) on first login to create their umpires doc
- Detection: if `auth.currentUser` exists but no `umpires/{uid}` doc, redirect to registration

**Files:** `auth.js` (add `signInWithPopup`), hamburger menu in all HTML pages, `form.js` (handle Google pre-filled name/email)

---

#### T3-B: Weather Integration
**Goal:** Show current weather conditions on the fields page and for games today.

**API:** Open-Meteo (free, no API key needed). Input: lat/lon from facility address or hardcoded per facility.

**Implementation:**
- `fields.js` — fetch weather for each facility's coordinates on page load. Show current temp, precipitation probability, wind.
- `schedule.js` — for today's games, show a small weather badge per game row.
- Weather data cached in memory per session (not Firestore).

**Files:** `fields.js`, `schedule.js`

---

#### T3-C: Umpire Profile — Availability Preferences + Equipment
**Goal:** Expand the umpire profile with operationally useful data.

**Fields to add to `umpires/{uid}`:**
- `maxGamesPerWeek` — integer preference
- `notes` — umpire-supplied general notes
- `equipment` — checklist of owned equipment (chest protector, mask, ball bag, etc.)
- `certifications` — any formal umpire certifications

**Admin view:** Show equipment and certification info in the roster for assignment planning.

**Files:** hamburger profile edit section, `auth.js` (`updateProfile`), `admin.html` roster view

---

#### T3-D: Rule Search / Reference Enhancements
**Goal:** Make the rules pages more useful.

**Options (pick one):**
1. **Simple:** Add a text search filter to `rule_breakdown.html` that highlights matching sections
2. **Medium:** Build a structured rules JSON (rule number, text, age-level applicability) and render it with filter/search
3. **Advanced:** Integrate an AI rules assistant using the Claude API — ask a question, get a rule reference

**Recommendation:** Start with option 1 (JavaScript `Ctrl+F` equivalent on the page). Option 3 is the long-term goal and requires a Cloud Function proxy to the Claude API.

---

#### T3-E: Admin Analytics Dashboard
**Goal:** Give admins visibility into platform health and umpire activity.

**Metrics to show (computed from existing Firestore data):**
- Total games this season / upcoming / cancelled
- Slots filled vs. open across all upcoming games
- Unpaid slots total (dollar amount)
- Incidents submitted this season
- Field issues by status (open/in-progress/resolved)
- Umpire activity: games worked per umpire (leaderboard)

**Implementation:** New section on `admin.html` or a dedicated `admin-analytics.html`. All computed client-side from Firestore queries — no new data needed.

---

### TIER 4 — Long-Term Architecture
_Plan but don't build yet._

---

#### T4-A: React Migration
**Trigger:** Platform complexity outgrows vanilla JS — component reuse becomes a maintenance burden, or active development accelerates significantly.

**When ready:**
- Vite + React + TypeScript + TailwindCSS + React Query
- Migrate page by page (schedule → admin → public)
- Keep Firebase backend identical — only the frontend changes
- React Router replaces multi-page HTML architecture
- Component library: shadcn/ui (matches current dark theme direction)
- Long-term mobile strategy: React Native or PWA built on the React platform (same codebase, shared Firebase backend) — **not Flutter**

**Effort:** ~3–4 weeks for a full migration.

---

#### T4-B: Tournament Operations Module
**Scope:**
- Tournament-scoped game schedule
- Multiple fields simultaneously
- Rain delay management
- Real-time field swap broadcast
- Tournament director role

**Prerequisite:** Availability management (T1-C) and check-in (T1-D/T2-C) must be stable first.

---

## Recommended Build Order

```
NOW (Tier 1)
  T1-A  PWA Installability            — manifest + service worker
  T1-B  Push Notification UI          — FCM token request + admin broadcast
  T1-C  Availability Management       — new page + admin assign integration
  T1-D  Day-of Quick Actions          — sticky bar on schedule.html
  T1-E  Mobile Bottom Tabs            — tabs.js + styles

NEXT (Tier 2)
  T2-B  Payroll CSV Export            — easiest, pure JS, standalone
  T2-A  Admin Announcements           — new collection + home page render
  T2-C  Check-In (admin view)         — extends T1-D
  T2-E  Umpire Earnings Page          — new page, umpire-facing payroll

LATER (Tier 2/3)
  T2-D  Enhanced Incident Reports     — Firebase Storage needed
  T3-A  Google Sign-In
  T3-B  Weather Integration
  T3-C  Profile Enhancements
  T3-E  Analytics Dashboard

LONG TERM (Tier 3/4)
  T3-D  Rule Search / AI Assistant
  T4-A  React Migration (+ React Native mobile long-term)
  T4-B  Tournament Module
```

---

## Key Firestore Schema Additions Required

| Item | New Collection / Field |
|---|---|
| T1-C Availability | `availability/{uid}.ranges: [{from, to, reason}]` |
| T1-D Check-in | `games/{id}.umpireSlots[].checkedIn`, `.checkedInAt` |
| T2-A Announcements | `announcements/{id}` — `{title, body, postedBy, postedAt, active}` |
| T2-D Incidents (photos) | `incidentReports/{id}.photoUrls: string[]` |
| T3-C Profile extras | `umpires/{uid}.maxGamesPerWeek`, `.equipment`, `.certifications` |

---

## Files That Will Change Most

| File | Tiers |
|---|---|
| `schedule.js` / `schedule.html` | T1-D, T2-C |
| `index.html` / `index.js` | T2-A, T1-B (notif UI) |
| `auth.js` | T1-B, T3-A |
| `admin.js` / `admin.html` | T2-A, T3-E |
| `admin-games.js` | T1-C (availability check), T2-C |
| `firestore.rules` | T1-C, T2-A, T2-D |
| `styles.css` | T1-E (mobile tabs), T1-D (sticky bar) |
| `functions/index.js` | T1-B (broadcast function) |
