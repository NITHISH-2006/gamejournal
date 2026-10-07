import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  description?: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
  className?: string;
  compact?: boolean;
};

/**
 * Empty / zero-data state.
 *
 * Every list in the app previously rendered a bare "No logs yet." string with
 * no visual container, so empty sections looked broken rather than empty.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'glass flex flex-col items-center justify-center rounded-2xl text-center',
        compact ? 'gap-2 p-8' : 'gap-3 p-12',
        className
      )}
    >
      {Icon && (
        <span
          className="neu-inset flex size-14 items-center justify-center rounded-2xl"
          aria-hidden="true"
        >
          <Icon className="size-6 text-brand" />
        </span>
      )}
      <div className="space-y-1">
        <p className="font-heading text-base font-semibold">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground text-balance">
            {description}
          </p>
        )}
      </div>
      {actionLabel && actionHref && (
        <Link
          href={actionHref}
          className="neu-button mt-2 inline-flex h-10 items-center gap-2 rounded-xl px-5 text-sm font-medium text-white brand-gradient"
        >
          {actionLabel}
        </Link>
      )}
      {actionLabel && !actionHref && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="neu-button mt-2 inline-flex h-10 items-center gap-2 rounded-xl px-5 text-sm font-medium text-white brand-gradient"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/** Page-level section heading. */
export function SectionHeader({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-end justify-between gap-4', className)}>
      <div className="space-y-1">
        <h2 className="font-heading text-xl font-bold tracking-tight">{title}</h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
