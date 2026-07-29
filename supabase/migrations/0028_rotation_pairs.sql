-- ---------------------------------------------------------------------------
-- 0028 — rotation pairs: two cheap players whose fixtures take turns being kind
--
-- allaboutfpl's preseason pairs two clubs with complementary schedules and alternates which
-- defender starts, scoring the result as "0 of 7 games against last season's top six". The whole
-- thing runs on a **three-tier bucket of last season's table** — top 6 / 7th-12th / the rest.
--
-- We have `fixture_difficulty` per club per gameweek: continuous, venue-aware, and calibrated
-- against a de-vigged market at Spearman 0.92. So the pair score is a sum over the window of the
-- better of the two clubs each week:
--
--     score(i, j, N) = Σ over the next N gameweeks of max(easiness_i, easiness_j)
--
-- **Doubles and blanks fall out for free**, which is the reason to build it this way rather than
-- averaging: a blanking club contributes 0 that week, so its partner carries it — which is exactly
-- what a rotation is for — and a doubling club contributes both fixtures.
--
-- TWO EASINESSES, BECAUSE AN EASY FIXTURE FOR A STRIKER IS A DIFFERENT FIXTURE
-- The split already exists in `fixture_difficulty` and is used here unchanged:
--   - **defensive** — expected clean sheets, Σ p_clean_sheet. Additive, so a double is worth two
--     chances at the bonus, and that is the FPL-relevant quantity.
--   - **attacking** — P(scores at least once) = 1 − e^−Λ over the gameweek's fixtures, the same
--     expression 0025 promoted. A probability, so it cannot exceed 1 however many fixtures there
--     are; the honest reading of "will this club score" for a doubling club.
--
-- Mixing the two would be the `fixture_run` incomparable-totals trap again: expected clean sheets
-- can exceed 1 and a probability cannot, so they are never compared with each other, only within
-- their own axis.
--
-- WHAT COUNTS AS ROTATABLE, AND WHY THE FILTER IS THE FEATURE
-- A rotation between two £6.5m defenders is not a rotation, it is two starters and a wasted slot.
-- So: `price <= 5.0`, available, and a real minutes share — a player who does not start is not
-- half of a rotation either, he is a bench slot. Cheapness is the whole point: the pair exists to
-- free money for the players you actually want.
--
-- TWO THINGS THE FIRST DRAFT GOT WRONG, BOTH VISIBLE ONLY BY READING THE OUTPUT
--
-- 1. **Same axis is not the same thing as same position.** Grouping goalkeepers with defenders
--    produced "Martinez (AVL) + Yoro (MUN)" as a top defensive pair — a keeper and a centre-back.
--    They do not compete for a squad slot, so rotating them is meaningless; you play both every
--    week. A rotation is two players filling **one** slot, so the pair must share `element_type`.
--    The axis still decides which easiness to score, which is a separate question.
--
-- 2. **The score is a property of the club pair, not of the players.** So the first draft's top
--    five defensive pairs were AVL+MUN four times over with identical scores of 2.174, and 1 354
--    rows carried about 190 distinct answers. Collapsed to one row per (position, club pair) with
--    the cheapest qualifying player from each club as its representative — which is also the
--    useful form: "AVL and MUN alternate well; the cheapest way in is Digne and Shaw at £9.0m."
--    `alternatives_a` / `alternatives_b` count who else at each club would do, so the collapse
--    hides nothing.
--
-- Pairs are emitted once, with `code_a < code_b`, and never from the same club — two players at
-- one club share a fixture list, so their max() is just that club's own run.
-- ---------------------------------------------------------------------------

drop view if exists rotation_window cascade;
create view rotation_window as
-- The next six gameweeks. Six because that is the horizon over which a manager plans a chip or a
-- transfer, and it matches the `fixture_run` window on /teams so the two screens agree.
select
  (select gameweek from next_gameweek)      as first_gameweek,
  (select gameweek from next_gameweek) + 5  as last_gameweek;

drop view if exists rotation_club_gameweek cascade;
create view rotation_club_gameweek as
with grid as (
  -- Every club against every gameweek in the window, so a **blank is a row with zero fixtures**
  -- rather than a missing row. A missing row would silently drop out of the sum and read as if
  -- the club had not been considered.
  select t.code as team_code, g.gameweek
  from teams t
  cross join generate_series(
    (select first_gameweek from rotation_window),
    (select last_gameweek from rotation_window)
  ) as g(gameweek)
)
select
  g.team_code,
  g.gameweek,
  count(fd.fpl_id)                                        as fixtures,
  -- Additive: two fixtures are two clean-sheet chances.
  coalesce(sum(fd.p_clean_sheet), 0)                      as defensive_easiness,
  -- A probability over the gameweek's total expected goals, so it stays in [0, 1].
  case when count(fd.fpl_id) = 0 then 0
       else round((1 - exp(-sum(fd.expected_goals_for)))::numeric, 4)
  end                                                     as attacking_easiness,
  string_agg(case when fd.is_home then upper(o.short_name) else lower(o.short_name) end,
             ', ' order by fd.kickoff_time)               as opponents
from grid g
left join fixture_difficulty fd
       on fd.team_code = g.team_code
      and fd.gameweek = g.gameweek
      and not coalesce(fd.finished, false)
left join teams o on o.code = fd.opponent_code
group by g.team_code, g.gameweek;

-- ---------------------------------------------------------------------------
-- rotation_pairs — the scored pairs
-- ---------------------------------------------------------------------------
drop view if exists rotation_pairs cascade;
create view rotation_pairs as
with eligible as (
  select
    s.player_code, s.web_name, s.position, s.element_type, s.team_code, s.team_short,
    s.price, s.selected_by_percent, s.total_points, s.is_available,
    a.minutes_share, a.start_rate,
    -- Which axis this player is rotated for. Keepers and defenders are bought for clean sheets;
    -- midfielders and forwards for goals. `element_type` decides, not preference.
    case when s.element_type in (1, 2) then 'defensive' else 'attacking' end as axis
  from player_scout s
  join player_availability a on a.player_code = s.player_code
  where s.price <= 5.0
    and s.is_available
    -- Half the club's minutes. Below that he is not half a rotation, he is a bench slot — and
    -- the pair's whole premise is that one of the two starts every week.
    and a.minutes_share >= 0.50
),
-- One representative per club per position: the cheapest, then the one who plays most. The pair
-- score cannot distinguish players at the same club — they share a fixture list — so ranking every
-- combination just repeats one club pair N times.
rep as (
  select distinct on (element_type, team_code)
    player_code, web_name, position, element_type, team_code, team_short,
    price, minutes_share, total_points, axis
  from eligible
  order by element_type, team_code, price asc, minutes_share desc, total_points desc
),
depth as (
  select element_type, team_code, count(*) as options from eligible group by 1, 2
),
paired as (
  select
    x.player_code as code_a, y.player_code as code_b,
    x.web_name as name_a, y.web_name as name_b,
    x.position as position_a, y.position as position_b,
    x.element_type,
    x.team_code as team_a, y.team_code as team_b,
    x.team_short as short_a, y.team_short as short_b,
    x.price as price_a, y.price as price_b,
    x.minutes_share as minutes_a, y.minutes_share as minutes_b,
    x.total_points as points_a, y.total_points as points_b,
    da.options as alternatives_a, db.options as alternatives_b,
    x.axis
  from rep x
  join rep y
    on y.player_code > x.player_code       -- each pair once
   and y.team_code <> x.team_code          -- two players at one club share a fixture list
   -- Same position, not merely the same axis. A keeper and a defender do not share a squad slot,
   -- so alternating them is not a rotation — see note 1 in the header.
   and y.element_type = x.element_type
  join depth da on da.element_type = x.element_type and da.team_code = x.team_code
  join depth db on db.element_type = y.element_type and db.team_code = y.team_code
),
scored as (
  select
    p.*,
    sum(case when p.axis = 'defensive'
             then greatest(ca.defensive_easiness, cb.defensive_easiness)
             else greatest(ca.attacking_easiness, cb.attacking_easiness) end)  as pair_score,
    -- What the better of the two clubs alone would have scored. The difference is the entire
    -- value of rotating rather than owning one of them — if it is near zero, do not bother.
    greatest(
      sum(case when p.axis = 'defensive' then ca.defensive_easiness
               else ca.attacking_easiness end),
      sum(case when p.axis = 'defensive' then cb.defensive_easiness
               else cb.attacking_easiness end)
    )                                                                          as best_single_score,
    count(*) filter (where ca.fixtures = 0 and cb.fixtures = 0)                as both_blank,
    count(*) filter (where ca.fixtures = 0 or cb.fixtures = 0)                 as either_blank,
    count(*) filter (where ca.fixtures > 1 or cb.fixtures > 1)                 as either_double,
    count(*)                                                                   as gameweeks
  from paired p
  join rotation_club_gameweek ca on ca.team_code = p.team_a
  join rotation_club_gameweek cb on cb.team_code = p.team_b and cb.gameweek = ca.gameweek
  group by p.code_a, p.code_b, p.name_a, p.name_b, p.position_a, p.position_b, p.element_type,
           p.team_a, p.team_b, p.short_a, p.short_b, p.price_a, p.price_b,
           p.minutes_a, p.minutes_b, p.points_a, p.points_b,
           p.alternatives_a, p.alternatives_b, p.axis
)
select
  s.code_a, s.code_b, s.name_a, s.name_b,
  s.position_a, s.position_b, s.element_type, s.team_a, s.team_b, s.short_a, s.short_b,
  s.price_a, s.price_b, round(s.price_a + s.price_b, 1)          as combined_price,
  s.minutes_a, s.minutes_b, s.points_a, s.points_b,
  -- How many other qualifying players at each club could take the slot. The collapse to one
  -- representative per club hides nobody: this is the count it stands for.
  s.alternatives_a, s.alternatives_b,
  s.axis,
  s.gameweeks,
  round(s.pair_score::numeric, 3)                                as pair_score,
  round(s.best_single_score::numeric, 3)                         as best_single_score,
  -- The reason to rotate at all, in the units of the axis.
  round((s.pair_score - s.best_single_score)::numeric, 3)        as rotation_gain,
  -- The same gain in FPL points, which is the only unit that decides anything. A clean sheet is
  -- 4 points for a keeper or defender; a goal-involvement chance is worth roughly 3 to the kind
  -- of cheap midfielder this view surfaces, so that axis is a rougher conversion and labelled so.
  --
  -- **This number is the honest verdict on the feature.** Measured 2026-07-29 over GW1-6, the best
  -- defensive pair gains 0.204 expected clean sheets — about **0.8 points across six gameweeks**,
  -- or 0.14 a week. That is because the window currently holds no blanks and no doubles: with every
  -- club playing exactly once a week and Elo difficulty fairly smooth, max(a, b) is barely above
  -- max of two similar numbers. Rotation earns its keep when the calendar breaks, and the screen
  -- should say so rather than implying the pairing itself is clever.
  round((s.pair_score - s.best_single_score)::numeric
        * case when s.axis = 'defensive' then 4 else 3 end, 2)   as gain_in_points,
  s.either_blank, s.both_blank, s.either_double,
  (select first_gameweek from rotation_window)                   as first_gameweek,
  (select last_gameweek from rotation_window)                    as last_gameweek,
  rank() over (partition by s.position_a order by s.pair_score desc) as position_rank
from scored s
-- A pair that gains nothing over simply owning the better club is not a rotation, it is two
-- players. Zero is the honest floor: the sum can never be below the best single by construction.
where s.pair_score > s.best_single_score;

-- ---------------------------------------------------------------------------
-- rotation_pairs_check
--
-- The research doc's §10 asks for a simulated double and blank rather than waiting for one, and
-- it is right to: 2026/27 currently has **760 club-gameweeks, every one with exactly one
-- fixture**, so the blank and double branches are unexercised by the data. `verify` cannot
-- simulate, so the assertions below are the ones checkable now, and
-- `scripts/probe/prove_rotation_pairs.py` does the simulation with no database at all.
-- ---------------------------------------------------------------------------
drop view if exists rotation_pairs_check cascade;
create view rotation_pairs_check as
select
  (select count(*) from rotation_club_gameweek)                       as club_gameweeks,
  (select count(*) from rotation_pairs)                               as pairs,
  (select count(distinct axis) from rotation_pairs)                   as axes,

  -- The grid must be complete: 20 clubs × 6 gameweeks, blanks included as zero-fixture rows.
  (select count(*) = 20 * (1 + (select last_gameweek - first_gameweek from rotation_window))
     from rotation_club_gameweek)                                     as grid_is_complete,
  (select count(*) from rotation_club_gameweek where fixtures = 0)     as blank_club_gameweeks,
  (select count(*) from rotation_club_gameweek where fixtures > 1)     as double_club_gameweeks,
  -- A blank must contribute nothing to either axis, never a flattering default.
  (select coalesce(bool_and(defensive_easiness = 0 and attacking_easiness = 0), true)
     from rotation_club_gameweek where fixtures = 0)                   as blank_contributes_zero,
  -- A probability cannot exceed 1 however many fixtures a club has that week.
  (select coalesce(bool_and(attacking_easiness between 0 and 1), true)
     from rotation_club_gameweek)                                     as attacking_is_a_probability,
  -- Expected clean sheets is additive and MAY exceed 1 over a double. Asserting otherwise would
  -- be asserting the trap rather than against it.
  (select coalesce(bool_and(defensive_easiness >= 0), true)
     from rotation_club_gameweek)                                     as defensive_non_negative,

  -- Pair construction.
  (select coalesce(bool_and(team_a <> team_b), true) from rotation_pairs)
                                                                      as never_same_club,
  (select coalesce(bool_and(code_a < code_b), true) from rotation_pairs)
                                                                      as each_pair_once,
  (select coalesce(bool_and(price_a <= 5.0 and price_b <= 5.0), true) from rotation_pairs)
                                                                      as price_cap_enforced,
  (select coalesce(bool_and(minutes_a >= 0.50 and minutes_b >= 0.50), true)
     from rotation_pairs)                                             as both_are_regulars,
  -- A rotation fills one squad slot, so the two players must play the same position. Grouping by
  -- axis alone paired a goalkeeper with a centre-back; see note 1 in the header.
  (select coalesce(bool_and(position_a = position_b), true) from rotation_pairs)
                                                                      as same_position_only,
  -- One row per (position, club pair). More than one means the collapse to a representative
  -- regressed and the list is repeating a club pair under different player names.
  (select coalesce(bool_and(n = 1), true) from (
     select position_a, least(team_a, team_b) t1, greatest(team_a, team_b) t2, count(*) n
     from rotation_pairs group by 1, 2, 3) x)                         as one_row_per_club_pair,

  -- The score. Taking the better club each week can never beat itself, and rotating can never be
  -- worse than owning the better of the two — that is what makes `rotation_gain` a floor at zero.
  (select coalesce(bool_and(pair_score >= best_single_score), true) from rotation_pairs)
                                                                      as pair_beats_single,
  (select coalesce(bool_and(rotation_gain > 0), true) from rotation_pairs)
                                                                      as gain_is_positive,
  (select coalesce(bool_and(gameweeks = 1 + (select last_gameweek - first_gameweek
                                               from rotation_window)), true)
     from rotation_pairs)                                             as every_pair_spans_window,

  -- Independent re-derivation of one pair's score from the club-gameweek rows, rather than a
  -- restatement of the view's own sum.
  (select coalesce(bool_and(abs(rp.pair_score - x.recomputed) < 0.002), true)
     from rotation_pairs rp
     join lateral (
       select sum(case when rp.axis = 'defensive'
                       then greatest(ca.defensive_easiness, cb.defensive_easiness)
                       else greatest(ca.attacking_easiness, cb.attacking_easiness) end) as recomputed
       from rotation_club_gameweek ca
       join rotation_club_gameweek cb
         on cb.team_code = rp.team_b and cb.gameweek = ca.gameweek
       where ca.team_code = rp.team_a
     ) x on true)                                                     as score_recomputes;
