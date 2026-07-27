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

# Every case here is deliberately non-ASCII — that is the whole point of the suite — and a
# Windows console defaults to cp1252, which cannot encode Ł, đ or ß. Without this the suite
# passes all 44 cases and then dies printing them, which on the developer's own machine is
# indistinguishable from a failure.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sync.matching.players import FplPlayer, PlayerResolver, normalise  # noqa: E402

ARS, AVL, CHE, NEW, MCI = 3, 7, 8, 4, 43
BOU, CRY, LIV, SUN, TOT, BRE, NFO, FUL = 91, 31, 14, 56, 6, 94, 17, 54
LEE = 2

# A pool shaped like the real one, including every collision that made naive matching
# produce confident nonsense on the first live run.
POOL = [
    FplPlayer(154561, "David", "Raya Martín", "Raya", None, ARS),
    FplPlayer(184029, "Martin", "Ødegaard", "Ødegaard", None, ARS),
    FplPlayer(481655, "Martín", "Zubimendi Ibáñez", "Zubimendi", None, ARS),
    FplPlayer(195384, "Mikel", "Merino Zazón", "Merino", None, ARS),
    FplPlayer(109745, "Kepa", "Arrizabalaga Revuelta", "Arrizabalaga", None, ARS),
    FplPlayer(111317, "David", "Brooks", "Brooks", None, AVL),
    FplPlayer(213292, "David", "Akintola", "Akintola", None, CHE),
    FplPlayer(67089, "Martin", "Dubravka", "Dubravka", None, NEW),
    FplPlayer(7083, "Christian", "Nørgaard", "Nørgaard", None, ARS),
    FplPlayer(1001, "João", "Pedro Junqueira de Jesus", "João Pedro", None, CHE),
    # Two players sharing a surname at different clubs — surname alone must not resolve.
    FplPlayer(2001, "Amad", "Diallo", "Amad", None, NEW),
    FplPlayer(2002, "Ibrahima", "Diallo", "Diallo", None, AVL),
    # --- Nickname / truncation cases that must still match --------------------- #
    FplPlayer(3001, "Junior", "Kroupi", "Kroupi.Jr", None, BOU),
    FplPlayer(3002, "Destiny", "Udogie", "Udogie", None, TOT),
    FplPlayer(3003, "Joe", "Gomez", "Gomez", None, LIV),
    FplPlayer(3004, "Matty", "Cash", "Cash", None, AVL),
    FplPlayer(3005, "Tino", "Livramento", "Livramento", None, NEW),
    FplPlayer(3006, "Josh", "King", "King", None, FUL),
    FplPlayer(3007, "Đorđe", "Petrović", "Petrović", None, BOU),
    FplPlayer(3008, "Trey", "Nyoni", "Nyoni", None, LIV),
    FplPlayer(3009, "Benjamin", "White", "White", None, ARS),
    FplPlayer(3010, "Alisson", "Becker", "A.Becker", None, LIV),
    FplPlayer(3011, "Sávio", "Moreira de Oliveira", "Savinho", None, MCI),
    FplPlayer(3012, "Pape Matar", "Sarr", "P.M.Sarr", None, TOT),
    # --- The false-positive traps, all real ----------------------------------- #
    FplPlayer(4001, "Nicolas", "Jackson", "N.Jackson", None, CHE),
    FplPlayer(4002, "Will", "Dennis", "Dennis", None, BOU),
    FplPlayer(4003, "Harvey", "Barnes", "Barnes", None, NEW),
    FplPlayer(4004, "Cristhian", "Mosquera", "Mosquera", None, ARS),
    FplPlayer(4005, "Jørgen", "Strand Larsen", "Strand Larsen", None, MCI),
    FplPlayer(4006, "Victor", "Munoz", "Munoz", None, LIV),
    FplPlayer(4007, "Rayan", "Cherki", "Cherki", None, MCI),
    FplPlayer(4008, "Gabriel", "Fernando de Jesus", "G.Jesus", "Gabriel Jesus", ARS),
    # --- The mononym-collides-with-three-forenames trap ----------------------- #
    # Arsenal's Gabriel went unmatched in the live pool for a whole season's worth of data.
    # Understat calls him "Gabriel"; the key "gabriel" collects his own web_name at 0.95 *and*
    # the first_name of Martinelli, Jesus and Gudmundsson at 0.58. Four candidates meant the
    # club had to arbitrate, and three of them are Arsenal, so it could not. A 209-point
    # defender had no shot data, no headed xG and no Understat creation numbers.
    #
    # All four must resolve, and to different players — which is the part a one-case test
    # would miss.
    FplPlayer(5001, "Gabriel", "dos Santos Magalhães", "Gabriel", None, ARS),
    FplPlayer(5002, "Gabriel", "Teodoro Martinelli Silva", "Martinelli", None, ARS),
    FplPlayer(5003, "Gabriel", "Gudmundsson", "Gudmundsson", None, LEE),
]

# (external name, external team code or None, expected player_code)
SHOULD_MATCH = [
    # The mononym trap: a strong unique key must beat several weak coincidental ones.
    ("Gabriel", ARS, 5001),
    ("Gabriel Martinelli", ARS, 5002),
    ("Gabriel Gudmundsson", LEE, 5003),
    ("Gabriel Jesus", ARS, 4008),
    # And without the club, the mononym is still unambiguous on web_name alone.
    ("Gabriel", None, 5001),
    # Spanish/Portuguese double surnames: FPL keeps both, Understat keeps one.
    ("David Raya", ARS, 154561),
    ("Martín Zubimendi", ARS, 481655),
    ("Mikel Merino", ARS, 195384),
    # Precomposed Nordic letters, which NFKD does not decompose.
    ("Martin Odegaard", ARS, 184029),
    ("Christian Norgaard", ARS, 7083),
    # Đ transliterates to 'dj', which is what Understat writes.
    ("Djordje Petrovic", BOU, 3007),
    # Single-token given name where FPL stores the full legal name.
    ("Kepa", ARS, 109745),
    ("Alisson", LIV, 3010),
    ("Sávio", MCI, 3011),
    # Straightforward exact matches must keep working.
    ("David Brooks", AVL, 111317),
    ("Joao Pedro", CHE, 1001),
    ("Gabriel Jesus", ARS, 4008),
    # Nicknames and truncations — the reason the forename check has to be generous.
    ("Joshua King", FUL, 3006),          # Josh   <- Joshua   (prefix)
    ("Joseph Gomez", LIV, 3003),         # Joe    <- Joseph   (shared 2 chars)
    ("Matthew Cash", AVL, 3004),         # Matty  <- Matthew  (shared 2 chars)
    ("Valentino Livramento", NEW, 3005),  # Tino  <- Valentino (contained)
    ("Treymaurice Nyoni", LIV, 3008),    # Trey   <- Treymaurice (prefix)
    ("Ben White", ARS, 3009),            # Ben    <- Benjamin (prefix)
    ("Pape Sarr", TOT, 3012),
    # The forename may sit in any token, not just the first.
    ("Eli Junior Kroupi", BOU, 3001),
    ("Iyenoma Destiny Udogie", TOT, 3002),
    # Ambiguous surname, but the club disambiguates.
    ("Diallo", AVL, 2002),
    # A transferred player: enrichment carries last season's club, so a wrong team must
    # not prevent an otherwise unique name match.
    ("Martin Odegaard", MCI, 184029),
]

# Cases where returning *anything* would be a bug. Every entry below the divider is a real
# false positive the first live run produced — all ten shared a surname and disagreed on
# the forename, which is exactly what the forename check now vetoes.
SHOULD_NOT_MATCH = [
    ("Erling Haaland", None),         # not in the pool at all
    ("Xyz Nonexistent", ARS),
    ("David", None),                  # three Davids, no club
    # ---- observed false positives, 2026-07-26 -------------------------------- #
    ("Jackson Tchatchoua", None),     # was -> Nicolas Jackson
    ("Dennis Cirkin", SUN),           # was -> Will Dennis
    ("Ashley Barnes", None),          # was -> Harvey Barnes
    ("Yerson Mosquera", None),        # was -> Cristhian Mosquera
    ("Jacob Bruun Larsen", None),     # was -> Jørgen Strand Larsen
    ("Daniel Muñoz", CRY),            # was -> Victor Munoz (different club, too)
    ("Mathis Cherki", MCI),           # was -> Rayan Cherki (same club; name must decide)
    ("Fernando López", None),         # was -> Gabriel Fernando de Jesus
    ("Luis Guilherme", None),         # was -> Dário Luís Essugo
    ("Florentino Luís", None),        # was -> Dário Luís Essugo
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
