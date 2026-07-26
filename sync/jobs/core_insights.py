"""FPL-Core-Insights: per-match player stats, keyed on official FPL element ids.

This replaced Sofascore after Sofascore was confirmed to 403 GitHub Actions runners. It is
the better source anyway:

  - **Per match, not per season** — the granularity rolling form actually needs.
  - **No name matching.** `player_id` is FPL's own season-scoped element id, so it joins
    through our `player_seasons` table. Given how much work Understat's names cost, a source
    that ships FPL ids is worth a lot.
  - **64 columns**, covering everything Sofascore uniquely had (`goals_prevented`,
    `big_chances_missed`, duel splits, keeper detail) plus physical data no other free
    source carries: `top_speed`, `distance_covered`, `sprinting_distance`,
    `number_of_sprints`.

Caveats, both deliberate:

  - It's one volunteer's repository with no stated licence and no SLA. We mirror what we
    consume into our own tables and never read it live at request time.
  - Most columns land in a JSONB `stats` blob rather than 64 typed columns, because the
    schema carries no guarantee. A column appearing or vanishing must not need a migration.
    Values worth querying get promoted to real columns once they prove stable.

Gameweek folders only exist once played, so in preseason `GW1/playermatchstats.csv` is
present but empty. Zero rows is the correct preseason result, not a failure.
"""

from __future__ import annotations

import csv
import io
from typing import Any

from curl_cffi import requests as curl_requests

from .. import config, db
from ..fpl import FplClient

RAW = "https://raw.githubusercontent.com/olbauday/FPL-Core-Insights/main/data"
IMPERSONATE = "chrome120"

# Promoted to typed columns: queried often enough to be worth the schema commitment.
# Everything else stays in the JSONB blob. Split by target type so coercion is explicit.
PROMOTED_INT = ("minutes_played", "start_min", "finish_min")
PROMOTED_NUM = ("xg", "xa", "xgot", "goals_prevented", "distance_covered", "top_speed")
PROMOTED = PROMOTED_INT + PROMOTED_NUM


def season_path(season: str) -> str:
    """'2026-27' -> '2026-2027', the repository's folder naming."""
    start, end = season.split("-")
    return f"{start}-{start[:2]}{end}"


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return None if n != n else n


def _int(v: Any) -> int | None:
    n = _num(v)
    return None if n is None else int(n)


def _get_csv(url: str, timeout: int = 30) -> tuple[list[dict], int]:
    resp = curl_requests.get(url, impersonate=IMPERSONATE, timeout=timeout)
    if resp.status_code != 200:
        return [], resp.status_code
    text = resp.content.decode("utf-8-sig", errors="replace")
    return list(csv.DictReader(io.StringIO(text))), 200


def fetch_gw(season: str, event: int, timeout: int = 30) -> tuple[list[dict], int]:
    return _get_csv(
        f"{RAW}/{season_path(season)}/By%20Gameweek/GW{event}/playermatchstats.csv",
        timeout,
    )


def fetch_player_map(season: str, timeout: int = 30) -> dict[int, int]:
    """`{element_id: player_code}` from the source's own `players.csv`.

    Needed for any season we don't hold `player_seasons` rows for. Element ids are
    season-scoped and reused across seasons, so mapping last season's match stats through
    *this* season's ids would silently attribute stats to the wrong players — the exact
    failure the stable `code` convention exists to prevent.
    """
    rows, status = _get_csv(f"{RAW}/{season_path(season)}/players.csv", timeout)
    if status != 200:
        return {}
    out: dict[int, int] = {}
    for r in rows:
        fpl_id, code = _int(r.get("player_id")), _int(r.get("player_code"))
        if fpl_id is not None and code is not None:
            out[fpl_id] = code
    return out


def build(
    rows: list[dict], season: str, event: int, code_by_fpl_id: dict[int, int]
) -> tuple[list[dict[str, Any]], list[int]]:
    out: list[dict[str, Any]] = []
    unknown_ids: list[int] = []

    for r in rows:
        fpl_id = _int(r.get("player_id"))
        match_id = (r.get("match_id") or "").strip()
        if fpl_id is None or not match_id:
            continue
        player_code = code_by_fpl_id.get(fpl_id)
        if player_code is None:
            # An element id we have no player for — a mid-season addition we haven't synced
            # yet. Recorded rather than silently dropped.
            unknown_ids.append(fpl_id)
            continue

        row: dict[str, Any] = {
            "season": season,
            "player_code": player_code,
            "ci_player_id": fpl_id,
            "match_id": match_id,
            "event": event,
        }
        row.update({c: _int(r.get(c)) for c in PROMOTED_INT})
        row.update({c: _num(r.get(c)) for c in PROMOTED_NUM})
        # Everything else, verbatim minus empties, so a new column survives without a
        # migration.
        row["stats"] = {
            k: v for k, v in r.items()
            if k and k not in PROMOTED and k not in ("player_id", "match_id")
            and v not in (None, "")
        }
        out.append(row)

    return out, unknown_ids


def run(
    client: FplClient,
    *,
    dry_run: bool = False,
    season: str | None = None,
) -> dict[str, Any]:
    bootstrap = client.bootstrap()
    events = bootstrap["events"]
    season = season or config.season_label(events)

    # Only fetch gameweeks that could have been played. For the live season `next_event_id`
    # gives the current gameweek (GW1 in preseason), so this never probes 38 URLs for
    # nothing. A season other than the live one is complete, so take all 38.
    live_season = config.season_label(events)
    upto = (config.next_event_id(events) or 1) if season == live_season else 38
    detail: dict[str, Any] = {
        "season": season,
        "gameweeks_probed": list(range(1, upto + 1)),
        "per_gw": {},
        "preseason": config.is_preseason(events),
    }

    fetched: list[tuple[int, list[dict]]] = []
    for event in range(1, upto + 1):
        raw, status = fetch_gw(season, event)
        if status != 200:
            detail["per_gw"][f"GW{event}"] = f"HTTP {status}"
            continue
        detail["per_gw"][f"GW{event}"] = len(raw)
        fetched.append((event, raw))

    if dry_run:
        detail["csv_rows_total"] = sum(len(r) for _, r in fetched)
        if fetched and fetched[0][1]:
            detail["columns"] = sorted(fetched[0][1][0].keys())
        return detail

    with db.connect() as conn:
        with db.sync_run(conn, "core_insights") as state:
            # The whole reason this source is cheap: its player_id IS FPL's element id, so
            # our own player_seasons table maps it with no name matching at all.
            mapping = db.fetch(
                conn,
                "select fpl_id, player_code from player_seasons where season = %s",
                (season,),
            )
            code_by_fpl_id = {m["fpl_id"]: m["player_code"] for m in mapping}
            map_source = "player_seasons"

            if not code_by_fpl_id:
                # A past season we never synced dimensions for. The source ships
                # player_code in its own players.csv, so use that — restricted to codes we
                # actually hold, since player_code is the FK.
                known_codes = {
                    r["code"] for r in db.fetch(conn, "select code from players")
                }
                code_by_fpl_id = {
                    fid: code
                    for fid, code in fetch_player_map(season).items()
                    if code in known_codes
                }
                map_source = "core-insights players.csv"

            all_rows: list[dict[str, Any]] = []
            unknown: list[int] = []
            for event, raw in fetched:
                rows, unknown_ids = build(raw, season, event, code_by_fpl_id)
                all_rows.extend(rows)
                unknown.extend(unknown_ids)

            written = db.upsert(
                conn, "core_insights_player_match", all_rows,
                ("season", "player_code", "match_id"))

            detail.update({
                "rows_written": written,
                "id_map_source": map_source,
                "known_players_in_season": len(code_by_fpl_id),
                "unmapped_element_ids": sorted(set(unknown))[:20],
                "unmapped_count": len(set(unknown)),
            })
            state["rows"] = written
            state["detail"] = detail

    return detail
