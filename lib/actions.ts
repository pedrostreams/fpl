'use server'

import { revalidatePath } from 'next/cache'
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
