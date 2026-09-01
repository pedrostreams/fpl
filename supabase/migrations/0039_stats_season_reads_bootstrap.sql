-- ---------------------------------------------------------------------------
-- 0039 — the in-progress season has no `history_past`, so stop excluding it
-- ---------------------------------------------------------------------------
-- `player_stats_season` was `from player_season_totals where source = 'history_past'`. That is
-- the third rule in CLAUDE.md's "three things that will bite you", and it is correct — for a
-- **completed** season. Applied unconditionally it deletes the season being played, because
-- `history_past` comes from `element-summary.history_past` and is only written once a season is
-- over. The in-progress season has exactly one source, and it is `bootstrap`.
--
-- MEASURED 2026-09-01, two gameweeks in: `player_season_totals` held 626 rows for 2026-27
-- (`source = 'bootstrap'`, up to 180 minutes) and `player_stats_season` held **none** — its
-- most recent season was 2025-26. `season_context.stats_season` had flipped to 2026-27 when the
-- season started, which is right, so `player_scout`'s
--
--     left join player_stats_season s on s.player_code = st.player_code
--                                    and s.season = ctx.stats_season
--
-- matched nothing for all 626 players and every stat column came back NULL. Not just the
-- per-90 rates — `minutes`, `total_points`, `goals_scored`, the lot. Hence 626 of 626
-- `is_cold_start`, 0 of 626 `has_reliable_sample`, `captain_picks` and `target_players` empty,
-- and `/players` and the player page missing most of their columns.
--
-- This is the failure mode this repo keeps meeting: **preseason could not distinguish the bug
-- from the design.** Before GW1, `stats_season` pointed at 2025-26, which does have
-- `history_past`, so the join worked and every screen was full. The view was only ever exercised
-- against the one season where its filter was harmless.
--
-- AND WAITING WOULD NOT HAVE FIXED IT. The obvious reading is that the 450-minute reliability
-- floor is simply unmet in September and clears itself around GW5. It does not: at GW5 those
-- rows still carry `source = 'bootstrap'` and are still excluded, so the screens would have
-- stayed empty for the whole season while looking like a threshold that had not come good yet.
--
-- THE FIX, and why it is not just "drop the where clause". `history_past` and `bootstrap`
-- disagree for loan and transfer cases — verified 2026-07-26, Anthony at 0 bootstrap minutes
-- against 2717 in `history_past` — so for a completed season `history_past` must keep winning.
-- Bootstrap is therefore admitted for the **current season only**, where it is the sole source.
--
-- `distinct on` guards the one date this could fan out: when 2026-27 ends it gains
-- `history_past` rows while `current_season` still names it, so both sources qualify for the
-- same (season, player_code) and every join downstream would double. The ordering prefers
-- `history_past`, so that day resolves to the right row instead of two.
--
-- Preseason stays correct without a special case: `player_season_totals.season` is the season
-- the numbers DESCRIBE (`config.aggregates_season`), so before GW1 the bootstrap rows are filed
-- under the previous season and the `current_season` clause admits nothing that exists.
--
-- The 450-minute floor is deliberately untouched. A per-90 off 180 minutes is noise, and the
-- decision on 2026-09-01 was to let the rates arrive when the minutes do. This migration
-- restores the columns that never needed a floor — minutes, totals, points, goals — so
-- `has_reliable_sample` now reads false because a player has 180 minutes rather than because he
-- has none. `captain_picks` and `target_players` therefore stay empty until the floor is
-- genuinely met, which is the intended behaviour and not this migration's business.
-- ---------------------------------------------------------------------------

-- `create or replace`, against the drop-and-create convention in CLAUDE.md and for a much
-- stronger reason than 0038 had: `player_stats_season` sits at the root of **about forty views
-- across nine levels** of dependency — player_scout, captain_picks, player_wide, every
-- `*_check`, the lot. A cascade would drop all of them and this migration would have to
-- reconstruct the entire tree. The 32 output columns and their types are unchanged, which is
-- what makes replace legal here; only the `where` and a `distinct on` differ.
create or replace view player_stats_season as
select distinct on (t.season, t.player_code)
  t.season,
  t.player_code,
  t.minutes,
  t.starts,
  t.total_points,
  t.goals_scored,
  t.assists,
  t.clean_sheets,
  t.goals_conceded,
  t.saves,
  t.bonus,
  t.bps,
  t.yellow_cards,
  t.red_cards,
  t.expected_goals,
  t.expected_assists,
  t.expected_goal_involvements,
  t.expected_goals_conceded,
  t.defensive_contribution,
  t.clearances_blocks_interceptions,
  t.recoveries,
  t.tackles,
  (t.minutes >= 450)                                                as has_reliable_sample,
  case when t.minutes >= 450
       then round(t.expected_goals * 90.0 / t.minutes, 3) end       as xg_per_90,
  case when t.minutes >= 450
       then round(t.expected_assists * 90.0 / t.minutes, 3) end     as xa_per_90,
  case when t.minutes >= 450
       then round(t.expected_goal_involvements * 90.0 / t.minutes, 3) end
                                                                    as xgi_per_90,
  case when t.minutes >= 450
       then round(t.expected_goals_conceded * 90.0 / t.minutes, 3) end
                                                                    as xgc_per_90,
  case when t.minutes >= 450
       then round(t.total_points * 90.0 / t.minutes, 2) end          as points_per_90,
  case when t.minutes >= 450
       then round(t.defensive_contribution * 90.0 / t.minutes, 2) end
                                                                    as defcon_per_90,
  case when t.minutes >= 450
       then round(t.bps * 90.0 / t.minutes, 2) end                   as bps_per_90,
  round(t.goals_scored - t.expected_goals, 2)                        as goals_minus_xg,
  round(t.assists - t.expected_assists, 2)                           as assists_minus_xa
from player_season_totals t
where t.source = 'history_past'
   -- Name the column. A bare `season` here would resolve as an outer reference to `t.season`
   -- and silently become a tautology — see CLAUDE.md.
   or (t.source = 'bootstrap'
       and t.season = (select current_season from season_context))
order by t.season, t.player_code,
         case t.source when 'history_past' then 0 else 1 end;
