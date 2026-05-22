import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { getProfileByUsername } from '@/app/actions/profiles';
import { getFollowCounts, isFollowing } from '@/app/actions/follows';
import { getUserLists } from '@/app/actions/lists';
import FollowButton from '@/components/FollowButton';
import { Card } from '@/components/ui/card';
import { Star } from 'lucide-react';
import { format } from 'date-fns';
import Link from 'next/link';

type Log = {
  id: string;
  game_id: number;
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

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return { title: `@${username} — GameJournal` };
}

export default async function UserProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const supabase = await createClient();

  const [profile, { data: { user: currentUser } }] = await Promise.all([
    getProfileByUsername(username),
    supabase.auth.getUser(),
  ]);

  if (!profile) notFound();

  const isOwnProfile = currentUser?.id === profile.id;

  const [logsResult, followCounts, lists, following] = await Promise.all([
    supabase
      .from('game_logs')
      .select('id, game_id, status, rating, review, created_at, games ( name, cover_url )')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false }),
    getFollowCounts(profile.id).catch(() => ({ followers: 0, following: 0 })),
    getUserLists(profile.id).catch(() => []),
    currentUser && !isOwnProfile ? isFollowing(profile.id).catch(() => false) : Promise.resolve(false),
  ]);

  const allLogs = (logsResult.data ?? []) as unknown as Log[];
  const ratings = allLogs.map((l) => l.rating).filter(Boolean) as number[];
  const avgRating = ratings.length
    ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)
    : null;

  const stats = [
    { label: 'Logged',    value: allLogs.length },
    { label: 'Completed', value: allLogs.filter((l) => l.status === 'completed').length },
    { label: 'Playing',   value: allLogs.filter((l) => l.status === 'playing').length },
    { label: 'Avg Rating', value: avgRating ? `${avgRating}/10` : '—' },
  ];

  return (
    <div className="max-w-4xl mx-auto px-6 py-10 space-y-10">

      {/* Profile header */}
      <div className="flex items-start gap-5">
        <div className="w-16 h-16 rounded-full bg-violet-600 flex items-center justify-center text-2xl font-bold select-none flex-shrink-0">
          {profile.username[0].toUpperCase()}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold">
              {profile.display_name || `@${profile.username}`}
            </h1>
            {profile.display_name && (
              <span className="text-zinc-500 text-sm">@{profile.username}</span>
            )}
            {/* Follow button — only shown to other signed-in users */}
            {currentUser && !isOwnProfile && (
              <FollowButton targetUserId={profile.id} initialFollowing={following as boolean} />
            )}
            {isOwnProfile && (
              <Link href="/profile" className="text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-700 rounded-lg px-3 py-1 transition-colors">
                Edit Profile
              </Link>
            )}
          </div>
          {profile.bio && <p className="text-zinc-400 text-sm mt-1">{profile.bio}</p>}
          <div className="flex gap-4 mt-2 text-sm text-zinc-400">
            <span><strong className="text-white">{followCounts.followers}</strong> followers</span>
            <span><strong className="text-white">{followCounts.following}</strong> following</span>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {stats.map(({ label, value }) => (
          <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold">{value}</p>
            <p className="text-xs text-zinc-500 mt-1 uppercase tracking-wider">{label}</p>
          </div>
        ))}
      </div>

      {/* Cover grid */}
      {allLogs.filter((l) => l.games?.cover_url).length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Games</h2>
          <div className="grid grid-cols-6 sm:grid-cols-10 gap-2">
            {allLogs.filter((l) => l.games?.cover_url).slice(0, 20).map((log) => (
              <Link key={log.id} href={`/game/${log.game_id}`}>
                <img
                  src={log.games!.cover_url!}
                  alt={log.games!.name}
                  title={log.games!.name}
                  className="w-full aspect-[3/4] object-cover rounded hover:opacity-75 transition-opacity"
                />
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Public lists */}
      {lists.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Lists</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {lists.map((list: any) => (
              <Link key={list.id} href={`/list/${list.id}`}>
                <Card className="bg-zinc-900 border-zinc-800 p-4 hover:border-zinc-700 transition-colors cursor-pointer">
                  <p className="font-semibold">{list.name}</p>
                  {list.description && <p className="text-sm text-zinc-500 mt-0.5 line-clamp-1">{list.description}</p>}
                  <p className="text-xs text-zinc-600 mt-2">{list.list_games?.length ?? 0} games</p>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Recent logs */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Recent Logs</h2>
        {allLogs.length === 0 ? (
          <Card className="p-12 text-center bg-zinc-900 border-zinc-800">
            <p className="text-zinc-400">No games logged yet.</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {allLogs.slice(0, 10).map((log) => (
              <Card key={log.id} className="bg-zinc-900 border-zinc-800 p-0">
                <div className="flex gap-4 p-4">
                  <Link href={`/game/${log.game_id}`} className="flex-shrink-0">
                    {log.games?.cover_url ? (
                      <img src={log.games.cover_url} alt={log.games.name} className="w-12 h-16 object-cover rounded hover:opacity-75 transition-opacity" />
                    ) : (
                      <div className="w-12 h-16 bg-zinc-800 rounded" />
                    )}
                  </Link>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link href={`/game/${log.game_id}`} className="font-semibold hover:text-violet-400 transition-colors truncate">
                        {log.games?.name ?? 'Unknown'}
                      </Link>
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
                    {log.review && <p className="mt-1.5 text-sm text-zinc-400 line-clamp-2">{log.review}</p>}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
