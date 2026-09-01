-- ---------------------------------------------------------------------------
-- 0040 — the reliability floor becomes a setting, and drops to 120 for September
-- ---------------------------------------------------------------------------
-- 450 minutes — five full matches — is the right floor for a settled season and the wrong one
-- for GW3. After two gameweeks the maximum possible is 180, so `has_reliable_sample` was false
-- for all 626 players and `captain_picks`, `target_players` and `hidden_gems` returned nothing.
-- Empty is defensible; it is also useless in the weeks a manager is deciding most.
--
-- 120 minutes is the floor until further notice. **This is a deliberate trade, not a fix**: a
-- per-90 off 120 minutes is a volatile number and the screens will recommend some players on
-- less evidence than they would in November. The floor goes back up by intent, which is why it
-- is a row in a table rather than a constant in a view:
--
--     update analysis_settings set min_minutes_for_rates = 450;
--
-- One statement, no migration, and every view follows immediately. `python -m sync.cli verify`
-- prints the current value so a temporary setting cannot quietly become permanent.
--
-- WHY ONE FLOOR REACHES ALL THREE VIEWS. Only `player_stats_season` needed changing.
-- `has_reliable_sample` is defined here, and everything downstream keys on it:
-- `player_scout` gates every percentile on `case when b.has_reliable_sample then percent_rank()
-- ... end`, `output_percentile` is built from those percentiles, `value_percentile` ranks
-- `points_per_million` (which has no floor of its own), and `minutes_rank` is a plain
-- `cume_dist` over `minutes_share`. So `target_score` and `gem_score` stop being NULL the
-- moment this boolean turns true. `captain_picks` gates on `has_reliable_sample` *and*
-- `coalesce(xgi_per_90, 0) > 0` — and `xgi_per_90` is NULL below the floor, which is why
-- lowering only the row filter would have changed nothing.
--
-- WHAT DELIBERATELY DOES NOT MOVE:
--   - `player_scout.is_cold_start` keeps its 450. Every player newly admitted here is between
--     120 and 450 minutes and therefore still renders with the cold-start treatment, which
--     labels the thin sample instead of hiding it. That is the whole reason not to unify them.
--   - `xg_chain_per_90`, `xg_buildup_per_90` and `xgi_per_million` in `player_scout` keep 450
--     too. They gate nothing and stay NULL; a stricter floor on an Understat-derived extra is
--     not worth restating a 300-line view for.
--   - `form_players` (0011) requires `has_reliable_sample and minutes >= 900`. That 900 was
--     itself the fix for a rate ranking off too small a sample — Osula on 76 points above
--     Haaland on 239 — and it still binds. Nothing about this migration reopens it.
--   - The `/players` "Finishers" trap in CLAUDE.md (a player on two minutes at npxG/90 3.29)
--     stays shut: 120 still excludes him, the guard simply sits lower.
--
-- Single-row table by the `id boolean primary key check (id)` trick, so a second row cannot be
-- inserted and the scalar subquery downstream can never return more than one value.
--
-- The floor arrives in the view as a one-row `cross join` rather than a function call: an
-- uncorrelated scalar is evaluated once as an InitPlan, where a `stable` function can be called
-- per row. With ~40 views downstream of this one and a documented history of check views taking
-- 40 seconds, that distinction is worth being deliberate about.
-- ---------------------------------------------------------------------------

create table if not exists analysis_settings (
  id                    boolean primary key default true check (id),
  min_minutes_for_rates int         not null default 450,
  updated_at            timestamptz not null default now()
);

insert into analysis_settings (id, min_minutes_for_rates)
values (true, 120)
on conflict (id) do nothing;

-- `create or replace`: this view is the root of about forty views across nine dependency
-- levels, so a cascade would drop the lot. The 32 output columns and their types are unchanged
-- — only the floor moves from a literal to the setting.
create or replace view player_stats_season as
with floor as (select min_minutes_for_rates as m from analysis_settings)
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
  (t.minutes >= f.m)                                                as has_reliable_sample,
  case when t.minutes >= f.m
       then round(t.expected_goals * 90.0 / t.minutes, 3) end       as xg_per_90,
  case when t.minutes >= f.m
       then round(t.expected_assists * 90.0 / t.minutes, 3) end     as xa_per_90,
  case when t.minutes >= f.m
       then round(t.expected_goal_involvements * 90.0 / t.minutes, 3) end
                                                                    as xgi_per_90,
  case when t.minutes >= f.m
       then round(t.expected_goals_conceded * 90.0 / t.minutes, 3) end
                                                                    as xgc_per_90,
  case when t.minutes >= f.m
       then round(t.total_points * 90.0 / t.minutes, 2) end          as points_per_90,
  case when t.minutes >= f.m
       then round(t.defensive_contribution * 90.0 / t.minutes, 2) end
                                                                    as defcon_per_90,
  case when t.minutes >= f.m
       then round(t.bps * 90.0 / t.minutes, 2) end                   as bps_per_90,
  round(t.goals_scored - t.expected_goals, 2)                        as goals_minus_xg,
  round(t.assists - t.expected_assists, 2)                           as assists_minus_xa
from player_season_totals t
cross join floor f
where t.source = 'history_past'
   -- Name the column. A bare `season` here would resolve as an outer reference to `t.season`
   -- and silently become a tautology — see CLAUDE.md. 0039 has the reasoning.
   or (t.source = 'bootstrap'
       and t.season = (select current_season from season_context))
order by t.season, t.player_code,
         case t.source when 'history_past' then 0 else 1 end;
