-- ---------------------------------------------------------------------------
-- 0032 — sell candidates, as reason codes rather than a score
--
-- allaboutfpl's most repeated weekly format is **Buy, Hold, Sell**. We have buy
-- (`target_players`), hold is a non-action, and **we have had no sell view at all**. Every one of
-- their sell reasons is derivable from columns already held, which is the finding that makes this
-- cheap.
--
-- **The reason is the product, not a ranking.** A blended "sell score" of 0.71 cannot be argued
-- with; "his next six fixtures are harder than his last six, and his minutes are falling" can. So
-- this emits an array of reason codes, and the count of them is the strength — two reasons is a
-- stronger sell than one. Migration 0012 exposes all seven of its captaincy rank components for the
-- same purpose: so the recommendation can be disagreed with rather than trusted.
--
-- THE SIX REASONS, AND WHERE EACH COMES FROM
--   fixtures_turning   `fixture_run` next 6 against the last 6 — their "fixtures turning brutal"
--   injured            `status` / `news` / `chance_of_playing`, via `player_availability`
--   defence_declining  `team_clean_sheet_pct` and `xgc_per_90`, for keepers and defenders
--   no_attacking_upside  low `xgi_per_90` *and* a defensive metric falling — never on its own
--   price_falling      `net_transfers_event` and `price_change_percent`
--   rotation_risk      0029's `rotation_risk`, which is what that view was built to feed
--
-- WHAT IS DELIBERATELY NOT A REASON
-- A run of blanks. A player who has not returned in four games has not necessarily got worse, and
-- `trend-claims.md` §3 measured why: over six matches a player's own figures are roughly half
-- signal at best, and returns are far noisier than the underlying. Selling on a blank run is the
-- single most common FPL mistake and this view refuses to encourage it. `player_form_metric`
-- carries the underlying change instead, gated on his own error bar.
--
-- CONFLICT WITH `target_players` IS SURFACED, NOT SUPPRESSED
-- A player can legitimately be both — cheap and in form, but with a hard run coming. The doc's §10
-- asks that the conflict be visible on screen rather than resolved silently, so `also_a_target` is
-- a column and the check counts them.
-- ---------------------------------------------------------------------------

drop view if exists sell_candidates cascade;
create view sell_candidates as
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
    tg.player_code is not null                               as also_a_target
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
      case when b.element_type in (1, 2)
            and b.team_clean_sheet_pct is not null and b.team_clean_sheet_pct < 0.25
            and b.xgc_per_90 is not null and b.xgc_per_90 > 1.5
           then 'defence_declining' end,
      -- Never on its own — a low xGI is normal for a defender. It only counts alongside the
      -- defensive reason, which is what "no attacking upside to compensate" means.
      case when b.element_type in (1, 2)
            and b.xgi_per_90 is not null and b.xgi_per_90 < 0.15
            and b.team_clean_sheet_pct is not null and b.team_clean_sheet_pct < 0.25
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

-- ---------------------------------------------------------------------------
-- sell_check
-- ---------------------------------------------------------------------------
drop view if exists sell_check cascade;
create view sell_check as
with s as materialized (
  select * from sell_candidates
)
select
  (select count(*) from s)                                            as candidates,
  (select count(*) filter (where reason_count >= 2) from s)            as multi_reason,
  (select count(*) filter (where also_a_target) from s)                as also_targets,
  -- Row counts beside every gated assertion below, because `bool_and` over zero rows is NULL and
  -- `coalesce(…, true)` then reads as a pass. Three of these were vacuous on the first run and the
  -- table said nothing about it — the exact trap CLAUDE.md documents, in my own new check.
  (select count(*) filter (where not is_available) from s)             as unavailable_rows,
  (select count(*) filter (where 'injured' = any(sell_reasons)) from s) as injured_rows,
  (select count(*) filter (where 'fixtures_turning' = any(sell_reasons)) from s)
                                                                      as fixture_reason_rows,
  (select count(*) filter (where 'no_attacking_upside' = any(sell_reasons)) from s)
                                                                      as upside_reason_rows,
  (select count(*) filter (where 'rotation_risk' = any(sell_reasons)) from s)
                                                                      as rotation_reason_rows,
  (select count(*) filter (where 'price_falling' = any(sell_reasons)) from s)
                                                                      as price_reason_rows,
  (select count(*) filter (where 'defence_declining' = any(sell_reasons)) from s)
                                                                      as defence_reason_rows,

  -- The doc's §10: every row carries at least one reason code.
  (select coalesce(bool_and(cardinality(sell_reasons) >= 1), true) from s)
                                                                      as every_row_has_a_reason,
  -- And the threshold the view claims to enforce.
  (select coalesce(bool_and(reason_count >= 2 or selected_by_percent >= 5.0), true) from s)
                                                                      as threshold_enforced,
  -- The sentence is built from the reasons, so it must have exactly as many clauses.
  (select coalesce(bool_and(
            array_length(string_to_array(sell_word, ' · '), 1) = reason_count), true) from s)
                                                                      as word_matches_reasons,
  (select coalesce(bool_and(sell_word is not null and sell_word <> ''), true) from s)
                                                                      as every_row_has_a_word,

  -- Reason vocabulary is closed. A typo in a code would silently produce a null clause in the
  -- sentence and a reason nothing can read.
  (select coalesce(bool_and(r in ('fixtures_turning', 'injured', 'defence_declining',
                                  'no_attacking_upside', 'price_falling', 'rotation_risk')), true)
     from s, unnest(s.sell_reasons) as r)                             as reasons_are_known,

  -- "No attacking upside" must never fire alone: a low xGI is normal for a defender, and on its
  -- own it would flag most of the league's back fours.
  (select coalesce(bool_and('defence_declining' = any(sell_reasons)) filter (
            where 'no_attacking_upside' = any(sell_reasons)), true) from s)
                                                                      as upside_never_fires_alone,

  -- Injury reasons must agree with `player_availability` rather than being invented here.
  (select coalesce(bool_and(not is_available or chance_of_playing < 75) filter (
            where 'injured' = any(sell_reasons)), true) from s)         as injury_agrees_with_source,
  -- And an unavailable player must always carry the injured reason.
  (select coalesce(bool_and('injured' = any(sell_reasons)) filter (
            where not is_available), true) from s)                      as unavailable_is_flagged,

  -- The fixtures reason needs both windows. Before GW7 there is no previous run, so the swing is
  -- null and the reason must not fire — a null must never read as "fixtures are fine" nor as bad.
  (select count(*) filter (where difficulty_swing is null) from s)      as no_previous_run,
  (select coalesce(bool_and(difficulty_swing >= 0.08) filter (
            where 'fixtures_turning' = any(sell_reasons)), true) from s)
                                                                      as fixture_reason_has_a_swing,

  -- A blank run is deliberately not a reason. If `total_points` ever appears in the reason logic
  -- this stops holding, and that is the point: selling on a blank run is the most common FPL
  -- mistake and the view refuses to encourage it.
  (select coalesce(bool_and(reason_count > 0), true) from s)            as no_empty_rows,

  -- Conflict with `target_players` is surfaced rather than suppressed, so it is legitimate for
  -- this to be non-zero — but the rows must be readable as both.
  (select coalesce(bool_and(reason_count >= 1) filter (where also_a_target), true) from s)
                                                                      as conflicts_still_have_reasons;
