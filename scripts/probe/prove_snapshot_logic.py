"""Prove player_snapshots' insert-on-change comparison works in both directions.

Why this exists as its own check: a comparison bug that always reported "unchanged" would
silently discard every snapshot, and the run would still look clean — 0 inserted, no
errors, exit 0. Since the FPL API has no history endpoint, that failure is unrecoverable.
It is the one piece of logic in this repo whose silent failure costs data permanently.

Runs without a database so it can gate CI: the "previous" row is a copy of a live one,
which is a fair stand-in because psycopg returns `numeric` as Decimal and `_row` already
produces Decimal. The DB round-trip itself was verified separately against Supabase on
2026-07-26 — numeric(6,3) stores 74.6 as Decimal('74.600'), and Decimal compares by value,
so Decimal('74.600') == Decimal('74.6') is True and no phantom change is produced.

    python scripts/probe/prove_snapshot_logic.py

Exit code is the number of undetected fields, so any regression fails the build.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sync import config  # noqa: E402
from sync.fpl import FplClient  # noqa: E402
from sync.jobs.snapshot import WATCHED, _changed, _price_event, _row  # noqa: E402

# One mutation per watched field. Each must be detected on its own — testing them
# together would let a single working field mask ten broken ones.
BUMPS = {
    "now_cost": lambda v: (v or 0) + 1,
    "selected_by_percent": lambda v: (v or Decimal(0)) + 1,
    "transfers_in_event": lambda v: (v or 0) + 1,
    "transfers_out_event": lambda v: (v or 0) + 1,
    "cost_change_event": lambda v: (v or 0) + 1,
    "cost_change_start": lambda v: (v or 0) + 1,
    "price_change_percent": lambda v: (v or Decimal(0)) + 1,
    "status": lambda v: "i" if v != "i" else "a",
    "chance_of_playing_next_round": lambda v: 25 if v != 25 else 50,
    # Added with WATCHED in 0036. The news mutation has to differ from the real value whatever it
    # is, including the empty string that most players carry.
    "news": lambda v: "Knock - 75% chance of playing" if v != "Knock - 75% chance of playing" else "Fit",
    "penalties_order": lambda v: 1 if v != 1 else 2,
    "corners_order": lambda v: 1 if v != 1 else 2,
    "direct_freekicks_order": lambda v: 1 if v != 1 else 2,
    "form": lambda v: (v or Decimal(0)) + 1,
    "ep_next": lambda v: (v or Decimal(0)) + 1,
}


def main() -> int:
    missing = set(WATCHED) - set(BUMPS)
    if missing:
        print(f"FAIL  no mutation defined for watched field(s): {sorted(missing)}")
        print("      a field was added to WATCHED without extending this test")
        return len(missing)

    boot = FplClient(cache=False).bootstrap()
    events = boot["events"]
    season = config.season_label(events)
    event = config.next_event_id(events)
    now = datetime.now(timezone.utc).replace(microsecond=0)

    element = max(boot["elements"], key=lambda e: float(e["selected_by_percent"]))
    row = _row(element, season, event, now)
    previous = dict(row)

    print(f"probe player: {element['web_name']} "
          f"(cost {row['now_cost']}, owned {row['selected_by_percent']}%)\n")

    failures: list[str] = []

    # An identical row must NOT be written — this is what keeps the table inside the
    # 500 MB free tier.
    if _changed(row, previous):
        print("FAIL  identical row reported as changed (table would grow unbounded)")
        failures.append("identical-row")
    else:
        print("PASS  identical row -> skipped")

    # A first sighting must always be written.
    if not _changed(row, None):
        print("FAIL  new player (no previous row) reported as unchanged")
        failures.append("first-sighting")
    else:
        print("PASS  no previous row -> inserted")

    for field in WATCHED:
        mutated = dict(row)
        mutated[field] = BUMPS[field](row[field])
        if _changed(mutated, previous):
            print(f"PASS  {field:<30} {row[field]!r} -> {mutated[field]!r}")
        else:
            print(f"FAIL  {field:<30} change NOT detected")
            failures.append(field)

    # A cost move must also land in player_price_events — the labelled training set.
    moved = dict(row)
    moved["now_cost"] = (row["now_cost"] or 0) + 1
    event_row = _price_event(moved, previous)
    if event_row and event_row["old_cost"] != event_row["new_cost"]:
        print(f"PASS  price event emitted "
              f"({event_row['old_cost']} -> {event_row['new_cost']})")
    else:
        print("FAIL  cost move did not emit a price event")
        failures.append("price-event")

    # And an unchanged cost must not.
    if _price_event(dict(row), previous) is not None:
        print("FAIL  price event emitted without a cost change")
        failures.append("spurious-price-event")
    else:
        print("PASS  no cost change -> no price event")

    print(f"\n{len(failures)} failure(s)" + (f": {failures}" if failures else ""))
    return len(failures)


if __name__ == "__main__":
    sys.exit(main())
