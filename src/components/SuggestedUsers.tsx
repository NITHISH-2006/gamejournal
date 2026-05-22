import { createClient } from '@/lib/supabase';
import Link from 'next/link';
import FollowButton from '@/components/FollowButton';

export default async function SuggestedUsers({ currentUserId }: { currentUserId: string }) {
  const supabase = await createClient();

  // Get users with the most logs, excluding current user
  const { data: topLoggers } = await supabase
    .from('game_logs')
    .select('user_id')
    .neq('user_id', currentUserId)
    .limit(50);

  if (!topLoggers?.length) return null;

  // Count logs per user and take top 5
  const counts = new Map<string, number>();
  for (const row of topLoggers) {
    counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
  }
  const topIds = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => id);

  if (!topIds.length) return null;

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, display_name')
    .in('id', topIds);

  if (!profiles?.length) return null;

  return (
    <div className="mb-8 p-5 rounded-xl border border-zinc-800 bg-zinc-900">
      <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">
        Suggested Users to Follow
      </h3>
      <div className="space-y-3">
        {profiles.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3">
            <Link href={`/user/${p.username}`} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
              <div className="w-8 h-8 rounded-full bg-violet-600 flex items-center justify-center text-sm font-bold flex-shrink-0">
                {p.username[0].toUpperCase()}
              </div>
              <div>
                <p className="text-sm font-medium">{p.display_name || `@${p.username}`}</p>
                {p.display_name && <p className="text-xs text-zinc-500">@{p.username}</p>}
              </div>
            </Link>
            <FollowButton targetUserId={p.id} initialFollowing={false} />
          </div>
        ))}
      </div>
    </div>
  );
}
