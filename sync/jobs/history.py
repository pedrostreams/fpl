"""Per-gameweek and per-season history from `element-summary/{id}`.

One request per player (~558), so this is a daily job, rate-limited to stay a polite
client. Field access is defensive `.get()` throughout because `history` is empty in
preseason — the shape can only be confirmed once GW1 has been played, and a rename
should degrade to a null column rather than crash the run.
"""

from __future__ import annotations

import time
from typing import Any

from .. import config, db
from ..fpl import FplClient, as_bool, as_int, as_num, as_ts

REQUEST_DELAY = 0.25  # ~140s for a full pass; polite and well inside any rate limit

INT_STATS = (
    "total_points", "minutes", "goals_scored", "assists", "clean_sheets",
    "goals_conceded", "own_goals", "penalties_saved", "penalties_missed",
    "yellow_cards", "red_cards", "saves", "bonus", "bps",
    "clearances_blocks_interceptions", "recoveries", "tackles",
    "defensive_contribution", "starts",
)
NUM_STATS = (
    "influence", "creativity", "threat", "ict_index", "expected_goals",
    "expected_assists", "expected_goal_involvements", "expected_goals_conceded",
)


def normalise_season(name: str) -> str:
    """FPL writes past seasons as '2024/25'; we store '2024-25' everywhere."""
    return str(name).replace("/", "-")


def gw_row(h: dict, season: str, player_code: int, team_code_by_id: dict) -> dict:
    return {
        "season": season,
        "player_code": player_code,
        "event": as_int(h.get("round")) or 0,
        "fixture": as_int(h.get("fixture")) or 0,
        "opponent_team_code": team_code_by_id.get(h.get("opponent_team")),
        "was_home": as_bool(h.get("was_home")),
        "kickoff_time": as_ts(h.get("kickoff_time")),
        "team_h_score": as_int(h.get("team_h_score")),
        "team_a_score": as_int(h.get("team_a_score")),
        **{k: as_int(h.get(k)) for k in INT_STATS},
        **{k: as_num(h.get(k)) for k in NUM_STATS},
        "value": as_int(h.get("value")),
        "selected": as_int(h.get("selected")),
        "transfers_in": as_int(h.get("transfers_in")),
        "transfers_out": as_int(h.get("transfers_out")),
        "transfers_balance": as_int(h.get("transfers_balance")),
    }


def past_row(p: dict, player_code: int) -> dict:
    return {
        "season": normalise_season(p.get("season_name", "")),
        "player_code": player_code,
        "source": "history_past",
        "start_cost": as_int(p.get("start_cost")),
        "end_cost": as_int(p.get("end_cost")),
        **{k: as_int(p.get(k)) for k in INT_STATS},
        **{k: as_num(p.get(k)) for k in NUM_STATS},
    }


def run(
    client: FplClient,
    *,
    dry_run: bool = False,
    limit: int | None = None,
) -> dict[str, Any]:
    bootstrap = client.bootstrap()
    events = bootstrap["events"]
    season = config.season_label(events)
    team_code_by_id = {t["id"]: t["code"] for t in bootstrap["teams"]}

    elements = bootstrap["elements"]
    if limit:
        elements = elements[:limit]

    gw_rows: list[dict] = []
    past_rows: list[dict] = []
    seasons_seen: set[str] = set()
    failures: list[int] = []

    for i, e in enumerate(elements):
        try:
            summary = client.element_summary(e["id"])
        except Exception:
            failures.append(e["id"])
            continue

        for h in summary.get("history", []):
            gw_rows.append(gw_row(h, season, e["code"], team_code_by_id))
        for p in summary.get("history_past", []):
            row = past_row(p, e["code"])
            if row["season"]:
                past_rows.append(row)
                seasons_seen.add(row["season"])

        if i < len(elements) - 1:
            time.sleep(REQUEST_DELAY)

    # history_past.season has an FK-free column, but seasons rows keep joins predictable.
    season_rows = [
        {"name": s, "is_current": s == season, "gw1_deadline": None}
        for s in sorted(seasons_seen)
        if s != season
    ]

    detail: dict[str, Any] = {
        "season": season,
        "players_fetched": len(elements) - len(failures),
        "gw_rows": len(gw_rows),
        "history_past_rows": len(past_rows),
        "past_seasons": sorted(seasons_seen),
        "failures": failures,
    }

    if dry_run:
        return detail

    with db.connect() as conn:
        with db.sync_run(conn, "history") as state:
            written = db.upsert(conn, "seasons", season_rows, ("name",))
            written += db.upsert(
                conn, "player_gw_stats", gw_rows,
                ("season", "player_code", "event", "fixture"),
            )
            written += db.upsert(
                conn, "player_season_totals", past_rows,
                ("season", "player_code", "source"),
            )
            state["rows"] = written
            state["detail"] = detail
    detail["rows_written"] = written
    return detail
