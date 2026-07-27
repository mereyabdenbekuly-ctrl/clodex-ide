import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseAgent } from './base-agent';

type SettlementState = {
  queuedMessages: Array<{
    id: string;
    role: 'user';
    parts: Array<{ type: 'text'; text: string }>;
  }>;
  history: Array<{
    id: string;
    role: 'assistant';
    parts: Array<{ type: 'text'; text: string }>;
  }>;
};

type StepSettlement = {
  outcome: 'completed' | 'failed' | 'superseded';
  state: SettlementState;
};

type SettlementHarness = {
  _stepGeneration: number;
  _pendingContinue: boolean | null;
  _queuedDrainRequested: boolean;
  _queuedDrainScheduled: boolean;
  state: {
    get: () => SettlementState;
    commands: {
      recordStepError: (args: {
        error: undefined;
        markUnread: 'if-assistant-history';
      }) => void;
    };
  };
  runStep: () => Promise<void>;
  canRunStep: () => boolean;
  onIdle: () => void;
  emitNotificationEvent: (event: 'done') => void;
  settleStepContinuation: (
    stepGeneration: number,
    stepHasApprovalRequest: boolean,
  ) => boolean;
  scheduleQueuedMessageWake: (originatingStep: {
    settled: Promise<StepSettlement>;
  }) => void;
};

function createSettlementHarness(state: SettlementState) {
  const recordStepError = vi.fn();
  const onIdle = vi.fn();
  const emitNotificationEvent = vi.fn();
  const runStep = vi.fn(async () => {});
  const agent = Object.create(BaseAgent.prototype) as SettlementHarness;
  agent._stepGeneration = 7;
  agent._pendingContinue = false;
  agent._queuedDrainRequested = false;
  agent._queuedDrainScheduled = false;
  agent.state = {
    get: () => state,
    commands: { recordStepError },
  };
  agent.runStep = runStep;
  agent.canRunStep = () => true;
  agent.onIdle = onIdle;
  agent.emitNotificationEvent = emitNotificationEvent;

  return {
    agent,
    recordStepError,
    onIdle,
    emitNotificationEvent,
    runStep,
  };
}

describe('BaseAgent queued follow-up settlement', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('schedules one next step when a message is queued after the earlier stop decision', async () => {
    vi.useFakeTimers();
    const state: SettlementState = {
      queuedMessages: [],
      history: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Current turn is finishing' }],
        },
      ],
    };
    const harness = createSettlementHarness(state);

    // `_pendingContinue = false` models shouldRunNewStep() observing an empty
    // queue. The user message arrives later while the stream/persistence tail
    // is still draining but before the step is settled.
    state.queuedMessages.push({
      id: 'user-late',
      role: 'user',
      parts: [{ type: 'text', text: 'Use the new requirement instead' }],
    });

    expect(harness.agent.settleStepContinuation(7, false)).toBe(true);
    expect(harness.agent._pendingContinue).toBeNull();
    expect(harness.runStep).not.toHaveBeenCalled();
    expect(harness.recordStepError).not.toHaveBeenCalled();
    expect(harness.onIdle).not.toHaveBeenCalled();
    expect(harness.emitNotificationEvent).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(harness.runStep).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(harness.runStep).toHaveBeenCalledTimes(1);
  });

  it('preserves the ordinary idle transition when no late message exists', async () => {
    vi.useFakeTimers();
    const state: SettlementState = {
      queuedMessages: [],
      history: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Done' }],
        },
      ],
    };
    const harness = createSettlementHarness(state);

    expect(harness.agent.settleStepContinuation(7, false)).toBe(true);

    expect(harness.recordStepError).toHaveBeenCalledWith({
      error: undefined,
      markUnread: 'if-assistant-history',
    });
    expect(harness.onIdle).toHaveBeenCalledTimes(1);
    expect(harness.emitNotificationEvent).toHaveBeenCalledWith('done');
    await vi.runAllTimersAsync();
    expect(harness.runStep).not.toHaveBeenCalled();
  });

  it('leaves a queued follow-up blocked on an explicit approval instead of scheduling a no-op step', async () => {
    vi.useFakeTimers();
    const state: SettlementState = {
      queuedMessages: [
        {
          id: 'user-late',
          role: 'user',
          parts: [{ type: 'text', text: 'Wait for my approval first' }],
        },
      ],
      history: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Approval required' }],
        },
      ],
    };
    const harness = createSettlementHarness(state);
    harness.agent._pendingContinue = true;

    expect(harness.agent.settleStepContinuation(7, true)).toBe(true);

    expect(harness.recordStepError).toHaveBeenCalledWith({
      error: undefined,
      markUnread: 'if-assistant-history',
    });
    expect(harness.onIdle).toHaveBeenCalledTimes(1);
    expect(harness.emitNotificationEvent).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(harness.runStep).not.toHaveBeenCalled();
    expect(state.queuedMessages).toHaveLength(1);
  });

  it('wakes after the originating step settles when enqueue missed the tail re-check', async () => {
    vi.useFakeTimers();
    const state: SettlementState = {
      queuedMessages: [
        {
          id: 'user-after-tail',
          role: 'user',
          parts: [{ type: 'text', text: 'This arrived after the final check' }],
        },
      ],
      history: [],
    };
    const harness = createSettlementHarness(state);
    let settle!: (settlement: StepSettlement) => void;
    const settled = new Promise<StepSettlement>((resolve) => {
      settle = resolve;
    });

    harness.agent.scheduleQueuedMessageWake({ settled });
    expect(harness.runStep).not.toHaveBeenCalled();

    settle({ outcome: 'completed', state });
    await settled;
    await vi.runAllTimersAsync();

    expect(harness.runStep).toHaveBeenCalledTimes(1);
  });

  it('does not restart a step superseded by a priority lifecycle action', async () => {
    vi.useFakeTimers();
    const state: SettlementState = {
      queuedMessages: [
        {
          id: 'user-before-stop',
          role: 'user',
          parts: [{ type: 'text', text: 'Do not undo the explicit stop' }],
        },
      ],
      history: [],
    };
    const harness = createSettlementHarness(state);

    harness.agent.scheduleQueuedMessageWake({
      settled: Promise.resolve({ outcome: 'superseded', state }),
    });
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(harness.runStep).not.toHaveBeenCalled();
  });
});

describe('BaseAgent queued-message ingress', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createSendHarness(options?: { existingQueueText?: string }) {
    const queuedMessages: any[] = options?.existingQueueText
      ? [
          {
            id: 'existing',
            role: 'user',
            parts: [{ type: 'text', text: options.existingQueueText }],
          },
        ]
      : [];
    const state = {
      isWorking: false,
      queuedMessages,
      history: [
        {
          id: 'assistant-approval',
          role: 'assistant',
          parts: [
            {
              type: 'tool-read',
              toolCallId: 'approval-1',
              state: 'approval-requested',
              input: { path: 'file.ts' },
            },
          ],
        },
      ],
    };
    const recordEvidenceEvent = vi.fn();
    const telemetryCapture = vi.fn();
    const internalStop = vi.fn();
    const invalidateOpenToolApprovals = vi.fn();
    const runStep = vi.fn(async () => {});
    const agent = Object.create(BaseAgent.prototype) as any;
    Object.defineProperty(agent, 'agentType', { value: 'chat' });
    agent.instanceId = 'agent-1';
    agent._activeStepRun = null;
    agent._historyRewriteInFlight = 0;
    agent._queuedDrainRequested = false;
    agent._queuedDrainScheduled = false;
    agent.state = {
      get: () => state,
      commands: {
        enqueueUserMessage: ({ message }: { message: any }) => {
          state.queuedMessages.push(message);
          return {
            queuedModelId: 'model-1',
            queueLengthAfter: state.queuedMessages.length,
          };
        },
        appendHistoryMessage: vi.fn(),
        restoreQueuedMessages: ({ messages }: { messages: any[] }) => {
          state.queuedMessages = messages;
        },
      },
    };
    agent.captureHistoryPreemptionGeneration = () => 0;
    agent.assertHistoryNotPreempted = vi.fn();
    agent.canRunStep = () => false;
    agent.commitQueuedMessagesDurably = async ({ mutate }: any) =>
      mutate().value;
    agent.recordEvidenceEvent = recordEvidenceEvent;
    agent.scheduleMemorySnapshotWrite = vi.fn();
    agent.internalStop = internalStop;
    agent.invalidateOpenToolApprovals = invalidateOpenToolApprovals;
    agent.runStep = runStep;
    agent.host = {
      logger: { debug: vi.fn() },
      telemetry: { capture: telemetryCapture },
    };

    return {
      agent,
      state,
      recordEvidenceEvent,
      telemetryCapture,
      internalStop,
      invalidateOpenToolApprovals,
      runStep,
    };
  }

  it('queues behind a visible approval without aborting or invalidating it', async () => {
    const harness = createSendHarness();

    const result = await harness.agent.sendUserMessageSerialized({
      id: 'renderer-id',
      role: 'user',
      parts: [{ type: 'text', text: 'Apply this after the read completes' }],
      metadata: { createdAt: new Date(), partsMetadata: [] },
    });

    expect(result.disposition).toBe('queued');
    expect(harness.state.queuedMessages).toHaveLength(1);
    expect(harness.state.history[0]?.parts[0]?.state).toBe(
      'approval-requested',
    );
    expect(harness.internalStop).not.toHaveBeenCalled();
    expect(harness.invalidateOpenToolApprovals).not.toHaveBeenCalled();
    expect(harness.runStep).not.toHaveBeenCalled();
    expect(harness.recordEvidenceEvent).toHaveBeenCalledWith(
      'user_message',
      expect.objectContaining({ queued: true }),
      expect.any(Object),
    );
  });

  it('preserves FIFO when an idle renderer races an already queued message', async () => {
    const harness = createSendHarness({ existingQueueText: 'first' });
    harness.agent.canRunStep = () => true;

    const result = await harness.agent.sendUserMessageSerialized({
      id: 'renderer-id',
      role: 'user',
      parts: [{ type: 'text', text: 'second' }],
      metadata: { createdAt: new Date(), partsMetadata: [] },
    });

    expect(result.disposition).toBe('queued');
    expect(
      harness.state.queuedMessages.map((message) => message.parts[0]?.text),
    ).toEqual(['first', 'second']);
  });

  it('rolls back an edited queue exactly when strict persistence fails', async () => {
    const before = [
      {
        id: 'queued-1',
        role: 'user',
        parts: [{ type: 'text', text: 'before' }],
      },
    ];
    const state = { queuedMessages: structuredClone(before) };
    const agent = Object.create(BaseAgent.prototype) as any;
    agent._historyRewriteInFlight = 0;
    agent.state = {
      get: () => state,
      commands: {
        restoreQueuedMessages: ({ messages }: { messages: any[] }) => {
          state.queuedMessages = structuredClone(messages);
        },
      },
    };
    agent.saveQueuedMessagesStrict = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);
    agent.scheduleQueuedMessageWake = vi.fn();
    agent.scheduleQueuedDrainAttempt = vi.fn();

    await expect(
      agent.commitQueuedMessagesDurably({
        previousQueue: structuredClone(before),
        originatingStep: null,
        requestDrain: false,
        mutate: () => {
          state.queuedMessages[0]!.parts[0]!.text = 'after';
          return { changed: true, value: 'updated' };
        },
      }),
    ).rejects.toThrow('disk full');

    expect(state.queuedMessages).toEqual(before);
    expect(agent.saveQueuedMessagesStrict).toHaveBeenCalledTimes(2);
    expect(agent._historyRewriteInFlight).toBe(0);
  });
});

describe('BaseAgent explicit queue lifecycle actions', () => {
  it('keeps queued work paused after an explicit Stop', async () => {
    const agent = Object.create(BaseAgent.prototype) as any;
    agent._queuedDrainRequested = true;
    agent.internalStop = vi.fn(async () => {});
    agent.state = {
      commands: { setIsWorkingFalse: vi.fn() },
    };

    await agent.stopSerialized();

    expect(agent._queuedDrainRequested).toBe(false);
    expect(agent.internalStop).toHaveBeenCalledWith('user-stopped');
    expect(agent.state.commands.setIsWorkingFalse).toHaveBeenCalledTimes(1);
  });
});

describe('BaseAgent durable queue mutation wake policy', () => {
  it('does not re-arm execution when editing a queue paused by explicit Stop', async () => {
    const state = {
      queuedMessages: [
        {
          id: 'queued-1',
          role: 'user',
          parts: [{ type: 'text', text: 'before' }],
        },
      ],
    };
    const agent = Object.create(BaseAgent.prototype) as any;
    agent._historyRewriteInFlight = 0;
    agent._queuedDrainRequested = false;
    agent.state = {
      get: () => state,
      commands: { restoreQueuedMessages: vi.fn() },
    };
    agent.saveQueuedMessagesStrict = vi.fn(async () => {});
    agent.scheduleQueuedMessageWake = vi.fn();
    agent.scheduleQueuedDrainAttempt = vi.fn();

    await agent.commitQueuedMessagesDurably({
      previousQueue: structuredClone(state.queuedMessages),
      originatingStep: null,
      requestDrain: false,
      mutate: () => {
        state.queuedMessages[0]!.parts[0]!.text = 'after';
        return { changed: true, value: 'updated' };
      },
    });

    expect(agent.scheduleQueuedMessageWake).not.toHaveBeenCalled();
    expect(agent._queuedDrainRequested).toBe(false);
  });
});

describe('BaseAgent strict queue persistence', () => {
  it('propagates queued-state storage errors instead of using best-effort persistence', async () => {
    const persist = vi.fn(async () => {});
    const agent = Object.create(BaseAgent.prototype) as any;
    Object.defineProperty(agent, 'config', {
      value: { persistent: true },
    });
    agent.state = { persist };

    await agent.saveQueuedMessagesStrict();

    expect(persist).toHaveBeenCalledWith({ throwOnError: true });
  });
});

describe('BaseAgent stop versus queued drain', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not restart retained queued work after the full Stop lifecycle settles', async () => {
    vi.useFakeTimers();
    const runStep = vi.fn(async () => {});
    const state = {
      queuedMessages: [
        {
          id: 'queued-1',
          role: 'user',
          parts: [{ type: 'text', text: 'stay paused' }],
        },
      ],
    };
    const agent = Object.create(BaseAgent.prototype) as any;
    agent._historyLifecycleTail = Promise.resolve();
    agent._historyPreemptionInFlight = 0;
    agent._historyPreemptionGeneration = 0;
    agent._approvalLifecycleGeneration = 0;
    agent._queuedDrainRequested = true;
    agent._queuedDrainScheduled = false;
    agent.supersedeCurrentStep = vi.fn();
    agent.internalStop = vi.fn(async () => {});
    agent.state = {
      get: () => state,
      commands: { setIsWorkingFalse: vi.fn() },
    };
    agent.canRunStep = () => true;
    agent.runStep = runStep;

    await agent.stop();
    await vi.runAllTimersAsync();

    expect(agent._queuedDrainRequested).toBe(false);
    expect(state.queuedMessages).toHaveLength(1);
    expect(runStep).not.toHaveBeenCalled();
  });
});
