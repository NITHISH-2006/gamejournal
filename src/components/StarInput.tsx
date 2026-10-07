'use client';

import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Star } from 'lucide-react';
import type { StarInputProps } from '@/components/StarRating';

/** Interactive 10-point star picker with keyboard support. */
export function StarInput({
  value,
  onChange,
  max = 10,
  className,
  disabled,
}: StarInputProps) {
  const items = Array.from({ length: max }, (_, i) => i + 1);

  /**
   * Preview-only value, set by hover.
   *
   * Previously `onMouseEnter` called `onChange` directly — the same handler as
   * `onClick`, despite a comment claiming hover "sets" the value and click
   * "commits" it. In the edit dialog that is silent data corruption: the user
   * reaches for the stars, then moves the pointer toward the Save button, and the
   * rating has already been rewritten by whatever star they passed over. It then
   * persisted, with no undo and no confirmation.
   */
  const [hovered, setHovered] = useState<number | null>(null);

  // The preview wins while the pointer or keyboard focus is on the group, and the
  // committed value takes over the moment it leaves.
  const shown = hovered ?? value;

  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * Moves DOM focus to the star that now holds the roving tabindex.
   *
   * Without this, ArrowRight updates `value` — and therefore which button has
   * `tabIndex={0}` — while focus stays on the button the user started from, which
   * has just become `tabIndex={-1}`. The arrows keep working because the event
   * bubbles to the container, but the focus ring sits on the wrong star and the
   * "checked" state is off-screen from focus.
   */
  function focusStar(next: number) {
    const clamped = Math.min(max, Math.max(1, next));
    onChange(clamped);
    const target = containerRef.current?.querySelector<HTMLButtonElement>(
      `[data-star="${clamped}"]`
    );
    target?.focus();
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusStar(value + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusStar(value - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusStar(1);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusStar(max);
    } else if (/^[0-9]$/.test(e.key)) {
      const n = Number(e.key);
      if (n >= 1 && n <= max) {
        e.preventDefault();
        focusStar(n);
      }
    }
  };

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label="Rating out of 10"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={handleKeyDown}
      onMouseLeave={() => setHovered(null)}
      className={cn(
        'inline-flex items-center gap-1 rounded-xl p-1 outline-none',
        'focus-visible:ring-2 focus-visible:ring-brand/50',
        disabled && 'pointer-events-none opacity-50',
        className
      )}
    >
      {items.map((n) => {
        const active = n <= shown;
        return (
          <button
            key={n}
            data-star={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} of ${max}`}
            disabled={disabled}
            // Roving tabindex: exactly one tab stop for the whole radiogroup.
            // Every star used to be focusable *and* wired to onFocus, so tabbing
            // through the log form fired onChange(1) through onChange(10) and
            // overwrote the default rating before the user touched anything.
            tabIndex={value === n ? 0 : -1}
            onMouseEnter={() => setHovered(n)}
            onFocus={() => setHovered(n)}
            onBlur={() => setHovered((h) => (h === n ? null : h))}
            // The only place the rating is actually written.
            onClick={() => {
              onChange(n);
              setHovered(null);
            }}
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
