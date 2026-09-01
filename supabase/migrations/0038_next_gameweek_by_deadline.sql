-- ---------------------------------------------------------------------------
-- 0038 — the next gameweek is the next DEADLINE, not the next unfinished fixture
-- ---------------------------------------------------------------------------
-- `next_gameweek` fed ten migrations — captain_picks, target_players, sell_candidates,
-- rotation_pairs, gameweek_shape, fixture percentages, watchlist_detail — and defined itself as
-- `min(event) where not finished`. In preseason that is indistinguishable from the right answer:
-- nothing was finished, so the minimum was GW1, which was also the next deadline. In-season the
-- two come apart, and they came apart on 2026-09-01.
--
-- MEASURED that morning: all ten GW2 fixtures had kicked off between 28 and 31 August and the
-- live API reported every one `finished: true`, while `fixtures.finished` in this database still
-- read false. `next_gameweek` therefore answered **GW2** — a gameweek whose deadline had passed
-- four days earlier — and `/gw`, the page whose entire job is "what do I do before the next
-- deadline", was briefing a locked week. Running `dimensions` corrected the flags and the view
-- immediately returned GW3, so nothing was broken about the write path.
--
-- THAT IS THE POINT: the flag was merely late, and the view has no defence against late. FPL
-- owns `finished`, flips it per fixture after bonus is applied, and takes longer still over
-- `events.data_checked` — GW2 was `is_current` with `data_checked = false` a full day after its
-- last whistle. Any view keyed on `finished` is wrong for that whole window, and the window sits
-- exactly where a manager is deciding: after the results, before the next deadline.
--
-- `deadline_time` has neither problem. It is published weeks ahead, never moves retroactively,
-- and needs no sync to become true — the clock does that. So the gameweek you can still act on is
-- the first whose deadline is in the future, and no ingest lag can change the answer.
--
-- `create or replace`, not drop + create, deliberately against the convention in CLAUDE.md: a
-- `drop` here cascades into all ten dependents. The column list and types are unchanged, which is
-- what makes replace legal.
--
-- The aggregate form keeps the old contract of **exactly one row, possibly NULL**. After GW38's
-- deadline `min()` returns NULL rather than no row, so every `= (select gameweek from
-- next_gameweek)` consumer keeps comparing against NULL and matching nothing, which is what they
-- did before. A bare `limit 1` would have returned zero rows and read the same in a scalar
-- subquery, but not in a join.
--
-- `first_kickoff` keeps its meaning — the earliest kickoff in that gameweek — but is no longer
-- filtered on `finished`. It never should have been: the first kickoff of a week is a property of
-- the schedule, and once matches start the old version began reporting the first *remaining*
-- kickoff, so a Saturday-evening reader was told the week began at 17:30.
-- ---------------------------------------------------------------------------

create or replace view next_gameweek as
with actionable as (
  -- Name the column explicitly. `(select season from season_context)` would resolve as an outer
  -- reference here and silently become a tautology — see CLAUDE.md.
  select min(e.id) as gameweek
  from events e
  where e.season = (select current_season from season_context)
    and e.deadline_time > now()
)
select
  a.gameweek,
  (select min(f.kickoff_time)
     from fixtures f
    where f.event = a.gameweek
      and f.season = (select current_season from season_context)) as first_kickoff
from actionable a;
