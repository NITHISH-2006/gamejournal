import Link from 'next/link';
import {
  Flame,
  Trophy,
  Clock,
  Heart,
  Star,
  BookOpen,
  Gamepad2,
  TrendingUp,
} from 'lucide-react';
import { StatTile, GameCover } from '@/components/ui-primitives';
import { getActivityStats, getYearInReview } from '@/app/actions/stats';
import { Card } from '@/components/ui/card';
import { formatPlaytime } from '@/lib/date';

function initials(count: number) {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/**
 * Player statistics: streaks, totals and a year in review.
 *
 * Renders nothing when the analytics functions are unavailable, which is the
 * case on a pre-002 database. Degrading to "no panel" is better than showing a
 * grid of zeros, which reads as "this player has done nothing" rather than
 * "this feature is not installed".
 * `ownerName` exists because this component is rendered on other people's public
 * profiles as well as on /profile. The heading said "Your statistics" on
 * somebody else's page, which is both wrong and misleading for a screen reader.
 */
export default async function StatsPanel({
  userId,
  ownerName = 'this player',
}: {
  userId: string;
  ownerName?: string;
}) {
  const [stats, review] = await Promise.all([
    getActivityStats(userId).catch(() => null),
    getYearInReview(userId).catch(() => null),
  ]);

  if (!stats || stats.totalLogs === 0) return null;

  const peak = Math.max(1, ...(review?.mostPlayed ?? []).map((g) => g.logs));

  return (
    <section
      className="space-y-5"
      aria-label={`${ownerName.charAt(0).toUpperCase()}${ownerName.slice(1)} statistics`}
    >
      {/* Headline numbers */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label="Current streak"
          value={stats.currentStreak}
          hint={stats.currentStreak === 1 ? 'day' : 'days'}
          icon={<Flame className="size-4 text-orange-400" />}
          accent={stats.currentStreak > 0}
        />
        <StatTile
          label="Longest streak"
          value={stats.longestStreak}
          icon={<Trophy className="size-4 text-amber-400" />}
        />
        <StatTile
          label="Avg rating"
          value={stats.avgRating != null ? stats.avgRating.toFixed(1) : '--'}
          hint="out of 10"
          icon={<Star className="size-4 text-amber-400" />}
        />
        <StatTile
          label="Playtime"
          value={formatPlaytime(stats.totalPlaytime)}
          icon={<Clock className="size-4" />}
        />
        <StatTile
          label="Reviews"
          value={stats.reviewCount}
          icon={<BookOpen className="size-4" />}
        />
        <StatTile
          label="Favourites"
          value={stats.favorites}
          icon={<Heart className="size-4 text-rose-400" />}
        />
      </div>

      {/* Year in review */}
      {review && review.gamesPlayed > 0 && (
        <Card className="relative overflow-hidden p-6 sm:p-8">
          <div
            className="pointer-events-none absolute -top-16 left-1/2 size-64 -translate-x-1/2 rounded-full opacity-25 blur-3xl"
            style={{ background: 'var(--brand)' }}
            aria-hidden="true"
          />
          <div className="relative">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="flex items-center gap-2 font-heading text-xl font-bold tracking-tight">
                <TrendingUp className="size-5 text-brand" />
                {review.year} in review
              </h2>
              <p className="text-ink-muted text-sm">
                {initials(review.gamesPlayed)} games ·{' '}
                {initials(review.gamesCompleted)} completed ·{' '}
                {initials(review.reviewsWritten)} reviews
              </p>
            </div>

            <div className="mt-5 grid gap-6 sm:grid-cols-2">
              <div>
                <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wider uppercase">
                  Most played
                </h3>
                <ul className="space-y-2">
                  {(review.mostPlayed ?? []).slice(0, 5).map((g) => (
                    <li key={g.game_id}>
                      <Link
                        href={`/game/${g.game_id}`}
                        className="group flex items-center gap-3"
                      >
                        <div className="relative aspect-square w-9 shrink-0 overflow-hidden rounded-lg">
                          <GameCover
                            src={g.cover_url}
                            alt={g.name}
                            className="transition-transform duration-300 group-hover:scale-110"
                            sizes="36px"
                          />
                        </div>
                        <span className="min-w-0 flex-1 truncate text-sm transition-colors group-hover:text-brand">
                          {g.name}
                        </span>
                        <span className="shrink-0 text-ink-muted text-xs tabular-nums">
                          {g.logs}
                        </span>
                      </Link>
                      {/* Proportional bar — the "at a glance" read that a bare
                          number does not give you. */}
                      <div
                        className="mt-1 h-1 overflow-hidden rounded-full bg-white/6"
                        role="presentation"
                      >
                        <div
                          className="h-full rounded-full bg-brand/60"
                          style={{ width: `${Math.round((g.logs / peak) * 100)}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wider uppercase">
                  Top rated
                </h3>
                <ul className="space-y-2">
                  {(review.topRated ?? []).slice(0, 5).map((g) => (
                    <li key={g.game_id}>
                      <Link
                        href={`/game/${g.game_id}`}
                        className="group flex items-center gap-3"
                      >
                        <div className="relative aspect-square w-9 shrink-0 overflow-hidden rounded-lg">
                          <GameCover
                            src={g.cover_url}
                            alt={g.name}
                            className="transition-transform duration-300 group-hover:scale-110"
                            sizes="36px"
                          />
                        </div>
                        <span className="min-w-0 flex-1 truncate text-sm transition-colors group-hover:text-brand">
                          {g.name}
                        </span>
                        <span className="shrink-0 text-xs font-semibold text-amber-400 tabular-nums">
                          {g.rating}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {stats.activeDays > 0 && (
              <p className="text-ink-faint mt-5 text-xs">
                Logged on {initials(stats.activeDays)} separate days ·{' '}
                {initials(stats.distinctGames)} distinct games ·{' '}
                {initials(stats.completed)} completed
              </p>
            )}
          </div>
        </Card>
      )}

      {/* Status breakdown */}
      {stats.totalLogs > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Gamepad2 className="text-ink-faint size-4" aria-hidden="true" />
          {(
            [
              ['Completed', stats.completed, 'bg-emerald-400'],
              ['Playing', stats.playing, 'bg-sky-400'],
              ['Backlog', stats.backlog, 'bg-zinc-400'],
              ['Abandoned', stats.abandoned, 'bg-rose-400'],
            ] as const
          ).map(([label, value, dot]) => (
            <span
              key={label}
              className="glass inline-flex items-center gap-1.5 rounded-full px-2.5 py-1"
            >
              <span className={`size-1.5 rounded-full ${dot}`} aria-hidden="true" />
              <span className="font-medium tabular-nums">{value}</span>
              <span className="text-ink-muted">{label.toLowerCase()}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
