// JO10 Opstelling — opslag: localStorage-cache + Firebase realtime sync (compat SDK), selectie, concept.
//
// Compatibiliteit met v1.html (deelt Firebase `jo10_matches` en localStorage `jo10_matches_v1`):
//  - de wedstrijden blijven ALTIJD een array; onbekende velden en onbekende records blijven behouden;
//  - schrijven gaat via ref.transaction() die per id samenvoegt in de actuele remote array
//    (v1 deed set() van de hele array → twee toestellen overschreven elkaar);
//  - een remote `null` (alles verwijderd) wordt wél verwerkt (v1 negeerde dat);
//  - er wordt nooit een lege array/null geschreven, behalve als de gebruiker expliciet de laatste wedstrijd verwijdert.
//
// Sync-model: lokale wijzigingen worden als "ops" ({ [id]: 'put'|'del' }) in localStorage bewaard tot een transactie
// ze bevestigd heeft. Remote snapshots zijn leidend, behalve voor ids met een openstaande op (lokaal wint tot
// bevestiging). Bij herverbinden (`.info/connected`) worden openstaande ops opnieuw verstuurd. Alle ops zijn
// idempotent (samenvoegen op id), dus dubbel versturen kan geen kwaad.
// Van elke openstaande put staat een kopie in `jo10_sync_v2` (meta.pending), omdat v1.html `jo10_matches_v1`
// op hetzelfde toestel kan overschrijven. Wat door sync of verwijderen lokaal verdwijnt, gaat eerst naar een
// lokale prullenbak (`jo10_trash_v2`, max. 200) — zie getTrash()/restoreFromTrash().
(function (root) {
  const JO10 = root.JO10 = root.JO10 || {};

  function cfg() {
    if (JO10.Config) return JO10.Config;
    if (typeof require === 'function') { try { return require('./config.js'); } catch (e) { /* ignore */ } }
    return {};
  }

  const LS_META = 'jo10_sync_v2';   // { known: [id], ops: { [id]: 'put'|'del' }, pending: { [id]: rec }, quarantine: { [id]: reden }, squadDirty, pendingTrainers: [trainer] }
  const LS_TRASH = 'jo10_trash_v2'; // [{ match, removedAt, reason: 'deleted'|'remote' }]
  const TRASH_MAX = 200;
  const BAD_KEY_CHARS = /[.#$\/\[\]\u0000-\u001f\u007f]/;   // Firebase-sleutels mogen dit niet bevatten
  const CODES = ['K', 'V', 'M', 'S'];
  const CODE_WORDS = { keeper: 'K', verdediger: 'V', verdediging: 'V', middenvelder: 'M', midden: 'M', spits: 'S', aanval: 'S', wissel: 'W' };

  // ── omgeving (injecteerbaar voor tests) ────────────────────────────────────
  const memStorage = (() => {
    let data = {};
    return {
      getItem: k => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
      setItem: (k, v) => { data[k] = String(v); },
      removeItem: k => { delete data[k]; },
      clear: () => { data = {}; },
    };
  })();
  let envOverride = {};
  function envFirebase() { return 'firebase' in envOverride ? envOverride.firebase : root.firebase; }
  function envLS() {
    if ('localStorage' in envOverride) return envOverride.localStorage || memStorage;
    try { return root.localStorage || memStorage; } catch (e) { return memStorage; }
  }
  function now() { return envOverride.now ? envOverride.now() : Date.now(); }
  function debounceMs() { return 'debounceMs' in envOverride ? envOverride.debounceMs : 50; }
  function flushTimeoutMs() { return 'flushTimeoutMs' in envOverride ? envOverride.flushTimeoutMs : 4000; }
  function backoffBaseMs() { return 'backoffMs' in envOverride ? envOverride.backoffMs : 2000; }

  // ── helpers ────────────────────────────────────────────────────────────────
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function toNum(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && /^\s*-?\d+(?:[.,]\d+)?\s*$/.test(v)) return Number(v.trim().replace(',', '.'));
    return undefined;
  }

  // Firebase geeft arrays soms als object terug ({0:…,1:…}) of met gaten (null). Dense array zonder null.
  function toArray(v) {
    if (Array.isArray(v)) return v.filter(x => x !== null && x !== undefined);
    if (isObj(v)) {
      return Object.keys(v).sort((a, b) => (toNum(a) ?? Infinity) - (toNum(b) ?? Infinity) || (a < b ? -1 : 1))
        .map(k => v[k]).filter(x => x !== null && x !== undefined);
    }
    return [];
  }
  // Zoals toArray, maar met behoud van posities (voor keepers[] per periode).
  function toSparseArray(v) {
    if (Array.isArray(v)) return v.map(x => (x === undefined ? null : x));
    if (isObj(v)) {
      const out = [];
      Object.keys(v).forEach(k => { const i = toNum(k); if (i !== undefined && i >= 0 && i < 100) out[i] = v[k]; });
      return Array.from(out, x => (x === undefined ? null : x));
    }
    return [];
  }

  function keyOf(rec) {
    if (!isObj(rec) || rec.id === undefined || rec.id === null || rec.id === '') return null;
    const n = toNum(rec.id);
    return String(n !== undefined ? n : rec.id);
  }

  function isPermissionError(err) {
    if (!err) return false;
    return /permission/i.test(String(err.code || '') + ' ' + String(err.message || err));
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function normDate(v) {
    if (typeof v !== 'string') return v instanceof Date && !isNaN(v) ? `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}` : '';
    const s = v.trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
    return s;
  }

  function buildTitel(teg, thuisUit) {
    const team = cfg().TEAM_NAME || 'JO10';
    return `${team} vs ${teg || 'Onbekend'} (${thuisUit === 'uit' ? '✈️ Uit' : '🏠 Thuis'})`;
  }

  // ── validatie ──────────────────────────────────────────────────────────────
  // Spelersnaam (wordt sleutel in posities → Firebase-regels). Geeft foutmelding (NL) of null.
  function validName(name) {
    const s = name === undefined || name === null ? '' : String(name).trim();
    if (!s) return 'Naam mag niet leeg zijn';
    if (/[.#$/[\]]/.test(s)) return 'Naam mag geen . # $ / [ ] bevatten';
    if (BAD_KEY_CHARS.test(s)) return 'Naam bevat ongeldige tekens';
    if (s.length > 40) return 'Naam is te lang (max. 40 tekens)';
    return null;
  }
  function sanitizeName(name) {
    return String(name).replace(new RegExp(BAD_KEY_CHARS.source, 'g'), '').replace(/\s+/g, ' ').trim();
  }
  // Eerste sleutel die Firebase zou weigeren (synchrone throw in transaction/set), of null.
  function findBadKey(v, path) {
    path = path || '';
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) { const b = findBadKey(v[i], path + '/' + i); if (b) return b; }
      return null;
    }
    if (isObj(v)) {
      for (const k of Object.keys(v)) {
        if (k === '' || BAD_KEY_CHARS.test(k)) return path + '/' + k;
        const b = findBadKey(v[k], path + '/' + k);
        if (b) return b;
      }
    }
    return null;
  }
  // Reden waarom een (genormaliseerde) wedstrijd niet gesynchroniseerd mag worden, of null.
  function matchProblem(m) {
    if (!m.periodes.length) return 'Wedstrijd zonder periodes kan niet opgeslagen worden';
    for (let i = 0; i < m.periodes.length; i++) {
      const p = m.periodes[i];
      const names = Object.keys(p.posities).concat(p.wissels);
      if (!Object.keys(p.posities).length) return `Periode ${i + 1} heeft geen opstelling`;
      for (const n of names) {
        const err = validName(n);
        if (err && err !== 'Naam is te lang (max. 40 tekens)') return `Ongeldige naam "${n}" in periode ${i + 1}: ${err}`;
      }
    }
    const bad = findBadKey(m);
    if (bad) return `Ongeldige sleutel ${bad} (geen . # $ / [ ] toegestaan)`;
    return null;
  }

  // ── normalisatie ───────────────────────────────────────────────────────────
  function normalizePeriode(raw) {
    const p = isObj(raw) ? clone(raw) : {};
    const posities = {};
    const wissels = [];
    const addW = n => { n = String(n).trim(); if (n && !wissels.includes(n)) wissels.push(n); };
    if (isObj(p.posities)) {
      Object.keys(p.posities).forEach(name => {
        const rawCode = p.posities[name];
        if (rawCode === null || rawCode === undefined || rawCode === '') return;
        let code = String(rawCode).trim();
        const up = code.toUpperCase();
        if (CODES.includes(up) || up === 'W') code = up;
        else if (CODE_WORDS[code.toLowerCase()]) code = CODE_WORDS[code.toLowerCase()];
        if (code === 'W') addW(name);
        else posities[name] = code;   // onbekende codes blijven ongemoeid
      });
    }
    const w = p.wissels !== undefined && p.wissels !== null ? p.wissels : p.subs;
    toArray(w).forEach(x => { if (typeof x === 'string' || typeof x === 'number') addW(x); });
    p.posities = posities;
    p.wissels = wissels.filter(n => !(n in posities));
    delete p.subs;
    return p;
  }

  function normalizeMatch(raw) {
    const m = isObj(raw) ? clone(raw) : {};
    const id = toNum(m.id);
    if (id !== undefined) m.id = id;
    ['v', 'updatedAt', 'createdAt'].forEach(k => { if (m[k] !== undefined) { const n = toNum(m[k]); if (n !== undefined) m[k] = n; } });
  // Wie heeft de wedstrijd gemaakt / laatst gewijzigd (trainernaam, optioneel). Leeg/null → veld weg.
  ['createdBy', 'updatedBy'].forEach(k => {
    if (!(k in m)) return;
    const v = typeof m[k] === 'string' || typeof m[k] === 'number' ? sanitizeName(m[k]).slice(0, 40) : '';
    if (v) m[k] = v; else delete m[k];
  });

    m.datum = normDate(m.datum);
    if (typeof m.titel !== 'string') m.titel = m.titel === undefined || m.titel === null ? '' : String(m.titel);

    const tm = m.titel.match(/\bvs\.?\s+(.+?)\s*(?:\(([^)]*)\))?\s*$/i);
    if (typeof m.tegenstander !== 'string' || !m.tegenstander.trim()) m.tegenstander = tm ? tm[1].trim() : (typeof m.tegenstander === 'string' ? m.tegenstander : '');
    const tu = typeof m.thuisUit === 'string' ? m.thuisUit.trim().toLowerCase() : '';
    if (tu === 'thuis' || tu === 'uit') m.thuisUit = tu;
    else m.thuisUit = tm && tm[2] && /uit/i.test(tm[2]) ? 'uit' : 'thuis';
    if (!m.titel.trim()) m.titel = buildTitel(m.tegenstander, m.thuisUit);

    if (isObj(m.score)) {
      const h = toNum(m.score.home), a = toNum(m.score.away);
      m.score = h !== undefined && a !== undefined ? Object.assign({}, m.score, { home: h, away: a }) : null;
    } else m.score = null;

    m.periodes = toArray(m.periodes).map(normalizePeriode);

    if (m.aanwezig !== undefined) m.aanwezig = toArray(m.aanwezig).map(String);
    if (m.keepers !== undefined) m.keepers = toSparseArray(m.keepers).map(x => (x === null || x === '' ? null : String(x)));
    if (m.goals !== undefined) {
      m.goals = toArray(m.goals).filter(isObj).map(g => Object.assign({}, g, {
        team: g.team === 'away' ? 'away' : 'home',
        minute: toNum(g.minute) !== undefined ? toNum(g.minute) : null,
        by: g.by === undefined || g.by === null || g.by === '' ? null : String(g.by),
      }));
    }
    return m;
  }

  function normalizeSquad(raw) {
    const def = cfg().DEFAULT_SQUAD || { players: [], settings: { periods: 4, minutes: 50 } };
    const r = isObj(raw) ? clone(raw) : clone(def);
    const players = [];
    toArray(r.players).forEach(p => {
      const o = typeof p === 'string' ? { name: p } : (isObj(p) ? p : null);
      if (!o || o.name === undefined || o.name === null) return;
      const name = sanitizeName(o.name);
      if (!name || players.some(x => x.name.toLowerCase() === name.toLowerCase())) return;
      players.push(Object.assign({}, o, {
        name,
        active: o.active !== false,
        avoid: toArray(o.avoid).map(c => String(c).toUpperCase()).filter(c => CODES.includes(c)),
        aliases: toArray(o.aliases).map(a => String(a).trim()).filter(Boolean),
      }));
    });
    const s = isObj(r.settings) ? r.settings : {};
    r.players = players;
    r.settings = Object.assign({}, s, {
      periods: toNum(s.periods) > 0 ? toNum(s.periods) : (def.settings && def.settings.periods) || 4,
      minutes: toNum(s.minutes) > 0 ? toNum(s.minutes) : (def.settings && def.settings.minutes) || 50,
    });
    if (r.updatedAt !== undefined) r.updatedAt = toNum(r.updatedAt) || 0;
    if (r.trainers !== undefined) {
      const trainers = normalizeTrainers(r.trainers);
      if (trainers.length) r.trainers = trainers; else delete r.trainers;   // Firebase bewaart geen lege lijst
    }
    return r;
  }

  // ── trainers ──────────────────────────────────────────────────────────────
  // Squad.trainers = [{ name, role: 'hoofdtrainer'|'trainer' }] (optioneel). Namen zoals spelersnamen.
  const ROLES = ['hoofdtrainer', 'trainer'];
  function normalizeTrainer(t) {
    const o = typeof t === 'string' ? { name: t } : (isObj(t) ? t : null);
    if (!o || o.name === undefined || o.name === null) return null;
    const name = sanitizeName(o.name);
    if (validName(name)) return null;
    const role = ROLES.includes(String(o.role || '').toLowerCase()) ? String(o.role).toLowerCase() : 'trainer';
    return Object.assign({}, o, { name, role });
  }
  function normalizeTrainers(list) {
    const out = [];
    toArray(list).forEach(t => {
      const tr = normalizeTrainer(t);
      if (tr && !out.some(x => x.name.toLowerCase() === tr.name.toLowerCase())) out.push(tr);
    });
    return out.slice(0, cfg().MAX_TRAINERS || 20);
  }
  // Voeg ontbrekende trainers toe aan een squad (bestaande namen blijven zoals ze zijn). → nieuwe squad
  function mergeTrainers(squad, list) {
    const sq = clone(squad) || {};
    const cur = normalizeTrainers(sq.trainers);
    normalizeTrainers(list).forEach(t => { if (!cur.some(x => x.name.toLowerCase() === t.name.toLowerCase())) cur.push(t); });
    if (cur.length) sq.trainers = cur.slice(0, cfg().MAX_TRAINERS || 20);
    return sq;
  }
  function sameName(a, b) { return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }

  // ── wijzigingen van andere trainers herkennen (puur) ──────────────────────
  // Handtekening van de opstelling (zonder uitslag/doelpunten/tijdstempels): verandert alleen als
  // datum, tegenstander, thuis/uit, aanwezigen, keepers, formatie of periodes wijzigen.
  function lineupSig(raw) {
    const m = normalizeMatch(raw);
    const per = m.periodes.map(p => {
      const pos = {}; Object.keys(p.posities).sort().forEach(n => { pos[n] = p.posities[n]; });
      return [pos, p.wissels.slice().sort()];
    });
    return JSON.stringify([m.datum, (m.tegenstander || '').trim(), m.thuisUit, (m.aanwezig || []).slice().sort(),
      m.keepers || [], m.formatie || null, per]);
  }
  function scoreSig(raw) {
    const m = normalizeMatch(raw);
    return JSON.stringify([m.score ? [m.score.home, m.score.away] : null, (m.goals || []).length]);
  }
  // Vergelijk twee lijsten wedstrijden (vorige en nieuwe toestand) en geef de wijzigingen die NIET van `me` komen:
  // [{ kind: 'new'|'lineup'|'score'|'other'|'deleted', id, by: naam|null, match }]
  //  - by = updatedBy alleen als updatedAt echt nieuwer is (v1.html laat een oude updatedBy staan) → anders null;
  //  - wijzigingen met by === me (zelfde naam, ook op een ander toestel) tellen niet mee.
  function diffByOthers(prev, next, me) {
    const keyed = list => { const map = {}; toArray(list).forEach(r => { const k = keyOf(r); if (k !== null) map[k] = r; }); return map; };
    const P = keyed(prev), N = keyed(next);
    const out = [];
    Object.keys(N).forEach(k => {
      const n = normalizeMatch(N[k]);
      const p = P[k] ? normalizeMatch(P[k]) : null;
      if (!p) {
        const by = n.createdBy || n.updatedBy || null;
        if (!sameName(by, me)) out.push({ kind: 'new', id: n.id, by, match: n });
        return;
      }
      const newer = (toNum(n.updatedAt) || 0) > (toNum(p.updatedAt) || 0);
      const lineup = lineupSig(p) !== lineupSig(n);
      const score = scoreSig(p) !== scoreSig(n);
      if (!newer && !lineup && !score) return;
      const by = newer ? (n.updatedBy || null) : null;
      if (sameName(by, me)) return;
      out.push({ kind: lineup ? 'lineup' : score ? 'score' : 'other', id: n.id, by, match: n });
    });
    Object.keys(P).forEach(k => { if (!N[k]) { const p = normalizeMatch(P[k]); out.push({ kind: 'deleted', id: p.id, by: null, match: p }); } });
    return out;
  }

  // Pure merge: pas lokale ops toe op een (remote) array. Records die we niet kennen blijven staan.
  function applyOps(current, ops, localByKey) {
    const arr = toArray(current).slice();
    Object.keys(ops || {}).forEach(key => {
      if (ops[key] === 'del') {   // alle records met dit id (ook dubbele)
        for (let i = arr.length - 1; i >= 0; i--) if (keyOf(arr[i]) === key) arr.splice(i, 1);
        return;
      }
      const idx = arr.findIndex(r => keyOf(r) === key);
      const loc = localByKey && localByKey[key];
      if (!loc) return;
      if (idx >= 0) arr[idx] = Object.assign({}, isObj(arr[idx]) ? arr[idx] : {}, clone(loc));
      else arr.push(clone(loc));
    });
    return arr;
  }

  // ── state ──────────────────────────────────────────────────────────────────
  function freshState(statusCbs) {
    return {
      raw: [],                 // wedstrijden zoals opgeslagen (niet genormaliseerd, met alle onbekende velden)
      squad: null,             // genormaliseerde squad of null (→ default)
      squadDenied: false,
      meta: { known: [], ops: {}, pending: {}, quarantine: {}, squadDirty: false, pendingTrainers: [] },
      revs: {}, rev: 0,
      status: 'offline',
      statusCbs: statusCbs || [],
      onChange: null,
      refs: null,
      connected: false,
      gotRemote: false,
      gotRemoteSquad: false,   // jo10_squad minstens één keer van de server gelezen
      matchesDenied: false,
      flushQueued: false,
      syncError: null,         // laatste transactiefout → status 'error' + back-off
      blocked: false,
      backoffMs: 0,
      retryTimer: null,
      changeTimer: null,
      flushChain: Promise.resolve(),
    };
  }
  let S = freshState();

  function readJSON(key, fallback) {
    try { const s = envLS().getItem(key); return s === null || s === undefined ? fallback : JSON.parse(s); }
    catch (e) { return fallback; }
  }
  function writeJSON(key, val) {
    try { envLS().setItem(key, JSON.stringify(val)); } catch (e) { /* quota / private mode */ }
  }
  function persistMatches() { writeJSON(cfg().LS_MATCHES || 'jo10_matches_v1', S.raw); }
  function persistMeta() { writeJSON(LS_META, S.meta); }

  function setStatus(st) {
    if (S.status === st) return;
    S.status = st;
    S.statusCbs.slice().forEach(cb => { try { cb(st); } catch (e) { /* ignore */ } });
  }
  // Ops die echt verstuurd kunnen worden (een put zonder record — zou niet mogen gebeuren — blijft bewaard maar telt niet).
  function pendingCount() {
    const ops = S.meta.ops;
    const local = localByKey();
    return Object.keys(ops).filter(k => ops[k] === 'del' || local[k] || S.meta.pending[k]).length;
  }
  function settleStatus() {
    if (!S.refs) return setStatus('offline');
    if (!S.connected) return setStatus('offline');
    if (S.matchesDenied || S.syncError) return setStatus('error');
    setStatus(pendingCount() || !S.gotRemote ? 'syncing' : 'synced');
  }

  function emitChange() {
    S.changeTimer = null;
    if (typeof S.onChange !== 'function') return;
    try { S.onChange({ matches: getMatches(), squad: getSquad() }); }
    catch (e) { if (typeof console !== 'undefined') console.error('[Store] onChange', e); }
  }
  function scheduleChange() {
    const ms = debounceMs();
    if (ms <= 0) return emitChange();
    if (S.changeTimer) clearTimeout(S.changeTimer);
    S.changeTimer = setTimeout(emitChange, ms);
  }

  function bumpRev(key) { S.revs[key] = ++S.rev; }
  function localByKey() {
    const map = {};
    S.raw.forEach(r => { const k = keyOf(r); if (k !== null) map[k] = r; });
    return map;
  }

  function readTrash() { return toArray(readJSON(LS_TRASH, [])).filter(e => isObj(e) && isObj(e.match)); }
  function addToTrash(recs, reason) {
    recs = recs.filter(isObj);
    if (!recs.length) return;
    let trash = readTrash();
    const t = now();
    recs.forEach(rec => {
      const k = keyOf(rec);
      if (k !== null) trash = trash.filter(e => keyOf(e.match) !== k);
      trash.push({ match: clone(rec), removedAt: t, reason });
    });
    if (trash.length > TRASH_MAX) trash = trash.slice(trash.length - TRASH_MAX);
    writeJSON(LS_TRASH, trash);
  }
  function quarantine(key, reason) {
    delete S.meta.ops[key];
    S.meta.quarantine[key] = reason;
    persistMeta();
    if (typeof console !== 'undefined') console.warn('[Store] wedstrijd ' + key + ' niet gesynchroniseerd: ' + reason);
  }

  function loadCache() {
    const C = cfg();
    S.raw = toArray(readJSON(C.LS_MATCHES || 'jo10_matches_v1', []));
    const sq = readJSON(C.LS_SQUAD || 'jo10_squad_v2', null);
    S.squad = isObj(sq) ? normalizeSquad(sq) : null;
    const meta = readJSON(LS_META, null);
    if (isObj(meta)) {
      S.meta = {
        known: toArray(meta.known).map(String),
        ops: isObj(meta.ops) ? Object.fromEntries(Object.entries(meta.ops).filter(([, v]) => v === 'put' || v === 'del')) : {},
        pending: isObj(meta.pending) ? meta.pending : {},
        quarantine: isObj(meta.quarantine) ? meta.quarantine : {},
        squadDirty: !!meta.squadDirty,
        pendingTrainers: normalizeTrainers(meta.pendingTrainers),
      };
      // Openstaande records terugzetten als v1.html (of een volle quota) de gedeelde cache heeft overschreven.
      Object.keys(S.meta.pending).forEach(k => {
        const rec = S.meta.pending[k];
        if (!isObj(rec) || (S.meta.ops[k] !== 'put' && !S.meta.quarantine[k])) { delete S.meta.pending[k]; return; }
        const idx = S.raw.findIndex(r => keyOf(r) === k);
        if (idx >= 0) S.raw[idx] = Object.assign({}, isObj(S.raw[idx]) ? S.raw[idx] : {}, rec);
        else S.raw.push(clone(rec));
      });
    } else {
      // Eerste start van v2 op dit toestel: neem aan dat de cache van de server kwam (geen wederopstanding).
      // Wat daarna bij de eerste snapshot wegvalt, gaat naar de prullenbak.
      S.meta = { known: S.raw.map(keyOf).filter(k => k !== null), ops: {}, pending: {}, quarantine: {}, squadDirty: false, pendingTrainers: [] };
    }
    Object.keys(S.meta.ops).forEach(bumpRev);
  }

  // ── remote → lokaal ───────────────────────────────────────────────────────
  function handleRemote(val) {
    S.gotRemote = true;
    const remote = toArray(val);
    const ops = S.meta.ops;
    const local = localByKey();
    Object.keys(S.meta.pending).forEach(k => { if (!local[k]) local[k] = S.meta.pending[k]; });
    const known = new Set(S.meta.known);
    const remoteKeys = new Set();
    const result = [];
    const dropped = [];
    remote.forEach(rec => {
      const k = keyOf(rec);
      if (k !== null) remoteKeys.add(k);
      if (k !== null && ops[k] === 'del') return;                       // verwijderd, wacht op bevestiging
      if (k !== null && ops[k] === 'put' && local[k]) { result.push(Object.assign({}, rec, local[k])); return; }
      result.push(rec);
    });
    const kept = new Set();
    S.raw.concat(Object.values(S.meta.pending)).forEach(rec => {
      const k = keyOf(rec);
      if (k === null || remoteKeys.has(k) || kept.has(k)) return;
      if (ops[k] === 'put' || S.meta.quarantine[k]) { kept.add(k); result.push(local[k] || rec); }   // lokaal, nog niet bevestigd
      else if (!known.has(k) && ops[k] !== 'del') {                     // nooit op de server geweest (bv. offline v1)
        ops[k] = 'put'; bumpRev(k); S.meta.pending[k] = clone(rec); kept.add(k); result.push(rec);
      } else if (ops[k] !== 'del') dropped.push(rec);                    // stond op de server, daar verwijderd → prullenbak
    });
    addToTrash(dropped, 'remote');
    S.meta.known = Array.from(remoteKeys);
    const changed = !same(result, S.raw);
    S.raw = result;
    persistMatches();
    persistMeta();
    if (changed) scheduleChange();
    settleStatus();
    if (pendingCount() && S.connected) flush();
  }

  // ── lokaal → remote ───────────────────────────────────────────────────────
  // Pas versturen na de eerste remote snapshot: dan heeft de SDK de actuele waarde in cache en draait de
  // transactie niet eerst op een `null`-gok (die lokaal even een bijna lege lijst zou tonen).
  function canFlush() { return !!(S.refs && S.connected && S.gotRemote && !S.matchesDenied && !S.blocked); }

  // Na een transactiefout niet meteen opnieuw (de SDK vuurt tentative+revert value-events → anders een lus);
  // wachten met groeiende vertraging, of tot herverbinden.
  function syncFailed(err) {
    S.syncError = err || new Error('sync mislukt');
    S.backoffMs = Math.min(60000, S.backoffMs ? S.backoffMs * 2 : backoffBaseMs());
    S.blocked = true;
    if (S.retryTimer) clearTimeout(S.retryTimer);
    S.retryTimer = setTimeout(() => { S.retryTimer = null; S.blocked = false; flush(); }, S.backoffMs);
    if (S.retryTimer && typeof S.retryTimer.unref === 'function') S.retryTimer.unref();
    settleStatus();
  }
  function unblock() {
    if (S.retryTimer) { clearTimeout(S.retryTimer); S.retryTimer = null; }
    S.blocked = false;
  }
  function flush() {
    if (!canFlush() || !pendingCount()) return Promise.resolve(true);
    if (S.flushQueued) return S.flushChain;
    S.flushQueued = true;
    const run = () => { S.flushQueued = false; return doFlush(); };
    S.flushChain = S.flushChain.then(run, run);
    return S.flushChain;
  }

  function doFlush() {
    if (!canFlush() || !pendingCount()) return Promise.resolve(true);
    const ops = Object.assign({}, S.meta.ops);
    const revs = Object.assign({}, S.revs);
    const all = localByKey();
    const local = {};
    Object.keys(ops).forEach(k => {
      if (ops[k] !== 'put') return;
      const rec = all[k] || S.meta.pending[k];
      if (!rec) { delete ops[k]; return; }          // geen record: op blijft in meta staan, nooit stil weggooien
      const bad = findBadKey(rec);
      if (bad) { quarantine(k, 'ongeldige sleutel ' + bad); delete ops[k]; return; }   // blokkeert de rest niet
      local[k] = clone(rec);
    });
    if (!Object.keys(ops).length) { settleStatus(); return Promise.resolve(true); }
    const refs = S.refs;
    setStatus('syncing');
    let p;
    try {
      p = refs.matches.transaction(current => {
        const next = applyOps(current, ops, local);
        // Lege array nooit schrijven; null alleen als (expliciet) de laatste wedstrijd verwijderd is.
        return next.length ? next : null;
      });
    } catch (e) { p = Promise.reject(e); }
    return Promise.resolve(p).then(res => {
      if (refs !== S.refs) return false;
      if (res && res.committed === false) { settleStatus(); return false; }
      Object.keys(ops).forEach(k => {
        if (S.meta.ops[k] === ops[k] && S.revs[k] === revs[k]) { delete S.meta.ops[k]; delete S.meta.pending[k]; }
      });
      S.syncError = null;
      S.backoffMs = 0;
      persistMeta();
      if (res && res.snapshot && typeof res.snapshot.val === 'function') handleRemote(res.snapshot.val());
      settleStatus();
      return true;
    }, err => {
      if (refs !== S.refs) return false;
      if (typeof console !== 'undefined') console.warn('[Store] transactie mislukt', err && (err.message || err));
      syncFailed(err);
      return false;
    });
  }

  function withTimeout(p, ms) {
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(false), ms);
      if (t && typeof t.unref === 'function') t.unref();
      p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(false); });
    });
  }

  function pushSquad() {
    if (S.squadDenied) { S.meta.squadDirty = false; persistMeta(); return; }
    if (!S.refs || !S.connected || !S.squad) return;
    const refs = S.refs;
    const data = clone(S.squad);
    const sent = JSON.stringify(data);
    let p;
    try { p = refs.squad.set(data); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(() => {
      if (JSON.stringify(S.squad) === sent) { S.meta.squadDirty = false; persistMeta(); }
    }, err => {
      if (isPermissionError(err)) { S.squadDenied = true; S.meta.squadDirty = false; persistMeta(); }
      // andere fouten: squadDirty blijft staan → opnieuw bij herverbinden
    });
  }

  function handleRemoteSquad(val) {
    S.gotRemoteSquad = true;
    if (isObj(val) && val.players !== undefined) {
      if (S.meta.squadDirty) { pushSquad(); return; }   // lokale wijziging nog niet bevestigd → lokaal wint
      let sq = normalizeSquad(val);
      // Trainer die zich op dit toestel aanmeldde vóór de selectie binnen was: nu pas samenvoegen en versturen,
      // zodat een (verouderde) lokale selectie nooit de echte overschrijft.
      const pend = S.meta.pendingTrainers || [];
      if (pend.length) {
        const merged = normalizeSquad(mergeTrainers(sq, pend));
        S.meta.pendingTrainers = [];
        if (!same(merged, sq)) {
          sq = normalizeSquad(Object.assign({}, merged, { updatedAt: now() }));
          if (!S.squadDenied) S.meta.squadDirty = true;
        }
        persistMeta();
      }
      const changed = !same(sq, S.squad);
      S.squad = sq;
      writeJSON(cfg().LS_SQUAD || 'jo10_squad_v2', sq);
      if (changed) scheduleChange();
      if (S.meta.squadDirty) pushSquad();
    } else if ((val === null || val === undefined) && S.squad) {
      if ((S.meta.pendingTrainers || []).length) { S.meta.pendingTrainers = []; persistMeta(); }   // zitten al in S.squad
      pushSquad();   // remote leeg, lokaal een eigen selectie → zaaien
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  function teardown() {
    if (S.changeTimer) { clearTimeout(S.changeTimer); S.changeTimer = null; }
    if (S.retryTimer) { clearTimeout(S.retryTimer); S.retryTimer = null; }
    const refs = S.refs;
    S.refs = null;
    if (!refs) return;
    ['matches', 'squad', 'connected'].forEach(k => {
      try { if (refs[k] && refs[k].off) refs[k].off('value', refs.handlers[k]); } catch (e) { /* ignore */ }
    });
  }

  function startSync() {
    const fb = envFirebase();
    if (!fb || typeof fb.database !== 'function') {
      setStatus('offline');
      waitForFirebase();
      return;
    }
    try {
      const C = cfg();
      if (typeof fb.initializeApp === 'function' && (!fb.apps || !fb.apps.length)) fb.initializeApp(C.FIREBASE);
      const db = fb.database();
      const refs = {
        matches: db.ref(C.FB_MATCHES || 'jo10_matches'),
        squad: db.ref(C.FB_SQUAD || 'jo10_squad'),
        connected: db.ref('.info/connected'),
        handlers: {},
      };
      S.refs = refs;
      setStatus('syncing');
      refs.handlers.connected = snap => {
        if (S.refs !== refs) return;
        S.connected = !!(snap && snap.val());
        if (S.connected) unblock();
        settleStatus();
        if (S.connected) {
          flush();
          if (S.meta.squadDirty) pushSquad();
        }
      };
      refs.handlers.matches = snap => { if (S.refs === refs) handleRemote(snap ? snap.val() : null); };
      refs.handlers.squad = snap => { if (S.refs === refs) handleRemoteSquad(snap ? snap.val() : null); };
      refs.connected.on('value', refs.handlers.connected, () => {});
      refs.matches.on('value', refs.handlers.matches, err => {
        if (S.refs !== refs) return;
        S.matchesDenied = true;
        setStatus('error');
        if (typeof console !== 'undefined') console.warn('[Store] jo10_matches niet leesbaar', err && err.message);
      });
      refs.squad.on('value', refs.handlers.squad, () => {
        // Database-rules staan jo10_squad mogelijk niet toe → stil terugvallen op localStorage/default.
        if (S.refs === refs) S.squadDenied = true;
      });
    } catch (e) {
      teardown();
      S.connected = false;
      setStatus('offline');
    }
  }

  // Firebase laadt asynchroon (index.html). Zolang het er nog niet is: even blijven kijken (max ~60 s),
  // alleen in de browser en niet als tests een eigen firebase injecteren.
  function waitForFirebase() {
    if (S.fbWait || 'firebase' in envOverride || typeof window === 'undefined') return;
    const started = Date.now();
    S.fbWait = setInterval(() => {
      const fb = envFirebase();
      if (fb && typeof fb.database === 'function') {
        clearInterval(S.fbWait); S.fbWait = null;
        if (!S.refs) startSync();
      } else if (Date.now() - started > 60000) {
        clearInterval(S.fbWait); S.fbWait = null;
      }
    }, 300);
  }

  function init(opts) {
    opts = opts || {};
    if (opts.env) _setEnv(opts.env);
    teardown();
    if (S.fbWait) clearInterval(S.fbWait);
    S = freshState(S.statusCbs);
    S.onChange = opts.onChange || null;
    loadCache();
    startSync();
    return Promise.resolve();
  }

  // ── publieke API ──────────────────────────────────────────────────────────
  function getMatches() {
    return S.raw.filter(isObj).map(normalizeMatch).sort((a, b) => {
      const da = a.datum || '', db = b.datum || '';
      if (da !== db) return da < db ? -1 : 1;
      const ia = toNum(a.id) ?? 0, ib = toNum(b.id) ?? 0;
      return ia - ib;
    });
  }

  function saveMatch(match) {
    const m = normalizeMatch(match);
    const problem = matchProblem(m);
    if (problem) return Promise.reject(new Error(problem));   // niets lokaal gewijzigd
    const keys = new Set(S.raw.map(keyOf).filter(k => k !== null));
    if (m.id === undefined || m.id === null || m.id === '') {   // bestaande (ook niet-numerieke) ids behouden
      let id = now();
      while (keys.has(String(id))) id++;
      m.id = id;
    }
    if (m.tegenstander && m.tegenstander.trim()) m.titel = buildTitel(m.tegenstander.trim(), m.thuisUit);
    if (m.v === undefined) m.v = 2;
    m.updatedAt = now();
    const key0 = keyOf(m);
    const isNew = !S.raw.some(r => keyOf(r) === key0) && !S.meta.pending[key0];
    // Wie: trainer van dit toestel. Zonder naam updatedBy expliciet leegmaken (null), anders blijft via de
    // merge de naam van de vorige trainer staan terwijl updatedAt nieuwer is.
    const me = getMe();
    m.updatedBy = me || null;
    if (isNew) {
      if (!m.createdBy && me) m.createdBy = me;
      if (m.createdAt === undefined) m.createdAt = m.updatedAt;
    }
    const clean = clone(m);   // haalt undefined weg (Firebase weigert undefined)
    const key = keyOf(clean);
    const idx = S.raw.findIndex(r => keyOf(r) === key);
    if (idx >= 0) S.raw[idx] = Object.assign({}, isObj(S.raw[idx]) ? S.raw[idx] : {}, clean);
    else S.raw.push(clean);
    S.meta.ops[key] = 'put';
    S.meta.pending[key] = clone(idx >= 0 ? S.raw[idx] : clean);
    delete S.meta.quarantine[key];
    bumpRev(key);
    persistMatches();
    persistMeta();
    const result = normalizeMatch(idx >= 0 ? S.raw[idx] : clean);
    if (!canFlush()) { settleStatus(); return Promise.resolve(result); }
    return withTimeout(flush(), flushTimeoutMs()).then(() => result);
  }

  function deleteMatch(id) {
    const key = keyOf({ id });
    if (key === null) return Promise.resolve();
    const removed = S.raw.filter(r => keyOf(r) === key);
    if (!removed.length && S.meta.pending[key]) removed.push(S.meta.pending[key]);
    addToTrash(removed, 'deleted');
    S.raw = S.raw.filter(r => keyOf(r) !== key);
    delete S.meta.pending[key];
    delete S.meta.quarantine[key];
    S.meta.ops[key] = 'del';
    bumpRev(key);
    persistMatches();
    persistMeta();
    if (!canFlush()) { settleStatus(); return Promise.resolve(); }
    return withTimeout(flush(), flushTimeoutMs()).then(() => undefined);
  }

  // Lokale prullenbak, nieuwste eerst.
  function getTrash() { return clone(readTrash()).reverse(); }

  function restoreFromTrash(id) {
    const key = keyOf({ id });
    const trash = readTrash();
    let entry = null;
    for (let i = trash.length - 1; i >= 0; i--) if (keyOf(trash[i].match) === key) { entry = trash[i]; break; }
    if (!entry) return Promise.reject(new Error('Wedstrijd niet gevonden in de prullenbak'));
    const k = keyOf(entry.match);
    delete S.meta.ops[k];                     // een openstaande 'del' mag het terugzetten niet tegenhouden
    return saveMatch(entry.match).then(m => {
      writeJSON(LS_TRASH, readTrash().filter(e => keyOf(e.match) !== k));
      return m;
    });
  }

  function getSquad() {
    return clone(S.squad || normalizeSquad(cfg().DEFAULT_SQUAD));
  }

  function saveSquad(squad) {
    S.squad = normalizeSquad(Object.assign({}, clone(squad) || {}, { updatedAt: now() }));
    writeJSON(cfg().LS_SQUAD || 'jo10_squad_v2', S.squad);
    if (!S.squadDenied) { S.meta.squadDirty = true; persistMeta(); }
    pushSquad();
    return Promise.resolve();
  }

  function activePlayers() {
    return getSquad().players.filter(p => p.active !== false).map(p => p.name);
  }

  // ── trainer op dit toestel ────────────────────────────────────────────────
  function lsMe() { return cfg().LS_ME || 'jo10_me_v2'; }
  function getMe() {
    let v = null;
    try { v = envLS().getItem(lsMe()); } catch (e) { v = null; }
    const name = v ? sanitizeName(v) : '';
    return name && !validName(name) ? name : '';
  }
  // → NL-foutmelding of null. Lege naam = vergeten.
  function setMe(name) {
    const raw = name === undefined || name === null ? '' : String(name).replace(/\s+/g, ' ').trim();
    if (!raw) { try { envLS().removeItem(lsMe()); } catch (e) { /* ignore */ } return null; }
    const err = validName(raw);
    if (err) return err;
    const s = sanitizeName(raw);
    try { envLS().setItem(lsMe(), s); } catch (e) { /* privémodus */ }
    return null;
  }
  // Trainer aan de selectie toevoegen (bv. via "Wie ben jij?" op een nieuw toestel). Is de selectie nog niet van
  // de server gelezen, dan alleen lokaal tonen en pas samenvoegen + versturen als die binnen is.
  function addTrainer(t) {
    const rawErr = validName(isObj(t) ? t.name : t);
    if (rawErr) return Promise.reject(new Error(rawErr));
    const tr = normalizeTrainer(t);
    if (!tr) return Promise.reject(new Error('Ongeldige naam'));
    const cur = getSquad();
    if (normalizeTrainers(cur.trainers).some(x => sameName(x.name, tr.name))) return Promise.resolve(cur);
    const merged = mergeTrainers(cur, [tr]);
    if (S.gotRemoteSquad || S.squadDenied) return saveSquad(merged).then(getSquad);
    S.meta.pendingTrainers = normalizeTrainers((S.meta.pendingTrainers || []).concat([tr]));
    persistMeta();
    S.squad = normalizeSquad(merged);
    writeJSON(cfg().LS_SQUAD || 'jo10_squad_v2', S.squad);
    return Promise.resolve(getSquad());
  }

  function getDraft() { const d = readJSON(cfg().LS_DRAFT || 'jo10_draft_v2', null); return isObj(d) ? d : null; }
  function saveDraft(draft) { writeJSON(cfg().LS_DRAFT || 'jo10_draft_v2', draft); }
  function clearDraft() { try { envLS().removeItem(cfg().LS_DRAFT || 'jo10_draft_v2'); } catch (e) { /* ignore */ } }

  function getStatus() { return S.status; }
  function onStatus(cb) {
    if (typeof cb !== 'function') return () => {};
    S.statusCbs.push(cb);
    try { cb(S.status); } catch (e) { /* ignore */ }
    return () => { S.statusCbs = S.statusCbs.filter(x => x !== cb); };
  }

  // ── test hooks ────────────────────────────────────────────────────────────
  function _setEnv(e) { envOverride = Object.assign({}, envOverride, e || {}); }
  function _reset() { teardown(); envOverride = {}; S = freshState(); memStorage.clear(); }

  const Store = JO10.Store = {
    init, getMatches, saveMatch, deleteMatch, getSquad, saveSquad, activePlayers,
    getDraft, saveDraft, clearDraft, getStatus, onStatus, normalizeMatch, normalizeSquad,
    getTrash, restoreFromTrash, validName,
    getMe, setMe, addTrainer, normalizeTrainers, mergeTrainers, lineupSig, diffByOthers,
    // intern / tests
    _setEnv, _reset, _applyOps: applyOps, _flush: flush, _state: () => S, _findBadKey: findBadKey, LS_META, LS_TRASH,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Store;
})(typeof window !== 'undefined' ? window : globalThis);
