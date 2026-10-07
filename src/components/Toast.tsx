'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { CheckCircle2, XCircle, X, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

type ToastType = 'success' | 'error' | 'info';

type ToastItem = {
  id: number;
  message: string;
  type: ToastType;
  leaving?: boolean;
};

type ToastContextValue = {
  toast: (message: string, type?: ToastType) => void;
};

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

/**
 * Toast tones.
 *
 * Uses the design tokens rather than a hard-coded Tailwind palette. The previous
 * values pinned `text-emerald-100`, `text-rose-100` and `text-zinc-100` plus
 * literal `rgba()` shadows, so the three toasts could not respond to a theme
 * change and had to be edited by hand whenever one was made — which is how a
 * low-contrast surface survives a contrast audit.
 */
const TONES: Record<ToastType, { className: string; Icon: typeof CheckCircle2 }> = {
  success: {
    className: 'border-success/25 bg-success/12 text-ink',
    Icon: CheckCircle2,
  },
  error: {
    className: 'border-destructive/25 bg-destructive/12 text-ink',
    Icon: XCircle,
  },
  info: {
    className: 'border-white/12 bg-white/8 text-ink',
    Icon: Info,
  },
};

const DISMISS_AFTER = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  /**
   * Fix: the counter used to be a plain `let` in the component body, so it was
   * reset to 0 on every render. Every toast therefore received id 1, which
   * broke React's list keys and made the auto-dismiss timer for one toast
   * remove whichever toast happened to share its id. A ref persists across
   * renders and gives each toast a stable unique id.
   */
  const counter = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const remove = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, type: ToastType = 'success') => {
      counter.current += 1;
      const id = counter.current;

      setToasts((prev) => {
        // Cap the stack so a rapid burst of errors cannot fill the screen.
        const next = [...prev, { id, message, type }];
        return next.length > 4 ? next.slice(next.length - 4) : next;
      });

      const timer = setTimeout(() => remove(id), DISMISS_AFTER);
      timers.current.set(id, timer);
    },
    [remove]
  );

  // Clear pending timers if the provider unmounts.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}

      {/* Lifted clear of the fixed mobile tab bar (which is `bottom-0` and
          `z-50` on < md) and respects the iOS home-indicator inset, so the
          dismiss button is never underneath it. */}
      <div
        className="pointer-events-none fixed inset-x-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[100] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:items-end"
        role="region"
        aria-label="Notifications"
      >

        {toasts.map((t) => {
          const { Icon, className } = TONES[t.type];
          return (
            <div
              key={t.id}
              // Errors use `alert`/assertive. Every toast was previously
              // `status`/polite, so a failure like "Could not update your
              // watchlist" was announced at the same low priority as a success
              // and was routinely missed.
              role={t.type === 'error' ? 'alert' : 'status'}
              aria-live={t.type === 'error' ? 'assertive' : 'polite'}
              className={cn(
                'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border px-4 py-3',
                'backdrop-blur-xl animate-rise text-sm font-medium',
                className
              )}
            >
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="flex-1 leading-snug">{t.message}</span>
              <button
                type="button"
                onClick={() => remove(t.id)}
                className="-mt-0.5 shrink-0 rounded-md p-1 opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100"
                aria-label="Dismiss notification"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
