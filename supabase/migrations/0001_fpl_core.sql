-- 0001_fpl_core.sql — FPL core dimensions, facts, and the snapshot time series.
--
-- Append-only and idempotent: safe to re-run from scratch. See docs/SYNC_PLAN.md §2.
--
-- Key decision: every foreign key uses FPL's *stable* `code`, never the season-scoped
-- `id`, because FPL reuses element/team ids across seasons. Season-scoped ids live in
-- `player_seasons` / `team_seasons` so payloads that reference them can still be parsed.

-- ---------------------------------------------------------------------------
-- Dimensions
-- ---------------------------------------------------------------------------

create table if not exists seasons (
  name          text primary key,              -- '2026-27'
  is_current    boolean     not null default false,
  gw1_deadline  timestamptz,
  updated_at    timestamptz not null default now()
);

create table if not exists teams (
  code        int  primary key,                -- stable across seasons
  name        text not null,
  short_name  text,
  pulse_id    int,
  updated_at  timestamptz not null default now()
);

create table if not exists team_seasons (
  season                 text not null references seasons(name) on delete cascade,
  team_code              int  not null references teams(code)   on delete cascade,
  fpl_id                 int  not null,        -- season-scoped 1..20
  -- NOTE: every strength_* field is 0 until the season actually starts (verified
  -- 2026-07-26). Use ClubElo / odds for preseason fixture difficulty instead.
  strength               int,
  strength_overall_home  int,
  strength_overall_away  int,
  strength_attack_home   int,
  strength_attack_away   int,
  strength_defence_home  int,
  strength_defence_away  int,
  played int, win int, draw int, loss int, points int, position int,
  form   text,
  updated_at timestamptz not null default now(),
  primary key (season, team_code),
  unique (season, fpl_id)
);

create table if not exists players (
  code         int  primary key,               -- stable across seasons
  first_name   text,
  second_name  text,
  web_name     text,
  known_name   text,
  birth_date   date,
  region       int,
  opta_code    text,                           -- e.g. 'p223094'; no free source bridges it
  photo        text,
  updated_at   timestamptz not null default now()
);

create table if not exists player_seasons (
  season         text not null references seasons(name) on delete cascade,
  player_code    int  not null references players(code) on delete cascade,
  fpl_id         int  not null,                -- season-scoped element id
  element_type   int,                          -- 1 GK, 2 DEF, 3 MID, 4 FWD
  team_code      int  references teams(code),
  start_cost     int,                          -- now_cost - cost_change_start
  squad_number   int,
  team_join_date date,
  updated_at     timestamptz not null default now(),
  primary key (season, player_code),
  unique (season, fpl_id)
);

create table if not exists events (
  season                text not null references seasons(name) on delete cascade,
  id                    int  not null,
  name                  text,
  deadline_time         timestamptz,
  finished              boolean,
  data_checked          boolean,
  is_previous           boolean,
  is_current            boolean,
  is_next               boolean,
  average_entry_score   int,
  highest_score         int,
  most_selected         int,
  most_transferred_in   int,
  top_element           int,
  most_captained        int,
  most_vice_captained   int,
  transfers_made        bigint,
  ranked_count          bigint,
  chip_plays            jsonb,
  updated_at            timestamptz not null default now(),
  primary key (season, id)
);

create table if not exists fixtures (
  season                text not null references seasons(name) on delete cascade,
  fpl_id                int  not null,
  code                  bigint,
  event                 int,                   -- null for unscheduled fixtures
  kickoff_time          timestamptz,
  started               boolean,
  finished              boolean,
  finished_provisional  boolean,
  minutes               int,
  team_h_code           int references teams(code),
  team_a_code           int references teams(code),
  team_h_score          int,
  team_a_score          int,
  team_h_difficulty     int,                   -- FPL's integer FDR 1-5
  team_a_difficulty     int,
  pulse_id              int,
  stats                 jsonb,                 -- per-player goals/assists/bps after FT
  updated_at            timestamptz not null default now(),
  primary key (season, fpl_id)
);

create index if not exists fixtures_event_idx        on fixtures (season, event);
create index if not exists fixtures_kickoff_idx      on fixtures (kickoff_time);
create index if not exists player_seasons_team_idx   on player_seasons (season, team_code);

-- ---------------------------------------------------------------------------
-- player_snapshots — the one table that cannot be backfilled
-- ---------------------------------------------------------------------------
-- The FPL API has no history endpoint. Any moment we don't sample is gone forever.
-- Written insert-on-change (see docs/SYNC_PLAN.md §4): a naive hourly insert of all
-- 558 players is ~4M rows/season (~600 MB with indexes), over Supabase's 500 MB free
-- tier. Comparing against the previous row keeps every transition while dropping the
-- long runs where a low-owned player doesn't move.

create table if not exists player_snapshots (
  id                            bigserial primary key,
  season                        text not null,
  player_code                   int  not null references players(code) on delete cascade,
  captured_at                   timestamptz not null,
  event                         int,           -- the 'next' gameweek at capture time
  now_cost                      int,
  selected_by_percent           numeric(6,3),
  transfers_in_event            int,
  transfers_out_event           int,
  transfers_in                  bigint,
  transfers_out                 bigint,
  cost_change_event             int,
  cost_change_event_fall        int,
  cost_change_start             int,
  cost_change_start_fall        int,
  price_change_percent          numeric(8,3), -- FPL's own predictor, new for 2026/27
  form                          numeric(6,2),
  ep_this                       numeric(6,2),
  ep_next                       numeric(6,2),
  status                        text,          -- a | d | i | s | u
  chance_of_playing_next_round  int,
  news                          text,
  total_points                  int,
  event_points                  int,
  unique (season, player_code, captured_at)
);

create index if not exists player_snapshots_player_idx on player_snapshots (player_code, captured_at desc);
create index if not exists player_snapshots_season_idx on player_snapshots (season, captured_at desc);

-- One row per actual price move, with the net-transfer state that preceded it.
-- Tiny (~10-30 rows/night) and exempt from rollup: this is the labelled training set
-- for the price model.
create table if not exists player_price_events (
  id                         bigserial primary key,
  season                     text not null,
  player_code                int  not null references players(code) on delete cascade,
  changed_at                 timestamptz not null,   -- when the change was detected
  old_cost                   int not null,
  new_cost                   int not null,
  delta                      int generated always as (new_cost - old_cost) stored,
  prev_captured_at           timestamptz,
  prev_transfers_in_event    int,
  prev_transfers_out_event   int,
  prev_selected_by_percent   numeric(6,3),
  prev_price_change_percent  numeric(8,3),
  unique (season, player_code, changed_at)
);

create index if not exists player_price_events_season_idx on player_price_events (season, changed_at desc);

-- ---------------------------------------------------------------------------
-- Aggregates
-- ---------------------------------------------------------------------------
-- `season` is the season the NUMBERS DESCRIBE, which is not always the season being
-- synced: verified 2026-07-26, the 2026/27 bootstrap payload carried Haaland's 2025/26
-- totals (minutes 2953, xG 25.50). `source` distinguishes where a row came from so a
-- bootstrap carry-over can never silently overwrite a settled history_past row.

create table if not exists player_season_totals (
  season       text not null,
  player_code  int  not null references players(code) on delete cascade,
  source       text not null,                 -- 'bootstrap' | 'history_past'
  start_cost   int,
  end_cost     int,
  total_points int,
  minutes      int,
  starts       int,
  goals_scored int,
  assists      int,
  clean_sheets int,
  goals_conceded int,
  own_goals    int,
  penalties_saved   int,
  penalties_missed  int,
  yellow_cards int,
  red_cards    int,
  saves        int,
  bonus        int,
  bps          int,
  influence    numeric,
  creativity   numeric,
  threat       numeric,
  ict_index    numeric,
  clearances_blocks_interceptions int,
  recoveries   int,
  tackles      int,
  defensive_contribution int,
  expected_goals               numeric,
  expected_assists             numeric,
  expected_goal_involvements   numeric,
  expected_goals_conceded      numeric,
  updated_at   timestamptz not null default now(),
  primary key (season, player_code, source)
);

-- Per-gameweek rows. `fixture` is part of the key because double gameweeks give a
-- player two rows in one event; it defaults to 0 rather than null so the PK holds.
create table if not exists player_gw_stats (
  season       text not null,
  player_code  int  not null references players(code) on delete cascade,
  event        int  not null,
  fixture      int  not null default 0,
  opponent_team_code int references teams(code),
  was_home     boolean,
  kickoff_time timestamptz,
  team_h_score int,
  team_a_score int,
  minutes      int,
  total_points int,
  goals_scored int,
  assists      int,
  clean_sheets int,
  goals_conceded int,
  own_goals    int,
  penalties_saved  int,
  penalties_missed int,
  yellow_cards int,
  red_cards    int,
  saves        int,
  bonus        int,
  bps          int,
  influence    numeric,
  creativity   numeric,
  threat       numeric,
  ict_index    numeric,
  clearances_blocks_interceptions int,
  recoveries   int,
  tackles      int,
  defensive_contribution int,
  starts       int,
  expected_goals             numeric,
  expected_assists           numeric,
  expected_goal_involvements numeric,
  expected_goals_conceded    numeric,
  value        int,                            -- price at the time of that gameweek
  selected     bigint,
  transfers_in int,
  transfers_out int,
  transfers_balance int,
  updated_at   timestamptz not null default now(),
  primary key (season, player_code, event, fixture)
);

create index if not exists player_gw_stats_event_idx on player_gw_stats (season, event);

-- ---------------------------------------------------------------------------
-- Observability — without this, a silently-skipped cron is invisible
-- ---------------------------------------------------------------------------

create table if not exists sync_runs (
  id            bigserial primary key,
  job           text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running',   -- running | ok | error
  rows_touched  int  not null default 0,
  detail        jsonb,
  error         text
);

create index if not exists sync_runs_job_idx on sync_runs (job, started_at desc);

create or replace view sync_freshness as
select
  job,
  max(started_at)                                        as last_attempt,
  max(finished_at) filter (where status = 'ok')           as last_ok,
  now() - max(finished_at) filter (where status = 'ok')   as age,
  count(*) filter (where status = 'error'
                     and started_at > now() - interval '24 hours') as errors_24h
from sync_runs
group by job;
