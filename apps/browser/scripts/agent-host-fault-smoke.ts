import type {
  AgentStepExecutionRequest,
  AgentStepExecutor,
} from '@clodex/agent-core/agents';
import type { AgentStore, AgentSystemState } from '@clodex/agent-core';
import type {
  AgentHostProcessTelemetryEvents,
  AgentHostProcessTelemetrySink,
} from '@shared/agent-runtime-telemetry';
import { app } from 'electron';
import { tool } from 'ai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BrowserAgentStepExecutor } from '../src/backend/agent-host/browser-agent-step-executor';
import { AgentHostProcessService } from '../src/backend/agent-host/supervisor';
import type { Logger } from '../src/backend/services/logger';

const outputDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(outputDirectory, 'agent-host.cjs');

const logger = {
  debug() {},
  info() {},
  warn(message: unknown, error?: unknown) {
    console.warn(message, error ?? '');
  },
  error(message: unknown, error?: unknown) {
    console.error(message, error ?? '');
  },
} as unknown as Logger;

type LifecycleTelemetryEvent =
  AgentHostProcessTelemetryEvents['agent-host-process-lifecycle'];

let service: AgentHostProcessService | null = null;

try {
  app.disableHardwareAcceleration();
  await app.whenReady();

  const lifecycleEvents: LifecycleTelemetryEvent[] = [];
  const lifecycleTelemetry: AgentHostProcessTelemetrySink = {
    capture(eventName, properties) {
      assert(
        eventName === 'agent-host-process-lifecycle',
        `unexpected lifecycle event ${eventName}`,
      );
      lifecycleEvents.push(properties);
    },
  };

  service = await AgentHostProcessService.create(logger, {
    workerPath,
    readyTimeoutMs: 10_000,
    restartBaseDelayMs: 50,
    heartbeatTimeoutMs: 30_000,
    telemetry: lifecycleTelemetry,
  });
  service.bindAgentStore(createAgentStore());

  const initialPid = service.pid;
  assert(
    typeof initialPid === 'number' && initialPid > 0,
    'utility process did not expose an initial PID',
  );
  assert(
    initialPid !== process.pid,
    'agent host did not use a separate process',
  );

  await waitFor(
    () => service?.syncedRuntimeRevision === 1,
    'initial runtime state synchronization',
  );
  const initialRuntimeSyncCount = service.runtimeSyncCount;

  let localFallbacks = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  const callbackErrors: string[] = [];
  let resolveFirstModelStarted!: () => void;
  const firstModelStarted = new Promise<void>((resolve) => {
    resolveFirstModelStarted = resolve;
  });

  const localExecutor: AgentStepExecutor = {
    async execute() {
      localFallbacks += 1;
      throw new Error('fault smoke unexpectedly fell back locally');
    },
  };
  const streamTextFn = ((options: { abortSignal?: AbortSignal }) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      return {
        fullStream: createBlockedStream(
          options.abortSignal,
          resolveFirstModelStarted,
        ),
      };
    }

    return {
      fullStream: createStream([
        {
          type: 'text-delta',
          id: 'fault-smoke-text',
          text: 'Recovered.',
        },
        {
          type: 'tool-call',
          toolCallId: 'fault-smoke-tool-call',
          toolName: 'read',
          input: {
            path: 'README.md',
          },
        },
        {
          type: 'finish-step',
          response: {
            id: 'fault-smoke-response',
            timestamp: new Date(),
            modelId: 'fault-smoke-model',
          },
          usage: usage(9, 3),
          finishReason: 'tool-calls',
          rawFinishReason: 'tool_calls',
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          rawFinishReason: 'tool_calls',
          totalUsage: usage(9, 3),
        },
      ]),
    };
  }) as unknown as typeof import('ai').streamText;

  const executor = new BrowserAgentStepExecutor({
    process: service,
    logger,
    isEnabled: () => true,
    localExecutor,
    streamTextFn,
  });

  const firstExecution = await executor.execute(
    createRequest(
      'fault-smoke-first',
      () => {
        throw new Error('the pre-crash step must not execute a tool');
      },
      callbackErrors,
    ),
  );
  const firstChunksPromise = collectStream(
    firstExecution.toUIMessageStream({
      generateMessageId: () => 'fault-smoke-first-message',
    }),
  );
  const firstConsumption = Promise.resolve(firstExecution.consumeStream());

  await firstModelStarted;
  assert(process.kill(initialPid, 'SIGKILL'), 'failed to kill utility process');

  const [firstChunks] = await Promise.all([
    firstChunksPromise,
    firstConsumption,
  ]);
  assert(
    firstChunks.some(
      (chunk) =>
        chunk.type === 'error' &&
        chunk.errorText.includes('turn was not replayed'),
    ),
    'crashed isolated step did not report the no-replay error',
  );
  assert(
    localFallbacks === 0,
    'dispatched step was replayed through the local executor',
  );
  assert(
    callbackErrors.some((message) => message.includes('turn was not replayed')),
    'step onError callback did not receive the crash error',
  );

  await waitFor(
    () =>
      service?.processStatus === 'ready' &&
      typeof service.pid === 'number' &&
      service.pid !== initialPid,
    'utility-process restart with a new PID',
  );
  const restartedPid = service.pid;
  await waitFor(
    () =>
      (service?.runtimeSyncCount ?? 0) > initialRuntimeSyncCount &&
      service?.syncedRuntimeRevision === 1,
    'runtime state resynchronization after restart',
  );

  const secondExecution = await executor.execute(
    createRequest(
      'fault-smoke-second',
      (requestedPath) => {
        toolCalls += 1;
        assert(
          requestedPath === 'README.md',
          'tool input changed after utility-process recovery',
        );
        return 'FAULT_SMOKE_TOOL_OK';
      },
      callbackErrors,
    ),
  );
  const [secondChunks] = await Promise.all([
    collectStream(
      secondExecution.toUIMessageStream({
        generateMessageId: () => 'fault-smoke-second-message',
      }),
    ),
    Promise.resolve(secondExecution.consumeStream()),
  ]);

  assert(modelCalls === 2, `expected two model calls, received ${modelCalls}`);
  assert(
    toolCalls === 1,
    `expected one recovered tool call, received ${toolCalls}`,
  );
  assert(localFallbacks === 0, 'recovered step used the local executor');
  assert(
    secondChunks.some(
      (chunk) =>
        chunk.type === 'tool-output-available' &&
        chunk.toolCallId === 'fault-smoke-tool-call' &&
        chunk.output === 'FAULT_SMOKE_TOOL_OK',
    ),
    'recovered UI stream did not contain the tool output',
  );
  assert(
    secondChunks.some(
      (chunk) => chunk.type === 'finish' && chunk.finishReason === 'tool-calls',
    ),
    'recovered isolated step did not finish successfully',
  );

  for (const phase of [
    'worker-crashed',
    'restart-scheduled',
    'restart-succeeded',
  ] as const) {
    assert(
      lifecycleEvents.some((event) => event.phase === phase),
      `missing lifecycle telemetry phase ${phase}`,
    );
  }
  assert(
    !/prompt|message|tool|trace|agent[_-]?instance/i.test(
      JSON.stringify(lifecycleEvents),
    ),
    'lifecycle telemetry contained a forbidden content field',
  );

  await service.teardown();
  service = null;
  console.log(
    `AGENT_HOST_FAULT_SMOKE crashed=true restarted=${restartedPid !== initialPid} resynced=true localFallbacks=${localFallbacks} exit=0`,
  );
  app.exit(0);
} catch (error) {
  if (service) {
    await service.teardown().catch(() => {});
  }
  console.error(
    'AGENT_HOST_FAULT_SMOKE crashed=false restarted=false resynced=false exit=1',
    error instanceof Error ? error.stack : error,
  );
  app.exit(1);
}

function createRequest(
  purpose: string,
  executeTool: (path: string) => unknown | Promise<unknown>,
  callbackErrors: string[],
): AgentStepExecutionRequest {
  return {
    context: {
      agentInstanceId: 'fault-smoke-agent',
      agentType: 'chat',
      traceId: `fault-smoke-trace-${purpose}`,
      requestedModelId: 'fault-smoke-model',
      resolvedModelId: 'fault-smoke-model',
      isApprovalContinuation: false,
      metadata: {
        purpose,
      },
    },
    options: {
      model: {
        provider: 'fault-smoke',
        modelId: 'fault-smoke-model',
      } as never,
      messages: [
        {
          role: 'system',
          content: 'Use the provided read tool.',
        },
        {
          role: 'user',
          content: 'Inspect the project readme.',
        },
      ],
      tools: {
        read: tool({
          inputSchema: z.object({
            path: z.string(),
          }),
          execute: async ({ path: requestedPath }) =>
            await executeTool(requestedPath),
        }),
      },
      onError: ({ error }) => {
        callbackErrors.push(
          error instanceof Error ? error.message : String(error),
        );
      },
    },
  };
}

function createAgentStore(): AgentStore {
  const state = {
    agents: {
      instances: {
        'fault-smoke-agent': {
          type: 'chat',
          parentAgentInstanceId: null,
          state: {
            isWorking: true,
            history: [
              {
                id: 'fault-smoke-message',
                role: 'user',
                content: [{ type: 'text', text: 'private smoke prompt' }],
              },
            ],
            queuedMessages: [],
          },
        },
      },
    },
    toolbox: {},
  } as unknown as AgentSystemState;

  return {
    get: () => state,
    subscribe: () => () => {},
  } as unknown as AgentStore;
}

function usage(
  inputTokens: number,
  outputTokens: number,
): import('ai').LanguageModelUsage {
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokens,
    outputTokenDetails: {
      textTokens: outputTokens,
      reasoningTokens: 0,
    },
    totalTokens: inputTokens + outputTokens,
  };
}

function createBlockedStream(
  signal: AbortSignal | undefined,
  onStarted: () => void,
): AsyncIterable<never> {
  return {
    async *[Symbol.asyncIterator]() {
      onStarted();
      if (signal?.aborted) throw createAbortError(signal);
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(createAbortError(signal)),
          { once: true },
        );
      });
    },
  };
}

function createAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('fault smoke model call aborted', 'AbortError');
}

function createStream<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

async function collectStream<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
