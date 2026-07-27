-- ---------------------------------------------------------------------------
-- 0018 — a number nobody can read is not information
-- ---------------------------------------------------------------------------
-- Peder, on the player page: *"xGI/90 for Morgan Gibbs-White. That number does not tell me
-- damn shit, without context to other midfielders. So if the stat could tell me that he gets
-- on more shots during 90 minutes than 99% of other players, that tells me a whole lot."*
--
-- He is right, and the example proves itself. Gibbs-White reads 0.398 xGI/90, which is
-- unreadable. Against the 148 rankable midfielders:
--
--     shots per 90          88th percentile
--     shots in box per 90   88th
--     points per 90         89th
--     xGI/90                83rd
--     xA/90                 35th   <-- the interesting one
--
-- He shoots a lot and creates very little. No single raw figure says that, and the composite
-- xGI actively hides it by averaging the two halves together.
--
-- TALL, NOT WIDE. One row per player per metric rather than 32 more columns on `player_wide`.
-- Adding a metric is one line in the VALUES list, the profile page selects `where player_code
-- = $1`, and nothing has to change shape. 558 players x 32 metrics is ~15 000 rows, which is
-- nothing.
--
-- WHY IN SQL. lib/rank.ts computes percentiles in the browser, but only ever to decide how
-- green a cell is — a number with no consequence. These have one: they are printed in words,
-- reasoned about, and used to decide a transfer. CLAUDE.md's rule applies, so they live here
-- where `verify` can assert on them.
--
-- THE COMPARISON SET IS PART OF THE ANSWER. Within position, because a centre-back's xGI
-- against forwards is meaningless. And excluding `is_cold_start`, because "better than 99% of
-- midfielders" is worthless if the bottom 40% of that pool have played twenty minutes between
-- them. `pool_size` is published so the screen can name the set rather than implying "all of
-- them" — the same rule as every heat cell in DESIGN.md.
--
-- `higher_is_better` DUPLICATES `direction` in lib/columns.ts, and that is a real risk: if the
-- two disagree, a metric renders green while reading "worse than 90% of midfielders".
-- `auditPercentileDirections` in lib/queries.ts compares them at runtime and shouts.

drop view if exists player_metric_percentile cascade;
create view player_metric_percentile as
-- The fourth column is the element_types the metric means anything for, NULL for all of them.
-- Without it, `saves` was ranked across midfielders — every value 0, so all 148 tied at rank 1
-- and every one of them read "1st of 148 for saves". A percentile over a constant is not a
-- weak signal, it is a false one.
with unpivoted as (
  select
    w.player_code,
    w.position,
    m.metric,
    m.value,
    m.higher_is_better
  from player_wide w
  cross join lateral (values
    -- Returns and value
    ('total_points',               w.total_points::numeric,               true, null::int[]),
    ('points_per_90',              w.points_per_90::numeric,              true, null::int[]),
    ('points_per_million',         w.points_per_million::numeric,         true, null::int[]),
    ('xgi_per_million',            w.xgi_per_million::numeric,            true, null::int[]),
    ('goals_scored',               w.goals_scored::numeric,               true, null::int[]),
    ('assists',                    w.assists::numeric,                    true, null::int[]),
    ('bonus',                      w.bonus::numeric,                      true, null::int[]),
    ('bps',                        w.bps::numeric,                        true, null::int[]),
    ('defensive_contribution',     w.defensive_contribution::numeric,     true, null::int[]),
    ('clean_sheets',               w.clean_sheets::numeric,               true, '{1,2,3}'::int[]),
    ('saves',                      w.saves::numeric,                      true, '{1}'::int[]),
    ('goals_conceded',             w.goals_conceded::numeric,             false, '{1,2}'::int[]),
    -- Volume
    ('minutes',                    w.minutes::numeric,                    true, null::int[]),
    ('minutes_share',              w.minutes_share::numeric,              true, null::int[]),
    ('pct_minutes_outside_league', w.pct_minutes_outside_league::numeric,  false, null::int[]),
    -- Ownership. Low is the good end on a screen for finding differentials, which is the same
    -- direction lib/columns.ts declares.
    ('selected_by_percent',        w.selected_by_percent::numeric,        false, null::int[]),
    -- Rates
    ('xgi_per_90',                 w.xgi_per_90::numeric,                 true, null::int[]),
    ('xg_per_90',                  w.xg_per_90::numeric,                  true, null::int[]),
    ('xa_per_90',                  w.xa_per_90::numeric,                  true, null::int[]),
    ('xgc_per_90',                 w.xgc_per_90::numeric,                 false, '{1,2}'::int[]),
    ('defcon_per_90',              w.defcon_per_90::numeric,              true, null::int[]),
    ('bps_per_90',                 w.bps_per_90::numeric,                 true, null::int[]),
    -- Season expected totals
    ('expected_goals',             w.expected_goals::numeric,             true, null::int[]),
    ('expected_assists',           w.expected_assists::numeric,           true, null::int[]),
    -- Chance quality
    ('shots_per_90',               w.shots_per_90::numeric,               true, null::int[]),
    ('shots_in_box_per_90',        w.shots_in_box_per_90::numeric,        true, null::int[]),
    ('big_chances_per_90',         w.big_chances_per_90::numeric,         true, null::int[]),
    ('non_penalty_xg_per_90',      w.non_penalty_xg_per_90::numeric,      true, null::int[]),
    ('head_xg_per_90',             w.head_xg_per_90::numeric,             true, null::int[]),
    -- Creation
    ('understat_xa',               w.understat_xa::numeric,               true, null::int[]),
    ('xg_chain_per_90',            w.xg_chain_per_90::numeric,            true, null::int[]),
    ('xg_buildup_per_90',          w.xg_buildup_per_90::numeric,          true, null::int[])
  ) as m(metric, value, higher_is_better, applies_to)
  where not w.is_cold_start
    and m.value is not null
    and (m.applies_to is null or w.element_type = any(m.applies_to))
)
select
  u.player_code,
  u.metric,
  u.position,
  u.value,
  u.higher_is_better,
  -- MID-RANK, and neither of the two obvious choices.
  --
  -- `percent_rank` hands a tie group the rank of its FIRST member. That is how every full-time
  -- starter came out as "37th percentile" for minutes on the captain panel — tied at the top
  -- and reported near the bottom.
  --
  -- `cume_dist` is the share of rows at or *below*, which fails the same way in the other
  -- direction: 22 of 23 goalkeepers have exactly 0.000 xG/90, so every one of them read
  -- "96th percentile" for scoring. Measured before this fix, all 23 keepers sat in the
  -- notional top 10% for xG/90, DEFCON, goals scored and headed xG simultaneously.
  --
  -- The mid-rank percentile — (below + half of equal) / n — is the standard answer and is
  -- honest in both directions. Those 22 keepers become the median, which is exactly what
  -- being indistinguishable from 95% of your position means.
  round((
    ( (rank() over (
         partition by u.metric, u.position
         order by case when u.higher_is_better then u.value else -u.value end
       ) - 1)
      + 0.5 * count(*) over (partition by u.metric, u.position, u.value)
    ) / count(*) over (partition by u.metric, u.position)
  )::numeric, 4)                                                        as percentile,
  -- 1 = best. More concrete than a percentile at the top of the range: "3rd of 148" beats
  -- "98th percentile" when the reader wants to know whether anyone is better.
  rank() over (
    partition by u.metric, u.position
    order by case when u.higher_is_better then -u.value else u.value end
  )                                                                     as position_rank,
  count(*) over (partition by u.metric, u.position)                     as pool_size,
  -- Is this percentile worth putting into a sentence?
  --
  -- Two ways it is not. A pool under 12 makes every step worth eight points, and one
  -- goalkeeper had shot data at all — "1st of 1" is not a compliment. And a metric that does
  -- not vary within the position cannot rank anyone, which is the general form of the `saves`
  -- fault above: min = max means everybody is simultaneously first and last.
  (count(*) over (partition by u.metric, u.position) >= 12
   and min(u.value) over (partition by u.metric, u.position)
     < max(u.value) over (partition by u.metric, u.position))           as is_quotable
from unpivoted u;

-- ---------------------------------------------------------------------------
-- percentile_check
-- ---------------------------------------------------------------------------
drop view if exists percentile_check cascade;
create view percentile_check as
select
  count(*)                                                              as rows,
  count(distinct metric)                                                as metrics,
  count(distinct player_code)                                           as players,
  bool_and(percentile > 0 and percentile <= 1)                          as percentile_in_range,
  bool_and(position_rank between 1 and pool_size)                       as rank_in_pool,
  -- The best value must be rank 1 in both directions. If a lower-is-better metric inverts,
  -- the page will tell the reader the leakiest defence in the league is the tightest.
  (select bool_and(ok) from (
     select (position_rank = 1) = (value = min(value) over (partition by metric, position)) as ok
     from player_metric_percentile where not higher_is_better
   ) d)                                                                 as lower_better_ranked_right,
  (select bool_and(ok) from (
     select (position_rank = 1) = (value = max(value) over (partition by metric, position)) as ok
     from player_metric_percentile where higher_is_better
   ) d)                                                                 as higher_better_ranked_right,
  -- A pool of five is not a percentile worth printing. Goalkeepers are the smallest group, so
  -- this is the number to watch.
  count(*) filter (where not is_quotable)                               as not_quotable,
  min(pool_size) filter (where is_quotable)                             as smallest_quotable_pool,
  -- A metric that does not vary cannot rank anyone. If this stops being zero, some column has
  -- gone constant within a position and everyone in it is being told they are first.
  (select count(*) from (
     select metric, position from player_metric_percentile
     group by 1, 2 having min(value) = max(value)
   ) d)                                                                 as constant_metrics,
  -- The tie-inflation detector. A tenth of a pool can legitimately be in its top tenth; a
  -- third cannot. Before the mid-rank fix this found six metric/position pairs where *every*
  -- goalkeeper was simultaneously in the top 10%, all of them tied at zero.
  (select count(*) from (
     select metric, position
     from player_metric_percentile
     group by 1, 2
     having count(*) filter (where percentile >= 0.9) > 0.3 * count(*)
   ) d)                                                                 as tie_inflated_metrics,
  (select pool_size from player_metric_percentile
    where metric = 'xgi_per_90' and position = 'MID' limit 1)            as mid_xgi_pool
from player_metric_percentile;
