'use server';

import { createClient } from '@/lib/supabase';

export type Notification = {
  id: string;
  type: 'like' | 'follow';
  read: boolean;
  created_at: string;
  actor_username: string | null;
  log_id: string | null;
  game_name: string | null;
};

export async function getNotifications(): Promise<Notification[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('notifications')
    .select(`
      id, type, read, created_at, log_id,
      profiles!actor_id ( username ),
      game_logs ( games ( name ) )
    `)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) { console.error('getNotifications error:', error.message); return []; }

  return (data ?? []).map((n: any) => ({
    id: n.id,
    type: n.type,
    read: n.read,
    created_at: n.created_at,
    log_id: n.log_id ?? null,
    actor_username: Array.isArray(n.profiles) ? (n.profiles[0]?.username ?? null) : (n.profiles?.username ?? null),
    game_name: Array.isArray(n.game_logs)
      ? (Array.isArray(n.game_logs[0]?.games) ? n.game_logs[0]?.games[0]?.name : n.game_logs[0]?.games?.name) ?? null
      : (Array.isArray(n.game_logs?.games) ? n.game_logs?.games[0]?.name : n.game_logs?.games?.name) ?? null,
  }));
}

export async function markAllRead() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  await supabase
    .from('notifications')
    .update({ read: true })
    .eq('user_id', user.id)
    .eq('read', false);
}

export async function createNotification(
  userId: string,
  actorId: string,
  type: 'like' | 'follow',
  logId?: string
) {
  if (userId === actorId) return; // don't notify yourself
  const supabase = await createClient();
  await supabase.from('notifications').insert({
    user_id: userId,
    actor_id: actorId,
    type,
    log_id: logId ?? null,
  });
}
