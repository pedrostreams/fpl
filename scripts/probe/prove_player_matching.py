"""Regression cases for cross-source player name matching.

Every case here is a real name pair that broke, or nearly broke, a live run. Matching is
the layer where a bug is invisible: a wrong match silently attributes one player's xG to
another, and nothing errors. So the negative cases matter as much as the positive ones.

Runs without a database or network. Exit code is the number of failures.

    python scripts/probe/prove_player_matching.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sync.matching.players import FplPlayer, PlayerResolver, normalise  # noqa: E402

ARS, AVL, CHE, NEW, MCI = 3, 7, 8, 4, 43

# A pool shaped like the real one, including the collisions that make naive matching unsafe.
POOL = [
    FplPlayer(154561, "David", "Raya Martín", "Raya", None, ARS),
    FplPlayer(184029, "Martin", "Ødegaard", "Ødegaard", None, ARS),
    FplPlayer(481655, "Martín", "Zubimendi Ibáñez", "Zubimendi", None, ARS),
    FplPlayer(195384, "Mikel", "Merino Zazón", "Merino", None, ARS),
    FplPlayer(109745, "Kepa", "Arrizabalaga Revuelta", "Arrizabalaga", None, ARS),
    FplPlayer(111317, "David", "Brooks", "Brooks", None, AVL),
    FplPlayer(213292, "David", "Akintola", "Akintola", None, CHE),
    FplPlayer(67089, "Martin", "Dubravka", "Dubravka", None, NEW),
    FplPlayer(499604, "Rayan", "Vitor Simplício Rocha", "Rayan", "Rayan", MCI),
    FplPlayer(7083, "Christian", "Nørgaard", "Nørgaard", None, ARS),
    FplPlayer(1001, "João", "Pedro Junqueira de Jesus", "João Pedro", None, CHE),
    # Two players sharing a surname at different clubs — surname alone must not resolve.
    FplPlayer(2001, "Amad", "Diallo", "Diallo", None, NEW),
    FplPlayer(2002, "Ibrahima", "Diallo", "Diallo", None, AVL),
]

# (external name, external team code or None, expected player_code)
SHOULD_MATCH = [
    # Spanish/Portuguese double surnames: FPL keeps both, Understat keeps one.
    ("David Raya", ARS, 154561),
    ("Martín Zubimendi", ARS, 481655),
    ("Mikel Merino", ARS, 195384),
    # Precomposed Nordic letters, which NFKD does not decompose.
    ("Martin Odegaard", ARS, 184029),
    ("Christian Norgaard", ARS, 7083),
    # Single-token given name where FPL stores the full legal name.
    ("Kepa", ARS, 109745),
    # Straightforward exact matches must keep working.
    ("David Brooks", AVL, 111317),
    ("Joao Pedro", CHE, 1001),
    # Ambiguous surname, but the club disambiguates.
    ("Diallo", NEW, 2001),
    ("Diallo", AVL, 2002),
    # A transferred player: enrichment carries last season's club, so a wrong team must
    # not prevent an otherwise unique name match.
    ("Martin Odegaard", MCI, 184029),
]

# Cases where returning *anything* would be a bug.
SHOULD_NOT_MATCH = [
    ("Diallo", None),                 # ambiguous surname, no club to break the tie
    ("Erling Haaland", None),         # not in the pool at all
    ("Xyz Nonexistent", ARS),
    ("David", None),                  # three Davids, no club
]


def main() -> int:
    resolver = PlayerResolver(POOL)
    failures = 0

    print("=== should match ===")
    for name, team, expected in SHOULD_MATCH:
        hit = resolver.resolve(name, team)
        if hit is None:
            print(f"FAIL  {name!r} (team={team}) -> no match, expected {expected}")
            failures += 1
        elif hit.player_code != expected:
            print(f"FAIL  {name!r} (team={team}) -> {hit.player_code} "
                  f"via {hit.method}, expected {expected}")
            failures += 1
        else:
            print(f"PASS  {name!r:<22} -> {expected} via {hit.method} "
                  f"(conf {hit.confidence})")

    print("\n=== should NOT match ===")
    for name, team in SHOULD_NOT_MATCH:
        hit = resolver.resolve(name, team)
        if hit is not None:
            print(f"FAIL  {name!r} (team={team}) -> {hit.player_code} via "
                  f"{hit.method} (conf {hit.confidence}); expected no match")
            failures += 1
        else:
            print(f"PASS  {name!r:<22} -> correctly unresolved")

    print("\n=== normalisation ===")
    for raw, want in [
        ("Ødegaard", "odegaard"), ("Nørgaard", "norgaard"), ("João", "joao"),
        ("O'Brien", "obrien"), ("Ibáñez", "ibanez"), ("Łukasz", "lukasz"),
        ("Weiß", "weiss"), ("Guéhi", "guehi"),
    ]:
        got = normalise(raw)
        if got != want:
            print(f"FAIL  normalise({raw!r}) = {got!r}, expected {want!r}")
            failures += 1
        else:
            print(f"PASS  normalise({raw!r:<12}) = {got!r}")

    print(f"\n{failures} failure(s)")
    return failures


if __name__ == "__main__":
    sys.exit(main())
