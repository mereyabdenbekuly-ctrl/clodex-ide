import { memo, useMemo } from 'react';
import { cn } from '@ui/utils';
import type { SwarmRunState } from '@shared/karton-contracts/ui';

function getRunProgress(run: SwarmRunState): {
  completed: number;
  total: number;
  percent: number;
} {
  const tasks = run.phases.flatMap((phase) => phase.tasks);
  const total = tasks.length;
  const completed = tasks.filter((task) => task.status === 'completed').length;
  return {
    completed,
    total,
    percent: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
}

function getActivePhaseTitle(run: SwarmRunState): string {
  const running = run.phases.find((phase) => phase.status === 'running');
  if (running) return running.title;
  const next = run.phases.find((phase) => phase.status === 'pending');
  if (next) return next.title;
  const last = run.phases.at(-1);
  return last?.title ?? run.description;
}

export const SwarmInlineProgress = memo(function SwarmInlineProgress({
  run,
}: {
  run: SwarmRunState;
}) {
  const progress = useMemo(() => getRunProgress(run), [run]);
  const activePhaseTitle = getActivePhaseTitle(run);

  return (
    <div className="mt-3 w-full max-w-xl rounded-lg border border-blue-500/20 bg-blue-500/8 p-3 shadow-[0_0_0_1px_rgba(59,130,246,0.08)]">
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'size-2.5 shrink-0 rounded-[2px]',
            run.status === 'running' &&
              'animate-pulse bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)]',
            run.status === 'completed' && 'bg-zinc-500',
            run.status === 'failed' && 'bg-red-500',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium text-foreground">
              Swarm выполняет задачу
            </span>
            <span className="text-blue-200">
              {progress.completed}/{progress.total}
            </span>
          </div>
          <div className="mt-1 truncate text-subtle-foreground text-xs">
            {activePhaseTitle}
          </div>
        </div>
        <span className="shrink-0 rounded border border-blue-500/30 px-1.5 text-[10px] text-blue-200 uppercase leading-4">
          {run.status === 'running' ? 'running' : run.status}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={cn(
            'h-full rounded-full transition-[width,background-color] duration-300',
            run.status === 'running' && 'bg-blue-500',
            run.status === 'completed' && 'bg-zinc-500',
            run.status === 'failed' && 'bg-red-500',
          )}
          style={{
            width: `${Math.max(progress.percent, run.status === 'running' ? 8 : 0)}%`,
          }}
        />
      </div>
    </div>
  );
});
