import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Globe, Lock, Calendar, List as ListIcon, ArrowLeft } from 'lucide-react';
import { getListById } from '@/app/actions/lists';
import { getUser } from '@/lib/supabase';
import { validateUuid } from '@/lib/validation';
import { formatDate } from '@/lib/date';
import { GameCover } from '@/components/ui-primitives';
import { EmptyState } from '@/components/EmptyState';

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;

  try {
    validateUuid(id, 'list id');
  } catch {
    return { title: 'List not found' };
  }

  // getListById returns null for private lists the viewer does not own, so a
  // private list is not leaked through metadata either.
  const list = await getListById(id).catch(() => null);
  if (!list) return { title: 'List not found', robots: { index: false } };

  const description =
    list.description ??
    `A GameJournal list with ${list.games.length} ${list.games.length === 1 ? 'game' : 'games'}.`;

  return {
    title: list.name,
    description,
    alternates: { canonical: `/list/${id}` },
    openGraph: { type: 'website', title: list.name, description },
    robots: { index: list.is_public, follow: true },
  };
}

export default async function ListPage({ params }: Params) {
  const { id } = await params;

  let listId: string;
  try {
    listId = validateUuid(id, 'list id');
  } catch {
    notFound();
  }

  const [list, currentUser] = await Promise.all([
    getListById(listId).catch(() => null),
    getUser(),
  ]);

  // null means either the list does not exist, or it is private and the
  // viewer is not the owner. Both are a 404 from the outside.
  if (!list) notFound();

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6">
      <div className="mt-8">
        <Link
          href={currentUser ? '/profile' : '/discover'}
          className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5 transition-transform group-hover:-translate-x-0.5" />
          Back to {currentUser ? 'your library' : 'discover'}
        </Link>

        <header className="glass mt-4 rounded-3xl p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2.5 font-heading text-3xl font-bold tracking-tight">
                <ListIcon className="size-6 shrink-0 text-brand" />
                <span className="truncate">{list.name}</span>
              </h1>
              {list.description && (
                <p className="mt-2 max-w-2xl text-pretty text-muted-foreground">
                  {list.description}
                </p>
              )}
            </div>

            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/6 px-3 py-1.5 text-xs font-medium text-muted-foreground">
              {list.is_public ? (
                <>
                  <Globe className="size-3" />
                  Public
                </>
              ) : (
                <>
                  <Lock className="size-3" />
                  Private
                </>
              )}
            </span>
          </div>

          <p className="mt-4 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Calendar className="size-3.5" />
            {list.games.length} {list.games.length === 1 ? 'game' : 'games'} · Created{' '}
            {formatDate(list.created_at)}
          </p>
        </header>

        {list.games.length === 0 ? (
          <EmptyState
            className="mt-8"
            icon={ListIcon}
            title="This list is empty"
            description="Games added to this list will appear here."
          />
        ) : (
          <div className="mt-8 grid grid-cols-3 gap-3 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-8">
            {list.games.map((game, index) => (
              <Link
                key={game.gameId}
                href={`/game/${game.gameId}`}
                className="group animate-stagger"
                style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
              >
                <div className="relative aspect-[3/4] overflow-hidden rounded-xl">
                  <GameCover
                    src={game.coverUrl}
                    alt={game.name}
                    className="transition-transform duration-300 group-hover:scale-110"
                    sizes="(max-width: 640px) 33vw, 14vw"
                  />
                  <span
                    className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-white/8 ring-inset"
                    aria-hidden="true"
                  />
                </div>
                <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
                  {game.name}
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
