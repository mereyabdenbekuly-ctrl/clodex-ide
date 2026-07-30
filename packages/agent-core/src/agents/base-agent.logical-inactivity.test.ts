import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeError } from '../types/agent';
import { BaseAgent } from './base-agent';
import type {
  AgentLogicalInactivityRecoveryResult,
  AgentRuntimePhase,
  AgentRuntimeProgress,
} from './runtime-progress';

type HarnessState = {
  isWorking: boolean;
  history: Array<{
    id: string;
    role: 'user';
    parts: Array<{ type: 'text'; text: string }>;
  }>;
  queuedMessages: Array<{
    id: string;
    role: 'user';
    parts: Array<{ type: 'text'; text: string }>;
  }>;
  error?: AgentRuntimeError;
};

type LogicalInactivityHarness = {
  _stepGeneration: number;
  _runtimeProgress: AgentRuntimeProgress;
  _runtimeProgressTurnId: string | null;
  _logicalInactivityRecoveryTurnId: string | null;
  _logicalInactivityRecoveryAttempts: number;
  _logicalInactivityRecoveryInFlight: boolean;
  _activeRuntimePolicyChecks: number;
  _activeRuntimeToolExecutions: number;
  _runtimeTailGeneration: number | null;
  _historyLifecycleTail: Promise<void>;
  _historyPreemptionInFlight: number;
  _historyPreemptionGeneration: number;
  _approvalLifecycleGeneration: number;
  _pendingSyntheticContinuation: unknown;
  state: {
    get: () => HarnessState;
    commands: {
      setIsWorkingFalse: () => void;
      recordStepError: (input: {
        error: AgentRuntimeError | undefined;
        markUnread: 'always' | 'mark-unread' | 'if-assistant-history';
      }) => void;
    };
  };
  host: {
    logger: {
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    };
  };
  runStep: ReturnType<typeof vi.fn>;
  internalStop: ReturnType<typeof vi.fn>;
  supersedeCurrentStep: () => void;
  scheduleQueuedDrainAttempt: ReturnType<typeof vi.fn>;
  emitNotificationEvent: ReturnType<typeof vi.fn>;
  getRuntimeProgress: () => AgentRuntimeProgress;
  recoverLogicalInactivity: (
    expected: AgentRuntimeProgress,
  ) => Promise<AgentLogicalInactivityRecoveryResult>;
  stop: () => Promise<void>;
  heartbeatRuntimeProgress: (
    phase: AgentRuntimePhase,
    expectedStepGeneration?: number,
  ) => void;
  heartbeatRuntimeActivePhase: (
    fallbackPhase: 'streaming-model' | 'awaiting-approval',
    expectedStepGeneration: number,
  ) => void;
  wrapToolsWithTiming: (
    tools: Record<string, unknown>,
    expectedStepGeneration: number,
  ) => Record<
    string,
    {
      execute?: (input: unknown, options: { toolCallId: string }) => unknown;
    }
  >;
  admitToolCallLifecycleStage: ReturnType<typeof vi.fn>;
};

describe('BaseAgent logical-inactivity recovery', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries one exactly observed pre-effect stall and preserves the queue', async () => {
    const harness = createHarness();
    const expected = harness.agent.getRuntimeProgress();

    await expect(
      harness.agent.recoverLogicalInactivity(expected),
    ).resolves.toBe('retried');

    expect(harness.internalStop).toHaveBeenCalledOnce();
    expect(harness.internalStop).toHaveBeenCalledWith('logical-inactivity');
    expect(harness.runStep).toHaveBeenCalledOnce();
    expect(harness.state.queuedMessages).toEqual([
      expect.objectContaining({ id: 'queued-1' }),
    ]);
    expect(harness.state.error).toBeUndefined();
    expect(harness.agent._logicalInactivityRecoveryAttempts).toBe(1);
    expect(harness.agent._pendingSyntheticContinuation).toEqual({
      reason: 'logical-inactivity',
    });
  });

  it('fails closed on the second pre-effect stall in the same visible turn', async () => {
    const harness = createHarness({ recoveryAttempts: 1 });
    const expected = harness.agent.getRuntimeProgress();

    await expect(
      harness.agent.recoverLogicalInactivity(expected),
    ).resolves.toBe('failed-closed');

    expect(harness.runStep).not.toHaveBeenCalled();
    expect(harness.state.isWorking).toBe(false);
    expect(harness.state.error).toMatchObject({
      reasonCode: 'logical-inactivity',
    });
    expect(harness.state.error?.message).toContain(
      'during phase "waiting-model"',
    );
    expect(harness.state.error?.message).toContain(
      'automatic replay was denied',
    );
    expect(harness.agent.getRuntimeProgress().phase).toBe('idle');
    expect(harness.emitNotificationEvent).toHaveBeenCalledWith('error');
  });

  it.each([
    'post-effect',
    'uncertain',
  ] as const)('never replays a %s stall', async (effectBoundary) => {
    const harness = createHarness({ effectBoundary });
    const expected = harness.agent.getRuntimeProgress();

    await expect(
      harness.agent.recoverLogicalInactivity(expected),
    ).resolves.toBe('failed-closed');

    expect(harness.runStep).not.toHaveBeenCalled();
    expect(harness.state.error).toMatchObject({
      reasonCode: 'logical-inactivity',
    });
    expect(harness.state.error?.message).toContain(
      `boundary=${effectBoundary}`,
    );
  });

  it.each([
    'tool-running',
    'awaiting-approval',
    'idle',
  ] as const)('ignores direct watchdog recovery while phase is %s', async (phase) => {
    const harness = createHarness({ phase });
    const expected = harness.agent.getRuntimeProgress();

    await expect(
      harness.agent.recoverLogicalInactivity(expected),
    ).resolves.toBe('ignored');

    expect(harness.internalStop).not.toHaveBeenCalled();
    expect(harness.runStep).not.toHaveBeenCalled();
    expect(harness.state.error).toBeUndefined();
  });

  it('ignores a stale generation snapshot without preempting the current step', async () => {
    const harness = createHarness();
    const stale = {
      ...harness.agent.getRuntimeProgress(),
      stepGeneration: 6,
    };

    await expect(harness.agent.recoverLogicalInactivity(stale)).resolves.toBe(
      'ignored',
    );

    expect(harness.agent._stepGeneration).toBe(7);
    expect(harness.internalStop).not.toHaveBeenCalled();
  });

  it('lets explicit Stop win without publishing a logical-inactivity error', async () => {
    const harness = createHarness();

    await harness.agent.stop();

    expect(harness.internalStop).toHaveBeenCalledWith('user-stopped');
    expect(harness.state.isWorking).toBe(false);
    expect(harness.state.error).toBeUndefined();
    expect(harness.emitNotificationEvent).not.toHaveBeenCalled();
    expect(harness.agent.getRuntimeProgress().phase).toBe('idle');
  });

  it('extends the deadline on current-generation chunks and ignores stale callbacks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
    const harness = createHarness({ lastProgressAt: Date.now() - 240_000 });

    harness.agent.heartbeatRuntimeProgress('streaming-model', 7);
    const afterCurrentChunk = harness.agent.getRuntimeProgress();
    expect(afterCurrentChunk.lastProgressAt).toBe(Date.now());
    expect(afterCurrentChunk.phase).toBe('streaming-model');

    vi.setSystemTime(new Date('2026-07-30T00:01:00.000Z'));
    harness.agent.heartbeatRuntimeProgress('streaming-model', 6);
    expect(harness.agent.getRuntimeProgress()).toEqual(afterCurrentChunk);
  });

  it('does not let a late teed-stream chunk downgrade the post-step tail', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
    const harness = createHarness({ phase: 'post-step' });
    harness.agent._runtimeTailGeneration = 7;
    const beforeLateChunk = harness.agent.getRuntimeProgress();

    vi.setSystemTime(new Date('2026-07-30T00:00:30.000Z'));
    harness.agent.heartbeatRuntimeActivePhase('streaming-model', 7);

    expect(harness.agent.getRuntimeProgress()).toEqual(beforeLateChunk);
  });

  it('keeps the no-timeout tool-running phase until every parallel tool settles', async () => {
    const harness = createHarness({ phase: 'streaming-model' });
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    harness.agent.admitToolCallLifecycleStage = vi.fn(
      (_name: string, _toolCallId: string, stage: string) => ({
        kind: 'admitted',
        admission: {
          occurrence: {},
          primaryNeedsApproval: stage === 'needs-approval' ? false : undefined,
        },
      }),
    );
    const wrapped = harness.agent.wrapToolsWithTiming(
      {
        first: { execute: () => first.promise },
        second: { execute: () => second.promise },
      },
      7,
    );

    const firstRun = Promise.resolve(
      wrapped.first?.execute?.({}, { toolCallId: 'first' }),
    );
    const secondRun = Promise.resolve(
      wrapped.second?.execute?.({}, { toolCallId: 'second' }),
    );
    expect(harness.agent.getRuntimeProgress()).toMatchObject({
      phase: 'tool-running',
      effectBoundary: 'uncertain',
    });

    first.resolve({ ok: true });
    await firstRun;
    expect(harness.agent.getRuntimeProgress()).toMatchObject({
      phase: 'tool-running',
      effectBoundary: 'post-effect',
    });

    second.resolve({ ok: true });
    await secondRun;
    expect(harness.agent.getRuntimeProgress()).toMatchObject({
      phase: 'streaming-model',
      effectBoundary: 'post-effect',
    });
  });
});

function createHarness(options?: {
  phase?: AgentRuntimePhase;
  effectBoundary?: AgentRuntimeProgress['effectBoundary'];
  lastProgressAt?: number;
  recoveryAttempts?: number;
}) {
  const state: HarnessState = {
    isWorking: options?.phase !== 'idle',
    history: [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Continue the task' }],
      },
    ],
    queuedMessages: [
      {
        id: 'queued-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Keep this queued' }],
      },
    ],
  };
  const agent = Object.create(BaseAgent.prototype) as LogicalInactivityHarness;
  agent._stepGeneration = 7;
  agent._runtimeProgress = {
    phase: options?.phase ?? 'waiting-model',
    lastProgressAt: options?.lastProgressAt ?? Date.now() - 360_000,
    stepGeneration: 7,
    effectBoundary: options?.effectBoundary ?? 'pre-effect',
  };
  agent._runtimeProgressTurnId = 'user-1';
  agent._logicalInactivityRecoveryTurnId = 'user-1';
  agent._logicalInactivityRecoveryAttempts = options?.recoveryAttempts ?? 0;
  agent._logicalInactivityRecoveryInFlight = false;
  agent._activeRuntimePolicyChecks = 0;
  agent._activeRuntimeToolExecutions = 0;
  agent._runtimeTailGeneration = null;
  agent._historyLifecycleTail = Promise.resolve();
  agent._historyPreemptionInFlight = 0;
  agent._historyPreemptionGeneration = 0;
  agent._approvalLifecycleGeneration = 0;
  agent._pendingSyntheticContinuation = null;
  agent.state = {
    get: () => state,
    commands: {
      setIsWorkingFalse: () => {
        state.isWorking = false;
      },
      recordStepError: ({ error }) => {
        state.isWorking = false;
        state.error = error;
      },
    },
  };
  agent.host = {
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
  agent.runStep = vi.fn(async () => undefined);
  agent.scheduleQueuedDrainAttempt = vi.fn();
  agent.emitNotificationEvent = vi.fn();
  agent.supersedeCurrentStep = () => {
    agent._stepGeneration += 1;
    agent._runtimeTailGeneration = null;
  };
  const internalStop = vi.fn(async (_reason: string) => {
    agent._stepGeneration += 1;
  });
  agent.internalStop = internalStop;

  return {
    agent,
    state,
    internalStop,
    runStep: agent.runStep,
    emitNotificationEvent: agent.emitNotificationEvent,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
