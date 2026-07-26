-- ---------------------------------------------------------------------------
-- 0013 — availability, and why "Safe" was recommending the least safe players
-- ---------------------------------------------------------------------------
-- Two faults Peder found by reading the screen, both of which made a panel actively
-- misleading rather than merely weak.
--
-- FAULT 1: `minutes_security` measured the wrong thing, and its error pointed the wrong way.
--
-- It was `starts / ceil(minutes / 90)` — "when he played, did he start". For a player who
-- appeared six times and started all six, that is 1.000. The numbers:
--
--     Haaland   2 953 min   34 starts   starts/appearance 1.000   86% of the season
--     Saka      2 218 min   25 starts   starts/appearance 1.000   65%
--     Havertz     577 min    7 starts   starts/appearance 1.000   17%
--
-- Havertz scored identically to Haaland on the component whose entire job was to say "will he
-- be on the pitch". So the axis labelled *Safe* actively rewarded a player who missed most of
-- the season, and put him top at 0.990. Not a weak signal — an inverted one.
--
-- The fix is to measure share of the team's available minutes. That is the number that answers
-- the question, and it separates Havertz (0.169) from Haaland (0.863) immediately.
--
-- A hard gate as well as a rank component, because for captaincy "will he play" is a
-- precondition, not a factor to be outweighed by a good fixture. At least half the team's
-- minutes: the pool goes 278 → 158, which is still far more than a captain shortlist needs.
--
-- The trade-off, stated: a player who missed half of last season through injury but is a
-- nailed starter now is wrongly excluded. That is the conservative direction for an armband,
-- and it self-corrects once current-season minutes exist — at which point this view should read
-- from `player_gw_stats` instead. Tracked in FIX_WHEN_LIVE.md.
--
-- FAULT 2: `hidden_gems` never filtered on availability at all.
--
-- It selected `is_available`, `status` and `news` for display and then never used them in the
-- WHERE clause, so 31 of 269 recommendations were injured or suspended players. "Players to
-- target" pointing at someone who cannot play is worse than an empty panel.

-- ---------------------------------------------------------------------------
-- player_availability — did he actually play, and is he fit now?
-- ---------------------------------------------------------------------------
drop view if exists player_availability cascade;
create view player_availability as
select
  s.player_code,
  s.minutes,
  s.starts,
  -- coalesce to 38: `team_style` has no row for promoted clubs, and a full league season is
  -- 38 matches regardless.
  coalesce(ts.matches, 38)                                          as team_matches,
  round(coalesce(s.minutes, 0) / (coalesce(ts.matches, 38) * 90.0), 3) as minutes_share,
  -- "When he played, did he start." Kept, because it still distinguishes a starter from a
  -- substitute — but it is no longer allowed to stand in for availability.
  round(least(1.0, coalesce(s.starts, 0)::numeric
              / greatest(1, ceil(coalesce(s.minutes, 0) / 90.0))), 3) as start_rate,
  s.status,
  s.chance_of_playing_next_round                                    as chance_of_playing,
  -- Both conditions matter. `status` is FPL's flag; `chance_of_playing` is the percentage it
  -- publishes alongside a doubt, and it is NULL for a fit player — so coalesce to 100, never 0.
  (s.status = 'a' and coalesce(s.chance_of_playing_next_round, 100) >= 100) as fully_fit
from player_scout s
left join team_style ts
  on ts.team_code = s.team_code
 and ts.season = (select stats_season from season_context);

-- ---------------------------------------------------------------------------
-- hidden_gems — now excludes players who cannot play
-- ---------------------------------------------------------------------------
drop view if exists hidden_gems cascade;
create view hidden_gems as
select
  s.player_code, s.web_name, s.position, s.element_type, s.team_short, s.team_code,
  s.price, s.selected_by_percent, s.minutes, s.total_points,
  s.xgi_per_90, s.defcon_per_90, s.xgc_per_90, s.points_per_million,
  s.output_percentile, s.differential_percentile, s.value_percentile,
  s.is_available, s.status, s.news, s.penalties_order,
  a.chance_of_playing,
  a.minutes_share,
  round((s.output_percentile + s.differential_percentile + s.value_percentile) / 3.0, 4)
    as gem_score
from player_scout s
join player_availability a on a.player_code = s.player_code
where not s.is_cold_start
  and s.has_reliable_sample
  and s.selected_by_percent < 10
  -- The filter that was missing. 31 of 269 rows were injured or suspended.
  and a.fully_fit
order by (s.output_percentile + s.differential_percentile + s.value_percentile) desc;

-- ---------------------------------------------------------------------------
-- captain_picks — availability as a gate, minutes share as the component
-- ---------------------------------------------------------------------------
drop view if exists captain_picks cascade;
create view captain_picks as
with fixture as (
  select
    fd.team_code, fd.gameweek, fd.kickoff_time, fd.is_home, fd.opponent_code,
    fd.p_win, fd.difficulty, fd.attack_difficulty, fd.expected_goals_for,
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
    s.selected_by_percent, s.status, s.news, s.minutes,
    s.xgi_per_90, s.points_per_90, s.penalties_order,
    f.gameweek, f.kickoff_time, f.is_home, f.opponent_code,
    f.p_win, f.difficulty, f.p_team_scores, f.p_team_scores_2plus, f.expected_goals_for,
    a.minutes_share, a.start_rate, a.chance_of_playing, a.team_matches,
    coalesce(p.shots_in_box_per_90, 0)                                        as shots_in_box_per_90,
    coalesce(p.big_chances_per_90, 0)                                         as big_chances_per_90,
    coalesce(p.non_penalty_xg_per_90, 0)                                      as non_penalty_xg_per_90,
    (p.player_code is not null)                                               as has_shot_data
  from player_scout s
  join fixture f on f.team_code = s.team_code
  join player_availability a on a.player_code = s.player_code
  left join player_shot_profile p on p.player_code = s.player_code
  where s.has_reliable_sample
    and coalesce(s.xgi_per_90, 0) > 0
    -- Fit right now.
    and a.fully_fit
    -- And demonstrably a regular. This is the gate that removes Havertz on 17% of a season
    -- from a panel whose whole promise is a safe floor.
    and a.minutes_share >= 0.5
),
ranked as (
  select
    c.*,
    -- cume_dist, not percent_rank: they disagree on ties, and these distributions are tied
    -- heavily at the top. percent_rank gives a tie group the rank of its FIRST member, which
    -- rendered every full-time starter as "37th percentile" for minutes.
    cume_dist()   over (order by c.minutes_share)             as r_minutes,
    cume_dist()   over (order by c.p_team_scores)             as r_team_scores,
    cume_dist()   over (order by c.xgi_per_90)                as r_involvement,
    cume_dist()   over (order by c.p_team_scores_2plus)       as r_team_scores_2,
    cume_dist()   over (order by c.big_chances_per_90)        as r_big_chances,
    cume_dist()   over (order by c.shots_in_box_per_90)       as r_shots_in_box,
    cume_dist()   over (order by c.non_penalty_xg_per_90)     as r_np_xg
  from candidates c
)
select
  r.player_code, r.web_name, r.position, r.team_short, r.team_code, r.price,
  r.selected_by_percent, r.status, r.news, r.minutes, r.gameweek, r.kickoff_time,
  o.short_name as opponent_short, o.name as opponent_name, r.is_home,
  r.p_win, r.difficulty, r.expected_goals_for,
  r.p_team_scores, r.p_team_scores_2plus,
  r.xgi_per_90, r.penalties_order, r.has_shot_data,
  r.minutes_share, r.start_rate, r.chance_of_playing, r.team_matches,
  r.shots_in_box_per_90, r.big_chances_per_90, r.non_penalty_xg_per_90,

  round(((r.r_minutes + r.r_team_scores + r.r_involvement) / 3.0)::numeric, 4) as floor_score,
  round(((
      r.r_big_chances + r.r_shots_in_box + r.r_team_scores_2 + r.r_np_xg
      + case when r.penalties_order = 1 then 1.0
             when r.penalties_order is not null then 0.5
             else 0.0 end
    ) / 5.0)::numeric, 4)                                                    as ceiling_score,
  round(((
      (r.r_minutes + r.r_team_scores + r.r_involvement) / 3.0
      + (r.r_big_chances + r.r_shots_in_box + r.r_team_scores_2 + r.r_np_xg
         + case when r.penalties_order = 1 then 1.0
                when r.penalties_order is not null then 0.5 else 0.0 end) / 5.0
    ) / 2.0)::numeric, 4)                                                    as combined_score,
  round(r.r_minutes::numeric, 3)        as rank_minutes,
  round(r.r_team_scores::numeric, 3)    as rank_team_scores,
  round(r.r_involvement::numeric, 3)    as rank_involvement,
  round(r.r_big_chances::numeric, 3)    as rank_big_chances,
  round(r.r_shots_in_box::numeric, 3)   as rank_shots_in_box,
  round(r.r_team_scores_2::numeric, 3)  as rank_team_scores_2,
  round(r.r_np_xg::numeric, 3)          as rank_np_xg,
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
-- captain_check — rebuilt after the cascade, plus the new availability invariants
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
  bool_and(p_team_scores_2plus <= p_team_scores)                   as tail_ordered,
  -- The two invariants this migration exists to protect.
  bool_and(status = 'a')                                           as all_fit,
  bool_and(minutes_share >= 0.5)                                   as all_regulars,
  round(min(minutes_share), 3)                                     as min_minutes_share,
  round(avg(p_team_scores), 3)                                     as avg_p_scores,
  round(corr(floor_score, ceiling_score)::numeric, 3)              as floor_ceiling_corr,
  (select count(*) from player_shot_profile)                       as players_with_shot_profile,
  (select bool_and(situation is not null and body_part is not null) from understat_shots)
                                                                   as shot_attributes_repaired,
  -- And the gems fault: not one recommendation may be unavailable.
  (select count(*) from hidden_gems)                               as gems,
  (select bool_and(is_available) from hidden_gems)                  as all_gems_available
from captain_picks;
