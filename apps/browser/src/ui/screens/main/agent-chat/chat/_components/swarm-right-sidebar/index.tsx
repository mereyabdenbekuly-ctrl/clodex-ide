import { memo, useCallback, useMemo, useState } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@clodex/stage-ui/components/tooltip';
import { cn } from '@ui/utils';
import {
  useComparingSelector,
  useKartonProcedure,
  useKartonState,
} from '@ui/hooks/use-karton';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import { useTrack } from '@ui/hooks/use-track';
import { Button } from '@clodex/stage-ui/components/button';
import {
  IconChevronDownOutline18,
  IconCodeBranchOutline18,
  IconXmarkOutline18,
} from 'nucleo-ui-outline-18';
import { OverlayScrollbar } from '@clodex/stage-ui/components/overlay-scrollbar';
import type {
  SwarmRunState,
  SwarmTaskState,
} from '@shared/karton-contracts/ui';

// ============================================================================
// Shared visuals (relocated from footer-status-card/swarm-section.tsx)
// ============================================================================
//
// These were originally internal to the StatusCard section factory. We
// keep the same look-and-feel — colors, spacing, indicator pulse — and
// just promote them to first-class React components so the right sidebar
// can render them directly. The legacy `buildSwarmSections` factory in
// footer-status-card/swarm-section.tsx re-exports from this module to
// keep storybook tests and any other consumer working unchanged.

function SwarmStatusIndicator({
  status,
}: {
  status: SwarmTaskState['status'];
}) {
  switch (status) {
    case 'running':
      return (
        <div className="size-2.5 shrink-0 animate-pulse rounded-[2px] bg-clodex-green-brand shadow-[0_0_8px_rgba(0,238,120,0.8)]" />
      );
    case 'completed':
      return <div className="size-2.5 shrink-0 rounded-[2px] bg-zinc-500" />;
    case 'failed':
      return <div className="size-2.5 shrink-0 rounded-[2px] bg-red-500" />;
    case 'pending':
      return (
        <div className="size-2.5 shrink-0 rounded-[2px] border border-zinc-600 bg-transparent" />
      );
  }
}

function getModelLabel(modelId: string | undefined): string | null {
  if (!modelId) return null;
  if (modelId === 'gpt-5.5') return 'GPT-5.5';
  if (modelId === 'claude-opus-4.8') return 'Opus 4.8';
  if (modelId === 'gemini-3.5-flash') return 'Gemini 3.5';
  if (modelId === 'gemini-3.1-pro-preview') return 'Gemini 3.1';
  return modelId;
}

function TaskRow({ task }: { task: SwarmTaskState }) {
  const preferredModelLabel = getModelLabel(task.preferredModelId);
  const resolvedModelLabel = getModelLabel(task.resolvedModelId);
  const didFallback =
    task.preferredModelId &&
    task.resolvedModelId &&
    task.preferredModelId !== task.resolvedModelId;
  const modelLabel = didFallback
    ? `${preferredModelLabel ?? task.preferredModelId} -> ${resolvedModelLabel ?? task.resolvedModelId}`
    : (resolvedModelLabel ?? preferredModelLabel);
  return (
    <div
      className={cn(
        'mx-1 flex w-[calc(100%-0.5rem)] flex-row items-start gap-1.5 rounded px-1 py-0.5 text-xs transition-colors',
        task.status === 'running' && 'bg-clodex-green-brand/10',
        task.status === 'failed' && 'bg-red-500/10',
      )}
    >
      <div className="flex size-5 shrink-0 items-center justify-center">
        <SwarmStatusIndicator status={task.status} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 flex-row items-center gap-1.5">
          <span
            className={cn(
              'min-w-0 truncate leading-5 transition-colors',
              task.status === 'running' && 'text-clodex-green-200',
              task.status === 'completed'
                ? 'text-subtle-foreground'
                : 'text-foreground',
            )}
          >
            {task.name}
          </span>
          <span className="shrink-0 rounded border border-border/40 px-1 text-[10px] text-muted-foreground leading-4">
            {task.modelTaskRole}
          </span>
          {modelLabel && (
            <span
              className={cn(
                'shrink-0 rounded border border-border/40 px-1 text-[10px] text-muted-foreground leading-4',
                task.status === 'running' &&
                  'border-clodex-green-300/30 bg-clodex-green-brand/10 text-clodex-green-200',
                didFallback &&
                  'border-amber-400/40 bg-amber-500/10 text-amber-200',
              )}
              title={
                didFallback
                  ? `Requested ${preferredModelLabel ?? task.preferredModelId}, resolved ${resolvedModelLabel ?? task.resolvedModelId}`
                  : undefined
              }
            >
              {modelLabel}
            </span>
          )}
        </div>
        {task.error && (
          <div
            className="whitespace-pre-wrap break-words text-destructive text-xs leading-4"
            title={task.error}
          >
            {task.error}
          </div>
        )}
        {task.output && (
          <div className="line-clamp-2 text-subtle-foreground text-xs">
            {task.output}
          </div>
        )}
        {task.logs.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5">
            {task.logs.slice(-4).map((entry) => (
              <div
                key={`${entry.timestamp}:${entry.message}`}
                className={cn(
                  'line-clamp-2 break-words text-[10px] leading-3.5',
                  entry.level === 'info' && 'text-subtle-foreground',
                  entry.level === 'warn' && 'text-amber-200',
                  entry.level === 'error' && 'text-destructive',
                )}
                title={entry.message}
              >
                {entry.message}
              </div>
            ))}
          </div>
        )}
      </div>
      {(task.metrics.tokens > 0 || task.metrics.toolsUsed > 0) && (
        <div
          className={cn(
            'shrink-0 pt-0.5 text-[10px] text-subtle-foreground',
            task.status === 'running' && 'text-clodex-green-200',
          )}
        >
          {task.metrics.tokens > 0 && `${task.metrics.tokens} tok`}
          {task.metrics.tokens > 0 && task.metrics.toolsUsed > 0 && ' · '}
          {task.metrics.toolsUsed > 0 && `${task.metrics.toolsUsed} tools`}
        </div>
      )}
    </div>
  );
}

function getPhaseProgress(phase: SwarmRunState['phases'][number]): {
  completed: number;
  total: number;
  percent: number;
} {
  const total = phase.tasks.length;
  const completed = phase.tasks.filter(
    (task) => task.status === 'completed',
  ).length;
  return {
    completed,
    total,
    percent: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
}

function getRunProgress(run: SwarmRunState): {
  completed: number;
  total: number;
} {
  const tasks = run.phases.flatMap((phase) => phase.tasks);
  return {
    completed: tasks.filter((task) => task.status === 'completed').length,
    total: tasks.length,
  };
}

function getRunRenderFingerprint(run: SwarmRunState): string {
  return [
    run.id,
    run.status,
    run.completedAt ?? '',
    run.error ?? '',
    ...run.phases.flatMap((phase) => [
      phase.id,
      phase.status,
      ...phase.tasks.flatMap((task) => [
        task.id,
        task.status,
        task.preferredModelId ?? '',
        task.resolvedModelId ?? '',
        task.metrics.tokens,
        task.metrics.toolsUsed,
        task.output ?? '',
        task.error ?? '',
        ...task.logs.flatMap((entry) => [
          entry.level,
          entry.message,
          entry.timestamp,
        ]),
      ]),
    ]),
  ].join('|');
}

function SwarmRunContent({ run }: { run: SwarmRunState }) {
  const initialExpandedPhases = useMemo(() => {
    const entries = run.phases.map((phase, index) => [
      phase.id,
      phase.status === 'running' || index === 0,
    ]);
    return Object.fromEntries(entries) as Record<string, boolean>;
  }, [run.id, run.phases]);
  const [expandedPhases, setExpandedPhases] = useState<Record<string, boolean>>(
    initialExpandedPhases,
  );

  const togglePhase = (phaseId: string) => {
    setExpandedPhases((prev) => ({
      ...prev,
      [phaseId]: !(prev[phaseId] ?? false),
    }));
  };

  return (
    <div className="pt-1">
      {run.phases.map((phase) => {
        const progress = getPhaseProgress(phase);
        const isExpanded = expandedPhases[phase.id] ?? false;
        return (
          <div key={phase.id} className="pb-1">
            <button
              type="button"
              className="flex w-full shrink-0 cursor-pointer items-center gap-2 px-2 pt-1.5 pb-1 text-left transition-colors hover:bg-hover-derived/40"
              onClick={() => togglePhase(phase.id)}
              aria-expanded={isExpanded}
            >
              <IconChevronDownOutline18
                className={cn(
                  'size-3 shrink-0 text-subtle-foreground transition-transform duration-100',
                  isExpanded && 'rotate-180',
                )}
              />
              <SwarmStatusIndicator status={phase.status} />
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    'truncate font-medium text-xs',
                    phase.status === 'running'
                      ? 'text-clodex-green-200'
                      : 'text-subtle-foreground',
                    phase.status === 'failed' && 'text-destructive',
                  )}
                >
                  {phase.title}
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width,background-color] duration-300',
                      phase.status === 'failed' && 'bg-red-500',
                      phase.status === 'running' && 'bg-clodex-green-brand',
                      phase.status === 'completed' && 'bg-zinc-500',
                      phase.status === 'pending' && 'bg-zinc-700',
                    )}
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
              </div>
              <div className="shrink-0 text-[10px] text-subtle-foreground">
                {progress.completed}/{progress.total}
              </div>
            </button>
            {isExpanded &&
              phase.tasks.map((task) => <TaskRow key={task.id} task={task} />)}
          </div>
        );
      })}
      {run.error && (
        <div className="px-2 pt-1 pb-1 text-destructive text-xs">
          {run.error}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// SwarmRunCard — one run rendered as a sidebar entry
// ============================================================================

function SwarmRunCard({ run }: { run: SwarmRunState }) {
  const progress = getRunProgress(run);
  const clearRun = useKartonProcedure((p) => p.swarm.clearRun);
  const track = useTrack();

  const handleCancel = useCallback(() => {
    track('swarm-run-cancel-clicked', { run_id: run.id });
    void clearRun(run.id).catch(() => {
      // swallow — surface failure via next karton-state read
    });
  }, [clearRun, run.id, track]);

  const isRunning = run.status === 'running';
  const [expanded, setExpanded] = useState(isRunning);

  return (
    <div className="rounded-md border border-border/40 bg-background">
      <div className="flex h-7 w-full flex-row items-center justify-between gap-2 pr-1 pl-1.5 text-muted-foreground text-xs">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <IconChevronDownOutline18
            className={cn(
              'size-3 shrink-0 transition-transform duration-100',
              expanded && 'rotate-180',
            )}
          />
          <SwarmStatusIndicator status={run.status} />
          <span className="truncate">{run.description}</span>
          <span className="shrink-0 text-subtle-foreground">
            ({progress.completed}/{progress.total})
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <span
            className={cn(
              'rounded border border-border/40 px-1.5 text-[10px] uppercase leading-4',
              run.status === 'running' &&
                'border-clodex-green-brand/40 bg-clodex-green-brand/10 text-clodex-green-200',
              run.status === 'completed' &&
                'border-zinc-500/40 bg-zinc-500/10 text-zinc-300',
              run.status === 'failed' &&
                'border-red-500/40 bg-red-500/10 text-destructive',
            )}
          >
            {run.status}
          </span>
          {isRunning && (
            <Tooltip>
              <TooltipTrigger>
                <Button
                  variant="ghost"
                  size="icon-2xs"
                  aria-label="Cancel swarm"
                  onClick={handleCancel}
                >
                  <IconXmarkOutline18 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Cancel swarm</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      {expanded && <SwarmRunContent run={run} />}
    </div>
  );
}

// ============================================================================
// SwarmRightSidebar — Claude Desktop background-tasks style
// ============================================================================
//
// Reads the same `s.swarmRuns` karton state the legacy StatusCard section
// used. Filters by the currently-open agent so the sidebar reflects the
// chat the user is looking at. Multiple runs are stacked newest-first.

export const SwarmRightSidebar = memo(function SwarmRightSidebar() {
  const [openAgent] = useOpenAgent();

  const runs = useKartonState(
    useComparingSelector(
      (s): SwarmRunState[] => {
        if (!openAgent) return [];
        return Object.values(s.swarmRuns)
          .filter((run) => run.agentInstanceId === openAgent)
          .sort((a, b) => b.startedAt - a.startedAt);
      },
      (a, b) => {
        if (a === b) return true;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
          const left = a[i];
          const right = b[i];
          if (!left || !right) return false;
          if (getRunRenderFingerprint(left) !== getRunRenderFingerprint(right))
            return false;
        }
        return true;
      },
    ),
  );

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-border/40 border-b px-3 text-muted-foreground text-xs">
        <IconCodeBranchOutline18 className="size-3.5 shrink-0" />
        <span className="font-medium uppercase tracking-wide">Background</span>
        <span className="ml-auto text-subtle-foreground">
          {runs.length} {runs.length === 1 ? 'task' : 'tasks'}
        </span>
      </div>
      {runs.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-muted-foreground text-xs">
          <span>
            Background tasks will appear here. Ask the agent to plan a
            multi-step change to start a swarm.
          </span>
        </div>
      ) : (
        <OverlayScrollbar
          className="mask-alpha min-h-0 flex-1"
          options={{ overflow: { x: 'hidden', y: 'scroll' } }}
        >
          <div className="flex flex-col gap-2 p-2">
            {runs.map((run) => (
              <SwarmRunCard key={run.id} run={run} />
            ))}
          </div>
        </OverlayScrollbar>
      )}
    </div>
  );
});
