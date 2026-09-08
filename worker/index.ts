import { Client } from 'pg'
import { runWithClient, type Queryable } from '../lib/db'
import { getSavedViews, getWatchlist } from '../lib/queries'
import { deleteView, parseCode, saveView, setWatchlistNote, toggleWatchlist } from '../lib/writes'

/**
 * The only code in this app that runs per request.
 *
 * Everything else is a file. `output: 'export'` in next.config.ts turns all 687 pages into
 * static HTML, and Cloudflare serves those from its asset layer without ever invoking this
 * Worker — which is what makes the site free to host: "requests to static assets are free and
 * unlimited", and the free plan's 10ms CPU ceiling cannot apply to a request that runs no code.
 *
 * What is left over is the watchlist and the saved views: the only state a visitor can change,
 * and therefore the only state that cannot be baked into a file at build time. Three endpoints,
 * and each of them is one SQL statement and a small JSON body. That shape is the reason they fit
 * the free plan comfortably — Cloudflare bills CPU, not the wait for Postgres, and waiting is
 * nearly all these do.
 *
 * These were Next server actions before the move, and route handlers briefly after it. Neither
 * survives an export, and the server action would not have survived the CPU limit anyway: an
 * action re-renders the current route to return a fresh RSC payload, and on /players that render
 * measured 300ms. Hearting a player would have returned Error 1102 instead of a heart.
 */

/** The Hyperdrive binding: a pooled, TLS-terminated route to Supabase. See wrangler.jsonc. */
interface Hyperdrive {
  connectionString: string
}

interface Env {
  HYPERDRIVE: Hyperdrive
  /** The exported site. Used only to answer paths that are neither a file nor an endpoint. */
  ASSETS: { fetch(request: Request): Promise<Response> }
}

/**
 * Declared locally rather than pulled from @cloudflare/workers-types.
 *
 * That package redefines `Request`, `Response` and friends, and this file is compiled by the
 * same tsconfig as the React app, which needs the DOM versions. One three-line type is a much
 * smaller price than two competing sets of web globals.
 */
type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Never cache any of this. It is the one part of the site that is not a build artefact,
      // and a cached watchlist is the exact bug these endpoints exist to avoid.
      'cache-control': 'no-store',
    },
  })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // Cloudflare only routes a request here when no exported file matched it, so anything that
    // is not an endpoint is a genuine miss. Handing it back to the asset layer serves the
    // exported 404 page — `not_found_handling: "404-page"` in wrangler.jsonc — rather than the
    // bare text a Worker would otherwise produce.
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)

    const client = new Client({ connectionString: env.HYPERDRIVE.connectionString })
    try {
      await client.connect()
    } catch (e) {
      // The site itself is unaffected — it is static — so this is one panel failing, not an
      // outage. 503 rather than 500: it is worth retrying.
      console.error('[api] could not connect', e)
      return json({ error: 'The database is not reachable right now.' }, 503)
    }

    // One connection for the whole request, shared by every query inside it. `pg` queues
    // statements on a single connection, so the two reads in /api/user-state run back to back
    // rather than in parallel — two round trips through Hyperdrive, which pools next to the
    // database, so this is milliseconds of waiting and no CPU at all.
    const queryable: Queryable = { query: (sql, params) => client.query(sql, params) }

    try {
      return await runWithClient(queryable, () => handle(url, request))
    } catch (e) {
      console.error('[api]', url.pathname, e)
      return json({ error: 'Something went wrong.' }, 500)
    } finally {
      // Closing is not something the response should wait on, but it must still happen: an
      // unclosed socket holds a Hyperdrive pool slot until the isolate is reclaimed.
      ctx.waitUntil(client.end())
    }
  },
}

async function handle(url: URL, request: Request): Promise<Response> {
  const route = `${request.method} ${url.pathname}`

  switch (route) {
    /**
     * Everything on the screen that is not public football data.
     *
     * One endpoint rather than two because it is one round trip for the client, and both halves
     * are small: a watchlist is tens of rows, saved views a handful. components/user-state.tsx
     * calls this on mount from every page.
     */
    case 'GET /api/user-state': {
      const [watchlist, views] = await Promise.all([getWatchlist(), getSavedViews()])
      return json({ watchlist, views })
    }

    // The heart.
    case 'POST /api/watchlist': {
      const body = (await request.json()) as { playerCode?: unknown }
      const code = parseCode(body.playerCode)
      if (code === null) return json({ error: 'A player code is required.' }, 400)
      return json(await toggleWatchlist(code))
    }

    // The note under it. No UI writes one yet; the endpoint is here because the capability
    // predates the move and dropping it silently would be a regression by omission.
    case 'PATCH /api/watchlist': {
      const body = (await request.json()) as { playerCode?: unknown; note?: unknown }
      const code = parseCode(body.playerCode)
      if (code === null) return json({ error: 'A player code is required.' }, 400)
      await setWatchlistNote(code, typeof body.note === 'string' ? body.note : '')
      return json({ ok: true })
    }

    /**
     * Saved views: the column sets composed in the column picker.
     *
     * `saveView` returns `{ ok, error }` rather than throwing, because the errors it knows about
     * — a duplicate name, an empty column set — are things to show a user, not faults. Those
     * come back as 200 with `ok: false`; a 500 from here means something genuinely broke.
     */
    case 'POST /api/views': {
      const body = (await request.json()) as {
        id?: number
        name?: string
        columns?: string[]
        filters?: Record<string, unknown>
        sortKey?: string | null
        sortDesc?: boolean
      }
      return json(
        await saveView({
          id: body.id,
          name: String(body.name ?? ''),
          columns: Array.isArray(body.columns) ? body.columns : [],
          filters: body.filters ?? {},
          sortKey: body.sortKey ?? null,
          sortDesc: Boolean(body.sortDesc),
        }),
      )
    }

    case 'DELETE /api/views': {
      const id = Number(url.searchParams.get('id'))
      if (!Number.isInteger(id) || id <= 0) return json({ error: 'A view id is required.' }, 400)
      await deleteView(id)
      return json({ ok: true })
    }

    default:
      return json({ error: 'No such endpoint.' }, 404)
  }
}
