# Go-live test checklist

**GW1 deadline: 2026-08-21 17:30 UTC.**

Until then nothing is `finished`, no price moves, no gameweek transfer is counted, and
`element-summary.history` is empty — so a large part of this codebase has never executed
against the data shape it will run on for the next ten months.

The rule behind this list: **a code path the data cannot currently reach is untested, however
carefully it was written.** That is exactly how the fixture ticker shipped with incomparable
totals — `fixture_run` looked correct and had never once run mid-gameweek.

Baseline captured 2026-07-26, preseason: 558 players · 380 fixtures · 20 teams · 2 568
`player_season_totals` · 0 `player_gw_stats` · 0 `player_price_events` · 52 MB of 500 MB.

---

## 1. Before the deadline — 2026-08-21, up to 17:30 UTC

Everything here is checkable today; do it once more on the day, because a month of cron runs
will have happened in between.

- [ ] `python -m sync.cli verify` → **all checks passed**, no stale `'running'` rows
- [ ] `select * from sync_freshness;` → every job inside its cadence
- [ ] Snapshot series is unbroken across the whole month. `select * from snapshot_coverage;` →
      `minutes_since_last_run` under ~90, `covers_7d = true`
- [ ] Count the hourly captures actually recorded: `select count(*) from sync_runs where
      job='snapshot' and status='ok' and started_at > now() - interval '7 days'` → expect ~168.
      **Materially fewer means GitHub dropped runs and that time series is gone for good.**
- [ ] Storage still well under 500 MB — `verify` prints the total
- [ ] `python scripts/probe/probe_sources.py` → only Sofascore BLOCKED, nothing FAILED
- [ ] All four workflows still enabled in the Actions tab (GitHub disables schedules after 60
      days of repo inactivity)
- [ ] `/prices` shows ownership drift with real spread by now, and the 24h/7d cards read
      **Ready**

## 2. The deadline passes — 2026-08-21, 17:30–24:00 UTC

This is when the frozen half of the app comes alive. **Watch it live rather than the next
morning** — this hour is unrepeatable.

- [ ] `transfers_in_event` / `transfers_out_event` become non-zero →
      `select count(*) from player_movement where net_transfers_event <> 0`
- [ ] `/prices` — the **"Prices are frozen"** banner disappears on its own
- [ ] `/prices` — sort by *Most transferred in* and *Most transferred out*; both populate and
      the numbers are plausible against public FPL sites
- [ ] `price_change_percent` stops being 0 for everyone — FPL's own signal starts moving
- [ ] `/prices` default sort switches itself from *Most owned* to *Most transferred in*
      (driven by `covers24h`, so this should already have flipped earlier)
- [ ] `events` table: GW1 `is_current` flips → `select id, name, is_current, finished,
      deadline_time from events order by id limit 3`

## 3. The first price change — the night of 2026-08-21/22, ~01:00–03:00 UTC

FPL moves prices around 01:30 UK time. `sync-snapshot` samples every 15 minutes across
00:00–02:45 specifically to bracket this.

- [ ] `player_price_events` gets its **first rows ever** →
      `select * from player_price_events order by id limit 20`
- [ ] Direction is right: a player whose `now_cost` went up has a rise event, not a fall
- [ ] The 15-minute captures actually ran → `select distinct captured_at from
      player_snapshots where captured_at::time between '00:00' and '03:00' order by 1`
- [ ] `/prices` — **Δ£ start** column becomes non-zero for the movers
- [ ] Cross-check three risers and three fallers against a public price-change site. **This is
      the labelled training set for the price model — if it is wrong, the model is wrong.**

## 4. GW1 completes — 2026-08-24/25

The biggest shape change. Several things flip at once, so check them in this order.

- [ ] `fixtures.finished` becomes true → `select count(*) from fixtures where finished`
- [ ] **`element-summary.history` returns real rows.** Read one payload by hand and confirm
      every key `sync/jobs/history.py` reads is present with the assumed type — the field
      access is defensive `.get()` against a *guessed* shape and has never seen live data
- [ ] `player_gw_stats` populates → `select count(*), count(distinct player_code) from
      player_gw_stats`
- [ ] **`season_context.stats_season` flips** from `2025-26` to `2026-27` the moment any player
      has non-null minutes. Verify: `select * from season_context;`
- [ ] Every screen follows that flip without code changes — `/scout`, `/gems`, `/teams` all
      state `2026-27` in their provenance line
- [ ] **Judge whether the hard switch is right.** After one match the 450-minute reliability
      floor makes almost the whole pool `is_cold_start`, so `/scout` percentiles nearly all
      vanish and `/gems` may go empty. Decide then whether to blend last season in rather than
      switch outright. `select count(*) filter (where is_cold_start), count(*) from
      player_scout`
- [ ] Preseason carry-over has stopped: `verify`'s check for bootstrap rows filed under the
      current season *with minutes* has never fired, so its logic is unproven. Confirm
      `player_season_totals` now has a `2026-27` / `bootstrap` row set that is genuinely
      this season
- [ ] **Fixture ticker mid-gameweek** — the case that was only ever simulated. During the GW2
      weekend, with some matches played: `/teams` shows the *window is not the same size*
      banner, the `#` column differs between clubs, and short rows are flagged
- [ ] Ticker horizon has rolled forward by itself — first column is GW2, not GW1
- [ ] `fixture_run` rates stay comparable while totals diverge — `select fixtures,
      p_win_per_fixture, expected_wins from fixture_run order by fixtures`
- [ ] `player_gw_stats` gives real `tournament` attribution, so per-90 rates are not deflated
      by cup minutes → `select tournament, count(*) from core_insights_player_match group by 1`

## 5. First reschedule — whenever a cup tie forces one

- [ ] **Blank gameweek** renders as hatched `blank`, not as an easy fixture
- [ ] **Double gameweek** stacks two chips in one cell
- [ ] Both are called out in the prose line above the ticker
- [ ] `fixture_run` treats a double as two chances: `expected_wins` reflects both, and the
      per-fixture rate does not
- [ ] The `#` column shows 7 for a club with a double in the window

These are the last two unexercised render paths. To test before the calendar cooperates:
duplicate or delete a `fixtures` row inside a transaction, render, roll back.

## 6. After ~5 gameweeks

- [ ] **DEFCON per-match hit rate** — the biggest analytical gap. Per-90 averages hide
      consistency: a player at 9.8/90 who clears 10 most weeks is worth more than one at 11.0
      driven by two outliers. Thresholds are 10 for defenders, 12 for midfielders and forwards
      (`element_types.defcon_threshold`). Build from `player_gw_stats` and add it to `/scout`
- [ ] Reliability floor makes sense again — enough minutes accrued that percentiles mean
      something
- [ ] **Validate, do not refit, the Elo model.** Once `2627/E0.csv` exists, compare
      `fixture_difficulty.p_win` against the new season's de-vigged odds and confirm the
      Spearman is still ~0.92. `calibrate_elo_fixtures.py` refuses to refit under 100 matches
      (~GW10) by design, and 30 matches would be worse than last season's 272
- [ ] Physical data coverage — was 144 of 12 242 rows (1.2%) and behind `nullif`. Recheck
      before building anything on it
- [ ] Promoted clubs now have `team_style` rows → `team_style` covers 20 of 20, and the
      promoted banner on `/teams` disappears by itself
- [ ] Storage growth on trend for the season → the growth query in `docs/SYNC_PLAN.md` §8

## 7. End of season

- [ ] **Refit the fixture model** on 2026-27, ideally pooled with 2025-26 — the script takes a
      single `--season` today, so pooling needs a small change. Update both the constants and
      the fit numbers quoted in the header of migration 0007
- [ ] Backtest the price model against a full season of `player_price_events`
- [ ] Re-run every claim in `docs/DATA_SOURCES.md` §1 — sources die, and two already have

---

## Per-surface regression pass

Run this whole block once after GW1 and once after GW5. Each item is something that currently
*cannot* be wrong because the data is frozen.

### `/scout`

- [ ] Percentile heatmaps spread across the full range, computed within position
- [ ] Sorting puts nulls last in **both** directions on every numeric column
- [ ] `new` badge only on players genuinely without a reliable sample
- [ ] xGC and Owned colours still inverted — lower is better
- [ ] Set-piece badges (P/F/C) match FPL's taker orders after any preseason change
- [ ] **Euro** column shows real cup and European minutes, and flags >25% as rotation risk
- [ ] Stale-sync chip appears if a job goes red — force it by pausing a workflow
- [ ] Still ~109 KB compressed with in-season data. Measure, don't assume

### `/gems`

- [ ] Not empty (see the cold-start judgement in §4)
- [ ] Output is position-aware: no goalkeeper ranked on xGI, no keeper ranked on DEFCON
- [ ] The three component bars sum sensibly to the headline score
- [ ] Ownership under 10% still holds as a differential filter once the crowd converges

### `/teams`

- [ ] Ticker: all three lenses re-colour cells *and* swap the summary metric
- [ ] `ARS` home / `ars` away casing correct against the real calendar
- [ ] Tooltips: win %, xG/xGA, clean sheet, and FPL's own rating for comparison
- [ ] PPDA still ranks the pressing sides where the eye test says they belong
- [ ] Style table switches to in-season data via `season_context`

### `/prices`

- [ ] Coverage cards accurate — instants, span, last **run** (not last change)
- [ ] Stale-job banner fires when the snapshot job actually stalls. Force it by disabling
      `sync-snapshot` for three hours
- [ ] The three kinds of absent stay distinct: `—` no value, hatching not ranked, `·` not
      observed long enough. **A `0` where `·` belongs is the failure mode here**
- [ ] All six sort modes populate
- [ ] **Net 24h** matches the net of `transfers_in_event` movement over the same span — this
      column exists only because we capture hourly and no FPL endpoint exposes it

### Sync and infra

- [ ] All four workflows green, and check `sync-enrich` specifically — it has never run on
      schedule, only locally
- [ ] `sync-enrich` deliberately has **no soccerdata cache**; confirm Understat row counts are
      full and not a stale partial snapshot
- [ ] Identity matching after the transfer window: re-run `python -m sync.cli understat
      --rematch` and check `player_external_ids` count and `unmatched_names`. Mappings are
      sticky, so stored mistakes survive otherwise
- [ ] `prove_player_matching.py` still 44/44 after any squad churn
- [ ] Sofascore still blocked from Actions — if its 116 per-player stats turn out to matter,
      that needs a self-hosted runner or a local cron

## Still blocked on you

- [ ] **Mini-league effective ownership** needs the league id from
      `https://fantasy.premierleague.com/leagues/XXXXXX/standings/c`. This is the feature
      Fantasy Football Fix structurally cannot provide — it computes EO against the global
      top-10k, not against the ten or twenty squads you are actually trying to beat
- [ ] **Deploy to Vercel** with `DATABASE_URL` set to the session pooler host
- [ ] **Visual design review.** Every screen has been verified by asserting on rendered HTML,
      never by looking at it. Spacing, weight and contrast are unaudited. Eight of the ten open
      questions in [DESIGN.md](DESIGN.md) §9 are independent of the season; the diverging colour
      ramp and the landing page want in-season data to judge
