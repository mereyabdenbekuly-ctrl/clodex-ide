import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NetworkPolicy } from '@shared/network-policy';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseNetworkPolicyAuditRecords,
  readNetworkPolicyAuditLedger,
  readNetworkPolicyAuditTail,
  verifyNetworkPolicyAuditChain,
} from './audit-ledger';
import { NetworkPolicyEngine } from '.';

const temporaryDirectories: string[] = [];

const makeAuditPath = async (): Promise<string> => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'clodex-network-policy-'),
  );
  temporaryDirectories.push(directory);
  return path.join(directory, 'audit', 'network-policy.jsonl');
};

const allowlistedPolicy: NetworkPolicy = {
  id: 'test-policy',
  version: 1,
  mode: 'allowlist',
  allowedHosts: ['api.example.com'],
  allowedPorts: [443],
  allowedDestinations: [],
  allowPrivateNetworks: false,
  allowLoopback: false,
  allowIpLiterals: false,
};

const evaluate = (engine: NetworkPolicyEngine, suffix = ''): Promise<unknown> =>
  engine.evaluate({
    scope: {
      principalKind: 'agent',
      principalId: `agent-secret-id${suffix}`,
      jobId: `job-secret-id${suffix}`,
    },
    destination: `https://api.example.com/private?token=super-secret${suffix}`,
  });

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('NetworkPolicyAuditLedger', () => {
  it('persists no raw identity, hostname, path, query, or secret content', async () => {
    const auditPath = await makeAuditPath();
    const engine = await NetworkPolicyEngine.create({
      auditPath,
      resolvePolicy: () => allowlistedPolicy,
      now: () => 1234,
    });

    await evaluate(engine);

    const content = await fs.readFile(auditPath, 'utf8');
    for (const secret of [
      'api.example.com',
      '/private',
      'super-secret',
      'agent-secret-id',
      'job-secret-id',
    ]) {
      expect(content).not.toContain(secret);
    }
    const [record] = parseNetworkPolicyAuditRecords(content);
    expect(record).toMatchObject({
      sequence: 1,
      createdAt: 1234,
      principalKind: 'agent',
      destinationPort: 443,
      protocol: 'https',
      decision: 'allow',
      reason: 'allowlisted',
    });
    expect(record?.principalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record?.destinationHostHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('serializes concurrent writes into a valid hash chain', async () => {
    const auditPath = await makeAuditPath();
    const engine = await NetworkPolicyEngine.create({
      auditPath,
      resolvePolicy: () => allowlistedPolicy,
    });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => evaluate(engine, `-${index}`)),
    );

    const records = parseNetworkPolicyAuditRecords(
      await fs.readFile(auditPath, 'utf8'),
    );
    expect(records).toHaveLength(20);
    expect(records.map((record) => record.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(() => verifyNetworkPolicyAuditChain(records)).not.toThrow();
  });

  it('continues sequence and hash state after reopening', async () => {
    const auditPath = await makeAuditPath();
    const first = await NetworkPolicyEngine.create({
      auditPath,
      resolvePolicy: () => allowlistedPolicy,
    });
    await evaluate(first, '-first');

    const second = await NetworkPolicyEngine.create({
      auditPath,
      resolvePolicy: () => allowlistedPolicy,
    });
    await evaluate(second, '-second');

    const records = parseNetworkPolicyAuditRecords(
      await fs.readFile(auditPath, 'utf8'),
    );
    expect(records.map((record) => record.sequence)).toEqual([1, 2]);
    expect(records[1]?.previousHash).toBe(records[0]?.eventHash);
    expect(() => verifyNetworkPolicyAuditChain(records)).not.toThrow();
  });

  it('detects tampering when reopening', async () => {
    const auditPath = await makeAuditPath();
    const engine = await NetworkPolicyEngine.create({
      auditPath,
      resolvePolicy: () => allowlistedPolicy,
    });
    await evaluate(engine);

    const [record] = parseNetworkPolicyAuditRecords(
      await fs.readFile(auditPath, 'utf8'),
    );
    await fs.writeFile(
      auditPath,
      `${JSON.stringify({ ...record, decision: 'deny' })}\n`,
    );

    await expect(
      NetworkPolicyEngine.create({
        auditPath,
        resolvePolicy: () => allowlistedPolicy,
      }),
    ).rejects.toThrow('integrity check failed');
  });

  it('returns a bounded verified suffix and the complete sanitized ledger', async () => {
    const auditPath = await makeAuditPath();
    const engine = await NetworkPolicyEngine.create({
      auditPath,
      resolvePolicy: () => allowlistedPolicy,
      now: () => 123,
    });

    for (let index = 0; index < 5; index++) {
      await evaluate(engine, `-${index}`);
    }

    await expect(
      readNetworkPolicyAuditTail(auditPath, 2),
    ).resolves.toMatchObject({
      records: [{ sequence: 4 }, { sequence: 5 }],
      truncated: true,
    });
    await expect(readNetworkPolicyAuditLedger(auditPath)).resolves.toHaveLength(
      5,
    );
    expect(await fs.readFile(auditPath, 'utf8')).not.toContain(
      'api.example.com',
    );
  });

  it('rejects malformed records', () => {
    expect(() => parseNetworkPolicyAuditRecords('{}\n')).toThrow();
    expect(() => parseNetworkPolicyAuditRecords('{not-json}\n')).toThrow();
  });
});
