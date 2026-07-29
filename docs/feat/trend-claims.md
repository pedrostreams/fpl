# Trend claims — "target Brentford now, because…"

**Status:** designed, measured, not yet built. Scope agreed 2026-07-28: the engine plus club-level
claims, strict threshold.

`docs/LATER.md` item 2, in Peder's words:

> More "analysis explanation". You should target Brentford now because their current trend is that
> they are not conceding shots. They have started season well etc.

The app currently states facts and ranks them. It does not say *why now*. This is the layer that
does — and the measurements below changed what that layer is allowed to be.

---

## 1. The measurement that shaped the design

Prose carries far more authority than a shaded cell. "They have stopped conceding" reads as a
conclusion; `1.42` reads as a number the reader can weigh. So before writing any of it: **is a
rolling window signal at all?**

**Method.** Per club, per metric, per window length: shuffle that club's own 38 matches 20 000–
40 000 times and take the mean of a random N. That distribution *is* what "no trend" looks like
for this club and this metric. Two-sided p is how often a random window is at least as far from
the season mean as the actual last N.

**Result.** 4 metrics × 17 clubs × 4 windows = 272 tests. **23 reached p < 0.05 — 8.5%.** At
α = 0.05, pure noise produces 5.0% by construction.

That is close to nothing. A naive implementation — one trend sentence per club — would be a
confident random-number generator.

### What survives

Requiring the effect to hold at **two or more window lengths** is a cheap robustness rule with a
real mechanism behind it: adjacent windows share most of their matches, so a genuine effect
persists across N while a fluke rarely does. Under that rule, **8 of 102 club-metric pairs**
survive (6 metrics × 17 clubs, 40 000 permutations each):

| Club | Metric | Season | Last 6 | z (N=6) | Opponent Elo gap | Reading |
|---|---|---|---|---|---|---|
| **BHA** | deep completions created | 7.11 | 10.00 | +2.59 | −21 | 4 of 4 windows — strongest in the set |
| **MCI** | deep completions created | 10.76 | 14.83 | +2.63 | +10 | 3 of 4 |
| **MCI** | shots taken | 15.61 | 19.67 | +2.17 | +10 | 3 of 4 |
| **TOT** | deep completions conceded | 6.76 | 2.83 | −2.25 | −8 | 3 of 4, normal opposition |
| **CRY** | deep completions conceded | 6.11 | 9.17 | +2.70 | **+62** | Collapse, against harder opposition |
| **CRY** | expected goals conceded | 1.58 | 2.21 | +2.02 | **+62** | Same |
| **MUN** | deep completions conceded | 7.00 | 9.50 | +1.98 | −12 | 2 of 4 |
| **MUN** | shots conceded | 11.63 | 14.17 | +1.66 | −12 | 2 of 4 at other N |
| CHE | expected goals for | 1.90 | 1.06 | −2.17 | −12 | 2 of 4 |

**Nine clubs of seventeen have no defensible trend on any of six metrics.** That is the feature's
most important output. A screen that says nothing about Everton is worth more than one that
invents something.

### The confound: was the run just easier?

A club whose last six were against the bottom six will look like it stopped conceding.
`club_elo` is a **dated** series, so opponent strength on the day is available as a control. It
matters in both directions:

- **CRY** conceded far more against opposition **62 Elo stronger** than their season average. The
  control *strengthens* the claim rather than explaining it away.
- **TOT** improved against opposition 8 Elo weaker — i.e. normal. Their collapse in deep
  completions conceded (6.8 → 2.8) is not a fixture artefact.

Any claim that survives on an easier-than-usual run must be discounted, and the threshold is
±40 Elo — the league spans roughly 500 points, so 40 is a real difference rather than rounding.

### Peder's own example, checked

Brentford ended 2025/26 conceding **more**, not less:

| | Season | Last 6 |
|---|---|---|
| Shots conceded | 13.2 | **16.7** |
| Expected goals conceded | 1.56 | **2.10** |
| Deep completions conceded | 7.3 | **10.0** |

…against opposition 25 Elo *stronger*. The example was illustrative rather than a claim about
Brentford, but it is the argument for the feature: a plausible hunch, inverted by the data.

---

## 2. Calibration — the statistic that ships

The permutation test is the reference and cannot live in a view. So a cheap statistic was fitted
to it:

```
fpc = sqrt((N - n) / (N - 1))          -- sampling n of N matches WITHOUT replacement
se  = stddev(season) / sqrt(n) * fpc
z   = (window_mean - season_mean) / se
```

The finite-population correction is not optional — without it the standard error is overstated
and every z comes out too small.

**Fitted threshold: |z| ≥ 1.95, which agrees with the permutation test on 406 of 408 cases** (one
false positive, one false negative). Under the 2+ window rule the two approaches select 8 and 9
pairs respectively, sharing 8.

1.95 is essentially the normal critical value — but it was **measured, not assumed**. The mean of
four matches is not normally distributed, and the correction and the non-normality happen to
roughly cancel. Assuming 1.96 would have been right by luck.

---

## 3. What the data supports, and the preseason boundary

**The wording of the ask cannot be built today.** "Their *current* trend" and "they have *started
the season* well" are both about the season in progress, which does not exist until 2026-08-21.
Everything above is the **end of last season** and must say so.

| Source | Grain | Covers | Usable for |
|---|---|---|---|
| `understat_team_match` | per match, `kickoff` | 17 clubs × 38, 2025-08-15 → 2026-05-24 | Club windows. 114 rows have a null `team_code` — the three promoted clubs have no season at all |
| `understat_shots` | per shot, `game_id` | 2025/26 | Shots for and conceded per match, via the match row for the opponent |
| `club_elo` | **dated series, live now** | **all 20 clubs incl. promoted** | Opponent-strength control; a genuine *current* direction |
| `core_insights_player_match` | per player per match, `event` | 9 991 rows, 403 players, 38 GWs, 0 unmapped, 40-field `stats` jsonb | Player-level windows — **out of scope here**, see §7 |
| `player_gw_stats`, `fixtures.finished` | — | empty until GW1 | The in-season version |
| `player_snapshots` | hourly, ours | from 2026-07-26 | Ownership and price momentum |

`club_elo` deserves a note: `valid_from` runs to **2026-08-31**, 33 days into the future, because
ClubElo dates forward to the next fixture. Every read must be `valid_from <= <date>` ordered
descending — which `elo_now` (migration 0016) already does.

---

## 4. Design

Four views, one migration. All classification in SQL where `verify` can assert on it; only
sentence assembly in TypeScript.

```
team_match_form   per club per match: the six metrics + opponent Elo on the day
      ↓
team_trend        club × metric × window(4,6,8,10): means, stddev, z, opponent gap
      ↓
team_claim        club × metric: survives 2+ windows → direction, strength, basis
      ↓
trend_check       assertions for `python -m sync.cli verify`
```

**The six metrics.** Conceded: expected goals, shots, deep completions. Created: expected goals,
shots, deep completions. Deep completions earn their place twice over — they were the most
trend-bearing metric in the measurement, and there is a mechanism for that: territory is a
coaching choice that persists, whereas expected goals conceded is dominated by who you played.

**Claim fields** (`team_claim`): `team_code`, `metric`, `direction` (`improving` | `worsening`),
`windows_held`, `window`, `window_mean`, `season_mean`, `opponent_elo_gap`,
`opposition` (`easier` | `comparable` | `harder`), `basis` (`last_season` | `in_season`),
`strength` (`strong` | `discounted`).

**`strength` is `discounted`** when the direction is favourable *and* the run was easier by more
than 40 Elo. Discounted claims are not rendered — they are kept so `verify` can count them and so
the reason is inspectable.

**Threshold: strict.** |z| ≥ 1.95 at 2+ windows. Chosen over a "worth watching" tier because a
second, weaker tier puts the burden of separating them on the reader at every glance.

---

## 5. The honesty rules

Baked into the code, not this document:

1. **Never "now" about last-season data.** `basis = 'last_season'` renders as *"ended 2025/26"*.
   The word "currently" is reserved for `in_season`.
2. **Always name the window and the comparison.** "2.8 deep completions per match across the last
   6 of 2025/26, against 6.8 for the season" — never a bare "improving".
3. **Always state the opposition control** when the gap exceeds ±40 Elo, in the direction that
   argues against the claim as readily as for it.
4. **Say nothing rather than something weak.** Nine of seventeen clubs get no claim today. The
   empty state says so explicitly: *"No trend that survives a robustness check."*
5. **Promoted clubs get Elo-only claims, labelled as such.** They have no Understat season. An
   absent claim must not read as "no trend" when the truth is "no data" — DESIGN.md's three kinds
   of absent apply.
6. **The claim never contradicts the fixture layer.** Migration 0014 already ranks the *next*
   fixture; a trend is about the club, not the match. Both appear, neither is rewritten.

---

## 6. Where it renders

- **`/team/[code]`** — a Form section: the surviving claims, or the empty state.
- **`/teams`** — a marker on clubs with a live claim, so the ticker answers "who changed".
- **Dashboard, "Teams to target"** — where Peder's example lives. One sentence under the club.
- **Tooltip host** — the full workings on hover: window mean, season mean, z, windows held,
  opposition. This is why the tooltip work landed first; a claim of this shape belongs in a panel
  with rows, not in an attribute string.

---

## 7. Deliberately out of scope

- **Player-level trends.** The data supports it (§3) but the noise floor has not been measured
  there, and minute-limited samples are worse than club samples — a player with four starts in the
  window is a smaller N than any club. Revisit with the same permutation method first.
- **A "worth watching" tier.** See §4.
- **Causal language.** "Because they changed formation" is not in any table we hold.
- **Trends over more than one season.** Expected stats are zero before 2022/23 and squads turn
  over; the comparison would not mean what it appears to.

---

## 8. Verification

- `trend_check` asserts: every claim has ≥2 windows held; no claim without a season sample of ≥20
  matches; `direction` agrees with the sign of `window_mean − season_mean` **after** the metric's
  own direction is applied (conceding less is `improving`, creating less is `worsening` — the same
  trap as the heatmap's "colour means better, never bigger"); no `in_season` basis before GW1.
- A probe script re-runs the permutation test against the shipped view and fails if the two
  disagree on which pairs survive. The calibration in §2 is a measurement taken once; the probe is
  what keeps it true.
- `FIX_WHEN_LIVE.md` gains: on the first in-season run, confirm `basis` flips to `in_season`, and
  that a 6-match window early in the season is compared against **last season** rather than
  against a 6-match "season average" of itself.

---

## 9. Why this gets better in September

The noise finding is specific to "the last 6 of a *completed* season", where 6 matches is a
subsample of 38 that the season average already contains. **After GW6, "the last 6" is all the
evidence there is**, and the comparison becomes this season versus last — a different and much
stronger question. The machinery is identical; the evidence strengthens every round.
