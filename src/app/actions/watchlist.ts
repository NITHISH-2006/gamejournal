'use server';

import { createClient } from '@/lib/supabase';
import { ensureGameCached } from '@/app/actions/igdb';

async function getOrCreateWatchlist(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  // Find existing watchlist
  const { data: existing } = await supabase
    .from('lists')
    .select('id')
    .eq('user_id', userId)
    .eq('name', 'Plan to Play')
    .maybeSingle();

  if (existing) return existing.id;

  // Create it
  const { data, error } = await supabase
    .from('lists')
    .insert({ user_id: userId, name: 'Plan to Play', description: 'Games I want to play', is_public: true })
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  return data.id;
}

export async function addToWatchlist(game: { id: number; name: string; cover_url?: string | null; release_date?: string | null }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');

  await ensureGameCached(game);
  const listId = await getOrCreateWatchlist(supabase, user.id);

  const { error } = await supabase
    .from('list_games')
    .insert({ list_id: listId, game_id: game.id });

  if (error && error.code !== '23505') throw new Error(error.message);
}

export async function removeFromWatchlist(gameId: number) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');

  const listId = await getOrCreateWatchlist(supabase, user.id);

  await supabase
    .from('list_games')
    .delete()
    .eq('list_id', listId)
    .eq('game_id', gameId);
}

export async function isInWatchlist(gameId: number): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { data: list } = await supabase
    .from('lists')
    .select('id')
    .eq('user_id', user.id)
    .eq('name', 'Plan to Play')
    .maybeSingle();

  if (!list) return false;

  const { data } = await supabase
    .from('list_games')
    .select('game_id')
    .eq('list_id', list.id)
    .eq('game_id', gameId)
    .maybeSingle();

  return !!data;
}
