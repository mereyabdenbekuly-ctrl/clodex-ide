import { describe, expect, it, vi } from 'vitest';
import type { CloudTaskControlPlane } from './cloud-task-control-plane';
import { CloudTaskExecutionHandoffCoordinator } from './cloud-task-execution-handoff';
import {
  CloudTaskExecutionLeaseRegistry,
  type CloudTaskExecutionLease,
} from './cloud-task-execution-lease';
import type {
  CloudTaskStreamResumeCheckpoint,
  CloudTaskStreamResumeStore,
} from './cloud-task-resume-store';
import type {
  CloudTaskCredentialLease,
  CloudTaskSecretBroker,
} from './cloud-task-security';
import type { CloudTaskTeleportSession } from '../services/cloud-task-teleport';
import type { CloudTaskTeleportObserver } from './cloud-task-production-adapter';
import { CloudTaskTeleportRecovery } from './cloud-task-teleport-recovery';

const NOW = 1_000_000;

describe('CloudTaskTeleportRecovery', () => {
  it('restores suspended UI without credentials and resumes with a fresh epoch', async () => {
    const checkpoint = createCheckpoint();
    const resumeStore = createResumeStore(checkpoint);
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => NOW,
    });
    const controlPlane = createControlPlane();
    const handoffCoordinator = new CloudTaskExecutionHandoffCoordinator({
      controlPlane,
      leaseRegistry,
      resumeStore,
    });
    const credential = createCredential();
    const secretBroker = {
      acquire: vi.fn(async () => credential),
    } as unknown as CloudTaskSecretBroker;
    const sessions: CloudTaskTeleportSession[] = [];
    const unregister = vi.fn(() => {
      sessions.length = 0;
    });
    const update = vi.fn();
    const observer: CloudTaskTeleportObserver = {
      publish: vi.fn(),
      update,
      register: vi.fn((value) => {
        sessions.push(value);
        return unregister;
      }),
    };
    const recovery = new CloudTaskTeleportRecovery({
      controlPlane,
      secretBroker,
      resumeStore,
      handoffCoordinator,
      leaseRegistry,
      residency: 'us',
      leaseHolderId: 'desktop-recovered',
      now: () => NOW,
    });
    const assertLocalSafePoint = vi.fn(async () => {});
    const replayChunk = vi.fn(async () => 'applied' as const);
    const finishReplay = vi.fn(async () => {});
    recovery.setHostBindings({
      assertLocalSafePoint,
      replayChunk,
      finishReplay,
    });

    await expect(recovery.restore(observer)).resolves.toBe(1);
    expect(sessions[0]!.state).toMatchObject({
      agentInstanceId: 'agent-1',
      phase: 'suspended',
      epoch: 1,
      handoffId: 'handoff-1',
      lastSequence: 5,
    });
    expect(secretBroker.acquire).not.toHaveBeenCalled();

    await expect(sessions[0]!.resumeInCloud()).resolves.toMatchObject({
      phase: 'cloud-owned',
      epoch: 2,
      handoffId: null,
      lastSequence: 5,
    });
    expect(secretBroker.acquire).toHaveBeenCalledWith({
      taskId: 'task-1',
      residency: 'us',
      scopes: ['task:lease', 'task:resume', 'task:stream', 'task:memory'],
    });
    expect(assertLocalSafePoint).toHaveBeenCalledWith('agent-1');
    await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce());
    expect(finishReplay).toHaveBeenCalledWith('agent-1', {
      executionId: 'execution-1',
      outcome: 'cancelled',
    });
    expect(update).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ lastSequence: 6 }),
    );
    expect(resumeStore.clear).toHaveBeenCalledOnce();
    expect(controlPlane.releaseExecutionLease).toHaveBeenCalledOnce();
    expect(credential.dispose).toHaveBeenCalledOnce();
    expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(true);
    await recovery.teardown();
  });

  it('keeps a recovered session suspended when the server returns a stale epoch', async () => {
    const checkpoint = createCheckpoint();
    const resumeStore = createResumeStore(checkpoint);
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => NOW,
    });
    const controlPlane = createControlPlane({
      resumeExecution: vi.fn(async (handoff, holderId) => ({
        handoffId: handoff.handoffId,
        resumeAfterSequence: handoff.suspendedAtSequence,
        execution: createExecution(),
        lease: createLease({ holderId, epoch: 1 }),
      })),
    });
    const credential = createCredential();
    const recovery = new CloudTaskTeleportRecovery({
      controlPlane,
      secretBroker: {
        acquire: vi.fn(async () => credential),
      } as unknown as CloudTaskSecretBroker,
      resumeStore,
      handoffCoordinator: new CloudTaskExecutionHandoffCoordinator({
        controlPlane,
        leaseRegistry,
        resumeStore,
      }),
      leaseRegistry,
      residency: 'us',
      leaseHolderId: 'desktop-recovered',
      now: () => NOW,
    });
    recovery.setHostBindings({
      assertLocalSafePoint: vi.fn(async () => {}),
      replayChunk: vi.fn(async () => 'applied' as const),
      finishReplay: vi.fn(async () => {}),
    });
    const sessions: CloudTaskTeleportSession[] = [];
    await recovery.restore({
      publish: vi.fn(),
      update: vi.fn(),
      register: (value) => {
        sessions.push(value);
        return vi.fn();
      },
    });

    await expect(sessions[0]!.resumeInCloud()).rejects.toMatchObject({
      reason: 'stale-epoch',
    });
    expect(sessions[0]!.state.phase).toBe('suspended');
    expect(credential.dispose).toHaveBeenCalledOnce();
    expect(resumeStore.clear).not.toHaveBeenCalled();
    await recovery.teardown();
  });

  it('commits each recovered chunk before advancing the durable cursor', async () => {
    const checkpoint = createCheckpoint();
    const ordering: string[] = [];
    const resumeStore = createResumeStore(checkpoint);
    vi.mocked(resumeStore.save).mockImplementation(
      async (_execution, sequence) => {
        ordering.push(`cursor:${sequence}`);
      },
    );
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => NOW,
    });
    const controlPlane = createControlPlane({
      streamExecution: vi.fn(() =>
        (async function* () {
          yield {
            sequence: 6,
            executionId: 'execution-1',
            type: 'chunk' as const,
            chunk: {
              type: 'text-delta',
              id: 'cloud-text-1',
              delta: 'continued',
            },
          };
          yield {
            sequence: 7,
            executionId: 'execution-1',
            type: 'completed' as const,
            result: {} as never,
          };
        })(),
      ),
    });
    const recovery = new CloudTaskTeleportRecovery({
      controlPlane,
      secretBroker: {
        acquire: vi.fn(async () => createCredential()),
      } as unknown as CloudTaskSecretBroker,
      resumeStore,
      handoffCoordinator: new CloudTaskExecutionHandoffCoordinator({
        controlPlane,
        leaseRegistry,
        resumeStore,
      }),
      leaseRegistry,
      residency: 'us',
      leaseHolderId: 'desktop-recovered',
      now: () => NOW,
    });
    const replayChunk = vi.fn(async () => {
      ordering.push('history:6');
      return 'duplicate' as const;
    });
    const finishReplay = vi.fn(async () => {
      ordering.push('finish:7');
    });
    recovery.setHostBindings({
      assertLocalSafePoint: vi.fn(async () => {}),
      replayChunk,
      finishReplay,
    });
    const sessions: CloudTaskTeleportSession[] = [];
    await recovery.restore({
      publish: vi.fn(),
      update: vi.fn(),
      register: (value) => {
        sessions.push(value);
        return vi.fn();
      },
    });

    await sessions[0]!.resumeInCloud();
    await vi.waitFor(() => expect(resumeStore.clear).toHaveBeenCalledOnce());

    expect(replayChunk).toHaveBeenCalledWith('agent-1', {
      executionId: 'execution-1',
      sequence: 6,
      chunk: {
        type: 'text-delta',
        id: 'cloud-text-1',
        delta: 'continued',
      },
    });
    expect(finishReplay).toHaveBeenCalledWith('agent-1', {
      executionId: 'execution-1',
      outcome: 'completed',
    });
    expect(ordering.filter((entry) => entry !== 'cursor:5')).toEqual([
      'history:6',
      'cursor:6',
      'finish:7',
      'cursor:7',
    ]);
    await recovery.teardown();
  });

  it('does not request a newer cloud epoch when the local agent is not idle', async () => {
    const checkpoint = createCheckpoint();
    const resumeStore = createResumeStore(checkpoint);
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => NOW,
    });
    const controlPlane = createControlPlane();
    const recovery = new CloudTaskTeleportRecovery({
      controlPlane,
      secretBroker: {
        acquire: vi.fn(async () => createCredential()),
      } as unknown as CloudTaskSecretBroker,
      resumeStore,
      handoffCoordinator: new CloudTaskExecutionHandoffCoordinator({
        controlPlane,
        leaseRegistry,
        resumeStore,
      }),
      leaseRegistry,
      residency: 'us',
      leaseHolderId: 'desktop-recovered',
      now: () => NOW,
    });
    recovery.setHostBindings({
      assertLocalSafePoint: vi.fn(async () => {
        throw new Error('agent is working');
      }),
      replayChunk: vi.fn(async () => 'applied' as const),
      finishReplay: vi.fn(async () => {}),
    });
    const sessions: CloudTaskTeleportSession[] = [];
    await recovery.restore({
      publish: vi.fn(),
      update: vi.fn(),
      register: (value) => {
        sessions.push(value);
        return vi.fn();
      },
    });

    await expect(sessions[0]!.resumeInCloud()).rejects.toThrow(
      'agent is working',
    );
    expect(controlPlane.resumeExecution).not.toHaveBeenCalled();
    expect(resumeStore.clear).not.toHaveBeenCalled();
    await recovery.teardown();
  });

  it('recovers a cloud-owned execution after a second IDE restart', async () => {
    const checkpoint = createCloudOwnedCheckpoint();
    const resumeStore = createResumeStore(checkpoint);
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => NOW,
    });
    const controlPlane = createControlPlane({
      acquireExecutionLease: vi.fn(async (request) =>
        createLease({
          taskId: request.taskId,
          executionId: request.executionId,
          restoreReceiptId: request.restoreReceiptId,
          holderId: request.holderId,
          epoch: 3,
          leaseId: 'lease-3',
          fencingToken: 'fence-3',
        }),
      ),
      getExecutionStatus: vi.fn(
        async () =>
          ({
            taskId: 'task-1',
            executionId: 'execution-1',
            status: 'running',
            updatedAt: NOW,
          }) as const,
      ),
      streamExecution: vi.fn(() =>
        (async function* () {
          yield {
            sequence: 6,
            executionId: 'execution-1',
            type: 'log' as const,
            level: 'info' as const,
            message: 'sensitive /workspace/path https://provider.example',
          };
          yield {
            sequence: 7,
            executionId: 'execution-1',
            type: 'usage' as const,
            durationMs: 1_500,
            costMicros: 42,
          };
          yield {
            sequence: 8,
            executionId: 'execution-1',
            type: 'artifact' as const,
            artifact: {
              artifactId: 'artifact-1',
              fileName: 'report.zip',
              mediaType: 'application/zip',
              sizeBytes: 128,
              sha256: 'a'.repeat(64),
              downloadUrl: 'https://provider.example/private-artifact',
              expiresAt: NOW + 60_000,
            },
          };
          yield {
            sequence: 9,
            executionId: 'execution-1',
            type: 'chunk' as const,
            chunk: {
              type: 'text-delta',
              id: 'cloud-text-1',
              delta: 'after restart',
            },
          };
          yield {
            sequence: 10,
            executionId: 'execution-1',
            type: 'completed' as const,
            result: {} as never,
          };
        })(),
      ),
    });
    const credential = createCredential();
    const replayChunk = vi.fn(
      async (_agentInstanceId, input: { sequence: number }) =>
        input.sequence === 9 ? ('duplicate' as const) : ('applied' as const),
    );
    const finishReplay = vi.fn(async () => {});
    const update = vi.fn();
    const unregister = vi.fn();
    const recovery = new CloudTaskTeleportRecovery({
      controlPlane,
      secretBroker: {
        acquire: vi.fn(async () => credential),
      } as unknown as CloudTaskSecretBroker,
      resumeStore,
      handoffCoordinator: new CloudTaskExecutionHandoffCoordinator({
        controlPlane,
        leaseRegistry,
        resumeStore,
      }),
      leaseRegistry,
      artifactDownloader: {
        download: vi.fn(async () => ({
          executionId: 'execution-1',
          artifactId: 'artifact-1',
          fileName: 'report.zip',
          mediaType: 'application/zip',
          sizeBytes: 128,
          sha256: 'a'.repeat(64),
          localPath: '/private/recovered/report.zip',
          resumedBytes: 0,
        })),
      },
      policy: {
        residency: 'us',
        maxSnapshotBytes: 1_000,
        maxSnapshotFiles: 10,
        maxArtifactBytes: 1_000,
        maxArtifactFiles: 10,
        maxDurationMs: 60_000,
        maxCostMicros: 1_000,
      },
      residency: 'us',
      leaseHolderId: 'desktop-recovered',
      now: () => NOW,
    });
    recovery.setHostBindings({
      assertLocalSafePoint: vi.fn(async () => {}),
      replayChunk: replayChunk as never,
      finishReplay,
    });

    await expect(
      recovery.restore({
        publish: vi.fn(),
        update,
        register: vi.fn(() => unregister),
      }),
    ).resolves.toBe(1);
    expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(false);

    await vi.waitFor(() => expect(resumeStore.clear).toHaveBeenCalledOnce());
    expect(controlPlane.acquireExecutionLease).toHaveBeenCalledWith(
      {
        taskId: 'task-1',
        executionId: 'execution-1',
        holderId: 'desktop-recovered',
        checkpointId: null,
        restoreReceiptId: 'restore-1',
      },
      'fresh-token',
    );
    expect(replayChunk).toHaveBeenNthCalledWith(
      1,
      'agent-1',
      expect.objectContaining({
        sequence: 6,
        chunk: expect.objectContaining({
          type: 'data-cloud-log',
          data: {
            level: 'info',
            message: 'Recovered cloud info log event',
          },
        }),
      }),
    );
    expect(replayChunk).toHaveBeenNthCalledWith(
      2,
      'agent-1',
      expect.objectContaining({
        sequence: 7,
        chunk: expect.objectContaining({
          type: 'data-cloud-usage',
          data: { durationMs: 1_500, costMicros: 42 },
        }),
      }),
    );
    expect(replayChunk).toHaveBeenNthCalledWith(
      3,
      'agent-1',
      expect.objectContaining({
        sequence: 8,
        chunk: {
          type: 'data-cloud-artifact',
          id: 'cloud-artifact-8',
          data: {
            executionId: 'execution-1',
            artifactId: 'artifact-1',
            fileName: 'report.zip',
            mediaType: 'application/zip',
            sizeBytes: 128,
          },
        },
      }),
    );
    expect(replayChunk).toHaveBeenNthCalledWith(
      4,
      'agent-1',
      expect.objectContaining({ sequence: 9 }),
    );
    expect(finishReplay).toHaveBeenCalledWith('agent-1', {
      executionId: 'execution-1',
      outcome: 'completed',
    });
    expect(resumeStore.save).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'execution-1' }),
      9,
      null,
      {
        agentInstanceId: 'agent-1',
        cloudOwnership: { epoch: 3 },
      },
    );
    expect(controlPlane.releaseExecutionLease).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(credential.dispose).toHaveBeenCalledOnce();
    expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(true);
    await recovery.teardown();
  });

  it('keeps local execution fenced when cloud-owned recovery has no newer epoch', async () => {
    const checkpoint = createCloudOwnedCheckpoint();
    const resumeStore = createResumeStore(checkpoint);
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => NOW,
    });
    const controlPlane = createControlPlane({
      acquireExecutionLease: vi.fn(async (request) =>
        createLease({
          taskId: request.taskId,
          executionId: request.executionId,
          restoreReceiptId: request.restoreReceiptId,
          holderId: request.holderId,
          epoch: 2,
        }),
      ),
    });
    const update = vi.fn();
    const recovery = new CloudTaskTeleportRecovery({
      controlPlane,
      secretBroker: {
        acquire: vi.fn(async () => createCredential()),
      } as unknown as CloudTaskSecretBroker,
      resumeStore,
      handoffCoordinator: new CloudTaskExecutionHandoffCoordinator({
        controlPlane,
        leaseRegistry,
        resumeStore,
      }),
      leaseRegistry,
      residency: 'us',
      leaseHolderId: 'desktop-recovered',
      now: () => NOW,
    });
    recovery.setHostBindings({
      assertLocalSafePoint: vi.fn(async () => {}),
      replayChunk: vi.fn(async () => 'applied' as const),
      finishReplay: vi.fn(async () => {}),
    });

    await recovery.restore({
      publish: vi.fn(),
      update,
      register: vi.fn(() => vi.fn()),
    });
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ phase: 'failed' }),
      ),
    );

    expect(controlPlane.streamExecution).not.toHaveBeenCalled();
    expect(resumeStore.clear).not.toHaveBeenCalled();
    expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(false);
    await recovery.teardown();
  });

  it('keeps a cloud-owned checkpoint fenced without network access when the gate is disabled', async () => {
    const checkpoint = createCloudOwnedCheckpoint();
    const resumeStore = createResumeStore(checkpoint);
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => NOW,
    });
    const secretBroker = {
      acquire: vi.fn(),
    } as unknown as CloudTaskSecretBroker;
    const update = vi.fn();
    const controlPlane = createControlPlane();
    const recovery = new CloudTaskTeleportRecovery({
      controlPlane,
      secretBroker,
      resumeStore,
      handoffCoordinator: new CloudTaskExecutionHandoffCoordinator({
        controlPlane,
        leaseRegistry,
        resumeStore,
      }),
      leaseRegistry,
      residency: 'us',
      leaseHolderId: 'desktop-recovered',
      isFeatureEnabled: () => false,
      now: () => NOW,
    });
    recovery.setHostBindings({
      assertLocalSafePoint: vi.fn(async () => {}),
      replayChunk: vi.fn(async () => 'applied' as const),
      finishReplay: vi.fn(async () => {}),
    });

    await recovery.restore({
      publish: vi.fn(),
      update,
      register: vi.fn(() => vi.fn()),
    });

    expect(secretBroker.acquire).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        phase: 'failed',
        error: 'Cloud Tasks is disabled; local execution remains fenced',
      }),
    );
    expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(false);
    await recovery.teardown();
  });
});

function createCheckpoint(): CloudTaskStreamResumeCheckpoint {
  return {
    version: 5,
    taskId: 'task-1',
    executionId: 'execution-1',
    restoreReceiptId: 'restore-1',
    agentInstanceId: 'agent-1',
    handoff: {
      handoffId: 'handoff-1',
      sourceLeaseId: 'lease-1',
      sourceEpoch: 1,
      suspendedAtSequence: 5,
    },
    cloudOwnership: null,
    memoryCheckpoint: null,
    lastSequence: 5,
    expiresAt: NOW + 60_000,
    updatedAt: NOW - 1_000,
  };
}

function createCloudOwnedCheckpoint(): CloudTaskStreamResumeCheckpoint {
  return {
    ...createCheckpoint(),
    handoff: null,
    cloudOwnership: { epoch: 2 },
  };
}

function createResumeStore(
  checkpoint: CloudTaskStreamResumeCheckpoint,
): CloudTaskStreamResumeStore {
  return {
    load: vi.fn(async () => checkpoint.lastSequence),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    listPending: vi.fn(async () => [checkpoint]),
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
    acquireExecutionLease: vi.fn(),
    renewExecutionLease: vi.fn(),
    releaseExecutionLease: vi.fn(async () => {}),
    suspendExecution: vi.fn(),
    resumeExecution: vi.fn(async (handoff, holderId) => ({
      handoffId: handoff.handoffId,
      resumeAfterSequence: handoff.suspendedAtSequence,
      execution: createExecution(),
      lease: createLease({ holderId }),
    })),
    streamExecution: vi.fn(() =>
      (async function* () {
        yield {
          sequence: 6,
          executionId: 'execution-1',
          type: 'cancelled' as const,
        };
      })(),
    ),
    getExecutionStatus: vi.fn(),
    cancelExecution: vi.fn(),
    cancelExecutionById: vi.fn(),
    downloadArtifact: vi.fn(),
    ...overrides,
  };
}

function createExecution() {
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
    leaseId: 'lease-2',
    taskId: 'task-1',
    executionId: 'execution-1',
    restoreReceiptId: 'restore-1',
    holderId: 'desktop-recovered',
    epoch: 2,
    fencingToken: 'fence-2',
    acquiredAt: NOW,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

function createCredential(): CloudTaskCredentialLease {
  return {
    credentialId: 'credential-1',
    token: 'fresh-token',
    expiresAt: NOW + 60_000,
    scopes: ['task:lease', 'task:resume', 'task:stream'],
    dispose: vi.fn(async () => {}),
  };
}
