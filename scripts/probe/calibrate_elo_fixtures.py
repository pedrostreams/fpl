"""Fit Elo -> match probabilities against last season's betting market.

WHY THIS EXISTS
---------------
The fixture ticker needs difficulty for the *coming* six gameweeks. The two obvious inputs
both fail:

  * `fixture_odds` is built from football-data.co.uk's `E0.csv`, which only exists for
    matches already played. Verified 2026-07-26: 380 rows, all with a final score, none in
    the future. No bookmaker prices exist for fixtures weeks out.
  * FPL's own FDR covers all 380 upcoming fixtures but has four usable values across 760
    team-fixtures (2:209, 3:342, 4:171, 5:38, no 1s), with 45% of the season in one bucket.
    It orders fixtures correctly and cannot separate them.

ClubElo covers all 20 clubs including the promoted three, and is forward-looking by nature.
So difficulty comes from Elo. But turning an Elo difference into P(win)/P(draw)/P(clean
sheet) needs constants, and inventing them would make the whole ticker unfalsifiable.

Instead we fit them against evidence we already hold: every 2025-26 match where both clubs
are in the current league, with each side's Elo *as of that match date* and the de-vigged
market probabilities for the same game. The market is the target for result probabilities —
it is the best available estimate of a match's true odds. Actual goals are the target for
the scoring rates, because no goal market exists for future fixtures either.

Output is three fitted constants plus their error, pasted into
`supabase/migrations/0007_fixture_difficulty.sql`. Re-run after a season to refit.

    python scripts/probe/calibrate_elo_fixtures.py
    python scripts/probe/calibrate_elo_fixtures.py --season 2025-26
"""

from __future__ import annotations

import argparse
import json
import math
from typing import Any

import numpy as np
from scipy import optimize, stats

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sync import config, db  # noqa: E402

# Elo's own scale: a 400-point edge means 10:1 expected score. Not a fitted parameter.
ELO_SCALE = 400.0

SAMPLE_SQL = """
with m as (
  select
    o.match_date, o.home_team_code, o.away_team_code,
    o.home_goals, o.away_goals,
    o.p_home, o.p_draw, o.p_away, o.p_over_25,
    (select e.elo from club_elo e
      where e.team_code = o.home_team_code
        and o.match_date between e.valid_from and coalesce(e.valid_to, o.match_date)
      order by e.valid_from desc limit 1) as elo_home,
    (select e.elo from club_elo e
      where e.team_code = o.away_team_code
        and o.match_date between e.valid_from and coalesce(e.valid_to, o.match_date)
      order by e.valid_from desc limit 1) as elo_away
  from match_odds o
  where o.season = %s
    and o.home_team_code is not null
    and o.away_team_code is not null
)
select * from m
where elo_home is not null and elo_away is not null
  and p_home is not null and p_draw is not null and p_away is not null
order by match_date
"""


def load(season: str) -> list[dict[str, Any]]:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(SAMPLE_SQL, (season,))
        cols = [d[0] for d in cur.description]
        return [r if isinstance(r, dict) else dict(zip(cols, r)) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Result model
# ---------------------------------------------------------------------------
# Elo gives an expected *score share* E = P(win) + 0.5*P(draw), not P(win) on its own, so a
# draw model is required to split it. P(draw) peaks when the sides are level and decays as
# the mismatch grows; a Gaussian in the Elo difference is the simplest shape with that
# behaviour and no discontinuities. Three free parameters:
#
#   hfa        home advantage, in Elo points
#   draw_max   P(draw) between perfectly matched sides
#   draw_width Elo difference at which P(draw) falls to 1/e of its peak
def result_probs(elo_h, elo_a, hfa, draw_max, draw_width):
    d = (elo_h + hfa) - elo_a
    e = 1.0 / (1.0 + np.power(10.0, -d / ELO_SCALE))
    p_draw = draw_max * np.exp(-np.square(d / draw_width))
    p_home = e - 0.5 * p_draw
    p_away = 1.0 - e - 0.5 * p_draw
    # A large enough mismatch can push the loser below zero. Clip, then renormalise so the
    # three still sum to 1 — a probability vector that doesn't is worse than a clipped one.
    p_home = np.clip(p_home, 1e-4, 1.0)
    p_away = np.clip(p_away, 1e-4, 1.0)
    total = p_home + p_draw + p_away
    return p_home / total, p_draw / total, p_away / total


def fit_result(rows: list[dict]) -> tuple[dict[str, float], dict[str, float]]:
    eh = np.array([float(r["elo_home"]) for r in rows])
    ea = np.array([float(r["elo_away"]) for r in rows])
    market = np.array([[float(r["p_home"]), float(r["p_draw"]), float(r["p_away"])] for r in rows])

    def loss(params):
        hfa, draw_max, draw_width = params
        if draw_max <= 0 or draw_width <= 1:
            return 1e6
        ph, pd, pa = result_probs(eh, ea, hfa, draw_max, draw_width)
        pred = np.stack([ph, pd, pa], axis=1)
        # Cross-entropy against the market's own distribution: penalises being confidently
        # wrong far harder than mean absolute error would.
        return float(-np.mean(np.sum(market * np.log(np.clip(pred, 1e-9, 1)), axis=1)))

    best = optimize.minimize(
        loss, x0=[65.0, 0.28, 250.0], method="Nelder-Mead",
        options={"xatol": 1e-3, "fatol": 1e-9, "maxiter": 20000},
    )
    hfa, draw_max, draw_width = (float(v) for v in best.x)
    ph, pd, pa = result_probs(eh, ea, hfa, draw_max, draw_width)
    pred = np.stack([ph, pd, pa], axis=1)

    # Cross-entropy has no absolute meaning; its floor is the market distribution's own
    # entropy, reached only by predicting the market exactly. Report the gap, not the number.
    floor = float(-np.mean(np.sum(market * np.log(np.clip(market, 1e-9, 1)), axis=1)))

    return (
        {"hfa": hfa, "draw_max": draw_max, "draw_width": draw_width},
        {
            "matches": len(rows),
            "cross_entropy": round(loss(best.x), 4),
            "cross_entropy_floor": round(floor, 4),
            "excess_over_floor": round(loss(best.x) - floor, 4),
            "mae_home": round(float(np.mean(np.abs(pred[:, 0] - market[:, 0]))), 4),
            "mae_draw": round(float(np.mean(np.abs(pred[:, 1] - market[:, 1]))), 4),
            "mae_away": round(float(np.mean(np.abs(pred[:, 2] - market[:, 2]))), 4),
            "max_abs_error": round(float(np.max(np.abs(pred - market))), 4),
            # The baseline worth beating: predicting the league's average split every time.
            "mae_home_baseline": round(float(np.mean(np.abs(market[:, 0].mean() - market[:, 0]))), 4),
            # Does it rank fixtures in the market's order? That is all the ticker needs.
            "spearman_vs_market": round(
                float(stats.spearmanr(pred[:, 0], market[:, 0]).statistic), 4),
        },
    )


# ---------------------------------------------------------------------------
# Goal model
# ---------------------------------------------------------------------------
# Fitted on actual goals rather than the market, because no over/under line exists for a
# fixture six weeks out. Poisson with a log link:
#
#   log(lambda) = base + slope * (elo_self - elo_opp)/400 + home_boost * is_home
#
# `home_boost` is deliberately a log-additive term rather than a nudge to the Elo difference,
# so `exp(home_boost)` reads directly as "home sides score this many times as often" — a
# number that can be sanity-checked against the league. Folding it into the Elo difference
# instead makes it identifiable only as a product with `slope`, and it came out as an
# alarming-looking 180 Elo points that in fact meant a perfectly ordinary 1.24x.
#
# Two sides per match, so 2N observations. P(clean sheet) then falls out as
# P(opponent scores 0) = exp(-lambda_opponent).
def goal_lambdas(elo_self, elo_opp, is_home, base, slope, home_boost):
    d = (elo_self - elo_opp) / ELO_SCALE
    return np.exp(base + slope * d + home_boost * is_home)


def fit_goals(rows: list[dict]) -> tuple[dict[str, float], dict[str, float]]:
    scored = [r for r in rows if r["home_goals"] is not None and r["away_goals"] is not None]
    elo_self = np.array(
        [float(r["elo_home"]) for r in scored] + [float(r["elo_away"]) for r in scored])
    elo_opp = np.array(
        [float(r["elo_away"]) for r in scored] + [float(r["elo_home"]) for r in scored])
    is_home = np.array([1.0] * len(scored) + [0.0] * len(scored))
    goals = np.array(
        [int(r["home_goals"]) for r in scored] + [int(r["away_goals"]) for r in scored],
        dtype=float)

    def nll(params):
        base, slope, home_boost = params
        lam = goal_lambdas(elo_self, elo_opp, is_home, base, slope, home_boost)
        lam = np.clip(lam, 1e-6, 20.0)
        return float(-np.mean(goals * np.log(lam) - lam))  # Poisson NLL, factorial dropped

    best = optimize.minimize(
        nll, x0=[math.log(1.4), 0.8, 0.2], method="Nelder-Mead",
        options={"xatol": 1e-4, "fatol": 1e-9, "maxiter": 20000},
    )
    base, slope, home_boost = (float(v) for v in best.x)
    lam = goal_lambdas(elo_self, elo_opp, is_home, base, slope, home_boost)

    # Sides are stacked [all home, all away], so index i's opponent is i±N — the same
    # permutation for both lambda and goals.
    n = len(scored)
    flip = np.concatenate([np.arange(n, 2 * n), np.arange(0, n)])

    # Side i's clean sheet is its OPPONENT failing to score, so it needs the opponent's
    # lambda. Using exp(-lam[i]) here instead scored P(side i draws a blank) against
    # "side i kept a blank" — two different teams' events, which produced a calibration
    # table that ran backwards: the lowest predicted quartile had the highest observed rate.
    p_cs = np.exp(-lam[flip])
    kept = (goals[flip] == 0).astype(float)

    # Does P(clean sheet) hold up? Predicted against observed, in quartiles of the
    # prediction. A model that ranks fixtures correctly but is badly scaled shows up here.
    order = np.argsort(p_cs)
    buckets = []
    for chunk in np.array_split(order, 4):
        buckets.append({
            "n": int(len(chunk)),
            "predicted": round(float(np.mean(p_cs[chunk])), 4),
            "observed": round(float(np.mean(kept[chunk])), 4),
        })

    return (
        {"base": base, "slope": slope, "home_boost": home_boost},
        {
            "side_observations": len(goals),
            "mean_goals_actual": round(float(goals.mean()), 4),
            "mean_goals_predicted": round(float(lam.mean()), 4),
            "implied_home_scoring_ratio": round(float(math.exp(home_boost)), 4),
            "poisson_nll": round(nll(best.x), 4),
            "clean_sheet_calibration": buckets,
            "cs_mean_predicted": round(float(p_cs.mean()), 4),
            "cs_mean_observed": round(float(kept.mean()), 4),
            # Monotone across quartiles is the property the ticker depends on; exact
            # calibration matters less than getting the order right.
            "cs_monotone": all(
                buckets[i]["observed"] <= buckets[i + 1]["observed"] for i in range(3)),
        },
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", default="2025-26")
    args = ap.parse_args()

    config.load_dotenv()
    rows = load(args.season)
    print(f"calibration sample: {len(rows)} matches from {args.season}")
    if len(rows) < 100:
        print("FAIL: too few matches to fit three parameters")
        return 1

    r_params, r_fit = fit_result(rows)
    g_params, g_fit = fit_goals(rows)

    print("\n--- result model (target: de-vigged market 1X2) ---")
    print(json.dumps(r_params, indent=2))
    print(json.dumps(r_fit, indent=2))
    print("\n--- goal model (target: actual goals) ---")
    print(json.dumps(g_params, indent=2))
    print(json.dumps(g_fit, indent=2))

    print("\n--- paste into the migration ---")
    for k, v in {**r_params, **g_params}.items():
        print(f"  {k:12s} {v:.6f}")

    checks = {
        # Home advantage should land in the range the literature reports for the modern
        # league. A wild value means the join picked up the wrong Elo rows.
        "hfa in 30-120 Elo points": 30.0 <= r_params["hfa"] <= 120.0,
        "beats constant baseline": r_fit["mae_home"] < r_fit["mae_home_baseline"],
        "ranks fixtures like the market": r_fit["spearman_vs_market"] > 0.9,
        "home scoring ratio in 1.0-1.4": 1.0 <= g_fit["implied_home_scoring_ratio"] <= 1.4,
        # The one that caught a real bug.
        "clean sheet quartiles monotone": g_fit["cs_monotone"],
    }
    print()
    for name, passed in checks.items():
        print(f"  {'PASS' if passed else 'FAIL'}  {name}")
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
