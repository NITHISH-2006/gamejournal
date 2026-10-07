import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Calendar, Users, MessageSquare, TrendingUp, Clock } from 'lucide-react';
import { getGameStats, getGameLogs } from '@/app/actions/discover';
import { getUser } from '@/lib/supabase';
import { getUserLists } from '@/app/actions/lists';
import { getWatchlistMembership } from '@/app/actions/watchlist';
import { validateGameId } from '@/lib/validation';
import { formatDate, formatYear, formatPlaytime } from '@/lib/date';
import { STATUS_META, type LogStatus } from '@/lib/types';
import { getSiteUrl } from '@/lib/env';

import AddToListButton from '@/components/AddToListButton';
import WatchlistButton from '@/components/WatchlistButton';
import LikeButton from '@/components/LikeButton';
import LogGameButton from '@/components/LogGameButton';
import CommentThread from '@/components/CommentThread';
import CollapsibleSessions from '@/components/CollapsibleSessions';
import { getCommentsForLogs, type Comment } from '@/app/actions/comments';
import { getOwnProfile } from '@/app/actions/profiles';
import LogActions from '@/components/LogActions';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
import { MessageCircleOff } from 'lucide-react';

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;

  let gameId: number;
  try {
    gameId = validateGameId(id);
  } catch {
    return { title: 'Game not found' };
  }

  const game = await getGameStats(gameId);
  if (!game) return { title: 'Game not found', robots: { index: false } };

  const summary =
    game.summary?.slice(0, 180) ??
    `See what the community thought of ${game.name} on GameJournal.`;

  const url = `${getSiteUrl()}/game/${gameId}`;

  return {
    title: game.name,
    description: summary,
    alternates: { canonical: `/game/${gameId}` },
    openGraph: {
      type: 'website',
      title: `${game.name} - GameJournal`,
      description: summary,
      url,
      // Prefer the generated 1200x630 card; it renders properly in Discord,
      // Slack and X. The raw cover is 264x374 and appears letterboxed.
      images: [
        {
          url: `${getSiteUrl()}/api/og/game/${gameId}`,
          width: 1200,
          height: 630,
          alt: `${game.name} on GameJournal`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${game.name} - GameJournal`,
      description: summary,
      images: [`${getSiteUrl()}/api/og/game/${gameId}`],
    },
  };
}

export default async function GamePage({ params }: Params) {
  const { id } = await params;

  let gameId: number;
  try {
    gameId = validateGameId(id);
  } catch {
    notFound();
  }

  const [game, user] = await Promise.all([getGameStats(gameId), getUser()]);
  const profile = user ? await getOwnProfile().catch(() => null) : null;

  if (!game) notFound();

  const [logs, lists, watchlist] = await Promise.all([
    getGameLogs(gameId, 50),
    user ? getUserLists(user.id, { includePrivate: true }).catch(() => []) : Promise.resolve([]),
    user ? getWatchlistMembership([gameId]).catch(() => ({})) : Promise.resolve({}),
  ]);

  // One batched query for every thread on the page. Resolving each log's
  // comments individually would be up to 50 round trips per page view.
  const commentsByLog = await getCommentsForLogs(
    logs.map((l) => l.id)
  ).catch(() => ({}) as Record<string, Comment[]>);

  const inWatchlist = Boolean((watchlist as Record<number, boolean>)[gameId]);

  const shapedLists = lists.map((l) => ({
    id: l.id,
    name: l.name,
    is_public: l.is_public,
    list_games: l.games.map((g) => ({ game_id: g.gameId })),
  }));

  const releaseYear = formatYear(game.releaseDate);
  const hasStats = game.ratingCount > 0;

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6">
      {/* Hero */}
      <header className="mt-8 flex flex-col gap-6 sm:flex-row">
        <div className="relative aspect-[3/4] w-36 shrink-0 self-start overflow-hidden rounded-2xl shadow-2xl sm:w-44">
          <GameCover
            src={game.coverUrl}
            alt={game.name}
            className=""
            priority
            sizes="(max-width: 640px) 144px, 176px"
          />
          <span
            className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-white/10 ring-inset"
            aria-hidden="true"
          />
        </div>

        <div className="min-w-0 flex-1">
          <h1 className="text-balance font-heading text-3xl font-bold tracking-tight sm:text-4xl">
            {game.name}
          </h1>

          {releaseYear && (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Calendar className="size-3.5" />
              {releaseYear}
            </p>
          )}

          {hasStats && (
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
              <StarRating
                value={Math.round(game.avgRating ?? 0)}
                size="lg"
                showValue
                count={game.ratingCount}
              />
              <span className="text-sm text-muted-foreground">
                {game.ratingCount} {game.ratingCount === 1 ? 'rating' : 'ratings'}
              </span>
            </div>
          )}

          {/* Status breakdown */}
          {game.watchers > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {Object.entries(game.statusCounts).map(([status, count]) => {
                const meta = STATUS_META[status as LogStatus];
                if (!meta || !count) return null;
                return (
                  <span
                    key={status}
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${meta.chip}`}
                  >
                    <span className={`size-1.5 rounded-full ${meta.dot}`} />
                    {count} {meta.label.toLowerCase()}
                  </span>
                );
              })}
            </div>
          )}

          {game.summary && (
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-pretty text-muted-foreground">
              {game.summary}
            </p>
          )}

          <div className="mt-6 flex flex-wrap gap-2">
            {user ? (
              <>
                <WatchlistButton
                  game={{
                    id: gameId,
                    name: game.name,
                    cover_url: game.coverUrl,
                    release_date: game.releaseDate,
                  }}
                  initialInWatchlist={inWatchlist}
                />
                {shapedLists.length > 0 && (
                  <AddToListButton
                    gameId={gameId}
                    gameName={game.name}
                    lists={shapedLists}
                  />
                )}
                <LogGameButton
                  game={{
                    id: gameId,
                    name: game.name,
                    cover_url: game.coverUrl,
                    release_date: game.releaseDate,
                  }}
                />
              </>
            ) : (
              <Link href="/">
                <Button variant="primary" size="sm">
                  Sign in to log this game
                </Button>
              </Link>
            )}
          </div>
        </div>
      </header>

      {/* Aggregate stats */}
      {game.watchers > 0 && (
        <section
          className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4"
          aria-label="Game statistics"
        >
          <StatTile label="Logged by" value={game.watchers} icon={<Users className="size-4" />} />
          <StatTile
            label="Avg Rating"
            value={game.avgRating != null ? game.avgRating.toFixed(1) : '--'}
            icon={<TrendingUp className="size-4 text-amber-400" />}
            accent
          />
          <StatTile
            label="Reviews"
            value={logs.filter((l) => l.review).length}
            icon={<MessageSquare className="size-4" />}
          />
          <StatTile
            label="Playtime"
            value={formatPlaytime(game.playtimeHours)}
            icon={<Clock className="size-4" />}
          />
        </section>
      )}

      {/* Community logs */}
      <section className="mt-12">
        <div className="mb-5 flex items-baseline justify-between gap-4">
          <h2 className="font-heading text-xl font-bold tracking-tight">
            Community logs
            <span className="ml-2 text-base font-normal text-muted-foreground">
              ({logs.length})
            </span>
          </h2>
        </div>

        {logs.length === 0 ? (
          <EmptyState
            icon={MessageCircleOff}
            title="No logs yet"
            description={
              user
                ? 'Be the first to log this game and share your take.'
                : 'Sign in to log this game and share your take.'
            }
            actionLabel={user ? undefined : 'Sign in'}
            actionHref={user ? undefined : '/'}
          />
        ) : (
          <div className="space-y-3">
            {logs.map((log, index) => (
              <Card
                key={log.id}
                className="animate-stagger p-5"
                style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {log.username ? (
                        <Link
                          href={`/user/${log.username}`}
                          className="inline-flex items-center gap-2 font-medium transition-colors hover:text-brand"
                        >
                          <ProfileAvatar username={log.username} size={24} />
                          <span className="text-sm">@{log.username}</span>
                        </Link>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          anonymous
                        </span>
                      )}
                      <StatusPill status={log.status} size="xs" />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDate(log.diary_date ?? log.created_at)}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {user?.id === log.user_id && <LogActions log={log} gameId={gameId} />}
                    <LikeButton
                      logId={log.id}
                      initialCount={log.like_count}
                      initialLiked={log.liked_by_me}
                      currentUserId={user?.id}
                      size="md"
                    />
                  </div>
                </div>

                <div className="mt-3">
                  <StarRating value={log.rating} size="sm" showValue />
                </div>

                {/* Session history, for the log's owner only. Fetched per-log here
                    rather than for all 50 logs, because it is a per-log affordance
                    and 50 extra round trips on a public page is not a trade worth
                    making. Renders nothing until the owner expands it. */}
                {user?.id === log.user_id && (
                  <CollapsibleSessions logId={log.id} />
                )}

                {log.review && (
                  <ReviewText
                    text={log.review}
                    hasSpoilers={Boolean(log.has_spoilers)}
                    className="mt-3"
                  />
                )}

                {log.tags && log.tags.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {log.tags.map((tag) => (
                      <TagChip key={tag} tag={tag} />
                    ))}
                  </div>
                )}

                <CommentThread
                  logId={log.id}
                  initialComments={commentsByLog[log.id] ?? []}
                  currentUser={
                    user
                      ? {
                          id: user.id,
                          username: profile?.username ?? 'you',
                          avatarUrl: profile?.avatar_url ?? null,
                        }
                      : null
                  }
                />
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
