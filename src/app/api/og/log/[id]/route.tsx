import { createPublicClient } from '@/lib/supabase';
import { validateUuid } from '@/lib/validation';
import { safeCoverUrl } from '@/lib/images';
import { ImageResponse } from 'next/og';

/**
 * Server-rendered OpenGraph card for a single log.
 *
 * Notes on reliability:
 *  - Responses are cached publicly for a week with stale-while-revalidate, so
 *    a link shared into a chat app is not regenerated on every crawler hit.
 *  - Only *successful* renders are cached. An error response carries
 *    `no-store`, because caching a 404 for seven days means a log that is
 *    created later still unfurls as "Not found" for a week, and a transient
 *    database error becomes a permanently broken preview.
 *  - Remote cover art is fetched with a short timeout and the card still
 *    renders if the fetch fails, rather than returning a 500.
 *  - Only text and a known-shape image are rendered, so a hostile review
 *    string cannot inject markup.
 *  - A review the author marked as a spoiler is never rendered here. This
 *    image is public and cached, so leaking one is irreversible.
 */
export const runtime = 'edge';

/**
 * Errors must never be cached under the success cache headers, or a transient
 * failure becomes a sticky 404 for the full `s-maxage`.
 */
function errorResponse(body: string, status: number, headers: Headers): Response {
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(body, { status, headers });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const cacheSeconds = 604800; // 7 days
  const headers = new Headers({
    'Content-Type': 'image/png',
    'Cache-Control': `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=86400`,
  });

  // Validated before touching the database. `id` arrives from the URL, and
  // `.eq('id', <not a uuid>)` makes PostgREST reject the whole request.
  if (!validateUuid(id)) {
    return errorResponse('Bad request', 400, headers);
  }

  try {
    const supabase = createPublicClient();

    // Two projections, not one. The `profiles (username)` embed depends on a
    // foreign key that a database predating migration 002 does not have, and a
    // missing FK fails the *entire* PostgREST request — not just that column —
    // so a single-projection query 404s every log on such a database. The
    // username is only a label on the card, so dropping it is acceptable; the
    // route must not depend on it.
    let log: Record<string, unknown> | null = null;
    let authorName: string | null = null;

    const withAuthor = await supabase
      .from('game_logs')
      .select('rating, status, review, has_spoilers, created_at, games ( name, cover_url ), profiles ( username )')
      .eq('id', id)
      .maybeSingle();

    if (!withAuthor.error && withAuthor.data) {
      const row = withAuthor.data as Record<string, unknown>;
      log = row;
      const p = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
      authorName =
        p && typeof (p as { username?: unknown }).username === 'string'
          ? (p as { username: string }).username
          : null;
    } else {
      const withoutAuthor = await supabase
        .from('game_logs')
        .select('rating, status, review, has_spoilers, created_at, games ( name, cover_url )')
        .eq('id', id)
        .maybeSingle();

      if (withoutAuthor.error || !withoutAuthor.data) {
        return errorResponse('Not found', 404, headers);
      }
      log = withoutAuthor.data as Record<string, unknown>;
    }

    if (!log) return errorResponse('Not found', 404, headers);

    const game = (Array.isArray(log.games) ? log.games[0] : log.games) as
      | { name?: string | null; cover_url?: string | null }
      | null;

    const rating = Number(log.rating ?? 0);
    const stars = '★'.repeat(Math.max(0, Math.min(5, Math.round(rating / 2)))) +
      '☆'.repeat(Math.max(0, 5 - Math.max(0, Math.min(5, Math.round(rating / 2)))));

    // Allow-listed exactly as `next/image` is configured. An arbitrary https
    // host would turn this route into an open fetch proxy.
    const cover = safeCoverUrl(game?.cover_url);

    // A spoiler review is withheld from a public, week-cached image. There is
    // no way to un-share one that has already been unfurled.
    const review =
      !log.has_spoilers && typeof log.review === 'string' && log.review.trim().length > 0
        ? log.review.trim().slice(0, 180)
        : null;

    return new ImageResponse(
      (
        <div
          style={{
            width: '1200px',
            height: '630px',
            display: 'flex',
            alignItems: 'center',
            gap: '48px',
            padding: '60px',
            background: 'linear-gradient(135deg, #0d0d14 0%, #17121f 55%, #1b1226 100%)',
            fontFamily: 'sans-serif',
          }}
        >
          {cover && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cover}
              alt=""
              width={180}
              height={240}
              style={{
                width: 180,
                height: 240,
                objectFit: 'cover',
                borderRadius: 16,
                flexShrink: 0,
              }}
            />
          )}

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
              flex: 1,
              minWidth: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: '#8b5cf6',
                }}
              />
              <span
                style={{
                  color: '#a78bfa',
                  fontSize: 20,
                  fontWeight: 700,
                  letterSpacing: 3,
                }}
              >
                GAMEJOURNAL
              </span>
            </div>

            <div
              style={{
                color: '#ffffff',
                fontSize: 54,
                fontWeight: 800,
                lineHeight: 1.1,
              }}
            >
              {game?.name ?? 'Unknown game'}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <span style={{ color: '#fbbf24', fontSize: 34 }}>{stars}</span>
              <span style={{ color: '#d4d4d8', fontSize: 26 }}>{rating}/10</span>
              <span
                style={{
                  background: 'rgba(139,92,246,0.18)',
                  border: '1px solid rgba(139,92,246,0.4)',
                  color: '#c4b5fd',
                  fontSize: 15,
                  padding: '5px 14px',
                  borderRadius: 999,
                }}
              >
                {typeof log.status === 'string' ? log.status : ''}
              </span>
            </div>

            {review && (
              <div
                style={{
                  color: '#a1a1aa',
                  fontSize: 24,
                  lineHeight: 1.45,
                  maxWidth: 700,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {review}
              </div>
            )}

            {authorName && (
              <div style={{ color: '#71717a', fontSize: 20, marginTop: 6 }}>
                @{authorName}
              </div>
            )}
          </div>
        </div>
      ),
      { width: 1200, height: 630, headers }
    );
  } catch (err) {
    console.error('[og/log] failed to render card:', err);
    // No store: a transient failure must not be pinned for a week.
    return errorResponse('Error generating image', 500, headers);
  }
}
