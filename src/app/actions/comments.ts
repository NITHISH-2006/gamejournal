'use server';

import { createClient, createPublicClient, requireUser } from '@/lib/supabase';
import { createNotification } from '@/lib/notify';
import { enforce } from '@/lib/rate-limit';
import { callerKey } from '@/lib/limiter';
import { validateComment, validateUuid } from '@/lib/validation';
import { revalidateLogPaths } from '@/lib/revalidate';

export type Comment = {
  id: string;
  log_id: string;
  /** Needed to decide whether to offer the author-only delete affordance. */
  user_id: string;
  body: string;
  created_at: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

/**
 * Comments on a log.
 *
 * The `comments` table, its RLS and the `comment` notification type are added
 * by `supabase/migrations/002_fixes_and_features.sql`. Reads go through the
 * public client on purpose: a comment thread is world-readable (the log it
 * hangs off is), and using the cookie-bound client here would drag `cookies()`
 * into the game page's render path for no benefit.
 */
export async function getComments(logId: unknown): Promise<Comment[]> {
  const id = validateUuid(logId, 'log id');
  const supabase = createPublicClient();

  const { data, error } = await supabase
    .from('comments')
    .select('id, log_id, body, created_at, user_id')
    .eq('log_id', id)
    .order('created_at', { ascending: true })
    .limit(200);

  if (error) {
    console.error('[comments] getComments error:', error.message);
    return [];
  }

  const rows = data ?? [];
  if (!rows.length) return [];

  // Batch-resolve authors rather than embedding, so a mismatch in the foreign
  // key's generated name cannot take the whole thread down.
  const authorIds = [...new Set(rows.map((r) => r.user_id as string))];
  // The error was previously discarded, so a transient failure attributed every
  // comment in the thread to a user called "unknown" — a real person's comment
  // credited to a stranger, with nothing in the log to explain it.
  const { data: authors, error: authorError } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', authorIds);

  if (authorError) {
    console.error('[comments] author lookup error:', authorError.message);
  }

  const byId = new Map(
    (authors ?? []).map((a) => [
      a.id as string,
      {
        username: a.username as string,
        display_name: (a.display_name as string | null) ?? null,
        avatar_url: (a.avatar_url as string | null) ?? null,
      },
    ])
  );

  return rows.map((r) => {
    const author = byId.get(r.user_id as string);
    return {
      id: r.id as string,
      log_id: r.log_id as string,
      user_id: r.user_id as string,
      body: r.body as string,
      created_at: r.created_at as string,
      username: author?.username ?? 'unknown',
      display_name: author?.display_name ?? null,
      avatar_url: author?.avatar_url ?? null,
    };
  });
}

export async function addComment(
  logId: unknown,
  body: unknown
): Promise<{ id: string }> {
  const user = await requireUser();
  await enforce(await callerKey('comment:write', user.id), 20, 60_000);

  const id = validateUuid(logId, 'log id');
  const text = validateComment(body);

  const supabase = await createClient();

  const { data: log, error: logError } = await supabase
    .from('game_logs')
    .select('id, user_id, game_id')
    .eq('id', id)
    .maybeSingle();

  if (logError) throw new Error(logError.message);
  if (!log) throw new Error('That log no longer exists.');

  const { data, error } = await supabase
    .from('comments')
    .insert({ log_id: id, user_id: user.id, body: text })
    .select('id')
    .single();

  if (error) throw new Error(error.message);

  if (log.user_id !== user.id) {
    await createNotification(
      log.user_id as string,
      user.id,
      'comment',
      id,
      (log as { game_id?: number | null }).game_id ?? null,
      data.id as string
    ).catch(() => {});
  }

  revalidateLogPaths(user.id, (log as { game_id?: number | null }).game_id ?? 0);
  return { id: data.id as string };
}

/**
 * Comments for many logs at once.
 *
 * The game page renders up to 50 log cards, so resolving each one separately
 * would be 50 round trips on every page view. This is a single query plus one
 * author lookup, keyed by log id.
 */
export async function getCommentsForLogs(
  logIds: string[]
): Promise<Record<string, Comment[]>> {
  const ids = (logIds ?? []).filter((v) => typeof v === 'string').slice(0, 200);
  const result: Record<string, Comment[]> = {};
  if (!ids.length) return result;

  const supabase = createPublicClient();
  const { data, error } = await supabase
    .from('comments')
    .select('id, log_id, body, created_at, user_id')
    .in('log_id', ids)
    .order('created_at', { ascending: true })
    .limit(1000);

  if (error) {
    console.error('[comments] getCommentsForLogs error:', error.message);
    return result;
  }

  const rows = data ?? [];
  if (!rows.length) return result;

  const authorIds = [...new Set(rows.map((r) => r.user_id as string))];
  // The error was previously discarded, so a transient failure attributed every
  // comment in the thread to a user called "unknown" — a real person's comment
  // credited to a stranger, with nothing in the log to explain it.
  const { data: authors, error: authorError } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', authorIds);

  if (authorError) {
    console.error('[comments] author lookup error:', authorError.message);
  }

  const byId = new Map(
    (authors ?? []).map((a) => [
      a.id as string,
      {
        username: a.username as string,
        display_name: (a.display_name as string | null) ?? null,
        avatar_url: (a.avatar_url as string | null) ?? null,
      },
    ])
  );

  for (const r of rows) {
    const author = byId.get(r.user_id as string);
    const logId = r.log_id as string;
    (result[logId] ??= []).push({
      id: r.id as string,
      log_id: logId,
      user_id: r.user_id as string,
      body: r.body as string,
      created_at: r.created_at as string,
      username: author?.username ?? 'unknown',
      display_name: author?.display_name ?? null,
      avatar_url: author?.avatar_url ?? null,
    });
  }

  return result;
}

/** Author-only delete. Ownership is enforced here and again by RLS. */

export async function deleteComment(commentId: unknown): Promise<void> {
  const user = await requireUser();
  await enforce(await callerKey('comment:write', user.id), 30, 60_000);

  const id = validateUuid(commentId, 'comment id');
  const supabase = await createClient();

  const { error } = await supabase
    .from('comments')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) throw new Error(error.message);

  // Resolve the parent log's game so only the affected page is invalidated.
  // Both comment mutations previously called `revalidateAll()`, so a single
  // 1�1000 character comment on one log invalidated every ISR route in the
  // application: the feed, every game page, every profile, every list and the
  // sitemap.
  const { data: parent } = await supabase
    .from('comments')
    .select('log_id, game_logs ( game_id )')
    .eq('id', id)
    .maybeSingle();

  const gameId = (parent as { game_logs?: { game_id?: number } | null } | null)
    ?.game_logs?.game_id;

  revalidateLogPaths(user.id, gameId ?? 0);
}
