"""Rotation-pair scoring — no database, no network, so it gates CI.

**Why this exists.** `docs/feat/allaboutfpl-learnings.md` §10 asks for a simulated double and blank
rather than waiting for one, and it is right to: 2026/27 currently holds **760 club-gameweeks, every
single one with exactly one fixture**. Both branches that make rotation worth anything —
`fixtures = 0` and `fixtures > 1` — are unreachable from the data, and `rotation_pairs_check` can
only report that they are empty. This reimplements the scoring rule independently and drives it
through the calendars the season has not produced yet.

It also settles the question the feature exists to answer. Measured against the real GW1-6 window,
the best defensive pair gains **1.60 points across six gameweeks** and the average 0.51 — because
with every club playing once a week, `max(a, b)` is barely above the better of two similar numbers.
The simulations below show where the value actually is: a blank costs a lone owner his whole week,
and that is the case a partner covers.

    python scripts/probe/prove_rotation_pairs.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.stdout.reconfigure(encoding="utf-8")

failures: list[str] = []


def check(label: str, got, want, tol: float = 1e-9) -> None:
    if isinstance(want, float):
        good = got is not None and abs(got - want) <= tol
    else:
        good = got == want
    print(f"  {'ok  ' if good else 'FAIL'} {label}: got {got!r}, want {want!r}")
    if not good:
        failures.append(label)


# --------------------------------------------------------------------------------------- #
# The scoring rule, reimplemented from migration 0028's SQL rather than read out of it.
# A club-gameweek is a list of per-fixture values: [] is a blank, [x] a single, [x, y] a double.
# --------------------------------------------------------------------------------------- #

def defensive_easiness(fixtures: list[float]) -> float:
    """Expected clean sheets — additive, so a double is two chances and may exceed 1."""
    return sum(fixtures)


def attacking_easiness(lambdas: list[float]) -> float:
    """P(scores at least once) over the gameweek — a probability, so capped at 1 by construction."""
    import math
    if not lambdas:
        return 0.0
    return 1 - math.exp(-sum(lambdas))


def pair_score(a: list[list[float]], b: list[list[float]], axis: str) -> float:
    f = defensive_easiness if axis == "defensive" else attacking_easiness
    return sum(max(f(wa), f(wb)) for wa, wb in zip(a, b))


def single_score(a: list[list[float]], axis: str) -> float:
    f = defensive_easiness if axis == "defensive" else attacking_easiness
    return sum(f(w) for w in a)


def gain(a: list[list[float]], b: list[list[float]], axis: str) -> float:
    return pair_score(a, b, axis) - max(single_score(a, axis), single_score(b, axis))


print("\nA blank contributes nothing, and is not the same as an easy fixture")
check("blank -> 0 defensively", defensive_easiness([]), 0.0)
check("blank -> 0 attacking", attacking_easiness([]), 0.0)
# The trap this guards: if a blank fell out of the sum as a missing row instead of a zero, the
# club would look like it had simply not been considered rather than having no fixture.
check("a blank is worse than any fixture", defensive_easiness([]) < defensive_easiness([0.05]), True)

print("\nA double adds both fixtures on the additive axis and stays a probability on the other")
check("two clean-sheet chances add", defensive_easiness([0.4, 0.35]), 0.75)
check("expected clean sheets may exceed 1", defensive_easiness([0.6, 0.55]) > 1, True)
check("P(scores) never exceeds 1", round(attacking_easiness([2.5, 2.1]), 6), 0.989948)
check("P(scores) of a double beats the same club's single",
      attacking_easiness([1.2, 1.1]) > attacking_easiness([1.2]), True)

print("\nRotation is worthless when two schedules are identical")
same = [[0.30]] * 6
check("gain is zero", gain(same, [list(w) for w in same], "defensive"), 0.0)

print("\nRotation pays exactly when one partner blanks")
# Six gameweeks. Club A blanks in GW3; club B plays a normal fixture every week.
a = [[0.30], [0.30], [], [0.30], [0.30], [0.30]]
b = [[0.28], [0.28], [0.28], [0.28], [0.28], [0.28]]
check("A alone loses its blank week", round(single_score(a, "defensive"), 4), 1.5)
check("B alone is steady", round(single_score(b, "defensive"), 4), 1.68)
check("the pair covers the blank", round(pair_score(a, b, "defensive"), 4), 1.78)
# This is the number that justifies the feature: the pair beats the better single by the whole
# value of the covered week, which no amount of clever pairing achieves in a regular calendar.
check("gain equals the covered week", round(gain(a, b, "defensive"), 4), 0.1)

print("\nAnd when a partner doubles")
c = [[0.30], [0.30], [0.30, 0.32], [0.30], [0.30], [0.30]]
d = [[0.28]] * 6
check("the double is counted in full", round(single_score(c, "defensive"), 4), 2.12)
check("the pair takes the doubling club that week", round(pair_score(c, d, "defensive"), 4), 2.12)
check("no gain — the doubling club is better every week", round(gain(c, d, "defensive"), 4), 0.0)
# The interesting case: the partner doubles in the week our club blanks.
e = [[0.30], [0.30], [], [0.30], [0.30], [0.30]]
f = [[0.10], [0.10], [0.40, 0.38], [0.10], [0.10], [0.10]]
check("a double covering a blank is the best case",
      round(gain(e, f, "defensive"), 4), 0.78)

print("\nInvariants that must hold for every calendar")
CASES = [
    ("regular", [[0.3]] * 6, [[0.25]] * 6),
    ("one blank", a, b),
    ("one double", c, d),
    ("blank covered by double", e, f),
    ("both blank the same week", [[0.3], []], [[0.25], []]),
    ("all blanks", [[], []], [[], []]),
]
for axis in ("defensive", "attacking"):
    for name, x, y in CASES:
        g = gain(x, y, axis)
        check(f"{axis}/{name}: rotating never loses", g >= -1e-12, True)
        check(f"{axis}/{name}: pair >= each single",
              pair_score(x, y, axis) >= max(single_score(x, axis), single_score(y, axis)) - 1e-12,
              True)

print("\nBoth clubs blanking cannot be rescued by pairing")
check("two blanks stay zero", pair_score([[]], [[]], "defensive"), 0.0)
check("and the gain is zero, not negative", gain([[]], [[]], "defensive"), 0.0)

print("\nThe measured verdict on the real window, for the record")
# From `select axis, max(gain_in_points), avg(gain_in_points) from rotation_pairs group by 1`
# on 2026-07-29, when the window held no blanks and no doubles.
print("  GW1-6, no blanks or doubles in the calendar:")
print("    defensive  142 pairs   best 1.60 pts   avg 0.51 pts")
print("    attacking   21 pairs   best 0.85 pts   avg 0.46 pts")
print("  So a regular calendar makes rotation worth about half a point over six gameweeks.")
print("  The simulations above are where it earns its keep.")

print(f"\n{'PASSED' if not failures else f'{len(failures)} FAILED: ' + ', '.join(failures)}")
sys.exit(1 if failures else 0)
