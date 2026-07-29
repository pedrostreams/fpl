"""Norsk Tipping (Oddsen) — the only free source here that prices an *unplayed* fixture.

`football-data.co.uk` is retrospective by construction: `E0.csv` contains nothing but played
matches, so it can calibrate the Elo model but can never rate next weekend. This one prices
fixtures before they happen, which makes it the only source that can carry team news.

**There is no API key.** The one header that matters is `Accept`. Carried over from `../vm26`,
which reads the same endpoint for the World Cup; nothing to store, nothing to leak.

    GET /events/FBL/{fromYYYYMMDDHHmm}/{toYYYYMMDDHHmm}   -> events, each with its mainMarket
    GET /markets/{eventId}                                -> every market currently OPEN

`events/{eventId}` and `livedata/{eventId}` return 204 for a non-live match and most other
paths 403, so those two are the whole usable surface. vm26 reads only `mainMarket` off the
event list; `markets/{eventId}` is the one that carries team totals and clean sheets, and it
is why this client exists rather than a copy of vm26's.

**Two properties that shape every caller.** There is no history: any window ending before
today returns 204, so odds are in the same class as `player_snapshots` — not backfillable,
and an uncaptured gameweek is gone permanently. And the horizon is roughly one gameweek, so
this complements `fixture_difficulty` rather than replacing it: market for this gameweek,
Elo for the next six.

Measured 2026-07-29, tournament 35887 (Premier League):
  - 9 of GW1's 10 fixtures posted, each carrying **HUB only**. Fulham v Chelsea, the Monday
    night game, was not posted at all — so incomplete coverage of a priced gameweek is the
    expected state, not an error.
  - Arsenal v Coventry's HUB opened `betStart = 2026-06-21`, two months ahead.
  - Club names arrive in English (`Brighton and Hove Albion`, `Nottingham Forest`), and the
    existing `TeamResolver` resolves all 20 with no new aliases. Verified, not assumed.

Market depth is **per competition, and the Premier League's is unmeasured**: no PL fixture
falls inside the deep-market window before 21 August. Depth does not track lead time —
Conference League qualifiers 4h out carried 8 markets while Brasil Serie A at 12h carried 46.
`FIX_WHEN_LIVE.md` holds the 19-20 August probe that settles it.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from curl_cffi import requests as curl_requests

BASE = "https://api.norsk-tipping.no/OddsenGameInfo/v1/api"
IMPERSONATE = "chrome120"
HEADERS = {"Accept": "application/json;charset=utf-8"}

# Norsk Tipping tournament ids. The Community Shield is 37442 and is deliberately absent —
# it is not an FPL fixture and would resolve to two Premier League clubs.
PREMIER_LEAGUE = "35887"

SPORT_FOOTBALL = "FBL"


class NorskTippingUnavailable(RuntimeError):
    """The endpoint answered with something other than data or an expected 204."""


def _window(start: date, end: date) -> str:
    """`{from}/{to}` for the events path, and the time components are NOT ours to choose.

    Measured 2026-07-29: the path looks like `YYYYMMDDHHmm`, but only `0000` for `from` and
    `2359` for `to` return data. `202607290001` and `202607291200` both answer **204** for a
    window containing 135 events, as does a `to` of `2300`. So this is a date-range endpoint
    wearing a timestamp's clothes, and it does not support intra-day windows.

    That makes 204 dangerously overloaded — it means both "nothing in this range" and "your
    range was malformed". The fix is structural rather than a validation check: this function
    takes `date`, not `datetime`, so a caller cannot supply a time to get wrong. Passing
    `datetime.now()` straight through is what returned 0 events from a window holding 9
    Premier League fixtures.
    """
    return f"{start:%Y%m%d}0000/{end:%Y%m%d}2359"


class NorskTipping:
    """Read-only client. Construct once per run; it holds no state beyond the session."""

    def __init__(self, timeout: int = 40) -> None:
        self.timeout = timeout

    def _get(self, path: str) -> Any | None:
        """Returns parsed JSON, or None for 204.

        204 is not a failure. It is what the API returns for a window with nothing in it,
        which includes every window in the past and every window beyond the horizon. A
        caller that treats it as an error would fail for the whole preseason — the same
        mistake `2627/E0.csv` 404ing in preseason invites.
        """
        resp = curl_requests.get(
            f"{BASE}/{path}", headers=HEADERS, impersonate=IMPERSONATE, timeout=self.timeout
        )
        if resp.status_code == 204:
            return None
        if resp.status_code != 200:
            raise NorskTippingUnavailable(f"{path} -> HTTP {resp.status_code}")
        if not resp.content:
            return None
        return resp.json()

    def events(
        self,
        start: date,
        end: date,
        *,
        tournament: str | None = PREMIER_LEAGUE,
        sport: str = SPORT_FOOTBALL,
    ) -> list[dict[str, Any]]:
        """Events in the date range, each carrying its `mainMarket` (HUB, when open).

        Takes `date` deliberately — see `_window`: the endpoint only accepts whole days, and
        handing it a time silently returns 204.

        `tournament=None` returns every competition, which is what the August depth probe
        wants; the ingest always passes a single id.
        """
        payload = self._get(f"events/{sport}/{_window(start, end)}")
        events = (payload or {}).get("eventList") or []
        if tournament is None:
            return events
        return [e for e in events if str((e.get("tournament") or {}).get("id")) == tournament]

    def markets(self, event_id: str) -> list[dict[str, Any]]:
        """Every OPEN market for one event.

        Returns HUB alone until roughly 15 hours before kickoff, then up to 46 markets. The
        deep set is where team totals (`{Team} Totalt 0.5`) and clean sheets (`{Team} holder
        nullen`) live — the two numbers that make this source worth having.
        """
        payload = self._get(f"markets/{event_id}")
        if payload is None:
            return []
        return payload.get("markets") or payload.get("marketList") or []
