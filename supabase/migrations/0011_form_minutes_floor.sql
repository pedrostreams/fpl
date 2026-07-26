-- ---------------------------------------------------------------------------
-- 0011 — form needs a much higher minutes floor than the rest of the app
-- ---------------------------------------------------------------------------
-- Caught by looking at the rendered dashboard rather than by any check passing or failing.
-- "Players in form" was topped by Osula on 76 points, ahead of Haaland on 239, because in
-- preseason the panel falls back to last season's points per 90 and the 450-minute
-- reliability floor is far too low for a *rate* to be stable. A player with 500 minutes and
-- one hot fortnight outranks a player with 2 900 minutes of sustained output. The panel was
-- confidently recommending exactly the wrong players.
--
-- 450 minutes is the right floor for the scout screen, where the rate sits beside a percentile
-- and a `new` badge and the reader can see the sample. It is the wrong floor for a ranked
-- "who is hot" list, where the rate IS the ranking and nothing else is visible.
--
-- So: 900 minutes — ten full matches — for the fallback basis only. Once FPL's own `form`
-- field is live it needs no floor at all, because a 30-day average is inherently recent and
-- self-limiting. Minutes are also now exposed so the panel can show its own sample size.

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
where s.is_available
  and (
    -- Live form: FPL's own 30-day average, no minutes floor needed.
    coalesce(m.form, 0) > 0
    -- Fallback: a rate, so it needs enough minutes to be a rate and not an accident.
    or (s.has_reliable_sample and coalesce(s.minutes, 0) >= 900)
  )
order by case when coalesce(m.form, 0) > 0 then m.form else s.points_per_90 end desc nulls last;
