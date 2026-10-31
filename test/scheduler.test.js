'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Config = require('../js/config.js');
const Scheduler = require('../js/scheduler.js');

const NAMES = ['Noud', 'Bastiaan', 'James', 'Giulio', 'Bram', 'Coen', 'Izzy', 'Abel', 'Finn', 'Lars'];
const SQUAD = Config.DEFAULT_SQUAD;

// code van speler in periode
const codeOf = (per, nm) => (per.wissels.includes(nm) ? 'W' : per.posities[nm] || null);
const column = (res, nm) => res.periodes.map(per => codeOf(per, nm));

// Controleert alle harde regels; geeft lijst met fouten terug.
function hardViolations(res, players, keepers, locks = [], base) {
  const errs = [];
  const form = Config.formationFor(players.length, base);
  const subsNeeded = players.length - (form.K + form.V + form.M + form.S);
  res.periodes.forEach((per, p) => {
    const cnt = { K: 0, V: 0, M: 0, S: 0 };
    Object.entries(per.posities).forEach(([nm, c]) => {
      cnt[c]++;
      if (!players.includes(nm)) errs.push(`P${p + 1}: onbekende speler ${nm}`);
    });
    ['K', 'V', 'M', 'S'].forEach(c => { if (cnt[c] !== form[c]) errs.push(`P${p + 1}: ${c}=${cnt[c]} i.p.v. ${form[c]}`); });
    if (per.wissels.length !== subsNeeded) errs.push(`P${p + 1}: ${per.wissels.length} wissels`);
    players.forEach(nm => {
      const inPos = nm in per.posities, inW = per.wissels.includes(nm);
      if (inPos === inW) errs.push(`P${p + 1}: ${nm} ${inPos ? 'dubbel' : 'ontbreekt'}`);
    });
    const kLock = locks.find(l => l.period === p && l.code === 'K');
    const keeper = kLock ? kLock.player : keepers[p];
    if (keeper && per.posities[keeper] !== 'K') errs.push(`P${p + 1}: keeper ${keeper} staat niet op K`);
  });
  players.forEach(nm => {
    const col = column(res, nm);
    for (let p = 1; p < col.length; p++) if (col[p] === 'W' && col[p - 1] === 'W') errs.push(`${nm} wissel P${p} en P${p + 1}`);
  });
  locks.forEach(l => {
    const c = codeOf(res.periodes[l.period], l.player);
    if (c !== l.code) errs.push(`lock ${l.player} P${l.period + 1} ${l.code} → ${c}`);
  });
  return errs;
}

function rng(seed) { return Scheduler._mulberry32(seed); }

// Eenvoudige geschiedenis: elke wedstrijd met gegeven spelers; `subsFor(match, period)` → wissels
function makeHistory(count, players, subsPick, posPick) {
  const hist = [];
  for (let m = 0; m < count; m++) {
    const periodes = [];
    for (let p = 0; p < 4; p++) {
      const wissels = subsPick(m, p);
      const field = players.filter(x => !wissels.includes(x));
      const codes = ['K', 'V', 'V', 'M', 'S', 'S'];
      const posities = {};
      field.forEach((x, i) => { posities[x] = posPick ? posPick(x, i, m, p) : codes[(i + m + p) % codes.length]; });
      periodes.push({ posities, wissels });
    }
    hist.push({ id: m + 1, datum: `2026-09-${String(m + 1).padStart(2, '0')}`, periodes });
  }
  return hist;
}

test('formationFor delegeert naar Config', () => {
  for (let n = 1; n <= 12; n++) assert.deepStrictEqual(Scheduler.formationFor(n), Config.formationFor(n));
});

test('harde regels over veel seeds en 4..10 spelers', () => {
  const r = rng(12345);
  for (let n = 4; n <= 10; n++) {
    for (let seed = 1; seed <= 15; seed++) {
      const players = NAMES.slice(0, n);
      const mode = seed % 3;
      let keepers;
      if (mode === 0) keepers = Array(4).fill(players[seed % n]);                    // zelfde keeper
      else if (mode === 1) keepers = [0, 0, 1, 1].map(h => players[(seed + h * 3) % n]); // per helft
      else keepers = [0, 1, 2, 3].map(() => players[Math.floor(r() * n)]);          // willekeurig
      const res = Scheduler.generate({ players, keepers, periods: 4, history: [], squad: SQUAD, seed, locks: [] });
      const errs = hardViolations(res, players, keepers);
      assert.deepStrictEqual(errs, [], `n=${n} seed=${seed} keepers=${keepers}: ${errs.join('; ')}`);
      assert.ok(res.fairness && typeof res.fairness.score === 'number');
      // speeltijd gelijk: verschil in wisselbeurten ≤ 1 (spelers die alles keepen tellen niet)
      const subs = players.filter(nm => !keepers.every(k => k === nm)).map(nm => column(res, nm).filter(c => c === 'W').length);
      assert.ok(Math.max(...subs) - Math.min(...subs) <= 1, `n=${n} seed=${seed}: wissels ${subs}`);
    }
  }
});

test('harde regels met historie en 2 en 3 periodes', () => {
  const players = NAMES.slice(0, 8);
  const hist = makeHistory(4, players, (m, p) => [players[(m + p) % 8], players[(m + p + 4) % 8]]);
  for (const periods of [2, 3, 5]) {
    for (let seed = 1; seed <= 8; seed++) {
      const keepers = Scheduler.suggestKeepers({ players, history: hist, squad: SQUAD, periods });
      assert.strictEqual(keepers.length, periods);
      const res = Scheduler.generate({ players, keepers, periods, history: hist, squad: SQUAD, seed });
      assert.strictEqual(res.periodes.length, periods);
      assert.deepStrictEqual(hardViolations(res, players, keepers), []);
    }
  }
});

test('deterministisch per seed, verschillend tussen seeds', () => {
  const players = NAMES.slice(0, 9);
  const keepers = ['Noud', 'Noud', 'James', 'James'];
  const a = Scheduler.generate({ players, keepers, periods: 4, history: [], squad: SQUAD, seed: 7 });
  const b = Scheduler.generate({ players, keepers, periods: 4, history: [], squad: SQUAD, seed: 7 });
  assert.deepStrictEqual(a, b);
  const seen = new Set();
  for (let seed = 1; seed <= 10; seed++) {
    seen.add(JSON.stringify(Scheduler.generate({ players, keepers, periods: 4, history: [], squad: SQUAD, seed }).periodes));
  }
  assert.ok(seen.size >= 3, `slechts ${seen.size} verschillende schema's`);
});

test('locks worden gerespecteerd; K-lock gaat boven keepers', () => {
  const players = NAMES.slice(0, 8);
  const keepers = ['Noud', 'Noud', 'James', 'James'];
  const locks = [
    { period: 0, player: 'Coen', code: 'W' },
    { period: 1, player: 'Coen', code: 'S' },
    { period: 2, player: 'Izzy', code: 'K' },   // overschrijft James in P3
    { period: 3, player: 'Bram', code: 'M' },
    { period: 3, player: 'Noud', code: 'V' },
  ];
  for (let seed = 1; seed <= 10; seed++) {
    const res = Scheduler.generate({ players, keepers, periods: 4, history: [], squad: SQUAD, seed, locks });
    assert.deepStrictEqual(hardViolations(res, players, keepers, locks), [], `seed ${seed}`);
    assert.strictEqual(res.periodes[2].posities.Izzy, 'K');
    assert.strictEqual(res.keepers[2], 'Izzy');
  }
});

test('lock die niet in de formatie past wordt genegeerd met waarschuwing', () => {
  const players = NAMES.slice(0, 8);
  const locks = [
    { period: 0, player: 'Coen', code: 'M' },
    { period: 0, player: 'Izzy', code: 'M' },        // tweede middenvelder past niet
    { period: 1, player: 'Onbekend', code: 'V' },    // niet aanwezig
  ];
  const res = Scheduler.generate({ players, keepers: ['Noud', 'Noud', 'Abel', 'Abel'], periods: 4, history: [], squad: SQUAD, seed: 3, locks });
  assert.strictEqual(res.periodes[0].posities.Coen, 'M');
  assert.ok(res.warnings.some(w => w.includes('Izzy') && w.includes('genegeerd')), res.warnings.join('|'));
  assert.ok(res.warnings.some(w => w.includes('Onbekend')), res.warnings.join('|'));
  assert.deepStrictEqual(hardViolations(res, players, ['Noud', 'Noud', 'Abel', 'Abel']), []);
});

test('onmogelijke locks: minimaliseren en waarschuwen; keeper elders vastgezet', () => {
  const players = NAMES.slice(0, 9);
  const keepers = ['Noud', 'Noud', 'James', 'James'];
  const locks = [
    { period: 0, player: 'Coen', code: 'W' },
    { period: 1, player: 'Coen', code: 'W' },
    { period: 1, player: 'Noud', code: 'S' },
  ];
  const res = Scheduler.generate({ players, keepers, periods: 4, history: [], squad: SQUAD, seed: 1, locks });
  assert.ok(res.warnings.includes('Coen staat twee periodes achter elkaar wissel (P1 en P2)'), res.warnings.join('|'));
  assert.ok(res.warnings.some(w => w.startsWith('Noud staat in periode 2 vast als Spits; ')), res.warnings.join('|'));
  assert.strictEqual(res.periodes[1].posities.Noud, 'S');
  assert.strictEqual(Object.values(res.periodes[1].posities).filter(c => c === 'K').length, 1);
  // verder geen schendingen behalve die van Coen
  const errs = hardViolations(res, players, ['Noud', null, 'James', 'James'], locks);
  assert.deepStrictEqual(errs, ['Coen wissel P1 en P2']);
});

test('tegenstrijdige locks voor dezelfde speler en periode: laatste wint, met waarschuwing', () => {
  const players = NAMES.slice(0, 8);
  const keepers = ['Noud', 'Noud', 'James', 'James'];
  const locks = [
    { period: 1, player: 'Coen', code: 'K' },
    { period: 1, player: 'Coen', code: 'S' },   // wint
    { period: 2, player: 'Izzy', code: 'V' },
    { period: 2, player: 'Izzy', code: 'V' },   // dubbel maar gelijk → geen waarschuwing
  ];
  const res = Scheduler.generate({ players, keepers, periods: 4, history: [], squad: SQUAD, seed: 1, locks });
  assert.ok(res.warnings.includes('Coen heeft in periode 2 twee vastzettingen; Spits aangehouden'), res.warnings.join('|'));
  assert.ok(!res.warnings.some(w => w.startsWith('Izzy heeft')), res.warnings.join('|'));
  assert.strictEqual(res.periodes[1].posities.Coen, 'S');
  assert.strictEqual(res.periodes[1].posities.Noud, 'K');
  assert.strictEqual(res.periodes[2].posities.Izzy, 'V');
  assert.deepStrictEqual(hardViolations(res, players, keepers, [locks[1], locks[2]]), []);
});

test('avoid-posities worden vermeden (Bastiaan geen spits)', () => {
  const squad = {
    players: [
      { name: 'Bastiaan', active: true, avoid: ['S'], aliases: [] },
      { name: 'Bram', active: true, avoid: ['V', 'M'], aliases: [] },
      { name: 'Coen', active: true, avoid: ['M'], aliases: [] },
    ],
    settings: { periods: 4, minutes: 50 },
  };
  for (let n = 5; n <= 10; n++) {
    for (let seed = 1; seed <= 6; seed++) {
      const players = NAMES.slice(0, n);
      const res = Scheduler.generate({ players, keepers: ['Noud', 'Noud', 'James', 'James'], periods: 4, history: [], squad, seed });
      assert.ok(!column(res, 'Bastiaan').includes('S'), `n=${n} seed=${seed} Bastiaan spits`);
      assert.ok(!column(res, 'Bram').some(c => c === 'V' || c === 'M'), `n=${n} seed=${seed} Bram ${column(res, 'Bram')}`);
      assert.ok(!column(res, 'Coen').includes('M'), `n=${n} seed=${seed} Coen middenveld`);
      assert.ok(!res.warnings.some(w => w.includes('liever niet')), res.warnings.join('|'));
    }
  }
});

test('avoid is zacht: onvermijdelijk → toch ingedeeld, met waarschuwing', () => {
  const squad = { players: ['Noud', 'Bastiaan', 'James', 'Giulio'].map(name => ({ name, active: true, avoid: ['S'], aliases: [] })), settings: { periods: 4 } };
  const players = ['Noud', 'Bastiaan', 'James', 'Giulio'];
  const res = Scheduler.generate({ players, keepers: ['Noud', 'Noud', 'James', 'James'], periods: 4, history: [], squad, seed: 1 });
  assert.deepStrictEqual(hardViolations(res, players, ['Noud', 'Noud', 'James', 'James']), []);
  assert.ok(res.warnings.some(w => /staat als Spits \(liever niet\)/.test(w)));
});

test('spelers zonder profiel in de selectie en geen squad', () => {
  const players = ['Noud', 'Bastiaan', 'Gast1', 'Gast2', 'Gast3', 'Gast4', 'Gast5'];
  const res = Scheduler.generate({ players, keepers: ['Gast1', 'Gast1', 'Gast2', 'Gast2'], periods: 4, history: [], squad: { players: [] }, seed: 2 });
  assert.deepStrictEqual(hardViolations(res, players, ['Gast1', 'Gast1', 'Gast2', 'Gast2']), []);
  const res2 = Scheduler.generate({ players, keepers: ['Gast1', 'Gast1', 'Gast2', 'Gast2'], periods: 4, seed: 2 });
  assert.deepStrictEqual(hardViolations(res2, players, ['Gast1', 'Gast1', 'Gast2', 'Gast2']), []);
});

test('ontbrekende of afwezige keeper → voorstel + waarschuwing', () => {
  const players = NAMES.slice(0, 8);
  const res = Scheduler.generate({ players, keepers: ['Noud', null, 'Weg', undefined], periods: 4, history: [], squad: SQUAD, seed: 1 });
  assert.deepStrictEqual(hardViolations(res, players, []), []);
  assert.strictEqual(res.periodes[0].posities.Noud, 'K');
  res.periodes.forEach(per => assert.strictEqual(Object.values(per.posities).filter(c => c === 'K').length, 1));
  assert.ok(res.warnings.some(w => w.includes('Weg') && w.includes('niet aanwezig')));
  assert.ok(res.warnings.some(w => w.startsWith('Geen keeper voor periode 2')));
  const res2 = Scheduler.generate({ players, periods: 4, seed: 1 });
  assert.strictEqual(res2.keepers.length, 4);
  assert.ok(res2.keepers.every(Boolean));
});

test('seizoensbalans: wie vaak wissel was, zit nu minder', () => {
  const players = NAMES.slice(0, 9);
  // Coen was elke wedstrijd 2× wissel, de rest gemiddeld minder
  const hist = makeHistory(6, players, (m, p) => {
    const others = players.filter(x => x !== 'Coen');
    if (p === 0 || p === 2) return ['Coen', others[(m * 3 + p) % 8], others[(m * 3 + p + 1) % 8]];
    return others.slice((m + p) % 6, (m + p) % 6 + 3);
  });
  const st = Scheduler.stats(hist, ['Coen', 'Noud']);
  assert.ok(st.Coen.W > st.Noud.W);
  for (let seed = 1; seed <= 10; seed++) {
    const res = Scheduler.generate({ players, keepers: ['Noud', 'Noud', 'James', 'James'], periods: 4, history: hist, squad: SQUAD, seed });
    const subs = players.map(nm => column(res, nm).filter(c => c === 'W').length);
    assert.strictEqual(column(res, 'Coen').filter(c => c === 'W').length, Math.min(...subs), `seed ${seed}`);
  }
  // 7 spelers: 4 wisselbeurten over 7 spelers → Coen hoeft niet
  const p7 = players.slice(0, 7);
  for (let seed = 1; seed <= 10; seed++) {
    const res = Scheduler.generate({ players: p7, keepers: ['Noud', 'Noud', 'James', 'James'], periods: 4, history: hist, squad: SQUAD, seed });
    assert.ok(!column(res, 'Coen').includes('W'), `seed ${seed}`);
  }
});

test('wie vorige wedstrijd in P1 wissel was, begint nu niet als wissel', () => {
  const players = NAMES.slice(0, 8);
  const hist = makeHistory(3, players, (m, p) => (m === 2 && p === 0 ? ['Izzy', 'Abel'] : [players[(m + p * 2) % 8], players[(m + p * 2 + 1) % 8]]));
  for (let seed = 1; seed <= 10; seed++) {
    const res = Scheduler.generate({ players, keepers: ['Noud', 'Noud', 'James', 'James'], periods: 4, history: hist, squad: SQUAD, seed });
    assert.ok(!res.periodes[0].wissels.includes('Izzy') && !res.periodes[0].wissels.includes('Abel'), `seed ${seed}: ${res.periodes[0].wissels}`);
  }
});

test('veldposities: max 2 keer dezelfde, meestal ≥ 2 verschillende', () => {
  for (let n = 6; n <= 10; n++) {
    for (let seed = 1; seed <= 5; seed++) {
      const players = NAMES.slice(0, n);
      const res = Scheduler.generate({ players, keepers: ['Noud', 'Noud', 'James', 'James'], periods: 4, history: [], squad: SQUAD, seed });
      players.forEach(nm => {
        const col = column(res, nm);
        ['V', 'M', 'S'].forEach(c => assert.ok(col.filter(x => x === c).length <= 2, `n=${n} seed=${seed} ${nm}: ${col}`));
        const field = col.filter(c => 'VMS'.includes(c));
        if (field.length >= 2) assert.ok(new Set(field).size >= 2, `n=${n} seed=${seed} ${nm}: ${col}`);
      });
    }
  }
});

test('seizoensbalans posities: veel verdedigd → nu minder verdediger', () => {
  const players = NAMES.slice(0, 6);
  // Giulio stond steeds verdediger
  const hist = makeHistory(5, players, () => [], (x, i, m, p) => (x === 'Giulio' ? 'V' : ['K', 'V', 'M', 'S', 'S'][(i + m + p) % 5]));
  for (let seed = 1; seed <= 6; seed++) {
    const res = Scheduler.generate({ players, keepers: ['Noud', 'Noud', 'James', 'James'], periods: 4, history: hist, squad: SQUAD, seed });
    const col = column(res, 'Giulio');
    assert.ok(col.filter(c => c === 'V').length === 0, `seed ${seed}: ${col}`);
  }
});

test('historie met legacy-records (subs, ontbrekende posities, score undefined)', () => {
  const players = NAMES.slice(0, 8);
  const legacy = [
    { titel: 'oud', periodes: [{ posities: { Noud: 'K', Bram: 'V' }, subs: ['Coen', 'Izzy'] }, { subs: ['Abel'] }, {}, null] },
    { titel: 'zonder periodes' },
    null,
    { datum: '2026-09-01', score: undefined, periodes: [{ posities: { James: 'k', Coen: 'W' }, wissels: ['Bram'] }] },
  ];
  const st = Scheduler.stats(legacy, ['Coen', 'Bram', 'James', 'Abel', 'Niemand']);
  assert.deepStrictEqual(st.Coen, { matches: 2, periods: 2, K: 0, V: 0, M: 0, S: 0, W: 2, fieldPct: 0 });
  assert.strictEqual(st.Bram.matches, 2);
  assert.strictEqual(st.Bram.V, 1);
  assert.strictEqual(st.Bram.W, 1);
  assert.strictEqual(st.James.K, 1);
  assert.strictEqual(st.Abel.W, 1);
  assert.deepStrictEqual(st.Niemand, { matches: 0, periods: 0, K: 0, V: 0, M: 0, S: 0, W: 0, fieldPct: 0 });
  const res = Scheduler.generate({ players, keepers: ['Noud', 'Noud', 'James', 'James'], periods: 4, history: legacy, squad: SQUAD, seed: 1 });
  assert.deepStrictEqual(hardViolations(res, players, ['Noud', 'Noud', 'James', 'James']), []);
  assert.ok(Array.isArray(Scheduler.suggestKeepers({ players, history: legacy, squad: SQUAD, periods: 4 })));
  assert.doesNotThrow(() => Scheduler.evaluate(legacy[0].periodes, { players, history: legacy }));
});

test('stats: tellingen en fieldPct', () => {
  const hist = [
    { datum: '2026-09-01', periodes: [
      { posities: { A: 'K', B: 'V' }, wissels: ['C'] },
      { posities: { A: 'V', C: 'S' }, wissels: ['B'] },
    ] },
    { datum: '2026-09-08', periodes: [{ posities: { A: 'M', B: 'S' }, wissels: [] }] },
  ];
  const st = Scheduler.stats(hist);
  assert.deepStrictEqual(Object.keys(st), ['A', 'B', 'C']);
  assert.deepStrictEqual(st.A, { matches: 2, periods: 3, K: 1, V: 1, M: 1, S: 0, W: 0, fieldPct: 100 });
  assert.deepStrictEqual(st.B, { matches: 2, periods: 3, K: 0, V: 1, M: 0, S: 1, W: 1, fieldPct: 67 });
  assert.deepStrictEqual(st.C, { matches: 1, periods: 2, K: 0, V: 0, M: 0, S: 1, W: 1, fieldPct: 50 });
  assert.deepStrictEqual(Scheduler.stats(undefined, ['X']).X.matches, 0);
});

test('suggestKeepers: minst gekeept per helft, avoid K, tie-break', () => {
  const players = ['Abel', 'Bram', 'Coen', 'Daan'];
  const squad = { players: [{ name: 'Abel', avoid: ['K'] }], settings: { periods: 4 } };
  assert.deepStrictEqual(Scheduler.suggestKeepers({ players, history: [], squad, periods: 4 }), ['Bram', 'Bram', 'Coen', 'Coen']);
  const hist = [
    { datum: '2026-09-01', periodes: [{ posities: { Bram: 'K', Coen: 'V' }, wissels: [] }, { posities: { Bram: 'K' }, wissels: [] }] },
    { datum: '2026-09-08', periodes: [{ posities: { Coen: 'K' }, wissels: [] }, { posities: { Daan: 'K' }, wissels: [] }] },
  ];
  // K-periodes: Bram 2, Coen 1, Daan 1 (Coen en Daan gelijk → op naam)
  assert.deepStrictEqual(Scheduler.suggestKeepers({ players, history: hist, squad, periods: 4 }), ['Coen', 'Coen', 'Daan', 'Daan']);
  // 3 periodes: eerste helft = 2 periodes
  assert.deepStrictEqual(Scheduler.suggestKeepers({ players, history: hist, squad, periods: 3 }), ['Coen', 'Coen', 'Daan']);
  // één kandidaat → zelfde keeper voor beide helften
  assert.deepStrictEqual(Scheduler.suggestKeepers({ players: ['Abel', 'Bram'], history: [], squad, periods: 2 }), ['Bram', 'Bram']);
  // iedereen avoid K → toch iemand
  assert.strictEqual(Scheduler.suggestKeepers({ players: ['Abel'], history: [], squad, periods: 4 }).length, 4);
  assert.deepStrictEqual(Scheduler.suggestKeepers({ players: [], history: [], squad, periods: 4 }), []);
});

test('evaluate: Nederlandse waarschuwingen voor ongeldige schema\'s', () => {
  const players = ['Noud', 'Bastiaan', 'James', 'Giulio', 'Bram', 'Coen', 'Izzy', 'Abel'];
  const ok = { posities: { Noud: 'K', Bastiaan: 'V', James: 'V', Giulio: 'M', Bram: 'S', Coen: 'S' }, wissels: ['Izzy', 'Abel'] };
  const p2 = { posities: { Noud: 'K', Bastiaan: 'V', Izzy: 'V', Abel: 'M', Bram: 'S', Coen: 'S' }, wissels: ['James', 'Giulio'] };
  const p3 = { posities: { Noud: 'K', Bastiaan: 'S', Izzy: 'V', Abel: 'V', Bram: 'V', Coen: 'S' }, wissels: ['James', 'Giulio'] };
  const p4 = { posities: { James: 'K', Bastiaan: 'V', Giulio: 'V', Abel: 'M', Bram: 'S', Izzy: 'S' }, wissels: ['Noud'] };
  const ev = Scheduler.evaluate([ok, p2, p3, p4], { players, keepers: ['Noud', 'Noud', 'Noud', 'Noud'], history: [], squad: SQUAD });
  const w = ev.warnings;
  assert.ok(w.includes('James staat twee periodes achter elkaar wissel (P2 en P3)'), w.join('\n'));
  assert.ok(w.includes('Giulio staat twee periodes achter elkaar wissel (P2 en P3)'), w.join('\n'));
  assert.ok(w.some(x => x.startsWith('Bastiaan staat als Spits (liever niet)')), w.join('\n'));
  assert.ok(w.some(x => x.startsWith('Formatie periode 3 klopt niet: 3 verdedigers')), w.join('\n'));
  assert.ok(w.some(x => x.startsWith('Formatie periode 4 klopt niet')), w.join('\n'));
  assert.ok(w.some(x => x.includes('Coen') && x.includes('niet ingedeeld')), w.join('\n'));
  assert.ok(w.includes('Noud is keeper in periode 4 maar staat als wissel'), w.join('\n'));
  assert.deepStrictEqual(ev.perPlayer.James, { field: 2, sub: 2, K: 1, V: 1, M: 0, S: 0 });
  assert.ok(ev.score >= 0 && ev.score < 60, `score ${ev.score}`);
});

test('evaluate: geldig schema geeft hoge score; robuust bij rommel', () => {
  const players = NAMES.slice(0, 8);
  const res = Scheduler.generate({ players, keepers: ['Noud', 'Noud', 'James', 'James'], periods: 4, history: [], squad: SQUAD, seed: 5 });
  const ev = Scheduler.evaluate(res.periodes, { players, keepers: ['Noud', 'Noud', 'James', 'James'], history: [], squad: SQUAD });
  assert.deepStrictEqual(ev.warnings, []);
  assert.strictEqual(ev.score, 100);
  assert.deepStrictEqual(res.fairness, { perPlayer: ev.perPlayer, score: ev.score });
  players.forEach(nm => assert.strictEqual(ev.perPlayer[nm].field + ev.perPlayer[nm].sub, 4));
  for (const junk of [null, undefined, 'x', [null], [{}], [{ posities: null, wissels: 'x' }], [{ posities: { A: 'Z' } }]]) {
    assert.doesNotThrow(() => Scheduler.evaluate(junk, { players }));
    assert.doesNotThrow(() => Scheduler.evaluate(junk));
    const e = Scheduler.evaluate(junk, { players });
    assert.ok(Array.isArray(e.warnings) && e.score >= 0 && e.score <= 100);
  }
  // speler in schema die niet aanwezig is
  const e2 = Scheduler.evaluate([{ posities: { Vreemd: 'K' }, wissels: [] }], { players: ['Noud'] });
  assert.ok(e2.warnings.some(x => x.includes('Vreemd') && x.includes('niet aanwezig')));
  // ongelijke speeltijd: F en G elk 2× wissel, de rest 0×
  const base = { A: 'K', B: 'V', C: 'V', D: 'M', E: 'S' };
  const e3 = Scheduler.evaluate([
    { posities: { ...base, F: 'S' }, wissels: ['G'] },
    { posities: { ...base, G: 'S' }, wissels: ['F'] },
    { posities: { ...base, F: 'S' }, wissels: ['G'] },
    { posities: { ...base, G: 'S' }, wissels: ['F'] },
  ], { players: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] });
  assert.ok(e3.warnings.some(x => x.startsWith('Speeltijd ongelijk')), e3.warnings.join('|'));
});

test('generate: randgevallen (0, 1, 4 spelers, 2 periodes, zelfde keeper)', () => {
  const r0 = Scheduler.generate({ players: [], keepers: [], periods: 4, seed: 1 });
  assert.strictEqual(r0.periodes.length, 4);
  assert.ok(r0.warnings.length > 0);
  const r1 = Scheduler.generate({ players: ['Noud'], keepers: ['Noud'], periods: 2, seed: 1 });
  assert.deepStrictEqual(r1.periodes.map(p => p.posities.Noud), ['K', 'K']);
  const p4 = NAMES.slice(0, 4);
  const r4 = Scheduler.generate({ players: p4, keepers: ['Noud', 'Noud', 'Noud', 'Noud'], periods: 4, seed: 1 });
  assert.deepStrictEqual(hardViolations(r4, p4, ['Noud', 'Noud', 'Noud', 'Noud']), []);
  const p8 = NAMES.slice(0, 8);
  const r2 = Scheduler.generate({ players: p8, keepers: ['Noud', 'James'], periods: 2, seed: 9, squad: SQUAD });
  assert.deepStrictEqual(hardViolations(r2, p8, ['Noud', 'James']), []);
  // 2 periodes, 2 wissels: 4 verschillende spelers wissel
  assert.strictEqual(new Set(r2.periodes.flatMap(p => p.wissels)).size, 4);
  // periodes afgeleid uit keepers-lengte
  const r3 = Scheduler.generate({ players: p8, keepers: ['Noud', 'Noud', 'James'], seed: 1 });
  assert.strictEqual(r3.periodes.length, 3);
});

test('prestatie: < 150 ms per schema bij 8–10 spelers', () => {
  const hist = makeHistory(12, NAMES, (m, p) => NAMES.slice((m + p) % 6, (m + p) % 6 + 4));
  const locks = [{ period: 1, player: 'Coen', code: 'V' }];
  for (let n = 8; n <= 10; n++) {
    const players = NAMES.slice(0, n);
    let worst = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const t = process.hrtime.bigint();
      Scheduler.generate({ players, keepers: ['Noud', 'Noud', 'James', 'James'], periods: 4, history: hist, squad: SQUAD, seed, locks });
      worst = Math.max(worst, Number(process.hrtime.bigint() - t) / 1e6);
    }
    assert.ok(worst < 150, `n=${n}: ${worst.toFixed(1)} ms`);
  }
});

// ── Formatie per wedstrijd (2-1-2 standaard, 2-2-1) ───────────────────────

const F212 = Config.formationById('2-1-2');
const F221 = Config.formationById('2-2-1');

// Opstelling als compacte tekst: per periode de code per speler in NAMES-volgorde (alleen aanwezigen).
const encode = res => res.periodes.map(p => NAMES.filter(n => n in p.posities || p.wissels.includes(n))
  .map(n => (p.wissels.includes(n) ? 'W' : p.posities[n])).join('')).join('|');

// Vastgelegd met de scheduler van vóór de formatiekeuze (commit 8b7a752): zonder `formation` (en met
// expliciet 2-1-2) moet generate exact dezelfde schema's blijven geven.
const GOLDEN_212 = [
  '5:1:KVVMS|KMVSV|SKMVV|VKSVM', '5:7:KVSMV|KMSVV|MKVVS|VKVSM', '5:42:KVSVM|KMSVV|MKVSV|VKVMS',
  '6:1:KVSMSV|KMSVSV|MKVSVS|VKVSMS', '6:7:KMSVVS|KVSMVS|VKMSSV|SKVSMV', '6:42:KVSSMV|KMSSVV|SKVVSM|VKMVSS',
  '7:1:KWMVVSS|KMVVWSS|MKWSSVV|WKSSMVV', '7:7:KWMVSVS|KMSVSVW|MKWSVSV|WKVSVSM', '7:42:KWVVMSS|KMWVVSS|MKSSWVV|WKMSSVV',
  '8:1:KWMSWSVV|KMWSVVWS|VKSWVWSM|WKVVSMSW', '8:7:KWMVVSWS|KVWMSWSV|SKVWWVSM|WKSSMVVW', '8:42:KWWVMVSS|KMVWVWSS|VKVMSSWW|WKSSWMVV',
  '9:1:KWWSVSMVW|KMSVWWSWV|VKWWSVWMS|WKVMWWVSS', '9:7:KWWMSSVVW|KVVSWWWMS|SKWWVMSWV|WKSVWVWSM', '9:42:KWSVMWWSV|KMSWWSVVW|VKWSSVWWM|WKVWVWSMS',
];
const GOLDEN_212_SEASON = ['KWVSSWMV|KVSMWVSW|VKMWVSWS|WKWVMSVS', 'SKWSVMV|SKSWVMV|WMKVSVS|MWKVSVS',
  'SVKWSVMW|VVKSMWWS|VWVKWSSM|WMWKVSSV', 'MVVKWSS|MVVKSSW|SWSMKVV|VMSSKWV'];

test('formatie: zonder formation (en met 2-1-2) exact dezelfde schema\'s als vóór de formatiekeuze', () => {
  for (const extra of [{}, { formation: F212 }, { formation: { K: 1, V: 2, M: 1, S: 2 } }, { formation: null }]) {
    const got = [];
    for (const n of [5, 6, 7, 8, 9]) for (const seed of [1, 7, 42]) {
      const players = NAMES.slice(0, n);
      const keepers = [players[0], players[0], players[1], players[1]];
      got.push(`${n}:${seed}:` + encode(Scheduler.generate(Object.assign({ players, keepers, periods: 4, history: [], squad: SQUAD, seed, locks: [] }, extra))));
    }
    assert.deepStrictEqual(got, GOLDEN_212, JSON.stringify(extra));
    // met seizoenshistorie (seizoensbalans + P1-regel)
    const out = []; const history = [];
    for (let m = 0; m < 4; m++) {
      const players = NAMES.slice(0, 8 - (m % 2));
      const keepers = [players[m], players[m], players[m + 1], players[m + 1]];
      const r = Scheduler.generate(Object.assign({ players, keepers, periods: 4, history: history.slice(), squad: SQUAD, seed: 100 + m, locks: [] }, extra));
      out.push(encode(r));
      history.push({ id: m + 1, datum: `2026-09-0${m + 1}`, periodes: r.periodes });
    }
    assert.deepStrictEqual(out, GOLDEN_212_SEASON, JSON.stringify(extra));
  }
});

test('formatie: Config.FORMATIONS, formationById/formationId en formationFor(n, base)', () => {
  assert.deepStrictEqual(Config.FORMATIONS.map(f => f.id), ['2-1-2', '2-2-1']);
  assert.strictEqual(Config.DEFAULT_FORMATION, '2-1-2');
  assert.deepStrictEqual(F221, { K: 1, V: 2, M: 2, S: 1 });
  assert.deepStrictEqual(Config.formationById('onzin'), F212);
  assert.deepStrictEqual(Config.formationById('3-1-1'), { K: 1, V: 3, M: 1, S: 1 });   // generiek
  assert.strictEqual(Config.formationId(F221), '2-2-1');
  // minder spelers: grootste linie eerst, aanval eerst bij gelijkstand
  assert.deepStrictEqual(Config.formationFor(5, F221), { K: 1, V: 2, M: 1, S: 1 });
  assert.deepStrictEqual(Config.formationFor(4, F221), { K: 1, V: 1, M: 1, S: 1 });
  assert.deepStrictEqual(Config.formationFor(9, F221), F221);
  for (let n = 1; n <= 12; n++) assert.deepStrictEqual(Scheduler.formationFor(n, F221), Config.formationFor(n, F221));
  // oude vaste regel blijft gelden voor 2-1-2 (4..12 spelers)
  assert.deepStrictEqual(Config.formationFor(5), { K: 1, V: 2, M: 1, S: 1 });
  assert.deepStrictEqual(Config.formationFor(4), { K: 1, V: 1, M: 1, S: 1 });
});

test('formatie 2-2-1: harde regels over veel seeds en 4..10 spelers', () => {
  for (let n = 4; n <= 10; n++) {
    for (let seed = 1; seed <= 10; seed++) {
      const players = NAMES.slice(0, n);
      const keepers = seed % 2 ? Array(4).fill(players[seed % n]) : [0, 0, 1, 1].map(h => players[(seed + h * 3) % n]);
      const res = Scheduler.generate({ players, keepers, periods: 4, history: [], squad: SQUAD, seed, locks: [], formation: F221 });
      assert.deepStrictEqual(hardViolations(res, players, keepers, [], F221), [], `n=${n} seed=${seed}`);
      if (n >= 6) res.periodes.forEach(per => {
        const vals = Object.values(per.posities);
        assert.strictEqual(vals.filter(c => c === 'M').length, 2);
        assert.strictEqual(vals.filter(c => c === 'S').length, 1);
      });
    }
  }
});

test('formatie 2-2-1: locks, 2 en 3 periodes, met historie', () => {
  const players = NAMES.slice(0, 8);
  const hist = makeHistory(3, players, (m, p) => [players[(m + p) % 8], players[(m + p + 4) % 8]]);
  const locks = [{ period: 0, player: 'Bram', code: 'M' }, { period: 1, player: 'Coen', code: 'S' }, { period: 2, player: 'Izzy', code: 'W' }];
  const res = Scheduler.generate({ players, keepers: ['Noud', 'Noud', 'James', 'James'], periods: 4, history: hist, squad: SQUAD, seed: 3, locks, formation: F221 });
  assert.deepStrictEqual(hardViolations(res, players, ['Noud', 'Noud', 'James', 'James'], locks, F221), []);
  for (const P of [2, 3]) {
    const keepers = Array(P).fill('Noud');
    const r = Scheduler.generate({ players, keepers, periods: P, history: hist, squad: SQUAD, seed: 5, formation: F221 });
    assert.strictEqual(r.periodes.length, P);
    assert.deepStrictEqual(hardViolations(r, players, keepers, [], F221), []);
  }
});

test('formatie 2-2-1: deterministisch per seed, anders dan 2-1-2', () => {
  const players = NAMES.slice(0, 8);
  const keepers = ['Noud', 'Noud', 'James', 'James'];
  const a = Scheduler.generate({ players, keepers, periods: 4, history: [], squad: SQUAD, seed: 11, formation: F221 });
  const b = Scheduler.generate({ players, keepers, periods: 4, history: [], squad: SQUAD, seed: 11, formation: Object.assign({}, F221) });
  assert.deepStrictEqual(a, b);
  const c = Scheduler.generate({ players, keepers, periods: 4, history: [], squad: SQUAD, seed: 11 });
  assert.notDeepStrictEqual(a.periodes, c.periodes);
  // evaluate met de juiste formatie: geen formatiewaarschuwingen; met de verkeerde wel
  const ok = Scheduler.evaluate(a.periodes, { players, keepers, history: [], squad: SQUAD, formation: F221 });
  assert.ok(!ok.warnings.some(w => w.startsWith('Formatie')), ok.warnings.join('\n'));
  const wrong = Scheduler.evaluate(a.periodes, { players, keepers, history: [], squad: SQUAD });
  assert.ok(wrong.warnings.some(w => w.startsWith('Formatie periode 1 klopt niet')), wrong.warnings.join('\n'));
  assert.ok(a.fairness !== undefined && ok.score >= 70, `score ${ok.score}`);
});

test('formatie: seizoensbalans volgt de verhouding, max ~helft op dezelfde linie', () => {
  assert.deepStrictEqual(Scheduler._shareOf(F212), { V: 0.4, M: 0.2, S: 0.4 });
  assert.deepStrictEqual(Scheduler._shareOf(F221), { V: 0.4, M: 0.4, S: 0.2 });
  assert.deepStrictEqual([2, 3, 4, 5, 6].map(Scheduler._maxSameOf), [2, 2, 2, 3, 3]);
  // Bij 2-2-1 staat iedereen over 4 periodes hooguit 2× op dezelfde linie
  for (let seed = 1; seed <= 5; seed++) {
    const players = NAMES.slice(0, 8);
    const res = Scheduler.generate({ players, keepers: ['Noud', 'Noud', 'James', 'James'], periods: 4, history: [], squad: SQUAD, seed, formation: F221 });
    players.forEach(nm => {
      const col = column(res, nm);
      ['V', 'M', 'S'].forEach(c => assert.ok(col.filter(x => x === c).length <= 2, `seed=${seed} ${nm}: ${col}`));
    });
  }
  // Seizoen met veel middenveld voor Giulio → bij 2-2-1 (middenveld = 40%) krijgt hij minder M dan bij 2-1-2-quota zou
  const players = NAMES.slice(0, 6);
  const hist = makeHistory(5, players, () => [], (x, i, m, p) => (x === 'Giulio' ? 'M' : ['K', 'V', 'V', 'S', 'S'][(i + m + p) % 5]));
  for (let seed = 1; seed <= 4; seed++) {
    const res = Scheduler.generate({ players, keepers: ['Noud', 'Noud', 'James', 'James'], periods: 4, history: hist, squad: SQUAD, seed, formation: F221 });
    const col = column(res, 'Giulio');
    assert.ok(col.filter(c => c === 'M').length <= 1, `seed ${seed}: ${col}`);
  }
});

test('formatie: avoid blijft werken bij 2-2-1 (Bastiaan geen spits)', () => {
  const players = NAMES.slice(0, 8);
  for (let seed = 1; seed <= 6; seed++) {
    const res = Scheduler.generate({ players, keepers: ['Noud', 'Noud', 'James', 'James'], periods: 4, history: [], squad: SQUAD, seed, formation: F221 });
    assert.ok(!column(res, 'Bastiaan').includes('S'), `seed ${seed}`);
  }
});
