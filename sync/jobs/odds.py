"""Bookmaker odds from football-data.co.uk — the basis for real fixture difficulty.

FPL's `team_h_difficulty` is an integer 1-5 that FPL sets by hand. Market odds are
continuous, venue- and opponent-aware, and set by people with money at stake. De-vigged,
they're a strictly better difficulty input.

The vig (overround) is why raw odds can't be used directly: `1/odds` summed across all
outcomes exceeds 1, because the margin is baked in. Normalising by that sum removes it and
yields probabilities that sum to 1. This is the simple proportional method — good enough
here, and honest about what it is. Favourite-longshot bias means it slightly overstates
long odds, which matters for a betting model and not for ranking fixtures.

Clean-sheet probability is deliberately NOT derived here. It needs a Poisson fit over the
1X2 and over/under lines, which is modelling and belongs in the derived-views layer, not in
ingest. Ingest's job is to land the market's own numbers faithfully.

Note `2627/E0.csv` does not exist until matches are played — a 404 in preseason is the
expected state, not a failure.
"""

from __future__ import annotations

import csv
import io
from datetime import date, datetime
from typing import Any

from curl_cffi import requests as curl_requests

from .. import config, db
from ..fpl import FplClient
from . import _resolve

BASE = "https://www.football-data.co.uk/mmz4281"
IMPERSONATE = "chrome120"


def season_code(season: str) -> str:
    """'2025-26' -> '2526', which is how football-data.co.uk names its files."""
    start, end = season.split("-")
    return f"{start[2:]}{end}"


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _int(v: Any) -> int | None:
    n = _num(v)
    return None if n is None else int(n)


def _match_date(v: str) -> date | None:
    """The CSV uses dd/mm/yy and dd/mm/yyyy interchangeably across seasons."""
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(str(v).strip(), fmt).date()
        except (TypeError, ValueError):
            continue
    return None


def devig(odds: list[float | None]) -> list[float | None]:
    """Proportional de-vig: 1/odds, normalised so the outcomes sum to 1.

    Returns Nones unchanged if any outcome is missing — a partial market can't be
    normalised, and guessing would silently distort the probabilities.
    """
    if not odds or any(o is None or o <= 1.0 for o in odds):
        return [None] * len(odds)
    implied = [1.0 / o for o in odds]  # type: ignore[operator]
    total = sum(implied)
    if total <= 0:
        return [None] * len(odds)
    return [round(i / total, 5) for i in implied]


def fetch_season(season: str, timeout: int = 30) -> tuple[list[dict], int]:
    url = f"{BASE}/{season_code(season)}/E0.csv"
    resp = curl_requests.get(url, impersonate=IMPERSONATE, timeout=timeout)
    if resp.status_code != 200:
        return [], resp.status_code
    # utf-8-sig: the file carries a BOM that would otherwise end up inside the first
    # column name, making 'Div' unfindable.
    text = resp.content.decode("utf-8-sig", errors="replace")
    return list(csv.DictReader(io.StringIO(text))), 200


def build(rows: list[dict], season: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for r in rows:
        when = _match_date(r.get("Date", ""))
        home, away = (r.get("HomeTeam") or "").strip(), (r.get("AwayTeam") or "").strip()
        if not when or not home or not away:
            continue

        avg_h, avg_d, avg_a = (_num(r.get("AvgH")), _num(r.get("AvgD")), _num(r.get("AvgA")))
        avg_o, avg_u = _num(r.get("Avg>2.5")), _num(r.get("Avg<2.5"))
        p_h, p_d, p_a = devig([avg_h, avg_d, avg_a])
        p_o, p_u = devig([avg_o, avg_u])

        out.append({
            "season": season,
            "match_date": when,
            "home_team_raw": home,
            "away_team_raw": away,
            "kickoff_time": (r.get("Time") or "").strip() or None,
            "home_goals": _int(r.get("FTHG")),
            "away_goals": _int(r.get("FTAG")),
            "result": (r.get("FTR") or "").strip() or None,
            "avg_home": avg_h, "avg_draw": avg_d, "avg_away": avg_a,
            "avg_over_25": avg_o, "avg_under_25": avg_u,
            "p_home": p_h, "p_draw": p_d, "p_away": p_a,
            "p_over_25": p_o, "p_under_25": p_u,
            # All 132 columns retained so a new market (Asian handicap, closing prices,
            # shots) can be derived later without re-fetching a season.
            "raw": {k: v for k, v in r.items() if k and v not in (None, "")},
        })
    return out


def run(
    client: FplClient | None = None,
    *,
    dry_run: bool = False,
    season: str | None = None,
) -> dict[str, Any]:
    """Ingests the requested season, plus the current one when they differ.

    In preseason the current season's file doesn't exist yet, so the completed season
    carries the analysis until matches are played.
    """
    if season:
        wanted = [season]
    else:
        events = client.bootstrap()["events"] if client else []
        current = config.season_label(events) if events else None
        completed = config.aggregates_season(events) if events else "2025-26"
        wanted = [completed] + ([current] if current and current != completed else [])

    detail: dict[str, Any] = {"seasons_requested": wanted, "per_season": {}}
    all_rows: list[dict[str, Any]] = []

    for s in wanted:
        raw, status = fetch_season(s)
        if status != 200:
            # Expected in preseason: the current season's CSV appears once games are played.
            detail["per_season"][s] = f"HTTP {status} (not published yet)"
            continue
        rows = build(raw, s)
        detail["per_season"][s] = {
            "csv_rows": len(raw),
            "parsed": len(rows),
            "with_devigged_1x2": sum(1 for r in rows if r["p_home"] is not None),
            "with_devigged_ou25": sum(1 for r in rows if r["p_over_25"] is not None),
        }
        all_rows.extend(rows)

    if dry_run:
        detail["would_write"] = len(all_rows)
        if all_rows:
            sample = all_rows[0]
            detail["sample"] = {
                k: sample[k] for k in
                ("match_date", "home_team_raw", "away_team_raw", "avg_home",
                 "p_home", "p_draw", "p_away", "p_over_25")
            }
        return detail

    with db.connect() as conn:
        with db.sync_run(conn, "odds") as state:
            teams = _resolve.load_team_resolver(conn)
            for r in all_rows:
                r["home_team_code"] = teams.code(r["home_team_raw"])
                r["away_team_code"] = teams.code(r["away_team_raw"])

            written = db.upsert(
                conn, "match_odds", all_rows,
                ("season", "match_date", "home_team_raw", "away_team_raw"))

            detail.update({
                "rows_written": written,
                "both_teams_resolved": sum(
                    1 for r in all_rows
                    if r["home_team_code"] and r["away_team_code"]),
                "unknown_teams": teams.report(),
            })
            state["rows"] = written
            state["detail"] = detail

    return detail
