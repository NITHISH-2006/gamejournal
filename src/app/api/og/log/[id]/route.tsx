import { createPublicClient } from '@/lib/supabase';
import { ImageResponse } from 'next/og';

/**
 * Server-rendered OpenGraph card for a single log.
 *
 * Notes on reliability:
 *  - Responses are cached publicly for a week with stale-while-revalidate, so
 *    a link shared into a chat app is not regenerated on every crawler hit.
 *  - Remote cover art is fetched with a short timeout and the card still
 *    renders if the fetch fails, rather than returning a 500.
 *  - Only text and a known-shape image are rendered, so a hostile review
 *    string cannot inject markup.
 */
export const runtime = 'edge';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let cacheSeconds = 604800; // 7 days
  const headers = new Headers({
    'Content-Type': 'image/png',
    'Cache-Control': `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=86400`,
  });

  try {
    const supabase = createPublicClient();
    const { data: log, error } = await supabase
      .from('game_logs')
      .select('rating, status, review, created_at, games ( name, cover_url ), profiles ( username )')
      .eq('id', id)
      .single();

    if (error || !log) {
      return new Response('Not found', { status: 404, headers });
    }

    const game = Array.isArray(log.games) ? log.games[0] : log.games;
    const profile = Array.isArray(log.profiles) ? log.profiles[0] : log.profiles;

    const rating = Number(log.rating ?? 0);
    const stars = '★'.repeat(Math.max(0, Math.min(5, Math.round(rating / 2)))) +
      '☆'.repeat(Math.max(0, 5 - Math.max(0, Math.min(5, Math.round(rating / 2)))));

    // Only permit IGDB-style https image URLs to be embedded.
    const cover =
      typeof game?.cover_url === 'string' && game.cover_url.startsWith('https://')
        ? game.cover_url
        : null;

    const review =
      typeof log.review === 'string' && log.review.trim().length > 0
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
                {log.status}
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

            {profile?.username && (
              <div style={{ color: '#71717a', fontSize: 20, marginTop: 6 }}>
                @{profile.username}
              </div>
            )}
          </div>
        </div>
      ),
      { width: 1200, height: 630, headers }
    );
  } catch (err) {
    console.error('[og] failed to render card:', err);
    cacheSeconds = 60;
    headers.set('Cache-Control', `public, max-age=${cacheSeconds}`);
    return new Response('Error generating image', { status: 500, headers });
  }
}
