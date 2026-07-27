'use server'

import { revalidatePath } from 'next/cache'
import { COLUMNS_BY_KEY } from './columns'
import { query } from './db'

/**
 * The app's only write path.
 *
 * Everything else in this project is read-only over SQL views, with Postgres written solely by
 * the Python sync. The watchlist is the exception, and it is deliberately ungated: the app is
 * public on Vercel with no auth, so anyone with the URL can edit it. That was a considered
 * choice — one user, an obscure URL, and near-zero stakes if a stranger hearts a midfielder —
 * not an oversight. If it ever matters, the fix is a signed cookie checked here, in one place.
 *
 * What is NOT skipped despite being ungated: the player code is validated against `players`
 * before insert. The foreign key would reject a bad code anyway, but a clean early return
 * beats surfacing a constraint violation to the UI, and it keeps a malformed request from
 * reaching the database at all.
 */

function parseCode(raw: unknown): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

export async function toggleWatchlist(playerCode: number): Promise<{ watched: boolean }> {
  const code = parseCode(playerCode)
  if (code === null) return { watched: false }

  const known = await query<{ code: number }>('select code from players where code = $1', [code])
  if (!known.length) return { watched: false }

  // Delete-then-insert rather than a read followed by a branch: one round trip decides it, and
  // two rapid clicks cannot both read "absent" and both insert.
  const removed = await query<{ player_code: number }>(
    'delete from watchlist where player_code = $1 returning player_code',
    [code],
  )
  if (!removed.length) {
    await query(
      'insert into watchlist (player_code) values ($1) on conflict do nothing',
      [code],
    )
  }

  // The watchlist appears on the dashboard and the scout screen, and both are cached for five
  // minutes. Without this a heart would look like it did nothing until the cache expired.
  revalidatePath('/')
  revalidatePath('/scout')
  revalidatePath('/gems')

  return { watched: !removed.length }
}

// ---------------------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------------------
// A "view" here is the user's saved configuration — a column set plus filters — not a
// Postgres view. Presets ship in lib/columns.ts; this is only for the ones composed in the
// app. Same ungated posture as the watchlist above, and the same one-line fix if it changes.

/** Column keys are validated against the catalogue, so a saved view cannot reference nothing. */
export async function saveView(input: {
  id?: number
  name: string
  columns: string[]
  filters: Record<string, unknown>
  sortKey: string | null
  sortDesc: boolean
}): Promise<{ ok: boolean; error?: string; id?: number }> {
  const name = input.name.trim().slice(0, 60)
  if (!name) return { ok: false, error: 'Give the view a name.' }

  const valid = input.columns.filter((k) => COLUMNS_BY_KEY.has(k))
  if (!valid.length) return { ok: false, error: 'Pick at least one column.' }

  const sortKey = input.sortKey && COLUMNS_BY_KEY.has(input.sortKey) ? input.sortKey : null

  try {
    if (input.id) {
      const rows = await query<{ id: number }>(
        `update saved_views
            set name = $2, columns = $3, filters = $4, sort_key = $5, sort_desc = $6,
                updated_at = now()
          where id = $1 returning id`,
        [input.id, name, valid, JSON.stringify(input.filters), sortKey, input.sortDesc],
      )
      if (!rows.length) return { ok: false, error: 'That view no longer exists.' }
      revalidatePath('/players')
      return { ok: true, id: rows[0].id }
    }
    const rows = await query<{ id: number }>(
      `insert into saved_views (name, columns, filters, sort_key, sort_desc)
       values ($1, $2, $3, $4, $5) returning id`,
      [name, valid, JSON.stringify(input.filters), sortKey, input.sortDesc],
    )
    revalidatePath('/players')
    return { ok: true, id: rows[0].id }
  } catch (e) {
    // The unique index on lower(trim(name)) is the likely cause, and "pick another name" is
    // more use than a Postgres error string.
    const msg = e instanceof Error && /saved_views_name_key/.test(e.message)
      ? `You already have a view called "${name}".`
      : 'Could not save that view.'
    return { ok: false, error: msg }
  }
}

export async function deleteView(id: number): Promise<void> {
  if (!Number.isInteger(id) || id <= 0) return
  await query('delete from saved_views where id = $1', [id])
  revalidatePath('/players')
}

export async function setWatchlistNote(playerCode: number, note: string): Promise<void> {
  const code = parseCode(playerCode)
  if (code === null) return
  const trimmed = note.trim().slice(0, 280)
  await query('update watchlist set note = nullif($2, \'\') where player_code = $1', [
    code,
    trimmed,
  ])
  revalidatePath('/')
}
