/**
 * Theme choice: the one piece of user state this app persists.
 *
 * The tokens in `app/globals.css` were written dark-and-light from the start, with light
 * overrides in **two** blocks — a `prefers-color-scheme` query guarded by
 * `:root:not([data-theme='dark'])`, and a plain `:root[data-theme='light']` after it. That
 * guard is what makes three states fall out of the CSS for free:
 *
 *   | `data-theme` | Result |
 *   |---|---|
 *   | `system` (or absent) | The media query decides. Dark unless the OS asks for light. |
 *   | `dark` | The guard excludes the media query, so `:root`'s dark values win. |
 *   | `light` | The `[data-theme='light']` block wins on source order. |
 *
 * So `system` is not a fourth thing bolted on — it is the absence of an override, and writing
 * the literal string rather than removing the attribute keeps one attribute to read and lets
 * the toggle style its active segment from it (see `.theme-opt` in `globals.css`).
 *
 * DESIGN.md §9.1 asked for two things: a control, and "a localStorage read that doesn't flash
 * on first paint". `THEME_SCRIPT` is the second one.
 */

export const THEME_CHOICES = ['system', 'light', 'dark'] as const

export type ThemeChoice = (typeof THEME_CHOICES)[number]

/** Namespaced because localhost:3210 is shared with the sibling projects in `../`. */
export const THEME_KEY = 'fpl-scout-theme'

/**
 * Runs **before first paint**, from `<head>` in the root layout — synchronous and inline, which
 * is the whole point. Anything deferred, bundled or effect-driven paints the default theme
 * first and then corrects it, and the correction is exactly the flash §9.1 refused to ship.
 *
 * Costs ~200 bytes of blocking script. That is the honest price of the feature: no framework
 * can read `localStorage` during server rendering, so either the client stamps the attribute
 * before the first frame or the user sees the wrong theme for one.
 *
 * `try`/`catch` because `localStorage` *throws* on access — not returns null — in Safari's
 * private mode and under some cookie-blocking settings. An unhandled throw here would abort
 * the script and leave the page permanently on the default theme.
 *
 * The fallback is `'system'`, so a first-time visitor with no stored value gets the OS
 * preference rather than an assertion about what they want.
 */
export const THEME_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});document.documentElement.dataset.theme=(t==='light'||t==='dark')?t:'system'}catch(e){document.documentElement.dataset.theme='system'}`
