import { createHash } from 'node:crypto';
import {
  buildEvidenceMemoryCheckpoint,
  compareEvidenceMemoryEvents,
  EvidenceMemoryDivergenceError,
  EvidenceMemoryFencedWriteError,
  normalizeSyncEvent,
  sameSynchronizedEvent,
  type EvidenceMemoryEvent,
  type EvidenceMemorySyncBatch,
  type EvidenceMemorySyncCursor,
} from '@clodex/agent-core/evidence-memory';
import { createClient, type Client, type Transaction } from '@libsql/client';
import {
  CloudTaskMemoryCompareAndSwapError,
  sameCloudTaskMemoryCheckpoint,
  type CloudTaskMemoryAtomicMergeReceipt,
  type CloudTaskMemoryAtomicMergeRequest,
  type CloudTaskMemoryCheckpointIdentity,
} from './cloud-task-memory-atomic-sync';

const MAX_BATCHES = 1_000;
const MAX_EVENTS = 50_000;
const DEFAULT_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60_000;

export class CloudTaskMemoryIdempotencyConflictError extends Error {
  public constructor(public readonly mutationId: string) {
    super('Cloud evidence memory mutation id was reused with different input');
    this.name = 'CloudTaskMemoryIdempotencyConflictError';
  }
}

export interface CloudTaskMemoryAtomicCommitAuthority {
  epoch: number;
  fencingTokenHash: string;
}

/**
 * Durable reference implementation of the cloud-side atomic-v1 ledger.
 *
 * It is intentionally transport-neutral: an HTTP service can validate task
 * credentials and lease headers, then delegate the transactional mutation to
 * this class.
 */
export class SqliteCloudTaskMemoryAtomicLedger {
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly client: Client,
    private readonly now: () => number,
    private readonly receiptRetentionMs: number,
    private readonly faultInjector:
      | ((point: 'after-events-before-receipt') => void | Promise<void>)
      | undefined,
  ) {}

  public static async createWithUrl(
    url: string,
    options: {
      now?: () => number;
      receiptRetentionMs?: number;
      faultInjector?: (
        point: 'after-events-before-receipt',
      ) => void | Promise<void>;
    } = {},
  ): Promise<SqliteCloudTaskMemoryAtomicLedger> {
    const receiptRetentionMs =
      options.receiptRetentionMs ?? DEFAULT_RECEIPT_RETENTION_MS;
    if (
      !Number.isSafeInteger(receiptRetentionMs) ||
      receiptRetentionMs < 60_000
    ) {
      throw new Error('Atomic memory receipt retention is invalid');
    }
    const client = createClient({ url });
    await client.executeMultiple(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cloud_task_memory_events (
        task_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_timestamp INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (task_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS cloud_task_memory_events_order
        ON cloud_task_memory_events(task_id, event_timestamp, event_id);
      CREATE TABLE IF NOT EXISTS cloud_task_memory_receipts (
        task_id TEXT NOT NULL,
        mutation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        committed_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, mutation_id)
      );
      CREATE INDEX IF NOT EXISTS cloud_task_memory_receipts_retention
        ON cloud_task_memory_receipts(committed_at);
      CREATE TABLE IF NOT EXISTS cloud_task_memory_authority (
        task_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        fencing_token_hash TEXT NOT NULL
      );
    `);
    return new SqliteCloudTaskMemoryAtomicLedger(
      client,
      options.now ?? Date.now,
      receiptRetentionMs,
      options.faultInjector,
    );
  }

  public async activateAuthority(
    taskId: string,
    authority: CloudTaskMemoryAtomicCommitAuthority,
  ): Promise<void> {
    await this.enqueueWrite(
      async () => await this.activateAuthorityTransaction(taskId, authority),
    );
  }

  private async activateAuthorityTransaction(
    taskId: string,
    authority: CloudTaskMemoryAtomicCommitAuthority,
  ): Promise<void> {
    validateTaskId(taskId);
    validateAuthority(authority);
    const transaction = await this.client.transaction('write');
    try {
      const current = await readAuthority(transaction, taskId);
      if (current) {
        if (authority.epoch < current.epoch) {
          throw new EvidenceMemoryFencedWriteError('stale-epoch');
        }
        if (
          authority.epoch === current.epoch &&
          authority.fencingTokenHash !== current.fencingTokenHash
        ) {
          throw new EvidenceMemoryFencedWriteError('ownership-conflict');
        }
      }
      await transaction.execute({
        sql: `
          INSERT INTO cloud_task_memory_authority (
            task_id, epoch, fencing_token_hash
          ) VALUES (?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            epoch = excluded.epoch,
            fencing_token_hash = excluded.fencing_token_hash
        `,
        args: [taskId, authority.epoch, authority.fencingTokenHash],
      });
      await transaction.commit();
    } catch (error) {
      await rollbackQuietly(transaction);
      throw error;
    } finally {
      transaction.close();
    }
  }

  public async commit(
    request: CloudTaskMemoryAtomicMergeRequest,
    authority?: CloudTaskMemoryAtomicCommitAuthority,
  ): Promise<CloudTaskMemoryAtomicMergeReceipt> {
    return await this.enqueueWrite(
      async () => await this.commitTransaction(request, authority),
    );
  }

  private async commitTransaction(
    request: CloudTaskMemoryAtomicMergeRequest,
    authority?: CloudTaskMemoryAtomicCommitAuthority,
  ): Promise<CloudTaskMemoryAtomicMergeReceipt> {
    const normalized = normalizeAtomicRequest(request);
    if (authority) validateAuthority(authority);
    const requestHash = hashAtomicRequest(normalized);
    const transaction = await this.client.transaction('write');
    try {
      await assertAuthority(transaction, normalized.taskId, authority);
      const replay = await readReceipt(
        transaction,
        normalized.taskId,
        normalized.mutationId,
      );
      if (replay) {
        if (replay.requestHash !== requestHash) {
          throw new CloudTaskMemoryIdempotencyConflictError(
            normalized.mutationId,
          );
        }
        await transaction.rollback();
        return { ...replay.receipt, replayed: true };
      }

      const currentEvents = await readEvents(transaction, normalized.taskId);
      const previous = buildEvidenceMemoryCheckpoint(
        normalized.taskId,
        currentEvents,
        this.now(),
      );
      if (
        !sameCloudTaskMemoryCheckpoint(
          previous,
          normalized.expectedRemoteCheckpoint,
        )
      ) {
        throw new CloudTaskMemoryCompareAndSwapError(
          normalized.expectedRemoteCheckpoint,
          previous,
        );
      }

      const merged = new Map(
        currentEvents.map((event) => [event.id, event] as const),
      );
      const imported: EvidenceMemoryEvent[] = [];
      let duplicateEvents = 0;
      for (const event of normalized.events) {
        const existing = merged.get(event.id);
        if (existing) {
          if (!sameSynchronizedEvent(existing, event)) {
            throw new EvidenceMemoryDivergenceError(event.id);
          }
          duplicateEvents += 1;
          continue;
        }
        merged.set(event.id, event);
        imported.push(event);
      }
      const checkpoint = buildEvidenceMemoryCheckpoint(
        normalized.taskId,
        [...merged.values()],
        this.now(),
      );
      if (
        !sameCloudTaskMemoryCheckpoint(checkpoint, normalized.targetCheckpoint)
      ) {
        throw new EvidenceMemoryDivergenceError(
          checkpoint.headEventId ?? 'empty-ledger',
          'Atomic evidence memory target checkpoint did not converge',
        );
      }

      if (imported.length > 0) {
        await transaction.batch(
          imported.map((event) => ({
            sql: `
              INSERT INTO cloud_task_memory_events (
                task_id, event_id, event_timestamp, event_json
              ) VALUES (?, ?, ?, ?)
            `,
            args: [
              normalized.taskId,
              event.id,
              event.timestamp,
              JSON.stringify(event),
            ],
          })),
        );
      }
      await this.faultInjector?.('after-events-before-receipt');
      const committedAt = this.now();
      const receipt: CloudTaskMemoryAtomicMergeReceipt = {
        version: 1,
        mutationId: normalized.mutationId,
        replayed: false,
        previousCheckpoint: toCheckpointIdentity(previous),
        checkpoint: toCheckpointIdentity(checkpoint),
        importedEvents: imported.length,
        duplicateEvents,
        committedAt,
      };
      await transaction.execute({
        sql: `
          INSERT INTO cloud_task_memory_receipts (
            task_id, mutation_id, request_hash, receipt_json, committed_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
        args: [
          normalized.taskId,
          normalized.mutationId,
          requestHash,
          JSON.stringify(receipt),
          committedAt,
        ],
      });
      await transaction.execute({
        sql: 'DELETE FROM cloud_task_memory_receipts WHERE committed_at < ?',
        args: [committedAt - this.receiptRetentionMs],
      });
      await transaction.commit();
      return receipt;
    } catch (error) {
      await rollbackQuietly(transaction);
      throw error;
    } finally {
      transaction.close();
    }
  }

  public async pull(input: {
    taskId: string;
    cursor?: EvidenceMemorySyncCursor | null;
    limit?: number;
  }): Promise<EvidenceMemorySyncBatch> {
    validateTaskId(input.taskId);
    const limit = input.limit ?? 500;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Atomic memory pull limit is invalid');
    }
    const events = await this.readAllEvents(input.taskId);
    const eligible = input.cursor
      ? events.filter(
          (event) =>
            event.timestamp > input.cursor!.timestamp ||
            (event.timestamp === input.cursor!.timestamp &&
              event.id.localeCompare(input.cursor!.eventId) > 0),
        )
      : events;
    const selected = eligible.slice(0, limit);
    const nextCursor =
      eligible.length > selected.length && selected.length > 0
        ? {
            timestamp: selected.at(-1)!.timestamp,
            eventId: selected.at(-1)!.id,
          }
        : null;
    const baseEvents = input.cursor
      ? events.filter(
          (event) =>
            event.timestamp < input.cursor!.timestamp ||
            (event.timestamp === input.cursor!.timestamp &&
              event.id.localeCompare(input.cursor!.eventId) <= 0),
        )
      : [];
    return {
      version: 1,
      taskId: input.taskId,
      baseCheckpoint: buildEvidenceMemoryCheckpoint(
        input.taskId,
        baseEvents,
        this.now(),
      ),
      targetCheckpoint: buildEvidenceMemoryCheckpoint(
        input.taskId,
        events,
        this.now(),
      ),
      events: selected.map((event) => ({ version: 1, event })),
      nextCursor,
    };
  }

  public async getCheckpoint(
    taskId: string,
  ): Promise<CloudTaskMemoryCheckpointIdentity> {
    validateTaskId(taskId);
    return toCheckpointIdentity(
      buildEvidenceMemoryCheckpoint(
        taskId,
        await this.readAllEvents(taskId),
        this.now(),
      ),
    );
  }

  public async clearTask(taskId: string): Promise<void> {
    validateTaskId(taskId);
    await this.enqueueWrite(
      async () =>
        await this.client.batch(
          [
            {
              sql: 'DELETE FROM cloud_task_memory_events WHERE task_id = ?',
              args: [taskId],
            },
            {
              sql: 'DELETE FROM cloud_task_memory_receipts WHERE task_id = ?',
              args: [taskId],
            },
          ],
          'write',
        ),
    );
  }

  public close(): void {
    this.client.close();
  }

  private async readAllEvents(taskId: string): Promise<EvidenceMemoryEvent[]> {
    const result = await this.client.execute({
      sql: `
        SELECT event_json
        FROM cloud_task_memory_events
        WHERE task_id = ?
        ORDER BY event_timestamp ASC, event_id ASC
      `,
      args: [taskId],
    });
    return result.rows.map((row) =>
      normalizeSyncEvent(JSON.parse(String(row.event_json))),
    );
  }

  private async enqueueWrite<T>(action: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(action);
    this.writeQueue = result.then(
      () => {},
      () => {},
    );
    return await result;
  }
}

function normalizeAtomicRequest(request: CloudTaskMemoryAtomicMergeRequest): {
  taskId: string;
  mutationId: string;
  expectedRemoteCheckpoint: CloudTaskMemoryCheckpointIdentity;
  targetCheckpoint: CloudTaskMemoryCheckpointIdentity;
  batches: EvidenceMemorySyncBatch[];
  events: EvidenceMemoryEvent[];
} {
  if (
    request.version !== 1 ||
    !Array.isArray(request.batches) ||
    request.batches.length < 1 ||
    request.batches.length > MAX_BATCHES
  ) {
    throw new Error('Atomic memory merge request is invalid');
  }
  validateTaskId(request.taskId);
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(request.mutationId)) {
    throw new Error('Atomic memory mutation id is invalid');
  }
  validateCheckpoint(request.expectedRemoteCheckpoint);
  validateCheckpoint(request.targetCheckpoint);
  const events: EvidenceMemoryEvent[] = [];
  let targetCheckpointId: string | null = null;
  for (const batch of request.batches) {
    if (
      batch.version !== 1 ||
      batch.taskId !== request.taskId ||
      batch.baseCheckpoint.taskId !== request.taskId ||
      batch.targetCheckpoint.taskId !== request.taskId ||
      !sameCloudTaskMemoryCheckpoint(
        batch.targetCheckpoint,
        request.targetCheckpoint,
      )
    ) {
      throw new Error('Atomic memory batch binding is invalid');
    }
    targetCheckpointId ??= batch.targetCheckpoint.checkpointId;
    if (batch.targetCheckpoint.checkpointId !== targetCheckpointId) {
      throw new Error('Atomic memory batches have different targets');
    }
    for (const envelope of batch.events) {
      if (envelope.version !== 1 || envelope.event.taskId !== request.taskId) {
        throw new Error('Atomic memory event envelope is invalid');
      }
      events.push(normalizeSyncEvent(envelope.event));
      if (events.length > MAX_EVENTS) {
        throw new Error('Atomic memory event limit exceeded');
      }
    }
  }
  return {
    taskId: request.taskId,
    mutationId: request.mutationId,
    expectedRemoteCheckpoint: { ...request.expectedRemoteCheckpoint },
    targetCheckpoint: { ...request.targetCheckpoint },
    batches: request.batches,
    events: events.sort(compareEvidenceMemoryEvents),
  };
}

async function readEvents(
  transaction: Transaction,
  taskId: string,
): Promise<EvidenceMemoryEvent[]> {
  const result = await transaction.execute({
    sql: `
      SELECT event_json
      FROM cloud_task_memory_events
      WHERE task_id = ?
      ORDER BY event_timestamp ASC, event_id ASC
    `,
    args: [taskId],
  });
  return result.rows.map((row) =>
    normalizeSyncEvent(JSON.parse(String(row.event_json))),
  );
}

async function readReceipt(
  transaction: Transaction,
  taskId: string,
  mutationId: string,
): Promise<{
  requestHash: string;
  receipt: CloudTaskMemoryAtomicMergeReceipt;
} | null> {
  const result = await transaction.execute({
    sql: `
      SELECT request_hash, receipt_json
      FROM cloud_task_memory_receipts
      WHERE task_id = ? AND mutation_id = ?
    `,
    args: [taskId, mutationId],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    requestHash: String(row.request_hash),
    receipt: JSON.parse(String(row.receipt_json)),
  };
}

async function readAuthority(
  transaction: Transaction,
  taskId: string,
): Promise<CloudTaskMemoryAtomicCommitAuthority | null> {
  const result = await transaction.execute({
    sql: `
      SELECT epoch, fencing_token_hash
      FROM cloud_task_memory_authority
      WHERE task_id = ?
    `,
    args: [taskId],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    epoch: Number(row.epoch),
    fencingTokenHash: String(row.fencing_token_hash),
  };
}

async function assertAuthority(
  transaction: Transaction,
  taskId: string,
  supplied: CloudTaskMemoryAtomicCommitAuthority | undefined,
): Promise<void> {
  const current = await readAuthority(transaction, taskId);
  if (!current) {
    if (supplied) {
      throw new EvidenceMemoryFencedWriteError('ownership-conflict');
    }
    return;
  }
  if (!supplied || supplied.epoch < current.epoch) {
    throw new EvidenceMemoryFencedWriteError('stale-epoch');
  }
  if (
    supplied.epoch !== current.epoch ||
    supplied.fencingTokenHash !== current.fencingTokenHash
  ) {
    throw new EvidenceMemoryFencedWriteError('invalid-fence');
  }
}

function validateAuthority(
  authority: CloudTaskMemoryAtomicCommitAuthority,
): void {
  if (!Number.isSafeInteger(authority.epoch) || authority.epoch < 1) {
    throw new Error('Atomic memory authority epoch is invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(authority.fencingTokenHash)) {
    throw new Error('Atomic memory fencing token hash is invalid');
  }
}

function validateCheckpoint(
  checkpoint: CloudTaskMemoryCheckpointIdentity,
): void {
  if (
    !/^[A-Za-z0-9._:-]{1,200}$/.test(checkpoint.checkpointId) ||
    !Number.isSafeInteger(checkpoint.eventCount) ||
    checkpoint.eventCount < 0
  ) {
    throw new Error('Atomic memory checkpoint is invalid');
  }
}

function validateTaskId(taskId: string): void {
  if (
    typeof taskId !== 'string' ||
    taskId.length < 1 ||
    taskId.length > 4_096 ||
    taskId.includes('\0')
  ) {
    throw new Error('Atomic memory task id is invalid');
  }
}

function hashAtomicRequest(request: {
  taskId: string;
  mutationId: string;
  expectedRemoteCheckpoint: CloudTaskMemoryCheckpointIdentity;
  targetCheckpoint: CloudTaskMemoryCheckpointIdentity;
  events: EvidenceMemoryEvent[];
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        taskId: request.taskId,
        mutationId: request.mutationId,
        expectedRemoteCheckpoint: request.expectedRemoteCheckpoint,
        targetCheckpoint: request.targetCheckpoint,
        events: request.events,
      }),
    )
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function toCheckpointIdentity(
  checkpoint: CloudTaskMemoryCheckpointIdentity,
): CloudTaskMemoryCheckpointIdentity {
  return {
    checkpointId: checkpoint.checkpointId,
    eventCount: checkpoint.eventCount,
  };
}

async function rollbackQuietly(transaction: Transaction): Promise<void> {
  try {
    await transaction.rollback();
  } catch {
    // The transaction may already be closed after a successful rollback.
  }
}
