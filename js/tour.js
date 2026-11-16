// JO10 Opstelling — rondleiding door de app (JO10.Tour).
// Schermvullende, veegbare kaartjes (scroll-snap) met kleine illustraties in de stijl van de app zelf
// (mini-veld met gekleurde chips, mini-wisselbord, mini-klok). Klassiek script, geen DOM nodig om te laden:
// de beslislogica (decide/readLocal) is puur en wordt in Node getest (test/tour.test.js).
(function (root) {
  'use strict';
  const JO10 = root.JO10 = root.JO10 || {};

  const KEY_FALLBACK = 'jo10_rondleiding_v1';
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"'`]/g, c => ESC[c]);
  const cfg = () => JO10.Config || {};
  const tourKey = () => cfg().LS_TOUR || KEY_FALLBACK;

  // ═══════════════════════════════════════════════════════════════════
  // Wanneer tonen? (puur)
  // ═══════════════════════════════════════════════════════════════════
  // 'tour' = automatisch openen (nieuw toestel), 'hint' = kaartje "Nieuw: rondleiding" op Start (bestaande gebruiker),
  // 'none' = niets. Nooit automatisch over een lopende live-wedstrijd heen.
  function decide(st) {
    st = st || {};
    if (st.seen) return 'none';
    if (st.hasMatches || st.hasMe || st.usedBefore) return 'hint';
    if (st.liveRunning) return 'none';
    return 'tour';
  }

  function sGet(storage, k) { try { return storage ? storage.getItem(k) : null; } catch (e) { return null; } }
  function sSet(storage, k, v) { try { if (storage) storage.setItem(k, v); } catch (e) { /* privémodus / vol */ } }
  function defaultStorage() { try { return root.localStorage || null; } catch (e) { return null; } }

  // Wat weet dit toestel al? Lezen vóór Store.init, zodat wedstrijden die net van de server binnenkomen
  // (tweede trainer op een nieuw toestel) niet als "bestaande gebruiker" tellen.
  function readLocal(storage, c) {
    c = c || cfg();
    storage = storage === undefined ? defaultStorage() : storage;
    const k = (name, fb) => c[name] || fb;
    let hasMatches = false;
    try {
      const raw = JSON.parse(sGet(storage, k('LS_MATCHES', 'jo10_matches_v1')) || 'null');
      hasMatches = Array.isArray(raw) ? raw.some(Boolean) : !!(raw && typeof raw === 'object' && Object.keys(raw).length);
    } catch (e) { hasMatches = false; }
    const me = sGet(storage, k('LS_ME', 'jo10_me_v2'));
    return {
      seen: !!sGet(storage, k('LS_TOUR', KEY_FALLBACK)),
      hasMatches,
      hasMe: !!(me && String(me).trim()),
      // v2 al eens geopend (laatste scherm / concept bewaard)
      usedBefore: !!(sGet(storage, 'jo10_ui_v2') || sGet(storage, k('LS_DRAFT', 'jo10_draft_v2'))),
    };
  }
  function isSeen(storage) { return !!sGet(storage === undefined ? defaultStorage() : storage, tourKey()); }
  function markSeen(storage) { sSet(storage === undefined ? defaultStorage() : storage, tourKey(), String(Date.now())); }

  // ═══════════════════════════════════════════════════════════════════
  // Inhoud (7 kaarten)
  // ═══════════════════════════════════════════════════════════════════
  const FALLBACK_NAMES = ['Noud', 'Bram', 'Izzy', 'Coen', 'James', 'Abel', 'Giulio', 'Bastiaan'];
  function nameList(players) {
    const out = [];
    (Array.isArray(players) ? players : []).forEach(p => {
      const n = String(p == null ? '' : p).trim();
      if (n && !out.includes(n)) out.push(n);
    });
    FALLBACK_NAMES.forEach(n => { if (out.length < 8 && !out.includes(n)) out.push(n); });
    return out.slice(0, 8);
  }
  const chip = (code, name, extra) => `<span class="pc pc--${code}${extra ? ' ' + extra : ''}"><span class="pc__name">${esc(name)}</span>${/is-locked/.test(extra || '') ? '<span class="pc__lock">🔒</span>' : ''}</span>`;

  function artWelkom() {
    return `<div class="ta ta--hero">
      <span class="ta-logo">⚽</span>
      <span class="ta-float ta-float--a">⚖️ Eerlijk</span>
      <span class="ta-float ta-float--b">⏱️ Live</span>
      <span class="ta-float ta-float--c">🤝 Samen</span>
      <span class="ta-dots"><i class="ta-dot--K"></i><i class="ta-dot--V"></i><i class="ta-dot--M"></i><i class="ta-dot--S"></i></span>
    </div>`;
  }
  function artStart(o) {
    const nx = o.next || {};
    return `<div class="ta ta--soft"><div class="tm-card tm-next">
      <div class="tm-top"><span class="tm-kicker">📋 Volgende wedstrijd</span><span class="tm-chip">${esc(nx.chip || 'Zaterdag')}</span></div>
      <div class="tm-opp">${esc(nx.tegenstander || 'FC Stein')}</div>
      <div class="tm-when">${esc(nx.when || 'zaterdag · 09:45')}</div>
      <div class="tm-facts"><span>${nx.thuisUit === 'uit' ? '✈️ Uit' : '🏠 Thuis'}</span><span>📅 Clubkalender</span></div>
      <div class="tm-btn">⚡ Maak opstelling<span class="tm-tap" aria-hidden="true"></span></div>
    </div></div>`;
  }
  function artMaken(o) {
    const n = o.names;
    const att = n.slice(0, 6).map((x, i) => `<span class="tm-att${i === 4 ? '' : ' is-on'}"><b>${i === 4 ? '' : '✓'}</b>${esc(x)}</span>`).join('');
    return `<div class="ta ta--soft"><div class="tm-card tm-make">
      <div class="tm-label"><span class="tm-step">1</span> Wie zijn er?</div>
      <div class="tm-atts">${att}</div>
      <div class="tm-line"><span class="tm-label"><span class="tm-step">2</span> Keepers</span><span class="tm-keeper">🧤 ${esc(n[2])} · ${esc(n[3])}</span></div>
      <div class="tm-line"><span class="tm-label"><span class="tm-step">3</span> Formatie</span><span class="tm-seg"><span class="is-on">2-1-2</span><span>2-2-1</span></span></div>
      <div class="tm-btn tm-btn--sm">⚡ Maak wisselschema</div>
    </div></div>`;
  }
  function artAanpassen(o) {
    const n = o.names;
    return `<div class="ta ta--soft ta--split">
      <div class="tm-period">
        <div class="tm-period__head"><b>Periode 1</b><small>0–12,5</small></div>
        <div class="tm-pitch"><span class="tm-lines" aria-hidden="true"><i></i></span>
          <div class="tm-row">${chip('S', n[0], 'is-sel')}${chip('S', n[1])}</div>
          <div class="tm-row">${chip('M', n[2], 'is-target')}</div>
          <div class="tm-row">${chip('V', n[3])}${chip('V', n[4], 'is-locked')}</div>
          <div class="tm-row">${chip('K', n[5])}</div>
        </div>
        <div class="tm-bench"><span>Wissel</span>${chip('W', n[6])}${chip('W', n[7])}</div>
      </div>
      <div class="tm-side">
        <div class="tm-swap"><b>Tik, tik</b><span>${esc(n[0])} ⇄ ${esc(n[2])}</span></div>
        <div class="tm-tool">🔒 Vastzetten</div>
        <div class="tm-tool">🔀 Ander schema</div>
        <div class="tm-tool">↩️ Ongedaan</div>
        <div class="tm-fair"><span>Eerlijkheid</span><b>96<small>/100</small></b><i><s></s></i></div>
      </div>
    </div>`;
  }
  function artBord(o) {
    const n = o.names;
    const row = (off, on, code, label) => `<li class="sb-row">
      <span class="sb-off"><span class="sb-arrow sb-arrow--off">▼</span>${esc(off)}</span><span class="sb-swap">⇄</span>
      <span class="sb-on"><span class="sb-arrow sb-arrow--on">▲</span>${esc(on)}</span>
      <span class="sb-pos" style="--pc:var(--pos-${code})">${label}</span></li>`;
    return `<div class="ta ta--board"><div class="sboard tm-board">
      <div class="sboard__head"><span class="sboard__label">WISSEL</span><span class="sboard__when">P1 → P2 · na 12,5 min</span></div>
      <ul class="sboard__rows">${row(n[0], n[6], 'S', 'Spits')}${row(n[3], n[7], 'V', 'Verdediger')}</ul>
    </div></div>`;
  }
  function artLive(o) {
    const n = o.names; const opp = (o.next && o.next.tegenstander) || 'FC Stein';
    return `<div class="ta ta--soft"><div class="tm-card tm-live">
      <div class="tm-live__top"><span class="tm-badge"><i></i>LIVE</span><span>Periode 2 van 4</span></div>
      <div class="tm-clock">08:41</div>
      <div class="tm-due">🔁 Volgende wissel <b>over 3:49</b></div>
      <div class="tm-score"><span class="tm-team">${esc(o.team || 'JO10')}</span><b>2 – 1</b><span class="tm-team">${esc(opp)}</span></div>
      <div class="tm-scorers"><span>⚽ ${esc(n[0])}</span><span>⚽ ${esc(n[2])}</span></div>
    </div></div>`;
  }
  function artSamen(o) {
    const me = String(o.name || '').trim();
    const ini = s => esc((s || '?').slice(0, 1).toUpperCase());
    const bars = o.names.slice(0, 4).map((x, i) => `<li><span>${esc(x)}</span><i><s style="width:${[78, 75, 75, 72][i]}%"></s></i></li>`).join('');
    return `<div class="ta ta--soft ta--split ta--samen">
      <div class="tm-col">
        <div class="tm-duo"><span class="tm-av">${me ? ini(me) : '🧑‍🏫'}</span><span class="tm-link">📲</span><span class="tm-av tm-av--2">＋</span></div>
        <div class="tm-share"><span>💬 WhatsApp</span><span>🖼️ PNG</span></div>
      </div>
      <div class="tm-card tm-season"><div class="tm-label">📊 Speeltijd</div><ul>${bars}</ul></div>
    </div>`;
  }

  // Kaarten. title/text/bullets: text/bullets mogen <b> bevatten; alle dynamische waarden gaan door esc().
  function slides(o) {
    o = o || {};
    const name = String(o.name || '').trim();
    const a = { name, names: nameList(o.players), next: o.next || null, team: o.team || 'JO10' };
    return [
      { id: 'welkom', kicker: name ? `Hoi ${esc(name)} 👋` : 'Welkom 👋', title: `${esc(o.appName || 'JO10 Opstelling')}`,
        text: '<b>Eerlijk wisselen zonder gedoe.</b> In een minuutje zie je hoe het werkt.',
        bullets: ['⚖️ Iedereen evenveel speeltijd', '⏱️ Live klok en wissels langs de lijn', '🤝 Samen met de andere trainer'], art: artWelkom(a) },
      { id: 'start', kicker: '🏠 Start', title: 'Je volgende wedstrijd staat klaar',
        text: 'De wedstrijden komen vanzelf uit de clubkalender. Eén tik op <b>⚡ Maak opstelling</b> en datum, tegenstander en thuis/uit zijn ingevuld.',
        bullets: ['📅 Ook het programma en de volgende training', '📝 Halverwege gestopt? Je concept wacht op je'], art: artStart(a) },
      { id: 'maken', kicker: '⚽ Wedstrijd', title: 'Opstelling in drie tikken',
        text: 'Vink aan wie er zijn, kies keepers en formatie en tik op <b>Maak wisselschema</b>.',
        bullets: ['🧤 Keepervoorstel: wie het minst keepte', '📐 Formatie 2-1-2 of 2-2-1', '⚖️ Iedereen evenveel speeltijd, <b>nooit twee keer achter elkaar wissel</b>'], art: artMaken(a) },
      { id: 'aanpassen', kicker: '✏️ Aanpassen', title: 'Jij hebt het laatste woord',
        text: 'Tik twee spelers in dezelfde periode aan om ze te ruilen. De eerlijkheidsscore laat zien of het eerlijk blijft.',
        bullets: ['🔒 Tik nog eens op een speler om hem vast te zetten', '🔀 Ander schema: vastgezette spelers blijven staan', '↩️ Ongedaan maken kan altijd'], art: artAanpassen(a) },
      { id: 'bord', kicker: '🔁 Wisselborden', title: 'Wie eruit, wie erin?',
        text: 'Tussen de periodes staat een wisselbord klaar. Zo zie je in één oogopslag wat er moet gebeuren.',
        bullets: ['<span class="tour-off">▼</span> eruit · <span class="tour-on">▲</span> erin, met de positie erbij', 'Tik in het schema op <b>🔁 Wisselbord</b>'], art: artBord(a) },
      { id: 'live', kicker: '⏱️ Live', title: 'Coachen langs de lijn',
        text: 'De klok loopt door, ook als je telefoon op slot gaat.',
        bullets: ['🔔 Seintje vlak voor de wissel, met wie eruit en erin', '⚽ Score en doelpuntenmakers met één tik', '⏸️ Pauzeren en verder waar je was'], art: artLive(a) },
      { id: 'samen', kicker: '🤝 Samen & delen', title: 'Samen coachen, makkelijk delen',
        text: 'Nodig de tweede trainer uit: jullie zien en bewerken dezelfde opstellingen.',
        bullets: ['📲 Uitnodigen via <b>👥 Team → Trainers</b>', '💬 Opstelling delen via WhatsApp of als plaatje', '📊 <b>Seizoen</b>: speeltijd per speler en alle uitslagen'], art: artSamen(a) },
    ];
  }

  // ═══════════════════════════════════════════════════════════════════
  // Weergave
  // ═══════════════════════════════════════════════════════════════════
  let T = null; // { el, track, idx, n, opts, prevFocus, inerted, pending, pendingUntil, raf }

  const reduced = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function html(list, o) {
    const n = list.length;
    const slidesHTML = list.map((s, i) => `<section class="tour__slide${i === 0 ? ' is-active' : ''}" id="tour-s${i}" data-i="${i}" role="group" aria-roledescription="kaart" aria-label="${i + 1} van ${n}">
        <div class="tour__art" aria-hidden="true">${s.art}</div>
        <div class="tour__body">
          <p class="tour__kicker">${s.kicker}</p>
          <h2 class="tour__title" id="tour-t${i}">${s.title}</h2>
          <p class="tour__text" id="tour-d${i}">${s.text}</p>
          ${s.bullets && s.bullets.length ? `<ul class="tour__list">${s.bullets.map(b => `<li>${b}</li>`).join('')}</ul>` : ''}
          ${i === n - 1 && o.onInvite ? '<button type="button" class="btn btn--secondary btn--block tour__invite" data-tour="invite">📲 Tweede trainer uitnodigen</button>' : ''}
        </div>
      </section>`).join('');
    return `<div class="tour__panel" role="dialog" aria-modal="true" aria-labelledby="tour-t0" aria-describedby="tour-d0" tabindex="-1">
      <div class="tour__top">
        <span class="tour__count" aria-hidden="true"><b>1</b>/${n}</span>
        <span class="tour__name">Rondleiding</span>
        <button type="button" class="tour__skip" data-tour="skip">Overslaan</button>
      </div>
      <div class="tour__track">${slidesHTML}</div>
      <div class="tour__nav">
        <button type="button" class="btn btn--ghost tour__prev" data-tour="prev" aria-label="Vorige kaart">‹ Terug</button>
        <div class="tour__dots" aria-hidden="true">${list.map((_, i) => `<span class="tour__dot${i === 0 ? ' is-on' : ''}" data-tour="dot" data-i="${i}"></span>`).join('')}</div>
        <button type="button" class="btn btn--primary tour__next" data-tour="next">Volgende ›</button>
      </div>
      <p class="sr-only" aria-live="polite" data-tour-live></p>
    </div>`;
  }

  function setIndex(i, announce) {
    if (!T) return;
    i = Math.max(0, Math.min(T.n - 1, i));
    const changedIdx = i !== T.idx;
    T.idx = i;
    const el = T.el;
    el.querySelectorAll('.tour__slide').forEach((s, j) => {
      const on = j === i;
      s.classList.toggle('is-active', on);
      if (on) { s.removeAttribute('aria-hidden'); s.inert = false; s.removeAttribute('inert'); }
      else { s.setAttribute('aria-hidden', 'true'); s.inert = true; s.setAttribute('inert', ''); }
    });
    el.querySelectorAll('.tour__dot').forEach((d, j) => d.classList.toggle('is-on', j === i));
    const cnt = el.querySelector('.tour__count b'); if (cnt) cnt.textContent = String(i + 1);
    const panel = el.querySelector('.tour__panel');
    panel.setAttribute('aria-labelledby', `tour-t${i}`);
    panel.setAttribute('aria-describedby', `tour-d${i}`);
    const prev = el.querySelector('.tour__prev');
    const next = el.querySelector('.tour__next');
    const last = i === T.n - 1;
    prev.classList.toggle('is-hidden', i === 0);
    prev.setAttribute('aria-hidden', i === 0 ? 'true' : 'false');
    prev.tabIndex = i === 0 ? -1 : 0;
    next.textContent = last ? 'Aan de slag' : 'Volgende ›';
    next.classList.toggle('is-last', last);
    next.setAttribute('aria-label', last ? 'Aan de slag, rondleiding sluiten' : 'Volgende kaart');
    if (changedIdx && announce) {
      const t = el.querySelector(`#tour-t${i}`);
      const live = el.querySelector('[data-tour-live]');
      if (live && t) live.textContent = `Kaart ${i + 1} van ${T.n}: ${t.textContent}`;
    }
    // Focus nooit op een knop laten staan die net verdween
    if (i === 0 && doc().activeElement === prev) next.focus({ preventScroll: true });
  }

  function goTo(i) {
    if (!T) return;
    i = Math.max(0, Math.min(T.n - 1, i));
    const w = T.track.clientWidth || 1;
    T.pending = i; T.pendingUntil = Date.now() + 800;
    setIndex(i, true);
    try { T.track.scrollTo({ left: i * w, behavior: reduced() ? 'auto' : 'smooth' }); }
    catch (e) { T.track.scrollLeft = i * w; }
  }

  function onScroll() {
    if (!T || T.raf) return;
    T.raf = root.requestAnimationFrame(() => {
      if (!T) return;
      T.raf = 0;
      const w = T.track.clientWidth || 1;
      const i = Math.round(T.track.scrollLeft / w);
      if (T.pending != null) {
        if (i === T.pending || Date.now() > T.pendingUntil) T.pending = null;
        else return;
      }
      if (i !== T.idx) setIndex(i, true);
    });
  }
  function onResize() {
    if (!T) return;
    const w = T.track.clientWidth || 1;
    T.track.scrollLeft = T.idx * w;
  }

  function focusables() {
    if (!T) return [];
    return Array.from(T.el.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])'))
      .filter(x => !x.disabled && x.tabIndex !== -1 && !x.closest('[inert]') && x.getClientRects().length);
  }
  function onKey(e) {
    if (!T) return;
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close('skip'); return; }
    if (k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); e.stopPropagation(); goTo(T.idx + 1); return; }
    if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); e.stopPropagation(); goTo(T.idx - 1); return; }
    if (k === 'Home') { e.preventDefault(); e.stopPropagation(); goTo(0); return; }
    if (k === 'End') { e.preventDefault(); e.stopPropagation(); goTo(T.n - 1); return; }
    if (k === 'Tab') {
      e.stopPropagation();
      const f = focusables(); if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1], a = doc().activeElement;
      if (e.shiftKey && (a === first || !T.el.contains(a) || a === T.el.querySelector('.tour__panel'))) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && (a === last || !T.el.contains(a))) { first.focus(); e.preventDefault(); }
    }
  }
  function onClick(e) {
    const t = e.target.closest('[data-tour]'); if (!t || !T) return;
    e.preventDefault();
    const act = t.dataset.tour;
    if (act === 'skip') close('skip');
    else if (act === 'prev') goTo(T.idx - 1);
    else if (act === 'next') { if (T.idx >= T.n - 1) close('done'); else goTo(T.idx + 1); }
    else if (act === 'dot') goTo(+t.dataset.i || 0);
    else if (act === 'invite') close('invite');
  }
  // Focus die buiten de rondleiding belandt (bv. VoiceOver) terughalen
  function onFocusIn(e) {
    if (!T || T.el.contains(e.target)) return;
    const p = T.el.querySelector('.tour__panel'); if (p) p.focus({ preventScroll: true });
  }

  const doc = () => root.document;

  function open(opts) {
    const d = doc(); if (!d || !d.body) return false;
    if (T) close('replace', true);
    opts = opts || {};
    const list = slides(opts);
    const el = d.createElement('div');
    el.className = 'tour';
    el.innerHTML = html(list, opts);
    // Rest van de pagina onbereikbaar maken (schermlezer + toetsenbord)
    const inerted = [];
    Array.from(d.body.children).forEach(c => {
      if (c.tagName === 'SCRIPT' || c.inert || c.hasAttribute('inert')) return;
      c.inert = true; c.setAttribute('inert', ''); inerted.push(c);
    });
    d.body.appendChild(el);
    d.body.classList.add('has-tour');
    T = { el, track: el.querySelector('.tour__track'), idx: 0, n: list.length, opts, prevFocus: d.activeElement, inerted, pending: null, pendingUntil: 0, raf: 0 };
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    T.track.addEventListener('scroll', onScroll, { passive: true });
    root.addEventListener('resize', onResize);
    d.addEventListener('focusin', onFocusIn);
    setIndex(Math.max(0, Math.min(list.length - 1, opts.start | 0)), false);
    if (T.idx) T.track.scrollLeft = T.idx * (T.track.clientWidth || 1);
    root.requestAnimationFrame(() => {
      if (!T || T.el !== el) return;
      el.classList.add('is-open');
      const p = el.querySelector('.tour__panel');
      try { p.focus({ preventScroll: true }); } catch (e) { p.focus(); }
    });
    return true;
  }

  function close(reason, silent) {
    if (!T) return;
    const st = T; T = null;
    const d = doc();
    st.el.removeEventListener('keydown', onKey);
    st.el.removeEventListener('click', onClick);
    st.track.removeEventListener('scroll', onScroll);
    root.removeEventListener('resize', onResize);
    d.removeEventListener('focusin', onFocusIn);
    if (st.raf) root.cancelAnimationFrame(st.raf);
    st.inerted.forEach(c => { c.inert = false; c.removeAttribute('inert'); });
    d.body.classList.remove('has-tour');
    const finish = () => { if (st.el.parentNode) st.el.parentNode.removeChild(st.el); };
    if (reduced() || silent) finish();
    else { st.el.classList.remove('is-open'); st.el.classList.add('is-closing'); setTimeout(finish, 200); }
    const pf = st.prevFocus;
    if (pf && pf.isConnected && pf.focus && pf !== d.body) { try { pf.focus({ preventScroll: true }); } catch (e) { /* */ } }
    if (silent) return;
    const o = st.opts || {};
    try { if (typeof o.onClose === 'function') o.onClose(reason || 'skip'); } catch (e) { console.warn('[JO10] Tour.onClose', e); }
    if (reason === 'invite' && typeof o.onInvite === 'function') {
      try { o.onInvite(); } catch (e) { console.warn('[JO10] Tour.onInvite', e); }
    }
  }

  JO10.Tour = {
    decide, readLocal, isSeen, markSeen, slides,
    open, close,
    isOpen: () => !!T,
    get index() { return T ? T.idx : -1; },
    goTo,
    _esc: esc,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = JO10.Tour;
})(typeof window !== 'undefined' ? window : globalThis);
