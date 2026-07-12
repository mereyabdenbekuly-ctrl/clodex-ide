import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSystemCloudTaskArtifactStore } from './cloud-task-artifact-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('FileSystemCloudTaskArtifactStore', () => {
  it('evicts oldest completed artifacts before reserving global disk budget', async () => {
    const rootDirectory = await createRoot();
    const audit = vi.fn();
    const store = new FileSystemCloudTaskArtifactStore({
      rootDirectory,
      residency: 'us',
      maxDiskBytes: 10,
      maxAgeMs: 60_000,
      now: () => 1_000_000,
      audit,
    });
    await createArtifact(store, rootDirectory, 'execution-1', 'artifact-1', 6);
    const oldDate = new Date(900_000);
    await utimes(
      path.join(rootDirectory, 'execution-1', 'artifact-1.artifact'),
      oldDate,
      oldDate,
    );

    const reservation = await store.reserve({
      executionId: 'execution-2',
      artifactId: 'artifact-2',
      expectedBytes: 8,
    });

    expect(
      await readFile(
        path.join(rootDirectory, 'execution-1', 'artifact-1.artifact'),
      ).catch(() => null),
    ).toBeNull();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'retention',
        removedArtifacts: 1,
        removedBytes: 6,
      }),
    );
    await reservation.release();
  });

  it('never removes an active partial download during cleanup', async () => {
    const rootDirectory = await createRoot();
    const store = new FileSystemCloudTaskArtifactStore({
      rootDirectory,
      residency: 'eu',
      maxDiskBytes: 8,
      maxAgeMs: 1,
      now: () => 1_000_000,
    });
    const reservation = await store.reserve({
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      expectedBytes: 8,
    });
    const directory = path.join(rootDirectory, 'execution-1');
    await mkdir(directory, { recursive: true });
    const partialPath = path.join(directory, 'artifact-1.part');
    await writeFile(partialPath, Buffer.alloc(8));
    const oldDate = new Date(100);
    await utimes(partialPath, oldDate, oldDate);

    await store.cleanup();

    expect((await readFile(partialPath)).byteLength).toBe(8);
    await reservation.release();
  });

  it('resolves only metadata-bound regular files under the artifact root', async () => {
    const rootDirectory = await createRoot();
    const store = new FileSystemCloudTaskArtifactStore({
      rootDirectory,
      residency: 'apac',
    });
    await createArtifact(store, rootDirectory, 'execution-1', 'artifact-1', 4);

    const expectedPath = await realpath(
      path.join(rootDirectory, 'execution-1', 'artifact-1.artifact'),
    );
    await expect(store.resolve('execution-1', 'artifact-1')).resolves.toEqual(
      expect.objectContaining({
        executionId: 'execution-1',
        artifactId: 'artifact-1',
        fileName: 'result.txt',
        sizeBytes: 4,
        localPath: expectedPath,
      }),
    );
    await expect(store.resolve('execution-1', '../outside')).rejects.toThrow(
      'artifact id',
    );
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'cloud-artifact-store-test-'));
  temporaryDirectories.push(root);
  return root;
}

async function createArtifact(
  store: FileSystemCloudTaskArtifactStore,
  rootDirectory: string,
  executionId: string,
  artifactId: string,
  sizeBytes: number,
): Promise<void> {
  const directory = path.join(rootDirectory, executionId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `${artifactId}.artifact`),
    Buffer.alloc(sizeBytes),
  );
  await store.recordCompleted({
    executionId,
    artifactId,
    fileName: 'result.txt',
    mediaType: 'text/plain',
    sizeBytes,
    sha256: 'a'.repeat(64),
    downloadedAt: 1_000_000,
  });
}
