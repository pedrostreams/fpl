"""The manager's own team — record, history, and (once it exists) the squad.

Three endpoints, and only two of them work before the season starts. Verified 2026-07-26
against entry 1617827:

    entry/{id}/               200 — team name, manager name, favourite club, started event
    entry/{id}/history/       200 — 10 past seasons with points and overall rank
    entry/{id}/event/1/picks/ 404 — **the squad does not exist until the GW1 deadline passes**

That 404 is the expected preseason state, not a failure, and the job records how many
gameweeks of picks it managed to store so `verify` can tell "not published yet" from "the
endpoint changed shape". The moment the deadline passes, picks start returning and this job
begins populating them with no code change.

Note the leagues in the payload: all five of Peder's are `league_type = 's'`, FPL's own
system leagues (Arsenal, Norway, Gameweek 1, Overall, Top 10%). A friend-group mini-league is
`league_type = 'x'` and there is not one yet — so mini-league effective ownership is blocked
on the league being *created*, not on anyone finding its id.

    python -m sync.cli manager --dry-run
"""

from __future__ import annotations

import os
from typing import Any

from .. import db
from ..fpl import FplClient, as_int, as_num, as_text

# Peder's entry. Not a secret — an FPL entry id is public — so a default here beats making
# every run depend on an env var being present. Override with FPL_ENTRY_ID.
DEFAULT_ENTRY_ID = 1617827


def entry_id() -> int:
    raw = os.environ.get("FPL_ENTRY_ID")
    return int(raw) if raw and raw.strip().isdigit() else DEFAULT_ENTRY_ID


def build_manager(payload: dict, eid: int) -> dict[str, Any]:
    return {
        "entry_id": eid,
        "name": as_text(payload.get("name")),
        "player_name": " ".join(
            p for p in (as_text(payload.get("player_first_name")),
                        as_text(payload.get("player_last_name"))) if p
        ) or None,
        # `favourite_team` is a season-scoped team id, not a code, so it is resolved against
        # team_seasons rather than stored raw.
        "favourite_team": None,
        "started_event": as_int(payload.get("started_event")),
        "current_event": as_int(payload.get("current_event")),
        # These read None in preseason: there has been no deadline yet to bank against.
        "bank": None if payload.get("last_deadline_bank") is None
                else as_num(payload["last_deadline_bank"]) / 10,
        "squad_value": None if payload.get("last_deadline_value") is None
                       else as_num(payload["last_deadline_value"]) / 10,
        "total_transfers": as_int(payload.get("last_deadline_total_transfers")),
        "overall_points": as_int(payload.get("summary_overall_points")),
        "overall_rank": as_int(payload.get("summary_overall_rank")),
    }


def build_seasons(history: dict, eid: int) -> list[dict[str, Any]]:
    out = []
    for s in history.get("past", []) or []:
        name = as_text(s.get("season_name"))
        if not name:
            continue
        out.append({
            "entry_id": eid,
            "season_name": name,
            "total_points": as_int(s.get("total_points")),
            "rank": as_int(s.get("rank")),
        })
    return out


def run(client: FplClient | None = None, *, dry_run: bool = False) -> dict[str, Any]:
    client = client or FplClient()
    eid = entry_id()
    detail: dict[str, Any] = {"entry_id": eid}

    entry = client.entry(eid)
    history = client.entry_history(eid)

    manager = build_manager(entry, eid)
    seasons = build_seasons(history, eid)

    # League shape, so the mini-league question is answered by data rather than by asking.
    leagues = (entry.get("leagues") or {}).get("classic") or []
    detail["leagues"] = {
        "total": len(leagues),
        "system": sum(1 for lg in leagues if lg.get("league_type") == "s"),
        "invitational": [
            {"id": lg.get("id"), "name": lg.get("name"), "size": lg.get("rank_count")}
            for lg in leagues if lg.get("league_type") == "x"
        ],
    }
    detail["manager"] = {k: manager[k] for k in ("name", "player_name", "started_event")}
    detail["past_seasons"] = len(seasons)

    # The squad. 404 before the first deadline, which is why this is a probe and not a fetch.
    picks_event = manager["current_event"] or manager["started_event"] or 1
    picks = client.entry_picks_optional(eid, picks_event)
    detail["picks"] = (
        {"event": picks_event, "players": len(picks.get("picks") or [])}
        if picks else
        {"event": picks_event, "available": False,
         "why": "404 — the squad is not published until the GW1 deadline passes"}
    )

    if dry_run:
        return detail

    with db.connect() as conn:
        with db.sync_run(conn, "manager") as state:
            # Resolve favourite_team from the season-scoped id the payload uses.
            fav = as_int(entry.get("favourite_team"))
            if fav is not None:
                row = db.fetch(conn, """
                    select team_code from team_seasons
                    where fpl_id = %s and season = (select current_season from season_context)
                """, (fav,))
                manager["favourite_team"] = row[0]["team_code"] if row else None

            written = db.upsert(conn, "managers", [manager], ("entry_id",))
            if seasons:
                written += db.upsert(
                    conn, "manager_seasons", seasons, ("entry_id", "season_name"))

            detail["rows_written"] = written
            state["rows"] = written
            state["detail"] = detail

    return detail
