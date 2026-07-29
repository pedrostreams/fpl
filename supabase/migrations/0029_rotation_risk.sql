-- ---------------------------------------------------------------------------
-- 0029 — rotation risk, from what is derivable rather than from a press conference
--
-- allaboutfpl's predicted-XI article is press-conference transcription, hand-updated on Friday.
-- `docs/feat/allaboutfpl-learnings.md` §7 declines to scrape a predicted-XI site for a good
-- reason: the failure mode is a **confidently wrong starting eleven**, which is worse than no
-- starting eleven at all. This builds the derivable part instead and says plainly what it cannot
-- know.
--
-- FOUR INPUTS, AND THE THIRD IS NEW
--   1. **European and cup load, per match.** `core_insights_player_match.tournament` distinguishes
--      prem / champions-league / europa-league / conference-league / efl-cup — 2 251 of 12 242 rows
--      are non-league. The research doc treats this as a season-level column
--      (`pct_minutes_outside_league`); it is available per match, so a player's *recent* midweek
--      load is measurable, which is the version that predicts a Saturday rest.
--   2. **Minutes, recently.** From 0027's window, where minutes turned out to be the second most
--      reliable six-match signal measured (`rel(6)` 0.63-0.79). This is what
--      `minutes_security` should have been: `cume_dist` over starts-per-appearance pins every
--      full-time starter at 1.000 and discriminates almost nothing.
--   3. **Squad competition** — how many other available players at the same club and position have
--      a comparable minutes share. New, cheap, and it is what "competition for the left-back spot"
--      actually means in allaboutfpl's £4.0m article. A player with two rivals on 60% of the
--      minutes is a different proposition from one with none, at identical personal stats.
--   4. **FPL's own line** — `status`, `news`, `chance_of_playing`. Late, but authoritative.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- It does not predict a lineup. It answers "how exposed is this player to being rotated", which is
-- a different and answerable question. `risk_word` is the sentence; there is no probability,
-- because a probability here would be exactly the false authority `trend-claims.md` §1 warns about.
-- ---------------------------------------------------------------------------

drop view if exists player_midweek_load cascade;
create view player_midweek_load as
-- Per-match competition load. `tournament` is on every row, so this needs no new source.
with per_player as (
  select
    m.player_code,
    count(*)                                                          as all_matches,
    count(*) filter (where m.tournament = 'prem')                     as league_matches,
    count(*) filter (where m.tournament <> 'prem')                    as other_matches,
    sum(m.minutes_played)                                             as all_minutes,
    sum(m.minutes_played) filter (where m.tournament <> 'prem')       as other_minutes,
    -- The last six *weeks* of non-league football, by gameweek rather than by appearance: what
    -- matters for a rest is whether he played midweek, not how many league games ago that was.
    count(*) filter (
      where m.tournament <> 'prem'
        and m.event > (select max(event) - 6 from core_insights_player_match)
    )                                                                 as recent_other_matches
  from core_insights_player_match m
  where m.season = (select stats_season from season_context)
    and m.minutes_played > 0
  group by m.player_code
)
select
  player_code, all_matches, league_matches, other_matches,
  all_minutes, coalesce(other_minutes, 0)                              as other_minutes,
  recent_other_matches,
  round(100.0 * coalesce(other_minutes, 0) / nullif(all_minutes, 0), 1) as pct_minutes_outside_league,
  -- A player with a European midweek every other week is exposed to a Saturday rest in a way one
  -- with none is not. Three tiers rather than a continuum, because the input is a count of matches.
  case
    when other_matches = 0 then 'domestic only'
    when other_matches >= 8 then 'heavy European load'
    else 'some midweek football'
  end                                                                  as load_word
from per_player;

-- ---------------------------------------------------------------------------
-- squad_competition — who else can take the slot
-- ---------------------------------------------------------------------------
-- The genuinely new input. Counted over *available* players only, because an injured rival is not
-- competition this week, and over the same club and position, because that is the slot.
drop view if exists squad_competition cascade;
create view squad_competition as
with pool as (
  select
    s.player_code, s.team_code, s.element_type, s.web_name,
    a.minutes_share, s.is_available, s.price
  from player_scout s
  join player_availability a on a.player_code = s.player_code
)
select
  p.player_code,
  p.team_code,
  p.element_type,
  count(*) filter (where r.player_code <> p.player_code)                as squad_mates,
  -- "Comparable" is within 20 percentage points of his own minutes share, or above it. Someone on
  -- 15% of the minutes is not competition for a 90% starter; someone on 75% is.
  count(*) filter (
    where r.player_code <> p.player_code
      and r.is_available
      and r.minutes_share >= p.minutes_share - 0.20
  )                                                                     as rivals,
  count(*) filter (
    where r.player_code <> p.player_code
      and r.is_available
      and r.minutes_share > p.minutes_share
  )                                                                     as rivals_ahead,
  round(max(r.minutes_share) filter (where r.player_code <> p.player_code
                                       and r.is_available)::numeric, 3) as best_rival_share
from pool p
join pool r on r.team_code = p.team_code and r.element_type = p.element_type
group by p.player_code, p.team_code, p.element_type;

-- ---------------------------------------------------------------------------
-- rotation_risk — the four inputs composed into one flag
-- ---------------------------------------------------------------------------
drop view if exists rotation_risk cascade;
create view rotation_risk as
with base as (
  select
    s.player_code, s.web_name, s.position, s.element_type, s.team_code, s.team_short,
    s.price, s.status, s.news, a.chance_of_playing, s.is_available,
    a.minutes_share, a.start_rate,
    l.pct_minutes_outside_league, l.other_matches, l.recent_other_matches, l.load_word,
    c.rivals, c.rivals_ahead, c.best_rival_share, c.squad_mates,
    -- Recent minutes from 0027's window. Null for the 263 players without one, and that null must
    -- survive: "we do not know his recent minutes" is not "his recent minutes are low".
    f.window_mean                                                        as recent_minutes,
    f.season_mean                                                        as season_minutes,
    f.separated                                                          as minutes_moved
  from player_scout s
  join player_availability a on a.player_code = s.player_code
  left join player_midweek_load l on l.player_code = s.player_code
  left join squad_competition c on c.player_code = s.player_code
  left join player_form_metric f
         on f.player_code = s.player_code and f.metric = 'minutes'
)
select
  b.*,
  -- The reasons, as an array rather than a score. Same principle as `sell_candidates`: the reason
  -- is the product, and a blended number cannot be argued with.
  array_remove(array[
    case when not b.is_available then 'unavailable' end,
    case when b.chance_of_playing is not null and b.chance_of_playing < 100
         then 'flagged fitness' end,
    -- `rivals_ahead >= 1` alone is nearly vacuous: at any club, in any position, somebody has
    -- played more than you unless you are the single most-used. The first draft handed that reason
    -- to **200 of 563** players, including Endo with eight Liverpool midfielders ahead of him —
    -- true, and not rotation risk. He is not a starter, which is a different fact that
    -- `minutes_share` already states. So competition only counts as a reason for someone who is
    -- otherwise playing.
    case when b.rivals_ahead >= 1 and b.minutes_share >= 0.60
         then 'someone ahead of him' end,
    case when b.rivals >= 2 and b.minutes_share >= 0.60
         then 'two or more rivals for the slot' end,
    case when b.recent_other_matches >= 3 then 'midweek football recently' end,
    case when b.minutes_moved and b.recent_minutes < b.season_minutes
         then 'minutes falling' end,
    case when b.start_rate is not null and b.start_rate < 0.70
         then 'not a guaranteed starter' end
  ], null)                                                              as risk_reasons,
  -- Ordered so that minutes come before competition. Rotation risk is a property of a player who
  -- plays; a player who does not play is not "at risk of rotation", he is simply not picked, and
  -- conflating the two made "behind someone in the pecking order" the answer for 200 players.
  case
    when not b.is_available then 'not available'
    when b.recent_minutes is null then 'unknown — no recent record'
    when b.minutes_share < 0.40 then 'not a starter'
    when b.minutes_moved and b.recent_minutes < b.season_minutes then 'minutes falling'
    when b.minutes_share >= 0.85 and coalesce(b.rivals, 0) = 0 then 'nailed on'
    when coalesce(b.rivals, 0) >= 1 and b.minutes_share >= 0.60
      then 'a real contest for the slot'
    when b.minutes_share >= 0.75 then 'a regular'
    else 'rotated'
  end                                                                   as risk_word
from base b;

-- ---------------------------------------------------------------------------
-- rotation_risk_check
-- ---------------------------------------------------------------------------
drop view if exists rotation_risk_check cascade;
create view rotation_risk_check as
select
  (select count(*) from rotation_risk)                                  as players,
  (select count(*) from squad_competition)                              as competition_rows,
  (select count(*) from player_midweek_load)                            as load_rows,

  -- Every registered player must appear. A rotation-risk view that silently drops the players it
  -- has least data on is worse than none, because absence would read as safety.
  (select count(*) = (select count(*) from player_scout) from rotation_risk)
                                                                        as covers_every_player,
  (select coalesce(bool_and(risk_word is not null), true) from rotation_risk)
                                                                        as every_player_has_a_word,
  (select coalesce(bool_and(risk_word in (
            'not available', 'unknown — no recent record', 'not a starter',
            'minutes falling', 'a real contest for the slot',
            'nailed on', 'a regular', 'rotated')), true) from rotation_risk)
                                                                        as words_are_known,

  -- The null that must survive. 263 players have no six-match window, and "unknown" is the only
  -- honest reading — not "low minutes".
  (select count(*) from rotation_risk where recent_minutes is null)      as unknown_recent_minutes,
  (select coalesce(bool_and(risk_word = 'unknown — no recent record'), true)
     from rotation_risk where recent_minutes is null and is_available)   as unknown_reads_unknown,

  -- Squad competition arithmetic.
  (select coalesce(bool_and(rivals <= squad_mates), true) from rotation_risk
    where rivals is not null)                                           as rivals_within_squad,
  (select coalesce(bool_and(rivals_ahead <= rivals), true) from rotation_risk
    where rivals is not null)                                           as ahead_is_subset_of_rivals,
  -- A player on the highest minutes share at his club and position can have nobody ahead of him.
  (select coalesce(bool_and(rivals_ahead = 0), true) from rotation_risk r
    where r.minutes_share is not null
      and r.minutes_share >= coalesce(r.best_rival_share, 0))            as top_of_pool_has_nobody_ahead,

  -- Midweek load. The per-match `tournament` split is the point of the view, so assert it is real.
  (select count(*) from player_midweek_load where other_matches > 0)     as players_with_midweek,
  (select coalesce(bool_and(league_matches + other_matches = all_matches), true)
     from player_midweek_load)                                          as match_counts_reconcile,
  (select coalesce(bool_and(pct_minutes_outside_league between 0 and 100), true)
     from player_midweek_load where pct_minutes_outside_league is not null)
                                                                        as load_pct_in_range,
  -- A domestic-only player must not be described as carrying midweek football.
  (select coalesce(bool_and(load_word = 'domestic only'), true)
     from player_midweek_load where other_matches = 0)                  as no_matches_reads_domestic,

  -- Reasons. An empty array is a legitimate answer — it means no risk found — but a player who is
  -- unavailable must always carry at least the one reason.
  (select coalesce(bool_and(cardinality(risk_reasons) >= 1), true)
     from rotation_risk where not is_available)                          as unavailable_has_a_reason,
  (select coalesce(bool_and('nailed on' <> risk_word), true)
     from rotation_risk where cardinality(risk_reasons) > 0)             as nailed_on_has_no_reasons,

  -- Competition may only be a reason for a player who actually plays; see the note above the
  -- reason array. Without this the signal reverts to "somebody is ahead of nearly everybody".
  (select coalesce(bool_and(minutes_share >= 0.60), true)
     from rotation_risk
    where 'someone ahead of him' = any(risk_reasons))                    as competition_needs_minutes,
  -- And a non-starter must be described as one rather than as a rotation risk.
  (select coalesce(bool_and(risk_word = 'not a starter'), true)
     from rotation_risk
    where is_available and recent_minutes is not null
      and minutes_share < 0.40)                                          as non_starters_say_so;
