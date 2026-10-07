'use server';

import { createPublicClient } from '@/lib/supabase';
import { validateUuid } from '@/lib/validation';
import { enforce } from '@/lib/rate-limit';
import { callerKey } from '@/lib/limiter';

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
 *
 * Every action in this file is rate limited. They read public data, so this is
 * not about confidentiality — it is that all four are genuinely expensive
 * (`get_user_activity_stats` runs six CTEs including a window function over
 * every distinct active day; `get_year_in_review` joins and aggregates three
 * `jsonb_agg`s; `search_reviews` is a full-text scan over `review_tsv`), and
 * a `'use server'` export is a publicly reachable POST endpoint. They were the
 * only unmetered operations in an application where every *write* was limited.
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
  await enforce(await callerKey('stats:activity'), 60, 60_000);

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
  await enforce(await callerKey('stats:history'), 60, 60_000);

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
  await enforce(await callerKey('stats:year'), 30, 60_000);

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

  // Tightest limit in the app: this is a full-text search and it is reachable
  // without authentication.
  await enforce(await callerKey('stats:search'), 20, 60_000);

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

/* ---------------------------------------------------------------------------
 * Activity heatmap and session summaries (migration 004)
 * ------------------------------------------------------------------------ */

/**
 * Per-day activity, for a contribution-style grid.
 *
 * Separate from `getActivityStats` because the two answer different questions at
 * very different costs: this one returns up to `days` rows where the streaks
 * query returns a single row, and the dashboard strip should not inherit the
 * heatmap's cost.
 *
 * The series is dense — every day in the window, including zeroes. A sparse
 * series would leave the client to infer the gaps, and a missing day is
 * indistinguishable from an unrendered one.
 */
export type HeatmapDay = { day: string; logs: number; minutes: number };

export async function getActivityHeatmap(
  userId: unknown,
  days = 365
): Promise<HeatmapDay[] | null> {
  const id = validateUuid(userId, 'user id');
  await enforce(await callerKey('stats:heatmap'), 60, 60_000);

  // Clamped here as well as in SQL. The SQL clamp is the guarantee; this avoids
  // asking the database for a year when the caller wanted a fortnight.
  const span = Number.isFinite(days) ? Math.min(Math.max(days, 7), 1460) : 365;

  const supabase = createPublicClient();
  const { data, error } = await supabase.rpc('get_user_activity_heatmap', {
    p_user_id: id,
    p_days: span,
  });

  if (error) {
    // Pre-004 database. The caller renders nothing rather than an empty grid,
    // because a grid of zeroes reads as "this player never plays".
    console.error('[stats] getActivityHeatmap error:', error.message);
    return null;
  }

  return (data ?? []).map((r) => ({
    day: r.day,
    logs: Number(r.logs ?? 0),
    minutes: Number(r.minutes ?? 0),
  }));
}

/** Session rollup for one log. Null when the RPC is not installed. */
export async function getSessionsSummary(
  logId: unknown
): Promise<{ sessionCount: number; totalHours: number; lastPlayed: string | null } | null> {
  const id = validateUuid(logId, 'log id');
  await enforce(await callerKey('stats:sessions'), 60, 60_000);

  const supabase = createPublicClient();
  const { data, error } = await supabase.rpc('get_game_sessions_summary', {
    p_log_id: id,
  });

  if (error) {
    console.error('[stats] getSessionsSummary error:', error.message);
    return null;
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { sessionCount: 0, totalHours: 0, lastPlayed: null };

  return {
    sessionCount: Number(row.session_count ?? 0),
    totalHours: Number(row.total_hours ?? 0),
    lastPlayed: row.last_played ?? null,
  };
}
