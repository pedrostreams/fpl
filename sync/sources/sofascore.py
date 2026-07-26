"""Direct Sofascore API client — no ScraperFC, no botasaurus, no hrequests.

Why not ScraperFC (which the Sporting_Director_Game scripts use): `import ScraperFC`
pulls in `botasaurus_requests`, which downloads a TLS binary from GitHub releases at
import time. That download 403s on GitHub Actions runners, so the import fails before any
Sofascore call is even attempted — verified in CI 2026-07-26. Monkey-patching the JSON
getter, as SDG does, can't help: the failure happens during the import that the patch
depends on.

Sofascore's API itself is simple and public. All we need from ScraperFC was the stat-name
list and the endpoint shape, both reproduced here. What genuinely matters is the TLS
fingerprint: Sofascore rejects plain `requests` and `cloudscraper` with 403, while
`curl_cffi` impersonating Chrome returns 200.

    from sync.sources.sofascore import Sofascore
    sofa = Sofascore()
    rows = sofa.player_season_stats(season="25/26")
"""

from __future__ import annotations

from typing import Any, Iterator

from curl_cffi import requests as curl_requests

API = "https://api.sofascore.com/api/v1"
IMPERSONATE = "chrome120"

# Sofascore unique-tournament ids.
LEAGUES = {
    "ENG-Premier League": 17,
    "ESP-La Liga": 8,
    "ITA-Serie A": 23,
    "GER-Bundesliga": 35,
    "FRA-Ligue 1": 34,
}

POSITIONS = "G~D~M~F"

# The full statistics field list. Sofascore only returns fields you ask for, so this is
# not cosmetic — a missing name means a silently absent column. Sourced from
# ScraperFC 4.5.0 and verified against a live response (114 columns) on 2026-07-26.
STAT_NAMES = [
    "accurateChippedPasses", "accurateCrosses", "accurateCrossesPercentage",
    "accurateFinalThirdPasses", "accurateLongBalls", "accurateLongBallsPercentage",
    "accurateOppositionHalfPasses", "accurateOwnHalfPasses", "accuratePasses",
    "accuratePassesPercentage", "aerialDuelsWon", "aerialDuelsWonPercentage", "aerialLost",
    "appearances", "assists", "attemptPenaltyMiss", "attemptPenaltyPost",
    "attemptPenaltyTarget", "ballRecovery", "bigChancesCreated", "bigChancesMissed",
    "blockedShots", "cleanSheet", "clearances", "countRating", "crossesNotClaimed",
    "directRedCards", "dispossessed", "dribbledPast", "duelLost", "errorLeadToGoal",
    "errorLeadToShot", "expectedAssists", "expectedGoals", "fouls", "freeKickGoal",
    "goalConversionPercentage", "goalKicks", "goals", "goalsAssistsSum", "goalsConceded",
    "goalsConcededInsideTheBox", "goalsConcededOutsideTheBox", "goalsFromInsideTheBox",
    "goalsFromOutsideTheBox", "goalsPrevented", "groundDuelsWon",
    "groundDuelsWonPercentage", "headedGoals", "highClaims", "hitWoodwork",
    "inaccuratePasses", "interceptions", "keyPasses", "leftFootGoals", "matchesStarted",
    "minutesPlayed", "offsides", "outfielderBlocks", "ownGoals", "passToAssist",
    "penaltiesTaken", "penaltyConceded", "penaltyConversion", "penaltyFaced",
    "penaltyGoals", "penaltySave", "penaltyWon", "possessionLost", "possessionWonAttThird",
    "punches", "rating", "redCards", "rightFootGoals", "runsOut",
    "savedShotsFromInsideTheBox", "savedShotsFromOutsideTheBox", "saves", "savesCaught",
    "savesParried", "scoringFrequency", "setPieceConversion", "shotFromSetPiece",
    "shotsFromInsideTheBox", "shotsFromOutsideTheBox", "shotsOffTarget", "shotsOnTarget",
    "successfulDribbles", "successfulDribblesPercentage", "successfulRunsOut", "tackles",
    "tacklesWon", "tacklesWonPercentage", "totalAttemptAssist", "totalChippedPasses",
    "totalContest", "totalCross", "totalDuelsWon", "totalDuelsWonPercentage",
    "totalLongBalls", "totalOppositionHalfPasses", "totalOwnHalfPasses", "totalPasses",
    "totalRating", "totalShots", "totwAppearances", "touches", "wasFouled", "yellowCards",
    "yellowRedCards",
]


class SofascoreBlocked(RuntimeError):
    """Sofascore refused the request — almost always a datacenter IP being filtered.

    Distinct from a structural failure so callers can tell "this source is unreachable
    from this network" apart from "this source changed shape". The first is a hosting
    problem; the second is a code problem.
    """


class Sofascore:
    def __init__(self, *, timeout: int = 30) -> None:
        self.timeout = timeout
        self._fields = "%2C".join(STAT_NAMES)

    def _get(self, url: str) -> dict[str, Any]:
        try:
            resp = curl_requests.get(url, impersonate=IMPERSONATE, timeout=self.timeout)
        except Exception as exc:
            raise SofascoreBlocked(f"transport error for {url}: {exc!r}") from exc
        if resp.status_code in (403, 429):
            raise SofascoreBlocked(
                f"HTTP {resp.status_code} from Sofascore for {url} — the caller's IP is "
                f"most likely being filtered (datacenter ranges are)."
            )
        resp.raise_for_status()
        return resp.json()

    def seasons(self, league: str = "ENG-Premier League") -> dict[str, int]:
        """{'25/26': 76986, ...} — Sofascore's own season labels mapped to ids."""
        data = self._get(f"{API}/unique-tournament/{LEAGUES[league]}/seasons/")
        return {s["year"]: s["id"] for s in data["seasons"]}

    def player_season_stats(
        self,
        season: str = "25/26",
        league: str = "ENG-Premier League",
        *,
        accumulation: str = "total",
    ) -> list[dict[str, Any]]:
        """One flat dict per player, with `player_id`/`team_id` lifted out of the nested
        objects so the result is directly upsertable."""
        season_ids = self.seasons(league)
        if season not in season_ids:
            raise ValueError(
                f"season {season!r} not available for {league}; "
                f"have {sorted(season_ids)[:8]}..."
            )
        return list(self._paginate(LEAGUES[league], season_ids[season], accumulation))

    def _paginate(
        self, league_id: int, season_id: int, accumulation: str
    ) -> Iterator[dict[str, Any]]:
        offset = 0
        while True:
            data = self._get(
                f"{API}/unique-tournament/{league_id}/season/{season_id}/statistics"
                f"?limit=100&offset={offset}&accumulation={accumulation}"
                f"&fields={self._fields}&filters=position.in.{POSITIONS}"
            )
            for row in data.get("results", []):
                player = row.pop("player", None) or {}
                team = row.pop("team", None) or {}
                row["player_id"] = player.get("id")
                row["player"] = player.get("name")
                row["player_slug"] = player.get("slug")
                row["position"] = player.get("position")
                row["team_id"] = team.get("id")
                row["team"] = team.get("name")
                yield row
            pages = data.get("pages", 0)
            if pages == 0 or data.get("page") == pages:
                return
            offset += 100
