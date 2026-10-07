import { createClient } from '@/lib/supabase';
import Link from 'next/link';
import { getFollowStates } from '@/app/actions/follows';
import { getSuggestedUsers } from '@/app/actions/profiles';
import FollowButton from '@/components/FollowButton';
import { ProfileAvatar } from '@/components/ui-primitives';
import { Gamepad2 } from 'lucide-react';

/**
 * Accounts to follow, for users who have not followed anyone yet.
 *
 * The previous version counted logs over an arbitrary 50 most-recent rows
 * (biased toward whoever logged most recently) and hard-coded
 * `initialFollowing={false}`, so the button read "Follow" even for people you
 * already followed.
 */
export default async function SuggestedUsers({
  currentUserId,
}: {
  currentUserId: string;
}) {
  const supabase = await createClient();

  // Do not suggest anyone the user already follows.
  const { data: followingRows } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', currentUserId);

  const alreadyFollowing = new Set(
    (followingRows ?? []).map((r) => r.following_id as string)
  );

  // The action resolves the viewer from the session, so `is_following` is
  // already scoped to whoever is actually signed in. Passing a user id here
  // used to make the follow graph queryable for any account.
  const suggestions = (await getSuggestedUsers())
    .filter((s) => !alreadyFollowing.has(s.id))
    .slice(0, 4);

  if (!suggestions.length) return null;

  // Defensive: re-assert live follow state in case anything changed.
  const states: Record<string, boolean> = await getFollowStates(
    suggestions.map((s) => s.id)
  ).catch(() => ({}));

  return (
    <section
      className="glass mb-8 rounded-2xl p-5"
      aria-labelledby="suggested-users-heading"
    >
      <h2
        id="suggested-users-heading"
        className="mb-4 flex items-center gap-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase"
      >
        <Gamepad2 className="size-3.5 text-brand" />
        Players worth following
      </h2>

      <ul className="space-y-1">
        {suggestions.map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between gap-3 rounded-xl p-2 transition-colors hover:bg-white/4"
          >
            <Link
              href={`/user/${p.username}`}
              className="flex min-w-0 flex-1 items-center gap-3"
            >
              <ProfileAvatar username={p.username} size={36} />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {p.display_name ?? `@${p.username}`}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {p.log_count > 0
                    ? `${p.log_count} ${p.log_count === 1 ? 'log' : 'logs'}`
                    : 'New player'}
                </span>
              </span>
            </Link>
            <FollowButton
              targetUserId={p.id}
              initialFollowing={states[p.id] ?? false}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
