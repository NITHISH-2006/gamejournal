/**
 * Shared sentinel for "game search is not configured".
 *
 * This lives outside the `"use server"` modules because a Server Action file
 * may only export async functions, so it cannot export a constant or a
 * predicate. Both the server action and the client import from here.
 */
export const GAME_SEARCH_UNAVAILABLE = 'Game search is not configured on this deployment.';

export function isGameSearchUnavailable(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : '';
  return message.includes(GAME_SEARCH_UNAVAILABLE);
}
