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
import type { Database } from '@/lib/database.types';

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
  await enforce(await callerKey('list:create', user.id), 20, 60_000);

  const listName = validateListName(name);
  const listDescription = validateListDescription(description);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('lists')
    .insert({
      user_id: user.id,
      name: listName,
      description: listDescription,
      // Coerced, not trusted. `isPublic` is typed `boolean` but this is a public
// Server Action endpoint, so the runtime value is caller-supplied; a non-boolean
// reached a boolean column and came back as a raw PostgREST 400. The sibling
// `updateList` already did this.
is_public: Boolean(isPublic),
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
  await enforce(await callerKey('list:mutate', user.id), 60, 60_000);

  const id = validateUuid(listId, 'list id');
  const gid = validateGameId(gameId);

  await assertOwnership(id, user.id);

  const supabase = await createClient();
  const { error } = await supabase
    .from('list_games')
    .insert({ list_id: id, game_id: gid });

  if (error && error.code !== '23505') throw new Error(error.message);

  // These two are reached from `AddToListButton`, which calls them directly.
  // Every sibling in this file revalidates (`createList`, `deleteList`,
  // `updateList`), so omitting it here left `/list/<id>`, `/profile` and
  // `/user/<username>` serving stale game counts until ISR expired.
  revalidateList();
  return { success: true };
}

export async function removeGameFromList(
  listId: unknown,
  gameId: unknown
): Promise<{ success: true }> {
  const user = await requireUser();
  await enforce(await callerKey('list:mutate', user.id), 60, 60_000);

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

  revalidateList();
  return { success: true };
}

export async function deleteList(listId: unknown): Promise<{ success: true }> {
  const user = await requireUser();
  await enforce(await callerKey('list:delete', user.id), 20, 60_000);

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
  await enforce(await callerKey('list:mutate', user.id), 30, 60_000);

  const id = validateUuid(listId, 'list id');
  await assertOwnership(id, user.id);

  // Typed as the table's `Update` shape rather than `Record<string, unknown>`
  // so a field that is not a real column is a compile error.
  const update: Database['public']['Tables']['lists']['Update'] = {};
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

/**
 * Removed: `addGameToOwnedLists`.
 *
 * It had no callers, but a `'use server'` module registers *every* exported
 * async function as a publicly reachable POST endpoint, with no way to opt one
 * out. This one performed a bulk insert across up to 50 caller-supplied list
 * ids, so it was reachable attack surface with real write cost.
 */
