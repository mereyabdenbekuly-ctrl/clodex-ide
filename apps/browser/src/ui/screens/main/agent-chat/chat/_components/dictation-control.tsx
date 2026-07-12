import { Button } from '@clodex/stage-ui/components/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@clodex/stage-ui/components/tooltip';
import type { DictationState } from '@shared/dictation';
import { HotkeyActions } from '@shared/hotkeys';
import { HotkeyCombo } from '@ui/components/hotkey-combo';
import { cn } from '@ui/utils';
import { Loader2Icon, MicIcon, RefreshCcwIcon } from 'lucide-react';

export interface DictationControlProps {
  state: DictationState;
  disabled?: boolean;
  onToggle: () => void;
}

export function DictationControl({
  state,
  disabled = false,
  onToggle,
}: DictationControlProps) {
  const recording = state.status === 'recording';
  const busy =
    state.status === 'requesting-permission' || state.status === 'transcribing';
  const label = getDictationActionLabel(state);
  const statusText = getDictationStatusText(state);
  const partialTranscript = getDictationPartialTranscript(state);

  return (
    <div className="relative shrink-0">
      {partialTranscript && (
        <div
          className="pointer-events-none absolute right-0 bottom-10 z-20 min-w-40 max-w-72 rounded-xl border border-border bg-background/95 px-3 py-2 text-foreground text-xs shadow-lg backdrop-blur-md"
          aria-hidden="true"
        >
          <span className="line-clamp-3">{partialTranscript}</span>
        </div>
      )}
      <DictationFailureMessage
        state={state}
        className="absolute right-0 bottom-10 z-20 w-80 max-w-[min(20rem,calc(100vw-2rem))]"
      />
      <Tooltip>
        <TooltipTrigger>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={disabled}
            className={cn(
              'z-10 size-8 shrink-0 cursor-pointer rounded-full p-1 disabled:opacity-50',
              recording &&
                'bg-error-solid/10 text-error-foreground ring-1 ring-error-solid/25 hover:bg-error-solid/15',
              state.status === 'failed' &&
                'text-error-foreground ring-1 ring-error-solid/20',
            )}
            aria-label={label}
            aria-pressed={recording}
            aria-busy={busy}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggle();
            }}
          >
            <DictationStatusIcon state={state} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <span className="flex max-w-72 flex-col gap-1">
            <span className="flex items-center gap-1.5">
              <span>{label}</span>
              <HotkeyCombo action={HotkeyActions.TOGGLE_DICTATION} size="xs" />
            </span>
            {state.status === 'failed' && (
              <span className="text-error-foreground text-xs">
                {state.error}
              </span>
            )}
          </span>
        </TooltipContent>
      </Tooltip>
      <span className="sr-only" role="status" aria-live="polite">
        {statusText}
      </span>
    </div>
  );
}

export function DictationFailureMessage({
  state,
  className,
}: {
  state: DictationState;
  className?: string;
}) {
  if (state.status !== 'failed') return null;

  return (
    <div
      className={cn(
        'pointer-events-none rounded-xl border border-error-solid/35 bg-background/96 px-3 py-2.5 text-xs shadow-lg backdrop-blur-md',
        className,
      )}
      role="alert"
      aria-live="assertive"
    >
      <span className="block font-medium text-error-foreground">
        Dictation unavailable
      </span>
      <span className="mt-1 block text-muted-foreground leading-5">
        {state.error}
      </span>
    </div>
  );
}

export function DictationStatusIcon({ state }: { state: DictationState }) {
  if (
    state.status === 'requesting-permission' ||
    state.status === 'transcribing'
  ) {
    return <Loader2Icon className="size-4 animate-spin" />;
  }

  if (state.status === 'recording') {
    return (
      <span className="relative flex size-4 items-center justify-center">
        <span className="absolute size-3 rounded-full bg-error-solid/45 motion-safe:animate-ping" />
        <span className="relative size-2.5 rounded-full bg-error-solid" />
      </span>
    );
  }

  if (state.status === 'failed' && state.retryable) {
    return <RefreshCcwIcon className="size-4" />;
  }

  return <MicIcon className="size-4" />;
}

export function getDictationActionLabel(state: DictationState): string {
  switch (state.status) {
    case 'idle':
    case 'completed':
      return 'Start dictation';
    case 'requesting-permission':
      return 'Cancel microphone request';
    case 'recording':
      return 'Stop and transcribe';
    case 'transcribing':
      return 'Cancel transcription';
    case 'failed':
      return state.retryable ? 'Retry transcription' : 'Record again';
  }
}

export function getDictationStatusText(state: DictationState): string {
  switch (state.status) {
    case 'idle':
      return 'Dictation ready';
    case 'requesting-permission':
      return 'Requesting microphone access';
    case 'recording':
      return state.transport === 'realtime' && state.partialTranscript
        ? 'Realtime dictation preview updated'
        : 'Dictation recording';
    case 'transcribing':
      return 'Transcribing dictation';
    case 'completed':
      return 'Dictation inserted into the message';
    case 'failed':
      return `Dictation failed: ${state.error}`;
  }
}

export function getDictationPartialTranscript(
  state: DictationState,
): string | undefined {
  if (
    (state.status === 'recording' || state.status === 'transcribing') &&
    state.transport === 'realtime'
  ) {
    return state.partialTranscript;
  }
  return undefined;
}
