import { Pool } from 'pg'

/**
 * Read-only Postgres access for server components.
 *
 * No Supabase JS client on purpose. There is no auth and no client-side write, so a direct
 * server-side connection is both simpler and safer: the connection string never reaches the
 * browser, and no anon key has to be paired with RLS policies that would only ever say
 * "everyone may read everything" for what is entirely public football data.
 */

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
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
    // The pooler is shared with the sync jobs and with every other build worker or serverless
    // instance, so stay modest. The dashboard alone fires 11 queries concurrently; they queue
    // on these 3 connections, which costs a few hundred milliseconds and is far cheaper than
    // exhausting the pooler.
    max: 3,
    idleTimeoutMillis: 30_000,
    // Generous on purpose. This is the wait for a free connection, not for a query, and under
    // contention 10s was short enough to fail a production build outright.
    connectionTimeoutMillis: 30_000,
  })
}

export const pool: Pool = globalThis.__fplPool ?? createPool()
if (process.env.NODE_ENV !== 'production') globalThis.__fplPool = pool

/** Run a read query and return typed rows. */
export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params)
  return result.rows as T[]
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
