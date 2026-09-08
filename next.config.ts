import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  /**
   * A static export, which is the whole deployment strategy in one line.
   *
   * The app is hosted on Cloudflare Workers on the free plan, which allows 10ms of CPU per
   * invocation. Rendering /players was measured at 300ms and a player profile at 45ms, so any
   * page that renders per request does not return a slow page, it returns Error 1102. Exported
   * pages are plain files, and Cloudflare serves those from its own asset layer: "requests to
   * static assets are free and unlimited", and — the part that matters — a request matching an
   * asset never invokes the Worker at all, so no CPU ceiling applies to reading the site.
   *
   * The Cloudflare Next adapter was tried first and is the wrong tool for this constraint. It
   * writes prerendered pages into `.open-next/cache` as incremental-cache entries rather than
   * into the assets directory, so every page view goes through the Worker to read one back —
   * which puts a 3.5MB HTML page back inside a 10ms budget for no benefit, since nothing here
   * revalidates any more.
   *
   * What an export costs, and where each piece went:
   *   · route handlers — the three /api endpoints are a hand-written Worker now, in worker/.
   *     They are the only code that runs per request, and they are pure I/O, which Cloudflare
   *     does not bill as CPU.
   *   · redirects() — moved to public/_redirects, applied by Cloudflare at the edge.
   *   · ISR — gone on purpose. `revalidate = 300` polled every five minutes for data the Python
   *     sync writes a few times a day; the sync POSTs a Workers Builds deploy hook instead, and
   *     the site rebuilds when the data actually changed.
   */
  output: 'export',

  // `pg` is a server-only dependency with native-ish internals; keeping it external stops
  // the bundler trying to trace it into the client graph. Still true with an export — every
  // query in lib/queries.ts runs during the build, and the Worker imports the same modules.
  serverExternalPackages: ['pg'],
  typedRoutes: true,
  // Prerendering runs one worker per CPU by default, and every worker is a separate process
  // with its own `pg` pool. On this machine that was 9 workers x 4 connections = 36 against a
  // Supabase session pooler whose pool is 15, and the build died with "timeout exceeded when
  // trying to connect" on the dashboard — the page with the most concurrent queries, so the
  // first to run out. Capping the workers bounds total connections; the build is a few seconds
  // slower and it no longer depends on how many cores the machine happens to have.
  //
  // It matters more now that there are 687 pages rather than 13. The per-player queries were
  // batched into one-per-view for the same reason — see groupedByPlayer in lib/queries.ts.
  experimental: { cpus: 2 },

  // `redirects()` lived here and cannot: a static export has no server to answer with a 308.
  // Both entries — `/gems` and `/scout` — are in public/_redirects, which Cloudflare applies
  // before it looks for a file. The reasoning that put them there is unchanged: `/gems` became
  // `/players?view=differentials` when migration 0033 made `gem_score` a column, `/scout` became
  // the Overview preset, and both are URLs the friend group still has.
  //
  // What is lost with the route file gone: `typedRoutes` no longer turns a stale
  // `<Link href="/scout">` into a build error. Nothing links there today — checked — and a link
  // to a redirect would work anyway.
}

export default nextConfig
