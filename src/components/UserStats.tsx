import { createClient } from '@/lib/supabase';

type Stats = {
  total: number;
  completed: number;
  playing: number;
  avgRating: number | null;
};

async function fetchStats(userId: string): Promise<Stats> {
  const supabase = await createClient();

  const { data } = await supabase
    .from('game_logs')
    .select('status, rating')
    .eq('user_id', userId);

  if (!data || data.length === 0) {
    return { total: 0, completed: 0, playing: 0, avgRating: null };
  }

  const completed = data.filter((l) => l.status === 'completed').length;
  const playing = data.filter((l) => l.status === 'playing').length;
  const ratings = data.map((l) => l.rating).filter((r) => r != null) as number[];
  const avgRating = ratings.length
    ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
    : null;

  return { total: data.length, completed, playing, avgRating };
}

export default async function UserStats({ userId }: { userId: string }) {
  const stats = await fetchStats(userId);

  const items = [
    { label: 'Games Logged', value: stats.total },
    { label: 'Completed', value: stats.completed },
    { label: 'Playing', value: stats.playing },
    { label: 'Avg Rating', value: stats.avgRating != null ? `${stats.avgRating}/10` : '—' },
  ];

  return (
    <div className="grid grid-cols-4 gap-3 mb-10">
      {items.map(({ label, value }) => (
        <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-center">
          <p className="text-2xl font-bold text-white">{value}</p>
          <p className="text-xs text-zinc-500 mt-1 uppercase tracking-wider">{label}</p>
        </div>
      ))}
    </div>
  );
}
