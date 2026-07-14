import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  canonicalizeJson,
  decodeUtf8,
  encodeUtf8,
  parseCanonicalJson,
} from '@clodex/contracts';
import {
  validateRegistryHeadCompareAndSwapInput,
  validateRegistryHeadKey,
  validateRegistryHeadSnapshot,
  type ProtectedRegistryHeadPort,
  type RegistryHeadCompareAndSwapInput,
  type RegistryHeadCompareAndSwapOutcome,
  type RegistryHeadKey,
  type RegistryHeadSnapshot,
} from '@clodex/registry';

export const POSIX_REGISTRY_HEAD_SNAPSHOT_FILENAME =
  'scoped-registry-heads.snapshot.v1.json' as const;
export const POSIX_REGISTRY_HEAD_STAGING_FILENAME =
  '.scoped-registry-heads.snapshot.v1.tmp' as const;
export const POSIX_REGISTRY_HEAD_LOCK_DIRECTORYNAME =
  '.scoped-registry-heads.snapshot.v1.lock' as const;
export const POSIX_REGISTRY_HEAD_SNAPSHOT_KIND =
  'clodex.posix-registry-head-snapshot' as const;
export const POSIX_REGISTRY_HEAD_SNAPSHOT_VERSION = 1 as const;
export const POSIX_REGISTRY_HEAD_MAX_HEADS = 2_048;
export const POSIX_REGISTRY_HEAD_MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NOFOLLOW =
  typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

/**
 * Honest deployment profile. This adapter provides same-directory atomic
 * replacement and multi-process exclusion on a trusted local POSIX
 * filesystem. It is not an independently protected head: a same-UID actor or
 * backup rollback can replace the complete snapshot undetectably.
 */
export const POSIX_LOCAL_REGISTRY_HEAD_PROFILE = Object.freeze({
  profileId: 'clodex-registry-node.posix-local-snapshot-v1',
  platformScope: 'trusted-local-posix-filesystem',
  canonicalEncoding: 'strict-canonical-json-utf8',
  atomicReplace: 'same-directory-rename',
  stableBeforeSuccess: true,
  multiProcessCas: true,
  lockKind: 'atomic-directory-no-stale-break',
  baseDirectoryMode: '0700',
  snapshotFileMode: '0600',
  encryptionAtRest: false,
  independentlyProtected: false,
  antiRollbackAgainstSnapshotReplacement: false,
  trustedBasePathRequired: true,
  networkFilesystemDurabilityClaim: false,
} as const);

export interface PosixRegistryHeadStoreOptions {
  /** Trusted absolute path. No manifest-controlled value enters a filename. */
  readonly baseDirectory: string;
}

export type PosixRegistryHeadStoreErrorCode =
  | 'base-directory-invalid'
  | 'filesystem-failure'
  | 'lock-unavailable'
  | 'orphan-staging-file'
  | 'platform-unsupported'
  | 'post-commit-cleanup-failed'
  | 'snapshot-invalid'
  | 'snapshot-limit-exceeded';

export class PosixRegistryHeadStoreError extends Error {
  public constructor(
    public readonly code: PosixRegistryHeadStoreErrorCode,
    message: string,
    public readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = 'PosixRegistryHeadStoreError';
  }
}

interface PosixRegistryHeadSnapshot {
  readonly kind: typeof POSIX_REGISTRY_HEAD_SNAPSHOT_KIND;
  readonly version: typeof POSIX_REGISTRY_HEAD_SNAPSHOT_VERSION;
  readonly mutationCount: number;
  readonly heads: readonly RegistryHeadSnapshot[];
}

/**
 * Whole-store synchronous CAS adapter. Synchronous mutation is intentional:
 * the core verifier permits no await between its final signer fence, CAS, and
 * current-head fence. This adapter still does not satisfy independent
 * anti-rollback protection and must not be promoted as a production head.
 */
export class PosixRegistryHeadSnapshotStore
  implements ProtectedRegistryHeadPort
{
  public readonly profile = POSIX_LOCAL_REGISTRY_HEAD_PROFILE;

  readonly #baseDirectory: string;
  readonly #snapshotPath: string;
  readonly #stagingPath: string;
  readonly #lockPath: string;
  #baseDevice: number | null = null;
  #baseInode: number | null = null;
  #terminalFailure: PosixRegistryHeadStoreError | null = null;

  public constructor(optionsValue: PosixRegistryHeadStoreOptions) {
    if (process.platform === 'win32') {
      throw storeError(
        'platform-unsupported',
        'The POSIX registry-head adapter is not supported on Windows',
      );
    }
    const options = validateOptions(optionsValue);
    this.#baseDirectory = options.baseDirectory;
    this.#snapshotPath = join(
      this.#baseDirectory,
      POSIX_REGISTRY_HEAD_SNAPSHOT_FILENAME,
    );
    this.#stagingPath = join(
      this.#baseDirectory,
      POSIX_REGISTRY_HEAD_STAGING_FILENAME,
    );
    this.#lockPath = join(
      this.#baseDirectory,
      POSIX_REGISTRY_HEAD_LOCK_DIRECTORYNAME,
    );
    this.#ensureBaseDirectory();
  }

  public readCurrent(keyValue: RegistryHeadKey): RegistryHeadSnapshot | null {
    this.#assertUsable();
    const key = validateRegistryHeadKey(keyValue);
    const snapshot = this.#readSnapshotWithLock();
    return (
      snapshot.heads.find(
        (head) => serializeHeadKey(head) === serializeHeadKey(key),
      ) ?? null
    );
  }

  public compareAndSwap(
    inputValue: RegistryHeadCompareAndSwapInput,
  ): RegistryHeadCompareAndSwapOutcome {
    this.#assertUsable();
    const input = validateRegistryHeadCompareAndSwapInput(inputValue);
    this.#ensureBaseDirectory();
    this.#acquireLock();
    let committed = false;
    let outcome: RegistryHeadCompareAndSwapOutcome | null = null;
    let primaryFailure: PosixRegistryHeadStoreError | null = null;
    let cleanupFailure: PosixRegistryHeadStoreError | null = null;
    try {
      if (existsSync(this.#stagingPath)) {
        throw storeError(
          'orphan-staging-file',
          'A registry-head staging file exists; operator reconciliation is required',
        );
      }
      const snapshot = this.#loadSnapshot();
      const key = serializeHeadKey(input.key);
      const current =
        snapshot.heads.find((head) => serializeHeadKey(head) === key) ?? null;
      if (!headValuesEqual(current, input.expected)) {
        outcome = 'CONFLICT';
      } else {
        assertSuccessor(input.expected, input.next);
        const heads = snapshot.heads.filter(
          (head) => serializeHeadKey(head) !== key,
        );
        heads.push(input.next);
        heads.sort((left, right) =>
          compareAscii(serializeHeadKey(left), serializeHeadKey(right)),
        );
        const nextSnapshot = validateStoreSnapshot({
          kind: POSIX_REGISTRY_HEAD_SNAPSHOT_KIND,
          version: POSIX_REGISTRY_HEAD_SNAPSHOT_VERSION,
          mutationCount: snapshot.mutationCount + 1,
          heads,
        });
        this.#writeSnapshot(nextSnapshot);
        committed = true;
        const reconciled = this.#loadSnapshot();
        if (canonicalizeJson(reconciled) !== canonicalizeJson(nextSnapshot)) {
          throw storeError(
            'filesystem-failure',
            'Registry-head snapshot reconciliation failed after rename',
          );
        }
        outcome = 'APPLIED';
      }
    } catch (error) {
      primaryFailure = normalizeFilesystemError(
        error,
        'Registry-head CAS failed',
      );
    } finally {
      try {
        rmdirSync(this.#lockPath);
      } catch (cleanupError) {
        const failure = storeError(
          'post-commit-cleanup-failed',
          committed
            ? 'Registry-head mutation committed but lock cleanup failed'
            : 'Registry-head lock cleanup failed',
          cleanupError,
        );
        this.#terminalFailure = failure;
        cleanupFailure = failure;
      }
    }
    if (primaryFailure !== null) throw primaryFailure;
    if (cleanupFailure !== null) throw cleanupFailure;
    if (outcome === null) {
      throw storeError(
        'filesystem-failure',
        'Registry-head CAS completed without a terminal outcome',
      );
    }
    return outcome;
  }

  public assertCurrent(expectedValue: RegistryHeadSnapshot): void {
    this.#assertUsable();
    const expected = validateRegistryHeadSnapshot(expectedValue);
    const current = this.readCurrent({
      registryType: expected.registryType,
      workspaceId: expected.workspaceId,
      taskId: expected.taskId,
      rootObjectId: expected.rootObjectId,
    });
    if (!headValuesEqual(current, expected)) {
      throw storeError(
        'snapshot-invalid',
        'POSIX registry head no longer matches the expected snapshot',
      );
    }
  }

  public readAll(): readonly RegistryHeadSnapshot[] {
    this.#assertUsable();
    return this.#readSnapshotWithLock().heads;
  }

  #assertUsable(): void {
    if (this.#terminalFailure !== null) throw this.#terminalFailure;
    this.#ensureBaseDirectory();
  }

  #ensureBaseDirectory(): void {
    try {
      try {
        lstatSync(this.#baseDirectory);
      } catch (error) {
        if (nodeErrorCode(error) !== 'ENOENT') throw error;
        const parentStatus = lstatSync(dirname(this.#baseDirectory));
        if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) {
          throw storeError(
            'base-directory-invalid',
            'Registry-head base parent must be a real trusted directory',
          );
        }
        try {
          mkdirSync(this.#baseDirectory, { mode: PRIVATE_DIRECTORY_MODE });
        } catch (mkdirError) {
          if (nodeErrorCode(mkdirError) !== 'EEXIST') throw mkdirError;
        }
      }
      const before = lstatSync(this.#baseDirectory);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw storeError(
          'base-directory-invalid',
          'Registry-head base path must be a real directory',
        );
      }
      if (
        typeof process.getuid === 'function' &&
        before.uid !== process.getuid()
      ) {
        throw storeError(
          'base-directory-invalid',
          'Registry-head base directory must be owned by the current user',
        );
      }
      chmodSync(this.#baseDirectory, PRIVATE_DIRECTORY_MODE);
      const status = lstatSync(this.#baseDirectory);
      if (
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        (status.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
      ) {
        throw storeError(
          'base-directory-invalid',
          'Registry-head base directory must have POSIX mode 0700',
        );
      }
      if (this.#baseDevice === null) {
        this.#baseDevice = status.dev;
        this.#baseInode = status.ino;
      } else if (
        status.dev !== this.#baseDevice ||
        status.ino !== this.#baseInode
      ) {
        throw storeError(
          'base-directory-invalid',
          'Registry-head base directory identity changed',
        );
      }
    } catch (error) {
      throw normalizeFilesystemError(
        error,
        'Unable to validate registry-head base directory',
        'base-directory-invalid',
      );
    }
  }

  #acquireLock(): void {
    try {
      mkdirSync(this.#lockPath, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (nodeErrorCode(error) === 'EEXIST') {
        throw storeError(
          'lock-unavailable',
          'Registry-head mutation lock is already held; stale locks are never broken automatically',
          error,
        );
      }
      throw normalizeFilesystemError(
        error,
        'Unable to acquire registry-head mutation lock',
      );
    }
  }

  #readSnapshotWithLock(): PosixRegistryHeadSnapshot {
    this.#acquireLock();
    let snapshot: PosixRegistryHeadSnapshot | null = null;
    let primaryFailure: PosixRegistryHeadStoreError | null = null;
    let cleanupFailure: PosixRegistryHeadStoreError | null = null;
    try {
      if (existsSync(this.#stagingPath)) {
        throw storeError(
          'orphan-staging-file',
          'A registry-head staging file exists; operator reconciliation is required',
        );
      }
      snapshot = this.#loadSnapshot();
    } catch (error) {
      primaryFailure = normalizeFilesystemError(
        error,
        'Registry-head read failed',
      );
    } finally {
      try {
        rmdirSync(this.#lockPath);
      } catch (cleanupError) {
        const failure = storeError(
          'post-commit-cleanup-failed',
          'Registry-head read lock cleanup failed',
          cleanupError,
        );
        this.#terminalFailure = failure;
        cleanupFailure = failure;
      }
    }
    if (primaryFailure !== null) throw primaryFailure;
    if (cleanupFailure !== null) throw cleanupFailure;
    if (snapshot === null) {
      throw storeError(
        'filesystem-failure',
        'Registry-head read completed without a snapshot',
      );
    }
    return snapshot;
  }

  #loadSnapshot(): PosixRegistryHeadSnapshot {
    this.#ensureBaseDirectory();
    let descriptor: number | null = null;
    try {
      let pathStatus: Stats;
      try {
        pathStatus = lstatSync(this.#snapshotPath);
      } catch (error) {
        if (nodeErrorCode(error) === 'ENOENT') return emptySnapshot();
        throw error;
      }
      if (!pathStatus.isFile() || pathStatus.isSymbolicLink()) {
        throw storeError(
          'snapshot-invalid',
          'Registry-head snapshot must be a regular non-symlink file',
        );
      }
      descriptor = openSync(this.#snapshotPath, constants.O_RDONLY | NOFOLLOW);
      const status = fstatSync(descriptor);
      if (status.dev !== pathStatus.dev || status.ino !== pathStatus.ino) {
        throw storeError(
          'snapshot-invalid',
          'Registry-head snapshot identity changed while opening',
        );
      }
      if (
        !status.isFile() ||
        status.nlink !== 1 ||
        !Number.isSafeInteger(status.size) ||
        status.size <= 0 ||
        status.size > POSIX_REGISTRY_HEAD_MAX_SNAPSHOT_BYTES
      ) {
        throw storeError(
          status.size > POSIX_REGISTRY_HEAD_MAX_SNAPSHOT_BYTES
            ? 'snapshot-limit-exceeded'
            : 'snapshot-invalid',
          'Registry-head snapshot type or size is invalid',
        );
      }
      if ((status.mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw storeError(
          'snapshot-invalid',
          'Registry-head snapshot must have POSIX mode 0600',
        );
      }
      if (
        typeof process.getuid === 'function' &&
        status.uid !== process.getuid()
      ) {
        throw storeError(
          'snapshot-invalid',
          'Registry-head snapshot must be owned by the current user',
        );
      }
      const bytes = Buffer.alloc(status.size);
      let offset = 0;
      while (offset < bytes.length) {
        const bytesRead = readSync(
          descriptor,
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (bytesRead === 0) {
          throw storeError(
            'snapshot-invalid',
            'Registry-head snapshot changed or truncated while being read',
          );
        }
        offset += bytesRead;
      }
      const probe = Buffer.alloc(1);
      if (readSync(descriptor, probe, 0, 1, bytes.length) !== 0) {
        throw storeError(
          'snapshot-limit-exceeded',
          'Registry-head snapshot grew while being read',
        );
      }
      const text = decodeUtf8(bytes);
      const parsed = parseCanonicalJson(text);
      const snapshot = validateStoreSnapshot(parsed);
      if (canonicalizeJson(snapshot) !== text) {
        throw storeError(
          'snapshot-invalid',
          'Registry-head snapshot changed during validation',
        );
      }
      this.#ensureBaseDirectory();
      return snapshot;
    } catch (error) {
      throw normalizeFilesystemError(
        error,
        'Unable to read registry-head snapshot',
        'snapshot-invalid',
      );
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }

  #writeSnapshot(snapshot: PosixRegistryHeadSnapshot): void {
    const text = canonicalizeJson(snapshot);
    const bytes = encodeUtf8(text);
    if (bytes.length > POSIX_REGISTRY_HEAD_MAX_SNAPSHOT_BYTES) {
      throw storeError(
        'snapshot-limit-exceeded',
        'Registry-head snapshot exceeds the byte limit',
      );
    }
    let descriptor: number | null = null;
    try {
      descriptor = openSync(
        this.#stagingPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      fchmodSync(descriptor, PRIVATE_FILE_MODE);
      const stagingStatus = fstatSync(descriptor);
      if (
        !stagingStatus.isFile() ||
        stagingStatus.nlink !== 1 ||
        (stagingStatus.mode & 0o777) !== PRIVATE_FILE_MODE ||
        (typeof process.getuid === 'function' &&
          stagingStatus.uid !== process.getuid())
      ) {
        throw storeError(
          'filesystem-failure',
          'Registry-head staging file security properties are invalid',
        );
      }
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(this.#stagingPath, this.#snapshotPath);
      const directoryDescriptor = openSync(
        this.#baseDirectory,
        constants.O_RDONLY | NOFOLLOW,
      );
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
      this.#ensureBaseDirectory();
    } catch (error) {
      throw normalizeFilesystemError(
        error,
        'Unable to persist registry-head snapshot',
      );
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }
}

function validateOptions(value: unknown): PosixRegistryHeadStoreOptions {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw storeError(
      'base-directory-invalid',
      'Registry-head store options must be a plain object',
    );
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== 1 || names[0] !== 'baseDirectory') {
    throw storeError(
      'base-directory-invalid',
      'Registry-head store options require only baseDirectory',
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'baseDirectory');
  if (!descriptor?.enumerable || !('value' in descriptor)) {
    throw storeError(
      'base-directory-invalid',
      'Registry-head baseDirectory must be an own data field',
    );
  }
  if (
    typeof descriptor.value !== 'string' ||
    !isAbsolute(descriptor.value) ||
    resolve(descriptor.value) !== descriptor.value
  ) {
    throw storeError(
      'base-directory-invalid',
      'Registry-head baseDirectory must be a normalized absolute path',
    );
  }
  return Object.freeze({ baseDirectory: descriptor.value });
}

function emptySnapshot(): PosixRegistryHeadSnapshot {
  return Object.freeze({
    kind: POSIX_REGISTRY_HEAD_SNAPSHOT_KIND,
    version: POSIX_REGISTRY_HEAD_SNAPSHOT_VERSION,
    mutationCount: 0,
    heads: Object.freeze([]),
  });
}

function validateStoreSnapshot(value: unknown): PosixRegistryHeadSnapshot {
  let canonical: string;
  try {
    canonical = canonicalizeJson(value);
  } catch (error) {
    throw storeError(
      'snapshot-invalid',
      'Registry-head snapshot is not closed canonical data',
      error,
    );
  }
  const parsed = parseCanonicalJson(canonical);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw storeError(
      'snapshot-invalid',
      'Registry-head snapshot must be an object',
    );
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['heads', 'kind', 'mutationCount', 'version'];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw storeError(
      'snapshot-invalid',
      'Registry-head snapshot has an invalid closed schema',
    );
  }
  if (
    record.kind !== POSIX_REGISTRY_HEAD_SNAPSHOT_KIND ||
    record.version !== POSIX_REGISTRY_HEAD_SNAPSHOT_VERSION ||
    !Number.isSafeInteger(record.mutationCount) ||
    (record.mutationCount as number) < 0
  ) {
    throw storeError(
      'snapshot-invalid',
      'Registry-head snapshot metadata is invalid',
    );
  }
  if (!Array.isArray(record.heads)) {
    throw storeError(
      'snapshot-invalid',
      'Registry-head heads must be an array',
    );
  }
  if (record.heads.length > POSIX_REGISTRY_HEAD_MAX_HEADS) {
    throw storeError(
      'snapshot-limit-exceeded',
      'Registry-head snapshot exceeds the head-count limit',
    );
  }
  const heads = record.heads.map(validateRegistryHeadSnapshot);
  let previous: string | null = null;
  for (const head of heads) {
    const key = serializeHeadKey(head);
    if (previous !== null && key <= previous) {
      throw storeError(
        'snapshot-invalid',
        'Registry heads must be strictly sorted and scope-unique',
      );
    }
    previous = key;
  }
  if ((record.mutationCount as number) < heads.length) {
    throw storeError(
      'snapshot-invalid',
      'Registry-head mutation count cannot be below the head count',
    );
  }
  return Object.freeze({
    kind: POSIX_REGISTRY_HEAD_SNAPSHOT_KIND,
    version: POSIX_REGISTRY_HEAD_SNAPSHOT_VERSION,
    mutationCount: record.mutationCount as number,
    heads: Object.freeze(heads),
  });
}

function assertSuccessor(
  expected: RegistryHeadSnapshot | null,
  next: RegistryHeadSnapshot,
): void {
  if (expected === null) {
    if (next.epoch !== 1 || next.previousManifestHash !== null) {
      throw storeError(
        'snapshot-invalid',
        'A new registry head must begin at genesis epoch 1',
      );
    }
    return;
  }
  if (
    serializeHeadKey(expected) !== serializeHeadKey(next) ||
    next.epoch !== expected.epoch + 1 ||
    next.previousManifestHash !== expected.manifestHash
  ) {
    throw storeError(
      'snapshot-invalid',
      'Registry-head CAS may only install the exact next hash-linked epoch',
    );
  }
}

function serializeHeadKey(key: RegistryHeadKey): string {
  const validated = validateRegistryHeadKey({
    registryType: key.registryType,
    workspaceId: key.workspaceId,
    taskId: key.taskId,
    rootObjectId: key.rootObjectId,
  });
  return canonicalizeJson(validated);
}

function headValuesEqual(
  left: RegistryHeadSnapshot | null,
  right: RegistryHeadSnapshot | null,
): boolean {
  if (left === null || right === null) return left === right;
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function nodeErrorCode(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'code');
  return descriptor &&
    'value' in descriptor &&
    typeof descriptor.value === 'string'
    ? descriptor.value
    : null;
}

function normalizeFilesystemError(
  error: unknown,
  message: string,
  fallbackCode: PosixRegistryHeadStoreErrorCode = 'filesystem-failure',
): PosixRegistryHeadStoreError {
  if (error instanceof PosixRegistryHeadStoreError) return error;
  return storeError(fallbackCode, message, error);
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function storeError(
  code: PosixRegistryHeadStoreErrorCode,
  message: string,
  originalCause?: unknown,
): PosixRegistryHeadStoreError {
  return new PosixRegistryHeadStoreError(code, message, originalCause);
}
