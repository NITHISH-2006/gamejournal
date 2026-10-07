import { cn } from '@/lib/utils';

/** Skeleton block with the shimmer animation. */
export function Skeleton({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("skeleton rounded-xl", className)}
      aria-hidden="true"
      {...props}
    />
  );
}

/** Feed-shaped skeleton rows. */
export function LogCardSkeleton() {
  return (
    <div className="glass flex gap-4 rounded-2xl p-4">
      <Skeleton className="h-24 w-16 shrink-0 rounded-lg" />
      <div className="flex-1 space-y-2.5">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-1/4" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    </div>
  );
}

export function FeedSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading activity">
      {Array.from({ length: count }).map((_, i) => (
        <LogCardSkeleton key={i} />
      ))}
      <span className="sr-only">Loading activity...</span>
    </div>
  );
}

/** Grid of cover-art placeholders. */
export function CoverGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div
      className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6"
      role="status"
      aria-label="Loading games"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="aspect-[3/4] w-full rounded-xl" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
      <span className="sr-only">Loading games...</span>
    </div>
  );
}