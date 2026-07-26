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

        errors = db.fetch(conn, "select count(*) as n from sync_runs where status = 'error'")
        if errors[0]["n"]:
            problems.append(f"{errors[0]['n']} sync_runs rows have status='error'")

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
