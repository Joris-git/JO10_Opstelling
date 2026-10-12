const test = require('node:test');
const assert = require('node:assert');
const F = require('../js/fixtures.js');

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//VoetbalAssist//NL',
  'BEGIN:VEVENT', 'UID:wed-1@voetbalassist',
  'DTSTART:20261017T070000Z', 'DTEND:20261017T080000Z',
  'SUMMARY:Sporting 70 O10-3 - DOS O10-2', 'LOCATION:Sportpark Voordorp\\, Utrecht',
  'DESCRIPTION:Competitie\\nVerzamelen: 08:30', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:wed-2@voetbalassist',
  'DTSTART;TZID=W. Europe Standard Time:20261024T103000',
  'SUMMARY:Kampong O10-4 - Sporting \'70 O10-3', 'LOCATION:Sportpark Kampong', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:wed-3', 'DTSTART;VALUE=DATE:20261031',
  'SUMMARY:Sporting 70 O10-3 - Elinkwijk O10-1 (beker)', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:wed-4', 'DTSTART:20261003T080000Z',
  'SUMMARY:Sporting 70 O10-3 - Hercules O10-5 4-2', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:x', 'DTSTART:20261107T080000Z', 'SUMMARY:Geen wedstrijd (herfstvakantie)', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:long', 'DTSTART:20261114T090000Z',
  'SUMMARY:Sporting 70 O10-3 - Voor', ' waarts O10-2', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('parses VoetbalAssist-like iCal: home/away, time zones, location', () => {
  const { fixtures, warnings } = F.parseICS(ICS);
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(fixtures.length, 5);
  const [hercules, dos, kampong, elink, voor] = fixtures;
  assert.deepStrictEqual([dos.datum, dos.tijd, dos.tegenstander, dos.thuisUit], ['2026-10-17', '09:00', 'DOS O10-2', 'thuis']);
  assert.strictEqual(dos.locatie, 'Sportpark Voordorp, Utrecht');
  assert.strictEqual(dos.verzamel, '08:30');
  assert.deepStrictEqual([kampong.datum, kampong.tijd, kampong.tegenstander, kampong.thuisUit], ['2026-10-24', '10:30', 'Kampong O10-4', 'uit']);
  assert.deepStrictEqual([elink.tijd, elink.soort, elink.tegenstander], ['', 'beker', 'Elinkwijk O10-1']);
  assert.deepStrictEqual(hercules.score, { home: 4, away: 2 });
  assert.strictEqual(hercules.tegenstander, 'Hercules O10-5');
  assert.strictEqual(voor.tegenstander, 'Voorwaarts O10-2', 'folded lines are joined');
});

test('away score is flipped to our perspective', () => {
  const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260912T080000Z\nSUMMARY:DOS O10-2 - Sporting 70 O10-3 1-3\nEND:VEVENT\nEND:VCALENDAR';
  const [f] = F.parseICS(ics).fixtures;
  assert.strictEqual(f.thuisUit, 'uit');
  assert.deepStrictEqual(f.score, { home: 3, away: 1 });
});

test('summer time conversion (UTC → Amsterdam)', () => {
  const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260905T074500Z\nSUMMARY:Sporting 70 O10-3 vs DOS\nEND:VEVENT\nEND:VCALENDAR';
  assert.strictEqual(F.parseICS(ics).fixtures[0].tijd, '09:45');
});

test('not an ics → warning, no crash', () => {
  const r = F.parseICS('<html>Niet gevonden</html>');
  assert.strictEqual(r.fixtures.length, 0);
  assert.ok(r.warnings.length);
});

test('upcoming/next/matchFor/shortName', () => {
  const { fixtures } = F.parseICS(ICS);
  const now = new Date(2026, 9, 12);
  assert.strictEqual(F.next(fixtures, now).tegenstander, 'DOS O10-2');
  assert.strictEqual(F.upcoming(fixtures, now).length, 4);
  assert.strictEqual(F.past(fixtures, now).length, 1);
  const matches = [{ id: 1, datum: '2026-10-17', tegenstander: 'DOS' }, { id: 2, datum: '2026-10-24', tegenstander: 'Kampong' }];
  assert.strictEqual(F.matchFor(fixtures[1], matches).id, 1);
  assert.strictEqual(F.matchFor(fixtures[3], matches), null);
  assert.strictEqual(F.shortName('DOS O10-2'), 'DOS');
  assert.strictEqual(F.shortName('Sporting 70 JO10-3JM'), 'Sporting 70');
  assert.strictEqual(F.shortName('FC Stein'), 'FC Stein');
});
