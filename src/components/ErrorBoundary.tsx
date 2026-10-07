'use client';

import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

type Props = {
  children: ReactNode;
  fallback?: ReactNode;
  /** Change this value to reset the boundary, e.g. the current pathname. */
  resetKey?: string;
  label?: string;
};

type State = { hasError: boolean; message: string };

/**
 * Error boundary for a sub-tree of the UI.
 *
 * Improvements over the original:
 *  - Accepts a `resetKey` so the boundary clears automatically when the route
 *    changes. The old "Try again" button just cleared state; if the child
 *    threw deterministically it immediately re-threw, so the retry was useless.
 *  - Shows the error message instead of only logging it to the console.
 *  - `componentDidCatch` logs with a component stack.
 */
export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message || 'Unknown error' };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      `[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`,
      error.message,
      info.componentStack
    );
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, message: '' });
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div
          className="glass rounded-2xl border-rose-500/20 p-6 text-center"
          role="alert"
        >
          <span
            className="mx-auto mb-3 flex size-11 items-center justify-center rounded-xl bg-rose-500/12"
            aria-hidden="true"
          >
            <AlertTriangle className="size-5 text-rose-400" />
          </span>
          <p className="font-heading text-sm font-semibold">
            {this.props.label ?? 'This section failed to load'}
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground break-words">
            {this.state.message}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, message: '' })}
            className="neu-button mt-4 inline-flex h-9 items-center gap-2 rounded-xl px-4 text-xs font-medium text-foreground"
          >
            <RefreshCw className="size-3.5" />
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
