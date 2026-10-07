'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search,
  Home,
  Compass,
  User,
  List,
  Bookmark,
  PlusCircle,
  CornerDownLeft,
  Loader2,
} from 'lucide-react';
import { searchProfiles } from '@/app/actions/profiles';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ProfileAvatar } from '@/components/ui-primitives';
import { cn } from '@/lib/utils';

type UserResult = {
  kind: 'user';
  id: string;
  username: string;
  display_name: string | null;
};

type ActionResult = { kind: 'action'; id: string; label: string; href: string };

type Result = UserResult | ActionResult;

/**
 * Anything the palette can select. Both static actions and user hits are
 * normalised into this so rendering and keyboard navigation read the same
 * array â€” see the note on `items` below.
 */
type PaletteItem =
  | { kind: 'action'; id: string; label: string; href: string }
  | { kind: 'user'; id: string; username: string; display_name: string | null };

/**
 * Command palette (Cmd/Ctrl+K).
 *
 * Gives keyboard users fast access to the sections that were previously
 * reachable only by clicking small nav links, and adds debounced user search
 * so the app is usable without a mouse.
 */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const router = useRouter();

  const openPalette = useCallback(() => {
    setOpen(true);
    setQuery('');
    setResults([]);
    setActiveIndex(0);
  }, []);

  // Global shortcut.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => (prev ? false : true));
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      // Defer so the dialog is mounted before focusing.
      requestAnimationFrame(() => inputRef.current?.focus());
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  // Debounced user search - 250ms, and cancel out-of-order responses.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      // Defer so this is not a synchronous setState inside the effect body.
      const id = requestAnimationFrame(() => {
        setResults([]);
        setSearching(false);
      });
      return () => cancelAnimationFrame(id);
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const profiles = await searchProfiles(trimmed);
        if (cancelled) return;
        setResults(
          (profiles as {
            id: string;
            username: string;
            display_name: string | null;
          }[]).map((p) => ({
            kind: 'user' as const,
            id: p.id,
            username: p.username,
            display_name: p.display_name,
          }))
        );
        setActiveIndex(0);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router]
  );

  /**
   * One flat list of everything selectable, in render order.
   *
   * The previous version kept `staticActions` and user hits in two separate
   * branches while `onKeyDown` only ever read `results`. With an empty query
   * `results` is `[]`, so `ArrowDown` computed `Math.min(1, -1) === -1` and
   * `Enter` did nothing â€” the palette's core value proposition, jumping to a
   * page without a mouse, was broken. Rendering and keyboard navigation now
   * both derive from this single array, so they cannot disagree.
   *
   * Static actions are filtered by the query so typing "dis" surfaces
   * "Discover games".
   */
  const items = useMemo<PaletteItem[]>(() => {
    const STATIC_ACTIONS: ActionResult[] = [
      { kind: 'action', id: 'nav-home', label: 'Go to Home', href: '/' },
      { kind: 'action', id: 'nav-discover', label: 'Go to Discover', href: '/discover' },
      { kind: 'action', id: 'nav-profile', label: 'Go to your profile', href: '/profile' },
      { kind: 'action', id: 'log', label: 'Log a game', href: '/?log=1' },
    ];

    const q = query.trim().toLowerCase();
    const actions: PaletteItem[] = STATIC_ACTIONS
      .filter((a) => !q || a.label.toLowerCase().includes(q))
      .map((a) => ({ kind: 'action' as const, id: a.id, label: a.label, href: a.href }));

    // Below the minimum length, showing user results would be noise.
    if (q.length < 2) return actions;
    return [...results, ...actions];
  }, [query, results]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (items.length ? Math.min(i + 1, items.length - 1) : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (items.length ? Math.max(i - 1, 0) : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = items[activeIndex];
      if (!selected) return;
      if (selected.kind === 'user') go(`/user/${selected.username}`);
      else go(selected.href);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  // Keep the highlighted row in view during arrow navigation.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <>
      <button
        type="button"
        onClick={openPalette}
        className="rounded-xl p-2 text-muted-foreground transition-colors hover:bg-white/6 hover:text-foreground"
        aria-label="Open command palette"
        title="Command palette (Ctrl+K)"
      >
        <Search className="size-4.5" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          aria-label="Command palette"
          className="glass-strong z-[120] w-full max-w-lg gap-0 overflow-hidden p-0"
        >
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <div className="flex items-center gap-3 border-b border-white/8 px-4">
            {searching ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Search className="size-4 shrink-0 text-muted-foreground" />
            )}
            {/* A combobox that actually points at its listbox. Without
                role/aria-expanded/aria-controls/aria-activedescendant the
                `<ul role="listbox">` below existed in isolation, so arrowing
                through the results announced nothing at all. */}
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search games, users, or jump to a page..."
              className="h-14 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              role="combobox"
              aria-expanded={items.length > 0}
              aria-controls="cmdk-results"
              aria-autocomplete="list"
              aria-activedescendant={
                items.length > 0 ? `cmdk-option-${activeIndex}` : undefined
              }
              aria-label="Search games, users and pages"
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className="hidden shrink-0 rounded-md border border-white/10 bg-white/5 px-0.5 py-0.5 text-[0.6rem] text-muted-foreground sm:block">
              ESC
            </kbd>
          </div>

          {/* Live region: results resolve asynchronously and a screen-reader
              user previously got no signal that the search had finished. */}
          <ul
            ref={listRef}
            id="cmdk-results"
            role="listbox"
            aria-label="Commands and players"
            className="max-h-[60dvh] overflow-y-auto p-2"
          >
            {items.length === 0 && query.trim().length >= 2 && !searching && (
              <li
                role="status"
                aria-live="polite"
                className="px-3 py-8 text-center text-sm text-muted-foreground"
              >
                No results for {query.trim()}
              </li>
            )}

            {items.map((item, i) => (
              <li
                key={`${item.kind}-${item.id}`}
                id={`cmdk-option-${i}`}
                role="option"
                aria-selected={i === activeIndex}
              >
                <button
                  type="button"
                  onClick={() =>
                    item.kind === 'user' ? go(`/user/${item.username}`) : go(item.href)
                  }
                  onMouseEnter={() => setActiveIndex(i)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors',
                    i === activeIndex
                      ? 'bg-white/8 text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {item.kind === 'action' ? (
                    <IconFor actionId={item.id} />
                  ) : (
                    <ProfileAvatar username={item.username} size={26} />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {item.kind === 'action'
                      ? item.label
                      : (item.display_name ?? `@${item.username}`)}
                  </span>
                  {item.kind === 'user' && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      @{item.username}
                    </span>
                  )}
                  {i === activeIndex && (
                    <CornerDownLeft className="ml-auto size-3.5 shrink-0 opacity-50" />
                  )}
                </button>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-4 border-t border-white/8 px-4 py-2.5 text-[0.65rem] text-muted-foreground">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-white/10 bg-white/5 px-1">â†‘â†“</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-white/10 bg-white/5 px-1">â†µ</kbd>
              select
            </span>
            <span className="ml-auto hidden items-center gap-1 sm:flex">
              <kbd className="rounded border border-white/10 bg-white/5 px-1">esc</kbd>
              close
            </span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function IconFor({ actionId }: { actionId: string }) {
  const Icon =
    actionId === 'nav-home'
      ? Home
      : actionId === 'nav-discover'
        ? Compass
        : actionId === 'nav-profile'
          ? User
          : actionId === 'log'
            ? PlusCircle
            : List;
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/6">
      <Icon className="size-3.5" />
    </span>
  );
}

export { Bookmark };
