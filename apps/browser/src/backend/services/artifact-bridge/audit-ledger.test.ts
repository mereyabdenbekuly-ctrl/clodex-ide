import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger';
import { ArtifactBridgeAuditLedger } from './audit-ledger';

describe('ArtifactBridgeAuditLedger', () => {
  let root: string;
  let filePath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'clodex-audit-'));
    filePath = path.join(root, 'artifact-bridge.jsonl');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes a verifiable append-only hash chain without request payloads', async () => {
    const ledger = new ArtifactBridgeAuditLedger(filePath, {} as Logger, () =>
      Date.parse('2026-07-11T12:00:00.000Z'),
    );
    await ledger.record({
      action: 'capability.invoked',
      outcome: 'success',
      context: { kind: 'agent', agentId: 'agent-a', appId: 'dashboard' },
      requestId: 'request-1',
      method: 'callMcpTool',
      resource: 'docs/search',
    });
    await ledger.record({
      action: 'grant.revoked',
      outcome: 'success',
      context: { kind: 'agent', agentId: 'agent-a', appId: 'dashboard' },
    });

    const records = (await fs.readFile(filePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      sequence: 1,
      previousHash: 'GENESIS',
      event: { resource: 'docs/search' },
    });
    expect(records[1].previousHash).toBe(records[0].eventHash);
    expect(JSON.stringify(records)).not.toContain('arguments');
  });

  it('fails closed when an existing record was modified', async () => {
    const logger = { error: vi.fn() } as unknown as Logger;
    const first = new ArtifactBridgeAuditLedger(filePath, logger);
    await first.record({
      action: 'grant.saved',
      outcome: 'success',
      context: { kind: 'agent', agentId: 'agent-a', appId: 'dashboard' },
    });
    const content = await fs.readFile(filePath, 'utf8');
    await fs.writeFile(filePath, content.replace('dashboard', 'tampered'));

    const reopened = new ArtifactBridgeAuditLedger(filePath, logger);
    await expect(
      reopened.record({
        action: 'grant.revoked',
        outcome: 'success',
        context: { kind: 'agent', agentId: 'agent-a', appId: 'dashboard' },
      }),
    ).rejects.toThrow('integrity check failed');
    await expect(
      reopened.record({
        action: 'grant.saved',
        outcome: 'success',
        context: { kind: 'agent', agentId: 'agent-a', appId: 'dashboard' },
      }),
    ).rejects.toThrow('integrity check failed');
    await expect(reopened.listRecent(10)).rejects.toThrow(
      'integrity check failed',
    );
    expect(await fs.readFile(filePath, 'utf8')).toBe(
      content.replace('dashboard', 'tampered'),
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it('continues a valid v1 agent audit chain with v2 package-principal records', async () => {
    const legacyPayload = {
      schemaVersion: 1 as const,
      sequence: 1,
      timestamp: '2026-07-11T11:00:00.000Z',
      previousHash: 'GENESIS',
      event: {
        action: 'grant.saved' as const,
        outcome: 'success' as const,
        context: { agentId: 'agent-a', appId: 'dashboard' },
      },
    };
    const legacyRecord = {
      ...legacyPayload,
      eventHash: createHash('sha256')
        .update('GENESIS')
        .update('\n')
        .update(JSON.stringify(legacyPayload))
        .digest('hex'),
    };
    await fs.writeFile(filePath, `${JSON.stringify(legacyRecord)}\n`);

    const ledger = new ArtifactBridgeAuditLedger(filePath, {} as Logger, () =>
      Date.parse('2026-07-11T12:00:00.000Z'),
    );
    await ledger.record({
      action: 'capability.invoked',
      outcome: 'success',
      context: {
        kind: 'package',
        packageId: 'com.example.dashboard',
        appId: 'dashboard',
      },
      method: 'getCapabilities',
    });

    const records = (await fs.readFile(filePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records[1]).toMatchObject({
      schemaVersion: 2,
      sequence: 2,
      previousHash: legacyRecord.eventHash,
      event: {
        context: {
          kind: 'package',
          packageId: 'com.example.dashboard',
          appId: 'dashboard',
        },
      },
    });

    await expect(
      ledger.listRecent(10, {
        kind: 'package',
        packageId: 'com.example.dashboard',
        appId: 'dashboard',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        sequence: 2,
        action: 'capability.invoked',
        context: {
          kind: 'package',
          packageId: 'com.example.dashboard',
          appId: 'dashboard',
        },
      }),
    ]);
    await expect(
      ledger.listRecent(10, {
        kind: 'agent',
        agentId: 'agent-a',
        appId: 'dashboard',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        sequence: 1,
        action: 'grant.saved',
        context: {
          kind: 'agent',
          agentId: 'agent-a',
          appId: 'dashboard',
        },
      }),
    ]);
  });

  it('returns newest-first bounded audit metadata without hashes', async () => {
    const ledger = new ArtifactBridgeAuditLedger(filePath, {} as Logger, () =>
      Date.parse('2026-07-11T12:00:00.000Z'),
    );
    await ledger.record({
      action: 'grant.saved',
      outcome: 'success',
      context: { kind: 'agent', agentId: 'agent-a', appId: 'dashboard' },
    });
    await ledger.record({
      action: 'grant.revoked',
      outcome: 'success',
      context: { kind: 'agent', agentId: 'agent-a', appId: 'dashboard' },
      resource: 'scope:all',
    });

    const recent = await ledger.listRecent(1);
    expect(recent).toEqual([
      expect.objectContaining({
        sequence: 2,
        action: 'grant.revoked',
        resource: 'scope:all',
      }),
    ]);
    expect(JSON.stringify(recent)).not.toContain('eventHash');
    expect(JSON.stringify(recent)).not.toContain('previousHash');
  });
});
