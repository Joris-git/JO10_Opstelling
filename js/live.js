// JO10 Opstelling — live-wedstrijdmodus: klok per periode, wissels, score.
// Pure tijd-/wissel-/scorelogica is geëxporteerd voor Node-tests; de DOM-laag draait alleen in de browser.
(function (root) {
  'use strict';
  const JO10 = root.JO10 = root.JO10 || {};

  const cfg = () => JO10.Config || {};
  const lsKey = () => cfg().LS_LIVE || 'jo10_live_v2';
  const teamName = () => cfg().TEAM_NAME || 'JO10';

  const POS_FALLBACK = {
    K: { code: 'K', label: 'Keeper', color: '#f59e0b' },
    V: { code: 'V', label: 'Verdediger', color: '#3b82f6' },
    M: { code: 'M', label: 'Middenvelder', color: '#10b981' },
    S: { code: 'S', label: 'Spits', color: '#ef4444' },
    W: { code: 'W', label: 'Wissel', color: '#94a3b8' },
  };
  const ORDER = ['K', 'V', 'M', 'S'];
  const LABEL_TO_CODE = { keeper: 'K', verdediger: 'V', middenvelder: 'M', spits: 'S', wissel: 'W' };
  const WARN_MS = 60 * 1000;
  const STATE_TTL_MS = 3 * 24 * 3600 * 1000;

  function posInfo(code) {
    const P = cfg().POSITIONS;
    return (P && P[code]) || POS_FALLBACK[code] || { code, label: String(code), color: '#94a3b8' };
  }
  const posLabel = code => posInfo(code).label;

  // ───────────────────────── Pure helpers: opstelling ─────────────────────────

  function normCode(v) {
    if (v == null) return null;
    const s = String(v).trim();
    const u = s.toUpperCase();
    if (u === 'K' || u === 'V' || u === 'M' || u === 'S' || u === 'W') return u;
    return LABEL_TO_CODE[s.toLowerCase()] || null;
  }

  /** Defensief lezen van een periode (oude records: `subs`, labels i.p.v. codes). */
  function normalizePeriod(p) {
    const posities = {};
    const wissels = [];
    if (p && p.posities && typeof p.posities === 'object') {
      Object.keys(p.posities).forEach(name => {
        const c = normCode(p.posities[name]);
        if (c === 'W') wissels.push(name);
        else if (c) posities[name] = c;
      });
    }
    const subs = (p && (Array.isArray(p.wissels) ? p.wissels : Array.isArray(p.subs) ? p.subs : [])) || [];
    subs.forEach(n => { if (n && !posities[n] && wissels.indexOf(n) < 0) wissels.push(n); });
    return { posities, wissels };
  }

  /** Spelers op het veld gesorteerd K, V, M, S (stabiel op invoervolgorde). */
  function lineupOf(period) {
    const p = normalizePeriod(period);
    const names = Object.keys(p.posities);
    return names
      .map((name, i) => ({ name, code: p.posities[name], i }))
      .sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code) || a.i - b.i)
      .map(({ name, code }) => ({ name, code }));
  }

  /**
   * Verschil tussen periode a (nu) en b (volgende).
   * swaps: wie eruit / erin (gekoppeld op positie waar mogelijk), moves: positiewissels op het veld.
   */
  function diffPeriods(a, b) {
    const A = normalizePeriod(a), B = normalizePeriod(b);
    const offs = lineupOf(A).filter(x => !B.posities[x.name]);           // {name, code: oude positie}
    const ons = lineupOf(B).filter(x => !A.posities[x.name]);            // {name, code: nieuwe positie}
    const moves = lineupOf(A)
      .filter(x => B.posities[x.name] && B.posities[x.name] !== x.code)
      .map(x => ({ name: x.name, from: x.code, to: B.posities[x.name] }));

    const swaps = [];
    const freeOffs = offs.slice();
    const unpairedOns = [];
    ons.forEach(on => {
      const i = freeOffs.findIndex(o => o.code === on.code);
      if (i >= 0) { swaps.push({ off: freeOffs[i].name, on: on.name, pos: on.code }); freeOffs.splice(i, 1); }
      else unpairedOns.push(on);
    });
    unpairedOns.forEach(on => {
      const o = freeOffs.shift();
      swaps.push({ off: o ? o.name : null, on: on.name, pos: on.code });
    });
    freeOffs.forEach(o => swaps.push({ off: o.name, on: null, pos: null }));
    swaps.sort((x, y) => (ORDER.indexOf(x.pos) + 9) % 9 - (ORDER.indexOf(y.pos) + 9) % 9);

    return {
      off: offs.map(x => x.name),
      on: ons.map(x => x.name),
      swaps,
      moves,
      none: swaps.length === 0 && moves.length === 0,
    };
  }

  /** Nederlandse zinnen voor een diff, bv. "Noud eruit → Bram erin (Spits)". */
  function describeDiff(diff) {
    const lines = [];
    diff.swaps.forEach(s => {
      if (s.off && s.on) lines.push(`${s.off} eruit → ${s.on} erin (${posLabel(s.pos)})`);
      else if (s.on) lines.push(`${s.on} erin (${posLabel(s.pos)})`);
      else if (s.off) lines.push(`${s.off} eruit`);
    });
    diff.moves.forEach(m => lines.push(`${m.name}: ${posLabel(m.from)} → ${posLabel(m.to)}`));
    return lines;
  }

  // ───────────────────────── Pure helpers: klok ─────────────────────────

  /** Aantal periodes en lengte per periode (ms). Het schema van de wedstrijd is leidend. */
  function timing(match, settings) {
    const s = settings || {};
    const n = (match && Array.isArray(match.periodes) && match.periodes.length) || Number(s.periods) || 4;
    const minutes = Number(s.minutes) > 0 ? Number(s.minutes) : 50;
    return { periods: n, periodMs: Math.round((minutes / n) * 60000) };
  }

  function newState(matchId, now) {
    return { v: 1, matchId, period: 0, startedAt: null, accMs: 0, finished: false, alerts: {}, updatedAt: now || 0 };
  }

  const isRunning = s => !!(s && s.startedAt != null);

  function startClock(s, now) {
    if (isRunning(s) || s.finished) return s;
    return Object.assign({}, s, { startedAt: now, updatedAt: now });
  }
  const resumeClock = startClock;

  function pauseClock(s, now) {
    if (!isRunning(s)) return s;
    return Object.assign({}, s, { accMs: s.accMs + Math.max(0, now - s.startedAt), startedAt: null, updatedAt: now });
  }

  /** Naar volgende periode (klok staat dan stil tot Start), of na de laatste periode: wedstrijd klaar. */
  function nextPeriod(s, now, periods) {
    const p = pauseClock(s, now);
    if (p.period >= periods - 1) return Object.assign({}, p, { finished: true, updatedAt: now });
    return Object.assign({}, p, { period: p.period + 1, accMs: 0, startedAt: null, updatedAt: now });
  }

  /** Vanuit de samenvatting terug naar de laatste periode (per ongeluk afgesloten). */
  function reopen(s, now) {
    return Object.assign({}, s, { finished: false, updatedAt: now });
  }

  function markAlert(s, kind, now) {
    const alerts = Object.assign({}, s.alerts || {});
    alerts[kind] = s.period;
    return Object.assign({}, s, { alerts, updatedAt: now });
  }

  /** Alles wat de UI over de klok moet weten, afgeleid van tijdstempels. */
  function computeClock(s, now, t) {
    const periods = t.periods, periodMs = t.periodMs;
    const running = isRunning(s);
    const elapsedMs = Math.max(0, (s.accMs || 0) + (running ? Math.max(0, now - s.startedAt) : 0));
    const remainingMs = periodMs - elapsedMs;
    const ended = elapsedMs >= periodMs;
    const started = running || elapsedMs > 0;
    const phase = s.finished ? 'finished' : running ? 'running' : started ? 'paused' : 'ready';
    const half = Math.ceil(periods / 2);
    return {
      period: s.period,
      periodNumber: s.period + 1,
      periods,
      periodMs,
      elapsedMs,
      remainingMs,
      overtimeMs: Math.max(0, -remainingMs),
      progress: periodMs > 0 ? Math.min(1, elapsedMs / periodMs) : 0,
      running,
      started,
      ended,
      warn: !ended && started && remainingMs <= WARN_MS,
      phase,
      isLast: s.period >= periods - 1,
      isHalfTime: phase === 'ready' && s.period > 0 && s.period === half && s.period < periods,
      matchMs: s.period * periodMs + Math.min(elapsedMs, periodMs),
    };
  }

  /** Wedstrijdminuut (1-based, zoals in het voetbal) of null als er nog niet gespeeld is. */
  function matchMinute(clock) {
    if (!clock || clock.phase === 'finished') return null;
    if (clock.period === 0 && !clock.started) return null;
    const capMin = Math.ceil(((clock.period + 1) * clock.periodMs) / 60000);
    return Math.max(1, Math.min(capMin, Math.floor(clock.matchMs / 60000) + 1));
  }

  /** mm:ss. `ceil` voor aftellen (zodat 00:00 samenvalt met het einde). */
  function formatClock(ms, opts) {
    const ceil = opts && opts.ceil;
    const secs = Math.max(0, ceil ? Math.ceil(Math.abs(ms) / 1000) : Math.floor(Math.abs(ms) / 1000));
    const m = Math.floor(secs / 60), sec = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  /** "P2 · 07:41 / 12:30" */
  function clockLabel(clock) {
    return `P${clock.periodNumber} · ${formatClock(clock.elapsedMs)} / ${formatClock(clock.periodMs)}`;
  }

  // ───────────────────────── Pure helpers: score ─────────────────────────

  function scoreOf(match) {
    const sc = match && match.score;
    return { home: Math.max(0, Number(sc && sc.home) || 0), away: Math.max(0, Number(sc && sc.away) || 0) };
  }

  function addGoal(match, team, minute, by) {
    const score = scoreOf(match);
    score[team === 'away' ? 'away' : 'home'] += 1;
    const goals = (Array.isArray(match.goals) ? match.goals : []).slice();
    goals.push({ team: team === 'away' ? 'away' : 'home', minute: minute == null ? null : minute, by: by || null });
    return Object.assign({}, match, { score, goals });
  }

  function setScorer(match, index, by) {
    const goals = (Array.isArray(match.goals) ? match.goals : []).slice();
    if (!goals[index]) return match;
    goals[index] = Object.assign({}, goals[index], { by: by || null });
    return Object.assign({}, match, { goals });
  }

  function undoLastGoal(match) {
    const goals = (Array.isArray(match.goals) ? match.goals : []).slice();
    if (!goals.length) return match;
    const g = goals.pop();
    const score = scoreOf(match);
    const k = g.team === 'away' ? 'away' : 'home';
    score[k] = Math.max(0, score[k] - 1);
    return Object.assign({}, match, { score, goals });
  }

  /** [{name, count}] gesorteerd op aantal; null = "Onbekend". */
  function scorers(match) {
    const map = new Map();
    (Array.isArray(match && match.goals) ? match.goals : []).forEach(g => {
      if (g.team !== 'home') return;
      const k = g.by || null;
      map.set(k, (map.get(k) || 0) + 1);
    });
    return Array.from(map, ([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || (a.name === null) - (b.name === null) || String(a.name).localeCompare(String(b.name)));
  }

  /** Het enige wat live-modus naar de app terugstuurt: { id, score, goals } (nooit de hele wedstrijd). */
  function goalPatch(match) {
    return {
      id: match.id,
      score: scoreOf(match),
      goals: (Array.isArray(match.goals) ? match.goals : []).map(g => Object.assign({}, g)),
    };
  }

  /**
   * Remote wijziging verwerken terwijl live-modus open staat: opstelling e.d. van remote,
   * score/goals van remote alleen als die nieuwer zijn dan onze laatste lokale score-actie.
   */
  function mergeRemote(local, remote, localEditAt) {
    if (!remote || (local && local.id != null && remote.id !== local.id)) return local;
    const merged = Object.assign({}, local, remote);
    const remoteNewer = !localEditAt || (Number(remote.updatedAt) || 0) > localEditAt;
    if (!remoteNewer) {
      merged.score = local.score;
      merged.goals = local.goals;
    }
    return merged;
  }

  // ───────────────────────── Persistentie ─────────────────────────

  function readAll(storage) {
    try {
      const raw = storage && storage.getItem(lsKey());
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch (e) { return {}; }
  }

  function loadState(storage, matchId, now) {
    const all = readAll(storage);
    const s = all[String(matchId)];
    if (s && typeof s === 'object' && typeof s.period === 'number') {
      return Object.assign(newState(matchId, now), s, { alerts: Object.assign({}, s.alerts || {}) });
    }
    return newState(matchId, now);
  }

  function saveState(storage, s, now) {
    try {
      const all = readAll(storage);
      const t = now || Date.now();
      Object.keys(all).forEach(k => { if (!all[k] || t - (all[k].updatedAt || 0) > STATE_TTL_MS) delete all[k]; });
      all[String(s.matchId)] = s;
      storage && storage.setItem(lsKey(), JSON.stringify(all));
    } catch (e) { /* opslag vol/geblokkeerd: klok werkt in deze sessie gewoon door */ }
  }

  function clearState(storage, matchId) {
    try {
      const all = readAll(storage);
      delete all[String(matchId)];
      storage && storage.setItem(lsKey(), JSON.stringify(all));
    } catch (e) { /* negeren */ }
  }

  // ───────────────────────── DOM-laag ─────────────────────────

  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function getStorage() {
    try { const s = root.localStorage; s.getItem('x'); return s; } catch (e) { return null; }
  }

  let ctx = null; // huidige mount

  function mount(containerEl, opts) {
    if (ctx) unmount();
    if (!containerEl) throw new Error('JO10.Live.mount: container ontbreekt');
    const o = opts || {};
    const match = Object.assign({}, o.match || {});
    const now = Date.now();
    const storage = getStorage();
    ctx = {
      el: containerEl,
      match,
      settings: o.settings || {},
      onUpdate: typeof o.onUpdate === 'function' ? o.onUpdate : () => {},
      onExit: typeof o.onExit === 'function' ? o.onExit : () => {},
      storage,
      t: timing(match, o.settings),
      state: loadState(storage, match.id, now),
      sheet: null,
      key: '',
      timer: null,
      wake: null,
      wakeWanted: false,
    };
    const hasLineup = Array.isArray(match.periodes) && match.periodes.length > 0;
    if (ctx.state.period > ctx.t.periods - 1) ctx.state = Object.assign({}, ctx.state, { period: ctx.t.periods - 1 });

    containerEl.innerHTML =
      '<div class="live-root">' +
      '<div class="live-main"></div>' +
      '<div class="live-sheet-host"></div>' +
      '<div class="live-sr" role="status" aria-live="polite" aria-atomic="true"></div>' +
      '</div>';
    ctx.rootEl = containerEl.firstChild;
    ctx.mainEl = ctx.rootEl.querySelector('.live-main');
    ctx.sheetEl = ctx.rootEl.querySelector('.live-sheet-host');
    ctx.srEl = ctx.rootEl.querySelector('.live-sr');

    ctx.onClick = ev => handleClick(ev);
    ctx.onKey = ev => { if (ev.key === 'Escape' && ctx && ctx.sheet) closeSheet(); };
    ctx.onVis = () => {
      if (!ctx) return;
      if (document.visibilityState === 'visible') { tick(true); syncWakeLock(); }
    };
    ctx.rootEl.addEventListener('click', ctx.onClick);
    document.addEventListener('keydown', ctx.onKey);
    document.addEventListener('visibilitychange', ctx.onVis);

    ctx.localEditAt = 0;
    applyLineupMode(hasLineup);
  }

  function applyLineupMode(hasLineup) {
    ctx.noLineup = !hasLineup;
    if (!hasLineup) {
      clearInterval(ctx.timer);
      ctx.timer = null;
      releaseWake(ctx);
      renderNoLineup();
      return;
    }
    render();
    if (!ctx.timer) ctx.timer = setInterval(() => tick(false), 250);
    syncWakeLock();
  }

  /** Optioneel door de app aangeroepen als de opgeslagen wedstrijd remote wijzigt. Klok blijft staan. */
  function update(remoteMatch) {
    if (!ctx || !remoteMatch || remoteMatch.id !== ctx.match.id) return;
    ctx.match = mergeRemote(ctx.match, remoteMatch, ctx.localEditAt);
    ctx.t = timing(ctx.match, ctx.settings);
    if (ctx.state.period > ctx.t.periods - 1) {
      ctx.state = Object.assign({}, ctx.state, { period: ctx.t.periods - 1 });
      saveState(ctx.storage, ctx.state, Date.now());
    }
    if (ctx.sheet && ctx.sheet.type === 'scorer' && !(ctx.match.goals || [])[ctx.sheet.idx]) ctx.sheet = null;
    applyLineupMode(Array.isArray(ctx.match.periodes) && ctx.match.periodes.length > 0);
  }

  function unmount() {
    if (!ctx) return;
    const c = ctx;
    ctx = null;
    clearInterval(c.timer);
    c.rootEl && c.rootEl.removeEventListener('click', c.onClick);
    document.removeEventListener('keydown', c.onKey);
    document.removeEventListener('visibilitychange', c.onVis);
    releaseWake(c);
    if (c.el) c.el.innerHTML = '';
  }

  // ── Wake Lock ──
  async function acquireWake(c) {
    try {
      if (c.wake || !root.navigator || !navigator.wakeLock || document.visibilityState !== 'visible') return;
      const lock = await navigator.wakeLock.request('screen');
      if (ctx !== c || !c.wakeWanted) { lock.release().catch(() => {}); return; }
      c.wake = lock;
      lock.addEventListener && lock.addEventListener('release', () => { if (c.wake === lock) c.wake = null; });
    } catch (e) { /* niet ondersteund of geweigerd: geen probleem */ }
  }
  function releaseWake(c) {
    c.wakeWanted = false;
    const l = c.wake;
    c.wake = null;
    if (l) { try { l.release().catch(() => {}); } catch (e) { /* negeren */ } }
  }
  function syncWakeLock() {
    if (!ctx) return;
    if (isRunning(ctx.state)) { ctx.wakeWanted = true; acquireWake(ctx); }
    else releaseWake(ctx);
  }

  function vibrate(pattern) {
    try { if (root.navigator && typeof navigator.vibrate === 'function') navigator.vibrate(pattern); } catch (e) { /* negeren */ }
  }

  function announce(msg) {
    if (!ctx) return;
    ctx.srEl.textContent = '';
    setTimeout(() => { if (ctx) ctx.srEl.textContent = msg; }, 50);
  }

  // ── State-wijzigingen ──
  function setState(s) {
    ctx.state = s;
    saveState(ctx.storage, s, Date.now());
    syncWakeLock();
    render();
  }

  function updateMatch(m, msg) {
    ctx.match = m;
    ctx.localEditAt = Date.now();
    try { ctx.onUpdate(goalPatch(m)); } catch (e) { console.error(e); }
    render();
    if (msg) announce(msg);
  }

  const clockNow = () => computeClock(ctx.state, Date.now(), ctx.t);
  const periodAt = i => (ctx.match.periodes || [])[i] || {};
  const opponent = () => (ctx.match.tegenstander && String(ctx.match.tegenstander).trim()) || 'Tegenstander';

  function scoreText(m) {
    const sc = scoreOf(m);
    return `${teamName()} ${sc.home}–${sc.away} ${opponent()}`;
  }

  function currentDiffInfo(clock) {
    // Tijdens/na periode p: wissels p → p+1. In de pauze vóór periode p (>0): wissels p-1 → p.
    if (clock.phase === 'ready' && clock.period > 0) {
      return { from: clock.period - 1, to: clock.period, now: true };
    }
    if (clock.isLast) return null;
    return { from: clock.period, to: clock.period + 1, now: clock.ended };
  }

  function tick(force) {
    if (!ctx || ctx.noLineup) return;
    const clock = clockNow();
    const key = renderKey(clock);
    if (force || key !== ctx.key) render(clock);
    else updateLive(clock);

    if (clock.running && clock.warn && ctx.state.alerts.warn !== clock.period) {
      ctx.state = markAlert(ctx.state, 'warn', Date.now());
      saveState(ctx.storage, ctx.state, Date.now());
      vibrate(200);
      announce(clock.isLast
        ? `Nog 1 minuut in de laatste periode.`
        : `Nog 1 minuut in periode ${clock.periodNumber}. Maak de wissels klaar.`);
    }
    if (clock.running && clock.ended && ctx.state.alerts.end !== clock.period) {
      ctx.state = markAlert(ctx.state, 'end', Date.now());
      saveState(ctx.storage, ctx.state, Date.now());
      vibrate([400, 200, 400, 200, 800]);
      if (clock.isLast) announce('Einde van de laatste periode. Druk op Einde wedstrijd.');
      else {
        const lines = describeDiff(diffPeriods(periodAt(clock.period), periodAt(clock.period + 1)));
        announce(`Einde periode ${clock.periodNumber}. Wissel nu. ${lines.join('. ')}`);
      }
    }
  }

  const renderKey = c => [c.phase, c.period, c.warn, c.ended, ctx.sheet ? ctx.sheet.type : ''].join('|');

  function updateLive(clock) {
    const q = sel => ctx.mainEl.querySelectorAll(sel);
    q('[data-live="clock"]').forEach(n => { n.textContent = formatClock(clock.elapsedMs); });
    q('[data-live="progress"]').forEach(n => { n.style.width = (clock.progress * 100).toFixed(1) + '%'; });
    q('[data-live="sub"]').forEach(n => { n.textContent = clockSubText(clock); });
    q('[data-live="countdown"]').forEach(n => { n.textContent = formatClock(clock.remainingMs, { ceil: true }); });
  }

  function clockSubText(c) {
    if (c.phase === 'finished') return 'Wedstrijd afgelopen';
    if (c.ended) return `+${formatClock(c.overtimeMs)} over tijd`;
    if (c.phase === 'ready') return c.period === 0 ? 'Klaar voor de aftrap' : `Klaar voor periode ${c.periodNumber}`;
    return `nog ${formatClock(c.remainingMs, { ceil: true })}`;
  }

  // ── Rendering ──
  function render(clock) {
    if (!ctx) return;
    const c = clock || clockNow();
    ctx.key = renderKey(c);
    const root_ = ctx.rootEl;
    root_.className = 'live-root live-phase-' + c.phase + (c.warn ? ' live-is-warn' : '') + (c.ended && c.phase !== 'finished' ? ' live-is-due' : '');

    const parts = [];
    parts.push(renderTop());
    if (c.ended && c.phase !== 'finished') parts.push(renderBanner(c));
    if (c.phase === 'finished') {
      parts.push(renderSummary(c));
      parts.push(renderScore(c));
      parts.push(renderGoals());
    } else {
      parts.push(renderClock(c));
      const di = currentDiffInfo(c);
      const changeFirst = di && (di.now || c.warn);
      if (changeFirst) parts.push(renderChange(c, di));
      parts.push(renderScore(c));
      if (!changeFirst) parts.push(renderChange(c, di));
      parts.push(renderPitch(c));
      parts.push(renderGoals());
      parts.push(
        '<div class="live-finish-wrap"><button type="button" class="live-btn live-btn-ghost live-btn-finish" data-act="finish">🏁 Wedstrijd afronden</button></div>'
      );
    }
    ctx.mainEl.innerHTML = parts.join('');
    renderSheet(c);
  }

  function renderNoLineup() {
    ctx.rootEl.className = 'live-root live-phase-empty';
    ctx.mainEl.innerHTML =
      renderTop() +
      '<section class="live-card live-empty">' +
      '<div class="live-empty-icon" aria-hidden="true">📋</div>' +
      '<h2>Nog geen opstelling</h2>' +
      '<p>Voor deze wedstrijd is nog geen wisselschema gemaakt. Maak eerst een opstelling, dan kun je hier live de klok, wissels en score bijhouden.</p>' +
      '<button type="button" class="live-btn live-btn-primary" data-act="exit">Terug naar de wedstrijd</button>' +
      '</section>';
  }

  function fmtDate(d) {
    if (!d) return '';
    try {
      const dt = new Date(d + 'T12:00:00');
      if (isNaN(dt)) return esc(d);
      return dt.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
    } catch (e) { return esc(d); }
  }

  function renderTop() {
    const m = ctx.match;
    const where = m.thuisUit === 'uit' ? 'Uit' : m.thuisUit === 'thuis' ? 'Thuis' : '';
    const meta = [where, fmtDate(m.datum)].filter(Boolean).join(' · ');
    return '<header class="live-top">' +
      '<button type="button" class="live-back" data-act="exit" aria-label="Terug (klok loopt door)">‹ Terug</button>' +
      '<div class="live-top-title"><span class="live-live-dot" aria-hidden="true"></span>' +
      `<strong>${esc(teamName())} – ${esc(opponent())}</strong>` +
      (meta ? `<small>${esc(meta)}</small>` : '') +
      '</div></header>';
  }

  function renderBanner(c) {
    const txt = c.isLast ? 'Laatste periode is voorbij' : `Einde periode ${c.periodNumber} — wissel nu!`;
    return `<div class="live-banner" role="alert"><span aria-hidden="true">⏰</span> ${esc(txt)}</div>`;
  }

  function renderClock(c) {
    let status = '';
    if (c.phase === 'running') status = c.ended ? 'Tijd is om' : 'Loopt';
    else if (c.phase === 'paused') status = 'Gepauzeerd';
    else status = c.isHalfTime ? 'Rust' : c.period === 0 ? 'Nog niet begonnen' : 'Wisselmoment';

    let primary = '', secondary = '';
    if (c.phase === 'ready') {
      primary = `<button type="button" class="live-btn live-btn-primary live-btn-xl" data-act="start">▶ ${c.period === 0 ? 'Start wedstrijd' : 'Start P' + c.periodNumber}</button>`;
    } else {
      const nextLabel = c.isLast ? '🏁 Einde wedstrijd' : '⏭ Volgende periode';
      const pauseBtn = c.running
        ? '<button type="button" class="live-btn live-btn-xl ' + (c.ended ? 'live-btn-secondary' : 'live-btn-primary') + '" data-act="pause">⏸ Pauze</button>'
        : '<button type="button" class="live-btn live-btn-xl ' + (c.ended ? 'live-btn-secondary' : 'live-btn-primary') + '" data-act="resume">▶ Hervat</button>';
      const nextBtn = `<button type="button" class="live-btn live-btn-xl ${c.ended ? 'live-btn-primary live-btn-pulse' : 'live-btn-secondary'}" data-act="next">${nextLabel}</button>`;
      primary = c.ended ? nextBtn : pauseBtn;
      secondary = c.ended ? pauseBtn : nextBtn;
    }

    const halftime = c.isHalfTime
      ? '<div class="live-halftime" role="note"><span aria-hidden="true">☕</span> Rust — tijd voor drinken en een praatje</div>'
      : '';

    return '<section class="live-card live-clock-card" aria-label="Wedstrijdklok">' +
      halftime +
      '<div class="live-clock-head">' +
      `<span class="live-pchip">P${c.periodNumber}</span>` +
      `<span class="live-status live-status-${c.ended ? 'due' : c.phase}">${esc(status)}</span>` +
      `<span class="live-of">Periode ${c.periodNumber} van ${c.periods}</span>` +
      '</div>' +
      `<div class="live-clock${c.ended ? ' live-clock-over' : ''}" role="timer" aria-label="${esc(clockLabel(c))}">` +
      `<span class="live-clock-time" data-live="clock">${formatClock(c.elapsedMs)}</span>` +
      `<span class="live-clock-len" aria-hidden="true">/ ${formatClock(c.periodMs)}</span>` +
      '</div>' +
      `<div class="live-progress" aria-hidden="true"><div class="live-progress-bar" data-live="progress" style="width:${(c.progress * 100).toFixed(1)}%"></div></div>` +
      `<div class="live-clock-sub" data-live="sub">${esc(clockSubText(c))}</div>` +
      `<div class="live-actions${secondary ? '' : ' live-actions-one'}">${primary}${secondary}</div>` +
      '</section>';
  }

  function renderChange(c, di) {
    if (!di) {
      return '<section class="live-card live-change live-change-muted" aria-label="Wissels">' +
        '<h2 class="live-h2">Wissels</h2><p class="live-muted">Laatste periode — geen wissels meer. Genieten!</p></section>';
    }
    const diff = diffPeriods(periodAt(di.from), periodAt(di.to));
    let title, sub, cls = '';
    if (di.now) {
      cls = ' live-change-now';
      title = `Wissel nu — voor P${di.to + 1}`;
      sub = c.phase === 'ready' ? `Doe deze wissels vóór de start van periode ${di.to + 1}.` : 'Periode is voorbij: wissel nu.';
    } else {
      if (c.warn) cls = ' live-change-warn';
      title = `Volgende wissel — na P${di.from + 1}`;
      sub = null;
    }
    const countdown = !di.now
      ? `<div class="live-countdown"><span>${c.warn ? 'Nog' : 'Over'}</span> <strong data-live="countdown">${formatClock(c.remainingMs, { ceil: true })}</strong></div>`
      : '';

    let body = '';
    if (diff.none) body = '<p class="live-muted">Geen wissels: iedereen blijft op dezelfde plek.</p>';
    else {
      body = '<ul class="live-swaps">' + diff.swaps.map(s => {
        const pos = s.pos ? posInfo(s.pos) : null;
        return '<li class="live-swap"><div class="live-swap-names">' +
          (s.off ? `<span class="live-swap-off"><span class="live-arrow" aria-hidden="true">▼</span>${esc(s.off)} <em>eruit</em></span>` : '') +
          (s.on ? `<span class="live-swap-on"><span class="live-arrow" aria-hidden="true">▲</span>${esc(s.on)} <em>erin</em></span>` : '') +
          '</div>' +
          (pos ? `<span class="live-pos" style="--pos:${pos.color}">${esc(pos.label)}</span>` : '') +
          '</li>';
      }).join('') + '</ul>';
      if (diff.moves.length) {
        body += '<ul class="live-moves">' + diff.moves.map(m =>
          `<li><strong>${esc(m.name)}</strong>: <span class="live-pos-txt" style="--pos:${posInfo(m.from).color}">${esc(posLabel(m.from))}</span> <span aria-hidden="true">→</span><span class="live-sr-only">wordt</span> <span class="live-pos-txt" style="--pos:${posInfo(m.to).color}">${esc(posLabel(m.to))}</span></li>`
        ).join('') + '</ul>';
      }
    }
    return `<section class="live-card live-change${cls}" aria-label="Wissels">` +
      `<div class="live-change-head"><h2 class="live-h2">${esc(title)}</h2>${countdown}</div>` +
      (sub ? `<p class="live-change-sub">${esc(sub)}</p>` : '') +
      body + '</section>';
  }

  function renderScore(c) {
    const sc = scoreOf(ctx.match);
    const goals = Array.isArray(ctx.match.goals) ? ctx.match.goals : [];
    const last = goals[goals.length - 1];
    const lastTxt = last
      ? (last.team === 'home' ? (last.by || teamName()) : opponent()) + (last.minute != null ? ` ${last.minute}'` : '')
      : '';
    return '<section class="live-card live-score-card" aria-label="Score">' +
      '<h2 class="live-h2 live-score-fix-title">Score corrigeren</h2>' +
      '<div class="live-score">' +
      `<div class="live-team live-team-home"><span class="live-team-name">${esc(teamName())}</span><span class="live-team-goals">${sc.home}</span></div>` +
      '<span class="live-score-sep" aria-hidden="true">–</span>' +
      `<div class="live-team live-team-away"><span class="live-team-goals">${sc.away}</span><span class="live-team-name">${esc(opponent())}</span></div>` +
      '</div>' +
      '<div class="live-score-actions">' +
      `<button type="button" class="live-btn live-btn-primary live-btn-goal" data-act="goal-home">+ Goal ${esc(teamName())}</button>` +
      '<button type="button" class="live-btn live-btn-secondary live-btn-goal" data-act="goal-away">+ Goal tegenstander</button>' +
      '</div>' +
      (last ? `<button type="button" class="live-btn live-btn-link" data-act="undo" aria-label="Laatste goal ongedaan maken (${esc(lastTxt)})">↶ Ongedaan: ${esc(lastTxt)}</button>` : '') +
      '</section>';
  }

  function renderPitch(c) {
    const period = normalizePeriod(periodAt(c.period));
    const rows = { S: [], M: [], V: [], K: [] };
    lineupOf(period).forEach(p => rows[p.code].push(p.name));
    const chip = (name, code) => `<span class="live-chip" style="--pos:${posInfo(code).color}"><b aria-hidden="true">${code}</b>${esc(name)}</span>`;
    const rowHtml = code => rows[code].length
      ? `<div class="live-row live-row-${code}" aria-label="${esc(posLabel(code))}">${rows[code].map(n => chip(n, code)).join('')}</div>` : '';
    return '<section class="live-card live-pitch-card" aria-label="Opstelling">' +
      `<h2 class="live-h2">Opstelling P${c.periodNumber}${c.phase === 'ready' && c.period > 0 ? ' (na de wissel)' : ''}</h2>` +
      '<div class="live-pitch">' +
      '<div class="live-pitch-lines" aria-hidden="true"><i class="live-pl-mid"></i><i class="live-pl-circle"></i><i class="live-pl-box"></i><i class="live-pl-box live-pl-box-top"></i></div>' +
      rowHtml('S') + rowHtml('M') + rowHtml('V') + rowHtml('K') +
      '</div>' +
      '<div class="live-bench"><span class="live-bench-label">🪑 Wissel</span>' +
      (period.wissels.length ? period.wissels.map(n => `<span class="live-chip live-chip-bench">${esc(n)}</span>`).join('') : '<span class="live-muted">niemand</span>') +
      '</div></section>';
  }

  function renderGoals() {
    const goals = Array.isArray(ctx.match.goals) ? ctx.match.goals : [];
    if (!goals.length) return '';
    return '<section class="live-card live-goals" aria-label="Doelpunten"><h2 class="live-h2">Doelpunten</h2><ol class="live-goal-list">' +
      goals.map((g, i) => {
        const min = g.minute != null ? `${g.minute}'` : '–';
        if (g.team === 'home') {
          return `<li class="live-goal live-goal-home"><span class="live-goal-min">${min}</span><span class="live-goal-ball" aria-hidden="true">⚽</span>` +
            `<span class="live-goal-who">${esc(g.by || 'Onbekend')} <small>${esc(teamName())}</small></span>` +
            `<button type="button" class="live-btn live-btn-mini" data-act="edit-scorer" data-idx="${i}" aria-label="Doelpuntenmaker wijzigen">Wijzig</button></li>`;
        }
        return `<li class="live-goal live-goal-away"><span class="live-goal-min">${min}</span><span class="live-goal-ball" aria-hidden="true">⚽</span>` +
          `<span class="live-goal-who">${esc(opponent())}</span></li>`;
      }).join('') + '</ol></section>';
  }

  function renderSummary(c) {
    const sc = scoreOf(ctx.match);
    const result = sc.home > sc.away ? 'Gewonnen! 🎉' : sc.home < sc.away ? 'Verloren — volgende keer beter' : 'Gelijkgespeeld';
    const list = scorers(ctx.match);
    const scorersHtml = list.length
      ? '<ul class="live-scorers">' + list.map(s => `<li><span aria-hidden="true">⚽</span> ${esc(s.name || 'Onbekend')}${s.count > 1 ? ` <b>${s.count}×</b>` : ''}</li>`).join('') + '</ul>'
      : '<p class="live-muted">Geen doelpunten voor ' + esc(teamName()) + '.</p>';
    return '<section class="live-card live-summary" aria-label="Samenvatting">' +
      '<h2 class="live-summary-title">🏁 Einde wedstrijd</h2>' +
      `<div class="live-final"><span>${esc(teamName())}</span><strong>${sc.home} – ${sc.away}</strong><span>${esc(opponent())}</span></div>` +
      `<p class="live-result">${esc(result)}</p>` +
      '<h3 class="live-h3">Doelpuntenmakers</h3>' + scorersHtml +
      '<div class="live-actions live-actions-col">' +
      '<button type="button" class="live-btn live-btn-primary live-btn-xl" data-act="finish-now">✓ Afronden en opslaan</button>' +
      `<button type="button" class="live-btn live-btn-ghost" data-act="reopen">‹ Terug naar periode ${c.periods}</button>` +
      '</div></section>';
  }

  // ── Sheets (keuzelijst doelpuntenmaker, bevestigingen) ──
  function openSheet(sheet) { ctx.sheet = sheet; render(); }
  function closeSheet() { if (!ctx) return; const had = ctx.sheet; ctx.sheet = null; render(); if (had && had.returnFocus) focusAct(had.returnFocus); }
  function focusAct(act) { const b = ctx && ctx.mainEl.querySelector(`[data-act="${act}"]`); if (b) b.focus(); }

  function renderSheet(c) {
    const s = ctx.sheet;
    if (!s) { ctx.sheetEl.innerHTML = ''; return; }
    let inner = '';
    if (s.type === 'scorer') {
      const names = onFieldNames(c);
      const g = (ctx.match.goals || [])[s.idx];
      inner = '<h2 class="live-sheet-title" id="live-sheet-t">⚽ Wie scoorde?</h2>' +
        `<p class="live-sheet-text">${g && g.minute != null ? `Goal in minuut ${g.minute}. ` : ''}Stand: ${esc(scoreText(ctx.match))}</p>` +
        '<div class="live-pick">' +
        names.map(n => `<button type="button" class="live-btn live-btn-pick${g && g.by === n ? ' live-is-sel' : ''}" data-act="pick" data-name="${esc(n)}">${esc(n)}</button>`).join('') +
        `<button type="button" class="live-btn live-btn-pick live-btn-unknown${g && !g.by ? ' live-is-sel' : ''}" data-act="pick" data-name="">Onbekend</button>` +
        '</div>';
    } else if (s.type === 'confirm') {
      inner = `<h2 class="live-sheet-title" id="live-sheet-t">${esc(s.title)}</h2>` +
        `<p class="live-sheet-text">${esc(s.text)}</p>` +
        '<div class="live-actions">' +
        '<button type="button" class="live-btn live-btn-secondary live-btn-xl" data-act="sheet-cancel">Annuleer</button>' +
        `<button type="button" class="live-btn live-btn-primary live-btn-xl" data-act="confirm-ok">${esc(s.ok)}</button>` +
        '</div>';
    }
    ctx.sheetEl.innerHTML =
      '<div class="live-sheet-backdrop" data-act="sheet-cancel"></div>' +
      '<div class="live-sheet" role="dialog" aria-modal="true" aria-labelledby="live-sheet-t">' +
      '<button type="button" class="live-sheet-close" data-act="sheet-cancel" aria-label="Sluiten">✕</button>' +
      inner + '</div>';
    const first = ctx.sheetEl.querySelector('.live-sheet .live-btn');
    if (first) try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); }
  }

  function onFieldNames(c) {
    if (c.phase === 'finished') {
      const all = [];
      (Array.isArray(ctx.match.aanwezig) ? ctx.match.aanwezig : []).forEach(n => all.indexOf(n) < 0 && all.push(n));
      (ctx.match.periodes || []).forEach(p => lineupOf(p).forEach(x => all.indexOf(x.name) < 0 && all.push(x.name)));
      return all;
    }
    // In de wisselpauze telt de opstelling van de periode die (net) gespeeld is/start.
    return lineupOf(periodAt(c.period)).map(x => x.name);
  }

  // ── Acties ──
  function handleClick(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn || !ctx || !ctx.rootEl.contains(btn)) return;
    const act = btn.getAttribute('data-act');
    const now = Date.now();
    const c = computeClock(ctx.state, now, ctx.t);

    switch (act) {
      case 'exit':
        ctx.onExit();
        return;
      case 'start':
      case 'resume':
        setState(startClock(ctx.state, now));
        announce(act === 'start' ? `Periode ${c.periodNumber} gestart.` : 'Klok loopt weer.');
        return;
      case 'pause':
        setState(pauseClock(ctx.state, now));
        announce(`Klok gepauzeerd op ${formatClock(c.elapsedMs)}.`);
        return;
      case 'next':
        if (!c.ended) {
          openSheet({
            type: 'confirm', action: 'next', returnFocus: 'next',
            title: c.isLast ? 'Wedstrijd beëindigen?' : `Periode ${c.periodNumber} afsluiten?`,
            text: `Er staat nog ${formatClock(c.remainingMs, { ceil: true })} op de klok. ` +
              (c.isLast ? 'Toch naar de samenvatting?' : `Toch door naar periode ${c.periodNumber + 1}?`),
            ok: c.isLast ? 'Ja, einde' : 'Ja, volgende',
          });
          return;
        }
        doNext();
        return;
      case 'goal-home': {
        const minute = matchMinute(c);
        const m = addGoal(ctx.match, 'home', minute, null);
        ctx.sheet = { type: 'scorer', idx: m.goals.length - 1, returnFocus: 'goal-home' };
        updateMatch(m, `Goal ${teamName()}! ${scoreText(m)}.`);
        vibrate(80);
        return;
      }
      case 'goal-away': {
        const m = addGoal(ctx.match, 'away', matchMinute(c), null);
        updateMatch(m, `Goal ${opponent()}. ${scoreText(m)}.`);
        vibrate(80);
        return;
      }
      case 'undo': {
        const m = undoLastGoal(ctx.match);
        updateMatch(m, `Laatste goal ongedaan gemaakt. ${scoreText(m)}.`);
        return;
      }
      case 'edit-scorer':
        openSheet({ type: 'scorer', idx: Number(btn.getAttribute('data-idx')), returnFocus: null });
        return;
      case 'pick': {
        const s = ctx.sheet;
        if (!s || s.type !== 'scorer') return;
        const name = btn.getAttribute('data-name') || null;
        const ret = s.returnFocus;
        ctx.sheet = null;
        updateMatch(setScorer(ctx.match, s.idx, name), name ? `Doelpunt van ${name}.` : 'Doelpuntenmaker onbekend.');
        if (ret) focusAct(ret);
        return;
      }
      case 'sheet-cancel':
        closeSheet();
        return;
      case 'confirm-ok': {
        const s = ctx.sheet;
        ctx.sheet = null;
        if (s && s.action === 'next') doNext();
        else if (s && s.action === 'finish') doFinish();
        else render();
        return;
      }
      case 'finish':
        openSheet({
          type: 'confirm', action: 'finish', returnFocus: 'finish',
          title: 'Wedstrijd afronden?',
          text: `Eindstand ${scoreText(ctx.match)} wordt opgeslagen en de klok stopt.`,
          ok: 'Afronden',
        });
        return;
      case 'finish-now':
        doFinish();
        return;
      case 'reopen':
        setState(reopen(ctx.state, now));
        return;
      default:
    }
  }

  function doNext() {
    const now = Date.now();
    const before = computeClock(ctx.state, now, ctx.t);
    const s = nextPeriod(ctx.state, now, ctx.t.periods);
    setState(s);
    window.scrollTo && window.scrollTo({ top: 0, behavior: 'smooth' });
    if (s.finished) announce(`Einde wedstrijd. ${scoreText(ctx.match)}.`);
    else {
      const lines = describeDiff(diffPeriods(periodAt(before.period), periodAt(s.period)));
      const ht = computeClock(s, now, ctx.t).isHalfTime ? 'Rust. ' : '';
      announce(`${ht}Wissels voor periode ${s.period + 1}: ${lines.length ? lines.join('. ') : 'geen'}.`);
    }
  }

  function doFinish() {
    const c = ctx;
    const m = Object.assign({}, c.match, { score: scoreOf(c.match), goals: Array.isArray(c.match.goals) ? c.match.goals.slice() : [] });
    c.match = m;
    try { c.onUpdate(goalPatch(m)); } catch (e) { console.error(e); }
    clearState(c.storage, m.id);
    releaseWake(c);
    clearInterval(c.timer);
    c.onExit();
  }

  const Live = {
    mount,
    unmount,
    update,
    // pure helpers (getest in test/live.test.js)
    timing,
    newState,
    isRunning,
    startClock,
    resumeClock,
    pauseClock,
    nextPeriod,
    reopen,
    markAlert,
    computeClock,
    matchMinute,
    formatClock,
    clockLabel,
    normalizePeriod,
    lineupOf,
    diffPeriods,
    describeDiff,
    scoreOf,
    addGoal,
    setScorer,
    undoLastGoal,
    scorers,
    goalPatch,
    mergeRemote,
    loadState,
    saveState,
    clearState,
  };
  JO10.Live = Live;

  if (typeof module !== 'undefined' && module.exports) module.exports = Live;
})(typeof window !== 'undefined' ? window : globalThis);
