import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Button } from '@clodex/stage-ui/components/button';
import type { CodexMicroAction, CodexMicroPosition } from '@shared/agent-os';
import { shouldClaimClodexUiFocus } from '@shared/dictation-runtime';
import { resolveFeatureGate } from '@shared/feature-gates';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import { cn } from '@ui/utils';
import {
  AtSignIcon,
  ChevronDownIcon,
  CommandIcon,
  Gamepad2Icon,
  MicIcon,
  PlusIcon,
  SquareIcon,
  TerminalIcon,
  ZapIcon,
} from 'lucide-react';
import { useCommandCenter } from '../command-center/command-center-context';
import { requestChatInputPrefill } from '../agent-chat/chat/_lib/chat-input-events';
import { activateMountedFlag } from './codex-micro-lifecycle';

const COMPACT_SIZE = { width: 56, height: 48 };
const EXPANDED_SIZE = { width: 264, height: 252 };
const VIEWPORT_MARGIN = 18;

type DragState = {
  pointerId: number;
  pointerStart: CodexMicroPosition;
  positionStart: CodexMicroPosition;
  moved: boolean;
};

function getSize(expanded: boolean) {
  return expanded ? EXPANDED_SIZE : COMPACT_SIZE;
}

function clampPosition(
  position: CodexMicroPosition,
  expanded: boolean,
): CodexMicroPosition {
  const size = getSize(expanded);
  return {
    x: Math.min(
      Math.max(VIEWPORT_MARGIN, position.x),
      Math.max(
        VIEWPORT_MARGIN,
        window.innerWidth - size.width - VIEWPORT_MARGIN,
      ),
    ),
    y: Math.min(
      Math.max(VIEWPORT_MARGIN, position.y),
      Math.max(
        VIEWPORT_MARGIN,
        window.innerHeight - size.height - VIEWPORT_MARGIN,
      ),
    ),
  };
}

function getDefaultPosition(expanded: boolean): CodexMicroPosition {
  const size = getSize(expanded);
  return {
    x: Math.max(
      VIEWPORT_MARGIN,
      window.innerWidth - size.width - VIEWPORT_MARGIN,
    ),
    y: Math.max(
      VIEWPORT_MARGIN,
      window.innerHeight - size.height - VIEWPORT_MARGIN,
    ),
  };
}

function payloadString(action: CodexMicroAction, key: string): string | null {
  const value = action.payload[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function ActionIcon({ action }: { action: CodexMicroAction }) {
  if (action.kind === 'push-to-talk') return <MicIcon className="size-4" />;
  if (action.kind === 'insert-skill-mention') {
    return <AtSignIcon className="size-4" />;
  }
  if (action.kind === 'run-command') return <TerminalIcon className="size-4" />;
  if (action.kind === 'open-command-palette') {
    return <CommandIcon className="size-4" />;
  }
  if (action.kind === 'insert-text') return <ZapIcon className="size-4" />;

  const customAction = payloadString(action, 'action');
  if (customAction === 'new-agent') return <PlusIcon className="size-4" />;
  if (customAction === 'stop-agent') return <SquareIcon className="size-4" />;
  return <ZapIcon className="size-4" />;
}

export function CodexMicroOverlay({ onInteract }: { onInteract?: () => void }) {
  const micro = useKartonState((state) => state.agentOs.micro);
  const dictationEnabled = useKartonState(
    (state) =>
      resolveFeatureGate(
        'global-dictation',
        state.preferences.featureGates.overrides,
        state.appInfo.releaseChannel,
      ).enabled,
  );
  const availableSkills = useKartonState((state) => state.skills);
  const installedSkills = useKartonState(
    (state) => state.agentOs.installedSkills,
  );
  const [openAgent, setOpenAgent] = useOpenAgent();
  const commandCenter = useCommandCenter();
  const triggerAction = useKartonProcedure(
    (procedures) => procedures.agentOs.micro.triggerAction,
  );
  const setPosition = useKartonProcedure(
    (procedures) => procedures.agentOs.micro.setPosition,
  );
  const setExpanded = useKartonProcedure(
    (procedures) => procedures.agentOs.micro.setExpanded,
  );
  const createAgent = useKartonProcedure(
    (procedures) => procedures.agents.create,
  );
  const stopAgent = useKartonProcedure((procedures) => procedures.agents.stop);
  const setLastOpenAgentId = useKartonProcedure(
    (procedures) => procedures.browser.setLastOpenAgentId,
  );
  const openAgentState = useKartonState((state) =>
    openAgent ? state.agents.instances[openAgent]?.state : undefined,
  );
  const currentMountPaths = useKartonState((state) =>
    openAgent
      ? (state.toolbox[openAgent]?.workspace?.mounts ?? []).map(
          (mount) => mount.path,
        )
      : [],
  );

  const [position, setLocalPosition] = useState<CodexMicroPosition>({
    x: 0,
    y: 0,
  });
  const [ready, setReady] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const positionRef = useRef(position);
  const expandedRef = useRef(micro.expanded);
  const mountedRef = useRef(true);

  positionRef.current = position;
  expandedRef.current = micro.expanded;

  const applyPosition = useCallback((nextPosition: CodexMicroPosition) => {
    positionRef.current = nextPosition;
    setLocalPosition(nextPosition);
  }, []);

  useEffect(() => activateMountedFlag(mountedRef), []);

  useLayoutEffect(() => {
    const nextPosition = clampPosition(
      micro.position ?? getDefaultPosition(micro.expanded),
      micro.expanded,
    );
    applyPosition(nextPosition);
    setReady(true);
  }, [applyPosition, micro.expanded, micro.position]);

  useEffect(() => {
    const handleResize = () => {
      const nextPosition = clampPosition(
        positionRef.current,
        expandedRef.current,
      );
      applyPosition(nextPosition);
      void setPosition({
        x: Math.round(nextPosition.x),
        y: Math.round(nextPosition.y),
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [applyPosition, setPosition]);

  const toggleExpanded = useCallback(() => {
    const nextExpanded = !micro.expanded;
    const nextPosition = clampPosition(positionRef.current, nextExpanded);
    applyPosition(nextPosition);
    void Promise.all([
      setExpanded(nextExpanded),
      setPosition({
        x: Math.round(nextPosition.x),
        y: Math.round(nextPosition.y),
      }),
    ]);
  }, [applyPosition, micro.expanded, setExpanded, setPosition]);

  const createNewAgent = useCallback(async () => {
    const id = await createAgent(
      undefined,
      openAgentState?.activeModelId,
      openAgentState?.toolApprovalMode,
      currentMountPaths.length > 0 ? currentMountPaths : undefined,
    );
    setOpenAgent(id);
    await setLastOpenAgentId(id);
  }, [
    createAgent,
    currentMountPaths,
    openAgentState?.activeModelId,
    openAgentState?.toolApprovalMode,
    setLastOpenAgentId,
    setOpenAgent,
  ]);

  const executeAction = useCallback(
    async (actionId: string) => {
      if (busyActionId !== null) return;
      if (shouldClaimClodexUiFocus('micro-pointer', false)) onInteract?.();
      setBusyActionId(actionId);
      try {
        const action = await triggerAction(actionId);
        if (action.kind === 'insert-text') {
          requestChatInputPrefill(payloadString(action, 'text') ?? '');
          return;
        }
        if (action.kind === 'insert-skill-mention') {
          const configuredSkill =
            payloadString(action, 'skillName') ??
            payloadString(action, 'skillId');
          const fallbackSkill =
            installedSkills[0]?.name ??
            availableSkills.find((skill) => skill.userInvocable !== false)?.id;
          const skill = configuredSkill ?? fallbackSkill;
          requestChatInputPrefill(skill ? `@${skill} ` : '@skill ');
          return;
        }
        if (action.kind === 'run-command') {
          requestChatInputPrefill(
            payloadString(action, 'command') ??
              payloadString(action, 'text') ??
              '',
          );
          return;
        }
        if (action.kind === 'open-command-palette') {
          commandCenter.open({ restoreFocusOnClose: true });
          return;
        }
        if (action.kind !== 'custom') return;

        const customAction = payloadString(action, 'action');
        if (customAction === 'new-agent') {
          await createNewAgent();
        } else if (customAction === 'stop-agent' && openAgent) {
          await stopAgent(openAgent);
        }
      } catch (error) {
        console.error('Failed to execute Micro action', error);
      } finally {
        if (mountedRef.current) setBusyActionId(null);
      }
    },
    [
      availableSkills,
      busyActionId,
      commandCenter,
      createNewAgent,
      installedSkills,
      onInteract,
      openAgent,
      stopAgent,
      triggerAction,
    ],
  );

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    if (event.button !== 0 || dragRef.current !== null) return;
    if (shouldClaimClodexUiFocus('micro-pointer', false)) onInteract?.();
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
      clampPosition(
        {
          x: drag.positionStart.x + deltaX,
          y: drag.positionStart.y + deltaY,
        },
        micro.expanded,
      ),
    );
  };

  const finishDrag = (
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
      toggleExpanded();
      return;
    }
    const nextPosition = clampPosition(positionRef.current, micro.expanded);
    applyPosition(nextPosition);
    void setPosition({
      x: Math.round(nextPosition.x),
      y: Math.round(nextPosition.y),
    });
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-[42]">
      <div
        className={cn(
          'app-no-drag pointer-events-auto absolute overflow-hidden border border-white/35 bg-background/75 shadow-codex-2xl backdrop-blur-xl transition-[width,height,opacity,border-radius] duration-150 dark:border-white/15 dark:bg-background/65',
          micro.expanded ? 'rounded-2xl' : 'rounded-full',
        )}
        style={{
          width: getSize(micro.expanded).width,
          height: getSize(micro.expanded).height,
          opacity: ready ? 1 : 0,
          transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
          willChange: 'transform',
        }}
      >
        <button
          type="button"
          aria-label={
            micro.expanded
              ? 'Drag Micro controller or collapse it'
              : 'Drag or expand Micro controller'
          }
          className={cn(
            'flex h-12 w-full touch-none select-none items-center outline-none',
            'cursor-grab focus-visible:ring-2 focus-visible:ring-primary-solid focus-visible:ring-inset active:cursor-grabbing',
            micro.expanded ? 'justify-between px-3' : 'justify-center',
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(event) => finishDrag(event, false)}
          onPointerCancel={(event) => finishDrag(event, true)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            if (shouldClaimClodexUiFocus('micro-keyboard', false)) {
              onInteract?.();
            }
            toggleExpanded();
          }}
        >
          <span className="flex items-center gap-2">
            <span className="relative">
              <Gamepad2Icon className="size-5 text-primary-solid" />
              {micro.pushToTalkActive && (
                <span className="absolute -top-1 -right-1 size-2 rounded-full bg-error-solid motion-safe:animate-pulse" />
              )}
            </span>
            {micro.expanded && (
              <span className="font-medium text-foreground text-sm">
                Micro controller
              </span>
            )}
          </span>
          {micro.expanded && <ChevronDownIcon className="size-4" />}
        </button>

        {micro.expanded && (
          <div className="grid grid-cols-2 gap-2 px-3 pb-3">
            {micro.actions.slice(0, 6).map((action) => {
              const active =
                action.kind === 'push-to-talk' && micro.pushToTalkActive;
              const dictationUnavailable =
                action.kind === 'push-to-talk' && !dictationEnabled;
              return (
                <Button
                  key={action.id}
                  variant={active ? 'primary' : 'secondary'}
                  size="sm"
                  className="h-14 min-w-0 justify-start gap-2 px-2.5"
                  disabled={busyActionId !== null || dictationUnavailable}
                  onClick={() => void executeAction(action.id)}
                  title={
                    dictationUnavailable
                      ? 'Enable the Global dictation preview feature first'
                      : action.title
                  }
                >
                  <span className="shrink-0">
                    <ActionIcon action={action} />
                  </span>
                  <span className="truncate text-xs">{action.title}</span>
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
