'use client';

import { useState, useTransition } from 'react';
import { toggleLike } from '@/app/actions/likes';
import { Heart, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type Props = {
  logId: string;
  initialCount: number;
  initialLiked: boolean;
  currentUserId?: string;
  size?: 'sm' | 'md';
};

/**
 * Like toggle with an optimistic update.
 *
 * The toggle is now a single server action returning authoritative state, so
 * the button cannot drift out of sync with the database the way separate
 * like/unlike calls could. On failure the previous value is restored.
 */
export default function LikeButton({
  logId,
  initialCount,
  initialLiked,
  currentUserId,
  size = 'sm',
}: Props) {
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [pending, startTransition] = useTransition();

  if (!currentUserId) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-ink-muted"
        aria-label={count > 0 ? `${count} likes` : 'No likes yet'}
      >
        <Heart className="size-3.5" />
        {count > 0 && <span className="tabular-nums">{count}</span>}
      </span>
    );
  }

  const handleToggle = () => {
    if (pending) return;

    const wasLiked = liked;
    const wasCount = count;

    // Optimistic
    setLiked(!wasLiked);
    setCount(wasCount + (wasLiked ? -1 : 1));

    startTransition(async () => {
      try {
        const result = await toggleLike(logId);
        setLiked(result.likedByMe);
        setCount(result.count);
      } catch (err) {
        // Revert to the last known-good state.
        setLiked(wasLiked);
        setCount(wasCount);
        console.error('[like] toggle failed:', (err as Error).message);
      }
    });
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={pending}
      aria-pressed={liked}
      aria-label={liked ? 'Unlike this log' : 'Like this log'}
      title={liked ? 'Unlike' : 'Like'}
      className={cn(
        'group inline-flex items-center gap-1.5 rounded-full px-2 py-1 transition-all duration-200',
        'disabled:opacity-60',
        liked
          ? 'text-rose-400 hover:text-rose-300'
          : 'text-muted-foreground hover:bg-white/6 hover:text-rose-300',
        size === 'md' && 'px-2.5 py-1.5'
      )}
    >
      {pending ? (
        <Loader2 className={cn('animate-spin', size === 'md' ? 'size-4' : 'size-3.5')} />
      ) : (
        <Heart
          className={cn(
            size === 'md' ? 'size-4' : 'size-3.5',
            'transition-transform duration-200 group-active:scale-125',
            liked && 'fill-current'
          )}
        />
      )}
      {count > 0 && (
        <span className="text-xs font-medium tabular-nums">{count}</span>
      )}
    </button>
  );
}
