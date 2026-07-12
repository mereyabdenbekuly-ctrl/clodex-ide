import { Button } from '@clodex/stage-ui/components/button';
import { TooltipProvider } from '@clodex/stage-ui/components/tooltip';
import type {
  QuickTaskWindowBridge,
  QuickTaskWindowContext,
} from '@shared/quick-task-window';
import {
  QuickTaskComposer,
  type QuickTaskComposerSubmitResult,
} from '@ui/screens/main/quick-task/quick-task-composer';
import {
  CircleAlertIcon,
  Loader2Icon,
  RotateCcwIcon,
  XIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isPlainEscape,
  selectNewestQuickTaskContext,
} from './quick-task-window-lifecycle';

const CONTEXT_LOAD_TIMEOUT_MS = 5_000;

declare global {
  interface Window {
    quickTask: QuickTaskWindowBridge;
  }
}

function syncSystemTheme() {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    document.documentElement.classList.toggle('dark', media.matches);
  };
  apply();
  media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
}

function QuickTaskWindowLoadingState({
  error,
  onRetry,
  onClose,
}: {
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-transparent p-2">
      <div className="app-drag relative flex h-full w-full items-center justify-center rounded-[18px] border border-white/40 bg-token-main-surface-primary shadow-codex-2xl dark:border-white/10">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close quick task"
          className="app-no-drag absolute top-4 right-4"
          onClick={onClose}
        >
          <XIcon className="size-3.5" />
        </Button>
        {error ? (
          <div className="app-no-drag flex max-w-sm flex-col items-center gap-4 px-6 text-center">
            <span className="flex size-10 items-center justify-center rounded-xl bg-error-solid/10 text-error-foreground">
              <CircleAlertIcon className="size-5" />
            </span>
            <div>
              <h1 className="font-medium text-sm text-token-text-primary">
                Quick Task could not load
              </h1>
              <p className="mt-1 text-token-text-tertiary text-xs leading-5">
                {error}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="rounded-xl"
              onClick={onRetry}
            >
              <RotateCcwIcon className="size-3.5" />
              Retry
            </Button>
          </div>
        ) : (
          <div
            role="status"
            aria-live="polite"
            className="flex flex-col items-center gap-3 text-token-text-tertiary text-xs"
          >
            <Loader2Icon className="size-5 animate-spin" />
            <span>Loading Quick Task…</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function QuickTaskWindowApp() {
  const [context, setContext] = useState<QuickTaskWindowContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadAttemptRef = useRef(0);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => syncSystemTheme(), []);

  const applyContext = useCallback((value: QuickTaskWindowContext) => {
    if (loadTimeoutRef.current !== null) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
    setLoadError(null);
    setContext((current) => selectNewestQuickTaskContext(current, value));
  }, []);

  const loadContext = useCallback(() => {
    const attempt = ++loadAttemptRef.current;
    if (loadTimeoutRef.current !== null) {
      clearTimeout(loadTimeoutRef.current);
    }
    setContext(null);
    setLoadError(null);
    loadTimeoutRef.current = setTimeout(() => {
      if (loadAttemptRef.current !== attempt) return;
      loadTimeoutRef.current = null;
      setLoadError(
        'Clodex did not provide the window context in time. Retry or reopen the window.',
      );
    }, CONTEXT_LOAD_TIMEOUT_MS);

    void window.quickTask
      .getContext()
      .then((value) => {
        if (loadAttemptRef.current === attempt) applyContext(value);
      })
      .catch(() => {
        if (loadAttemptRef.current !== attempt) return;
        if (loadTimeoutRef.current !== null) {
          clearTimeout(loadTimeoutRef.current);
          loadTimeoutRef.current = null;
        }
        setLoadError(
          'The current task context is unavailable. Check that the main Clodex window is still running.',
        );
      });
  }, [applyContext]);

  useEffect(() => {
    const unsubscribe = window.quickTask.onContext((value) => {
      applyContext(value);
    });
    loadContext();
    return () => {
      loadAttemptRef.current += 1;
      if (loadTimeoutRef.current !== null) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      unsubscribe();
    };
  }, [applyContext, loadContext]);

  useEffect(() => {
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (!isPlainEscape(event)) return;
      event.preventDefault();
      event.stopPropagation();
      void window.quickTask.close();
    };
    window.addEventListener('keydown', dismissOnEscape);
    return () => window.removeEventListener('keydown', dismissOnEscape);
  }, []);

  const handleSubmit = useCallback(
    async (
      prompt: string,
      useCurrentWorkspace: boolean,
    ): Promise<QuickTaskComposerSubmitResult> => {
      const result = await window.quickTask.submit({
        requestId: context?.requestId ?? -1,
        prompt,
        useCurrentWorkspace,
      });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    [context?.requestId],
  );

  if (!context) {
    return (
      <QuickTaskWindowLoadingState
        error={loadError}
        onRetry={loadContext}
        onClose={() => void window.quickTask.close()}
      />
    );
  }

  return (
    <TooltipProvider>
      <QuickTaskComposer
        key={context.requestId}
        initialPrompt={context.initialPrompt}
        hasCurrentWorkspace={context.hasCurrentWorkspace}
        workspaceLabels={context.workspaceLabels}
        modelLabel={context.modelLabel}
        approvalLabel={context.approvalLabel}
        mode="window"
        shortcut={
          <span className="rounded-md border border-token-border-light bg-token-bg-secondary/60 px-1.5 py-0.5 font-mono text-[10px] text-token-text-tertiary">
            Esc
          </span>
        }
        onClose={() => void window.quickTask.close()}
        onSubmit={handleSubmit}
      />
    </TooltipProvider>
  );
}
