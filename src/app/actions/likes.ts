'use server';

import { revalidatePath } from 'next/cache';
import { createClient, requireUser } from '@/lib/supabase';
import { enforce } from '@/lib/rate-limit';
import { callerKey } from '@/lib/limiter';
import { createNotification } from '@/lib/notify';
import { validateUuid } from '@/lib/validation';
import { exactCount } from '@/lib/count';

export type LikeSummary = { count: number; likedByMe: boolean };

/** Toggles a like on a log and returns the authoritative new state. */
export async function toggleLike(logId: unknown): Promise<LikeSummary> {
  const user = await requireUser();
  await enforce(await callerKey('like:write', user.id), 120, 60_000);

  const id = validateUuid(logId, 'log id');
  const supabase = await createClient();

  const { data: log, error: logError } = await supabase
    .from('game_logs')
    .select('id, user_id, game_id')
    .eq('id', id)
    .maybeSingle();

  if (logError) throw new Error(logError.message);
  if (!log) throw new Error('That log no longer exists.');

  const gameId = (log as { game_id?: number | null }).game_id ?? null;

  // Read as a plain array rather than `maybeSingle()`: `maybeSingle` returns
  // null for zero rows but *errors* on more than one, and the error was being
  // discarded, so a legacy duplicate made `existing` null and the toggle
  // always took the insert branch.
  //
  // The projection is `'*'`, not `'id'`. `log_likes` is keyed on
  // `(user_id, log_id)` and only gained a surrogate `id` in migration 002, so
  // `select('id')` fails with 42703 on a pre-002 database â€” and PostgREST
  // returns that with an *empty* message. The error went unchecked, so
  // `existingRows` was null, the toggle always took the INSERT branch, and
  // un-liking was impossible. Naming no column makes the read valid on both
  // sides of the migration.
  const { data: existingRows, error: readError } = await supabase
    .from('log_likes')
    .select('*')
    .eq('user_id', user.id)
    .eq('log_id', id)
    .order('created_at', { ascending: true })
    .limit(1);

  if (readError) throw new Error(readError.message || 'Could not read your likes.');

  const existing = existingRows?.[0];
  let likedByMe: boolean;

  if (existing) {
    // Delete by composite key so this works with or without 002's backfill.
    const { error } = await supabase
      .from('log_likes')
      .delete()
      .eq('user_id', user.id)
      .eq('log_id', id);
    if (error) throw new Error(error.message);
    likedByMe = false;
  } else {
    const { error } = await supabase
      .from('log_likes')
      .insert({ user_id: user.id, log_id: id });
    if (error) {
      if (error.code === '23505') {
        // Concurrent double-click lost the race; converge on "liked".
        likedByMe = true;
      } else {
        throw new Error(error.message);
      }
    } else {
      likedByMe = true;

      // Only notify on a genuine new like. The previous implementation
      // notified on every call, so double-clicking produced two notifications.
      if (log.user_id !== user.id) {
        await createNotification(log.user_id, user.id, 'like', id, gameId).catch(() => {});
      }
    }
  }

  const count = await exactCount(
    (sel) =>
      supabase
        .from('log_likes')
        .select(sel, { count: 'exact', head: true })
        .eq('log_id', id),
    'log_likes.count'
  );

  revalidatePath('/', 'layout');
  return { count, likedByMe };
}

/**
 * Batch like state for a set of logs.
 *
 * Prefers the `get_log_likes` RPC from the migration (single round trip,
 * server-side aggregation). Falls back to fetching rows when the function is
 * not installed, which is what happens on a pre-migration database.
 */
export async function getLikesForLogs(
  logIds: string[]
): Promise<Record<string, LikeSummary>> {
  const ids = (logIds ?? []).filter((v) => typeof v === 'string').slice(0, 200);
  if (!ids.length) return {};

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: rpcRows, error: rpcError } = await supabase.rpc('get_log_likes', {
    p_log_ids: ids,
  });

  if (!rpcError && Array.isArray(rpcRows)) {
    const result: Record<string, LikeSummary> = {};
    for (const row of rpcRows as {
      log_id: string;
      like_count: number | string;
      liked_by_me: boolean;
    }[]) {
      result[row.log_id] = {
        count: Number(row.like_count ?? 0),
        likedByMe: Boolean(row.liked_by_me),
      };
    }
    // Fill in zeros for logs with no likes so callers can index safely.
    for (const id of ids) {
      result[id] ??= { count: 0, likedByMe: false };
    }
    return result;
  }

  if (rpcError && !isMissingFunction(rpcError.message)) {
    console.error('[likes] get_log_likes RPC failed:', rpcError.message);
  }

  // Fallback: two targeted queries instead of one unbounded fetch.
  const [countRows, mineRows] = await Promise.all([
    supabase.from('log_likes').select('log_id').in('log_id', ids),
    user
      ? supabase.from('log_likes').select('log_id').in('log_id', ids).eq('user_id', user.id)
      : Promise.resolve({ data: [] as { log_id: string }[], error: null }),
  ]);

  // Previously unchecked, so a failure on either query produced a fully
  // populated map of `{ count: 0, likedByMe: false }`. That is the worst
  // possible wrong answer: the UI showed an un-highlighted "Like" button on a
  // post the user had already liked, and clicking it then *un-liked* it. A
  // failed read must be a logged error, not a confident wrong answer.
  if (countRows.error) {
    console.error('[likes] like count fallback error:', countRows.error.message);
  }
  if (mineRows.error) {
    console.error('[likes] own-likes fallback error:', mineRows.error.message);
  }

  const counts = new Map<string, number>();
  for (const row of countRows.data ?? []) {
    counts.set(row.log_id, (counts.get(row.log_id) ?? 0) + 1);
  }
  const mine = new Set((mineRows.data ?? []).map((r) => r.log_id));

  const result: Record<string, LikeSummary> = {};
  for (const id of ids) {
    result[id] = { count: counts.get(id) ?? 0, likedByMe: mine.has(id) };
  }
  return result;
}

function isMissingFunction(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('does not exist') ||
    m.includes('could not find the function') ||
    m.includes('404')
  );
}

/**
 * Removed: `likeLog`, `unlikeLog`.
 *
 * Neither had callers, but a 'use server' module registers *every* exported
 * async function as a publicly reachable POST endpoint, with no way to opt
 * one out. `toggleLike` is the supported entry point.
 */
