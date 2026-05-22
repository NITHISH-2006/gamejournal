import { createClient } from '@/lib/supabase';
import ActivityFeed from '@/components/ActivityFeed';
import UserStats from '@/components/UserStats';
import ErrorBoundary from '@/components/ErrorBoundary';
import SuggestedUsers from '@/components/SuggestedUsers';
import LogGameModal from '@/components/LogGameModal';
import { Gamepad2 } from 'lucide-react';

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Check if user follows anyone (to decide whether to show suggested users)
  let hasFollows = false;
  if (user) {
    const { count } = await supabase
      .from('follows')
      .select('*', { count: 'exact', head: true })
      .eq('follower_id', user.id);
    hasFollows = (count ?? 0) > 0;
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">

      {/* Signed-out hero */}
      {!user && (
        <div className="mb-10 p-10 rounded-2xl border border-zinc-800 bg-zinc-900 text-center">
          <div className="flex justify-center mb-4">
            <Gamepad2 className="h-12 w-12 text-violet-500" />
          </div>
          <h2 className="text-3xl font-bold mb-2">Track every game you play.</h2>
          <p className="text-zinc-400 mb-6">
            Log games, rate them, write reviews, and see what your friends are playing.
          </p>
          <p className="text-zinc-500 text-sm">Sign in using the button in the top right to get started.</p>
        </div>
      )}

      {/* Signed-in stats */}
      {user && (
        <ErrorBoundary>
          <UserStats userId={user.id} />
        </ErrorBoundary>
      )}

      {/* Suggested users — shown when signed in but not following anyone */}
      {user && !hasFollows && (
        <ErrorBoundary>
          <SuggestedUsers currentUserId={user.id} />
        </ErrorBoundary>
      )}

      <ErrorBoundary>
        <ActivityFeed currentUserId={user?.id} />
      </ErrorBoundary>
    </div>
  );
}
