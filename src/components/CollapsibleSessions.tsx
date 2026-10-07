'use client';

import { useState, useTransition } from 'react';
import { ChevronRight, Clock, Loader2 } from 'lucide-react';
import { getSessionsForLog, type PlaySession } from '@/app/actions/sessions';
import SessionLog from '@/components/SessionLog';

/**
 * Lazy-loaded session history for one log.
 *
 * The game page renders up to 50 community logs. Fetching sessions for all of
 * them would be 50 extra round trips on the app's hottest public page, for a
 * feature only the log's owner can use — so the list is fetched on first expand
 * instead of with the page.
 *
 * Split from `SessionLog` specifically so the toggle can be a Server-rendered
 * boundary: the collapsed state costs no queries and no client JavaScript beyond
 * this small component.
 */
export default function CollapsibleSessions({ logId }: { logId: string }) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<PlaySession[] | null>(null);
  const [pending, startTransition] = useTransition();

  function handleToggle() {
    const next = !open;
    setOpen(next);
    // Already fetched: nothing to do on re-expand.
    if (!next || sessions !== null) return;

    startTransition(async () => {
      const rows = await getSessionsForLog(logId).catch(() => []);
      setSessions(rows);
    });
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
        {open ? 'Hide' : 'Show'} play sessions
        {pending && (
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div className="mt-1">
          {sessions === null ? (
            <p className="text-xs text-ink-faint" role="status">
              <Clock className="mr-1 inline size-3" aria-hidden="true" />
              Loading sessions…
            </p>
          ) : (
            <SessionLog logId={logId} initialSessions={sessions} canEdit />
          )}
        </div>
      )}
    </div>
  );
}