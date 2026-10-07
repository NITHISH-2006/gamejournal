'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { searchProfiles } from '@/app/actions/profiles';
import { Input } from '@/components/ui/input';
import { Search, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { ProfileAvatar } from '@/components/ui-primitives';
import { cn } from '@/lib/utils';

type Profile = {
  id: string;
  username: string;
  display_name?: string | null;
  bio?: string | null;
};

/**
 * Debounced user search.
 *
 * The previous version called `searchProfiles` (a Server Action) on every
 * keystroke with no debounce and no minimum length, and left the dropdown open
 * with no way to dismiss it.
 */
export default function UserSearch({
  className,
  placeholder = 'Search players by username...',
}: {
  className?: string;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Profile[]>([]);
  const [pending, startTransition] = useTransition();
  const [focused, setFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const requestId = useRef(0);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const trimmed = query.trim();

    // Invalidate any in-flight request *before* the early return, so dropping
    // below the minimum length cannot be overwritten by a response that was
    // already on the wire.
    requestId.current += 1;
    const id = requestId.current;

    if (trimmed.length < 2) {
      const raf = requestAnimationFrame(() => {
        setResults([]);
        setActiveIndex(0);
      });
      return () => cancelAnimationFrame(raf);
    }

    const timer = setTimeout(() => {
      startTransition(async () => {
        const data = await searchProfiles(trimmed).catch(() => []);
        // `clearTimeout` only cancels *pending* timers, not a round-trip that
        // is already in flight. Without this guard, typing "ali" then "alice"
        // could land the "ali" response last and show the wrong players for
        // the current query.
        if (id !== requestId.current) return;
        setResults((data ?? []) as unknown as Profile[]);
        setActiveIndex(0);
      });
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!show || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setFocused(false);
    }
  };

  // Dismiss on outside click.
  useEffect(() => {
    if (!focused) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [focused]);

  const show = focused && query.trim().length >= 2;

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
        {pending && (
          <Loader2 className="absolute top-1/2 right-3.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="pr-10 pl-10"
          role="combobox"
          aria-label="Search players"
          aria-expanded={show && results.length > 0}
          aria-controls="user-search-results"
          aria-activedescendant={
            show && results.length > 0 ? `user-search-opt-${activeIndex}` : undefined
          }
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {show && (
        <div className="glass-strong absolute top-full right-0 left-0 z-30 mt-2 overflow-hidden rounded-2xl animate-rise">
          {results.length > 0 ? (
            // The list is a live region: results arrive asynchronously, and a
            // screen-reader user previously got no confirmation that the search
            // had completed at all.
            <ul
              id="user-search-results"
              ref={listRef}
              role="listbox"
              aria-label="Player search results"
              className="max-h-72 overflow-y-auto py-1"
            >
              {results.map((p, i) => (
                <li
                  key={p.id}
                  id={`user-search-opt-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                >
                  <Link
                    href={`/user/${p.username}`}
                    onClick={() => {
                      setQuery('');
                      setResults([]);
                      setFocused(false);
                    }}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={cn(
                      'flex items-center gap-3 px-4 py-2.5 transition-colors',
                      i === activeIndex ? 'bg-white/8' : 'hover:bg-white/6'
                    )}
                  >
                    <ProfileAvatar
                      username={p.username}
                      size={32}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {p.display_name ?? `@${p.username}`}
                      </span>
                      {p.display_name && (
                        <span className="block truncate text-xs text-muted-foreground">
                          @{p.username}
                        </span>
                      )}
                      {p.bio && (
                        <span className="mt-0.5 block truncate text-xs text-ink-muted">
                          {p.bio}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : !pending ? (
            <p
              role="status"
              aria-live="polite"
              className="px-4 py-8 text-center text-sm text-muted-foreground"
            >
              No players found for &ldquo;{query.trim()}&rdquo;
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
