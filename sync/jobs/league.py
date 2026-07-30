"""The mini-league — members, standings, and every rival's squad.

Effective ownership is only worth computing against the people you are actually playing, and
that needs their picks, which needs their entry ids, which needs the league. All three come
from one endpoint.

    leagues-classic/{id}/standings/   200 — league meta, `standings`, `new_entries`

**Read both lists.** Probed 2026-07-30 on league 422500 ("Hakuna Mateta", created that morning):
`standings.results` is `[]` and `new_entries.results` holds both members. Before the season
starts, `new_entries` is the *only* list there is — a job reading `standings` alone reports an
empty league that is not empty, and the page built on it would be convincingly wrong. Each list
paginates on its own parameter and its own `has_next`, so both are walked.

Rivals' picks land in `manager_picks`, the same table as mine: same grain, same key, same
element-to-code resolution. `my_squad` joins `managers` so that sharing the table cannot turn my
squad screen into everyone's.

    python -m sync.cli league --dry-run
"""

from __future__ import annotations

import os
from typing import Any

from .. import config, db
from ..fpl import FplClient, as_int, as_text, as_ts
from .manager import build_picks

# Hakuna Mateta. Public — a league id appears in the URL of every standings page — so a default
# beats making the job depend on an env var. Override with FPL_LEAGUE_ID.
DEFAULT_LEAGUE_ID = 422500

# A friend group, not the global leaderboard. If this is ever exceeded the league is not the kind
# of league this feature is for, and walking 200 pages of picks would be a different job.
MAX_PAGES = 20


def league_id() -> int:
    raw = os.environ.get("FPL_LEAGUE_ID")
    return int(raw) if raw and raw.strip().isdigit() else DEFAULT_LEAGUE_ID


def build_league(payload: dict) -> dict[str, Any]:
    lg = payload.get("league") or {}
    return {
        "league_id": as_int(lg.get("id")),
        "name": as_text(lg.get("name")),
        "league_type": as_text(lg.get("league_type")),
        "admin_entry": as_int(lg.get("admin_entry")),
        "start_event": as_int(lg.get("start_event")),
        "created": as_ts(lg.get("created")),
    }


def build_entries(standings: list[dict], new_entries: list[dict],
                  lid: int) -> list[dict[str, Any]]:
    """One row per member, `standings` winning where a member appears in both.

    The two sections carry different fields for the same person: `standings` has rank and points
    and no join time, `new_entries` has a join time and no rank. Unioning on `entry` rather than
    concatenating is what stops a member who has started playing being stored twice.
    """
    rows: dict[int, dict[str, Any]] = {}

    for e in new_entries or []:
        eid = as_int(e.get("entry"))
        if eid is None:
            continue
        rows[eid] = {
            "league_id": lid,
            "entry_id": eid,
            "entry_name": as_text(e.get("entry_name")),
            "player_name": " ".join(
                p for p in (as_text(e.get("player_first_name")),
                            as_text(e.get("player_last_name"))) if p
            ) or None,
            "joined_at": as_ts(e.get("joined_time")),
            "rank": None,
            "last_rank": None,
            "total": None,
            "event_total": None,
            "source": "new_entries",
        }

    for s in standings or []:
        eid = as_int(s.get("entry"))
        if eid is None:
            continue
        prior = rows.get(eid, {})
        rows[eid] = {
            "league_id": lid,
            "entry_id": eid,
            "entry_name": as_text(s.get("entry_name")),
            "player_name": as_text(s.get("player_name")),
            # Only `new_entries` carries it, so keep whatever that pass found.
            "joined_at": prior.get("joined_at"),
            "rank": as_int(s.get("rank")),
            "last_rank": as_int(s.get("last_rank")),
            "total": as_int(s.get("total")),
            "event_total": as_int(s.get("event_total")),
            "source": "standings",
        }

    return list(rows.values())


def _walk(client: FplClient, lid: int) -> tuple[dict, list[dict], list[dict]]:
    """Every page of both lists. Returns (first payload, standings, new_entries)."""
    first = client.league_standings(lid)
    standings = list((first.get("standings") or {}).get("results") or [])
    new_entries = list((first.get("new_entries") or {}).get("results") or [])

    page = 1
    while (first.get("standings") or {}).get("has_next") and page < MAX_PAGES:
        page += 1
        nxt = client.league_standings(lid, page=page)
        results = (nxt.get("standings") or {}).get("results") or []
        standings.extend(results)
        if not (nxt.get("standings") or {}).get("has_next"):
            break

    page = 1
    while (first.get("new_entries") or {}).get("has_next") and page < MAX_PAGES:
        page += 1
        nxt = client.league_standings(lid, new_entries_page=page)
        results = (nxt.get("new_entries") or {}).get("results") or []
        new_entries.extend(results)
        if not (nxt.get("new_entries") or {}).get("has_next"):
            break

    return first, standings, new_entries


def run(client: FplClient | None = None, *, dry_run: bool = False) -> dict[str, Any]:
    client = client or FplClient()
    lid = league_id()
    season = config.season_label(client.bootstrap()["events"])

    payload, standings, new_entries = _walk(client, lid)
    league = build_league(payload)
    entries = build_entries(standings, new_entries, lid)

    detail: dict[str, Any] = {
        "league_id": lid,
        "season": season,
        "name": league["name"],
        "members": len(entries),
        "from_standings": sum(1 for e in entries if e["source"] == "standings"),
        "from_new_entries": sum(1 for e in entries if e["source"] == "new_entries"),
    }

    if league["league_id"] is None:
        raise RuntimeError(f"league {lid}: payload carried no league id")

    if dry_run:
        detail["entries"] = [
            {"entry": e["entry_id"], "name": e["entry_name"], "source": e["source"]}
            for e in entries
        ]
        return detail

    with db.connect() as conn:
        with db.sync_run(conn, "league") as state:
            written = db.upsert(conn, "leagues", [league], ("league_id",))
            if entries:
                written += db.upsert(
                    conn, "league_entries", entries, ("league_id", "entry_id"))

            # Rivals' squads. The same 404 rule as my own: before the GW1 deadline nobody's picks
            # exist, so this loop makes one request per member and stores nothing, which is the
            # expected state rather than a failure.
            codes = {
                r["fpl_id"]: r["player_code"]
                for r in db.fetch(
                    conn,
                    "select fpl_id, player_code from player_seasons where season = %s",
                    (season,),
                )
            }
            # The gameweek to fetch picks for. Taken from `managers.current_event` — my own
            # entry's view of where the season is — rather than from `events`, because it is the
            # same number the manager job uses and the two must not disagree about which
            # gameweek's squads are being compared. 0 in preseason, and the loop is skipped.
            current = db.fetch(
                conn,
                "select coalesce(max(current_event), 0) as e from managers",
            )[0]["e"] or 0

            stored, unavailable, unresolved = 0, [], []
            if current:
                for e in entries:
                    picks = client.entry_picks_optional(e["entry_id"], current)
                    if picks is None:
                        unavailable.append(e["entry_id"])
                        continue
                    rows, missing = build_picks(
                        picks, e["entry_id"], season, current, codes)
                    unresolved.extend(missing)
                    if rows:
                        written += db.upsert(
                            conn, "manager_picks", rows,
                            ("entry_id", "season", "event", "player_code"))
                        stored += len(rows)

            detail["picks"] = {
                "event": current or None,
                "rows": stored,
                "not_published": unavailable,
                "unresolved_elements": unresolved,
            }
            detail["rows_written"] = written
            state["rows"] = written
            state["detail"] = detail

    return detail
