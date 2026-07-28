/**
 * Let a probe script import the app's TypeScript modules directly.
 *
 * Node 22+ strips type annotations on its own, but it will not invent a file extension:
 * `lib/rank.ts` imports `'./columns'`, which is normal TypeScript and not a valid ESM
 * specifier. Rather than rewrite app imports to suit a test harness, resolve the extension
 * here.
 *
 * Used as `node --import ./scripts/probe/_ts_resolve.mjs <script>`, and also maps the `@/`
 * alias from tsconfig so a probe can import anything the app can.
 */

import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..')

registerHooks({
  resolve(specifier, context, next) {
    // `@/lib/x` -> <root>/lib/x, the same alias tsconfig gives the app.
    if (specifier.startsWith('@/')) {
      specifier = pathToFileURL(resolvePath(ROOT, specifier.slice(2))).href
    }

    if (specifier.startsWith('.') || specifier.startsWith('file:')) {
      const base = specifier.startsWith('file:')
        ? fileURLToPath(specifier)
        : resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)
      // Only fill in an extension when there is genuinely no file there; never shadow a real
      // .js sitting next to a .ts.
      if (!existsSync(base)) {
        for (const ext of ['.ts', '.tsx', '.mjs', '.js', '/index.ts']) {
          if (existsSync(base + ext)) {
            return next(pathToFileURL(base + ext).href, context)
          }
        }
      }
    }

    return next(specifier, context)
  },
})
