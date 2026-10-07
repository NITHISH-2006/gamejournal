'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Compass, User, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Bottom navigation for small screens.
 *
 * The previous navbar hid all links behind `hidden sm:flex` with no mobile
 * alternative, so phone visitors could not reach Discover or their profile at
 * all. This is a fixed tab bar, hidden from `md` up where the inline nav takes
 * over. `env(safe-area-inset-bottom)` keeps it clear of the iOS home indicator.
 *
 * Note: icons are passed as a *string key*, not a component reference.
 * Navbar is a Server Component, and React cannot serialise a function across
 * the server/client boundary - passing `icon: Home` directly produced a 500
 * with "Functions cannot be passed directly to Client Components".
 */
const ICONS: Record<string, LucideIcon> = {
  home: Home,
  discover: Compass,
  profile: User,
};

export type MobileNavItem = {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
};

export default function MobileNav({ items }: { items: MobileNavItem[] }) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  if (!items.length) return null;

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 md:hidden"
      aria-label="Mobile navigation"
    >
      <div className="glass border-x-0 border-b-0 px-2 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))]">
        <ul className="flex items-stretch justify-around">
          {items.map((item) => {
            const active = isActive(item.href);
            const Icon = ICONS[item.icon] ?? Home;
            return (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-[0.65rem] font-medium transition-all duration-200',
                    active
                      ? 'text-brand'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <span
                    className={cn(
                      'flex h-7 w-12 items-center justify-center rounded-full transition-all duration-200',
                      active && 'bg-brand/15'
                    )}
                  >
                    <Icon className="size-4.5" aria-hidden="true" />
                  </span>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
