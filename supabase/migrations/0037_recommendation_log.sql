-- ---------------------------------------------------------------------------
-- 0037 — the recommendation log: what we said, and what then happened
--
-- Every honesty mechanism in this project so far is a **pre-ship gate**. `prove_style_claims`
-- re-derives a claim independently; `rel(6)` decides which metrics may carry a sentence; §7.2
-- gates a probability on beating a trivial baseline before it renders. All of them ask "is this
-- defensible before anyone sees it".
--
-- None of them asks the other question: **was it right.** This table does, and it is the only
-- thing in the app that can tell Peder whether to trust the app.
--
-- STAMPED, NEVER RECOMPUTED
-- The rows are written at the deadline and are immutable thereafter — `insert_ignore`, not
-- `upsert`, and the writer refuses an event whose deadline has not passed. That is the whole
-- integrity of the idea: a recommendation is only scoreable against the information available at
-- the time it was made, and a log that re-derives its own history is a log that always looks
-- right. Everything needed to explain a row is frozen into `basis` at write time for the same
-- reason — `captain_picks` will give a different answer next week, and next week's answer is not
-- what we said.
--
-- WHY THE UNIT IS A RANK, NOT A SCORE
-- All three sources already emit an ordering, and an ordering is what a reader acts on: nobody
-- transfers in the 0.71, they transfer in the top one. Storing the rank makes the natural
-- questions arithmetic — did the top captain pick out-score the second, did the sell list
-- under-perform the buy list — without committing to any particular score being meaningful.
--
-- ONE DECISION DEFERRED, DELIBERATELY
-- Nothing here scores *Peder's* decisions, only the app's. His actual moves arrive free in
-- `manager_transfers` (0034) and the comparison is a later view. Building it now would mean
-- guessing the shape of a join against a table that has never held a row.
-- ---------------------------------------------------------------------------

create table if not exists recommendation_log (
  season       text        not null,
  event        int         not null,
  -- 'captain_floor' and 'captain_ceiling' are separate kinds rather than one 'captain' with a
  -- flag, because migration 0012 deliberately refuses to collapse the two axes into one ranking
  -- and this table must not undo that by storing a single captain ordering.
  kind         text        not null,
  player_code  int         not null references players(code) on delete cascade,
  rank         int         not null,
  -- Frozen at write time. Whatever the source view said about this player at this instant, so a
  -- row can be explained a month later without asking a view that has since moved on.
  basis        jsonb       not null default '{}'::jsonb,
  stamped_at   timestamptz not null default now(),
  primary key (season, event, kind, player_code)
);

create index if not exists recommendation_log_event_idx
  on recommendation_log (season, event, kind, rank);

-- ---------------------------------------------------------------------------
-- recommendation_scored — the log against what actually happened
-- ---------------------------------------------------------------------------
-- Empty until a gameweek completes: `player_gw_stats` holds 0 rows until GW1 is played, so every
-- `points` here is null and every boolean below is null with a row count beside it. That is the
-- expected state, not a broken join.
--
-- The comparison that matters is against a **baseline**, never in isolation. "Our top captain
-- pick scored 8" means nothing; "our top captain pick scored 8 against a median of 4 for the
-- pool we chose from" means something. So the pool median travels with every row.
drop view if exists recommendation_scored cascade;
create view recommendation_scored as
with actual as (
  select season, event, player_code, total_points, minutes
  from player_gw_stats
),
joined as (
  select
    r.season, r.event, r.kind, r.rank, r.player_code, r.basis, r.stamped_at,
    a.total_points, a.minutes
  from recommendation_log r
  left join actual a
    on a.season = r.season and a.event = r.event and a.player_code = r.player_code
),
pool as (
  -- The median of everyone we recommended in that kind that week. A pick beating the pool it was
  -- drawn from is the claim the ranking actually makes.
  select season, event, kind,
         percentile_cont(0.5) within group (order by total_points) as median_points,
         count(total_points)                                       as scored_players
  from joined
  group by season, event, kind
)
select
  j.season, j.event, j.kind, j.rank, j.player_code,
  p.web_name, ps.element_type, t.short_name as team_short, t.code as team_code,
  j.basis, j.stamped_at,
  j.total_points, j.minutes,
  pool.median_points,
  pool.scored_players,
  -- Null until the gameweek is scored, and null is the honest reading: not "zero points", but
  -- "we do not know yet".
  case when j.total_points is not null and pool.median_points is not null
       then j.total_points - pool.median_points end                as vs_pool_median,
  -- A blank is 0-2 points. The threshold is FPL's own shape rather than a chosen one: 2 points is
  -- an appearance and nothing else.
  case when j.total_points is not null then j.total_points >= 3 end as returned,
  case when j.total_points is not null then j.total_points >= 10 end as hauled
from joined j
join pool on pool.season = j.season and pool.event = j.event and pool.kind = j.kind
left join players p on p.code = j.player_code
left join player_seasons ps
  on ps.player_code = j.player_code and ps.season = j.season
left join teams t on t.code = ps.team_code;

-- ---------------------------------------------------------------------------
-- recommendation_check
-- ---------------------------------------------------------------------------
drop view if exists recommendation_check cascade;
create view recommendation_check as
with per_group as materialized (
  -- One scan, grouped once. Every assertion below is an aggregate over the same rows, which is
  -- migration 0031's rule: a check view built from N scalar subqueries scans its base N times,
  -- and a slow `verify` is a `verify` that gets skipped.
  select
    l.season, l.event, l.kind,
    count(*)                                        as picks,
    count(distinct l.rank)                          as distinct_ranks,
    max(l.rank)                                     as top_rank,
    min(l.rank)                                     as first_rank,
    count(*) filter (where p.code is null)          as unnamed,
    -- The immutability claim, asserted mechanically rather than trusted to the writer. Ten
    -- minutes of slack because the job is dispatched at the deadline, not executed at it.
    bool_and(l.stamped_at <= e.deadline_time + interval '10 minutes') as stamped_in_time
  from recommendation_log l
  left join players p on p.code = l.player_code
  left join events e on e.id = l.event
  group by l.season, l.event, l.kind
)
select
  (select count(*) from recommendation_log)                       as logged,
  (select count(*) from recommendation_scored
    where total_points is not null)                               as scored,
  count(*)                                                        as groups,
  count(distinct kind)                                            as kinds,
  -- Ranks came from an ordering, so within a kind and gameweek they must be 1..n with no gaps
  -- and no ties. A duplicate means the writer ran twice against a view that had moved.
  bool_and(picks = distinct_ranks)                                as ranks_unique,
  bool_and(first_rank = 1 and top_rank = picks)                   as ranks_contiguous,
  bool_and(stamped_in_time)                                       as stamped_in_time,
  bool_and(unnamed = 0)                                           as players_named
from per_group;
