import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Bookmark, Gamepad2, CheckCircle2, PlayCircle, Star, Heart, PlusCircle } from 'lucide-react';
import { createClient, getUser } from '@/lib/supabase';
import { getUserStats } from '@/app/actions/discover';
import { getFollowCounts } from '@/app/actions/follows';
import { getUserLists } from '@/app/actions/lists';
import { getOwnProfile } from '@/app/actions/profiles';
import { getCapabilities } from '@/lib/capabilities';
import CreateListModal from '@/components/CreateListModal';
import EditProfileForm from '@/components/EditProfileForm';
import StatsPanel from '@/components/StatsPanel';
import ActivityHeatmap from '@/components/ActivityHeatmap';
import LibraryImport from '@/components/LibraryImport';
import FollowList from '@/components/FollowList';
import LogActions from '@/components/LogActions';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/EmptyState';
import { StarRating } from '@/components/StarRating';
import {
  GameCover,
  StatusPill,
  TagChip,
  ReviewText,
  StatTile,
  ProfileAvatar,
} from '@/components/ui-primitives';
import { formatDate, formatMonthYear } from '@/lib/date';
import type { LogStatus } from '@/lib/types';

export const metadata: Metadata = {
  title: 'Your library',
  robots: { index: false, follow: false },
};

type ProfileLog = {
  id: string;
  game_id: number;
  status: LogStatus;
  rating: number;
  review: string | null;
  created_at: string;
  diary_date: string | null;
  tags: string[] | null;
  // NOT NULL DEFAULT false. Non-optional on purpose — see the note in
  // `user/[username]/page.tsx`: when this was optional, leaving it out of the
  // select was a type error the compiler could not report, and the symptom was
  // spoiler reviews rendering in the open.
  has_spoilers: boolean;
  is_favorite?: boolean | null;
  playtime_hours?: number | null;
  games: { name: string; cover_url?: string | null } | null;
};

export default async function ProfilePage() {
  const user = await getUser();
  if (!user) redirect('/');

  const supabase = await createClient();
  const [logsResult, stats, followCounts, lists, caps, profile] = await Promise.all([
    supabase
      .from('game_logs')
      .select(
        'id, game_id, status, rating, review, created_at, diary_date, tags, is_favorite, has_spoilers, playtime_hours, games ( name, cover_url )'
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50),
    getUserStats(user.id).catch(() => null),
    getFollowCounts(user.id).catch(() => ({ followers: 0, following: 0 })),
    getUserLists(user.id, { includePrivate: true }).catch(() => []),
    getCapabilities(),
    // The authoritative profile row. `user.user_metadata.username` is written
    // once at signup and never updated, so seeding the edit form from it made
    // the form re-submit the OLD handle and silently undo a rename.
    getOwnProfile().catch(() => null),
  ]);

  const logs = (logsResult.data ?? []) as unknown as ProfileLog[];
  const covers = logs.filter((l) => l.games?.cover_url);

  const tiles = [
    { label: 'Logged', value: stats?.total ?? logs.length, icon: <Gamepad2 className="size-4" /> },
    { label: 'Completed', value: stats?.completed ?? 0, icon: <CheckCircle2 className="size-4 text-emerald-400" /> },
    { label: 'Playing', value: stats?.playing ?? 0, icon: <PlayCircle className="size-4 text-sky-400" /> },
    { label: 'Backlog', value: stats?.backlog ?? 0, icon: <Bookmark className="size-4" /> },
    {
      label: 'Avg Rating',
      value: stats?.avgRating != null ? stats.avgRating.toFixed(1) : '--',
      hint: stats?.avgRating != null ? 'out of 10' : undefined,
      icon: <Star className="size-4 text-amber-400" />,
      accent: true,
    },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-10 px-4 sm:px-6">
      {/* Header */}
      <header className="glass mt-8 flex flex-col gap-5 rounded-3xl p-6 sm:flex-row sm:items-start sm:p-8">
        <ProfileAvatar
          username={profile?.username ?? user.email ?? 'you'}
          avatarUrl={profile?.avatar_url}
          size={80}
          className="ring-2 ring-white/15"
        />

        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium tracking-wider text-brand uppercase">
            Your library
          </p>
          <h1 className="mt-1 truncate font-heading text-2xl font-bold tracking-tight">
            {profile?.display_name || profile?.username || user.email}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            @{profile?.username ?? '—'} · Member since{' '}
            {formatMonthYear(user.created_at)}
          </p>

          <div className="mt-3 flex flex-wrap gap-4 text-sm text-muted-foreground">
            <span>
              <strong className="text-foreground">{followCounts.followers}</strong>{' '}
              {followCounts.followers === 1 ? 'follower' : 'followers'}
            </span>
            <span>
              <strong className="text-foreground">{followCounts.following}</strong>{' '}
              following
            </span>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <EditProfileForm
              username={profile?.username ?? user.user_metadata?.username ?? ''}
              displayName={profile?.display_name ?? null}
              bio={profile?.bio ?? null}
              email={user.email ?? ''}
            />
            <Link href="/discover">
              <Card className="glass-subtle inline-flex h-9 cursor-pointer items-center gap-2 px-4 text-sm transition-colors hover:bg-white/8">
                <PlusCircle className="size-4 text-brand" />
                Find players
              </Card>
            </Link>
          </div>
        </div>
      </header>

      {/* Stats */}
      <StatsPanel userId={user.id} ownerName="your" />

      {/* Activity pattern. Renders nothing when migration 004 is not applied,
          because an empty grid would read as "you never play". */}
      <ActivityHeatmap userId={user.id} />

      {/* Social graph */}
      <FollowList
        userId={user.id}
        followerCount={followCounts.followers}
        followingCount={followCounts.following}
      />

      {/* Onboarding. Importing an existing library is the difference between a
          tracker people adopt and one they abandon after adding four games. */}
      <LibraryImport />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((tile) => (
          <StatTile key={tile.label} {...tile} />
        ))}
      </section>

      {/* Cover wall */}
      {covers.length > 0 && (
        <section>
          <h2 className="mb-4 font-heading text-lg font-bold tracking-tight">
            Your shelf
            {/* The fetch is capped at 50, so the count has to say so rather than
                implying the shelf ends there. */}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({covers.length === 50 ? '50 most recent' : covers.length})
            </span>
          </h2>
          <div className="grid grid-cols-4 gap-2.5 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
            {covers.slice(0, 40).map((log) => (
              <Link
                key={log.id}
                href={`/game/${log.game_id}`}
                className="group relative block aspect-[3/4] overflow-hidden rounded-lg"
                title={log.games!.name}
              >
                <GameCover
                  src={log.games!.cover_url}
                  alt={log.games!.name}
                  className="transition-transform duration-300 group-hover:scale-110"
                  sizes="(max-width: 640px) 25vw, 10vw"
                />
                <span
                  className="pointer-events-none absolute inset-0 rounded-lg ring-1 ring-white/8 ring-inset"
                  aria-hidden="true"
                />
                {caps.logFavorite && log.is_favorite && (
                  <Heart
                    className="absolute top-1 right-1 size-3 fill-rose-400 text-rose-400 drop-shadow"
                    aria-label="Favourite"
                  />
                )}
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Lists */}
      <section>
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="font-heading text-lg font-bold tracking-tight">Lists</h2>
          <CreateListModal />
        </div>

        {lists.length === 0 ? (
          <EmptyState
            compact
            icon={Bookmark}
            title="No lists yet"
            description="Group games into collections like best-of lists or a plan to play."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {lists.map((list) => (
              <Link key={list.id} href={`/list/${list.id}`}>
                <Card className="group h-full p-5 transition-all duration-300 hover:border-white/20">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-heading font-semibold transition-colors group-hover:text-brand">
                      {list.name}
                    </p>
                    <span className="shrink-0 rounded-full bg-white/6 px-2 py-0.5 text-[0.65rem] text-muted-foreground">
                      {list.is_public ? 'Public' : 'Private'}
                    </span>
                  </div>
                  {list.description && (
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {list.description}
                    </p>
                  )}
                  <p className="mt-3 text-xs text-ink-muted">
                    {list.games.length}{' '}
                    {list.games.length === 1 ? 'game' : 'games'}
                  </p>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* All logs */}
      <section>
        <h2 className="mb-4 font-heading text-lg font-bold tracking-tight">
          All logs
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            ({logs.length})
          </span>
        </h2>

        {logs.length === 0 ? (
          <EmptyState
            icon={Gamepad2}
            title="Your journal is empty"
            description="Log the first game you have played to get started."
            actionLabel="Log a game"
            actionHref="/?log=1"
          />
        ) : (
          <div className="space-y-3">
            {logs.map((log, index) => (
              <Card
                key={log.id}
                className="animate-stagger"
                style={{ animationDelay: `${Math.min(index, 10) * 35}ms` }}
              >
                <div className="flex gap-4 p-4">
                  <Link
                    href={`/game/${log.game_id}`}
                    className="group relative block aspect-[3/4] w-14 shrink-0 overflow-hidden rounded-lg"
                  >
                    <GameCover
                      src={log.games?.cover_url}
                      alt={log.games?.name ?? 'Game'}
                      className="transition-transform duration-300 group-hover:scale-105"
                    />
                  </Link>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/game/${log.game_id}`}
                            className="truncate font-semibold transition-colors hover:text-brand"
                          >
                            {log.games?.name ?? 'Unknown game'}
                          </Link>
                          <StatusPill status={log.status} size="xs" />
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <StarRating value={log.rating} size="xs" />
                          <span className="text-xs text-muted-foreground">
                            {log.rating}/10
                          </span>
                          <span className="text-xs text-ink-faint">
                            {formatDate(log.diary_date ?? log.created_at)}
                          </span>
                        </div>
                      </div>
                      <LogActions log={log} gameId={log.game_id} />
                    </div>

                    {log.review && (
                      <ReviewText
                      text={log.review}
                      hasSpoilers={Boolean(log.has_spoilers)}
                      className="mt-2 line-clamp-2"
                    />
                    )}

                    {log.tags && log.tags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {log.tags.map((tag) => (
                          <TagChip key={tag} tag={tag} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
