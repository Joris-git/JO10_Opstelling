// Tests voor de pure tijd-, wissel- en scorelogica van JO10.Live.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/config.js');
const Live = require('../js/live.js');

const MIN = 60000;
const T = { periods: 4, periodMs: 12.5 * MIN };

test('timing: lengte per periode volgt uit minuten en aantal periodes van het schema', () => {
  assert.deepEqual(Live.timing({ periodes: [{}, {}, {}, {}] }, { periods: 4, minutes: 50 }), { periods: 4, periodMs: 750000 });
  assert.deepEqual(Live.timing({ periodes: [{}, {}] }, { periods: 4, minutes: 50 }), { periods: 2, periodMs: 1500000 });
  assert.deepEqual(Live.timing({}, { periods: 3, minutes: 45 }), { periods: 3, periodMs: 900000 });
  assert.deepEqual(Live.timing(null, {}), { periods: 4, periodMs: 750000 });
});

test('formatClock: mm:ss, floor standaard en ceil voor aftellen', () => {
  assert.equal(Live.formatClock(0), '00:00');
  assert.equal(Live.formatClock(750000), '12:30');
  assert.equal(Live.formatClock(7 * MIN + 41999), '07:41');
  assert.equal(Live.formatClock(1001, { ceil: true }), '00:02');
  assert.equal(Live.formatClock(-5000), '00:05');
});

test('nieuwe klok: ready, niets verstreken, geen wedstrijdminuut', () => {
  const s = Live.newState(42, 1000);
  const c = Live.computeClock(s, 999999, T);
  assert.equal(c.phase, 'ready');
  assert.equal(c.elapsedMs, 0);
  assert.equal(c.periodNumber, 1);
  assert.equal(c.started, false);
  assert.equal(Live.matchMinute(c), null);
  assert.equal(Live.clockLabel(c), 'P1 · 00:00 / 12:30');
});

test('start/pauze/hervat rekent met tijdstempels (overleeft herladen)', () => {
  let s = Live.newState(1, 0);
  s = Live.startClock(s, 1000);
  assert.equal(Live.computeClock(s, 1000 + 90000, T).elapsedMs, 90000);
  assert.equal(Live.computeClock(s, 1000 + 90000, T).phase, 'running');

  s = Live.pauseClock(s, 1000 + 100000);
  assert.equal(s.startedAt, null);
  assert.equal(s.accMs, 100000);
  // tijd verstrijkt tijdens pauze: telt niet mee
  const cp = Live.computeClock(s, 10 * MIN, T);
  assert.equal(cp.elapsedMs, 100000);
  assert.equal(cp.phase, 'paused');

  s = Live.resumeClock(s, 20 * MIN);
  assert.equal(Live.computeClock(s, 20 * MIN + 5000, T).elapsedMs, 105000);

  // dubbel starten / dubbel pauzeren is idempotent
  assert.equal(Live.startClock(s, 99 * MIN), s);
  const p = Live.pauseClock(s, 21 * MIN);
  assert.equal(Live.pauseClock(p, 22 * MIN), p);
});

test('klok die achteruit loopt (tijd van toestel verzet) geeft nooit negatieve tijd', () => {
  const s = Live.startClock(Live.newState(1, 0), 50000);
  assert.equal(Live.computeClock(s, 10000, T).elapsedMs, 0);
});

test('waarschuwing in laatste minuut, einde en overtijd', () => {
  const s = Live.startClock(Live.newState(1, 0), 0);
  const before = Live.computeClock(s, T.periodMs - 61000, T);
  assert.equal(before.warn, false);
  const warn = Live.computeClock(s, T.periodMs - 60000, T);
  assert.equal(warn.warn, true);
  assert.equal(warn.ended, false);
  const end = Live.computeClock(s, T.periodMs, T);
  assert.equal(end.ended, true);
  assert.equal(end.warn, false);
  const over = Live.computeClock(s, T.periodMs + 35000, T);
  assert.equal(over.overtimeMs, 35000);
  assert.equal(over.progress, 1);
  assert.equal(over.remainingMs, -35000);
});

test('volgende periode: klok staat stil tot start, rust na helft, finished na laatste', () => {
  let s = Live.startClock(Live.newState(1, 0), 0);
  s = Live.nextPeriod(s, T.periodMs + 1000, 4);
  let c = Live.computeClock(s, T.periodMs + 5000, T);
  assert.equal(c.period, 1);
  assert.equal(c.phase, 'ready');
  assert.equal(c.elapsedMs, 0);
  assert.equal(c.isHalfTime, false);

  s = Live.nextPeriod(Live.startClock(s, 0), 1, 4);
  c = Live.computeClock(s, 2, T);
  assert.equal(c.period, 2);
  assert.equal(c.isHalfTime, true, 'na P2 van 4 is het rust');

  s = Live.nextPeriod(s, 3, 4);
  assert.equal(s.period, 3);
  s = Live.nextPeriod(Live.startClock(s, 10), 20, 4);
  assert.equal(s.finished, true);
  assert.equal(s.period, 3);
  assert.equal(Live.computeClock(s, 30, T).phase, 'finished');
  assert.equal(Live.isRunning(s), false);

  const r = Live.reopen(s, 40);
  assert.equal(r.finished, false);
  assert.equal(Live.computeClock(r, 50, T).phase, 'paused');
});

test('rust: bij 2 periodes na P1, bij 3 periodes na P2', () => {
  const two = { periods: 2, periodMs: 25 * MIN };
  const s2 = Live.nextPeriod(Live.newState(1, 0), 0, 2);
  assert.equal(Live.computeClock(s2, 0, two).isHalfTime, true);
  const three = { periods: 3, periodMs: 15 * MIN };
  let s3 = Live.nextPeriod(Live.newState(1, 0), 0, 3);
  assert.equal(Live.computeClock(s3, 0, three).isHalfTime, false);
  s3 = Live.nextPeriod(s3, 0, 3);
  assert.equal(Live.computeClock(s3, 0, three).isHalfTime, true);
});

test('matchMinute: hele wedstrijdminuut over alle periodes', () => {
  let s = Live.startClock(Live.newState(1, 0), 0);
  assert.equal(Live.matchMinute(Live.computeClock(s, 30000, T)), 1);
  assert.equal(Live.matchMinute(Live.computeClock(s, 7 * MIN + 41000, T)), 8);
  // overtijd in P1 wordt afgekapt op de laatste minuut van P1 (12,5 → 13)
  assert.equal(Live.matchMinute(Live.computeClock(s, 15 * MIN, T)), 13);
  s = Live.nextPeriod(s, 15 * MIN, 4);
  // P2 nog niet gestart (vergeten op start te drukken): begin van P2
  assert.equal(Live.matchMinute(Live.computeClock(s, 16 * MIN, T)), 13);
  s = Live.startClock(s, 20 * MIN);
  assert.equal(Live.matchMinute(Live.computeClock(s, 20 * MIN + 2 * MIN, T)), 15);
});

test('markAlert onthoudt per periode dat er al getrild is', () => {
  let s = Live.newState(1, 0);
  s = Live.markAlert(s, 'end', 5);
  assert.equal(s.alerts.end, 0);
  s = Live.nextPeriod(s, 6, 4);
  assert.notEqual(s.alerts.end, s.period);
});

test('normalizePeriod: oude records met subs en labels', () => {
  const p = Live.normalizePeriod({ posities: { A: 'Keeper', B: 'v', C: 'Spits', D: 'Wissel' }, subs: ['E'] });
  assert.deepEqual(p.posities, { A: 'K', B: 'V', C: 'S' });
  assert.deepEqual(p.wissels.sort(), ['D', 'E']);
  assert.deepEqual(Live.normalizePeriod(undefined), { posities: {}, wissels: [] });
});

test('lineupOf sorteert K, V, M, S', () => {
  const l = Live.lineupOf({ posities: { S1: 'S', K1: 'K', M1: 'M', V1: 'V', V2: 'V', S2: 'S' } });
  assert.deepEqual(l.map(x => x.code), ['K', 'V', 'V', 'M', 'S', 'S']);
});

test('diffPeriods: eruit/erin gekoppeld op positie, en positiewissels', () => {
  const p1 = { posities: { James: 'K', Coen: 'V', Bastiaan: 'V', Izzy: 'M', Noud: 'S', Abel: 'S' }, wissels: ['Bram', 'Giulio'] };
  const p2 = { posities: { James: 'K', Bastiaan: 'V', Giulio: 'V', Coen: 'M', Bram: 'S', Abel: 'S' }, wissels: ['Noud', 'Izzy'] };
  const d = Live.diffPeriods(p1, p2);
  assert.deepEqual(d.off.sort(), ['Izzy', 'Noud']);
  assert.deepEqual(d.on.sort(), ['Bram', 'Giulio']);
  assert.deepEqual(d.swaps, [
    { off: 'Izzy', on: 'Giulio', pos: 'V' },
    { off: 'Noud', on: 'Bram', pos: 'S' },
  ]);
  assert.deepEqual(d.moves, [{ name: 'Coen', from: 'V', to: 'M' }]);
  assert.equal(d.none, false);

  const lines = Live.describeDiff(d);
  assert.ok(lines.includes('Noud eruit → Bram erin (Spits)'));
  assert.ok(lines.includes('Coen: Verdediger → Middenvelder'));
});

test('diffPeriods: identiek → none; keeperwissel op het veld is een move', () => {
  const a = { posities: { A: 'K', B: 'V' }, wissels: [] };
  assert.equal(Live.diffPeriods(a, a).none, true);
  const b = { posities: { A: 'V', B: 'K' }, wissels: [] };
  const d = Live.diffPeriods(a, b);
  assert.deepEqual(d.moves, [{ name: 'A', from: 'K', to: 'V' }, { name: 'B', from: 'V', to: 'K' }]);
  assert.deepEqual(Live.describeDiff(d), ['A: Keeper → Verdediger', 'B: Verdediger → Keeper']);
});

test('diffPeriods: ongelijk aantal eruit/erin', () => {
  const a = { posities: { A: 'K', B: 'V', C: 'S' } };
  const b = { posities: { A: 'K', B: 'V' } };
  assert.deepEqual(Live.describeDiff(Live.diffPeriods(a, b)), ['C eruit']);
  assert.deepEqual(Live.describeDiff(Live.diffPeriods(b, a)), ['C erin (Spits)']);
});

test('score: goal toevoegen, scorer zetten, ongedaan maken', () => {
  let m = { id: 1, score: null };
  m = Live.addGoal(m, 'home', 3, null);
  m = Live.addGoal(m, 'away', 9, null);
  m = Live.addGoal(m, 'home', 20, 'Bram');
  assert.deepEqual(m.score, { home: 2, away: 1 });
  assert.equal(m.goals.length, 3);
  m = Live.setScorer(m, 0, 'Noud');
  assert.equal(m.goals[0].by, 'Noud');
  assert.deepEqual(Live.scorers(m), [{ name: 'Bram', count: 1 }, { name: 'Noud', count: 1 }]);
  m = Live.undoLastGoal(m);
  assert.deepEqual(m.score, { home: 1, away: 1 });
  m = Live.undoLastGoal(Live.undoLastGoal(m));
  assert.deepEqual(m.score, { home: 0, away: 0 });
  assert.equal(Live.undoLastGoal(m), m, 'niets om ongedaan te maken');
});

test('score: oorspronkelijke match wordt niet gemuteerd', () => {
  const m = { id: 1, score: { home: 1, away: 0 }, goals: [] };
  const m2 = Live.addGoal(m, 'home', 1, 'X');
  assert.deepEqual(m.score, { home: 1, away: 0 });
  assert.equal(m.goals.length, 0);
  assert.deepEqual(m2.score, { home: 2, away: 0 });
});

test('scorers: Onbekend achteraan bij gelijk aantal, aantallen gesorteerd', () => {
  const m = { goals: [
    { team: 'home', by: null }, { team: 'home', by: 'Bram' }, { team: 'home', by: 'Bram' },
    { team: 'away', by: null }, { team: 'home', by: 'Abel' },
  ] };
  assert.deepEqual(Live.scorers(m), [{ name: 'Bram', count: 2 }, { name: 'Abel', count: 1 }, { name: null, count: 1 }]);
});

test('persistentie: per wedstrijd opgeslagen, opruimen van oude state', () => {
  const mem = new Map();
  const storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  const now = 10 * 24 * 3600 * 1000;
  const s1 = Live.startClock(Live.newState(111, now), now);
  Live.saveState(storage, s1, now);
  Live.saveState(storage, Object.assign(Live.newState(222, now), { period: 2 }), now);
  assert.equal(Live.loadState(storage, 111, now).startedAt, now);
  assert.equal(Live.loadState(storage, 222, now).period, 2);
  assert.equal(Live.loadState(storage, 333, now).period, 0, 'onbekende wedstrijd → nieuwe state');

  // oude state (> 3 dagen) wordt bij volgende save opgeruimd
  Live.saveState(storage, Live.newState(444, now + 5 * 24 * 3600 * 1000), now + 5 * 24 * 3600 * 1000);
  const all = JSON.parse(mem.get('jo10_live_v2'));
  assert.deepEqual(Object.keys(all), ['444']);

  Live.clearState(storage, 444);
  assert.deepEqual(JSON.parse(mem.get('jo10_live_v2')), {});

  // corrupte opslag of geen opslag → geen crash
  mem.set('jo10_live_v2', '{kapot');
  assert.equal(Live.loadState(storage, 1, 0).period, 0);
  assert.equal(Live.loadState(null, 1, 0).period, 0);
  Live.saveState(null, s1, now);
});

test('goalPatch: alleen { id, score, goals }, losgekoppeld van het origineel', () => {
  const m = { id: 7, titel: 'x', periodes: [{}], score: null, goals: [{ team: 'home', minute: 3, by: null }] };
  const p = Live.goalPatch(m);
  assert.deepEqual(Object.keys(p).sort(), ['goals', 'id', 'score']);
  assert.deepEqual(p, { id: 7, score: { home: 0, away: 0 }, goals: [{ team: 'home', minute: 3, by: null }] });
  p.goals[0].by = 'X';
  assert.equal(m.goals[0].by, null);
  assert.deepEqual(Live.goalPatch({ id: 1 }).goals, []);
});

test('mergeRemote: opstelling van remote, score lokaal tenzij remote nieuwer', () => {
  const local = { id: 1, periodes: [{ posities: { A: 'K' } }], score: { home: 2, away: 0 }, goals: [{ team: 'home' }, { team: 'home' }], updatedAt: 100 };
  const remoteOld = { id: 1, periodes: [{ posities: { B: 'K' } }], score: { home: 1, away: 0 }, goals: [{ team: 'home' }], updatedAt: 500 };
  // lokale goal op t=1000, remote opgeslagen op t=500 → lokale score houden, wel nieuwe opstelling
  let m = Live.mergeRemote(local, remoteOld, 1000);
  assert.deepEqual(m.periodes, remoteOld.periodes);
  assert.deepEqual(m.score, { home: 2, away: 0 });
  assert.equal(m.goals.length, 2);
  // remote nieuwer dan laatste lokale actie → remote score
  const remoteNew = Object.assign({}, remoteOld, { score: { home: 3, away: 1 }, goals: [], updatedAt: 2000 });
  m = Live.mergeRemote(local, remoteNew, 1000);
  assert.deepEqual(m.score, { home: 3, away: 1 });
  // nog geen lokale score-actie → remote altijd leidend
  assert.deepEqual(Live.mergeRemote(local, remoteOld, 0).score, { home: 1, away: 0 });
  // andere wedstrijd of niets → negeren
  assert.equal(Live.mergeRemote(local, { id: 2 }, 0), local);
  assert.equal(Live.mergeRemote(local, null, 0), local);
});

test('pitchRows: rijen volgen de formatie van de opstelling (2-1-2 en 2-2-1)', () => {
  const r212 = Live.pitchRows({ posities: { K1: 'K', V1: 'V', V2: 'V', M1: 'M', S1: 'S', S2: 'S' }, wissels: ['W1'] });
  assert.deepEqual(r212, { S: ['S1', 'S2'], M: ['M1'], V: ['V1', 'V2'], K: ['K1'] });
  const r221 = Live.pitchRows({ posities: { S1: 'S', M2: 'M', K1: 'K', V1: 'V', M1: 'M', V2: 'V' }, wissels: ['W1', 'W2'] });
  assert.deepEqual(r221, { S: ['S1'], M: ['M2', 'M1'], V: ['V1', 'V2'], K: ['K1'] });
  assert.deepEqual(Live.pitchRows(undefined), { S: [], M: [], V: [], K: [] });
});

test('formationOf: formatie-veld, anders afgeleid; wisseldiff ongewijzigd bij 2-2-1', () => {
  assert.deepEqual(Live.formationOf({ formatie: '2-2-1', periodes: [] }), { K: 1, V: 2, M: 2, S: 1 });
  assert.deepEqual(Live.formationOf({ periodes: [{ posities: { a: 'K', b: 'V', c: 'V', d: 'M', e: 'M', f: 'S' } }] }), { K: 1, V: 2, M: 2, S: 1 });
  assert.deepEqual(Live.formationOf({ periodes: [] }), { K: 1, V: 2, M: 1, S: 2 });
  const p1 = { posities: { K1: 'K', V1: 'V', V2: 'V', M1: 'M', M2: 'M', S1: 'S' }, wissels: ['W1'] };
  const p2 = { posities: { K1: 'K', V1: 'V', V2: 'V', M1: 'M', W1: 'M', M2: 'S' }, wissels: ['S1'] };
  const d = Live.diffPeriods(p1, p2);
  assert.deepEqual(d.off, ['S1']);
  assert.deepEqual(d.on, ['W1']);
  assert.deepEqual(d.swaps, [{ off: 'S1', on: 'W1', pos: 'M' }]);
  assert.deepEqual(d.moves, [{ name: 'M2', from: 'M', to: 'S' }]);
});
