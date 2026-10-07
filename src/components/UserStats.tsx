import { getUserStats } from '@/app/actions/discover';
import { StatTile } from '@/components/ui-primitives';
import { Gamepad2, CheckCircle2, PlayCircle, Star, Library } from 'lucide-react';

/**
 * Dashboard statistics.
 *
 * The previous implementation selected every log row for the user and counted
 * them in JavaScript; this uses count aggregates, so cost is constant as the
 * library grows. Also adds a backlog and favourites tile.
 */
export default async function UserStats({ userId }: { userId: string }) {
  const stats = await getUserStats(userId);

  const tiles = [
    { label: 'Logged', value: stats.total, icon: <Gamepad2 className="size-4" /> },
    {
      label: 'Completed',
      value: stats.completed,
      icon: <CheckCircle2 className="size-4 text-emerald-400" />,
    },
    {
      label: 'Playing',
      value: stats.playing,
      icon: <PlayCircle className="size-4 text-sky-400" />,
    },
    {
      label: 'Backlog',
      value: stats.backlog,
      icon: <Library className="size-4" />,
    },
    {
      label: 'Avg Rating',
      value: stats.avgRating != null ? stats.avgRating.toFixed(1) : '--',
      hint: stats.avgRating != null ? 'out of 10' : undefined,
      icon: <Star className="size-4 text-amber-400" />,
      accent: true,
    },
  ];

  return (
    <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((tile) => (
        <StatTile key={tile.label} {...tile} />
      ))}
    </div>
  );
}
