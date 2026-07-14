import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EvidenceMemoryFencedWriteError,
  EvidenceMemoryService,
} from '@clodex/agent-core/evidence-memory';
import type { Logger } from '@clodex/agent-core/host';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CloudTaskMemoryCompareAndSwapError,
  type CloudTaskMemoryAtomicMergeRequest,
} from './cloud-task-memory-atomic-sync';
import {
  CloudTaskMemoryIdempotencyConflictError,
  SqliteCloudTaskMemoryAtomicLedger,
} from './cloud-task-memory-atomic-ledger';
import {
  LocalCloudTaskEvidenceMemorySynchronizer,
  type CloudTaskEvidenceMemoryTransport,
} from './cloud-task-evidence-memory-sync';
import type { CloudTaskStartedExecution } from './cloud-task-control-plane';

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
const services: EvidenceMemoryService[] = [];
const ledgers: SqliteCloudTaskMemoryAtomicLedger[] = [];
const directories: string[] = [];
const WINDOWS_CLEANUP_DEADLINE_MS = 10_000;

afterEach(async () => {
  // libSQL's native Windows teardown can retain a file handle when multiple
  // clients close concurrently. Serialize every close before removing its
  // isolated data directory so the hook cannot deadlock or race directory
  // deletion.
  for (const ledger of ledgers.splice(0)) await ledger.close();
  for (const service of services.splice(0)) await service.teardown();
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

describe('SqliteCloudTaskMemoryAtomicLedger', () => {
  it('persists immutable idempotency receipts across restart', async () => {
    const { url } = await createLedgerUrl();
    const local = await createMemory();
    const first = await createLedger(url);
    const request = await createRequest(local, first, 'mutation-1', 'event-1');

    const committed = await first.commit(request);
    expect(committed.replayed).toBe(false);
    await first.close();
    ledgers.splice(ledgers.indexOf(first), 1);

    const restarted = await createLedger(url);
    const replayed = await restarted.commit(request);
    expect(replayed).toEqual(
      expect.objectContaining({
        mutationId: 'mutation-1',
        replayed: true,
        checkpoint: committed.checkpoint,
      }),
    );
    expect(await restarted.getCheckpoint('task-1')).toEqual(
      committed.checkpoint,
    );
  });

  it('rolls back inserted events when a crash happens before receipt commit', async () => {
    const { url } = await createLedgerUrl();
    const local = await createMemory();
    const ledger = await createLedger(url, {
      faultInjector() {
        throw new Error('simulated process crash');
      },
    });
    const before = await ledger.getCheckpoint('task-1');
    const request = await createRequest(
      local,
      ledger,
      'mutation-crash',
      'event-1',
    );

    await expect(ledger.commit(request)).rejects.toThrow(
      'simulated process crash',
    );

    expect(await ledger.getCheckpoint('task-1')).toEqual(before);
  });

  it('rejects reuse of a mutation id with different content', async () => {
    const { url } = await createLedgerUrl();
    const firstMemory = await createMemory();
    const secondMemory = await createMemory();
    const ledger = await createLedger(url);
    const first = await createRequest(
      firstMemory,
      ledger,
      'mutation-reused',
      'event-1',
    );
    await ledger.commit(first);
    const different = await createRequest(
      secondMemory,
      ledger,
      'mutation-reused',
      'event-2',
    );

    await expect(ledger.commit(different)).rejects.toBeInstanceOf(
      CloudTaskMemoryIdempotencyConflictError,
    );
    expect((await ledger.getCheckpoint('task-1')).eventCount).toBe(1);
  });

  it('allows only one writer to win the same checkpoint CAS', async () => {
    const { url } = await createLedgerUrl();
    const leftMemory = await createMemory();
    const rightMemory = await createMemory();
    const ledger = await createLedger(url);
    const left = await createRequest(
      leftMemory,
      ledger,
      'mutation-left',
      'event-left',
    );
    const right = await createRequest(
      rightMemory,
      ledger,
      'mutation-right',
      'event-right',
    );

    const results = await Promise.allSettled([
      ledger.commit(left),
      ledger.commit(right),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(CloudTaskMemoryCompareAndSwapError);
    expect((await ledger.getCheckpoint('task-1')).eventCount).toBe(1);
  });

  it('rejects stale epochs and invalid fencing tokens', async () => {
    const { url } = await createLedgerUrl();
    const local = await createMemory();
    const ledger = await createLedger(url);
    await ledger.activateAuthority('task-1', {
      epoch: 2,
      fencingTokenHash: 'a'.repeat(64),
    });
    const request = await createRequest(
      local,
      ledger,
      'mutation-fenced',
      'event-1',
    );

    await expect(
      ledger.commit(request, {
        epoch: 1,
        fencingTokenHash: 'a'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(EvidenceMemoryFencedWriteError);
    await expect(
      ledger.commit(request, {
        epoch: 2,
        fencingTokenHash: 'b'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(EvidenceMemoryFencedWriteError);
    expect((await ledger.getCheckpoint('task-1')).eventCount).toBe(0);
  });

  it('runs the synchronizer end-to-end against the durable transaction store', async () => {
    const { url } = await createLedgerUrl();
    const local = await createMemory();
    const ledger = await createLedger(url);
    const execution = createExecution();
    const baseTransport = createLedgerTransport(ledger);
    let loseFirstResponse = true;
    const synchronizer = new LocalCloudTaskEvidenceMemorySynchronizer({
      evidenceMemory: local,
      transport: {
        ...baseTransport,
        async commitAtomicMerge(input) {
          const receipt = await baseTransport.commitAtomicMerge!(input);
          if (loseFirstResponse) {
            loseFirstResponse = false;
            throw new TypeError('response lost after transaction commit');
          }
          return receipt;
        },
      },
      recoveryPolicy: {
        jitterRatio: 0,
        sleep: async () => {},
      },
    });
    await local.record({
      id: 'e2e-event',
      taskId: execution.taskId,
      type: 'decision_recorded',
      timestamp: 10,
      payload: { decision: 'Use the durable transaction store.' },
    });
    const checkpoint = await local.createCheckpoint(execution.taskId);

    const result = await synchronizer.prepareCloudRestore({
      taskId: execution.taskId,
      agentInstanceId: 'agent-1',
      execution,
      checkpoint,
      taskCredential: 'credential',
    });

    expect(result?.eventCount).toBe(1);
    expect(await ledger.getCheckpoint(execution.taskId)).toEqual({
      checkpointId: result?.checkpointId,
      eventCount: 1,
    });
  });
});

async function createRequest(
  memory: EvidenceMemoryService,
  ledger: SqliteCloudTaskMemoryAtomicLedger,
  mutationId: string,
  eventId: string,
): Promise<CloudTaskMemoryAtomicMergeRequest> {
  await memory.record({
    id: eventId,
    taskId: 'task-1',
    type: 'decision_recorded',
    timestamp: 10,
    payload: { decision: eventId },
  });
  const batch = await memory.exportSyncBatch({ taskId: 'task-1' });
  return {
    version: 1,
    mutationId,
    taskId: 'task-1',
    expectedRemoteCheckpoint: await ledger.getCheckpoint('task-1'),
    targetCheckpoint: {
      checkpointId: batch.targetCheckpoint.checkpointId,
      eventCount: batch.targetCheckpoint.eventCount,
    },
    batches: [batch],
  };
}

async function createMemory(): Promise<EvidenceMemoryService> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'atomic-ledger-memory-tests-'),
  );
  directories.push(directory);
  const service = await EvidenceMemoryService.createWithUrl(
    `file:${path.join(directory, `${randomUUID()}.sqlite`)}`,
    { logger, now: () => 1_700_000_000_000 },
  );
  services.push(service);
  return service;
}

async function createLedgerUrl(): Promise<{ url: string }> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'atomic-ledger-tests-'),
  );
  directories.push(directory);
  return { url: `file:${path.join(directory, 'ledger.sqlite')}` };
}

async function removeTestDirectory(directory: string): Promise<void> {
  const removal = fs
    .rm(directory, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 10 : 0,
      retryDelay: 100,
    })
    .then(
      () => ({ status: 'removed' as const }),
      (error: unknown) => ({ status: 'failed' as const, error }),
    );
  if (process.platform !== 'win32') {
    const result = await removal;
    if (result.status === 'failed') throw result.error;
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    removal,
    new Promise<{ status: 'deferred' }>((resolve) => {
      timeout = setTimeout(
        () => resolve({ status: 'deferred' }),
        WINDOWS_CLEANUP_DEADLINE_MS,
      );
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (result.status === 'failed') throw result.error;
  if (result.status === 'deferred') {
    // The isolated temp directory cannot affect later tests. Keep the native
    // request observed through `removal`, but do not let an unbounded Windows
    // filesystem operation consume Vitest's entire hook timeout.
    console.warn('[atomic-ledger-test] deferred Windows temp cleanup');
  }
}

async function createLedger(
  url: string,
  options: Parameters<
    typeof SqliteCloudTaskMemoryAtomicLedger.createWithUrl
  >[1] = {},
): Promise<SqliteCloudTaskMemoryAtomicLedger> {
  const ledger = await SqliteCloudTaskMemoryAtomicLedger.createWithUrl(url, {
    now: () => 1_700_000_000_000,
    ...options,
  });
  ledgers.push(ledger);
  return ledger;
}

function createLedgerTransport(
  ledger: SqliteCloudTaskMemoryAtomicLedger,
): CloudTaskEvidenceMemoryTransport {
  return {
    async push() {
      throw new Error('Legacy push must not be used');
    },
    async pull({ taskId, cursor }) {
      return await ledger.pull({ taskId, cursor });
    },
    async resolveDivergence({ taskId }) {
      await ledger.clearTask(taskId);
    },
    async commitAtomicMerge({ request }) {
      return await ledger.commit(request);
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
