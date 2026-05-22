import { ImageResponse } from 'next/og';
import { createClient } from '@/lib/supabase';

export const runtime = 'edge';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const supabase = await createClient();
    const { data: log } = await supabase
      .from('game_logs')
      .select('rating, status, review, games ( name, cover_url ), profiles ( username )')
      .eq('id', id)
      .single();

    if (!log) {
      return new Response('Not found', { status: 404 });
    }

    const game = (log.games as any) as { name: string; cover_url?: string } | null;
    const profile = (log.profiles as any) as { username: string } | null;
    const stars = '★'.repeat(Math.round(log.rating / 2)) + '☆'.repeat(5 - Math.round(log.rating / 2));

    return new ImageResponse(
      (
        <div
          style={{
            width: '1200px',
            height: '630px',
            background: '#09090b',
            display: 'flex',
            alignItems: 'center',
            padding: '60px',
            gap: '48px',
            fontFamily: 'sans-serif',
          }}
        >
          {/* Cover */}
          {game?.cover_url && (
            <img
              src={game.cover_url}
              style={{ width: '180px', height: '240px', objectFit: 'cover', borderRadius: '12px', flexShrink: 0 }}
            />
          )}

          {/* Content */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1 }}>
            {/* Site badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#7c3aed' }} />
              <span style={{ color: '#7c3aed', fontSize: '18px', fontWeight: 700, letterSpacing: '0.1em' }}>
                GAMEJOURNAL
              </span>
            </div>

            {/* Game name */}
            <div style={{ color: '#ffffff', fontSize: '52px', fontWeight: 800, lineHeight: 1.1 }}>
              {game?.name ?? 'Unknown Game'}
            </div>

            {/* Stars + rating */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ color: '#facc15', fontSize: '32px' }}>{stars}</span>
              <span style={{ color: '#a1a1aa', fontSize: '24px' }}>{log.rating}/10</span>
              <span style={{
                background: '#27272a',
                color: '#a1a1aa',
                fontSize: '14px',
                padding: '4px 12px',
                borderRadius: '999px',
                marginLeft: '8px',
              }}>
                {log.status}
              </span>
            </div>

            {/* Review snippet */}
            {log.review && (
              <div style={{
                color: '#a1a1aa',
                fontSize: '22px',
                lineHeight: 1.5,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                overflow: 'hidden',
                maxWidth: '700px',
              }}>
                "{log.review}"
              </div>
            )}

            {/* Username */}
            {profile?.username && (
              <div style={{ color: '#52525b', fontSize: '18px', marginTop: '8px' }}>
                @{profile.username}
              </div>
            )}
          </div>
        </div>
      ),
      { width: 1200, height: 630 }
    );
  } catch (err) {
    console.error('OG image error:', err);
    return new Response('Error generating image', { status: 500 });
  }
}
