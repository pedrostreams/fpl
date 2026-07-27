"""player_snapshots — the only data that cannot be backfilled.

The FPL API exposes current state only; there is no history endpoint. Any moment we fail
to sample is gone permanently, which is why this job runs hourly (and every 15 minutes
across the nightly price window) from before the season starts.

Written insert-on-change: a naive hourly insert of all 558 players is ~4M rows/season,
roughly 600 MB with indexes, over Supabase's 500 MB free tier. Comparing against each
player's previous row keeps every transition while dropping the long flat runs.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timezone
from typing import Any

from .. import config, db
from ..fpl import FplClient, as_int, as_num, as_text

# Any move in one of these writes a new row. Deliberately excludes the cumulative
# `transfers_in` / `transfers_out`: within a gameweek they carry the same signal as the
# _event counters, so watching them would force a row for every player every hour.
WATCHED = (
    "now_cost",
    "selected_by_percent",
    "transfers_in_event",
    "transfers_out_event",
    "cost_change_event",
    "cost_change_start",
    "price_change_percent",
    "status",
    "chance_of_playing_next_round",
    "form",
    "ep_next",
)


def _row(element: dict, season: str, event: int | None, captured_at: datetime) -> dict:
    return {
        "season": season,
        "player_code": element["code"],
        "captured_at": captured_at,
        "event": event,
        "now_cost": as_int(element.get("now_cost")),
        "selected_by_percent": as_num(element.get("selected_by_percent")),
        "transfers_in_event": as_int(element.get("transfers_in_event")),
        "transfers_out_event": as_int(element.get("transfers_out_event")),
        "transfers_in": as_int(element.get("transfers_in")),
        "transfers_out": as_int(element.get("transfers_out")),
        "cost_change_event": as_int(element.get("cost_change_event")),
        "cost_change_event_fall": as_int(element.get("cost_change_event_fall")),
        "cost_change_start": as_int(element.get("cost_change_start")),
        "cost_change_start_fall": as_int(element.get("cost_change_start_fall")),
        "price_change_percent": as_num(element.get("price_change_percent")),
        "form": as_num(element.get("form")),
        "ep_this": as_num(element.get("ep_this")),
        "ep_next": as_num(element.get("ep_next")),
        "status": as_text(element.get("status")),
        "chance_of_playing_next_round": as_int(element.get("chance_of_playing_next_round")),
        "news": as_text(element.get("news")),
        "total_points": as_int(element.get("total_points")),
        "event_points": as_int(element.get("event_points")),
    }


def _latest_by_player(conn, season: str) -> dict[int, dict]:
    """Most recent snapshot per player. DISTINCT ON is the cheap Postgres idiom here and
    uses the (player_code, captured_at desc) index directly."""
    rows = db.fetch(
        conn,
        """
        select distinct on (player_code) *
        from player_snapshots
        where season = %s
        order by player_code, captured_at desc
        """,
        (season,),
    )
    return {r["player_code"]: r for r in rows}


def _changed(new: dict, prev: dict | None) -> bool:
    if prev is None:
        return True
    # Both sides are Decimal for numeric columns, and Decimal equality is by value, so
    # Decimal('74.600') == Decimal('74.6'). No float rounding involved.
    return any(new[f] != prev.get(f) for f in WATCHED)


def _price_event(new: dict, prev: dict) -> dict | None:
    old_cost, new_cost = prev.get("now_cost"), new["now_cost"]
    if old_cost is None or new_cost is None or old_cost == new_cost:
        return None
    return {
        "season": new["season"],
        "player_code": new["player_code"],
        "changed_at": new["captured_at"],
        "old_cost": old_cost,
        "new_cost": new_cost,
        # The state that preceded the move — the model's features.
        "prev_captured_at": prev.get("captured_at"),
        "prev_transfers_in_event": prev.get("transfers_in_event"),
        "prev_transfers_out_event": prev.get("transfers_out_event"),
        "prev_selected_by_percent": prev.get("selected_by_percent"),
        "prev_price_change_percent": prev.get("price_change_percent"),
    }


def _register_new_players(conn, elements: Sequence[dict]) -> int:
    """Give any unknown player an identity row, so the capture cannot die on a signing.

    `player_snapshots.player_code` references `players.code`, and `players` is written by the
    **daily** `dimensions` job. The snapshot runs hourly. So for up to 24 hours after FPL adds
    a player, this job inserted a row referencing a code that did not exist yet — and because
    the insert is chunked into one statement, a single new player aborted the whole transaction
    and lost *everyone's* capture, not just theirs.

    That is exactly what happened on 2026-07-27: five transfer-window signings appeared in
    bootstrap (Penders, Anselmino, Morita, Maeda, Bamba) and the hourly job failed for 4h42m
    on `player_snapshots_player_code_fkey`. The transfer window runs to the end of August, so
    this would have recurred every time a club registered anyone.

    Registering the identity here rather than skipping the player: every column of `players`
    except `code` is nullable and bootstrap already carries the names, so there is no reason to
    lose the new player's first day of ownership drift either. `dimensions` fills in the rest —
    known_name, birth_date, region, opta_code — on its next run and keeps it current.
    """
    codes = [e["code"] for e in elements]
    # db.fetch, not a raw cursor: the connection uses a dict row factory, so r[0] raises
    # KeyError rather than returning the first column.
    known = {
        r["code"]
        for r in db.fetch(conn, "select code from players where code = any(%s)", (codes,))
    }

    missing = [
        {
            "code": e["code"],
            "first_name": as_text(e.get("first_name")),
            "second_name": as_text(e.get("second_name")),
            "web_name": as_text(e.get("web_name")),
            "photo": as_text(e.get("photo")),
            "updated_at": datetime.now(timezone.utc),
        }
        for e in elements
        if e["code"] not in known
    ]
    if not missing:
        return 0
    return db.insert_ignore(conn, "players", missing, ("code",))


def run(client: FplClient, *, dry_run: bool = False) -> dict[str, Any]:
    bootstrap = client.bootstrap()
    events = bootstrap["events"]
    season = config.season_label(events)
    event = config.next_event_id(events)
    captured_at = datetime.now(timezone.utc).replace(microsecond=0)

    candidates = [_row(e, season, event, captured_at) for e in bootstrap["elements"]]

    detail: dict[str, Any] = {
        "season": season,
        "event": event,
        "captured_at": captured_at.isoformat(),
        "candidates": len(candidates),
        "preseason": config.is_preseason(events),
    }

    if dry_run:
        # Without a DB there is no previous row to diff against, so report the ceiling
        # and the fields that would be watched.
        detail["would_insert_max"] = len(candidates)
        detail["watched"] = list(WATCHED)
        return detail

    with db.connect() as conn:
        with db.sync_run(conn, "snapshot") as state:
            new_players = _register_new_players(conn, bootstrap["elements"])
            detail["new_players"] = new_players

            previous = _latest_by_player(conn, season)

            to_insert, price_events = [], []
            for row in candidates:
                prev = previous.get(row["player_code"])
                if not _changed(row, prev):
                    continue
                to_insert.append(row)
                if prev is not None:
                    pe = _price_event(row, prev)
                    if pe:
                        price_events.append(pe)

            inserted = db.insert_ignore(
                conn, "player_snapshots", to_insert,
                ("season", "player_code", "captured_at"),
            )
            prices = db.insert_ignore(
                conn, "player_price_events", price_events,
                ("season", "player_code", "changed_at"),
            )

            detail.update({
                "inserted": inserted,
                "skipped_unchanged": len(candidates) - len(to_insert),
                "price_events": prices,
                "first_run": not previous,
            })
            state["rows"] = inserted + prices
            state["detail"] = detail
    return detail
