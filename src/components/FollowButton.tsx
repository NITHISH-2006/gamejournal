'use client';

import { useState } from 'react';
import { followUser, unfollowUser } from '@/app/actions/follows';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/Toast';
import { Loader2 } from 'lucide-react';

type Props = {
  targetUserId: string;
  initialFollowing: boolean;
};

export default function FollowButton({ targetUserId, initialFollowing }: Props) {
  const [following, setFollowing] = useState(initialFollowing);
  const [pending, setPending] = useState(false);
  const { toast } = useToast();

  const toggle = async () => {
    if (pending) return;
    setPending(true);
    try {
      if (following) {
        await unfollowUser(targetUserId);
        setFollowing(false);
        toast('Unfollowed');
      } else {
        await followUser(targetUserId);
        setFollowing(true);
        toast('Now following!');
      }
    } catch (err: any) {
      // Surface the actual error — common causes: not signed in, already following
      const msg = err.message ?? 'Something went wrong';
      toast(msg, 'error');
      console.error('FollowButton error:', msg);
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      onClick={toggle}
      disabled={pending}
      variant={following ? 'outline' : 'default'}
      size="sm"
      className={following
        ? 'border-zinc-700 text-zinc-300 hover:border-red-800 hover:text-red-400 disabled:opacity-60'
        : 'bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-60'
      }
    >
      {pending
        ? <Loader2 className="h-4 w-4 animate-spin" />
        : following ? 'Following' : 'Follow'
      }
    </Button>
  );
}
