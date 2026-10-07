'use client';

import { useState, useTransition, useEffect, useCallback, useRef } from 'react';
import { Filter, Loader2, X, SlidersHorizontal } from 'lucide-react';
import { browseGames, type BrowseHit, type BrowseSort } from '@/app/actions/browse';
import { Button } from '@/components/ui/button';
import { GameCover } from '@/components/ui-primitives';
import { formatYear } from '@/lib/date';
import type { LogStatus } from '@/lib/types';

/**
 * Filterable game browser.
 *
 * Filters are applied in the query, not in the browser. Slicing an already-fetched
 * page would mean downloading everything to show 24 rows, and would make the
 * counts beside each filter wrong.
 *
 * The filter state lives in the URL so a filtered view can be shared and survives
 * a refresh — the difference between a browser and a toy.
 */

const SORTS: { value: BrowseSort; label: string }[] = [
  { value: 'recent', label: 'Recently active' },
  { value: 'rating', label: 'Highest rated' },
  { value: 'most_logged', label: 'Most logged' },
  { value: 'discussed', label: 'Most discussed' },
];

const STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'playing', label: 'Playing' },
  { value: 'completed', label: 'Completed' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'abandoned', label: 'Abandoned' },
] as const;

type State = {
  status: string;
  minRating: number;
  tag: string | null;
  year: number | null;
  minLogs: number;
  sort: BrowseSort;
};

const EMPTY: State = {
  status: '',
  minRating: 0,
  tag: null,
  year: null,
  minLogs: 0,
  sort: 'recent',
};

function readState(): State {
  if (typeof window === 'undefined') return EMPTY;
  const p = new URLSearchParams(window.location.search);
  const status = p.get('status') ?? '';
  const minRating = Number(p.get('minRating') ?? 0);
  const tag = p.get('tag');
  const year = Number(p.get('year'));
  const minLogs = Number(p.get('minLogs') ?? 0);
  const sort = (p.get('sort') ?? 'recent') as BrowseSort;

  return {
    status: STATUSES.some((s) => s.value === status) ? status : '',
    minRating: Number.isFinite(minRating) ? Math.min(Math.max(minRating, 0), 10) : 0,
    tag,
    year: Number.isFinite(year) && year > 0 ? year : null,
    minLogs: Number.isFinite(minLogs) ? Math.min(Math.max(minLogs, 0), 500) : 0,
    sort: SORTS.some((s) => s.value === sort) ? sort : 'recent',
  };
}

export default function GameBrowser() {
  const [state, setState] = useState<State>(EMPTY);
  const [hits, setHits] = useState<BrowseHit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [pending, startTransition] = useTransition();

  /*
   * Monotonic request id.
   *
   * Every query takes a ticket before it starts and checks it before it writes
   * state. Without this, two filters changed in quick succession race: the
   * *slower* response wins if it lands second, so the grid shows results for
   * filters the user has already changed away from, while the controls read
   * something else entirely. Stale responses are discarded.
   *
   * A ref, not state: it must be readable and writable inside an async callback
   * without causing a render.
   */
  const requestId = useRef(0);

  /*
   * Debounce for the controls that fire on every change event.
   *
   * The rating slider and the two number inputs call update on each event, so
   * dragging the slider from 0 to 8 queues eight queries — each one a full
   * aggregate over game_logs. Two of them are almost always in flight at once,
   * which is what the request id above exists to clean up.
   *
   * Selects are excluded: they produce one event per deliberate choice, so
   * delaying them would feel broken rather than responsive.
   */
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback((next: State) => {
    const ticket = ++requestId.current;

    startTransition(async () => {
      try {
        const result = await browseGames({
          status: (next.status || null) as LogStatus | null,
          minRating: next.minRating || null,
          tag: next.tag,
          year: next.year,
          minLogs: next.minLogs || null,
          sort: next.sort,
        });

        // Superseded while in flight. Writing now would show stale results.
        if (ticket !== requestId.current) return;

        setHits(result.hits);
        setTotal(result.total);
        setError(null);

        /*
         * The URL is written only by the winning request.
         *
         * Writing it on every control change instead would mean the address bar
         * could describe a query whose results are still in flight — and if that
         * query then failed, the URL would claim a filter the grid does not show.
         */
        const p = new URLSearchParams();
        if (next.status) p.set('status', next.status);
        if (next.minRating) p.set('minRating', String(next.minRating));
        if (next.tag) p.set('tag', next.tag);
        if (next.year) p.set('year', String(next.year));
        if (next.minLogs) p.set('minLogs', String(next.minLogs));
        if (next.sort !== 'recent') p.set('sort', next.sort);
        const qs = p.toString();
        window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
      } catch (err) {
        if (ticket !== requestId.current) return;

        setError((err as Error).message);
        /*
         * The previous results are deliberately kept.
         *
         * `setHits([])` on failure told the user the filter matched nothing —
         * a confident, specific, wrong claim. A network blip mid-filter made a
         * populated library appear empty, and the empty state offered "clear all
         * filters", so the natural next click made it worse. The error says what
         * happened; the stale grid stays visible and is labelled as such.
         */
      }
    });
  }, []);

  /**
   * Reads the filter state out of the URL and runs the first query together.
   *
   * Deferred a frame because the URL is only meaningful on the client, and a
   * synchronous setState in an effect body is a cascading render (React 19 flags
   * it explicitly). An earlier version had two effects racing over a `ready`
   * flag, which could leave the browser unfiltered if the second lost the race.
   */
  useEffect(() => {
    const initial = readState();
    const id = requestAnimationFrame(() => {
      setState(initial);
      run(initial);
    });
    return () => cancelAnimationFrame(id);
  }, [run]);

  // Cancel a pending debounce on unmount so it cannot set state on a dead tree.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  /** Applies a change immediately. For selects and tag chips. */
  function updateNow(patch: Partial<State>) {
    const next = { ...state, ...patch };
    setState(next);

    // Cancel any queued debounced run so it cannot overwrite this one.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    run(next);
  }

  /**
   * Coalesces rapid changes into one query. For sliders and number inputs.
   *
   * The control's own label updates immediately because `state` is set
   * synchronously — only the query waits. So the slider tracks the pointer while
   * the grid updates once, on release or after the user stops moving.
   */
  function updateDebounced(patch: Partial<State>) {
    const next = { ...state, ...patch };
    setState(next);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      run(next);
    }, 300);
  }

  function clear() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setState(EMPTY);
    run(EMPTY);
  }

  const activeCount =
    (state.status ? 1 : 0) +
    (state.minRating ? 1 : 0) +
    (state.tag ? 1 : 0) +
    (state.year ? 1 : 0) +
    (state.minLogs ? 1 : 0);

  return (
    <section aria-labelledby="browse-heading">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="browse-heading" className="font-heading text-lg font-bold tracking-tight">
            Browse everything
          </h2>
          <p className="text-sm text-ink-muted">
            Every game anyone has logged, filterable.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="browse-sort" className="sr-only">
            Sort results
          </label>
          <select
            id="browse-sort"
            value={state.sort}
            onChange={(e) => updateNow({ sort: e.target.value as BrowseSort })}
            disabled={pending}
            className="h-9 rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value} className="bg-surface">
                {s.label}
              </option>
            ))}
          </select>

          <Button
            variant="glass"
            size="sm"
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
            aria-controls="browse-filters"
          >
            <SlidersHorizontal className="size-3.5" aria-hidden="true" />
            Filters
            {activeCount > 0 && (
              <span className="ml-0.5 rounded-full bg-brand px-1.5 text-[0.6rem] font-bold text-white">
                {activeCount}
              </span>
            )}
          </Button>
        </div>
      </div>

      {showFilters && (
        <div
          id="browse-filters"
          className="mb-4 grid gap-3 rounded-2xl border border-white/10 bg-white/4 p-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <div className="space-y-1">
            <label htmlFor="filter-status" className="text-xs text-ink-muted">
              Status
            </label>
            <select
              id="filter-status"
              value={state.status}
              onChange={(e) => updateNow({ status: e.target.value })}
              disabled={pending}
              className="h-9 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
            >
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value} className="bg-surface">
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="filter-rating" className="text-xs text-ink-muted">
              Minimum rating: {state.minRating || 'any'}
            </label>
            <input
              id="filter-rating"
              type="range"
              min={0}
              max={10}
              step={1}
              value={state.minRating}
              onChange={(e) => updateDebounced({ minRating: Number(e.target.value) })}
              disabled={pending}
              className="w-full accent-[var(--brand)]"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="filter-year" className="text-xs text-ink-muted">
              Release year
            </label>
            <input
              id="filter-year"
              type="number"
              min={1970}
              max={2100}
              placeholder="e.g. 2020"
              value={state.year ?? ''}
              onChange={(e) =>
                updateDebounced({ year: e.target.value ? Number(e.target.value) : null })
              }
              disabled={pending}
              className="h-9 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="filter-logs" className="text-xs text-ink-muted">
              Minimum logs: {state.minLogs || 'any'}
            </label>
            <input
              id="filter-logs"
              type="number"
              min={0}
              max={500}
              placeholder="e.g. 5"
              value={state.minLogs || ''}
              onChange={(e) =>
                updateDebounced({ minLogs: e.target.value ? Number(e.target.value) : 0 })
              }
              disabled={pending}
              className="h-9 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
            />
          </div>

          {activeCount > 0 && (
            <div className="sm:col-span-2 lg:col-span-4">
              <Button variant="glass" size="sm" onClick={clear} disabled={pending}>
                <X className="size-3.5" aria-hidden="true" />
                Clear all filters
              </Button>
            </div>
          )}
        </div>
      )}

      {state.tag && (
        <p className="mb-3 flex items-center gap-2 text-sm text-ink-muted">
          <Filter className="size-3.5" aria-hidden="true" />
          Tagged
          <span className="rounded-md bg-brand/20 px-1.5 py-0.5 text-xs text-foreground">
            #{state.tag}
          </span>
          <button
            type="button"
            onClick={() => updateNow({ tag: null })}
            className="underline underline-offset-2 hover:text-foreground"
          >
            clear
          </button>
        </p>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {pending ? 'Loading games' : `${total} games found`}
      </p>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
          {/*
            Only say the results are stale when there are results to be stale.
            On a first load that failed there is nothing on screen, and
            "showing previous results" would be describing a grid the user never
            saw.
          */}
          {hits && hits.length > 0 && (
            <span className="ml-1 text-ink-muted">
              Still showing the previous results.
            </span>
          )}
        </p>
      )}

      {pending && hits === null ? (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="skeleton aspect-[3/4] rounded-xl" />
          ))}
        </div>
      ) : hits && hits.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-white/4 p-8 text-center">
          <p className="text-sm text-ink-muted">
            Nothing matches those filters. Try widening them.
          </p>
          {activeCount > 0 && (
            <Button variant="glass" size="sm" onClick={clear} className="mt-3">
              Clear all filters
            </Button>
          )}
        </div>
      ) : (
        hits && (
          <>
            {pending && (
              <p className="mb-2 flex items-center gap-1.5 text-xs text-ink-muted">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                Updating…
              </p>
            )}
            <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
              {hits.map((hit) => (
                <li key={hit.gameId}>
                  <a
                    href={`/game/${hit.gameId}`}
                    className="group block focus-visible:outline-none"
                    title={hit.name}
                  >
                    <GameCover
                      src={hit.coverUrl}
                      alt={hit.name}
                      sizes="(min-width: 1024px) 11vw, (min-width: 640px) 22vw, 30vw"
                      className="aspect-[3/4] w-full rounded-xl transition-transform group-hover:scale-105"
                    />
                    <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
                      {hit.name}
                    </p>
                    <p className="text-[0.65rem] text-ink-faint">
                      {hit.avgRating != null ? `${hit.avgRating.toFixed(1)}★ · ` : ''}
                      {hit.logCount} {hit.logCount === 1 ? 'log' : 'logs'}
                      {hit.releaseYear ? ` · ${formatYear(String(hit.releaseYear)) ?? hit.releaseYear}` : ''}
                    </p>
                  </a>
                </li>
              ))}
            </ul>

            {total > hits.length && (
              <p className="mt-4 text-center text-xs text-ink-faint">
                Showing {hits.length} of {total} matching games.{' '}
                <button
                  type="button"
                  onClick={() => run({ ...state })}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Refine the filters to narrow it down
                </button>
              </p>
            )}
          </>
        )
      )}
    </section>
  );
}