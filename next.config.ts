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
}

export default nextConfig
