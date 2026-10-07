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

/** Targeted invalidation for a single list, used alongside revalidateAll(). */
export function revalidateList(listId: string): void {
  revalidateAll();
  revalidatePath(`/list/${listId}`);
}
