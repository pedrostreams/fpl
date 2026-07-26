-- 0006_gk_output.sql — goalkeepers must not be ranked on defensive contribution.
--
-- 0005 made output position-aware, but lumped goalkeepers with defenders: output became the
-- mean of the expected-goals-conceded percentile and the defensive-contribution percentile.
--
-- Goalkeepers score **no** defensive contribution points at all — `element_types.defcon_threshold`
-- is null for them, which is the schema saying so. FPL still reports a non-zero
-- `defensive_contribution` figure for keepers, so the percentile is not constant and the
-- ranking silently spread them on a metric that can never earn them a point.
--
-- Goalkeepers are therefore judged on expected goals conceded alone, which is what actually
-- drives their return alongside saves.

drop view if exists hidden_gems cascade;

create or replace view player_scout_output as
select
  player_code,
  case
    -- Goalkeepers: clean-sheet prospects only. No DEFCON component.
    when element_type = 1 then coalesce(xgc_per_90_percentile, 0)
    -- Defenders: both clean sheets and defensive contribution pay.
    when element_type = 2
      then round(((coalesce(xgc_per_90_percentile, 0)
                 + coalesce(defcon_per_90_percentile, 0)) / 2.0)::numeric, 3)
    -- Midfielders and forwards: attacking involvement.
    else coalesce(xgi_per_90_percentile, 0)
  end as output_percentile
from player_scout;

-- player_scout already exposes `output_percentile` from 0005; recreate it so the goalkeeper
-- branch is the one that ships. Kept as a full redefinition rather than a patch because a
-- view cannot be altered column-by-column.
drop view if exists player_scout_output cascade;

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

create view hidden_gems as
select
  player_code, web_name, position, team_short, price, selected_by_percent,
  minutes, total_points, xgi_per_90, defcon_per_90, xgc_per_90, saves,
  points_per_million, output_percentile, differential_percentile, value_percentile,
  is_available, status, news, penalties_order,
  round((output_percentile + differential_percentile
         + coalesce(value_percentile, 0)) / 3.0, 3) as gem_score
from player_scout
where not is_cold_start
  and has_reliable_sample
  and selected_by_percent < 10
order by gem_score desc;
