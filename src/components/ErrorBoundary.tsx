'use client';

import { Component, ReactNode } from 'react';

type Props = { children: ReactNode; fallback?: ReactNode };
type State = { hasError: boolean; message: string };

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error) {
    console.error('ErrorBoundary caught:', error.message);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-center">
          <p className="text-zinc-400 text-sm">Something went wrong loading this section.</p>
          <button
            onClick={() => this.setState({ hasError: false, message: '' })}
            className="mt-3 text-xs text-violet-400 hover:text-violet-300 underline"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
