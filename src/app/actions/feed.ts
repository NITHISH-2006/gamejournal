'use server';

import { createClient } from '@/lib/supabase';

export type FeedLog = {
  id: string;
  game_id: number;
  user_id: string;
  status: string;
  rating: number;
  review: string | null;
  diary_date: string | null;
  tags: string[] | null;
  created_at: string;
  game_name: string;
  game_cover: string | null;
  username: string | null;
};

export async function getFeedData(
  type: 'global' | 'following' | 'trending',
  currentUserId?: string
): Promise<FeedLog[]> {
  const supabase = await createClient();

  try {
    if (type === 'following') {
      if (!currentUserId) return [];

      const { data: followData } = await supabase
        .from('follows')
        .select('following_id')
        .eq('follower_id', currentUserId);

      const ids = (followData ?? []).map((f: any) => f.following_id as string);
      if (!ids.length) return [];

      const { data, error } = await supabase
        .from('game_logs')
        .select(`
          id, game_id, user_id, status, rating, review,
          diary_date, tags, created_at,
          games ( name, cover_url ),
          profiles ( username )
        `)
        .in('user_id', ids)
        .order('created_at', { ascending: false })
        .limit(30);

      if (error) { console.error('feed following error:', error.message); return []; }
      return normalize(data ?? []);
    }

    if (type === 'trending') {
      // Last 48 hours — most-logged games bubble to top
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from('game_logs')
        .select(`
          id, game_id, user_id, status, rating, review,
          diary_date, tags, created_at,
          games ( name, cover_url ),
          profiles ( username )
        `)
        .gte('created_at', cutoff)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) { console.error('feed trending error:', error.message); return []; }

      const raw = normalize(data ?? []);
      const freq = new Map<number, number>();
      for (const l of raw) freq.set(l.game_id, (freq.get(l.game_id) ?? 0) + 1);
      return raw.sort((a, b) => (freq.get(b.game_id) ?? 0) - (freq.get(a.game_id) ?? 0));
    }

    // global
    const { data, error } = await supabase
      .from('game_logs')
      .select(`
        id, game_id, user_id, status, rating, review,
        diary_date, tags, created_at,
        games ( name, cover_url ),
        profiles ( username )
      `)
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) { console.error('feed global error:', error.message); return []; }
    return normalize(data ?? []);

  } catch (err: any) {
    console.error('getFeedData error:', err.message);
    return [];
  }
}

function normalize(rows: any[]): FeedLog[] {
  return rows.map((r) => ({
    id: r.id,
    game_id: r.game_id,
    user_id: r.user_id,
    status: r.status,
    rating: r.rating,
    review: r.review ?? null,
    diary_date: r.diary_date ?? null,
    tags: r.tags ?? null,
    created_at: r.created_at,
    game_name: Array.isArray(r.games) ? (r.games[0]?.name ?? 'Unknown') : (r.games?.name ?? 'Unknown'),
    game_cover: Array.isArray(r.games) ? (r.games[0]?.cover_url ?? null) : (r.games?.cover_url ?? null),
    username: Array.isArray(r.profiles) ? (r.profiles[0]?.username ?? null) : (r.profiles?.username ?? null),
  }));
}
