-- ---------------------------------------------------------------------------
-- 0010 — the watchlist, the manager's own team, and the dashboard's views
-- ---------------------------------------------------------------------------
-- Two firsts in this migration, both deliberate:
--
--   * `watchlist` is the first table the WEB APP writes to. Everything until now has been
--     read-only over views, with Postgres written only by the Python sync. There is no auth
--     and the app is public, so anyone with the URL can edit the watchlist — Peder chose that
--     knowingly over a cookie gate. It is one row per player with no user column, because
--     there is exactly one user. Adding a second user later means adding that column, not
--     redesigning.
--
--   * `managers` / `manager_seasons` hold Peder's own FPL side. Verified 2026-07-26 against
--     entry 1617827: `entry/{id}/` and `entry/{id}/history/` both answer in preseason, but
--     `entry/{id}/event/1/picks/` returns **404 until the GW1 deadline passes**. The squad
--     genuinely does not exist in the API yet, so the dashboard shows the manager's record and
--     an explicit placeholder rather than pretending otherwise.

create table if not exists watchlist (
  player_code int primary key references players(code) on delete cascade,
  added_at    timestamptz not null default now(),
  note        text
);

-- ---------------------------------------------------------------------------
-- The manager's own record
-- ---------------------------------------------------------------------------
create table if not exists managers (
  entry_id      int primary key,
  name          text,               -- the team name, e.g. 'Joga Bonitos'
  player_name   text,
  favourite_team int references teams(code),
  started_event int,
  current_event int,
  bank          numeric(4,1),
  squad_value   numeric(5,1),
  total_transfers int,
  overall_points int,
  overall_rank  bigint,
  updated_at    timestamptz not null default now()
);

create table if not exists manager_seasons (
  entry_id     int not null references managers(entry_id) on delete cascade,
  season_name  text not null,       -- FPL's own '2025/26' formatting, kept verbatim
  total_points int,
  rank         bigint,
  updated_at   timestamptz not null default now(),
  primary key (entry_id, season_name)
);

-- Which gameweek is next? Every dashboard panel needs this and none of them should each
-- work it out for themselves.
drop view if exists next_gameweek cascade;
create view next_gameweek as
select
  min(gameweek) as gameweek,
  (select min(kickoff_time) from fixture_difficulty fd2
    where fd2.gameweek = min(fd.gameweek) and not coalesce(fd2.finished, false)) as first_kickoff
from fixture_difficulty fd
where not coalesce(fd.finished, false) and fd.gameweek is not null;

-- ---------------------------------------------------------------------------
-- watchlist_detail — the watchlist with everything worth seeing beside it
-- ---------------------------------------------------------------------------
-- Joins the saved players to their scout row, their movement, and their next fixture, so the
-- dashboard panel is one query and the page does no assembly.
drop view if exists watchlist_detail cascade;
create view watchlist_detail as
select
  w.player_code,
  w.added_at,
  w.note,
  s.web_name,
  s.position,
  s.team_short,
  s.team_code,
  s.price,
  s.selected_by_percent,
  s.status,
  s.news,
  s.is_available,
  s.total_points,
  s.minutes,
  s.xgi_per_90,
  s.defcon_per_90,
  s.xgc_per_90,
  s.points_per_million,
  s.output_percentile,
  s.is_cold_start,
  s.penalties_order,
  m.price_change_percent,
  m.net_transfers_event,
  m.ownership_delta_24h,
  m.has_24h_history,
  -- The next fixture, for the "should I bring them in this week" question.
  nf.opponent_short,
  nf.is_home,
  nf.difficulty      as next_difficulty,
  nf.p_clean_sheet   as next_p_clean_sheet,
  nf.expected_goals_for as next_expected_goals_for
from watchlist w
join player_scout s on s.player_code = w.player_code
left join player_movement m on m.player_code = w.player_code
left join lateral (
  select o.short_name as opponent_short, fd.is_home, fd.difficulty,
         fd.p_clean_sheet, fd.expected_goals_for
  from fixture_difficulty fd
  join teams o on o.code = fd.opponent_code
  where fd.team_code = s.team_code
    and fd.gameweek = (select gameweek from next_gameweek)
    and not coalesce(fd.finished, false)
  order by fd.kickoff_time
  limit 1
) nf on true;

-- ---------------------------------------------------------------------------
-- captain_picks — a heuristic, and named so nobody mistakes it for a projection
-- ---------------------------------------------------------------------------
-- Deliberately NOT called "expected points". A real projection needs a minutes model, a
-- bonus-point model and a per-position scoring model, none of which exist yet. This is three
-- honest factors multiplied together, and the screen shows all three so the ranking can be
-- argued with:
--
--   attacking output   xGI/90, the rate at which the player is involved in goals
--   fixture ease       1 - attack_difficulty, from the Elo model calibrated to market odds
--   minutes security   starts per appearance, because a captain who is subbed at 60' is
--                      a wasted armband regardless of how good the rate is
--
-- Only players clearing the 450-minute reliability floor appear. A captain pick built on a
-- three-game sample is worse than no pick.
drop view if exists captain_picks cascade;
create view captain_picks as
select
  s.player_code,
  s.web_name,
  s.position,
  s.team_short,
  s.team_code,
  s.price,
  s.selected_by_percent,
  s.status,
  s.news,
  s.minutes,
  s.xgi_per_90,
  s.points_per_90,
  s.penalties_order,
  fd.gameweek,
  fd.kickoff_time,
  o.short_name                                     as opponent_short,
  o.name                                           as opponent_name,
  fd.is_home,
  fd.p_win,
  fd.difficulty,
  fd.attack_difficulty,
  fd.expected_goals_for,
  round(1.0 - fd.attack_difficulty, 4)             as fixture_ease,
  -- starts/appearances as a minutes-security proxy. `starts` and `minutes` are the only
  -- signals available preseason; after GW1 this should become a real minutes model.
  round(least(1.0, coalesce(s.starts, 0)::numeric
                   / greatest(1, ceil(coalesce(s.minutes, 0) / 90.0))), 3) as minutes_security,
  round(
    coalesce(s.xgi_per_90, 0)
    * (1.0 - fd.attack_difficulty)
    * least(1.0, coalesce(s.starts, 0)::numeric
                 / greatest(1, ceil(coalesce(s.minutes, 0) / 90.0)))
  , 4)                                             as captain_score
from player_scout s
join fixture_difficulty fd on fd.team_code = s.team_code
                         and fd.gameweek = (select gameweek from next_gameweek)
                         and not coalesce(fd.finished, false)
join teams o on o.code = fd.opponent_code
where s.has_reliable_sample
  and s.is_available
  and coalesce(s.xgi_per_90, 0) > 0
order by captain_score desc;

-- ---------------------------------------------------------------------------
-- form_players — who is actually performing right now
-- ---------------------------------------------------------------------------
-- `form` is FPL's own average points over the last 30 days and is 0 for everyone in
-- preseason, so this falls back to last season's per-90 output and says which it is using.
-- The `basis` column exists so the UI never has to guess.
drop view if exists form_players cascade;
create view form_players as
select
  s.player_code, s.web_name, s.position, s.team_short, s.team_code,
  s.price, s.selected_by_percent, s.status, s.total_points, s.minutes,
  s.points_per_90, s.xgi_per_90, s.goals_minus_xg, s.output_percentile,
  m.form,
  case when coalesce(m.form, 0) > 0 then 'form' else 'last_season_rate' end as basis,
  case when coalesce(m.form, 0) > 0 then m.form else s.points_per_90 end     as form_value
from player_scout s
left join player_movement m on m.player_code = s.player_code
where s.has_reliable_sample and s.is_available
order by case when coalesce(m.form, 0) > 0 then m.form else s.points_per_90 end desc nulls last;

-- ---------------------------------------------------------------------------
-- dashboard_check — for `python -m sync.cli verify`
-- ---------------------------------------------------------------------------
drop view if exists dashboard_check cascade;
create view dashboard_check as
select
  (select gameweek from next_gameweek)                          as next_gameweek,
  (select count(*) from watchlist)                              as watchlist_size,
  (select count(*) from watchlist_detail)                        as watchlist_resolved,
  (select count(*) from captain_picks)                           as captain_candidates,
  (select count(distinct team_code) from captain_picks)           as teams_with_candidates,
  (select count(*) from form_players)                            as form_players,
  (select distinct basis from form_players limit 1)               as form_basis,
  (select count(*) from managers)                                as managers,
  (select count(*) from manager_seasons)                         as manager_seasons,
  -- Every watchlisted player must resolve to a scout row, or the join is dropping saves.
  (select count(*) from watchlist) = (select count(*) from watchlist_detail)
                                                                 as watchlist_fully_resolved,
  -- A captain score is a product of three factors each in [0,1]-ish; a negative one means a
  -- sign error upstream.
  (select bool_and(captain_score >= 0) from captain_picks)        as captain_scores_non_negative;
