-- ---------------------------------------------------------------------------
-- 0015 — one wide row per player, so a view can be composed rather than coded
-- ---------------------------------------------------------------------------
-- `/scout` and `/gems` are one table with different column sets and different row filters,
-- and building them as two routes meant every new lens needed a new page. Peder's model:
-- a *view* selects columns, a *filter* selects rows, and he wants to compose his own in the
-- app rather than wait for one to be built. (His word "view" means the saved configuration,
-- not a Postgres view — this file is the Postgres view underneath all of them.)
--
-- That only works if the browser already holds everything, otherwise every column the user
-- picks is a round trip. Measured before committing to it, because `/scout`'s 109 KB was
-- measured rather than assumed:
--
--     558 players x 111 columns, row objects   1 343 KB raw   114 KB gzipped
--     the same data, columnar                    320 KB raw    68 KB gzipped
--
-- 114 KB is what `/scout` already ships for a *single* view, so the whole dataset costs
-- nothing extra. Columnar halves it again by writing each column name once instead of 558
-- times, and that is how `getPlayerWide` serialises it.
--
-- WHAT THIS VIEW DOES NOT CONTAIN: percentiles. `player_scout` has them for the metrics that
-- feed a score, and those stay in SQL where `verify` can check them. Shading a cell is a
-- different job: the user may put any column on screen, including ones nobody has thought of
-- yet, so a precomputed percentile per column would mean a migration for every new metric —
-- exactly the friction the column catalogue exists to remove. Ranks for shading are computed
-- in `lib/rank.ts` from the rows already in the browser. The rule in CLAUDE.md still holds
-- where it matters: a number you reason about lives in SQL, a number that only paints a cell
-- does not.
--
-- Two columns are deliberately absent. `avg_distance_prem` and `top_speed_prem` came back
-- 100% null across all 558 players — the physical data was known to be thin at 1.2% coverage
-- and is in fact entirely missing from this view's grain.

drop view if exists player_wide cascade;
create view player_wide as
with heads as (
  -- Headed threat. This is what survives of "aerial ability": FBref's aerial duels went with
  -- the Opta licence in January 2026, but Understat's shot rows carry `body_part`, and for FPL
  -- purposes "does he score with his head" beats "does he win headers" anyway. Only usable at
  -- all because the enum repair in sync/sources/understat_raw.py puts `Head` back — soccerdata
  -- drops it to NaN for 19.6% of shots.
  select player_code,
         count(*)                          as head_shots,
         round(sum(xg)::numeric, 3)        as head_xg,
         count(*) filter (where result = 'Goal') as head_goals
  from understat_shots
  where body_part = 'Head'
  group by player_code
),
corners as (
  -- Club-level corner threat, which is the team context a defender view wants: a centre-back
  -- at a side that generates 17.5 xG from corners is a different proposition from one at a
  -- side that generates 5. Shots from corners, not corners won — Understat records the shot,
  -- not the delivery, and the shot is the part that scores FPL points.
  select team_code,
         count(*)                          as team_corner_shots,
         round(sum(xg)::numeric, 2)        as team_corner_xg,
         count(*) filter (where result = 'Goal') as team_corner_goals
  from understat_shots
  where situation = 'From Corner'
  group by team_code
)
select
  -- identity
  s.player_code, s.web_name, s.first_name, s.second_name, s.age,
  s.position, s.element_type, s.team_code, s.team_short, s.team_name,

  -- availability
  s.status, s.news, s.chance_of_playing_next_round as chance_of_playing, s.is_available,
  a.minutes_share, a.start_rate, a.fully_fit,

  -- price and ownership
  s.price, s.cost_change_start, s.cost_change_event, s.price_change_percent,
  s.selected_by_percent, s.transfers_in_event, s.transfers_out_event, s.net_transfers_event,
  s.points_per_million, s.xgi_per_million,

  -- volume and returns
  s.minutes, s.starts, s.total_points, s.goals_scored, s.assists, s.clean_sheets,
  s.goals_conceded, s.saves, s.bonus, s.bps, s.defensive_contribution, s.defcon_threshold,

  -- expected, season totals
  s.expected_goals, s.expected_assists, s.expected_goal_involvements, s.expected_goals_conceded,

  -- rates
  s.xg_per_90, s.xa_per_90, s.xgi_per_90, s.xgc_per_90, s.points_per_90,
  s.defcon_per_90, s.bps_per_90,

  -- finishing and creation quality
  s.goals_minus_xg, s.assists_minus_xa,
  s.understat_xa, s.xg_chain, s.xg_buildup, s.xg_chain_per_90, s.xg_buildup_per_90,

  -- chance quality, from the shot events
  p.shots_per_90, p.shots_in_box_per_90, p.big_chances_per_90, p.non_penalty_xg_per_90,
  -- Zero only where zero is the truth. A player Understat has a record for and who never
  -- headed at goal really did generate no headed xG; a player with no Understat mapping at
  -- all has an *unknown* figure, and coalescing him to 0 would rank him alongside the first
  -- as "no aerial threat". That is DESIGN.md's cardinal error — a 0 standing in for absent —
  -- and the first draft of this view made it.
  case when x.player_code is not null then coalesce(h.head_shots, 0) end as head_shots,
  case when x.player_code is not null then coalesce(h.head_xg, 0) end    as head_xg,
  case when x.player_code is not null then coalesce(h.head_goals, 0) end as head_goals,
  case when x.player_code is not null and coalesce(s.minutes, 0) >= 90
       then round(coalesce(h.head_xg, 0) / (s.minutes / 90.0), 3) end   as head_xg_per_90,

  -- set pieces
  s.penalties_order, s.direct_freekicks_order, s.corners_order,

  -- rotation risk
  s.other_minutes, s.pct_minutes_outside_league,

  -- this gameweek's fixture. Joined from team_fixture_context directly rather than through
  -- player_target_base, which applies its own fit-and-regular filters and would have left the
  -- fixture null for the 312 players it excludes.
  coalesce(f.fixture_count, 0)                                         as fixture_count,
  f.opponents, f.difficulty as fixture_difficulty, f.xg_for as fixture_xg_for,
  f.expected_clean_sheets as fixture_clean_sheets,
  case when s.element_type in (1, 2) then f.defence_fixture_rank
       else f.attack_fixture_rank end                                  as fixture_rank,
  case when s.element_type in (1, 2) then f.opponent_attacking_rank
       else f.opponent_defensive_rank end                              as opponent_rank,

  -- the player's own club, for the team-context columns a view can pull in
  ts.xg_per_match as team_xg_per_match, ts.xga_per_match as team_xga_per_match,
  ts.ppda as team_ppda, ts.deep_completions as team_deep_completions,
  ts.clean_sheet_pct as team_clean_sheet_pct,
  ts.attacking_rank as team_attacking_rank, ts.defensive_rank as team_defensive_rank,
  -- Same rule for the club figures. `team_style` existing is the marker that Understat covered
  -- the club last season; the three promoted sides have no row, and their corner threat is
  -- unknown rather than nil.
  case when ts.team_code is not null then coalesce(c.team_corner_shots, 0) end as team_corner_shots,
  case when ts.team_code is not null then coalesce(c.team_corner_xg, 0) end    as team_corner_xg,
  case when ts.team_code is not null then coalesce(c.team_corner_goals, 0) end as team_corner_goals,

  -- sample flags, so the UI can hatch rather than mislead
  s.has_reliable_sample, s.is_cold_start
from player_scout s
join player_availability a on a.player_code = s.player_code
left join player_shot_profile p on p.player_code = s.player_code
left join heads h on h.player_code = s.player_code
-- Presence here is the answer to "did Understat see this player at all", which is what
-- separates a genuine zero from an unknown above.
left join player_external_ids x
  on x.player_code = s.player_code and x.source = 'understat'
left join team_fixture_context f on f.team_code = s.team_code
left join corners c on c.team_code = s.team_code
left join team_style ts on ts.team_code = s.team_code
 and ts.season = (select stats_season from season_context);

-- ---------------------------------------------------------------------------
-- saved_views — the user's own column sets, written through lib/actions.ts
-- ---------------------------------------------------------------------------
-- Presets live in code, not in here. A preset in a table can only be improved by a migration
-- and drifts out of sync with the column catalogue; a preset in `lib/columns.ts` is checked by
-- the type system against the columns that actually exist.
--
-- No owner column and no auth, consistent with `watchlist` and for the same reason: one user,
-- an unlisted URL, near-zero stakes. If that changes, the fix is a signed cookie checked in
-- the one server action, not a schema change.
create table if not exists saved_views (
  id          bigint generated always as identity primary key,
  name        text        not null,
  -- Column keys from the catalogue in lib/columns.ts. Deliberately not foreign-keyed to
  -- anything: a key that disappears from the catalogue must degrade to "column skipped", not
  -- make the whole saved view unloadable.
  columns     text[]      not null,
  -- {price: {min, max}, position: [...], ...}. jsonb because the filter vocabulary will grow
  -- and a column per filter type would be a migration each time.
  filters     jsonb       not null default '{}'::jsonb,
  sort_key    text,
  sort_desc   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint saved_views_name_not_blank check (length(trim(name)) > 0),
  constraint saved_views_has_columns    check (cardinality(columns) > 0)
);

create unique index if not exists saved_views_name_key on saved_views (lower(trim(name)));

-- ---------------------------------------------------------------------------
-- player_wide_check
-- ---------------------------------------------------------------------------
drop view if exists player_wide_check cascade;
create view player_wide_check as
select
  count(*)                                                        as players,
  -- Must cover every player, unlike the scoring views. A custom view over the whole squad is
  -- the point; silently dropping the unfit or the thin-sample ones would be the old routes
  -- with extra steps.
  (select count(*) from player_scout)                             as scout_players,
  count(*) = (select count(*) from player_scout)                  as covers_everyone,
  count(*) filter (where fixture_count = 0)                       as blanking,
  count(*) filter (where head_shots > 0)                          as with_head_shots,
  count(*) filter (where team_corner_xg > 0)                      as with_team_corners,
  -- Unknown must stay distinguishable from nil. If these ever hit zero, an unmapped player is
  -- being reported as having generated no headed xG rather than as unmeasured.
  count(*) filter (where head_xg is null)                         as head_xg_unknown,
  count(*) filter (where team_corner_xg is null)                  as team_corners_unknown,
  -- Head xG can never exceed total xG: a shot is counted once, and if this trips, the
  -- body_part repair has started double-counting or the join has fanned out.
  bool_and(head_xg <= coalesce(expected_goals, 0) + 0.5)          as head_xg_within_total,
  bool_and(coalesce(head_goals, 0) <= coalesce(goals_scored, 0))  as head_goals_within_total,
  -- One row per player. A fan-out in any of the four left joins would be invisible in the UI
  -- and would silently double every aggregate built on top.
  count(*) = count(distinct player_code)                          as one_row_per_player
from player_wide;
