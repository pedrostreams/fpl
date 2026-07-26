"""Resolve external player identities to FPL's stable player `code`.

Unlike teams, this can't be a hand-curated map — it's ~550 players a season, changing with
every transfer window. FPL exposes `opta_code` but no free scrape source publishes Opta ids,
so name matching is unavoidable.

Two rules make it survivable:

  1. **Resolve once, persist the result.** Mappings live in `player_external_ids` and are
     sticky: a later run reuses an existing mapping rather than re-matching, so a manual
     correction is never silently undone.
  2. **Never guess quietly.** Anything unresolved goes to `unmatched_names` for review.

## What the real data broke

The first version matched 374 of 537 Understat players. Diagnosing the 163 gave three
distinct causes, and only two were bugs:

  - **80 played for relegated clubs** (Wolves, West Ham, Burnley) and others had left the
    league entirely (Trossard, Sancho, Douglas Luiz). Genuinely absent from FPL 2026/27 —
    correct behaviour, not a failure. A 100% match rate across seasons is *not* the goal.
  - **`ø` is not a decomposable diacritic.** Stripping combining marks turns `é` into `e`,
    but `Ødegaard` stays `ødegaard` while Understat writes `odegaard`. Precomposed Nordic
    and Eastern European letters need explicit transliteration. Hence `TRANSLITERATE`.
  - **Spanish and Portuguese double surnames.** FPL stores `David Raya Martín`,
    `Mikel Merino Zazón`, `Zubimendi Ibáñez`, `Kepa Arrizabalaga Revuelta`; Understat writes
    `David Raya`, `Mikel Merino`, `Martín Zubimendi`, `Kepa`. Matching whole strings can
    never bridge that, so both sides are decomposed into name-part variants and compared
    across every combination.

## Cross-season caution

Team is used only to break ties, never to veto a unique match. Enrichment covers the
*previous* season while `player_seasons` holds the *current* club, so any transferred player
has a legitimately different team on each side. Vetoing on that would reject correct matches.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import Iterable

# Letters NFKD leaves alone because they are distinct letters, not accented forms. Without
# this, 'Ødegaard' never matches 'Odegaard'.
TRANSLITERATE = str.maketrans({
    "ø": "o", "Ø": "o", "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe",
    "ð": "d", "Ð": "d", "đ": "d", "Đ": "d", "þ": "th", "Þ": "th",
    "ł": "l", "Ł": "l", "ß": "ss", "ı": "i", "İ": "i",
    "ħ": "h", "Ħ": "h", "ŋ": "n", "Ŋ": "n", "ʼ": "", "'": "", "'": "",
})


def normalise(name: str) -> str:
    """Casefold, transliterate, strip diacritics, drop non-alphanumerics.

    'Nørgaard' -> 'norgaard', 'Ødegaard' -> 'odegaard', 'João Pedro' -> 'joaopedro',
    "O'Brien" -> 'obrien'.
    """
    if not name:
        return ""
    text = str(name).translate(TRANSLITERATE)
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return "".join(c for c in stripped.casefold() if c.isalnum())


def _tokens(name: str) -> list[str]:
    return [t for t in str(name or "").replace("-", " ").split() if t]


@dataclass(frozen=True)
class FplPlayer:
    code: int
    first_name: str
    second_name: str
    web_name: str
    known_name: str | None
    team_code: int | None

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.second_name}".strip()


@dataclass(frozen=True)
class Match:
    player_code: int
    method: str
    confidence: float


# Keys generated per FPL player, strongest first. The weight is how much a hit on this key
# is worth; anything below ~0.6 only survives when it is unambiguous or the club agrees.
def _fpl_keys(p: FplPlayer) -> list[tuple[str, str, float]]:
    first = _tokens(p.first_name)
    second = _tokens(p.second_name)
    keys: list[tuple[str, str, float]] = [
        ("full_name", p.full_name, 0.99),
        ("known_name", p.known_name or "", 0.98),
        ("web_name", p.web_name, 0.95),
        ("second_name", p.second_name, 0.92),
    ]
    if first and second:
        # 'David Raya Martín' -> 'David Raya'. This is the rung that fixes the Spanish and
        # Portuguese double-surname cases.
        keys.append(("first+second_head", f"{first[0]} {second[0]}", 0.93))
        if len(second) > 1:
            keys.append(("first+second_tail", f"{first[0]} {second[-1]}", 0.88))
    if second:
        keys.append(("second_head", second[0], 0.84))
        if len(second) > 1:
            keys.append(("second_tail", second[-1], 0.82))
    if first:
        # 'Kepa'. Almost always ambiguous, so it needs uniqueness or the club to survive.
        keys.append(("first_name", p.first_name, 0.58))
    return [(m, normalise(v), w) for m, v, w in keys if normalise(v)]


# Variants of the incoming name, strongest first, with a multiplier for how much the
# transformation costs in confidence.
def _external_variants(name: str) -> list[tuple[str, str, float]]:
    toks = _tokens(name)
    out: list[tuple[str, str, float]] = [("as_given", name, 1.00)]
    if len(toks) > 1:
        out.append(("first+last", f"{toks[0]} {toks[-1]}", 0.98))
        out.append(("last", toks[-1], 0.90))
        out.append(("first", toks[0], 0.70))
    return [(k, normalise(v), f) for k, v, f in out if normalise(v)]


MIN_CONFIDENCE = 0.55


class PlayerResolver:
    """Cascading name matcher over a fixed pool of FPL players."""

    def __init__(self, players: Iterable[FplPlayer]) -> None:
        self.players = list(players)
        self._by_code = {p.code: p for p in self.players}
        # key -> {player_code: (method, weight)}, keeping the strongest key per player so a
        # coincidental weak key can't outrank that player's own strong one.
        self._index: dict[str, dict[int, tuple[str, float]]] = {}
        for p in self.players:
            for method, key, weight in _fpl_keys(p):
                bucket = self._index.setdefault(key, {})
                prev = bucket.get(p.code)
                if prev is None or weight > prev[1]:
                    bucket[p.code] = (method, weight)

    def resolve(self, name: str, team_code: int | None = None) -> Match | None:
        """Best match for an external name, or None.

        Confidence is a coarse trust label, not a probability — it exists so a review can
        sort by "how much should I believe this".
        """
        best: Match | None = None

        for variant_kind, key, factor in _external_variants(name):
            bucket = self._index.get(key)
            if not bucket:
                continue

            if len(bucket) == 1:
                code, (method, weight) = next(iter(bucket.items()))
            else:
                # Ambiguous: let the club decide, but only as a tiebreak. Enrichment covers
                # last season while player_seasons holds the current club, so a transferred
                # player legitimately differs — this must never veto a unique hit.
                if team_code is None:
                    continue
                same = {c: v for c, v in bucket.items()
                        if self._by_code[c].team_code == team_code}
                if len(same) != 1:
                    continue
                code, (method, weight) = next(iter(same.items()))
                weight -= 0.05  # resolved by club rather than by name alone

            confidence = round(weight * factor, 3)
            if confidence < MIN_CONFIDENCE:
                continue
            if best is None or confidence > best.confidence:
                best = Match(code, f"{variant_kind}->{method}", confidence)
                if confidence >= 0.97:  # good enough to stop looking
                    break

        return best
