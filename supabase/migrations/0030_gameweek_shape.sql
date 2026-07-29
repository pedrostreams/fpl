-- ---------------------------------------------------------------------------
-- 0030 — blanks and doubles: a detector that currently detects nothing, on purpose
--
-- allaboutfpl's whole second half runs on season shape — blank gameweeks, doubles, and a chip
-- guide keyed on which is coming. It moves more points than any transfer.
--
-- **This ships with no findings, and that is the honest state rather than a failure.** Measured
-- 2026-07-29: 2026/27 holds **760 club-gameweeks, every single one with exactly one fixture**.
-- Zero blanks, zero doubles. So the view answers "the season is flat" today, and its entire value
-- is being ready — and already verified — when the first FA Cup round is drawn and FPL removes a
-- league fixture.
--
-- BE STRICT ABOUT WHAT THIS CAN KNOW
-- FPL's fixture list shows what is **scheduled**. A blank caused by an FA Cup semi-final does not
-- exist until the round is drawn and the league fixture is pulled. allaboutfpl's own maintained
-- page is explicitly provisional — "the exact number of teams blanking will depend on the FA Cup
-- results" — and they hand-update it for months.
--
-- So there are three states here, not two, which is DESIGN.md's three-kinds-of-absent in a new
-- place:
--   - **confirmed shape** — the fixture list says a club has 0 or 2 fixtures in a gameweek
--   - **flat** — one fixture, nothing to report
--   - **provisional** — a gameweek far enough out that cup rounds are undrawn, so today's flat
--     reading is not yet a promise. `is_provisional` marks it, and a consumer must render that as
--     **unknown rather than as normal**. Cup-draw contingency is out of scope and the page says so.
--
-- WHY `fixture_count = 0` IS NOT THE SAME AS A BLANK
-- `team_fixture_context` simply has no row for a club with no fixture, and `player_wide` coalesces
-- that to 0. That is right for "this club plays nobody next week" and wrong as a blank *detector*,
-- because a missing row cannot be distinguished from a club that does not exist. The grid below is
-- built from `teams × generate_series`, so every club-gameweek is a row and a blank is a counted
-- zero.
-- ---------------------------------------------------------------------------

drop view if exists gameweek_shape cascade;
create view gameweek_shape as
with bounds as (
  select
    coalesce(min(event), 1)  as first_event,
    coalesce(max(event), 38) as last_event
  from fixtures
  where season = (select current_season from season_context)
),
grid as (
  select t.code as team_code, t.short_name, g.event
  from teams t
  cross join lateral (
    select generate_series((select first_event from bounds),
                           (select last_event from bounds)) as event
  ) g
),
counted as (
  select
    g.team_code, g.short_name, g.event,
    count(f.fpl_id)                                   as fixtures,
    min(f.kickoff_time)                               as first_kickoff,
    string_agg(case when f.team_h_code = g.team_code
                    then upper(o.short_name) else lower(o.short_name) end,
               ', ' order by f.kickoff_time)          as opponents
  from grid g
  left join fixtures f
         on f.season = (select current_season from season_context)
        and f.event = g.event
        and (f.team_h_code = g.team_code or f.team_a_code = g.team_code)
  left join teams o
         on o.code = case when f.team_h_code = g.team_code then f.team_a_code
                          else f.team_h_code end
  group by g.team_code, g.short_name, g.event
)
select
  c.team_code,
  c.short_name,
  c.event,
  c.fixtures,
  c.first_kickoff,
  c.opponents,
  case when c.fixtures = 0 then 'blank'
       when c.fixtures > 1 then 'double'
       else 'single' end                              as shape,
  -- **Provisional, not normal.** A gameweek more than roughly eight weeks out can still lose a
  -- fixture to a cup round that has not been drawn, so a flat reading there is not yet a promise.
  -- Eight weeks is a judgement, not a measurement, and it is labelled as one: FA Cup third-round
  -- ties are drawn around six weeks ahead and the later rounds later still.
  (c.first_kickoff is null or c.first_kickoff > now() + interval '56 days')
    and c.fixtures = 1                                as is_provisional
from counted c;

-- ---------------------------------------------------------------------------
-- gameweek_shape_summary — the league-wide picture, one row per gameweek
-- ---------------------------------------------------------------------------
drop view if exists gameweek_shape_summary cascade;
create view gameweek_shape_summary as
select
  event,
  count(*)                                            as clubs,
  count(*) filter (where shape = 'blank')              as blanking,
  count(*) filter (where shape = 'double')             as doubling,
  count(*) filter (where shape = 'single')             as single,
  count(*) filter (where is_provisional)               as provisional,
  sum(fixtures)                                        as club_fixtures,
  min(first_kickoff)                                   as first_kickoff,
  string_agg(short_name, ', ' order by short_name)
    filter (where shape = 'blank')                     as blanking_clubs,
  string_agg(short_name, ', ' order by short_name)
    filter (where shape = 'double')                    as doubling_clubs,
  -- The sentence, so a consumer does not have to invent one — and so "nothing to report" is an
  -- explicit answer rather than an empty row.
  case
    when count(*) filter (where shape = 'blank') > 0
     and count(*) filter (where shape = 'double') > 0
      then count(*) filter (where shape = 'blank') || ' blank, '
        || count(*) filter (where shape = 'double') || ' double'
    when count(*) filter (where shape = 'blank') > 0
      then count(*) filter (where shape = 'blank') || ' clubs blank'
    when count(*) filter (where shape = 'double') > 0
      then count(*) filter (where shape = 'double') || ' clubs double'
    when count(*) filter (where is_provisional) = count(*)
      then 'flat as scheduled — cup rounds undrawn'
    else 'every club plays once'
  end                                                  as shape_word
from gameweek_shape
group by event;

-- ---------------------------------------------------------------------------
-- gameweek_shape_check
--
-- The doc's §10 asks that blanks and doubles reconcile against `fixture_count` in `player_wide`
-- and that a club with no scheduled fixture never renders as an easy fixture. Both are below.
-- The blank and double branches are **unexercised by the data** — see the header — so
-- `scripts/probe/prove_gameweek_shape.py` simulates them without a database.
-- ---------------------------------------------------------------------------
drop view if exists gameweek_shape_check cascade;
create view gameweek_shape_check as
select
  (select count(*) from gameweek_shape)                                 as club_gameweeks,
  (select count(*) from gameweek_shape_summary)                         as gameweeks,
  (select count(*) from gameweek_shape where shape = 'blank')            as blank_rows,
  (select count(*) from gameweek_shape where shape = 'double')           as double_rows,
  (select count(*) from gameweek_shape where is_provisional)             as provisional_rows,

  -- The grid must be complete, because a blank is a counted zero and a missing row is invisible.
  (select count(*) = 20 * (select count(*) from gameweek_shape_summary)
     from gameweek_shape)                                               as grid_is_complete,
  (select coalesce(bool_and(clubs = 20), true) from gameweek_shape_summary)
                                                                        as every_gameweek_has_20_clubs,
  (select coalesce(bool_and(blanking + doubling + single = clubs), true)
     from gameweek_shape_summary)                                       as shapes_partition_the_league,

  -- Total fixtures must reconcile against the fixture table itself, counted independently.
  (select sum(club_fixtures) from gameweek_shape_summary)                as club_fixture_total,
  (select (select sum(club_fixtures) from gameweek_shape_summary)
        = 2 * (select count(*) from fixtures
                where season = (select current_season from season_context)
                  and event is not null))                               as reconciles_with_fixtures,

  -- A blank must carry no opponent and no kickoff. If either were present the row would render as
  -- a fixture that is not happening.
  (select coalesce(bool_and(opponents is null and first_kickoff is null), true)
     from gameweek_shape where shape = 'blank')                         as blank_has_no_fixture,
  (select coalesce(bool_and(opponents is not null), true)
     from gameweek_shape where shape <> 'blank')                        as played_rows_have_opponents,
  -- A double must name two opponents, or the string aggregation lost one.
  (select coalesce(bool_and(opponents like '%, %'), true)
     from gameweek_shape where shape = 'double')                        as double_names_both,

  -- Provisional and confirmed are different states, and provisional only applies to a flat reading:
  -- a gameweek already showing a blank or a double has had its shape decided.
  (select coalesce(bool_and(shape = 'single'), true)
     from gameweek_shape where is_provisional)                          as provisional_only_when_flat,

  -- Against `player_wide`, which is where a consumer meets the same fact. Next gameweek only,
  -- because that is the one `team_fixture_context` covers.
  (select count(*) from player_wide where fixture_count = 0)             as player_wide_blanking,
  (select (select count(distinct team_code) from gameweek_shape
            where shape = 'blank' and event = (select gameweek from next_gameweek))
        = (select count(distinct team_code) from player_wide
            where fixture_count = 0))                                   as agrees_with_player_wide,

  (select coalesce(bool_and(shape_word is not null), true) from gameweek_shape_summary)
                                                                        as every_gameweek_has_a_word;
