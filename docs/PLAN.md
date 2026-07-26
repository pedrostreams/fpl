# FPL data platform — plan

**Goal:** a data-driven FPL web app good enough to replace a Fantasy Football Fix Premium
subscription, built on free sources that refresh at least daily.

**Hard deadline:** GW1 kicks off with a deadline of **2026-08-21 17:30 UTC**. The premium
subscription lapses **2026-08-14**, one week earlier.

**Decided stack** (matches the two reference projects where it makes sense, diverges
where they hurt):

| Layer | Choice | Why |
|---|---|---|
| Store | Supabase Postgres | Same as `vm26` and `Sporting_Director_Game`. Region `eu-central-1`. |
| Sync runtime | **GitHub Actions** | Only free host that does sub-daily cron *and* runs Python. Vercel Hobby cron is 1×/day and can't run `soccerdata`/`ScraperFC` at all. |
| Ingest language | **Python, writing straight to Postgres** | `soccerdata` and `ScraperFC` are Python-only. Drops the `Python → JSON → TS` hop that left `Sporting_Director_Game`'s enrichment "currently manual". |
| Web app | Next.js + TS, read-only against Postgres | Later phase. Reads views, never scrapes. |

---

## The one time-critical fact

The FPL API exposes **only current state**. There is no historical endpoint. Every
time-series feature — price prediction, ownership momentum, form trends — depends on
snapshots *we* capture. Nothing can be backfilled.

**But**, verified empirically on 2026-07-26, preseason has no transfer or price activity
whatsoever:

| Preseason probe | Value |
|---|---|
| `max(transfers_in_event)` | 0 |
| `max(transfers_in)` (season total) | 0 |
| Players with `cost_change_start ≠ 0` | 0 of 558 |
| Players with `price_change_percent ≠ 0` | 0 of 558 |
| Players with `selected_by_percent > 0` | **505 of 558** |
| Registered entries (`total_players`) | **1 573 812** |

So squad selection does **not** register as transfers, and prices are frozen until the
GW1 deadline. **The price model genuinely cannot start before 2026-08-21** — a correct
instinct, and it reorders the roadmap.

What *is* live and unrecoverable right now is **ownership drift**: 1.57M squads are
already built and `selected_by_percent` moves daily as the template forms. That is worth
capturing from today, cheaply, even though the price model can't use it yet.

**Conclusion:** build **player scouting first**. Run the snapshot job from day one anyway
— it is one hourly cron, it costs nothing, and it means the price model has a warm
pipeline the moment prices unfreeze.

---

## Phases

### Phase 0 — Research ✅ done 2026-07-26

Findings in [DATA_SOURCES.md](DATA_SOURCES.md); evidence in
[scripts/probe/](../scripts/probe/). Headlines:

- The FPL API now carries **Opta xG/xA/xGC natively** (105 fields/player) → no paid
  provider needed, and the `Sportmonks` dependency from `Sporting_Director_Game` is
  dropped.
- **FBref is dead for advanced stats** — lost its Opta licence January 2026, data
  deleted. A second loss after the StatsBomb termination. Do not build on it.
- **Understat, Sofascore, ClubElo, football-data.co.uk all verified alive** today.
- FPL ships its own `price_change_percent` predictor for 2026/27 — treat as a free input
  signal, not a competitor; we'll hold the raw net-transfer curve it hides.

### Phase 1 — Core sync (now → ~2026-08-02)

Design in [SYNC_PLAN.md](SYNC_PLAN.md).

1. Supabase project + migration `0001` (FPL core + `player_snapshots` + `sync_runs`).
2. Python sync for `bootstrap-static`, `fixtures`, `element-summary`.
3. GitHub Actions: hourly snapshot, daily full sync.
4. **Start snapshotting immediately** to bank ownership drift before GW1.

Success test: `player_snapshots` gains 558 rows per hour without duplicates, and
`sync_runs` shows green.

### Phase 2 — Enrichment sync (~2026-08-02 → 08-09)

Migration `0002` plus one Python module per source:

- **Understat** — `read_team_match_stats` (PPDA, deep completions, per-match xG/npxG),
  `read_shot_events` (8 616 shots/season with x/y, body part, situation),
  `read_player_season_stats` (xA, xGChain, xGBuildup).
- **Sofascore** — 114 player-season stats via the verified `curl_cffi`
  `chrome120` TLS-impersonation patch.
- **ClubElo** — team Elo time series.
- **football-data.co.uk** — closing odds → de-vigged win / clean-sheet probabilities.
  (`2627/E0.csv` 404s until matches are played; expected.)

Also here: the FPL ↔ Understat ↔ Sofascore identity problem. Resolve once into
`player_external_ids` rather than name-matching at query time — reuse the cascade idea
from `Sporting_Director_Game/lib/matching/players.ts`, but persist the result.

### Phase 3 — Derived metrics (~2026-08-09 → 08-16)

SQL views and materialised views. `Sporting_Director_Game` proved the matview pattern
works; reuse it, and reuse its rule that base-stat writes need an explicit refresh.

- Rolling per-90s over last N gameweeks, minutes-weighted.
- Over/underperformance: `goals − xG`, `assists − xA`.
- Value: points per £m, and xGI per £m.
- **Team style:** PPDA and deep-completions percentiles → a defensive/pressing axis.
- **Fixture difficulty from odds**, not FPL's integer 1–5 FDR.
- **DEFCON reliability:** rate of clearing the threshold per 90, not just the season total.
- Set-piece threat, straight from `penalties_order` / `*_freekicks_order` / corners.

### Phase 4 — Web app (~2026-08-16 → GW1, then iterative)

Next.js + TS, reading views only. First screens, in order:

1. **Player scout** — filterable, sortable table with percentile heatmaps. This is the
   Phase-4 entry point because it's what you need to pick a GW1 squad. Lift the
   TanStack Table + `lib/heatmap.ts` percentile approach from
   `Sporting_Director_Game/components/players-table/`.
2. **Hidden gems** — high xGI/90 × low ownership × low price × rising minutes.
3. **Team profiles** — form, xG/xGA, PPDA, Elo, upcoming fixture ticker.
4. **Price watch** — goes live at GW1, when the underlying data starts existing.

### Phase 5 — The differentiator (post-GW1)

**Mini-league effective ownership.** Pull the friend group's actual squads via
`leagues-classic/{id}/standings/` → `entry/{id}/event/{n}/picks/`, and compute EO against
*those 10–20 rivals* instead of the global top-10k.

This is the feature Fantasy Football Fix structurally cannot offer, because it doesn't
know who you're playing against. It's also the most direct answer to "bruke dette til min
fordel". Blocked until the season starts (picks are hidden pre-GW1).

**Needed from you:** the mini-league ID — visible in the URL when you open the league on
the FPL site (`.../leagues/XXXXXX/standings/c`).

---

## Feature → source map

Condensed from [DATA_SOURCES.md](DATA_SOURCES.md) §6:

| What you asked for | Source | Phase |
|---|---|---|
| Who's performing right now | FPL `form`, xGI/90, DEFCON/90 | 3 |
| Hidden gems | FPL ownership × xGI/90 × price | 3 |
| Price rise/fall next 24h | **our own snapshots** + `price_change_percent` | 1 collect, 4 model |
| Which teams are performing | Understat xG/xGA, ClubElo | 2–3 |
| Which teams play defensively | **Understat PPDA + deep completions** | 2–3 |
| Better fixture difficulty | de-vigged bookmaker odds | 2–3 |
| DEFCON bankers | FPL `defensive_contribution_per_90` | 3 |
| Set-piece threat | FPL taker orders (free, first-party) | 3 |
| Beat *your* mini-league | `leagues-classic` + `entry/.../picks` | 5 |

---

## Risks

| Risk | Mitigation |
|---|---|
| A Tier 2 scrape breaks (it happened twice to FBref in a year) | Cache raw payloads to disk/storage on every run. An outage then costs future data, not past data. Probe script gates CI. |
| Preseason carry-over corrupts 2026/27 stats | Tag every aggregate with the season it belongs to at ingest. `history == []` and `form == 0.0` are the reliable preseason tells. |
| Season-scoped FPL `id` reused across seasons | Key everything on the stable `code` / `element_code`. |
| GitHub Actions cron drifts or is skipped under load | `sync_runs` table + a staleness check; hourly job is idempotent so a missed run self-heals. |
| Name matching FPL ↔ Understat ↔ Sofascore | Resolve once into `player_external_ids`, log unmatched for review — same discipline as SDG's `tmp/<source>-unmatched.json`. |
| Scope creep before GW1 | Phases 1–3 are the only ones that must land by 2026-08-21. Phase 5 is the fun one; it's deliberately after. |

---

## Conventions

Carried over from the reference projects because they worked:

- Migrations are **append-only and idempotent** (`if not exists`); `drop`+`create` for
  views in a new numbered migration.
- **Any change to a data source or derived metric updates
  [DATA_SOURCES.md](DATA_SOURCES.md) in the same commit.** This is what kept SDG
  debuggable.
- Every sync job records to `sync_runs`, and is safe to re-run.
- Docs and code in English; commit messages and conversation in Norwegian as you prefer.
