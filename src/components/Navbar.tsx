import Link from 'next/link';
import { Suspense } from 'react';
import { createClient } from '@/lib/supabase';
import { getOwnProfile } from '@/app/actions/profiles';
import { getUnreadCount } from '@/app/actions/notifications';
import AuthButton from '@/components/AuthButton';
import LogGameModal from '@/components/LogGameModal';
import NotificationBell from '@/components/NotificationBell';
import { Gamepad2, Search } from 'lucide-react';
import { ProfileAvatar } from '@/components/ui-primitives';
import MobileNav from '@/components/MobileNav';
import CommandPalette from '@/components/CommandPalette';

export default async function Navbar() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [profile, unread] = await Promise.all([
    user ? getOwnProfile().catch(() => null) : Promise.resolve(null),
    user ? getUnreadCount().catch(() => 0) : Promise.resolve(0),
  ]);

  // Two lists, because a Server Component cannot hand an icon *component*
  // (a function) to the client-rendered MobileNav. We pass a string key here
  // and MobileNav maps it to the real icon locally.
  const navItems = [
    { href: '/', label: 'Home' },
    { href: '/discover', label: 'Discover' },
    ...(profile ? [{ href: `/user/${profile.username}`, label: 'Profile' }] : []),
  ];

  const navIcons = [
    { href: '/', icon: 'home' },
    { href: '/discover', icon: 'discover' },
    ...(profile
      ? [{ href: `/user/${profile.username}`, icon: 'profile' }]
      : []),
  ] as const;

  return (
    <header className="fixed inset-x-0 top-0 z-50 h-16">
      {/* Glass navbar: translucent bar with a blur and a hairline bottom edge. */}
      <div className="glass absolute inset-0 rounded-none border-x-0 border-t-0">
        <div className="mx-auto flex h-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          {/* Brand */}
          <Link
            href="/"
            className="group flex shrink-0 items-center gap-2.5 font-bold tracking-tight transition-opacity hover:opacity-90"
          >
            <span
              className="brand-gradient flex size-8 items-center justify-center rounded-xl shadow-[0_4px_14px_-4px_var(--brand)] transition-transform duration-300 group-hover:scale-105"
              aria-hidden="true"
            >
              <Gamepad2 className="size-4.5 text-white" />
            </span>
            <span className="hidden sm:inline">
              Game<span className="text-gradient">Journal</span>
            </span>
          </Link>

          {/* Desktop nav */}
          <nav
            className="hidden items-center gap-1 md:flex"
            aria-label="Main navigation"
          >
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium text-muted-foreground transition-all duration-200 hover:bg-white/6 hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          {/* Actions */}
          <div className="flex shrink-0 items-center gap-2">
            {user && <CommandPalette />}

            {user && (
              <Link
                href="/discover"
                className="rounded-xl p-2 text-muted-foreground transition-colors hover:bg-white/6 hover:text-foreground md:hidden"
                aria-label="Discover"
              >
                <Search className="size-4.5" />
              </Link>
            )}

            {user && <NotificationBell initialUnread={unread} />}

            {/* `LogGameModal` calls `useSearchParams()` to read `?log=1`. Without
                a `<Suspense>` boundary above it, Next.js cannot statically render
                the page and opts the whole route out of server rendering. It is
                mounted from the root layout, so this boundary protects every route
                in the app, not just the game pages. */}
            {user && (
              <Suspense fallback={null}>
                <LogGameModal />
              </Suspense>
            )}

            {profile ? (
              <Link
                href={`/user/${profile.username}`}
                className="rounded-full transition-transform hover:scale-105 md:hidden"
                aria-label="Your profile"
              >
                <ProfileAvatar
                  username={profile.username}
                  avatarUrl={profile.avatar_url}
                  size={32}
                />
              </Link>
            ) : null}

            <AuthButton
              user={user}
              username={profile?.username}
              displayName={profile?.display_name}
              avatarUrl={profile?.avatar_url}
            />
          </div>
        </div>
      </div>

      {/* Mobile bottom bar */}
      <MobileNav
        items={navItems.map((item, i) => ({
          href: item.href,
          label: item.label,
          icon: navIcons[i].icon as 'home' | 'discover' | 'profile',
        }))}
      />
    </header>
  );
}
