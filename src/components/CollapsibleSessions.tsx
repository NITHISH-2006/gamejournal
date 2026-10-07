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
 *
 * ── `canEdit` is a prop, not a constant ───────────────────────────────────────
 *
 * It was hardcoded to `true`, so every visitor — including anonymous ones — saw
 * a "Log a session" button on every log on the page. Clicking it called an action
 * that requires a session and came back "You must be signed in", after the user
 * had already typed a number of hours.
 *
 * It also gates whether `SessionLog` renders its form at all, so the hardcoded
 * `true` meant the form was rendered for everyone and then rejected on submit.
 */
export default function CollapsibleSessions({
  logId,
  canEdit = false,
}: {
  logId: string;
  canEdit?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<PlaySession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /**
   * Kept as a named function so both the first expand and a retry can call it.
   *
   * It sets `sessions` only on success. On failure `sessions` stays `null` and
   * `loadError` is set, which is what lets the retry button exist: previously a
   * failed load set `sessions` to `[]`, which is indistinguishable from "this
   * game has no sessions", so the component rendered the empty state permanently
   * and never offered to try again.
   */
  function load() {
    startTransition(async () => {
      try {
        const { sessions: next, error } = await getSessionsForLog(logId);

        if (error) {
          setLoadError(error);
          return;
        }

        setSessions(next);
        setLoadError(null);
      } catch (err) {
        setLoadError((err as Error).message || 'Could not load sessions.');
      }
    });
  }

  function handleToggle() {
    const next = !open;
    setOpen(next);

    // Already fetched successfully: nothing to do on re-expand.
    if (!next || sessions !== null) return;

    // A failed load is retried on re-expand, since `sessions` is still null.
    load();
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
          {pending && sessions === null ? (
            <p className="text-xs text-ink-faint" role="status">
              <Clock className="mr-1 inline size-3" aria-hidden="true" />
              Loading sessions…
            </p>
          ) : loadError && sessions === null ? (
            <p role="alert" className="text-xs text-destructive">
              {loadError}{' '}
              <button
                type="button"
                onClick={load}
                disabled={pending}
                className="underline underline-offset-2 disabled:opacity-50"
              >
                Try again
              </button>
            </p>
          ) : (
            <SessionLog
              logId={logId}
              initialSessions={sessions ?? []}
              canEdit={canEdit}
            />
          )}
        </div>
      )}
    </div>
  );
}