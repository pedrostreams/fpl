-- 0005_view_fixes.sql — three problems the first real query session exposed.
--
-- Views are cheap to recreate, so these are corrections rather than workarounds.

-- ---------------------------------------------------------------------------
-- 1. player_congestion: physical data is ~1% populated, and 0 means "not measured"
-- ---------------------------------------------------------------------------
-- FPL-Core-Insights ships `distance_covered` and `top_speed` columns, and I recorded them
-- as a headline advantage ("physical data no other free source carries"). Measured against
-- the actual data that was overstated: for 2025/26 only **144 of 12 242 rows** carry a
-- non-zero distance and 281 a non-zero top speed — 1.2% coverage, absent entirely from
-- GW1-12 and scattered between GW6 and GW36.
--
-- Worse, the zeros are not zeros: a player who was on the pitch for 90 minutes did not run
-- 0 km. Averaging them dragged every figure to 0.00, which is how the gap surfaced.
--
-- So: `nullif(..., 0)` to treat unmeasured as unknown, and an explicit coverage count so
-- any consumer can see the sample is too thin to trust. Re-check in-season; the feed may
-- improve, and if it does this becomes useful.

drop view if exists player_congestion cascade;
create view player_congestion as
select
  season,
  player_code,
  count(*) filter (where tournament = 'prem')                            as prem_matches,
  count(*) filter (where tournament <> 'prem')                           as other_matches,
  coalesce(sum(minutes_played) filter (where tournament = 'prem'), 0)    as prem_minutes,
  coalesce(sum(minutes_played) filter (where tournament <> 'prem'), 0)   as other_minutes,
  round(
    coalesce(sum(minutes_played) filter (where tournament <> 'prem'), 0) * 100.0
    / nullif(sum(minutes_played), 0), 1
  )                                                                      as pct_minutes_outside_league,
  -- Unmeasured is null, not zero. Both stay null until coverage is worth reading.
  round(avg(nullif(distance_covered, 0)) filter (where tournament = 'prem'), 2)
                                                                         as avg_distance_prem,
  round(max(nullif(top_speed, 0)) filter (where tournament = 'prem'), 2) as top_speed_prem,
  count(*) filter (where tournament = 'prem' and distance_covered > 0)   as matches_with_physical
from core_insights_player_match
group by season, player_code;

-- ---------------------------------------------------------------------------
-- 2 & 3. player_scout: price scale, and an output metric that fits the position
-- ---------------------------------------------------------------------------
-- `now_cost / 10.0` returned numeric with full scale, so prices rendered as
-- 15.5000000000000000. Rounded to one decimal, which is the precision FPL actually uses.
--
-- The substantive fix is `output_percentile`. Ranking every position on xGI/90 made the
-- hidden-gems list nonsense: Darlow, a goalkeeper with an xGI/90 of 0.002, scored 0.842 and
-- placed second, because his xGI percentile was computed among goalkeepers where near-zero
-- is normal. Attacking expected-goal involvement is simply the wrong output measure for a
-- keeper or a centre-back — their FPL return comes from clean sheets, saves and defensive
-- contribution.
--
-- So output is now position-aware: goalkeepers and defenders are judged on expected goals
-- conceded and defensive contribution, midfielders and forwards on expected goal
-- involvement. The component percentiles stay exposed so a UI can show *why* something
-- ranks, rather than asking for trust in a single composite.

drop view if exists player_scout cascade;
create view player_scout as
with ctx as (select * from season_context),
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
    case when s.minutes >= 450 and u.xg_chain is not null
         then round(u.xg_chain * 90.0 / s.minutes, 3) end   as xg_chain_per_90,
    case when s.minutes >= 450 and u.xg_buildup is not null
         then round(u.xg_buildup * 90.0 / s.minutes, 3) end as xg_buildup_per_90,
    c.other_minutes, c.pct_minutes_outside_league,
    c.avg_distance_prem, c.top_speed_prem, c.matches_with_physical,
    case when st.now_cost > 0
         then round(s.total_points / (st.now_cost / 10.0), 2) end as points_per_million,
    case when st.now_cost > 0 and s.minutes >= 450
         then round(s.expected_goal_involvements / (st.now_cost / 10.0), 3) end
                                                                 as xgi_per_million,
    (s.player_code is null or coalesce(s.minutes, 0) < 450)       as is_cold_start
  from player_state st
  cross join ctx
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
  -- Position-appropriate output. A centre-back's FPL return is clean sheets and defensive
  -- contribution; a striker's is goal involvement. Ranking both on xGI put a goalkeeper
  -- second in the hidden-gems list.
  case
    when r.element_type in (1, 2)
      then round(((coalesce(r.xgc_per_90_percentile, 0)
                 + coalesce(r.defcon_per_90_percentile, 0)) / 2.0)::numeric, 3)
    else coalesce(r.xgi_per_90_percentile, 0)
  end as output_percentile
from ranked r;

drop view if exists hidden_gems cascade;
create view hidden_gems as
select
  player_code, web_name, position, team_short, price, selected_by_percent,
  minutes, total_points, xgi_per_90, defcon_per_90, xgc_per_90, points_per_million,
  output_percentile, differential_percentile, value_percentile,
  is_available, status, news, penalties_order,
  -- Equal weight on output, ownership scarcity, and points per million. The weighting is a
  -- judgement, not a truth, which is why every component is exposed alongside it.
  round((output_percentile + differential_percentile
         + coalesce(value_percentile, 0)) / 3.0, 3) as gem_score
from player_scout
where not is_cold_start
  and has_reliable_sample
  and selected_by_percent < 10
order by gem_score desc;
