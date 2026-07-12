import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  networkPolicyDecisionReasonSchema,
  networkPolicyPrincipalKindSchema,
  type NetworkPolicyDecision,
  type NetworkPolicyScope,
} from '@shared/network-policy';
import { z } from 'zod';

const AUDIT_SCHEMA_VERSION = 1;
const GENESIS_HASH = 'GENESIS';
const DEFAULT_TAIL_LIMIT = 200;
const MAX_TAIL_LIMIT = 1_000;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

export const networkPolicyAuditRecordSchema = z
  .object({
    schemaVersion: z.literal(AUDIT_SCHEMA_VERSION),
    sequence: z.number().int().positive(),
    eventId: z.string().uuid(),
    createdAt: z.number().int().nonnegative(),
    eventType: z.literal('decision'),
    principalKind: networkPolicyPrincipalKindSchema,
    principalHash: z.string().regex(/^[a-f0-9]{64}$/),
    jobHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    workspaceSnapshotHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    destinationHostHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    destinationPort: z.number().int().min(1).max(65_535).nullable(),
    protocol: z.enum(['http', 'https', 'ws', 'wss']).nullable(),
    decision: z.enum(['allow', 'deny']),
    reason: networkPolicyDecisionReasonSchema,
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    previousHash: z.string(),
    eventHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type NetworkPolicyAuditRecord = z.infer<
  typeof networkPolicyAuditRecordSchema
>;

type NetworkPolicyAuditRecordInput = Omit<
  NetworkPolicyAuditRecord,
  'schemaVersion' | 'sequence' | 'eventId' | 'previousHash' | 'eventHash'
>;

export class NetworkPolicyAuditLedger {
  private sequence = 0;
  private previousHash = GENESIS_HASH;
  private queue = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private readonly now: () => number,
  ) {}

  public static async create(
    filePath: string,
    now: () => number = Date.now,
  ): Promise<NetworkPolicyAuditLedger> {
    const ledger = new NetworkPolicyAuditLedger(filePath, now);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.chmod(filePath, 0o600);
      const records = parseNetworkPolicyAuditRecords(
        await fs.readFile(filePath, 'utf8'),
      );
      verifyNetworkPolicyAuditChain(records);
      const last = records.at(-1);
      ledger.sequence = last?.sequence ?? 0;
      ledger.previousHash = last?.eventHash ?? GENESIS_HASH;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return ledger;
  }

  public recordDecision(
    scope: NetworkPolicyScope,
    result: NetworkPolicyDecision,
  ): Promise<void> {
    return this.append({
      createdAt: this.now(),
      eventType: 'decision',
      principalKind: scope.principalKind,
      principalHash: hashAuditIdentity('principal', scope.principalId),
      jobHash: scope.jobId ? hashAuditIdentity('job', scope.jobId) : null,
      workspaceSnapshotHash: scope.workspaceSnapshotHash ?? null,
      destinationHostHash: result.destination
        ? hashAuditIdentity('destination-host', result.destination.hostname)
        : null,
      destinationPort: result.destination?.port ?? null,
      protocol: result.destination?.protocol ?? null,
      decision: result.decision,
      reason: result.reason,
      policyHash: result.policyHash,
    });
  }

  private append(input: NetworkPolicyAuditRecordInput): Promise<void> {
    this.queue = this.queue.then(async () => {
      const withoutHash = {
        schemaVersion: AUDIT_SCHEMA_VERSION,
        sequence: this.sequence + 1,
        eventId: randomUUID(),
        ...input,
        previousHash: this.previousHash,
      };
      const record = networkPolicyAuditRecordSchema.parse({
        ...withoutHash,
        eventHash: hashNetworkPolicyAuditRecord(withoutHash),
      });
      await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      this.sequence = record.sequence;
      this.previousHash = record.eventHash;
    });
    return this.queue;
  }
}

export interface NetworkPolicyAuditTail {
  records: NetworkPolicyAuditRecord[];
  truncated: boolean;
}

/**
 * Reads a bounded suffix of the content-free ledger for UI inspection. The
 * first record may point to a hash outside the suffix, while every record in
 * the returned window is individually hashed and contiguous with its peers.
 */
export async function readNetworkPolicyAuditTail(
  filePath: string,
  limit: number = DEFAULT_TAIL_LIMIT,
): Promise<NetworkPolicyAuditTail> {
  const boundedLimit = Math.max(1, Math.min(MAX_TAIL_LIMIT, Math.floor(limit)));
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const { size } = await handle.stat();
    if (size === 0) return { records: [], truncated: false };
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let content = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = content.indexOf('\n');
      content = firstNewline < 0 ? '' : content.slice(firstNewline + 1);
    }
    const parsed = parseNetworkPolicyAuditRecords(content);
    verifyNetworkPolicyAuditWindow(parsed);
    return {
      records: parsed.slice(-boundedLimit),
      truncated: start > 0 || parsed.length > boundedLimit,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records: [], truncated: false };
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Reads and verifies the complete sanitized ledger for user export. */
export async function readNetworkPolicyAuditLedger(
  filePath: string,
): Promise<NetworkPolicyAuditRecord[]> {
  try {
    const records = parseNetworkPolicyAuditRecords(
      await fs.readFile(filePath, 'utf8'),
    );
    verifyNetworkPolicyAuditChain(records);
    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function parseNetworkPolicyAuditRecords(
  content: string,
): NetworkPolicyAuditRecord[] {
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => networkPolicyAuditRecordSchema.parse(JSON.parse(line)));
}

export function verifyNetworkPolicyAuditChain(
  records: readonly NetworkPolicyAuditRecord[],
): void {
  let sequence = 0;
  let previousHash = GENESIS_HASH;
  for (const record of records) {
    const { eventHash, ...withoutHash } = record;
    if (
      record.sequence !== sequence + 1 ||
      record.previousHash !== previousHash ||
      eventHash !== hashNetworkPolicyAuditRecord(withoutHash)
    ) {
      throw new Error('Network policy audit ledger integrity check failed');
    }
    sequence = record.sequence;
    previousHash = eventHash;
  }
}

function verifyNetworkPolicyAuditWindow(
  records: readonly NetworkPolicyAuditRecord[],
): void {
  let previous: NetworkPolicyAuditRecord | undefined;
  for (const record of records) {
    const { eventHash, ...withoutHash } = record;
    if (eventHash !== hashNetworkPolicyAuditRecord(withoutHash)) {
      throw new Error('Network policy audit ledger integrity check failed');
    }
    if (
      previous &&
      (record.sequence !== previous.sequence + 1 ||
        record.previousHash !== previous.eventHash)
    ) {
      throw new Error('Network policy audit ledger integrity check failed');
    }
    previous = record;
  }
}

function hashAuditIdentity(domain: string, value: string): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(value)
    .digest('hex');
}

function hashNetworkPolicyAuditRecord(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
