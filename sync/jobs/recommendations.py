"""Stamp what the app recommended, so it can be scored later.

Every other honesty mechanism here is a pre-ship gate: does this claim survive an independent
derivation, does this metric clear a reliability threshold, does this probability beat a trivial
baseline. None of them asks whether the answer turned out to be right. This job is the one that
does, and it is the only thing in the app that can say whether the app is worth trusting.

    python -m sync.cli recommendations --dry-run

**It writes only inside the deadline window, and never overwrites.** A recommendation is
scoreable only against the information available when it was made, so:

  - the job refuses to write outside `WINDOW_HOURS` before the deadline (and 10 minutes after it),
    because outside that window the source views describe a different gameweek;
  - rows go in with `insert_ignore`, so the first capture in the window is the one that stands and
    a second run cannot quietly restate it as the view drifts.

That is the whole integrity of the idea. A log that re-derives its own history always looks right.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from .. import config, db
from ..fpl import FplClient

# How long before the deadline the log may be written. Six hours is after the last Friday press
# conference and inside the window where the deep odds markets have opened, so it captures the
# recommendation a reader would actually have acted on rather than Tuesday's.
WINDOW_HOURS = 6

# Kinds and where each comes from. The two captain axes are separate kinds on purpose: migration
# 0012 refuses to collapse floor and ceiling into one ranking, and storing a single captain
# ordering here would undo that.
SOURCES: dict[str, dict[str, Any]] = {
    "captain_floor": {
        "sql": """
            select player_code, floor_score as score, combined_score, ceiling_score,
                   p_team_scores, minutes_share, xgi_per_90, opponent_short
            from captain_picks order by floor_score desc nulls last limit %s
        """,
        "limit": 10,
    },
    "captain_ceiling": {
        "sql": """
            select player_code, ceiling_score as score, combined_score, floor_score,
                   p_team_scores_2plus, big_chances_per_90, non_penalty_xg_per_90, opponent_short
            from captain_picks order by ceiling_score desc nulls last limit %s
        """,
        "limit": 10,
    },
    "target": {
        "sql": """
            select player_code, target_score, price, selected_by_percent, xgi_per_90,
                   points_per_million, fixture_rank, opponents
            from target_players order by target_score desc nulls last limit %s
        """,
        "limit": 15,
    },
    "sell": {
        "sql": """
            select player_code, reason_count, sell_reasons, sell_word, price,
                   selected_by_percent, minutes_moved, difficulty_swing
            from sell_candidates order by reason_count desc, player_code limit %s
        """,
        "limit": 15,
    },
}


def _jsonable(value: Any) -> Any:
    """Coerce a psycopg row value into something `json.dumps` accepts.

    `numeric` arrives as `Decimal`, which is not JSON serializable — found by simulating a
    deadline write in a rolled-back transaction rather than by discovering it at 17:30 on
    21 August, which is the only other time this code path runs.

    Float rather than str, deliberately, and it is the one place in this project where that is
    the right call: `basis` is a frozen *explanation*, never an input to a comparison. The
    Decimal-over-float rule exists because snapshot equality must not produce phantom changes
    from binary rounding, and nothing here is ever compared to anything.
    """
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def _window(deadline: datetime | None, now: datetime) -> tuple[bool, str]:
    """Whether the log may be written, and why not if it may not."""
    if deadline is None:
        return False, "no upcoming deadline"
    if now > deadline + timedelta(minutes=10):
        return False, f"deadline passed at {deadline.isoformat()}"
    if now < deadline - timedelta(hours=WINDOW_HOURS):
        hours = (deadline - now).total_seconds() / 3600
        return False, f"{hours:.1f}h before the deadline, window opens at {WINDOW_HOURS}h"
    return True, "in window"


def run(client: FplClient | None = None, *, dry_run: bool = False) -> dict[str, Any]:
    client = client or FplClient()
    boot = client.bootstrap()
    events = boot["events"]
    season = config.season_label(events)
    event_id = config.next_event_id(events)

    now = datetime.now(timezone.utc)
    deadline = None
    for e in events:
        if e["id"] == event_id and e.get("deadline_time"):
            deadline = datetime.fromisoformat(str(e["deadline_time"]).replace("Z", "+00:00"))
            break

    may_write, why = _window(deadline, now)
    detail: dict[str, Any] = {
        "season": season,
        "event": event_id,
        "deadline": deadline.isoformat() if deadline else None,
        "in_window": may_write,
        "why": why,
    }

    if not may_write:
        # Not an error. Most runs of this job are outside the window by design, and a job that
        # went red for doing the right thing would be turned off within a week.
        return detail

    with db.connect() as conn:
        with db.sync_run(conn, "recommendations") as state:
            written, per_kind = 0, {}
            for kind, spec in SOURCES.items():
                rows = db.fetch(conn, spec["sql"], (spec["limit"],))
                payload = []
                for rank, r in enumerate(rows, start=1):
                    code = r.pop("player_code")
                    payload.append({
                        "season": season,
                        "event": event_id,
                        "kind": kind,
                        "player_code": code,
                        "rank": rank,
                        # Everything the source said about this player at this instant. Frozen,
                        # because next week's `captain_picks` is not what we said this week.
                        "basis": {k: _jsonable(v) for k, v in r.items()},
                    })
                if payload:
                    # insert_ignore, never upsert: the first capture in the window stands.
                    n = db.insert_ignore(
                        conn, "recommendation_log", payload,
                        ("season", "event", "kind", "player_code"))
                    written += n
                    per_kind[kind] = {"candidates": len(payload), "inserted": n}
                else:
                    per_kind[kind] = {"candidates": 0, "inserted": 0}

            detail["kinds"] = per_kind
            detail["rows_written"] = written
            state["rows"] = written
            state["detail"] = detail

    return detail
