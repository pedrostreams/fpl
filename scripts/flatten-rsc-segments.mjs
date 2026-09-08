#!/usr/bin/env node
/**
 * Renames the exported RSC segment payloads to the paths the client router actually asks for.
 *
 * Next 16's router prefetches a page in segments. It requests them with the segment path joined
 * by dots:
 *
 *   GET /team/1/__next.team.$d$code.__PAGE__.txt
 *
 * but `next build` with `output: 'export'` writes that same payload nested, because the name it
 * builds contains slashes and the filesystem reads those as directories:
 *
 *   out/team/1/__next.team/$d$code/__PAGE__.txt
 *
 * A server can map between the two. A static host cannot, so every prefetch 404s: measured at
 * ~30 failed requests per page view, with the router then aborting its own prefetch of the page.
 * Navigation still worked — the router falls back to fetching the whole `.txt`, which is flat and
 * does resolve — so the symptom was purely wasted requests and a console full of 404s. Worth
 * fixing because prefetching is the thing that makes clicking a nav link feel instant.
 *
 * Renaming rather than copying: the nested path is never requested, and the payloads are ~60KB
 * each across ~690 pages, so copying would add about 42MB to a 132MB deploy for nothing.
 *
 * Note the sibling files that need no help — `__next._full.txt` and `__next._tree.txt` are
 * written flat, with dots, and return 200 as-is. Only the segment payloads nest.
 *
 * If a future Next release writes these flat, this script finds nothing and says so. Check it on
 * every upgrade: it is a workaround for an implementation detail, not for documented behaviour.
 */
import { existsSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const OUT = 'out'

if (!existsSync(OUT)) {
  console.error(`✗ ${OUT}/ does not exist. Did \`next build\` run?`)
  process.exit(1)
}

/** Every directory under `out/` whose name starts with `__next.` — one per prerendered page. */
function findSegmentDirs(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name)
    if (entry.name.startsWith('__next.')) found.push(path)
    else findSegmentDirs(path, found)
  }
  return found
}

/** Files inside a segment directory, as paths relative to it. */
function filesUnder(dir, prefix = '', found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) filesUnder(join(dir, entry.name), rel, found)
    else found.push(rel)
  }
  return found
}

/** Depth-first, so a directory is removed only once everything below it is gone. */
function removeEmptyDirs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(join(dir, entry.name))
  }
  if (readdirSync(dir).length === 0) rmdirSync(dir)
}

let moved = 0
let bytes = 0
const collisions = []

for (const segmentDir of findSegmentDirs(OUT)) {
  const parent = dirname(segmentDir)
  const prefix = basename(segmentDir) // "__next.team"

  for (const rel of filesUnder(segmentDir)) {
    // "$d$code/__PAGE__.txt" -> "__next.team.$d$code.__PAGE__.txt"
    const target = join(parent, `${prefix}.${rel.split('/').join('.')}`)
    const source = join(segmentDir, rel)
    if (existsSync(target)) {
      collisions.push(target)
      continue
    }
    bytes += statSync(source).size
    renameSync(source, target)
    moved += 1
  }

  removeEmptyDirs(segmentDir)
}

if (collisions.length) {
  console.error(`\n✗ ${collisions.length} segment payload(s) already exist at their flat path:`)
  for (const c of collisions.slice(0, 5)) console.error(`  · ${c}`)
  console.error('  Next may now write these flat itself — re-read this script before keeping it.\n')
  process.exit(1)
}

console.log(
  moved === 0
    ? '· no nested RSC segment payloads found (Next may write these flat now — see the comment)'
    : `✓ flattened ${moved} RSC segment payloads (${(bytes / 1048576).toFixed(1)} MB) so prefetches resolve`,
)
