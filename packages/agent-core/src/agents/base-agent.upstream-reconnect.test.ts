import { simulateReadableStream } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseAgent } from './base-agent';
import { UpstreamStepRecoveryTracker } from './shared/upstream-reconnect';

type ReconnectState = {
  activeModelId: string;
  history: any[];
  error?: any;
};

function createReconnectHarness(options?: {
  persistent?: boolean;
  history?: any[];
}) {
  const state: ReconnectState = {
    activeModelId: 'gpt-test',
    history: options?.history ?? [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Continue the task' }],
      },
    ],
  };
  const persist = vi.fn(async () => {});
  const terminateNonTerminalToolPartsInLastAssistant = vi.fn(() => ({
    changed: false,
    dirtyMessageIndices: [] as number[],
  }));
  const removeTransportOnlyAssistantTail = vi.fn(() => ({
    status: 'no-tail' as const,
  }));
  const setIsWorkingFalse = vi.fn();
  const recordStepError = vi.fn(({ error }: { error: unknown }) => {
    state.error = error;
  });
  const mergeUIMessageStream = vi.fn();
  const runStep = vi.fn(async () => {});
  const revertToUserMessageSerialized = vi.fn(async () => {});
  const sendUserMessageSerialized = vi.fn(async () => ({
    disposition: 'started' as const,
  }));

  const agent = Object.create(BaseAgent.prototype) as any;
  Object.defineProperties(agent, {
    config: { value: { persistent: options?.persistent ?? false } },
    agentType: { value: 'chat' },
  });
  agent.instanceId = 'agent-1';
  agent._stepGeneration = 7;
  agent._stepResolvedModelId = 'gpt-test';
  agent._pendingContinue = null;
  agent._pendingSyntheticContinuation = null;
  agent._pendingToolCapabilityScopeId = 'scope-1';
  agent._upstreamReconnectTurnId = null;
  agent._upstreamReconnectAttempts = 0;
  agent._upstreamReconnectNeedsContinuation = false;
  agent._upstreamReconnectCompletedToolSignatures = new Set();
  agent._upstreamReconnectTimer = null;
  agent._toolCallExecutions = new Map();
  agent._toolCallAdmissions = new Map();
  agent._toolCallProviderIds = new Map();
  agent._preRejectedToolCalls = new Map();
  agent._duplicateToolCallRejectionsByError = new WeakMap();
  agent._duplicateToolCallRejectionsByMessage = new Map();
  agent.stepAbortController = new AbortController();
  agent.state = {
    get: () => state,
    persist,
    commands: {
      recordStepError,
      terminateNonTerminalToolPartsInLastAssistant,
      removeTransportOnlyAssistantTail,
      mergeUIMessageStream,
      setIsWorkingFalse,
    },
  };
  agent.host = {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    telemetry: { capture: vi.fn() },
  };
  agent.emitNotificationEvent = vi.fn();
  agent.report = vi.fn();
  const applyAndPersistApprovalSweep = vi.fn(async (mutate: () => unknown) => {
    mutate();
  });
  agent.applyAndPersistApprovalSweep = applyAndPersistApprovalSweep;
  agent.populatePathReferencesOnAssistantMessage = vi.fn(async () => {});
  agent.emitDisconnectedTerminalToolEvents = vi.fn();
  agent.scheduleMemorySnapshotWrite = vi.fn();
  agent._seenApprovalRequestIds = new Set();
  agent.runStep = runStep;
  agent.revertToUserMessageSerialized = revertToUserMessageSerialized;
  agent.sendUserMessageSerialized = sendUserMessageSerialized;

  return {
    agent,
    state,
    persist,
    recordStepError,
    terminateNonTerminalToolPartsInLastAssistant,
    removeTransportOnlyAssistantTail,
    setIsWorkingFalse,
    mergeUIMessageStream,
    applyAndPersistApprovalSweep,
    runStep,
    revertToUserMessageSerialized,
    sendUserMessageSerialized,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeUiStream(chunks: unknown[]) {
  return simulateReadableStream({ chunks }) as any;
}

function makeFinishedStepResult() {
  return {
    finishReason: 'stop',
    rawFinishReason: undefined,
    usage: {
      inputTokens: 0,
      inputTokenDetails: {
        noCacheTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokens: 0,
      outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
      totalTokens: 0,
    },
    totalUsage: {
      inputTokens: 0,
      inputTokenDetails: {
        noCacheTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokens: 0,
      outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
      totalTokens: 0,
    },
    content: [],
    text: '',
    reasoning: '',
    reasoningText: undefined,
    files: [],
    sources: [],
    toolCalls: [],
    staticToolCalls: [],
    dynamicToolCalls: [],
    toolResults: [],
    staticToolResults: [],
    dynamicToolResults: [],
    request: {},
    response: {
      id: 'response-1',
      timestamp: new Date(),
      modelId: 'gpt-test',
      messages: [],
    },
    warnings: undefined,
    providerMetadata: undefined,
    steps: [],
  };
}

function createOnFinishDisconnectHarness() {
  const state = {
    activeModelId: 'gpt-test',
    queuedMessages: [],
    history: [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Keep reconnecting' }],
      },
    ],
  };
  const agent = Object.create(BaseAgent.prototype) as any;
  Object.defineProperties(agent, {
    config: { value: { persistent: false } },
    agentType: { value: 'chat' },
  });
  agent.instanceId = 'agent-1';
  agent._stepGeneration = 7;
  agent._upstreamReconnectTurnId = 'user-1';
  agent._upstreamReconnectAttempts = 3;
  agent._upstreamReconnectNeedsContinuation = false;
  agent._upstreamReconnectCompletedToolSignatures = new Set();
  agent._upstreamReconnectTimer = null;
  agent._pendingToolCapabilityScopeId = null;
  agent._pendingSyntheticContinuation = null;
  agent._pendingContinue = null;
  agent._pendingToolCallRecoveryExhaustion = null;
  agent._cacheAnalyzer = { trackStep: vi.fn() };
  agent.state = {
    get: () => state,
    commands: {
      beginStep: vi.fn(() => ({ queueFlushIndex: undefined })),
      setIsWorkingFalse: vi.fn(),
      recordStepError: vi.fn(),
    },
  };
  agent.host = {
    models: {
      getWithOptions: vi.fn(async () => ({
        model: {} as never,
        providerOptions: undefined,
        headers: undefined,
        contextWindowSize: 200_000,
        providerMode: 'custom',
        reasoningSignatureSource: undefined,
      })),
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    telemetry: { capture: vi.fn() },
  };
  agent.getModelTaskRoleForNextStep = vi.fn(() => 'analysis');
  agent.generateContextForNewStep = vi.fn(async () => []);
  agent.getToolsForStep = vi.fn(async () => ({}));
  agent.resetToolCallExecutionTracking = vi.fn();
  agent.wrapToolsWithTiming = vi.fn((tools) => tools);
  agent.wrapToolsWithOutputBudget = vi.fn((tools) => tools);
  agent.getModelSettings = vi.fn(async () => ({}));
  agent.wrapModelWithToolCallIdentityFence = vi.fn((model) => model);
  agent.getExecutionTargetForCurrentTurn = vi.fn(() => undefined);
  agent.updateTitle = vi.fn(async () => {});
  agent.handleUiStream = vi.fn(async () => {});
  agent.handlePostStep = vi.fn(async () => false);
  agent.report = vi.fn();
  agent.emitNotificationEvent = vi.fn();

  let attemptsObservedByDisconnectHandler: number | undefined;
  agent.handleUpstreamDisconnect = vi.fn(async () => {
    attemptsObservedByDisconnectHandler = agent._upstreamReconnectAttempts;
    return 'failed' as const;
  });
  agent.stepExecutor = {
    execute: vi.fn(async (request: any) => ({
      modelRouteBinding: 'request-model' as const,
      toUIMessageStream: vi.fn(() => null),
      consumeStream: vi.fn(async () => {
        request.options.onError?.({
          error: new Error('ServerDisconnectedError'),
        });
        await request.options.onFinish?.(makeFinishedStepResult());
      }),
    })),
  };

  return {
    agent,
    getAttemptsObservedByDisconnectHandler: () =>
      attemptsObservedByDisconnectHandler,
  };
}

function disconnectInput(
  tracker: UpstreamStepRecoveryTracker,
  overrides?: Record<string, unknown>,
) {
  const error = new Error(
    'Codex upstream request failed via proxy endpoint 62b8b1d2-f4bc-43bc-93c3-ce086afc5cd0: ServerDisconnectedError',
  );
  return {
    disconnect: {
      error,
      info: {
        message: error.message,
        endpointId: '62b8b1d2-f4bc-43bc-93c3-ce086afc5cd0',
      },
    },
    tracker,
    stepGeneration: 7,
    isApprovalContinuation: false,
    modelId: 'gpt-test',
    modelRouteBinding: 'request-model' as const,
    toolCapabilityScopeId: 'scope-1',
    approvalOriginScopeId: null,
    historyMessageIdsBeforeStream: ['user-1'],
    ...overrides,
  };
}

describe('BaseAgent phase-aware upstream reconnect', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('manual reconnect preserves history instead of reverting and resending the user turn', async () => {
    const harness = createReconnectHarness();
    harness.state.error = {
      kind: 'upstream-disconnected',
      message: 'Partial response preserved.',
      originalMessage: 'ServerDisconnectedError',
      modelId: 'gpt-test',
      attempts: 5,
      phase: 'partial-output',
      resumeMode: 'continue',
    };

    await harness.agent.retryLastUserMessageSerialized();

    expect(harness.revertToUserMessageSerialized).not.toHaveBeenCalled();
    expect(harness.sendUserMessageSerialized).not.toHaveBeenCalled();
    expect(harness.runStep).toHaveBeenCalledOnce();
    expect(harness.runStep).toHaveBeenCalledWith(false);
    expect(harness.agent._pendingSyntheticContinuation).toEqual({
      reason: 'upstream-disconnected',
      attempt: 1,
      maxAttempts: 5,
    });
  });

  it('rejects an impossible persisted phase/resume combination', async () => {
    const harness = createReconnectHarness();
    harness.state.error = {
      kind: 'upstream-disconnected',
      message: 'Invalid persisted recovery state',
      originalMessage: 'ServerDisconnectedError',
      modelId: 'gpt-test',
      attempts: 5,
      phase: 'unknown-tool-outcome',
      resumeMode: 'continue',
    };

    await expect(
      harness.agent.retryLastUserMessageSerialized(),
    ).rejects.toThrow('persisted recovery state is invalid');
    expect(harness.runStep).not.toHaveBeenCalled();
  });

  it('blocks reconnect when a dispatched tool has no durable terminal result', async () => {
    const harness = createReconnectHarness({
      history: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Change the project' }],
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-write',
              toolCallId: 'write-unknown',
              state: 'input-available',
              input: { path: 'w1/file.ts', content: 'changed' },
            },
          ],
        },
      ],
    });
    const tracker = new UpstreamStepRecoveryTracker();
    tracker.markToolDispatched('write-unknown');

    await expect(
      harness.agent.handleUpstreamDisconnect(disconnectInput(tracker)),
    ).resolves.toBe('failed');

    expect(harness.runStep).not.toHaveBeenCalled();
    expect(harness.agent._upstreamReconnectTimer).toBeNull();
    expect(harness.state.error).toMatchObject({
      kind: 'upstream-disconnected',
      phase: 'unknown-tool-outcome',
      resumeMode: 'blocked',
      attempts: 0,
    });
    expect(
      harness.terminateNonTerminalToolPartsInLastAssistant,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        outputErrorText: expect.stringContaining('outcome is unknown'),
      }),
    );
    await expect(
      harness.agent.retryLastUserMessageSerialized(),
    ).rejects.toThrow('Reconnect is blocked');
    expect(harness.revertToUserMessageSerialized).not.toHaveBeenCalled();
  });

  it('strictly persists a terminal tool result before scheduling continuation', async () => {
    vi.useFakeTimers();
    const harness = createReconnectHarness({
      persistent: true,
      history: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Inspect the file' }],
        },
        {
          id: 'assistant-terminal',
          role: 'assistant',
          parts: [
            {
              type: 'tool-read',
              toolCallId: 'read-terminal',
              state: 'output-available',
              input: { path: 'w1/file.ts' },
              output: { message: 'contents' },
            },
          ],
        },
      ],
    });
    const tracker = new UpstreamStepRecoveryTracker();
    tracker.markToolDispatched('read-terminal');
    tracker.markToolTerminal('read-terminal');

    await expect(
      harness.agent.handleUpstreamDisconnect(disconnectInput(tracker)),
    ).resolves.toBe('failed');

    expect(harness.persist).toHaveBeenCalledWith({
      dirtyMessageIndices: [1],
      expectedMessageBindings: [
        { messageIndex: 1, messageId: 'assistant-terminal' },
      ],
      throwOnError: true,
    });
    expect(
      harness.agent.populatePathReferencesOnAssistantMessage,
    ).toHaveBeenCalledWith(7);
    expect(harness.agent.scheduleMemorySnapshotWrite).toHaveBeenCalledWith(
      'post-step',
    );
    expect(harness.agent._pendingSyntheticContinuation).toEqual({
      reason: 'upstream-disconnected',
      attempt: 1,
      maxAttempts: 5,
    });
    expect(harness.agent._upstreamReconnectAttempts).toBe(1);
    expect(harness.runStep).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(harness.runStep).toHaveBeenCalledOnce();
    expect(harness.runStep).toHaveBeenCalledWith(false);
    expect(harness.revertToUserMessageSerialized).not.toHaveBeenCalled();
  });

  it('keeps the synthetic Continue instruction across a later pre-output disconnect', async () => {
    vi.useFakeTimers();
    const harness = createReconnectHarness({
      history: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Inspect and continue' }],
        },
        {
          id: 'assistant-terminal',
          role: 'assistant',
          parts: [
            {
              type: 'tool-read',
              toolCallId: 'read-terminal',
              state: 'output-available',
              input: { path: 'w1/file.ts' },
              output: { message: 'contents' },
            },
          ],
        },
      ],
    });
    const completed = new UpstreamStepRecoveryTracker();
    completed.markToolDispatched('read-terminal');
    completed.markToolTerminal('read-terminal');

    await harness.agent.handleUpstreamDisconnect(disconnectInput(completed));
    expect(harness.agent._pendingSyntheticContinuation).toMatchObject({
      reason: 'upstream-disconnected',
      attempt: 1,
    });

    // generateContextForNewStep consumes the transient prompt before the next
    // provider request. A disconnect before that request emits output must put
    // the same continuation intent back for the following attempt.
    harness.agent._pendingSyntheticContinuation = null;
    await harness.agent.handleUpstreamDisconnect(
      disconnectInput(new UpstreamStepRecoveryTracker()),
    );

    expect(harness.agent._pendingSyntheticContinuation).toEqual({
      reason: 'upstream-disconnected',
      attempt: 2,
      maxAttempts: 5,
    });
    expect(harness.agent._upstreamReconnectNeedsContinuation).toBe(true);
  });

  it('retries only before output and publishes an error after five reconnect attempts', async () => {
    vi.useFakeTimers();
    const harness = createReconnectHarness();
    const delays = [500, 1_000, 2_000, 4_000, 8_000];

    for (const [index, delay] of delays.entries()) {
      const tracker = new UpstreamStepRecoveryTracker();
      await expect(
        harness.agent.handleUpstreamDisconnect(disconnectInput(tracker)),
      ).resolves.toBe('failed');
      expect(harness.agent._upstreamReconnectAttempts).toBe(index + 1);
      expect(harness.state.error).toBeUndefined();

      await vi.advanceTimersByTimeAsync(delay);
      expect(harness.runStep).toHaveBeenCalledTimes(index + 1);
      expect(harness.runStep).toHaveBeenLastCalledWith(false);
    }

    await expect(
      harness.agent.handleUpstreamDisconnect(
        disconnectInput(new UpstreamStepRecoveryTracker()),
      ),
    ).resolves.toBe('failed');

    expect(harness.runStep).toHaveBeenCalledTimes(5);
    expect(harness.state.error).toMatchObject({
      kind: 'upstream-disconnected',
      attempts: 5,
      phase: 'before-output',
      resumeMode: 'retry-step',
    });
    expect(
      harness.agent.host.telemetry.capture.mock.calls.filter(
        ([event]: [string]) => event === 'upstream-reconnect-scheduled',
      ),
    ).toHaveLength(5);
    expect(harness.revertToUserMessageSerialized).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(harness.runStep).toHaveBeenCalledTimes(5);
  });

  it.each([
    {
      phase: 'partial output',
      track(tracker: UpstreamStepRecoveryTracker) {
        tracker.markFirstToken();
      },
    },
    {
      phase: 'terminal tool output',
      track(tracker: UpstreamStepRecoveryTracker) {
        tracker.markToolDispatched('external-tool');
        tracker.markToolTerminal('external-tool');
      },
    },
  ])('blocks an external route even after $phase', async ({ track }) => {
    vi.useFakeTimers();
    const harness = createReconnectHarness();
    const tracker = new UpstreamStepRecoveryTracker();
    track(tracker);

    await expect(
      harness.agent.handleUpstreamDisconnect(
        disconnectInput(tracker, { modelRouteBinding: 'external' }),
      ),
    ).resolves.toBe('failed');

    expect(harness.state.error).toMatchObject({
      kind: 'upstream-disconnected',
      phase: 'route-unverified',
      resumeMode: 'blocked',
    });
    expect(harness.agent._upstreamReconnectTimer).toBeNull();
    expect(harness.runStep).not.toHaveBeenCalled();
  });

  it('does not treat a preliminary output as a durable terminal tool result', async () => {
    const harness = createReconnectHarness();
    const tracker = new UpstreamStepRecoveryTracker();
    tracker.markToolDispatched('preliminary-tool');

    await harness.agent.handleUiStream(
      makeUiStream([
        { type: 'start', messageId: 'assistant-stream' },
        {
          type: 'tool-input-available',
          toolCallId: 'preliminary-tool',
          toolName: 'read',
          input: { path: 'w1/file.ts' },
        },
        {
          type: 'tool-output-available',
          toolCallId: 'preliminary-tool',
          output: { message: 'partial' },
          preliminary: true,
        },
      ]),
      undefined,
      7,
      tracker,
    );

    expect(tracker.snapshot()).toMatchObject({
      terminalToolCallIds: [],
      unresolvedToolCallIds: ['preliminary-tool'],
    });
  });

  it('treats a provider-executed tool call without a result as unresolved', async () => {
    const harness = createReconnectHarness();
    const tracker = new UpstreamStepRecoveryTracker();

    await harness.agent.handleUiStream(
      makeUiStream([
        { type: 'start', messageId: 'assistant-stream' },
        {
          type: 'tool-input-available',
          toolCallId: 'provider-tool',
          toolName: 'provider_search',
          input: { query: 'status' },
          providerExecuted: true,
        },
      ]),
      undefined,
      7,
      tracker,
    );

    expect(tracker.snapshot()).toMatchObject({
      toolDispatched: true,
      dispatchedToolCallIds: ['provider-tool'],
      unresolvedToolCallIds: ['provider-tool'],
    });
    await harness.agent.handleUpstreamDisconnect(disconnectInput(tracker));
    expect(harness.state.error).toMatchObject({
      phase: 'unknown-tool-outcome',
      resumeMode: 'blocked',
    });
  });

  it('does not run a general approval sweep for a safe pre-output retry', async () => {
    vi.useFakeTimers();
    const approvalResponded = {
      id: 'assistant-approval',
      role: 'assistant',
      parts: [
        {
          type: 'tool-read',
          toolCallId: 'approved-read',
          state: 'approval-responded',
          input: { path: 'w1/file.ts' },
          approval: { id: 'approval-1', approved: true },
        },
      ],
    };
    const harness = createReconnectHarness({
      history: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Retry without touching approval' }],
        },
        structuredClone(approvalResponded),
      ],
    });
    const before = structuredClone(harness.state.history);

    await harness.agent.handleUpstreamDisconnect(
      disconnectInput(new UpstreamStepRecoveryTracker()),
    );

    expect(harness.applyAndPersistApprovalSweep).not.toHaveBeenCalled();
    expect(
      harness.terminateNonTerminalToolPartsInLastAssistant,
    ).not.toHaveBeenCalled();
    expect(harness.state.history).toEqual(before);
    expect(harness.agent._upstreamReconnectAttempts).toBe(1);
  });

  it('preserves a pending approval and does not reconnect automatically', async () => {
    vi.useFakeTimers();
    const pendingApproval = {
      id: 'assistant-pending-approval',
      role: 'assistant',
      parts: [
        {
          type: 'tool-write',
          toolCallId: 'write-awaiting-approval',
          state: 'approval-requested',
          input: { path: 'w1/file.ts', content: 'changed' },
          approval: { id: 'approval-pending' },
        },
      ],
    };
    const harness = createReconnectHarness({
      persistent: true,
      history: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Change the project' }],
        },
        structuredClone(pendingApproval),
      ],
    });
    const before = structuredClone(harness.state.history);

    await expect(
      harness.agent.handleUpstreamDisconnect(
        disconnectInput(new UpstreamStepRecoveryTracker()),
      ),
    ).resolves.toBe('completed');

    expect(harness.persist).toHaveBeenCalledWith({
      dirtyMessageIndices: [1],
      expectedMessageBindings: [
        { messageIndex: 1, messageId: 'assistant-pending-approval' },
      ],
      throwOnError: true,
    });
    expect(harness.state.history).toEqual(before);
    expect(
      harness.agent.populatePathReferencesOnAssistantMessage,
    ).toHaveBeenCalledWith(7);
    expect(harness.agent.scheduleMemorySnapshotWrite).toHaveBeenCalledWith(
      'post-step',
    );
    expect(harness.setIsWorkingFalse).toHaveBeenCalledOnce();
    expect(harness.applyAndPersistApprovalSweep).not.toHaveBeenCalled();
    expect(harness.removeTransportOnlyAssistantTail).not.toHaveBeenCalled();
    expect(harness.recordStepError).not.toHaveBeenCalled();
    expect(harness.agent.emitNotificationEvent).not.toHaveBeenCalled();
    expect(harness.agent._upstreamReconnectTimer).toBeNull();

    await vi.runAllTimersAsync();
    expect(harness.runStep).not.toHaveBeenCalled();
  });

  it('blocks an unresolved sibling tool even when another call is awaiting approval', async () => {
    const harness = createReconnectHarness({
      history: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Run both tools' }],
        },
        {
          id: 'assistant-parallel-tools',
          role: 'assistant',
          parts: [
            {
              type: 'tool-write',
              toolCallId: 'write-awaiting-approval',
              state: 'approval-requested',
              input: { path: 'w1/file.ts', content: 'changed' },
              approval: { id: 'approval-pending' },
            },
            {
              type: 'tool-shell',
              toolCallId: 'shell-unknown',
              state: 'input-available',
              input: { command: 'touch marker' },
            },
          ],
        },
      ],
    });
    const tracker = new UpstreamStepRecoveryTracker();
    tracker.markToolDispatched('shell-unknown');

    await harness.agent.handleUpstreamDisconnect(disconnectInput(tracker));

    expect(harness.state.error).toMatchObject({
      phase: 'unknown-tool-outcome',
      resumeMode: 'blocked',
    });
    expect(harness.setIsWorkingFalse).not.toHaveBeenCalled();
  });

  it('records completed tool evidence before blocking an unresolved later tool', async () => {
    const harness = createReconnectHarness({
      history: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Inspect, then change the file' }],
        },
        {
          id: 'assistant-mixed-tools',
          role: 'assistant',
          parts: [
            {
              type: 'tool-read',
              toolCallId: 'read-terminal',
              state: 'output-available',
              input: { path: 'w1/file.ts' },
              output: { message: 'contents' },
            },
            {
              type: 'tool-write',
              toolCallId: 'write-unknown',
              state: 'input-available',
              input: { path: 'w1/file.ts', content: 'changed' },
            },
          ],
        },
      ],
    });
    const tracker = new UpstreamStepRecoveryTracker();
    tracker.markToolDispatched('read-terminal');
    tracker.markToolTerminal('read-terminal');
    tracker.markToolDispatched('write-unknown');

    await expect(
      harness.agent.handleUpstreamDisconnect(disconnectInput(tracker)),
    ).resolves.toBe('failed');

    expect(
      harness.agent.emitDisconnectedTerminalToolEvents,
    ).toHaveBeenCalledWith(tracker);
    expect(
      harness.agent.populatePathReferencesOnAssistantMessage,
    ).toHaveBeenCalledWith(7);
    expect(harness.state.error).toMatchObject({
      phase: 'unknown-tool-outcome',
      resumeMode: 'blocked',
    });
  });

  it('terminates a non-dispatched external tool tail before blocking the route', async () => {
    const harness = createReconnectHarness({
      history: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Inspect the external state' }],
        },
        {
          id: 'assistant-external-tool',
          role: 'assistant',
          parts: [
            {
              type: 'tool-search',
              toolCallId: 'search-not-dispatched',
              state: 'input-available',
              input: { query: 'status' },
            },
          ],
        },
      ],
    });
    const tracker = new UpstreamStepRecoveryTracker();
    tracker.markOutputCommitted();

    await expect(
      harness.agent.handleUpstreamDisconnect(
        disconnectInput(tracker, { modelRouteBinding: 'external' }),
      ),
    ).resolves.toBe('failed');

    expect(
      harness.terminateNonTerminalToolPartsInLastAssistant,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        outputErrorText: expect.stringContaining('trusted terminal result'),
      }),
    );
    expect(harness.state.error).toMatchObject({
      phase: 'route-unverified',
      resumeMode: 'blocked',
    });
  });

  it('restores the approval origin scope before retrying an approval continuation', async () => {
    vi.useFakeTimers();
    const harness = createReconnectHarness();

    await expect(
      harness.agent.handleUpstreamDisconnect(
        disconnectInput(new UpstreamStepRecoveryTracker(), {
          isApprovalContinuation: true,
          toolCapabilityScopeId: 'retry-scope',
          approvalOriginScopeId: 'original-approval-scope',
        }),
      ),
    ).resolves.toBe('failed');

    expect(harness.agent._pendingToolCapabilityScopeId).toBe(
      'original-approval-scope',
    );
    expect(harness.applyAndPersistApprovalSweep).not.toHaveBeenCalled();
    expect(harness.removeTransportOnlyAssistantTail).toHaveBeenCalledWith({
      baselineMessageIds: ['user-1'],
    });
    expect(harness.runStep).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(harness.runStep).toHaveBeenCalledOnce();
    expect(harness.runStep).toHaveBeenCalledWith(true);
  });

  it('does not publish stale recovery state when superseded during strict persistence', async () => {
    const harness = createReconnectHarness({
      persistent: true,
      history: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Inspect the file' }],
        },
        {
          id: 'assistant-terminal',
          role: 'assistant',
          parts: [
            {
              type: 'tool-read',
              toolCallId: 'read-terminal',
              state: 'output-available',
              input: { path: 'w1/file.ts' },
              output: { message: 'contents' },
            },
          ],
        },
      ],
    });
    const persistenceBarrier = deferred<void>();
    const strictPersist = vi.fn(() => persistenceBarrier.promise);
    harness.agent.state.persist = strictPersist;
    const tracker = new UpstreamStepRecoveryTracker();
    tracker.markToolDispatched('read-terminal');
    tracker.markToolTerminal('read-terminal');

    const recovery = harness.agent.handleUpstreamDisconnect(
      disconnectInput(tracker),
    );
    await vi.waitFor(() => expect(strictPersist).toHaveBeenCalledOnce());

    harness.agent._stepGeneration = 8;
    persistenceBarrier.resolve();

    await expect(recovery).resolves.toBe('superseded');
    expect(harness.recordStepError).not.toHaveBeenCalled();
    expect(harness.agent.emitNotificationEvent).not.toHaveBeenCalled();
    expect(harness.agent._upstreamReconnectTimer).toBeNull();
    expect(harness.runStep).not.toHaveBeenCalled();
  });

  it('disables hidden provider retries from the first execution', async () => {
    const harness = createOnFinishDisconnectHarness();
    harness.agent._upstreamReconnectAttempts = 0;

    await expect(harness.agent.runAdmittedStep(false, 7)).resolves.toBe(
      'failed',
    );

    expect(harness.agent.stepExecutor.execute).toHaveBeenCalledOnce();
    const [request] = harness.agent.stepExecutor.execute.mock.calls[0];
    expect(request.options.maxRetries).toBe(0);
  });

  it('routes a pre-stream request-model disconnect into the reconnect handler', async () => {
    const harness = createOnFinishDisconnectHarness();
    harness.agent.stepExecutor = {
      resolveModelRouteBinding: vi.fn(() => 'request-model' as const),
      execute: vi.fn(async () => {
        throw {
          name: 'TypeError',
          message: 'fetch failed',
          cause: {
            code: 'UND_ERR_CONNECT_TIMEOUT',
            message: 'connect timeout',
          },
        };
      }),
    };

    await expect(harness.agent.runAdmittedStep(false, 7)).resolves.toBe(
      'failed',
    );

    expect(harness.agent.handleUpstreamDisconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRouteBinding: 'request-model',
        tracker: expect.any(UpstreamStepRecoveryTracker),
      }),
    );
  });

  it('tracks raw deltas and provider execution before UI smoothing', () => {
    const harness = createReconnectHarness();
    const tracker = new UpstreamStepRecoveryTracker();
    const identityState = {
      occurrenceCounts: new Map(),
      activeOccurrences: new Map(),
      pendingTerminalOccurrences: new Map(),
      pendingApprovalOccurrences: new Map(),
      ambiguousInputProviderIds: new Set(),
      ambiguousReferenceProviderIds: new Set(),
    };

    harness.agent.rewriteModelToolCallIdentityPart(
      { type: 'text-delta', id: 'text-1', delta: 'hello' },
      identityState,
      'stream',
      tracker,
    );
    harness.agent.rewriteModelToolCallIdentityPart(
      {
        type: 'tool-input-start',
        id: 'provider-tool',
        toolName: 'provider_search',
        providerExecuted: true,
      },
      identityState,
      'stream',
      tracker,
    );

    expect(tracker.snapshot()).toMatchObject({
      firstTokenObserved: true,
      toolDispatched: true,
      unresolvedToolCallIds: ['provider-tool'],
    });
  });

  it('blocks an exact completed local tool replay during reconnect continuation', async () => {
    const harness = createReconnectHarness({
      history: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Write once' }],
        },
        {
          id: 'assistant-write',
          role: 'assistant',
          parts: [
            {
              type: 'tool-write',
              toolCallId: 'write-terminal',
              state: 'output-available',
              input: { path: 'w1/file.ts', content: 'changed' },
              output: { ok: true },
            },
          ],
        },
      ],
    });
    const tracker = new UpstreamStepRecoveryTracker();
    tracker.markToolDispatched('write-terminal');
    tracker.markToolTerminal('write-terminal');
    harness.agent.captureCompletedToolSignaturesForReconnect(tracker);
    const effect = vi.fn(async () => ({ ok: true }));
    const wrapped = harness.agent.wrapToolsWithTiming({
      write: { execute: effect },
    });

    await expect(
      wrapped.write.execute(
        { path: 'w1/file.ts', content: 'changed' },
        { toolCallId: 'write-replayed' },
      ),
    ).rejects.toThrow('Reconnect safety blocked');
    expect(effect).not.toHaveBeenCalled();

    await expect(
      wrapped.write.execute(
        { path: 'w1/other.ts', content: 'different' },
        { toolCallId: 'write-new' },
      ),
    ).resolves.toEqual({ ok: true });
    expect(effect).toHaveBeenCalledOnce();
  });

  it('does not reset the reconnect budget when onFinish races after a captured disconnect', async () => {
    const harness = createOnFinishDisconnectHarness();

    await expect(harness.agent.runAdmittedStep(false, 7)).resolves.toBe(
      'failed',
    );

    expect(harness.agent.handleUpstreamDisconnect).toHaveBeenCalledOnce();
    expect(harness.getAttemptsObservedByDisconnectHandler()).toBe(3);
    expect(harness.agent._upstreamReconnectAttempts).toBe(3);
  });
});
