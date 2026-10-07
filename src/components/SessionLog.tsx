import { useState, useTransition, useRef, useMemo } from 'react';
import { Clock, Plus, Trash2, Loader2 } from 'lucide-react';
import { addPlaySession, deletePlaySession, getSessionsForLog, type PlaySession } from '@/app/actions/sessions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/Toast';
import { formatDate } from '@/lib/date';
import { validateSessionDraft } from '@/lib/session-validate';

/**
 * Play-session log for a single game.
 *
 * The `playtime_hours` field on a log is a single number, so it can answer "how
 * much have I played" but not "when did I last play" or "was that a marathon".
 * This records a row per sitting and shows the history.
 *
 * `initialSessions` is fetched by the page so the list is server-rendered; the
 * component re-reads after a mutation rather than trying to reconcile state
 * itself, which keeps the server the single source of truth.
 */
export default function SessionLog({
  logId,
  initialSessions,
  canEdit,
}: {
  logId: string;
  initialSessions: PlaySession[];
  canEdit: boolean;
}) {
  /**
   * The server-rendered rows are only the *starting* state.
   *
   * Every subsequent value comes from an explicit read, and a read that fails
   * leaves the previous rows on screen with the error beside them. Replacing the
   * list with `[]` on failure would tell the user a game they have played forty
   * times has never been played.
   */
  const [sessions, setSessions] = useState<PlaySession[]>(initialSessions);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [hours, setHours] = useState('');
  const [playedOn, setPlayedOn] = useState('');
  const [platform, setPlatform] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();

  // `pending` from useTransition is not updated synchronously, so two clicks in
  // the same frame both pass a state-based guard. A ref closes that gap.
  const busy = useRef(false);

  const total = useMemo(
    () => sessions.reduce((sum, s) => sum + s.hours, 0),
    [sessions]
  );

  /**
   * Re-reads the sessions after a mutation.
   *
   * Returns whether it succeeded, so the caller can distinguish "the write
   * worked but the list is stale" from "the write worked and the list is
   * current". The write is never rolled back on a read failure — the row exists
   * in the database either way.
   */
  async function refresh(): Promise<boolean> {
    try {
      const { sessions: next, error: readError } = await getSessionsForLog(logId);
      if (readError) {
        setLoadError(readError);
        return false;
      }
      setSessions(next);
      setLoadError(null);
      return true;
    } catch (err) {
      // A rejected action (network, deployment, auth) rather than a reported
      // read failure. Same treatment: keep what is on screen.
      setLoadError((err as Error).message || 'Could not refresh sessions.');
      return false;
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy.current) return;

    setError(null);

    // Validate before the round trip so the common mistake (a typo'd date, or
    // leaving the field blank) is caught without a failed write.
    if (!hours.trim()) {
      setError('Enter how long you played for.');
      return;
    }

    // `validateSessionDraft` is the same function the server action runs, so the
    // client and the server cannot disagree about what is acceptable. The old
    // inline check only verified the date round-tripped through `Date`, so
    // `hours` was sent unvalidated and a 999-hour session failed at the server
    // after a round trip.
    const draftError = validateSessionDraft({ hours, playedOn });
    if (draftError) {
      setError(draftError);
      return;
    }

    busy.current = true;
    startTransition(async () => {
      try {
        await addPlaySession(logId, { hours, playedOn, platform, note });
        setHours('');
        setPlatform('');
        setNote('');
        setPlayedOn('');
        setShowForm(false);
        await refresh();
        toast('Session logged');
      } catch (err) {
        const message = (err as Error).message;
        setError(message);
        toast(message || 'Could not log that session', 'error');
      } finally {
        busy.current = false;
      }
    });
  }

  function handleDelete(sessionId: string) {
    if (busy.current) return;
    busy.current = true;
    startTransition(async () => {
      try {
        await deletePlaySession(sessionId);
        await refresh();
        toast('Session removed');
      } catch (err) {
        toast((err as Error).message || 'Could not remove that session', 'error');
      } finally {
        busy.current = false;
      }
    });
  }

  return (
    <section aria-labelledby="sessions-heading" className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 id="sessions-heading" className="flex items-center gap-1.5 text-sm font-semibold">
          <Clock className="size-4" aria-hidden="true" />
          Play sessions
          {sessions.length > 0 && (
            <span className="text-xs font-normal text-ink-muted">
              · {sessions.length} logged · {Math.round(total * 10) / 10}h total
            </span>
          )}
        </h3>

        {canEdit && !showForm && (
          <Button variant="glass" size="sm" onClick={() => setShowForm(true)}>
            <Plus className="size-3.5" aria-hidden="true" />
            Log a session
          </Button>
        )}
      </div>

      {loadError && (
        // Rendered *beside* the list rather than replacing it, so a failed
        // refresh does not look like the history was deleted.
        <p role="alert" className="mb-2 text-xs text-destructive">
          {loadError}{' '}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={pending}
            className="underline underline-offset-2 disabled:opacity-50"
          >
            Try again
          </button>
        </p>
      )}

      {sessions.length === 0 ? (
        <p className="text-xs text-ink-muted">
          {loadError
            ? 'Could not load sessions.'
            : canEdit
              ? 'No sessions yet. Logging how long you played each day adds history the single playtime number cannot show.'
              : 'No sessions logged yet.'}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {sessions.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-2 rounded-lg bg-white/4 px-3 py-1.5 text-xs"
            >
              <span className="min-w-0 truncate">
                <span className="font-medium tabular-nums">{s.hours}h</span>
                <span className="text-ink-muted"> · {formatDate(s.playedOn)}</span>
                {s.platform && <span className="text-ink-muted"> · {s.platform}</span>}
                {s.note && <span className="text-ink-faint"> · {s.note}</span>}
              </span>

              {canEdit && (
                <button
                  type="button"
                  onClick={() => handleDelete(s.id)}
                  disabled={pending}
                  aria-label={`Remove session from ${formatDate(s.playedOn)}`}
                  className="shrink-0 rounded p-1 text-ink-muted transition-colors hover:text-destructive disabled:opacity-50"
                >
                  {pending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  )}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {showForm && canEdit && (
        <form onSubmit={handleSubmit} className="mt-3 space-y-2.5" noValidate>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="space-y-1">
              <label htmlFor="session-hours" className="text-xs text-ink-muted">
                Hours
              </label>
              <Input
                id="session-hours"
                type="number"
                inputMode="decimal"
                min={0.25}
                max={24}
                step={0.25}
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                disabled={pending}
                placeholder="1.5"
                required
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="session-date" className="text-xs text-ink-muted">
                Date
              </label>
              <Input
                id="session-date"
                type="date"
                value={playedOn}
                onChange={(e) => setPlayedOn(e.target.value)}
                disabled={pending}
              />
            </div>

            <div className="col-span-2 space-y-1">
              <label htmlFor="session-platform" className="text-xs text-ink-muted">
                Platform <span className="text-ink-faint">(optional)</span>
              </label>
              <Input
                id="session-platform"
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                disabled={pending}
                placeholder="PS5, Switch, PC…"
                maxLength={40}
              />
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="session-note" className="text-xs text-ink-muted">
              Note <span className="text-ink-faint">(optional)</span>
            </label>
            <Textarea
              id="session-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={pending}
              placeholder="Finally beat the second boss"
              maxLength={280}
              rows={2}
            />
          </div>

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={pending}>
              {pending ? 'Saving…' : 'Add session'}
            </Button>
            <Button
              type="button"
              variant="glass"
              size="sm"
              disabled={pending}
              onClick={() => {
                setShowForm(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}