-- ---------------------------------------------------------------------------
-- 0012 — captain picks, rebuilt around floor and ceiling
-- ---------------------------------------------------------------------------
-- The first version multiplied xGI/90 × fixture ease × starts-per-appearance into one number.
-- Reading allaboutfpl's GW37 captain methodology exposed three real weaknesses in that, and
-- all three are fixable with data already held.
--
-- 1. ONE SCORE HIDES THE DECISION. They rank on two separate axes — a "safety rank" from
--    anytime-return projections and an "explosion rank" from projected points. That is the
--    right shape, because the question is not "who is best" but "do I want a floor or a
--    ceiling this week". Leading your mini-league you want the safe armband; chasing, you want
--    variance. One blended score makes that choice for the user and hides it.
--
-- 2. WIN PROBABILITY IS THE WRONG FIXTURE INPUT. A captain does not care whether the team
--    wins, only whether it scores. They use P(team scores ≥1) and P(≥2) from bookmaker odds.
--    We already hold the Poisson rate λ per team per fixture, so both fall straight out:
--        P(≥1) = 1 − e^(−λ)          P(≥2) = 1 − e^(−λ)(1 + λ)
--    Strictly better than the 1X2 win probability and it costs two expressions.
--
-- 3. MULTIPLYING RAW QUANTITIES LETS THE WIDEST SPREAD DOMINATE. xGI/90 ranges over roughly
--    0–0.9 while starts-per-appearance clusters near 1.0, so output silently outweighed
--    minutes security. Their "Cumulative Rank Factor" aggregates *ranks*, which is scale-free.
--    Percentile ranks within the candidate pool, then averaged.
--
-- What we keep that they explicitly omit: ownership, home/away, penalty duty, and minutes
-- security. Their article names those as gaps in its own method.
--
-- Not yet possible: their rolling six-gameweek window. `player_gw_stats` is empty until GW1,
-- so the shot profile below is whole-season. `basis` says which, and the switch to a rolling
-- window is tracked in FIX_WHEN_LIVE.md.

-- ---------------------------------------------------------------------------
-- player_shot_profile — volume and chance quality, from repaired Understat shots
-- ---------------------------------------------------------------------------
-- Depends on migration-time repair of soccerdata's dropped enum values (see
-- sync/sources/understat_raw.py). Before that fix all 92 penalties and all 1 778 headers were
-- NULL, so non-penalty xG was not computable at all and this view would have silently
-- attributed penalty xG to open play.
drop view if exists player_shot_profile cascade;
create view player_shot_profile as
with box as (
  select
    s.player_code,
    s.season,
    count(*)                                                          as shots,
    -- Understat normalises the pitch to 0–1 with the attacking goal at x = 1. The penalty box
    -- is 16.5 m deep on a 105 m pitch and 40.32 m wide on a 68 m one.
    count(*) filter (
      where s.location_x >= 1 - 16.5 / 105.0
        and s.location_y between 0.5 - 20.16 / 68.0 and 0.5 + 20.16 / 68.0
    )                                                                 as shots_in_box,
    -- No "big chance" flag exists in Understat; xG ≥ 0.3 is the conventional proxy and is
    -- roughly where a chance becomes better than one-in-three.
    count(*) filter (where s.xg >= 0.3 and s.situation <> 'Penalty')   as big_chances,
    count(*) filter (where s.situation = 'Penalty')                    as penalty_shots,
    count(*) filter (where s.body_part = 'Head')                       as header_shots,
    count(*) filter (where s.situation in ('From Corner', 'Set Piece', 'Direct Freekick'))
                                                                      as set_piece_shots,
    round(sum(s.xg), 3)                                               as shot_xg,
    round(sum(s.xg) filter (where s.situation <> 'Penalty'), 3)        as non_penalty_xg
  from understat_shots s
  where s.player_code is not null
  group by s.player_code, s.season
)
select
  b.*,
  sc.minutes,
  round(b.shots / (nullif(sc.minutes, 0) / 90.0), 3)         as shots_per_90,
  round(b.shots_in_box / (nullif(sc.minutes, 0) / 90.0), 3)  as shots_in_box_per_90,
  round(b.big_chances / (nullif(sc.minutes, 0) / 90.0), 3)   as big_chances_per_90,
  round(b.non_penalty_xg / (nullif(sc.minutes, 0) / 90.0), 3) as non_penalty_xg_per_90,
  case when b.shots > 0 then round(b.shots_in_box::numeric / b.shots, 3) end as in_box_share
from box b
join player_scout sc on sc.player_code = b.player_code
where b.season = (select stats_season from season_context);

-- ---------------------------------------------------------------------------
-- captain_picks — two axes, rank-aggregated
-- ---------------------------------------------------------------------------
drop view if exists captain_picks cascade;
create view captain_picks as
with fixture as (
  select
    fd.team_code, fd.gameweek, fd.kickoff_time, fd.is_home, fd.opponent_code,
    fd.p_win, fd.difficulty, fd.attack_difficulty, fd.expected_goals_for,
    -- Poisson, from the same λ the fixture model already produces.
    round((1 - exp(-fd.expected_goals_for))::numeric, 4)                       as p_team_scores,
    round((1 - exp(-fd.expected_goals_for) * (1 + fd.expected_goals_for))::numeric, 4)
                                                                              as p_team_scores_2plus
  from fixture_difficulty fd
  where fd.gameweek = (select gameweek from next_gameweek)
    and not coalesce(fd.finished, false)
),
candidates as (
  select
    s.player_code, s.web_name, s.position, s.team_short, s.team_code, s.price,
    s.selected_by_percent, s.status, s.news, s.minutes, s.starts,
    s.xgi_per_90, s.points_per_90, s.penalties_order, s.direct_freekicks_order,
    f.gameweek, f.kickoff_time, f.is_home, f.opponent_code,
    f.p_win, f.difficulty, f.p_team_scores, f.p_team_scores_2plus, f.expected_goals_for,
    -- Starts per appearance. The only minutes signal available before GW1; after that it
    -- should become a real minutes model.
    least(1.0, coalesce(s.starts, 0)::numeric
               / greatest(1, ceil(coalesce(s.minutes, 0) / 90.0)))            as minutes_security,
    coalesce(p.shots_in_box_per_90, 0)                                        as shots_in_box_per_90,
    coalesce(p.big_chances_per_90, 0)                                         as big_chances_per_90,
    coalesce(p.non_penalty_xg_per_90, 0)                                      as non_penalty_xg_per_90,
    coalesce(p.penalty_shots, 0)                                              as penalty_shots,
    (p.player_code is not null)                                               as has_shot_data
  from player_scout s
  join fixture f on f.team_code = s.team_code
  left join player_shot_profile p on p.player_code = s.player_code
  where s.has_reliable_sample
    and s.is_available
    and coalesce(s.xgi_per_90, 0) > 0
),
ranked as (
  select
    c.*,
    -- Percentile ranks inside the candidate pool. Scale-free, so no component can dominate
    -- another just by having a wider spread.
    --
    -- cume_dist, NOT percent_rank. Both are "percentile", but they disagree on ties, and
    -- minutes_security is heavily tied: nearly every reliable player starts every game, so most
    -- candidates sit at exactly 1.0. percent_rank assigns a tie group the rank of its FIRST
    -- member, so all six top picks rendered as "Minutes 37th percentile" — a player starting
    -- 100% of matches shown as below-average, which is worse than useless on screen. cume_dist
    -- is the fraction of rows at or below the value, so the maximum is 1.0 and a tie group gets
    -- the credit it has earned.
    cume_dist()   over (order by c.minutes_security)        as r_minutes,
    cume_dist()   over (order by c.p_team_scores)            as r_team_scores,
    cume_dist()   over (order by c.xgi_per_90)               as r_involvement,
    cume_dist()   over (order by c.p_team_scores_2plus)      as r_team_scores_2,
    cume_dist()   over (order by c.big_chances_per_90)       as r_big_chances,
    cume_dist()   over (order by c.shots_in_box_per_90)      as r_shots_in_box,
    cume_dist()   over (order by c.non_penalty_xg_per_90)    as r_np_xg
  from candidates c
)
select
  r.player_code, r.web_name, r.position, r.team_short, r.team_code, r.price,
  r.selected_by_percent, r.status, r.news, r.minutes, r.gameweek, r.kickoff_time,
  o.short_name as opponent_short, o.name as opponent_name, r.is_home,
  r.p_win, r.difficulty, r.expected_goals_for,
  r.p_team_scores, r.p_team_scores_2plus,
  r.xgi_per_90, r.minutes_security, r.penalties_order, r.has_shot_data,
  r.shots_in_box_per_90, r.big_chances_per_90, r.non_penalty_xg_per_90,

  -- FLOOR: will he be on the pitch, and will his team score at all? The safe armband.
  round(((r.r_minutes + r.r_team_scores + r.r_involvement) / 3.0)::numeric, 4)        as floor_score,
  -- CEILING: can he haul? Chance volume and quality, a two-goal team performance, and a
  -- penalty on top. Penalty duty is a genuine ceiling spike and belongs on this axis only.
  round(((
      r.r_big_chances + r.r_shots_in_box + r.r_team_scores_2 + r.r_np_xg
      + case when r.penalties_order = 1 then 1.0
             when r.penalties_order is not null then 0.5
             else 0.0 end
    ) / 5.0)::numeric, 4)                                                            as ceiling_score,
  round(((
      (r.r_minutes + r.r_team_scores + r.r_involvement) / 3.0
      + (r.r_big_chances + r.r_shots_in_box + r.r_team_scores_2 + r.r_np_xg
         + case when r.penalties_order = 1 then 1.0
                when r.penalties_order is not null then 0.5 else 0.0 end) / 5.0
    ) / 2.0)::numeric, 4)                                                            as combined_score,
  -- The components, so the ranking can be argued with rather than trusted.
  round(r.r_minutes::numeric, 3)        as rank_minutes,
  round(r.r_team_scores::numeric, 3)    as rank_team_scores,
  round(r.r_involvement::numeric, 3)    as rank_involvement,
  round(r.r_big_chances::numeric, 3)    as rank_big_chances,
  round(r.r_shots_in_box::numeric, 3)   as rank_shots_in_box,
  round(r.r_team_scores_2::numeric, 3)  as rank_team_scores_2,
  round(r.r_np_xg::numeric, 3)          as rank_np_xg,
  -- Whole-season until `player_gw_stats` fills; then this should read 'last_6_gameweeks'.
  'season' as basis
from ranked r
join teams o on o.code = r.opponent_code
order by (
  (r.r_minutes + r.r_team_scores + r.r_involvement) / 3.0
  + (r.r_big_chances + r.r_shots_in_box + r.r_team_scores_2 + r.r_np_xg
     + case when r.penalties_order = 1 then 1.0
            when r.penalties_order is not null then 0.5 else 0.0 end) / 5.0
) desc;

-- ---------------------------------------------------------------------------
-- captain_check — invariants for `python -m sync.cli verify`
-- ---------------------------------------------------------------------------
drop view if exists captain_check cascade;
create view captain_check as
select
  count(*)                                                        as candidates,
  count(*) filter (where has_shot_data)                            as with_shot_data,
  bool_and(floor_score between 0 and 1)                            as floor_in_range,
  bool_and(ceiling_score between 0 and 1)                          as ceiling_in_range,
  bool_and(p_team_scores between 0 and 1
       and p_team_scores_2plus between 0 and 1)                    as scoring_probs_in_range,
  -- P(≥2 goals) must never exceed P(≥1). If it does, the Poisson tail is wrong.
  bool_and(p_team_scores_2plus <= p_team_scores)                   as tail_ordered,
  round(avg(p_team_scores), 3)                                     as avg_p_scores,
  round(avg(p_team_scores_2plus), 3)                               as avg_p_scores_2,
  -- Floor and ceiling must not be the same ranking, or the two axes are not earning their
  -- keep. Anything above ~0.95 correlation means the split is decorative.
  round(corr(floor_score, ceiling_score)::numeric, 3)              as floor_ceiling_corr,
  (select count(*) from player_shot_profile)                       as players_with_shot_profile,
  (select bool_and(situation is not null and body_part is not null) from understat_shots)
                                                                   as shot_attributes_repaired
from captain_picks;
