// ── Bronze Bracket: 9-team DE → 8-team DE Restructure ────────────────────────
// Paste into the browser console while on admin-tournament.html.
// Tournament: 3iE3aa9uQAz5P3DN8XFD
//
// What this does:
//   • Deletes G1 (play-in) and G8 (extra LB game from the bye structure)
//   • Renumbers the remaining 15 games to G1–G15 (8-team DE layout)
//   • Removes the Seed #9 participant from the bronze bracket
//   • Clears bracketAdvancement for bronze (reapply via "Apply Standard DE Bracket Rules")
//   • Clears homeTeam/awayTeam from bronze games (reapply via "Apply Seeds to Games")
//
// Mapping verified against BRACKET_TEMPLATES in admin-tournament.js:
//
//   DELETE  9DE G1  (play-in #8v#9)
//   DELETE  9DE G8  (W(G6)vL(G5) — extra LB game from the bye)
//
//   9DE G5  → 8DE G1   (#1's game, now #1 vs #8 directly)
//   9DE G4  → 8DE G2   (#4 vs #5 — unchanged)
//   9DE G2  → 8DE G3   (#2 vs #7 — unchanged)
//   9DE G3  → 8DE G4   (#3 vs #6 — unchanged)
//   9DE G6  → 8DE G5   (LB R1 top)
//   9DE G7  → 8DE G6   (LB R1 bottom — L(#2v#7) vs L(#3v#6), unchanged)
//   9DE G10 → 8DE G7   (WB semi top  — W(G1)vW(G2) in new numbering)
//   9DE G9  → 8DE G8   (WB semi bottom — W(G3)vW(G4) in new numbering)
//   9DE G12 → 8DE G9   (LB — L(WB semi top) vs W(LB R1 top))
//   9DE G11 → 8DE G10  (LB — L(WB semi bot) vs W(LB R1 bot))
//   9DE G13 → 8DE G11  (WB Final)
//   9DE G14 → 8DE G12  (LB)
//   9DE G15 → 8DE G13  (LB Final)
//   9DE G16 → 8DE G14  (Championship)
//   9DE G17 → 8DE G15  (If Necessary)

(async () => {
  const TID = "3iE3aa9uQAz5P3DN8XFD";

  const { db } = await import('./firebase.js');
  const {
    getDoc, getDocs, query, collection, where, doc, writeBatch,
  } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

  // ── Load tournament ──────────────────────────────────────────────────────────
  const tSnap = await getDoc(doc(db, 'tournaments', TID));
  if (!tSnap.exists()) { console.error('❌ Tournament not found:', TID); return; }
  const tournament = { id: TID, ...tSnap.data() };
  console.log('✅ Tournament:', tournament.name, '—', tournament.date);

  // ── Load all linked games ────────────────────────────────────────────────────
  const gSnap = await getDocs(query(
    collection(db, 'games'),
    where('tournamentId', '==', TID)
  ));
  const allGames = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // ── Identify bronze bracket ──────────────────────────────────────────────────
  const brackets = [...new Set(allGames.map(g => g.field || '').filter(Boolean))].sort();
  console.log('Brackets:', brackets);

  const bronzeBracket = brackets.find(b => /bronze/i.test(b))
    || brackets.find(b => /\b3\b/.test(b))
    || null;

  if (!bronzeBracket) {
    console.error('❌ No bronze bracket found. Brackets:', brackets);
    return;
  }
  console.log('Bronze bracket name:', JSON.stringify(bronzeBracket));

  // ── Parse game numbers from notes ─────────────────────────────────────────────
  const bronzeGames = allGames.filter(g => g.field === bronzeBracket);
  const byNum = {};
  bronzeGames.forEach(g => {
    const m = (g.notes || '').match(/Game\s+(\d+)/i);
    if (m) byNum[parseInt(m[1])] = g;
  });

  const foundNums = Object.keys(byNum).map(Number).sort((a, b) => a - b);
  console.log(`\nBronze games (${foundNums.length}): G${foundNums.join(', G')}`);
  console.log('\nCurrent roster:');
  foundNums.forEach(n => {
    const g = byNum[n];
    const teams = (g.homeTeam || g.awayTeam)
      ? `${g.homeTeam || 'TBD'} vs ${g.awayTeam || 'TBD'}`
      : '(teams TBD)';
    console.log(`  G${String(n).padStart(2)}: ${g.date} ${g.time}  ${teams}  [${g.notes}]`);
  });

  if (foundNums.length !== 17) {
    console.warn(`\n⚠️  Expected 17 games for a 9-team DE bracket, found ${foundNums.length}.`);
  }

  // ── Mapping ──────────────────────────────────────────────────────────────────
  const TO_DELETE = [1, 8];  // 9DE game numbers to delete
  const REMAP = {            // 9DE game number → 8DE game number
     5:  1,
     4:  2,
     2:  3,
     3:  4,
     6:  5,
     7:  6,
    10:  7,
     9:  8,
    12:  9,
    11: 10,
    13: 11,
    14: 12,
    15: 13,
    16: 14,
    17: 15,
  };

  // ── Preview ──────────────────────────────────────────────────────────────────
  console.log('\n── Planned changes ─────────────────────────────────────────────────────────');
  for (const n of TO_DELETE) {
    const g = byNum[n];
    console.log(g
      ? `  DELETE  G${n}: ${g.notes}  (${g.date} ${g.time})`
      : `  DELETE  G${n}: ⚠️ not found — skipping`
    );
  }
  for (const [from, to] of Object.entries(REMAP).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const g = byNum[Number(from)];
    const newNotes = g ? (g.notes || '').replace(/Game\s+\d+/i, `Game ${to}`) : '—';
    console.log(g
      ? `  RENAME  G${from} → G${to}:  "${g.notes}" → "${newNotes}"`
      : `  RENAME  G${from} → G${to}:  ⚠️ not found — skipping`
    );
  }

  const seed9 = (tournament.participants || []).find(
    p => p.bracket === bronzeBracket && p.seed === 9
  );
  if (seed9) {
    console.log(`\n  REMOVE  Seed #9 participant: ${seed9.teamName}`);
  } else {
    console.log('\n  (No Seed #9 participant found in bronze bracket)');
  }
  console.log('  CLEAR   bracketAdvancement for bronze (click "Apply Standard DE Bracket Rules" after)');
  console.log('  CLEAR   homeTeam/awayTeam from all bronze games (click "Apply Seeds to Games" after)');

  // ── Confirm ──────────────────────────────────────────────────────────────────
  if (!confirm(
    `Restructure "${bronzeBracket}" from 9-team DE → 8-team DE?\n\n` +
    `• Delete G1 (play-in) and G8 (extra LB game)\n` +
    `• Renumber 15 remaining games to G1–G15\n` +
    `• Remove Seed #9 participant\n` +
    `• Clear bracket advancement rules\n` +
    `• Clear team names (reapply seeds after)\n\n` +
    `This is atomic — all changes succeed or none do. Proceed?`
  )) {
    console.log('Cancelled — no changes made.');
    return;
  }

  // ── Execute (single atomic batch) ────────────────────────────────────────────
  const batch = writeBatch(db);

  // Delete the two game documents
  for (const n of TO_DELETE) {
    if (byNum[n]) {
      batch.delete(doc(db, 'games', byNum[n].id));
    }
  }

  // Renumber remaining games and clear team assignments
  for (const [fromStr, toNum] of Object.entries(REMAP)) {
    const g = byNum[Number(fromStr)];
    if (!g) continue;

    const newNotes = (g.notes || '').replace(/Game\s+\d+/i, `Game ${toNum}`);
    batch.update(doc(db, 'games', g.id), {
      notes:    newNotes,
      homeTeam: '',
      awayTeam: '',
    });
  }

  // Update tournament doc: remove seed #9, clear bronze advancement
  const updatedParticipants = (tournament.participants || []).filter(
    p => !(p.bracket === bronzeBracket && p.seed === 9)
  );
  const updatedAdvancement = { ...(tournament.bracketAdvancement || {}) };
  delete updatedAdvancement[bronzeBracket];

  batch.update(doc(db, 'tournaments', TID), {
    participants:       updatedParticipants,
    bracketAdvancement: updatedAdvancement,
  });

  try {
    await batch.commit();
    console.log('\n✅ All changes committed successfully!\n');
    console.log('Next steps (in admin-tournament.html after refreshing the page):');
    console.log('  1. Refresh the page');
    console.log('  2. Bracket Flow section → "Apply Standard DE Bracket Rules"');
    console.log('  3. Participating Teams → verify Seed #9 is gone; update seed #8 team if needed');
    console.log('  4. Team Seedings → "Apply Seeds to Games"');
    console.log('  5. Check the tournament viewer to confirm the 8DE bracket renders correctly');
  } catch (err) {
    console.error('\n❌ Batch failed — no changes were made:', err.message);
    console.error(err);
  }
})();
