'use client';

import { useRef, useState, useTransition } from 'react';
import {
  addGameToList,
  removeGameFromList,
  deleteList,
  updateList,
} from '@/app/actions/lists';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useToast } from '@/components/Toast';
import { ListPlus, Check, Loader2, Trash2, Lock, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';

type ListItem = {
  id: string;
  name: string;
  is_public: boolean;
  list_games: { game_id: number }[];
};

type Props = {
  gameId: number;
  gameName: string;
  lists: ListItem[];
};

export default function AddToListButton({ gameId, gameName, lists }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [localLists, setLocalLists] = useState(lists);
  const [viewing, setViewing] = useState<string | null>(null);
  const { toast } = useToast();

  // A ref, not the `pending` state.
  //
  // `useTransition` does not update `pending` synchronously, so two clicks in
  // the same frame both passed `if (pending) return`. The result was a genuine
  // race: `addGameToList` and `removeGameFromList` fired concurrently and the
  // net effect was a no-op, with a success toast for each. This is the same
  // guard `AuthButton` already uses.
  const busy = useRef(false);

  const isInList = (list: ListItem) =>
    list.list_games.some((lg) => lg.game_id === gameId);

  const toggle = (list: ListItem) => {
    if (busy.current) return;
    const inList = isInList(list);

    busy.current = true;
    startTransition(async () => {
      try {
        if (inList) {
          await removeGameFromList(list.id, gameId);
          setLocalLists((prev) =>
            prev.map((l) =>
              l.id === list.id
                ? { ...l, list_games: l.list_games.filter((lg) => lg.game_id !== gameId) }
                : l
            )
          );
          toast(`Removed from "${list.name}"`);
        } else {
          await addGameToList(list.id, gameId);
          setLocalLists((prev) =>
            prev.map((l) =>
              l.id === list.id
                ? { ...l, list_games: [...l.list_games, { game_id: gameId }] }
                : l
            )
          );
          toast(`Added to "${list.name}"`);
        }
      } catch (err) {
        toast((err as Error).message ?? 'Could not update that list', 'error');
      } finally {
        busy.current = false;
      }
    });
  };

  // Both of these previously had no guard at all, so a burst of clicks fired
  // overlapping deletes / visibility flips.
  const handleDelete = (list: ListItem) => {
    if (busy.current) return;
    busy.current = true;
    startTransition(async () => {
      try {
        await deleteList(list.id);
        setLocalLists((prev) => prev.filter((l) => l.id !== list.id));
        setViewing((v) => (v === list.id ? null : v));
        toast(`Deleted "${list.name}"`);
      } catch (err) {
        toast((err as Error).message ?? 'Could not delete that list', 'error');
      } finally {
        busy.current = false;
      }
    });
  };

  const handleVisibility = (list: ListItem) => {
    if (busy.current) return;
    busy.current = true;
    startTransition(async () => {
      try {
        await updateList(list.id, { isPublic: !list.is_public });
        setLocalLists((prev) =>
          prev.map((l) => (l.id === list.id ? { ...l, is_public: !l.is_public } : l))
        );
        toast(list.is_public ? 'List is now private' : 'List is now public');
      } catch (err) {
        toast((err as Error).message ?? 'Could not update visibility', 'error');
      } finally {
        busy.current = false;
      }
    });
  };

  if (localLists.length === 0) return null;

  const activeList = localLists.find((l) => l.id === viewing);

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="glass" size="sm">
            <ListPlus />
            Add to list
          </Button>
        </DialogTrigger>

        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add to a list</DialogTitle>
            <DialogDescription>
              Choose where &ldquo;{gameName}&rdquo; belongs in your library.
            </DialogDescription>
          </DialogHeader>

          <ul className="space-y-2">
            {localLists.map((list) => {
              const inList = isInList(list);
              return (
                <li
                  key={list.id}
                  className={cn(
                    'flex items-center gap-2 rounded-xl border p-1 transition-colors',
                    inList
                      ? 'border-brand/40 bg-brand/10'
                      : 'border-white/8 hover:border-white/15'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggle(list)}
                    disabled={pending}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left"
                  >
                    <span
                      className={cn(
                        'flex size-6 shrink-0 items-center justify-center rounded-lg transition-colors',
                        inList ? 'bg-brand text-white' : 'bg-white/8'
                      )}
                    >
                      {pending ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : inList ? (
                        <Check className="size-3.5" />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                        {list.name}
                        {list.is_public ? (
                          <Globe className="size-3 shrink-0 text-muted-foreground" />
                        ) : (
                          <Lock className="size-3 shrink-0 text-muted-foreground" />
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {list.list_games.length}{' '}
                        {list.list_games.length === 1 ? 'game' : 'games'}
                      </span>
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleVisibility(list)}
                    disabled={pending}
                    className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-white/6 hover:text-foreground"
                    title={list.is_public ? 'Make private' : 'Make public'}
                    aria-label={list.is_public ? 'Make list private' : 'Make list public'}
                  >
                    {list.is_public ? <Globe className="size-3.5" /> : <Lock className="size-3.5" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      // Close the picker before opening the detail view.
                      //
                      // Both dialogs were mounted at once otherwise: two overlays
                      // stacked, two `FocusScope`s fighting over focus, and the
                      // second marking the first `aria-hidden` while it still
                      // looked present.
                      setOpen(false);
                      setViewing(list.id);
                    }}
                    className="rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    View
                  </button>
                </li>
              );
            })}
          </ul>

          <p className="text-[0.65rem] text-muted-foreground">
            Public lists are visible to anyone with the link. Private lists only you
            can see.
          </p>
        </DialogContent>
      </Dialog>

      {/* List detail with remove/delete controls */}
      <Dialog open={Boolean(viewing)} onOpenChange={(v) => !v && setViewing(null)}>
        <DialogContent className="sm:max-w-md">
          {activeList && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {activeList.name}
                  {activeList.is_public ? (
                    <Globe className="size-4 text-muted-foreground" />
                  ) : (
                    <Lock className="size-4 text-muted-foreground" />
                  )}
                </DialogTitle>
                <DialogDescription>
                  {activeList.list_games.length}{' '}
                  {activeList.list_games.length === 1 ? 'game' : 'games'} in this list
                </DialogDescription>
              </DialogHeader>

              <Button
                type="button"
                variant="danger"
                onClick={() => handleDelete(activeList)}
                disabled={pending}
                className="w-full"
              >
                {pending ? <Loader2 className="animate-spin" /> : <Trash2 />}
                Delete list
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
