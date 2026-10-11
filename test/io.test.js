'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

require('../js/config.js');
require('../js/store.js');
const IO = require('../js/io.js');
const Config = globalThis.JO10.Config;
const SQUAD = Config.DEFAULT_SQUAD;
const HDR = ['Tijd', 'Keeper', 'Verd 1', 'Verd 2', 'Midden', 'Spits 1', 'Spits 2', 'Wissel 1', 'Wissel 2'];

function match(extra = {}) {
  return Object.assign({
    id: 1760000000000, titel: 'JO10 vs FC Stein (🏠 Thuis)', datum: '2025-10-11', tegenstander: 'FC Stein', thuisUit: 'thuis',
    score: null,
    periodes: [
      { posities: { Abel: 'K', Noud: 'V', Bram: 'V', Coen: 'M', James: 'S', Izzy: 'S' }, wissels: ['Giulio', 'Bastiaan'] },
      { posities: { Abel: 'K', Giulio: 'V', Bastiaan: 'V', Noud: 'M', Bram: 'S', Coen: 'S' }, wissels: ['James', 'Izzy'] },
      { posities: { Noud: 'K', James: 'V', Izzy: 'V', Giulio: 'M', Bastiaan: 'S', Abel: 'S' }, wissels: ['Bram', 'Coen'] },
      { posities: { Noud: 'K', Bram: 'V', Coen: 'V', James: 'M', Izzy: 'S', Giulio: 'S' }, wissels: ['Abel', 'Bastiaan'] },
    ],
  }, extra);
}

// ── parseRows ──────────────────────────────────────────────────────────────
test('parseRows: v1-formaat met "Wedstrijd"-blokken, aliassen, hoofdletterongevoelig', () => {
  const rows = [
    ['Wedstrijd 1 - VV Geleen'],
    HDR,
    ['0-12.5', 'abel', 'NOUD', 'Bram', 'Coen', 'jms', 'Izzy', 'bas', 'Giulio'],
    ['12.5-25', 'Abel', 'Giulio', 'Bas', 'Noud', 'Bram', 'Coen', 'James', 'Izzy'],
    [],
    ['Wedstrijd 2'],
    HDR,
    ['0-12.5', 'Coen', 'Noud', 'Bram', 'Abel', 'James', 'Izzy', 'Pietje', ''],
  ];
  const { matches, warnings } = IO.parseRows(rows, SQUAD, { now: 100 });
  assert.equal(matches.length, 2);
  const [a, b] = matches;
  assert.equal(a.id, 100);
  assert.equal(b.id, 101);
  assert.equal(a.titel, 'Wedstrijd 1 - VV Geleen');
  assert.equal(a.periodes.length, 2);
  assert.deepEqual(a.periodes[0].posities, { Abel: 'K', Noud: 'V', Bram: 'V', Coen: 'M', James: 'S', Izzy: 'S' });
  assert.deepEqual(a.periodes[0].wissels, ['Bastiaan', 'Giulio']);
  assert.ok(!('Bastiaan' in a.periodes[0].posities), 'wissels staan niet in posities');
  assert.deepEqual(a.keepers, ['Abel', 'Abel']);
  assert.equal(a.aanwezig.length, 8);
  assert.equal(a.score, null);
  assert.equal(a.datum, '');
  assert.deepEqual(b.periodes[0].wissels, ['Pietje']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Onbekende naam "Pietje"/);
});

test('parseRows: Wedstrijd-titel zonder kopregel en v1-titel met datum in kolom 2', () => {
  const rows = [
    ['Wedstrijd 3'],
    ['0-12.5', 'Abel', 'Noud', 'Bram', 'Coen', 'James', 'Izzy', 'Bastiaan', 'Giulio'],
    [],
    ['JO10 vs RKVV Born (✈️ Uit)', '04-10-2025'],
    HDR,
    ['0-12.5', 'Abel', 'Noud', 'Bram', 'Coen', 'James', 'Izzy', 'Bastiaan', 'Giulio'],
  ];
  const { matches } = IO.parseRows(rows, SQUAD);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].periodes.length, 1);
  assert.equal(matches[1].tegenstander, 'RKVV Born');
  assert.equal(matches[1].thuisUit, 'uit');
  assert.equal(matches[1].datum, '2025-10-04');
});

test('parseRows: datums als Excel-serienummer of Date, lege cellen en streepjes', () => {
  const rows = [
    ['JO10 vs A (🏠 Thuis)', 45941],
    HDR,
    ['0-12.5', 'Abel', '—', '', 'Coen', 'James', null, '-', ''],
  ];
  const { matches, warnings } = IO.parseRows(rows, SQUAD);
  assert.equal(matches[0].datum, '2025-10-11');
  assert.deepEqual(matches[0].periodes[0].posities, { Abel: 'K', Coen: 'M', James: 'S' });
  assert.deepEqual(matches[0].periodes[0].wissels, []);
  assert.deepEqual(warnings, []);
  assert.equal(IO.parseDate(new Date(2025, 9, 11)), '2025-10-11');
  assert.equal(IO.parseDate('2025-10-11'), '2025-10-11');
  assert.equal(IO.parseDate('11/10/25'), '2025-10-11');
  assert.equal(IO.parseDate('Uitslag 3-2'), '');
});

test('parseRows: eigen squad met extra spelers/aliassen', () => {
  const squad = { players: [{ name: 'Sem', aliases: ['semmie'] }, { name: 'Abel' }] };
  const { matches, warnings } = IO.parseRows([['Wedstrijd x'], HDR, ['', 'SEMMIE', 'abel']], squad);
  assert.deepEqual(matches[0].periodes[0].posities, { Sem: 'K', Abel: 'V' });
  assert.deepEqual(warnings, []);
});

test('parseRows: lege of rommel-invoer', () => {
  assert.deepEqual(IO.parseRows([], SQUAD).matches, []);
  assert.deepEqual(IO.parseRows(null, SQUAD).matches, []);
  const r = IO.parseRows([['iets'], ['nog iets', 1, 2]], SQUAD);
  assert.deepEqual(r.matches, []);
});

// ── export → import round-trip ─────────────────────────────────────────────
test('buildSchemaRows heeft v1-kolommen en is weer te importeren (round-trip)', () => {
  const m1 = match();
  const m2 = match({ id: 5, datum: '2025-09-20', tegenstander: 'VV Geleen', thuisUit: 'uit', titel: 'JO10 vs VV Geleen (✈️ Uit)', score: { home: 3, away: 2 } });
  const rows = IO.buildSchemaRows([m1, m2], { settings: { minutes: 50 } });
  // gesorteerd op datum: m2 eerst
  assert.deepEqual(rows[0], ['JO10 vs VV Geleen (✈️ Uit)', '20-09-2025', 'Uitslag 3-2']);
  assert.deepEqual(rows[1], HDR);
  assert.deepEqual(rows[2], ['0-12.5', 'Abel', 'Noud', 'Bram', 'Coen', 'James', 'Izzy', 'Giulio', 'Bastiaan']);
  assert.equal(rows[5][0], '37.5-50');
  assert.deepEqual(rows[6], []);

  const { matches, warnings } = IO.parseRows(rows, SQUAD);
  assert.deepEqual(warnings, []);
  assert.equal(matches.length, 2);
  const [b, a] = matches;
  assert.equal(b.tegenstander, 'VV Geleen');
  assert.equal(b.thuisUit, 'uit');
  assert.equal(b.datum, '2025-09-20');
  assert.deepEqual(b.score, { home: 3, away: 2 });
  assert.equal(a.titel, 'JO10 vs FC Stein (🏠 Thuis)');
  assert.equal(a.datum, '2025-10-11');
  assert.equal(a.score, null);
  assert.deepEqual(a.periodes, m1.periodes);
  assert.deepEqual(a.keepers, ['Abel', 'Abel', 'Noud', 'Noud']);
});

test('buildSchemaRows: extra wisselkolommen bij meer dan 2 wissels, legacy subs', () => {
  const m = {
    id: 1, datum: '2025-10-01', titel: 'Wedstrijd 1',
    periodes: [{ posities: { Abel: 'K' }, subs: ['A', 'B', 'C'] }, { posities: { Bram: 'K' } }],
  };
  const rows = IO.buildSchemaRows([m], {});
  assert.deepEqual(rows[1], [...HDR, 'Wissel 3']);
  assert.deepEqual(rows[2].slice(7), ['A', 'B', 'C']);
  assert.equal(rows[2][0], '0-25');
  const back = IO.parseRows(rows, { players: [{ name: 'Abel' }, { name: 'Bram' }, { name: 'A' }, { name: 'B' }, { name: 'C' }] });
  assert.deepEqual(back.matches[0].periodes[0].wissels, ['A', 'B', 'C']);
});

test('buildSeasonRows: totalen per speler', () => {
  const rows = IO.buildSeasonRows([match(), match({ id: 2, datum: '2025-10-18' })]);
  assert.deepEqual(rows[0], ['Speler', 'Wedstrijden', 'Periodes', 'K', 'V', 'M', 'S', 'W', 'Veld %']);
  const abel = rows.find(r => r[0] === 'Abel');
  assert.deepEqual(abel, ['Abel', 2, 8, 4, 0, 0, 2, 2, 75]);
  assert.equal(rows.length, 9);
  assert.deepEqual(rows.slice(1).map(r => r[0]), ['Abel', 'Bastiaan', 'Bram', 'Coen', 'Giulio', 'Izzy', 'James', 'Noud']);
});

// ── exportExcel / importExcel met nep-SheetJS ──────────────────────────────
function fakeXLSX() {
  const calls = { written: null, filename: null };
  const X = {
    utils: {
      book_new: () => ({ SheetNames: [], Sheets: {} }),
      aoa_to_sheet: aoa => ({ __aoa: JSON.parse(JSON.stringify(aoa)) }),
      book_append_sheet: (wb, ws, name) => { wb.SheetNames.push(name); wb.Sheets[name] = ws; },
      sheet_to_json: (ws, opts) => { assert.equal(opts.header, 1); return ws.__aoa; },
    },
    writeFile: (wb, filename) => { calls.written = wb; calls.filename = filename; },
    write: () => 'b64',
    read: (data, opts) => { assert.equal(opts.type, 'array'); assert.ok(data instanceof Uint8Array); return X.__nextBook; },
    calls,
  };
  return X;
}

test('exportExcel: sheets Schema + Seizoen, bestandsnaam, writeFile', () => {
  const X = fakeXLSX();
  IO._setEnv({ XLSX: X, location: { protocol: 'https:', href: 'https://x' } });
  try {
    IO.exportExcel([match()], { settings: { minutes: 50 } });
    assert.deepEqual(X.calls.written.SheetNames, ['Schema', 'Seizoen']);
    assert.equal(X.calls.filename, 'JO10_Wisselschema_11-10-2025.xlsx');
    assert.deepEqual(X.calls.written.Sheets.Schema.__aoa[1], HDR);
    assert.equal(X.calls.written.Sheets.Seizoen.__aoa.length, 9);
    assert.ok(Array.isArray(X.calls.written.Sheets.Schema['!cols']));
    IO.exportExcel([match(), match({ id: 3 })], {});
    assert.match(X.calls.filename, /^JO10_Wisselschema_\d{2}-\d{2}-\d{4}\.xlsx$/);
  } finally { IO._resetEnv(); }
});

test('exportExcel zonder SheetJS geeft duidelijke fout', () => {
  IO._setEnv({ XLSX: undefined });
  try { assert.throws(() => IO.exportExcel([match()], {}), /Excel/); } finally { IO._resetEnv(); }
});

test('importExcel: leest eerste/Schema-sheet via XLSX en geeft matches + warnings', async () => {
  const X = fakeXLSX();
  const rows = IO.buildSchemaRows([match()], {});
  X.__nextBook = { SheetNames: ['Seizoen', 'Schema'], Sheets: { Seizoen: { __aoa: [['Speler']] }, Schema: { __aoa: rows } } };
  IO._setEnv({ XLSX: X });
  try {
    const file = { name: 'x.xlsx', arrayBuffer: async () => new ArrayBuffer(4) };
    const res = await IO.importExcel(file, SQUAD);
    assert.equal(res.matches.length, 1);
    assert.equal(res.matches[0].tegenstander, 'FC Stein');
    assert.deepEqual(res.warnings, []);

    X.__nextBook = { SheetNames: ['Blad1'], Sheets: { Blad1: { __aoa: [['niks']] } } };
    const empty = await IO.importExcel(file, SQUAD);
    assert.equal(empty.matches.length, 0);
    assert.ok(empty.warnings.length >= 1);
  } finally { IO._resetEnv(); }
  IO._setEnv({ XLSX: undefined });
  try { await assert.rejects(IO.importExcel({ arrayBuffer: async () => new ArrayBuffer(1) }, SQUAD), /Excel/); }
  finally { IO._resetEnv(); }
});

// ── WhatsApp ───────────────────────────────────────────────────────────────
test('whatsappText: exacte opmaak', () => {
  const m = match();
  m.periodes = m.periodes.slice(0, 2);
  const txt = IO.whatsappText(m, { settings: { minutes: 50, periods: 2 } });
  assert.equal(txt, [
    '⚽ JO10 – FC Stein (🏠 thuis) za 11-10',
    '',
    '*Periode 1* (0–25 min)',
    '🧤 Abel',
    '🛡️ Noud, Bram',
    '⚙️ Coen',
    '⚡ James, Izzy',
    '🪑 Giulio, Bastiaan',
    '',
    '*Periode 2* (25–50 min)',
    '🧤 Abel',
    '🛡️ Giulio, Bastiaan',
    '⚙️ Noud',
    '⚡ Bram, Coen',
    '🪑 James, Izzy',
  ].join('\n'));
});

test('whatsappText: 4 periodes, uit, score en doelpuntenmakers; legacy zonder datum', () => {
  const m = match({ thuisUit: 'uit', datum: '2025-10-12', score: { home: 3, away: 1 },
    goals: [{ team: 'home', by: 'Noud' }, { team: 'home', by: 'Noud' }, { team: 'away' }, { team: 'home', by: 'Izzy' }] });
  const txt = IO.whatsappText(m, { settings: { minutes: 50 } });
  assert.ok(txt.startsWith('⚽ JO10 – FC Stein (✈️ uit) zo 12-10\n\n*Periode 1* (0–12,5 min)\n'));
  assert.ok(txt.includes('*Periode 4* (37,5–50 min)'));
  assert.ok(txt.endsWith('🏁 Uitslag: JO10 3–1 FC Stein\n⚽ Noud 2x, Izzy'));

  const legacy = { id: 1, titel: 'Wedstrijd 3', periodes: [{ posities: { Abel: 'K' }, subs: ['Noud'] }] };
  const t2 = IO.whatsappText(legacy, {});
  assert.equal(t2, '⚽ Wedstrijd 3\n\n*Periode 1* (0–50 min)\n🧤 Abel\n🪑 Noud');
});

// ── PNG ────────────────────────────────────────────────────────────────────
test('pngLayout: 4 periodes → 2x2 raster, formatie S boven M boven V boven K, binnen het veld', () => {
  const L = IO.pngLayout(match(), { settings: { minutes: 50 } });
  assert.equal(L.cols, 2);
  assert.equal(L.rows, 2);
  assert.equal(L.scale, 2);
  assert.equal(L.cells.length, 4);
  assert.ok(L.width <= 440, 'smal genoeg voor telefoon');
  assert.equal(L.header.title, 'JO10 vs FC Stein');
  assert.equal(L.header.subtitle, '🏠 Thuis  ·  za 11 okt 2025');
  assert.equal(L.header.score, null);
  L.cells.forEach((c, i) => {
    assert.equal(c.title, `Periode ${i + 1}`);
    assert.equal(c.chips.length, 6);
    const y = code => c.chips.filter(ch => ch.code === code).map(ch => ch.cy);
    assert.ok(Math.max(...y('S')) < y('M')[0]);
    assert.ok(y('M')[0] < Math.min(...y('V')));
    assert.ok(Math.max(...y('V')) < y('K')[0]);
    c.chips.forEach(ch => {
      assert.ok(ch.cx - ch.maxW / 2 >= c.pitch.x - 0.01 && ch.cx + ch.maxW / 2 <= c.pitch.x + c.pitch.w + 0.01, 'chip binnen veld');
      assert.ok(ch.cy - ch.h / 2 >= c.pitch.y && ch.cy + ch.h / 2 <= c.pitch.y + c.pitch.h);
    });
    assert.equal(c.wissels.length, 2);
    c.wissels.forEach(w => assert.ok(w.cy > c.pitch.y + c.pitch.h && w.cy < c.y + c.h));
    assert.ok(c.x + c.w <= L.width && c.y + c.h <= L.height);
  });
  assert.equal(L.cells[0].time, '0–12,5 min');
  // cellen overlappen niet
  assert.ok(L.cells[1].x >= L.cells[0].x + L.cells[0].w);
  assert.ok(L.cells[2].y >= L.cells[0].y + L.cells[0].h);
});

test('pngLayout: 2 periodes naast elkaar, geen wissels, score in header, 5 spelers', () => {
  const m = { id: 1, datum: '2025-10-11', tegenstander: 'X', thuisUit: 'uit', score: { home: 1, away: 4 },
    periodes: [{ posities: { A: 'K', B: 'V', C: 'V', D: 'M', E: 'S' } }, { posities: { A: 'K' } }] };
  const L = IO.pngLayout(m, {});
  assert.equal(L.cols, 2);
  assert.equal(L.rows, 1);
  assert.equal(L.header.score, '1 – 4');
  assert.match(L.header.subtitle, /^✈️ Uit/);
  const s = L.cells[0].chips.find(c => c.code === 'S');
  assert.ok(Math.abs(s.cx - (L.cells[0].pitch.x + L.cells[0].pitch.w / 2)) < 0.01, 'enkele spits in het midden');
  assert.equal(L.cells[0].wissels.length, 0);
  assert.equal(IO.pngLayout({ periodes: [] }, {}).cells.length, 1);
});

function fakeCanvasEnv({ canShare }) {
  const ops = [];
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return s => ({ width: String(s).length * 7 });
      if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (k in t) return t[k];
      return (...a) => { ops.push([k, ...a]); };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const anchors = [];
  const canvas = {
    getContext: () => ctx,
    toBlob: cb => setTimeout(() => cb({ size: 123, type: 'image/png' }), 0),
    toDataURL: () => 'data:image/png;base64,xx',
  };
  const document = {
    createElement: tag => {
      if (tag === 'canvas') return canvas;
      const a = { click() { a.clicked = true; }, remove() {} };
      anchors.push(a);
      return a;
    },
    body: { appendChild() {} },
  };
  const shared = [];
  const navigator = {
    canShare: () => canShare,
    share: async d => { shared.push(d); },
  };
  class File { constructor(parts, name, o) { this.parts = parts; this.name = name; this.type = o.type; } }
  const URL = { createObjectURL: () => 'blob:1', revokeObjectURL() {} };
  return { env: { document, navigator, File, URL, location: { protocol: 'https:', href: 'https://x' } }, ops, canvas, anchors, shared };
}

test('exportPNG: deelblad via navigator.share als canShare', async () => {
  const f = fakeCanvasEnv({ canShare: true });
  IO._setEnv(f.env);
  try {
    await IO.exportPNG(match(), { settings: { minutes: 50 } });
    assert.equal(f.shared.length, 1);
    assert.equal(f.shared[0].files[0].name, 'JO10_FC_Stein_11-10-2025.png');
    assert.equal(f.shared[0].files[0].type, 'image/png');
    assert.equal(f.anchors.length, 0);
    const L = IO.pngLayout(match(), {});
    assert.equal(f.canvas.width, L.width * 2);
    assert.equal(f.canvas.height, L.height * 2);
    const texts = f.ops.filter(o => o[0] === 'fillText').map(o => o[1]);
    assert.ok(texts.includes('JO10 vs FC Stein'));
    assert.ok(texts.includes('Periode 4'));
    assert.ok(texts.includes('Bastiaan'));
    assert.ok(texts.includes('Giulio'));
    assert.ok(texts.includes('🪑 WISSELS'));
    assert.ok(f.ops.some(o => o[0] === 'scale' && o[1] === 2));
  } finally { IO._resetEnv(); }
});

test('exportPNG: download-link als delen niet kan; annuleren van delen is geen fout', async () => {
  const f = fakeCanvasEnv({ canShare: false });
  IO._setEnv(f.env);
  try {
    await IO.exportPNG(match(), {});
    assert.equal(f.anchors.length, 1);
    assert.equal(f.anchors[0].clicked, true);
    assert.equal(f.anchors[0].download, 'JO10_FC_Stein_11-10-2025.png');
  } finally { IO._resetEnv(); }

  const g = fakeCanvasEnv({ canShare: true });
  g.env.navigator.share = async () => { const e = new Error('cancel'); e.name = 'AbortError'; throw e; };
  IO._setEnv(g.env);
  try {
    await IO.exportPNG(match(), {});
    assert.equal(g.anchors.length, 0, 'annuleren → geen download');
  } finally { IO._resetEnv(); }

  const h = fakeCanvasEnv({ canShare: true });
  h.env.navigator.share = async () => { const e = new Error('no gesture'); e.name = 'NotAllowedError'; throw e; };
  IO._setEnv(h.env);
  try {
    await IO.exportPNG(match(), {});
    assert.equal(h.anchors.length, 1, 'andere fout → terugvallen op download');
    assert.equal(h.anchors[0].clicked, true);
  } finally { IO._resetEnv(); }
});

test('lange namen worden ingekort binnen de chip', () => {
  const f = fakeCanvasEnv({ canShare: true });
  const m = match();
  m.periodes = [{ posities: { 'Maximiliaan-Alexander van den Berg': 'M', A: 'K' }, wissels: [] }];
  const L = IO.pngLayout(m, {});
  const ctx = f.canvas.getContext();
  IO._drawLayout(ctx, L);
  const t = f.ops.filter(o => o[0] === 'fillText').map(o => o[1]).find(s => s.startsWith('Maxi'));
  assert.ok(t.endsWith('…'));
  assert.ok(t.length * 7 <= L.cells[0].chips[0].maxW);
});
