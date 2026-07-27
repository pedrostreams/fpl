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
    "ð": "d", "Ð": "d", "þ": "th", "Þ": "th",
    # Đ/đ -> 'dj', not 'd': FPL writes 'Đorđe Petrović' where Understat writes 'Djordje
    # Petrovic', and 'dj' is the transliteration that makes those two meet.
    "đ": "dj", "Đ": "dj",
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
#
# There is deliberately no "first token only" variant. It looked harmless and was the single
# largest source of false positives in the first live run: 'Jackson Tchatchoua' matched
# 'Nicolas Jackson', 'Dennis Cirkin' matched 'Will Dennis', and 'Fernando López' matched
# 'Gabriel Fernando de Jesus' — each time by treating the incoming forename as a surname.
# Genuinely single-name players ('Kepa', 'Alisson', 'Sávio', 'Jair') have one token, so
# `as_given` already covers them against the `first_name` key.
def _external_variants(name: str) -> list[tuple[str, str, float]]:
    toks = _tokens(name)
    out: list[tuple[str, str, float]] = [("as_given", name, 1.00)]
    if len(toks) > 1:
        out.append(("first+last", f"{toks[0]} {toks[-1]}", 0.98))
        out.append(("last", toks[-1], 0.90))
    return [(k, normalise(v), f) for k, v, f in out if normalise(v)]


MIN_CONFIDENCE = 0.55

# Rungs trustworthy enough to skip the forename check: they already matched the whole name.
_WHOLE_NAME_METHODS = {"full_name", "known_name"}


def _forename_compatible(a: str, b: str) -> bool:
    """Could these two be the same person's forename?

    Deliberately generous, because real pairs include Josh/Joshua, Joe/Joseph,
    Matty/Matthew, Ben/Benjamin, Trey/Treymaurice and Tino/Valentino. Generous enough to
    accept a nickname, strict enough to reject Ashley/Harvey and Jacob/Jørgen.
    """
    a, b = normalise(a), normalise(b)
    if not a or not b:
        return True                      # nothing to contradict
    if a == b:
        return True
    if len(a) == 1 or len(b) == 1:
        return a[0] == b[0]              # an initial, e.g. 'J. Gomez'
    short, long = sorted((a, b), key=len)
    if len(short) >= 3 and (long.startswith(short) or short in long):
        return True                      # Josh/Joshua, Trey/Treymaurice, Tino/Valentino
    return short[:2] == long[:2]         # Joe/Joseph, Matty/Matthew, Yeremi/Yeremy


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

    def _forename_agrees(self, name: str, player: FplPlayer) -> bool:
        """Does the FPL forename appear, compatibly, anywhere in the incoming name?

        This is the veto that stops surname-only agreement from becoming a match. Every
        false positive in the first live run shared a surname and disagreed on the forename:
        Ashley/Harvey Barnes, Yerson/Cristhian Mosquera, Jacob Bruun/Jørgen Strand Larsen,
        Mathis/Rayan Cherki, Daniel/Victor Muñoz.

        Any token is allowed to carry the forename, not just the first, because sources
        disagree about where it sits: Understat's 'Eli Junior Kroupi' is FPL's 'Junior
        Kroupi', and 'Iyenoma Destiny Udogie' is 'Destiny Udogie'.
        """
        first = player.first_name
        if not first:
            return True
        tokens = _tokens(name)
        if len(tokens) < 2:
            return True   # single-name players carry no forename to contradict
        return any(_forename_compatible(first, t) for t in tokens)

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

            # Drop candidates whose forename contradicts the incoming name, unless the whole
            # name already matched.
            bucket = {
                c: (m, w) for c, (m, w) in bucket.items()
                if m in _WHOLE_NAME_METHODS or self._forename_agrees(name, self._by_code[c])
            }
            if not bucket:
                continue

            # One strong hit plus several weak ones is not ambiguous — it is one answer and
            # some noise. The weights already say how much each key is worth, and flattening
            # the bucket threw that ordering away.
            #
            # This is not hypothetical. Arsenal's Gabriel (`web_name` "Gabriel", 209 points
            # last season) went unmatched for exactly this reason: the key "gabriel" collected
            # his own `web_name` hit at 0.95 *and* the `first_name` of Gabriel Martinelli,
            # Gabriel Jesus and Gabriel Gudmundsson at 0.58. Four candidates, so it fell
            # through to the club tiebreak — and three of them are Arsenal, so that could not
            # separate them either. The result was silence about a top-six asset.
            #
            # Safe against the false positives that shaped this file: those all came from
            # treating an incoming *forename* as a surname, a variant that still does not
            # exist, and the forename veto above still runs first.
            if len(bucket) > 1:
                top = max(w for _, w in bucket.values())
                strongest = {c: v for c, v in bucket.items() if v[1] >= top - 1e-9}
                if len(strongest) == 1:
                    bucket = strongest

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
