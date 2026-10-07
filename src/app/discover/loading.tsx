import { CoverGridSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6">
      <CoverGridSkeleton count={18} />
    </div>
  );
}
