"""Forward-looking market odds from Norsk Tipping — the source that expires if unread.

Why this is a separate job and a separate table from `odds.py` / `match_odds`:

  - **Different grain.** `match_odds` is keyed `(season, match_date, home_team_raw,
    away_team_raw)` and upserted — one row per match, forever. Odds *move*, and a price
    captured at the deadline is a different fact from one captured three days earlier, so this
    table is append-on-change with `fetched_at` in the key. Adding `fetched_at` to
    `match_odds`' key would let duplicate football-data rows accumulate, which its upsert
    currently prevents.
  - **The proposed shared key is not implementable.** `docs/feat/allaboutfpl-learnings.md`
    §7.1 suggests `match_odds` gain `source` + `fixture_fpl_id` + `fetched_at` keyed on
    `(fixture, source, fetched_at)`. Existing football-data rows have no `fixture_fpl_id` —
    they are retrospective and pre-date the fixture list — and a Postgres primary key cannot
    contain nulls. One of the two sources would have to lie about its key.
  - **Different market set.** football-data gives market-average 1X2 and O/U 2.5 across
    bookmakers. This gives up to 46 markets from one bookmaker, including team totals and
    clean sheets. Cramming those into `match_odds`' fixed columns would discard most of it.

**Ingest lands the market's own numbers and derives nothing.** That is `odds.py`'s stated rule
and it applies here: the λ-inversion in §7.1 — six constraints on two unknowns, least-squares,
with the residual stored as the goodness check — is modelling and belongs in the derived-views
layer where a `_check` view can assert on it. This job's job is faithful capture.

**Append-on-change, not append-always.** The horizon is one gameweek, so a naive hourly insert
is only ~9 000 rows a season and volume is not the argument. The argument is that every stored
row should be a genuine price movement, which makes "when did this move" answerable directly.
The `player_snapshots` consequence carries over: liveness comes from `sync_runs`, never from
`max(fetched_at)`, because a quiet market writes no rows at all.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any

from .. import config, db
from ..fpl import FplClient
from ..sources.norsk_tipping import NorskTipping, NorskTippingUnavailable
from . import _resolve
from .odds import devig

SOURCE = "norsk-tipping"

# How far ahead to ask. The horizon is roughly one gameweek, but GW1's HUB opened two months
# early, so a wide window costs one request and catches anything posted ahead of schedule.
LOOKAHEAD_DAYS = 60

# A fixture is identified by its two clubs; kickoff is an independent cross-check. Beyond
# this the fixture has been rescheduled (or one side is wrong), which is worth seeing.
KICKOFF_TOLERANCE = timedelta(hours=6)


def _norm(s: str | None) -> str:
    """Lowercase, de-accented, punctuation-flattened — for comparing market and club names."""
    if not s:
        return ""
    out = unicodedata.normalize("NFKD", str(s))
    out = "".join(c for c in out if not unicodedata.combining(c))
    out = out.lower().replace("'", "").replace("-", " ")
    return re.sub(r"\s+", " ", out).strip()


def _odds(sel: dict[str, Any]) -> float | None:
    try:
        v = float(str(sel.get("selectionOdds", "")).replace(",", "."))
    except (TypeError, ValueError):
        return None
    return v if v > 1.0 else None


def _line(text: str) -> float | None:
    """Pull a goal line out of a market or selection name: 'Totalt 2.5' -> 2.5."""
    m = re.search(r"(\d+[.,]5)", text or "")
    return float(m.group(1).replace(",", ".")) if m else None


def _two_way(selections: list[dict[str, Any]], yes: tuple[str, ...],
             no: tuple[str, ...]) -> float | None:
    """De-vigged probability of the first outcome in a two-way market.

    Returns None unless *both* sides are present: `devig` refuses to normalise a partial
    market rather than guessing, and a one-sided price still carries the bookmaker's margin.
    """
    a = b = None
    for s in selections:
        # selectionName first ('Over'), selectionValue as the fallback ('O'). Matched on
        # equality or a full-word prefix — not a single leading letter, because 'Uavgjort'
        # (draw) would otherwise read as 'Under'.
        tag = _norm(s.get("selectionName")) or _norm(s.get("selectionValue"))
        if tag in yes or tag.startswith(tuple(y for y in yes if len(y) > 1)):
            a = _odds(s)
        elif tag in no or tag.startswith(tuple(n for n in no if len(n) > 1)):
            b = _odds(s)
    return devig([a, b])[0]


def _yes(selections: list[dict[str, Any]]) -> float | None:
    return _two_way(selections, ("ja", "yes", "j"), ("nei", "no", "n"))


def _over(selections: list[dict[str, Any]]) -> float | None:
    return _two_way(selections, ("over", "o"), ("under", "u"))


def _side_of(market_name: str, home: str, away: str) -> str | None:
    """Which club a team-specific market names. Longest match wins, so 'Manchester United'
    is not mistaken for 'Manchester City' when both are in the fixture."""
    n = _norm(market_name)
    h, a = _norm(home), _norm(away)
    hit_h, hit_a = h and h in n, a and a in n
    if hit_h and hit_a:
        return "home" if len(h) >= len(a) else "away"
    if hit_h:
        return "home"
    if hit_a:
        return "away"
    return None


def parse_markets(
    markets: list[dict[str, Any]], home: str, away: str
) -> tuple[dict[str, Any], list[str]]:
    """Market list -> de-vigged probabilities, plus the names we did not recognise.

    Pure transform, so `--dry-run` is meaningful and `prove_market_odds.py` can assert on it
    without a network. **The unrecognised list is the point of the return type**: the Premier
    League's deep-market names cannot be verified before 21 August, so anything unmatched has
    to surface in the job's output rather than being silently dropped. Nothing is lost either
    way — every market is stored verbatim in `market_odds.markets`.
    """
    out: dict[str, Any] = {}
    unknown: list[str] = []

    for m in markets:
        name = m.get("marketName") or ""
        n = _norm(name)
        sels = m.get("selections") or []
        if not sels:
            continue

        # 1X2. The only market open outside the deep window, and the one that expires.
        if n == "hub" or (m.get("marketLineType") == "MONEY" and n.startswith("hub")):
            by = {(_norm(s.get("selectionValue")) or "")[:1]: _odds(s) for s in sels}
            p_h, p_d, p_a = devig([by.get("h"), by.get("d"), by.get("a")])
            out.update(odds_home=by.get("h"), odds_draw=by.get("d"), odds_away=by.get("a"),
                       p_home=p_h, p_draw=p_d, p_away=p_a)
            continue

        # Both teams to score.
        if "begge lag scorer" in n or "btts" in n:
            out["p_btts"] = _yes(sels)
            continue

        # Clean sheet — `holder nullen`. The single most valuable field here: clean sheets
        # decide every goalkeeper and defender, and a market price has the centre-back's
        # suspension already in it where `exp(-lambda)` does not.
        if "holder nullen" in n or "clean sheet" in n:
            if side := _side_of(name, home, away):
                out[f"p_{side}_clean_sheet"] = _yes(sels)
            else:
                unknown.append(name)
            continue

        # Team totals — `{Team} Totalt 0.5` over is P(team scores 1+), `1.5` is P(2+).
        # These are allaboutfpl's `% 1+ Goal` and `% 2+ Goals`, priced instead of modelled.
        # A `totalt` market with no club in its name falls through to the whole-match O/U
        # branch below, which is what `Totalt antall mål 2.5` is.
        if "totalt" in n and (side := _side_of(name, home, away)):
            line = _line(name) or _line(str(sels[0].get("selectionName") or ""))
            if line == 0.5:
                out[f"p_{side}_scores"] = _over(sels)
            elif line == 1.5:
                out[f"p_{side}_scores_2plus"] = _over(sels)
            else:
                unknown.append(name)
            continue

        # Whole-match goals over/under.
        if ("totalt" in n or "total" in n or "over" in n) and (line := _line(name)):
            key = {0.5: "p_over_05", 1.5: "p_over_15",
                   2.5: "p_over_25", 3.5: "p_over_35"}.get(line)
            if key:
                out[key] = _over(sels)
            else:
                unknown.append(name)
            continue

        # Correct score carries the full scoreline distribution, from which team totals are
        # exact. Deliberately not inverted here — see the module docstring: that is modelling.
        if "korrekt resultat" in n or "correct score" in n:
            continue

        unknown.append(name)

    return out, unknown


# The probability columns compared to decide whether a price actually moved.
DRIFT_KEYS = (
    "p_home", "p_draw", "p_away", "p_btts",
    "p_over_05", "p_over_15", "p_over_25", "p_over_35",
    "p_home_scores", "p_away_scores",
    "p_home_scores_2plus", "p_away_scores_2plus",
    "p_home_clean_sheet", "p_away_clean_sheet",
)


def _signature(row: dict[str, Any]) -> tuple:
    """What counts as a change. Rounded to the stored scale so a numeric round-trip through
    Postgres cannot manufacture a phantom movement — the same reason `fpl.as_num` returns
    Decimal rather than float."""
    return tuple(
        None if row.get(k) is None else round(float(row[k]), 5) for k in DRIFT_KEYS
    )


def build(
    events: list[dict[str, Any]],
    markets_by_event: dict[str, list[dict[str, Any]]],
    season: str,
    fetched_at: datetime,
) -> list[dict[str, Any]]:
    """Events + their markets -> rows. Pure, so `--dry-run` exercises the whole transform."""
    rows: list[dict[str, Any]] = []
    for e in events:
        event_id = str(e.get("eventId") or "")
        home = e.get("homeParticipant") or ""
        away = e.get("awayParticipant") or ""
        if not event_id or not home or not away:
            continue

        kickoff = e.get("startTime")
        markets = markets_by_event.get(event_id) or []
        main = e.get("mainMarket")
        # The event list carries HUB inline; `markets/{id}` repeats it. Feed both so a run
        # that could not reach `markets/` still lands the 1X2 — which is the part that expires.
        if main and not any(_norm(m.get("marketName")) == "hub" for m in markets):
            markets = [main, *markets]

        probs, unknown = parse_markets(markets, home, away)
        rows.append({
            "source": SOURCE,
            "season": season,
            "external_event_id": event_id,
            "kickoff": kickoff,
            "home_team_raw": home,
            "away_team_raw": away,
            "fetched_at": fetched_at,
            "market_count": len(markets),
            "unrecognised_markets": unknown,
            "markets": {"markets": markets},
            **{k: None for k in DRIFT_KEYS},
            **probs,
        })
    return rows


def _load_fixtures(conn, season: str) -> dict[tuple[int, int], dict[str, Any]]:
    """`{(home_code, away_code): fixture}` — unique within a season, since each pair meets
    once at each ground."""
    rows = db.fetch(
        conn,
        """select fpl_id, event, team_h_code, team_a_code, kickoff_time
             from fixtures where season = %s""",
        (season,),
    )
    return {(r["team_h_code"], r["team_a_code"]): r for r in rows}


def run(
    client: FplClient | None = None,
    *,
    dry_run: bool = False,
    season: str | None = None,
) -> dict[str, Any]:
    fetched_at = datetime.now(timezone.utc)
    nt = NorskTipping()

    if season is None:
        events_payload = client.bootstrap()["events"] if client else []
        season = config.season_label(events_payload) if events_payload else "2026-27"

    detail: dict[str, Any] = {"source": SOURCE, "season": season,
                              "fetched_at": fetched_at.isoformat()}

    try:
        # Whole days only, and `date` is what the client accepts — the endpoint answers 204 to
        # any window carrying a time. Starting from today rather than now also means a run at
        # 23:50 cannot miss an event kicking off at 23:55.
        today = fetched_at.date()
        events = nt.events(today, today + timedelta(days=LOOKAHEAD_DAYS))
    except NorskTippingUnavailable as exc:
        # Never fatal. Odds are decision support, not scoring — vm26's rule, and the reason
        # a blocked run must not take the rest of `enrich` down with it.
        detail["error"] = str(exc)
        return detail

    detail["events_found"] = len(events)
    if not events:
        # 204 or an empty window. Expected outside the horizon, and not a failure.
        detail["note"] = "no Premier League events in window (expected outside the horizon)"
        return detail

    markets_by_event: dict[str, list[dict[str, Any]]] = {}
    for e in events:
        eid = str(e.get("eventId") or "")
        if not eid:
            continue
        try:
            markets_by_event[eid] = nt.markets(eid)
        except NorskTippingUnavailable as exc:
            detail.setdefault("market_errors", []).append(f"{eid}: {exc}")

    rows = build(events, markets_by_event, season, fetched_at)
    deepest = max((r["market_count"] for r in rows), default=0)
    unknown = sorted({n for r in rows for n in r["unrecognised_markets"]})
    detail.update({
        "parsed": len(rows),
        "deepest_market_count": deepest,
        "with_1x2": sum(1 for r in rows if r["p_home"] is not None),
        "with_team_totals": sum(1 for r in rows if r["p_home_scores"] is not None),
        "with_clean_sheet": sum(1 for r in rows if r["p_home_clean_sheet"] is not None),
        # The August depth probe reads exactly this line.
        "unrecognised_markets": unknown,
    })

    if dry_run:
        detail["would_write"] = len(rows)
        if rows:
            s = rows[0]
            detail["sample"] = {k: s[k] for k in
                                ("external_event_id", "home_team_raw", "away_team_raw",
                                 "kickoff", "market_count", "p_home", "p_draw", "p_away")}
        return detail

    with db.connect() as conn:
        with db.sync_run(conn, "market_odds") as state:
            teams = _resolve.load_team_resolver(conn)
            fixtures = _load_fixtures(conn, season)

            previous = {
                r["external_event_id"]: r
                for r in db.fetch(
                    conn,
                    f"""select distinct on (external_event_id) external_event_id,
                               {', '.join(DRIFT_KEYS)}
                          from market_odds
                         where source = %s and season = %s
                         order by external_event_id, fetched_at desc""",
                    (SOURCE, season),
                )
            }

            unmatched: list[dict[str, Any]] = []
            rescheduled: list[str] = []
            changed: list[dict[str, Any]] = []

            for r in rows:
                r["home_team_code"] = teams.code(r["home_team_raw"])
                r["away_team_code"] = teams.code(r["away_team_raw"])
                fx = fixtures.get((r["home_team_code"], r["away_team_code"]))
                if fx:
                    r["fixture_fpl_id"], r["event"] = fx["fpl_id"], fx["event"]
                    if r["kickoff"] and fx["kickoff_time"]:
                        drift = abs(datetime.fromisoformat(r["kickoff"]) - fx["kickoff_time"])
                        if drift > KICKOFF_TOLERANCE:
                            rescheduled.append(
                                f"{r['home_team_raw']} v {r['away_team_raw']}: "
                                f"NT {r['kickoff']} vs fixture {fx['kickoff_time']}")
                else:
                    r["fixture_fpl_id"] = r["event"] = None
                    unmatched.append({"raw_name": f"{r['home_team_raw']} v {r['away_team_raw']}",
                                      "raw_team": r["home_team_raw"],
                                      "external_id": r["external_event_id"]})

                if _signature(r) != _signature(previous.get(r["external_event_id"], {})):
                    changed.append(r)

            for r in changed:
                r.pop("unrecognised_markets", None)

            written = db.insert_ignore(
                conn, "market_odds", changed,
                ("source", "external_event_id", "fetched_at"))

            if unmatched:
                _resolve.log_unmatched(conn, SOURCE, "fixture", season, unmatched)

            detail.update({
                "rows_written": written,
                "unchanged_skipped": len(rows) - len(changed),
                "fixtures_matched": sum(1 for r in rows if r.get("fixture_fpl_id")),
                "fixtures_unmatched": len(unmatched),
                "rescheduled": rescheduled,
                "unknown_teams": teams.report(),
            })
            state["rows"] = written
            state["detail"] = detail

    return detail
