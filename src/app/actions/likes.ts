'use server';

import { createClient } from '@/lib/supabase';
import { revalidatePath } from 'next/cache';
import { createNotification } from '@/app/actions/notifications';

export async function likeLog(logId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');

  const { error } = await supabase
    .from('log_likes')
    .insert({ user_id: user.id, log_id: logId });

  if (error && error.code !== '23505') throw new Error(error.message);

  // Notify log owner
  const { data: log } = await supabase.from('game_logs').select('user_id').eq('id', logId).single();
  if (log) await createNotification(log.user_id, user.id, 'like', logId).catch(() => {});

  revalidatePath('/');
}

export async function unlikeLog(logId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');

  const { error } = await supabase
    .from('log_likes')
    .delete()
    .eq('user_id', user.id)
    .eq('log_id', logId);

  if (error) throw new Error(error.message);

  revalidatePath('/');
}

export async function getLikesForLogs(logIds: string[]): Promise<Record<string, { count: number; likedByMe: boolean }>> {
  if (!logIds.length) return {};
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data } = await supabase
    .from('log_likes')
    .select('log_id, user_id')
    .in('log_id', logIds);

  const result: Record<string, { count: number; likedByMe: boolean }> = {};
  for (const logId of logIds) {
    const rows = (data ?? []).filter((r) => r.log_id === logId);
    result[logId] = {
      count: rows.length,
      likedByMe: user ? rows.some((r) => r.user_id === user.id) : false,
    };
  }
  return result;
}
