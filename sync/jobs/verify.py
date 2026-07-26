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
