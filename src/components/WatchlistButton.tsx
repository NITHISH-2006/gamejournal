'use client';

import { useState } from 'react';
import { addToWatchlist, removeFromWatchlist } from '@/app/actions/watchlist';
import { useToast } from '@/components/Toast';
import { Bookmark, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Game = { id: number; name: string; cover_url?: string | null; release_date?: string | null };

type Props = {
  game: Game;
  initialInWatchlist: boolean;
  variant?: 'icon' | 'button';
};

export default function WatchlistButton({ game, initialInWatchlist, variant = 'button' }: Props) {
  const [inList, setInList] = useState(initialInWatchlist);
  const [pending, setPending] = useState(false);
  const { toast } = useToast();

  const toggle = async () => {
    if (pending) return;
    setPending(true);
    try {
      if (inList) {
        await removeFromWatchlist(game.id);
        setInList(false);
        toast('Removed from watchlist');
      } else {
        await addToWatchlist(game);
        setInList(true);
        toast('Added to Plan to Play!');
      }
    } catch (err: any) {
      toast(err.message ?? 'Failed', 'error');
    } finally {
      setPending(false);
    }
  };

  if (variant === 'icon') {
    return (
      <button
        onClick={toggle}
        disabled={pending}
        title={inList ? 'Remove from watchlist' : 'Add to Plan to Play'}
        className={`transition-colors ${inList ? 'text-violet-400 hover:text-violet-300' : 'text-zinc-500 hover:text-zinc-300'}`}
      >
        {pending
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : <Bookmark className={`w-4 h-4 ${inList ? 'fill-current' : ''}`} />
        }
      </button>
    );
  }

  return (
    <Button
      onClick={toggle}
      disabled={pending}
      variant="outline"
      size="sm"
      className={`border-zinc-700 transition-colors ${inList ? 'text-violet-400 border-violet-800 hover:text-red-400 hover:border-red-800' : 'text-zinc-300 hover:text-white'}`}
    >
      {pending
        ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
        : <Bookmark className={`w-4 h-4 mr-1.5 ${inList ? 'fill-current' : ''}`} />
      }
      {inList ? 'Watchlisted' : 'Watchlist'}
    </Button>
  );
}
