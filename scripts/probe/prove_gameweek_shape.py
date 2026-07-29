"""Blank and double detection, simulated against the real views. Needs DATABASE_URL.

**Why this is not a pure-Python probe.** 2026/27 currently holds 760 club-gameweeks, every one with
exactly one fixture, so `gameweek_shape`'s blank and double branches are unreachable and
`gameweek_shape_check` can only report that they are empty. A Python reimplementation would test a
copy of the logic. This tests the logic itself: it deletes and duplicates `fixtures` rows **inside a
transaction**, reads the real views, and rolls back — which is exactly what CLAUDE.md prescribes for
a code path the frozen calendar cannot reach.

Nothing is committed. The rollback is in a `finally`, and `dimensions` re-syncs `fixtures` from the
API daily anyway, so even a crash mid-run self-heals.

    python scripts/probe/prove_gameweek_shape.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.stdout.reconfigure(encoding="utf-8")

import psycopg  # noqa: E402

failures: list[str] = []


def check(label: str, got, want) -> None:
    good = got == want
    print(f"  {'ok  ' if good else 'FAIL'} {label}: got {got!r}, want {want!r}")
    if not good:
        failures.append(label)


def one(cur, sql: str, params=()):
    cur.execute(sql, params)
    row = cur.fetchone()
    return row[0] if row else None


url = os.environ.get("DATABASE_URL")
if not url:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
    url = os.environ.get("DATABASE_URL")
if not url:
    print("DATABASE_URL not set — this probe needs the database, like prove_style_claims.py")
    sys.exit(1)

conn = psycopg.connect(url)
try:
    cur = conn.cursor()

    # A gameweek far enough out that it is already flagged provisional, so the simulation does not
    # also have to fight the 56-day boundary.
    gw = one(cur, "select min(event) from gameweek_shape_summary where provisional = 20")
    print(f"\nBaseline — the calendar as scheduled (simulating on GW{gw})")
    check("every club plays once", one(cur, "select single from gameweek_shape_summary where event=%s", (gw,)), 20)
    check("no blanks anywhere", one(cur, "select count(*) from gameweek_shape where shape='blank'"), 0)
    check("no doubles anywhere", one(cur, "select count(*) from gameweek_shape where shape='double'"), 0)
    check("the whole grid is present", one(cur, "select count(*) from gameweek_shape"), 760)

    victim = one(cur, """select team_h_code from fixtures
                          where season=(select current_season from season_context) and event=%s
                          order by fpl_id limit 1""", (gw,))
    fid = one(cur, """select fpl_id from fixtures
                       where season=(select current_season from season_context) and event=%s
                         and team_h_code=%s""", (gw, victim))
    away = one(cur, "select team_a_code from fixtures where fpl_id=%s", (fid,))

    print(f"\nSIMULATED BLANK — removing fixture {fid} from GW{gw}")
    cur.execute("delete from fixtures where fpl_id=%s", (fid,))
    check("two clubs now blank",
          one(cur, "select blanking from gameweek_shape_summary where event=%s", (gw,)), 2)
    check("and they are named",
          one(cur, """select count(*) from gameweek_shape
                       where event=%s and shape='blank' and team_code in (%s,%s)""",
              (gw, victim, away)), 2)
    # The trap: a blank must carry no opponent and no kickoff, or it renders as a fixture that is
    # not being played.
    check("a blank has no opponent",
          one(cur, """select count(*) from gameweek_shape
                       where event=%s and shape='blank' and opponents is not null""", (gw,)), 0)
    check("a blank has no kickoff",
          one(cur, """select count(*) from gameweek_shape
                       where event=%s and shape='blank' and first_kickoff is not null""", (gw,)), 0)
    check("shapes still partition the league",
          one(cur, """select blanking + doubling + single = clubs
                       from gameweek_shape_summary where event=%s""", (gw,)), True)
    check("the grid is still complete", one(cur, "select count(*) from gameweek_shape"), 760)
    check("the sentence says so",
          one(cur, "select shape_word from gameweek_shape_summary where event=%s", (gw,)),
          "2 clubs blank")
    # A blanking club is provisional-flagged only when flat; its shape is now decided.
    check("a blank is not provisional",
          one(cur, """select count(*) from gameweek_shape
                       where event=%s and shape='blank' and is_provisional""", (gw,)), 0)
    conn.rollback()

    print(f"\nSIMULATED DOUBLE — giving two clubs a second fixture in GW{gw}")
    # Reuse a real fixture from a later gameweek so every column stays valid, then move the copy.
    src = one(cur, """select fpl_id from fixtures
                       where season=(select current_season from season_context) and event=%s+1
                       order by fpl_id limit 1""", (gw,))
    cur.execute("""insert into fixtures
                   select season, 900000 + fpl_id, 900000 + code, %s, kickoff_time, started,
                          finished, finished_provisional, minutes, team_h_code, team_a_code,
                          team_h_score, team_a_score, team_h_difficulty, team_a_difficulty,
                          pulse_id, stats, updated_at
                     from fixtures where fpl_id=%s""", (gw, src))
    h = one(cur, "select team_h_code from fixtures where fpl_id=%s", (src,))
    a = one(cur, "select team_a_code from fixtures where fpl_id=%s", (src,))
    check("two clubs now double",
          one(cur, "select doubling from gameweek_shape_summary where event=%s", (gw,)), 2)
    check("each has two fixtures",
          one(cur, """select count(*) from gameweek_shape
                       where event=%s and team_code in (%s,%s) and fixtures=2""", (gw, h, a)), 2)
    # The string aggregation must name both, or the screen shows one opponent for a double.
    check("both opponents are named",
          one(cur, """select count(*) from gameweek_shape
                       where event=%s and shape='double' and opponents like '%%, %%'""", (gw,)), 2)
    # One extra fixture is TWO club-fixtures, one for each side — 20 becomes 22, not 24. The
    # first draft asserted 24 and this caught it: the grain is club-gameweeks, not fixtures.
    check("club-fixture count rises by two",
          int(one(cur, "select club_fixtures from gameweek_shape_summary where event=%s", (gw,))), 22)
    check("shapes still partition the league",
          one(cur, """select blanking + doubling + single = clubs
                       from gameweek_shape_summary where event=%s""", (gw,)), True)
    check("the sentence says so",
          one(cur, "select shape_word from gameweek_shape_summary where event=%s", (gw,)),
          "2 clubs double")
    check("a double is not provisional",
          one(cur, """select count(*) from gameweek_shape
                       where event=%s and shape='double' and is_provisional""", (gw,)), 0)
    conn.rollback()

    print(f"\nSIMULATED BOTH — a blank and a double in GW{gw} at once")
    cur.execute("delete from fixtures where fpl_id=%s", (fid,))
    cur.execute("""insert into fixtures
                   select season, 900000 + fpl_id, 900000 + code, %s, kickoff_time, started,
                          finished, finished_provisional, minutes, team_h_code, team_a_code,
                          team_h_score, team_a_score, team_h_difficulty, team_a_difficulty,
                          pulse_id, stats, updated_at
                     from fixtures where fpl_id=%s""", (gw, src))
    check("both are reported",
          one(cur, """select blanking || '/' || doubling from gameweek_shape_summary
                       where event=%s""", (gw,)), "2/2")
    check("the sentence carries both",
          one(cur, "select shape_word from gameweek_shape_summary where event=%s", (gw,)),
          "2 blank, 2 double")
    check("shapes still partition the league",
          one(cur, """select blanking + doubling + single = clubs
                       from gameweek_shape_summary where event=%s""", (gw,)), True)
    conn.rollback()

    print("\nAfter rollback the calendar is untouched")
    check("no blanks", one(cur, "select count(*) from gameweek_shape where shape='blank'"), 0)
    check("no doubles", one(cur, "select count(*) from gameweek_shape where shape='double'"), 0)
    check("760 club-gameweeks", one(cur, "select count(*) from gameweek_shape"), 760)
    check("380 fixtures",
          one(cur, """select count(*) from fixtures
                       where season=(select current_season from season_context)"""), 380)
finally:
    conn.rollback()
    conn.close()

print(f"\n{'PASSED' if not failures else f'{len(failures)} FAILED: ' + ', '.join(failures)}")
sys.exit(1 if failures else 0)
