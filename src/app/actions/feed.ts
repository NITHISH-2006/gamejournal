'use server';

import { exactCount } from '@/lib/count';
import { announceDegraded as reportDegraded } from '@/lib/schema-notice';
import { createClient } from '@/lib/supabase';
import type { FeedLog, FeedMode, LogStatus } from '@/lib/types';

const PAGE_SIZE = 20;
const MAX_LIMIT = 50;
const TRENDING_WINDOW_HOURS = 72;

/** PostgREST returns a to-one relation as an object but may return an array. */
function relOne<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function normalize(rows: unknown[], usernames?: Record<string, string>): FeedLog[] {
  return (rows as Record<string, unknown>[]).map((r) => {
    const game = relOne(r.games as { name: string; cover_url: string | null } | null);
    const profile = relOne(r.profiles as { username: string } | null);
    return {
      id: r.id as string,
      game_id: r.game_id as number,
      user_id: r.user_id as string,
      status: r.status as LogStatus,
      rating: r.rating as number,
      review: (r.review as string | null) ?? null,
      diary_date: (r.diary_date as string | null) ?? null,
      tags: (r.tags as string[] | null) ?? null,
      // The SELECT requests these, so they must be carried through. Omitting
      // them here meant the feed silently ignored the spoiler flag, which is
      // the exact failure the flag exists to prevent.
      has_spoilers: (r.has_spoilers as boolean | null) ?? null,
      is_favorite: (r.is_favorite as boolean | null) ?? null,
      created_at: r.created_at as string,
      game_name: game?.name ?? 'Unknown game',
      game_cover: game?.cover_url ?? null,
      // Falls back to the batch-resolved map when the author could not be
      // embedded, so posts keep their attribution on a database missing the
      // `game_logs -> profiles` foreign key.
      username: profile?.username ?? usernames?.[r.user_id as string] ?? null,
    };
  });
}

const SELECT = `
  id, game_id, user_id, status, rating, review,
  diary_date, tags, has_spoilers, is_favorite, created_at,
  games ( name, cover_url ),
  profiles ( username )
`;

/**
 * The same projection without the `profiles` embed.
 *
 * Used as a fallback when PostgREST cannot resolve the author relationship.
 * On a database without the `game_logs.user_id -> profiles.id` foreign key,
 * the embed fails with PGRST200 for the WHOLE query, so the feed — the app's
 * main surface — renders empty and every post loses its author. The usernames
 * are then resolved in a second query, which is the same resilience
 * `getCommentsForLogs` uses for comment authors.
 */
const SELECT_NO_EMBED = `
  id, game_id, user_id, status, rating, review,
  diary_date, tags, has_spoilers, is_favorite, created_at,
  games ( name, cover_url )
`;

/** 001-era columns only, for a database where 002 has not been applied. */
const SELECT_LEGACY = `
  id, game_id, user_id, status, rating, review,
  diary_date, tags, created_at,
  games ( name, cover_url )
`;

/** No columns beyond the 001 base schema and no `profiles` embed. */
const SELECT_MINIMAL = `
  id, game_id, user_id, status, rating, review,
  diary_date, tags, created_at,
  games ( name, cover_url )
`;

type AnyQuery = PromiseLike<{
  data: unknown;
  error: { message: string; code?: string } | null;
}>;

type QueryOutcome = { data: unknown[] | null; error: { message: string } | null };

/**
 * Progressively degrades the projection until the database accepts one.
 *
 * Four tiers, each tried only if the previous failed:
 *   1. full projection, with the author embed
 *   2. full projection, no author embed        (missing FK)
 *   3. 001 columns, with the author embed      (002 not applied)
 *   4. 001 columns, no author embed            (neither)
 *
 * Tier 2 is what the live project needs; it was hitting tier 1 and returning
 * zero rows with only a server log to show for it.
 */
async function runLogQuery(
  build: (select: string) => AnyQuery,
  label: string
): Promise<QueryOutcome> {
  const attempts: [string, string][] = [
    [SELECT, 'full projection'],
    [SELECT_NO_EMBED, 'no author embed (missing game_logs -> profiles FK)'],
    [SELECT_LEGACY, 'pre-002 columns'],
    [SELECT_MINIMAL, 'pre-002 columns, no author embed'],
  ];

  let lastError: { message: string } | null = null;

  for (const [select, description] of attempts) {
    const result = await build(select);
    if (!result.error) {
      if (description !== 'full projection') {
        announceDegraded(`feed:${label}`, description);
      }
      return { data: (result.data as unknown[]) ?? null, error: null };
    }
    lastError = result.error;
    // Deliberately silent per attempt. These failures are the *expected*
    // mechanism of the fallback, not incidents: on a pre-002 database every
    // home page render produced three `console.error` lines, which is what made
    // the real errors in this log impossible to find. Only the fact that the
    // ladder settled on a lower tier is reported, and only once per process.
  }

  // Every tier failed — that *is* an incident.
  console.error(
    `[feed] ${label}: all ${attempts.length} projections failed. ` +
      `Last error: ${lastError?.message || '(empty message)'}`
  );
  return { data: null, error: lastError };
}

/**
 * Reports a degraded query path once per process, instead of on every request.
 *
 * Lives in `lib/schema-notice` rather than here: this module starts with
 * `'use server'`, which requires every export to be `async`.
 */
function announceDegraded(scope: string, detail: string): void {
  reportDegraded(scope, detail);
}

/**
 * Resolves usernames for rows whose author could not be embedded.
 *
 * Only called on the degraded path, so it costs nothing on a healthy database.
 */
async function fillUsernames(
  rows: unknown[]
): Promise<Record<string, string>> {
  const ids = [
    ...new Set(
      (rows as Record<string, unknown>[])
        .map((r) => r.user_id as string)
        .filter(Boolean)
    ),
  ];
  if (!ids.length) return {};

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username')
    .in('id', ids);

  if (error) {
    console.error('[feed] username lookup error:', error.message);
    return {};
  }

  const map: Record<string, string> = {};
  for (const p of data ?? []) map[p.id as string] = p.username as string;
  return map;
}

/**
 * Fetches a page of the activity feed.
 *
 * Fixes over the previous implementation:
 *  - Paginated with a cursor instead of a hard-coded `limit(30)`, so the feed
 *    can actually grow.
 *  - The "following" view resolves the caller's id from the session instead of
 *    trusting a client-supplied `currentUserId`, which meant a forged value
 *    returned another user's following feed.
 *  - Trending groups by game server-side and returns whole groups, rather than
 *    re-sorting a flat list of individual posts by log count.
 */
/**
 * Keyset cursor for `(created_at DESC, id DESC)`.
 *
 * ── Why the cursor carries two columns ──────────────────────────────────────
 *
 * The feed orders by `created_at DESC, id DESC` but paged on `created_at`
 * alone, filtering with `created_at < cursor`. That silently drops every row
 * that shares the boundary row's timestamp: such a row has a *different* id, so
 * it sorts strictly after the boundary row, yet its `created_at` is not
 * `< cursor`. It appears on no page, and no page reports a gap.
 *
 * `game_logs.created_at` defaults to `now()`, which in Postgres is the
 * *transaction* timestamp — so every row written by one insert shares it, and
 * two rapid submissions can collide too. This is a data-loss bug that only
 * shows up once a feed has any ties at all.
 *
 * The predicate is the standard two-clause disjunction:
 *
 *     created_at < c  OR  (created_at = c AND id < i)
 *
 * which exactly matches the sort order, so the two columns together form a
 * total order and no row can be skipped or served twice.
 *
 * The timestamp is normalised to `toISOString()` before it goes into the
 * cursor. PostgREST returns `2024-01-01T00:00:00+00:00`, and a raw `+` in a
 * query string decodes to a space — the comparison would silently be against
 * the wrong instant. `…Z` needs no escaping.
 */
const CURSOR_SEP = '|';

function encodeCursor(createdAt: string, id: string): string {
  return `${new Date(createdAt).toISOString()}${CURSOR_SEP}${id}`;
}

function decodeCursor(cursor: string | null): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const at = cursor.indexOf(CURSOR_SEP);
  if (at <= 0) return null;
  return { createdAt: cursor.slice(0, at), id: cursor.slice(at + 1) };
}

/**
 * The PostgREST filter matching everything strictly after the cursor.
 *
 * Passed to `.or()`, which is inserted into the query string verbatim, so the
 * values must be free of characters that need escaping. `toISOString()` output
 * and a uuid are.
 */
function cursorFilter(cursor: { createdAt: string; id: string }): string {
  return `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`;
}

export async function getFeedData(
  type: FeedMode = 'global',
  opts: { cursor?: string | null; limit?: number } = {}
): Promise<{ logs: FeedLog[]; nextCursor: string | null }> {
  const supabase = await createClient();

  // `Number.isFinite` rather than Math.min: `opts.limit` arrives from a client,
  // so it can be a string or NaN. `Math.max(NaN, 1)` is NaN, `Math.min(NaN, 50)`
  // is NaN, and `.limit(NaN)` makes PostgREST reject the query — which, inside
  // the retrying `runLogQuery` helper, produced four identical error lines and
  // an empty feed.
  const rawLimit = Number(opts.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT)
    : PAGE_SIZE;

  const cursor = decodeCursor(opts.cursor ?? null);

  try {
    if (type === 'following') {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return { logs: [], nextCursor: null };

      const { data: followRows, error: followError } = await supabase
        .from('follows')
        .select('following_id')
        .eq('follower_id', user.id);

      // Previously unchecked, so a failed read yielded `ids = []` and the
      // "Following" tab rendered permanently empty with no server output at
      // all — the single most invisible failure mode in the app.
      if (followError) {
        console.error('[feed] following lookup error:', followError.message);
        return { logs: [], nextCursor: null };
      }

      const ids = (followRows ?? []).map((r) => r.following_id as string);
      if (!ids.length) return { logs: [], nextCursor: null };

      const { data, error } = await runLogQuery(
        (select) => {
          let q = supabase
            .from('game_logs')
            .select(select)
            .in('user_id', ids)
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .limit(limit + 1);
          if (cursor) q = q.or(cursorFilter(cursor));
          return q;
        },
        'following'
      );
      if (error) return { logs: [], nextCursor: null };

      return paginate(normalize(data ?? [], await fillUsernames(data ?? [])), limit);
    }

    if (type === 'trending') {
      const cutoff = new Date(
        Date.now() - TRENDING_WINDOW_HOURS * 60 * 60 * 1000
      ).toISOString();

      // Count how often each game was logged inside the window.
      //
      // The explicit order matters: without it Postgres may return *any* 500 of
      // the matching rows, so the "top 10" could differ between two identical
      // requests in the same second. That is the exact non-determinism
      // `get_trending_games` was added to remove; this path stays for a
      // pre-002 database and is now at least reproducible.
      const { data: counts, error: countError } = await supabase
        .from('game_logs')
        .select('game_id')
        .gte('created_at', cutoff)
        .order('created_at', { ascending: false })
        .limit(500);

      if (countError) {
        console.error('[feed] trending count error:', countError.message);
        return { logs: [], nextCursor: null };
      }

      const freq = new Map<number, number>();
      for (const row of counts ?? []) {
        const gid = row.game_id as number;
        freq.set(gid, (freq.get(gid) ?? 0) + 1);
      }

      const ranked = [...freq.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, 10)
        .map(([gameId]) => gameId);

      if (!ranked.length) return { logs: [], nextCursor: null };

      // One bounded query per ranked game, taking its most recent log in the
      // window.
      //
      // The previous shape fetched `.in('game_id', ranked).limit(limit * 2)` and
      // de-duplicated in JavaScript. That is a guess: if the newest 40 rows
      // happened to all belong to four games, the other six ranked games never
      // appeared at all. Asking for exactly one row per game cannot under-fill.
      const perGame = await Promise.all(
        ranked.map((gameId) =>
          runLogQuery(
            (select) =>
              supabase
                .from('game_logs')
                .select(select)
                .eq('game_id', gameId)
                .gte('created_at', cutoff)
                .order('created_at', { ascending: false })
                .order('id', { ascending: false })
                .limit(1),
            `trending:game:${gameId}`
          )
        )
      );

      const anyFailed = perGame.some((r) => r.error);
      const flat = perGame.flatMap((r) => r.data ?? []);
      if (anyFailed && !flat.length) {
        console.error('[feed] trending log fetch failed');
        return { logs: [], nextCursor: null };
      }

      const rows = normalize(flat, await fillUsernames(flat));

      // Rank order is by log frequency, which `ranked` already encodes.
      const byGame = new Map(rows.map((r) => [r.game_id, r]));
      const ordered = ranked
        .map((gameId) => byGame.get(gameId))
        .filter((r): r is FeedLog => Boolean(r));

      // `nextCursor: null` is correct here, not a stub: trending is a ranked
      // top-N set rather than a paged stream, so there is nothing to resume.
      return { logs: ordered.slice(0, limit), nextCursor: null };
    }

    // global
    const { data, error } = await runLogQuery(
      (select) => {
        let q = supabase
          .from('game_logs')
          .select(select)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit + 1);
        if (cursor) q = q.or(cursorFilter(cursor));
        return q;
      },
      'global'
    );
    if (error) return { logs: [], nextCursor: null };

    return paginate(normalize(data ?? [], await fillUsernames(data ?? [])), limit);
  } catch (err) {
    console.error('[feed] getFeedData error:', (err as Error).message);
    return { logs: [], nextCursor: null };
  }
}

/** Trims the extra probe row and derives the next cursor. */
function paginate(rows: FeedLog[], limit: number) {
  if (rows.length <= limit) {
    return { logs: rows, nextCursor: null };
  }
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    logs: page,
    // Both columns, so the next page resumes exactly where this one stopped.
    nextCursor: last ? encodeCursor(last.created_at, last.id) : null,
  };
}

/** Total number of public logs, for the stats strip. */
export async function getFeedTotals(): Promise<{ logs: number; users: number }> {
  const supabase = await createClient();

  // Errors were previously discarded on both. PostgREST returns `count: null`
  // on failure, so `count ?? 0` turned any RLS or permission problem into a
  // site-wide "0 logs / 0 players" strip — with nothing in the log to explain
  // it. `exactCount` logs and returns 0 instead of hiding the cause.
  const [logs, users] = await Promise.all([
    exactCount(
      (sel) => supabase.from('game_logs').select(sel, { count: 'exact', head: true }),
      'feedTotals.logs'
    ),
    exactCount(
      (sel) => supabase.from('profiles').select(sel, { count: 'exact', head: true }),
      'feedTotals.users'
    ),
  ]);

  return { logs, users };
}
