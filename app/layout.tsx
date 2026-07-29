import type { Metadata } from 'next'
import Link from 'next/link'
import { Logo } from '@/components/logo'
import { Search } from '@/components/search'
import { ThemeToggle } from '@/components/theme-toggle'
import { TooltipHost } from '@/components/tooltip-host'
import { getSearchIndex } from '@/lib/queries'
import { THEME_SCRIPT } from '@/lib/theme'
import './globals.css'

export const metadata: Metadata = {
  title: 'FPL Scout',
  description: 'Data-driven Fantasy Premier League analysis built on free sources.',
}

const NAV = [
  { href: '/', label: 'Dashboard' },
  // Second, deliberately. It is the page that answers the week in order, and the one to open on a
  // Friday — the dashboard is the state of the data, this is the decision.
  { href: '/gw', label: 'Gameweek' },
  { href: '/players', label: 'Players' },
  { href: '/gems', label: 'Hidden gems' },
  { href: '/teams', label: 'Teams' },
  { href: '/prices', label: 'Prices' },
] as const

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Fetched in the layout so search works from every page with no per-keystroke round trip.
  // 578 rows; the cost is one cheap query per render, shared by every route.
  const searchIndex = await getSearchIndex()

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
              <Search index={searchIndex} />
              {/* Rightmost, after search: a setting you touch once, not a tool you reach for
                  every session. */}
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-[1800px] px-4 py-6">{children}</main>
        {/* One tooltip for the whole app, driven by delegated events. Mounted here so a
            trigger anywhere costs a data attribute and no client boundary — including inside
            server components, which cannot hold state of their own. */}
        <TooltipHost />
      </body>
    </html>
  )
}
