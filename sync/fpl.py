"""Official FPL API client, plus the type coercion the payloads demand.

The API returns several numeric fields as strings (`selected_by_percent: "74.6"`,
`expected_goals: "25.50"`, `form: "0.0"`) and uses "" / null interchangeably for absent
values, so nothing can be trusted to arrive as the type its name suggests.

Raw payloads are cached to disk on every fetch. Two FBref data losses in a year argue
that a source outage should cost us future data, not the data we already had.
"""

from __future__ import annotations

import gzip
import json
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import requests

from . import config

BASE = "https://fantasy.premierleague.com/api"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


class FplClient:
    def __init__(self, *, cache: bool = True, timeout: int = 60) -> None:
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": UA, "Accept": "application/json"})
        self.timeout = timeout
        self.cache = cache

    def _get(self, path: str, cache_name: str | None = None) -> Any:
        resp = self.session.get(f"{BASE}/{path}", timeout=self.timeout)
        resp.raise_for_status()
        payload = resp.json()
        if self.cache and cache_name:
            self._cache(cache_name, payload)
        return payload

    def _cache(self, name: str, payload: Any) -> None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        out = config.CACHE_DIR / name / f"{stamp}.json.gz"
        out.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(out, "wt", encoding="utf-8") as fh:
            json.dump(payload, fh, separators=(",", ":"))

    # -- endpoints ---------------------------------------------------------- #

    def bootstrap(self) -> dict:
        return self._get("bootstrap-static/", "bootstrap")

    def fixtures(self) -> list[dict]:
        return self._get("fixtures/", "fixtures")

    def element_summary(self, element_id: int) -> dict:
        # Not cached: ~550 files per run would swamp the cache directory for data that
        # is fully reconstructible from `history` rows already in Postgres.
        return self._get(f"element-summary/{element_id}/")

    def event_live(self, event: int) -> dict:
        return self._get(f"event/{event}/live/", f"live-gw{event}")

    def league_standings(self, league_id: int, page: int = 1) -> dict:
        return self._get(f"leagues-classic/{league_id}/standings/?page_standings={page}")

    def entry_picks(self, entry_id: int, event: int) -> dict:
        return self._get(f"entry/{entry_id}/event/{event}/picks/")

    def entry(self, entry_id: int) -> dict:
        return self._get(f"entry/{entry_id}/", f"entry-{entry_id}")

    def entry_history(self, entry_id: int) -> dict:
        return self._get(f"entry/{entry_id}/history/", f"entry-{entry_id}-history")

    def entry_picks_optional(self, entry_id: int, event: int) -> dict | None:
        """The squad, or None if FPL has not published it.

        A 404 here is the expected state before the first deadline — verified 2026-07-26,
        entry 1617827 returns `{"detail":"Not found."}` for GW1 — so it must not raise. Every
        other status still does, because "the endpoint changed shape" and "the squad isn't
        picked yet" need to look different to the caller.
        """
        resp = self.session.get(
            f"{BASE}/entry/{entry_id}/event/{event}/picks/", timeout=self.timeout)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()


# --------------------------------------------------------------------------- #
# Coercion
# --------------------------------------------------------------------------- #

def as_int(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def as_num(v: Any) -> Decimal | None:
    """Decimal, not float — these values land in numeric columns and feed price
    comparisons where binary rounding would create phantom changes."""
    if v is None or v == "":
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, TypeError, ValueError):
        return None


def as_bool(v: Any) -> bool | None:
    return None if v is None else bool(v)


def as_text(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def as_date(v: Any) -> date | None:
    if not v:
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def as_ts(v: Any) -> datetime | None:
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
