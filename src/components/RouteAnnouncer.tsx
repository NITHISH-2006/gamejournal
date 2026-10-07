'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Announces client-side navigations to assistive technology.
 *
 * This is a Client Component in its own file on purpose. It needs `useEffect` and
 * `usePathname`, and putting it inline in `app/layout.tsx` would pull those hooks
 * into a module that is a Server Component — which `tsc` does not flag but
 * Turbopack rejects at build time.
 *
 * Why it is needed at all: a Next.js App Router navigation swaps children
 * without a document load. Nothing in the DOM changes, no focus moves, and the
 * document title changes silently. A screen-reader user therefore gets *no*
 * signal that the page changed.
 *
 * `aria-live="polite"` rather than `assertive`: a navigation is not an error, and
 * interrupting whatever the user was doing would be worse than silence.
 */
export default function RouteAnnouncer() {
  const pathname = usePathname();
  const [message, setMessage] = useState('');

  useEffect(() => {
    // Deferred a frame so the announcement happens after the new content is
    // mounted. A synchronous setState in an effect body is a cascading render,
    // which React 19 flags.
    const id = requestAnimationFrame(() => {
      setMessage(`Navigated to ${pathname}`);
    });
    return () => cancelAnimationFrame(id);
  }, [pathname]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}