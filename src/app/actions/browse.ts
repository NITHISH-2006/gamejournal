'use server';

import { createPublicClient } from '@/lib/supabase';
import { enforce } from '@/lib/rate-limit';
import { clientKey } from '@/lib/rate-limit';
import { headers } from 'next/headers';
import type { LogStatus } from '@/lib/types';

/**
 * Filterable browse.
 *
 * `/discover` previously offered two fixed leaderboards and nothing else, so
 * there was no way to answer "what did people rate highly *this* year" or "what
 * are the most-used co-op tags".
 *
 * ── Why this is a SQL function rather than a PostgREST query ──────────────────
 *
 * The previous implementation selected log rows, embedded the parent game, and
 * aggregated per game in JavaScript. Three things were wrong with it:
 *
 *  1. `total` was `sorted.length` — the number of games in the *fetched window*,
 *     not the number matching the filter. Page 2 of a 200-result filter displayed
 *     "48 games".
 *
 *  2. Sorting and paging happened in JS over an already-fetched set, so paging
 *     could not work at all. `.order(created_at).limit(offset + limit + 1)` sorted
 *     by log time, then the rows were grouped and re-sorted by rating — so page 2
 *     was the second *chunk of log rows*, sliced to 24, not the second page of
 *     the rating order. The order was also unstable between pages because the
 *     grouping depended on which rows happened to be in the window.
 *
 *  3. `minLogs` was a client-side `.filter()` over a bounded window, and
 *     `minRating` was a `.gte()` on individual log rows. So "average rating
 *     above 7" actually meant "games with *any* log rated 7 or above" and
 *     "at least 10 logs" only counted the logs that had been fetched.
 *
 * All three are aggregation-and-paging problems, and they need to be solved
 * where the data lives. Migration 005 adds `browse_games` and
 * `browse_games_count`.
 *
 * Rate limited like the rest of the read surface: this is a `'use server'`
 * export, so it is a publicly reachable POST endpoint, and it is the most
 * expensive query in the application.
 */

export type BrowseSort = 'recent' | 'rating' | 'most_logged' | 'discussed';

export type BrowseFilters = {
  status?: LogStatus | null;
  /** Minimum average rating, 0–10. */
  minRating?: number | null;
  tag?: string | null;
  /** Release year of the game. */
  year?: number | null;
  /** Only games with at least this many logs. */
  minLogs?: number | null;
  sort?: BrowseSort;
  limit?: number;
  offset?: number;
};

export type BrowseHit = {
  gameId: number;
  name: string;
  coverUrl: string | null;
  releaseYear: number | null;
  avgRating: number | null;
  logCount: number;
  reviewCount: number;
  lastActivity: string | null;
};

const PAGE_SIZE = 24;
const MAX_OFFSET = 4800;

/**
 * Applies the filters and returns one page plus an exact total.
 *
 * Both numbers come from SQL now, so `total` is the real number of matching
 * games rather than the size of the fetched window.
 */
export async function browseGames(filters: BrowseFilters = {}) {
  await enforce(`browse:ip:${clientKey(await headers())}`, 60, 60_000);

  const supabase = createPublicClient();

  const limit = Number.isFinite(filters.limit)
    ? Math.min(Math.max(filters.limit ?? PAGE_SIZE, 1), 48)
    : PAGE_SIZE;

  const offset = Number.isFinite(filters.offset)
    ? Math.min(Math.max(filters.offset ?? 0, 0), MAX_OFFSET)
    : 0;

  /**
   * Clamped here as well as in SQL.
   *
   * The SQL function repeats the clamp, because the function is callable by
   * anyone with the anon key and must not trust its arguments. Clamping only in
   * SQL would leave the *client* sending a negative offset that the function
   * silently corrects, so the two agree deliberately rather than by luck.
   */
  const minRating = Number.isFinite(filters.minRating)
    ? Math.min(Math.max(filters.minRating ?? 0, 0), 10)
    : 0;

  const minLogs = Number.isFinite(filters.minLogs)
    ? Math.min(Math.max(filters.minLogs ?? 0, 0), 500)
    : 0;

  /**
   * Length-clamped before it reaches the `tags @> array[...]` containment test.
   *
   * Previously `filters.tag` went into `.contains('tags', [tag])` with no
   * validation at all, so the caller fully controlled an array operand to a GIN
   * index scan.
   */
  const tag = normalizeTag(filters.tag);

  const year = Number.isFinite(filters.year)
    ? Math.min(Math.max(filters.year ?? 0, 1970), 2100)
    : null;

  const status = isStatus(filters.status) ? filters.status : null;
  const sort = filters.sort ?? 'recent';

  const args = {
    p_status: status,
    p_min_rating: minRating > 0 ? minRating : null,
    p_tag: tag,
    p_year: year,
    p_min_logs: minLogs > 0 ? minLogs : null,
  };

  const { data, error } = await supabase.rpc('browse_games', {
    ...args,
    p_sort: sort,
    p_limit: limit,
    p_offset: offset,
  });

  if (error) {
    console.error('[discover] browseGames error:', error.message);
    return { hits: [] as BrowseHit[], total: 0, offset };
  }

  /*
   * The count is a separate call because PostgREST cannot return a scalar and a
   * result set from one round trip. It is issued concurrently with nothing
   * else, so the extra latency is one query, and it is only skipped when the
   * page came back empty — where the answer is trivially zero and the user is
   * about to be told the same thing.
   */
  const total =
    !data || data.length === 0
      ? 0
      : await countMatching(supabase, args);

  const hits: BrowseHit[] = (data ?? []).map((row) => ({
    gameId: row.game_id,
    name: row.name,
    coverUrl: row.cover_url,
    releaseYear: row.release_year,
    avgRating: row.avg_rating,
    logCount: row.log_count,
    reviewCount: row.review_count,
    lastActivity: row.last_activity,
  }));

  return { hits, total, offset };
}

/**
 * The exact number of games matching the filters.
 *
 * A failed count returns `0`, which is indistinguishable from "no results" to
 * the caller. That is a real ambiguity, so it is logged rather than papered
 * over: the page above is non-empty, so a `0` here means the count query failed,
 * not that the filter matched nothing.
 */
async function countMatching(
  supabase: ReturnType<typeof createPublicClient>,
  args: {
    p_status: string | null;
    p_min_rating: number | null;
    p_tag: string | null;
    p_year: number | null;
    p_min_logs: number | null;
  }
): Promise<number> {
  const { data, error } = await supabase.rpc('browse_games_count', args);

  if (error) {
    console.error('[discover] browse_games_count error:', error.message);
    return 0;
  }

  // The function returns a scalar `bigint`, so `data` is the number itself.
  // Reading it as a row array yields `undefined`, and `?? 0` then reports every
  // filter as empty.
  return typeof data === 'number' ? data : 0;
}

/**
 * Normalises a tag filter, or rejects it.
 *
 * Returns `null` for anything that is not a plausible tag. Returning `null`
 * rather than throwing is deliberate: a malformed filter should widen the
 * result set, not produce an error page. Tags are free text on the log, so the
 * only reliable validation is shape.
 */
function normalizeTag(value: string | null | undefined): string | null {
  if (!value) return null;

  const tag = value.trim().toLowerCase();

  // Empty after trimming.
  if (tag.length === 0) return null;

  // Beyond this length it is not a tag, it is an attempt at a heavy GIN scan.
  if (tag.length > 32) return null;

  // Only word characters and spaces. Rejects `%`, `_`, `*` and quotes, which
  // have no meaning in a tag and are the characters a `like`/`similar to`
  // interpretation would treat as wildcards.
  if (!/^[\p{L}\p{N} _-]+$/u.test(tag)) return null;

  return tag;
}

function isStatus(value: unknown): value is LogStatus {
  return (
    value === 'backlog' ||
    value === 'playing' ||
    value === 'completed' ||
    value === 'abandoned'
  );
}

/**
 * The tags actually in use, with counts.
 *
 * Computed by `get_popular_tags` in SQL with `unnest` over the tag array, rather
 * than by fetching up to 1000 log rows and counting in JavaScript — which is what
 * the old trending fallback did, so the counts were a sample of the most recent
 * logs presented next to each tag as though they were global.
 */
export async function getPopularTags(limit = 16): Promise<{ tag: string; count: number }[]> {
  await enforce(`browse:ip:${clientKey(await headers())}`, 30, 60_000);

  const supabase = createPublicClient();
  const capped = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 40) : 16;

  const { data, error } = await supabase.rpc('get_popular_tags', { p_limit: capped });

  if (error) {
    console.error('[discover] getPopularTags error:', error.message);
    return [];
  }

  return (data ?? []).map((row) => ({ tag: row.tag, count: row.count }));
}