'use client';

import { useState, useTransition } from 'react';
import { toggleFollow } from '@/app/actions/follows';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/Toast';
import { Loader2, UserCheck, UserPlus } from 'lucide-react';

type Props = {
  targetUserId: string;
  initialFollowing: boolean;
};

/**
 * Follow toggle.
 *
 * Uses the `toggleFollow` action, which returns the authoritative follow state
 * and the new follower count, so the button label always matches the database.
 * The previous version called separate follow/unfollow actions and could leave
 * the UI showing "Following" after a failed request.
 */
export default function FollowButton({ targetUserId, initialFollowing }: Props) {
  const [following, setFollowing] = useState(initialFollowing);
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();

  const handleToggle = () => {
    if (pending) return;
    const wasFollowing = following;

    setFollowing(!wasFollowing); // optimistic

    startTransition(async () => {
      try {
        const result = await toggleFollow(targetUserId);
        setFollowing(result.following);
        toast(
          result.following
            ? 'Following. Their logs will now appear in your feed.'
            : 'Unfollowed.'
        );
      } catch (err) {
        setFollowing(wasFollowing);
        const message = (err as Error).message ?? 'Something went wrong';
        toast(message, 'error');
        console.error('[follow] toggle failed:', message);
      }
    });
  };

  return (
    <Button
      type="button"
      onClick={handleToggle}
      disabled={pending}
      variant={following ? 'glass' : 'primary'}
      size="sm"
      aria-pressed={following}
    >
      {pending ? (
        <Loader2 className="animate-spin" />
      ) : following ? (
        <UserCheck />
      ) : (
        <UserPlus />
      )}
      {following ? 'Following' : 'Follow'}
    </Button>
  );
}
