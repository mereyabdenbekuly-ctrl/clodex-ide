import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EvidenceMemoryDivergenceError,
  EvidenceMemoryFencedWriteError,
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

async function createMemory(): Promise<EvidenceMemoryService> {
  const directory = path.join(os.tmpdir(), 'teleport-evidence-memory-tests');
  await fs.mkdir(directory, { recursive: true });
  const service = await EvidenceMemoryService.createWithUrl(
    `file:${path.join(directory, `${randomUUID()}.sqlite`)}`,
    { logger, now: () => 1_700_000_000_000 },
  );
  services.push(service);
  return service;
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.teardown()));
});

describe('LocalCloudTaskEvidenceMemorySynchronizer', () => {
  it('synchronizes both handoff directions and fences the stale local writer', async () => {
    const local = await createMemory();
    const remote = await createMemory();
    const transport = createTransport(remote);
    const synchronizer = new LocalCloudTaskEvidenceMemorySynchronizer({
      evidenceMemory: local,
      transport,
      batchSize: 1,
    });
    const execution = createExecution();

    await local.record({
      id: 'local-before-teleport',
      taskId: execution.taskId,
      type: 'decision_recorded',
      timestamp: 10,
      payload: { decision: 'Keep the session checkpoint deterministic.' },
    });
    const checkpoint = await local.createCheckpoint(execution.taskId);
    await local.record({
      id: 'local-after-checkpoint',
      taskId: execution.taskId,
      type: 'context_pack_built',
      timestamp: 15,
      payload: { checkpointRace: 'captured before cloud ownership' },
    });
    const prepared = await synchronizer.prepareCloudRestore({
      taskId: execution.taskId,
      agentInstanceId: 'agent-1',
      execution,
      checkpoint: {
        checkpointId: checkpoint.checkpointId,
        eventCount: checkpoint.eventCount,
        ledgerHash: checkpoint.ledgerHash,
      },
      taskCredential: 'credential',
    });
    expect((await remote.getStats(execution.taskId)).total).toBe(2);

    const lease1 = createLease(1, 'fence-1');
    await synchronizer.activateCloudOwnership({
      taskId: execution.taskId,
      agentInstanceId: 'agent-1',
      execution,
      lease: lease1,
      checkpoint: prepared,
    });
    await expect(
      local.record({
        taskId: execution.taskId,
        type: 'decision_recorded',
        payload: { decision: 'This local writer is stale.' },
      }),
    ).rejects.toBeInstanceOf(EvidenceMemoryFencedWriteError);

    await remote.record({
      id: 'cloud-delta',
      taskId: execution.taskId,
      type: 'test_completed',
      timestamp: 20,
      payload: { command: 'pnpm test', exitCode: 0 },
    });
    const localCheckpoint = await synchronizer.synchronizeCloudToLocal({
      agentInstanceId: 'agent-1',
      execution,
      lease: lease1,
      handoff: createHandoff(),
      taskCredential: 'credential',
    });
    expect(localCheckpoint).toEqual(
      expect.objectContaining({
        eventCount: 3,
        epoch: 1,
        lastSequence: 7,
        syncState: 'synchronized',
      }),
    );

    await local.record({
      id: 'local-delta',
      taskId: execution.taskId,
      type: 'decision_recorded',
      timestamp: 30,
      payload: { decision: 'Continue locally after the barrier.' },
    });
    const resumeCheckpoint = await synchronizer.prepareResumeInCloud({
      agentInstanceId: 'agent-1',
      execution,
      handoff: createHandoff(),
      taskCredential: 'credential',
    });
    expect(resumeCheckpoint?.eventCount).toBe(4);
    expect((await remote.getStats(execution.taskId)).total).toBe(4);

    await synchronizer.activateCloudOwnership({
      taskId: execution.taskId,
      agentInstanceId: 'agent-1',
      execution,
      lease: createLease(2, 'fence-2'),
      checkpoint: resumeCheckpoint,
    });
    await expect(
      local.record({
        taskId: execution.taskId,
        type: 'decision_recorded',
        payload: { decision: 'The old local owner is fenced again.' },
      }),
    ).rejects.toBeInstanceOf(EvidenceMemoryFencedWriteError);
  });

  it('records divergence state and can explicitly keep the local ledger', async () => {
    const local = await createMemory();
    const remote = await createMemory();
    const journalEntries: Array<{
      status: string;
      resolution?: string | null;
      recoveryClass?: string | null;
      recoveryDecision?: string | null;
    }> = [];
    const synchronizer = new LocalCloudTaskEvidenceMemorySynchronizer({
      evidenceMemory: local,
      transport: createTransport(remote),
      journal: {
        async record(input) {
          journalEntries.push({
            status: input.status,
            resolution: input.resolution,
            recoveryClass: input.recoveryClass,
            recoveryDecision: input.recoveryDecision,
          });
          return input as never;
        },
      },
    });
    const execution = createExecution();
    await local.record({
      id: 'conflicting-event',
      taskId: execution.taskId,
      type: 'decision_recorded',
      payload: { decision: 'Keep local.' },
    });
    await remote.record({
      id: 'conflicting-event',
      taskId: execution.taskId,
      type: 'decision_recorded',
      payload: { decision: 'Keep cloud.' },
    });
    const checkpoint = await local.createCheckpoint(execution.taskId);

    await expect(
      synchronizer.prepareCloudRestore({
        taskId: execution.taskId,
        agentInstanceId: 'agent-1',
        execution,
        checkpoint: {
          checkpointId: checkpoint.checkpointId,
          eventCount: checkpoint.eventCount,
          ledgerHash: checkpoint.ledgerHash,
        },
        taskCredential: 'credential',
      }),
    ).rejects.toBeInstanceOf(EvidenceMemoryDivergenceError);
    expect(
      synchronizer.getCheckpointState(execution.executionId)?.syncState,
    ).toBe('diverged');
    expect(journalEntries).toContainEqual(
      expect.objectContaining({
        recoveryClass: 'content-conflict',
        recoveryDecision: 'manual',
      }),
    );

    const resolved = await synchronizer.resolveDivergence({
      strategy: 'keep-local',
      taskId: execution.taskId,
      agentInstanceId: 'agent-1',
      execution,
      lease: createLease(1, 'fence-1'),
      taskCredential: 'credential',
      lastSequence: 0,
    });
    expect(resolved.syncState).toBe('synchronized');
    expect(await remote.createCheckpoint(execution.taskId)).toEqual(
      expect.objectContaining({
        checkpointId: checkpoint.checkpointId,
        eventCount: checkpoint.eventCount,
      }),
    );
    expect(journalEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'diverged' }),
        expect.objectContaining({
          status: 'synchronized',
          resolution: 'keep-local',
        }),
      ]),
    );
  });

  it('can explicitly replace the local ledger with the cloud authority', async () => {
    const local = await createMemory();
    const remote = await createMemory();
    const synchronizer = new LocalCloudTaskEvidenceMemorySynchronizer({
      evidenceMemory: local,
      transport: createTransport(remote),
    });
    const execution = createExecution();
    await local.record({
      id: 'conflicting-event',
      taskId: execution.taskId,
      type: 'decision_recorded',
      payload: { decision: 'Local value.' },
    });
    await remote.record({
      id: 'conflicting-event',
      taskId: execution.taskId,
      type: 'decision_recorded',
      payload: { decision: 'Cloud value.' },
    });

    const resolved = await synchronizer.resolveDivergence({
      strategy: 'accept-cloud',
      taskId: execution.taskId,
      agentInstanceId: 'agent-1',
      execution,
      lease: createLease(1, 'fence-1'),
      taskCredential: 'credential',
      lastSequence: 4,
    });

    expect(resolved).toEqual(
      expect.objectContaining({
        eventCount: 1,
        lastSequence: 4,
        syncState: 'synchronized',
      }),
    );
    expect(await local.list({ taskId: execution.taskId })).toEqual([
      expect.objectContaining({
        id: 'conflicting-event',
        payload: { decision: 'Cloud value.' },
      }),
    ]);
  });

  it('automatically merges ledgers only when every shared event is identical', async () => {
    const local = await createMemory();
    const remote = await createMemory();
    const journalEntries: RecordCloudTaskMemorySyncJournalInput[] = [];
    const synchronizer = new LocalCloudTaskEvidenceMemorySynchronizer({
      evidenceMemory: local,
      transport: createTransport(remote),
      journal: {
        async record(input) {
          journalEntries.push(input);
          return input as never;
        },
      },
    });
    const execution = createExecution();
    await local.record({
      id: 'local-only',
      taskId: execution.taskId,
      type: 'decision_recorded',
      timestamp: 10,
      payload: { decision: 'Local append.' },
    });
    await remote.record({
      id: 'cloud-only',
      taskId: execution.taskId,
      type: 'test_completed',
      timestamp: 20,
      payload: { command: 'pnpm test', exitCode: 0 },
    });
    const checkpoint = await local.createCheckpoint(execution.taskId);

    const result = await synchronizer.prepareCloudRestore({
      taskId: execution.taskId,
      agentInstanceId: 'agent-1',
      execution,
      checkpoint,
      taskCredential: 'credential',
    });

    expect(result).toEqual(
      expect.objectContaining({
        eventCount: 2,
        syncState: 'synchronized',
      }),
    );
    expect(await local.createCheckpoint(execution.taskId)).toEqual(
      expect.objectContaining({
        checkpointId: result?.checkpointId,
        eventCount: 2,
      }),
    );
    expect(await remote.createCheckpoint(execution.taskId)).toEqual(
      expect.objectContaining({
        checkpointId: result?.checkpointId,
        eventCount: 2,
      }),
    );
    expect(journalEntries).toContainEqual(
      expect.objectContaining({
        operation: 'auto-resolve-divergence',
        recoveryClass: 'append-only',
        recoveryDecision: 'merge-non-conflicting',
        automatic: true,
      }),
    );
  });

  it('automatically retries transient transport failures with backoff', async () => {
    const local = await createMemory();
    const remote = await createMemory();
    const transport = createTransport(remote);
    const delays: number[] = [];
    const journalEntries: RecordCloudTaskMemorySyncJournalInput[] = [];
    let failuresRemaining = 2;
    const synchronizer = new LocalCloudTaskEvidenceMemorySynchronizer({
      evidenceMemory: local,
      transport: {
        ...transport,
        async commitAtomicMerge(input) {
          if (failuresRemaining > 0) {
            failuresRemaining -= 1;
            throw new TypeError('fetch failed');
          }
          return await transport.commitAtomicMerge!(input);
        },
      },
      recoveryPolicy: {
        baseDelayMs: 100,
        jitterRatio: 0,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
      journal: {
        async record(input) {
          journalEntries.push(input);
          return input as never;
        },
      },
    });
    const execution = createExecution();
    await local.record({
      id: 'retry-event',
      taskId: execution.taskId,
      type: 'decision_recorded',
      payload: { decision: 'Retry safely.' },
    });
    const checkpoint = await local.createCheckpoint(execution.taskId);

    const result = await synchronizer.prepareCloudRestore({
      taskId: execution.taskId,
      agentInstanceId: 'agent-1',
      execution,
      checkpoint,
      taskCredential: 'credential',
    });

    expect(result?.syncState).toBe('synchronized');
    expect(delays).toEqual([100, 200]);
    expect(
      journalEntries.filter((entry) => entry.operation === 'auto-retry'),
    ).toEqual([
      expect.objectContaining({
        recoveryClass: 'transient',
        recoveryDecision: 'retry',
        backoffMs: 100,
      }),
      expect.objectContaining({
        recoveryClass: 'transient',
        recoveryDecision: 'retry',
        backoffMs: 200,
      }),
    ]);
  });
});

function createTransport(
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
      return {
        checkpointId: result.checkpoint.checkpointId,
        eventCount: result.checkpoint.eventCount,
      };
    },
    async pull({ taskId, cursor }) {
      return await remote.exportSyncBatch({ taskId, cursor, limit: 1 });
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

function createLease(epoch: number, fencingToken: string) {
  return {
    leaseId: `lease-${epoch}`,
    taskId: 'task-1',
    executionId: 'execution-1',
    restoreReceiptId: 'restore-1',
    holderId: 'desktop',
    epoch,
    fencingToken,
    acquiredAt: 1_700_000_000_000,
    expiresAt: 1_700_000_060_000,
  };
}

function createHandoff() {
  return {
    handoffId: 'handoff-1',
    taskId: 'task-1',
    executionId: 'execution-1',
    restoreReceiptId: 'restore-1',
    sourceLeaseId: 'lease-1',
    sourceEpoch: 1,
    suspendedAtSequence: 7,
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_060_000,
  };
}
