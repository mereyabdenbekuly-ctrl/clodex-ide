import type { AgentStore, AgentSystemState } from '@clodex/agent-core';
import type {
  AgentHostProcessTelemetryEvents,
  AgentHostProcessTelemetrySink,
} from '@shared/agent-runtime-telemetry';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../services/logger';
import {
  AGENT_HOST_PROTOCOL_VERSION,
  type AgentHostToMainMessage,
  type MainToAgentHostMessage,
  type OpenManusExecutionRequest,
} from './protocol';
import type {
  AgentTurnHostHandlers,
  IsolatedAgentTurnRequest,
  IsolatedAgentTurnResult,
} from './isolated-agent-turn';

const electronMocks = vi.hoisted(() => ({
  fork: vi.fn(),
}));

vi.mock('electron', () => ({
  utilityProcess: {
    fork: electronMocks.fork,
  },
}));

import {
  AgentHostProcessService,
  type AgentHostProcessOptions,
} from './supervisor';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const openManusRequest: OpenManusExecutionRequest = {
  prompt: 'Inspect the workspace',
  mountPrefix: 'w1234',
  timeoutMs: 60_000,
  maxTokens: 8_192,
};

const isolatedTurnRequest: IsolatedAgentTurnRequest = {
  agentInstanceId: 'agent-1',
  modelId: 'test-model',
  traceId: 'trace-1',
  metadata: {
    purpose: 'test',
  },
  systemPrompt: 'Use read-only tools.',
  messages: [
    {
      role: 'user',
      content: 'Read README.md',
    },
  ],
  tools: [
    {
      name: 'read',
      inputSchema: {
        type: 'object',
      },
    },
  ],
  maxSteps: 3,
};

const isolatedTurnResult: IsolatedAgentTurnResult = {
  status: 'completed',
  text: 'Done.',
  messages: [
    ...isolatedTurnRequest.messages,
    {
      role: 'assistant',
      text: 'Done.',
      toolCalls: [],
    },
  ],
  steps: [
    {
      index: 1,
      text: 'Done.',
      reasoning: '',
      finishReason: 'stop',
      usage: {},
      toolCalls: [],
      toolResults: [],
      toolErrors: [],
      approvalRequests: [],
    },
  ],
};

class FakeUtilityProcess extends EventEmitter {
  public pid: number | undefined;
  public stdout = null;
  public stderr = null;
  public readonly messages: MainToAgentHostMessage[] = [];
  public readonly kill = vi.fn(() => {
    queueMicrotask(() => this.exit(143));
    return true;
  });

  private exited = false;

  public constructor(
    pid: number,
    private readonly autoReady: boolean,
    private readonly autoExitOnShutdown: boolean,
  ) {
    super();
    this.pid = pid;
  }

  public postMessage(message: MainToAgentHostMessage): void {
    this.messages.push(message);

    if (message.type === 'initialize' && this.autoReady) {
      queueMicrotask(() => {
        this.send({
          type: 'ready',
          protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
          launchId: message.launchId,
          pid: this.pid ?? 0,
          startedAt: Date.now(),
        });
      });
    }

    if (message.type === 'shutdown' && this.autoExitOnShutdown) {
      queueMicrotask(() => {
        this.send({
          type: 'shutdown-complete',
          launchId: message.launchId,
          requestId: message.requestId,
        });
        queueMicrotask(() => this.exit(0));
      });
    }
  }

  public send(message: AgentHostToMainMessage): void {
    this.emit('message', message);
  }

  public exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code);
    this.pid = undefined;
  }
}

class AgentHostHarness {
  public readonly children: FakeUtilityProcess[] = [];
  public autoReady = true;
  public autoExitOnShutdown = true;
  public throwOnNextFork = false;

  public readonly fork = vi.fn(
    (_modulePath: string, _args: string[], _options: Electron.ForkOptions) => {
      if (this.throwOnNextFork) {
        this.throwOnNextFork = false;
        throw new Error('fork failed');
      }

      const child = new FakeUtilityProcess(
        10_000 + this.children.length,
        this.autoReady,
        this.autoExitOnShutdown,
      );
      this.children.push(child);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  );
}

class FakeAgentStore {
  private readonly listeners = new Set<(state: AgentSystemState) => void>();

  public constructor(private state: AgentSystemState) {}

  public get(): AgentSystemState {
    return this.state;
  }

  public subscribe(listener: (state: AgentSystemState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public publish(state: AgentSystemState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

const services: AgentHostProcessService[] = [];

type LifecycleTelemetryEvent =
  AgentHostProcessTelemetryEvents['agent-host-process-lifecycle'];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.teardown();
  }
  await flushMicrotasks();
  vi.useRealTimers();
});

describe('AgentHostProcessService', () => {
  it('starts with a versioned handshake and hardened fork options', async () => {
    const harness = new AgentHostHarness();
    const service = await createService(harness);
    const child = harness.children[0];

    expect(service.processStatus).toBe('ready');
    expect(service.pid).toBe(child?.pid);
    expect(harness.fork).toHaveBeenCalledWith(
      expect.stringMatching(/agent-host\.cjs$/),
      [],
      {
        execArgv: ['--max-old-space-size=256'],
        serviceName: 'clodex-agent-host',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {},
        allowLoadingUnsignedLibraries: false,
      },
    );
    expect(child?.messages[0]).toMatchObject({
      type: 'initialize',
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      launchId: expect.any(String),
    });
  });

  it('deduplicates content-free runtime snapshots', async () => {
    const harness = new AgentHostHarness();
    const service = await createService(harness);
    const store = new FakeAgentStore(
      createState({
        messageText: 'secret prompt',
        isWorking: true,
      }),
    );

    service.bindAgentStore(store as unknown as AgentStore);
    const child = harness.children[0];
    const firstSnapshot = runtimeSnapshots(child).at(-1);

    expect(firstSnapshot).toMatchObject({
      revision: 1,
      agents: [
        {
          id: 'agent-1',
          type: 'chat',
          parentAgentInstanceId: null,
          isWorking: true,
          historyLength: 1,
          queuedMessageCount: 1,
          lastMessageId: 'message-1',
        },
      ],
    });
    expect(JSON.stringify(firstSnapshot)).not.toContain('secret prompt');
    expect(JSON.stringify(firstSnapshot)).not.toContain('queued secret');

    store.publish(
      createState({
        messageText: 'different secret, same runtime shape',
        isWorking: true,
      }),
    );
    expect(runtimeSnapshots(child)).toHaveLength(2);

    store.publish(
      createState({
        messageText: 'different secret, now idle',
        isWorking: false,
      }),
    );
    expect(runtimeSnapshots(child)).toHaveLength(3);
    expect(runtimeSnapshots(child).at(-1)?.revision).toBe(2);
  });

  it('reports a delayed worker heartbeat as a main-loop stall', async () => {
    const harness = new AgentHostHarness();
    const service = await createService(harness, {
      mainLoopStallThresholdMs: 100,
    });
    const listener = vi.fn();
    service.onMainLoopStall(listener);

    harness.children[0]?.send({
      type: 'heartbeat',
      launchId: launchIdOf(harness.children[0]),
      sequence: 7,
      sentAt: Date.now() - 250,
      trackedAgentCount: 1,
      workingAgentCount: 1,
      stateRevision: 4,
    });

    expect(listener).toHaveBeenCalledWith({
      stalledForMs: 250,
      heartbeatSequence: 7,
    });
  });

  it('refuses to treat the utility process as an OpenManus confinement boundary', async () => {
    const harness = new AgentHostHarness();
    const service = await createService(harness);
    const child = harness.children[0];

    await expect(service.executeOpenManus(openManusRequest)).rejects.toThrow(
      'not an OS-confined, credential-brokered adapter',
    );
    expect(
      child?.messages.some((message) => message.type === 'execute-openmanus'),
    ).toBe(false);
  });

  it('routes isolated turn model/tool RPC and streaming events through main', async () => {
    const harness = new AgentHostHarness();
    const service = await createService(harness);
    const child = harness.children[0];
    const callModel = vi.fn(async (_request, { onEvent }) => {
      onEvent({
        type: 'text-delta',
        text: 'Checking.',
      });
      return {
        text: 'Checking.',
        reasoning: '',
        toolCalls: [
          {
            toolCallId: 'tool-1',
            toolName: 'read',
            input: {
              path: 'README.md',
            },
          },
        ],
        finishReason: 'tool-calls',
        usage: {},
      };
    });
    const callTool = vi.fn(async () => ({
      output: '# Project',
    }));
    const handlers = {
      callModel,
      callTool,
    } satisfies AgentTurnHostHandlers;
    const onEvent = vi.fn();

    const execution = service.executeAgentTurn(isolatedTurnRequest, {
      onEvent,
      handlers,
    });
    const executeMessage = child?.messages.find(
      (
        message,
      ): message is Extract<
        MainToAgentHostMessage,
        { type: 'execute-agent-turn' }
      > => message.type === 'execute-agent-turn',
    );
    if (!executeMessage) throw new Error('Expected execute-agent-turn request');

    child?.send({
      type: 'agent-model-call-request',
      launchId: executeMessage.launchId,
      turnRequestId: executeMessage.requestId,
      callId: 'model-call-1',
      request: {
        agentInstanceId: isolatedTurnRequest.agentInstanceId,
        modelId: isolatedTurnRequest.modelId,
        traceId: isolatedTurnRequest.traceId,
        metadata: isolatedTurnRequest.metadata,
        systemPrompt: isolatedTurnRequest.systemPrompt,
        messages: isolatedTurnRequest.messages,
        tools: isolatedTurnRequest.tools,
        settings: isolatedTurnRequest.settings,
      },
    });
    await flushMicrotasks();

    expect(callModel).toHaveBeenCalledOnce();
    expect(child?.messages).toContainEqual({
      type: 'agent-model-call-event',
      launchId: executeMessage.launchId,
      turnRequestId: executeMessage.requestId,
      callId: 'model-call-1',
      event: {
        type: 'text-delta',
        text: 'Checking.',
      },
    });
    expect(child?.messages).toContainEqual(
      expect.objectContaining({
        type: 'agent-model-call-complete',
        turnRequestId: executeMessage.requestId,
        callId: 'model-call-1',
      }),
    );

    child?.send({
      type: 'agent-tool-call-request',
      launchId: executeMessage.launchId,
      turnRequestId: executeMessage.requestId,
      callId: 'tool-host-call-1',
      request: {
        agentInstanceId: isolatedTurnRequest.agentInstanceId,
        call: {
          toolCallId: 'tool-1',
          toolName: 'read',
          input: {
            path: 'README.md',
          },
        },
        messages: isolatedTurnRequest.messages,
      },
    });
    await flushMicrotasks();

    expect(callTool).toHaveBeenCalledOnce();
    expect(child?.messages).toContainEqual({
      type: 'agent-tool-call-complete',
      launchId: executeMessage.launchId,
      turnRequestId: executeMessage.requestId,
      callId: 'tool-host-call-1',
      result: {
        output: '# Project',
      },
    });

    const streamedEvent = {
      type: 'text-delta' as const,
      step: 1,
      text: 'Done.',
    };
    child?.send({
      type: 'agent-turn-event',
      launchId: executeMessage.launchId,
      requestId: executeMessage.requestId,
      event: streamedEvent,
    });
    child?.send({
      type: 'agent-turn-complete',
      launchId: executeMessage.launchId,
      requestId: executeMessage.requestId,
      result: isolatedTurnResult,
    });

    await expect(execution).resolves.toEqual(isolatedTurnResult);
    expect(onEvent).toHaveBeenCalledWith(streamedEvent);
  });

  it('aborts active host RPC when an isolated turn is cancelled', async () => {
    const harness = new AgentHostHarness();
    const service = await createService(harness);
    const child = harness.children[0];
    let hostSignal: AbortSignal | undefined;
    const callModel = vi.fn(
      async (_request, { signal }: { signal: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          hostSignal = signal;
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    service.setAgentTurnHandlers({
      callModel,
      callTool: vi.fn(),
    });
    const controller = new AbortController();
    const execution = service.executeAgentTurn(isolatedTurnRequest, {
      signal: controller.signal,
    });
    const executeMessage = child?.messages.find(
      (
        message,
      ): message is Extract<
        MainToAgentHostMessage,
        { type: 'execute-agent-turn' }
      > => message.type === 'execute-agent-turn',
    );
    if (!executeMessage) throw new Error('Expected execute-agent-turn request');

    child?.send({
      type: 'agent-model-call-request',
      launchId: executeMessage.launchId,
      turnRequestId: executeMessage.requestId,
      callId: 'model-call-1',
      request: {
        agentInstanceId: isolatedTurnRequest.agentInstanceId,
        modelId: isolatedTurnRequest.modelId,
        traceId: isolatedTurnRequest.traceId,
        metadata: isolatedTurnRequest.metadata,
        systemPrompt: isolatedTurnRequest.systemPrompt,
        messages: isolatedTurnRequest.messages,
        tools: isolatedTurnRequest.tools,
      },
    });
    await flushMicrotasks();
    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(hostSignal?.aborted).toBe(true);
    expect(child?.messages.at(-1)).toEqual({
      type: 'cancel-agent-turn',
      launchId: executeMessage.launchId,
      requestId: executeMessage.requestId,
    });
  });

  it('does not replay an isolated turn after a worker crash', async () => {
    const harness = new AgentHostHarness();
    const lifecycleEvents: LifecycleTelemetryEvent[] = [];
    const service = await createService(harness, {
      restartBaseDelayMs: 10,
      telemetry: createLifecycleTelemetry(lifecycleEvents),
    });
    service.setAgentTurnHandlers({
      callModel: vi.fn(),
      callTool: vi.fn(),
    });
    const execution = service.executeAgentTurn(isolatedTurnRequest);

    harness.children[0]?.exit(9);

    await expect(execution).rejects.toThrow('turn was not replayed');
    expect(lifecycleEvents[0]).toEqual({
      phase: 'worker-crashed',
      restart_attempt: 0,
      exit_code: 9,
      pending_execution_count: 0,
      pending_turn_count: 1,
    });
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(
      harness.children[1]?.messages.some(
        (message) => message.type === 'execute-agent-turn',
      ),
    ).toBe(false);
  });

  it('rejects an already-aborted OpenManus request before any IPC', async () => {
    const harness = new AgentHostHarness();
    const service = await createService(harness);
    const child = harness.children[0];
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      service.executeOpenManus(openManusRequest, {
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      child?.messages.some(
        (message) =>
          message.type === 'execute-openmanus' ||
          message.type === 'cancel-execution',
      ),
    ).toBe(false);
  });

  it('does not queue or replay OpenManus work across a worker crash', async () => {
    const harness = new AgentHostHarness();
    const service = await createService(harness, {
      restartBaseDelayMs: 10,
    });
    await expect(service.executeOpenManus(openManusRequest)).rejects.toThrow(
      'not an OS-confined, credential-brokered adapter',
    );

    harness.children[0]?.exit(9);

    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(
      harness.children[1]?.messages.some(
        (message) => message.type === 'execute-openmanus',
      ),
    ).toBe(false);
  });

  it('restarts after a crash and resynchronizes the latest snapshot', async () => {
    const harness = new AgentHostHarness();
    const lifecycleEvents: LifecycleTelemetryEvent[] = [];
    const service = await createService(harness, {
      restartBaseDelayMs: 10,
      telemetry: createLifecycleTelemetry(lifecycleEvents),
    });
    const store = new FakeAgentStore(createState({ isWorking: true }));
    service.bindAgentStore(store as unknown as AgentStore);
    const expectedSnapshot = runtimeSnapshots(harness.children[0]).at(-1);

    harness.children[0]?.exit(1);
    expect(service.processStatus).toBe('restarting');

    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();

    expect(harness.children).toHaveLength(2);
    expect(service.processStatus).toBe('ready');
    expect(runtimeSnapshots(harness.children[1])[0]).toEqual(expectedSnapshot);
    expect(lifecycleEvents).toEqual([
      {
        phase: 'worker-crashed',
        restart_attempt: 0,
        exit_code: 1,
        pending_execution_count: 0,
        pending_turn_count: 0,
      },
      {
        phase: 'restart-scheduled',
        restart_attempt: 1,
        delay_ms: 10,
      },
      {
        phase: 'restart-succeeded',
        restart_attempt: 1,
        recovery_duration_ms: 10,
      },
    ]);
    expect(JSON.stringify(lifecycleEvents)).not.toMatch(
      /prompt|message|tool|trace|agent[_-]?instance/i,
    );
  });

  it('stops restarting after the bounded restart budget is exhausted', async () => {
    const harness = new AgentHostHarness();
    const lifecycleEvents: LifecycleTelemetryEvent[] = [];
    const service = await createService(harness, {
      maxRestartsPerWindow: 1,
      restartBaseDelayMs: 10,
      telemetry: createLifecycleTelemetry(lifecycleEvents),
    });

    harness.children[0]?.exit(1);
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(service.processStatus).toBe('ready');

    harness.children[1]?.exit(1);

    expect(service.processStatus).toBe('failed');
    expect(harness.children).toHaveLength(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Restart budget exhausted'),
    );
    expect(lifecycleEvents.at(-2)).toEqual({
      phase: 'worker-crashed',
      restart_attempt: 1,
      exit_code: 1,
      pending_execution_count: 0,
      pending_turn_count: 0,
    });
    expect(lifecycleEvents.at(-1)).toEqual({
      phase: 'restart-budget-exhausted',
      restart_attempt: 1,
      recovery_duration_ms: 0,
    });
  });

  it('recovers when a restart fork attempt itself fails', async () => {
    const harness = new AgentHostHarness();
    const lifecycleEvents: LifecycleTelemetryEvent[] = [];
    const service = await createService(harness, {
      restartBaseDelayMs: 10,
      telemetry: createLifecycleTelemetry(lifecycleEvents),
    });

    harness.throwOnNextFork = true;
    harness.children[0]?.exit(1);
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(service.processStatus).toBe('restarting');

    await vi.advanceTimersByTimeAsync(20);
    await flushMicrotasks();

    expect(harness.children).toHaveLength(2);
    expect(service.processStatus).toBe('ready');
    expect(lifecycleEvents).toContainEqual({
      phase: 'restart-spawn-failed',
      restart_attempt: 1,
      recovery_duration_ms: 10,
    });
    expect(lifecycleEvents).toContainEqual({
      phase: 'restart-scheduled',
      restart_attempt: 2,
      delay_ms: 20,
    });
    expect(lifecycleEvents.at(-1)).toEqual({
      phase: 'restart-succeeded',
      restart_attempt: 2,
      recovery_duration_ms: 30,
    });
  });

  it('waits for a graceful worker exit during teardown', async () => {
    const harness = new AgentHostHarness();
    const service = await createService(harness);
    const child = harness.children[0];

    await service.teardown();
    await flushMicrotasks();

    expect(child?.messages.at(-1)).toMatchObject({
      type: 'shutdown',
      launchId: launchIdOf(child),
      reason: 'app-shutdown',
    });
    expect(child?.kill).not.toHaveBeenCalled();
    expect(service.processStatus).toBe('stopped');
  });

  it('rejects an incompatible worker protocol version', async () => {
    const harness = new AgentHostHarness();
    harness.autoReady = false;
    const creating = AgentHostProcessService.create(logger, {
      fork: asFork(harness),
      readyTimeoutMs: 1_000,
    });

    await flushMicrotasks();
    const child = harness.children[0];
    child?.send({
      type: 'ready',
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION + 1,
      launchId: launchIdOf(child),
      pid: child.pid ?? 0,
      startedAt: Date.now(),
    });

    await expect(creating).rejects.toThrow('protocol mismatch');
    expect(child?.kill).toHaveBeenCalledOnce();
  });

  it('ignores malformed worker messages without refreshing health state', async () => {
    const harness = new AgentHostHarness();
    const service = await createService(harness);

    harness.children[0]?.emit('message', {
      type: 'heartbeat',
      launchId: launchIdOf(harness.children[0]),
    });

    expect(service.processStatus).toBe('ready');
    expect(logger.warn).toHaveBeenCalledWith(
      '[AgentHostProcess] Ignoring malformed worker message',
    );
  });
});

async function createService(
  harness: AgentHostHarness,
  options: AgentHostProcessOptions = {},
): Promise<AgentHostProcessService> {
  const creating = AgentHostProcessService.create(logger, {
    fork: asFork(harness),
    readyTimeoutMs: 1_000,
    heartbeatTimeoutMs: 1_000_000,
    healthCheckIntervalMs: 1_000_000,
    ...options,
  });
  await flushMicrotasks();
  const service = await creating;
  services.push(service);
  return service;
}

function createLifecycleTelemetry(
  events: LifecycleTelemetryEvent[],
): AgentHostProcessTelemetrySink {
  return {
    capture(eventName, properties) {
      expect(eventName).toBe('agent-host-process-lifecycle');
      events.push(properties);
    },
  };
}

function asFork(
  harness: AgentHostHarness,
): NonNullable<AgentHostProcessOptions['fork']> {
  return harness.fork as NonNullable<AgentHostProcessOptions['fork']>;
}

function launchIdOf(child: FakeUtilityProcess | undefined): string {
  const initialize = child?.messages.find(
    (
      message,
    ): message is Extract<MainToAgentHostMessage, { type: 'initialize' }> =>
      message.type === 'initialize',
  );
  if (!initialize) throw new Error('Worker was not initialized');
  return initialize.launchId;
}

function runtimeSnapshots(
  child: FakeUtilityProcess | undefined,
): Array<
  Extract<MainToAgentHostMessage, { type: 'sync-runtime-state' }>['snapshot']
> {
  return (
    child?.messages
      .filter(
        (
          message,
        ): message is Extract<
          MainToAgentHostMessage,
          { type: 'sync-runtime-state' }
        > => message.type === 'sync-runtime-state',
      )
      .map((message) => message.snapshot) ?? []
  );
}

function createState({
  messageText = 'message',
  isWorking,
}: {
  messageText?: string;
  isWorking: boolean;
}): AgentSystemState {
  return {
    agents: {
      instances: {
        'agent-1': {
          type: 'chat',
          parentAgentInstanceId: null,
          state: {
            isWorking,
            history: [
              {
                id: 'message-1',
                role: 'user',
                content: [{ type: 'text', text: messageText }],
              },
            ],
            queuedMessages: [
              {
                id: 'queued-1',
                role: 'user',
                content: [{ type: 'text', text: 'queued secret' }],
              },
            ],
          },
        },
      },
    },
    toolbox: {},
  } as unknown as AgentSystemState;
}

async function flushMicrotasks(): Promise<void> {
  vi.runAllTicks();
  await Promise.resolve();
  vi.runAllTicks();
  await Promise.resolve();
}
