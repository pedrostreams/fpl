-- ---------------------------------------------------------------------------
-- 0009 — price and ownership movement from our own snapshot series
-- ---------------------------------------------------------------------------
-- This is the one screen built on data that exists nowhere else. The FPL API has no history
-- endpoint, so every number here comes from `player_snapshots`, which we capture hourly and
-- which cannot be backfilled.
--
-- THE TRAP THIS VIEW HAS TO AVOID. `player_snapshots` is written insert-on-change (see
-- docs/SYNC_PLAN.md §4), so a player whose price and ownership never moved has exactly ONE
-- row, from the first capture. Two consequences:
--
--   * "the value 24 hours ago" is not "the row nearest 24 hours ago" — it is the most recent
--     row at or before that instant, because the absence of a row means nothing changed.
--   * a player with no row that old has an **undefined** delta, not a zero one. The series
--     simply doesn't reach back that far. Reporting 0 would tell the user "this player is
--     stable" when the truth is "we have not been watching long enough to know", and that is
--     the exact failure the rest of this project treats as unacceptable. Hence the
--     `has_*_history` flags, which the UI uses to hatch rather than shade.
--
-- Verified 2026-07-26, ~3 hours after the first capture: 558 players, 2 instants, 0 price
-- changes, 25 players with ownership drift, max 0.20 percentage points. Prices are frozen
-- until the GW1 deadline unfreezes them, so most of this reads empty until 2026-08-21 and
-- that is the expected state, not a fault.

-- ---------------------------------------------------------------------------
-- snapshot_coverage — how much history do we actually have?
-- ---------------------------------------------------------------------------
-- On screen, so a thin table reads as "we started watching recently" rather than
-- "nothing is happening".
--
-- CAREFUL WITH THE TWO KINDS OF "LAST". Because the table is insert-on-change, a capture that
-- finds nothing moved writes no rows and leaves no trace here at all. So
-- `max(captured_at)` is the last time something CHANGED, which during a frozen preseason
-- market can be hours behind while the job runs perfectly every hour. Using it as a freshness
-- indicator would report a healthy pipeline as dead — exactly backwards. Pipeline liveness
-- comes from `sync_runs`, which records every attempt including the ones that wrote nothing.
drop view if exists snapshot_coverage cascade;
create view snapshot_coverage as
select
  s.rows,
  s.players,
  s.instants,
  s.first_change,
  s.last_change,
  s.change_span_hours,
  round(extract(epoch from now() - s.last_change) / 60.0)          as minutes_since_last_change,
  -- The real health signal: when did the job last RUN, whether or not it wrote anything.
  r.last_run,
  round(extract(epoch from now() - r.last_run) / 60.0)             as minutes_since_last_run,
  -- Does the series reach back far enough for the 24h and 7d columns to mean anything?
  (s.first_change <= now() - interval '24 hours')                  as covers_24h,
  (s.first_change <= now() - interval '7 days')                    as covers_7d
from (
  select
    count(*)                     as rows,
    count(distinct player_code)  as players,
    count(distinct captured_at)  as instants,
    min(captured_at)             as first_change,
    max(captured_at)             as last_change,
    round(extract(epoch from max(captured_at) - min(captured_at)) / 3600.0, 1)
                                 as change_span_hours
  from player_snapshots
) s
cross join (
  select max(started_at) as last_run
  from sync_runs where job = 'snapshot' and status = 'ok'
) r;

-- ---------------------------------------------------------------------------
-- player_movement — what changed, over which window
-- ---------------------------------------------------------------------------
drop view if exists player_movement cascade;
create view player_movement as
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
  -- `singular_name_short`, not `short_name`: element_types mirrors the FPL payload's own
  -- field names, and `short_name` belongs to `teams`.
  et.singular_name_short                           as position,
  l.captured_at                                    as as_of,
  t.short_name                                     as team_short,
  t.name                                           as team_name,
  round(l.now_cost / 10.0, 1)                      as price,
  l.selected_by_percent,
  l.status,
  l.chance_of_playing_next_round,
  l.news,
  l.total_points,
  l.form,
  l.ep_next,

  -- FPL's own price predictor, new for 2026/27. An input signal, not a competitor — we hold
  -- the net-transfer curve it is derived from and it does not expose that.
  l.price_change_percent,
  l.cost_change_event,
  l.cost_change_start,

  -- Net transfers this gameweek, straight from the payload. The direct driver of a price
  -- change, and zero for everyone until the GW1 deadline.
  l.transfers_in_event,
  l.transfers_out_event,
  l.transfers_in_event - l.transfers_out_event     as net_transfers_event,

  -- Movement over 24 hours. Null, never 0, when the series doesn't reach back that far.
  (r24.player_code is not null)                    as has_24h_history,
  round((l.now_cost - r24.now_cost) / 10.0, 1)     as price_delta_24h,
  round(l.selected_by_percent - r24.selected_by_percent, 3) as ownership_delta_24h,
  -- Cumulative transfers differenced over the window: actual transfer velocity, which no
  -- FPL endpoint exposes. This is the column the price model will be trained on.
  (l.transfers_in - r24.transfers_in)              as transfers_in_24h,
  (l.transfers_out - r24.transfers_out)            as transfers_out_24h,
  (l.transfers_in - r24.transfers_in) - (l.transfers_out - r24.transfers_out)
                                                   as net_transfers_24h,

  -- Same over a week, for the slower drift that decides a price rise days ahead.
  (r7.player_code is not null)                     as has_7d_history,
  round((l.now_cost - r7.now_cost) / 10.0, 1)      as price_delta_7d,
  round(l.selected_by_percent - r7.selected_by_percent, 3) as ownership_delta_7d,
  (l.transfers_in - r7.transfers_in) - (l.transfers_out - r7.transfers_out)
                                                   as net_transfers_7d
from latest l
join players p            on p.code = l.player_code
left join player_seasons ps on ps.player_code = l.player_code
                          and ps.season = (select current_season from season_context)
left join teams t         on t.code = ps.team_code
left join element_types et on et.id = ps.element_type
left join ref_24h r24     on r24.player_code = l.player_code
left join ref_7d r7       on r7.player_code = l.player_code;

-- ---------------------------------------------------------------------------
-- movement_check — for `python -m sync.cli verify`
-- ---------------------------------------------------------------------------
drop view if exists movement_check cascade;
create view movement_check as
select
  (select count(*) from player_movement)                          as players,
  (select instants from snapshot_coverage)                        as instants,
  (select change_span_hours from snapshot_coverage)               as change_span_hours,
  (select minutes_since_last_run from snapshot_coverage)          as minutes_since_last_run,
  (select covers_24h from snapshot_coverage)                      as covers_24h,
  -- A missing window must be null, not zero. If any row reports a delta while claiming no
  -- history, the coalesce discipline has broken somewhere.
  (select bool_and(price_delta_24h is null and ownership_delta_24h is null)
     from player_movement where not has_24h_history)              as no_history_means_null,
  -- Every player alive in the current season should appear exactly once.
  (select count(*) = count(distinct player_code) from player_movement) as one_row_per_player,
  (select count(*) from player_movement where net_transfers_event <> 0)
                                                                  as players_with_event_transfers,
  (select count(*) from player_movement
    where has_24h_history and ownership_delta_24h <> 0)            as ownership_movers_24h,
  (select count(*) from player_price_events)                      as price_events_captured;
