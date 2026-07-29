"""Re-derive every statistic behind the style section, independently, and fail on drift.

    python scripts/probe/prove_style_claims.py

Exit code is the number of FAILed checks. **This one needs DATABASE_URL** -- unlike the three
`prove_*` scripts that gate CI, the quantities here are properties of 646 club-matches and
cannot be asserted against a fixture. Run it like `calibrate_elo_fixtures.py`, by hand, and
after any change to migration 0021 or 0022.

Why it exists: migration 0021's header quotes reliabilities that decide whether a rank appears
on screen, and a number in a comment is a number that can go stale. Every figure here is
recomputed from the raw tables by a second implementation and compared with what the views
return, so the views are checked against the statistics rather than against themselves.

The four things it proves:

  1. VARIANCE DECOMPOSITION. Python recomputes reliability per metric from
     `understat_team_match` and `understat_shots` and must match `team_style_reliability`.
     A pure-SQL bug that reproduced a plausible-but-wrong reliability would otherwise be
     invisible, and the whole rank gate hangs off this number.

  2. THE DELTA METHOD. Dead-ball share is a ratio of correlated sums, and its standard error
     comes from the delta method because sd/sqrt(n) is meaningless for a ratio. Checked against
     a within-club bootstrap, which is the estimator that needs no algebra to be right.

  3. THE GATES. Reliability governs the ordering; a club's own standard error governs whether
     that club can be named. Both recomputed and compared row by row.

  4. THE PERMUTATION TEST. The reference for the trend filter. Shuffle each club's own season
     and ask how often a random window falls as far from the season mean as the actual last N.
     `team_trend`'s cheap z-score must agree with it on which pairs survive -- that agreement
     is the only reason a view is allowed to stand in for a permutation test. Runs last
     because 20 000 shuffles per club-metric-window is by far the slowest check here.
"""

from __future__ import annotations

import math
import os
import random
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

REPO = Path(__file__).resolve().parents[2]

# Fixed seeds: a probe that fails intermittently teaches nothing.
PERM_SEED = 20260729
BOOT_SEED = 20260730
PERMUTATIONS = 20000
BOOTSTRAPS = 4000

failed: list[str] = []


def hdr(name: str) -> None:
    print(f"\n{'=' * 78}\n{name}\n{'=' * 78}", flush=True)


def ok(msg: str) -> None:
    print(f"PASS  {msg}", flush=True)


def bad(msg: str) -> None:
    failed.append(msg)
    print(f"FAIL  {msg}", flush=True)


def close(a: float | None, b: float | None, tol: float) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(float(a) - float(b)) <= tol


# ---------------------------------------------------------------------------
# The same per-match series the views build, assembled here from the raw tables so that a
# mistake in migration 0021's unions cannot hide behind itself.
# ---------------------------------------------------------------------------
SERIES_SQL = """
with shot_team as (
  select season, game_id, team_code,
         count(*) as shots,
         sum(xg) as np_xg,
         sum(xg) filter (
           where situation in ('From Corner', 'Set Piece', 'Direct Freekick')
         ) as dead_xg
  from understat_shots
  where result <> 'Own Goal' and situation <> 'Penalty' and team_code is not null
  group by season, game_id, team_code
),
shot_game as (
  select season, game_id, count(*) as shots
  from understat_shots
  where result <> 'Own Goal' and situation <> 'Penalty'
  group by season, game_id
)
select
  m.season, m.team_code, m.kickoff,
  m.xg::float                                                        as xg,
  m.opponent_xg::float                                               as xga,
  m.deep_completions::float                                          as deep_for,
  m.opponent_deep_completions::float                                 as deep_conc,
  m.ppda::float                                                      as ppda,
  case when g.shots is null then null else coalesce(s.shots, 0)::float end          as shots_for,
  case when g.shots is null then null else (g.shots - coalesce(s.shots, 0))::float end as shots_conc,
  case when g.shots is null then null else coalesce(s.dead_xg, 0)::float end        as dead_xg,
  case when g.shots is null then null else coalesce(s.np_xg, 0)::float end          as np_xg_shots
from understat_team_match m
left join shot_team s
  on s.season = m.season and s.game_id = m.game_id and s.team_code = m.team_code
left join shot_game g
  on g.season = m.season and g.game_id = m.game_id
where m.team_code is not null
order by m.team_code, m.kickoff
"""

MEANS = ["deep_for", "shots_for", "xg", "shots_conc", "deep_conc", "xga", "ppda"]


def connect():
    """Load .env the way the sync jobs do, then connect."""
    env = REPO / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL is not set. This probe reads the database by design — see the")
        print("module docstring. The three CI probes are the ones that need no connection.")
        sys.exit(2)
    import psycopg
    from psycopg.rows import dict_row

    return psycopg.connect(url, row_factory=dict_row)


def load(conn) -> dict[int, list[dict]]:
    clubs: dict[int, list[dict]] = {}
    for r in conn.execute(SERIES_SQL).fetchall():
        clubs.setdefault(r["team_code"], []).append(r)
    return clubs


# ---------------------------------------------------------------------------
# 1 + 2. Reliability, both kinds of figure
# ---------------------------------------------------------------------------
def club_figures(clubs: dict[int, list[dict]], metric: str) -> dict[int, tuple[float, float, int]]:
    """(value, standard error, matches) per club — a mean, or the one ratio."""
    out = {}
    for code, rows in clubs.items():
        if metric == "dead_share":
            pairs = [(r["dead_xg"], r["np_xg_shots"]) for r in rows
                     if r["dead_xg"] is not None and r["np_xg_shots"] is not None]
            if len(pairs) < 20:
                continue
            n = len(pairs)
            num = [a for a, _ in pairs]
            den = [b for _, b in pairs]
            nb, db = statistics.fmean(num), statistics.fmean(den)
            vn, vd = statistics.variance(num), statistics.variance(den)
            cov = sum((a - nb) * (b - db) for a, b in pairs) / (n - 1)
            # Delta method. The covariance term is not a refinement: a club that attacks more
            # has a larger numerator AND denominator, and dropping it overstates the error.
            var = vn / db**2 + nb**2 * vd / db**4 - 2 * nb * cov / db**3
            out[code] = (sum(num) / sum(den), math.sqrt(max(var, 0) / n), n)
        else:
            v = [r[metric] for r in rows if r[metric] is not None]
            if len(v) < 20:
                continue
            out[code] = (statistics.fmean(v), math.sqrt(statistics.variance(v) / len(v)), len(v))
    return out


def decompose(figures: dict[int, tuple[float, float, int]]) -> tuple[float, float, float, float]:
    """(reliability, reliability_6, sd_between, sd_noise) — the ICC, uniform across both kinds."""
    vals = [v for v, _, _ in figures.values()]
    var_noise = statistics.fmean([se * se for _, se, _ in figures.values()])
    var_between = max(statistics.variance(vals) - var_noise, 0.0)
    n = statistics.fmean([m for _, _, m in figures.values()])
    rel = var_between / (var_between + var_noise) if var_between else 0.0
    rel6 = var_between / (var_between + var_noise * n / 6) if var_between else 0.0
    return rel, rel6, math.sqrt(var_between), math.sqrt(var_noise)


def check_reliability(conn, clubs) -> None:
    hdr("1. Variance decomposition — recomputed, and compared with team_style_reliability")
    rows = {r["metric"]: r for r in conn.execute(
        "select * from team_style_reliability").fetchall()}
    print(f"{'metric':12}{'rel (py)':>10}{'rel (sql)':>11}{'rel6 py':>9}{'rel6 sql':>10}"
          f"{'sd_b py':>9}{'sd_b sql':>10}")
    for metric in MEANS + ["dead_share"]:
        figs = club_figures(clubs, metric)
        rel, rel6, sd_b, _ = decompose(figs)
        row = rows.get(metric)
        if row is None:
            bad(f"{metric}: no row in team_style_reliability")
            continue
        print(f"{metric:12}{rel:10.3f}{float(row['reliability']):11.3f}"
              f"{rel6:9.3f}{float(row['reliability_6']):10.3f}"
              f"{sd_b:9.4f}{float(row['sd_between']):10.4f}")
        # 1e-3 is the rounding the view applies, not a fudge factor.
        if not close(rel, row["reliability"], 1e-3):
            bad(f"{metric}: reliability {rel:.4f} vs view {row['reliability']}")
        elif not close(rel6, row["reliability_6"], 1e-3):
            bad(f"{metric}: reliability_6 {rel6:.4f} vs view {row['reliability_6']}")
        elif not close(sd_b, row["sd_between"], 1e-4):
            bad(f"{metric}: sd_between {sd_b:.5f} vs view {row['sd_between']}")
        else:
            ok(f"{metric}: reliability {rel:.3f} reproduced, rank_earned={row['rank_earned']}")

    # The gate is the point of the number, so assert the consequence too.
    for metric, row in rows.items():
        expect = float(row["reliability"]) >= 0.60
        if bool(row["rank_earned"]) != expect:
            bad(f"{metric}: rank_earned={row['rank_earned']} at reliability {row['reliability']}")
    ok("rank_earned follows the 0.60 gate on every metric")


def check_delta_method(conn, clubs) -> None:
    hdr("2. Delta method for the ratio — checked against a within-club bootstrap")
    print("Dead-ball share is sum(dead ball)/sum(non-penalty xG). The bootstrap needs no")
    print("algebra to be right, so it is the reference for the algebra the view uses.\n")
    rng = random.Random(BOOT_SEED)
    figs = club_figures(clubs, "dead_share")
    # Seeded at the ideal ratio, not at zero. Starting from 0.0 means the initial |0 - 1| = 1
    # beats every real deviation, so nothing ever updates and the check fails on its own
    # initial value while reporting `team None`.
    worst = 1.0
    worst_code = None
    for code, rows in clubs.items():
        if code not in figs:
            continue
        pairs = [(r["dead_xg"], r["np_xg_shots"]) for r in rows
                 if r["dead_xg"] is not None and r["np_xg_shots"] is not None]
        n = len(pairs)
        draws = []
        for _ in range(BOOTSTRAPS):
            s = [pairs[rng.randrange(n)] for _ in range(n)]
            den = sum(b for _, b in s)
            if den:
                draws.append(sum(a for a, _ in s) / den)
        se_boot = statistics.stdev(draws)
        se_delta = figs[code][1]
        ratio = se_delta / se_boot if se_boot else 0.0
        if abs(ratio - 1) > abs(worst - 1):
            worst, worst_code = ratio, code
    # 10% is loose enough for bootstrap noise at 4 000 draws and tight enough that dropping
    # the covariance term (which inflates the error by up to 60%) fails immediately.
    if abs(worst - 1) > 0.10:
        bad(f"delta/bootstrap SE ratio {worst:.3f} on team {worst_code} — outside 10%")
    else:
        ok(f"delta method within 10% of the bootstrap on all clubs (worst {worst:.3f})")

    # And the SE the view stores must be the SE computed here.
    stored = {r["team_code"]: float(r["std_error"]) for r in conn.execute(
        "select team_code, std_error from team_style_metric where metric = 'dead_share'"
    ).fetchall()}
    mismatch = [c for c in figs if not close(figs[c][1], stored.get(c), 1e-4)]
    if mismatch:
        bad(f"team_style_metric.std_error differs for {len(mismatch)} clubs on dead_share")
    else:
        ok("team_style_metric.std_error matches the recomputed delta-method SE")


# ---------------------------------------------------------------------------
# 3. The permutation test — the reference for the trend filter
# ---------------------------------------------------------------------------
def permutation_survivors(clubs, windows=(4, 6, 8, 10), alpha=0.05, min_windows=2):
    """Club-metric pairs where a window differs from the season at 2+ window lengths.

    The distribution of "a random window of this club's own season" IS the null. Nothing is
    assumed about normality, which is exactly why this and not a t-test is the reference.
    """
    rng = random.Random(PERM_SEED)
    survivors: dict[tuple[int, str], int] = {}
    for code, rows in clubs.items():
        for metric in MEANS:
            v = [r[metric] for r in rows if r[metric] is not None]
            if len(v) < 20:
                continue
            season_mean = statistics.fmean(v)
            hits = 0
            for n in windows:
                if n >= len(v):
                    continue
                actual = abs(statistics.fmean(v[-n:]) - season_mean)
                pool = list(v)
                extreme = 0
                for _ in range(PERMUTATIONS):
                    rng.shuffle(pool)
                    if abs(statistics.fmean(pool[:n]) - season_mean) >= actual - 1e-12:
                        extreme += 1
                if (extreme + 1) / (PERMUTATIONS + 1) < alpha:
                    hits += 1
            if hits >= min_windows:
                survivors[(code, metric)] = hits
    return survivors


def check_permutation(conn, clubs) -> None:
    hdr("4. Permutation test — does team_trend's cheap z-score agree with the reference?")
    print(f"{PERMUTATIONS:,} shuffles per club-metric-window. This is the slow one.\n")
    # `ordered` in the view is by kickoff DESC and takes the most recent N; the series here is
    # ascending, so the last N is the same set of matches.
    survivors = permutation_survivors(clubs)
    shipped = {(r["team_code"], r["metric"]) for r in conn.execute(
        "select team_code, metric from team_trend").fetchall()}
    perm = set(survivors)

    only_perm = perm - shipped
    only_view = shipped - perm
    names = {r["code"]: r["short_name"] for r in conn.execute(
        "select code, short_name from teams").fetchall()}
    print(f"permutation test: {len(perm)} pairs    team_trend: {len(shipped)} pairs")
    for code, metric in sorted(only_perm, key=lambda p: (names.get(p[0], ""), p[1])):
        print(f"  only the permutation test: {names.get(code, code):5} {metric}")
    for code, metric in sorted(only_view, key=lambda p: (names.get(p[0], ""), p[1])):
        print(f"  only team_trend:           {names.get(code, code):5} {metric}")

    # The calibration measured one false positive and one false negative out of 408 cases, so
    # a couple of pairs may legitimately differ. More than that means the z-score has stopped
    # standing in for the permutation test and the threshold needs refitting.
    disagreements = len(only_perm) + len(only_view)
    if disagreements > 2:
        bad(f"z-score and permutation test disagree on {disagreements} pairs (tolerance 2)")
    else:
        ok(f"z-score agrees with the permutation test ({disagreements} pair(s) differ, <= 2)")

    agreed = len(perm & shipped)
    if agreed == 0 and perm:
        bad("no overlap at all between the two — the filter is not measuring what it claims")
    else:
        ok(f"{agreed} pairs found by both")


# ---------------------------------------------------------------------------
# 4. The two gates
# ---------------------------------------------------------------------------
def check_gates(conn, clubs) -> None:
    hdr("3. The two gates — ordering by reliability, naming by the club's own error bar")
    rows = conn.execute("""
        select m.team_code, m.metric, m.value, m.std_error, m.league_mean, m.separation_z,
               m.separated, m.rank_earned, m.metric_rank
        from team_style_metric m""").fetchall()
    by_metric: dict[str, list[dict]] = {}
    for r in rows:
        by_metric.setdefault(r["metric"], []).append(r)

    bad_z = 0
    for metric, rs in by_metric.items():
        figs = club_figures(clubs, metric)
        league = statistics.fmean([v for v, _, _ in figs.values()])
        for r in rs:
            value, se, _ = figs[r["team_code"]]
            z = (value - league) / se if se else 0.0
            if not close(z, r["separation_z"], 0.02):
                bad_z += 1
            if bool(r["separated"]) != (abs(z) >= 2 - 1e-9):
                bad(f"{metric}/{r['team_code']}: separated={r['separated']} at z={z:.3f}")
    if bad_z:
        bad(f"separation_z differs from the recomputed value on {bad_z} rows")
    else:
        ok(f"separation_z reproduced on all {len(rows)} club-metric rows")

    unearned_ranked = [r for r in rows if not r["rank_earned"] and r["metric_rank"] is not None]
    if unearned_ranked:
        bad(f"{len(unearned_ranked)} rows carry a rank the reliability does not support")
    else:
        ok("no rank is rendered on a metric below the 0.60 reliability gate")

    # The gates must genuinely disagree, or gate 2 is decoration. Dead-ball share is the case
    # that motivated it: too noisy to order, yet with unambiguous outliers.
    both = {(r["metric"]) for r in rows if not r["rank_earned"] and r["separated"]}
    if not both:
        bad("no metric is unranked yet has separated clubs — gate 2 is doing nothing")
    else:
        ok(f"gates disagree where they should: {', '.join(sorted(both))} unranked but named")

    # Every claim on screen must trace to a separated row.
    claims = conn.execute("select count(*) as n from team_style_claim").fetchone()["n"]
    separated = sum(1 for r in rows if r["separated"])
    if claims != separated:
        bad(f"{claims} claims against {separated} separated rows")
    else:
        ok(f"{claims} claims, one per separated club-metric row")


def main() -> int:
    with connect() as conn:
        clubs = load(conn)
        matches = sum(len(v) for v in clubs.values())
        print(f"{matches} club-matches over {len(clubs)} clubs")
        if matches < 100:
            print("Too little data to prove anything. Run `python -m sync.cli enrich` first.")
            return 2
        check_reliability(conn, clubs)
        check_delta_method(conn, clubs)
        check_gates(conn, clubs)
        check_permutation(conn, clubs)

    print(f"\n{'=' * 78}")
    print(f"{len(failed)} FAILED" + (f": {'; '.join(failed)}" if failed else ""))
    print("=" * 78)
    return len(failed)


if __name__ == "__main__":
    sys.exit(main())
