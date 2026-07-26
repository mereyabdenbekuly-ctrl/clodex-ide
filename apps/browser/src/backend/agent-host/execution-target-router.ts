import { randomUUID } from 'node:crypto';
import {
  createAgentExecutionTaskRecord,
  transitionAgentExecutionTask,
  type AgentExecutionTarget,
  type AgentExecutionTaskRecord,
  type AgentExecutionTaskStatus,
  type AgentStepExecution,
  type AgentStepExecutionRequest,
  type AgentStepExecutor,
} from '@clodex/agent-core/agents';
import type {
  AsyncIterableStream,
  InferUIMessageChunk,
  UIMessage,
  UIMessageStreamOptions,
} from 'ai';
import {
  CloudTaskSnapshotError,
  type CloudTaskSnapshotDescriptor,
  type CloudTaskSnapshotPackager,
} from './cloud-task-snapshot-packager';

const DEFAULT_MAX_RECENT_TASKS = 100;

export type ExecutionTargetFailureReason =
  | 'gate-disabled'
  | 'adapter-unavailable'
  | 'snapshot-unavailable'
  | 'snapshot-invalid'
  | 'snapshot-error'
  | 'lease-conflict'
  | 'execution-error'
  | 'aborted'
  | 'timeout';

export interface ExecutionTargetAuditEvent {
  operation: 'selected' | 'transition' | 'rejected';
  target: AgentExecutionTarget;
  status: AgentExecutionTaskStatus;
  reason?: ExecutionTargetFailureReason;
  durationMs?: number;
}

export interface AgentExecutionTargetAdapter extends AgentStepExecutor {
  readonly target: AgentExecutionTarget;
  isAvailable(): boolean;
}

export interface ExecutionTargetRouterOptions {
  localExecutor: AgentStepExecutor;
  cloudAdapter?: AgentExecutionTargetAdapter;
  snapshotPackager?: CloudTaskSnapshotPackager;
  isCloudEnabled: () => boolean;
  audit?: (event: ExecutionTargetAuditEvent) => void;
  createTaskId?: () => string;
  now?: () => number;
  maxRecentTasks?: number;
  isLocalExecutionAllowed?: (agentInstanceId: string) => boolean;
}

export class LocalExecutionTargetAdapter
  implements AgentExecutionTargetAdapter
{
  public readonly target = 'local' as const;

  public constructor(private readonly executor: AgentStepExecutor) {}

  public isAvailable(): boolean {
    return true;
  }

  public execute(
    request: AgentStepExecutionRequest,
  ): AgentStepExecution | PromiseLike<AgentStepExecution> {
    return this.executor.execute(request);
  }
}

export class UnavailableCloudExecutionTargetAdapter
  implements AgentExecutionTargetAdapter
{
  public readonly target = 'cloud' as const;

  public isAvailable(): boolean {
    return false;
  }

  public execute(): never {
    throw new CloudExecutionTargetUnavailableError('adapter-unavailable');
  }
}

export class CloudExecutionTargetUnavailableError extends Error {
  public constructor(
    public readonly reason: Extract<
      ExecutionTargetFailureReason,
      'gate-disabled' | 'adapter-unavailable'
    >,
  ) {
    super(
      reason === 'gate-disabled'
        ? 'Cloud task execution is disabled'
        : 'Cloud task execution adapter is unavailable',
    );
    this.name = 'CloudExecutionTargetUnavailableError';
  }
}

export class CloudExecutionSnapshotPreparationError extends Error {
  public constructor(
    public readonly reason: Extract<
      ExecutionTargetFailureReason,
      'snapshot-unavailable' | 'snapshot-invalid' | 'snapshot-error' | 'aborted'
    >,
    options?: ErrorOptions,
  ) {
    super(
      reason === 'snapshot-unavailable'
        ? 'Cloud task snapshot packager is unavailable'
        : reason === 'snapshot-invalid'
          ? 'Cloud task snapshot selection is invalid'
          : reason === 'aborted'
            ? 'Cloud task snapshot preparation was cancelled'
            : 'Cloud task snapshot preparation failed',
      options,
    );
    this.name = 'CloudExecutionSnapshotPreparationError';
  }
}

export class ExecutionTargetRouter implements AgentStepExecutor {
  private readonly localAdapter: AgentExecutionTargetAdapter;
  private readonly cloudAdapter: AgentExecutionTargetAdapter;
  private readonly snapshotPackager: CloudTaskSnapshotPackager | undefined;
  private readonly isCloudEnabled: () => boolean;
  private readonly auditSink:
    | ((event: ExecutionTargetAuditEvent) => void)
    | undefined;
  private readonly createTaskId: () => string;
  private readonly now: () => number;
  private readonly maxRecentTasks: number;
  private readonly isLocalExecutionAllowed: (
    agentInstanceId: string,
  ) => boolean;
  private readonly tasks = new Map<string, AgentExecutionTaskRecord>();

  public constructor(options: ExecutionTargetRouterOptions) {
    this.localAdapter = new LocalExecutionTargetAdapter(options.localExecutor);
    this.cloudAdapter =
      options.cloudAdapter ?? new UnavailableCloudExecutionTargetAdapter();
    if (this.cloudAdapter.target !== 'cloud') {
      throw new Error('Cloud execution adapter must target cloud');
    }
    this.snapshotPackager = options.snapshotPackager;
    this.isCloudEnabled = options.isCloudEnabled;
    this.auditSink = options.audit;
    this.createTaskId = options.createTaskId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.maxRecentTasks = options.maxRecentTasks ?? DEFAULT_MAX_RECENT_TASKS;
    this.isLocalExecutionAllowed =
      options.isLocalExecutionAllowed ?? (() => false);
  }

  public async execute(
    request: AgentStepExecutionRequest,
  ): Promise<AgentStepExecution> {
    const target = request.context.executionTarget ?? 'local';
    const taskId = this.createTaskId();
    const createdAt = this.now();
    this.storeTask(
      createAgentExecutionTaskRecord({
        id: taskId,
        target,
        now: createdAt,
      }),
    );
    this.audit({
      operation: 'selected',
      target,
      status: 'queued',
    });
    this.transition(taskId, 'preparing');

    if (
      target === 'local' &&
      !this.isLocalExecutionAllowed(request.context.agentInstanceId)
    ) {
      this.reject(taskId, 'lease-conflict');
      throw new CloudExecutionLeaseConflictError();
    }

    if (target === 'cloud' && !this.isCloudEnabled()) {
      this.reject(taskId, 'gate-disabled');
      throw new CloudExecutionTargetUnavailableError('gate-disabled');
    }
    const adapter = target === 'cloud' ? this.cloudAdapter : this.localAdapter;
    if (!adapter.isAvailable()) {
      this.reject(taskId, 'adapter-unavailable');
      throw new CloudExecutionTargetUnavailableError('adapter-unavailable');
    }

    let routedRequest: AgentStepExecutionRequest = {
      ...request,
      context: {
        ...request.context,
        executionTarget: target,
        executionTaskId: taskId,
      },
    };
    let snapshotCleanup: (() => Promise<void>) | undefined;
    if (target === 'cloud') {
      const prepared = await this.prepareCloudSnapshot(taskId, routedRequest);
      routedRequest = prepared.request;
      snapshotCleanup = prepared.cleanup;
    }
    let execution: AgentStepExecution;
    try {
      execution = await adapter.execute(routedRequest);
    } catch (error) {
      await snapshotCleanup?.().catch(() => {});
      const failure = classifyExecutionError(error);
      this.markTerminal(taskId, failure.status, failure.reason);
      throw error;
    }
    if (snapshotCleanup) {
      try {
        await snapshotCleanup();
      } catch (error) {
        this.reject(taskId, 'snapshot-error');
        throw new CloudExecutionSnapshotPreparationError('snapshot-error', {
          cause: error,
        });
      }
    }
    return new TrackedAgentStepExecution(
      execution,
      routedRequest.options.abortSignal,
      () => this.markRunning(taskId),
      (status, reason) => this.markTerminal(taskId, status, reason),
    );
  }

  public listRecentTasks(): AgentExecutionTaskRecord[] {
    return Array.from(this.tasks.values(), (task) => structuredClone(task));
  }

  public getTask(taskId: string): AgentExecutionTaskRecord | null {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : null;
  }

  private markRunning(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'preparing') return;
    this.transition(taskId, 'running');
  }

  private markTerminal(
    taskId: string,
    status: Extract<
      AgentExecutionTaskStatus,
      'completed' | 'failed' | 'cancelled'
    >,
    reason?: ExecutionTargetFailureReason,
  ): void {
    const task = this.tasks.get(taskId);
    if (
      !task ||
      task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'cancelled'
    ) {
      return;
    }
    this.transition(taskId, status, reason);
  }

  private reject(
    taskId: string,
    reason: ExecutionTargetFailureReason,
    status: Extract<
      AgentExecutionTaskStatus,
      'failed' | 'cancelled'
    > = 'failed',
  ): void {
    const task = this.transition(taskId, status, reason);
    this.audit({
      operation: 'rejected',
      target: task.target,
      status: task.status,
      reason,
      durationMs: Math.max(0, task.updatedAt - task.createdAt),
    });
  }

  private async prepareCloudSnapshot(
    taskId: string,
    request: AgentStepExecutionRequest,
  ): Promise<{
    request: AgentStepExecutionRequest;
    cleanup: () => Promise<void>;
  }> {
    if (!this.snapshotPackager) {
      this.reject(taskId, 'snapshot-unavailable');
      throw new CloudExecutionSnapshotPreparationError('snapshot-unavailable');
    }

    let prepared:
      | Awaited<ReturnType<CloudTaskSnapshotPackager['prepare']>>
      | undefined;
    try {
      prepared = await this.snapshotPackager.prepare({
        taskId,
        agentInstanceId: request.context.agentInstanceId,
        selection: request.context.snapshotSelection ?? {
          version: 1,
          mode: 'explicit',
          entries: [],
        },
        abortSignal: request.options.abortSignal,
      });
      return {
        request: withCloudSnapshot(request, prepared.descriptor),
        cleanup: prepared.cleanup,
      };
    } catch (error) {
      if (prepared) {
        await prepared.cleanup().catch(() => {});
      }
      const reason = classifySnapshotPreparationError(error);
      this.reject(
        taskId,
        reason,
        reason === 'aborted' ? 'cancelled' : 'failed',
      );
      throw new CloudExecutionSnapshotPreparationError(reason, {
        cause: error,
      });
    }
  }

  private transition(
    taskId: string,
    status: AgentExecutionTaskStatus,
    reason?: ExecutionTargetFailureReason,
  ): AgentExecutionTaskRecord {
    const current = this.tasks.get(taskId);
    if (!current) throw new Error('Execution task is missing');
    const next = transitionAgentExecutionTask(current, status, {
      now: this.now(),
      failureReason: reason,
    });
    this.tasks.set(taskId, next);
    this.audit({
      operation: 'transition',
      target: next.target,
      status: next.status,
      reason,
      durationMs:
        next.finishedAt === null
          ? undefined
          : Math.max(0, next.finishedAt - next.createdAt),
    });
    return next;
  }

  private storeTask(task: AgentExecutionTaskRecord): void {
    this.tasks.set(task.id, task);
    while (this.tasks.size > this.maxRecentTasks) {
      const oldest = this.tasks.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.tasks.delete(oldest);
    }
  }

  private audit(event: ExecutionTargetAuditEvent): void {
    try {
      this.auditSink?.(event);
    } catch {
      // Audit transport must not alter execution routing.
    }
  }
}

export class CloudExecutionLeaseConflictError extends Error {
  public readonly reason = 'lease-conflict' as const;

  public constructor() {
    super('Local execution is read-only while a cloud task lease is active');
    this.name = 'CloudExecutionLeaseConflictError';
  }
}

export function createExecutionTargetRouter(
  options: ExecutionTargetRouterOptions,
): ExecutionTargetRouter {
  return new ExecutionTargetRouter(options);
}

class TrackedAgentStepExecution implements AgentStepExecution {
  public readonly modelRouteBinding: AgentStepExecution['modelRouteBinding'];
  private terminal = false;
  private readonly abortHandler: (() => void) | null;

  public constructor(
    private readonly execution: AgentStepExecution,
    private readonly abortSignal: AbortSignal | undefined,
    private readonly onRunning: () => void,
    private readonly onTerminal: (
      status: Extract<
        AgentExecutionTaskStatus,
        'completed' | 'failed' | 'cancelled'
      >,
      reason?: ExecutionTargetFailureReason,
    ) => void,
  ) {
    this.modelRouteBinding = execution.modelRouteBinding;
    this.abortHandler = abortSignal
      ? () => this.finish('cancelled', 'aborted')
      : null;
    if (abortSignal?.aborted) {
      this.abortHandler?.();
    } else if (this.abortHandler) {
      abortSignal?.addEventListener('abort', this.abortHandler, { once: true });
    }
  }

  public consumeStream(options?: {
    onError?: (error: unknown) => void;
  }): PromiseLike<void> {
    return this.execution.consumeStream({
      onError: (error) => {
        const failure = classifyExecutionError(error);
        this.finish(failure.status, failure.reason);
        options?.onError?.(error);
      },
    });
  }

  public toUIMessageStream<UI_MESSAGE extends UIMessage>(
    options?: UIMessageStreamOptions<UI_MESSAGE>,
  ): AsyncIterableStream<InferUIMessageChunk<UI_MESSAGE>> {
    this.onRunning();
    const source = this.execution.toUIMessageStream(options);
    const iterator = source[Symbol.asyncIterator]();
    return toAsyncIterableStream(
      new ReadableStream<InferUIMessageChunk<UI_MESSAGE>>({
        pull: async (controller) => {
          try {
            const result = await iterator.next();
            if (result.done) {
              this.finish('completed');
              controller.close();
              return;
            }
            const type = getChunkType(result.value);
            if (type === 'abort') {
              const failure = classifyExecutionError(
                new DOMException(
                  getChunkReason(result.value) ?? 'Agent step aborted',
                  'AbortError',
                ),
              );
              this.finish(failure.status, failure.reason);
            } else if (type === 'error') {
              this.finish('failed', 'execution-error');
            }
            controller.enqueue(result.value);
          } catch (error) {
            const failure = classifyExecutionError(error);
            this.finish(failure.status, failure.reason);
            controller.error(error);
          }
        },
        cancel: async () => {
          try {
            await iterator.return?.();
          } finally {
            this.finish('cancelled', 'aborted');
          }
        },
      }),
    );
  }

  private finish(
    status: Extract<
      AgentExecutionTaskStatus,
      'completed' | 'failed' | 'cancelled'
    >,
    reason?: ExecutionTargetFailureReason,
  ): void {
    if (this.terminal) return;
    this.terminal = true;
    if (this.abortHandler) {
      this.abortSignal?.removeEventListener('abort', this.abortHandler);
    }
    this.onTerminal(status, reason);
  }
}

function getChunkType(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('type' in value)) return null;
  return typeof value.type === 'string' ? value.type : null;
}

function getChunkReason(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('reason' in value)) return null;
  return typeof value.reason === 'string' ? value.reason : null;
}

function classifyExecutionError(error: unknown): {
  status: 'failed' | 'cancelled';
  reason: Extract<
    ExecutionTargetFailureReason,
    'execution-error' | 'aborted' | 'timeout'
  >;
} {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);
  if (
    (error instanceof Error && error.name === 'TimeoutError') ||
    message.includes('timed out') ||
    message.includes('timeout')
  ) {
    return { status: 'failed', reason: 'timeout' };
  }
  if (isAbortError(error)) {
    return { status: 'cancelled', reason: 'aborted' };
  }
  return { status: 'failed', reason: 'execution-error' };
}

function classifySnapshotPreparationError(
  error: unknown,
): Extract<
  ExecutionTargetFailureReason,
  'snapshot-invalid' | 'snapshot-error' | 'aborted'
> {
  if (error instanceof CloudTaskSnapshotError) {
    if (error.reason === 'aborted') return 'aborted';
    if (
      error.reason === 'io-error' ||
      error.reason === 'crypto-error' ||
      error.reason === 'file-changed'
    ) {
      return 'snapshot-error';
    }
    return 'snapshot-invalid';
  }
  return isAbortError(error) ? 'aborted' : 'snapshot-error';
}

function withCloudSnapshot(
  request: AgentStepExecutionRequest,
  snapshot: CloudTaskSnapshotDescriptor,
): AgentStepExecutionRequest {
  return {
    ...request,
    context: {
      ...request.context,
      metadata: {
        ...request.context.metadata,
        cloudSnapshot: snapshot,
      },
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function toAsyncIterableStream<T>(
  source: ReadableStream<T>,
): AsyncIterableStream<T> {
  const stream = source as AsyncIterableStream<T>;
  (
    stream as unknown as {
      [Symbol.asyncIterator]: () => AsyncIterator<T>;
    }
  )[Symbol.asyncIterator] = () => {
    const reader = source.getReader();
    const iterator: AsyncIterator<T> & AsyncIterable<T> = {
      async next(): Promise<IteratorResult<T>> {
        const result = await reader.read();
        if (result.done) {
          reader.releaseLock();
          return { done: true, value: undefined };
        }
        return { done: false, value: result.value };
      },
      async return(): Promise<IteratorResult<T>> {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  };
  return stream;
}
