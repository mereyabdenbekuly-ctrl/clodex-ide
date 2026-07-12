import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CloudTaskMemoryDivergenceResolution,
  CloudTaskMemoryRecoveryClass,
  CloudTaskMemoryRecoveryDecision,
  CloudTaskMemorySyncDiagnosticsExport,
  CloudTaskMemorySyncDirection,
  CloudTaskMemorySyncErrorCode,
  CloudTaskMemorySyncJournalEntry,
  CloudTaskMemorySyncOperation,
  CloudTaskMemorySyncStatus,
} from '@shared/cloud-task-memory-sync';
import { cloudTaskMemorySyncOperations } from '@shared/cloud-task-memory-sync';

const JOURNAL_VERSION = 1;
const MAX_ENTRIES = 1_000;
const MAX_FILE_BYTES = 1024 * 1024;

export interface RecordCloudTaskMemorySyncJournalInput {
  taskId: string;
  agentInstanceId: string;
  executionId: string;
  operation: CloudTaskMemorySyncOperation;
  direction: CloudTaskMemorySyncDirection;
  status: CloudTaskMemorySyncStatus;
  epoch?: number | null;
  checkpointId?: string | null;
  eventCount?: number | null;
  importedEvents?: number | null;
  duplicateEvents?: number | null;
  divergenceEventIdHash?: string | null;
  errorCode?: CloudTaskMemorySyncErrorCode | null;
  resolution?: CloudTaskMemoryDivergenceResolution | null;
  recoveryClass?: CloudTaskMemoryRecoveryClass | null;
  recoveryDecision?: CloudTaskMemoryRecoveryDecision | null;
  automatic?: boolean;
  backoffMs?: number | null;
  protocol?: 'legacy' | 'atomic-v1' | null;
  idempotentReplay?: boolean;
  attempt?: number;
  startedAt: number;
  finishedAt: number;
}

interface PersistedJournal {
  version: typeof JOURNAL_VERSION;
  entries: CloudTaskMemorySyncJournalEntry[];
}

/**
 * Durable, content-free observability ledger. No prompts, paths, event
 * payloads, ledger hashes, credentials, lease IDs, or fencing tokens are
 * accepted by its schema.
 */
export class FileSystemCloudTaskMemorySyncJournal {
  private entries: CloudTaskMemorySyncJournalEntry[] = [];
  private writeQueue = Promise.resolve();
  private initialized = false;

  public constructor(
    private readonly options: {
      filePath: string;
      now?: () => number;
      idGenerator?: () => string;
    },
  ) {}

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const content = await readFile(this.options.filePath, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return;
      const parsed = JSON.parse(content) as Partial<PersistedJournal>;
      if (
        parsed.version !== JOURNAL_VERSION ||
        !Array.isArray(parsed.entries)
      ) {
        return;
      }
      this.entries = parsed.entries
        .map(parseJournalEntry)
        .filter(
          (entry): entry is CloudTaskMemorySyncJournalEntry => entry !== null,
        )
        .slice(-MAX_ENTRIES);
    } catch {
      this.entries = [];
    }
  }

  public async record(
    input: RecordCloudTaskMemorySyncJournalInput,
  ): Promise<CloudTaskMemorySyncJournalEntry> {
    await this.initialize();
    const entry = normalizeJournalEntry(input, {
      id: (this.options.idGenerator ?? randomUUID)(),
      now: (this.options.now ?? Date.now)(),
    });
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.writeQueue = this.writeQueue.then(async () => {
      await this.persist();
    });
    await this.writeQueue;
    return structuredClone(entry);
  }

  public listForAgent(
    agentInstanceId: string,
    limit = 20,
  ): CloudTaskMemorySyncJournalEntry[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('Memory sync journal limit is invalid');
    }
    return this.entries
      .filter((entry) => entry.agentInstanceId === agentInstanceId)
      .slice(-limit)
      .reverse()
      .map((entry) => structuredClone(entry));
  }

  public exportForAgent(
    agentInstanceId: string,
  ): CloudTaskMemorySyncDiagnosticsExport {
    return {
      format: 'clodex-memory-sync-diagnostics',
      version: 1,
      exportedAt: (this.options.now ?? Date.now)(),
      agentInstanceId,
      entries: this.listForAgent(agentInstanceId, 100),
    };
  }

  public async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async persist(): Promise<void> {
    const filePath = path.resolve(this.options.filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(
      temporaryPath,
      JSON.stringify({
        version: JOURNAL_VERSION,
        entries: this.entries,
      } satisfies PersistedJournal),
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporaryPath, filePath);
  }
}

function normalizeJournalEntry(
  input: RecordCloudTaskMemorySyncJournalInput,
  generated: { id: string; now: number },
): CloudTaskMemorySyncJournalEntry {
  const startedAt = normalizeTimestamp(input.startedAt, 'start time');
  const finishedAt = normalizeTimestamp(input.finishedAt, 'finish time');
  if (finishedAt < startedAt || finishedAt > generated.now + 60_000) {
    throw new Error('Memory sync journal timestamps are invalid');
  }
  return {
    id: normalizeOpaque(inputId(generated.id), 'journal id'),
    taskId: normalizeOpaque(input.taskId, 'task id'),
    agentInstanceId: normalizeOpaque(input.agentInstanceId, 'agent id'),
    executionId: normalizeOpaque(input.executionId, 'execution id'),
    operation: normalizeOperation(input.operation),
    direction: normalizeDirection(input.direction),
    status: normalizeStatus(input.status),
    epoch: normalizeOptionalCount(input.epoch, 'epoch', true),
    checkpointId:
      input.checkpointId == null
        ? null
        : normalizeOpaque(input.checkpointId, 'checkpoint id'),
    eventCount: normalizeOptionalCount(input.eventCount, 'event count'),
    importedEvents: normalizeOptionalCount(
      input.importedEvents,
      'imported event count',
    ),
    duplicateEvents: normalizeOptionalCount(
      input.duplicateEvents,
      'duplicate event count',
    ),
    divergenceEventIdHash:
      input.divergenceEventIdHash == null
        ? null
        : normalizeSha256(input.divergenceEventIdHash),
    errorCode: normalizeErrorCode(input.errorCode),
    resolution: normalizeResolution(input.resolution),
    recoveryClass: normalizeRecoveryClass(input.recoveryClass),
    recoveryDecision: normalizeRecoveryDecision(input.recoveryDecision),
    automatic: input.automatic === true,
    backoffMs: normalizeOptionalCount(input.backoffMs, 'backoff'),
    protocol: normalizeProtocol(input.protocol),
    idempotentReplay: input.idempotentReplay === true,
    attempt: normalizeOptionalCount(input.attempt ?? 1, 'attempt', true)!,
    startedAt,
    finishedAt,
  };
}

function normalizeOperation(
  value: CloudTaskMemorySyncOperation,
): CloudTaskMemorySyncOperation {
  if (!(cloudTaskMemorySyncOperations as readonly string[]).includes(value)) {
    throw new Error('Memory sync operation is invalid');
  }
  return value;
}

function normalizeDirection(
  value: CloudTaskMemorySyncDirection,
): CloudTaskMemorySyncDirection {
  if (
    value !== 'local-to-cloud' &&
    value !== 'cloud-to-local' &&
    value !== 'ownership-only'
  ) {
    throw new Error('Memory sync direction is invalid');
  }
  return value;
}

function normalizeStatus(
  value: CloudTaskMemorySyncStatus,
): CloudTaskMemorySyncStatus {
  if (value !== 'synchronized' && value !== 'diverged' && value !== 'failed') {
    throw new Error('Memory sync status is invalid');
  }
  return value;
}

function normalizeErrorCode(
  value: CloudTaskMemorySyncErrorCode | null | undefined,
): CloudTaskMemorySyncErrorCode | null {
  if (value == null) return null;
  if (
    value !== 'checkpoint-mismatch' &&
    value !== 'cas-conflict' &&
    value !== 'event-divergence' &&
    value !== 'ownership-conflict' &&
    value !== 'transport-failure' &&
    value !== 'invalid-response' &&
    value !== 'unknown'
  ) {
    throw new Error('Memory sync error code is invalid');
  }
  return value;
}

function normalizeResolution(
  value: CloudTaskMemoryDivergenceResolution | null | undefined,
): CloudTaskMemoryDivergenceResolution | null {
  if (value == null) return null;
  if (value !== 'keep-local' && value !== 'accept-cloud') {
    throw new Error('Memory sync resolution is invalid');
  }
  return value;
}

function normalizeRecoveryClass(
  value: CloudTaskMemoryRecoveryClass | null | undefined,
): CloudTaskMemoryRecoveryClass | null {
  if (value == null) return null;
  if (
    value !== 'transient' &&
    value !== 'append-only' &&
    value !== 'content-conflict' &&
    value !== 'ownership-conflict' &&
    value !== 'checkpoint-conflict' &&
    value !== 'concurrent-update' &&
    value !== 'invalid-data' &&
    value !== 'unknown'
  ) {
    throw new Error('Memory sync recovery class is invalid');
  }
  return value;
}

function normalizeProtocol(
  value: 'legacy' | 'atomic-v1' | null | undefined,
): 'legacy' | 'atomic-v1' | null {
  if (value == null) return null;
  if (value !== 'legacy' && value !== 'atomic-v1') {
    throw new Error('Memory sync protocol is invalid');
  }
  return value;
}

function normalizeRecoveryDecision(
  value: CloudTaskMemoryRecoveryDecision | null | undefined,
): CloudTaskMemoryRecoveryDecision | null {
  if (value == null) return null;
  if (
    value !== 'retry' &&
    value !== 'merge-non-conflicting' &&
    value !== 'manual'
  ) {
    throw new Error('Memory sync recovery decision is invalid');
  }
  return value;
}

function parseJournalEntry(
  value: unknown,
): CloudTaskMemorySyncJournalEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Partial<CloudTaskMemorySyncJournalEntry>;
  try {
    return normalizeJournalEntry(
      {
        ...(entry as RecordCloudTaskMemorySyncJournalInput),
        startedAt: entry.startedAt!,
        finishedAt: entry.finishedAt!,
      },
      { id: entry.id!, now: Number.MAX_SAFE_INTEGER },
    );
  } catch {
    return null;
  }
}

function inputId(value: string): string {
  return value;
}

function normalizeOpaque(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new Error(`Memory sync ${label} is invalid`);
  }
  return value;
}

function normalizeSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('Memory sync divergence hash is invalid');
  }
  return value;
}

function normalizeTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Memory sync ${label} is invalid`);
  }
  return value;
}

function normalizeOptionalCount(
  value: number | null | undefined,
  label: string,
  positive = false,
): number | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new Error(`Memory sync ${label} is invalid`);
  }
  return value;
}
