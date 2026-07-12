import { Button } from '@clodex/stage-ui/components/button';
import { HotkeyActions } from '@shared/hotkeys';
import { HotkeyCombo } from '@ui/components/hotkey-combo';
import { cn } from '@ui/utils';
import {
  ArrowUpIcon,
  CheckIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  FolderIcon,
  LoaderCircleIcon,
  MessageSquarePlusIcon,
  SparklesIcon,
  XIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

const QUICK_STARTS = [
  'Review the current changes and report issues',
  'Run the relevant tests and fix failures',
  'Explain the architecture of this project',
] as const;

export type QuickTaskComposerSubmitResult =
  | { ok: true }
  | { ok: false; error: string };

export type QuickTaskComposerProps = {
  initialPrompt: string;
  hasCurrentWorkspace: boolean;
  workspaceLabels: string[];
  modelLabel: string;
  approvalLabel: string;
  mode: 'overlay' | 'window';
  shortcut?: ReactNode;
  successMessage?: string;
  successDurationMs?: number;
  onClose: () => void;
  onSuccess?: () => void;
  onSubmit: (
    prompt: string,
    useCurrentWorkspace: boolean,
  ) => Promise<QuickTaskComposerSubmitResult>;
};

export function QuickTaskComposer({
  initialPrompt,
  hasCurrentWorkspace,
  workspaceLabels,
  modelLabel,
  approvalLabel,
  mode,
  shortcut,
  successMessage = 'Task created. Opening it now…',
  successDurationMs = 650,
  onClose,
  onSuccess,
  onSubmit,
}: QuickTaskComposerProps) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [useCurrentWorkspace, setUseCurrentWorkspace] =
    useState(hasCurrentWorkspace);
  const [submitting, setSubmitting] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (successTimerRef.current !== null) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }
    setPrompt(initialPrompt);
    setUseCurrentWorkspace(hasCurrentWorkspace);
    setSubmitting(false);
    setSucceeded(false);
    setError(null);
    const frame = requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const length = textareaRef.current?.value.length ?? 0;
      textareaRef.current?.setSelectionRange(length, length);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (successTimerRef.current !== null) {
        clearTimeout(successTimerRef.current);
        successTimerRef.current = null;
      }
    };
  }, [hasCurrentWorkspace, initialPrompt]);

  const handleClose = useCallback(() => {
    if (!submitting && !succeeded) onClose();
  }, [onClose, submitting, succeeded]);

  const handleSubmit = useCallback(async () => {
    const text = prompt.trim();
    if (!text || submitting || succeeded) return;
    setSubmitting(true);
    setSucceeded(false);
    setError(null);
    try {
      const result = await onSubmit(text, useCurrentWorkspace);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSucceeded(true);
      if (onSuccess) {
        successTimerRef.current = setTimeout(() => {
          successTimerRef.current = null;
          onSuccess();
        }, successDurationMs);
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The quick task could not be created. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    onSubmit,
    onSuccess,
    prompt,
    submitting,
    succeeded,
    successDurationMs,
    useCurrentWorkspace,
  ]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        handleClose();
        return;
      }
      if (
        event.key === 'Enter' &&
        (event.metaKey || event.ctrlKey) &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        event.stopPropagation();
        void handleSubmit();
      }
    },
    [handleClose, handleSubmit],
  );

  const interactionLocked = submitting || succeeded;
  const canSubmit = prompt.trim().length > 0 && !interactionLocked;
  const content = (
    <div
      className={cn(
        'overflow-hidden border bg-token-main-surface-primary/96 shadow-codex-2xl ring-1 ring-black/5 backdrop-blur-2xl dark:ring-white/5',
        mode === 'window'
          ? 'h-full w-full overflow-y-auto rounded-[18px] border-white/50 dark:border-white/10'
          : 'w-full max-w-[680px] rounded-3xl border-white/45 dark:border-white/12',
      )}
    >
      <header
        className={cn(
          'flex items-center justify-between gap-4 border-token-border-light border-b px-5 py-4',
          mode === 'window' && 'app-drag',
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-clodex-green-400/10 text-clodex-green-400 ring-1 ring-clodex-green-400/15">
            <MessageSquarePlusIcon className="size-4.5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate font-semibold text-base text-token-text-primary tracking-[-0.01em]">
              {succeeded ? 'Task created' : 'Quick task'}
            </h1>
            <p className="truncate text-token-text-tertiary text-xs">
              {succeeded
                ? 'Opening the new task in Clodex.'
                : 'Create and run a task without leaving your current context.'}
            </p>
          </div>
        </div>
        <div className="app-no-drag flex shrink-0 items-center gap-2">
          {shortcut ?? (
            <HotkeyCombo
              action={HotkeyActions.OPEN_QUICK_TASK}
              size="xs"
              variant="chrome"
            />
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close quick task"
            disabled={interactionLocked}
            onClick={handleClose}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </header>

      <div className="p-4 sm:p-5">
        <div className="rounded-2xl border border-token-border-light bg-token-bg-secondary/35 p-2 shadow-codex-sm transition-colors focus-within:border-token-border-default focus-within:bg-token-main-surface-primary">
          <textarea
            ref={textareaRef}
            aria-label="Quick task prompt"
            placeholder="What should Clodex do?"
            value={prompt}
            disabled={interactionLocked}
            className="min-h-32 w-full resize-none bg-transparent px-2.5 py-2 text-[15px] text-token-text-primary leading-6 outline-none placeholder:text-token-text-tertiary disabled:opacity-60"
            onChange={(event) => setPrompt(event.currentTarget.value)}
          />

          <div className="flex flex-col gap-2 border-token-border-light border-t px-1.5 pt-2.5 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              aria-pressed={useCurrentWorkspace}
              disabled={!hasCurrentWorkspace || interactionLocked}
              className={cn(
                'flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-xs transition-[background-color,border-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border disabled:cursor-not-allowed disabled:opacity-50',
                useCurrentWorkspace && hasCurrentWorkspace
                  ? 'border-clodex-green-400/20 bg-clodex-green-400/8 text-token-text-primary shadow-codex-hairline'
                  : 'border-token-border-light bg-token-main-surface-primary/55 text-token-text-secondary hover:bg-token-list-hover-background',
              )}
              onClick={() => setUseCurrentWorkspace((current) => !current)}
            >
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-lg',
                  useCurrentWorkspace && hasCurrentWorkspace
                    ? 'bg-clodex-green-400/12 text-clodex-green-400'
                    : 'bg-token-bg-tertiary text-token-text-tertiary',
                )}
              >
                {useCurrentWorkspace && hasCurrentWorkspace ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <FolderIcon className="size-3.5" />
                )}
              </span>
              <span className="min-w-0">
                <span className="block font-medium">
                  {hasCurrentWorkspace
                    ? useCurrentWorkspace
                      ? 'Current workspace'
                      : 'No workspace'
                    : 'No workspace connected'}
                </span>
                {hasCurrentWorkspace && (
                  <span className="block max-w-72 truncate text-[11px] text-token-text-tertiary">
                    {workspaceLabels.slice(0, 2).join(', ')}
                    {workspaceLabels.length > 2
                      ? ` +${workspaceLabels.length - 2}`
                      : ''}
                  </span>
                )}
              </span>
            </button>

            <Button
              variant="primary"
              size="sm"
              className="h-10 shrink-0 rounded-xl px-4 shadow-codex-sm"
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
            >
              {submitting ? (
                <LoaderCircleIcon className="size-3.5 animate-spin" />
              ) : succeeded ? (
                <CheckIcon className="size-3.5" />
              ) : (
                <ArrowUpIcon className="size-3.5" />
              )}
              {submitting ? 'Creating…' : succeeded ? 'Created' : 'Create task'}
            </Button>
          </div>
        </div>

        {!prompt.trim() && (
          <div className="mt-3 flex flex-wrap gap-2">
            {QUICK_STARTS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="flex items-center gap-1.5 rounded-full border border-token-border-light bg-token-main-surface-primary/65 px-3 py-1.5 text-token-text-secondary text-xs shadow-codex-hairline transition-colors hover:bg-token-list-hover-background hover:text-token-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
                onClick={() => {
                  setPrompt(suggestion);
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
              >
                <SparklesIcon className="size-3 text-clodex-green-400" />
                {suggestion}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mt-3 flex items-start gap-2 rounded-xl border border-error-solid/25 bg-error-solid/8 px-3 py-2.5 text-token-text-secondary text-xs leading-5"
          >
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-error-solid" />
            <span>{error}</span>
          </div>
        )}

        {succeeded && (
          <div
            role="status"
            aria-live="polite"
            className="mt-3 flex items-start gap-2 rounded-xl border border-success-solid/25 bg-success-solid/8 px-3 py-2.5 text-token-text-secondary text-xs leading-5"
          >
            <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-success-foreground" />
            <span>{successMessage}</span>
          </div>
        )}

        <footer className="mt-4 flex flex-col gap-2 border-token-border-light border-t pt-3 text-[11px] text-token-text-tertiary sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              Model:{' '}
              <span className="text-token-text-secondary">{modelLabel}</span>
            </span>
            <span>
              Approval:{' '}
              <span className="text-token-text-secondary">{approvalLabel}</span>
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-1.5">
            Send with
            <HotkeyCombo action={HotkeyActions.CMD_ENTER} size="xs" />
          </span>
        </footer>
      </div>
    </div>
  );

  if (mode === 'window') {
    return (
      <div
        className="h-screen w-screen bg-transparent p-2"
        onKeyDownCapture={handleKeyDown}
      >
        {content}
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quick task"
      data-quick-task-modal-root=""
      className="app-no-drag fixed inset-0 z-[110] flex items-start justify-center bg-overlay/45 px-3 pt-[clamp(3.5rem,12vh,8.5rem)] pb-3 backdrop-blur-[3px] sm:px-6"
      onKeyDownCapture={handleKeyDown}
    >
      <button
        type="button"
        aria-label="Close quick task"
        className="absolute inset-0 cursor-default"
        disabled={interactionLocked}
        onClick={handleClose}
      />
      <div className="relative z-10 w-full max-w-[680px]">{content}</div>
    </div>
  );
}
