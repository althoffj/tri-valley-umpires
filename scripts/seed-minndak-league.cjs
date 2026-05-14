#!/usr/bin/env node
/**
 * seed-minndak-league.cjs — CommonJS version, runs from project root using
 * the firebase-admin package inside functions/node_modules.
 *
 * Usage (from project root):
 *   node scripts/seed-minndak-league.cjs
 */

const admin = require("/Users/jeffalthoff/Development/tri-valley-umpires/functions/node_modules/firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      "/Users/jeffalthoff/Development/tri-valley-umpires/tri-valley-baseball-umpires-firebase-adminsdk-fbsvc-e45616848b.json"
    ),
  });
}
const db = admin.firestore();

const MINNDAK = {
  name:       "MinnDak",
  websiteUrl: "https://www.minndak.org",
  notes:      "Governs 10U and 12U White divisions.",
  contacts: [
    { name: "Heather Bunde", role: "League Contact", email: "", phone: "" }
  ],
  homeLocations: [],
  createdAt: admin.firestore.FieldValue.serverTimestamp(),
};

async function main() {
  // 1. Upsert MinnDak in the `leagues` collection ───────────────────────────
  const leaguesCol = db.collection("leagues");
  const existing   = await leaguesCol.where("name", "==", "MinnDak").limit(1).get();

  let leagueId;
  if (!existing.empty) {
    leagueId = existing.docs[0].id;
    await leaguesCol.doc(leagueId).update({
      websiteUrl: MINNDAK.websiteUrl,
      notes:      MINNDAK.notes,
      contacts:   MINNDAK.contacts,
    });
    console.log(`✅ Updated existing MinnDak league  (id: ${leagueId})`);
  } else {
    const ref = await leaguesCol.add(MINNDAK);
    leagueId  = ref.id;
    console.log(`✅ Created MinnDak league  (id: ${leagueId})`);
  }

  // 2. Assign to matching teams in config/teamCalendars ─────────────────────
  const configRef  = db.doc("config/teamCalendars");
  const configSnap = await configRef.get();

  if (!configSnap.exists) {
    console.log("ℹ  config/teamCalendars not found — no teams to update.");
    return;
  }

  const teams   = configSnap.data().teams || [];
  let   changed = 0;

  const updated = teams.map(t => {
    const div  = (t.division || "").trim();
    const name = (t.name     || "").trim().toLowerCase();
    const is10U      = div === "10U";
    const is12UWhite = div === "12U" && name.includes("white");

    if (is10U || is12UWhite) {
      console.log(`  → Assigning MinnDak to: ${t.name} (${div})`);
      changed++;
      return { ...t, leagueId, leagueName: "MinnDak" };
    }
    return t;
  });

  if (changed === 0) {
    console.log("ℹ  No matching teams found in config/teamCalendars.");
    console.log("   Assign MinnDak manually via Admin → Scheduler → Teams.");
  } else {
    await configRef.update({ teams: updated });
    console.log(`\n✅ Done — ${changed} team(s) updated.`);
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
