import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AeadDataProtection,
  ProtectedAppendFileStorage,
  ProtectedFileStorage,
} from '@clodex/agent-core/host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/services/logger';
import { RunnerAuditLedger } from './runner-audit-ledger';

describe('RunnerAuditLedger', () => {
  let root: string;
  let filePath: string;
  let protectedFiles: ProtectedFileStorage;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-audit-'));
    filePath = path.join(root, 'runner-security.jsonl');
    protectedFiles = new ProtectedFileStorage(
      new AeadDataProtection(randomBytes(32)),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('persists a protected hash chain containing metadata but no command', async () => {
    const ledger = new RunnerAuditLedger(
      protectedFiles,
      filePath,
      {} as Logger,
    );
    await ledger.record(event('job-issued'));
    await ledger.record(event('receipt-issued'));

    const appendFile = new ProtectedAppendFileStorage(
      protectedFiles,
      filePath,
      'runner-security/audit/v1',
    );
    const records = (await appendFile.readFile())
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      sequence: 1,
      previousHash: 'GENESIS',
      event: { type: 'job-issued' },
    });
    expect(records[1].previousHash).toBe(records[0].eventHash);
    expect(JSON.stringify(records)).not.toContain('pnpm test');
  });

  it('continues a verified chain after restart', async () => {
    await new RunnerAuditLedger(protectedFiles, filePath, {} as Logger).record(
      event('job-issued'),
    );
    await new RunnerAuditLedger(protectedFiles, filePath, {} as Logger).record(
      event('job-admitted'),
    );

    const appendFile = new ProtectedAppendFileStorage(
      protectedFiles,
      filePath,
      'runner-security/audit/v1',
    );
    const records = (await appendFile.readFile())
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.sequence)).toEqual([1, 2]);
  });

  it('fails closed on a broken chain and rechecks on every retry', async () => {
    await new RunnerAuditLedger(protectedFiles, filePath, {} as Logger).record(
      event('job-issued'),
    );
    const appendFile = new ProtectedAppendFileStorage(
      protectedFiles,
      filePath,
      'runner-security/audit/v1',
    );
    await appendFile.append(
      `${JSON.stringify({
        schemaVersion: 1,
        sequence: 2,
        previousHash: 'wrong',
        eventHash: 'd'.repeat(64),
        event: event('job-admitted'),
      })}\n`,
    );
    const logger = { error: vi.fn() } as unknown as Logger;
    const ledger = new RunnerAuditLedger(protectedFiles, filePath, logger);

    await expect(ledger.record(event('receipt-issued'))).rejects.toThrow(
      'integrity check failed',
    );
    await expect(ledger.record(event('receipt-issued'))).rejects.toThrow(
      'integrity check failed',
    );
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});

function event(type: 'job-issued' | 'job-admitted' | 'receipt-issued') {
  return {
    type,
    createdAt: 1,
    jobId: '00000000-0000-4000-8000-000000000001',
    providerId: 'local-runner',
    leaseId: 'lease-1',
    snapshotHash: 'a'.repeat(64),
    operation: 'execute-command' as const,
    jobHash: 'b'.repeat(64),
    receiptHash: type === 'receipt-issued' ? 'c'.repeat(64) : null,
    outcome: type === 'receipt-issued' ? ('completed' as const) : null,
    reason: null,
  };
}
