#!/usr/bin/env node
/**
 * seed-minndak-league.js
 *
 * One-time script: creates the MinnDak league in the `leagues` Firestore
 * collection and assigns it to all 10U teams and the "12U White" team stored
 * in config/teamCalendars.
 *
 * Usage (from project root):
 *   node --input-type=module scripts/seed-minndak-league.js
 *
 * Auth: uses Application Default Credentials — run `firebase login` or set
 * GOOGLE_APPLICATION_CREDENTIALS to a service account key file.
 */

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp }       from "firebase-admin/firestore";

if (!getApps().length) {
  initializeApp({ projectId: "tri-valley-baseball-umpires" });
}
const db = getFirestore();

// ── MinnDak league definition ─────────────────────────────────────────────────

const MINNDAK = {
  name:          "MinnDak",
  websiteUrl:    "https://www.minndak.org",
  notes:         "Governs 10U and 12U White divisions.",
  contacts: [
    { name: "Heather Bunde", role: "League Contact", email: "", phone: "" }
  ],
  homeLocations: [],
  createdAt:     Timestamp.now(),
};

async function main() {
  // 1. Upsert the MinnDak league in the `leagues` collection ─────────────────
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

  // 2. Update matching teams in config/teamCalendars ────────────────────────
  //    Teams are stored as an array inside a single config document.
  const configRef = db.doc("config/teamCalendars");
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
