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
  CONTROL_PLANE_DURABILITY_CONTRACT_VERSION,
  CONTROL_PLANE_IDENTITY_KEY_MAX_LENGTH,
  assertControlPlaneSuccessor,
  cloneControlPlaneTransactionRecord,
  controlPlaneIdentityKeys,
  invokeControlPlanePreCommitFence,
  validateControlPlaneTransactionRecord,
  type AdapterDeclaredDurableControlPlaneContract,
  type ControlPlaneStorageCasResult,
  type ControlPlaneStorageMutation,
  type ControlPlaneStorageTransactionPort,
  type ControlPlaneTransactionRecord,
} from '@clodex/control-plane';

export const POSIX_CONTROL_PLANE_SNAPSHOT_FILENAME =
  'execution-control-plane.snapshot.v1.json' as const;
export const POSIX_CONTROL_PLANE_STAGING_FILENAME =
  '.execution-control-plane.snapshot.v1.tmp' as const;
export const POSIX_CONTROL_PLANE_LOCK_DIRECTORYNAME =
  '.execution-control-plane.snapshot.v1.lock' as const;

export const POSIX_CONTROL_PLANE_STORE_KIND =
  'clodex.posix-execution-control-plane-store' as const;
export const POSIX_CONTROL_PLANE_STORE_VERSION = 1 as const;
export const POSIX_CONTROL_PLANE_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
// Kept well below the shared canonical-JSON 100k-node ceiling. A terminal
// record plus its ten reservation objects remains bounded at this count.
export const POSIX_CONTROL_PLANE_MAX_RECORDS = 512;
export const POSIX_CONTROL_PLANE_IDENTITIES_PER_RECORD = 10;
export const POSIX_CONTROL_PLANE_MAX_IDENTITY_RESERVATIONS =
  POSIX_CONTROL_PLANE_MAX_RECORDS * POSIX_CONTROL_PLANE_IDENTITIES_PER_RECORD;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_ACQUISITION_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const MAX_LOCK_ACQUISITION_TIMEOUT_MS = 60_000;
const MAX_LOCK_RETRY_DELAY_MS = 1_000;

export const POSIX_LOCAL_CONTROL_PLANE_DURABILITY = Object.freeze({
  version: CONTROL_PLANE_DURABILITY_CONTRACT_VERSION,
  mode: 'adapter-declared-durable',
  adapterId: 'clodex-control-plane-node.posix-local-snapshot-v1',
  atomicScope: 'storage-transaction',
  atomicTicketPermitLedgerOutbox: true,
  linearizableCas: true,
  stableBeforeSuccess: true,
  restartReadable: true,
  multiProcessCas: true,
  externalEffectInStorageTransaction: false,
  recoveryMayReplayEffects: false,
} satisfies AdapterDeclaredDurableControlPlaneContract);

/**
 * Honest scope declaration for the adapter. This is a local POSIX filesystem
 * profile, not a protected control-plane head, encryption layer, or anti-rollback
 * mechanism. A complete older valid snapshot cannot be distinguished from the
 * current snapshot without an independently protected monotonic anchor.
 */
export const POSIX_LOCAL_CONTROL_PLANE_PROFILE = Object.freeze({
  version: 1,
  profileId: 'clodex-control-plane-node.posix-local-snapshot-v1',
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
  externalEffectAtomicity: false,
  effectReplayOnRecovery: false,
  trustedBasePathRequired: true,
  pathReplacementResistance:
    'inode-revalidated-best-effort-without-openat-relative-operations',
} as const);

export type PosixControlPlaneFaultPoint =
  | 'after-lock-acquired'
  | 'after-lock-directory-removed'
  | 'after-temporary-file-open'
  | 'after-temporary-file-write'
  | 'after-temporary-file-fsync'
  | 'after-atomic-rename'
  | 'after-directory-fsync';

export interface PosixControlPlaneStoreOptions {
  /** Trusted absolute directory. Record and identity values never enter paths. */
  readonly baseDirectory: string;
  readonly lockAcquisitionTimeoutMs?: number;
  readonly lockRetryDelayMs?: number;
  /** Deterministic fault injection for adapter verification. */
  readonly faultInjector?: (
    point: PosixControlPlaneFaultPoint,
  ) => void | Promise<void>;
}

export type PosixControlPlaneStoreErrorCode =
  | 'base-directory-invalid'
  | 'filesystem-failure'
  | 'lock-unavailable'
  | 'mutation-invalid'
  | 'orphan-temporary-file'
  | 'platform-unsupported'
  | 'store-invalid'
  | 'store-limit-exceeded';

export class PosixControlPlaneStoreError extends Error {
  public constructor(
    public readonly code: PosixControlPlaneStoreErrorCode,
    message: string,
    public readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = 'PosixControlPlaneStoreError';
  }
}

interface IdentityReservation {
  readonly identityKey: string;
  readonly transactionId: string;
}

interface PosixControlPlaneSnapshot {
  readonly kind: typeof POSIX_CONTROL_PLANE_STORE_KIND;
  readonly version: typeof POSIX_CONTROL_PLANE_STORE_VERSION;
  /** Equals the sum of all current record revisions. */
  readonly mutationCount: number;
  readonly records: readonly ControlPlaneTransactionRecord[];
  readonly identityReservations: readonly IdentityReservation[];
}

interface ValidatedMutation {
  readonly transactionId: string;
  readonly expectedRevision: number | null;
  readonly nextRecord: ControlPlaneTransactionRecord;
  readonly preCommitFence: ControlPlaneStorageMutation['preCommitFence'];
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
export class PosixControlPlaneStore
  implements ControlPlaneStorageTransactionPort
{
  public readonly durability = POSIX_LOCAL_CONTROL_PLANE_DURABILITY;
  public readonly profile = POSIX_LOCAL_CONTROL_PLANE_PROFILE;

  readonly #baseDirectory: string;
  readonly #snapshotPath: string;
  readonly #stagingPath: string;
  readonly #lockPath: string;
  readonly #lockAcquisitionTimeoutMs: number;
  readonly #lockRetryDelayMs: number;
  #baseDevice: number | null = null;
  #baseInode: number | null = null;
  #postCommitCleanupFailure: PosixControlPlaneStoreError | null = null;
  readonly #faultInjector:
    | PosixControlPlaneStoreOptions['faultInjector']
    | undefined;

  public constructor(options: PosixControlPlaneStoreOptions) {
    if (process.platform === 'win32') {
      throw new PosixControlPlaneStoreError(
        'platform-unsupported',
        'The POSIX control-plane adapter is not supported on Windows',
      );
    }
    const baseDirectory = requireAbsoluteBaseDirectory(
      readDataProperty(options, 'baseDirectory'),
    );
    this.#baseDirectory = resolve(baseDirectory);
    this.#snapshotPath = join(
      this.#baseDirectory,
      POSIX_CONTROL_PLANE_SNAPSHOT_FILENAME,
    );
    this.#stagingPath = join(
      this.#baseDirectory,
      POSIX_CONTROL_PLANE_STAGING_FILENAME,
    );
    this.#lockPath = join(
      this.#baseDirectory,
      POSIX_CONTROL_PLANE_LOCK_DIRECTORYNAME,
    );
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
      'Control-plane transaction ID',
      'mutation-invalid',
    );
    await this.#ensureBaseDirectory();
    const snapshot = await this.#loadSnapshot();
    const record = snapshot.records.find(
      (candidate) => candidate.transactionId === transactionId,
    );
    return record ? cloneControlPlaneTransactionRecord(record) : null;
  }

  public async scan(): Promise<readonly unknown[]> {
    await this.#ensureBaseDirectory();
    const snapshot = await this.#loadSnapshot();
    return Object.freeze(
      snapshot.records.map(cloneControlPlaneTransactionRecord),
    );
  }

  public async compareAndSwap(
    mutationValue: ControlPlaneStorageMutation,
  ): Promise<ControlPlaneStorageCasResult> {
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
          mutation.nextRecord.phase !== 'PREPARED'
        ) {
          throw adapterError(
            'mutation-invalid',
            'New control-plane records must start at revision 1 in PREPARED',
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
          assertControlPlaneSuccessor(current, mutation.nextRecord);
        } catch (error) {
          throw adapterError(
            'mutation-invalid',
            'Control-plane mutation is not an exact valid successor',
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
      for (const identityKey of controlPlaneIdentityKeys(mutation.nextRecord)) {
        const owner = identityOwners.get(identityKey);
        if (owner !== undefined && owner !== mutation.transactionId) {
          return Object.freeze({
            outcome: 'IDENTITY_CONFLICT',
            identityKey,
          });
        }
      }

      // The authority/trust fence is synchronous and runs only after all CAS
      // and identity checks pass, while this adapter holds the mutation lock.
      // The subsequent filesystem transaction is local-only; it still cannot
      // include the external effect.
      invokeControlPlanePreCommitFence(mutation.preCommitFence);

      const records = currentSnapshot.records.filter(
        (record) => record.transactionId !== mutation.transactionId,
      );
      records.push(cloneControlPlaneTransactionRecord(mutation.nextRecord));
      records.sort((left, right) =>
        compareStrings(left.transactionId, right.transactionId),
      );
      const nextSnapshot = createSnapshot(records);
      await this.#writeSnapshot(nextSnapshot);
      return Object.freeze({
        outcome: 'APPLIED',
        record: cloneControlPlaneTransactionRecord(mutation.nextRecord),
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
            'Control-plane base parent must already be a real trusted directory',
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
          'Control-plane base path must be a real directory, not a symlink',
        );
      }
      if (
        typeof process.getuid === 'function' &&
        before.uid !== process.getuid()
      ) {
        throw adapterError(
          'base-directory-invalid',
          'Control-plane base directory must be owned by the current user',
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
          'Control-plane base directory must have POSIX mode 0700',
        );
      }
      this.#assertAndPinBaseIdentity(after.dev, after.ino);
      const parent = dirname(this.#baseDirectory);
      const parentMetadata = await lstat(parent);
      if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
        throw adapterError(
          'base-directory-invalid',
          'Control-plane base parent must remain a real trusted directory',
        );
      }
      // Always stabilize the directory entry, including recovery after a
      // prior creator crashed between mkdir and parent fsync.
      await syncDirectoryPath(parent);
      await this.#syncBaseDirectory();
    } catch (error) {
      throw wrapFilesystemError(
        error,
        'Failed to establish the POSIX control-plane base directory',
      );
    }
  }

  async #loadSnapshot(): Promise<PosixControlPlaneSnapshot> {
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
      throw wrapFilesystemError(error, 'Failed to open control-plane snapshot');
    }

    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw adapterError(
          'store-invalid',
          'Control-plane snapshot must be a regular file',
        );
      }
      if (metadata.nlink !== 1) {
        throw adapterError(
          'store-invalid',
          'Control-plane snapshot must not have hard-link aliases',
        );
      }
      if (permissionBits(metadata.mode) !== FILE_MODE) {
        throw adapterError(
          'store-invalid',
          'Control-plane snapshot must have POSIX mode 0600',
        );
      }
      if (
        !Number.isSafeInteger(metadata.size) ||
        metadata.size <= 0 ||
        metadata.size > POSIX_CONTROL_PLANE_MAX_SNAPSHOT_BYTES
      ) {
        throw adapterError(
          'store-limit-exceeded',
          'Control-plane snapshot byte length is outside the fixed bound',
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
            'Control-plane snapshot changed or truncated while being read',
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
          'Control-plane snapshot grew while being read',
        );
      }
      let parsed: unknown;
      try {
        parsed = parseCanonicalJson(decodeUtf8(bytes));
      } catch (error) {
        throw adapterError(
          'store-invalid',
          'Control-plane snapshot is not exact canonical UTF-8 JSON',
          error,
        );
      }
      const snapshot = validateSnapshot(parsed);
      await this.#assertBaseDirectoryIdentity();
      return snapshot;
    } catch (error) {
      throw wrapFilesystemError(error, 'Failed to read control-plane snapshot');
    } finally {
      await handle.close();
    }
  }

  async #writeSnapshot(
    snapshotValue: PosixControlPlaneSnapshot,
  ): Promise<void> {
    const snapshot = validateSnapshot(snapshotValue);
    const bytes = encodeUtf8(canonicalizeJson(snapshot));
    if (bytes.byteLength > POSIX_CONTROL_PLANE_MAX_SNAPSHOT_BYTES) {
      throw adapterError(
        'store-limit-exceeded',
        'Next control-plane snapshot exceeds the fixed byte bound',
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
          'Control-plane staging file did not satisfy the 0600 regular-file contract',
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
              'Post-rename control-plane reconciliation failed',
            ),
            'Failed to durably replace or reconcile control-plane snapshot',
          );
        }
      }
      throw wrapFilesystemError(
        error,
        'Failed to durably replace control-plane snapshot',
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
      throw wrapFilesystemError(
        error,
        'Failed to inspect control-plane staging path',
      );
    }
    throw adapterError(
      'orphan-temporary-file',
      'A fixed-name control-plane staging entry already exists; it will not be promoted or removed automatically',
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
        'Control-plane mutation applied, but durable lock cleanup failed; this store instance is mutation-blocked',
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
        'Failed to release the control-plane mutation lock durably',
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
            'Control-plane mutation lock is not a private directory',
          );
        }
        await this.#assertBaseDirectoryIdentity();
        return;
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) {
          throw wrapFilesystemError(
            error,
            'Failed to acquire control-plane mutation lock',
          );
        }
        if (Date.now() >= deadline) {
          throw adapterError(
            'lock-unavailable',
            'Control-plane mutation lock remained present; stale locks are never broken automatically',
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
          'Control-plane base path stopped naming a real directory',
        );
      }
      this.#assertAndPinBaseIdentity(metadata.dev, metadata.ino);
    } catch (error) {
      throw wrapFilesystemError(
        error,
        'Failed to revalidate the pinned control-plane base directory',
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
        'Control-plane base directory identity changed after it was pinned',
      );
    }
  }

  async #injectFault(point: PosixControlPlaneFaultPoint): Promise<void> {
    await this.#faultInjector?.(point);
  }
}

const EMPTY_SNAPSHOT = createSnapshot([]);

function createSnapshot(
  recordValues: readonly ControlPlaneTransactionRecord[],
): PosixControlPlaneSnapshot {
  if (recordValues.length > POSIX_CONTROL_PLANE_MAX_RECORDS) {
    throw adapterError(
      'store-limit-exceeded',
      'Control-plane record count exceeds the fixed bound',
    );
  }
  const records = recordValues
    .map(cloneControlPlaneTransactionRecord)
    .sort((left, right) =>
      compareStrings(left.transactionId, right.transactionId),
    );
  const identityReservations = deriveIdentityReservations(records);
  let mutationCount = 0;
  for (const record of records) {
    mutationCount = safeAdd(mutationCount, record.revision, 'mutation count');
  }
  return validateSnapshot({
    kind: POSIX_CONTROL_PLANE_STORE_KIND,
    version: POSIX_CONTROL_PLANE_STORE_VERSION,
    mutationCount,
    records,
    identityReservations,
  });
}

function validateSnapshot(value: unknown): PosixControlPlaneSnapshot {
  const snapshot = requireClosedRecord(value, 'Control-plane snapshot');
  requireExactKeys(
    snapshot,
    ['kind', 'version', 'mutationCount', 'records', 'identityReservations'],
    'Control-plane snapshot',
  );
  if (snapshot.kind !== POSIX_CONTROL_PLANE_STORE_KIND) {
    throw adapterError(
      'store-invalid',
      'Control-plane snapshot kind is invalid',
    );
  }
  if (snapshot.version !== POSIX_CONTROL_PLANE_STORE_VERSION) {
    throw adapterError(
      'store-invalid',
      'Control-plane snapshot version is invalid',
    );
  }
  const mutationCount = requireNonNegativeSafeInteger(
    snapshot.mutationCount,
    'Control-plane snapshot mutation count',
    'store-invalid',
  );
  const recordValues = requireBoundedArray(
    snapshot.records,
    POSIX_CONTROL_PLANE_MAX_RECORDS,
    'Control-plane snapshot records',
  );
  const identityValues = requireBoundedArray(
    snapshot.identityReservations,
    POSIX_CONTROL_PLANE_MAX_IDENTITY_RESERVATIONS,
    'Control-plane snapshot identity reservations',
  );

  const records: ControlPlaneTransactionRecord[] = [];
  let previousTransactionId: string | null = null;
  let derivedMutationCount = 0;
  for (const value of recordValues) {
    let record: ControlPlaneTransactionRecord;
    try {
      record = validateControlPlaneTransactionRecord(value);
    } catch (error) {
      throw adapterError(
        'store-invalid',
        'Control-plane snapshot contains an invalid record',
        error,
      );
    }
    if (
      previousTransactionId !== null &&
      compareStrings(previousTransactionId, record.transactionId) >= 0
    ) {
      throw adapterError(
        'store-invalid',
        'Control-plane snapshot records are not strictly sorted and unique',
      );
    }
    if (record.revision !== expectedRevisionForState(record)) {
      throw adapterError(
        'store-invalid',
        'Control-plane record revision is rollback-shaped for its state',
      );
    }
    previousTransactionId = record.transactionId;
    derivedMutationCount = safeAdd(
      derivedMutationCount,
      record.revision,
      'derived mutation count',
    );
    records.push(cloneControlPlaneTransactionRecord(record));
  }
  if (mutationCount !== derivedMutationCount) {
    throw adapterError(
      'store-invalid',
      'Control-plane snapshot mutation count does not match record revisions',
    );
  }

  const expectedIdentities = deriveIdentityReservations(records);
  if (identityValues.length !== expectedIdentities.length) {
    throw adapterError(
      'store-invalid',
      'Control-plane snapshot identity reservation set is incomplete or excessive',
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
        'Control-plane snapshot identity reservations do not exactly match records',
      );
    }
    return reservation;
  });

  const result = {
    kind: POSIX_CONTROL_PLANE_STORE_KIND,
    version: POSIX_CONTROL_PLANE_STORE_VERSION,
    mutationCount,
    records: Object.freeze(records),
    identityReservations: Object.freeze(identityReservations),
  } as const;
  const encodedLength = encodeUtf8(canonicalizeJson(result)).byteLength;
  if (encodedLength > POSIX_CONTROL_PLANE_MAX_SNAPSHOT_BYTES) {
    throw adapterError(
      'store-limit-exceeded',
      'Canonical control-plane snapshot exceeds the fixed byte bound',
    );
  }
  return Object.freeze(result);
}

function validateMutation(value: unknown): ValidatedMutation {
  const mutation = requireClosedRecord(
    value,
    'Control-plane persistence mutation',
  );
  const expectedKeys = Object.hasOwn(mutation, 'preCommitFence')
    ? ['transactionId', 'expectedRevision', 'nextRecord', 'preCommitFence']
    : ['transactionId', 'expectedRevision', 'nextRecord'];
  requireExactKeys(
    mutation,
    expectedKeys,
    'Control-plane persistence mutation',
    'mutation-invalid',
  );
  const transactionId = requireIdentifier(
    mutation.transactionId,
    'Control-plane mutation transaction ID',
    'mutation-invalid',
  );
  const expectedRevision =
    mutation.expectedRevision === null
      ? null
      : requirePositiveSafeInteger(
          mutation.expectedRevision,
          'Control-plane expected revision',
          'mutation-invalid',
        );
  let nextRecord: ControlPlaneTransactionRecord;
  try {
    nextRecord = validateControlPlaneTransactionRecord(mutation.nextRecord);
  } catch (error) {
    throw adapterError(
      'mutation-invalid',
      'Control-plane mutation next record is invalid',
      error,
    );
  }
  if (nextRecord.transactionId !== transactionId) {
    throw adapterError(
      'mutation-invalid',
      'Control-plane mutation key does not match its next record',
    );
  }
  const preCommitFence = mutation.preCommitFence;
  if (preCommitFence !== undefined && typeof preCommitFence !== 'function') {
    throw adapterError(
      'mutation-invalid',
      'Control-plane preCommitFence must be a synchronous function',
    );
  }
  return Object.freeze({
    transactionId,
    expectedRevision,
    nextRecord,
    preCommitFence:
      preCommitFence as ControlPlaneStorageMutation['preCommitFence'],
  });
}

function deriveIdentityReservations(
  records: readonly ControlPlaneTransactionRecord[],
): readonly IdentityReservation[] {
  const owners = new Map<string, string>();
  for (const record of records) {
    for (const identityKey of controlPlaneIdentityKeys(record)) {
      const existing = owners.get(identityKey);
      if (existing !== undefined && existing !== record.transactionId) {
        throw adapterError(
          'store-invalid',
          `Control-plane identity ${identityKey} has multiple owners`,
        );
      }
      owners.set(identityKey, record.transactionId);
    }
  }
  if (owners.size > POSIX_CONTROL_PLANE_MAX_IDENTITY_RESERVATIONS) {
    throw adapterError(
      'store-limit-exceeded',
      'Control-plane identity reservation count exceeds the fixed bound',
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

function expectedRevisionForState(
  record: ControlPlaneTransactionRecord,
): number {
  let revision: number;
  switch (record.phase) {
    case 'PREPARED':
      revision = 1;
      break;
    case 'COMMIT_PERMIT':
      revision = 2;
      break;
    case 'EFFECT_IN_FLIGHT':
      revision = 3;
      break;
    case 'COMMITTED':
    case 'RESULT_UNAVAILABLE':
      revision = 4;
      break;
    case 'FAILED_PRE_EFFECT':
      revision = record.commitPermit === null ? 2 : 4;
      break;
    case 'UNCERTAIN':
      revision = record.effect.startedAt === null ? 3 : 4;
      break;
  }
  if (record.evidenceOutbox.status === 'DELIVERED') revision += 1;
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
      'Control-plane baseDirectory must be a bounded absolute path',
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
  code: PosixControlPlaneStoreErrorCode = 'store-invalid',
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
  code: PosixControlPlaneStoreErrorCode,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+=-]*$/.test(value)
  ) {
    throw adapterError(code, `${label} must be a bounded identifier`);
  }
  return value;
}

function requireIdentityKey(
  value: unknown,
  label: string,
  code: PosixControlPlaneStoreErrorCode,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > CONTROL_PLANE_IDENTITY_KEY_MAX_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+=-]*$/.test(value)
  ) {
    throw adapterError(
      code,
      `${label} must be a bounded control-plane identity key`,
    );
  }
  return value;
}

function requirePositiveSafeInteger(
  value: unknown,
  label: string,
  code: PosixControlPlaneStoreErrorCode,
): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw adapterError(code, `${label} must be a positive safe integer`);
  }
  return value as number;
}

function requireNonNegativeSafeInteger(
  value: unknown,
  label: string,
  code: PosixControlPlaneStoreErrorCode,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw adapterError(code, `${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw adapterError(
      'store-limit-exceeded',
      `Control-plane ${label} overflowed`,
    );
  }
  return result;
}

function readDataProperty<Key extends keyof PosixControlPlaneStoreOptions>(
  value: PosixControlPlaneStoreOptions,
  key: Key,
): PosixControlPlaneStoreOptions[Key] {
  if (value === null || typeof value !== 'object') {
    throw adapterError(
      'mutation-invalid',
      'POSIX control-plane options must be a data record',
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor)) {
    throw adapterError(
      'mutation-invalid',
      `POSIX control-plane option ${String(key)} must be a data property`,
    );
  }
  return descriptor.value as PosixControlPlaneStoreOptions[Key];
}

function readOptionalDataProperty<
  Key extends keyof PosixControlPlaneStoreOptions,
>(
  value: PosixControlPlaneStoreOptions,
  key: Key,
): PosixControlPlaneStoreOptions[Key] | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) {
    throw adapterError(
      'mutation-invalid',
      `POSIX control-plane option ${String(key)} must be a data property`,
    );
  }
  return descriptor.value as PosixControlPlaneStoreOptions[Key];
}

function readOptionalFunctionProperty(
  value: PosixControlPlaneStoreOptions,
  key: 'faultInjector',
): PosixControlPlaneStoreOptions['faultInjector'] | undefined {
  const candidate = readOptionalDataProperty(value, key);
  if (candidate !== undefined && typeof candidate !== 'function') {
    throw adapterError(
      'mutation-invalid',
      'POSIX control-plane faultInjector must be a function',
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
  code: PosixControlPlaneStoreErrorCode,
  message: string,
  cause?: unknown,
): PosixControlPlaneStoreError {
  return new PosixControlPlaneStoreError(code, message, cause);
}

function wrapFilesystemError(
  error: unknown,
  message: string,
): PosixControlPlaneStoreError {
  if (error instanceof PosixControlPlaneStoreError) return error;
  return adapterError('filesystem-failure', message, error);
}
