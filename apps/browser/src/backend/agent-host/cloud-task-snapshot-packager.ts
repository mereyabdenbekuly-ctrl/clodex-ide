import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createAgentTaskSnapshotManifest,
  type AgentTaskSnapshotManifest,
  type AgentTaskSnapshotSelection,
  type AgentTaskSnapshotSelectionEntry,
} from '@clodex/agent-core/agents';
import {
  isDataProtectionEnvelopeBuffer,
  isProtectedMountPrefix,
} from '@clodex/agent-core/host';
import {
  HARDCODED_DENY_SEGMENTS,
  loadWorkspaceIgnore,
  type WorkspaceIgnoreMatcher,
} from '@clodex/agent-core/workspace';
import { buildLocalWorkspaceSnapshotMetadata } from './workspace-snapshot-builder';

const ARCHIVE_FORMAT = 'clodex-snapshot-v1' as const;
const ARCHIVE_MAGIC = Buffer.from('CLODEXSNAP\0\x01', 'binary');
const MANIFEST_MARKER = Buffer.from('MANIFEST\0', 'utf8');
const AES_KEY_BYTES = 32;
const AES_NONCE_BYTES = 12;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_VISITED_ENTRIES = 100_000;

const SECRET_DIRECTORY_NAMES = new Set([
  '.aws',
  '.azure',
  '.clodex',
  '.codex',
  '.gnupg',
  '.kube',
  '.ssh',
]);
const SECRET_FILE_NAMES = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'kubeconfig',
  'service-account.json',
]);
const SECRET_FILE_EXTENSIONS = new Set([
  '.jks',
  '.key',
  '.keystore',
  '.p12',
  '.pem',
  '.pfx',
]);
const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template'];

export type CloudTaskSnapshotErrorReason =
  | 'selection-empty'
  | 'unknown-mount'
  | 'protected-path'
  | 'ignored-path'
  | 'secret-path'
  | 'symlink'
  | 'unsupported-file'
  | 'stale-file'
  | 'file-changed'
  | 'quota-exceeded'
  | 'aborted'
  | 'io-error'
  | 'crypto-error';

export class CloudTaskSnapshotError extends Error {
  public constructor(
    public readonly reason: CloudTaskSnapshotErrorReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CloudTaskSnapshotError';
  }
}

export interface CloudTaskSnapshotMount {
  prefix: string;
  path: string;
}

export interface CloudTaskSnapshotWrappedKey {
  algorithm: string;
  keyId: string;
  value: string;
}

export interface CloudTaskSnapshotSignature {
  algorithm: string;
  keyId: string;
  value: string;
}

export interface CloudTaskSnapshotCryptoProvider {
  wrapDataKey(input: {
    taskId: string;
    dataKey: Uint8Array;
  }): Promise<CloudTaskSnapshotWrappedKey>;
  signManifest(input: {
    taskId: string;
    canonicalManifest: Uint8Array;
  }): Promise<CloudTaskSnapshotSignature>;
}

export interface CloudTaskSnapshotDescriptor {
  version: 1;
  manifest: AgentTaskSnapshotManifest;
  archive: {
    format: typeof ARCHIVE_FORMAT;
    path: string;
    sizeBytes: number;
    sha256: string;
  };
  encryption: {
    algorithm: 'aes-256-gcm';
    nonce: string;
    authTag: string;
    wrappedDataKey: CloudTaskSnapshotWrappedKey;
  };
  signature: CloudTaskSnapshotSignature;
  upload?: {
    sessionId: string;
    objectId: string;
    residency: 'us' | 'eu' | 'apac';
    expiresAt: number;
    sha256: string;
  };
}

export interface PreparedCloudTaskSnapshot {
  descriptor: CloudTaskSnapshotDescriptor;
  cleanup(): Promise<void>;
}

export interface CloudTaskSnapshotPackager {
  prepare(input: {
    taskId: string;
    agentInstanceId: string;
    selection: AgentTaskSnapshotSelection;
    abortSignal?: AbortSignal;
  }): Promise<PreparedCloudTaskSnapshot>;
}

export interface FileSystemCloudTaskSnapshotPackagerOptions {
  resolveMounts: (
    agentInstanceId: string,
  ) =>
    | readonly CloudTaskSnapshotMount[]
    | Promise<readonly CloudTaskSnapshotMount[]>;
  cryptoProvider: CloudTaskSnapshotCryptoProvider;
  stagingRoot?: string;
  maxEntries?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
  maxVisitedEntries?: number;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  isProtectedFile?: (absolutePath: string) => boolean | Promise<boolean>;
}

interface CollectedSnapshotFile {
  mountPrefix: string;
  relativePath: string;
  absolutePath: string;
  expectedSha256?: string;
}

type ResolvedSnapshotSelectionEntry = Omit<
  AgentTaskSnapshotSelectionEntry,
  'expectedSha256'
> & {
  expectedSha256?: string;
};

interface SnapshotLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxVisitedEntries: number;
}

export class FileSystemCloudTaskSnapshotPackager
  implements CloudTaskSnapshotPackager
{
  private readonly resolveMounts: FileSystemCloudTaskSnapshotPackagerOptions['resolveMounts'];
  private readonly cryptoProvider: CloudTaskSnapshotCryptoProvider;
  private readonly stagingRoot: string;
  private readonly limits: SnapshotLimits;
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;
  private readonly isProtectedFile:
    | ((absolutePath: string) => boolean | Promise<boolean>)
    | undefined;

  public constructor(options: FileSystemCloudTaskSnapshotPackagerOptions) {
    this.resolveMounts = options.resolveMounts;
    this.cryptoProvider = options.cryptoProvider;
    this.stagingRoot =
      options.stagingRoot ?? path.join(tmpdir(), 'clodex-cloud-snapshots');
    this.limits = {
      maxEntries: positiveLimit(
        options.maxEntries,
        DEFAULT_MAX_ENTRIES,
        'entry',
      ),
      maxTotalBytes: positiveLimit(
        options.maxTotalBytes,
        DEFAULT_MAX_TOTAL_BYTES,
        'total byte',
      ),
      maxFileBytes: positiveLimit(
        options.maxFileBytes,
        DEFAULT_MAX_FILE_BYTES,
        'file byte',
      ),
      maxVisitedEntries: positiveLimit(
        options.maxVisitedEntries,
        DEFAULT_MAX_VISITED_ENTRIES,
        'visited entry',
      ),
    };
    this.now = options.now ?? Date.now;
    this.random = options.randomBytes ?? randomBytes;
    this.isProtectedFile = options.isProtectedFile;
  }

  public async prepare(input: {
    taskId: string;
    agentInstanceId: string;
    selection: AgentTaskSnapshotSelection;
    abortSignal?: AbortSignal;
  }): Promise<PreparedCloudTaskSnapshot> {
    assertNotAborted(input.abortSignal);
    if (
      input.selection.mode === 'explicit' &&
      input.selection.entries.length === 0
    ) {
      throw new CloudTaskSnapshotError(
        'selection-empty',
        'Cloud task snapshot selection is empty',
      );
    }

    const taskDirectory = path.join(
      this.stagingRoot,
      createHash('sha256').update(input.taskId).digest('hex').slice(0, 32),
    );
    const archivePath = path.join(taskDirectory, 'snapshot.enc');
    let archiveHandle: FileHandle | null = null;
    const dataKey = this.random(AES_KEY_BYTES);

    try {
      validateRandomBytes(dataKey, AES_KEY_BYTES, 'data key');
      const { files, mounts } = await this.collectFiles(input);
      assertNotAborted(input.abortSignal);
      await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
      archiveHandle = await open(archivePath, 'wx', 0o600);

      const nonce = this.random(AES_NONCE_BYTES);
      validateRandomBytes(nonce, AES_NONCE_BYTES, 'nonce');
      const wrappedDataKey = await this.wrapDataKey(input.taskId, dataKey);
      const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
      cipher.setAAD(
        Buffer.from(`clodex.cloud-snapshot.v1\0${input.taskId}`, 'utf8'),
      );
      const ciphertextHash = createHash('sha256');
      let encryptedBytes = 0;
      const writePlaintext = async (plaintext: Uint8Array): Promise<void> => {
        const encrypted = cipher.update(plaintext);
        if (encrypted.byteLength === 0) return;
        await writeAll(archiveHandle!, encrypted);
        ciphertextHash.update(encrypted);
        encryptedBytes += encrypted.byteLength;
      };

      await writePlaintext(ARCHIVE_MAGIC);
      const manifestEntries: AgentTaskSnapshotManifest['entries'] = [];
      let totalBytes = 0;
      for (const file of files) {
        assertNotAborted(input.abortSignal);
        const result = await this.writeFileRecord({
          file,
          writePlaintext,
          abortSignal: input.abortSignal,
        });
        totalBytes += result.sizeBytes;
        if (
          !Number.isSafeInteger(totalBytes) ||
          totalBytes > this.limits.maxTotalBytes
        ) {
          throw new CloudTaskSnapshotError(
            'quota-exceeded',
            'Snapshot total byte limit exceeded',
          );
        }
        manifestEntries.push({
          mountPrefix: file.mountPrefix,
          relativePath: file.relativePath,
          kind: 'file',
          sizeBytes: result.sizeBytes,
          sha256: result.sha256,
        });
      }

      const snapshotMetadata = await buildLocalWorkspaceSnapshotMetadata({
        mounts,
        entries: manifestEntries,
        selection: input.selection.mode,
      });
      const manifest = createAgentTaskSnapshotManifest({
        taskId: input.taskId,
        createdAt: this.now(),
        selection: input.selection.mode,
        entries: manifestEntries,
        mounts: snapshotMetadata.mounts,
        environment: snapshotMetadata.environment,
        maxEntries: this.limits.maxEntries,
        maxTotalBytes: this.limits.maxTotalBytes,
      });
      const canonicalManifest = canonicalJson(manifest);
      const signature = await this.signManifest(
        input.taskId,
        canonicalManifest,
      );
      const footer = canonicalJson({
        manifest: canonicalManifest.toString('base64url'),
        signature,
      });
      await writePlaintext(MANIFEST_MARKER);
      await writePlaintext(uint32(footer.byteLength));
      await writePlaintext(footer);

      const finalCiphertext = cipher.final();
      if (finalCiphertext.byteLength > 0) {
        await writeAll(archiveHandle, finalCiphertext);
        ciphertextHash.update(finalCiphertext);
        encryptedBytes += finalCiphertext.byteLength;
      }
      const authTag = cipher.getAuthTag();
      await archiveHandle.sync();
      await archiveHandle.close();
      archiveHandle = null;

      let cleaned = false;
      return {
        descriptor: {
          version: 1,
          manifest,
          archive: {
            format: ARCHIVE_FORMAT,
            path: archivePath,
            sizeBytes: encryptedBytes,
            sha256: ciphertextHash.digest('hex'),
          },
          encryption: {
            algorithm: 'aes-256-gcm',
            nonce: nonce.toString('base64url'),
            authTag: authTag.toString('base64url'),
            wrappedDataKey,
          },
          signature,
        },
        cleanup: async () => {
          if (cleaned) return;
          cleaned = true;
          await rm(taskDirectory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (archiveHandle) {
        await archiveHandle.close().catch(() => {});
      }
      await rm(taskDirectory, { recursive: true, force: true }).catch(() => {});
      if (error instanceof CloudTaskSnapshotError) throw error;
      throw new CloudTaskSnapshotError(
        'io-error',
        'Cloud task snapshot packaging failed',
        { cause: error },
      );
    } finally {
      dataKey.fill(0);
    }
  }

  private async collectFiles(input: {
    agentInstanceId: string;
    selection: AgentTaskSnapshotSelection;
    abortSignal?: AbortSignal;
  }): Promise<{
    files: CollectedSnapshotFile[];
    mounts: CloudTaskSnapshotMount[];
  }> {
    const mounts = await this.resolveMounts(input.agentInstanceId);
    const mountMap = new Map<string, CloudTaskSnapshotMount>();
    for (const mount of mounts) {
      if (mountMap.has(mount.prefix)) {
        throw new CloudTaskSnapshotError(
          'unknown-mount',
          'Duplicate cloud snapshot mount prefix',
        );
      }
      mountMap.set(mount.prefix, mount);
    }

    const files = new Map<string, CollectedSnapshotFile>();
    const ignoreMatchers = new Map<string, WorkspaceIgnoreMatcher>();
    let visitedEntries = 0;
    const selectedEntries: ResolvedSnapshotSelectionEntry[] =
      input.selection.mode === 'mounted-workspaces'
        ? mounts
            .filter((mount) => !isProtectedMountPrefix(mount.prefix))
            .map((mount) => ({
              mountPrefix: mount.prefix,
              relativePath: '',
            }))
        : input.selection.entries;

    for (const selected of selectedEntries) {
      assertNotAborted(input.abortSignal);
      if (isProtectedMountPrefix(selected.mountPrefix)) {
        throw new CloudTaskSnapshotError(
          'protected-path',
          'Protected mounts cannot be included in cloud snapshots',
        );
      }
      const mount = mountMap.get(selected.mountPrefix);
      if (!mount) {
        throw new CloudTaskSnapshotError(
          'unknown-mount',
          'Snapshot selection references an unavailable workspace mount',
        );
      }
      const root = await realpath(mount.path);
      let matcher = ignoreMatchers.get(selected.mountPrefix);
      if (!matcher) {
        matcher = await loadWorkspaceIgnore(root);
        ignoreMatchers.set(selected.mountPrefix, matcher);
      }
      const candidate = resolveInside(root, selected.relativePath);
      const candidateStat = await lstat(candidate);
      if (candidateStat.isSymbolicLink()) {
        throw new CloudTaskSnapshotError(
          'symlink',
          'Explicit snapshot selections cannot be symbolic links',
        );
      }
      const resolvedCandidate = await realpath(candidate);
      assertInside(root, resolvedCandidate);
      if (isSensitiveRelativePath(selected.relativePath)) {
        throw new CloudTaskSnapshotError(
          'secret-path',
          'Explicit snapshot selection matches a protected secret path',
        );
      }
      if (selected.relativePath && matcher.ignores(resolvedCandidate)) {
        throw new CloudTaskSnapshotError(
          'ignored-path',
          'Explicit snapshot selection is ignored by workspace policy',
        );
      }

      if (candidateStat.isFile()) {
        await this.addCollectedFile(files, {
          mountPrefix: selected.mountPrefix,
          relativePath: selected.relativePath,
          absolutePath: resolvedCandidate,
          expectedSha256: selected.expectedSha256,
        });
        continue;
      }
      if (!candidateStat.isDirectory()) {
        throw new CloudTaskSnapshotError(
          'unsupported-file',
          'Snapshot selections must be regular files or directories',
        );
      }

      const stack: Array<{ absolutePath: string; relativePath: string }> = [
        {
          absolutePath: resolvedCandidate,
          relativePath: selected.relativePath,
        },
      ];
      while (stack.length > 0) {
        assertNotAborted(input.abortSignal);
        const directory = stack.pop()!;
        const entries = await readdir(directory.absolutePath, {
          withFileTypes: true,
        });
        entries.sort((left, right) => compareOrdinal(left.name, right.name));
        for (const entry of entries) {
          visitedEntries += 1;
          if (visitedEntries > this.limits.maxVisitedEntries) {
            throw new CloudTaskSnapshotError(
              'quota-exceeded',
              'Snapshot traversal entry limit exceeded',
            );
          }
          assertNotAborted(input.abortSignal);
          const relativePath = toPosixPath(
            path.join(directory.relativePath, entry.name),
          );
          if (
            HARDCODED_DENY_SEGMENTS.has(entry.name) ||
            isSensitiveRelativePath(relativePath)
          ) {
            continue;
          }
          const absolutePath = path.join(directory.absolutePath, entry.name);
          if (matcher.ignores(absolutePath)) continue;
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            const resolvedDirectory = await realpath(absolutePath);
            assertInside(root, resolvedDirectory);
            stack.push({
              absolutePath: resolvedDirectory,
              relativePath,
            });
          } else if (entry.isFile()) {
            const resolvedFile = await realpath(absolutePath);
            assertInside(root, resolvedFile);
            await this.addCollectedFile(files, {
              mountPrefix: selected.mountPrefix,
              relativePath,
              absolutePath: resolvedFile,
            });
          }
        }
      }
    }

    const collected = Array.from(files.values());
    collected.sort((left, right) => {
      const mountOrder = compareOrdinal(left.mountPrefix, right.mountPrefix);
      return mountOrder !== 0
        ? mountOrder
        : compareOrdinal(left.relativePath, right.relativePath);
    });
    if (collected.length === 0) {
      throw new CloudTaskSnapshotError(
        'selection-empty',
        'Cloud task snapshot selection contains no eligible files',
      );
    }
    return { files: collected, mounts: [...mountMap.values()] };
  }

  private async addCollectedFile(
    files: Map<string, CollectedSnapshotFile>,
    file: CollectedSnapshotFile,
  ): Promise<void> {
    if (await this.isProtectedFile?.(file.absolutePath)) {
      throw new CloudTaskSnapshotError(
        'protected-path',
        'Protected files cannot be included in cloud snapshots',
      );
    }
    const identity = `${file.mountPrefix}/${file.relativePath}`;
    const existing = files.get(identity);
    if (existing) {
      if (file.expectedSha256) existing.expectedSha256 = file.expectedSha256;
      return;
    }
    if (files.size >= this.limits.maxEntries) {
      throw new CloudTaskSnapshotError(
        'quota-exceeded',
        'Snapshot file count limit exceeded',
      );
    }
    files.set(identity, file);
  }

  private async writeFileRecord(input: {
    file: CollectedSnapshotFile;
    writePlaintext: (value: Uint8Array) => Promise<void>;
    abortSignal?: AbortSignal;
  }): Promise<{ sizeBytes: number; sha256: string }> {
    const handle = await open(input.file.absolutePath, 'r');
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) {
        throw new CloudTaskSnapshotError(
          'unsupported-file',
          'Snapshot entry changed to a non-file',
        );
      }
      const sizeBytes = safeFileSize(before.size);
      if (sizeBytes > this.limits.maxFileBytes) {
        throw new CloudTaskSnapshotError(
          'quota-exceeded',
          'Snapshot file byte limit exceeded',
        );
      }
      const header = canonicalJson({
        mountPrefix: input.file.mountPrefix,
        relativePath: input.file.relativePath,
        sizeBytes,
      });
      await input.writePlaintext(uint32(header.byteLength));
      await input.writePlaintext(uint64(sizeBytes));
      await input.writePlaintext(header);

      const contentHash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      let firstChunk = true;
      while (offset < sizeBytes) {
        assertNotAborted(input.abortSignal);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, sizeBytes - offset),
          offset,
        );
        if (bytesRead === 0) {
          throw new CloudTaskSnapshotError(
            'file-changed',
            'Snapshot file was truncated while being read',
          );
        }
        const chunk = buffer.subarray(0, bytesRead);
        if (firstChunk && isDataProtectionEnvelopeBuffer(chunk)) {
          throw new CloudTaskSnapshotError(
            'protected-path',
            'Protected file envelopes cannot be included in cloud snapshots',
          );
        }
        firstChunk = false;
        contentHash.update(chunk);
        await input.writePlaintext(chunk);
        offset += bytesRead;
      }

      const after = await handle.stat({ bigint: true });
      if (!sameFileSnapshot(before, after)) {
        throw new CloudTaskSnapshotError(
          'file-changed',
          'Snapshot file changed while being read',
        );
      }
      const sha256 = contentHash.digest('hex');
      if (input.file.expectedSha256 && input.file.expectedSha256 !== sha256) {
        throw new CloudTaskSnapshotError(
          'stale-file',
          'Explicit snapshot file changed after user selection',
        );
      }
      return { sizeBytes, sha256 };
    } finally {
      await handle.close();
    }
  }

  private async wrapDataKey(
    taskId: string,
    dataKey: Uint8Array,
  ): Promise<CloudTaskSnapshotWrappedKey> {
    try {
      return validateWrappedKey(
        await this.cryptoProvider.wrapDataKey({ taskId, dataKey }),
      );
    } catch (error) {
      if (error instanceof CloudTaskSnapshotError) throw error;
      throw new CloudTaskSnapshotError(
        'crypto-error',
        'Snapshot data-key wrapping failed',
        { cause: error },
      );
    }
  }

  private async signManifest(
    taskId: string,
    canonicalManifest: Uint8Array,
  ): Promise<CloudTaskSnapshotSignature> {
    try {
      return validateSignature(
        await this.cryptoProvider.signManifest({
          taskId,
          canonicalManifest,
        }),
      );
    } catch (error) {
      if (error instanceof CloudTaskSnapshotError) throw error;
      throw new CloudTaskSnapshotError(
        'crypto-error',
        'Snapshot manifest signing failed',
        { cause: error },
      );
    }
  }
}

function positiveLimit(
  configured: number | undefined,
  fallback: number,
  label: string,
): number {
  const value = configured ?? fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Snapshot ${label} limit must be a positive safe integer`);
  }
  return value;
}

function validateRandomBytes(
  value: Buffer,
  expectedBytes: number,
  label: string,
): void {
  if (value.byteLength !== expectedBytes) {
    throw new CloudTaskSnapshotError(
      'crypto-error',
      `Snapshot ${label} has an invalid length`,
    );
  }
}

function validateWrappedKey(
  value: CloudTaskSnapshotWrappedKey,
): CloudTaskSnapshotWrappedKey {
  if (
    !value?.algorithm?.trim() ||
    !value.keyId?.trim() ||
    !value.value?.trim()
  ) {
    throw new CloudTaskSnapshotError(
      'crypto-error',
      'Snapshot wrapped data key is invalid',
    );
  }
  return {
    algorithm: value.algorithm.trim().slice(0, 64),
    keyId: value.keyId.trim().slice(0, 128),
    value: value.value.trim(),
  };
}

function validateSignature(
  value: CloudTaskSnapshotSignature,
): CloudTaskSnapshotSignature {
  if (
    !value?.algorithm?.trim() ||
    !value.keyId?.trim() ||
    !value.value?.trim()
  ) {
    throw new CloudTaskSnapshotError(
      'crypto-error',
      'Snapshot manifest signature is invalid',
    );
  }
  return {
    algorithm: value.algorithm.trim().slice(0, 64),
    keyId: value.keyId.trim().slice(0, 128),
    value: value.value.trim(),
  };
}

function resolveInside(root: string, relativePath: string): string {
  if (
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath) ||
    relativePath
      .split('/')
      .some((segment) => segment === '.' || segment === '..')
  ) {
    throw new CloudTaskSnapshotError(
      'protected-path',
      'Snapshot path is not a normalized relative path',
    );
  }
  const candidate = path.resolve(root, relativePath);
  assertInside(root, candidate);
  return candidate;
}

function assertInside(rootPath: string, candidatePath: string): void {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new CloudTaskSnapshotError(
      'protected-path',
      'Snapshot path escapes its workspace mount',
    );
  }
}

function isSensitiveRelativePath(relativePath: string): boolean {
  if (!relativePath) return false;
  const segments = relativePath.split('/');
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (SECRET_DIRECTORY_NAMES.has(lower)) return true;
  }
  const basename = segments.at(-1)!.toLowerCase();
  if (SECRET_FILE_NAMES.has(basename)) return true;
  if (
    basename === '.env' ||
    (basename.startsWith('.env.') &&
      !SAFE_ENV_SUFFIXES.some((suffix) => basename.endsWith(suffix)))
  ) {
    return true;
  }
  return SECRET_FILE_EXTENSIONS.has(path.posix.extname(basename));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function safeFileSize(size: bigint): number {
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CloudTaskSnapshotError(
      'quota-exceeded',
      'Snapshot file size is unsupported',
    );
  }
  return Number(size);
}

function sameFileSnapshot(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function canonicalJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function uint32(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new CloudTaskSnapshotError(
      'quota-exceeded',
      'Snapshot record metadata is too large',
    );
  }
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function uint64(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CloudTaskSnapshotError(
      'quota-exceeded',
      'Snapshot record size is invalid',
    );
  }
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

async function writeAll(handle: FileHandle, value: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await handle.write(
      value,
      offset,
      value.byteLength - offset,
    );
    if (bytesWritten <= 0) {
      throw new CloudTaskSnapshotError(
        'io-error',
        'Snapshot archive write made no progress',
      );
    }
    offset += bytesWritten;
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new CloudTaskSnapshotError(
    'aborted',
    'Cloud task snapshot packaging was cancelled',
  );
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
