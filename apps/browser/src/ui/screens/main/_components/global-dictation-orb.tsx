import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  clampDictationOrbPosition,
  DICTATION_ORB_SIZE,
  getDefaultDictationOrbPosition,
  parseDictationOrbPosition,
  type DictationOrbPosition,
} from '@shared/dictation-orb';
import type { DictationState } from '@shared/dictation';
import { shouldClaimClodexUiFocus } from '@shared/dictation-runtime';
import { HotkeyActions } from '@shared/hotkeys';
import { HotkeyCombo } from '@ui/components/hotkey-combo';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@clodex/stage-ui/components/tooltip';
import { cn } from '@ui/utils';
import {
  DictationStatusIcon,
  getDictationActionLabel,
  getDictationPartialTranscript,
  getDictationStatusText,
} from '../agent-chat/chat/_components/dictation-control';

const POSITION_STORAGE_KEY = 'clodex-global-dictation-orb-position-v1'; // gitleaks:allow
const KEYBOARD_NUDGE_PX = 12;

interface DragState {
  pointerId: number;
  pointerStart: DictationOrbPosition;
  positionStart: DictationOrbPosition;
  moved: boolean;
}

export interface GlobalDictationOrbProps {
  state: DictationState;
  disabled?: boolean;
  onToggle: () => void;
  onInteract?: () => void;
}

function getViewport() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function persistPosition(position: DictationOrbPosition): void {
  try {
    localStorage.setItem(
      POSITION_STORAGE_KEY,
      JSON.stringify({
        x: Math.round(position.x),
        y: Math.round(position.y),
      }),
    );
  } catch {
    // Position persistence is a best-effort renderer preference.
  }
}

export function GlobalDictationOrb({
  state,
  disabled = false,
  onToggle,
  onInteract,
}: GlobalDictationOrbProps) {
  const [position, setPosition] = useState<DictationOrbPosition>({
    x: 0,
    y: 0,
  });
  const [ready, setReady] = useState(false);
  const positionRef = useRef(position);
  const dragRef = useRef<DragState | null>(null);
  const recording = state.status === 'recording';
  const busy =
    state.status === 'requesting-permission' || state.status === 'transcribing';
  const label = getDictationActionLabel(state);
  const partialTranscript = getDictationPartialTranscript(state);

  const applyPosition = useCallback((nextPosition: DictationOrbPosition) => {
    positionRef.current = nextPosition;
    setPosition(nextPosition);
  }, []);

  useLayoutEffect(() => {
    let persisted: DictationOrbPosition | null = null;
    try {
      persisted = parseDictationOrbPosition(
        localStorage.getItem(POSITION_STORAGE_KEY),
      );
    } catch {
      // Fall back to the default position when storage is unavailable.
    }
    applyPosition(
      persisted
        ? clampDictationOrbPosition(persisted, getViewport())
        : getDefaultDictationOrbPosition(getViewport()),
    );
    setReady(true);
  }, [applyPosition]);

  useEffect(() => {
    const handleResize = () => {
      const nextPosition = clampDictationOrbPosition(
        positionRef.current,
        getViewport(),
      );
      applyPosition(nextPosition);
      persistPosition(nextPosition);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [applyPosition]);

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    if (disabled || event.button !== 0 || dragRef.current !== null) return;
    if (shouldClaimClodexUiFocus('orb-pointer', disabled)) onInteract?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      pointerStart: { x: event.clientX, y: event.clientY },
      positionStart: positionRef.current,
      moved: false,
    };
  };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.pointerStart.x;
    const deltaY = event.clientY - drag.pointerStart.y;
    if (Math.hypot(deltaX, deltaY) > 3) drag.moved = true;
    applyPosition(
      clampDictationOrbPosition(
        {
          x: drag.positionStart.x + deltaX,
          y: drag.positionStart.y + deltaY,
        },
        getViewport(),
      ),
    );
  };

  const finishPointerInteraction = (
    event: ReactPointerEvent<HTMLButtonElement>,
    cancelled: boolean,
  ): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;

    if (cancelled) {
      applyPosition(drag.positionStart);
      return;
    }
    if (!drag.moved) {
      onToggle();
      return;
    }

    const nextPosition = clampDictationOrbPosition(
      positionRef.current,
      getViewport(),
    );
    applyPosition(nextPosition);
    persistPosition(nextPosition);
  };

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (disabled) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (shouldClaimClodexUiFocus('orb-keyboard', disabled)) onInteract?.();
      onToggle();
      return;
    }

    const delta =
      event.key === 'ArrowLeft'
        ? { x: -KEYBOARD_NUDGE_PX, y: 0 }
        : event.key === 'ArrowRight'
          ? { x: KEYBOARD_NUDGE_PX, y: 0 }
          : event.key === 'ArrowUp'
            ? { x: 0, y: -KEYBOARD_NUDGE_PX }
            : event.key === 'ArrowDown'
              ? { x: 0, y: KEYBOARD_NUDGE_PX }
              : null;
    if (!delta) return;

    event.preventDefault();
    if (shouldClaimClodexUiFocus('orb-keyboard', disabled)) onInteract?.();
    const nextPosition = clampDictationOrbPosition(
      {
        x: positionRef.current.x + delta.x,
        y: positionRef.current.y + delta.y,
      },
      getViewport(),
    );
    applyPosition(nextPosition);
    persistPosition(nextPosition);
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-[43]">
      <div
        className="pointer-events-none absolute"
        style={{
          width: DICTATION_ORB_SIZE,
          height: DICTATION_ORB_SIZE,
          opacity: ready ? undefined : 0,
          transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
          willChange: 'transform',
        }}
      >
        {partialTranscript && (
          <div
            className="absolute top-1/2 right-[calc(100%+10px)] min-w-48 max-w-80 -translate-y-1/2 rounded-xl border border-border bg-background/92 px-3 py-2 text-foreground text-xs shadow-codex-xl backdrop-blur-xl"
            aria-hidden="true"
          >
            <span className="line-clamp-4">{partialTranscript}</span>
          </div>
        )}
        <Tooltip>
          <TooltipTrigger>
            <button
              type="button"
              disabled={disabled}
              aria-label={`${label}. Drag to move.`}
              aria-pressed={recording}
              aria-busy={busy}
              className={cn(
                'app-no-drag pointer-events-auto absolute inset-0 flex touch-none select-none items-center justify-center rounded-full',
                'border border-white/45 bg-background/78 text-foreground shadow-codex-2xl backdrop-blur-xl',
                'outline-none transition-[opacity,background-color,border-color,box-shadow,color] duration-150',
                'focus-visible:ring-2 focus-visible:ring-primary-solid disabled:cursor-not-allowed disabled:opacity-45',
                recording &&
                  'border-error-solid/55 bg-error-solid/12 text-error-foreground ring-4 ring-error-solid/10',
                state.status === 'failed' &&
                  'border-error-solid/45 text-error-foreground',
              )}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={(event) => finishPointerInteraction(event, false)}
              onPointerCancel={(event) => finishPointerInteraction(event, true)}
              onKeyDown={handleKeyDown}
            >
              <span className="scale-110">
                <DictationStatusIcon state={state} />
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">
            <span className="flex max-w-72 flex-col gap-1">
              <span className="flex items-center gap-1.5">
                <span>{label}</span>
                <HotkeyCombo
                  action={HotkeyActions.TOGGLE_DICTATION}
                  size="xs"
                />
              </span>
              <span className="text-muted-foreground text-xs">
                Drag the orb or use arrow keys to move it.
              </span>
              {state.status === 'failed' && (
                <span className="text-error-foreground text-xs">
                  {state.error}
                </span>
              )}
            </span>
          </TooltipContent>
        </Tooltip>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {getDictationStatusText(state)}
      </span>
    </div>
  );
}
