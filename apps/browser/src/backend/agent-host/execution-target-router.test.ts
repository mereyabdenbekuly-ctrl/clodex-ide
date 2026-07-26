import type {
  AgentExecutionTarget,
  AgentStepExecution,
  AgentStepExecutionRequest,
  AgentStepExecutor,
} from '@clodex/agent-core/agents';
import type { AsyncIterableStream, InferUIMessageChunk, UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import {
  CloudExecutionLeaseConflictError,
  CloudExecutionSnapshotPreparationError,
  CloudExecutionTargetUnavailableError,
  ExecutionTargetRouter,
  type AgentExecutionTargetAdapter,
} from './execution-target-router';
import type { CloudTaskSnapshotPackager } from './cloud-task-snapshot-packager';
import { createAutomaticSwarmStepExecutor } from '../services/agent-manager';
import { createAutomaticSwarmStepExecution } from '../services/swarm-runtime';

function createRequest(
  target?: AgentExecutionTarget,
  abortSignal?: AbortSignal,
): AgentStepExecutionRequest {
  return {
    context: {
      agentInstanceId: 'agent-1',
      agentType: 'chat',
      traceId: 'trace-1',
      requestedModelId: 'selected-model',
      resolvedModelId: 'routed-model',
      isApprovalContinuation: false,
      executionTarget: target,
      snapshotSelection:
        target === 'cloud'
          ? {
              version: 1,
              mode: 'explicit',
              entries: [
                {
                  mountPrefix: 'repo',
                  relativePath: 'src/index.ts',
                  expectedSha256: 'a'.repeat(64),
                },
              ],
            }
          : undefined,
      metadata: {},
    },
    options: {
      model: {} as never,
      messages: [{ role: 'user', content: 'hello' }],
      abortSignal,
    },
  };
}

function createExecution(
  chunks: Array<Record<string, unknown>> = [{ type: 'finish' }],
): AgentStepExecution {
  return {
    consumeStream: vi.fn(async () => {}),
    toUIMessageStream: vi.fn(() => createStream(chunks) as never),
  };
}

function createExecutor(execution = createExecution()) {
  const executor: AgentStepExecutor = {
    execute: vi.fn(() => execution),
  };
  return { executor, execution };
}

function createCloudAdapter(
  execution: AgentStepExecution,
): AgentExecutionTargetAdapter {
  return {
    target: 'cloud',
    isAvailable: () => true,
    execute: vi.fn(() => execution),
  };
}

function createSnapshotPackager() {
  const cleanup = vi.fn(async () => {});
  const packager: CloudTaskSnapshotPackager = {
    prepare: vi.fn(async () => ({
      descriptor: {
        version: 1 as const,
        manifest: {} as never,
        archive: {
          format: 'clodex-snapshot-v1' as const,
          path: '/tmp/snapshot.enc',
          sizeBytes: 1,
          sha256: '0'.repeat(64),
        },
        encryption: {
          algorithm: 'aes-256-gcm' as const,
          nonce: 'nonce',
          authTag: 'tag',
          wrappedDataKey: {
            algorithm: 'test',
            keyId: 'test-key',
            value: 'wrapped',
          },
        },
        signature: {
          algorithm: 'test',
          keyId: 'test-key',
          value: 'signature',
        },
      },
      cleanup,
    })),
  };
  return { packager, cleanup };
}

describe('ExecutionTargetRouter', () => {
  it('keeps local as the default and preserves the options object', async () => {
    const local = createExecutor();
    const audit = vi.fn();
    const router = new ExecutionTargetRouter({
      localExecutor: local.executor,
      isCloudEnabled: () => false,
      isLocalExecutionAllowed: () => true,
      createTaskId: () => 'task-local',
      now: sequenceClock(),
      audit,
    });
    const request = createRequest();

    const execution = await router.execute(request);
    await collectStream(execution.toUIMessageStream());

    expect(local.executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        options: request.options,
        context: expect.objectContaining({
          executionTarget: 'local',
          executionTaskId: 'task-local',
        }),
      }),
    );
    expect(router.getTask('task-local')).toMatchObject({
      target: 'local',
      status: 'completed',
      startedAt: expect.any(Number),
      finishedAt: expect.any(Number),
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'selected',
        target: 'local',
        status: 'queued',
      }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('hello');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('agent-1');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('trace-1');
  });

  it('keeps the router outermost for an admitted automatic Swarm turn', async () => {
    const ordinary = createExecutor();
    const automaticExecution = Object.assign(
      createExecution([
        { type: 'text-delta', id: 'swarm', delta: 'done' },
        { type: 'finish' },
      ]),
      { modelRouteBinding: 'external' as const },
    );
    const handler = vi.fn(async () => automaticExecution);
    const localWithAutomaticSwarm = createAutomaticSwarmStepExecutor({
      delegate: ordinary.executor,
      getHandler: () => handler,
    });
    const audit = vi.fn();
    const router = new ExecutionTargetRouter({
      localExecutor: localWithAutomaticSwarm,
      isCloudEnabled: () => false,
      isLocalExecutionAllowed: () => true,
      createTaskId: () => 'task-ultra',
      now: sequenceClock(),
      audit,
    });

    const execution = await router.execute(createRequest('local'));
    expect(execution.modelRouteBinding).toBe('external');
    await collectStream(execution.toUIMessageStream());

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          executionTarget: 'local',
          executionTaskId: 'task-ultra',
        }),
      }),
    );
    expect(ordinary.executor.execute).not.toHaveBeenCalled();
    expect(router.getTask('task-ultra')).toMatchObject({
      target: 'local',
      status: 'completed',
      finishedAt: expect.any(Number),
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'transition',
        target: 'local',
        status: 'completed',
      }),
    );
  });

  it('marks an admitted automatic Swarm failure as failed', async () => {
    const ordinary = createExecutor();
    const failure = new Error('automatic Swarm failed');
    const abortController = new AbortController();
    const onError = vi.fn(() => abortController.abort());
    const request = createRequest('local', abortController.signal);
    request.options = { ...request.options, onError };
    const handler = vi.fn(async (routedRequest: AgentStepExecutionRequest) =>
      createAutomaticSwarmStepExecution({
        request: routedRequest,
        run: async () => {
          throw failure;
        },
      }),
    );
    const router = new ExecutionTargetRouter({
      localExecutor: createAutomaticSwarmStepExecutor({
        delegate: ordinary.executor,
        getHandler: () => handler,
      }),
      isCloudEnabled: () => false,
      isLocalExecutionAllowed: () => true,
      createTaskId: () => 'task-ultra-failed',
      now: sequenceClock(),
    });

    const execution = await router.execute(request);
    const uiStream = execution.toUIMessageStream();
    const [chunks] = await Promise.all([
      collectStream(uiStream),
      execution.consumeStream(),
    ]);

    expect(chunks).toEqual([
      expect.objectContaining({
        type: 'error',
        errorText: failure.message,
      }),
    ]);
    expect(onError).toHaveBeenCalledWith({ error: failure });
    expect(abortController.signal.aborted).toBe(true);
    expect(ordinary.executor.execute).not.toHaveBeenCalled();
    expect(router.getTask('task-ultra-failed')).toMatchObject({
      target: 'local',
      status: 'failed',
      failureReason: 'execution-error',
      finishedAt: expect.any(Number),
    });
  });

  it('rejects local execution while cloud holds the agent lease', async () => {
    const local = createExecutor();
    const router = new ExecutionTargetRouter({
      localExecutor: local.executor,
      isCloudEnabled: () => true,
      isLocalExecutionAllowed: (agentInstanceId) =>
        agentInstanceId !== 'agent-1',
      createTaskId: () => 'task-local-fenced',
      now: sequenceClock(),
    });

    await expect(router.execute(createRequest('local'))).rejects.toBeInstanceOf(
      CloudExecutionLeaseConflictError,
    );
    expect(local.executor.execute).not.toHaveBeenCalled();
    expect(router.getTask('task-local-fenced')).toMatchObject({
      status: 'failed',
      failureReason: 'lease-conflict',
    });
  });

  it('fails closed when cloud is requested while the gate is disabled', async () => {
    const local = createExecutor();
    const cloud = createCloudAdapter(createExecution());
    const router = new ExecutionTargetRouter({
      localExecutor: local.executor,
      cloudAdapter: cloud,
      isCloudEnabled: () => false,
      createTaskId: () => 'task-cloud',
      now: sequenceClock(),
    });

    await expect(router.execute(createRequest('cloud'))).rejects.toMatchObject({
      name: 'CloudExecutionTargetUnavailableError',
      reason: 'gate-disabled',
    });
    expect(local.executor.execute).not.toHaveBeenCalled();
    expect(cloud.execute).not.toHaveBeenCalled();
    expect(router.getTask('task-cloud')).toMatchObject({
      target: 'cloud',
      status: 'failed',
      failureReason: 'gate-disabled',
    });
  });

  it('does not fall back locally when the cloud adapter is unavailable', async () => {
    const local = createExecutor();
    const router = new ExecutionTargetRouter({
      localExecutor: local.executor,
      isCloudEnabled: () => true,
      createTaskId: () => 'task-cloud',
      now: sequenceClock(),
    });

    await expect(router.execute(createRequest('cloud'))).rejects.toBeInstanceOf(
      CloudExecutionTargetUnavailableError,
    );
    expect(local.executor.execute).not.toHaveBeenCalled();
    expect(router.getTask('task-cloud')?.failureReason).toBe(
      'adapter-unavailable',
    );
  });

  it('routes an enabled cloud task and records completion', async () => {
    const local = createExecutor();
    const cloudExecution = createExecution([
      { type: 'text-delta', id: 'text-1', delta: 'ok' },
      { type: 'finish' },
    ]);
    const cloud = createCloudAdapter(cloudExecution);
    const snapshot = createSnapshotPackager();
    const router = new ExecutionTargetRouter({
      localExecutor: local.executor,
      cloudAdapter: cloud,
      snapshotPackager: snapshot.packager,
      isCloudEnabled: () => true,
      createTaskId: () => 'task-cloud',
      now: sequenceClock(),
    });
    const request = createRequest('cloud');

    const execution = await router.execute(request);
    const chunks = await collectStream(execution.toUIMessageStream());

    expect(chunks).toHaveLength(2);
    expect(snapshot.packager.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-cloud',
        agentInstanceId: 'agent-1',
        selection: request.context.snapshotSelection,
      }),
    );
    expect(cloud.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        options: request.options,
        context: expect.objectContaining({
          executionTarget: 'cloud',
          executionTaskId: 'task-cloud',
          metadata: expect.objectContaining({
            cloudSnapshot: expect.objectContaining({ version: 1 }),
          }),
        }),
      }),
    );
    expect(snapshot.cleanup).toHaveBeenCalledOnce();
    expect(local.executor.execute).not.toHaveBeenCalled();
    expect(router.getTask('task-cloud')?.status).toBe('completed');
  });

  it('fails closed when cloud snapshot packaging is unavailable', async () => {
    const local = createExecutor();
    const cloud = createCloudAdapter(createExecution());
    const router = new ExecutionTargetRouter({
      localExecutor: local.executor,
      cloudAdapter: cloud,
      isCloudEnabled: () => true,
      createTaskId: () => 'task-cloud',
      now: sequenceClock(),
    });

    await expect(router.execute(createRequest('cloud'))).rejects.toBeInstanceOf(
      CloudExecutionSnapshotPreparationError,
    );
    expect(cloud.execute).not.toHaveBeenCalled();
    expect(local.executor.execute).not.toHaveBeenCalled();
    expect(router.getTask('task-cloud')).toMatchObject({
      target: 'cloud',
      status: 'failed',
      failureReason: 'snapshot-unavailable',
    });
  });

  it('marks an aborted task as cancelled', async () => {
    const local = createExecutor(
      createExecution([{ type: 'abort', reason: 'cancelled' }]),
    );
    const controller = new AbortController();
    const router = new ExecutionTargetRouter({
      localExecutor: local.executor,
      isCloudEnabled: () => false,
      isLocalExecutionAllowed: () => true,
      createTaskId: () => 'task-abort',
      now: sequenceClock(),
    });

    const execution = await router.execute(
      createRequest('local', controller.signal),
    );
    controller.abort();
    await collectStream(execution.toUIMessageStream());

    expect(router.getTask('task-abort')).toMatchObject({
      status: 'cancelled',
      failureReason: null,
    });
  });

  it('records timeout separately from user cancellation', async () => {
    const timeoutExecution: AgentStepExecution = {
      consumeStream: (options) => {
        options?.onError?.(
          new DOMException('Agent step timed out after 1000ms', 'AbortError'),
        );
        return Promise.resolve();
      },
      toUIMessageStream: vi.fn(() => createStream([]) as never),
    };
    const local = createExecutor(timeoutExecution);
    const router = new ExecutionTargetRouter({
      localExecutor: local.executor,
      isCloudEnabled: () => false,
      isLocalExecutionAllowed: () => true,
      createTaskId: () => 'task-timeout',
      now: sequenceClock(),
    });

    const execution = await router.execute(createRequest());
    await execution.consumeStream();

    expect(router.getTask('task-timeout')).toMatchObject({
      status: 'failed',
      failureReason: 'timeout',
    });
  });

  it('keeps only the bounded recent task ledger', async () => {
    const local = createExecutor();
    let task = 0;
    const router = new ExecutionTargetRouter({
      localExecutor: local.executor,
      isCloudEnabled: () => false,
      isLocalExecutionAllowed: () => true,
      createTaskId: () => `task-${++task}`,
      now: sequenceClock(),
      maxRecentTasks: 2,
    });

    for (let run = 0; run < 3; run += 1) {
      const execution = await router.execute(createRequest());
      await collectStream(execution.toUIMessageStream());
    }

    expect(router.listRecentTasks().map((item) => item.id)).toEqual([
      'task-2',
      'task-3',
    ]);
  });
});

function sequenceClock(): () => number {
  let now = 0;
  return () => ++now;
}

function createStream(
  chunks: unknown[],
): AsyncIterableStream<InferUIMessageChunk<UIMessage>> {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk as InferUIMessageChunk<UIMessage>);
      }
      controller.close();
    },
  }) as AsyncIterableStream<InferUIMessageChunk<UIMessage>>;
  (
    stream as unknown as {
      [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
    }
  )[Symbol.asyncIterator] = () => {
    const reader = stream.getReader();
    return {
      async next() {
        const result = await reader.read();
        if (result.done) reader.releaseLock();
        return result;
      },
    };
  };
  return stream;
}

async function collectStream<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
