import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { CloudTaskControlPlaneAuditEvent } from './cloud-task-observability';
import type { CloudDataResidency } from './cloud-task-security';

const METADATA_VERSION = 1;
const MAX_METADATA_BYTES = 32 * 1024;
const DEFAULT_MAX_DISK_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EXECUTION_DIRECTORIES = 1_000;
const MAX_FILES_PER_EXECUTION = 2_000;

export interface CloudTaskArtifactRecord {
  version: typeof METADATA_VERSION;
  executionId: string;
  artifactId: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  downloadedAt: number;
}

export interface ResolvedCloudTaskArtifact extends CloudTaskArtifactRecord {
  localPath: string;
}

export interface CloudTaskArtifactCleanupResult {
  removedArtifacts: number;
  removedBytes: number;
  retainedBytes: number;
}

export interface CloudTaskArtifactReservation {
  release(): Promise<void>;
}

export interface FileSystemCloudTaskArtifactStoreOptions {
  rootDirectory: string;
  residency: CloudDataResidency;
  maxDiskBytes?: number;
  maxAgeMs?: number;
  now?: () => number;
  audit?: (event: CloudTaskControlPlaneAuditEvent) => void;
}

type StoredFile = {
  path: string;
  metadataPath?: string;
  key: string;
  size: number;
  updatedAt: number;
  kind: 'artifact' | 'partial';
};

/**
 * Owns retention, disk-budget reservations, and secure path resolution for
 * downloaded cloud artifacts. Renderer callers identify artifacts only by
 * opaque execution/artifact ids; raw local paths are never authoritative.
 */
export class FileSystemCloudTaskArtifactStore {
  public readonly rootDirectory: string;
  public readonly residency: CloudDataResidency;
  private readonly maxDiskBytes: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly reservations = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly options: FileSystemCloudTaskArtifactStoreOptions,
  ) {
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.residency = options.residency;
    this.maxDiskBytes = positiveSafeInteger(
      options.maxDiskBytes ?? DEFAULT_MAX_DISK_BYTES,
      'cloud artifact disk budget',
    );
    this.maxAgeMs = positiveSafeInteger(
      options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
      'cloud artifact retention',
    );
    this.now = options.now ?? Date.now;
  }

  public async initialize(): Promise<CloudTaskArtifactCleanupResult> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    return await this.cleanup();
  }

  public reserve(input: {
    executionId: string;
    artifactId: string;
    expectedBytes: number;
  }): Promise<CloudTaskArtifactReservation> {
    return this.exclusive(async () => {
      assertOpaqueId(input.executionId, 'execution id');
      assertOpaqueId(input.artifactId, 'artifact id');
      positiveSafeInteger(input.expectedBytes, 'artifact size');
      if (input.expectedBytes > this.maxDiskBytes) {
        throw new Error('Cloud task artifact exceeds global disk budget');
      }
      const key = artifactKey(input.executionId, input.artifactId);
      if (this.reservations.has(key)) {
        throw new Error('Cloud task artifact download is already active');
      }

      const inventory = await this.scan();
      const existingBytes = inventory.files
        .filter((file) => file.key === key)
        .reduce((sum, file) => sum + file.size, 0);
      const reservedBytes = sum(this.reservations.values());
      const additionalBytes = Math.max(0, input.expectedBytes - existingBytes);
      const cleanup = await this.cleanupInventory(
        inventory,
        this.maxDiskBytes - reservedBytes - additionalBytes,
      );
      if (
        cleanup.retainedBytes + reservedBytes + additionalBytes >
        this.maxDiskBytes
      ) {
        throw new Error('Cloud task global artifact disk budget is exhausted');
      }
      this.reservations.set(key, additionalBytes);
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          await this.exclusive(async () => {
            this.reservations.delete(key);
          });
        },
      };
    });
  }

  public recordCompleted(
    record: Omit<CloudTaskArtifactRecord, 'version' | 'downloadedAt'> & {
      downloadedAt?: number;
    },
  ): Promise<void> {
    return this.exclusive(async () => {
      const validated = validateRecord({
        ...record,
        version: METADATA_VERSION,
        downloadedAt: record.downloadedAt ?? this.now(),
      });
      const directory = this.artifactDirectory(validated.executionId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const metadataPath = this.metadataPath(
        validated.executionId,
        validated.artifactId,
      );
      const temporaryPath = `${metadataPath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(validated), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, metadataPath);
    });
  }

  public async resolve(
    executionId: string,
    artifactId: string,
  ): Promise<ResolvedCloudTaskArtifact> {
    assertOpaqueId(executionId, 'execution id');
    assertOpaqueId(artifactId, 'artifact id');
    const metadataPath = this.metadataPath(executionId, artifactId);
    const record = await this.readMetadata(metadataPath);
    if (
      !record ||
      record.executionId !== executionId ||
      record.artifactId !== artifactId
    ) {
      throw new Error('Cloud task artifact metadata is unavailable');
    }
    const localPath = this.artifactPath(executionId, artifactId);
    const entry = await lstat(localPath);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.size !== record.sizeBytes
    ) {
      throw new Error('Cloud task artifact file is invalid');
    }
    const [resolvedRoot, resolvedFile] = await Promise.all([
      realpath(this.rootDirectory),
      realpath(localPath),
    ]);
    if (!isPathInside(resolvedRoot, resolvedFile)) {
      throw new Error('Cloud task artifact escaped storage root');
    }
    return { ...record, localPath: resolvedFile };
  }

  public cleanup(): Promise<CloudTaskArtifactCleanupResult> {
    return this.exclusive(async () => {
      const inventory = await this.scan();
      return await this.cleanupInventory(
        inventory,
        this.maxDiskBytes - sum(this.reservations.values()),
      );
    });
  }

  private async cleanupInventory(
    inventory: { files: StoredFile[]; metadataFiles: string[] },
    targetBytes: number,
  ): Promise<CloudTaskArtifactCleanupResult> {
    const startedAt = this.now();
    const active = new Set(this.reservations.keys());
    const cutoff = this.now() - this.maxAgeMs;
    let retainedBytes = inventory.files.reduce(
      (total, file) => total + file.size,
      0,
    );
    let removedBytes = 0;
    let removedArtifacts = 0;
    const candidates = inventory.files
      .filter((file) => !active.has(file.key))
      .sort((a, b) => {
        const aExpired = a.updatedAt < cutoff ? 0 : 1;
        const bExpired = b.updatedAt < cutoff ? 0 : 1;
        return (
          aExpired - bExpired ||
          a.updatedAt - b.updatedAt ||
          a.path.localeCompare(b.path)
        );
      });

    for (const file of candidates) {
      if (
        file.updatedAt >= cutoff &&
        retainedBytes <= Math.max(0, targetBytes)
      ) {
        break;
      }
      await Promise.all([
        rm(file.path, { force: true }),
        file.metadataPath
          ? rm(file.metadataPath, { force: true })
          : Promise.resolve(),
        file.kind === 'partial'
          ? rm(file.path.replace(/\.part$/, '.resume.json'), { force: true })
          : Promise.resolve(),
      ]);
      retainedBytes -= file.size;
      removedBytes += file.size;
      if (file.kind === 'artifact') removedArtifacts += 1;
    }

    for (const metadataPath of inventory.metadataFiles) {
      const artifactPath = metadataPath.replace(
        /\.metadata\.json$/,
        '.artifact',
      );
      try {
        await lstat(artifactPath);
      } catch (error) {
        if (isMissingFileError(error)) await rm(metadataPath, { force: true });
      }
    }

    const result = {
      removedArtifacts,
      removedBytes,
      retainedBytes: Math.max(0, retainedBytes),
    };
    this.audit({
      operation: 'retention',
      success: retainedBytes <= Math.max(0, targetBytes),
      residency: this.options.residency,
      durationMs: this.now() - startedAt,
      removedArtifacts,
      removedBytes,
    });
    return result;
  }

  private async scan(): Promise<{
    files: StoredFile[];
    metadataFiles: string[];
  }> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.rootDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return { files: [], metadataFiles: [] };
      throw error;
    }
    if (entries.length > MAX_EXECUTION_DIRECTORIES) {
      throw new Error('Cloud task artifact directory limit exceeded');
    }
    const files: StoredFile[] = [];
    const metadataFiles: string[] = [];
    for (const directoryEntry of entries) {
      if (
        !directoryEntry.isDirectory() ||
        directoryEntry.isSymbolicLink() ||
        !isOpaqueId(directoryEntry.name)
      ) {
        continue;
      }
      const directory = this.artifactDirectory(directoryEntry.name);
      const children = await readdir(directory, { withFileTypes: true });
      if (children.length > MAX_FILES_PER_EXECUTION) {
        throw new Error('Cloud task artifact file limit exceeded');
      }
      for (const child of children) {
        if (!child.isFile() || child.isSymbolicLink()) continue;
        const match = /^([A-Za-z0-9._:-]{1,200})\.(artifact|part)$/.exec(
          child.name,
        );
        if (!match) {
          if (child.name.endsWith('.metadata.json')) {
            metadataFiles.push(path.join(directory, child.name));
          }
          continue;
        }
        const artifactId = match[1]!;
        const filePath = path.join(directory, child.name);
        const entry = await lstat(filePath);
        const kind = match[2] === 'artifact' ? 'artifact' : 'partial';
        files.push({
          path: filePath,
          metadataPath:
            kind === 'artifact'
              ? this.metadataPath(directoryEntry.name, artifactId)
              : undefined,
          key: artifactKey(directoryEntry.name, artifactId),
          size: entry.size,
          updatedAt: entry.mtimeMs,
          kind,
        });
      }
    }
    return { files, metadataFiles };
  }

  private artifactDirectory(executionId: string): string {
    assertOpaqueId(executionId, 'execution id');
    return path.join(this.rootDirectory, executionId);
  }

  private artifactPath(executionId: string, artifactId: string): string {
    assertOpaqueId(artifactId, 'artifact id');
    return path.join(
      this.artifactDirectory(executionId),
      `${artifactId}.artifact`,
    );
  }

  private metadataPath(executionId: string, artifactId: string): string {
    assertOpaqueId(artifactId, 'artifact id');
    return path.join(
      this.artifactDirectory(executionId),
      `${artifactId}.metadata.json`,
    );
  }

  private async readMetadata(
    metadataPath: string,
  ): Promise<CloudTaskArtifactRecord | null> {
    let text: string;
    try {
      text = await readFile(metadataPath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_METADATA_BYTES) return null;
    try {
      return validateRecord(JSON.parse(text));
    } catch {
      return null;
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private audit(event: CloudTaskControlPlaneAuditEvent): void {
    try {
      this.options.audit?.(event);
    } catch {
      // Audit transport must never change storage outcome.
    }
  }
}

function validateRecord(value: unknown): CloudTaskArtifactRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cloud task artifact metadata is invalid');
  }
  const record = value as Partial<CloudTaskArtifactRecord>;
  if (
    record.version !== METADATA_VERSION ||
    !isOpaqueId(record.executionId) ||
    !isOpaqueId(record.artifactId) ||
    typeof record.fileName !== 'string' ||
    record.fileName.length === 0 ||
    record.fileName.length > 240 ||
    /[/\\\0\r\n]/.test(record.fileName) ||
    typeof record.mediaType !== 'string' ||
    record.mediaType.length === 0 ||
    record.mediaType.length > 200 ||
    !Number.isSafeInteger(record.sizeBytes) ||
    (record.sizeBytes ?? 0) <= 0 ||
    typeof record.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.sha256) ||
    !Number.isSafeInteger(record.downloadedAt) ||
    (record.downloadedAt ?? -1) < 0
  ) {
    throw new Error('Cloud task artifact metadata is invalid');
  }
  return record as CloudTaskArtifactRecord;
}

function artifactKey(executionId: string, artifactId: string): string {
  return `${executionId}\0${artifactId}`;
}

function assertOpaqueId(
  value: unknown,
  label: string,
): asserts value is string {
  if (!isOpaqueId(value)) throw new Error(`Cloud task ${label} is invalid`);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
