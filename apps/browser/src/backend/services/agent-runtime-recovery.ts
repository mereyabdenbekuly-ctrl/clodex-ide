import { powerMonitor } from 'electron';
import type {
  AgentLogicalInactivityRecoveryResult,
  AgentRuntimePhase,
  AgentRuntimeProgress,
} from '@clodex/agent-core';
import { DisposableService } from './disposable';
import type { AgentManagerService } from './agent-manager';
import type { Logger } from './logger';

const EVENT_LOOP_CHECK_INTERVAL_MS = 10_000;
const EVENT_LOOP_STALL_THRESHOLD_MS = 45_000;
const EVENT_LOOP_RESUME_GRACE_MS = 10_000;
const LOGICAL_INACTIVITY_POLL_INTERVAL_MS = 10_000;

const LOGICAL_INACTIVITY_TIMEOUTS_MS: Readonly<
  Partial<Record<AgentRuntimePhase, number>>
> = {
  preparing: 300_000,
  'resolving-model': 300_000,
  'generating-context': 300_000,
  'waiting-model': 300_000,
  'streaming-model': 300_000,
  'policy-check': 90_000,
  'post-step': 120_000,
  persisting: 120_000,
  compressing: 150_000,
};

type ActiveAgentRuntimeProgress = {
  readonly agentInstanceId: string;
  readonly progress: AgentRuntimeProgress;
};

export interface AgentRuntimeWatchdog {
  onMainLoopStall(
    listener: (details: { stalledForMs: number }) => void,
  ): () => void;
}

export interface CloudTaskRuntimeRecovery {
  reconcile(reason: 'system-resumed'): Promise<unknown>;
}

export class AgentRuntimeRecoveryService extends DisposableService {
  private eventLoopCheckInterval: ReturnType<typeof setInterval> | null = null;
  private logicalInactivityPollInterval: ReturnType<typeof setInterval> | null =
    null;
  private lastEventLoopCheckAt = Date.now();
  private suspendedAt: number | null = null;
  private watchdogSuppressedUntil = 0;
  private logicalInactivitySuppressedUntil = 0;
  private recoveryEpoch = 0;
  private readonly logicalRecoveriesInFlight = new Set<string>();
  private readonly removeListeners: Array<() => void> = [];

  private constructor(
    private readonly logger: Logger,
    private readonly agentManager: AgentManagerService,
    private readonly watchdog?: AgentRuntimeWatchdog,
    private readonly cloudTasks?: CloudTaskRuntimeRecovery,
  ) {
    super();
  }

  public static create(
    logger: Logger,
    agentManager: AgentManagerService,
    watchdog?: AgentRuntimeWatchdog,
    cloudTasks?: CloudTaskRuntimeRecovery,
  ): AgentRuntimeRecoveryService {
    const instance = new AgentRuntimeRecoveryService(
      logger,
      agentManager,
      watchdog,
      cloudTasks,
    );
    instance.initialize();
    return instance;
  }

  private recoverInterruptedActiveAgents(
    reason: 'system-resumed' | 'event-loop-stalled',
    details?: { stalledForMs?: number },
  ): void {
    void this.agentManager
      .recoverInterruptedActiveAgents(reason, details)
      .catch((error) => {
        this.logger.warn(
          `[AgentRuntimeRecoveryService] Failed to recover interrupted agents. reason=${reason}`,
          error,
        );
      });
  }

  private retryNetworkFailedAgents(reason: string): void {
    void this.agentManager
      .retryNetworkFailedAgentsNow(reason)
      .catch((error) => {
        this.logger.warn(
          `[AgentRuntimeRecoveryService] Failed to retry network-failed agents. reason=${reason}`,
          error,
        );
      });
  }

  private handleEventLoopStall(stalledForMs: number): void {
    const now = Date.now();
    if (this.suspendedAt !== null || now < this.watchdogSuppressedUntil) {
      return;
    }

    // The event-loop recovery and the logical-inactivity poll share the same
    // agent lifecycle boundary. Suppress the latter while the former has a
    // chance to supersede the interrupted generation, otherwise both timers
    // can observe and recover the same stale step.
    this.recoveryEpoch += 1;
    this.logicalInactivitySuppressedUntil = now + EVENT_LOOP_RESUME_GRACE_MS;

    this.logger.info(
      `[AgentRuntimeRecoveryService] Event loop stall detected. elapsedMs=${stalledForMs}`,
    );

    this.recoverInterruptedActiveAgents('event-loop-stalled', {
      stalledForMs,
    });
    this.retryNetworkFailedAgents('event-loop-stalled');
  }

  private isLogicalInactivitySuppressed(now = Date.now()): boolean {
    return (
      this.suspendedAt !== null || now <= this.logicalInactivitySuppressedUntil
    );
  }

  private pollLogicalInactivity(): void {
    const now = Date.now();
    if (this.isLogicalInactivitySuppressed(now)) return;

    const recoveryEpoch = this.recoveryEpoch;
    let activeAgents: ActiveAgentRuntimeProgress[];
    try {
      activeAgents = this.agentManager.getActiveRuntimeProgress();
    } catch (error) {
      this.logger.warn(
        '[AgentRuntimeRecoveryService] Failed to inspect active agent runtime progress',
        error,
      );
      return;
    }

    for (const { agentInstanceId, progress } of activeAgents) {
      if (
        recoveryEpoch !== this.recoveryEpoch ||
        this.isLogicalInactivitySuppressed()
      ) {
        return;
      }

      const expected = { ...progress };
      const timeoutMs = LOGICAL_INACTIVITY_TIMEOUTS_MS[expected.phase];
      if (timeoutMs === undefined) continue;

      const inactiveForMs = now - expected.lastProgressAt;
      if (!Number.isFinite(inactiveForMs) || inactiveForMs < timeoutMs) {
        continue;
      }

      // Multiple phases can share one step generation, so bind single-flight
      // ownership to the complete expected snapshot. A stale generation N
      // never blocks a legitimately inactive N+1, while repeated timer ticks
      // cannot queue duplicate recovery for the same observation.
      const recoveryKey = this.getLogicalRecoveryKey(agentInstanceId, expected);
      if (this.logicalRecoveriesInFlight.has(recoveryKey)) continue;
      this.logicalRecoveriesInFlight.add(recoveryKey);

      this.logger.warn(
        `[AgentRuntimeRecoveryService] Logical inactivity detected. agentInstanceId=${agentInstanceId}, phase=${expected.phase}, inactiveForMs=${inactiveForMs}, timeoutMs=${timeoutMs}, stepGeneration=${expected.stepGeneration}, effectBoundary=${expected.effectBoundary}`,
      );

      void this.recoverLogicalInactivity(
        agentInstanceId,
        expected,
        recoveryKey,
        recoveryEpoch,
      );
    }
  }

  private async recoverLogicalInactivity(
    agentInstanceId: string,
    expected: AgentRuntimeProgress,
    recoveryKey: string,
    recoveryEpoch: number,
  ): Promise<void> {
    try {
      const result = await this.agentManager.recoverLogicalInactivity(
        agentInstanceId,
        expected,
      );
      if (recoveryEpoch !== this.recoveryEpoch) return;
      this.logLogicalRecoveryResult(agentInstanceId, expected, result);
    } catch (error) {
      if (recoveryEpoch !== this.recoveryEpoch) return;
      this.logger.warn(
        `[AgentRuntimeRecoveryService] Failed to recover logically inactive agent. agentInstanceId=${agentInstanceId}, phase=${expected.phase}, stepGeneration=${expected.stepGeneration}`,
        error,
      );
    } finally {
      this.logicalRecoveriesInFlight.delete(recoveryKey);
    }
  }

  private logLogicalRecoveryResult(
    agentInstanceId: string,
    expected: AgentRuntimeProgress,
    result: AgentLogicalInactivityRecoveryResult,
  ): void {
    const details = `agentInstanceId=${agentInstanceId}, phase=${expected.phase}, stepGeneration=${expected.stepGeneration}, effectBoundary=${expected.effectBoundary}`;
    if (result === 'retried') {
      this.logger.info(
        `[AgentRuntimeRecoveryService] Retried pre-effect logically inactive agent. ${details}`,
      );
      return;
    }
    if (result === 'failed-closed') {
      this.logger.warn(
        `[AgentRuntimeRecoveryService] Logically inactive agent failed closed without replay. ${details}`,
      );
      return;
    }
    this.logger.debug(
      `[AgentRuntimeRecoveryService] Ignored stale logical-inactivity observation. ${details}`,
    );
  }

  private getLogicalRecoveryKey(
    agentInstanceId: string,
    progress: AgentRuntimeProgress,
  ): string {
    return [
      agentInstanceId,
      progress.stepGeneration,
      progress.phase,
      progress.lastProgressAt,
      progress.effectBoundary,
    ].join('\0');
  }

  private initialize(): void {
    const handleSuspend = () => {
      this.recoveryEpoch += 1;
      this.suspendedAt = Date.now();
      this.logger.info('[AgentRuntimeRecoveryService] System suspend detected');
    };

    const handleResume = () => {
      const now = Date.now();
      this.recoveryEpoch += 1;
      const suspendedForMs =
        this.suspendedAt === null ? undefined : now - this.suspendedAt;
      this.suspendedAt = null;
      this.lastEventLoopCheckAt = now;
      this.watchdogSuppressedUntil = now + EVENT_LOOP_RESUME_GRACE_MS;
      this.logicalInactivitySuppressedUntil = now + EVENT_LOOP_RESUME_GRACE_MS;

      this.logger.info(
        `[AgentRuntimeRecoveryService] System resume detected${
          suspendedForMs === undefined
            ? ''
            : ` after ${Math.round(suspendedForMs / 1000)}s`
        }`,
      );

      this.recoverInterruptedActiveAgents('system-resumed', {
        stalledForMs: suspendedForMs,
      });
      this.retryNetworkFailedAgents('system-resumed');
      void this.cloudTasks?.reconcile('system-resumed').catch((error) => {
        this.logger.warn(
          '[AgentRuntimeRecoveryService] Failed to reconcile cloud tasks after resume',
          error,
        );
      });
    };

    powerMonitor.on('suspend', handleSuspend);
    powerMonitor.on('resume', handleResume);
    this.removeListeners.push(() => {
      powerMonitor.off('suspend', handleSuspend);
      powerMonitor.off('resume', handleResume);
    });

    if (this.watchdog) {
      this.removeListeners.push(
        this.watchdog.onMainLoopStall(({ stalledForMs }) => {
          this.handleEventLoopStall(stalledForMs);
        }),
      );
    } else {
      this.eventLoopCheckInterval = setInterval(() => {
        const now = Date.now();
        const elapsedMs = now - this.lastEventLoopCheckAt;
        this.lastEventLoopCheckAt = now;

        if (elapsedMs < EVENT_LOOP_STALL_THRESHOLD_MS) return;
        this.handleEventLoopStall(elapsedMs);
      }, EVENT_LOOP_CHECK_INTERVAL_MS);
      this.eventLoopCheckInterval.unref?.();
    }

    this.logicalInactivityPollInterval = setInterval(() => {
      this.pollLogicalInactivity();
    }, LOGICAL_INACTIVITY_POLL_INTERVAL_MS);
    this.logicalInactivityPollInterval.unref?.();
  }

  protected onTeardown(): void {
    this.recoveryEpoch += 1;
    for (const removeListener of this.removeListeners.splice(0)) {
      removeListener();
    }

    if (this.eventLoopCheckInterval) {
      clearInterval(this.eventLoopCheckInterval);
      this.eventLoopCheckInterval = null;
    }

    if (this.logicalInactivityPollInterval) {
      clearInterval(this.logicalInactivityPollInterval);
      this.logicalInactivityPollInterval = null;
    }
  }
}
