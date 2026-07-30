"""The manager's own team — record, history, squad, transfers and chips.

Four endpoints, and only three of them work before the season starts. Verified 2026-07-26 and
re-probed 2026-07-30 against entry 1617827:

    entry/{id}/               200 — team name, manager name, favourite club, started event
    entry/{id}/history/       200 — past seasons; `current` and `chips` are [] in preseason
    entry/{id}/transfers/     200 — **an empty list**, not a 404, so it needs no gate
    entry/{id}/event/1/picks/ 404 — **the squad does not exist until the GW1 deadline passes**

That 404 is the expected preseason state, not a failure, and the job records how many
gameweeks of picks it managed to store so `verify` can tell "not published yet" from "the
endpoint changed shape". The moment the deadline passes, picks start returning and this job
begins populating them with no code change.

**Every `element` in these payloads is a season-scoped id**, not a code, so it is resolved
through `player_seasons.fpl_id` before anything is written — CLAUDE.md's second rule. An
element that does not resolve is counted and dropped, never stored against a guess.

Leagues: **corrected 2026-07-30.** This note used to say all five of Peder's leagues were
`league_type = 's'` — FPL's own system leagues — and that mini-league effective ownership was
therefore blocked on a league being *created*. That was true on 2026-07-26 and is not any more:
Peder created **Hakuna Mateta, id 422500**, on 2026-07-30. `sync/jobs/league.py` reads it.

    python -m sync.cli manager --dry-run
"""

from __future__ import annotations

import os
from typing import Any

from .. import config, db
from ..fpl import FplClient, as_int, as_num, as_text, as_ts

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


def build_events(history: dict, eid: int, season: str) -> list[dict[str, Any]]:
    """`history.current` — one row per gameweek played. Empty until GW1 completes."""
    out = []
    for e in history.get("current", []) or []:
        event = as_int(e.get("event"))
        if event is None:
            continue
        out.append({
            "entry_id": eid,
            "season": season,
            "event": event,
            "points": as_int(e.get("points")),
            "total_points": as_int(e.get("total_points")),
            "rank": as_int(e.get("rank")),
            "overall_rank": as_int(e.get("overall_rank")),
            # Tenths in the payload, millions everywhere in this schema.
            "bank": None if e.get("bank") is None else as_num(e["bank"]) / 10,
            "squad_value": None if e.get("value") is None else as_num(e["value"]) / 10,
            "event_transfers": as_int(e.get("event_transfers")),
            "transfers_cost": as_int(e.get("event_transfers_cost")),
            "points_on_bench": as_int(e.get("points_on_bench")),
        })
    return out


def build_chips(history: dict, eid: int, season: str) -> list[dict[str, Any]]:
    out = []
    for c in history.get("chips", []) or []:
        name, event = as_text(c.get("name")), as_int(c.get("event"))
        if not name or event is None:
            continue
        out.append({"entry_id": eid, "season": season, "event": event,
                    "chip": name, "played_at": as_ts(c.get("time"))})
    return out


def build_picks(payload: dict, eid: int, season: str, event: int,
                codes: dict[int, int]) -> tuple[list[dict[str, Any]], list[int]]:
    """Rows plus the elements that could not be resolved.

    Dropping an unresolved element rather than storing it is the same doctrine as the
    cross-source matcher: a wrong id does not error, it silently attributes one player's
    points to another. The caller reports the count so a silent drop cannot pass for a
    fourteen-man squad.
    """
    rows, unresolved = [], []
    for p in payload.get("picks", []) or []:
        element = as_int(p.get("element"))
        code = codes.get(element) if element is not None else None
        if code is None:
            if element is not None:
                unresolved.append(element)
            continue
        rows.append({
            "entry_id": eid,
            "season": season,
            "event": event,
            "player_code": code,
            "pick_position": as_int(p.get("position")),
            "multiplier": as_int(p.get("multiplier")) or 0,
            "is_captain": bool(p.get("is_captain")),
            "is_vice": bool(p.get("is_vice_captain")),
        })
    return rows, unresolved


def build_transfers(payload: list[dict], eid: int, season: str,
                    codes: dict[int, int]) -> tuple[list[dict[str, Any]], int]:
    rows, dropped = [], 0
    for t in payload or []:
        ein, eout = as_int(t.get("element_in")), as_int(t.get("element_out"))
        cin, cout = codes.get(ein or -1), codes.get(eout or -1)
        made = as_ts(t.get("time"))
        event = as_int(t.get("event"))
        if cin is None or cout is None or made is None or event is None:
            dropped += 1
            continue
        rows.append({
            "entry_id": eid,
            "season": season,
            "event": event,
            "player_in": cin,
            "player_out": cout,
            "price_in": None if t.get("element_in_cost") is None
                        else as_num(t["element_in_cost"]) / 10,
            "price_out": None if t.get("element_out_cost") is None
                         else as_num(t["element_out_cost"]) / 10,
            "made_at": made,
        })
    return rows, dropped


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


def _element_codes(conn, season: str) -> dict[int, int]:
    """Season-scoped element id → stable player code."""
    return {
        r["fpl_id"]: r["player_code"]
        for r in db.fetch(
            conn,
            "select fpl_id, player_code from player_seasons where season = %s",
            (season,),
        )
    }


def run(client: FplClient | None = None, *, dry_run: bool = False) -> dict[str, Any]:
    client = client or FplClient()
    eid = entry_id()
    # From the bootstrap rather than from `season_context`, so the label is derived the same way
    # every other job derives it — GW1's deadline year — and cannot disagree with them. The
    # client caches the payload, so this costs nothing on a run that has already fetched it.
    season = config.season_label(client.bootstrap()["events"])
    detail: dict[str, Any] = {"entry_id": eid, "season": season}

    entry = client.entry(eid)
    history = client.entry_history(eid)
    transfers_raw = client.entry_transfers(eid)

    manager = build_manager(entry, eid)
    seasons = build_seasons(history, eid)
    events = build_events(history, eid, season)
    chips = build_chips(history, eid, season)

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
    detail["events"] = len(events)
    detail["chips"] = [c["chip"] for c in chips]

    # Every gameweek that has been played, plus the one in progress. Empty in preseason, so the
    # loop below makes no requests at all rather than probing 38 times for a guaranteed 404.
    last_event = manager["current_event"] or 0
    wanted = sorted({e["event"] for e in events} | ({last_event} if last_event else set()))
    detail["picks_requested"] = wanted

    if dry_run:
        # One probe, so a dry run still reports whether the squad has been published without
        # walking the whole season.
        probe_event = last_event or manager["started_event"] or 1
        probe = client.entry_picks_optional(eid, probe_event)
        detail["picks"] = (
            {"event": probe_event, "players": len(probe.get("picks") or [])}
            if probe else
            {"event": probe_event, "available": False,
             "why": "404 — the squad is not published until the GW1 deadline passes"}
        )
        detail["transfers"] = len(transfers_raw or [])
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
            if events:
                written += db.upsert(
                    conn, "manager_events", events, ("entry_id", "season", "event"))
            if chips:
                written += db.upsert(
                    conn, "manager_chips", chips, ("entry_id", "season", "event", "chip"),
                    touch=None)

            codes = _element_codes(conn, season)

            transfers, dropped = build_transfers(transfers_raw, eid, season, codes)
            if transfers:
                written += db.insert_ignore(
                    conn, "manager_transfers", transfers,
                    ("entry_id", "season", "event", "player_in", "player_out", "made_at"))
            detail["transfers"] = {"stored": len(transfers), "unresolved": dropped}

            stored, missing, unavailable = 0, [], []
            for event in wanted:
                payload = client.entry_picks_optional(eid, event)
                if payload is None:
                    unavailable.append(event)
                    continue
                rows, unresolved = build_picks(payload, eid, season, event, codes)
                missing.extend(unresolved)
                if rows:
                    written += db.upsert(
                        conn, "manager_picks", rows,
                        ("entry_id", "season", "event", "player_code"))
                    stored += len(rows)

            detail["picks"] = {
                "gameweeks": len(wanted) - len(unavailable),
                "rows": stored,
                # A 404 here is "not published yet" and is the whole preseason state. It is
                # reported, never raised.
                "not_published": unavailable,
                # Non-empty means an element in my own squad is not in `player_seasons`, which
                # would show as a squad of fewer than fifteen. `my_squad_check` asserts on it.
                "unresolved_elements": missing,
            }

            detail["rows_written"] = written
            state["rows"] = written
            state["detail"] = detail

    return detail
