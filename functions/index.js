const { onSchedule }                  = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError }          = require("firebase-functions/v2/https");
const { onDocumentWritten }           = require("firebase-functions/v2/firestore");
const { initializeApp }        = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const https = require("https");

initializeApp();

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

    const dateM = dtstart.match(/(\d{4})(\d{2})(\d{2})/);
    if (!dateM) continue;
    const date = `${dateM[1]}-${dateM[2]}-${dateM[3]}`;
    const timeM = dtstart.match(/T(\d{2})(\d{2})/);
    const time  = timeM ? `${timeM[1]}:${timeM[2]}` : "";

    // Parse home/away from SUMMARY (GameChanger formats: "Home @ Away" or "Home vs Away")
    let homeTeam = "", awayTeam = "";
    if (summary) {
      const atMatch  = summary.match(/^(.+?)\s+@\s+(.+)$/);
      const vsMatch  = summary.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
      if (atMatch)  { homeTeam = atMatch[1].trim();  awayTeam = atMatch[2].trim(); }
      else if (vsMatch) { homeTeam = vsMatch[1].trim(); awayTeam = vsMatch[2].trim(); }
    }

    events.push({ date, time, location, uid, summary, homeTeam, awayTeam });
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

  // Fetch ALL team feeds; build reference games + divDate map for city-schedule matching
  const eventsByDivDate = {}; // "DIVISION|DATE" → [{uid, teamName, location}]
  let added = 0, failed = 0;

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
        eventsByDivDate[key].push({ uid: ev.uid, teamName: team.name, location: ev.location, homeTeam: ev.homeTeam, awayTeam: ev.awayTeam });

      // Save as reference game if not already stored
      if (existingExtIds.has(ev.uid) || linkedUids.has(ev.uid)) continue;

      await db.collection("games").add({
        teamName:     team.name,
        division,
        date:         ev.date,
        time:         ev.time,
        location:     ev.location,
        homeTeam:     ev.homeTeam,
        awayTeam:     ev.awayTeam,
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
        // Copy team names from first matching ICS event if not already set
        const first = matches[0];
        if (!game.homeTeam && first.homeTeam) update.homeTeam = first.homeTeam;
        if (!game.awayTeam && first.awayTeam) update.awayTeam = first.awayTeam;
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
      // Pick up team names or location if GameChanger fills them in later
      const locatedMatch = matches.find(e =>
        /crooks,\s*sd/i.test(e.location) || /colton,\s*sd/i.test(e.location)
      );
      const teamUpdate = {};
      if (locatedMatch) teamUpdate.field = locatedMatch.location;
      const namedMatch = matches.find(e => e.homeTeam);
      if (namedMatch && !game.homeTeam) { teamUpdate.homeTeam = namedMatch.homeTeam; teamUpdate.awayTeam = namedMatch.awayTeam; }
      if (Object.keys(teamUpdate).length) await game.ref.update(teamUpdate);
    }
  }

  await db.doc("config/syncState").set(
    { lastSyncedAt: FieldValue.serverTimestamp(), lastResult: { added, linked, flagged, failed } },
    { merge: true }
  );
  console.log(`Sync: ${added} reference games added, ${linked} linked, ${flagged} flagged, ${failed} failed`);
  return { added, linked, flagged, failed };
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
  let added = 0;

  for (const ev of events) {
    if (!ev.uid) continue;
    const key = `${division}|${ev.date}`;
    if (!eventsByDivDate[key]) eventsByDivDate[key] = [];
    if (!eventsByDivDate[key].some(e => e.uid === ev.uid))
      eventsByDivDate[key].push({ uid: ev.uid, teamName: team.name, location: ev.location, homeTeam: ev.homeTeam, awayTeam: ev.awayTeam });

    if (existingExtIds.has(ev.uid) || linkedUids.has(ev.uid)) continue;
    await db.collection("games").add({
      teamName: team.name, division,
      date: ev.date, time: ev.time, location: ev.location,
      homeTeam: ev.homeTeam, awayTeam: ev.awayTeam,
      needsUmpires: false, umpireSlots: [], cancelled: false,
      externalId: ev.uid, source: "calendar",
      createdAt: FieldValue.serverTimestamp()
    });
    existingExtIds.add(ev.uid);
    added++;
  }

  const today = todayISO();
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
        await game.ref.update(update); linked++;
      }
    } else {
      const liveUids = new Set(matches.map(e => e.uid));
      const missing  = game.icsLinks.filter(l => !liveUids.has(l.uid));
      if (missing.length > 0 && !game.possibleChange) { await game.ref.update({ possibleChange: true }); flagged++; }
      else if (missing.length === 0 && game.possibleChange) { await game.ref.update({ possibleChange: false }); }
    }
  }

  return { added, linked, flagged };
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

  let msg = null;
  if (!before && after) {
    msg = `🆕 New game added: ${gameLabel(after)}`;
  } else if (before && !after) {
    msg = `🗑️ Game deleted: ${gameLabel(before)}`;
  } else if (before && after) {
    if (!before.cancelled && after.cancelled) {
      msg = `❌ Game cancelled: ${gameLabel(after)}`;
    } else if (before.cancelled && !after.cancelled) {
      msg = `✅ Game reinstated: ${gameLabel(after)}`;
    } else {
      // Only notify on field changes meaningful to umpires
      const changed = ["date","time","field","city","division"].some(k => before[k] !== after[k]);
      if (changed) msg = `✏️ Game updated: ${gameLabel(after)}`;
    }
  }

  if (!msg) return;

  await Promise.allSettled([
    hooks.jeff  ? postSlack(hooks.jeff,  msg) : null,
    channel     ? postSlack(channel,     msg) : null
  ].filter(Boolean));
});

// ── Phase 12: day-of reminders at 7 AM ───────────────────────────────────────

exports.sendDayOfReminders = onSchedule("every day 07:00", async () => {
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
