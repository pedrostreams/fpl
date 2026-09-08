import { getSearchIndex } from '@/lib/queries'

/**
 * The search index, as a file.
 *
 * It used to be fetched in the root layout and handed to <Search /> as a prop, which meant all
 * 674 rows — 133KB of JSON — were serialised into every page of the site. Twice, in fact: once
 * into the HTML and again into the RSC payload beside it. Across 685 exported pages that came to
 * 468MB of output for the player profiles alone, and about 400KB of every single page load.
 *
 * As one file it is downloaded once, by the people who actually open search, and the browser
 * caches it for the rest of the session.
 *
 * `force-static` is what lets a route handler exist at all in a static export: it runs at build
 * time and the result is written to out/search-index.json, exactly as app/icon.svg is. Nothing
 * here reads the request, so there is nothing to make it dynamic.
 */
export const dynamic = 'force-static'

export async function GET() {
  return Response.json(await getSearchIndex())
}
