import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Friendly destination for a failed auth callback.
 *
 * The callback route redirects here with a `reason` query parameter rather than
 * showing a raw Supabase error string on a blank page.
 *
 * A Server Component, not a Client Component: `searchParams` is available
 * synchronously, so reading the reason needs no `useState`/`useEffect` round
 * trip. The previous client version rendered the explanation and then filled in
 * the error on the next paint, which is both a cascading render and a visible
 * flash of the wrong content.
 */
export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-6 text-center">
      <span className="brand-gradient mb-6 flex size-16 items-center justify-center rounded-2xl">
        <AlertTriangle className="size-8 text-white" />
      </span>
      <h1 className="font-heading text-2xl font-bold tracking-tight">
        That sign-in link did not work
      </h1>
      <p className="mt-2 text-pretty text-muted-foreground">
        Confirmation and recovery links expire, and they can only be used once.
        Request a fresh one and it will work.
      </p>

      {reason && (
        <p className="mt-4 max-w-sm break-words rounded-xl bg-white/5 px-4 py-2 font-mono text-xs text-muted-foreground">
          {reason}
        </p>
      )}

      <div className="mt-8 flex flex-wrap justify-center gap-2">
        <Link href="/">
          <Button variant="primary">Back to home</Button>
        </Link>
        <Link href="/">
          <Button variant="glass">Try signing in again</Button>
        </Link>
      </div>
    </div>
  );
}
