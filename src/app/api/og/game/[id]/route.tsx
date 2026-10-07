import { createPublicClient } from '@/lib/supabase';
import { validateGameId } from '@/lib/validation';
import { ImageResponse } from 'next/og';

/**
 * Server-rendered OpenGraph card for a game's page, so links shared to
 * Discord/Slack/X render a real preview instead of a bare 264x374 cover.
 */
export const runtime = 'edge';

const CACHE = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const headers = new Headers({ 'Cache-Control': CACHE });

  try {
    const gameId = validateGameId(id);
    const supabase = createPublicClient();

    const { data: game } = await supabase
      .from('games')
      .select('id, name, cover_url, summary, release_date')
      .eq('id', gameId)
      .single();

    if (!game) {
      return new Response('Not found', { status: 404, headers });
    }

    const [{ count: logCount }, { data: agg }] = await Promise.all([
      supabase
        .from('game_logs')
        .select('id', { count: 'exact', head: true })
        .eq('game_id', gameId),
      supabase.rpc('get_game_stats', { p_game_id: gameId }),
    ]);

    const row = (Array.isArray(agg) ? agg[0] : agg) as
      | { avg_rating: number | string | null; rating_count: number | string | null }
      | undefined;

    const avg = row?.avg_rating != null ? Number(row.avg_rating) : null;
    const ratingCount = Number(row?.rating_count ?? 0);
    const releaseYear = game.release_date
      ? String(game.release_date).slice(0, 4)
      : null;

    const cover =
      typeof game.cover_url === 'string' && game.cover_url.startsWith('https://')
        ? game.cover_url
        : null;

    const stars =
      avg != null
        ? '★'.repeat(Math.round(avg / 2)) + '☆'.repeat(5 - Math.round(avg / 2))
        : null;

    return new ImageResponse(
      (
        <div
          style={{
            width: '1200px',
            height: '630px',
            display: 'flex',
            gap: '56px',
            padding: '64px',
            alignItems: 'center',
            background: 'linear-gradient(135deg, #0d0d14 0%, #17121f 60%, #1b1226 100%)',
            fontFamily: 'sans-serif',
          }}
        >
          {cover && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cover}
              alt=""
              width={240}
              height={320}
              style={{
                width: 240,
                height: 320,
                objectFit: 'cover',
                borderRadius: 20,
                flexShrink: 0,
                boxShadow: '0 20px 60px -12px rgba(0,0,0,0.7)',
              }}
            />
          )}

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
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
                fontSize: 60,
                fontWeight: 800,
                lineHeight: 1.08,
              }}
            >
              {game.name}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              {stars && <span style={{ color: '#fbbf24', fontSize: 36 }}>{stars}</span>}
              {avg != null && (
                <span style={{ color: '#d4d4d8', fontSize: 28 }}>
                  {avg.toFixed(1)}/10
                </span>
              )}
              {releaseYear && (
                <span style={{ color: '#71717a', fontSize: 24 }}>{releaseYear}</span>
              )}
            </div>

            {game.summary && (
              <div
                style={{
                  color: '#a1a1aa',
                  fontSize: 24,
                  lineHeight: 1.5,
                  maxWidth: 680,
                  display: '-webkit-box',
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {String(game.summary).slice(0, 220)}
              </div>
            )}

            {/* Satori (next/og) requires an explicit `display` on any element
                with more than one child node. The previous version rendered
                three separate JSX children here with no display, which made
                the whole route fail with:
                  "Expected <div> to have explicit display: flex..."
                and return a 500 for every shared link. Building the sentence as
                a single string is the more robust fix — one child, so the
                constraint cannot be violated. */}
            <div style={{ color: '#71717a', fontSize: 22, marginTop: 4 }}>
              {`${logCount ?? 0} ${logCount === 1 ? 'player has' : 'players have'} logged this${
                ratingCount > 0 ? ` · ${ratingCount} ratings` : ''
              }`}
            </div>
          </div>
        </div>
      ),
      { width: 1200, height: 630, headers }
    );
  } catch (err) {
    console.error('[og:game] failed to render card:', err);
    return new Response('Error generating image', { status: 500, headers });
  }
}
