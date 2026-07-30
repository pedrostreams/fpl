-- ---------------------------------------------------------------------------
-- 0033 — gem_score becomes a column, so /gems can stop being a page
--
-- `/gems` and `/players?view=differentials` look like the same screen and are not.
-- The preset is a row filter (`selected_by_percent < 10`, available, reliable,
-- `minutes_share >= 0.25`) plus a column set, sorted on `points_per_90`. `hidden_gems` is a
-- **five-component composite** (0014): position-aware output, ownership scarcity, value, the
-- fixture, and minutes — five ranks averaged, never raw quantities multiplied, so that whichever
-- metric happens to have the widest spread cannot quietly dominate.
--
-- Deleting the route without moving that composite deletes the composite. So it moves first, and
-- `gem_score_check` proves the move was faithful *before* the page goes.
--
-- ONE FORMULA, NOT TWO
-- `player_gem_score` becomes the single place the average is written. `hidden_gems` keeps its own
-- copy for now rather than being rebuilt on top of it: it is read by `captain_check` and
-- `target_check`, so `drop … cascade` would take two check views with it and — because there is
-- no version table and every migration re-runs in filename order — a later full run would drop
-- them again after 0014 had recreated them. The check below is what keeps the two copies honest;
-- when `hidden_gems` is next rewritten for its own reasons, it should select from here.
--
-- WHY THE SCORE IS DEFINED FOR PLAYERS `hidden_gems` NEVER SHOWS
-- `hidden_gems` filters to under 10% ownership. The *score* does not need that filter, because
-- scarcity is already one of its five components — a heavily-owned player scores low on that
-- axis and keeps whatever he earns on the other four. So the column is defined for every player
-- in the eligible pool regardless of ownership, which makes it strictly more useful than the view
-- it came from: the `differentials` preset can sort on it while its own filter does the 10% cut.
--
-- It is **null** outside the eligible pool — cold-start players, thin samples, the unfit, and
-- anyone under a quarter of a season. That is the honest answer rather than a low score, and
-- DESIGN.md §1.2 already says how null renders: an em dash, or `.heat-null` hatching, never a
-- shaded cell at the bottom of the ramp.
--
-- `create or replace`, not `drop … cascade`, for the reason 0025 records: `player_metric_percentile`
-- (0018), `fixture_percentage_check` (0025) and `gameweek_shape_check` (0030) all read
-- `player_wide`, and there would be no migration left to rebuild them. So this restates 0025's
-- definition with one line appended. The length is restatement, not new logic.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- player_gem_score — the composite, for everyone it can be computed for
-- ---------------------------------------------------------------------------
create or replace view player_gem_score as
select
  b.player_code,
  -- Identical arithmetic to hidden_gems (0014), including `coalesce(fixture_rank, 0)`: a
  -- blanking club scores 0 on the fixture axis rather than being excluded, because scoring
  -- nothing is the truthful answer for a player with no match. The rank itself stays null so
  -- the screen can print "blank" rather than a 0 that reads like a bad fixture.
  round((b.output_percentile + b.differential_percentile + b.value_percentile
         + coalesce(b.fixture_rank, 0) + b.minutes_rank) / 5.0, 4) as gem_score
from player_target_base b;

-- ---------------------------------------------------------------------------
-- player_wide — 0025's definition, plus gem_score
-- ---------------------------------------------------------------------------
create or replace view player_wide as
with heads as (
  select player_code,
         count(*)                                as head_shots,
         round(sum(xg)::numeric, 3)              as head_xg,
         count(*) filter (where result = 'Goal') as head_goals
  from understat_shots
  where body_part = 'Head'
  group by player_code
),
corners as (
  select team_code,
         count(*)                                as team_corner_shots,
         round(sum(xg)::numeric, 2)              as team_corner_xg,
         count(*) filter (where result = 'Goal') as team_corner_goals
  from understat_shots
  where situation = 'From Corner'
  group by team_code
)
select
  -- identity
  s.player_code, s.web_name, s.first_name, s.second_name, s.age,
  s.position, s.element_type, s.team_code, s.team_short, s.team_name,

  -- availability
  s.status, s.news, s.chance_of_playing_next_round as chance_of_playing, s.is_available,
  a.minutes_share, a.start_rate, a.fully_fit,

  -- price and ownership
  s.price, s.cost_change_start, s.cost_change_event, s.price_change_percent,
  s.selected_by_percent, s.transfers_in_event, s.transfers_out_event, s.net_transfers_event,
  s.points_per_million, s.xgi_per_million,

  -- volume and returns
  s.minutes, s.starts, s.total_points, s.goals_scored, s.assists, s.clean_sheets,
  s.goals_conceded, s.saves, s.bonus, s.bps, s.defensive_contribution, s.defcon_threshold,

  -- expected, season totals
  s.expected_goals, s.expected_assists, s.expected_goal_involvements, s.expected_goals_conceded,

  -- rates
  s.xg_per_90, s.xa_per_90, s.xgi_per_90, s.xgc_per_90, s.points_per_90,
  s.defcon_per_90, s.bps_per_90,

  -- finishing and creation quality
  s.goals_minus_xg, s.assists_minus_xa,
  s.understat_xa, s.xg_chain, s.xg_buildup, s.xg_chain_per_90, s.xg_buildup_per_90,

  -- chance quality, from the shot events
  p.shots_per_90, p.shots_in_box_per_90, p.big_chances_per_90, p.non_penalty_xg_per_90,
  case when x.player_code is not null then coalesce(h.head_shots, 0) end as head_shots,
  case when x.player_code is not null then coalesce(h.head_xg, 0) end    as head_xg,
  case when x.player_code is not null then coalesce(h.head_goals, 0) end as head_goals,
  case when x.player_code is not null and coalesce(s.minutes, 0) >= 90
       then round(coalesce(h.head_xg, 0) / (s.minutes / 90.0), 3) end   as head_xg_per_90,

  -- set pieces
  s.penalties_order, s.direct_freekicks_order, s.corners_order,

  -- rotation risk
  s.other_minutes, s.pct_minutes_outside_league,

  -- this gameweek's fixture
  coalesce(f.fixture_count, 0)                                         as fixture_count,
  f.opponents, f.difficulty as fixture_difficulty, f.xg_for as fixture_xg_for,
  f.expected_clean_sheets as fixture_clean_sheets,
  case when s.element_type in (1, 2) then f.defence_fixture_rank
       else f.attack_fixture_rank end                                  as fixture_rank,
  case when s.element_type in (1, 2) then f.opponent_attacking_rank
       else f.opponent_defensive_rank end                              as opponent_rank,

  -- the player's own club
  ts.xg_per_match as team_xg_per_match, ts.xga_per_match as team_xga_per_match,
  ts.ppda as team_ppda, ts.deep_completions as team_deep_completions,
  ts.clean_sheet_pct as team_clean_sheet_pct,
  ts.attacking_rank as team_attacking_rank, ts.defensive_rank as team_defensive_rank,
  case when ts.team_code is not null then coalesce(c.team_corner_shots, 0) end as team_corner_shots,
  case when ts.team_code is not null then coalesce(c.team_corner_xg, 0) end    as team_corner_xg,
  case when ts.team_code is not null then coalesce(c.team_corner_goals, 0) end as team_corner_goals,

  -- sample flags, so the UI can hatch rather than mislead
  s.has_reliable_sample, s.is_cold_start,

  -- appended in 0025 — the fixture as a percentage
  f.p_team_scores, f.p_team_scores_2plus,
  f.p_clean_sheet,

  -- APPENDED IN 0033 — the composite that used to be a page. Null outside the eligible pool.
  g.gem_score
from player_scout s
join player_availability a on a.player_code = s.player_code
left join player_shot_profile p on p.player_code = s.player_code
left join heads h on h.player_code = s.player_code
left join player_external_ids x
  on x.player_code = s.player_code and x.source = 'understat'
left join team_fixture_context f on f.team_code = s.team_code
left join corners c on c.team_code = s.team_code
left join team_style ts on ts.team_code = s.team_code
 and ts.season = (select stats_season from season_context)
left join player_gem_score g on g.player_code = s.player_code;

-- ---------------------------------------------------------------------------
-- gem_score_check — the move was faithful
-- ---------------------------------------------------------------------------
-- One materialized scan, one aggregate, per CLAUDE.md: a check view built from N scalar
-- subqueries scans its base N times, and a `verify` that is slow is a `verify` that gets skipped.
--
-- The assertion that matters is `agrees_with_hidden_gems`. It compares against an **independent
-- copy** of the formula — the one in 0014 that is about to lose its page — rather than restating
-- this migration's own expression, which would prove only that SQL is deterministic.
drop view if exists gem_score_check cascade;
create view gem_score_check as
with paired as materialized (
  select
    w.player_code,
    w.gem_score,
    w.selected_by_percent,
    w.has_reliable_sample,
    w.is_cold_start,
    hg.gem_score as hidden_gems_score
  from player_wide w
  left join hidden_gems hg on hg.player_code = w.player_code
)
select
  count(*)                                                          as players,
  count(gem_score)                                                  as scored,
  count(hidden_gems_score)                                          as in_hidden_gems,
  -- The parity assertion. NULL rather than true if hidden_gems is empty, which is what the
  -- row count beside it exists to disambiguate: bool_and over zero rows is NULL, and NULL in a
  -- table of booleans reads as a pass.
  bool_and(gem_score = hidden_gems_score)
    filter (where hidden_gems_score is not null)                    as agrees_with_hidden_gems,
  -- Every player hidden_gems scored must be scored here too. The reverse is not true and must
  -- not be asserted: this column is deliberately defined above 10% ownership as well.
  count(*) filter (where hidden_gems_score is not null
                     and gem_score is null)                         as lost_in_the_move,
  -- Scored strictly wider than the page it replaces, which is the point of the change.
  count(*) filter (where gem_score is not null
                     and selected_by_percent >= 10)                 as scored_above_10pct,
  -- A composite of five percentiles cannot leave [0, 1].
  bool_and(gem_score between 0 and 1)
    filter (where gem_score is not null)                            as within_unit_interval,
  -- Null is the eligibility gate doing its job, not a missing join: nobody outside the pool
  -- may carry a score.
  bool_and(gem_score is null)
    filter (where is_cold_start or not has_reliable_sample)         as ineligible_are_null
from paired;
