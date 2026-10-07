import type { Metadata } from 'next';
import Link from 'next/link';
import { Search, Trophy, Users, Flame, Sparkles } from 'lucide-react';
import { getTopRatedGames, getTrendingGames, getSiteStats } from '@/app/actions/discover';
import UserSearch from '@/components/UserSearch';
import ReviewSearch from '@/components/ReviewSearch';
import { GameCover } from '@/components/ui-primitives';
import { EmptyState, SectionHeader } from '@/components/EmptyState';

export const metadata: Metadata = {
  title: 'Discover games',
  description:
    'Find the highest rated games on GameJournal, see what is trending, and find players to follow.',
  alternates: { canonical: '/discover' },
};

export default async function DiscoverPage() {
  // Sequential rather than parallel: each of these is one aggregate query, and
  // keeping them serial keeps peak database connections at 1 for this page.
  //
  // `minLogs = 1` is safe now that ranking is confidence-weighted inside
  // `get_top_rated_games` — a single 10/10 is shrunk toward the prior mean
  // rather than being allowed to top the board, so no hard floor is needed and
  // the leaderboard is not artificially empty on a small site.
  const topGames = await getTopRatedGames(24, 1).catch(() => []);
  const trending = await getTrendingGames(168, 18).catch(() => []);
  const stats = await getSiteStats().catch(() => ({ logs: 0, users: 0, games: 0 }));

  return (
    <div className="mx-auto max-w-5xl space-y-14 px-4 sm:px-6">
      {/* Header */}
      <header className="glass relative mt-8 overflow-hidden rounded-3xl p-6 sm:p-8">
        <div
          className="pointer-events-none absolute -top-20 -right-10 size-56 rounded-full opacity-30 blur-3xl"
          style={{ background: 'var(--brand-2)' }}
          aria-hidden="true"
        />
        <div className="relative">
          <p className="flex items-center gap-1.5 text-xs font-medium tracking-wider text-brand uppercase">
            <Sparkles className="size-3" />
            Discover
          </p>
          <h1 className="mt-1.5 font-heading text-3xl font-bold tracking-tight">
            Find your next obsession
          </h1>
          <p className="mt-2 max-w-xl text-pretty text-muted-foreground">
            Rankings are computed across every log in the database, not a sample,
            so what you see is the real community verdict.
          </p>

          <div className="mt-5 flex flex-wrap gap-5 text-sm">
            <Stat value={stats.games} label="games" icon={Trophy} />
            <Stat value={stats.logs} label="logs" icon={Search} />
            <Stat value={stats.users} label="players" icon={Users} />
          </div>
        </div>
      </header>

      {/* User search */}
      <section>
        <SectionHeader
          title="Find players"
          description="Search for someone by username to follow their activity."
        />
        <div className="mt-4 max-w-sm">
          <UserSearch />
        </div>
      </section>

      {/* Review search */}
      <section>
        <SectionHeader
          title="Search reviews"
          description="Full-text search across everything the community has written."
        />
        <div className="mt-5">
          <ReviewSearch />
        </div>
      </section>

      {/* Top rated */}
      <section>
        <SectionHeader
          title="Top rated"
          description="Highest average score across the community."
        />
        <div className="mt-5">
          {topGames.length === 0 ? (
            <EmptyState
              icon={Trophy}
              title="No ratings yet"
              description="Once players start rating games, the leaderboard appears here."
            />
          ) : (
            <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
              {topGames.map((game, index) => (
                <li key={game.gameId} className="animate-stagger" style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}>
                  <Link href={`/game/${game.gameId}`} className="group block">
                    <div className="relative aspect-[3/4] overflow-hidden rounded-xl">
                      <GameCover
                        src={game.coverUrl}
                        alt={game.name}
                        className="transition-transform duration-300 group-hover:scale-110"
                      />
                      <span
                        className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-white/8 ring-inset"
                        aria-hidden="true"
                      />
                      {index === 0 && (
                        <span className="brand-gradient absolute top-1.5 left-1.5 rounded-full px-1.5 py-0.5 text-[0.6rem] font-bold text-white shadow-lg">
                          #1
                        </span>
                      )}
                      {game.avgRating != null && (
                        <span className="absolute right-1.5 bottom-1.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[0.65rem] font-bold tabular-nums backdrop-blur-sm">
                          {game.avgRating.toFixed(1)}
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
                      {game.name}
                    </p>
                    <p className="text-[0.65rem] text-ink-faint">
                      {game.logCount} {game.logCount === 1 ? 'log' : 'logs'}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Trending */}
      <section>
        <SectionHeader
          title="Trending this week"
          description="Most logged in the last seven days."
        />
        <div className="mt-5">
          {trending.length === 0 ? (
            <EmptyState
              icon={Flame}
              title="Nothing trending"
              description="Check back once a few games have been logged this week."
            />
          ) : (
            <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
              {trending.map((game, index) => (
                <li key={game.gameId} className="animate-stagger" style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}>
                  <Link href={`/game/${game.gameId}`} className="group block">
                    <div className="relative aspect-[3/4] overflow-hidden rounded-xl">
                      <GameCover
                        src={game.coverUrl}
                        alt={game.name}
                        className="transition-transform duration-300 group-hover:scale-110"
                      />
                      <span
                        className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-white/8 ring-inset"
                        aria-hidden="true"
                      />
                      <span className="absolute right-1.5 bottom-1.5 inline-flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[0.65rem] font-bold backdrop-blur-sm">
                        <Flame className="size-2.5 text-orange-400" />
                        {game.recentLogs}
                      </span>
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
                      {game.name}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function Stat({
  value,
  label,
  icon: Icon,
}: {
  value: number;
  label: string;
  icon: React.ElementType;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <Icon className="size-4 text-brand" />
      <span className="font-bold tabular-nums">{value.toLocaleString()}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}
