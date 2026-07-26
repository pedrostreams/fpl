"""Dimensions + season aggregates from `bootstrap-static` and `fixtures`.

Everything keys on FPL's stable `code`. The season-scoped `id` is kept in
`team_seasons.fpl_id` / `player_seasons.fpl_id` so payloads that reference it (fixtures
use `team_h`/`team_a`, element-summary uses element ids) can still be resolved.
"""

from __future__ import annotations

from typing import Any

from .. import config, db
from ..fpl import FplClient, as_bool, as_date, as_int, as_num, as_text, as_ts


def build(bootstrap: dict, fixtures_payload: list[dict]) -> dict[str, list[dict]]:
    """Pure transform: payloads in, table rows out. No DB, so --dry-run exercises it."""
    events = bootstrap["events"]
    season = config.season_label(events)
    agg_season = config.aggregates_season(events)

    team_code_by_id = {t["id"]: t["code"] for t in bootstrap["teams"]}
    known_team_codes = set(team_code_by_id.values())

    def team_code(season_team_id: Any, fallback: Any = None) -> int | None:
        """Resolve a season-scoped team id to a stable team code, or None.

        Both team FKs are nullable on purpose. All 558 players resolve cleanly today, but
        a player who leaves the league mid-season can be left pointing at a team that is
        no longer in `teams[]`, and an unresolvable code would abort the whole daily sync
        on a foreign-key violation. Losing one player's club for a day is the cheaper
        failure.
        """
        code = team_code_by_id.get(season_team_id)
        if code is None:
            code = as_int(fallback)
        return code if code in known_team_codes else None

    seasons = [{
        "name": season,
        "is_current": True,
        "gw1_deadline": as_ts(config.gw1_deadline(events)),
    }]
    # The aggregates may describe a season we have no other row for (preseason), and
    # player_season_totals.season has no FK — but keeping a row makes joins predictable.
    if agg_season != season:
        seasons.append({"name": agg_season, "is_current": False, "gw1_deadline": None})

    teams = [{
        "code": t["code"],
        "name": t["name"],
        "short_name": as_text(t.get("short_name")),
        "pulse_id": as_int(t.get("pulse_id")),
    } for t in bootstrap["teams"]]

    team_seasons = [{
        "season": season,
        "team_code": t["code"],
        "fpl_id": t["id"],
        "strength": as_int(t.get("strength")),
        "strength_overall_home": as_int(t.get("strength_overall_home")),
        "strength_overall_away": as_int(t.get("strength_overall_away")),
        "strength_attack_home": as_int(t.get("strength_attack_home")),
        "strength_attack_away": as_int(t.get("strength_attack_away")),
        "strength_defence_home": as_int(t.get("strength_defence_home")),
        "strength_defence_away": as_int(t.get("strength_defence_away")),
        "played": as_int(t.get("played")),
        "win": as_int(t.get("win")),
        "draw": as_int(t.get("draw")),
        "loss": as_int(t.get("loss")),
        "points": as_int(t.get("points")),
        "position": as_int(t.get("position")),
        "form": as_text(t.get("form")),
    } for t in bootstrap["teams"]]

    players, player_seasons, totals = [], [], []
    for e in bootstrap["elements"]:
        players.append({
            "code": e["code"],
            "first_name": as_text(e.get("first_name")),
            "second_name": as_text(e.get("second_name")),
            "web_name": as_text(e.get("web_name")),
            "known_name": as_text(e.get("known_name")),
            "birth_date": as_date(e.get("birth_date")),
            "region": as_int(e.get("region")),
            "opta_code": as_text(e.get("opta_code")),
            "photo": as_text(e.get("photo")),
        })

        now_cost = as_int(e.get("now_cost"))
        change_start = as_int(e.get("cost_change_start")) or 0
        player_seasons.append({
            "season": season,
            "player_code": e["code"],
            "fpl_id": e["id"],
            "element_type": as_int(e.get("element_type")),
            "team_code": team_code(e.get("team"), e.get("team_code")),
            "start_cost": (now_cost - change_start) if now_cost is not None else None,
            "squad_number": as_int(e.get("squad_number")),
            "team_join_date": as_date(e.get("team_join_date")),
            # Set-piece duty, published first-party by FPL. Free signal that paid tools
            # charge for; 64 penalty takers and 71 corner takers are named as of 2026-07-26.
            "penalties_order": as_int(e.get("penalties_order")),
            "penalties_text": as_text(e.get("penalties_text")),
            "direct_freekicks_order": as_int(e.get("direct_freekicks_order")),
            "direct_freekicks_text": as_text(e.get("direct_freekicks_text")),
            "corners_order": as_int(e.get("corners_and_indirect_freekicks_order")),
            "corners_text": as_text(e.get("corners_and_indirect_freekicks_text")),
        })

        totals.append({
            "season": agg_season,
            "player_code": e["code"],
            "source": "bootstrap",
            "start_cost": (now_cost - change_start) if now_cost is not None else None,
            "end_cost": now_cost,
            **{k: as_int(e.get(k)) for k in (
                "total_points", "minutes", "starts", "goals_scored", "assists",
                "clean_sheets", "goals_conceded", "own_goals", "penalties_saved",
                "penalties_missed", "yellow_cards", "red_cards", "saves", "bonus", "bps",
                "clearances_blocks_interceptions", "recoveries", "tackles",
                "defensive_contribution",
            )},
            **{k: as_num(e.get(k)) for k in (
                "influence", "creativity", "threat", "ict_index", "expected_goals",
                "expected_assists", "expected_goal_involvements", "expected_goals_conceded",
            )},
        })

    event_rows = [{
        "season": season,
        "id": ev["id"],
        "name": as_text(ev.get("name")),
        "deadline_time": as_ts(ev.get("deadline_time")),
        "finished": as_bool(ev.get("finished")),
        "data_checked": as_bool(ev.get("data_checked")),
        "is_previous": as_bool(ev.get("is_previous")),
        "is_current": as_bool(ev.get("is_current")),
        "is_next": as_bool(ev.get("is_next")),
        "average_entry_score": as_int(ev.get("average_entry_score")),
        "highest_score": as_int(ev.get("highest_score")),
        "most_selected": as_int(ev.get("most_selected")),
        "most_transferred_in": as_int(ev.get("most_transferred_in")),
        "top_element": as_int(ev.get("top_element")),
        "most_captained": as_int(ev.get("most_captained")),
        "most_vice_captained": as_int(ev.get("most_vice_captained")),
        "transfers_made": as_int(ev.get("transfers_made")),
        "ranked_count": as_int(ev.get("ranked_count")),
        "chip_plays": ev.get("chip_plays") or [],
    } for ev in events]

    fixture_rows = [{
        "season": season,
        "fpl_id": f["id"],
        "code": as_int(f.get("code")),
        "event": as_int(f.get("event")),
        "kickoff_time": as_ts(f.get("kickoff_time")),
        "started": as_bool(f.get("started")),
        "finished": as_bool(f.get("finished")),
        "finished_provisional": as_bool(f.get("finished_provisional")),
        "minutes": as_int(f.get("minutes")),
        "team_h_code": team_code(f.get("team_h")),
        "team_a_code": team_code(f.get("team_a")),
        "team_h_score": as_int(f.get("team_h_score")),
        "team_a_score": as_int(f.get("team_a_score")),
        "team_h_difficulty": as_int(f.get("team_h_difficulty")),
        "team_a_difficulty": as_int(f.get("team_a_difficulty")),
        "pulse_id": as_int(f.get("pulse_id")),
        "stats": f.get("stats") or [],
    } for f in fixtures_payload]

    # Squad-size rules come from the payload; `defcon_threshold` is ours and is set by
    # migration 0003, so it is deliberately not written here — an upsert listing only these
    # columns would leave it untouched.
    element_type_rows = [{
        "id": t["id"],
        "singular_name": as_text(t.get("singular_name")),
        "singular_name_short": as_text(t.get("singular_name_short")),
        "plural_name": as_text(t.get("plural_name")),
        "squad_select": as_int(t.get("squad_select")),
        "squad_min_play": as_int(t.get("squad_min_play")),
        "squad_max_play": as_int(t.get("squad_max_play")),
    } for t in bootstrap.get("element_types", [])]

    return {
        "seasons": seasons,
        "element_types": element_type_rows,
        "teams": teams,
        "team_seasons": team_seasons,
        "players": players,
        "player_seasons": player_seasons,
        "events": event_rows,
        "fixtures": fixture_rows,
        "player_season_totals": totals,
    }


# Insertion order matters: FKs point left to right.
ORDER: list[tuple[str, tuple[str, ...]]] = [
    ("seasons", ("name",)),
    ("element_types", ("id",)),
    ("teams", ("code",)),
    ("team_seasons", ("season", "team_code")),
    ("players", ("code",)),
    ("player_seasons", ("season", "player_code")),
    ("events", ("season", "id")),
    ("fixtures", ("season", "fpl_id")),
    ("player_season_totals", ("season", "player_code", "source")),
]


def run(client: FplClient, *, dry_run: bool = False) -> dict[str, Any]:
    bootstrap = client.bootstrap()
    fixtures_payload = client.fixtures()
    tables = build(bootstrap, fixtures_payload)

    events = bootstrap["events"]
    detail: dict[str, Any] = {
        "season": config.season_label(events),
        "aggregates_season": config.aggregates_season(events),
        "preseason": config.is_preseason(events),
        "counts": {name: len(tables[name]) for name, _ in ORDER},
    }

    if dry_run:
        return detail

    written = 0
    with db.connect() as conn:
        with db.sync_run(conn, "dimensions") as state:
            for name, conflict in ORDER:
                written += db.upsert(conn, name, tables[name], conflict)
            state["rows"] = written
            state["detail"] = detail
    detail["rows_written"] = written
    return detail
