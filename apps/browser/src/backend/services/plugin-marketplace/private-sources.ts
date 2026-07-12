import { createHash, verify } from 'node:crypto';
import semver from 'semver';
import {
  pluginMarketplaceIndexPayloadSchema,
  privateMarketplaceSourceSchema,
  privateMarketplaceSourceInputSchema,
  privateMarketplaceSourcesConfigSchema,
  signedPluginMarketplaceIndexSchema,
  type PluginMarketplaceIndexPayload,
  type PluginMarketplaceInstallSource,
  type PluginMarketplaceOperationResult,
  type PrivateMarketplaceSource,
  type PrivateMarketplaceSourceInput,
  type PrivateMarketplaceOperationResult,
  type PrivateMarketplaceSourcePublic,
  type PrivateMarketplaceSourcesConfig,
  type PrivateMarketplaceSourcesState,
} from '@shared/plugin-marketplace';
import type { FeatureGateId } from '@shared/feature-gates';
import { DisposableService } from '@/services/disposable';
import type { KartonService } from '@/services/karton';
import type { Logger } from '@/services/logger';
import { readPersistedData, writePersistedData } from '@/utils/persisted-data';
import {
  parseEd25519PublicKey,
  verifyPublisherSignatures,
} from './verification';
import {
  getPluginCompatibilityError,
  type PluginMarketplaceService,
} from './index';

const STORAGE_NAME = 'private-marketplace-sources' as const;
const STORAGE_OPTIONS = {
  encrypt: true,
  requireEncryption: true,
  allowPlaintextMigration: false,
} as const;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const INDEX_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_CONFIG: PrivateMarketplaceSourcesConfig = {
  schemaVersion: 1,
  sources: [],
};
const PROCEDURE_NAMES = [
  'pluginMarketplace.privateSources.list',
  'pluginMarketplace.privateSources.save',
  'pluginMarketplace.privateSources.remove',
  'pluginMarketplace.privateSources.setEnabled',
  'pluginMarketplace.privateSources.refresh',
  'pluginMarketplace.privateSources.install',
  'pluginMarketplace.privateSources.update',
  'pluginMarketplace.privateSources.uninstall',
] as const;

type SourceRuntimeState = {
  status: 'idle' | 'ready' | 'error';
  generatedAt: number | null;
  expiresAt: number | null;
  refreshedAt: number | null;
  pluginCount: number;
  error: string | null;
};

const EMPTY_RUNTIME_STATE: SourceRuntimeState = {
  status: 'idle',
  generatedAt: null,
  expiresAt: null,
  refreshedAt: null,
  pluginCount: 0,
  error: null,
};

export type PrivateMarketplaceSourcesServiceOptions = {
  logger: Logger;
  karton: KartonService;
  isFeatureEnabled: (feature: FeatureGateId) => boolean;
  now?: () => number;
  fetcher?: typeof fetch;
  appVersion: string;
  installer: Pick<
    PluginMarketplaceService,
    'getState' | 'installVerifiedEntry' | 'uninstallVerifiedPlugin'
  >;
  loadConfig?: () => Promise<unknown>;
  saveConfig?: (config: PrivateMarketplaceSourcesConfig) => Promise<void>;
};

function decodeCanonicalBase64(value: string, label: string): Buffer {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error(`${label} is not valid base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}

async function readResponseBodyBounded(response: Response): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_INDEX_BYTES) {
    throw new Error('Private marketplace index exceeds the size limit');
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const buffer = Buffer.from(chunk.value);
      totalBytes += buffer.length;
      if (totalBytes > MAX_INDEX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Private marketplace index exceeds the size limit');
      }
      chunks.push(buffer);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function validatePayload(
  payload: PluginMarketplaceIndexPayload,
  now: number,
): void {
  if (payload.generatedAt >= payload.expiresAt) {
    throw new Error(
      'Private marketplace index expiration must follow generation time',
    );
  }
  if (payload.expiresAt <= now) {
    throw new Error('Private marketplace index has expired');
  }
  const pluginIds = new Set<string>();
  for (const entry of payload.plugins) {
    if (pluginIds.has(entry.manifest.id)) {
      throw new Error(
        `Private marketplace index contains duplicate plugin: ${entry.manifest.id}`,
      );
    }
    pluginIds.add(entry.manifest.id);
    if (entry.source.type !== 'https') {
      throw new Error(
        `Private marketplace plugin ${entry.manifest.id} must use an HTTPS package source`,
      );
    }
  }
}

export class PrivateMarketplaceSourcesService extends DisposableService {
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private config: PrivateMarketplaceSourcesConfig =
    structuredClone(DEFAULT_CONFIG);
  private readonly runtime = new Map<string, SourceRuntimeState>();
  private readonly verifiedIndexes = new Map<
    string,
    PluginMarketplaceIndexPayload
  >();
  private readonly publisherVerification = new Map<
    string,
    Map<string, string>
  >();
  private operationQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: PrivateMarketplaceSourcesServiceOptions,
  ) {
    super();
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? fetch;
  }

  public static async create(
    options: PrivateMarketplaceSourcesServiceOptions,
  ): Promise<PrivateMarketplaceSourcesService> {
    const service = new PrivateMarketplaceSourcesService(options);
    await service.initialize();
    return service;
  }

  public list(): PrivateMarketplaceSourcesState {
    this.assertNotDisposed();
    return {
      enabled: this.options.isFeatureEnabled('plugin-marketplace'),
      sources: this.config.sources
        .map((source) => this.toPublic(source))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    };
  }

  public async save(
    rawInput: PrivateMarketplaceSourceInput,
  ): Promise<PrivateMarketplaceSourcePublic> {
    return await this.runExclusive(async () => {
      this.assertFeature();
      const input = privateMarketplaceSourceInputSchema.parse(rawInput);
      const key = parseEd25519PublicKey(
        input.signingPublicKey,
        'Private marketplace signing key',
      );
      const canonicalPublicKey = key
        .export({ type: 'spki', format: 'pem' })
        .toString()
        .trim();
      const canonicalIndexUrl = new URL(input.indexUrl).toString();
      const existing = this.findSource(input.id);
      if (
        existing &&
        this.hasInstalledPlugins(existing.id) &&
        (existing.indexUrl !== canonicalIndexUrl ||
          existing.signingKeyId !== input.signingKeyId ||
          existing.signingPublicKey.trim() !== canonicalPublicKey)
      ) {
        throw new Error(
          'Uninstall plugins from this source before changing its URL or signing key',
        );
      }
      const duplicate = this.config.sources.find(
        (source) =>
          source.id !== input.id &&
          new URL(source.indexUrl).toString() === canonicalIndexUrl,
      );
      if (duplicate) {
        throw new Error(
          `Private marketplace index URL is already used by ${duplicate.id}`,
        );
      }
      const now = this.now();
      const stored = privateMarketplaceSourceInputSchema.parse({
        ...input,
        indexUrl: canonicalIndexUrl,
        signingPublicKey: canonicalPublicKey,
      });
      const source: PrivateMarketplaceSource = {
        schemaVersion: 1,
        ...stored,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const next = structuredClone(this.config);
      const existingIndex = next.sources.findIndex(
        (candidate) => candidate.id === source.id,
      );
      if (existingIndex === -1) next.sources.push(source);
      else next.sources[existingIndex] = source;
      const parsed = privateMarketplaceSourcesConfigSchema.parse(next);
      await this.persist(parsed);
      this.config = parsed;
      this.resetRuntime(source.id);
      return this.toPublic(source);
    });
  }

  public async remove(id: string): Promise<PrivateMarketplaceSourcesState> {
    return await this.runExclusive(async () => {
      this.assertFeature();
      if (!this.findSource(id)) {
        throw new Error(`Private marketplace source not found: ${id}`);
      }
      if (this.hasInstalledPlugins(id)) {
        throw new Error(
          'Uninstall plugins from this source before removing it',
        );
      }
      const next: PrivateMarketplaceSourcesConfig = {
        ...this.config,
        sources: this.config.sources.filter((source) => source.id !== id),
      };
      const parsed = privateMarketplaceSourcesConfigSchema.parse(next);
      await this.persist(parsed);
      this.config = parsed;
      this.resetRuntime(id);
      return this.list();
    });
  }

  public async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<PrivateMarketplaceSourcePublic> {
    return await this.runExclusive(async () => {
      this.assertFeature();
      const existing = this.requireSource(id);
      const next = structuredClone(this.config);
      const index = next.sources.findIndex((source) => source.id === id);
      const updated = privateMarketplaceSourceSchema.parse({
        ...existing,
        enabled,
        updatedAt: this.now(),
      });
      next.sources[index] = updated;
      const parsed = privateMarketplaceSourcesConfigSchema.parse(next);
      await this.persist(parsed);
      this.config = parsed;
      if (!enabled) this.resetRuntime(id);
      return this.toPublic(updated);
    });
  }

  public async refresh(id: string): Promise<PrivateMarketplaceSourcePublic> {
    return await this.runExclusive(async () => {
      this.assertFeature();
      const source = this.requireSource(id);
      if (!source.enabled) {
        throw new Error(`Private marketplace source is disabled: ${id}`);
      }
      try {
        const response = await this.fetcher(source.indexUrl, {
          redirect: 'error',
          signal: AbortSignal.timeout(INDEX_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(
            `Private marketplace index request failed with HTTP ${response.status}`,
          );
        }
        const body = await readResponseBodyBounded(response);
        const envelope = signedPluginMarketplaceIndexSchema.parse(
          JSON.parse(body.toString('utf8')),
        );
        if (envelope.keyId !== source.signingKeyId) {
          throw new Error(
            `Private marketplace signing key ID mismatch: expected ${source.signingKeyId}`,
          );
        }
        const payloadBytes = decodeCanonicalBase64(
          envelope.payload,
          'Private marketplace index payload',
        );
        const signature = decodeCanonicalBase64(
          envelope.signature,
          'Private marketplace index signature',
        );
        const publicKey = parseEd25519PublicKey(
          source.signingPublicKey,
          'Private marketplace signing key',
        );
        if (!verify(null, payloadBytes, publicKey, signature)) {
          throw new Error('Private marketplace index signature is invalid');
        }
        const payload = pluginMarketplaceIndexPayloadSchema.parse(
          JSON.parse(payloadBytes.toString('utf8')),
        );
        const refreshedAt = this.now();
        validatePayload(payload, refreshedAt);
        const publisherVerification = verifyPublisherSignatures(payload);
        this.verifiedIndexes.set(id, structuredClone(payload));
        this.publisherVerification.set(id, publisherVerification);
        this.runtime.set(id, {
          status: 'ready',
          generatedAt: payload.generatedAt,
          expiresAt: payload.expiresAt,
          refreshedAt,
          pluginCount: payload.plugins.length,
          error: null,
        });
        return this.toPublic(source);
      } catch (error) {
        this.verifiedIndexes.delete(id);
        this.publisherVerification.delete(id);
        this.runtime.set(id, {
          ...EMPTY_RUNTIME_STATE,
          status: 'error',
          refreshedAt: this.now(),
          error: this.errorMessage(error),
        });
        throw error;
      }
    });
  }

  public getVerifiedIndex(id: string): PluginMarketplaceIndexPayload | null {
    this.assertNotDisposed();
    const payload = this.verifiedIndexes.get(id);
    return payload ? structuredClone(payload) : null;
  }

  public async install(
    sourceId: string,
    pluginId: string,
  ): Promise<PrivateMarketplaceOperationResult> {
    return await this.installOrUpdate(sourceId, pluginId, 'install');
  }

  public async update(
    sourceId: string,
    pluginId: string,
  ): Promise<PrivateMarketplaceOperationResult> {
    return await this.installOrUpdate(sourceId, pluginId, 'update');
  }

  public async uninstall(
    sourceId: string,
    pluginId: string,
  ): Promise<PrivateMarketplaceOperationResult> {
    return await this.runExclusive(async () => {
      this.assertFeature();
      const source = this.requireSource(sourceId);
      const result = await this.options.installer.uninstallVerifiedPlugin(
        pluginId,
        this.toInstallSource(source),
      );
      return this.toPrivateOperationResult(sourceId, result);
    });
  }

  private async initialize(): Promise<void> {
    const loaded = this.options.loadConfig
      ? await this.options.loadConfig()
      : await readPersistedData(
          STORAGE_NAME,
          privateMarketplaceSourcesConfigSchema,
          DEFAULT_CONFIG,
          STORAGE_OPTIONS,
        );
    this.config = privateMarketplaceSourcesConfigSchema.parse(loaded);
    for (const source of this.config.sources) {
      parseEd25519PublicKey(
        source.signingPublicKey,
        `Private marketplace signing key for ${source.id}`,
      );
    }
    this.registerProcedures();
  }

  private registerProcedures(): void {
    const { karton } = this.options;
    karton.registerServerProcedureHandler(
      'pluginMarketplace.privateSources.list',
      async () => this.list(),
    );
    karton.registerServerProcedureHandler(
      'pluginMarketplace.privateSources.save',
      async (_clientId, input: PrivateMarketplaceSourceInput) =>
        this.save(input),
    );
    karton.registerServerProcedureHandler(
      'pluginMarketplace.privateSources.remove',
      async (_clientId, id: string) => this.remove(id),
    );
    karton.registerServerProcedureHandler(
      'pluginMarketplace.privateSources.setEnabled',
      async (_clientId, id: string, enabled: boolean) =>
        this.setEnabled(id, enabled),
    );
    karton.registerServerProcedureHandler(
      'pluginMarketplace.privateSources.refresh',
      async (_clientId, id: string) => this.refresh(id),
    );
    karton.registerServerProcedureHandler(
      'pluginMarketplace.privateSources.install',
      async (_clientId, sourceId: string, pluginId: string) =>
        this.install(sourceId, pluginId),
    );
    karton.registerServerProcedureHandler(
      'pluginMarketplace.privateSources.update',
      async (_clientId, sourceId: string, pluginId: string) =>
        this.update(sourceId, pluginId),
    );
    karton.registerServerProcedureHandler(
      'pluginMarketplace.privateSources.uninstall',
      async (_clientId, sourceId: string, pluginId: string) =>
        this.uninstall(sourceId, pluginId),
    );
  }

  private toPublic(
    source: PrivateMarketplaceSource,
  ): PrivateMarketplaceSourcePublic {
    const storedRuntime = this.runtime.get(source.id) ?? EMPTY_RUNTIME_STATE;
    const expired =
      storedRuntime.status === 'ready' &&
      storedRuntime.expiresAt !== null &&
      storedRuntime.expiresAt <= this.now();
    const runtime = expired
      ? {
          ...storedRuntime,
          status: 'error' as const,
          pluginCount: 0,
          error: 'Private marketplace index has expired',
        }
      : storedRuntime;
    const payload = expired ? undefined : this.verifiedIndexes.get(source.id);
    const publisherVerification = this.publisherVerification.get(source.id);
    const installed = new Map(
      this.options.installer
        .getState()
        .installed.map((entry) => [entry.id, entry]),
    );
    const installSource = this.toInstallSource(source);
    const catalog =
      payload?.plugins
        .map((entry) => {
          const installedEntry = installed.get(entry.manifest.id);
          const installedFromSource =
            installedEntry !== undefined &&
            this.installSourcesMatch(installedEntry.source, installSource);
          const sourceConflict =
            installedEntry && !installedFromSource
              ? 'Plugin is installed from another marketplace source.'
              : null;
          const compatibilityError =
            sourceConflict ??
            getPluginCompatibilityError(
              entry.manifest,
              this.options.appVersion,
            );
          return {
            sourceId: source.id,
            manifest: entry.manifest,
            sha256: entry.sha256,
            publisherVerified:
              publisherVerification?.has(entry.manifest.id) ?? false,
            publisherKeyId:
              publisherVerification?.get(entry.manifest.id) ?? null,
            compatible: compatibilityError === null,
            compatibilityError,
            installedFromSource,
            sourceConflict,
            installedVersion: installedFromSource
              ? (installedEntry?.version ?? null)
              : null,
            updateAvailable:
              installedFromSource &&
              installedEntry !== undefined &&
              semver.gt(entry.manifest.version, installedEntry.version),
          };
        })
        .sort((a, b) =>
          a.manifest.displayName.localeCompare(b.manifest.displayName),
        ) ?? [];
    return {
      id: source.id,
      displayName: source.displayName,
      indexUrl: source.indexUrl,
      signingKeyId: source.signingKeyId,
      signingKeyFingerprint: this.getSigningKeyFingerprint(source),
      enabled: source.enabled,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      ...runtime,
      catalog,
    };
  }

  private findSource(id: string): PrivateMarketplaceSource | undefined {
    return this.config.sources.find((source) => source.id === id);
  }

  private requireSource(id: string): PrivateMarketplaceSource {
    const source = this.findSource(id);
    if (!source) {
      throw new Error(`Private marketplace source not found: ${id}`);
    }
    return source;
  }

  private resetRuntime(id: string): void {
    this.runtime.delete(id);
    this.verifiedIndexes.delete(id);
    this.publisherVerification.delete(id);
  }

  private async installOrUpdate(
    sourceId: string,
    pluginId: string,
    requestedOperation: 'install' | 'update',
  ): Promise<PrivateMarketplaceOperationResult> {
    return await this.runExclusive(async () => {
      this.assertFeature();
      const source = this.requireSource(sourceId);
      if (!source.enabled) {
        throw new Error(`Private marketplace source is disabled: ${sourceId}`);
      }
      const payload = this.verifiedIndexes.get(sourceId);
      if (!payload || payload.expiresAt <= this.now()) {
        this.resetRuntime(sourceId);
        throw new Error(
          'Refresh and verify the private marketplace source before installing',
        );
      }
      const entry = payload.plugins.find(
        (candidate) => candidate.manifest.id === pluginId,
      );
      if (!entry) {
        throw new Error(
          `Plugin is not present in private marketplace source ${sourceId}`,
        );
      }
      const result = await this.options.installer.installVerifiedEntry(
        entry,
        this.toInstallSource(source),
        this.publisherVerification.get(sourceId)?.get(pluginId),
        requestedOperation,
      );
      return this.toPrivateOperationResult(sourceId, result);
    });
  }

  private toPrivateOperationResult(
    sourceId: string,
    result: PluginMarketplaceOperationResult,
  ): PrivateMarketplaceOperationResult {
    if (result.ok) {
      return {
        ok: true,
        operation: result.operation,
        pluginId: result.pluginId,
        sourceId,
        state: this.list(),
      };
    }
    return {
      ok: false,
      operation: result.operation,
      pluginId: result.pluginId,
      sourceId,
      error: result.error,
      rolledBack: result.rolledBack,
      state: this.list(),
    };
  }

  private getSigningKeyFingerprint(source: PrivateMarketplaceSource): string {
    const publicKey = parseEd25519PublicKey(
      source.signingPublicKey,
      `Private marketplace signing key for ${source.id}`,
    );
    const fingerprint = createHash('sha256')
      .update(
        publicKey.export({
          type: 'spki',
          format: 'der',
        }),
      )
      .digest('hex');
    return `sha256:${fingerprint}`;
  }

  private toInstallSource(
    source: PrivateMarketplaceSource,
  ): PluginMarketplaceInstallSource {
    return {
      kind: 'private-marketplace',
      sourceId: source.id,
      signingKeyId: source.signingKeyId,
      signingKeyFingerprint: this.getSigningKeyFingerprint(source),
    };
  }

  private hasInstalledPlugins(sourceId: string): boolean {
    return this.options.installer
      .getState()
      .installed.some(
        (entry) =>
          entry.source !== 'official' && entry.source.sourceId === sourceId,
      );
  }

  private installSourcesMatch(
    left: PluginMarketplaceInstallSource,
    right: PluginMarketplaceInstallSource,
  ): boolean {
    if (left === 'official' || right === 'official') return left === right;
    return (
      left.sourceId === right.sourceId &&
      left.signingKeyId === right.signingKeyId &&
      left.signingKeyFingerprint === right.signingKeyFingerprint
    );
  }

  private async persist(
    config: PrivateMarketplaceSourcesConfig,
  ): Promise<void> {
    if (this.options.saveConfig) {
      await this.options.saveConfig(config);
      return;
    }
    await writePersistedData(
      STORAGE_NAME,
      privateMarketplaceSourcesConfigSchema,
      config,
      STORAGE_OPTIONS,
    );
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.assertNotDisposed();
    const previous = this.operationQueue;
    let release: () => void = () => undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private assertFeature(): void {
    if (!this.options.isFeatureEnabled('plugin-marketplace')) {
      throw new Error('Feature gate is disabled: plugin-marketplace');
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  protected onTeardown(): void {
    for (const procedureName of PROCEDURE_NAMES) {
      this.options.karton.removeServerProcedureHandler(procedureName);
    }
    this.runtime.clear();
    this.verifiedIndexes.clear();
    this.publisherVerification.clear();
    this.options.logger.debug(
      '[PrivateMarketplace] Private source registry disposed',
    );
  }
}
