import { createClient } from '@/lib/supabase';
import Link from 'next/link';
import { Star } from 'lucide-react';
import UserSearch from '@/components/UserSearch';

type GameRow = {
  game_id: number;
  avg_rating: number;
  log_count: number;
  games: { name: string; cover_url?: string } | null;
};

export default async function DiscoverPage() {
  const supabase = await createClient();

  // Top rated: aggregate game_logs by game_id
  const { data: topRaw } = await supabase
    .from('game_logs')
    .select('game_id, rating, games ( name, cover_url )')
    .not('rating', 'is', null)
    .order('rating', { ascending: false })
    .limit(100);

  // Group by game_id client-side (Supabase free tier has no RPC aggregation without functions)
  const gameMap = new Map<number, { name: string; cover_url?: string; ratings: number[] }>();
  for (const row of topRaw ?? []) {
    const g = row.games as { name: string; cover_url?: string } | null;
    if (!g) continue;
    if (!gameMap.has(row.game_id)) gameMap.set(row.game_id, { ...g, ratings: [] });
    gameMap.get(row.game_id)!.ratings.push(row.rating);
  }

  const topGames = Array.from(gameMap.entries())
    .map(([id, g]) => ({
      id,
      name: g.name,
      cover_url: g.cover_url,
      avg: g.ratings.reduce((a, b) => a + b, 0) / g.ratings.length,
      count: g.ratings.length,
    }))
    .filter((g) => g.count >= 1)
    .sort((a, b) => b.avg - a.avg || b.count - a.count)
    .slice(0, 24);

  // Recently active games
  const { data: recentRaw } = await supabase
    .from('game_logs')
    .select('game_id, created_at, games ( name, cover_url )')
    .order('created_at', { ascending: false })
    .limit(50);

  const seenRecent = new Set<number>();
  const recentGames: { id: number; name: string; cover_url?: string }[] = [];
  for (const row of recentRaw ?? []) {
    if (seenRecent.has(row.game_id)) continue;
    seenRecent.add(row.game_id);
    const g = row.games as { name: string; cover_url?: string } | null;
    if (g) recentGames.push({ id: row.game_id, name: g.name, cover_url: g.cover_url });
    if (recentGames.length >= 12) break;
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-10 space-y-14">

      {/* User search */}
      <section>
        <h2 className="text-xl font-bold mb-4">Find Users</h2>
        <div className="max-w-sm">
          <UserSearch />
        </div>
      </section>

      {/* Top Rated */}
      <section>
        <h2 className="text-2xl font-bold mb-6">Top Rated Games</h2>
        {topGames.length === 0 ? (
          <p className="text-zinc-500">No ratings yet — log some games to see rankings here.</p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-4">
            {topGames.map((game) => (
              <Link key={game.id} href={`/game/${game.id}`} className="group">
                <div className="relative">
                  {game.cover_url ? (
                    <img
                      src={game.cover_url}
                      alt={game.name}
                      className="w-full aspect-[3/4] object-cover rounded-lg group-hover:opacity-80 transition-opacity"
                    />
                  ) : (
                    <div className="w-full aspect-[3/4] bg-zinc-800 rounded-lg" />
                  )}
                  {/* Rating badge */}
                  <div className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 bg-black/70 rounded px-1.5 py-0.5">
                    <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />
                    <span className="text-xs font-semibold text-white">{game.avg.toFixed(1)}</span>
                  </div>
                </div>
                <p className="mt-1.5 text-xs text-zinc-400 truncate group-hover:text-white transition-colors">
                  {game.name}
                </p>
                <p className="text-xs text-zinc-600">{game.count} {game.count === 1 ? 'log' : 'logs'}</p>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Recently Logged */}
      <section>
        <h2 className="text-2xl font-bold mb-6">Recently Logged</h2>
        {recentGames.length === 0 ? (
          <p className="text-zinc-500">Nothing logged yet.</p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-4">
            {recentGames.map((game) => (
              <Link key={game.id} href={`/game/${game.id}`} className="group">
                {game.cover_url ? (
                  <img
                    src={game.cover_url}
                    alt={game.name}
                    className="w-full aspect-[3/4] object-cover rounded-lg group-hover:opacity-80 transition-opacity"
                  />
                ) : (
                  <div className="w-full aspect-[3/4] bg-zinc-800 rounded-lg" />
                )}
                <p className="mt-1.5 text-xs text-zinc-400 truncate group-hover:text-white transition-colors">
                  {game.name}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
