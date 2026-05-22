'use client';

import { useState, useEffect } from 'react';
import { getNotifications, markAllRead, type Notification } from '@/app/actions/notifications';
import { Bell } from 'lucide-react';
import { format } from 'date-fns';
import Link from 'next/link';

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [loaded, setLoaded] = useState(false);

  const unread = notifs.filter((n) => !n.read).length;

  const load = async () => {
    const data = await getNotifications().catch(() => []);
    setNotifs(data);
    setLoaded(true);
  };

  const handleOpen = async () => {
    if (!open) {
      await load();
      setOpen(true);
      if (unread > 0) {
        await markAllRead().catch(() => {});
        setNotifs((prev) => prev.map((n) => ({ ...n, read: true })));
      }
    } else {
      setOpen(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const label = (n: Notification) => {
    if (n.type === 'like') return `@${n.actor_username ?? 'someone'} liked your log${n.game_name ? ` of ${n.game_name}` : ''}`;
    if (n.type === 'follow') return `@${n.actor_username ?? 'someone'} followed you`;
    return 'New notification';
  };

  return (
    <div className="relative">
      <button
        onClick={handleOpen}
        className="relative p-2 text-zinc-400 hover:text-white transition-colors"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute top-1 right-1 w-2 h-2 bg-violet-500 rounded-full" />
        )}
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          {/* Dropdown */}
          <div className="absolute right-0 top-10 z-50 w-80 bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800">
              <p className="text-sm font-semibold">Notifications</p>
            </div>

            {!loaded && (
              <div className="p-4 space-y-2">
                {[...Array(3)].map((_, i) => <div key={i} className="h-10 bg-zinc-800 rounded animate-pulse" />)}
              </div>
            )}

            {loaded && notifs.length === 0 && (
              <p className="text-zinc-500 text-sm text-center py-8">No notifications yet.</p>
            )}

            {loaded && notifs.length > 0 && (
              <div className="max-h-80 overflow-y-auto divide-y divide-zinc-800">
                {notifs.map((n) => (
                  <div
                    key={n.id}
                    className={`px-4 py-3 text-sm ${n.read ? 'text-zinc-400' : 'text-white bg-zinc-800/50'}`}
                  >
                    <p>{label(n)}</p>
                    <p className="text-xs text-zinc-600 mt-0.5">
                      {format(new Date(n.created_at), 'MMM d, h:mm a')}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
