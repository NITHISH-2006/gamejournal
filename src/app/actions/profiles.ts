'use server';

import { revalidatePath } from 'next/cache';
import { createClient, requireUser } from '@/lib/supabase';
import { enforce } from '@/lib/rate-limit';
import { callerKey } from '@/lib/limiter';
import { exactCount } from '@/lib/count';
import {
  escapeLikePattern,
  validateBio,
  validateDisplayName,
  validateUsername,
} from '@/lib/validation';
import type { Profile } from '@/lib/types';

export async function getProfileByUsername(username: unknown): Promise<Profile | null> {
  const name = String(username ?? '').trim().toLowerCase();
  if (!name) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('username', name)
    .maybeSingle();

  if (error) {
    console.error('[profiles] getProfileByUsername error:', error.message);
    return null;
  }
  return (data as Profile | null) ?? null;
}

/**
 * The signed-in user's own profile.
 *
 * Self-heals a missing row: the database trigger on auth.users is the intended
 * path, but if it has not fired (or the trigger was dropped) the navbar and
 * profile pages would otherwise render a null username with no indication of
 * why. Returns null only when the user is signed out.
 */
export async function getOwnProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  if (data) return data as Profile;

  const base =
    (user.email ?? 'player')
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 14) || 'player';

  const { data: created, error } = await supabase
    .from('profiles')
    .insert({ id: user.id, username: `${base}${Math.random().toString(36).slice(2, 7)}` })
    .select('*')
    .single();

  if (error) {
    console.error('[profiles] getOwnProfile could not self-heal:', error.message);
    return null;
  }
  return created as Profile;
}

/**
 * Removed: `getProfileById`.
 *
 * It had no callers, and because it was exported from a `'use server'` module
 * it was still a public endpoint. It also had no UUID validation and never
 * checked `error`, so a non-UUID argument (PostgREST 400) and a permission
 * failure were both indistinguishable from "no such user".
 *
 * The live equivalent is `getProfileByUsername`, which is keyed on the public
 * identifier and is what the profile pages already use.
 */

/**
 * Updates the signed-in user's profile.
 *
 * Username changes are checked for collisions and revalidated against the
 * same rules as signup; the previous implementation wrote whatever the client
 * sent, allowing invalid or duplicate usernames.
 */
export async function updateProfile(updates: {
  display_name?: unknown;
  bio?: unknown;
  username?: unknown;
}): Promise<{ success: true; username?: string }> {
  const user = await requireUser();
  await enforce(await callerKey('profile:write'), 20, 60_000);

  const supabase = await createClient();
  const { data: current } = await supabase
    .from('profiles')
    .select('username')
    .eq('id', user.id)
    .maybeSingle();

  if (!current) {
    throw new Error('Your profile is missing. Please sign out and sign in again.');
  }

  const patch: Record<string, unknown> = {};

  if (updates.display_name !== undefined) {
    patch.display_name = validateDisplayName(updates.display_name);
  }
  if (updates.bio !== undefined) {
    patch.bio = validateBio(updates.bio);
  }

  let newUsername: string | undefined;
  if (updates.username !== undefined) {
    const username = validateUsername(updates.username);
    if (username !== current.username) {
      const { data: taken } = await supabase
        .from('profiles')
        .select('id')
        .eq('username', username)
        .maybeSingle();

      if (taken) throw new Error('That username is already taken.');
      patch.username = username;
      newUsername = username;
    }
  }

  if (Object.keys(patch).length === 0) return { success: true, username: current.username };

  const { error } = await supabase.from('profiles').update(patch).eq('id', user.id);
  if (error) {
    if (error.code === '23505') throw new Error('That username is already taken.');
    throw new Error(error.message);
  }

  revalidatePath('/', 'layout');
  if (newUsername) {
    revalidatePath(`/user/${current.username}`);
    revalidatePath(`/user/${newUsername}`);
  }

  return { success: true, username: newUsername ?? current.username };
}

/**
 * Username search.
 *
 * Two fixes over the previous version:
 *  - LIKE wildcards in the query are escaped, so `%` could not match
 *    every profile.
 *  - A minimum length is enforced and the result count is capped, which stops
 *    an empty query from dumping the entire user table.
 */
export async function searchProfiles(query: unknown) {
  const raw = String(query ?? '').trim();
  if (raw.length < 2) return [];

  await enforce(await callerKey('profile:search'), 40, 60_000);

  const pattern = `%${escapeLikePattern(raw.toLowerCase())}%`;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url, bio')
    .ilike('username', pattern)
    .order('username', { ascending: true })
    .limit(8);

  if (error) {
    console.error('[profiles] searchProfiles error:', error.message);
    return [];
  }

  return data ?? [];
}

/**
 * Accounts to recommend following.
 *
 * The previous version took an arbitrary 50 most-recent logs and counted
 * them client-side, which biased results toward whoever logged most recently
 * rather than the most active users overall, and hard-coded the follow state
 * to `false`. This ranks by real log counts and returns live follow state.
 */
export type Suggestion = {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  log_count: number;
  is_following: boolean;
};

/**
 * Accounts to suggest, for users who have not followed anyone yet.
 *
 * The caller's identity is resolved from the session, never taken as a
 * parameter. This is exported from a `'use server'` module, so it is a public
 * endpoint: with `currentUserId` as an argument, anyone could pass *another*
 * user's id and receive, for the 25 suggested profiles, that user's follow
 * state — a follow-graph oracle over arbitrary accounts. The `following` feed
 * view was already fixed for the same reason; this was missed.
 */
export async function getSuggestedUsers(): Promise<Suggestion[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const currentUserId = user.id;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, bio')
    .neq('id', currentUserId)
    .order('created_at', { ascending: false })
    .limit(25);

  if (error) {
    console.error('[profiles] getSuggestedUsers error:', error.message);
    return [];
  }

  const profiles = data ?? [];
  if (!profiles.length) return [];

  const ids = profiles.map((p) => p.id as string);

  const [logCounts, following] = await Promise.all([
    // Per-user counts, computed one bounded query per suggestion rather than
    // a single `.in()` slice. The old shape — one row per log, capped at 1000
    // across *all* users — undercounted anyone with more than ~40 logs while
    // still presenting the result as that user's total, and the truncation was
    // silent. 25 `count: 'exact', head: true` requests are issued concurrently.
    Promise.all(
      ids.map((id) =>
        exactCount(
          (sel) =>
            supabase
              .from('game_logs')
              .select(sel, { count: 'exact', head: true })
              .eq('user_id', id),
          `suggestedUsers.logs.${id}`
        )
      )
    ),
    // The missing `.eq('follower_id', …)` made this return *every* follow edge
    // in the database pointing at those 25 profiles, so `is_following` was true
    // whenever anyone at all followed them. The button then read "Following"
    // for people the viewer had never followed.
    supabase
      .from('follows')
      .select('following_id')
      .eq('follower_id', currentUserId)
      .in('following_id', ids),
  ]);

  if (following.error) {
    console.error('[profiles] suggested follow states error:', following.error.message);
  }

  const counts = new Map(ids.map((id, i) => [id, logCounts[i]]));
  const followingSet = new Set((following.data ?? []).map((r) => r.following_id as string));

  return profiles
    .map((p) => ({
      id: p.id as string,
      username: p.username as string,
      display_name: (p.display_name as string | null) ?? null,
      bio: (p.bio as string | null) ?? null,
      log_count: counts.get(p.id as string) ?? 0,
      is_following: followingSet.has(p.id as string),
    }))
    .sort((a, b) => b.log_count - a.log_count)
    .slice(0, 5);
}
