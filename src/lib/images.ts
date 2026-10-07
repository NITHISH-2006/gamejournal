/**
 * Image URL safety.
 *
 * `next.config.ts` allow-lists remote image hosts. When `next/image` is handed
 * a `src` that does not match one of those patterns it throws at *render* time,
 * not at request time — so a single poisoned `games.cover_url` row permanently
 * 500s every page that renders that game, for every visitor, with no way for a
 * user to recover.
 *
 * The row could get there because `ensureGameCached` originally upserted
 * metadata straight from a client-supplied payload whose only check was
 * `startsWith('https://')`. Any logged-in user could therefore point a game's
 * cover at an arbitrary host with one Server Action call.
 *
 * Defence in depth, applied at both ends:
 *   - write side (`safeCoverUrl` in validation) — never store an untrusted URL
 *   - render side (`isAllowedImageUrl` in GameCover) — never render one, even
 *     if a row predates the write-side fix
 *
 * The render-side check is the one that actually guarantees no page can 500,
 * because it also covers rows that are already in the database.
 */

/**
 * Permitted sources.
 *
 * These mirror `images.remotePatterns` in `next.config.ts` — **hostname *and*
 * pathname**, not just the hostname. That is the fix for a hole in the previous
 * version of this file: it checked only `hostname`, so
 * `https://images.igdb.com/anything` passed `safeCoverUrl` and passed the
 * render-side gate, and was then handed to `next/image`, which threw because
 * the configured pattern is `/igdb/image/upload/**`. The mitigation was
 * therefore incomplete at both ends, and the exact site-wide 500 it exists to
 * prevent remained reachable.
 *
 * A URL that no longer matches renders as the "no cover art" placeholder, which
 * is a graceful degradation rather than a crash.
 */

/** IGDB: fixed host, images only under the documented upload path. */
const IGDB_HOST = /^images\.igdb\.com$/i;
const IGDB_PATH = /^\/igdb\/image\/upload\//i;

/**
 * Supabase project storage: dynamic host (`<ref>.supabase.co`), and only the
 * public-object path. Checking the path matters — the project's REST and auth
 * endpoints are on the same host, and an attacker-controlled value pointing at
 * `/rest/v1/...` would otherwise be passed to next/image.
 */
const SUPAABASE_STORAGE_HOST = /^[a-z0-9-]+\.supabase\.co$/i;
const SUPAABASE_STORAGE_PATH = /^\/storage\/v1\/object\/public\//i;

export function isAllowedImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  // Reject anything that is not a plain https origin with no embedded
  // credentials, which also rules out `javascript:` and `data:`.
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.port) return false;

  const { hostname, pathname } = url;

  if (IGDB_HOST.test(hostname)) return IGDB_PATH.test(pathname);
  if (SUPAABASE_STORAGE_HOST.test(hostname)) {
    return SUPAABASE_STORAGE_PATH.test(pathname);
  }
  return false;
}

/**
 * Returns the URL if it is on the allow-list, otherwise null.
 * Use this on the write path.
 */
export function safeCoverUrl(value: unknown): string | null {
  return isAllowedImageUrl(value) ? value.slice(0, 500) : null;
}
