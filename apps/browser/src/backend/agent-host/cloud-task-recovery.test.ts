import { describe, expect, it, vi } from 'vitest';
import type { CloudTaskControlPlane } from './cloud-task-control-plane';
import type { CloudTaskExecutionLease } from './cloud-task-execution-lease';
import { CloudTaskRecoveryCoordinator } from './cloud-task-recovery';
import type {
  CloudTaskStreamResumeCheckpoint,
  CloudTaskStreamResumeStore,
} from './cloud-task-resume-store';
import type {
  CloudTaskSecretBroker,
  CloudTaskCredentialLease,
} from './cloud-task-security';

const CHECKPOINTS: CloudTaskStreamResumeCheckpoint[] = [
  {
    version: 5,
    taskId: 'task-active',
    executionId: 'execution-active',
    restoreReceiptId: 'restore-active',
    handoff: null,
    cloudOwnership: null,
    memoryCheckpoint: null,
    lastSequence: 4,
    expiresAt: 2_000_000,
    updatedAt: 900_000,
  },
  {
    version: 5,
    taskId: 'task-terminal',
    executionId: 'execution-terminal',
    restoreReceiptId: 'restore-terminal',
    handoff: null,
    cloudOwnership: null,
    memoryCheckpoint: null,
    lastSequence: 8,
    expiresAt: 2_000_000,
    updatedAt: 950_000,
  },
];

describe('CloudTaskRecoveryCoordinator', () => {
  it('cancels active orphaned executions and clears terminal checkpoints', async () => {
    const cleared: string[] = [];
    const store = createStore(cleared);
    const controlPlane = createControlPlane();
    controlPlane.getExecutionStatus = vi.fn(
      async (_taskId, executionId) =>
        ({
          taskId:
            executionId === 'execution-active'
              ? 'task-active'
              : 'task-terminal',
          executionId,
          status: executionId === 'execution-active' ? 'running' : 'completed',
          updatedAt: 1_000_000,
        }) as const,
    );
    const audit = vi.fn();
    const coordinator = new CloudTaskRecoveryCoordinator({
      controlPlane,
      secretBroker: createSecretBroker(),
      resumeStore: store,
      residency: 'us',
      audit,
      now: () => 1_000_000,
    });

    await expect(coordinator.reconcile('startup')).resolves.toEqual({
      inspected: 2,
      cancelled: 1,
      cleared: 2,
      retained: 0,
      failed: 0,
    });
    expect(controlPlane.cancelExecutionById).toHaveBeenCalledWith(
      'task-active',
      'execution-active',
      'recovery-token',
      undefined,
      expect.objectContaining({
        taskId: 'task-active',
        executionId: 'execution-active',
        restoreReceiptId: 'restore-active',
        holderId: 'clodex-recovery',
      }),
    );
    expect(controlPlane.releaseExecutionLease).toHaveBeenCalledTimes(2);
    expect(cleared).toEqual(['execution-active', 'execution-terminal']);
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: 'reconcile',
        success: true,
        inspectedExecutions: 2,
        cancelledExecutions: 1,
      }),
    );
  });

  it('retains a checkpoint when status cannot be verified', async () => {
    const cleared: string[] = [];
    const controlPlane = createControlPlane();
    controlPlane.getExecutionStatus = vi.fn(async () => {
      throw new Error('network unavailable');
    });
    const coordinator = new CloudTaskRecoveryCoordinator({
      controlPlane,
      secretBroker: createSecretBroker(),
      resumeStore: createStore(cleared, CHECKPOINTS.slice(0, 1)),
      residency: 'eu',
    });

    await expect(coordinator.reconcile('system-resumed')).resolves.toEqual({
      inspected: 0,
      cancelled: 0,
      cleared: 0,
      retained: 1,
      failed: 1,
    });
    expect(cleared).toEqual([]);
    expect(controlPlane.cancelExecutionById).not.toHaveBeenCalled();
  });

  it('retains an intentional suspended handoff without cancelling it', async () => {
    const controlPlane = createControlPlane();
    const checkpoint: CloudTaskStreamResumeCheckpoint = {
      ...CHECKPOINTS[0],
      handoff: {
        handoffId: 'handoff-1',
        sourceLeaseId: 'lease-1',
        sourceEpoch: 1,
        suspendedAtSequence: CHECKPOINTS[0].lastSequence,
      },
      cloudOwnership: null,
    };
    const coordinator = new CloudTaskRecoveryCoordinator({
      controlPlane,
      secretBroker: createSecretBroker(),
      resumeStore: createStore([], [checkpoint]),
      residency: 'us',
    });

    await expect(coordinator.reconcile('startup')).resolves.toEqual({
      inspected: 1,
      cancelled: 0,
      cleared: 0,
      retained: 1,
      failed: 0,
    });
    expect(controlPlane.acquireExecutionLease).not.toHaveBeenCalled();
    expect(controlPlane.cancelExecutionById).not.toHaveBeenCalled();
  });

  it('leaves agent-bound cloud-owned executions to Teleport recovery', async () => {
    const controlPlane = createControlPlane();
    const checkpoint: CloudTaskStreamResumeCheckpoint = {
      ...CHECKPOINTS[0],
      agentInstanceId: 'agent-1',
      cloudOwnership: { epoch: 3 },
    };
    const coordinator = new CloudTaskRecoveryCoordinator({
      controlPlane,
      secretBroker: createSecretBroker(),
      resumeStore: createStore([], [checkpoint]),
      residency: 'us',
    });

    await expect(coordinator.reconcile('startup')).resolves.toEqual({
      inspected: 1,
      cancelled: 0,
      cleared: 0,
      retained: 1,
      failed: 0,
    });
    expect(controlPlane.acquireExecutionLease).not.toHaveBeenCalled();
    expect(controlPlane.cancelExecutionById).not.toHaveBeenCalled();
  });
});

function createStore(
  cleared: string[],
  checkpoints = CHECKPOINTS,
): CloudTaskStreamResumeStore {
  return {
    load: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
    listPending: vi.fn(async () => checkpoints),
    clearByExecutionId: vi.fn(async (executionId) => {
      cleared.push(executionId);
    }),
  };
}

function createControlPlane(): CloudTaskControlPlane {
  return {
    createUploadSession: vi.fn(),
    uploadSnapshot: vi.fn(),
    issueCredential: vi.fn(),
    revokeCredential: vi.fn(),
    startExecution: vi.fn(),
    acquireExecutionLease: vi.fn(async (request) =>
      createExecutionLease({
        taskId: request.taskId,
        executionId: request.executionId,
        restoreReceiptId: request.restoreReceiptId,
        holderId: request.holderId,
      }),
    ),
    renewExecutionLease: vi.fn(),
    releaseExecutionLease: vi.fn(async () => {}),
    streamExecution: vi.fn(),
    getExecutionStatus: vi.fn(),
    cancelExecution: vi.fn(),
    cancelExecutionById: vi.fn(),
    downloadArtifact: vi.fn(),
  };
}

function createExecutionLease(
  overrides: Partial<CloudTaskExecutionLease> = {},
): CloudTaskExecutionLease {
  return {
    leaseId: `lease-${overrides.executionId ?? 'execution'}`,
    taskId: 'task-active',
    executionId: 'execution-active',
    restoreReceiptId: 'restore-execution',
    holderId: 'clodex-recovery',
    epoch: 1,
    fencingToken: `fence-${overrides.executionId ?? 'execution'}`,
    acquiredAt: 1_000_000,
    expiresAt: 1_060_000,
    ...overrides,
  };
}

function createSecretBroker(): CloudTaskSecretBroker {
  return {
    acquire: vi.fn(async () => {
      const lease: CloudTaskCredentialLease = {
        credentialId: 'recovery-credential',
        token: 'recovery-token',
        expiresAt: 2_000_000,
        scopes: ['task:lease', 'task:status', 'task:cancel'],
        dispose: vi.fn(async () => {}),
      };
      return lease;
    }),
  } as unknown as CloudTaskSecretBroker;
}
