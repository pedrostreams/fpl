"""Recover the two shot attributes `soccerdata` silently drops.

THE BUG IS UPSTREAM, NOT OURS. `soccerdata` converts Understat's CamelCase enum values into
spaced words, and its mapping is incomplete: three values become NaN. Proven 2026-07-26 by
counting the raw JSON it had already cached against what landed in Postgres, for the same 380
matches:

    situation   upstream: OpenPlay 6951  FromCorner 1674  SetPiece 559  DirectFreekick 248  Penalty 92
                stored:   Open Play 6951  From Corner 1674  Set Piece 559  Direct Freekick 248  NULL 92

    shotType    upstream: RightFoot 4743  LeftFoot 2957  Head 1778  OtherBodyPart 46
                stored:   Right Foot 4743  Left Foot 2957  NULL 1824  (= 1778 + 46)

Every count matches exactly, so the mapping drops precisely `Penalty`, `Head` and
`OtherBodyPart` — 1 870 of 9 524 shots, 19.6%, with a corrupted attribute. Our ingest cannot
be at fault: it passes the value straight through, and `_clean('Penalty')` returns `'Penalty'`.

WHY IT MATTERS ENOUGH TO FIX. Unlabelled penalties contaminate every non-penalty xG figure,
which is the number that actually predicts future scoring — a striker on four penalties looks
like a better open-play finisher than he is. Unlabelled headers make set-piece threat
unanalysable, and a tall defender who scores from corners is exactly the sort of cheap
differential this project exists to find.

WHY READ THE CACHE RATHER THAN INFER. The penalty label could be inferred from the coordinate
— all 92 sit at exactly (0.885, 0.500) with mean xG 0.761 — but `Head` and `OtherBodyPart`
cannot be separated once both are NaN. `soccerdata` writes the untouched Understat JSON to its
own cache during the same fetch, keyed by match id, with `id` matching our `shot_id`. Reading
that is exact rather than inferred, and costs no extra network request.

If `soccerdata` ever fixes its mapping this module becomes a no-op: it only fills values that
are missing, and reports how many it filled so `verify` notices when the count drops to zero.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

# soccerdata's default data root, overridable the same way soccerdata itself allows.
DEFAULT_ROOT = Path(os.environ.get("SOCCERDATA_DIR", Path.home() / "soccerdata")) / "data"

# Understat's own spellings, mapped to the spaced form soccerdata uses for the values it does
# convert — so a repaired row is indistinguishable from a correctly-parsed one.
SITUATION = {
    "OpenPlay": "Open Play",
    "FromCorner": "From Corner",
    "SetPiece": "Set Piece",
    "DirectFreekick": "Direct Freekick",
    "Penalty": "Penalty",
}
SHOT_TYPE = {
    "RightFoot": "Right Foot",
    "LeftFoot": "Left Foot",
    "Head": "Head",
    "OtherBodyPart": "Other Body Part",
}


def cache_dir(root: Path | None = None) -> Path:
    return (root or DEFAULT_ROOT) / "Understat"


def shot_attributes(root: Path | None = None) -> dict[str, dict[str, Any]]:
    """`{shot_id: {"situation": ..., "body_part": ...}}` from soccerdata's raw cache.

    Returns an empty dict if the cache is absent, which is a normal state on a cold CI runner
    before the fetch has run. Callers must treat "no repairs available" as acceptable rather
    than fatal, and let `verify` surface the resulting NULLs.
    """
    directory = cache_dir(root)
    if not directory.is_dir():
        return {}

    out: dict[str, dict[str, Any]] = {}
    for path in directory.glob("match_*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        shots = payload.get("shots")
        if not isinstance(shots, dict):
            continue
        for side in ("h", "a"):
            for shot in shots.get(side) or []:
                sid = shot.get("id")
                if sid is None:
                    continue
                out[str(sid)] = {
                    "situation": SITUATION.get(shot.get("situation")),
                    "body_part": SHOT_TYPE.get(shot.get("shotType")),
                }
    return out


def repair(rows: list[dict[str, Any]], root: Path | None = None) -> dict[str, int]:
    """Fill missing `situation` / `body_part` in place. Returns what it filled."""
    lookup = shot_attributes(root)
    stats = {
        "cached_shots": len(lookup),
        "situation_filled": 0,
        "body_part_filled": 0,
        "still_missing_situation": 0,
        "still_missing_body_part": 0,
    }
    if not lookup:
        stats["still_missing_situation"] = sum(1 for r in rows if not r.get("situation"))
        stats["still_missing_body_part"] = sum(1 for r in rows if not r.get("body_part"))
        return stats

    for row in rows:
        raw = lookup.get(str(row.get("shot_id")))
        if not raw:
            continue
        # Only ever fill a gap. Never overwrite a value soccerdata parsed correctly — if its
        # spelling changes, that is a discrepancy worth seeing rather than papering over.
        if not row.get("situation") and raw["situation"]:
            row["situation"] = raw["situation"]
            stats["situation_filled"] += 1
        if not row.get("body_part") and raw["body_part"]:
            row["body_part"] = raw["body_part"]
            stats["body_part_filled"] += 1

    stats["still_missing_situation"] = sum(1 for r in rows if not r.get("situation"))
    stats["still_missing_body_part"] = sum(1 for r in rows if not r.get("body_part"))
    return stats
