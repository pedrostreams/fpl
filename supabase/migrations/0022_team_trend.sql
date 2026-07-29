-- ---------------------------------------------------------------------------
-- 0022_team_trend.sql — the trend layer, reduced to what a window can actually detect
-- ---------------------------------------------------------------------------
-- The other half of docs/feat/trend-claims.md. Migration 0021 carries the style section,
-- which is the main deliverable; this is the small passenger that rides along.
--
-- WHY IT IS SMALL
-- A permutation test over 2025-26 -- shuffle each club's own 38 matches 20 000-40 000 times,
-- ask how often a random window of N falls at least as far from the season mean as the actual
-- last N -- found 8.5% of 272 club-metric-window tests at p < 0.05, against the 5.0% noise
-- gives by construction. Requiring the effect at two or more window lengths leaves 8 of 102
-- club-metric pairs over 6 of 17 clubs. Everything that survived is a near-doubling:
--
--   AVL expected goals for      0.86 -> 1.59      NEW expected goals conceded  0.77 -> 1.65
--   SUN deep completions created 3.17 -> 6.03
--
-- **A window resolves changes of roughly +/-50% and nothing subtler.** That is an information
-- limit, not an implementation weakness, and 0021's rel(6) = 0.13-0.48 says the same thing
-- from the other direction: a six-match mean is about a third signal.
--
-- Simulating September's shape -- this season's first N against an independent baseline rather
-- than against the season containing it -- gave 6 pairs over 5 clubs, marginally WORSE. The
-- independent baseline does nothing about the variance of the 6-match mean itself, which is
-- where the noise lives. So there is no version of this that gets better by waiting.
--
-- THE CHEAP STATISTIC, AND WHY THE CORRECTION IS NOT OPTIONAL
-- The permutation test is the reference and cannot live in a view, so a z-score was fitted to
-- it. Sampling n of a club's N matches happens WITHOUT replacement, so the finite-population
-- correction belongs in the standard error; without it every z comes out too small and the
-- filter passes claims the permutation test rejects:
--
--   fpc = sqrt((N - n) / (N - 1))
--   se  = stddev(season) / sqrt(n) * fpc
--   z   = (window_mean - season_mean) / se
--
-- |z| >= 1.95 agrees with the permutation test on 406 of 408 cases (one false positive, one
-- false negative). That is essentially the normal critical value, but it was measured rather
-- than assumed -- the mean of four matches is not normally distributed, and the correction and
-- the non-normality happen to cancel. scripts/probe/prove_style_claims.py re-runs the
-- permutation test against this view and fails if they stop agreeing.
--
-- ELO DRIFT IS THE ONLY HONEST "NOW"
-- Everything above describes a completed season, because Understat is all we have and it ends
-- in May. Elo drift is the one signal that is about the present, and the only one covering all
-- 20 clubs -- the three promoted sides have no Understat season at all.
--
-- Its threshold is not invented either. `elo_goal_effect_pct` runs the drift through the
-- goal-model coefficient that scripts/probe/calibrate_elo_fixtures.py fitted and migration
-- 0008 uses, so "notable" means "moves this club's expected goals by at least 3%", which is
-- about the smallest change worth a sentence. 3% is 25 Elo points.
--
-- **That coefficient now appears in two migrations, which is how two numbers drift apart.**
-- So `trend_check` recovers it from `fixture_difficulty`'s own output by regressing
-- ln(expected_goals_for) on elo_edge/400 and fails if the two copies disagree. Verified
-- 2026-07-29: recovers 0.477616 against the stated 0.477618, the gap being the 3-decimal
-- rounding on the published column.

-- ---------------------------------------------------------------------------
-- elo_goal_model — the fitted constants, named once in this migration
-- ---------------------------------------------------------------------------
-- Migration 0008 inlines these in `fixture_difficulty`. Naming them here at least makes the
-- duplication visible and gives `trend_check` something to compare against.
drop view if exists elo_goal_model cascade;
create view elo_goal_model as
select
  0.477618::double precision as elo_per_400,   -- goal-model slope on (elo_self - elo_opponent)/400
  3.0::double precision      as notable_pct,   -- |effect on expected goals| worth a sentence
  1.95::double precision     as trend_z,       -- calibrated against the permutation test
  2::int                     as trend_windows, -- ... and required to hold at this many lengths
  20::int                    as min_season_matches,
  40.0::double precision     as opposition_elo_gap;  -- when to state the opposition control

-- ---------------------------------------------------------------------------
-- team_match_context — who a club played, and how strong they were that day
-- ---------------------------------------------------------------------------
-- `club_elo` is a dated series, so opponent strength on the day is available rather than
-- opponent strength today. That matters both ways: Crystal Palace's collapse last season came
-- against opposition 62 Elo STRONGER, which strengthens the claim rather than explaining it.
--
-- Opponent Elo is null for matches against the three relegated clubs. ClubElo rates them, but
-- reaching the rating needs a `teams.code` and they have none, so the join cannot be made.
-- That is 102 of 646 club-matches and it is not random -- the missing opponents are the weak
-- ones -- so the counts are published alongside the averages and the opposition control is
-- only stated when a window has complete coverage. An average over the 4 of 6 matches whose
-- opponents happen to be rated is worse than no average.
drop view if exists team_match_context cascade;
create view team_match_context as
select
  m.season,
  m.team_code,
  m.game_id,
  m.kickoff,
  m.is_home,
  m.opponent_team_code,
  oe.elo as opponent_elo
from understat_team_match m
left join lateral (
  select e.elo from club_elo e
  where e.team_code = m.opponent_team_code
    and e.valid_from <= m.kickoff::date
  order by e.valid_from desc
  limit 1
) oe on true
where m.team_code is not null;

-- ---------------------------------------------------------------------------
-- team_trend — the +/-50% class, and nothing else
-- ---------------------------------------------------------------------------
drop view if exists team_trend cascade;
create view team_trend as
with cfg as (select * from elo_goal_model),
ordered as (
  select
    m.season, m.team_code, m.metric, m.value, m.game_id,
    row_number() over (
      partition by m.season, m.team_code, m.metric order by m.kickoff desc
    ) as recency
  from team_match_metric m
  join style_metric sm on sm.metric = m.metric
  where m.value is not null and sm.in_trend
),
season_stats as (
  select season, team_code, metric,
         count(*)             as n_season,
         avg(value)           as season_mean,
         stddev_samp(value)   as season_sd
  from ordered
  group by season, team_code, metric
  having count(*) >= (select min_season_matches from cfg)
),
-- Adjacent window lengths share most of their matches, so a real change persists across them
-- and a fluke does not. That is the whole reason the robustness rule is "2 or more".
windowed as (
  select
    o.season, o.team_code, o.metric, w.n as window_n,
    avg(o.value) as window_mean,
    count(*)     as matched
  from ordered o
  cross join (values (4), (6), (8), (10)) as w(n)
  where o.recency <= w.n
  group by o.season, o.team_code, o.metric, w.n
),
scored as (
  select
    w.season, w.team_code, w.metric, w.window_n, w.window_mean,
    s.n_season, s.season_mean, s.season_sd,
    sqrt((s.n_season - w.window_n)::double precision / (s.n_season - 1)) as fpc,
    (w.window_mean - s.season_mean) / nullif(
      s.season_sd / sqrt(w.window_n::double precision)
        * sqrt((s.n_season - w.window_n)::double precision / (s.n_season - 1)), 0
    ) as z
  from windowed w
  join season_stats s
    on s.season = w.season and s.team_code = w.team_code and s.metric = w.metric
  -- A window shorter than it claims to be is not that window.
  where w.matched = w.window_n
),
held as (
  select
    season, team_code, metric,
    count(*) filter (where abs(z) >= (select trend_z from cfg)) as windows_held,
    count(*)                                                    as windows_tested
  from scored
  group by season, team_code, metric
),
-- Opposition strength over the same window, by recency, so the control covers exactly the
-- matches the claim is about.
opp as (
  select
    c.season, c.team_code, w.n as window_n,
    avg(c.opponent_elo)                            as window_opponent_elo,
    count(c.opponent_elo)                          as window_opp_known
  from (
    select cx.*, row_number() over (
             partition by cx.season, cx.team_code order by cx.kickoff desc
           ) as recency
    from team_match_context cx
  ) c
  cross join (values (4), (6), (8), (10)) as w(n)
  where c.recency <= w.n
  group by c.season, c.team_code, w.n
),
opp_season as (
  select season, team_code,
         avg(opponent_elo)   as season_opponent_elo,
         count(opponent_elo) as season_opp_known,
         count(*)            as season_matches
  from team_match_context
  group by season, team_code
),
picked as (
  -- One row per club per metric: the window where the change reads loudest among those that
  -- held. Reporting all four would be the same claim four times.
  select distinct on (s.season, s.team_code, s.metric)
    s.*, h.windows_held, h.windows_tested
  from scored s
  join held h
    on h.season = s.season and h.team_code = s.team_code and h.metric = s.metric
  where h.windows_held >= (select trend_windows from cfg)
    and abs(s.z) >= (select trend_z from cfg)
  order by s.season, s.team_code, s.metric, abs(s.z) desc
)
select
  p.season,
  p.team_code,
  p.metric,
  sm.label,
  sm.short_label,
  sm.unit,
  sm.direction,
  p.window_n,
  p.windows_held,
  p.windows_tested,
  p.n_season,
  round(p.window_mean::numeric, 3)                            as window_mean,
  round(p.season_mean::numeric, 3)                            as season_mean,
  round((p.window_mean - p.season_mean)::numeric, 3)          as delta,
  round((100 * (p.window_mean - p.season_mean)
              / nullif(p.season_mean, 0))::numeric, 1)        as delta_pct,
  round(p.season_sd::numeric, 3)                              as season_sd,
  round(p.fpc::numeric, 3)                                    as fpc,
  round(p.z::numeric, 2)                                      as z,
  -- Better or worse AFTER the metric's own direction is applied. Conceding less is improving;
  -- creating less is worsening. This is the heatmap's "colour means better, never bigger" trap
  -- in a new place, and trend_check asserts it rather than trusting it.
  -- PPDA is the only direction-'none' metric in the trend layer, and "changed" tells a reader
  -- nothing. It gets a description instead of a verdict, which is the same rule /teams already
  -- follows: a low number is an aggressive press, not a good team. trend_check asserts PPDA is
  -- still the only such metric, so adding another forces this wording to be generalised rather
  -- than silently mislabelling it.
  case
    when sm.direction = 'none' then
      case when p.window_mean > p.season_mean then 'sitting deeper' else 'pressing higher' end
    when (sm.direction = 'high') = (p.window_mean > p.season_mean) then 'improving'
    else 'worsening'
  end                                                         as direction_word,
  -- Never "now" about a completed season. `basis` decides the tense at the render site.
  case when p.season = (select current_season from season_context)
       then 'in_season' else 'last_season' end                as basis,
  round(o.window_opponent_elo::numeric, 0)                    as window_opponent_elo,
  round(os.season_opponent_elo::numeric, 0)                   as season_opponent_elo,
  o.window_opp_known,
  p.window_n - o.window_opp_known                             as window_opp_missing,
  -- Stated only on complete coverage, and only when the gap is big enough to matter. The
  -- missing opponents are the relegated clubs, so a partial average is biased strong.
  case
    when o.window_opp_known < p.window_n then null
    when abs(o.window_opponent_elo - os.season_opponent_elo)
         < (select opposition_elo_gap from cfg) then null
    else round((o.window_opponent_elo - os.season_opponent_elo)::numeric, 0)
  end                                                         as opposition_gap,
  -- The sentence, naming the window and the comparison as honesty rule 2 requires. A bare
  -- "improving" is exactly what this layer must never emit.
  format('%s over the last %s of %s: %s against %s for the season',
         sm.label, p.window_n, p.season,
         round(p.window_mean::numeric, 2), round(p.season_mean::numeric, 2))
                                                              as phrase
from picked p
join style_metric sm on sm.metric = p.metric
left join opp o
  on o.season = p.season and o.team_code = p.team_code and o.window_n = p.window_n
left join opp_season os
  on os.season = p.season and os.team_code = p.team_code;

-- ---------------------------------------------------------------------------
-- team_elo_drift — the only claim that is honestly about now, and covers all 20 clubs
-- ---------------------------------------------------------------------------
-- In preseason both windows are flat: measured 2026-07-29, the 30-day drift is exactly 0.0 for
-- all 20 clubs because ClubElo carries a rating forward when nobody plays. That is the correct
-- output, not a bug, and `notable_30` is false for everyone as a result.
drop view if exists team_elo_drift cascade;
create view team_elo_drift as
with cfg as (select * from elo_goal_model),
base as (
  select
    t.code                        as team_code,
    e0.elo                        as elo,
    e0.valid_from                 as elo_as_of,
    e0.elo - e30.elo              as drift_30,
    e0.elo - e90.elo              as drift_90
  from teams t
  join team_seasons ts
    on ts.team_code = t.code and ts.season = (select current_season from season_context)
  -- Today's rating, never a forward-dated row: club_elo carries rows into the future, which is
  -- the trap migration 0008 fixed for elo_now.
  left join lateral (
    select e.elo, e.valid_from from club_elo e
    where e.team_code = t.code and e.valid_from <= current_date
    order by e.valid_from desc limit 1
  ) e0 on true
  left join lateral (
    select e.elo from club_elo e
    where e.team_code = t.code and e.valid_from <= current_date - 30
    order by e.valid_from desc limit 1
  ) e30 on true
  left join lateral (
    select e.elo from club_elo e
    where e.team_code = t.code and e.valid_from <= current_date - 90
    order by e.valid_from desc limit 1
  ) e90 on true
)
select
  b.team_code,
  round(b.elo::numeric, 0)        as elo,
  b.elo_as_of,
  round(b.drift_30::numeric, 1)   as drift_30,
  round(b.drift_90::numeric, 1)   as drift_90,
  -- What the drift does to this club's expected goals, through the model the app already
  -- fitted. An Elo number means nothing to a reader; a percentage of expected goals does.
  round((100 * (exp((select elo_per_400 from cfg) * b.drift_30 / 400.0) - 1))::numeric, 1)
                                  as goal_effect_30_pct,
  round((100 * (exp((select elo_per_400 from cfg) * b.drift_90 / 400.0) - 1))::numeric, 1)
                                  as goal_effect_90_pct,
  (abs(100 * (exp((select elo_per_400 from cfg) * b.drift_30 / 400.0) - 1))
     >= (select notable_pct from cfg))                        as notable_30,
  (abs(100 * (exp((select elo_per_400 from cfg) * b.drift_90 / 400.0) - 1))
     >= (select notable_pct from cfg))                        as notable_90,
  case when b.drift_90 > 0 then 'rising' when b.drift_90 < 0 then 'falling' else 'flat' end
                                  as direction_word
from base b;

-- ---------------------------------------------------------------------------
-- trend_check
-- ---------------------------------------------------------------------------
drop view if exists trend_check cascade;
create view trend_check as
select
  (select count(*) from team_trend)                                as trend_claims,
  (select count(distinct team_code) from team_trend)                as clubs_with_a_trend,
  (select count(distinct metric) from team_trend)                   as metrics_with_a_trend,
  -- The ratio metric must not appear: a window mean of its numerator would carry its label.
  (select count(*) from team_trend where metric = 'dead_share')      as ratio_leaked,
  -- The robustness rule and the sample floor, asserted rather than trusted.
  (select bool_and(windows_held >= 2) from team_trend)              as two_windows_held,
  (select bool_and(n_season >= 20) from team_trend)                 as season_sample_ok,
  (select bool_and(abs(z) >= 1.95) from team_trend)                 as z_above_threshold,
  -- The finite-population correction shrinks the standard error and can never do otherwise.
  (select bool_and(fpc > 0 and fpc <= 1) from team_trend)           as fpc_in_range,
  -- Direction after the metric's own direction is applied. Conceding less is improving.
  (select bool_and(
            case when direction = 'none' then (direction_word = 'sitting deeper') = (delta > 0)
                 when direction = 'high' then (direction_word = 'improving') = (delta > 0)
                 else (direction_word = 'improving') = (delta < 0)
            end)
     from team_trend)                                               as direction_respects_metric,
  -- A verdict is never printed on a metric with no better end. Press changes get described.
  (select bool_and(direction_word in ('sitting deeper', 'pressing higher'))
     from team_trend where direction = 'none')                      as press_described_not_judged,
  -- The descriptive wording above is PPDA-specific. If a second direction-'none' metric joins
  -- the trend layer, this fails and the wording has to be generalised instead of misapplied.
  (select count(*) from style_metric where direction = 'none' and in_trend)
                                                                   as none_metrics_in_trend,
  -- Nothing may claim to be about this season until this season has been played.
  (select count(*) from team_trend
    where basis = 'in_season'
      and not (select season_started from season_context))          as premature_in_season,
  -- Honesty rule 2: the window and the comparison are named in the sentence itself.
  (select bool_and(phrase like '%last ' || window_n || '%'
                   and phrase like '%' || season || '%'
                   and phrase like '%for the season%')
     from team_trend)                                               as phrase_names_window,
  -- Honesty rule 3, and the bias it guards against: a partial opponent average is biased
  -- strong, because the unrated opponents are exactly the relegated clubs.
  (select bool_and(opposition_gap is null) from team_trend
    where window_opp_missing > 0)                                   as no_gap_on_partial_coverage,
  (select bool_and(abs(opposition_gap) >= 40) from team_trend
    where opposition_gap is not null)                               as gap_only_when_material,
  (select count(*) from team_trend where opposition_gap is not null) as claims_with_a_gap_stated,
  -- Elo drift covers every club in the league, including the promoted three that have no
  -- Understat season. If this is not 20, the one signal that reaches them has a hole in it.
  (select count(*) from team_elo_drift)                            as clubs_with_drift,
  (select count(*) from team_elo_drift where elo is null)           as clubs_missing_elo,
  (select count(*) from team_elo_drift where notable_30)            as notable_30_day,
  (select count(*) from team_elo_drift where notable_90)            as notable_90_day,
  -- Zero drift must read as flat, never as a direction. Reported with its own row count,
  -- because `bool_and` over an empty set is NULL and a NULL check asserts nothing while
  -- looking like it passed -- which is what this originally did.
  (select bool_and(direction_word = 'flat') from team_elo_drift where drift_90 = 0)
                                                                   as zero_drift_is_flat,
  (select count(*) from team_elo_drift where drift_90 = 0)          as zero_drift_rows,
  -- These two always have all 20 rows, so they cannot go vacuous. They are what would catch a
  -- sign error or a wrong-signed coefficient in the goal-effect conversion, and the 30-day
  -- pair is fully exercised in preseason when every drift is flat.
  (select bool_and(sign(goal_effect_90_pct) = sign(drift_90)) from team_elo_drift)
                                                                   as effect_sign_tracks_drift,
  (select bool_and((drift_30 = 0) = (goal_effect_30_pct = 0)) from team_elo_drift)
                                                                   as zero_drift_zero_effect,
  (select bool_and(not notable_30) from team_elo_drift where drift_30 = 0)
                                                                   as flat_is_never_notable,
  -- The fitted coefficient is inlined in migration 0008 as well, so recover it from that
  -- view's own output and fail if the two copies have drifted apart. Home fixtures only: the
  -- home term is a constant within the group and would otherwise bias the intercept.
  (select abs(regr_slope(ln(expected_goals_for::double precision),
                         elo_edge::double precision / 400.0)
              - (select elo_per_400 from elo_goal_model)) < 0.001
     from fixture_difficulty
    where is_home and expected_goals_for > 0)                       as elo_coefficient_agrees,
  (select round(regr_slope(ln(expected_goals_for::double precision),
                           elo_edge::double precision / 400.0)::numeric, 6)
     from fixture_difficulty where is_home and expected_goals_for > 0)
                                                                   as elo_coefficient_recovered;
