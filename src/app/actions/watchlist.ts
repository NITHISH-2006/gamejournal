'use server';

import { revalidateAll } from '@/lib/revalidate';
import { createClient, requireUser } from '@/lib/supabase';
import { ensureGameCached } from '@/app/actions/igdb';
import { enforce } from '@/lib/rate-limit';
import { callerKey } from '@/lib/limiter';
import { validateGameId, validateGamePayload } from '@/lib/validation';

const WATCHLIST_NAME = 'Plan to Play';

const WATCHLIST_DESCRIPTION = 'Games you want to play next';

/**
 * Returns the user's watchlist id, creating it only if it does not exist.
 *
 * The previous version raced: two concurrent calls could both observe "no
 * list" and both insert, producing duplicate watchlists. It also used
 * `maybeSingle()`, which *throws* when more than one row exists - turning a
 * historical duplicate into a permanently broken watchlist. We now fetch
 * defensively and tolerate duplicates by picking the oldest.
 *
 * Two further fixes:
 *  - The list is located by the `kind` discriminator added in 002, not by its
 *    display name. Matching on `name = 'Plan to Play'` meant a user who
 *    created a *custom* list with that title had it silently adopted as their
 *    watchlist, so watchlist badges and toggles started mutating the wrong list.
 *  - `is_public` is now false. It was true, which auto-published a list on the
 *    user's public profile the moment they watched their first game, with no
 *    consent and no UI. `createList` already defaults to private.
 */
async function getOrCreateWatchlist(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<string> {
  const { data: existing, error: readError } = await supabase
    .from('lists')
    .select('id')
    .eq('user_id', userId)
    .eq('kind', 'watchlist')
    .order('created_at', { ascending: true })
    .limit(1);

  if (readError) {
    // Previously logged and then ignored, so a failed read fell straight
    // through to the INSERT. That insert then violated
    // `lists_user_watchlist_uniq` (the row we failed to read is still there),
    // the recovery read failed too, and the user was told "Could not create
    // your watchlist" — a write failure caused by a read blip, pointing at the
    // wrong thing. A read we could not complete is not evidence of absence.
    console.error('[watchlist] lookup error:', readError.message);
    throw new Error('Could not check your watchlist. Please try again.');
  }

  if (existing && existing.length > 0) return existing[0].id as string;

  const { data: created, error } = await supabase
    .from('lists')
    .insert({
      user_id: userId,
      name: WATCHLIST_NAME,
      description: WATCHLIST_DESCRIPTION,
      kind: 'watchlist',
      is_public: false,
    })
    .select('id')
    .single();

  if (error) {
    // Lost a race: another request created it first, so read it back.
    const { data: raced } = await supabase
      .from('lists')
      .select('id')
      .eq('user_id', userId)
      .eq('kind', 'watchlist')
      .order('created_at', { ascending: true })
      .limit(1);

    if (raced && raced.length > 0) return raced[0].id as string;
    throw new Error('Could not create your watchlist. Please try again.');
  }

  return created.id;
}

/** Returns the watchlist id if it exists, without ever creating it. */
async function findWatchlistId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<string | null> {
  // A failed read used to return null, which callers read as "no watchlist
  // yet" — so `toggleWatchlist` went on to create one, and the membership
  // check reported every game as absent. Distinguishing the two is the whole
  // point of this function.
  const { data, error } = await supabase
    .from('lists')
    .select('id')
    .eq('user_id', userId)
    .eq('kind', 'watchlist')
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) {
    console.error('[watchlist] findWatchlistId error:', error.message);
    throw new Error('Could not check your watchlist. Please try again.');
  }

  return data && data.length > 0 ? (data[0].id as string) : null;
}

export async function toggleWatchlist(game: unknown): Promise<{ inWatchlist: boolean }> {
  const user = await requireUser();
  await enforce(await callerKey('watchlist:write'), 60, 60_000);

  const parsed = validateGamePayload(game);
  const gid = validateGameId(parsed.id);
  const supabase = await createClient();

  const listId = await findWatchlistId(supabase, user.id);

  if (listId) {
    const { data: membership } = await supabase
      .from('list_games')
      .select('game_id')
      .eq('list_id', listId)
      .eq('game_id', gid)
      .maybeSingle();

    if (membership) {
      const { error } = await supabase
        .from('list_games')
        .delete()
        .eq('list_id', listId)
        .eq('game_id', gid);
      if (error) throw new Error(error.message);
      revalidateAll();
      return { inWatchlist: false };
    }
  }

  await ensureGameCached(parsed);
  const targetListId = listId ?? (await getOrCreateWatchlist(supabase, user.id));

  const { error } = await supabase
    .from('list_games')
    .insert({ list_id: targetListId, game_id: gid });

  if (error && error.code !== '23505') throw new Error(error.message);

  revalidateAll();
  return { inWatchlist: true };
}

export async function addToWatchlist(game: unknown): Promise<void> {
  await toggleWatchlist(game);
}

export async function removeFromWatchlist(gameId: unknown): Promise<void> {
  const user = await requireUser();
  const gid = validateGameId(gameId);
  const supabase = await createClient();

  // Previously this called getOrCreateWatchlist(), which would *create* a
  // watchlist purely as a side effect of removing a game from it.
  const listId = await findWatchlistId(supabase, user.id);
  if (!listId) return; // nothing to remove from

  const { error } = await supabase
    .from('list_games')
    .delete()
    .eq('list_id', listId)
    .eq('game_id', gid);

  if (error) throw new Error(error.message);
  revalidateAll();
}

/** Watchlist membership for many games at once (single round trip). */
export async function getWatchlistMembership(
  gameIds: number[]
): Promise<Record<number, boolean>> {
  const ids = (gameIds ?? [])
    .map((v) => {
      try {
        return validateGameId(v);
      } catch {
        return null;
      }
    })
    .filter((v): v is number => v !== null)
    .slice(0, 200);

  const result: Record<number, boolean> = {};
  if (!ids.length) return result;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return result;

  const listId = await findWatchlistId(supabase, user.id);
  if (!listId) return result;

  const { data, error } = await supabase
    .from('list_games')
    .select('game_id')
    .eq('list_id', listId)
    .in('game_id', ids);

  if (error) {
    console.error('[watchlist] membership error:', error.message);
    return result;
  }

  const inList = new Set((data ?? []).map((r) => r.game_id));
  for (const id of ids) result[id] = inList.has(id);
  return result;
}

export async function isInWatchlist(gameId: unknown): Promise<boolean> {
  const gid = validateGameId(gameId);
  const membership = await getWatchlistMembership([gid]);
  return membership[gid] ?? false;
}
