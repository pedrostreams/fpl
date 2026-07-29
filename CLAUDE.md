# FPL data platform — agent guide

Data-driven FPL tooling for a Norwegian friend-group mini-league, replacing a Fantasy
Football Fix Premium subscription with free sources. See `README.md` for setup and
`docs/` for design. This file captures what isn't obvious from the code.

**Deadline: GW1 is 2026-08-21 17:30 UTC.**

## Stack

Python sync (GitHub Actions, **clocked by pg_cron**) → Supabase Postgres → Next.js + TS web
app (Phase 4, not built yet). Sync writes straight to Postgres via `psycopg`; there is no
`Python → JSON → TypeScript` hop, deliberately — that pattern is what left
`../Sporting_Director_Game`'s enrichment "currently manual".

## Commands

```bash
python scripts/probe/probe_sources.py            # health-check every source; exit = #failures
python scripts/probe/prove_snapshot_logic.py     # insert-on-change regression, no DB needed
python scripts/probe/prove_player_matching.py    # 44 name-matching cases, no DB needed
python scripts/probe/prove_market_parse.py       # Norsk Tipping market parsing, no DB needed
python scripts/probe/prove_rotation_pairs.py     # blank/double rotation scoring, no DB needed
# tooltip rank == cell shading, no DB needed
node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON \
     --import ./scripts/probe/_ts_resolve.mjs scripts/probe/prove_rank_detail.mjs

python scripts/probe/calibrate_elo_fixtures.py   # refit the fixture-difficulty constants
python scripts/probe/prove_style_claims.py       # re-derive every style reliability, needs DB
python scripts/probe/prove_gameweek_shape.py      # simulate a blank + double in a rolled-back txn
python scripts/migrate.py                        # apply all migrations (idempotent)

python -m sync.cli all --dry-run                 # FPL core: dimensions, history, snapshot
python -m sync.cli snapshot                      # the hourly job
python -m sync.cli enrich                        # Tier 2: understat, core_insights, clubelo, odds, market_odds
python -m sync.cli market_odds --dry-run         # Norsk Tipping; runs 2-hourly on its own clock
python -m sync.cli understat --rematch           # re-resolve identities from scratch
python -m sync.cli verify                        # post-sync sanity + storage growth
```

There is no test runner. `--dry-run`, the probe scripts, and `verify` are the verification
path. Five of the six `prove_*` scripts run without a database or network, so they gate CI. One
of those is JavaScript rather than Python because it asserts on `lib/rank.ts` directly — Node
strips the type annotations, and `scripts/probe/_ts_resolve.mjs` supplies the file extensions
and the `@/` alias that TypeScript imports omit. `prove_style_claims.py` is the exception that
needs `DATABASE_URL`: what it asserts are properties of 646 club-matches, not of a fixture, so it
is run by hand like `calibrate_elo_fixtures.py`.

**`(select season from season_context)` is a silent tautology and reads as correct.**
`season_context` has columns `current_season`, `stats_season`, `season_started` — there is no
`season`. So inside a subquery whose outer scope has a `season` column (`player_seasons`,
`player_season_totals`, `fixtures` — most of the schema), Postgres resolves the bare name as an
**outer reference** and `ps.season = (select season from season_context)` becomes
`ps.season = ps.season`. No error, no warning, and it only fails loudly where no outer column of
that name is in scope. It is currently harmless because `player_seasons` holds one season; the day
2025-26 is loaded, every join written this way fans out. Always name the column you mean. Found
2026-07-29 in 0025's own check view, which had been reporting a pass on an unfiltered join.

**`select * from <name>_check;` is how a view is verified**, and every boolean in one must be
true. `python -m sync.cli verify` asserts every boolean in `market_odds_check`,
`fixture_percentage_check`, `position_price_value_check`, `form_check`,
`rotation_pairs_check`, `rotation_risk_check`, `gameweek_shape_check`, `style_check` and
`trend_check`
wholesale, and reports NULLs rather than failing them — some are legitimately empty until the
season starts. Two traps that made a check look like it passed when it asserted nothing:
`bool_and` over **zero rows is NULL**, which reads as a pass in a table of booleans — so publish
the row count beside any check whose `where` clause can go empty.

**A correlated `exists` against a scoring view evaluates it once per row.**
`sell_candidates` wrote `exists (select 1 from target_players where player_code = s.player_code)`
and took a 563-row view past a two-minute statement timeout — `target_players` is a scoring view,
evaluated 563 times. `with targets as materialized (select distinct player_code from
target_players)` plus a left join: 2.5s. Same shape as the check-view problem below, one level down.

**A check view built from N scalar subqueries scans its base view N times.** `rotation_risk_check`
took **41.5 seconds** and the whole loop 98.6 — a `verify` that slow is one that gets skipped, and a
check nobody runs asserts nothing. Almost every assertion in one of these views is an aggregate over
the same rows, so it belongs in **one** aggregate over one scan: `with r as materialized (select *
from …)` and then `bool_and(x) filter (where y)` per column. Migration 0031 did that for four views,
98.6s → 19s, with no assertion weakened. **And time a check view with `select *`, never
`count(*)`** — for `count(*)` the column values are never needed, so the planner discards every
scalar subquery and reported that same 41.5s view as 0.98s. And a check that restates the
expression it is checking proves only that SQL is deterministic; assert against an independent
derivation, which is what `prove_style_claims.py` exists to be.

**Nothing is `finished` until 2026-08-21**, so every code path keyed on an in-progress season
is unexercised by the data. [docs/FIX_WHEN_LIVE.md](docs/FIX_WHEN_LIVE.md) is the go-live
checklist — **136 items**, ordered by when each becomes checkable, from the deadline hour through
the first price change to end-of-season refit. It lives in `docs/` and not `.claude/context/`
because it is a list a human ticks through on the day, not agent guidance. **Add to it whenever you
write something the frozen data cannot reach**, and tick items off there rather than rediscovering
them. That rule is easy to half-follow: of the eight features shipped 2026-07-29, six had left
nothing behind here until they were audited for it a day later. That is how the fixture ticker shipped with incomparable totals:
`fixture_run` looked correct and had never run against the state it will spend the whole season
in. To exercise one, simulate rather than wait — either rewrite `finished` as
`kickoff_time < <cutoff>` inside a copy of the view's SQL, or briefly `update fixtures set
finished = true` for a few GW1 rows with the revert in a `finally`. `dimensions` re-syncs
`finished` from the API daily, so even a crashed run self-heals.

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

   Insert-on-change has **two consequences that will produce wrong numbers if you forget them**
   (both handled in migration 0009, `player_movement`):
   - "The value 24 hours ago" is the most recent row **at or before** that instant, not the row
     nearest to it. No row means nothing changed, not that data is missing.
   - A capture where nothing moved writes **no rows at all**, so `max(captured_at)` is the last
     time something *changed*. Using it as a freshness signal reports a perfectly healthy hourly
     job as dead whenever the market is frozen — which is the entire preseason. Liveness comes
     from `sync_runs`, which records every attempt including the empty ones.

   **The hourly clock is pg_cron, not GitHub Actions `schedule`** (migration 0019). Measured
   2026-07-28: GitHub delivered **12 of 33** scheduled runs in 24 hours and **1 of 12** in the
   nightly price window the job exists for, with `created_at = run_started_at` on all 12 — so the
   rest were never dispatched, not merely late. Moving every cron off the round minute helped
   from ~200 to ~130 median minutes and no further. `schedule` is best-effort by design;
   `workflow_dispatch` is not, so `cron.schedule` in Supabase calls `dispatch_workflow()`, which
   `pg_net`-POSTs the Actions API. **Change the cadence in `cron.job`, not in the workflow file**
   — the `schedule:` block there is now a sparse 3-hourly backstop for the case where the token
   lapses. `workflow_dispatch_health` is the thing to read when captures go quiet: it separates
   "the token is dead" (401) from "the job is unscheduled" from "GitHub is fine and nothing
   moved", which from `sync_runs` alone all look identical.

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

- `sync/cli.py` — **job modules are imported lazily, and that is load-bearing.** Importing them
  all eagerly meant `python -m sync.cli snapshot` pulled in `clubelo`, whose top-level
  `curl_cffi` import is an enrichment dependency the hourly snapshot workflow deliberately does
  not install. The hourly job died with `ModuleNotFoundError` before running a line — breaking
  the one table that cannot be backfilled. Adding the dependency to that workflow would have
  fixed the symptom and left the coupling. **Never import a job at `cli.py` module level.**
- `sync/sources/understat_raw.py` — repairs three shot enum values `soccerdata` drops to NaN.
  See `docs/DATA_SOURCES.md` §3.1; without it, non-penalty xG silently counts penalties.
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
- `scripts/probe/calibrate_elo_fixtures.py` — fits the fixture-difficulty constants. **The
  only place they are derived**; migration 0007 hardcodes the output. Re-run it after a season
  and update both the constants and the fit numbers quoted in the migration header. Its
  clean-sheet quartile check exists because it caught a real inversion: side *i*'s clean sheet
  is its **opponent's** lambda, and scoring `exp(-lambda[i])` against "side *i* kept a blank"
  compares two different teams' events, which reads as a plausible model running backwards.

## Web app

Next.js 16 + React 19 + Tailwind 4, App Router. `npm run dev` (add `PORT=3210` — port 3000
is usually taken by one of the sibling projects), `npm run build`, `npm run typecheck`.

- **No Supabase JS client.** Server components read Postgres directly via `pg`
  (`lib/db.ts`). There is no auth and no client-side write, so a direct server connection is
  simpler and safer than an anon key plus RLS policies that would only ever say "everyone
  may read all of this public football data". The connection string never reaches the browser.
- **The pool must be a `globalThis` singleton.** Next re-evaluates modules on every edit in
  dev; without it each hot reload leaks a fresh set of connections and exhausts the pooler.
- **`numeric` arrives as a string** from node-postgres, because it can hold values outside
  IEEE 754. Everything goes through `num()` in `lib/db.ts` — sorting the raw strings would
  put 9 after 10.
- **No metric is computed in TypeScript.** `lib/queries.ts` only maps columns. If a number
  needs deriving it belongs in a SQL view, where `python -m sync.cli verify` can check it
  instead of it being verifiable only by eye. **One documented exception**, in `lib/rank.ts`:
  percentiles used *only to shade a cell* are computed client-side. The line is what the number
  is for — a percentile that feeds a score (`gem_score`, `floor_score`) changes a
  recommendation and stays in SQL; one that decides how green a cell is does not, and putting
  it in SQL would mean a migration for every column a user might compose into a view. Match
  `cume_dist`, never `percent_rank`: they disagree on ties, and percent_rank is what rendered
  every full-time starter as "37th percentile" on the captain panel.
- **`typedRoutes: true`** means a `<Link>` to a route that doesn't exist is a build error.
  That is deliberate — it caught the nav pointing at unbuilt pages.
- Pages use segment `revalidate = 300`. Cache Components (`cacheComponents: true`) are opt-in
  in Next 16 and not enabled; the sync writes hourly at most, so five minutes costs nothing.

**Design language is `.claude/context/DESIGN.md`** — tokens, the heatmap contract, table and
badge conventions, what's deliberately absent, and the open questions the design round has to
settle. Read it before adding a screen; **update it in the same commit as any change to
`app/globals.css`**, the same discipline `docs/DATA_SOURCES.md` gets for data. Two rules from
it that a code change can silently break: **colour always means better, never bigger** (invert
"lower is better" metrics in the SQL view, never in the component), and **null must never
render as low** (em dash, or `.heat-null` hatching for an unranked cell).

**`/gw` is the order and the sentence, and that was the whole finding.**
Reading a season of allaboutfpl, the gap was never data — on data we are ahead almost everywhere.
Their advantage is that **every week, in a fixed order, someone answers the five questions a manager
actually has and writes a sentence about each**, while we had the answers scattered across seven
pages with no order and no sentence. `/gw` walks: shape of the week → buy/sell → captain →
differentials → what next. Almost no new SQL — `sell_candidates` (0032) was the only missing half,
because buy existed and hold is a non-action.

`sell_candidates` emits **reason codes, never a blended score**: "0.71" cannot be argued with,
"fixtures turning and his minutes falling" can, and two reasons is a stronger sell than one. Two
rules in it are load-bearing. **A run of blanks is deliberately not a reason** — returns are far
noisier than the underlying, and selling on a blank run is the most common mistake in the game.
And **`rotation_risk` fires only on a measured decline**, not on competition existing: accepting
"a real contest for the slot" flagged 38 players including one on 48.7% ownership.

**`/players` is the one table, and "view" is the user's word for a saved column set — not a
Postgres view.** `/scout` and `/gems` were the same 558 rows with different columns and
different row filters, so a view selects columns and a filter selects rows, both encoded in the
URL. Three pieces:

- `lib/columns.ts` — the **column catalogue**, every metric registered once with label, group,
  format and `direction`. Adding a metric is one entry plus one line in `player_wide`; there is
  no reason to build another page. `direction` is load-bearing: a composed view will put xGC
  next to xG, and without it one of them shades backwards and the screen recommends the worst
  defence in the league. `'none'` means show a plain number, which is the honest answer when
  "better" is undefined (price, PPDA, G−xG).
- `player_wide` (migration 0015) — one row per player, **every** player, no quality gates. The
  scoring views filter; a browsing table must not.
- `saved_views` + `saveView` in `lib/actions.ts` — the user's own compositions. Presets stay in
  code so the type system checks them against columns that exist.

Payload note: everything ships at once so a column picker never fetches. Measured, not assumed —
and **re-measured 2026-07-29, because the previous figure had gone stale**: a production
`/players?view=overview` is **172 KB gzipped**, not the 142 KB recorded when the catalogue held
89 columns. The RSC payload carries the data twice, once as HTML and once as hydration props.
`?view=fixtures` is 136 KB and `?view=defenders` 103 KB, so the view chosen matters more than the
column count. The three fixture-percentage columns added in 0025 account for **2.4 KB** of the
total: they hold one distinct value per club, so 11.3 KB raw compresses to 1.2 KB. Attribute
growth by measuring the columns you added rather than by subtracting from a remembered baseline —
that is how 2.4 KB nearly got blamed for 30 KB. Don't "optimise" without measuring the compressed
size first, and re-measure the baseline while you are there.

**A club's style is a measurement with an error bar, and two separate gates decide what may be
shown.** Migrations 0021/0022 + `components/team-style.tsx`. The rule that is easy to get wrong:
**reliability governs the league ORDERING, not whether an individual club can be named.** A metric
too noisy to rank (xGA and dead-ball share, both 0.49) still has clubs sitting five error bars
clear of the league, so `metric_rank` comes back null while `separated` stays true, and the page
prints the value and the sentence without the rank. Conflating the two silenced the axis that
answers "whose defenders are worth owning". Full reasoning in `docs/feat/trend-claims.md`;
the design rules in DESIGN.md §4.

Two numbers from it worth carrying around: **`rel(6)` is 0.13–0.48**, so any feature phrased as
"recent form" over six matches is about a third signal — that is why the trend layer only admits
changes of roughly ±50%. And **xGA is 0.49 over a full season**, which weakens `/teams` shading it
and the Defenders/Goalkeepers views ranking on xGC, and vindicates `fixture_difficulty` being
built on Elo. Nothing is hardcoded: the reliabilities are recomputed by the views as matches
accumulate, so the set of metrics that earn a rank should grow through the season.

**Recent form is the same shape as club style: a window, an error bar, and two gates.**
Migration 0027 + `components/player-form.tsx`. `core_insights_player_match.stats` already carries
per-match shots, box touches, chances created, big chances and the CBIT components for all 38
gameweeks — 11 168 of 11 168 appearances, zero empty — so the window needs **no cross-source join
and no `player_gw_stats`**. Four things that are load-bearing:

- **`tournament = 'prem'`.** 2 251 of 12 242 rows are European and cup matches, and without the
  filter "his last six league games" silently includes a Thursday Conference League tie.
- **Six *appearances*, not six gameweeks.** A player benched twice would otherwise have a window
  reaching back months.
- **The pool is the position.** Pooling positions inflates `rel(6)` for shots from **0.37
  (defenders) to 0.64** — the precision is borrowed entirely from the striker-versus-defender
  contrast. Every decomposition, rank and percentile partitions by `element_type`.
- **A zero-variance player is not "down on his season".** `abs(0) >= 2 * 0` is true, so a defender
  who never hit the DEFCON threshold and a midfielder with no shots all season were both flagged as
  having moved — **182 of 2 593 rows**, every one printing "down on his season". `separated`
  therefore requires `var_within > 0`, and `form_word` reads that boolean rather than recomputing
  the comparison, because two copies of it is how the badge and the sentence came to disagree.

Measured `rel(6)` within position (DEF/MID/FWD): **box touches 0.55/0.71/0.54** is the best
six-match attacking signal and was in neither allaboutfpl's vocabulary nor our catalogue; CBIT
0.65/0.70/0.55; minutes 0.63/0.73/0.79; **big chances 0.11/0.15/0.25**, which is one of
allaboutfpl's three headline captaincy metrics and cannot carry a six-match rank. Big chances stays
registered rather than deleted — the gate excludes it on the *measured* number, so a fuller season
can promote it without a migration.

**A player is rendered by `components/player-identity.tsx`, everywhere.** Five copies existed —
dashboard, captain panel, table cell, search result, gems card — and they disagreed about spacing,
about whether the name was a link, and about whether a club crest appeared. Three rules live in
the component so no call site can drift: identity is always a link (which is what stopped
`/`, `/gems`, `/teams` and `/prices` being dead ends), the fixture reads `v OPP` / `@ OPP` with
the word `blank` for no fixture, and tables pass `wrap={false}` because a wrapping identity makes
row height depend on name length. Callers supply only slots. `components/team-badge.tsx` is the
crest, keyed on `teams.code` — **never `fpl_id`**, which is season-scoped and would repaint half
the league the day FPL renumbers.

**Never `title`. Tooltips go through `data-tip`** and the single delegated host in
`components/tooltip-host.tsx` — full contract in DESIGN.md §7. Three reasons, and the first is
the one that matters: `title` does not appear on keyboard focus in any browser, so every
explanation in the app was mouse-only. It also cannot be structured, and two tooltips on one
element means the browser draws its own over ours — so adding `data-tip` means removing `title`.
Static text goes in attributes (and `tipRows()` builds `data-tip-rows`, which is the only way a
**server** component gets a rich tooltip); anything with thousands of triggers registers a
resolver via `registerTipSource` instead, because `/players` has **8 445** tagged cells and
serialising their content would be megabytes. Two exceptions that are not bugs: `title` on an
`<img>`, and the `title` **prop** on `Panel`/`Section`, which never reaches the DOM.

Two traps this table hit, both found by rendering it and reading the result:

- **A sorting function cannot put nulls last in both directions.** TanStack inverts the
  comparator when descending, so "return 1 for null" is nulls-first descending. Use
  `sortUndefined: 'last'` and have the accessor return `undefined`, not `null`. The first
  render led Overview with a 1.1%-owned player on zero points.
- **A preset that sorts by a per-90 rate must bound the sample.** Finishers led with a player
  on two minutes and an npxG/90 of 3.29; the top five in the whole pool all fail
  `has_reliable_sample`.

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
- **ClubElo** — Tier 2, and the **primary forward-looking fixture-difficulty input**. The only
  source here that covers a fixture before it is played, and the only team metric that covers
  promoted clubs.
- **football-data.co.uk** — Tier 2. De-vigged closing odds. **Retrospective only**: `E0.csv`
  contains nothing but played matches, so it cannot price a future fixture. It serves as the
  *calibration target* for the Elo model instead — see `docs/DATA_SOURCES.md` §3.4.
- **Norsk Tipping (Oddsen)** — Tier 2, **no API key**, and the only source here that prices an
  *unplayed* fixture. `market_odds` (migration 0023) is **append-on-change** so price drift
  survives; liveness therefore comes from `sync_runs`, never `max(fetched_at)`, exactly as with
  `player_snapshots`. Two traps: the events window accepts **whole days only** — a `from` of
  `0001` or `1200` returns **204 for a window holding 135 events**, so 204 means both "empty"
  and "malformed", which is why the client takes `date` rather than `datetime`. And **market
  depth is per competition**: the Premier League's is unmeasured until 19–20 August because no
  PL fixture falls inside the ~15h deep-market window before then. Details in §3.5.
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
