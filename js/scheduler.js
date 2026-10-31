// JO10 Opstelling — wisselschema-logica. Pure functies, geen DOM. Werkt in browser én Node.
//
// Formatie: `formation` = basisformatie voor deze wedstrijd { K, V, M, S } (standaard 1-2-1-2, ook 1-2-2-1).
// Zijn er minder spelers dan de formatie vraagt, dan wordt Config.formationFor(n, formation) gebruikt.
//
// Algoritme (generate):
//   1. Per periode worden de "vaste" cellen bepaald: locks + keeper (een lock met code 'K' gaat boven
//      `keepers`). Ontbrekende keepers worden aangevuld met suggestKeepers().
//   2. Een schema is een rooster speler × periode met codes K/V/M/S/W. De formatie per periode ligt vast,
//      dus alle zoekstappen zijn ruilacties tussen twee niet-vaste spelers binnen dezelfde periode
//      (of tegelijk in twee periodes = wisselbeurten ruilen). Daardoor blijft de formatie altijd exact.
//   3. De kosten zijn een som van per-speler-termen (harde regels met enorme straf, zachte regels met
//      gewichten, zie W hieronder). Daardoor is het effect van een ruil in O(periodes) te berekenen.
//   4. Simulated annealing (seeded mulberry32-PRNG) vanuit een slimme beginopstelling, meerdere restarts,
//      daarna een volledige hill-climb op het beste resultaat. Zelfde seed → zelfde schema.
(function (root) {
  'use strict';
  const JO10 = root.JO10 = root.JO10 || {};

  function cfg() {
    if (JO10.Config) return JO10.Config;
    if (typeof require === 'function') {
      try { return require('./config.js'); } catch (e) { /* ignore */ }
    }
    return null;
  }

  const DEFAULT_FORMATION = { K: 1, V: 2, M: 1, S: 2 };

  // Basisformatie opschonen: gehele getallen ≥ 0, keeper altijd 1, minstens één veldspeler.
  function normFormation(f) {
    const out = { K: 1, V: 0, M: 0, S: 0 };
    if (!f || typeof f !== 'object') return Object.assign({}, DEFAULT_FORMATION);
    ['V', 'M', 'S'].forEach(c => {
      const x = Math.floor(Number(f[c]));
      out[c] = Number.isFinite(x) && x > 0 ? Math.min(x, 20) : 0;
    });
    if (out.V + out.M + out.S === 0) return Object.assign({}, DEFAULT_FORMATION);
    return out;
  }

  // Formatie bij n aanwezige spelers (delegeert naar Config; zelfde regel als reserve).
  function formationFor(n, base) {
    const b = normFormation(base);
    const C = cfg();
    if (C && typeof C.formationFor === 'function') return C.formationFor(n, b);
    const f = Object.assign({}, b);
    while (f.K + f.V + f.M + f.S > Math.max(1, n)) {
      const order = ['S', 'M', 'V'].filter(c => f[c] > 0).sort((a, c) => f[c] - f[a]);
      if (!order.length) break;
      f[order[0]]--;
    }
    return f;
  }

  // Seizoensaandeel per linie volgens de verhouding in de basisformatie (2-1-2 → .4/.2/.4, 2-2-1 → .4/.4/.2).
  function shareOf(base) {
    const f = normFormation(base);
    const t = f.V + f.M + f.S;
    return { V: f.V / t, M: f.M / t, S: f.S / t };
  }

  // Max aantal periodes op dezelfde linie per wedstrijd (~helft, minimaal 2): 2/3/4 → 2, 5/6 → 3.
  // Minimaal 2 zodat 2- en 4-periodenwedstrijden precies dezelfde regel houden als vóór de formatiekeuze.
  const maxSameOf = P => Math.max(2, Math.ceil(P / 2));

  // ── constanten ──────────────────────────────────────────────────────────
  const CODES = ['K', 'V', 'M', 'S', 'W'];
  const IDX = { K: 0, V: 1, M: 2, S: 3, W: 4 };
  const K = 0, V = 1, M = 2, S = 3, WI = 4;
  const LABEL = { K: 'Keeper', V: 'Verdediger', M: 'Middenvelder', S: 'Spits', W: 'Wissel' };
  const PLURAL = {
    K: ['keeper', 'keepers'], V: ['verdediger', 'verdedigers'], M: ['middenvelder', 'middenvelders'],
    S: ['spits', 'spitsen'], W: ['wissel', 'wissels'],
  };

  // Gewichten van de kostenfunctie (per speler opgeteld).
  const W = {
    CONSEC: 10000,  // hard: twee periodes achter elkaar wissel
    AVOID: 400,     // per periode op een 'liever niet'-positie
    EVEN: 100,      // × wissels² — met vast totaal is dit minimaal bij gelijke verdeling (verschil ≤ 1)
    SEASON: 20,     // × wissels × seizoensschuld (geclipt op ±3) — max 120 < 2×EVEN, breekt gelijkheid dus nooit
    REPEAT: 80,     // per periode boven max ~helft (ceil(P/2)) op dezelfde veldpositie
    P1: 60,         // vorige wedstrijd begonnen als wissel en nu weer
    VARIETY: 30,    // ≥ 2 veldperiodes maar maar één soort positie
    BAL: 5,         // seizoensbalans V:M:S volgens formatieverhouding (Huber-afwijking, dus begrensd effect per periode)
    CHANGE: 6,      // positiewissel tussen twee opeenvolgende veldperiodes (rust/continuïteit)
  };
  const DEBT_CLIP = 3;

  // ── PRNG ────────────────────────────────────────────────────────────────
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedOf(seed) {
    if (typeof seed === 'number' && isFinite(seed)) return (Math.floor(seed) ^ 0x9E3779B9) >>> 0;
    const s = String(seed == null ? '1' : seed);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // ── helpers ─────────────────────────────────────────────────────────────
  const isName = s => typeof s === 'string' && s.trim() !== '';
  function uniq(arr) {
    const out = [], seen = new Set();
    (Array.isArray(arr) ? arr : []).forEach(x => { if (isName(x) && !seen.has(x)) { seen.add(x); out.push(x); } });
    return out;
  }
  function normCode(c) {
    if (typeof c !== 'string') return null;
    const u = c.trim().toUpperCase();
    return IDX[u] !== undefined ? u : null;
  }
  function normPeriod(p) {
    const posities = {}, wissels = [];
    if (p && typeof p === 'object') {
      const pos = p.posities && typeof p.posities === 'object' ? p.posities : {};
      Object.keys(pos).forEach(name => {
        const c = normCode(pos[name]);
        if (!c) return;
        if (c === 'W') { if (!wissels.includes(name)) wissels.push(name); } else posities[name] = c;
      });
      const ws = Array.isArray(p.wissels) ? p.wissels : (Array.isArray(p.subs) ? p.subs : []);
      ws.forEach(name => { if (isName(name) && !wissels.includes(name)) wissels.push(name); });
    }
    return { posities, wissels };
  }
  function normHistory(history) {
    return (Array.isArray(history) ? history : [])
      .filter(m => m && typeof m === 'object')
      .map((m, i) => ({ i, datum: typeof m.datum === 'string' ? m.datum : '', periodes: (Array.isArray(m.periodes) ? m.periodes : []).map(normPeriod) }));
  }
  function lastMatch(hist) {
    let best = null;
    hist.forEach(m => { if (m.periodes.length && (!best || m.datum >= best.datum)) best = m; });
    return best;
  }
  function avoidLookup(squad) {
    const C = cfg();
    const sq = squad === undefined ? (C && C.DEFAULT_SQUAD) : squad;
    const map = new Map();
    const players = sq && Array.isArray(sq.players) ? sq.players : [];
    players.forEach(pl => {
      if (!pl || !isName(pl.name)) return;
      const av = (Array.isArray(pl.avoid) ? pl.avoid : []).map(normCode).filter(c => c && c !== 'W');
      const keys = [pl.name].concat(Array.isArray(pl.aliases) ? pl.aliases : []);
      keys.forEach(k => { if (isName(k)) map.set(k.trim().toLowerCase(), av); });
    });
    return name => map.get(String(name).trim().toLowerCase()) || [];
  }
  const codeOf = c => CODES[c];
  function huber(d) { const a = Math.abs(d); return a <= 2 ? d * d : 4 * a - 4; }
  function pList(ps) { // [1,2,3] → "P1, P2 en P3"
    const s = ps.map(p => 'P' + (p + 1));
    return s.length <= 1 ? s.join('') : s.slice(0, -1).join(', ') + ' en ' + s[s.length - 1];
  }
  function plural(code, n) { return n + ' ' + PLURAL[code][n === 1 ? 0 : 1]; }

  // ── statistiek ─────────────────────────────────────────────────────────
  // Per naam: K/V/M/S/W-periodes, gespeelde wedstrijden, aanwezige periodes, verwachte wisselbeurten
  // (eerlijk aandeel van de wisselplekken in elke wedstrijd) en wedstrijden als keeper.
  function historyInfo(hist) {
    const info = new Map();
    const get = name => {
      let r = info.get(name);
      if (!r) { r = { K: 0, V: 0, M: 0, S: 0, W: 0, matches: 0, periods: 0, expectedSubs: 0, kMatches: 0 }; info.set(name, r); }
      return r;
    };
    hist.forEach(m => {
      const attended = new Set();
      const keeperIn = new Set();
      let slots = 0, attendeePeriods = 0;
      const perPeriod = m.periodes.map(p => {
        const names = new Set(Object.keys(p.posities).concat(p.wissels));
        slots += p.wissels.length;
        attendeePeriods += names.size;
        return names;
      });
      const presentCount = new Map();
      m.periodes.forEach((p, pi) => {
        perPeriod[pi].forEach(name => {
          attended.add(name);
          presentCount.set(name, (presentCount.get(name) || 0) + 1);
          const r = get(name);
          r.periods++;
          if (p.wissels.includes(name)) r.W++;
          else { const c = p.posities[name]; r[c]++; if (c === 'K') keeperIn.add(name); }
        });
      });
      attended.forEach(name => {
        const r = get(name);
        r.matches++;
        if (attendeePeriods > 0) r.expectedSubs += slots * presentCount.get(name) / attendeePeriods;
      });
      keeperIn.forEach(name => { get(name).kMatches++; });
    });
    return info;
  }

  function stats(history, names) {
    const hist = normHistory(history);
    const info = historyInfo(hist);
    const list = Array.isArray(names) ? uniq(names) : Array.from(info.keys()).sort((a, b) => a.localeCompare(b));
    const out = {};
    list.forEach(name => {
      const r = info.get(name) || { K: 0, V: 0, M: 0, S: 0, W: 0, matches: 0, periods: 0 };
      out[name] = {
        matches: r.matches, periods: r.periods, K: r.K, V: r.V, M: r.M, S: r.S, W: r.W,
        fieldPct: r.periods ? Math.round((r.periods - r.W) / r.periods * 100) : 0,
      };
    });
    return out;
  }

  // ── keepers voorstellen ────────────────────────────────────────────────
  function suggestKeepers(opts) {
    opts = opts || {};
    const players = uniq(opts.players);
    const sq = opts.squad;
    let P = opts.periods | 0;
    if (P <= 0) P = (sq && sq.settings && sq.settings.periods) | 0 || 4;
    if (!players.length) return [];
    const info = historyInfo(normHistory(opts.history));
    const avoidOf = avoidLookup(sq);
    let cands = players.filter(p => !avoidOf(p).includes('K'));
    if (!cands.length) cands = players.slice();
    const rank = (a, b) => {
      const ra = info.get(a) || { K: 0, kMatches: 0 }, rb = info.get(b) || { K: 0, kMatches: 0 };
      return (ra.K - rb.K) || (ra.kMatches - rb.kMatches) || a.localeCompare(b);
    };
    cands.sort(rank);
    const half = Math.ceil(P / 2);
    const first = cands[0];
    const second = cands.length >= 2 ? cands[1] : cands[0];
    return Array.from({ length: P }, (_, p) => (p < half ? first : second));
  }

  // ── kostenmodel ────────────────────────────────────────────────────────
  // Bouwt de per-speler statische gegevens op; colCost(i, col) berekent de kosten van één spelerkolom.
  function buildModel(players, P, hist, avoidOf, base) {
    const SHARE = shareOf(base);
    const maxSame = maxSameOf(P);
    const info = historyInfo(hist);
    const last = lastMatch(hist);
    const lastP1 = new Set(last && last.periodes[0] ? last.periodes[0].wissels : []);
    const data = players.map(name => {
      const r = info.get(name);
      let debt = r ? r.W - r.expectedSubs : 0;
      debt = Math.max(-DEBT_CLIP, Math.min(DEBT_CLIP, debt));
      let mask = 0;
      avoidOf(name).forEach(c => { mask |= 1 << IDX[c]; });
      return { name, debt, p1: lastP1.has(name), hV: r ? r.V : 0, hM: r ? r.M : 0, hS: r ? r.S : 0, mask };
    });
    function colCost(i, col) {
      const d = data[i];
      let subs = 0, consec = 0, cV = 0, cM = 0, cS = 0, changes = 0, avoidN = 0;
      let prevW = false, prevF = -1;
      for (let p = 0; p < P; p++) {
        const c = col[p];
        if (c === WI) {
          subs++; if (prevW) consec++; prevW = true; prevF = -1;
        } else {
          prevW = false;
          if (c === V) cV++; else if (c === M) cM++; else if (c === S) cS++;
          if (c !== K) { if (prevF > 0 && prevF !== c) changes++; prevF = c; } else prevF = -1;
        }
        if ((d.mask >> c) & 1) avoidN++;
      }
      let cost = W.EVEN * subs * subs + W.SEASON * subs * d.debt + W.CONSEC * consec + W.AVOID * avoidN + W.CHANGE * changes;
      if (d.p1 && P > 0 && col[0] === WI) cost += W.P1;
      cost += W.REPEAT * (Math.max(0, cV - maxSame) + Math.max(0, cM - maxSame) + Math.max(0, cS - maxSame));
      const fieldN = cV + cM + cS;
      if (fieldN >= 2 && (cV === fieldN || cM === fieldN || cS === fieldN)) cost += W.VARIETY;
      const tV = d.hV + cV, tM = d.hM + cM, tS = d.hS + cS, T = tV + tM + tS;
      if (T > 0) cost += W.BAL * (huber(tV - SHARE.V * T) + huber(tM - SHARE.M * T) + huber(tS - SHARE.S * T));
      return cost;
    }
    return { data, colCost };
  }

  // ── generate ───────────────────────────────────────────────────────────
  function generate(opts) {
    opts = opts || {};
    const players = uniq(opts.players);
    const n = players.length;
    const sq = opts.squad;
    const keepersIn = Array.isArray(opts.keepers) ? opts.keepers : [];
    let P = opts.periods | 0;
    if (P <= 0) P = keepersIn.length || ((sq && sq.settings && sq.settings.periods) | 0) || 4;
    const warnings = [];
    const emptyResult = msg => ({
      periodes: Array.from({ length: P }, () => ({ posities: {}, wissels: [] })),
      cost: 0, warnings: [msg], fairness: { perPlayer: {}, score: 0 }, keepers: [],
    });
    if (!n) return emptyResult('Geen spelers geselecteerd');

    const hist = normHistory(opts.history);
    const avoidOf = avoidLookup(sq);
    const base = normFormation(opts.formation);
    const form = formationFor(n, base);
    const fieldCount = form.K + form.V + form.M + form.S;
    const cap = [form.K, form.V, form.M, form.S, Math.max(0, n - fieldCount)];
    if (n < base.K + base.V + base.M + base.S) warnings.push(`Maar ${n} spelers aanwezig: formatie ${form.K}-${form.V}-${form.M}-${form.S}`);
    const index = new Map(players.map((p, i) => [p, i]));

    // Locks per periode
    const locksBy = Array.from({ length: P }, () => []);
    (Array.isArray(opts.locks) ? opts.locks : []).forEach(l => {
      if (!l || typeof l !== 'object') return;
      const p = Number(l.period), code = normCode(l.code);
      if (!Number.isInteger(p) || p < 0 || p >= P || !code) return;
      if (!index.has(l.player)) { warnings.push(`Vastzetting voor ${l.player} genegeerd (niet aanwezig)`); return; }
      // Meerdere locks voor dezelfde speler in dezelfde periode: de laatste wint (= meest recente bewerking)
      const i = index.get(l.player), prev = locksBy[p].findIndex(x => x.i === i);
      if (prev >= 0) {
        if (locksBy[p][prev].code !== IDX[code]) warnings.push(`${l.player} heeft in periode ${p + 1} twee vastzettingen; ${LABEL[code]} aangehouden`);
        locksBy[p].splice(prev, 1);
      }
      locksBy[p].push({ i, code: IDX[code] });
    });

    let suggested = null;
    const suggestion = p => {
      if (!suggested) suggested = suggestKeepers({ players, history: opts.history, squad: sq, periods: P });
      return suggested[p];
    };

    // Vaste cellen per periode
    const fixed = [], freeIdx = [], freeCodes = [];
    const keeperMoved = []; // [periode, keepernaam] waar de opgegeven keeper elders vaststaat
    for (let p = 0; p < P; p++) {
      const f = new Int8Array(n).fill(-1);
      const rem = cap.slice();
      const fix = (i, c) => { f[i] = c; rem[c]--; };
      const locks = locksBy[p];
      // 1) K-locks gaan voor de keeperlijst
      locks.forEach(l => {
        if (l.code !== K || f[l.i] !== -1) return;
        if (rem[K] > 0) fix(l.i, K);
        else warnings.push(`Vastzetting genegeerd: ${players[l.i]} als Keeper in periode ${p + 1} (er is al een keeper)`);
      });
      // 2) keeper uit de keeperlijst (tenzij die speler deze periode anders vastgezet is)
      const kName = keepersIn[p];
      if (rem[K] > 0) {
        if (isName(kName) && index.has(kName)) {
          const ki = index.get(kName);
          if (f[ki] === -1 && !locks.some(l => l.i === ki)) fix(ki, K);
        } else if (isName(kName)) {
          warnings.push(`Keeper ${kName} (periode ${p + 1}) is niet aanwezig`);
        }
      }
      // 3) overige locks
      locks.forEach(l => {
        if (l.code === K || f[l.i] !== -1) return;
        if (rem[l.code] > 0) fix(l.i, l.code);
        else warnings.push(`Vastzetting genegeerd: ${players[l.i]} als ${LABEL[CODES[l.code]]} in periode ${p + 1} past niet in de formatie`);
      });
      // 4) nog geen keeper → voorstel
      if (rem[K] > 0 && isName(kName) && index.has(kName)) keeperMoved.push([p, kName]);
      if (rem[K] > 0) {
        const s = suggestion(p);
        const si = index.has(s) ? index.get(s) : -1;
        if (si >= 0 && f[si] === -1) {
          fix(si, K);
          if (!isName(kName) || !index.has(kName)) warnings.push(`Geen keeper voor periode ${p + 1}: ${s} voorgesteld`);
        }
      }
      const fi = [], fc = [];
      for (let i = 0; i < n; i++) if (f[i] === -1) fi.push(i);
      for (let c = 0; c < 5; c++) for (let k = 0; k < rem[c]; k++) fc.push(c);
      // (sum(cap) === n, dus fc.length === fi.length; voor de zekerheid afkappen/aanvullen)
      while (fc.length > fi.length) fc.pop();
      while (fc.length < fi.length) fc.push(WI);
      fixed.push(f); freeIdx.push(fi); freeCodes.push(fc);
    }

    const model = buildModel(players, P, hist, avoidOf, base);
    const colCost = model.colCost;
    const rng = mulberry32(seedOf(opts.seed === undefined ? 1 : opts.seed));

    // grid[i] = Int8Array(P) met codes
    const newGrid = () => players.map(() => new Int8Array(P));
    const copyGrid = (src, dst) => { for (let i = 0; i < n; i++) dst[i].set(src[i]); };

    function initial(grid) {
      const subs = new Int32Array(n);
      for (let p = 0; p < P; p++) {
        const f = fixed[p];
        for (let i = 0; i < n; i++) if (f[i] >= 0) grid[i][p] = f[i];
        const fi = freeIdx[p];
        const codes = freeCodes[p];
        const wCount = codes.filter(c => c === WI).length;
        const order = fi.map(i => ({
          i, k: (p > 0 && grid[i][p - 1] === WI ? 1000 : 0) + subs[i] * 10 + model.data[i].debt * -2 + rng() * 5,
        })).sort((a, b) => a.k - b.k);
        const rest = codes.filter(c => c !== WI);
        for (let k = rest.length - 1; k > 0; k--) { const j = Math.floor(rng() * (k + 1)); const t = rest[k]; rest[k] = rest[j]; rest[j] = t; }
        order.forEach((o, k) => {
          if (k < wCount) { grid[o.i][p] = WI; subs[o.i]++; } else grid[o.i][p] = rest[k - wCount];
        });
      }
    }

    const movable = [];
    for (let p = 0; p < P; p++) if (freeIdx[p].length >= 2) movable.push(p);
    const isFree = (i, p) => fixed[p][i] === -1;

    function anneal(grid, iters) {
      const costs = new Float64Array(n);
      let total = 0;
      for (let i = 0; i < n; i++) { costs[i] = colCost(i, grid[i]); total += costs[i]; }
      const best = newGrid(); copyGrid(grid, best);
      let bestTotal = total;
      if (!movable.length) return { grid: best, total: bestTotal };
      const T0 = 80, T1 = 0.5;
      for (let it = 0; it < iters; it++) {
        const T = T0 * Math.pow(T1 / T0, it / iters);
        const p = movable[Math.floor(rng() * movable.length)];
        const fi = freeIdx[p];
        const a = fi[Math.floor(rng() * fi.length)];
        let b = fi[Math.floor(rng() * (fi.length - 1))];
        if (b === a) b = fi[fi.length - 1];
        const ga = grid[a], gb = grid[b];
        if (ga[p] === gb[p]) continue;
        let q = -1;
        if (P > 1 && rng() < 0.3) {
          q = Math.floor(rng() * (P - 1)); if (q >= p) q++;
          if (!isFree(a, q) || !isFree(b, q) || ga[q] === gb[q]) q = -1;
        }
        let t = ga[p]; ga[p] = gb[p]; gb[p] = t;
        if (q >= 0) { t = ga[q]; ga[q] = gb[q]; gb[q] = t; }
        const na = colCost(a, ga), nb = colCost(b, gb);
        const delta = na + nb - costs[a] - costs[b];
        if (delta <= 0 || rng() < Math.exp(-delta / T)) {
          costs[a] = na; costs[b] = nb; total += delta;
          if (total < bestTotal - 1e-9) { bestTotal = total; copyGrid(grid, best); }
        } else {
          t = ga[p]; ga[p] = gb[p]; gb[p] = t;
          if (q >= 0) { t = ga[q]; ga[q] = gb[q]; gb[q] = t; }
        }
      }
      return { grid: best, total: bestTotal };
    }

    // Volledige hill-climb: alle ruilen binnen een periode en alle dubbele ruilen over twee periodes.
    function polish(grid) {
      const costs = new Float64Array(n);
      for (let i = 0; i < n; i++) costs[i] = colCost(i, grid[i]);
      for (let pass = 0; pass < 30; pass++) {
        let improved = false;
        for (const p of movable) {
          const fi = freeIdx[p];
          for (let x = 0; x < fi.length; x++) for (let y = x + 1; y < fi.length; y++) {
            const a = fi[x], b = fi[y], ga = grid[a], gb = grid[b];
            if (ga[p] === gb[p]) continue;
            for (let q = -1; q < P; q++) {
              if (q === p) continue;
              if (q >= 0 && (!isFree(a, q) || !isFree(b, q) || ga[q] === gb[q])) continue;
              let t = ga[p]; ga[p] = gb[p]; gb[p] = t;
              if (q >= 0) { t = ga[q]; ga[q] = gb[q]; gb[q] = t; }
              const na = colCost(a, ga), nb = colCost(b, gb);
              if (na + nb < costs[a] + costs[b] - 1e-9) { costs[a] = na; costs[b] = nb; improved = true; }
              else { t = ga[p]; ga[p] = gb[p]; gb[p] = t; if (q >= 0) { t = ga[q]; ga[q] = gb[q]; gb[q] = t; } }
            }
          }
        }
        if (!improved) break;
      }
      let total = 0;
      for (let i = 0; i < n; i++) total += costs[i];
      return total;
    }

    const RESTARTS = 8;
    const ITERS = Math.min(10000, 1000 + 200 * n * P);
    let best = null, bestTotal = Infinity;
    const work = newGrid();
    for (let r = 0; r < RESTARTS; r++) {
      initial(work);
      const res = anneal(work, ITERS);
      const tot = polish(res.grid);
      if (tot < bestTotal - 1e-9) { bestTotal = tot; best = res.grid; }
    }

    // Uitvoer opbouwen (posities in volgorde K, V, M, S)
    const periodes = [], keepersOut = [];
    for (let p = 0; p < P; p++) {
      const posities = {}, wissels = [];
      for (const c of [K, V, M, S]) for (let i = 0; i < n; i++) if (best[i][p] === c) posities[players[i]] = CODES[c];
      for (let i = 0; i < n; i++) if (best[i][p] === WI) wissels.push(players[i]);
      periodes.push({ posities, wissels });
      keepersOut.push(Object.keys(posities).find(k => posities[k] === 'K') || null);
    }

    keeperMoved.forEach(([p, kName]) => {
      const c = codeOf(best[index.get(kName)][p]);
      warnings.push(`${kName} staat in periode ${p + 1} vast als ${LABEL[c]}; ${keepersOut[p] || 'niemand'} keept`);
    });

    const ev = evaluate(periodes, { players, keepers: keepersOut, history: opts.history, squad: sq, formation: base });
    const allWarnings = [];
    warnings.concat(ev.warnings).forEach(w => { if (!allWarnings.includes(w)) allWarnings.push(w); });
    return {
      periodes,
      cost: Math.round(bestTotal * 10) / 10,
      warnings: allWarnings,
      fairness: { perPlayer: ev.perPlayer, score: ev.score },
      keepers: keepersOut,
    };
  }

  // ── evaluate ───────────────────────────────────────────────────────────
  function evaluate(periodes, ctx) {
    ctx = ctx || {};
    const pers = (Array.isArray(periodes) ? periodes : []).map(normPeriod);
    const P = pers.length;
    const scheduled = [];
    pers.forEach(p => { Object.keys(p.posities).concat(p.wissels).forEach(nm => { if (!scheduled.includes(nm)) scheduled.push(nm); }); });
    const players = Array.isArray(ctx.players) ? uniq(ctx.players) : scheduled.slice();
    const keepers = Array.isArray(ctx.keepers) ? ctx.keepers : [];
    const avoidOf = avoidLookup(ctx.squad);
    const n = players.length;
    const form = n ? formationFor(n, ctx.formation) : { K: 0, V: 0, M: 0, S: 0 };
    const maxSame = maxSameOf(P);
    const need = { K: form.K, V: form.V, M: form.M, S: form.S, W: Math.max(0, n - (form.K + form.V + form.M + form.S)) };
    const warnings = [];
    let penalty = 0;

    const perPlayer = {};
    const blank = () => ({ field: 0, sub: 0, K: 0, V: 0, M: 0, S: 0 });
    players.forEach(nm => { perPlayer[nm] = blank(); });
    const extra = scheduled.filter(nm => !players.includes(nm));
    extra.forEach(nm => { perPlayer[nm] = blank(); warnings.push(`${nm} staat in de opstelling maar is niet aanwezig`); penalty += 5; });

    const codesOf = {}; // naam → [code|null per periode]
    Object.keys(perPlayer).forEach(nm => { codesOf[nm] = new Array(P).fill(null); });

    pers.forEach((per, p) => {
      const cnt = { K: 0, V: 0, M: 0, S: 0, W: 0 };
      Object.keys(per.posities).forEach(nm => {
        const c = per.posities[nm];
        cnt[c]++;
        if (perPlayer[nm]) { perPlayer[nm].field++; perPlayer[nm][c]++; }
        if (codesOf[nm]) codesOf[nm][p] = c;
        if (per.wissels.includes(nm)) { warnings.push(`${nm} staat in periode ${p + 1} zowel op het veld als wissel`); penalty += 10; }
      });
      per.wissels.forEach(nm => {
        cnt.W++;
        if (per.posities[nm]) return;
        if (perPlayer[nm]) perPlayer[nm].sub++;
        if (codesOf[nm]) codesOf[nm][p] = 'W';
      });
      const missing = players.filter(nm => !per.posities[nm] && !per.wissels.includes(nm));
      if (missing.length) { warnings.push(`Periode ${p + 1}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'zijn'} niet ingedeeld`); penalty += 10; }
      if (n) {
        const wrong = CODES.filter(c => cnt[c] !== need[c]);
        if (wrong.length) {
          warnings.push(`Formatie periode ${p + 1} klopt niet: ${wrong.map(c => plural(c, cnt[c])).join(', ')}`);
          penalty += 20;
        }
      }
      const k = keepers[p];
      if (isName(k) && per.posities[k] !== 'K') {
        if (per.wissels.includes(k)) warnings.push(`${k} is keeper in periode ${p + 1} maar staat als wissel`);
        else warnings.push(`Keeper periode ${p + 1} is ${k}, maar ${k} staat niet op doel`);
        penalty += 15;
      }
    });

    // Per speler: wissel achter elkaar, liever-niet-posities, te vaak dezelfde positie
    Object.keys(codesOf).forEach(nm => {
      const col = codesOf[nm];
      let run = [];
      const flush = () => {
        if (run.length === 2) warnings.push(`${nm} staat twee periodes achter elkaar wissel (P${run[0] + 1} en P${run[1] + 1})`);
        else if (run.length > 2) warnings.push(`${nm} staat ${run.length} periodes achter elkaar wissel (P${run[0] + 1} t/m P${run[run.length - 1] + 1})`);
        if (run.length >= 2) penalty += 15 * (run.length - 1);
        run = [];
      };
      col.forEach((c, p) => { if (c === 'W') run.push(p); else flush(); });
      flush();
      const av = avoidOf(nm);
      ['V', 'M', 'S'].forEach(c => {
        const ps = [];
        col.forEach((x, p) => { if (x === c) ps.push(p); });
        if (av.includes(c) && ps.length) { warnings.push(`${nm} staat als ${LABEL[c]} (liever niet): ${pList(ps)}`); penalty += 6 * ps.length; }
        if (ps.length > maxSame) { warnings.push(`${nm} staat ${ps.length} periodes als ${LABEL[c]} (liever max ${maxSame})`); penalty += 4 * (ps.length - maxSame); }
      });
    });

    // Gelijke speeltijd (spelers die elke periode keepen tellen niet mee)
    const subsList = players.filter(nm => !(P > 0 && codesOf[nm].every(c => c === 'K'))).map(nm => ({ nm, s: perPlayer[nm].sub }));
    if (subsList.length >= 2) {
      const max = Math.max(...subsList.map(x => x.s)), min = Math.min(...subsList.map(x => x.s));
      if (max - min > 1) {
        const hi = subsList.filter(x => x.s === max).map(x => x.nm), lo = subsList.filter(x => x.s === min).map(x => x.nm);
        warnings.push(`Speeltijd ongelijk: ${hi.join(', ')} ${max}× wissel, ${lo.join(', ')} ${min}× wissel`);
        penalty += 12 * (max - min - 1);
      }
    }

    // Vorige wedstrijd begonnen als wissel
    const last = lastMatch(normHistory(ctx.history));
    if (last && last.periodes[0] && P > 0) {
      const lastP1 = last.periodes[0].wissels;
      pers[0].wissels.filter(nm => lastP1.includes(nm)).forEach(nm => {
        warnings.push(`${nm} begon vorige wedstrijd ook als wissel`);
        penalty += 3;
      });
    }

    const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
    return { warnings, perPlayer, score };
  }

  JO10.Scheduler = {
    generate, evaluate, suggestKeepers, stats, formationFor,
    DEFAULT_FORMATION: Object.assign({}, DEFAULT_FORMATION),
    // intern, voor tests
    _mulberry32: mulberry32, _weights: W, _shareOf: shareOf, _maxSameOf: maxSameOf, _normFormation: normFormation,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = JO10.Scheduler;
})(typeof window !== 'undefined' ? window : globalThis);
