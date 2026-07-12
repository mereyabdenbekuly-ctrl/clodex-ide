import { createHash } from 'node:crypto';
import type {
  EvidenceMemoryCheckpoint,
  EvidenceMemorySyncBatch,
} from '@clodex/agent-core/evidence-memory';

export type CloudTaskMemoryCheckpointIdentity = Pick<
  EvidenceMemoryCheckpoint,
  'checkpointId' | 'eventCount'
>;

export interface CloudTaskMemoryAtomicMergeRequest {
  version: 1;
  mutationId: string;
  taskId: string;
  expectedRemoteCheckpoint: CloudTaskMemoryCheckpointIdentity;
  targetCheckpoint: CloudTaskMemoryCheckpointIdentity;
  batches: EvidenceMemorySyncBatch[];
}

export interface CloudTaskMemoryAtomicMergeReceipt {
  version: 1;
  mutationId: string;
  replayed: boolean;
  previousCheckpoint: CloudTaskMemoryCheckpointIdentity;
  checkpoint: CloudTaskMemoryCheckpointIdentity;
  importedEvents: number;
  duplicateEvents: number;
  committedAt: number;
}

export class CloudTaskMemoryCompareAndSwapError extends Error {
  public constructor(
    public readonly expectedCheckpoint: CloudTaskMemoryCheckpointIdentity,
    public readonly actualCheckpoint: CloudTaskMemoryCheckpointIdentity | null,
    message = 'Cloud evidence memory checkpoint changed before atomic commit',
  ) {
    super(message);
    this.name = 'CloudTaskMemoryCompareAndSwapError';
  }
}

export function createCloudTaskMemoryMutationId(input: {
  taskId: string;
  executionId: string;
  expectedRemoteCheckpoint: CloudTaskMemoryCheckpointIdentity;
  targetCheckpoint: CloudTaskMemoryCheckpointIdentity;
}): string {
  const digest = createHash('sha256')
    .update(
      [
        'clodex-memory-atomic-v1',
        input.taskId,
        input.executionId,
        input.expectedRemoteCheckpoint.checkpointId,
        String(input.expectedRemoteCheckpoint.eventCount),
        input.targetCheckpoint.checkpointId,
        String(input.targetCheckpoint.eventCount),
      ].join('\0'),
    )
    .digest('hex');
  return `memory-merge:${digest}`;
}

export function sameCloudTaskMemoryCheckpoint(
  left: CloudTaskMemoryCheckpointIdentity,
  right: CloudTaskMemoryCheckpointIdentity,
): boolean {
  return (
    left.checkpointId === right.checkpointId &&
    left.eventCount === right.eventCount
  );
}
