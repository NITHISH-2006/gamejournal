'use server';

import { cache } from 'react';
import { createClient } from '@/lib/supabase';
import { exactCount } from '@/lib/count';
import { getFeedTotals } from '@/app/actions/feed';
import { announceDegraded } from '@/lib/schema-notice';
import type { LogStatus } from '@/lib/types';

export type GameStats = {
  gameId: number;
  name: string;
  coverUrl: string | null;
  releaseDate: string | null;
  summary: string | null;
  avgRating: number | null;
  ratingCount: number;
  playtimeHours: number | null;
  statusCounts: Partial<Record<LogStatus, number>>;
  watchers: number;
};

export type GameLogEntry = {
  id: string;
  user_id: string;
  status: LogStatus;
  rating: number;
  review: string | null;
  created_at: string;
  diary_date: string | null;
  tags: string[] | null;
  /** Selected and now honoured by `ReviewText`; previously written but never read. */
  has_spoilers?: boolean | null;
  is_favorite?: boolean | null;
  username: string | null;
  liked_by_me: boolean;
  like_count: number;
};

/**
 * Aggregated stats for a single game.
 *
 * The old page only selected `name, cover_url, summary` and computed the
 * average in JavaScript, so `summary` was read but never populated by the
 * IGDB upsert - every game page showed an empty description.
 */
export const getGameStats = cache(async (
  gameId: number
): Promise<GameStats | null> => {
  const supabase = await createClient();

  const { data: game, error: gameError } = await supabase
    .from('games')
    .select('id, name, cover_url, release_date, summary')
    .eq('id', gameId)
    .maybeSingle();

  if (gameError) {
    console.error('[discover] getGameStats game error:', gameError.message);
    return null;
  }
  if (!game) return null;

  // Server-side aggregation keeps this correct past the first 100 rows. The
  // previous implementation selected the 100 highest ratings and averaged
  // those, which structurally excluded any game ranked below 100.
  const { data: agg, error: aggError } = await supabase
    .rpc('get_game_stats', { p_game_id: gameId });

  if (aggError) {
    console.error('[discover] get_game_stats RPC error:', aggError.message);
  }

  const row = (Array.isArray(agg) ? agg[0] : agg) as
    | {
        avg_rating: number | string | null;
        rating_count: number | string | null;
        playtime_hours: number | string | null;
        watchers: number | string | null;
        status_counts: Record<string, number> | null;
      }
    | undefined;

  const logs = await getGameLogs(gameId, 50);

  if (row) {
    return {
      gameId: game.id as number,
      name: game.name as string,
      coverUrl: (game.cover_url as string | null) ?? null,
      releaseDate: (game.release_date as string | null) ?? null,
      summary: (game.summary as string | null) ?? null,
      avgRating: toNumberOrNull(row.avg_rating),
      // `rating_count` is `(select count(*) … where rating > 0)` in the RPC, so
      // it is never null. The old `?? logs.length` arm substituted a
      // 50-capped page length into a "how many people rated this" field, so
      // whenever that fallback fired the number was wrong by construction.
      ratingCount: toNumber(row.rating_count),
      playtimeHours: toNumberOrNull(row.playtime_hours),
      statusCounts: (row.status_counts ?? {}) as Partial<Record<LogStatus, number>>,
      watchers: toNumber(row.watchers),
    };
  }

  // Fallback when the migration has not been applied.
  //
  // Only genuinely-rated logs count. Migration 002 backfills nulls to 0 and
  // then sets `rating NOT NULL`, where 0 means "logged but unrated" — so
  // averaging every log diluted the score with zeros, while the RPC filters
  // `rating > 0`. This has to match, or the same game shows two different
  // averages depending on whether the migration has been applied.
  const ratings = logs.map((l) => l.rating).filter((r) => Number.isFinite(r) && r > 0);
  const statusCounts = logs.reduce<Partial<Record<LogStatus, number>>>((acc, l) => {
    acc[l.status] = (acc[l.status] ?? 0) + 1;
    return acc;
  }, {});

  return {
    gameId: game.id as number,
    name: game.name as string,
    coverUrl: (game.cover_url as string | null) ?? null,
    releaseDate: (game.release_date as string | null) ?? null,
    summary: (game.summary as string | null) ?? null,
    avgRating: ratings.length
      ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
      : null,
    ratingCount: ratings.length,
    playtimeHours: null,
    statusCounts,
    watchers: logs.length,
  };
});

/** `Number()` that cannot produce NaN. */
function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Like `toNumber`, but a real null stays null rather than becoming 0. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export const getGameLogs = cache(async (
  gameId: number,
  limit = 50
): Promise<GameLogEntry[]> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Progressively degrade the projection.
  //
  // On a database without the `game_logs.user_id -> profiles.id` foreign key,
  // the `profiles (username)` embed fails with PGRST200 and takes the WHOLE
  // query down, so every game page silently lost its entire "Community logs"
  // section while still returning 200. Requesting the 002 columns on a
  // pre-002 database fails the same way with 42703. Both are retried below,
  // with the author resolved by a second query on the degraded path.
  const SELECT_FULL =
    'id, user_id, status, rating, review, created_at, diary_date, tags, has_spoilers, is_favorite, profiles ( username )';
  const SELECT_NO_EMBED =
    'id, user_id, status, rating, review, created_at, diary_date, tags, has_spoilers, is_favorite';
  const SELECT_LEGACY =
    'id, user_id, status, rating, review, created_at, diary_date, tags, profiles ( username )';
  const SELECT_MINIMAL =
    'id, user_id, status, rating, review, created_at, diary_date, tags';

  type Attempt = { data: unknown; error: { message: string } | null };
  const run = async (select: string): Promise<Attempt> => {
    const r = await supabase
      .from('game_logs')
      .select(select)
      .eq('game_id', gameId)
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, 100));
    return { data: r.data, error: r.error };
  };

  let data: unknown = null;
  let error: { message: string } | null = null;
  let degraded = false;

  for (const select of [SELECT_FULL, SELECT_NO_EMBED, SELECT_LEGACY, SELECT_MINIMAL]) {
    const attempt = await run(select);
    if (!attempt.error) {
      data = attempt.data;
      degraded = select !== SELECT_FULL;
      if (degraded) {
        // Announced once per process: this is a property of the database, not
        // of the request, so per-request logging only buries real errors.
        announceDegraded('discover:getGameLogs', `projection "${select}"`);
      }
      break;
    }
    error = attempt.error;
  }

  if (error && data === null) {
    console.error(
      '[discover] getGameLogs: all projections failed. ' +
        `Last error: ${error.message || '(empty message)'}`
    );
    return [];
  }

  const rows = (data ?? []) as Record<string, unknown>[];

  // Only on the degraded path do we need to resolve authors separately.
  let usernames: Record<string, string> | undefined;
  if (degraded && rows.length) {
    const ids = [...new Set(rows.map((r) => r.user_id as string).filter(Boolean))];
    const { data: authors, error: authorError } = await supabase
      .from('profiles')
      .select('id, username')
      .in('id', ids);
    if (authorError) {
      console.error('[discover] getGameLogs author lookup error:', authorError.message);
    }
    usernames = {};
    for (const a of authors ?? []) {
      usernames[a.id as string] = a.username as string;
    }
  }

  const logIds = rows.map((r) => r.id as string);

  const likeMap: Record<string, { count: number; likedByMe: boolean }> = {};
  if (logIds.length) {
    const [{ data: rpcRows, error: rpcError }, allMine] = await Promise.all([
      supabase.rpc('get_log_likes', { p_log_ids: logIds }),
      user
        ? supabase
            .from('log_likes')
            .select('log_id')
            .in('log_id', logIds)
            .eq('user_id', user.id)
        : Promise.resolve({ data: [] as { log_id: string }[], error: null }),
    ]);

    if (!rpcError && Array.isArray(rpcRows)) {
      for (const r of rpcRows as {
        log_id: string;
        like_count: number;
        liked_by_me: boolean;
      }[]) {
        likeMap[r.log_id] = { count: Number(r.like_count), likedByMe: Boolean(r.liked_by_me) };
      }
    } else {
      const { data: allLikes, error: allLikesError } = await supabase
        .from('log_likes')
        .select('log_id')
        .in('log_id', logIds);

      // Same failure mode as the feed: an unchecked read filled the whole map
      // with zeroes, so every post on a game page showed an un-highlighted
      // "Like" for posts the viewer had already liked.
      if (allLikesError) {
        console.error('[discover] getGameLogs like counts error:', allLikesError.message);
      }
      if (allMine.error) {
        console.error('[discover] getGameLogs own likes error:', allMine.error.message);
      }

      const counts = new Map<string, number>();
      for (const row of allLikes ?? []) {
        const lid = row.log_id as string;
        counts.set(lid, (counts.get(lid) ?? 0) + 1);
      }
      const mine = new Set((allMine.data ?? []).map((r) => r.log_id));
      for (const id of logIds) {
        likeMap[id] = { count: counts.get(id) ?? 0, likedByMe: mine.has(id) };
      }
    }
  }

  return rows.map((r) => {
    const profile = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
    const id = r.id as string;
    return {
      id,
      user_id: r.user_id as string,
      status: r.status as LogStatus,
      rating: r.rating as number,
      review: (r.review as string | null) ?? null,
      created_at: r.created_at as string,
      diary_date: (r.diary_date as string | null) ?? null,
      tags: (r.tags as string[] | null) ?? null,
      // Carried through from the embed when it worked, otherwise from the
      // batch-resolved map built on the degraded path.
      has_spoilers: (r.has_spoilers as boolean | null) ?? null,
      is_favorite: (r.is_favorite as boolean | null) ?? null,
      username:
        (profile as { username?: string } | null)?.username ??
        usernames?.[r.user_id as string] ??
        null,
      liked_by_me: likeMap[id]?.likedByMe ?? false,
      like_count: likeMap[id]?.count ?? 0,
    };
  });
});

export type RankedGame = {
  gameId: number;
  name: string;
  coverUrl: string | null;
  avgRating: number | null;
  logCount: number;
};

/**
 * Confidence-weighted ranking, shared by the RPC path and the fallback.
 *
 * A hard `minLogs` floor solves gaming on a large site but empties the
 * leaderboard on a small one — with 8 logs in the whole database, no game can
 * reach a floor of 5, so the primary discovery surface rendered permanently
 * empty. The floor was the wrong tool.
 *
 * This is the standard IMDb-style shrinkage: pull small samples toward a prior
 * mean in proportion to how little evidence there is. A lone 10/10 scores 5.5;
 * a 9.0 averaged over 20 ratings scores 8.35. So a single perfect rating still
 * cannot top a well-reviewed game, and the board is never artificially empty.
 *
 *   score = (avg * n + PRIOR * WEIGHT) / (n + WEIGHT)
 */
const PRIOR_MEAN = 4.0;
const PRIOR_WEIGHT = 3;

function weightedScore(avg: number, votes: number): number {
  return (avg * votes + PRIOR_MEAN * PRIOR_WEIGHT) / (votes + PRIOR_WEIGHT);
}

/**
 * Highest-rated games.
 *
 * Prefers the `get_top_rated_games` RPC — the aggregate belongs in SQL.
 *
 * The fallback exists because that RPC was genuinely absent on the live
 * project: the database had been created from an older revision of 001 that
 * predates it, so `rpc()` returned PGRST202 and the leaderboard rendered as
 * permanently empty with only a server-side log to show for it. This mirrors
 * the SQL faithfully, including the same weighted score, so the two paths
 * cannot disagree about who is #1.
 */
export async function getTopRatedGames(
  limit = 24,
  minLogs = 1
): Promise<RankedGame[]> {
  const supabase = await createClient();
  const take = Math.min(Math.max(limit, 1), 48);

  const { data, error } = await supabase.rpc('get_top_rated_games', {
    p_limit: take,
    p_min_logs: minLogs,
  });

  if (!error && Array.isArray(data)) {
    return (data as Record<string, unknown>[]).map((r) => ({
      gameId: r.game_id as number,
      name: r.name as string,
      coverUrl: (r.cover_url as string | null) ?? null,
      avgRating: toNumberOrNull(r.avg_rating),
      logCount: toNumber(r.log_count),
    }));
  }

  if (error) {
    console.error('[discover] get_top_rated_games error:', error.message);
  }

  // Fallback: aggregate client-side over a bounded slice.
  //
  // `rating > 0` rather than `rating is not null`. Migration 002 backfills nulls
  // to 0 and then sets `rating NOT NULL`, where 0 means "logged but unrated" —
  // so `is not null` matched every row in the table and filtered nothing, while
  // the loop below discarded the same rows anyway. This also means unrated logs
  // are never transferred.
  //
  // 1000 is PostgREST's default `db-max-rows`, so it is the real ceiling here:
  // the old `.limit(2000)` was silently truncated to 1000, which made the
  // averages an average of an arbitrary subset. That limitation is precisely
  // why 002 ships the RPC, and why the aggregation belongs in SQL.
  const { data: rows, error: fallbackError } = await supabase
    .from('game_logs')
    .select('game_id, rating, games ( name, cover_url )')
    .gt('rating', 0)
    .limit(1000);

  if (fallbackError) {
    console.error('[discover] getTopRatedGames fallback error:', fallbackError.message);
    return [];
  }

  const agg = new Map<
    number,
    { name: string; cover: string | null; sum: number; n: number }
  >();

  for (const row of (rows ?? []) as Record<string, unknown>[]) {
    const gid = row.game_id as number;
    const rating = Number(row.rating ?? 0);
    if (!Number.isInteger(gid) || gid <= 0 || rating <= 0) continue;

    const game = (Array.isArray(row.games) ? row.games[0] : row.games) as
      | { name: string; cover_url: string | null }
      | null;
    if (!game?.name) continue;

    const entry = agg.get(gid) ?? { name: game.name, cover: game.cover_url, sum: 0, n: 0 };
    entry.sum += rating;
    entry.n += 1;
    agg.set(gid, entry);
  }

  return [...agg.entries()]
    .filter(([, v]) => v.n >= Math.max(minLogs, 1))
    .map(([gameId, v]) => ({
      gameId,
      name: v.name,
      coverUrl: v.cover,
      avgRating: Math.round((v.sum / v.n) * 100) / 100,
      logCount: v.n,
      score: weightedScore(v.sum / v.n, v.n),
    }))
    .sort(
      (a, b) =>
        b.score - a.score || b.logCount - a.logCount || a.name.localeCompare(b.name)
    )
    .slice(0, take)
    // `score` is a sort key only; it must not reach the client shape.
    .map(({ score, ...ranked }) => {
      void score;
      return ranked;
    });
}

export type TrendingGame = RankedGame & { recentLogs: number };

/** Most-logged games in the recent window. */
/**
 * Trending games.
 *
 * This used to select up to 500 matching rows with **no `order()`** and group
 * them in JavaScript. Postgres may return any 500 of the matching rows, so the
 * "top 10 trending" list could differ between two identical requests in the
 * same second, and the ranking was computed over a truncated slice rather than
 * the whole window.
 *
 * 002 adds `get_trending_games`, which ranks in SQL. The old path is kept as a
 * fallback for a pre-002 database, but it now sorts and truncates in one place
 * so the fallback is at least deterministic.
 */
export async function getTrendingGames(
  windowHours = 168,
  limit = 18
): Promise<TrendingGame[]> {
  const supabase = await createClient();
  const days = Math.min(Math.max(Math.round(windowHours / 24), 1), 90);
  const take = Math.min(Math.max(limit, 1), 50);

  const { data, error } = await supabase.rpc('get_trending_games', {
    p_limit: take,
    p_days: days,
    p_min_logs: 1,
  });

  if (!error && Array.isArray(data)) {
    return (data as Record<string, unknown>[]).map((r) => ({
      // Guarded rather than cast: a `bigint` arrives as a string, and
      // `Number(undefined)` is NaN, which then became a React key and a
      // `Record` key — silently colliding on the string "NaN".
      gameId: toNumber(r.game_id),
      name: String(r.name ?? ''),
      coverUrl: (r.cover_url as string | null) ?? null,
      avgRating: toNumberOrNull(r.avg_rating),
      logCount: toNumber(r.log_count),
      recentLogs: toNumber(r.log_count),
    }));
  }

  if (error) {
    console.error('[discover] get_trending_games error:', error.message);
  }

  // Fallback: pre-002 database.
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const { data: rows, error: fallbackError } = await supabase
    .from('game_logs')
    .select('game_id, games ( name, cover_url )')
    .gte('created_at', since)
    // Ordered so the 500-row sample is reproducible. Without an `order()`,
    // Postgres may return any 500 of the matching rows, so two identical
    // requests in the same second could disagree about the ranking — the exact
    // non-determinism the RPC was added to remove.
    .order('created_at', { ascending: false })
    .limit(500);

  if (fallbackError) {
    console.error('[discover] getTrendingGames fallback error:', fallbackError.message);
    return [];
  }

  const map = new Map<number, { name: string; cover: string | null; n: number }>();
  for (const row of (rows ?? []) as Record<string, unknown>[]) {
    const gid = row.game_id as number;
    const game = (Array.isArray(row.games) ? row.games[0] : row.games) as
      | { name: string; cover_url: string | null }
      | null;
    if (!game) continue;
    const entry = map.get(gid) ?? { name: game.name, cover: game.cover_url, n: 0 };
    entry.n += 1;
    map.set(gid, entry);
  }

  return [...map.entries()]
    // Name is the tiebreak so the order is total, and therefore repeatable.
    .sort((a, b) => b[1].n - a[1].n || a[1].name.localeCompare(b[1].name))
    .slice(0, take)
    .map(([gameId, v]) => ({
      gameId,
      name: v.name,
      coverUrl: v.cover,
      avgRating: null,
      logCount: v.n,
      recentLogs: v.n,
    }));
}

export type UserStats = {
  total: number;
  completed: number;
  playing: number;
  backlog: number;
  abandoned: number;
  avgRating: number | null;
  totalPlaytime: number | null;
  favoriteCount: number;
  thisYear: number;
};

/**
 * Dashboard statistics for a user.
 *
 * The previous `UserStats` component downloaded every log row for the user
 * just to count them in JavaScript. This uses count aggregates, so the cost
 * stays constant as the library grows.
 */
export const getUserStats = cache(async (
  userId: string
): Promise<UserStats> => {
  const supabase = await createClient();
  const yearStart = `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`;

  const countFor = (
    build: (sel: string) => unknown,
    label: string
  ): Promise<number> =>
    exactCount(
      build as Parameters<typeof exactCount>[0],
      `userStats.${label}.${userId}`
    );

  // Errors were previously discarded on all eight, and `count ?? 0` turned any
  // failure into a real-looking zero. `favoriteCount` was the worst: it filters
  // on `is_favorite`, a column migration 002 adds, so on a pre-002 database
  // that one query fails with 42703 and the user's "Favourites" tile reads 0
  // forever. A user with no favourites and a broken query were indistinguishable.
  const [total, completed, playing, backlog, abandoned, thisYear, favorites] =
    await Promise.all([
      countFor(
        (sel) =>
          supabase
            .from('game_logs')
            .select(sel, { count: 'exact', head: true })
            .eq('user_id', userId),
        'total'
      ),
      countFor(
        (sel) =>
          supabase
            .from('game_logs')
            .select(sel, { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('status', 'completed'),
        'completed'
      ),
      countFor(
        (sel) =>
          supabase
            .from('game_logs')
            .select(sel, { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('status', 'playing'),
        'playing'
      ),
      countFor(
        (sel) =>
          supabase
            .from('game_logs')
            .select(sel, { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('status', 'backlog'),
        'backlog'
      ),
      countFor(
        (sel) =>
          supabase
            .from('game_logs')
            .select(sel, { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('status', 'abandoned'),
        'abandoned'
      ),
      countFor(
        (sel) =>
          supabase
            .from('game_logs')
            .select(sel, { count: 'exact', head: true })
            .eq('user_id', userId)
            .gte('created_at', yearStart),
        'thisYear'
      ),
      countFor(
        (sel) =>
          supabase
            .from('game_logs')
            .select(sel, { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('is_favorite', true),
        'favorites'
      ),
    ]);

// Only genuinely-rated logs, matching `get_game_stats` in the migration.
  // 002 makes `rating NOT NULL` with 0 meaning "unrated", so `is not null`
  // matched every row and pulled the average toward zero.
  //
  // Paged rather than a single unbounded read. PostgREST caps a response at
  // `db-max-rows` (1000 by default) and truncates silently, so the previous
  // single request computed the average over an arbitrary subset for anyone past
  // 1,000 rated logs — a wrong number rather than a rounded one, while the
  // caller-facing comment claimed the cost was constant.
  //
  // `get_user_activity_stats` would compute this in one round trip, but this
  // action must keep working on a database where 002 has not been applied, so
  // it pages instead. The ceiling is high enough that reaching it means the
  // answer is logged as approximate rather than silently wrong.
  const RATINGS_PAGE = 1000;
  const RATINGS_CEILING = 20_000;
  const ratings: number[] = [];
  let offset = 0;

  while (offset < RATINGS_CEILING) {
    const { data: page, error: pageError } = await supabase
      .from('game_logs')
      .select('rating')
      .eq('user_id', userId)
      .gt('rating', 0)
      .order('rating', { ascending: true })
      .range(offset, offset + RATINGS_PAGE - 1);

    if (pageError) {
      console.error('[discover] getUserStats ratings error:', pageError.message);
      break;
    }

    for (const row of page ?? []) {
      const value = row.rating as number;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        ratings.push(value);
      }
    }

    // A short page means we have reached the end.
    if (!page || page.length < RATINGS_PAGE) break;
    offset += RATINGS_PAGE;
  }

  if (ratings.length >= RATINGS_CEILING) {
    console.warn(
      `[discover] getUserStats: ${userId} has at least ${RATINGS_CEILING} rated logs; ` +
        'the average is computed from a truncated set. Apply migration 003 and switch to get_user_activity_stats.'
    );
  }

  const avgRating = ratings.length
    ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
    : null;

  return {
    total,
    completed,
    playing,
    backlog,
    abandoned,
    avgRating,
    totalPlaytime: null,
    favoriteCount: favorites,
    thisYear,
  };
});

/** Platform-wide totals shown on the landing hero. */
export async function getSiteStats() {
  const supabase = await createClient();
  const [totals, games] = await Promise.all([
    getFeedTotals(),
    exactCount(
      (sel) => supabase.from('games').select(sel, { count: 'exact', head: true }),
      'siteStats.games'
    ),
  ]);
  return { ...totals, games };
}
