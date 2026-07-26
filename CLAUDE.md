# FPL data platform — agent guide

Data-driven FPL tooling for a Norwegian friend-group mini-league, replacing a Fantasy
Football Fix Premium subscription with free sources. See `README.md` for setup and
`docs/` for design. This file captures what isn't obvious from the code.

**Deadline: GW1 is 2026-08-21 17:30 UTC.**

## Stack

Python sync (GitHub Actions cron) → Supabase Postgres → Next.js + TS web app (Phase 4,
not built yet). Sync writes straight to Postgres via `psycopg`; there is no
`Python → JSON → TypeScript` hop, deliberately — that pattern is what left
`../Sporting_Director_Game`'s enrichment "currently manual".

## Commands

```bash
python scripts/probe/probe_sources.py          # health-check every source; exit = #failures
python -m sync.cli all --dry-run               # parse live payloads, write nothing
python -m sync.cli snapshot                    # the hourly job
python -m sync.cli history --limit 20          # element-summary, capped

psql "$DATABASE_URL" -f supabase/migrations/0001_fpl_core.sql   # idempotent
```

There is no test runner. `--dry-run` plus the probe script are the verification path.

## The three things that will bite you

1. **Preseason carry-over.** Until GW1, `bootstrap-static.elements` aggregates describe
   the **previous** season. Verified 2026-07-26: the 2026/27 payload carried Haaland's
   2025/26 totals (`minutes: 2953`, `expected_goals: 25.50`). `config.aggregates_season()`
   resolves this, and `player_season_totals.season` is the season the *numbers* describe —
   not the season being synced. Never assume the two match.

2. **Season-scoped ids are reused across seasons.** `elements[].id` and `teams[].id` are
   not stable; `code` is. Every FK in the schema uses `code`. Season-scoped ids live in
   `player_seasons.fpl_id` / `team_seasons.fpl_id` because payloads reference them
   (fixtures use `team_h`/`team_a`, element-summary takes an element id).

3. **`player_snapshots` cannot be backfilled.** The FPL API has no history endpoint. It's
   written **insert-on-change** against `snapshot.WATCHED` because a naive hourly insert
   of 558 players is ~4M rows/season (~600 MB), over Supabase's 500 MB free tier. If you
   add a field to `WATCHED`, row volume goes up — check the growth query in
   `docs/SYNC_PLAN.md` §8 first. Cumulative `transfers_in`/`transfers_out` are
   deliberately *not* watched: within a gameweek they duplicate the `_event` counters and
   would force a row per player per hour.

## Architecture map

- `sync/config.py` — env + **season resolution**. `season_label`, `is_preseason`,
  `aggregates_season`. Preseason is detected two independent ways (no `is_current` event
  *and* no `finished` event) so one flag quirk can't mislabel an ingest.
- `sync/db.py` — `upsert` (chunked at 500, stamps `updated_at`), `insert_ignore`
  (append-only tables), `sync_run` context manager (records every attempt, re-raises).
- `sync/fpl.py` — API client + coercion. **The API returns numbers as strings**
  (`selected_by_percent: "74.6"`, `expected_goals: "25.50"`) and mixes `""` with `null`.
  Always go through `as_int` / `as_num` / `as_text`. `as_num` returns `Decimal`, not
  float, so snapshot comparisons can't produce phantom changes from binary rounding.
- `sync/jobs/dimensions.py` — `build()` is a pure transform (payloads in, rows out), which
  is what makes `--dry-run` meaningful. `ORDER` is FK-safe insertion order.
- `sync/jobs/snapshot.py` — insert-on-change + `player_price_events`, the labelled
  training set for the price model.
- `sync/jobs/history.py` — `element-summary` per player. Field access is defensive
  `.get()` because `history` is empty in preseason; its exact shape can only be confirmed
  after GW1.

## Data sources — read before adding a stat

`docs/DATA_SOURCES.md` is the single source of truth, and **any change to a source, stat,
or derived metric updates it in the same commit**. Carried over from
`Sporting_Director_Game`, where that discipline is why mismatches stayed debuggable.

Short version:
- **FPL API** — Tier 1. Opta xG/xA/xGC, DEFCON counters, set-piece taker orders, injury
  news. 105 fields/player.
- **Understat** (`soccerdata`) — Tier 2. `read_team_match_stats` gives **PPDA** and
  **deep completions**: the actual answer to "which teams play defensive football".
  Low PPDA = high press. Also 8 616 shot events/season with x/y and situation.
- **Sofascore** (`ScraperFC`) — Tier 2. 114 player-season stats. Gates on TLS
  fingerprint: plain `requests` gets 403, `curl_cffi` with `impersonate="chrome120"` gets
  200. Patch point is `ScraperFC.sofascore.botasaurus_browser_get_json`.
- **ClubElo**, **football-data.co.uk** — Tier 2. Team strength; closing odds → de-vigged
  win/clean-sheet probabilities, a much better fixture difficulty than FPL's integer FDR.
- **FBref — do not use.** Lost its Opta licence January 2026; advanced data deleted. A
  second loss after the StatsBomb termination. Basic stats and historical archive only.
- **Sportmonks — not used here.** The FPL API already supplies Opta xG.

Assume any Tier 2 source can vanish. Raw payloads are cached under `tmp/raw/` on every
fetch so an outage costs future data, not past data.

## When changing things

- New table or column → new numbered migration in `supabase/migrations/`, idempotent
  (`if not exists`). Views: `drop` + `create` in a new migration.
- New source → its own `sync/jobs/*.py` exposing `run(client, *, dry_run=False) -> dict`,
  registered in `sync/cli.py:JOBS`, plus a check in `scripts/probe/probe_sources.py`.
- Cross-source player identity resolves **once** into `player_external_ids` (Phase 2), not
  fuzzily at query time. Log unmatched rows to `tmp/<source>-unmatched.json`.
- Verify with `python -m sync.cli <job> --dry-run` and the probe script. Then check
  `select * from sync_freshness;`.

## Reference projects

`../vm26` (Next.js 16 + Supabase, cron ingest, RLS) and `../Sporting_Director_Game`
(Supabase + TanStack Table + percentile heatmaps + the Python scrapers this repo reuses).
Phase 4 should lift SDG's `components/players-table/` and `lib/heatmap.ts` approach rather
than reinvent it.
