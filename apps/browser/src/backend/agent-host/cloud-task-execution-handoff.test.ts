import { describe, expect, it, vi } from 'vitest';
import type {
  CloudTaskControlPlane,
  CloudTaskStartedExecution,
} from './cloud-task-control-plane';
import {
  CloudTaskExecutionHandoffCoordinator,
  CloudTaskExecutionHandoffError,
  type CloudTaskExecutionHandoffReceipt,
  waitForCloudTaskSuspensionBarrier,
} from './cloud-task-execution-handoff';
import {
  CloudTaskExecutionLeaseRegistry,
  type CloudTaskExecutionLease,
} from './cloud-task-execution-lease';
import type { CloudTaskStreamResumeStore } from './cloud-task-resume-store';
import type { CloudTaskEvidenceMemorySynchronizer } from './cloud-task-evidence-memory';

const NOW = 1_000_000;

describe('CloudTaskExecutionHandoffCoordinator', () => {
  it('drains every event through the matching suspended barrier', async () => {
    const observed: number[] = [];

    await expect(
      waitForCloudTaskSuspensionBarrier(
        asyncEvents([
          {
            sequence: 4,
            executionId: 'execution-1',
            type: 'log',
            level: 'info',
            message: 'flushed',
          },
          {
            sequence: 5,
            executionId: 'execution-1',
            type: 'suspended',
            handoffId: 'handoff-1',
          },
        ]),
        createHandoff(),
        (event) => {
          observed.push(event.sequence);
        },
      ),
    ).resolves.toEqual({ sequence: 5, handoffId: 'handoff-1' });
    expect(observed).toEqual([4]);
  });

  it('releases cloud ownership only after the exact stream barrier is persisted', async () => {
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => NOW,
    });
    const lease = createLease();
    leaseRegistry.activate('agent-1', lease);
    const receipt = createHandoff();
    const order: string[] = [];
    const resumeStore = createResumeStore(order);
    const controlPlane = createControlPlane({
      suspendExecution: vi.fn(async () => receipt),
      releaseExecutionLease: vi.fn(async () => {
        order.push('release');
      }),
    });
    const coordinator = new CloudTaskExecutionHandoffCoordinator({
      controlPlane,
      leaseRegistry,
      resumeStore,
    });

    await expect(
      coordinator.suspendToLocal({
        agentInstanceId: 'agent-1',
        execution: createExecution(),
        lease,
        taskCredential: 'task-token',
        lastObservedSequence: 4,
        waitForBarrier: async () => {
          expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(false);
          order.push('barrier');
          return { sequence: 5, handoffId: 'handoff-1' };
        },
      }),
    ).resolves.toEqual(receipt);

    expect(order).toEqual(['barrier', 'save', 'release']);
    expect(resumeStore.save).toHaveBeenCalledWith(
      createExecution(),
      5,
      expect.objectContaining({
        handoffId: 'handoff-1',
        suspendedAtSequence: 5,
      }),
      { agentInstanceId: 'agent-1' },
    );
    expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(true);
  });

  it('keeps the cloud lease active when the stream barrier does not match', async () => {
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => NOW,
    });
    const lease = createLease();
    leaseRegistry.activate('agent-1', lease);
    const releaseExecutionLease = vi.fn(async () => {});
    const coordinator = new CloudTaskExecutionHandoffCoordinator({
      controlPlane: createControlPlane({
        suspendExecution: vi.fn(async () => createHandoff()),
        releaseExecutionLease,
      }),
      leaseRegistry,
      resumeStore: createResumeStore(),
    });

    await expect(
      coordinator.suspendToLocal({
        agentInstanceId: 'agent-1',
        execution: createExecution(),
        lease,
        taskCredential: 'task-token',
        lastObservedSequence: 4,
        waitForBarrier: async () => ({
          sequence: 4,
          handoffId: 'handoff-1',
        }),
      }),
    ).rejects.toEqual(
      new CloudTaskExecutionHandoffError(
        'barrier-mismatch',
        'Cloud task stream did not reach the confirmed suspension barrier',
      ),
    );
    expect(releaseExecutionLease).not.toHaveBeenCalled();
    expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(false);
  });

  it('retries memory reconciliation from the persisted suspension barrier', async () => {
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => NOW,
    });
    const lease = createLease();
    leaseRegistry.activate('agent-1', lease);
    const suspendExecution = vi.fn(async () => createHandoff());
    const releaseExecutionLease = vi.fn(async () => {});
    const synchronizeCloudToLocal = vi
      .fn()
      .mockRejectedValueOnce(new Error('memory sync failed'))
      .mockResolvedValueOnce(null);
    const coordinator = new CloudTaskExecutionHandoffCoordinator({
      controlPlane: createControlPlane({
        suspendExecution,
        releaseExecutionLease,
      }),
      leaseRegistry,
      resumeStore: createResumeStore(),
      evidenceMemorySynchronizer: {
        synchronizeCloudToLocal,
      } as unknown as CloudTaskEvidenceMemorySynchronizer,
    });
    const waitForBarrier = vi.fn(async () => ({
      sequence: 5,
      handoffId: 'handoff-1',
    }));
    const input = {
      agentInstanceId: 'agent-1',
      execution: createExecution(),
      lease,
      taskCredential: 'task-token',
      lastObservedSequence: 4,
      waitForBarrier,
    };

    await expect(coordinator.suspendToLocal(input)).rejects.toThrow(
      'memory sync failed',
    );
    await expect(coordinator.suspendToLocal(input)).resolves.toEqual(
      createHandoff(),
    );
    expect(suspendExecution).toHaveBeenCalledOnce();
    expect(waitForBarrier).toHaveBeenCalledOnce();
    expect(synchronizeCloudToLocal).toHaveBeenCalledTimes(2);
    expect(releaseExecutionLease).toHaveBeenCalledOnce();
  });

  it('reclaims cloud ownership with a newer epoch after a local safe point', async () => {
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => NOW,
    });
    const order: string[] = [];
    const result = {
      handoffId: 'handoff-1',
      resumeAfterSequence: 5,
      execution: createExecution(),
      lease: createLease({
        leaseId: 'lease-2',
        holderId: 'desktop-2',
        epoch: 2,
        fencingToken: 'fence-2',
      }),
    };
    const resumeExecution = vi.fn(async () => {
      order.push('resume');
      return result;
    });
    const coordinator = new CloudTaskExecutionHandoffCoordinator({
      controlPlane: createControlPlane({ resumeExecution }),
      leaseRegistry,
      resumeStore: createResumeStore(order),
    });

    await expect(
      coordinator.resumeInCloud({
        agentInstanceId: 'agent-1',
        execution: createExecution(),
        handoff: createHandoff(),
        holderId: 'desktop-2',
        taskCredential: 'task-token',
        assertLocalSafePoint: async () => {
          order.push('safe-point');
        },
      }),
    ).resolves.toEqual(result);

    expect(order).toEqual(['safe-point', 'resume', 'save']);
    expect(leaseRegistry.get('agent-1')).toEqual(result.lease);
  });

  it('rejects a resumed lease that does not advance the fencing epoch', async () => {
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => NOW,
    });
    const coordinator = new CloudTaskExecutionHandoffCoordinator({
      controlPlane: createControlPlane({
        resumeExecution: vi.fn(async () => ({
          handoffId: 'handoff-1',
          resumeAfterSequence: 5,
          execution: createExecution(),
          lease: createLease({ holderId: 'desktop-2' }),
        })),
      }),
      leaseRegistry,
      resumeStore: createResumeStore(),
    });

    await expect(
      coordinator.resumeInCloud({
        agentInstanceId: 'agent-1',
        execution: createExecution(),
        handoff: createHandoff(),
        holderId: 'desktop-2',
        taskCredential: 'task-token',
        assertLocalSafePoint: vi.fn(),
      }),
    ).rejects.toMatchObject({ reason: 'stale-epoch' });
    expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(true);
  });
});

function createExecution(): CloudTaskStartedExecution {
  return {
    taskId: 'task-1',
    executionId: 'execution-1',
    restoreReceiptId: 'restore-1',
    streamUrl: 'https://cloud.example.test/stream',
    cancelUrl: 'https://cloud.example.test/cancel',
    expiresAt: NOW + 60_000,
  };
}

function createLease(
  overrides: Partial<CloudTaskExecutionLease> = {},
): CloudTaskExecutionLease {
  return {
    leaseId: 'lease-1',
    taskId: 'task-1',
    executionId: 'execution-1',
    restoreReceiptId: 'restore-1',
    holderId: 'desktop-1',
    epoch: 1,
    fencingToken: 'fence-1',
    acquiredAt: NOW,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

function createHandoff(
  overrides: Partial<CloudTaskExecutionHandoffReceipt> = {},
): CloudTaskExecutionHandoffReceipt {
  return {
    handoffId: 'handoff-1',
    taskId: 'task-1',
    executionId: 'execution-1',
    restoreReceiptId: 'restore-1',
    sourceLeaseId: 'lease-1',
    sourceEpoch: 1,
    suspendedAtSequence: 5,
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

function createResumeStore(order: string[] = []): CloudTaskStreamResumeStore {
  return {
    load: vi.fn(async () => 0),
    save: vi.fn(async () => {
      order.push('save');
    }),
    clear: vi.fn(async () => {}),
    listPending: vi.fn(async () => []),
    clearByExecutionId: vi.fn(async () => {}),
  };
}

function createControlPlane(
  overrides: Partial<CloudTaskControlPlane> = {},
): CloudTaskControlPlane {
  return {
    createUploadSession: vi.fn(),
    uploadSnapshot: vi.fn(),
    issueCredential: vi.fn(),
    revokeCredential: vi.fn(),
    startExecution: vi.fn(),
    confirmExecutionRestore: vi.fn(),
    acquireExecutionLease: vi.fn(),
    renewExecutionLease: vi.fn(),
    releaseExecutionLease: vi.fn(),
    suspendExecution: vi.fn(),
    resumeExecution: vi.fn(),
    streamExecution: vi.fn(),
    getExecutionStatus: vi.fn(),
    cancelExecution: vi.fn(),
    cancelExecutionById: vi.fn(),
    downloadArtifact: vi.fn(),
    ...overrides,
  };
}

async function* asyncEvents<T>(events: T[]): AsyncGenerator<T> {
  for (const event of events) yield event;
}
