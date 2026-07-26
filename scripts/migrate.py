"""Apply supabase/migrations/*.sql in filename order.

    python scripts/migrate.py              # apply all
    python scripts/migrate.py --list       # show what would run
    python scripts/migrate.py 0002         # apply just the ones matching a prefix

Migrations are written to be idempotent (`create table if not exists`, `create or replace
view`), so re-running the whole set is the normal way to bring a database up to date. There
is no version table on purpose: with idempotent migrations it would be bookkeeping that can
drift out of sync with reality, and reality is cheap to re-assert.

Each file runs inside its own transaction, so a failure leaves the earlier files applied
and rolls back only the one that broke.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import psycopg  # noqa: E402

from sync import config  # noqa: E402

MIGRATIONS = Path(__file__).resolve().parents[1] / "supabase" / "migrations"


def main() -> int:
    config.load_dotenv()
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    listing = "--list" in sys.argv

    files = sorted(MIGRATIONS.glob("*.sql"))
    if args:
        files = [f for f in files if any(f.name.startswith(a) for a in args)]
    if not files:
        print(f"no migrations matched in {MIGRATIONS}")
        return 1

    if listing:
        for f in files:
            print(f"  {f.name}  ({f.stat().st_size} bytes)")
        return 0

    url = config.database_url()
    print(f"applying {len(files)} migration(s)")
    for f in files:
        sql_text = f.read_text(encoding="utf-8")
        try:
            # A fresh connection per file keeps one failure from poisoning the rest.
            with psycopg.connect(url) as conn:
                with conn.cursor() as cur:
                    cur.execute(sql_text)
                conn.commit()
            print(f"  OK    {f.name}")
        except Exception as exc:
            print(f"  FAIL  {f.name}: {exc}")
            return 1
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
