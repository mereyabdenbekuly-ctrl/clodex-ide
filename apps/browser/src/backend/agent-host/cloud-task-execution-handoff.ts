import type {
  CloudTaskControlPlane,
  CloudTaskStartedExecution,
  CloudTaskStreamEvent,
} from './cloud-task-control-plane';
import {
  CloudTaskExecutionLeaseError,
  type CloudTaskExecutionLease,
  type CloudTaskExecutionLeaseRegistry,
} from './cloud-task-execution-lease';
import type {
  CloudTaskStreamResumeHandoff,
  CloudTaskStreamResumeStore,
} from './cloud-task-resume-store';
import type {
  CloudTaskEvidenceMemoryCheckpointState,
  CloudTaskEvidenceMemorySynchronizer,
} from './cloud-task-evidence-memory';

export interface CloudTaskExecutionHandoffReceipt {
  handoffId: string;
  taskId: string;
  executionId: string;
  restoreReceiptId: string;
  sourceLeaseId: string;
  sourceEpoch: number;
  suspendedAtSequence: number;
  createdAt: number;
  expiresAt: number;
}

export interface CloudTaskExecutionResumeResult {
  handoffId: string;
  resumeAfterSequence: number;
  execution: CloudTaskStartedExecution;
  lease: CloudTaskExecutionLease;
}

export interface CloudTaskExecutionHandoffCoordinatorOptions {
  controlPlane: CloudTaskControlPlane;
  leaseRegistry: CloudTaskExecutionLeaseRegistry;
  resumeStore: CloudTaskStreamResumeStore;
  evidenceMemorySynchronizer?: CloudTaskEvidenceMemorySynchronizer;
}

/**
 * Performs ownership transfer around a stream barrier.
 *
 * Cloud -> local:
 * 1. suspend the remote execution under the current fencing token;
 * 2. drain and persist every event through the server-provided barrier;
 * 3. release the lease;
 * 4. only then allow local execution.
 *
 * Local -> cloud reclaim is the inverse: verify a local safe point, atomically
 * resume with a newer epoch, activate the new lease, then resume streaming
 * strictly after the persisted barrier.
 */
export class CloudTaskExecutionHandoffCoordinator {
  private readonly memoryCheckpointByExecution = new Map<
    string,
    CloudTaskEvidenceMemoryCheckpointState | null
  >();
  private readonly pendingSuspensionByExecution = new Map<
    string,
    {
      receipt: CloudTaskExecutionHandoffReceipt;
      barrier: { sequence: number; handoffId: string };
    }
  >();

  public constructor(
    private readonly options: CloudTaskExecutionHandoffCoordinatorOptions,
  ) {}

  public getMemoryCheckpoint(
    executionId: string,
  ): CloudTaskEvidenceMemoryCheckpointState | null {
    return this.memoryCheckpointByExecution.get(executionId) ?? null;
  }

  public async suspendToLocal(input: {
    agentInstanceId: string;
    execution: CloudTaskStartedExecution;
    lease: CloudTaskExecutionLease;
    taskCredential: string;
    lastObservedSequence: number;
    waitForBarrier: (
      receipt: CloudTaskExecutionHandoffReceipt,
    ) => Promise<{ sequence: number; handoffId: string }>;
    signal?: AbortSignal;
  }): Promise<CloudTaskExecutionHandoffReceipt> {
    this.options.leaseRegistry.assertCurrent(
      input.agentInstanceId,
      input.lease,
    );
    const pending = this.pendingSuspensionByExecution.get(
      input.execution.executionId,
    );
    if (pending) {
      assertSuspendReceipt(input, pending.receipt);
      return await this.completeSuspension(input, pending);
    }
    const suspendExecution = this.options.controlPlane.suspendExecution;
    if (!suspendExecution) {
      throw new Error('Cloud task suspend handoff API is unavailable');
    }
    const receipt = await suspendExecution.call(
      this.options.controlPlane,
      input.execution,
      input.lease,
      input.lastObservedSequence,
      input.taskCredential,
      input.signal,
    );
    assertSuspendReceipt(input, receipt);
    const barrier = await input.waitForBarrier(receipt);
    if (
      barrier.sequence !== receipt.suspendedAtSequence ||
      barrier.handoffId !== receipt.handoffId
    ) {
      throw new CloudTaskExecutionHandoffError(
        'barrier-mismatch',
        'Cloud task stream did not reach the confirmed suspension barrier',
      );
    }
    const pendingSuspension = { receipt, barrier };
    this.pendingSuspensionByExecution.set(
      input.execution.executionId,
      pendingSuspension,
    );
    return await this.completeSuspension(input, pendingSuspension);
  }

  private async completeSuspension(
    input: {
      agentInstanceId: string;
      execution: CloudTaskStartedExecution;
      lease: CloudTaskExecutionLease;
      taskCredential: string;
      signal?: AbortSignal;
    },
    pending: {
      receipt: CloudTaskExecutionHandoffReceipt;
      barrier: { sequence: number; handoffId: string };
    },
  ): Promise<CloudTaskExecutionHandoffReceipt> {
    const { receipt, barrier } = pending;
    const handoff = toResumeHandoff(receipt);
    const memoryCheckpoint =
      (await this.options.evidenceMemorySynchronizer?.synchronizeCloudToLocal({
        agentInstanceId: input.agentInstanceId,
        execution: input.execution,
        lease: input.lease,
        handoff: receipt,
        taskCredential: input.taskCredential,
        signal: input.signal,
      })) ?? null;
    this.memoryCheckpointByExecution.set(
      input.execution.executionId,
      memoryCheckpoint,
    );
    await this.options.resumeStore.save(
      input.execution,
      barrier.sequence,
      handoff,
      {
        agentInstanceId: input.agentInstanceId,
        ...(memoryCheckpoint ? { memoryCheckpoint } : {}),
      },
    );
    const releaseExecutionLease =
      this.options.controlPlane.releaseExecutionLease;
    if (!releaseExecutionLease) {
      throw new Error('Cloud task execution lease API is unavailable');
    }
    await releaseExecutionLease.call(
      this.options.controlPlane,
      input.lease,
      input.taskCredential,
      input.signal,
    );
    this.options.leaseRegistry.release(input.agentInstanceId, input.lease);
    this.pendingSuspensionByExecution.delete(input.execution.executionId);
    return receipt;
  }

  public async resumeInCloud(input: {
    agentInstanceId: string;
    execution: CloudTaskStartedExecution;
    handoff: CloudTaskExecutionHandoffReceipt;
    holderId: string;
    taskCredential: string;
    assertLocalSafePoint: () => void | Promise<void>;
    signal?: AbortSignal;
  }): Promise<CloudTaskExecutionResumeResult> {
    if (
      !this.options.leaseRegistry.isLocalExecutionAllowed(input.agentInstanceId)
    ) {
      throw new CloudTaskExecutionLeaseError('conflict');
    }
    await input.assertLocalSafePoint();
    let memoryCheckpoint: CloudTaskEvidenceMemoryCheckpointState | null =
      (await this.options.evidenceMemorySynchronizer?.prepareResumeInCloud({
        agentInstanceId: input.agentInstanceId,
        execution: input.execution,
        handoff: input.handoff,
        taskCredential: input.taskCredential,
        signal: input.signal,
      })) ?? null;
    const resumeExecution = this.options.controlPlane.resumeExecution;
    if (!resumeExecution) {
      throw new Error('Cloud task resume handoff API is unavailable');
    }
    const result = await resumeExecution.call(
      this.options.controlPlane,
      input.handoff,
      input.holderId,
      input.taskCredential,
      input.signal,
    );
    assertResumeResult(input, result);
    this.options.leaseRegistry.activate(input.agentInstanceId, result.lease);
    if (this.options.evidenceMemorySynchronizer) {
      memoryCheckpoint =
        await this.options.evidenceMemorySynchronizer.activateCloudOwnership({
          taskId: result.execution.taskId,
          agentInstanceId: input.agentInstanceId,
          execution: result.execution,
          lease: result.lease,
          checkpoint: memoryCheckpoint,
        });
    }
    this.memoryCheckpointByExecution.set(
      result.execution.executionId,
      memoryCheckpoint,
    );
    await this.options.resumeStore.save(
      result.execution,
      result.resumeAfterSequence,
      null,
      {
        agentInstanceId: input.agentInstanceId,
        cloudOwnership: { epoch: result.lease.epoch },
        ...(memoryCheckpoint ? { memoryCheckpoint } : {}),
      },
    );
    return result;
  }
}

export type CloudTaskExecutionHandoffFailureReason =
  | 'binding-mismatch'
  | 'barrier-regression'
  | 'barrier-mismatch'
  | 'stale-epoch';

export class CloudTaskExecutionHandoffError extends Error {
  public constructor(
    public readonly reason: CloudTaskExecutionHandoffFailureReason,
    message = 'Cloud task execution handoff is invalid',
  ) {
    super(message);
    this.name = 'CloudTaskExecutionHandoffError';
  }
}

export async function waitForCloudTaskSuspensionBarrier(
  events: AsyncIterable<CloudTaskStreamEvent>,
  receipt: CloudTaskExecutionHandoffReceipt,
  onEvent?: (event: CloudTaskStreamEvent) => void | Promise<void>,
): Promise<{ sequence: number; handoffId: string }> {
  for await (const event of events) {
    if (event.sequence > receipt.suspendedAtSequence) {
      throw new CloudTaskExecutionHandoffError(
        'barrier-mismatch',
        'Cloud task stream advanced beyond the suspension barrier',
      );
    }
    if (event.type === 'suspended') {
      if (
        event.sequence !== receipt.suspendedAtSequence ||
        event.handoffId !== receipt.handoffId
      ) {
        throw new CloudTaskExecutionHandoffError('barrier-mismatch');
      }
      return { sequence: event.sequence, handoffId: event.handoffId };
    }
    await onEvent?.(event);
  }
  throw new CloudTaskExecutionHandoffError(
    'barrier-mismatch',
    'Cloud task stream ended before the suspension barrier',
  );
}

function assertSuspendReceipt(
  input: {
    execution: CloudTaskStartedExecution;
    lease: CloudTaskExecutionLease;
    lastObservedSequence: number;
  },
  receipt: CloudTaskExecutionHandoffReceipt,
): void {
  if (
    receipt.taskId !== input.execution.taskId ||
    receipt.executionId !== input.execution.executionId ||
    receipt.restoreReceiptId !== input.lease.restoreReceiptId ||
    receipt.sourceLeaseId !== input.lease.leaseId ||
    receipt.sourceEpoch !== input.lease.epoch
  ) {
    throw new CloudTaskExecutionHandoffError('binding-mismatch');
  }
  if (receipt.suspendedAtSequence < input.lastObservedSequence) {
    throw new CloudTaskExecutionHandoffError('barrier-regression');
  }
}

function assertResumeResult(
  input: {
    execution: CloudTaskStartedExecution;
    handoff: CloudTaskExecutionHandoffReceipt;
    holderId: string;
  },
  result: CloudTaskExecutionResumeResult,
): void {
  if (
    result.handoffId !== input.handoff.handoffId ||
    result.resumeAfterSequence !== input.handoff.suspendedAtSequence ||
    result.execution.taskId !== input.execution.taskId ||
    result.execution.executionId !== input.execution.executionId ||
    result.execution.restoreReceiptId !== input.handoff.restoreReceiptId ||
    result.lease.taskId !== input.execution.taskId ||
    result.lease.executionId !== input.execution.executionId ||
    result.lease.restoreReceiptId !== input.handoff.restoreReceiptId ||
    result.lease.holderId !== input.holderId
  ) {
    throw new CloudTaskExecutionHandoffError('binding-mismatch');
  }
  if (result.lease.epoch <= input.handoff.sourceEpoch) {
    throw new CloudTaskExecutionHandoffError('stale-epoch');
  }
}

function toResumeHandoff(
  receipt: CloudTaskExecutionHandoffReceipt,
): CloudTaskStreamResumeHandoff {
  return {
    handoffId: receipt.handoffId,
    sourceLeaseId: receipt.sourceLeaseId,
    sourceEpoch: receipt.sourceEpoch,
    suspendedAtSequence: receipt.suspendedAtSequence,
  };
}
