// JO10 Opstelling — export/import: PNG (deelbaar plaatje), Excel (v1-formaat + seizoensoverzicht), WhatsApp-tekst.
// Pure delen (parseRows, buildSchemaRows, buildSeasonRows, pngLayout, whatsappText) zijn zonder DOM testbaar.
(function (root) {
  const JO10 = root.JO10 = root.JO10 || {};

  function cfg() {
    if (JO10.Config) return JO10.Config;
    if (typeof require === 'function') { try { return require('./config.js'); } catch (e) { /* ignore */ } }
    return {};
  }

  // ── omgeving (injecteerbaar voor tests) ────────────────────────────────────
  let envOverride = {};
  const envGet = k => (k in envOverride ? envOverride[k] : root[k]);

  const HDR = ['Tijd', 'Keeper', 'Verd 1', 'Verd 2', 'Midden', 'Spits 1', 'Spits 2', 'Wissel 1', 'Wissel 2'];
  const WEEKDAYS = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  const ORDER = ['K', 'V', 'M', 'S'];

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const pad2 = n => String(n).padStart(2, '0');
  const str = v => (v === null || v === undefined ? '' : String(v).trim());

  function norm(m) {
    const S = JO10.Store;
    if (S && typeof S.normalizeMatch === 'function') return S.normalizeMatch(m);
    const c = JSON.parse(JSON.stringify(m || {}));
    c.periodes = (c.periodes || []).map(p => ({ posities: p.posities || {}, wissels: p.wissels || p.subs || [] }));
    return c;
  }
  function teamName(settings) { return (settings && settings.teamName) || cfg().TEAM_NAME || 'JO10'; }
  function minutesOf(settings) { return (settings && Number(settings.minutes)) || 50; }

  function namesFor(p, code) {
    return Object.keys(p.posities || {}).filter(n => p.posities[n] === code);
  }

  // 'YYYY-MM-DD' → Date (lokaal, zonder tijdzone-verschuiving)
  function isoToDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(iso));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function isoToDMY(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(iso));
    return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
  }
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // Excel-celwaarde → 'YYYY-MM-DD' of ''
  function parseDate(v) {
    if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
    if (typeof v === 'number' && v > 20000 && v < 80000) {   // Excel-serienummer
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
    const s = str(v);
    let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
    m = /(?:^|\D)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/.exec(s);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) {
      const y = m[3].length === 2 ? '20' + m[3] : m[3];
      return `${y}-${pad2(m[2])}-${pad2(m[1])}`;
    }
    return '';
  }

  function periodTimeLabels(n, minutes, style) {
    const C = cfg();
    if (style !== 'excel' && typeof C.periodTimes === 'function') return C.periodTimes(n, minutes);
    const len = minutes / n;
    const f = x => String(Math.round(x * 10) / 10);
    return Array.from({ length: n }, (_, i) => `${f(i * len)}-${f((i + 1) * len)}`);
  }

  function parseTitel(titel) {
    const m = /\bvs\.?\s+(.+?)\s*(?:\(([^)]*)\))?\s*$/i.exec(str(titel));
    if (!m) return { tegenstander: '', thuisUit: 'thuis' };
    return { tegenstander: m[1].trim(), thuisUit: m[2] && /uit/i.test(m[2]) ? 'uit' : 'thuis' };
  }

  function buildTitel(teg, thuisUit, settings) {
    return `${teamName(settings)} vs ${teg || 'Onbekend'} (${thuisUit === 'uit' ? '✈️ Uit' : '🏠 Thuis'})`;
  }

  // ── Excel import ──────────────────────────────────────────────────────────
  function nameMap(squad) {
    const sq = squad && Array.isArray(squad.players) ? squad : (cfg().DEFAULT_SQUAD || { players: [] });
    const map = new Map();
    sq.players.forEach(p => {
      const name = typeof p === 'string' ? p : p && p.name;
      if (!name) return;
      map.set(String(name).trim().toLowerCase(), String(name).trim());
    });
    sq.players.forEach(p => {
      if (!p || typeof p !== 'object') return;
      (p.aliases || []).forEach(a => {
        const k = String(a).trim().toLowerCase();
        if (k && !map.has(k)) map.set(k, String(p.name).trim());
      });
    });
    return map;
  }

  function headerCodes(row) {
    const cols = [];
    (row || []).forEach((c, i) => {
      const s = str(c).toLowerCase();
      if (/^keeper/.test(s)) cols.push([i, 'K']);
      else if (/^verd/.test(s)) cols.push([i, 'V']);
      else if (/^mid/.test(s)) cols.push([i, 'M']);
      else if (/^spits|^aanval/.test(s)) cols.push([i, 'S']);
      else if (/^wissel/.test(s)) cols.push([i, 'W']);
    });
    return cols;
  }
  const DEFAULT_COLS = headerCodes(HDR);

  function isEmptyRow(r) { return !r || !r.length || r.every(c => str(c) === ''); }
  function isHeaderRow(r) {
    return !!r && /^tijd/i.test(str(r[0])) && r.some(c => /^keeper/i.test(str(c)));
  }
  const EMPTY_NAME = /^[-–—.]*$/;

  // rows: array van arrays (sheet_to_json header:1). Pure functie.
  function parseRows(rows, squad, opts) {
    opts = opts || {};
    const map = nameMap(squad);
    const warnings = [];
    const warn = w => { if (!warnings.includes(w)) warnings.push(w); };
    const matches = [];
    let baseId = opts.now || Date.now();
    let cur = null;
    let cols = null;
    rows = Array.isArray(rows) ? rows : [];

    const resolve = (raw, where) => {
      const s = str(raw);
      if (!s || EMPTY_NAME.test(s)) return null;
      const hit = map.get(s.toLowerCase());
      if (hit) return hit;
      warn(`Onbekende naam "${s}" (${where})`);
      return s;
    };

    const startBlock = titleRow => {
      finish();
      const titel = titleRow ? str(titleRow[0]) : '';
      let datum = '';
      let score = null;
      if (titleRow) {
        for (let c = 1; c < titleRow.length; c++) {
          const v = titleRow[c];
          const d = !datum ? parseDate(v) : '';
          if (d) { datum = d; continue; }
          const sm = /^(?:uitslag|score)?[:\s]*(\d{1,2})\s*[-–]\s*(\d{1,2})$/i.exec(str(v));
          if (sm && !score) score = { home: Number(sm[1]), away: Number(sm[2]) };
        }
        if (!datum) datum = parseDate(titel);
      }
      cur = { titel, datum, score, periodes: [] };
      cols = null;
    };

    function finish() {
      if (cur && cur.periodes.length) {
        const nr = matches.length + 1;
        const t = parseTitel(cur.titel);
        const titel = cur.titel || (t.tegenstander ? buildTitel(t.tegenstander, t.thuisUit, opts.settings) : `Wedstrijd ${nr}`);
        const aanwezig = [];
        cur.periodes.forEach(p => {
          Object.keys(p.posities).concat(p.wissels).forEach(n => { if (!aanwezig.includes(n)) aanwezig.push(n); });
        });
        matches.push({
          id: baseId++,
          titel,
          datum: cur.datum || '',
          tegenstander: t.tegenstander,
          thuisUit: t.thuisUit,
          score: cur.score,
          periodes: cur.periodes,
          v: 2,
          aanwezig,
          keepers: cur.periodes.map(p => namesFor(p, 'K')[0] || null),
        });
      } else if (cur && cur.titel) {
        warn(`Geen periodes gevonden bij "${cur.titel}"`);
      }
      cur = null;
      cols = null;
    }

    const nextNonEmpty = i => { for (let j = i + 1; j < rows.length; j++) if (!isEmptyRow(rows[j])) return rows[j]; return null; };

    for (let i = 0; i < rows.length; i++) {
      const r = Array.isArray(rows[i]) ? rows[i] : [];
      if (isEmptyRow(r)) { if (cur && cols && cur.periodes.length) finish(); continue; }
      if (isHeaderRow(r)) {
        if (!cur || cols) startBlock(null);
        cols = headerCodes(r);
        continue;
      }
      const first = str(r[0]);
      if (/^wedstrijd/i.test(first) || isHeaderRow(nextNonEmpty(i))) { startBlock(r); continue; }
      if (!cur) continue;
      if (!cols) {
        // titelrij zonder kopregel: v1-kolomvolgorde aannemen als de rij namen bevat
        const known = DEFAULT_COLS.some(([c]) => map.has(str(r[c]).toLowerCase()));
        if (!known) continue;
        cols = DEFAULT_COLS;
      }
      const where = `${cur.titel || 'wedstrijd ' + (matches.length + 1)}, periode ${cur.periodes.length + 1}`;
      const posities = {};
      const wissels = [];
      cols.forEach(([c, code]) => {
        const name = resolve(r[c], where);
        if (!name) return;
        if (name in posities || wissels.includes(name)) { warn(`${name} staat dubbel in ${where}`); return; }
        if (code === 'W') wissels.push(name); else posities[name] = code;
      });
      if (!Object.keys(posities).length && !wissels.length) continue;
      cur.periodes.push({ posities, wissels });
    }
    finish();
    return { matches, warnings };
  }

  function readFileAsArrayBuffer(file) {
    if (file && typeof file.arrayBuffer === 'function') return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const FR = envGet('FileReader');
      if (!FR) return reject(new Error('Bestand kan niet gelezen worden'));
      const reader = new FR();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = () => reject(reader.error || new Error('Bestand kan niet gelezen worden'));
      reader.readAsArrayBuffer(file);
    });
  }

  function importExcel(file, squad) {
    const XLSX = envGet('XLSX');
    if (!XLSX) return Promise.reject(new Error('Excel-bibliotheek is niet geladen (offline?)'));
    return readFileAsArrayBuffer(file).then(buf => {
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
      const names = wb.SheetNames || [];
      const sheetName = names.find(n => /^schema$/i.test(n)) || names.find(n => !/^seizoen$/i.test(n)) || names[0];
      if (!sheetName) return { matches: [], warnings: ['Geen werkblad gevonden'] };
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
      const res = parseRows(rows, squad);
      if (!res.matches.length) res.warnings.push('Geen wedstrijden gevonden in dit bestand');
      return res;
    });
  }

  // ── Excel export ──────────────────────────────────────────────────────────
  function sortByDate(list) {
    return list.slice().sort((a, b) => (a.datum || '').localeCompare(b.datum || '') || (Number(a.id) || 0) - (Number(b.id) || 0));
  }

  function buildSchemaRows(matches, opts) {
    const settings = (opts && opts.settings) || {};
    const list = sortByDate((matches || []).map(norm));
    const maxW = Math.max(2, ...list.map(m => Math.max(0, ...m.periodes.map(p => p.wissels.length))));
    const hdr = HDR.slice(0, 7);
    for (let i = 1; i <= maxW; i++) hdr.push(`Wissel ${i}`);
    const rows = [];
    list.forEach((m, mi) => {
      const titel = m.titel || buildTitel(m.tegenstander, m.thuisUit, settings);
      const head = [titel, isoToDMY(m.datum)];
      if (m.score) head.push(`Uitslag ${m.score.home}-${m.score.away}`);
      rows.push(head);
      rows.push(hdr.slice());
      const times = periodTimeLabels(m.periodes.length || 1, minutesOf(settings), 'excel');
      m.periodes.forEach((p, i) => {
        const k = namesFor(p, 'K'), v = namesFor(p, 'V'), md = namesFor(p, 'M'), s = namesFor(p, 'S');
        const row = [times[i] || '', k[0] || '', v[0] || '', v[1] || '', md[0] || '', s[0] || '', s[1] || ''];
        for (let w = 0; w < maxW; w++) row.push(p.wissels[w] || '');
        rows.push(row);
      });
      if (mi < list.length - 1) rows.push([]);
    });
    return rows;
  }

  function seasonTotals(matches) {
    const tot = {};
    const get = n => (tot[n] = tot[n] || { matches: 0, periods: 0, K: 0, V: 0, M: 0, S: 0, W: 0 });
    (matches || []).map(norm).forEach(m => {
      const seen = new Set();
      m.periodes.forEach(p => {
        Object.keys(p.posities).forEach(n => {
          const c = p.posities[n];
          const t = get(n);
          if (t[c] !== undefined) t[c]++;
          t.periods++;
          seen.add(n);
        });
        p.wissels.forEach(n => { const t = get(n); t.W++; t.periods++; seen.add(n); });
      });
      seen.forEach(n => { get(n).matches++; });
    });
    return tot;
  }

  function buildSeasonRows(matches) {
    const tot = seasonTotals(matches);
    const rows = [['Speler', 'Wedstrijden', 'Periodes', 'K', 'V', 'M', 'S', 'W', 'Veld %']];
    Object.keys(tot).sort((a, b) => a.localeCompare(b, 'nl')).forEach(n => {
      const t = tot[n];
      const field = t.K + t.V + t.M + t.S;
      rows.push([n, t.matches, t.periods, t.K, t.V, t.M, t.S, t.W, t.periods ? Math.round(field / t.periods * 100) : 0]);
    });
    return rows;
  }

  function exportFilename(matches) {
    const list = (matches || []).map(norm);
    const iso = list.length === 1 && list[0].datum ? list[0].datum : todayISO();
    return `JO10_Wisselschema_${isoToDMY(iso) || iso}.xlsx`;
  }

  function exportExcel(matches, opts) {
    const XLSX = envGet('XLSX');
    if (!XLSX) throw new Error('Excel-bibliotheek is niet geladen (offline?)');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(buildSchemaRows(matches, opts));
    ws['!cols'] = [30, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, 'Schema');
    const ws2 = XLSX.utils.aoa_to_sheet(buildSeasonRows(matches));
    ws2['!cols'] = [14, 12, 10, 6, 6, 6, 6, 6, 8].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws2, 'Seizoen');
    const filename = exportFilename(matches);
    const loc = envGet('location');
    if (loc && (loc.protocol === 'data:' || String(loc.href || '').startsWith('data:'))) {
      const b64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
      const open = envGet('open');
      if (typeof open === 'function') open('data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + b64, '_blank');
      return;
    }
    XLSX.writeFile(wb, filename);
  }

  // ── WhatsApp-tekst ────────────────────────────────────────────────────────
  function shortDay(iso) {
    const d = isoToDate(iso);
    return d ? `${WEEKDAYS[d.getDay()]} ${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}` : '';
  }
  function longDay(iso) {
    const d = isoToDate(iso);
    return d ? `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '';
  }

  function whatsappText(match, opts) {
    const settings = (opts && opts.settings) || {};
    const P = cfg().POSITIONS || {};
    const icon = c => (P[c] && P[c].icon) || c;
    const m = norm(match);
    const team = teamName(settings);
    const teg = m.tegenstander || parseTitel(m.titel).tegenstander;
    let head = teg ? `⚽ ${team} – ${teg} (${m.thuisUit === 'uit' ? '✈️ uit' : '🏠 thuis'})` : `⚽ ${m.titel || team}`;
    const day = shortDay(m.datum);
    if (day) head += ` ${day}`;
    const lines = [head];
    const times = periodTimeLabels(m.periodes.length || 1, minutesOf(settings));
    m.periodes.forEach((p, i) => {
      lines.push('');
      lines.push(`*Periode ${i + 1}* (${times[i]})`);
      ORDER.forEach(c => { const n = namesFor(p, c); if (n.length) lines.push(`${icon(c)} ${n.join(', ')}`); });
      if (p.wissels.length) lines.push(`${icon('W')} ${p.wissels.join(', ')}`);
    });
    if (m.score) {
      lines.push('');
      lines.push(`🏁 Uitslag: ${team} ${m.score.home}–${m.score.away} ${teg || 'tegenstander'}`);
      const scorers = {};
      (m.goals || []).forEach(g => { if (g.team === 'home' && g.by) scorers[g.by] = (scorers[g.by] || 0) + 1; });
      const s = Object.keys(scorers).map(n => (scorers[n] > 1 ? `${n} ${scorers[n]}x` : n));
      if (s.length) lines.push(`⚽ ${s.join(', ')}`);
    }
    return lines.join('\n');
  }

  // ── PNG export ────────────────────────────────────────────────────────────
  const PNG = {
    PAD: 14, GAP: 12, HEADER_H: 84, CELL_W: 200, CELL_HDR_H: 34, PITCH_H: 252,
    CHIP_H: 26, WISSEL_ROW_H: 30, WISSEL_LABEL_H: 16, FOOTER_H: 26, CELL_PAD: 8,
    // y-positie per linie als fractie van de veldhoogte (aanval boven, keeper onder)
    ROW_Y: { S: 0.27, M: 0.48, V: 0.70, K: 0.885 },
    COLORS: { K: '#d97706', V: '#2563eb', M: '#059669', S: '#dc2626', W: '#64748b' },
  };

  function spreadX(n) {
    if (n <= 1) return [0.5];
    if (n === 2) return [0.27, 0.73];
    return Array.from({ length: n }, (_, i) => 0.16 + i * (0.68 / (n - 1)));
  }

  // Pure layout: alle coördinaten in CSS-pixels (canvas wordt 2x geschaald).
  function pngLayout(match, opts) {
    opts = opts || {};
    const settings = opts.settings || {};
    const m = norm(match);
    const periodes = m.periodes.length ? m.periodes : [{ posities: {}, wissels: [] }];
    const n = periodes.length;
    const cols = opts.cols || (n <= 2 ? n : n <= 4 ? 2 : 3);
    const rowsN = Math.ceil(n / cols);
    const L = PNG;
    const width = L.PAD * 2 + cols * L.CELL_W + (cols - 1) * L.GAP;
    const times = periodTimeLabels(n, minutesOf(settings));
    const team = teamName(settings);
    const teg = m.tegenstander || parseTitel(m.titel).tegenstander;

    const header = {
      x: 0, y: 0, w: width, h: L.HEADER_H,
      title: teg ? `${team} vs ${teg}` : (m.titel || team),
      subtitle: [m.thuisUit === 'uit' ? '✈️ Uit' : '🏠 Thuis', longDay(m.datum)].filter(Boolean).join('  ·  '),
      score: m.score ? `${m.score.home} – ${m.score.away}` : null,
    };

    const cells = [];
    let y = L.HEADER_H + L.PAD;
    for (let r = 0; r < rowsN; r++) {
      const slice = periodes.slice(r * cols, r * cols + cols);
      const wisselRows = Math.max(0, ...slice.map(p => Math.ceil(p.wissels.length / 2)));
      const cellH = L.CELL_HDR_H + L.PITCH_H + (wisselRows ? L.CELL_PAD + L.WISSEL_LABEL_H + wisselRows * L.WISSEL_ROW_H : 0) + L.CELL_PAD;
      slice.forEach((p, ci) => {
        const i = r * cols + ci;
        const x = L.PAD + ci * (L.CELL_W + L.GAP);
        const pitch = { x: x + L.CELL_PAD, y: y + L.CELL_HDR_H, w: L.CELL_W - 2 * L.CELL_PAD, h: L.PITCH_H };
        const chips = [];
        ORDER.forEach(code => {
          const names = namesFor(p, code);
          const xs = spreadX(names.length);
          names.forEach((name, k) => {
            chips.push({
              name, code, color: L.COLORS[code],
              cx: pitch.x + xs[k] * pitch.w,
              cy: pitch.y + L.ROW_Y[code] * pitch.h,
              h: L.CHIP_H,
              maxW: names.length > 1 ? pitch.w / names.length - 8 : pitch.w * 0.7,
            });
          });
        });
        const wissels = p.wissels.map((name, k) => {
          const colW = pitch.w / 2;
          return {
            name, code: 'W', color: L.COLORS.W,
            cx: pitch.x + colW * (k % 2) + colW / 2,
            cy: pitch.y + pitch.h + L.CELL_PAD + L.WISSEL_LABEL_H + Math.floor(k / 2) * L.WISSEL_ROW_H + L.WISSEL_ROW_H / 2,
            h: L.CHIP_H - 4,
            maxW: colW - 8,
          };
        });
        const wisselLabel = wissels.length ? { text: 'WISSELS', x: pitch.x + pitch.w / 2, y: pitch.y + pitch.h + L.CELL_PAD + L.WISSEL_LABEL_H - 4 } : null;
        cells.push({ index: i, x, y, w: L.CELL_W, h: cellH, title: `Periode ${i + 1}`, time: times[i], pitch, chips, wissels, wisselLabel });
      });
      y += cellH + L.GAP;
    }
    const height = y - L.GAP + L.PAD + L.FOOTER_H;
    return { width, height, scale: 2, cols, rows: rowsN, header, cells, footer: { y: height - L.FOOTER_H / 2 - 4, text: cfg().APP_NAME || 'JO10 Opstelling' } };
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function drawPitch(ctx, p) {
    const { x, y, w, h } = p;
    ctx.save();
    roundRect(ctx, x, y, w, h, 10);
    ctx.clip();
    const stripes = 8;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 ? '#2f9e44' : '#37b24d';
      ctx.fillRect(x, y + (h / stripes) * i, w, h / stripes + 1);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    const ix = x + 6, iy = y + 6, iw = w - 12, ih = h - 12;
    ctx.strokeRect(ix, iy, iw, ih);
    ctx.beginPath(); ctx.moveTo(ix, y + h / 2); ctx.lineTo(ix + iw, y + h / 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, w * 0.15, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, 2, 0, Math.PI * 2); ctx.fill();
    const bw = iw * 0.56, bh = ih * 0.15, gw = iw * 0.28, gh = ih * 0.06;
    ctx.strokeRect(x + (w - bw) / 2, iy, bw, bh);
    ctx.strokeRect(x + (w - gw) / 2, iy, gw, gh);
    ctx.strokeRect(x + (w - bw) / 2, iy + ih - bh, bw, bh);
    ctx.strokeRect(x + (w - gw) / 2, iy + ih - gh, gw, gh);
    ctx.restore();
  }

  function drawChip(ctx, c) {
    ctx.font = `bold 13px ${FONT}`;
    const text = fitText(ctx, c.name, c.maxW - 16);
    const w = Math.min(c.maxW, Math.max(52, ctx.measureText(text).width + 18));
    const x = c.cx - w / 2, y = c.cy - c.h / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = c.color;
    roundRect(ctx, x, y, w, c.h, c.h / 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, x, y, w, c.h, c.h / 2);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, c.cx, c.cy + 0.5);
  }

  function drawLayout(ctx, L) {
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#eef2f6';
    ctx.fillRect(0, 0, L.width, L.height);

    // header
    const h = L.header;
    const grad = typeof ctx.createLinearGradient === 'function' ? ctx.createLinearGradient(0, 0, L.width, h.h) : null;
    if (grad) { grad.addColorStop(0, '#c1121f'); grad.addColorStop(1, '#8d0b16'); }
    ctx.fillStyle = grad || '#c1121f';
    ctx.fillRect(0, 0, L.width, h.h);
    const scoreW = h.score ? 78 : 0;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `bold 12px ${FONT}`;
    ctx.fillText('⚽  OPSTELLING', PNG.PAD, 24);
    ctx.font = `bold 21px ${FONT}`;
    ctx.fillText(fitText(ctx, h.title, L.width - 2 * PNG.PAD - scoreW), PNG.PAD, 50);
    ctx.font = `14px ${FONT}`;
    ctx.fillText(fitText(ctx, h.subtitle, L.width - 2 * PNG.PAD - scoreW), PNG.PAD, 72);
    if (h.score) {
      const bx = L.width - PNG.PAD - scoreW, by = 22;
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      roundRect(ctx, bx, by, scoreW, 44, 10);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.font = `bold 22px ${FONT}`;
      ctx.fillText(h.score, bx + scoreW / 2, by + 30);
    }

    // periodes
    L.cells.forEach(c => {
      ctx.save();
      ctx.shadowColor = 'rgba(15,23,42,0.12)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;
      ctx.fillStyle = '#ffffff';
      roundRect(ctx, c.x, c.y, c.w, c.h, 12);
      ctx.fill();
      ctx.restore();
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#0f172a';
      ctx.font = `bold 15px ${FONT}`;
      ctx.fillText(c.title, c.x + 10, c.y + 23);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#64748b';
      ctx.font = `12px ${FONT}`;
      ctx.fillText(c.time || '', c.x + c.w - 10, c.y + 23);
      drawPitch(ctx, c.pitch);
      c.chips.forEach(ch => drawChip(ctx, ch));
      if (c.wisselLabel) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#64748b';
        ctx.font = `bold 10px ${FONT}`;
        ctx.fillText('🪑 ' + c.wisselLabel.text, c.wisselLabel.x, c.wisselLabel.y);
      }
      c.wissels.forEach(ch => drawChip(ctx, ch));
    });

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#94a3b8';
    ctx.font = `11px ${FONT}`;
    ctx.fillText(L.footer.text, L.width / 2, L.footer.y);
  }

  function pngFilename(match) {
    const m = norm(match);
    const teg = (m.tegenstander || '').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '');
    const d = isoToDMY(m.datum);
    return ['JO10', teg || 'opstelling', d].filter(Boolean).join('_') + '.png';
  }

  function exportPNG(match, opts) {
    const doc = envGet('document');
    if (!doc) return Promise.reject(new Error('Geen document beschikbaar'));
    const L = pngLayout(match, opts);
    const canvas = doc.createElement('canvas');
    canvas.width = L.width * L.scale;
    canvas.height = L.height * L.scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(L.scale, L.scale);
    drawLayout(ctx, L);
    const filename = pngFilename(match);
    const title = L.header.title;

    return new Promise(resolve => {
      canvas.toBlob(blob => {
        const nav = envGet('navigator');
        const FileCtor = envGet('File');
        const URLApi = envGet('URL');
        const download = () => {
          const loc = envGet('location');
          if (!blob || (loc && (loc.protocol === 'data:' || String(loc.href || '').startsWith('data:')))) {
            const open = envGet('open');
            if (typeof open === 'function') open(canvas.toDataURL('image/png'), '_blank');
            return resolve();
          }
          const url = URLApi.createObjectURL(blob);
          const a = doc.createElement('a');
          a.download = filename;
          a.href = url;
          if (doc.body && doc.body.appendChild) doc.body.appendChild(a);
          a.click();
          if (a.remove) a.remove();
          const t = setTimeout(() => URLApi.revokeObjectURL(url), 1000);
          if (t && typeof t.unref === 'function') t.unref();
          resolve();
        };
        if (blob && FileCtor && nav && typeof nav.canShare === 'function') {
          let file = null;
          try { file = new FileCtor([blob], filename, { type: 'image/png' }); } catch (e) { file = null; }
          if (file && nav.canShare({ files: [file] })) {
            // iOS-deelblad (Bewaar in Foto's, WhatsApp…). Annuleren (AbortError) is geen fout; andere fouten
            // (bv. NotAllowedError zonder user-gesture) → terugvallen op downloaden.
            Promise.resolve().then(() => nav.share({ files: [file], title })).then(() => resolve(), e => {
              if (e && e.name === 'AbortError') resolve();
              else download();
            });
            return;
          }
        }
        download();
      }, 'image/png');
    });
  }

  const IO = JO10.IO = {
    exportPNG, exportExcel, importExcel, whatsappText,
    // pure helpers (tests / hergebruik)
    parseRows, buildSchemaRows, buildSeasonRows, seasonTotals, pngLayout, parseDate, exportFilename, pngFilename,
    HEADER: HDR,
    _drawLayout: drawLayout,
    _setEnv(e) { envOverride = Object.assign({}, envOverride, e || {}); },
    _resetEnv() { envOverride = {}; },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = IO;
})(typeof window !== 'undefined' ? window : globalThis);
