-- ---------------------------------------------------------------------------
-- 0041 — `is_cold_start` has to move with the floor, because it is a gate
-- ---------------------------------------------------------------------------
-- 0040 lowered the floor in `player_stats_season` and left `player_scout`'s four literals at
-- 450, on the reasoning that `is_cold_start` is a *label* — the players newly admitted would
-- still render with the cold-start treatment, which honestly marks a thin sample.
--
-- That reasoning was wrong, and measuring it is what showed why. `captain_picks` went from 0 to
-- 168 rows, but `target_players` and `hidden_gems` stayed at **0**, because
-- `player_target_base` opens with `where not s.is_cold_start` — and `hidden_gems` (0006),
-- `player_metric_percentile` (0018) and two earlier views do the same. `is_cold_start` is used
-- as a gate in five places, always alongside `has_reliable_sample`.
--
-- They are not two concepts. `gem_score_check` asserts it outright:
--
--     count(*) filter (where is_cold_start or not has_reliable_sample) as ineligible_are_null
--
-- so a player between 120 and 450 minutes — cold-start true, reliable-sample true, percentiles
-- non-null — would have made that check false. Splitting the floors does not weaken a label; it
-- breaks an invariant the schema already states. The two must stay in lockstep.
--
-- So `player_scout` is restated with all four of its literals reading the setting. It has to be
-- the whole view: Postgres cannot alter one expression, and `create or replace` demands the
-- full query. Columns and types are byte-for-byte the shape 0006 shipped, which is what makes
-- replace legal — this view is the root of roughly forty dependents across nine levels and a
-- cascade would drop every one of them.
--
-- The four sites, and what each one gates:
--   `xg_chain_per_90`, `xg_buildup_per_90`  Understat rates. Gate nothing, moved for consistency.
--   `xgi_per_million`                        a rate over price. Gates nothing.
--   `is_cold_start`                          the gate this migration exists for.
--
-- Everything else in here is 0006 verbatim. The percentile gates already read
-- `b.has_reliable_sample` and so followed the setting from 0040 onwards; that is why
-- `captain_picks` repopulated and these two did not.
-- ---------------------------------------------------------------------------

create or replace view player_scout as
with ctx as (select * from season_context),
floor as (select min_minutes_for_rates as m from analysis_settings),
base as (
  select
    st.season, st.player_code, st.web_name, st.first_name, st.second_name,
    st.birth_date, st.age, st.fpl_id, st.element_type, st.position,
    st.defcon_threshold, st.team_code, st.team_name, st.team_short, st.start_cost,
    st.penalties_order, st.direct_freekicks_order, st.corners_order,
    st.is_first_penalty_taker, st.state_as_of, st.now_cost,
    round(st.now_cost / 10.0, 1)                        as price,
    st.selected_by_percent, st.form, st.ep_next, st.status, st.news,
    st.chance_of_playing_next_round, st.is_available,
    st.cost_change_start, st.cost_change_event, st.price_change_percent,
    st.transfers_in_event, st.transfers_out_event, st.net_transfers_event,
    ctx.stats_season,
    ctx.season_started,
    s.minutes, s.starts, s.total_points, s.goals_scored, s.assists,
    s.clean_sheets, s.goals_conceded, s.saves, s.bonus, s.bps,
    s.expected_goals, s.expected_assists, s.expected_goal_involvements,
    s.expected_goals_conceded, s.defensive_contribution,
    s.xg_per_90, s.xa_per_90, s.xgi_per_90, s.xgc_per_90,
    s.points_per_90, s.defcon_per_90, s.bps_per_90,
    s.goals_minus_xg, s.assists_minus_xa,
    coalesce(s.has_reliable_sample, false)              as has_reliable_sample,
    u.xa            as understat_xa,
    u.xg_chain,
    u.xg_buildup,
    case when s.minutes >= f.m and u.xg_chain is not null
         then round(u.xg_chain * 90.0 / s.minutes, 3) end   as xg_chain_per_90,
    case when s.minutes >= f.m and u.xg_buildup is not null
         then round(u.xg_buildup * 90.0 / s.minutes, 3) end as xg_buildup_per_90,
    c.other_minutes, c.pct_minutes_outside_league,
    c.avg_distance_prem, c.top_speed_prem, c.matches_with_physical,
    case when st.now_cost > 0
         then round(s.total_points / (st.now_cost / 10.0), 2) end as points_per_million,
    case when st.now_cost > 0 and s.minutes >= f.m
         then round(s.expected_goal_involvements / (st.now_cost / 10.0), 3) end
                                                                 as xgi_per_million,
    (s.player_code is null or coalesce(s.minutes, 0) < f.m)       as is_cold_start
  from player_state st
  cross join ctx
  cross join floor f
  left join player_stats_season s
         on s.player_code = st.player_code and s.season = ctx.stats_season
  left join understat_player_season u
         on u.player_code = st.player_code and u.season = ctx.stats_season
  left join player_congestion c
         on c.player_code = st.player_code and c.season = ctx.stats_season
),
ranked as (
  select
    b.*,
    case when b.has_reliable_sample then round(percent_rank() over (
      partition by b.element_type order by b.xgi_per_90 nulls first)::numeric, 3) end
                                                      as xgi_per_90_percentile,
    case when b.has_reliable_sample then round(percent_rank() over (
      partition by b.element_type order by b.xg_per_90 nulls first)::numeric, 3) end
                                                      as xg_per_90_percentile,
    case when b.has_reliable_sample then round(percent_rank() over (
      partition by b.element_type order by b.xa_per_90 nulls first)::numeric, 3) end
                                                      as xa_per_90_percentile,
    case when b.has_reliable_sample then round(percent_rank() over (
      partition by b.element_type order by b.defcon_per_90 nulls first)::numeric, 3) end
                                                      as defcon_per_90_percentile,
    case when b.has_reliable_sample then round(percent_rank() over (
      partition by b.element_type order by b.points_per_90 nulls first)::numeric, 3) end
                                                      as points_per_90_percentile,
    case when b.has_reliable_sample then round(percent_rank() over (
      partition by b.element_type order by b.bps_per_90 nulls first)::numeric, 3) end
                                                      as bps_per_90_percentile,
    case when b.has_reliable_sample then round(percent_rank() over (
      partition by b.element_type order by b.saves nulls first)::numeric, 3) end
                                                      as saves_percentile,
    -- Conceded, so inverted: 1.0 is the best defensive record in the position.
    case when b.has_reliable_sample then round((1 - percent_rank() over (
      partition by b.element_type order by b.xgc_per_90 nulls last))::numeric, 3) end
                                                      as xgc_per_90_percentile,
    case when b.has_reliable_sample then round(percent_rank() over (
      partition by b.element_type order by b.points_per_million nulls first)::numeric, 3) end
                                                      as value_percentile,
    round((1 - percent_rank() over (
      partition by b.element_type order by b.selected_by_percent nulls first))::numeric, 3)
                                                      as differential_percentile
  from base b
)
select
  r.*,
  case
    -- Goalkeepers cannot score defensive-contribution points at all, so ranking them on it
    -- is noise. Expected goals conceded is what drives a keeper's return.
    when r.element_type = 1 then coalesce(r.xgc_per_90_percentile, 0)
    when r.element_type = 2
      then round(((coalesce(r.xgc_per_90_percentile, 0)
                 + coalesce(r.defcon_per_90_percentile, 0)) / 2.0)::numeric, 3)
    else coalesce(r.xgi_per_90_percentile, 0)
  end as output_percentile
from ranked r;
