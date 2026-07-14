import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  canonicalizeJson,
  decodeUtf8,
  encodeUtf8,
  parseCanonicalJson,
} from '@clodex/contracts';
import {
  SAFE_CODING_LEDGER_DURABILITY_CONTRACT_VERSION,
  SAFE_CODING_LEDGER_IDENTITY_KEY_MAX_LENGTH,
  assertSafeCodingLedgerSuccessor,
  cloneSafeCodingLedgerRecord,
  safeCodingLedgerIdentityKeys,
  validateSafeCodingLedgerRecord,
  type AdapterDeclaredDurableLedgerContract,
  type SafeCodingLedgerPersistenceCasResult,
  type SafeCodingLedgerPersistenceMutation,
  type SafeCodingLedgerPersistenceTransactionPort,
  type SafeCodingLedgerRecord,
} from '@clodex/ledger';

export const POSIX_LEDGER_SNAPSHOT_FILENAME =
  'safe-coding-ledger.snapshot.v1.json' as const;
export const POSIX_LEDGER_STAGING_FILENAME =
  '.safe-coding-ledger.snapshot.v1.tmp' as const;
export const POSIX_LEDGER_LOCK_DIRECTORYNAME =
  '.safe-coding-ledger.snapshot.v1.lock' as const;

export const POSIX_LEDGER_STORE_KIND =
  'clodex.posix-safe-coding-ledger-store' as const;
export const POSIX_LEDGER_STORE_VERSION = 1 as const;
export const POSIX_LEDGER_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
// Kept well below the shared canonical-JSON 100k-node ceiling. A terminal
// record plus its eight reservation objects remains bounded at this count.
export const POSIX_LEDGER_MAX_RECORDS = 512;
export const POSIX_LEDGER_IDENTITIES_PER_RECORD = 8;
export const POSIX_LEDGER_MAX_IDENTITY_RESERVATIONS =
  POSIX_LEDGER_MAX_RECORDS * POSIX_LEDGER_IDENTITIES_PER_RECORD;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_ACQUISITION_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const MAX_LOCK_ACQUISITION_TIMEOUT_MS = 60_000;
const MAX_LOCK_RETRY_DELAY_MS = 1_000;

export const POSIX_LOCAL_SAFE_CODING_LEDGER_DURABILITY = Object.freeze({
  version: SAFE_CODING_LEDGER_DURABILITY_CONTRACT_VERSION,
  mode: 'adapter-declared-durable',
  adapterId: 'clodex-ledger-node.posix-local-snapshot-v1',
  atomicScope: 'storage-transaction',
  atomicRecordAndOutbox: true,
  stableBeforeSuccess: true,
  restartReadable: true,
  multiProcessCas: true,
} satisfies AdapterDeclaredDurableLedgerContract);

/**
 * Honest scope declaration for the adapter. This is a local POSIX filesystem
 * profile, not a protected ledger head, encryption layer, or anti-rollback
 * mechanism. A complete older valid snapshot cannot be distinguished from the
 * current snapshot without an independently protected monotonic anchor.
 */
export const POSIX_LOCAL_SAFE_CODING_LEDGER_PROFILE = Object.freeze({
  version: 1,
  profileId: 'clodex-ledger-node.posix-local-snapshot-v1',
  platformScope: 'posix-local-filesystem-only',
  crashModel:
    'single-host-filesystem-with-atomic-same-directory-rename-and-working-fsync',
  snapshotEncoding: 'strict-canonical-json-utf8',
  atomicReplace: 'same-directory-rename',
  lockKind: 'atomic-directory-no-stale-break',
  baseDirectoryMode: '0700',
  snapshotFileMode: '0600',
  encryptionAtRest: false,
  independentProtectedHead: false,
  antiRollback: false,
  networkFilesystemDurabilityClaim: false,
  trustedBasePathRequired: true,
  pathReplacementResistance:
    'inode-revalidated-best-effort-without-openat-relative-operations',
} as const);

export type PosixSafeCodingLedgerFaultPoint =
  | 'after-lock-acquired'
  | 'after-lock-directory-removed'
  | 'after-temporary-file-open'
  | 'after-temporary-file-write'
  | 'after-temporary-file-fsync'
  | 'after-atomic-rename'
  | 'after-directory-fsync';

export interface PosixSafeCodingLedgerStoreOptions {
  /** Trusted absolute directory. Record and identity values never enter paths. */
  readonly baseDirectory: string;
  readonly lockAcquisitionTimeoutMs?: number;
  readonly lockRetryDelayMs?: number;
  /** Deterministic fault injection for adapter verification. */
  readonly faultInjector?: (
    point: PosixSafeCodingLedgerFaultPoint,
  ) => void | Promise<void>;
}

export type PosixSafeCodingLedgerStoreErrorCode =
  | 'base-directory-invalid'
  | 'filesystem-failure'
  | 'lock-unavailable'
  | 'mutation-invalid'
  | 'orphan-temporary-file'
  | 'platform-unsupported'
  | 'store-invalid'
  | 'store-limit-exceeded';

export class PosixSafeCodingLedgerStoreError extends Error {
  public constructor(
    public readonly code: PosixSafeCodingLedgerStoreErrorCode,
    message: string,
    public readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = 'PosixSafeCodingLedgerStoreError';
  }
}

interface IdentityReservation {
  readonly identityKey: string;
  readonly transactionId: string;
}

interface PosixLedgerSnapshot {
  readonly kind: typeof POSIX_LEDGER_STORE_KIND;
  readonly version: typeof POSIX_LEDGER_STORE_VERSION;
  /** Equals the sum of all current record revisions. */
  readonly mutationCount: number;
  readonly records: readonly SafeCodingLedgerRecord[];
  readonly identityReservations: readonly IdentityReservation[];
}

interface ValidatedMutation {
  readonly transactionId: string;
  readonly expectedRevision: number | null;
  readonly nextRecord: SafeCodingLedgerRecord;
}

/**
 * Whole-store canonical snapshot adapter for a trusted local POSIX directory.
 *
 * CAS is rechecked only after acquiring an atomic lock directory. Successful
 * writes create a fixed-name 0600 staging file, fsync it, rename it over the
 * fixed-name snapshot, and fsync the containing directory before APPLIED can
 * escape. A surviving lock or staging file is never broken or promoted
 * automatically; mutations fail closed until an operator investigates it.
 */
export class PosixSafeCodingLedgerStore
  implements SafeCodingLedgerPersistenceTransactionPort
{
  public readonly durability = POSIX_LOCAL_SAFE_CODING_LEDGER_DURABILITY;
  public readonly profile = POSIX_LOCAL_SAFE_CODING_LEDGER_PROFILE;

  readonly #baseDirectory: string;
  readonly #snapshotPath: string;
  readonly #stagingPath: string;
  readonly #lockPath: string;
  readonly #lockAcquisitionTimeoutMs: number;
  readonly #lockRetryDelayMs: number;
  #baseDevice: number | null = null;
  #baseInode: number | null = null;
  #postCommitCleanupFailure: PosixSafeCodingLedgerStoreError | null = null;
  readonly #faultInjector:
    | PosixSafeCodingLedgerStoreOptions['faultInjector']
    | undefined;

  public constructor(options: PosixSafeCodingLedgerStoreOptions) {
    if (process.platform === 'win32') {
      throw new PosixSafeCodingLedgerStoreError(
        'platform-unsupported',
        'The POSIX ledger adapter is not supported on Windows',
      );
    }
    const baseDirectory = requireAbsoluteBaseDirectory(
      readDataProperty(options, 'baseDirectory'),
    );
    this.#baseDirectory = resolve(baseDirectory);
    this.#snapshotPath = join(
      this.#baseDirectory,
      POSIX_LEDGER_SNAPSHOT_FILENAME,
    );
    this.#stagingPath = join(
      this.#baseDirectory,
      POSIX_LEDGER_STAGING_FILENAME,
    );
    this.#lockPath = join(this.#baseDirectory, POSIX_LEDGER_LOCK_DIRECTORYNAME);
    this.#lockAcquisitionTimeoutMs = requireBoundedIntegerOption(
      readOptionalDataProperty(options, 'lockAcquisitionTimeoutMs'),
      DEFAULT_LOCK_ACQUISITION_TIMEOUT_MS,
      0,
      MAX_LOCK_ACQUISITION_TIMEOUT_MS,
      'lockAcquisitionTimeoutMs',
    );
    this.#lockRetryDelayMs = requireBoundedIntegerOption(
      readOptionalDataProperty(options, 'lockRetryDelayMs'),
      DEFAULT_LOCK_RETRY_DELAY_MS,
      1,
      MAX_LOCK_RETRY_DELAY_MS,
      'lockRetryDelayMs',
    );
    this.#faultInjector = readOptionalFunctionProperty(
      options,
      'faultInjector',
    );
  }

  public async read(transactionIdValue: string): Promise<unknown | null> {
    const transactionId = requireIdentifier(
      transactionIdValue,
      'Ledger transaction ID',
      'mutation-invalid',
    );
    await this.#ensureBaseDirectory();
    const snapshot = await this.#loadSnapshot();
    const record = snapshot.records.find(
      (candidate) => candidate.transactionId === transactionId,
    );
    return record ? cloneSafeCodingLedgerRecord(record) : null;
  }

  public async scan(): Promise<readonly unknown[]> {
    await this.#ensureBaseDirectory();
    const snapshot = await this.#loadSnapshot();
    return Object.freeze(snapshot.records.map(cloneSafeCodingLedgerRecord));
  }

  public async compareAndSwap(
    mutationValue: SafeCodingLedgerPersistenceMutation,
  ): Promise<SafeCodingLedgerPersistenceCasResult> {
    if (this.#postCommitCleanupFailure !== null) {
      throw this.#postCommitCleanupFailure;
    }
    const mutation = validateMutation(mutationValue);
    await this.#ensureBaseDirectory();
    return await this.#withMutationLock(async () => {
      const currentSnapshot = await this.#loadSnapshot();
      const current =
        currentSnapshot.records.find(
          (record) => record.transactionId === mutation.transactionId,
        ) ?? null;

      if (mutation.expectedRevision === null) {
        if (current !== null) {
          return Object.freeze({
            outcome: 'REVISION_CONFLICT',
            actualRevision: current.revision,
          });
        }
        if (
          mutation.nextRecord.revision !== 1 ||
          mutation.nextRecord.ticketState.status !== 'PREPARED'
        ) {
          throw adapterError(
            'mutation-invalid',
            'New ledger records must start at revision 1 in PREPARED',
          );
        }
      } else {
        if (
          current === null ||
          current.revision !== mutation.expectedRevision
        ) {
          return Object.freeze({
            outcome: 'REVISION_CONFLICT',
            actualRevision: current?.revision ?? null,
          });
        }
        try {
          assertSafeCodingLedgerSuccessor(current, mutation.nextRecord);
        } catch (error) {
          throw adapterError(
            'mutation-invalid',
            'Ledger mutation is not an exact valid successor',
            error,
          );
        }
      }

      const identityOwners = new Map(
        currentSnapshot.identityReservations.map((reservation) => [
          reservation.identityKey,
          reservation.transactionId,
        ]),
      );
      for (const identityKey of safeCodingLedgerIdentityKeys(
        mutation.nextRecord,
      )) {
        const owner = identityOwners.get(identityKey);
        if (owner !== undefined && owner !== mutation.transactionId) {
          return Object.freeze({
            outcome: 'IDENTITY_CONFLICT',
            identityKey,
          });
        }
      }

      const records = currentSnapshot.records.filter(
        (record) => record.transactionId !== mutation.transactionId,
      );
      records.push(cloneSafeCodingLedgerRecord(mutation.nextRecord));
      records.sort((left, right) =>
        compareStrings(left.transactionId, right.transactionId),
      );
      const nextSnapshot = createSnapshot(records);
      await this.#writeSnapshot(nextSnapshot);
      return Object.freeze({
        outcome: 'APPLIED',
        record: cloneSafeCodingLedgerRecord(mutation.nextRecord),
      });
    });
  }

  async #ensureBaseDirectory(): Promise<void> {
    try {
      try {
        await lstat(this.#baseDirectory);
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
        const parent = dirname(this.#baseDirectory);
        const parentMetadata = await lstat(parent);
        if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
          throw adapterError(
            'base-directory-invalid',
            'Ledger base parent must already be a real trusted directory',
          );
        }
        try {
          await mkdir(this.#baseDirectory, { mode: DIRECTORY_MODE });
        } catch (mkdirError) {
          if (!isNodeError(mkdirError, 'EEXIST')) throw mkdirError;
        }
      }
      const before = await lstat(this.#baseDirectory);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw adapterError(
          'base-directory-invalid',
          'Ledger base path must be a real directory, not a symlink',
        );
      }
      if (
        typeof process.getuid === 'function' &&
        before.uid !== process.getuid()
      ) {
        throw adapterError(
          'base-directory-invalid',
          'Ledger base directory must be owned by the current user',
        );
      }
      await chmod(this.#baseDirectory, DIRECTORY_MODE);
      const after = await lstat(this.#baseDirectory);
      if (
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        permissionBits(after.mode) !== DIRECTORY_MODE
      ) {
        throw adapterError(
          'base-directory-invalid',
          'Ledger base directory must have POSIX mode 0700',
        );
      }
      this.#assertAndPinBaseIdentity(after.dev, after.ino);
      const parent = dirname(this.#baseDirectory);
      const parentMetadata = await lstat(parent);
      if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
        throw adapterError(
          'base-directory-invalid',
          'Ledger base parent must remain a real trusted directory',
        );
      }
      // Always stabilize the directory entry, including recovery after a
      // prior creator crashed between mkdir and parent fsync.
      await syncDirectoryPath(parent);
      await this.#syncBaseDirectory();
    } catch (error) {
      throw wrapFilesystemError(
        error,
        'Failed to establish the POSIX ledger base directory',
      );
    }
  }

  async #loadSnapshot(): Promise<PosixLedgerSnapshot> {
    await this.#assertBaseDirectoryIdentity();
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        this.#snapshotPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        await this.#assertBaseDirectoryIdentity();
        return EMPTY_SNAPSHOT;
      }
      throw wrapFilesystemError(error, 'Failed to open ledger snapshot');
    }

    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw adapterError(
          'store-invalid',
          'Ledger snapshot must be a regular file',
        );
      }
      if (metadata.nlink !== 1) {
        throw adapterError(
          'store-invalid',
          'Ledger snapshot must not have hard-link aliases',
        );
      }
      if (permissionBits(metadata.mode) !== FILE_MODE) {
        throw adapterError(
          'store-invalid',
          'Ledger snapshot must have POSIX mode 0600',
        );
      }
      if (
        !Number.isSafeInteger(metadata.size) ||
        metadata.size <= 0 ||
        metadata.size > POSIX_LEDGER_MAX_SNAPSHOT_BYTES
      ) {
        throw adapterError(
          'store-limit-exceeded',
          'Ledger snapshot byte length is outside the fixed bound',
        );
      }
      const bytes = Buffer.alloc(metadata.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (bytesRead === 0) {
          throw adapterError(
            'store-invalid',
            'Ledger snapshot changed or truncated while being read',
          );
        }
        offset += bytesRead;
      }
      const probe = Buffer.alloc(1);
      const { bytesRead: extraBytes } = await handle.read(
        probe,
        0,
        1,
        bytes.length,
      );
      if (extraBytes !== 0) {
        throw adapterError(
          'store-limit-exceeded',
          'Ledger snapshot grew while being read',
        );
      }
      let parsed: unknown;
      try {
        parsed = parseCanonicalJson(decodeUtf8(bytes));
      } catch (error) {
        throw adapterError(
          'store-invalid',
          'Ledger snapshot is not exact canonical UTF-8 JSON',
          error,
        );
      }
      const snapshot = validateSnapshot(parsed);
      await this.#assertBaseDirectoryIdentity();
      return snapshot;
    } catch (error) {
      throw wrapFilesystemError(error, 'Failed to read ledger snapshot');
    } finally {
      await handle.close();
    }
  }

  async #writeSnapshot(snapshotValue: PosixLedgerSnapshot): Promise<void> {
    const snapshot = validateSnapshot(snapshotValue);
    const bytes = encodeUtf8(canonicalizeJson(snapshot));
    if (bytes.byteLength > POSIX_LEDGER_MAX_SNAPSHOT_BYTES) {
      throw adapterError(
        'store-limit-exceeded',
        'Next ledger snapshot exceeds the fixed byte bound',
      );
    }
    await this.#assertBaseDirectoryIdentity();
    await this.#assertNoStagingEntry();

    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let renamed = false;
    try {
      handle = await open(
        this.#stagingPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        FILE_MODE,
      );
      await handle.chmod(FILE_MODE);
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        permissionBits(metadata.mode) !== FILE_MODE
      ) {
        throw adapterError(
          'filesystem-failure',
          'Ledger staging file did not satisfy the 0600 regular-file contract',
        );
      }
      await this.#injectFault('after-temporary-file-open');
      await handle.writeFile(bytes);
      await this.#injectFault('after-temporary-file-write');
      await handle.sync();
      await this.#injectFault('after-temporary-file-fsync');
      await handle.close();
      handle = null;

      await rename(this.#stagingPath, this.#snapshotPath);
      renamed = true;
      await this.#injectFault('after-atomic-rename');
      await this.#syncBaseDirectory();
      await this.#injectFault('after-directory-fsync');
      await this.#assertBaseDirectoryIdentity();
    } catch (error) {
      if (renamed) {
        try {
          await this.#syncBaseDirectory();
          const recovered = await this.#loadSnapshot();
          if (canonicalizeJson(recovered) === canonicalizeJson(snapshot)) {
            return;
          }
        } catch (recoveryError) {
          throw wrapFilesystemError(
            new AggregateError(
              [error, recoveryError],
              'Post-rename ledger reconciliation failed',
            ),
            'Failed to durably replace or reconcile ledger snapshot',
          );
        }
      }
      throw wrapFilesystemError(
        error,
        'Failed to durably replace ledger snapshot',
      );
    } finally {
      if (handle !== null) await handle.close();
    }
  }

  async #assertNoStagingEntry(): Promise<void> {
    try {
      await lstat(this.#stagingPath);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return;
      throw wrapFilesystemError(error, 'Failed to inspect ledger staging path');
    }
    throw adapterError(
      'orphan-temporary-file',
      'A fixed-name ledger staging entry already exists; it will not be promoted or removed automatically',
    );
  }

  async #withMutationLock<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    await this.#acquireMutationLock();
    let result: Result;
    try {
      await this.#injectFault('after-lock-acquired');
      result = await operation();
    } catch (error) {
      try {
        await this.#releaseMutationLock();
      } catch {
        // Preserve the operation failure. The unresolved release failure is
        // fail-closed too: a surviving lock can only block later mutations.
      }
      throw error;
    }
    try {
      await this.#releaseMutationLock();
    } catch (error) {
      this.#postCommitCleanupFailure = wrapFilesystemError(
        error,
        'Ledger mutation applied, but durable lock cleanup failed; this store instance is mutation-blocked',
      );
    }
    return result;
  }

  async #releaseMutationLock(): Promise<void> {
    try {
      await this.#assertBaseDirectoryIdentity();
      await rmdir(this.#lockPath);
      await this.#injectFault('after-lock-directory-removed');
      await this.#syncBaseDirectory();
    } catch (error) {
      throw wrapFilesystemError(
        error,
        'Failed to release the ledger mutation lock durably',
      );
    }
  }

  async #acquireMutationLock(): Promise<void> {
    await this.#assertBaseDirectoryIdentity();
    const deadline = Date.now() + this.#lockAcquisitionTimeoutMs;
    for (;;) {
      try {
        await mkdir(this.#lockPath, { mode: DIRECTORY_MODE });
        const metadata = await lstat(this.#lockPath);
        if (
          !metadata.isDirectory() ||
          metadata.isSymbolicLink() ||
          permissionBits(metadata.mode) !== DIRECTORY_MODE
        ) {
          throw adapterError(
            'filesystem-failure',
            'Ledger mutation lock is not a private directory',
          );
        }
        await this.#assertBaseDirectoryIdentity();
        return;
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) {
          throw wrapFilesystemError(
            error,
            'Failed to acquire ledger mutation lock',
          );
        }
        if (Date.now() >= deadline) {
          throw adapterError(
            'lock-unavailable',
            'Ledger mutation lock remained present; stale locks are never broken automatically',
            error,
          );
        }
        await sleep(this.#lockRetryDelayMs);
      }
    }
  }

  async #syncBaseDirectory(): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(
        this.#baseDirectory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const metadata = await handle.stat();
      this.#assertAndPinBaseIdentity(metadata.dev, metadata.ino);
      await handle.sync();
    } finally {
      if (handle !== null) await handle.close();
    }
  }

  async #assertBaseDirectoryIdentity(): Promise<void> {
    try {
      const metadata = await lstat(this.#baseDirectory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw adapterError(
          'base-directory-invalid',
          'Ledger base path stopped naming a real directory',
        );
      }
      this.#assertAndPinBaseIdentity(metadata.dev, metadata.ino);
    } catch (error) {
      throw wrapFilesystemError(
        error,
        'Failed to revalidate the pinned ledger base directory',
      );
    }
  }

  #assertAndPinBaseIdentity(device: number, inode: number): void {
    if (this.#baseDevice === null || this.#baseInode === null) {
      this.#baseDevice = device;
      this.#baseInode = inode;
      return;
    }
    if (this.#baseDevice !== device || this.#baseInode !== inode) {
      throw adapterError(
        'base-directory-invalid',
        'Ledger base directory identity changed after it was pinned',
      );
    }
  }

  async #injectFault(point: PosixSafeCodingLedgerFaultPoint): Promise<void> {
    await this.#faultInjector?.(point);
  }
}

const EMPTY_SNAPSHOT = createSnapshot([]);

function createSnapshot(
  recordValues: readonly SafeCodingLedgerRecord[],
): PosixLedgerSnapshot {
  if (recordValues.length > POSIX_LEDGER_MAX_RECORDS) {
    throw adapterError(
      'store-limit-exceeded',
      'Ledger record count exceeds the fixed bound',
    );
  }
  const records = recordValues
    .map(cloneSafeCodingLedgerRecord)
    .sort((left, right) =>
      compareStrings(left.transactionId, right.transactionId),
    );
  const identityReservations = deriveIdentityReservations(records);
  let mutationCount = 0;
  for (const record of records) {
    mutationCount = safeAdd(mutationCount, record.revision, 'mutation count');
  }
  return validateSnapshot({
    kind: POSIX_LEDGER_STORE_KIND,
    version: POSIX_LEDGER_STORE_VERSION,
    mutationCount,
    records,
    identityReservations,
  });
}

function validateSnapshot(value: unknown): PosixLedgerSnapshot {
  const snapshot = requireClosedRecord(value, 'Ledger snapshot');
  requireExactKeys(
    snapshot,
    ['kind', 'version', 'mutationCount', 'records', 'identityReservations'],
    'Ledger snapshot',
  );
  if (snapshot.kind !== POSIX_LEDGER_STORE_KIND) {
    throw adapterError('store-invalid', 'Ledger snapshot kind is invalid');
  }
  if (snapshot.version !== POSIX_LEDGER_STORE_VERSION) {
    throw adapterError('store-invalid', 'Ledger snapshot version is invalid');
  }
  const mutationCount = requireNonNegativeSafeInteger(
    snapshot.mutationCount,
    'Ledger snapshot mutation count',
    'store-invalid',
  );
  const recordValues = requireBoundedArray(
    snapshot.records,
    POSIX_LEDGER_MAX_RECORDS,
    'Ledger snapshot records',
  );
  const identityValues = requireBoundedArray(
    snapshot.identityReservations,
    POSIX_LEDGER_MAX_IDENTITY_RESERVATIONS,
    'Ledger snapshot identity reservations',
  );

  const records: SafeCodingLedgerRecord[] = [];
  let previousTransactionId: string | null = null;
  let derivedMutationCount = 0;
  for (const value of recordValues) {
    let record: SafeCodingLedgerRecord;
    try {
      record = validateSafeCodingLedgerRecord(value);
    } catch (error) {
      throw adapterError(
        'store-invalid',
        'Ledger snapshot contains an invalid record',
        error,
      );
    }
    if (
      previousTransactionId !== null &&
      compareStrings(previousTransactionId, record.transactionId) >= 0
    ) {
      throw adapterError(
        'store-invalid',
        'Ledger snapshot records are not strictly sorted and unique',
      );
    }
    if (record.revision !== expectedRevisionForState(record)) {
      throw adapterError(
        'store-invalid',
        'Ledger record revision is rollback-shaped for its state',
      );
    }
    previousTransactionId = record.transactionId;
    derivedMutationCount = safeAdd(
      derivedMutationCount,
      record.revision,
      'derived mutation count',
    );
    records.push(cloneSafeCodingLedgerRecord(record));
  }
  if (mutationCount !== derivedMutationCount) {
    throw adapterError(
      'store-invalid',
      'Ledger snapshot mutation count does not match record revisions',
    );
  }

  const expectedIdentities = deriveIdentityReservations(records);
  if (identityValues.length !== expectedIdentities.length) {
    throw adapterError(
      'store-invalid',
      'Ledger snapshot identity reservation set is incomplete or excessive',
    );
  }
  const identityReservations = identityValues.map((entry, index) => {
    const reservation = validateIdentityReservation(entry);
    const expected = expectedIdentities[index];
    if (
      expected === undefined ||
      reservation.identityKey !== expected.identityKey ||
      reservation.transactionId !== expected.transactionId
    ) {
      throw adapterError(
        'store-invalid',
        'Ledger snapshot identity reservations do not exactly match records',
      );
    }
    return reservation;
  });

  const result = {
    kind: POSIX_LEDGER_STORE_KIND,
    version: POSIX_LEDGER_STORE_VERSION,
    mutationCount,
    records: Object.freeze(records),
    identityReservations: Object.freeze(identityReservations),
  } as const;
  const encodedLength = encodeUtf8(canonicalizeJson(result)).byteLength;
  if (encodedLength > POSIX_LEDGER_MAX_SNAPSHOT_BYTES) {
    throw adapterError(
      'store-limit-exceeded',
      'Canonical ledger snapshot exceeds the fixed byte bound',
    );
  }
  return Object.freeze(result);
}

function validateMutation(value: unknown): ValidatedMutation {
  const mutation = requireClosedRecord(value, 'Ledger persistence mutation');
  requireExactKeys(
    mutation,
    ['transactionId', 'expectedRevision', 'nextRecord'],
    'Ledger persistence mutation',
    'mutation-invalid',
  );
  const transactionId = requireIdentifier(
    mutation.transactionId,
    'Ledger mutation transaction ID',
    'mutation-invalid',
  );
  const expectedRevision =
    mutation.expectedRevision === null
      ? null
      : requirePositiveSafeInteger(
          mutation.expectedRevision,
          'Ledger expected revision',
          'mutation-invalid',
        );
  let nextRecord: SafeCodingLedgerRecord;
  try {
    nextRecord = validateSafeCodingLedgerRecord(mutation.nextRecord);
  } catch (error) {
    throw adapterError(
      'mutation-invalid',
      'Ledger mutation next record is invalid',
      error,
    );
  }
  if (nextRecord.transactionId !== transactionId) {
    throw adapterError(
      'mutation-invalid',
      'Ledger mutation key does not match its next record',
    );
  }
  return Object.freeze({ transactionId, expectedRevision, nextRecord });
}

function deriveIdentityReservations(
  records: readonly SafeCodingLedgerRecord[],
): readonly IdentityReservation[] {
  const owners = new Map<string, string>();
  for (const record of records) {
    for (const identityKey of safeCodingLedgerIdentityKeys(record)) {
      const existing = owners.get(identityKey);
      if (existing !== undefined && existing !== record.transactionId) {
        throw adapterError(
          'store-invalid',
          `Ledger identity ${identityKey} has multiple owners`,
        );
      }
      owners.set(identityKey, record.transactionId);
    }
  }
  if (owners.size > POSIX_LEDGER_MAX_IDENTITY_RESERVATIONS) {
    throw adapterError(
      'store-limit-exceeded',
      'Ledger identity reservation count exceeds the fixed bound',
    );
  }
  return Object.freeze(
    [...owners.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([identityKey, transactionId]) =>
        Object.freeze({ identityKey, transactionId }),
      ),
  );
}

function validateIdentityReservation(value: unknown): IdentityReservation {
  const reservation = requireClosedRecord(value, 'Identity reservation');
  requireExactKeys(
    reservation,
    ['identityKey', 'transactionId'],
    'Identity reservation',
  );
  return Object.freeze({
    identityKey: requireIdentityKey(
      reservation.identityKey,
      'Reserved identity key',
      'store-invalid',
    ),
    transactionId: requireIdentifier(
      reservation.transactionId,
      'Identity owner transaction ID',
      'store-invalid',
    ),
  });
}

function expectedRevisionForState(record: SafeCodingLedgerRecord): number {
  let revision: number;
  switch (record.ticketState.status) {
    case 'PREPARED':
      revision = 1;
      break;
    case 'COMMIT_PERMIT':
    case 'FAILED_PRE_EFFECT':
      revision = 2;
      break;
    case 'COMMITTED':
    case 'RESULT_UNAVAILABLE':
    case 'UNCERTAIN':
      revision = 3;
      break;
  }
  if (record.evidenceAdmission.status === 'ADMITTED') revision += 1;
  return revision;
}

function requireAbsoluteBaseDirectory(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes('\0') ||
    !isAbsolute(value)
  ) {
    throw adapterError(
      'base-directory-invalid',
      'Ledger baseDirectory must be a bounded absolute path',
    );
  }
  return value;
}

function requireBoundedIntegerOption(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw adapterError(
      'mutation-invalid',
      `${label} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value as number;
}

function requireClosedRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.getOwnPropertyNames(value).length !== Object.keys(value).length ||
    Object.getOwnPropertyNames(value).some((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return !descriptor || !('value' in descriptor);
    })
  ) {
    throw adapterError(
      'store-invalid',
      `${label} must be a closed data record`,
    );
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
  code: PosixSafeCodingLedgerStoreErrorCode = 'store-invalid',
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw adapterError(code, `${label} has unknown or missing fields`);
  }
}

function requireBoundedArray(
  value: unknown,
  maximum: number,
  label: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw adapterError('store-invalid', `${label} must be an array`);
  }
  if (value.length > maximum) {
    throw adapterError(
      'store-limit-exceeded',
      `${label} exceeds its fixed count bound`,
    );
  }
  return value;
}

function requireIdentifier(
  value: unknown,
  label: string,
  code: PosixSafeCodingLedgerStoreErrorCode,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) {
    throw adapterError(code, `${label} must be a bounded identifier`);
  }
  return value;
}

function requireIdentityKey(
  value: unknown,
  label: string,
  code: PosixSafeCodingLedgerStoreErrorCode,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > SAFE_CODING_LEDGER_IDENTITY_KEY_MAX_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) {
    throw adapterError(code, `${label} must be a bounded ledger identity key`);
  }
  return value;
}

function requirePositiveSafeInteger(
  value: unknown,
  label: string,
  code: PosixSafeCodingLedgerStoreErrorCode,
): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw adapterError(code, `${label} must be a positive safe integer`);
  }
  return value as number;
}

function requireNonNegativeSafeInteger(
  value: unknown,
  label: string,
  code: PosixSafeCodingLedgerStoreErrorCode,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw adapterError(code, `${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw adapterError('store-limit-exceeded', `Ledger ${label} overflowed`);
  }
  return result;
}

function readDataProperty<Key extends keyof PosixSafeCodingLedgerStoreOptions>(
  value: PosixSafeCodingLedgerStoreOptions,
  key: Key,
): PosixSafeCodingLedgerStoreOptions[Key] {
  if (value === null || typeof value !== 'object') {
    throw adapterError(
      'mutation-invalid',
      'POSIX ledger options must be a data record',
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor)) {
    throw adapterError(
      'mutation-invalid',
      `POSIX ledger option ${String(key)} must be a data property`,
    );
  }
  return descriptor.value as PosixSafeCodingLedgerStoreOptions[Key];
}

function readOptionalDataProperty<
  Key extends keyof PosixSafeCodingLedgerStoreOptions,
>(
  value: PosixSafeCodingLedgerStoreOptions,
  key: Key,
): PosixSafeCodingLedgerStoreOptions[Key] | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) {
    throw adapterError(
      'mutation-invalid',
      `POSIX ledger option ${String(key)} must be a data property`,
    );
  }
  return descriptor.value as PosixSafeCodingLedgerStoreOptions[Key];
}

function readOptionalFunctionProperty(
  value: PosixSafeCodingLedgerStoreOptions,
  key: 'faultInjector',
): PosixSafeCodingLedgerStoreOptions['faultInjector'] | undefined {
  const candidate = readOptionalDataProperty(value, key);
  if (candidate !== undefined && typeof candidate !== 'function') {
    throw adapterError(
      'mutation-invalid',
      'POSIX ledger faultInjector must be a function',
    );
  }
  return candidate;
}

function permissionBits(mode: number): number {
  return mode & 0o777;
}

async function syncDirectoryPath(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    await handle.sync();
  } finally {
    if (handle !== null) await handle.close();
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function adapterError(
  code: PosixSafeCodingLedgerStoreErrorCode,
  message: string,
  cause?: unknown,
): PosixSafeCodingLedgerStoreError {
  return new PosixSafeCodingLedgerStoreError(code, message, cause);
}

function wrapFilesystemError(
  error: unknown,
  message: string,
): PosixSafeCodingLedgerStoreError {
  if (error instanceof PosixSafeCodingLedgerStoreError) return error;
  return adapterError('filesystem-failure', message, error);
}
