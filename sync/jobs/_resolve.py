"""Shared plumbing for enrichment jobs: load resolvers, persist identity, log gaps.

Every Tier 2 source has the same three problems — its team names aren't ours, its player
ids aren't ours, and some rows won't resolve. Solving that once here keeps each source job
about the source.
"""

from __future__ import annotations

from typing import Any, Iterable

from .. import db
from ..matching import FplPlayer, PlayerResolver, TeamResolver


def load_team_resolver(conn) -> TeamResolver:
    rows = db.fetch(conn, "select name, code from teams")
    return TeamResolver({r["name"]: r["code"] for r in rows})


def load_player_resolver(conn, season: str) -> PlayerResolver:
    """Players plus their club in `season`, so the cascade can use the team to
    disambiguate shared surnames."""
    rows = db.fetch(
        conn,
        """
        select p.code, p.first_name, p.second_name, p.web_name, p.known_name,
               ps.team_code
        from players p
        left join player_seasons ps
          on ps.player_code = p.code and ps.season = %s
        """,
        (season,),
    )
    return PlayerResolver(
        FplPlayer(
            code=r["code"],
            first_name=r["first_name"] or "",
            second_name=r["second_name"] or "",
            web_name=r["web_name"] or "",
            known_name=r["known_name"],
            team_code=r["team_code"],
        )
        for r in rows
    )


def load_existing_ids(conn, source: str) -> dict[str, int]:
    """`{external_id: player_code}` already resolved for this source.

    Loaded and reused rather than re-matched, so a manual correction in the table is never
    silently overwritten by the cascade on the next run.
    """
    rows = db.fetch(
        conn,
        "select external_id, player_code from player_external_ids where source = %s",
        (source,),
    )
    return {r["external_id"]: r["player_code"] for r in rows}


def save_new_ids(conn, source: str, rows: Iterable[dict[str, Any]]) -> int:
    """Persist newly resolved mappings. `conflict=None` absorbs either unique constraint."""
    return db.insert_ignore(conn, "player_external_ids", list(rows), None)


def clear_ids(conn, source: str) -> int:
    """Drop every mapping for a source so the cascade runs fresh.

    Mappings are sticky by design, which is right while the matcher is stable and wrong the
    moment it improves: the first live run stored ten false positives, and without this they
    would survive every future run. Use when the matching logic changes — and note it also
    discards manual corrections, so re-apply those afterwards.
    """
    with conn.cursor() as cur:
        cur.execute("delete from player_external_ids where source = %s", (source,))
        n = cur.rowcount
    conn.commit()
    return n


def dedupe_by_player(
    candidates: list[tuple[str, int, float, dict[str, Any]]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Enforce one external id per FPL player, keeping the most confident.

    Two different external players resolving to the same FPL player means at least one is
    wrong. `player_external_ids` has a unique constraint on (player_code, source), so the
    loser was previously dropped silently by `on conflict do nothing` — which is how a
    reported 413 matches became 405 stored rows with no explanation.

    Takes (external_id, player_code, confidence, row) and returns (winners, losers).
    """
    best: dict[int, tuple[float, str, dict[str, Any]]] = {}
    losers: list[dict[str, Any]] = []

    for external_id, player_code, confidence, row in sorted(
        candidates, key=lambda c: -c[2]
    ):
        current = best.get(player_code)
        if current is None:
            best[player_code] = (confidence, external_id, row)
        else:
            losers.append({
                "external_id": external_id,
                "raw_name": row.get("external_name"),
                "raw_team": row.get("external_team"),
                "reason": f"collided with {current[1]} (conf {current[0]}) "
                          f"on player_code {player_code}",
            })

    return [row for _, _, row in best.values()], losers


def clear_unmatched(conn, source: str, kind: str, season: str) -> int:
    """Drop this source/season's previous unmatched rows before re-logging.

    Without it the table only ever grows, and a name fixed by an improved matcher would
    keep showing up as a problem forever.
    """
    with conn.cursor() as cur:
        cur.execute(
            "delete from unmatched_names where source=%s and kind=%s and season=%s",
            (source, kind, season or ""),
        )
        n = cur.rowcount
    conn.commit()
    return n


def log_unmatched(
    conn, source: str, kind: str, season: str, rows: Iterable[dict[str, Any]]
) -> int:
    """Record what didn't resolve, so it's reviewable instead of invisible."""
    payload = [
        {
            "source": source,
            "kind": kind,
            "external_id": str(r.get("external_id") or r.get("raw_name") or "?"),
            "raw_name": r.get("raw_name"),
            "raw_team": r.get("raw_team"),
            "season": season or "",
        }
        for r in rows
    ]
    return db.insert_ignore(
        conn, "unmatched_names", payload, ("source", "kind", "external_id", "season")
    )
