import { cn } from '@/lib/utils';

/** Star rating display and input. */
import { Star } from 'lucide-react';

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

type StarInputProps = {
  value: number;
  onChange: (value: number) => void;
  max?: number;
  className?: string;
  disabled?: boolean;
};

/** Interactive 10-point star picker with keyboard support. */
export function StarInput({
  value,
  onChange,
  max = 10,
  className,
  disabled,
}: StarInputProps) {
  const items = Array.from({ length: max }, (_, i) => i + 1);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(Math.min(max, value + 1));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(Math.max(1, value - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onChange(1);
    } else if (e.key === 'End') {
      e.preventDefault();
      onChange(max);
    } else if (/^[0-9]$/.test(e.key)) {
      const n = Number(e.key);
      if (n >= 1 && n <= max) {
        e.preventDefault();
        onChange(n);
      }
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="Rating out of 10"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex items-center gap-1 rounded-xl p-1 outline-none',
        'focus-visible:ring-2 focus-visible:ring-brand/50',
        disabled && 'pointer-events-none opacity-50',
        className
      )}
    >
      {items.map((n) => {
        const active = n <= value;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} of ${max}`}
            disabled={disabled}
            // Roving tabindex: only the currently-selected star is in the tab
            // order. Every star used to be focusable *and* wired to
            // `onFocus={() => onChange(n)}`, so tabbing through the log form
            // fired onChange(1), onChange(2) … onChange(10) — silently
            // overwriting the default rating of 8 before the user touched
            // anything. A radiogroup is required to have exactly one tab stop.
            tabIndex={value === n ? 0 : -1}
            // `onMouseEnter` sets the value, `onClick` commits it so keyboard
            // users are not forced through hover states.
            onMouseEnter={() => onChange(n)}
            onClick={() => onChange(n)}
            className="rounded-md p-0.5 transition-transform duration-150 hover:scale-115 focus-visible:outline-none"
          >
            <Star
              className={cn(
                'size-6 transition-colors duration-150',
                active
                  ? 'fill-amber-400 text-amber-400'
                  : 'text-white/15 hover:text-white/35'
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
