'use server';

import { createClient } from '@/lib/supabase';
import { ensureGameCached } from '@/app/actions/igdb';

export async function saveGameLog(
  game: { id: number; name: string; cover_url?: string | null; release_date?: string | null },
  status: string,
  rating: number,
  review: string
) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('You must be signed in to log games.');

  // Guarantee the game row exists before inserting the FK reference
  await ensureGameCached(game);

  const { error } = await supabase.from('game_logs').insert({
    user_id: user.id,
    game_id: game.id,
    status,
    rating,
    review: review.trim() || null,
  });

  if (error) {
    console.error('saveGameLog error:', error);
    throw new Error(error.message);
  }

  return { success: true };
}
