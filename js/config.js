// JO10 Opstelling — gedeelde constanten. Geen DOM, werkt in browser én Node.
(function (root) {
  const JO10 = root.JO10 = root.JO10 || {};

  JO10.Config = {
    APP_NAME: 'JO10 Opstelling',
    TEAM_NAME: 'JO10',

    // Standaard selectie (wordt gebruikt tot er een eigen selectie in de Store staat)
    DEFAULT_SQUAD: {
      players: [
        { name: 'Noud',     active: true, avoid: [], aliases: [] },
        { name: 'Bastiaan', active: true, avoid: ['S'], aliases: ['bas'] },
        { name: 'James',    active: true, avoid: [], aliases: ['jms'] },
        { name: 'Giulio',   active: true, avoid: [], aliases: [] },
        { name: 'Bram',     active: true, avoid: [], aliases: [] },
        { name: 'Coen',     active: true, avoid: [], aliases: [] },
        { name: 'Izzy',     active: true, avoid: [], aliases: [] },
        { name: 'Abel',     active: true, avoid: [], aliases: [] },
      ],
      settings: { periods: 4, minutes: 50 },
    },

    // Positiecodes. Volgorde = volgorde van achter naar voren.
    POSITIONS: {
      K: { code: 'K', label: 'Keeper',       short: 'K', icon: '🧤', color: '#f59e0b' },
      V: { code: 'V', label: 'Verdediger',   short: 'V', icon: '🛡️', color: '#3b82f6' },
      M: { code: 'M', label: 'Middenvelder', short: 'M', icon: '⚙️', color: '#10b981' },
      S: { code: 'S', label: 'Spits',        short: 'S', icon: '⚡', color: '#ef4444' },
      W: { code: 'W', label: 'Wissel',       short: 'W', icon: '🪑', color: '#94a3b8' },
    },
    FIELD_CODES: ['V', 'M', 'S'],

    // 6 tegen 6. Formatie kies je per wedstrijd; standaard 1-2-1-2 (keeper, 2 verdedigers, 1 middenvelder, 2 spitsen).
    FORMATION: { K: 1, V: 2, M: 1, S: 2 },
    FORMATIONS: [
      { id: '2-1-2', label: 'K · 2-1-2', formation: { K: 1, V: 2, M: 1, S: 2 } },
      { id: '2-2-1', label: 'K · 2-2-1', formation: { K: 1, V: 2, M: 2, S: 1 } },
    ],
    DEFAULT_FORMATION: '2-1-2',
    // id ('V-M-S', bv. '2-2-1') → { K, V, M, S }. Bekende ids uit FORMATIONS, andere 'V-M-S' worden ontleed;
    // onbekend/leeg → standaard.
    formationById(id) {
      const hit = this.FORMATIONS.find(x => x.id === id);
      if (hit) return Object.assign({}, hit.formation);
      const m = /^\s*(\d{1,2})-(\d{1,2})-(\d{1,2})\s*$/.exec(String(id == null ? '' : id));
      if (m && +m[1] + +m[2] + +m[3] > 0) return { K: 1, V: +m[1], M: +m[2], S: +m[3] };
      return Object.assign({}, this.FORMATIONS.find(x => x.id === this.DEFAULT_FORMATION).formation);
    },
    // { K, V, M, S } → id ('V-M-S')
    formationId(f) {
      if (!f || typeof f !== 'object') return this.DEFAULT_FORMATION;
      return `${f.V | 0}-${f.M | 0}-${f.S | 0}`;
    },
    // Formatie waarmee een (opgeslagen) wedstrijd gespeeld is: match.formatie ('2-2-1') → match.format.formation →
    // afgeleid uit de opstelling (grootste aantal per linie). Oude records zonder veld die binnen 1-2-1-2 passen
    // (ook bij 4–5 spelers) → standaard 1-2-1-2.
    matchFormation(m) {
      if (m && typeof m.formatie === 'string' && m.formatie.trim()) return this.formationById(m.formatie.trim());
      const ff = m && m.format && typeof m.format === 'object' ? m.format.formation : null;
      if (ff && typeof ff === 'object') {
        const f = { K: 1, V: Math.max(0, ff.V | 0), M: Math.max(0, ff.M | 0), S: Math.max(0, ff.S | 0) };
        if (f.V + f.M + f.S > 0) return f;
      }
      const def = this.formationById(this.DEFAULT_FORMATION);
      const cnt = { K: 1, V: 0, M: 0, S: 0 };
      const per = m && m.periodes;
      (Array.isArray(per) ? per : per && typeof per === 'object' ? Object.values(per) : []).forEach(p => {
        const c = { V: 0, M: 0, S: 0 };
        Object.values((p && p.posities) || {}).forEach(code => { if (code in c) c[code]++; });
        ['V', 'M', 'S'].forEach(k => { cnt[k] = Math.max(cnt[k], c[k]); });
      });
      return ['V', 'M', 'S'].every(k => cnt[k] <= def[k]) ? def : cnt;
    },
    // Formatie bij n aanwezige spelers, uitgaande van de basisformatie (standaard 1-2-1-2).
    // Te weinig spelers: haal één voor één een speler weg uit de grootste linie (aanval eerst bij gelijkstand,
    // dan middenveld, dan verdediging). Keeper blijft altijd. 2-1-2 bij 5 → 2-1-1, bij 4 → 1-1-1.
    formationFor(n, base) {
      const f = Object.assign({ K: 1, V: 2, M: 1, S: 2 }, base || {});
      const total = () => f.K + f.V + f.M + f.S;
      while (total() > Math.max(1, n)) {
        const order = ['S', 'M', 'V'].filter(c => f[c] > 0).sort((a, b) => f[b] - f[a]);
        if (!order.length) break;
        f[order[0]]--;
      }
      return f;
    },
    MIN_PLAYERS: 4,

    // Tijdsindeling per periode, bv. ['0–12.5', '12.5–25', ...]
    periodTimes(periods, minutes) {
      const len = minutes / periods;
      const f = x => String(Math.round(x * 10) / 10).replace('.', ',');
      return Array.from({ length: periods }, (_, i) => `${f(i * len)}–${f((i + 1) * len)} min`);
    },

    FIREBASE: {
      apiKey: 'AIzaSyA4TvAEc7lfSgEHy7i4YexkyHfSrBkoBeY',
      authDomain: 'opstellingjo10.firebaseapp.com',
      databaseURL: 'https://opstellingjo10-default-rtdb.europe-west1.firebasedatabase.app',
      projectId: 'opstellingjo10',
      storageBucket: 'opstellingjo10.firebasestorage.app',
      messagingSenderId: '774358533306',
      appId: '1:774358533306:web:2d5c5c82e1257ea9edae83',
    },
    // Firebase-paden. jo10_matches is gedeeld met v1.html en MOET een array blijven.
    FB_MATCHES: 'jo10_matches',
    FB_SQUAD: 'jo10_squad',

    // localStorage-sleutels. jo10_matches_v1 is gedeeld met v1.html.
    LS_MATCHES: 'jo10_matches_v1',
    LS_SQUAD: 'jo10_squad_v2',
    LS_DRAFT: 'jo10_draft_v2',
    LS_THEME: 'jo10_theme',
    LS_LIVE: 'jo10_live_v2',
    LS_CALENDAR: 'jo10_calendar_v2',
    LS_FORMATION: 'jo10_formatie_v2',             // laatst gekozen formatie (standaard voor een nieuwe wedstrijd)

    // Speelkalender: officiële iCal van de clubsite. Een GitHub Action zet die dagelijks in CALENDAR_FILE
    // (zelfde site als de app → geen CORS). CALENDAR_URL is de bron (en reserve voor direct ophalen).
    CALENDAR_FILE: 'data/kalender.ics',            // wedstrijden + trainingen van team O10-3 (clubsite)
    CALENDAR_URL: 'https://sporting70.voetbalassist.nl/Modules/UitslagenEnStanden/Front/ICal.ashx?id=149',
    CALENDAR_TEAM: "Sporting '70 O10-3",

    // Trainingsstof van de club (JO10–JO12). Alleen de woensdagtraining volgt de reeks:
    // eerste woensdag van het seizoen = week 1; woensdagen in schoolvakanties (regio Midden) tellen niet mee.
    TRAINING: {
      weekday: 3,                 // woensdag
      seasonStart: '2026-09-02',  // eerste woensdag na de zomervakantie (regio Midden: t/m 30 aug 2026)
      materialUrl: 'https://sporting70.voetbalassist.nl/569/trainingen/',
      materialFile: 'data/trainingen.json',   // optioneel: { "weken": { "1": { "titel", "thema", "link" } } }
      holidays: [                 // schoolvakanties 2026-2027 regio Midden (rijksoverheid.nl)
        { naam: 'Herfstvakantie',    van: '2026-10-17', tot: '2026-10-25' },
        { naam: 'Kerstvakantie',     van: '2026-12-19', tot: '2027-01-03' },
        { naam: 'Voorjaarsvakantie', van: '2027-02-20', tot: '2027-02-28' },
        { naam: 'Meivakantie',       van: '2027-04-24', tot: '2027-05-02' },
        { naam: 'Zomervakantie',     van: '2027-07-17', tot: '2027-08-29' },
      ],
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = JO10.Config;
})(typeof window !== 'undefined' ? window : globalThis);
