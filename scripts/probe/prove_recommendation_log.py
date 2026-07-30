"""Exercise the recommendation log's write path without waiting for a deadline.

    python scripts/probe/prove_recommendation_log.py      # needs DATABASE_URL

`sync/jobs/recommendations.py` writes in a six-hour window before a deadline and refuses
otherwise, which means on 2026-07-30 it runs exactly zero of its interesting lines — the next
deadline is 538 hours away. That is the `FIX_WHEN_LIVE` trap in its purest form: a code path
whose first real execution is the one moment it must not fail.

So this simulates the write against a sentinel season and deletes it afterwards. It has already
earned itself twice:

  - the first version of `basis` stored raw `Decimal` values, which `json.dumps` refuses. That
    would have failed at 17:30 on 21 August and nowhere else.
  - **`db.insert_ignore` and `db.upsert` call `conn.commit()` themselves.** So the
    "simulate inside a rolled-back transaction" technique in CLAUDE.md does *not* work through
    those helpers — the first draft of this probe rolled back at the end and had already written
    44 rows to the real database. Anything simulated through them must be cleaned up explicitly,
    which is what `SEASON` being a sentinel and the `finally` below are for.

Asserts four things:
  1. the window opens and closes where it should — no database needed
  2. every source query runs, serialises and inserts
  3. the log is immutable — a second write cannot restate a row
  4. ranks are contiguous and unique within each kind
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import psycopg  # noqa: E402
from psycopg.rows import dict_row  # noqa: E402

from sync import config, db  # noqa: E402
from sync.jobs.recommendations import SOURCES, _jsonable, _window  # noqa: E402

SEASON, EVENT = "9999-00", 99  # a season that cannot collide with real data


def main() -> int:
    config.load_dotenv()
    failures = 0

    # --- the window, which needs no database ------------------------------------------
    deadline = datetime(2026, 8, 21, 17, 30, tzinfo=timezone.utc)
    cases = [
        ("7h before", deadline - timedelta(hours=7), False),
        ("6h before, exactly", deadline - timedelta(hours=6), True),
        ("3h before", deadline - timedelta(hours=3), True),
        ("5 min after", deadline + timedelta(minutes=5), True),
        ("1h after", deadline + timedelta(hours=1), False),
        ("no deadline", deadline, None),
    ]
    for label, now, expected in cases:
        got, why = _window(None if expected is None else deadline, now)
        want = False if expected is None else expected
        ok = got is want
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'}  window {label:20} -> {got}  ({why})")

    conn = psycopg.connect(config.database_url(), row_factory=dict_row)
    try:
        # --- 1 + 2: every source runs, serialises and inserts --------------------------
        total = 0
        for kind, spec in SOURCES.items():
            rows = db.fetch(conn, spec["sql"], (spec["limit"],))
            if not rows:
                print(f"FAIL  {kind}: source query returned no rows")
                failures += 1
                continue
            payload = []
            for rank, r in enumerate(rows, start=1):
                code = r.pop("player_code")
                payload.append({
                    "season": SEASON, "event": EVENT, "kind": kind,
                    "player_code": code, "rank": rank,
                    "basis": {k: _jsonable(v) for k, v in r.items()},
                })
            n = db.insert_ignore(
                conn, "recommendation_log", payload,
                ("season", "event", "kind", "player_code"))
            total += n
            ok = n == len(payload)
            failures += 0 if ok else 1
            print(f"{'PASS' if ok else 'FAIL'}  {kind:16} {len(payload):3} candidates -> {n} stored")

        # --- 3: immutable ---------------------------------------------------------------
        first = db.fetch(
            conn,
            "select player_code from recommendation_log "
            "where season = %s and kind = 'target' and rank = 1",
            (SEASON,),
        )
        if first:
            code = first[0]["player_code"]
            db.insert_ignore(
                conn, "recommendation_log",
                [{"season": SEASON, "event": EVENT, "kind": "target",
                  "player_code": code, "rank": 99,
                  "basis": {"tampered": True}}],
                ("season", "event", "kind", "player_code"))
            # Read the row back rather than trusting the return value: `insert_ignore` reports
            # rows *attempted*, not rows written, so its count can never prove immutability.
            # That is honest for an append-only table where conflicts are the exception; here
            # the conflict is the entire point, so the assertion has to look at the data.
            after = db.fetch(
                conn,
                "select rank, basis from recommendation_log "
                "where season = %s and event = %s and kind = 'target' and player_code = %s",
                (SEASON, EVENT, code),
            )[0]
            ok = after["rank"] == 1 and "tampered" not in (after["basis"] or {})
            failures += 0 if ok else 1
            print(f"{'PASS' if ok else 'FAIL'}  a second write restates nothing "
                  f"(rank still {after['rank']}, basis untampered "
                  f"{'tampered' not in (after['basis'] or {})})")

        # --- 4: the check view, over the simulated rows only ----------------------------
        # `stamped_in_time` is deliberately excluded: event 99 has no row in `events`, so the
        # join is null and the assertion cannot be made here. It is asserted in production by
        # `verify` against real gameweeks.
        checks = db.fetch(conn, """
            select
              count(*)                              as groups,
              bool_and(picks = distinct_ranks)      as ranks_unique,
              bool_and(first_rank = 1
                       and top_rank = picks)        as ranks_contiguous,
              bool_and(unnamed = 0)                 as players_named
            from (
              select kind, count(*) picks, count(distinct rank) distinct_ranks,
                     min(rank) first_rank, max(rank) top_rank,
                     count(*) filter (where p.code is null) unnamed
              from recommendation_log l
              left join players p on p.code = l.player_code
              where l.season = %s group by kind
            ) g
        """, (SEASON,))[0]
        for key, value in checks.items():
            if key == "groups":
                print(f"      {key} = {value}")
                continue
            failures += 0 if value is True else 1
            print(f"{'PASS' if value is True else 'FAIL'}  {key} = {value}")

        print(f"\n{total} rows simulated")
    finally:
        # Explicit, not a rollback: the helpers above commit. See the module docstring.
        with conn.cursor() as cur:
            cur.execute("delete from recommendation_log where season = %s", (SEASON,))
            print(f"cleaned up {cur.rowcount} simulated rows")
        conn.commit()
        conn.close()

    print(f"\n{failures} failure(s)")
    return failures


if __name__ == "__main__":
    raise SystemExit(main())
