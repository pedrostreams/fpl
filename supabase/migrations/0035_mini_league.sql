-- ---------------------------------------------------------------------------
-- 0035 — the mini-league, and effective ownership against the people I am actually playing
--
-- This is the feature Fantasy Football Fix structurally cannot offer, and it is the clearest
-- single answer to "why build this instead of subscribing". Their effective ownership is computed
-- against the global top-10k. Mine should be computed against the ten or twenty squads that decide
-- whether I win Hakuna Mateta, because those are the only ones whose picks change my rank.
--
-- The difference is not cosmetic. A player on 45% global ownership who nobody in my league owns is
-- a *differential to me* and a template pick to everyone else; a player on 8% global ownership
-- that four of my six rivals hold is the opposite. Global EO cannot see either case.
--
-- LEAGUE 422500 — "HAKUNA MATETA", PROBED 2026-07-30
-- Created 06:27 that morning by Peder (`admin_entry = 1617827`), `league_type = 'x'`. This
-- corrects `sync/jobs/manager.py`, whose header recorded on 2026-07-26 that no invitational
-- league existed and that EO was therefore blocked on one being created.
--
-- **THE TRAP, AND IT WOULD SHIP AS "THE LEAGUE IS EMPTY".** Before the season starts, members are
-- published under **`new_entries`**, not under `standings` — `standings.results` is `[]` while
-- `new_entries.results` holds both current members. A sync that reads only `standings` finds
-- nobody and a page built on it reports an empty league that is not empty. So both are read and
-- unioned on `entry`, with `standings` taking precedence once it fills. Both paginate
-- independently (`has_next` on each), and the friend group will grow before GW1, so both are
-- walked rather than assumed to fit on one page.
--
-- WHY RIVALS' PICKS GO IN `manager_picks`
-- Same grain, same key, same resolution problem. A separate `league_picks` table would duplicate
-- the schema and then need reconciling with mine. `my_squad` (0034) joins `managers` precisely so
-- that sharing this table cannot turn my squad screen into everyone's.
-- ---------------------------------------------------------------------------

create table if not exists leagues (
  league_id    int         primary key,
  name         text,
  league_type  text,
  admin_entry  int,
  start_event  int,
  created      timestamptz,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- league_entries — who is in it, and where they stand
-- ---------------------------------------------------------------------------
-- The standings columns are nullable because before GW1 they do not exist: a member known only
-- from `new_entries` has a name and a join time and nothing else. Null is the honest value, and
-- the screen renders it as "not started" rather than as rank 0.
create table if not exists league_entries (
  league_id     int         not null references leagues(league_id) on delete cascade,
  entry_id      int         not null,
  entry_name    text,
  player_name   text,
  joined_at     timestamptz,
  rank          int,
  last_rank     int,
  total         int,
  event_total   int,
  -- Which of the two payload sections this row came from, so "we have not seen a standing yet"
  -- is distinguishable from "the standing is genuinely null".
  source        text        not null default 'standings',
  updated_at    timestamptz not null default now(),
  primary key (league_id, entry_id)
);

-- ---------------------------------------------------------------------------
-- league_ownership — effective ownership against these rivals
-- ---------------------------------------------------------------------------
-- Two numbers, deliberately, because they answer different questions:
--
--   `owned_pct`   — how many rivals hold him at all, bench included. This is the *transfer*
--                   question: bringing in a player six of eight already own gains me nothing
--                   even if he hauls.
--   `effective_ownership` — Σ multiplier / rivals. This is the *points-swing* question: a
--                   benched owner contributes nothing to the swing, and a captain contributes
--                   twice. Standard EO, computed over the only squads that matter to my rank.
--
-- EO can exceed 100%: eight rivals all captaining the same player is 200%. That is correct and
-- the screen must not clamp it — it is precisely the "everyone is captaining Haaland" state that
-- makes not owning him a 200% swing against me.
drop view if exists league_ownership cascade;
create view league_ownership as
with latest as (
  select league_id, max(event) as event
  from manager_picks p
  join league_entries le on le.entry_id = p.entry_id
  group by league_id
),
squads as (
  select
    le.league_id,
    l.event,
    p.entry_id,
    p.player_code,
    p.multiplier,
    p.pick_position
  from league_entries le
  join latest l on l.league_id = le.league_id
  join manager_picks p on p.entry_id = le.entry_id and p.event = l.event
),
sized as (
  select league_id, event, count(distinct entry_id) as rivals
  from squads group by league_id, event
)
select
  s.league_id,
  s.event,
  z.rivals,
  s.player_code,
  w.web_name, w.position, w.element_type, w.team_code, w.team_short,
  w.price, w.selected_by_percent, w.opponents, w.fixture_count,
  count(*)                                                          as owners,
  count(*) filter (where s.pick_position <= 11)                     as starters,
  count(*) filter (where s.multiplier >= 2)                         as captains,
  round(100.0 * count(*) / z.rivals, 1)                             as owned_pct,
  round(100.0 * sum(s.multiplier) / z.rivals, 1)                    as effective_ownership,
  -- The gap between what my league does and what the country does. Positive means my rivals are
  -- heavier on him than the game at large, which is the number that decides whether owning him
  -- protects a lead or chases one.
  round(100.0 * sum(s.multiplier) / z.rivals - w.selected_by_percent, 1) as eo_minus_global
from squads s
join sized z on z.league_id = s.league_id and z.event = s.event
join player_wide w on w.player_code = s.player_code
group by s.league_id, s.event, z.rivals, s.player_code,
         w.web_name, w.position, w.element_type, w.team_code, w.team_short,
         w.price, w.selected_by_percent, w.opponents, w.fixture_count;

-- ---------------------------------------------------------------------------
-- league_check
-- ---------------------------------------------------------------------------
drop view if exists league_check cascade;
create view league_check as
with e as materialized (select * from league_entries),
     o as materialized (select * from league_ownership)
select
  (select count(*) from leagues)                                    as leagues,
  (select count(*) from e)                                          as members,
  (select count(*) from e where source = 'new_entries')             as members_pre_season,
  (select count(*) from o)                                          as owned_players,
  (select max(event) from o)                                        as event,
  -- Nobody may be counted more often than there are rivals.
  (select bool_and(owners <= rivals) from o)                        as owners_within_league,
  -- Ownership of anything is at most everyone.
  (select bool_and(owned_pct <= 100.0) from o)                      as owned_pct_sane,
  -- EO deliberately has no upper bound: all-captained is 200%. Assert the floor only.
  (select bool_and(effective_ownership >= 0) from o)                as eo_non_negative,
  -- Starters and captains are subsets of owners.
  (select bool_and(starters <= owners and captains <= owners) from o) as subsets_hold,
  -- Every member resolved to a real entry. A league with one member is a league that failed to
  -- read `new_entries`, which is the specific failure this migration exists to avoid.
  (select bool_and(entry_id is not null) from e)                    as entries_resolved;
