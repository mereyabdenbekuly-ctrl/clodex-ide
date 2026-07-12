import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { enablePatches, produceWithPatches } from 'immer';
import { AgentTypes } from '@shared/karton-contracts/ui/agent';
import {
  clampMascotOverlayPosition,
  deriveMascotAgentSignal,
  getDefaultMascotOverlayPosition,
  rubberBandMascotOverlayPosition,
  resolveMascotOverlayPosition,
  stepMascotOverlaySpring,
  type MascotAgentSignal,
  type MascotAgentSnapshot,
  type MascotAgentStatus,
  type MascotOverlayMotion,
  type MascotOverlayPosition,
} from '@shared/mascot-overlay';
import {
  useComparingSelector,
  useKartonProcedure,
  useKartonState,
} from '@ui/hooks/use-karton';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import { cn } from '@ui/utils';
import { AGENT_STATUS_COLOR_CLASSES } from '@ui/lib/agent-status-colors';

enablePatches();

const STATUS_PRESENTATION: Record<
  MascotAgentStatus,
  {
    label: string;
    dotClassName: string;
    glowClassName: string;
    faceClassName: string;
  }
> = {
  idle: {
    label: 'Idle',
    dotClassName: 'bg-muted-foreground',
    glowClassName: 'bg-muted-foreground/10',
    faceClassName: 'text-muted-foreground',
  },
  working: {
    label: 'Working',
    dotClassName: AGENT_STATUS_COLOR_CLASSES.info.dot,
    glowClassName: AGENT_STATUS_COLOR_CLASSES.info.glow,
    faceClassName: AGENT_STATUS_COLOR_CLASSES.info.solidText,
  },
  waiting: {
    label: 'Waiting for you',
    dotClassName: AGENT_STATUS_COLOR_CLASSES.warning.dot,
    glowClassName: AGENT_STATUS_COLOR_CLASSES.warning.glow,
    faceClassName: AGENT_STATUS_COLOR_CLASSES.warning.solidText,
  },
  success: {
    label: 'Finished',
    dotClassName: AGENT_STATUS_COLOR_CLASSES.success.dot,
    glowClassName: AGENT_STATUS_COLOR_CLASSES.success.glow,
    faceClassName: AGENT_STATUS_COLOR_CLASSES.success.solidText,
  },
  error: {
    label: 'Needs attention',
    dotClassName: AGENT_STATUS_COLOR_CLASSES.error.dot,
    glowClassName: AGENT_STATUS_COLOR_CLASSES.error.glow,
    faceClassName: AGENT_STATUS_COLOR_CLASSES.error.solidText,
  },
};

type DragState = {
  pointerId: number;
  pointerStart: MascotOverlayPosition;
  positionStart: MascotOverlayPosition;
  moved: boolean;
};

function getViewport() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function positionKey(position: MascotOverlayPosition | null): string {
  return position === null ? 'default' : `${position.x}:${position.y}`;
}

function mascotAgentSignalsEqual(
  first: MascotAgentSignal,
  second: MascotAgentSignal,
): boolean {
  return (
    first.status === second.status &&
    first.targetAgentId === second.targetAgentId
  );
}

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = () => setReducedMotion(mediaQuery.matches);

    handleChange();
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return reducedMotion;
}

function MascotFace({ status }: { status: MascotAgentStatus }) {
  const presentation = STATUS_PRESENTATION[status];

  return (
    <div
      className={cn(
        'absolute inset-[15%] rounded-[24%] border border-foreground/10 bg-background/55 shadow-codex-hairline backdrop-blur-md',
        'forced-colors:border-[CanvasText] forced-colors:bg-[Canvas]',
        presentation.faceClassName,
      )}
    >
      <div className="absolute inset-x-[18%] top-[27%] flex items-center justify-between">
        <span
          className={cn(
            'block aspect-square w-[19%] rounded-full bg-current shadow-[0_0_12px_currentColor]',
            status === 'working' && 'motion-safe:animate-pulse',
          )}
        />
        <span
          className={cn(
            'block aspect-square w-[19%] rounded-full bg-current shadow-[0_0_12px_currentColor]',
            status === 'working' && 'motion-safe:animate-pulse',
          )}
        />
      </div>

      {status === 'success' ? (
        <span className="absolute right-[31%] bottom-[22%] left-[31%] h-[15%] rounded-b-full border-current border-b-[3px]" />
      ) : status === 'error' ? (
        <span className="absolute right-[31%] bottom-[16%] left-[31%] h-[15%] rounded-t-full border-current border-t-[3px]" />
      ) : status === 'waiting' ? (
        <span className="absolute bottom-[19%] left-1/2 aspect-square w-[11%] -translate-x-1/2 rounded-full border-2 border-current" />
      ) : (
        <span className="absolute right-[35%] bottom-[22%] left-[35%] h-[3px] rounded-full bg-current" />
      )}
    </div>
  );
}

export function MascotOverlay({ onInteract }: { onInteract?: () => void }) {
  const preferences = useKartonState((state) => state.preferences);
  const signal = useKartonState(
    useComparingSelector((state): MascotAgentSignal => {
      const snapshots: MascotAgentSnapshot[] = [];

      for (const [id, agent] of Object.entries(state.agents.instances)) {
        if (agent.type !== AgentTypes.CHAT && agent.type !== AgentTypes.MAGUS) {
          continue;
        }

        snapshots.push({
          id,
          isWorking: agent.state.isWorking,
          isWaitingForUser:
            (state.toolbox[id]?.pendingUserQuestion !== null &&
              state.toolbox[id]?.pendingUserQuestion !== undefined) ||
            Object.keys(agent.state.pendingApprovals ?? {}).length > 0,
          hasError:
            agent.state.error !== undefined &&
            agent.state.error.kind !== 'plan-limit-exceeded',
          hasUnseen: agent.state.unread === true,
        });
      }

      return deriveMascotAgentSignal(snapshots);
    }, mascotAgentSignalsEqual),
  );
  const updatePreferences = useKartonProcedure(
    (procedures) => procedures.preferences.update,
  );
  const [, setOpenAgent] = useOpenAgent();
  const reducedMotion = usePrefersReducedMotion();
  const size = preferences.mascotOverlay.size;
  const persistedPosition = preferences.mascotOverlay.position;
  const presentation = STATUS_PRESENTATION[signal.status];

  const [position, setPosition] = useState<MascotOverlayPosition>({
    x: 0,
    y: 0,
  });
  const [ready, setReady] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const positionRef = useRef(position);
  const preferencesRef = useRef(preferences);
  const persistedPositionRef = useRef(persistedPosition);
  const reducedMotionRef = useRef(reducedMotion);
  const initializedRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const ownPersistedPositionKeyRef = useRef<string | null>(null);

  preferencesRef.current = preferences;
  persistedPositionRef.current = persistedPosition;
  reducedMotionRef.current = reducedMotion;

  const applyPosition = useCallback((nextPosition: MascotOverlayPosition) => {
    positionRef.current = nextPosition;
    setPosition(nextPosition);
  }, []);

  const cancelAnimation = useCallback(() => {
    if (animationFrameRef.current === null) return;
    window.cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
  }, []);

  const animateTo = useCallback(
    (target: MascotOverlayPosition) => {
      cancelAnimation();

      if (reducedMotionRef.current) {
        applyPosition(target);
        return;
      }

      let motion: MascotOverlayMotion = {
        position: positionRef.current,
        velocity: { x: 0, y: 0 },
      };
      let previousTimestamp = performance.now();

      const animateFrame = (timestamp: number) => {
        const step = stepMascotOverlaySpring(
          motion,
          target,
          timestamp - previousTimestamp,
        );
        previousTimestamp = timestamp;
        motion = step;
        applyPosition(step.position);

        if (step.settled) {
          animationFrameRef.current = null;
          return;
        }

        animationFrameRef.current = window.requestAnimationFrame(animateFrame);
      };

      animationFrameRef.current = window.requestAnimationFrame(animateFrame);
    },
    [applyPosition, cancelAnimation],
  );

  const persistPosition = useCallback(
    async (nextPosition: MascotOverlayPosition) => {
      const roundedPosition = {
        x: Math.round(nextPosition.x),
        y: Math.round(nextPosition.y),
      };
      const currentPosition = preferencesRef.current.mascotOverlay.position;

      if (
        currentPosition?.x === roundedPosition.x &&
        currentPosition.y === roundedPosition.y
      ) {
        return;
      }

      const nextPositionKey = positionKey(roundedPosition);
      ownPersistedPositionKeyRef.current = nextPositionKey;
      const [, patches] = produceWithPatches(
        preferencesRef.current,
        (draft) => {
          draft.mascotOverlay.position = roundedPosition;
        },
      );

      try {
        await updatePreferences(patches);
      } catch (error) {
        if (ownPersistedPositionKeyRef.current === nextPositionKey) {
          ownPersistedPositionKeyRef.current = null;
        }
        console.error('Failed to save mascot position', error);
      }
    },
    [updatePreferences],
  );

  const persistDefaultPosition = useCallback(async () => {
    if (preferencesRef.current.mascotOverlay.position === null) return;

    ownPersistedPositionKeyRef.current = positionKey(null);
    const [, patches] = produceWithPatches(preferencesRef.current, (draft) => {
      draft.mascotOverlay.position = null;
    });

    try {
      await updatePreferences(patches);
    } catch (error) {
      if (ownPersistedPositionKeyRef.current === positionKey(null)) {
        ownPersistedPositionKeyRef.current = null;
      }
      console.error('Failed to reset mascot position', error);
    }
  }, [updatePreferences]);

  const persistedPositionKey = positionKey(persistedPosition);

  useLayoutEffect(() => {
    const nextPosition = resolveMascotOverlayPosition(
      persistedPosition,
      getViewport(),
      size,
    );

    if (!initializedRef.current) {
      initializedRef.current = true;
      applyPosition(nextPosition);
      setReady(true);
      return;
    }

    if (ownPersistedPositionKeyRef.current === persistedPositionKey) {
      ownPersistedPositionKeyRef.current = null;
      return;
    }

    if (dragRef.current === null) {
      animateTo(nextPosition);
    }
  }, [animateTo, applyPosition, persistedPosition, persistedPositionKey, size]);

  useEffect(() => {
    const handleResize = () => {
      if (dragRef.current !== null) return;

      const nextPosition =
        persistedPositionRef.current === null
          ? getDefaultMascotOverlayPosition(getViewport(), size)
          : clampMascotOverlayPosition(
              positionRef.current,
              getViewport(),
              size,
            );
      animateTo(nextPosition);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [animateTo, size]);

  useEffect(() => cancelAnimation, [cancelAnimation]);

  const finishDrag = useCallback(
    (cancelled: boolean) => {
      const drag = dragRef.current;
      if (drag === null) return;

      dragRef.current = null;
      setIsDragging(false);

      if (cancelled) {
        animateTo(
          clampMascotOverlayPosition(drag.positionStart, getViewport(), size),
        );
        return;
      }

      if (!drag.moved) {
        animateTo(
          clampMascotOverlayPosition(drag.positionStart, getViewport(), size),
        );
        if (signal.targetAgentId !== null) {
          setOpenAgent(signal.targetAgentId);
        }
        return;
      }

      const clampedPosition = clampMascotOverlayPosition(
        positionRef.current,
        getViewport(),
        size,
      );
      animateTo(clampedPosition);
      void persistPosition(clampedPosition);
    },
    [animateTo, persistPosition, setOpenAgent, signal.targetAgentId, size],
  );

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    if (event.button !== 0 || dragRef.current !== null) return;

    onInteract?.();
    cancelAnimation();
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      pointerStart: { x: event.clientX, y: event.clientY },
      positionStart: positionRef.current,
      moved: false,
    };
    setIsDragging(true);
  };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - drag.pointerStart.x;
    const deltaY = event.clientY - drag.pointerStart.y;
    if (Math.hypot(deltaX, deltaY) > 3) {
      drag.moved = true;
    }

    applyPosition(
      rubberBandMascotOverlayPosition(
        {
          x: drag.positionStart.x + deltaX,
          y: drag.positionStart.y + deltaY,
        },
        getViewport(),
        size,
      ),
    );
  };

  const handlePointerUp = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishDrag(false);
  };

  const handlePointerCancel = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    finishDrag(true);
  };

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      if (signal.targetAgentId === null) return;
      event.preventDefault();
      onInteract?.();
      setOpenAgent(signal.targetAgentId);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      onInteract?.();
      const defaultPosition = getDefaultMascotOverlayPosition(
        getViewport(),
        size,
      );
      animateTo(defaultPosition);
      void persistDefaultPosition();
      return;
    }

    const keyboardOffset =
      event.key === 'ArrowLeft'
        ? { x: -1, y: 0 }
        : event.key === 'ArrowRight'
          ? { x: 1, y: 0 }
          : event.key === 'ArrowUp'
            ? { x: 0, y: -1 }
            : event.key === 'ArrowDown'
              ? { x: 0, y: 1 }
              : null;

    if (keyboardOffset === null) return;

    event.preventDefault();
    onInteract?.();
    const distance = event.shiftKey ? 24 : 8;
    const nextPosition = clampMascotOverlayPosition(
      {
        x: positionRef.current.x + keyboardOffset.x * distance,
        y: positionRef.current.y + keyboardOffset.y * distance,
      },
      getViewport(),
      size,
    );
    animateTo(nextPosition);
    void persistPosition(nextPosition);
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-[35]">
      <span className="sr-only" aria-live="polite">
        Clodex mascot status: {presentation.label}
      </span>

      <button
        type="button"
        aria-roledescription="draggable mascot"
        data-status={signal.status}
        aria-label={`Clodex mascot. ${presentation.label}. Drag to move, use arrow keys to nudge, or press Home to reset its position.${
          signal.targetAgentId === null
            ? ''
            : ' Click or press Enter to open the relevant agent.'
        }`}
        title={`${presentation.label} — drag to move`}
        className={cn(
          'app-no-drag pointer-events-auto absolute touch-none select-none outline-none transition-[opacity] duration-150',
          'cursor-grab focus-visible:ring-2 focus-visible:ring-primary-solid focus-visible:ring-offset-2 focus-visible:ring-offset-background active:cursor-grabbing',
        )}
        style={{
          width: size,
          height: size,
          opacity: ready ? 1 : 0,
          transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
          willChange: 'transform',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onKeyDown={handleKeyDown}
      >
        <div
          className={cn(
            'absolute -inset-[9%] rounded-full blur-2xl transition-colors duration-300',
            presentation.glowClassName,
          )}
        />

        <div
          className={cn(
            'relative size-full overflow-hidden rounded-[30%] border border-white/35 bg-background/72 shadow-codex-2xl backdrop-blur-xl transition-transform duration-150',
            'dark:border-white/15 dark:bg-background/62',
            'forced-colors:border-[CanvasText] forced-colors:bg-[Canvas] forced-colors:shadow-none',
            isDragging && 'scale-[1.035]',
          )}
        >
          <div className="absolute inset-x-[12%] top-[7%] h-[18%] rounded-full bg-gradient-to-b from-white/45 to-transparent blur-md dark:from-white/15" />
          <div className="absolute top-[7%] left-1/2 h-[12%] w-[3px] -translate-x-1/2 rounded-full bg-foreground/35">
            <span
              className={cn(
                'absolute -top-[32%] left-1/2 aspect-square w-[320%] -translate-x-1/2 rounded-full',
                presentation.dotClassName,
                signal.status === 'working' && 'motion-safe:animate-pulse',
              )}
            />
          </div>

          {signal.status === 'working' && (
            <div className="absolute inset-[7%] rounded-[28%] border border-primary-solid/25 border-t-primary-solid/80 motion-safe:animate-spin" />
          )}

          <MascotFace status={signal.status} />

          <div className="absolute right-[13%] bottom-[8%] left-[13%] h-[7%] rounded-full bg-foreground/8 shadow-inner forced-colors:bg-[CanvasText]" />
        </div>

        <span
          className={cn(
            'absolute top-[3%] right-[3%] block aspect-square w-[16%] rounded-full border-2 border-background shadow-codex-md',
            'forced-colors:border-[Canvas] forced-colors:bg-[Highlight]',
            presentation.dotClassName,
          )}
        >
          {signal.status !== 'idle' && (
            <span
              className={cn(
                'absolute inset-0 rounded-full motion-safe:animate-ping',
                presentation.dotClassName,
              )}
            />
          )}
        </span>
      </button>
    </div>
  );
}
