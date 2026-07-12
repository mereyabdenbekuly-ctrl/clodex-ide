import { createHash } from 'node:crypto';
import {
  ProtectedAppendFileStorage,
  type ProtectedFileStorage,
} from '@clodex/agent-core/host';
import type {
  RunnerSecurityAuditEvent,
  RunnerSecurityAuditSink,
} from '@clodex/agent-shell';
import { z } from 'zod';
import type { Logger } from '@/services/logger';

const runnerAuditRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
    previousHash: z.string(),
    eventHash: z.string().regex(/^[a-f0-9]{64}$/),
    event: z.object({
      type: z.enum([
        'job-issued',
        'job-admitted',
        'job-rejected',
        'receipt-issued',
      ]),
      createdAt: z.number().int().nonnegative(),
      jobId: z.string().uuid(),
      providerId: z.string(),
      leaseId: z.string(),
      snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
      operation: z.enum(['create-session', 'execute-command', 'kill-session']),
      jobHash: z.string().regex(/^[a-f0-9]{64}$/),
      receiptHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      outcome: z.enum(['completed', 'failed']).nullable(),
      reason: z.string().nullable(),
    }),
  })
  .strict();
type RunnerAuditRecord = z.infer<typeof runnerAuditRecordSchema>;

export class RunnerAuditLedger implements RunnerSecurityAuditSink {
  private readonly storage: ProtectedAppendFileStorage;
  private queue = Promise.resolve();
  private initialized = false;
  private sequence = 0;
  private previousHash = 'GENESIS';

  public constructor(
    protectedFiles: ProtectedFileStorage,
    filePath: string,
    private readonly logger: Logger,
  ) {
    this.storage = new ProtectedAppendFileStorage(
      protectedFiles,
      filePath,
      'runner-security/audit/v1',
    );
  }

  public async record(event: RunnerSecurityAuditEvent): Promise<void> {
    this.queue = this.queue.then(
      () => this.append(event),
      () => this.append(event),
    );
    await this.queue;
  }

  private async append(event: RunnerSecurityAuditEvent): Promise<void> {
    await this.initialize();
    const withoutHash = {
      schemaVersion: 1 as const,
      sequence: this.sequence + 1,
      previousHash: this.previousHash,
      event,
    };
    const record: RunnerAuditRecord = {
      ...withoutHash,
      eventHash: hashRecord(withoutHash),
    };
    await this.storage.append(`${JSON.stringify(record)}\n`);
    this.sequence = record.sequence;
    this.previousHash = record.eventHash;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const content = (await this.storage.readFile()).toString('utf8');
      let sequence = 0;
      let previousHash = 'GENESIS';
      for (const line of content.split('\n').filter(Boolean)) {
        const parsed = runnerAuditRecordSchema.safeParse(JSON.parse(line));
        if (
          !parsed.success ||
          parsed.data.sequence !== sequence + 1 ||
          parsed.data.previousHash !== previousHash ||
          parsed.data.eventHash !==
            hashRecord({
              schemaVersion: parsed.data.schemaVersion,
              sequence: parsed.data.sequence,
              previousHash: parsed.data.previousHash,
              event: parsed.data.event,
            })
        ) {
          throw new Error('invalid runner audit record');
        }
        sequence = parsed.data.sequence;
        previousHash = parsed.data.eventHash;
      }
      this.sequence = sequence;
      this.previousHash = previousHash;
      this.initialized = true;
    } catch (error) {
      this.logger.error(
        '[RunnerSecurity] Audit ledger integrity failed',
        error,
      );
      throw new Error('Runner security audit ledger integrity check failed', {
        cause: error,
      });
    }
  }
}

function hashRecord(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
