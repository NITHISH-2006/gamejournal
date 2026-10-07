import { createClient } from '@/lib/supabase';

/**
 * Fire-and-forget notifier for likes, follows and comments. Never throws.
 *
 * ── Why this file exists, and why it must not have `'use server'` ────────────
 *
 * This used to live in `app/actions/notifications.ts`, which starts with
 * `'use server'`. Every `export async function` in such a module is registered
 * as a publicly invocable endpoint — there is no way to opt out. So the
 * function was reachable by anyone who could POST to the site, and the only
 * thing standing between a stranger and someone else's notification bell was
 * a check on the *actor* argument.
 *
 * The recipient was never checked, and the RLS policy cannot help: 002 defines
 * the insert as `with check (auth.uid() = actor_id and user_id <> actor_id)`,
 * which a caller satisfies simply by passing their own id as `actor_id`. The
 * result was an un-rate-limited notification-spam primitive against any user
 * id, with an attacker-chosen `type`, `game_id` and `comment_id` — and because
 * `UserNotification` renders the actor's username and a link to
 * `/game/<game_id>`, the planted rows looked entirely plausible in the UI.
 *
 * Moving the function into a module *without* the directive makes it a plain
 * server-side function again. It cannot be invoked over HTTP at all, which is
 * the correct shape: notifications are a side effect of another action, never
 * an action in their own right.
 *
 * Note the RLS asymmetry that the same 002 migration fixes: the old policy
 * compared the caller to the *recipient* (`auth.uid() = user_id`), so every
 * insert was rejected with 42501 and swallowed by the caller's `.catch()`.
 * The bell was permanently dead and the only trace was a log line nobody read.
 */

export type NotificationType = 'like' | 'follow' | 'comment' | 'mention';

/**
 * Records a notification for `userId`, authored by `actorId`.
 *
 * The actor is re-derived from the live session rather than trusted, because
 * every caller passes `user.id` and a stale or spoofed argument would insert a
 * row that RLS then rejects — or worse, one that it accepts.
 */
export async function createNotification(
  userId: string,
  actorId: string,
  type: NotificationType,
  logId?: string | null,
  gameId?: number | null,
  commentId?: string | null
): Promise<void> {
  if (!userId || !actorId) return;
  if (userId === actorId) return; // do not notify yourself

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user || user.id !== actorId) {
      console.error('[notify] actor mismatch, refusing insert');
      return;
    }

    const { error } = await supabase.from('notifications').insert({
      user_id: userId,
      actor_id: actorId,
      type,
      log_id: logId ?? null,
      game_id: gameId ?? null,
      comment_id: commentId ?? null,
    });

    // `game_id` is added by migration 002. On a pre-002 database the whole
    // insert is rejected, so retry without the 002-only columns rather than
    // dropping the notification — same progressive-degradation approach the
    // feed and game pages use.
    if (error && /game_id|comment_id|column .* does not exist/i.test(error.message)) {
      const retry = await supabase.from('notifications').insert({
        user_id: userId,
        actor_id: actorId,
        type,
        log_id: logId ?? null,
      });
      if (!retry.error) return;
      console.error('[notify] insert error (degraded):', retry.error.message);
      return;
    }

    if (error) console.error('[notify] insert error:', error.message);
  } catch (err) {
    // A failed notification must never break the action that triggered it.
    console.error('[notify] createNotification failed:', err);
  }
}
