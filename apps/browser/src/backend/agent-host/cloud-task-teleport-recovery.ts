import type { CloudTaskTeleportState } from '@shared/cloud-task-teleport';
import type { AgentMessage } from '@shared/karton-contracts/ui/agent';
import type { InferUIMessageChunk } from 'ai';
import type { CloudTaskTeleportSession } from '../services/cloud-task-teleport';
import type {
  CloudTaskControlPlane,
  CloudTaskStartedExecution,
  CloudTaskStreamEvent,
} from './cloud-task-control-plane';
import type { CloudTaskExecutionHandoffCoordinator } from './cloud-task-execution-handoff';
import type { CloudTaskExecutionLeaseRegistry } from './cloud-task-execution-lease';
import type {
  CloudTaskStreamResumeCheckpoint,
  CloudTaskStreamResumeStore,
} from './cloud-task-resume-store';
import type {
  CloudDataResidency,
  CloudTaskCredentialLease,
  CloudTaskExecutionPolicy,
  CloudTaskSecretBroker,
} from './cloud-task-security';
import type { CloudTaskTeleportObserver } from './cloud-task-production-adapter';
import type { CloudTaskArtifactDownloader } from './cloud-task-artifacts';
import type { CloudTaskEvidenceMemorySynchronizer } from './cloud-task-evidence-memory';

export interface CloudTaskTeleportRecoveryOptions {
  controlPlane: CloudTaskControlPlane;
  secretBroker: CloudTaskSecretBroker;
  resumeStore: CloudTaskStreamResumeStore;
  handoffCoordinator: CloudTaskExecutionHandoffCoordinator;
  leaseRegistry: CloudTaskExecutionLeaseRegistry;
  artifactDownloader?: CloudTaskArtifactDownloader;
  evidenceMemorySynchronizer?: CloudTaskEvidenceMemorySynchronizer;
  policy?: CloudTaskExecutionPolicy;
  residency: CloudDataResidency;
  leaseHolderId: string;
  isFeatureEnabled?: () => boolean;
  now?: () => number;
}

export interface CloudTaskTeleportRecoveryHostBindings {
  assertLocalSafePoint(agentInstanceId: string): Promise<void>;
  replayChunk(
    agentInstanceId: string,
    input: {
      executionId: string;
      sequence: number;
      chunk: InferUIMessageChunk<AgentMessage>;
    },
  ): Promise<'applied' | 'duplicate'>;
  finishReplay(
    agentInstanceId: string,
    input: {
      executionId: string;
      outcome: 'completed' | 'cancelled' | 'failed';
      error?: unknown;
    },
  ): Promise<void>;
}

type RecoveredSession = {
  checkpoint: CloudTaskStreamResumeCheckpoint;
  state: CloudTaskTeleportState;
  unregister: (() => void) | null;
  credential: CloudTaskCredentialLease | null;
  monitoring: Promise<void> | null;
};

/**
 * Reconstructs suspended handoffs and cloud-owned streams after a
 * main-process restart.
 *
 * Only opaque identifiers, epoch, and replay cursor are restored from disk.
 * Suspended sessions mint credentials only after explicit Resume; cloud-owned
 * sessions automatically obtain a fresh scoped credential while remaining
 * locally fenced.
 */
export class CloudTaskTeleportRecovery {
  private readonly now: () => number;
  private observer: CloudTaskTeleportObserver | null = null;
  private hostBindings: CloudTaskTeleportRecoveryHostBindings | null = null;
  private readonly sessions = new Map<string, RecoveredSession>();

  public constructor(
    private readonly options: CloudTaskTeleportRecoveryOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  public setHostBindings(
    bindings: CloudTaskTeleportRecoveryHostBindings,
  ): void {
    this.hostBindings = bindings;
  }

  public async restore(observer: CloudTaskTeleportObserver): Promise<number> {
    this.observer = observer;
    const checkpoints = await this.options.resumeStore.listPending();
    let restored = 0;
    for (const checkpoint of checkpoints) {
      if (
        (!checkpoint.handoff && !checkpoint.cloudOwnership) ||
        !checkpoint.agentInstanceId
      ) {
        continue;
      }
      if (this.sessions.has(checkpoint.agentInstanceId)) continue;
      const state = checkpoint.handoff
        ? this.toSuspendedState(checkpoint)
        : this.toCloudOwnedRestoringState(checkpoint);
      const recovered: RecoveredSession = {
        checkpoint,
        state,
        unregister: null,
        credential: null,
        monitoring: null,
      };
      const session: CloudTaskTeleportSession = {
        state,
        continueLocally: async () => {
          throw new Error(
            checkpoint.handoff
              ? 'Recovered Teleport session is already local-owned'
              : 'Recovered cloud execution must reach a confirmed terminal state',
          );
        },
        resumeInCloud: async () =>
          checkpoint.handoff
            ? await this.resume(recovered)
            : await this.retryCloudOwnedRecovery(recovered),
      };
      recovered.unregister = observer.register(session);
      this.sessions.set(checkpoint.agentInstanceId, recovered);
      if (checkpoint.cloudOwnership) {
        this.options.leaseRegistry.fence(
          checkpoint.agentInstanceId,
          checkpoint.cloudOwnership.epoch,
        );
        await this.options.evidenceMemorySynchronizer?.restoreDurableFence?.({
          taskId: checkpoint.taskId,
          agentInstanceId: checkpoint.agentInstanceId,
          epoch: checkpoint.cloudOwnership.epoch,
          checkpoint: checkpoint.memoryCheckpoint,
        });
        if (this.options.isFeatureEnabled?.() === false) {
          recovered.state = {
            ...recovered.state,
            phase: 'failed',
            error: 'Cloud Tasks is disabled; local execution remains fenced',
            updatedAt: this.now(),
          };
          observer.update(checkpoint.agentInstanceId, recovered.state);
        } else {
          this.startCloudOwnedRecovery(recovered);
        }
      }
      restored += 1;
    }
    return restored;
  }

  public async teardown(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()].map(async (session) => {
        session.unregister?.();
        await session.credential?.dispose();
      }),
    );
    this.sessions.clear();
    this.observer = null;
  }

  private startCloudOwnedRecovery(recovered: RecoveredSession): void {
    const monitoring = this.recoverCloudOwned(recovered);
    recovered.monitoring = monitoring;
    void monitoring.catch(() => {
      // recoverCloudOwned publishes a safe failed state and retains the fence.
    });
  }

  private async retryCloudOwnedRecovery(
    recovered: RecoveredSession,
  ): Promise<CloudTaskTeleportState> {
    if (recovered.monitoring) {
      throw new Error('Recovered cloud execution is already reconnecting');
    }
    recovered.state = {
      ...recovered.state,
      phase: 'restoring',
      updatedAt: this.now(),
      error: null,
    };
    this.observer?.update(recovered.state.agentInstanceId, {
      phase: 'restoring',
      updatedAt: recovered.state.updatedAt,
      error: null,
    });
    this.startCloudOwnedRecovery(recovered);
    return recovered.state;
  }

  private async recoverCloudOwned(recovered: RecoveredSession): Promise<void> {
    const checkpoint = recovered.checkpoint;
    const ownership = checkpoint.cloudOwnership;
    const agentInstanceId = checkpoint.agentInstanceId;
    if (!ownership || !agentInstanceId) {
      throw new Error('Recovered cloud ownership binding is incomplete');
    }
    let credential: CloudTaskCredentialLease | null = null;
    let lease:
      | Parameters<CloudTaskExecutionLeaseRegistry['activate']>[1]
      | null = null;
    try {
      const hostBindings = this.hostBindings;
      if (!hostBindings) {
        throw new Error('Recovered Teleport host bindings are unavailable');
      }
      credential = await this.options.secretBroker.acquire({
        taskId: checkpoint.taskId,
        residency: this.options.residency,
        scopes: ['task:lease', 'task:status', 'task:stream', 'task:memory'],
      });
      const acquireExecutionLease =
        this.options.controlPlane.acquireExecutionLease;
      if (!acquireExecutionLease) {
        throw new Error('Cloud task execution lease API is unavailable');
      }
      lease = await acquireExecutionLease.call(
        this.options.controlPlane,
        {
          taskId: checkpoint.taskId,
          executionId: checkpoint.executionId,
          holderId: this.options.leaseHolderId,
          checkpointId: null,
          restoreReceiptId: checkpoint.restoreReceiptId,
        },
        credential.token,
      );
      this.options.leaseRegistry.activate(agentInstanceId, lease);
      const execution = this.toRecoveredExecution(checkpoint);
      const memoryCheckpoint =
        (await this.options.evidenceMemorySynchronizer?.recoverCloudOwnership?.(
          {
            taskId: checkpoint.taskId,
            agentInstanceId,
            execution,
            lease,
            checkpoint: checkpoint.memoryCheckpoint,
          },
        )) ?? checkpoint.memoryCheckpoint;
      const status = await this.options.controlPlane.getExecutionStatus(
        checkpoint.taskId,
        checkpoint.executionId,
        credential.token,
        undefined,
        lease,
      );
      if (
        status.status === 'completed' ||
        status.status === 'failed' ||
        status.status === 'cancelled'
      ) {
        await hostBindings.finishReplay(agentInstanceId, {
          executionId: checkpoint.executionId,
          outcome: status.status,
          error:
            status.status === 'failed'
              ? new Error('Recovered cloud execution failed')
              : undefined,
        });
        await this.releaseRecoveredOwnership(
          recovered,
          execution,
          lease,
          credential,
        );
        await credential.dispose();
        credential = null;
        lease = null;
        return;
      }
      if (status.status === 'suspended') {
        throw new Error(
          'Recovered cloud execution is suspended without a durable handoff',
        );
      }

      await this.options.resumeStore.save(
        execution,
        checkpoint.lastSequence,
        null,
        {
          agentInstanceId,
          cloudOwnership: { epoch: lease.epoch },
          ...(memoryCheckpoint ? { memoryCheckpoint } : {}),
        },
      );
      recovered.checkpoint = {
        ...checkpoint,
        cloudOwnership: { epoch: lease.epoch },
        memoryCheckpoint,
        updatedAt: this.now(),
      };
      recovered.credential = credential;
      recovered.state = {
        ...recovered.state,
        phase: 'cloud-owned',
        epoch: lease.epoch,
        memoryCheckpointId: memoryCheckpoint?.checkpointId ?? null,
        memoryEventCount: memoryCheckpoint?.eventCount ?? null,
        memorySyncState: memoryCheckpoint?.syncState ?? null,
        updatedAt: this.now(),
        error: null,
      };
      this.observer?.update(agentInstanceId, {
        phase: 'cloud-owned',
        epoch: lease.epoch,
        memoryCheckpointId: memoryCheckpoint?.checkpointId ?? null,
        memoryEventCount: memoryCheckpoint?.eventCount ?? null,
        memorySyncState: memoryCheckpoint?.syncState ?? null,
        updatedAt: recovered.state.updatedAt,
        error: null,
      });
      await this.monitorRecoveredExecution(recovered, execution, lease);
      credential = null;
      lease = null;
    } catch (error) {
      const message = safeRecoveryErrorMessage(error);
      recovered.state = {
        ...recovered.state,
        phase: 'failed',
        updatedAt: this.now(),
        error: message,
      };
      this.observer?.update(agentInstanceId, {
        phase: 'failed',
        updatedAt: recovered.state.updatedAt,
        error: message,
      });
      // Ownership remains fenced until a newer epoch is acquired and released
      // or a confirmed terminal status is observed.
      throw error;
    } finally {
      if (credential) {
        if (lease) {
          await this.options.controlPlane.releaseExecutionLease
            ?.call(this.options.controlPlane, lease, credential.token)
            .catch(() => undefined);
        }
        await credential.dispose();
      }
      recovered.monitoring = null;
    }
  }

  private async resume(
    recovered: RecoveredSession,
  ): Promise<CloudTaskTeleportState> {
    if (recovered.monitoring) {
      throw new Error('Recovered Teleport execution is already resuming');
    }
    const { checkpoint } = recovered;
    const handoff = checkpoint.handoff;
    const agentInstanceId = checkpoint.agentInstanceId;
    if (!handoff || !agentInstanceId) {
      throw new Error('Recovered Teleport handoff binding is incomplete');
    }
    const hostBindings = this.hostBindings;
    if (!hostBindings) {
      throw new Error('Recovered Teleport host bindings are unavailable');
    }
    if (checkpoint.expiresAt <= this.now()) {
      await this.options.resumeStore.clearByExecutionId(checkpoint.executionId);
      throw new Error('Recovered Teleport handoff has expired');
    }

    const credential = await this.options.secretBroker.acquire({
      taskId: checkpoint.taskId,
      residency: this.options.residency,
      scopes: ['task:lease', 'task:resume', 'task:stream', 'task:memory'],
    });
    try {
      const result = await this.options.handoffCoordinator.resumeInCloud({
        agentInstanceId,
        execution: this.toRecoveredExecution(checkpoint),
        handoff: {
          handoffId: handoff.handoffId,
          taskId: checkpoint.taskId,
          executionId: checkpoint.executionId,
          restoreReceiptId: checkpoint.restoreReceiptId,
          sourceLeaseId: handoff.sourceLeaseId,
          sourceEpoch: handoff.sourceEpoch,
          suspendedAtSequence: handoff.suspendedAtSequence,
          createdAt: checkpoint.updatedAt,
          expiresAt: checkpoint.expiresAt,
        },
        holderId: this.options.leaseHolderId,
        taskCredential: credential.token,
        assertLocalSafePoint: async () => {
          if (
            checkpoint.lastSequence !== handoff.suspendedAtSequence ||
            checkpoint.expiresAt <= this.now()
          ) {
            throw new Error(
              'Recovered Teleport checkpoint is not a valid local safe point',
            );
          }
          await hostBindings.assertLocalSafePoint(agentInstanceId);
        },
      });
      recovered.credential = credential;
      const memoryCheckpoint =
        this.options.handoffCoordinator.getMemoryCheckpoint(
          result.execution.executionId,
        );
      recovered.checkpoint = {
        ...checkpoint,
        handoff: null,
        cloudOwnership: { epoch: result.lease.epoch },
        memoryCheckpoint,
        updatedAt: this.now(),
      };
      recovered.state = {
        agentInstanceId,
        taskId: result.execution.taskId,
        executionId: result.execution.executionId,
        phase: 'cloud-owned',
        epoch: result.lease.epoch,
        handoffId: null,
        lastSequence: result.resumeAfterSequence,
        memoryCheckpointId: memoryCheckpoint?.checkpointId ?? null,
        memoryEventCount: memoryCheckpoint?.eventCount ?? null,
        memorySyncState: memoryCheckpoint?.syncState ?? null,
        updatedAt: this.now(),
        error: null,
      };
      recovered.monitoring = this.monitorRecoveredExecution(
        recovered,
        result.execution,
        result.lease,
      );
      return recovered.state;
    } catch (error) {
      await credential.dispose();
      throw error;
    }
  }

  private async monitorRecoveredExecution(
    recovered: RecoveredSession,
    execution: CloudTaskStartedExecution,
    lease: Parameters<CloudTaskExecutionLeaseRegistry['activate']>[1],
  ): Promise<void> {
    const agentInstanceId = recovered.state.agentInstanceId;
    const credential = recovered.credential;
    if (!credential) return;
    let terminal = false;
    try {
      const hostBindings = this.hostBindings;
      if (!hostBindings) {
        throw new Error('Recovered Teleport host bindings are unavailable');
      }
      for await (const event of this.options.controlPlane.streamExecution(
        execution,
        credential.token,
        recovered.state.lastSequence,
        undefined,
        lease,
      )) {
        this.options.leaseRegistry.assertCurrent(agentInstanceId, lease);
        const replayChunk = await this.toRecoveredUiChunk(event, execution);
        if (replayChunk) {
          await hostBindings.replayChunk(agentInstanceId, {
            executionId: execution.executionId,
            sequence: event.sequence,
            chunk: replayChunk,
          });
        }
        if (event.type === 'completed') {
          await hostBindings.finishReplay(agentInstanceId, {
            executionId: execution.executionId,
            outcome: 'completed',
          });
        } else if (event.type === 'cancelled') {
          await hostBindings.finishReplay(agentInstanceId, {
            executionId: execution.executionId,
            outcome: 'cancelled',
          });
        } else if (event.type === 'failed') {
          await hostBindings.finishReplay(agentInstanceId, {
            executionId: execution.executionId,
            outcome: 'failed',
            // Remote reasons are intentionally not copied into durable chat:
            // they may contain provider URLs, paths, or prompt fragments.
            error: new Error('Recovered cloud execution failed'),
          });
        }

        // Crash-safety ordering is intentional: the assistant history and its
        // cloudReplay marker must commit before the external stream cursor.
        recovered.state = {
          ...recovered.state,
          lastSequence: event.sequence,
          updatedAt: this.now(),
        };
        this.observer?.update(agentInstanceId, {
          lastSequence: event.sequence,
          updatedAt: recovered.state.updatedAt,
        });
        await this.options.resumeStore.save(execution, event.sequence, null, {
          agentInstanceId,
          cloudOwnership: { epoch: lease.epoch },
          ...(recovered.checkpoint.memoryCheckpoint
            ? {
                memoryCheckpoint: {
                  ...recovered.checkpoint.memoryCheckpoint,
                  epoch: lease.epoch,
                  lastSequence: event.sequence,
                },
              }
            : {}),
        });
        recovered.checkpoint = {
          ...recovered.checkpoint,
          handoff: null,
          lastSequence: event.sequence,
          cloudOwnership: { epoch: lease.epoch },
          memoryCheckpoint: recovered.checkpoint.memoryCheckpoint
            ? {
                ...recovered.checkpoint.memoryCheckpoint,
                epoch: lease.epoch,
                lastSequence: event.sequence,
              }
            : null,
          updatedAt: recovered.state.updatedAt,
        };
        if (isTerminalEvent(event)) {
          terminal = true;
          break;
        }
      }
      if (!terminal) {
        throw new Error(
          'Recovered cloud task stream ended before a terminal event',
        );
      }
      await this.releaseRecoveredOwnership(
        recovered,
        execution,
        lease,
        credential,
      );
    } catch (error) {
      const message = safeRecoveryErrorMessage(error);
      recovered.state = {
        ...recovered.state,
        phase: 'failed',
        updatedAt: this.now(),
        error: message,
      };
      this.observer?.update(agentInstanceId, {
        phase: 'failed',
        updatedAt: recovered.state.updatedAt,
        error: message,
      });
      // Fail closed: retain the lease mirror and checkpoint until expiry or
      // the next startup reconciler proves remote state.
    } finally {
      await credential.dispose();
      recovered.credential = null;
      recovered.monitoring = null;
    }
  }

  private async toRecoveredUiChunk(
    event: CloudTaskStreamEvent,
    execution: CloudTaskStartedExecution,
  ): Promise<InferUIMessageChunk<AgentMessage> | null> {
    if (event.type === 'chunk') {
      return event.chunk as InferUIMessageChunk<AgentMessage>;
    }
    if (event.type === 'log') {
      return {
        type: 'data-cloud-log',
        id: `cloud-log-${event.sequence}`,
        data: {
          level: event.level,
          // Raw remote logs may contain paths, URLs, or prompt fragments.
          message: `Recovered cloud ${event.level} log event`,
        },
      } as InferUIMessageChunk<AgentMessage>;
    }
    if (event.type === 'usage') {
      return {
        type: 'data-cloud-usage',
        id: `cloud-usage-${event.sequence}`,
        data: {
          durationMs: event.durationMs,
          costMicros: event.costMicros,
        },
      } as InferUIMessageChunk<AgentMessage>;
    }
    if (event.type === 'artifact') {
      const downloader = this.options.artifactDownloader;
      const policy = this.options.policy;
      if (!downloader || !policy) {
        throw new Error('Recovered cloud artifact downloader is unavailable');
      }
      const downloaded = await downloader.download({
        taskId: execution.taskId,
        execution,
        artifact: event.artifact,
        policy,
      });
      return {
        type: 'data-cloud-artifact',
        id: `cloud-artifact-${event.sequence}`,
        data: {
          executionId: downloaded.executionId,
          artifactId: downloaded.artifactId,
          fileName: downloaded.fileName,
          mediaType: downloaded.mediaType,
          sizeBytes: downloaded.sizeBytes,
        },
      } as InferUIMessageChunk<AgentMessage>;
    }
    return null;
  }

  private async releaseRecoveredOwnership(
    recovered: RecoveredSession,
    execution: CloudTaskStartedExecution,
    lease: Parameters<CloudTaskExecutionLeaseRegistry['activate']>[1],
    credential: CloudTaskCredentialLease,
  ): Promise<void> {
    const releaseExecutionLease =
      this.options.controlPlane.releaseExecutionLease;
    if (!releaseExecutionLease) {
      throw new Error('Cloud task execution lease API is unavailable');
    }
    await releaseExecutionLease.call(
      this.options.controlPlane,
      lease,
      credential.token,
    );
    await this.options.resumeStore.clear(execution);
    this.options.leaseRegistry.release(recovered.state.agentInstanceId, lease);
    this.options.leaseRegistry.clearFence(
      recovered.state.agentInstanceId,
      lease.epoch,
    );
    recovered.unregister?.();
    this.sessions.delete(recovered.state.agentInstanceId);
    recovered.credential = null;
    recovered.monitoring = null;
  }

  private toSuspendedState(
    checkpoint: CloudTaskStreamResumeCheckpoint,
  ): CloudTaskTeleportState {
    return {
      agentInstanceId: checkpoint.agentInstanceId!,
      taskId: checkpoint.taskId,
      executionId: checkpoint.executionId,
      phase: 'suspended',
      epoch: checkpoint.handoff!.sourceEpoch,
      handoffId: checkpoint.handoff!.handoffId,
      lastSequence: checkpoint.lastSequence,
      memoryCheckpointId: checkpoint.memoryCheckpoint?.checkpointId ?? null,
      memoryEventCount: checkpoint.memoryCheckpoint?.eventCount ?? null,
      memorySyncState: checkpoint.memoryCheckpoint?.syncState ?? null,
      updatedAt: checkpoint.updatedAt,
      error: null,
    };
  }

  private toCloudOwnedRestoringState(
    checkpoint: CloudTaskStreamResumeCheckpoint,
  ): CloudTaskTeleportState {
    return {
      agentInstanceId: checkpoint.agentInstanceId!,
      taskId: checkpoint.taskId,
      executionId: checkpoint.executionId,
      phase: 'restoring',
      epoch: checkpoint.cloudOwnership!.epoch,
      handoffId: null,
      lastSequence: checkpoint.lastSequence,
      memoryCheckpointId: checkpoint.memoryCheckpoint?.checkpointId ?? null,
      memoryEventCount: checkpoint.memoryCheckpoint?.eventCount ?? null,
      memorySyncState: checkpoint.memoryCheckpoint?.syncState ?? null,
      updatedAt: checkpoint.updatedAt,
      error: null,
    };
  }

  private toRecoveredExecution(
    checkpoint: CloudTaskStreamResumeCheckpoint,
  ): CloudTaskStartedExecution {
    return {
      taskId: checkpoint.taskId,
      executionId: checkpoint.executionId,
      restoreReceiptId: checkpoint.restoreReceiptId,
      streamUrl: 'https://recovered.invalid/stream',
      cancelUrl: 'https://recovered.invalid/cancel',
      expiresAt: checkpoint.expiresAt,
    };
  }
}

function isTerminalEvent(event: CloudTaskStreamEvent): boolean {
  return (
    event.type === 'completed' ||
    event.type === 'failed' ||
    event.type === 'cancelled'
  );
}

function safeRecoveryErrorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    (error.message === 'Cloud task execution lease API is unavailable' ||
      error.message === 'Recovered Teleport host bindings are unavailable' ||
      error.message ===
        'Recovered cloud execution is suspended without a durable handoff' ||
      error.message === 'Recovered cloud artifact downloader is unavailable')
  ) {
    return error.message;
  }
  return 'Cloud execution recovery could not confirm remote ownership';
}
