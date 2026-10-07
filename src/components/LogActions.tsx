'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Trash2, Loader2 } from 'lucide-react';
import { updateGameLog, deleteGameLog } from '@/app/actions/logs';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { StarInput } from '@/components/StarInput';
import { LOG_STATUSES, STATUS_META, type LogStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

export type EditableLog = {
  id: string;
  status: LogStatus;
  rating: number;
  review: string | null;
  diary_date: string | null;
  tags: string[] | null;
};

/**
 * Owner-only edit and delete controls for a log.
 *
 * This did not exist before: the only way to change a mistaken entry was to
 * delete the whole row directly in the Supabase dashboard. Deleting is
 * confirmed, and both operations surface a real error message.
 */
export default function LogActions({
  log,
  gameId,
}: {
  log: EditableLog;
  gameId: number;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  const handleDelete = () => {
    startTransition(async () => {
      try {
        await deleteGameLog(log.id);
        toast('Log deleted');
        setConfirmDelete(false);
        router.refresh();
      } catch (err) {
        toast((err as Error).message ?? 'Could not delete the log', 'error');
      }
    });
  };

  return (
    <div className="flex items-center gap-0.5">
      <EditLogDialog
        log={log}
        open={editing}
        onOpenChange={setEditing}
        onSaved={() => router.refresh()}
      />

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogTrigger asChild>
          <button
            type="button"
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-400"
            aria-label="Delete this log"
            title="Delete log"
          >
            <Trash2 className="size-3.5" />
          </button>
        </DialogTrigger>

        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this log?</DialogTitle>
            <DialogDescription>
              This permanently removes your entry and its likes. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-2">
            <Button
              variant="glass"
              className="flex-1"
              onClick={() => setConfirmDelete(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              className="flex-1"
              onClick={handleDelete}
              disabled={pending}
            >
              {pending ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <span className="sr-only">Game id {gameId}</span>
    </div>
  );
}

function EditLogDialog({
  log,
  open,
  onOpenChange,
  onSaved,
}: {
  log: EditableLog;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<LogStatus>(log.status);
  const [rating, setRating] = useState(log.rating);
  const [review, setReview] = useState(log.review ?? '');
  const [diaryDate, setDiaryDate] = useState(log.diary_date ?? '');
  const [tags, setTags] = useState((log.tags ?? []).join(', '));
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();

  const handleSave = () => {
    startTransition(async () => {
      try {
        await updateGameLog(log.id, {
          status,
          rating,
          review,
          diaryDate: diaryDate || null,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        });
        toast('Log updated');
        onOpenChange(false);
        onSaved();
      } catch (err) {
        toast((err as Error).message ?? 'Could not update the log', 'error');
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-white/6 hover:text-foreground"
          aria-label="Edit this log"
          title="Edit log"
        >
          <Pencil className="size-3.5" />
        </button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit your log</DialogTitle>
          <DialogDescription>Update the details of this entry.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <fieldset>
            <legend className="mb-2 text-[0.65rem] font-medium tracking-wider text-muted-foreground uppercase">
              Status
            </legend>
            <div className="flex flex-wrap gap-2">
              {LOG_STATUSES.map((value) => {
                const meta = STATUS_META[value];
                const active = status === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setStatus(value)}
                    aria-pressed={active}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition-all',
                      active
                        ? meta.chip
                        : 'text-muted-foreground ring-white/8 hover:bg-white/5 hover:text-foreground'
                    )}
                  >
                    <span className={cn('size-1.5 rounded-full', meta.dot)} />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div>
            <p className="mb-1.5 text-[0.65rem] font-medium tracking-wider text-muted-foreground uppercase">
              Rating
            </p>
            <StarInput value={rating} onChange={setRating} />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="edit-date" className="text-xs font-medium text-muted-foreground">
              Date played
            </label>
            <Input
              id="edit-date"
              type="date"
              value={diaryDate}
              onChange={(e) => setDiaryDate(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="edit-review" className="text-xs font-medium text-muted-foreground">
              Review
            </label>
            <Textarea
              id="edit-review"
              value={review}
              maxLength={2000}
              onChange={(e) => setReview(e.target.value)}
              className="min-h-24"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="edit-tags" className="text-xs font-medium text-muted-foreground">
              Tags
            </label>
            <Input
              id="edit-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="rpg, masterpiece"
            />
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            variant="glass"
            className="flex-1"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            onClick={handleSave}
            disabled={pending}
          >
            {pending ? <Loader2 className="animate-spin" /> : null}
            Save changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
