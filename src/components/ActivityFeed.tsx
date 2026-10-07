'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase';
import { getFeedData } from '@/app/actions/feed';
import { getLikesForLogs } from '@/app/actions/likes';
import { Card } from '@/components/ui/card';
import { formatDate } from '@/lib/date';
import Link from 'next/link';
import {
  CalendarDays,
  Loader2,
  Share2,
  Copy,
  Check,
  Flame,
  Activity,
} from 'lucide-react';
import LikeButton from '@/components/LikeButton';
import { StarRating } from '@/components/StarRating';
import {
  GameCover,
  StatusPill,
  ProfileAvatar,
  TagChip,
  ReviewText,
} from '@/components/ui-primitives';
import { FeedSkeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { SegmentedControl } from '@/components/ui-primitives';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import { STATUS_META, type FeedLog, type FeedMode } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;

const MODES: { value: FeedMode; label: React.ReactNode }[] = [
  { value: 'global', label: 'Global' },
  { value: 'following', label: 'Following' },
  { value: 'trending', label: 'Trending' },
];

/** Extract the log id from a /api/og/log/<id> share URL. */
function logIdFromUrl(url: string): string | null {
  const m = url.match(/\/api\/og\/log\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

export default function ActivityFeed({
  currentUserId,
  initialLogs,
  initialCursor,
  initialLikes,
}: {
  currentUserId?: string;
  /**
   * First page, fetched on the server by the page that renders this.
   *
   * The previous version always started empty and called the `getFeedData`
   * Server Action from a `useEffect` on mount. Two problems:
   *
   *  1. It failed. The component is mounted inside a `<Suspense>` boundary on
   *     the home page, so it hydrates as part of a *streamed, deferred* subtree.
   *     Firing a Server Action from a `useEffect` during that hydration threw
   *     "An unexpected response was received from the server" every time, and
   *     the action body never even executed — confirmed by instrumenting
   *     `getFeedData`, which logged nothing while the client reported failure.
   *
   *  2. Even when it worked, the app's main content surface was 100%
   *     client-rendered: crawlers, no-JS visitors and the initial HTML all saw
   *     an empty skeleton, and the page always showed a loading flash.
   *
   * Server-fetching the first page fixes both. Client actions are still used
   * for tab switches and pagination, which are genuine user interactions.
   */
  initialLogs?: FeedLog[];
  initialCursor?: string | null;
  initialLikes?: Record<string, { count: number; likedByMe: boolean }>;
}) {
  const [logs, setLogs] = useState<FeedLog[]>(initialLogs ?? []);
  const [likes, setLikes] = useState<Record<string, { count: number; likedByMe: boolean }>>(
    initialLikes ?? {}
  );
  // Only genuinely loading when there is no server-provided first page.
  const [loading, setLoading] = useState(initialLogs === undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mode, setMode] = useState<FeedMode>('global');
  const [cursor, setCursor] = useState<string | null>(initialCursor ?? null);
  const [hasMore, setHasMore] = useState(Boolean(initialCursor));
  const [sharedId, setSharedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Memoised in lib/supabase, so this returns the same instance every call.
  const supabase = createBrowserSupabaseClient();
  const { toast } = useToast();

  const loadLikes = useCallback(async (rows: FeedLog[]) => {
    if (!rows.length) {
      setLikes({});
      return;
    }
    const map = await getLikesForLogs(rows.map((l) => l.id)).catch(() => ({}));
    setLikes(map);
  }, []);

  const fetchPage = useCallback(
    async (feedMode: FeedMode, nextCursor: string | null) => {
      try {
        const { logs: data, nextCursor: cursor } = await getFeedData(feedMode, {
          cursor: nextCursor,
          limit: PAGE_SIZE,
        });

        if (nextCursor) {
          setLogs((prev) => [...prev, ...data]);
        } else {
          setLogs(data);
        }
        setCursor(cursor);
        setHasMore(Boolean(cursor));
        await loadLikes(data);
      } catch (err) {
        console.error('[feed] fetch failed:', (err as Error).message);
        if (!nextCursor) setLogs([]);
        toast('Could not load the feed. Please try again.', 'error');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [loadLikes, toast]
  );

  // Reload when the tab changes — but NOT on mount, because the server has
  // already supplied the `global` page. Firing an action on mount is what
  // produced the "unexpected response" failure, and it also threw away the
  // server-rendered content and replaced it with a skeleton.
  //
  // A `useRef` guards the mount so switching tabs still works normally.
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      await fetchPage(mode, null);
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, fetchPage]);

  // Realtime: a single channel, subscribed once and reused across tab changes.
  useEffect(() => {
    const channel = supabase
      .channel('feed_realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'game_logs' },
        (payload: { new: Record<string, unknown> }) => {
          const inserted = payload.new as { user_id?: string } | undefined;
          if (!inserted?.user_id) return;
          // Skip the current user: their own post is already optimistic.
          if (inserted.user_id === currentUserId) return;
          void fetchPage(mode, null);
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, currentUserId, mode, fetchPage]);

  const loadMore = () => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    void fetchPage(mode, cursor);
  };

  const handleShare = async (log: FeedLog) => {
    const shareUrl = `${window.location.origin}/api/og/log/${log.id}`;
    const id = logIdFromUrl(shareUrl) ?? log.id;

    try {
      if (navigator.share) {
        await navigator.share({
          title: `${log.game_name} on GameJournal`,
          text: log.review?.slice(0, 120) || `Check out my ${log.status} log for ${log.game_name}.`,
          url: shareUrl,
        });
        setSharedId(id);
        setTimeout(() => setSharedId(null), 2000);
        return;
      }

      await navigator.clipboard.writeText(shareUrl);
      setCopiedId(log.id);
      setTimeout(() => setCopiedId(null), 2000);
      toast('Share link copied to clipboard');
    } catch {
      // User cancelled the share sheet, or clipboard permission was denied.
    }
  };

  const emptyCopy: Record<FeedMode, { title: string; description: string }> = {
    global: {
      title: 'No activity yet',
      description: 'Be the first to log a game and start the feed.',
    },
    following: currentUserId
      ? {
          title: 'Your following feed is quiet',
          description: 'Follow a few players and their logs will show up here.',
        }
      : {
          title: 'Sign in to see your feed',
          description: 'Follow other players to build a personalised activity feed.',
        },
    trending: {
      title: 'Nothing trending right now',
      description: 'Trending highlights the most logged games over the last few days.',
    },
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-xl font-bold tracking-tight">Activity</h2>
        <SegmentedControl
          value={mode}
          onChange={setMode}
          options={MODES}
          size="sm"
        />
      </div>

      {loading && <FeedSkeleton />}

      {!loading && logs.length === 0 && (
        <EmptyState
          title={emptyCopy[mode].title}
          description={emptyCopy[mode].description}
          actionLabel={currentUserId ? undefined : 'Sign in'}
          actionHref={currentUserId ? undefined : '/'}
          icon={mode === 'trending' ? Flame : Activity}
        />
      )}

      {!loading && logs.length > 0 && (
        <div className="space-y-3">
          {logs.map((log, index) => {
            const likeState = likes[log.id] ?? { count: 0, likedByMe: false };
            return (
              <Card
                key={log.id}
                className="animate-stagger overflow-hidden transition-all duration-300 hover:border-white/15"
                style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
              >
                <article className="flex gap-4 p-4">
                  <Link
                    href={`/game/${log.game_id}`}
                    className="group relative block aspect-[3/4] w-16 shrink-0 overflow-hidden rounded-xl"
                  >
                    <GameCover
                      src={log.game_cover}
                      alt={log.game_name}
                      className="transition-transform duration-300 group-hover:scale-105"
                    />
                    <span className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-white/10 ring-inset" />
                  </Link>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <Link
                            href={`/game/${log.game_id}`}
                            className="truncate font-semibold transition-colors hover:text-brand"
                          >
                            {log.game_name}
                          </Link>
                          <StatusPill status={log.status} size="xs" />
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          {log.username && (
                            <Link
                              href={`/user/${log.username}`}
                              className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
                            >
                              <ProfileAvatar username={log.username} size={16} />
                              @{log.username}
                            </Link>
                          )}
                          {log.username && <span aria-hidden="true">·</span>}
                          <span className="inline-flex items-center gap-1">
                            <CalendarDays className="size-3" aria-hidden="true" />
                            {formatDate(log.diary_date ?? log.created_at)}
                          </span>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => handleShare(log)}
                          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-white/6 hover:text-foreground"
                          aria-label={`Share your log of ${log.game_name}`}
                          title="Share"
                        >
                          {sharedId === log.id || copiedId === log.id ? (
                            <Check className="size-3.5 text-emerald-400" />
                          ) : copiedId === log.id ? (
                            <Copy className="size-3.5" />
                          ) : (
                            <Share2 className="size-3.5" />
                          )}
                        </button>
                        <LikeButton
                          logId={log.id}
                          initialCount={likeState.count}
                          initialLiked={likeState.likedByMe}
                          currentUserId={currentUserId}
                        />
                      </div>
                    </div>

                    <div className="mt-2">
                      <StarRating value={log.rating} size="sm" showValue />
                    </div>

                    {log.review && (
                      <ReviewText
                        text={log.review}
                        hasSpoilers={Boolean(log.has_spoilers)}
                        className="mt-2 line-clamp-3"
                      />
                    )}

                    {log.tags && log.tags.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {log.tags.map((tag) => (
                          <TagChip key={tag} tag={tag} />
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              </Card>
            );
          })}

          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button
                variant="glass"
                onClick={loadMore}
                disabled={loadingMore}
                className="min-w-36"
              >
                {loadingMore ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Loading
                  </>
                ) : (
                  'Load more'
                )}
              </Button>
            </div>
          )}

          {!hasMore && logs.length >= PAGE_SIZE && (
            <p className="pt-2 text-center text-xs text-muted-foreground">
              You are all caught up.
            </p>
          )}
        </div>
      )}

      {/* Status legend, doubles as a colour key for the pills. */}
      {!loading && logs.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2 text-[0.65rem] text-muted-foreground">
          {Object.entries(STATUS_META).map(([key, meta]) => (
            <span key={key} className="inline-flex items-center gap-1.5">
              <span className={cn('size-1.5 rounded-full', meta.dot)} />
              {meta.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
