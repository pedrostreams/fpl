-- ---------------------------------------------------------------------------
-- 0021_team_style.sql — playing style as a measured property, carrying its own error bars
-- ---------------------------------------------------------------------------
-- Replaces the wish in docs/LATER.md item 2 ("you should target Brentford, their current
-- trend is that they are not conceding shots") with the thing that survived measuring it.
-- Full reasoning in docs/feat/trend-claims.md; the short version is that a rolling window is
-- mostly noise and a season figure is not, so the club page gets a style section and the
-- trend layer (migration 0022) shrinks to what a window can actually detect.
--
-- WHY SEASON FIGURES AND NOT A FORM WINDOW
-- Reliability of a k-match club mean, measured below: a 6-match mean is 0.13-0.48 signal, a
-- 38-match mean is 0.49-0.85. The same club, the same metric, the same season -- the only
-- difference is how many matches went into the average. That single fact is the design.
--
-- TWO GATES, NOT ONE
-- These answer different questions and the earlier design conflated them:
--
--   1. `rank_earned` (reliability >= 0.60) -- may the league be ORDERED on this metric at all?
--      Reliability is about the ordering: it compares real between-club spread against the
--      noise in one club's own figure. Below 0.60 the middle of the table is arbitrary, so
--      `metric_rank` comes back NULL and no call site can render a rank the data cannot carry.
--
--   2. `separated` (|value - league mean| >= 2 x that club's own standard error) -- may THIS
--      club be named? A metric can be too noisy to order while still having outliers that are
--      unambiguous. Dead-ball share is exactly that case: reliability 0.49, so no rank, yet
--      five clubs sit more than two of their own standard errors from the league mean, and
--      "Newcastle lean on set pieces, Liverpool do not" is a true and useful sentence.
--
--      Without gate 2, the app's most actionable style axis would have been silenced by a
--      statistic that was never about individual clubs.
--
--      The comparison is against the mean of 17 club figures, which carries its own sampling
--      error, so strictly var(club - league mean) = var_club x (1 - 2/17) + ... ~= 0.94
--      var_club. Using the club's error alone therefore understates z by about 3%, which is
--      the conservative direction, and is why it is left alone rather than corrected.
--
-- THE DECOMPOSITION
-- The observed spread of club figures already contains within-club noise, so it is removed
-- before use -- this is an intraclass correlation, computed over every club-match rather
-- than from a split-half correlation across 17 clubs. That distinction matters: the split-half
-- estimator has a standard error of about +/-0.27 at n=17 and it produced two numbers in the
-- feature doc that were simply wrong (PPDA 0.48, dead ball 0.62).
--
--   var_noise   = mean over clubs of (that club's own standard error)^2
--   var_between = var(club figures) - var_noise          -- floored at 0
--   reliability = var_between / (var_between + var_noise)
--
-- ONE FORMULA, TWO KINDS OF FIGURE
-- Seven metrics are per-match means, where standard error is sd/sqrt(n). The eighth,
-- dead-ball share, is sum(dead-ball xG)/sum(non-penalty xG) -- a ratio of two correlated
-- sums, where sd/sqrt(n) is meaningless. Its standard error comes from the delta method:
--
--   var(N/D) ~= var(N)/D^2 + N^2 var(D)/D^4 - 2 N cov(N,D)/D^3      (N, D per-match means)
--
-- Validated against a 6 000-draw within-club bootstrap, 2026-07-29: the two agree to within
-- 0.2-2.8% on all 17 clubs (delta slightly the more conservative). **The covariance term is
-- not a refinement.** A club that attacks more has a larger numerator AND denominator;
-- dropping the term overstates the error by up to 60% and would silence real outliers.
--
-- Feeding both kinds through the same `var_noise` makes the decomposition uniform, and for a
-- mean it reduces exactly to the classic var(means) - var_within/n.
--
-- MEASURED 2026-07-29 over 646 club-matches (17 clubs x 38; the three promoted sides have no
-- Understat season, and the three relegated ones are opponents only):
--
--   metric                      between sd  within sd  rel(38)  rel(6)   what the page says
--   Deep completions created         1.462      3.723     0.85    0.48   holds all season
--   Shots taken                      1.474      4.685     0.79    0.37   holds all season
--   PPDA                             1.576      5.162     0.78    0.36   holds all season
--   Expected goals created           0.254      0.836     0.78    0.36   holds all season
--   Shots conceded                   1.257      4.467     0.75    0.32   holds all season
--   Deep completions conceded        0.996      3.654     0.74    0.31   fairly consistent
--   Dead-ball share of npxG              -          -     0.49       -   varies match to match
--   Expected goals conceded          0.132      0.825     0.49    0.13   varies match to match
--
-- Expected goals conceded is the finding. Over a FULL season, "this club concedes fewer
-- expected goals" is close to a coin flip -- which is worth knowing given that /teams shades
-- xGA and the Defenders and Goalkeepers views rank on xGC, and which vindicates building
-- fixture_difficulty on Elo instead.
--
-- **These are not constants.** Nothing here is hardcoded: the views recompute from whatever
-- matches exist, the numbers above are a dated record of one run, and reliability rises with
-- match count, so the set of metrics that earn a rank should grow through the season.
-- scripts/probe/prove_style_claims.py re-derives them independently and fails on drift.
--
-- ENUM VALUES ARE SPACE-SEPARATED. 'From Corner', 'Set Piece', 'Direct Freekick',
-- 'Open Play', 'Penalty', and result 'Own Goal'. The comment on understat_shots.situation in
-- migration 0002 still shows the pre-repair spelling ('SetPiece'), which is how a set-piece
-- query came back all zeros during this work. sync/sources/understat_raw.py repairs the three
-- values soccerdata drops; docs/DATA_SOURCES.md 3.1 has the detail.

-- ---------------------------------------------------------------------------
-- team_match_metric — one row per club per match per metric
-- ---------------------------------------------------------------------------
-- Long rather than wide so the decomposition, the ranks and the trend layer are each written
-- once instead of once per metric. `denom` is null for a mean and populated for the one
-- ratio, which is what lets a single formula serve both.
--
-- Shots conceded is (shots in the game) - (shots by this club) rather than a join on
-- opponent_team_code, deliberately: the three relegated clubs are not in `teams`, so their
-- team_code is null, and joining on it silently dropped every match against them -- 17 x 6 =
-- 102 of 646 club-matches. That is exactly the gap that made an earlier measurement read 544.
drop view if exists team_match_metric cascade;
create view team_match_metric as
with shot_team as (
  select season, game_id, team_code,
         count(*)                                                                as shots,
         sum(xg)                                                                 as np_xg,
         sum(xg) filter (
           where situation in ('From Corner', 'Set Piece', 'Direct Freekick')
         )                                                                       as dead_xg
  from understat_shots
  where result <> 'Own Goal' and situation <> 'Penalty' and team_code is not null
  group by season, game_id, team_code
),
shot_game as (
  select season, game_id, count(*) as shots
  from understat_shots
  where result <> 'Own Goal' and situation <> 'Penalty'
  group by season, game_id
),
base as (
  select
    m.season, m.team_code, m.game_id, m.kickoff,
    m.xg, m.opponent_xg, m.deep_completions, m.opponent_deep_completions, m.ppda,
    -- A club that took no shots took zero shots; a game with no shot rows at all is missing
    -- data. Coalescing the first to 0 is correct and coalescing the second would invent a
    -- zero, so the game-level count gates both.
    case when g.shots is null then null else coalesce(s.shots, 0)             end as shots_for,
    case when g.shots is null then null else g.shots - coalesce(s.shots, 0)   end as shots_conceded,
    case when g.shots is null then null else coalesce(s.dead_xg, 0)           end as dead_xg,
    case when g.shots is null then null else coalesce(s.np_xg, 0)             end as np_xg_shots
  from understat_team_match m
  left join shot_team s
    on s.season = m.season and s.game_id = m.game_id and s.team_code = m.team_code
  left join shot_game g
    on g.season = m.season and g.game_id = m.game_id
  where m.team_code is not null
)
select season, team_code, game_id, kickoff,
       'deep_for'::text as metric,
       deep_completions::double precision as value,
       null::double precision as denom
from base
union all
select season, team_code, game_id, kickoff, 'shots_for',
       shots_for::double precision, null::double precision from base
union all
select season, team_code, game_id, kickoff, 'xg',
       xg::double precision, null::double precision from base
union all
-- The only ratio. Numerator and denominator are null together by construction above, so the
-- `value is not null` filter downstream keeps the two sums over identical rows.
select season, team_code, game_id, kickoff, 'dead_share',
       dead_xg::double precision, np_xg_shots::double precision from base
union all
select season, team_code, game_id, kickoff, 'deep_conc',
       opponent_deep_completions::double precision, null::double precision from base
union all
select season, team_code, game_id, kickoff, 'shots_conc',
       shots_conceded::double precision, null::double precision from base
union all
select season, team_code, game_id, kickoff, 'xga',
       opponent_xg::double precision, null::double precision from base
union all
select season, team_code, game_id, kickoff, 'ppda',
       ppda::double precision, null::double precision from base;

-- ---------------------------------------------------------------------------
-- style_metric — the metric catalogue, the team-side twin of lib/columns.ts
-- ---------------------------------------------------------------------------
-- Registered once, here, because reliability, ranking and phrasing all need the same facts
-- about a metric and three copies would drift. Groups are ordered by how firm the property
-- is, not by convention: what a side CREATES is a firmer property than what it CONCEDES.
--
-- `direction` drives shading and obeys the DESIGN.md rule that colour means better and never
-- bigger. `rank_asc` is separate and drives the ordering, because the two genuinely differ
-- for PPDA: there is a meaningful order (rank 1 = the most aggressive press, as on /teams)
-- but no better end, so it ranks with direction 'none' and gets no colour.
drop view if exists style_metric cascade;
create view style_metric as
-- `in_trend` excludes the one ratio from the trend layer in 0022. A window mean of the
-- numerator (dead-ball xG per match) is a perfectly good series, but it would be labelled
-- "dead-ball share of xG" and mean something else, so it is left out explicitly rather than
-- by whichever column happens to be null.
select * from (values
  -- metric,       group,       g_ord, ord, label,                        short,        unit,        dir,    rank_asc, dp, pct, trend
  ('deep_for',    'create',       1, 1, 'Deep completions created',   'Box entries',  'per match', 'high', false, 2, false, true,
   'Passes completed within 20 m of the opponent goal, per match. The most persistent attacking property in the data.'),
  ('shots_for',   'create',       1, 2, 'Shots taken',                'Shots',        'per match', 'high', false, 1, false, true,
   'Non-penalty shots per match, counted from Understat shot events rather than a summary field.'),
  ('xg',          'create',       1, 3, 'Expected goals created',     'xG',           'per match', 'high', false, 2, false, true,
   'Expected goals per match, all situations.'),
  ('dead_share',  'dead_ball',    2, 1, 'Dead-ball share of xG',      'Dead ball',    'of npxG',   'high', false, 1, true,  false,
   'Share of non-penalty expected goals coming from corners, set pieces and direct free kicks. Penalties are excluded — a penalty is not a style.'),
  ('shots_conc',  'concede',      3, 1, 'Shots conceded',             'Shots against','per match', 'low',  true,  1, false, true,
   'Non-penalty shots faced per match.'),
  ('deep_conc',   'concede',      3, 2, 'Deep completions conceded',  'Box entries against', 'per match', 'low', true, 2, false, true,
   'Opponent passes completed within 20 m of goal, per match. How often a side is played through rather than shot at.'),
  ('xga',         'concede',      3, 3, 'Expected goals conceded',    'xGA',          'per match', 'low',  true,  2, false, true,
   'Expected goals faced per match. Shown without a rank: over a full season this separates clubs barely better than chance.'),
  ('ppda',        'press',        4, 1, 'Passes allowed per defensive action', 'PPDA', 'per match', 'none', true, 1, false, true,
   'Opponent passes allowed per defensive action. Low means an aggressive high press, high means sitting deep. A style, not a virtue.')
) as v(metric, metric_group, group_order, sort_order, label, short_label, unit,
       direction, rank_asc, decimals, as_percent, in_trend, blurb);

-- ---------------------------------------------------------------------------
-- style_rank_noun — what "2nd of 17" is 2nd AT, from either end
-- ---------------------------------------------------------------------------
-- Only needed where the ordering is not simply "best": PPDA ranks with direction 'none', so a
-- bare "2nd of 17" begs the question. Kept in SQL rather than in the component for the same
-- reason as style_phrase — wording a check can read.
--
-- Both ends, because one is not enough. Crystal Palace sat deepest in the league and read
-- "17th most aggressive of 17", which is a contortion for "least aggressive". The render site
-- counts from whichever end is nearer.
drop view if exists style_rank_noun cascade;
create view style_rank_noun as
select * from (values
  ('ppda', 'most aggressive', 'least aggressive')
) as v(metric, rank_noun, rank_noun_low);

-- ---------------------------------------------------------------------------
-- style_group — the four groups, named and ordered
-- ---------------------------------------------------------------------------
drop view if exists style_group cascade;
create view style_group as
select * from (values
  ('create',    1, 'Create',    'What they do with the ball. The firmest properties in the data.'),
  ('dead_ball', 2, 'Dead ball', 'What decides whether this club''s defenders and target men are worth owning.'),
  ('concede',   3, 'Concede',   'What they give up. Measurably less consistent than what they create.'),
  ('press',     4, 'Press',     'Where they defend from. A description, not a virtue.')
) as v(metric_group, group_order, title, note);

-- ---------------------------------------------------------------------------
-- style_phrase — how a separated club is described, per metric per side
-- ---------------------------------------------------------------------------
-- Text lives in SQL rather than the component so `style_check` can assert on it and so the
-- honesty rules are enforced where they are defined. `position_hint` is the FPL read: which
-- position this style makes worth owning. Null where the answer is "none" — PPDA changes
-- nothing about who to pick, and saying otherwise would be invention.
drop view if exists style_phrase cascade;
create view style_phrase as
select * from (values
  ('deep_for',   'high', 'works the ball into the box more than most',        'Midfielders and forwards'),
  ('deep_for',   'low',  'rarely plays through the opponent box',             null),
  ('shots_for',  'high', 'shoots more often than most',                      'Midfielders and forwards'),
  ('shots_for',  'low',  'takes few shots',                                  null),
  ('xg',         'high', 'creates more than most',                           'Midfielders and forwards'),
  ('xg',         'low',  'creates little',                                   null),
  ('dead_share', 'high', 'leans on set pieces for its goal threat',          'Defenders and target men'),
  ('dead_share', 'low',  'scores almost everything in open play',            'Midfielders and forwards'),
  ('shots_conc', 'high', 'concedes shots freely',                            null),
  ('shots_conc', 'low',  'concedes few shots',                               'Defenders and the goalkeeper'),
  ('deep_conc',  'high', 'lets opponents play through its box',              null),
  ('deep_conc',  'low',  'keeps opponents out of its box',                   'Defenders and the goalkeeper'),
  ('xga',        'high', 'concedes chances freely',                          null),
  ('xga',        'low',  'concedes little of quality',                       'Defenders and the goalkeeper'),
  ('ppda',       'high', 'sits deep rather than pressing',                   null),
  ('ppda',       'low',  'presses high up the pitch',                        null)
) as v(metric, side, clause, position_hint);

-- ---------------------------------------------------------------------------
-- team_style_metric — one row per club per metric: the figure, its error bar, its standing
-- ---------------------------------------------------------------------------
drop view if exists team_style_metric cascade;
create view team_style_metric as
with per_club as (
  select
    season, team_code, metric,
    count(*)                  as matches,
    avg(value)                as mean_value,
    var_samp(value)           as var_value,
    sum(value)                as sum_value,
    sum(denom)                as sum_denom,
    avg(denom)                as mean_denom,
    var_samp(denom)           as var_denom,
    covar_samp(value, denom)  as cov_value_denom
  from team_match_metric
  where value is not null
  group by season, team_code, metric
  -- A season figure needs a season. Below 20 matches the "full season" framing is a lie, and
  -- trend_check in 0022 asserts the same floor for the same reason.
  having count(*) >= 20
),
valued as (
  select
    p.season, p.team_code, p.metric, p.matches,
    case when p.sum_denom is null then p.mean_value
         else p.sum_value / nullif(p.sum_denom, 0) end                              as value,
    -- sd/sqrt(n) for a mean; the delta method for the ratio. See the header for why the
    -- covariance term stays and what it was validated against.
    case when p.sum_denom is null
         then sqrt(p.var_value / p.matches)
         else sqrt(
                greatest(
                    p.var_value / (p.mean_denom * p.mean_denom)
                  + p.mean_value * p.mean_value * p.var_denom / power(p.mean_denom, 4)
                  - 2 * p.mean_value * p.cov_value_denom / power(p.mean_denom, 3),
                  0
                ) / p.matches
              )
    end                                                                             as std_error
  from per_club p
),
decomp as (
  select
    season, metric,
    count(*)                                                  as clubs,
    avg(matches)                                              as matches_per_club,
    avg(value)                                                as league_mean,
    avg(std_error * std_error)                                as var_noise,
    greatest(var_samp(value) - avg(std_error * std_error), 0)  as var_between
  from valued
  group by season, metric
),
joined as (
  select
    v.season, v.team_code, v.metric, v.matches, v.value, v.std_error,
    d.clubs, d.matches_per_club, d.league_mean, d.var_noise, d.var_between,
    d.var_between / nullif(d.var_between + d.var_noise, 0)                    as reliability,
    -- Reliability of a 6-match figure. The delta variance is O(1/n), so scaling the measured
    -- noise by n/6 projects both kinds of figure the same way.
    d.var_between
      / nullif(d.var_between + d.var_noise * d.matches_per_club / 6, 0)       as reliability_6,
    sm.metric_group, sm.group_order, sm.sort_order, sm.label, sm.short_label,
    sm.unit, sm.direction, sm.rank_asc, sm.decimals, sm.as_percent, sm.blurb,
    rn.rank_noun, rn.rank_noun_low,
    rank() over (
      partition by v.season, v.metric
      order by case when sm.rank_asc then v.value else -v.value end
    )                                                                          as raw_rank,
    -- cume_dist, never percent_rank: they disagree on ties, and 1.0 must mean "best at this"
    -- whichever way the metric runs. Null for direction 'none' — PPDA has an order but no
    -- better end, so it must not be shaded.
    case when sm.direction = 'none' then null
         else cume_dist() over (
                partition by v.season, v.metric
                order by case when sm.direction = 'low' then -v.value else v.value end
              )
    end                                                                        as raw_percentile
  from valued v
  join decomp d on d.season = v.season and d.metric = v.metric
  join style_metric sm on sm.metric = v.metric
  left join style_rank_noun rn on rn.metric = v.metric
)
select
  j.season,
  j.team_code,
  j.metric,
  j.label,
  j.short_label,
  j.unit,
  j.blurb,
  j.metric_group,
  j.group_order,
  j.sort_order,
  j.direction,
  j.rank_noun,
  j.rank_noun_low,
  j.matches,
  round(j.value::numeric, 4)                                      as value,
  -- Pre-formatted for display, because the number of decimals is a property of the metric and
  -- belongs with the metric. A share renders as a percentage; everything else as a rate.
  case when j.as_percent
       then to_char((j.value * 100)::numeric, 'FM9990.' || repeat('0', j.decimals)) || '%'
       else to_char(j.value::numeric, 'FM9990.' || repeat('0', j.decimals))
  end                                                             as display_value,
  round(j.std_error::numeric, 4)                                  as std_error,
  round(j.league_mean::numeric, 4)                                as league_mean,
  case when j.as_percent
       then to_char((j.league_mean * 100)::numeric, 'FM9990.' || repeat('0', j.decimals)) || '%'
       else to_char(j.league_mean::numeric, 'FM9990.' || repeat('0', j.decimals))
  end                                                             as display_league_mean,
  j.clubs                                                         as pool,
  round(j.matches_per_club::numeric, 1)                           as matches_per_club,
  round(sqrt(j.var_between)::numeric, 4)                          as sd_between,
  round(sqrt(j.var_noise)::numeric, 4)                            as sd_noise,
  round(j.reliability::numeric, 3)                                as reliability,
  round(j.reliability_6::numeric, 3)                              as reliability_6,
  -- In words, never as a coefficient. A reader cannot weigh 0.49 against 0.85, and a claim at
  -- 0.85 must not look like one at 0.49.
  case when j.reliability >= 0.75 then 'holds all season'
       when j.reliability >= 0.60 then 'fairly consistent'
       else 'varies match to match'
  end                                                             as reliability_word,
  -- The same fact, but answering the question a reader of ONE club's page actually has: can I
  -- trust this number here? `reliability_word` is about the league ordering, and printing it
  -- alone made Newcastle's page contradict itself — the headline said "leans on set pieces"
  -- while the row beside it said "varies match to match". Both were true: dead-ball share
  -- cannot order the league, and Newcastle still sits 2.3 of its own error bars clear of it.
  -- So where the two gates disagree, say so instead of printing only the half that scans as a
  -- retraction.
  case when j.reliability >= 0.75 then 'holds all season'
       when j.reliability >= 0.60 then 'fairly consistent'
       when abs((j.value - j.league_mean) / nullif(j.std_error, 0)) >= 2
         then 'varies, but clear of the league'
       else 'varies match to match'
  end                                                             as standing_word,
  -- The tier exists so the component can style the three cases without containing any of the
  -- three strings. That is what keeps the reliability wording a measurement rather than a
  -- literal sitting in a React file.
  case when j.reliability >= 0.75 then 3
       when j.reliability >= 0.60 then 2
       else 1
  end                                                             as reliability_tier,
  (j.reliability >= 0.60)                                         as rank_earned,
  -- Gate 1. Null unless the ordering is supported, so no caller can render an unearned rank.
  case when j.reliability >= 0.60 then j.raw_rank end              as metric_rank,
  case when j.reliability >= 0.60 then round(j.raw_percentile::numeric, 3) end as percentile,
  -- Gate 2. How far this club sits from the league mean in units of its OWN error bar. Works
  -- at any reliability, because it is a statement about one club rather than about an order.
  round(((j.value - j.league_mean) / nullif(j.std_error, 0))::numeric, 2) as separation_z,
  (abs((j.value - j.league_mean) / nullif(j.std_error, 0)) >= 2)   as separated
from joined j;

-- ---------------------------------------------------------------------------
-- team_style_reliability — the decomposition on its own, one row per metric
-- ---------------------------------------------------------------------------
-- What the probe re-derives and what FIX_WHEN_LIVE.md asks to be re-read after GW6, GW12 and
-- GW19. `discrimination` is sd_between divided by one club's standard error, which is
-- identically sqrt(rel/(1-rel)) — the same fact in the units a reader can picture: how many
-- error bars wide the league is.
drop view if exists team_style_reliability cascade;
create view team_style_reliability as
select distinct
  season, metric, label, metric_group, group_order, sort_order, direction,
  pool as clubs, matches_per_club, sd_between, sd_noise,
  reliability, reliability_6, reliability_word, reliability_tier, rank_earned,
  round((sd_between / nullif(sd_noise, 0))::numeric, 2) as discrimination
from team_style_metric;

-- ---------------------------------------------------------------------------
-- team_dead_ball — the readable breakdown behind the share
-- ---------------------------------------------------------------------------
-- `team_profile` already carries corners and headers. This adds the rest of the dead ball and
-- the denominator, so the page can show where the threat comes from rather than only how much
-- of it there is.
drop view if exists team_dead_ball cascade;
create view team_dead_ball as
select
  s.season,
  s.team_code,
  round(sum(s.xg) filter (where s.situation = 'From Corner')::numeric, 2)      as corner_xg,
  count(*) filter (where s.situation = 'From Corner')                          as corner_shots,
  count(*) filter (where s.situation = 'From Corner' and s.result = 'Goal')    as corner_goals,
  round(sum(s.xg) filter (where s.situation = 'Set Piece')::numeric, 2)        as set_piece_xg,
  round(sum(s.xg) filter (where s.situation = 'Direct Freekick')::numeric, 2)  as free_kick_xg,
  count(*) filter (where s.situation = 'Direct Freekick' and s.result = 'Goal') as free_kick_goals,
  round(sum(s.xg) filter (
    where s.situation in ('From Corner', 'Set Piece', 'Direct Freekick')
  )::numeric, 2)                                                               as dead_ball_xg,
  count(*) filter (
    where s.situation in ('From Corner', 'Set Piece', 'Direct Freekick') and s.result = 'Goal'
  )                                                                            as dead_ball_goals,
  round(sum(s.xg)::numeric, 2)                                                 as np_xg,
  round(sum(s.xg) filter (where s.situation = 'Open Play')::numeric, 2)        as open_play_xg
from understat_shots s
where s.result <> 'Own Goal' and s.situation <> 'Penalty' and s.team_code is not null
group by s.season, s.team_code;

-- ---------------------------------------------------------------------------
-- team_style_claim — the sentences a club has earned, strongest first
-- ---------------------------------------------------------------------------
-- Only separated metrics appear: eleven of seventeen clubs get few or no claims, and saying
-- nothing is the correct output. The phrase names the season and the comparison because a
-- bare "presses high" invites the reader to hear "currently", and every number here describes
-- a completed season.
drop view if exists team_style_claim cascade;
create view team_style_claim as
select
  m.season,
  m.team_code,
  m.metric,
  m.label,
  m.metric_group,
  m.value,
  m.display_value,
  m.display_league_mean,
  m.std_error,
  m.separation_z,
  m.metric_rank,
  m.pool,
  m.reliability,
  m.reliability_word,
  m.reliability_tier,
  p.side,
  p.clause,
  p.position_hint,
  format('%s in %s — %s %s against a league %s',
         p.clause, m.season, m.display_value, m.unit, m.display_league_mean)  as phrase,
  row_number() over (
    partition by m.season, m.team_code order by abs(m.separation_z) desc
  )                                                                           as strength
from team_style_metric m
join style_phrase p
  on p.metric = m.metric
 and p.side = case when m.separation_z > 0 then 'high' else 'low' end
where m.separated;

-- ---------------------------------------------------------------------------
-- team_style_read — one line per club, tying style to which position to own
-- ---------------------------------------------------------------------------
-- The sentence docs/LATER.md item 2 asked for, with 38 matches behind it instead of 6.
-- Clubs with no separated metric are absent rather than present-and-empty; the page renders
-- the three-kinds-of-absent rule from DESIGN.md.
--
-- **Every position hint must follow from a clause the reader can see.** Taking the two
-- strongest claims for the sentence and then the strongest hint from anywhere produced
-- Tottenham as "creates little and rarely plays through the opponent box -> Defenders and
-- target men", where the recommendation came from a third claim (their dead-ball share) that
-- the sentence never mentioned. It reads as a non-sequitur because it is one.
--
-- So the sentence takes the two strongest claims as before, except that a claim naming a
-- position the lead does not is promoted ahead of a merely louder number. The hint is the
-- actionable half of the sentence, so it earns its place; everything else keeps the old
-- ordering. That also stopped City losing half their read — they keep opponents out of their
-- own box and work the ball into the other one, which is worth owning at both ends.
--
-- Requiring a *different* hint outright was the first attempt and it was worse: Liverpool
-- work the ball into the box and score almost everything in open play, both of which point at
-- midfielders, and the second clause was dropped for agreeing with the first.
drop view if exists team_style_read cascade;
create view team_style_read as
with lead_claim as (
  select * from team_style_claim where strength = 1
)
select
  l.season,
  l.team_code,
  (select count(*) from team_style_claim c
    where c.season = l.season and c.team_code = l.team_code)              as claims,
  concat_ws(' and ', l.clause, other.clause)                             as summary,
  -- nullif on the second hint so a club whose two clauses point the same way does not read
  -- "Midfielders and forwards · Midfielders and forwards".
  nullif(concat_ws(' · ', l.position_hint,
                   nullif(other.position_hint, l.position_hint)), '')     as position_hint,
  l.metric                                                               as lead_metric,
  l.separation_z                                                         as lead_z,
  l.reliability_tier                                                     as top_tier
from lead_claim l
left join lateral (
  select c.clause, c.position_hint
  from team_style_claim c
  where c.season = l.season
    and c.team_code = l.team_code
    and c.strength > 1
  order by
    -- A claim naming a position the lead does not comes first; otherwise the next strongest.
    (c.position_hint is not null
       and (l.position_hint is null or c.position_hint <> l.position_hint)) desc,
    c.strength
  limit 1
) other on true;

-- ---------------------------------------------------------------------------
-- style_check
-- ---------------------------------------------------------------------------
drop view if exists style_check cascade;
create view style_check as
select
  (select count(*) from team_match_metric)                          as metric_rows,
  (select count(distinct metric) from team_match_metric)            as metrics,
  (select count(*) from style_metric)                               as registered_metrics,
  -- Every registered metric produces rows, and no metric produces rows without being
  -- registered. A typo in the union would otherwise vanish quietly.
  (select count(*) from team_match_metric m
    where not exists (select 1 from style_metric s where s.metric = m.metric)) as unregistered_rows,
  -- A rank noun only makes sense on a metric that ranks, and every direction-'none' metric
  -- that ranks needs one or its rank reads as "2nd of 17" at nothing in particular.
  (select count(*) from style_rank_noun n
    where not exists (select 1 from style_metric s where s.metric = n.metric)) as orphan_rank_nouns,
  -- Both ends are needed, not one: a rank at the bottom of the pool is counted from the
  -- bottom, so a metric with only the "most" noun would read "17th most aggressive of 17".
  (select bool_and(rank_noun is not null and rank_noun_low is not null)
     from team_style_metric where direction = 'none' and rank_earned) as ranked_none_has_noun,
  (select count(*) from team_style_metric)                          as club_metric_rows,
  (select count(distinct team_code) from team_style_metric)          as clubs_with_style,
  -- Every club with style data carries the full set, so a page never renders a ragged grid.
  (select bool_and(n = (select count(*) from style_metric))
     from (select team_code, count(*) as n from team_style_metric group by team_code) t)
                                                                     as every_club_full_set,
  -- Gate 1, both ways. An unearned rank must be null, and an earned one must be present.
  (select bool_and(metric_rank is null) from team_style_metric where not rank_earned)
                                                                     as unreliable_never_ranked,
  (select bool_and(metric_rank is not null) from team_style_metric where rank_earned)
                                                                     as reliable_always_ranked,
  (select string_agg(distinct metric, ', ') from team_style_metric where not rank_earned)
                                                                     as unranked_metrics,
  -- The words are a function of the measurement, not an editorial choice.
  (select bool_and((reliability >= 0.75) = (reliability_word = 'holds all season'))
     from team_style_metric)                                         as word_matches_top_band,
  (select bool_and((reliability >= 0.60) = (reliability_tier >= 2)) from team_style_metric)
                                                                     as tier_matches_gate,
  -- The reconciling wording appears exactly where the two gates disagree, and nowhere else.
  (select bool_and((standing_word = 'varies, but clear of the league')
                   = (not rank_earned and separated))
     from team_style_metric)                                        as standing_reconciles_gates,
  (select bool_and(reliability between 0 and 1) from team_style_metric)
                                                                     as reliability_in_range,
  -- A 6-match figure can never be more reliable than the season figure it is a subset of.
  -- If this ever fails the projection is wrong, not the data.
  (select bool_and(reliability_6 <= reliability + 1e-9) from team_style_metric)
                                                                     as six_never_beats_season,
  -- Shading follows direction: no colour where there is no better end.
  (select bool_and(percentile is null) from team_style_metric where direction = 'none')
                                                                     as no_shade_without_direction,
  (select bool_and(percentile between 0 and 1) from team_style_metric
    where percentile is not null)                                    as percentile_in_range,
  -- Gate 2 is what it claims to be.
  (select bool_and(separated = (abs(separation_z) >= 2)) from team_style_metric)
                                                                     as separation_consistent,
  (select count(*) from team_style_metric where separated)            as separated_rows,
  (select count(*) from team_style_claim)                            as claims,
  (select count(*) from team_style_read)                             as clubs_with_a_read,
  (select bool_and(summary is not null and claims >= 1) from team_style_read)
                                                                     as read_always_says_something,
  -- The non-sequitur guard. Every position hint printed on a club's line must come from a
  -- clause printed on the same line, or the reader is told to buy defenders on the strength of
  -- a claim they cannot see.
  (select bool_and(
            not exists (
              select 1 from regexp_split_to_table(r.position_hint, ' · ') as h(hint)
              where not exists (
                select 1 from team_style_claim c
                where c.season = r.season and c.team_code = r.team_code
                  and c.position_hint = h.hint
                  and r.summary like '%' || c.clause || '%'
              )
            ))
     from team_style_read r where r.position_hint is not null)        as hint_traces_to_summary,
  -- A claim exists exactly when a club separates on that metric.
  (select count(*) from team_style_metric where separated)
    = (select count(*) from team_style_claim)                        as claim_per_separation,
  -- Honesty rule 2: the phrase names the season and the comparison, never a bare adjective.
  (select bool_and(phrase like '%' || season || '%' and phrase like '%league%')
     from team_style_claim)                                          as phrase_names_basis,
  -- Honesty rule 4 at the point of rendering: a claim on an unranked metric must not quote a
  -- rank, and dead-ball share is currently the live instance of that.
  (select bool_and(metric_rank is null) from team_style_claim
    where metric in (select metric from team_style_metric where not rank_earned))
                                                                     as claim_quotes_no_dead_rank,
  -- A share is a share.
  (select bool_and(value between 0 and 1) from team_style_metric where metric = 'dead_share')
                                                                     as share_in_range,
  -- The dead-ball parts add up to the whole, and the whole is part of non-penalty xG.
  (select bool_and(abs(dead_ball_xg - (corner_xg + set_piece_xg + free_kick_xg)) < 0.02)
     from team_dead_ball)                                            as dead_ball_parts_sum,
  (select bool_and(dead_ball_xg + open_play_xg between np_xg - 0.02 and np_xg + 0.02)
     from team_dead_ball)                                            as situations_partition_npxg,
  -- Promoted clubs have no Understat season, so they must be absent here rather than zero.
  (select count(*) from team_style_metric m
    join team_profile p on p.team_code = m.team_code
   where not p.has_style_data)                                       as promoted_leaked,
  (select min(matches) from team_style_metric)                       as fewest_matches,
  (select round(min(reliability), 2) from team_style_reliability)      as weakest_reliability,
  (select round(max(reliability), 2) from team_style_reliability)      as strongest_reliability;
