import type { Metadata } from 'next'
import Link from 'next/link'
import { Logo } from '@/components/logo'
import './globals.css'

export const metadata: Metadata = {
  title: 'FPL Scout',
  description: 'Data-driven Fantasy Premier League analysis built on free sources.',
}

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/players', label: 'Players' },
  { href: '/gems', label: 'Hidden gems' },
  { href: '/teams', label: 'Teams' },
  { href: '/prices', label: 'Prices' },
] as const

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
          </div>
        </header>
        <main className="mx-auto max-w-[1800px] px-4 py-6">{children}</main>
      </body>
    </html>
  )
}
