'use server';

import { revalidatePath } from 'next/cache';
import { createClient, requireUser } from '@/lib/supabase';
import { enforce } from '@/lib/rate-limit';
import { callerKey } from '@/lib/limiter';
import { createNotification } from '@/lib/notify';
import { validateUuid } from '@/lib/validation';
import { exactCount } from '@/lib/count';

/** Toggles follow state and returns the authoritative result. */
export async function toggleFollow(
  targetUserId: unknown
): Promise<{ following: boolean; followers: number }> {
  const user = await requireUser();
  await enforce(await callerKey('follow:write', user.id), 60, 60_000);

  const targetId = validateUuid(targetUserId, 'user id');
  if (targetId === user.id) throw new Error('You cannot follow yourself.');

  const supabase = await createClient();

  // Confirm the target exists so we do not create dangling follow rows.
  const { data: target, error: targetError } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('id', targetId)
    .maybeSingle();

  if (targetError) throw new Error(targetError.message);
  if (!target) throw new Error('That user does not exist.');

  // `maybeSingle()` returns null for zero rows but *errors* when more than one
  // matches, and the error was being discarded. Read as a plain array ordered
  // oldest-first so a legacy duplicate can never wedge the toggle.
  //
  // The projection is `'*'`, not `'id'`. `follows` is keyed on
  // `(follower_id, following_id)` and only gained a surrogate `id` in migration
  // 002. `select('id')` therefore fails with 42703 on a pre-002 database, and
  // PostgREST reports that with an *empty* message â€” so with the error
  // unchecked, `existingRows` was null, the toggle always took the INSERT
  // branch, and unfollowing was impossible.
  const { data: existingRows, error: readError } = await supabase
    .from('follows')
    .select('*')
    .eq('follower_id', user.id)
    .eq('following_id', targetId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (readError) throw new Error(readError.message || 'Could not read your follows.');

  const existing = existingRows?.[0];
  let following: boolean;

  if (existing) {
    // Delete by the composite key rather than the surrogate id so this works
    // whether or not 002's backfill has been applied yet.
    const { error } = await supabase
      .from('follows')
      .delete()
      .eq('follower_id', user.id)
      .eq('following_id', targetId);
    if (error) throw new Error(error.message);
    following = false;
  } else {
    const { error } = await supabase
      .from('follows')
      .insert({ follower_id: user.id, following_id: targetId });
    if (error) {
      // A concurrent double-click can win the race. Re-read so the UI still
      // settles on the truth instead of surfacing a raw constraint error.
      if (error.code === '23505') {
        // `'*'` for the same reason as the read above: this re-read would also
        // 42703 on a pre-002 database, leaving `raced` null and turning the
        // race into a thrown error with PostgREST's empty message â€” a blank
        // error dialog for the user.
        const { data: raced, error: raceError } = await supabase
          .from('follows')
          .select('*')
          .eq('follower_id', user.id)
          .eq('following_id', targetId)
          .limit(1);

        if (raceError) {
          throw new Error(raceError.message || 'Could not update your follows.');
        }
        if (raced?.length) {
          const { error: delErr } = await supabase
            .from('follows')
            .delete()
            .eq('follower_id', user.id)
            .eq('following_id', targetId);
          if (delErr) throw new Error(delErr.message);
          following = false;
        } else {
          // No row exists, so there is no follow edge in the database. A
          // concurrent double-click raced: our INSERT hit the unique constraint
          // because the paired DELETE had already removed the row, meaning the
          // un-follow is what actually persisted.
          //
          // The previous value here was `true`, which rendered the button as
          // "Following" for a follow that does not exist until the next refresh.
          following = false;
        }
      } else {
        throw new Error(error.message);
      }
    } else {
      following = true;
      await createNotification(targetId, user.id, 'follow').catch(() => {});
    }
  }

  const count = await exactCount(
    (sel) =>
      supabase
        .from('follows')
        .select(sel, { count: 'exact', head: true })
        .eq('following_id', targetId),
    'follows.afterToggle'
  );

  // Revalidate using the *username*, because the public route is
  // /user/[username]. The previous code revalidated /user/${userId}, which
  // matched no route, so follower counts never refreshed.
  revalidatePath('/', 'layout');
  revalidatePath('/discover');
  revalidatePath(`/user/${target.username}`);

  return { following, followers: count };
}

/**
 * Explicit follow. Kept for callers that want an idempotent "ensure followed".
 * This is NOT a toggle â€” the previous version delegated to `toggleFollow`, so
 * calling it on someone you already followed *unfollowed* them.
 */
export async function followUser(followingId: unknown): Promise<void> {
  const user = await requireUser();
  await enforce(await callerKey('follow:write', user.id), 60, 60_000);

  const targetId = validateUuid(followingId, 'user id');
  if (targetId === user.id) throw new Error('You cannot follow yourself.');

  const supabase = await createClient();
  const { error } = await supabase
    .from('follows')
    .upsert(
      { follower_id: user.id, following_id: targetId },
      { onConflict: 'follower_id,following_id', ignoreDuplicates: true }
    );
  if (error) throw new Error(error.message);
}

/**
 * Explicit unfollow. Delete-only: the previous version delegated to
 * `toggleFollow`, so calling it on someone you did *not* follow created the
 * follow and fired a notification.
 */
export async function unfollowUser(followingId: unknown): Promise<void> {
  const user = await requireUser();
  await enforce(await callerKey('follow:write', user.id), 60, 60_000);

  const targetId = validateUuid(followingId, 'user id');
  const supabase = await createClient();

  // Resolve the username so the target's public page is revalidated, and so a
  // well-formed-but-unknown id reports "That user does not exist." instead of
  // surfacing a raw Postgres 23503 foreign-key violation.
  const { data: target, error: targetError } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('id', targetId)
    .maybeSingle();

  if (targetError) throw new Error(targetError.message);
  if (!target) throw new Error('That user does not exist.');

  const { error } = await supabase
    .from('follows')
    .delete()
    .eq('follower_id', user.id)
    .eq('following_id', targetId);
  if (error) throw new Error(error.message);

  // Match `toggleFollow`: an unfollow through this path used to revalidate only
  // the layout, so the *target's* public profile kept serving a stale follower
  // count until ISR expired.
  revalidatePath('/', 'layout');
  revalidatePath('/discover');
  revalidatePath(`/user/${target.username}`);
}

export async function getFollowCounts(userId: unknown) {
  const id = validateUuid(userId, 'user id');
  const supabase = await createClient();

  const [followers, following] = await Promise.all([
    exactCount(
      (sel) =>
        supabase
          .from('follows')
          .select(sel, { count: 'exact', head: true })
          .eq('following_id', id),
      'follows.followers'
    ),
    exactCount(
      (sel) =>
        supabase
          .from('follows')
          .select(sel, { count: 'exact', head: true })
          .eq('follower_id', id),
      'follows.following'
    ),
  ]);

  return { followers, following };
}

export async function isFollowing(followingId: unknown): Promise<boolean> {
  const id = validateUuid(followingId, 'user id');
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { data } = await supabase
    .from('follows')
    .select('follower_id')
    .eq('follower_id', user.id)
    .eq('following_id', id)
    .maybeSingle();

  return Boolean(data);
}

/**
 * Batch follow state for a set of users.
 *
 * The previous SuggestedUsers component hard-coded `initialFollowing={false}`,
 * so the button read "Follow" even when you already followed the person.
 */
export async function getFollowStates(
  targetIds: string[]
): Promise<Record<string, boolean>> {
  const ids = (targetIds ?? []).filter((v) => typeof v === 'string').slice(0, 200);
  if (!ids.length) return {};

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return {};

  const { data, error } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', user.id)
    .in('following_id', ids);

  if (error) {
    console.error('[follows] getFollowStates error:', error.message);
    return {};
  }

  const following = new Set((data ?? []).map((r) => r.following_id));
  const result: Record<string, boolean> = {};
  for (const id of ids) result[id] = following.has(id);
  return result;
}

export type FollowListEntry = {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  created_at: string;
};

/** People who follow `userId`. */
export async function getFollowers(
  userId: unknown,
  limit = 50
): Promise<FollowListEntry[]> {
  const id = validateUuid(userId, 'user id');
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('follows')
    .select('follower_id, profiles!follows_follower_id_fkey ( id, username, display_name, bio, avatar_url, created_at )')
    .eq('following_id', id)
    .order('created_at', { ascending: false })
    .limit(clampLimit(limit));

  if (error) {
    console.error('[follows] getFollowers error:', error.message);
    return [];
  }

  return (data ?? [])
    .map((row) => unwrapProfile(row.profiles))
    .filter((p): p is FollowListEntry => p !== null);
}

/** People that `userId` follows. */
export async function getFollowing(
  userId: unknown,
  limit = 50
): Promise<FollowListEntry[]> {
  const id = validateUuid(userId, 'user id');
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('follows')
    .select('following_id, profiles!follows_following_id_fkey ( id, username, display_name, bio, avatar_url, created_at )')
    .eq('follower_id', id)
    .order('created_at', { ascending: false })
    .limit(clampLimit(limit));

  if (error) {
    console.error('[follows] getFollowing error:', error.message);
    return [];
  }

  return (data ?? [])
    .map((row) => unwrapProfile(row.profiles))
    .filter((p): p is FollowListEntry => p !== null);
}

/**
 * Bounds a client-supplied page size.
 *
 * The limit = 50 default was the only clamp, and a TypeScript default is not
 * a runtime one: a caller passing 1e9 sent that straight to PostgREST.
 *
 * Number.isFinite rather than Math.min, because Math.min(NaN, 100) is
 * NaN and .limit(NaN) makes PostgREST reject the whole query.
 */
function clampLimit(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(Math.trunc(n), 1), 100);
}

/** PostgREST returns a single relation as an object and a many relation as an array. */
function unwrapProfile(value: unknown): FollowListEntry | null {
  const record = Array.isArray(value) ? value[0] : value;
  if (!record || typeof record !== 'object') return null;
  return record as FollowListEntry;
}
