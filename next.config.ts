import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // `pg` is a server-only dependency with native-ish internals; keeping it external stops
  // the bundler trying to trace it into the client graph.
  serverExternalPackages: ['pg'],
  typedRoutes: true,
}

export default nextConfig
