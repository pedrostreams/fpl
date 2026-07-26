-- 0002_enrichment.sql — Tier 2 sources: Understat, ClubElo, bookmaker odds,
-- FPL-Core-Insights per-match stats, and cross-source player identity.
--
-- Append-only and idempotent. See docs/DATA_SOURCES.md for what each source provides.
--
-- Two conventions run through every table here:
--
--   1. Store the source's OWN id and name verbatim alongside the resolved FPL key. A bad
--      match can then be re-resolved without re-scraping, and an unresolvable row still
--      carries its data.
--   2. Resolved FPL keys are NULLABLE. The 2026/27 Premier League contains Coventry, Hull
--      and Ipswich while 2025/26 contained Burnley, West Ham and Wolves — so historical
--      enrichment rows legitimately reference clubs absent from `teams`. A null means
--      "not a current Premier League club", not an error.

-- ---------------------------------------------------------------------------
-- Cross-source player identity
-- ---------------------------------------------------------------------------
-- Resolved once at ingest, never fuzzily at query time. FPL exposes `opta_code` but no
-- free scrape source publishes Opta ids, so it doesn't bridge them — name matching is
-- unavoidable, which is exactly why the result must be persisted and sticky.

create table if not exists player_external_ids (
  player_code    int  not null references players(code) on delete cascade,
  source         text not null,              -- 'understat' | 'core_insights' | 'sofascore'
  external_id    text not null,
  external_name  text,                       -- verbatim, for auditing a bad match
  external_team  text,
  method         text,                       -- which cascade rung matched
  confidence     numeric(4,3),
  matched_at     timestamptz not null default now(),
  primary key (player_code, source),
  unique (source, external_id)
);

-- ---------------------------------------------------------------------------
-- Understat
-- ---------------------------------------------------------------------------
-- One row per TEAM per match, not per match. soccerdata returns home_*/away_* column
-- pairs; splitting them means "rolling xGA for team X" is a plain filter instead of a
-- union of two differently-named column sets.
--
-- The opponent's figures are duplicated onto each row on purpose: it makes xGA, PPDA-faced
-- and deep-completions-conceded available without a self-join, at the cost of storing each
-- match twice. 380 matches a season makes that trade obviously worth it.

create table if not exists understat_team_match (
  season                    text not null,          -- '2025-26'
  game_id                   text not null,
  understat_team            text not null,
  team_code                 int  references teams(code),
  is_home                   boolean not null,
  understat_opponent        text,
  opponent_team_code        int  references teams(code),
  kickoff                   timestamptz,
  goals                     int,
  xg                        numeric(6,3),
  np_xg                     numeric(6,3),
  np_xg_difference          numeric(6,3),
  ppda                      numeric(7,3),           -- passes allowed per defensive action
  deep_completions          int,
  points                    int,
  expected_points           numeric(6,3),
  opponent_goals            int,
  opponent_xg               numeric(6,3),
  opponent_np_xg            numeric(6,3),
  opponent_ppda             numeric(7,3),
  opponent_deep_completions int,
  updated_at                timestamptz not null default now(),
  primary key (season, game_id, understat_team)
);

create index if not exists utm_team_idx    on understat_team_match (team_code, kickoff desc);
create index if not exists utm_season_idx  on understat_team_match (season, kickoff desc);

create table if not exists understat_shots (
  season               text not null,
  shot_id              text not null,
  game_id              text,
  understat_player_id  text,
  player_code          int  references players(code),
  understat_player     text,
  understat_team       text,
  team_code            int  references teams(code),
  kickoff              timestamptz,
  minute               int,
  xg                   numeric(6,4),
  location_x           numeric(6,4),               -- 0-1, normalised pitch coordinates
  location_y           numeric(6,4),
  body_part            text,
  situation            text,                       -- Open Play / SetPiece / Penalty / ...
  result               text,                       -- Goal / Saved / Missed / Blocked / ...
  assist_player        text,
  assist_understat_id  text,
  updated_at           timestamptz not null default now(),
  primary key (season, shot_id)
);

create index if not exists ush_player_idx on understat_shots (player_code, kickoff desc);
create index if not exists ush_team_idx   on understat_shots (team_code, season);
create index if not exists ush_situ_idx   on understat_shots (season, situation);

create table if not exists understat_player_season (
  season               text not null,
  understat_player_id  text not null,
  player_code          int  references players(code),
  understat_player     text,
  understat_team       text,
  team_code            int  references teams(code),
  position             text,                       -- letter-coded, e.g. 'F M S'
  matches              int,
  minutes              int,
  goals                int,
  xg                   numeric(7,3),
  np_goals             int,
  np_xg                numeric(7,3),
  assists              int,
  xa                   numeric(7,3),               -- FPL has expected_assists; this is a
                                                   -- second model, useful as a cross-check
  shots                int,
  key_passes           int,
  xg_chain             numeric(7,3),               -- no FPL equivalent
  xg_buildup           numeric(7,3),               -- no FPL equivalent
  yellow_cards         int,
  red_cards            int,
  updated_at           timestamptz not null default now(),
  primary key (season, understat_player_id)
);

-- ---------------------------------------------------------------------------
-- ClubElo
-- ---------------------------------------------------------------------------
-- Continuous, opponent-adjusted team strength with real history — the substitute for
-- FPL's `strength_*` fields, which are all 0 until the season starts. Rows are validity
-- windows, and ClubElo publishes forward-dated ones (verified: Arsenal to 2026-12-31).

create table if not exists club_elo (
  club        text not null,                  -- ClubElo's own name, e.g. 'Forest'
  valid_from  date not null,
  valid_to    date,
  team_code   int  references teams(code),
  country     text,
  level       int,
  elo         numeric(8,3),
  rank        int,                            -- null for lower-ranked clubs
  updated_at  timestamptz not null default now(),
  primary key (club, valid_from)
);

create index if not exists elo_team_idx on club_elo (team_code, valid_from desc);

-- ---------------------------------------------------------------------------
-- Bookmaker odds
-- ---------------------------------------------------------------------------
-- De-vigged consensus probabilities are a far better fixture-difficulty input than FPL's
-- integer 1-5 FDR: continuous, opponent-and-venue aware, and set by people with money at
-- stake. `raw` keeps all 132 source columns so a new market can be derived later without
-- re-fetching.
--
-- Clean-sheet probability is deliberately NOT computed here — it needs a Poisson fit over
-- the 1X2 and over/under lines, which belongs in the derived-views layer, not in ingest.

create table if not exists match_odds (
  season            text not null,            -- '2025-26'
  match_date        date not null,
  home_team_raw     text not null,            -- football-data.co.uk naming
  away_team_raw     text not null,
  home_team_code    int  references teams(code),
  away_team_code    int  references teams(code),
  kickoff_time      text,                     -- source gives HH:MM local, not a timestamp
  home_goals        int,
  away_goals        int,
  result            text,                     -- H | D | A
  avg_home          numeric(8,3),             -- market-average decimal odds
  avg_draw          numeric(8,3),
  avg_away          numeric(8,3),
  avg_over_25       numeric(8,3),
  avg_under_25      numeric(8,3),
  p_home            numeric(6,5),             -- de-vigged (normalised to sum 1)
  p_draw            numeric(6,5),
  p_away            numeric(6,5),
  p_over_25         numeric(6,5),
  p_under_25        numeric(6,5),
  raw               jsonb,
  updated_at        timestamptz not null default now(),
  primary key (season, match_date, home_team_raw, away_team_raw)
);

create index if not exists odds_home_idx on match_odds (home_team_code, match_date desc);
create index if not exists odds_away_idx on match_odds (away_team_code, match_date desc);

-- ---------------------------------------------------------------------------
-- FPL-Core-Insights per-match player stats
-- ---------------------------------------------------------------------------
-- Chosen over Sofascore, which returns 403 to GitHub Actions runners (datacenter IPs).
-- This source is GitHub-hosted, refreshed twice daily, keyed on official FPL player ids,
-- and per-MATCH rather than per-season.
--
-- It covers everything Sofascore uniquely offered (goals_prevented, big_chances_missed,
-- duel splits, keeper detail) plus physical data available nowhere else free: top speed,
-- distance covered, sprint counts.
--
-- `stats` is JSONB rather than 64 columns: this is a third-party feed from a single
-- volunteer with no schema guarantee, so a column appearing or vanishing must not require
-- a migration. Values worth querying get promoted to real columns once they prove stable.

create table if not exists core_insights_player_match (
  season       text not null,
  player_code  int  not null references players(code) on delete cascade,
  ci_player_id int,                           -- source's FPL element id, kept verbatim
  match_id     text not null,
  event        int,
  minutes_played  int,
  start_min       int,
  finish_min      int,
  xg              numeric(6,3),
  xa              numeric(6,3),
  xgot            numeric(6,3),               -- expected goals on target
  goals_prevented numeric(6,3),               -- keepers; was Sofascore-only
  distance_covered numeric(8,2),              -- physical data: no other free source
  top_speed        numeric(6,2),
  stats        jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  primary key (season, player_code, match_id)
);

create index if not exists cipm_event_idx  on core_insights_player_match (season, event);
create index if not exists cipm_player_idx on core_insights_player_match (player_code, season);

-- ---------------------------------------------------------------------------
-- Unmatched-name reporting
-- ---------------------------------------------------------------------------
-- SDG wrote unmatched rows to tmp/<source>-unmatched.json, and that habit is why its
-- mismatches stayed debuggable. Same idea, but in the database so `verify` can surface it
-- instead of it sitting in a gitignored file nobody opens.

create table if not exists unmatched_names (
  id          bigserial primary key,
  source      text not null,
  kind        text not null,                  -- 'player' | 'team'
  external_id text not null,
  raw_name    text,
  raw_team    text,
  -- '' rather than null: a nullable column in a unique index lets duplicate rows through,
  -- because null is never equal to null.
  season      text not null default '',
  seen_at     timestamptz not null default now(),
  unique (source, kind, external_id, season)
);
