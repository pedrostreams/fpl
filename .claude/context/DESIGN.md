# Design language

The contract for anything rendered in this app. Read it before adding a screen, and update
it in the same commit as any change to `app/globals.css`.

This is a **decision tool**, not a dashboard. The user is one person, on a laptop, deciding
a transfer before a deadline. Every rule below serves one goal: *make a number's meaning and
its trustworthiness readable at a glance*. Anything that competes with that loses.

---

## 1. Five principles

1. **A number without a reference point is decoration.** Raw `xGI/90 = 0.412` says nothing.
   The same number with a percentile behind it says "top 8% of midfielders". Every metric
   that can be ranked *is* ranked, and the rank is what carries the colour.

2. **Absent must never look like low.** A player with no data has not scored zero. 19% of the
   player pool is cold-start; if they read as "bad" the hidden-gems screen defeats itself.
   There are **three distinct kinds of absent** and each has its own glyph, because collapsing
   them loses the reason:

   | Glyph | Means | Where |
   |---|---|---|
   | `—` | No value exists | `fmt()` in [lib/format.ts](../../lib/format.ts) |
   | hatching | A value exists but is not ranked — sample too small | `.heat-null` |
   | `·` | Not observed for long enough yet | `/prices` 24h and 7d deltas |

   The third is the subtlest and the most dangerous to get wrong. A `0` in a 24-hour delta
   column says "this player is stable"; the truth may be "we have only been watching for an
   hour". The SQL enforces it — `has_24h_history` in `player_movement` — and `verify` fails the
   build if a delta ever appears without the history to support it.

3. **The screen states its own provenance.** Which season the numbers describe, whether
   the season has started, whether a sync job is stale, whether a club was promoted — all
   of it on the page, not in a doc. A silently stale data tool is worse than no tool.

4. **Explain the metric where it is used.** PPDA gets its "low means high press" sentence on
   the teams page; DEFCON gets its thresholds in a column tooltip. Never assume the reader
   remembers which direction is good.

5. **Composite scores show their workings.** `gem_score` is a mean of three percentiles, so
   the card renders all three as bars. A score you cannot decompose is a score you cannot
   argue with, and the whole point is to disagree with the friend group's consensus.

---

## 2. Tokens

Defined in [app/globals.css](../../app/globals.css). **Never hardcode a colour**, in CSS or
in a `style` prop. Every token has a dark and a light value; dark is the default.

| Token | Role |
|---|---|
| `--bg` | Page background |
| `--surface` | Cards, table body |
| `--surface-2` | Table headers, inset controls, inactive chips |
| `--border` | All borders (`* { border-color: var(--border) }`) |
| `--text` | Primary text |
| `--muted` | Secondary text, units, ranks |
| `--faint` | Labels, legends, disabled, `—` |
| `--accent` | Interaction, active sort, emphasis. **Green-teal, ~165°** |
| `--heat-lo` / `--heat-hi` | The two ends of the percentile ramp |
| `--pos-gkp` `--pos-def` `--pos-mid` `--pos-fwd` | Position identity |
| `--ok` `--warn` `--danger` | Status only — availability, staleness, sign of a difference |

Everything is **oklch**. The heatmap interpolates continuously across 0–1, and sRGB midtones
go muddy. `color-mix(in oklab, …)` is the only mixing function used; percentages in
`color-mix` are the idiom for tinting a surface with a semantic colour:

```css
background: color-mix(in oklab, var(--warn) 9%, var(--surface));
borderColor: color-mix(in oklab, var(--warn) 28%, var(--border));
```

**Dark is not the only mode.** Light overrides live in both a `prefers-color-scheme` block
and a `[data-theme='light']` block, so an explicit toggle can win over the OS. There is no
toggle in the UI yet — see §9.

### Colour budget

Accent, position and status are three separate systems and they must not blur. A rule of
thumb that has held so far: **one accent element per row, at most.** If a screen starts
looking festive, the failure is that something semantic was given a decorative colour.

---

## 3. Typography and numbers

- One font stack, system sans. No web fonts — nothing here justifies a network round-trip
  or a layout shift.
- `body` sets `font-variant-numeric: tabular-nums`. Non-negotiable: every column is scanned
  vertically and proportional digits make that impossible.
- `.num` (mono, 13px, `-0.01em`) wraps **every** number that sits in a column with others.
  Prose numbers inside a sentence do not need it.
- Sizes are explicit brackets, not Tailwind's scale, because the range in use is narrow:
  `text-xl` for a page title, `[14px]` card title, `[13px]` body and cells, `[12px]` dense
  secondary, `[11px]` labels and legends, `[10px]`/`[9px]` uppercase micro-labels and badges.
- Micro-labels are `uppercase` + `tracking-wider`/`tracking-widest` + `--faint`. That
  combination *is* the label style; do not invent a second one.

### Formatting rules

All display formatting goes through [lib/format.ts](../../lib/format.ts) so "what does a
missing value look like" is one decision. Decimal places carry meaning — 3 for per-90
expected stats (`0.412`), 2 for rates and money, 1 for percentages and counts-per-match, 0
for minutes and points. Widening a column's precision beyond its measurement error is a lie
about how much the number is known.

---

## 4. The heatmap

The one component with real rules.

```tsx
<div className="heat" style={{ ['--p' as string]: pct }}>
```

- Percentile arrives as a `--p` custom property in **0–1**, and `color-mix` does the blend in
  CSS. Nothing computes a colour in JS: switching theme swaps two variables with no re-render.
- **Colour always means better, never bigger.** On the fixed screens, `xGC/90` and `Owned` are
  inverted in SQL before they reach the component. On `/players` the user composes the columns,
  so there is no view to invert them in: `direction` in [lib/columns.ts](../../lib/columns.ts)
  carries it instead, and [lib/rank.ts](../../lib/rank.ts) reads it. **Every new catalogue entry
  must declare a direction**, and `'none'` is a real answer — price, PPDA and G−xG are shown
  unshaded because "better" is genuinely undefined for them, and colouring them would assert
  something false. Never leave the direction to the reader.
- `pct === null` → `.heat-null` hatching, value shown in `--faint`.
- Every heat cell carries a `title` naming the comparison set: *"87th percentile in
  position"*, *"in the league"*. The set matters — a defender's xGI against forwards is
  meaningless, which is why player percentiles are within position.
- `--heat-hi` stays mid-dark in dark mode so `--text` keeps contrast at the top of the ramp.
  If you change the ramp, check the darkest cell against the lightest text.
- A legend showing the 0→1 ramp plus the hatch appears wherever the heatmap does.

---

### The fixture ticker

A second established pattern, in [components/fixture-ticker.tsx](../../components/fixture-ticker.tsx):

- **A lens switches the meaning of the whole table, not a column.** Overall / Attack /
  Defence each re-colour every cell *and* swap the summary metric (xWins / xG / xCS). Adding
  three more columns per gameweek would be unreadable; the same grid re-interpreted is not.
  Reach for this whenever one dataset has several audiences.
- **`ARS` is home, `ars` is away.** The universal FPL ticker convention, and it saves a
  column. The `H`/`A` suffix stays as the unambiguous form.
- **A blank gameweek is `.heat-null` with the word "blank"** — the same "absent ≠ low" rule
  as an unranked player, and here absence is actively the worst outcome on the row, so it must
  not render as a pale easy fixture.
- **A double gameweek stacks two chips in one cell** and is called out in prose above the
  table, because it is the single most actionable thing on the screen.
- **Difficulty is inverted for colour** (`--p = 1 - difficulty`), because 0 means easiest and
  colour means better.
- **A rate and a total are different columns, never one column.** A gameweek spans Friday to
  Monday, so mid-gameweek some clubs have played it and others haven't, and their windows hold
  different numbers of fixtures. The per-fixture rate stays comparable; the sum silently
  rewards having more fixtures left. Both are shown, the fixture count `#` beside them, and a
  banner appears only while the windows actually differ. Generalise the rule: **when an
  aggregate's denominator varies between rows, put the denominator on screen.**

---

### The composed table

[components/players-view.tsx](../../components/players-view.tsx). A **view** picks columns, a
**filter** picks rows, and the user builds both.

- **The comparison set is whatever is on screen.** Ranks are computed over the *filtered* rows,
  so narrowing to forwards under £7.0 rescales the shading to those forwards. That is the
  question being asked, and the tooltip still names the set.
- **Ranked within position by default**, across the whole pool only where the metric is
  team-level or absolute (`scope: 'all'`). A centre-back's xGI against forwards is meaningless.
- **A zero must never stand in for an unknown.** `player_wide` coalesces headed xG to 0 only
  for players Understat actually observed; the 159 with no mapping stay null and hatch. The
  first draft coalesced everything and quietly told the reader that an unmapped player has no
  aerial threat. Same for the three promoted clubs' corner figures.
- **A preset that sorts by a rate must bound the sample**, or the default view leads with a
  two-minute cameo at 3.29 npxG/90.
- **Sorting nulls last needs `sortUndefined`, not a comparator.** TanStack inverts the
  comparator on a descending sort, so a comparator that pushes nulls down ascending pulls them
  to the top descending. Both directions must be checked, on every numeric column.

---

### Percentiles

A rate on its own is not information. `0.398 xGI/90` says nothing; *83rd percentile among 148
midfielders* is a scouting report. So every rate on a player profile carries its rank, and
[player_metric_percentile](../../supabase/migrations/0018_metric_percentiles.sql) is where they
come from.

- **Mid-rank, not `cume_dist`, not `percent_rank`.** Both of the obvious choices are wrong on
  ties, in opposite directions. `percent_rank` gives a tie group its first member's position —
  every full-time starter read "37th percentile" for minutes. `cume_dist` counts rows at or
  *below* — all 22 goalkeepers tied on 0.000 xG/90 read "96th percentile" for scoring.
  `(strictly worse + half of equal) / n` is honest either way. `lib/rank.ts` must match, or the
  shaded cell and the printed sentence describe the same number differently.
- **Name the pool, always.** Within position, excluding cold-start players, and the count is on
  screen. "Better than 88% of midfielders" is worthless if a third of that pool played twenty
  minutes.
- **Refuse to quote a percentile that cannot mean anything.** A pool under 12, or a metric that
  does not vary within the position — `saves` across midfielders is 148 zeros, and ranking them
  told every one of them they were first. `is_quotable` decides in SQL, so no component has to
  remember.
- **Do not rank what the position does not do.** Correct arithmetic on a meaningless metric is
  still meaningless: a goalkeeper's headed xG is honestly the median and never worth a cell.

## 5. Page skeleton

```
header (sticky, backdrop-blur, 88% bg)
main   max-w-[1800px] px-4 py-6
  └ flex flex-col gap-5
      1. title + one-sentence subtitle explaining the screen's metric choices
      2. provenance / caveat banners (preseason, promoted clubs, stale sync)
      3. controls
      4. the data
      5. legend and footnotes in [11px] --faint
```

- `max-w-[1800px]`: this is a wide-table tool and a 1280px column wastes a laptop screen.
- Radii: `rounded-xl` for containers and banners, `rounded-lg` for inputs and buttons,
  `rounded-full` for nav pills and bar tracks, `rounded` for badges.
- Gaps: `gap-5` between page sections, `gap-3`/`gap-4` inside a section, `gap-2` inline.
- **Banners are conditional, never decorative.** Each one exists because a specific piece of
  data is missing or misleading, and it disappears when the condition clears — the preseason
  banner goes when `season_started` flips. A banner that is always visible is documentation
  in the wrong place.

### Tables

`border-separate border-spacing-0` with `sticky top-0` headers on `--surface-2`; first column
`sticky left-0` when the table scrolls horizontally (mind the z-index ladder: body cell 10,
header 20, first header 30). Cells are `p-0` with padding on the inner element, so a heat
cell can fill its cell edge to edge. Headers are clickable for sort and show `▲`/`▼` at full
opacity, `▾` at 0.25 when unsorted. Wrap in `.scroll-thin`.

Sorting must put **nulls last in both directions** (`nullsLast` in
[components/scout-table.tsx](../../components/scout-table.tsx)) — TanStack's default
interleaves them and a blank row appearing "best" is a bug the user learns to ignore.

### Controls

Label above input, `Field` wraps both. 36px (`h-9`) control height throughout. Sliders show
their current value in the label (`Max price · £8.5`) because a bare thumb position is
unreadable. Active toggles use an accent tint with an accent border; active position filters
fill with the position colour and flip text to `--bg`.

Filtering is **client-side over the full row set**. `/scout` ships all 558 rows — 2.4 MB of
HTML, **109 KB compressed** (measured). Instant filtering beats a round-trip; don't
"optimise" this without measuring the compressed size.

---

## 6. Badges

Small, uppercase, meaning-dense. Established vocabulary:

| Badge | Style | Meaning |
|---|---|---|
| `P1` `F2` `C1` | accent tint, `[9px]` bold | Set-piece order — penalty, free-kick, corner |
| `new` | `--surface-2` on `--faint` | Cold start, no reliable sample |
| `promoted` | `--surface-2` on `--warn` | No prior Premier League season |
| status dot | 6px round, `--ok`/`--warn`/`--danger` | Availability; `title` carries the news text |

A badge always has a `title`. Two-to-three characters of jargon are worth it for density,
but only if hovering explains them.

---

## 7. Interaction

- **No client JS unless the interaction needs it.** Pages are server components; only
  `/scout`'s table is `'use client'`. A card grid that never sorts stays on the server.
- Hover states are `transition-colors` on background only. No transforms, no shadows.
- `revalidate = 300` per page. The sync writes hourly at most.
- No loading skeletons yet — server rendering against a pooled connection is fast enough
  that a skeleton would flash. Revisit if a query passes ~300 ms.

---

## 8. Deliberately absent

Each of these is a decision, not a gap:

- **No chart library.** Bars are divs, ramps are `color-mix`. A 200 KB charting dependency
  for eleven bars is not a trade worth making. Revisit only for a genuine time series —
  price history over a season is the first real candidate.
- **No icon set.** Text labels and 6px dots. Icons would need a legend anyway.
- **No component library.** `Field`, `Slider`, `Toggle`, `Heat`, `Bar` are ~15 lines each and
  local to where they're used. Promote to `components/` on the *second* use, not the first.
- **No animation.** Nothing here benefits from motion.
- **No auth, no user state.** All data is public; there is nothing to protect and nothing to
  persist. Filter state lives in React and dies on reload — deliberate for now, see §9.

---

## 9. Open questions for the design round

Recorded, not decided. Do not resolve these silently in a feature commit.

1. **Theme toggle.** Tokens support it, nothing exposes it. Needs a control and a
   `localStorage` read that doesn't flash on first paint.
2. **Density.** 13px rows are tight on a laptop and comfortable on a large monitor. A
   compact/comfortable switch, or pick one and commit?
3. **`/scout`'s 18 columns.** Column visibility presets ("attacking", "defensive",
   "value") versus one wide table you scroll.
4. **Shareable state.** Filters in the URL would let a mini-league argument be linked. Costs
   a `useSearchParams` and some care over history entries.
5. **Mobile.** Untested and almost certainly poor. The scout table cannot work under 600px
   without a different layout — probably cards. Is a phone even a target?
6. **The colour ramp's midpoint.** A single-hue ramp reads as "more/less". A diverging ramp
   through a neutral at the 50th percentile would read as "above/below average" — arguably
   the more useful question, and a real fork in the language.
7. **Landing page.** `app/page.tsx` currently exists only to redirect. A summary view — "what
   changed since you last looked" — is the obvious thing and the price-watch data is what
   would feed it.
8. **Visual review has not happened.** Every screen so far is verified by asserting on
   rendered HTML, never by looking at it. Treat spacing, weight and contrast as unaudited.
9. **The teams page now holds two tables.** The ticker and the style profile answer different
   questions ("who do they play" versus "how do they play") and are used together, which is why
   they share a route. If it feels crowded, splitting the ticker onto `/fixtures` is the
   obvious move — but then the two tables can no longer be read side by side.
10. **The ticker's blank and double paths are still unexercised.** No gameweek in GW1–6 has
    anything but exactly one fixture per club, because reschedules haven't happened yet. Both
    code paths are written and neither has rendered real data. The *mixed-window* path has
    been exercised, by briefly marking GW1's early fixtures finished against the live database
    and reverting — see the note in `CLAUDE.md` on how to repeat that.
