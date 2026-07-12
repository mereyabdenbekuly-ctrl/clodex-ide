import { vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn() },
}));

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NetworkEgressGrant } from '@shared/network-egress-control';
import type {
  NetworkPolicy,
  NetworkPolicyDestinationGrant,
} from '@shared/network-policy';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import { createControlledBrowserNetworkPolicy } from './controlled-browser';
import { NetworkEgressControlCenterService } from './control-center';

type Handler = (clientId: string, ...args: never[]) => Promise<unknown>;

const services: NetworkEgressControlCenterService[] = [];
const temporaryDirectories: string[] = [];

async function createHarness({ enabled = true } = {}) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'clodex-egress-control-'),
  );
  temporaryDirectories.push(directory);
  const handlers = new Map<string, Handler>();
  const removed: string[] = [];
  const karton = {
    registerServerProcedureHandler(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    removeServerProcedureHandler(name: string) {
      removed.push(name);
      handlers.delete(name);
    },
  } as unknown as KartonService;
  let persistentGrants: NetworkEgressGrant[] = [];
  const preferences = {
    get: vi.fn(() => ({
      networkEgress: {
        browserGrants: structuredClone(persistentGrants),
      },
    })),
    update: vi.fn(async (patches: Array<{ value?: unknown }>) => {
      persistentGrants = structuredClone(
        patches[0]?.value as NetworkEgressGrant[],
      );
    }),
  };
  let policy: NetworkPolicy | null = createControlledBrowserNetworkPolicy();
  const applyBrowserGrants = vi.fn(
    async (grants: readonly NetworkPolicyDestinationGrant[]) => {
      policy = createControlledBrowserNetworkPolicy([], grants, 2);
    },
  );
  const saveAudit = vi.fn(async () => ({
    canceled: false,
    filePath: '/tmp/egress-audit.json',
  }));
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  let now = 10_000;

  return {
    handlers,
    removed,
    karton,
    preferences,
    applyBrowserGrants,
    saveAudit,
    logger,
    enabled,
    auditPath: path.join(directory, 'audit.jsonl'),
    getPolicy: () => policy,
    getPersistentGrants: () => persistentGrants,
    now: () => now,
    setNow: (value: number) => {
      now = value;
    },
  };
}

async function createService(
  harness: Awaited<ReturnType<typeof createHarness>>,
) {
  const service = await NetworkEgressControlCenterService.create({
    logger: harness.logger,
    karton: harness.karton,
    preferences: harness.preferences as never,
    auditPath: harness.auditPath,
    isFeatureEnabled: () => harness.enabled,
    getRuntimeStatus: () => ({
      policyEngineEnabled: true,
      policyEngineAvailable: true,
      proxyRequired: true,
      proxyAvailable: true,
      controlledBrowserEnabled: true,
      controlledBrowserActive: true,
    }),
    getBrowserPolicy: harness.getPolicy,
    applyBrowserGrants: harness.applyBrowserGrants,
    saveAudit: harness.saveAudit,
    now: harness.now,
  });
  services.push(service);
  return service;
}

afterEach(async () => {
  for (const service of services.splice(0)) service.teardown();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe('NetworkEgressControlCenterService', () => {
  it('adds, normalizes, persists, applies, and revokes an exact destination grant', async () => {
    const harness = await createHarness();
    await createService(harness);

    const added = (await harness.handlers.get('networkEgressControl.addGrant')!(
      'client',
      {
        scope: 'persistent',
        protocol: 'http',
        hostname: 'LOCALHOST.',
        port: 3000,
      } as never,
    )) as { grants: NetworkEgressGrant[] };

    expect(added.grants).toEqual([
      expect.objectContaining({
        scope: 'persistent',
        protocol: 'http',
        hostname: 'localhost',
        port: 3000,
        expiresAt: null,
      }),
    ]);
    expect(harness.getPersistentGrants()).toHaveLength(1);
    expect(harness.applyBrowserGrants).toHaveBeenLastCalledWith([
      { protocol: 'http', hostname: 'localhost', port: 3000 },
    ]);

    await harness.handlers.get('networkEgressControl.revokeGrant')!(
      'client',
      added.grants[0]?.id as never,
    );
    expect(harness.getPersistentGrants()).toEqual([]);
    expect(harness.applyBrowserGrants).toHaveBeenLastCalledWith([]);
  });

  it('expires session grants without persisting them', async () => {
    const harness = await createHarness();
    await createService(harness);

    const added = (await harness.handlers.get('networkEgressControl.addGrant')!(
      'client',
      {
        scope: 'session',
        protocol: 'https',
        hostname: 'dev.example.com',
        port: 8443,
        ttlMs: 60_000,
      } as never,
    )) as { grants: NetworkEgressGrant[] };
    expect(added.grants).toHaveLength(1);
    expect(harness.preferences.update).not.toHaveBeenCalled();

    harness.setNow(70_001);
    const snapshot = (await harness.handlers.get(
      'networkEgressControl.getSnapshot',
    )!('client')) as { grants: NetworkEgressGrant[] };
    expect(snapshot.grants).toEqual([]);
  });

  it('exports only the sanitized ledger envelope and rechecks the feature gate', async () => {
    const harness = await createHarness();
    await createService(harness);

    await expect(
      harness.handlers.get('networkEgressControl.exportAudit')!('client'),
    ).resolves.toEqual({
      canceled: false,
      count: 0,
      filePath: '/tmp/egress-audit.json',
    });
    expect(harness.saveAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'clodex-network-egress-audit',
        version: 1,
        records: [],
      }),
    );

    const disabledHarness = await createHarness({ enabled: false });
    await createService(disabledHarness);
    await expect(
      disabledHarness.handlers.get('networkEgressControl.getSnapshot')!(
        'client',
      ),
    ).rejects.toThrow('control center is disabled');
  });
});
