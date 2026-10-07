'use server';

import { revalidatePath } from 'next/cache';
import { createClient, requireUser } from '@/lib/supabase';
import { enforce } from '@/lib/rate-limit';
import { callerKey } from '@/lib/limiter';
import {
  escapeLikePattern,
  validateBio,
  validateDisplayName,
  validateUsername,
} from '@/lib/validation';
import type { Profile } from '@/lib/types';
import type { Database } from '@/lib/database.types';

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
  await enforce(await callerKey('profile:write', user.id), 20, 60_000);

  const supabase = await createClient();
  const { data: current } = await supabase
    .from('profiles')
    .select('username')
    .eq('id', user.id)
    .maybeSingle();

  if (!current) {
    throw new Error('Your profile is missing. Please sign out and sign in again.');
  }

  // Only fields the user actually changed. An untouched field is absent from the
  // patch, so the server cannot null it — that is what stops saving an edit
  // from silently erasing the display name and bio.
  const patch: Database['public']['Tables']['profiles']['Update'] = {};

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

  // No `user.id` here on purpose: search is open to signed-out visitors, so the
  // key falls back to the IP bucket. `callerKey` resolves the session through
  // the request-scoped cache, so an authenticated caller is still bucketed per
  // user rather than sharing an IP bucket.
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

  // Ranked in SQL by `get_suggested_users`: one round trip, correct ordering
  // across the whole table.
  //
  // The previous implementation selected the 25 *newest* profiles and then sorted
  // those 25 by log count in JavaScript, which could only reorder within that
  // pool � so a genuinely active player who registered recently was invisible on
  // any site with more than 25 users. It then issued 25 concurrent
  // `count: 'exact', head: true` requests on top, one per candidate, for a
  // homepage render. So: biased *and* 26 round trips.
  //
  // Falls back to the JavaScript path if the RPC is not installed yet, which is
  // the same graceful-degradation contract the rest of this codebase uses.
  const { data: ranked, error: rpcError } = await supabase.rpc('get_suggested_users', {
    p_exclude: currentUserId,
    p_limit: SUGGESTION_LIMIT * 5,
  });

  let candidates: Suggestion[];

  if (rpcError || !ranked || !ranked.length) {
    if (rpcError) {
      console.error('[profiles] get_suggested_users RPC error:', rpcError.message);
    }
    candidates = await suggestedUsersFallback(supabase, currentUserId);
  } else {
    candidates = ranked.map((r) => ({
      id: r.id,
      username: r.username,
      display_name: r.display_name ?? null,
      bio: r.bio ?? null,
      log_count: Number(r.log_count ?? 0),
      is_following: false,
    }));
  }

  if (!candidates.length) return [];

  const ids = candidates.map((c) => c.id);

  // The missing `.eq('follower_id', ...)` made this return *every* follow edge in
  // the database pointing at those profiles, so `is_following` was true whenever
  // anyone at all followed them. The button then read "Following" for people the
  // viewer had never followed.
  const { data: following, error: followError } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', currentUserId)
    .in('following_id', ids);

  if (followError) {
    console.error('[profiles] suggested follow states error:', followError.message);
  }

  const followingSet = new Set((following ?? []).map((r) => r.following_id as string));

  return candidates
    .map((c) => ({ ...c, is_following: followingSet.has(c.id) }))
    .sort((a, b) => b.log_count - a.log_count)
    .slice(0, SUGGESTION_LIMIT);
}

const SUGGESTION_LIMIT = 5;

/**
 * JavaScript ranking, used only when `get_suggested_users` is not installed.
 *
 * Still one round trip: PostgREST computes the aggregate with a nested
 * `game_logs(count)` embed, which replaces the 25 separate count queries.
 */
async function suggestedUsersFallback(
  supabase: Awaited<ReturnType<typeof createClient>>,
  currentUserId: string
): Promise<Suggestion[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, bio, game_logs(count)')
    .neq('id', currentUserId)
    .order('created_at', { ascending: false })
    .limit(SUGGESTION_LIMIT * 5);

  if (error) {
    console.error('[profiles] getSuggestedUsers error:', error.message);
    return [];
  }

  return (data ?? []).map((p) => {
    const nested = p.game_logs as unknown;
    const count = Array.isArray(nested) ? Number(nested[0]?.count ?? 0) : 0;
    return {
      id: p.id,
      username: p.username,
      display_name: p.display_name ?? null,
      bio: p.bio ?? null,
      log_count: Number.isFinite(count) ? count : 0,
      is_following: false,
    };
  });
}
