-- ---------------------------------------------------------------------------
-- 0020 — team_code where a crest or a club link needs one
-- ---------------------------------------------------------------------------
-- The shared player component (`components/player-identity.tsx`) renders a club crest and
-- links the club to its profile page, both keyed on `teams.code` — the badge path is
-- resources.premierleague.com/premierleague25/badges/{code}.svg, verified against all 20 clubs.
--
-- Most views already carried it: player_scout, target_players, hidden_gems, captain_picks,
-- watchlist_detail, form_players, player_wide. Two did not, and both feed a surface that now
-- shows identity — `search_index` (the header search, on every page) and `player_movement`
-- (/prices).
--
-- WHY `code` AND NOT `fpl_id`. Season-scoped ids are reused between seasons; `code` is stable
-- and is what every FK in this schema uses. Keying artwork on the id would repaint half the
-- league the day FPL renumbers, silently and plausibly.
--
-- CREATE OR REPLACE, WITH THE NEW COLUMN LAST. Postgres allows replacing a view when the new
-- definition keeps every existing column in the same position and type, and permits additions
-- **at the end of the list**. That is the whole reason the column goes last rather than beside
-- `team_short` where it reads better: appending replaces in place, while reordering would force
-- `drop ... cascade`. Migration 0016 is the cautionary tale — a cascade there took
-- `fixture_difficulty` and eleven dependent views with it, and because that file sorts last
-- nothing rebuilt them. `search_index` has `profile_check` downstream; `player_movement` has
-- `form_players`, `movement_check` and `watchlist_detail`. None of them are touched by this.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- search_index — a club crest beside every result
-- ---------------------------------------------------------------------------
-- For a player row this is the club he plays for. For a club row it is the club itself, which
-- is already `code` — repeated into `team_code` so the component needs no branch.
create or replace view search_index as
select
  'player'                                                      as kind,
  s.player_code                                                 as code,
  s.web_name                                                    as label,
  concat_ws(' · ', s.position, s.team_name,
            case when s.price is not null then '£' || s.price end) as sublabel,
  s.position,
  s.team_short,
  lower(concat_ws(' ', s.web_name, s.first_name, s.second_name, s.team_name, s.team_short,
                  s.position))                                  as haystack,
  coalesce(s.total_points, 0)                                   as weight,
  s.team_code
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
  10000,
  t.code
from teams t
left join team_seasons ts
  on ts.team_code = t.code and ts.season = (select stats_season from season_context);

-- ---------------------------------------------------------------------------
-- player_movement — /prices gets crests and club links
-- ---------------------------------------------------------------------------
-- Unchanged apart from the final column. `ps` is the left-joined `player_seasons` row that
-- `team_short` and `team_name` already come from via `teams t`, so a player between clubs
-- yields null here exactly as it already does there — and `TeamBadge` renders nothing for a
-- null code rather than a broken frame.
create or replace view player_movement as
with latest as (
  select distinct on (player_code)
    player_code, captured_at, now_cost, selected_by_percent,
    transfers_in, transfers_out, transfers_in_event, transfers_out_event,
    cost_change_event, cost_change_start, price_change_percent,
    form, ep_next, status, chance_of_playing_next_round, news, total_points
  from player_snapshots
  order by player_code, captured_at desc
),
-- The most recent row at or before the cutoff. Not the nearest row to it.
ref_24h as (
  select distinct on (player_code)
    player_code, now_cost, selected_by_percent, transfers_in, transfers_out
  from player_snapshots
  where captured_at <= now() - interval '24 hours'
  order by player_code, captured_at desc
),
ref_7d as (
  select distinct on (player_code)
    player_code, now_cost, selected_by_percent, transfers_in, transfers_out
  from player_snapshots
  where captured_at <= now() - interval '7 days'
  order by player_code, captured_at desc
)
select
  l.player_code,
  p.web_name,
  et.singular_name_short                                            as position,
  l.captured_at                                                     as as_of,
  t.short_name                                                      as team_short,
  t.name                                                            as team_name,
  round(l.now_cost::numeric / 10.0, 1)                              as price,
  l.selected_by_percent,
  l.status,
  l.chance_of_playing_next_round,
  l.news,
  l.total_points,
  l.form,
  l.ep_next,
  l.price_change_percent,
  l.cost_change_event,
  l.cost_change_start,
  l.transfers_in_event,
  l.transfers_out_event,
  l.transfers_in_event - l.transfers_out_event                       as net_transfers_event,
  r24.player_code is not null                                        as has_24h_history,
  round((l.now_cost - r24.now_cost)::numeric / 10.0, 1)              as price_delta_24h,
  round(l.selected_by_percent - r24.selected_by_percent, 3)          as ownership_delta_24h,
  l.transfers_in - r24.transfers_in                                  as transfers_in_24h,
  l.transfers_out - r24.transfers_out                                as transfers_out_24h,
  l.transfers_in - r24.transfers_in
    - (l.transfers_out - r24.transfers_out)                          as net_transfers_24h,
  r7.player_code is not null                                         as has_7d_history,
  round((l.now_cost - r7.now_cost)::numeric / 10.0, 1)               as price_delta_7d,
  round(l.selected_by_percent - r7.selected_by_percent, 3)           as ownership_delta_7d,
  l.transfers_in - r7.transfers_in
    - (l.transfers_out - r7.transfers_out)                           as net_transfers_7d,
  ps.team_code
from latest l
join players p            on p.code = l.player_code
left join player_seasons ps on ps.player_code = l.player_code
                           and ps.season = (select current_season from season_context)
left join teams t         on t.code = ps.team_code
left join element_types et on et.id = ps.element_type
left join ref_24h r24     on r24.player_code = l.player_code
left join ref_7d r7       on r7.player_code = l.player_code;

-- ---------------------------------------------------------------------------
-- Assertion
-- ---------------------------------------------------------------------------
-- A crest that silently fails to render is the kind of fault nobody reports, so make the join
-- checkable. `search_index` must have a code for every row; `player_movement` may legitimately
-- lack one for a player with no current-season club, which is why the two are counted apart.
create or replace view badge_check as
select
  (select count(*) from search_index)                                    as search_rows,
  (select count(*) from search_index where team_code is null)            as search_missing_code,
  (select count(*) from search_index where kind = 'team'
     and code <> team_code)                                              as club_rows_mismatched,
  (select count(*) from player_movement)                                 as movement_rows,
  (select count(*) from player_movement where team_code is null)         as movement_missing_code,
  -- Every code referenced must actually be a club, or the badge URL 404s.
  (select count(*) from search_index s
    where s.team_code is not null
      and not exists (select 1 from teams t where t.code = s.team_code))  as search_orphan_codes,
  (select count(*) from player_movement m
    where m.team_code is not null
      and not exists (select 1 from teams t where t.code = m.team_code))  as movement_orphan_codes;
