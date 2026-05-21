# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Deploy Commands

```bash
# Deploy hosting only (most common — HTML/JS/CSS changes)
firebase deploy --only hosting

# Deploy Firestore rules
firebase deploy --only firestore:rules

# Deploy Cloud Functions
firebase deploy --only functions

# Deploy everything
firebase deploy

# Set email secrets for Cloud Functions
firebase functions:secrets:set GMAIL_USER
firebase functions:secrets:set GMAIL_PASS
```

There is no build step. All JS is vanilla ES modules served directly by Firebase Hosting. No bundler, no transpiler, no `npm install` needed for the frontend.

For Cloud Functions (`functions/` directory): Node 22, CommonJS (`require`). No build step needed there either — deploy runs them directly.

---

## Architecture Overview

**Vanilla JS multi-page app** hosted on Firebase Hosting. No framework, no bundler. Each page is an HTML file + a paired JS module. Firebase SDK is loaded directly from CDN (`https://www.gstatic.com/firebasejs/10.12.0/`).

### Shared modules (loaded by most pages)

| File | Purpose |
|---|---|
| `firebase.js` | Firebase app init — exports `db`, `auth`, `app`, `messaging`, `storage` |
| `auth.js` | Auth state, role resolution, hamburger menu, `authReadyPromise` |
| `org.js` | Org settings from Firestore `config/org`; patches `data-org-*` attributes site-wide |
| `utils.js` | `esc()`, `fmtDate()`, `fmtTime()`, `todayISO()`, `setMsg()`, `showToast()`, `showConfirm()` |
| `nav.js` | Injects top nav HTML based on auth role; single source of truth for nav links |
| `tabs.js` | Injects mobile bottom tab bar |
| `pwa.js` | Service worker registration, stale-page reload, install prompt, pull-to-refresh, swipe-down modal dismiss, left-edge back swipe |
| `facilities.js` | Shared facility lookup, shed-code cache (`getFacilities`, `getShedCodes`, `matchFacility`), and `showShedCodeDialog` |
| `cal.js` | Client-side ICS generation |
| `slack-webhooks.js` | Client-side Slack notification helpers |

### Auth pattern

**Always use `authReadyPromise` instead of raw `onAuthStateChanged`** in page JS files. `auth.js` registers its own `onAuthStateChanged` that does async Firestore reads (`umpires/{uid}`, `admins/{uid}`, `coaches/{uid}`) to resolve roles before `authReadyPromise` resolves. Using raw `onAuthStateChanged` in a page fires before those reads complete, so `isAdmin()` / `isApproved()` return false.

```js
import { authReadyPromise, isAdmin, isApproved, getCurrentUser } from "./auth.js";

authReadyPromise.then(() => {
  const user = getCurrentUser();
  // isAdmin() and isApproved() are now reliable
});
```

Roles: `isAdmin()`, `isApproved()` (approved umpire), `isSuperAdmin()`, `isCoach()`, `isLoggedIn()`.

### Firestore collections

| Collection | Description |
|---|---|
| `games/{id}` | Game records. Key fields: `date` (YYYY-MM-DD string), `time` (HH:MM string), `city`, `division`, `league`, `field`, `facilityId`, `umpireSlots[]`, `needsUmpires`, `cancelled`, `isAway` |
| `umpires/{uid}` | Umpire profiles. Key fields: `approved`, `active`, `name`, `email` |
| `admins/{uid}` | Admin records. `superAdmin: bool`, `roles: string[]` (empty = super admin) |
| `config/payRates` | `plate`, `field`, `extra` pay rates |
| `config/org` | Org settings (name, coordinator, divisions, etc.) |
| `facilities/{id}` | Facility info: `name`, `fields: [{name, notes}]`, `address`, `lat`, `lng` |
| `facilityCodes/{id}` | Shed codes keyed by facility ID |
| `availability/{uid}` | Umpire unavailable dates |
| `cancellationRequests/{id}` | Umpire slot cancellation requests pending admin approval |
| `announcements/{id}` | Active announcements shown on home page |
| `leagues/{id}` | League/program names |

### `umpireSlots` schema (inside `games` documents)

```js
umpireSlots: [
  {
    type: "Plate" | "Field" | "Extra",
    payRate: number,
    assignedUid: string | null,
    assignedName: string | null,
    checkedIn: boolean,
    checkedInAt: string | null,   // ISO timestamp
    paid: boolean,
  }
]
```

### Firestore security rules pattern

Umpires may only update `umpireSlots` and `needsUmpires` on non-cancelled games:
```
allow update: if isAdmin() ||
  (isApproved() &&
   resource.data.get('cancelled', false) != true &&
   request.resource.data.diff(resource.data).affectedKeys().hasOnly(['umpireSlots', 'needsUmpires']));
```

### Asset versioning

All JS and CSS `<script>`/`<link>` tags use `?v=N` query strings (e.g. `schedule.js?v=31`). **Bump the version number whenever you change a file** — Firebase Hosting serves with `no-cache` headers but browsers and the service worker skip cache based on the full URL including query string. The service worker intentionally bypasses cache for any URL containing `?v=`.

### Cloud Functions (`functions/index.js`)

CommonJS. Key functions:
- `notifyGameCancellation` — HTTPS callable; sends push + email to assigned umpires
- `notifyOpenSlots` — HTTPS callable; sends push + Slack to all umpires about open slots  
- `onGameSlotChanged` — Firestore trigger on `games/{gameId}`; detects admin assignments/removals and notifies affected umpires
- `sendDayOfReminders` — scheduled (cron); sends morning push + Slack for today's games
- `generateIcs` — HTTPS function for calendar subscription

Email uses Gmail via Nodemailer. Secrets stored in Firebase Secret Manager (`GMAIL_USER`, `GMAIL_PASS`). **Always call `buildTransport()` inline inside the function** — never at module level, because secrets aren't available at module init time.

### Admin pages

All admin pages (`admin-*.html`) share the same pattern:
- Auth gate: `authReadyPromise.then(() => { if (!isAdmin()) show #noAccess; })`
- Subnav: `<nav class="admin-subnav">` block — preserved on all admin pages
- Super-admin-only features guarded by `isSuperAdmin()`

### PWA / Service Worker

`firebase-messaging-sw.js` is the combined FCM + app shell service worker. Key behaviors:
- Navigation requests: network-first, cache as offline fallback
- `?v=` versioned assets: network-first, no caching
- Static assets (logo, manifest): cache-first
- On SW activate: posts `SW_ACTIVATED` to open clients → `pwa.js` triggers `location.reload()`
- Stale-page detection in `pwa.js`: reloads if app was backgrounded >10 min (fixes iOS PWA restore)

`CACHE_NAME` is `tvu-shell-vN` — bump N in `firebase-messaging-sw.js` to force all clients to drop stale caches on next visit.

### `org.js` / `data-org-*` pattern

Any HTML element with `data-org-text="fieldName"` or `data-org-color="fieldName"` is automatically patched when org settings load. This lets coordinator name, phone, accent color, etc. be updated from Firestore without touching HTML.

Divisions select elements with `data-org-divisions` are auto-populated from `config/org.activeDivisions`.

---

## Key Conventions

- **HTML escaping**: always use `esc()` from `utils.js` when interpolating user/Firestore data into innerHTML strings
- **`fmtDate()`** handles ISO strings, JS Dates, and Firestore Timestamps — pass any of the three
- **Firestore writes from umpires**: transaction-based for slot claims/check-ins to prevent race conditions
- **CSP**: `script-src` does not include `'unsafe-inline'` — never use `onclick="..."` in innerHTML; use `data-*` attributes + event delegation instead
- **Long-term stack**: stay vanilla JS now; React + React Native is the planned future migration (Flutter is explicitly ruled out)
