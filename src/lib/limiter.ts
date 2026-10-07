import { headers } from 'next/headers';
import { cache } from 'react';
import { clientKey } from '@/lib/rate-limit';
import { requireUser } from '@/lib/supabase';

/**
 * Returns a stable rate-limit key for the current caller.
 *
 * Authenticated callers are bucketed per user id so that a shared NAT / office
 * IP does not cause legitimate users to throttle each other.
 *
 * `userId` is optional. Pass the id you already resolved and no second lookup
 * happens; omit it and it is resolved once per request (see `getUserCached`).
 * Every write action needs the user *and* a rate-limit key, so without this
 * each one paid two `auth.getUser()` calls — and `auth.getUser()` is a network
 * round trip that validates the JWT against Supabase, not a cookie read.
 */
export async function callerKey(action: string, userId?: string): Promise<string> {
  // Only a *genuine* "not signed in" falls back to the IP bucket.
  //
  // The bare `catch` this replaces swallowed everything `requireUser` can
  // throw — including a misconfigured Supabase project (env.ts throws
  // synchronously) and a network failure during `auth.getUser()`. During an
  // auth outage every signed-in user was therefore bucketed by IP, so a single
  // office or NAT egress point throttled all of them together, and `enforce`
  // threw `RateLimitError` at users who had done nothing wrong. A transient
  // infrastructure fault should not be able to produce a rate-limit error.
  const resolved = userId ?? (await getUserCached());
  if (resolved) return `${action}:user:${resolved}`;

  const headerList = await headers();
  return `${action}:ip:${clientKey(headerList)}`;
}

/**
 * Resolves the signed-in user at most once per request.
 *
 * React's `cache()` scopes to a single render/request pass, which is exactly
 * the lifetime a user session is valid for. This is safe to share across
 * components within one request: the user cannot change mid-request.
 *
 * Before this, a single `saveGameLog` call constructed five Supabase clients
 * and made four `auth.getUser()` round trips — `requireUser`, `callerKey` inside
 * `enforce`, `ensureGameCached`'s own `requireUser` + `callerKey`, and finally
 * the action's own client — all to learn the same id.
 */
export const getUserCached = cache(async (): Promise<string | null> => {
  try {
    const user = await requireUser();
    return user.id;
  } catch (err) {
    const message = (err as Error).message ?? '';
    const genuinelySignedOut =
      message === 'You must be signed in to do that.' ||
      /must be signed in/i.test(message);
    if (!genuinelySignedOut) {
      console.error('[limiter] could not resolve caller identity:', message);
    }
    return null;
  }
});
