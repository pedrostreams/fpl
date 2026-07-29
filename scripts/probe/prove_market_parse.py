"""Norsk Tipping market parsing — no database, no network, so it gates CI.

**Why this exists.** The 1X2 market is open now and verified against the live API. The deep
46-market set that carries team totals and clean sheets is **not open for the Premier League
and cannot be before 2026-08-21**, so `parse_markets` handles market names this repo has never
seen served. Two things can go wrong in August, and they need separating:

  1. the market names differ from what was measured on other competitions, or
  2. the parser is wrong.

This script rules out (2) in advance. It builds synthetic payloads using the names recorded in
`docs/feat/allaboutfpl-learnings.md` §7.1 and asserts the arithmetic, the sideing, the tail
ordering and — the one that matters — that an unrecognised market is **reported rather than
dropped**. If August shows unfamiliar names, the fix is a recogniser, not a debugging session.

    python scripts/probe/prove_market_parse.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# The market names are Norwegian; without this the Windows console mangles them into
# mojibake and a name mismatch becomes unreadable in exactly the output meant to diagnose it.
sys.stdout.reconfigure(encoding="utf-8")

from sync.jobs.market_odds import _side_of, parse_markets  # noqa: E402

HOME, AWAY = "Newcastle United", "Liverpool"

failures: list[str] = []


def check(label: str, got, want, tol: float = 5e-4) -> None:
    if isinstance(want, float) and isinstance(got, (int, float)):
        good = got is not None and abs(got - want) <= tol
    else:
        good = got == want
    print(f"  {'ok  ' if good else 'FAIL'} {label}: got {got!r}, want {want!r}")
    if not good:
        failures.append(label)


def market(name: str, sels: list[tuple[str, str]], **extra) -> dict:
    return {
        "marketName": name,
        "selections": [{"selectionName": n, "selectionOdds": o} for n, o in sels],
        **extra,
    }


def hub(h: str, d: str, a: str) -> dict:
    """HUB identifies its outcomes by selectionValue, not name — as the live API does."""
    return {
        "marketName": "HUB",
        "marketLineType": "MONEY",
        "selections": [
            {"selectionValue": "H", "selectionName": HOME, "selectionOdds": h},
            {"selectionValue": "D", "selectionName": "Uavgjort", "selectionOdds": d},
            {"selectionValue": "A", "selectionName": AWAY, "selectionOdds": a},
        ],
    }


print("\n1X2 — the market that is open today")
# Live values for Arsenal v Coventry, 2026-07-29: 1.15 / 6.20 / 14.00.
probs, unknown = parse_markets([hub("1.15", "6.20", "14.00")], "Arsenal", "Coventry")
check("p_home", probs["p_home"], 0.78888)
check("p_draw", probs["p_draw"], 0.14632)
check("p_away", probs["p_away"], 0.06480)
check("sums to 1", round(probs["p_home"] + probs["p_draw"] + probs["p_away"], 5), 1.0)
check("odds retained", probs["odds_home"], 1.15)
check("nothing unrecognised", unknown, [])

print("\nDe-vig refuses a partial market rather than guessing")
partial = {
    "marketName": "HUB", "marketLineType": "MONEY",
    "selections": [
        {"selectionValue": "H", "selectionOdds": "1.15"},
        {"selectionValue": "D", "selectionOdds": "6.20"},
    ],
}
probs, _ = parse_markets([partial], HOME, AWAY)
check("p_home is None when a side is missing", probs["p_home"], None)

print("\nThe deep set — names from allaboutfpl-learnings §7.1, unseen for the PL")
deep = [
    hub("2.50", "3.40", "2.80"),
    market("Begge lag scorer", [("Ja", "1.60"), ("Nei", "2.30")]),
    market("Totalt antall mål 2.5", [("Over", "1.80"), ("Under", "2.00")]),
    market("Totalt antall mål 1.5", [("Over", "1.25"), ("Under", "4.00")]),
    market("Totalt antall mål 3.5", [("Over", "2.60"), ("Under", "1.50")]),
    market(f"{HOME} Totalt 0.5", [("Over", "1.30"), ("Under", "3.50")]),
    market(f"{HOME} Totalt 1.5", [("Over", "2.20"), ("Under", "1.65")]),
    market(f"{AWAY} Totalt 0.5", [("Over", "1.25"), ("Under", "4.00")]),
    market(f"{AWAY} Totalt 1.5", [("Over", "2.05"), ("Under", "1.75")]),
    market(f"{HOME} holder nullen", [("Ja", "4.00"), ("Nei", "1.25")]),
    market(f"{AWAY} holder nullen", [("Ja", "3.50"), ("Nei", "1.30")]),
    market("Korrekt resultat", [("1-0", "8.00"), ("2-1", "9.00")]),
]
probs, unknown = parse_markets(deep, HOME, AWAY)
check("nothing unrecognised", unknown, [])
check("p_btts", probs["p_btts"], 0.58974)
check("p_over_15", probs["p_over_15"], 0.76190)
check("p_over_25", probs["p_over_25"], 0.52632)
check("p_over_35", probs["p_over_35"], 0.36585)
check("home scores 1+", probs["p_home_scores"], 0.72917)
check("home scores 2+", probs["p_home_scores_2plus"], 0.42857)
check("away scores 1+", probs["p_away_scores"], 0.76190)
check("away scores 2+", probs["p_away_scores_2plus"], 0.46053)
check("home clean sheet", probs["p_home_clean_sheet"], 0.23810)
check("away clean sheet", probs["p_away_clean_sheet"], 0.27083)

print("\nInternal consistency — the assertions market_odds_check makes on real rows")
check("P(2+) <= P(1+), home", probs["p_home_scores_2plus"] <= probs["p_home_scores"], True)
check("P(2+) <= P(1+), away", probs["p_away_scores_2plus"] <= probs["p_away_scores"], True)
check("goal lines ordered", probs["p_over_35"] <= probs["p_over_25"] <= probs["p_over_15"], True)
# A clean sheet for one side IS the other side failing to score. Priced separately by the
# bookmaker, so agreement is real evidence the sideing is right — and these synthetic odds
# were chosen to satisfy it, which is why the tolerance is the same 3pp the check view uses.
check("home CS == 1 - away scores",
      abs(probs["p_home_clean_sheet"] - (1 - probs["p_away_scores"])) < 0.03, True)

print("\nSideing — the trap is two clubs sharing a city")
check("Manchester United, not City",
      _side_of("Manchester United Totalt 0.5", "Manchester United", "Manchester City"), "home")
check("Manchester City as away",
      _side_of("Manchester City holder nullen", "Manchester United", "Manchester City"), "away")
check("longest match wins either ordering",
      _side_of("Manchester United Totalt 1.5", "Manchester City", "Manchester United"), "away")
check("no club named", _side_of("Totalt antall mål 2.5", HOME, AWAY), None)

print("\nAn unrecognised market is reported, never silently dropped")
probs, unknown = parse_markets(
    [hub("2.50", "3.40", "2.80"), market("Hjørnespark totalt 9.5", [("Over", "1.9"), ("Under", "1.9")]),
     market("Noe helt nytt", [("Ja", "2.0"), ("Nei", "2.0")])],
    HOME, AWAY)
check("1X2 still parsed alongside", probs["p_home"] is not None, True)
check("both unknowns reported", sorted(unknown), ["Hjørnespark totalt 9.5", "Noe helt nytt"])

print("\nA team-total on an unexpected line is reported, not mis-filed as 0.5")
probs, unknown = parse_markets([market(f"{HOME} Totalt 2.5", [("Over", "3.0"), ("Under", "1.4")])],
                               HOME, AWAY)
check("2.5 team line not stored as p_home_scores", probs.get("p_home_scores"), None)
check("reported instead", unknown, [f"{HOME} Totalt 2.5"])

print("\nEmpty and malformed input")
check("no markets -> no probabilities", parse_markets([], HOME, AWAY), ({}, []))
check("selectionless market ignored",
      parse_markets([{"marketName": "HUB", "selections": []}], HOME, AWAY), ({}, []))

print(f"\n{'PASSED' if not failures else f'{len(failures)} FAILED: ' + ', '.join(failures)}")
sys.exit(1 if failures else 0)
