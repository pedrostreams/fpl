"""ClubElo: continuous, opponent-adjusted team strength with real history.

Why this matters for FPL: the `strength_overall_home` family in `bootstrap-static` is `0`
for every team until the season starts (verified 2026-07-26), and even in-season it's a
coarse integer FPL sets by hand. Elo is continuous, updated per match, and — critically for
a project starting in preseason — already has thousands of rows of history for backtesting.

The API is CSV over plain HTTP with no key. Two endpoints are used:

    /<Club>       full history for one club: one row per validity window
    /<YYYY-MM-DD> every club's rating on that date

We take the per-club history, because a single date gives no trend and the fixture-difficulty
work needs the slope as much as the level. ClubElo also publishes forward-dated rows
(Arsenal's current window runs to 2026-12-31), so `valid_to` is often in the future.
"""

from __future__ import annotations

import csv
import io
from datetime import date
from typing import Any

from curl_cffi import requests as curl_requests

from .. import db
from ..fpl import FplClient
from . import _resolve

API = "http://api.clubelo.com"
IMPERSONATE = "chrome120"

# ClubElo's own spellings, which differ from FPL's ('Forest', 'Man United', 'Tottenham').
# The alias map in sync/matching/teams.py resolves them; this list only decides which clubs
# to fetch. Kept explicit rather than derived from `teams` because ClubElo needs its name,
# not ours.
CLUBS = [
    "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton", "Chelsea",
    "Coventry", "Crystal Palace", "Everton", "Fulham", "Hull", "Ipswich", "Leeds",
    "Liverpool", "Man City", "Man United", "Newcastle", "Forest", "Tottenham",
    "Sunderland",
]


def _num(v: str) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _int(v: str) -> int | None:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _day(v: str) -> date | None:
    try:
        return date.fromisoformat(str(v).strip())
    except (TypeError, ValueError):
        return None


def fetch_club(club: str, timeout: int = 30) -> list[dict[str, Any]]:
    """Fetch one club's full Elo history.

    Spaces must be stripped from the path: ClubElo expects `/AstonVilla`, and for
    `/Aston Villa` it answers **HTTP 200 with a header row and no data** rather than a 404.
    That silently produced 0 rows for Aston Villa, Crystal Palace, Man City and Man United
    on the first run — a partial sync that looked completely successful. Callers must treat
    an empty result as a failure, which is why `run()` checks row counts per club.
    """
    slug = str(club).replace(" ", "")
    resp = curl_requests.get(f"{API}/{slug}", impersonate=IMPERSONATE, timeout=timeout)
    resp.raise_for_status()
    return list(csv.DictReader(io.StringIO(resp.text)))


def run(
    client: FplClient | None = None,
    *,
    dry_run: bool = False,
    since: str = "2015-01-01",
) -> dict[str, Any]:
    """`since` trims the archive — ClubElo has ~6 500 rows per club going back decades, and
    pre-2015 English football is not informative about the 2026/27 season."""
    floor = _day(since)
    rows: list[dict[str, Any]] = []
    failures: list[str] = []
    per_club: dict[str, int] = {}

    for club in CLUBS:
        try:
            raw = fetch_club(club)
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{club}: {exc!r}")
            continue
        if not raw:
            # 200-with-no-rows is how ClubElo reports an unknown club name. Without this
            # check the club is simply absent from the data and nothing looks wrong.
            failures.append(f"{club}: 200 but no data rows — check the club name")
            per_club[club] = 0
            continue
        kept = 0
        for r in raw:
            valid_from = _day(r.get("From", ""))
            if valid_from is None or (floor and valid_from < floor):
                continue
            rows.append({
                "club": r.get("Club") or club,
                "valid_from": valid_from,
                "valid_to": _day(r.get("To", "")),
                "country": r.get("Country"),
                "level": _int(r.get("Level", "")),
                "elo": _num(r.get("Elo", "")),
                "rank": _int(r.get("Rank", "")),
            })
            kept += 1
        per_club[club] = kept

    detail: dict[str, Any] = {
        "clubs_fetched": len(per_club),
        "rows": len(rows),
        "since": since,
        "failures": failures,
        "rows_per_club": per_club,
    }

    if dry_run:
        return detail

    with db.connect() as conn:
        with db.sync_run(conn, "clubelo") as state:
            teams = _resolve.load_team_resolver(conn)
            for row in rows:
                row["team_code"] = teams.code(row["club"])

            written = db.upsert(conn, "club_elo", rows, ("club", "valid_from"))
            resolved = sum(1 for r in rows if r["team_code"] is not None)

            detail.update({
                "rows_written": written,
                "rows_resolved_to_fpl_team": resolved,
                "unknown_clubs": teams.report(),
            })
            state["rows"] = written
            state["detail"] = detail

            # Raised inside the sync_run block on purpose. A partial fetch is worth failing
            # on — silently syncing 18 of 20 clubs would skew every Elo-based fixture
            # comparison — but raising after the block exits would record 'ok' in sync_runs
            # while the job actually failed, which is worse than either outcome alone.
            if failures:
                raise RuntimeError(
                    f"ClubElo fetch failed for {len(failures)} of {len(CLUBS)} clubs: "
                    f"{failures}"
                )

    return detail
