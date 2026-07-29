"""Probe every free data source this project depends on, and report what is alive.

This script is the evidence behind docs/DATA_SOURCES.md section 1. The free football
data landscape lost StatsBomb-on-FBref and then Opta-on-FBref inside about a year, so
re-run this before trusting any claim in that document.

    python scripts/probe/probe_sources.py            # everything
    python scripts/probe/probe_sources.py understat  # one source
    python scripts/probe/probe_sources.py --strict   # blocked sources fail too

Exit code is the number of FAILed checks, so CI can gate on it. A source that is alive but
refuses our IP or quota reports as BLOCKED and does not fail the build by default — that
is a hosting problem, not a code one, and Sofascore is permanently in that state on
GitHub Actions runners.
"""

from __future__ import annotations

import sys
import traceback
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

failed: list[str] = []
blocked: list[str] = []


def hdr(name: str) -> None:
    print(f"\n{'=' * 72}\n{name}\n{'=' * 72}", flush=True)


def ok(msg: str) -> None:
    print(f"PASS  {msg}", flush=True)


def bad(msg: str) -> None:
    failed.append(msg)
    print(f"FAIL  {msg}", flush=True)


def trace() -> None:
    """Print the traceback to stdout, not stderr.

    GitHub Actions interleaves the two streams unpredictably, which once put a traceback
    *below* the summary and made a 2-failure run look like a 1-failure run. One stream
    keeps the log readable in order.
    """
    traceback.print_exc(file=sys.stdout)
    sys.stdout.flush()


class _RateLimited(RuntimeError):
    """Refused for quota reasons, not because the source changed. Same class of problem as
    an IP block: a hosting concern, so it reports as BLOCKED rather than FAIL."""


def blocked_from_here(source: str, msg: str) -> None:
    """The source is alive but refuses this network — a hosting problem, not a code one.

    Kept distinct from FAIL so CI stays meaningful: Sofascore 403s GitHub Actions runners
    (datacenter IPs) while serving a home connection fine. Counting that as a failure
    would either make the build permanently red or train us to ignore it.
    """
    blocked.append(source)
    print(f"BLOCKED  {msg}", flush=True)


# --------------------------------------------------------------------------- #
# Tier 1
# --------------------------------------------------------------------------- #

def check_fpl_api() -> None:
    hdr("Official FPL API — fantasy.premierleague.com/api (Tier 1, core)")
    import requests

    s = requests.Session()
    s.headers["User-Agent"] = BROWSER_UA
    base = "https://fantasy.premierleague.com/api"

    try:
        b = s.get(f"{base}/bootstrap-static/", timeout=60).json()
        el, tm, ev = b["elements"], b["teams"], b["events"]
        ok(f"bootstrap-static: {len(el)} players x {len(el[0])} fields, "
           f"{len(tm)} teams, {len(ev)} events")

        # The preseason carry-over trap: aggregates belong to LAST season until GW1.
        nxt = next((e for e in ev if e["is_next"]), None)
        cur = next((e for e in ev if e["is_current"]), None)
        if nxt:
            print(f"      next event: GW{nxt['id']} deadline {nxt['deadline_time']}")
        preseason = cur is None
        print(f"      preseason (no current event): {preseason}"
              f"  -> aggregates in `elements` are PRIOR-season if True")

        # Fields we design around; a rename here breaks the sync.
        required = [
            "code", "opta_code", "now_cost", "cost_change_event", "price_change_percent",
            "selected_by_percent", "transfers_in_event", "transfers_out_event",
            "expected_goals", "expected_assists", "expected_goals_conceded",
            "defensive_contribution", "defensive_contribution_per_90",
            "clearances_blocks_interceptions", "recoveries", "tackles",
            "status", "news", "chance_of_playing_next_round",
            "penalties_order", "direct_freekicks_order",
            "corners_and_indirect_freekicks_order", "scout_risks",
        ]
        missing = [f for f in required if f not in el[0]]
        if missing:
            bad(f"bootstrap-static missing expected fields: {missing}")
        else:
            ok(f"all {len(required)} design-critical player fields present")

        setp = sum(1 for p in el if p.get("penalties_order") is not None)
        newsy = sum(1 for p in el if p.get("news"))
        risks = sum(1 for p in el if p.get("scout_risks"))
        statuses = {}
        for p in el:
            statuses[p["status"]] = statuses.get(p["status"], 0) + 1
        print(f"      penalty takers={setp}  players with news={newsy}  "
              f"scout_risks populated={risks}  statuses={statuses}")
    except Exception:
        bad("bootstrap-static"); trace()

    try:
        f = s.get(f"{base}/fixtures/", timeout=60).json()
        ok(f"fixtures: {len(f)} rows x {len(f[0])} fields "
           f"(FDR present: {'team_h_difficulty' in f[0]})")
    except Exception:
        bad("fixtures"); trace()

    try:
        pid = b["elements"][0]["id"]
        es = s.get(f"{base}/element-summary/{pid}/", timeout=60).json()
        ok(f"element-summary/{pid}: history={len(es['history'])} "
           f"history_past={len(es['history_past'])} fixtures={len(es['fixtures'])}")
    except Exception:
        bad("element-summary"); trace()


# --------------------------------------------------------------------------- #
# Tier 2
# --------------------------------------------------------------------------- #

def check_understat() -> None:
    hdr("Understat via soccerdata — PPDA, deep completions, shot events (Tier 2)")
    try:
        import soccerdata as sd
        us = sd.Understat(leagues="ENG-Premier League", seasons="2025/2026")

        players = us.read_player_season_stats().reset_index()
        ok(f"read_player_season_stats: {len(players)} rows x {len(players.columns)} cols")

        teams = us.read_team_match_stats().reset_index()
        has_ppda = any("ppda" in c for c in teams.columns)
        has_deep = any("deep_completions" in c for c in teams.columns)
        ok(f"read_team_match_stats: {len(teams)} rows x {len(teams.columns)} cols "
           f"(ppda={has_ppda}, deep_completions={has_deep})")
        if not (has_ppda and has_deep):
            bad("team-style columns missing — defensive profiling depends on these")

        sched = us.read_schedule().reset_index()
        # A short row count almost always means a stale soccerdata cache, not an
        # Understat gap: a local cache reported 346/380 team-matches while a fresh CI
        # cache returned the full 380 on the same day (2026-07-26). Clear
        # ~/soccerdata/data/Understat before concluding the source is incomplete.
        if len(teams) < len(sched):
            print(f"      NOTE {len(teams)} team-match rows vs {len(sched)} scheduled — "
                  f"likely a stale soccerdata cache; clear it before trusting this")

        shots = us.read_shot_events().reset_index()
        ok(f"read_shot_events: {len(shots)} rows x {len(shots.columns)} cols")
    except Exception:
        bad("understat"); trace()


def check_sofascore() -> None:
    hdr("Sofascore via direct API + curl_cffi TLS impersonation (Tier 2)")
    # Deliberately NOT via ScraperFC: importing it pulls in botasaurus_requests, which
    # downloads a TLS binary from GitHub releases at import time. That download 403s on
    # Actions runners, so the import dies before Sofascore is ever contacted.
    from sync.sources.sofascore import Sofascore, SofascoreBlocked

    try:
        sofa = Sofascore()
        seasons = sofa.seasons()
        # Don't sort these lexically — Sofascore labels run '26/27'...'99/00', so a
        # string sort reports 1999 as the newest season. Check for the ones we need.
        have = {s: seasons.get(s) for s in ("25/26", "26/27")}
        ok(f"seasons: {len(seasons)} available; "
           + ", ".join(f"{s}={'id ' + str(i) if i else 'MISSING'}"
                       for s, i in have.items()))
        if not have["25/26"]:
            bad("Sofascore has no 25/26 season — enrichment has no completed season")

        rows = sofa.player_season_stats("25/26")
        if not rows:
            bad("player_season_stats returned no rows")
            return
        ok(f"player_season_stats: {len(rows)} rows x {len(rows[0])} cols")

        # A subset that exists nowhere else in the free stack — if these vanish, the
        # source is still up but no longer worth the dependency.
        wanted = ("rating", "goalsPrevented", "bigChancesCreated", "ballRecovery",
                  "possessionWonAttThird", "expectedGoals", "minutesPlayed")
        missing = [w for w in wanted if w not in rows[0]]
        if missing:
            bad(f"Sofascore no longer returns: {missing}")
        else:
            ok(f"all {len(wanted)} signature stats present")
    except SofascoreBlocked as exc:
        blocked_from_here("sofascore", f"sofascore: {exc}")
    except Exception:
        bad("sofascore"); trace()


def check_clubelo() -> None:
    hdr("ClubElo — api.clubelo.com (Tier 2, team strength)")
    try:
        from curl_cffi import requests as cr
        r = cr.get("http://api.clubelo.com/Arsenal", impersonate="chrome120", timeout=30)
        r.raise_for_status()
        lines = r.text.strip().split("\n")
        ok(f"Arsenal: {len(lines) - 1} rows | header={lines[0]}")
        print(f"      latest: {lines[-1]}")
    except Exception:
        bad("clubelo"); trace()


def check_football_data_couk() -> None:
    hdr("football-data.co.uk — results + bookmaker odds CSV (Tier 2, odds)")
    from curl_cffi import requests as cr
    # 2627 only appears once matches are played; a 404 preseason is expected.
    for season, required in (("2526", True), ("2627", False)):
        try:
            r = cr.get(f"https://www.football-data.co.uk/mmz4281/{season}/E0.csv",
                       impersonate="chrome120", timeout=30)
            if r.status_code != 200:
                msg = f"{season}: HTTP {r.status_code}"
                bad(msg) if required else print(f"      {msg} (expected preseason)")
                continue
            lines = r.text.strip().split("\n")
            cols = lines[0].split(",")
            ok(f"{season}: {len(lines) - 1} rows x {len(cols)} cols")
        except Exception:
            bad(f"football-data.co.uk {season}"); trace()


def check_norsk_tipping() -> None:
    hdr("Norsk Tipping (Oddsen) — api.norsk-tipping.no (Tier 2, forward-looking odds)")
    from sync.sources.norsk_tipping import NorskTipping

    try:
        nt = NorskTipping()
        today = date.today()
        events = nt.events(today, today + timedelta(days=60))
        if not events:
            # No PL fixture inside the horizon. Expected between gameweeks and for most of
            # the preseason — the same shape as 2627/E0.csv 404ing, and not a failure.
            print("      no Premier League events in the next 60 days (expected off-season)")
            return

        depth = {}
        for e in events[:3]:
            depth[e.get("eventName")] = len(nt.markets(str(e.get("eventId"))))
        deepest = max(depth.values(), default=0)
        ok(f"tournament 35887: {len(events)} events | markets on first 3: {depth}")

        # The prize is the 46-market set: team totals and `holder nullen`. It opens ~15h
        # before kickoff and the PL's depth is unmeasured until 2026-08-21 — see
        # FIX_WHEN_LIVE. HUB alone is the expected answer outside that window, so this
        # prints rather than fails.
        if deepest <= 1:
            print("      HUB only — deep markets not open yet (expected outside ~15h)")
        else:
            names = [m.get("marketName") for m in nt.markets(str(events[0].get("eventId")))]
            print(f"      DEEP SET OPEN ({deepest} markets): {names}")
    except Exception:
        bad("norsk-tipping"); trace()


# --------------------------------------------------------------------------- #
# Tier 3
# --------------------------------------------------------------------------- #

def check_fpl_core_insights() -> None:
    hdr("olbauday/FPL-Core-Insights — GitHub CSV mirror (Tier 3, cross-check)")
    import os

    import requests

    s = requests.Session()
    s.headers.update({"User-Agent": BROWSER_UA, "Accept": "application/vnd.github+json"})

    # Unauthenticated GitHub API is 60 requests/hour *per IP*, and Actions runners share
    # IPs — so this check crashed in CI on a rate-limit response. GITHUB_TOKEN is provided
    # automatically inside Actions and lifts the limit well clear of any real usage.
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        s.headers["Authorization"] = f"Bearer {token}"
    print(f"      auth: {'GITHUB_TOKEN' if token else 'anonymous (60 req/hour per IP)'}")

    repo = "https://api.github.com/repos/olbauday/FPL-Core-Insights"

    def api(path: str):
        """Return parsed JSON, or raise RateLimited / RuntimeError with GitHub's reason.

        The API answers errors with a JSON *object* where success gives an array, which is
        why a bare `c[0]` produced `KeyError: 0` instead of anything diagnosable.
        """
        resp = s.get(f"{repo}{path}", timeout=45)
        payload = resp.json()
        if isinstance(payload, dict) and "message" in payload:
            msg = payload["message"]
            if resp.status_code in (403, 429) or "rate limit" in msg.lower():
                raise _RateLimited(f"{resp.status_code}: {msg}")
            raise RuntimeError(f"GitHub {resp.status_code}: {msg}")
        return payload

    try:
        commits = api("/commits?per_page=1")
        if not commits:
            bad("fpl-core-insights: repository has no commits")
            return
        head = commits[0]["commit"]
        ok(f"last commit: {head['author']['date']} — {head['message'].splitlines()[0]}")

        tree = api("/contents/data/2026-2027")
        if isinstance(tree, list):
            ok(f"data/2026-2027: {sorted(e['name'] for e in tree)}")
        else:
            bad(f"data/2026-2027 is not a directory listing: {tree!r}")
    except _RateLimited as exc:
        blocked_from_here("fpl-core-insights", f"fpl-core-insights rate-limited — {exc}")
    except Exception:
        bad("fpl-core-insights"); trace()


# --------------------------------------------------------------------------- #

CHECKS = {
    "fpl": check_fpl_api,
    "understat": check_understat,
    "sofascore": check_sofascore,
    "clubelo": check_clubelo,
    "odds": check_football_data_couk,
    "norsktipping": check_norsk_tipping,
    "coreinsights": check_fpl_core_insights,
}


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    strict = "--strict" in sys.argv          # treat blocked sources as failures too
    which = args[0] if args else "all"
    if which != "all" and which not in CHECKS:
        print(f"unknown check {which!r}; pick from: all, {', '.join(CHECKS)}")
        return 2

    for name, fn in CHECKS.items():
        if which in ("all", name):
            fn()

    print(f"\n{'=' * 72}")
    # Name them. A bare count once read as "1 failure" while the log actually held two,
    # because the second traceback had been interleaved out of view.
    print(f"{len(failed)} FAILED" + (f": {', '.join(failed)}" if failed else ""))
    if blocked:
        print(f"{len(blocked)} BLOCKED from this network: {', '.join(blocked)}")
        print("  Alive, but refusing this IP or quota — a hosting problem, not a code one.")
        print("  Sofascore filters datacenter ranges, so it is expected to be blocked on")
        print("  GitHub Actions; run that ingest from a residential connection or a")
        print("  self-hosted runner. Use --strict to fail the build on blocked sources.")
    print("=" * 72)
    return len(failed) + (len(blocked) if strict else 0)


if __name__ == "__main__":
    sys.exit(main())
