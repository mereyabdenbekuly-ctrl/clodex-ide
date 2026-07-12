import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  P256RunnerSigningAuthority,
  createSignedRunnerJob,
  hashRunnerPayload,
} from './runner-security';
import {
  DockerRunnerAdapter,
  type DockerRunnerTransport,
} from './docker-runner-adapter';

const SNAPSHOT_HASH = 'a'.repeat(64);
const DIRTY_PATCH_HASH = 'b'.repeat(64);
const REMOTE_ENVIRONMENT_HASH = 'c'.repeat(64);
const ARCHIVE = Buffer.from('archive');
const ARCHIVE_HASH = createHash('sha256').update(ARCHIVE).digest('hex');

describe('DockerRunnerAdapter', () => {
  it('exposes Docker provider identity while reusing signed runner admission', async () => {
    const guardian = P256RunnerSigningAuthority.generate().authority;
    const receiptAuthority = P256RunnerSigningAuthority.generate().authority;
    const transport: DockerRunnerTransport = {
      prepareWorkspace: vi.fn(async () => ({
        workspaceHandle: 'd'.repeat(64),
        repositoryRevision: '0123456789abcdef',
        dirtyPatchHash: DIRTY_PATCH_HASH,
        materializationArchiveHash: ARCHIVE_HASH,
        environmentFingerprintHash: REMOTE_ENVIRONMENT_HASH,
      })),
      execute: vi.fn(async () => ({
        stdout: 'ok\n',
        stderr: '',
        exitCode: 0,
      })),
      captureWorkspaceArtifactState: vi.fn(async () => ({
        entries: [],
        truncated: false,
      })),
      releaseWorkspace: vi.fn(async () => undefined),
    };
    let nextId = 0;
    const adapter = new DockerRunnerAdapter('docker-runner:test', transport, {
      receiptAuthority,
      trustedGuardianPublicKey: guardian.publicKey,
      createId: () => `id-${++nextId}`,
    });
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      environmentFingerprintHash: 'e'.repeat(64),
      mounts: [
        {
          mountPrefix: 'work',
          workspaceRoot: '/local/workspace',
          repositoryRevision: '0123456789abcdef',
          dirtyPatchHash: DIRTY_PATCH_HASH,
          hasDirtyChanges: true,
          materialization: {
            version: 1,
            archiveFormat: 'tar-gzip',
            archive: ARCHIVE,
            archiveHash: ARCHIVE_HASH,
            totalBytes: ARCHIVE.byteLength,
          },
        },
      ],
    });

    expect(adapter.kind).toBe('docker');
    expect(lease.providerId).toBe('docker-runner:test');
    expect(transport.prepareWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: '/local/workspace',
        snapshotHash: SNAPSHOT_HASH,
      }),
    );

    const payload = {
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-create',
      cwd: '/local/workspace',
    };
    const created = await adapter.createSession(lease, {
      snapshotHash: SNAPSHOT_HASH,
      ...payload,
      signedJob: createSignedRunnerJob({
        providerId: lease.providerId,
        leaseId: lease.id,
        snapshotHash: lease.snapshotHash,
        operation: 'create-session',
        payloadHash: hashRunnerPayload('create-session', payload),
        environmentFingerprintHash: lease.environmentFingerprintHash,
        authority: guardian,
      }),
    });

    expect(created.value).toBe('id-2');
    expect(created.receipt.publicKey).toBe(receiptAuthority.publicKey);
  });

  it('reports Docker-specific admission errors', async () => {
    const guardian = P256RunnerSigningAuthority.generate().authority;
    const receiptAuthority = P256RunnerSigningAuthority.generate().authority;
    const transport = {
      prepareWorkspace: vi.fn(),
      execute: vi.fn(),
      captureWorkspaceArtifactState: vi.fn(),
      releaseWorkspace: vi.fn(),
    } as unknown as DockerRunnerTransport;
    const adapter = new DockerRunnerAdapter('docker-runner:test', transport, {
      receiptAuthority,
      trustedGuardianPublicKey: guardian.publicKey,
    });

    await expect(
      adapter.prepareWorkspace({
        snapshotHash: SNAPSHOT_HASH,
        environmentFingerprintHash: 'e'.repeat(64),
        mounts: [],
      }),
    ).rejects.toThrow(
      'Docker runner v1 requires exactly one mounted workspace',
    );
    expect(transport.prepareWorkspace).not.toHaveBeenCalled();
  });
});
