import { revalidatePath } from 'next/cache';

/**
 * Invalidate every surface a list mutation can be visible on.
 *
 * List and watchlist writes previously revalidated only `/profile` and
 * `/list/<id>`. But `/user/[username]` renders the user's *public* lists, and
 * `updateList` can flip `is_public` — so toggling a list to public, or adding
 * a game to a public watchlist, left the public profile serving stale data
 * until the ISR window expired.
 *
 * `revalidatePath('/', 'layout')` invalidates the whole tree in one call. It is
 * what logs, likes and follows already do, and the cost is a re-render rather
 * than a database write, so consistency is worth more here than surgical
 * invalidation.
 */
export function revalidateAll(): void {
  revalidatePath('/', 'layout');
}

/**
 * Targeted invalidation for a single list, alongside `revalidateAll()`.
 *
 * `listId` is optional: adding or removing a *game* on an existing list changes
 * the list page but has no separate page of its own, so those callers only need
 * the tree invalidation.
 */
export function revalidateList(listId?: string): void {
  revalidateAll();
  if (listId) revalidatePath(`/list/${listId}`);
}

/**
 * Invalidate every surface a log mutation is visible on.
 *
 * `gameId` is the game's IGDB id, which is what `/game/[id]` is keyed on, so the
 * game page is invalidated even though no log permalink exists.
 */
export function revalidateLogPaths(userId: string, gameId: number): void {
  revalidateAll();
  revalidatePath('/profile');
  if (gameId) revalidatePath(`/game/${gameId}`);
  // No `revalidatePath('/api/og/log')` here any more. That is a route *handler*
  // path, not a cacheable page, so the call was a no-op. The OG cards have their
  // own long-lived CDN cache and are keyed by log id, so they cannot be
  // invalidated from here regardless.
}