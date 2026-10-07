'use server';

import { createClient, requireUser } from '@/lib/supabase';
import { revalidateAll, revalidateList } from '@/lib/revalidate';
import { enforce } from '@/lib/rate-limit';
import { callerKey } from '@/lib/limiter';
import {
  validateGameId,
  validateListDescription,
  validateListName,
  validateUuid,
} from '@/lib/validation';
import type { UserList } from '@/lib/types';

/**
 * Security note
 * -------------
 * The previous `addGameToList` / `removeGameFromList` accepted any list id
 * and wrote to it without checking ownership. Any authenticated user could
 * mutate another person's list by guessing its UUID. Every mutation below now
 * asserts `list.user_id === currentUser` before writing.
 *
 * Reads are also gated on `is_public`; previously `/list/[id]` exposed private
 * lists to anyone who had the URL.
 */

export async function createList(
  name: unknown,
  description?: unknown,
  isPublic = false
): Promise<{ id: string }> {
  const user = await requireUser();
  await enforce(await callerKey('list:create'), 20, 60_000);

  const listName = validateListName(name);
  const listDescription = validateListDescription(description);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('lists')
    .insert({
      user_id: user.id,
      name: listName,
      description: listDescription,
      is_public: isPublic,
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error('You already have a list with that name.');
    }
    throw new Error(error.message);
  }

  revalidateAll();
  return { id: data.id };
}

type ListRow = {
  id: string;
  name: string;
  description: string | null;
  is_public: boolean;
  created_at: string;
  list_games: { game_id: number; games: { name: string; cover_url: string | null } | { name: string; cover_url: string | null }[] | null }[] | null;
};

function shapeList(row: ListRow): UserList {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    is_public: Boolean(row.is_public),
    created_at: row.created_at,
    games: (row.list_games ?? [])
      .map((entry) => {
        const relation = entry.games;
        const game = Array.isArray(relation) ? relation[0] : relation;
        return {
          gameId: entry.game_id,
          name: game?.name ?? 'Unknown',
          coverUrl: game?.cover_url ?? null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Lists belonging to a user, filtered to public ones when not the owner. */
export async function getUserLists(
  userId: unknown,
  opts: { includePrivate?: boolean } = {}
): Promise<UserList[]> {
  const id = validateUuid(userId, 'user id');
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('lists')
    .select('id, name, description, is_public, created_at, list_games ( game_id, games ( name, cover_url ) )')
    .eq('user_id', id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[lists] getUserLists error:', error.message);
    return [];
  }

  let rows = (data ?? []) as unknown as ListRow[];

  if (!opts.includePrivate) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user?.id !== id) {
      rows = rows.filter((row) => row.is_public);
    }
  }

  return rows.map(shapeList);
}

/** A single list, honouring privacy. Returns null when not visible. */
export async function getListById(listId: unknown): Promise<UserList | null> {
  const id = validateUuid(listId, 'list id');
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('lists')
    .select('id, name, description, is_public, created_at, user_id, list_games ( game_id, games ( name, cover_url ) )')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[lists] getListById error:', error.message);
    return null;
  }
  if (!data) return null;

  const row = data as unknown as ListRow & { user_id: string };

  if (!row.is_public) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user?.id !== row.user_id) return null;
  }

  return shapeList(row);
}

/** Asserts the list exists and belongs to the current user. */
async function assertOwnership(listId: string, userId: string): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('lists')
    .select('user_id')
    .eq('id', listId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error('That list does not exist.');
  if (data.user_id !== userId) {
    throw new Error('You do not have permission to change that list.');
  }
}

export async function addGameToList(
  listId: unknown,
  gameId: unknown
): Promise<{ success: true }> {
  const user = await requireUser();
  await enforce(await callerKey('list:mutate'), 60, 60_000);

  const id = validateUuid(listId, 'list id');
  const gid = validateGameId(gameId);

  await assertOwnership(id, user.id);

  const supabase = await createClient();
  const { error } = await supabase
    .from('list_games')
    .insert({ list_id: id, game_id: gid });

  if (error && error.code !== '23505') throw new Error(error.message);
  return { success: true };
}

export async function removeGameFromList(
  listId: unknown,
  gameId: unknown
): Promise<{ success: true }> {
  const user = await requireUser();
  await enforce(await callerKey('list:mutate'), 60, 60_000);

  const id = validateUuid(listId, 'list id');
  const gid = validateGameId(gameId);

  await assertOwnership(id, user.id);

  const supabase = await createClient();
  const { error } = await supabase
    .from('list_games')
    .delete()
    .eq('list_id', id)
    .eq('game_id', gid);

  if (error) throw new Error(error.message);
  return { success: true };
}

export async function deleteList(listId: unknown): Promise<{ success: true }> {
  const user = await requireUser();
  await enforce(await callerKey('list:delete'), 20, 60_000);

  const id = validateUuid(listId, 'list id');
  await assertOwnership(id, user.id);

  const supabase = await createClient();
  const { error } = await supabase.from('lists').delete().eq('id', id);
  if (error) throw new Error(error.message);

  revalidateAll();
  return { success: true };
}

/** Rename / re-describe / change visibility of a list. */
export async function updateList(
  listId: unknown,
  patch: { name?: unknown; description?: unknown; isPublic?: unknown }
): Promise<{ success: true }> {
  const user = await requireUser();
  await enforce(await callerKey('list:mutate'), 30, 60_000);

  const id = validateUuid(listId, 'list id');
  await assertOwnership(id, user.id);

  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = validateListName(patch.name);
  if (patch.description !== undefined) {
    update.description = validateListDescription(patch.description);
  }
  if (patch.isPublic !== undefined) update.is_public = Boolean(patch.isPublic);

  if (!Object.keys(update).length) return { success: true };

  const supabase = await createClient();
  const { error } = await supabase.from('lists').update(update).eq('id', id);
  if (error) {
    if (error.code === '23505') {
      throw new Error('You already have a list with that name.');
    }
    throw new Error(error.message);
  }

  revalidateList(id);
  return { success: true };
}

/** Adds a game to every list owned by a user (used by the watchlist flow). */
export async function addGameToOwnedLists(
  listIds: unknown[],
  gameId: unknown
): Promise<void> {
  const user = await requireUser();
  // The only mutating action in this file with no `enforce(...)`, unlike the
  // four around it. It performs a bulk insert, so an unbounded caller could
  // otherwise drive large writes.
  await enforce(await callerKey('list:write'), 60, 60_000);
  const gid = validateGameId(gameId);
  const ids = (listIds ?? [])
    .map((v) => {
      try {
        return validateUuid(v, 'list id');
      } catch {
        return null;
      }
    })
    .filter((v): v is string => v !== null)
    .slice(0, 50);

  if (!ids.length) return;

  const supabase = await createClient();
  const { data, error: ownershipError } = await supabase
    .from('lists')
    .select('id')
    .eq('user_id', user.id)
    .in('id', ids);

  // Previously unchecked. On failure `owned` was empty, `insertable` was empty,
  // and the function returned having done nothing at all — "add to all my
  // lists" silently no-oped. A failed ownership check is not evidence that the
  // caller owns nothing.
  if (ownershipError) {
    console.error('[lists] addGameToOwnedLists ownership check failed:', ownershipError.message);
    throw new Error('Could not check which lists you own. Please try again.');
  }

  const owned = new Set((data ?? []).map((l) => l.id));
  const insertable = ids.filter((v) => owned.has(v));
  if (!insertable.length) return;

  const { error } = await supabase
    .from('list_games')
    .insert(insertable.map((list_id) => ({ list_id, game_id: gid })));

  // 23505 means the game was already on the list, which is the desired state.
  if (error && error.code !== '23505') {
    console.error('[lists] addGameToOwnedLists error:', error.message);
    throw new Error('Could not add that game to your lists. Please try again.');
  }
}

/**
 * Removed: `export { getCapabilities }`.
 *
 * The comment claimed it was re-exported for the watchlist, but the watchlist
 * imports it from `@/lib/capabilities` and nothing imported it from here — so
 * this re-export existed only to turn a plain library function into a public
 * Server Action endpoint that runs a database probe on demand. Being `async` and
 * exported from a `'use server'` module is sufficient to register it; there is
 * no way to opt a single export out.
 */
