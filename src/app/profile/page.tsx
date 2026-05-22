import { redirect } from 'next/navigation';
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
  games: { name: string; cover_url?: string } | null;
};

const statusColors: Record<string, string> = {
  playing:   'bg-blue-600/20 text-blue-400',
  completed: 'bg-green-600/20 text-green-400',
  backlog:   'bg-zinc-700/50 text-zinc-400',
  abandoned: 'bg-red-600/20 text-red-400',
};

export default async function ProfilePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect('/');

  // Fetch all logs for this user
  const { data: logs } = await supabase
    .from('game_logs')
    .select('id, status, rating, review, created_at, games ( name, cover_url )')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  const allLogs = (logs ?? []) as Log[];

  // Compute stats
  const total     = allLogs.length;
  const completed = allLogs.filter((l) => l.status === 'completed').length;
  const playing   = allLogs.filter((l) => l.status === 'playing').length;
  const backlog   = allLogs.filter((l) => l.status === 'backlog').length;
  const ratings   = allLogs.map((l) => l.rating).filter(Boolean) as number[];
  const avgRating = ratings.length
    ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)
    : null;

  const stats = [
    { label: 'Logged',    value: total },
    { label: 'Completed', value: completed },
    { label: 'Playing',   value: playing },
    { label: 'Backlog',   value: backlog },
    { label: 'Avg Rating', value: avgRating ? `${avgRating}/10` : '—' },
  ];

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">

      {/* Profile header */}
      <div className="mb-8">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-violet-600 flex items-center justify-center text-2xl font-bold select-none">
            {user.email?.[0].toUpperCase()}
          </div>
          <div>
            <h1 className="text-2xl font-bold">{user.email}</h1>
            <p className="text-zinc-500 text-sm mt-0.5">Member since {format(new Date(user.created_at), 'MMMM yyyy')}</p>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-10">
        {stats.map(({ label, value }) => (
          <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold">{value}</p>
            <p className="text-xs text-zinc-500 mt-1 uppercase tracking-wider">{label}</p>
          </div>
        ))}
      </div>

      {/* Cover grid */}
      {allLogs.length > 0 && (
        <div className="mb-10">
          <h2 className="text-lg font-semibold mb-4">Game Covers</h2>
          <div className="grid grid-cols-5 sm:grid-cols-8 gap-2">
            {allLogs.filter((l) => l.games?.cover_url).map((log) => (
              <img
                key={log.id}
                src={log.games!.cover_url!}
                alt={log.games!.name}
                title={log.games!.name}
                className="w-full aspect-[3/4] object-cover rounded-lg"
              />
            ))}
          </div>
        </div>
      )}

      {/* Full log list */}
      <h2 className="text-lg font-semibold mb-4">All Logs</h2>

      {allLogs.length === 0 ? (
        <Card className="p-12 text-center bg-zinc-900 border-zinc-800">
          <p className="text-zinc-400">No games logged yet.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {allLogs.map((log) => (
            <Card key={log.id} className="bg-zinc-900 border-zinc-800 p-0">
              <div className="flex gap-4 p-4">
                {log.games?.cover_url ? (
                  <img
                    src={log.games.cover_url}
                    alt={log.games.name}
                    className="w-12 h-16 object-cover rounded flex-shrink-0"
                  />
                ) : (
                  <div className="w-12 h-16 bg-zinc-800 rounded flex-shrink-0" />
                )}

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold truncate">{log.games?.name ?? 'Unknown'}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[log.status] ?? 'bg-zinc-700 text-zinc-400'}`}>
                      {log.status}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex">
                      {Array.from({ length: 10 }).map((_, i) => (
                        <Star key={i} className={`w-3 h-3 ${i < log.rating ? 'fill-yellow-400 text-yellow-400' : 'text-zinc-700'}`} />
                      ))}
                    </div>
                    <span className="text-xs text-zinc-500">{log.rating}/10</span>
                    <span className="text-xs text-zinc-600">·</span>
                    <span className="text-xs text-zinc-500">{format(new Date(log.created_at), 'MMM d, yyyy')}</span>
                  </div>

                  {log.review && (
                    <p className="mt-1.5 text-sm text-zinc-400 line-clamp-2">{log.review}</p>
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
