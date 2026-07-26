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
    "club_elo", "match_odds", "core_insights_player_match",
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

        current = db.fetch(conn, "select name from seasons where is_current order by name desc limit 1")
        if current:
            season = current[0]["name"]
            bad = db.fetch(conn, """
                select count(*) as n from player_season_totals
                where season = %s and source = 'bootstrap' and coalesce(minutes, 0) > 0
            """, (season,))
            if bad[0]["n"]:
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

        gems = db.fetch(conn, """
            select position, count(*) as n, round(avg(gem_score), 3) as avg_score,
                   round(max(gem_score), 3) as best
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
