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

from importlib import import_module

from . import config
from .fpl import FplClient

# Job names, resolved to modules only when actually invoked.
#
# THIS IMPORT MUST STAY LAZY. Importing every job eagerly meant `python -m sync.cli snapshot`
# pulled in `clubelo`, whose top-level `from curl_cffi import requests` is an enrichment
# dependency the hourly snapshot workflow deliberately does not install — it installs only
# psycopg and requests, to stay fast at 24 runs a day. The result was
# `ModuleNotFoundError: No module named 'curl_cffi'` before the snapshot job ran a single line,
# breaking the one table in this project that cannot be backfilled. Observed failing on the
# 20:56 scheduled run, 2026-07-26.
#
# Adding curl_cffi to that workflow would have fixed the symptom and left the coupling: any
# future enrichment dependency would break the hourly job again. Resolving on demand means a
# job can only be broken by its own imports.
JOBS = (
    "dimensions", "snapshot", "history", "understat", "core_insights",
    "clubelo", "odds", "market_odds", "manager", "league", "recommendations", "verify",
)


def job_runner(name: str):
    """Import `sync.jobs.<name>` and return its `run`. Raises only for that one job."""
    return import_module(f".jobs.{name}", package=__package__).run

# Jobs that accept --season.
SEASON_JOBS = ("understat", "odds", "market_odds", "core_insights")

# The daily enrichment set, for `python -m sync.cli enrich`.
# `market_odds` runs here AND more often than daily: Norsk Tipping keeps no history, so an
# uncaptured price is gone permanently, and the deep markets only open ~15h before kickoff.
ENRICH = ["understat", "core_insights", "clubelo", "odds", "market_odds"]


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
            result = job_runner(name)(client, **kwargs)
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
