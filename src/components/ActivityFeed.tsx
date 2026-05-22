'use client';

import { useEffect, useState, useRef } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase';
import { Card } from '@/components/ui/card';
import { Star } from 'lucide-react';
import { format } from 'date-fns';
import Link from 'next/link';
import LikeButton from '@/components/LikeButton';
import { getLikesForLogs } from '@/app/actions/likes';

type Log = {
  id: string;
  game_id: number;
  user_id: string;
  status: string;
  rating: number;
  review?: string;
  diary_date?: string;
  tags?: string[];
  created_at: string;
  games: { name: string; cover_url?: string } | null;
  profiles: { username: string } | null;
};

type FeedMode = 'global' | 'following';

const statusColors: Record<string, string> = {
  playing:   'bg-blue-600/20 text-blue-400',
  completed: 'bg-green-600/20 text-green-400',
  backlog:   'bg-zinc-700/50 text-zinc-400',
  abandoned: 'bg-red-600/20 text-red-400',
};

export default function ActivityFeed({ currentUserId }: { currentUserId?: string }) {
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<FeedMode>('global');
  const [likes, setLikes] = useState<Record<string, { count: number; likedByMe: boolean }>>({});
  const supabase = useRef(createBrowserSupabaseClient()).current;

  const fetchLogs = async (feedMode: FeedMode) => {
    setLoading(true);
    let data: any[] = [];

    if (feedMode === 'following' && currentUserId) {
      const { data: followData } = await supabase
        .from('follows')
        .select('following_id')
        .eq('follower_id', currentUserId);

      const followingIds = (followData ?? []).map((f: any) => f.following_id);
      if (followingIds.length === 0) { setLogs([]); setLoading(false); return; }

      const { data: rows } = await supabase
        .from('game_logs')
        .select('id, game_id, user_id, status, rating, review, diary_date, tags, created_at, games ( name, cover_url ), profiles ( username )')
        .in('user_id', followingIds)
        .order('created_at', { ascending: false })
        .limit(30);
      data = rows ?? [];
    } else {
      const { data: rows } = await supabase
        .from('game_logs')
        .select('id, game_id, user_id, status, rating, review, diary_date, tags, created_at, games ( name, cover_url ), profiles ( username )')
        .order('created_at', { ascending: false })
        .limit(30);
      data = rows ?? [];
    }

    const typedLogs = data as unknown as Log[];
    setLogs(typedLogs);

    // Fetch likes for all logs
    if (typedLogs.length > 0) {
      const likesData = await getLikesForLogs(typedLogs.map((l) => l.id)).catch(() => ({}));
      setLikes(likesData);
    }

    setLoading(false);
  };

  useEffect(() => {
    fetchLogs(mode);
    const channel = supabase
      .channel('game_logs_feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_logs' }, () => fetchLogs(mode))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [mode]);

  return (
    <div className="space-y-4">
      {/* Feed toggle */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Activity</h2>
        {currentUserId && (
          <div className="flex rounded-lg overflow-hidden border border-zinc-800 text-sm">
            {(['global', 'following'] as FeedMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-4 py-1.5 capitalize transition-colors ${
                  mode === m ? 'bg-violet-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-white'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Skeletons */}
      {loading && (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 rounded-xl bg-zinc-900 animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty */}
      {!loading && logs.length === 0 && (
        <Card className="p-12 text-center bg-zinc-900 border-zinc-800">
          {mode === 'following' ? (
            <><p className="text-zinc-400">No activity from people you follow.</p><p className="text-zinc-600 text-sm mt-1">Follow users to see their logs here.</p></>
          ) : (
            <><p className="text-zinc-400">No logs yet.</p><p className="text-zinc-600 text-sm mt-1">Be the first to log a game!</p></>
          )}
        </Card>
      )}

      {/* Log cards */}
      {!loading && logs.map((log) => {
        const logLikes = likes[log.id] ?? { count: 0, likedByMe: false };
        const username = (log.profiles as any)?.username as string | undefined;

        return (
          <Card key={log.id} className="bg-zinc-900 border-zinc-800 p-0 hover:border-zinc-700 transition-colors">
            <div className="flex gap-4 p-4">
              <Link href={`/game/${log.game_id}`} className="flex-shrink-0">
                {log.games?.cover_url ? (
                  <img src={log.games.cover_url} alt={log.games.name} className="w-14 h-20 object-cover rounded hover:opacity-80 transition-opacity" />
                ) : (
                  <div className="w-14 h-20 bg-zinc-800 rounded" />
                )}
              </Link>

              <div className="flex-1 min-w-0">
                {/* Top row: game name + status */}
                <div className="flex items-center gap-2 flex-wrap">
                  <Link href={`/game/${log.game_id}`} className="font-semibold text-base hover:text-violet-400 transition-colors truncate">
                    {log.games?.name ?? 'Unknown Game'}
                  </Link>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${statusColors[log.status] ?? 'bg-zinc-700 text-zinc-400'}`}>
                    {log.status}
                  </span>
                </div>

                {/* Username + date */}
                <div className="flex items-center gap-2 mt-0.5 text-xs text-zinc-500">
                  {username && (
                    <><Link href={`/user/${username}`} className="hover:text-violet-400 transition-colors">@{username}</Link><span>·</span></>
                  )}
                  <span>{format(new Date(log.diary_date ?? log.created_at), 'MMM d, yyyy')}</span>
                </div>

                {/* Stars + rating */}
                <div className="flex items-center gap-2 mt-1.5">
                  <div className="flex">
                    {Array.from({ length: 10 }).map((_, i) => (
                      <Star key={i} className={`w-3.5 h-3.5 ${i < log.rating ? 'fill-yellow-400 text-yellow-400' : 'text-zinc-700'}`} />
                    ))}
                  </div>
                  <span className="text-sm text-zinc-400">{log.rating}/10</span>
                  <span className="ml-auto">
                    <LikeButton logId={log.id} initialCount={logLikes.count} initialLiked={logLikes.likedByMe} currentUserId={currentUserId} />
                  </span>
                </div>

                {log.review && <p className="mt-2 text-sm text-zinc-400 line-clamp-2">{log.review}</p>}

                {/* Tags */}
                {log.tags && log.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {log.tags.map((tag) => (
                      <span key={tag} className="text-xs px-1.5 py-0.5 bg-zinc-800 text-zinc-500 rounded">#{tag}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
