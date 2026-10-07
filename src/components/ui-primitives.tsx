import Image from 'next/image';
import { cn } from '@/lib/utils';
import { STATUS_META, type LogStatus } from '@/lib/types';
import { isAllowedImageUrl } from '@/lib/images';
import { Heart, Bookmark } from 'lucide-react';

type GameCoverProps = {
  src: string | null | undefined;
  alt: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
};

/**
 * Game cover art with a graceful fallback.
 *
 * Uses next/image so covers are resized, lazy-loaded and served as modern
 * formats. The previous pages used raw <img>, which shipped full-resolution
 * IGDB art to every grid cell and was flagged by the Next.js linter.
 *
 * The host check is not cosmetic. `next/image` throws on a `src` whose host is
 * absent from `images.remotePatterns`, at render time, which takes down every
 * page that shows the game. Rows already in the database may predate the
 * write-side allow-list in `src/lib/validation.ts`, so the guard has to exist
 * here too. Failing closed to the placeholder is a degraded card, not an
 * outage.
 */
export function GameCover({ src, alt, className, sizes, priority }: GameCoverProps) {
  if (!src || !isAllowedImageUrl(src)) {
    return (
      <div
        className={cn(
          'neu-inset flex items-center justify-center rounded-xl',
          className
        )}
        role="img"
        aria-label={`${alt} (no cover art)`}
      >
        <span className="px-2 text-center text-[0.6rem] leading-tight text-ink-faint">
          {alt.length > 22 ? `${alt.slice(0, 20)}...` : alt}
        </span>
      </div>
    );
  }

  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes ?? '(max-width: 640px) 40vw, (max-width: 1024px) 25vw, 15vw'}
      priority={priority}
      className={cn('object-cover', className)}
    />
  );
}

/** Status pill built from the shared STATUS_META map. */
export function StatusPill({
  status,
  size = 'sm',
  className,
}: {
  status: LogStatus;
  size?: 'xs' | 'sm';
  className?: string;
}) {
  const meta = STATUS_META[status] ?? STATUS_META.backlog;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-medium ring-1 backdrop-blur-sm',
        meta.chip,
        size === 'xs' ? 'px-2 py-0.5 text-[0.65rem]' : 'px-2.5 py-1 text-xs',
        className
      )}
    >
      <span className={cn('size-1.5 rounded-full', meta.dot)} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

/** Circular avatar with a brand gradient fallback. */
export function ProfileAvatar({
  username,
  avatarUrl,
  size = 40,
  className,
}: {
  username: string;
  avatarUrl?: string | null;
  size?: number;
  className?: string;
}) {
  const initial = (username?.[0] ?? '?').toUpperCase();
  // Same render-time guard as GameCover: an unlisted host makes next/image
  // throw and takes the page down with it.
  const usableAvatar = isAllowedImageUrl(avatarUrl) ? avatarUrl : null;

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full',
        'brand-gradient font-semibold text-white ring-1 ring-white/15',
        className
      )}
      style={{ width: size, height: size, fontSize: Math.max(11, size * 0.38) }}
    >
      {usableAvatar ? (
        <Image
          src={usableAvatar}
          alt=""
          fill
          sizes={`${size}px`}
          className="object-cover"
        />
      ) : (
        <span aria-hidden="true">{initial}</span>
      )}
      <span className="sr-only">{username}</span>
    </span>
  );
}

/** Compact metric tile used across the stats strips. */
export function StatTile({
  label,
  value,
  hint,
  icon,
  accent = false,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        'group/stat relative overflow-hidden rounded-2xl p-4 text-center',
        accent ? 'glass ring-brand' : 'glass'
      )}
    >
      {accent && (
        <div
          className="pointer-events-none absolute inset-x-0 -top-8 h-16 opacity-60 blur-2xl"
          style={{ background: 'var(--brand)' }}
          aria-hidden="true"
        />
      )}
      <div className="relative flex flex-col items-center gap-1">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        <span
          className={cn(
            'text-2xl font-bold tabular-nums tracking-tight',
            accent && 'text-gradient'
          )}
        >
          {value}
        </span>
        <span className="text-[0.65rem] font-medium tracking-wider text-muted-foreground uppercase">
          {label}
        </span>
        {hint && <span className="text-[0.65rem] text-ink-muted">{hint}</span>}
      </div>
    </div>
  );
}

/** Pill filter/segmented control. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'md',
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: React.ReactNode; count?: number }[];
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      role="tablist"
      className={cn(
        'neu-inset inline-flex items-center gap-1 rounded-2xl p-1',
        className
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-xl font-medium transition-all duration-200',
              size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm',
              active
                ? 'brand-gradient text-white shadow-[0_4px_14px_-4px_var(--brand)]'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {opt.label}
            {opt.count != null && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[0.6rem] font-semibold tabular-nums',
                  active ? 'bg-white/20' : 'bg-white/8'
                )}
              >
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Tag chip. */
export function TagChip({ tag }: { tag: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-white/6 px-2 py-0.5 text-[0.7rem] text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground">
      #{tag}
    </span>
  );
}

/** Spoiler-aware review text. */
export function ReviewText({
  text,
  hasSpoilers = false,
  className,
}: {
  text: string;
  hasSpoilers?: boolean;
  className?: string;
}) {
  return (
    <p
      className={cn('text-sm leading-relaxed whitespace-pre-wrap text-zinc-300', className)}
    >
      {hasSpoilers ? (
        <details className="group">
          <summary className="cursor-pointer list-none text-xs font-medium text-brand hover:underline">
            Contains spoilers - tap to reveal
          </summary>
          <span className="mt-2 block">{text}</span>
        </details>
      ) : (
        text
      )}
    </p>
  );
}

export { Heart, Bookmark };
