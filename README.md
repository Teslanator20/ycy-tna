# YCY · TNA Tracker

Trackt, **wer mit wem TNA spielt** (The Nameless Anomaly) in der Gilde **[YCY] YuChaYuan**.

Es gibt kein offizielles "Party"-API von Wynncraft, also wird die Zusammensetzung **abgeleitet** aus
zwei unabhängigen Signalen:

1. **TNA-Co-Runs** (Hauptsignal, TNA-spezifisch) — wenn der TNA-Completion-Zähler mehrerer Member
   im selben Poll-Fenster steigt, haben sie sehr wahrscheinlich zusammen geraidet. Über viele Runs
   kristallisieren sich stabile Paare/Gruppen raus.
   - Stimmt zusätzlich der **Server** überein, gilt der Run als *server-bestätigt* (höhere Konfidenz).
   - **Offline/versteckte** Member werden trotzdem erfasst: ihr TNA-Zähler steigt auch wenn sie
     offline gestellt sind. Finished in einem Fenster genau **eine** Server-Party, werden offline
     Raider dieser Party zugerechnet; sonst landen sie als *window-only* (niedrigere Konfidenz).
2. **Server-Co-Anwesenheit** (Korroboration) — wie oft zwei Member gleichzeitig auf derselben Welt
   online gesehen werden.

## Dateien

- `guild.json` — Gilden-Config (Prefix YCY, getrackter Raid)
- `poll.js` — pollt **nur den Gilden-Endpunkt** (1 Call); der liefert pro Member die komplette
  `globalData.raids.list` inkl. TNA-Zähler — für **alle** Member, online wie offline
- `state.json` — letzter Stand pro Member (TNA gesamt, gained seit Start, Server, online, lastRaid)
- `pairs.json` — Paar-Matrizen: `tna` (gemeinsame Runs, mit `confirmed`-Zähler) + `copresence`
- `runs.json` — Log erkannter TNA-Runs (30 Tage), je Run `confirmed`/`crowded`-Flags
- `index.html` — Dashboard (GitHub Pages)

## Warum nur ein Call

Der Gilden-Endpunkt trägt pro Member bereits die vollständigen Raid-Totals (`globalData.raids.list`).
Damit brauchen wir den `PLAYER`-Endpunkt (Limit 50/min) gar nicht: ein einziger Call pro Poll deckt
alle 96 Member ab, inklusive offline/versteckter Spieler — und nichts läuft ins Rate-Limit.

## Workflow

`.github/workflows/poll.yml` läuft alle 3 Min per Cron + `workflow_dispatch`. Häufiges Polling
verbessert die zeitliche Zuordnung der TNA-Runs. Optional zuverlässiger Trigger via cron-job.org →
`POST /actions/workflows/poll.yml/dispatches`.

## Genauigkeit / Caveats

- Die Wynncraft-API cached Daten leicht verzögert → gelegentlich landen Partner in benachbarten
  Fenstern. Das macht etwas Rauschen, aber echte Paare dominieren über Zeit.
- Member, die noch nie TNA gespielt haben, haben keinen TNA-Eintrag → `tna: null` (kein Tracking nötig).
- "Server" = Wynncraft-Welt (z.B. `AS13`); mehrere Partys können auf derselben Welt sein. Häufiges
  Polling (3 Min) hält die Fenster kurz, sodass meist nur eine Party pro Fenster fertig wird.
- Finishen in einem Fenster mehr als ~6 Member gemeinsam, wird der Run als *crowded* geloggt aber
  nicht verpaart (zu mehrdeutig).
