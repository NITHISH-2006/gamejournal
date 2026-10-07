'use client';

import { useState, useTransition, useOptimistic } from 'react';
import { MessageSquare, Send, Trash2, Loader2 } from 'lucide-react';
import { addComment, deleteComment, type Comment } from '@/app/actions/comments';
import { useToast } from '@/components/Toast';
import { ProfileAvatar } from '@/components/ui-primitives';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { LIMITS } from '@/lib/validation';
import { formatDate } from '@/lib/date';
import { cn } from '@/lib/utils';

type NewComment = Comment & { optimistic?: boolean };

/**
 * Comment thread for a single log.
 *
 * Threads are per-log rather than per-game, so a popular game does not
 * collapse into one unreadable wall of text.
 *
 * Posting is optimistic: the new comment appears immediately and is reconciled
 * from the server response. `useOptimistic` keeps the pending row in the list
 * across the transition without a second source of truth, which is what the
 * previous manual `setComments` approach kept getting wrong on failure — the
 * optimistic row was left behind when the action rejected.
 */
export default function CommentThread({
  logId,
  initialComments,
  currentUser,
}: {
  logId: string;
  initialComments: Comment[];
  currentUser: { id: string; username: string; avatarUrl: string | null } | null;
}) {
  const [comments, setComments] = useState<Comment[]>(initialComments);
  const [body, setBody] = useState('');
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();

  const [optimistic, addOptimistic] = useOptimistic<NewComment[], NewComment>(
    comments as NewComment[],
    (state, next) => [...state, next]
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text || !currentUser) return;

    const tempId = `optimistic-${Date.now()}`;

    startTransition(async () => {
      addOptimistic({
        id: tempId,
        log_id: logId,
        user_id: currentUser.id,
        body: text,
        created_at: new Date().toISOString(),
        username: currentUser.username,
        display_name: null,
        avatar_url: currentUser.avatarUrl,
        optimistic: true,
      });

      try {
        await addComment(logId, text);
        setBody('');
        // Re-read from the server rather than splicing the local copy, so the
        // thread reflects the real row (including a server-side trim).
        const fresh = await fetchComments(logId);
        setComments(fresh);
      } catch (err) {
        // useOptimistic drops the row automatically when the transition ends,
        // so there is nothing to roll back by hand.
        toast((err as Error).message ?? 'Could not post that comment', 'error');
      }
    });
  };

  const remove = (commentId: string) => {
    startTransition(async () => {
      try {
        await deleteComment(commentId);
        setComments((prev) => prev.filter((c) => c.id !== commentId));
      } catch (err) {
        toast((err as Error).message ?? 'Could not delete that comment', 'error');
      }
    });
  };

  const visible = [...optimistic];

  return (
    <div className="mt-4 border-t border-white/8 pt-4">
      <h4 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-ink-muted uppercase">
        <MessageSquare className="size-3.5" />
        {comments.length === 0 ? 'Discussion' : `Discussion (${comments.length})`}
      </h4>

      {visible.length > 0 && (
        <ul className="mt-3 space-y-3">
          {visible.map((c) => (
            <li
              key={c.id}
              className={cn(
                'flex gap-2.5',
                c.optimistic && 'opacity-60'
              )}
            >
              <ProfileAvatar
                username={c.username}
                avatarUrl={c.avatar_url}
                size={28}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">
                    {c.display_name ?? `@${c.username}`}
                  </span>
                  <span className="text-ink-faint text-xs">
                    {formatDate(c.created_at)}
                  </span>
                </div>
                <p className="mt-0.5 text-sm whitespace-pre-wrap text-ink-muted">
                  {c.body}
                </p>
              </div>
              {c.user_id === currentUser?.id && !c.optimistic && (
                <button
                  type="button"
                  onClick={() => remove(c.id)}
                  aria-label="Delete comment"
                  className="h-fit rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-white/8 hover:text-rose-300"
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {currentUser ? (
        <form onSubmit={submit} className="mt-4 space-y-2">
          <label htmlFor={`comment-${logId}`} className="sr-only">
            Add a comment
          </label>
          <Textarea
            id={`comment-${logId}`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add to the discussion..."
            maxLength={LIMITS.commentMax}
            rows={2}
            className="min-h-16 resize-y text-sm"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-faint text-xs tabular-nums">
              {body.length}/{LIMITS.commentMax}
            </span>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={pending || body.trim().length < 2}
            >
              {pending ? <Loader2 className="animate-spin" /> : <Send />}
              Post
            </Button>
          </div>
        </form>
      ) : (
        <p className="mt-3 text-ink-faint text-xs">
          Sign in to join the discussion.
        </p>
      )}
    </div>
  );
}

async function fetchComments(logId: string): Promise<Comment[]> {
  const { getComments } = await import('@/app/actions/comments');
  return getComments(logId);
}
