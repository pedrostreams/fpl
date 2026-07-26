"""Resolve each source's team naming to FPL's stable team `code`.

A hand-curated map, not fuzzy matching. There are 20 clubs, the names change once a year,
and every source disagrees in a different way:

    FPL          Man Utd    Spurs       Nott'm Forest   Brighton
    Understat    Manchester United      Tottenham       Nottingham Forest
    ClubElo      Man United Tottenham   Forest          Brighton
    odds CSV     Man United Tottenham   Nott'm Forest   Brighton

Fuzzy matching on 20 known strings would be strictly worse: slower, occasionally wrong,
and silent when it is. The cost of this approach is one edit per promoted club per year.

Names from clubs no longer in the Premier League are deliberately included — Understat and
the odds CSV carry full 2025/26 history, which contains Burnley, West Ham and Wolves.
Those resolve to None: real data about a club we hold no `teams` row for. Callers store the
raw name alongside, so nothing is lost.
"""

from __future__ import annotations

import unicodedata

# Canonical FPL name -> every alias seen in the wild, verified against live source output
# on 2026-07-26. Keys are matched case- and punctuation-insensitively, so only genuinely
# different words need listing.
ALIASES: dict[str, tuple[str, ...]] = {
    "Arsenal": ("Arsenal", "Arsenal FC"),
    "Aston Villa": ("Aston Villa", "Villa"),
    "Bournemouth": ("Bournemouth", "AFC Bournemouth"),
    "Brentford": ("Brentford",),
    "Brighton": ("Brighton", "Brighton & Hove Albion", "Brighton and Hove Albion"),
    "Chelsea": ("Chelsea",),
    "Coventry City": ("Coventry City", "Coventry"),
    "Crystal Palace": ("Crystal Palace", "Palace"),
    "Everton": ("Everton",),
    "Fulham": ("Fulham",),
    "Hull City": ("Hull City", "Hull"),
    "Ipswich Town": ("Ipswich Town", "Ipswich"),
    "Leeds": ("Leeds", "Leeds United"),
    "Liverpool": ("Liverpool",),
    "Man City": ("Man City", "Manchester City"),
    "Man Utd": ("Man Utd", "Man United", "Manchester United", "Manchester Utd"),
    "Newcastle": ("Newcastle", "Newcastle United", "Newcastle Utd"),
    "Nott'm Forest": (
        "Nott'm Forest", "Nottingham Forest", "Forest", "Nottm Forest",
    ),
    "Spurs": ("Spurs", "Tottenham", "Tottenham Hotspur"),
    "Sunderland": ("Sunderland",),
    # --- Clubs outside the 2026/27 Premier League -------------------------------- #
    # Present in 2025/26 Understat and odds history. Listed so they are recognised as
    # known-but-unresolvable rather than reported as new unmatched names every run.
    "Burnley": ("Burnley",),
    "West Ham": ("West Ham", "West Ham United"),
    "Wolves": ("Wolves", "Wolverhampton Wanderers", "Wolverhampton"),
    "Leicester": ("Leicester", "Leicester City"),
    "Southampton": ("Southampton",),
    "Luton": ("Luton", "Luton Town"),
    "Sheffield United": ("Sheffield United", "Sheffield Utd"),
    "Norwich": ("Norwich", "Norwich City"),
    "Watford": ("Watford",),
    "West Brom": ("West Brom", "West Bromwich Albion"),
}


def normalise(name: str) -> str:
    """Casefold, strip diacritics and drop everything that isn't a letter or digit.

    'Nott'm Forest', "NOTT'M FOREST" and 'Nottm Forest' all collapse to 'nottmforest',
    which removes most of the apostrophe-and-ampersand variation between sources.
    """
    if not name:
        return ""
    decomposed = unicodedata.normalize("NFKD", str(name))
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return "".join(c for c in stripped.casefold() if c.isalnum())


# Flattened lookup: normalised alias -> canonical FPL name.
_BY_ALIAS: dict[str, str] = {}
for _canonical, _aliases in ALIASES.items():
    _BY_ALIAS[normalise(_canonical)] = _canonical
    for _alias in _aliases:
        _BY_ALIAS[normalise(_alias)] = _canonical

# Clubs we recognise but hold no current `teams` row for.
NON_PL = {
    "Burnley", "West Ham", "Wolves", "Leicester", "Southampton", "Luton",
    "Sheffield United", "Norwich", "Watford", "West Brom",
}


class TeamResolver:
    """Maps source team names to FPL team codes, given the codes currently in the DB.

    Construct with `{canonical_fpl_name: code}` — usually `select name, code from teams`.
    """

    def __init__(self, code_by_name: dict[str, int]) -> None:
        self._code_by_norm = {normalise(n): c for n, c in code_by_name.items()}
        self.unknown: set[str] = set()

    def code(self, raw_name: str | None) -> int | None:
        """Resolve to an FPL team code, or None.

        None has two distinct meanings, and both are legitimate:
          - a club recognised but outside the current Premier League (relegated/promoted)
          - a name we've never seen, which is recorded in `self.unknown` for review

        Callers always persist the raw name too, so an unresolved row keeps its data.
        """
        if not raw_name:
            return None
        norm = normalise(raw_name)

        code = self._code_by_norm.get(norm)
        if code is not None:
            return code

        canonical = _BY_ALIAS.get(norm)
        if canonical is None:
            # Genuinely unrecognised — worth a human look, e.g. a newly promoted club.
            self.unknown.add(str(raw_name))
            return None

        # Known alias: try again against the DB under its canonical spelling.
        code = self._code_by_norm.get(normalise(canonical))
        if code is None and canonical not in NON_PL:
            # Recognised, not flagged as non-PL, yet absent from `teams` — most likely a
            # promoted club that needs adding to NON_PL or the current season isn't synced.
            self.unknown.add(f"{raw_name} (canonical={canonical}, absent from teams)")
        return code

    def report(self) -> list[str]:
        return sorted(self.unknown)
