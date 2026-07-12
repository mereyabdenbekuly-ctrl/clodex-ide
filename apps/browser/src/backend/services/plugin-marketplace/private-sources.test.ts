import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DATA_ROOT = vi.hoisted(
  () => `/tmp/clodex-private-marketplace-${process.pid}`,
);

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/clodex-test-app',
    getPath: () => TEST_DATA_ROOT,
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) =>
      Buffer.from(`test-ciphertext:${value}`, 'utf8'),
    decryptString: (value: Buffer) =>
      value.toString('utf8').replace(/^test-ciphertext:/, ''),
  },
}));

import type { KartonService } from '@/services/karton';
import type { Logger } from '@/services/logger';
import type {
  PluginMarketplaceIndexPayload,
  PluginMarketplaceInstallSource,
  PrivateMarketplaceSourceInput,
  PrivateMarketplaceSourcesConfig,
} from '@shared/plugin-marketplace';
import type { PluginMarketplaceService } from './index';
import { PrivateMarketplaceSourcesService } from './private-sources';

const NOW = Date.UTC(2026, 6, 11);
const KEY_ID = 'engineering-2026-01';
const INDEX_URL = 'https://plugins.example.com/clodex/index.json';

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
} as unknown as Logger;

function createKarton() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  return {
    handlers,
    service: {
      registerServerProcedureHandler: vi.fn(
        (name: string, handler: (...args: any[]) => unknown) => {
          handlers.set(name, handler);
        },
      ),
      removeServerProcedureHandler: vi.fn((name: string) => {
        handlers.delete(name);
      }),
    } as unknown as KartonService,
  };
}

function publicKeyPem(key: KeyObject): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

function sourceInput(
  publicKey: string,
  overrides: Partial<PrivateMarketplaceSourceInput> = {},
): PrivateMarketplaceSourceInput {
  return {
    id: 'engineering',
    displayName: 'Engineering Marketplace',
    indexUrl: INDEX_URL,
    signingKeyId: KEY_ID,
    signingPublicKey: publicKey,
    enabled: true,
    ...overrides,
  };
}

function payload(
  overrides: Partial<PluginMarketplaceIndexPayload> = {},
): PluginMarketplaceIndexPayload {
  return {
    schemaVersion: 1,
    generatedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    plugins: [
      {
        manifest: {
          schemaVersion: 1,
          id: 'engineering-tools',
          version: '1.0.0',
          displayName: 'Engineering Tools',
          description: 'Internal engineering workflows.',
          publisher: 'Example Engineering',
          compatibility: { minAppVersion: '1.16.0' },
          permissions: ['skills'],
          requiredCredentials: [],
        },
        source: {
          type: 'https',
          url: 'https://plugins.example.com/packages/engineering-tools.zip',
        },
        sha256: 'a'.repeat(64),
      },
    ],
    ...overrides,
  };
}

function signedIndexResponse(
  privateKey: KeyObject,
  rawPayload: unknown,
  options?: { keyId?: string; tamperSignature?: boolean },
): Response {
  const payloadBytes = Buffer.from(JSON.stringify(rawPayload), 'utf8');
  const signature = options?.tamperSignature
    ? Buffer.alloc(64, 7)
    : sign(null, payloadBytes, privateKey);
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      keyId: options?.keyId ?? KEY_ID,
      payload: payloadBytes.toString('base64'),
      signature: signature.toString('base64'),
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

async function createHarness(options?: {
  fetcher?: typeof fetch;
  installer?: Pick<
    PluginMarketplaceService,
    'getState' | 'installVerifiedEntry' | 'uninstallVerifiedPlugin'
  >;
  loadConfig?: () => Promise<unknown>;
  saveConfig?: (config: PrivateMarketplaceSourcesConfig) => Promise<void>;
  enabled?: boolean;
}) {
  const karton = createKarton();
  const installer = options?.installer ?? createInstaller();
  const service = await PrivateMarketplaceSourcesService.create({
    logger,
    karton: karton.service,
    isFeatureEnabled: () => options?.enabled ?? true,
    now: () => NOW,
    fetcher: options?.fetcher,
    appVersion: '1.16.0',
    installer,
    loadConfig:
      options?.loadConfig ??
      (async () => ({
        schemaVersion: 1,
        sources: [],
      })),
    saveConfig: options?.saveConfig ?? (async () => undefined),
  });
  return { installer, karton, service };
}

function createInstaller() {
  const installed: Array<{
    id: string;
    version: string;
    source: PluginMarketplaceInstallSource;
  }> = [];
  const getState = vi.fn(() => ({ installed }) as any);
  const installVerifiedEntry = vi.fn(
    async (
      entry: PluginMarketplaceIndexPayload['plugins'][number],
      source: PluginMarketplaceInstallSource,
      _publisherKeyId: string | undefined,
      requestedOperation: 'install' | 'update',
    ) => {
      const existingIndex = installed.findIndex(
        (item) => item.id === entry.manifest.id,
      );
      const operation = existingIndex === -1 ? requestedOperation : 'update';
      const record = {
        id: entry.manifest.id,
        version: entry.manifest.version,
        source,
      };
      if (existingIndex === -1) installed.push(record);
      else installed[existingIndex] = record;
      return {
        ok: true as const,
        operation,
        pluginId: entry.manifest.id,
        state: getState(),
      };
    },
  );
  const uninstallVerifiedPlugin = vi.fn(
    async (pluginId: string, source: PluginMarketplaceInstallSource) => {
      const existingIndex = installed.findIndex((item) => item.id === pluginId);
      if (existingIndex !== -1) installed.splice(existingIndex, 1);
      return {
        ok: true as const,
        operation: 'uninstall' as const,
        pluginId,
        source,
        state: getState(),
      };
    },
  );
  return {
    getState,
    installVerifiedEntry,
    uninstallVerifiedPlugin,
  } as unknown as Pick<
    PluginMarketplaceService,
    'getState' | 'installVerifiedEntry' | 'uninstallVerifiedPlugin'
  >;
}

beforeEach(async () => {
  await fs.rm(TEST_DATA_ROOT, { recursive: true, force: true });
});

afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(TEST_DATA_ROOT, { recursive: true, force: true });
});

describe('PrivateMarketplaceSourcesService', () => {
  it('stores pinned sources but exposes only their SPKI fingerprint', async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const persisted: PrivateMarketplaceSourcesConfig[] = [];
    const harness = await createHarness({
      saveConfig: async (config) => {
        persisted.push(structuredClone(config));
      },
    });

    const saved = await harness.service.save(
      sourceInput(publicKeyPem(keyPair.publicKey)),
    );
    expect(saved).toMatchObject({
      id: 'engineering',
      signingKeyId: KEY_ID,
      signingKeyFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      status: 'idle',
    });
    expect(saved).not.toHaveProperty('signingPublicKey');
    expect(persisted[0]?.sources[0]?.signingPublicKey).toContain(
      'BEGIN PUBLIC KEY',
    );
    expect(
      harness.karton.handlers.has('pluginMarketplace.privateSources.refresh'),
    ).toBe(true);

    const rsaKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(
      harness.service.save(
        sourceInput(publicKeyPem(rsaKey.publicKey), { id: 'rsa-source' }),
      ),
    ).rejects.toThrow('must be an Ed25519 public key');
    await expect(
      harness.service.save(
        sourceInput(publicKeyPem(keyPair.publicKey), {
          id: 'duplicate-url',
          displayName: 'Duplicate URL',
        }),
      ),
    ).rejects.toThrow('index URL is already used');

    await expect(
      harness.service.setEnabled('engineering', false),
    ).resolves.toMatchObject({ enabled: false });
    await expect(harness.service.remove('engineering')).resolves.toMatchObject({
      sources: [],
    });
    await harness.service.teardown();
    expect(harness.karton.handlers.size).toBe(0);
  });

  it('persists the registry through strict safeStorage-backed storage', async () => {
    const keyPair = generateKeyPairSync('ed25519');
    await fs.mkdir(path.join(TEST_DATA_ROOT, 'clodex'), { recursive: true });
    const karton = createKarton();
    const installer = createInstaller();
    const service = await PrivateMarketplaceSourcesService.create({
      logger,
      karton: karton.service,
      isFeatureEnabled: () => true,
      now: () => NOW,
      appVersion: '1.16.0',
      installer,
    });
    await service.save(sourceInput(publicKeyPem(keyPair.publicKey)));
    await service.teardown();

    const storagePath = path.join(
      TEST_DATA_ROOT,
      'clodex',
      'private-marketplace-sources.json',
    );
    const storedBytes = await fs.readFile(storagePath, 'utf8');
    expect(storedBytes).toContain('"$clodex":"clodex.safe-storage"');
    expect(storedBytes).not.toContain(INDEX_URL);

    const restartedKarton = createKarton();
    const restarted = await PrivateMarketplaceSourcesService.create({
      logger,
      karton: restartedKarton.service,
      isFeatureEnabled: () => true,
      now: () => NOW,
      appVersion: '1.16.0',
      installer,
    });
    expect(restarted.list().sources).toHaveLength(1);
    expect(restarted.list().sources[0]).not.toHaveProperty('signingPublicKey');
    await restarted.teardown();
  });

  it('fetches with redirects blocked and verifies the exact pinned key', async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const fetcher = vi.fn(async () =>
      signedIndexResponse(keyPair.privateKey, payload()),
    ) as unknown as typeof fetch;
    const harness = await createHarness({ fetcher });
    await harness.service.save(sourceInput(publicKeyPem(keyPair.publicKey)));

    await expect(harness.service.refresh('engineering')).resolves.toMatchObject(
      {
        status: 'ready',
        generatedAt: NOW - 1_000,
        expiresAt: NOW + 60_000,
        pluginCount: 1,
        error: null,
      },
    );
    expect(fetcher).toHaveBeenCalledWith(
      INDEX_URL,
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(
      harness.service.getVerifiedIndex('engineering')?.plugins[0]?.manifest.id,
    ).toBe('engineering-tools');
    await harness.service.teardown();
  });

  it('installs only from the verified source and preserves source provenance', async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const fetcher = vi.fn(async () =>
      signedIndexResponse(keyPair.privateKey, payload()),
    ) as unknown as typeof fetch;
    const harness = await createHarness({ fetcher });
    await harness.service.save(sourceInput(publicKeyPem(keyPair.publicKey)));
    await expect(
      harness.service.install('engineering', 'engineering-tools'),
    ).rejects.toThrow('Refresh and verify');
    await harness.service.refresh('engineering');

    const installed = await harness.service.install(
      'engineering',
      'engineering-tools',
    );
    expect(installed).toMatchObject({
      ok: true,
      operation: 'install',
      sourceId: 'engineering',
      state: {
        sources: [
          {
            catalog: [
              {
                manifest: { id: 'engineering-tools' },
                installedFromSource: true,
                installedVersion: '1.0.0',
              },
            ],
          },
        ],
      },
    });
    expect(harness.installer.installVerifiedEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ id: 'engineering-tools' }),
      }),
      expect.objectContaining({
        kind: 'private-marketplace',
        sourceId: 'engineering',
        signingKeyId: KEY_ID,
        signingKeyFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
      undefined,
      'install',
    );
    await expect(harness.service.remove('engineering')).rejects.toThrow(
      'Uninstall plugins from this source',
    );
    const replacementKey = generateKeyPairSync('ed25519');
    await expect(
      harness.service.save(sourceInput(publicKeyPem(replacementKey.publicKey))),
    ).rejects.toThrow('before changing its URL or signing key');
    await expect(
      harness.service.uninstall('engineering', 'engineering-tools'),
    ).resolves.toMatchObject({ ok: true, operation: 'uninstall' });
    await expect(harness.service.remove('engineering')).resolves.toMatchObject({
      sources: [],
    });
    await harness.service.teardown();
  });

  it('fails closed on key-ID mismatch, tampering, and oversized indexes', async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const responses = [
      signedIndexResponse(keyPair.privateKey, payload(), {
        keyId: 'unexpected-key',
      }),
      signedIndexResponse(keyPair.privateKey, payload(), {
        tamperSignature: true,
      }),
      new Response('x', {
        status: 200,
        headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
      }),
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(4 * 1024 * 1024));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    ];
    const fetcher = vi.fn(
      async () => responses.shift()!,
    ) as unknown as typeof fetch;
    const harness = await createHarness({ fetcher });
    await harness.service.save(sourceInput(publicKeyPem(keyPair.publicKey)));

    await expect(harness.service.refresh('engineering')).rejects.toThrow(
      'signing key ID mismatch',
    );
    await expect(harness.service.refresh('engineering')).rejects.toThrow(
      'signature is invalid',
    );
    await expect(harness.service.refresh('engineering')).rejects.toThrow(
      'exceeds the size limit',
    );
    await expect(harness.service.refresh('engineering')).rejects.toThrow(
      'exceeds the size limit',
    );
    expect(harness.service.list().sources[0]).toMatchObject({
      status: 'error',
      pluginCount: 0,
    });
    expect(harness.service.getVerifiedIndex('engineering')).toBeNull();
    await harness.service.teardown();
  });

  it('rejects expired, duplicate, and non-HTTPS package metadata', async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const valid = payload();
    const duplicatePayload = {
      ...valid,
      plugins: [valid.plugins[0], structuredClone(valid.plugins[0])],
    };
    const bundledPayload = payload({
      plugins: [
        {
          ...valid.plugins[0]!,
          source: {
            type: 'bundled-directory',
            relativePath: 'packages/engineering-tools',
          },
        },
      ],
    } as Partial<PluginMarketplaceIndexPayload>);
    const responses = [
      signedIndexResponse(keyPair.privateKey, payload({ expiresAt: NOW })),
      signedIndexResponse(keyPair.privateKey, duplicatePayload),
      signedIndexResponse(keyPair.privateKey, bundledPayload),
    ];
    const fetcher = vi.fn(
      async () => responses.shift()!,
    ) as unknown as typeof fetch;
    const harness = await createHarness({ fetcher });
    await harness.service.save(sourceInput(publicKeyPem(keyPair.publicKey)));

    await expect(harness.service.refresh('engineering')).rejects.toThrow(
      'index has expired',
    );
    await expect(harness.service.refresh('engineering')).rejects.toThrow(
      'duplicate plugin',
    );
    await expect(harness.service.refresh('engineering')).rejects.toThrow(
      'must use an HTTPS package source',
    );
    await harness.service.teardown();
  });

  it('keeps source listings available while the feature gate blocks changes', async () => {
    const harness = await createHarness({ enabled: false });
    expect(harness.service.list()).toEqual({ enabled: false, sources: [] });
    const keyPair = generateKeyPairSync('ed25519');
    await expect(
      harness.service.save(sourceInput(publicKeyPem(keyPair.publicKey))),
    ).rejects.toThrow('Feature gate is disabled');
    await harness.service.teardown();
  });
});
