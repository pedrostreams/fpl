-- 0004_derived_views.sql — the analysis layer the web app reads.
--
-- Views, not tables: every input is already stored, so these are cheap to recreate and
-- impossible to leave stale. Migration 0013 in Sporting_Director_Game had to convert its
-- equivalent to a materialised view for query speed; do that here only if reads actually
-- get slow, and remember the refresh obligation that comes with it.
--
-- `drop view if exists` + `create` (rather than `create or replace`) so column lists can
-- change in a later migration without a type-mismatch error.

-- ---------------------------------------------------------------------------
-- season_context — which season should the analysis read?
-- ---------------------------------------------------------------------------
-- In preseason the useful numbers are last season's; from GW1 they're this season's. Every
-- view below reads `stats_season` from here rather than hardcoding a label, so the whole
-- layer switches over on its own the moment the first gameweek is played.
--
-- Season labels are 'YYYY-YY', which sorts lexically in chronological order.

drop view if exists season_context cascade;
create view season_context as
with cur as (
  select name from seasons where is_current order by name desc limit 1
)
select
  (select name from cur) as current_season,
  case
    when exists (select 1 from player_gw_stats
                 where season = (select name from cur) and minutes is not null)
      then (select name from cur)
    else (select max(season) from player_season_totals
          where source = 'history_past' and season < (select name from cur))
  end as stats_season,
  exists (select 1 from player_gw_stats
          where season = (select name from cur) and minutes is not null) as season_started;

-- ---------------------------------------------------------------------------
-- player_state — current, live facts about each player
-- ---------------------------------------------------------------------------
-- Price, ownership and availability as of the newest snapshot. Snapshots are written
-- insert-on-change, so "the latest row" is the current value carried forward — DISTINCT ON
-- is the correct read, not a join on a timestamp.

drop view if exists player_state cascade;
create view player_state as
select
  ps.season,
  p.code                          as player_code,
  p.web_name,
  p.first_name,
  p.second_name,
  p.birth_date,
  date_part('year', age(p.birth_date))::int as age,
  ps.fpl_id,
  ps.element_type,
  et.singular_name_short          as position,
  et.defcon_threshold,
  ps.team_code,
  t.name                          as team_name,
  t.short_name                    as team_short,
  ps.start_cost,
  -- Set-piece duty: FPL publishes this first-party and it is a genuine edge.
  ps.penalties_order,
  ps.direct_freekicks_order,
  ps.corners_order,
  (ps.penalties_order = 1)        as is_first_penalty_taker,
  snap.captured_at                as state_as_of,
  snap.now_cost,
  snap.now_cost / 10.0            as price,
  snap.selected_by_percent,
  snap.form,
  snap.ep_next,
  snap.status,
  snap.news,
  snap.chance_of_playing_next_round,
  -- 'a' is available; d/i/s/u are doubtful, injured, suspended, unavailable.
  (snap.status = 'a')             as is_available,
  snap.cost_change_start,
  snap.cost_change_event,
  snap.price_change_percent,
  snap.transfers_in_event,
  snap.transfers_out_event,
  coalesce(snap.transfers_in_event, 0) - coalesce(snap.transfers_out_event, 0)
                                  as net_transfers_event
from player_seasons ps
join players p       on p.code = ps.player_code
join element_types et on et.id = ps.element_type
left join teams t    on t.code = ps.team_code
left join lateral (
  select * from player_snapshots s
  where s.player_code = ps.player_code and s.season = ps.season
  order by s.captured_at desc limit 1
) snap on true
where ps.season = (select current_season from season_context);

-- ---------------------------------------------------------------------------
-- player_stats_season — authoritative per-season totals and per-90s
-- ---------------------------------------------------------------------------
-- Source is `history_past` for completed seasons, which is deliberate: verified 2026-07-26,
-- the `bootstrap` rows disagree for loan and transfer cases (Anthony showed 0 minutes there
-- against 2717 in history_past) because they describe only the player's spell at their
-- current club. See docs/DATA_SOURCES.md 2.1.
--
-- Per-90s use a 450-minute floor (five full matches). Below that the denominator is small
-- enough that a single cameo distorts the rate, which is how "hidden gems" turn into noise.
-- Rates are null rather than wrong, and `has_reliable_sample` says which is which.

drop view if exists player_stats_season cascade;
create view player_stats_season as
select
  t.season,
  t.player_code,
  t.minutes,
  t.starts,
  t.total_points,
  t.goals_scored,
  t.assists,
  t.clean_sheets,
  t.goals_conceded,
  t.saves,
  t.bonus,
  t.bps,
  t.yellow_cards,
  t.red_cards,
  t.expected_goals,
  t.expected_assists,
  t.expected_goal_involvements,
  t.expected_goals_conceded,
  -- DEFCON: FPL's own figure, never recomputed. The formula is position-dependent —
  -- clearances+blocks+interceptions+tackles for defenders, plus recoveries for midfielders
  -- and forwards (verified 2026-07-26) — and summing one formula for everyone overstates
  -- every defender by their entire recovery count.
  t.defensive_contribution,
  t.clearances_blocks_interceptions,
  t.recoveries,
  t.tackles,
  (t.minutes >= 450)                                      as has_reliable_sample,
  case when t.minutes >= 450 then round(t.expected_goals * 90.0 / t.minutes, 3) end
                                                          as xg_per_90,
  case when t.minutes >= 450 then round(t.expected_assists * 90.0 / t.minutes, 3) end
                                                          as xa_per_90,
  case when t.minutes >= 450 then round(t.expected_goal_involvements * 90.0 / t.minutes, 3) end
                                                          as xgi_per_90,
  case when t.minutes >= 450 then round(t.expected_goals_conceded * 90.0 / t.minutes, 3) end
                                                          as xgc_per_90,
  case when t.minutes >= 450 then round(t.total_points * 90.0 / t.minutes, 2) end
                                                          as points_per_90,
  case when t.minutes >= 450 then round(t.defensive_contribution * 90.0 / t.minutes, 2) end
                                                          as defcon_per_90,
  case when t.minutes >= 450 then round(t.bps * 90.0 / t.minutes, 2) end
                                                          as bps_per_90,
  -- Finishing and creation vs expectation. Positive means outperforming the model, which
  -- regresses: it flags who has been lucky as much as who is good.
  round(t.goals_scored - t.expected_goals, 2)             as goals_minus_xg,
  round(t.assists - t.expected_assists, 2)                as assists_minus_xa
from player_season_totals t
where t.source = 'history_past';

-- ---------------------------------------------------------------------------
-- player_congestion — minutes outside the league
-- ---------------------------------------------------------------------------
-- FPL-Core-Insights' gameweek folders include Champions League, Europa League and cup
-- fixtures. Unlabelled that corrupted per-90s (Declan Rice: 4 246 minutes against FPL's
-- 3 093); labelled, it answers a question FPL's own data cannot — who is playing midweek
-- and therefore carries rotation and fatigue risk.

drop view if exists player_congestion cascade;
create view player_congestion as
select
  season,
  player_code,
  count(*) filter (where tournament = 'prem')                     as prem_matches,
  count(*) filter (where tournament <> 'prem')                    as other_matches,
  coalesce(sum(minutes_played) filter (where tournament = 'prem'), 0)  as prem_minutes,
  coalesce(sum(minutes_played) filter (where tournament <> 'prem'), 0) as other_minutes,
  round(
    coalesce(sum(minutes_played) filter (where tournament <> 'prem'), 0) * 100.0
    / nullif(sum(minutes_played), 0), 1
  )                                                               as pct_minutes_outside_league,
  -- Physical load, from the only free source that publishes it.
  round(avg(distance_covered) filter (where tournament = 'prem'), 2) as avg_distance_prem,
  round(max(top_speed) filter (where tournament = 'prem'), 2)        as top_speed_prem
from core_insights_player_match
group by season, player_code;

-- ---------------------------------------------------------------------------
-- team_style — the defensive/attacking profile
-- ---------------------------------------------------------------------------
-- PPDA (passes allowed per defensive action) is the direct answer to "which teams play
-- defensive football", and nothing in the FPL API comes close. **Low PPDA means an
-- aggressive high press; high PPDA means sitting deep.** `press_intensity_rank` inverts it
-- so rank 1 is always the most aggressive presser, because a metric where "lower is more"
-- invites misreading in a UI.

drop view if exists team_style cascade;
create view team_style as
with agg as (
  select
    season,
    team_code,
    understat_team,
    count(*)                                  as matches,
    round(avg(xg), 3)                         as xg_per_match,
    round(avg(opponent_xg), 3)                as xga_per_match,
    round(avg(xg) - avg(opponent_xg), 3)      as xg_difference,
    round(avg(np_xg), 3)                      as np_xg_per_match,
    round(avg(ppda), 2)                       as ppda,
    round(avg(opponent_ppda), 2)              as opponent_ppda,
    round(avg(deep_completions), 2)           as deep_completions,
    round(avg(opponent_deep_completions), 2)  as deep_completions_conceded,
    sum(goals)                                as goals,
    sum(opponent_goals)                       as goals_conceded,
    sum(points)                               as points,
    round(sum(expected_points), 1)            as expected_points,
    count(*) filter (where opponent_goals = 0) as clean_sheets
  from understat_team_match
  where team_code is not null
  group by season, team_code, understat_team
)
select
  a.*,
  round(a.clean_sheets * 100.0 / nullif(a.matches, 0), 1) as clean_sheet_pct,
  rank() over (partition by a.season order by a.ppda)              as press_intensity_rank,
  rank() over (partition by a.season order by a.xga_per_match)     as defensive_rank,
  rank() over (partition by a.season order by a.xg_per_match desc) as attacking_rank,
  -- Percentiles for heatmapping. Inverted where lower is better, so 1.0 always means
  -- "best in the league at this" regardless of the metric's direction.
  round(percent_rank() over (partition by a.season order by a.xg_per_match)::numeric, 3)
                                                          as xg_percentile,
  round((1 - percent_rank() over (partition by a.season order by a.xga_per_match))::numeric, 3)
                                                          as defence_percentile,
  round((1 - percent_rank() over (partition by a.season order by a.ppda))::numeric, 3)
                                                          as press_percentile,
  elo.elo                                                 as current_elo
from agg a
left join lateral (
  select e.elo from club_elo e
  where e.team_code = a.team_code
  order by e.valid_from desc limit 1
) elo on true;

-- ---------------------------------------------------------------------------
-- fixture_odds — one row per team per fixture, with market-implied difficulty
-- ---------------------------------------------------------------------------
-- Replaces FPL's integer 1-5 FDR with de-vigged market probabilities: continuous,
-- venue-aware, and priced by people with money at stake.
--
-- Clean-sheet probability is estimated with a Poisson split of the over/under 2.5 line.
-- Total expected goals is inferred from P(over 2.5), then split between the sides in
-- proportion to their win probabilities, and P(clean sheet) = P(opponent scores 0) =
-- exp(-lambda_opponent). It is an approximation — it assumes independent Poisson scoring
-- and ignores the draw's information — but it is materially better than an integer 1-5,
-- and honest about being a model rather than a market price.

drop view if exists fixture_odds cascade;
create view fixture_odds as
with sided as (
  select season, match_date, home_team_code as team_code, away_team_code as opponent_code,
         true as is_home, p_home as p_win, p_away as p_lose, p_draw, p_over_25, p_under_25
  from match_odds where home_team_code is not null and away_team_code is not null
  union all
  select season, match_date, away_team_code, home_team_code,
         false, p_away, p_home, p_draw, p_over_25, p_under_25
  from match_odds where home_team_code is not null and away_team_code is not null
),
lambdas as (
  select
    s.*,
    -- Invert P(over 2.5) for a Poisson total. ln(1/(1-p)) is a cheap monotone stand-in for
    -- the exact inverse, calibrated to land near 2.7 goals at the typical p ~ 0.52.
    case when s.p_over_25 is not null and s.p_over_25 < 0.999
         then greatest(0.4, least(6.0, 2.7 * (0.5 + s.p_over_25)))
    end as total_goals
  from sided s
)
select
  l.season,
  l.match_date,
  l.team_code,
  l.opponent_code,
  l.is_home,
  l.p_win,
  l.p_draw,
  l.p_lose,
  l.p_over_25,
  round(l.total_goals, 3) as expected_total_goals,
  -- Split the total by relative win probability; a heavy favourite takes the larger share.
  round(l.total_goals * (0.5 + 0.5 * (l.p_win - l.p_lose)), 3)     as expected_goals_for,
  round(l.total_goals * (0.5 - 0.5 * (l.p_win - l.p_lose)), 3)     as expected_goals_against,
  round(exp(-(l.total_goals * (0.5 - 0.5 * (l.p_win - l.p_lose))))::numeric, 4)
                                                                   as p_clean_sheet,
  -- 0 = easiest fixture, 1 = hardest. Directly comparable across teams and venues, which
  -- FPL's integer FDR is not.
  round((1 - l.p_win)::numeric, 4)                                 as difficulty
from lambdas l;

-- ---------------------------------------------------------------------------
-- player_scout — what the scout screen reads
-- ---------------------------------------------------------------------------
-- Joins live state to the most recent season with data, adds value metrics, and ranks
-- within position for the heatmap.
--
-- Percentiles are computed **within position** because a defender's xGI/90 is not
-- comparable to a forward's, and only over players clearing the 450-minute floor. Everyone
-- else gets a null percentile and `is_cold_start = true` rather than being ranked last on
-- a tiny sample: 104 of 558 players (19%) have no prior-season record at all, and they are
-- exactly where genuine hidden gems live, so silently sorting them to the bottom would
-- defeat the screen's purpose.

drop view if exists player_scout cascade;
create view player_scout as
with ctx as (select * from season_context),
base as (
  select
    st.*,
    ctx.stats_season,
    ctx.season_started,
    s.minutes, s.starts, s.total_points, s.goals_scored, s.assists,
    s.clean_sheets, s.goals_conceded, s.saves, s.bonus, s.bps,
    s.expected_goals, s.expected_assists, s.expected_goal_involvements,
    s.expected_goals_conceded, s.defensive_contribution,
    s.xg_per_90, s.xa_per_90, s.xgi_per_90, s.xgc_per_90,
    s.points_per_90, s.defcon_per_90, s.bps_per_90,
    s.goals_minus_xg, s.assists_minus_xa, s.has_reliable_sample,
    -- Understat's independent xA plus the two metrics FPL has no equivalent for: xG chain
    -- credits every possession a player was involved in, xG buildup excludes their own
    -- shots and key passes, so a high buildup with low chain marks a deep progressor.
    u.xa            as understat_xa,
    u.xg_chain,
    u.xg_buildup,
    case when s.minutes >= 450 and u.xg_chain is not null
         then round(u.xg_chain * 90.0 / s.minutes, 3) end as xg_chain_per_90,
    case when s.minutes >= 450 and u.xg_buildup is not null
         then round(u.xg_buildup * 90.0 / s.minutes, 3) end as xg_buildup_per_90,
    c.other_minutes, c.pct_minutes_outside_league,
    c.avg_distance_prem, c.top_speed_prem,
    -- Value. Price is in tenths of a million, hence /10.
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
)
select
  b.*,
  -- Ranked within position, and only among reliable samples: `nulls last` plus the
  -- has_reliable_sample filter keeps cold-start players out of the distribution instead of
  -- dragging the percentiles down.
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
  -- xGC is conceded, so invert: 1.0 means the best defensive record in the position.
  case when b.has_reliable_sample then round((1 - percent_rank() over (
    partition by b.element_type order by b.xgc_per_90 nulls last))::numeric, 3) end
                                                    as xgc_per_90_percentile,
  case when b.has_reliable_sample then round(percent_rank() over (
    partition by b.element_type order by b.points_per_million nulls first)::numeric, 3) end
                                                    as value_percentile,
  -- Low ownership is the differential axis: 1.0 = least owned in the position.
  round((1 - percent_rank() over (
    partition by b.element_type order by b.selected_by_percent nulls first))::numeric, 3)
                                                    as differential_percentile
from base b;

-- ---------------------------------------------------------------------------
-- hidden_gems — high output, low ownership, low price
-- ---------------------------------------------------------------------------
-- Deliberately excludes cold-start players rather than ranking them: with no minutes there
-- is no output to rank, and a made-up score would be worse than an honest omission. The
-- scout screen surfaces them separately.

drop view if exists hidden_gems cascade;
create view hidden_gems as
select
  player_code, web_name, position, team_short, price, selected_by_percent,
  minutes, total_points, xgi_per_90, points_per_million,
  xgi_per_90_percentile, differential_percentile, value_percentile,
  is_available, status, news, penalties_order,
  -- Equal weight on output, scarcity of ownership, and value per million. Weighting is a
  -- judgement call, not a truth — the component percentiles are exposed above so the UI can
  -- show why a player scored well rather than asking for trust in one number.
  round((coalesce(xgi_per_90_percentile, 0)
       + differential_percentile
       + coalesce(value_percentile, 0)) / 3.0, 3) as gem_score
from player_scout
where not is_cold_start
  and has_reliable_sample
  and selected_by_percent < 10
order by gem_score desc;
