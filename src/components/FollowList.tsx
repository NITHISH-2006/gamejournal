'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Users } from 'lucide-react';
import {
  getFollowers,
  getFollowing,
  type FollowListEntry,
} from '@/app/actions/follows';
import { ProfileAvatar } from '@/components/ui-primitives';
import { SegmentedControl } from '@/components/ui-primitives';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatDate } from '@/lib/date';

type Mode = 'followers' | 'following';

/**
 * Followers / following list.
 *
 * Loaded on demand rather than eagerly. The profile page renders on every
 * navigation, and two extra queries for a panel most visitors never open is a
 * poor trade — especially since `getFollowers`/`getFollowing` previously
 * accepted an unclamped `limit` from the client and had no `order()` at all,
 * so page order was whatever Postgres happened to return.
 */
export default function FollowList({
  userId,
  followerCount,
  followingCount,
}: {
  userId: string;
  followerCount: number;
  followingCount: number;
}) {
  const [mode, setMode] = useState<Mode>('followers');
  const [entries, setEntries] = useState<FollowListEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = mode === 'followers' ? followerCount : followingCount;

  const load = async (next: Mode) => {
    setMode(next);
    setEntries(null);
    setError(null);

    if (total === 0) {
      setEntries([]);
      return;
    }

    setLoading(true);
    try {
      const rows =
        next === 'followers'
          ? await getFollowers(userId, 50)
          : await getFollowing(userId, 50);
      setEntries(rows);
    } catch (err) {
      setError((err as Error).message ?? 'Could not load that list.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section aria-label="Social graph">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-heading text-lg font-bold tracking-tight">
          <Users className="size-4 text-brand" />
          Community
        </h2>
        <SegmentedControl
          value={mode}
          onChange={load}
          options={[
            { value: 'followers', label: 'Followers', count: followerCount },
            { value: 'following', label: 'Following', count: followingCount },
          ]}
          size="sm"
        />
      </div>

      {entries === null && !loading && !error ? (
        <Button variant="glass" size="sm" onClick={() => load(mode)}>
          Show {mode}
        </Button>
      ) : loading ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <li
              key={i}
              className="skeleton h-14 rounded-xl"
              aria-hidden="true"
            />
          ))}
        </ul>
      ) : error ? (
        <Card className="p-4">
          <p className="text-ink-muted text-sm">{error}</p>
        </Card>
      ) : entries && entries.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-ink-muted text-sm">
            {mode === 'followers'
              ? 'No followers yet.'
              : 'Not following anyone yet.'}
          </p>
        </Card>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {(entries ?? []).map((entry) => (
            <li key={entry.id}>
              <Link href={`/user/${entry.username}`}>
                <Card className="flex items-center gap-3 p-3 transition-all duration-300 hover:border-white/20">
                  <ProfileAvatar
                    username={entry.username}
                    avatarUrl={entry.avatar_url}
                    size={36}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {entry.display_name ?? `@${entry.username}`}
                    </span>
                    {entry.bio ? (
                      <span className="block truncate text-ink-faint text-xs">
                        {entry.bio}
                      </span>
                    ) : (
                      <span className="text-ink-faint block text-xs">
                        Joined {formatDate(entry.created_at)}
                      </span>
                    )}
                  </span>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
