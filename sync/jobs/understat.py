"""Understat: team-match style metrics, shot events, and creator stats.

The reason this source is in the stack at all is `ppda` and `deep_completions`, which
answer "which teams play defensive football" directly and appear nowhere in the FPL API.
PPDA is passes allowed per defensive action, so **low PPDA = aggressive high press** and
high PPDA = sitting deep.

Two traps, both already paid for once:

  - **`soccerdata` caches aggressively.** A stale cache served 346 of 380 team-matches and
    528 players, and that got written into our docs as an Understat coverage gap. It
    wasn't. This job reconciles row counts against `read_schedule()` and reports a
    shortfall rather than accepting it.
  - **The league changes teams every year.** 2025/26 Understat data contains Burnley, West
    Ham and Wolves, which hold no row in `teams`. Their `team_code` resolves to None by
    design; the raw name is always stored.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from .. import config, db
from ..fpl import FplClient, as_ts
from . import _resolve

SOURCE = "understat"
LEAGUE = "ENG-Premier League"


def _clean(v: Any) -> Any:
    """Convert pandas' several flavours of "missing" to None, and numpy scalars to Python.

    pandas has at least four: `None`, `float('nan')`, `NaT`, and `pd.NA`. The last one is
    the nasty one — `pd.NA != pd.NA` evaluates to `pd.NA` rather than True, and `bool(pd.NA)`
    raises, so the obvious `if v != v` self-inequality check silently lets it through and
    psycopg then fails with "cannot adapt type 'NAType'". `pd.isna` handles all four.

    numpy scalars are unwrapped via `.item()` because psycopg has no adapter for them.
    """
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        # pd.isna raises on some container types; those aren't missing values.
        pass
    item = getattr(v, "item", None)
    if callable(item) and getattr(v, "shape", ()) == ():
        return item()
    return v


def _season_label(raw: str) -> str:
    """soccerdata reports the season as '2526'; we store '2025-26' everywhere."""
    s = str(raw)
    return f"20{s[:2]}-{s[2:]}" if len(s) == 4 and s.isdigit() else s


def _understat_season_arg(season: str) -> str:
    """'2025-26' -> '2025/2026', which is what soccerdata expects."""
    start = season.split("-")[0]
    return f"{start}/{int(start) + 1}"


def target_season(events: list[dict]) -> str:
    """Which season to pull.

    In preseason the current campaign has no matches, so the useful data is last season's —
    the same reasoning as `config.aggregates_season`.
    """
    return config.aggregates_season(events)


def run(
    client: FplClient,
    *,
    dry_run: bool = False,
    season: str | None = None,
    rematch: bool = False,
) -> dict[str, Any]:
    import soccerdata as sd

    bootstrap = client.bootstrap()
    season = season or target_season(bootstrap["events"])

    us = sd.Understat(leagues=LEAGUE, seasons=_understat_season_arg(season))

    schedule = us.read_schedule().reset_index()
    team_match = us.read_team_match_stats().reset_index()
    shots = us.read_shot_events().reset_index()
    players = us.read_player_season_stats().reset_index()

    detail: dict[str, Any] = {
        "season": season,
        "scheduled_matches": len(schedule),
        "team_match_rows_raw": len(team_match),
        "shot_rows": len(shots),
        "player_rows": len(players),
    }

    # The cache trap. A shortfall here is nearly always a stale cache, not missing data.
    if len(team_match) < len(schedule):
        detail["coverage_warning"] = (
            f"{len(team_match)} of {len(schedule)} matches — likely a stale soccerdata "
            f"cache; clear ~/soccerdata/data/Understat and re-run before trusting this"
        )

    if dry_run:
        detail["would_write"] = {
            "understat_team_match": len(team_match) * 2,
            "understat_shots": len(shots),
            "understat_player_season": len(players),
        }
        return detail

    with db.connect() as conn:
        with db.sync_run(conn, "understat") as state:
            teams = _resolve.load_team_resolver(conn)
            resolver = _resolve.load_player_resolver(conn, config.season_label(bootstrap["events"]))
            cleared = _resolve.clear_ids(conn, SOURCE) if rematch else 0
            known = _resolve.load_existing_ids(conn, SOURCE)

            # ---- team-match: one row per team, opponent figures denormalised in ---- #
            tm_rows: list[dict] = []
            for _, r in team_match.iterrows():
                season_lbl = _season_label(r["season"])
                kickoff = as_ts(str(_clean(r.get("date"))))
                for side, other in (("home", "away"), ("away", "home")):
                    tm_rows.append({
                        "season": season_lbl,
                        "game_id": str(r["game_id"]),
                        "understat_team": str(r[f"{side}_team"]),
                        "team_code": teams.code(r[f"{side}_team"]),
                        "is_home": side == "home",
                        "understat_opponent": str(r[f"{other}_team"]),
                        "opponent_team_code": teams.code(r[f"{other}_team"]),
                        "kickoff": kickoff,
                        "goals": _clean(r.get(f"{side}_goals")),
                        "xg": _clean(r.get(f"{side}_xg")),
                        "np_xg": _clean(r.get(f"{side}_np_xg")),
                        "np_xg_difference": _clean(r.get(f"{side}_np_xg_difference")),
                        "ppda": _clean(r.get(f"{side}_ppda")),
                        "deep_completions": _clean(r.get(f"{side}_deep_completions")),
                        "points": _clean(r.get(f"{side}_points")),
                        "expected_points": _clean(r.get(f"{side}_expected_points")),
                        "opponent_goals": _clean(r.get(f"{other}_goals")),
                        "opponent_xg": _clean(r.get(f"{other}_xg")),
                        "opponent_np_xg": _clean(r.get(f"{other}_np_xg")),
                        "opponent_ppda": _clean(r.get(f"{other}_ppda")),
                        "opponent_deep_completions": _clean(r.get(f"{other}_deep_completions")),
                    })

            # ---- player identity, resolved once and reused ------------------------ #
            unmatched: list[dict] = []
            code_by_uid: dict[str, int] = dict(known)
            # (external_id, player_code, confidence, row) for dedupe_by_player.
            candidates: list[tuple[str, int, float, dict]] = []

            for _, r in players.iterrows():
                uid = str(_clean(r.get("player_id")) or "")
                if not uid or uid in code_by_uid:
                    continue
                name = str(r.get("player") or "").strip()
                raw_team = str(r.get("team") or "").strip()
                hit = resolver.resolve(name, teams.code(raw_team))
                if hit is None:
                    unmatched.append({
                        "external_id": uid, "raw_name": name, "raw_team": raw_team,
                    })
                    continue
                candidates.append((uid, hit.player_code, hit.confidence, {
                    "player_code": hit.player_code,
                    "source": SOURCE,
                    "external_id": uid,
                    "external_name": name,
                    "external_team": raw_team,
                    "method": hit.method,
                    "confidence": hit.confidence,
                }))

            # Two external players resolving to one FPL player means at least one is wrong.
            # Keep the confident one and log the other rather than letting the unique
            # constraint drop it silently.
            new_ids, collided = _resolve.dedupe_by_player(candidates)
            for row in new_ids:
                code_by_uid[row["external_id"]] = row["player_code"]
            unmatched.extend(collided)

            player_rows = [{
                "season": _season_label(r["season"]),
                "understat_player_id": str(r["player_id"]),
                "player_code": code_by_uid.get(str(r["player_id"])),
                "understat_player": str(r.get("player") or ""),
                "understat_team": str(r.get("team") or ""),
                "team_code": teams.code(r.get("team")),
                "position": _clean(r.get("position")),
                **{c: _clean(r.get(c)) for c in (
                    "matches", "minutes", "goals", "xg", "np_goals", "np_xg", "assists",
                    "xa", "shots", "key_passes", "xg_chain", "xg_buildup",
                    "yellow_cards", "red_cards",
                )},
            } for _, r in players.iterrows()]

            shot_rows = [{
                "season": _season_label(r["season"]),
                "shot_id": str(r["shot_id"]),
                "game_id": str(_clean(r.get("game_id")) or ""),
                "understat_player_id": str(_clean(r.get("player_id")) or ""),
                "player_code": code_by_uid.get(str(_clean(r.get("player_id")) or "")),
                "understat_player": str(r.get("player") or ""),
                "understat_team": str(r.get("team") or ""),
                "team_code": teams.code(r.get("team")),
                "kickoff": as_ts(str(_clean(r.get("date")))),
                "minute": _clean(r.get("minute")),
                "xg": _clean(r.get("xg")),
                "location_x": _clean(r.get("location_x")),
                "location_y": _clean(r.get("location_y")),
                "body_part": _clean(r.get("body_part")),
                "situation": _clean(r.get("situation")),
                "result": _clean(r.get("result")),
                "assist_player": _clean(r.get("assist_player")),
                "assist_understat_id": (
                    str(_clean(r.get("assist_player_id")))
                    if _clean(r.get("assist_player_id")) is not None else None
                ),
            } for _, r in shots.iterrows()]

            # Identity and diagnostics first, facts second. The 9 524-row shot upsert is
            # the most likely thing to fail, and when it did, unmatched-name logging sat
            # below it and was lost — leaving no record of why 163 players hadn't resolved.
            written = _resolve.save_new_ids(conn, SOURCE, new_ids)
            _resolve.clear_unmatched(conn, SOURCE, "player", season)
            if unmatched:
                _resolve.log_unmatched(conn, SOURCE, "player", season, unmatched)

            written += db.upsert(
                conn, "understat_team_match", tm_rows,
                ("season", "game_id", "understat_team"))
            written += db.upsert(
                conn, "understat_player_season", player_rows,
                ("season", "understat_player_id"))
            written += db.upsert(
                conn, "understat_shots", shot_rows, ("season", "shot_id"))

            detail.update({
                "team_match_rows_written": len(tm_rows),
                "mappings_cleared_for_rematch": cleared,
                "newly_matched_players": len(new_ids),
                "already_matched": len(known),
                "collisions_rejected": len(collided),
                "collision_sample": [c["reason"] for c in collided[:5]],
                "unmatched_players": len(unmatched),
                "unmatched_sample": [u.get("raw_name") for u in unmatched[:10]],
                "unknown_teams": teams.report(),
                "shots_linked_to_fpl": sum(1 for s in shot_rows if s["player_code"]),
                "player_rows_linked_to_fpl": sum(
                    1 for p in player_rows if p["player_code"]),
            })
            state["rows"] = written
            state["detail"] = detail

    return detail
