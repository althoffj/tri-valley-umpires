const { onSchedule }                  = require("firebase-functions/v2/scheduler");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten }           = require("firebase-functions/v2/firestore");
const { defineSecret }                = require("firebase-functions/params");
const { initializeApp }               = require("firebase-admin/app");
const { getFirestore, FieldValue }    = require("firebase-admin/firestore");
const { getMessaging }                = require("firebase-admin/messaging");
const { getAuth }                     = require("firebase-admin/auth");
const https     = require("https");
const nodemailer = require("nodemailer");

initializeApp();

const APP_URL = "https://tri-valley-baseball-umpires.web.app";

// ── Email secrets (set via: firebase functions:secrets:set GMAIL_USER / GMAIL_PASS) ──
const GMAIL_USER = defineSecret("GMAIL_USER");
const GMAIL_PASS = defineSecret("GMAIL_PASS");

// ── Email helper ──────────────────────────────────────────────────────────────

function buildTransport() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER.value(), pass: GMAIL_PASS.value() },
  });
}

/**
 * Build a role-aware welcome email for a new admin.
 * @param {string} name        Display name of the new admin
 * @param {string} email       Their email address
 * @param {boolean} isSA       Whether they're a super admin
 * @param {string[]} roles     Granted role keys (empty if super admin)
 * @param {boolean} isNew      True if a brand-new Firebase Auth account was created
 * @param {string|null} resetLink  One-time password-setup URL (only for new accounts)
 */
function buildAdminWelcomeEmail({ name, email, isSA, roles, isNew, resetLink }) {
  const APP_URL   = "https://tri-valley-baseball-umpires.web.app";
  const ADMIN_URL = `${APP_URL}/admin.html`;

  // ── Access section ──────────────────────────────────────────────────────────
  const ROLE_DESCRIPTIONS = {
    games:       { label: "Games",       detail: "Manage the game schedule — add, edit, cancel, delete games, and sync from team calendars." },
    umpires:     { label: "Umpires",     detail: "View the umpire roster, approve or deny new registrations, and revoke existing access." },
    payroll:     { label: "Payroll",     detail: "View payroll summaries, filter by date or umpire, and mark game slots as paid." },
    config:      { label: "Config",      detail: "Set system-wide defaults: plate/field/extra pay rates and default umpire slot types." },
    facilities:  { label: "Facilities",  detail: "Manage ballparks and fields, update field issue statuses, and review umpire-submitted field issues." },
    tournaments: { label: "Tournaments", detail: "Create and manage tournaments, apply rain delays, swap umpire field assignments, and update tournament status." },
  };

  let accessHtml;
  if (isSA) {
    accessHtml = `
      <p style="margin:0 0 10px"><strong>Access level: Super Admin</strong> — full unrestricted access to every section.</p>
      <table style="border-collapse:collapse;width:100%">
        ${Object.values(ROLE_DESCRIPTIONS).map(r => `
          <tr>
            <td style="padding:6px 10px;border-bottom:1px solid #333;font-weight:bold;white-space:nowrap;vertical-align:top">${r.label}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #333;color:#ccc">${r.detail}</td>
          </tr>`).join("")}
        <tr>
          <td style="padding:6px 10px;font-weight:bold;white-space:nowrap;vertical-align:top">+ Super Admin</td>
          <td style="padding:6px 10px;color:#ccc">Manually assign umpires to game slots · Manage announcements · Add/remove admins and set their permissions · Delete umpire accounts</td>
        </tr>
      </table>`;
  } else if (roles.length === 0) {
    accessHtml = `<p style="margin:0;color:#f5a623">Your account has been created but no permissions have been granted yet. Contact a super admin to have your roles configured.</p>`;
  } else {
    const granted = roles.map(key => ROLE_DESCRIPTIONS[key]).filter(Boolean);
    accessHtml = `
      <p style="margin:0 0 10px"><strong>Access level: Admin</strong> — access to the sections listed below.</p>
      <table style="border-collapse:collapse;width:100%">
        ${granted.map(r => `
          <tr>
            <td style="padding:6px 10px;border-bottom:1px solid #333;font-weight:bold;white-space:nowrap;vertical-align:top">${r.label}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #333;color:#ccc">${r.detail}</td>
          </tr>`).join("")}
      </table>`;
  }

  // ── Sign-in section ─────────────────────────────────────────────────────────
  let signinHtml;
  if (!isNew) {
    signinHtml = `<p style="margin:0">Sign in with your existing account at <a href="${ADMIN_URL}" style="color:#7ec8f7">${ADMIN_URL}</a>. Your admin panel will appear automatically once signed in.</p>`;
  } else if (resetLink) {
    signinHtml = `
      <p style="margin:0 0 8px">Your account is ready. Use the button below to set your password — <strong>this link expires after one use.</strong></p>
      <p style="margin:0 0 12px">
        <a href="${resetLink}" style="display:inline-block;background:#601929;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:1rem">Set Your Password →</a>
      </p>
      <p style="margin:0 0 6px;font-size:0.85em;color:#aaa">Or copy this link into your browser:</p>
      <p style="margin:0;font-size:0.75em;color:#888;word-break:break-all;font-family:monospace">${resetLink}</p>
      <p style="margin:10px 0 0;font-size:0.85em;color:#aaa">If the link has expired, visit <a href="${APP_URL}" style="color:#7ec8f7">${APP_URL}</a> and click <strong>"Forgot Password"</strong>.</p>`;
  } else {
    // Link generation failed — give clear manual instructions
    signinHtml = `
      <p style="margin:0 0 8px">Your account has been created. To set your password:</p>
      <ol style="margin:0 0 8px;padding-left:20px;color:#ccc">
        <li>Go to <a href="${APP_URL}" style="color:#7ec8f7">${APP_URL}</a></li>
        <li>Click <strong>"Sign In"</strong> then <strong>"Forgot Password"</strong></li>
        <li>Enter <strong>${email}</strong> and check your inbox for a reset email</li>
      </ol>`;
  }

  // ── Full HTML email ─────────────────────────────────────────────────────────
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d0d1a;font-family:Arial,sans-serif;color:#e0e0e0">
  <table style="max-width:600px;margin:32px auto;border-radius:10px;overflow:hidden;border:1px solid #2a2a4a">
    <!-- Header -->
    <tr><td style="background:#601929;padding:24px 28px">
      <h1 style="margin:0;color:#fff;font-size:1.4rem">⚾ Tri-Valley Baseball Umpires</h1>
      <p style="margin:6px 0 0;color:#ffb0b0;font-size:0.9rem">Admin Access Granted</p>
    </td></tr>

    <!-- Greeting -->
    <tr><td style="background:#1a1a2e;padding:24px 28px">
      <p style="margin:0 0 12px">Hi ${name || email},</p>
      <p style="margin:0">You've been added as an administrator for the <strong>Tri-Valley Baseball Umpires</strong> platform. Below is a summary of your access and how to sign in.</p>
    </td></tr>

    <!-- Sign-in -->
    <tr><td style="background:#12122a;padding:20px 28px;border-top:1px solid #2a2a4a">
      <h2 style="margin:0 0 12px;font-size:1rem;color:#7ec8f7;text-transform:uppercase;letter-spacing:0.05em">Sign In</h2>
      ${signinHtml}
    </td></tr>

    <!-- Access -->
    <tr><td style="background:#1a1a2e;padding:20px 28px;border-top:1px solid #2a2a4a">
      <h2 style="margin:0 0 12px;font-size:1rem;color:#7ec8f7;text-transform:uppercase;letter-spacing:0.05em">Your Access</h2>
      ${accessHtml}
    </td></tr>

    <!-- Admin panel link -->
    <tr><td style="background:#12122a;padding:20px 28px;border-top:1px solid #2a2a4a">
      <h2 style="margin:0 0 10px;font-size:1rem;color:#7ec8f7;text-transform:uppercase;letter-spacing:0.05em">Admin Panel</h2>
      <p style="margin:0 0 12px">Once signed in, navigate to the admin panel from the hamburger menu in the top-right corner of any page, or go directly to:</p>
      <a href="${ADMIN_URL}" style="display:inline-block;background:#1e3a5f;color:#7ec8f7;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold">${ADMIN_URL}</a>
    </td></tr>

    <!-- Footer -->
    <tr><td style="background:#0d0d1a;padding:16px 28px;border-top:1px solid #2a2a4a;font-size:0.82rem;color:#666">
      <p style="margin:0">Questions? Contact Jeff Althoff: <a href="tel:6053800229" style="color:#7ec8f7">605-380-0229</a></p>
      <p style="margin:4px 0 0">This message was sent automatically because you were added as an admin. If this was a mistake, contact a super admin.</p>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Hi ${name || email},`,
    ``,
    `You've been added as an administrator for Tri-Valley Baseball Umpires.`,
    ``,
    !isNew
      ? `Sign in at: ${ADMIN_URL}`
      : resetLink
        ? `Set your password here (expires after one use):\n${resetLink}\n\nOr copy into your browser if the button above doesn't work.\n\nIf the link has expired, visit ${APP_URL} and click "Forgot Password".`
        : `Your account was created with email: ${email}\nTo set your password: go to ${APP_URL}, click "Sign In" then "Forgot Password", and enter your email.`,
    ``,
    `Access level: ${isSA ? "Super Admin (full access)" : roles.length ? roles.join(", ") : "No roles assigned yet"}`,
    ``,
    `Admin panel: ${ADMIN_URL}`,
    ``,
    `Questions? Contact Jeff Althoff: 605-380-0229`,
  ].join("\n");

  return {
    from:    `"Tri-Valley Baseball Umpires" <${GMAIL_USER.value()}>`,
    to:      email,
    subject: "You've been added as a Tri-Valley Baseball Umpires admin",
    text,
    html,
  };
}

// ── CORS allowlist ────────────────────────────────────────────────────────────
const CORS = ["https://tri-valley-baseball-umpires.web.app", "https://tri-valley-baseball-umpires.firebaseapp.com"];

// ── ICS fetch (server-side, no CORS restrictions) ─────────────────────────────

function fetchICS(rawUrl, redirects = 3) {
  const url = rawUrl.replace(/^webcal:\/\//i, "https://");
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.get({
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      headers:  { "User-Agent": "TriValleyUmpires/1.0 calendar-sync" }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        fetchICS(res.headers.location, redirects - 1).then(resolve).catch(reject);
        return;
      }
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}`));
        else resolve(data);
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ── ICS parser ────────────────────────────────────────────────────────────────

/**
 * Parse a DTSTART value into { date, time } in America/Chicago local time.
 *
 * ICS files from GameChanger store times as UTC (ending with "Z").
 * e.g. a 6:30 PM CDT game → DTSTART:20260513T233000Z
 * Without conversion this would store as "23:30" — 5 hours wrong.
 *
 * Handles three RFC 5545 forms:
 *   DTSTART:20260513T233000Z          → UTC, convert to Central
 *   DTSTART;TZID=America/Chicago:...T183000  → already local, use as-is
 *   DTSTART:20260513                  → all-day, no time
 */
function parseDTStart(dtstart) {
  const dateM = dtstart.match(/(\d{4})(\d{2})(\d{2})/);
  if (!dateM) return { date: "", time: "" };

  const timeM = dtstart.match(/T(\d{2})(\d{2})/);

  if (timeM && dtstart.endsWith("Z")) {
    // UTC datetime — convert to America/Chicago (handles CDT/CST automatically)
    const utcMs = Date.UTC(
      parseInt(dateM[1]), parseInt(dateM[2]) - 1, parseInt(dateM[3]),
      parseInt(timeM[1]), parseInt(timeM[2])
    );
    const d = new Date(utcMs);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone:  "America/Chicago",
      year:      "numeric",
      month:     "2-digit",
      day:       "2-digit",
      hour:      "2-digit",
      minute:    "2-digit",
      hour12:    false
    }).formatToParts(d);
    const p = type => parts.find(x => x.type === type)?.value ?? "00";
    // Intl can return "24" for midnight in some environments — normalise to "00"
    const hour = p("hour") === "24" ? "00" : p("hour");
    return {
      date: `${p("year")}-${p("month")}-${p("day")}`,
      time: `${hour}:${p("minute")}`
    };
  }

  // Non-UTC (TZID-qualified or floating) — treat digits as already local
  return {
    date: `${dateM[1]}-${dateM[2]}-${dateM[3]}`,
    time: timeM ? `${timeM[1]}:${timeM[2]}` : ""
  };
}

/**
 * Correct the isAway flag from the perspective of a specific subscribed team.
 * GameChanger SUMMARY format: "Away Team @ Home Team"
 * parseVEvents always sets isAway=true for the @ format, but that is only right
 * when the subscribed team is the away team.  This function re-resolves the flag
 * by fuzzy-matching team names.
 *
 * Returns true  — subscribed team is the away team
 *         false — subscribed team is the home team
 *         parsedValue — neither name matches (fall back to parsed value)
 */
function resolveIsAway(teamName, homeTeam, awayTeam, parsedValue) {
  if (!teamName || (!homeTeam && !awayTeam)) return parsedValue;
  const t = teamName.toLowerCase().trim();
  const matchAway = awayTeam && (awayTeam.toLowerCase().trim().includes(t) || t.includes(awayTeam.toLowerCase().trim()));
  const matchHome = homeTeam && (homeTeam.toLowerCase().trim().includes(t) || t.includes(homeTeam.toLowerCase().trim()));
  if (matchAway && !matchHome) return true;
  if (matchHome && !matchAway) return false;
  return parsedValue; // ambiguous — keep whatever parseVEvents decided
}

/**
 * Look up a facilityId from an ICS LOCATION string by checking each known city
 * keyword against the location text.  Returns the facilityId or "".
 */
function facilityIdFromLocation(location, facilityByCity) {
  if (!location || !facilityByCity) return "";
  const loc = location.toLowerCase();
  for (const [city, id] of Object.entries(facilityByCity)) {
    const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(loc)) return id;
  }
  return "";
}

function parseVEvents(icsText) {
  // Unfold continuation lines (RFC 5545: line starting with space/tab continues previous)
  const unfolded = icsText.replace(/\r?\n[ \t]/g, "");
  const events = [];
  const blocks = unfolded.split(/BEGIN:VEVENT/i);

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const get = key => {
      const re = new RegExp(`^${key}[^:\r\n]*:([^\r\n]+)`, "im");
      const m = block.match(re);
      return m ? m[1].trim() : "";
    };

    const dtstart  = get("DTSTART");
    const location = get("LOCATION");
    const uid      = get("UID");
    const summary  = get("SUMMARY");

    const { date, time } = parseDTStart(dtstart);
    const dtend = get("DTEND");
    const { time: endTime } = parseDTStart(dtend);
    if (!date) continue;

    // Parse home/away from SUMMARY (GameChanger formats: "Away @ Home" or "Home vs Away")
    // "Team A @ Team B" means Team A is visiting Team B — A is away, B is home.
    let homeTeam = "", awayTeam = "", isAway = false;
    if (summary) {
      const atMatch  = summary.match(/^(.+?)\s+@\s+(.+)$/);
      const vsMatch  = summary.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
      if (atMatch) {
        awayTeam = atMatch[1].trim(); // team before @ is the visiting/away team
        homeTeam = atMatch[2].trim(); // team after @ is the host/home team
        isAway   = true;
      } else if (vsMatch) {
        homeTeam = vsMatch[1].trim();
        awayTeam = vsMatch[2].trim();
      }
    }

    events.push({ date, time, endTime, location, uid, summary, homeTeam, awayTeam, isAway });
  }
  return events;
}

// ── Practice detection ────────────────────────────────────────────────────────

/**
 * Returns true if the SUMMARY field looks like a practice, workout, or other
 * non-game event that should be stored in the `practices` collection, not `games`.
 */
function isPracticeEvent(summary) {
  return /\bpractice\b|\bworkout\b|\btraining\b/i.test(summary || "");
}

// ── Core sync logic ───────────────────────────────────────────────────────────

function todayISO() {
  // Cloud Functions run in UTC — use America/Chicago to match the league's local date
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
}

/**
 * Returns the umpire slot types that should be created for a given division.
 * Checks config/payRates.divisionSlotTypes for a per-division override first,
 * then falls back to defaultSlotTypes.  A division mapped to [] means no slots.
 */
function getSlotTypesForDivision(division, rates) {
  const overrides = rates.divisionSlotTypes || {};
  if (division && Object.prototype.hasOwnProperty.call(overrides, division)) {
    return overrides[division]; // may be [] — intentional
  }
  return (rates.defaultSlotTypes && rates.defaultSlotTypes.length)
    ? rates.defaultSlotTypes
    : ["Plate", "Field"];
}

/**
 * Build a fresh umpire slot object for each slot type.
 * Used everywhere a game needs new (unassigned) slots created.
 */
function makeUmpireSlots(slotTypes, rateMap) {
  return slotTypes.map(t => ({
    type: t, assignedUid: null, assignedName: null,
    payRate: rateMap[t] || 0, checkedIn: false, checkedInAt: null, paid: false, noShow: false,
  }));
}

function inferDivision(teamName) {
  if (/10U/i.test(teamName)) return "10U";
  if (/12U/i.test(teamName)) return "12U";
  if (/14U/i.test(teamName)) return "14U";
  if (/HS\s*JV/i.test(teamName)) return "HS JV";
  if (/HS/i.test(teamName)) return "HS Varsity";
  return "Other";
}

async function runSync() {
  const db = getFirestore();

  const teamsSnap = await db.doc("config/teamCalendars").get();
  const teams     = teamsSnap.exists ? (teamsSnap.data().teams || []) : [];
  if (teams.length === 0) return { added: 0, linked: 0, flagged: 0, failed: 0 };

  // Load all existing games, practices, pay rates, and facilities in parallel
  const [gamesSnap, practicesSnap, ratesSnap, facilitiesSnap] = await Promise.all([
    db.collection("games").get(),
    db.collection("practices").get(),
    db.doc("config/payRates").get(),
    db.collection("facilities").get(),
  ]);

  // Pay-rate config for auto-creating home-game umpire slots
  const rates   = ratesSnap.exists ? ratesSnap.data() : {};
  const rateMap = { Plate: rates.plate || 0, Field: rates.field || 0, Extra: rates.extra || 0 };

  // Build city → facilityId map dynamically from all facilities.
  // Extracts city from address format "Street, City, SD XXXXX[, USA]".
  const facilityByCity = {};
  facilitiesSnap.forEach(d => {
    const data = d.data();
    const addr = (data.address || "").toLowerCase().trim();
    if (addr) {
      const parts = addr.split(",").map(s => s.trim());
      // "SD" or "South Dakota" segment — city is the segment before it
      const sdIdx = parts.findIndex(p => /^s\.?d\.?\b|^south\s+dakota\b/.test(p));
      if (sdIdx > 0) {
        const city = parts[sdIdx - 1];
        if (city) facilityByCity[city] = d.id;
      }
    }
  });
  // Team name → config object for metadata lookups throughout the sync
  const teamByName = {};
  for (const t of teams) { if (t.name) teamByName[t.name] = t; }

  const existingExtIds         = new Set(gamesSnap.docs.map(d => d.data().externalId).filter(Boolean));
  const existingPracticeExtIds = new Set(practicesSnap.docs.map(d => d.data().externalId).filter(Boolean));
  const linkedUids        = new Set();
  const cityGames         = [];
  for (const d of gamesSnap.docs) {
    const g = d.data();
    if (g.source === "city-schedule") {
      cityGames.push({ ref: d.ref, ...g });
      (g.icsLinks || []).forEach(l => linkedUids.add(l.uid));
    }
  }

  const today = todayISO();

  // Build externalId → docRef map for existing calendar games (enables time correction below)
  const extIdToDoc = {};
  for (const d of gamesSnap.docs) {
    const g = d.data();
    if (g.externalId && g.source === "calendar") extIdToDoc[g.externalId] = d;
  }

  // Fetch ALL team feeds; build reference games + divDate map for city-schedule matching
  const eventsByDivDate = {}; // "DIVISION|DATE" → [{uid, teamName, location}]
  let added = 0, corrected = 0, failed = 0;

  // Pre-fetch all ICS feeds in parallel — avoids N serial network round-trips
  const icsResults = await Promise.allSettled(teams.map(t => fetchICS(t.icsUrl)));

  // Collect all Firestore writes during event processing, then execute in parallel
  const toDelete      = []; // document refs to delete
  const toPracticeAdd = []; // plain objects to batch-add to practices
  const toGamePatch   = []; // { ref, patch } to update in parallel
  const toGameAdd     = []; // plain objects to batch-add to games

  for (let ti = 0; ti < teams.length; ti++) {
    const team = teams[ti];
    const icsResult = icsResults[ti];
    if (icsResult.status === "rejected") {
      console.error(`Failed: ${team.name}: ${icsResult.reason?.message}`); failed++; continue;
    }
    const icsText = icsResult.value;

    const division = inferDivision(team.name);

    for (const ev of parseVEvents(icsText)) {
      if (!ev.uid) continue;
      if (!ev.date || ev.date < today) continue; // never add or modify past events
      // Correct isAway from the subscribed team's perspective
      ev.isAway = resolveIsAway(team.name, ev.homeTeam, ev.awayTeam, ev.isAway);
      // Location-based override: if the game is at the team's home city it is always a home game,
      // regardless of how the summary was formatted or whether name-matching was ambiguous.
      if (team.city && ev.location && ev.location.toLowerCase().includes(team.city.toLowerCase())) {
        ev.isAway = false;
      }

      // ── Route practice events to `practices` collection ─────────────────────
      if (isPracticeEvent(ev.summary)) {
        // Clean up any stale reference game that was mistakenly created for this externalId
        if (existingExtIds.has(ev.uid)) {
          const staleDoc = gamesSnap.docs.find(d =>
            d.data().externalId === ev.uid && d.data().needsUmpires === false
          );
          if (staleDoc) {
            toDelete.push(staleDoc.ref);
            existingExtIds.delete(ev.uid);
            console.log(`Will delete stale game entry for practice externalId: ${ev.uid}`);
          }
        }
        if (!existingPracticeExtIds.has(ev.uid)) {
          toPracticeAdd.push({
            teamName:   team.name,
            date:       ev.date,
            startTime:  ev.time || "",
            endTime:    "",
            field:      (ev.location || "").split(",")[0].trim(),
            source:     "calendar",
            externalId: ev.uid,
            createdAt:  FieldValue.serverTimestamp(),
          });
          existingPracticeExtIds.add(ev.uid);
          added++;
        }
        continue; // never add to games
      }

      // Build divDate map (all divisions — used for matching below)
      const key = `${division}|${ev.date}`;
      if (!eventsByDivDate[key]) eventsByDivDate[key] = [];
      if (!eventsByDivDate[key].some(e => e.uid === ev.uid))
        eventsByDivDate[key].push({ uid: ev.uid, teamName: team.name, location: ev.location, homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, isAway: ev.isAway });

      if (existingExtIds.has(ev.uid) || linkedUids.has(ev.uid)) {
        // Self-healing: correct date/time and isAway on existing future calendar games
        const existingDoc = extIdToDoc[ev.uid];
        if (existingDoc && ev.date >= today) {
          const eData = existingDoc.data();
          // Never silently change time/date if umpires are already involved — admin must update manually
          const hasUmpires = eData.needsUmpires === true || (eData.umpireSlots || []).some(s => s.assignedUid);
          const patch = {};
          if (!hasUmpires) {
            if (eData.time !== ev.time) patch.time = ev.time;
            if (eData.date !== ev.date) patch.date = ev.date;
          }
          // Cosmetic fields are always safe to correct
          if ((eData.isAway || false) !== ev.isAway) patch.isAway = ev.isAway;
          if (eData.homeTeam !== ev.homeTeam)        patch.homeTeam = ev.homeTeam;
          if (eData.awayTeam !== ev.awayTeam)        patch.awayTeam = ev.awayTeam;
          if (Object.keys(patch).length) {
            toGamePatch.push({ ref: existingDoc.ref, patch });
            corrected++;
          }
        }
        continue;
      }

      // Queue new game document.
      // Home games for a team that has needsUmpireForHome configured are created as
      // first-class city-schedule games so umpires can sign up immediately.
      // Away games, teams without a city, and teams without needsUmpireForHome remain
      // as lightweight reference entries.
      //
      // Duplicate guard: if a city-schedule game already exists for this division+date
      // (entered by admin or created by an earlier sync pass), skip the add — the
      // city-schedule matching loop below will link this ICS event to that game.
      const isHomeWithCity = !ev.isAway && team.city && team.needsUmpireForHome;
      const cityScheduleExists = isHomeWithCity &&
        cityGames.some(g => g.division === division && g.date === ev.date);
      if (isHomeWithCity && cityScheduleExists) {
        // A city-schedule game already exists for this division+date.
        // The city-schedule matching loop below will link this ICS event to it.
        // No new document needed — just fall through to the existingExtIds.add() below.
      } else if (isHomeWithCity) {
        // Home game with umpires needed and no existing city-schedule entry → create one.
        const fieldName  = (ev.location || "").split(",")[0].trim();
        const facilityId = facilityIdFromLocation(ev.location, facilityByCity);
        const league     = (team.leagueNames && team.leagueNames.length)
          ? team.leagueNames[0]
          : (team.leagueName || "");
        const slotTypes = getSlotTypesForDivision(division, rates);
        toGameAdd.push({
          teamName:     team.name,
          division,
          city:         team.city,
          league,
          facilityId,
          date:         ev.date,
          time:         ev.time,
          field:        fieldName,
          location:     ev.location,
          homeTeam:     ev.homeTeam,
          awayTeam:     ev.awayTeam,
          isAway:       false,
          type:         "Regular",
          needsUmpires: slotTypes.length > 0,
          umpireSlots:  makeUmpireSlots(slotTypes, rateMap),
          icsLinks:     [{ uid: ev.uid, teamName: team.name }],
          cancelled:    false,
          externalId:   ev.uid,
          source:       "city-schedule",
          createdAt:    FieldValue.serverTimestamp()
        });
      } else {
        // Away game or no city context → lightweight reference entry only.
        toGameAdd.push({
          teamName:     team.name,
          division,
          date:         ev.date,
          time:         ev.time,
          location:     ev.location,
          homeTeam:     ev.homeTeam,
          awayTeam:     ev.awayTeam,
          isAway:       ev.isAway || false,
          needsUmpires: false,
          umpireSlots:  [],
          cancelled:    false,
          externalId:   ev.uid,
          source:       "calendar",
          createdAt:    FieldValue.serverTimestamp()
        });
      }
      existingExtIds.add(ev.uid);
      added++;
    }
  }

  // Execute all collected writes: deletes + patches in parallel, sets in chunked batches
  // (Firestore batch limit is 500 ops — chunking guards against large initial imports)
  await Promise.all([
    ...toDelete.map(ref => ref.delete()),
    ...toGamePatch.map(({ ref, patch }) => ref.update(patch)),
  ]);
  const allSets = [
    ...toPracticeAdd.map(data => ({ col: "practices", data })),
    ...toGameAdd.map(data     => ({ col: "games",     data })),
  ];
  for (let i = 0; i < allSets.length; i += 499) {
    const b = db.batch();
    allSets.slice(i, i + 499).forEach(({ col, data }) => b.set(db.collection(col).doc(), data));
    await b.commit();
  }

  // ── Match / monitor city-schedule games against ICS events ───────────────────
  let linked = 0, flagged = 0;

  // Build one merged update per city-schedule game, then execute all in parallel
  const cityUpdates = []; // { ref, update }
  for (const game of cityGames) {
    if (game.date < today || game.cancelled) continue;
    const key     = `${game.division}|${game.date}`;
    const matches = eventsByDivDate[key] || [];
    const gameUpdate = {};

    if (!game.icsLinks || game.icsLinks.length === 0) {
      if (matches.length > 0) {
        gameUpdate.icsLinks = matches.map(e => ({ uid: e.uid, teamName: e.teamName }));
        // Copy team names and away flag from first matching ICS event if not already set
        const first = matches[0];
        if (!game.homeTeam && first.homeTeam) gameUpdate.homeTeam = first.homeTeam;
        if (!game.awayTeam && first.awayTeam) gameUpdate.awayTeam = first.awayTeam;
        if (first.isAway !== undefined && (game.isAway || false) !== first.isAway) gameUpdate.isAway = first.isAway;
        linked++;
      }
    } else {
      const liveUids = new Set(matches.map(e => e.uid));
      const missing  = game.icsLinks.filter(l => !liveUids.has(l.uid));
      if (missing.length > 0 && !game.possibleChange) {
        gameUpdate.possibleChange = true; flagged++;
      } else if (missing.length === 0 && game.possibleChange) {
        gameUpdate.possibleChange = false;
      }
      // Pick up team names, location, and away flag if GameChanger fills them in later
      const locatedMatch = matches.find(e => !!facilityIdFromLocation(e.location, facilityByCity));
      // Only fill in field if not already set; take just the first segment of the ICS
      // location string ("West Field, Colton, SD" → "West Field"), not the full address.
      // Also self-heal games where the full address was previously written as the field.
      if (locatedMatch) {
        const fieldName = locatedMatch.location.split(",")[0].trim();
        if (!game.field || game.field.includes(",")) {
          gameUpdate.field = fieldName;
        }
      }
      const namedMatch = matches.find(e => e.homeTeam);
      if (namedMatch && !game.homeTeam) {
        gameUpdate.homeTeam = namedMatch.homeTeam;
        gameUpdate.awayTeam = namedMatch.awayTeam;
      }
      // Always sync isAway from the ICS match (away status can change if schedule changes)
      const awayMatch = matches.find(e => e.isAway !== undefined);
      if (awayMatch && (game.isAway || false) !== awayMatch.isAway) gameUpdate.isAway = awayMatch.isAway;
    }

    // ── Fill in missing metadata from team config + ICS location ──────────────
    // Runs regardless of link status; safe on any city-schedule game.
    {
      const tName = (game.icsLinks?.[0]?.teamName) || (matches[0]?.teamName) || game.teamName || "";
      const t = teamByName[tName];
      if (!game.league) {
        const l = t?.leagueNames?.[0] || t?.leagueName || "";
        if (l) gameUpdate.league = l;
      }
      if (!game.city && t?.city) gameUpdate.city = t.city;
      if (!game.facilityId) {
        const locMatch = matches.find(e => !!facilityIdFromLocation(e.location, facilityByCity));
        if (locMatch) {
          const fid = facilityIdFromLocation(locMatch.location, facilityByCity);
          if (fid) gameUpdate.facilityId = fid;
        }
      }
      // Restore umpire slots if missing and team needs umpires (no assigned umpires present)
      const hasAssigned = (game.umpireSlots || []).some(s => s.assignedUid);
      if (!hasAssigned && t?.needsUmpireForHome) {
        const slotTypes = getSlotTypesForDivision(game.division, rates);
        if (slotTypes.length > 0 && (game.umpireSlots || []).length === 0) {
          gameUpdate.umpireSlots  = makeUmpireSlots(slotTypes, rateMap);
          gameUpdate.needsUmpires = true;
        }
      }
    }

    if (Object.keys(gameUpdate).length) cityUpdates.push({ ref: game.ref, update: gameUpdate });
  }
  if (cityUpdates.length > 0) {
    await Promise.all(cityUpdates.map(({ ref, update }) => ref.update(update)));
  }

  // ── Repair pass: promote existing source:"calendar" home games ───────────────
  // Handles games imported before the home-game promotion logic existed.
  // Runs on every sync so no manual button is needed.
  {
    // Build the set of division+date slots already covered by city-schedule games
    // (includes games just created above in toGameAdd).
    const coveredKeys = new Set(cityGames.map(g => `${g.division}|${g.date}`));
    for (const g of toGameAdd) {
      if (g.source === "city-schedule") coveredKeys.add(`${g.division}|${g.date}`);
    }

    const repairOps = [];
    for (const d of gamesSnap.docs) {
      const g = d.data();
      if (g.source !== "calendar") continue;
      if (!g.date || g.date < today) continue;
      if ((g.umpireSlots || []).some(s => s.assignedUid)) continue; // never touch assigned games

      const team = teamByName[g.teamName];
      if (!team || !team.needsUmpireForHome) continue;

      // Location-based home detection: if we find a known facility in the location OR
      // the location text contains the team's home city, it's a home game.
      const loc = (g.location || "").toLowerCase();
      const isAtHome = !!facilityIdFromLocation(g.location, facilityByCity) ||
                       (team.city && loc.includes(team.city.toLowerCase())) ||
                       (team.city && g.isAway !== true && !g.location); // no location — fall back to stored value
      if (!isAtHome) continue;

      const key = `${g.division}|${g.date}`;
      if (coveredKeys.has(key)) {
        // A city-schedule game already covers this slot — delete the calendar duplicate
        repairOps.push(d.ref.delete());
      } else {
        const fieldName  = (g.field && !g.field.includes(",")) ? g.field : (g.location || "").split(",")[0].trim();
        const facilityId = g.facilityId || facilityIdFromLocation(g.location, facilityByCity) || "";
        const city       = g.city || team.city || "";
        const league     = g.league || team.leagueNames?.[0] || team.leagueName || "";
        const division   = g.division || inferDivision(team.name);
        const slotTypes  = getSlotTypesForDivision(division, rates);
        // Re-derive isAway: location at home city always wins
        const correctedIsAway = (team.city && loc.includes(team.city.toLowerCase()))
          ? false
          : resolveIsAway(team.name, g.homeTeam || "", g.awayTeam || "", g.isAway || false);
        repairOps.push(d.ref.update({
          source:       "city-schedule",
          city, league, division, facilityId,
          field:        fieldName,
          isAway:       correctedIsAway,
          type:         g.type || "Regular",
          needsUmpires: slotTypes.length > 0,
          umpireSlots:  makeUmpireSlots(slotTypes, rateMap),
          ...(g.externalId && !(g.icsLinks || []).length
            ? { icsLinks: [{ uid: g.externalId, teamName: g.teamName || team.name }] }
            : {}),
        }));
        coveredKeys.add(key);
        corrected++;
      }
    }
    if (repairOps.length > 0) await Promise.all(repairOps);
  }

  // ── Slot cleanup pass: remove umpire slots from city-schedule games whose
  // team no longer needs umpires (needsUmpireForHome false/absent, or division
  // override produces zero slot types).  Never touches games with assigned
  // umpires or games in the past.
  {
    const cleanupOps = [];
    for (const d of gamesSnap.docs) {
      const g = d.data();
      if (g.source !== "city-schedule") continue;
      if (!g.date || g.date < today) continue;
      if ((g.umpireSlots || []).some(s => s.assignedUid)) continue;
      // Only clear if slots exist (avoid no-op writes)
      if (!g.needsUmpires && !(g.umpireSlots || []).length) continue;

      const team = teamByName[g.teamName];
      const slotTypes = team ? getSlotTypesForDivision(g.division, rates) : [];
      const shouldHaveSlots = team?.needsUmpireForHome && slotTypes.length > 0;

      if (!shouldHaveSlots && (g.needsUmpires || (g.umpireSlots || []).length > 0)) {
        cleanupOps.push(d.ref.update({ umpireSlots: [], needsUmpires: false }));
      }
    }
    if (cleanupOps.length > 0) {
      console.log(`Slot cleanup: removing slots from ${cleanupOps.length} game(s)`);
      await Promise.all(cleanupOps);
    }
  }

  await db.doc("config/syncState").set(
    { lastSyncedAt: FieldValue.serverTimestamp(), lastResult: { added, linked, flagged, failed } },
    { merge: true }
  );
  console.log(`Sync: ${added} added, ${corrected} times corrected, ${linked} linked, ${flagged} flagged, ${failed} failed`);
  return { added, corrected, linked, flagged, failed };
}

// ── Scheduled: runs every 6 hours automatically ───────────────────────────────

exports.syncGamesScheduled = onSchedule("every 6 hours", async () => {
  await runSync();
});

// ── Scheduling Assistant helpers ──────────────────────────────────────────────

function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

function gamesOverlap(g1, g2, durMap) {
  if (g1.date !== g2.date) return false;
  const f1 = (g1.field || "").trim().toLowerCase();
  const f2 = (g2.field || "").trim().toLowerCase();
  if (!f1 || !f2 || f1 !== f2) return false;
  const s1 = timeToMinutes(g1.time);
  const s2 = timeToMinutes(g2.time);
  if (s1 === null || s2 === null) return false;
  const d1 = durMap[g1.division] ?? durMap["default"] ?? 90;
  const d2 = durMap[g2.division] ?? durMap["default"] ?? 90;
  // Strict inequality: butted-up start times (s2 === s1+d1) are fine
  return s1 < s2 + d2 && s2 < s1 + d1;
}

/** Build fieldName.toLowerCase() → { lights, supportedDivisions } index */
async function buildFieldIndex(db) {
  const snap = await db.collection("facilities").get();
  const idx = {};
  snap.docs.forEach(d => {
    (d.data().fields || []).forEach(f => {
      if (f.name) idx[f.name.trim().toLowerCase()] = f;
    });
  });
  return idx;
}

// ── previewCalendarImport ─────────────────────────────────────────────────────

exports.previewCalendarImport = onCall({ cors: CORS }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const db = getFirestore();

  const callerDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!callerDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  // Load config
  const [teamsSnap, schedulingSnap, gamesSnap, fieldIndex] = await Promise.all([
    db.doc("config/teamCalendars").get(),
    db.doc("config/scheduling").get(),
    db.collection("games").get(),
    buildFieldIndex(db),
  ]);

  const teams    = teamsSnap.exists  ? (teamsSnap.data().teams || [])  : [];
  const schedCfg = schedulingSnap.exists ? schedulingSnap.data() : {};
  const durMap   = schedCfg.gameDurationMinutes || { "10U": 90, "12U": 90, "14U": 120, "HS JV": 120, "HS Varsity": 150, default: 90 };
  const lateStartCutoff = timeToMinutes(schedCfg.lateStartCutoff || "19:30");

  // Index existing games
  const existingGames    = gamesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const existingExtIdSet = new Set(existingGames.map(g => g.externalId).filter(Boolean));
  const today            = todayISO();

  const ready = [], conflicts = [], duplicates = [], warnings = [];

  // Fetch all ICS feeds concurrently
  const icsResults = await Promise.allSettled(teams.map(t => fetchICS(t.icsUrl)));

  for (let ti = 0; ti < teams.length; ti++) {
    const team = teams[ti];
    const icsResult = icsResults[ti];
    if (icsResult.status === "rejected") {
      warnings.push({ source: team.name, message: `Failed to fetch: ${icsResult.reason?.message ?? icsResult.reason}` });
      continue;
    }
    const icsText = icsResult.value;

    const events   = parseVEvents(icsText);
    const division = inferDivision(team.name);

    let skippedPractices = 0;
    for (const ev of events) {
      if (!ev.date || ev.date < today) continue; // skip past events
      // Correct isAway from the subscribed team's perspective
      ev.isAway = resolveIsAway(team.name, ev.homeTeam, ev.awayTeam, ev.isAway);

      // Skip practice/workout events — they go to the practices collection, not games
      if (isPracticeEvent(ev.summary)) { skippedPractices++; continue; }

      // Skip if no location (can't determine field)
      const rawLocation = ev.location || "";
      const field = rawLocation.split(",")[0].trim(); // take everything before first comma

      const candidate = {
        source:      "calendar",
        sourceLabel: team.name,
        sourceType:  team.type || "gamechanger",
        externalId:  ev.uid,
        date:        ev.date,
        time:        ev.time || "",
        field,
        division,
        homeTeam:    ev.homeTeam || "",
        awayTeam:    ev.awayTeam || "",
        isAway:      ev.isAway || false,
        city:        team.city || "",
        type:        "Regular",
        needsUmpires: true,
        cancelled:   false,
        umpireSlots: [],
      };

      // ── Duplicate check ──────────────────────────────────────────────────────
      if (ev.uid && existingExtIdSet.has(ev.uid)) {
        duplicates.push({ ...candidate, _reason: "Already imported" });
        continue;
      }

      const fieldKey  = field.toLowerCase();
      const fieldObj  = fieldIndex[fieldKey] || null;
      const gameConflicts = [];

      // ── Conflict: field time overlap ─────────────────────────────────────────
      for (const existing of existingGames) {
        if (!existing.cancelled && gamesOverlap(candidate, existing, durMap)) {
          gameConflicts.push({
            type:    "field_overlap",
            label:   "Field time overlap",
            color:   "#e53935",
            with: {
              id:       existing.id,
              date:     existing.date,
              time:     existing.time,
              field:    existing.field,
              division: existing.division,
              city:     existing.city,
            }
          });
        }
      }

      // Also check against other candidates in this same batch
      for (const other of [...ready, ...conflicts.map(c => c.game)]) {
        if (other && gamesOverlap(candidate, other, durMap)) {
          gameConflicts.push({
            type:  "batch_overlap",
            label: "Overlaps another incoming game",
            color: "#e53935",
            with: { date: other.date, time: other.time, field: other.field, division: other.division, sourceLabel: other.sourceLabel }
          });
          break;
        }
      }

      // ── Conflict: no lights / late start ────────────────────────────────────
      if (candidate.time && fieldObj !== null) {
        const startMin = timeToMinutes(candidate.time);
        if (startMin !== null && !fieldObj.lights && startMin > lateStartCutoff) {
          gameConflicts.push({
            type:  "no_lights",
            label: `Starts after ${schedCfg.lateStartCutoff || "19:30"} — field has no lights`,
            color: "#f57c00",
          });
        }
      }

      // ── Warning: division mismatch ───────────────────────────────────────────
      if (fieldObj) {
        const supported = fieldObj.supportedDivisions || [];
        if (supported.length && !supported.includes(division)) {
          gameConflicts.push({
            type:  "division_mismatch",
            label: `${division} not in supported divisions for ${field} (${supported.join(", ")})`,
            color: "#f9a825",
          });
        }
      }

      if (gameConflicts.length === 0) {
        ready.push(candidate);
      } else {
        conflicts.push({ game: candidate, issues: gameConflicts });
      }
    }
    if (skippedPractices > 0) {
      warnings.push({
        source: team.name,
        message: `${skippedPractices} practice event${skippedPractices !== 1 ? "s" : ""} skipped — visible on Scheduler → Calendar`
      });
    }
  }

  return { ready, conflicts, duplicates, warnings };
});

// ── commitCalendarImport ──────────────────────────────────────────────────────

exports.commitCalendarImport = onCall({ cors: CORS }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const db = getFirestore();

  const callerDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!callerDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const { games } = request.data;
  if (!Array.isArray(games) || games.length === 0) throw new HttpsError("invalid-argument", "games array required.");

  // Load default slot types
  const paySnap      = await db.doc("config/payRates").get();
  const payData      = paySnap.exists ? paySnap.data() : {};
  const defaultRateMap = { Plate: payData.plate || 0, Field: payData.field || 0, Extra: payData.extra || 0 };
  const defaultSlots = makeUmpireSlots(payData.defaultSlotTypes || [], defaultRateMap);

  // Dedup against already-existing externalIds
  const gamesSnap        = await db.collection("games").get();
  const existingExtIdSet = new Set(gamesSnap.docs.map(d => d.data().externalId).filter(Boolean));

  const BATCH_LIMIT = 499;
  let batch = db.batch();
  let opsInBatch = 0;
  let added = 0;
  for (const g of games) {
    if (g.externalId && existingExtIdSet.has(g.externalId)) continue; // race-condition guard
    const ref = db.collection("games").doc();
    batch.set(ref, {
      source:      g.source      || "calendar",
      externalId:  g.externalId  || null,
      date:        g.date,
      time:        g.time        || "",
      field:       g.field       || "",
      city:        g.city        || "",
      division:    g.division    || "",
      type:        g.type        || "Regular",
      homeTeam:    g.homeTeam    || "",
      awayTeam:    g.awayTeam    || "",
      isAway:       g.isAway      || false,
      cancelled:    false,
      umpireSlots: (g.needsUmpires === false) ? [] : (g.umpireSlots?.length ? g.umpireSlots : defaultSlots),
      needsUmpires: g.needsUmpires === false ? false : (g.umpireSlots?.length ? true : defaultSlots.length > 0),
      notes:       g.notes       || "",
      importedAt:  new Date().toISOString(),
      importedBy:  request.auth.uid,
    });
    added++;
    opsInBatch++;
    if (opsInBatch >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      opsInBatch = 0;
    }
  }
  if (opsInBatch > 0) await batch.commit();
  return { added };
});

// ── repairCalendarGames — bulk-fix bad source:"calendar" imports ──────────────
//
// Finds all future source:"calendar" games (no past games, no assigned umpires)
// that are home games at a known facility, then either:
//   • Promotes them to source:"city-schedule" with full metadata + umpire slots, OR
//   • Deletes them if a city-schedule game already exists for that division+date.

exports.repairCalendarGames = onCall({ cors: CORS }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const db = getFirestore();
  const callerDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!callerDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const today = todayISO();

  const [gamesSnap, teamsSnap, ratesSnap, facilitiesSnap] = await Promise.all([
    db.collection("games").get(),
    db.doc("config/teamCalendars").get(),
    db.doc("config/payRates").get(),
    db.collection("facilities").get(),
  ]);

  // Team lookup by name
  const teams = teamsSnap.exists ? (teamsSnap.data().teams || []) : [];
  const teamByName = {};
  for (const t of teams) { if (t.name) teamByName[t.name] = t; }

  // Pay-rate config
  const rates   = ratesSnap.exists ? ratesSnap.data() : {};
  const rateMap = { Plate: rates.plate || 0, Field: rates.field || 0, Extra: rates.extra || 0 };

  // Build city → facilityId map dynamically from all facilities
  const facilityByCity = {};
  facilitiesSnap.forEach(d => {
    const addr = (d.data().address || "").toLowerCase().trim();
    if (addr) {
      const parts = addr.split(",").map(s => s.trim());
      const sdIdx = parts.findIndex(p => /^s\.?d\.?\b|^south\s+dakota\b/.test(p));
      if (sdIdx > 0) {
        const city = parts[sdIdx - 1];
        if (city) facilityByCity[city] = d.id;
      }
    }
  });

  // Separate existing city-schedule games (keyed by "division|date") from calendar games to repair
  const cityScheduleKeys = new Set(); // "division|date" of all existing city-schedule games
  const calendarGames    = [];        // source:"calendar" candidates for repair

  for (const d of gamesSnap.docs) {
    const g = d.data();
    if (g.source === "city-schedule") {
      cityScheduleKeys.add(`${g.division}|${g.date}`);
    } else if (g.source === "calendar") {
      if (!g.date || g.date < today) continue;                          // never touch past games
      const hasAssigned = (g.umpireSlots || []).some(s => s.assignedUid);
      if (hasAssigned) continue;                                         // never touch assigned games
      calendarGames.push({ ref: d.ref, ...g });
    }
  }

  let promoted = 0, deleted = 0, skipped = 0;
  const ops = []; // collected Firestore operations executed in parallel at the end

  for (const game of calendarGames) {
    const team = teamByName[game.teamName];

    if (!team) { skipped++; continue; } // no team config — admin must fix manually

    // Only repair home games for teams that have needsUmpireForHome configured.
    // Use the location as primary signal; fall back to team city + isAway flag.
    const loc = (game.location || "").toLowerCase();
    const isAtHome = !!facilityIdFromLocation(game.location, facilityByCity) ||
                     (team.city && loc.includes(team.city.toLowerCase())) ||
                     (team.city && game.isAway !== true && !game.location);

    if (!isAtHome || !team.needsUmpireForHome) { skipped++; continue; }

    const key = `${game.division}|${game.date}`;

    if (cityScheduleKeys.has(key)) {
      // A city-schedule game already exists for this slot — the calendar entry is a duplicate.
      ops.push(game.ref.delete());
      deleted++;
    } else {
      // Promote: update the existing document in-place (preserves the document ID and
      // any icsLinks / externalId already stored on it).
      const fieldName  = (game.field && !game.field.includes(","))
        ? game.field
        : (game.location || "").split(",")[0].trim();
      const facilityId = game.facilityId || facilityIdFromLocation(game.location, facilityByCity) || "";
      const city       = game.city || team.city || "";
      const league     = game.league ||
        ((team.leagueNames && team.leagueNames.length) ? team.leagueNames[0] : (team.leagueName || ""));
      const division   = game.division || inferDivision(team.name);
      const slotTypes  = getSlotTypesForDivision(division, rates);

      // Re-compute isAway: location at team's home city always wins
      const correctedIsAway = (team.city && loc.includes(team.city.toLowerCase()))
        ? false
        : resolveIsAway(team.name, game.homeTeam || "", game.awayTeam || "", game.isAway || false);

      ops.push(game.ref.update({
        source:       "city-schedule",
        city,
        league,
        division,
        facilityId,
        field:        fieldName,
        isAway:       correctedIsAway,
        type:         game.type || "Regular",
        needsUmpires: slotTypes.length > 0,
        umpireSlots:  makeUmpireSlots(slotTypes, rateMap),
        // Ensure icsLinks is initialised if the game has an externalId
        ...(game.externalId && !(game.icsLinks || []).length
          ? { icsLinks: [{ uid: game.externalId, teamName: game.teamName || team.name }] }
          : {}),
      }));

      // Mark this slot as covered so a second calendar game for the same div+date is deleted
      cityScheduleKeys.add(key);
      promoted++;
    }
  }

  await Promise.all(ops);
  return { promoted, deleted, skipped };
});

// ── Callable: admin panel "Sync" button ───────────────────────────────────────

exports.syncGamesNow = onCall(
  { cors: ["https://tri-valley-baseball-umpires.web.app", "https://tri-valley-baseball-umpires.firebaseapp.com"] },
  async request => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in.");
    const db       = getFirestore();
    const adminDoc = await db.doc(`admins/${request.auth.uid}`).get();
    if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");
    return await runSync();
  }
);

// ── One-time city schedule import ─────────────────────────────────────────────

const CITY_SCHEDULE = [
  // City of Crooks — 12U
  { city: "City of Crooks", division: "12U", date: "2026-05-13", time: "18:30", field: "NH-North" },
  { city: "City of Crooks", division: "12U", date: "2026-05-20", time: "18:30", field: "NH-North" },
  { city: "City of Crooks", division: "12U", date: "2026-05-27", time: "18:30", field: "NH-North" },
  // City of Colton — 10U
  { city: "City of Colton", division: "10U", date: "2026-05-11", time: "18:30", field: "West" },
  { city: "City of Colton", division: "10U", date: "2026-05-13", time: "18:30", field: "West" },
  { city: "City of Colton", division: "10U", date: "2026-05-18", time: "18:30", field: "West" },
  { city: "City of Colton", division: "10U", date: "2026-05-20", time: "18:30", field: "West" },
  { city: "City of Colton", division: "10U", date: "2026-05-27", time: "18:30", field: "East" },
  { city: "City of Colton", division: "10U", date: "2026-05-27", time: "18:30", field: "West" },
];

exports.importCitySchedule = onCall(
  { cors: ["https://tri-valley-baseball-umpires.web.app", "https://tri-valley-baseball-umpires.firebaseapp.com"] },
  async request => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in.");
    const db       = getFirestore();
    const adminDoc = await db.doc(`admins/${request.auth.uid}`).get();
    if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");
    const adminData = adminDoc.data() || {};
    const isSuperAdmin = adminData.superAdmin === true || (Array.isArray(adminData.roles) && adminData.roles.length === 0);
    if (!isSuperAdmin) throw new HttpsError("permission-denied", "Super admin access required.");

    const ratesSnap = await db.doc("config/payRates").get();
    const rates     = ratesSnap.exists ? ratesSnap.data() : {};
    const rateMap   = { Plate: rates.plate || 0, Field: rates.field || 0, Extra: rates.extra || 0 };
    const defaultSlotTypes = (rates.defaultSlotTypes && rates.defaultSlotTypes.length)
      ? rates.defaultSlotTypes
      : ["Plate", "Field"];

    // Build all externalIds upfront
    const cityEntries = CITY_SCHEDULE.map(g => ({
      ...g,
      externalId: `city-2026-${g.city.replace(/\s+/g,"").toLowerCase()}-${g.division}-${g.date}-${g.field.replace(/\s+/g,"")}`
    }));

    // Fetch all existing city-schedule games in one query (instead of N per-game queries)
    const existingSnap = await db.collection("games")
      .where("source", "==", "city-schedule").get();
    const existingExtIds = new Set(existingSnap.docs.map(d => d.data().externalId).filter(Boolean));

    // Batch-write all new games
    let added = 0, skipped = 0;
    const batch = db.batch();
    for (const entry of cityEntries) {
      if (existingExtIds.has(entry.externalId)) { skipped++; continue; }
      const newRef = db.collection("games").doc();
      batch.set(newRef, {
        city:         entry.city,
        division:     entry.division,
        date:         entry.date,
        time:         entry.time,
        type:         "Regular",
        field:        entry.field,
        needsUmpires: true,
        umpireSlots:  makeUmpireSlots(getSlotTypesForDivision(entry.division, rates), rateMap),
        cancelled:  false,
        externalId: entry.externalId,
        source:     "city-schedule",
        createdAt:  FieldValue.serverTimestamp()
      });
      added++;
    }
    if (added > 0) await batch.commit();
    return { added, skipped };
  }
);

// ── Phase 11: single-team sync ────────────────────────────────────────────────

async function runSyncForTeam(team) {
  const db = getFirestore();

  // Fetch games + practices + config (pay rates, facilities) + ICS feed in parallel
  const [[gamesSnap, practicesSnap, ratesSnap, facilitiesSnap], icsText] = await Promise.all([
    Promise.all([
      db.collection("games").get(),
      db.collection("practices").get(),
      db.doc("config/payRates").get(),
      db.collection("facilities").get(),
    ]),
    fetchICS(team.icsUrl).catch(err => {
      throw new Error(`Failed to fetch ICS for ${team.name}: ${err.message}`);
    }),
  ]);

  const rates   = ratesSnap.exists ? ratesSnap.data() : {};
  const rateMap = { Plate: rates.plate || 0, Field: rates.field || 0, Extra: rates.extra || 0 };
  const facilityByCity = {};
  for (const d of facilitiesSnap.docs) {
    const cities = d.data().cities || [];
    for (const city of cities) { if (city) facilityByCity[city] = d.id; }
    const city = d.data().city;
    if (city) facilityByCity[city] = d.id;
  }

  const existingExtIds         = new Set(gamesSnap.docs.map(d => d.data().externalId).filter(Boolean));
  const existingPracticeExtIds = new Set(practicesSnap.docs.map(d => d.data().externalId).filter(Boolean));
  const linkedUids     = new Set();
  const cityGames      = [];
  for (const d of gamesSnap.docs) {
    const g = d.data();
    if (g.source === "city-schedule") {
      cityGames.push({ ref: d.ref, ...g });
      (g.icsLinks || []).forEach(l => linkedUids.add(l.uid));
    }
  }

  const division = inferDivision(team.name);
  const events = parseVEvents(icsText);
  const eventsByDivDate = {};
  const extIdToDoc = {};
  for (const d of gamesSnap.docs) {
    const g = d.data();
    if (g.externalId && g.source === "calendar") extIdToDoc[g.externalId] = d;
  }
  const today = todayISO();
  let added = 0, corrected = 0;

  // Collect writes during event processing, then execute in parallel
  const toDelete      = [];
  const toPracticeAdd = [];
  const toGamePatch   = [];
  const toGameAdd     = [];

  for (const ev of events) {
    if (!ev.uid) continue;
    if (!ev.date || ev.date < today) continue; // never add or modify past events
    // Correct isAway from the subscribed team's perspective
    ev.isAway = resolveIsAway(team.name, ev.homeTeam, ev.awayTeam, ev.isAway);

    // ── Route practice events to `practices` collection ─────────────────────
    if (isPracticeEvent(ev.summary)) {
      // Clean up any stale reference game that was mistakenly created for this externalId
      if (existingExtIds.has(ev.uid)) {
        const staleDoc = gamesSnap.docs.find(d =>
          d.data().externalId === ev.uid && d.data().needsUmpires === false
        );
        if (staleDoc) {
          toDelete.push(staleDoc.ref);
          existingExtIds.delete(ev.uid);
          console.log(`Will delete stale game entry for practice externalId: ${ev.uid}`);
        }
      }
      if (!existingPracticeExtIds.has(ev.uid)) {
        toPracticeAdd.push({
          teamName:   team.name,
          date:       ev.date,
          startTime:  ev.time || "",
          endTime:    "",
          field:      (ev.location || "").split(",")[0].trim(),
          source:     "calendar",
          externalId: ev.uid,
          createdAt:  FieldValue.serverTimestamp(),
        });
        existingPracticeExtIds.add(ev.uid);
        added++;
      }
      continue; // never add to games
    }

    const key = `${division}|${ev.date}`;
    if (!eventsByDivDate[key]) eventsByDivDate[key] = [];
    if (!eventsByDivDate[key].some(e => e.uid === ev.uid))
      eventsByDivDate[key].push({ uid: ev.uid, teamName: team.name, location: ev.location, homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, isAway: ev.isAway });

    if (existingExtIds.has(ev.uid) || linkedUids.has(ev.uid)) {
      // Self-healing: correct date/time and isAway on existing future calendar games
      const existingDoc = extIdToDoc[ev.uid];
      if (existingDoc && ev.date >= today) {
        const eData = existingDoc.data();
        // Never silently change time/date if umpires are already involved — admin must update manually
        const hasUmpires = eData.needsUmpires === true || (eData.umpireSlots || []).some(s => s.assignedUid);
        const patch = {};
        if (!hasUmpires) {
          if (eData.time !== ev.time) patch.time = ev.time;
          if (eData.date !== ev.date) patch.date = ev.date;
        }
        // Cosmetic fields are always safe to correct
        if ((eData.isAway || false) !== ev.isAway) patch.isAway = ev.isAway;
        if (eData.homeTeam !== ev.homeTeam)        patch.homeTeam = ev.homeTeam;
        if (eData.awayTeam !== ev.awayTeam)        patch.awayTeam = ev.awayTeam;
        if (Object.keys(patch).length) {
          toGamePatch.push({ ref: existingDoc.ref, patch });
          corrected++;
        }
      }
      continue;
    }

    toGameAdd.push({
      teamName: team.name, division,
      date: ev.date, time: ev.time, location: ev.location,
      homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, isAway: ev.isAway || false,
      needsUmpires: false, umpireSlots: [], cancelled: false,
      externalId: ev.uid, source: "calendar",
      createdAt: FieldValue.serverTimestamp()
    });
    existingExtIds.add(ev.uid);
    added++;
  }

  // Execute all collected writes: deletes + patches in parallel, sets in chunked batches
  // (Firestore batch limit is 500 ops — chunking guards against large initial imports)
  await Promise.all([
    ...toDelete.map(ref => ref.delete()),
    ...toGamePatch.map(({ ref, patch }) => ref.update(patch)),
  ]);
  const allSets = [
    ...toPracticeAdd.map(data => ({ col: "practices", data })),
    ...toGameAdd.map(data     => ({ col: "games",     data })),
  ];
  for (let i = 0; i < allSets.length; i += 499) {
    const b = db.batch();
    allSets.slice(i, i + 499).forEach(({ col, data }) => b.set(db.collection(col).doc(), data));
    await b.commit();
  }

  // ── City-schedule matching — build one merged update per game, then parallel-write ──
  let linked = 0, flagged = 0;
  const cityUpdates = [];
  for (const game of cityGames) {
    if (game.division !== division) continue;
    if (game.date < today || game.cancelled) continue;
    const key     = `${division}|${game.date}`;
    const matches = eventsByDivDate[key] || [];
    const gameUpdate = {};

    if (!game.icsLinks || game.icsLinks.length === 0) {
      if (matches.length > 0) {
        gameUpdate.icsLinks = matches.map(e => ({ uid: e.uid, teamName: e.teamName }));
        const first = matches[0];
        if (!game.homeTeam && first.homeTeam) gameUpdate.homeTeam = first.homeTeam;
        if (!game.awayTeam && first.awayTeam) gameUpdate.awayTeam = first.awayTeam;
        if (first.isAway !== undefined && (game.isAway || false) !== first.isAway) gameUpdate.isAway = first.isAway;
        linked++;
      }
    } else {
      const liveUids = new Set(matches.map(e => e.uid));
      const missing  = game.icsLinks.filter(l => !liveUids.has(l.uid));
      if (missing.length > 0 && !game.possibleChange) { gameUpdate.possibleChange = true; flagged++; }
      else if (missing.length === 0 && game.possibleChange) { gameUpdate.possibleChange = false; }
      // Always sync isAway from the ICS match (merged into single update)
      const awayMatch = matches.find(e => e.isAway !== undefined);
      if (awayMatch && (game.isAway || false) !== awayMatch.isAway) gameUpdate.isAway = awayMatch.isAway;
    }

    if (Object.keys(gameUpdate).length) cityUpdates.push({ ref: game.ref, update: gameUpdate });
  }
  if (cityUpdates.length > 0) {
    await Promise.all(cityUpdates.map(({ ref, update }) => ref.update(update)));
  }

  // ── Repair pass (this team only) ─────────────────────────────────────────────
  // Promotes source:"calendar" home games for this team to source:"city-schedule".
  {
    const coveredKeys = new Set(cityGames.map(g => `${g.division}|${g.date}`));
    for (const g of toGameAdd) {
      if (g.source === "city-schedule") coveredKeys.add(`${g.division}|${g.date}`);
    }
    const repairOps = [];
    for (const d of gamesSnap.docs) {
      const g = d.data();
      if (g.source !== "calendar" || g.teamName !== team.name) continue;
      if (!g.date || g.date < today) continue;
      if ((g.umpireSlots || []).some(s => s.assignedUid)) continue;
      if (!team.needsUmpireForHome) continue;
      const loc      = (g.location || "").toLowerCase();
      const isAtHome = !!facilityIdFromLocation(g.location, facilityByCity) ||
                       (team.city && loc.includes(team.city.toLowerCase())) ||
                       (team.city && g.isAway !== true && !g.location);
      if (!isAtHome) continue;
      const key = `${g.division}|${g.date}`;
      if (coveredKeys.has(key)) {
        repairOps.push(d.ref.delete());
      } else {
        const fieldName  = (g.field && !g.field.includes(",")) ? g.field : (g.location || "").split(",")[0].trim();
        const facilityId = g.facilityId || facilityIdFromLocation(g.location, facilityByCity) || "";
        const city       = g.city || team.city || "";
        const league     = g.league || team.leagueNames?.[0] || team.leagueName || "";
        const slotTypes  = getSlotTypesForDivision(g.division || division, rates);
        const correctedIsAway = (team.city && loc.includes(team.city.toLowerCase()))
          ? false
          : resolveIsAway(team.name, g.homeTeam || "", g.awayTeam || "", g.isAway || false);
        repairOps.push(d.ref.update({
          source: "city-schedule", city, league, facilityId,
          field: fieldName, isAway: correctedIsAway, type: g.type || "Regular",
          needsUmpires: slotTypes.length > 0,
          umpireSlots:  makeUmpireSlots(slotTypes, rateMap),
          ...(g.externalId && !(g.icsLinks || []).length
            ? { icsLinks: [{ uid: g.externalId, teamName: g.teamName || team.name }] }
            : {}),
        }));
        coveredKeys.add(key);
        corrected++;
      }
    }
    if (repairOps.length > 0) await Promise.all(repairOps);
  }

  // ── Slot cleanup pass (this team only) ───────────────────────────────────────
  // Removes umpire slots from city-schedule games when the team no longer needs umpires.
  {
    const cleanupOps = [];
    for (const d of gamesSnap.docs) {
      const g = d.data();
      if (g.source !== "city-schedule" || g.teamName !== team.name) continue;
      if (!g.date || g.date < today) continue;
      if ((g.umpireSlots || []).some(s => s.assignedUid)) continue;
      if (!g.needsUmpires && !(g.umpireSlots || []).length) continue;
      const slotTypes     = getSlotTypesForDivision(g.division, rates);
      const shouldHaveSlots = team.needsUmpireForHome && slotTypes.length > 0;
      if (!shouldHaveSlots && (g.needsUmpires || (g.umpireSlots || []).length > 0)) {
        cleanupOps.push(d.ref.update({ umpireSlots: [], needsUmpires: false }));
      }
    }
    if (cleanupOps.length > 0) await Promise.all(cleanupOps);
  }

  return { added, corrected, linked, flagged };
}

exports.syncTeamNow = onCall(
  { cors: ["https://tri-valley-baseball-umpires.web.app", "https://tri-valley-baseball-umpires.firebaseapp.com"] },
  async request => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in.");
    const db       = getFirestore();
    const adminDoc = await db.doc(`admins/${request.auth.uid}`).get();
    if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

    const { teamIndex } = request.data;
    if (typeof teamIndex !== "number") throw new HttpsError("invalid-argument", "teamIndex required.");

    const teamsSnap = await db.doc("config/teamCalendars").get();
    const teams     = teamsSnap.exists ? (teamsSnap.data().teams || []) : [];
    if (teamIndex < 0 || teamIndex >= teams.length)
      throw new HttpsError("out-of-range", "Invalid team index.");

    return await runSyncForTeam(teams[teamIndex]);
  }
);

// ── Phase 12: Slack helpers ───────────────────────────────────────────────────

// ── ICS helpers ───────────────────────────────────────────────────────────────

function p2(n) { return String(n).padStart(2, "0"); }
function icsEsc(s) {
  return (s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
const CHICAGO_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:America/Chicago",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0600","TZOFFSETTO:-0500","TZNAME:CDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0500","TZOFFSETTO:-0600","TZNAME:CST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

function gamesToIcs(games, calName = "Tri-Valley Baseball Schedule") {
  const now = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Tri-Valley Baseball Umpires//Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEsc(calName)}`,
    "X-WR-TIMEZONE:America/Chicago",
    CHICAGO_VTIMEZONE,
  ];

  for (const g of games) {
    if (!g.date) continue;
    const [y, mo, d] = g.date.split("-");
    let dtstart, dtend;
    if (g.time) {
      const [h, m] = g.time.split(":");
      dtstart = `DTSTART;TZID=America/Chicago:${y}${mo}${d}T${h}${m}00`;
      const durMin = /HS/i.test(g.division || "") ? 120 : 90;
      const end = new Date(+y, +mo - 1, +d, +h, +m + durMin);
      dtend = `DTEND;TZID=America/Chicago:${end.getFullYear()}${p2(end.getMonth()+1)}${p2(end.getDate())}T${p2(end.getHours())}${p2(end.getMinutes())}00`;
    } else {
      const next = new Date(+y, +mo - 1, +d + 1);
      dtstart = `DTSTART;VALUE=DATE:${y}${mo}${d}`;
      dtend   = `DTEND;VALUE=DATE:${next.getFullYear()}${p2(next.getMonth()+1)}${p2(next.getDate())}`;
    }

    let summary = "";
    if (g.homeTeam && g.awayTeam) summary = `${g.homeTeam} vs ${g.awayTeam}`;
    else if (g.teamName) summary = g.teamName;
    else summary = `${g.division || "Baseball"} Game`;
    if (g.cancelled) summary = `CANCELLED: ${summary}`;

    const descParts = [];
    if (g.division) descParts.push(`Division: ${g.division}`);
    if (g.field)    descParts.push(`Field: ${g.field}`);
    const assigned = (g.umpireSlots || []).filter(s => s.assignedName);
    if (assigned.length) descParts.push(`Umpires: ${assigned.map(s => `${s.type}: ${s.assignedName}`).join(", ")}`);

    const evt = [
      "BEGIN:VEVENT",
      `UID:game-${g.id || g.externalId || Math.random()}@tri-valley-baseball-umpires`,
      `DTSTAMP:${now}`,
      dtstart,
      dtend,
      `SUMMARY:${icsEsc(summary)}`,
    ];
    if (descParts.length) evt.push(`DESCRIPTION:${icsEsc(descParts.join("\\n"))}`);
    if (g.field)          evt.push(`LOCATION:${icsEsc(g.field)}`);
    evt.push(`STATUS:${g.cancelled ? "CANCELLED" : "CONFIRMED"}`);
    evt.push("END:VEVENT");
    lines.push(...evt);
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

exports.icsGames = onRequest({ cors: false }, async (req, res) => {
  const db       = getFirestore();
  const teamId   = req.query.team     || "";
  const division = req.query.division || "";
  const facility = req.query.facility || "";
  const today    = todayISO();

  try {
    const snap  = await db.collection("games").orderBy("date").get();
    let games   = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Only future games; include cancelled so subscribed calendars show the cancellation
    games = games.filter(g => g.date >= today);
    if (teamId)   games = games.filter(g => g.teamId === teamId || (g.teamName || "").toLowerCase() === teamId.toLowerCase());
    if (division) games = games.filter(g => g.division === division);
    if (facility) games = games.filter(g => g.facilityId === facility);

    const icsText = gamesToIcs(games, "Tri-Valley Baseball Schedule");
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'inline; filename="tri-valley-schedule.ics"');
    res.setHeader("Cache-Control", "public, max-age=1800");
    res.status(200).send(icsText);
  } catch (err) {
    res.status(500).send("Error generating calendar: " + err.message);
  }
});

exports.icsUmpire = onRequest({ cors: false }, async (req, res) => {
  const token = req.query.token || "";
  if (!token) { res.status(401).send("Token required."); return; }

  const db = getFirestore();
  try {
    const umpSnap = await db.collection("umpires").where("calendarToken", "==", token).limit(1).get();
    if (umpSnap.empty) { res.status(401).send("Invalid or expired token."); return; }

    const umpDoc  = umpSnap.docs[0];
    const umpire  = umpDoc.data();
    const uid     = umpDoc.id;
    const today   = todayISO();

    const snap  = await db.collection("games").orderBy("date").get();
    const games = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(g => g.date >= today)
      .filter(g => (g.umpireSlots || []).some(s => s.assignedUid === uid));

    const calName = `${umpire.name || "Umpire"} — My Games`;
    const icsText = gamesToIcs(games, calName);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'inline; filename="my-games.ics"');
    res.setHeader("Cache-Control", "private, max-age=900");
    res.status(200).send(icsText);
  } catch (err) {
    res.status(500).send("Error generating calendar: " + err.message);
  }
});

function postSlack(webhookUrl, text) {
  if (!webhookUrl) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify({ text });
    const urlObj  = new URL(webhookUrl);
    const req     = https.request({
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, res => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Slack timeout")); });
    req.write(body);
    req.end();
  });
}

async function loadWebhookConfig(db) {
  const snap = await db.doc("config/slackWebhooks").get();
  return snap.exists ? snap.data() : {};
}

function getTargetWebhooks(config, eventType, division = null) {
  // New format: webhooks array
  if (Array.isArray(config.webhooks)) {
    return config.webhooks
      .filter(w => w.active !== false && w.url)
      .filter(w => (w.events || []).includes(eventType))
      .filter(w => {
        if (!division || !w.divisions || !w.divisions.length) return true;
        return w.divisions.some(d => new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(division));
      })
      .map(w => w.url);
  }

  // Legacy fallback: flat keys (jeff, ch10u, ch12u, dailySummary)
  const urls = new Set();
  const div = division || "";
  const addJeff    = () => { if (config.jeff)  urls.add(config.jeff); };
  const addChannel = () => {
    if (/10U/i.test(div) && config.ch10u) urls.add(config.ch10u);
    if (/12U/i.test(div) && config.ch12u) urls.add(config.ch12u);
  };
  switch (eventType) {
    case "gameChanges":
    case "openSlots":
    case "dayOfReminders":
      addJeff(); addChannel(); break;
    case "slotChanges":
    case "cancellationRequests":
    case "incidentReports":
    case "tournamentSwaps":
    case "coachRegistration":
    case "umpireRequests":
    case "practiceRequests":
    case "callupRequests":
    case "checkIn":
    case "fieldIssues":
    case "rainout":
    case "umpireRegistration":
      addJeff(); break;
    case "dailySummary":
      if (config.dailySummary) urls.add(config.dailySummary); break;
  }
  return [...urls];
}

function fmtDateSlack(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

function fmtTimeSlack(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,"0")} ${h >= 12 ? "PM" : "AM"}`;
}

function gameLabel(g) {
  const teams = [g.homeTeam, g.awayTeam].filter(Boolean).join(" vs ");
  return `${fmtDateSlack(g.date)} at ${fmtTimeSlack(g.time)} — ${g.city ?? ""} ${g.division ?? ""}${teams ? " · " + teams : ""}${g.field ? " · " + g.field : ""}`;
}

// ── Phase 12: onGameWrite trigger ─────────────────────────────────────────────

exports.onGameWrite = onDocumentWritten("games/{gameId}", async event => {
  const before = event.data.before?.data() ?? null;
  const after  = event.data.after?.data()  ?? null;

  // Skip if neither side ever needed umpires AND the game wasn't deleted/created
  // (a deletion/creation always gets a Slack notification regardless of needsUmpires)
  const isCreate  = !before && !!after;
  const isDelete  = !!before && !after;
  const isUpdate  = !!before && !!after;
  if (isUpdate && !after.needsUmpires && !before.needsUmpires) return;

  const db     = getFirestore();
  const div    = after?.division ?? before?.division ?? "";
  const config = await loadWebhookConfig(db);

  // ── 1. Structural game changes → gameChanges / rainout webhooks ─────────────
  let broadcastMsg = null;
  let rainoutMsg   = null;

  if (isCreate) {
    broadcastMsg = `🆕 New game added: ${gameLabel(after)}`;
  } else if (isDelete) {
    broadcastMsg = `🗑️ Game deleted: ${gameLabel(before)}`;
  } else {
    if (!before.cancelled && after.cancelled) {
      if (after.cancellationType === "rainout") {
        rainoutMsg = `🌧 Rain Out — ${gameLabel(after)}`;
      } else {
        broadcastMsg = `❌ Game cancelled: ${gameLabel(after)}`;
      }
    } else if (before.cancelled && !after.cancelled) {
      broadcastMsg = `✅ Game reinstated: ${gameLabel(after)}`;
    } else {
      const changed = ["date","time","field","city","division"].some(k => before[k] !== after[k]);
      if (changed) broadcastMsg = `✏️ Game updated: ${gameLabel(after)}`;
    }
  }

  // ── 2. Slot assignment changes → slotChanges webhooks ───────────────────────
  let jeffMsg = null;
  const checkIns = [];

  if (isUpdate) {
    const beforeSlots = before.umpireSlots || [];
    const afterSlots  = after.umpireSlots  || [];
    const signups  = [];
    const cancels  = [];

    for (let i = 0; i < afterSlots.length; i++) {
      const b = beforeSlots[i] || {};
      const a = afterSlots[i];
      if (!b.assignedUid && a.assignedUid && !after.cancelled) {
        signups.push(`${a.type}: ${a.assignedName || a.assignedUid}`);
      } else if (b.assignedUid && !a.assignedUid && !after.cancelled) {
        cancels.push(`${b.type}: ${b.assignedName || b.assignedUid}`);
      }
      // Check-in: fires for any game (including retroactive admin check-in on past games)
      if (!b.checkedIn && a.checkedIn && a.assignedName) {
        checkIns.push(`${a.type}: ${a.assignedName}`);
      }
    }

    if (signups.length) {
      jeffMsg = `📋 Signed up — ${signups.join(", ")} · ${gameLabel(after)}`;
    } else if (cancels.length) {
      jeffMsg = `↩️ Cancelled — ${cancels.join(", ")} · ${gameLabel(after)}`;
    }
  }

  // ── Send notifications ───────────────────────────────────────────────────────
  const sends = [];
  if (broadcastMsg) {
    getTargetWebhooks(config, "gameChanges", div).forEach(url =>
      sends.push(postSlack(url, broadcastMsg))
    );
  }
  if (rainoutMsg) {
    getTargetWebhooks(config, "rainout", div).forEach(url =>
      sends.push(postSlack(url, rainoutMsg))
    );
  }
  if (jeffMsg) {
    getTargetWebhooks(config, "slotChanges", div).forEach(url =>
      sends.push(postSlack(url, jeffMsg))
    );
  }
  if (checkIns.length) {
    const checkInMsg = `✅ Checked in — ${checkIns.join(", ")} · ${gameLabel(after)}`;
    getTargetWebhooks(config, "checkIn", div).forEach(url =>
      sends.push(postSlack(url, checkInMsg))
    );
  }

  if (sends.length) await Promise.allSettled(sends);
  // Push + email to assigned umpires is handled by onGameSlotChanged (more precise).
});

// ── Cancellation request notifications ───────────────────────────────────────

exports.onCancellationRequest = onDocumentWritten(
  { document: "cancellationRequests/{requestId}", secrets: [GMAIL_USER, GMAIL_PASS] },
  async event => {
  const before = event.data.before?.data() ?? null;
  const after  = event.data.after?.data()  ?? null;
  if (!after) return;

  const db   = getFirestore();
  const name = after.name     || after.uid || "Unknown";
  const slot = after.slotType || "?";
  const date = fmtDateSlack(after.gameDate);
  const time = after.gameTime ? fmtTimeSlack(after.gameTime) : "";
  const gameWhere = [after.gameCity, after.gameDivision, after.gameField].filter(Boolean).join(" · ");

  // ── New pending request → notify admin via Slack ──────────────────────────
  if (after.status === "pending" && before?.status !== "pending") {
    const config  = await loadWebhookConfig(db);
    const targets = getTargetWebhooks(config, "cancellationRequests");
    if (targets.length) {
      const msg = `⚠️ Cancellation request — ${name} wants to cancel ${slot} slot · ${date}${time ? " at " + time : ""}${gameWhere ? " · " + gameWhere : ""}\nReview: https://tri-valley-baseball-umpires.web.app/admin.html`;
      await Promise.allSettled(targets.map(url => postSlack(url, msg)));
    }
    return;
  }

  // ── Status resolved (approved / denied) → notify the umpire ──────────────
  const resolved = after.status === "approved" || after.status === "denied";
  const wasResolved = before?.status === "approved" || before?.status === "denied";
  if (!resolved || wasResolved || !after.uid) return;

  const isApproved = after.status === "approved";
  const pushTitle  = isApproved ? "✅ Cancellation Approved" : "❌ Cancellation Denied";
  const pushBody   = isApproved
    ? `Your ${slot} slot on ${date} has been released. You are no longer assigned.`
    : `Your cancellation request for ${slot} on ${date} was denied. You remain assigned.`;

  // Push notification
  try {
    const tokenSnap = await db.doc(`notifications/${after.uid}`).get();
    const token = tokenSnap.exists ? tokenSnap.data()?.token : null;
    if (token) {
      const result = await getMessaging().sendEachForMulticast({
        tokens: [token],
        notification: { title: pushTitle, body: pushBody },
        webpush: { fcmOptions: { link: "https://tri-valley-baseball-umpires.web.app/schedule.html" } },
      });
      // Clean up stale token
      if (result.responses[0]?.error?.code === "messaging/registration-token-not-registered") {
        await db.doc(`notifications/${after.uid}`).delete();
      }
    }
  } catch (err) {
    console.error("onCancellationRequest push:", err);
  }

  // Email notification
  try {
    const umpSnap = await db.doc(`umpires/${after.uid}`).get();
    const email   = umpSnap.exists ? umpSnap.data()?.email : null;
    if (email) {
      const orgSnap = await db.doc("config/orgSettings").get();
      const org     = orgSnap.exists ? orgSnap.data() : {};
      const orgName = org.assocName || "Tri-Valley Baseball Umpires";
      const coord   = org.coordinatorName  || "";
      const phone   = org.coordinatorPhone || "";
      const APP_URL = "https://tri-valley-baseball-umpires.web.app";

      const subject = isApproved
        ? `Cancellation Approved — ${slot} on ${date}`
        : `Cancellation Request Denied — ${slot} on ${date}`;

      const bodyHtml = `
        <div style="font-family:-apple-system,sans-serif;max-width:540px;margin:0 auto;color:#111">
          <div style="background:#601929;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0">
            <strong style="font-size:1.1rem">${isApproved ? "✅ Cancellation Approved" : "❌ Cancellation Request Denied"}</strong>
          </div>
          <div style="background:#f7f2f3;padding:20px 24px;border-radius:0 0 8px 8px;border:1px solid #d9b8bb;border-top:none">
            <p>Hi ${name},</p>
            <p>${isApproved
              ? `Your request to cancel your <strong>${slot}</strong> slot has been <strong>approved</strong>. You are no longer assigned to the game below.`
              : `Your request to cancel your <strong>${slot}</strong> slot has been <strong>denied</strong>. You remain assigned to the game below.`}
            </p>
            <div style="background:#fff;border:1px solid #ddd;border-radius:6px;padding:12px 16px;margin:16px 0;font-size:0.9rem">
              <strong>Game Details</strong><br>
              📅 ${after.gameDate || ""}${time ? " at " + time : ""}<br>
              📍 ${gameWhere || "—"}
            </div>
            ${isApproved ? "" : `<p>If you have questions about this decision, please contact ${coord ? coord + (phone ? " at " + phone : "") : "your coordinator"}.</p>`}
            <p><a href="${APP_URL}/schedule.html" style="color:#601929">View your schedule →</a></p>
            <hr style="border:none;border-top:1px solid #ddd;margin:16px 0">
            <p style="font-size:0.8rem;color:#777">${orgName}${coord ? " · " + coord : ""}${phone ? " · " + phone : ""}</p>
          </div>
        </div>`;

      const transport = buildTransport();
      await transport.sendMail({
        from:    `"${orgName}" <${GMAIL_USER.value()}>`,
        to:      email,
        subject,
        html:    bodyHtml,
      });
    }
  } catch (err) {
    console.error("onCancellationRequest email:", err);
  }
});

// ── Incident report notifications ────────────────────────────────────────────

exports.onIncidentReport = onDocumentWritten("incidentReports/{reportId}", async event => {
  const before = event.data.before?.data() ?? null;
  const after  = event.data.after?.data()  ?? null;
  if (!after) return;

  const db     = getFirestore();
  const isNew  = !before;
  const statusChanged = !isNew &&
    (before.status ?? "open") !== (after.status ?? "open") &&
    (after.status === "reviewed" || after.status === "closed");

  // ── New report → Slack admin notification ─────────────────────────────────
  if (isNew) {
    const config  = await loadWebhookConfig(db);
    const targets = getTargetWebhooks(config, "incidentReports");
    if (targets.length) {
      const gLabel = [
        after.gameDate ? fmtDateSlack(after.gameDate) : "",
        after.gameCity,
        after.gameDivision,
      ].filter(Boolean).join(" · ");

      let details = "";
      if (after.ejection) {
        const ej = after.ejection;
        details = `\nEjected: ${ej.role || "?"}${ej.name ? " — " + ej.name : ""}${ej.team ? " (" + ej.team + ")" : ""}`;
        if (ej.reason) details += `\nReason: ${ej.reason}`;
      } else if (after.injury) {
        const inj = after.injury;
        details = `\nInjured: ${inj.party || "?"}${inj.name ? " — " + inj.name : ""}`;
        if (inj.description) details += ` · ${inj.description}`;
        details += `\nEMS: ${inj.emsCalled || "No"}`;
      } else if (after.unsafeConditions) {
        const uc = after.unsafeConditions;
        details = `\nCondition: ${uc.conditionType || "?"}`;
        if (uc.gameStatus) details += ` · Game: ${uc.gameStatus}`;
      }

      const msg = `🚨 Incident Report — *${after.incidentType || "Incident"}* · ${after.reporterName || after.reportedBy}${gLabel ? " · " + gLabel : ""}${details}\nReview: https://tri-valley-baseball-umpires.web.app/admin-incidents.html`;
      await Promise.allSettled(targets.map(url => postSlack(url, msg)));
    }
  }

  // ── Status change → push notification to reporter ─────────────────────────
  if (statusChanged && after.reportedBy) {
    try {
      const tokenSnap = await db.doc(`notifications/${after.reportedBy}`).get();
      const token = tokenSnap.exists ? tokenSnap.data()?.token : null;
      if (token) {
        const statusLabel = after.status === "reviewed" ? "Reviewed" : "Closed";
        const noteStr = after.adminNotes ? ` — ${after.adminNotes}` : "";
        const result = await getMessaging().sendEachForMulticast({
          tokens: [token],
          notification: {
            title: `📋 Report ${statusLabel}`,
            body: `Your ${after.incidentType || "incident"} report has been ${statusLabel.toLowerCase()}${noteStr}`,
          },
          webpush: { fcmOptions: { link: "https://tri-valley-baseball-umpires.web.app/incident.html" } },
        });
        if (result.responses[0]?.error) await tokenSnap.ref.delete();
      }
    } catch (e) {
      console.error("Incident status push error:", e);
    }
  }
});

// ── Notify umpires about open slots ──────────────────────────────────────────

exports.notifyOpenSlots = onCall({ cors: ["https://tri-valley-baseball-umpires.web.app", "https://tri-valley-baseball-umpires.firebaseapp.com"] }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in.");
  const db       = getFirestore();
  const adminDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const { gameId } = request.data || {};
  if (!gameId) throw new HttpsError("invalid-argument", "gameId required.");

  const gameSnap = await db.doc(`games/${gameId}`).get();
  if (!gameSnap.exists) throw new HttpsError("not-found", "Game not found.");
  const game = gameSnap.data();
  if (game.cancelled) throw new HttpsError("failed-precondition", "Game is cancelled.");

  const open = (game.umpireSlots || []).filter(s => !s.assignedUid);
  if (open.length === 0) throw new HttpsError("failed-precondition", "No open slots.");

  const slotTypes = open.map(s => s.type).join(", ");
  const label     = gameLabel(game);
  const msg       = `⚾ Umpires needed — ${slotTypes} slot${open.length !== 1 ? "s" : ""} open · ${label}\n${game.notes ? "📋 " + game.notes + "\n" : ""}Sign up: https://tri-valley-baseball-umpires.web.app/schedule.html`;

  const config  = await loadWebhookConfig(db);
  const div     = game.division ?? "";
  const targets = getTargetWebhooks(config, "openSlots", div);
  const sends = targets.map(url => postSlack(url, msg));
  if (sends.length) await Promise.allSettled(sends);

  // Push notification to all registered tokens
  const tokensSnap = await db.collection("notifications").get();
  const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
  let pushed = 0;
  if (tokens.length > 0) {
    const pushMsg  = `${slotTypes} slot${open.length !== 1 ? "s" : ""} open · ${fmtDateSlack(game.date)} ${game.city ?? ""} ${game.division ?? ""}`;
    const result   = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title: "⚾ Umpires needed", body: pushMsg },
      webpush: { fcmOptions: { link: "https://tri-valley-baseball-umpires.web.app/schedule.html" } }
    });
    pushed = result.successCount;
    // Clean up stale tokens
    const stale = result.responses.map((r, i) => r.error ? tokens[i] : null).filter(Boolean);
    if (stale.length > 0) {
      const batch = db.batch();
      for (const snap of tokensSnap.docs) {
        if (stale.includes(snap.data().token)) batch.delete(snap.ref);
      }
      await batch.commit();
    }
  }

  return { slacked: sends.length, pushed };
});

// ── Public facility schedule (no auth required) ───────────────────────────────

exports.getFacilitySchedule = onRequest({ cors: true }, async (req, res) => {
  const facilityId = req.query.facilityId;
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1); // 1-based

  if (!facilityId) { res.status(400).json({ error: "facilityId required" }); return; }

  const db = getFirestore();
  const facSnap = await db.doc(`facilities/${facilityId}`).get();
  if (!facSnap.exists) { res.status(404).json({ error: "Facility not found" }); return; }

  const fac = facSnap.data();
  const fieldNames = (fac.fields || []).map(f => f.name).filter(Boolean);

  // Date range for the requested month
  const mm = String(month).padStart(2, "0");
  const firstOfMonth = `${year}-${mm}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const lastOfMonth = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;

  let games = [], practices = [];
  if (fieldNames.length > 0) {
    const fieldSet = new Set(fieldNames);
    const [gSnap, pSnap] = await Promise.all([
      db.collection("games")
        .where("date", ">=", firstOfMonth)
        .where("date", "<=", lastOfMonth)
        .orderBy("date").orderBy("time").get(),
      db.collection("practices")
        .where("date", ">=", firstOfMonth)
        .where("date", "<=", lastOfMonth)
        .orderBy("date").get(),
    ]);
    games = gSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(g => fieldSet.has(g.field))
      .map(g => ({
        id: g.id, date: g.date, time: g.time, field: g.field,
        division: g.division, homeTeam: g.homeTeam, awayTeam: g.awayTeam,
        city: g.city, gameType: g.gameType,
        cancelled: g.cancelled, cancellationType: g.cancellationType,
      }));
    practices = pSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(p => fieldSet.has(p.field))
      .map(p => ({
        id: p.id, date: p.date, startTime: p.startTime, endTime: p.endTime,
        field: p.field, teamName: p.teamName, division: p.division,
      }));
  }

  res.json({
    facility: {
      id:           facSnap.id,
      name:         fac.name         || "",
      address:      fac.address      || "",
      googleMapsUrl: fac.googleMapsUrl || "",
      notes:        fac.notes        || "",
      fields:       (fac.fields || []).map(f => ({ name: f.name, notes: f.notes || "" })),
    },
    year, month, games, practices,
  });
});

// ── Notify assigned umpires of game cancellation / rainout / reschedule ──────

exports.notifyGameCancellation = onCall({ cors: CORS }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const db       = getFirestore();
  const adminDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const { gameId, type, notes } = request.data || {};
  if (!gameId) throw new HttpsError("invalid-argument", "gameId required.");

  const gameSnap = await db.doc(`games/${gameId}`).get();
  if (!gameSnap.exists) throw new HttpsError("not-found", "Game not found.");
  const game = gameSnap.data();

  // Collect UIDs of assigned umpires
  const assignedUids = [...new Set(
    (game.umpireSlots || []).filter(s => s.assignedUid).map(s => s.assignedUid)
  )];
  if (assignedUids.length === 0) return { notified: 0, slacked: 0 };

  const label     = gameLabel(game);
  const typeLabel = type === "rainout"     ? "🌧 Rain Out"
                  : type === "rescheduled" ? "🔄 Rescheduled"
                  :                         "⛔ Cancelled";
  const notesStr  = notes ? ` — ${notes}` : "";
  const pushTitle = type === "rainout"     ? "Game Rained Out"
                  : type === "rescheduled" ? "Game Rescheduled"
                  :                         "Game Cancelled";
  const pushBody  = `${label}${notesStr}`;
  const slackMsg  = `${typeLabel} · ${label}${notesStr}\n` +
    `Assigned: ${(game.umpireSlots || []).filter(s => s.assignedUid).map(s => s.assignedName || s.assignedUid).join(", ")}\n` +
    `These umpires will not be paid for this game.`;

  // Targeted push notifications to each assigned umpire
  const tokenSnaps = await Promise.all(
    assignedUids.map(uid => db.doc(`notifications/${uid}`).get())
  );
  const tokens = tokenSnaps.map(s => s.exists ? s.data()?.token : null).filter(Boolean);
  let pushed = 0;
  if (tokens.length > 0) {
    const result = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title: pushTitle, body: pushBody },
      webpush: { fcmOptions: { link: "https://tri-valley-baseball-umpires.web.app/schedule.html" } },
    });
    pushed = result.successCount;
    // Prune stale tokens
    const stale = result.responses.map((r, i) => r.error ? tokens[i] : null).filter(Boolean);
    if (stale.length > 0) {
      const batch = db.batch();
      for (const snap of tokenSnaps) {
        if (snap.exists && stale.includes(snap.data()?.token)) batch.delete(snap.ref);
      }
      await batch.commit();
    }
  }

  // Slack — gameChanges webhooks
  const config2  = await loadWebhookConfig(db);
  const div2     = game.division ?? "";
  const slackSends = getTargetWebhooks(config2, "gameChanges", div2).map(url => postSlack(url, slackMsg));
  if (slackSends.length) await Promise.allSettled(slackSends);

  return { notified: pushed, slacked: slackSends.length };
});

// ── Email broadcast to all active approved umpires ───────────────────────────

exports.sendBroadcastEmail = onCall({ cors: CORS, secrets: [GMAIL_USER, GMAIL_PASS] }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const db       = getFirestore();
  const adminDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const { subject, body } = request.data || {};
  if (!subject || !body) throw new HttpsError("invalid-argument", "subject and body are required.");

  // Fetch all approved, active umpires with a valid email
  const snap = await db.collection("umpires")
    .where("approved", "==", true)
    .get();

  const recipients = snap.docs
    .map(d => d.data())
    .filter(u => u.active !== false && u.email)
    .map(u => ({ name: u.name || "", email: u.email }));

  if (recipients.length === 0) return { sent: 0, failed: 0 };

  const transport = buildTransport();
  let sent = 0, failed = 0;

  await Promise.all(recipients.map(async r => {
    try {
      await transport.sendMail({
        from:    `"Tri-Valley Umpires" <${GMAIL_USER.value()}>`,
        to:      r.email,
        subject,
        text:    body,
        html:    `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <p>${body.replace(/\n/g, "<br>")}</p>
          <hr style="border:none;border-top:1px solid #333;margin:24px 0">
          <p style="color:#888;font-size:0.85rem">Tri-Valley Baseball Umpires &mdash;
            <a href="https://tri-valley-baseball-umpires.web.app">Portal</a></p>
        </div>`
      });
      sent++;
    } catch (_) {
      failed++;
    }
  }));

  return { sent, failed };
});

// ── Email pay stub to an individual umpire ───────────────────────────────────

exports.emailPayStub = onCall({ cors: CORS, secrets: [GMAIL_USER, GMAIL_PASS] }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const db       = getFirestore();
  const adminDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const { uid, fromDate, toDate } = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");

  // Fetch umpire profile + config in parallel
  const [umpSnap, ratesSnap, orgSnap, gamesSnap] = await Promise.all([
    db.doc(`umpires/${uid}`).get(),
    db.doc("config/payRates").get(),
    db.doc("config/orgSettings").get(),
    db.collection("games").orderBy("date", "asc").get(),
  ]);

  if (!umpSnap.exists) throw new HttpsError("not-found", "Umpire not found.");
  const ump = umpSnap.data();
  if (!ump.email) throw new HttpsError("failed-precondition", "Umpire has no email address on file.");

  const rates = ratesSnap.exists
    ? { plate: Number(ratesSnap.data().plate ?? 0), field: Number(ratesSnap.data().field ?? 0), extra: Number(ratesSnap.data().extra ?? 0) }
    : { plate: 0, field: 0, extra: 0 };
  const org   = orgSnap.exists ? orgSnap.data() : {};
  const brand = org.accentColor || "#601929";

  // Build rows for this umpire, filtered by date range
  const rows = [];
  gamesSnap.forEach(d => {
    const g = { id: d.id, ...d.data() };
    if (g.cancelled && g.cancellationType !== "rainout" && g.cancellationType !== "rescheduled") return;
    if (fromDate && g.date < fromDate) return;
    if (toDate   && g.date > toDate)   return;
    (g.umpireSlots ?? []).forEach(slot => {
      if (slot.assignedUid !== uid || slot.noShow) return;
      const configRate = rates[slot.type?.toLowerCase()] ?? 0;
      const pay = Number(slot.payRate ?? configRate);
      rows.push({ date: g.date, division: g.division ?? "", city: g.city ?? "", field: g.field ?? "",
        slotType: slot.type ?? "—", pay, paid: slot.paid === true });
    });
  });

  if (!rows.length) throw new HttpsError("not-found", "No payroll rows found for this umpire in the selected period.");

  rows.sort((a, b) => a.date.localeCompare(b.date));
  const owed    = rows.reduce((s, r) => s + r.pay, 0);
  const paid    = rows.filter(r => r.paid).reduce((s, r) => s + r.pay, 0);
  const balance = owed - paid;
  const today   = new Date().toLocaleDateString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "long", day: "numeric" });

  function fmtMoney(n) { return `$${n.toFixed(2)}`; }
  function fmtDt(iso) {
    if (!iso) return "—";
    const [y, m, d2] = iso.split("-");
    return `${Number(m)}/${Number(d2)}/${y}`;
  }

  const periodFrom = fromDate ? fmtDt(fromDate) : "All time";
  const periodTo   = toDate   ? fmtDt(toDate)   : today;
  const orgName    = org.assocName || "Tri-Valley Baseball";
  const coordName  = org.coordinatorName || "";
  const coordPhone = org.coordinatorPhone || "";
  const APP_URL    = "https://tri-valley-baseball-umpires.web.app";

  const gameRowsHtml = rows.map(r => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${fmtDt(r.date)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${r.division}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${r.city}${r.field ? " · " + r.field : ""}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${r.slotType}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmtMoney(r.pay)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;color:${r.paid ? "#2a7a3a" : "#b00"}">
        ${r.paid ? "Paid" : "Unpaid"}
      </td>
    </tr>`).join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><title>Pay Stub — ${ump.name}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;background:#fff;padding:32px 40px;max-width:720px;margin:0 auto">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid ${brand};padding-bottom:14px;margin-bottom:20px">
    <div>
      <div style="font-size:20px;font-weight:700;color:${brand}">${orgName}</div>
      <div style="font-size:12px;color:#555;margin-top:3px">Umpire Pay Statement</div>
    </div>
    <div style="text-align:right;font-size:12px;color:#555">
      <div>Issued: <strong>${today}</strong></div>
      <div>Period: ${periodFrom} – ${periodTo}</div>
    </div>
  </div>
  <div style="background:#f9f9f9;border-radius:6px;padding:14px 18px;margin-bottom:20px">
    <div style="font-size:16px;font-weight:600">${ump.name || ""}</div>
    ${ump.email ? `<div style="font-size:13px;color:#555">${ump.email}</div>` : ""}
  </div>
  <div style="display:flex;gap:16px;margin-bottom:20px">
    <div style="flex:1;background:#f0f0f0;border-radius:6px;padding:12px 16px;text-align:center">
      <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.05em">Total Earned</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px">${fmtMoney(owed)}</div>
    </div>
    <div style="flex:1;background:#f0f0f0;border-radius:6px;padding:12px 16px;text-align:center">
      <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.05em">Total Paid</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px;color:#2a7a3a">${fmtMoney(paid)}</div>
    </div>
    <div style="flex:1;background:${balance > 0 ? "#fff3f3" : "#f0fff4"};border-radius:6px;padding:12px 16px;text-align:center;border:1px solid ${balance > 0 ? "#fca5a5" : "#86efac"}">
      <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.05em">Balance Due</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px;color:${balance > 0 ? "#b91c1c" : "#15803d"}">${fmtMoney(balance)}</div>
    </div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead>
      <tr style="background:${brand};color:#fff">
        <th style="padding:8px 10px;text-align:left">Date</th>
        <th style="padding:8px 10px;text-align:left">Division</th>
        <th style="padding:8px 10px;text-align:left">Location</th>
        <th style="padding:8px 10px;text-align:left">Role</th>
        <th style="padding:8px 10px;text-align:right">Pay</th>
        <th style="padding:8px 10px;text-align:center">Status</th>
      </tr>
    </thead>
    <tbody>${gameRowsHtml}</tbody>
  </table>
  <div style="margin-top:24px;padding-top:16px;border-top:1px solid #ddd;font-size:11px;color:#888">
    <p>This is a payment record for officiating services rendered. It is not a tax document. Retain for your records.</p>
    ${coordName ? `<p>Questions? Contact ${coordName}${coordPhone ? " at " + coordPhone : ""} or visit <a href="${APP_URL}">${APP_URL}</a></p>` : ""}
  </div>
</body></html>`;

  const transport = buildTransport();
  await transport.sendMail({
    from:    `"${orgName}" <${GMAIL_USER.value()}>`,
    to:      ump.email,
    subject: `Pay Stub — ${ump.name} · ${periodFrom}${toDate ? " – " + periodTo : ""}`,
    html,
    text: `Pay Stub for ${ump.name}\nPeriod: ${periodFrom} – ${periodTo}\n\nTotal Earned: ${fmtMoney(owed)}\nTotal Paid: ${fmtMoney(paid)}\nBalance Due: ${fmtMoney(balance)}\n\nGames: ${rows.length}\n\nView your earnings: ${APP_URL}/earnings.html`,
  });

  return { sent: true, to: ump.email, rows: rows.length };
});

// ── FCM broadcast ─────────────────────────────────────────────────────────────

exports.sendBroadcast = onCall({ cors: CORS }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in.");
  const db       = getFirestore();
  const adminDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const { title, body, slackWebhook } = request.data || {};
  if (!title || !body) throw new HttpsError("invalid-argument", "title and body are required.");

  const tokensSnap = await db.collection("notifications").get();
  const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);

  // Send push notifications (skip if no tokens, but still post to Slack)
  let sent = 0, failed = 0;
  if (tokens.length > 0) {
    const result = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      webpush: { fcmOptions: { link: "https://tri-valley-baseball-umpires.web.app/" } }
    });
    sent   = result.successCount;
    failed = result.failureCount;

    // Remove stale tokens (unregistered or invalid)
    const stale = result.responses
      .map((r, i) => r.error ? tokens[i] : null)
      .filter(Boolean);
    if (stale.length > 0) {
      const batch = db.batch();
      for (const snap of tokensSnap.docs) {
        if (stale.includes(snap.data().token)) batch.delete(snap.ref);
      }
      await batch.commit();
    }
  }

  // Also post to Slack if a webhook was provided
  let slacked = false;
  const webhook = slackWebhook || (await loadWebhookConfig(db)).broadcast || null;
  if (webhook) {
    await postSlack(webhook, `📣 *${title}*\n${body}`).catch(() => {});
    slacked = true;
  }

  return { sent, failed, slacked };
});

// ── Phase 12: day-of reminders at 7 AM ───────────────────────────────────────

async function dayOfRemindersCore(db) {
  const config = await loadWebhookConfig(db);
  // early-exit guard: check if any webhook handles dayOfReminders
  const anyDayOf = Array.isArray(config.webhooks)
    ? config.webhooks.some(w => w.active !== false && w.url && (w.events||[]).includes("dayOfReminders"))
    : !!(config.jeff || config.ch10u || config.ch12u);

  const today = todayISO();

  // Slack only needs games with open slots (needsUmpires === true)
  const openSnap = await db.collection("games")
    .where("date", "==", today)
    .where("needsUmpires", "==", true)
    .get();

  // Push reminders go to ALL assigned umpires today, regardless of fill status
  const allTodaySnap = await db.collection("games")
    .where("date", "==", today)
    .get();

  // ── Slack channel reminders ──────────────────────────────────────────────
  let sent = 0;
  if (anyDayOf) {
    for (const d of openSnap.docs) {
      const g = d.data();
      if (g.cancelled) continue;
      const slots = (g.umpireSlots ?? [])
        .map(s => s.assignedName ? `${s.type}: ${s.assignedName}` : `${s.type}: OPEN`)
        .join(" | ");
      const msg     = `⚾ *Game today:* ${gameLabel(g)}\n${slots}`;
      const targets = getTargetWebhooks(config, "dayOfReminders", g.division ?? "");
      await Promise.allSettled(targets.map(url => postSlack(url, msg)));
      sent++;
    }
    if (sent === 0) {
      const targets = getTargetWebhooks(config, "dayOfReminders");
      await Promise.allSettled(targets.map(url =>
        postSlack(url, `📋 *${fmtDateSlack(today)}* — No games scheduled today.`)
      ));
    }
  }

  // ── Direct push to each assigned umpire ─────────────────────────────────
  // Collect uid → list of game summaries (all today's games, not just open ones)
  const uidGames = {};
  for (const d of allTodaySnap.docs) {
    const g = d.data();
    if (g.cancelled) continue;
    for (const slot of (g.umpireSlots ?? [])) {
      if (!slot.assignedUid) continue;
      if (!uidGames[slot.assignedUid]) uidGames[slot.assignedUid] = [];
      uidGames[slot.assignedUid].push({
        slotType: slot.type,
        game:     g,
      });
    }
  }

  const uids = Object.keys(uidGames);
  if (uids.length > 0) {
    try {
      const tokenSnaps = await Promise.all(uids.map(uid => db.doc(`notifications/${uid}`).get()));
      const messages   = [];
      const validSnaps = [];

      uids.forEach((uid, i) => {
        const snap2 = tokenSnaps[i];
        const token = snap2.exists ? snap2.data()?.token : null;
        if (!token) return;
        const entries = uidGames[uid];
        const body = entries.map(e => {
          const g = e.game;
          return `${e.slotType} · ${fmtTimeSlack(g.time)} · ${g.city ?? ""}${g.field ? " · " + g.field : ""}`;
        }).join("\n");
        messages.push({
          token,
          notification: {
            title: `⚾ Game${entries.length > 1 ? "s" : ""} Today`,
            body,
          },
          webpush: { fcmOptions: { link: "https://tri-valley-baseball-umpires.web.app/schedule.html" } },
        });
        validSnaps.push(snap2);
      });

      if (messages.length > 0) {
        const result = await getMessaging().sendEach(messages);
        // Prune stale tokens
        const stale = result.responses.map((r, i) => r.error ? validSnaps[i] : null).filter(Boolean);
        if (stale.length > 0) {
          const batch = db.batch();
          stale.forEach(s => batch.delete(s.ref));
          await batch.commit();
        }
      }
    } catch (e) {
      console.error("Day-of push error:", e);
    }
  }

  return { sent, pushed: uids.length };
}

exports.sendDayOfReminders = onSchedule("0 7 * * *", async () => {
  await dayOfRemindersCore(getFirestore());
});

exports.triggerDayOfReminders = onCall({ cors: CORS }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const db       = getFirestore();
  const adminDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");
  return dayOfRemindersCore(db);
});

// ── Daily game summary at 7 AM ────────────────────────────────────────────────
//
// Posts a single comprehensive message to the "Daily Game Summary" Slack channel
// listing every non-cancelled game today, the assigned umpire(s) per slot, each
// umpire's phone number, and parent contact info when available.

async function dailyGameSummaryCore(db) {
  const config  = await loadWebhookConfig(db);
  const targets = getTargetWebhooks(config, "dailySummary");
  if (!targets.length) return { sent: false, reason: "No webhook configured." };

  const today = todayISO();

  const snap = await db.collection("games")
    .where("date", "==", today)
    .get();

  const games = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(g => !g.cancelled)
    .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));

  if (!games.length) {
    await Promise.allSettled(targets.map(url => postSlack(url, `📋 *Daily Game Summary — ${fmtDateSlack(today)}*\n\nNo games scheduled today.`)));
    return { sent: true, games: 0 };
  }

  // Collect all unique assigned umpire UIDs across all games
  const uidSet = new Set();
  for (const g of games) {
    for (const s of (g.umpireSlots ?? [])) {
      if (s.assignedUid) uidSet.add(s.assignedUid);
    }
  }

  // Batch-fetch umpire profiles for contact info
  const umpireCache = {};
  if (uidSet.size > 0) {
    await Promise.all([...uidSet].map(async uid => {
      try {
        const d = await db.doc(`umpires/${uid}`).get();
        if (d.exists) umpireCache[uid] = d.data();
      } catch (_) {}
    }));
  }

  function slotLine(slot) {
    if (!slot.assignedUid) {
      return `  • ${slot.type}: _No umpire assigned_`;
    }
    const u = umpireCache[slot.assignedUid];
    const name  = slot.assignedName || (u && u.name) || slot.assignedUid;
    const phone = u && u.phone ? ` | 📞 ${u.phone}` : "";
    let line    = `  • ${slot.type}: *${name}*${phone}`;
    if (u && u.parentName) {
      const parentPhone = u.parentPhone ? ` | 📞 ${u.parentPhone}` : "";
      line += `\n    _Parent: ${u.parentName}${parentPhone}_`;
    }
    return line;
  }

  const blocks = games.map(g => {
    const slots     = g.umpireSlots ?? [];
    const header    = `*${fmtTimeSlack(g.time)} — ${g.division ?? ""} · ${g.city ?? ""}${g.field ? " · " + g.field : ""}*`;
    const teams     = [g.homeTeam, g.awayTeam].filter(Boolean).join(" vs ");
    const teamsLine = teams ? `  ${teams}` : "";
    const slotLines = slots.length
      ? slots.map(slotLine).join("\n")
      : "  _No umpire slots configured_";
    return [header, teamsLine, slotLines].filter(Boolean).join("\n");
  });

  const msg = `📋 *Daily Game Summary — ${fmtDateSlack(today)}*\n`
    + `${games.length} game${games.length !== 1 ? "s" : ""} today\n`
    + "─".repeat(32) + "\n\n"
    + blocks.join("\n\n");

  await Promise.allSettled(targets.map(url => postSlack(url, msg)));
  return { sent: true, games: games.length };
}

exports.sendDailyGameSummary = onSchedule("0 7 * * *", async () => {
  await dailyGameSummaryCore(getFirestore());
});

exports.triggerDailyGameSummary = onCall({ cors: CORS }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const db       = getFirestore();
  const adminDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");
  return dailyGameSummaryCore(db);
});

// ── Tournament field swap notification ───────────────────────────────────────

exports.notifyTournamentSwap = onCall({ cors: CORS }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in.");
  const db       = getFirestore();
  const adminDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const { tournamentName, game1, game2, umpires1 = [], umpires2 = [] } = request.data;

  // Collect affected UIDs — the umpires being moved to a new field
  const affectedUids = [
    ...umpires1.map(u => u.uid),
    ...umpires2.map(u => u.uid)
  ].filter(Boolean);

  // Send Slack notification
  const config  = await loadWebhookConfig(db);
  const swapTargets = getTargetWebhooks(config, "tournamentSwaps");
  if (swapTargets.length) {
    const names1 = umpires1.map(u => u.name).join(", ") || "none";
    const names2 = umpires2.map(u => u.name).join(", ") || "none";
    const msg = `🔄 *Field Swap — ${tournamentName}*\n`
      + `• ${game1.time} ${game1.field ? "(" + game1.field + ")" : ""} ↔ ${game2.time} ${game2.field ? "(" + game2.field + ")" : ""}\n`
      + `• ${names1} ⇄ ${names2}`;
    await Promise.allSettled(swapTargets.map(url => postSlack(url, msg)));
  }

  // Send FCM push to affected umpires
  if (!affectedUids.length) return { sent: 0 };

  const tokenDocs = await Promise.all(
    affectedUids.map(uid => db.doc(`notifications/${uid}`).get())
  );
  const tokens = tokenDocs.map(d => d.exists ? d.data().token : null).filter(Boolean);
  if (!tokens.length) return { sent: 0 };

  const messaging = getMessaging();
  const result    = await messaging.sendEachForMulticast({
    tokens,
    notification: {
      title: `⇄ Field Swap — ${tournamentName}`,
      body:  `Your field assignment has changed. Check the schedule for your new game.`
    },
    webpush: { fcmOptions: { link: "/schedule.html" } }
  });

  // Remove stale tokens
  const stale = [];
  result.responses.forEach((r, i) => {
    if (!r.success && r.error?.code === "messaging/registration-token-not-registered") {
      stale.push(tokens[i]);
    }
  });
  if (stale.length) {
    // tokenDocs already fetched above — no need to scan the full notifications collection
    const batch = db.batch();
    tokenDocs.forEach(d => {
      if (d.exists && stale.includes(d.data()?.token)) batch.delete(d.ref);
    });
    await batch.commit();
  }

  return { sent: result.successCount };
});

// ── Update umpire account (super admin only) ──────────────────────────────────
// Updates Firebase Auth (email, displayName) and Firestore profile fields.
// Email changes update the auth account so the umpire can sign in with the new address.

exports.updateUmpireAccount = onCall({ cors: CORS }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const db       = getFirestore();
  const adminDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const adminData = adminDoc.data();
  const isSA = adminData.superAdmin === true || (adminData.roles || []).length === 0;
  if (!isSA) throw new HttpsError("permission-denied", "Super admin access required.");

  const {
    uid,
    firstName, lastName, email, phone,
    street, city, state, zip,
    certifications, notes, approved,
    parents,
    parentName, parentEmail, parentPhone,
    emergencyContactName, emergencyContactPhone
  } = request.data;

  if (!uid) throw new HttpsError("invalid-argument", "uid is required.");

  const adminAuth = getAuth();

  // Build Firebase Auth update (only fields that are being changed)
  const authUpdate = {};
  if (email)                    authUpdate.email       = email.trim().toLowerCase();
  if (firstName || lastName)    authUpdate.displayName = `${(firstName || "").trim()} ${(lastName || "").trim()}`.trim();

  if (Object.keys(authUpdate).length > 0) {
    await adminAuth.updateUser(uid, authUpdate);
  }

  // Build Firestore profile update
  const firestoreUpdate = {};
  if (firstName !== undefined)       firestoreUpdate.firstName = firstName.trim();
  if (lastName  !== undefined)       firestoreUpdate.lastName  = lastName.trim();
  if (firstName !== undefined || lastName !== undefined) {
    firestoreUpdate.name = `${(firstName || "").trim()} ${(lastName || "").trim()}`.trim();
  }
  if (email     !== undefined)       firestoreUpdate.email     = email.trim().toLowerCase();
  if (phone     !== undefined)       firestoreUpdate.phone     = phone.trim();
  if (street    !== undefined)       firestoreUpdate.street    = street.trim();
  if (city      !== undefined)       firestoreUpdate.city      = city.trim();
  if (state     !== undefined)       firestoreUpdate.state     = state;
  if (zip       !== undefined)       firestoreUpdate.zip       = zip.trim();
  if (certifications !== undefined)  firestoreUpdate.certifications = certifications;
  if (notes       !== undefined)     firestoreUpdate.notes       = notes.trim();
  if (approved    !== undefined)     firestoreUpdate.approved    = approved;
  if (Array.isArray(parents))        firestoreUpdate.parents     = parents;
  if (parentName  !== undefined)     firestoreUpdate.parentName  = parentName.trim();
  if (parentEmail !== undefined)     firestoreUpdate.parentEmail = parentEmail.trim().toLowerCase();
  if (parentPhone !== undefined)     firestoreUpdate.parentPhone = parentPhone.trim();
  // Sync flat backward-compat fields from parents[0] when the full array is being saved
  if (Array.isArray(parents)) {
    const fp = parents[0] || null;
    firestoreUpdate.parentName  = fp?.name  || "";
    firestoreUpdate.parentEmail = fp?.email || "";
    firestoreUpdate.parentPhone = fp?.phone || "";
  }
  // If a parent/guardian is set, they are always the emergency contact
  const resolvedParentName  = (firestoreUpdate.parentName  ?? parentName  ?? "").trim();
  const resolvedParentPhone = (firestoreUpdate.parentPhone ?? parentPhone ?? "").trim();
  if (resolvedParentName) {
    firestoreUpdate.emergencyContactName  = resolvedParentName;
    firestoreUpdate.emergencyContactPhone = resolvedParentPhone || (emergencyContactPhone?.trim() ?? "");
  } else {
    if (emergencyContactName  !== undefined) firestoreUpdate.emergencyContactName  = emergencyContactName.trim();
    if (emergencyContactPhone !== undefined) firestoreUpdate.emergencyContactPhone = emergencyContactPhone.trim();
  }

  if (Object.keys(firestoreUpdate).length > 0) {
    await db.doc(`umpires/${uid}`).update(firestoreUpdate);
  }

  return { success: true };
});

// ── Create admin user (super admin only) ──────────────────────────────────────
// Looks up or creates a Firebase Auth account for the given email, then writes
// their doc to the admins collection. Returns a password-reset link for newly
// created accounts so the super admin can share a one-time setup URL with them.

exports.createAdminUser = onCall({ cors: CORS, secrets: [GMAIL_USER, GMAIL_PASS] }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const db         = getFirestore();
  const callerDoc  = await db.doc(`admins/${request.auth.uid}`).get();
  if (!callerDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");
  const callerData = callerDoc.data();
  const isSA = callerData.superAdmin === true || (callerData.roles || []).length === 0;
  if (!isSA) throw new HttpsError("permission-denied", "Super admin access required.");

  const { email, name, superAdmin: makeSA, roles } = request.data;
  if (!email) throw new HttpsError("invalid-argument", "email is required.");

  const adminAuth = getAuth();
  let uid;
  let isNew     = false;
  let resetLink = null;

  // Look up existing Firebase Auth user; create if absent
  try {
    const existing = await adminAuth.getUserByEmail(email.toLowerCase().trim());
    uid = existing.uid;
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      const created = await adminAuth.createUser({
        email:        email.toLowerCase().trim(),
        displayName:  name || email,
        emailVerified: false,
      });
      uid   = created.uid;
      isNew = true;
    } else {
      throw new HttpsError("internal", err.message);
    }
  }

  // Generate a password-setup link for brand-new accounts
  if (isNew) {
    try {
      resetLink = await adminAuth.generatePasswordResetLink(
        email.toLowerCase().trim(),
        { url: "https://tri-valley-baseball-umpires.web.app/admin.html" }
      );
    } catch (linkErr) {
      console.error("generatePasswordResetLink failed:", linkErr.message);
      // resetLink stays null — email will fall back to "use Forgot Password" instructions
    }
  }

  // Ensure they aren't already an admin
  const adminDocRef    = db.doc(`admins/${uid}`);
  const existingAdmin  = await adminDocRef.get();
  if (existingAdmin.exists) throw new HttpsError("already-exists", "This user is already an admin.");

  await adminDocRef.set({
    superAdmin: makeSA === true,
    roles:      makeSA ? [] : (roles || []),
    name:       name  || "",
    email:      email.toLowerCase().trim(),
    addedAt:    new Date().toISOString(),
    addedBy:    request.auth.uid,
  });

  // Send welcome email (non-fatal — don't block the response if mail fails)
  try {
    const transport = buildTransport();
    const mailOptions = buildAdminWelcomeEmail({
      name,
      email:     email.toLowerCase().trim(),
      isSA:      makeSA === true,
      roles:     makeSA ? [] : (roles || []),
      isNew,
      resetLink,
    });
    await transport.sendMail(mailOptions);
  } catch (mailErr) {
    console.error("Admin welcome email failed:", mailErr.message);
    // Still return success — the admin was created; email failure is non-fatal
  }

  return { uid, isNew, resetLink };
});

// ── Create umpire account (admin) ────────────────────────────────────────────
// Creates a Firebase Auth user + approved umpires/{uid} doc. Sends a password
// setup email to the new umpire so they can sign in.

exports.createUmpireAccount = onCall({ cors: CORS, secrets: [GMAIL_USER, GMAIL_PASS] }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const db        = getFirestore();
  const callerDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!callerDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const { firstName, lastName, email, phone } = request.data;
  if (!email || !firstName || !lastName)
    throw new HttpsError("invalid-argument", "firstName, lastName, and email are required.");

  const adminAuth = getAuth();
  let uid; let isNew = false; let resetLink = null;
  try {
    const existing = await adminAuth.getUserByEmail(email.toLowerCase().trim());
    uid = existing.uid;
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw new HttpsError("internal", err.message);
    const created = await adminAuth.createUser({
      email:        email.toLowerCase().trim(),
      displayName:  `${firstName} ${lastName}`,
      emailVerified: false,
    });
    uid = created.uid; isNew = true;
  }

  // Don't overwrite an existing umpire profile
  const umpRef = db.doc(`umpires/${uid}`);
  const existing = await umpRef.get();
  if (existing.exists) throw new HttpsError("already-exists", "An umpire profile already exists for this email.");

  await umpRef.set({
    firstName, lastName,
    name:  `${firstName} ${lastName}`,
    email: email.toLowerCase().trim(),
    phone: phone || "",
    approved: true,
    active:   true,
    createdAt: new Date().toISOString(),
    createdBy: request.auth.uid,
  });

  if (isNew) {
    try {
      resetLink = await adminAuth.generatePasswordResetLink(
        email.toLowerCase().trim(),
        { url: "https://tri-valley-baseball-umpires.web.app/index.html" }
      );
    } catch (_) {}
  }

  // Welcome email (non-fatal)
  try {
    const APP_URL = "https://tri-valley-baseball-umpires.web.app";
    const transport = buildTransport();
    await transport.sendMail({
      from:    `"Tri-Valley Umpires" <${GMAIL_USER.value()}>`,
      to:      email.toLowerCase().trim(),
      subject: "Your Tri-Valley Umpire account is ready",
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#1a1a2e;color:#e8e8f0;padding:32px;border-radius:12px">
        <h2 style="color:#7ec8f7;margin-top:0">Welcome to Tri-Valley Baseball Umpires!</h2>
        <p>Hi ${firstName},</p>
        <p>An administrator has created an umpire account for you on the Tri-Valley Baseball Umpires platform. Your account is already approved and ready to use.</p>
        ${resetLink
          ? `<p><a href="${resetLink}" style="background:#601929;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Set Your Password</a></p>
             <p style="color:#aaa;font-size:0.85rem">This link expires in 24 hours. After setting your password you can sign in at <a href="${APP_URL}" style="color:#7ec8f7">${APP_URL}</a>.</p>`
          : `<p>Sign in at <a href="${APP_URL}" style="color:#7ec8f7">${APP_URL}</a> using your email address. If you haven't set a password, use the Forgot Password link.</p>`}
      </div>`,
    });
  } catch (mailErr) { console.error("Umpire welcome email failed:", mailErr.message); }

  return { uid, isNew, resetLink };
});

// ── Create coach account (admin) ──────────────────────────────────────────────
// Creates a Firebase Auth user + approved coaches/{uid} doc. Sends a password
// setup email to the new coach.

exports.createCoachAccount = onCall({ cors: CORS, secrets: [GMAIL_USER, GMAIL_PASS] }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const db        = getFirestore();
  const callerDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!callerDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const { firstName, lastName, email, phone, teamName, division, city, existingDocId } = request.data;
  if (!email || !firstName || !lastName)
    throw new HttpsError("invalid-argument", "firstName, lastName, and email are required.");

  const adminAuth = getAuth();
  let uid; let isNew = false; let resetLink = null;
  try {
    const existing = await adminAuth.getUserByEmail(email.toLowerCase().trim());
    uid = existing.uid;
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw new HttpsError("internal", err.message);
    const created = await adminAuth.createUser({
      email:        email.toLowerCase().trim(),
      displayName:  `${firstName} ${lastName}`,
      emailVerified: false,
    });
    uid = created.uid; isNew = true;
  }

  const coachRef = db.doc(`coaches/${uid}`);

  if (existingDocId && existingDocId !== uid) {
    // Upgrading a no-sign-in coach record: migrate to the auth-UID-keyed path and delete the old doc.
    const oldRef  = db.doc(`coaches/${existingDocId}`);
    const oldSnap = await oldRef.get();
    const oldData = oldSnap.exists ? oldSnap.data() : {};
    await coachRef.set({
      ...oldData,
      name:        `${firstName} ${lastName}`,
      email:       email.toLowerCase().trim(),
      phone:       phone    || oldData.phone    || "",
      teamName:    teamName || oldData.teamName || "",
      division:    division || oldData.division || "",
      city:        city     || oldData.city     || "",
      allowSignIn: true,
      role:        "coach",
      upgradedAt:  new Date().toISOString(),
    });
    if (oldSnap.exists) await oldRef.delete();
  } else {
    const existing = await coachRef.get();
    if (existing.exists) throw new HttpsError("already-exists", "A coach profile already exists for this email.");
    await coachRef.set({
      name:     `${firstName} ${lastName}`,
      email:    email.toLowerCase().trim(),
      phone:    phone    || "",
      teamName: teamName || "",
      division: division || "",
      city:     city     || "",
      approved: true,
      active:   true,
      role:     "coach",
      createdAt: new Date().toISOString(),
      createdBy: request.auth.uid,
    });
  }

  if (isNew) {
    try {
      resetLink = await adminAuth.generatePasswordResetLink(
        email.toLowerCase().trim(),
        { url: "https://tri-valley-baseball-umpires.web.app/coach-portal.html" }
      );
    } catch (_) {}
  }

  let emailSent = false;
  try {
    const APP_URL = "https://tri-valley-baseball-umpires.web.app";
    const transport = buildTransport();
    await transport.sendMail({
      from:    `"Tri-Valley Umpires" <${GMAIL_USER.value()}>`,
      to:      email.toLowerCase().trim(),
      subject: "Your Tri-Valley Coach Portal account is ready",
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#1a1a2e;color:#e8e8f0;padding:32px;border-radius:12px">
        <h2 style="color:#7ec8f7;margin-top:0">Welcome to the Tri-Valley Coach Portal!</h2>
        <p>Hi ${firstName},</p>
        <p>An administrator has created a coach account for you${teamName ? ` for <strong>${teamName}</strong>` : ""}. Your account is active and ready to use.</p>
        ${resetLink
          ? `<p><a href="${resetLink}" style="background:#601929;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Set Your Password</a></p>
             <p style="color:#aaa;font-size:0.85rem">This link expires in 24 hours. After setting your password you can sign in at <a href="${APP_URL}/coach-portal.html" style="color:#7ec8f7">the Coach Portal</a>.</p>`
          : `<p>Sign in at <a href="${APP_URL}/coach-portal.html" style="color:#7ec8f7">the Coach Portal</a> using your email address.</p>`}
      </div>`,
    });
    emailSent = true;
  } catch (mailErr) { console.error("Coach welcome email failed:", mailErr.message); }

  return { uid, isNew, resetLink, emailSent };
});

// ── Delete umpire account (super admin only) ──────────────────────────────────
// Permanently removes the Firestore umpire profile AND the Firebase Auth account.

exports.deleteUmpireAccount = onCall({ cors: CORS }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const db         = getFirestore();
  const callerDoc  = await db.doc(`admins/${request.auth.uid}`).get();
  if (!callerDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");
  const callerData = callerDoc.data();
  const isSA = callerData.superAdmin === true || (callerData.roles || []).length === 0;
  if (!isSA) throw new HttpsError("permission-denied", "Super admin access required.");

  const { uid } = request.data;
  if (!uid) throw new HttpsError("invalid-argument", "uid is required.");

  const adminAuth = getAuth();

  // Delete Firestore profile first
  await db.doc(`umpires/${uid}`).delete();

  // Delete Firebase Auth account (ok if already gone)
  try {
    await adminAuth.deleteUser(uid);
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw new HttpsError("internal", err.message);
  }

  return { success: true };
});

// ── onUmpireApproved — welcome email + password-setup link when approved ─────
exports.onUmpireApproved = onDocumentWritten(
  { document: "umpires/{uid}", secrets: [GMAIL_USER, GMAIL_PASS] },
  async event => {
    // Only fire when approved flips to true (not on create, not on delete)
    const before = event.data.before?.data() ?? null;
    const after  = event.data.after?.data()  ?? null;
    if (!before || !after) return; // create or delete — handled by onUmpireRegistered
    if (before.approved === true) return;  // already was approved
    if (after.approved  !== true) return;  // not newly approved
    if (after.denied === true)    return;  // safety guard

    const uid   = event.params.uid;
    const email = after.email;
    const name  = after.name || `${after.firstName || ""} ${after.lastName || ""}`.trim() || email;

    if (!email) { console.log(`onUmpireApproved: no email for uid ${uid}`); return; }

    const APP_URL = "https://tri-valley-baseball-umpires.web.app";
    const adminAuth = getAuth();

    // Generate a password-setup link (acts as first-time password set)
    let resetLink = null;
    try {
      resetLink = await adminAuth.generatePasswordResetLink(
        email, { url: `${APP_URL}/schedule.html` }
      );
    } catch (err) {
      console.error("onUmpireApproved: generatePasswordResetLink failed:", err.message);
    }

    const signinHtml = resetLink
      ? `<p style="margin:0 0 8px">Use the button below to set your password — <strong>this link expires after one use.</strong></p>
         <p style="margin:0 0 12px">
           <a href="${resetLink}" style="display:inline-block;background:#601929;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:1rem">Set Your Password →</a>
         </p>
         <p style="margin:0 0 6px;font-size:0.85em;color:#aaa">Or copy this link into your browser:</p>
         <p style="margin:0;font-size:0.75em;color:#888;word-break:break-all;font-family:monospace">${resetLink}</p>
         <p style="margin:10px 0 0;font-size:0.85em;color:#aaa">If the link has expired, visit <a href="${APP_URL}" style="color:#7ec8f7">${APP_URL}</a> and click <strong>"Forgot Password"</strong>.</p>`
      : `<p style="margin:0 0 8px">To sign in for the first time:</p>
         <ol style="margin:0;padding-left:20px;color:#ccc">
           <li>Go to <a href="${APP_URL}" style="color:#7ec8f7">${APP_URL}</a></li>
           <li>Click <strong>Sign In</strong> → <strong>Forgot Password</strong></li>
           <li>Enter <strong>${email}</strong> and check your inbox</li>
         </ol>`;

    const signinText = resetLink
      ? `Set your password here (expires after one use):\n${resetLink}\n\nIf expired, go to ${APP_URL} and click "Forgot Password".`
      : `To sign in: go to ${APP_URL}, click "Sign In" → "Forgot Password", and enter ${email}.`;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d0d1a;font-family:Arial,sans-serif;color:#e0e0e0">
  <table style="max-width:600px;margin:32px auto;border-radius:10px;overflow:hidden;border:1px solid #2a2a4a">
    <tr><td style="background:#601929;padding:24px 28px">
      <h1 style="margin:0;color:#fff;font-size:1.4rem">⚾ Tri-Valley Baseball Umpires</h1>
      <p style="margin:6px 0 0;color:#b8f0b8;font-size:0.9rem">Your account is approved!</p>
    </td></tr>
    <tr><td style="background:#1a1a2e;padding:24px 28px">
      <p style="margin:0 0 12px">Hi ${name},</p>
      <p style="margin:0">Your umpire account has been <strong>approved</strong>. You can now sign in and claim open game slots on the schedule.</p>
    </td></tr>
    <tr><td style="background:#12122a;padding:20px 28px;border-top:1px solid #2a2a4a">
      <h2 style="margin:0 0 12px;font-size:1rem;color:#7ec8f7;text-transform:uppercase;letter-spacing:0.05em">Set Up Your Password</h2>
      ${signinHtml}
    </td></tr>
    <tr><td style="background:#1a1a2e;padding:20px 28px;border-top:1px solid #2a2a4a">
      <h2 style="margin:0 0 10px;font-size:1rem;color:#7ec8f7;text-transform:uppercase;letter-spacing:0.05em">Game Schedule</h2>
      <p style="margin:0 0 12px">Once signed in, visit the schedule to see open games and sign up for slots:</p>
      <a href="${APP_URL}/schedule.html" style="display:inline-block;background:#1e3a5f;color:#7ec8f7;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold">${APP_URL}/schedule.html</a>
    </td></tr>
    <tr><td style="background:#0d0d1a;padding:16px 28px;border-top:1px solid #2a2a4a;font-size:0.82rem;color:#666">
      <p style="margin:0">Questions? Contact Jeff Althoff: <a href="tel:6053800229" style="color:#7ec8f7">605-380-0229</a> (urgent only)</p>
    </td></tr>
  </table>
</body>
</html>`;

    const text = [
      `Hi ${name},`,
      ``,
      `Your umpire account has been approved! You can now sign in and claim open game slots.`,
      ``,
      signinText,
      ``,
      `Game schedule: ${APP_URL}/schedule.html`,
      ``,
      `Questions? Contact Jeff Althoff: 605-380-0229 (urgent only).`,
    ].join("\n");

    let transport;
    try { transport = buildTransport(); }
    catch (err) { console.error("onUmpireApproved: failed to build transport:", err.message); return; }

    try {
      await transport.sendMail({
        from:    `"Tri-Valley Baseball Umpires" <${GMAIL_USER.value()}>`,
        to:      email,
        subject: "You're approved — Tri-Valley Baseball Umpires",
        html,
        text,
      });
      console.log(`onUmpireApproved: welcome email sent to ${email}`);
    } catch (err) {
      console.error("onUmpireApproved: failed to send email:", err.message);
    }
  }
);

// ── createManualUmpire — add umpire record without Firebase Auth credentials ───
// Admin-only. Creates an approved umpires/{autoId} doc with noCredentials:true.
// Credentials can be added later via grantUmpireCredentials.
exports.createManualUmpire = onCall({ cors: CORS }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const db        = getFirestore();
  const callerDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!callerDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const { firstName, lastName, email, phone } = request.data;
  if (!firstName || !lastName)
    throw new HttpsError("invalid-argument", "firstName and lastName are required.");

  const docRef = await db.collection("umpires").add({
    firstName,
    lastName,
    name:          `${firstName} ${lastName}`,
    email:         email ? email.toLowerCase().trim() : "",
    phone:         phone ? phone.trim()               : "",
    approved:      true,
    active:        true,
    noCredentials: true,
    createdAt:     new Date().toISOString(),
    createdBy:     request.auth.uid,
  });

  return { id: docRef.id };
});

// ── grantUmpireCredentials — create login for a no-credentials umpire ─────────
// Migrates an existing noCredentials umpire doc to a new Auth-keyed doc:
//   1. Creates a Firebase Auth account with the provided email.
//   2. Writes umpires/{newUid} copying the existing data.
//   3. Deletes umpires/{oldDocId}.
//   4. Sends a password-setup welcome email.
exports.grantUmpireCredentials = onCall({ cors: CORS, secrets: [GMAIL_USER, GMAIL_PASS] }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const db        = getFirestore();
  const callerDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!callerDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const { docId, email } = request.data;
  if (!docId || !email)
    throw new HttpsError("invalid-argument", "docId and email are required.");

  const cleanEmail = email.toLowerCase().trim();

  // Fetch the existing manual umpire doc
  const oldRef  = db.doc(`umpires/${docId}`);
  const oldSnap = await oldRef.get();
  if (!oldSnap.exists) throw new HttpsError("not-found", "Umpire record not found.");
  const oldData = oldSnap.data();
  if (!oldData.noCredentials)
    throw new HttpsError("failed-precondition", "This umpire already has login credentials.");

  const adminAuth = getAuth();
  let uid; let isNew = false; let resetLink = null;

  try {
    const existing = await adminAuth.getUserByEmail(cleanEmail);
    uid = existing.uid;
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw new HttpsError("internal", err.message);
    const created = await adminAuth.createUser({
      email:         cleanEmail,
      displayName:   oldData.name,
      emailVerified: false,
    });
    uid = created.uid; isNew = true;
  }

  // Ensure no existing umpire doc for this Auth uid
  const newRef  = db.doc(`umpires/${uid}`);
  const newSnap = await newRef.get();
  if (newSnap.exists)
    throw new HttpsError("already-exists", "A profile already exists for this email address.");

  // Migrate: write auth-keyed doc (without noCredentials flag), delete manual doc
  const { noCredentials: _drop, ...baseData } = oldData;
  const newData = { ...baseData, email: cleanEmail };
  const batch = db.batch();
  batch.set(newRef, newData);
  batch.delete(oldRef);
  await batch.commit();

  // Generate password reset link
  try {
    resetLink = await adminAuth.generatePasswordResetLink(cleanEmail,
      { url: "https://tri-valley-baseball-umpires.web.app/index.html" });
  } catch (_) {}

  // Welcome email (non-fatal)
  try {
    const APP_URL  = "https://tri-valley-baseball-umpires.web.app";
    const firstName = oldData.firstName || (oldData.name || "").split(" ")[0] || "there";
    const transport = buildTransport();
    await transport.sendMail({
      from:    `"Tri-Valley Umpires" <${GMAIL_USER.value()}>`,
      to:      cleanEmail,
      subject: "Your Tri-Valley Umpire account is ready",
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#1a1a2e;color:#e8e8f0;padding:32px;border-radius:12px">
        <h2 style="color:#7ec8f7;margin-top:0">Welcome to Tri-Valley Baseball Umpires!</h2>
        <p>Hi ${firstName},</p>
        <p>Your Tri-Valley Baseball Umpires account now has login access. It is already approved and ready to use.</p>
        ${resetLink
          ? `<p><a href="${resetLink}" style="background:#601929;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Set Your Password</a></p>
             <p style="color:#aaa;font-size:0.85rem">This link expires in 24 hours. After setting your password you can sign in at <a href="${APP_URL}" style="color:#7ec8f7">${APP_URL}</a>.</p>`
          : `<p>Sign in at <a href="${APP_URL}" style="color:#7ec8f7">${APP_URL}</a> using your email address.</p>`}
      </div>`,
    });
  } catch (mailErr) { console.error("grantUmpireCredentials welcome email failed:", mailErr.message); }

  return { uid, isNew };
});

// ── getUmpireAuthStatus — Firebase Auth metadata for every umpire (admin) ─────
exports.getUmpireAuthStatus = onCall({ cors: CORS }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const db       = getFirestore();
  const adminDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const umpSnap = await db.collection("umpires").get();
  const uids    = umpSnap.docs.map(d => d.id);
  if (uids.length === 0) return {};

  const adminAuth = getAuth();
  const result    = {};
  const CHUNK     = 100;

  for (let i = 0; i < uids.length; i += CHUNK) {
    const chunk = uids.slice(i, i + CHUNK);
    const { users, notFound } = await adminAuth.getUsers(
      chunk.map(uid => ({ uid }))
    );
    for (const u of users) {
      result[u.uid] = {
        lastSignInTime: u.metadata.lastSignInTime || null,
        emailVerified:  u.emailVerified,
        hasPassword:    !!u.passwordHash,
        disabled:       u.disabled,
      };
    }
    for (const id of (notFound || [])) {
      const uid = typeof id === "string" ? id : id.uid;
      result[uid] = { lastSignInTime: null, emailVerified: false, hasPassword: false, disabled: false, noAuthAccount: true };
    }
  }

  return result;
});

// ── onUmpireRegistered — notify admins (and parent if minor) when a new
//    umpire registers. Replaces the client-side EmailJS calls in form.js.
exports.onUmpireRegistered = onDocumentWritten(
  { document: "umpires/{uid}", secrets: [GMAIL_USER, GMAIL_PASS] },
  async event => {
    // Only fire on creates (before == null), not updates or deletes
    if (event.data.before && event.data.before.exists) return;
    const after = event.data.after;
    if (!after || !after.exists) return;
    // Skip admin-created accounts (createUmpireAccount / createManualUmpire set createdBy)
    if (after.data().createdBy) return;

    const d = after.data();
    const APP_URL  = "https://tri-valley-baseball-umpires.web.app";
    const ADMIN_URL = `${APP_URL}/admin.html`;

    const address = [d.street, d.city, d.state, d.zip].filter(Boolean).join(", ");
    const datetime = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });

    const adminHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d0d1a;font-family:Arial,sans-serif;color:#e0e0e0">
  <table style="max-width:600px;margin:32px auto;border-radius:10px;overflow:hidden;border:1px solid #2a2a4a">
    <tr><td style="background:#601929;padding:24px 28px">
      <h1 style="margin:0;color:#fff;font-size:1.4rem">⚾ Tri-Valley Baseball Umpires</h1>
      <p style="margin:6px 0 0;color:#ffb0b0;font-size:0.9rem">New Umpire Registration</p>
    </td></tr>
    <tr><td style="background:#1a1a2e;padding:24px 28px">
      <p style="margin:0 0 12px">A new umpire has submitted an acknowledgment and is waiting for approval.</p>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:6px 10px;border-bottom:1px solid #333;font-weight:bold;width:120px">Name</td>
            <td style="padding:6px 10px;border-bottom:1px solid #333">${d.name || ""}</td></tr>
        <tr><td style="padding:6px 10px;border-bottom:1px solid #333;font-weight:bold">Email</td>
            <td style="padding:6px 10px;border-bottom:1px solid #333">${d.email || ""}</td></tr>
        <tr><td style="padding:6px 10px;border-bottom:1px solid #333;font-weight:bold">Phone</td>
            <td style="padding:6px 10px;border-bottom:1px solid #333">${d.phone || ""}</td></tr>
        <tr><td style="padding:6px 10px;border-bottom:1px solid #333;font-weight:bold">Address</td>
            <td style="padding:6px 10px;border-bottom:1px solid #333">${address}</td></tr>
        <tr><td style="padding:6px 10px;border-bottom:1px solid #333;font-weight:bold">Signature</td>
            <td style="padding:6px 10px;border-bottom:1px solid #333">${d.signature || ""}</td></tr>
        <tr><td style="padding:6px 10px;font-weight:bold">Submitted</td>
            <td style="padding:6px 10px">${datetime}</td></tr>
      </table>
    </td></tr>
    <tr><td style="background:#12122a;padding:20px 28px;border-top:1px solid #2a2a4a;text-align:center">
      <a href="${ADMIN_URL}" style="display:inline-block;background:#601929;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold">Review in Admin Panel →</a>
    </td></tr>
  </table>
</body>
</html>`;

    const adminText = `New umpire registration:\nName: ${d.name || ""}\nEmail: ${d.email || ""}\nPhone: ${d.phone || ""}\nAddress: ${address}\nSubmitted: ${datetime}\n\nReview at ${ADMIN_URL}`;

    let transport;
    try {
      transport = buildTransport();
    } catch (err) {
      console.error("onUmpireRegistered: failed to build transport", err);
      return;
    }

    // Build list of parent emails to notify — prefer new parents[] array, fall
    // back to the flat parentEmail field for profiles registered before multi-parent.
    const parentRecipients = (() => {
      const arr = Array.isArray(d.parents) ? d.parents : [];
      const fromArray = arr.filter(p => p && p.email);
      if (fromArray.length) return fromArray; // [{name, email, ...}]
      if (d.parentEmail) return [{ name: d.parentName || "", email: d.parentEmail }];
      return [];
    })();

    function makeParentEmail(parentName) {
      const greeting = parentName ? `Hi ${parentName},` : "Hi Parent/Guardian,";
      return {
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d0d1a;font-family:Arial,sans-serif;color:#e0e0e0">
  <table style="max-width:600px;margin:32px auto;border-radius:10px;overflow:hidden;border:1px solid #2a2a4a">
    <tr><td style="background:#601929;padding:24px 28px">
      <h1 style="margin:0;color:#fff;font-size:1.4rem">⚾ Tri-Valley Baseball Umpires</h1>
      <p style="margin:6px 0 0;color:#ffb0b0;font-size:0.9rem">Umpire Registration Confirmation</p>
    </td></tr>
    <tr><td style="background:#1a1a2e;padding:24px 28px">
      <p style="margin:0 0 12px">${greeting}</p>
      <p style="margin:0 0 12px">This confirms that <strong>${d.name || ""}</strong> has submitted an umpire acknowledgment for the Tri-Valley Baseball Umpires program.</p>
      <p style="margin:0 0 12px">Their account is pending administrator approval, which typically takes 1–2 business days. Once approved, they'll be able to sign up for games at:</p>
      <p style="margin:0 0 12px"><a href="${APP_URL}" style="color:#7ec8f7">${APP_URL}</a></p>
      <p style="margin:0;font-size:0.85em;color:#aaa">Questions? Contact the league administrator.</p>
    </td></tr>
  </table>
</body>
</html>`,
        text: `${greeting}\n\nThis confirms that ${d.name || ""} has submitted an umpire acknowledgment for the Tri-Valley Baseball Umpires program.\n\nTheir account is pending approval. Once approved, they can sign up for games at ${APP_URL}.\n\nQuestions? Contact the league administrator.`,
      };
    }

    // Send admin email + all parent emails in parallel
    const sends = [
      transport.sendMail({
        from:    `"Tri-Valley Umpires" <${GMAIL_USER.value()}>`,
        to:      GMAIL_USER.value(),
        subject: `New Umpire Registration — ${d.name || d.email || "Unknown"}`,
        html:    adminHtml,
        text:    adminText,
      }).catch(err => console.error("onUmpireRegistered: failed to send admin email", err)),

      ...parentRecipients.map(p => {
        const body = makeParentEmail(p.name);
        return transport.sendMail({
          from:    `"Tri-Valley Umpires" <${GMAIL_USER.value()}>`,
          to:      p.email,
          subject: `Umpire Registration — ${d.name || ""}`,
          html:    body.html,
          text:    body.text,
        }).catch(err => console.error(`onUmpireRegistered: failed to send parent email to ${p.email}`, err));
      }),
    ];

    // Slack notification
    try {
      const db      = getFirestore();
      const config  = await loadWebhookConfig(db);
      const targets = getTargetWebhooks(config, "umpireRegistration");
      if (targets.length) {
        const msg = `🆕 New Umpire Registration — *${d.name || d.email || "Unknown"}*${d.email ? " · " + d.email : ""}${d.phone ? " · " + d.phone : ""}\nReview: https://tri-valley-baseball-umpires.web.app/admin-users.html`;
        await Promise.allSettled(targets.map(url => postSlack(url, msg)));
      }
    } catch (e) {
      console.error("onUmpireRegistered: Slack error", e);
    }

    await Promise.all(sends);
  }
);


// Notify admin when a coach registers
exports.onCoachRegistration = onDocumentWritten("coaches/{uid}", async (event) => {
  if (event.data.before && event.data.before.exists) return; // only on creation
  if (!event.data.after || !event.data.after.exists) return;
  const db = getFirestore();
  const r = event.data.after.data();
  if (r.approved || r.active === false) return; // skip if already approved or inactive
  const config = await loadWebhookConfig(db);
  const urls = getTargetWebhooks(config, "coachRegistration");
  const ADMIN_URL = "https://tri-valley-baseball-umpires.web.app/admin-users.html";
  const msg = `👤 *New Coach Registration* — ${r.name ?? "Unknown"}\n` +
    `Team: ${r.teamName ?? "—"} · Division: ${r.division ?? "—"} · City: ${r.city ?? "—"}\n` +
    `Email: ${r.email ?? "—"} · Phone: ${r.phone ?? "—"}\n` +
    `Review: ${ADMIN_URL}`;
  await Promise.allSettled(urls.map(url => postSlack(url, msg)));
});

// Notify admin when a coach submits an umpire request
exports.onUmpireRequest = onDocumentWritten("umpireRequests/{requestId}", async (event) => {
  if (!event.data.after || !event.data.after.exists) return; // deletion
  const isCreate = !event.data.before.exists;
  if (!isCreate) return; // only notify on creation
  const db = getFirestore();
  const r = event.data.after.data();
  const config = await loadWebhookConfig(db);
  const urls = getTargetWebhooks(config, "umpireRequests");
  const msg = `🗓️ *Umpire Request* from ${r.contactName ?? "a coach"}\n` +
    `Team: ${r.teamName ?? "—"} · Division: ${r.division ?? "—"}\n` +
    `Date: ${r.date ?? "—"} at ${r.time ?? "—"} · Location: ${r.location ?? "—"}\n` +
    `Umpires needed: ${r.umpiresNeeded ?? "—"} · Phone: ${r.contactPhone ?? "—"}` +
    (r.notes ? `\nNotes: ${r.notes}` : "");
  await Promise.allSettled(urls.map(url => postSlack(url, msg)));
});

// ── Field Calendar Import ─────────────────────────────────────────────────────

exports.fetchFacilityIcs = onCall({ cors: CORS }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const db = getFirestore();

  const callerDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!callerDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const { facilityId } = request.data || {};
  if (!facilityId) throw new HttpsError("invalid-argument", "facilityId required.");

  const facilityDoc = await db.doc(`facilities/${facilityId}`).get();
  if (!facilityDoc.exists) throw new HttpsError("not-found", "Facility not found.");
  const facility = facilityDoc.data();

  const icsUrl = facility.externalIcsUrl;
  if (!icsUrl) throw new HttpsError("failed-precondition", "Facility has no external calendar URL configured.");

  // Build dedup set from all existing games + practices
  const [allGamesSnap, allPracticesSnap, teamsSnap] = await Promise.all([
    db.collection("games").get(),
    db.collection("practices").get(),
    db.doc("config/teamCalendars").get(),
  ]);

  const knownUids = new Set();
  allGamesSnap.docs.forEach(d => { const u = d.data().externalId || d.data().icsUid; if (u) knownUids.add(u); });
  allPracticesSnap.docs.forEach(d => { const u = d.data().externalId || d.data().icsUid; if (u) knownUids.add(u); });

  const teams = teamsSnap.exists ? (teamsSnap.data().teams || []) : [];

  // Fetch ICS
  let icsText;
  try { icsText = await fetchICS(icsUrl); }
  catch (err) { throw new HttpsError("internal", `Failed to fetch calendar: ${err.message}`); }

  const today = todayISO();
  const parsed = parseVEvents(icsText);

  const events = [];
  for (const ev of parsed) {
    if (!ev.uid) continue;
    // Only include today and future
    if (ev.date && ev.date < today) continue;

    const alreadyImported = knownUids.has(ev.uid);

    // Type detection
    let suggestedType = "other";
    if (isPracticeEvent(ev.summary)) {
      suggestedType = "practice";
    } else if (/\bvs\.?\b|\s+@\s+/i.test(ev.summary || "") || (ev.homeTeam && ev.awayTeam)) {
      suggestedType = "game";
    }

    // Team suggestion: fuzzy match against team names
    let suggestedTeamId = "";
    let suggestedTeamName = "";
    const combinedLower = `${ev.homeTeam || ""} ${ev.awayTeam || ""} ${ev.summary || ""}`.toLowerCase();
    for (const t of teams) {
      // Use meaningful words (>3 chars) from team name for matching
      const words = t.name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      if (words.length > 0 && words.some(w => combinedLower.includes(w))) {
        suggestedTeamId = t.id || "";
        suggestedTeamName = t.name;
        break;
      }
    }

    events.push({
      uid: ev.uid,
      date: ev.date,
      time: ev.time || "",
      endTime: ev.endTime || "",
      summary: ev.summary || "",
      location: ev.location || "",
      homeTeam: ev.homeTeam || "",
      awayTeam: ev.awayTeam || "",
      suggestedType,
      suggestedTeamId,
      suggestedTeamName,
      alreadyImported,
    });
  }

  events.sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""));

  return {
    facilityId,
    facilityName: facility.name || "",
    events,
    newCount: events.filter(e => !e.alreadyImported).length,
  };
});

// Notify admin when a coach submits a practice request
exports.onPracticeRequest = onDocumentWritten("practiceRequests/{requestId}", async (event) => {
  if (!event.data.after || !event.data.after.exists) return;
  const isCreate = !event.data.before.exists;
  if (!isCreate) return;
  const db = getFirestore();
  const r = event.data.after.data();
  const config = await loadWebhookConfig(db);
  const urls = getTargetWebhooks(config, "practiceRequests");
  const msg = `🏟️ *Practice Request* from ${r.coachName ?? r.contactName ?? "a coach"}\n` +
    `Team: ${r.teamName ?? "—"}\n` +
    `Field: ${r.field ?? "—"} · ${r.startTime ?? ""}–${r.endTime ?? ""}` +
    (r.recurrence?.type === "weekly"
      ? ` · Weekly (${r.recurrence.startDate ?? ""} – ${r.recurrence.endDate ?? ""})`
      : ` · ${r.date ?? "—"}`) +
    (r.notes ? `\nNotes: ${r.notes}` : "");
  await Promise.allSettled(urls.map(url => postSlack(url, msg)));
});

// ── Call-up request notifications ────────────────────────────────────────────
// • New request  → email home coach, Slack admin channel
// • Status change (approved / declined) → email requesting coach

exports.onCallupRequest = onDocumentWritten(
  { document: "callupRequests/{requestId}", secrets: [GMAIL_USER, GMAIL_PASS] },
  async (event) => {
    if (!event.data.after.exists) return;          // deletion — ignore
    const before = event.data.before.exists ? event.data.before.data() : null;
    const r      = event.data.after.data();
    const db     = getFirestore();
    const APP_URL = "https://tri-valley-baseball-umpires.web.app";

    // ── New request → notify home coach ──────────────────────────────────────
    if (!before && r.status === "pending") {
      const homeEmail = r.homeCoachEmail;
      if (homeEmail) {
        const transport = buildTransport();
        const dateLine  = r.gameDate ? ` for ${r.gameDate}` : "";
        const subject   = `Call-Up Request: ${r.playerFirstName} ${r.playerLastName}${dateLine}`;
        const text = [
          `Hi ${r.homeCoachName || "Coach"},`,
          ``,
          `${r.requestingCoachName || "A coach"} from ${r.requestingTeamName} is requesting to call up`,
          `${r.playerFirstName} ${r.playerLastName}${r.playerNumber ? ` (#${r.playerNumber})` : ""}${r.playerPosition ? `, ${r.playerPosition}` : ""} from your roster.`,
          ``,
          r.gameDate  ? `Game / Event Date: ${r.gameDate}` : "",
          r.reason    ? `Reason: ${r.reason}` : "",
          ``,
          `Please log in to the Coach Portal to approve or decline this request:`,
          `${APP_URL}/coach-callup.html`,
          ``,
          `— Tri-Valley Baseball`,
        ].filter(l => l !== null).join("\n");
        await transport.sendMail({
          from:    `"Tri-Valley Baseball" <${GMAIL_USER.value()}>`,
          to:      homeEmail,
          subject,
          text,
        }).catch(err => console.error("callup email to home coach failed:", err.message));
      }

      // Slack admin notification
      const config = await loadWebhookConfig(db).catch(() => null);
      if (config) {
        const urls = getTargetWebhooks(config, "callupRequests");
        if (urls.length) {
          const datePart = r.gameDate ? ` · ${r.gameDate}` : "";
          const msg = `⬆️ *Call-Up Request* — ${r.requestingCoachName || r.requestingTeamName} wants to call up ` +
            `*${r.playerFirstName} ${r.playerLastName}* from ${r.homeTeamName}${datePart}\n` +
            `Reason: ${r.reason || "—"}\n` +
            `Review: ${APP_URL}/admin-callup.html`;
          await Promise.allSettled(urls.map(url => postSlack(url, msg)));
        }
      }
      return;
    }

    // ── Status change → notify requesting coach ───────────────────────────────
    if (before && before.status === "pending" &&
        (r.status === "approved" || r.status === "declined")) {
      const toEmail = r.requestingCoachEmail;
      if (!toEmail) return;
      const transport = buildTransport();
      const approved  = r.status === "approved";
      const subject   = `Call-Up ${approved ? "Approved" : "Declined"}: ${r.playerFirstName} ${r.playerLastName}`;
      const text = [
        `Hi ${r.requestingCoachName || "Coach"},`,
        ``,
        `${r.homeCoachName || "The home coach"} has ${approved ? "approved" : "declined"} your request to call up`,
        `${r.playerFirstName} ${r.playerLastName}${r.playerNumber ? ` (#${r.playerNumber})` : ""} from ${r.homeTeamName}.`,
        ``,
        r.responseNote ? `Their note: "${r.responseNote}"` : "",
        ``,
        `View your requests: ${APP_URL}/coach-callup.html`,
        ``,
        `— Tri-Valley Baseball`,
      ].filter(l => l !== null).join("\n");
      await transport.sendMail({
        from:    `"Tri-Valley Baseball" <${GMAIL_USER.value()}>`,
        to:      toEmail,
        subject,
        text,
      }).catch(err => console.error("callup email to requesting coach failed:", err.message));
    }
  }
);

// ── fetchOrgIcs ───────────────────────────────────────────────────────────────
// Fetches the org-level field use calendar (stored in config/orgSettings.fieldCalendarUrl),
// parses future events, auto-detects which facility each event belongs to by matching
// field/facility name keywords from the SUMMARY, and returns events ready for review.

exports.fetchOrgIcs = onCall({ cors: CORS }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const db = getFirestore();

  const callerDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!callerDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  // Load org calendar URL
  const orgDoc = await db.doc("config/orgSettings").get();
  const fieldCalendarUrl = orgDoc.exists ? orgDoc.data().fieldCalendarUrl : null;
  if (!fieldCalendarUrl) {
    throw new HttpsError(
      "failed-precondition",
      "No field use calendar URL configured. Add one in Config → Organization Settings → Field Use Calendar."
    );
  }

  // Build facility + field keyword index (longer names first to prefer specific matches)
  const facilitiesSnap = await db.collection("facilities").get();
  const fieldKeywords = [];
  facilitiesSnap.docs.forEach(d => {
    const fac = d.data();
    if (fac.name) {
      fieldKeywords.push({ pattern: fac.name.toLowerCase(), facilityId: d.id, facilityName: fac.name, fieldName: "" });
    }
    (fac.fields || []).forEach(f => {
      if (f.name) {
        fieldKeywords.push({ pattern: f.name.toLowerCase(), facilityId: d.id, facilityName: fac.name, fieldName: f.name });
      }
    });
  });
  fieldKeywords.sort((a, b) => b.pattern.length - a.pattern.length);

  // Load teams for suggestions
  const teamsSnap = await db.doc("config/teamCalendars").get();
  const teams = teamsSnap.exists ? (teamsSnap.data().teams || []) : [];

  // Build dedup set from all existing games + practices
  const [gamesSnap, practicesSnap] = await Promise.all([
    db.collection("games").get(),
    db.collection("practices").get(),
  ]);
  const knownUids = new Set();
  gamesSnap.docs.forEach(d => { const u = d.data().externalId || d.data().icsUid; if (u) knownUids.add(u); });
  practicesSnap.docs.forEach(d => { const u = d.data().externalId || d.data().icsUid; if (u) knownUids.add(u); });

  // Fetch and parse ICS
  let icsText;
  try { icsText = await fetchICS(fieldCalendarUrl); }
  catch (err) { throw new HttpsError("internal", `Failed to fetch calendar: ${err.message}`); }

  const today  = todayISO();
  const parsed = parseVEvents(icsText);

  const events = [];
  for (const ev of parsed) {
    if (!ev.uid) continue;
    if (ev.date && ev.date < today) continue;

    const alreadyImported = knownUids.has(ev.uid);

    // ── Type + structure detection ───────────────────────────────────────────
    // This calendar uses the format: "-Game- [DIV] [FIELD] TV [OPPONENT]"
    let suggestedType = "other";
    let division = "";
    let opponent = "";
    let fieldHint = "";

    const gameMatch = (ev.summary || "").match(/^-\s*Game\s*-\s+(\S+)\s+(.+?)\s+TV\s+(.+)$/i);
    if (gameMatch) {
      suggestedType = "game";
      division      = gameMatch[1].trim();
      fieldHint     = gameMatch[2].trim();
      opponent      = gameMatch[3].trim();
    } else if (isPracticeEvent(ev.summary)) {
      suggestedType = "practice";
    } else if (/\bgame\b/i.test(ev.summary || "") || /\bvs\.?\b|\s+@\s+/i.test(ev.summary || "")) {
      suggestedType = "game";
    }

    // ── Facility detection ────────────────────────────────────────────────────
    // Search the field hint first (from structured game format), then full summary
    const searchStr  = fieldHint || ev.summary || "";
    const searchLow  = searchStr.toLowerCase();
    let detectedFacilityId   = "";
    let detectedFacilityName = "";
    let detectedFieldName    = "";
    for (const kw of fieldKeywords) {
      if (searchLow.includes(kw.pattern)) {
        detectedFacilityId   = kw.facilityId;
        detectedFacilityName = kw.facilityName;
        detectedFieldName    = kw.fieldName;
        break;
      }
    }

    // ── Team suggestion ───────────────────────────────────────────────────────
    let suggestedTeamId   = "";
    let suggestedTeamName = "";
    const combinedLow = `${ev.homeTeam || ""} ${ev.awayTeam || ""} ${ev.summary || ""}`.toLowerCase();
    for (const t of teams) {
      const words = t.name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      if (words.length > 0 && words.some(w => combinedLow.includes(w))) {
        suggestedTeamId   = t.id || "";
        suggestedTeamName = t.name;
        break;
      }
    }

    events.push({
      uid:                 ev.uid,
      date:                ev.date,
      time:                ev.time    || "",
      endTime:             ev.endTime || "",
      summary:             ev.summary || "",
      division,
      opponent,
      detectedFacilityId,
      detectedFacilityName,
      detectedFieldName,
      suggestedType,
      suggestedTeamId,
      suggestedTeamName,
      alreadyImported,
    });
  }

  events.sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""));

  const facilities = facilitiesSnap.docs
    .map(d => ({ id: d.id, name: d.data().name || "" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    source:   "org",
    events,
    newCount: events.filter(e => !e.alreadyImported).length,
    facilities,
  };
});

// ── Field issue status change → push reporter ─────────────────────────────────

exports.onFieldIssue = onDocumentWritten("fieldIssues/{issueId}", async event => {
  const before = event.data.before?.data() ?? null;
  const after  = event.data.after?.data()  ?? null;
  if (!after) return;

  const db    = getFirestore();
  const isNew = !before;

  // ── New report → Slack admin notification ─────────────────────────────────
  if (isNew) {
    try {
      const config  = await loadWebhookConfig(db);
      const targets = getTargetWebhooks(config, "fieldIssues");
      if (targets.length) {
        const loc  = after.fieldName
          ? `${after.facilityName || ""} — ${after.fieldName}`.trim()
          : (after.facilityName || "");
        const desc = after.description ? "\n" + String(after.description).slice(0, 150) : "";
        const msg  = `⚠️ Field Issue — *${after.title || after.issueType || "Reported"}*${loc ? " at " + loc : ""}${desc}\nReview: https://tri-valley-baseball-umpires.web.app/admin-field-calendar.html`;
        await Promise.allSettled(targets.map(url => postSlack(url, msg)));
      }
    } catch (e) {
      console.error("Field issue Slack error:", e);
    }
    return;
  }

  // ── Status change → push notification to reporter ─────────────────────────
  const prevStatus = before.status ?? "Open";
  const newStatus  = after.status  ?? "Open";
  if (prevStatus === newStatus) return; // Status unchanged
  if (!after.reportedBy) return;

  try {
    const tokenSnap = await db.doc(`notifications/${after.reportedBy}`).get();
    const token     = tokenSnap.exists ? tokenSnap.data()?.token : null;
    if (!token) return;

    const loc      = after.fieldName ? `${after.facilityName} — ${after.fieldName}` : (after.facilityName || "");
    const noteStr  = after.adminNotes ? ` — ${after.adminNotes}` : "";
    const emoji    = newStatus === "Resolved"    ? "✅"
                   : newStatus === "In Progress" ? "🔧"
                   : "📋";

    const result = await getMessaging().sendEachForMulticast({
      tokens: [token],
      notification: {
        title: `${emoji} Field Issue ${newStatus}`,
        body:  `${after.title || "Your field issue"}${loc ? " at " + loc : ""}${noteStr}`,
      },
      webpush: { fcmOptions: { link: "https://tri-valley-baseball-umpires.web.app/field-issues.html" } },
    });
    if (result.responses[0]?.error) await tokenSnap.ref.delete();
  } catch (e) {
    console.error("Field issue push error:", e);
  }
});

// ── onGameSlotChanged — notify umpires when an admin assigns or removes them ──
//
// Fires on any game document write. Compares umpireSlots before/after to find:
//   • Newly assigned umpires  → "You've been assigned to a game"
//   • Newly removed umpires   → "You've been removed from a game"
// Self-signups are excluded: if the umpire's own uid triggered the write the
// Firestore write comes from the client, not an admin, so we skip it via the
// `adminWrite` flag. However we can't read who wrote it from Firestore triggers,
// so instead we skip any change where the before-slot was empty (self-signup)
// and skip any change where the after-slot is empty but no admin context (i.e.,
// we detect removals only when an assignedUid disappears).

exports.onGameSlotChanged = onDocumentWritten(
  { document: "games/{gameId}", secrets: [GMAIL_USER, GMAIL_PASS] },
  async event => {
    const before = event.data.before?.data() ?? null;
    const after  = event.data.after?.data()  ?? null;

    // Ignore deletes and new game creations (no slots to compare)
    if (!before || !after) return;

    const beforeSlots = before.umpireSlots || [];
    const afterSlots  = after.umpireSlots  || [];

    const APP_URL = "https://tri-valley-baseball-umpires.web.app";
    const db      = getFirestore();

    const gameDate = after.date  || "";
    const gameTime = after.time  || "";
    const gameCity = after.city  || "";
    const gameDivision = after.division || "";
    const gameField    = after.field    || "";
    const gameWhere    = [gameCity, gameDivision, gameField].filter(Boolean).join(" · ");
    const dateStr  = fmtDateSlack(gameDate);
    const timeStr  = gameTime ? fmtTimeSlack(gameTime) : "";

    // Collect notifications to send: { uid, action: "assigned"|"removed", slotType }
    const notifications = [];

    // Use index-based comparison to correctly handle multiple slots of the same type.
    // Check if any non-slot field changed as a proxy for admin write vs self-signup.
    const nonSlotChanged = (() => {
      const track = ["date","time","city","division","field","notes","cancelled","homeTeam","awayTeam"];
      return track.some(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    })();

    const maxLen = Math.max(beforeSlots.length, afterSlots.length);
    for (let i = 0; i < maxLen; i++) {
      const b = beforeSlots[i];
      const a = afterSlots[i];
      const prevUid  = b?.assignedUid || null;
      const nextUid  = a?.assignedUid || null;
      const slotType = a?.type ?? b?.type ?? `Slot ${i}`;

      if (prevUid === nextUid) continue; // no change

      // For assignments (empty→filled): only notify for admin-initiated assigns.
      // Self-signups on schedule.html only write umpireSlots+needsUmpires, so
      // nonSlotChanged will be false and we correctly skip them.
      if (!prevUid && nextUid) {
        if (nonSlotChanged) {
          notifications.push({ uid: nextUid, action: "assigned", slotType });
        }
      }

      // For removals (filled→empty): always notify the umpire who was removed.
      if (prevUid && !nextUid) {
        notifications.push({ uid: prevUid, action: "removed", slotType });
      }

      // For swaps (uid A → uid B): notify both.
      if (prevUid && nextUid && prevUid !== nextUid) {
        notifications.push({ uid: prevUid, action: "removed",  slotType });
        notifications.push({ uid: nextUid, action: "assigned", slotType });
      }
    }

    if (!notifications.length) return;

    // Load org settings once for email branding
    let orgName = "Tri-Valley Baseball Umpires", coord = "", coordPhone = "";
    try {
      const orgSnap = await db.doc("config/orgSettings").get();
      if (orgSnap.exists) {
        const org = orgSnap.data();
        orgName    = org.assocName        || orgName;
        coord      = org.coordinatorName  || "";
        coordPhone = org.coordinatorPhone || "";
      }
    } catch (_) {}

    await Promise.allSettled(notifications.map(async ({ uid, action, slotType }) => {
      let umpireName = "Umpire", umpireEmail = null;
      try {
        const snap = await db.doc(`umpires/${uid}`).get();
        if (snap.exists) {
          umpireName  = snap.data().name  || umpireName;
          umpireEmail = snap.data().email || null;
        }
      } catch (_) {}

      const isAssigned = action === "assigned";
      const pushTitle  = isAssigned ? "📋 Game Assignment" : "🔔 Assignment Removed";
      const pushBody   = isAssigned
        ? `You've been assigned as ${slotType} on ${dateStr}${timeStr ? " at " + timeStr : ""} in ${gameCity || "—"}.`
        : `Your ${slotType} assignment on ${dateStr}${timeStr ? " at " + timeStr : ""} in ${gameCity || "—"} has been removed.`;

      // Push notification
      try {
        const tokenSnap = await db.doc(`notifications/${uid}`).get();
        const token = tokenSnap.exists ? tokenSnap.data()?.token : null;
        if (token) {
          const result = await getMessaging().sendEachForMulticast({
            tokens: [token],
            notification: { title: pushTitle, body: pushBody },
            webpush: { fcmOptions: { link: `${APP_URL}/schedule.html` } },
          });
          if (result.responses[0]?.error?.code === "messaging/registration-token-not-registered") {
            await db.doc(`notifications/${uid}`).delete();
          }
        }
      } catch (err) {
        console.error("onGameSlotChanged push:", err);
      }

      // Email notification
      if (!umpireEmail) return;
      try {
        const subject = isAssigned
          ? `Game Assignment — ${slotType} on ${dateStr}`
          : `Assignment Removed — ${slotType} on ${dateStr}`;

        const bodyHtml = `
          <div style="font-family:-apple-system,sans-serif;max-width:540px;margin:0 auto;color:#111">
            <div style="background:#601929;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0">
              <strong style="font-size:1.1rem">${isAssigned ? "📋 Game Assignment" : "🔔 Assignment Removed"}</strong>
            </div>
            <div style="background:#f7f2f3;padding:20px 24px;border-radius:0 0 8px 8px;border:1px solid #d9b8bb;border-top:none">
              <p>Hi ${umpireName},</p>
              <p>${isAssigned
                ? `You have been <strong>assigned</strong> to the following game as <strong>${slotType}</strong>.`
                : `Your <strong>${slotType}</strong> assignment for the following game has been <strong>removed</strong> by an administrator.`}
              </p>
              <div style="background:#fff;border:1px solid #ddd;border-radius:6px;padding:12px 16px;margin:16px 0;font-size:0.9rem">
                <strong>Game Details</strong><br>
                📅 ${dateStr}${timeStr ? " at " + timeStr : ""}<br>
                📍 ${gameWhere || "—"}
              </div>
              ${isAssigned
                ? `<p>Log in to view your full schedule and check in on game day.</p>`
                : `<p>If you have questions about this change, contact ${coord ? coord + (coordPhone ? " at " + coordPhone : "") : "your coordinator"}.</p>`}
              <p><a href="${APP_URL}/schedule.html" style="color:#601929">View your schedule →</a></p>
              <hr style="border:none;border-top:1px solid #ddd;margin:16px 0">
              <p style="font-size:0.8rem;color:#777">${orgName}${coord ? " · " + coord : ""}${coordPhone ? " · " + coordPhone : ""}</p>
            </div>
          </div>`;

        const transport = buildTransport();
        await transport.sendMail({
          from:    `"${orgName}" <${GMAIL_USER.value()}>`,
          to:      umpireEmail,
          subject,
          html:    bodyHtml,
        });
      } catch (err) {
        console.error("onGameSlotChanged email:", err);
      }
    }));
  }
);
