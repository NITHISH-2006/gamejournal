import { createClient } from '@/lib/supabase';
import ActivityFeed from '@/components/ActivityFeed';
import UserStats from '@/components/UserStats';
import ErrorBoundary from '@/components/ErrorBoundary';

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      {!user ? (
        <div className="mb-10 p-10 rounded-2xl border border-zinc-800 bg-zinc-900 text-center">
          <h2 className="text-3xl font-bold mb-2">Track every game you play.</h2>
          <p className="text-zinc-400">Log games, rate them, write reviews, and see what your friends are playing.</p>
        </div>
      ) : (
        <ErrorBoundary>
          <UserStats userId={user.id} />
        </ErrorBoundary>
      )}
      <ErrorBoundary>
        <ActivityFeed currentUserId={user?.id} />
      </ErrorBoundary>
    </div>
  );
}
