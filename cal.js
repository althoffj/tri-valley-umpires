// cal.js — client-side ICS generation and download
const p2 = n => String(n).padStart(2, "0");
const icsEsc = s => (s || "").replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\n/g,"\\n");

const CHICAGO_VTZ = `BEGIN:VTIMEZONE\r\nTZID:America/Chicago\r\nBEGIN:DAYLIGHT\r\nTZOFFSETFROM:-0600\r\nTZOFFSETTO:-0500\r\nTZNAME:CDT\r\nDTSTART:19700308T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\nEND:DAYLIGHT\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0600\r\nTZNAME:CST\r\nDTSTART:19701101T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\nEND:STANDARD\r\nEND:VTIMEZONE`;

export function gamesToIcs(games, calName = "Tri-Valley Baseball Schedule") {
  const now = new Date().toISOString().replace(/[-:.]/g,"").slice(0,15) + "Z";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Tri-Valley Baseball Umpires//Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEsc(calName)}`,
    "X-WR-TIMEZONE:America/Chicago",
    CHICAGO_VTZ,
  ];

  for (const g of games) {
    if (!g.date) continue;
    const [y, mo, d] = g.date.split("-");
    let dtstart, dtend;
    if (g.time) {
      const [h, m] = g.time.split(":");
      dtstart = `DTSTART;TZID=America/Chicago:${y}${mo}${d}T${h}${m}00`;
      const durMin = /HS/i.test(g.division || "") ? 120 : 90;
      const end = new Date(+y, +mo-1, +d, +h, +m + durMin);
      dtend = `DTEND;TZID=America/Chicago:${end.getFullYear()}${p2(end.getMonth()+1)}${p2(end.getDate())}T${p2(end.getHours())}${p2(end.getMinutes())}00`;
    } else {
      const next = new Date(+y, +mo-1, +d+1);
      dtstart = `DTSTART;VALUE=DATE:${y}${mo}${d}`;
      dtend   = `DTEND;VALUE=DATE:${next.getFullYear()}${p2(next.getMonth()+1)}${p2(next.getDate())}`;
    }

    let summary = "";
    if (g.homeTeam && g.awayTeam) summary = `${g.homeTeam} vs ${g.awayTeam}`;
    else if (g.teamName)          summary = g.teamName;
    else                          summary = `${g.division || "Baseball"} Game`;
    if (g.cancelled) summary = `CANCELLED: ${summary}`;

    const descParts = [];
    if (g.division) descParts.push(`Division: ${g.division}`);
    if (g.field)    descParts.push(`Field: ${g.field}`);
    const assigned = (g.umpireSlots || []).filter(s => s.assignedName);
    if (assigned.length) descParts.push(`Umpires: ${assigned.map(s => `${s.type}: ${s.assignedName}`).join(", ")}`);

    const evt = [
      "BEGIN:VEVENT",
      `UID:game-${g.id || Math.random()}@tri-valley-baseball-umpires`,
      `DTSTAMP:${now}`,
      dtstart, dtend,
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

export function downloadIcs(games, filename = "schedule.ics", calName) {
  const text = gamesToIcs(games, calName);
  const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
