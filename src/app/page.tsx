import Link from 'next/link';
import { createClient, getUser } from '@/lib/supabase';
import { getOwnProfile } from '@/app/actions/profiles';
import { getSiteStats } from '@/app/actions/discover';
import { getFeedData } from '@/app/actions/feed';
import { getLikesForLogs } from '@/app/actions/likes';
import ActivityFeed from '@/components/ActivityFeed';
import UserStats from '@/components/UserStats';
import ErrorBoundary from '@/components/ErrorBoundary';
import SuggestedUsers from '@/components/SuggestedUsers';
import LogGameModal from '@/components/LogGameModal';
import type { FeedLog } from '@/lib/types';
import { Gamepad2, Compass, Sparkles, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default async function Home() {
  const user = await getUser();

  const [hasFollows, stats, profile, feed] = await Promise.all([
    user ? userFollowsAnyone(user.id) : Promise.resolve(false),
    getSiteStats().catch(() => ({ logs: 0, users: 0, games: 0 })),
    user ? getOwnProfile().catch(() => null) : Promise.resolve(null),
    // The first page of the feed is fetched here, on the server, and handed to
    // <ActivityFeed />. Previously the component started empty and called a
    // Server Action from a useEffect on mount, which failed outright (the
    // component hydrates inside a streamed <Suspense> subtree, and an action
    // fired from that hydration returned an unparseable response) and left the
    // app's main content surface invisible to crawlers and no-JS visitors.
    getFeedData('global', { limit: 20 }).catch(() => ({
      logs: [] as FeedLog[],
      nextCursor: null,
    })),
  ]);

  // Like state for the first page, resolved server-side in the same round trip
  // shape the component already expects.
  const likeMap = feed.logs.length
    ? await getLikesForLogs(feed.logs.map((l) => l.id)).catch(() => ({}))
    : {};

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6">
      {!user ? (
        <Hero stats={stats} />
      ) : (
        <WelcomeHeader username={profile?.username ?? null} />
      )}

      <div className="space-y-8 py-8">
        {user && (
          <ErrorBoundary label="Your statistics" resetKey="stats">
            <UserStats userId={user.id} />
          </ErrorBoundary>
        )}

        {user && !hasFollows && (
          <ErrorBoundary label="Suggested players" resetKey="suggested">
            <SuggestedUsers currentUserId={user.id} />
          </ErrorBoundary>
        )}

        <ErrorBoundary label="Activity feed" resetKey="feed">
          <ActivityFeed
            currentUserId={user?.id}
            initialLogs={feed.logs}
            initialCursor={feed.nextCursor}
            initialLikes={likeMap}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}

function Hero({ stats }: { stats: { logs: number; games: number; users: number } }) {
  return (
    <section className="glass relative mt-8 overflow-hidden rounded-3xl px-6 py-14 text-center sm:px-10">
      <div
        className="pointer-events-none absolute -top-24 left-1/2 size-64 -translate-x-1/2 rounded-full opacity-40 blur-3xl"
        style={{ background: 'var(--brand)' }}
        aria-hidden="true"
      />

      <div className="relative">
        <span className="brand-gradient mx-auto mb-6 flex size-16 items-center justify-center rounded-2xl shadow-[0_10px_36px_-8px_var(--brand)]">
          <Gamepad2 className="size-8 text-white" />
        </span>

        <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">
          Track every game{' '}
          <span className="text-gradient">you play</span>
        </h1>

        <p className="mx-auto mt-4 max-w-lg text-pretty text-muted-foreground">
          Log what you are playing, rate it out of ten, write a review, and see
          what your friends picked up this week.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <LogGameModal />
          <Link href="/discover">
            <Button variant="glass" size="lg">
              <Compass />
              Explore games
            </Button>
          </Link>
        </div>

        {stats.logs > 0 && (
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm">
            <Stat value={stats.logs} label="logs written" />
            <Stat value={stats.games} label="games tracked" />
            <Stat value={stats.users} label="players" />
          </div>
        )}
      </div>
    </section>
  );
}

function WelcomeHeader({ username }: { username: string | null }) {
  return (
    <section className="mt-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="flex items-center gap-1.5 text-xs font-medium tracking-wider text-brand uppercase">
          <Sparkles className="size-3" />
          Welcome back
        </p>
        <h1 className="mt-1 font-heading text-3xl font-bold tracking-tight">
          Your activity
        </h1>
      </div>
      {username && (
        <Link
          href={`/user/${username}`}
          className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          View your public profile
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      )}
    </section>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-gradient text-xl font-bold tabular-nums">
        {value.toLocaleString()}
      </span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

/** True when the user follows at least one account. */
async function userFollowsAnyone(userId: string): Promise<boolean> {
  const supabase = await createClient();
  const { count } = await supabase
    .from('follows')
    .select('*', { count: 'exact', head: true })
    .eq('follower_id', userId);
  return (count ?? 0) > 0;
}
