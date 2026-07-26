"""Probe every free data source this project depends on, and report what is alive.

This script is the evidence behind docs/DATA_SOURCES.md section 1. The free football
data landscape lost StatsBomb-on-FBref and then Opta-on-FBref inside about a year, so
re-run this before trusting any claim in that document.

    python scripts/probe/probe_sources.py            # everything
    python scripts/probe/probe_sources.py understat  # one source

Exit code is the number of FAILed checks, so CI can gate on it.
"""

from __future__ import annotations

import sys
import traceback

BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

failures = 0


def hdr(name: str) -> None:
    print(f"\n{'=' * 72}\n{name}\n{'=' * 72}", flush=True)


def ok(msg: str) -> None:
    print(f"PASS  {msg}", flush=True)


def bad(msg: str) -> None:
    global failures
    failures += 1
    print(f"FAIL  {msg}", flush=True)


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
        bad("bootstrap-static"); traceback.print_exc()

    try:
        f = s.get(f"{base}/fixtures/", timeout=60).json()
        ok(f"fixtures: {len(f)} rows x {len(f[0])} fields "
           f"(FDR present: {'team_h_difficulty' in f[0]})")
    except Exception:
        bad("fixtures"); traceback.print_exc()

    try:
        pid = b["elements"][0]["id"]
        es = s.get(f"{base}/element-summary/{pid}/", timeout=60).json()
        ok(f"element-summary/{pid}: history={len(es['history'])} "
           f"history_past={len(es['history_past'])} fixtures={len(es['fixtures'])}")
    except Exception:
        bad("element-summary"); traceback.print_exc()


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
        if len(teams) < len(sched[sched.get("has_data", True) == True]):  # noqa: E712
            print(f"      NOTE coverage gap: {len(teams)} team-match rows vs "
                  f"{len(sched)} scheduled — reconcile against has_data")

        shots = us.read_shot_events().reset_index()
        ok(f"read_shot_events: {len(shots)} rows x {len(shots.columns)} cols")
    except Exception:
        bad("understat"); traceback.print_exc()


def check_sofascore() -> None:
    hdr("Sofascore via ScraperFC + curl_cffi TLS impersonation (Tier 2)")
    try:
        import ScraperFC as sfc
        import ScraperFC.sofascore as sofa_mod
        from curl_cffi import requests as cr

        # Sofascore gates on TLS fingerprint: plain requests/cloudscraper get 403,
        # curl_cffi impersonating chrome120 gets 200. Patching the module-level JSON
        # getter avoids ScraperFC's botasaurus/Chrome dependency entirely.
        def _get_json(url: str, *a, **k) -> dict:
            resp = cr.get(url, impersonate="chrome120", timeout=30)
            resp.raise_for_status()
            return resp.json()

        patched = [a for a in ("botasaurus_browser_get_json", "get_json", "_get_json")
                   if hasattr(sofa_mod, a)]
        for a in patched:
            setattr(sofa_mod, a, _get_json)
        if not patched:
            bad("no known patch point on ScraperFC.sofascore — API changed")
            return
        print(f"      patched hooks: {patched}")

        df = sfc.Sofascore().scrape_player_league_stats(
            year="25/26", league="England Premier League")
        ok(f"scrape_player_league_stats: {len(df)} rows x {len(df.columns)} cols")
    except Exception:
        bad("sofascore"); traceback.print_exc()


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
        bad("clubelo"); traceback.print_exc()


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
            bad(f"football-data.co.uk {season}"); traceback.print_exc()


# --------------------------------------------------------------------------- #
# Tier 3
# --------------------------------------------------------------------------- #

def check_fpl_core_insights() -> None:
    hdr("olbauday/FPL-Core-Insights — GitHub CSV mirror (Tier 3, cross-check)")
    import requests
    s = requests.Session()
    s.headers.update({"User-Agent": BROWSER_UA, "Accept": "application/vnd.github+json"})
    repo = "https://api.github.com/repos/olbauday/FPL-Core-Insights"
    try:
        c = s.get(f"{repo}/commits?per_page=1", timeout=45).json()
        ok(f"last commit: {c[0]['commit']['author']['date']} — "
           f"{c[0]['commit']['message'].splitlines()[0]}")
        t = s.get(f"{repo}/contents/data/2026-2027", timeout=45).json()
        if isinstance(t, list):
            ok(f"data/2026-2027: {[e['name'] for e in t]}")
        else:
            bad(f"data/2026-2027 not a directory listing: {t}")
    except Exception:
        bad("fpl-core-insights"); traceback.print_exc()


# --------------------------------------------------------------------------- #

CHECKS = {
    "fpl": check_fpl_api,
    "understat": check_understat,
    "sofascore": check_sofascore,
    "clubelo": check_clubelo,
    "odds": check_football_data_couk,
    "coreinsights": check_fpl_core_insights,
}


def main() -> int:
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which != "all" and which not in CHECKS:
        print(f"unknown check {which!r}; pick from: all, {', '.join(CHECKS)}")
        return 2
    for name, fn in CHECKS.items():
        if which in ("all", name):
            fn()
    print(f"\n{'=' * 72}\n{failures} FAILED check(s)\n{'=' * 72}")
    return failures


if __name__ == "__main__":
    sys.exit(main())
