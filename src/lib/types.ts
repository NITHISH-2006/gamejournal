/** Shared domain types used across Server Components, Server Actions and UI. */

export const LOG_STATUSES = [
  'backlog',
  'playing',
  'completed',
  'abandoned',
] as const;

export type LogStatus = (typeof LOG_STATUSES)[number];

export function isLogStatus(value: unknown): value is LogStatus {
  return (
    typeof value === 'string' &&
    (LOG_STATUSES as readonly string[]).includes(value)
  );
}

export const STATUS_META: Record<
  LogStatus,
  { label: string; dot: string; chip: string; description: string }
> = {
  playing: {
    label: 'Playing',
    dot: 'bg-sky-400',
    chip: 'bg-sky-500/15 text-sky-300 ring-sky-400/30',
    description: 'Currently playing',
  },
  completed: {
    label: 'Completed',
    dot: 'bg-emerald-400',
    chip: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30',
    description: 'Finished it',
  },
  backlog: {
    label: 'Backlog',
    dot: 'bg-zinc-400',
    chip: 'bg-zinc-400/15 text-zinc-300 ring-zinc-400/30',
    description: 'Want to play',
  },
  abandoned: {
    label: 'Abandoned',
    dot: 'bg-rose-400',
    chip: 'bg-rose-500/15 text-rose-300 ring-rose-400/30',
    description: 'Gave up on it',
  },
};

export type Game = {
  id: number;
  name: string;
  cover_url?: string | null;
  release_date?: string | null;
  summary?: string | null;
};

export type FeedLog = {
  id: string;
  game_id: number;
  user_id: string;
  status: LogStatus;
  rating: number;
  review: string | null;
  diary_date: string | null;
  tags: string[] | null;
  created_at: string;
  game_name: string;
  game_cover: string | null;
  username: string | null;
  /**
   * The author marked this review as containing spoilers.
   *
   * This was written to the database and offered in the UI but never selected
   * by any query, and `ReviewText` was called with `hasSpoilers={false}`
   * everywhere — so a spoiler was rendered in full on the feed, on profiles and
   * inside a publicly cacheable OG image. Now selected and honoured.
   */
  has_spoilers?: boolean | null;
  is_favorite?: boolean | null;
  playtime_hours?: number | null;
  liked_by_me?: boolean;
  like_count?: number;
};

export type Profile = {
  id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  bio?: string | null;
  created_at: string;
};

export type UserList = {
  id: string;
  name: string;
  description: string | null;
  is_public: boolean;
  created_at: string;
  games: { gameId: number; name: string; coverUrl: string | null }[];
};

export type UserNotification = {
  id: string;
  // 'comment' was missing from this union even though the DB enum has always
  // contained it, so a comment notification cast into this type fell outside
  // the union and rendered with a follow icon.
  type: 'like' | 'follow' | 'comment' | 'mention';
  read: boolean;
  created_at: string;
  actor_username: string | null;
  log_id: string | null;
  /** Lets the bell link to /game/<id> instead of dead-ending on /discover. */
  game_id: number | null;
  game_name: string | null;
};

export type FeedMode = 'global' | 'following' | 'trending';

/**
 * Removed: `LOG_SELECT`.
 *
 * It had no importers, so it was dead — but it was also a landmine. It omitted
 * `has_spoilers` from the projection, and `FeedLog.has_spoilers` is documented
 * immediately above as the flag that exists to stop a spoiler review being
 * rendered in full. The first person to reach for the shared "canonical log
 * projection" constant would have reintroduced exactly that bug, and TypeScript
 * would not have complained because the field is nullable.
 *
 * `src/app/actions/feed.ts` now owns its own projections explicitly, and
 * `src/lib/capabilities.ts` selects the columns it needs at the call site.
 */
