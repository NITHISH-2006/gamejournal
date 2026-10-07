'use client';

import { useState, useEffect, useRef, useTransition } from 'react';
import Link from 'next/link';
import { Search, Loader2, X } from 'lucide-react';
import { searchReviews, type SearchHit } from '@/app/actions/stats';
import { GameCover } from '@/components/ui-primitives';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Full-text review search.
 *
 * Backs `search_logs` in 002, which replaces the 001 version: that one built
 * its tsvector inline for every row on every call with no index behind it, had
 * no pagination at all (a hard 48-row cap with no way to reach row 49), and
 * ordered by `count(*)` with no tiebreak, so two identical searches could
 * return results in different orders.
 *
 * The request-sequence guard mirrors the one in `LogGameModal`: `clearTimeout`
 * cannot cancel a round-trip already in flight, so without it a slow early
 * query can land after a fast later one and overwrite the correct results.
 */
export default function ReviewSearch() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState<{ matchCount: number; gameId: number } | null>(null);
  const [searched, setSearched] = useState(false);
  const [pending, startTransition] = useTransition();
  const requestId = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();

    requestId.current += 1;
    const id = requestId.current;

    if (trimmed.length < 2) {
      // Deferred a frame: synchronous setState in an effect body causes a
      // cascading render, which React 19 flags.
      const raf = requestAnimationFrame(() => {
        setHits([]);
        setCursor(null);
        setSearched(false);
      });
      return () => cancelAnimationFrame(raf);
    }

    const timer = setTimeout(() => {
      startTransition(async () => {
        const res = await searchReviews(trimmed, 24).catch(() => ({
          hits: [],
          nextCursor: null,
        }));
        if (id !== requestId.current) return;
        setHits(res.hits);
        setCursor(res.nextCursor);
        setSearched(true);
      });
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  const loadMore = () => {
    const trimmed = query.trim();
    if (!cursor) return;
    startTransition(async () => {
      const res = await searchReviews(trimmed, 24, cursor).catch(() => ({
        hits: [],
        nextCursor: null,
      }));
      if (!res.hits.length) {
        setCursor(null);
        return;
      }
      // Append, and guard against a double-click firing the same page twice.
      setHits((prev) => {
        const seen = new Set(prev.map((h) => h.game_id));
        return [...prev, ...res.hits.filter((h) => !seen.has(h.game_id))];
      });
      setCursor(res.nextCursor);
    });
  };

  return (
    <section aria-label="Search reviews">
      <div className="relative mb-5">
        <Search
          className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-ink-faint"
          aria-hidden="true"
        />
        {pending && (
          <Loader2
            className="absolute top-1/2 right-4 size-4 -translate-y-1/2 animate-spin text-ink-faint"
            aria-hidden="true"
          />
        )}
        <label htmlFor="review-search" className="sr-only">
          Search game reviews
        </label>
        <Input
          id="review-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search what players are saying..."
          className="h-12 pr-11 pl-11 text-base"
          autoComplete="off"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="absolute top-1/2 right-3 -translate-y-1/2 rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-white/8 hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* Announce the result count: search resolves asynchronously. */}
      <p role="status" aria-live="polite" className="sr-only">
        {searched && !pending
          ? `${hits.length} result${hits.length === 1 ? '' : 's'} found`
          : ''}
      </p>

      {searched && !pending && hits.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-ink-muted text-sm">
            No reviews matched &ldquo;{query.trim()}&rdquo;.
          </p>
          <p className="text-ink-faint mt-1 text-xs">
            Try a different word, or search by a title on the leaderboard.
          </p>
        </Card>
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {hits.map((hit) => (
              <li key={hit.game_id}>
                <Link href={`/game/${hit.game_id}`} className="group block h-full">
                  <Card
                    className={cn(
                      'flex h-full gap-3 p-3 transition-all duration-300',
                      'hover:border-white/20'
                    )}
                  >
                    <div className="relative aspect-[3/4] w-16 shrink-0 overflow-hidden rounded-xl">
                      <GameCover
                        src={hit.cover_url}
                        alt={hit.name}
                        className="transition-transform duration-300 group-hover:scale-110"
                        sizes="64px"
                      />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <p className="truncate text-sm font-semibold transition-colors group-hover:text-brand">
                        {hit.name}
                      </p>
                      {hit.latest_review && (
                        <p className="text-ink-muted mt-1 line-clamp-3 text-xs">
                          {hit.latest_review}
                        </p>
                      )}
                      <p className="text-ink-faint mt-auto pt-1.5 text-[0.65rem]">
                        {hit.match_count} matching review
                        {hit.match_count === 1 ? '' : 's'}
                      </p>
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>

          {cursor && (
            <div className="mt-5 flex justify-center">
              <Button variant="glass" onClick={loadMore} disabled={pending}>
                {pending ? <Loader2 className="animate-spin" /> : null}
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
