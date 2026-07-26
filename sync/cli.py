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
from .jobs import dimensions, history, snapshot, verify

JOBS = {
    "dimensions": dimensions.run,
    "snapshot": snapshot.run,
    "history": history.run,
    "verify": verify.run,
}


def _print(job: str, detail: dict[str, Any]) -> None:
    print(f"\n[{job}] " + json.dumps(detail, indent=2, default=str), flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sync")
    parser.add_argument("job", choices=[*JOBS, "all"])
    parser.add_argument("--dry-run", action="store_true",
                        help="fetch and transform, but write nothing")
    parser.add_argument("--limit", type=int, default=None,
                        help="history only: cap the number of players fetched")
    parser.add_argument("--no-cache", action="store_true",
                        help="skip writing raw payloads to tmp/raw")
    parser.add_argument("--reap-stale", action="store_true",
                        help="verify only: mark sync_runs rows stuck on 'running' as errors")
    args = parser.parse_args(argv)

    config.load_dotenv()
    client = FplClient(cache=not args.no_cache)

    # 'all' is the daily order: dimensions must land before history's FKs resolve, and
    # the snapshot goes last so it reflects post-sync state.
    names = ["dimensions", "history", "snapshot"] if args.job == "all" else [args.job]

    failed = 0
    for name in names:
        kwargs: dict[str, Any] = {"dry_run": args.dry_run}
        if name == "history":
            kwargs["limit"] = args.limit
        if name == "verify":
            kwargs["reap_stale"] = args.reap_stale
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
