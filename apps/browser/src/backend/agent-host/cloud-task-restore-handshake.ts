import { createHash } from 'node:crypto';
import { agentSessionCheckpointSchema } from '@clodex/agent-core/agents';

export interface CloudTaskRestoreCheckpointBinding {
  checkpointId: string;
  historyContentHash: string;
  workspaceRevisionHash: string;
  memoryCheckpointId?: string | null;
  memoryLedgerHash?: string | null;
  memoryEventCount?: number | null;
}

export interface CloudTaskExecutionRestoreReceipt {
  restoreReceiptId: string;
  taskId: string;
  executionId: string;
  uploadSessionId: string;
  snapshotSha256: string;
  workspaceSnapshotHash: string;
  checkpointId: string | null;
  historyContentHash: string | null;
  workspaceRevisionHash: string | null;
  memoryCheckpointId?: string | null;
  memoryLedgerHash?: string | null;
  memoryEventCount?: number | null;
  restoredAt: number;
}

export type CloudTaskRestoreHandshakeFailureReason =
  | 'invalid-checkpoint'
  | 'checkpoint-mismatch'
  | 'restore-mismatch';

export class CloudTaskRestoreHandshakeError extends Error {
  public constructor(
    public readonly reason: CloudTaskRestoreHandshakeFailureReason,
    message?: string,
  ) {
    super(
      message ??
        (reason === 'invalid-checkpoint'
          ? 'Cloud task session checkpoint is invalid'
          : reason === 'checkpoint-mismatch'
            ? 'Cloud task checkpoint does not match the current agent'
            : 'Cloud task restore confirmation does not match the uploaded state'),
    );
    this.name = 'CloudTaskRestoreHandshakeError';
  }
}

/**
 * Produces a path-free, deterministic binding for the durable checkpoint.
 * Absolute workspace paths never leave the desktop process.
 */
export function createCloudTaskRestoreCheckpointBinding(
  value: unknown,
  expectedAgentInstanceId: string,
): CloudTaskRestoreCheckpointBinding | null {
  if (value === null || value === undefined) return null;
  const parsed = agentSessionCheckpointSchema.safeParse(value);
  if (!parsed.success) {
    throw new CloudTaskRestoreHandshakeError('invalid-checkpoint');
  }
  const checkpoint = parsed.data;
  if (checkpoint.task.agentInstanceId !== expectedAgentInstanceId) {
    throw new CloudTaskRestoreHandshakeError('checkpoint-mismatch');
  }
  if (checkpoint.workspace.snapshot) {
    return {
      checkpointId: checkpoint.id,
      historyContentHash: checkpoint.memory.history.contentHash,
      workspaceRevisionHash: checkpoint.workspace.snapshot.snapshotHash,
      ...(checkpoint.memory.evidence
        ? {
            memoryCheckpointId: checkpoint.memory.evidence.checkpointId,
            memoryLedgerHash: checkpoint.memory.evidence.ledgerHash,
            memoryEventCount: checkpoint.memory.evidence.eventCount,
          }
        : {}),
    };
  }
  const workspaces = checkpoint.workspace.workspaces.map((workspace) => ({
    repositoryId: workspace.repositoryId,
    worktreeId: workspace.worktreeId,
    revision: workspace.revision,
  }));
  return {
    checkpointId: checkpoint.id,
    historyContentHash: checkpoint.memory.history.contentHash,
    workspaceRevisionHash: createCloudTaskWorkspaceRevisionHash(workspaces),
    ...(checkpoint.memory.evidence
      ? {
          memoryCheckpointId: checkpoint.memory.evidence.checkpointId,
          memoryLedgerHash: checkpoint.memory.evidence.ledgerHash,
          memoryEventCount: checkpoint.memory.evidence.eventCount,
        }
      : {}),
  };
}

export function createCloudTaskWorkspaceRevisionHash(
  workspaces: readonly {
    repositoryId: string | null;
    worktreeId: string | null;
    revision: string | null;
  }[],
): string {
  return sha256(
    JSON.stringify({
      version: 1,
      workspaces: [...workspaces].sort(compareWorkspaceRevision),
    }),
  );
}

function compareWorkspaceRevision(
  left: {
    repositoryId: string | null;
    worktreeId: string | null;
    revision: string | null;
  },
  right: {
    repositoryId: string | null;
    worktreeId: string | null;
    revision: string | null;
  },
): number {
  return (
    compareNullable(left.repositoryId, right.repositoryId) ||
    compareNullable(left.worktreeId, right.worktreeId) ||
    compareNullable(left.revision, right.revision)
  );
}

function compareNullable(left: string | null, right: string | null): number {
  const normalizedLeft = left ?? '';
  const normalizedRight = right ?? '';
  return normalizedLeft < normalizedRight
    ? -1
    : normalizedLeft > normalizedRight
      ? 1
      : 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
