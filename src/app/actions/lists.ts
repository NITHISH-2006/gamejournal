'use server';

import { createClient } from '@/lib/supabase';

export async function createList(name: string, description?: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');

  const { data, error } = await supabase
    .from('lists')
    .insert({ user_id: user.id, name: name.trim(), description: description?.trim() || null })
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function getUserLists(userId: string) {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('lists')
    .select(`
      id, name, description, is_public, created_at,
      list_games ( game_id, games ( name, cover_url ) )
    `)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function addGameToList(listId: string, gameId: number) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');

  const { error } = await supabase
    .from('list_games')
    .insert({ list_id: listId, game_id: gameId });

  if (error && error.code !== '23505') throw new Error(error.message); // ignore duplicate
}

export async function removeGameFromList(listId: string, gameId: number) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');

  const { error } = await supabase
    .from('list_games')
    .delete()
    .eq('list_id', listId)
    .eq('game_id', gameId);

  if (error) throw new Error(error.message);
}

export async function deleteList(listId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');

  const { error } = await supabase
    .from('lists')
    .delete()
    .eq('id', listId)
    .eq('user_id', user.id);

  if (error) throw new Error(error.message);
}
