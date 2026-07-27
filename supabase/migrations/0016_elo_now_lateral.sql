-- ---------------------------------------------------------------------------
-- 0016 — the four seconds every fixture screen was paying
-- ---------------------------------------------------------------------------
-- `select * from next_gameweek` took 3.99s. It returns two integers. The plan said why:
--
--     ->  Subquery Scan on eo  (actual time=0.016..4.873 rows=10 loops=760)
--           ->  Index Scan using elo_team_idx on club_elo  (rows=10562 loops=760)
--                 Buffers: shared hit=132430
--
-- `elo_now` is `distinct on (team_code) ... order by team_code, valid_from desc`. A DISTINCT ON
-- cannot stop at the first row per team — it walks the whole index and discards — so each
-- evaluation scans about 21 900 rows. `fixture_difficulty` joins it twice, once for each side,
-- and the planner chose a nested loop, so the scan ran 760 times: 132 430 buffer hits to answer
-- "which gameweek is next".
--
-- Two independent faults, both fixed here.
--
-- FAULT 1: elo_now scans instead of seeking.
--
-- Driving from `teams` with a LATERAL top-1 turns it into 20 index seeks — one per club,
-- each landing on the newest qualifying row and stopping. Same result, same `valid_from <=
-- current_date` bound that 0008 added, and `teams` is the more honest driver anyway: we want
-- a rating for every club, and a club with no ClubElo row should surface as a NULL rather
-- than vanish from the join. Hence LEFT JOIN LATERAL, not CROSS.
--
-- FAULT 2: next_gameweek asks the wrong table.
--
-- "Which gameweek is next" is a property of the fixture list, not of the difficulty model,
-- but the view read `fixture_difficulty` — so a question needing one index scan of `fixtures`
-- dragged the entire Elo join through with it. Reading `fixtures` directly makes it trivial,
-- and it removes the circular smell of the difficulty model being consulted to decide which
-- gameweek to compute difficulty for.
--
-- Measured after: next_gameweek 3.99s → 6ms, player_wide 2.6s → 0.3s.

-- REPLACE, not DROP CASCADE. The first draft of this file dropped `elo_now` with a cascade,
-- which took `fixture_difficulty` and the eleven views built on it with it — and because this
-- file sorts last, nothing rebuilt them. One `migrate.py` pass left the database without
-- `fixture_difficulty` at all. `create or replace` is legal here precisely because the column
-- list, order and types are unchanged; only the plan differs. If a future edit changes the
-- shape, it needs a drop and every dependent recreated in the same file.
create or replace view elo_now as
select
  t.code                                                        as team_code,
  e.elo,
  e.rank                                                        as elo_rank,
  e.valid_from                                                  as elo_as_of
from teams t
left join lateral (
  select c.elo, c.rank, c.valid_from
  from club_elo c
  -- The bound from 0008, kept: ClubElo publishes future-dated rows, and for an upcoming
  -- fixture the right input is today's strength, not a rating stamped with a later date.
  where c.team_code = t.code
    and c.valid_from <= current_date
  order by c.valid_from desc
  limit 1
) e on true;

-- ---------------------------------------------------------------------------
-- next_gameweek — ask the fixture list, not the difficulty model
-- ---------------------------------------------------------------------------
-- Redefines 0010's version, so the two must agree and this one wins. Replaced rather than
-- dropped for the same reason as above: `captain_picks` and `team_fixture_context` both read
-- it, and a cascade from the last file in the directory has nothing left to rebuild it.
create or replace view next_gameweek as
select
  min(f.event)                                                  as gameweek,
  (select min(f2.kickoff_time) from fixtures f2
    where f2.event = min(f.event)
      and f2.season = (select current_season from season_context)
      and not coalesce(f2.finished, false))                     as first_kickoff
from fixtures f
where f.season = (select current_season from season_context)
  and not coalesce(f.finished, false)
  and f.event is not null;
