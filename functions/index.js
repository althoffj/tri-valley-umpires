const { onSchedule }                  = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError }          = require("firebase-functions/v2/https");
const { onDocumentWritten }           = require("firebase-functions/v2/firestore");
const { defineSecret }                = require("firebase-functions/params");
const { initializeApp }               = require("firebase-admin/app");
const { getFirestore, FieldValue }    = require("firebase-admin/firestore");
const { getMessaging }                = require("firebase-admin/messaging");
const { getAuth }                     = require("firebase-admin/auth");
const https     = require("https");
const nodemailer = require("nodemailer");

initializeApp();

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

    events.push({ date, time, location, uid, summary, homeTeam, awayTeam, isAway });
  }
  return events;
}

// ── Core sync logic ───────────────────────────────────────────────────────────

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

  // Load all existing games for dedup
  const gamesSnap         = await db.collection("games").get();
  const existingExtIds    = new Set(gamesSnap.docs.map(d => d.data().externalId).filter(Boolean));
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

  for (const team of teams) {
    let icsText;
    try { icsText = await fetchICS(team.icsUrl); }
    catch (err) { console.error(`Failed: ${team.name}: ${err.message}`); failed++; continue; }

    const division = inferDivision(team.name);

    for (const ev of parseVEvents(icsText)) {
      if (!ev.uid) continue;

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
            await existingDoc.ref.update(patch);
            corrected++;
          }
        }
        continue;
      }

      // Save as reference game if not already stored
      await db.collection("games").add({
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
      existingExtIds.add(ev.uid);
      added++;
    }
  }

  // ── Match / monitor city-schedule games against ICS events ───────────────────
  let linked = 0, flagged = 0;

  for (const game of cityGames) {
    if (game.date < today || game.cancelled) continue;
    const key     = `${game.division}|${game.date}`;
    const matches = eventsByDivDate[key] || [];

    if (!game.icsLinks || game.icsLinks.length === 0) {
      if (matches.length > 0) {
        const update = { icsLinks: matches.map(e => ({ uid: e.uid, teamName: e.teamName })) };
        // Copy team names and away flag from first matching ICS event if not already set
        const first = matches[0];
        if (!game.homeTeam && first.homeTeam) update.homeTeam = first.homeTeam;
        if (!game.awayTeam && first.awayTeam) update.awayTeam = first.awayTeam;
        if (first.isAway !== undefined && (game.isAway || false) !== first.isAway) update.isAway = first.isAway;
        await game.ref.update(update);
        linked++;
      }
    } else {
      const liveUids = new Set(matches.map(e => e.uid));
      const missing  = game.icsLinks.filter(l => !liveUids.has(l.uid));
      if (missing.length > 0 && !game.possibleChange) {
        await game.ref.update({ possibleChange: true }); flagged++;
      } else if (missing.length === 0 && game.possibleChange) {
        await game.ref.update({ possibleChange: false });
      }
      // Pick up team names, location, and away flag if GameChanger fills them in later
      const locatedMatch = matches.find(e =>
        /crooks,\s*sd/i.test(e.location) || /colton,\s*sd/i.test(e.location)
      );
      const teamUpdate = {};
      if (locatedMatch) teamUpdate.field = locatedMatch.location;
      const namedMatch = matches.find(e => e.homeTeam);
      if (namedMatch && !game.homeTeam) {
        teamUpdate.homeTeam = namedMatch.homeTeam;
        teamUpdate.awayTeam = namedMatch.awayTeam;
      }
      // Always sync isAway from the ICS match (away status can change if schedule changes)
      const awayMatch = matches.find(e => e.isAway !== undefined);
      if (awayMatch && (game.isAway || false) !== awayMatch.isAway) teamUpdate.isAway = awayMatch.isAway;
      if (Object.keys(teamUpdate).length) await game.ref.update(teamUpdate);
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

    const ratesSnap = await db.doc("config/payRates").get();
    const rates     = ratesSnap.exists ? ratesSnap.data() : {};
    const rateMap   = { Plate: rates.plate || 0, Field: rates.field || 0, Extra: rates.extra || 0 };
    const defaultSlotTypes = (rates.defaultSlotTypes && rates.defaultSlotTypes.length)
      ? rates.defaultSlotTypes
      : ["Plate", "Field"];

    let added = 0, skipped = 0;
    for (const g of CITY_SCHEDULE) {
      const externalId = `city-2026-${g.city.replace(/\s+/g,"").toLowerCase()}-${g.division}-${g.date}-${g.field.replace(/\s+/g,"")}`;
      const existing = await db.collection("games").where("externalId", "==", externalId).limit(1).get();
      if (!existing.empty) { skipped++; continue; }
      await db.collection("games").add({
        city:         g.city,
        division:     g.division,
        date:         g.date,
        time:         g.time,
        type:         "Regular",
        field:        g.field,
        needsUmpires: true,
        umpireSlots:  defaultSlotTypes.map(t => ({
          type: t, assignedUid: null, assignedName: null, payRate: rateMap[t] || 0
        })),
        cancelled:  false,
        externalId,
        source:     "city-schedule",
        createdAt:  FieldValue.serverTimestamp()
      });
      added++;
    }
    return { added, skipped };
  }
);

// ── Phase 11: single-team sync ────────────────────────────────────────────────

async function runSyncForTeam(team, teamIndex) {
  const db = getFirestore();

  const gamesSnap      = await db.collection("games").get();
  const existingExtIds = new Set(gamesSnap.docs.map(d => d.data().externalId).filter(Boolean));
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
  let icsText;
  try { icsText = await fetchICS(team.icsUrl); }
  catch (err) { throw new Error(`Failed to fetch ICS for ${team.name}: ${err.message}`); }

  const events = parseVEvents(icsText);
  const eventsByDivDate = {};
  const extIdToDoc = {};
  for (const d of gamesSnap.docs) {
    const g = d.data();
    if (g.externalId && g.source === "calendar") extIdToDoc[g.externalId] = d;
  }
  const today = todayISO();
  let added = 0, corrected = 0;

  for (const ev of events) {
    if (!ev.uid) continue;
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
          await existingDoc.ref.update(patch);
          corrected++;
        }
      }
      continue;
    }
    await db.collection("games").add({
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

  let linked = 0, flagged = 0;
  for (const game of cityGames) {
    if (game.division !== division) continue;
    if (game.date < today || game.cancelled) continue;
    const key     = `${division}|${game.date}`;
    const matches = eventsByDivDate[key] || [];
    if (!game.icsLinks || game.icsLinks.length === 0) {
      if (matches.length > 0) {
        const update = { icsLinks: matches.map(e => ({ uid: e.uid, teamName: e.teamName })) };
        const first  = matches[0];
        if (!game.homeTeam && first.homeTeam) update.homeTeam = first.homeTeam;
        if (!game.awayTeam && first.awayTeam) update.awayTeam = first.awayTeam;
        if (first.isAway !== undefined && (game.isAway || false) !== first.isAway) update.isAway = first.isAway;
        await game.ref.update(update); linked++;
      }
    } else {
      const liveUids = new Set(matches.map(e => e.uid));
      const missing  = game.icsLinks.filter(l => !liveUids.has(l.uid));
      if (missing.length > 0 && !game.possibleChange) { await game.ref.update({ possibleChange: true }); flagged++; }
      else if (missing.length === 0 && game.possibleChange) { await game.ref.update({ possibleChange: false }); }
      // Always sync isAway from the ICS match
      const awayMatch = matches.find(e => e.isAway !== undefined);
      if (awayMatch && (game.isAway || false) !== awayMatch.isAway) {
        await game.ref.update({ isAway: awayMatch.isAway });
      }
    }
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

    return await runSyncForTeam(teams[teamIndex], teamIndex);
  }
);

// ── Phase 12: Slack helpers ───────────────────────────────────────────────────

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

async function getSlackWebhooks(db) {
  const snap = await db.doc("config/slackWebhooks").get();
  return snap.exists ? snap.data() : {};
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

  // Only fire for needsUmpires games
  if (!after?.needsUmpires && !before?.needsUmpires) return;

  const db      = getFirestore();
  const hooks   = await getSlackWebhooks(db);
  if (!hooks.jeff && !hooks.ch10u && !hooks.ch12u) return;

  const div     = after?.division ?? before?.division ?? "";
  const channel = /10U/i.test(div) ? hooks.ch10u : /12U/i.test(div) ? hooks.ch12u : null;

  // ── 1. Structural game changes → jeff + channel ──────────────────────────────
  let broadcastMsg = null;

  if (!before && after) {
    broadcastMsg = `🆕 New game added: ${gameLabel(after)}`;
  } else if (before && !after) {
    broadcastMsg = `🗑️ Game deleted: ${gameLabel(before)}`;
  } else if (before && after) {
    if (!before.cancelled && after.cancelled) {
      broadcastMsg = `❌ Game cancelled: ${gameLabel(after)}`;
    } else if (before.cancelled && !after.cancelled) {
      broadcastMsg = `✅ Game reinstated: ${gameLabel(after)}`;
    } else {
      const changed = ["date","time","field","city","division"].some(k => before[k] !== after[k]);
      if (changed) broadcastMsg = `✏️ Game updated: ${gameLabel(after)}`;
    }
  }

  // ── 2. Slot assignment changes → jeff only ───────────────────────────────────
  let jeffMsg = null;

  if (before && after && !after.cancelled) {
    const beforeSlots = before.umpireSlots || [];
    const afterSlots  = after.umpireSlots  || [];
    const signups  = [];
    const cancels  = [];

    for (let i = 0; i < afterSlots.length; i++) {
      const b = beforeSlots[i] || {};
      const a = afterSlots[i];
      if (!b.assignedUid && a.assignedUid) {
        signups.push(`${a.type}: ${a.assignedName || a.assignedUid}`);
      } else if (b.assignedUid && !a.assignedUid) {
        cancels.push(`${b.type}: ${b.assignedName || b.assignedUid}`);
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
    if (hooks.jeff)  sends.push(postSlack(hooks.jeff,  broadcastMsg));
    if (channel)     sends.push(postSlack(channel,     broadcastMsg));
  }
  if (jeffMsg && hooks.jeff) {
    sends.push(postSlack(hooks.jeff, jeffMsg));
  }

  if (sends.length) await Promise.allSettled(sends);
});

// ── Cancellation request notifications ───────────────────────────────────────

exports.onCancellationRequest = onDocumentWritten("cancellationRequests/{requestId}", async event => {
  const before = event.data.before?.data() ?? null;
  const after  = event.data.after?.data()  ?? null;

  // Only notify on new pending requests
  if (!after || after.status !== "pending" || before?.status === "pending") return;

  const db    = getFirestore();
  const hooks = await getSlackWebhooks(db);
  if (!hooks.jeff) return;

  const name  = after.name     || after.uid || "Unknown";
  const slot  = after.slotType || "?";
  const date  = fmtDateSlack(after.gameDate);
  const time  = after.gameTime ? fmtTimeSlack(after.gameTime) : "";
  const where = [after.gameCity, after.gameDivision, after.gameField].filter(Boolean).join(" · ");
  const msg   = `⚠️ Cancellation request — ${name} wants to cancel ${slot} slot · ${date}${time ? " at " + time : ""}${where ? " · " + where : ""}\nReview: https://tri-valley-baseball-umpires.web.app/admin-games.html`;

  await postSlack(hooks.jeff, msg).catch(() => {});
});

// ── Incident report notifications ────────────────────────────────────────────

exports.onIncidentReport = onDocumentWritten("incidentReports/{reportId}", async event => {
  // Only fire on new documents
  if (event.data.before?.exists || !event.data.after?.exists) return;

  const r   = event.data.after.data();
  const db  = getFirestore();
  const hooks = await getSlackWebhooks(db);
  if (!hooks.jeff) return;

  const gameLabel = [
    r.gameDate ? fmtDateSlack(r.gameDate) : "",
    r.gameCity,
    r.gameDivision
  ].filter(Boolean).join(" · ");

  let details = "";
  if (r.ejection) {
    const ej = r.ejection;
    details = `\nEjected: ${ej.role || "?"}${ej.name ? " — " + ej.name : ""}${ej.team ? " (" + ej.team + ")" : ""}`;
    if (ej.reason) details += `\nReason: ${ej.reason}`;
  } else if (r.injury) {
    const inj = r.injury;
    details = `\nInjured: ${inj.party || "?"}${inj.name ? " — " + inj.name : ""}`;
    if (inj.description) details += ` · ${inj.description}`;
    details += `\nEMS: ${inj.emsCalled || "No"}`;
  } else if (r.unsafeConditions) {
    const uc = r.unsafeConditions;
    details = `\nCondition: ${uc.conditionType || "?"}`;
    if (uc.gameStatus) details += ` · Game: ${uc.gameStatus}`;
  }

  const msg = `🚨 Incident Report — *${r.incidentType || "Incident"}* · ${r.reporterName || r.reportedBy}${gameLabel ? " · " + gameLabel : ""}${details}`;
  await postSlack(hooks.jeff, msg).catch(() => {});
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

  const hooks = await getSlackWebhooks(db);
  const div   = game.division ?? "";
  const channel = /10U/i.test(div) ? hooks.ch10u : /12U/i.test(div) ? hooks.ch12u : null;

  const sends = [];
  if (hooks.jeff)  sends.push(postSlack(hooks.jeff,  msg));
  if (channel)     sends.push(postSlack(channel,     msg));
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

// ── FCM broadcast ─────────────────────────────────────────────────────────────

const CORS = ["https://tri-valley-baseball-umpires.web.app", "https://tri-valley-baseball-umpires.firebaseapp.com"];

exports.sendBroadcast = onCall({ cors: CORS }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in.");
  const db       = getFirestore();
  const adminDoc = await db.doc(`admins/${request.auth.uid}`).get();
  if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admin access required.");

  const { title, body } = request.data || {};
  if (!title || !body) throw new HttpsError("invalid-argument", "title and body are required.");

  const tokensSnap = await db.collection("notifications").get();
  const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
  if (tokens.length === 0) return { sent: 0, failed: 0 };

  const result = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    webpush: { fcmOptions: { link: "https://tri-valley-baseball-umpires.web.app/" } }
  });

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

  return { sent: result.successCount, failed: result.failureCount };
});

// ── Phase 12: day-of reminders at 7 AM ───────────────────────────────────────

exports.sendDayOfReminders = onSchedule("0 7 * * *", async () => {
  const db    = getFirestore();
  const hooks = await getSlackWebhooks(db);
  if (!hooks.jeff && !hooks.ch10u && !hooks.ch12u) return;

  const today = todayISO();
  const snap  = await db.collection("games")
    .where("date", "==", today)
    .where("needsUmpires", "==", true)
    .get();

  if (snap.empty) return;

  for (const d of snap.docs) {
    const g      = d.data();
    if (g.cancelled) continue;
    const div    = g.division ?? "";
    const channel = /10U/i.test(div) ? hooks.ch10u : /12U/i.test(div) ? hooks.ch12u : null;
    const slots  = (g.umpireSlots ?? [])
      .map(s => s.assignedName ? `${s.type}: ${s.assignedName}` : `${s.type}: OPEN`)
      .join(" | ");
    const msg = `⚾ *Game today:* ${gameLabel(g)}\n${slots}`;

    await Promise.allSettled([
      hooks.jeff ? postSlack(hooks.jeff, msg) : null,
      channel    ? postSlack(channel,    msg) : null
    ].filter(Boolean));
  }
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
  const hooks = await getSlackWebhooks(db);
  if (hooks.jeff) {
    const names1 = umpires1.map(u => u.name).join(", ") || "none";
    const names2 = umpires2.map(u => u.name).join(", ") || "none";
    const msg = `🔄 *Field Swap — ${tournamentName}*\n`
      + `• ${game1.time} ${game1.field ? "(" + game1.field + ")" : ""} ↔ ${game2.time} ${game2.field ? "(" + game2.field + ")" : ""}\n`
      + `• ${names1} ⇄ ${names2}`;
    await postSlack(hooks.jeff, msg).catch(() => {});
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
    const notifSnap = await db.collection("notifications").get();
    await Promise.all(
      notifSnap.docs
        .filter(d => stale.includes(d.data().token))
        .map(d => d.ref.delete())
    );
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
    parentName, parentEmail, parentPhone
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
  if (parentName  !== undefined)     firestoreUpdate.parentName  = parentName.trim();
  if (parentEmail !== undefined)     firestoreUpdate.parentEmail = parentEmail.trim().toLowerCase();
  if (parentPhone !== undefined)     firestoreUpdate.parentPhone = parentPhone.trim();

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

// ── onUmpireRegistered — notify admins (and parent if minor) when a new
//    umpire registers. Replaces the client-side EmailJS calls in form.js.
exports.onUmpireRegistered = onDocumentWritten(
  { document: "umpires/{uid}", secrets: [GMAIL_USER, GMAIL_PASS] },
  async event => {
    // Only fire on creates (before == null), not updates or deletes
    if (event.data.before && event.data.before.exists) return;
    const after = event.data.after;
    if (!after || !after.exists) return;

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

    // Admin notification
    try {
      await transport.sendMail({
        from:    `"Tri-Valley Umpires" <${GMAIL_USER.value()}>`,
        to:      GMAIL_USER.value(),
        subject: `New Umpire Registration — ${d.name || d.email || "Unknown"}`,
        html:    adminHtml,
        text:    adminText,
      });
    } catch (err) {
      console.error("onUmpireRegistered: failed to send admin email", err);
    }

    // Parent notification (only if parentEmail is present)
    if (d.parentEmail) {
      const parentHtml = `
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
      <p style="margin:0 0 12px">Hi ${d.parentName || "Parent/Guardian"},</p>
      <p style="margin:0 0 12px">This confirms that <strong>${d.name || ""}</strong> has submitted an umpire acknowledgment for the Tri-Valley Baseball Umpires program.</p>
      <p style="margin:0 0 12px">Their account is pending administrator approval, which typically takes 1–2 business days. Once approved, they'll be able to sign up for games at:</p>
      <p style="margin:0 0 12px"><a href="${APP_URL}" style="color:#7ec8f7">${APP_URL}</a></p>
      <p style="margin:0;font-size:0.85em;color:#aaa">Questions? Contact the league administrator.</p>
    </td></tr>
  </table>
</body>
</html>`;

      const parentText = `Hi ${d.parentName || "Parent/Guardian"},\n\nThis confirms that ${d.name || ""} has submitted an umpire acknowledgment for the Tri-Valley Baseball Umpires program.\n\nTheir account is pending approval. Once approved, they can sign up for games at ${APP_URL}.\n\nQuestions? Contact the league administrator.`;

      try {
        await transport.sendMail({
          from:    `"Tri-Valley Umpires" <${GMAIL_USER.value()}>`,
          to:      d.parentEmail,
          subject: `Umpire Registration — ${d.name || ""}`,
          html:    parentHtml,
          text:    parentText,
        });
      } catch (err) {
        console.error("onUmpireRegistered: failed to send parent email", err);
      }
    }
  }
);
