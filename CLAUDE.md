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
python scripts/probe/probe_sources.py            # health-check every source; exit = #failures
python scripts/probe/prove_snapshot_logic.py     # insert-on-change regression, no DB needed
python scripts/probe/prove_player_matching.py    # 44 name-matching cases, no DB needed

python scripts/migrate.py                        # apply all migrations (idempotent)

python -m sync.cli all --dry-run                 # FPL core: dimensions, history, snapshot
python -m sync.cli snapshot                      # the hourly job
python -m sync.cli enrich                        # Tier 2: understat, core_insights, clubelo, odds
python -m sync.cli understat --rematch           # re-resolve identities from scratch
python -m sync.cli verify                        # post-sync sanity + storage growth
```

There is no test runner. `--dry-run`, the probe scripts, and `verify` are the verification
path. The two `prove_*` scripts run without a database or network, so they gate CI.

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

3. **Read completed seasons from `player_season_totals` where `source = 'history_past'`,
   never `'bootstrap'`.** They disagree for loan and transfer cases — verified 2026-07-26,
   5 players in 2025/26, e.g. Anthony at 0 bootstrap minutes vs 2717 in history_past.
   Related: expected stats (xG/xA/xGI/xGC) are **zero before 2022/23**, so xG backtests
   have four seasons, not twenty. Details in `docs/DATA_SOURCES.md` §2.1.

4. **`player_snapshots` cannot be backfilled.** The FPL API has no history endpoint. It's
   written **insert-on-change** against `snapshot.WATCHED` because a naive hourly insert
   of 558 players is ~4M rows/season (~600 MB), over Supabase's 500 MB free tier. If you
   add a field to `WATCHED`, row volume goes up — check the growth query in
   `docs/SYNC_PLAN.md` §8 first. Cumulative `transfers_in`/`transfers_out` are
   deliberately *not* watched: within a gameweek they duplicate the `_event` counters and
   would force a row per player per hour.

## Cross-source name matching — where a bug is invisible

`sync/matching/players.py`. A wrong match doesn't error: it silently attributes one
player's xG to another. The first live run stored **ten false positives**, every one of them
a shared surname with an incompatible forename — `Jackson Tchatchoua` → `Nicolas Jackson`,
`Ashley Barnes` → `Harvey Barnes`, `Daniel Muñoz` → `Victor Munoz`. Three rules came out of
fixing that, and none of them is optional:

1. **A shared surname is not a match.** The FPL forename must be compatible with *some*
   token of the incoming name (`_forename_agrees`). Any token, not just the first —
   Understat's `Eli Junior Kroupi` is FPL's `Junior Kroupi`. Compatibility is deliberately
   generous (prefix, containment, or two shared leading characters) because real pairs
   include Josh/Joshua, Joe/Joseph, Matty/Matthew and Tino/Valentino.
2. **Never use the incoming forename as a surname candidate.** There is no "first token
   only" variant, and adding one back is how four of the ten false positives happened.
   Genuine single-name players (Kepa, Alisson, Sávio, Jair) have one token and are already
   covered.
3. **Team breaks ties; it never vetoes.** Enrichment covers last season while
   `player_seasons` holds the current club, so a transferred player legitimately differs on
   each side.

Plus: `Đ`/`đ` transliterate to **`dj`**, not `d` — FPL writes `Đorđe Petrović` where
Understat writes `Djordje Petrovic`. And `ø`, `æ`, `ł`, `ß` are distinct letters that NFKD
does *not* decompose, so they need `TRANSLITERATE` rather than diacritic stripping.

`scripts/probe/prove_player_matching.py` holds all of this as 44 regression cases, needing
no database or network. **Extend it before changing the matcher**, and note the negatives
matter more than the positives. If you do change the logic, re-resolve with
`python -m sync.cli understat --rematch` — mappings are sticky, so stored mistakes survive
otherwise.

Not matching is fine and expected: 138 of 537 Understat players are unresolved because
they played for relegated clubs or left the league. `unmatched_names` records them, and
`dedupe_by_player` rejects two external players resolving to one FPL player rather than
letting a unique constraint drop one silently.

## Architecture map

- `sync/config.py` — env + **season resolution**. `season_label`, `is_preseason`,
  `aggregates_season`. Preseason is detected two independent ways (no `is_current` event
  *and* no `finished` event) so one flag quirk can't mislabel an ingest.
- `sync/db.py` — `upsert` (chunked at 500, stamps `updated_at`), `insert_ignore`
  (append-only tables), `sync_run` context manager (records every attempt, re-raises).
  **`sync_run`'s error path must `rollback()` before recording the failure**: a failed
  write leaves the connection in an aborted transaction where the error-recording `UPDATE`
  fails too, stranding the row on `'running'` and losing the error. That bug produced the
  two orphaned rows visible in `sync_runs` ids 1-2. `verify` now flags stale `'running'`
  rows because `sync_freshness` reads only `'ok'` and `'error'` and can't see them.
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
  Low PPDA = high press. Also 9 524 shot events/season with x/y and situation.
  **`soccerdata` caches aggressively** and will serve a partial mid-season snapshot
  indefinitely — a short row count means a stale cache, not an Understat gap. Clear
  `~/soccerdata/data/Understat` before concluding otherwise.
- **Sofascore** — Tier 2. 116 player-season stats via **our own client**,
  `sync/sources/sofascore.py`. **Never reach for `ScraperFC`** (as
  `../Sporting_Director_Game` does): importing it downloads a TLS binary from GitHub
  releases at import time, which 403s on Actions runners and kills the job before
  Sofascore is contacted. Gates on TLS fingerprint — `curl_cffi` with
  `impersonate="chrome120"`, not plain `requests`. Raises `SofascoreBlocked` on 403/429 so
  callers can tell "blocked from this IP" from "source changed shape".
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
