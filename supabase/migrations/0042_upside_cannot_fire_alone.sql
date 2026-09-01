-- ---------------------------------------------------------------------------
-- 0042 — make `no_attacking_upside` structurally unable to fire alone
-- ---------------------------------------------------------------------------
-- `sell_check.upside_never_fires_alone` went false the moment 0040 lowered the reliability
-- floor to 120 minutes. The check was right, the reason logic was wrong, and it had been wrong
-- since 0032 — it simply could not fire.
--
-- 0032's comment states the rule plainly: "Never on its own — a low xGI is normal for a
-- defender. It only counts alongside the defensive reason." The code did not implement it. The
-- two branches shared only `team_clean_sheet_pct < 0.25`:
--
--   defence_declining     element_type in (1,2), clean_sheet_pct < 0.25, xgc_per_90 > 1.5
--   no_attacking_upside   element_type in (1,2), clean_sheet_pct < 0.25, xgi_per_90 < 0.15
--
-- so a defender at a leaky club whose xGC happened to sit at or below 1.5 got
-- `no_attacking_upside` without `defence_declining`. Before 0040 that was unreachable: the
-- branch guards on `xgi_per_90 is not null` and every per-90 was NULL under 450 minutes, which
-- no player reaches in September. Lowering the floor did not break this; it made it reachable.
--
-- MEASURED 2026-09-01 at the 120-minute floor: 36 rows carried `no_attacking_upside` and **8 of
-- them lacked `defence_declining`** — van Ewijk, Rushworth, Thomas, Amenda, Dasilva, Donnarumma,
-- Lacroix, and N.Williams, who had it as his *only* reason and so appeared on the sell list on
-- the strength of a defender having a low xGI. That is exactly the "flag most of the league's
-- back fours" failure 0032 wrote the rule to prevent.
--
-- THE FIX IS ONE BOOLEAN, NOT A DUPLICATED PREDICATE. Copying `xgc_per_90 > 1.5` into the second
-- branch would work today and drift the first time either threshold is tuned. This repo already
-- has that scar: `form_word` reads `separated` rather than recomputing the comparison, because
-- "two copies of it is how the badge and the sentence came to disagree". So `defence_is_declining`
-- is computed once in `base` and both branches read it. `no_attacking_upside` now cannot appear
-- without `defence_declining` by construction, which turns `upside_never_fires_alone` from an
-- assertion that catches a slip into one that proves the construction.
--
-- `create or replace`, columns unchanged — `sell_check` and `change_feed_detail` depend on this
-- view and a cascade would drop them. Everything below is 0032 verbatim apart from the new
-- boolean in `base` and the two branches that now read it.
-- ---------------------------------------------------------------------------

create or replace view sell_candidates as
with runs as (
  -- Next six against the last six, per club. `fixture_run` is per club per direction on /teams;
  -- here only the comparison matters, so it is computed directly to avoid depending on its window.
  select
    fd.team_code,
    avg(fd.difficulty) filter (
      where fd.gameweek between (select gameweek from next_gameweek)
                            and (select gameweek from next_gameweek) + 5
    )                                                        as next_six_difficulty,
    avg(fd.difficulty) filter (
      where fd.gameweek between (select gameweek from next_gameweek) - 6
                            and (select gameweek from next_gameweek) - 1
    )                                                        as last_six_difficulty
  from fixture_difficulty fd
  group by fd.team_code
),
-- Materialised, and not a correlated `exists`. The first draft wrote
-- `exists (select 1 from target_players where player_code = s.player_code)`, which evaluates a
-- scoring view **once per player** — 563 times — and took `sell_check` past a two-minute statement
-- timeout. Same lesson as 0031 one level down: pin the single evaluation.
targets as materialized (
  select distinct player_code from target_players
),
base as (
  select
    s.player_code, s.web_name, s.position, s.element_type, s.team_code, s.team_short,
    s.price, s.selected_by_percent, s.total_points, s.status, s.news, s.is_available,
    s.xgi_per_90, s.xgc_per_90, s.points_per_90, s.net_transfers_event, s.price_change_percent,
    a.minutes_share, a.chance_of_playing,
    ts.clean_sheet_pct                                       as team_clean_sheet_pct,
    r.next_six_difficulty, r.last_six_difficulty,
    -- Null where the club has no previous run to compare against, which is every club before GW7.
    -- Null must not become "fixtures are fine"; the reason simply cannot fire.
    r.next_six_difficulty - r.last_six_difficulty            as difficulty_swing,
    rr.risk_word, rr.risk_reasons                            as rotation_reasons,
    f.window_mean                                            as recent_minutes,
    f.season_mean                                            as season_minutes,
    f.separated                                              as minutes_moved,
    tg.player_code is not null                               as also_a_target,
    -- The single definition of "his defence is leaking", read by two reasons below. Only the
    -- positions paid for clean sheets, and a measured concession rate rather than a bad club.
    (s.element_type in (1, 2)
      and ts.clean_sheet_pct is not null and ts.clean_sheet_pct < 0.25
      and s.xgc_per_90 is not null and s.xgc_per_90 > 1.5)   as defence_is_declining
  from player_scout s
  join player_availability a on a.player_code = s.player_code
  left join runs r on r.team_code = s.team_code
  left join team_style ts on ts.team_code = s.team_code
                         and ts.season = (select stats_season from season_context)
  left join rotation_risk rr on rr.player_code = s.player_code
  left join player_form_metric f
         on f.player_code = s.player_code and f.metric = 'minutes'
  left join targets tg on tg.player_code = s.player_code
),
flagged as (
  select
    b.*,
    array_remove(array[
      -- Their "fixtures turning brutal". 0.08 on the difficulty scale is roughly one rank of
      -- opponent quality; below that the swing is inside the model's own resolution.
      case when b.difficulty_swing >= 0.08 then 'fixtures_turning' end,
      case when not b.is_available
             or (b.chance_of_playing is not null and b.chance_of_playing < 75)
           then 'injured' end,
      -- Defensive decline, and only for the positions paid for clean sheets.
      case when b.defence_is_declining then 'defence_declining' end,
      -- Never on its own — a low xGI is normal for a defender, and alone it would flag most of
      -- the league's back fours. Reading the same boolean is what makes that structural: this
      -- branch is a strict subset of the one above, so the pair cannot come apart if either
      -- threshold is tuned.
      case when b.defence_is_declining
            and b.xgi_per_90 is not null and b.xgi_per_90 < 0.15
           then 'no_attacking_upside' end,
      case when b.net_transfers_event < -20000
             or (b.price_change_percent is not null and b.price_change_percent < -50)
           then 'price_falling' end,
      -- **Only a measured decline, not the existence of competition.** The first draft accepted
      -- 'a real contest for the slot' too, and that flagged 38 players including Bruno Fernandes at
      -- 48.7% ownership — nearly every midfielder at a big club has a rival within 20 points of his
      -- minutes share. That is the same error 0029 had to fix one level down: competition existing
      -- is not risk materialising. `minutes falling` is a two-error-bar move in his own six-match
      -- window, which is a fact about him rather than about his squad.
      case when b.risk_word = 'minutes falling' then 'rotation_risk' end
    ], null)                                                  as sell_reasons
  from base b
)
select
  f.player_code, f.web_name, f.position, f.element_type, f.team_code, f.team_short,
  f.price, f.selected_by_percent, f.total_points, f.minutes_share,
  f.status, f.news, f.chance_of_playing, f.is_available,
  f.xgi_per_90, f.xgc_per_90, f.team_clean_sheet_pct,
  f.net_transfers_event, f.price_change_percent,
  round(f.next_six_difficulty, 3)                            as next_six_difficulty,
  round(f.last_six_difficulty, 3)                            as last_six_difficulty,
  round(f.difficulty_swing, 3)                               as difficulty_swing,
  f.risk_word, f.recent_minutes, f.season_minutes, f.minutes_moved,
  f.sell_reasons,
  cardinality(f.sell_reasons)                                as reason_count,
  f.also_a_target,
  -- The sentence, built from the reasons rather than beside them, so the two cannot drift.
  array_to_string(array(
    select case r
      when 'fixtures_turning'   then 'fixtures turning'
      when 'injured'            then 'a fitness flag'
      when 'defence_declining'  then 'his defence leaking'
      when 'no_attacking_upside' then 'nothing at the other end to compensate'
      when 'price_falling'      then 'money leaving him'
      when 'rotation_risk'      then 'his place under threat'
    end from unnest(f.sell_reasons) as r
  ), ' · ')                                                   as sell_word
from flagged f
-- One reason is a note; the view exists for the players carrying more than one. Ownership is the
-- other half of relevance — a 0.2%-owned player is not a sell decision anybody has to make.
where cardinality(f.sell_reasons) >= 2
   or (cardinality(f.sell_reasons) = 1 and f.selected_by_percent >= 5.0);
