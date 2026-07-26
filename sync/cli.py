"""Sync entrypoint.

    python -m sync.cli dimensions --dry-run
    python -m sync.cli snapshot
    python -m sync.cli history --limit 20
    python -m sync.cli all

--dry-run fetches live payloads and runs every transform, but touches no database. It is
the cheap pre-flight check described in docs/SYNC_PLAN.md §8.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from . import config
from .fpl import FplClient
from .jobs import (
    clubelo, core_insights, dimensions, history, odds, snapshot, understat, verify,
)

JOBS = {
    "dimensions": dimensions.run,
    "snapshot": snapshot.run,
    "history": history.run,
    "understat": understat.run,
    "core_insights": core_insights.run,
    "clubelo": clubelo.run,
    "odds": odds.run,
    "verify": verify.run,
}

# Jobs that accept --season.
SEASON_JOBS = ("understat", "odds", "core_insights")

# The daily enrichment set, for `python -m sync.cli enrich`.
ENRICH = ["understat", "core_insights", "clubelo", "odds"]


def _print(job: str, detail: dict[str, Any]) -> None:
    print(f"\n[{job}] " + json.dumps(detail, indent=2, default=str), flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sync")
    parser.add_argument("job", choices=[*JOBS, "all", "enrich"])
    parser.add_argument("--dry-run", action="store_true",
                        help="fetch and transform, but write nothing")
    parser.add_argument("--limit", type=int, default=None,
                        help="history only: cap the number of players fetched")
    parser.add_argument("--no-cache", action="store_true",
                        help="skip writing raw payloads to tmp/raw")
    parser.add_argument("--reap-stale", action="store_true",
                        help="verify only: mark sync_runs rows stuck on 'running' as errors")
    parser.add_argument("--season", default=None,
                        help="enrichment jobs: season to pull, e.g. 2025-26 "
                             "(defaults to the last completed season in preseason)")
    parser.add_argument("--rematch", action="store_true",
                        help="understat only: discard stored identity mappings and resolve "
                             "from scratch. Use after changing the matching logic; it also "
                             "discards manual corrections")
    args = parser.parse_args(argv)

    config.load_dotenv()
    client = FplClient(cache=not args.no_cache)

    # 'all' is the daily FPL order: dimensions must land before history's FKs resolve, and
    # the snapshot goes last so it reflects post-sync state. 'enrich' is the Tier 2 set,
    # which assumes dimensions already exist — every enrichment job resolves against
    # `teams` and `player_seasons`.
    if args.job == "all":
        names = ["dimensions", "history", "snapshot"]
    elif args.job == "enrich":
        names = list(ENRICH)
    else:
        names = [args.job]

    failed = 0
    for name in names:
        kwargs: dict[str, Any] = {"dry_run": args.dry_run}
        if name == "history":
            kwargs["limit"] = args.limit
        if name == "verify":
            kwargs["reap_stale"] = args.reap_stale
        if name in SEASON_JOBS:
            kwargs["season"] = args.season
        if name == "understat":
            kwargs["rematch"] = args.rematch
        try:
            result = JOBS[name](client, **kwargs)
            # verify is read-only and formats its own tables; a JSON dump would just
            # repeat what it already printed.
            if name == "verify":
                failed += len(result.get("problems", []))
            else:
                _print(name, result)
        except Exception as exc:
            failed += 1
            print(f"\n[{name}] FAILED: {exc!r}", file=sys.stderr, flush=True)
            if args.job != "all":
                raise
    return failed


if __name__ == "__main__":
    sys.exit(main())
