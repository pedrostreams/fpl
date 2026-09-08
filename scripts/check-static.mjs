#!/usr/bin/env node
/**
 * Asserts that the deployable output is entirely files.
 *
 * This is the load-bearing invariant of the Cloudflare deployment, and it is not a performance
 * preference. The Workers free plan allows 10ms of CPU per invocation; rendering /players was
 * measured at 300ms and a player profile at 45ms. Going over does not serve a slow page, it
 * serves nothing — Error 1102, CPU limit exceeded. So every page is exported to out/ and served
 * by Cloudflare's asset layer, which never invokes the Worker and is not metered at all.
 *
 * `output: 'export'` already fails the build on a page that needs a request, so this is the
 * second line rather than the first. What it catches is the quieter kind of breakage: a page
 * that stopped being generated (a `generateStaticParams` that silently returned fewer codes, a
 * route deleted by accident), and the two Cloudflare control files going missing, which would
 * turn every /gems and /scout link into a 404 and drop the caching rules without any error.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'out'

if (!existsSync(OUT)) {
  console.error(`\n✗ ${OUT}/ does not exist. Did \`next build\` run?\n`)
  process.exit(1)
}

const appPaths = JSON.parse(readFileSync('.next/app-path-routes-manifest.json', 'utf8'))
const problems = []

/** Where the export puts a given route's HTML. `/` is out/index.html, `/gw` is out/gw.html. */
const htmlFor = (route) => (route === '/' ? join(OUT, 'index.html') : join(OUT, `${route}.html`))

let pageRoutes = 0
for (const [appPath, route] of Object.entries(appPaths)) {
  if (!appPath.endsWith('/page')) continue
  // Internal routes Next generates for error states; they are not pages anyone navigates to.
  if (route.startsWith('/_')) continue
  pageRoutes += 1

  if (route.includes('[')) {
    // A dynamic route: assert generateStaticParams actually produced files, since returning an
    // empty array is not an error to Next and would leave every profile a 404.
    const dir = join(OUT, route.slice(1).split('/')[0])
    const built = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.html')).length : 0
    if (built === 0) problems.push(`${route} generated no pages — check generateStaticParams`)
    continue
  }

  if (!existsSync(htmlFor(route))) problems.push(`${route} was not exported to ${htmlFor(route)}`)
}

// Both are copied from public/ and both fail silently if lost: the redirects would 404 and the
// caching rules would simply not apply.
for (const control of ['_redirects', '_headers']) {
  if (!existsSync(join(OUT, control))) problems.push(`${control} is missing from ${OUT}/`)
}

if (problems.length) {
  console.error(`\n✗ ${problems.length} problem(s) with the export:\n`)
  for (const p of problems) console.error(`  · ${p}`)
  console.error('')
  process.exit(1)
}

// Inventory, for the build log: how many files ship, and the largest page.
let files = 0
let bytes = 0
let biggest = { path: null, bytes: 0 }
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path)
      continue
    }
    const { size } = statSync(path)
    bytes += size
    if (entry.name.endsWith('.html')) {
      files += 1
      if (size > biggest.bytes) biggest = { path, bytes: size }
    }
  }
}
walk(OUT)

console.log(
  `✓ ${pageRoutes} page routes, ${files} HTML files, ${(bytes / 1024 / 1024).toFixed(1)} MB total. ` +
    `Nothing renders per request. Largest: ${biggest.path} at ${(biggest.bytes / 1024).toFixed(0)} KB.`,
)
