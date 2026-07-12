import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EvidenceMemoryDivergenceError,
  EvidenceMemoryService,
} from '@clodex/agent-core/evidence-memory';
import type { Logger } from '@clodex/agent-core/host';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalCloudTaskEvidenceMemorySynchronizer,
  type CloudTaskEvidenceMemoryTransport,
} from './cloud-task-evidence-memory-sync';
import type { CloudTaskStartedExecution } from './cloud-task-control-plane';
import {
  CloudTaskMemoryCompareAndSwapError,
  sameCloudTaskMemoryCheckpoint,
  type CloudTaskMemoryAtomicMergeReceipt,
} from './cloud-task-memory-atomic-sync';
import type { RecordCloudTaskMemorySyncJournalInput } from './cloud-task-memory-sync-journal';

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
const services: EvidenceMemoryService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.teardown()));
});

describe('Cloud task memory atomic sync chaos', () => {
  it('replays the same mutation after the commit response is lost', async () => {
    const local = await createMemory();
    const remote = await createMemory();
    const server = createAtomicTransport(remote);
    const mutationIds: string[] = [];
    const journalEntries: RecordCloudTaskMemorySyncJournalInput[] = [];
    let loseResponse = true;
    const synchronizer = new LocalCloudTaskEvidenceMemorySynchronizer({
      evidenceMemory: local,
      transport: {
        ...server,
        async commitAtomicMerge(input) {
          mutationIds.push(input.request.mutationId);
          const receipt = await server.commitAtomicMerge!(input);
          if (loseResponse) {
            loseResponse = false;
            throw new TypeError('fetch failed after commit');
          }
          return receipt;
        },
      },
      recoveryPolicy: {
        jitterRatio: 0,
        sleep: async () => {},
      },
      journal: journalSink(journalEntries),
    });
    const execution = createExecution();
    const checkpoint = await recordLocalEvent(local, execution.taskId);

    const result = await synchronizer.prepareCloudRestore({
      taskId: execution.taskId,
      agentInstanceId: 'agent-1',
      execution,
      checkpoint,
      taskCredential: 'credential',
    });

    expect(result?.eventCount).toBe(1);
    expect(mutationIds).toHaveLength(2);
    expect(mutationIds[1]).toBe(mutationIds[0]);
    expect((await remote.getStats(execution.taskId)).total).toBe(1);
    expect(journalEntries).toContainEqual(
      expect.objectContaining({
        protocol: 'atomic-v1',
        idempotentReplay: true,
        status: 'synchronized',
      }),
    );
  });

  it('rebuilds the proof after a concurrent checkpoint update', async () => {
    const local = await createMemory();
    const remote = await createMemory();
    const server = createAtomicTransport(remote);
    const mutationIds: string[] = [];
    const journalEntries: RecordCloudTaskMemorySyncJournalInput[] = [];
    let injectConcurrentWriter = true;
    const synchronizer = new LocalCloudTaskEvidenceMemorySynchronizer({
      evidenceMemory: local,
      transport: {
        ...server,
        async commitAtomicMerge(input) {
          mutationIds.push(input.request.mutationId);
          if (injectConcurrentWriter) {
            injectConcurrentWriter = false;
            await remote.record({
              id: 'event-1',
              taskId: input.taskId,
              type: 'decision_recorded',
              timestamp: 10,
              payload: { decision: 'Atomic recovery.' },
            });
            throw new CloudTaskMemoryCompareAndSwapError(
              input.request.expectedRemoteCheckpoint,
              await remote.createCheckpoint(input.taskId),
            );
          }
          return await server.commitAtomicMerge!(input);
        },
      },
      recoveryPolicy: {
        jitterRatio: 0,
        sleep: async () => {},
      },
      journal: journalSink(journalEntries),
    });
    const execution = createExecution();
    const checkpoint = await recordLocalEvent(local, execution.taskId);

    const result = await synchronizer.prepareCloudRestore({
      taskId: execution.taskId,
      agentInstanceId: 'agent-1',
      execution,
      checkpoint,
      taskCredential: 'credential',
    });

    expect(result?.eventCount).toBe(1);
    expect(mutationIds).toHaveLength(2);
    expect(mutationIds[1]).not.toBe(mutationIds[0]);
    expect(journalEntries).toContainEqual(
      expect.objectContaining({
        operation: 'auto-retry',
        errorCode: 'cas-conflict',
        recoveryClass: 'concurrent-update',
        protocol: 'atomic-v1',
      }),
    );
  });

  it('converges without duplicates after a process restart loses pending state', async () => {
    const local = await createMemory();
    const remote = await createMemory();
    const server = createAtomicTransport(remote);
    const execution = createExecution();
    const checkpoint = await recordLocalEvent(local, execution.taskId);
    let loseResponse = true;
    const first = new LocalCloudTaskEvidenceMemorySynchronizer({
      evidenceMemory: local,
      transport: {
        ...server,
        async commitAtomicMerge(input) {
          const receipt = await server.commitAtomicMerge!(input);
          if (loseResponse) {
            loseResponse = false;
            throw new TypeError('connection reset after durable commit');
          }
          return receipt;
        },
      },
      recoveryPolicy: { maxAttempts: 1 },
    });

    await expect(
      first.prepareCloudRestore({
        taskId: execution.taskId,
        agentInstanceId: 'agent-1',
        execution,
        checkpoint,
        taskCredential: 'credential',
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect((await remote.getStats(execution.taskId)).total).toBe(1);

    const restarted = new LocalCloudTaskEvidenceMemorySynchronizer({
      evidenceMemory: local,
      transport: server,
    });
    const result = await restarted.prepareCloudRestore({
      taskId: execution.taskId,
      agentInstanceId: 'agent-1',
      execution,
      checkpoint,
      taskCredential: 'credential',
    });

    expect(result?.eventCount).toBe(1);
    expect((await remote.getStats(execution.taskId)).total).toBe(1);
  });
});

function createAtomicTransport(
  remote: EvidenceMemoryService,
): CloudTaskEvidenceMemoryTransport {
  const receipts = new Map<string, CloudTaskMemoryAtomicMergeReceipt>();
  return {
    async push({ taskId, batch }) {
      const result = await remote.reconcileSyncBatch({
        taskId,
        events: batch.events,
        expectedCheckpoint:
          batch.nextCursor === null ? batch.targetCheckpoint : null,
      });
      return result.checkpoint;
    },
    async pull({ taskId, cursor }) {
      return await remote.exportSyncBatch({ taskId, cursor, limit: 100 });
    },
    async resolveDivergence({ taskId }) {
      await remote.clearTask(taskId);
    },
    async commitAtomicMerge({ taskId, request }) {
      const replay = receipts.get(request.mutationId);
      if (replay) return { ...replay, replayed: true };
      const previous = await remote.createCheckpoint(taskId);
      if (
        !sameCloudTaskMemoryCheckpoint(
          previous,
          request.expectedRemoteCheckpoint,
        )
      ) {
        throw new CloudTaskMemoryCompareAndSwapError(
          request.expectedRemoteCheckpoint,
          previous,
        );
      }
      let importedEvents = 0;
      let duplicateEvents = 0;
      for (const batch of request.batches) {
        const result = await remote.reconcileSyncBatch({
          taskId,
          events: batch.events,
        });
        importedEvents += result.importedEvents;
        duplicateEvents += result.duplicateEvents;
      }
      const checkpoint = await remote.createCheckpoint(taskId);
      if (
        !sameCloudTaskMemoryCheckpoint(checkpoint, request.targetCheckpoint)
      ) {
        throw new EvidenceMemoryDivergenceError(
          checkpoint.headEventId ?? 'empty-ledger',
        );
      }
      const receipt: CloudTaskMemoryAtomicMergeReceipt = {
        version: 1,
        mutationId: request.mutationId,
        replayed: false,
        previousCheckpoint: previous,
        checkpoint,
        importedEvents,
        duplicateEvents,
        committedAt: 1_700_000_000_000,
      };
      receipts.set(request.mutationId, receipt);
      return receipt;
    },
  };
}

async function createMemory(): Promise<EvidenceMemoryService> {
  const directory = path.join(os.tmpdir(), 'memory-atomic-chaos-tests');
  await fs.mkdir(directory, { recursive: true });
  const service = await EvidenceMemoryService.createWithUrl(
    `file:${path.join(directory, `${randomUUID()}.sqlite`)}`,
    { logger, now: () => 1_700_000_000_000 },
  );
  services.push(service);
  return service;
}

async function recordLocalEvent(memory: EvidenceMemoryService, taskId: string) {
  await memory.record({
    id: 'event-1',
    taskId,
    type: 'decision_recorded',
    timestamp: 10,
    payload: { decision: 'Atomic recovery.' },
  });
  return await memory.createCheckpoint(taskId);
}

function journalSink(entries: RecordCloudTaskMemorySyncJournalInput[]) {
  return {
    async record(input: RecordCloudTaskMemorySyncJournalInput) {
      entries.push(input);
      return input as never;
    },
  };
}

function createExecution(): CloudTaskStartedExecution {
  return {
    taskId: 'task-1',
    executionId: 'execution-1',
    restoreReceiptId: 'restore-1',
    streamUrl: 'https://cloud.example/stream',
    cancelUrl: 'https://cloud.example/cancel',
    expiresAt: 1_800_000_000_000,
  };
}
