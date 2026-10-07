'use client';

import { useState, useTransition } from 'react';
import { toggleWatchlist } from '@/app/actions/watchlist';
import { useToast } from '@/components/Toast';
import { Bookmark, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Game = {
  id: number;
  name: string;
  cover_url?: string | null;
  release_date?: string | null;
};

type Props = {
  game: Game;
  initialInWatchlist: boolean;
  variant?: 'button' | 'icon';
};

/**
 * Watchlist toggle.
 *
 * Now a single toggle action returning authoritative state, so rapid clicks
 * cannot desynchronise the label from the database.
 */
export default function WatchlistButton({
  game,
  initialInWatchlist,
  variant = 'button',
}: Props) {
  const [inList, setInList] = useState(initialInWatchlist);
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();

  const handleToggle = () => {
    if (pending) return;
    const wasIn = inList;
    setInList(!wasIn); // optimistic

    startTransition(async () => {
      try {
        const result = await toggleWatchlist(game);
        setInList(result.inWatchlist);
        toast(
          result.inWatchlist
            ? 'Added to your Plan to Play list'
            : 'Removed from your Plan to Play list'
        );
      } catch (err) {
        setInList(wasIn);
        const message = (err as Error).message ?? 'Could not update your watchlist';
        toast(message, 'error');
      }
    });
  };

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={handleToggle}
        disabled={pending}
        title={inList ? 'Remove from Plan to Play' : 'Add to Plan to Play'}
        aria-pressed={inList}
        className={cn(
          'rounded-lg p-1.5 transition-colors',
          inList
            ? 'text-brand hover:text-brand/80'
            : 'text-muted-foreground hover:text-foreground'
        )}
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Bookmark className={cn('size-4', inList && 'fill-current')} />
        )}
        <span className="sr-only">
          {inList ? 'Remove from Plan to Play' : 'Add to Plan to Play'}
        </span>
      </button>
    );
  }

  return (
    <Button
      type="button"
      onClick={handleToggle}
      disabled={pending}
      variant="glass"
      size="sm"
      aria-pressed={inList}
    >
      {pending ? (
        <Loader2 className="animate-spin" />
      ) : (
        <Bookmark className={cn(inList && 'fill-current')} />
      )}
      {inList ? 'In Plan to Play' : 'Plan to Play'}
    </Button>
  );
}
