import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Gamepad2, Settings, MessageSquareOff, List } from 'lucide-react';
import { createClient, getUser } from '@/lib/supabase';
import { getProfileByUsername } from '@/app/actions/profiles';
import { getFollowCounts } from '@/app/actions/follows';
import { getUserStats } from '@/app/actions/discover';
import { getUserLists } from '@/app/actions/lists';
import { getFollowStates } from '@/app/actions/follows';
import FollowButton from '@/components/FollowButton';
import StatsPanel from '@/components/StatsPanel';
import ActivityHeatmap from '@/components/ActivityHeatmap';
import FollowList from '@/components/FollowList';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/EmptyState';
import { StarRating } from '@/components/StarRating';
import {
  GameCover,
  StatusPill,
  ProfileAvatar,
  TagChip,
  ReviewText,
  StatTile,
} from '@/components/ui-primitives';
import { formatDate } from '@/lib/date';
import type { LogStatus } from '@/lib/types';

type Params = { params: Promise<{ username: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { username } = await params;
  const profile = await getProfileByUsername(username).catch(() => null);

  if (!profile) {
    return { title: 'Player not found', robots: { index: false } };
  }

  const name = profile.display_name || `@${profile.username}`;
  const description = profile.bio
    ? `${profile.bio} - See what ${name} is playing on GameJournal.`
    : `See what ${name} is playing, rating and reviewing on GameJournal.`;

  return {
    title: name,
    description,
    alternates: { canonical: `/user/${profile.username}` },
    openGraph: { type: 'profile', title: name, description },
    twitter: { card: 'summary', title: name, description },
  };
}

type ProfileLog = {
  id: string;
  game_id: number;
  status: LogStatus;
  rating: number;
  review: string | null;
  created_at: string;
  diary_date: string | null;
  tags: string[] | null;
  // NOT NULL DEFAULT false in the schema. Declared non-optional on purpose:
  // when these were `has_spoilers?: boolean`, omitting the column from the
  // select above type-checked cleanly and every spoiler-flagged review
  // rendered in full on the public profile.
  has_spoilers: boolean;
  is_favorite?: boolean | null;
  games: { name: string; cover_url?: string | null } | null;
};

export default async function UserProfilePage({ params }: Params) {
  const { username } = await params;
  const profile = await getProfileByUsername(username).catch(() => null);
  if (!profile) notFound();

  const currentUser = await getUser();
  const isOwn = currentUser?.id === profile.id;

  const supabase = await createClient();
  const [logsResult, followCounts, stats, lists] = await Promise.all([
    supabase
      .from('game_logs')
      .select('id, game_id, status, rating, review, created_at, diary_date, tags, is_favorite, has_spoilers, playtime_hours, games ( name, cover_url )')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(100),
    getFollowCounts(profile.id).catch(() => ({ followers: 0, following: 0 })),
    getUserStats(profile.id).catch(() => null),
    // Public profiles only ever expose public lists. getUserLists enforces
    // this server-side; the previous page passed the owner's id with no
    // privacy filter and leaked private lists.
    getUserLists(profile.id, { includePrivate: false }).catch(() => []),
  ]);

  const logs = (logsResult.data ?? []) as unknown as ProfileLog[];
  const covers = logs.filter((l) => l.games?.cover_url);
  let following = false;
  if (currentUser && !isOwn) {
    const states: Record<string, boolean> = await getFollowStates([profile.id]).catch(
      () => ({})
    );
    following = states[profile.id] ?? false;
  }

  const displayName = profile.display_name || `@${profile.username}`;

  const tiles = [
    { label: 'Logged', value: stats?.total ?? logs.length, icon: <Gamepad2 className="size-4" /> },
    {
      label: 'Completed',
      value: stats?.completed ?? 0,
      icon: <span className="size-2 rounded-full bg-emerald-400" />,
    },
    {
      label: 'Playing',
      value: stats?.playing ?? 0,
      icon: <span className="size-2 rounded-full bg-sky-400" />,
    },
    {
      label: 'Avg Rating',
      value: stats?.avgRating != null ? stats.avgRating.toFixed(1) : '--',
      icon: <span className="text-amber-400">*</span>,
      accent: true,
    },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-10 px-4 sm:px-6">
      {/* Header */}
      <header className="glass mt-8 flex flex-col gap-5 rounded-3xl p-6 sm:flex-row sm:items-start sm:p-8">
        <ProfileAvatar
          username={profile.username}
          avatarUrl={profile.avatar_url}
          size={80}
          className="ring-2 ring-white/15"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-heading text-2xl font-bold tracking-tight">
              {displayName}
            </h1>
            {profile.display_name && (
              <span className="text-sm text-muted-foreground">
                @{profile.username}
              </span>
            )}
          </div>

          {profile.bio && (
            <p className="mt-2 max-w-xl text-sm text-pretty text-muted-foreground">
              {profile.bio}
            </p>
          )}

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

          <div className="mt-4">
            {isOwn ? (
              <Link
                href="/profile"
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 text-sm transition-colors hover:bg-white/8"
              >
                <Settings className="size-4" />
                Manage your library
              </Link>
            ) : currentUser ? (
              <FollowButton targetUserId={profile.id} initialFollowing={following} />
            ) : (
              <Link
                href="/"
                className="inline-flex h-9 items-center rounded-xl px-4 text-sm text-brand transition-colors hover:underline"
              >
                Sign in to follow
              </Link>
            )}
          </div>
        </div>
      </header>

      {/* Stats */}
      <StatsPanel userId={profile.id} ownerName={profile.display_name || profile.username} />

      {/* Activity pattern. Renders nothing when migration 004 is not applied. */}
      <ActivityHeatmap userId={profile.id} />

      {/* Social graph */}
      <FollowList
        userId={profile.id}
        followerCount={followCounts.followers}
        followingCount={followCounts.following}
      />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((tile) => (
          <StatTile key={tile.label} {...tile} />
        ))}
      </section>

      {/* Shelf */}
      {covers.length > 0 && (
        <section>
          <h2 className="mb-4 font-heading text-lg font-bold tracking-tight">Shelf</h2>
          <div className="grid grid-cols-4 gap-2.5 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
            {covers.slice(0, 30).map((log) => (
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
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Public lists */}
      {lists.length > 0 && (
        <section>
          <h2 className="mb-4 flex items-center gap-2 font-heading text-lg font-bold tracking-tight">
            <List className="size-4 text-brand" />
            Lists
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {lists.map((list) => (
              <Link key={list.id} href={`/list/${list.id}`}>
                <Card className="group h-full p-5 transition-all duration-300 hover:border-white/20">
                  <p className="font-heading font-semibold transition-colors group-hover:text-brand">
                    {list.name}
                  </p>
                  {list.description && (
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {list.description}
                    </p>
                  )}
                  <p className="mt-3 text-xs text-ink-muted">
                    {list.games.length} {list.games.length === 1 ? 'game' : 'games'}
                  </p>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Recent logs */}
      <section>
        <h2 className="mb-4 font-heading text-lg font-bold tracking-tight">
          Recent logs
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            ({logs.length})
          </span>
        </h2>

        {logs.length === 0 ? (
          <EmptyState
            icon={MessageSquareOff}
            title="No logs yet"
            description={`${displayName} has not logged any games yet.`}
          />
        ) : (
          <div className="space-y-3">
            {logs.slice(0, 20).map((log, index) => (
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
