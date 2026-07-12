import type {
  AgentStepExecutionRequest,
  AgentStepExecutor,
} from '@clodex/agent-core/agents';
import type {
  AgentStepRuntimeTelemetryEvents,
  AgentStepRuntimeTelemetrySink,
} from '@shared/agent-runtime-telemetry';
import { tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BrowserAgentStepExecutor } from './browser-agent-step-executor';
import { executeIsolatedAgentTurn } from './isolated-agent-turn-runtime';
import type {
  AgentTurnHostHandlers,
  IsolatedAgentTurnEvent,
  IsolatedAgentTurnRequest,
} from './isolated-agent-turn';

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
};

function createRequest(
  overrides: Partial<AgentStepExecutionRequest['options']> = {},
): AgentStepExecutionRequest {
  const options = {
    model: {
      provider: 'test-provider',
      modelId: 'routed-model',
    } as never,
    messages: [
      {
        role: 'system' as const,
        content: 'Use tools when needed.',
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: 'ephemeral',
            },
          },
          openaiCompatible: {
            cache_control: {
              type: 'ephemeral',
            },
          },
        },
      },
      {
        role: 'user' as const,
        content: 'Read README.md',
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: 'ephemeral',
            },
          },
          openaiCompatible: {
            cache_control: {
              type: 'ephemeral',
            },
          },
        },
      },
    ],
    tools: {
      read: tool({
        inputSchema: z.object({
          path: z.string(),
        }),
        execute: vi.fn(async () => '# Project'),
      }),
    },
  } satisfies AgentStepExecutionRequest['options'];

  return {
    context: {
      agentInstanceId: 'agent-1',
      agentType: 'chat',
      traceId: 'trace-1',
      requestedModelId: 'selected-model',
      resolvedModelId: 'routed-model',
      isApprovalContinuation: false,
      metadata: {
        purpose: 'test',
      },
    },
    options: {
      ...options,
      ...overrides,
    } as AgentStepExecutionRequest['options'],
  };
}

function createInMemoryProcess() {
  return {
    canExecuteAgentWorkloads: true,
    executeAgentTurn: vi.fn(
      async (
        request: IsolatedAgentTurnRequest,
        options: {
          signal?: AbortSignal;
          onEvent?: (event: IsolatedAgentTurnEvent) => void;
          handlers?: AgentTurnHostHandlers;
        },
      ) => {
        if (!options.handlers) throw new Error('missing handlers');
        return await executeIsolatedAgentTurn(request, {
          signal: options.signal,
          handlers: options.handlers,
          onEvent: options.onEvent,
        });
      },
    ),
  };
}

function createLocalExecutor() {
  const execution = {
    consumeStream: vi.fn(async () => {}),
    toUIMessageStream: vi.fn(),
  };
  const executor: AgentStepExecutor = {
    execute: vi.fn(() => execution as never),
  };
  return { executor, execution };
}

function createTelemetry() {
  const capture = vi.fn();
  const telemetry: AgentStepRuntimeTelemetrySink = {
    capture<T extends keyof AgentStepRuntimeTelemetryEvents>(
      eventName: T,
      properties: AgentStepRuntimeTelemetryEvents[T],
    ) {
      capture(eventName, properties);
    },
  };
  return { telemetry, capture };
}

describe('BrowserAgentStepExecutor', () => {
  it('keeps the local executor as the default path when the gate is off', async () => {
    const local = createLocalExecutor();
    const telemetry = createTelemetry();
    const request = createRequest();
    const executor = new BrowserAgentStepExecutor({
      process: createInMemoryProcess(),
      logger,
      isEnabled: () => false,
      telemetry: telemetry.telemetry,
      localExecutor: local.executor,
    });

    await expect(executor.execute(request)).resolves.toBe(local.execution);
    expect(local.executor.execute).toHaveBeenCalledWith(request);
    expect(telemetry.capture).toHaveBeenCalledWith(
      'agent-step-runtime-selected',
      expect.objectContaining({
        agent_type: 'chat',
        model_id: 'routed-model',
        runtime: 'local',
        reason: 'gate-disabled',
        preparation_duration_ms: expect.any(Number),
      }),
    );
  });

  it('honors the emergency kill switch before remote preparation', async () => {
    const local = createLocalExecutor();
    const telemetry = createTelemetry();
    const process = createInMemoryProcess();
    const request = createRequest();
    const executor = new BrowserAgentStepExecutor({
      process,
      logger,
      isEnabled: () => true,
      isKillSwitchActive: () => true,
      telemetry: telemetry.telemetry,
      localExecutor: local.executor,
    });

    await expect(executor.execute(request)).resolves.toBe(local.execution);
    expect(process.executeAgentTurn).not.toHaveBeenCalled();
    expect(telemetry.capture).toHaveBeenCalledWith(
      'agent-step-runtime-selected',
      expect.objectContaining({
        runtime: 'local',
        reason: 'kill-switch-active',
      }),
    );
  });

  it('falls back before dispatch for unsupported multimodal messages', async () => {
    const local = createLocalExecutor();
    const telemetry = createTelemetry();
    const process = createInMemoryProcess();
    const request = createRequest({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              image: new Uint8Array([1, 2, 3]),
            },
          ],
        },
      ],
    });
    const executor = new BrowserAgentStepExecutor({
      process,
      logger,
      isEnabled: () => true,
      telemetry: telemetry.telemetry,
      localExecutor: local.executor,
    });

    await expect(executor.execute(request)).resolves.toBe(local.execution);
    expect(process.executeAgentTurn).not.toHaveBeenCalled();
    expect(local.executor.execute).toHaveBeenCalledOnce();
    expect(telemetry.capture).toHaveBeenCalledWith(
      'agent-step-runtime-selected',
      expect.objectContaining({
        runtime: 'local',
        reason: 'unsupported-multimodal-content',
      }),
    );
  });

  it('runs a compatible model/tool step through the utility-process contract', async () => {
    const process = createInMemoryProcess();
    const telemetry = createTelemetry();
    const request = createRequest({
      onFinish: vi.fn(),
    });
    const streamTextFn = vi.fn(() => ({
      fullStream: createStream([
        {
          type: 'text-delta',
          id: 'text-1',
          text: 'Checking.',
        },
        {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'read',
          input: {
            path: 'README.md',
          },
        },
        {
          type: 'finish-step',
          response: {
            id: 'response-1',
            timestamp: new Date(),
            modelId: 'routed-model',
          },
          usage: emptyUsage(12, 3),
          finishReason: 'tool-calls',
          rawFinishReason: 'tool_calls',
          providerMetadata: {
            test: {
              route: 'isolated',
            },
          },
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          rawFinishReason: 'tool_calls',
          totalUsage: emptyUsage(12, 3),
        },
      ]),
    })) as unknown as typeof import('ai').streamText;
    const local = createLocalExecutor();
    const executor = new BrowserAgentStepExecutor({
      process,
      logger,
      isEnabled: () => true,
      telemetry: telemetry.telemetry,
      localExecutor: local.executor,
      streamTextFn,
    });

    const execution = await executor.execute(request);
    const uiStream = execution.toUIMessageStream({
      generateMessageId: () => 'message-1',
    });
    const [chunks] = await Promise.all([
      collectStream(uiStream),
      execution.consumeStream(),
    ]);

    expect(chunks).toEqual([
      {
        type: 'start',
        messageId: 'message-1',
      },
      {
        type: 'start-step',
      },
      {
        type: 'text-start',
        id: 'isolated-text-1',
      },
      {
        type: 'text-delta',
        id: 'isolated-text-1',
        delta: 'Checking.',
      },
      {
        type: 'text-end',
        id: 'isolated-text-1',
      },
      {
        type: 'tool-input-available',
        toolCallId: 'tool-1',
        toolName: 'read',
        input: {
          path: 'README.md',
        },
      },
      {
        type: 'tool-output-available',
        toolCallId: 'tool-1',
        output: '# Project',
      },
      {
        type: 'finish-step',
      },
      {
        type: 'finish',
        finishReason: 'tool-calls',
      },
    ]);
    expect(process.executeAgentTurn).toHaveBeenCalledOnce();
    expect(local.executor.execute).not.toHaveBeenCalled();
    expect(request.options.onFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        finishReason: 'tool-calls',
        toolCalls: [
          expect.objectContaining({
            toolCallId: 'tool-1',
            toolName: 'read',
          }),
        ],
        toolResults: [
          expect.objectContaining({
            toolCallId: 'tool-1',
            output: '# Project',
          }),
        ],
      }),
    );
    expect(
      (request.options.tools as Record<string, { execute?: unknown }>).read
        ?.execute,
    ).toHaveBeenCalledOnce();
    expect(telemetry.capture).toHaveBeenCalledWith(
      'agent-step-runtime-selected',
      expect.objectContaining({
        runtime: 'isolated',
        reason: 'compatible',
      }),
    );
    expect(telemetry.capture).toHaveBeenCalledWith(
      'agent-step-runtime-finished',
      expect.objectContaining({
        runtime: 'isolated',
        outcome: 'completed',
        duration_ms: expect.any(Number),
      }),
    );
  });

  it('streams an approval request without executing the guarded tool', async () => {
    const process = createInMemoryProcess();
    const execute = vi.fn();
    const request = createRequest({
      tools: {
        read: tool({
          inputSchema: z.object({
            path: z.string(),
          }),
          needsApproval: true,
          execute,
        }),
      },
    });
    const streamTextFn = vi.fn(() => ({
      fullStream: createStream([
        {
          type: 'tool-call',
          toolCallId: 'tool-approval',
          toolName: 'read',
          input: {
            path: 'secrets.txt',
          },
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          rawFinishReason: 'tool_calls',
          totalUsage: emptyUsage(8, 2),
        },
      ]),
    })) as unknown as typeof import('ai').streamText;
    const executor = new BrowserAgentStepExecutor({
      process,
      logger,
      isEnabled: () => true,
      streamTextFn,
    });

    const execution = await executor.execute(request);
    const chunks = await collectStream(execution.toUIMessageStream());

    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'tool-approval-request',
        toolCallId: 'tool-approval',
        approvalId: expect.any(String),
      }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not replay a dispatched step locally after a worker failure', async () => {
    const local = createLocalExecutor();
    const telemetry = createTelemetry();
    const process = {
      canExecuteAgentWorkloads: true,
      executeAgentTurn: vi.fn(async () => {
        throw new Error('worker exited; turn was not replayed');
      }),
    };
    const onError = vi.fn();
    const request = createRequest({ onError });
    const executor = new BrowserAgentStepExecutor({
      process,
      logger,
      isEnabled: () => true,
      telemetry: telemetry.telemetry,
      localExecutor: local.executor,
      streamTextFn: vi.fn() as never,
    });

    const execution = await executor.execute(request);
    const uiStream = execution.toUIMessageStream();
    const [chunks] = await Promise.all([
      collectStream(uiStream),
      execution.consumeStream(),
    ]);

    expect(chunks).toContainEqual({
      type: 'error',
      errorText: 'worker exited; turn was not replayed',
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(local.executor.execute).not.toHaveBeenCalled();
    expect(telemetry.capture).toHaveBeenCalledWith(
      'agent-step-runtime-finished',
      expect.objectContaining({
        outcome: 'failed',
      }),
    );
  });

  it('quarantines repeated failures and recovers through one half-open probe', async () => {
    let now = 0;
    let attempts = 0;
    const healthyProcess = createInMemoryProcess();
    const process = {
      canExecuteAgentWorkloads: true,
      executeAgentTurn: vi.fn(
        async (
          request: IsolatedAgentTurnRequest,
          options: {
            signal?: AbortSignal;
            onEvent?: (event: IsolatedAgentTurnEvent) => void;
            handlers?: AgentTurnHostHandlers;
          },
        ) => {
          attempts += 1;
          if (attempts <= 2) {
            throw new Error(`isolated failure ${attempts}`);
          }
          return await healthyProcess.executeAgentTurn(request, options);
        },
      ),
    };
    const local = createLocalExecutor();
    const telemetry = createTelemetry();
    const streamTextFn = vi.fn(() => ({
      fullStream: createStream([
        {
          type: 'finish-step',
          response: {
            id: 'recovery-response',
            timestamp: new Date(),
            modelId: 'routed-model',
          },
          usage: emptyUsage(4, 1),
          finishReason: 'stop',
          rawFinishReason: 'stop',
        },
        {
          type: 'finish',
          finishReason: 'stop',
          rawFinishReason: 'stop',
          totalUsage: emptyUsage(4, 1),
        },
      ]),
    })) as unknown as typeof import('ai').streamText;
    const executor = new BrowserAgentStepExecutor({
      process,
      logger,
      isEnabled: () => true,
      telemetry: telemetry.telemetry,
      circuitBreaker: {
        failureThreshold: 2,
        cooldownMs: 1_000,
        now: () => now,
      },
      localExecutor: local.executor,
      streamTextFn,
    });

    for (let failure = 0; failure < 2; failure += 1) {
      const execution = await executor.execute(createRequest());
      await Promise.all([
        collectStream(execution.toUIMessageStream()),
        execution.consumeStream(),
      ]);
    }

    const quarantined = await executor.execute(createRequest());
    expect(quarantined).toBe(local.execution);
    expect(process.executeAgentTurn).toHaveBeenCalledTimes(2);
    expect(telemetry.capture).toHaveBeenCalledWith(
      'agent-step-runtime-selected',
      expect.objectContaining({
        runtime: 'local',
        reason: 'circuit-breaker-open',
      }),
    );
    expect(telemetry.capture).toHaveBeenCalledWith(
      'agent-step-runtime-circuit-breaker',
      expect.objectContaining({
        state: 'open',
        trigger: 'failure-threshold',
        consecutive_failures: 2,
      }),
    );

    now = 1_000;
    const probe = await executor.execute(createRequest());
    await Promise.all([
      collectStream(probe.toUIMessageStream()),
      probe.consumeStream(),
    ]);
    const recovered = await executor.execute(createRequest());
    await Promise.all([
      collectStream(recovered.toUIMessageStream()),
      recovered.consumeStream(),
    ]);

    expect(process.executeAgentTurn).toHaveBeenCalledTimes(4);
    expect(local.executor.execute).toHaveBeenCalledOnce();
    expect(telemetry.capture).toHaveBeenCalledWith(
      'agent-step-runtime-circuit-breaker',
      expect.objectContaining({
        state: 'half-open',
        trigger: 'cooldown-elapsed',
      }),
    );
    expect(telemetry.capture).toHaveBeenCalledWith(
      'agent-step-runtime-circuit-breaker',
      expect.objectContaining({
        state: 'closed',
        trigger: 'probe-succeeded',
      }),
    );
  });

  it('records an aborted isolated step without replaying it locally', async () => {
    const local = createLocalExecutor();
    const telemetry = createTelemetry();
    const process = {
      canExecuteAgentWorkloads: true,
      executeAgentTurn: vi.fn(async () => {
        throw new DOMException('cancelled by smoke', 'AbortError');
      }),
    };
    const onAbort = vi.fn();
    const request = createRequest({ onAbort });
    const executor = new BrowserAgentStepExecutor({
      process,
      logger,
      isEnabled: () => true,
      telemetry: telemetry.telemetry,
      localExecutor: local.executor,
      streamTextFn: vi.fn() as never,
    });

    const execution = await executor.execute(request);
    const [chunks] = await Promise.all([
      collectStream(execution.toUIMessageStream()),
      execution.consumeStream(),
    ]);

    expect(chunks).toContainEqual({
      type: 'abort',
      reason: 'cancelled by smoke',
    });
    expect(onAbort).toHaveBeenCalledOnce();
    expect(local.executor.execute).not.toHaveBeenCalled();
    expect(telemetry.capture).toHaveBeenCalledWith(
      'agent-step-runtime-finished',
      expect.objectContaining({
        outcome: 'aborted',
      }),
    );
  });
});

function emptyUsage(
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
