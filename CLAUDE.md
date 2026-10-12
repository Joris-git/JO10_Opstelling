# JO10 Opstelling — architectuur & contract

Webapp (statische site, geen build-stap) waarmee de trainer van een JO10-team per wedstrijd een eerlijk
wisselschema maakt, live de wedstrijd begeleidt en het seizoen bijhoudt. Taal van de UI: **Nederlands**.
Primair gebruik: **telefoon langs de lijn** (iPhone Safari), soms desktop.

- `index.html` — app (v2). Laadt klassieke `<script>`-bestanden (geen ES-modules, zodat ook `file://` werkt).
- `v1.html` — de oude app, ongewijzigd bewaard als terugvaloptie. Niet aanpassen.
- Geen frameworks. Externe libs alleen via CDN met vaste versie: SheetJS `xlsx@0.18.5` (cdnjs),
  Firebase compat `10.12.2` (jsdelivr). De app moet blijven werken als Firebase/CDN niet laadt (offline).

## Bestanden en eigenaarschap

| Bestand | Inhoud | Globale naam |
|---|---|---|
| `js/config.js` | Constanten (posities, formatie, Firebase-config, localStorage-sleutels) | `JO10.Config` |
| `js/scheduler.js` | Pure logica: schema genereren, evalueren, keepers voorstellen, statistiek. Geen DOM. | `JO10.Scheduler` |
| `js/store.js` | Opslag: localStorage-cache + Firebase realtime sync, selectie, concept | `JO10.Store` |
| `js/io.js` | PNG-export, Excel import/export, WhatsApp-tekst | `JO10.IO` |
| `js/live.js` + `css/live.css` | Live-wedstrijdmodus (klok, wissels, score) | `JO10.Live` |
| `js/fixtures.js` | Speelkalender: iCal (.ics) ontleden, thuis/uit bepalen, koppelen aan wedstrijden | `JO10.Fixtures` |
| `data/kalender.ics` | Officiële iCal van de clubsite, wekelijks (vrijdag 20:00) bijgewerkt door `.github/workflows/kalender.yml` | |
| `js/app.js` + `css/app.css` | UI-shell, schermen, state, rendering | `JO10.App` |
| `test/*.test.js` | `node --test test/*.test.js` — unit tests voor scheduler/store/io-logica | |

Elk JS-bestand is een IIFE: `(function(root){ const JO10 = root.JO10 = root.JO10 || {}; ... })(typeof window!=='undefined'?window:globalThis);`
en exporteert via `module.exports` als `module` bestaat (voor Node-tests). Laadvolgorde in `index.html`:
config → scheduler → store → io → fixtures → live → app.

## Datamodel (compatibel met v1 — NIET breken)

Firebase-pad `jo10_matches` en localStorage `jo10_matches_v1` bevatten een **array** van wedstrijden.
v1.html leest/schrijft dezelfde array, dus bestaande velden behouden hun betekenis; nieuwe velden zijn optioneel.

```js
Match = {
  id: number,                 // Date.now() bij aanmaken; uniek
  titel: string,              // "JO10 vs FC Stein (🏠 Thuis)"  (v1-formaat, blijven vullen)
  datum: 'YYYY-MM-DD',
  tegenstander: string,
  thuisUit: 'thuis' | 'uit',
  score: { home: number, away: number } | null,   // home = ONS team (JO10), ook bij uitwedstrijd
  periodes: [ { posities: { [naam]: 'K'|'V'|'M'|'S' }, wissels: [naam] } ],  // wissels staan NIET in posities
  // ── nieuw in v2, optioneel ──
  v: 2,
  aanwezig: [naam],
  keepers: [naam],            // keeper per periode (lengte = aantal periodes)
  goals: [ { team: 'home'|'away', minute: number|null, by: naam|null } ],
  notitie: string,
  updatedAt: number,
}
```

Oude records kunnen `subs` i.p.v. `wissels` hebben en `score` kan `undefined` zijn — altijd defensief lezen
(`Store.normalizeMatch` doet dit).

Firebase-pad `jo10_squad` (nieuw) en localStorage `jo10_squad_v2`:
```js
Squad = {
  players: [ { name: string, active: boolean, avoid: ['K'|'V'|'M'|'S'], aliases: [string] } ],
  settings: { periods: number /*4*/, minutes: number /*50*/ },
  updatedAt: number,
}
```
`avoid` = posities die deze speler liever niet speelt (bv. Bastiaan: `['S']`; `'K'` = niet als keeper voorstellen).
Als `jo10_squad` niet bestaat of niet leesbaar/schrijfbaar is (database-rules!) → `Config.DEFAULT_SQUAD`/lokale kopie gebruiken.

Draft (alleen lokaal, `jo10_draft_v2`): de wedstrijd die je nu aan het voorbereiden bent, zodat niets verloren
gaat bij herladen: `{ datum, tegenstander, thuisUit, aanwezig, keepers, periodes, locks, seed, savedId }`.

## API-contracten

### `JO10.Scheduler` (pure functies, deterministisch bij gelijke `seed`)
```js
generate({
  players: [naam],            // aanwezige spelers
  keepers: [naam],            // keeper per periode, lengte = periods
  periods: 4,
  history: [Match],           // eerdere wedstrijden (seizoensbalans)
  squad: Squad,               // voor avoid-voorkeuren
  seed: number,               // andere seed = ander (bijna-optimaal) schema → "Shuffle"
  locks: [ { period: i, player: naam, code: 'K'|'V'|'M'|'S'|'W' } ],  // vastgezette posities die behouden blijven
}) → { periodes: [{posities, wissels}], cost: number, warnings: [string], fairness: {...} }

evaluate(periodes, { players, keepers, history, squad }) → {
  warnings: [string],         // Nederlandstalig, bv. "Noud staat twee periodes achter elkaar wissel (P2 en P3)"
  perPlayer: { [naam]: { field: n, sub: n, K: n, V: n, M: n, S: n } },
  score: 0..100,              // eerlijkheidsscore voor deze wedstrijd
}

suggestKeepers({ players, history, squad, periods }) → [naam]   // keeper per periode: wie het minst gekeept heeft, per helft
stats(history, names) → { [naam]: { matches, periods, K, V, M, S, W, fieldPct } }
formationFor(n) → zie Config
```

### `JO10.Store`
```js
init({ onChange }) → Promise<void>  // laadt cache, start Firebase-sync; onChange({matches, squad}) bij remote wijziging
getMatches() → [Match]  (genormaliseerd, gesorteerd op datum oplopend)
saveMatch(match) → Promise<Match>   // insert of update op id; zet updatedAt; merge-veilig (transaction)
deleteMatch(id) → Promise<void>
getSquad() → Squad ; saveSquad(squad) → Promise<void>
activePlayers() → [naam]
getDraft() / saveDraft(draft) / clearDraft()
getStatus() → 'offline'|'syncing'|'synced'|'error' ; onStatus(cb)
normalizeMatch(raw) → Match
getTrash() → [{ match, removedAt, reason }]   // lokaal vangnet: wedstrijden die door sync/verwijderen verdwenen
restoreFromTrash(id) → Promise<Match>        // zet terug (als nieuwe put)
```
Spelersnamen mogen geen `. # $ / [ ]` bevatten (Firebase-sleutels); Store/UI valideren dit.
Een wedstrijd zonder periodes wordt niet naar Firebase geschreven (v1 crasht op lege `periodes`).

### `JO10.IO`
```js
exportPNG(match, { settings }) → Promise<void>   // deelblad (navigator.share) op mobiel, anders download
exportExcel(matches, { settings }) → void         // zelfde kolommen als v1: Tijd|Keeper|Verd 1|Verd 2|Midden|Spits 1|Spits 2|Wissel 1|Wissel 2
importExcel(file, squad) → Promise<{ matches: [Match], warnings: [string] }>  // v1-formaat ("Wedstrijd…"-blokken)
whatsappText(match, { settings }) → string        // opstelling per periode als platte tekst met emoji
```

### `JO10.Live`
```js
mount(containerEl, { match, settings, onUpdate(patch), onExit() })  // rendert live-scherm in container
// onUpdate krijgt ALLEEN een patch { id, score, goals } — nooit de hele (mogelijk verouderde) wedstrijd.
// App merget die patch in de actuele versie uit Store.getMatches() en slaat dan op (anders overschrijft live-modus
// wijzigingen die intussen op een ander toestel zijn gedaan).
unmount()
```
Live-state (klok, huidige periode, start-tijdstempel) staat in localStorage `jo10_live_v2`, zodat herladen of
scherm vergrendelen de klok niet reset (rekenen met `Date.now()`, niet met tellers).

### `JO10.App`
Owner van de DOM-shell en navigatie. Schermen: `wedstrijd` (voorbereiden), `live`, `seizoen`, `team`.
`App.go(screen, params)`; `App.toast(msg, type)`.

### Speelkalender
Bron: `Config.CALENDAR_URL` (VoetbalAssist-iCal van team O10-3). Browsers mogen die niet direct ophalen (CORS), daarom
downloadt een GitHub Action hem elke vrijdag om 20:00 naar `data/kalender.ics` (zelfde origin als de app). De app leest eerst dat
bestand, dan (reserve) de URL, en cachet de fixtures in localStorage `jo10_calendar_v2`. Handmatig een `.ics` importeren
kan ook (Team → Speelkalender). Fixture: `{ id, datum, tijd, tegenstander, thuisUit, locatie, soort, verzamel, uid, score }`.
Ons team wordt herkend aan "Sporting 70"/"Sporting '70"; de andere ploeg is de tegenstander (thuis = wij eerst genoemd).

## Regels voor het wisselschema (domein)
- 6 tegen 6: Keeper, 2 Verdedigers, 1 Middenvelder, 2 Spitsen. 4 periodes van 12,5 min (instelbaar).
- Aantal wissels per periode = aanwezig − 6 (0 t/m 4).
- **Hard:** formatie exact gevuld; keeper van periode p staat op K; niemand twee periodes achter elkaar wissel;
  een keeper is niet wissel in de periodes dat hij keept; vastgezette locks worden gerespecteerd.
- **Zacht (kosten):** speeltijd zo gelijk mogelijk binnen de wedstrijd, en over het seizoen (wie vaak wissel was,
  is nu minder vaak wissel); niet meer dan 2 periodes dezelfde veldpositie per wedstrijd; seizoensbalans V:M:S ≈ 2:1:2;
  `avoid`-posities vermijden (zwaar); wie vorige wedstrijd in P1 wissel was, begint nu niet als wissel;
  liefst niet elke periode van positie wisselen (rust/continuïteit).

## Ontwikkelen & testen
- `node --test test/*.test.js` — unit tests (Node 22, geen npm-dependencies nodig).
- UI testen: `python3 -m http.server` in de repo-root en Playwright/Chromium (`/opt/pw-browsers`). Firebase is in de
  ontwikkelcontainer niet bereikbaar; de app moet dan netjes lokaal blijven werken (status "offline").
- Mobiel eerst: 375px breed, touch-targets ≥ 44px, geen horizontale scroll. Licht én donker thema.

## Bekende beperkingen
- Firebase bewaart geen lege arrays: bij precies 6 spelers komt `wissels: []` terug als ontbrekend veld. v2 leest dat
  defensief; v1.html crasht daarop (bestond al in v1 bij eigen 6-spelerswedstrijden). v1 is alleen nog terugvaloptie.
- Echte Firebase-sync en de CDN's zijn in de ontwikkelcontainer niet bereikbaar; die paden zijn met fakes getest.
