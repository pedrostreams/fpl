import type { Metadata, Route } from 'next'
import Link from 'next/link'
import { Logo } from '@/components/logo'
import { Search } from '@/components/search'
import { ThemeToggle } from '@/components/theme-toggle'
import { TooltipHost } from '@/components/tooltip-host'
import { UserStateProvider } from '@/components/user-state'
import { getSyncHealth } from '@/lib/queries'
import { THEME_SCRIPT } from '@/lib/theme'
import './globals.css'

export const metadata: Metadata = {
  title: 'FPL Scout',
  description: 'Data-driven Fantasy Premier League analysis built on free sources.',
}

/**
 * One page owns one question, and a panel that answers another page's question links there
 * rather than rendering a second copy of it. That rule is why `CaptainPanel` no longer appears
 * on both `/` and `/gw`: two homes for the same week is what made six routes feel like a mess.
 *
 * `/gems` is gone — it was `/players?view=differentials` with a different sort, and migration
 * 0033 moved `gem_score` into the catalogue so the preset could carry it. `/prices` stays a
 * route but leaves the nav: its movement content is in the feed and its coverage content is on
 * Status, and it becomes interesting again the day prices unfreeze.
 *
 * Ordered as a week is lived: where the season is, then my own team, then the people I am
 * playing, then the reference tables.
 */
const NAV = [
  { href: '/', label: 'Dashboard' },
  // Second, deliberately. It is the page that answers the week in order, and the one to open on a
  // Friday — the dashboard is the state of the data, this is the decision.
  { href: '/gw', label: 'Gameweek' },
  { href: '/me', label: 'My team' },
  { href: '/league', label: 'League' },
  { href: '/changed', label: 'Changed' },
  { href: '/players', label: 'Players' },
  { href: '/teams', label: 'Teams' },
] as const

// 36 hours, matching /status. Every job runs at least daily, so a day and a half is late rather
// than merely off-schedule.
const STALE_SECONDS = 36 * 60 * 60

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The search index is deliberately NOT fetched here any more. It was, and passing it to
  // <Search /> as a prop serialised all 674 rows into every page — 133KB of JSON, twice per page
  // once the RSC payload is counted, which came to 468MB of exported output for the player
  // profiles alone. It is app/search-index.json/route.ts now: one file, fetched by the people who
  // open search, cached by their browser.
  const health = await getSyncHealth()
  const stale = health.filter(
    (h) => h.ageSeconds === null || h.ageSeconds > STALE_SECONDS,
  ).length

  return (
    // suppressHydrationWarning because the script below writes `data-theme` here before React
    // hydrates. Scoped to this element only — it does not extend to children.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Blocking, inline, and in <head> deliberately. It has to stamp `data-theme` before the
            first frame, and only a synchronous script in the head can: an effect, a bundled
            module or a script at the top of <body> all run after the browser has had a chance to
            paint the default theme, and a dark page flashing to light is worse than no toggle.
            See lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">
        <header
          className="sticky top-0 z-50 border-b backdrop-blur"
          style={{ background: 'color-mix(in oklab, var(--bg) 88%, transparent)' }}
        >
          <div className="mx-auto flex h-14 max-w-[1800px] items-center gap-6 px-4">
            <Link href="/" className="flex items-center gap-2">
              <Logo />
              <span className="text-[15px] font-semibold tracking-tight">FPL Scout</span>
              <span
                className="hidden text-[11px] font-medium uppercase tracking-widest sm:inline"
                style={{ color: 'var(--faint)' }}
              >
                tanberg
              </span>
            </Link>
            <nav className="flex items-center gap-1">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-[var(--surface-2)]"
                  style={{ color: 'var(--muted)' }}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-2">
              {/* Not in the nav. Whether the data is alive is a precondition for trusting a
                  decision, not a decision — so it earns a dot and a link, and the reasons live
                  on /status. Amber whenever any job has not succeeded inside 36 hours. */}
              <Link
                href={'/status' as Route}
                className="flex items-center gap-1.5 rounded-full px-2 py-1.5 text-[12px] transition-colors hover:bg-[var(--surface-2)]"
                style={{ color: 'var(--muted)' }}
                data-tip={stale === 0 ? 'Every sync job is fresh' : `${stale} job(s) stale`}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: stale === 0 ? 'var(--ok)' : 'var(--warn)' }}
                />
                <span className="hidden sm:inline">{stale === 0 ? 'Live' : `${stale} stale`}</span>
              </Link>
              <Search />
              {/* Rightmost, after search: a setting you touch once, not a tool you reach for
                  every session. */}
              <ThemeToggle />
            </div>
          </div>
        </header>
        {/* The watchlist and the saved views are the only mutable state in the app, and the
            only thing not prerendered — every page is a static file now, so they are fetched
            in the browser instead. One provider around everything means a heart clicked in the
            players table and the same player's heart on the dashboard are the same state. */}
        <main className="mx-auto max-w-[1800px] px-4 py-6">
          <UserStateProvider>{children}</UserStateProvider>
        </main>
        {/* One tooltip for the whole app, driven by delegated events. Mounted here so a
            trigger anywhere costs a data attribute and no client boundary — including inside
            server components, which cannot hold state of their own. */}
        <TooltipHost />
      </body>
    </html>
  )
}
