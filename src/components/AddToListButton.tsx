'use client';

import { useState, useTransition } from 'react';
import { addGameToList, removeGameFromList } from '@/app/actions/lists';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useToast } from '@/components/Toast';
import { ListPlus, Loader2, Check } from 'lucide-react';

type ListItem = {
  id: string;
  name: string;
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
  const { toast } = useToast();

  const isInList = (list: ListItem) =>
    list.list_games.some((lg) => lg.game_id === gameId);

  const toggle = (list: ListItem) => {
    const inList = isInList(list);
    startTransition(async () => {
      try {
        if (inList) {
          await removeGameFromList(list.id, gameId);
          setLocalLists((prev) =>
            prev.map((l) => l.id === list.id
              ? { ...l, list_games: l.list_games.filter((lg) => lg.game_id !== gameId) }
              : l
            )
          );
          toast(`Removed from "${list.name}"`);
        } else {
          await addGameToList(list.id, gameId);
          setLocalLists((prev) =>
            prev.map((l) => l.id === list.id
              ? { ...l, list_games: [...l.list_games, { game_id: gameId }] }
              : l
            )
          );
          toast(`Added to "${list.name}"`);
        }
      } catch (err: any) {
        toast(err.message ?? 'Failed', 'error');
      }
    });
  };

  if (lists.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="border-zinc-700 text-zinc-300 hover:text-white">
          <ListPlus className="h-4 w-4 mr-1.5" /> Add to List
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-sm bg-zinc-950 border-zinc-800 text-white">
        <DialogHeader>
          <DialogTitle className="text-white text-base">Add "{gameName}" to a list</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          {localLists.map((list) => {
            const inList = isInList(list);
            return (
              <button
                key={list.id}
                onClick={() => toggle(list)}
                disabled={pending}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border transition-colors text-left
                  ${inList
                    ? 'border-violet-700 bg-violet-950/40 text-violet-300'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700'
                  }`}
              >
                <span className="text-sm font-medium">{list.name}</span>
                {inList && <Check className="h-4 w-4 text-violet-400 flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
