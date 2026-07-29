-- ---------------------------------------------------------------------------
-- 0026 — is a £5.5m defender better value than a £5.5m midfielder? Measured, not repeated.
--
-- allaboutfpl's preseason asserts that "£5.0–5.5 DEFs are good value for money … can easily
-- outscore Midfielders at the same price point or even higher", citing Milenković at £5.5m on
-- 178 points, and attributes it to DEFCON. We hold the whole post-DEFCON season, so the honest
-- move is to compute the answer rather than restate the claim.
--
-- **Their claim holds.** Measured 2026-07-29 over 2025/26, by start-of-season price:
--
--     £5.0–5.5   DEF  n=47  82.3 pts  15.78 per £m
--                MID  n=110 61.0 pts  11.71 per £m
--
-- Defenders beat midfielders on points per million in every comparable bucket, not just that
-- one. And a finding neither they nor the research doc mentions: **goalkeepers at £4.6–5.5
-- returned 19.79 per £m, the best bucket in the game** (n=14, 102.4 points average). A £5.0m
-- keeper is the single most efficient outlay available.
--
-- A VIEW, NOT A CONSTANT
-- The numbers above are in this comment as a record of what was true when it was written. The
-- view recomputes them on every read, so the screen can never quote a July figure in March.
-- That is the same discipline `team_style_reliability` follows: nothing is hardcoded, and the
-- answer is allowed to change as the data does.
--
-- THREE THINGS THAT MAKE THIS HONEST RATHER THAN JUST CALCULABLE
--
-- 1. **`history_past`, never `bootstrap`** — CLAUDE.md rule 3. They disagree for loan and
--    transfer cases; `bootstrap` had Anthony at 0 minutes against 2 717 in history_past.
--
-- 2. **Survivorship is real here and is published rather than hidden.** `history_past` comes
--    from element-summary of *currently registered* players, so a player who left the Premier
--    League has no row at all. Every departed £5.0m defender who flopped and was sold is
--    invisible, which biases every bucket **upward** — and most in the cheap buckets, where
--    squad filler churns hardest. `players_missing_a_price` and the header note carry that.
--    The DEF-versus-MID *comparison* is far more robust than the levels, because the bias
--    applies to both. Bounding it is impossible from this table: there is no source here for a
--    departed player's season, which is exactly why the limitation is stated instead of
--    corrected.
--
-- 3. **`start_cost`, not `end_cost` or `now_cost`.** The question is "what was he worth at the
--    price I would have paid", and that is the preseason price. Using the end-of-season price
--    would divide a good season by the price his good season caused.
--
-- THE BPS CAVEAT, QUANTIFIED RATHER THAN WAVED AT
-- 2026/27 changes the bonus system: CBI moves from 1 BPS per 2 actions to 1 per 3, the −1 for
-- being tackled goes, and goalkeeper saves are restructured. Total points include bonus, so
-- these figures inherit some of that. **Measured: bonus is 6.4% of a defender's season points**
-- (12.6% for forwards), and the rule change alters who wins bonus rather than removing it, so
-- the effect on any individual is a fraction of that 6.4%. `bonus_share_pct` puts the exposure
-- on screen per bucket. This is a small correction to points-per-million and a total rewrite of
-- what `bps_per_90` means — two different exposures, and conflating them overstates the first.
-- ---------------------------------------------------------------------------

drop view if exists position_price_value cascade;
create view position_price_value as
with priced as (
  select
    et.singular_name_short                            as position,
    et.id                                             as element_type,
    h.player_code,
    h.start_cost,
    h.total_points,
    h.bonus,
    h.minutes,
    -- Half-million bands from £4.0m. Wider than the price grid so each band holds enough
    -- players to mean something: at £0.1m granularity most bands would hold one or two.
    case
      when h.start_cost <= 45 then '4.0-4.5'
      when h.start_cost <= 55 then '4.6-5.5'
      when h.start_cost <= 65 then '5.6-6.5'
      when h.start_cost <= 80 then '6.6-8.0'
      when h.start_cost <= 100 then '8.1-10.0'
      else '10.0+'
    end                                               as price_band,
    case
      when h.start_cost <= 45 then 1 when h.start_cost <= 55 then 2
      when h.start_cost <= 65 then 3 when h.start_cost <= 80 then 4
      when h.start_cost <= 100 then 5 else 6
    end                                               as band_order
  from player_season_totals h
  -- Position comes from the **current** registration, not the measured season. Two reasons, and
  -- the first is decisive: `player_seasons` holds only 2026-27 — 563 rows, no 2025-26 — so a
  -- join on `stats_season` returns nothing at all. The first draft did exactly that and the view
  -- came back empty. The second is that current position is also the *right* choice for the
  -- question being asked: "if I spend £5.5m on a defender this season, what have £5.5m defenders
  -- returned?" The slot being filled is today's. A player FPL reclassified between seasons has
  -- last season's points credited to this season's position, which is the intended behaviour
  -- rather than a compromise.
  --
  -- Note also `(select current_season from ...)` spelled out rather than `(select season from
  -- ...)`: `season_context` has no `season` column, so that name would resolve as an outer
  -- reference to `ps.season` and silently become the tautology `ps.season = ps.season`.
  join player_seasons ps
    on ps.player_code = h.player_code
   and ps.season = (select current_season from season_context)
  join element_types et on et.id = ps.element_type
  where h.season = (select stats_season from season_context)
    and h.source = 'history_past'
    and h.start_cost is not null
    and h.start_cost > 0
)
select
  p.position,
  p.element_type,
  p.price_band,
  p.band_order,
  count(*)                                                          as players,
  round(avg(p.total_points), 1)                                     as avg_points,
  round(max(p.total_points), 0)                                     as best_points,
  -- The headline. Points per £m of the price you would have paid.
  round(avg(p.total_points::numeric / (p.start_cost / 10.0)), 2)    as points_per_million,
  round(max(p.total_points::numeric / (p.start_cost / 10.0)), 2)    as best_points_per_million,
  -- Median matters as much as the mean here: one Milenković drags a bucket, and a manager
  -- picking blind gets closer to the median than to the mean.
  round(percentile_cont(0.5) within group (
          order by p.total_points::numeric / (p.start_cost / 10.0))::numeric, 2)
                                                                    as median_points_per_million,
  -- How much of this bucket's return is bonus, and therefore priced on a superseded rule set.
  round(100.0 * sum(p.bonus) / nullif(sum(p.total_points), 0), 1)    as bonus_share_pct,
  -- A bucket where most players barely played says more about squad filler than about value.
  count(*) filter (where p.minutes >= 900)                          as players_over_10_matches,
  round(avg(p.minutes), 0)                                          as avg_minutes
from priced p
group by p.position, p.element_type, p.price_band, p.band_order
having count(*) >= 4   -- below this the mean is one player's season
order by p.element_type, p.band_order;

-- ---------------------------------------------------------------------------
-- position_price_value_check
-- ---------------------------------------------------------------------------

drop view if exists position_price_value_check cascade;
create view position_price_value_check as
select
  (select count(*) from position_price_value)                        as buckets,
  (select count(distinct position) from position_price_value)        as positions,
  -- Coalesced: `sum()` over zero rows is NULL, which in a check table reads as "unknown" when
  -- the honest answer is "none". `buckets = 0` above is the signal that something is wrong.
  (select coalesce(sum(players), 0) from position_price_value)        as players_in_buckets,

  -- Survivorship, stated as a number rather than a caveat. These are the players in the current
  -- game with no 2025/26 record — new signings and the promoted three — plus, importantly, any
  -- who DID play and are missing anyway, which would be a genuine gap rather than a new arrival.
  (select count(*) from player_seasons ps
    where ps.season = (select current_season from season_context)
      and not exists (select 1 from player_season_totals h
                       where h.player_code = ps.player_code
                         and h.season = (select stats_season from season_context)
                         and h.source = 'history_past'))             as players_missing_a_price,
  -- The one that would reveal a real hole: a player with recorded 2025/26 league minutes but no
  -- history_past row. New signings have no minutes either, so they do not trip this.
  (select count(*) from player_seasons ps
    where ps.season = (select current_season from season_context)
      and exists (select 1 from core_insights_player_match m
                   where m.player_code = ps.player_code and m.tournament = 'prem'
                     and m.minutes_played > 0)
      and not exists (select 1 from player_season_totals h
                       where h.player_code = ps.player_code
                         and h.season = (select stats_season from season_context)
                         and h.source = 'history_past'))             as played_but_unpriced,

  (select coalesce(bool_and(points_per_million >= 0), true)
     from position_price_value)                                      as ppm_non_negative,
  (select coalesce(bool_and(best_points_per_million >= points_per_million), true)
     from position_price_value)                                      as best_beats_mean,
  (select coalesce(bool_and(avg_points <= best_points), true)
     from position_price_value)                                      as mean_beats_no_one,
  (select coalesce(bool_and(players >= 4), true)
     from position_price_value)                                      as min_sample_enforced,
  (select coalesce(bool_and(bonus_share_pct between 0 and 100), true)
     from position_price_value)                                      as bonus_share_sane,

  -- Independent re-derivation of the headline claim, computed here from the base table rather
  -- than read back out of the view. If these two disagree the grouping is wrong.
  (select round(avg(h.total_points::numeric / (h.start_cost / 10.0)), 2)
     from player_season_totals h
     join player_seasons ps on ps.player_code = h.player_code
                           and ps.season = (select current_season from season_context)
    where h.season = (select stats_season from season_context)
      and h.source = 'history_past' and ps.element_type = 2
      and h.start_cost between 46 and 55)                            as def_46_55_ppm,
  (select round(avg(h.total_points::numeric / (h.start_cost / 10.0)), 2)
     from player_season_totals h
     join player_seasons ps on ps.player_code = h.player_code
                           and ps.season = (select current_season from season_context)
    where h.season = (select stats_season from season_context)
      and h.source = 'history_past' and ps.element_type = 3
      and h.start_cost between 46 and 55)                            as mid_46_55_ppm,
  (select coalesce(bool_and(abs(v.points_per_million - x.ppm) < 0.005), true)
     from position_price_value v
     join lateral (
       select round(avg(h.total_points::numeric / (h.start_cost / 10.0)), 2) as ppm
       from player_season_totals h
       join player_seasons ps on ps.player_code = h.player_code
                             and ps.season = (select current_season from season_context)
       where h.season = (select stats_season from season_context)
         and h.source = 'history_past'
         and ps.element_type = v.element_type
         and case
               when h.start_cost <= 45 then '4.0-4.5'
               when h.start_cost <= 55 then '4.6-5.5'
               when h.start_cost <= 65 then '5.6-6.5'
               when h.start_cost <= 80 then '6.6-8.0'
               when h.start_cost <= 100 then '8.1-10.0'
               else '10.0+' end = v.price_band
     ) x on true)                                                    as every_bucket_recomputes;
