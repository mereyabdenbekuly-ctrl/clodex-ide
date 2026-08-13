import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../types/agent';
import { BaseAgent } from './base-agent';
import { HistoryCompressionUnsettledTimeoutError } from './shared/history-compression';

type CompressionState = {
  activeModelId: string;
  usedTokens: number;
  history: AgentMessage[];
};

type CompressionHarness = {
  config: {
    persistent: boolean;
    historyCompressionThreshold: number;
    minUncompressedMessages: number;
    maxOutputTokens?: number;
  };
  instanceId: string;
  _stepGeneration: number;
  _stepResolvedModelId: string;
  _isCompressingHistory: boolean;
  _historyCompressionAbortController: AbortController | null;
  _historyCompressionGenerationFailures: number;
  _historyCompressionRetryNotBefore: number;
  stepAbortController: AbortController | null;
  _recoveredReplayExecutionId: string | null;
  host: {
    models: { getWithOptions: ReturnType<typeof vi.fn> };
    logger: {
      debug: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    };
  };
  state: {
    get: () => CompressionState;
    commands: {
      storeCompressedHistory: ReturnType<typeof vi.fn>;
      restoreCompressedHistory: ReturnType<typeof vi.fn>;
    };
    persist: ReturnType<typeof vi.fn>;
  };
  compressHistory: ReturnType<typeof vi.fn>;
  scheduleMemorySnapshotWrite: ReturnType<typeof vi.fn>;
  recordEvidenceEvent: ReturnType<typeof vi.fn>;
  report: ReturnType<typeof vi.fn>;
  maybeCompressHistoryAfterStep: (
    expectedStepGeneration: number,
    contextWindowSize: number,
  ) => Promise<void>;
  supersedeCurrentStep: () => void;
};

function makeMessage(index: number): AgentMessage {
  return {
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    parts: [
      {
        type: 'text',
        text: `${index}: ${'context '.repeat(40)}`,
        ...(index % 2 === 0 ? {} : { state: 'done' as const }),
      },
    ],
    metadata: { createdAt: new Date(), partsMetadata: [{}] },
  } as AgentMessage;
}

function prepareLargeCriticalHistory(
  state: CompressionState,
  usedTokens = 161_166,
): void {
  state.usedTokens = usedTokens;
  state.history[0]!.parts = [
    {
      type: 'text',
      text: `0: INITIAL_GOAL ${'historic context '.repeat(30_000)}`,
    },
  ];
  state.history[8]!.parts = [
    {
      type: 'text',
      text: '8: LATEST_COMPACTED_STATE continue the active implementation safely',
    },
  ];
}

function prepareSmallWindowCriticalHistory(state: CompressionState): void {
  state.usedTokens = 6_401;
  state.history[0]!.parts = [
    {
      type: 'text',
      text: `0: SMALL_WINDOW_GOAL ${'a'.repeat(6_000)}`,
    },
  ];
  state.history[8]!.parts = [
    {
      type: 'text',
      text: '8: SMALL_WINDOW_LATEST_STATE',
    },
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
}

function createCompressionHarness(persistent = true) {
  const history = Array.from({ length: 14 }, (_, index) => makeMessage(index));
  const state: CompressionState = {
    activeModelId: 'test-model',
    usedTokens: 2_001,
    history,
  };
  const compression = deferred<string>();
  const storeCompressedHistory = vi.fn(
    (args: {
      boundaryMessageId: string;
      compactedMessageIds: readonly string[];
      compressedHistory: string;
      expectedUsedTokens: number;
      postCompressionUsedTokens: number;
    }) => {
      const boundaryIndex = state.history.findIndex(
        (message) => message.id === args.boundaryMessageId,
      );
      if (boundaryIndex < 0) return 'missing' as const;
      if (
        boundaryIndex !== args.compactedMessageIds.length ||
        args.compactedMessageIds.some(
          (messageId, index) => state.history[index]?.id !== messageId,
        )
      ) {
        return 'stale' as const;
      }
      if (state.usedTokens !== args.expectedUsedTokens) {
        return 'usage-stale' as const;
      }
      state.history[boundaryIndex]!.metadata!.compressedHistory =
        args.compressedHistory;
      state.usedTokens = args.postCompressionUsedTokens;
      return 'written' as const;
    },
  );
  const restoreCompressedHistory = vi.fn(
    (args: {
      boundaryMessageId: string;
      expectedCompressedHistory: string;
      previousCompressedHistory: string | undefined;
      expectedUsedTokens: number;
      previousUsedTokens: number;
    }) => {
      const boundary = state.history.find(
        (message) => message.id === args.boundaryMessageId,
      );
      if (!boundary) return 'missing' as const;
      if (
        boundary.metadata?.compressedHistory !== args.expectedCompressedHistory
      ) {
        return 'mismatch' as const;
      }
      if (state.usedTokens !== args.expectedUsedTokens) {
        return 'usage-mismatch' as const;
      }
      if (args.previousCompressedHistory === undefined) {
        delete boundary.metadata!.compressedHistory;
      } else {
        boundary.metadata!.compressedHistory = args.previousCompressedHistory;
      }
      state.usedTokens = args.previousUsedTokens;
      return 'restored' as const;
    },
  );

  const agent = Object.create(BaseAgent.prototype) as CompressionHarness;
  Object.defineProperties(agent, {
    config: {
      value: {
        persistent,
        historyCompressionThreshold: 0.5,
        minUncompressedMessages: 5,
      },
    },
    agentType: { value: 'chat' },
  });
  agent.instanceId = 'agent-1';
  agent._stepGeneration = 7;
  agent._stepResolvedModelId = 'test-model';
  agent._isCompressingHistory = false;
  agent._historyCompressionAbortController = null;
  agent._historyCompressionGenerationFailures = 0;
  agent._historyCompressionRetryNotBefore = 0;
  agent.stepAbortController = null;
  agent._recoveredReplayExecutionId = null;
  agent.host = {
    models: {
      getWithOptions: vi.fn(async () => ({ contextWindowSize: 4_000 })),
    },
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  agent.state = {
    get: () => state,
    commands: { storeCompressedHistory, restoreCompressedHistory },
    persist: vi.fn(async () => {}),
  };
  agent.compressHistory = vi.fn(async () => await compression.promise);
  agent.scheduleMemorySnapshotWrite = vi.fn();
  agent.recordEvidenceEvent = vi.fn();
  agent.report = vi.fn();

  return {
    agent,
    state,
    compression,
    storeCompressedHistory,
    restoreCompressedHistory,
  };
}

function makeSuccessfulStepResult() {
  return {
    finishReason: 'stop',
    rawFinishReason: undefined,
    usage: {
      inputTokens: 1,
      inputTokenDetails: {
        noCacheTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokens: 1,
      outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
      totalTokens: 2,
    },
    totalUsage: {
      inputTokens: 1,
      inputTokenDetails: {
        noCacheTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokens: 1,
      outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
      totalTokens: 2,
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
      id: 'response-recovered',
      timestamp: new Date(),
      modelId: 'test-model',
      messages: [],
    },
    warnings: undefined,
    providerMetadata: undefined,
    steps: [],
  };
}

function createPreStepRecoveryHarness(options?: {
  compression?: ReturnType<typeof deferred<string>>;
  queuedUserBoundary?: boolean;
}) {
  const events: string[] = [];
  const terminalEffect = {
    type: 'tool-multiEdit',
    toolCallId: 'multi-edit-already-completed',
    state: 'output-available',
    input: {
      path: 'w1/src/already-edited.ts',
      edits: [{ oldText: 'before', newText: 'after' }],
    },
    output: { success: true },
  } as any;
  const history = Array.from({ length: 10 }, (_, index) => makeMessage(index));
  history[8]!.metadata!.compressedHistory =
    'The latest durable briefing before the oversized assistant tail.';
  history[9] = {
    id: 'assistant-critical-tail',
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text: `Critical retained tail ${'large tool context '.repeat(20_000)}`,
        state: 'done',
      },
      terminalEffect,
    ],
    metadata: { createdAt: new Date(), partsMetadata: [{}, {}] },
  } as AgentMessage;
  const queuedUserMessage = {
    id: 'user-recovery-boundary',
    role: 'user',
    parts: [{ type: 'text', text: 'Continue after recovering the context.' }],
    metadata: { createdAt: new Date(), partsMetadata: [{}] },
  } as AgentMessage;
  const state: any = {
    activeModelId: 'test-model',
    usedTokens: 193_505,
    history,
    queuedMessages:
      options?.queuedUserBoundary === false ? [] : [queuedUserMessage],
    error: {
      message:
        'Context compression failed before the next step at critical occupancy',
      retryable: false,
    },
  };
  const storeCompressedHistory = vi.fn(
    (args: {
      boundaryMessageId: string;
      compactedMessageIds: readonly string[];
      compressedHistory: string;
      expectedUsedTokens: number;
      postCompressionUsedTokens: number;
    }) => {
      events.push('store-compression');
      const boundaryIndex = state.history.findIndex(
        (message: AgentMessage) => message.id === args.boundaryMessageId,
      );
      if (boundaryIndex < 0) return 'missing' as const;
      if (
        boundaryIndex !== args.compactedMessageIds.length ||
        args.compactedMessageIds.some(
          (messageId, index) => state.history[index]?.id !== messageId,
        )
      ) {
        return 'stale' as const;
      }
      if (state.usedTokens !== args.expectedUsedTokens) {
        return 'usage-stale' as const;
      }
      state.history[boundaryIndex] = {
        ...state.history[boundaryIndex],
        metadata: {
          ...state.history[boundaryIndex].metadata,
          compressedHistory: args.compressedHistory,
        },
      };
      state.usedTokens = args.postCompressionUsedTokens;
      return 'written' as const;
    },
  );
  const restoreCompressedHistory = vi.fn(() => 'restored' as const);
  const persist = vi.fn(async () => {
    events.push('persist-compression');
  });
  const beginStep = vi.fn(({ flushQueue }: { flushQueue: boolean }) => {
    if (!flushQueue || state.queuedMessages.length === 0) {
      return { queueFlushIndex: undefined };
    }
    const queueFlushIndex = state.history.length;
    state.history.push(...state.queuedMessages);
    state.queuedMessages = [];
    return { queueFlushIndex };
  });
  const recordStepError = vi.fn(({ error }: { error: unknown }) => {
    state.error = error;
  });
  const recordUsage = vi.fn(() => {
    // Model usage for the recovered request replaces the stale persisted
    // occupancy before the existing post-step barrier runs.
    state.usedTokens = 2;
  });

  const agent = Object.create(BaseAgent.prototype) as any;
  Object.defineProperties(agent, {
    config: {
      value: {
        persistent: true,
        historyCompressionThreshold: 0.5,
        minUncompressedMessages: 5,
        maxOutputTokens: 1_024,
        generateTitles: false,
      },
    },
    agentType: { value: 'chat' },
  });
  agent.instanceId = 'agent-pre-step-recovery';
  agent._stepGeneration = 7;
  agent._stepResolvedModelId = '';
  agent._stepResolvedMaxOutputTokens = undefined;
  agent._isCompressingHistory = false;
  agent._historyCompressionAbortController = null;
  agent._historyCompressionGenerationFailures = 0;
  agent._historyCompressionRetryNotBefore = 0;
  agent._pendingContinue = null;
  agent._pendingSyntheticContinuation = null;
  agent._pendingToolCallRecoveryExhaustion = null;
  agent._pendingToolCapabilityScopeId = null;
  agent._upstreamReconnectTurnId = null;
  agent._upstreamReconnectAttempts = 0;
  agent._upstreamReconnectNeedsContinuation = false;
  agent._upstreamReconnectCompletedToolSignatures = new Set();
  agent._upstreamReconnectTimer = null;
  agent._recoveredReplayExecutionId = null;
  agent._recoveredReplayStepGeneration = null;
  agent._closedRecoveredReplayExecutionIds = new Set();
  agent._cacheAnalyzer = { trackStep: vi.fn() };
  agent._toolCallExecutions = new Map();
  agent._toolCallAdmissions = new Map();
  agent._toolCallProviderIds = new Map();
  agent._preRejectedToolCalls = new Map();
  agent._duplicateToolCallRejectionsByError = new WeakMap();
  agent._duplicateToolCallRejectionsByMessage = new Map();
  agent.stepAbortController = null;
  agent.state = {
    get: () => state,
    persist,
    commands: {
      beginStep,
      storeCompressedHistory,
      restoreCompressedHistory,
      recordStepError,
      recordUsage,
      setIsWorkingFalse: vi.fn(),
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
  let resolvedMaxOutputTokensSeenByCompression: number | undefined;
  let compressionSignal: AbortSignal | undefined;
  const compression = options?.compression;
  agent.compressHistory = vi.fn(
    async (messages: AgentMessage[], signal?: AbortSignal) => {
      events.push('compress-history');
      compressionSignal = signal;
      resolvedMaxOutputTokensSeenByCompression =
        agent._stepResolvedMaxOutputTokens;
      if (compression) return await compression.promise;
      const completedEffect = messages
        .flatMap((message) => message.parts)
        .find(
          (part: any) =>
            part.toolCallId === terminalEffect.toolCallId &&
            part.state === 'output-available',
        );
      return `Recovered continuity summary; completed effect receipt: ${completedEffect?.toolCallId ?? 'missing'}.`;
    },
  );
  agent.getModelSettings = vi.fn(async () => {
    events.push('resolve-config');
    return { maxOutputTokens: 4_096 };
  });
  let compressedHistorySeenByContext: string | undefined;
  let usedTokensSeenByContext: number | undefined;
  agent.generateContextForNewStep = vi.fn(async () => {
    events.push('generate-context');
    usedTokensSeenByContext = state.usedTokens;
    compressedHistorySeenByContext = state.history.find(
      (message: AgentMessage) => message.id === queuedUserMessage.id,
    )?.metadata?.compressedHistory;
    return [{ role: 'user', content: 'continue safely' }];
  });
  const effectExecution = vi.fn(async () => ({ success: true }));
  agent.getToolsForStep = vi.fn(async () => {
    events.push('get-tools');
    return { multiEdit: { execute: effectExecution } };
  });
  agent.resetToolCallExecutionTracking = vi.fn();
  agent.wrapToolsWithTiming = vi.fn((tools) => tools);
  agent.wrapToolsWithOutputBudget = vi.fn((tools) => tools);
  agent.wrapModelWithToolCallIdentityFence = vi.fn((model) => model);
  agent.getExecutionTargetForCurrentTurn = vi.fn(() => undefined);
  agent.updateTitle = vi.fn(async () => {});
  agent.handleUiStream = vi.fn(async () => {});
  agent.handlePostStep = vi.fn(async () => false);
  agent.populatePathReferencesOnAssistantMessage = vi.fn(async () => {});
  agent.populatePathReferencesOnUserMessages = vi.fn(async () => {});
  agent.saveState = vi.fn(async () => {});
  agent.scheduleMemorySnapshotWrite = vi.fn();
  agent.recordEvidenceEvent = vi.fn();
  agent.onIdle = vi.fn(async () => {});
  agent.emitNotificationEvent = vi.fn();
  agent.report = vi.fn();
  const execute = vi.fn(async (request: any) => {
    events.push('provider-execute');
    return {
      modelRouteBinding: 'request-model' as const,
      toUIMessageStream: vi.fn(() => null),
      consumeStream: vi.fn(async () => {
        await request.options.onFinish?.(makeSuccessfulStepResult());
      }),
    };
  });
  agent.stepExecutor = { execute };

  return {
    agent,
    state,
    events,
    queuedUserMessage,
    terminalEffect,
    effectExecution,
    execute,
    beginStep,
    persist,
    storeCompressedHistory,
    getResolvedMaxOutputTokensSeenByCompression: () =>
      resolvedMaxOutputTokensSeenByCompression,
    getCompressedHistorySeenByContext: () => compressedHistorySeenByContext,
    getUsedTokensSeenByContext: () => usedTokensSeenByContext,
    getCompressionSignal: () => compressionSignal,
  };
}

describe('BaseAgent history-compression admission barrier', () => {
  it('waits for and durably stores compression before the step may settle', async () => {
    const { agent, state, compression, storeCompressedHistory } =
      createCompressionHarness();
    let settled = false;

    const barrier = agent.maybeCompressHistoryAfterStep(7, 4_000).then(() => {
      settled = true;
    });

    await vi.waitFor(() =>
      expect(agent.compressHistory).toHaveBeenCalledOnce(),
    );
    expect(settled).toBe(false);
    expect(storeCompressedHistory).not.toHaveBeenCalled();

    compression.resolve('A durable compressed history that is long enough.');
    await barrier;

    expect(storeCompressedHistory).toHaveBeenCalledOnce();
    expect(agent.state.persist).toHaveBeenCalledWith({
      dirtyMessageIndices: [expect.any(Number)],
      expectedMessageBindings: [
        {
          messageIndex: expect.any(Number),
          messageId: expect.stringMatching(/^message-/),
        },
      ],
      throwOnError: true,
    });
    expect(
      state.history.some(
        (message) =>
          message.metadata?.compressedHistory ===
          'A durable compressed history that is long enough.',
      ),
    ).toBe(true);
    expect(agent.scheduleMemorySnapshotWrite).toHaveBeenCalledWith(
      'compression',
    );
    expect(agent.recordEvidenceEvent).toHaveBeenCalledWith(
      'compression_completed',
      expect.objectContaining({ compactedMessageCount: expect.any(Number) }),
      expect.any(Object),
    );
  });

  it('discards a summary when a priority lifecycle action supersedes the step', async () => {
    const { agent, compression, storeCompressedHistory } =
      createCompressionHarness();

    const barrier = agent.maybeCompressHistoryAfterStep(7, 4_000);
    await vi.waitFor(() =>
      expect(agent.compressHistory).toHaveBeenCalledOnce(),
    );

    agent._stepGeneration = 8;
    compression.resolve('This stale summary must never be attached.');
    await barrier;

    expect(storeCompressedHistory).not.toHaveBeenCalled();
    expect(agent.state.persist).not.toHaveBeenCalled();
    expect(agent.scheduleMemorySnapshotWrite).not.toHaveBeenCalled();
  });

  it('uses a fresh compression signal instead of an already-aborted step signal', async () => {
    const { agent } = createCompressionHarness();
    const finishedStepController = new AbortController();
    finishedStepController.abort();
    agent.stepAbortController = finishedStepController;
    let compressionSignal: AbortSignal | undefined;
    agent.compressHistory.mockImplementationOnce(
      async (_history: AgentMessage[], signal?: AbortSignal) => {
        compressionSignal = signal;
        return 'A summary generated in an independent cancellation scope.';
      },
    );

    await agent.maybeCompressHistoryAfterStep(7, 4_000);

    expect(compressionSignal).toBeInstanceOf(AbortSignal);
    expect(compressionSignal).not.toBe(finishedStepController.signal);
    expect(compressionSignal?.aborted).toBe(false);
  });

  it('treats pre-mutation generation failure as transient and backs off below critical occupancy', async () => {
    const { agent, storeCompressedHistory } = createCompressionHarness();
    agent.compressHistory.mockRejectedValueOnce(
      new DOMException('The operation was aborted', 'AbortError'),
    );

    await expect(
      agent.maybeCompressHistoryAfterStep(7, 4_000),
    ).resolves.toBeUndefined();

    expect(storeCompressedHistory).not.toHaveBeenCalled();
    expect(agent.state.persist).not.toHaveBeenCalled();
    expect(agent.report).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AbortError' }),
      'compressHistoryGenerationTransient',
    );
    expect(agent._historyCompressionGenerationFailures).toBe(1);
    expect(agent._historyCompressionRetryNotBefore).toBeGreaterThan(Date.now());

    await agent.maybeCompressHistoryAfterStep(7, 4_000);
    expect(agent.compressHistory).toHaveBeenCalledTimes(1);
  });

  it('aborts a stopped compression without fallback, storage, reporting, or retry backoff', async () => {
    const { agent, storeCompressedHistory } = createCompressionHarness();
    const started = deferred<void>();
    let stoppedSignal: AbortSignal | undefined;
    agent.compressHistory.mockImplementationOnce(
      async (_history: AgentMessage[], signal?: AbortSignal) => {
        stoppedSignal = signal;
        started.resolve();
        return await new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );

    const stoppedBarrier = agent.maybeCompressHistoryAfterStep(7, 4_000);
    await started.promise;
    agent.supersedeCurrentStep();
    await expect(stoppedBarrier).resolves.toBeUndefined();

    expect(stoppedSignal?.aborted).toBe(true);
    expect(storeCompressedHistory).not.toHaveBeenCalled();
    expect(agent.state.persist).not.toHaveBeenCalled();
    expect(agent.report).not.toHaveBeenCalled();
    expect(agent._historyCompressionGenerationFailures).toBe(0);
    expect(agent._historyCompressionRetryNotBefore).toBe(0);

    let retrySignal: AbortSignal | undefined;
    agent.compressHistory.mockImplementationOnce(
      async (_history: AgentMessage[], signal?: AbortSignal) => {
        retrySignal = signal;
        return 'A fresh compression succeeds after the user starts again.';
      },
    );
    await agent.maybeCompressHistoryAfterStep(8, 4_000);

    expect(retrySignal).toBeInstanceOf(AbortSignal);
    expect(retrySignal).not.toBe(stoppedSignal);
    expect(retrySignal?.aborted).toBe(false);
    expect(storeCompressedHistory).toHaveBeenCalledOnce();
  });

  it('stores a deterministic fallback and continues at critical occupancy', async () => {
    const { agent, state, storeCompressedHistory } = createCompressionHarness();
    prepareLargeCriticalHistory(state);
    agent.compressHistory.mockRejectedValueOnce(
      new Error('all compression routes unavailable'),
    );

    await expect(
      agent.maybeCompressHistoryAfterStep(7, 200_000),
    ).resolves.toBeUndefined();

    expect(agent.compressHistory).toHaveBeenCalledOnce();
    expect(storeCompressedHistory).toHaveBeenCalledOnce();
    const storedHistory =
      storeCompressedHistory.mock.calls[0]?.[0]?.compressedHistory;
    expect(storedHistory).toContain('## Emergency continuity snapshot');
    expect(storedHistory).toContain('INITIAL_GOAL');
    expect(storedHistory).toContain('LATEST_COMPACTED_STATE');
    expect(new TextEncoder().encode(storedHistory).length).toBeLessThanOrEqual(
      30_000,
    );
    expect(state.history).toHaveLength(14);
    expect(state.usedTokens).toBeLessThan(160_000);
    expect(agent.state.persist).toHaveBeenCalledOnce();
    expect(agent.report).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'all compression routes unavailable',
      }),
      'compressHistoryGenerationEmergencyFallback',
    );
    expect(agent._historyCompressionGenerationFailures).toBe(0);
    expect(agent._historyCompressionRetryNotBefore).toBe(0);
    expect(agent.recordEvidenceEvent).toHaveBeenCalledWith(
      'compression_completed',
      expect.objectContaining({
        strategy: 'deterministic-emergency',
        generationFailureCount: 1,
        postCompressionUsedTokens: state.usedTokens,
        emergencyProjection: expect.objectContaining({
          targetInputTokens: 140_000,
          outputReserveTokens: 40_000,
          generalReserveTokens: 20_000,
          projectedInputTokens: expect.any(Number),
          snapshotTokenUpperBound: expect.any(Number),
        }),
      }),
      expect.any(Object),
    );
  });

  it('shrinks the emergency snapshot budget for a small context window', async () => {
    const { agent, state, storeCompressedHistory } = createCompressionHarness();
    prepareSmallWindowCriticalHistory(state);
    agent.compressHistory.mockRejectedValueOnce(
      new Error('all compression routes unavailable'),
    );

    await expect(
      agent.maybeCompressHistoryAfterStep(7, 8_000),
    ).resolves.toBeUndefined();

    const storedHistory =
      storeCompressedHistory.mock.calls[0]?.[0]?.compressedHistory;
    const snapshotUtf8Bytes = new TextEncoder().encode(storedHistory).length;
    expect(snapshotUtf8Bytes).toBeLessThan(5_600);
    expect(agent.recordEvidenceEvent).toHaveBeenCalledWith(
      'compression_completed',
      expect.objectContaining({
        emergencyProjection: expect.objectContaining({
          targetInputTokens: 5_600,
          outputReserveTokens: 1_600,
          generalReserveTokens: 800,
          snapshotTokenUpperBound: snapshotUtf8Bytes,
          projectedInputTokens: expect.any(Number),
        }),
      }),
      expect.any(Object),
    );
  });

  it('folds a same-boundary prior briefing into a later emergency boundary', async () => {
    const { agent, state, storeCompressedHistory } = createCompressionHarness();
    state.usedTokens = 8_001;
    state.history[9]!.metadata!.compressedHistory =
      `PRIOR_BRIEFING_START ${'p'.repeat(19_000)} PRIOR_TOOL_RECEIPT_END`;
    agent.compressHistory.mockRejectedValueOnce(
      new Error('all compression routes unavailable'),
    );

    await expect(
      agent.maybeCompressHistoryAfterStep(7, 10_000),
    ).resolves.toBeUndefined();

    expect(storeCompressedHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        boundaryMessageId: 'message-10',
        compactedMessageIds: expect.arrayContaining(['message-9']),
        compressedHistory: expect.stringContaining('PRIOR_TOOL_RECEIPT_END'),
      }),
    );
  });

  it('fails closed when no boundary exists after the latest durable briefing', async () => {
    const { agent, state, storeCompressedHistory } = createCompressionHarness();
    state.usedTokens = 8_001;
    state.history.at(-1)!.metadata!.compressedHistory =
      'The latest message already carries the durable briefing.';

    await expect(
      agent.maybeCompressHistoryAfterStep(7, 10_000),
    ).rejects.toMatchObject({ retryable: false });

    expect(agent.compressHistory).not.toHaveBeenCalled();
    expect(storeCompressedHistory).not.toHaveBeenCalled();
  });

  it('reserves retained file injections and fails closed when they consume the safe input budget', async () => {
    const { agent, state, storeCompressedHistory } = createCompressionHarness();
    prepareSmallWindowCriticalHistory(state);
    state.history[10]!.metadata!.pathReferences = {
      'w1/a.ts': 'a',
      'w1/b.ts': 'b',
    };
    agent.compressHistory.mockRejectedValueOnce(
      new Error('all compression routes unavailable'),
    );

    await expect(
      agent.maybeCompressHistoryAfterStep(7, 8_000),
    ).rejects.toMatchObject({ retryable: false });

    expect(storeCompressedHistory).not.toHaveBeenCalled();
  });

  it('deduplicates repeated retained user previews by path and content hash', async () => {
    const { agent, state } = createCompressionHarness();
    prepareLargeCriticalHistory(state);
    state.history[10]!.metadata!.pathReferences = { 'w1/shared.ts': 'hash-1' };
    state.history[12]!.metadata!.pathReferences = { 'w1/shared.ts': 'hash-1' };
    agent.compressHistory.mockRejectedValueOnce(
      new Error('all compression routes unavailable'),
    );

    await expect(
      agent.maybeCompressHistoryAfterStep(7, 200_000),
    ).resolves.toBeUndefined();

    expect(agent.recordEvidenceEvent).toHaveBeenCalledWith(
      'compression_completed',
      expect.objectContaining({
        emergencyProjection: expect.objectContaining({
          retainedFileInjectionTokens: 10_512,
        }),
      }),
      expect.any(Object),
    );
  });

  it('reserves the resolved maximum output budget before admitting a fallback', async () => {
    const { agent, state, storeCompressedHistory } = createCompressionHarness();
    prepareSmallWindowCriticalHistory(state);
    agent.config.maxOutputTokens = 6_000;
    agent.compressHistory.mockRejectedValueOnce(
      new Error('all compression routes unavailable'),
    );

    await expect(
      agent.maybeCompressHistoryAfterStep(7, 8_000),
    ).rejects.toMatchObject({ retryable: false });

    expect(storeCompressedHistory).not.toHaveBeenCalled();
  });

  it('fails closed when a retained CJK tail exceeds the conservative input budget', async () => {
    const { agent, state, storeCompressedHistory } = createCompressionHarness();
    prepareSmallWindowCriticalHistory(state);
    for (let index = 9; index < state.history.length; index += 1) {
      const message = state.history[index]!;
      message.parts = [
        {
          type: 'text',
          text: `RETAINED_CJK_${index} ${'界'.repeat(500)}`,
          ...(message.role === 'assistant' ? { state: 'done' as const } : {}),
        },
      ];
    }
    agent.compressHistory.mockRejectedValueOnce(
      new Error('all compression routes unavailable'),
    );

    await expect(
      agent.maybeCompressHistoryAfterStep(7, 8_000),
    ).rejects.toMatchObject({ retryable: false });

    expect(storeCompressedHistory).not.toHaveBeenCalled();
  });

  it('rebuilds the emergency prefix from current same-id message content', async () => {
    const { agent, state, compression, storeCompressedHistory } =
      createCompressionHarness();
    prepareSmallWindowCriticalHistory(state);

    const barrier = agent.maybeCompressHistoryAfterStep(7, 8_000);
    await vi.waitFor(() =>
      expect(agent.compressHistory).toHaveBeenCalledOnce(),
    );
    state.history[0] = {
      ...state.history[0]!,
      parts: [
        {
          type: 'text',
          text: `0: CURRENT_SAME_ID_CONTENT ${'b'.repeat(6_000)}`,
        },
      ],
    } as AgentMessage;
    compression.reject(new Error('all compression routes unavailable'));

    await expect(barrier).resolves.toBeUndefined();
    const storedHistory =
      storeCompressedHistory.mock.calls[0]?.[0]?.compressedHistory;
    expect(storedHistory).toContain('CURRENT_SAME_ID_CONTENT');
    expect(storedHistory).not.toContain('SMALL_WINDOW_GOAL');
  });

  it.each([
    ['missing', 'boundary message missing'],
    ['stale', 'history prefix changed'],
    ['usage-stale', 'context occupancy changed'],
  ] as const)('fails closed when the critical exact-prefix store is %s', async (writeResult, expectedMessage) => {
    const { agent, state, compression, storeCompressedHistory } =
      createCompressionHarness();
    state.usedTokens = 3_200;
    storeCompressedHistory.mockReturnValueOnce(writeResult);

    const barrier = agent.maybeCompressHistoryAfterStep(7, 4_000);
    await vi.waitFor(() =>
      expect(agent.compressHistory).toHaveBeenCalledOnce(),
    );
    compression.resolve('A model summary whose prefix binding became stale.');

    await expect(barrier).rejects.toMatchObject({
      message: expect.stringContaining(expectedMessage),
      retryable: false,
    });
    expect(agent.state.persist).not.toHaveBeenCalled();
    expect(agent.recordEvidenceEvent).not.toHaveBeenCalled();
  });

  it('rolls back a critical deterministic fallback when persistence rejects', async () => {
    const { agent, state, restoreCompressedHistory } =
      createCompressionHarness();
    prepareLargeCriticalHistory(state);
    agent.compressHistory.mockRejectedValueOnce(
      new Error('all compression routes unavailable'),
    );
    agent.state.persist.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    await expect(
      agent.maybeCompressHistoryAfterStep(7, 200_000),
    ).rejects.toMatchObject({ retryable: false });

    expect(restoreCompressedHistory).toHaveBeenCalledOnce();
    expect(
      state.history.some(
        (message) => message.metadata?.compressedHistory !== undefined,
      ),
    ).toBe(false);
    expect(agent.recordEvidenceEvent).not.toHaveBeenCalled();
    expect(agent._historyCompressionGenerationFailures).toBe(1);
    expect(state.usedTokens).toBe(161_166);
  });

  it('fails closed instead of archiving an ambiguous tool outcome locally', async () => {
    const { agent, state, storeCompressedHistory } = createCompressionHarness();
    prepareLargeCriticalHistory(state);
    state.history[2]!.parts = [
      {
        type: 'tool-write',
        toolCallId: 'write-with-unknown-outcome',
        state: 'input-available',
        input: { path: 'w1/src/file.ts', content: 'changed' },
      },
    ] as any;
    agent.compressHistory.mockRejectedValueOnce(
      new Error('all compression routes unavailable'),
    );

    await expect(
      agent.maybeCompressHistoryAfterStep(7, 200_000),
    ).rejects.toMatchObject({ retryable: false });

    expect(storeCompressedHistory).not.toHaveBeenCalled();
    expect(agent.state.persist).not.toHaveBeenCalled();
    expect(agent.recordEvidenceEvent).not.toHaveBeenCalled();
  });

  it('fails closed instead of overlapping a compressor that ignored abort', async () => {
    const { agent, storeCompressedHistory } = createCompressionHarness();
    agent.compressHistory.mockRejectedValueOnce(
      new HistoryCompressionUnsettledTimeoutError('stuck-model'),
    );

    await expect(
      agent.maybeCompressHistoryAfterStep(7, 4_000),
    ).rejects.toMatchObject({ retryable: false });

    expect(storeCompressedHistory).not.toHaveBeenCalled();
    expect(agent.state.persist).not.toHaveBeenCalled();
    expect(agent._historyCompressionGenerationFailures).toBe(0);
    expect(agent._historyCompressionRetryNotBefore).toBe(0);
  });

  it('rolls back and fails closed when strict persistence rejects', async () => {
    const { agent, state, compression, restoreCompressedHistory } =
      createCompressionHarness();
    agent.state.persist.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    const barrier = agent.maybeCompressHistoryAfterStep(7, 4_000);
    await vi.waitFor(() =>
      expect(agent.compressHistory).toHaveBeenCalledOnce(),
    );
    compression.resolve('A summary that must be rolled back after failure.');

    await expect(barrier).rejects.toThrow(
      'Context compression failed before the next step',
    );
    await expect(barrier).rejects.toMatchObject({ retryable: false });
    expect(restoreCompressedHistory).toHaveBeenCalledOnce();
    expect(
      state.history.some(
        (message) => message.metadata?.compressedHistory !== undefined,
      ),
    ).toBe(false);
    expect(agent.scheduleMemorySnapshotWrite).not.toHaveBeenCalled();
    expect(agent.recordEvidenceEvent).not.toHaveBeenCalled();
    expect(agent.report).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'History compression could not be persisted durably',
      }),
      'compressHistory',
    );
  });

  it('does not mislabel persistence rollback failures as recovery phases', async () => {
    const { agent, compression, restoreCompressedHistory } =
      createCompressionHarness();
    agent.state.persist.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    restoreCompressedHistory.mockReturnValueOnce('usage-mismatch');

    const barrier = agent.maybeCompressHistoryAfterStep(7, 4_000);
    await vi.waitFor(() =>
      expect(agent.compressHistory).toHaveBeenCalledOnce(),
    );
    compression.resolve('A summary whose rollback must fail closed.');

    const failure = await barrier.catch((error: unknown) => error);
    expect(failure).toMatchObject({ retryable: false });
    expect(failure).not.toHaveProperty('recoveryDiagnostics.0');
    expect(agent.report).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'History compression persistence and exact in-memory rollback failed',
      }),
      'compressHistory',
    );
  });

  it('keeps non-persistent agents out of durable agent storage', async () => {
    const { agent, state, compression } = createCompressionHarness(false);

    const barrier = agent.maybeCompressHistoryAfterStep(7, 4_000);
    await vi.waitFor(() =>
      expect(agent.compressHistory).toHaveBeenCalledOnce(),
    );
    compression.resolve('An in-memory summary for a non-persistent agent.');
    await barrier;

    expect(agent.state.persist).not.toHaveBeenCalled();
    expect(
      state.history.some(
        (message) =>
          message.metadata?.compressedHistory ===
          'An in-memory summary for a non-persistent agent.',
      ),
    ).toBe(true);
  });
});

describe('BaseAgent pre-step history-compression admission', () => {
  it('recovers a persisted critical task at a new queued-user boundary before one provider step', async () => {
    const compression = deferred<string>();
    const harness = createPreStepRecoveryHarness({ compression });

    const step = harness.agent.runAdmittedStep(false, 7);
    await vi.waitFor(() =>
      expect(harness.agent.compressHistory).toHaveBeenCalledOnce(),
    );

    expect(harness.events).toEqual(['resolve-config', 'compress-history']);
    expect(harness.agent.generateContextForNewStep).not.toHaveBeenCalled();
    expect(harness.agent.getToolsForStep).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.getResolvedMaxOutputTokensSeenByCompression()).toBe(4_096);

    compression.resolve(
      `Recovered continuity summary; completed effect receipt: ${harness.terminalEffect.toolCallId}.`,
    );

    await expect(step).resolves.toBe('completed');
    expect(harness.events).toEqual([
      'resolve-config',
      'compress-history',
      'store-compression',
      'persist-compression',
      'generate-context',
      'get-tools',
      'provider-execute',
    ]);
    expect(harness.beginStep).toHaveBeenCalledWith({ flushQueue: true });
    expect(harness.storeCompressedHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        boundaryMessageId: harness.queuedUserMessage.id,
        compactedMessageIds: expect.arrayContaining([
          'assistant-critical-tail',
        ]),
      }),
    );
    expect(harness.getCompressedHistorySeenByContext()).toContain(
      harness.terminalEffect.toolCallId,
    );
    expect(harness.getUsedTokensSeenByContext()).toBeLessThan(160_000);
    expect(harness.getUsedTokensSeenByContext()).not.toBe(193_505);
    expect(harness.persist).toHaveBeenCalledOnce();
    expect(harness.execute).toHaveBeenCalledOnce();
    expect(harness.effectExecution).not.toHaveBeenCalled();
    expect(
      harness.state.history.find(
        (message: AgentMessage) => message.id === 'assistant-critical-tail',
      )?.parts,
    ).toContainEqual(harness.terminalEffect);
    expect(harness.state.error).toBeUndefined();
  });

  it('adds a large queued user message before evaluating the compression trigger', async () => {
    const harness = createPreStepRecoveryHarness();
    harness.state.usedTokens = 90_000;
    harness.state.history[9].parts = [
      {
        type: 'text',
        text: 'A small prior tail leaves the queued message unaccounted.',
        state: 'done',
      },
    ];
    harness.queuedUserMessage.parts = [
      {
        type: 'text',
        text: `Continue with this payload: ${'q'.repeat(20_000)}`,
      },
    ];

    await expect(harness.agent.runAdmittedStep(false, 7)).resolves.toBe(
      'completed',
    );

    expect(harness.agent.compressHistory).toHaveBeenCalledOnce();
    expect(harness.storeCompressedHistory).toHaveBeenCalledOnce();
    expect(harness.getUsedTokensSeenByContext()).toBeGreaterThan(90_000);
    expect(harness.getUsedTokensSeenByContext()).toBeLessThan(160_000);
    expect(harness.execute).toHaveBeenCalledOnce();
  });

  it('applies the same admission gate to approval continuation re-entry', async () => {
    const harness = createPreStepRecoveryHarness({
      queuedUserBoundary: false,
    });
    const admissionError = new Error('approval continuation admission blocked');
    const admissionGate = vi.fn(async () => {
      throw admissionError;
    });
    harness.agent.maybeCompressHistoryForStepAdmission = admissionGate;

    await expect(harness.agent.runAdmittedStep(true, 7)).resolves.toBe(
      'failed',
    );

    expect(harness.beginStep).toHaveBeenCalledWith({ flushQueue: false });
    expect(admissionGate).toHaveBeenCalledWith(7, 200_000, 193_505);
    expect(harness.agent._stepResolvedMaxOutputTokens).toBe(4_096);
    expect(harness.agent.generateContextForNewStep).not.toHaveBeenCalled();
    expect(harness.agent.getToolsForStep).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.state.error).toMatchObject({
      message: expect.stringContaining(admissionError.message),
    });
  });

  it('keeps recalculated occupancy when provider setup fails before new usage arrives', async () => {
    const harness = createPreStepRecoveryHarness();
    harness.execute.mockRejectedValueOnce(
      new Error('provider setup failed after compression'),
    );

    await expect(harness.agent.runAdmittedStep(false, 7)).resolves.toBe(
      'failed',
    );

    const recoveredUsedTokens = harness.state.usedTokens;
    expect(recoveredUsedTokens).toBeLessThan(160_000);
    expect(harness.agent.compressHistory).toHaveBeenCalledOnce();

    await expect(
      harness.agent.runAdmittedStep(false, harness.agent._stepGeneration),
    ).resolves.toBe('completed');

    expect(harness.agent.compressHistory).toHaveBeenCalledOnce();
    expect(harness.execute).toHaveBeenCalledTimes(2);
  });

  it('populates queued attachments before blocking an unsafe semantic admission', async () => {
    const harness = createPreStepRecoveryHarness();
    harness.state.usedTokens = 6_401;
    harness.queuedUserMessage.metadata!.attachments = [
      { path: 'att/retained-a.txt' },
      { path: 'att/retained-b.txt' },
    ];
    expect(harness.queuedUserMessage.metadata!.pathReferences).toBeUndefined();
    harness.agent.populatePathReferencesOnUserMessages.mockImplementationOnce(
      async () => {
        harness.queuedUserMessage.metadata!.pathReferences = {
          'att/retained-a.txt': 'hash-a',
          'att/retained-b.txt': 'hash-b',
        };
      },
    );
    harness.agent.host.models.getWithOptions.mockResolvedValue({
      model: {} as never,
      providerOptions: undefined,
      headers: undefined,
      contextWindowSize: 8_000,
      providerMode: 'custom',
      reasoningSignatureSource: undefined,
    });
    harness.agent.getModelSettings.mockImplementationOnce(async () => {
      harness.events.push('resolve-config');
      return { maxOutputTokens: 1_600 };
    });

    await expect(harness.agent.runAdmittedStep(false, 7)).resolves.toBe(
      'failed',
    );

    expect(harness.agent.compressHistory).toHaveBeenCalledOnce();
    expect(
      harness.agent.populatePathReferencesOnUserMessages.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      harness.agent.compressHistory.mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );
    expect(harness.storeCompressedHistory).not.toHaveBeenCalled();
    expect(harness.persist).not.toHaveBeenCalled();
    expect(harness.agent.generateContextForNewStep).not.toHaveBeenCalled();
    expect(harness.agent.getToolsForStep).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.state.error).toMatchObject({
      retryable: false,
      message: expect.stringMatching(
        /critical context occupancy \(\d+\/8000 tokens\)/u,
      ),
      recoveryDiagnostics: [
        expect.stringContaining(
          'generation: HistoryCompressionUnsafeProjectionError',
        ),
        expect.stringContaining(
          'emergency-fallback: Error: Emergency history compression has no safe snapshot budget',
        ),
      ],
    });
  });

  it('keeps inferred non-history occupancy in semantic admission projections', async () => {
    const harness = createPreStepRecoveryHarness();
    harness.state.history[9].parts = [
      {
        type: 'text',
        text: 'A small retained tail cannot explain the persisted occupancy.',
        state: 'done',
      },
    ];

    await expect(harness.agent.runAdmittedStep(false, 7)).resolves.toBe(
      'failed',
    );

    expect(harness.agent.compressHistory).toHaveBeenCalledOnce();
    expect(harness.storeCompressedHistory).not.toHaveBeenCalled();
    expect(harness.agent.generateContextForNewStep).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.state.error).toMatchObject({
      retryable: false,
      recoveryDiagnostics: [
        expect.stringContaining(
          'generation: HistoryCompressionUnsafeProjectionError',
        ),
        expect.stringContaining(
          'emergency-fallback: Error: Emergency history compression has no safe snapshot budget',
        ),
      ],
    });
  });

  it('discards an oversized semantic summary instead of hiding it behind stale occupancy', async () => {
    const harness = createPreStepRecoveryHarness();
    harness.state.usedTokens = 5_000;
    harness.state.history[9].parts = [
      {
        type: 'text',
        text: 'A small retained tail remains safe without the rejected summary.',
        state: 'done',
      },
    ];
    harness.agent.compressHistory.mockResolvedValueOnce('s'.repeat(7_000));
    harness.agent.host.models.getWithOptions.mockResolvedValue({
      model: {} as never,
      providerOptions: undefined,
      headers: undefined,
      contextWindowSize: 8_000,
      providerMode: 'custom',
      reasoningSignatureSource: undefined,
    });
    harness.agent.getModelSettings.mockImplementationOnce(async () => {
      harness.events.push('resolve-config');
      return { maxOutputTokens: 1_600 };
    });

    await expect(harness.agent.runAdmittedStep(false, 7)).resolves.toBe(
      'completed',
    );

    expect(harness.storeCompressedHistory).not.toHaveBeenCalled();
    expect(harness.persist).not.toHaveBeenCalled();
    expect(harness.getCompressedHistorySeenByContext()).toBeUndefined();
    expect(harness.getUsedTokensSeenByContext()).toBe(5_000);
    expect(harness.execute).toHaveBeenCalledOnce();
    expect(harness.agent.report).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'HistoryCompressionUnsafeProjectionError',
      }),
      'compressHistoryGenerationTransient',
    );
  });

  it('compresses below the normal trigger when the reserved output budget makes admission unsafe', async () => {
    const harness = createPreStepRecoveryHarness();
    harness.state.usedTokens = 3_500;
    harness.agent.host.models.getWithOptions.mockResolvedValue({
      model: {} as never,
      providerOptions: undefined,
      headers: undefined,
      contextWindowSize: 8_000,
      providerMode: 'custom',
      reasoningSignatureSource: undefined,
    });
    harness.agent.getModelSettings.mockImplementationOnce(async () => {
      harness.events.push('resolve-config');
      return { maxOutputTokens: 5_000 };
    });

    await expect(harness.agent.runAdmittedStep(false, 7)).resolves.toBe(
      'completed',
    );

    expect(harness.agent.compressHistory).toHaveBeenCalledOnce();
    expect(harness.storeCompressedHistory).toHaveBeenCalledOnce();
    expect(harness.getUsedTokensSeenByContext()).toBeLessThanOrEqual(3_000);
    expect(harness.execute).toHaveBeenCalledOnce();
  });

  it('publishes bounded phase diagnostics when semantic and emergency recovery both fail', async () => {
    const harness = createPreStepRecoveryHarness();
    harness.agent.compressHistory.mockRejectedValueOnce(
      new Error(
        `semantic route failed with Bearer secret-token-value\n` +
          `x-api-key: AIzaThisMustNotEscape123456789\n` +
          `?api_key=query-secret-value&next=1\n` +
          `Authorization: Basic basic-secret-value\n` +
          `access_token='access-secret-value' ${'x'.repeat(1_000)}`,
      ),
    );
    harness.state.history[9].parts.push({
      type: 'tool-write',
      toolCallId: 'ambiguous-write',
      state: 'input-available',
      input: { path: 'w1/src/file.ts', content: 'changed' },
    });

    await expect(harness.agent.runAdmittedStep(false, 7)).resolves.toBe(
      'failed',
    );

    expect(harness.state.error).toMatchObject({
      retryable: false,
      recoveryDiagnostics: [
        expect.stringContaining(
          'generation: Error: semantic route failed with Bearer [redacted]',
        ),
        expect.stringContaining(
          'emergency-fallback: Error: Emergency history compression refused ambiguous tool outcome',
        ),
      ],
    });
    expect(JSON.stringify(harness.state.error)).not.toContain(
      'secret-token-value',
    );
    expect(JSON.stringify(harness.state.error)).not.toMatch(
      /AIzaThisMustNotEscape|query-secret-value|basic-secret-value|access-secret-value/u,
    );
    expect(
      harness.state.error?.recoveryDiagnostics?.every(
        (diagnostic) => diagnostic.length <= 600,
      ),
    ).toBe(true);
  });

  it('does not prepare context or execute a provider after pre-step compression is superseded', async () => {
    const compression = deferred<string>();
    const harness = createPreStepRecoveryHarness({ compression });

    const step = harness.agent.runAdmittedStep(false, 7);
    await vi.waitFor(() =>
      expect(harness.agent.compressHistory).toHaveBeenCalledOnce(),
    );

    harness.agent.supersedeCurrentStep();
    expect(harness.getCompressionSignal()?.aborted).toBe(true);
    compression.resolve('A stale summary that must be discarded.');

    await expect(step).resolves.toBe('superseded');
    expect(harness.storeCompressedHistory).not.toHaveBeenCalled();
    expect(harness.persist).not.toHaveBeenCalled();
    expect(harness.agent.generateContextForNewStep).not.toHaveBeenCalled();
    expect(harness.agent.getToolsForStep).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.effectExecution).not.toHaveBeenCalled();
  });
});

describe('BaseAgent post-step retry safety', () => {
  it('refuses to replay a user turn for a non-retryable post-step error', async () => {
    const agent = Object.create(BaseAgent.prototype) as any;
    agent.state = {
      get: () => ({
        error: {
          message: 'Context compression could not be persisted durably',
          retryable: false,
        },
        history: [makeMessage(0)],
      }),
    };
    agent.revertToUserMessageSerialized = vi.fn();
    agent.sendUserMessageSerialized = vi.fn();

    await expect(agent.retryLastUserMessageSerialized()).rejects.toThrow(
      'cannot safely replay the last user message',
    );
    expect(agent.revertToUserMessageSerialized).not.toHaveBeenCalled();
    expect(agent.sendUserMessageSerialized).not.toHaveBeenCalled();
  });
});
