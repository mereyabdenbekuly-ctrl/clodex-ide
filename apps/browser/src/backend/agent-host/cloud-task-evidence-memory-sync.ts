import { createHash } from 'node:crypto';
import {
  EvidenceMemoryDivergenceError,
  EvidenceMemoryFencedWriteError,
  hashEvidenceMemoryFencingToken,
  type EvidenceMemoryCheckpoint,
  type EvidenceMemoryService,
  type EvidenceMemorySyncBatch,
  type EvidenceMemorySyncCursor,
  type EvidenceMemorySyncEventEnvelope,
  type EvidenceMemoryWriteFence,
} from '@clodex/agent-core/evidence-memory';
import type {
  CloudTaskMemoryDivergenceResolution,
  CloudTaskMemoryRecoveryClass,
  CloudTaskMemorySyncDirection,
  CloudTaskMemorySyncErrorCode,
  CloudTaskMemorySyncOperation,
} from '@shared/cloud-task-memory-sync';
import type {
  CloudTaskEvidenceMemoryCheckpointState,
  CloudTaskEvidenceMemorySynchronizer,
} from './cloud-task-evidence-memory';
import type { CloudTaskStartedExecution } from './cloud-task-control-plane';
import {
  CloudTaskMemoryCompareAndSwapError,
  createCloudTaskMemoryMutationId,
  sameCloudTaskMemoryCheckpoint,
  type CloudTaskMemoryAtomicMergeReceipt,
  type CloudTaskMemoryAtomicMergeRequest,
} from './cloud-task-memory-atomic-sync';
import type { FileSystemCloudTaskMemorySyncJournal } from './cloud-task-memory-sync-journal';
import {
  CloudTaskMemoryRecoveryPolicy,
  type CloudTaskMemoryRecoveryPolicyOptions,
} from './cloud-task-memory-recovery-policy';

export interface CloudTaskEvidenceMemoryTransport {
  push(input: {
    taskId: string;
    execution: CloudTaskStartedExecution;
    batch: EvidenceMemorySyncBatch;
    taskCredential: string;
    signal?: AbortSignal;
  }): Promise<{ checkpointId: string; eventCount: number }>;
  pull(input: {
    taskId: string;
    execution: CloudTaskStartedExecution;
    cursor: EvidenceMemorySyncCursor | null;
    taskCredential: string;
    signal?: AbortSignal;
  }): Promise<EvidenceMemorySyncBatch>;
  resolveDivergence(input: {
    taskId: string;
    execution: CloudTaskStartedExecution;
    strategy: 'keep-local';
    taskCredential: string;
    signal?: AbortSignal;
  }): Promise<void>;
  commitAtomicMerge?(input: {
    taskId: string;
    execution: CloudTaskStartedExecution;
    request: CloudTaskMemoryAtomicMergeRequest;
    taskCredential: string;
    signal?: AbortSignal;
  }): Promise<CloudTaskMemoryAtomicMergeReceipt>;
}

export interface LocalCloudTaskEvidenceMemorySynchronizerOptions {
  evidenceMemory: EvidenceMemoryService;
  transport: CloudTaskEvidenceMemoryTransport;
  journal?: Pick<FileSystemCloudTaskMemorySyncJournal, 'record'>;
  batchSize?: number;
  recoveryPolicy?: CloudTaskMemoryRecoveryPolicyOptions;
}

interface AutomaticMergeContext {
  taskCredential: string;
  epoch: number;
  lastSequence: number;
  writeFence?: EvidenceMemoryWriteFence;
  signal?: AbortSignal;
}

/**
 * Bridges the local Evidence Memory ledger with an authorized cloud transport.
 * The transport carries encrypted task-scoped envelopes; Teleport itself only
 * persists opaque checkpoint identity, counts, epoch, and sync status.
 */
export class LocalCloudTaskEvidenceMemorySynchronizer
  implements CloudTaskEvidenceMemorySynchronizer
{
  private readonly batchSize: number;
  private readonly stateByExecution = new Map<
    string,
    CloudTaskEvidenceMemoryCheckpointState
  >();
  private readonly attemptsByExecution = new Map<string, number>();
  private readonly pendingAtomicMergeByExecution = new Map<
    string,
    CloudTaskMemoryAtomicMergeRequest
  >();
  private readonly atomicDiagnosticsByExecution = new Map<
    string,
    { protocol: 'legacy' | 'atomic-v1'; idempotentReplay: boolean }
  >();
  private readonly recoveryPolicy: CloudTaskMemoryRecoveryPolicy;

  public constructor(
    private readonly options: LocalCloudTaskEvidenceMemorySynchronizerOptions,
  ) {
    this.batchSize = options.batchSize ?? 500;
    this.recoveryPolicy = new CloudTaskMemoryRecoveryPolicy(
      options.recoveryPolicy,
    );
    if (
      !Number.isSafeInteger(this.batchSize) ||
      this.batchSize <= 0 ||
      this.batchSize > 500
    ) {
      throw new Error('Evidence memory sync batch size is invalid');
    }
  }

  public getCheckpointState(
    executionId: string,
  ): CloudTaskEvidenceMemoryCheckpointState | null {
    const state = this.stateByExecution.get(executionId);
    return state ? structuredClone(state) : null;
  }

  public async prepareCloudRestore(
    input: Parameters<
      CloudTaskEvidenceMemorySynchronizer['prepareCloudRestore']
    >[0],
  ): Promise<CloudTaskEvidenceMemoryCheckpointState | null> {
    return await this.observe(
      input,
      'prepare-cloud-restore',
      'local-to-cloud',
      async () => await this.prepareCloudRestoreImpl(input),
      null,
      {
        taskCredential: input.taskCredential,
        epoch: 1,
        lastSequence: 0,
        signal: input.signal,
      },
    );
  }

  public async activateCloudOwnership(
    input: Parameters<
      CloudTaskEvidenceMemorySynchronizer['activateCloudOwnership']
    >[0],
  ): Promise<CloudTaskEvidenceMemoryCheckpointState | null> {
    return await this.observe(
      input,
      'activate-cloud-ownership',
      'ownership-only',
      async () => await this.activateCloudOwnershipImpl(input),
    );
  }

  public async synchronizeCloudToLocal(
    input: Parameters<
      CloudTaskEvidenceMemorySynchronizer['synchronizeCloudToLocal']
    >[0],
  ): Promise<CloudTaskEvidenceMemoryCheckpointState | null> {
    return await this.observe(
      {
        ...input,
        taskId: input.execution.taskId,
      },
      'cloud-to-local',
      'cloud-to-local',
      async () => await this.synchronizeCloudToLocalImpl(input),
      null,
      {
        taskCredential: input.taskCredential,
        epoch: input.lease.epoch,
        lastSequence: input.handoff.suspendedAtSequence,
        writeFence: {
          owner: 'cloud',
          epoch: input.lease.epoch,
          fencingTokenHash: hashEvidenceMemoryFencingToken(
            input.lease.fencingToken,
          ),
        },
        signal: input.signal,
      },
    );
  }

  public async prepareResumeInCloud(
    input: Parameters<
      CloudTaskEvidenceMemorySynchronizer['prepareResumeInCloud']
    >[0],
  ): Promise<CloudTaskEvidenceMemoryCheckpointState | null> {
    return await this.observe(
      {
        ...input,
        taskId: input.execution.taskId,
      },
      'local-to-cloud',
      'local-to-cloud',
      async () => await this.prepareResumeInCloudImpl(input),
      null,
      {
        taskCredential: input.taskCredential,
        epoch: input.handoff.sourceEpoch,
        lastSequence: input.handoff.suspendedAtSequence,
        signal: input.signal,
      },
    );
  }

  public async recoverCloudOwnership(
    input: Parameters<
      NonNullable<CloudTaskEvidenceMemorySynchronizer['recoverCloudOwnership']>
    >[0],
  ): Promise<CloudTaskEvidenceMemoryCheckpointState | null> {
    return await this.observe(
      input,
      'recover-cloud-ownership',
      'ownership-only',
      async () => await this.activateCloudOwnershipImpl(input),
    );
  }

  public restoreDurableFence(input: {
    taskId: string;
    agentInstanceId: string;
    epoch: number;
    checkpoint: CloudTaskEvidenceMemoryCheckpointState | null;
  }): void {
    void input.agentInstanceId;
    void input.checkpoint;
    this.options.evidenceMemory.activateWriteAuthority(input.taskId, {
      owner: 'cloud',
      epoch: input.epoch,
    });
  }

  private async prepareCloudRestoreImpl(input: {
    taskId: string;
    agentInstanceId: string;
    execution: CloudTaskStartedExecution;
    checkpoint: {
      checkpointId: string;
      eventCount: number;
      ledgerHash: string;
    } | null;
    taskCredential: string;
    signal?: AbortSignal;
  }): Promise<CloudTaskEvidenceMemoryCheckpointState | null> {
    void input.agentInstanceId;
    if (!input.checkpoint) return null;
    if (
      !(await this.options.evidenceMemory.verifyCheckpointIdentity(
        input.taskId,
        input.checkpoint,
      ))
    ) {
      throw new Error('Session checkpoint evidence memory binding is stale');
    }
    const local = await this.options.evidenceMemory.createCheckpoint(
      input.taskId,
    );
    const remote = await this.pushAll({
      taskId: input.taskId,
      execution: input.execution,
      taskCredential: input.taskCredential,
      signal: input.signal,
    });
    if (
      remote.checkpointId !== local.checkpointId ||
      remote.eventCount !== local.eventCount
    ) {
      throw new Error('Cloud evidence memory checkpoint did not converge');
    }
    return {
      checkpointId: local.checkpointId,
      eventCount: local.eventCount,
      epoch: 1,
      lastSequence: 0,
      syncState: 'synchronized',
    };
  }

  private async activateCloudOwnershipImpl(input: {
    taskId: string;
    agentInstanceId: string;
    execution: CloudTaskStartedExecution;
    lease: {
      epoch: number;
      fencingToken: string;
    };
    checkpoint: CloudTaskEvidenceMemoryCheckpointState | null;
  }): Promise<CloudTaskEvidenceMemoryCheckpointState | null> {
    void input.agentInstanceId;
    void input.execution;
    this.options.evidenceMemory.activateWriteAuthority(input.taskId, {
      owner: 'cloud',
      epoch: input.lease.epoch,
      fencingTokenHash: hashEvidenceMemoryFencingToken(
        input.lease.fencingToken,
      ),
    });
    const checkpoint =
      input.checkpoint ??
      toCheckpointState(
        await this.options.evidenceMemory.createCheckpoint(input.taskId),
        input.lease.epoch,
        0,
      );
    return {
      ...checkpoint,
      epoch: input.lease.epoch,
      syncState: 'synchronized',
    };
  }

  private async synchronizeCloudToLocalImpl(input: {
    agentInstanceId: string;
    execution: CloudTaskStartedExecution;
    lease: { epoch: number; fencingToken: string };
    handoff: { suspendedAtSequence: number };
    taskCredential: string;
    signal?: AbortSignal;
  }): Promise<CloudTaskEvidenceMemoryCheckpointState> {
    void input.agentInstanceId;
    const cloudFence = {
      owner: 'cloud' as const,
      epoch: input.lease.epoch,
      fencingTokenHash: hashEvidenceMemoryFencingToken(
        input.lease.fencingToken,
      ),
    };
    let cursor: EvidenceMemorySyncCursor | null = null;
    let checkpoint: EvidenceMemoryCheckpoint | null = null;
    do {
      const batch = await this.options.transport.pull({
        taskId: input.execution.taskId,
        execution: input.execution,
        cursor,
        taskCredential: input.taskCredential,
        signal: input.signal,
      });
      const result = await this.options.evidenceMemory.reconcileSyncBatch({
        taskId: input.execution.taskId,
        events: batch.events,
        expectedCheckpoint:
          batch.nextCursor === null ? batch.targetCheckpoint : null,
        writeFence: cloudFence,
      });
      checkpoint = result.checkpoint;
      cursor = batch.nextCursor;
    } while (cursor !== null);

    this.options.evidenceMemory.transferWriteAuthority({
      taskId: input.execution.taskId,
      from: cloudFence,
      to: { owner: 'local', epoch: input.lease.epoch },
    });
    const resolved =
      checkpoint ??
      (await this.options.evidenceMemory.createCheckpoint(
        input.execution.taskId,
      ));
    return toCheckpointState(
      resolved,
      input.lease.epoch,
      input.handoff.suspendedAtSequence,
    );
  }

  private async prepareResumeInCloudImpl(input: {
    agentInstanceId: string;
    execution: CloudTaskStartedExecution;
    handoff: { sourceEpoch: number; suspendedAtSequence: number };
    taskCredential: string;
    signal?: AbortSignal;
  }): Promise<CloudTaskEvidenceMemoryCheckpointState> {
    void input.agentInstanceId;
    const authority = this.options.evidenceMemory.getWriteAuthority(
      input.execution.taskId,
    );
    if (
      !authority ||
      authority.owner !== 'local' ||
      authority.epoch !== input.handoff.sourceEpoch
    ) {
      throw new Error('Local evidence memory ownership is not at the handoff');
    }
    const checkpoint = await this.options.evidenceMemory.createCheckpoint(
      input.execution.taskId,
    );
    const remote = await this.pushAll({
      taskId: input.execution.taskId,
      execution: input.execution,
      taskCredential: input.taskCredential,
      signal: input.signal,
    });
    if (
      remote.checkpointId !== checkpoint.checkpointId ||
      remote.eventCount !== checkpoint.eventCount
    ) {
      throw new Error('Cloud evidence memory resume checkpoint diverged');
    }
    return toCheckpointState(
      checkpoint,
      input.handoff.sourceEpoch,
      input.handoff.suspendedAtSequence,
    );
  }

  public async resolveDivergence(input: {
    strategy: CloudTaskMemoryDivergenceResolution;
    taskId: string;
    agentInstanceId: string;
    execution: CloudTaskStartedExecution;
    lease: { epoch: number; fencingToken: string };
    taskCredential: string;
    lastSequence: number;
    signal?: AbortSignal;
  }): Promise<CloudTaskEvidenceMemoryCheckpointState> {
    const result = await this.observe(
      input,
      'resolve-divergence',
      input.strategy === 'keep-local' ? 'local-to-cloud' : 'cloud-to-local',
      async () => {
        if (input.strategy === 'keep-local') {
          await this.options.transport.resolveDivergence({
            taskId: input.taskId,
            execution: input.execution,
            strategy: 'keep-local',
            taskCredential: input.taskCredential,
            signal: input.signal,
          });
          const local = await this.options.evidenceMemory.createCheckpoint(
            input.taskId,
          );
          const remote = await this.pushAll(input);
          if (
            local.checkpointId !== remote.checkpointId ||
            local.eventCount !== remote.eventCount
          ) {
            throw new Error(
              'Cloud evidence memory resolution did not converge',
            );
          }
          return toCheckpointState(
            local,
            input.lease.epoch,
            input.lastSequence,
          );
        }

        const cloudFence = {
          owner: 'cloud' as const,
          epoch: input.lease.epoch,
          fencingTokenHash: hashEvidenceMemoryFencingToken(
            input.lease.fencingToken,
          ),
        };
        let cursor: EvidenceMemorySyncCursor | null = null;
        const batches: EvidenceMemorySyncBatch[] = [];
        do {
          const batch = await this.options.transport.pull({
            taskId: input.taskId,
            execution: input.execution,
            cursor,
            taskCredential: input.taskCredential,
            signal: input.signal,
          });
          batches.push(batch);
          cursor = batch.nextCursor;
        } while (cursor !== null);

        await this.options.evidenceMemory.clearTask(input.taskId);
        let checkpoint: EvidenceMemoryCheckpoint | null = null;
        for (const batch of batches) {
          const reconciled =
            await this.options.evidenceMemory.reconcileSyncBatch({
              taskId: input.taskId,
              events: batch.events,
              expectedCheckpoint:
                batch.nextCursor === null ? batch.targetCheckpoint : null,
              writeFence: cloudFence,
            });
          checkpoint = reconciled.checkpoint;
        }
        return toCheckpointState(
          checkpoint ??
            (await this.options.evidenceMemory.createCheckpoint(input.taskId)),
          input.lease.epoch,
          input.lastSequence,
        );
      },
      input.strategy,
    );
    if (!result) {
      throw new Error('Evidence memory divergence resolution is unavailable');
    }
    return result;
  }

  private async observe(
    input: {
      taskId: string;
      agentInstanceId: string;
      execution: CloudTaskStartedExecution;
      lease?: { epoch: number };
    },
    operation: CloudTaskMemorySyncOperation,
    direction: CloudTaskMemorySyncDirection,
    action: () => Promise<CloudTaskEvidenceMemoryCheckpointState | null>,
    resolution: CloudTaskMemoryDivergenceResolution | null = null,
    automaticMerge?: AutomaticMergeContext,
  ): Promise<CloudTaskEvidenceMemoryCheckpointState | null> {
    for (let policyAttempt = 1; ; policyAttempt += 1) {
      const startedAt = Date.now();
      const attempt = this.nextAttempt(input.execution.executionId);
      try {
        const result = await action();
        if (result) {
          this.stateByExecution.set(input.execution.executionId, result);
        }
        await this.recordObservation({
          input,
          operation,
          direction,
          status: 'synchronized',
          result,
          resolution,
          attempt,
          startedAt,
        });
        return result;
      } catch (caughtError) {
        let error = caughtError;
        let provenRecoveryClass: CloudTaskMemoryRecoveryClass | null = null;
        if (error instanceof EvidenceMemoryDivergenceError && automaticMerge) {
          try {
            const merge = await this.tryAutomaticNonConflictingMerge(
              input,
              automaticMerge,
            );
            if (merge.outcome === 'merged') {
              this.stateByExecution.set(
                input.execution.executionId,
                merge.state,
              );
              await this.recordObservation({
                input,
                operation: 'auto-resolve-divergence',
                direction,
                status: 'synchronized',
                result: merge.state,
                attempt,
                startedAt,
                recoveryClass: 'append-only',
                recoveryDecision: 'merge-non-conflicting',
                automatic: true,
                importedEvents: merge.importedEvents,
                duplicateEvents: merge.duplicateEvents,
              });
              return merge.state;
            }
            provenRecoveryClass = merge.recoveryClass;
          } catch (recoveryError) {
            error = recoveryError;
          }
        }

        const classification = this.recoveryPolicy.classify(error);
        if (
          classification.retryable &&
          policyAttempt < this.recoveryPolicy.maxAttempts
        ) {
          const backoffMs = this.recoveryPolicy.getBackoffMs(policyAttempt);
          await this.recordObservation({
            input,
            operation: 'auto-retry',
            direction,
            status: 'failed',
            result: null,
            attempt,
            startedAt,
            error,
            recoveryClass: classification.recoveryClass,
            recoveryDecision: 'retry',
            automatic: true,
            backoffMs,
          });
          await this.recoveryPolicy.wait(backoffMs, automaticMerge?.signal);
          continue;
        }

        const status =
          error instanceof EvidenceMemoryDivergenceError
            ? 'diverged'
            : 'failed';
        const current =
          this.stateByExecution.get(input.execution.executionId) ??
          (await this.createFailureState(
            input.taskId,
            input.lease?.epoch ?? automaticMerge?.epoch ?? 1,
          ));
        const failedState: CloudTaskEvidenceMemoryCheckpointState = {
          ...current,
          syncState: status,
        };
        this.stateByExecution.set(input.execution.executionId, failedState);
        await this.recordObservation({
          input,
          operation,
          direction,
          status,
          result: current,
          resolution,
          attempt,
          startedAt,
          error,
          recoveryClass: provenRecoveryClass ?? classification.recoveryClass,
          recoveryDecision: 'manual',
        });
        throw error;
      }
    }
  }

  private nextAttempt(executionId: string): number {
    const attempt = (this.attemptsByExecution.get(executionId) ?? 0) + 1;
    this.attemptsByExecution.set(executionId, attempt);
    return attempt;
  }

  private async recordObservation(input: {
    input: {
      taskId: string;
      agentInstanceId: string;
      execution: CloudTaskStartedExecution;
      lease?: { epoch: number };
    };
    operation: CloudTaskMemorySyncOperation;
    direction: CloudTaskMemorySyncDirection;
    status: 'synchronized' | 'diverged' | 'failed';
    result: CloudTaskEvidenceMemoryCheckpointState | null;
    resolution?: CloudTaskMemoryDivergenceResolution | null;
    attempt: number;
    startedAt: number;
    error?: unknown;
    recoveryClass?: CloudTaskMemoryRecoveryClass | null;
    recoveryDecision?: 'retry' | 'merge-non-conflicting' | 'manual' | null;
    automatic?: boolean;
    backoffMs?: number | null;
    importedEvents?: number | null;
    duplicateEvents?: number | null;
  }): Promise<void> {
    const atomicDiagnostics =
      this.atomicDiagnosticsByExecution.get(
        input.input.execution.executionId,
      ) ??
      (this.pendingAtomicMergeByExecution.has(input.input.execution.executionId)
        ? { protocol: 'atomic-v1' as const, idempotentReplay: false }
        : null);
    await this.options.journal?.record({
      taskId: input.input.taskId,
      agentInstanceId: input.input.agentInstanceId,
      executionId: input.input.execution.executionId,
      operation: input.operation,
      direction: input.direction,
      status: input.status,
      epoch: input.result?.epoch ?? input.input.lease?.epoch ?? null,
      checkpointId: input.result?.checkpointId ?? null,
      eventCount: input.result?.eventCount ?? null,
      importedEvents: input.importedEvents,
      duplicateEvents: input.duplicateEvents,
      divergenceEventIdHash:
        input.error instanceof EvidenceMemoryDivergenceError
          ? createHash('sha256').update(input.error.eventId).digest('hex')
          : null,
      errorCode:
        input.error === undefined ? null : classifySyncError(input.error),
      resolution: input.resolution,
      recoveryClass: input.recoveryClass,
      recoveryDecision: input.recoveryDecision,
      automatic: input.automatic,
      backoffMs: input.backoffMs,
      protocol: atomicDiagnostics?.protocol ?? null,
      idempotentReplay: atomicDiagnostics?.idempotentReplay ?? false,
      attempt: input.attempt,
      startedAt: input.startedAt,
      finishedAt: Date.now(),
    });
    if (
      this.atomicDiagnosticsByExecution.get(
        input.input.execution.executionId,
      ) === atomicDiagnostics
    ) {
      this.atomicDiagnosticsByExecution.delete(
        input.input.execution.executionId,
      );
    }
  }

  private async tryAutomaticNonConflictingMerge(
    input: {
      taskId: string;
      agentInstanceId: string;
      execution: CloudTaskStartedExecution;
    },
    context: AutomaticMergeContext,
  ): Promise<
    | {
        outcome: 'merged';
        state: CloudTaskEvidenceMemoryCheckpointState;
        importedEvents: number;
        duplicateEvents: number;
      }
    | {
        outcome: 'manual';
        recoveryClass: CloudTaskMemoryRecoveryClass;
      }
  > {
    if (!this.options.transport.commitAtomicMerge) {
      return {
        outcome: 'manual',
        recoveryClass: 'checkpoint-conflict',
      };
    }
    const [localBatches, remoteBatches] = await Promise.all([
      this.collectLocalBatches(input.taskId),
      this.collectRemoteBatches({
        taskId: input.taskId,
        execution: input.execution,
        taskCredential: context.taskCredential,
        signal: context.signal,
      }),
    ]);
    const proof = proveNonConflictingLedgerUnion(
      input.taskId,
      localBatches,
      remoteBatches,
    );
    if (!proof.safe) {
      return {
        outcome: 'manual',
        recoveryClass: proof.recoveryClass,
      };
    }

    let importedEvents = 0;
    let duplicateEvents = 0;
    for (const batch of remoteBatches) {
      const reconciled = await this.options.evidenceMemory.reconcileSyncBatch({
        taskId: input.taskId,
        events: batch.events,
        writeFence: context.writeFence,
      });
      importedEvents += reconciled.importedEvents;
      duplicateEvents += reconciled.duplicateEvents;
    }

    const local = await this.options.evidenceMemory.createCheckpoint(
      input.taskId,
    );
    const remote = await this.pushAll({
      taskId: input.taskId,
      execution: input.execution,
      taskCredential: context.taskCredential,
      signal: context.signal,
    });
    if (
      local.checkpointId !== remote.checkpointId ||
      local.eventCount !== remote.eventCount
    ) {
      throw new EvidenceMemoryDivergenceError(
        local.headEventId ?? 'empty-ledger',
        'Automatic evidence memory merge did not converge',
      );
    }
    return {
      outcome: 'merged',
      state: toCheckpointState(local, context.epoch, context.lastSequence),
      importedEvents,
      duplicateEvents,
    };
  }

  private async collectLocalBatches(
    taskId: string,
  ): Promise<EvidenceMemorySyncBatch[]> {
    let cursor: EvidenceMemorySyncCursor | null = null;
    const batches: EvidenceMemorySyncBatch[] = [];
    do {
      const batch = await this.options.evidenceMemory.exportSyncBatch({
        taskId,
        cursor,
        limit: this.batchSize,
      });
      batches.push(batch);
      cursor = batch.nextCursor;
    } while (cursor !== null);
    return batches;
  }

  private async collectRemoteBatches(input: {
    taskId: string;
    execution: CloudTaskStartedExecution;
    taskCredential: string;
    signal?: AbortSignal;
  }): Promise<EvidenceMemorySyncBatch[]> {
    let cursor: EvidenceMemorySyncCursor | null = null;
    const batches: EvidenceMemorySyncBatch[] = [];
    do {
      const batch = await this.options.transport.pull({
        ...input,
        cursor,
      });
      batches.push(batch);
      cursor = batch.nextCursor;
    } while (cursor !== null);
    return batches;
  }

  private async createFailureState(
    taskId: string,
    epoch: number,
  ): Promise<CloudTaskEvidenceMemoryCheckpointState> {
    const checkpoint =
      await this.options.evidenceMemory.createCheckpoint(taskId);
    return {
      ...toCheckpointState(checkpoint, epoch, 0),
      syncState: 'failed',
    };
  }

  private async pushAll(input: {
    taskId: string;
    execution: CloudTaskStartedExecution;
    taskCredential: string;
    signal?: AbortSignal;
  }): Promise<{ checkpointId: string; eventCount: number }> {
    if (this.options.transport.commitAtomicMerge) {
      return await this.pushAllAtomically(input);
    }
    this.atomicDiagnosticsByExecution.set(input.execution.executionId, {
      protocol: 'legacy',
      idempotentReplay: false,
    });
    let cursor: EvidenceMemorySyncCursor | null = null;
    let remote = { checkpointId: '', eventCount: 0 };
    do {
      const batch = await this.options.evidenceMemory.exportSyncBatch({
        taskId: input.taskId,
        cursor,
        limit: this.batchSize,
      });
      remote = await this.options.transport.push({
        ...input,
        batch,
      });
      cursor = batch.nextCursor;
    } while (cursor !== null);
    return remote;
  }

  private async pushAllAtomically(input: {
    taskId: string;
    execution: CloudTaskStartedExecution;
    taskCredential: string;
    signal?: AbortSignal;
  }): Promise<{ checkpointId: string; eventCount: number }> {
    const commit = this.options.transport.commitAtomicMerge;
    if (!commit) throw new Error('Atomic memory merge API is unavailable');
    const batches = await this.collectLocalBatches(input.taskId);
    const target = batches[0]?.targetCheckpoint;
    if (!target) throw new Error('Atomic memory merge target is unavailable');
    const targetCheckpoint = {
      checkpointId: target.checkpointId,
      eventCount: target.eventCount,
    };
    let request = this.pendingAtomicMergeByExecution.get(
      input.execution.executionId,
    );
    if (
      !request ||
      !sameCloudTaskMemoryCheckpoint(request.targetCheckpoint, targetCheckpoint)
    ) {
      const remote = await this.options.transport.pull({
        ...input,
        cursor: null,
      });
      const expectedRemoteCheckpoint = {
        checkpointId: remote.targetCheckpoint.checkpointId,
        eventCount: remote.targetCheckpoint.eventCount,
      };
      request = {
        version: 1,
        mutationId: createCloudTaskMemoryMutationId({
          taskId: input.taskId,
          executionId: input.execution.executionId,
          expectedRemoteCheckpoint,
          targetCheckpoint,
        }),
        taskId: input.taskId,
        expectedRemoteCheckpoint,
        targetCheckpoint,
        batches,
      };
      this.pendingAtomicMergeByExecution.set(
        input.execution.executionId,
        request,
      );
    }

    let receipt: CloudTaskMemoryAtomicMergeReceipt;
    try {
      receipt = await commit({
        ...input,
        request,
      });
    } catch (error) {
      if (error instanceof CloudTaskMemoryCompareAndSwapError) {
        this.atomicDiagnosticsByExecution.set(input.execution.executionId, {
          protocol: 'atomic-v1',
          idempotentReplay: false,
        });
        this.pendingAtomicMergeByExecution.delete(input.execution.executionId);
      }
      throw error;
    }
    validateAtomicMergeReceipt(request, receipt);
    this.pendingAtomicMergeByExecution.delete(input.execution.executionId);
    this.atomicDiagnosticsByExecution.set(input.execution.executionId, {
      protocol: 'atomic-v1',
      idempotentReplay: receipt.replayed,
    });
    return receipt.checkpoint;
  }
}

function proveNonConflictingLedgerUnion(
  taskId: string,
  localBatches: readonly EvidenceMemorySyncBatch[],
  remoteBatches: readonly EvidenceMemorySyncBatch[],
):
  | { safe: true }
  | { safe: false; recoveryClass: CloudTaskMemoryRecoveryClass } {
  const local = validateAndIndexLedger(taskId, localBatches);
  const remote = validateAndIndexLedger(taskId, remoteBatches);
  if (!local.valid || !remote.valid) {
    return { safe: false, recoveryClass: 'invalid-data' };
  }
  for (const [eventId, localEvent] of local.events) {
    const remoteEvent = remote.events.get(eventId);
    if (
      remoteEvent &&
      canonicalJson(localEvent) !== canonicalJson(remoteEvent)
    ) {
      return { safe: false, recoveryClass: 'content-conflict' };
    }
  }
  return { safe: true };
}

function validateAndIndexLedger(
  taskId: string,
  batches: readonly EvidenceMemorySyncBatch[],
):
  | { valid: true; events: Map<string, EvidenceMemorySyncEventEnvelope> }
  | { valid: false } {
  if (batches.length === 0) return { valid: false };
  const target = batches[0]?.targetCheckpoint;
  if (!target || target.taskId !== taskId) return { valid: false };
  const events = new Map<string, EvidenceMemorySyncEventEnvelope>();
  for (const batch of batches) {
    if (
      batch.version !== 1 ||
      batch.taskId !== taskId ||
      batch.targetCheckpoint.taskId !== taskId ||
      batch.targetCheckpoint.checkpointId !== target.checkpointId ||
      batch.targetCheckpoint.eventCount !== target.eventCount
    ) {
      return { valid: false };
    }
    for (const envelope of batch.events) {
      if (
        envelope.version !== 1 ||
        envelope.event.taskId !== taskId ||
        !envelope.event.id
      ) {
        return { valid: false };
      }
      const existing = events.get(envelope.event.id);
      if (existing && canonicalJson(existing) !== canonicalJson(envelope)) {
        return { valid: false };
      }
      events.set(envelope.event.id, envelope);
    }
  }
  if (events.size !== target.eventCount) return { valid: false };
  return { valid: true, events };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function classifySyncError(error: unknown): CloudTaskMemorySyncErrorCode {
  if (error instanceof CloudTaskMemoryCompareAndSwapError) {
    return 'cas-conflict';
  }
  if (error instanceof EvidenceMemoryDivergenceError) {
    return 'event-divergence';
  }
  if (error instanceof EvidenceMemoryFencedWriteError) {
    return 'ownership-conflict';
  }
  if (
    error instanceof Error &&
    (error.message.includes('checkpoint') ||
      error.message.includes('binding is stale'))
  ) {
    return 'checkpoint-mismatch';
  }
  if (error instanceof TypeError) return 'transport-failure';
  return error instanceof Error ? 'unknown' : 'invalid-response';
}

function validateAtomicMergeReceipt(
  request: CloudTaskMemoryAtomicMergeRequest,
  receipt: CloudTaskMemoryAtomicMergeReceipt,
): void {
  if (
    receipt.version !== 1 ||
    receipt.mutationId !== request.mutationId ||
    !sameCloudTaskMemoryCheckpoint(
      receipt.previousCheckpoint,
      request.expectedRemoteCheckpoint,
    ) ||
    !sameCloudTaskMemoryCheckpoint(
      receipt.checkpoint,
      request.targetCheckpoint,
    ) ||
    !Number.isSafeInteger(receipt.importedEvents) ||
    receipt.importedEvents < 0 ||
    !Number.isSafeInteger(receipt.duplicateEvents) ||
    receipt.duplicateEvents < 0 ||
    !Number.isSafeInteger(receipt.committedAt) ||
    receipt.committedAt < 0
  ) {
    throw new Error('Cloud evidence memory atomic merge receipt is invalid');
  }
}

function toCheckpointState(
  checkpoint: EvidenceMemoryCheckpoint,
  epoch: number,
  lastSequence: number,
): CloudTaskEvidenceMemoryCheckpointState {
  return {
    checkpointId: checkpoint.checkpointId,
    eventCount: checkpoint.eventCount,
    epoch,
    lastSequence,
    syncState: 'synchronized',
  };
}
