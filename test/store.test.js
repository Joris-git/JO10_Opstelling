'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

require('../js/config.js');
const Store = require('../js/store.js');
const Config = globalThis.JO10.Config;

const unhandled = [];
process.on('unhandledRejection', e => unhandled.push(e));

// ── fakes ───────────────────────────────────────────────────────────────────
function fakeLS(init) {
  const data = Object.assign({}, init || {});
  return {
    data,
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
  };
}

const clone = v => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
// Firebase-semantiek: lege arrays/objecten en null-velden worden niet opgeslagen; [] → null.
function fbNorm(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) {
    const a = v.map(fbNorm);
    while (a.length && a[a.length - 1] === null) a.pop();
    return a.length ? a : null;
  }
  if (typeof v === 'object') {
    const o = {};
    Object.keys(v).forEach(k => { const x = fbNorm(v[k]); if (x !== null) o[k] = x; });
    return Object.keys(o).length ? o : null;
  }
  return v;
}

function permErr(path) {
  const e = new Error(`permission_denied at /${path}: Client doesn't have permission to access the desired data.`);
  e.code = 'PERMISSION_DENIED';
  return e;
}

function makeFakeFirebase(opts = {}) {
  const server = {};
  Object.keys(opts.initial || {}).forEach(k => { server[k] = fbNorm(clone(opts.initial[k])); });
  const deny = new Set(opts.deny || []);
  const listeners = {};    // path -> [{cb, err}]
  const cache = {};        // wat deze client laatst zag (voor de eerste transactie-gok)
  let connected = opts.connected !== false;
  const queue = [];        // schrijfacties terwijl offline
  const hooks = { beforeCommit: null };
  const log = { transactions: 0, txAttempts: 0, sets: [] };
  const snap = v => ({ val: () => clone(v) });
  const get = p => (p in server ? server[p] : null);

  function emit(path) {
    if (path === '.info/connected') {
      (listeners[path] || []).forEach(l => l.cb(snap(connected)));
      return;
    }
    if (!connected || deny.has(path)) return;
    cache[path] = clone(get(path));
    (listeners[path] || []).forEach(l => l.cb(snap(get(path))));
  }

  function whenOnline(fn) {
    if (connected) return Promise.resolve().then(fn);
    return new Promise((resolve, reject) => queue.push(() => Promise.resolve().then(fn).then(resolve, reject)));
  }

  function ref(path) {
    return {
      path,
      on(evt, cb, err) {
        (listeners[path] = listeners[path] || []).push({ cb, err });
        if (path === '.info/connected') { cb(snap(connected)); return cb; }
        queueMicrotask(() => {
          if (deny.has(path)) { if (err) err(permErr(path)); return; }
          if (connected) { cache[path] = clone(get(path)); cb(snap(get(path))); }
        });
        return cb;
      },
      off(evt, cb) {
        listeners[path] = (listeners[path] || []).filter(l => cb && l.cb !== cb);
      },
      set(v) {
        if (deny.has(path)) return Promise.reject(permErr(path));
        return whenOnline(() => { log.sets.push({ path, v: clone(v) }); server[path] = fbNorm(clone(v)); emit(path); });
      },
      transaction(fn) {
        log.transactions++;
        if (deny.has(path)) return Promise.reject(permErr(path));
        return whenOnline(() => {
          let current = path in cache ? clone(cache[path]) : null;
          for (let i = 0; i < 25; i++) {
            log.txAttempts++;
            const result = fn(clone(current));
            if (result === undefined) return { committed: false, snapshot: snap(get(path)) };
            if (hooks.beforeCommit) { const h = hooks.beforeCommit; hooks.beforeCommit = null; h(); }
            if (JSON.stringify(fbNorm(current)) === JSON.stringify(get(path))) {
              server[path] = fbNorm(clone(result));
              emit(path);
              return { committed: true, snapshot: snap(get(path)) };
            }
            current = clone(get(path));
          }
          throw new Error('maxretry');
        });
      },
    };
  }

  const fb = {
    apps: [],
    initializeApp(c) { fb.apps.push(c); return {}; },
    database() { return { ref }; },
    // test helpers
    server, hooks, log, cache,
    remoteWrite(path, v) { server[path] = fbNorm(clone(v)); emit(path); },
    setConnected(v) {
      connected = v;
      emit('.info/connected');
      if (v) {
        Object.keys(listeners).forEach(p => { if (p !== '.info/connected') emit(p); });
        queue.splice(0).forEach(f => f());
      }
    },
    emitStale(path, v) { (listeners[path] || []).forEach(l => l.cb(snap(fbNorm(clone(v))))); },
  };
  return fb;
}

const tick = () => new Promise(r => setTimeout(r, 0));
async function settle(n = 5) { for (let i = 0; i < n; i++) await tick(); }

let clock = 1000;
function setup(env = {}) {
  Store._reset();
  clock = 1_700_000_000_000;
  const ls = env.localStorage || fakeLS();
  Store._setEnv(Object.assign({ firebase: undefined, localStorage: ls, debounceMs: 0, now: () => ++clock }, env, { localStorage: ls }));
  return ls;
}

function mk(id, datum, extra = {}) {
  return Object.assign({
    id, titel: `JO10 vs Team${id} (🏠 Thuis)`, datum, tegenstander: `Team${id}`, thuisUit: 'thuis', score: null,
    periodes: [{ posities: { Abel: 'K', Noud: 'V', Bram: 'V', Coen: 'M', James: 'S', Izzy: 'S' }, wissels: ['Giulio', 'Bastiaan'] }],
  }, extra);
}

// ── normalizeMatch ──────────────────────────────────────────────────────────
test('normalizeMatch: legacy subs → wissels, score null, periodes [], numerieke strings, titel', () => {
  const raw = {
    id: '1700000000001', datum: '2025-09-14', titel: 'JO10 vs FC Stein (✈️ Uit)',
    periodes: [
      { posities: { Abel: 'K', Noud: 'v', Bram: 'Verdediger', Coen: 'M', Bas: 'W' }, subs: ['Giulio'], extraPeriodField: 7 },
    ],
    custom: { keep: true },
  };
  const m = Store.normalizeMatch(raw);
  assert.equal(m.id, 1700000000001);
  assert.equal(m.score, null);
  assert.equal(m.tegenstander, 'FC Stein');
  assert.equal(m.thuisUit, 'uit');
  assert.deepEqual(m.periodes[0].posities, { Abel: 'K', Noud: 'V', Bram: 'V', Coen: 'M' });
  assert.deepEqual(m.periodes[0].wissels, ['Bas', 'Giulio']);
  assert.equal(m.periodes[0].subs, undefined);
  assert.equal(m.periodes[0].extraPeriodField, 7);
  assert.deepEqual(m.custom, { keep: true });
  // raw niet gemuteerd
  assert.deepEqual(raw.periodes[0].subs, ['Giulio']);

  const bare = Store.normalizeMatch({ id: 5, tegenstander: 'VV Geleen', score: { home: '3', away: '1' } });
  assert.deepEqual(bare.periodes, []);
  assert.equal(bare.titel, 'JO10 vs VV Geleen (🏠 Thuis)');
  assert.deepEqual(bare.score, { home: 3, away: 1 });
  assert.equal(bare.datum, '');

  assert.equal(Store.normalizeMatch({ score: { home: 2 } }).score, null);
  assert.equal(Store.normalizeMatch({ datum: '12-10-2025' }).datum, '2025-10-12');
  assert.equal(Store.normalizeMatch(null).titel, 'JO10 vs Onbekend (🏠 Thuis)');
});

test('normalizeMatch is idempotent en behandelt Firebase-objecten als arrays', () => {
  const raw = {
    id: 3, datum: '2025-10-01', titel: 'x', periodes: { 0: { posities: { A: 'K' } }, 1: { wissels: { 0: 'B' } } },
    keepers: { 0: 'A', 2: 'C' }, goals: [{ team: 'away', minute: '12' }, { by: 'Noud' }], v: '2',
  };
  const a = Store.normalizeMatch(raw);
  assert.equal(a.periodes.length, 2);
  assert.deepEqual(a.periodes[1], { posities: {}, wissels: ['B'] });
  assert.deepEqual(a.keepers, ['A', null, 'C']);
  assert.deepEqual(a.goals, [{ team: 'away', minute: 12, by: null }, { team: 'home', minute: null, by: 'Noud' }]);
  assert.equal(a.v, 2);
  assert.deepEqual(Store.normalizeMatch(a), a);
});

test('applyOps: merge op id, onbekende records/velden blijven, array-vorm', () => {
  const remote = [{ id: 1, a: 1, futureField: 'x' }, 'rare-string-record', { noId: true }, null, { id: 2 }];
  const out = Store._applyOps(remote, { 1: 'put', 2: 'del', 9: 'put' }, { 1: { id: 1, a: 2 }, 9: { id: 9 } });
  assert.ok(Array.isArray(out));
  assert.deepEqual(out, [{ id: 1, a: 2, futureField: 'x' }, 'rare-string-record', { noId: true }, { id: 9 }]);
  assert.deepEqual(Store._applyOps({ 0: { id: 1 }, 1: { id: 2 } }, {}, {}), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(Store._applyOps(null, { 1: 'del' }, {}), []);
});

// ── lokaal / offline ───────────────────────────────────────────────────────
test('zonder firebase: status offline, opslaan/verwijderen lokaal, gesorteerd', async () => {
  const ls = setup();
  await Store.init({});
  assert.equal(Store.getStatus(), 'offline');
  await Store.saveMatch(mk(undefined, '2025-10-05', { id: undefined }));
  const b = await Store.saveMatch(mk(20, '2025-09-01'));
  await Store.saveMatch(mk(10, '2025-09-01'));
  const list = Store.getMatches();
  assert.deepEqual(list.map(m => m.datum), ['2025-09-01', '2025-09-01', '2025-10-05']);
  assert.deepEqual(list.slice(0, 2).map(m => m.id), [10, 20]);
  assert.equal(typeof list[2].id, 'number');
  assert.equal(b.v, 2);
  assert.ok(b.updatedAt > 0);
  const stored = JSON.parse(ls.data[Config.LS_MATCHES]);
  assert.ok(Array.isArray(stored));
  assert.equal(stored.length, 3);

  await Store.deleteMatch(20);
  assert.deepEqual(Store.getMatches().map(m => m.id).filter(id => id === 20), []);
  assert.equal(JSON.parse(ls.data[Config.LS_MATCHES]).length, 2);
});

test('saveMatch update behoudt onbekende velden en zet titel in v1-formaat', async () => {
  const ls = setup({ localStorage: fakeLS({ jo10_matches_v1: JSON.stringify([mk(1, '2025-09-01', { legacyX: 42 })]) }) });
  await Store.init({});
  const m = Store.getMatches()[0];
  m.tegenstander = 'FC Stein'; m.thuisUit = 'uit'; m.score = { home: 2, away: 2 };
  await Store.saveMatch(m);
  const stored = JSON.parse(ls.data[Config.LS_MATCHES]);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].legacyX, 42);
  assert.equal(stored[0].titel, 'JO10 vs FC Stein (✈️ Uit)');
  assert.deepEqual(stored[0].score, { home: 2, away: 2 });
});

test('firebase die faalt bij initialisatie → offline, alles werkt lokaal', async () => {
  setup({ firebase: { apps: [], initializeApp() { throw new Error('boom'); }, database() { throw new Error('x'); } } });
  await Store.init({});
  assert.equal(Store.getStatus(), 'offline');
  await Store.saveMatch(mk(1, '2025-09-01'));
  assert.equal(Store.getMatches().length, 1);
});

test('draft get/save/clear en activePlayers', async () => {
  const ls = setup();
  await Store.init({});
  assert.equal(Store.getDraft(), null);
  Store.saveDraft({ datum: '2025-10-01', tegenstander: 'X', aanwezig: ['Abel'] });
  assert.deepEqual(Store.getDraft().aanwezig, ['Abel']);
  assert.ok(ls.data[Config.LS_DRAFT]);
  Store.clearDraft();
  assert.equal(Store.getDraft(), null);
  assert.equal(Store.activePlayers().length, Config.DEFAULT_SQUAD.players.length);
  const sq = Store.getSquad();
  sq.players[0].active = false;
  await Store.saveSquad(sq);
  assert.ok(!Store.activePlayers().includes(sq.players[0].name));
  // getSquad geeft een kopie
  Store.getSquad().players.length = 0;
  assert.ok(Store.getSquad().players.length > 0);
});

// ── firebase sync ──────────────────────────────────────────────────────────
test('remote data komt binnen → onChange, cache bijgewerkt, geen dubbele onChange bij gelijke data', async () => {
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01'), mk(2, '2025-08-01', { subs: 'x' })] } });
  const ls = setup({ firebase: fb });
  const changes = [];
  const statuses = [];
  Store.onStatus(s => statuses.push(s));
  await Store.init({ onChange: c => changes.push(c) });
  await settle();
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].matches.map(m => m.id), [2, 1]);
  assert.equal(Store.getStatus(), 'synced');
  assert.ok(statuses.includes('syncing') && statuses.includes('synced'));
  assert.equal(JSON.parse(ls.data[Config.LS_MATCHES]).length, 2);
  assert.equal(fb.apps.length, 1);

  fb.remoteWrite('jo10_matches', fb.server.jo10_matches); // zelfde inhoud
  assert.equal(changes.length, 1);
  fb.remoteWrite('jo10_matches', [...fb.server.jo10_matches, mk(3, '2025-10-01')]);
  assert.equal(changes.length, 2);
  assert.equal(changes[1].matches.length, 3);
});

test('onChange wordt gedebounced', async () => {
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  setup({ firebase: fb, debounceMs: 10 });
  const changes = [];
  await Store.init({ onChange: c => changes.push(c) });
  await settle();
  fb.remoteWrite('jo10_matches', [mk(1, '2025-09-01'), mk(2, '2025-09-02')]);
  fb.remoteWrite('jo10_matches', [mk(1, '2025-09-01'), mk(2, '2025-09-02'), mk(3, '2025-09-03')]);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].matches.length, 3);
});

test('remote null (alles verwijderd op ander toestel) wordt verwerkt (v1-bug)', async () => {
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  const ls = setup({ firebase: fb });
  const changes = [];
  await Store.init({ onChange: c => changes.push(c) });
  await settle();
  assert.equal(Store.getMatches().length, 1);
  fb.remoteWrite('jo10_matches', null);
  assert.equal(Store.getMatches().length, 0);
  assert.equal(changes.at(-1).matches.length, 0);
  assert.deepEqual(JSON.parse(ls.data[Config.LS_MATCHES]), []);
  assert.equal(fb.log.transactions, 0, 'niets terugschrijven');
});

test('lokale cache met records die al op de server stonden maar daar weg zijn → verdwijnen bij eerste snapshot', async () => {
  const ls = fakeLS({
    jo10_matches_v1: JSON.stringify([mk(1, '2025-09-01'), mk(2, '2025-09-02')]),
  });
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  setup({ firebase: fb, localStorage: ls });
  const p = Store.init({});
  assert.equal(Store.getMatches().length, 2, 'cache direct beschikbaar');
  await p;
  await settle();
  assert.deepEqual(Store.getMatches().map(m => m.id), [1]);
  assert.equal(fb.log.transactions, 0);
});

test('saveMatch: transactie merged met gelijktijdige schrijfactie van ander toestel', async () => {
  const other = mk(1, '2025-09-01', { v1OnlyField: 'bewaren', periodes: [{ posities: { Abel: 'K' }, wissels: ['Noud'], x: 1 }] });
  const fb = makeFakeFirebase({ initial: { jo10_matches: [other] } });
  setup({ firebase: fb });
  await Store.init({});
  await settle();
  // tijdens onze transactie voegt een ander toestel (v1, met set()) wedstrijd 2 toe
  fb.hooks.beforeCommit = () => { fb.server.jo10_matches = fbNorm([other, mk(2, '2025-09-08', { byOther: true })]); };
  const saved = await Store.saveMatch(mk(3, '2025-09-15', { notitie: 'nieuw' }));
  await settle();
  const remote = fb.server.jo10_matches;
  assert.ok(Array.isArray(remote));
  assert.deepEqual(remote.map(r => r.id), [1, 2, 3]);
  assert.equal(remote[0].v1OnlyField, 'bewaren');
  assert.equal(remote[0].periodes[0].x, 1);
  assert.equal(remote[1].byOther, true);
  assert.equal(remote[2].notitie, 'nieuw');
  assert.equal(saved.id, 3);
  assert.ok(fb.log.txAttempts >= 2, 'transactie is opnieuw gedraaid');
  assert.deepEqual(Store.getMatches().map(m => m.id), [1, 2, 3]);
  assert.equal(Store.getStatus(), 'synced');
  assert.deepEqual(Store._state().meta.ops, {});
});

test('saveMatch update van bestaande remote record behoudt onbekende remote velden', async () => {
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01', { remoteOnly: 'x' })] } });
  setup({ firebase: fb });
  await Store.init({});
  await settle();
  const m = Store.getMatches()[0];
  delete m.remoteOnly;               // ook als de app het veld niet meestuurt
  m.score = { home: 4, away: 0 };
  await Store.saveMatch(m);
  assert.equal(fb.server.jo10_matches[0].remoteOnly, 'x');
  assert.deepEqual(fb.server.jo10_matches[0].score, { home: 4, away: 0 });
  assert.equal(fb.server.jo10_matches.length, 1);
});

test('deleteMatch: merge, echo herstelt record niet, laatste verwijderen → null', async () => {
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01'), mk(2, '2025-09-02')] } });
  setup({ firebase: fb });
  const changes = [];
  await Store.init({ onChange: c => changes.push(c) });
  await settle();

  // offline verwijderen; een verouderde snapshot (met record 1) mag het niet terugbrengen
  fb.setConnected(false);
  await Store.deleteMatch(1);
  assert.equal(Store.getStatus(), 'offline');
  fb.emitStale('jo10_matches', [mk(1, '2025-09-01'), mk(2, '2025-09-02')]);
  assert.deepEqual(Store.getMatches().map(m => m.id), [2]);
  assert.equal(fb.server.jo10_matches.length, 2);

  fb.setConnected(true);
  await settle(10);
  assert.deepEqual(fb.server.jo10_matches.map(m => m.id), [2]);
  assert.deepEqual(Store.getMatches().map(m => m.id), [2]);
  assert.equal(Store.getStatus(), 'synced');

  await Store.deleteMatch(2);
  await settle();
  assert.equal(fb.server.jo10_matches, null);
  assert.deepEqual(Store.getMatches(), []);
  assert.deepEqual(Store._state().meta.ops, {});
});

test('deleteMatch tijdens gelijktijdige toevoeging op ander toestel: niets anders gaat verloren', async () => {
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  setup({ firebase: fb });
  await Store.init({});
  await settle();
  fb.hooks.beforeCommit = () => { fb.server.jo10_matches = fbNorm([mk(1, '2025-09-01'), mk(2, '2025-09-02')]); };
  await Store.deleteMatch(1);
  await settle();
  assert.deepEqual(fb.server.jo10_matches.map(m => m.id), [2], 'geen null geschreven terwijl er nog data was');
  assert.deepEqual(Store.getMatches().map(m => m.id), [2]);
});

test('snel achter elkaar opslaan (tweede tijdens lopende transactie) → beide op server, geen open ops', async () => {
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  setup({ firebase: fb });
  await Store.init({});
  await settle();
  const p1 = Store.saveMatch(mk(2, '2025-09-02'));
  const m2 = mk(2, '2025-09-02', { notitie: 'tweede versie' });
  const p2 = Store.saveMatch(m2);
  const p3 = Store.saveMatch(mk(3, '2025-09-03'));
  await Promise.all([p1, p2, p3]);
  await settle(10);
  assert.deepEqual(fb.server.jo10_matches.map(m => m.id), [1, 2, 3]);
  assert.equal(fb.server.jo10_matches[1].notitie, 'tweede versie');
  assert.deepEqual(Store._state().meta.ops, {});
  assert.equal(Store.getStatus(), 'synced');
});

test('offline opslaan, daarna herverbinden → lokale staat wordt gesynchroniseerd', async () => {
  const fb = makeFakeFirebase({ connected: false, initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  setup({ firebase: fb });
  const statuses = [];
  Store.onStatus(s => statuses.push(s));
  await Store.init({});
  await settle();
  assert.equal(Store.getStatus(), 'offline');
  const saved = await Store.saveMatch(mk(2, '2025-09-08'));   // mag niet blijven hangen
  assert.equal(saved.id, 2);
  assert.deepEqual(fb.server.jo10_matches.map(m => m.id), [1]);

  fb.setConnected(true);
  await settle(10);
  assert.deepEqual(fb.server.jo10_matches.map(m => m.id), [1, 2]);
  assert.deepEqual(Store.getMatches().map(m => m.id), [1, 2]);
  assert.equal(Store.getStatus(), 'synced');
  assert.ok(statuses.includes('offline') && statuses.includes('synced'));
});

test('openstaande wijzigingen overleven herladen (offline sessie → nieuwe sessie online)', async () => {
  const ls = fakeLS();
  // sessie 1: geen firebase (CDN niet geladen)
  setup({ localStorage: ls });
  await Store.init({});
  await Store.saveMatch(mk(7, '2025-09-07'));
  // sessie 2: online, server heeft al iets anders
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  Store._setEnv({ firebase: fb });
  await Store.init({});
  await settle(10);
  assert.deepEqual(fb.server.jo10_matches.map(m => m.id), [1, 7]);
  assert.deepEqual(Store.getMatches().map(m => m.id), [1, 7]);
});

test('record dat v1 offline in de gedeelde cache zette (nooit op server) wordt alsnog gepusht', async () => {
  const ls = fakeLS();
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  setup({ firebase: fb, localStorage: ls });
  await Store.init({});
  await settle();
  Store._reset();
  // v1 schrijft offline een nieuwe wedstrijd in jo10_matches_v1
  const cache = JSON.parse(ls.data[Config.LS_MATCHES]);
  cache.push(mk(5, '2025-09-05', { fromV1: true }));
  ls.setItem(Config.LS_MATCHES, JSON.stringify(cache));
  Store._setEnv({ firebase: fb, localStorage: ls, debounceMs: 0 });
  await Store.init({});
  await settle(10);
  assert.deepEqual(fb.server.jo10_matches.map(m => m.id), [1, 5]);
  assert.equal(fb.server.jo10_matches[1].fromV1, true);
});

test('nooit een lege array schrijven: opslaan bij lege remote geeft array met 1 record; object-vorm → array', async () => {
  const fb = makeFakeFirebase({ initial: {} });
  setup({ firebase: fb });
  await Store.init({});
  await settle();
  await Store.saveMatch(mk(1, '2025-09-01'));
  assert.ok(Array.isArray(fb.server.jo10_matches));
  assert.equal(fb.server.jo10_matches.length, 1);

  const fb2 = makeFakeFirebase({ initial: { jo10_matches: { 0: mk(1, '2025-09-01'), 1: mk(2, '2025-09-02') } } });
  setup({ firebase: fb2 });
  await Store.init({});
  await settle();
  assert.equal(Store.getMatches().length, 2);
  await Store.saveMatch(mk(3, '2025-09-03'));
  assert.ok(Array.isArray(fb2.server.jo10_matches));
  assert.deepEqual(fb2.server.jo10_matches.map(m => m.id), [1, 2, 3]);
});

test('onbekende records in de remote array blijven behouden bij opslaan', async () => {
  const fb = makeFakeFirebase({ initial: { jo10_matches: [{ titel: 'zonder id', periodes: [] }, mk(1, '2025-09-01')] } });
  setup({ firebase: fb });
  await Store.init({});
  await settle();
  await Store.saveMatch(mk(2, '2025-09-02'));
  assert.equal(fb.server.jo10_matches.length, 3);
  assert.equal(fb.server.jo10_matches[0].titel, 'zonder id');
});

test('jo10_matches niet leesbaar → status error, lokaal blijft werken', async () => {
  const fb = makeFakeFirebase({ deny: ['jo10_matches'], initial: {} });
  setup({ firebase: fb });
  await Store.init({});
  await settle();
  assert.equal(Store.getStatus(), 'error');
  await Store.saveMatch(mk(1, '2025-09-01'));
  assert.equal(Store.getMatches().length, 1);
  assert.equal(Store.getStatus(), 'error');
});

// ── squad ──────────────────────────────────────────────────────────────────
test('squad permission denied → stil terugvallen op localStorage/default, status niet error', async () => {
  unhandled.length = 0;
  const fb = makeFakeFirebase({ deny: ['jo10_squad'], initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  const ls = setup({ firebase: fb });
  await Store.init({});
  await settle();
  assert.deepEqual(Store.getSquad().players.map(p => p.name), Config.DEFAULT_SQUAD.players.map(p => p.name));
  const sq = Store.getSquad();
  sq.players.push({ name: 'Nieuw' });
  await Store.saveSquad(sq);
  await settle();
  assert.equal(Store.getStatus(), 'synced');
  assert.ok(Store.getSquad().players.some(p => p.name === 'Nieuw' && p.active === true && Array.isArray(p.avoid)));
  assert.ok(JSON.parse(ls.data[Config.LS_SQUAD]).players.some(p => p.name === 'Nieuw'));
  assert.equal(unhandled.length, 0);
  // na herladen: lokale kopie
  Store._setEnv({ firebase: fb, localStorage: ls });
  await Store.init({});
  await settle();
  assert.ok(Store.getSquad().players.some(p => p.name === 'Nieuw'));
});

test('squad set() permission denied (lezen mag wel) → geen unhandled rejection', async () => {
  unhandled.length = 0;
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  setup({ firebase: fb });
  await Store.init({});
  await settle();
  const origDb = fb.database;
  // maak alleen set() op jo10_squad geweigerd
  const db = origDb();
  const origRef = db.ref;
  fb.database = () => ({ ref: p => { const r = origRef(p); if (p === 'jo10_squad') r.set = () => Promise.reject(permErr(p)); return r; } });
  await Store.init({});
  await settle();
  await Store.saveSquad(Object.assign(Store.getSquad(), { settings: { periods: 4, minutes: 40 } }));
  await settle();
  assert.equal(Store.getSquad().settings.minutes, 40);
  assert.equal(Store._state().squadDenied, true);
  assert.notEqual(Store.getStatus(), 'error');
  assert.equal(unhandled.length, 0);
});

test('squad sync: opslaan schrijft jo10_squad, remote wijziging → onChange', async () => {
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  setup({ firebase: fb });
  const changes = [];
  await Store.init({ onChange: c => changes.push(c) });
  await settle();
  const sq = Store.getSquad();
  sq.players = sq.players.slice(0, 7);
  await Store.saveSquad(sq);
  await settle();
  assert.equal(fb.server.jo10_squad.players.length, 7);
  assert.equal(Store._state().meta.squadDirty, false);
  const n = changes.length;
  const remote = clone(fb.server.jo10_squad);
  remote.players.push({ name: 'Remote', active: true });
  fb.remoteWrite('jo10_squad', remote);
  assert.equal(changes.length, n + 1);
  assert.ok(changes.at(-1).squad.players.some(p => p.name === 'Remote' && Array.isArray(p.aliases)));
});

test('lokale squad wordt naar lege remote gezaaid', async () => {
  const ls = fakeLS({ jo10_squad_v2: JSON.stringify({ players: [{ name: 'A' }, { name: 'B', avoid: ['S', 'X'] }] }) });
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  setup({ firebase: fb, localStorage: ls });
  await Store.init({});
  await settle();
  assert.deepEqual(fb.server.jo10_squad.players.map(p => p.name), ['A', 'B']);
  assert.deepEqual(Store.getSquad().players[1].avoid, ['S']);
  assert.deepEqual(Store.getSquad().settings, { periods: 4, minutes: 50 });
});

test('onStatus: direct aanroepen met huidige status en afmelden', async () => {
  setup();
  const seen = [];
  const off = Store.onStatus(s => seen.push(s));
  await Store.init({});
  assert.deepEqual(seen, ['offline']);
  off();
  const fb = makeFakeFirebase({ initial: {} });
  Store._setEnv({ firebase: fb });
  await Store.init({});
  await settle();
  assert.deepEqual(seen, ['offline']);
});

// ── review-regressies (S1–S10) ─────────────────────────────────────────────
const ids = () => Store.getMatches().map(m => m.id);
const srvIds = fb => (fb.server.jo10_matches || []).filter(Boolean).map(m => m.id);

test('S1: v1 overschrijft gedeelde cache terwijl v2 een openstaande put heeft → match blijft bewaard en wordt gepusht', async () => {
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] }, connected: false });
  const ls = setup({ firebase: fb });
  await Store.init({}); await settle();
  await Store.saveMatch(mk(undefined, '2025-09-08', { id: undefined, tegenstander: 'NEW' }));
  const newId = ids().find(i => i !== 1);
  ls.setItem('jo10_matches_v1', JSON.stringify([mk(1, '2025-09-01')]));   // v1.html on('value')
  Store._reset();
  Store._setEnv({ firebase: fb, localStorage: ls, debounceMs: 0 });
  fb.setConnected(true);
  const p = Store.init({});
  assert.ok(ids().includes(newId), 'direct na laden teruggezet uit meta.pending');
  await p; await settle(10);
  assert.deepEqual(srvIds(fb), [1, newId]);
  assert.deepEqual(Store._state().meta.ops, {});
  assert.deepEqual(Store._state().meta.pending, {});
});

test('S7: quota-fout op jo10_matches_v1 → openstaande match overleeft herladen', async () => {
  const ls = fakeLS();
  const real = ls.setItem;
  let full = false;
  ls.setItem = (k, v) => { if (full && k === 'jo10_matches_v1') throw new Error('QuotaExceededError'); real(k, v); };
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] }, connected: false });
  setup({ firebase: fb, localStorage: ls });
  await Store.init({}); await settle();
  full = true;
  const saved = await Store.saveMatch(mk(undefined, '2025-09-08', { id: undefined, tegenstander: 'Q' }));
  Store._reset();
  Store._setEnv({ firebase: fb, localStorage: ls, debounceMs: 0 });
  fb.setConnected(true);
  await Store.init({}); await settle(10);
  assert.deepEqual(srvIds(fb), [1, saved.id]);
});

test('S2: eerste v2-start, v1-cache met match die de server nooit haalde → niet stil weg maar in prullenbak', async () => {
  const ls = fakeLS({ jo10_matches_v1: JSON.stringify([mk(1, '2025-09-01'), mk(2, '2025-09-08')]) });
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  setup({ firebase: fb, localStorage: ls });
  await Store.init({}); await settle(10);
  assert.deepEqual(ids(), [1]);
  const trash = Store.getTrash();
  assert.equal(trash.length, 1);
  assert.equal(trash[0].match.id, 2);
  assert.equal(trash[0].reason, 'remote');
  assert.ok(trash[0].removedAt > 0);
  assert.ok(ls.data[Store.LS_TRASH]);
});

test('S3: v1 op vers toestel doet set([één]) → seizoen in prullenbak, terug te zetten', async () => {
  const season = [1, 2, 3, 4, 5].map(i => mk(i, '2025-09-0' + i, { extra: 'veld' + i }));
  const fb = makeFakeFirebase({ initial: { jo10_matches: season } });
  setup({ firebase: fb });
  await Store.init({}); await settle();
  fb.remoteWrite('jo10_matches', [mk(99, '2025-10-01')]);
  await settle();
  assert.deepEqual(ids(), [99]);
  assert.deepEqual(Store.getTrash().map(e => e.match.id).sort(), [1, 2, 3, 4, 5]);
  const restored = await Store.restoreFromTrash(3);
  await settle();
  assert.equal(restored.id, 3);
  assert.deepEqual(srvIds(fb), [99, 3]);
  assert.equal(fb.server.jo10_matches[1].extra, 'veld3');
  assert.deepEqual(Store.getTrash().map(e => e.match.id).sort(), [1, 2, 4, 5]);
  await assert.rejects(Store.restoreFromTrash(12345), /prullenbak/);
});

test('verwijderen zet de match in de prullenbak (reason deleted); prullenbak is begrensd op 200', async () => {
  setup();
  await Store.init({});
  await Store.saveMatch(mk(1, '2025-09-01', { notitie: 'n' }));
  await Store.deleteMatch(1);
  const t = Store.getTrash();
  assert.equal(t[0].reason, 'deleted');
  assert.equal(t[0].match.notitie, 'n');
  const back = await Store.restoreFromTrash(1);
  assert.deepEqual(ids(), [1]);
  assert.equal(back.notitie, 'n');
  for (let i = 0; i < 205; i++) { await Store.saveMatch(mk(1000 + i, '2025-09-01')); await Store.deleteMatch(1000 + i); }
  const trash = Store.getTrash();
  assert.equal(trash.length, 200);
  assert.equal(trash[0].match.id, 1204, 'nieuwste eerst');
});

test('S4: dubbel id in remote array → verwijderen verwijdert alle exemplaren', async () => {
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01'), mk(7, '2025-09-02'), mk(7, '2025-09-02', { titel: 'dup' })] } });
  setup({ firebase: fb });
  await Store.init({}); await settle();
  await Store.deleteMatch(7); await settle();
  assert.deepEqual(srvIds(fb), [1]);
  assert.deepEqual(ids(), [1]);
  assert.equal(Store.getStatus(), 'synced');
});

test('S5: niet-numeriek string-id → opslaan werkt bestaande bij, geen duplicaat', async () => {
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk('abc', '2025-09-01')] } });
  setup({ firebase: fb });
  await Store.init({}); await settle();
  const m = Store.getMatches()[0];
  await Store.saveMatch(Object.assign({}, m, { notitie: 'x' })); await settle();
  assert.deepEqual(ids(), ['abc']);
  assert.deepEqual(srvIds(fb), ['abc']);
  assert.equal(fb.server.jo10_matches[0].notitie, 'x');
});

test('S6: schrijven geweigerd (tentative+revert events) → geen transactielus, status error, herstel na herverbinden', async () => {
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  const origRef = fb.database().ref;
  const listeners = [];
  let deny = true;
  fb.database = () => ({ ref: path => {
    const r = origRef(path);
    if (path !== 'jo10_matches') return r;
    const on = r.on.bind(r);
    const tx = r.transaction.bind(r);
    r.on = (e, cb, err) => { listeners.push(cb); return on(e, cb, err); };
    r.transaction = fn => {
      if (!deny) return tx(fn);
      fb.log.transactions++;
      const tentative = fbNorm(fn(clone(fb.server.jo10_matches)));
      listeners.forEach(cb => cb({ val: () => clone(tentative) }));
      return new Promise((_, rej) => setTimeout(() => {
        listeners.forEach(cb => cb({ val: () => clone(fb.server.jo10_matches) }));
        rej(permErr('jo10_matches'));
      }, 5));
    };
    return r;
  } });
  setup({ firebase: fb, flushTimeoutMs: 50, backoffMs: 1000 });
  await Store.init({}); await settle();
  const saved = await Store.saveMatch(mk(undefined, '2025-09-08', { id: undefined }));
  await new Promise(r => setTimeout(r, 300));
  assert.ok(fb.log.transactions <= 2, `transacties: ${fb.log.transactions}`);
  assert.equal(Store.getStatus(), 'error');
  assert.ok(ids().includes(saved.id), 'lokaal bewaard');
  deny = false;
  fb.setConnected(false);
  fb.setConnected(true);
  await settle(10);
  assert.deepEqual(srvIds(fb), [1, saved.id]);
  assert.equal(Store.getStatus(), 'synced');
});

test('synchrone throw in transaction() → geen unhandled rejection, status error, back-off', async () => {
  unhandled.length = 0;
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  const origRef = fb.database().ref;
  fb.database = () => ({ ref: path => { const r = origRef(path); if (path === 'jo10_matches') r.transaction = () => { fb.log.transactions++; throw new Error('boom'); }; return r; } });
  setup({ firebase: fb, flushTimeoutMs: 50, backoffMs: 1000 });
  await Store.init({}); await settle();
  await Store.saveMatch(mk(2, '2025-09-02'));
  fb.remoteWrite('jo10_matches', [mk(1, '2025-09-01')]);
  fb.remoteWrite('jo10_matches', [mk(1, '2025-09-01'), mk(3, '2025-09-03')]);
  await settle();
  assert.equal(fb.log.transactions, 1);
  assert.equal(Store.getStatus(), 'error');
  assert.equal(unhandled.length, 0);
});

test('S10: namen met . # $ / [ ] → saveMatch weigert; oude ongeldige op wordt in quarantaine gezet en blokkeert de rest niet', async () => {
  assert.equal(Store.validName('Noud'), null);
  for (const bad of ['M.J.', 'a#b', 'a$b', 'a/b', 'a[b', 'a]b', '', '   ']) assert.equal(typeof Store.validName(bad), 'string', bad);
  assert.deepEqual(Store.normalizeSquad({ players: [{ name: 'M.J.' }, { name: '[x]' }, { name: '...' }] }).players.map(p => p.name), ['MJ', 'x']);

  // oude openstaande op (bv. van vóór de validatie) met een ongeldige sleutel
  const badRec = mk(5, '2025-09-05', { periodes: [{ posities: { 'M.J.': 'K', Noud: 'V' }, wissels: [] }] });
  const ls = fakeLS({
    jo10_matches_v1: JSON.stringify([mk(1, '2025-09-01'), badRec]),
    jo10_sync_v2: JSON.stringify({ known: ['1'], ops: { 5: 'put' }, pending: { 5: badRec } }),
  });
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01')] } });
  const origRef = fb.database().ref;
  fb.database = () => ({ ref: path => {
    const r = origRef(path); const tx = r.transaction.bind(r);
    r.transaction = fn => { const out = fn(clone(fb.server[path])); const b = Store._findBadKey(out);
      if (b) throw new Error('transaction failed: Data returned contains an invalid key (' + b + ')'); return tx(fn); };
    return r; } });
  setup({ firebase: fb, localStorage: ls, flushTimeoutMs: 50 });
  await Store.init({}); await settle(10);
  await assert.rejects(Store.saveMatch(mk(undefined, '2025-09-08', { id: undefined, periodes: [{ posities: { 'M.J.': 'K' }, wissels: [] }] })), /Ongeldige naam "M\.J\."/);
  const m1 = Store.getMatches().find(m => m.id === 1);
  await Store.saveMatch(Object.assign({}, m1, { score: { home: 4, away: 2 } }));
  await settle();
  assert.deepEqual(fb.server.jo10_matches[0].score, { home: 4, away: 2 });
  assert.deepEqual(srvIds(fb), [1]);
  assert.deepEqual(Store._state().meta.ops, {});
  assert.ok(Store._state().meta.quarantine[5]);
  assert.ok(ids().includes(5), 'ongeldige match blijft lokaal');
  assert.equal(Store.getStatus(), 'synced');
  fb.remoteWrite('jo10_matches', fb.server.jo10_matches); await settle();
  assert.ok(ids().includes(5));
  assert.deepEqual(Store._state().meta.ops, {});
});

test('wedstrijd zonder periodes of met lege periode wordt geweigerd, zonder lokale wijziging', async () => {
  const ls = setup();
  await Store.init({});
  await assert.rejects(Store.saveMatch({ tegenstander: 'X', datum: '2025-09-01' }), /zonder periodes/);
  await assert.rejects(Store.saveMatch(mk(3, '2025-09-01', { periodes: [{ posities: {}, wissels: ['A'] }] })), /Periode 1 heeft geen opstelling/);
  assert.deepEqual(Store.getMatches(), []);
  assert.equal(ls.data[Config.LS_MATCHES], undefined);
  const ok = await Store.saveMatch(mk(4, '2025-09-01', { periodes: [{ posities: { Abel: 'K' } }] }));
  assert.deepEqual(ok.periodes[0].wissels, [], 'wissels altijd als array');
  assert.deepEqual(JSON.parse(ls.data[Config.LS_MATCHES])[0].periodes[0].wissels, []);
});

test('S8: v1 verwijdert terwijl v2 offline dezelfde match bewerkt → lokale bewerking wint (terug op server)', async () => {
  const fb = makeFakeFirebase({ initial: { jo10_matches: [mk(1, '2025-09-01'), mk(2, '2025-09-02'), mk(3, '2025-09-03')] } });
  setup({ firebase: fb });
  await Store.init({}); await settle();
  fb.setConnected(false);
  const m3 = Store.getMatches().find(m => m.id === 3);
  await Store.saveMatch(Object.assign({}, m3, { score: { home: 1, away: 0 } }));
  fb.server.jo10_matches = fbNorm([mk(1, '2025-09-01')]);
  fb.setConnected(true); await settle(20);
  assert.deepEqual(ids(), [1, 3]);
  assert.deepEqual(srvIds(fb), [1, 3]);
  assert.deepEqual(Store.getTrash().map(e => e.match.id), [2]);
  assert.equal(Store.getStatus(), 'synced');
});

test('geen unhandled rejections in de hele suite', async () => {
  await settle();
  assert.equal(unhandled.length, 0, String(unhandled[0]));
});
