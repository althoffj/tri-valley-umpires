// tournament.js — Public-facing tournament bracket viewer with live scores
import { db } from "./firebase.js";
import { authReadyPromise, isApproved, isAdmin, isLoggedIn } from "./auth.js";
import { esc, fmtDate, fmtTime } from "./utils.js";
import {
  collection, getDocs, query, orderBy, where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── State ─────────────────────────────────────────────────────────────────────

let allTournaments    = [];
let currentGames      = [];
let selectedTid       = null;
let activeBracket     = null;   // null = "All"
let bracketAdvancement = {};
let _refreshTimer     = null;
let displayOpts       = { scores: true, time: true, routing: true, seeds: true, umpires: false };
let viewStyle         = "bracket";  // "bracket" | "list" | "teams"
let selectedTeam      = null;       // team name currently highlighted in bracket view

// ── Bracket position maps (from spreadsheet row/col) ─────────────────────────
// Each entry: game number → { col, row } using the spreadsheet's coordinate system.
// Columns represent rounds; rows represent vertical position.

const POSITIONS_8DE = {
   1: {col:1,  row:3 },   // #1 vs #8
   2: {col:1,  row:10},   // #4 vs #5
   3: {col:1,  row:17},   // #2 vs #7
   4: {col:1,  row:24},   // #3 vs #6
   5: {col:1,  row:35},   // L(G1) vs L(G2)
   6: {col:1,  row:47},   // L(G3) vs L(G4)
   7: {col:3,  row:7 },   // W(G1) vs W(G2)
   8: {col:3,  row:21},   // W(G3) vs W(G4)
   9: {col:3,  row:33},   // L(G7) vs W(G5)
  10: {col:3,  row:45},   // L(G8) vs W(G6)
  11: {col:5,  row:14},   // W(G7) vs W(G8) — WB Final
  12: {col:5,  row:39},   // W(G9) vs W(G10)
  13: {col:7,  row:35},   // L(G11) vs W(G12) — LB Final
  14: {col:9,  row:24},   // Championship
  15: {col:12, row:33},   // If necessary
};

const POSITIONS_9DE = {
   1: {col:1,  row:19},   // #8 vs #9 play-in
   2: {col:3,  row:3 },   // #2 vs #7
   3: {col:3,  row:10},   // #3 vs #6
   4: {col:3,  row:24},   // #4 vs #5
   5: {col:3,  row:17},   // #1 vs W(G1)
   6: {col:1,  row:33},   // L(G1) vs L(G4)
   7: {col:3,  row:47},   // L(G2) vs L(G3)
   8: {col:3,  row:35},   // W(G6) vs L(G5)
   9: {col:5,  row:7 },   // W(G2) vs W(G3)
  10: {col:5,  row:21},   // W(G4) vs W(G5)
  11: {col:5,  row:45},   // W(G7) vs L(G10)
  12: {col:5,  row:33},   // W(G8) vs L(G9)
  13: {col:7,  row:14},   // W(G9) vs W(G10) — WB Final
  14: {col:7,  row:39},   // W(G11) vs W(G12)
  15: {col:9,  row:35},   // L(G13) vs W(G14) — LB Final
  16: {col:11, row:24},   // Championship
  17: {col:14, row:33},   // If necessary
};

function getPositions(bracketName, bGames) {
  // Primary: detect from actual game numbers in the bracket (9DE goes up to G17, 8DE to G15)
  if (bGames && bGames.length) {
    const maxNum = Math.max(0, ...bGames.map(g => {
      const m = (g.notes || "").match(/Game\s+(\d+)/i);
      return m ? parseInt(m[1]) : 0;
    }));
    if (maxNum > 0) return maxNum > 15 ? POSITIONS_9DE : POSITIONS_8DE;
  }
  // Fallback: bracket name heuristics
  const n = (bracketName || "").toLowerCase();
  if (n.includes("3") || n.includes("bronze") || n.includes("9")) return POSITIONS_9DE;
  return POSITIONS_8DE;
}

// Pixel layout constants
const CARD_W = 172;

// Map spreadsheet column numbers to SVG x-pixel positions
const COL_X = {1:8, 3:222, 5:436, 7:640, 9:844, 11:1048, 12:1048, 14:1252};
const ROW_SCALE = 13.5;  // pixels per spreadsheet row unit

function cx(col)  { return COL_X[col] ?? (col * 100); }
function cy(row)  { return Math.round((row - 1) * ROW_SCALE); }

// ── SVG Bracket renderer ──────────────────────────────────────────────────────

function renderBracketSVG(bracket, bGames, bAdvRules, today, opts, participants) {
  // Card geometry — base body is 62px; add rows for umpires and/or routing footer
  const UMPIRE_H   = opts.umpires  ? 14 : 0;
  const CARD_H     = 62 + UMPIRE_H + (opts.routing ? 18 : 0);
  // Connector arrival Y offsets (fixed — home/away rows are always at the same positions)
  const HOME_Y_OFF = 29;  // center of home team row (header 18px, row ends at 40px)
  const AWAY_Y_OFF = 51;  // center of away team row (row starts 40px, ends at 62px)

  const positions = getPositions(bracket, bGames);
  const maxCol    = Math.max(...Object.values(positions).map(p => p.col));
  const maxRow    = Math.max(...Object.values(positions).map(p => p.row));

  const SVG_W = cx(maxCol) + CARD_W + 20;
  const SVG_H = cy(maxRow) + CARD_H + 24;

  // Map game number → game doc
  const gameMap = {};
  bGames.forEach(g => {
    const m = (g.notes || "").match(/Game\s+(\d+)/i);
    if (m) gameMap[parseInt(m[1])] = g;
  });

  // Seed lookup: teamName → seed number
  const seedMap = {};
  (participants || []).forEach(p => { if (p.teamName) seedMap[p.teamName] = p.seed; });

  // ── Team selection highlights ──
  const selTeam     = opts.selectedTeam || null;
  const activeGames = new Set();   // games the selected team is currently in
  const winNext     = new Set();   // games they'd go to if they win
  const lossNext    = new Set();   // games they'd go to if they lose

  if (selTeam) {
    Object.entries(gameMap).forEach(([numStr, g]) => {
      const num = parseInt(numStr);
      if (g.homeTeam === selTeam || g.awayTeam === selTeam) {
        activeGames.add(num);
        const rule = bAdvRules[num] || {};
        if (rule.winner?.game) winNext.add(rule.winner.game);
        if (rule.loser?.game)  lossNext.add(rule.loser.game);
      }
    });
    // Don't double-highlight games the team is already playing in
    activeGames.forEach(n => { winNext.delete(n); lossNext.delete(n); });
  }
  const hasSel = selTeam && activeGames.size > 0;

  // ── Connector lines ──
  const dimLines    = [];
  const brightLines = [];
  Object.entries(bAdvRules).forEach(([numStr, rule]) => {
    const num    = parseInt(numStr);
    const srcPos = positions[num];
    if (!srcPos) return;

    const srcX    = cx(srcPos.col) + CARD_W;
    const srcMidY = cy(srcPos.row) + CARD_H / 2;

    function drawLine(destGame, slot, isWinner) {
      const dstPos = positions[destGame];
      if (!dstPos) return;
      const dstX    = cx(dstPos.col);
      const dstY    = cy(dstPos.row) + (slot === "away" ? AWAY_Y_OFF : HOME_Y_OFF);
      const elbowX  = srcX + Math.round((dstX - srcX) / 2);
      const color   = isWinner ? "#4ade80" : "#f87171";
      const dash    = isWinner ? "" : `stroke-dasharray="6,4"`;
      const opacity = isWinner ? "0.75" : "0.6";
      const path    = `<path d="M${srcX},${srcMidY} H${elbowX} V${dstY} H${dstX}" ` +
        `fill="none" stroke="${color}" stroke-width="1.5" opacity="${opacity}" ${dash}/>`;
      if (hasSel && activeGames.has(num)) brightLines.push(path);
      else dimLines.push(path);
    }

    if (rule.winner?.game) drawLine(rule.winner.game, rule.winner.slot, true);
    if (rule.loser?.game)  drawLine(rule.loser.game,  rule.loser.slot,  false);
  });

  // ── Game cards ──
  const cards = Object.entries(positions).map(([numStr, pos]) => {
    const num = parseInt(numStr);
    const g   = gameMap[num];
    const x   = cx(pos.col);
    const y   = cy(pos.row);

    if (!g) {
      return `
        <g>
          <rect x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}"
            rx="5" fill="#141414" stroke="#2a2a2a" stroke-width="1"/>
          <text x="${x+8}" y="${y+15}" fill="#777" font-size="10" font-family="system-ui">
            Game ${num}
          </text>
          <text x="${x+8}" y="${y+35}" fill="#555" font-size="11" font-family="system-ui">TBD</text>
          <line x1="${x}" y1="${y+22}" x2="${x+CARD_W}" y2="${y+22}" stroke="#1e1e1e"/>
          <text x="${x+8}" y="${y+55}" fill="#555" font-size="11" font-family="system-ui">TBD</text>
        </g>`;
    }

    const hasScore  = g.homeScore != null && g.awayScore != null;
    const isToday   = g.date === today;
    const cancelled = g.cancelled;
    const ifNec     = (g.notes || "").toLowerCase().includes("if necessary");

    const homeWin  = hasScore && g.homeScore > g.awayScore;
    const awayWin  = hasScore && g.awayScore > g.homeScore;

    // Seed prefixes
    const homeSeed = seedMap[g.homeTeam] ?? null;
    const awaySeed = seedMap[g.awayTeam] ?? null;
    const seedPad  = (opts.seeds && (homeSeed != null || awaySeed != null));
    const nameMaxW = seedPad ? 14 : 18;
    const nameX    = x + 7;
    const homeName = truncate(g.homeTeam || "TBD", nameMaxW);
    const awayName = truncate(g.awayTeam || "TBD", nameMaxW);

    // Colors
    const bgFill      = cancelled ? "#111" : hasScore ? "#0f1f0f" : isToday ? "#1a1a00" : "#161616";
    const borderColor = cancelled ? "#222" : hasScore ? "#1e4a1e" : isToday ? "#4a4a00" : "#2a2a2a";
    const headerBg    = cancelled ? "#111" : "#0d0d0d";
    const divColor    = cancelled ? "#1a1a1a" : hasScore ? "#1a3a1a" : isToday ? "#252500" : "#1e1e1e";
    const footerBg    = cancelled ? "#0d0d0d" : "#0b0b0b";

    const homeColor      = homeWin ? "#fff" : "#ccc";
    const awayColor      = awayWin ? "#fff" : "#ccc";
    const homeWeight     = homeWin ? "bold" : "normal";
    const awayWeight     = awayWin ? "bold" : "normal";
    const homeScoreColor = homeWin ? "#4ade80" : "#999";
    const awayScoreColor = awayWin ? "#4ade80" : "#999";

    const timeStr    = g.date === today ? `Today ${fmtTime(g.time)}` :
                       `${fmtDate(g.date).slice(0,6)} ${fmtTime(g.time)}`;
    const headerLabel = `G${num}${ifNec ? "*" : ""}`;
    // Selection-state overlay
    let selOpacity    = cancelled ? "0.4" : "1";
    let selStroke     = borderColor;
    let selStrokeW    = "1";
    if (hasSel) {
      if (activeGames.has(num))    { selStroke = "#fbbf24"; selStrokeW = "2.5"; }
      else if (winNext.has(num))   { selStroke = "#4ade80"; selStrokeW = "2"; selOpacity = cancelled ? "0.3" : "0.65"; }
      else if (lossNext.has(num))  { selStroke = "#f87171"; selStrokeW = "2"; selOpacity = cancelled ? "0.3" : "0.65"; }
      else                         { selOpacity = "0.1"; }
    }
    const opacity = selOpacity;

    // Routing footer text
    const rule    = bAdvRules[num] || {};
    const wNext   = rule.winner?.game ? `W→G${rule.winner.game}` : "";
    const lNext   = rule.loser?.game  ? `L→G${rule.loser.game}`  : "";
    const routeParts = [wNext, lNext].filter(Boolean);
    const routeText  = routeParts.length ? routeParts.join("  ·  ") : (wNext || lNext || "");

    return `
      <g opacity="${opacity}">
        <rect x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}"
          rx="5" fill="${bgFill}" stroke="${selStroke}" stroke-width="${selStrokeW}"/>

        <!-- Header bar -->
        <rect x="${x}" y="${y}" width="${CARD_W}" height="18" rx="5" fill="${headerBg}"/>
        <rect x="${x}" y="${y+13}" width="${CARD_W}" height="5" fill="${headerBg}"/>
        <text x="${x+7}" y="${y+13}" fill="#a78bfa" font-size="10" font-weight="bold"
          font-family="system-ui,sans-serif">${esc(headerLabel)}</text>
        ${opts.time ? `<text x="${x+CARD_W-7}" y="${y+13}" fill="#999" font-size="9"
          text-anchor="end" font-family="system-ui,sans-serif">${esc(timeStr)}</text>` : ""}

        <line x1="${x}" y1="${y+18}" x2="${x+CARD_W}" y2="${y+18}" stroke="${divColor}"/>

        <!-- Home row -->
        ${opts.seeds && homeSeed != null ? `<text x="${x+6}" y="${y+34}" fill="#c4b5fd" font-size="9"
          font-weight="bold" font-family="system-ui,sans-serif">#${homeSeed}</text>` : ""}
        <text x="${seedPad && homeSeed != null ? x+24 : nameX}" y="${y+34}" fill="${homeColor}"
          font-size="11" font-weight="${homeWeight}" font-family="system-ui,sans-serif">${esc(homeName)}</text>
        ${opts.scores && hasScore ? `<text x="${x+CARD_W-7}" y="${y+34}" fill="${homeScoreColor}"
          font-size="12" font-weight="bold" text-anchor="end" font-family="system-ui,sans-serif">${g.homeScore}</text>` : ""}
        ${g.homeTeam && g.homeTeam !== "TBD" ? `<rect x="${x}" y="${y+18}" width="${CARD_W}" height="22"
          fill="transparent" data-select-team="${esc(g.homeTeam)}" style="cursor:pointer"/>` : ""}

        <line x1="${x}" y1="${y+40}" x2="${x+CARD_W}" y2="${y+40}" stroke="${divColor}"/>

        <!-- Away row -->
        ${opts.seeds && awaySeed != null ? `<text x="${x+6}" y="${y+57}" fill="#c4b5fd" font-size="9"
          font-weight="bold" font-family="system-ui,sans-serif">#${awaySeed}</text>` : ""}
        <text x="${seedPad && awaySeed != null ? x+24 : nameX}" y="${y+57}" fill="${awayColor}"
          font-size="11" font-weight="${awayWeight}" font-family="system-ui,sans-serif">${esc(awayName)}</text>
        ${opts.scores && hasScore ? `<text x="${x+CARD_W-7}" y="${y+57}" fill="${awayScoreColor}"
          font-size="12" font-weight="bold" text-anchor="end" font-family="system-ui,sans-serif">${g.awayScore}</text>` : ""}
        ${g.awayTeam && g.awayTeam !== "TBD" ? `<rect x="${x}" y="${y+40}" width="${CARD_W}" height="22"
          fill="transparent" data-select-team="${esc(g.awayTeam)}" style="cursor:pointer"/>` : ""}

        <!-- Umpire row (only when opts.umpires and user is signed in) -->
        ${opts.umpires ? (() => {
          const names = (g.umpireSlots || [])
            .filter(s => s.assignedName)
            .map(s => s.assignedName)
            .join(" · ");
          const assigned = !!names;
          const label    = truncate(names || "Unassigned", 24);
          const color    = assigned ? "#fbbf24" : "#ef4444";
          const weight   = assigned ? "normal" : "bold";
          return `
          <line x1="${x}" y1="${y+62}" x2="${x+CARD_W}" y2="${y+62}" stroke="${divColor}"/>
          <text x="${x+7}" y="${y+72}" fill="${color}" font-size="9" font-weight="${weight}"
            font-family="system-ui,sans-serif">🧑‍⚖️ ${esc(label)}</text>`;
        })() : ""}

        <!-- Routing footer (only when opts.routing) -->
        ${opts.routing && routeText ? `
          <line x1="${x}" y1="${y+62+UMPIRE_H}" x2="${x+CARD_W}" y2="${y+62+UMPIRE_H}" stroke="${divColor}"/>
          <rect x="${x}" y="${y+62+UMPIRE_H}" width="${CARD_W}" height="${CARD_H - 62 - UMPIRE_H}" fill="${footerBg}"/>
          <text x="${x+7}" y="${y+75+UMPIRE_H}" fill="#aaa" font-size="9"
            font-family="system-ui,sans-serif">${esc(routeText)}</text>` : ""}
      </g>`;
  }).join("");

  const refreshNote = `<text x="${SVG_W - 8}" y="${SVG_H - 6}" fill="#666" font-size="9"
    text-anchor="end" font-family="system-ui">* = if necessary  |  green = winner path  |  dashed = loser path</text>`;

  return `
    <svg xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 ${SVG_W} ${SVG_H}"
      style="min-width:${SVG_W}px;display:block;background:#0a0a0a;border-radius:8px">
      ${hasSel
        ? `<g opacity="0.15">${dimLines.join("")}</g>${brightLines.join("")}`
        : dimLines.join("")}
      ${cards}
      ${refreshNote}
    </svg>`;
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadTournaments() {
  const snap = await getDocs(query(collection(db, "tournaments"), orderBy("date", "desc")));
  allTournaments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function loadGamesForTournament(tid) {
  const snap = await getDocs(query(
    collection(db, "games"),
    where("tournamentId", "==", tid)
  ));
  currentGames = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.time || "").localeCompare(b.time || ""));
  const t = allTournaments.find(x => x.id === tid);
  bracketAdvancement = t?.bracketAdvancement || {};
}

// ── Print / Save PDF ─────────────────────────────────────────────────────────

function printBrackets() {
  const t       = allTournaments.find(x => x.id === selectedTid);
  const tName   = t?.name || "Tournament Bracket";
  const today   = new Date().toISOString().slice(0, 10);

  const visible = activeBracket
    ? currentGames.filter(g => g.field === activeBracket)
    : currentGames;

  const bracketOrder = [];
  const byBracket    = {};
  visible.forEach(g => {
    const b = g.field || "Games";
    if (!byBracket[b]) { byBracket[b] = []; bracketOrder.push(b); }
    byBracket[b].push(g);
  });

  const sections = bracketOrder.map((bracket, i) => {
    const bGames   = [...byBracket[bracket]].sort((a, b) => {
      const nA = parseInt((a.notes || "").match(/Game\s+(\d+)/i)?.[1] || "999");
      const nB = parseInt((b.notes || "").match(/Game\s+(\d+)/i)?.[1] || "999");
      return nA - nB;
    });
    const bAdvRules = bracketAdvancement[bracket] || {};
    const bPartic   = (t?.participants || [])
      .filter(p => p.bracket === bracket)
      .sort((a, b) => (a.seed || 99) - (b.seed || 99));

    // Produce a print-friendly SVG (override min-width so it can scale)
    const svgRaw = renderBracketSVG(bracket, bGames, bAdvRules, today, displayOpts, bPartic);
    const svgScaled = svgRaw.replace(/style="min-width:[^"]*"/, 'style="width:100%;height:auto;display:block"');

    const seedsHtml = bPartic.length
      ? `<div style="margin:6px 0 10px;display:flex;flex-wrap:wrap;gap:4px">
           ${bPartic.map(p =>
             `<span style="padding:2px 8px;background:#1a1a2a;border:1px solid #333;border-radius:4px;font-size:11px">
               <b style="color:#c4b5fd">#${p.seed}</b> ${p.teamName || ""}
             </span>`).join("")}
         </div>`
      : "";

    const pageBreak = i < bracketOrder.length - 1
      ? 'style="page-break-after:always"'
      : "";

    return `<div ${pageBreak}>
      <h2 style="margin:0 0 4px;font-size:16px;color:#ddd">${bracket}</h2>
      ${seedsHtml}
      ${svgScaled}
    </div>`;
  }).join("\n");

  const optLabels = [
    displayOpts.scores  && "Scores",
    displayOpts.time    && "Date/Time",
    displayOpts.seeds   && "Seeds",
    displayOpts.routing && "Win/Loss routing",
    displayOpts.umpires && "Umpires",
  ].filter(Boolean).join(" · ");

  const html = `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${tName}</title>
  <style>
    @page { size: landscape; margin: 0.4in; }
    * { box-sizing: border-box; }
    body {
      background: #0d0d0d;
      color: #ddd;
      font-family: system-ui, sans-serif;
      margin: 0;
      padding: 0;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    h1 { font-size: 18px; margin: 0 0 2px; }
    .meta { font-size: 11px; color: #888; margin-bottom: 14px; }
  </style>
</head>
<body>
  <h1>${tName}</h1>
  <div class="meta">Showing: ${optLabels || "default"} · Printed ${new Date().toLocaleDateString()}</div>
  ${sections}
  <script>window.onload = () => { window.print(); }<\/script>
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) { alert("Pop-up blocked — please allow pop-ups for this site."); return; }
  win.document.write(html);
  win.document.close();
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderTournamentSelector() {
  const sel = document.getElementById("tournamentSelect");
  if (!allTournaments.length) {
    sel.innerHTML = `<option value="">No tournaments found</option>`;
    return;
  }
  sel.innerHTML = allTournaments.map(t =>
    `<option value="${esc(t.id)}">${esc(t.name)} — ${esc(fmtDate(t.date))}</option>`
  ).join("");
  sel.value = selectedTid || allTournaments[0].id;
}

function renderMeta() {
  const t  = allTournaments.find(x => x.id === selectedTid);
  const el = document.getElementById("tournamentMeta");
  if (!t) { el.textContent = ""; return; }

  const statusColors = {
    scheduled:"#7ec8f7", active:"#86efac", "rain-delay":"#ffd966", complete:"#888"
  };
  const s     = t.status || "scheduled";
  const color = statusColors[s] || "#7ec8f7";
  const label = s === "rain-delay" ? "Rain Delay" : s.charAt(0).toUpperCase() + s.slice(1);

  el.innerHTML = [
    t.division ? `<span class="badge" style="background:#1a2a3a;color:#7ec8f7">${esc(t.division)}</span>` : "",
    `<span class="badge" style="background:#1a1a1a;color:${color};border:1px solid ${color}33">${label}</span>`,
    t.location ? esc(t.location) : "",
  ].filter(Boolean).join("  &nbsp;·&nbsp;  ");
}

function renderBracketTabs() {
  const brackets = [...new Set(currentGames.map(g => g.field || "").filter(Boolean))].sort();
  const bar      = document.getElementById("bracketTabBar");

  if (brackets.length <= 1) { bar.style.display = "none"; activeBracket = null; return; }

  bar.style.display = "";
  bar.innerHTML = [
    `<button type="button" class="cal-view-btn bracket-tab-btn${activeBracket === null ? " active" : ""}" data-bracket="">All Brackets</button>`,
    ...brackets.map(b =>
      `<button type="button" class="cal-view-btn bracket-tab-btn${activeBracket === b ? " active" : ""}" data-bracket="${esc(b)}">${esc(b)}</button>`
    )
  ].join("");
}

// Shared helper: build a game row for the list view (used by render + print)
function buildListRows(games, opts, today, seedMap) {
  return games.map(g => {
    const noteMatch = (g.notes || "").match(/Game\s+(\d+)/i);
    const gameLabel = noteMatch ? `Game ${noteMatch[1]}` : "—";
    const ifNec     = (g.notes || "").toLowerCase().includes("if necessary");

    const homeScore = g.homeScore != null ? g.homeScore : "";
    const awayScore = g.awayScore != null ? g.awayScore : "";
    const hasScore  = homeScore !== "" && awayScore !== "";
    const homeWon   = hasScore && Number(g.homeScore) > Number(g.awayScore);
    const awayWon   = hasScore && Number(g.awayScore) > Number(g.homeScore);

    const homeWonStyle = homeWon ? "font-weight:bold;color:white" : hasScore ? "color:var(--light-text)" : "";
    const awayWonStyle = awayWon ? "font-weight:bold;color:white" : hasScore ? "color:var(--light-text)" : "";

    const homeSeed = opts.seeds && seedMap[g.homeTeam] ? `<span style="color:#c4b5fd;font-size:0.75rem;margin-right:3px">#${seedMap[g.homeTeam]}</span>` : "";
    const awaySeed = opts.seeds && seedMap[g.awayTeam] ? `<span style="color:#c4b5fd;font-size:0.75rem;margin-right:3px">#${seedMap[g.awayTeam]}</span>` : "";

    const scorePart = opts.scores && hasScore
      ? `<span style="font-size:0.9rem;font-weight:bold;color:#86efac;margin-left:6px">${g.homeScore}–${g.awayScore}</span>`
      : "";

    const dateStr = g.date === today ? "Today" : fmtDate(g.date);

    const umpireNames = (g.umpireSlots || [])
      .filter(s => s.assignedName).map(s => s.assignedName).join(", ");
    const umpireRow = opts.umpires
      ? `<div style="font-size:0.75rem;color:${umpireNames ? "#fbbf24" : "#ef4444"};font-weight:${umpireNames ? "normal" : "bold"};margin-top:2px">🧑‍⚖️ ${esc(umpireNames || "Unassigned")}</div>`
      : "";

    const colCount = opts.time ? 4 : 3;
    return `<tr${g.cancelled ? ' style="opacity:0.45"' : ""}>
      ${opts.time ? `<td style="white-space:nowrap;font-size:0.8rem;color:var(--light-text)">
        ${esc(dateStr)}<br><span style="font-size:0.75rem">${esc(fmtTime(g.time))}</span>
      </td>` : ""}
      <td style="font-size:0.82rem;white-space:nowrap">
        ${g.field ? `<span class="badge" style="background:#1a2a3a;color:#7ec8f7">${esc(g.field)}</span>` : ""}
        <span style="color:var(--light-text);font-size:0.78rem">${esc(gameLabel)}${ifNec ? " <em>(if nec.)</em>" : ""}</span>
      </td>
      <td>
        ${homeSeed}<span style="${homeWonStyle}">${esc(g.homeTeam || "TBD")}</span>
        <span style="color:var(--light-text);margin:0 5px">vs</span>
        ${awaySeed}<span style="${awayWonStyle}">${esc(g.awayTeam || "TBD")}</span>
        ${scorePart}
        ${g.cancelled ? ' <span style="color:#f87171;font-size:0.75rem">(cancelled)</span>' : ""}
        ${umpireRow}
      </td>
      <td style="font-size:0.8rem;color:var(--light-text)">${esc(g.city || "")}</td>
    </tr>`;
  }).join("");
}

function renderListView(container, visible) {
  const t      = allTournaments.find(x => x.id === selectedTid);
  const today  = new Date().toISOString().slice(0, 10);
  const sorted = [...visible].sort((a, b) =>
    (a.date || "").localeCompare(b.date || "") || (a.time || "").localeCompare(b.time || "")
  );

  // Build seed map across all brackets
  const seedMap = {};
  (t?.participants || []).forEach(p => { if (p.teamName) seedMap[p.teamName] = p.seed; });

  const rows = buildListRows(sorted, displayOpts, today, seedMap);
  const colCount = displayOpts.time ? 4 : 3;

  const listOpts = [
    ["scores", "Scores"],
    ["time",   "Date/Time"],
    ["seeds",  "Seeds"],
    ...(isLoggedIn() ? [["umpires", "Umpires"]] : []),
  ];
  const toolbar = `
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:14px;
                padding:8px 12px;background:#111;border:1px solid #222;border-radius:6px;font-size:0.8rem">
      <span style="color:var(--light-text);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em">Show:</span>
      ${listOpts.map(([key, label]) => `
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;color:#ccc">
          <input type="checkbox" class="bracket-disp-opt" data-opt="${key}"
            ${displayOpts[key] ? "checked" : ""}
            style="cursor:pointer;accent-color:#a78bfa">
          ${label}
        </label>`).join("")}
      <button id="listPrintBtn" type="button"
        style="margin-left:auto;padding:4px 12px;background:#1e1e2e;border:1px solid #444;
               border-radius:5px;color:#ccc;cursor:pointer;font-size:0.8rem;white-space:nowrap">
        🖨 Print / Save PDF
      </button>
    </div>`;

  container.innerHTML = toolbar + `
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--light-text)">
            ${displayOpts.time ? "<th>Date / Time</th>" : ""}
            <th>Bracket / Game</th>
            <th>Matchup</th>
            <th>Location</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="${colCount}" style="text-align:center;color:var(--light-text);padding:16px">No games.</td></tr>`}</tbody>
      </table>
    </div>`;
}

function renderTeamsView(container) {
  const t = allTournaments.find(x => x.id === selectedTid);
  const allPartic = (t?.participants || [])
    .filter(p => !activeBracket || p.bracket === activeBracket)
    .sort((a, b) => (a.bracket || "").localeCompare(b.bracket || "") || (a.seed || 99) - (b.seed || 99));

  if (!allPartic.length) {
    container.innerHTML = `<div class="document-note"><p style="margin:0;color:var(--light-text)">No teams registered for this tournament.</p></div>`;
    return;
  }

  const byBracket = {};
  const bracketOrder = [];
  allPartic.forEach(p => {
    const b = p.bracket || "Unknown";
    if (!byBracket[b]) { byBracket[b] = []; bracketOrder.push(b); }
    byBracket[b].push(p);
  });

  const sections = bracketOrder.map(bracket => {
    const teams = byBracket[bracket];
    const rows = teams.map(p => `
      <tr>
        <td style="color:#c4b5fd;font-weight:bold;white-space:nowrap">#${p.seed || "?"}</td>
        <td><strong>${esc(p.teamName || "—")}</strong></td>
        <td style="font-size:0.88rem">${esc(p.coachName || "—")}</td>
        <td style="font-size:0.82rem">
          ${p.coachPhone ? `<a href="tel:${esc(p.coachPhone)}" style="color:#ffd580">${esc(p.coachPhone)}</a>` : ""}
          ${p.coachPhone && p.coachEmail ? " &nbsp;·&nbsp; " : ""}
          ${p.coachEmail ? `<a href="mailto:${esc(p.coachEmail)}" style="color:#7ec8f7">${esc(p.coachEmail)}</a>` : ""}
          ${!p.coachPhone && !p.coachEmail ? '<span style="color:var(--light-text)">—</span>' : ""}
        </td>
      </tr>`).join("");
    return `
      <div class="schedule-section" style="margin-bottom:24px">
        <h2 style="font-size:1.05rem">🏟 ${esc(bracket)}</h2>
        <div style="overflow-x:auto">
          <table>
            <thead><tr style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--light-text)">
              <th>#</th><th>Team</th><th>Coach</th><th>Contact</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join("");

  const printBtn = `
    <div style="margin-bottom:12px;display:flex;justify-content:flex-end">
      <button id="teamsPrintBtn" type="button"
        style="padding:4px 12px;background:#1e1e2e;border:1px solid #444;
               border-radius:5px;color:#ccc;cursor:pointer;font-size:0.8rem">
        🖨 Print / Save PDF
      </button>
    </div>`;

  container.innerHTML = printBtn + sections;
}

function printListView() {
  const t      = allTournaments.find(x => x.id === selectedTid);
  const tName  = t?.name || "Tournament Games";
  const today  = new Date().toISOString().slice(0, 10);

  const visible = activeBracket
    ? currentGames.filter(g => g.field === activeBracket)
    : currentGames;
  const sorted = [...visible].sort((a, b) =>
    (a.date || "").localeCompare(b.date || "") || (a.time || "").localeCompare(b.time || "")
  );

  const seedMap = {};
  (t?.participants || []).forEach(p => { if (p.teamName) seedMap[p.teamName] = p.seed; });

  // Print opts use same displayOpts but print-safe inline styles (no CSS vars)
  const printOpts = { ...displayOpts };
  const rows = sorted.map(g => {
    const noteMatch = (g.notes || "").match(/Game\s+(\d+)/i);
    const gameLabel = noteMatch ? `Game ${noteMatch[1]}` : "—";
    const ifNec     = (g.notes || "").toLowerCase().includes("if necessary");
    const homeScore = g.homeScore != null ? g.homeScore : "";
    const awayScore = g.awayScore != null ? g.awayScore : "";
    const hasScore  = homeScore !== "" && awayScore !== "";
    const homeWon   = hasScore && Number(g.homeScore) > Number(g.awayScore);
    const awayWon   = hasScore && Number(g.awayScore) > Number(g.homeScore);
    const homeSeed  = printOpts.seeds && seedMap[g.homeTeam] ? `#${seedMap[g.homeTeam]} ` : "";
    const awaySeed  = printOpts.seeds && seedMap[g.awayTeam] ? `#${seedMap[g.awayTeam]} ` : "";
    const scoreStr  = printOpts.scores && hasScore ? `  ${g.homeScore}–${g.awayScore}` : "";
    const umpireNames = (g.umpireSlots || []).filter(s => s.assignedName).map(s => s.assignedName).join(", ");
    const umpireStr = printOpts.umpires ? (umpireNames || "Unassigned") : "";
    const umpireColor = umpireNames ? "#fbbf24" : "#ef4444";
    const umpireWeight = umpireNames ? "normal" : "bold";
    const dateStr   = fmtDate(g.date);
    return `<tr${g.cancelled ? ' style="opacity:0.5"' : ""}>
      ${printOpts.time ? `<td style="white-space:nowrap;font-size:11px;color:#999">${dateStr}<br>${fmtTime(g.time)}</td>` : ""}
      <td style="font-size:11px;white-space:nowrap">
        ${g.field ? `<span style="background:#1a2a3a;color:#7ec8f7;padding:1px 6px;border-radius:3px;font-size:10px">${g.field}</span> ` : ""}
        <span style="color:#999">${gameLabel}${ifNec ? " (if nec.)" : ""}</span>
      </td>
      <td style="font-size:12px">
        <span style="${homeWon ? "font-weight:bold;color:white" : "color:#ccc"}">${homeSeed}${g.homeTeam || "TBD"}</span>
        <span style="color:#666;margin:0 5px">vs</span>
        <span style="${awayWon ? "font-weight:bold;color:white" : "color:#ccc"}">${awaySeed}${g.awayTeam || "TBD"}</span>
        ${scoreStr ? `<span style="color:#86efac;font-weight:bold;margin-left:6px">${scoreStr.trim()}</span>` : ""}
        ${g.cancelled ? ' <span style="color:#f87171">(cancelled)</span>' : ""}
        ${umpireStr ? `<div style="font-size:10px;color:${umpireColor};font-weight:${umpireWeight};margin-top:1px">🧑‍⚖️ ${umpireStr}</div>` : ""}
      </td>
      <td style="font-size:11px;color:#999">${g.city || ""}</td>
    </tr>`;
  }).join("");

  const optLabels = [
    printOpts.scores  && "Scores",
    printOpts.time    && "Date/Time",
    printOpts.seeds   && "Seeds",
    printOpts.umpires && "Umpires",
  ].filter(Boolean).join(" · ");

  const colCount = printOpts.time ? 4 : 3;
  const html = `<!doctype html>
<html><head><meta charset="UTF-8"><title>${tName}</title>
<style>
  @page { size: portrait; margin: 0.5in; }
  * { box-sizing: border-box; }
  body { background:#0d0d0d;color:#ddd;font-family:system-ui,sans-serif;margin:0;padding:0;
         -webkit-print-color-adjust:exact;print-color-adjust:exact; }
  h1 { font-size:17px;margin:0 0 2px }
  .meta { font-size:10px;color:#888;margin-bottom:14px }
  table { border-collapse:collapse;width:100% }
  th { text-align:left;padding:4px 8px;font-size:10px;text-transform:uppercase;
       letter-spacing:0.04em;color:#888;border-bottom:1px solid #333 }
  td { padding:5px 8px;border-bottom:1px solid #1a1a1a;vertical-align:top }
</style></head>
<body>
  <h1>${tName}</h1>
  <div class="meta">Showing: ${optLabels || "all"} · Printed ${new Date().toLocaleDateString()}</div>
  <table>
    <thead><tr>
      ${printOpts.time ? "<th>Date / Time</th>" : ""}
      <th>Bracket / Game</th><th>Matchup</th><th>Location</th>
    </tr></thead>
    <tbody>${rows || `<tr><td colspan="${colCount}" style="text-align:center;color:#888;padding:16px">No games.</td></tr>`}</tbody>
  </table>
  <script>window.onload = () => { window.print(); }<\/script>
</body></html>`;

  const win = window.open("", "_blank");
  if (!win) { alert("Pop-up blocked — please allow pop-ups for this site."); return; }
  win.document.write(html);
  win.document.close();
}

function printTeamsView() {
  const t = allTournaments.find(x => x.id === selectedTid);
  const tName = t?.name || "Tournament Teams";
  const allPartic = (t?.participants || [])
    .slice()
    .sort((a, b) => (a.bracket || "").localeCompare(b.bracket || "") || (a.seed || 99) - (b.seed || 99));

  const byBracket = {};
  const bracketOrder = [];
  allPartic.forEach(p => {
    const b = p.bracket || "Unknown";
    if (!byBracket[b]) { byBracket[b] = []; bracketOrder.push(b); }
    byBracket[b].push(p);
  });

  const sections = bracketOrder.map((bracket, i) => {
    const teams = byBracket[bracket];
    const rows = teams.map(p => `
      <tr>
        <td style="font-weight:bold;color:#c4b5fd;white-space:nowrap">#${p.seed || "?"}</td>
        <td style="font-weight:bold">${p.teamName || "—"}</td>
        <td>${p.coachName || "—"}</td>
        <td>${[p.coachPhone, p.coachEmail].filter(Boolean).join("  ·  ") || "—"}</td>
      </tr>`).join("");
    const pb = i < bracketOrder.length - 1 ? 'style="page-break-after:always"' : "";
    return `<div ${pb}>
      <h2 style="font-size:14px;margin:0 0 6px;color:#ddd">${bracket}</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <thead><tr style="border-bottom:1px solid #444">
          <th style="text-align:left;padding:4px 8px;font-size:10px;color:#888;text-transform:uppercase">#</th>
          <th style="text-align:left;padding:4px 8px;font-size:10px;color:#888;text-transform:uppercase">Team</th>
          <th style="text-align:left;padding:4px 8px;font-size:10px;color:#888;text-transform:uppercase">Coach</th>
          <th style="text-align:left;padding:4px 8px;font-size:10px;color:#888;text-transform:uppercase">Contact</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join("");

  const html = `<!doctype html>
<html><head><meta charset="UTF-8"><title>${tName} — Teams</title>
<style>
  @page { size: portrait; margin: 0.5in; }
  * { box-sizing: border-box; }
  body { background:#0d0d0d;color:#ddd;font-family:system-ui,sans-serif;margin:0;padding:0;
         -webkit-print-color-adjust:exact;print-color-adjust:exact; }
  h1 { font-size:17px;margin:0 0 2px }
  .meta { font-size:10px;color:#888;margin-bottom:16px }
  td { padding:5px 8px;border-bottom:1px solid #1a1a1a;font-size:12px;vertical-align:top }
</style></head>
<body>
  <h1>${tName} — Teams &amp; Coach Contacts</h1>
  <div class="meta">Printed ${new Date().toLocaleDateString()}</div>
  ${sections || "<p style='color:#888'>No teams registered.</p>"}
  <script>window.onload = () => { window.print(); }<\/script>
</body></html>`;

  const win = window.open("", "_blank");
  if (!win) { alert("Pop-up blocked — please allow pop-ups for this site."); return; }
  win.document.write(html);
  win.document.close();
}

function renderContent() {
  const container = document.getElementById("tournamentContent");
  const today     = new Date().toISOString().slice(0, 10);

  if (!currentGames.length) {
    container.innerHTML = `<div class="document-note"><p style="margin:0;color:var(--light-text)">No games found for this tournament.</p></div>`;
    return;
  }

  const visible = activeBracket
    ? currentGames.filter(g => g.field === activeBracket)
    : currentGames;

  if (viewStyle === "list") {
    renderListView(container, visible);
    return;
  }

  if (viewStyle === "teams") {
    renderTeamsView(container);
    return;
  }

  const bracketOrder = [];
  const byBracket    = {};
  visible.forEach(g => {
    const b = g.field || "Games";
    if (!byBracket[b]) { byBracket[b] = []; bracketOrder.push(b); }
    byBracket[b].push(g);
  });

  const sections = bracketOrder.map(bracket => {
    const bGames    = [...byBracket[bracket]].sort((a, b) => {
      const nA = parseInt((a.notes || "").match(/Game\s+(\d+)/i)?.[1] || "999");
      const nB = parseInt((b.notes || "").match(/Game\s+(\d+)/i)?.[1] || "999");
      return nA - nB;
    });
    const bAdvRules  = bracketAdvancement[bracket] || {};

    // Bracket summary
    const completedCount = bGames.filter(g => g.homeScore != null && !g.cancelled).length;
    const totalCount     = bGames.filter(g => !g.cancelled).length;
    const summary        = completedCount > 0
      ? ` <span style="color:var(--light-text);font-size:0.8rem;font-weight:normal"> · ${completedCount}/${totalCount} games complete</span>` : "";

    // Seed strip
    const t         = allTournaments.find(x => x.id === selectedTid);
    const bPartic   = (t?.participants || [])
      .filter(p => p.bracket === bracket)
      .sort((a, b) => (a.seed || 99) - (b.seed || 99));
    const seedsHtml = bPartic.length ? `
      <div style="margin-bottom:8px;display:flex;flex-wrap:wrap;gap:5px">
        ${bPartic.map(p => {
          const isSelected = selectedTeam === p.teamName;
          return `
          <span data-select-team="${esc(p.teamName)}"
            style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;cursor:pointer;
                   background:${isSelected ? "#2a1f00" : "#1a1a2a"};
                   border:1px solid ${isSelected ? "#fbbf24" : "#333"};
                   border-radius:5px;font-size:0.8rem;user-select:none"
            title="Click to highlight ${esc(p.teamName)}'s games">
            <span style="color:#c4b5fd;font-weight:bold">#${p.seed}</span>
            <span style="color:${isSelected ? "#fbbf24" : "inherit"};font-weight:${isSelected ? "bold" : "normal"}">${esc(p.teamName)}</span>
          </span>`;
        }).join("")}
      </div>` : "";

    // SVG bracket (pass display opts + participants for seed lookup)
    const svgHtml = renderBracketSVG(bracket, bGames, bAdvRules, today, { ...displayOpts, selectedTeam }, bPartic);

    return `
      <div class="schedule-section" style="margin-bottom:32px">
        <h2 style="font-size:1.05rem">🏟 ${esc(bracket)}${summary}</h2>
        ${seedsHtml}
        <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
          ${svgHtml}
        </div>
        <div style="display:flex;gap:16px;margin-top:6px;flex-wrap:wrap">
          <span style="font-size:0.72rem;color:#444;display:flex;align-items:center;gap:4px">
            <span style="width:20px;height:2px;background:#4ade80;display:inline-block;opacity:0.6"></span>
            Winner path
          </span>
          <span style="font-size:0.72rem;color:#444;display:flex;align-items:center;gap:4px">
            <span style="width:20px;height:2px;background:#f87171;display:inline-block;opacity:0.5;border-top:2px dashed #f87171;background:none"></span>
            Loser path
          </span>
        </div>
      </div>`;
  }).join("");

  // Build rules section HTML (shown above bracket sections)
  const tRules    = allTournaments.find(x => x.id === selectedTid);
  const rulesText = (tRules?.rules || "").trim();
  const rulesHtml = rulesText ? (() => {
    const lines = rulesText.split("\n").map(l => l.trim()).filter(Boolean);
    const items  = lines.map(l => `<li style="margin-bottom:6px;line-height:1.5">${esc(l)}</li>`).join("");
    return `
      <div class="schedule-section" style="margin-bottom:24px;padding:16px;
            background:rgba(255,230,100,0.04);border:1px solid #3a3010;border-radius:8px">
        <h2 style="font-size:1rem;color:#ffd966;margin:0 0 10px">📋 Key Rules</h2>
        <ul style="margin:0;padding-left:18px;color:var(--light-text);font-size:0.88rem">
          ${items}
        </ul>
      </div>`;
  })() : "";

  const baseOpts = [
    ["scores",  "Scores"],
    ["time",    "Date/Time"],
    ["seeds",   "Seeds"],
    ["routing", "Win/Loss routing"],
  ];
  const signedInOpts = isLoggedIn() ? [["umpires", "Umpires"]] : [];

  const dispToolbar = `
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:14px;
                padding:8px 12px;background:#111;border:1px solid #222;border-radius:6px;font-size:0.8rem">
      <span style="color:var(--light-text);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em">Show:</span>
      ${[...baseOpts, ...signedInOpts].map(([key, label]) => `
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;color:#ccc">
          <input type="checkbox" class="bracket-disp-opt" data-opt="${key}"
            ${displayOpts[key] ? "checked" : ""}
            style="cursor:pointer;accent-color:#a78bfa">
          ${label}
        </label>`).join("")}
      <button id="bracketPrintBtn" type="button"
        style="margin-left:auto;padding:4px 12px;background:#1e1e2e;border:1px solid #444;
               border-radius:5px;color:#ccc;cursor:pointer;font-size:0.8rem;white-space:nowrap">
        🖨 Print / Save PDF
      </button>
    </div>`;

  const selChip = selectedTeam ? `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;
                padding:6px 12px;background:#1a1400;border:1px solid #fbbf2450;
                border-radius:6px;font-size:0.82rem">
      <span style="color:#fbbf24">⭐ Highlighting: <strong>${esc(selectedTeam)}</strong></span>
      <span style="color:#666;font-size:0.75rem">
        — gold border = current games &nbsp;·&nbsp;
        <span style="color:#4ade8088">green</span> = if they win &nbsp;·&nbsp;
        <span style="color:#f8717188">red</span> = if they lose
      </span>
      <button id="clearTeamSelect" type="button"
        style="margin-left:auto;padding:2px 10px;background:#2a1a00;border:1px solid #fbbf2440;
               border-radius:4px;color:#fbbf24;cursor:pointer;font-size:0.78rem">
        ✕ Clear
      </button>
    </div>` : "";

  container.innerHTML = rulesHtml + dispToolbar + selChip + sections;
}

// ── Auto-refresh ──────────────────────────────────────────────────────────────

function startAutoRefresh() {
  stopAutoRefresh();
  const t = allTournaments.find(x => x.id === selectedTid);
  if (!t) return;
  // Refresh every 90s when tournament is active or today is within tournament dates
  const today = new Date().toISOString().slice(0, 10);
  if (t.status === "active" || t.date === today || t.date <= today) {
    _refreshTimer = setInterval(async () => {
      await loadGamesForTournament(selectedTid);
      renderContent();
    }, 90_000);
  }
}

function stopAutoRefresh() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

// ── Event listeners ───────────────────────────────────────────────────────────

document.addEventListener("click", e => {
  // Print / Save PDF
  if (e.target.closest("#bracketPrintBtn")) { printBrackets(); return; }
  if (e.target.closest("#listPrintBtn"))    { printListView(); return; }
  if (e.target.closest("#teamsPrintBtn"))   { printTeamsView(); return; }

  // Clear team selection
  if (e.target.closest("#clearTeamSelect")) {
    selectedTeam = null;
    renderContent();
    return;
  }

  // Team name click → highlight that team
  const teamEl = e.target.closest("[data-select-team]");
  if (teamEl) {
    const name = teamEl.dataset.selectTeam;
    selectedTeam = name === selectedTeam ? null : name;
    renderContent();
    return;
  }

  // Click on SVG background (not on a team) → clear selection
  if (selectedTeam && e.target.closest("svg") && e.target.closest("#tournamentContent")) {
    selectedTeam = null;
    renderContent();
    return;
  }

  // View style toggle (Bracket / Games / Teams)
  const styleBtn = e.target.closest(".view-style-btn");
  if (styleBtn) {
    viewStyle = styleBtn.dataset.style || "bracket";
    selectedTeam = null;
    document.querySelectorAll(".view-style-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.style === viewStyle)
    );
    renderContent();
    return;
  }

  // Bracket tab
  const tabBtn = e.target.closest(".bracket-tab-btn");
  if (!tabBtn) return;
  activeBracket = tabBtn.dataset.bracket || null;
  document.querySelectorAll(".bracket-tab-btn").forEach(b =>
    b.classList.toggle("active", (b.dataset.bracket || null) === activeBracket)
  );
  renderContent();
});

document.addEventListener("change", e => {
  const cb = e.target.closest(".bracket-disp-opt");
  if (!cb) return;
  displayOpts[cb.dataset.opt] = cb.checked;
  renderContent();
});

document.getElementById("tournamentSelect").addEventListener("change", async function () {
  selectedTid = this.value;
  activeBracket = null;
  selectedTeam = null;
  stopAutoRefresh();
  document.getElementById("tournamentContent").innerHTML =
    `<p style="color:var(--light-text);text-align:center;padding:30px">Loading…</p>`;
  try {
    await loadGamesForTournament(selectedTid);
    renderMeta();
    renderBracketTabs();
    renderContent();
    startAutoRefresh();
  } catch (err) {
    document.getElementById("tournamentContent").innerHTML =
      `<div class="document-note"><p style="color:#ffb4b4;margin:0">Failed to load games: ${esc(err.message)}</p></div>`;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    await loadTournaments();
    renderTournamentSelector();

    if (!allTournaments.length) {
      document.getElementById("tournamentContent").innerHTML =
        `<div class="document-note"><p style="margin:0;color:var(--light-text)">No tournaments have been created yet.</p></div>`;
      return;
    }

    const preferred = allTournaments.find(t =>
      ["scheduled","active","rain-delay"].includes(t.status || "scheduled")
    ) || allTournaments[0];
    selectedTid = preferred.id;
    document.getElementById("tournamentSelect").value = selectedTid;

    await loadGamesForTournament(selectedTid);
    renderMeta();
    renderBracketTabs();
    renderContent();
    startAutoRefresh();
  } catch (err) {
    document.getElementById("tournamentContent").innerHTML =
      `<div class="document-note"><p style="color:#ffb4b4;margin:0">Failed to load tournaments: ${esc(err.message)}</p></div>`;
    console.error(err);
  }
}

authReadyPromise.then(init);
