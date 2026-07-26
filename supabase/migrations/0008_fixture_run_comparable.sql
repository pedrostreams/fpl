-- ---------------------------------------------------------------------------
-- 0008 — make the fixture run comparable across teams, and bound elo_now to today
-- ---------------------------------------------------------------------------
-- Supersedes 0007's definitions of all four views. `elo_now` changes, and every other view
-- depends on it, so `drop ... cascade` takes them all and they are rebuilt here. 0007 is left
-- in place as the historical record of where the fitted constants came from — they are
-- unchanged, and this migration touches no arithmetic in the model itself.
--
-- TWO PROBLEMS, both found by simulating a season in progress rather than by reading the SQL
-- (`fixture_run` looked correct; nothing in the data is `finished` yet, so it had never been
-- exercised against the state it will spend the entire season in).
--
-- 1. MID-GAMEWEEK, TEAMS HAVE DIFFERENT WINDOWS.
--    The horizon is a set of six gameweeks, but a gameweek spans Friday to Monday. With
--    GW1's Saturday played, simulation gave:
--
--      MCI  6 fixtures  GW1-6  xWins 3.467
--      ARS  5 fixtures  GW2-6  xWins 3.419
--
--    `avg_difficulty` survives this — it is a mean. The SUMS do not, and the sums are what
--    the ticker showed as its headline. A team looked worse purely for having already played.
--    Fix: publish per-fixture rates alongside the totals, so the comparable quantity and the
--    accumulated quantity are both available and neither has to be inferred. The totals stay
--    because they are the right answer to "how much upside in total" — which is exactly what
--    a double gameweek changes and a per-fixture rate hides.
--
-- 2. `elo_now` READ A FUTURE-DATED ROW.
--    ClubElo splits its current rating across forward-dated rows (Arsenal on 2026-07-26 had
--    rows starting 2026-05-31, 08-22 and 08-31, all at 2063.8), and `order by valid_from desc`
--    picked the furthest-future one. Verified harmless today: no club's future rows disagree,
--    and all 20 match the row covering today. But it is only harmless as long as ClubElo never
--    forward-publishes a projection, and reading a projection as today's strength would be
--    silent. Bounded to `valid_from <= current_date`.

-- ---------------------------------------------------------------------------
drop view if exists elo_now cascade;
create view elo_now as
select distinct on (e.team_code)
  e.team_code,
  e.elo,
  e.rank as elo_rank,
  e.valid_from as elo_as_of
from club_elo e
where e.team_code is not null
  -- Today's strength, never a forward-dated row. Falls back to the most recent started
  -- period if ClubElo leaves a gap, which is the correct behaviour for a carried rating.
  and e.valid_from <= current_date
order by e.team_code, e.valid_from desc;

-- ---------------------------------------------------------------------------
-- fixture_difficulty — unchanged from 0007 except for being rebuilt after the cascade.
-- Constants remain those fitted by scripts/probe/calibrate_elo_fixtures.py; see the 0007
-- header for the fit quality.
-- ---------------------------------------------------------------------------
drop view if exists fixture_difficulty cascade;
create view fixture_difficulty as
with ctx as (select current_season from season_context),
sided as (
  select f.season, f.fpl_id, f.event, f.kickoff_time, f.finished,
         f.team_h_code as team_code, f.team_a_code as opponent_code,
         true as is_home, f.team_h_difficulty as fpl_difficulty
  from fixtures f
  where f.team_h_code is not null and f.team_a_code is not null
  union all
  select f.season, f.fpl_id, f.event, f.kickoff_time, f.finished,
         f.team_a_code, f.team_h_code,
         false, f.team_a_difficulty
  from fixtures f
  where f.team_h_code is not null and f.team_a_code is not null
),
rated as (
  select
    s.*,
    es.elo as elo_self,
    eo.elo as elo_opponent,
    (es.elo + case when s.is_home then 47.358409 else 0 end)
      - (eo.elo + case when s.is_home then 0 else 47.358409 end) as elo_edge
  from sided s
  join ctx on s.season = ctx.current_season
  left join elo_now es on es.team_code = s.team_code
  left join elo_now eo on eo.team_code = s.opponent_code
),
probs as (
  select
    r.*,
    1.0 / (1.0 + power(10.0, -r.elo_edge / 400.0)) as score_share,
    0.268800 * exp(-power(r.elo_edge / 397.358743, 2)) as p_draw_raw
  from rated r
),
split as (
  select
    p.*,
    greatest(p.score_share - 0.5 * p.p_draw_raw, 0.0001)       as p_win_raw,
    greatest(1.0 - p.score_share - 0.5 * p.p_draw_raw, 0.0001) as p_lose_raw
  from probs p
),
normed as (
  select
    s.*,
    s.p_win_raw + s.p_draw_raw + s.p_lose_raw as denom,
    exp(0.191729 + 0.477618 * ((s.elo_self - s.elo_opponent) / 400.0)
        + case when s.is_home then 0.215463 else 0.0 end) as lambda_for,
    exp(0.191729 + 0.477618 * ((s.elo_opponent - s.elo_self) / 400.0)
        + case when s.is_home then 0.0 else 0.215463 end) as lambda_against
  from split s
)
select
  n.season,
  n.fpl_id,
  n.event                                          as gameweek,
  n.kickoff_time,
  n.finished,
  n.team_code,
  n.opponent_code,
  n.is_home,
  n.fpl_difficulty,
  round(n.elo_self::numeric, 1)                    as elo_self,
  round(n.elo_opponent::numeric, 1)                as elo_opponent,
  round(n.elo_edge::numeric, 1)                    as elo_edge,
  round((n.p_win_raw / n.denom)::numeric, 4)       as p_win,
  round((n.p_draw_raw / n.denom)::numeric, 4)      as p_draw,
  round((n.p_lose_raw / n.denom)::numeric, 4)      as p_lose,
  round(n.lambda_for::numeric, 3)                  as expected_goals_for,
  round(n.lambda_against::numeric, 3)              as expected_goals_against,
  round(exp(-n.lambda_against)::numeric, 4)        as p_clean_sheet,
  round((1.0 - n.p_win_raw / n.denom)::numeric, 4) as difficulty,
  round(greatest(0.0, least(1.0, 1.0 - n.lambda_for / 2.75))::numeric, 4)
                                                   as attack_difficulty,
  round(greatest(0.0, least(1.0, n.lambda_against / 2.75))::numeric, 4)
                                                   as defence_difficulty
from normed n
where n.elo_self is not null and n.elo_opponent is not null;

-- ---------------------------------------------------------------------------
-- fixture_run — each team's remaining fixtures in the next six gameweeks
-- ---------------------------------------------------------------------------
-- Both a rate and a total for every metric. The rate answers "who has the kinder run", the
-- total answers "who accumulates more", and the two diverge exactly when the window differs:
-- mid-gameweek, or across a blank or a double. `fixtures` is published so a reader can always
-- see which of the two they are looking at and why they disagree.
drop view if exists fixture_run cascade;
create view fixture_run as
with horizon as (
  select distinct gameweek
  from fixture_difficulty
  where not coalesce(finished, false) and gameweek is not null
  order by gameweek
  limit 6
)
select
  fd.team_code,
  count(*)                                        as fixtures,
  min(fd.gameweek)                                as first_gameweek,
  max(fd.gameweek)                                as last_gameweek,
  count(distinct fd.gameweek)                     as gameweeks_with_fixture,
  count(*) filter (where fd.is_home)              as home_fixtures,
  -- Rates: comparable across teams whatever the window.
  round(avg(fd.difficulty), 4)                    as avg_difficulty,
  round(avg(fd.attack_difficulty), 4)             as avg_attack_difficulty,
  round(avg(fd.defence_difficulty), 4)            as avg_defence_difficulty,
  round(avg(fd.p_win), 4)                         as p_win_per_fixture,
  round(avg(fd.expected_goals_for), 3)            as xg_for_per_fixture,
  round(avg(fd.p_clean_sheet), 4)                 as p_clean_sheet_per_fixture,
  -- Totals: what a manager actually accumulates, and where a double shows up as a gain.
  round(sum(fd.expected_goals_for), 3)            as expected_goals_for,
  round(sum(fd.expected_goals_against), 3)        as expected_goals_against,
  round(sum(fd.p_clean_sheet), 3)                 as expected_clean_sheets,
  round(sum(fd.p_win), 3)                         as expected_wins
from fixture_difficulty fd
join horizon h on h.gameweek = fd.gameweek
where not coalesce(fd.finished, false)
group by fd.team_code;

-- ---------------------------------------------------------------------------
-- fixture_difficulty_check — for `python -m sync.cli verify`
-- ---------------------------------------------------------------------------
drop view if exists fixture_difficulty_check cascade;
create view fixture_difficulty_check as
select
  count(*)                                                       as rows,
  count(distinct team_code)                                      as teams,
  bool_and(abs(p_win + p_draw + p_lose - 1.0) < 0.0005)           as probabilities_sum_to_1,
  bool_and(difficulty between 0 and 1)                           as difficulty_in_range,
  bool_and(attack_difficulty between 0 and 1
       and defence_difficulty between 0 and 1)                    as position_difficulty_in_range,
  bool_and(p_clean_sheet between 0 and 1)                        as clean_sheet_in_range,
  (max(p_win) filter (where is_home) > max(p_win) filter (where not is_home))
                                                                 as home_advantage_present,
  round(avg(expected_goals_for), 3)                              as avg_expected_goals,
  round(avg(p_clean_sheet), 3)                                   as avg_p_clean_sheet,
  -- Rate x fixtures must reconstruct the total, or one of the two is lying.
  (select bool_and(abs(expected_wins - p_win_per_fixture * fixtures) < 0.01)
     from fixture_run)                                           as run_rate_matches_total,
  -- Informational, not a fault: >1 means teams have differently-sized windows, which is the
  -- normal state mid-gameweek and the reason the rates exist.
  (select count(distinct fixtures) from fixture_run)              as distinct_window_sizes,
  -- elo_now must never read a forward-dated row.
  (select bool_and(elo_as_of <= current_date) from elo_now)       as elo_is_not_future_dated
from fixture_difficulty;
