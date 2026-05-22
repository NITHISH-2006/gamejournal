'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase';
import { getFeedData, type FeedLog } from '@/app/actions/feed';
import { getLikesForLogs } from '@/app/actions/likes';
import { Card } from '@/components/ui/card';
import { Star } from 'lucide-react';
import { format } from 'date-fns';
import Link from 'next/link';
import LikeButton from '@/components/LikeButton';

type FeedMode = 'global' | 'following' | 'trending';

const statusColors: Record<string, string> = {
  playing:   'bg-blue-600/20 text-blue-400',
  completed: 'bg-green-600/20 text-green-400',
  backlog:   'bg-zinc-700/50 text-zinc-400',
  abandoned: 'bg-red-600/20 text-red-400',
};

export default function ActivityFeed({ currentUserId }: { currentUserId?: string }) {
  const [logs, setLogs] = useState<FeedLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<FeedMode>('global');
  const [likes, setLikes] = useState<Record<string, { count: number; likedByMe: boolean }>>({});
  // Realtime subscription only — data fetching goes through server action
  const supabase = useRef(createBrowserSupabaseClient()).current;

  const fetchLogs = useCallback(async (feedMode: FeedMode) => {
    setLoading(true);
    try {
      const data = await getFeedData(feedMode, currentUserId);
      setLogs(data);
      if (data.length > 0) {
        const likesData = await getLikesForLogs(data.map((l) => l.id)).catch(() => ({}));
        setLikes(likesData);
      } else {
        setLikes({});
      }
    } catch (err) {
      console.error('ActivityFeed fetch error:', err);
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [currentUserId]);

  useEffect(() => {
    fetchLogs(mode);

    // Realtime: re-fetch when new logs are inserted
    const channel = supabase
      .channel('feed_realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_logs' }, () => {
        fetchLogs(mode);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [mode, fetchLogs]);

  return (
    <div className="space-y-4">
      {/* Feed toggle */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Activity</h2>
        <div className="flex rounded-lg overflow-hidden border border-zinc-800 text-sm">
          {(['global', 'following', 'trending'] as FeedMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-4 py-1.5 capitalize transition-colors ${
                mode === m ? 'bg-violet-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-white'
              }`}
            >
              {m === 'trending' ? '🔥 Trending' : m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Skeletons */}
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
          {mode === 'following' && !currentUserId && (
            <p className="text-zinc-400">Sign in to see logs from people you follow.</p>
          )}
          {mode === 'following' && currentUserId && (
            <><p className="text-zinc-400 text-lg">No activity yet.</p><p className="text-zinc-600 text-sm mt-1">Follow some users to see their logs here.</p></>
          )}
          {mode === 'trending' && (
            <><p className="text-zinc-400 text-lg">Nothing trending yet.</p><p className="text-zinc-600 text-sm mt-1">Trending shows logs from the last 48 hours.</p></>
          )}
          {mode === 'global' && (
            <><p className="text-zinc-400 text-lg">No logs yet.</p><p className="text-zinc-600 text-sm mt-1">Be the first to log a game!</p></>
          )}
        </Card>
      )}

      {/* Log cards */}
      {!loading && logs.map((log) => {
        const logLikes = likes[log.id] ?? { count: 0, likedByMe: false };
        return (
          <Card key={log.id} className="bg-zinc-900 border-zinc-800 p-0 hover:border-zinc-700 transition-colors">
            <div className="flex gap-4 p-4">
              <Link href={`/game/${log.game_id}`} className="flex-shrink-0">
                {log.game_cover ? (
                  <img src={log.game_cover} alt={log.game_name} className="w-14 h-20 object-cover rounded hover:opacity-80 transition-opacity" />
                ) : (
                  <div className="w-14 h-20 bg-zinc-800 rounded" />
                )}
              </Link>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link href={`/game/${log.game_id}`} className="font-semibold text-base hover:text-violet-400 transition-colors truncate">
                    {log.game_name}
                  </Link>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${statusColors[log.status] ?? 'bg-zinc-700 text-zinc-400'}`}>
                    {log.status}
                  </span>
                </div>

                <div className="flex items-center gap-2 mt-0.5 text-xs text-zinc-500">
                  {log.username && (
                    <><Link href={`/user/${log.username}`} className="hover:text-violet-400 transition-colors">@{log.username}</Link><span>·</span></>
                  )}
                  <span>{format(new Date(log.diary_date ?? log.created_at), 'MMM d, yyyy')}</span>
                </div>

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
