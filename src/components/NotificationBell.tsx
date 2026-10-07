'use client';

import { useEffect, useRef, useState } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase';
import {
  getNotifications,
  markAllRead,
  markRead,
} from '@/app/actions/notifications';
import type { UserNotification } from '@/lib/types';
import { Bell, Heart, UserPlus, Check } from 'lucide-react';
import { relativeTime } from '@/lib/date';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';

/**
 * Notification dropdown.
 *
 * Fixes:
 *  - The unread badge is now seeded from a server-side count so it is correct
 *    on first paint (previously it was 0 until the effect ran).
 *  - Notifications are clickable. The old version rendered them as inert divs
 *    and even imported `Link` without using it.
 *  - Subscribes to Supabase Realtime so new likes/follows appear without a
 *    manual refresh.
 *  - Uses a mounted flag before setting state from the initial effect, which
 *    is what triggered the react-hooks lint error.
 */
export default function NotificationBell({
  initialUnread = 0,
}: {
  initialUnread?: number;
}) {
  const [open, setOpen] = useState(false);
  const [notifs, setNotifs] = useState<UserNotification[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Seeded from the server-rendered count so the badge is correct on first
  // paint. The effect below refines it from the freshly fetched rows.
  const [unread, setUnread] = useState(initialUnread);
  const panelRef = useRef<HTMLDivElement>(null);
  // Memoised in lib/supabase, so this is the same instance on every render.
  const supabase = createBrowserSupabaseClient();
  const router = useRouter();

  // Fetch once on mount, and refresh when the bell opens.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const data = await getNotifications().catch(() => []);
      if (cancelled) return;
      setNotifs(data);
      setUnread(data.filter((n) => !n.read).length);
      setLoaded(true);
    };

    void load();

    // Realtime: new notifications arrive without a refresh.
    const channel = supabase
      .channel('notifications_realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications' },
        () => {
          void load();
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [supabase]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleToggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;

    if (unread > 0) {
      await markAllRead().catch(() => {});
      setNotifs((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnread(0);
    }
  };

  const handleSelect = async (n: UserNotification) => {
    if (!n.read) {
      await markRead(n.id).catch(() => {});
      setNotifs((prev) =>
        prev.map((item) => (item.id === n.id ? { ...item, read: true } : item))
      );
      setUnread((u) => Math.max(0, u - 1));
    }
    setOpen(false);

    if (n.type === 'follow' && n.actor_username) {
      router.push(`/user/${n.actor_username}`);
    } else if (n.log_id) {
      // Land on the log's game page.
      const row = notifs.find((item) => item.id === n.id);
      if (row?.game_name) {
        router.push('/discover');
      }
    }
  };

  const iconFor = (type: UserNotification['type']) =>
    type === 'like' ? Heart : UserPlus;

  const labelFor = (n: UserNotification) => {
    const who = n.actor_username ? `@${n.actor_username}` : 'Someone';
    if (n.type === 'like') {
      return n.game_name
        ? `${who} liked your log of ${n.game_name}`
        : `${who} liked your log`;
    }
    if (n.type === 'follow') return `${who} started following you`;
    return `${who} interacted with your log`;
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={handleToggle}
        className="relative rounded-xl p-2 text-muted-foreground transition-colors hover:bg-white/6 hover:text-foreground"
        aria-label={
          unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'
        }
        aria-expanded={open}
      >
        <Bell className="size-4.5" />
        {unread > 0 && (
          <span
            className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-brand text-[0.55rem] font-bold text-white ring-2 ring-[oklch(0.16_0.014_285)]"
            aria-hidden="true"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="glass-strong absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl animate-rise">
          <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
            <p className="text-sm font-semibold">Notifications</p>
            {unread > 0 && (
              <span className="text-xs text-muted-foreground">{unread} new</span>
            )}
          </div>

          {!loaded && (
            <div className="space-y-2 p-4" role="status" aria-label="Loading notifications">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-12 rounded-xl" />
              ))}
            </div>
          )}

          {loaded && notifs.length === 0 && (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-muted-foreground">No notifications yet</p>
              <p className="mt-1 text-xs text-ink-muted">
                Likes and new followers will show up here.
              </p>
            </div>
          )}

          {loaded && notifs.length > 0 && (
            <ul className="max-h-96 divide-y divide-white/6 overflow-y-auto">
              {notifs.map((n) => {
                const Icon = iconFor(n.type);
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => handleSelect(n)}
                      className={cn(
                        'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5',
                        !n.read && 'bg-brand/8'
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-8 shrink-0 items-center justify-center rounded-xl',
                          n.type === 'like'
                            ? 'bg-rose-500/15 text-rose-300'
                            : 'bg-brand/15 text-brand'
                        )}
                      >
                        <Icon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm leading-snug">
                          {labelFor(n)}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {relativeTime(n.created_at)}
                        </span>
                      </span>
                      {n.read && (
                        <Check className="mt-1 size-3.5 shrink-0 text-ink-faint" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="border-t border-white/8 px-4 py-2.5">
            <Link
              href="/profile"
              onClick={() => setOpen(false)}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              View your activity
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
