import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CloudTaskStartedExecution } from './cloud-task-control-plane';
import { FileSystemCloudTaskStreamResumeStore } from './cloud-task-resume-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('FileSystemCloudTaskStreamResumeStore', () => {
  it('persists a content-free cursor and clears it after terminal delivery', async () => {
    const rootDirectory = await mkdtemp(
      path.join(tmpdir(), 'cloud-resume-test-'),
    );
    temporaryDirectories.push(rootDirectory);
    const execution = createExecution();
    const store = new FileSystemCloudTaskStreamResumeStore({
      rootDirectory,
      now: () => 1_000_000,
    });

    expect(await store.load(execution)).toBe(0);
    await store.save(execution, 7);
    expect(await store.load(execution)).toBe(7);
    await store.clear(execution);
    expect(await store.load(execution)).toBe(0);
  });

  it('persists a suspended handoff only at its exact stream barrier', async () => {
    const rootDirectory = await mkdtemp(
      path.join(tmpdir(), 'cloud-resume-test-'),
    );
    temporaryDirectories.push(rootDirectory);
    const execution = createExecution();
    const store = new FileSystemCloudTaskStreamResumeStore({
      rootDirectory,
      now: () => 1_000_000,
    });
    const handoff = {
      handoffId: 'handoff-1',
      sourceLeaseId: 'lease-1',
      sourceEpoch: 1,
      suspendedAtSequence: 7,
    };

    await store.save(execution, 7, handoff, {
      agentInstanceId: 'agent-1',
    });
    await expect(store.listPending()).resolves.toEqual([
      expect.objectContaining({
        executionId: execution.executionId,
        agentInstanceId: 'agent-1',
        lastSequence: 7,
        handoff,
      }),
    ]);
    await expect(store.save(execution, 6, handoff)).rejects.toThrow(
      'handoff checkpoint',
    );
  });

  it('persists only the epoch for cloud-owned recovery', async () => {
    const rootDirectory = await mkdtemp(
      path.join(tmpdir(), 'cloud-resume-test-'),
    );
    temporaryDirectories.push(rootDirectory);
    const execution = createExecution();
    const store = new FileSystemCloudTaskStreamResumeStore({
      rootDirectory,
      now: () => 1_000_000,
    });

    await store.save(execution, 11, null, {
      agentInstanceId: 'agent-1',
      cloudOwnership: { epoch: 3 },
      memoryCheckpoint: {
        checkpointId: `memory:${'b'.repeat(64)}`,
        eventCount: 42,
        epoch: 3,
        lastSequence: 11,
        syncState: 'synchronized',
      },
    });

    await expect(store.listPending()).resolves.toEqual([
      expect.objectContaining({
        version: 5,
        agentInstanceId: 'agent-1',
        lastSequence: 11,
        handoff: null,
        cloudOwnership: { epoch: 3 },
        memoryCheckpoint: {
          checkpointId: `memory:${'b'.repeat(64)}`,
          eventCount: 42,
          epoch: 3,
          lastSequence: 11,
          syncState: 'synchronized',
        },
      }),
    ]);
    const raw = await readOptional(
      path.join(rootDirectory, 'execution-1.json'),
    );
    expect(raw).not.toContain('fencingToken');
    expect(raw).not.toContain('leaseId');
    expect(raw).not.toContain('https://');
    expect(raw).not.toContain('ledgerHash');
  });

  it('reads legacy v3 checkpoints as unowned v5 checkpoints', async () => {
    const rootDirectory = await mkdtemp(
      path.join(tmpdir(), 'cloud-resume-test-'),
    );
    temporaryDirectories.push(rootDirectory);
    await writeFile(
      path.join(rootDirectory, 'execution-1.json'),
      JSON.stringify({
        version: 3,
        taskId: 'task-1',
        executionId: 'execution-1',
        restoreReceiptId: 'restore-1',
        agentInstanceId: 'agent-1',
        handoff: null,
        lastSequence: 4,
        expiresAt: 1_060_000,
        updatedAt: 1_000_000,
      }),
      'utf8',
    );
    const store = new FileSystemCloudTaskStreamResumeStore({
      rootDirectory,
      now: () => 1_000_000,
    });

    await expect(store.listPending()).resolves.toEqual([
      expect.objectContaining({
        version: 5,
        cloudOwnership: null,
        lastSequence: 4,
      }),
    ]);
  });

  it('drops expired checkpoints', async () => {
    const rootDirectory = await mkdtemp(
      path.join(tmpdir(), 'cloud-resume-test-'),
    );
    temporaryDirectories.push(rootDirectory);
    const execution = createExecution();
    const writer = new FileSystemCloudTaskStreamResumeStore({
      rootDirectory,
      now: () => 1_000_000,
    });
    await writer.save(execution, 3);
    const expiredReader = new FileSystemCloudTaskStreamResumeStore({
      rootDirectory,
      now: () => execution.expiresAt + 1,
    });

    expect(await expiredReader.load(execution)).toBe(0);
  });

  it('lists bounded valid checkpoints and removes corrupt entries', async () => {
    const rootDirectory = await mkdtemp(
      path.join(tmpdir(), 'cloud-resume-test-'),
    );
    temporaryDirectories.push(rootDirectory);
    const store = new FileSystemCloudTaskStreamResumeStore({
      rootDirectory,
      now: () => 1_000_000,
    });
    const first = createExecution();
    const second = {
      ...createExecution(),
      taskId: 'task-2',
      executionId: 'execution-2',
    };
    await store.save(second, 9);
    await store.save(first, 3);
    await writeFile(path.join(rootDirectory, 'corrupt.json'), '{', 'utf8');

    expect(await store.listPending()).toEqual([
      expect.objectContaining({ executionId: 'execution-1', lastSequence: 3 }),
      expect.objectContaining({ executionId: 'execution-2', lastSequence: 9 }),
    ]);
    expect(await store.listPending(1)).toHaveLength(1);
    expect(
      await readOptional(path.join(rootDirectory, 'corrupt.json')),
    ).toBeNull();

    await store.clearByExecutionId('execution-1');
    expect(await store.listPending()).toEqual([
      expect.objectContaining({ executionId: 'execution-2' }),
    ]);
  });
});

function createExecution(): CloudTaskStartedExecution {
  return {
    executionId: 'execution-1',
    restoreReceiptId: 'restore-1',
    taskId: 'task-1',
    streamUrl: 'https://cloud.example.test/stream',
    cancelUrl: 'https://cloud.example.test/cancel',
    expiresAt: 1_060_000,
  };
}

async function readOptional(filePath: string): Promise<string | null> {
  const { readFile } = await import('node:fs/promises');
  return await readFile(filePath, 'utf8').catch(() => null);
}
