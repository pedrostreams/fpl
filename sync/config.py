"""Environment and season resolution.

The season-resolution logic here encodes the preseason trap documented in
docs/DATA_SOURCES.md §2: until GW1 kicks off, the `bootstrap-static.elements` aggregates
describe the *previous* season, not the one being synced.
"""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = Path(os.environ.get("FPL_CACHE_DIR", REPO_ROOT / "tmp" / "raw"))


def load_dotenv() -> None:
    """Load .env if present. Deliberately dependency-free and non-overriding, so CI
    secrets always win over a stale local file."""
    for name in (".env", ".env.local"):
        path = REPO_ROOT / name
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit(
            "DATABASE_URL is not set.\n"
            "Use the Supabase *session pooler* host — vm26's notes record that\n"
            "db.<ref>.supabase.co does not resolve:\n"
            "  postgresql://postgres.<ref>:<pw>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres"
        )
    return url


# --------------------------------------------------------------------------- #
# Season resolution
# --------------------------------------------------------------------------- #

def season_label(events: list[dict]) -> str:
    """'2026-27' — derived from GW1's deadline year rather than hardcoded."""
    first = min(events, key=lambda e: e["id"])
    year = int(str(first["deadline_time"])[:4])
    return f"{year}-{str(year + 1)[-2:]}"


def previous_season_label(label: str) -> str:
    """'2026-27' -> '2025-26'."""
    year = int(label.split("-")[0])
    return f"{year - 1}-{str(year)[-2:]}"


def is_preseason(events: list[dict]) -> bool:
    """True when the season hasn't started.

    Two independent tells, both verified against the live API on 2026-07-26: no event is
    flagged `is_current`, and no event is `finished`. Checking both means a mid-season
    quirk in one flag can't silently mislabel a whole ingest.
    """
    return not any(e.get("is_current") for e in events) and not any(
        e.get("finished") for e in events
    )


def aggregates_season(events: list[dict]) -> str:
    """Which season the `elements` aggregate stats actually describe.

    In preseason the payload still carries last season's totals — verified: Haaland
    showed minutes 2953 / xG 25.50 in the 2026/27 payload on 2026-07-26.
    """
    current = season_label(events)
    return previous_season_label(current) if is_preseason(events) else current


def gw1_deadline(events: list[dict]) -> str | None:
    first = min(events, key=lambda e: e["id"])
    return first.get("deadline_time")


def next_event_id(events: list[dict]) -> int | None:
    for e in events:
        if e.get("is_current"):
            return e["id"]
    for e in events:
        if e.get("is_next"):
            return e["id"]
    return None
