'use server';

import { createClient } from '@/lib/supabase';
import { revalidatePath } from 'next/cache';
import { createNotification } from '@/app/actions/notifications';

export async function followUser(followingId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  if (user.id === followingId) throw new Error('Cannot follow yourself');

  const { error } = await supabase
    .from('follows')
    .insert({ follower_id: user.id, following_id: followingId });

  if (error) throw new Error(error.message);

  await createNotification(followingId, user.id, 'follow').catch(() => {});

  revalidatePath('/');
  revalidatePath(`/user/${followingId}`);
}

export async function unfollowUser(followingId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');

  const { error } = await supabase
    .from('follows')
    .delete()
    .eq('follower_id', user.id)
    .eq('following_id', followingId);

  if (error) throw new Error(error.message);

  revalidatePath('/');
  revalidatePath(`/user/${followingId}`);
}

export async function getFollowCounts(userId: string) {
  const supabase = await createClient();

  const [{ count: followers, error: e1 }, { count: following, error: e2 }] = await Promise.all([
    supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId),
    supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId),
  ]);

  if (e1) console.error('getFollowCounts followers error:', e1.message);
  if (e2) console.error('getFollowCounts following error:', e2.message);
  if (e1 || e2) throw new Error(e1?.message ?? e2?.message ?? 'Failed to get follow counts');

  return { followers: followers ?? 0, following: following ?? 0 };
}

export async function isFollowing(followingId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { data } = await supabase
    .from('follows')
    .select('follower_id')
    .eq('follower_id', user.id)
    .eq('following_id', followingId)
    .maybeSingle();

  return !!data;
}
