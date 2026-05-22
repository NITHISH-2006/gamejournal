'use client';

import { useState } from 'react';
import { likeLog, unlikeLog } from '@/app/actions/likes';
import { Heart } from 'lucide-react';

type Props = {
  logId: string;
  initialCount: number;
  initialLiked: boolean;
  currentUserId?: string;
};

export default function LikeButton({ logId, initialCount, initialLiked, currentUserId }: Props) {
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [pending, setPending] = useState(false);

  if (!currentUserId) {
    return (
      <span className="flex items-center gap-1 text-xs text-zinc-600">
        <Heart className="w-3.5 h-3.5" />
        {count > 0 && count}
      </span>
    );
  }

  const toggle = async () => {
    if (pending) return;
    setPending(true);
    // Optimistic update
    const wasLiked = liked;
    setLiked(!wasLiked);
    setCount((c) => wasLiked ? c - 1 : c + 1);
    try {
      if (wasLiked) await unlikeLog(logId);
      else await likeLog(logId);
    } catch {
      // Revert on failure
      setLiked(wasLiked);
      setCount((c) => wasLiked ? c + 1 : c - 1);
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      onClick={toggle}
      disabled={pending}
      className={`flex items-center gap-1 text-xs transition-colors ${
        liked ? 'text-red-400 hover:text-red-300' : 'text-zinc-600 hover:text-zinc-400'
      }`}
    >
      <Heart className={`w-3.5 h-3.5 ${liked ? 'fill-current' : ''}`} />
      {count > 0 && <span>{count}</span>}
    </button>
  );
}
