'use client';

import { useEffect, useRef, useState, useCallback, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Search,
  Loader2,
  CheckCircle2,
  Calendar,
  Hash,
  Clock,
  EyeOff,
  Heart,
  AlertCircle,
  Plus,
} from 'lucide-react';
import { searchGames } from '@/app/actions/igdb';
import { isGameSearchUnavailable } from '@/lib/game-search-error';
import { saveGameLog } from '@/app/actions/logs';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { GameCover } from '@/components/ui-primitives';
import { StarInput } from '@/components/StarInput';
import { LOG_STATUSES, STATUS_META, type Game, type LogStatus } from '@/lib/types';
import { localDateString } from '@/lib/validation';
import { cn } from '@/lib/utils';

const DEBOUNCE_MS = 350;

/**
 * Game logging dialog.
 *
 * Fixes:
 *  - Search is debounced. The previous version fired a Server Action (and
 *    potentially an outbound IGDB request) on every keystroke.
 *  - Results are real <button> elements with arrow-key navigation, so the
 *    picker is keyboard accessible. It was previously a list of clickable
 *    <div>s.
 *  - "Save" is a single atomic action and reports the real error message.
 *  - Logging the same game twice updates the existing entry and the toast
 *    says so, instead of silently creating a duplicate.
 *  - Adds playtime, favourites and spoiler flags, gated on what the database
 *    actually supports.
 */
export default function LogGameModal({
  showTrigger = true,
  presetGame = null,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: {
  /**
   * Set false when a trigger already exists elsewhere on the page.
   *
   * The navbar already mounts one of these at the layout level, and it is
   * also mounted here. Two instances meant two Radix dialogs open at once for
   * `?log=1`: two overlays, two competing focus traps, and the second
   * `aria-hidden`ing the first.
   */
  showTrigger?: boolean;
  /** Log this game directly, skipping the search step. */
  presetGame?: Game | null;
  /** Controlled mode, so a page can supply its own trigger button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  // Controlled when the caller supplies `open`, otherwise self-managed.
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      controlledOnOpenChange?.(next);
    },
    [isControlled, controlledOnOpenChange]
  );
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Game[]>([]);
  /**
   * Only a *user* selection lives in state. The preselected game is a prop and
   * is folded in here, which avoids the `setState` inside an effect that React
   * 19 forbids (and which would also have fought a `router.refresh()`).
   * `null` in this state means "fall back to the preset".
   */
  const [userSelection, setUserSelection] = useState<Game | null>(null);
  const selected = userSelection ?? presetGame;
  const setSelected = (game: Game | null) => setUserSelection(game);
  const [status, setStatus] = useState<LogStatus>('playing');
  const [rating, setRating] = useState(8);
  const [review, setReview] = useState('');
  // Empty on the server on purpose. Client Components are server-rendered,
  // and `localDateString()` reads the *server's* timezone (UTC on Vercel), so
  // seeding it here made the browser hydrate with a different value and
  // React logged a mismatch on every route — the modal is mounted from the
  // root layout. It is populated in an effect below, once the user is
  // actually in their own timezone.
  const [diaryDate, setDiaryDate] = useState('');
  const [tags, setTags] = useState('');
  const [playtime, setPlaytime] = useState('');
  const [isFavorite, setIsFavorite] = useState(false);
  const [hasSpoilers, setHasSpoilers] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const toast = useToast().toast;
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestId = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Populate today's date in the *user's* timezone once mounted. Deferred a
  // frame so this is not a synchronous setState in the effect body, which
  // React 19 flags as causing a cascading render.
  useEffect(() => {
    const id = requestAnimationFrame(() => setDiaryDate(localDateString()));
    return () => cancelAnimationFrame(id);
  }, []);

  // Allows ?log=1 (used by the command palette and empty states) to open the
  // dialog. The param is then stripped, otherwise a refresh or a Back
  // navigation re-opens the modal on top of the page the user just left.
  const wantsOpen = searchParams.get('log') === '1';
  useEffect(() => {
    if (!wantsOpen) return;
    const id = requestAnimationFrame(() => setOpen(true));
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('log');
      window.history.replaceState(null, '', url.toString());
    }
    return () => cancelAnimationFrame(id);
  }, [wantsOpen, setOpen]);

  const reset = useCallback(() => {
    setQuery('');
    setResults([]);
    setUserSelection(null);
    setStatus('playing');
    setRating(8);
    setReview('');
    setDiaryDate(localDateString());
    setTags('');
    setPlaytime('');
    setIsFavorite(false);
    setHasSpoilers(false);
    setError(null);
    setSearchError(null);
    setSaved(false);
    setActiveIndex(0);
  }, []);

  const handleOpenChange = (value: boolean) => {
    setOpen(value);
    if (!value) reset();
  };

  // Debounced, race-safe search.
  useEffect(() => {
    const trimmed = query.trim();

    // Invalidate any in-flight request *before* the early return. Previously
    // the bump only happened on the search path, so selecting a game while a
    // request was outstanding left `requestId` unchanged and the stale
    // response repopulated the dropdown on top of the selection.
    requestId.current += 1;
    const id = requestId.current;

    if (trimmed.length < 2 || selected) {
      const raf = requestAnimationFrame(() => {
        setResults([]);
        setSearching(false);
        setSearchError(null);
      });
      return () => cancelAnimationFrame(raf);
    }

    const timer = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const data = await searchGames(trimmed, 10);
        // Discard responses that arrived after a newer keystroke.
        if (id !== requestId.current) return;
        setResults(data);
        setActiveIndex(0);
        if (data.length === 0) {
          setSearchError('No games matched that search. Try a different title.');
        }
      } catch (err) {
        if (id !== requestId.current) return;
        if (isGameSearchUnavailable(err)) {
          setSearchError(
            'Game search is not configured on this deployment. An administrator needs to add IGDB credentials.'
          );
        } else {
          setSearchError((err as Error).message ?? 'Search failed. Please try again.');
        }
        setResults([]);
      } finally {
        if (id === requestId.current) setSearching(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, selected]);

  // Keep the highlighted result in view.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const handleSelect = (game: Game) => {
    setSelected(game);
    setQuery(game.name);
    setResults([]);
    setError(null);
    setSearchError(null);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (!results.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const game = results[activeIndex];
      if (game) handleSelect(game);
    }
  };

  const handleLog = () => {
    if (!selected || saving || saved) return;
    setSaving(true);
    setError(null);

    startTransition(async () => {
      try {
        const result = await saveGameLog({
          game: selected,
          status,
          rating,
          review,
          diaryDate: diaryDate || undefined,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          playtimeHours: playtime || undefined,
          isFavorite,
          hasSpoilers,
        });

        setSaved(true);
        toast(
          result.updated
            ? `Updated your log for ${result.gameName}`
            : `${result.gameName} logged!`
        );
        router.refresh();
        setTimeout(() => handleOpenChange(false), 900);
      } catch (err) {
        const message = (err as Error).message ?? 'Something went wrong.';
        setError(message);
        toast(message, 'error');
      } finally {
        setSaving(false);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {showTrigger && (
        <DialogTrigger asChild>
          <Button variant="primary" size="sm">
            <Plus className="size-4" />
            <span className="hidden sm:inline">Log a game</span>
            <span className="sm:hidden">Log</span>
          </Button>
        </DialogTrigger>
      )}

      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Log a game</DialogTitle>
          <DialogDescription>
            Search for a title, then rate it, review it and track your progress.
          </DialogDescription>
        </DialogHeader>

        {/* Search */}
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
            {searching && (
              <Loader2 className="absolute top-1/2 right-3.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search for a game..."
              className="pr-10 pl-10"
              aria-label="Search for a game"
              role="combobox"
              aria-expanded={results.length > 0}
              aria-controls="game-search-results"
              aria-autocomplete="list"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {searchError && (
            <p className="flex items-start gap-1.5 text-xs text-amber-300">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              {searchError}
            </p>
          )}

          {results.length > 0 && (
            <ul
              ref={listRef}
              id="game-search-results"
              role="listbox"
              className="max-h-64 overflow-y-auto divide-y divide-white/6 rounded-xl border border-white/8 bg-surface/60"
            >
              {results.map((game, index) => (
                <li key={game.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    onClick={() => handleSelect(game)}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={cn(
                      'flex w-full items-center gap-3 p-3 text-left transition-colors',
                      index === activeIndex ? 'bg-white/8' : 'hover:bg-white/5'
                    )}
                  >
                    <span className="relative block aspect-[3/4] w-9 shrink-0 overflow-hidden rounded-md">
                      <GameCover src={game.cover_url} alt={game.name} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {game.name}
                      </span>
                      {game.release_date && (
                        <span className="block text-xs text-muted-foreground">
                          {game.release_date.slice(0, 4)}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Log form */}
        {selected && (
          <div className="space-y-5 border-t border-white/8 pt-5">
            <div className="flex items-center gap-4">
              <span className="relative block aspect-[3/4] w-14 shrink-0 overflow-hidden rounded-xl">
                <GameCover src={selected.cover_url} alt={selected.name} />
              </span>
              <div className="min-w-0">
                <p className="text-[0.65rem] font-medium tracking-wider text-muted-foreground uppercase">
                  Selected
                </p>
                <h3 className="truncate text-lg font-bold">{selected.name}</h3>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(null);
                    setQuery('');
                  }}
                  className="mt-0.5 text-xs text-brand transition-colors hover:underline"
                >
                  Change game
                </button>
              </div>
            </div>

            {/* Status */}
            <fieldset>
              <legend className="mb-2 text-[0.65rem] font-medium tracking-wider text-muted-foreground uppercase">
                Status
              </legend>
              <div className="flex flex-wrap gap-2">
                {LOG_STATUSES.map((value) => {
                  const meta = STATUS_META[value];
                  const active = status === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setStatus(value)}
                      aria-pressed={active}
                      title={meta.description}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-all duration-200',
                        'ring-1 backdrop-blur-sm',
                        active
                          ? meta.chip
                          : 'text-muted-foreground ring-white/8 hover:bg-white/5 hover:text-foreground'
                      )}
                    >
                      <span
                        className={cn('size-1.5 rounded-full', meta.dot)}
                        aria-hidden="true"
                      />
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* Rating */}
            <div>
              <p className="mb-1.5 text-[0.65rem] font-medium tracking-wider text-muted-foreground uppercase">
                Your rating
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <StarInput value={rating} onChange={setRating} />
                <span className="text-lg font-bold tabular-nums">
                  {rating > 0 ? rating : '--'}
                  <span className="text-sm font-normal text-muted-foreground">/10</span>
                </span>
                {/* Rating 0 means "logged but not yet rated" — the schema's
                    documented meaning for a 0. Without this control the state
                    was unreachable: the modal defaulted to 8 and the stars could
                    only ever go up, so every log was rated. Rating something
                    before you have finished it is the single most common way
                    trackers get abandoned. */}
                <button
                  type="button"
                  onClick={() => setRating(0)}
                  aria-pressed={rating === 0}
                  className="rounded-md px-1.5 py-0.5 text-[0.65rem] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline aria-pressed:text-foreground"
                >
                  {rating === 0 ? 'Not rated yet' : 'Clear rating'}
                </button>
              </div>
              <p className="mt-1 text-[0.65rem] text-muted-foreground">
                Use arrow keys or number keys to rate.
              </p>
            </div>

            {/* Date + playtime */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor="diary-date"
                  className="text-[0.65rem] font-medium tracking-wider text-muted-foreground uppercase"
                >
                  Date played
                </label>
                <div className="relative">
                  <Calendar className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="diary-date"
                    type="date"
                    value={diaryDate}
                    max={localDateString()}
                    onChange={(e) => setDiaryDate(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="playtime"
                  className="text-[0.65rem] font-medium tracking-wider text-muted-foreground uppercase"
                >
                  Playtime (hours)
                </label>
                <div className="relative">
                  <Clock className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="playtime"
                    type="number"
                    min={0}
                    max={9999}
                    step={0.5}
                    inputMode="decimal"
                    placeholder="e.g. 42.5"
                    value={playtime}
                    onChange={(e) => setPlaytime(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>
            </div>

            {/* Review */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="review"
                  className="text-[0.65rem] font-medium tracking-wider text-muted-foreground uppercase"
                >
                  Review
                </label>
                <span className="text-[0.65rem] tabular-nums text-muted-foreground">
                  {review.length}/2000
                </span>
              </div>
              <Textarea
                id="review"
                value={review}
                maxLength={2000}
                onChange={(e) => setReview(e.target.value)}
                placeholder="What did you think?"
                className="min-h-28"
              />
            </div>

            {/* Tags */}
            <div className="space-y-1.5">
              <label
                htmlFor="tags"
                className="text-[0.65rem] font-medium tracking-wider text-muted-foreground uppercase"
              >
                Tags
              </label>
              <div className="relative">
                <Hash className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="rpg, masterpiece, replay"
                  className="pl-10"
                />
              </div>
              <p className="text-[0.65rem] text-muted-foreground">
                Comma separated, up to 10 tags.
              </p>
            </div>

            {/* Toggles */}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setIsFavorite((v) => !v)}
                aria-pressed={isFavorite}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition-all',
                  isFavorite
                    ? 'bg-rose-500/15 text-rose-300 ring-rose-400/30'
                    : 'text-muted-foreground ring-white/8 hover:bg-white/5 hover:text-foreground'
                )}
              >
                <Heart className={cn('size-3.5', isFavorite && 'fill-current')} />
                {isFavorite ? 'Favourite' : 'Mark as favourite'}
              </button>

              <button
                type="button"
                onClick={() => setHasSpoilers((v) => !v)}
                aria-pressed={hasSpoilers}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition-all',
                  hasSpoilers
                    ? 'bg-amber-500/15 text-amber-300 ring-amber-400/30'
                    : 'text-muted-foreground ring-white/8 hover:bg-white/5 hover:text-foreground'
                )}
              >
                <EyeOff className="size-3.5" />
                {hasSpoilers ? 'Contains spoilers' : 'No spoilers'}
              </button>
            </div>

            {error && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                {error}
              </p>
            )}

            <Button
              type="button"
              onClick={handleLog}
              disabled={saving || saved}
              variant="success"
              className="h-12 w-full text-base"
            >
              {saved ? (
                <>
                  <CheckCircle2 className="size-5" />
                  Saved!
                </>
              ) : saving ? (
                <>
                  <Loader2 className="size-5 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save log'
              )}
            </Button>
          </div>
        )}

        {!selected && !results.length && !searching && query.length < 2 && (
          <p className="text-center text-xs text-muted-foreground">
            Start typing to search the game database.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
