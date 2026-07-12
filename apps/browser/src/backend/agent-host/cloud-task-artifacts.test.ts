import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileSystemCloudTaskArtifactDownloader,
  type CloudTaskArtifactDownloader,
} from './cloud-task-artifacts';
import type {
  CloudTaskArtifactDescriptor,
  CloudTaskControlPlane,
  CloudTaskStartedExecution,
} from './cloud-task-control-plane';
import {
  CloudTaskSecretBroker,
  type CloudTaskExecutionPolicy,
  type CloudTaskSecretBrokerTransport,
} from './cloud-task-security';

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

describe('FileSystemCloudTaskArtifactDownloader', () => {
  it('resumes with an artifact-scoped credential and verifies the final digest', async () => {
    const content = Buffer.from('hello world');
    const artifact = createArtifact(content);
    const offsets: number[] = [];
    const audit = vi.fn();
    const controlPlane = createControlPlane();
    controlPlane.downloadArtifact = vi.fn(async (_artifact, token, offset) => {
      expect(token).toBe('artifact-token');
      offsets.push(offset);
      const chunk =
        offset === 0 ? content.subarray(0, 6) : content.subarray(offset);
      return {
        body: streamBytes(chunk),
        startOffset: offset,
        totalSize: content.byteLength,
      };
    });
    const rootDirectory = await mkdtemp(
      path.join(tmpdir(), 'cloud-artifact-test-'),
    );
    temporaryDirectories.push(rootDirectory);
    const downloader = createDownloader(rootDirectory, controlPlane, audit);

    const downloaded = await downloader.download({
      taskId: 'task-1',
      execution: createExecution(),
      artifact,
      policy: POLICY,
    });

    expect(offsets).toEqual([0, 6]);
    expect(await readFile(downloaded.localPath)).toEqual(content);
    expect(downloaded.resumedBytes).toBe(0);
    expect(audit.mock.calls.map(([event]) => event.operation)).toEqual([
      'resume',
      'artifact',
    ]);
    expect(audit.mock.calls[1]?.[0]).toMatchObject({
      success: true,
      artifactBytes: content.byteLength,
    });
  });

  it('fails closed and removes partial state on an integrity mismatch', async () => {
    const content = Buffer.from('artifact');
    const artifact = {
      ...createArtifact(content),
      sha256: 'f'.repeat(64),
    };
    const controlPlane = createControlPlane();
    controlPlane.downloadArtifact = vi.fn(
      async (_artifact, _token, offset) => ({
        body: streamBytes(content),
        startOffset: offset,
        totalSize: content.byteLength,
      }),
    );
    const rootDirectory = await mkdtemp(
      path.join(tmpdir(), 'cloud-artifact-test-'),
    );
    temporaryDirectories.push(rootDirectory);
    const audit = vi.fn();
    const downloader = createDownloader(rootDirectory, controlPlane, audit);

    await expect(
      downloader.download({
        taskId: 'task-1',
        execution: createExecution(),
        artifact,
        policy: POLICY,
      }),
    ).rejects.toThrow('integrity');

    expect(
      await readFile(
        path.join(rootDirectory, 'execution-1', 'artifact-1.part'),
      ).catch(() => null),
    ).toBeNull();
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: 'artifact',
        success: false,
        reason: 'integrity',
      }),
    );
  });
});

function createDownloader(
  rootDirectory: string,
  controlPlane: CloudTaskControlPlane,
  audit: ReturnType<typeof vi.fn>,
): CloudTaskArtifactDownloader {
  const transport: CloudTaskSecretBrokerTransport = {
    issueCredential: vi.fn(async (request) => ({
      credentialId: 'artifact-credential',
      taskId: request.taskId,
      audience: request.audience,
      residency: request.residency,
      scopes: [...request.scopes],
      token: 'artifact-token',
      issuedAt: 1_000_000,
      expiresAt: 1_060_000,
    })),
    revokeCredential: vi.fn(async () => {}),
  };
  return new FileSystemCloudTaskArtifactDownloader({
    rootDirectory,
    controlPlane,
    secretBroker: new CloudTaskSecretBroker({
      transport,
      getAccountAccessToken: () => 'account-token',
      audience: 'cloud-task-runtime',
      now: () => 1_000_000,
    }),
    audit,
    now: () => 1_000_000,
  });
}

function createArtifact(content: Buffer): CloudTaskArtifactDescriptor {
  return {
    artifactId: 'artifact-1',
    fileName: 'result.txt',
    mediaType: 'text/plain',
    sizeBytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
    downloadUrl: 'https://cloud.example.test/artifacts/artifact-1',
    expiresAt: 1_060_000,
  };
}

function createExecution(): CloudTaskStartedExecution {
  return {
    executionId: 'execution-1',
    taskId: 'task-1',
    streamUrl: 'https://cloud.example.test/stream',
    cancelUrl: 'https://cloud.example.test/cancel',
    expiresAt: 1_060_000,
  };
}

function createControlPlane(): CloudTaskControlPlane {
  return {
    createUploadSession: vi.fn(),
    uploadSnapshot: vi.fn(),
    issueCredential: vi.fn(),
    revokeCredential: vi.fn(),
    startExecution: vi.fn(),
    streamExecution: vi.fn(),
    getExecutionStatus: vi.fn(),
    cancelExecution: vi.fn(),
    cancelExecutionById: vi.fn(),
    downloadArtifact: vi.fn(),
  };
}

function streamBytes(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}
