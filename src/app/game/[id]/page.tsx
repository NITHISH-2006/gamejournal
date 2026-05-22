import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { Card } from '@/components/ui/card';
import { Star } from 'lucide-react';
import { format } from 'date-fns';

type Log = {
  id: string;
  status: string;
  rating: number;
  review?: string;
  created_at: string;
  user_id: string;
};

const statusColors: Record<string, string> = {
  playing:   'bg-blue-600/20 text-blue-400',
  completed: 'bg-green-600/20 text-green-400',
  backlog:   'bg-zinc-700/50 text-zinc-400',
  abandoned: 'bg-red-600/20 text-red-400',
};

export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  // Fetch game info
  const { data: game } = await supabase
    .from('games')
    .select('*')
    .eq('id', id)
    .single();

  if (!game) notFound();

  // Fetch all logs for this game
  const { data: logs } = await supabase
    .from('game_logs')
    .select('id, status, rating, review, created_at, user_id')
    .eq('game_id', id)
    .order('created_at', { ascending: false });

  const allLogs = (logs ?? []) as Log[];

  // Community stats
  const ratings = allLogs.map((l) => l.rating).filter(Boolean) as number[];
  const avgRating = ratings.length
    ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)
    : null;

  const statusCounts = allLogs.reduce<Record<string, number>>((acc, l) => {
    acc[l.status] = (acc[l.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">

      {/* Game header */}
      <div className="flex gap-6 mb-10">
        {game.cover_url ? (
          <img
            src={game.cover_url}
            alt={game.name}
            className="w-32 h-44 object-cover rounded-xl flex-shrink-0 shadow-lg"
          />
        ) : (
          <div className="w-32 h-44 bg-zinc-800 rounded-xl flex-shrink-0" />
        )}

        <div className="flex-1">
          <h1 className="text-4xl font-bold mb-1">{game.name}</h1>
          {game.release_date && (
            <p className="text-zinc-500 text-sm mb-4">{format(new Date(game.release_date), 'yyyy')}</p>
          )}

          {/* Community rating */}
          {avgRating && (
            <div className="flex items-center gap-2 mb-4">
              <div className="flex">
                {Array.from({ length: 10 }).map((_, i) => (
                  <Star key={i} className={`w-4 h-4 ${i < parseFloat(avgRating) ? 'fill-yellow-400 text-yellow-400' : 'text-zinc-700'}`} />
                ))}
              </div>
              <span className="text-lg font-semibold">{avgRating}</span>
              <span className="text-zinc-500 text-sm">/ 10 · {ratings.length} {ratings.length === 1 ? 'rating' : 'ratings'}</span>
            </div>
          )}

          {/* Status breakdown */}
          {allLogs.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {Object.entries(statusCounts).map(([status, count]) => (
                <span key={status} className={`text-xs px-2.5 py-1 rounded-full font-medium ${statusColors[status] ?? 'bg-zinc-700 text-zinc-400'}`}>
                  {count} {status}
                </span>
              ))}
            </div>
          )}

          {game.summary && (
            <p className="mt-4 text-zinc-400 text-sm leading-relaxed line-clamp-4">{game.summary}</p>
          )}
        </div>
      </div>

      {/* Reviews */}
      <h2 className="text-xl font-semibold mb-4">
        Community Logs
        <span className="text-zinc-500 font-normal text-base ml-2">({allLogs.length})</span>
      </h2>

      {allLogs.length === 0 ? (
        <Card className="p-12 text-center bg-zinc-900 border-zinc-800">
          <p className="text-zinc-400">No logs yet. Be the first to log this game!</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {allLogs.map((log) => (
            <Card key={log.id} className="bg-zinc-900 border-zinc-800 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap mb-1.5">
                    {/* Anonymous avatar */}
                    <div className="w-6 h-6 rounded-full bg-zinc-700 flex items-center justify-center text-xs font-bold flex-shrink-0">
                      {log.user_id.slice(0, 1).toUpperCase()}
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[log.status] ?? 'bg-zinc-700 text-zinc-400'}`}>
                      {log.status}
                    </span>
                    <span className="text-xs text-zinc-500">{format(new Date(log.created_at), 'MMM d, yyyy')}</span>
                  </div>

                  <div className="flex items-center gap-1.5 mb-2">
                    {Array.from({ length: 10 }).map((_, i) => (
                      <Star key={i} className={`w-3.5 h-3.5 ${i < log.rating ? 'fill-yellow-400 text-yellow-400' : 'text-zinc-700'}`} />
                    ))}
                    <span className="text-sm text-zinc-400 ml-1">{log.rating}/10</span>
                  </div>

                  {log.review && (
                    <p className="text-sm text-zinc-300 leading-relaxed">{log.review}</p>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
