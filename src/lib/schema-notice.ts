/**
 * One-time logging for degraded schema paths.
 *
 * ── Why this is not in `app/actions/feed.ts` ────────────────────────────────
 *
 * That module starts with `'use server'`, and every `export` in such a file
 * must be an `async function` — anything else is a build error ("Server Actions
 * must be async functions"). So a synchronous reporting helper cannot live
 * there. This is the same constraint that forced `createNotification` out of
 * `app/actions/notifications.ts`, and for the same reason: `'use server'`
 * cannot express "this is a plain function, not an endpoint".
 *
 * ── Why it only logs once ──────────────────────────────────────────────────
 *
 * The app degrades gracefully when `002_fixes_and_features.sql` has not been
 * applied: the feed and game pages try a sequence of projections and use the
 * first the database accepts. Those failed attempts are the *mechanism*, not
 * incidents — logging each one produced three `console.error` lines on every
 * home page render, which is precisely why the real errors in this log had
 * become impossible to find.
 *
 * The condition is a property of the database, not of the request, so it is
 * reported once per process and the full guidance is only shown the first time.
 */

/** Scopes already reported, so a degraded path stays quiet afterwards. */
const announced = new Set<string>();

export function announceDegraded(scope: string, detail: string): void {
  if (announced.has(scope)) return;
  announced.add(scope);
  console.warn(
    `[schema] ${scope} is using a fallback: ${detail}. ` +
      'Apply supabase/migrations/002_fixes_and_features.sql to remove this.'
  );
}
