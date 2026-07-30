import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // `pg` is a server-only dependency with native-ish internals; keeping it external stops
  // the bundler trying to trace it into the client graph.
  serverExternalPackages: ['pg'],
  typedRoutes: true,
  // Prerendering runs one worker per CPU by default, and every worker is a separate process
  // with its own `pg` pool. On this machine that was 9 workers x 4 connections = 36 against a
  // Supabase session pooler whose pool is 15, and the build died with "timeout exceeded when
  // trying to connect" on the dashboard — the page with the most concurrent queries, so the
  // first to run out. Capping the workers bounds total connections; the build is a few seconds
  // slower and it no longer depends on how many cores the machine happens to have.
  experimental: { cpus: 2 },
  // `/gems` was retired in favour of `/players?view=differentials` once migration 0033 made
  // `gem_score` a column — the page and the preset were one table with different columns and a
  // different row filter. Permanent, because the URL is dead rather than moved temporarily, and
  // a redirect rather than a deletion because the friend group has the old link.
  //
  // `redirects()` and not a `page.tsx` that calls `redirect()`: a route file would keep `/gems`
  // in the `typedRoutes` union, so a stale `<Link href="/gems">` would still compile. Removing
  // the route is what turns every one of those into a build error, which is how the four inbound
  // links were found.
  async redirects() {
    return [{ source: '/gems', destination: '/players?view=differentials', permanent: true }]
  },
}

export default nextConfig
