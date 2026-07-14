import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  artifactBridgeAuditActionSchema,
  artifactBridgeAuditEntrySchema,
  type ArtifactBridgeAuditEntry,
  type ArtifactBridgeContext,
} from '@shared/artifact-bridge';
import type { Logger } from '../logger';
import { redactSensitiveText } from './sensitive-egress';

const MAX_RECENT_AUDIT_RECORDS = 200;
const legacyAuditContextSchema = z.object({
  agentId: z.string(),
  appId: z.string(),
  pluginId: z.string().optional(),
});
const auditContextSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent'),
    agentId: z.string(),
    appId: z.string(),
    pluginId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('package'),
    packageId: z.string(),
    appId: z.string(),
  }),
]);
const createAuditEventSchema = <TContext extends z.ZodTypeAny>(
  context: TContext,
) =>
  z.object({
    action: artifactBridgeAuditActionSchema,
    outcome: z.enum(['success', 'denied', 'error']),
    context,
    requestId: z.string().optional(),
    method: z.string().optional(),
    resource: z.string().optional(),
    error: z.string().optional(),
  });
const legacyAuditEventSchema = createAuditEventSchema(legacyAuditContextSchema);
const auditEventSchema = createAuditEventSchema(auditContextSchema);
const legacyAuditRecordSchema = z.object({
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  previousHash: z.string(),
  eventHash: z.string().regex(/^[a-f0-9]{64}$/),
  event: legacyAuditEventSchema,
});
const auditRecordSchema = z.object({
  schemaVersion: z.literal(2),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  previousHash: z.string(),
  eventHash: z.string().regex(/^[a-f0-9]{64}$/),
  event: auditEventSchema,
});
type AuditRecord = z.infer<typeof auditRecordSchema>;

export type ArtifactBridgeAuditEvent = z.infer<typeof auditEventSchema>;

export interface ArtifactBridgeAuditRecorder {
  record(event: ArtifactBridgeAuditEvent): Promise<void>;
}

export interface ArtifactBridgeAuditReader {
  listRecent(
    limit: number,
    context?: ArtifactBridgeContext,
  ): Promise<ArtifactBridgeAuditEntry[]>;
}

export class ArtifactBridgeAuditLedger
  implements ArtifactBridgeAuditRecorder, ArtifactBridgeAuditReader
{
  private queue = Promise.resolve();
  private initialized = false;
  private initialization: Promise<void> | null = null;
  private initializationError: Error | null = null;
  private sequence = 0;
  private previousHash = 'GENESIS';
  private readonly recentRecords: ArtifactBridgeAuditEntry[] = [];

  public constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  public async record(event: ArtifactBridgeAuditEvent): Promise<void> {
    this.queue = this.queue.then(
      async () => await this.append(event),
      async () => await this.append(event),
    );
    await this.queue;
  }

  public async listRecent(
    rawLimit: number,
    context?: ArtifactBridgeContext,
  ): Promise<ArtifactBridgeAuditEntry[]> {
    await this.queue;
    await this.initialize();
    const limit = z.number().int().min(1).max(100).parse(rawLimit);
    const filtered = context
      ? this.recentRecords.filter((entry) =>
          auditContextsEqual(entry.context, context),
        )
      : this.recentRecords;
    return structuredClone(filtered.slice(-limit).reverse());
  }

  private async append(event: ArtifactBridgeAuditEvent): Promise<void> {
    await this.initialize();
    const payload = {
      schemaVersion: 2 as const,
      sequence: this.sequence + 1,
      timestamp: new Date(this.now()).toISOString(),
      previousHash: this.previousHash,
      event,
    };
    const eventHash = hashRecord(payload.previousHash, payload);
    const record: AuditRecord = { ...payload, eventHash };
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true });
    const handle = await fs.open(this.filePath, 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(directory);
    this.sequence = record.sequence;
    this.previousHash = record.eventHash;
    this.rememberRecord(toAuditEntry(record));
  }

  private async initialize(): Promise<void> {
    if (this.initializationError) throw this.initializationError;
    if (this.initialized) return;
    this.initialization ??= this.loadAndVerify().then(
      () => {
        this.initialized = true;
      },
      (error: unknown) => {
        this.initializationError = toError(error);
        throw this.initializationError;
      },
    );
    await this.initialization;
  }

  private async loadAndVerify(): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return;
      throw error;
    }

    let expectedPreviousHash = 'GENESIS';
    let expectedSequence = 1;
    for (const line of content.split('\n').filter(Boolean)) {
      const parsed = z
        .union([legacyAuditRecordSchema, auditRecordSchema])
        .safeParse(JSON.parse(line));
      if (
        !parsed.success ||
        parsed.data.sequence !== expectedSequence ||
        parsed.data.previousHash !== expectedPreviousHash ||
        parsed.data.eventHash !==
          hashRecord(parsed.data.previousHash, {
            schemaVersion: parsed.data.schemaVersion,
            sequence: parsed.data.sequence,
            timestamp: parsed.data.timestamp,
            previousHash: parsed.data.previousHash,
            event: parsed.data.event,
          })
      ) {
        this.logger.error(
          '[ArtifactBridge] Audit ledger integrity verification failed',
          { filePath: this.filePath, sequence: expectedSequence },
        );
        throw new Error('Artifact bridge audit ledger integrity check failed');
      }
      this.sequence = parsed.data.sequence;
      this.previousHash = parsed.data.eventHash;
      this.rememberRecord(toAuditEntry(parsed.data));
      expectedSequence++;
      expectedPreviousHash = parsed.data.eventHash;
    }
  }

  private rememberRecord(entry: ArtifactBridgeAuditEntry): void {
    this.recentRecords.push(entry);
    if (this.recentRecords.length > MAX_RECENT_AUDIT_RECORDS) {
      this.recentRecords.splice(
        0,
        this.recentRecords.length - MAX_RECENT_AUDIT_RECORDS,
      );
    }
  }
}

export function artifactBridgeAuditResource(
  method: string,
  params: unknown,
): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const value = params as Record<string, unknown>;
  if (
    method === 'callMcpTool' ||
    method === 'prepareMcpWrite' ||
    method === 'prepareSensitiveMcpCall'
  ) {
    return redactSensitiveText(
      `${String(value.serverId ?? '')}/${String(value.toolName ?? '')}`,
    ).slice(0, 513);
  }
  if (method === 'runAutomation') {
    return String(value.automationId ?? '');
  }
  return undefined;
}

function hashRecord(previousHash: string, payload: object): string {
  return createHash('sha256')
    .update(previousHash)
    .update('\n')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function auditContext(
  context: ArtifactBridgeContext,
): ArtifactBridgeAuditEvent['context'] {
  return context.kind === 'agent'
    ? {
        kind: 'agent',
        agentId: context.agentId,
        appId: context.appId,
        ...(context.pluginId ? { pluginId: context.pluginId } : {}),
      }
    : {
        kind: 'package',
        packageId: context.packageId,
        appId: context.appId,
      };
}

function toAuditEntry(
  record: z.infer<typeof legacyAuditRecordSchema> | AuditRecord,
): ArtifactBridgeAuditEntry {
  const context =
    'kind' in record.event.context
      ? record.event.context
      : {
          kind: 'agent' as const,
          agentId: record.event.context.agentId,
          appId: record.event.context.appId,
          ...(record.event.context.pluginId
            ? { pluginId: record.event.context.pluginId }
            : {}),
        };
  return artifactBridgeAuditEntrySchema.parse({
    sequence: record.sequence,
    timestamp: record.timestamp,
    action: record.event.action,
    outcome: record.event.outcome,
    context,
    requestId: record.event.requestId ?? null,
    method: record.event.method ?? null,
    resource: record.event.resource ?? null,
    error: record.event.error ?? null,
  });
}

function auditContextsEqual(
  left: ArtifactBridgeContext,
  right: ArtifactBridgeContext,
): boolean {
  if (left.kind !== right.kind || left.appId !== right.appId) return false;
  if (left.kind === 'package' && right.kind === 'package') {
    return left.packageId === right.packageId;
  }
  if (left.kind === 'agent' && right.kind === 'agent') {
    return (
      left.agentId === right.agentId &&
      (left.pluginId ?? null) === (right.pluginId ?? null)
    );
  }
  return false;
}
