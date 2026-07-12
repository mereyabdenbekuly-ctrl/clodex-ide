import { Component } from 'react';
import type { CSSProperties, ErrorInfo, ReactNode } from 'react';
import posthog from 'posthog-js';
import { Button } from '@clodex/stage-ui/components/button';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    posthog.captureException(error, {
      source: 'renderer',
      handler: 'errorBoundary',
      componentStack: errorInfo.componentStack,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
          <h1 className="font-semibold text-xl">Something went wrong</h1>
          <p className="text-muted-foreground text-sm">
            An unexpected error occurred. Please reload the app.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="text-primary-foreground! hover:text-hover-derived! active:text-active-derived!"
            style={
              {
                '--cm-text-color': 'var(--color-primary-foreground)',
              } as CSSProperties
            }
            onClick={() => window.location.reload()}
          >
            Reload
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
