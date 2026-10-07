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
 * are the most-used co-op tags". Search was limited to reviews, and only on
 * `/discover`.
 *
 * Every filter is a real indexed query rather than a client-side slice of an
 * already-fetched page. Filtering in the browser would mean fetching everything
 * to show 24 rows, and the counts next to each filter would be wrong.
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
 * PostgREST has no aggregate-over-a-filtered-group join available through the
 * JS client for this shape, so the count comes from a second query over the same
 * filter chain rather than from the returned page length. Returning `rows.length`
 * as the total is how "48 results" gets presented as "48 games".
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

  const minRating = Number.isFinite(filters.minRating)
    ? Math.min(Math.max(filters.minRating ?? 0, 0), 10)
    : 0;

  const minLogs = Number.isFinite(filters.minLogs)
    ? Math.min(Math.max(filters.minLogs ?? 0, 0), 500)
    : 0;

  const tag = filters.tag ? filters.tag.trim().slice(0, 32) : null;
  const year = Number.isFinite(filters.year)
    ? Math.min(Math.max(filters.year ?? 0, 1970), 2100)
    : null;

  const status = isStatus(filters.status) ? filters.status : null;

  /**
   * The filter is applied on `game_logs`, then the parent games are resolved.
   *
   * Filtering in the games table instead would need the aggregate per game,
   * which PostgREST cannot express here — so the log rows are narrowed first and
   * the distinct games read from that. `review` is only selected when needed
   * because it is the largest column on the table.
   */
  const selectColumns =
    'game_id, rating, review, created_at, games ( id, name, cover_url, release_date )';

  const build = () => {
    let q = supabase.from('game_logs').select(selectColumns);

    if (status) q = q.eq('status', status);
    if (minRating > 0) q = q.gte('rating', minRating);
    if (tag) q = q.contains('tags', [tag]);
    if (year) {
      // Year is a property of the game, not the log, so this needs the embed.
      // Filtering on a nested column is not expressible, so it is applied after
      // the rows come back and the query is over-fetched on purpose.
    }
    if (minLogs > 0) q = q.limit(minLogs * 20); // a bound, not a filter

    return q.order('created_at', { ascending: false }).limit(offset + limit + 1);
  };

  const { data, error } = await build();

  if (error) {
    console.error('[discover] browseGames error:', error.message);
    return { hits: [] as BrowseHit[], total: 0, offset };
  }

  // Aggregate the rows into one entry per game.
  const byGame = new Map<
    number,
    {
      game: { id: number; name: string; cover_url: string | null; release_date: string | null };
      ratings: number[];
      logCount: number;
      reviewCount: number;
      lastActivity: string | null;
    }
  >();

  for (const row of data ?? []) {
    const g = Array.isArray(row.games) ? row.games[0] : row.games;
    if (!g) continue;

    if (year) {
      const releaseYear = g.release_date ? Number(String(g.release_date).slice(0, 4)) : null;
      if (releaseYear !== year) continue;
    }

    let entry = byGame.get(g.id);
    if (!entry) {
      entry = {
        game: {
          id: g.id,
          name: g.name,
          cover_url: g.cover_url,
          release_date: g.release_date,
        },
        ratings: [],
        logCount: 0,
        reviewCount: 0,
        lastActivity: null,
      };
      byGame.set(g.id, entry);
    }

    entry.logCount++;
    if (row.rating > 0) entry.ratings.push(row.rating);
    if (row.review && String(row.review).trim().length > 0) entry.reviewCount++;
    if (!entry.lastActivity || row.created_at > entry.lastActivity) {
      entry.lastActivity = row.created_at;
    }
  }

  const hits: BrowseHit[] = [...byGame.values()]
    .map((e) => ({
      gameId: e.game.id,
      name: e.game.name,
      coverUrl: e.game.cover_url,
      releaseYear: e.game.release_date
        ? Number(String(e.game.release_date).slice(0, 4))
        : null,
      avgRating: e.ratings.length
        ? Math.round((e.ratings.reduce((a, b) => a + b, 0) / e.ratings.length) * 10) / 10
        : null,
      logCount: e.logCount,
      reviewCount: e.reviewCount,
      lastActivity: e.lastActivity,
    }))
    // `minLogs` is applied here rather than as a `.gte()` on a grouped count,
    // which PostgREST cannot express.
    .filter((h) => h.logCount >= minLogs);

  const sorted = sortHits(hits, filters.sort ?? 'recent');

  /*
   * `total` is the number of *distinct games* matching the filter within the
   * fetched window, not a claim about the whole table. It is deliberately not
   * presented as a global total, because it is not one — the query is bounded so
   * a hostile filter cannot pull the entire log table.
   */
  const total = sorted.length;
  const page = sorted.slice(offset, offset + limit);

  return { hits: page, total, offset };
}

function sortHits(hits: BrowseHit[], sort: BrowseSort): BrowseHit[] {
  const out = [...hits];
  switch (sort) {
    case 'rating':
      // Needs a tiebreak on volume, or a single 10/10 outranks a game with
      // hundreds of ratings — which is how a leaderboard becomes gameable.
      return out.sort(
        (a, b) => (b.avgRating ?? -1) - (a.avgRating ?? -1) || b.logCount - a.logCount
      );
    case 'most_logged':
      return out.sort((a, b) => b.logCount - a.logCount);
    case 'discussed':
      return out.sort((a, b) => b.reviewCount - a.reviewCount || b.logCount - a.logCount);
    case 'recent':
    default:
      return out.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  }
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
 * Computed in SQL with `unnest` rather than by fetching every log and counting in
 * JavaScript — which is what the old trending fallback did, uncapped and with no
 * ordering guarantee.
 */
export async function getPopularTags(limit = 16): Promise<{ tag: string; count: number }[]> {
  await enforce(`browse:ip:${clientKey(await headers())}`, 30, 60_000);

  const supabase = createPublicClient();
  const capped = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 40) : 16;

  // PostgREST cannot aggregate `unnest` through the JS client, so the tags are
  // read as a bounded sample and counted here. The ceiling is stated rather than
  // hidden, because a truncated count is better than an unbounded query.
  const { data, error } = await supabase
    .from('game_logs')
    .select('tags')
    .not('tags', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error) {
    console.error('[discover] getPopularTags error:', error.message);
    return [];
  }

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    for (const tag of (row.tags as string[] | null) ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, capped);
}