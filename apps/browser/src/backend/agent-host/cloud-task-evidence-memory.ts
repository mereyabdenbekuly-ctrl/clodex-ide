import type { CloudTaskStartedExecution } from './cloud-task-control-plane';
import type { CloudTaskExecutionHandoffReceipt } from './cloud-task-execution-handoff';
import type { CloudTaskExecutionLease } from './cloud-task-execution-lease';
import type { CloudTaskMemoryDivergenceResolution } from '@shared/cloud-task-memory-sync';

export type CloudTaskEvidenceMemorySyncState =
  | 'pending'
  | 'synchronized'
  | 'diverged'
  | 'failed';

/**
 * Content-free identity safe to persist in Teleport recovery state and expose
 * as diagnostics. Ledger hashes and event payloads remain inside the
 * authorized synchronizer transport.
 */
export interface CloudTaskEvidenceMemoryCheckpointState {
  checkpointId: string;
  eventCount: number;
  epoch: number;
  lastSequence: number;
  syncState: CloudTaskEvidenceMemorySyncState;
}

export interface CloudTaskEvidenceMemorySynchronizer {
  getCheckpointState?(
    executionId: string,
  ): CloudTaskEvidenceMemoryCheckpointState | null;

  restoreDurableFence?(input: {
    taskId: string;
    agentInstanceId: string;
    epoch: number;
    checkpoint: CloudTaskEvidenceMemoryCheckpointState | null;
  }): void | Promise<void>;

  prepareCloudRestore(input: {
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
  }): Promise<CloudTaskEvidenceMemoryCheckpointState | null>;

  activateCloudOwnership(input: {
    taskId: string;
    agentInstanceId: string;
    execution: CloudTaskStartedExecution;
    lease: CloudTaskExecutionLease;
    checkpoint: CloudTaskEvidenceMemoryCheckpointState | null;
  }): Promise<CloudTaskEvidenceMemoryCheckpointState | null>;

  synchronizeCloudToLocal(input: {
    agentInstanceId: string;
    execution: CloudTaskStartedExecution;
    lease: CloudTaskExecutionLease;
    handoff: CloudTaskExecutionHandoffReceipt;
    taskCredential: string;
    signal?: AbortSignal;
  }): Promise<CloudTaskEvidenceMemoryCheckpointState | null>;

  prepareResumeInCloud(input: {
    agentInstanceId: string;
    execution: CloudTaskStartedExecution;
    handoff: CloudTaskExecutionHandoffReceipt;
    taskCredential: string;
    signal?: AbortSignal;
  }): Promise<CloudTaskEvidenceMemoryCheckpointState | null>;

  recoverCloudOwnership?(input: {
    taskId: string;
    agentInstanceId: string;
    execution: CloudTaskStartedExecution;
    lease: CloudTaskExecutionLease;
    checkpoint: CloudTaskEvidenceMemoryCheckpointState | null;
  }): Promise<CloudTaskEvidenceMemoryCheckpointState | null>;

  resolveDivergence?(input: {
    strategy: CloudTaskMemoryDivergenceResolution;
    taskId: string;
    agentInstanceId: string;
    execution: CloudTaskStartedExecution;
    lease: CloudTaskExecutionLease;
    taskCredential: string;
    lastSequence: number;
    signal?: AbortSignal;
  }): Promise<CloudTaskEvidenceMemoryCheckpointState>;
}
