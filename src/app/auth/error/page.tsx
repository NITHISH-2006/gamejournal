import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Friendly destination for a failed auth callback.
 *
 * The callback route redirects here with a short `reason` code rather than a raw
 * Supabase error string: PostgREST messages leak table and column names, and
 * this page is reachable without authentication.
 *
 * A Server Component, not a Client Component: `searchParams` is available
 * synchronously, so reading the reason needs no `useState`/`useEffect` round
 * trip. The previous client version rendered the explanation and then filled in
 * the error on the next paint, which is both a cascading render and a visible
 * flash of the wrong content.
 */
export const metadata: Metadata = {
  title: 'Sign-in link problem',
  description: 'That sign-in link expired or could not be used.',
  // Never index. This page exists only as a dead end for one visitor.
  robots: { index: false, follow: false },
};

/**
 * Copy per reason code. An unrecognised code is deliberately not echoed — the
 * previous version rendered `reason` verbatim, which meant whatever ended up in
 * the query string appeared on the page.
 */
const REASONS: Record<string, string> = {
  missing_code:
    'That link was incomplete — the sign-in code was missing from it. Links sometimes get truncated by email clients.',
  expired: 'That link has expired. Recovery links are valid for a short window.',
  invalid: 'That link was not recognised. It may have already been used.',
  already_used: 'That link has already been used. Request a fresh one.',
  unknown: 'We could not complete that sign-in. Requesting a new link will usually fix it.',
};

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const explanation = REASONS[reason ?? ''] ?? REASONS.unknown;

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-6 text-center">
      <span className="brand-gradient mb-6 flex size-16 items-center justify-center rounded-2xl">
        <AlertTriangle className="size-8 text-white" />
      </span>
      <h1 className="font-heading text-2xl font-bold tracking-tight">
        That sign-in link did not work
      </h1>
      <p className="mt-3 text-pretty text-ink-muted">{explanation}</p>

      <div className="mt-8 flex flex-wrap justify-center gap-2">
        {/* Both buttons used to point at `/`, so "Try signing in again" was a
            second link to the same place with a different label. */}
        <Link href="/">
          <Button variant="glass">Back to home</Button>
        </Link>
        <Link href="/?signin=1">
          <Button variant="primary">Sign in again</Button>
        </Link>
      </div>
    </div>
  );
}