-- ---------------------------------------------------------------------------
-- 0017 — search, the player profile, and the club page
-- ---------------------------------------------------------------------------
-- The table answers "who should I look at". These answer "tell me about him", which is the
-- question you have once a name is on the shortlist — and until now the only way to ask it was
-- to squint at one row among 558.
--
-- The centrepiece is the shot map. Understat records every shot with normalised pitch
-- coordinates, an xG, a body part and a situation, and the enum repair in
-- sync/sources/understat_raw.py means body part and situation are actually populated. Haaland
-- has 125 plottable shots last season, 27 of them goals. Nothing else in this dataset shows a
-- player's habits as directly.

-- ---------------------------------------------------------------------------
-- search_index — players and clubs in one list
-- ---------------------------------------------------------------------------
-- One flat list rather than two searches, because the user does not think "am I looking for a
-- player or a club", they think of a name. 578 rows, shipped once to the header so search is
-- instant on every page and never round-trips.
drop view if exists search_index cascade;
create view search_index as
select
  'player'                                                      as kind,
  s.player_code                                                 as code,
  s.web_name                                                    as label,
  concat_ws(' · ', s.position, s.team_name,
            case when s.price is not null then '£' || s.price end) as sublabel,
  s.position,
  s.team_short,
  -- Everything worth matching against, lower-cased once here rather than per keystroke in the
  -- browser. Includes the full name because "bruno" should find B.Fernandes, whose web_name
  -- does not contain it.
  lower(concat_ws(' ', s.web_name, s.first_name, s.second_name, s.team_name, s.team_short,
                  s.position))                                  as haystack,
  -- Ranking hint, so a search for "sa" offers Saka before a reserve keeper. Total points is
  -- the crudest possible proxy for prominence and is exactly right for this.
  coalesce(s.total_points, 0)                                   as weight
from player_scout s
union all
select
  'team',
  t.code,
  t.name,
  concat_ws(' · ', t.short_name,
            case when ts.position is not null then 'finished ' || ts.position end),
  null,
  t.short_name,
  lower(concat_ws(' ', t.name, t.short_name)),
  -- Above every player, so typing a club name surfaces the club first. Players are capped at
  -- 300-odd points, so 10000 is unreachable rather than merely large.
  10000
from teams t
left join team_seasons ts
  on ts.team_code = t.code and ts.season = (select stats_season from season_context);

-- ---------------------------------------------------------------------------
-- player_shots — the shot map, with the pitch geometry resolved in SQL
-- ---------------------------------------------------------------------------
-- Understat normalises coordinates to 0..1 with the attacking goal at x = 1. The zone
-- boundaries are real pitch measurements divided by a 105 x 68 m pitch, worked out here rather
-- than as magic numbers in a component:
--
--     penalty area   16.5 m deep  -> x >= 1 - 16.5/105 = 0.8429
--                    40.32 m wide -> |y - 0.5| <= 20.16/68 = 0.2965
--     six-yard box    5.5 m deep  -> x >= 1 - 5.5/105  = 0.9476
--                    18.32 m wide -> |y - 0.5| <=  9.16/68 = 0.1347
drop view if exists player_shots cascade;
create view player_shots as
select
  u.player_code,
  u.shot_id,
  u.season,
  u.kickoff,
  u.minute,
  u.xg,
  u.location_x,
  u.location_y,
  u.body_part,
  u.situation,
  u.result,
  (u.result = 'Goal')                                           as is_goal,
  u.assist_player,
  case
    when u.location_x >= 1 - 5.5 / 105.0
     and abs(u.location_y - 0.5) <= 9.16 / 68.0   then 'six_yard'
    when u.location_x >= 1 - 16.5 / 105.0
     and abs(u.location_y - 0.5) <= 20.16 / 68.0  then 'penalty_area'
    else 'outside_box'
  end                                                           as zone,
  -- Distance to the centre of the goal, in metres. The honest summary of shot selection, and
  -- it survives a reader who does not want to interpret a scatter plot.
  round(sqrt(power((1 - u.location_x) * 105.0, 2)
           + power((u.location_y - 0.5) * 68.0, 2))::numeric, 1) as distance_m
from understat_shots u
where u.player_code is not null
  -- Own goals are not shots. Understat records them against the defender who scored them,
  -- positioned at his *own* goal line — which is why min(location_x) came back as 0.005, a
  -- shot from 104.5 metres. Plotting them would put 41 dots at the wrong end of the pitch and
  -- count them as attempts. Found only by asking why the minimum x looked wrong.
  and u.result <> 'Own Goal';

-- ---------------------------------------------------------------------------
-- player_shot_profile — the same fault, in a view that has been live since 0012
-- ---------------------------------------------------------------------------
-- 28 players had an own goal counted as a shot attempt. The two worst are goalkeepers:
--
--     Petrović    shots 1   shots_per_90 0.026   own goals 1
--     Verbruggen  shots 1   shots_per_90 0.026   own goals 1
--
-- Both figures are entirely fictional — neither has attempted a shot at the opposition goal.
-- Murillo's 13 shots were 15% own goals.
--
-- `captain_picks` is unaffected: it reads shots_in_box, big_chances and non-penalty xG, and an
-- own goal sits at x ≈ 0.01 (never in the box) with xG 0. But `shots_per_90` is in the column
-- catalogue and on the Finishers view, so it was a wrong number on screen.
--
-- REPLACE, not drop: `captain_picks` depends on this and the column list is unchanged. The
-- lesson from 0016 is still fresh.
create or replace view player_shot_profile as
with box as (
  select
    s.player_code,
    s.season,
    count(*)                                                          as shots,
    count(*) filter (
      where s.location_x >= 1 - 16.5 / 105.0
        and s.location_y between 0.5 - 20.16 / 68.0 and 0.5 + 20.16 / 68.0
    )                                                                 as shots_in_box,
    count(*) filter (where s.xg >= 0.3 and s.situation <> 'Penalty')   as big_chances,
    count(*) filter (where s.situation = 'Penalty')                    as penalty_shots,
    count(*) filter (where s.body_part = 'Head')                       as header_shots,
    count(*) filter (where s.situation in ('From Corner', 'Set Piece', 'Direct Freekick'))
                                                                      as set_piece_shots,
    round(sum(s.xg), 3)                                               as shot_xg,
    round(sum(s.xg) filter (where s.situation <> 'Penalty'), 3)        as non_penalty_xg
  from understat_shots s
  where s.player_code is not null
    and s.result <> 'Own Goal'
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
-- player_career — every season FPL will admit to
-- ---------------------------------------------------------------------------
-- `history_past` only, never `bootstrap`, for completed seasons: they disagree for loan and
-- transfer cases and history_past is the one that is right (CLAUDE.md §3). The current season
-- is appended from `player_scout`, which during preseason is still describing last season —
-- hence `is_current_season` rather than letting the reader infer it from the label.
drop view if exists player_career cascade;
create view player_career as
select
  t.player_code,
  t.season,
  t.minutes,
  t.total_points,
  t.goals_scored,
  t.assists,
  t.clean_sheets,
  t.goals_conceded,
  t.bonus,
  t.expected_goals,
  t.expected_assists,
  case when coalesce(t.minutes, 0) >= 90
       then round(t.total_points / (t.minutes / 90.0), 2) end    as points_per_90,
  false                                                         as is_current_season
from player_season_totals t
where t.source = 'history_past'
union all
select
  s.player_code,
  s.stats_season,
  s.minutes, s.total_points, s.goals_scored, s.assists, s.clean_sheets, s.goals_conceded,
  s.bonus, s.expected_goals, s.expected_assists,
  s.points_per_90,
  true
from player_scout s
where coalesce(s.minutes, 0) > 0
  -- Avoid printing the same season twice: in preseason `stats_season` is last season, which
  -- history_past already covers.
  and not exists (
    select 1 from player_season_totals h
    where h.player_code = s.player_code
      and h.season = s.stats_season
      and h.source = 'history_past'
  );

-- ---------------------------------------------------------------------------
-- player_fixtures — the run ahead, per player
-- ---------------------------------------------------------------------------
-- Keyed by player rather than by club so the profile page is one query, and carrying the
-- position-appropriate half of the fixture the same way `player_target_base` does.
drop view if exists player_fixtures cascade;
create view player_fixtures as
select
  s.player_code,
  fd.gameweek,
  fd.kickoff_time,
  fd.is_home,
  o.short_name                                                  as opponent_short,
  o.name                                                        as opponent_name,
  fd.difficulty,
  fd.p_win,
  fd.expected_goals_for,
  fd.p_clean_sheet,
  case when s.element_type in (1, 2) then fd.defence_difficulty
       else fd.attack_difficulty end                            as position_difficulty
from player_scout s
join fixture_difficulty fd on fd.team_code = s.team_code
join teams o on o.code = fd.opponent_code
where not coalesce(fd.finished, false)
  and fd.gameweek >= (select gameweek from next_gameweek);

-- ---------------------------------------------------------------------------
-- team_profile — one row per club, everything a club page leads with
-- ---------------------------------------------------------------------------
-- Last season's finishing position is NOT in `team_seasons`. That table only ever holds the
-- season being synced — verified: `select season, count(*) from team_seasons` returns one row,
-- 2026-27 — so joining it on `stats_season` finds nothing and every club rendered as "no
-- 2025-26 Premier League record" *directly above* a full 2025-26 style block. Arsenal read as
-- having no record while showing 71 goals and the best defence in the league.
--
-- Derived from `team_style.points` instead, and it is exact rather than approximate: the 17
-- clubs with a style row are this season's 20 minus the 3 promoted, which is last season's 20
-- minus the 3 relegated. Relegated clubs finish 18th to 20th by definition, so positions 1-17
-- among the survivors are their true positions. Ordered on points, then goal difference, then
-- goals scored, which is the Premier League's own tiebreak.
drop view if exists team_profile cascade;
create view team_profile as
with standings as (
  select
    team_code,
    points,
    rank() over (
      order by points desc,
               (goals - goals_conceded) desc,
               goals desc
    )                                                           as position
  from team_style
  where season = (select stats_season from season_context)
)
select
  t.code                                                        as team_code,
  t.name,
  t.short_name,
  sd.position                                                   as last_position,
  sd.points                                                     as last_points,
  ts.played, ts.win, ts.draw, ts.loss,
  st.xg_per_match, st.xga_per_match, st.np_xg_per_match, st.xg_difference,
  st.ppda, st.opponent_ppda, st.deep_completions, st.deep_completions_conceded,
  st.goals, st.goals_conceded, st.clean_sheets, st.clean_sheet_pct,
  st.expected_points,
  st.attacking_rank, st.defensive_rank, st.press_intensity_rank,
  e.elo, e.elo_rank,
  -- Set-piece threat, the thing that makes a club's defenders and target men worth owning.
  c.corner_shots, c.corner_xg, c.corner_goals,
  h.head_shots, h.head_xg, h.head_goals,
  -- Whether Understat covered them at all. Promoted clubs have no style row, and every
  -- metric above is NULL rather than zero for them — the page has to say so.
  (st.team_code is not null)                                    as has_style_data
from teams t
left join standings sd on sd.team_code = t.code
-- Kept for played/win/draw/loss, which describe the *current* season and are legitimately
-- zero in preseason. Deliberately not the source of `last_position` any more.
left join team_seasons ts
  on ts.team_code = t.code and ts.season = (select current_season from season_context)
left join team_style st
  on st.team_code = t.code and st.season = (select stats_season from season_context)
left join elo_now e on e.team_code = t.code
left join (
  select team_code,
         count(*)                                   as corner_shots,
         round(sum(xg)::numeric, 2)                  as corner_xg,
         count(*) filter (where result = 'Goal')     as corner_goals
  from understat_shots where situation = 'From Corner' group by team_code
) c on c.team_code = t.code
left join (
  select team_code,
         count(*)                                   as head_shots,
         round(sum(xg)::numeric, 2)                  as head_xg,
         count(*) filter (where result = 'Goal')     as head_goals
  from understat_shots where body_part = 'Head' group by team_code
) h on h.team_code = t.code;

-- ---------------------------------------------------------------------------
-- team_form — match by match, from Understat's own team rows
-- ---------------------------------------------------------------------------
drop view if exists team_form cascade;
create view team_form as
select
  m.team_code,
  m.season,
  m.kickoff,
  m.is_home,
  o.short_name                                                  as opponent_short,
  coalesce(o.name, m.understat_opponent)                        as opponent_name,
  m.goals, m.opponent_goals,
  m.xg, m.opponent_xg, m.np_xg, m.np_xg_difference,
  m.ppda, m.opponent_ppda,
  -- `understat_team_match` names this `opponent_deep_completions`; `team_style` calls the
  -- season aggregate `deep_completions_conceded`. Aliased to the latter so the two agree.
  m.deep_completions, m.opponent_deep_completions as deep_completions_conceded,
  m.points, m.expected_points,
  -- Points minus expected points: where a season was luckier or unluckier than it played.
  round((m.points - m.expected_points)::numeric, 2)             as points_over_expected,
  case when m.goals > m.opponent_goals then 'W'
       when m.goals = m.opponent_goals then 'D'
       else 'L' end                                             as result
from understat_team_match m
left join teams o on o.code = m.opponent_team_code;

-- ---------------------------------------------------------------------------
-- profile_check
-- ---------------------------------------------------------------------------
drop view if exists profile_check cascade;
create view profile_check as
select
  (select count(*) from search_index)                            as search_rows,
  (select count(*) from search_index where kind = 'player')      as search_players,
  (select count(*) from search_index where kind = 'team')        as search_teams,
  -- Every row must be findable by typing its own name, or search is quietly lying.
  (select bool_and(haystack like '%' || lower(label) || '%') from search_index)
                                                                 as label_in_haystack,
  (select count(*) from player_shots)                            as shots,
  (select count(distinct player_code) from player_shots)          as players_with_shots,
  -- Coordinates must be inside the pitch. Understat has flipped its axes before, and a shot
  -- map is one of the few screens where wrong data still looks plausible.
  (select bool_and(location_x between 0 and 1 and location_y between 0 and 1) from player_shots)
                                                                 as coords_in_range,
  -- Now that own goals are excluded, the furthest shot should be a plausible long-range
  -- effort rather than something from the player's own goal line. Below ~0.3 means own goals
  -- have crept back in, or Understat has changed how it orients the pitch.
  (select round(min(location_x)::numeric, 2) from player_shots)   as min_x,
  (select count(*) from player_shots where result = 'Own Goal')    as own_goals_leaked,
  (select count(*) from understat_shots where result = 'Own Goal') as own_goals_in_source,
  (select count(*) from player_shots where zone = 'six_yard')     as six_yard_shots,
  (select count(*) from player_shots where zone = 'penalty_area') as box_shots,
  (select count(*) from player_shots where zone = 'outside_box')  as outside_shots,
  -- A goal from a six-yard-box shot must be shorter than one from outside. If these invert,
  -- the geometry above is wrong.
  (select round(avg(distance_m)::numeric, 1) from player_shots where zone = 'six_yard')
                                                                 as avg_dist_six_yard,
  (select round(avg(distance_m)::numeric, 1) from player_shots where zone = 'outside_box')
                                                                 as avg_dist_outside,
  (select count(distinct player_code) from player_career)         as players_with_career,
  (select count(*) from player_career where is_current_season)    as current_season_rows,
  -- No season may appear twice for one player, which is what the NOT EXISTS guard prevents.
  (select bool_and(n = 1) from (
     select player_code, season, count(*) as n from player_career group by 1, 2
   ) d)                                                          as one_row_per_season,
  (select count(*) from team_profile)                            as teams,
  (select count(*) from team_profile where has_style_data)        as teams_with_style,
  -- A club with style data must have a finishing position, and one without must not. The
  -- contradiction this migration fixes was exactly these two disagreeing.
  (select bool_and(has_style_data = (last_position is not null)) from team_profile)
                                                                 as position_matches_style,
  (select max(last_position) from team_profile)                   as worst_position,
  (select count(*) from team_form)                               as form_matches,
  (select count(*) from player_fixtures)                         as fixture_rows;
