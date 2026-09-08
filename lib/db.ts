import { AsyncLocalStorage } from 'node:async_hooks'
import { Pool } from 'pg'

/**
 * Read-only Postgres access for server components.
 *
 * No Supabase JS client on purpose. There is no auth and no client-side write, so a direct
 * server-side connection is both simpler and safer: the connection string never reaches the
 * browser, and no anon key has to be paired with RLS policies that would only ever say
 * "everyone may read everything" for what is entirely public football data.
 *
 * The same `query` runs in two places that could not be less alike, which is why it goes through
 * `run` instead of straight at a pool:
 *
 *   1. Node, during `next build`. The app is a static export, so this is where all of the
 *      reading happens — every page, all 687 of them, is rendered here against DATABASE_URL. A
 *      long-lived process with a connection pool is exactly the right shape for that.
 *   2. The Cloudflare Worker, for the three /api endpoints in worker/. Those exist because the
 *      watchlist and the saved views are the only state a visitor can change, and so the only
 *      state that cannot be baked into a file. A pool is actively wrong there: a socket cannot
 *      outlive the request that opened it, and reusing one across requests fails with "Cannot
 *      perform I/O on behalf of a different request".
 *
 * The Worker therefore opens one connection per request and puts it here with `runWithClient`,
 * and everything in lib/queries.ts works unchanged in both environments.
 */

/** A result set, narrowed to what this module actually reads off it. */
type Rows = {
  rows: unknown[]
  fields: readonly { name: string; dataTypeID: number }[]
}

/** Anything that can run a parameterised query: a pooled Node client, or the Worker's. */
export type Queryable = {
  query(sql: string, params: unknown[]): Promise<Rows>
}

/**
 * The connection for the request in flight, if something upstream opened one.
 *
 * AsyncLocalStorage rather than a module-level variable, and that is not a stylistic choice: one
 * Worker isolate serves overlapping requests, so a shared variable would hand request B the
 * connection request A had already closed. ALS scopes it to the call tree instead. Available in
 * Workers under the `nodejs_compat` flag, which wrangler.jsonc sets for `pg`'s sake anyway.
 */
const requestClient = new AsyncLocalStorage<Queryable>()

/** Run `fn` with `client` as the connection every `query` inside it will use. */
export function runWithClient<T>(client: Queryable, fn: () => Promise<T>): Promise<T> {
  return requestClient.run(client, fn)
}

declare global {
  // Next's dev server re-evaluates modules on every edit. Without a global the pool would
  // leak a new set of connections per hot reload and exhaust the Supabase pooler.
  // eslint-disable-next-line no-var
  var __fplPool: Pool | undefined
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Use the Supabase session pooler host — ' +
        'db.<ref>.supabase.co does not resolve.',
    )
  }

  const isLocal = /@(localhost|127\.0\.0\.1)/.test(connectionString)

  return new Pool({
    connectionString,
    // Supabase terminates TLS at the pooler with a certificate chain Node won't verify by
    // default. The connection is still encrypted; only chain verification is relaxed.
    //
    // Node-only, and worth knowing why the Worker cannot do the same: the Workers runtime
    // ignores `rejectUnauthorized` and would reject this chain. That is one of the two reasons
    // the /api handlers go through Hyperdrive — it terminates TLS itself.
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
    // 3, and measured rather than assumed — both directions were tried.
    //
    // The old reasoning here was "the dashboard fires 11 queries concurrently and they queue on
    // these 3 connections for a few hundred milliseconds". That was true while a request
    // rendered one page. A static export renders many pages at once per worker: instrumenting a
    // build showed **18 queries in flight against 3 connections**, so everything took its queue
    // position rather than its cost — `select * from snapshot_coverage` 20s, `select * from
    // player_wide` 17.9s against 4.4s measured alone — and whichever query was last waited past
    // the deadline below and threw "timeout exceeded when trying to connect". Three builds died
    // that way.
    //
    // The obvious fix — more connections — is wrong here, and expensively so. At `max: 5` per
    // worker (10 against the pooler's 15) the build failed differently: `canceling statement due
    // to statement timeout`, 57014. This Supabase instance runs `statement_timeout = 2min`, and
    // ten concurrent readers of an 89-column view over 654 players pushed a 4.4s query past two
    // whole minutes. The database is the bottleneck, not the queue, so widening the queue just
    // moves the failure and makes every query slower on the way.
    //
    // So: keep the database working on three things at a time, and let the queue be long.
    max: 3,
    idleTimeoutMillis: 30_000,
    // This is the wait for a free connection, not a connect attempt, so patience is the correct
    // behaviour — 30s was a fatal deadline on a queue that was merely long. A build's total
    // heavy query work is ~6s per worker; four minutes is headroom over any honest case, and it
    // still fails fast on the things that deserve it, like a pooler full of someone else's
    // clients or a wrong password.
    connectionTimeoutMillis: 240_000,
  })
}

/**
 * Built on first use rather than at import.
 *
 * The Worker imports this module too — lib/queries.ts is the same file in both environments —
 * and there is no DATABASE_URL there, so constructing a pool eagerly threw before the request's
 * own client was ever consulted.
 */
let poolInstance: Pool | undefined

function nodePool(): Pool {
  poolInstance ??= globalThis.__fplPool ?? createPool()
  if (process.env.NODE_ENV !== 'production') globalThis.__fplPool = poolInstance
  return poolInstance
}

/**
 * Answers to parameterless queries, for the life of a build.
 *
 * Prerendering 687 pages in one process means the layout's search index — 578 rows, needed so
 * search works from every page — was fetched 687 times, along with the sync health beside it.
 * That is what exhausted the Supabase pooler: "timeout exceeded when trying to connect", the
 * same failure the `cpus: 2` cap in next.config.ts was already fighting, except no worker cap
 * helps when the query count scales with the number of pages.
 *
 * The rule is deliberately narrow: no parameters means the answer is the same for every page in
 * this build, so ask once. Anything parameterised — every per-club query — goes straight
 * through, which keeps this growing with the number of distinct queries rather than the number
 * of pages.
 *
 * Build only. In the Worker this would be a cache with no invalidation and an isolate's
 * lifetime, which for the watchlist is precisely wrong — hence the early return below.
 */
const buildCache = new Map<string, Promise<Rows>>()

async function run(sql: string, params: unknown[]): Promise<Rows> {
  // The Worker's connection, scoped to this request. Never cached, for the reason above.
  const client = requestClient.getStore()
  if (client) return client.query(sql, params)

  if (params.length) return nodePool().query(sql, params)

  const hit = buildCache.get(sql)
  if (hit) return hit
  // The promise, not the result: two pages rendering concurrently must share one round trip
  // rather than both missing and both querying.
  const pending = nodePool().query(sql, params)
  buildCache.set(sql, pending)
  try {
    return await pending
  } catch (e) {
    // A failed query must not be remembered as the answer for the rest of the build.
    buildCache.delete(sql)
    throw e
  }
}

/** Run a read query and return typed rows. */
export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await run(sql, params)
  return result.rows as T[]
}

/** A result column: its name, and the Postgres type OID that decides whether to parse it. */
export type Field = { name: string; dataTypeID: number }

/**
 * Rows plus the result-set's own column metadata.
 *
 * Only `getPlayerWide` needs this, and it needs both halves for real reasons: the column
 * catalogue is audited against the view's actual shape, so a column renamed in a migration is
 * reported rather than silently rendering an empty table, and the type OIDs are what identify
 * which columns arrived as `numeric` strings and have to be parsed.
 */
export async function queryWithFields<T>(
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: T[]; fields: Field[] }> {
  const result = await run(sql, params)
  return {
    rows: result.rows as T[],
    fields: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
  }
}

/**
 * Postgres `numeric` arrives as a string in node-postgres, because it can hold values
 * outside IEEE 754. Every metric in this app is a small decimal, so parsing is safe — and
 * necessary, since sorting strings would order 9 after 10.
 */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
