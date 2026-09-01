"""Post-sync verification: did the data land, and does it look right?

A green workflow only proves the process exited 0. This checks the things that can be
silently wrong instead — season attribution, unresolved team references, snapshot
insert-on-change behaviour, and growth against Supabase's 500 MB free tier.

    python -m sync.cli verify
"""

from __future__ import annotations

from typing import Any

from .. import db
from ..fpl import FplClient

COUNTS = (
    "seasons", "teams", "team_seasons", "players", "player_seasons",
    "events", "fixtures", "player_season_totals", "player_gw_stats",
    "player_snapshots", "player_price_events", "sync_runs",
    # Tier 2 enrichment
    "understat_team_match", "understat_shots", "understat_player_season",
    "club_elo", "match_odds", "market_odds", "core_insights_player_match",
    "player_external_ids", "unmatched_names",
)


def _fmt(rows: list[dict], indent: str = "    ") -> str:
    if not rows:
        return f"{indent}(none)"
    cols = list(rows[0].keys())
    widths = {c: max(len(c), *(len(str(r[c])) for r in rows)) for c in cols}
    head = indent + "  ".join(c.ljust(widths[c]) for c in cols)
    rule = indent + "  ".join("-" * widths[c] for c in cols)
    body = [indent + "  ".join(str(r[c]).ljust(widths[c]) for c in cols) for r in rows]
    return "\n".join([head, rule, *body])


def run(
    client: FplClient | None = None,
    *,
    dry_run: bool = False,
    reap_stale: bool = False,
) -> dict[str, Any]:
    problems: list[str] = []

    with db.connect() as conn:
        if reap_stale:
            with conn.cursor() as cur:
                cur.execute("""
                    update sync_runs
                    set status = 'error', finished_at = now(),
                        error = 'reaped: process died without recording an outcome'
                    where status = 'running' and started_at < now() - interval '30 minutes'
                """)
                reaped = cur.rowcount
            conn.commit()
            print(f"\nreaped {reaped} stale 'running' row(s)")

        print("\n=== row counts ===")
        counts = {}
        for table in COUNTS:
            counts[table] = db.fetch(conn, f"select count(*) as n from {table}")[0]["n"]
        print(_fmt([{"table": t, "rows": n} for t, n in counts.items()]))

        for table in ("teams", "players", "fixtures", "events"):
            if counts[table] == 0:
                problems.append(f"{table} is empty — the sync did not write dimensions")
        if counts["teams"] and counts["teams"] != 20:
            problems.append(f"expected 20 teams, found {counts['teams']}")
        if counts["fixtures"] and counts["fixtures"] != 380:
            problems.append(f"expected 380 fixtures, found {counts['fixtures']}")

        print("\n=== sync freshness ===")
        print(_fmt(db.fetch(conn, "select * from sync_freshness order by job")))

        print("\n=== recent runs ===")
        print(_fmt(db.fetch(conn, """
            select job, status, rows_touched,
                   to_char(started_at, 'MM-DD HH24:MI') as started,
                   coalesce(round(extract(epoch from finished_at - started_at))::text, '-') as secs
            from sync_runs order by started_at desc limit 8
        """)))

        # Flag a job whose *latest* run failed, not every failure ever recorded. Counting
        # historical errors makes verify permanently red once anything has ever broken,
        # which trains you to ignore it — and a resolved failure is not a current problem.
        broken = db.fetch(conn, """
            select distinct on (job) job, status,
                   to_char(started_at, 'MM-DD HH24:MI') as started, left(error, 120) as err
            from sync_runs order by job, started_at desc
        """)
        for row in broken:
            if row["status"] == "error":
                problems.append(f"{row['job']}: latest run failed ({row['started']}) "
                                f"— {row['err']}")
            elif row["status"] == "running":
                problems.append(f"{row['job']}: latest run still 'running' "
                                f"({row['started']})")

        healed = db.fetch(conn, """
            select count(*) as n from sync_runs
            where status = 'error' and started_at > now() - interval '7 days'
        """)
        if healed[0]["n"]:
            print(f"\n    note: {healed[0]['n']} failed run(s) in the last 7 days, "
                  f"all since recovered")

        # Rows stuck on 'running' mean a process died without recording why. They are
        # invisible to sync_freshness (which only reads 'ok' and 'error'), so they need
        # their own check — this is the hole that hid the aborted-transaction bug.
        stale = db.fetch(conn, """
            select id, job, to_char(started_at, 'MM-DD HH24:MI') as started,
                   round(extract(epoch from now() - started_at) / 60) as age_min
            from sync_runs
            where status = 'running' and started_at < now() - interval '30 minutes'
            order by id
        """)
        if stale:
            print("\n=== stale 'running' rows (process died without recording an error) ===")
            print(_fmt(stale))
            problems.append(
                f"{len(stale)} sync_runs rows stuck on 'running' — reap with: "
                f"python -m sync.cli verify --reap-stale"
            )

        # Season attribution — the preseason carry-over trap. Aggregates from the
        # bootstrap payload must be filed under the season they DESCRIBE.
        print("\n=== player_season_totals by season/source ===")
        print(_fmt(db.fetch(conn, """
            select season, source, count(*) as players,
                   sum(minutes) as minutes, round(sum(expected_goals), 1) as xg
            from player_season_totals
            group by season, source order by season desc, source
        """)))

        # This assertion is **preseason-only**, and leaving it ungated turned it into a
        # permanent failure the moment GW1 kicked off: 358 rows on 2026-08-31, 364 the next
        # morning, climbing with every fixture played. Before GW1 a bootstrap aggregate
        # describes the PREVIOUS season, so minutes on a current-season row mean
        # `config.aggregates_season` was bypassed. After GW1 those same rows carry this
        # season's minutes and are simply correct — there is nothing left to assert.
        #
        # Mirrors `config.is_preseason`: no event `is_current` AND none `finished`, so one
        # flag quirk cannot flip it alone. The count is printed either way, because a check
        # that disappears silently is indistinguishable from one that never ran.
        current = db.fetch(conn, "select name from seasons where is_current order by name desc limit 1")
        if current:
            season = current[0]["name"]
            bad = db.fetch(conn, """
                select count(*) as n from player_season_totals
                where season = %s and source = 'bootstrap' and coalesce(minutes, 0) > 0
            """, (season,))
            # Season-scoped on purpose. Unscoped, the day 2025-26 is loaded its finished
            # events would pin `preseason` to false forever — and the naming of the column
            # has to be explicit here for the reason at the top of CLAUDE.md.
            pre = db.fetch(conn, """
                select not exists (select 1 from events e
                                    where e.season = %s and e.is_current)
                   and not exists (select 1 from events e
                                    where e.season = %s and e.finished) as preseason
            """, (season, season))
            preseason = bool(pre and pre[0]["preseason"])
            print(f"\n=== bootstrap rows with minutes under {season}: {bad[0]['n']} "
                  f"({'asserted, preseason' if preseason else 'expected, season is live'}) ===")
            if preseason and bad[0]["n"]:
                problems.append(
                    f"{bad[0]['n']} bootstrap rows filed under the current season "
                    f"({season}) already have minutes — preseason carry-over may be "
                    f"misattributed"
                )

        print("\n=== unresolved references (nullable by design) ===")
        print(_fmt(db.fetch(conn, """
            select 'player_seasons.team_code' as ref,
                   count(*) filter (where team_code is null) as nulls, count(*) as total
            from player_seasons
            union all
            select 'fixtures.team_h_code',
                   count(*) filter (where team_h_code is null), count(*) from fixtures
            union all
            select 'fixtures.event (unscheduled)',
                   count(*) filter (where event is null), count(*) from fixtures
        """)))

        # Snapshot behaviour: insert-on-change means later captures should touch far
        # fewer than the full 558 rows. A flat 558 every time means the comparison
        # isn't working and the free tier will fill up.
        print("\n=== snapshots per capture instant (most recent 8) ===")
        print(_fmt(db.fetch(conn, """
            select to_char(captured_at, 'MM-DD HH24:MI') as captured_at,
                   count(*) as rows_written
            from player_snapshots
            group by captured_at order by captured_at desc limit 8
        """)))

        # ---- Tier 2 enrichment sanity ------------------------------------------ #
        # Row counts prove a job ran; these prove the numbers mean something.

        if counts["understat_team_match"]:
            print("\n=== Understat team-match coverage + PPDA sanity ===")
            print(_fmt(db.fetch(conn, """
                select season,
                       count(*) as team_rows,
                       count(distinct game_id) as matches,
                       count(*) filter (where team_code is null) as unresolved_teams,
                       round(min(ppda), 1) as ppda_min,
                       round(avg(ppda), 1) as ppda_avg,
                       round(max(ppda), 1) as ppda_max
                from understat_team_match group by season order by season desc
            """)))
            # PPDA is passes allowed per defensive action; real values sit roughly 4-30.
            # Anything outside that means a column got mixed up somewhere upstream.
            odd = db.fetch(conn, """
                select count(*) as n from understat_team_match
                where ppda is not null and (ppda <= 0 or ppda > 100)
            """)
            if odd[0]["n"]:
                problems.append(f"{odd[0]['n']} understat_team_match rows have "
                                f"implausible PPDA (<=0 or >100)")

            # Each match must yield exactly two team rows; anything else means the
            # home/away split dropped or duplicated a side.
            lopsided = db.fetch(conn, """
                select count(*) as n from (
                  select game_id from understat_team_match
                  group by season, game_id having count(*) <> 2
                ) t
            """)
            if lopsided[0]["n"]:
                problems.append(f"{lopsided[0]['n']} Understat matches do not have "
                                f"exactly 2 team rows")

        if counts["match_odds"]:
            print("\n=== Odds: de-vigged probabilities ===")
            print(_fmt(db.fetch(conn, """
                select season, count(*) as matches,
                       count(*) filter (where p_home is not null) as with_1x2,
                       count(*) filter (where p_over_25 is not null) as with_ou25,
                       count(*) filter (where home_team_code is null
                                          or away_team_code is null) as unresolved_side
                from match_odds group by season order by season desc
            """)))
            # De-vigging normalises to 1 by construction, so a drift here means the
            # arithmetic broke rather than the market being unusual.
            bad = db.fetch(conn, """
                select count(*) as n from match_odds
                where p_home is not null
                  and abs((p_home + p_draw + p_away) - 1) > 0.001
            """)
            if bad[0]["n"]:
                problems.append(f"{bad[0]['n']} match_odds rows where de-vigged 1X2 "
                                f"probabilities don't sum to 1")

        if counts["club_elo"]:
            print("\n=== ClubElo ===")
            print(_fmt(db.fetch(conn, """
                select count(distinct club) as clubs, count(*) as rows,
                       count(*) filter (where team_code is null) as unresolved,
                       min(valid_from) as earliest, max(valid_from) as latest
                from club_elo
            """)))
            # 20 clubs are fetched by name; a short count means a silent partial fetch,
            # which is exactly what a space in the URL caused once.
            clubs = db.fetch(conn, "select count(distinct club) as n from club_elo")
            if clubs[0]["n"] < 20:
                problems.append(f"club_elo has only {clubs[0]['n']} distinct clubs, "
                                f"expected 20 — likely a silent partial fetch")

        if counts["core_insights_player_match"]:
            print("\n=== FPL-Core-Insights per-match ===")
            print(_fmt(db.fetch(conn, """
                select season, count(*) as rows,
                       count(distinct player_code) as players,
                       count(distinct event) as gameweeks,
                       count(*) filter (where xg is not null) as with_xg,
                       count(*) filter (where distance_covered is not null) as with_physical
                from core_insights_player_match group by season order by season desc
            """)))

        if counts["player_external_ids"]:
            print("\n=== Identity resolution ===")
            print(_fmt(db.fetch(conn, """
                select source, count(*) as mapped,
                       round(min(confidence), 2) as min_conf,
                       round(avg(confidence), 3) as avg_conf
                from player_external_ids group by source order by source
            """)))
            print(_fmt(db.fetch(conn, """
                select source, kind, season, count(*) as unmatched
                from unmatched_names group by source, kind, season
                order by source, season
            """)))

        # ---- Derived views ----------------------------------------------------- #
        # A view that returns confident nonsense is worse than one that errors, so these
        # check the numbers are football-plausible rather than merely present.

        ctx = db.fetch(conn, "select * from season_context")
        if ctx:
            print("\n=== season_context (drives which season every view reads) ===")
            print(_fmt(ctx))

        scout = db.fetch(conn, """
            select count(*) as players,
                   count(*) filter (where is_cold_start) as cold_start,
                   count(*) filter (where has_reliable_sample) as reliable_sample,
                   count(*) filter (where price is null) as missing_price,
                   count(*) filter (where output_percentile is null) as missing_output
            from player_scout
        """)
        if scout:
            print("\n=== player_scout ===")
            print(_fmt(scout))
            s = scout[0]
            if s["players"] == 0:
                problems.append("player_scout is empty — the scout screen has nothing to read")
            if s["missing_price"]:
                problems.append(f"{s['missing_price']} player_scout rows have no price "
                                f"(no snapshot yet for that player?)")

            # Percentiles are a rank in [0,1] by construction. Anything outside means the
            # window function or an inversion is wrong.
            bad_pct = db.fetch(conn, """
                select count(*) as n from player_scout
                where (xgi_per_90_percentile is not null
                       and (xgi_per_90_percentile < 0 or xgi_per_90_percentile > 1))
                   or (output_percentile < 0 or output_percentile > 1)
                   or (differential_percentile < 0 or differential_percentile > 1)
            """)
            if bad_pct[0]["n"]:
                problems.append(f"{bad_pct[0]['n']} player_scout rows have a percentile "
                                f"outside [0,1]")

            # Goalkeepers score no defensive contribution, so it must not feed their output
            # (migration 0006). If it does, their output no longer equals the xGC percentile.
            gk = db.fetch(conn, """
                select count(*) as n from player_scout
                where element_type = 1 and has_reliable_sample
                  and output_percentile <> coalesce(xgc_per_90_percentile, 0)
            """)
            if gk[0]["n"]:
                problems.append(f"{gk[0]['n']} goalkeepers have output_percentile driven by "
                                f"something other than xGC — DEFCON is leaking back in")

        style = db.fetch(conn, """
            select season, count(*) as teams,
                   round(min(ppda), 2) as ppda_min, round(max(ppda), 2) as ppda_max,
                   count(*) filter (where current_elo is null) as missing_elo
            from team_style group by season order by season desc
        """)
        if style:
            print("\n=== team_style ===")
            print(_fmt(style))

            # Fewer than 20 teams in a past season is correct, not a fault: promoted clubs
            # have no prior Premier League data. 2025/26 holds 17 of the current 20 because
            # Coventry, Hull and Ipswich came up. This is the team-level twin of the player
            # cold-start problem, so report it as coverage rather than flagging it.
            missing = db.fetch(conn, """
                select t.name
                from teams t
                join team_seasons ts on ts.team_code = t.code
                 and ts.season = (select current_season from season_context)
                where not exists (
                  select 1 from team_style s
                  where s.team_code = t.code
                    and s.season = (select stats_season from season_context))
                order by t.name
            """)
            if missing:
                print(f"\n    promoted / no prior-season style data "
                      f"({len(missing)} of 20): "
                      f"{', '.join(m['name'] for m in missing)}")
                print("    -> team profiles need a cold-start path for these")

            # Once the season is under way, every current team must be present.
            started = ctx and ctx[0]["season_started"]
            if started:
                current_rows = next(
                    (r for r in style if r["season"] == ctx[0]["stats_season"]), None)
                if current_rows and current_rows["teams"] != 20:
                    problems.append(
                        f"team_style {current_rows['season']} has "
                        f"{current_rows['teams']} teams mid-season, expected 20")

        odds_view = db.fetch(conn, """
            select season, count(*) as team_fixtures,
                   round(min(p_clean_sheet), 3) as cs_min,
                   round(max(p_clean_sheet), 3) as cs_max,
                   round(avg(expected_goals_for), 3) as avg_xg_for
            from fixture_odds group by season order by season desc
        """)
        if odds_view:
            print("\n=== fixture_odds (Poisson clean-sheet model) ===")
            print(_fmt(odds_view))
            # A probability outside [0,1], or an implausible goal expectation, means the
            # Poisson approximation has drifted.
            bad_cs = db.fetch(conn, """
                select count(*) as n from fixture_odds
                where p_clean_sheet is not null
                  and (p_clean_sheet <= 0 or p_clean_sheet >= 1
                       or expected_goals_for < 0 or expected_goals_for > 6)
            """)
            if bad_cs[0]["n"]:
                problems.append(f"{bad_cs[0]['n']} fixture_odds rows have an implausible "
                                f"clean-sheet probability or expected goals")

        # The Elo fixture model. Its constants are fitted offline by
        # scripts/probe/calibrate_elo_fixtures.py, so nothing in the sync can notice if the
        # view's arithmetic drifts — these invariants are the only guard.
        fd = db.fetch(conn, "select * from fixture_difficulty_check")
        if fd:
            print("\n=== fixture_difficulty (Elo model, calibrated to market odds) ===")
            print(_fmt(fd))
            f = fd[0]
            for flag, message in (
                ("probabilities_sum_to_1", "1X2 probabilities don't sum to 1"),
                ("difficulty_in_range", "difficulty outside [0,1]"),
                ("position_difficulty_in_range", "attack/defence difficulty outside [0,1]"),
                ("clean_sheet_in_range", "clean-sheet probability outside [0,1]"),
                ("home_advantage_present", "home sides are not favoured — an Elo sign is wrong"),
                ("run_rate_matches_total",
                 "fixture_run's per-fixture rate x fixtures does not reconstruct the total"),
                ("elo_is_not_future_dated",
                 "elo_now is reading a forward-dated ClubElo row instead of today's rating"),
            ):
                if f[flag] is False:
                    problems.append(f"fixture_difficulty: {message}")
            if f["teams"] and f["teams"] != 20:
                problems.append(f"fixture_difficulty covers {f['teams']} teams, expected 20 "
                                f"— a club has no Elo rating")
            # Not a fault. Mid-gameweek some clubs have played and some haven't, so their
            # windows hold different numbers of fixtures — that is exactly why the per-fixture
            # rates exist. Report it so the state is visible rather than surprising.
            if (f["distinct_window_sizes"] or 0) > 1:
                print(f"\n    note: teams have {f['distinct_window_sizes']} different window "
                      f"sizes in the ticker — normal mid-gameweek; compare on the "
                      f"per-fixture rates, not the totals")
            # The goal model was fitted to a league mean of 1.373 goals per side. Drifting far
            # from that means the Elo join is picking up the wrong ratings.
            if f["avg_expected_goals"] is not None and not (
                    1.1 <= float(f["avg_expected_goals"]) <= 1.7):
                problems.append(f"fixture_difficulty averages "
                                f"{f['avg_expected_goals']} expected goals per side, "
                                f"outside the plausible 1.1-1.7")

        cap = db.fetch(conn, "select * from captain_check")
        if cap:
            print("\n=== captain_picks (floor / ceiling, rank-aggregated) ===")
            print(_fmt(cap))
            c = cap[0]
            for flag, message in (
                ("floor_in_range", "floor_score outside [0,1]"),
                ("ceiling_in_range", "ceiling_score outside [0,1]"),
                ("scoring_probs_in_range", "a team-scoring probability outside [0,1]"),
                ("tail_ordered", "P(2+ goals) exceeds P(1+) — the Poisson tail is inverted"),
                # The whole point of the repair in sync/sources/understat_raw.py. If this goes
                # false, non-penalty xG is silently counting penalties again.
                ("shot_attributes_repaired",
                 "understat_shots has NULL situation or body_part — soccerdata's dropped enum "
                 "values are no longer being repaired"),
            ):
                if c[flag] is False:
                    problems.append(f"captain_picks: {message}")
            # Two axes that rank identically are one axis with extra steps.
            corr = c["floor_ceiling_corr"]
            if corr is not None and float(corr) > 0.95:
                problems.append(f"captain_picks: floor and ceiling correlate at {corr} — the "
                                f"two-axis split has stopped distinguishing anything")

        mv = db.fetch(conn, "select * from movement_check")
        if mv:
            print("\n=== player_movement (our own snapshot series) ===")
            print(_fmt(mv))
            m = mv[0]
            # The invariant that matters: a window we have no history for must read null, not
            # zero. Zero would tell the user "this player is stable" when the truth is "we have
            # not been watching long enough to know".
            if m["no_history_means_null"] is False:
                problems.append("player_movement reports a delta for players with no history "
                                "for that window — a missing window must be null, not 0")
            if m["one_row_per_player"] is False:
                problems.append("player_movement has more than one row for some player")
            # Snapshot liveness reads from sync_runs, not from the last row written: the table
            # is insert-on-change, so a healthy hourly job writes nothing while prices are
            # frozen. 150 minutes is one missed hourly tick plus slack.
            since = m["minutes_since_last_run"]
            if since is None:
                problems.append("no successful snapshot run recorded — the one series that "
                                "cannot be backfilled is not being captured")
            elif since > 150:
                problems.append(f"last successful snapshot run was {int(since)} minutes ago, "
                                f"expected hourly — lost time series cannot be recovered")

        # ---------------------------------------------------------------------
        # The clock itself (migration 0019)
        # ---------------------------------------------------------------------
        # The check above catches "no runs happened". This one catches *why*, which is the
        # part that used to take a morning to work out. A revoked or expired PAT produces a
        # 401 here hours before the snapshot gap grows big enough to notice, and the two
        # failures are indistinguishable from the sync_runs side: both look like silence.
        dsp = db.fetch(conn, "select * from workflow_dispatch_health")
        if dsp:
            print("\n=== pg_cron -> workflow_dispatch (the hourly clock) ===")
            print(_fmt(dsp))
            for d in dsp:
                if d["failed_24h"]:
                    problems.append(
                        f"{d['workflow']}: {d['failed_24h']} of {d['dispatches_24h']} dispatches "
                        f"failed in 24h — {d['last_error']}"
                    )
                # Pending means pg_net accepted the request and no response came back. A few
                # in flight is normal; a pile is pg_net's worker not running.
                if d["pending"] and d["pending"] > 2:
                    problems.append(
                        f"{d['workflow']}: {d['pending']} dispatches never got a response — "
                        f"pg_net's background worker may be stopped"
                    )
                # Cadence is per workflow, and one hourly threshold for all of them failed
                # `sync-daily` every Monday-to-Thursday morning: market-odds is
                # `23 */2 * * *` — two-hourly — with the extra hourly job only on Friday,
                # Saturday and Sunday (`53 * * * 5,6,0`). So a 101-minute gap on a Tuesday
                # was the schedule working exactly as written. Keep this table in step with
                # `cron.schedule` in migrations 0019 and 0024; an unlisted workflow falls back
                # to hourly, which is the tighter assumption and so fails loudly rather than
                # quietly.
                max_gap = {
                    "sync-snapshot.yml": 90,       # hourly at :17, plus the price window
                    "sync-market-odds.yml": 150,   # two-hourly at :23 outside Fri-Sun
                }.get(d["workflow"], 90)
                gap = d["minutes_since_last"]
                if gap is not None and gap > max_gap:
                    problems.append(
                        f"{d['workflow']}: last dispatch {int(gap)} minutes ago, expected "
                        f"within {max_gap} — check `select * from cron.job` is still active"
                    )
        else:
            # An empty view means no dispatch in 24 hours at all, which is the pg_cron
            # equivalent of the job being unscheduled. Only worth flagging once the mechanism
            # exists — before 0019 is applied the view is absent and db.fetch returns nothing,
            # which is why this is a warning line rather than a problem.
            print("\n=== pg_cron -> workflow_dispatch ===\n    no dispatches in 24h "
                  "(migration 0019 not applied, or cron.job inactive)")

        # Actions minutes are the constraint that stops everything at once, and the REST API
        # will not report them without a user-scoped token. Dispatch count is the half we
        # control, so it is the half we measure.
        load = db.fetch(conn, "select * from workflow_dispatch_load")
        if load and load[0]["dispatches_7d"]:
            print("\n=== estimated Actions load ===")
            print(_fmt(load))
            est = load[0]["est_minutes_month"]
            # 2000 is the free-plan allowance for a private repo; the other workflows add
            # roughly 400. Flag at 1600 so there is time to thin the daytime cadence.
            if est is not None and int(est) > 1600:
                problems.append(
                    f"snapshot dispatches alone project {int(est)} Actions minutes/month "
                    f"against a 2000 free-tier ceiling — thin the daytime cron in cron.job"
                )

        tgt = db.fetch(conn, "select * from target_check")
        if tgt:
            print("\n=== target_players / hidden_gems (fixture-aware) ===")
            print(_fmt(tgt))
            t = tgt[0]
            for flag, message in (
                # 0013's fault, now asserted on both surfaces. A recommendation to buy someone
                # who cannot play is worse than an empty panel.
                ("all_targets_available", "target_players recommends an unavailable player"),
                ("all_gems_available", "hidden_gems recommends an unavailable player"),
                ("fixture_rank_in_range", "a fixture rank outside [0,1]"),
                ("score_in_range", "a target score outside [0,1]"),
                # The position split is the point of 0014. If it stops holding, every keeper is
                # being ranked on how many goals his own side is expected to score.
                ("keepers_on_clean_sheets",
                 "a keeper or defender is being ranked on expected goals for, not clean sheets"),
                ("attackers_on_goals",
                 "a midfielder or forward is being ranked on clean sheets, not goals"),
                ("opponent_rank_sane", "an opponent league rank outside 1..20 — the join is wrong"),
                # A club playing this gameweek must have a rank; a club blanking must not. Both
                # directions matter: the first would silently zero a good fixture, the second
                # would print a 0 that reads as "hard fixture" when the truth is "no fixture".
                ("ranked_when_playing", "a player with a fixture has no fixture rank"),
                ("null_when_blank", "a blanking player has a fixture rank"),
            ):
                # `is False` only: bool_and over an empty set is NULL, which is what happens
                # when nobody blanks. Absence of the case is not failure of the check.
                if t[flag] is False:
                    problems.append(f"target_players: {message}")
            # If the fixture correlates almost perfectly with output, it is not adding
            # information and the extra component is just noise dressed as rigour.
            corr = t["output_fixture_corr"]
            if corr is not None and abs(float(corr)) > 0.9:
                problems.append(f"target_players: fixture rank correlates with output at "
                                f"{corr} — the fixture axis is not adding information")

        pctl = db.fetch(conn, "select * from percentile_check")
        if pctl:
            print("\n=== player_metric_percentile (context for every rate) ===")
            print(_fmt(pctl))
            q = pctl[0]
            for flag, message in (
                ("percentile_in_range", "a percentile outside (0,1]"),
                ("rank_in_pool", "a rank outside its own pool"),
                # Direction is declared twice: here and as `direction` in lib/columns.ts. If
                # either inverts, the page tells the reader the leakiest defence in the league
                # is the tightest, and both halves look self-consistent.
                ("lower_better_ranked_right",
                 "a lower-is-better metric ranks its worst value first"),
                ("higher_better_ranked_right",
                 "a higher-is-better metric ranks its worst value first"),
            ):
                if q[flag] is False:
                    problems.append(f"player_metric_percentile: {message}")
            # The tie trap, in both directions. cume_dist put 22 goalkeepers tied on 0.000
            # xG/90 at the 96th percentile for scoring; percent_rank does the mirror image to
            # a group tied at the top. Mid-rank fixes both, and this is how a regression
            # announces itself rather than quietly flattering everybody.
            if q["tie_inflated_metrics"]:
                problems.append(
                    f"player_metric_percentile: {q['tie_inflated_metrics']} metric/position "
                    f"pairs put over 30% of their pool in the top 10% — ties are inflating "
                    f"percentiles again")

        # Check views verified wholesale: every boolean must be true, whatever it is called.
        # The named blocks above explain *why* a specific flag matters and stay as they are;
        # this catches the rest, and catches a newly added boolean without an edit here.
        #
        # NULL is reported rather than failed, deliberately. `bool_and` over zero rows is NULL
        # and reads as a pass in a table of booleans, so it must be visible — but some are
        # legitimately empty until the season starts (`trend_check` has one by design, with its
        # row count published beside it), and failing on those would make `verify` red for a
        # month for no reason.
        # The four added in 0034-0037 are all-NULL until 2026-08-21 and that is correct: no squad,
        # no standings, no logged recommendation and no scored gameweek exists before the first
        # deadline. Each publishes a row count beside its booleans so "asserts nothing" is
        # visible rather than reading as a pass.
        for view in ("market_odds_check", "fixture_percentage_check",
                     "position_price_value_check", "form_check",
                     "rotation_pairs_check", "rotation_risk_check",
                     "gameweek_shape_check", "sell_check",
                     "style_check", "trend_check", "gem_score_check",
                     "my_squad_check", "league_check", "change_check",
                     "recommendation_check"):
            rows = db.fetch(conn, f"select * from {view}")
            if not rows:
                problems.append(f"{view}: returned no rows at all")
                continue
            q = rows[0]
            false_flags = [k for k, v in q.items() if v is False]
            null_flags = [k for k, v in q.items() if v is None]
            if false_flags:
                problems.append(f"{view}: false — {', '.join(false_flags)}")
            print(f"\n=== {view} ===")
            print(f"    {len(q)} columns, {len(false_flags)} false, {len(null_flags)} null")
            if null_flags:
                print(f"    null (asserts nothing — confirm the row count beside it): "
                      f"{', '.join(null_flags)}")

        gems = db.fetch(conn, """
            select position, count(*) as n, round(avg(gem_score), 3) as avg_score,
                   round(max(gem_score), 3) as best,
                   count(*) filter (where fixture_count = 0) as blanking
            from hidden_gems group by position order by position
        """)
        if gems:
            print("\n=== hidden_gems by position ===")
            print(_fmt(gems))

        print("\n=== storage (Supabase free tier = 500 MB) ===")
        print(_fmt(db.fetch(conn, """
            select relname as table,
                   pg_size_pretty(pg_total_relation_size(c.oid)) as size,
                   pg_total_relation_size(c.oid) as bytes
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
            order by pg_total_relation_size(c.oid) desc limit 8
        """)))
        total = db.fetch(conn, """
            select pg_size_pretty(sum(pg_total_relation_size(c.oid))) as total
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
        """)
        print(f"    total: {total[0]['total']}")

    print("\n=== verdict ===")
    if problems:
        for p in problems:
            print(f"    PROBLEM  {p}")
    else:
        print("    all checks passed")

    return {"counts": counts, "problems": problems}
