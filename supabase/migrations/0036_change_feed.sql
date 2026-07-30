-- ---------------------------------------------------------------------------
-- 0036 — what changed since you last looked
--
-- The app answers every question in the present tense. Nothing tells you what *moved*, so
-- finding the three facts that changed since Tuesday means sweeping seven pages — and that,
-- rather than the page count, is what makes the tool feel scattered.
--
-- The odd part is that we already store the changes. Three tables are change logs by
-- construction and none of them is read as one:
--
--   `player_snapshots`     insert-on-change — every row IS a movement
--   `player_price_events`  a labelled price change, with both costs
--   `market_odds`          append-on-change — every row IS a re-pricing
--
-- So this migration adds almost no data. It adds a reading of data we have been accumulating
-- since 2026-07-26.
--
-- TWO NEW SNAPSHOT COLUMNS, AND THE MEASUREMENT THAT ALLOWED THEM
-- `SYNC_PLAN.md` §8's rule is that `WATCHED` may not grow without measuring row volume first,
-- because a naive hourly insert of 558 players is ~4M rows a season and the free tier is 500 MB.
-- Measured 2026-07-30 over the 1 478 rows and 84.3 hours captured so far:
--
--   news changed 9 times, and **0 of those were news-only** — every one arrived with a status
--   change, so the row already existed and adding `news` to WATCHED costs nothing today. The
--   honest upper bound in season is every news change, ~2.6/day, ~100 rows/season.
--
-- Set-piece order is not in `player_snapshots` at all — it lives on `player_seasons`, which is
-- upserted, so the old value is overwritten and a new penalty taker is invisible. That is one of
-- the largest single-week signals in the game. Three int columns, changing a handful of times a
-- season per club, is the cheapest possible way to see it happen.
--
-- WHAT THIS VIEW DELIBERATELY DOES NOT DO
-- It does not rank, score or filter by importance. A feed that decides what matters is a feed
-- that hides the thing you were looking for; the reader's own squad and watchlist are the filter,
-- applied at query time.
-- ---------------------------------------------------------------------------

alter table player_snapshots add column if not exists penalties_order        int;
alter table player_snapshots add column if not exists corners_order          int;
alter table player_snapshots add column if not exists direct_freekicks_order int;

-- ---------------------------------------------------------------------------
-- change_feed — one row per thing that happened
-- ---------------------------------------------------------------------------
-- A union rather than a table, so there is nothing to backfill and nothing to keep in step: the
-- feed is a *reading* of the logs, and a log that gains a row gains a feed entry for free.
--
-- `kind` is a code, not a sentence, for the same reason `sell_candidates` emits reason codes: the
-- screen owns the wording, the view owns the fact.
drop view if exists change_feed cascade;
create view change_feed as

-- Price. The only one of these that has its own labelled table, because the price model needs it
-- as a training set (0009).
select
  'price'::text                                              as kind,
  e.changed_at                                               as at,
  e.player_code,
  null::int                                                  as team_code,
  (e.new_cost - e.old_cost)::numeric / 10                    as delta,
  (e.old_cost::numeric / 10)::text                           as before,
  (e.new_cost::numeric / 10)::text                           as after,
  null::text                                                 as note
from player_price_events e

union all

-- Availability. `status` and `chance_of_playing_next_round` are both in WATCHED already, so
-- these rows exist today; `news` joins them in this migration and carries the *reason*, which is
-- the half a manager actually acts on.
select
  'availability',
  s.captured_at,
  s.player_code,
  null,
  (coalesce(s.chance_of_playing_next_round, 100)
     - coalesce(prev.chance_of_playing_next_round, 100))::numeric,
  prev.status,
  s.status,
  nullif(s.news, '')
from player_snapshots s
join lateral (
  select p.status, p.chance_of_playing_next_round, p.news
  from player_snapshots p
  where p.player_code = s.player_code
    and p.season = s.season
    and p.captured_at < s.captured_at
  order by p.captured_at desc
  limit 1
) prev on true
where s.status is distinct from prev.status
   or s.chance_of_playing_next_round is distinct from prev.chance_of_playing_next_round
   or s.news is distinct from prev.news

union all

-- Set pieces. Null before 0036 — the columns did not exist — so the first capture after this
-- migration establishes a baseline and emits nothing, which is correct: we did not observe a
-- change, we observed the start of watching.
select
  'set_piece',
  s.captured_at,
  s.player_code,
  null,
  null,
  concat_ws('/', prev.penalties_order, prev.corners_order, prev.direct_freekicks_order),
  concat_ws('/', s.penalties_order, s.corners_order, s.direct_freekicks_order),
  case
    when s.penalties_order is distinct from prev.penalties_order        then 'penalties'
    when s.direct_freekicks_order is distinct from prev.direct_freekicks_order then 'free kicks'
    else 'corners'
  end
from player_snapshots s
join lateral (
  select p.penalties_order, p.corners_order, p.direct_freekicks_order
  from player_snapshots p
  where p.player_code = s.player_code
    and p.season = s.season
    and p.captured_at < s.captured_at
  order by p.captured_at desc
  limit 1
) prev on true
where (s.penalties_order is distinct from prev.penalties_order
    or s.corners_order is distinct from prev.corners_order
    or s.direct_freekicks_order is distinct from prev.direct_freekicks_order)
  -- Both sides must be observed. Otherwise the migration itself would read as 558 changes.
  and (prev.penalties_order is not null or prev.corners_order is not null
       or prev.direct_freekicks_order is not null)

union all

-- The market re-pricing a fixture. Append-on-change, so every row here is a genuine movement —
-- and a market drifting toward a club between Wednesday and Friday is team news being priced in,
-- often before it reaches FPL's own `news` field. That is the reason this source is in the feed
-- at all rather than only on a fixture screen.
select
  'market',
  m.fetched_at,
  null,
  m.team_code,
  round((m.p_win - prev.p_win)::numeric, 4),
  round(prev.p_win::numeric, 3)::text,
  round(m.p_win::numeric, 3)::text,
  -- The opponent, so a line reads "Arsenal v Coventry" rather than "Arsenal, somewhere".
  case when m.is_home then 'v ' else '@ ' end || coalesce(o.short_name, '?')
from fixture_market_odds m
join lateral (
  select p.p_win
  from fixture_market_odds p
  where p.fixture_fpl_id = m.fixture_fpl_id
    and p.team_code = m.team_code
    and p.fetched_at < m.fetched_at
  order by p.fetched_at desc
  limit 1
) prev on true
left join teams o on o.code = m.opponent_code
-- A rounding-level wobble is not news. One percentage point is the smallest move worth a line.
where abs(m.p_win - prev.p_win) >= 0.01;

-- ---------------------------------------------------------------------------
-- change_feed_detail — the feed with names attached
-- ---------------------------------------------------------------------------
-- Separate from the union so the union stays cheap to reason about, and so a caller that only
-- wants counts does not pay for the joins.
drop view if exists change_feed_detail cascade;
create view change_feed_detail as
select
  c.kind,
  c.at,
  c.player_code,
  coalesce(c.team_code, ps.team_code)          as team_code,
  p.web_name,
  et.singular_name_short                       as position,
  t.short_name                                 as team_short,
  c.delta,
  c.before,
  c.after,
  c.note,
  -- Two flags the screen filters on, computed here so the filtering is one indexed predicate
  -- rather than three joins per render.
  (w.player_code is not null)                  as is_watched,
  (sq.player_code is not null)                 as is_mine
from change_feed c
left join players p            on p.code = c.player_code
left join player_seasons ps    on ps.player_code = c.player_code
                              and ps.season = (select current_season from season_context)
left join element_types et     on et.id = ps.element_type
left join teams t              on t.code = coalesce(c.team_code, ps.team_code)
left join watchlist w          on w.player_code = c.player_code
left join (select distinct player_code from my_squad) sq
                               on sq.player_code = c.player_code;

-- ---------------------------------------------------------------------------
-- change_check
-- ---------------------------------------------------------------------------
drop view if exists change_check cascade;
create view change_check as
with f as materialized (select * from change_feed_detail)
select
  count(*)                                                        as events,
  count(*) filter (where kind = 'price')                          as price_events,
  count(*) filter (where kind = 'availability')                   as availability_events,
  count(*) filter (where kind = 'set_piece')                      as set_piece_events,
  count(*) filter (where kind = 'market')                         as market_events,
  min(at)                                                         as earliest,
  max(at)                                                         as latest,
  -- Every event is about something nameable. A player event with no name means the feed is
  -- reading a code the dimension tables do not have, which would render as a blank row.
  bool_and(web_name is not null) filter (where player_code is not null) as players_named,
  bool_and(team_short is not null) filter (where team_code is not null) as teams_named,
  -- A change with no before and no after is not a change.
  bool_and(before is not null or after is not null)               as sides_present,
  -- Nothing may be dated in the future; a clock problem in a feed is invisible otherwise.
  bool_and(at <= now())                                           as not_in_the_future
from f;
