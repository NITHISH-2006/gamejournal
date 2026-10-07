'use server';

import { createClient } from '@/lib/supabase';
import { exactCount } from '@/lib/count';
import type { UserNotification } from '@/lib/types';
import { validateUuid } from '@/lib/validation';
import { announceDegraded } from '@/lib/schema-notice';

/**
 * Notifications for the signed-in user.
 *
 * The previous implementation embedded `profiles!actor_id` and
 * `game_logs ( games ( name ) )` in a single select. That depends on the
 * foreign keys being named exactly as PostgREST expects; if the constraint
 * name differed, the whole query failed and the bell silently showed nothing.
 * We now fetch the notifications, then batch-resolve actors and games, which
 * is resilient to constraint naming.
 */
export async function getNotifications(limit = 30): Promise<UserNotification[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  // `Number.isFinite` rather than Math.min: Math.min(NaN, 50) is NaN, and
  // `.limit(NaN)` makes PostgREST reject the whole query.
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 30;

  // `game_id` is added by migration 002, and a missing column fails the *whole*
  // query, not just that field. This is the one read that had no degraded
  // projection, so on a pre-002 database the entire bell returned `[]` — while
  // its siblings (feed, game pages) fell back correctly. `game_id` only supplies
  // a nicer link target, so the retry without it is a strict improvement.
  const SELECT_FULL = 'id, type, read, created_at, log_id, game_id, actor_id';
  const SELECT_LEGACY = 'id, type, read, created_at, log_id, actor_id';

  let data: unknown = null;
  let error: { message: string } | null = null;

  for (const select of [SELECT_FULL, SELECT_LEGACY]) {
    const attempt = await supabase
      .from('notifications')
      .select(select)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(safeLimit);
    if (!attempt.error) {
      data = attempt.data;
      if (select !== SELECT_FULL) {
        announceDegraded('notifications:getNotifications', 'pre-002 projection');
      }
      break;
    }
    error = attempt.error;
  }

  if (error && data === null) {
    console.error(
      '[notifications] getNotifications: both projections failed. ' +
        `Last error: ${error.message || '(empty message)'}`
    );
    return [];
  }

  const rows = (data ?? []) as Record<string, unknown>[];
  if (!rows.length) return [];

  const actorIds = unique(rows.map((r) => r.actor_id as string));
  const logIds = unique(rows.map((r) => r.log_id).filter(Boolean) as string[]);

  const [actors, logs] = await Promise.all([
    actorIds.length
      ? supabase.from('profiles').select('id, username').in('id', actorIds)
      : Promise.resolve({ data: [] as { id: string; username: string }[] }),
    logIds.length
      ? supabase
          .from('game_logs')
          .select('id, games ( name )')
          .in('id', logIds)
      : Promise.resolve({
          data: [] as { id: string; games: { name: string } | { name: string }[] | null }[],
        }),
  ]);

  const actorMap = new Map((actors.data ?? []).map((p) => [p.id, p.username]));
  const gameMap = new Map<string, string>();
  for (const log of logs.data ?? []) {
    const relation = log.games;
    const name = Array.isArray(relation)
      ? relation[0]?.name
      : relation?.name;
    if (name) gameMap.set(log.id, name);
  }

  return rows.map((row) => ({
    id: row.id as string,
    type: row.type as UserNotification['type'],
    read: Boolean(row.read),
    created_at: row.created_at as string,
    log_id: (row.log_id as string | null) ?? null,
    // Stored on the row by 002 so a "someone liked your log of X" notification
    // can link to /game/<id>. Without it the bell dead-ended on /discover.
    game_id: (row.game_id as number | null) ?? null,
    actor_username: actorMap.get(row.actor_id as string) ?? null,
    game_name: row.log_id ? (gameMap.get(row.log_id as string) ?? null) : null,
  }));
}

export async function getUnreadCount(): Promise<number> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return 0;

// Via `exactCount`, like every other count in the codebase. This was the last
  // hand-rolled `select(…, { count: 'exact', head: true })`: it destructured
  // `count` without checking `error`, so a permission blip rendered as a
  // confident "0 unread" on the bell badge rather than an error.
  return exactCount(
    (sel) =>
      supabase
        .from('notifications')
        .select(sel, { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('read', false),
    'notifications.unread'
  );
}

/**
 * Returns whether the write actually landed.
 *
 * The previous version swallowed the error and returned void, so the client
 * unconditionally zeroed the badge and marked every row read in local state.
 * When the update failed the server still had them unread, and the badge was
 * wrong until the next realtime insert triggered a reload.
 */
export async function markAllRead(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { error } = await supabase
    .from('notifications')
    .update({ read: true })
    .eq('user_id', user.id)
    .eq('read', false);

  if (error) {
    console.error('[notifications] markAllRead error:', error.message);
    return false;
  }
  return true;
}

export async function markRead(notificationId: unknown): Promise<void> {
  const id = validateUuid(notificationId, 'notification id');
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { error } = await supabase
    .from('notifications')
    .update({ read: true })
    .eq('id', id)
    .eq('user_id', user.id);

  // Previously the error was never destructured, so the action resolved
  // successfully even when the UPDATE was rejected by RLS. The caller
  // optimistically cleared the badge, the row stayed `read = false`, and
  // `getUnreadCount` kept counting it — so the badge reappeared on the next
  // poll with no explanation.
  if (error) {
    console.error('[notifications] markRead error:', error.message);
    throw new Error('Could not mark that notification as read.');
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
