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
    usedTokens: 101,
    history,
  };
  const compression = deferred<string>();
  const storeCompressedHistory = vi.fn(
    (args: {
      boundaryMessageId: string;
      compactedMessageIds: readonly string[];
      compressedHistory: string;
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
      state.history[boundaryIndex]!.metadata!.compressedHistory =
        args.compressedHistory;
      return 'written' as const;
    },
  );
  const restoreCompressedHistory = vi.fn(
    (args: {
      boundaryMessageId: string;
      expectedCompressedHistory: string;
      previousCompressedHistory: string | undefined;
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
      if (args.previousCompressedHistory === undefined) {
        delete boundary.metadata!.compressedHistory;
      } else {
        boundary.metadata!.compressedHistory = args.previousCompressedHistory;
      }
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
      getWithOptions: vi.fn(async () => ({ contextWindowSize: 200 })),
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

describe('BaseAgent history-compression admission barrier', () => {
  it('waits for and durably stores compression before the step may settle', async () => {
    const { agent, state, compression, storeCompressedHistory } =
      createCompressionHarness();
    let settled = false;

    const barrier = agent.maybeCompressHistoryAfterStep(7, 200).then(() => {
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

    const barrier = agent.maybeCompressHistoryAfterStep(7, 200);
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

    await agent.maybeCompressHistoryAfterStep(7, 200);

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
      agent.maybeCompressHistoryAfterStep(7, 200),
    ).resolves.toBeUndefined();

    expect(storeCompressedHistory).not.toHaveBeenCalled();
    expect(agent.state.persist).not.toHaveBeenCalled();
    expect(agent.report).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AbortError' }),
      'compressHistoryGenerationTransient',
    );
    expect(agent._historyCompressionGenerationFailures).toBe(1);
    expect(agent._historyCompressionRetryNotBefore).toBeGreaterThan(Date.now());

    await agent.maybeCompressHistoryAfterStep(7, 200);
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

    const stoppedBarrier = agent.maybeCompressHistoryAfterStep(7, 200);
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
    await agent.maybeCompressHistoryAfterStep(8, 200);

    expect(retrySignal).toBeInstanceOf(AbortSignal);
    expect(retrySignal).not.toBe(stoppedSignal);
    expect(retrySignal?.aborted).toBe(false);
    expect(storeCompressedHistory).toHaveBeenCalledOnce();
  });

  it('fails closed with a non-retryable post-step error at critical occupancy', async () => {
    const { agent, state, storeCompressedHistory } = createCompressionHarness();
    state.usedTokens = 160;
    agent.compressHistory.mockRejectedValueOnce(
      new Error('all compression routes unavailable'),
    );

    await expect(
      agent.maybeCompressHistoryAfterStep(7, 200),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        'Context compression failed before the next step',
      ),
      retryable: false,
    });
    expect(storeCompressedHistory).not.toHaveBeenCalled();
    expect(agent.state.persist).not.toHaveBeenCalled();
  });

  it('fails closed instead of overlapping a compressor that ignored abort', async () => {
    const { agent, storeCompressedHistory } = createCompressionHarness();
    agent.compressHistory.mockRejectedValueOnce(
      new HistoryCompressionUnsettledTimeoutError('stuck-model'),
    );

    await expect(
      agent.maybeCompressHistoryAfterStep(7, 200),
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

    const barrier = agent.maybeCompressHistoryAfterStep(7, 200);
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

  it('keeps non-persistent agents out of durable agent storage', async () => {
    const { agent, state, compression } = createCompressionHarness(false);

    const barrier = agent.maybeCompressHistoryAfterStep(7, 200);
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
