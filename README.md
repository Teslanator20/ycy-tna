# YCY · TNA Tracker

Trackt, **wer mit wem TNA spielt** (The Nameless Anomaly) in der Gilde **[YCY] YuChaYuan**.

Es gibt kein offizielles "Party"-API von Wynncraft, also wird die Zusammensetzung **abgeleitet** aus
zwei unabhängigen Signalen:

1. **TNA-Co-Runs** (Hauptsignal, TNA-spezifisch) — wenn der TNA-Completion-Zähler mehrerer Member
   im selben Poll-Fenster steigt *und* sie auf demselben Server (Welt) sind, haben sie sehr
   wahrscheinlich zusammen geraidet. Über viele Runs kristallisieren sich stabile Paare/Gruppen raus.
2. **Server-Co-Anwesenheit** (Korroboration) — wie oft zwei Member gleichzeitig auf derselben Welt
   online gesehen werden.

## Dateien

- `guild.json` — Gilden-Config (Prefix YCY, getrackter Raid)
- `poll.js` — pollt Gildenroster (1 Call) + Spielerdaten **nur der online Member** (PLAYER-Limit = 50/min)
- `state.json` — letzter Stand pro Member (TNA gesamt, gained seit Start, Server, online)
- `pairs.json` — Paar-Matrizen: `tna` (gemeinsame Runs) + `copresence` (gemeinsame Server-Samples)
- `runs.json` — Log erkannter TNA-Runs (30 Tage)
- `index.html` — Dashboard (GitHub Pages)

## Rate Limits

Die Wynncraft-`PLAYER`-API erlaubt nur **50 Requests/Minute**. Darum werden Spielerdaten nur für
aktuell online Member geholt — TNA-Zähler steigen ohnehin nur online, es geht also kein Increment
verloren. Der Poller ist 429-aware und wartet bei Bedarf das Reset-Fenster ab.

## Workflow

`.github/workflows/poll.yml` läuft alle 3 Min per Cron + `workflow_dispatch`. Häufiges Polling
verbessert die zeitliche Zuordnung der TNA-Runs. Optional zuverlässiger Trigger via cron-job.org →
`POST /actions/workflows/poll.yml/dispatches`.

## Genauigkeit / Caveats

- Die Wynncraft-API cached Spielerdaten leicht verzögert → gelegentlich landen Partner in
  benachbarten Fenstern. Das macht etwas Rauschen, aber echte Paare dominieren über Zeit.
- Nur Member, die seit Tracking-Start mind. einmal online waren, haben TNA-Daten.
- "Server" = Wynncraft-Welt (z.B. `AS13`); mehrere Partys können auf derselben Welt sein, daher ist
  das TNA-Increment-Signal stärker als reine Co-Anwesenheit.
