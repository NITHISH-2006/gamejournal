import Link from 'next/link';
import { Gamepad2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-6 text-center">
      <span
        className="brand-gradient mb-6 flex size-16 items-center justify-center rounded-2xl shadow-[0_10px_36px_-8px_var(--brand)]"
        aria-hidden="true"
      >
        <Gamepad2 className="size-8 text-white" />
      </span>

      <p className="text-6xl font-bold tracking-tight text-gradient">404</p>

      <h1 className="mt-3 font-heading text-2xl font-bold tracking-tight">
        This page is off the map
      </h1>

      <p className="mt-2 text-pretty text-muted-foreground">
        The game, player or list you are looking for does not exist, or it is
        private.
      </p>

      <div className="mt-8 flex flex-wrap justify-center gap-2">
        <Link href="/">
          <Button variant="primary">
            <Gamepad2 />
            Back to home
          </Button>
        </Link>
        <Link href="/discover">
          <Button variant="glass">
            <Search />
            Discover games
          </Button>
        </Link>
      </div>
    </div>
  );
}
