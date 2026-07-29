-- ---------------------------------------------------------------------------
-- 0031 — a check view built from N scalar subqueries scans its base view N times
--
-- Measured 2026-07-29, and this is a lesson about the *shape* of a check view rather than about
-- any one query. `select * from <name>_check` on the views added today:
--
--     rotation_risk_check    41.5s
--     form_check             21.7s
--     rotation_pairs_check   20.0s
--     the whole check loop   98.6s
--
-- `python -m sync.cli verify` runs after every sync and is the entire verification path in a repo
-- with no test runner. A 99-second version is one that gets skipped, and a check nobody runs
-- asserts nothing — the same failure mode as `bool_and` over zero rows, reached socially instead
-- of logically.
--
-- THE CAUSE, AND WHY THE FIRST TIMING MISSED IT
-- Each `(select bool_and(...) from rotation_risk where ...)` is an independent scalar subquery, so
-- Postgres evaluates `rotation_risk` — 1.8s — once per column. Nineteen columns, 34 seconds.
--
-- And `select count(*) from rotation_risk_check` reported **0.98s**, which is what sent me looking
-- elsewhere: for `count(*)` the column values are never needed, so the planner discards every
-- scalar subquery. **Time a check view with `select *`, never `count(*)`.**
--
-- THE FIX IS ALSO SIMPLER THAN WHAT IT REPLACES
-- Almost every assertion in these views is an aggregate over the same rows, so they belong in one
-- aggregate query over one scan rather than in N subqueries. `with … as materialized` pins the
-- single evaluation — without the keyword Postgres may inline the CTE and undo the point.
--
-- Cross-table assertions stay as subqueries, because they genuinely read something else. There are
-- few of them and they are cheap.
--
-- Result: 98.6s → about 8s, with no assertion removed or weakened. `style_check` and `trend_check`
-- from 0021/0022 are left alone at 4.3s and 3.3s; they are the same shape but small enough not to
-- matter, and rewriting working checks for 7 seconds is not worth the risk of changing one.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- rotation_risk_check — 41.5s -> one scan
-- ---------------------------------------------------------------------------
drop view if exists rotation_risk_check cascade;
create view rotation_risk_check as
with r as materialized (
  select * from rotation_risk
),
l as materialized (
  select * from player_midweek_load
)
select
  (select count(*) from r)                                              as players,
  (select count(*) from squad_competition)                              as competition_rows,
  (select count(*) from l)                                              as load_rows,

  -- Every registered player must appear. A rotation-risk view that silently drops the players it
  -- has least data on is worse than none, because absence would read as safety.
  (select count(*) from r) = (select count(*) from player_scout)         as covers_every_player,

  -- One scan of `r` for everything that is an aggregate over it.
  (select coalesce(bool_and(risk_word is not null), true) from r)        as every_player_has_a_word,
  (select coalesce(bool_and(risk_word in (
            'not available', 'unknown — no recent record', 'not a starter',
            'minutes falling', 'a real contest for the slot',
            'nailed on', 'a regular', 'rotated')), true) from r)        as words_are_known,

  -- The null that must survive. 263 players have no six-match window, and "unknown" is the only
  -- honest reading — not "low minutes".
  (select count(*) filter (where recent_minutes is null) from r)         as unknown_recent_minutes,
  (select coalesce(bool_and(risk_word = 'unknown — no recent record') filter (
            where recent_minutes is null and is_available), true) from r)
                                                                        as unknown_reads_unknown,

  -- Squad competition arithmetic.
  (select coalesce(bool_and(rivals <= squad_mates) filter (where rivals is not null), true)
     from r)                                                            as rivals_within_squad,
  (select coalesce(bool_and(rivals_ahead <= rivals) filter (where rivals is not null), true)
     from r)                                                            as ahead_is_subset_of_rivals,
  -- A player on the highest minutes share at his club and position can have nobody ahead of him.
  (select coalesce(bool_and(rivals_ahead = 0) filter (
            where minutes_share is not null
              and minutes_share >= coalesce(best_rival_share, 0)), true)
     from r)                                                            as top_of_pool_has_nobody_ahead,

  -- Reasons. An empty array is legitimate — no risk found — but an unavailable player must always
  -- carry at least the one reason.
  (select coalesce(bool_and(cardinality(risk_reasons) >= 1) filter (
            where not is_available), true) from r)                       as unavailable_has_a_reason,
  (select coalesce(bool_and('nailed on' <> risk_word) filter (
            where cardinality(risk_reasons) > 0), true) from r)          as nailed_on_has_no_reasons,
  -- Competition may only be a reason for a player who actually plays; `rivals_ahead >= 1` alone is
  -- true for nearly everyone and handed the reason to 200 of 563 players before this rule.
  (select coalesce(bool_and(minutes_share >= 0.60) filter (
            where 'someone ahead of him' = any(risk_reasons)), true) from r)
                                                                        as competition_needs_minutes,
  (select coalesce(bool_and(risk_word = 'not a starter') filter (
            where is_available and recent_minutes is not null
              and minutes_share < 0.40), true) from r)                   as non_starters_say_so,

  -- Midweek load, one scan of `l`.
  (select count(*) filter (where other_matches > 0) from l)              as players_with_midweek,
  (select coalesce(bool_and(league_matches + other_matches = all_matches), true) from l)
                                                                        as match_counts_reconcile,
  (select coalesce(bool_and(pct_minutes_outside_league between 0 and 100) filter (
            where pct_minutes_outside_league is not null), true) from l)
                                                                        as load_pct_in_range,
  (select coalesce(bool_and(load_word = 'domestic only') filter (
            where other_matches = 0), true) from l)                      as no_matches_reads_domestic;

-- ---------------------------------------------------------------------------
-- form_check — 21.7s -> one scan
-- ---------------------------------------------------------------------------
drop view if exists form_check cascade;
create view form_check as
with f as materialized (
  select * from player_form_metric
),
rel as materialized (
  select * from player_form_reliability
),
win as materialized (
  select player_code, metric, count(*) filter (where recency <= 6) as window_matches
  from player_match_metric group by player_code, metric having count(*) >= 12
)
select
  (select count(*) from player_match_metric)                            as metric_rows,
  (select count(distinct player_code) from player_match_metric)         as players_with_matches,
  (select count(*) from player_form)                                    as players_with_window,
  (select count(*) from f)                                              as form_rows,
  (select count(*) from rel)                                            as reliability_rows,

  -- The window is six appearances. Not five, not seven, and not six gameweeks.
  (select coalesce(bool_and(window_matches = 6), true) from win)         as window_is_always_six,
  (select count(*) from core_insights_player_match where tournament <> 'prem')
                                                                        as non_league_rows_excluded,
  -- Joined on `match_id`, NOT `(player_code, event)`: a midweek European tie carries the same
  -- `event` as that gameweek's league match, so the looser join read as a leak that does not exist.
  (select coalesce(bool_and(m.tournament = 'prem'), true)
     from core_insights_player_match m
     join player_match_metric p
       on p.match_id = m.match_id and p.player_code = m.player_code
      and p.season = m.season)                                          as window_is_league_only,

  -- Coverage, published rather than assumed.
  (select count(*) from player_seasons
    where season = (select current_season from season_context))          as registered_players,
  (select count(*) from player_seasons ps
    where ps.season = (select current_season from season_context)
      and not exists (select 1 from player_form pf
                       where pf.player_code = ps.player_code))          as players_without_window,

  -- Everything that is an aggregate over the form rows, in one scan.
  (select coalesce(bool_and(n = 1), true) from (
     select player_code, metric, count(distinct element_type) n from f group by 1, 2) x)
                                                                        as one_position_per_row,
  (select coalesce(bool_and(pool >= 20), true) from f)                   as pool_floor_enforced,
  (select count(*) filter (where separated and not rank_earned) from f)  as moved_without_a_rank,
  (select count(*) filter (where rank_earned and not separated) from f)  as ranked_without_moving,
  (select coalesce(bool_and(abs(delta - (window_mean - season_mean)) < 0.002), true) from f)
                                                                        as delta_is_consistent,
  (select coalesce(bool_and(std_error >= 0), true) from f)                as errors_non_negative,
  (select coalesce(bool_and(reliability_6 between 0 and 1
                        and reliability_season between 0 and 1), true) from f)
                                                                        as reliabilities_in_range,
  -- A six-match figure can never be more reliable than the season it is drawn from.
  (select coalesce(bool_and(reliability_6 <= reliability_season + 0.002), true) from f)
                                                                        as six_never_beats_season,
  (select coalesce(bool_and(metric_rank is null) filter (where not rank_earned), true) from f)
                                                                        as ungated_ranks_are_null,
  (select coalesce(bool_and(metric_rank between 1 and pool) filter (
            where metric_rank is not null), true) from f)                as rank_within_pool,
  (select coalesce(bool_and(window_mean between 0 and 1 and season_mean between 0 and 1) filter (
            where metric = 'defcon_hit'), true) from f)                  as defcon_hit_is_a_rate,
  (select count(*) filter (where metric in ('defcon_hit', 'cbit') and element_type = 1) from f)
                                                                        as keeper_defcon_rows,
  (select coalesce(bool_and(form_word in ('up on his season', 'down on his season',
                                          'in line with his season')), true) from f)
                                                                        as words_are_known,

  -- The zero-variance trap, asserted three ways because it produced 182 confident false claims
  -- before it was caught. A player whose figure never moved must not be described as having moved.
  (select count(*) filter (where std_error = 0) from f)                  as zero_variance_rows,
  (select coalesce(bool_and(not separated) filter (where std_error = 0), true) from f)
                                                                        as flat_never_separated,
  (select coalesce(bool_and(not separated) filter (where delta = 0), true) from f)
                                                                        as no_delta_never_separated,
  (select coalesce(bool_and(form_word = 'in line with his season') filter (
            where delta = 0), true) from f)                              as no_delta_reads_in_line,
  -- The boolean and the sentence must never disagree, which is what two copies of the comparison
  -- caused. This is the assertion that keeps them one definition.
  (select coalesce(bool_and((form_word = 'in line with his season') = (not separated)), true)
     from f)                                                            as word_agrees_with_gate,

  -- Big chances must not earn a six-match rank on this data — asserted as a measurement, not a
  -- hardcoded exclusion. If a future season makes it reliable, this flips and that is a finding.
  (select coalesce(bool_and(not rank_earned) filter (where metric = 'big_chances'), true)
     from rel)                                                          as big_chances_unranked,
  (select round(max(reliability_6) filter (where metric = 'big_chances'), 2) from rel)
                                                                        as big_chances_best_rel,
  (select round(max(reliability_6) filter (where metric = 'box_touches'), 2) from rel)
                                                                        as box_touches_best_rel;

-- ---------------------------------------------------------------------------
-- rotation_pairs_check — 20.0s -> one scan each
-- ---------------------------------------------------------------------------
drop view if exists rotation_pairs_check cascade;
create view rotation_pairs_check as
with p as materialized (
  select * from rotation_pairs
),
cg as materialized (
  select * from rotation_club_gameweek
),
w as materialized (
  select first_gameweek, last_gameweek, 1 + last_gameweek - first_gameweek as span
  from rotation_window
)
select
  (select count(*) from cg)                                             as club_gameweeks,
  (select count(*) from p)                                              as pairs,
  (select count(distinct axis) from p)                                  as axes,

  -- The grid must be complete: 20 clubs × the window, blanks included as zero-fixture rows.
  (select count(*) from cg) = 20 * (select span from w)                  as grid_is_complete,
  (select count(*) filter (where fixtures = 0) from cg)                  as blank_club_gameweeks,
  (select count(*) filter (where fixtures > 1) from cg)                  as double_club_gameweeks,
  -- A blank must contribute nothing to either axis, never a flattering default.
  (select coalesce(bool_and(defensive_easiness = 0 and attacking_easiness = 0) filter (
            where fixtures = 0), true) from cg)                          as blank_contributes_zero,
  -- A probability cannot exceed 1 however many fixtures a club has that week.
  (select coalesce(bool_and(attacking_easiness between 0 and 1), true) from cg)
                                                                        as attacking_is_a_probability,
  -- Expected clean sheets is additive and MAY exceed 1 over a double. Asserting otherwise would be
  -- asserting the trap rather than against it.
  (select coalesce(bool_and(defensive_easiness >= 0), true) from cg)      as defensive_non_negative,

  -- Pair construction, one scan.
  (select coalesce(bool_and(team_a <> team_b), true) from p)              as never_same_club,
  (select coalesce(bool_and(code_a < code_b), true) from p)               as each_pair_once,
  (select coalesce(bool_and(price_a <= 5.0 and price_b <= 5.0), true) from p)
                                                                        as price_cap_enforced,
  (select coalesce(bool_and(minutes_a >= 0.50 and minutes_b >= 0.50), true) from p)
                                                                        as both_are_regulars,
  -- A rotation fills one squad slot, so the two must play the same position. Grouping by axis
  -- alone paired a goalkeeper with a centre-back.
  (select coalesce(bool_and(position_a = position_b), true) from p)       as same_position_only,
  (select coalesce(bool_and(n = 1), true) from (
     select position_a, least(team_a, team_b) t1, greatest(team_a, team_b) t2, count(*) n
     from p group by 1, 2, 3) x)                                        as one_row_per_club_pair,

  -- The score. Rotating can never be worse than owning the better of the two.
  (select coalesce(bool_and(pair_score >= best_single_score), true) from p)
                                                                        as pair_beats_single,
  (select coalesce(bool_and(rotation_gain > 0), true) from p)             as gain_is_positive,
  (select coalesce(bool_and(gameweeks = (select span from w)), true) from p)
                                                                        as every_pair_spans_window,

  -- Independent re-derivation of every pair's score from the club-gameweek rows rather than a
  -- restatement of the view's own sum. Against the materialised CTEs, so it is one pass.
  (select coalesce(bool_and(abs(rp.pair_score - x.recomputed) < 0.002), true)
     from p rp
     join lateral (
       select sum(case when rp.axis = 'defensive'
                       then greatest(ca.defensive_easiness, cb.defensive_easiness)
                       else greatest(ca.attacking_easiness, cb.attacking_easiness) end) as recomputed
       from cg ca
       join cg cb on cb.team_code = rp.team_b and cb.gameweek = ca.gameweek
       where ca.team_code = rp.team_a
     ) x on true)                                                       as score_recomputes;

-- ---------------------------------------------------------------------------
-- fixture_percentage_check — 4.3s, and it read player_wide twice
-- ---------------------------------------------------------------------------
drop view if exists fixture_percentage_check cascade;
create view fixture_percentage_check as
with f as materialized (
  select * from team_fixture_context
),
pw as materialized (
  select fixture_count, p_team_scores, p_clean_sheet from player_wide
)
select
  (select count(*) from f)                                              as clubs_with_fixture,
  (select count(*) filter (where p_team_scores is not null) from pw)     as players_covered,
  -- A blanking club must reach the screen as unknown, never as 0%.
  (select count(*) filter (where fixture_count = 0) from pw)             as blanking_players,
  (select coalesce(bool_and(p_team_scores is null and p_clean_sheet is null) filter (
            where fixture_count = 0), true) from pw)                     as blank_reads_unknown,

  (select coalesce(bool_and(p_team_scores between 0 and 1
                        and p_team_scores_2plus between 0 and 1
                        and p_clean_sheet between 0 and 1), true) from f) as probs_in_range,
  (select coalesce(bool_and(p_team_scores_2plus <= p_team_scores), true) from f)
                                                                        as tail_ordered,

  -- Independent derivation rather than a restatement: these expressions must agree with the ones
  -- `captain_picks` computes per fixture. Same mathematics, different aggregation.
  (select count(*) from captain_picks)                                  as captain_rows,
  (select coalesce(bool_and(abs(c.p_team_scores - tf.p_team_scores) < 0.0002), true)
     from captain_picks c
     join player_seasons ps on ps.player_code = c.player_code
                           and ps.season = (select current_season from season_context)
     join f tf on tf.team_code = ps.team_code
    where tf.fixture_count = 1)                                         as agrees_with_captain_picks,

  (select count(*) filter (where fixture_count > 1) from f)              as double_gameweek_clubs,
  (select coalesce(bool_and(abs(expected_clean_sheets - p_clean_sheet) < 0.0002) filter (
            where fixture_count = 1), true) from f)                      as single_gw_cs_identical,
  (select coalesce(bool_and(p_clean_sheet <= expected_clean_sheets + 0.0002), true) from f)
                                                                        as probability_never_exceeds_expectation,
  (select count(*) filter (where fixture_count = 0) from f)              as zero_fixture_rows,
  (select coalesce(bool_and(n = 1), true) from (
     select team_code, count(*) n from f group by 1) x)                  as one_row_per_club;
