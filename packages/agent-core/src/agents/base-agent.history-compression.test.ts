import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../types/agent';
import { BaseAgent } from './base-agent';

type CompressionState = {
  activeModelId: string;
  usedTokens: number;
  isCompressingContext?: boolean;
  history: AgentMessage[];
};

type CompressionHarness = {
  instanceId: string;
  _stepGeneration: number;
  _stepResolvedModelId: string;
  _isCompressingHistory: boolean;
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
      setContextCompactionState: ReturnType<typeof vi.fn>;
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
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createCompressionHarness(persistent = true) {
  const history = Array.from({ length: 14 }, (_, index) => makeMessage(index));
  const state: CompressionState = {
    activeModelId: 'test-model',
    usedTokens: 100_000,
    isCompressingContext: false,
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
  const setContextCompactionState = vi.fn(
    (args: { isCompressing: boolean; totalTokens?: number }) => {
      state.isCompressingContext = args.isCompressing;
      if (args.totalTokens !== undefined) state.usedTokens = args.totalTokens;
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
  agent.host = {
    models: {
      getWithOptions: vi.fn(async () => ({ contextWindowSize: 200 })),
    },
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  agent.state = {
    get: () => state,
    commands: {
      storeCompressedHistory,
      restoreCompressedHistory,
      setContextCompactionState,
    },
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
    expect(state.isCompressingContext).toBe(true);
    expect(state.usedTokens).toBe(100_000);

    compression.resolve('A durable compressed history that is long enough.');
    await barrier;

    expect(storeCompressedHistory).toHaveBeenCalledOnce();
    expect(state.isCompressingContext).toBe(false);
    expect(state.usedTokens).toBeLessThan(100_000);
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
    expect(agent.state.get().isCompressingContext).toBe(false);
    expect(agent.state.persist).not.toHaveBeenCalled();
    expect(agent.scheduleMemorySnapshotWrite).not.toHaveBeenCalled();
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
    expect(restoreCompressedHistory).toHaveBeenCalledOnce();
    expect(state.isCompressingContext).toBe(false);
    expect(state.usedTokens).toBe(100_000);
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
    expect(state.isCompressingContext).toBe(false);
    expect(state.usedTokens).toBeLessThan(100_000);
    expect(
      state.history.some(
        (message) =>
          message.metadata?.compressedHistory ===
          'An in-memory summary for a non-persistent agent.',
      ),
    ).toBe(true);
  });
});
