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

type SettlementHarness = {
  _stepGeneration: number;
  _pendingContinue: boolean | null;
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
  onIdle: () => void;
  emitNotificationEvent: (event: 'done') => void;
  settleStepContinuation: (
    stepGeneration: number,
    stepHasApprovalRequest: boolean,
  ) => boolean;
  scheduleQueuedMessageWake: (originatingStep: {
    settled: Promise<'completed' | 'failed' | 'superseded'>;
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
  agent.state = {
    get: () => state,
    commands: { recordStepError },
  };
  agent.runStep = runStep;
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
    let settle!: (outcome: 'completed' | 'failed' | 'superseded') => void;
    const settled = new Promise<'completed' | 'failed' | 'superseded'>(
      (resolve) => {
        settle = resolve;
      },
    );

    harness.agent.scheduleQueuedMessageWake({ settled });
    expect(harness.runStep).not.toHaveBeenCalled();

    settle('completed');
    await settled;
    await Promise.resolve();

    expect(harness.runStep).toHaveBeenCalledTimes(1);
  });

  it('does not restart a step superseded by a priority lifecycle action', async () => {
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
      settled: Promise.resolve('superseded'),
    });
    await Promise.resolve();

    expect(harness.runStep).not.toHaveBeenCalled();
  });
});
