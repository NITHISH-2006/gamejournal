import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import Link from 'next/link';
import { format } from 'date-fns';

export default async function ListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: list } = await supabase
    .from('lists')
    .select(`
      id, name, description, is_public, created_at, user_id,
      list_games ( game_id, added_at, games ( name, cover_url ) )
    `)
    .eq('id', id)
    .single();

  if (!list) notFound();

  const items = (list.list_games ?? []) as {
    game_id: number;
    added_at: string;
    games: { name: string; cover_url?: string } | null;
  }[];

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">{list.name}</h1>
        {list.description && <p className="text-zinc-400 mt-2">{list.description}</p>}
        <p className="text-zinc-600 text-sm mt-2">
          {items.length} {items.length === 1 ? 'game' : 'games'} · Created {format(new Date(list.created_at), 'MMM d, yyyy')}
        </p>
      </div>

      {items.length === 0 ? (
        <p className="text-zinc-500">No games in this list yet.</p>
      ) : (
        <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-3">
          {items.map((item) => (
            <Link key={item.game_id} href={`/game/${item.game_id}`} className="group">
              {item.games?.cover_url ? (
                <img
                  src={item.games.cover_url}
                  alt={item.games.name}
                  className="w-full aspect-[3/4] object-cover rounded-lg group-hover:opacity-80 transition-opacity"
                />
              ) : (
                <div className="w-full aspect-[3/4] bg-zinc-800 rounded-lg" />
              )}
              <p className="mt-1 text-xs text-zinc-500 truncate group-hover:text-white transition-colors">
                {item.games?.name}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
