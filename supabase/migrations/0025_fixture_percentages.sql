-- ---------------------------------------------------------------------------
-- 0025 — the fixture as a percentage, not a decimal
--
-- allaboutfpl never prints a difficulty. It prints "86% chance of 1+ goal", "37% chance of
-- 2+", "clean sheet odds". We compute all three inside `captain_picks` and then throw them
-- away: everywhere else in the app the fixture reads `0.64`, which carries no reference point
-- at all. A reader cannot tell whether 0.64 is good without knowing the distribution; 86%
-- explains itself. That is the whole of this migration — three expressions, no new data.
--
-- `create or replace view`, NOT `drop ... cascade`
-- `team_fixture_context` is read by `player_target_base` (0014) and `player_wide` (0015). A
-- cascading drop here would delete both and they would never come back, because `migrate.py`
-- applies files in order and 0014/0015 have already run by the time this one does. So this
-- replaces in place, which constrains the shape: the existing 14 output columns must keep their
-- names, types and **order**, and new ones can only be appended. That is why the outer select
-- lists columns explicitly instead of `a.*` — `p_clean_sheet` has to be computed inside the CTE
-- (it needs the per-fixture rows) but must not surface in the middle of the column list.
--
-- THE DOUBLE-GAMEWEEK TRAP, which is the only interesting part
-- `team_fixture_context` aggregates a club's fixtures for one gameweek, so it must survive a
-- double. The existing quantities sum, correctly: two fixtures are two chances to return, and
-- `expected_clean_sheets` genuinely adds. **Probabilities do not sum.** Two fixtures at 60%
-- would give 120%.
--
-- Goals compose exactly, because a sum of independent Poissons is Poisson: over the gameweek
-- the club's total goals are Poisson(Λ) with Λ = Σ λ_i, which is already computed as `xg_for`.
-- So the two team-total probabilities fall straight out of it and are right for a single, a
-- double and a blank alike:
--
--     P(scores 1+) = 1 − e^−Λ
--     P(scores 2+) = 1 − e^−Λ (1 + Λ)
--
-- Clean sheets do not compose that way, because FPL awards them per fixture rather than per
-- gameweek. Two different quantities exist, and conflating them is the `fixture_run`
-- incomparable-totals trap in a new place:
--
--   - `expected_clean_sheets` = Σ p_i — additive, can exceed 1, unchanged. This is the
--     FPL-relevant quantity: the expected number of clean-sheet bonuses.
--   - `p_clean_sheet` = 1 − Π(1 − p_i) — a real probability, "keeps at least one clean sheet".
--
-- For a single gameweek the two are identical, which is the overwhelmingly common case. Over a
-- double they answer different questions, and the column labels say which.
--
-- WHY THESE ARE ELO AND NOT MARKET NUMBERS, TODAY
-- Migration 0023 landed a market that prices unplayed fixtures, and `{Team} Totalt 0.5/1.5`
-- would replace the first two expressions with a price that has team news in it. Those markets
-- are **not open for the Premier League** and cannot be confirmed before 2026-08-21, so there
-- is nothing to switch to yet and a `basis` column here would have only one value to hold.
-- When the August probe settles it, the overlay goes in a further migration and `basis` arrives
-- with something real to distinguish. Building the switch first would be speculative complexity.
-- ---------------------------------------------------------------------------

create or replace view team_fixture_context as
with agg as (
  select
    fd.team_code,
    count(*)                                            as fixture_count,
    min(fd.kickoff_time)                                as first_kickoff,
    sum(fd.expected_goals_for)                          as xg_for,
    -- Expected clean sheets, not P(clean sheet): over a double these add, and over a single
    -- gameweek the two are identical. `p_clean_sheet` is exp(-xGA), the opponent failing to
    -- score — the orientation that the Elo calibration in 0007 had to be fixed to get right.
    sum(fd.p_clean_sheet)                               as expected_clean_sheets,
    avg(fd.difficulty)                                  as difficulty,
    -- Same casing convention as the /teams ticker: ARS home, ars away.
    string_agg(case when fd.is_home then upper(o.short_name) else lower(o.short_name) end,
               ', ' order by fd.kickoff_time)           as opponents,
    -- Opponent style, which is what turns a rank into a sentence a human can check. NULL for
    -- promoted clubs, which have no `team_style` row until they have played — and NULL must
    -- stay NULL all the way to the screen rather than becoming a flattering zero.
    -- Rounded: avg() over an integer column returns numeric at full scale, and 9 came out of
    -- the view as 9.0000000000000000. Over a double gameweek this is a genuine mean of two
    -- opponents, so one decimal rather than an integer.
    round(avg(os.attacking_rank)::numeric, 1)           as opponent_attacking_rank,
    round(avg(os.defensive_rank)::numeric, 1)           as opponent_defensive_rank,
    round(avg(os.xg_per_match)::numeric, 2)             as opponent_xg_per_match,
    round(avg(os.xga_per_match)::numeric, 2)            as opponent_xga_per_match,
    -- The true denominator, counted rather than assumed. Three promoted clubs have no
    -- `team_style` row, so "6th of 20" was wrong by three places before anyone read it.
    (select count(*) from team_style
      where season = (select stats_season from season_context))::int as ranked_clubs,
    -- P(at least one clean sheet this gameweek) — multiplicative, so it stays a probability
    -- over a double where the additive sum above deliberately does not. `greatest(…, 1e-9)`
    -- guards ln(0): a p_clean_sheet that rounds to exactly 1 would otherwise abort the view.
    1 - exp(sum(ln(greatest(1 - fd.p_clean_sheet, 1e-9))))
                                                        as p_clean_sheet_any
  from fixture_difficulty fd
  join teams o on o.code = fd.opponent_code
  left join team_style os
    on os.team_code = fd.opponent_code
   and os.season = (select stats_season from season_context)
  where fd.gameweek = (select gameweek from next_gameweek)
    and not coalesce(fd.finished, false)
  group by fd.team_code
)
select
  -- The original 14, in their original order and types. Do not reorder: `create or replace
  -- view` rejects it, and `player_wide` and `player_target_base` both read this.
  a.team_code, a.fixture_count, a.first_kickoff, a.xg_for, a.expected_clean_sheets,
  a.difficulty, a.opponents,
  a.opponent_attacking_rank, a.opponent_defensive_rank,
  a.opponent_xg_per_match, a.opponent_xga_per_match, a.ranked_clubs,
  -- Ranked across the 20 clubs, not across the several hundred players. A fixture is a
  -- property of the club, and ranking it per player would weight it by squad size — a club
  -- with 30 listed players would drag the distribution around for no footballing reason.
  -- The cost is resolution: 20 clubs means steps of 0.05 and real ties. That is honest.
  -- Cast: cume_dist returns double precision, and mixing that into the numeric percentiles
  -- from player_scout makes round(value, digits) unresolvable.
  (cume_dist() over (order by a.expected_clean_sheets))::numeric as defence_fixture_rank,
  (cume_dist() over (order by a.xg_for))::numeric                as attack_fixture_rank,

  -- Appended: the three percentages. The two allaboutfpl leads every captaincy article with
  -- are the same expressions `captain_picks` has used since 0012, promoted so the rest of the
  -- app can print them instead of a bare difficulty.
  round((1 - exp(-a.xg_for))::numeric, 4)                        as p_team_scores,
  round((1 - exp(-a.xg_for) * (1 + a.xg_for))::numeric, 4)       as p_team_scores_2plus,
  round(a.p_clean_sheet_any::numeric, 4)                         as p_clean_sheet
from agg a;

-- ---------------------------------------------------------------------------
-- player_wide gains the three columns
--
-- **They have to live on `player_wide` itself.** `getPlayerWide()` runs `select * from
-- player_wide` and `auditCatalogue` then checks every key in `lib/columns.ts` against that
-- result set, logging loudly for any that is missing. A companion view joined in TypeScript
-- would satisfy the screen and fail the audit — and the audit is what makes a mistyped column
-- key visible instead of silently rendering one column short.
--
-- So this restates 0015's definition with three lines appended. Two constraints forced that:
-- `create or replace view` cannot reorder or insert columns, so the new ones go last; and
-- `player_metric_percentile` (0018) reads this view, so `drop … cascade` would delete it with
-- no migration left to rebuild it. 0015 stays as written and becomes history, the same way
-- 0008 supersedes 0007's fixture views and 0005 supersedes 0004's. `team_fixture_context` is
-- already joined here as `f`, so the change really is three lines — the length is restatement,
-- not new logic. The reasoning behind each block is in 0015 and is not duplicated.
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
  -- Zero only where zero is the truth — a player Understat never saw has an *unknown* headed
  -- xG, and coalescing him to 0 would rank him as having no aerial threat. DESIGN.md's
  -- cardinal error, and the first draft of 0015 made it.
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

  -- APPENDED IN 0025 — the fixture as a percentage. Null for a blanking club, which is the
  -- honest answer: there is no chance of scoring in a match that is not being played, and a
  -- 0% would read as "they will not score" rather than "they are not playing". `fixture_count`
  -- is the column that distinguishes the two.
  f.p_team_scores, f.p_team_scores_2plus,
  -- Clean sheets pay points to goalkeepers and defenders only, so for everyone else this is a
  -- fact about the club rather than the player's return. Shown anyway: a midfielder at a club
  -- that keeps clean sheets is a midfielder at a club that is winning.
  f.p_clean_sheet
from player_scout s
join player_availability a on a.player_code = s.player_code
left join player_shot_profile p on p.player_code = s.player_code
left join heads h on h.player_code = s.player_code
left join player_external_ids x
  on x.player_code = s.player_code and x.source = 'understat'
left join team_fixture_context f on f.team_code = s.team_code
left join corners c on c.team_code = s.team_code
left join team_style ts on ts.team_code = s.team_code
 and ts.season = (select stats_season from season_context);

-- ---------------------------------------------------------------------------
-- fixture_percentage_check
-- ---------------------------------------------------------------------------

drop view if exists fixture_percentage_check cascade;
create view fixture_percentage_check as
select
  (select count(*) from team_fixture_context)                          as clubs_with_fixture,
  (select count(*) from player_wide where p_team_scores is not null)    as players_covered,
  -- A blanking club must reach the screen as unknown, never as 0%. `player_wide` coalesces
  -- `fixture_count` to 0 but leaves the three probabilities null, and this is the assertion
  -- that keeps those two facts consistent with each other.
  (select count(*) from player_wide where fixture_count = 0)           as blanking_players,
  (select coalesce(bool_and(p_team_scores is null and p_clean_sheet is null), true)
     from player_wide where fixture_count = 0)                         as blank_reads_unknown,

  (select coalesce(bool_and(p_team_scores between 0 and 1
                        and p_team_scores_2plus between 0 and 1
                        and p_clean_sheet between 0 and 1), true)
     from team_fixture_context)                                        as probs_in_range,
  -- The tail ordering `captain_check` also asserts: P(2+) can never exceed P(1+).
  (select coalesce(bool_and(p_team_scores_2plus <= p_team_scores), true)
     from team_fixture_context)                                        as tail_ordered,

  -- Independent derivation rather than a restatement: these two expressions must agree with
  -- the ones `captain_picks` computes from `fixture_difficulty` per fixture. They are the same
  -- mathematics reached through a different aggregation, so disagreement means one of the two
  -- mishandled the gameweek grouping.
  (select count(*) from captain_picks)                                 as captain_rows,
  -- `current_season`, spelled out. `(select season from season_context)` looks right and is a
  -- silent tautology: `season_context` has no `season` column, so Postgres resolves the name as
  -- an **outer reference** to `player_seasons.season` and the predicate becomes
  -- `ps.season = ps.season`. It only errors where no outer column of that name is in scope.
  -- Harmless while `player_seasons` holds one season; the moment 2025-26 is loaded the join
  -- fans out and this check silently compares the wrong rows.
  (select coalesce(bool_and(abs(c.p_team_scores - f.p_team_scores) < 0.0002), true)
     from captain_picks c
     join player_seasons ps on ps.player_code = c.player_code
                           and ps.season = (select current_season from season_context)
     join team_fixture_context f on f.team_code = ps.team_code
    where f.fixture_count = 1)                                         as agrees_with_captain_picks,

  -- Over a single gameweek the additive and multiplicative clean-sheet figures are identical.
  -- Where they diverge there must be a double, and this is what would catch a probability
  -- being summed past 1.
  (select count(*) from team_fixture_context where fixture_count > 1)   as double_gameweek_clubs,
  (select coalesce(bool_and(abs(expected_clean_sheets - p_clean_sheet) < 0.0002), true)
     from team_fixture_context where fixture_count = 1)                as single_gw_cs_identical,
  (select coalesce(bool_and(p_clean_sheet <= expected_clean_sheets + 0.0002), true)
     from team_fixture_context)                                        as probability_never_exceeds_expectation,

  -- A blank must not appear as a certainty of anything. `team_fixture_context` has no row for a
  -- blanking club at all, which is why `player_wide` coalesces `fixture_count` to 0 — so the
  -- assertion here is that the view genuinely omits them rather than emitting zeros.
  (select count(*) from team_fixture_context where fixture_count = 0)   as zero_fixture_rows,

  -- Every club in the gameweek is present, and no club appears twice.
  (select coalesce(bool_and(n = 1), true) from (
     select team_code, count(*) n from team_fixture_context group by 1) x)
                                                                       as one_row_per_club;
