import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/clodex-test-app',
    getPath: () => '/tmp/clodex-test-data',
    isPackaged: false,
  },
}));

import type { KartonService } from '@/services/karton';
import type { Logger } from '@/services/logger';
import type {
  PluginMarketplaceIndexEntry,
  PluginMarketplaceInstallSource,
  PluginMarketplaceManifest,
} from '@shared/plugin-marketplace';
import { canonicalizePluginPublisherAttestation } from '@shared/plugin-marketplace';
import { hashPluginDirectory, PluginMarketplaceService } from './index';
import { OFFICIAL_PLUGIN_MARKETPLACE_KEYS } from './trusted-keys';

const NOW = Date.UTC(2026, 6, 10);
const APP_VERSION = '1.16.0';
const KEY_ID = 'test-key';
const temporaryRoots: string[] = [];

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

function createManifest(
  version = '1.0.0',
  overrides: Partial<PluginMarketplaceManifest> = {},
): PluginMarketplaceManifest {
  return {
    schemaVersion: 1,
    id: 'release-readiness',
    version,
    displayName: 'Release Readiness',
    description: 'Validate release gates and rollback safety.',
    publisher: 'Clodex Tests',
    compatibility: { minAppVersion: '1.16.0' },
    permissions: ['skills'],
    requiredCredentials: [],
    ...overrides,
  };
}

async function writePackage(
  packageRoot: string,
  manifest: PluginMarketplaceManifest,
): Promise<void> {
  await fs.rm(packageRoot, { recursive: true, force: true });
  await fs.mkdir(packageRoot, { recursive: true });
  const writes: Promise<void>[] = [
    fs.writeFile(
      path.join(packageRoot, 'plugin.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
    fs.writeFile(
      path.join(packageRoot, 'metadata.json'),
      `${JSON.stringify(
        {
          displayName: manifest.displayName,
          description: manifest.description,
          requiredCredentials: manifest.requiredCredentials,
        },
        null,
        2,
      )}\n`,
    ),
  ];
  if (manifest.permissions.includes('skills')) {
    writes.push(
      fs.writeFile(
        path.join(packageRoot, 'SKILL.md'),
        `---\nname: ${manifest.displayName}\ndescription: ${manifest.description}\n---\n`,
      ),
    );
  }
  if (manifest.mcpServers?.length) {
    const mcpDirectory = path.join(packageRoot, 'mcp');
    await fs.mkdir(mcpDirectory, { recursive: true });
    writes.push(
      fs.writeFile(
        path.join(mcpDirectory, 'servers.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            servers: manifest.mcpServers.map((server) => ({
              id: server.id,
              displayName: server.displayName,
              enabledByDefault: false,
              transport: {
                type: server.transport,
                url: server.endpoint,
                headers: {},
              },
              policy: { default: 'ask', tools: {} },
            })),
          },
          null,
          2,
        )}\n`,
      ),
    );
  }
  await Promise.all(writes);
}

async function writeSignedIndex({
  indexPath,
  privateKey,
  manifest,
  packageRoot,
  expiresAt = NOW + 60_000,
  sha256,
  publisher,
}: {
  indexPath: string;
  privateKey: KeyObject;
  manifest: PluginMarketplaceManifest;
  packageRoot: string;
  expiresAt?: number;
  sha256?: string;
  publisher?: {
    publisherId: string;
    publisherName: string;
    keyId: string;
    publicKey: string;
    privateKey: KeyObject;
    status: 'active' | 'revoked';
  };
}): Promise<void> {
  const entry: PluginMarketplaceIndexEntry = {
    manifest,
    source: {
      type: 'bundled-directory',
      relativePath: path
        .relative(path.dirname(indexPath), packageRoot)
        .split(path.sep)
        .join('/'),
    },
    sha256: sha256 ?? (await hashPluginDirectory(packageRoot)),
  };
  if (publisher) {
    entry.publisherSignature = {
      keyId: publisher.keyId,
      signature: sign(
        null,
        Buffer.from(canonicalizePluginPublisherAttestation(entry), 'utf8'),
        publisher.privateKey,
      ).toString('base64'),
    };
  }
  const payloadBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: NOW - 1_000,
      expiresAt,
      publisherKeys: publisher
        ? [
            {
              publisherId: publisher.publisherId,
              publisherName: publisher.publisherName,
              keyId: publisher.keyId,
              publicKey: publisher.publicKey,
              status: publisher.status,
            },
          ]
        : undefined,
      plugins: [entry],
    }),
  );
  await fs.writeFile(
    indexPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        keyId: KEY_ID,
        payload: payloadBytes.toString('base64'),
        signature: sign(null, payloadBytes, privateKey).toString('base64'),
      },
      null,
      2,
    )}\n`,
  );
}

async function createHarness(options?: {
  enabled?: boolean;
  initialSource?: PluginMarketplaceInstallSource;
  saveLock?: (
    lockfile: Parameters<
      NonNullable<
        Parameters<typeof PluginMarketplaceService.create>[0]['saveLock']
      >
    >[0],
  ) => Promise<void>;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clodex-market-test-'));
  temporaryRoots.push(root);
  const marketplaceRoot = path.join(root, 'marketplace');
  const packageRoot = path.join(
    marketplaceRoot,
    'packages',
    'release-readiness',
  );
  const indexPath = path.join(marketplaceRoot, 'index.json');
  const installedDir = path.join(root, 'installed');
  const stagingDir = path.join(root, 'staging');
  const lockPath = path.join(root, 'lock.json');
  await fs.mkdir(marketplaceRoot, { recursive: true });

  const keyPair = generateKeyPairSync('ed25519');
  const manifest = createManifest();
  await writePackage(packageRoot, manifest);
  await writeSignedIndex({
    indexPath,
    privateKey: keyPair.privateKey,
    manifest,
    packageRoot,
  });
  let initialLock: unknown;
  if (options?.initialSource) {
    const installPath = path.join(installedDir, manifest.id);
    await fs.mkdir(installedDir, { recursive: true });
    await fs.cp(packageRoot, installPath, { recursive: true });
    initialLock = {
      schemaVersion: 1,
      plugins: {
        [manifest.id]: {
          id: manifest.id,
          version: manifest.version,
          sha256: await hashPluginDirectory(installPath),
          source: options.initialSource,
          installedAt: NOW - 1_000,
          updatedAt: NOW - 1_000,
          manifest,
        },
      },
    };
  }

  const karton = createKarton();
  const service = await PluginMarketplaceService.create({
    logger,
    karton: karton.service,
    isFeatureEnabled: () => options?.enabled ?? true,
    trustedKeys: {
      [KEY_ID]: keyPair.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
    },
    appVersion: APP_VERSION,
    now: () => NOW,
    indexPath,
    installedDir,
    stagingDir,
    lockPath,
    loadLock: initialLock ? async () => initialLock : undefined,
    saveLock: options?.saveLock,
  });

  return {
    indexPath,
    installedDir,
    karton,
    keyPair,
    lockPath,
    manifest,
    packageRoot,
    service,
  };
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('PluginMarketplaceService', () => {
  it('verifies the repository bundled catalog with the committed public key', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'clodex-bundled-market-test-'),
    );
    temporaryRoots.push(root);
    const karton = createKarton();
    const service = await PluginMarketplaceService.create({
      logger,
      karton: karton.service,
      isFeatureEnabled: () => true,
      trustedKeys: OFFICIAL_PLUGIN_MARKETPLACE_KEYS,
      appVersion: APP_VERSION,
      now: () => NOW,
      indexPath: path.resolve('bundled/marketplace/index.json'),
      installedDir: path.join(root, 'installed'),
      stagingDir: path.join(root, 'staging'),
      lockPath: path.join(root, 'lock.json'),
    });

    expect(service.getState()).toMatchObject({
      status: 'ready',
      catalog: [
        {
          manifest: { id: 'release-readiness', version: '1.0.0' },
          compatible: true,
        },
      ],
    });
    await service.teardown();
  });

  it('verifies the signed official index and exposes gate state read-only', async () => {
    const harness = await createHarness();

    expect(harness.service.getState()).toMatchObject({
      enabled: true,
      status: 'ready',
      keyId: KEY_ID,
      catalog: [
        {
          manifest: { id: 'release-readiness', version: '1.0.0' },
          compatible: true,
          installedVersion: null,
        },
      ],
    });
    expect(harness.karton.handlers.has('pluginMarketplace.getState')).toBe(
      true,
    );

    await harness.service.teardown();
    expect(harness.karton.handlers.size).toBe(0);
  });

  it('rejects tampered signatures and expired indexes', async () => {
    const harness = await createHarness();
    const envelope = JSON.parse(
      await fs.readFile(harness.indexPath, 'utf8'),
    ) as { signature: string };
    envelope.signature = Buffer.alloc(64, 7).toString('base64');
    await fs.writeFile(harness.indexPath, JSON.stringify(envelope));

    await expect(harness.service.refresh()).rejects.toThrow(
      'signature is invalid',
    );
    expect(harness.service.getState()).toMatchObject({
      status: 'error',
      catalog: [],
    });

    await writeSignedIndex({
      indexPath: harness.indexPath,
      privateKey: harness.keyPair.privateKey,
      manifest: harness.manifest,
      packageRoot: harness.packageRoot,
      expiresAt: NOW,
    });
    await expect(harness.service.refresh()).rejects.toThrow(
      'index has expired',
    );
    await harness.service.teardown();
  });

  it('installs and uninstalls through staging with an integrity lockfile', async () => {
    const harness = await createHarness();

    await expect(
      harness.service.install('release-readiness'),
    ).resolves.toMatchObject({
      ok: true,
      operation: 'install',
    });
    const installedRoot = path.join(harness.installedDir, 'release-readiness');
    const lock = JSON.parse(await fs.readFile(harness.lockPath, 'utf8')) as {
      plugins: Record<string, { version: string; sha256: string }>;
    };
    expect(lock.plugins['release-readiness']).toMatchObject({
      version: '1.0.0',
      sha256: await hashPluginDirectory(installedRoot),
    });
    expect(harness.service.getState().installed).toHaveLength(1);

    await expect(
      harness.service.uninstall('release-readiness'),
    ).resolves.toMatchObject({
      ok: true,
      operation: 'uninstall',
    });
    await expect(fs.access(installedRoot)).rejects.toThrow();
    expect(harness.service.getState().installed).toHaveLength(0);
    await harness.service.teardown();
  });

  it('keeps private source provenance scoped in the lockfile', async () => {
    const privateSource: PluginMarketplaceInstallSource = {
      kind: 'private-marketplace',
      sourceId: 'engineering',
      signingKeyId: 'engineering-2026-01',
      signingKeyFingerprint: `sha256:${'a'.repeat(64)}`,
    };
    const harness = await createHarness({ initialSource: privateSource });

    expect(harness.service.getState()).toMatchObject({
      installed: [
        {
          id: 'release-readiness',
          source: privateSource,
        },
      ],
      catalog: [
        {
          manifest: { id: 'release-readiness' },
          compatible: false,
          compatibilityError:
            'Plugin is installed from a private marketplace source.',
          installedVersion: null,
        },
      ],
    });
    await expect(
      harness.service.uninstall('release-readiness'),
    ).resolves.toMatchObject({
      ok: false,
      error: 'Plugin is installed from another marketplace source.',
    });
    await expect(
      harness.service.uninstallVerifiedPlugin(
        'release-readiness',
        privateSource,
      ),
    ).resolves.toMatchObject({ ok: true, operation: 'uninstall' });
    await harness.service.teardown();
  });

  it('quarantines an installed plugin when startup integrity verification fails', async () => {
    const harness = await createHarness();
    await harness.service.install('release-readiness');
    await harness.service.teardown();

    const installedRoot = path.join(harness.installedDir, 'release-readiness');
    await fs.appendFile(
      path.join(installedRoot, 'SKILL.md'),
      '\nTampered after install.\n',
    );
    const karton = createKarton();
    const restarted = await PluginMarketplaceService.create({
      logger,
      karton: karton.service,
      isFeatureEnabled: () => true,
      trustedKeys: {
        [KEY_ID]: harness.keyPair.publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString(),
      },
      appVersion: APP_VERSION,
      now: () => NOW,
      indexPath: harness.indexPath,
      installedDir: harness.installedDir,
      stagingDir: path.join(path.dirname(harness.installedDir), 'staging'),
      lockPath: harness.lockPath,
    });

    expect(restarted.getState()).toMatchObject({
      status: 'ready',
      installed: [],
      warnings: [
        expect.stringContaining('installed package integrity hash changed'),
      ],
    });
    await expect(fs.access(installedRoot)).rejects.toThrow();
    await restarted.teardown();
  });

  it('rejects hash mismatch, undeclared capabilities, and incompatible apps', async () => {
    const harness = await createHarness();

    await writeSignedIndex({
      indexPath: harness.indexPath,
      privateKey: harness.keyPair.privateKey,
      manifest: harness.manifest,
      packageRoot: harness.packageRoot,
      sha256: '0'.repeat(64),
    });
    await harness.service.refresh();
    await expect(
      harness.service.install('release-readiness'),
    ).resolves.toMatchObject({
      ok: false,
      error: 'Plugin package integrity check failed',
    });

    const undeclared = createManifest('1.0.1', { permissions: [] });
    await writePackage(harness.packageRoot, undeclared);
    await fs.writeFile(
      path.join(harness.packageRoot, 'SKILL.md'),
      '---\nname: Undeclared\ndescription: Undeclared skill content.\n---\n',
    );
    await writeSignedIndex({
      indexPath: harness.indexPath,
      privateKey: harness.keyPair.privateKey,
      manifest: undeclared,
      packageRoot: harness.packageRoot,
    });
    await harness.service.refresh();
    await expect(
      harness.service.install('release-readiness'),
    ).resolves.toMatchObject({
      ok: false,
      error: 'Plugin package contains skills without skills permission',
    });

    const incompatible = createManifest('1.0.2', {
      compatibility: { minAppVersion: '9.0.0' },
    });
    await writePackage(harness.packageRoot, incompatible);
    await writeSignedIndex({
      indexPath: harness.indexPath,
      privateKey: harness.keyPair.privateKey,
      manifest: incompatible,
      packageRoot: harness.packageRoot,
    });
    await harness.service.refresh();
    await expect(
      harness.service.install('release-readiness'),
    ).resolves.toMatchObject({
      ok: false,
      error: 'Requires Clodex 9.0.0 or newer.',
    });
    await harness.service.teardown();
  });

  it('exposes signed MCP summaries and verifies package declarations match', async () => {
    const harness = await createHarness();
    const mcpManifest = createManifest('2.0.0', {
      permissions: ['mcp', 'network'],
      mcpServers: [
        {
          id: 'learn',
          displayName: 'Microsoft Learn',
          transport: 'streamable-http',
          endpoint: 'https://learn.microsoft.com/api/mcp',
          authentication: 'none',
        },
      ],
    });
    await writePackage(harness.packageRoot, mcpManifest);
    await writeSignedIndex({
      indexPath: harness.indexPath,
      privateKey: harness.keyPair.privateKey,
      manifest: mcpManifest,
      packageRoot: harness.packageRoot,
    });
    await harness.service.refresh();

    expect(harness.service.getState().catalog[0]?.manifest.mcpServers).toEqual(
      mcpManifest.mcpServers,
    );
    await expect(
      harness.service.install('release-readiness'),
    ).resolves.toMatchObject({ ok: true });
    await harness.service.uninstall('release-readiness');

    const serversPath = path.join(harness.packageRoot, 'mcp', 'servers.json');
    const declarations = JSON.parse(await fs.readFile(serversPath, 'utf8')) as {
      servers: Array<{ transport: { url: string } }>;
    };
    declarations.servers[0]!.transport.url =
      'https://malicious.example.com/mcp';
    await fs.writeFile(serversPath, JSON.stringify(declarations));
    await writeSignedIndex({
      indexPath: harness.indexPath,
      privateKey: harness.keyPair.privateKey,
      manifest: mcpManifest,
      packageRoot: harness.packageRoot,
    });
    await harness.service.refresh();

    await expect(
      harness.service.install('release-readiness'),
    ).resolves.toMatchObject({
      ok: false,
      error: 'Plugin MCP declarations do not match the signed catalog summary',
    });
    await harness.service.teardown();
  });

  it('verifies publisher signatures and rejects revoked publisher keys', async () => {
    const harness = await createHarness();
    const publisherKeyPair = generateKeyPairSync('ed25519');
    const publisher = {
      publisherId: 'clodex-tests',
      publisherName: 'Clodex Tests',
      keyId: 'clodex-tests-2026-01',
      publicKey: publisherKeyPair.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
      privateKey: publisherKeyPair.privateKey,
      status: 'active' as const,
    };
    const publisherManifest = createManifest('2.0.0', {
      publisherId: publisher.publisherId,
    });
    await writePackage(harness.packageRoot, publisherManifest);
    await writeSignedIndex({
      indexPath: harness.indexPath,
      privateKey: harness.keyPair.privateKey,
      manifest: publisherManifest,
      packageRoot: harness.packageRoot,
      publisher,
    });
    await harness.service.refresh();

    expect(harness.service.getState().catalog[0]).toMatchObject({
      publisherVerified: true,
      publisherKeyId: publisher.keyId,
    });
    await expect(
      harness.service.install('release-readiness'),
    ).resolves.toMatchObject({ ok: true });
    expect(harness.service.getState().installed[0]).toMatchObject({
      publisherKeyId: publisher.keyId,
      publisherSignature: expect.any(String),
    });
    await harness.service.uninstall('release-readiness');

    await writeSignedIndex({
      indexPath: harness.indexPath,
      privateKey: harness.keyPair.privateKey,
      manifest: publisherManifest,
      packageRoot: harness.packageRoot,
      publisher: { ...publisher, status: 'revoked' },
    });
    await expect(harness.service.refresh()).rejects.toThrow(
      `Publisher signing key is revoked: ${publisher.keyId}`,
    );

    const unrelatedKeyPair = generateKeyPairSync('ed25519');
    await writeSignedIndex({
      indexPath: harness.indexPath,
      privateKey: harness.keyPair.privateKey,
      manifest: publisherManifest,
      packageRoot: harness.packageRoot,
      publisher: {
        ...publisher,
        publicKey: unrelatedKeyPair.publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString(),
        status: 'active',
      },
    });
    await expect(harness.service.refresh()).rejects.toThrow(
      'Publisher signature is invalid for plugin release-readiness',
    );
    await harness.service.teardown();
  });

  it('rolls an update back when the lockfile cannot be committed', async () => {
    let failWrites = false;
    let persistedLock: unknown = { schemaVersion: 1, plugins: {} };
    const harness = await createHarness({
      saveLock: async (lockfile) => {
        if (failWrites) throw new Error('simulated lock write failure');
        persistedLock = structuredClone(lockfile);
      },
    });

    await expect(
      harness.service.install('release-readiness'),
    ).resolves.toMatchObject({ ok: true });
    const versionTwo = createManifest('2.0.0');
    await writePackage(harness.packageRoot, versionTwo);
    await writeSignedIndex({
      indexPath: harness.indexPath,
      privateKey: harness.keyPair.privateKey,
      manifest: versionTwo,
      packageRoot: harness.packageRoot,
    });
    await harness.service.refresh();
    failWrites = true;

    await expect(
      harness.service.update('release-readiness'),
    ).resolves.toMatchObject({
      ok: false,
      operation: 'update',
      rolledBack: true,
      error: 'simulated lock write failure',
    });
    const restoredManifest = JSON.parse(
      await fs.readFile(
        path.join(harness.installedDir, 'release-readiness', 'plugin.json'),
        'utf8',
      ),
    ) as PluginMarketplaceManifest;
    expect(restoredManifest.version).toBe('1.0.0');
    expect(persistedLock).toMatchObject({
      plugins: { 'release-readiness': { version: '1.0.0' } },
    });
    await harness.service.teardown();
  });

  it('keeps read-only state available while the feature gate blocks changes', async () => {
    const harness = await createHarness({ enabled: false });

    expect(harness.service.getState()).toMatchObject({
      enabled: false,
      status: 'ready',
    });
    await expect(harness.service.install('release-readiness')).rejects.toThrow(
      'Feature gate is disabled',
    );

    const getState = harness.karton.handlers.get('pluginMarketplace.getState');
    await expect(getState?.('client')).resolves.toMatchObject({
      enabled: false,
    });
    await harness.service.teardown();
  });
});
