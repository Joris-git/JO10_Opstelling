// JO10 Opstelling — UI-shell, schermen, state en rendering (JO10.App).
// Klassiek script (geen modules). Praat alleen via de API's uit CLAUDE.md met
// JO10.Scheduler / JO10.Store / JO10.IO / JO10.Live en blijft werken (met een
// vriendelijke melding) als een van die modules ontbreekt of een fout gooit.
(function (root) {
  'use strict';
  const JO10 = root.JO10 = root.JO10 || {};
  const doc = root.document;
  if (!doc) { if (typeof module !== 'undefined' && module.exports) module.exports = {}; return; }

  // ═══════════════════════════════════════════════════════════════════
  // Constanten & config
  // ═══════════════════════════════════════════════════════════════════
  const SCREENS = ['wedstrijd', 'live', 'seizoen', 'team'];
  const UI_KEY = 'jo10_ui_v2';           // alleen UI-voorkeuren (laatste tab, weergave, live-wedstrijd)
  const PITCH_ROWS = ['S', 'M', 'V', 'K']; // van boven (aanval) naar onder (keeper)
  const EDIT_CODES = ['K', 'V', 'M', 'S', 'W'];
  const FIELD = ['K', 'V', 'M', 'S'];

  const FALLBACK_CFG = {
    APP_NAME: 'JO10 Opstelling', TEAM_NAME: 'JO10', MIN_PLAYERS: 4,
    DEFAULT_SQUAD: { players: [], settings: { periods: 4, minutes: 50 } },
    POSITIONS: {
      K: { code: 'K', label: 'Keeper', short: 'K', icon: '🧤', color: '#f59e0b' },
      V: { code: 'V', label: 'Verdediger', short: 'V', icon: '🛡️', color: '#3b82f6' },
      M: { code: 'M', label: 'Middenvelder', short: 'M', icon: '⚙️', color: '#10b981' },
      S: { code: 'S', label: 'Spits', short: 'S', icon: '⚡', color: '#ef4444' },
      W: { code: 'W', label: 'Wissel', short: 'W', icon: '🪑', color: '#94a3b8' },
    },
    formationFor(n) { return n >= 6 ? { K: 1, V: 2, M: 1, S: 2 } : n === 5 ? { K: 1, V: 2, M: 1, S: 1 } : n === 4 ? { K: 1, V: 1, M: 1, S: 1 } : { K: 1, V: Math.max(0, n - 1), M: 0, S: 0 }; },
    periodTimes(periods, minutes) {
      const len = minutes / periods; const f = x => String(Math.round(x * 10) / 10).replace('.', ',');
      return Array.from({ length: periods }, (_, i) => `${f(i * len)}–${f((i + 1) * len)} min`);
    },
    LS_MATCHES: 'jo10_matches_v1', LS_SQUAD: 'jo10_squad_v2', LS_DRAFT: 'jo10_draft_v2', LS_THEME: 'jo10_theme', LS_LIVE: 'jo10_live_v2',
  };
  const C = () => JO10.Config || FALLBACK_CFG;
  const POS = code => ((C().POSITIONS || FALLBACK_CFG.POSITIONS)[code]) || { code, label: code, icon: '', color: '#94a3b8' };
  const TEAM = () => C().TEAM_NAME || 'JO10';
  const MIN_PLAYERS = () => C().MIN_PLAYERS || 4;

  // ═══════════════════════════════════════════════════════════════════
  // Kleine hulpfuncties
  // ═══════════════════════════════════════════════════════════════════
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"'`]/g, c => ESC[c]);
  const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const uniq = a => [...new Set(a)];
  const pad2 = n => String(n).padStart(2, '0');
  const isoOf = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const todayISO = () => isoOf(new Date());
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const $ = (sel, el) => (el || doc).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || doc).querySelectorAll(sel));
  const sameId = (a, b) => a != null && b != null && String(a) === String(b);
  const randSeed = () => Math.floor(Math.random() * 2147483646) + 1;
  const reducedMotion = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function nextSaturdayISO() { const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7)); return isoOf(d); }
  function parseISO(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function fmtDate(iso, opts) {
    const d = parseISO(iso); if (!d) return iso || '';
    try { return d.toLocaleDateString('nl-NL', opts || { weekday: 'short', day: 'numeric', month: 'short' }); } catch (e) { return iso; }
  }
  function lsGet(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { root.localStorage.setItem(k, v); } catch (e) { /* privémodus / vol */ } }
  function lsJSON(k) { try { return JSON.parse(lsGet(k) || 'null'); } catch (e) { return null; } }
  function scrollIntoView(el) { if (el) el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }); }
  function nameKey(s) { return String(s || '').trim().toLowerCase(); }

  // ═══════════════════════════════════════════════════════════════════
  // Foutafhandeling & module-toegang
  // ═══════════════════════════════════════════════════════════════════
  const lastErr = {};
  function reportError(e, msg) {
    try { console.error('[JO10]', msg || '', e); } catch (_) { /* */ }
    const key = msg || String(e && e.message);
    const now = Date.now();
    if (lastErr[key] && now - lastErr[key] < 4000) return;
    lastErr[key] = now;
    toast(msg || 'Er ging iets mis. Probeer het nog eens.', 'error');
  }
  // Store weigert ongeldige wedstrijden met een Nederlandse foutmelding: die tonen we letterlijk.
  const errMsg = (e, fallback) => (e && typeof e.message === 'string' && e.message.trim() && !/^(TypeError|ReferenceError)/.test(String(e.name)) ? e.message : fallback);
  const MOD_LABEL = { Scheduler: 'De rekenmodule', Store: 'De opslagmodule', IO: 'De deel- en exportmodule', Live: 'De live-module' };
  function modFn(mod, fn) { const m = JO10[mod]; return m && typeof m[fn] === 'function' ? m[fn].bind(m) : null; }
  function callMod(mod, fn, args, fallback, errMsg) {
    const f = modFn(mod, fn);
    if (!f) { reportError(new Error(`${mod}.${fn} ontbreekt`), `${MOD_LABEL[mod] || mod} is niet geladen.`); return fallback; }
    try { return f.apply(null, args || []); } catch (e) { reportError(e, errMsg || `${MOD_LABEL[mod] || mod} gaf een fout.`); return fallback; }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Datamodel-helpers (defensief lezen)
  // ═══════════════════════════════════════════════════════════════════
  function normPeriod(p) {
    p = p || {};
    const posities = {}; const wissels = [];
    Object.entries(p.posities || {}).forEach(([n, c]) => {
      if (c === 'W') wissels.push(n); else if (FIELD.includes(c)) posities[n] = c;
    });
    (Array.isArray(p.wissels) ? p.wissels : Array.isArray(p.subs) ? p.subs : []).forEach(n => { if (n && !posities[n]) wissels.push(n); });
    return { posities, wissels: uniq(wissels) };
  }
  function localNormMatch(raw) {
    const m = Object.assign({}, raw || {});
    m.periodes = (Array.isArray(m.periodes) ? m.periodes : []).map(normPeriod);
    const s = m.score;
    m.score = s && typeof s === 'object' && s.home !== '' && s.away !== '' && s.home != null && s.away != null &&
      !isNaN(+s.home) && !isNaN(+s.away) ? { home: +s.home, away: +s.away } : null;
    m.thuisUit = m.thuisUit === 'uit' ? 'uit' : 'thuis';
    if (!m.tegenstander && m.titel) { const t = /vs\s+(.+?)\s*(\(|$)/.exec(m.titel); if (t) m.tegenstander = t[1]; }
    return m;
  }
  function normMatch(raw) {
    const f = modFn('Store', 'normalizeMatch');
    let m = null;
    if (f) { try { m = f(raw); } catch (e) { console.warn('[JO10] normalizeMatch', e); } }
    m = localNormMatch(m || raw); // tweede laag: UI rekent op deze vorm
    return m;
  }
  function normSquad(sq) {
    const def = clone(C().DEFAULT_SQUAD || FALLBACK_CFG.DEFAULT_SQUAD);
    sq = sq && typeof sq === 'object' ? sq : def;
    const players = (Array.isArray(sq.players) ? sq.players : def.players).filter(p => p && p.name).map(p => ({
      name: String(p.name),
      active: p.active !== false,
      avoid: Array.isArray(p.avoid) ? p.avoid.filter(c => FIELD.includes(c)) : [],
      aliases: Array.isArray(p.aliases) ? p.aliases.filter(Boolean).map(String) : [],
    }));
    const settings = Object.assign({ periods: 4, minutes: 50 }, def.settings || {}, sq.settings || {});
    settings.periods = [2, 4].includes(+settings.periods) ? +settings.periods : 4;
    settings.minutes = clamp(+settings.minutes || 50, 10, 120);
    return Object.assign({}, sq, { players, settings });
  }
  const byDate = (a, b) => String(a.datum || '').localeCompare(String(b.datum || '')) || (+a.id || 0) - (+b.id || 0);
  function codeOf(per, name) {
    if (!per) return null;
    if (per.posities && per.posities[name]) return per.posities[name];
    return (per.wissels || []).includes(name) ? 'W' : null;
  }
  function setCode(per, name, code) {
    delete per.posities[name];
    per.wissels = per.wissels.filter(n => n !== name);
    if (code === 'W') per.wissels.push(name); else if (code) per.posities[name] = code;
  }
  function namesOf(periodes) {
    const s = [];
    (periodes || []).forEach(p => { Object.keys(p.posities || {}).forEach(n => s.push(n)); (p.wissels || []).forEach(n => s.push(n)); });
    return uniq(s);
  }
  function orderNames(names, order) {
    const idx = new Map((order || []).map((n, i) => [n, i]));
    return names.slice().sort((a, b) => (idx.has(a) ? idx.get(a) : 999) - (idx.has(b) ? idx.get(b) : 999) || a.localeCompare(b));
  }
  function groupByCode(per, order) {
    const g = { K: [], V: [], M: [], S: [], W: [] };
    Object.entries(per.posities || {}).forEach(([n, c]) => { if (g[c]) g[c].push(n); });
    (per.wissels || []).forEach(n => g.W.push(n));
    Object.keys(g).forEach(k => { g[k] = orderNames(g[k], order); });
    return g;
  }
  function resultOf(m) { if (!m || !m.score) return null; const { home: h, away: a } = m.score; return h > a ? 'W' : h < a ? 'V' : 'G'; }
  const RESULT_LABEL = { W: 'Gewonnen', G: 'Gelijk', V: 'Verloren' };
  const RESULT_ICON = { W: '🏆', G: '🤝', V: '😞' };
  function titelOf(tegenstander, thuisUit) {
    return `${TEAM()} vs ${tegenstander || 'Onbekend'} (${thuisUit === 'uit' ? '✈️ Uit' : '🏠 Thuis'})`;
  }
  function periodTimes(n, minutes) {
    try { return (C().periodTimes || FALLBACK_CFG.periodTimes)(n, minutes); } catch (e) { return FALLBACK_CFG.periodTimes(n, minutes); }
  }
  function halvesOf(n) {
    if (n < 2) return [Array.from({ length: n }, (_, i) => i)];
    const mid = Math.ceil(n / 2);
    return [Array.from({ length: mid }, (_, i) => i), Array.from({ length: n - mid }, (_, i) => mid + i)];
  }
  const rangeLabel = idx => (idx.length > 1 ? `P${idx[0] + 1}–P${idx[idx.length - 1] + 1}` : `P${idx[0] + 1}`);

  // ═══════════════════════════════════════════════════════════════════
  // Store-facade (met lokale terugval als JO10.Store ontbreekt)
  // ═══════════════════════════════════════════════════════════════════
  const Local = {
    matches() { const a = lsJSON(C().LS_MATCHES); return Array.isArray(a) ? a.filter(Boolean) : []; },
    writeMatches(a) { lsSet(C().LS_MATCHES, JSON.stringify(a)); },
    squad() { return lsJSON(C().LS_SQUAD) || clone(C().DEFAULT_SQUAD); },
  };
  const St = {
    run(fn, args, fallbackFn) {
      const f = modFn('Store', fn);
      if (f) { try { return f.apply(null, args || []); } catch (e) { reportError(e, 'De opslag gaf een fout — we werken lokaal verder.'); } }
      return fallbackFn ? fallbackFn() : undefined;
    },
    async init(opts) {
      const f = modFn('Store', 'init');
      if (!f) { reportError(new Error('Store ontbreekt'), 'De opslagmodule is niet geladen — alles blijft op dit apparaat.'); return; }
      return f(opts);
    },
    getMatches() {
      const a = St.run('getMatches', [], () => Local.matches());
      return (Array.isArray(a) ? a : []).filter(Boolean).map(localNormMatch).sort(byDate);
    },
    getSquad() { return normSquad(St.run('getSquad', [], () => Local.squad())); },
    activePlayers() {
      const a = St.run('activePlayers', [], null);
      return Array.isArray(a) ? a.slice() : St.getSquad().players.filter(p => p.active).map(p => p.name);
    },
    async saveMatch(m) {
      const f = modFn('Store', 'saveMatch');
      if (f) return f(m);
      const list = Local.matches(); const rec = Object.assign({}, m, { updatedAt: Date.now() });
      const i = list.findIndex(x => sameId(x.id, m.id));
      if (i >= 0) list[i] = rec; else list.push(rec);
      Local.writeMatches(list); return rec;
    },
    async deleteMatch(id) {
      const f = modFn('Store', 'deleteMatch');
      if (f) return f(id);
      Local.writeMatches(Local.matches().filter(x => !sameId(x.id, id)));
    },
    async saveSquad(sq) {
      const f = modFn('Store', 'saveSquad');
      if (f) return f(sq);
      lsSet(C().LS_SQUAD, JSON.stringify(Object.assign({}, sq, { updatedAt: Date.now() })));
    },
    getDraft() { return St.run('getDraft', [], () => lsJSON(C().LS_DRAFT)); },
    saveDraft(d) { St.run('saveDraft', [d], () => lsSet(C().LS_DRAFT, JSON.stringify(d))); },
    clearDraft() { St.run('clearDraft', [], () => { try { root.localStorage.removeItem(C().LS_DRAFT); } catch (e) { /* */ } }); },
    getStatus() { return St.run('getStatus', [], () => 'offline') || 'offline'; },
    onStatus(cb) { const f = modFn('Store', 'onStatus'); if (f) { try { f(cb); } catch (e) { console.warn(e); } } },
  };
  const settings = () => St.getSquad().settings;
  const settingsFor = m => Object.assign({}, settings(), { periods: (m && m.periodes && m.periodes.length) || settings().periods });
  // Historie met bijnamen/oude namen omgezet naar de huidige spelersnaam (Team → bijnamen), zodat
  // hernoemen of "bas" ↔ "Bastiaan" de seizoensbalans niet breekt.
  function aliasMap() {
    const map = new Map();
    St.getSquad().players.forEach(p => { map.set(nameKey(p.name), p.name); });
    St.getSquad().players.forEach(p => p.aliases.forEach(a => { if (!map.has(nameKey(a))) map.set(nameKey(a), p.name); }));
    return map;
  }
  function canonMatches(ms) {
    const map = aliasMap();
    const c = n => (typeof n === 'string' && map.get(nameKey(n))) || n;
    return ms.map(m => {
      const out = Object.assign({}, m, {
        periodes: (m.periodes || []).map(per => {
          const posities = {}; Object.entries(per.posities || {}).forEach(([n, code]) => { posities[c(n)] = code; });
          return { posities, wissels: (per.wissels || []).map(c) };
        }),
      });
      if (Array.isArray(m.aanwezig)) out.aanwezig = m.aanwezig.map(c);
      if (Array.isArray(m.keepers)) out.keepers = m.keepers.map(c);
      if (Array.isArray(m.goals)) out.goals = m.goals.map(g => (g && g.by ? Object.assign({}, g, { by: c(g.by) }) : g));
      return out;
    });
  }
  const historyExcl = id => canonMatches(St.getMatches().filter(m => !sameId(m.id, id)));
  const findMatch = id => St.getMatches().find(m => sameId(m.id, id)) || null;
  // Record zoals de Store het geeft (zonder extra UI-normalisatie) — basis voor patches.
  function rawMatch(id) {
    const a = St.run('getMatches', [], () => Local.matches());
    return (Array.isArray(a) ? a : []).find(m => m && sameId(m.id, id)) || null;
  }
  // Spelersnamen worden Firebase-sleutels (posities): geen . # $ / [ ]
  function nameError(name) {
    const f = modFn('Store', 'validName');
    if (f) { try { const r = f(name); if (r) return String(r); } catch (e) { console.warn(e); } }
    if (!String(name || '').trim()) return 'Naam mag niet leeg zijn.';
    if (/[.#$/[\]]/.test(name)) return 'Een naam mag geen . # $ / [ of ] bevatten.';
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════════════
  const S = {
    ready: false,
    screen: 'wedstrijd',
    draft: null,
    view: 'veld',          // 'veld' | 'tabel' (schema-weergave)
    sel: null,             // { p, name } geselecteerde speler in het schema
    undo: [],
    genWarnings: [],
    carouselX: {},
    scroll: {},
    season: { sort: 'pct', dir: -1, detailId: null },
    liveMatchId: null,
    liveMounted: null,
    edit: null,            // speler-bewerken in Team
    pendingImport: null,
    shareMatch: null,
  };

  function saveUI() {
    lsSet(UI_KEY, JSON.stringify({ screen: S.screen, view: S.view, liveMatchId: S.liveMatchId }));
  }

  // ── Concept (draft) ────────────────────────────────────────────────
  function sigOf(d) { return JSON.stringify([d.aanwezig.slice().sort(), d.keepers, d.periods]); }
  function isStale(d) { return !!(d.periodes && d.sig !== sigOf(d)); }
  function hasUnsaved(d) { return !!(d && d.periodes && d.dirty); }
  function keepersValid(d) { return d.keepers.length === d.periods && d.keepers.every(k => k && d.aanwezig.includes(k)); }

  function newDraft() {
    const st = settings();
    const d = {
      datum: todayISO(), tegenstander: '', thuisUit: 'thuis',
      aanwezig: St.activePlayers(), keepers: [], periodes: null, locks: [],
      seed: randSeed(), savedId: null,
      // UI-extra's (lokaal concept, niet in Match)
      periods: st.periods, guests: [], sameKeeper: false, keepersAuto: true, dirty: false, sig: null,
    };
    autoKeepers(d);
    return d;
  }
  function restoreDraft() {
    let raw = null;
    try { raw = St.getDraft(); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.aanwezig)) return newDraft();
    const st = settings();
    const d = Object.assign(newDraftShell(st), raw);
    d.aanwezig = uniq(d.aanwezig.filter(Boolean).map(String));
    d.guests = Array.isArray(d.guests) ? d.guests : [];
    d.locks = Array.isArray(d.locks) ? d.locks.filter(l => l && l.player != null && l.period != null) : [];
    d.periodes = Array.isArray(d.periodes) && d.periodes.length ? d.periodes.map(normPeriod) : null;
    d.periods = d.periodes ? d.periodes.length : ([2, 4].includes(+d.periods) ? +d.periods : st.periods);
    d.keepers = Array.isArray(d.keepers) ? d.keepers.slice(0, d.periods) : [];
    while (d.keepers.length < d.periods) d.keepers.push('');
    if (d.savedId != null && !findMatch(d.savedId)) { d.savedId = null; if (d.periodes) d.dirty = true; }
    if (d.periodes && !d.sig) d.sig = sigOf(d);
    if (!d.periodes && d.keepersAuto) autoKeepers(d);
    return d;
  }
  function newDraftShell(st) {
    return { datum: todayISO(), tegenstander: '', thuisUit: 'thuis', aanwezig: [], keepers: [], periodes: null, locks: [],
      seed: randSeed(), savedId: null, periods: st.periods, guests: [], sameKeeper: false, keepersAuto: true, dirty: false, sig: null };
  }
  function draftFromMatch(m) {
    const periodes = (m.periodes || []).map(normPeriod);
    const squadOrder = St.getSquad().players.map(p => p.name);
    let aanwezig = Array.isArray(m.aanwezig) && m.aanwezig.length ? m.aanwezig.slice() : orderNames(namesOf(periodes), squadOrder);
    aanwezig = uniq(aanwezig.concat(namesOf(periodes)));
    const keepers = periodes.map((p, i) => (Array.isArray(m.keepers) && m.keepers[i] && p.posities[m.keepers[i]] === 'K')
      ? m.keepers[i] : (Object.keys(p.posities).find(n => p.posities[n] === 'K') || ''));
    const squadNames = new Set(squadOrder);
    const d = {
      datum: m.datum || todayISO(), tegenstander: m.tegenstander || '', thuisUit: m.thuisUit === 'uit' ? 'uit' : 'thuis',
      aanwezig, keepers, periodes: periodes.length ? periodes : null, locks: [], seed: randSeed(), savedId: m.id,
      periods: periodes.length || settings().periods, guests: aanwezig.filter(n => !squadNames.has(n)),
      sameKeeper: keepers.length > 1 && keepers.every(k => k && k === keepers[0]), keepersAuto: false, dirty: false, sig: null,
    };
    d.sig = sigOf(d);
    return d;
  }

  let draftTimer = null;
  function persistDraft(now) {
    clearTimeout(draftTimer);
    const write = () => { try { St.saveDraft(clone(S.draft)); } catch (e) { console.warn(e); } };
    if (now) write(); else draftTimer = setTimeout(write, 250);
  }
  function changed() { if (S.draft.periodes) S.draft.dirty = true; persistDraft(); }

  // ── Keepers ────────────────────────────────────────────────────────
  // Aantal periodes op doel dit seizoen (zelfde maat als Scheduler.suggestKeepers gebruikt).
  function keeperCounts(history) {
    const c = {};
    history.forEach(m => (m.periodes || []).forEach(p => Object.entries(p.posities || {}).forEach(([n, code]) => { if (code === 'K') c[n] = (c[n] || 0) + 1; })));
    return c;
  }
  const perTxt = n => `${n} ${n === 1 ? 'periode' : 'periodes'}`;
  function avoidSet(code) { return new Set(St.getSquad().players.filter(p => p.avoid.includes(code)).map(p => p.name)); }
  function suggestKeepersFor(d) {
    const players = d.aanwezig;
    if (!players.length) return Array(d.periods).fill('');
    const f = modFn('Scheduler', 'suggestKeepers');
    if (f) {
      try {
        const r = f({ players: players.slice(), history: historyExcl(d.savedId), squad: St.getSquad(), periods: d.periods });
        if (Array.isArray(r) && r.length && r.every(n => !n || players.includes(n))) {
          const out = r.slice(0, d.periods); while (out.length < d.periods) out.push(out[out.length - 1] || '');
          return out;
        }
      } catch (e) { console.warn('[JO10] suggestKeepers', e); }
    }
    // Terugval: wie het minst gekeept heeft (en K niet vermijdt)
    const counts = keeperCounts(historyExcl(d.savedId)); const avoid = avoidSet('K');
    const ranked = players.slice().sort((a, b) => (avoid.has(a) - avoid.has(b)) || (counts[a] || 0) - (counts[b] || 0) || a.localeCompare(b));
    const halves = halvesOf(d.periods); const out = [];
    halves.forEach((idx, h) => idx.forEach(() => out.push(ranked[Math.min(h, ranked.length - 1)] || '')));
    return out;
  }
  function autoKeepers(d) {
    const sug = suggestKeepersFor(d);
    if (d.sameKeeper) { d.keepers = Array(d.periods).fill(sug[0] || ''); return; }
    d.keepers = Array(d.periods).fill('');
    halvesOf(d.periods).forEach(idx => idx.forEach(i => { d.keepers[i] = sug[idx[0]] || ''; }));
  }
  function ensureKeepers(d) {
    while (d.keepers.length < d.periods) d.keepers.push('');
    d.keepers = d.keepers.slice(0, d.periods);
    if (d.keepersAuto) { autoKeepers(d); return; }
    d.keepers = d.keepers.map(k => (k && d.aanwezig.includes(k) ? k : ''));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Toasts
  // ═══════════════════════════════════════════════════════════════════
  let toastSeq = 0; const toastActions = {};
  const TOAST_ICON = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' };
  function toast(msg, type, opts) {
    type = type || 'info'; opts = opts || {};
    const host = doc.getElementById('toast-root'); if (!host) return;
    const id = ++toastSeq;
    const el = doc.createElement('div');
    el.className = `toast toast--${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `<span class="toast__icon" aria-hidden="true">${TOAST_ICON[type] || ''}</span><span class="toast__msg">${esc(msg)}</span>` +
      (opts.action ? `<button type="button" class="toast__btn" data-act="toast-action" data-id="${id}">${esc(opts.action.label)}</button>` : '');
    if (opts.action) toastActions[id] = opts.action.fn;
    el.dataset.toast = id;
    host.appendChild(el);
    while (host.children.length > 3) host.removeChild(host.firstChild);
    requestAnimationFrame(() => el.classList.add('is-in'));
    const ms = opts.ms || (type === 'error' ? 5500 : opts.action ? 5000 : 2600);
    setTimeout(() => dismissToast(el, id), ms);
    el.addEventListener('click', e => { if (!e.target.closest('.toast__btn')) dismissToast(el, id); });
  }
  function dismissToast(el, id) {
    delete toastActions[id];
    if (!el.parentNode) return;
    el.classList.remove('is-in');
    setTimeout(() => el.remove(), reducedMotion() ? 0 : 220);
  }
  // "Ongedaan"-toasts horen bij één specifieke wijziging: na een nieuwe wijziging of een undo
  // zou de knop een ándere stap terugdraaien, dus dan weghalen.
  function dismissActionToasts() {
    $$('#toast-root .toast').forEach(el => { if (el.querySelector('.toast__btn')) dismissToast(el, el.dataset.toast); });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Bottom-sheet / dialogen
  // ═══════════════════════════════════════════════════════════════════
  let sheetState = null;
  function openSheet(o) {
    closeSheet(false);
    const host = doc.getElementById('sheet-root'); if (!host) return null;
    const prevFocus = doc.activeElement;
    host.innerHTML = `<div class="sheet-backdrop" data-act="sheet-close"></div>
      <div class="sheet${o.className ? ' ' + o.className : ''}" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div class="sheet__grip" aria-hidden="true"></div>
        <div class="sheet__head"><h2 id="sheet-title" class="sheet__title">${o.title}</h2>
          <button type="button" class="icon-btn" data-act="sheet-close" aria-label="Sluiten">✕</button></div>
        <div class="sheet__body">${o.body || ''}</div>
        ${o.actions ? `<div class="sheet__actions">${o.actions}</div>` : ''}
      </div>`;
    doc.body.classList.add('has-sheet');
    sheetState = { prevFocus, onClose: o.onClose, resolve: null };
    requestAnimationFrame(() => {
      host.classList.add('is-open');
      const f = host.querySelector('[autofocus]') || host.querySelector('.sheet__body button, .sheet__body input, .sheet__actions button');
      if (f) try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); }
    });
    return host.querySelector('.sheet');
  }
  function closeSheet(silent) {
    if (!sheetState) return;
    const st = sheetState; sheetState = null;
    const host = doc.getElementById('sheet-root');
    host.classList.remove('is-open'); host.innerHTML = '';
    doc.body.classList.remove('has-sheet');
    if (!silent) { if (st.resolve) st.resolve(null); if (st.onClose) st.onClose(); }
    if (st.prevFocus && st.prevFocus.isConnected && st.prevFocus.focus) try { st.prevFocus.focus({ preventScroll: true }); } catch (e) { /* */ }
  }
  function confirmDialog(o) {
    return new Promise(resolve => {
      openSheet({
        title: esc(o.title || 'Weet je het zeker?'),
        body: o.message ? `<p class="sheet__msg">${esc(o.message)}</p>` : '',
        actions: `<button type="button" class="btn btn--secondary" data-act="sheet-resolve" data-v="0">${esc(o.cancel || 'Annuleren')}</button>
                  <button type="button" class="btn ${o.danger ? 'btn--danger' : 'btn--primary'}" data-act="sheet-resolve" data-v="1">${esc(o.ok || 'OK')}</button>`,
      });
      if (sheetState) sheetState.resolve = v => resolve(v === true);
      else resolve(false);
    });
  }
  function promptDialog(o) {
    return new Promise(resolve => {
      openSheet({
        title: esc(o.title),
        body: `<form data-form="prompt" class="stack" autocomplete="off">
          <label class="field"><span class="field__label">${esc(o.label || '')}</span>
          <input class="input" name="v" value="${esc(o.value || '')}" placeholder="${esc(o.placeholder || '')}" autocapitalize="words" enterkeyhint="done" maxlength="40" autofocus></label>
          ${o.hint ? `<p class="hint">${esc(o.hint)}</p>` : ''}
          <button type="submit" hidden></button></form>`,
        actions: `<button type="button" class="btn btn--secondary" data-act="sheet-close">Annuleren</button>
                  <button type="button" class="btn btn--primary" data-act="prompt-ok">${esc(o.ok || 'OK')}</button>`,
      });
      if (sheetState) sheetState.resolve = v => resolve(typeof v === 'string' ? v : null);
      else resolve(null);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Thema & sync-status
  // ═══════════════════════════════════════════════════════════════════
  const THEME_ICON = { auto: '🌗', light: '☀️', dark: '🌙' };
  const THEME_LABEL = { auto: 'automatisch', light: 'licht', dark: 'donker' };
  function currentTheme() { const t = lsGet(C().LS_THEME); return t === 'light' || t === 'dark' ? t : 'auto'; }
  function applyTheme(t, store) {
    if (t !== 'light' && t !== 'dark') t = 'auto';
    if (t === 'auto') doc.documentElement.removeAttribute('data-theme'); else doc.documentElement.setAttribute('data-theme', t);
    if (store) lsSet(C().LS_THEME, t);
    const b = doc.getElementById('theme-btn');
    if (b) { b.textContent = THEME_ICON[t]; b.setAttribute('aria-label', `Thema: ${THEME_LABEL[t]} (tik om te wisselen)`); b.title = `Thema: ${THEME_LABEL[t]}`; }
    $$('[data-act="set-theme"]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.v === t)));
  }
  const STATUS_TEXT = {
    offline: 'Offline – alles staat veilig op dit apparaat',
    syncing: 'Synchroniseren…',
    synced: 'Gesynchroniseerd met de cloud',
    error: 'Synchronisatie mislukt – lokaal opgeslagen',
  };
  function showStatus(s) {
    if (!STATUS_TEXT[s]) s = 'offline';
    $$('.sync-dot').forEach(x => { x.dataset.status = s; });
    const el = doc.getElementById('sync-dot'); if (!el) return;
    el.title = STATUS_TEXT[s]; el.setAttribute('aria-label', STATUS_TEXT[s]);
    const t = doc.getElementById('team-sync-text'); if (t) t.textContent = STATUS_TEXT[s];
  }
  function applyPosColors() {
    const r = doc.documentElement.style;
    EDIT_CODES.forEach(c => { const col = POS(c).color; if (col) r.setProperty(`--pos-${c}`, col); });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Navigatie
  // ═══════════════════════════════════════════════════════════════════
  function screenEl(name) { return doc.getElementById(`screen-${name}`); }
  function go(screen, params) {
    params = params || {};
    if (!SCREENS.includes(screen)) screen = 'wedstrijd';
    const prev = S.screen;
    if (prev !== screen) {
      S.scroll[prev] = root.scrollY || 0;
      if (prev === 'live') unmountLive();
      if (prev === 'wedstrijd') S.sel = null;
      closeSheet(false);
    }
    S.screen = screen;
    if (screen === 'live' && params.matchId != null) { if (!sameId(S.liveMatchId, params.matchId)) unmountLive(); S.liveMatchId = params.matchId; }
    if (screen === 'seizoen' && 'matchId' in params) S.season.detailId = params.matchId;
    SCREENS.forEach(n => { const el = screenEl(n); if (el) el.hidden = n !== screen; });
    $$('.tabbar .tab').forEach(t => { if (t.dataset.screen === screen) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
    doc.body.dataset.screen = screen;
    renderScreen(screen);
    setSelbar();
    saveUI();
    if (prev !== screen || params.top) root.scrollTo(0, params.top ? 0 : (S.scroll[screen] || 0));
  }
  function renderScreen(name) {
    const el = screenEl(name); if (!el) return;
    try {
      ({ wedstrijd: renderWedstrijd, live: renderLive, seizoen: renderSeizoen, team: renderTeam })[name]();
    } catch (e) {
      reportError(e, 'Dit scherm kon niet getekend worden.');
      el.innerHTML = `<div class="container"><div class="card empty"><div class="empty__icon" aria-hidden="true">😕</div>
        <p><b>Oeps, hier ging iets mis.</b></p><p class="hint">${esc(e && e.message)}</p>
        <button type="button" class="btn btn--primary" data-act="reload">Opnieuw laden</button></div></div>`;
    }
  }
  function rerender() { if (S.ready) renderScreen(S.screen); }

  // ═══════════════════════════════════════════════════════════════════
  // Schema-weergave (gedeeld door editor en seizoensdetail)
  // ═══════════════════════════════════════════════════════════════════
  function isLocked(locks, p, name) { return (locks || []).some(l => l.period === p && l.player === name); }
  function chipHTML(name, code, p, o) {
    const locked = isLocked(o.locks, p, name);
    const sel = !!(o.sel && o.sel.p === p && o.sel.name === name);
    const target = !!(o.sel && o.sel.p === p && !sel);
    const cls = `pc pc--${code}${sel ? ' is-sel' : ''}${target ? ' is-target' : ''}${locked ? ' is-locked' : ''}`;
    const inner = `<span class="pc__name">${esc(name)}</span>${locked ? '<span class="pc__lock" aria-hidden="true">🔒</span>' : ''}`;
    if (!o.editable) return `<span class="${cls}" title="${esc(POS(code).label)}">${inner}</span>`;
    const label = `${name}, ${POS(code).label}, periode ${p + 1}${locked ? ', vastgezet' : ''}`;
    return `<button type="button" class="${cls}" data-act="chip" data-p="${p}" data-name="${esc(name)}" aria-pressed="${sel}" aria-label="${esc(label)}">${inner}</button>`;
  }
  function veldHTML(periodes, o) {
    const cards = periodes.map((per, p) => {
      const g = groupByCode(per, o.order);
      const rows = PITCH_ROWS.map(code => `<div class="pitch__row" data-code="${code}">${g[code].map(n => chipHTML(n, code, p, o)).join('')}</div>`).join('');
      const bench = g.W.length ? g.W.map(n => chipHTML(n, 'W', p, o)).join('') : '<span class="bench__none">geen wissels</span>';
      return `<article class="period${o.sel && o.sel.p === p ? ' is-active' : ''}" aria-label="Periode ${p + 1}">
        <header class="period__head"><span class="period__title">Periode ${p + 1}</span><span class="period__time">${esc(o.times[p] || '')}</span></header>
        <div class="pitch"><div class="pitch__lines" aria-hidden="true"><i class="pl-mid"></i><i class="pl-circle"></i><i class="pl-box pl-box--top"></i><i class="pl-box pl-box--bot"></i></div>${rows}</div>
        <div class="bench"><span class="bench__label">🪑 Wissel</span><div class="bench__chips">${bench}</div></div>
      </article>`;
    }).join('');
    const dots = periodes.length > 1 ? `<div class="carousel-dots" aria-hidden="true">${periodes.map((_, i) => `<span class="dot${i === 0 ? ' is-on' : ''}"></span>`).join('')}</div>` : '';
    return `<div class="periods" style="--np:${periodes.length}" data-carousel="${esc(o.key || 'x')}">${cards}</div>${dots}`;
  }
  function tabelHTML(periodes, o) {
    const names = orderNames(namesOf(periodes), o.order);
    const head = periodes.map((_, p) => `<th scope="col" title="${esc(o.times[p] || '')}">P${p + 1}</th>`).join('');
    const rows = names.map(n => {
      let field = 0, sub = 0;
      const cells = periodes.map((per, p) => {
        const code = codeOf(per, n);
        if (!code) return '<td class="sched__cell"><span class="pb pb--none" aria-label="niet ingedeeld">–</span></td>';
        if (code === 'W') sub++; else field++;
        const locked = isLocked(o.locks, p, n);
        const sel = !!(o.sel && o.sel.p === p && o.sel.name === n);
        const target = !!(o.sel && o.sel.p === p && !sel);
        const cls = `pb pb--${code}${sel ? ' is-sel' : ''}${target ? ' is-target' : ''}${locked ? ' is-locked' : ''}`;
        const inner = `<span class="pb__code">${esc(POS(code).short || code)}</span>${locked ? '<span class="pb__lock" aria-hidden="true">🔒</span>' : ''}`;
        const el = o.editable
          ? `<button type="button" class="${cls}" data-act="chip" data-p="${p}" data-name="${esc(n)}" aria-pressed="${sel}" aria-label="${esc(`${n}, ${POS(code).label}, periode ${p + 1}${locked ? ', vastgezet' : ''}`)}">${inner}</button>`
          : `<span class="${cls}" title="${esc(POS(code).label)}">${inner}</span>`;
        return `<td class="sched__cell${o.sel && o.sel.p === p ? ' is-col' : ''}">${el}</td>`;
      }).join('');
      return `<tr><th scope="row" class="sched__name">${esc(n)}</th>${cells}<td class="sched__num">${field}</td><td class="sched__num sched__num--sub">${sub}</td></tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="sched">
      <thead><tr><th scope="col" class="sched__name">Speler</th>${head}<th scope="col" title="Periodes in het veld"><span aria-hidden="true">⚽</span><span class="sr-only">Veld</span></th><th scope="col" title="Periodes wissel"><span aria-hidden="true">🪑</span><span class="sr-only">Wissel</span></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }
  function legendHTML() {
    return `<div class="legend" aria-label="Legenda">${EDIT_CODES.map(c => `<span class="legend__item"><span class="pb pb--${c} pb--mini">${esc(POS(c).short || c)}</span>${esc(POS(c).label)}</span>`).join('')}</div>`;
  }
  function viewToggleHTML(view, act) {
    return `<div class="seg seg--sm" role="group" aria-label="Weergave">
      <button type="button" class="seg__btn" data-act="${act}" data-v="veld" aria-pressed="${view === 'veld'}">🏟️ Veld</button>
      <button type="button" class="seg__btn" data-act="${act}" data-v="tabel" aria-pressed="${view === 'tabel'}">📋 Tabel</button></div>`;
  }
  function bindCarousel(scope) {
    $$('.periods[data-carousel]', scope).forEach(car => {
      const key = car.dataset.carousel;
      if (S.carouselX[key]) car.scrollLeft = S.carouselX[key];
      const dots = car.nextElementSibling && car.nextElementSibling.classList.contains('carousel-dots') ? $$('.dot', car.nextElementSibling) : [];
      const update = () => {
        S.carouselX[key] = car.scrollLeft;
        if (!dots.length) return;
        const cards = car.children; if (!cards.length) return;
        const w = cards[0].getBoundingClientRect().width || 1;
        const i = clamp(Math.round(car.scrollLeft / (w + 10)), 0, dots.length - 1);
        dots.forEach((d, j) => d.classList.toggle('is-on', j === i));
      };
      car.addEventListener('scroll', update, { passive: true });
      update();
    });
  }
  function scrollCarouselTo(scope, p) {
    const car = $('.periods[data-carousel]', scope); if (!car || !car.children[p]) return;
    if (car.scrollWidth <= car.clientWidth + 4) return; // grid op desktop
    const target = car.children[p];
    const left = target.offsetLeft - car.offsetLeft - 8;
    if (Math.abs(car.scrollLeft - left) > 20) car.scrollTo({ left, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Speelkalender (officiële iCal, via data/kalender.ics)
  // ═══════════════════════════════════════════════════════════════════
  const Cal = { fixtures: [], trainings: [], material: {}, updatedAt: 0, source: '', loading: false, error: '' };
  const CAL_KEY = () => C().LS_CALENDAR || 'jo10_calendar_v2';
  const CAL_SOURCE = { site: 'clubsite (dagelijks automatisch)', club: 'clubsite', file: 'eigen .ics-bestand' };
  function calLoadCache() {
    const c = lsJSON(CAL_KEY());
    if (c && Array.isArray(c.fixtures)) Object.assign(Cal, { fixtures: c.fixtures, trainings: Array.isArray(c.trainings) ? c.trainings : [], updatedAt: +c.updatedAt || 0, source: c.source || '' });
  }
  function calApply(text, source) {
    const F = JO10.Fixtures;
    const r = F.parseICS(text, { team: C().CALENDAR_TEAM });
    r.trainings = typeof F.parseTrainings === 'function' ? F.parseTrainings(text) : [];
    r.ok = r.fixtures.length > 0 || r.trainings.length > 0;
    if (r.ok) {
      Object.assign(Cal, { fixtures: r.fixtures, trainings: r.trainings, updatedAt: Date.now(), source, error: '' });
      lsSet(CAL_KEY(), JSON.stringify({ fixtures: Cal.fixtures, trainings: Cal.trainings, updatedAt: Cal.updatedAt, source }));
    }
    return r;
  }
  async function calRefresh(manual) {
    if (!JO10.Fixtures || Cal.loading || typeof root.fetch !== 'function') return;
    // Een eigen geïmporteerd bestand niet stil overschrijven; handmatig vernieuwen mag wel.
    if (!manual && Cal.source === 'file' && Cal.fixtures.length) return;
    Cal.loading = true;
    let r = null, err = '';
    const tries = [[C().CALENDAR_FILE, 'site'], [C().CALENDAR_URL, 'club']].filter(t => t[0]);
    for (const [url, src] of tries) {
      try {
        const res = await root.fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rr = calApply(await res.text(), src);
        if (rr.ok) { r = rr; break; }
        err = rr.warnings[0] || 'Geen wedstrijden gevonden';
      } catch (e) { err = e && e.message || String(e); }
    }
    Cal.loading = false; Cal.error = r ? '' : err;
    if (manual) toast(r ? `📅 Kalender bijgewerkt: ${r.fixtures.length} wedstrijden, ${r.trainings.length} trainingen` : 'Kalender ophalen lukte niet. Importeer het .ics-bestand, of probeer het later nog eens.', r ? 'success' : 'warn', { ms: 4000 });
    if (r || manual) calRerender();
  }
  function calRerender() {
    if (!S.ready || sheetState) return;
    if (S.screen === 'wedstrijd') { if (!isTyping()) renderInfo(); }
    else if (S.screen === 'seizoen') renderSeizoen();
    else if (S.screen === 'team') { if (!isTyping()) renderTeam(); }
  }
  // Trainingsstof per week (optioneel bestand; ontbreekt het, dan linken we naar de clubpagina)
  async function loadMaterial() {
    const T = C().TRAINING || {};
    if (!T.materialFile || typeof root.fetch !== 'function') return;
    try {
      const res = await root.fetch(T.materialFile, { cache: 'no-cache' });
      if (!res.ok) return;
      const j = await res.json();
      if (j && typeof j.weken === 'object') { Cal.material = j.weken; calRerender(); }
    } catch (e) { /* geen materiaalbestand: prima */ }
  }
  function trainingOpts() {
    const T = C().TRAINING || {};
    return { start: T.seasonStart, weekday: T.weekday == null ? 3 : T.weekday, holidays: T.holidays || [] };
  }
  // Komende reeks-trainingen (woensdag): week, vakantie, tijd/veld uit de kalender, stof
  function upcomingTrainings(n) {
    if (!modFn('Fixtures', 'trainingWeeks')) return [];
    const today = todayISO();
    const until = isoOf(new Date(Date.now() + 1000 * 60 * 60 * 24 * 7 * (n + 8)));
    return fxFn('trainingWeeks', [Object.assign(trainingOpts(), { until })], [])
      .filter(w => w.datum >= today).slice(0, n)
      .map(w => {
        const t = Cal.trainings.find(x => x.datum === w.datum) || null;
        const mat = w.week != null ? (Cal.material[String(w.week)] || null) : null;
        return Object.assign({}, w, { t, mat });
      });
  }
  function trainingRowHTML(w, first) {
    const d = parseISO(w.datum);
    const T = C().TRAINING || {};
    const when = `${fmtDate(w.datum, { weekday: 'short' })}${w.t ? ` ${w.t.tijd}${w.t.eind ? '–' + w.t.eind : ''}` : ''}${w.t && w.t.veld ? ` · veld ${w.t.veld}` : ''}`;
    const title = w.vakantie ? `🏖️ ${w.vakantie}` : `Week ${w.week}${w.mat && w.mat.titel ? ` · ${w.mat.titel}` : ''}`;
    const sub = w.vakantie ? 'telt niet mee in de reeks' : [when, w.mat && w.mat.thema].filter(Boolean).join(' · ');
    const link = !w.vakantie ? ((w.mat && w.mat.link) || T.materialUrl) : '';
    const inner = `<span class="mrow__date" aria-hidden="true"><b>${d ? d.getDate() : '?'}</b><small>${d ? esc(d.toLocaleDateString('nl-NL', { month: 'short' })) : ''}</small></span>
      <span class="mrow__main"><span class="mrow__opp">${esc(title)}</span><span class="mrow__meta">${esc(sub)}</span></span>
      ${link ? `<span class="fx-tag">${first ? 'Trainingsstof ›' : '›'}</span>` : ''}`;
    return link ? `<a class="mrow${w.vakantie ? ' is-off' : ''}" href="${esc(link)}" target="_blank" rel="noopener">${inner}</a>`
      : `<div class="mrow is-off">${inner}</div>`;
  }
  function trainingenHTML() {
    const list = upcomingTrainings(S.trAll ? 12 : 4);
    if (!list.length) return '';
    return `<div class="card"><h2 class="card__title">🏃 Trainingen</h2>
      <div class="mlist">${list.map((w, i) => trainingRowHTML(w, i === 0)).join('')}</div>
      <button type="button" class="link-btn fx-more" data-act="tr-all">${S.trAll ? 'Minder tonen' : 'Meer weken'}</button>
      <p class="hint">Woensdagtraining volgens de trainingsstof van de club (week 1 = ${esc(fmtDate((C().TRAINING || {}).seasonStart || '', { day: 'numeric', month: 'long' }))}). Schoolvakanties (regio Midden) tellen niet mee.</p></div>`;
  }
  async function onCalendarFile(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (!JO10.Fixtures) { reportError(new Error('Fixtures ontbreekt'), 'De kalendermodule is niet geladen.'); return; }
    let text = '';
    try { text = await file.text(); } catch (e) { reportError(e, 'Dit bestand kon niet gelezen worden.'); return; }
    const r = calApply(text, 'file');
    if (r.ok) toast(`📅 ${r.fixtures.length} wedstrijden en ${r.trainings.length} trainingen uit ${file.name} ingelezen`, 'success');
    else toast(r.warnings[0] || 'Geen wedstrijden gevonden in dit bestand.', 'warn');
    renderTeam();
  }
  const fxFn = (fn, args, fb) => { const f = modFn('Fixtures', fn); if (!f) return fb; try { return f(...args); } catch (e) { console.warn(e); return fb; } };
  const fxShort = f => fxFn('shortName', [f.tegenstander], f.tegenstander);
  const fxById = id => Cal.fixtures.find(f => String(f.id) === String(id)) || null;
  function fxWhen(f, long) {
    const day = fmtDate(f.datum, long ? { weekday: 'long', day: 'numeric', month: 'long' } : { weekday: 'short', day: 'numeric', month: 'short' });
    return `${day}${f.tijd ? ` · ${f.tijd}` : ''}`;
  }
  function fxMeta(f) {
    return [f.thuisUit === 'uit' ? '✈️ uit' : '🏠 thuis', f.soort && f.soort !== 'competitie' ? f.soort : '', f.verzamel ? `verzamelen ${f.verzamel}` : '', f.locatie].filter(Boolean).join(' · ');
  }
  function fxApplyToDraft(d, f) {
    d.datum = f.datum; d.tegenstander = fxShort(f); d.thuisUit = f.thuisUit === 'uit' ? 'uit' : 'thuis';
  }
  // Wedstrijd voorbereiden vanuit de kalender (Seizoen → Programma)
  async function fxPlan(id) {
    const f = fxById(id); if (!f) return;
    const existing = fxFn('matchFor', [f, St.getMatches()], null);
    if (existing) { editMatch(existing.id); return; }
    let d = S.draft;
    const fresh = !d.periodes && !d.savedId;
    if (!fresh) {
      if (hasUnsaved(d)) {
        const ok = await confirmDialog({ title: 'Nieuwe wedstrijd?', message: 'Je huidige schema is nog niet opgeslagen. Weggooien en de wedstrijd uit de kalender voorbereiden?', ok: 'Ja', danger: true });
        if (!ok) return;
      }
      d = S.draft = newDraft(); S.undo = []; S.sel = null; S.genWarnings = []; S.carouselX = {};
    }
    fxApplyToDraft(d, f);
    persistDraft(true);
    go('wedstrijd', { top: true });
    toast(`${fxShort(f)} · ${fxWhen(f)} klaargezet`, 'success');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Scherm: Wedstrijd
  // ═══════════════════════════════════════════════════════════════════
  function renderWedstrijd() {
    const el = screenEl('wedstrijd');
    el.innerHTML = `<nav class="progress" id="w-progress" aria-label="Voortgang"></nav>
      <div class="container">
        <div class="card" id="w-info"></div>
        <div class="card" id="w-aanwezig"></div>
        <div class="card" id="w-keepers"></div>
        <div id="w-generate"></div>
        <div class="card card--schema" id="w-schema" hidden></div>
        <div class="card" id="w-actions" hidden></div>
      </div>`;
    renderInfo(); renderAanwezig(); renderKeepers(); renderGenerate(); renderSchema(); renderActions(); renderProgress();
  }
  function renderProgress() {
    const el = $('#w-progress'); if (!el) return;
    const d = S.draft;
    const steps = [
      { k: 'w-info', l: 'Gegevens', done: !!d.tegenstander.trim() },
      { k: 'w-aanwezig', l: 'Aanwezig', done: d.aanwezig.length >= MIN_PLAYERS() },
      { k: 'w-keepers', l: 'Keepers', done: keepersValid(d) },
      { k: 'w-schema', l: 'Schema', done: !!d.periodes && !isStale(d) },
      { k: 'w-actions', l: 'Opslaan', done: !!d.savedId && !d.dirty },
    ];
    el.innerHTML = `<ol class="progress__list">${steps.map((s, i) => `<li><button type="button" class="progress__step${s.done ? ' is-done' : ''}" data-act="scroll-to" data-target="${s.k}">
      <span class="progress__dot" aria-hidden="true">${s.done ? '✓' : i + 1}</span><span class="progress__label">${s.l}</span><span class="sr-only">${s.done ? ' (klaar)' : ''}</span></button></li>`).join('')}</ol>`;
  }
  function opponents() {
    return uniq(St.getMatches().map(m => (m.tegenstander || '').trim()).filter(t => t && t !== 'Onbekend')).sort((a, b) => a.localeCompare(b));
  }
  function renderInfo() {
    const el = $('#w-info'); if (!el) return;
    const d = S.draft; const today = todayISO(); const sat = nextSaturdayISO();
    const quick = [`<button type="button" class="chip-btn" data-act="date-quick" data-v="${today}" aria-pressed="${d.datum === today}">Vandaag</button>`];
    if (sat !== today) quick.push(`<button type="button" class="chip-btn" data-act="date-quick" data-v="${sat}" aria-pressed="${d.datum === sat}">${esc(fmtDate(sat, { weekday: 'short', day: 'numeric', month: 'short' }))}</button>`);
    el.innerHTML = `<h2 class="card__title"><span class="step-num" aria-hidden="true">1</span> Wedstrijd</h2>
      <div class="form-grid">
        <label class="field field--opp"><span class="field__label">Tegenstander</span>
          <input class="input" id="in-opp" type="text" list="opp-list" data-input="tegenstander" value="${esc(d.tegenstander)}" placeholder="bijv. FC Stein" autocomplete="off" autocapitalize="words" enterkeyhint="done" maxlength="60"></label>
        <datalist id="opp-list">${opponents().map(o => `<option value="${esc(o)}"></option>`).join('')}</datalist>
        <div class="field"><span class="field__label" id="lbl-date">Datum</span>
          <div class="date-row"><input class="input" type="date" data-input="datum" value="${esc(d.datum)}" aria-labelledby="lbl-date">
          <div class="date-quick">${quick.join('')}</div></div></div>
        <div class="field"><span class="field__label" id="lbl-hu">Thuis of uit</span>
          <div class="seg" role="group" aria-labelledby="lbl-hu">
            <button type="button" class="seg__btn" data-act="thuisuit" data-v="thuis" aria-pressed="${d.thuisUit === 'thuis'}">🏠 Thuis</button>
            <button type="button" class="seg__btn" data-act="thuisuit" data-v="uit" aria-pressed="${d.thuisUit === 'uit'}">✈️ Uit</button></div></div>
      </div>
      <p class="hint" id="opp-hint" aria-live="polite"></p>
      ${fxHintHTML(d)}`;
    renderOppHint();
  }
  function fxHintHTML(d) {
    if (!Cal.fixtures.length) return '';
    const same = fxFn('onDate', [Cal.fixtures, d.datum], [])[0];
    const nameMatches = f => { const t = nameKey(d.tegenstander); return t && (nameKey(fxShort(f)) === t || nameKey(f.tegenstander) === t); };
    if (same && nameMatches(same) && (same.thuisUit || 'thuis') === d.thuisUit) {
      return `<p class="fx-line">📅 ${esc(fxWhen(same))} · ${esc(fxMeta(same))}</p>`;
    }
    const f = same || (!d.tegenstander.trim() && !d.periodes ? fxFn('next', [Cal.fixtures], null) : null);
    if (!f) return '';
    return `<div class="fx-suggest"><span class="fx-suggest__txt"><small>${same ? 'Volgens de kalender' : 'Volgende wedstrijd'}</small>
        <b>${esc(fxShort(f))}</b> <span>${esc(fxWhen(f))} · ${f.thuisUit === 'uit' ? '✈️ uit' : '🏠 thuis'}</span></span>
      <button type="button" class="btn btn--primary btn--sm" data-act="fx-use" data-id="${esc(f.id)}">Overnemen</button></div>`;
  }
  function renderOppHint() {
    const el = $('#opp-hint'); if (!el) return;
    const t = nameKey(S.draft.tegenstander);
    const prev = t ? St.getMatches().filter(m => nameKey(m.tegenstander) === t && !sameId(m.id, S.draft.savedId)).sort(byDate).pop() : null;
    if (!prev) { el.textContent = ''; el.hidden = true; return; }
    const r = resultOf(prev);
    el.hidden = false;
    el.innerHTML = `Vorige keer tegen ${esc(prev.tegenstander)} (${esc(fmtDate(prev.datum))}): ` +
      (r ? `${RESULT_ICON[r]} <b>${prev.score.home}–${prev.score.away}</b> ${RESULT_LABEL[r].toLowerCase()}` : 'nog geen uitslag');
  }
  function renderAanwezig() {
    const el = $('#w-aanwezig'); if (!el) return;
    const d = S.draft; const sq = St.getSquad();
    const active = sq.players.filter(p => p.active).map(p => p.name);
    const extra = d.aanwezig.filter(n => !active.includes(n) && !d.guests.includes(n)); // bv. inactief maar wel aanwezig
    const names = uniq(active.concat(extra, d.guests));
    const n = d.aanwezig.length; const min = MIN_PLAYERS();
    const chips = names.map(name => {
      const on = d.aanwezig.includes(name); const guest = d.guests.includes(name);
      return `<span class="pchip-wrap"><button type="button" class="pchip${on ? ' is-on' : ''}${guest ? ' pchip--guest' : ''}" data-act="att-toggle" data-name="${esc(name)}" aria-pressed="${on}">
        <span class="pchip__check" aria-hidden="true">${on ? '✓' : ''}</span><span class="pchip__name">${esc(name)}</span>${guest ? '<span class="pchip__tag">gast</span>' : ''}</button>${guest ? `<button type="button" class="pchip__x" data-act="remove-guest" data-name="${esc(name)}" aria-label="Gast ${esc(name)} verwijderen">✕</button>` : ''}</span>`;
    }).join('');
    let hint;
    if (n < min) hint = `<p class="note note--warn">⚠️ Minimaal ${min} spelers nodig${n ? ` (nu ${n})` : ''}.</p>`;
    else if (n < 6) {
      const f = (C().formationFor || FALLBACK_CFG.formationFor)(n);
      hint = `<p class="note note--info">${n} spelers → geen wissels, je speelt met ${f.V} verdediger${f.V === 1 ? '' : 's'}, ${f.M} middenvelder en ${f.S} spits${f.S === 1 ? '' : 'en'}.</p>`;
    } else {
      const w = n - 6;
      hint = `<p class="note note--info">${n} spelers → <b>${w}</b> wissel${w === 1 ? '' : 's'} per periode${w === 0 ? ' (iedereen speelt alles)' : ''}${w > 4 ? ' — dat zijn er wel veel' : ''}.</p>`;
    }
    el.innerHTML = `<div class="card__head"><h2 class="card__title"><span class="step-num" aria-hidden="true">2</span> Aanwezig <span class="count-badge">${n}</span></h2>
      <div class="mini-actions"><button type="button" class="link-btn" data-act="att-all">Alle</button><button type="button" class="link-btn" data-act="att-none">Geen</button></div></div>
      <div class="pchips">${chips}<button type="button" class="pchip pchip--add" data-act="add-guest">＋ gastspeler</button></div>
      ${hint}`;
  }
  function renderKeepers() {
    const el = $('#w-keepers'); if (!el) return;
    const d = S.draft;
    const counts = keeperCounts(historyExcl(d.savedId));
    const avoidK = avoidSet('K');
    const opts = selName => `<option value="">— kies keeper —</option>` + d.aanwezig.map(n =>
      `<option value="${esc(n)}"${n === selName ? ' selected' : ''}>${esc(n)} · ${counts[n] ? `${perTxt(counts[n])} gekeept` : 'nog niet gekeept'}${avoidK.has(n) ? ' · liever niet' : ''}</option>`).join('');
    const halves = halvesOf(d.periods);
    let rows;
    if (d.sameKeeper || halves.length < 2) {
      rows = `<label class="keeper-row"><span class="keeper-row__label">Hele wedstrijd</span>
        <select class="input select" data-change="keeper" data-half="all">${opts(d.keepers[0])}</select></label>`;
    } else {
      rows = halves.map((idx, h) => {
        const mixed = idx.some(i => d.keepers[i] !== d.keepers[idx[0]]);
        return `<label class="keeper-row"><span class="keeper-row__label">${h === 0 ? '1e' : '2e'} helft <small>${rangeLabel(idx)}</small></span>
          <select class="input select" data-change="keeper" data-half="${h}">${opts(d.keepers[idx[0]])}</select>
          ${mixed ? `<small class="keeper-row__note">In het schema aangepast: ${idx.map(i => `P${i + 1} ${esc(d.keepers[i] || '–')}`).join(', ')}</small>` : ''}</label>`;
      }).join('');
    }
    const sug = suggestKeepersFor(d);
    const sugNames = uniq(sug.filter(Boolean));
    let hint = '';
    if (sugNames.length) {
      if (!historyExcl(d.savedId).length) hint = '💡 Nog geen wedstrijden opgeslagen — kies gerust wie graag wil keepen.';
      else if (sugNames.length === 1) hint = `💡 <b>${esc(sugNames[0])}</b> heeft dit seizoen het minst gekeept (${perTxt(counts[sugNames[0]] || 0)}).`;
      else hint = `💡 ${sugNames.map(n => `<b>${esc(n)}</b> (${perTxt(counts[n] || 0)})`).join(' en ')} hebben dit seizoen het minst gekeept.`;
      const cur = d.sameKeeper ? Array(d.periods).fill(sug[0]) : sug;
      const differs = JSON.stringify(cur) !== JSON.stringify(d.keepers);
      if (differs) hint += ` <button type="button" class="link-btn" data-act="keeper-suggest">Gebruik voorstel</button>`;
    }
    const missing = !keepersValid(d) && d.aanwezig.length >= MIN_PLAYERS();
    el.innerHTML = `<h2 class="card__title"><span class="step-num" aria-hidden="true">3</span> Keepers</h2>
      <div class="keeper-rows">${rows}</div>
      ${halves.length > 1 ? `<label class="switch"><input type="checkbox" data-change="same-keeper"${d.sameKeeper ? ' checked' : ''}><span class="switch__track" aria-hidden="true"></span><span>Zelfde keeper hele wedstrijd</span></label>` : ''}
      ${hint ? `<p class="hint">${hint}</p>` : ''}
      ${missing ? '<p class="note note--warn">⚠️ Kies voor elke helft een keeper.</p>' : ''}`;
  }
  function renderGenerate() {
    const el = $('#w-generate'); if (!el) return;
    const d = S.draft;
    if (d.periodes && !isStale(d)) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    const ready = d.aanwezig.length >= MIN_PLAYERS() && keepersValid(d);
    const nHist = historyExcl(d.savedId).length;
    const label = d.periodes ? '⚡ Werk schema bij' : '⚡ Maak wisselschema';
    el.innerHTML = `<div class="gen-block">
      <button type="button" class="btn btn--primary btn--xl" data-act="generate"${ready ? '' : ' aria-disabled="true"'}>${label}</button>
      <p class="hint hint--center">${ready
        ? (nHist ? `Houdt rekening met ${nHist} eerdere wedstrijd${nHist === 1 ? '' : 'en'} voor een eerlijke verdeling.` : 'Eerlijk verdeeld over de periodes.')
        : 'Kies eerst wie er zijn en wie er keept.'}${d.periodes && d.locks.length ? ` Vastgezette posities (${d.locks.length}) blijven staan.` : ''}</p></div>`;
  }
  function evaluateDraft(d) {
    const f = modFn('Scheduler', 'evaluate');
    let ev = null;
    if (f) {
      try { ev = f(clone(d.periodes), { players: d.aanwezig.slice(), keepers: d.keepers.slice(), history: historyExcl(d.savedId), squad: St.getSquad() }); }
      catch (e) { reportError(e, 'Controle van het schema mislukte.'); }
    }
    ev = ev && typeof ev === 'object' ? ev : {};
    const perPlayer = ev.perPlayer && typeof ev.perPlayer === 'object' ? ev.perPlayer : {};
    d.aanwezig.forEach(n => {
      if (perPlayer[n]) return;
      const c = { field: 0, sub: 0, K: 0, V: 0, M: 0, S: 0 };
      d.periodes.forEach(per => { const code = codeOf(per, n); if (code === 'W') c.sub++; else if (code) { c.field++; c[code]++; } });
      perPlayer[n] = c;
    });
    return { warnings: Array.isArray(ev.warnings) ? ev.warnings : [], perPlayer, score: typeof ev.score === 'number' && isFinite(ev.score) ? ev.score : null };
  }
  function fairHTML(score) {
    if (score == null) return '';
    const s = Math.round(clamp(score, 0, 100));
    const lvl = s >= 85 ? 'good' : s >= 70 ? 'ok' : s >= 50 ? 'meh' : 'bad';
    const word = { good: 'Heel eerlijk', ok: 'Eerlijk', meh: 'Kan eerlijker', bad: 'Niet eerlijk' }[lvl];
    return `<div class="fair fair--${lvl}">
      <div class="fair__top"><span class="fair__label">Eerlijkheid</span><span class="fair__word">${word}</span><b class="fair__score">${s}<small>/100</small></b></div>
      <div class="meter" role="meter" aria-label="Eerlijkheidsscore" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${s}"><span style="width:${s}%"></span></div></div>`;
  }
  function perPlayerHTML(d, ev) {
    const names = orderNames(d.aanwezig.slice(), d.aanwezig);
    const subs = names.map(n => (ev.perPlayer[n] || {}).sub || 0);
    const avg = subs.reduce((a, b) => a + b, 0) / (subs.length || 1);
    return `<div class="pp-list">${names.map(n => {
      const c = ev.perPlayer[n] || {};
      const segs = d.periodes.map((per, p) => { const code = codeOf(per, n) || 'none'; return `<span class="pp__seg pb--${code}" title="P${p + 1}: ${esc(code === 'none' ? '–' : POS(code).label)}"></span>`; }).join('');
      const hi = (c.sub || 0) > avg + 0.5;
      return `<div class="pp"><span class="pp__name">${esc(n)}</span><span class="pp__bar" aria-hidden="true">${segs}</span>
        <span class="pp__nums${hi ? ' is-hi' : ''}">${c.field || 0}<small> veld</small> · ${c.sub || 0}<small> wissel</small></span></div>`;
    }).join('')}</div>`;
  }
  function renderSchema() {
    const el = $('#w-schema'); if (!el) return;
    const d = S.draft;
    if (!d.periodes) { el.hidden = true; el.innerHTML = ''; setSelbar(); return; }
    el.hidden = false;
    // carrousel-positie bewaren
    const car = $('.periods[data-carousel]', el); if (car) S.carouselX[car.dataset.carousel] = car.scrollLeft;
    const stale = isStale(d);
    const ev = evaluateDraft(d);
    const warnings = uniq(ev.warnings.concat(S.genWarnings || []));
    const times = periodTimes(d.periods, settings().minutes);
    const o = { editable: true, locks: d.locks, sel: S.sel, order: d.aanwezig, times, key: 'editor' };
    el.innerHTML = `<div class="card__head"><h2 class="card__title"><span class="step-num" aria-hidden="true">4</span> Wisselschema</h2>${viewToggleHTML(S.view, 'view')}</div>
      ${stale ? `<div class="note note--warn stale">Aanwezigheid of keepers zijn gewijzigd. <button type="button" class="btn btn--primary btn--sm" data-act="generate">⚡ Werk bij</button></div>` : ''}
      ${fairHTML(ev.score)}
      ${warnings.length ? `<ul class="warnings">${warnings.map(w => `<li>⚠️ ${esc(w)}</li>`).join('')}</ul>` : (ev.score != null ? '<p class="note note--ok">✓ Geen aandachtspunten — iedereen komt eerlijk aan bod.</p>' : '')}
      <div class="schema-view schema-view--${S.view}">${S.view === 'tabel' ? tabelHTML(d.periodes, o) + legendHTML() : veldHTML(d.periodes, o)}</div>
      <p class="hint hint--edit">✋ Tik een speler en daarna een tweede in dezelfde periode om ze te <b>ruilen</b>. Nog een keer tikken = meer opties.</p>
      <div class="toolbar">
        <button type="button" class="btn btn--secondary" data-act="reshuffle">🔀 Ander schema</button>
        <button type="button" class="btn btn--secondary" data-act="undo"${S.undo.length ? '' : ' disabled'}>↩️ Ongedaan</button>
        ${d.locks.length ? `<button type="button" class="btn btn--ghost" data-act="unlock-all">🔓 Alles los (${d.locks.length})</button>` : ''}
      </div>
      <details class="pp-details"${S.ppOpen ? ' open' : ''} data-toggle="pp"><summary>Speeltijd per speler</summary>${perPlayerHTML(d, ev)}</details>`;
    bindCarousel(el);
    setSelbar();
  }
  function setSelbar() {
    let bar = doc.getElementById('selbar');
    const d = S.draft;
    const sel = S.screen === 'wedstrijd' && S.sel && d && d.periodes ? S.sel : null;
    if (!sel) { if (bar) bar.remove(); doc.body.classList.remove('has-selbar'); return; }
    const code = codeOf(d.periodes[sel.p], sel.name);
    const locked = isLocked(d.locks, sel.p, sel.name);
    if (!bar) { bar = doc.createElement('div'); bar.id = 'selbar'; bar.className = 'selbar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Geselecteerde speler'); doc.body.appendChild(bar); }
    bar.innerHTML = `<div class="selbar__text"><b>${esc(sel.name)}</b> · P${sel.p + 1} · ${esc(POS(code).label)}<small>Tik een speler in periode ${sel.p + 1} om te ruilen</small></div>
      <div class="selbar__btns">
        <button type="button" class="btn btn--sm btn--secondary" data-act="chip-menu">Positie…</button>
        <button type="button" class="icon-btn icon-btn--solid" data-act="chip-lock" aria-pressed="${locked}" aria-label="${locked ? 'Losmaken' : 'Vastzetten'}" title="${locked ? 'Losmaken' : 'Vastzetten'}">${locked ? '🔓' : '🔒'}</button>
        <button type="button" class="icon-btn icon-btn--solid" data-act="sel-clear" aria-label="Selectie opheffen">✕</button></div>`;
    doc.body.classList.add('has-selbar');
  }
  function renderActions() {
    const el = $('#w-actions'); if (!el) return;
    const d = S.draft;
    if (!d.periodes) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const saved = d.savedId != null ? findMatch(d.savedId) : null;
    const status = saved && !d.dirty ? `<p class="saved-line is-saved">✓ Opgeslagen${saved.updatedAt ? ` om ${new Date(saved.updatedAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}` : ''}</p>`
      : saved ? '<p class="saved-line is-dirty">● Wijzigingen nog niet opgeslagen</p>' : '<p class="saved-line">Nog niet opgeslagen</p>';
    const saveLabel = !saved ? '✅ Opslaan' : d.dirty ? '💾 Wijzigingen opslaan' : '✓ Opgeslagen';
    el.innerHTML = `<h2 class="card__title"><span class="step-num" aria-hidden="true">5</span> Klaar!</h2>
      ${status}
      <div class="btn-grid">
        <button type="button" class="btn ${saved && !d.dirty ? 'btn--secondary' : 'btn--success'} btn--lg" data-act="save">${saveLabel}</button>
        <button type="button" class="btn btn--secondary btn--lg" data-act="share">📤 Delen</button>
        <button type="button" class="btn btn--primary btn--lg btn-grid__wide" data-act="start-live">▶️ Start live</button>
      </div>
      ${saved ? `<div class="subcard"><h3 class="subcard__title">⚽ Uitslag</h3>${scoreEditorHTML(saved)}</div>` : ''}
      <button type="button" class="btn btn--ghost btn--block" data-act="new-match">🆕 Nieuwe wedstrijd</button>`;
  }
  function scoreEditorHTML(m) {
    const s = m.score;
    return `<form class="score-edit" data-form="score" data-id="${esc(m.id)}" novalidate>
      <div class="score-edit__row">
        <label class="score-edit__team"><span class="score-edit__name">${esc(TEAM())}</span>
          <input class="score-num" name="home" type="number" inputmode="numeric" min="0" max="99" value="${s ? s.home : ''}" placeholder="–" aria-label="Doelpunten ${esc(TEAM())}"></label>
        <span class="score-edit__dash" aria-hidden="true">–</span>
        <label class="score-edit__team"><span class="score-edit__name">${esc(m.tegenstander || 'Tegenstander')}</span>
          <input class="score-num" name="away" type="number" inputmode="numeric" min="0" max="99" value="${s ? s.away : ''}" placeholder="–" aria-label="Doelpunten ${esc(m.tegenstander || 'tegenstander')}"></label>
      </div>
      <div class="score-edit__btns"><button type="submit" class="btn btn--primary btn--sm">💾 Uitslag opslaan</button>
        ${s ? `<button type="button" class="btn btn--ghost btn--sm" data-act="score-clear" data-id="${esc(m.id)}">Wissen</button>` : ''}</div>
    </form>`;
  }
  function refreshDraftUI(parts) {
    if (S.screen !== 'wedstrijd') return;
    (parts || ['info', 'aanwezig', 'keepers', 'generate', 'schema', 'actions']).forEach(p => ({
      info: renderInfo, aanwezig: renderAanwezig, keepers: renderKeepers, generate: renderGenerate, schema: renderSchema, actions: renderActions,
    })[p]());
    renderProgress();
  }

  // ── Wedstrijd: acties ──────────────────────────────────────────────
  function toggleAttendance(name) {
    const d = S.draft;
    if (d.aanwezig.includes(name)) d.aanwezig = d.aanwezig.filter(n => n !== name);
    else {
      // in selectie-volgorde terugzetten
      const order = St.getSquad().players.map(p => p.name).concat(d.guests);
      d.aanwezig = orderNames(d.aanwezig.concat(name), order);
    }
    ensureKeepers(d); changed();
    refreshDraftUI(['aanwezig', 'keepers', 'generate', 'schema', 'actions']);
  }
  function cleanLocks(d) {
    return (d.locks || []).filter(l => {
      if (!d.aanwezig.includes(l.player) || l.period >= d.periods || l.period < 0) return false;
      const k = d.keepers[l.period];
      if (l.code === 'K') return k === l.player;
      return k !== l.player;
    }).map(l => ({ period: l.period, player: l.player, code: l.code }));
  }
  function pushUndo() {
    const d = S.draft;
    S.undo.push(clone({ periodes: d.periodes, keepers: d.keepers, locks: d.locks, sig: d.sig, sameKeeper: d.sameKeeper }));
    if (S.undo.length > 30) S.undo.shift();
    dismissActionToasts();
  }
  function doUndo() {
    const snap = S.undo.pop(); if (!snap) return;
    dismissActionToasts();
    Object.assign(S.draft, snap); S.draft.dirty = true; S.sel = null; S.genWarnings = [];
    persistDraft();
    refreshDraftUI(['keepers', 'generate', 'schema', 'actions']);
    toast('Laatste wijziging teruggedraaid', 'info');
  }
  function doGenerate(newSeed) {
    const d = S.draft;
    if (d.aanwezig.length < MIN_PLAYERS()) { toast(`Minimaal ${MIN_PLAYERS()} spelers nodig.`, 'warn'); scrollIntoView($('#w-aanwezig')); return; }
    if (!keepersValid(d)) { toast('Kies eerst de keepers.', 'warn'); scrollIntoView($('#w-keepers')); return; }
    if (!modFn('Scheduler', 'generate')) { reportError(new Error('Scheduler ontbreekt'), 'De rekenmodule is niet geladen — herlaad de pagina.'); return; }
    const first = !d.periodes;
    const locks = cleanLocks(d);
    const before = d.periodes ? JSON.stringify(d.periodes) : null;
    let res = null; let seed = d.seed || randSeed();
    for (let attempt = 0; attempt < (newSeed ? 6 : 1); attempt++) {
      if (newSeed) seed = randSeed();
      res = callMod('Scheduler', 'generate', [{
        players: d.aanwezig.slice(), keepers: d.keepers.slice(), periods: d.periods,
        history: historyExcl(d.savedId), squad: St.getSquad(), seed, locks: clone(locks),
      }], null, 'Het schema kon niet gemaakt worden.');
      if (!res || !Array.isArray(res.periodes) || !res.periodes.length) break;
      if (!newSeed || JSON.stringify(res.periodes.map(normPeriod)) !== before) break;
    }
    if (!res || !Array.isArray(res.periodes) || !res.periodes.length) { if (res) toast('Het schema kon niet gemaakt worden.', 'error'); return; }
    if (d.periodes) pushUndo();
    d.periodes = res.periodes.map(normPeriod);
    d.periods = d.periodes.length;
    d.periodes.forEach((per, i) => {
      const rk = Array.isArray(res.keepers) ? res.keepers[i] : null;
      const k = rk && per.posities[rk] === 'K' ? rk : Object.keys(per.posities).find(n => per.posities[n] === 'K');
      if (k) d.keepers[i] = k;
    });
    d.seed = seed; d.locks = locks; d.sig = sigOf(d); d.dirty = true;
    S.sel = null;
    S.genWarnings = Array.isArray(res.warnings) ? res.warnings.filter(w => typeof w === 'string') : [];
    persistDraft();
    if (newSeed && before && JSON.stringify(d.periodes) === before) toast('Geen ander schema mogelijk met deze keuzes en vastzettingen.', 'info');
    else if (newSeed) toast('Nieuw schema gemaakt', 'success', { action: { label: 'Ongedaan', fn: doUndo } });
    refreshDraftUI(['keepers', 'generate', 'schema', 'actions']);
    if (first) setTimeout(() => scrollIntoView($('#w-schema')), 30);
  }
  function afterEdit(msg) {
    const d = S.draft;
    d.sig = sigOf(d); d.dirty = true; S.genWarnings = [];
    persistDraft();
    refreshDraftUI(['keepers', 'schema', 'actions']);
    if (msg) toast(msg, 'info', { action: { label: 'Ongedaan', fn: doUndo }, ms: 3500 });
  }
  function moveLock(d, p, name, code) { d.locks.forEach(l => { if (l.period === p && l.player === name) l.code = code; }); }
  function doSwap(p, a, b) {
    const d = S.draft; const per = d.periodes[p];
    const ca = codeOf(per, a), cb = codeOf(per, b);
    if (!ca || !cb) return;
    if (ca === cb) { S.sel = null; renderSchema(); toast(`${a} en ${b} staan al allebei op ${POS(ca).label.toLowerCase()}.`, 'info'); return; }
    pushUndo();
    setCode(per, a, cb); setCode(per, b, ca);
    if (ca === 'K') d.keepers[p] = b;
    if (cb === 'K') d.keepers[p] = a;
    moveLock(d, p, a, cb); moveLock(d, p, b, ca);
    S.sel = null;
    afterEdit(`P${p + 1}: ${a} ⇄ ${b}`);
  }
  function partnerFor(d, p, name, code) {
    const per = d.periodes[p];
    const cands = namesOf([per]).filter(n => n !== name && codeOf(per, n) === code);
    cands.sort((x, y) => isLocked(d.locks, p, x) - isLocked(d.locks, p, y));
    return cands[0] || null;
  }
  function doSetPos(p, name, code) {
    const d = S.draft; const per = d.periodes[p];
    const cur = codeOf(per, name);
    closeSheet(true);
    if (cur === code) { S.sel = null; renderSchema(); return; }
    const partner = partnerFor(d, p, name, code);
    if (partner) { doSwap(p, name, partner); return; }
    pushUndo();
    setCode(per, name, code);
    if (code === 'K') d.keepers[p] = name;
    else if (cur === 'K') d.keepers[p] = '';
    moveLock(d, p, name, code);
    S.sel = null;
    afterEdit(`P${p + 1}: ${name} → ${POS(code).label}`);
  }
  function toggleLock(p, name) {
    const d = S.draft;
    const code = codeOf(d.periodes[p], name); if (!code) return;
    pushUndo();
    if (isLocked(d.locks, p, name)) { d.locks = d.locks.filter(l => !(l.period === p && l.player === name)); toast(`${name} in P${p + 1} losgemaakt`, 'info'); }
    else { d.locks.push({ period: p, player: name, code }); toast(`🔒 ${name} staat vast als ${POS(code).label.toLowerCase()} in P${p + 1}. “Ander schema” houdt dit vast.`, 'success'); }
    d.dirty = true; persistDraft();
    renderSchema(); renderGenerate();
  }
  function onChip(p, name) {
    const sel = S.sel;
    if (!sel) { S.sel = { p, name }; renderSchema(); return; }
    if (sel.p === p && sel.name === name) { openChipSheet(p, name); return; }
    if (sel.p === p) { doSwap(p, sel.name, name); return; }
    S.sel = { p, name }; renderSchema();
  }
  function openChipSheet(p, name) {
    const d = S.draft; const per = d.periodes[p]; if (!per) return;
    const cur = codeOf(per, name); const locked = isLocked(d.locks, p, name);
    const opts = EDIT_CODES.map(code => {
      const partner = code === cur ? null : partnerFor(d, p, name, code);
      const sub = code === cur ? 'huidige positie' : partner ? `ruilt met ${partner}` : '';
      return `<button type="button" class="opt opt--pos${code === cur ? ' is-current' : ''}" data-act="set-pos" data-p="${p}" data-name="${esc(name)}" data-code="${code}"${code === cur ? ' aria-current="true"' : ''}>
        <span class="pb pb--${code} pb--mini" aria-hidden="true">${esc(POS(code).short || code)}</span>
        <span class="opt__text"><b>${esc(POS(code).icon)} ${esc(POS(code).label)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${code === cur ? '<span class="opt__check" aria-hidden="true">✓</span>' : ''}</button>`;
    }).join('');
    openSheet({
      title: `${esc(name)} <small class="sheet__sub">Periode ${p + 1}</small>`,
      body: `<div class="opt-list">${opts}</div>
        <button type="button" class="opt opt--lock" data-act="toggle-lock" data-p="${p}" data-name="${esc(name)}">
          <span class="opt__icon" aria-hidden="true">${locked ? '🔓' : '🔒'}</span><span class="opt__text"><b>${locked ? 'Losmaken' : 'Vastzetten'}</b><small>${locked ? 'Mag weer verschuiven bij een nieuw schema' : 'Blijft staan bij “Ander schema”'}</small></span></button>`,
      onClose: () => { S.sel = null; renderSchema(); },
    });
  }
  function buildMatch(d) {
    const existing = d.savedId != null ? findMatch(d.savedId) : null;
    const tegenstander = d.tegenstander.trim() || 'Onbekend';
    const periodes = d.periodes.map(per => {
      const posities = {}; Object.entries(per.posities).forEach(([n, c]) => { if (FIELD.includes(c)) posities[n] = c; });
      return { posities, wissels: per.wissels.filter(n => !posities[n]) };
    });
    return Object.assign({}, existing || {}, {
      id: existing ? existing.id : (d.savedId != null ? d.savedId : Date.now()),
      titel: titelOf(tegenstander, d.thuisUit),
      datum: d.datum || todayISO(),
      tegenstander, thuisUit: d.thuisUit,
      score: existing && existing.score ? existing.score : null,
      periodes, v: 2, aanwezig: d.aanwezig.slice(), keepers: d.keepers.slice(),
    });
  }
  // Eén opslag tegelijk: een dubbele tik (of "Opslaan" + "Start live") tijdens een trage Firebase-flush
  // mag geen tweede wedstrijd met een nieuw Date.now()-id aanmaken.
  let savePending = null;
  function doSave() {
    if (savePending) return savePending;
    savePending = doSaveNow().finally(() => { savePending = null; });
    return savePending;
  }
  async function doSaveNow() {
    const d = S.draft;
    if (!d.periodes || !d.periodes.length) { toast('Maak eerst een wisselschema — zonder schema kan er niets opgeslagen worden.', 'warn'); scrollIntoView($('#w-generate')); return null; }
    if (isStale(d)) {
      const ok = await confirmDialog({ title: 'Schema is niet bijgewerkt', message: 'Aanwezigheid of keepers zijn gewijzigd na het maken van het schema. Toch dit schema opslaan?', ok: 'Toch opslaan', cancel: 'Eerst bijwerken' });
      if (!ok) { scrollIntoView($('#w-schema')); return null; }
    }
    const match = buildMatch(d);
    let saved;
    try { saved = await St.saveMatch(match); } catch (e) {
      // Store.saveMatch schrijft lokaal vóór de (eventueel time-out-ende) flush: staat hij er toch, dan id vasthouden.
      if (findMatch(match.id)) { d.savedId = match.id; persistDraft(true); }
      reportError(e, errMsg(e, 'Opslaan mislukt. Probeer het nog eens.')); return null;
    }
    const rec = saved && saved.id != null ? saved : match;
    d.savedId = rec.id; d.dirty = false;
    persistDraft(true);
    refreshDraftUI(['info', 'actions']);
    toast('Opgeslagen ✓', 'success');
    return rec;
  }
  async function startLiveFromDraft() {
    const d = S.draft;
    let m = d.savedId != null && !d.dirty ? findMatch(d.savedId) : null;
    if (!m) m = await doSave();
    if (m) go('live', { matchId: m.id, top: true });
  }
  async function newMatch() {
    if (hasUnsaved(S.draft)) {
      const ok = await confirmDialog({ title: 'Nieuwe wedstrijd?', message: 'Je huidige schema is nog niet opgeslagen. Weggooien en opnieuw beginnen?', ok: 'Ja, nieuwe wedstrijd', danger: true });
      if (!ok) return;
    }
    S.draft = newDraft(); S.undo = []; S.sel = null; S.genWarnings = []; S.carouselX = {};
    persistDraft(true);
    renderWedstrijd();
    root.scrollTo(0, 0);
    toast('Nieuwe wedstrijd gestart', 'info');
  }
  async function addGuest() {
    const name = await promptDialog({ title: 'Gastspeler toevoegen', label: 'Naam', placeholder: 'bijv. Sam (JO9)', ok: 'Toevoegen', hint: 'Alleen voor deze wedstrijd. Vaste spelers voeg je toe bij 👥 Team.' });
    if (name == null) return;
    const n = name.trim().replace(/\s+/g, ' ');
    if (!n) return;
    const err = nameError(n);
    if (err) { toast(err, 'warn'); return; }
    const d = S.draft;
    const all = St.getSquad().players.map(p => p.name).concat(d.guests);
    const existing = all.find(x => nameKey(x) === nameKey(n));
    if (existing) {
      if (!d.aanwezig.includes(existing)) toggleAttendance(existing);
      toast(`${existing} staat er al bij`, 'info'); return;
    }
    d.guests.push(n); d.aanwezig.push(n);
    ensureKeepers(d); changed();
    refreshDraftUI(['aanwezig', 'keepers', 'generate', 'schema', 'actions']);
    toast(`${n} toegevoegd als gast`, 'success');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Delen (PNG / WhatsApp / Excel)
  // ═══════════════════════════════════════════════════════════════════
  function openShare(match) {
    S.shareMatch = match;
    openSheet({
      title: 'Delen',
      body: `<div class="opt-list">
        <button type="button" class="opt" data-act="share-wa"><span class="opt__icon" aria-hidden="true">💬</span><span class="opt__text"><b>WhatsApp-tekst</b><small>Opstelling per periode als bericht</small></span></button>
        <button type="button" class="opt" data-act="share-png"><span class="opt__icon" aria-hidden="true">🖼️</span><span class="opt__text"><b>Afbeelding (PNG)</b><small>Handig voor de ouder-app</small></span></button>
        <button type="button" class="opt" data-act="share-xlsx"><span class="opt__icon" aria-hidden="true">📗</span><span class="opt__text"><b>Excel</b><small>Zelfde indeling als vroeger</small></span></button>
      </div>`,
    });
  }
  function fallbackWhatsapp(m, st) {
    const times = periodTimes(m.periodes.length, st.minutes);
    const lines = [`⚽ *${m.titel}*`, fmtDate(m.datum, { weekday: 'long', day: 'numeric', month: 'long' }), ''];
    m.periodes.forEach((per, i) => {
      const g = groupByCode(per, m.aanwezig);
      lines.push(`*Periode ${i + 1}* (${times[i]})`);
      FIELD.forEach(c => { if (g[c].length) lines.push(`${POS(c).icon} ${g[c].join(', ')}`); });
      lines.push(`🪑 ${g.W.join(', ') || '–'}`, '');
    });
    return lines.join('\n').trim();
  }
  async function shareWhatsapp(m) {
    const st = settingsFor(m);
    let text = null;
    const f = modFn('IO', 'whatsappText');
    if (f) { try { text = f(m, { settings: st }); } catch (e) { console.warn(e); } }
    if (!text) text = fallbackWhatsapp(m, st);
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    let copied = false;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); copied = true; } } catch (e) { copied = false; }
    toast(copied ? 'Tekst gekopieerd — WhatsApp wordt geopend' : 'WhatsApp wordt geopend', 'success');
    try { root.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener'); } catch (e) { /* popup geblokkeerd */ }
  }
  async function sharePNG(m) {
    const f = modFn('IO', 'exportPNG');
    if (!f) { reportError(new Error('IO.exportPNG ontbreekt'), 'De exportmodule is niet geladen.'); return; }
    try { await f(m, { settings: settingsFor(m) }); } catch (e) { if (!(e && e.name === 'AbortError')) reportError(e, 'Afbeelding maken mislukt.'); }
  }
  function shareExcel(matches) {
    if (typeof root.XLSX === 'undefined') { toast('Excel is nu niet beschikbaar (geen internet?). Probeer het later nog eens.', 'warn'); return; }
    const f = modFn('IO', 'exportExcel');
    if (!f) { reportError(new Error('IO.exportExcel ontbreekt'), 'De exportmodule is niet geladen.'); return; }
    try { f(matches, { settings: settings() }); toast('Excel-bestand gemaakt', 'success'); } catch (e) { reportError(e, 'Excel maken mislukt.'); }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Scherm: Live
  // ═══════════════════════════════════════════════════════════════════
  function unmountLive() {
    if (S.liveMounted == null) return;
    S.liveMounted = null;
    const f = modFn('Live', 'unmount');
    if (f) try { f(); } catch (e) { console.warn('[JO10] Live.unmount', e); }
  }
  function exitLive() {
    const id = S.liveMounted;
    unmountLive();
    S.liveMatchId = null; saveUI();
    if (S.screen === 'live') renderLive();
    // Live wist zijn klokstatus alleen bij "Afronden"; bij "‹ Terug" loopt de klok door.
    let running = false;
    try { running = String(id) in JSON.parse(localStorage.getItem(C().LS_LIVE || 'jo10_live_v2') || '{}'); } catch (e) { /* negeren */ }
    if (id != null && !running) {
      const m = rawMatch(id), sc = m && m.score;
      toast(sc ? `🏁 Eindstand ${sc.home}–${sc.away} opgeslagen` : '🏁 Wedstrijd afgerond', 'success');
    } else if (id != null) {
      toast('⏱️ De klok loopt door — tik de wedstrijd aan om terug te gaan.');
    }
  }
  // Live geeft alleen een patch { id, score, goals }. Altijd mergen in de ACTUELE versie uit de Store, zodat
  // wijzigingen van een ander toestel (opstelling, notitie…) niet door een verouderde kopie overschreven worden.
  const LIVE_FIELDS = ['score', 'goals'];
  function onLiveUpdate(patch) {
    if (!patch || patch.id == null) return;
    const cur = rawMatch(patch.id);
    if (!cur) { reportError(new Error('live: wedstrijd niet gevonden'), 'Deze wedstrijd bestaat niet meer — live-stand niet opgeslagen.'); return; }
    const next = Object.assign({}, cur);
    LIVE_FIELDS.forEach(k => { if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = clone(patch[k]); });
    Promise.resolve().then(() => St.saveMatch(next)).catch(e => reportError(e, errMsg(e, 'Opslaan van de live-stand mislukt.')));
  }
  function mountLive(el, m) {
    if (sameId(S.liveMounted, m.id) && $('#live-host', el)) return;
    unmountLive();
    if (!modFn('Live', 'mount')) {
      el.innerHTML = `<div class="container"><div class="card empty"><div class="empty__icon" aria-hidden="true">⏱️</div>
        <p><b>De live-module is niet geladen.</b></p><p class="hint">Herlaad de pagina of probeer het straks opnieuw.</p>
        <button type="button" class="btn btn--secondary" data-act="live-exit">← Terug</button></div></div>`;
      reportError(new Error('Live ontbreekt'), 'De live-module is niet geladen.');
      return;
    }
    el.innerHTML = '<div class="live-host" id="live-host"></div>';
    try {
      JO10.Live.mount($('#live-host', el), { match: clone(m), settings: settingsFor(m), onUpdate: onLiveUpdate, onExit: exitLive });
      S.liveMounted = m.id;
    } catch (e) {
      S.liveMounted = null; S.liveMatchId = null; saveUI();
      reportError(e, 'Live-modus kon niet starten.');
      renderLiveList(el);
    }
  }
  function renderLive() {
    const el = screenEl('live');
    if (S.liveMatchId != null) {
      const m = findMatch(S.liveMatchId);
      if (m) { mountLive(el, m); return; }
      S.liveMatchId = null; saveUI();
    }
    unmountLive();
    renderLiveList(el);
  }
  function matchRowHTML(m, act, extra) {
    const r = resultOf(m);
    const badge = r ? `<span class="res res--${r}" title="${RESULT_LABEL[r]}">${r} <b>${m.score.home}–${m.score.away}</b></span>` : '<span class="res res--none">–</span>';
    const d = parseISO(m.datum);
    return `<button type="button" class="mrow" data-act="${act}" data-id="${esc(m.id)}">
      <span class="mrow__date" aria-hidden="true"><b>${d ? d.getDate() : '?'}</b><small>${d ? esc(d.toLocaleDateString('nl-NL', { month: 'short' })) : ''}</small></span>
      <span class="mrow__main"><span class="mrow__opp">${m.thuisUit === 'uit' ? '✈️' : '🏠'} ${esc(m.tegenstander || m.titel || 'Onbekend')}</span>
        <span class="mrow__meta">${esc(fmtDate(m.datum, { weekday: 'long', day: 'numeric', month: 'long' }))}</span></span>
      ${extra || badge}</button>`;
  }
  function renderLiveList(el) {
    const ms = St.getMatches(); const today = todayISO();
    const todays = ms.filter(m => m.datum === today).reverse();
    const recent = ms.filter(m => m.datum !== today).sort(byDate).reverse().slice(0, 6);
    const d = S.draft;
    const unsaved = d && d.periodes && (d.dirty || d.savedId == null);
    const goIcon = '<span class="mrow__go" aria-hidden="true">▶️</span>';
    el.innerHTML = `<div class="container">
      <div class="page-head"><h1 class="page-title">⏱️ Live</h1><p class="hint">Klok, wissels en score tijdens de wedstrijd.</p></div>
      ${unsaved ? `<div class="card card--accent"><p><b>Je opstelling${d.tegenstander ? ` tegen ${esc(d.tegenstander)}` : ''} is nog niet opgeslagen.</b></p>
        <button type="button" class="btn btn--primary btn--block btn--lg" data-act="start-live">▶️ Opslaan & live starten</button></div>` : ''}
      ${todays.length ? `<div class="card"><h2 class="card__title">Vandaag</h2><div class="mlist">${todays.map(m => matchRowHTML(m, 'live-match', goIcon)).join('')}</div></div>` : ''}
      ${recent.length ? `<div class="card"><h2 class="card__title">Andere wedstrijden</h2><div class="mlist">${recent.map(m => matchRowHTML(m, 'live-match', goIcon)).join('')}</div></div>` : ''}
      ${!todays.length && !recent.length && !unsaved ? `<div class="card empty"><div class="empty__icon" aria-hidden="true">📋</div>
        <p><b>Nog geen opstelling klaar.</b></p><p class="hint">Maak eerst een wisselschema, daarna kun je hier live meekijken.</p>
        <button type="button" class="btn btn--primary" data-act="go" data-screen="wedstrijd">⚽ Opstelling maken</button></div>` : ''}
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Scherm: Seizoen
  // ═══════════════════════════════════════════════════════════════════
  function fallbackStats(matches, names) {
    const out = {}; names.forEach(n => { out[n] = { matches: 0, periods: 0, K: 0, V: 0, M: 0, S: 0, W: 0 }; });
    matches.forEach(m => {
      const seen = new Set();
      (m.periodes || []).forEach(per => names.forEach(n => {
        const c = codeOf(per, n); if (!c) return;
        out[n][c]++; out[n].periods++; seen.add(n);
      }));
      seen.forEach(n => out[n].matches++);
    });
    return out;
  }
  function seasonRows(matches) {
    const sq = St.getSquad();
    const names = sq.players.map(p => p.name);
    let st = null;
    const f = modFn('Scheduler', 'stats');
    const hist = canonMatches(matches);
    if (f) { try { st = f(hist, names.slice()); } catch (e) { reportError(e, 'Statistiek kon niet berekend worden.'); } }
    if (!st || typeof st !== 'object') st = fallbackStats(hist, names);
    return sq.players.map(p => {
      const s = st[p.name] || {};
      const K = +s.K || 0, V = +s.V || 0, M = +s.M || 0, Sx = +s.S || 0, W = +s.W || 0;
      const played = K + V + M + Sx, total = played + W;
      return { name: p.name, active: p.active, matches: +s.matches || 0, K, V, M, S: Sx, W, total, pct: total ? Math.round(played / total * 100) : null };
    }).filter(r => r.active || r.total > 0);
  }
  function renderSeizoen() {
    const el = screenEl('seizoen');
    if (S.season.detailId != null) {
      const m = findMatch(S.season.detailId);
      if (m) { renderDetail(el, m); return; }
      S.season.detailId = null;
    }
    const ms = St.getMatches();
    const today = todayISO();
    const played = ms.filter(m => m.score || (m.datum && m.datum <= today));
    const scored = ms.filter(m => m.score);
    const rec = { W: 0, G: 0, V: 0 }; let gf = 0, ga = 0;
    scored.forEach(m => { rec[resultOf(m)]++; gf += m.score.home; ga += m.score.away; });
    const rows = seasonRows(ms);
    const { sort, dir } = S.season;
    rows.sort((a, b) => {
      const va = a[sort], vb = b[sort];
      if (sort === 'name') return dir * a.name.localeCompare(b.name);
      return dir * ((va == null ? -1 : va) - (vb == null ? -1 : vb)) || a.name.localeCompare(b.name);
    });
    const cols = [['name', 'Speler'], ['matches', 'Wed'], ['K', '🧤'], ['V', '🛡️'], ['M', '⚙️'], ['S', '⚡'], ['W', '🪑'], ['pct', 'Speeltijd']];
    const colTitle = { matches: 'Wedstrijden', K: 'Keeper', V: 'Verdediger', M: 'Middenveld', S: 'Spits', W: 'Wissel', pct: '% van de periodes gespeeld', name: 'Naam' };
    const th = cols.map(([k, l]) => {
      const active = sort === k;
      return `<th scope="col" class="st__th st__th--${k}" aria-sort="${active ? (dir > 0 ? 'ascending' : 'descending') : 'none'}">
        <button type="button" class="st__sort${active ? ' is-active' : ''}" data-act="sort" data-k="${k}" title="${esc(colTitle[k])}" aria-label="Sorteer op ${esc(colTitle[k])}">${l}<span class="st__arrow" aria-hidden="true">${active ? (dir > 0 ? '▲' : '▼') : ''}</span></button></th>`;
    }).join('');
    const tb = rows.map(r => `<tr${r.active ? '' : ' class="is-inactive"'}><th scope="row" class="st__name">${esc(r.name)}</th>
      <td>${r.matches || '–'}</td><td>${r.K || '–'}</td><td>${r.V || '–'}</td><td>${r.M || '–'}</td><td>${r.S || '–'}</td><td>${r.W || '–'}</td>
      <td class="st__pct">${r.pct == null ? '–' : `<span class="pbar" aria-hidden="true"><span style="width:${r.pct}%"></span></span><span>${r.pct}%</span>`}</td></tr>`).join('');
    // topscorers
    const goals = {};
    canonMatches(ms).forEach(m => (Array.isArray(m.goals) ? m.goals : []).forEach(g => { if (g && g.team === 'home' && g.by) goals[g.by] = (goals[g.by] || 0) + 1; }));
    const scorers = Object.entries(goals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
    const list = ms.slice().sort(byDate).reverse();
    el.innerHTML = `<div class="container">
      <div class="page-head"><h1 class="page-title">📊 Seizoen</h1></div>
      <div class="stat-cards">
        <div class="stat"><span class="stat__num">${played.length}</span><span class="stat__label">gespeeld</span></div>
        <div class="stat"><span class="stat__num stat__num--rec"><span class="c-W">${rec.W}</span>-<span class="c-G">${rec.G}</span>-<span class="c-V">${rec.V}</span></span><span class="stat__label">W-G-V</span></div>
        <div class="stat"><span class="stat__num">${gf}<small>–</small>${ga}</span><span class="stat__label">doelpunten</span></div>
      </div>
      ${trainingenHTML()}
      ${programmaHTML(ms)}
      <div class="card"><h2 class="card__title">Speeltijd & posities</h2>
        ${ms.length ? `<div class="table-wrap"><table class="st"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>
        <p class="hint">Aantal periodes per positie over ${ms.length} wedstrijd${ms.length === 1 ? '' : 'en'}. Tik op een kolomkop om te sorteren.</p>` : '<p class="hint">Nog geen wedstrijden opgeslagen.</p>'}
      </div>
      ${scorers.length ? `<div class="card"><h2 class="card__title">⚽ Topscorers</h2><ol class="scorers">${scorers.map(([n, c], i) => `<li><span class="scorers__rank">${i + 1}</span><span class="scorers__name">${esc(n)}</span><span class="scorers__n">${c}</span></li>`).join('')}</ol></div>` : ''}
      <div class="card"><h2 class="card__title">Wedstrijden <span class="count-badge">${list.length}</span></h2>
        ${list.length ? `<div class="mlist">${list.map(m => matchRowHTML(m, 'open-match')).join('')}</div>` : `<div class="empty"><p class="hint">Hier verschijnen je opgeslagen wedstrijden.</p><button type="button" class="btn btn--primary" data-act="go" data-screen="wedstrijd">⚽ Eerste opstelling maken</button></div>`}
      </div></div>`;
  }
  function programmaHTML(ms) {
    if (!JO10.Fixtures) return '';
    if (!Cal.fixtures.length) {
      return `<div class="card"><h2 class="card__title">📅 Programma</h2>
        <p class="hint">${Cal.loading ? 'Kalender laden…' : Cal.trainings.length ? 'Er staan nog geen wedstrijden in de clubkalender. Zodra de club ze toevoegt, verschijnen ze hier vanzelf.' : 'De speelkalender is nog niet geladen.'}</p>
        <button type="button" class="btn btn--secondary btn--sm" data-act="cal-refresh">🔄 Kalender ophalen</button></div>`;
    }
    const up = fxFn('upcoming', [Cal.fixtures], []);
    const done = fxFn('past', [Cal.fixtures], []).slice().reverse();
    const row = (f, isPast) => {
      const m = fxFn('matchFor', [f, ms], null);
      const d = parseISO(f.datum);
      const r = m ? resultOf(m) : null;
      const sc = m && m.score ? m.score : f.score;
      const rr = r || (sc ? (sc.home > sc.away ? 'W' : sc.home < sc.away ? 'V' : 'G') : null);
      const right = rr ? `<span class="res res--${rr}" title="${RESULT_LABEL[rr]}">${rr} <b>${sc.home}–${sc.away}</b></span>`
        : isPast ? '<span class="res res--none">–</span>'
        : `<span class="fx-tag${m ? ' fx-tag--ok' : ''}">${m ? '✓ opstelling' : 'Opstelling ›'}</span>`;
      return `<button type="button" class="mrow" data-act="${m && isPast ? 'open-match' : 'fx-plan'}" data-id="${esc(m && isPast ? m.id : f.id)}">
        <span class="mrow__date" aria-hidden="true"><b>${d ? d.getDate() : '?'}</b><small>${d ? esc(d.toLocaleDateString('nl-NL', { month: 'short' })) : ''}</small></span>
        <span class="mrow__main"><span class="mrow__opp">${f.thuisUit === 'uit' ? '✈️' : '🏠'} ${esc(fxShort(f))}</span>
          <span class="mrow__meta">${esc([fmtDate(f.datum, { weekday: 'short' }) + (f.tijd ? ' ' + f.tijd : ''), f.soort && f.soort !== 'competitie' ? f.soort : '', f.locatie].filter(Boolean).join(' · '))}</span></span>
        ${right}</button>`;
    };
    return `<div class="card"><h2 class="card__title">📅 Programma <span class="count-badge">${up.length}</span></h2>
      ${up.length ? `<div class="mlist">${up.slice(0, S.fxAll ? up.length : 5).map(f => row(f, false)).join('')}</div>
        ${up.length > 5 ? `<button type="button" class="link-btn fx-more" data-act="fx-all">${S.fxAll ? 'Minder tonen' : `Alle ${up.length} wedstrijden`}</button>` : ''}`
        : '<p class="hint">Geen komende wedstrijden in de kalender.</p>'}
      ${done.length ? `<details class="fx-past"><summary>Gespeeld (${done.length})</summary><div class="mlist">${done.map(f => row(f, true)).join('')}</div></details>` : ''}
      <p class="hint">Tik op een wedstrijd om de opstelling voor te bereiden. Bron: ${esc(CAL_SOURCE[Cal.source] || 'clubsite')}.</p></div>`;
  }
  function renderDetail(el, m) {
    const r = resultOf(m);
    const st = settingsFor(m);
    const times = periodTimes(m.periodes.length, st.minutes);
    const order = Array.isArray(m.aanwezig) && m.aanwezig.length ? m.aanwezig : St.getSquad().players.map(p => p.name);
    const o = { editable: false, locks: [], sel: null, order, times, key: 'detail-' + m.id };
    const goals = (Array.isArray(m.goals) ? m.goals : []).filter(Boolean);
    const view = S.view;
    el.innerHTML = `<div class="container">
      <div class="detail-top"><button type="button" class="btn btn--ghost btn--sm" data-act="close-detail">← Seizoen</button></div>
      <div class="card">
        <div class="detail-head"><h1 class="detail-title">${m.thuisUit === 'uit' ? '✈️' : '🏠'} ${esc(m.tegenstander || 'Onbekend')}</h1>
          <p class="hint">${esc(fmtDate(m.datum, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))} · ${m.thuisUit === 'uit' ? 'uit' : 'thuis'}</p>
          ${r ? `<p class="detail-score res res--${r}">${RESULT_ICON[r]} ${RESULT_LABEL[r]} <b>${m.score.home}–${m.score.away}</b></p>` : ''}</div>
        <div class="subcard"><h3 class="subcard__title">Uitslag</h3>${scoreEditorHTML(m)}</div>
        ${goals.length ? `<div class="subcard"><h3 class="subcard__title">Doelpunten</h3><ul class="goals">${goals.map(g => `<li class="goal goal--${g.team === 'away' ? 'away' : 'home'}">
          <span class="goal__min">${g.minute != null ? `${esc(g.minute)}'` : ''}</span><span>${g.team === 'away' ? esc(m.tegenstander || 'Tegenstander') : `⚽ ${esc(g.by || TEAM())}`}</span></li>`).join('')}</ul></div>` : ''}
        ${m.notitie ? `<p class="note note--info">📝 ${esc(m.notitie)}</p>` : ''}
      </div>
      ${m.periodes.length ? `<div class="card card--schema">
        <div class="card__head"><h2 class="card__title">Opstelling</h2>${viewToggleHTML(view, 'view')}</div>
        <div class="schema-view schema-view--${view}">${view === 'tabel' ? tabelHTML(m.periodes, o) + legendHTML() : veldHTML(m.periodes, o)}</div></div>` : ''}
      <div class="btn-grid">
        <button type="button" class="btn btn--secondary btn--lg" data-act="edit-match" data-id="${esc(m.id)}">✏️ Bewerk opstelling</button>
        <button type="button" class="btn btn--secondary btn--lg" data-act="share-match" data-id="${esc(m.id)}">📤 Delen</button>
        <button type="button" class="btn btn--primary btn--lg" data-act="live-match" data-id="${esc(m.id)}">▶️ Start live</button>
        <button type="button" class="btn btn--danger-ghost btn--lg" data-act="delete-match" data-id="${esc(m.id)}">🗑️ Verwijder</button>
      </div></div>`;
    bindCarousel(el);
  }
  async function saveScore(form) {
    const home = form.elements.namedItem('home'), away = form.elements.namedItem('away');
    const h = home.value.trim(), a = away.value.trim();
    if (h === '' || a === '') { toast('Vul beide scores in (ook als het 0 is).', 'warn'); (h === '' ? home : away).focus(); return; }
    const hn = Number(h), an = Number(a);
    if (!Number.isInteger(hn) || !Number.isInteger(an) || hn < 0 || an < 0 || hn > 99 || an > 99) { toast('Een score is een heel getal van 0 t/m 99.', 'warn'); return; }
    const m = findMatch(form.dataset.id);
    if (!m) { toast('Wedstrijd niet gevonden.', 'error'); return; }
    try { await St.saveMatch(Object.assign({}, m, { score: { home: hn, away: an } })); } catch (e) { reportError(e, errMsg(e, 'Uitslag opslaan mislukt.')); return; }
    const r = hn > an ? 'W' : hn < an ? 'V' : 'G';
    toast(`${RESULT_ICON[r]} ${RESULT_LABEL[r]} — ${hn}–${an} opgeslagen`, 'success');
    rerender();
  }
  async function clearScore(id) {
    const m = findMatch(id); if (!m) return;
    const ok = await confirmDialog({ title: 'Uitslag wissen?', message: `De uitslag ${m.score ? `${m.score.home}–${m.score.away} ` : ''}wordt verwijderd.`, ok: 'Wissen', danger: true });
    if (!ok) return;
    try { await St.saveMatch(Object.assign({}, m, { score: null })); } catch (e) { reportError(e, errMsg(e, 'Opslaan mislukt.')); return; }
    toast('Uitslag gewist', 'info'); rerender();
  }
  async function editMatch(id) {
    const m = findMatch(id); if (!m) return;
    if (!m.periodes.length) { toast('Deze wedstrijd heeft geen opstelling.', 'warn'); return; }
    if (hasUnsaved(S.draft) && sameId(S.draft.savedId, id)) {
      // Deze wedstrijd staat al open met niet-opgeslagen wijzigingen: die niet stil overschrijven.
      go('wedstrijd', { top: true });
      setTimeout(() => scrollIntoView($('#w-schema')), 40);
      toast('Deze opstelling staat al open, met je wijzigingen die nog niet zijn opgeslagen', 'info');
      return;
    }
    if (hasUnsaved(S.draft)) {
      const ok = await confirmDialog({ title: 'Huidige opstelling vervangen?', message: 'Je opstelling op het Wedstrijd-scherm is nog niet opgeslagen. Die gaat verloren.', ok: 'Vervangen', danger: true });
      if (!ok) return;
    }
    S.draft = draftFromMatch(m); S.undo = []; S.sel = null; S.genWarnings = []; S.carouselX = {};
    persistDraft(true);
    go('wedstrijd', { top: true });
    setTimeout(() => scrollIntoView($('#w-schema')), 40);
    toast('Opstelling geladen — wijzigingen worden in dezelfde wedstrijd opgeslagen', 'info');
  }
  async function deleteMatch(id) {
    const m = findMatch(id); if (!m) return;
    const ok = await confirmDialog({ title: 'Wedstrijd verwijderen?', message: `${m.tegenstander || 'Onbekend'} (${fmtDate(m.datum)}) wordt verwijderd, ook op andere apparaten.${modFn('Store', 'getTrash') ? ' Terughalen kan via 👥 Team → Prullenbak.' : ''}`, ok: 'Verwijderen', danger: true });
    if (!ok) return;
    try { await St.deleteMatch(m.id); } catch (e) { reportError(e, errMsg(e, 'Verwijderen mislukt.')); return; }
    if (sameId(S.draft.savedId, m.id)) { S.draft.savedId = null; if (S.draft.periodes) S.draft.dirty = true; persistDraft(); }
    if (sameId(S.liveMatchId, m.id)) { S.liveMatchId = null; saveUI(); }
    S.season.detailId = null;
    renderSeizoen(); root.scrollTo(0, 0);
    toast('Wedstrijd verwijderd', 'info');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Scherm: Team
  // ═══════════════════════════════════════════════════════════════════
  function renderTeam() {
    const el = screenEl('team');
    const sq = St.getSquad(); const st = sq.settings; const theme = currentTheme();
    const rows = sq.players.map((p, i) => `<li><button type="button" class="prow${p.active ? '' : ' is-inactive'}" data-act="edit-player" data-i="${i}">
      <span class="prow__avatar" aria-hidden="true">${esc(p.name.slice(0, 1).toUpperCase())}</span>
      <span class="prow__main"><span class="prow__name">${esc(p.name)}</span>
        <span class="prow__meta">${p.active ? '' : '<span class="tag">inactief</span>'}${p.avoid.map(c => `<span class="tag tag--avoid" title="Liever geen ${esc(POS(c).label.toLowerCase())}">geen ${esc(POS(c).short || c)}</span>`).join('')}${p.aliases.length ? `<span class="prow__alias">ook: ${esc(p.aliases.join(', '))}</span>` : ''}</span></span>
      <span class="prow__chev" aria-hidden="true">›</span></button></li>`).join('');
    const nMatches = St.getMatches().length;
    el.innerHTML = `<div class="container">
      <div class="page-head"><h1 class="page-title">👥 Team</h1></div>
      <div class="card"><div class="card__head"><h2 class="card__title">Spelers <span class="count-badge">${sq.players.filter(p => p.active).length}</span></h2></div>
        <ul class="plist">${rows}</ul>
        <form class="add-row" data-form="add-player" autocomplete="off">
          <label class="sr-only" for="in-new-player">Nieuwe speler</label>
          <input class="input" id="in-new-player" name="name" placeholder="Naam nieuwe speler" autocapitalize="words" enterkeyhint="done" maxlength="40">
          <button type="submit" class="btn btn--primary">＋ Toevoegen</button></form>
        <p class="hint">Tik op een speler om de naam, “liever niet”-posities of bijnamen aan te passen.</p>
      </div>
      <div class="card"><h2 class="card__title">⚙️ Wedstrijd</h2>
        <div class="set-row"><span class="set-row__label" id="lbl-per">Aantal periodes</span>
          <div class="seg seg--sm" role="group" aria-labelledby="lbl-per">${[2, 4].map(n => `<button type="button" class="seg__btn" data-act="set-periods" data-v="${n}" aria-pressed="${st.periods === n}">${n}</button>`).join('')}</div></div>
        <label class="set-row"><span class="set-row__label">Wedstrijdduur</span>
          <span class="input-unit"><input class="input input--num" type="number" inputmode="numeric" min="10" max="120" step="1" value="${st.minutes}" data-change="minutes" aria-label="Wedstrijdduur in minuten"><span>min</span></span></label>
        <p class="hint">${st.periods} periodes van ${String(Math.round(st.minutes / st.periods * 10) / 10).replace('.', ',')} minuten.</p>
      </div>
      <div class="card"><h2 class="card__title">🎨 Weergave</h2>
        <div class="seg" role="group" aria-label="Thema">
          <button type="button" class="seg__btn" data-act="set-theme" data-v="auto" aria-pressed="${theme === 'auto'}">🌗 Auto</button>
          <button type="button" class="seg__btn" data-act="set-theme" data-v="light" aria-pressed="${theme === 'light'}">☀️ Licht</button>
          <button type="button" class="seg__btn" data-act="set-theme" data-v="dark" aria-pressed="${theme === 'dark'}">🌙 Donker</button></div>
      </div>
      <div class="card"><h2 class="card__title">💾 Gegevens</h2>
        <p class="sync-line"><span class="sync-dot" data-status="${esc(St.getStatus())}" aria-hidden="true"></span><span id="team-sync-text">${esc(STATUS_TEXT[St.getStatus()] || STATUS_TEXT.offline)}</span></p>
        <p class="hint">${nMatches} wedstrijd${nMatches === 1 ? '' : 'en'} opgeslagen.</p>
        <div class="btn-col">
          <button type="button" class="btn btn--secondary btn--block" data-act="import-xlsx">📥 Excel importeren</button>
          <input type="file" id="import-file" accept=".xlsx,.xls" data-change="import-file" hidden>
          <button type="button" class="btn btn--secondary btn--block" data-act="export-season"${nMatches ? '' : ' disabled'}>📗 Heel seizoen naar Excel</button>
          <a class="btn btn--ghost btn--block" href="v1.html">↩️ Oude versie openen</a>
        </div>
        ${trashHTML()}
      </div>
      ${calTeamHTML()}
      <div class="card"><details class="explain"><summary>🤝 Hoe werkt het eerlijk verdelen?</summary>
        <ul>
          <li><b>Iedereen evenveel spelen.</b> Wie vaker wissel was (deze wedstrijd én dit seizoen), is nu minder vaak wissel.</li>
          <li><b>Nooit twee keer achter elkaar wissel</b>, en de keeper is niet wissel in de periodes dat hij keept.</li>
          <li><b>Afwisseling:</b> niet meer dan 2 periodes op dezelfde plek, en over het seizoen ongeveer evenveel verdedigen, middenveld en aanvallen.</li>
          <li><b>Keepen eerlijk rond:</b> de app stelt voor wie het minst gekeept heeft.</li>
          <li><b>“Liever niet”</b>-posities worden zoveel mogelijk vermeden.</li>
          <li>Niet tevreden? <b>Ruil</b> spelers met twee tikken, <b>zet vast</b> wat goed is 🔒 en kies <b>🔀 Ander schema</b>.</li>
        </ul></details></div>
      <p class="footer-note">${esc(C().APP_NAME || 'JO10 Opstelling')} · v2</p>
    </div>`;
  }
  function calTeamHTML() {
    if (!JO10.Fixtures) return '';
    const n = Cal.fixtures.length;
    const when = Cal.updatedAt ? new Date(Cal.updatedAt).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    return `<div class="card"><h2 class="card__title">📅 Speelkalender</h2>
      <p class="hint">${esc(C().CALENDAR_TEAM || '')}${n || Cal.trainings.length ? ` · <b>${n} wedstrijden</b>, ${Cal.trainings.length} trainingen · bijgewerkt ${esc(when)} · ${esc(CAL_SOURCE[Cal.source] || '')}` : ` · ${Cal.loading ? 'laden…' : 'nog niet geladen'}`}</p>
      ${Cal.error && !n && !Cal.trainings.length ? `<p class="note note--warn">Ophalen lukte niet (${esc(Cal.error)}).</p>` : ''}
      <div class="btn-col">
        <button type="button" class="btn btn--secondary btn--block" data-act="cal-refresh"${Cal.loading ? ' disabled' : ''}>🔄 Kalender vernieuwen</button>
        <button type="button" class="btn btn--ghost btn--block" data-act="cal-import">📥 .ics-bestand importeren</button>
        <input type="file" id="cal-file" accept=".ics,text/calendar" data-change="cal-file" hidden>
      </div>
      <p class="hint">De officiële kalender van de clubsite wordt elke avond automatisch opgehaald. Tegenstander, datum en thuis/uit neem je met één tik over bij ⚽ Wedstrijd.</p></div>`;
  }
  // ── Prullenbak (lokaal vangnet van de Store) ──
  const TRASH_REASON = { deleted: 'zelf verwijderd', delete: 'zelf verwijderd', user: 'zelf verwijderd', remote: 'verdwenen bij synchroniseren', sync: 'verdwenen bij synchroniseren', import: 'vervangen bij import' };
  function trashItems() {
    if (!modFn('Store', 'getTrash')) return null;
    const t = St.run('getTrash', [], () => []);
    return (Array.isArray(t) ? t : []).filter(x => x && x.match && x.match.id != null)
      .sort((a, b) => (+b.removedAt || 0) - (+a.removedAt || 0));
  }
  function trashHTML() {
    const items = trashItems();
    if (items == null) return '';
    const fmtTs = ts => { const d = new Date(+ts); return isNaN(d) ? '' : d.toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
    return `<details class="trash"${S.trashOpen ? ' open' : ''} data-toggle="trash"><summary>🗑️ Prullenbak / herstellen <span class="count-badge">${items.length}</span></summary>
      ${items.length ? `<p class="hint">Wedstrijden die verwijderd zijn of bij het synchroniseren verdwenen. Alleen op dit apparaat bewaard.</p>
      <ul class="trash__list">${items.map(it => { const m = normMatch(it.match); return `<li class="trash__item">
        <span class="trash__main"><b>${esc(m.tegenstander || m.titel || 'Onbekend')}</b>
          <small>${esc(m.datum ? fmtDate(m.datum) : '–')} · weg sinds ${esc(fmtTs(it.removedAt))}${it.reason ? ` · ${esc(TRASH_REASON[it.reason] || it.reason)}` : ''}</small></span>
        <button type="button" class="btn btn--secondary btn--sm" data-act="trash-restore" data-id="${esc(m.id)}">Herstel</button></li>`; }).join('')}</ul>`
        : '<p class="hint">Leeg — er is niets verwijderd.</p>'}</details>`;
  }
  async function restoreTrash(id) {
    const f = modFn('Store', 'restoreFromTrash');
    if (!f) { reportError(new Error('restoreFromTrash ontbreekt'), 'Herstellen is niet beschikbaar.'); return; }
    if (findMatch(id)) {
      const ok = await confirmDialog({ title: 'Wedstrijd bestaat al', message: 'Er staat al een wedstrijd met deze gegevens. Toch de versie uit de prullenbak terugzetten?', ok: 'Terugzetten' });
      if (!ok) return;
    }
    let m;
    try { m = await f(isNaN(Number(id)) ? id : Number(id)); } catch (e) { reportError(e, errMsg(e, 'Herstellen mislukt.')); return; }
    toast(`${(m && m.tegenstander) || 'Wedstrijd'} hersteld`, 'success');
    renderTeam();
  }

  async function persistSquad(sq, okMsg) {
    try { await St.saveSquad(sq); if (okMsg) toast(okMsg, 'success'); }
    catch (e) { console.warn(e); toast('Opgeslagen op dit apparaat (synchroniseren lukte niet).', 'warn'); }
    renderTeam();
  }
  async function addPlayer(form) {
    const input = form.elements.namedItem('name');
    const n = (input.value || '').trim().replace(/\s+/g, ' ');
    if (!n) { input.focus(); return; }
    const err = nameError(n);
    if (err) { toast(err, 'warn'); input.focus(); return; }
    const sq = clone(St.getSquad());
    if (sq.players.some(p => nameKey(p.name) === nameKey(n))) { toast(`${n} staat al in het team.`, 'warn'); return; }
    sq.players.push({ name: n, active: true, avoid: [], aliases: [] });
    const d = S.draft;
    d.guests = d.guests.filter(g => nameKey(g) !== nameKey(n));
    if (!d.periodes && !d.aanwezig.includes(n)) { d.aanwezig.push(n); ensureKeepers(d); persistDraft(); }
    await persistSquad(sq, `${n} toegevoegd`);
    const again = $('#in-new-player'); if (again) again.focus();
  }
  function openPlayerSheet(i) {
    const p = St.getSquad().players[i]; if (!p) return;
    S.edit = { i, orig: p.name, avoid: p.avoid.slice() };
    openSheet({
      title: `Speler bewerken`,
      body: `<form data-form="player" class="stack" autocomplete="off">
        <label class="field"><span class="field__label">Naam</span><input class="input" name="name" value="${esc(p.name)}" maxlength="40" autocapitalize="words"></label>
        <label class="switch"><input type="checkbox" name="active"${p.active ? ' checked' : ''}><span class="switch__track" aria-hidden="true"></span><span>Actief (staat standaard bij aanwezig)</span></label>
        <div class="field"><span class="field__label" id="lbl-avoid">Liever niet op…</span>
          <div class="avoid-row" role="group" aria-labelledby="lbl-avoid">${FIELD.map(c => `<button type="button" class="avoid-btn${p.avoid.includes(c) ? ' is-on' : ''}" data-act="ep-avoid" data-code="${c}" aria-pressed="${p.avoid.includes(c)}">${esc(POS(c).icon)} ${esc(POS(c).label)}</button>`).join('')}</div>
          <p class="hint">Rood doorgestreept = liever niet. Met “Keeper” aan wordt de speler niet als keeper voorgesteld.</p></div>
        <label class="field"><span class="field__label">Bijnamen / oude namen</span><input class="input" name="aliases" value="${esc(p.aliases.join(', '))}" placeholder="bijv. Bas, Bassie"></label>
        <p class="hint">Gescheiden door komma’s. Zo herkennen de Excel-import en het seizoensoverzicht die namen als ${esc(p.name)}.</p>
        <button type="submit" hidden></button>
      </form>`,
      actions: `<button type="button" class="btn btn--danger-ghost" data-act="ep-delete">🗑️</button>
        <button type="button" class="btn btn--secondary" data-act="sheet-close">Annuleren</button>
        <button type="button" class="btn btn--primary" data-act="ep-save">Opslaan</button>`,
    });
  }
  function renameInDraft(oldN, newN) {
    const d = S.draft; const r = n => (n === oldN ? newN : n);
    d.aanwezig = d.aanwezig.map(r); d.keepers = d.keepers.map(r); d.guests = d.guests.map(r);
    d.locks.forEach(l => { l.player = r(l.player); });
    if (d.periodes) d.periodes.forEach(per => {
      if (per.posities[oldN]) { per.posities[newN] = per.posities[oldN]; delete per.posities[oldN]; }
      per.wissels = per.wissels.map(r);
    });
    if (d.periodes) d.sig = sigOf(d);
    persistDraft();
  }
  async function savePlayerSheet() {
    const form = $('#sheet-root form[data-form="player"]'); if (!form || !S.edit) return;
    const sq = clone(St.getSquad()); const p = sq.players[S.edit.i];
    if (!p || p.name !== S.edit.orig) { closeSheet(true); toast('Het team is intussen gewijzigd. Probeer het opnieuw.', 'warn'); renderTeam(); return; }
    const name = form.elements.namedItem('name').value.trim().replace(/\s+/g, ' ');
    const nErr = name ? nameError(name) : 'Naam mag niet leeg zijn.';
    if (nErr) { toast(nErr, 'warn'); form.elements.namedItem('name').focus(); return; }
    if (sq.players.some((q, j) => j !== S.edit.i && nameKey(q.name) === nameKey(name))) { toast(`${name} bestaat al.`, 'warn'); return; }
    let aliases = form.elements.namedItem('aliases').value.split(',').map(s => s.trim()).filter(Boolean);
    const renamed = name !== p.name;
    if (renamed && !aliases.some(a => nameKey(a) === nameKey(p.name))) aliases.push(p.name);
    aliases = uniq(aliases.filter(a => nameKey(a) !== nameKey(name)));
    const oldName = p.name;
    Object.assign(p, { name, active: form.elements.namedItem('active').checked, avoid: S.edit.avoid.slice(), aliases });
    closeSheet(true);
    if (renamed) renameInDraft(oldName, name);
    await persistSquad(sq, renamed ? `Hernoemd naar ${name}. “${oldName}” blijft als bijnaam gekoppeld aan de historie.` : 'Opgeslagen');
  }
  async function deletePlayer() {
    if (!S.edit) return;
    const name = S.edit.orig;
    const ok = await confirmDialog({ title: `${name} verwijderen?`, message: 'De speler verdwijnt uit het team. Opgeslagen wedstrijden blijven bewaard. Tip: “inactief” maken kan ook.', ok: 'Verwijderen', danger: true });
    if (!ok) return;
    const sq = clone(St.getSquad());
    sq.players = sq.players.filter(p => p.name !== name);
    await persistSquad(sq, `${name} verwijderd`);
  }
  async function setPeriods(n) {
    const sq = clone(St.getSquad());
    if (sq.settings.periods === n) return;
    sq.settings.periods = n;
    const d = S.draft;
    if (!d.periodes) { d.periods = n; ensureKeepers(d); if (!d.keepersAuto && d.keepers.some(k => !k)) { d.keepersAuto = true; autoKeepers(d); } persistDraft(); }
    await persistSquad(sq, `${n} periodes ingesteld`);
    if (d.periodes && d.periods !== n) toast('Je huidige schema houdt zijn eigen aantal periodes. Nieuwe wedstrijden gebruiken de nieuwe instelling.', 'info', { ms: 4500 });
  }
  async function setMinutes(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n) || n < 10 || n > 120) { toast('Kies een duur tussen 10 en 120 minuten.', 'warn'); renderTeam(); return; }
    const sq = clone(St.getSquad()); sq.settings.minutes = n;
    await persistSquad(sq, `Wedstrijdduur: ${n} minuten`);
  }
  function importKey(m) { return `${m.datum || ''}|${nameKey(m.tegenstander || m.titel || '')}`; }
  async function onImportFile(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (typeof root.XLSX === 'undefined') { toast('Excel is nu niet beschikbaar (geen internet?). Probeer het later nog eens.', 'warn'); return; }
    const f = modFn('IO', 'importExcel');
    if (!f) { reportError(new Error('IO.importExcel ontbreekt'), 'De importmodule is niet geladen.'); return; }
    let res;
    try { res = await f(file, St.getSquad()); } catch (e) { reportError(e, 'Dit Excel-bestand kon niet gelezen worden.'); return; }
    const found = (res && Array.isArray(res.matches) ? res.matches : []).filter(Boolean);
    const warnings = res && Array.isArray(res.warnings) ? res.warnings : [];
    const keys = new Set(St.getMatches().map(importKey));
    const fresh = []; const seen = new Set();
    let empty = 0;
    found.forEach(m => {
      if (!Array.isArray(m.periodes) || !m.periodes.length) { empty++; return; }
      const k = importKey(m); if (!keys.has(k) && !seen.has(k)) { seen.add(k); fresh.push(m); }
    });
    if (empty) warnings.push(`${empty} wedstrijd${empty === 1 ? '' : 'en'} zonder opstelling overgeslagen`);
    const dupes = found.length - empty - fresh.length;
    S.pendingImport = fresh;
    openSheet({
      title: '📥 Excel importeren',
      body: `<p class="sheet__msg"><b>${found.length} wedstrijd${found.length === 1 ? '' : 'en'} gevonden</b> in ${esc(file.name)}.</p>
        <p class="hint">${fresh.length} nieuw${dupes ? ` · ${dupes} stond${dupes === 1 ? '' : 'en'} er al in (worden overgeslagen)` : ''}.</p>
        ${warnings.length ? `<ul class="warnings">${warnings.slice(0, 6).map(w => `<li>⚠️ ${esc(w)}</li>`).join('')}${warnings.length > 6 ? `<li>… en nog ${warnings.length - 6}</li>` : ''}</ul>` : ''}
        ${fresh.length ? `<ul class="import-list">${fresh.slice(0, 20).map(m => `<li>${esc(m.datum ? fmtDate(m.datum) : '–')} · ${esc(m.tegenstander || m.titel || 'Onbekend')} <small>(${(m.periodes || []).length} periodes)</small></li>`).join('')}${fresh.length > 20 ? `<li>…</li>` : ''}</ul>` : ''}`,
      actions: `<button type="button" class="btn btn--secondary" data-act="sheet-close">Annuleren</button>
        <button type="button" class="btn btn--primary" data-act="import-confirm"${fresh.length ? '' : ' disabled'}>Importeer ${fresh.length}</button>`,
    });
  }
  async function confirmImport() {
    const list = S.pendingImport || []; S.pendingImport = null;
    closeSheet(true);
    if (!list.length) return;
    const used = new Set(St.getMatches().map(m => String(m.id)));
    let ok = 0; let base = Date.now(); let firstErr = '';
    for (const raw of list) {
      const m = Object.assign({}, raw);
      if (m.id == null || used.has(String(m.id))) { while (used.has(String(base))) base++; m.id = base++; }
      used.add(String(m.id));
      if (!m.titel) m.titel = titelOf(m.tegenstander, m.thuisUit);
      try { await St.saveMatch(m); ok++; } catch (e) { console.warn(e); if (!firstErr) firstErr = errMsg(e, ''); }
    }
    toast(`${ok} wedstrijd${ok === 1 ? '' : 'en'} geïmporteerd${ok < list.length ? ` · ${list.length - ok} overgeslagen${firstErr ? ` (${firstErr})` : ''}` : ''}`, ok === list.length ? 'success' : 'warn');
    rerender();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Events (delegatie)
  // ═══════════════════════════════════════════════════════════════════
  const ACT = {
    go: ds => {
      if (ds.screen === S.screen) { // nogmaals op de actieve tab: terug naar boven (en detail sluiten)
        if (S.screen === 'seizoen' && S.season.detailId != null) { S.season.detailId = null; renderSeizoen(); }
        root.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
        return;
      }
      go(ds.screen);
    },
    reload: () => root.location.reload(),
    'theme-cycle': () => { const order = ['auto', 'light', 'dark']; const t = order[(order.indexOf(currentTheme()) + 1) % 3]; applyTheme(t, true); toast(`Thema: ${THEME_LABEL[t]}`, 'info', { ms: 1400 }); },
    'set-theme': ds => applyTheme(ds.v, true),
    'scroll-to': ds => { const t = doc.getElementById(ds.target); if (t && !t.hidden) scrollIntoView(t); else if (ds.target === 'w-schema' || ds.target === 'w-actions') scrollIntoView($('#w-generate')); },
    thuisuit: ds => { S.draft.thuisUit = ds.v === 'uit' ? 'uit' : 'thuis'; changed(); $$('[data-act="thuisuit"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === S.draft.thuisUit))); renderActions(); renderProgress(); },
    'date-quick': ds => { S.draft.datum = ds.v; changed(); renderInfo(); renderActions(); renderProgress(); },
    'att-toggle': ds => toggleAttendance(ds.name),
    'att-all': () => { const d = S.draft; d.aanwezig = uniq(St.activePlayers().concat(d.guests)); ensureKeepers(d); changed(); refreshDraftUI(['aanwezig', 'keepers', 'generate', 'schema', 'actions']); },
    'att-none': () => { const d = S.draft; d.aanwezig = []; ensureKeepers(d); changed(); refreshDraftUI(['aanwezig', 'keepers', 'generate', 'schema', 'actions']); },
    'add-guest': () => addGuest(),
    'remove-guest': ds => { const d = S.draft; d.guests = d.guests.filter(g => g !== ds.name); d.aanwezig = d.aanwezig.filter(n => n !== ds.name); ensureKeepers(d); changed(); refreshDraftUI(['aanwezig', 'keepers', 'generate', 'schema', 'actions']); },
    'keeper-suggest': () => { const d = S.draft; d.keepersAuto = true; autoKeepers(d); changed(); refreshDraftUI(['keepers', 'generate', 'schema', 'actions']); },
    generate: () => doGenerate(false),
    reshuffle: () => doGenerate(true),
    undo: () => doUndo(),
    'unlock-all': () => { pushUndo(); S.draft.locks = []; S.draft.dirty = true; persistDraft(); renderSchema(); renderGenerate(); toast('Alle vastzettingen opgeheven', 'info'); },
    view: ds => { S.view = ds.v === 'tabel' ? 'tabel' : 'veld'; saveUI(); if (S.screen === 'wedstrijd') renderSchema(); else rerender(); },
    chip: ds => onChip(+ds.p, ds.name),
    'chip-menu': () => { if (S.sel) openChipSheet(S.sel.p, S.sel.name); },
    'chip-lock': () => { if (S.sel) { const { p, name } = S.sel; S.sel = null; toggleLock(p, name); } },
    'sel-clear': () => { S.sel = null; renderSchema(); },
    'set-pos': ds => doSetPos(+ds.p, ds.name, ds.code),
    'toggle-lock': ds => { closeSheet(true); S.sel = null; toggleLock(+ds.p, ds.name); },
    save: () => doSave(),
    share: () => { if (!S.draft.periodes) return; openShare(buildMatch(S.draft)); },
    'share-match': ds => { const m = findMatch(ds.id); if (m) openShare(m); },
    'share-wa': () => { const m = S.shareMatch; closeSheet(true); if (m) shareWhatsapp(m); },
    'share-png': () => { const m = S.shareMatch; closeSheet(true); if (m) sharePNG(m); },
    'share-xlsx': () => { const m = S.shareMatch; closeSheet(true); if (m) shareExcel([m]); },
    'start-live': () => startLiveFromDraft(),
    'new-match': () => newMatch(),
    'score-clear': ds => clearScore(ds.id),
    'open-match': ds => { S.season.detailId = ds.id; S.scroll.seizoenList = root.scrollY; renderSeizoen(); root.scrollTo(0, 0); },
    'close-detail': () => { S.season.detailId = null; renderSeizoen(); root.scrollTo(0, S.scroll.seizoenList || 0); },
    sort: ds => { const k = ds.k; if (S.season.sort === k) S.season.dir *= -1; else { S.season.sort = k; S.season.dir = k === 'name' ? 1 : -1; } renderSeizoen(); },
    'edit-match': ds => editMatch(ds.id),
    'delete-match': ds => deleteMatch(ds.id),
    'live-match': ds => { const m = findMatch(ds.id); if (m) go('live', { matchId: m.id, top: true }); },
    'live-exit': () => exitLive(),
    'edit-player': ds => openPlayerSheet(+ds.i),
    'ep-avoid': (ds, el) => {
      if (!S.edit) return; const c = ds.code;
      S.edit.avoid = S.edit.avoid.includes(c) ? S.edit.avoid.filter(x => x !== c) : S.edit.avoid.concat(c);
      const on = S.edit.avoid.includes(c); el.classList.toggle('is-on', on); el.setAttribute('aria-pressed', String(on));
    },
    'ep-save': () => savePlayerSheet(),
    'ep-delete': () => deletePlayer(),
    'set-periods': ds => setPeriods(+ds.v),
    'import-xlsx': () => { const i = doc.getElementById('import-file'); if (i) i.click(); },
    'import-confirm': () => confirmImport(),
    'export-season': () => shareExcel(St.getMatches()),
    'trash-restore': ds => restoreTrash(ds.id),
    'fx-use': ds => { const f = fxById(ds.id); if (!f) return; fxApplyToDraft(S.draft, f); changed(); renderInfo(); renderActions(); renderProgress(); toast(`${fxShort(f)} overgenomen`, 'success', { ms: 1600 }); },
    'fx-plan': ds => fxPlan(ds.id),
    'fx-all': () => { S.fxAll = !S.fxAll; renderSeizoen(); },
    'tr-all': () => { S.trAll = !S.trAll; renderSeizoen(); },
    'cal-refresh': () => calRefresh(true),
    'cal-import': () => { const i = doc.getElementById('cal-file'); if (i) i.click(); },
    'sheet-close': () => closeSheet(false),
    'sheet-resolve': ds => { const st = sheetState; if (st && st.resolve) { const r = st.resolve; st.resolve = null; r(ds.v === '1'); } closeSheet(true); },
    'prompt-ok': () => { const f = $('#sheet-root form[data-form="prompt"]'); if (f) FORM.prompt(f); },
    'toast-action': (ds, el) => { const fn = toastActions[ds.id]; const t = el.closest('.toast'); if (t) dismissToast(t, ds.id); if (fn) fn(); },
  };
  const INPUT = {
    tegenstander: v => { S.draft.tegenstander = v; changed(); renderOppHint(); renderProgress(); },
    datum: v => { if (!v) return; S.draft.datum = v; changed(); $$('[data-act="date-quick"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v))); renderProgress(); },
  };
  const CHANGE = {
    keeper: (el) => {
      const d = S.draft; const v = el.value; const half = el.dataset.half;
      const idx = half === 'all' ? Array.from({ length: d.periods }, (_, i) => i) : halvesOf(d.periods)[+half] || [];
      idx.forEach(i => { d.keepers[i] = v; });
      d.keepersAuto = false; changed();
      refreshDraftUI(['keepers', 'generate', 'schema', 'actions']);
    },
    'same-keeper': (el) => {
      const d = S.draft; d.sameKeeper = el.checked;
      if (d.sameKeeper) { const k = d.keepers.find(Boolean) || suggestKeepersFor(d)[0] || ''; d.keepers = Array(d.periods).fill(k); }
      else if (d.keepersAuto) autoKeepers(d);
      changed(); refreshDraftUI(['keepers', 'generate', 'schema', 'actions']);
    },
    minutes: el => setMinutes(el.value),
    'import-file': el => onImportFile(el),
    'cal-file': el => onCalendarFile(el),
  };
  const FORM = {
    prompt: f => { const v = f.elements.namedItem('v').value; const st = sheetState; if (st && st.resolve) { const r = st.resolve; st.resolve = null; r(v); } closeSheet(true); },
    score: f => saveScore(f),
    'add-player': f => addPlayer(f),
    player: () => savePlayerSheet(),
  };
  function bindEvents() {
    doc.addEventListener('click', e => {
      const t = e.target.closest('[data-act]'); if (!t) return;
      if (t.closest('#live-host')) return; // live.js heeft eigen data-act-afhandeling
      if (t.getAttribute('aria-disabled') === 'true' && t.dataset.act !== 'generate') return;
      const h = ACT[t.dataset.act]; if (!h) return;
      if (t.tagName === 'A') e.preventDefault();
      try { const r = h(t.dataset, t, e); if (r && typeof r.catch === 'function') r.catch(err => reportError(err)); } catch (err) { reportError(err); }
    });
    doc.addEventListener('input', e => {
      const t = e.target.closest('[data-input]'); if (!t) return; if (t.closest('#live-host')) return;
      const h = INPUT[t.dataset.input]; if (h) try { h(t.value, t); } catch (err) { reportError(err); }
    });
    doc.addEventListener('change', e => {
      const t = e.target.closest('[data-change]'); if (!t) return; if (t.closest('#live-host')) return;
      const h = CHANGE[t.dataset.change]; if (h) try { const r = h(t); if (r && r.catch) r.catch(err => reportError(err)); } catch (err) { reportError(err); }
    });
    doc.addEventListener('submit', e => {
      const f = e.target.closest('form[data-form]'); if (!f) return; if (f.closest('#live-host')) return;
      e.preventDefault();
      const h = FORM[f.dataset.form]; if (h) try { const r = h(f); if (r && r.catch) r.catch(err => reportError(err)); } catch (err) { reportError(err); }
    });
    doc.addEventListener('toggle', e => {
      const t = e.target && e.target.dataset && e.target.dataset.toggle;
      if (t === 'pp') S.ppOpen = e.target.open; else if (t === 'trash') S.trashOpen = e.target.open;
    }, true);
    doc.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (sheetState) { closeSheet(false); e.preventDefault(); }
        else if (S.sel) { S.sel = null; renderSchema(); }
      } else if (e.key === 'Tab' && sheetState) {
        const f = $$('#sheet-root button, #sheet-root input, #sheet-root select, #sheet-root a[href]').filter(x => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && doc.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && doc.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    });
    // Concept direct wegschrijven als Safari de pagina in de achtergrond zet
    const flush = () => { if (S.draft) persistDraft(true); };
    root.addEventListener('pagehide', flush);
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') flush(); });
    root.addEventListener('error', e => { if (e && e.error) reportError(e.error, 'Er ging iets mis. Herlaad de pagina als het niet goed werkt.'); });
    // Promise-fouten van externe libs (Firebase offline e.d.) alleen loggen; eigen async-acties melden zichzelf.
    root.addEventListener('unhandledrejection', e => { console.warn('[JO10] unhandledrejection', e && e.reason); });
  }

  // Remote wijziging (ander apparaat / Firebase)
  function isTyping() { const a = doc.activeElement; return !!(a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)); }
  function onRemoteChange() {
    if (!S.ready) return;
    try {
      if (S.draft && S.draft.savedId != null && !findMatch(S.draft.savedId)) { S.draft.savedId = null; if (S.draft.periodes) S.draft.dirty = true; persistDraft(); }
      if (S.screen === 'seizoen') renderSeizoen();
      else if (S.screen === 'team') { if (!sheetState && !isTyping()) renderTeam(); }
      else if (S.screen === 'live') {
        if (S.liveMounted == null) renderLive();
        else {
          const latest = findMatch(S.liveMounted);
          const up = modFn('Live', 'update');
          if (!latest) { toast('Deze wedstrijd is op een ander toestel verwijderd.', 'warn'); exitLive(); }
          else if (up) { try { up(clone(latest)); } catch (e) { console.warn('[JO10] Live.update', e); } }
        }
      }
      else if (S.screen === 'wedstrijd' && !isTyping() && !sheetState) { renderKeepers(); renderActions(); renderProgress(); const dl = $('#opp-list'); if (dl) dl.innerHTML = opponents().map(o => `<option value="${esc(o)}"></option>`).join(''); }
    } catch (e) { console.warn('[JO10] onChange', e); }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Opstarten
  // ═══════════════════════════════════════════════════════════════════
  async function boot() {
    applyPosColors();
    applyTheme(currentTheme(), false);
    bindEvents();
    const ui = lsJSON(UI_KEY) || {};
    S.view = ui.view === 'tabel' ? 'tabel' : 'veld';
    S.liveMatchId = ui.liveMatchId != null ? ui.liveMatchId : null;
    showStatus('syncing');
    try {
      await Promise.race([St.init({ onChange: onRemoteChange }), new Promise(r => setTimeout(r, 2500))]);
    } catch (e) { reportError(e, 'Opslag starten mislukt — we werken lokaal verder.'); }
    showStatus(St.getStatus());
    St.onStatus(showStatus);
    ['Scheduler', 'IO', 'Live'].forEach(m => { if (!JO10[m]) console.warn(`[JO10] ${m} niet geladen`); });
    if (!JO10.Scheduler) reportError(new Error('Scheduler ontbreekt'), 'De rekenmodule is niet geladen — wisselschema maken lukt nu niet.');
    try { S.draft = restoreDraft(); } catch (e) { reportError(e, 'Je concept kon niet hersteld worden.'); S.draft = newDraft(); }
    calLoadCache();
    S.ready = true;
    const start = SCREENS.includes(ui.screen) ? ui.screen : 'wedstrijd';
    S.screen = null;
    go(start);
    root.scrollTo(0, 0);
    // Speelkalender op de achtergrond verversen (cache is al direct zichtbaar)
    setTimeout(() => { calRefresh(false).catch(e => console.warn('[JO10] kalender', e)); loadMaterial(); }, 400);
  }

  JO10.App = {
    go: (screen, params) => go(screen, params),
    toast: (msg, type, opts) => toast(msg, type, opts),
    confirm: o => confirmDialog(o || {}),
    render: () => rerender(),
    get state() { return S; },
    _esc: esc,
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => { boot().catch(e => reportError(e)); });
  else boot().catch(e => reportError(e));

  if (typeof module !== 'undefined' && module.exports) module.exports = JO10.App;
})(typeof window !== 'undefined' ? window : globalThis);
