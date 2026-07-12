import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HttpCloudTaskControlPlane,
  type CloudTaskStartedExecution,
} from './cloud-task-control-plane';
import { CloudTaskExecutionLeaseError } from './cloud-task-execution-lease';
import type { CloudTaskExecutionPolicy } from './cloud-task-security';
import type { CloudTaskSnapshotDescriptor } from './cloud-task-snapshot-packager';

const POLICY: CloudTaskExecutionPolicy = {
  residency: 'eu',
  maxSnapshotBytes: 1024,
  maxSnapshotFiles: 10,
  maxArtifactBytes: 4096,
  maxArtifactFiles: 5,
  maxDurationMs: 60_000,
  maxCostMicros: 50_000,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('HttpCloudTaskControlPlane', () => {
  it('commits evidence memory with CAS and an idempotency key', async () => {
    const fetchMock = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(
          'memory-merge:abc',
        );
        return jsonResponse({
          version: 1,
          mutationId: 'memory-merge:abc',
          replayed: false,
          previousCheckpoint: {
            checkpointId: 'checkpoint-before',
            eventCount: 1,
          },
          checkpoint: {
            checkpointId: 'checkpoint-after',
            eventCount: 2,
          },
          importedEvents: 1,
          duplicateEvents: 1,
          committedAt: 1_700_000_000_000,
        });
      },
    );
    const controlPlane = new HttpCloudTaskControlPlane({
      baseUrl: 'https://cloud.example.test',
      fetch: fetchMock as typeof fetch,
    });
    const execution = createExecution();

    const receipt = await controlPlane.commitEvidenceMemoryAtomicMerge(
      {
        taskId: execution.taskId,
        execution,
        request: {
          version: 1,
          mutationId: 'memory-merge:abc',
          taskId: execution.taskId,
          expectedRemoteCheckpoint: {
            checkpointId: 'checkpoint-before',
            eventCount: 1,
          },
          targetCheckpoint: {
            checkpointId: 'checkpoint-after',
            eventCount: 2,
          },
          batches: [{} as never],
        },
      },
      'task-token',
    );

    expect(receipt).toEqual(
      expect.objectContaining({
        mutationId: 'memory-merge:abc',
        replayed: false,
        importedEvents: 1,
      }),
    );
  });

  it('maps atomic merge HTTP conflicts to checkpoint CAS errors', async () => {
    const controlPlane = new HttpCloudTaskControlPlane({
      baseUrl: 'https://cloud.example.test',
      fetch: (async () =>
        jsonResponse(
          {
            actualCheckpoint: {
              checkpointId: 'checkpoint-new',
              eventCount: 3,
            },
          },
          409,
        )) as typeof fetch,
    });
    const execution = createExecution();

    await expect(
      controlPlane.commitEvidenceMemoryAtomicMerge(
        {
          taskId: execution.taskId,
          execution,
          request: {
            version: 1,
            mutationId: 'memory-merge:conflict',
            taskId: execution.taskId,
            expectedRemoteCheckpoint: {
              checkpointId: 'checkpoint-old',
              eventCount: 2,
            },
            targetCheckpoint: {
              checkpointId: 'checkpoint-target',
              eventCount: 4,
            },
            batches: [{} as never],
          },
        },
        'task-token',
      ),
    ).rejects.toMatchObject({
      actualCheckpoint: {
        checkpointId: 'checkpoint-new',
        eventCount: 3,
      },
    });
  });

  it('creates a bounded upload session and never forwards auth to the signed upload URL', async () => {
    const now = 1_000_000;
    const server = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const directory = await mkdtemp(path.join(tmpdir(), 'cloud-upload-test-'));
    temporaryDirectories.push(directory);
    const archivePath = path.join(directory, 'snapshot.enc');
    await writeFile(archivePath, 'ciphertext');
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v1/cloud-tasks/upload-sessions')) {
          expect(new Headers(init?.headers).get('Authorization')).toBe(
            'Bearer account-token',
          );
          return jsonResponse({
            sessionId: 'upload-1',
            uploadUrl: 'https://uploads.example.test/object',
            uploadHeaders: {
              'x-amz-meta-purpose': 'cloud-task',
            },
            expiresAt: now + 60_000,
            residency: 'eu',
            maxBytes: 4096,
            maxFiles: 20,
            recipientKey: {
              algorithm: 'p256',
              keyId: 'recipient-1',
              publicKeySpki: server.publicKey
                .export({ format: 'der', type: 'spki' })
                .toString('base64url'),
              expiresAt: now + 60_000,
            },
          });
        }
        if (url === 'https://uploads.example.test/object') {
          const headers = new Headers(init?.headers);
          expect(headers.get('Authorization')).toBeNull();
          expect(headers.get('Cookie')).toBeNull();
          expect(headers.get('X-Clodex-SHA256')).toBe('b'.repeat(64));
          expect(
            Buffer.from(
              await new Response(init?.body as BodyInit).arrayBuffer(),
            ).toString('utf8'),
          ).toBe('ciphertext');
          return new Response(null, {
            status: 200,
            headers: {
              'x-clodex-sha256': 'b'.repeat(64),
              'x-clodex-object-id': 'object-1',
            },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    );
    const controlPlane = new HttpCloudTaskControlPlane({
      baseUrl: 'https://cloud.example.test',
      fetch: fetchMock as typeof fetch,
      now: () => now,
    });

    const session = await controlPlane.createUploadSession(
      {
        taskId: 'task-1',
        residency: 'eu',
        selectedEntryCount: 1,
        policy: POLICY,
      },
      'account-token',
    );
    expect(session.maxBytes).toBe(POLICY.maxSnapshotBytes);
    expect(session.maxFiles).toBe(POLICY.maxSnapshotFiles);

    const uploaded = await controlPlane.uploadSnapshot(
      session,
      createDescriptor(archivePath),
    );
    expect(uploaded).toEqual({
      sessionId: 'upload-1',
      objectId: 'object-1',
      sha256: 'b'.repeat(64),
    });
  });

  it('parses monotonic NDJSON streaming events and enforces execution binding', async () => {
    const result = {
      status: 'completed',
      text: 'done',
      messages: [],
      steps: [
        {
          index: 1,
          text: 'done',
          reasoning: '',
          finishReason: 'stop',
          usage: {},
          toolCalls: [],
          toolResults: [],
          toolErrors: [],
          approvalRequests: [],
        },
      ],
    };
    const ndjson = [
      {
        sequence: 1,
        executionId: 'execution-1',
        type: 'log',
        level: 'info',
        message: 'started',
      },
      {
        sequence: 2,
        executionId: 'execution-1',
        type: 'completed',
        result,
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    const fetchMock = vi.fn(
      async () =>
        new Response(ndjson, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        }),
    );
    const controlPlane = new HttpCloudTaskControlPlane({
      baseUrl: 'https://cloud.example.test',
      fetch: fetchMock as typeof fetch,
    });
    const execution: CloudTaskStartedExecution = {
      executionId: 'execution-1',
      taskId: 'task-1',
      streamUrl: 'https://cloud.example.test/stream',
      cancelUrl: 'https://cloud.example.test/cancel',
      expiresAt: Date.now() + 60_000,
    };

    const events = [];
    for await (const event of controlPlane.streamExecution(
      execution,
      'task-token',
      0,
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      sequence: 2,
      type: 'completed',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://cloud.example.test/stream?after=0'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer task-token',
        }),
      }),
    );
  });

  it('rejects cross-origin stream URLs and mismatched upload integrity', async () => {
    const controlPlane = new HttpCloudTaskControlPlane({
      baseUrl: 'https://cloud.example.test',
      fetch: vi.fn(
        async () => new Response(null, { status: 200 }),
      ) as typeof fetch,
    });
    const execution: CloudTaskStartedExecution = {
      executionId: 'execution-1',
      taskId: 'task-1',
      streamUrl: 'https://attacker.example/stream',
      cancelUrl: 'https://cloud.example.test/cancel',
      expiresAt: Date.now() + 60_000,
    };

    await expect(async () => {
      for await (const _event of controlPlane.streamExecution(
        execution,
        'task-token',
        0,
      )) {
        // No events expected.
      }
    }).rejects.toThrow('configured API origin');
  });

  it('sends fencing headers and rejects stale execution owners', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/restore-handshake')) {
          expect(JSON.parse(String(init?.body))).toEqual({
            taskId: 'task-1',
            uploadSessionId: 'upload-1',
            snapshotSha256: 'a'.repeat(64),
            workspaceSnapshotHash: 'b'.repeat(64),
            checkpoint: null,
          });
          return jsonResponse({
            restoreReceiptId: 'restore-1',
            taskId: 'task-1',
            executionId: 'execution-1',
            uploadSessionId: 'upload-1',
            snapshotSha256: 'a'.repeat(64),
            workspaceSnapshotHash: 'b'.repeat(64),
            checkpointId: null,
            historyContentHash: null,
            workspaceRevisionHash: null,
            restoredAt: now,
          });
        }
        if (url.endsWith('/v1/cloud-tasks/executions/execution-1/lease')) {
          return jsonResponse({
            leaseId: 'lease-1',
            taskId: 'task-1',
            executionId: 'execution-1',
            restoreReceiptId: 'restore-1',
            holderId: 'desktop-1',
            epoch: 7,
            fencingToken: 'fence-7',
            acquiredAt: now,
            expiresAt: now + 60_000,
          });
        }
        const headers = new Headers(init?.headers);
        expect(headers.get('X-Clodex-Lease-Id')).toBe('lease-1');
        expect(headers.get('X-Clodex-Lease-Epoch')).toBe('7');
        expect(headers.get('X-Clodex-Fencing-Token')).toBe('fence-7');
        if (url.endsWith('/renew')) {
          return jsonResponse({
            leaseId: 'lease-1',
            taskId: 'task-1',
            executionId: 'execution-1',
            restoreReceiptId: 'restore-1',
            holderId: 'desktop-1',
            epoch: 7,
            fencingToken: 'fence-7',
            acquiredAt: now,
            expiresAt: now + 120_000,
          });
        }
        if (url.includes('/stream')) {
          return new Response(null, { status: 412 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    );
    const controlPlane = new HttpCloudTaskControlPlane({
      baseUrl: 'https://cloud.example.test',
      fetch: fetchMock as typeof fetch,
      now: () => now,
    });
    const restoreReceipt = await controlPlane.confirmExecutionRestore(
      {
        taskId: 'task-1',
        executionId: 'execution-1',
        uploadSessionId: 'upload-1',
        snapshotSha256: 'a'.repeat(64),
        workspaceSnapshotHash: 'b'.repeat(64),
        checkpoint: null,
      },
      'task-token',
    );
    const lease = await controlPlane.acquireExecutionLease(
      {
        taskId: 'task-1',
        executionId: 'execution-1',
        holderId: 'desktop-1',
        checkpointId: null,
        restoreReceiptId: restoreReceipt.restoreReceiptId,
      },
      'task-token',
    );
    await expect(
      controlPlane.renewExecutionLease(lease, 'task-token'),
    ).resolves.toMatchObject({ expiresAt: now + 120_000 });

    const execution: CloudTaskStartedExecution = {
      executionId: 'execution-1',
      taskId: 'task-1',
      streamUrl: 'https://cloud.example.test/stream',
      cancelUrl: 'https://cloud.example.test/cancel',
      expiresAt: now + 60_000,
    };
    await expect(async () => {
      for await (const _event of controlPlane.streamExecution(
        execution,
        'task-token',
        0,
        undefined,
        lease,
      )) {
        // Stale owners receive no events.
      }
    }).rejects.toEqual(new CloudTaskExecutionLeaseError('stale-fencing-token'));
  });

  it('rejects a restore receipt for a different workspace snapshot', async () => {
    const now = 1_000_000;
    const controlPlane = new HttpCloudTaskControlPlane({
      baseUrl: 'https://cloud.example.test',
      now: () => now,
      fetch: vi.fn(async () =>
        jsonResponse({
          restoreReceiptId: 'restore-1',
          taskId: 'task-1',
          executionId: 'execution-1',
          uploadSessionId: 'upload-1',
          snapshotSha256: 'a'.repeat(64),
          workspaceSnapshotHash: 'c'.repeat(64),
          checkpointId: null,
          historyContentHash: null,
          workspaceRevisionHash: null,
          restoredAt: now,
        }),
      ) as typeof fetch,
    });

    await expect(
      controlPlane.confirmExecutionRestore(
        {
          taskId: 'task-1',
          executionId: 'execution-1',
          uploadSessionId: 'upload-1',
          snapshotSha256: 'a'.repeat(64),
          workspaceSnapshotHash: 'b'.repeat(64),
          checkpoint: null,
        },
        'task-token',
      ),
    ).rejects.toMatchObject({
      name: 'CloudTaskRestoreHandshakeError',
      reason: 'restore-mismatch',
    });
  });

  it('binds suspend/resume to an exact sequence barrier and newer epoch', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/handoffs/suspend')) {
          expect(new Headers(init?.headers).get('X-Clodex-Lease-Epoch')).toBe(
            '3',
          );
          return jsonResponse({
            handoffId: 'handoff-1',
            taskId: 'task-1',
            executionId: 'execution-1',
            restoreReceiptId: 'restore-1',
            sourceLeaseId: 'lease-1',
            sourceEpoch: 3,
            suspendedAtSequence: 9,
            createdAt: now,
            expiresAt: now + 60_000,
          });
        }
        if (url.endsWith('/execution-handoffs/handoff-1/resume')) {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            resumeAfterSequence: 9,
            holderId: 'desktop-2',
          });
          return jsonResponse({
            handoffId: 'handoff-1',
            resumeAfterSequence: 9,
            execution: {
              taskId: 'task-1',
              executionId: 'execution-1',
              streamUrl: 'https://cloud.example.test/stream',
              cancelUrl: 'https://cloud.example.test/cancel',
              expiresAt: now + 60_000,
            },
            lease: {
              leaseId: 'lease-2',
              taskId: 'task-1',
              executionId: 'execution-1',
              restoreReceiptId: 'restore-1',
              holderId: 'desktop-2',
              epoch: 4,
              fencingToken: 'fence-4',
              acquiredAt: now,
              expiresAt: now + 60_000,
            },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    );
    const controlPlane = new HttpCloudTaskControlPlane({
      baseUrl: 'https://cloud.example.test',
      fetch: fetchMock as typeof fetch,
      now: () => now,
    });
    const execution: CloudTaskStartedExecution = {
      taskId: 'task-1',
      executionId: 'execution-1',
      restoreReceiptId: 'restore-1',
      streamUrl: 'https://cloud.example.test/stream',
      cancelUrl: 'https://cloud.example.test/cancel',
      expiresAt: now + 60_000,
    };
    const lease = {
      leaseId: 'lease-1',
      taskId: 'task-1',
      executionId: 'execution-1',
      restoreReceiptId: 'restore-1',
      holderId: 'desktop-1',
      epoch: 3,
      fencingToken: 'fence-3',
      acquiredAt: now,
      expiresAt: now + 60_000,
    };

    const handoff = await controlPlane.suspendExecution(
      execution,
      lease,
      7,
      'task-token',
    );
    expect(handoff.suspendedAtSequence).toBe(9);
    await expect(
      controlPlane.resumeExecution(handoff, 'desktop-2', 'task-token'),
    ).resolves.toMatchObject({
      handoffId: 'handoff-1',
      resumeAfterSequence: 9,
      lease: { epoch: 4 },
      execution: { restoreReceiptId: 'restore-1' },
    });
  });

  it('parses usage/artifact events and validates resumable artifact ranges', async () => {
    const now = 1_000_000;
    const content = Buffer.from('artifact');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const ndjson = [
      {
        sequence: 1,
        executionId: 'execution-1',
        type: 'usage',
        durationMs: 500,
        costMicros: 250,
      },
      {
        sequence: 2,
        executionId: 'execution-1',
        type: 'artifact',
        artifact: {
          artifactId: 'artifact-1',
          fileName: 'result.txt',
          mediaType: 'text/plain',
          sizeBytes: content.byteLength,
          sha256,
          downloadUrl: 'https://cloud.example.test/artifacts/artifact-1',
          expiresAt: now + 60_000,
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/stream')) {
          return new Response(ndjson, { status: 200 });
        }
        expect(new Headers(init?.headers).get('Authorization')).toBe(
          'Bearer artifact-token',
        );
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=3-');
        return new Response(content.subarray(3), {
          status: 206,
          headers: {
            'content-range': `bytes 3-${content.byteLength - 1}/${content.byteLength}`,
            'content-length': String(content.byteLength - 3),
            'x-clodex-sha256': sha256,
          },
        });
      },
    );
    const controlPlane = new HttpCloudTaskControlPlane({
      baseUrl: 'https://cloud.example.test',
      fetch: fetchMock as typeof fetch,
      now: () => now,
    });
    const execution: CloudTaskStartedExecution = {
      executionId: 'execution-1',
      taskId: 'task-1',
      streamUrl: 'https://cloud.example.test/stream',
      cancelUrl: 'https://cloud.example.test/cancel',
      expiresAt: now + 60_000,
    };

    const events = [];
    for await (const event of controlPlane.streamExecution(
      execution,
      'task-token',
      0,
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(['usage', 'artifact']);
    const artifactEvent = events[1];
    if (!artifactEvent || artifactEvent.type !== 'artifact') {
      throw new Error('Artifact event was not parsed');
    }
    const download = await controlPlane.downloadArtifact(
      artifactEvent.artifact,
      'artifact-token',
      3,
    );

    expect(download.startOffset).toBe(3);
    expect(
      Buffer.from(await new Response(download.body).arrayBuffer()),
    ).toEqual(content.subarray(3));
  });

  it('conforms to fixed-origin status and idempotent orphan cancellation endpoints', async () => {
    const requests: Array<{
      url: string;
      method: string;
      token: string | null;
    }> = [];
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        requests.push({
          url,
          method: init?.method ?? 'GET',
          token: headers.get('Authorization'),
        });
        if (url.endsWith('/v1/cloud-tasks/executions/execution-1')) {
          return jsonResponse({
            taskId: 'task-1',
            executionId: 'execution-1',
            status: 'running',
            updatedAt: 1_000_000,
          });
        }
        if (url.endsWith('/v1/cloud-tasks/executions/execution-1/cancel')) {
          return new Response(null, { status: 410 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    );
    const controlPlane = new HttpCloudTaskControlPlane({
      baseUrl: 'https://cloud.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      controlPlane.getExecutionStatus('task-1', 'execution-1', 'status-token'),
    ).resolves.toEqual({
      taskId: 'task-1',
      executionId: 'execution-1',
      status: 'running',
      updatedAt: 1_000_000,
    });
    await expect(
      controlPlane.cancelExecutionById('task-1', 'execution-1', 'cancel-token'),
    ).resolves.toBeUndefined();
    expect(requests).toEqual([
      {
        url: 'https://cloud.example.test/v1/cloud-tasks/executions/execution-1',
        method: 'GET',
        token: 'Bearer status-token',
      },
      {
        url: 'https://cloud.example.test/v1/cloud-tasks/executions/execution-1/cancel',
        method: 'POST',
        token: 'Bearer cancel-token',
      },
    ]);
  });
});

function createDescriptor(archivePath: string): CloudTaskSnapshotDescriptor {
  return {
    version: 1,
    manifest: {
      version: 1,
      taskId: 'task-1',
      snapshotHash: 'c'.repeat(64),
      createdAt: 1,
      selection: 'explicit',
      totalBytes: 10,
      entries: [
        {
          mountPrefix: 'repo',
          relativePath: 'src/index.ts',
          kind: 'file',
          sizeBytes: 10,
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
      path: archivePath,
      sizeBytes: 10,
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

function createExecution(): CloudTaskStartedExecution {
  return {
    taskId: 'task-1',
    executionId: 'execution-1',
    restoreReceiptId: 'restore-1',
    streamUrl: 'https://cloud.example.test/stream',
    cancelUrl: 'https://cloud.example.test/cancel',
    expiresAt: Date.now() + 60_000,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
