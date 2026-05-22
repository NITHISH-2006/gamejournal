'use client';

import { useEffect, useState, useRef } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase';
import { Card } from '@/components/ui/card';
import { Star } from 'lucide-react';
import { format } from 'date-fns';
import Link from 'next/link';

type Log = {
  id: string;
  game_id: number;
  user_id: string;
  status: string;
  rating: number;
  review?: string;
  created_at: string;
  games: { name: string; cover_url?: string } | null;
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
  const supabase = useRef(createBrowserSupabaseClient()).current;

  const fetchLogs = async (feedMode: FeedMode) => {
    setLoading(true);

    if (feedMode === 'following' && currentUserId) {
      // Get IDs of people the current user follows
      const { data: followData } = await supabase
        .from('follows')
        .select('following_id')
        .eq('follower_id', currentUserId);

      const followingIds = (followData ?? []).map((f) => f.following_id);

      if (followingIds.length === 0) {
        setLogs([]);
        setLoading(false);
        return;
      }

      const { data } = await supabase
        .from('game_logs')
        .select('id, game_id, user_id, status, rating, review, created_at, games ( name, cover_url )')
        .in('user_id', followingIds)
        .order('created_at', { ascending: false })
        .limit(30);

      setLogs((data as Log[]) ?? []);
    } else {
      const { data } = await supabase
        .from('game_logs')
        .select('id, game_id, user_id, status, rating, review, created_at, games ( name, cover_url )')
        .order('created_at', { ascending: false })
        .limit(30);

      setLogs((data as Log[]) ?? []);
    }

    setLoading(false);
  };

  useEffect(() => {
    fetchLogs(mode);

    const channel = supabase
      .channel('game_logs_feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_logs' }, () => {
        fetchLogs(mode);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [mode]);

  const switchMode = (m: FeedMode) => {
    if (m !== mode) setMode(m);
  };

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
                onClick={() => switchMode(m)}
                className={`px-4 py-1.5 capitalize transition-colors ${
                  mode === m
                    ? 'bg-violet-600 text-white'
                    : 'bg-zinc-900 text-zinc-400 hover:text-white'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Loading skeletons */}
      {loading && (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 rounded-xl bg-zinc-900 animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty states */}
      {!loading && logs.length === 0 && (
        <Card className="p-12 text-center bg-zinc-900 border-zinc-800">
          {mode === 'following' ? (
            <>
              <p className="text-zinc-400 text-lg">No activity from people you follow.</p>
              <p className="text-zinc-600 text-sm mt-1">Follow some users to see their logs here.</p>
            </>
          ) : (
            <>
              <p className="text-zinc-400 text-lg">No logs yet.</p>
              <p className="text-zinc-600 text-sm mt-1">Be the first to log a game!</p>
            </>
          )}
        </Card>
      )}

      {/* Log cards */}
      {!loading && logs.map((log) => (
        <Card key={log.id} className="bg-zinc-900 border-zinc-800 p-0 hover:border-zinc-700 transition-colors">
          <div className="flex gap-4 p-4">
            <Link href={`/game/${log.game_id}`} className="flex-shrink-0">
              {log.games?.cover_url ? (
                <img
                  src={log.games.cover_url}
                  alt={log.games.name}
                  className="w-14 h-20 object-cover rounded hover:opacity-80 transition-opacity"
                />
              ) : (
                <div className="w-14 h-20 bg-zinc-800 rounded" />
              )}
            </Link>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Link href={`/game/${log.game_id}`} className="font-semibold text-base hover:text-violet-400 transition-colors truncate">
                  {log.games?.name ?? 'Unknown Game'}
                </Link>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${statusColors[log.status] ?? 'bg-zinc-700 text-zinc-400'}`}>
                  {log.status}
                </span>
              </div>

              <div className="flex items-center gap-2 mt-1.5">
                <div className="flex">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <Star key={i} className={`w-3.5 h-3.5 ${i < log.rating ? 'fill-yellow-400 text-yellow-400' : 'text-zinc-700'}`} />
                  ))}
                </div>
                <span className="text-sm text-zinc-400">{log.rating}/10</span>
                <span className="text-xs text-zinc-600">·</span>
                <span className="text-xs text-zinc-500">{format(new Date(log.created_at), 'MMM d, yyyy')}</span>
              </div>

              {log.review && (
                <p className="mt-2 text-sm text-zinc-400 line-clamp-2">{log.review}</p>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
