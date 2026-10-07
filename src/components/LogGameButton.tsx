'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import LogGameModal from '@/components/LogGameModal';
import { Button } from '@/components/ui/button';
import type { Game } from '@/lib/types';

/**
 * "Log this game" control for the game detail page.
 *
 * This exists as a client component because `LogGameModal` needs open state,
 * and the page that hosts it is an async Server Component — hooks cannot be
 * called there.
 *
 * Rendering the modal here with `showTrigger={false}` also fixes a real bug:
 * the navbar already mounts a `LogGameModal` at the layout level, and the page
 * used to mount a second one. Two instances meant `?log=1` opened two Radix
 * dialogs simultaneously — two overlays, two competing focus traps, and the
 * second `aria-hidden`ing the first.
 */
export default function LogGameButton({ game }: { game: Game }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        Log this game
      </Button>
      <LogGameModal
        showTrigger={false}
        open={open}
        onOpenChange={setOpen}
        presetGame={game}
      />
    </>
  );
}
