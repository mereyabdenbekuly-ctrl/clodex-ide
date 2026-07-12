import { generateKeyPairSync } from 'node:crypto';
import {
  createAgentSessionCheckpoint,
  createAgentTaskSnapshotManifest,
} from '@clodex/agent-core/agents';
import type {
  AgentStepExecutionRequest,
  AgentTaskSnapshotSelection,
} from '@clodex/agent-core/agents';
import type { InferUIMessageChunk, UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import type {
  CloudTaskControlPlane,
  CloudTaskStartedExecution,
  CloudTaskStreamEvent,
  CloudTaskUploadSession,
} from './cloud-task-control-plane';
import {
  CloudTaskUploadSnapshotPackager,
  ProductionCloudExecutionTargetAdapter,
  type CloudTaskTeleportObserver,
} from './cloud-task-production-adapter';
import {
  CloudTaskExecutionLeaseError,
  CloudTaskExecutionLeaseRegistry,
  type CloudTaskExecutionLease,
} from './cloud-task-execution-lease';
import {
  CloudTaskSecretBroker,
  type CloudTaskExecutionPolicy,
  type CloudTaskSecretBrokerTransport,
} from './cloud-task-security';
import type {
  CloudTaskSnapshotCryptoProvider,
  CloudTaskSnapshotDescriptor,
  FileSystemCloudTaskSnapshotPackager,
} from './cloud-task-snapshot-packager';
import type { IsolatedAgentTurnResult } from './isolated-agent-turn';
import { CloudTaskExecutionHandoffCoordinator } from './cloud-task-execution-handoff';
import type { CloudTaskTeleportSession } from '../services/cloud-task-teleport';

const POLICY: CloudTaskExecutionPolicy = {
  residency: 'eu',
  maxSnapshotBytes: 1024,
  maxSnapshotFiles: 10,
  maxArtifactBytes: 4096,
  maxArtifactFiles: 5,
  maxDurationMs: 60_000,
  maxCostMicros: 50_000,
};

describe('CloudTaskUploadSnapshotPackager', () => {
  it('binds packaging to the upload-session recipient key and verifies upload integrity', async () => {
    const server = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const session = createUploadSession(server);
    const descriptor = createSnapshotDescriptor();
    const cleanup = vi.fn(async () => {});
    const uploadSnapshot = vi.fn(async () => ({
      sessionId: session.sessionId,
      objectId: 'object-1',
      sha256: descriptor.archive.sha256,
    }));
    const audit = vi.fn();
    let taskCrypto: CloudTaskSnapshotCryptoProvider | undefined;
    const localPackager = {
      prepare: vi.fn(async () => ({
        descriptor,
        cleanup,
      })),
    } as unknown as FileSystemCloudTaskSnapshotPackager;
    const packager = new CloudTaskUploadSnapshotPackager({
      controlPlane: {
        ...createControlPlane(),
        createUploadSession: vi.fn(async () => session),
        uploadSnapshot,
      },
      getAccountAccessToken: () => 'account-token',
      resolvePolicy: () => POLICY,
      createLocalPackager: ({ cryptoProvider }) => {
        taskCrypto = cryptoProvider;
        return localPackager;
      },
      audit,
    });

    const prepared = await packager.prepare({
      taskId: 'task-1',
      agentInstanceId: 'agent-1',
      selection: createSelection(),
    });

    expect(taskCrypto).toBeDefined();
    expect(uploadSnapshot).toHaveBeenCalledWith(session, descriptor, undefined);
    expect(prepared.descriptor.upload).toEqual({
      sessionId: 'upload-1',
      objectId: 'object-1',
      residency: 'eu',
      expiresAt: session.expiresAt,
      sha256: descriptor.archive.sha256,
    });
    await prepared.cleanup();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith({
      operation: 'upload',
      success: true,
      residency: 'eu',
      durationMs: expect.any(Number),
      snapshotBytes: descriptor.archive.sizeBytes,
      snapshotFiles: descriptor.manifest.entries.length,
    });
  });

  it('cleans local staging when upload integrity fails', async () => {
    const server = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const descriptor = createSnapshotDescriptor();
    const cleanup = vi.fn(async () => {});
    const audit = vi.fn();
    const packager = new CloudTaskUploadSnapshotPackager({
      controlPlane: {
        ...createControlPlane(),
        createUploadSession: vi.fn(async () => createUploadSession(server)),
        uploadSnapshot: vi.fn(async () => ({
          sessionId: 'upload-1',
          objectId: 'object-1',
          sha256: 'f'.repeat(64),
        })),
      },
      getAccountAccessToken: () => 'account-token',
      resolvePolicy: () => POLICY,
      createLocalPackager: () =>
        ({
          prepare: vi.fn(async () => ({ descriptor, cleanup })),
        }) as unknown as FileSystemCloudTaskSnapshotPackager,
      audit,
    });

    await expect(
      packager.prepare({
        taskId: 'task-1',
        agentInstanceId: 'agent-1',
        selection: createSelection(),
      }),
    ).rejects.toThrow('integrity');
    expect(cleanup).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith({
      operation: 'upload',
      success: false,
      residency: 'eu',
      reason: 'integrity',
      durationMs: expect.any(Number),
      snapshotBytes: descriptor.archive.sizeBytes,
      snapshotFiles: descriptor.manifest.entries.length,
    });
  });

  it('audits upload-session failures without snapshot content', async () => {
    const audit = vi.fn();
    const packager = new CloudTaskUploadSnapshotPackager({
      controlPlane: {
        ...createControlPlane(),
        createUploadSession: vi.fn(async () => {
          throw new Error('network unavailable');
        }),
      },
      getAccountAccessToken: () => 'account-token',
      resolvePolicy: () => POLICY,
      createLocalPackager: vi.fn(),
      audit,
    });

    await expect(
      packager.prepare({
        taskId: 'task-secret',
        agentInstanceId: 'agent-secret',
        selection: createSelection(),
      }),
    ).rejects.toThrow('network unavailable');

    expect(audit).toHaveBeenCalledWith({
      operation: 'upload',
      success: false,
      residency: 'eu',
      reason: 'network',
      durationMs: expect.any(Number),
      snapshotBytes: undefined,
      snapshotFiles: undefined,
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('task-secret');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('agent-secret');
  });
});

describe('ProductionCloudExecutionTargetAdapter', () => {
  it('binds a session checkpoint and workspace revision before lease acquisition', async () => {
    const now = 1_000_000;
    const request = createRequest(vi.fn());
    const snapshot = request.context.metadata
      .cloudSnapshot as CloudTaskSnapshotDescriptor & {
      upload: NonNullable<CloudTaskSnapshotDescriptor['upload']>;
    };
    snapshot.manifest = createAgentTaskSnapshotManifest({
      taskId: 'task-1',
      createdAt: snapshot.manifest.createdAt,
      selection: 'mounted-workspaces',
      entries: snapshot.manifest.entries,
      mounts: [
        {
          ...snapshot.manifest.mounts[0],
          repositoryId: 'repo-1',
          worktreeId: 'worktree-1',
          repositoryRevision: 'abc123',
        },
      ],
      environment: {
        os: snapshot.manifest.environment.os,
        arch: snapshot.manifest.environment.arch,
        shell: snapshot.manifest.environment.shell,
        toolchains: snapshot.manifest.environment.toolchains,
      },
    });
    request.context.metadata.session_checkpoint = createTeleportCheckpoint();
    const execution = createStartedExecution(now);
    const confirmExecutionRestore = vi.fn(async (restoreRequest) => ({
      restoreReceiptId: 'restore-teleport',
      taskId: restoreRequest.taskId,
      executionId: restoreRequest.executionId,
      uploadSessionId: restoreRequest.uploadSessionId,
      snapshotSha256: restoreRequest.snapshotSha256,
      workspaceSnapshotHash: restoreRequest.workspaceSnapshotHash,
      checkpointId: restoreRequest.checkpoint?.checkpointId ?? null,
      historyContentHash: restoreRequest.checkpoint?.historyContentHash ?? null,
      workspaceRevisionHash:
        restoreRequest.checkpoint?.workspaceRevisionHash ?? null,
      restoredAt: now,
    }));
    const acquireExecutionLease = vi.fn(async (leaseRequest) =>
      createExecutionLease(now, {
        restoreReceiptId: leaseRequest.restoreReceiptId,
        holderId: leaseRequest.holderId,
      }),
    );
    const controlPlane = {
      ...createControlPlane(now),
      startExecution: vi.fn(async () => execution),
      confirmExecutionRestore,
      acquireExecutionLease,
      streamExecution: vi.fn(() =>
        asyncEvents([
          {
            sequence: 1,
            executionId: execution.executionId,
            type: 'usage',
            durationMs: 1,
            costMicros: 1,
          },
          {
            sequence: 2,
            executionId: execution.executionId,
            type: 'completed',
            result: createTurnResult(),
          },
        ]),
      ),
    };
    const adapter = new ProductionCloudExecutionTargetAdapter({
      controlPlane,
      secretBroker: createBroker(
        now,
        vi.fn(async () => {}),
      ),
      getAccountAccessToken: () => 'account-token',
      resolvePolicy: () => POLICY,
      serializeRequest: vi.fn(async () => createSerializedTurn()),
      now: () => now,
    });

    const step = await adapter.execute(request);
    await Promise.all([
      collect(step.toUIMessageStream()),
      step.consumeStream(),
    ]);

    expect(confirmExecutionRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceSnapshotHash: snapshot.manifest.snapshotHash,
        checkpoint: expect.objectContaining({
          checkpointId: '11111111-1111-4111-8111-111111111111',
          historyContentHash: 'a'.repeat(64),
          workspaceRevisionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
      'task-token',
      undefined,
    );
    expect(confirmExecutionRestore.mock.invocationCallOrder[0]).toBeLessThan(
      acquireExecutionLease.mock.invocationCallOrder[0] ?? 0,
    );
    expect(acquireExecutionLease).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointId: '11111111-1111-4111-8111-111111111111',
        restoreReceiptId: 'restore-teleport',
      }),
      'task-token',
      undefined,
    );
  });

  it('uses a scoped lease, streams chunks/logs and invokes onFinish', async () => {
    const now = 1_000_000;
    const revokeCredential = vi.fn(async () => {});
    const broker = createBroker(now, revokeCredential);
    const onFinish = vi.fn(async () => {});
    const request = createRequest(onFinish);
    const execution = createStartedExecution(now);
    const events: CloudTaskStreamEvent[] = [
      {
        sequence: 1,
        executionId: execution.executionId,
        type: 'chunk',
        chunk: { type: 'text-start', id: 'cloud-text-1' },
      },
      {
        sequence: 2,
        executionId: execution.executionId,
        type: 'chunk',
        chunk: {
          type: 'text-delta',
          id: 'cloud-text-1',
          delta: 'hello',
        },
      },
      {
        sequence: 3,
        executionId: execution.executionId,
        type: 'usage',
        durationMs: 500,
        costMicros: 250,
      },
      {
        sequence: 4,
        executionId: execution.executionId,
        type: 'log',
        level: 'info',
        message: 'building',
      },
      {
        sequence: 5,
        executionId: execution.executionId,
        type: 'artifact',
        artifact: {
          artifactId: 'artifact-1',
          fileName: 'result.txt',
          mediaType: 'text/plain',
          sizeBytes: 10,
          sha256: 'c'.repeat(64),
          downloadUrl: 'https://cloud.example.test/artifacts/artifact-1',
          expiresAt: now + 60_000,
        },
      },
      {
        sequence: 6,
        executionId: execution.executionId,
        type: 'completed',
        result: createTurnResult(),
      },
    ];
    const startExecution = vi.fn(async () => execution);
    const audit = vi.fn();
    const artifactDownloader = {
      download: vi.fn(async () => ({
        executionId: 'execution-1',
        artifactId: 'artifact-1',
        fileName: 'result.txt',
        mediaType: 'text/plain',
        sizeBytes: 10,
        sha256: 'c'.repeat(64),
        localPath: '/tmp/cloud-artifact',
        resumedBytes: 0,
      })),
    };
    const resumeStore = {
      load: vi.fn(async () => 0),
      save: vi.fn(
        async (_execution: CloudTaskStartedExecution, _sequence: number) => {},
      ),
      clear: vi.fn(async () => {}),
      listPending: vi.fn(async () => []),
      clearByExecutionId: vi.fn(async () => {}),
    };
    const controlPlane = {
      ...createControlPlane(now),
      startExecution,
      streamExecution: vi.fn(() => asyncEvents(events)),
    };
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => now,
    });
    const adapter = new ProductionCloudExecutionTargetAdapter({
      controlPlane,
      secretBroker: broker,
      getAccountAccessToken: () => 'account-token',
      resolvePolicy: () => POLICY,
      serializeRequest: vi.fn(async () => createSerializedTurn()),
      artifactDownloader,
      resumeStore,
      leaseRegistry,
      audit,
      now: () => now,
    });

    const step = await adapter.execute(request);
    expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(false);
    const uiStream = step.toUIMessageStream();
    const [chunks] = await Promise.all([
      collect(uiStream),
      step.consumeStream(),
    ]);
    expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(true);

    expect(startExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        uploadSessionId: 'upload-1',
        snapshotSha256: 'b'.repeat(64),
        policy: POLICY,
      }),
      'task-token',
      undefined,
    );
    expect(chunks).toEqual([
      { type: 'text-start', id: 'cloud-text-1' },
      { type: 'text-delta', id: 'cloud-text-1', delta: 'hello' },
      {
        type: 'data-cloud-usage',
        id: 'cloud-usage-3',
        data: { durationMs: 500, costMicros: 250 },
      },
      {
        type: 'data-cloud-log',
        id: 'cloud-log-4',
        data: { level: 'info', message: 'building' },
      },
      {
        type: 'data-cloud-artifact',
        id: 'cloud-artifact-5',
        data: {
          executionId: 'execution-1',
          artifactId: 'artifact-1',
          fileName: 'result.txt',
          mediaType: 'text/plain',
          sizeBytes: 10,
        },
      },
    ]);
    expect(onFinish).toHaveBeenCalledOnce();
    expect(revokeCredential).toHaveBeenCalledOnce();
    expect(artifactDownloader.download).toHaveBeenCalledOnce();
    expect(resumeStore.save).toHaveBeenCalledTimes(events.length + 1);
    expect(resumeStore.save).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ executionId: 'execution-1' }),
      0,
      null,
      {
        agentInstanceId: 'agent-1',
        cloudOwnership: { epoch: 1 },
      },
    );
    expect(resumeStore.clear).toHaveBeenCalledOnce();
    expect(audit.mock.calls.map(([event]) => event.operation)).toEqual([
      'restore-handshake',
      'lease-acquire',
      'start',
      'usage',
      'stream',
      'lease-release',
    ]);
    expect(audit.mock.calls[4]?.[0]).toEqual({
      operation: 'stream',
      success: true,
      residency: 'eu',
      durationMs: expect.any(Number),
      reason: undefined,
    });
  });

  it('cancels execution when reported cost exceeds the local policy', async () => {
    const now = 1_000_000;
    const request = createRequest(vi.fn());
    const execution = createStartedExecution(now);
    const cancelExecution = vi.fn(async () => {});
    const audit = vi.fn();
    const controlPlane = {
      ...createControlPlane(now),
      startExecution: vi.fn(async () => execution),
      cancelExecution,
      streamExecution: vi.fn(() =>
        asyncEvents([
          {
            sequence: 1,
            executionId: execution.executionId,
            type: 'usage',
            durationMs: 1_000,
            costMicros: POLICY.maxCostMicros + 1,
          },
        ]),
      ),
    };
    const adapter = new ProductionCloudExecutionTargetAdapter({
      controlPlane,
      secretBroker: createBroker(
        now,
        vi.fn(async () => {}),
      ),
      getAccountAccessToken: () => 'account-token',
      resolvePolicy: () => POLICY,
      serializeRequest: vi.fn(async () => createSerializedTurn()),
      audit,
      now: () => now,
    });

    const step = await adapter.execute(request);
    const [chunks] = await Promise.all([
      collect(step.toUIMessageStream()),
      step.consumeStream(),
    ]);

    expect(cancelExecution).toHaveBeenCalledOnce();
    expect(chunks).toEqual([
      expect.objectContaining({
        type: 'error',
        errorText: expect.stringContaining('cost'),
      }),
    ]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'usage',
        success: false,
        limit: 'cost',
      }),
    );
  });

  it('suspends at the exact barrier and resumes the same UI stream with a newer epoch', async () => {
    const now = 1_000_000;
    const request = createRequest(vi.fn());
    const execution = createStartedExecution(now);
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => now,
    });
    const suspendRequested = createTestDeferred<void>();
    let streamAttempt = 0;
    const resumeStore = {
      load: vi.fn(async () => 0),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      listPending: vi.fn(async () => []),
      clearByExecutionId: vi.fn(async () => {}),
    };
    const controlPlane = {
      ...createControlPlane(now),
      startExecution: vi.fn(async () => execution),
      suspendExecution: vi.fn(async () => {
        suspendRequested.resolve();
        return {
          handoffId: 'handoff-1',
          taskId: execution.taskId,
          executionId: execution.executionId,
          restoreReceiptId: 'restore-1',
          sourceLeaseId: 'lease-1',
          sourceEpoch: 1,
          suspendedAtSequence: 2,
          createdAt: now,
          expiresAt: now + 60_000,
        };
      }),
      resumeExecution: vi.fn(async (handoff, holderId) => ({
        handoffId: handoff.handoffId,
        resumeAfterSequence: handoff.suspendedAtSequence,
        execution: { ...execution, restoreReceiptId: 'restore-1' },
        lease: createExecutionLease(now, {
          leaseId: 'lease-2',
          holderId,
          epoch: 2,
          fencingToken: 'fence-2',
        }),
      })),
      streamExecution: vi.fn(() => {
        streamAttempt += 1;
        return streamAttempt === 1
          ? (async function* (): AsyncIterable<CloudTaskStreamEvent> {
              yield {
                sequence: 1,
                executionId: execution.executionId,
                type: 'usage',
                durationMs: 10,
                costMicros: 10,
              };
              await suspendRequested.promise;
              yield {
                sequence: 2,
                executionId: execution.executionId,
                type: 'suspended',
                handoffId: 'handoff-1',
              };
            })()
          : asyncEvents([
              {
                sequence: 3,
                executionId: execution.executionId,
                type: 'usage',
                durationMs: 20,
                costMicros: 20,
              },
              {
                sequence: 4,
                executionId: execution.executionId,
                type: 'completed',
                result: createTurnResult(),
              },
            ]);
      }),
    };
    const handoffCoordinator = new CloudTaskExecutionHandoffCoordinator({
      controlPlane,
      leaseRegistry,
      resumeStore,
    });
    let teleportSession: CloudTaskTeleportSession | null = null;
    let teleportState = null as null | CloudTaskTeleportSession['state'];
    const observer: CloudTaskTeleportObserver = {
      publish: (state) => {
        teleportState = state;
      },
      register: (session) => {
        teleportSession = session;
        teleportState = session.state;
        return () => {
          teleportSession = null;
        };
      },
      update: (_agentInstanceId, update) => {
        if (teleportState) teleportState = { ...teleportState, ...update };
      },
    };
    const adapter = new ProductionCloudExecutionTargetAdapter({
      controlPlane,
      secretBroker: createBroker(
        now,
        vi.fn(async () => {}),
      ),
      getAccountAccessToken: () => 'account-token',
      resolvePolicy: () => POLICY,
      serializeRequest: vi.fn(async () => createSerializedTurn()),
      resumeStore,
      leaseRegistry,
      leaseHolderId: 'desktop-1',
      handoffCoordinator,
      now: () => now,
    });
    adapter.setTeleportObserver(observer);

    const step = await adapter.execute(request);
    const chunksPromise = collect(step.toUIMessageStream());
    const consumePromise = Promise.resolve(step.consumeStream());
    await vi.waitFor(() => {
      expect(teleportState?.lastSequence).toBe(1);
    });

    const suspended = await teleportSession!.continueLocally();
    expect(suspended).toMatchObject({
      phase: 'suspended',
      epoch: 1,
      handoffId: 'handoff-1',
      lastSequence: 2,
    });
    expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(true);

    const resumed = await teleportSession!.resumeInCloud();
    expect(resumed).toMatchObject({
      phase: 'cloud-owned',
      epoch: 2,
      handoffId: null,
      lastSequence: 2,
    });
    expect(leaseRegistry.get('agent-1')).toMatchObject({ epoch: 2 });

    const chunks = await chunksPromise;
    await consumePromise;
    expect(chunks).toEqual([
      {
        type: 'data-cloud-usage',
        id: 'cloud-usage-1',
        data: { durationMs: 10, costMicros: 10 },
      },
      {
        type: 'data-cloud-usage',
        id: 'cloud-usage-3',
        data: { durationMs: 20, costMicros: 20 },
      },
    ]);
    expect(controlPlane.releaseExecutionLease).toHaveBeenCalledTimes(2);
    expect(controlPlane.resumeExecution).toHaveBeenCalledOnce();
    expect(teleportSession).toBeNull();
  });

  it('replays an unfinished artifact event from the last persisted sequence', async () => {
    const now = 1_000_000;
    const request = createRequest(vi.fn());
    const execution = createStartedExecution(now);
    const afterSequences: number[] = [];
    let streamAttempt = 0;
    const artifact = {
      artifactId: 'artifact-1',
      fileName: 'result.txt',
      mediaType: 'text/plain',
      sizeBytes: 10,
      sha256: 'c'.repeat(64),
      downloadUrl: 'https://cloud.example.test/artifacts/artifact-1',
      expiresAt: now + 60_000,
    };
    const controlPlane = {
      ...createControlPlane(now),
      startExecution: vi.fn(async () => execution),
      streamExecution: vi.fn(
        (
          _execution: CloudTaskStartedExecution,
          _token: string,
          afterSequence: number,
        ) => {
          afterSequences.push(afterSequence);
          streamAttempt += 1;
          return asyncEvents(
            streamAttempt === 1
              ? [
                  {
                    sequence: 1,
                    executionId: execution.executionId,
                    type: 'usage',
                    durationMs: 100,
                    costMicros: 50,
                  },
                  {
                    sequence: 2,
                    executionId: execution.executionId,
                    type: 'artifact',
                    artifact,
                  },
                ]
              : [
                  {
                    sequence: 2,
                    executionId: execution.executionId,
                    type: 'artifact',
                    artifact,
                  },
                  {
                    sequence: 3,
                    executionId: execution.executionId,
                    type: 'completed',
                    result: createTurnResult(),
                  },
                ],
          );
        },
      ),
    };
    const artifactDownloader = {
      download: vi
        .fn()
        .mockRejectedValueOnce(new Error('network interrupted'))
        .mockResolvedValueOnce({
          executionId: 'execution-1',
          artifactId: 'artifact-1',
          fileName: 'result.txt',
          mediaType: 'text/plain',
          sizeBytes: 10,
          sha256: 'c'.repeat(64),
          localPath: '/tmp/cloud-artifact',
          resumedBytes: 5,
        }),
    };
    const resumeStore = {
      load: vi.fn(async () => 0),
      save: vi.fn(
        async (_execution: CloudTaskStartedExecution, _sequence: number) => {},
      ),
      clear: vi.fn(async () => {}),
      listPending: vi.fn(async () => []),
      clearByExecutionId: vi.fn(async () => {}),
    };
    const adapter = new ProductionCloudExecutionTargetAdapter({
      controlPlane,
      secretBroker: createBroker(
        now,
        vi.fn(async () => {}),
      ),
      getAccountAccessToken: () => 'account-token',
      resolvePolicy: () => POLICY,
      serializeRequest: vi.fn(async () => createSerializedTurn()),
      artifactDownloader,
      resumeStore,
      now: () => now,
    });

    const step = await adapter.execute(request);
    await Promise.all([
      collect(step.toUIMessageStream()),
      step.consumeStream(),
    ]);

    expect(afterSequences).toEqual([0, 1]);
    expect(artifactDownloader.download).toHaveBeenCalledTimes(2);
    expect(resumeStore.save.mock.calls.map(([, sequence]) => sequence)).toEqual(
      [0, 1, 2, 3],
    );
    expect(resumeStore.clear).toHaveBeenCalledOnce();
  });

  it('cancels the remote execution when the local abort signal fires', async () => {
    const now = 1_000_000;
    const controller = new AbortController();
    const request = createRequest(vi.fn(), controller.signal);
    const execution = createStartedExecution(now);
    const cancelExecution = vi.fn(async () => {});
    const audit = vi.fn();
    const controlPlane = {
      ...createControlPlane(now),
      startExecution: vi.fn(async () => execution),
      cancelExecution,
      streamExecution: vi.fn(
        (
          _execution: CloudTaskStartedExecution,
          _token: string,
          _after: number,
          signal?: AbortSignal,
        ) =>
          (async function* () {
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(resolve, 5_000);
              signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(timeout);
                  reject(new DOMException('Aborted', 'AbortError'));
                },
                { once: true },
              );
            });
          })(),
      ),
    };
    const adapter = new ProductionCloudExecutionTargetAdapter({
      controlPlane,
      secretBroker: createBroker(
        now,
        vi.fn(async () => {}),
      ),
      getAccountAccessToken: () => 'account-token',
      resolvePolicy: () => POLICY,
      serializeRequest: vi.fn(async () => createSerializedTurn()),
      audit,
      now: () => now,
    });

    const step = await adapter.execute(request);
    const uiPromise = collect(step.toUIMessageStream());
    const consumePromise = step.consumeStream();
    controller.abort();
    const [chunks] = await Promise.all([uiPromise, consumePromise]);

    expect(cancelExecution).toHaveBeenCalledOnce();
    expect(chunks).toEqual([
      expect.objectContaining({
        type: 'abort',
      }),
    ]);
    expect(audit.mock.calls.map(([event]) => event.operation)).toEqual([
      'restore-handshake',
      'lease-acquire',
      'start',
      'cancel',
      'stream',
      'lease-release',
    ]);
  });

  it('keeps local ownership when cloud lease acquisition fails', async () => {
    const now = 1_000_000;
    const request = createRequest(vi.fn());
    const execution = createStartedExecution(now);
    const startExecution = vi.fn(async () => execution);
    const acquireExecutionLease = vi.fn(async () => {
      throw new CloudTaskExecutionLeaseError('conflict');
    });
    const cancelExecution = vi.fn(async () => {});
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => now,
    });
    const adapter = new ProductionCloudExecutionTargetAdapter({
      controlPlane: {
        ...createControlPlane(now),
        startExecution,
        acquireExecutionLease,
        cancelExecution,
      },
      secretBroker: createBroker(
        now,
        vi.fn(async () => {}),
      ),
      getAccountAccessToken: () => 'account-token',
      resolvePolicy: () => POLICY,
      serializeRequest: vi.fn(async () => createSerializedTurn()),
      leaseRegistry,
      now: () => now,
    });

    await expect(adapter.execute(request)).rejects.toMatchObject({
      reason: 'conflict',
    });

    expect(startExecution.mock.invocationCallOrder[0]).toBeLessThan(
      acquireExecutionLease.mock.invocationCallOrder[0] ?? 0,
    );
    expect(cancelExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        ...execution,
        restoreReceiptId: 'restore-1',
      }),
      'task-token',
    );
    expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(true);
  });

  it('does not acquire ownership when restore confirmation fails', async () => {
    const now = 1_000_000;
    const request = createRequest(vi.fn());
    const execution = createStartedExecution(now);
    const confirmExecutionRestore = vi.fn(async () => {
      throw new Error('restore receipt mismatch');
    });
    const acquireExecutionLease = vi.fn();
    const cancelExecution = vi.fn(async () => {});
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => now,
    });
    const audit = vi.fn();
    const adapter = new ProductionCloudExecutionTargetAdapter({
      controlPlane: {
        ...createControlPlane(now),
        startExecution: vi.fn(async () => execution),
        confirmExecutionRestore,
        acquireExecutionLease,
        cancelExecution,
      },
      secretBroker: createBroker(
        now,
        vi.fn(async () => {}),
      ),
      getAccountAccessToken: () => 'account-token',
      resolvePolicy: () => POLICY,
      serializeRequest: vi.fn(async () => createSerializedTurn()),
      leaseRegistry,
      audit,
      now: () => now,
    });

    await expect(adapter.execute(request)).rejects.toThrow(
      'restore receipt mismatch',
    );

    expect(confirmExecutionRestore).toHaveBeenCalledOnce();
    expect(acquireExecutionLease).not.toHaveBeenCalled();
    expect(cancelExecution).toHaveBeenCalledWith(execution, 'task-token');
    expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'restore-handshake',
        success: false,
        reason: 'restore',
      }),
    );
  });

  it('fences an old stream when a newer epoch takes ownership', async () => {
    const now = 1_000_000;
    const request = createRequest(vi.fn());
    const execution = createStartedExecution(now);
    const oldLease = createExecutionLease(now);
    const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
      now: () => now,
    });
    const controlPlane = {
      ...createControlPlane(now),
      startExecution: vi.fn(async () => execution),
      acquireExecutionLease: vi.fn(async () => oldLease),
      streamExecution: vi.fn(() =>
        asyncEvents([
          {
            sequence: 1,
            executionId: execution.executionId,
            type: 'usage',
            durationMs: 1,
            costMicros: 1,
          },
        ]),
      ),
    };
    const adapter = new ProductionCloudExecutionTargetAdapter({
      controlPlane,
      secretBroker: createBroker(
        now,
        vi.fn(async () => {}),
      ),
      getAccountAccessToken: () => 'account-token',
      resolvePolicy: () => POLICY,
      serializeRequest: vi.fn(async () => createSerializedTurn()),
      leaseRegistry,
      now: () => now,
    });

    const step = await adapter.execute(request);
    const newerLease = createExecutionLease(now, {
      leaseId: 'lease-2',
      holderId: 'other-holder',
      epoch: 2,
      fencingToken: 'fence-2',
    });
    leaseRegistry.activate('agent-1', newerLease);

    const [chunks] = await Promise.all([
      collect(step.toUIMessageStream()),
      step.consumeStream(),
    ]);

    expect(chunks).toEqual([
      expect.objectContaining({
        type: 'error',
        errorText: expect.stringContaining('stale'),
      }),
    ]);
    expect(controlPlane.streamExecution).toHaveBeenCalledOnce();
    expect(leaseRegistry.get('agent-1')).toEqual(newerLease);
  });

  it('keeps local execution fenced after uncertain renewal and release', async () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    try {
      const request = createRequest(vi.fn());
      const execution = createStartedExecution(now);
      const leaseRegistry = new CloudTaskExecutionLeaseRegistry({
        now: () => now,
      });
      const controlPlane = {
        ...createControlPlane(now),
        startExecution: vi.fn(async () => execution),
        acquireExecutionLease: vi.fn(async () =>
          createExecutionLease(now, { expiresAt: now + 1_000 }),
        ),
        renewExecutionLease: vi.fn(async () => {
          throw new Error('network unavailable');
        }),
        releaseExecutionLease: vi.fn(async () => {
          throw new Error('network unavailable');
        }),
        streamExecution: vi.fn(
          (
            _execution: CloudTaskStartedExecution,
            _token: string,
            _after: number,
            signal?: AbortSignal,
          ) =>
            (async function* () {
              await new Promise<void>((_resolve, reject) => {
                signal?.addEventListener(
                  'abort',
                  () => reject(new Error('stream interrupted')),
                  { once: true },
                );
              });
            })(),
        ),
      };
      const adapter = new ProductionCloudExecutionTargetAdapter({
        controlPlane,
        secretBroker: createBroker(
          now,
          vi.fn(async () => {}),
        ),
        getAccountAccessToken: () => 'account-token',
        resolvePolicy: () => POLICY,
        serializeRequest: vi.fn(async () => createSerializedTurn()),
        leaseRegistry,
        now: () => now,
      });

      const step = await adapter.execute(request);
      const uiPromise = collect(step.toUIMessageStream());
      const consumePromise = step.consumeStream();
      now += 500;
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all([uiPromise, consumePromise]);

      expect(controlPlane.renewExecutionLease).toHaveBeenCalledOnce();
      expect(controlPlane.releaseExecutionLease).toHaveBeenCalledOnce();
      expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(false);

      now += 501;
      expect(leaseRegistry.isLocalExecutionAllowed('agent-1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createBroker(
  now: number,
  revokeCredential: ReturnType<typeof vi.fn>,
): CloudTaskSecretBroker {
  const transport: CloudTaskSecretBrokerTransport = {
    issueCredential: vi.fn(async (request) => ({
      credentialId: 'cred-1',
      taskId: request.taskId,
      audience: request.audience,
      residency: request.residency,
      scopes: [...request.scopes],
      token: 'task-token',
      issuedAt: now,
      expiresAt: now + 60_000,
    })),
    revokeCredential,
  };
  return new CloudTaskSecretBroker({
    transport,
    getAccountAccessToken: () => 'account-token',
    audience: 'cloud-task-runtime',
    now: () => now,
  });
}

function createControlPlane(now = 1_000_000): CloudTaskControlPlane {
  return {
    createUploadSession: vi.fn(),
    uploadSnapshot: vi.fn(),
    issueCredential: vi.fn(),
    revokeCredential: vi.fn(),
    startExecution: vi.fn(),
    confirmExecutionRestore: vi.fn(async (request) => ({
      restoreReceiptId: 'restore-1',
      taskId: request.taskId,
      executionId: request.executionId,
      uploadSessionId: request.uploadSessionId,
      snapshotSha256: request.snapshotSha256,
      workspaceSnapshotHash: request.workspaceSnapshotHash,
      checkpointId: request.checkpoint?.checkpointId ?? null,
      historyContentHash: request.checkpoint?.historyContentHash ?? null,
      workspaceRevisionHash: request.checkpoint?.workspaceRevisionHash ?? null,
      restoredAt: now,
    })),
    acquireExecutionLease: vi.fn(async (request) =>
      createExecutionLease(now, {
        taskId: request.taskId,
        executionId: request.executionId,
        restoreReceiptId: request.restoreReceiptId,
        holderId: request.holderId,
      }),
    ),
    renewExecutionLease: vi.fn(async (lease) => ({
      ...lease,
      expiresAt: lease.expiresAt + 60_000,
    })),
    releaseExecutionLease: vi.fn(async () => {}),
    streamExecution: vi.fn(),
    getExecutionStatus: vi.fn(),
    cancelExecution: vi.fn(),
    cancelExecutionById: vi.fn(),
    downloadArtifact: vi.fn(),
  };
}

function createExecutionLease(
  now: number,
  overrides: Partial<CloudTaskExecutionLease> = {},
): CloudTaskExecutionLease {
  return {
    leaseId: 'lease-1',
    taskId: 'task-1',
    executionId: 'execution-1',
    restoreReceiptId: 'restore-1',
    holderId: 'clodex-desktop',
    epoch: 1,
    fencingToken: 'fence-1',
    acquiredAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

function createUploadSession(
  server: ReturnType<typeof generateKeyPairSync>,
): CloudTaskUploadSession {
  return {
    sessionId: 'upload-1',
    uploadUrl: 'https://uploads.example.test/snapshot',
    uploadHeaders: {},
    expiresAt: Date.now() + 60_000,
    residency: 'eu',
    maxBytes: 1024,
    maxFiles: 10,
    recipientKey: {
      algorithm: 'p256',
      keyId: 'recipient-1',
      publicKeySpki: server.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64url'),
      expiresAt: Date.now() + 60_000,
    },
  };
}

function createSnapshotDescriptor(): CloudTaskSnapshotDescriptor {
  return {
    version: 1,
    manifest: {
      version: 1,
      taskId: 'task-1',
      snapshotHash: 'c'.repeat(64),
      createdAt: 1,
      selection: 'explicit',
      totalBytes: 1,
      entries: [
        {
          mountPrefix: 'repo',
          relativePath: 'src/index.ts',
          kind: 'file',
          sizeBytes: 1,
          sha256: 'a'.repeat(64),
        },
      ],
      mounts: [
        {
          mountPrefix: 'repo',
          workspaceIdHash: 'd'.repeat(64),
          repositoryId: null,
          worktreeId: null,
          repositoryRevision: null,
          dirtyPatchHash: 'e'.repeat(64),
          dependencyFingerprintHash: '1'.repeat(64),
          ignorePolicyHash: 'f'.repeat(64),
        },
      ],
      environment: {
        os: 'test',
        arch: 'test',
        shell: null,
        toolchains: {},
        fingerprintHash: '1'.repeat(64),
      },
    },
    archive: {
      format: 'clodex-snapshot-v1',
      path: '/tmp/snapshot.enc',
      sizeBytes: 1,
      sha256: 'b'.repeat(64),
    },
    encryption: {
      algorithm: 'aes-256-gcm',
      nonce: 'nonce',
      authTag: 'tag',
      wrappedDataKey: {
        algorithm: 'test',
        keyId: 'key',
        value: 'wrapped',
      },
    },
    signature: {
      algorithm: 'test',
      keyId: 'key',
      value: 'signature',
    },
  };
}

function createRequest(
  onFinish: ReturnType<typeof vi.fn>,
  abortSignal?: AbortSignal,
): AgentStepExecutionRequest {
  return {
    context: {
      agentInstanceId: 'agent-1',
      agentType: 'chat',
      traceId: 'trace-1',
      requestedModelId: 'model-1',
      resolvedModelId: 'model-1',
      isApprovalContinuation: false,
      executionTarget: 'cloud',
      executionTaskId: 'task-1',
      metadata: {
        cloudSnapshot: {
          ...createSnapshotDescriptor(),
          upload: {
            sessionId: 'upload-1',
            objectId: 'object-1',
            residency: 'eu',
            expiresAt: 2_000_000,
            sha256: 'b'.repeat(64),
          },
        },
      },
    },
    options: {
      model: {} as never,
      messages: [{ role: 'user', content: 'hello' }],
      abortSignal,
      onFinish,
      onError: vi.fn(),
      onAbort: vi.fn(),
    },
  };
}

function createTeleportCheckpoint() {
  return createAgentSessionCheckpoint({
    id: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-07-11T10:00:00.000Z',
    task: {
      agentInstanceId: 'agent-1',
      agentType: 'chat',
      title: 'Teleport',
      goal: null,
      lineage: {
        parentAgentInstanceId: null,
        forkedFromAgentId: null,
        forkedFromMessageId: null,
      },
    },
    execution: {
      state: 'idle',
      target: 'local',
      activeModelId: 'model-1',
      approvalProfile: 'alwaysAsk',
      usedTokens: 1,
      historyMessageCount: 1,
      lastMessageId: 'message-1',
    },
    memory: {
      history: {
        kind: 'agent-memory-jsonl',
        agentInstanceId: 'agent-1',
        messageCount: 1,
        contentHash: 'a'.repeat(64),
      },
      compressedHistory: null,
    },
    workspace: {
      capturedAt: '2026-07-11T10:00:00.000Z',
      workspaces: [
        {
          path: '/repo',
          permissions: ['read', 'edit'],
          repositoryId: 'repo-1',
          worktreeId: 'worktree-1',
          revision: 'abc123',
        },
      ],
    },
    persistence: {
      agentStateFlushedAt: '2026-07-11T10:00:00.000Z',
      memoryFlushedAt: '2026-07-11T10:00:00.000Z',
    },
  });
}

function createSelection(): AgentTaskSnapshotSelection {
  return {
    version: 1,
    mode: 'explicit',
    entries: [
      {
        mountPrefix: 'repo',
        relativePath: 'src/index.ts',
        expectedSha256: 'a'.repeat(64),
      },
    ],
  };
}

function createStartedExecution(now: number): CloudTaskStartedExecution {
  return {
    executionId: 'execution-1',
    taskId: 'task-1',
    streamUrl: 'https://cloud.example.test/stream',
    cancelUrl: 'https://cloud.example.test/cancel',
    expiresAt: now + 60_000,
  };
}

function createSerializedTurn() {
  return {
    agentInstanceId: 'agent-1',
    modelId: 'model-1',
    traceId: 'trace-1',
    metadata: {},
    systemPrompt: '',
    messages: [{ role: 'user' as const, content: 'hello' }],
    tools: [],
    maxSteps: 1,
  };
}

function createTurnResult(): IsolatedAgentTurnResult {
  return {
    status: 'completed',
    text: 'hello',
    messages: [{ role: 'assistant', text: 'hello', toolCalls: [] }],
    steps: [
      {
        index: 1,
        text: 'hello',
        reasoning: '',
        finishReason: 'stop',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
        toolCalls: [],
        toolResults: [],
        toolErrors: [],
        approvalRequests: [],
      },
    ],
  };
}

async function* asyncEvents(
  events: CloudTaskStreamEvent[],
): AsyncIterable<CloudTaskStreamEvent> {
  for (const event of events) yield event;
}

function createTestDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function collect(
  stream: AsyncIterable<InferUIMessageChunk<UIMessage>>,
): Promise<InferUIMessageChunk<UIMessage>[]> {
  const chunks: InferUIMessageChunk<UIMessage>[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
