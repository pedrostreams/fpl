-- ---------------------------------------------------------------------------
-- 0014 — the fixture, and who "players to target" is actually for
-- ---------------------------------------------------------------------------
-- Prompted by reading allaboutfpl's GW37 scout picks against our own list. Their whole method
-- is "stats analysis AND matchups", and every single justification is a claim about the
-- opponent: Raya because Burnley are 2nd bottom for goals scored, Saka because Burnley have
-- the worst defensive record. Same fixture, two different numbers, chosen by position.
--
-- `hidden_gems` did not join `fixture_difficulty` at all. Measured on the GW1 pool:
--
--     Schär   DEF  NEW v LIV   difficulty 0.67   clean sheet 27%   ranked 4th
--     Wieffer DEF  BHA v AVL   difficulty 0.68   clean sheet 26%   ranked 6th
--     Danso   DEF  TOT @ BRE   difficulty 0.77   clean sheet 20%   ranked 9th
--
-- Three defenders recommended into a one-in-five clean sheet, with nothing on screen saying so.
--
-- Worth stating what the fault is NOT. The pool is not skewed toward bad fixtures — the mean
-- difficulty across all 20 GW1 sides is 0.614 and across the gem pool 0.589, marginally
-- easier. The fault is that the pool spans 0.107 to 0.968 and the ordering ignores every bit
-- of it. A discarded signal with a nine-fold spread, not a bias.
--
-- FAULT 2: one ownership filter was doing two different jobs.
--
-- The dashboard panel is titled "Players to target" and read from `hidden_gems`, so it
-- inherited the under-10%-owned gate. That gate excluded Raya, Haaland, B.Fernandes, Cherki,
-- Palmer, Saka and Mbeumo — the 46 fit-and-reliable players above the line average 0.820 on
-- output against 0.697 for the 238 below it. "Who should I buy" and "who should I buy that
-- nobody owns" are different questions; only the second one wants a hard gate.
--
-- So: `/gems` keeps the gate, because that is the page's entire premise. The dashboard moves
-- to `target_players`, which has no gate and marks differentials with a flag instead.
--
-- What we deliberately did not copy: the article states no minutes threshold, no rotation
-- screening and no injury filter. It is an eye test with statistics attached. We take the
-- framing, not the rigour — every view here still inherits `fully_fit` from 0013.
--
-- FAULT 3, found by rendering the page and reading it, having just written the paragraph
-- above about the article's missing minutes screening. The first draft of this migration had
-- the same hole. The top goalkeeper gem was Bayindir: 540 minutes, 15.8% of United's season,
-- Onana's backup, recommended at rank 01. Eleven of the top twenty were under 40% of a season:
--
--     Awoniyi   480 min  14.0%      Bayindir  540 min  15.8%      Hickey    679 min  19.9%
--     Savinho   817 min  23.9%      Heaven    920 min  26.9%      Mount   1 010 min  29.5%
--
-- This is the Havertz fault from 0013 on a different surface. `has_reliable_sample` clears a
-- 450-minute floor, which certifies that a per-90 rate is *measurable* — not that the player
-- is a regular. Two different claims, and the second one is the one a buy recommendation makes.
--
-- Treated differently from captaincy, though, and deliberately. For an armband "will he play"
-- is a precondition, so 0013 gates at half the team's minutes. For a transfer target it is not:
-- a squad player at 30% last season may be this season's starter, and Martinelli, Savinho and
-- a new signing like Cuenca are exactly the players a differential list should surface. So:
-- a low hard floor at 25% that removes the demonstrably-not-playing, plus minutes as a scored
-- component so that among the survivors a regular outranks a bit-part player on the same rate.
-- The figure is also printed on every card, because a percentile hid this once already.
--
-- FAULT 4, same reading pass: "TOT 6th of 20 for defence" is false precision twice over.
-- Ranks 4 to 17 span 1.41 to 1.70 xGA per match — a 0.29 spread dressed up as fourteen
-- distinct places, when only Arsenal (0.87) and City (1.22) are real outliers. And it is not
-- out of 20: only 17 clubs have a `team_style` row, because the three promoted sides have no
-- top-flight record. The number now leads, the direction is named, and the denominator is
-- counted rather than assumed.

-- ---------------------------------------------------------------------------
-- team_fixture_context — the next gameweek per club, blank- and double-safe
-- ---------------------------------------------------------------------------
-- Aggregated rather than joined row-per-fixture, because a double gameweek would otherwise
-- duplicate every player of that club in the output.
--
-- Summed, not averaged, for the two scoring quantities. This is the opposite of the choice
-- made for `fixture_run` on /teams, and for a reason: there the window sizes differed between
-- clubs, so a total rewarded merely having more games left. Here every row is the same single
-- gameweek, so two fixtures genuinely are two chances to return, and summing is what a
-- transfer decision actually wants.
--
-- `next_gameweek` is referenced as a scalar subquery, not joined. It costs 2.6s to evaluate,
-- and as a CROSS JOIN against a CTE Postgres inlined it and re-ran it per fixture row — the
-- view took over 60 seconds and hit the statement timeout. As a scalar subquery it becomes an
-- InitPlan and runs exactly once. `captain_picks` in 0013 already had it in this form.
drop view if exists team_fixture_context cascade;
create view team_fixture_context as
with agg as (
  select
    fd.team_code,
    count(*)                                            as fixture_count,
    min(fd.kickoff_time)                                as first_kickoff,
    sum(fd.expected_goals_for)                          as xg_for,
    -- Expected clean sheets, not P(clean sheet): over a double these add, and over a single
    -- gameweek the two are identical. `p_clean_sheet` is exp(-xGA), the opponent failing to
    -- score — the orientation that the Elo calibration in 0007 had to be fixed to get right.
    sum(fd.p_clean_sheet)                               as expected_clean_sheets,
    avg(fd.difficulty)                                  as difficulty,
    -- Same casing convention as the /teams ticker: ARS home, ars away.
    string_agg(case when fd.is_home then upper(o.short_name) else lower(o.short_name) end,
               ', ' order by fd.kickoff_time)           as opponents,
    -- Opponent style, which is what turns a rank into a sentence a human can check. NULL for
    -- promoted clubs, which have no `team_style` row until they have played — and NULL must
    -- stay NULL all the way to the screen rather than becoming a flattering zero.
    -- Rounded: avg() over an integer column returns numeric at full scale, and 9 came out of
    -- the view as 9.0000000000000000. Over a double gameweek this is a genuine mean of two
    -- opponents, so one decimal rather than an integer.
    round(avg(os.attacking_rank)::numeric, 1)           as opponent_attacking_rank,
    round(avg(os.defensive_rank)::numeric, 1)           as opponent_defensive_rank,
    round(avg(os.xg_per_match)::numeric, 2)             as opponent_xg_per_match,
    round(avg(os.xga_per_match)::numeric, 2)            as opponent_xga_per_match,
    -- The true denominator, counted rather than assumed. Three promoted clubs have no
    -- `team_style` row, so "6th of 20" was wrong by three places before anyone read it.
    (select count(*) from team_style
      where season = (select stats_season from season_context))::int as ranked_clubs
  from fixture_difficulty fd
  join teams o on o.code = fd.opponent_code
  left join team_style os
    on os.team_code = fd.opponent_code
   and os.season = (select stats_season from season_context)
  where fd.gameweek = (select gameweek from next_gameweek)
    and not coalesce(fd.finished, false)
  group by fd.team_code
)
select
  a.*,
  -- Ranked across the 20 clubs, not across the several hundred players. A fixture is a
  -- property of the club, and ranking it per player would weight it by squad size — a club
  -- with 30 listed players would drag the distribution around for no footballing reason.
  -- The cost is resolution: 20 clubs means steps of 0.05 and real ties. That is honest.
  -- Cast: cume_dist returns double precision, and mixing that into the numeric percentiles
  -- from player_scout makes round(value, digits) unresolvable.
  (cume_dist() over (order by a.expected_clean_sheets))::numeric as defence_fixture_rank,
  (cume_dist() over (order by a.xg_for))::numeric                as attack_fixture_rank
from agg a;

-- ---------------------------------------------------------------------------
-- player_target_base — one definition of "worth buying", two surfaces on top of it
-- ---------------------------------------------------------------------------
drop view if exists player_target_base cascade;
create view player_target_base as
with eligible as (
select
  s.player_code, s.web_name, s.position, s.element_type, s.team_short, s.team_code,
  s.price, s.selected_by_percent, s.minutes, s.total_points,
  s.xgi_per_90, s.defcon_per_90, s.xgc_per_90, s.points_per_million,
  -- Added because the article cites bonus points in almost every write-up and we had the
  -- column sitting unused. Displayed only; not in any score.
  s.bps_per_90,
  s.output_percentile, s.differential_percentile, s.value_percentile,
  s.is_available, s.status, s.news, s.penalties_order,
  a.chance_of_playing, a.minutes_share,

  coalesce(f.fixture_count, 0)      as fixture_count,
  f.opponents,
  f.difficulty                      as fixture_difficulty,
  f.xg_for                          as fixture_xg_for,
  f.expected_clean_sheets           as fixture_clean_sheets,

  -- Position decides which half of the fixture is the relevant half. Our output percentile
  -- has been position-aware since 0004 — a centre-back is not judged on xGI — and the
  -- fixture layer had no equivalent. A keeper wants the opponent to be toothless; a forward
  -- wants them to be porous. Those are different columns of the same row.
  case when s.element_type in (1, 2) then 'clean sheet' else 'goals' end   as fixture_basis,
  case when s.element_type in (1, 2) then f.defence_fixture_rank
       else f.attack_fixture_rank end                                      as fixture_rank,
  -- The opponent's weakness in the dimension this player exploits: their attack if we are
  -- keeping it out, their defence if we are trying to score. 1 = best in the league, so a
  -- HIGH number here is a good fixture.
  case when s.element_type in (1, 2) then f.opponent_attacking_rank
       else f.opponent_defensive_rank end                                  as opponent_rank,
  case when s.element_type in (1, 2) then f.opponent_xg_per_match
       else f.opponent_xga_per_match end                                   as opponent_per_match,
  f.ranked_clubs
from player_scout s
join player_availability a on a.player_code = s.player_code
left join team_fixture_context f on f.team_code = s.team_code
where not s.is_cold_start
  -- Certifies that a per-90 rate is measurable off 450 minutes. It says nothing about whether
  -- the player is a regular, which is the claim a buy recommendation actually makes.
  and s.has_reliable_sample
  -- Inherited from 0013. 31 of 269 recommendations used to be injured or suspended players.
  and a.fully_fit
  -- Fault 3. A quarter of a season, ~9.5 full matches. Low on purpose: high enough to drop a
  -- backup keeper on 540 minutes, low enough to keep the squad players who become starters,
  -- which is most of what a differential list is for.
  and a.minutes_share >= 0.25
)
select
  e.*,
  -- Volume, ranked separately from rate. These are orthogonal by construction — output is a
  -- per-90 figure and cannot see how often the 90 happened — which is precisely why a
  -- bit-part player could top the list on output alone.
  (cume_dist() over (order by e.minutes_share))::numeric as minutes_rank
from eligible e;

-- ---------------------------------------------------------------------------
-- hidden_gems — unchanged premise, plus the fixture
-- ---------------------------------------------------------------------------
-- Five equal components now: output, scarcity, value, fixture, minutes. Equal weighting is the
-- same doctrine as everywhere else — ranks averaged, never raw quantities multiplied, so that
-- whichever metric happens to have the widest spread cannot quietly dominate.
--
-- A blanking club scores 0 on the fixture axis rather than being excluded, because scoring
-- nothing is the truthful answer for a player with no match. The rank stays NULL so the
-- screen can say "blank" instead of printing a 0 that reads like a bad fixture.
drop view if exists hidden_gems cascade;
create view hidden_gems as
select
  b.*,
  round((b.output_percentile + b.differential_percentile + b.value_percentile
         + coalesce(b.fixture_rank, 0) + b.minutes_rank) / 5.0, 4) as gem_score
from player_target_base b
where b.selected_by_percent < 10
order by (b.output_percentile + b.differential_percentile + b.value_percentile
          + coalesce(b.fixture_rank, 0) + b.minutes_rank) desc;

-- ---------------------------------------------------------------------------
-- target_players — the dashboard's question, without the differential gate
-- ---------------------------------------------------------------------------
-- Four components: how good, how cheap, how kind the fixture, how often he plays. Ownership is
-- not one of them. It is displayed, and it flags a differential, but it does not decide the
-- order — a manager opening the landing page is asking who to buy, and the answer to that is
-- allowed to be a player other people already own.
drop view if exists target_players cascade;
create view target_players as
select
  b.*,
  (b.selected_by_percent < 10)                                             as is_differential,
  round((b.output_percentile + b.value_percentile
         + coalesce(b.fixture_rank, 0) + b.minutes_rank) / 4.0, 4)         as target_score
from player_target_base b
order by (b.output_percentile + b.value_percentile
          + coalesce(b.fixture_rank, 0) + b.minutes_rank) desc;

-- ---------------------------------------------------------------------------
-- target_check — the invariants these two views exist to hold
-- ---------------------------------------------------------------------------
drop view if exists target_check cascade;
create view target_check as
select
  (select count(*) from target_players)                                    as targets,
  (select count(*) from hidden_gems)                                       as gems,
  -- 0013's fault, now asserted on both surfaces rather than one.
  (select bool_and(is_available) from target_players)                      as all_targets_available,
  (select bool_and(is_available) from hidden_gems)                         as all_gems_available,
  -- The fault this migration exists to fix: a recommendation with no fixture attached.
  (select count(*) from target_players where fixture_count = 0)            as targets_blanking,
  (select bool_and(fixture_rank is not null)
     from target_players where fixture_count > 0)                          as ranked_when_playing,
  (select bool_and(fixture_rank is null)
     from target_players where fixture_count = 0)                          as null_when_blank,
  (select bool_and(fixture_rank between 0 and 1) from target_players
    where fixture_rank is not null)                                        as fixture_rank_in_range,
  (select bool_and(target_score between 0 and 1) from target_players)      as score_in_range,
  -- Position must actually change which fixture number is used, or the split is decoration.
  (select bool_and(fixture_basis = 'clean sheet')
     from target_players where element_type in (1, 2))                     as keepers_on_clean_sheets,
  (select bool_and(fixture_basis = 'goals')
     from target_players where element_type in (3, 4))                     as attackers_on_goals,
  -- An opponent rank outside the ranked set means the join found the wrong club.
  (select bool_and(opponent_rank between 1 and ranked_clubs) from target_players
    where opponent_rank is not null)                                       as opponent_rank_sane,
  -- Fault 3. No recommendation may sit below a quarter of a season, and the worst survivor is
  -- printed so the floor cannot quietly stop being enforced without anyone noticing.
  (select bool_and(minutes_share >= 0.25) from target_players)             as all_regulars,
  (select round(min(minutes_share), 3) from target_players)                as min_minutes_share,
  -- Volume against rate. If these two correlated, minutes would be a second helping of output
  -- rather than the independent axis the bit-part players slipped through.
  (select round(corr(output_percentile, minutes_rank)::numeric, 3)
     from target_players)                                                  as output_minutes_corr,
  -- Does the fixture layer change anything? If the top of the list is identical with and
  -- without it, the work was cosmetic and should be reverted rather than believed.
  (select round(corr(output_percentile, coalesce(fixture_rank, 0))::numeric, 3)
     from target_players)                                                  as output_fixture_corr
;

-- ---------------------------------------------------------------------------
-- captain_check — recreated verbatim from 0013, which the cascade above dropped
-- ---------------------------------------------------------------------------
drop view if exists captain_check cascade;
create view captain_check as
select
  count(*)                                                        as candidates,
  count(*) filter (where has_shot_data)                            as with_shot_data,
  bool_and(floor_score between 0 and 1)                            as floor_in_range,
  bool_and(ceiling_score between 0 and 1)                          as ceiling_in_range,
  bool_and(p_team_scores between 0 and 1
       and p_team_scores_2plus between 0 and 1)                    as scoring_probs_in_range,
  bool_and(p_team_scores_2plus <= p_team_scores)                   as tail_ordered,
  bool_and(status = 'a')                                           as all_fit,
  bool_and(minutes_share >= 0.5)                                   as all_regulars,
  round(min(minutes_share), 3)                                     as min_minutes_share,
  round(avg(p_team_scores), 3)                                     as avg_p_scores,
  round(corr(floor_score, ceiling_score)::numeric, 3)              as floor_ceiling_corr,
  (select count(*) from player_shot_profile)                       as players_with_shot_profile,
  (select bool_and(situation is not null and body_part is not null) from understat_shots)
                                                                   as shot_attributes_repaired,
  (select count(*) from hidden_gems)                               as gems,
  (select bool_and(is_available) from hidden_gems)                 as all_gems_available
from captain_picks;
