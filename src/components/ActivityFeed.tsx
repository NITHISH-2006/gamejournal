'use client';

import { useEffect, useState, useRef } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase';
import { Card } from '@/components/ui/card';
import { Star } from 'lucide-react';
import { format } from 'date-fns';

type Log = {
  id: string;
  status: string;
  rating: number;
  review?: string;
  created_at: string;
  games: {
    name: string;
    cover_url?: string;
  } | null;
};

const statusColors: Record<string, string> = {
  playing: 'bg-blue-600/20 text-blue-400',
  completed: 'bg-green-600/20 text-green-400',
  backlog: 'bg-zinc-700/50 text-zinc-400',
  abandoned: 'bg-red-600/20 text-red-400',
};

export default function ActivityFeed() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);
  // Stable client ref — avoids re-creating on every render
  const supabase = useRef(createBrowserSupabaseClient()).current;

  const fetchLogs = async () => {
    const { data, error } = await supabase
      .from('game_logs')
      .select(`
        id,
        status,
        rating,
        review,
        created_at,
        games ( name, cover_url )
      `)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) console.error('ActivityFeed fetch error:', error);
    setLogs((data as Log[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    fetchLogs();

    const channel = supabase
      .channel('game_logs_feed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'game_logs' },
        () => fetchLogs()
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold">Recent Activity</h2>
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-28 rounded-xl bg-zinc-900 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold">Recent Activity</h2>

      {logs.length === 0 ? (
        <Card className="p-12 text-center bg-zinc-900 border-zinc-800">
          <p className="text-zinc-400 text-lg">No logs yet.</p>
          <p className="text-zinc-600 text-sm mt-1">Hit "Log a Game" to get started.</p>
        </Card>
      ) : (
        logs.map((log) => (
          <Card key={log.id} className="bg-zinc-900 border-zinc-800 p-0">
            <div className="flex gap-4 p-4">
              {/* Cover */}
              {log.games?.cover_url ? (
                <img
                  src={log.games.cover_url}
                  alt={log.games.name}
                  className="w-14 h-20 object-cover rounded flex-shrink-0"
                />
              ) : (
                <div className="w-14 h-20 bg-zinc-800 rounded flex-shrink-0" />
              )}

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold text-base truncate">{log.games?.name ?? 'Unknown Game'}</h3>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[log.status] ?? 'bg-zinc-700 text-zinc-400'}`}>
                    {log.status}
                  </span>
                </div>

                <div className="flex items-center gap-2 mt-1.5">
                  <div className="flex">
                    {Array.from({ length: 10 }).map((_, i) => (
                      <Star
                        key={i}
                        className={`w-3.5 h-3.5 ${i < log.rating ? 'fill-yellow-400 text-yellow-400' : 'text-zinc-700'}`}
                      />
                    ))}
                  </div>
                  <span className="text-sm text-zinc-400">{log.rating}/10</span>
                  <span className="text-xs text-zinc-600">·</span>
                  <span className="text-xs text-zinc-500">
                    {format(new Date(log.created_at), 'MMM d, yyyy')}
                  </span>
                </div>

                {log.review && (
                  <p className="mt-2 text-sm text-zinc-400 line-clamp-2">{log.review}</p>
                )}
              </div>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
