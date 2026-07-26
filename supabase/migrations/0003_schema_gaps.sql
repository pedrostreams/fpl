-- 0003_schema_gaps.sql — three gaps found while designing the derived views.
--
-- Append-only and idempotent.

-- ---------------------------------------------------------------------------
-- 1. Set-piece taker order
-- ---------------------------------------------------------------------------
-- These sit in `bootstrap-static.elements` and were simply never ingested, despite
-- set-piece threat being on the feature list from the start. FPL publishes them
-- first-party — 64 penalty takers, 60 direct free-kick takers, 71 corner takers as of
-- 2026-07-26 — so this is a free signal that competitors charge for.
--
-- On `player_seasons` rather than `player_snapshots`: they change a handful of times a
-- season, so a per-hour time series would be almost entirely duplicate rows.

alter table player_seasons add column if not exists penalties_order int;
alter table player_seasons add column if not exists penalties_text text;
alter table player_seasons add column if not exists direct_freekicks_order int;
alter table player_seasons add column if not exists direct_freekicks_text text;
alter table player_seasons add column if not exists corners_order int;
alter table player_seasons add column if not exists corners_text text;

create index if not exists player_seasons_penalties_idx
  on player_seasons (season, penalties_order)
  where penalties_order is not null;

-- ---------------------------------------------------------------------------
-- 2. element_types lookup
-- ---------------------------------------------------------------------------
-- `element_type` was stored as a bare int with the meaning living only in comments.
-- The DEFCON threshold is position-dependent, so the mapping now carries logic and
-- belongs in a table.
--
-- Verified against 2025/26 data on 2026-07-26: `defensive_contribution` counts
-- clearances + blocks + interceptions + tackles for DEFENDERS (97 of 99 players match
-- exactly), and additionally counts recoveries for MIDFIELDERS and FORWARDS (125 of 128,
-- and 25 of 25). Goalkeepers score no defensive contribution at all. The handful of
-- mismatches are players whose position changed between seasons.
--
-- Consequence: never recompute `defensive_contribution` from its components with a single
-- formula. Summing CBI + tackles + recoveries for everyone overstates every defender by
-- their entire recovery count. Use FPL's figure, which already applied the right rule.

create table if not exists element_types (
  id                   int primary key,        -- 1 GK, 2 DEF, 3 MID, 4 FWD
  singular_name        text,
  singular_name_short  text,
  plural_name          text,
  squad_select         int,
  squad_min_play       int,
  squad_max_play       int,
  defcon_threshold     int,                    -- qualifying actions needed for 2 points
  updated_at           timestamptz not null default now()
);

insert into element_types (id, singular_name, singular_name_short, plural_name, defcon_threshold)
values
  (1, 'Goalkeeper', 'GKP', 'Goalkeepers', null),
  (2, 'Defender',   'DEF', 'Defenders',   10),
  (3, 'Midfielder', 'MID', 'Midfielders', 12),
  (4, 'Forward',    'FWD', 'Forwards',    12)
on conflict (id) do update set
  singular_name       = excluded.singular_name,
  singular_name_short = excluded.singular_name_short,
  plural_name         = excluded.plural_name,
  defcon_threshold    = excluded.defcon_threshold,
  updated_at          = now();

-- ---------------------------------------------------------------------------
-- 3. Competition label on FPL-Core-Insights per-match rows
-- ---------------------------------------------------------------------------
-- The `By Gameweek/GW{n}/` folders are NOT Premier League only, despite the naming. They
-- carry Champions League, Europa League and EFL Cup fixtures played in the same window:
-- of 519 distinct 2025/26 matches, 379 are `prem`, 64 Champions League, 37 EFL Cup and
-- 26 Europa League. 1 863 player-gameweek pairs have more than one match row.
--
-- Unlabelled, that silently corrupts every per-90: Declan Rice showed 4 246 minutes here
-- against FPL's 3 093, a 37% overstatement, because European minutes were being counted
-- as league minutes.
--
-- Labelled, it becomes a feature rather than a defect — minutes in other competitions are
-- exactly the rotation-and-fatigue signal an FPL manager wants. Views filter to
-- `tournament = 'prem'` for scoring stats and read the rest for congestion.
--
-- The competition is encoded in `match_id`, e.g. `25-26-champions-league-arsenal-vs-...`.

alter table core_insights_player_match
  add column if not exists tournament text;

create index if not exists cipm_tournament_idx
  on core_insights_player_match (season, tournament, player_code);
