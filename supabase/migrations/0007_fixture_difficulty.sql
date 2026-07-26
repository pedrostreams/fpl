-- ---------------------------------------------------------------------------
-- 0007 — forward-looking fixture difficulty from Elo, calibrated to the market
-- ---------------------------------------------------------------------------
-- The problem this solves is resolution, not direction. FPL's own FDR orders fixtures
-- sensibly — our difficulty rises monotonically across its buckets, 0.43 / 0.64 / 0.74 /
-- 0.88 — but it has four usable values for 760 team-fixtures (2:209, 3:342, 4:171, 5:38, no
-- 1s at all, verified 2026-07-26), and 45% of the season lands in bucket 3. Inside that one
-- bucket our model spans **0.194 to 0.955**: FPL rates a near-certain win and a near-certain
-- defeat identically. That is the information a transfer decision needs and an integer
-- cannot carry.
--
-- And `fixture_odds` cannot fill the gap, because it is built from football-data.co.uk's
-- `E0.csv`, which only publishes matches already played: 380 rows for 2025-26, every one with
-- a final score, none in the future. There is no bookmaker price for a fixture six weeks out.
--
-- So difficulty comes from ClubElo, which covers all 20 clubs including the promoted three
-- and is forward-looking by construction. The constants below are NOT invented — they are
-- fitted by `scripts/probe/calibrate_elo_fixtures.py` against the 272 matches of 2025-26
-- where both clubs are in the current league, using each side's Elo as of that match date.
--
-- Fit quality, 2026-07-26 (re-run the script after a season and update these numbers):
--   Result model, target = de-vigged market 1X2
--     cross-entropy 1.0281 against a floor of 1.0142 — 1.4% above the best possible
--     MAE on P(home win) 0.053, versus 0.123 for always predicting the league average
--     Spearman vs market 0.923 — it ranks fixtures in essentially the market's order
--   Goal model, target = actual goals scored, 544 side-observations
--     implied home scoring ratio 1.240
--     P(clean sheet) by quartile of prediction: 0.181/0.169, 0.237/0.206, 0.283/0.272,
--     0.346/0.353 (predicted/observed) — monotone and close
--
-- Honest about what it is: a two-parameter model of a football match. It cannot know that a
-- team has three centre-backs injured or is playing a Thursday night in Baku. It is
-- materially better than an integer 2-3-4, and it says so on the page.

-- ---------------------------------------------------------------------------
-- elo_now — each club's current rating
-- ---------------------------------------------------------------------------
-- ClubElo publishes one row per rating period with `valid_from`/`valid_to`, and carries the
-- current rating forward on future-dated rows. For an upcoming fixture the right input is
-- today's strength, not a rating stamped with the fixture's date.
drop view if exists elo_now cascade;
create view elo_now as
select distinct on (e.team_code)
  e.team_code,
  e.elo,
  e.rank as elo_rank,
  e.valid_from as elo_as_of
from club_elo e
where e.team_code is not null
order by e.team_code, e.valid_from desc;

-- ---------------------------------------------------------------------------
-- fixture_difficulty — one row per team per upcoming fixture
-- ---------------------------------------------------------------------------
drop view if exists fixture_difficulty cascade;
create view fixture_difficulty as
with ctx as (select current_season from season_context),
-- Both sides of every fixture, so a team's whole run reads off one table.
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
    -- Home advantage, in Elo points, fitted against the market: 47.358409.
    -- Lower than the ~65 usually quoted, which is consistent with the decline in home
    -- advantage since 2020 rather than a bug — the fit is checked against a 30-120 range.
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
    -- Elo's expected score share: P(win) + 0.5*P(draw). Not P(win) on its own.
    1.0 / (1.0 + power(10.0, -r.elo_edge / 400.0)) as score_share,
    -- P(draw) peaks between level sides and decays with the mismatch. Gaussian in the Elo
    -- difference: the simplest shape with that behaviour and no discontinuity.
    -- Fitted: peak 0.268800 at level, falling to 1/e at 397.358743 points.
    0.268800 * exp(-power(r.elo_edge / 397.358743, 2)) as p_draw_raw
  from rated r
),
split as (
  select
    p.*,
    -- A large enough mismatch can push the loser's share below zero, so clip before
    -- renormalising. A probability vector that doesn't sum to 1 is worse than a clipped one.
    greatest(p.score_share - 0.5 * p.p_draw_raw, 0.0001)       as p_win_raw,
    greatest(1.0 - p.score_share - 0.5 * p.p_draw_raw, 0.0001) as p_lose_raw
  from probs p
),
normed as (
  select
    s.*,
    s.p_win_raw + s.p_draw_raw + s.p_lose_raw as denom,
    -- Poisson scoring rates. log(lambda) = base + slope*(elo diff)/400 + boost if home.
    -- Fitted on actual goals: base 0.191729, slope 0.477618, home boost 0.215463
    -- (exp(0.215463) = 1.240x, the home side's scoring multiplier).
    -- Note this uses the RAW Elo difference, not elo_edge: the result model's home
    -- advantage and the goal model's are separately fitted quantities and mixing them
    -- would double-count the venue.
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
  -- P(opponent scores 0) under Poisson. This is the number that decides a defender or
  -- keeper's ceiling, and it is the reason the ticker is split by position below.
  round(exp(-n.lambda_against)::numeric, 4)        as p_clean_sheet,
  -- Three difficulties, all on 0 = easiest, 1 = hardest, all continuous and venue-aware.
  -- Deliberately three and not one: an easy fixture for a striker and an easy fixture for a
  -- centre-back are different fixtures, and the single-number FDR is exactly what hides it.
  round((1.0 - n.p_win_raw / n.denom)::numeric, 4) as difficulty,
  -- Attacking: how hard it is to score. Scaled by the league's ~1.37 goals per side per
  -- match so 0.5 sits near an average fixture rather than at an arbitrary point.
  round(greatest(0.0, least(1.0, 1.0 - n.lambda_for / 2.75))::numeric, 4)
                                                   as attack_difficulty,
  -- Defensive: how hard it is to keep a clean sheet.
  round(greatest(0.0, least(1.0, n.lambda_against / 2.75))::numeric, 4)
                                                   as defence_difficulty
from normed n
where n.elo_self is not null and n.elo_opponent is not null;

-- ---------------------------------------------------------------------------
-- fixture_run — each team's next N gameweeks, aggregated
-- ---------------------------------------------------------------------------
-- The ticker's "who has the best run" question. Aggregated in SQL rather than in the client
-- because double gameweeks make it a genuine sum, not an average: two fixtures in one
-- gameweek is two chances at points, and a blank is none.
drop view if exists fixture_run cascade;
create view fixture_run as
with horizon as (
  -- The next six gameweeks that still have unplayed fixtures. Anchored on the data, not on
  -- the clock, so it behaves the same in preseason as mid-season.
  select distinct gameweek
  from fixture_difficulty
  -- coalesce, not `not finished`: the column is nullable and `not null` is null, which
  -- would silently drop every fixture the API hasn't stamped yet.
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
  round(avg(fd.difficulty), 4)                    as avg_difficulty,
  round(avg(fd.attack_difficulty), 4)             as avg_attack_difficulty,
  round(avg(fd.defence_difficulty), 4)            as avg_defence_difficulty,
  -- Sums, not averages: this is the quantity a manager actually accumulates over the run,
  -- and it is where a double gameweek shows up as an advantage.
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
-- Every invariant the model must satisfy, as one row of booleans. A view rather than a
-- Python assertion so it is checkable straight from psql too.
drop view if exists fixture_difficulty_check cascade;
create view fixture_difficulty_check as
select
  count(*)                                                       as rows,
  count(distinct team_code)                                      as teams,
  -- 380 fixtures x 2 sides, if every club resolved to an Elo rating.
  bool_and(abs(p_win + p_draw + p_lose - 1.0) < 0.0005)          as probabilities_sum_to_1,
  bool_and(difficulty between 0 and 1)                           as difficulty_in_range,
  bool_and(attack_difficulty between 0 and 1
       and defence_difficulty between 0 and 1)                   as position_difficulty_in_range,
  bool_and(p_clean_sheet between 0 and 1)                        as clean_sheet_in_range,
  -- The strongest side at home must be favoured over the weakest side away. If this flips,
  -- a sign is wrong somewhere in the Elo edge.
  (max(p_win) filter (where is_home) > max(p_win) filter (where not is_home))
                                                                 as home_advantage_present,
  round(avg(expected_goals_for), 3)                              as avg_expected_goals,
  round(avg(p_clean_sheet), 3)                                   as avg_p_clean_sheet
from fixture_difficulty;
