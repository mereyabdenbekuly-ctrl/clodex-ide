import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
let agentManager: AgentManagerService;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
  vi.clearAllMocks();
  electronMocks.reset();
  recoverInterruptedActiveAgents = vi.fn().mockResolvedValue(undefined);
  retryNetworkFailedAgentsNow = vi.fn().mockResolvedValue(undefined);
  agentManager = {
    recoverInterruptedActiveAgents,
    retryNetworkFailedAgentsNow,
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
    await flushMicrotasks();
    expect(recoverInterruptedActiveAgents).not.toHaveBeenCalled();
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
