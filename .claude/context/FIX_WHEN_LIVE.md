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
- [ ] **A brand-new player must not kill the capture.** `players` is written daily and the
      snapshot runs hourly, so for up to 24 hours a signing exists in bootstrap and not in
      `players`. That FK violation aborted the whole transaction and lost everyone's capture
      for 4h42m on 2026-07-27. `snapshot` now registers the identity itself — check
      `new_players` in its output during the window, and confirm `dimensions` then fills in
      birth_date, region and opta_code for them
- [ ] Count the hourly captures actually recorded: `select count(*) from sync_runs where
      job='snapshot' and status='ok' and started_at > now() - interval '7 days'` → expect ~231
      (33/day: hourly plus four an hour across the price window). **Materially fewer means the
      clock stopped and that time series is gone for good.**
- [ ] **The clock is pg_cron now, not GitHub — check it directly.** `select * from
      workflow_dispatch_health;` → `failed_24h = 0`, `pending` ≤ 2, `minutes_since_last` under
      ~65. A non-zero `failed_24h` names the cause in `last_error`; 401 is the token, 403 is a
      missing Actions:write permission. Before 0019 the only symptom of either was silence.
- [ ] **The PAT has an expiry and nothing warns you.** Confirm `github_actions_pat` in
      `vault.decrypted_secrets` still authenticates: `select dispatch_workflow('sync-snapshot.yml');`
      then `select collect_dispatch_results();` → `status_code = 204`. Renew with
      `vault.update_secret`. If it has lapsed, the 3-hourly GitHub backstop is all that has
      been running, at ~36% delivery.
- [ ] **Probe Norsk Tipping's Premier League market depth — 19–20 August, and this one decides
      the scope of two features.** `python scripts/probe/probe_sources.py norsktipping` and read
      the market list. Depth is per *competition*, not per lead time: Conference League
      qualifiers 4h out carried 8 markets while Brasil Serie A at 12h carried 46, and **no PL
      fixture falls inside the ~15h deep window before 21 August**, so this cannot be settled
      earlier. If `{Team} Totalt 0.5/1.5` and `{Team} holder nullen` appear, F4's three
      percentage columns become market-priced for the current gameweek and `holder nullen`
      replaces `exp(−λ_against)` for every goalkeeper and defender. If only HUB opens, we keep
      the Elo model and the ingest still earns its keep on 1X2 drift. Either way, `market_odds.
      markets` stores every market verbatim, so a name we failed to recognise costs a recogniser
      and not a re-fetch — and `prove_market_parse.py` has already ruled out the parser
- [ ] **Norsk Tipping capture is unbroken through the month.** `select count(*),
      count(distinct external_event_id), max(fetched_at) from market_odds;` — **there is no
      history endpoint, so a gap here is permanent**, exactly like `player_snapshots`. Note the
      liveness trap: append-on-change means a frozen market writes no rows, so read `sync_runs`
      for the job's health and never `max(fetched_at)`
- [ ] `select * from market_odds_check;` → every boolean true. Most are gated on markets that do
      not open until ~15h before kickoff, so **read the `*_rows` counts beside them**: on
      2026-07-29 `with_team_totals_rows` and `cs_cross_check_rows` were both 0, which makes those
      two booleans vacuous. `clean_sheet_agrees_with_scores` is the one worth waiting for — it
      cross-checks two separately-priced markets against each other
- [ ] `select jobname, schedule, active from cron.job;` → all five active. A Supabase project
      that pauses (7 days idle on the free tier) stops pg_cron with it; hourly traffic should
      prevent that, but check rather than assume.
- [ ] Actions minutes: `select * from workflow_dispatch_load;` projects ~1020/month from
      snapshots alone against a 2000 free-tier private-repo ceiling, with ~400 more from the
      other workflows. Compare against Settings → Billing, which the REST API will not report
      without a user-scoped token. **If it is close, thin the daytime hours in `cron.job` — not
      the price window.**
- [ ] Storage still well under 500 MB — `verify` prints the total
- [ ] `python scripts/probe/probe_sources.py` → only Sofascore BLOCKED, nothing FAILED
- [ ] All five workflows still enabled in the Actions tab (GitHub disables schedules after 60
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
- [ ] **`entry/{id}/event/1/picks/` stops 404-ing** — the one path in `sync/jobs/manager.py` the
      frozen data cannot reach. `python -m sync.cli manager --dry-run` → `detail.picks` carries
      `players: 15` instead of `available: false`. Until this hour, `entry_picks_optional`'s
      success branch has never executed. Checked 2026-07-29: this is also the *only* free route to
      the squad — `my-team/{id}/` is 403 without a session cookie, `users.premierleague.com` no
      longer resolves, and login is PingOne with no third-party client. See LATER.md §10; a "my
      team" page is unblocked from this moment with no auth work.

## 3. The first price change — the night of 2026-08-21/22, ~01:00–03:00 UTC

FPL moves prices around 01:30 UK time. pg_cron dispatches four samples an hour across
00:00–02:59 UTC (`:02`, `:17`, `:32`, `:47`) specifically to bracket this.

**This night is the one real test of migration 0019.** Under GitHub's own scheduler this window
delivered 1 of 12 dispatches on 2026-07-28 — measured, not feared. If the new clock also misses
it, the first night of the labelled training set is gone and no amount of later sampling
recovers it. Check the mechanism *before* the numbers:

- [ ] `select * from workflow_dispatches where requested_at > '<tonight 00:00Z>' order by
      requested_at;` → **12 rows, every one `status_code = 204`**. This is the row count the
      whole migration exists to produce.
- [ ] `player_price_events` gets its **first rows ever** →
      `select * from player_price_events order by id limit 20`
- [ ] Direction is right: a player whose `now_cost` went up has a rise event, not a fall
- [ ] The four-an-hour captures actually ran → `select distinct captured_at from
      player_snapshots where captured_at::time between '00:00' and '03:00' order by 1`.
      Insert-on-change means a quiet quarter-hour writes nothing, so a missing instant here is
      only a gap if `workflow_dispatches` also lacks its 204 — compare the two, don't infer.
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
- [ ] **`target_check.null_when_blank` currently reads NULL, not true.** `bool_and` over an
      empty set is NULL, and no club blanks in GW1 — so the assertion that a blanking player
      has no fixture rank has never actually been evaluated. It becomes real at the first
      blank; until then treat it as unproven, not as passing
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
      (`element_types.defcon_threshold`). ~~Build from `player_gw_stats`~~ — **not blocked, and
      this item was in the wrong section. Measured 2026-07-29: `core_insights_player_match.stats`
      already carries per-match `clearances`, `blocks`, `interceptions`, `tackles` and
      `recoveries` for 11 168 of 11 168 appearances, zero empty.** The 2025/26 hit rate on 60+
      minute league appearances is **DEF 24.1%, MID 13.7%, FWD 0.2%** — so DEFCON is irrelevant
      for forwards, and keepers must be excluded (FPL awards them none; a CBIT count for a
      keeper is an artifact). It is also the *most* reliable six-match signal measured,
      `rel(6) = 0.65` for defenders, beating every attacking metric. **Built 2026-07-29** in
      migration 0027 as `defcon_hit` — a per-match 0/1 whose mean is the hit rate. What remains
      for this section is the *current* season's version once it has six league games of its own
- [ ] Reliability floor makes sense again — enough minutes accrued that percentiles mean
      something
- [ ] **Switch the captain model to a rolling six-gameweek window.** *(The window itself shipped
      2026-07-29 as `player_form_metric`; what is left is wiring `captain_picks` to read it.)* ~~`player_shot_profile` and
      `captain_picks` are whole-season today because `player_gw_stats` is empty~~ — **wrong, and
      corrected 2026-07-29.** The window needs no FPL per-match data at all:
      `core_insights_player_match` holds per-match shots, box touches, xG, xA and minutes for all
      38 gameweeks of 2025/26, on one table, with no cross-source join. Built in F7 as
      `basis = 'last_6_2025_26'`. **Two measured constraints that came with it:** rank on box
      touches (`rel(6)` 0.55/0.71/0.54 for DEF/MID/FWD) rather than big chances (0.11/0.15/0.25 —
      a rare-event count, mostly noise over six matches), and compute every percentile **within
      position**, because pooling inflates `rel(6)` by about half. Filter `tournament='prem'` or
      the window silently mixes in European and cup matches — 2 251 of 12 242 rows.
- [ ] **Replace `minutes_security` with a real minutes model.** Starts-per-appearance is a
      preseason stand-in, and `cume_dist` puts every full-time starter at 1.000, so the component
      currently discriminates almost nothing. ~~Per-match minutes from `player_gw_stats`~~ —
      **also already available** in `core_insights_player_match`, and minutes turn out to be the
      second most reliable six-match signal measured (`rel(6)` 0.63–0.79). So the weakest term in
      any projection has a much better estimator available today than the one in place. The
      estimator now exists — `player_form_metric` where `metric = 'minutes'` — so this item is
      down to replacing the component inside `captain_picks`.
- [ ] **Confirm the soccerdata enum repair still fires.** `verify` fails if `situation` or
      `body_part` goes NULL, but check `shot_attribute_repair` in the understat job output:
      `situation_filled` should be ~92 per season and `body_part_filled` ~1 800. If both drop to
      0 *and* no NULLs appear, soccerdata has fixed its mapping and the repair is a harmless
      no-op. If both drop to 0 *and* NULLs appear, the raw cache layout changed.
- [ ] **Validate, do not refit, the Elo model.** ~~Once `2627/E0.csv` exists~~ — **no longer
      blocked on that, from GW1.** football-data publishes only played matches, which is why this
      waited; Norsk Tipping prices *unplayed* ones, so `fixture_difficulty.p_win` can be compared
      against `market_odds.p_home` on ten fixtures a week, continuously, from the first gameweek.
      Track the Spearman weekly rather than once. `2627/E0.csv` remains the *refit* source —
      `calibrate_elo_fixtures.py` refuses under 100 matches (~GW10) by design, and 30 matches
      would be worse than last season's 272 — but validation no longer has to wait for it
- [ ] Physical data coverage — was 144 of 12 242 rows (1.2%) and behind `nullif`. Recheck
      before building anything on it
- [ ] **Move the target minutes floor onto this season.** `player_target_base` gates at 25% of
      *last* season's minutes and ranks on the same figure, which is a stand-in with a known
      failure: a player who was a bit-part last year and is a nailed starter now is penalised,
      and vice versa. Once `player_gw_stats` has a few rounds, read minutes from there. The
      floor exists because without it a backup keeper on 540 minutes ranked first on `/gems`
- [ ] Promoted clubs now have `team_style` rows → `team_style` covers 20 of 20, the
      promoted banner on `/teams` disappears by itself, and the opponent note on `/gems` stops
      reading "of 17" and "promoted, no top-flight record"
- [ ] **Recompute the style reliabilities and see which metrics earn a rank.** Run
      `python scripts/probe/prove_style_claims.py`, then `select * from team_style_reliability`.
      `rel(k)` rises with k, so as this season's matches accumulate the set of metrics with
      `rank_earned = true` should **grow** past the six it holds today. **If it does not, that is
      a finding, not a non-event** — it would mean the 2025-26 figures were an unusually clean
      season rather than a property of the metrics. The two candidates to watch are expected goals
      conceded and dead-ball share, both at 0.49; a move above 0.60 makes their ranks appear on
      `/team/[code]` with no code change, and the *"varies, but clear of the league"* wording will
      stop appearing on its own. Nothing is hardcoded — this is a reading, not an edit
- [ ] **The style section switches basis, and the trend layer wakes up.** `team_style_metric`
      reads `stats_season`, so it keeps describing 2025-26 until `season_context` moves. Check
      that the club page's "How they play" note names the season the numbers actually come from,
      and that `team_trend`'s `basis` flips to `in_season` only once a club has 20 matches —
      `trend_check.premature_in_season` must stay 0 throughout. Until then the honest current
      signal is the Elo drift, which is the one thing on that page that is about now
- [ ] **The 30-day Elo drift starts moving.** It is exactly 0.0 for all 20 clubs in preseason
      because ClubElo carries a rating forward when nobody plays, so `notable_30` is false for
      everyone. Once matches resume, confirm `team_elo_drift.notable_30` picks up a handful of
      clubs rather than all 20 (the threshold is ≥3% on expected goals, which is 25 Elo). If
      everyone is notable, the threshold is too tight for in-season volatility
- [ ] **Opponent Elo coverage becomes complete.** Today 102 of 646 club-matches have no opponent
      Elo, because last season's relegated clubs have no `teams.code`. Within 2026-27 every
      opponent is in `teams`, so `team_trend.window_opp_missing` should reach 0 and the
      opposition control should start appearing on more claims. While it is non-zero the control
      is deliberately withheld, since the unrated opponents are exactly the weak ones
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

### `/player/[code]` and `/team/[code]`

- [ ] **The style section's rank column and reliability column still agree.** A rank must appear
      only where the reliability supports it. `style_check.unreliable_never_ranked` and
      `reliable_always_ranked` cover both directions, but eyeball one club too: an em dash in the
      rank column beside *"varies match to match"* is correct, and an em dash beside *"holds all
      season"* is a bug
- [ ] **The read sentence and the position hint still agree.** `style_check.hint_traces_to_summary`
      asserts every printed hint comes from a clause printed in the same sentence — this failed
      once already, with Tottenham reading "creates little and rarely plays through the opponent
      box → Defenders and target men", where the recommendation came from a claim the sentence
      never showed
- [ ] **A club with no separated axis still says so.** Three clubs get the empty state today
      ("a mid-table style in every direction is a real answer"). If that count goes to zero, gate 2
      has loosened; if it goes to twenty, something has broken in `separated`
- [ ] **Shot map dot count equals the shot count above it.** The frame is adaptive because a
      fixed crop silently dropped seven shots taken from beyond 60 m while still counting them
- [ ] Own goals stay out of the map and out of `player_shot_profile`. Understat files them
      against the defender at his own goal line, so `profile_check.own_goals_leaked` must be 0
      and `min_x` must stay near 0.30, not 0.005
- [ ] The two empty states stay distinct: **"No shots taken"** for a mapped player with none,
      **"Not measurable"** for one Understat never saw. Check a goalkeeper and a promoted-club
      signing
- [ ] `player_career.is_current_season` becomes true for someone. It is 0 rows today because
      in preseason `stats_season` equals a season `history_past` already has, so the union's
      second branch has **never fired** — untested, not passing
- [ ] Club standings still coherent: `profile_check.position_matches_style` true, and
      `worst_position` equals the number of clubs with style data. This derives last season's
      table from `team_style.points` because `team_seasons` only ever holds the season being
      synced — the first draft told the reader Arsenal had no record directly above its 71 goals
- [ ] After promotion data arrives, `worst_position` should reach 20 and the promoted banner
      should disappear on its own

- [ ] **Percentiles still mean something once the season resets.** After GW1 the pool collapses
      to whoever clears the reliability floor, so `percentile_check.smallest_quotable_pool` will
      fall and `not_quotable` will rise. Watch that the profile degrades to "not ranked" rather
      than quoting a percentile out of a pool of six
- [ ] `percentile_check.tie_inflated_metrics` stays 0. Early in the season almost everything
      ties at zero, which is exactly when the mid-rank fix earns its place
- [ ] Spot-check one player against a public site. The pool and the floor are ours, so the
      numbers will not match anyone else's exactly — confirm the *ordering* agrees

### Connection budget

- [ ] **The Supabase session pooler allows 15 clients total, shared with the sync jobs.**
      `/players`, `/player/[code]` and `/team/[code]` are dynamic, so each warm Vercel instance
      holds up to `max: 3`. Saturating it makes the *hourly snapshot* fail — the one table with
      no backfill path — because someone was browsing. Seen locally on 2026-07-27 with several
      builds and preview servers running at once
- [ ] **Consider moving the web app to the transaction pooler** (port 6543 rather than 5432).
      It is built for exactly this shape — many short-lived serverless clients — where session
      mode is not. The sync jobs should stay on the session pooler
- [ ] Check `select count(*) from pg_stat_activity` under real traffic before deciding

### Search

- [ ] `⌘K` and `/` both open it; arrows and Enter navigate
- [ ] `profile_check.label_in_haystack` still true — every row findable by its own name
- [ ] Typing a club name puts the club above its players (the 10000 weight)
- [ ] A newly signed player is searchable within a day of FPL adding him

### `/players` (was `/scout`)

- [ ] **Sorting puts nulls last in BOTH directions on every numeric column.** Click each header
      twice. This is not hypothetical: the composed table shipped a first draft where descending
      sort put the null rows on top, and it took reading the screen to see it
- [ ] Every preset that sorts by a per-90 rate still bounds the sample — no two-minute cameo
      leading a view
- [ ] Custom views survive a catalogue change: retire a column from `lib/columns.ts`, reload a
      saved view that used it, and confirm the view still opens with that column skipped
- [ ] The catalogue audit is silent. `getPlayerWide` logs `[columns] … no matching column in
      player_wide` once per process if a key is mistyped — check the Vercel function logs
- [ ] Headed xG and team corner figures are still **null**, not 0, for unmapped players and
      promoted clubs. `player_wide_check.head_xg_unknown` and `team_corners_unknown` must both
      stay above zero until Understat covers everyone
- [ ] Payload still ~142 KB gzipped with in-season data. Measure, don't assume
- [ ] `/scout` still 308s to `/players?view=overview`

### `/scout`

- [ ] Percentile heatmaps spread across the full range, computed within position
- [ ] Sorting puts nulls last in **both** directions on every numeric column
- [ ] `new` badge only on players genuinely without a reliable sample
- [ ] xGC and Owned colours still inverted — lower is better
- [ ] Set-piece badges (P/F/C) match FPL's taker orders after any preseason change
- [ ] **Euro** column shows real cup and European minutes, and flags >25% as rotation risk
- [ ] Stale-sync chip appears if a job goes red — force it by pausing a workflow
- [ ] Still ~109 KB compressed with in-season data. Measure, don't assume

### `/gems` and the dashboard's "Players to target"

- [ ] Not empty (see the cold-start judgement in §4)
- [ ] Output is position-aware: no goalkeeper ranked on xGI, no keeper ranked on DEFCON
- [ ] The five component bars average to the headline score
- [ ] Ownership under 10% still holds as a differential filter once the crowd converges
- [ ] **Fixture is position-aware too** — keepers and defenders ranked on expected clean
      sheets, midfielders and forwards on expected goals for. `target_check` asserts this, but
      confirm on screen that a keeper's opponent note reads *create* and a forward's *concede*
- [ ] **A double gameweek stacks in the opponent chip** as `ARS, whu ×2`, and the summed xG
      and clean sheets reward it. A blank reads *blank gameweek* in warn colour and scores 0
      on the fixture axis — never a `0` that looks like a hard fixture
- [ ] **Every card still prints the minutes share in words.** A percentile hid a 540-minute
      backup keeper at rank 01 once, and hid Havertz on the captain panel before that. If this
      line ever disappears, the same class of fault returns invisibly
- [ ] The dashboard panel has **no** ownership gate — Haaland and Saka are allowed to appear —
      while `/gems` still has one. Confirm the two lists genuinely differ

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
