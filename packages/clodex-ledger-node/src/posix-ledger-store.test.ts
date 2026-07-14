import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalizeJson,
  encodeBase64Url,
  parseCanonicalJson,
  type SafeCodingExecutionTicket,
} from '@clodex/contracts';
import {
  createPreparedSafeCodingLedgerRecord,
  recordSafeCodingCommitPermit,
  type SafeCodingLedgerPersistenceMutation,
  type SafeCodingLedgerRecord,
} from '@clodex/ledger';
import { afterEach, describe, expect, it } from 'vitest';
import {
  POSIX_LEDGER_LOCK_DIRECTORYNAME,
  POSIX_LEDGER_MAX_RECORDS,
  POSIX_LEDGER_MAX_SNAPSHOT_BYTES,
  POSIX_LEDGER_SNAPSHOT_FILENAME,
  POSIX_LEDGER_STAGING_FILENAME,
  POSIX_LOCAL_SAFE_CODING_LEDGER_DURABILITY,
  POSIX_LOCAL_SAFE_CODING_LEDGER_PROFILE,
  PosixSafeCodingLedgerStore,
  PosixSafeCodingLedgerStoreError,
  type PosixSafeCodingLedgerFaultPoint,
} from './posix-ledger-store.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const PREPARED_AT = '2026-07-14T00:01:00Z';
const PERMITTED_AT = '2026-07-14T00:02:00Z';

const temporaryRoots: string[] = [];
const describePosix = describe.skipIf(process.platform === 'win32');

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function ticketFixture(
  index = 1,
  overrides: Partial<SafeCodingExecutionTicket> = {},
): SafeCodingExecutionTicket {
  return {
    kind: 'clodex.execution-ticket',
    specVersion: '1.0.0',
    ticketId: uuid(index),
    requestId: `request:${index}`,
    contractHash: HASH_A,
    contractRevision: 1,
    subject: { principalId: 'agent:one', instanceId: 'runtime:one' },
    audience: {
      guardianId: 'guardian:local',
      executorId: 'executor:sandbox',
      runtimeEpoch: 1,
      taskId: 'task:one',
      workspaceId: 'workspace:one',
    },
    actionHash: HASH_B,
    argumentsHash: HASH_C,
    resolvedObjectId: `object:${index}`,
    stateCommitmentHash: HASH_D,
    adapterId: 'adapter:safe-file',
    adapterDigest: HASH_E,
    policyDigest: HASH_A,
    registryDigest: HASH_B,
    runnerRegistryDigest: HASH_C,
    effectRegistryDigest: HASH_D,
    effectClass: 'local.reversible',
    revocationEpoch: 0,
    budgetReservationId: `reservation:${index}`,
    nonce: nonceFixture(index),
    issuedAt: '2026-07-14T00:00:00Z',
    expiresAt: '2026-07-14T00:10:00Z',
    ...overrides,
  };
}

function nonceFixture(index: number): string {
  const bytes = new Uint8Array(16);
  bytes[12] = (index >>> 24) & 0xff;
  bytes[13] = (index >>> 16) & 0xff;
  bytes[14] = (index >>> 8) & 0xff;
  bytes[15] = index & 0xff;
  return encodeBase64Url(bytes);
}

function preparedFixture(
  index = 1,
  ticket = ticketFixture(index),
): SafeCodingLedgerRecord {
  return createPreparedSafeCodingLedgerRecord({
    ticket,
    attemptId: `attempt:${index}`,
    evidenceIntentId: `evidence:${index}`,
    attestationId: uuid(10_000 + index),
    evidenceExpectation: {
      delegationLineageHash: HASH_A,
      runnerId: 'runner:recording',
      runnerDigest: HASH_D,
      observerId: 'observer:recording',
      preStateHash: HASH_B,
      completionPostStateHash: HASH_C,
      idempotencyKey: null,
      completionBudgetCharges: {
        uniqueModifiedFiles: 1,
        mutationBytes: 8,
        testRuns: 0,
      },
      completionEvidenceLevel: 'adapter_observed',
      completionReconciliationRef: null,
    },
    now: PREPARED_AT,
  });
}

function insertMutation(
  record = preparedFixture(),
): SafeCodingLedgerPersistenceMutation {
  return {
    transactionId: record.transactionId,
    expectedRevision: null,
    nextRecord: record,
  };
}

function permitFixture(ticket = ticketFixture()) {
  return {
    ticketId: ticket.ticketId,
    requestId: ticket.requestId,
    contractHash: ticket.contractHash,
    contractRevision: ticket.contractRevision,
    revocationEpoch: ticket.revocationEpoch,
    budgetReservationId: ticket.budgetReservationId,
    permittedAt: PERMITTED_AT,
  };
}

async function newBaseDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'clodex-ledger-node-'));
  temporaryRoots.push(root);
  return join(root, 'ledger');
}

function snapshotPath(baseDirectory: string): string {
  return join(baseDirectory, POSIX_LEDGER_SNAPSHOT_FILENAME);
}

function stagingPath(baseDirectory: string): string {
  return join(baseDirectory, POSIX_LEDGER_STAGING_FILENAME);
}

function lockPath(baseDirectory: string): string {
  return join(baseDirectory, POSIX_LEDGER_LOCK_DIRECTORYNAME);
}

function modeBits(mode: number): number {
  return mode & 0o777;
}

async function readSnapshotObject(
  baseDirectory: string,
): Promise<Record<string, unknown>> {
  const text = await readFile(snapshotPath(baseDirectory), 'utf8');
  return parseCanonicalJson(text) as Record<string, unknown>;
}

async function writeCanonicalSnapshot(
  baseDirectory: string,
  value: unknown,
): Promise<void> {
  await writeFile(snapshotPath(baseDirectory), canonicalizeJson(value), {
    mode: 0o600,
  });
  await chmod(snapshotPath(baseDirectory), 0o600);
}

async function expectStoreError(
  promise: Promise<unknown>,
  code: PosixSafeCodingLedgerStoreError['code'],
): Promise<PosixSafeCodingLedgerStoreError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PosixSafeCodingLedgerStoreError);
    expect((error as PosixSafeCodingLedgerStoreError).code).toBe(code);
    return error as PosixSafeCodingLedgerStoreError;
  }
  throw new Error(`Expected POSIX ledger error ${code}`);
}

function runCasWorker(input: {
  readonly baseDirectory: string;
  readonly mutation: SafeCodingLedgerPersistenceMutation;
  readonly holdAfterLockMs: number;
}): Promise<unknown> {
  if (process.platform === 'win32') {
    throw new Error('The POSIX ledger CAS worker must not run on Windows');
  }
  const executable = fileURLToPath(
    new URL('../../../node_modules/.bin/tsx', import.meta.url),
  );
  const worker = fileURLToPath(
    new URL('./test-support/cas-worker.ts', import.meta.url),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [worker], {
      env: {
        ...process.env,
        CLODEX_LEDGER_NODE_WORKER_INPUT: canonicalizeJson(input),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`CAS worker exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as unknown);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (
        error === null ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

it.runIf(process.platform === 'win32')(
  'fails closed with platform-unsupported on Windows',
  () => {
    let failure: unknown;
    try {
      new PosixSafeCodingLedgerStore({
        baseDirectory: join(tmpdir(), 'clodex-ledger-platform-probe'),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'PosixSafeCodingLedgerStoreError',
      code: 'platform-unsupported',
    });
  },
);

describePosix('PosixSafeCodingLedgerStore', () => {
  it('persists one closed canonical snapshot with private POSIX modes before APPLIED', async () => {
    const baseDirectory = await newBaseDirectory();
    const observed: PosixSafeCodingLedgerFaultPoint[] = [];
    const store = new PosixSafeCodingLedgerStore({
      baseDirectory,
      faultInjector(point) {
        observed.push(point);
      },
    });

    const result = await store.compareAndSwap(insertMutation());

    expect(result.outcome).toBe('APPLIED');
    expect(observed).toEqual([
      'after-lock-acquired',
      'after-temporary-file-open',
      'after-temporary-file-write',
      'after-temporary-file-fsync',
      'after-atomic-rename',
      'after-directory-fsync',
      'after-lock-directory-removed',
    ]);
    expect(modeBits((await stat(baseDirectory)).mode)).toBe(0o700);
    expect(modeBits((await stat(snapshotPath(baseDirectory))).mode)).toBe(
      0o600,
    );
    const text = await readFile(snapshotPath(baseDirectory), 'utf8');
    const snapshot = parseCanonicalJson(text) as Record<string, unknown>;
    expect(canonicalizeJson(snapshot)).toBe(text);
    expect(snapshot).toMatchObject({
      kind: 'clodex.posix-safe-coding-ledger-store',
      version: 1,
      mutationCount: 1,
    });
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.identityReservations).toHaveLength(7);
    await expect(stat(stagingPath(baseDirectory))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(lockPath(baseDirectory))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('declares only adapter-scoped POSIX local durability and no protected head', () => {
    expect(POSIX_LOCAL_SAFE_CODING_LEDGER_DURABILITY).toEqual({
      version: 1,
      mode: 'adapter-declared-durable',
      adapterId: 'clodex-ledger-node.posix-local-snapshot-v1',
      atomicScope: 'storage-transaction',
      atomicRecordAndOutbox: true,
      stableBeforeSuccess: true,
      restartReadable: true,
      multiProcessCas: true,
    });
    expect(POSIX_LOCAL_SAFE_CODING_LEDGER_PROFILE).toMatchObject({
      platformScope: 'posix-local-filesystem-only',
      encryptionAtRest: false,
      independentProtectedHead: false,
      antiRollback: false,
      networkFilesystemDurabilityClaim: false,
    });
  });

  it('is restart-readable from a completely new adapter instance', async () => {
    const baseDirectory = await newBaseDirectory();
    const record = preparedFixture();
    await new PosixSafeCodingLedgerStore({ baseDirectory }).compareAndSwap(
      insertMutation(record),
    );

    const restarted = new PosixSafeCodingLedgerStore({ baseDirectory });

    await expect(restarted.read(record.transactionId)).resolves.toEqual(record);
    await expect(restarted.scan()).resolves.toEqual([record]);
  });

  it('fails closed when the pinned base-directory inode is replaced', async () => {
    const baseDirectory = await newBaseDirectory();
    const displacedDirectory = `${baseDirectory}.displaced`;
    const store = new PosixSafeCodingLedgerStore({ baseDirectory });
    await store.compareAndSwap(insertMutation());

    await rename(baseDirectory, displacedDirectory);
    await mkdir(baseDirectory, { mode: 0o700 });

    await expectStoreError(store.scan(), 'base-directory-invalid');
    await expect(
      new PosixSafeCodingLedgerStore({ baseDirectory }).scan(),
    ).resolves.toEqual([]);
  });

  it('serializes concurrent independent instances and lets only one CAS win', async () => {
    const baseDirectory = await newBaseDirectory();
    let announceLock!: () => void;
    let releaseLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      announceLock = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const first = new PosixSafeCodingLedgerStore({
      baseDirectory,
      lockAcquisitionTimeoutMs: 2_000,
      lockRetryDelayMs: 2,
      async faultInjector(point) {
        if (point === 'after-lock-acquired') {
          announceLock();
          await release;
        }
      },
    });
    const second = new PosixSafeCodingLedgerStore({
      baseDirectory,
      lockAcquisitionTimeoutMs: 2_000,
      lockRetryDelayMs: 2,
    });
    const mutation = insertMutation();

    const firstResultPromise = first.compareAndSwap(mutation);
    await lockAcquired;
    let secondSettled = false;
    const secondResultPromise = second.compareAndSwap(mutation).finally(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondSettled).toBe(false);
    releaseLock();

    const [firstResult, secondResult] = await Promise.all([
      firstResultPromise,
      secondResultPromise,
    ]);
    expect(firstResult.outcome).toBe('APPLIED');
    expect(secondResult).toEqual({
      outcome: 'REVISION_CONFLICT',
      actualRevision: 1,
    });
    await expect(second.scan()).resolves.toHaveLength(1);
  });

  it('enforces the same CAS boundary across independent OS processes', async () => {
    const baseDirectory = await newBaseDirectory();
    const mutation = insertMutation();
    const first = runCasWorker({
      baseDirectory,
      mutation,
      holdAfterLockMs: 1_000,
    });
    try {
      await waitForPath(lockPath(baseDirectory));
    } catch (error) {
      await first.catch(() => undefined);
      throw error;
    }
    const second = runCasWorker({
      baseDirectory,
      mutation,
      holdAfterLockMs: 0,
    });

    const results = await Promise.all([first, second]);

    expect(results).toContainEqual({
      outcome: 'APPLIED',
      record: mutation.nextRecord,
    });
    expect(results).toContainEqual({
      outcome: 'REVISION_CONFLICT',
      actualRevision: 1,
    });
    await expect(
      new PosixSafeCodingLedgerStore({ baseDirectory }).scan(),
    ).resolves.toEqual([mutation.nextRecord]);
  }, 15_000);

  it('never breaks a surviving lock directory automatically', async () => {
    const baseDirectory = await newBaseDirectory();
    const store = new PosixSafeCodingLedgerStore({
      baseDirectory,
      lockAcquisitionTimeoutMs: 25,
      lockRetryDelayMs: 2,
    });
    await store.scan();
    await mkdir(lockPath(baseDirectory), { mode: 0o700 });

    await expectStoreError(
      store.compareAndSwap(insertMutation()),
      'lock-unavailable',
    );

    expect((await stat(lockPath(baseDirectory))).isDirectory()).toBe(true);
    await expect(stat(snapshotPath(baseDirectory))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('ignores an orphan staging file on reads and refuses to promote or overwrite it', async () => {
    const baseDirectory = await newBaseDirectory();
    const firstRecord = preparedFixture(1);
    const store = new PosixSafeCodingLedgerStore({ baseDirectory });
    await store.compareAndSwap(insertMutation(firstRecord));
    await writeFile(
      stagingPath(baseDirectory),
      canonicalizeJson({ attackerChosen: true }),
      { mode: 0o600 },
    );

    const restarted = new PosixSafeCodingLedgerStore({ baseDirectory });
    await expect(restarted.scan()).resolves.toEqual([firstRecord]);
    await expectStoreError(
      restarted.compareAndSwap(insertMutation(preparedFixture(2))),
      'orphan-temporary-file',
    );
    await expect(restarted.scan()).resolves.toEqual([firstRecord]);
    expect(await readFile(stagingPath(baseDirectory), 'utf8')).toBe(
      canonicalizeJson({ attackerChosen: true }),
    );
  });

  it('leaves a pre-rename fault as a non-promoted orphan and never reports APPLIED', async () => {
    const baseDirectory = await newBaseDirectory();
    const store = new PosixSafeCodingLedgerStore({
      baseDirectory,
      faultInjector(point) {
        if (point === 'after-temporary-file-fsync') {
          throw new Error('injected-before-rename');
        }
      },
    });

    await expectStoreError(
      store.compareAndSwap(insertMutation()),
      'filesystem-failure',
    );

    expect((await stat(stagingPath(baseDirectory))).isFile()).toBe(true);
    await expect(stat(snapshotPath(baseDirectory))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      new PosixSafeCodingLedgerStore({ baseDirectory }).scan(),
    ).resolves.toEqual([]);
    await expectStoreError(
      new PosixSafeCodingLedgerStore({ baseDirectory }).compareAndSwap(
        insertMutation(preparedFixture(2)),
      ),
      'orphan-temporary-file',
    );
  });

  it('reconciles an exact post-rename snapshot before returning APPLIED', async () => {
    const baseDirectory = await newBaseDirectory();
    const record = preparedFixture();
    const store = new PosixSafeCodingLedgerStore({
      baseDirectory,
      faultInjector(point) {
        if (point === 'after-atomic-rename') {
          throw new Error('injected-after-rename');
        }
      },
    });

    await expect(store.compareAndSwap(insertMutation(record))).resolves.toEqual(
      {
        outcome: 'APPLIED',
        record,
      },
    );

    const restarted = new PosixSafeCodingLedgerStore({ baseDirectory });
    await expect(restarted.read(record.transactionId)).resolves.toEqual(record);
    await expect(
      restarted.compareAndSwap(insertMutation(record)),
    ).resolves.toEqual({
      outcome: 'REVISION_CONFLICT',
      actualRevision: 1,
    });
  });

  it('reconciles an exact post-fsync snapshot without exposing retry authority', async () => {
    const baseDirectory = await newBaseDirectory();
    const record = preparedFixture();
    const store = new PosixSafeCodingLedgerStore({
      baseDirectory,
      faultInjector(point) {
        if (point === 'after-directory-fsync') {
          throw new Error('injected-after-directory-fsync');
        }
      },
    });

    await expect(store.compareAndSwap(insertMutation(record))).resolves.toEqual(
      {
        outcome: 'APPLIED',
        record,
      },
    );
    await expect(
      new PosixSafeCodingLedgerStore({ baseDirectory }).read(
        record.transactionId,
      ),
    ).resolves.toEqual(record);
  });

  it('returns APPLIED but mutation-blocks the instance when durable lock cleanup fails', async () => {
    const baseDirectory = await newBaseDirectory();
    const record = preparedFixture();
    const store = new PosixSafeCodingLedgerStore({
      baseDirectory,
      faultInjector(point) {
        if (point === 'after-lock-directory-removed') {
          throw new Error('injected-after-lock-directory-removed');
        }
      },
    });

    await expect(store.compareAndSwap(insertMutation(record))).resolves.toEqual(
      {
        outcome: 'APPLIED',
        record,
      },
    );
    await expect(store.read(record.transactionId)).resolves.toEqual(record);
    await expectStoreError(
      store.compareAndSwap(insertMutation(preparedFixture(2))),
      'filesystem-failure',
    );
  });

  it('fails closed on non-canonical JSON, invalid UTF-8, and insecure file mode', async () => {
    const nonCanonicalBase = await newBaseDirectory();
    const nonCanonicalStore = new PosixSafeCodingLedgerStore({
      baseDirectory: nonCanonicalBase,
    });
    await nonCanonicalStore.scan();
    await writeFile(snapshotPath(nonCanonicalBase), '{ "version": 1 }', {
      mode: 0o600,
    });
    await expectStoreError(nonCanonicalStore.scan(), 'store-invalid');

    const invalidUtf8Base = await newBaseDirectory();
    const invalidUtf8Store = new PosixSafeCodingLedgerStore({
      baseDirectory: invalidUtf8Base,
    });
    await invalidUtf8Store.scan();
    await writeFile(snapshotPath(invalidUtf8Base), Buffer.from([0xc0, 0xaf]), {
      mode: 0o600,
    });
    await expectStoreError(invalidUtf8Store.scan(), 'store-invalid');

    const modeBase = await newBaseDirectory();
    const modeStore = new PosixSafeCodingLedgerStore({
      baseDirectory: modeBase,
    });
    await modeStore.compareAndSwap(insertMutation());
    await chmod(snapshotPath(modeBase), 0o644);
    await expectStoreError(modeStore.scan(), 'store-invalid');
  });

  it('rejects corrupted identity reservations and mutation counts', async () => {
    const identityBase = await newBaseDirectory();
    const identityStore = new PosixSafeCodingLedgerStore({
      baseDirectory: identityBase,
    });
    await identityStore.compareAndSwap(insertMutation());
    const identitySnapshot = await readSnapshotObject(identityBase);
    (identitySnapshot.identityReservations as unknown[]).pop();
    await writeCanonicalSnapshot(identityBase, identitySnapshot);
    await expectStoreError(identityStore.scan(), 'store-invalid');

    const countBase = await newBaseDirectory();
    const countStore = new PosixSafeCodingLedgerStore({
      baseDirectory: countBase,
    });
    await countStore.compareAndSwap(insertMutation());
    const countSnapshot = await readSnapshotObject(countBase);
    countSnapshot.mutationCount = 0;
    await writeCanonicalSnapshot(countBase, countSnapshot);
    await expectStoreError(countStore.scan(), 'store-invalid');
  });

  it('rejects a rollback-shaped record revision even when the record is otherwise valid', async () => {
    const baseDirectory = await newBaseDirectory();
    const store = new PosixSafeCodingLedgerStore({ baseDirectory });
    const prepared = preparedFixture();
    await store.compareAndSwap(insertMutation(prepared));
    const permitted = recordSafeCodingCommitPermit(
      prepared,
      permitFixture(prepared.ticketState.ticket),
    );
    const rollbackShaped = JSON.parse(canonicalizeJson(permitted)) as Record<
      string,
      unknown
    >;
    rollbackShaped.revision = 1;
    const snapshot = await readSnapshotObject(baseDirectory);
    snapshot.records = [rollbackShaped];
    snapshot.mutationCount = 1;
    await writeCanonicalSnapshot(baseDirectory, snapshot);

    await expectStoreError(store.scan(), 'store-invalid');
  });

  it('enforces fixed byte and record-count bounds before accepting a store', async () => {
    const byteBase = await newBaseDirectory();
    const byteStore = new PosixSafeCodingLedgerStore({
      baseDirectory: byteBase,
    });
    await byteStore.scan();
    await writeFile(snapshotPath(byteBase), 'x', { mode: 0o600 });
    await truncate(snapshotPath(byteBase), POSIX_LEDGER_MAX_SNAPSHOT_BYTES + 1);
    await expectStoreError(byteStore.scan(), 'store-limit-exceeded');

    const countBase = await newBaseDirectory();
    const countStore = new PosixSafeCodingLedgerStore({
      baseDirectory: countBase,
    });
    await countStore.scan();
    await writeCanonicalSnapshot(countBase, {
      kind: 'clodex.posix-safe-coding-ledger-store',
      version: 1,
      mutationCount: 0,
      records: Array.from({ length: POSIX_LEDGER_MAX_RECORDS + 1 }, () => null),
      identityReservations: [],
    });
    await expectStoreError(countStore.scan(), 'store-limit-exceeded');
  });

  it('atomically rejects an identity already reserved by another transaction', async () => {
    const baseDirectory = await newBaseDirectory();
    const store = new PosixSafeCodingLedgerStore({ baseDirectory });
    const firstTicket = ticketFixture(1);
    const secondTicket = ticketFixture(2, {
      requestId: firstTicket.requestId,
    });
    await store.compareAndSwap(insertMutation(preparedFixture(1, firstTicket)));

    await expect(
      store.compareAndSwap(insertMutation(preparedFixture(2, secondTicket))),
    ).resolves.toEqual({
      outcome: 'IDENTITY_CONFLICT',
      identityKey: `request:${firstTicket.requestId}`,
    });
    await expect(store.scan()).resolves.toHaveLength(1);
  });
});
