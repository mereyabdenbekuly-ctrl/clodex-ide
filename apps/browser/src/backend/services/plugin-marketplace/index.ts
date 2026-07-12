import { createHash, randomUUID, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';
import * as yauzl from 'yauzl';
import { pluginMetadataSchema } from '@shared/plugins';
import {
  pluginMarketplaceIndexPayloadSchema,
  pluginMarketplaceLockfileSchema,
  pluginMarketplaceManifestSchema,
  signedPluginMarketplaceIndexSchema,
  type PluginMarketplaceIndexPayload,
  type PluginMarketplaceIndexEntry,
  type PluginMarketplaceInstallSource,
  type PluginMarketplaceLockfile,
  type PluginMarketplaceManifest,
  type PluginMarketplaceOperationResult,
  type PluginMarketplacePackageSource,
  type PluginMarketplaceState,
} from '@shared/plugin-marketplace';
import type { FeatureGateId } from '@shared/feature-gates';
import {
  getBundledPluginMarketplaceIndexPath,
  getInstalledPluginsDir,
  getPluginMarketplaceLockPath,
  getPluginMarketplaceStagingDir,
} from '@/utils/paths';
import type { KartonService } from '@/services/karton';
import type { Logger } from '@/services/logger';
import { DisposableService } from '@/services/disposable';
import {
  readPluginMcpServerDeclarations,
  readPluginRuntimeManifest,
  summarizePluginMcpServers,
} from '@/services/mcp/plugin-bridge';
import { verifyPublisherSignatures } from './verification';

const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_PACKAGE_FILES = 1_000;
const LOCK_SCHEMA_VERSION = 1;
const BACKUP_PREFIX = '.backup.';

const DEFAULT_LOCKFILE: PluginMarketplaceLockfile = {
  schemaVersion: LOCK_SCHEMA_VERSION,
  plugins: {},
};

const PROCEDURE_NAMES = [
  'pluginMarketplace.getState',
  'pluginMarketplace.refresh',
  'pluginMarketplace.install',
  'pluginMarketplace.update',
  'pluginMarketplace.uninstall',
] as const;

export type PluginMarketplaceAuditEvent = {
  operation: 'refresh' | 'install' | 'update' | 'uninstall' | 'rollback';
  success: boolean;
  durationMs: number;
  pluginId?: string;
  version?: string;
  permissionCount?: number;
  catalogSize?: number;
  keyId?: string;
};

type PreparedPackage = {
  root: string;
  sourceSha256: string;
  cleanup: () => Promise<void>;
};

type InspectedPackage = {
  manifest: PluginMarketplaceManifest;
  treeSha256: string;
};

function createUnavailableState(): PluginMarketplaceState {
  return {
    enabled: false,
    status: 'unavailable',
    keyId: null,
    generatedAt: null,
    expiresAt: null,
    refreshedAt: null,
    error: null,
    warnings: [],
    catalog: [],
    installed: [],
  };
}

async function writeJsonAtomically(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validateRelativePath(fileName: string): string {
  if (
    fileName.includes('\\') ||
    fileName.includes('\0') ||
    path.posix.isAbsolute(fileName)
  ) {
    throw new Error(`Invalid plugin package path: ${fileName}`);
  }
  const normalized = path.posix.normalize(fileName);
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(`Plugin package traversal is not allowed: ${fileName}`);
  }
  return normalized;
}

async function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return await new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error('Unable to open plugin archive'));
        return;
      }
      resolve(zipFile);
    });
  });
}

async function openEntryStream(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<NodeJS.ReadableStream> {
  return await new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Unable to read ${entry.fileName}`));
        return;
      }
      resolve(stream);
    });
  });
}

async function extractArchive(
  sourcePath: string,
  destination: string,
): Promise<void> {
  const zipFile = await openZip(sourcePath);
  let fileCount = 0;
  let extractedBytes = 0;

  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      zipFile.close();
      reject(error);
    };

    zipFile.on('error', fail);
    zipFile.on('end', () => {
      if (!failed) resolve();
    });
    zipFile.on('entry', (entry) => {
      void (async () => {
        fileCount += 1;
        if (fileCount > MAX_PACKAGE_FILES) {
          throw new Error('Plugin archive contains too many files');
        }

        const normalized = validateRelativePath(entry.fileName);
        const mode = entry.externalFileAttributes >>> 16;
        if ((mode & 0o170000) === 0o120000) {
          throw new Error('Plugin archives may not contain symbolic links');
        }

        const destinationPath = path.resolve(destination, normalized);
        if (
          destinationPath !== destination &&
          !destinationPath.startsWith(`${destination}${path.sep}`)
        ) {
          throw new Error('Plugin archive entry escapes the staging directory');
        }
        if (normalized.endsWith('/')) {
          await fs.mkdir(destinationPath, { recursive: true });
          zipFile.readEntry();
          return;
        }

        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        const stream = await openEntryStream(zipFile, entry);
        const handle = await fs.open(destinationPath, 'wx', 0o600);
        try {
          for await (const chunk of stream) {
            const buffer = Buffer.from(chunk as Buffer);
            extractedBytes += buffer.length;
            if (extractedBytes > MAX_PACKAGE_BYTES) {
              throw new Error(
                'Plugin archive exceeds the extracted size limit',
              );
            }
            await handle.write(buffer);
          }
        } finally {
          await handle.close();
        }
        zipFile.readEntry();
      })().catch(fail);
    });
    zipFile.readEntry();
  });
}

async function collectPackageFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const stat = await fs.lstat(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error('Plugin packages may not contain symbolic links');
      }
      if (stat.isDirectory()) {
        await visit(entryPath);
      } else if (stat.isFile()) {
        files.push(entryPath);
      }
      if (files.length > MAX_PACKAGE_FILES) {
        throw new Error('Plugin package contains too many files');
      }
    }
  };
  await visit(root);
  return files.sort((a, b) =>
    path.relative(root, a).localeCompare(path.relative(root, b)),
  );
}

export async function hashPluginDirectory(root: string): Promise<string> {
  const hash = createHash('sha256');
  let totalBytes = 0;
  for (const filePath of await collectPackageFiles(root)) {
    const relativePath = path
      .relative(root, filePath)
      .split(path.sep)
      .join('/');
    const buffer = await fs.readFile(filePath);
    totalBytes += buffer.length;
    if (totalBytes > MAX_PACKAGE_BYTES) {
      throw new Error('Plugin package exceeds the size limit');
    }
    hash.update(relativePath);
    hash.update('\0');
    hash.update(String(buffer.length));
    hash.update('\0');
    hash.update(buffer);
  }
  return hash.digest('hex');
}

export function getPluginCompatibilityError(
  manifest: PluginMarketplaceManifest,
  appVersion: string,
): string | null {
  if (semver.lt(appVersion, manifest.compatibility.minAppVersion)) {
    return `Requires Clodex ${manifest.compatibility.minAppVersion} or newer.`;
  }
  if (
    manifest.compatibility.maxAppVersion &&
    semver.gt(appVersion, manifest.compatibility.maxAppVersion)
  ) {
    return `Supports Clodex up to ${manifest.compatibility.maxAppVersion}.`;
  }
  return null;
}

function installSourcesMatch(
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

function assertDeclaredContentPermissions(
  root: string,
  files: string[],
  manifest: PluginMarketplaceManifest,
): void {
  const relativeFiles = files.map((file) =>
    path.relative(root, file).split(path.sep).join('/'),
  );
  const permissions = new Set(manifest.permissions);
  const hasSkills = relativeFiles.some(
    (file) =>
      file.toLocaleLowerCase() === 'skill.md' || file.startsWith('skills/'),
  );
  const hasApps = relativeFiles.some((file) => file.startsWith('apps/'));
  const hasMcp = relativeFiles.some((file) => file.startsWith('mcp/'));

  if (hasSkills && !permissions.has('skills')) {
    throw new Error('Plugin package contains skills without skills permission');
  }
  if (hasApps && !permissions.has('apps')) {
    throw new Error('Plugin package contains apps without apps permission');
  }
  if (hasMcp && !permissions.has('mcp')) {
    throw new Error('Plugin package contains MCP files without mcp permission');
  }
  if (
    manifest.requiredCredentials.length > 0 &&
    !permissions.has('credentials')
  ) {
    throw new Error(
      'Plugin declares credentials without credentials permission',
    );
  }
}

export type PluginMarketplaceServiceOptions = {
  logger: Logger;
  karton: KartonService;
  isFeatureEnabled: (feature: FeatureGateId) => boolean;
  trustedKeys: Readonly<Record<string, string>>;
  appVersion: string;
  onPluginsChanged?: () => Promise<void> | void;
  audit?: (event: PluginMarketplaceAuditEvent) => void;
  now?: () => number;
  fetcher?: typeof fetch;
  indexPath?: string;
  installedDir?: string;
  stagingDir?: string;
  lockPath?: string;
  loadLock?: () => Promise<unknown>;
  saveLock?: (lockfile: PluginMarketplaceLockfile) => Promise<void>;
};

export class PluginMarketplaceService extends DisposableService {
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private readonly indexPath: string;
  private readonly installedDir: string;
  private readonly stagingDir: string;
  private readonly lockPath: string;
  private lockfile: PluginMarketplaceLockfile =
    structuredClone(DEFAULT_LOCKFILE);
  private indexPayload: PluginMarketplaceIndexPayload | null = null;
  private publisherVerification = new Map<string, string>();
  private state: PluginMarketplaceState = createUnavailableState();
  private operationQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: PluginMarketplaceServiceOptions,
  ) {
    super();
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? fetch;
    this.indexPath =
      options.indexPath ?? getBundledPluginMarketplaceIndexPath();
    this.installedDir = options.installedDir ?? getInstalledPluginsDir();
    this.stagingDir = options.stagingDir ?? getPluginMarketplaceStagingDir();
    this.lockPath = options.lockPath ?? getPluginMarketplaceLockPath();
  }

  public static async create(
    options: PluginMarketplaceServiceOptions,
  ): Promise<PluginMarketplaceService> {
    const service = new PluginMarketplaceService(options);
    await service.initialize();
    return service;
  }

  public getState(): PluginMarketplaceState {
    this.assertNotDisposed();
    return {
      ...structuredClone(this.state),
      enabled: this.options.isFeatureEnabled('plugin-marketplace'),
    };
  }

  public async refresh(): Promise<PluginMarketplaceState> {
    return await this.runExclusive(async () => {
      this.assertFeature();
      await this.refreshIndex();
      return this.getState();
    });
  }

  public async install(
    pluginId: string,
  ): Promise<PluginMarketplaceOperationResult> {
    return await this.runExclusive(() =>
      this.installOrUpdate(pluginId, 'install'),
    );
  }

  public async update(
    pluginId: string,
  ): Promise<PluginMarketplaceOperationResult> {
    return await this.runExclusive(() =>
      this.installOrUpdate(pluginId, 'update'),
    );
  }

  public async uninstall(
    pluginId: string,
  ): Promise<PluginMarketplaceOperationResult> {
    return await this.runExclusive(() =>
      this.uninstallPlugin(pluginId, 'official'),
    );
  }

  public async installVerifiedEntry(
    entry: PluginMarketplaceIndexEntry,
    source: PluginMarketplaceInstallSource,
    publisherKeyId: string | undefined,
    requestedOperation: 'install' | 'update',
  ): Promise<PluginMarketplaceOperationResult> {
    return await this.runExclusive(() =>
      this.installEntry(entry, source, publisherKeyId, requestedOperation),
    );
  }

  public async uninstallVerifiedPlugin(
    pluginId: string,
    source: PluginMarketplaceInstallSource,
  ): Promise<PluginMarketplaceOperationResult> {
    return await this.runExclusive(() =>
      this.uninstallPlugin(pluginId, source),
    );
  }

  private async uninstallPlugin(
    pluginId: string,
    expectedSource: PluginMarketplaceInstallSource,
  ): Promise<PluginMarketplaceOperationResult> {
    this.assertFeature();
    const startedAt = this.now();
    const existing = this.lockfile.plugins[pluginId];
    if (!existing) {
      return {
        ok: false,
        operation: 'uninstall',
        pluginId,
        error: 'Plugin is not installed.',
        rolledBack: false,
        state: this.getState(),
      };
    }
    if (!installSourcesMatch(existing.source, expectedSource)) {
      return {
        ok: false,
        operation: 'uninstall',
        pluginId,
        error: 'Plugin is installed from another marketplace source.',
        rolledBack: false,
        state: this.getState(),
      };
    }

    const installPath = this.resolveInstallPath(pluginId);
    const backupPath = this.createBackupPath(pluginId);
    let moved = false;
    try {
      if (await this.pathExists(installPath)) {
        await fs.rename(installPath, backupPath);
        moved = true;
      }
      const nextLock = structuredClone(this.lockfile);
      delete nextLock.plugins[pluginId];
      await this.persistLock(nextLock);
      this.lockfile = nextLock;
      if (moved) {
        await fs.rm(backupPath, { recursive: true, force: true });
      }
      this.rebuildState();
      await this.notifyPluginsChanged();
      this.audit({
        operation: 'uninstall',
        success: true,
        durationMs: this.now() - startedAt,
        pluginId,
        version: existing.version,
        permissionCount: existing.manifest.permissions.length,
      });
      return {
        ok: true,
        operation: 'uninstall',
        pluginId,
        state: this.getState(),
      };
    } catch (error) {
      if (moved && !(await this.pathExists(installPath))) {
        await fs.rename(backupPath, installPath).catch(() => undefined);
      }
      this.audit({
        operation: 'rollback',
        success: false,
        durationMs: this.now() - startedAt,
        pluginId,
        version: existing.version,
      });
      return {
        ok: false,
        operation: 'uninstall',
        pluginId,
        error: this.errorMessage(error),
        rolledBack: moved,
        state: this.getState(),
      };
    }
  }

  private async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.installedDir, { recursive: true }),
      fs.mkdir(this.stagingDir, { recursive: true }),
    ]);
    await this.loadLockfile();
    await this.recoverBackups();
    await this.reconcileInstalledPlugins();
    this.registerProcedures();
    await this.refreshIndex(false);
  }

  private registerProcedures(): void {
    const { karton } = this.options;
    karton.registerServerProcedureHandler(
      'pluginMarketplace.getState',
      async () => {
        return this.getState();
      },
    );
    karton.registerServerProcedureHandler(
      'pluginMarketplace.refresh',
      async () => this.refresh(),
    );
    karton.registerServerProcedureHandler(
      'pluginMarketplace.install',
      async (_clientId, pluginId: string) => this.install(pluginId),
    );
    karton.registerServerProcedureHandler(
      'pluginMarketplace.update',
      async (_clientId, pluginId: string) => this.update(pluginId),
    );
    karton.registerServerProcedureHandler(
      'pluginMarketplace.uninstall',
      async (_clientId, pluginId: string) => this.uninstall(pluginId),
    );
  }

  private async refreshIndex(throwOnError = true): Promise<void> {
    const startedAt = this.now();
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      const envelope = signedPluginMarketplaceIndexSchema.parse(
        JSON.parse(raw),
      );
      const publicKey = this.options.trustedKeys[envelope.keyId];
      if (!publicKey) {
        throw new Error(
          `Marketplace signing key is not trusted: ${envelope.keyId}`,
        );
      }
      const payloadBytes = Buffer.from(envelope.payload, 'base64');
      const signature = Buffer.from(envelope.signature, 'base64');
      if (!verify(null, payloadBytes, publicKey, signature)) {
        throw new Error('Marketplace index signature is invalid');
      }
      const payload = pluginMarketplaceIndexPayloadSchema.parse(
        JSON.parse(payloadBytes.toString('utf8')),
      );
      if (payload.expiresAt <= this.now()) {
        throw new Error('Marketplace index has expired');
      }
      const ids = new Set<string>();
      for (const entry of payload.plugins) {
        if (ids.has(entry.manifest.id)) {
          throw new Error(
            `Marketplace index contains duplicate plugin: ${entry.manifest.id}`,
          );
        }
        ids.add(entry.manifest.id);
      }
      this.publisherVerification = verifyPublisherSignatures(payload);
      this.indexPayload = payload;
      this.state = {
        ...this.state,
        status: 'ready',
        keyId: envelope.keyId,
        generatedAt: payload.generatedAt,
        expiresAt: payload.expiresAt,
        refreshedAt: this.now(),
        error: null,
      };
      this.rebuildState();
      this.audit({
        operation: 'refresh',
        success: true,
        durationMs: this.now() - startedAt,
        catalogSize: payload.plugins.length,
        keyId: envelope.keyId,
      });
    } catch (error) {
      this.indexPayload = null;
      this.publisherVerification.clear();
      this.state = {
        ...this.state,
        status: 'error',
        refreshedAt: this.now(),
        error: this.errorMessage(error),
      };
      this.rebuildState();
      this.audit({
        operation: 'refresh',
        success: false,
        durationMs: this.now() - startedAt,
      });
      if (throwOnError) throw error;
    }
  }

  private async installOrUpdate(
    pluginId: string,
    requestedOperation: 'install' | 'update',
  ): Promise<PluginMarketplaceOperationResult> {
    this.assertFeature();
    const entry = this.indexPayload?.plugins.find(
      (candidate) => candidate.manifest.id === pluginId,
    );
    const existing = this.lockfile.plugins[pluginId];
    const operation = existing ? 'update' : requestedOperation;
    if (!entry) {
      return {
        ok: false,
        operation,
        pluginId,
        error: 'Plugin is not present in the signed marketplace index.',
        rolledBack: false,
        state: this.getState(),
      };
    }
    return await this.installEntry(
      entry,
      'official',
      this.publisherVerification.get(pluginId),
      requestedOperation,
    );
  }

  private async installEntry(
    entry: PluginMarketplaceIndexEntry,
    source: PluginMarketplaceInstallSource,
    publisherKeyId: string | undefined,
    requestedOperation: 'install' | 'update',
  ): Promise<PluginMarketplaceOperationResult> {
    this.assertFeature();
    const startedAt = this.now();
    const pluginId = entry.manifest.id;
    const existing = this.lockfile.plugins[pluginId];
    const operation = existing ? 'update' : requestedOperation;
    if (source !== 'official' && entry.source.type !== 'https') {
      return {
        ok: false,
        operation,
        pluginId,
        error: 'Private marketplace plugins must use an HTTPS package source.',
        rolledBack: false,
        state: this.getState(),
      };
    }
    if (existing && !installSourcesMatch(existing.source, source)) {
      return {
        ok: false,
        operation,
        pluginId,
        error: 'Plugin is already installed from another marketplace source.',
        rolledBack: false,
        state: this.getState(),
      };
    }
    if (
      entry.manifest.publisherId &&
      publisherKeyId !== entry.publisherSignature?.keyId
    ) {
      return {
        ok: false,
        operation,
        pluginId,
        error: 'Publisher signature was not verified for this plugin.',
        rolledBack: false,
        state: this.getState(),
      };
    }
    const compatibilityError = getPluginCompatibilityError(
      entry.manifest,
      this.options.appVersion,
    );
    if (compatibilityError) {
      return {
        ok: false,
        operation,
        pluginId,
        error: compatibilityError,
        rolledBack: false,
        state: this.getState(),
      };
    }
    if (existing && !semver.gt(entry.manifest.version, existing.version)) {
      return {
        ok: false,
        operation: 'update',
        pluginId,
        error: 'No newer marketplace version is available.',
        rolledBack: false,
        state: this.getState(),
      };
    }

    let prepared: PreparedPackage | null = null;
    let stagePath: string | null = null;
    let backupPath: string | null = null;
    let activated = false;
    const installPath = this.resolveInstallPath(pluginId);
    try {
      prepared = await this.preparePackage(entry.source);
      if (prepared.sourceSha256 !== entry.sha256) {
        throw new Error('Plugin package integrity check failed');
      }
      const inspected = await this.inspectPackage(
        prepared.root,
        entry.manifest,
      );
      stagePath = path.join(
        this.stagingDir,
        `${pluginId}.${randomUUID()}.stage`,
      );
      await fs.cp(prepared.root, stagePath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      if ((await hashPluginDirectory(stagePath)) !== inspected.treeSha256) {
        throw new Error('Staged plugin changed during installation');
      }

      if (await this.pathExists(installPath)) {
        backupPath = this.createBackupPath(pluginId);
        await fs.rename(installPath, backupPath);
      }
      await fs.rename(stagePath, installPath);
      stagePath = null;
      activated = true;

      const now = this.now();
      const nextLock = structuredClone(this.lockfile);
      nextLock.plugins[pluginId] = {
        id: pluginId,
        version: inspected.manifest.version,
        sha256: inspected.treeSha256,
        source,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
        manifest: inspected.manifest,
        publisherKeyId,
        publisherSignature: entry.publisherSignature?.signature,
      };
      await this.persistLock(nextLock);
      this.lockfile = nextLock;
      if (backupPath) {
        await fs.rm(backupPath, { recursive: true, force: true });
        backupPath = null;
      }
      this.rebuildState();
      await this.notifyPluginsChanged();
      this.audit({
        operation,
        success: true,
        durationMs: this.now() - startedAt,
        pluginId,
        version: inspected.manifest.version,
        permissionCount: inspected.manifest.permissions.length,
      });
      return { ok: true, operation, pluginId, state: this.getState() };
    } catch (error) {
      if (activated && (await this.pathExists(installPath))) {
        await fs
          .rm(installPath, { recursive: true, force: true })
          .catch(() => undefined);
      }
      if (backupPath && (await this.pathExists(backupPath))) {
        await fs.rename(backupPath, installPath).catch(() => undefined);
      }
      this.audit({
        operation: backupPath ? 'rollback' : operation,
        success: false,
        durationMs: this.now() - startedAt,
        pluginId,
        version: entry.manifest.version,
        permissionCount: entry.manifest.permissions.length,
      });
      return {
        ok: false,
        operation,
        pluginId,
        error: this.errorMessage(error),
        rolledBack: backupPath !== null,
        state: this.getState(),
      };
    } finally {
      if (stagePath) {
        await fs
          .rm(stagePath, { recursive: true, force: true })
          .catch(() => undefined);
      }
      await prepared?.cleanup().catch(() => undefined);
    }
  }

  private async preparePackage(
    source: PluginMarketplacePackageSource,
  ): Promise<PreparedPackage> {
    if (source.type === 'bundled-directory') {
      const marketplaceRoot = path.dirname(this.indexPath);
      const packageRoot = path.resolve(marketplaceRoot, source.relativePath);
      if (!packageRoot.startsWith(`${marketplaceRoot}${path.sep}`)) {
        throw new Error('Bundled plugin source escapes the marketplace root');
      }
      return {
        root: packageRoot,
        sourceSha256: await hashPluginDirectory(packageRoot),
        cleanup: async () => undefined,
      };
    }

    const response = await this.fetcher(source.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`Plugin download failed with HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_PACKAGE_BYTES) {
      throw new Error('Plugin download exceeds the size limit');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_PACKAGE_BYTES) {
      throw new Error('Plugin download exceeds the size limit');
    }

    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'clodex-plugin-'),
    );
    const archivePath = path.join(temporaryRoot, 'package.clodex-plugin');
    const extractPath = path.join(temporaryRoot, 'contents');
    await fs.mkdir(extractPath);
    await fs.writeFile(archivePath, buffer, { mode: 0o600 });
    try {
      await extractArchive(archivePath, extractPath);
      return {
        root: extractPath,
        sourceSha256: createHash('sha256').update(buffer).digest('hex'),
        cleanup: () => fs.rm(temporaryRoot, { recursive: true, force: true }),
      };
    } catch (error) {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
  }

  private async inspectPackage(
    root: string,
    signedManifest: PluginMarketplaceManifest,
  ): Promise<InspectedPackage> {
    const manifestPath = path.join(root, 'plugin.json');
    const metadataPath = path.join(root, 'metadata.json');
    const [manifestRaw, metadataRaw, files] = await Promise.all([
      fs.readFile(manifestPath, 'utf8'),
      fs.readFile(metadataPath, 'utf8'),
      collectPackageFiles(root),
    ]);
    const manifest = pluginMarketplaceManifestSchema.parse(
      JSON.parse(manifestRaw),
    );
    const metadata = pluginMetadataSchema.parse(JSON.parse(metadataRaw));
    if (JSON.stringify(manifest) !== JSON.stringify(signedManifest)) {
      throw new Error('Plugin manifest does not match the signed index');
    }
    if (
      metadata.displayName !== manifest.displayName ||
      metadata.description !== manifest.description ||
      JSON.stringify(metadata.requiredCredentials) !==
        JSON.stringify(manifest.requiredCredentials)
    ) {
      throw new Error('Plugin metadata does not match plugin.json');
    }
    const compatibilityError = getPluginCompatibilityError(
      manifest,
      this.options.appVersion,
    );
    if (compatibilityError) throw new Error(compatibilityError);
    assertDeclaredContentPermissions(root, files, manifest);
    const declarations = await readPluginMcpServerDeclarations(root);
    const actualMcpServers = declarations
      ? summarizePluginMcpServers(declarations)
      : [];
    if (
      JSON.stringify(actualMcpServers) !==
      JSON.stringify(manifest.mcpServers ?? [])
    ) {
      throw new Error(
        'Plugin MCP declarations do not match the signed catalog summary',
      );
    }
    const runtimeManifest = await readPluginRuntimeManifest(root);
    const actualExecutableRuntimes =
      runtimeManifest?.runtimes.map((runtime) => ({
        id: runtime.id,
        sha256: runtime.sha256,
        platforms: runtime.platforms,
        architectures: runtime.architectures,
        limits: runtime.limits,
      })) ?? [];
    if (
      manifest.executableRuntimes &&
      JSON.stringify(actualExecutableRuntimes) !==
        JSON.stringify(manifest.executableRuntimes)
    ) {
      throw new Error(
        'Plugin executable runtimes do not match the signed catalog summary',
      );
    }
    return {
      manifest,
      treeSha256: await hashPluginDirectory(root),
    };
  }

  private rebuildState(): void {
    const installed = Object.values(this.lockfile.plugins).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const catalog =
      this.indexPayload?.plugins
        .map((entry) => {
          const candidateInstalledEntry =
            this.lockfile.plugins[entry.manifest.id];
          const installedEntry =
            candidateInstalledEntry?.source === 'official'
              ? candidateInstalledEntry
              : undefined;
          const sourceConflict = candidateInstalledEntry && !installedEntry;
          const compatibilityError = sourceConflict
            ? 'Plugin is installed from a private marketplace source.'
            : getPluginCompatibilityError(
                entry.manifest,
                this.options.appVersion,
              );
          return {
            manifest: entry.manifest,
            sha256: entry.sha256,
            publisherVerified: this.publisherVerification.has(
              entry.manifest.id,
            ),
            publisherKeyId:
              this.publisherVerification.get(entry.manifest.id) ?? null,
            compatible: compatibilityError === null,
            compatibilityError,
            installedVersion: installedEntry?.version ?? null,
            updateAvailable:
              installedEntry !== undefined &&
              semver.gt(entry.manifest.version, installedEntry.version),
          };
        })
        .sort((a, b) =>
          a.manifest.displayName.localeCompare(b.manifest.displayName),
        ) ?? [];
    this.state = { ...this.state, catalog, installed };
  }

  private async loadLockfile(): Promise<void> {
    try {
      const raw = this.options.loadLock
        ? await this.options.loadLock()
        : JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
      this.lockfile = pluginMarketplaceLockfileSchema.parse(raw);
    } catch {
      this.lockfile = structuredClone(DEFAULT_LOCKFILE);
    }
    this.rebuildState();
  }

  private async persistLock(
    lockfile: PluginMarketplaceLockfile,
  ): Promise<void> {
    const parsed = pluginMarketplaceLockfileSchema.parse(lockfile);
    if (this.options.saveLock) {
      await this.options.saveLock(parsed);
      return;
    }
    await writeJsonAtomically(this.lockPath, parsed);
  }

  private async recoverBackups(): Promise<void> {
    const entries = await fs.readdir(this.installedDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(BACKUP_PREFIX)) {
        continue;
      }
      const withoutPrefix = entry.name.slice(BACKUP_PREFIX.length);
      const pluginId = withoutPrefix.slice(0, -37);
      const backupPath = path.join(this.installedDir, entry.name);
      const installPath = this.resolveInstallPath(pluginId);
      if (
        this.lockfile.plugins[pluginId] &&
        !(await this.pathExists(installPath))
      ) {
        await fs.rename(backupPath, installPath);
      } else {
        await fs.rm(backupPath, { recursive: true, force: true });
      }
    }
    await fs.rm(this.stagingDir, { recursive: true, force: true });
    await fs.mkdir(this.stagingDir, { recursive: true });
  }

  private async reconcileInstalledPlugins(): Promise<void> {
    const nextLock = structuredClone(this.lockfile);
    const warnings: string[] = [];
    const quarantined: string[] = [];
    const installedEntries = await fs.readdir(this.installedDir, {
      withFileTypes: true,
    });

    for (const [pluginId, lockEntry] of Object.entries(this.lockfile.plugins)) {
      const installPath = this.resolveInstallPath(pluginId);
      try {
        const inspected = await this.inspectPackage(
          installPath,
          lockEntry.manifest,
        );
        if (inspected.treeSha256 !== lockEntry.sha256) {
          throw new Error('installed package integrity hash changed');
        }
      } catch (error) {
        delete nextLock.plugins[pluginId];
        if (await this.pathExists(installPath)) {
          const quarantinePath = path.join(
            this.stagingDir,
            `${pluginId}.${randomUUID()}.quarantine`,
          );
          await fs.rename(installPath, quarantinePath);
          quarantined.push(quarantinePath);
        }
        warnings.push(`Disabled ${pluginId}: ${this.errorMessage(error)}.`);
      }
    }

    for (const entry of installedEntries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(BACKUP_PREFIX) ||
        nextLock.plugins[entry.name]
      ) {
        continue;
      }
      const orphanPath = path.join(this.installedDir, entry.name);
      if (!(await this.pathExists(orphanPath))) continue;
      const quarantinePath = path.join(
        this.stagingDir,
        `${entry.name}.${randomUUID()}.quarantine`,
      );
      await fs.rename(orphanPath, quarantinePath);
      quarantined.push(quarantinePath);
      warnings.push(
        `Disabled ${entry.name}: package is not present in the integrity lockfile.`,
      );
    }

    if (
      Object.keys(nextLock.plugins).length !==
        Object.keys(this.lockfile.plugins).length ||
      quarantined.length > 0
    ) {
      try {
        await this.persistLock(nextLock);
      } catch (error) {
        this.options.logger.warn(
          `[PluginMarketplace] Failed to persist reconciled lockfile: ${this.errorMessage(error)}`,
        );
        warnings.push(
          'The repaired marketplace lockfile could not be persisted; quarantined plugins remain disabled.',
        );
      }
      this.lockfile = nextLock;
    }

    await Promise.all(
      quarantined.map((quarantinePath) =>
        fs.rm(quarantinePath, { recursive: true, force: true }),
      ),
    );
    this.state = { ...this.state, warnings };
    this.rebuildState();
  }

  private resolveInstallPath(pluginId: string): string {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginId)) {
      throw new Error('Invalid marketplace plugin ID');
    }
    const installPath = path.resolve(this.installedDir, pluginId);
    if (
      !installPath.startsWith(`${path.resolve(this.installedDir)}${path.sep}`)
    ) {
      throw new Error('Resolved plugin install path is unsafe');
    }
    return installPath;
  }

  private createBackupPath(pluginId: string): string {
    return path.join(
      this.installedDir,
      `${BACKUP_PREFIX}${pluginId}.${randomUUID()}`,
    );
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
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

  private async notifyPluginsChanged(): Promise<void> {
    try {
      await this.options.onPluginsChanged?.();
    } catch (error) {
      this.options.logger.warn(
        `[PluginMarketplace] Failed to refresh plugin discovery: ${this.errorMessage(error)}`,
      );
    }
  }

  private audit(event: PluginMarketplaceAuditEvent): void {
    try {
      this.options.audit?.(event);
    } catch {
      // Audit transport must not change install/rollback behavior.
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  protected async onTeardown(): Promise<void> {
    for (const procedureName of PROCEDURE_NAMES) {
      this.options.karton.removeServerProcedureHandler(procedureName);
    }
  }
}
