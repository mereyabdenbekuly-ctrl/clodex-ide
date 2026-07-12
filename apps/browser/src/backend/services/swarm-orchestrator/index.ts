import type {
  SwarmPlan,
  SwarmRunEvent,
  SwarmRunResult,
  SwarmTaskResult,
} from '@clodex/agent-core/swarm-orchestrator';
import { mapSwarmRoleToModelTaskRole } from '@clodex/agent-core/swarm-orchestrator';
import type {
  SwarmPhaseState,
  SwarmRunState,
  SwarmTaskState,
} from '@shared/karton-contracts/ui';
import type { KartonService } from '@/services/karton';

const MAX_SWARM_RUNS_PER_AGENT = 5;
const MAX_TASK_LOGS = 12;

export class BrowserSwarmStore {
  private readonly uiKarton: KartonService;

  constructor(uiKarton: KartonService) {
    this.uiKarton = uiKarton;
  }

  public seedRun(
    agentInstanceId: string,
    runId: string,
    plan: SwarmPlan,
    startedAt = Date.now(),
  ): void {
    const run = buildInitialRunState(agentInstanceId, runId, plan, startedAt);
    this.uiKarton.setState((draft) => {
      draft.swarmRuns[runId] = run;
      pruneOldRunsForAgent(draft.swarmRuns, agentInstanceId, runId);
    });
  }

  public applyEvent(agentInstanceId: string, event: SwarmRunEvent): void {
    this.uiKarton.setState((draft) => {
      if (event.type === 'workflow_started') {
        draft.swarmRuns[event.runId] = buildInitialRunState(
          agentInstanceId,
          event.runId,
          event.plan,
        );
        pruneOldRunsForAgent(draft.swarmRuns, agentInstanceId, event.runId);
        return;
      }

      const run = draft.swarmRuns[event.runId];
      if (!run) return;

      switch (event.type) {
        case 'phase_started': {
          run.status = 'running';
          const phase = findPhase(run, event.phaseId);
          if (phase) phase.status = 'running';
          break;
        }
        case 'task_started': {
          const task = findTask(
            run,
            event.taskId,
            event.phaseId,
            event.taskName,
          );
          if (task) {
            task.status = 'running';
            task.modelTaskRole = event.modelTaskRole;
            task.preferredModelId = event.preferredModelId;
            appendTaskLog(task, {
              level: 'info',
              message: event.preferredModelId
                ? `Started ${event.modelTaskRole} worker with preferred model ${event.preferredModelId}.`
                : `Started ${event.modelTaskRole} worker.`,
            });
          }
          // A started task implies the parent phase is in-flight. Bump
          // the phase out of `pending` even if no `phase_started` event
          // has arrived yet — keeps the sidebar in sync with reality.
          const startedPhase = findPhase(run, event.phaseId);
          if (startedPhase && startedPhase.status === 'pending') {
            startedPhase.status = 'running';
          }
          break;
        }
        case 'task_progress': {
          const task = findTask(run, event.taskId, event.phaseId);
          if (task) {
            task.metrics.tokens += event.metrics.newTokens ?? 0;
            task.metrics.toolsUsed += event.metrics.toolsUsed ?? 0;
            if (event.metrics.resolvedModelId) {
              task.resolvedModelId = event.metrics.resolvedModelId;
            }
            if (event.metrics.log) {
              appendTaskLog(task, event.metrics.log);
            }
          }
          break;
        }
        case 'task_completed': {
          const task = findTask(
            run,
            event.taskId,
            event.phaseId,
            event.result.taskName,
          );
          if (task) {
            task.status = 'completed';
            task.output = event.result.output;
            task.preferredModelId = event.result.preferredModelId;
            task.resolvedModelId = event.result.resolvedModelId;
            task.metrics.tokens += event.result.metrics?.newTokens ?? 0;
            task.metrics.toolsUsed += event.result.metrics?.toolsUsed ?? 0;
            appendTaskLog(task, {
              level: 'info',
              message: 'Completed.',
            });
          }
          break;
        }
        case 'task_failed': {
          // `task_failed` is terminal for the task but does NOT mark the
          // whole run as failed — sibling tasks may still complete and
          // deliver partial results. The runner emits a `workflow_failed`
          // separately if the whole run aborts.
          const task = findTask(run, event.taskId, event.phaseId);
          if (task) {
            task.status = 'failed';
            task.error = event.error.message;
            appendTaskLog(task, {
              level: 'error',
              message: event.error.message,
            });
          }
          break;
        }
        case 'phase_completed': {
          const phase = findPhase(run, event.phaseId);
          if (phase) {
            applyTaskResults(run, event.results);
            phase.status = 'completed';
            for (const task of phase.tasks) {
              if (task.status !== 'failed') task.status = 'completed';
            }
          }
          break;
        }
        case 'workflow_completed': {
          markRunCompleted(run, event.results, Date.now());
          break;
        }
        case 'workflow_failed': {
          applyTaskResults(run, event.partialResults);
          run.status = 'failed';
          run.error = event.error.message;
          run.completedAt = Date.now();
          break;
        }
      }

      // Self-heal: after any state change, recompute parent statuses from
      // the actual child state. Runner events can arrive out-of-order or
      // skip a level (e.g. workflow_completed before all phase_completed),
      // which used to leave the sidebar showing stale "completed" badges
      // over still-running children. The recompute is O(phases * tasks) —
      // cheap relative to the karton broadcast.
      recomputeRunStatuses(run);
    });
  }

  public completeRunFromResult(
    agentInstanceId: string,
    result: SwarmRunResult,
  ): void {
    this.uiKarton.setState((draft) => {
      let run = draft.swarmRuns[result.runId];
      if (!run) {
        run = buildInitialRunState(agentInstanceId, result.runId, result.plan);
        draft.swarmRuns[result.runId] = run;
      }

      markRunCompleted(run, result.results, Date.now());
      pruneOldRunsForAgent(draft.swarmRuns, agentInstanceId, result.runId);
    });
  }

  public clearRun(runId: string): void {
    this.uiKarton.setState((draft) => {
      delete draft.swarmRuns[runId];
    });
  }
}

export function buildInitialRunState(
  agentInstanceId: string,
  runId: string,
  plan: SwarmPlan,
  startedAt = Date.now(),
): SwarmRunState {
  return {
    id: runId,
    agentInstanceId,
    description: plan.workflow.description,
    status: 'running',
    taskComplexity: plan.task_complexity,
    startedAt,
    phases: plan.workflow.phases.map((phase) => ({
      id: phase.id,
      title: phase.title,
      status: 'pending',
      tasks: phase.tasks.map(
        (task, taskIndex): SwarmTaskState => ({
          id: task.id || `${phase.id}-t${taskIndex + 1}`,
          name: task.name,
          role: task.role,
          modelTaskRole:
            task.modelTaskRole ?? mapSwarmRoleToModelTaskRole(task.role),
          preferredModelId: task.preferredModelId,
          status: 'pending',
          prompt: task.prompt,
          logs: [],
          metrics: {
            tokens: 0,
            toolsUsed: 0,
          },
        }),
      ),
    })),
  };
}

function findPhase(
  run: SwarmRunState,
  phaseId: string,
): SwarmPhaseState | undefined {
  return run.phases.find((phase) => phase.id === phaseId);
}

function findTask(
  run: SwarmRunState,
  taskId: string,
  phaseId?: string,
  taskName?: string,
): SwarmTaskState | undefined {
  const phases = phaseId
    ? run.phases.filter((phase) => phase.id === phaseId)
    : run.phases;

  for (const phase of phases) {
    const task = phase.tasks.find((candidate) => candidate.id === taskId);
    if (task) return task;
  }

  if (taskName) {
    for (const phase of phases) {
      const task = phase.tasks.find((candidate) => candidate.name === taskName);
      if (task) return task;
    }
  }

  return undefined;
}

function applyTaskResults(
  run: SwarmRunState,
  results: readonly SwarmTaskResult[],
): void {
  for (const result of results) {
    const task = findTask(run, result.taskId, undefined, result.taskName);
    if (!task) continue;

    task.status = 'completed';
    task.output = result.output;
    task.modelTaskRole = result.modelTaskRole;
    task.preferredModelId = result.preferredModelId;
    task.resolvedModelId = result.resolvedModelId;
    task.error = undefined;
    appendTaskLog(task, {
      level: 'info',
      message: result.output.startsWith(`## ${result.taskName} unavailable`)
        ? 'Marked unavailable and continued with remaining agents.'
        : 'Result received.',
    });

    const resultTokens = result.metrics?.newTokens ?? 0;
    const resultTools = result.metrics?.toolsUsed ?? 0;
    if (task.metrics.tokens === 0 && resultTokens > 0) {
      task.metrics.tokens = resultTokens;
    }
    if (task.metrics.toolsUsed === 0 && resultTools > 0) {
      task.metrics.toolsUsed = resultTools;
    }
  }
}

function appendTaskLog(
  task: SwarmTaskState,
  entry: {
    level: 'info' | 'warn' | 'error';
    message: string;
    timestamp?: number;
  },
): void {
  task.logs.push({
    level: entry.level,
    message: entry.message,
    timestamp: entry.timestamp ?? Date.now(),
  });
  if (task.logs.length > MAX_TASK_LOGS) {
    task.logs.splice(0, task.logs.length - MAX_TASK_LOGS);
  }
}

function markRunCompleted(
  run: SwarmRunState,
  results: readonly SwarmTaskResult[],
  completedAt: number,
): void {
  applyTaskResults(run, results);

  for (const phase of run.phases) {
    phase.status = 'completed';
    for (const task of phase.tasks) {
      task.status = 'completed';
      task.error = undefined;
    }
  }

  run.status = 'completed';
  run.error = undefined;
  run.completedAt = completedAt;
}

function pruneOldRunsForAgent(
  runs: Record<string, SwarmRunState>,
  agentInstanceId: string,
  keepRunId: string,
): void {
  const agentRuns = Object.values(runs)
    .filter((run) => run.agentInstanceId === agentInstanceId)
    .sort((a, b) => b.startedAt - a.startedAt);

  for (const run of agentRuns.slice(MAX_SWARM_RUNS_PER_AGENT)) {
    if (run.id !== keepRunId) delete runs[run.id];
  }
}

/**
 * Recompute parent statuses from the actual child state. Called after
 * every event so the sidebar cannot end up showing e.g. a `completed`
 * phase badge over still-running children.
 *
 * Rules:
 * - phase is `failed` if any task is `failed`. (Once a task fails the
 *   phase is broken even if other tasks finish successfully.)
 * - phase is `completed` if every task is `completed` AND there is at
 *   least one task. (Empty phases stay `pending` until runner reports.)
 * - phase is `running` if any task is `running` (or `pending` while
 *   other tasks already moved).
 * - run is `failed` if any phase is `failed`.
 * - run is `completed` if every phase is `completed`. The runner may
 *   still send `workflow_completed` after this; that event wins.
 *
 * Conservative: never demotes a runner-emitted terminal state. A `failed`
 * or `completed` status stays, even if a stale child shows the opposite.
 */
export function recomputeRunStatuses(run: SwarmRunState): void {
  for (const phase of run.phases) {
    let anyTaskRunning = false;
    let anyTaskFailed = false;
    let allTasksCompleted = phase.tasks.length > 0;

    for (const task of phase.tasks) {
      if (task.status === 'running' || task.status === 'pending') {
        allTasksCompleted = false;
      }
      if (task.status === 'running') anyTaskRunning = true;
      if (task.status === 'failed') anyTaskFailed = true;
    }

    // Only escalate phase status from a non-terminal state. Never
    // demote `completed`/`failed` — those are terminal until a fresh
    // event says otherwise.
    if (phase.status === 'pending' || phase.status === 'running') {
      if (anyTaskFailed) {
        phase.status = 'failed';
      } else if (allTasksCompleted) {
        phase.status = 'completed';
      } else if (anyTaskRunning && phase.status === 'pending') {
        phase.status = 'running';
      }
    }
  }

  // Run-level: only flip from `running` to a terminal state. Never
  // demote a terminal `completed`/`failed` — the runner is the source
  // of truth for those.
  if (run.status === 'running') {
    let allPhasesCompleted = run.phases.length > 0;
    let anyPhaseFailed = false;
    for (const phase of run.phases) {
      if (phase.status !== 'completed') allPhasesCompleted = false;
      if (phase.status === 'failed') anyPhaseFailed = true;
    }
    if (anyPhaseFailed) {
      run.status = 'failed';
      run.completedAt = run.completedAt ?? Date.now();
    } else if (allPhasesCompleted) {
      run.status = 'completed';
      run.completedAt = run.completedAt ?? Date.now();
    }
  }
}
