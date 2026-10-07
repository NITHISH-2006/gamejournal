import { cn } from '@/lib/utils';
import { Star } from 'lucide-react';

/**
 * Read-only star rating.
 *
 * Deliberately a Server Component: ratings are rendered on the feed, on every
 * game page and on every profile, and none of those surfaces should ship
 * JavaScript just to draw five stars. The interactive picker lives in
 * `StarInput.tsx`, which is a Client Component.
 */

type RatingProps = {
  value: number;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  showValue?: boolean;
  max?: number;
  className?: string;
  count?: number;
};

const SIZES = {
  xs: 'size-3',
  sm: 'size-3.5',
  md: 'size-4',
  lg: 'size-5',
} as const;

const TEXT = {
  xs: 'text-[0.65rem]',
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base',
} as const;

/** Read-only star row with half-step precision (10-point scale / 5 stars). */
export function StarRating({
  value,
  size = 'sm',
  showValue = false,
  max = 10,
  className,
  count,
}: RatingProps) {
  const stars = max / 2;
  const filled = value / 2;

  return (
    <span
      className={cn('inline-flex items-center gap-1', className)}
      role="img"
      aria-label={`${value} out of ${max}${count != null ? ` from ${count} ratings` : ''}`}
    >
      <span className="inline-flex" aria-hidden="true">
        {Array.from({ length: stars }).map((_, i) => {
          const fill = Math.max(0, Math.min(1, filled - i));
          return (
            <span key={i} className={cn('relative inline-block', SIZES[size])}>
              <Star className={cn(SIZES[size], 'absolute inset-0 text-white/12')} />
              <span
                className="absolute inset-0 overflow-hidden"
                style={{ width: `${fill * 100}%` }}
              >
                <Star className={cn(SIZES[size], 'fill-amber-400 text-amber-400')} />
              </span>
            </span>
          );
        })}
      </span>
      {showValue && (
        <span className={cn('font-semibold tabular-nums', TEXT[size])}>
          {value % 1 === 0 ? value : value.toFixed(1)}
          <span className="text-muted-foreground font-normal">/{max}</span>
        </span>
      )}
    </span>
  );
}

/**
 * Props for the interactive picker. Declared here, consumed by
 * `StarInput.tsx`, so the display component stays free of client hooks.
 */
export type StarInputProps = {
  value: number;
  onChange: (value: number) => void;
  max?: number;
  className?: string;
  disabled?: boolean;
};
