import type {
  AgentStepExecutionRequest,
  AgentStepExecutor,
} from '@clodex/agent-core/agents';
import type {
  AgentStepRuntimeTelemetryEvents,
  AgentStepRuntimeTelemetrySink,
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

let service: AgentHostProcessService | null = null;

type RuntimeTelemetryEvent = {
  [EVENT_NAME in keyof AgentStepRuntimeTelemetryEvents]: {
    eventName: EVENT_NAME;
    properties: AgentStepRuntimeTelemetryEvents[EVENT_NAME];
  };
}[keyof AgentStepRuntimeTelemetryEvents];

try {
  app.disableHardwareAcceleration();
  await app.whenReady();

  service = await AgentHostProcessService.create(logger, {
    workerPath,
    readyTimeoutMs: 10_000,
  });

  const workerPid = service.pid;
  assert(service.canExecuteAgentWorkloads, 'utility process is not ready');
  assert(
    typeof workerPid === 'number' && workerPid > 0,
    'utility process did not expose a PID',
  );
  assert(
    workerPid !== process.pid,
    'agent host did not use a separate process',
  );

  let toolCalls = 0;
  let localFallbacks = 0;
  const callbackErrors: string[] = [];
  const telemetryEvents: RuntimeTelemetryEvent[] = [];

  const telemetry: AgentStepRuntimeTelemetrySink = {
    capture<T extends keyof AgentStepRuntimeTelemetryEvents>(
      eventName: T,
      properties: AgentStepRuntimeTelemetryEvents[T],
    ) {
      telemetryEvents.push({ eventName, properties } as RuntimeTelemetryEvent);
    },
  };
  const localExecutor: AgentStepExecutor = {
    async execute() {
      localFallbacks += 1;
      throw new Error('smoke request unexpectedly fell back locally');
    },
  };
  const streamTextFn = (() => ({
    fullStream: createStream([
      {
        type: 'text-delta',
        id: 'smoke-text',
        text: 'Inspecting.',
      },
      {
        type: 'tool-call',
        toolCallId: 'smoke-tool-call',
        toolName: 'read',
        input: {
          path: 'README.md',
        },
      },
      {
        type: 'finish-step',
        response: {
          id: 'smoke-response',
          timestamp: new Date(),
          modelId: 'smoke-model',
        },
        usage: usage(7, 2),
        finishReason: 'tool-calls',
        rawFinishReason: 'tool_calls',
      },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        rawFinishReason: 'tool_calls',
        totalUsage: usage(7, 2),
      },
    ]),
  })) as unknown as typeof import('ai').streamText;

  const request: AgentStepExecutionRequest = {
    context: {
      agentInstanceId: 'smoke-agent',
      agentType: 'chat',
      traceId: 'smoke-trace',
      requestedModelId: 'smoke-model',
      resolvedModelId: 'smoke-model',
      isApprovalContinuation: false,
      metadata: {
        purpose: 'agent-host-smoke',
      },
    },
    options: {
      model: {
        provider: 'smoke',
        modelId: 'smoke-model',
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
          execute: async ({ path: requestedPath }) => {
            toolCalls += 1;
            assert(
              requestedPath === 'README.md',
              'tool input changed across utility-process RPC',
            );
            return 'SMOKE_TOOL_OK';
          },
        }),
      },
      onError: ({ error }) => {
        callbackErrors.push(
          error instanceof Error ? error.message : String(error),
        );
      },
    },
  };

  const executor = new BrowserAgentStepExecutor({
    process: service,
    logger,
    isEnabled: () => true,
    telemetry,
    localExecutor,
    streamTextFn,
  });
  const execution = await executor.execute(request);
  const [chunks] = await Promise.all([
    collectStream(
      execution.toUIMessageStream({
        generateMessageId: () => 'smoke-message',
      }),
    ),
    execution.consumeStream(),
  ]);

  assert(localFallbacks === 0, 'compatible step used the local executor');
  assert(toolCalls === 1, `expected one tool call, received ${toolCalls}`);
  assert(callbackErrors.length === 0, callbackErrors.join('; '));
  assert(
    chunks.some((chunk) => chunk.type === 'start-step'),
    'UI stream did not start an isolated step',
  );
  assert(
    chunks.some(
      (chunk) =>
        chunk.type === 'tool-output-available' &&
        chunk.toolCallId === 'smoke-tool-call' &&
        chunk.output === 'SMOKE_TOOL_OK',
    ),
    'UI stream did not contain the tool output',
  );
  assert(
    chunks.some(
      (chunk) => chunk.type === 'finish' && chunk.finishReason === 'tool-calls',
    ),
    'UI stream did not finish successfully',
  );
  assert(
    telemetryEvents.some(
      (event) =>
        event.eventName === 'agent-step-runtime-selected' &&
        event.properties.runtime === 'isolated' &&
        event.properties.reason === 'compatible',
    ),
    'isolated selection telemetry was not emitted',
  );
  assert(
    telemetryEvents.some(
      (event) =>
        event.eventName === 'agent-step-runtime-finished' &&
        event.properties.outcome === 'completed',
    ),
    'isolated completion telemetry was not emitted',
  );

  await service.teardown();
  service = null;
  console.log(
    `AGENT_STEP_EXECUTOR_SMOKE ready=true workerPid=${workerPid} toolCalls=${toolCalls} localFallbacks=${localFallbacks} exit=0`,
  );
  app.exit(0);
} catch (error) {
  if (service) {
    await service.teardown().catch(() => {});
  }
  console.error(
    'AGENT_STEP_EXECUTOR_SMOKE ready=false exit=1',
    error instanceof Error ? error.stack : error,
  );
  app.exit(1);
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
