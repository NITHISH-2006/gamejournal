'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, Home, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Route-level error boundary.
 *
 * The app previously had no `error.tsx` anywhere. A thrown error in a Server
 * Component produced Next's default unstyled error page, so an RLS or network
 * failure looked like a broken deployment.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Replace with your error reporter (Sentry, etc.) in production.
    console.error('[route error]', error.message, error.digest);
  }, [error]);

  const isNotFound = error.message.toLowerCase().includes('not found');

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center px-6 text-center">
      <span
        className="mb-6 flex size-16 items-center justify-center rounded-2xl bg-rose-500/12"
        aria-hidden="true"
      >
        <AlertTriangle className="size-7 text-rose-400" />
      </span>

      <h1 className="font-heading text-2xl font-bold tracking-tight">
        {isNotFound ? 'We could not find that' : 'Something went wrong'}
      </h1>

      <p className="mt-2 text-pretty text-muted-foreground">
        {isNotFound
          ? 'The page you are looking for does not exist, or is not shared publicly.'
          : 'An unexpected error occurred while loading this page. This has been logged.'}
      </p>

      {error.digest && (
        <p className="mt-2 font-mono text-[0.65rem] text-ink-faint">
          Reference: {error.digest}
        </p>
      )}

      <div className="mt-8 flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={reset}>
          <RotateCcw />
          Try again
        </Button>
        <Link href="/">
          <Button variant="glass">
            <Home />
            Back to home
          </Button>
        </Link>
      </div>
    </div>
  );
}
