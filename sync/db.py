"""Postgres access: connection, chunked upsert, and sync-run bookkeeping.

Talks to Postgres directly rather than through the Supabase REST API — the sync needs
bulk upserts and window functions, neither of which REST does well, and it means no
service-role key has to exist in CI.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any, Iterable, Iterator, Sequence

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from . import config

CHUNK = 500


@contextmanager
def connect() -> Iterator[psycopg.Connection]:
    conn = psycopg.connect(config.database_url(), row_factory=dict_row)
    try:
        yield conn
    finally:
        conn.close()


def _wrap_json(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """psycopg won't adapt dict/list values without an explicit Jsonb wrapper."""
    out = []
    for row in rows:
        out.append({
            k: Jsonb(v) if isinstance(v, (dict, list)) else v
            for k, v in row.items()
        })
    return out


def upsert(
    conn: psycopg.Connection,
    table: str,
    rows: Sequence[dict[str, Any]],
    conflict: Sequence[str],
    *,
    touch: str | None = "updated_at",
    chunk: int = CHUNK,
) -> int:
    """Chunked `insert ... on conflict do update`.

    Chunking matters for the same reason it did in Sporting_Director_Game: naive
    single-row inserts over ~550 players x many stats hit row limits and are slow.

    `touch` names a column to stamp with now() on update; pass None for tables without
    one. Append-only tables should use `insert_ignore` instead.
    """
    if not rows:
        return 0

    cols = list(rows[0].keys())
    updatable = [c for c in cols if c not in conflict]
    if touch and touch in cols:
        updatable = [c for c in updatable if c != touch]

    if updatable:
        assignments = [
            sql.SQL("{c} = excluded.{c}").format(c=sql.Identifier(c)) for c in updatable
        ]
        if touch and touch in cols:
            assignments.append(sql.SQL("{c} = now()").format(c=sql.Identifier(touch)))
        action = sql.SQL("do update set ") + sql.SQL(", ").join(assignments)
    else:
        action = sql.SQL("do nothing")

    stmt = sql.SQL(
        "insert into {table} ({cols}) values ({vals}) on conflict ({conflict}) {action}"
    ).format(
        table=sql.Identifier(table),
        cols=sql.SQL(", ").join(map(sql.Identifier, cols)),
        vals=sql.SQL(", ").join(sql.Placeholder() * len(cols)),
        conflict=sql.SQL(", ").join(map(sql.Identifier, conflict)),
        action=action,
    )

    total = 0
    wrapped = _wrap_json(list(rows))
    with conn.cursor() as cur:
        for i in range(0, len(wrapped), chunk):
            batch = wrapped[i : i + chunk]
            cur.executemany(stmt, [[r[c] for c in cols] for r in batch])
            total += len(batch)
    conn.commit()
    return total


def insert_ignore(
    conn: psycopg.Connection,
    table: str,
    rows: Sequence[dict[str, Any]],
    conflict: Sequence[str] | None,
    *,
    chunk: int = CHUNK,
) -> int:
    """Append-only insert for `player_snapshots` / `player_price_events`.

    `do nothing` makes a re-run within the same capture instant a no-op instead of an
    error, which is what lets a retried GitHub Actions job be safe.

    Pass `conflict=None` for a bare `on conflict do nothing`, which absorbs *any*
    constraint rather than one named target. Needed by `player_external_ids`, which has two
    unique constraints — (player_code, source) and (source, external_id) — and a remapped
    player would otherwise trip the one not being watched.
    """
    if not rows:
        return 0
    cols = list(rows[0].keys())
    target = (
        sql.SQL("")
        if conflict is None
        else sql.SQL(" ({})").format(sql.SQL(", ").join(map(sql.Identifier, conflict)))
    )
    stmt = sql.SQL(
        "insert into {table} ({cols}) values ({vals}) on conflict{target} do nothing"
    ).format(
        table=sql.Identifier(table),
        cols=sql.SQL(", ").join(map(sql.Identifier, cols)),
        vals=sql.SQL(", ").join(sql.Placeholder() * len(cols)),
        target=target,
    )
    total = 0
    wrapped = _wrap_json(list(rows))
    with conn.cursor() as cur:
        for i in range(0, len(wrapped), chunk):
            batch = wrapped[i : i + chunk]
            cur.executemany(stmt, [[r[c] for c in cols] for r in batch])
            total += len(batch)
    conn.commit()
    return total


def fetch(conn: psycopg.Connection, query: str, params: Iterable[Any] = ()) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(query, list(params))
        return cur.fetchall()


# --------------------------------------------------------------------------- #
# sync_runs bookkeeping
# --------------------------------------------------------------------------- #

@contextmanager
def sync_run(conn: psycopg.Connection, job: str) -> Iterator[dict]:
    """Record a job attempt. Yields a mutable dict; set `rows` and `detail` on it.

    A failure is recorded and then re-raised, so the workflow still goes red while
    `sync_freshness` can show what broke.
    """
    with conn.cursor() as cur:
        cur.execute(
            "insert into sync_runs (job) values (%s) returning id", (job,)
        )
        run_id = cur.fetchone()["id"]
    conn.commit()

    state: dict[str, Any] = {"rows": 0, "detail": {}}
    try:
        yield state
    except Exception as exc:
        # rollback() first, always. A failed write leaves the connection in an aborted
        # transaction, where every subsequent statement — including this very error
        # record — fails too. Without the rollback the row stays 'running' forever and
        # the error is lost, which is the observability layer breaking at the one moment
        # it matters. (Observed 2026-07-26: sync_runs rows 1-2 stuck this way.)
        try:
            conn.rollback()
        except Exception:
            pass
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "update sync_runs set finished_at = now(), status = 'error', "
                    "rows_touched = %s, detail = %s, error = %s where id = %s",
                    (state["rows"], Jsonb(state["detail"]), repr(exc)[:4000], run_id),
                )
            conn.commit()
        except Exception:
            # A dead connection can't record anything; let the original error surface
            # rather than masking it with a bookkeeping failure.
            pass
        raise
    else:
        with conn.cursor() as cur:
            cur.execute(
                "update sync_runs set finished_at = now(), status = 'ok', "
                "rows_touched = %s, detail = %s where id = %s",
                (state["rows"], Jsonb(state["detail"]), run_id),
            )
        conn.commit()
