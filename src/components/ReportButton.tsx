'use client';

import { useState, useTransition, useRef } from 'react';
import { Flag, Loader2, Check } from 'lucide-react';
import {
  reportContent,
  getExistingReports,
  type ReportableType,
} from '@/app/actions/reports';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/Toast';

/**
 * Report content for moderation.
 *
 * The previous version of this app had this feature and it had never once
 * worked: there was no `reports` table in any migration, so every submit failed
 * with PGRST205 and the raw error was shown to the user. The README advertised it
 * as a working feature throughout.
 *
 * `alreadyReported` is seeded by the page so the button can read "Reported"
 * instead of inviting a duplicate that the unique index would discard silently.
 */

const REASONS: { value: string; label: string }[] = [
  { value: 'spam', label: 'Spam or advertising' },
  { value: 'harassment', label: 'Harassment or abuse' },
  { value: 'offensive', label: 'Hateful or offensive content' },
  { value: 'misinformation', label: 'False or misleading information' },
  { value: 'copyright', label: 'Copyright concern' },
  { value: 'other', label: 'Something else' },
];

export default function ReportButton({
  contentType,
  contentId,
  alreadyReported = false,
  isSignedIn,
}: {
  contentType: ReportableType;
  contentId: string;
  alreadyReported?: boolean;
  isSignedIn: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(alreadyReported);
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();

  // Ref guard: `pending` is not updated synchronously, so two clicks in one
  // frame would both pass a state-based check and file the report twice.
  const busy = useRef(false);

  function handleOpen() {
    if (!isSignedIn) {
      toast('Sign in to report content.', 'error');
      return;
    }
    setOpen(true);
    // Confirm the server's view rather than trusting the seeded prop, which may
    // be stale after a client-side navigation.
    void getExistingReports(contentId)
      .then((types) => {
        if (types.includes(contentType)) setSubmitted(true);
      })
      .catch(() => {});
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy.current) return;

    setError(null);

    if (!reason) {
      setError('Please choose a reason.');
      return;
    }

    busy.current = true;
    startTransition(async () => {
      try {
        await reportContent(contentType, contentId, reason, notes);
        setSubmitted(true);
        setOpen(false);
        setReason('');
        setNotes('');
        toast('Thanks — our moderators will take a look.');
      } catch (err) {
        const message = (err as Error).message;
        setError(message);
        toast(message || 'Could not submit that report', 'error');
      } finally {
        busy.current = false;
      }
    });
  }

  if (submitted) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-ink-muted"
        role="status"
      >
        <Check className="size-3.5" aria-hidden="true" />
        Reported
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        aria-label={`Report this ${contentType}`}
        title="Report"
        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-white/6 hover:text-foreground"
      >
        <Flag className="size-3.5" aria-hidden="true" />
      </button>

      <Dialog open={open} onOpenChange={(v) => { if (!pending) setOpen(v); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Report this {contentType}</DialogTitle>
            <DialogDescription>
              Tell our moderators what is wrong. We review every report and will
              not tell the person you reported who did it.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <fieldset className="space-y-2" disabled={pending}>
              <legend className="mb-1 text-sm font-medium">Reason</legend>
              {REASONS.map((r) => (
                <label
                  key={r.value}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    type="radio"
                    name="report-reason"
                    value={r.value}
                    checked={reason === r.value}
                    onChange={() => setReason(r.value)}
                    required
                  />
                  {r.label}
                </label>
              ))}
            </fieldset>

            <div className="space-y-1.5">
              <label htmlFor="report-notes" className="text-sm font-medium">
                Anything else? <span className="text-ink-faint">(optional)</span>
              </label>
              <Textarea
                id="report-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={pending}
                maxLength={500}
                rows={3}
                placeholder="Anything that would help us understand"
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="glass"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={pending || !reason}>
                {pending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Sending…
                  </>
                ) : (
                  'Submit report'
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}