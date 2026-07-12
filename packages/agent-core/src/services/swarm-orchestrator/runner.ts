import { randomUUID } from 'node:crypto';
import type { ModelTaskRole } from '../../host/models';
import type {
  SwarmEventListener,
  SwarmPhase,
  SwarmPlan,
  SwarmRunEvent,
  SwarmRunResult,
  SwarmTask,
  SwarmTaskExecutor,
  SwarmTaskResult,
  SwarmTaskRole,
} from './types';
import { normalizeSwarmPlan } from './planner';

const MAX_SHARED_CONTEXT_RESULT_CHARS = 12_000;
const MAX_SHARED_CONTEXT_TOTAL_CHARS = 48_000;

export interface SwarmRunnerOptions {
  executor: SwarmTaskExecutor;
  idGenerator?: () => string;
}

export class SwarmRunner {
  private readonly executor: SwarmTaskExecutor;
  private readonly idGenerator: () => string;
  private readonly listeners = new Set<SwarmEventListener>();

  constructor(options: SwarmRunnerOptions) {
    this.executor = options.executor;
    this.idGenerator = options.idGenerator ?? randomUUID;
  }

  public on(listener: SwarmEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async run(
    plan: SwarmPlan,
    runId = this.idGenerator(),
  ): Promise<SwarmRunResult> {
    const normalizedPlan = normalizeSwarmPlan(plan);
    const results: SwarmTaskResult[] = [];

    this.emit({ type: 'workflow_started', runId, plan: normalizedPlan });

    try {
      for (const [
        phaseIndex,
        phase,
      ] of normalizedPlan.workflow.phases.entries()) {
        this.emit({
          type: 'phase_started',
          runId,
          phaseId: phase.id,
          phaseTitle: phase.title,
          phaseIndex,
        });

        const phaseResults = await this.runPhase({
          runId,
          plan: normalizedPlan,
          phase,
          phaseIndex,
          previousResults: results,
        });
        results.push(...phaseResults);
        this.emit({
          type: 'phase_completed',
          runId,
          phaseId: phase.id,
          results: phaseResults,
          sharedContext: formatSharedContext(results),
        });
      }

      this.emit({
        type: 'workflow_completed',
        runId,
        results,
        sharedContext: formatSharedContext(results),
      });
      return { runId, plan: normalizedPlan, results };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit({
        type: 'workflow_failed',
        runId,
        error: err,
        partialResults: results,
        sharedContext: formatSharedContext(results),
      });
      throw err;
    }
  }

  private async runPhase({
    runId,
    plan,
    phase,
    phaseIndex,
    previousResults,
  }: {
    runId: string;
    plan: SwarmPlan;
    phase: SwarmPhase;
    phaseIndex: number;
    previousResults: readonly SwarmTaskResult[];
  }): Promise<SwarmTaskResult[]> {
    const sharedContext = formatSharedContext(previousResults);
    const settled = await Promise.allSettled(
      phase.tasks.map((task, taskIndex) =>
        this.runTask({
          runId,
          plan,
          phase,
          task: withTaskId(task, phase.id, taskIndex),
          phaseIndex,
          taskIndex,
          previousResults,
          sharedContext,
        }),
      ),
    );

    if (phase.failureMode === 'soft') {
      return settled.map((result, taskIndex) => {
        if (result.status === 'fulfilled') return result.value;

        const task = withTaskId(phase.tasks[taskIndex], phase.id, taskIndex);
        const modelTaskRole =
          task.modelTaskRole ?? mapSwarmRoleToModelTaskRole(task.role);
        const error =
          result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason));
        return {
          taskId: task.id,
          taskName: task.name,
          role: task.role,
          modelTaskRole,
          preferredModelId: task.preferredModelId,
          output: formatSoftFailedTaskOutput(task.name, error),
        };
      });
    }

    const failed = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) {
      throw failed.reason instanceof Error
        ? failed.reason
        : new Error(String(failed.reason));
    }

    return settled.map(
      (result) => (result as PromiseFulfilledResult<SwarmTaskResult>).value,
    );
  }

  private async runTask({
    runId,
    plan,
    phase,
    task,
    phaseIndex,
    taskIndex,
    previousResults,
    sharedContext,
  }: {
    runId: string;
    plan: SwarmPlan;
    phase: SwarmPhase;
    task: SwarmTask & { id: string };
    phaseIndex: number;
    taskIndex: number;
    previousResults: readonly SwarmTaskResult[];
    sharedContext: string;
  }): Promise<SwarmTaskResult> {
    const modelTaskRole =
      task.modelTaskRole ?? mapSwarmRoleToModelTaskRole(task.role);
    this.emit({
      type: 'task_started',
      runId,
      phaseId: phase.id,
      taskId: task.id,
      taskName: task.name,
      role: task.role,
      modelTaskRole,
      preferredModelId: task.preferredModelId,
    });

    try {
      const output = await this.executor({
        runId,
        plan,
        phase,
        task,
        phaseIndex,
        taskIndex,
        modelTaskRole,
        previousResults,
        sharedContext,
        emitProgress: (metrics) => {
          this.emit({
            type: 'task_progress',
            runId,
            phaseId: phase.id,
            taskId: task.id,
            metrics,
          });
        },
      });
      const result: SwarmTaskResult =
        typeof output === 'string'
          ? {
              taskId: task.id,
              taskName: task.name,
              role: task.role,
              modelTaskRole,
              preferredModelId: task.preferredModelId,
              output,
            }
          : {
              ...output,
              taskId: task.id,
              taskName: task.name,
              role: task.role,
              modelTaskRole,
              preferredModelId: task.preferredModelId,
            };

      this.emit({
        type: 'task_completed',
        runId,
        phaseId: phase.id,
        taskId: task.id,
        result,
        sharedContext: formatSharedContext([...previousResults, result]),
      });
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit({
        type: 'task_failed',
        runId,
        phaseId: phase.id,
        taskId: task.id,
        error: err,
      });
      throw err;
    }
  }

  private emit(event: SwarmRunEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export function mapSwarmRoleToModelTaskRole(
  role: SwarmTaskRole,
): ModelTaskRole {
  switch (role) {
    case 'coder':
      return 'coding';
    case 'reviewer':
      return 'review';
    case 'researcher':
    case 'planner':
      return 'analysis';
  }
}

export function formatSharedContext(
  results: readonly SwarmTaskResult[],
): string {
  if (results.length === 0) return '';

  const blocks = results.map((result) => {
    const boundedOutput = truncateSharedContextText(
      result.output,
      MAX_SHARED_CONTEXT_RESULT_CHARS,
    );
    return [
      `<task id="${escapeAttribute(result.taskId)}" name="${escapeAttribute(
        result.taskName,
      )}" role="${result.role}" modelRole="${result.modelTaskRole}">`,
      boundedOutput,
      '</task>',
    ].join('\n');
  });

  return truncateSharedContextText(
    ['<swarm-context>', ...blocks, '</swarm-context>'].join('\n'),
    MAX_SHARED_CONTEXT_TOTAL_CHARS,
  );
}

function truncateSharedContextText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated for swarm context]`;
}

function withTaskId(
  task: SwarmTask | undefined,
  phaseId: string,
  taskIndex: number,
): SwarmTask & { id: string } {
  if (!task) {
    throw new Error(`Missing swarm task ${phaseId}-t${taskIndex + 1}`);
  }
  return {
    ...task,
    id: task.id || `${phaseId}-t${taskIndex + 1}`,
  };
}

function formatSoftFailedTaskOutput(taskName: string, error: Error): string {
  return [
    `## ${taskName} unavailable`,
    '',
    'This debate participant could not complete because its model/provider returned a runtime error.',
    `Last error: ${error.message}`,
    '',
    'Continue the workflow using the remaining completed participants. Do not treat this as evidence for or against the technical approach; treat it as missing input.',
  ].join('\n');
}

function escapeAttribute(value: string): string {
  return value.replace(/[<>&"]/g, (char) => {
    switch (char) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      default:
        return char;
    }
  });
}
