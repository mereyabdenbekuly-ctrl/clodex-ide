import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NetworkPolicy } from '@shared/network-policy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkPolicyEngine } from '.';

const temporaryDirectories: string[] = [];

const makeEngine = async (
  resolveDns: (
    hostname: string,
  ) => Promise<Array<{ address: string; family: 4 | 6 }>>,
  overrides: Partial<NetworkPolicy> = {},
): Promise<NetworkPolicyEngine> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clodex-dns-'));
  temporaryDirectories.push(directory);
  return await NetworkPolicyEngine.create({
    auditPath: path.join(directory, 'audit.jsonl'),
    resolveDns,
    resolvePolicy: () => ({
      id: 'dns-test',
      version: 1,
      mode: 'allowlist',
      allowedHosts: ['api.example.com'],
      allowedPorts: [443],
      allowedDestinations: [],
      allowPrivateNetworks: false,
      allowLoopback: false,
      allowIpLiterals: false,
      ...overrides,
    }),
  });
};

const request = (destination = 'https://api.example.com') => ({
  scope: {
    principalKind: 'mcp' as const,
    principalId: 'remote-test',
  },
  destination,
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('NetworkPolicyEngine DNS pinning', () => {
  it('resolves once and returns a validated pinned address', async () => {
    const resolveDns = vi.fn(async () => [
      { address: '2001:4860:4860::8888', family: 6 as const },
      { address: '8.8.8.8', family: 4 as const },
    ]);
    const engine = await makeEngine(resolveDns);

    const result = await engine.resolveAndEvaluate(request());

    expect(resolveDns).toHaveBeenCalledOnce();
    expect(resolveDns).toHaveBeenCalledWith('api.example.com');
    expect(result).toMatchObject({
      decision: { decision: 'allow', reason: 'allowlisted' },
      pinnedAddress: { address: '8.8.8.8', family: 4 },
    });
  });

  it('does not leak DNS queries for policy-denied hosts', async () => {
    const resolveDns = vi.fn(async () => [
      { address: '8.8.8.8', family: 4 as const },
    ]);
    const engine = await makeEngine(resolveDns);

    const result = await engine.resolveAndEvaluate(
      request('https://denied.example.com'),
    );

    expect(result.decision).toMatchObject({
      decision: 'deny',
      reason: 'host-not-allowed',
    });
    expect(resolveDns).not.toHaveBeenCalled();
  });

  it('rejects mixed public/private answers to prevent rebinding', async () => {
    const engine = await makeEngine(async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);

    const result = await engine.resolveAndEvaluate(request());

    expect(result).toMatchObject({
      decision: {
        decision: 'deny',
        reason: 'resolved-loopback-denied',
      },
      pinnedAddress: null,
    });
  });

  it.each([
    ['10.0.0.1', 4],
    ['fd00::1', 6],
    ['::ffff:127.0.0.1', 6],
    ['::ffff:7f00:1', 6],
  ] as const)('rejects resolved non-public address %s', async (address, family) => {
    const engine = await makeEngine(async () => [{ address, family }]);

    const result = await engine.resolveAndEvaluate(request());

    expect(result.decision.decision).toBe('deny');
    expect([
      'resolved-loopback-denied',
      'resolved-private-network-denied',
    ]).toContain(result.decision.reason);
    expect(result.pinnedAddress).toBeNull();
  });

  it('fails closed when DNS resolution fails or returns no valid addresses', async () => {
    const failing = await makeEngine(async () => {
      throw new Error('resolver unavailable');
    });
    await expect(failing.resolveAndEvaluate(request())).resolves.toMatchObject({
      decision: { decision: 'deny', reason: 'dns-resolution-failed' },
      pinnedAddress: null,
    });

    const empty = await makeEngine(async () => [
      { address: 'not-an-ip', family: 4 },
    ]);
    await expect(empty.resolveAndEvaluate(request())).resolves.toMatchObject({
      decision: { decision: 'deny', reason: 'dns-resolution-failed' },
      pinnedAddress: null,
    });
  });

  it('pins an explicitly granted loopback destination without widening the policy', async () => {
    const resolveDns = vi.fn(async () => [
      { address: '127.0.0.1', family: 4 as const },
    ]);
    const engine = await makeEngine(resolveDns, {
      allowedDestinations: [
        { protocol: 'http', hostname: 'localhost', port: 3000 },
      ],
    });

    const result = await engine.resolveAndEvaluate(
      request('http://localhost:3000'),
    );

    expect(result).toMatchObject({
      decision: { decision: 'allow', reason: 'exact-destination-grant' },
      pinnedAddress: { address: '127.0.0.1', family: 4 },
    });
    expect(
      await engine.resolveAndEvaluate(request('http://localhost:3001')),
    ).toMatchObject({
      decision: { decision: 'deny', reason: 'loopback-denied' },
      pinnedAddress: null,
    });
  });
});
