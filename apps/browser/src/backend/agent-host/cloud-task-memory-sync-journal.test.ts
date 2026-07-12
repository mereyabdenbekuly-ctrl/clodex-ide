import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { FileSystemCloudTaskMemorySyncJournal } from './cloud-task-memory-sync-journal';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('FileSystemCloudTaskMemorySyncJournal', () => {
  it('persists only content-free diagnostics and restores them after restart', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'memory-sync-journal-'),
    );
    directories.push(directory);
    const filePath = path.join(directory, 'journal.json');
    const journal = new FileSystemCloudTaskMemorySyncJournal({
      filePath,
      now: () => 2_000,
      idGenerator: () => 'journal-1',
    });
    await journal.record({
      taskId: 'task-1',
      agentInstanceId: 'agent-1',
      executionId: 'execution-1',
      operation: 'cloud-to-local',
      direction: 'cloud-to-local',
      status: 'diverged',
      epoch: 3,
      checkpointId: `memory:${'a'.repeat(64)}`,
      eventCount: 42,
      divergenceEventIdHash: 'b'.repeat(64),
      errorCode: 'event-divergence',
      recoveryClass: 'content-conflict',
      recoveryDecision: 'manual',
      automatic: false,
      protocol: 'atomic-v1',
      idempotentReplay: true,
      startedAt: 1_900,
      finishedAt: 2_000,
    });

    const raw = await readFile(filePath, 'utf8');
    expect(raw).not.toMatch(
      /payload|prompt|fencingToken|leaseId|ledgerHash|workspace|credential/,
    );
    const restored = new FileSystemCloudTaskMemorySyncJournal({
      filePath,
      now: () => 3_000,
    });
    await restored.initialize();
    expect(restored.listForAgent('agent-1')).toEqual([
      expect.objectContaining({
        status: 'diverged',
        errorCode: 'event-divergence',
        eventCount: 42,
        recoveryClass: 'content-conflict',
        recoveryDecision: 'manual',
        protocol: 'atomic-v1',
        idempotentReplay: true,
      }),
    ]);
    expect(restored.exportForAgent('agent-1')).toEqual(
      expect.objectContaining({
        format: 'clodex-memory-sync-diagnostics',
        version: 1,
        entries: expect.arrayContaining([
          expect.objectContaining({ id: 'journal-1' }),
        ]),
      }),
    );
  });
});
