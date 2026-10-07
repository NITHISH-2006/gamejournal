'use server';

import { createPublicClient } from '@/lib/supabase';
import { validateUuid } from '@/lib/validation';

/**
 * Player analytics for the profile page.
 *
 * Everything here is computed in SQL by functions added in
 * `supabase/migrations/002_fixes_and_features.sql`. The previous
 * `getUserStats` fetched every rated log and averaged it in JavaScript, which
 * meant that once a user passed PostgREST's 1000-row cap the average was
 * silently computed from an arbitrary subset — a wrong number rather than a
 * rounded one, while the doc comment claimed the cost was constant.
 *
 * `get_user_activity_stats` is one row-returning function, so the whole
 * dashboard strip is a single round trip.
 */

export type ActivityStats = {
  totalLogs: number;
  ratedLogs: number;
  reviewCount: number;
  completed: number;
  playing: number;
  backlog: number;
  abandoned: number;
  favorites: number;
  totalPlaytime: number;
  avgRating: number | null;
  distinctGames: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  thisYear: number;
  lastLoggedAt: string | null;
};

export async function getActivityStats(
  userId: unknown
): Promise<ActivityStats | null> {
  const id = validateUuid(userId, 'user id');

  const supabase = createPublicClient();
  const { data, error } = await supabase.rpc('get_user_activity_stats', {
    p_user_id: id,
  });

  if (error) {
    // Pre-002 database. The caller degrades rather than showing zeros.
    console.error('[stats] getActivityStats error:', error.message);
    return null;
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | null;
  if (!row) return null;

  return {
    totalLogs: num(row.total_logs),
    ratedLogs: num(row.rated_logs),
    reviewCount: num(row.review_count),
    completed: num(row.completed),
    playing: num(row.playing),
    backlog: num(row.backlog),
    abandoned: num(row.abandoned),
    favorites: num(row.favorites),
    totalPlaytime: num(row.total_playtime),
    avgRating: row.avg_rating == null ? null : numOrNull(row.avg_rating),
    distinctGames: num(row.distinct_games),
    activeDays: num(row.active_days),
    currentStreak: num(row.current_streak),
    longestStreak: num(row.longest_streak),
    thisYear: num(row.this_year),
    lastLoggedAt:
      typeof row.last_logged_at === 'string' ? row.last_logged_at : null,
  };
}

export type LogHistoryPoint = {
  month: string;
  logs: number;
  completed: number;
  hours: number;
};

/** Monthly volume for the activity sparkline. */
export async function getLogHistory(
  userId: unknown,
  months = 12
): Promise<LogHistoryPoint[]> {
  const id = validateUuid(userId, 'user id');
  const span = Number.isFinite(months) ? Math.min(Math.max(months, 1), 36) : 12;

  const supabase = createPublicClient();
  const { data, error } = await supabase.rpc('get_user_log_history', {
    p_user_id: id,
    p_months: span,
  });

  if (error) {
    console.error('[stats] getLogHistory error:', error.message);
    return [];
  }

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    month: String(r.month),
    logs: num(r.logs),
    completed: num(r.completed),
    hours: num(r.hours),
  }));
}

export type YearInReview = {
  year: number;
  gamesPlayed: number;
  gamesCompleted: number;
  reviewsWritten: number;
  hoursPlayed: number;
  avgRating: number | null;
  favorites: number;
  topRated: {
    game_id: number;
    name: string;
    cover_url: string | null;
    rating: number;
  }[];
  mostPlayed: {
    game_id: number;
    name: string;
    cover_url: string | null;
    logs: number;
  }[];
  statusSplit: Record<string, number>;
};

export async function getYearInReview(
  userId: unknown,
  year?: number
): Promise<YearInReview | null> {
  const id = validateUuid(userId, 'user id');
  const supabase = createPublicClient();

  const { data, error } = await supabase.rpc('get_year_in_review', {
    p_user_id: id,
    p_year: year ?? null,
  });

  if (error) {
    console.error('[stats] getYearInReview error:', error.message);
    return null;
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | null;
  if (!row) return null;

  return {
    year: num(row.year),
    gamesPlayed: num(row.games_played),
    gamesCompleted: num(row.games_completed),
    reviewsWritten: num(row.reviews_written),
    hoursPlayed: num(row.hours_played),
    avgRating: row.avg_rating == null ? null : numOrNull(row.avg_rating),
    favorites: num(row.favorites),
    topRated: (row.top_rated ?? []) as YearInReview['topRated'],
    mostPlayed: (row.most_played ?? []) as YearInReview['mostPlayed'],
    statusSplit: (row.status_split ?? {}) as Record<string, number>,
  };
}

export type SearchHit = {
  game_id: number;
  name: string;
  cover_url: string | null;
  latest_review: string | null;
  match_count: number;
};

/**
 * Full-text review search.
 *
 * Backs the discovery page. `search_logs` in 001 existed but had no caller,
 * no pagination, and built its tsvector inline per row per call; 002 replaces
 * it with an indexed generated column and a real keyset cursor.
 */
export async function searchReviews(
  query: unknown,
  limit = 24,
  cursor?: { matchCount: number; gameId: number } | null
): Promise<{ hits: SearchHit[]; nextCursor: { matchCount: number; gameId: number } | null }> {
  const q = String(query ?? '').trim();
  if (q.length < 2) return { hits: [], nextCursor: null };

  // 47, not 48. A probe row is requested as `p_limit: take + 1`, but the SQL
  // clamps to `least(p_limit, 48)`. With `take = 48` the request sent 49 and
  // could only ever receive 48, so `hasMore = rows.length > take` was
  // `48 > 48` = false and pagination stopped dead at exactly 48 results — the
  // probe row could never arrive at the cap.
  const take = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 47) : 24;

  const supabase = createPublicClient();
  const { data, error } = await supabase.rpc('search_logs', {
    p_query: q,
    p_limit: take + 1,
    p_after_rank: cursor?.matchCount ?? null,
    p_after_game: cursor?.gameId ?? null,
  });

  if (error) {
    console.error('[stats] searchReviews error:', error.message);
    return { hits: [], nextCursor: null };
  }

  const rows = (data ?? []) as SearchHit[];
  const hasMore = rows.length > take;
  const hits = hasMore ? rows.slice(0, take) : rows;
  const last = hits[hits.length - 1];

  return {
    hits,
    nextCursor:
      hasMore && last ? { matchCount: last.match_count, gameId: last.game_id } : null,
  };
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Like `num`, but preserves a genuine null.
 *
 * `avg_rating` means "nobody has rated this", which is different from "rated 0".
 * Collapsing the two would render a real 0 average for an unrated game.
 */
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
