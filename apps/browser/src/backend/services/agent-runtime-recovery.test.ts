import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentLogicalInactivityRecoveryResult,
  AgentRuntimeEffectBoundary,
  AgentRuntimePhase,
  AgentRuntimeProgress,
} from '@clodex/agent-core';
import type { AgentManagerService } from './agent-manager';
import {
  AgentRuntimeRecoveryService,
  type CloudTaskRuntimeRecovery,
  type AgentRuntimeWatchdog,
} from './agent-runtime-recovery';
import type { Logger } from './logger';

const electronMocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  const powerMonitor = {
    on: vi.fn((event: string, listener: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set<() => void>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return powerMonitor;
    }),
    off: vi.fn((event: string, listener: () => void) => {
      listeners.get(event)?.delete(listener);
      return powerMonitor;
    }),
  };

  return {
    powerMonitor,
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    reset() {
      listeners.clear();
      powerMonitor.on.mockClear();
      powerMonitor.off.mockClear();
    },
  };
});

vi.mock('electron', () => ({
  powerMonitor: electronMocks.powerMonitor,
}));

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

class FakeWatchdog implements AgentRuntimeWatchdog {
  private readonly listeners = new Set<
    (details: { stalledForMs: number }) => void
  >();

  public readonly onMainLoopStall = vi.fn(
    (listener: (details: { stalledForMs: number }) => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  );

  public emit(stalledForMs: number): void {
    for (const listener of this.listeners) listener({ stalledForMs });
  }

  public get listenerCount(): number {
    return this.listeners.size;
  }
}

const services: AgentRuntimeRecoveryService[] = [];
let recoverInterruptedActiveAgents: ReturnType<typeof vi.fn>;
let retryNetworkFailedAgentsNow: ReturnType<typeof vi.fn>;
let getActiveRuntimeProgress: ReturnType<typeof vi.fn>;
let recoverLogicalInactivity: ReturnType<typeof vi.fn>;
let agentManager: AgentManagerService;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
  vi.clearAllMocks();
  electronMocks.reset();
  recoverInterruptedActiveAgents = vi.fn().mockResolvedValue(undefined);
  retryNetworkFailedAgentsNow = vi.fn().mockResolvedValue(undefined);
  getActiveRuntimeProgress = vi.fn().mockReturnValue([]);
  recoverLogicalInactivity = vi
    .fn()
    .mockResolvedValue(
      'retried' satisfies AgentLogicalInactivityRecoveryResult,
    );
  agentManager = {
    recoverInterruptedActiveAgents,
    retryNetworkFailedAgentsNow,
    getActiveRuntimeProgress,
    recoverLogicalInactivity,
  } as unknown as AgentManagerService;
});

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.teardown();
  }
  vi.useRealTimers();
});

describe('AgentRuntimeRecoveryService', () => {
  it('uses the utility-process watchdog for event-loop recovery', async () => {
    const watchdog = new FakeWatchdog();
    createService(watchdog);

    watchdog.emit(55_000);
    await flushMicrotasks();

    expect(recoverInterruptedActiveAgents).toHaveBeenCalledWith(
      'event-loop-stalled',
      { stalledForMs: 55_000 },
    );
    expect(retryNetworkFailedAgentsNow).toHaveBeenCalledWith(
      'event-loop-stalled',
    );
  });

  it('suppresses watchdog stalls during suspend and the resume grace period', async () => {
    const watchdog = new FakeWatchdog();
    createService(watchdog);

    electronMocks.emit('suspend');
    vi.setSystemTime(new Date('2026-07-10T00:00:30.000Z'));
    watchdog.emit(60_000);
    electronMocks.emit('resume');
    watchdog.emit(60_000);
    await flushMicrotasks();

    expect(recoverInterruptedActiveAgents).toHaveBeenCalledTimes(1);
    expect(recoverInterruptedActiveAgents).toHaveBeenCalledWith(
      'system-resumed',
      { stalledForMs: 30_000 },
    );
    expect(retryNetworkFailedAgentsNow).toHaveBeenCalledTimes(1);
    expect(retryNetworkFailedAgentsNow).toHaveBeenCalledWith('system-resumed');

    vi.setSystemTime(new Date('2026-07-10T00:00:41.000Z'));
    watchdog.emit(60_000);
    await flushMicrotasks();

    expect(recoverInterruptedActiveAgents).toHaveBeenLastCalledWith(
      'event-loop-stalled',
      { stalledForMs: 60_000 },
    );
    expect(retryNetworkFailedAgentsNow).toHaveBeenLastCalledWith(
      'event-loop-stalled',
    );
  });

  it('retains the main-process timer as a startup fallback', async () => {
    createService();

    vi.setSystemTime(new Date('2026-07-10T00:00:50.000Z'));
    await vi.advanceTimersToNextTimerAsync();
    await flushMicrotasks();

    expect(recoverInterruptedActiveAgents).toHaveBeenCalledWith(
      'event-loop-stalled',
      { stalledForMs: 60_000 },
    );
    expect(retryNetworkFailedAgentsNow).toHaveBeenCalledWith(
      'event-loop-stalled',
    );
  });

  it('unsubscribes from power and watchdog events on teardown', async () => {
    const watchdog = new FakeWatchdog();
    const service = createService(watchdog);

    expect(watchdog.listenerCount).toBe(1);
    await service.teardown();

    expect(watchdog.listenerCount).toBe(0);
    expect(electronMocks.powerMonitor.off).toHaveBeenCalledWith(
      'suspend',
      expect.any(Function),
    );
    expect(electronMocks.powerMonitor.off).toHaveBeenCalledWith(
      'resume',
      expect.any(Function),
    );

    watchdog.emit(50_000);
    electronMocks.emit('resume');
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(recoverInterruptedActiveAgents).not.toHaveBeenCalled();
    expect(getActiveRuntimeProgress).not.toHaveBeenCalled();
  });

  it('reconciles orphaned cloud tasks after system resume', async () => {
    const cloudTasks = {
      reconcile: vi.fn(async () => ({})),
    } satisfies CloudTaskRuntimeRecovery;
    createService(undefined, cloudTasks);

    electronMocks.emit('resume');
    await flushMicrotasks();

    expect(cloudTasks.reconcile).toHaveBeenCalledWith('system-resumed');
  });

  it('uses phase-specific logical-inactivity timeouts', async () => {
    const now = Date.now();
    const timedPhases = [
      ['preparing', 300_000],
      ['resolving-model', 300_000],
      ['generating-context', 300_000],
      ['waiting-model', 300_000],
      ['streaming-model', 300_000],
      ['policy-check', 90_000],
      ['post-step', 120_000],
      ['persisting', 120_000],
      ['compressing', 150_000],
    ] as const satisfies ReadonlyArray<readonly [AgentRuntimePhase, number]>;
    const snapshots = timedPhases.map(([phase, timeoutMs], index) => ({
      agentInstanceId: `agent-${phase}`,
      progress: runtimeProgress({
        phase,
        lastProgressAt: now - timeoutMs,
        stepGeneration: index + 1,
        effectBoundary:
          phase === 'post-step' || phase === 'persisting'
            ? 'post-effect'
            : 'pre-effect',
      }),
    }));
    getActiveRuntimeProgress.mockReturnValue(snapshots);
    createService(new FakeWatchdog());

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(recoverLogicalInactivity).toHaveBeenCalledTimes(snapshots.length);
    for (const snapshot of snapshots) {
      expect(recoverLogicalInactivity).toHaveBeenCalledWith(
        snapshot.agentInstanceId,
        snapshot.progress,
      );
    }
  });

  it('does not time out progress before its phase threshold', async () => {
    const now = Date.now();
    getActiveRuntimeProgress.mockReturnValue([
      {
        agentInstanceId: 'model-agent',
        progress: runtimeProgress({
          phase: 'waiting-model',
          lastProgressAt: now - (300_000 - 10_001),
        }),
      },
      {
        agentInstanceId: 'policy-agent',
        progress: runtimeProgress({
          phase: 'policy-check',
          lastProgressAt: now - (90_000 - 10_001),
        }),
      },
      {
        agentInstanceId: 'persisting-agent',
        progress: runtimeProgress({
          phase: 'persisting',
          lastProgressAt: now - (120_000 - 10_001),
        }),
      },
      {
        agentInstanceId: 'compression-agent',
        progress: runtimeProgress({
          phase: 'compressing',
          lastProgressAt: now - (150_000 - 10_001),
        }),
      },
    ]);
    createService(new FakeWatchdog());

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(recoverLogicalInactivity).not.toHaveBeenCalled();
  });

  it.each([
    'tool-running',
    'awaiting-approval',
    'idle',
  ] as const)('never applies a logical-inactivity timeout while phase is %s', async (phase) => {
    getActiveRuntimeProgress.mockReturnValue([
      {
        agentInstanceId: `agent-${phase}`,
        progress: runtimeProgress({
          phase,
          lastProgressAt: Date.now() - 86_400_000,
          effectBoundary: phase === 'tool-running' ? 'uncertain' : 'pre-effect',
        }),
      },
    ]);
    createService(new FakeWatchdog());

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(recoverLogicalInactivity).not.toHaveBeenCalled();
  });

  it('single-flights an exact snapshot without blocking a newer generation', async () => {
    const first = runtimeProgress({
      phase: 'policy-check',
      lastProgressAt: Date.now() - 120_000,
      stepGeneration: 7,
    });
    const second = runtimeProgress({
      phase: 'post-step',
      lastProgressAt: Date.now() - 180_000,
      stepGeneration: 8,
      effectBoundary: 'uncertain',
    });
    let current = first;
    getActiveRuntimeProgress.mockImplementation(() => [
      { agentInstanceId: 'agent-race', progress: current },
    ]);

    let settleFirst!: (result: AgentLogicalInactivityRecoveryResult) => void;
    const firstRecovery = new Promise<AgentLogicalInactivityRecoveryResult>(
      (resolve) => {
        settleFirst = resolve;
      },
    );
    recoverLogicalInactivity.mockImplementation(
      (_agentInstanceId: string, expected: AgentRuntimeProgress) =>
        expected.stepGeneration === first.stepGeneration
          ? firstRecovery
          : Promise.resolve('failed-closed'),
    );
    createService(new FakeWatchdog());

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recoverLogicalInactivity).toHaveBeenCalledTimes(1);

    current = second;
    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(recoverLogicalInactivity).toHaveBeenCalledTimes(2);
    expect(recoverLogicalInactivity).toHaveBeenNthCalledWith(
      1,
      'agent-race',
      first,
    );
    expect(recoverLogicalInactivity).toHaveBeenNthCalledWith(
      2,
      'agent-race',
      second,
    );

    settleFirst('ignored');
    await flushMicrotasks();
  });

  it('delegates the exact snapshot so a user stop can invalidate recovery', async () => {
    const stoppedGeneration = runtimeProgress({
      phase: 'waiting-model',
      lastProgressAt: Date.now() - 360_000,
      stepGeneration: 12,
    });
    getActiveRuntimeProgress.mockReturnValue([
      { agentInstanceId: 'agent-stopped', progress: stoppedGeneration },
    ]);
    recoverLogicalInactivity.mockResolvedValue('ignored');
    createService(new FakeWatchdog());

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(recoverLogicalInactivity).toHaveBeenCalledWith(
      'agent-stopped',
      stoppedGeneration,
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining(
        'Ignored stale logical-inactivity observation. agentInstanceId=agent-stopped',
      ),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('failed closed without replay'),
    );
  });

  it('suppresses logical recovery through suspend and the resume grace tick', async () => {
    getActiveRuntimeProgress.mockReturnValue([
      {
        agentInstanceId: 'agent-suspended',
        progress: runtimeProgress({
          phase: 'waiting-model',
          lastProgressAt: Date.now() - 600_000,
        }),
      },
    ]);
    createService(new FakeWatchdog());

    electronMocks.emit('suspend');
    await vi.advanceTimersByTimeAsync(60_000);
    electronMocks.emit('resume');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(recoverInterruptedActiveAgents).toHaveBeenCalledTimes(1);
    expect(recoverInterruptedActiveAgents).toHaveBeenCalledWith(
      'system-resumed',
      { stalledForMs: 60_000 },
    );
    expect(getActiveRuntimeProgress).not.toHaveBeenCalled();
    expect(recoverLogicalInactivity).not.toHaveBeenCalled();
  });

  it('applies the same watchdog path to local and isolated active agents', async () => {
    const local = runtimeProgress({
      phase: 'generating-context',
      lastProgressAt: Date.now() - 360_000,
      stepGeneration: 21,
    });
    const isolated = runtimeProgress({
      phase: 'generating-context',
      lastProgressAt: Date.now() - 360_000,
      stepGeneration: 22,
    });
    getActiveRuntimeProgress.mockReturnValue([
      { agentInstanceId: 'local-agent', progress: local },
      { agentInstanceId: 'isolated-agent', progress: isolated },
    ]);
    createService(new FakeWatchdog());

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(recoverLogicalInactivity).toHaveBeenCalledWith('local-agent', local);
    expect(recoverLogicalInactivity).toHaveBeenCalledWith(
      'isolated-agent',
      isolated,
    );
  });
});

function createService(
  watchdog?: AgentRuntimeWatchdog,
  cloudTasks?: CloudTaskRuntimeRecovery,
): AgentRuntimeRecoveryService {
  const service = AgentRuntimeRecoveryService.create(
    logger,
    agentManager,
    watchdog,
    cloudTasks,
  );
  services.push(service);
  return service;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function runtimeProgress(
  overrides: Partial<AgentRuntimeProgress> &
    Pick<AgentRuntimeProgress, 'phase' | 'lastProgressAt'>,
): AgentRuntimeProgress {
  return {
    phase: overrides.phase,
    lastProgressAt: overrides.lastProgressAt,
    stepGeneration: overrides.stepGeneration ?? 1,
    effectBoundary:
      overrides.effectBoundary ??
      ('pre-effect' satisfies AgentRuntimeEffectBoundary),
  };
}
