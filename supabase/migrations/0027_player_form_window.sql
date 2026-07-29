-- ---------------------------------------------------------------------------
-- 0027 — recent form as a measurement, with the same two gates as 0021
--
-- Recency is the one axis allaboutfpl's method has that ours does not: every number of theirs is
-- a rolling last-4-to-6-game window, ours are season totals. This adds the window — and,
-- following 0021, adds it as a *measurement with an error bar* rather than as a fact.
--
-- WHAT WAS BLOCKING THIS, AND WHY IT WAS NOT
-- `FIX_WHEN_LIVE.md` deferred the rolling window to "after ~5 gameweeks, once `player_gw_stats`
-- fills", and `docs/feat/allaboutfpl-learnings.md` §4 proposed joining `understat_shots` to
-- `fixtures` on kickoff, calling that join "the risk in this feature". Both are wrong, measured
-- 2026-07-29:
--
--   - `fixtures` holds **only 2026/27**, so there is no 2025/26 calendar to join a shot to. That
--     join could not have worked at all.
--   - It is also unnecessary. `core_insights_player_match.stats` already carries per-match
--     `total_shots`, `touches_opposition_box`, `big_chances_missed`, `chances_created` and the
--     CBIT components, and the table has `event`, `minutes_played`, `xg` and `xa` natively —
--     **11 168 of 11 168 appearances populated, zero empty**. One table, no cross-source join.
--
-- `tournament = 'prem'` is not optional. The table holds 12 242 rows of which **2 251 are
-- European and cup** matches; without the filter a "last six league games" window silently mixes
-- in a Thursday Conference League tie.
--
-- THE WINDOW IS SIX APPEARANCES, NOT SIX GAMEWEEKS
-- A striker who was benched twice would otherwise have a "last six" stretching back three months.
-- `minutes_played > 0` is the denominator, which is what §4 of the research doc correctly warns
-- about — it just located the difficulty in the wrong place.
--
-- TWO GATES, AS IN 0021, AND THEY ANSWER DIFFERENT QUESTIONS
--   - `reliability_6` governs whether the **position may be ordered** on a six-match figure.
--   - `separated` governs whether **this player's form has actually moved** — |window − season|
--     against his own standard error. A metric too noisy to rank can still show a player two
--     error bars clear of his own season, and that is the more useful claim anyway: the question
--     a manager has is "is he different lately", not "who is 7th at this over six games".
--
-- THE POOL IS THE POSITION. THIS IS THE ONE THING EASY TO GET WRONG.
-- Measured: pooling all positions inflates `rel(6)` for shots from **0.37 (defenders) to 0.64**.
-- The apparent precision is borrowed entirely from the striker-versus-defender contrast, which no
-- manager needs a model to tell them about. So every decomposition, rank and percentile below
-- partitions by `element_type`. Same lesson as 0021's two gates: reliability is a property of the
-- pool being ordered, not of the metric.
--
-- WHAT THE MEASUREMENT SAID, AND WHY NOTHING IS HARDCODED FROM IT
-- Within position, `rel(6)` on 2025/26 (DEF / MID / FWD):
--
--     box touches      0.55  0.71  0.54     <- the best six-match attacking signal there is
--     CBIT             0.65  0.70  0.55
--     minutes          0.63  0.73  0.79
--     chances created  0.45  0.59  0.37
--     shots            0.37  0.54  0.45
--     xG               0.27  0.51  0.47
--     xA               0.38  0.51  0.27
--     big chances      0.11  0.15  0.25     <- one of allaboutfpl's three headline metrics
--
-- Two consequences. **Box touches is the metric to rank on**, and neither allaboutfpl nor our own
-- catalogue had it. And **big chances cannot carry a six-match rank** — it is a rare-event count,
-- so a six-match total is mostly Poisson noise. It is still registered below rather than deleted:
-- the gate excludes it on the measured number, so if a fuller season ever makes it reliable it
-- earns its rank without a migration. That is 0021's rule — the reliabilities are recomputed as
-- matches accumulate, never stored as constants.
--
-- COVERAGE, WHICH IS THE HONEST CAVEAT
-- 360 of 563 registered players have six league appearances in 2025/26; 203 do not. Those are the
-- new signings and the three promoted clubs — precisely the players a manager is least sure about
-- in preseason. Their window is **absent, and must render as unknown rather than as low**.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- window_metric — the registry
-- ---------------------------------------------------------------------------
drop view if exists window_metric cascade;
create view window_metric as
select * from (values
  --  metric          sort  label                      short    dir     dec  pct    positions
  ('box_touches',      1, 'Touches in the box',      'Box',    'high', 1, false, '{2,3,4}'::int[]),
  ('shots',            2, 'Shots',                   'Sh',     'high', 1, false, '{2,3,4}'::int[]),
  ('xg',               3, 'Expected goals',          'xG',     'high', 2, false, '{2,3,4}'::int[]),
  ('xa',               4, 'Expected assists',        'xA',     'high', 2, false, '{2,3,4}'::int[]),
  ('chances',          5, 'Chances created',         'Ch',     'high', 1, false, '{2,3,4}'::int[]),
  ('big_chances',      6, 'Big chances missed',      'BCM',    'high', 1, false, '{3,4}'::int[]),
  -- CBIT and the DEFCON hit are meaningless for goalkeepers: FPL awards them no defensive
  -- contribution at all, which is why `element_types.defcon_threshold` is null for GKP.
  ('cbit',             7, 'Defensive actions',       'CBIT',   'high', 1, false, '{2,3,4}'::int[]),
  -- `as_percent`, and it is not cosmetic. This is a mean of zeros and ones, so at 0 decimals
  -- Botman's genuine 1.00-against-0.36 rendered as "1" against "0" — which claims he went from
  -- never hitting the threshold to always, a different and wrong statement. A rate has to be
  -- shown as a rate.
  ('defcon_hit',       8, 'Hit the DEFCON threshold','DC hit', 'high', 0, true,  '{2,3,4}'::int[]),
  -- Minutes last, and deliberately included: it is the second most reliable six-match signal
  -- measured, and it is the weakest term in every projection. `minutes_security` today is
  -- starts-per-appearance, which cume_dist pins at 1.000 for every full-time starter.
  ('minutes',          9, 'Minutes',                 'Mins',   'high', 0, false, '{1,2,3,4}'::int[])
) as v(metric, sort_order, label, short_label, direction, decimals, as_percent, positions);

-- ---------------------------------------------------------------------------
-- player_match_metric — long form, one row per player per league match per metric
-- ---------------------------------------------------------------------------
-- Long rather than wide for the same reason 0018 gave: one decomposition expression serves every
-- metric instead of one per column.
drop view if exists player_match_metric cascade;
create view player_match_metric as
with app as (
  select
    m.season, m.player_code, m.event, m.match_id, m.minutes_played, m.xg, m.xa, m.stats,
    ps.element_type,
    et.defcon_threshold,
    -- Appearance order, newest first. This is what makes "last six" mean six appearances.
    row_number() over (partition by m.player_code order by m.event desc) as recency
  from core_insights_player_match m
  join player_seasons ps
    on ps.player_code = m.player_code
   and ps.season = (select current_season from season_context)
  join element_types et on et.id = ps.element_type
  where m.season = (select stats_season from season_context)
    and m.tournament = 'prem'
    and m.minutes_played > 0
    and m.stats ? 'total_shots'
)
select season, player_code, element_type, event, match_id, recency, metric, value from app,
lateral (values
  ('box_touches', (stats->>'touches_opposition_box')::numeric),
  ('shots',       (stats->>'total_shots')::numeric),
  ('xg',          xg::numeric),
  ('xa',          xa::numeric),
  ('chances',     (stats->>'chances_created')::numeric),
  ('big_chances', (stats->>'big_chances_missed')::numeric),
  ('cbit',        ((stats->>'clearances')::int + (stats->>'blocks')::int
                 + (stats->>'interceptions')::int + (stats->>'tackles')::int)::numeric),
  -- The FPL threshold, per match, as 0 or 1 — so the mean is the hit *rate*. Defenders count
  -- CBIT alone; midfielders and forwards add recoveries. Null for keepers, who get none.
  ('defcon_hit',  case when defcon_threshold is null then null
                       when element_type = 2 then
                         (((stats->>'clearances')::int + (stats->>'blocks')::int
                         + (stats->>'interceptions')::int + (stats->>'tackles')::int)
                          >= defcon_threshold)::int::numeric
                       else
                         (((stats->>'clearances')::int + (stats->>'blocks')::int
                         + (stats->>'interceptions')::int + (stats->>'tackles')::int
                         + (stats->>'recoveries')::int) >= defcon_threshold)::int::numeric
                  end),
  ('minutes',     minutes_played::numeric)
) as v(metric, value)
where value is not null;

-- ---------------------------------------------------------------------------
-- player_form_metric — the window, its error bar, and whether it has moved
-- ---------------------------------------------------------------------------
drop view if exists player_form_metric cascade;
create view player_form_metric as
with per_player as (
  select
    season, player_code, element_type, metric,
    count(*)                                              as appearances,
    avg(value)                                            as season_mean,
    var_samp(value)                                       as var_within,
    avg(value) filter (where recency <= 6)                as window_mean,
    count(*) filter (where recency <= 6)                  as window_matches
  from player_match_metric
  group by season, player_code, element_type, metric
  -- Twelve appearances to estimate a player's own within-match variance. Below that the error
  -- bar is itself too noisy to gate on, and 0021 applied the same reasoning at 20 club-matches.
  having count(*) >= 12 and count(*) filter (where recency <= 6) = 6
),
-- The decomposition, PER POSITION. See the header: pooling inflates rel(6) for shots from 0.37
-- to 0.64 by borrowing the striker-versus-defender contrast.
decomp as (
  select
    season, element_type, metric,
    count(*)                                                    as pool,
    avg(appearances)                                            as matches_per_player,
    avg(season_mean)                                            as position_mean,
    avg(var_within)                                             as var_within,
    greatest(var_samp(season_mean) - avg(var_within) / avg(appearances), 0) as var_between
  from per_player
  group by season, element_type, metric
),
joined as (
  select
    p.season, p.player_code, p.element_type, p.metric,
    p.appearances, p.season_mean, p.window_mean, p.window_matches,
    -- The standard error of a SIX-match mean, which is the figure being shown. Not the season's.
    sqrt(p.var_within / 6)                                            as window_std_error,
    -- Gate 2, defined ONCE. `form_word` reads this rather than restating the arithmetic, because
    -- the first draft computed the comparison in both places and they disagreed on the edge case
    -- below — which is how a boolean and the sentence beside it end up contradicting each other.
    --
    -- **`var_within > 0` is not a formality.** A player whose figure never varies has
    -- var_within = 0, so std_error = 0 and delta = 0, and `abs(0) >= 2 * 0` is TRUE. That marked
    -- **182 of 2 593 rows** as having moved and printed "down on his season" for a defender who
    -- had never once hit the DEFCON threshold and a midfielder who had taken no shots all season.
    -- Nothing changed, and there was nothing there to change.
    (p.var_within > 0
       and abs(p.window_mean - p.season_mean) >= 2 * sqrt(p.var_within / 6))  as separated,
    d.pool, d.position_mean, d.var_between, d.var_within as pool_var_within,
    -- Reliability of a six-match figure: the measured noise projected to n = 6. This is the
    -- number the gate uses, because six matches is what the column contains.
    d.var_between / nullif(d.var_between + d.var_within / 6, 0)       as reliability_6,
    -- The season figure's reliability, for context: it is what a full-season column would earn.
    d.var_between
      / nullif(d.var_between + d.var_within / d.matches_per_player, 0) as reliability_season,
    wm.label, wm.short_label, wm.direction, wm.decimals, wm.as_percent, wm.sort_order,
    rank() over (
      partition by p.season, p.element_type, p.metric order by p.window_mean desc
    )                                                                 as raw_rank,
    cume_dist() over (
      partition by p.season, p.element_type, p.metric order by p.window_mean
    )                                                                 as raw_percentile
  from per_player p
  join decomp d
    on d.season = p.season and d.element_type = p.element_type and d.metric = p.metric
  join window_metric wm on wm.metric = p.metric
  where p.element_type = any(wm.positions)
    -- A pool of five players cannot be ranked and its variance estimate is worthless.
    and d.pool >= 20
)
select
  j.season, j.player_code, j.element_type, j.metric,
  j.label, j.short_label, j.direction, j.decimals, j.as_percent, j.sort_order,
  j.appearances, j.pool,
  round(j.window_mean::numeric, 3)                                    as window_mean,
  round(j.season_mean::numeric, 3)                                    as season_mean,
  round((j.window_mean - j.season_mean)::numeric, 3)                  as delta,
  round(j.window_std_error::numeric, 4)                               as std_error,
  round(j.position_mean::numeric, 3)                                  as position_mean,
  round(j.reliability_6::numeric, 3)                                  as reliability_6,
  round(j.reliability_season::numeric, 3)                             as reliability_season,
  j.reliability_6 >= 0.60                                             as rank_earned,
  -- Gate 1: the position may be ordered on this metric over six matches.
  case when j.reliability_6 >= 0.60 then j.raw_rank end               as metric_rank,
  case when j.reliability_6 >= 0.60
       then round(j.raw_percentile::numeric, 3) end                    as percentile,
  -- Gate 2: THIS player's last six differ from his own season by more than two of his own
  -- standard errors. Independent of gate 1 by design — the axis 0021 nearly lost was exactly
  -- the one that fails gate 1 and passes gate 2. Computed in `joined`; see the note there.
  j.separated,
  case
    when j.window_std_error = 0 then null
    else round(((j.window_mean - j.season_mean) / j.window_std_error)::numeric, 2)
  end                                                                 as z,
  -- The sentence, driven by the same boolean rather than by a second copy of the comparison. A
  -- player who has not moved is "in line", including the flat-at-zero case that must never read
  -- as a decline.
  case
    when not j.separated then 'in line with his season'
    when j.window_mean > j.season_mean then 'up on his season'
    else 'down on his season'
  end                                                                 as form_word,
  'last_6_' || replace(j.season, '-', '_')                            as basis
from joined j;

-- ---------------------------------------------------------------------------
-- player_form_reliability — the decomposition on its own, per position per metric
-- ---------------------------------------------------------------------------
-- What FIX_WHEN_LIVE.md should re-read once the season provides its own matches, and what makes
-- the header's table checkable rather than a claim.
drop view if exists player_form_reliability cascade;
create view player_form_reliability as
select distinct
  season, element_type, metric, label, sort_order, direction,
  pool, reliability_6, reliability_season, rank_earned,
  round(sqrt(reliability_6 / nullif(1 - reliability_6, 0))::numeric, 2) as discrimination
from player_form_metric
order by sort_order, element_type;

-- ---------------------------------------------------------------------------
-- player_form — one row per player: the headline, for a page to read
-- ---------------------------------------------------------------------------
drop view if exists player_form cascade;
create view player_form as
with moved as (
  -- The strongest genuine movement per player, preferring metrics that earned a rank but not
  -- requiring one — the same precedence 0021's `team_style_read` lateral uses.
  select distinct on (player_code)
    player_code, metric, label, short_label, window_mean, season_mean, delta, z,
    form_word, rank_earned, metric_rank, pool, percentile
  from player_form_metric
  where separated
  order by player_code, rank_earned desc, abs(z) desc
)
select
  p.player_code,
  p.element_type,
  max(p.appearances)                                          as league_appearances,
  count(*)                                                    as metrics_measured,
  count(*) filter (where p.separated)                         as metrics_moved,
  count(*) filter (where p.rank_earned)                       as metrics_ranked,
  m.metric                                                    as lead_metric,
  m.label                                                     as lead_label,
  m.window_mean                                               as lead_window,
  m.season_mean                                               as lead_season,
  m.z                                                         as lead_z,
  m.form_word                                                 as lead_word,
  m.metric_rank                                               as lead_rank,
  m.pool                                                      as lead_pool,
  min(p.basis)                                                as basis
from player_form_metric p
left join moved m on m.player_code = p.player_code
group by p.player_code, p.element_type, m.metric, m.label, m.window_mean, m.season_mean,
         m.z, m.form_word, m.metric_rank, m.pool;

-- ---------------------------------------------------------------------------
-- form_check
-- ---------------------------------------------------------------------------
drop view if exists form_check cascade;
create view form_check as
select
  (select count(*) from player_match_metric)                          as metric_rows,
  (select count(distinct player_code) from player_match_metric)       as players_with_matches,
  (select count(*) from player_form)                                  as players_with_window,
  (select count(*) from player_form_metric)                           as form_rows,
  (select count(*) from player_form_reliability)                      as reliability_rows,

  -- The window is six appearances. Not five, not seven, and not six gameweeks.
  (select coalesce(bool_and(window_matches = 6), true) from (
     select count(*) filter (where recency <= 6) as window_matches
     from player_match_metric group by player_code, metric
     having count(*) >= 12) x)                                        as window_is_always_six,
  -- League only. A single European match inside a window would break this.
  (select count(*) from core_insights_player_match
    where tournament <> 'prem')                                       as non_league_rows_excluded,
  -- Joined on `match_id`, NOT on `(player_code, event)`. The first draft used the latter and
  -- came back false: a midweek European tie carries the *same* `event` as that gameweek's league
  -- match, so the join paired a league row here against the Champions League row there and read
  -- as a leak that does not exist. `match_id` identifies the fixture, which is what the
  -- assertion actually needs — and it is why `player_match_metric` carries the column.
  (select coalesce(bool_and(m.tournament = 'prem'), true)
     from core_insights_player_match m
     join player_match_metric p
       on p.match_id = m.match_id and p.player_code = m.player_code
      and p.season = m.season)                                        as window_is_league_only,

  -- Coverage, published rather than assumed. 203 players have no window and must read as unknown.
  (select count(*) from player_seasons
    where season = (select current_season from season_context))        as registered_players,
  (select count(*) from player_seasons ps
    where ps.season = (select current_season from season_context)
      and not exists (select 1 from player_form f
                       where f.player_code = ps.player_code))          as players_without_window,

  -- The pool is the position. If any decomposition spans two element_types this is false, and
  -- every reliability above it is inflated.
  (select coalesce(bool_and(n = 1), true) from (
     select player_code, metric, count(distinct element_type) n
     from player_form_metric group by 1, 2) x)                        as one_position_per_row,
  (select coalesce(bool_and(pool >= 20), true) from player_form_metric)
                                                                      as pool_floor_enforced,

  -- The two gates must be capable of disagreeing, or gate 2 is decoration. 0021's dead-ball
  -- share is the precedent: reliability 0.49, no rank, five unambiguous outliers.
  (select count(*) from player_form_metric where separated and not rank_earned)
                                                                      as moved_without_a_rank,
  (select count(*) from player_form_metric where rank_earned and not separated)
                                                                      as ranked_without_moving,

  -- Big chances must not earn a six-match rank on this data. Asserted as a *measurement*, not a
  -- hardcoded exclusion: if a future season makes it reliable, this flips and that is a finding.
  (select coalesce(bool_and(not rank_earned), true)
     from player_form_reliability where metric = 'big_chances')        as big_chances_unranked,
  (select round(max(reliability_6), 2) from player_form_reliability
    where metric = 'big_chances')                                     as big_chances_best_rel,
  -- Box touches was the measured winner. If it stops being the most reliable attacking metric,
  -- the header's reasoning needs revisiting rather than silently drifting.
  (select round(max(reliability_6), 2) from player_form_reliability
    where metric = 'box_touches')                                     as box_touches_best_rel,

  -- Arithmetic that must hold whatever the data does.
  (select coalesce(bool_and(abs(delta - (window_mean - season_mean)) < 0.002), true)
     from player_form_metric)                                          as delta_is_consistent,
  (select coalesce(bool_and(std_error >= 0), true) from player_form_metric)
                                                                      as errors_non_negative,
  (select coalesce(bool_and(reliability_6 between 0 and 1
                        and reliability_season between 0 and 1), true)
     from player_form_metric)                                          as reliabilities_in_range,
  -- A six-match figure can never be more reliable than the season it is drawn from.
  (select coalesce(bool_and(reliability_6 <= reliability_season + 0.002), true)
     from player_form_metric)                                          as six_never_beats_season,
  (select coalesce(bool_and(metric_rank is null), true)
     from player_form_metric where not rank_earned)                    as ungated_ranks_are_null,
  (select coalesce(bool_and(metric_rank between 1 and pool), true)
     from player_form_metric where metric_rank is not null)            as rank_within_pool,
  -- The DEFCON hit rate is a mean of zeros and ones, so it is a proportion by construction.
  (select coalesce(bool_and(window_mean between 0 and 1
                        and season_mean between 0 and 1), true)
     from player_form_metric where metric = 'defcon_hit')              as defcon_hit_is_a_rate,
  -- Keepers get no DEFCON, so they must be absent from that metric entirely rather than showing 0.
  (select count(*) from player_form_metric
    where metric in ('defcon_hit', 'cbit') and element_type = 1)       as keeper_defcon_rows,
  (select coalesce(bool_and(form_word in ('up on his season', 'down on his season',
                                          'in line with his season')), true)
     from player_form_metric)                                          as words_are_known,

  -- The zero-variance trap, asserted three ways because it produced 182 confident false claims
  -- before it was caught. A player whose figure never moved must not be described as having moved.
  (select count(*) from player_form_metric where std_error = 0)         as zero_variance_rows,
  (select coalesce(bool_and(not separated), true)
     from player_form_metric where std_error = 0)                      as flat_never_separated,
  (select coalesce(bool_and(not separated), true)
     from player_form_metric where delta = 0)                          as no_delta_never_separated,
  (select coalesce(bool_and(form_word = 'in line with his season'), true)
     from player_form_metric where delta = 0)                          as no_delta_reads_in_line,
  -- The boolean and the sentence must never disagree, which is what having two copies of the
  -- comparison caused. This is the assertion that keeps them one definition.
  (select coalesce(bool_and((form_word = 'in line with his season') = (not separated)), true)
     from player_form_metric)                                          as word_agrees_with_gate;
