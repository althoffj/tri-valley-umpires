const { onSchedule }          = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError }   = require("firebase-functions/v2/https");
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

    const dateM = dtstart.match(/(\d{4})(\d{2})(\d{2})/);
    if (!dateM) continue;
    const date = `${dateM[1]}-${dateM[2]}-${dateM[3]}`;
    const timeM = dtstart.match(/T(\d{2})(\d{2})/);
    const time  = timeM ? `${timeM[1]}:${timeM[2]}` : "";

    events.push({ date, time, location, uid });
  }
  return events;
}

// ── Core sync logic ───────────────────────────────────────────────────────────

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function runSync() {
  const db = getFirestore();

  const teamsSnap = await db.doc("config/teamCalendars").get();
  const teams     = teamsSnap.exists ? (teamsSnap.data().teams || []) : [];
  console.log(`Teams in Firestore (${teams.length}): ${teams.map(t => t.name).join(", ") || "none"}`);
  const relevant  = teams.filter(t => /10U|12U/i.test(t.name));
  console.log(`Relevant 10U/12U teams (${relevant.length}): ${relevant.map(t => t.name).join(", ") || "none"}`);

  if (relevant.length === 0) return { added: 0, failed: 0 };

  const gamesSnap  = await db.collection("games").get();
  const seenUids   = new Set(gamesSnap.docs.map(d => d.data().externalId).filter(Boolean));

  const ratesSnap  = await db.doc("config/payRates").get();
  const rates      = ratesSnap.exists ? ratesSnap.data() : {};
  const defaultPay = rates.plate || 0;

  const today = todayISO();
  let added = 0, failed = 0;

  for (const team of relevant) {
    let icsText;
    try {
      icsText = await fetchICS(team.icsUrl);
    } catch (err) {
      console.error(`Failed to fetch ${team.name}: ${err.message}`);
      failed++;
      continue;
    }

    const division = /10U/i.test(team.name) ? "10U" : "12U";

    const events = parseVEvents(icsText);
    const upcoming = events.filter(e => e.date >= today);
    console.log(`  ${team.name}: ${events.length} total, ${upcoming.length} upcoming`);

    for (const ev of events) {
      if (ev.date < today) continue;

      // Empty location = home game; non-empty = away game at another venue
      // Also accept explicit Crooks/Colton addresses in case GameChanger fills them in
      let city = null;
      if (!ev.location) {
        city = division === "12U" ? "City of Crooks" : "City of Colton";
      } else if (/crooks,\s*sd/i.test(ev.location)) {
        city = "City of Crooks";
      } else if (/colton,\s*sd/i.test(ev.location)) {
        city = "City of Colton";
      }
      if (!city) continue;

      if (ev.uid && seenUids.has(ev.uid)) continue;

      await db.collection("games").add({
        city, division,
        date:   ev.date,
        time:   ev.time,
        type:   "Regular",
        field:  ev.location,
        payRate: defaultPay,
        umpireSlots: [
          { type: "Plate", assignedUid: null, assignedName: null },
          { type: "Field", assignedUid: null, assignedName: null }
        ],
        cancelled:  false,
        externalId: ev.uid || null,
        source:     "calendar",
        createdAt:  FieldValue.serverTimestamp()
      });

      if (ev.uid) seenUids.add(ev.uid);
      added++;
    }
  }

  await db.doc("config/syncState").set(
    { lastSyncedAt: FieldValue.serverTimestamp(), lastResult: { added, failed } },
    { merge: true }
  );

  console.log(`Sync complete: ${added} added, ${failed} failed`);
  return { added, failed };
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

    const ratesSnap  = await db.doc("config/payRates").get();
    const rates      = ratesSnap.exists ? ratesSnap.data() : {};
    const defaultPay = rates.plate || 0;

    let added = 0, skipped = 0;
    for (const g of CITY_SCHEDULE) {
      const externalId = `city-2026-${g.city.replace(/\s+/g,"").toLowerCase()}-${g.division}-${g.date}-${g.field.replace(/\s+/g,"")}`;
      const existing = await db.collection("games").where("externalId", "==", externalId).limit(1).get();
      if (!existing.empty) { skipped++; continue; }
      await db.collection("games").add({
        city:       g.city,
        division:   g.division,
        date:       g.date,
        time:       g.time,
        type:       "Regular",
        field:      g.field,
        payRate:    defaultPay,
        umpireSlots: [
          { type: "Plate", assignedUid: null, assignedName: null },
          { type: "Field", assignedUid: null, assignedName: null }
        ],
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
