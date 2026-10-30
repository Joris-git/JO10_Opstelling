// JO10 Opstelling — speelkalender: iCal (.ics) inlezen en koppelen aan wedstrijden. Pure logica, geen DOM.
(function (root) {
  const JO10 = root.JO10 = root.JO10 || {};

  // Ons team herkennen in "Sporting 70 O10-3 - DOS O10-2". Standaard: alles met "Sporting 70" / "Sporting '70".
  const DEFAULT_TEAM_RE = /sporting\s*[’'`]?\s*70/i;

  function pad(n) { return String(n).padStart(2, '0'); }
  function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

  // ── iCal-basis ────────────────────────────────────────────────────────────
  // Regels "unfolden" (vervolgregels beginnen met spatie/tab) en escapes ongedaan maken.
  function unfold(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
  }
  function unescapeText(v) {
    return String(v || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
  }
  function parseLine(line) {
    const i = line.indexOf(':');
    if (i < 0) return null;
    const head = line.slice(0, i), value = line.slice(i + 1);
    const parts = head.split(';');
    const params = {};
    parts.slice(1).forEach(p => { const j = p.indexOf('='); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, ''); });
    return { name: parts[0].toUpperCase(), params, value };
  }

  // Tijd in een bepaalde tijdzone (IANA) omzetten naar een echt Date-object.
  function zonedToDate(y, mo, d, h, mi, s, tz) {
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    try {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const get = t => { const o = {}; f.formatToParts(new Date(t)).forEach(p => { o[p.type] = p.value; }); return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second); };
      const off = get(guess) - guess;
      return new Date(guess - off);
    } catch (e) {
      return new Date(y, mo - 1, d, h, mi, s);
    }
  }
  // Windows-zonenamen die Sportlink/VoetbalAssist soms gebruiken.
  const TZ_ALIASES = { 'W. Europe Standard Time': 'Europe/Amsterdam', 'Romance Standard Time': 'Europe/Amsterdam', 'Central Europe Standard Time': 'Europe/Amsterdam' };

  // → { datum: 'YYYY-MM-DD', tijd: 'HH:MM' | '', date: Date } in Nederlandse tijd
  function parseDateValue(value, params, localTz) {
    const v = String(value || '').trim();
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, z] = m;
    if (h === undefined || (params && params.VALUE === 'DATE')) {
      return { datum: `${y}-${mo}-${d}`, tijd: '', date: new Date(+y, +mo - 1, +d) };
    }
    let date;
    if (z) date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)));
    else if (params && params.TZID) date = zonedToDate(+y, +mo, +d, +h, +mi, +(s || 0), TZ_ALIASES[params.TZID] || params.TZID);
    else return { datum: `${y}-${mo}-${d}`, tijd: `${h}:${mi}`, date: new Date(+y, +mo - 1, +d, +h, +mi) }; // "floating": zo laten
    return toLocalParts(date, localTz || 'Europe/Amsterdam');
  }
  function toLocalParts(date, tz) {
    try {
      const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const o = {}; f.formatToParts(date).forEach(p => { o[p.type] = p.value; });
      return { datum: `${o.year}-${o.month}-${o.day}`, tijd: `${pad(+o.hour % 24)}:${o.minute}`, date };
    } catch (e) {
      return { datum: isoDate(date), tijd: `${pad(date.getHours())}:${pad(date.getMinutes())}`, date };
    }
  }

  function parseEvents(text) {
    const lines = unfold(text).split('\n');
    const events = []; let cur = null;
    lines.forEach(raw => {
      const line = raw.trimEnd(); if (!line) return;
      if (/^BEGIN:VEVENT$/i.test(line)) { cur = {}; return; }
      if (/^END:VEVENT$/i.test(line)) { if (cur) events.push(cur); cur = null; return; }
      if (!cur) return;
      const p = parseLine(line); if (!p) return;
      if (!(p.name in cur)) cur[p.name] = p;
    });
    return events;
  }

  // ── Wedstrijd-tekst ontleden ─────────────────────────────────────────────
  // "Sporting 70 O10-3 - DOS O10-2", "Sporting '70 O10-3 vs. DOS", "DOS O10-2 – Sporting 70 O10-3 (beker)"
  function splitTeams(summary) {
    let s = String(summary || '').replace(/\s+/g, ' ').trim();
    let soort = '';
    const tag = /\s*[([]\s*(beker|oefen(?:wedstrijd)?|competitie|vriendschappelijk|toernooi)[^)\]]*[)\]]\s*$/i.exec(s);
    if (tag) { soort = tag[1].toLowerCase().startsWith('oefen') || tag[1].toLowerCase().startsWith('vriend') ? 'oefen' : tag[1].toLowerCase(); s = s.slice(0, tag.index).trim(); }
    // Uitslag in de titel (bv. "A - B 3-2" of "A 3 - 2 B") weghalen
    let score = null;
    const sc = /\s+(\d{1,2})\s*[-–]\s*(\d{1,2})\s*$/.exec(s);
    if (sc && /\s[-–]\s|\svs\.?\s/i.test(s.slice(0, sc.index))) { score = [+sc[1], +sc[2]]; s = s.slice(0, sc.index).trim(); }
    const seps = [/\s+[-–—]\s+/, /\s+vs\.?\s+/i, /\s+tegen\s+/i];
    for (const re of seps) {
      const m = re.exec(s);
      if (m) return { home: s.slice(0, m.index).trim(), away: s.slice(m.index + m[0].length).trim(), soort, score };
    }
    return { home: s, away: '', soort, score };
  }

  function teamMatcher(team) {
    if (team instanceof RegExp) return t => team.test(t);
    const key = norm(team || '');
    if (!key) return t => DEFAULT_TEAM_RE.test(t);
    return t => norm(t).includes(key) || (DEFAULT_TEAM_RE.test(t) && DEFAULT_TEAM_RE.test(team));
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/[’'`.]/g, '').replace(/\s+/g, ' ').trim(); }

  function slug(s) { return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

  // ── Publiek: .ics → fixtures ─────────────────────────────────────────────
  // Fixture = { id, datum, tijd, tegenstander, thuisUit, locatie, soort, verzamel, uid, score }
  function parseICS(text, opts) {
    opts = opts || {};
    const isOurs = teamMatcher(opts.team);
    const warnings = [];
    const events = parseEvents(text);
    if (!/BEGIN:VCALENDAR/i.test(String(text || ''))) warnings.push('Dit lijkt geen iCal-bestand (.ics).');
    const fixtures = [];
    events.forEach(ev => {
      const summary = unescapeText(ev.SUMMARY && ev.SUMMARY.value);
      const start = ev.DTSTART && parseDateValue(ev.DTSTART.value, ev.DTSTART.params, opts.timeZone);
      if (!summary || !start) return;
      if (ev.STATUS && /CANCELLED/i.test(ev.STATUS.value)) return;
      const t = splitTeams(summary);
      let thuisUit = '', tegenstander = '';
      if (t.away) {
        if (isOurs(t.home) && !isOurs(t.away)) { thuisUit = 'thuis'; tegenstander = t.away; }
        else if (isOurs(t.away) && !isOurs(t.home)) { thuisUit = 'uit'; tegenstander = t.home; }
        else { thuisUit = 'thuis'; tegenstander = t.away; }
      } else {
        // Geen tegenstander in de titel (training, toernooi, vrije zaterdag…) → overslaan
        return;
      }
      const desc = unescapeText(ev.DESCRIPTION && ev.DESCRIPTION.value);
      const verz = /(?:verzamel(?:en|tijd)?|aanwezig)\D{0,12}(\d{1,2})[:.](\d{2})/i.exec(desc);
      let soort = t.soort;
      if (!soort && /beker/i.test(desc + ' ' + summary)) soort = 'beker';
      if (!soort && /oefen|vriendschappelijk/i.test(desc + ' ' + summary)) soort = 'oefen';
      const uid = ev.UID ? unescapeText(ev.UID.value) : '';
      let score = null;
      if (t.score) score = thuisUit === 'uit' ? { home: t.score[1], away: t.score[0] } : { home: t.score[0], away: t.score[1] };
      fixtures.push({
        id: uid || `${start.datum}-${slug(tegenstander)}`,
        datum: start.datum,
        tijd: start.tijd,
        tegenstander,
        thuisUit,
        locatie: unescapeText(ev.LOCATION && ev.LOCATION.value),
        soort: soort || 'competitie',
        verzamel: verz ? `${pad(+verz[1])}:${verz[2]}` : '',
        uid,
        score,
      });
    });
    fixtures.sort((a, b) => (a.datum + a.tijd).localeCompare(b.datum + b.tijd));
    // dubbele (zelfde dag + tegenstander) samenvoegen
    const seen = new Set(); const out = [];
    fixtures.forEach(f => { const k = `${f.datum}|${norm(shortName(f.tegenstander))}`; if (seen.has(k)) return; seen.add(k); out.push(f); });
    if (events.length && !out.length) warnings.push('Geen wedstrijden met een tegenstander gevonden in de kalender.');
    return { fixtures: out, warnings, events: events.length };
  }

  // ── Helpers voor de app ──────────────────────────────────────────────────
  function todayISO(now) { return isoDate(now ? new Date(now) : new Date()); }
  function upcoming(fixtures, now) {
    const t = todayISO(now);
    return (fixtures || []).filter(f => f && f.datum >= t);
  }
  function past(fixtures, now) {
    const t = todayISO(now);
    return (fixtures || []).filter(f => f && f.datum < t);
  }
  function next(fixtures, now) { return upcoming(fixtures, now)[0] || null; }
  function onDate(fixtures, datum) { return (fixtures || []).filter(f => f && f.datum === datum); }

  // Opgeslagen wedstrijd bij een fixture: zelfde datum (en bij meerdere: best passende tegenstander).
  function matchFor(fixture, matches) {
    if (!fixture) return null;
    const same = (matches || []).filter(m => m && m.datum === fixture.datum);
    if (same.length <= 1) return same[0] || null;
    const k = norm(fixture.tegenstander);
    return same.find(m => { const t = norm(m.tegenstander); return t && (k.includes(t) || t.includes(k)); }) || same[0];
  }

  // Korte tegenstandernaam zonder teamaanduiding, bv. "DOS O10-2" → "DOS"
  function shortName(name) {
    const s = String(name || '').replace(/\s+(?:J?O|MO)\s?\d{1,2}(?:-\d{1,2})?\w*$/i, '').trim();
    return s || String(name || '').trim();
  }

  // ── Trainingen ───────────────────────────────────────────────────────────
  // Trainingen uit dezelfde iCal: { datum, tijd, eind, veld }
  function parseTrainings(text, opts) {
    opts = opts || {};
    const out = [];
    parseEvents(text).forEach(ev => {
      const summary = unescapeText(ev.SUMMARY && ev.SUMMARY.value);
      const cat = unescapeText(ev.CATEGORIES && ev.CATEGORIES.value);
      if (!/training/i.test(cat + ' ' + summary)) return;
      if (ev.STATUS && /CANCELLED/i.test(ev.STATUS.value)) return;
      const start = ev.DTSTART && parseDateValue(ev.DTSTART.value, ev.DTSTART.params, opts.timeZone);
      const end = ev.DTEND && parseDateValue(ev.DTEND.value, ev.DTEND.params, opts.timeZone);
      if (!start) return;
      const desc = unescapeText(ev.DESCRIPTION && ev.DESCRIPTION.value);
      const veld = /veld:\s*([^,\n]+)/i.exec(desc);
      out.push({ datum: start.datum, tijd: start.tijd, eind: end ? end.tijd : '', veld: veld ? veld[1].trim() : '' });
    });
    out.sort((a, b) => (a.datum + a.tijd).localeCompare(b.datum + b.tijd));
    return out;
  }

  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d + n);
    return isoDate(dt);
  }
  function holidayOn(datum, holidays) {
    return (holidays || []).find(h => h && datum >= h.van && datum <= h.tot) || null;
  }
  // Genummerde trainingsweken: elke `weekday` (0=zo … 3=wo) vanaf `start` is week 1, 2, 3 …;
  // weken in een vakantie krijgen geen nummer en tellen niet mee.
  // → [{ datum, week: n|null, vakantie: naam|null }] van start t/m `until`
  function trainingWeeks(o) {
    o = o || {};
    const start = o.start; if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '')) return [];
    const wd = o.weekday == null ? 3 : +o.weekday;
    let d = start;
    const [y, m, dd] = start.split('-').map(Number);
    const shift = (wd - new Date(y, m - 1, dd).getDay() + 7) % 7;
    d = addDays(d, shift);
    const until = o.until || addDays(d, 7 * 52);
    const out = []; let n = 0;
    while (d <= until && out.length < 60) {
      const h = holidayOn(d, o.holidays);
      if (h) out.push({ datum: d, week: null, vakantie: h.naam || 'vakantie' });
      else out.push({ datum: d, week: ++n, vakantie: null });
      d = addDays(d, 7);
    }
    return out;
  }
  function trainingWeekOf(datum, o) {
    const list = trainingWeeks(Object.assign({}, o, { until: datum }));
    const hit = list.find(x => x.datum === datum);
    return hit || null;
  }

  const api = { parseTrainings, trainingWeeks, trainingWeekOf, parseICS, parseEvents, splitTeams, parseDateValue, upcoming, past, next, onDate, matchFor, shortName };
  JO10.Fixtures = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
