// Tests voor de rondleiding (JO10.Tour): wanneer automatisch tonen, hint of niets.
const test = require('node:test');
const assert = require('node:assert/strict');
const Config = require('../js/config.js');
const Tour = require('../js/tour.js');

function fakeStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    _m: m,
  };
}

test('decide: nieuw toestel → rondleiding automatisch', () => {
  assert.equal(Tour.decide({}), 'tour');
  assert.equal(Tour.decide({ seen: false, hasMatches: false, hasMe: false, usedBefore: false, liveRunning: false }), 'tour');
  assert.equal(Tour.decide(), 'tour');
});

test('decide: al gezien → nooit meer automatisch, ook geen hint', () => {
  assert.equal(Tour.decide({ seen: true }), 'none');
  assert.equal(Tour.decide({ seen: true, hasMatches: true, hasMe: true }), 'none');
});

test('decide: bestaande gebruiker (wedstrijden, naam of eerder gebruikt) → hint i.p.v. rondleiding', () => {
  assert.equal(Tour.decide({ hasMatches: true }), 'hint');
  assert.equal(Tour.decide({ hasMe: true }), 'hint');
  assert.equal(Tour.decide({ usedBefore: true }), 'hint');
  // hint mag ook tijdens live: het is maar een kaartje op Start
  assert.equal(Tour.decide({ hasMatches: true, liveRunning: true }), 'hint');
});

test('decide: lopende live-wedstrijd → niet automatisch (en vlag blijft onaangeroerd)', () => {
  assert.equal(Tour.decide({ liveRunning: true }), 'none');
});

test('readLocal: leeg toestel', () => {
  const st = Tour.readLocal(fakeStorage(), Config);
  assert.deepEqual(st, { seen: false, hasMatches: false, hasMe: false, usedBefore: false });
  assert.equal(Tour.decide(st), 'tour');
});

test('readLocal: v1-gebruiker met wedstrijden in jo10_matches_v1 → hint', () => {
  const s = fakeStorage({ jo10_matches_v1: JSON.stringify([{ id: 1, datum: '2026-09-12', periodes: [] }]) });
  const st = Tour.readLocal(s, Config);
  assert.equal(st.hasMatches, true);
  assert.equal(Tour.decide(st), 'hint');
});

test('readLocal: lege of kapotte wedstrijdenlijst telt niet als bestaande gebruiker', () => {
  assert.equal(Tour.readLocal(fakeStorage({ jo10_matches_v1: '[]' }), Config).hasMatches, false);
  assert.equal(Tour.readLocal(fakeStorage({ jo10_matches_v1: '[null]' }), Config).hasMatches, false);
  assert.equal(Tour.readLocal(fakeStorage({ jo10_matches_v1: '{kapot' }), Config).hasMatches, false);
  assert.equal(Tour.readLocal(fakeStorage({ jo10_matches_v1: 'null' }), Config).hasMatches, false);
});

test('readLocal: naam ingesteld ("Wie ben jij?") → hint; alleen spaties telt niet', () => {
  assert.equal(Tour.decide(Tour.readLocal(fakeStorage({ jo10_me_v2: 'Joris' }), Config)), 'hint');
  assert.equal(Tour.readLocal(fakeStorage({ jo10_me_v2: '   ' }), Config).hasMe, false);
});

test('readLocal: v2 al eerder geopend (laatste scherm of concept) → hint', () => {
  assert.equal(Tour.readLocal(fakeStorage({ jo10_ui_v2: '{"screen":"start"}' }), Config).usedBefore, true);
  assert.equal(Tour.readLocal(fakeStorage({ jo10_draft_v2: '{}' }), Config).usedBefore, true);
});

test('markSeen/isSeen: vlag in Config.LS_TOUR; daarna nooit meer automatisch', () => {
  assert.equal(Config.LS_TOUR, 'jo10_rondleiding_v1');
  const s = fakeStorage();
  assert.equal(Tour.isSeen(s), false);
  Tour.markSeen(s);
  assert.equal(Tour.isSeen(s), true);
  assert.ok(s._m.has('jo10_rondleiding_v1'));
  const st = Tour.readLocal(s, Config);
  assert.equal(st.seen, true);
  assert.equal(Tour.decide(Object.assign(st, { liveRunning: false })), 'none');
});

test('opslag die gooit (privémodus) → geen crash, gedrag als leeg toestel', () => {
  const bad = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); } };
  assert.deepEqual(Tour.readLocal(bad, Config), { seen: false, hasMatches: false, hasMe: false, usedBefore: false });
  assert.doesNotThrow(() => Tour.markSeen(bad));
  assert.equal(Tour.isSeen(bad), false);
  assert.equal(Tour.readLocal(null, Config).seen, false);
});

test('slides: 7 kaarten, begroeting met naam, alle dynamische tekst ge-escaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const list = Tour.slides({ name: evil, players: [evil, 'Bram'], next: { tegenstander: evil, when: evil, chip: evil }, team: evil });
  assert.equal(list.length, 7);
  assert.deepEqual(list.map(s => s.id), ['welkom', 'start', 'maken', 'aanpassen', 'bord', 'live', 'samen']);
  const all = list.map(s => [s.kicker, s.title, s.text, (s.bullets || []).join(''), s.art].join('')).join('');
  assert.ok(!all.includes('<img'), 'geen ruwe HTML uit gebruikersinvoer');
  assert.ok(all.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.match(list[0].kicker, /^Hoi &lt;img/);
});

test('slides: zonder naam/spelers → "Welkom" en voorbeeldnamen', () => {
  const list = Tour.slides({});
  assert.equal(list[0].kicker, 'Welkom 👋');
  assert.match(list[3].art, /Noud/);
  list.forEach(s => {
    assert.ok(s.title && s.text, `kaart ${s.id} heeft titel en tekst`);
    assert.ok(!s.bullets || s.bullets.length <= 3, `kaart ${s.id}: max 3 punten`);
  });
});
