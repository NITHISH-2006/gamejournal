import { headers } from 'next/headers';
import { clientKey } from '@/lib/rate-limit';
import { requireUser } from '@/lib/supabase';

/**
 * Returns a stable rate-limit key for the current caller.
 *
 * Authenticated callers are bucketed per user id so that a shared NAT / office
 * IP does not cause legitimate users to throttle each other.
 */
export async function callerKey(action: string): Promise<string> {
  // Only a *genuine* "not signed in" falls back to the IP bucket.
  //
  // The bare `catch` this replaces swallowed everything `requireUser` can
  // throw — including a misconfigured Supabase project (env.ts throws
  // synchronously) and a network failure during `auth.getUser()`. During an
  // auth outage every signed-in user was therefore bucketed by IP, so a single
  // office or NAT egress point throttled all of them together, and `enforce`
  // threw `RateLimitError` at users who had done nothing wrong. A transient
  // infrastructure fault should not be able to produce a rate-limit error.
  try {
    const user = await requireUser();
    return `${action}:user:${user.id}`;
  } catch (err) {
    const message = (err as Error).message ?? '';
    const genuinelySignedOut =
      message === 'You must be signed in to do that.' ||
      /must be signed in/i.test(message);
    if (!genuinelySignedOut) {
      console.error('[limiter] could not resolve caller identity:', message);
    }
  }
  const headerList = await headers();
  return `${action}:ip:${clientKey(headerList)}`;
}
