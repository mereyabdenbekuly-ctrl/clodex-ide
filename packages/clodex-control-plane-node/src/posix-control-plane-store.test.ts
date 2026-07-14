import { spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeJson, parseCanonicalJson } from '@clodex/contracts';
import {
  TRUSTED_COMMIT_PERMIT_KIND,
  TRUSTED_COMMIT_PERMIT_VERSION,
  consumeCommitPermit,
  createPreparedControlPlaneRecord,
  markControlPlaneEffectInFlight,
  type ControlPlaneStorageMutation,
  type ControlPlaneTransactionRecord,
} from '@clodex/control-plane';
import { afterEach, describe, expect, it } from 'vitest';
import {
  POSIX_CONTROL_PLANE_LOCK_DIRECTORYNAME,
  POSIX_CONTROL_PLANE_SNAPSHOT_FILENAME,
  POSIX_CONTROL_PLANE_STAGING_FILENAME,
  POSIX_LOCAL_CONTROL_PLANE_DURABILITY,
  POSIX_LOCAL_CONTROL_PLANE_PROFILE,
  PosixControlPlaneStore,
  type PosixControlPlaneStoreError,
  type PosixControlPlaneFaultPoint,
} from './posix-control-plane-store.js';

const T0 = '2026-07-14T00:00:00.000Z';
const T1 = '2026-07-14T00:00:01.000Z';
const T2 = '2026-07-14T00:00:02.000Z';
const temporaryRoots: string[] = [];
const describePosix = describe.skipIf(process.platform === 'win32');

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

function preparedFixture(suffix = '1'): ControlPlaneTransactionRecord {
  return createPreparedControlPlaneRecord({
    transactionId: `ticket-${suffix}`,
    ticketCommitment: `sha256:ticket-commitment-${suffix}`,
    authorityScopeHash: `sha256:authority-scope-${suffix}`,
    nonce: `nonce-${suffix}`,
    budgetReservationId: `budget-${suffix}`,
    attemptId: `attempt-${suffix}`,
    adapterId: 'adapter.filesystem-v1',
    adapterDigest: 'sha256:adapter-digest-v1',
    operationCommitment: `sha256:operation-${suffix}`,
    targetObjectId: `workspace-object-${suffix}`,
    preStateHash: `sha256:pre-state-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    ledgerEntryId: `ledger-entry-${suffix}`,
    evidenceIntentId: `evidence-intent-${suffix}`,
    attestationId: `attestation-${suffix}`,
    now: T0,
  });
}

function permittedFixture(
  prepared = preparedFixture(),
): ControlPlaneTransactionRecord {
  return consumeCommitPermit(
    prepared,
    {
      kind: TRUSTED_COMMIT_PERMIT_KIND,
      version: TRUSTED_COMMIT_PERMIT_VERSION,
      permitId: `permit-${prepared.transactionId}`,
      permitDigest: `sha256:permit-${prepared.transactionId}`,
      admissionReceiptHash: `sha256:admission-${prepared.transactionId}`,
      issuerId: 'guardian.production-v1',
      trustEpoch: 9,
      registryDigest: 'sha256:registry-v9',
      ticketId: prepared.ticket.ticketId,
      ticketCommitment: prepared.ticket.ticketCommitment,
      operationCommitment: prepared.effect.operationCommitment,
      issuedAt: T0,
      expiresAt: '2026-07-14T00:01:00.000Z',
      admittedAt: T1,
    },
    T1,
  );
}

function insertMutation(
  record = preparedFixture(),
): ControlPlaneStorageMutation {
  return {
    transactionId: record.transactionId,
    expectedRevision: null,
    nextRecord: record,
  };
}

function successorMutation(
  previous: ControlPlaneTransactionRecord,
  next: ControlPlaneTransactionRecord,
  preCommitFence?: () => void,
): ControlPlaneStorageMutation {
  return {
    transactionId: previous.transactionId,
    expectedRevision: previous.revision,
    nextRecord: next,
    ...(preCommitFence === undefined ? {} : { preCommitFence }),
  };
}

async function newBaseDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'clodex-control-plane-node-'));
  temporaryRoots.push(root);
  return join(root, 'control-plane');
}

function snapshotPath(baseDirectory: string): string {
  return join(baseDirectory, POSIX_CONTROL_PLANE_SNAPSHOT_FILENAME);
}

function stagingPath(baseDirectory: string): string {
  return join(baseDirectory, POSIX_CONTROL_PLANE_STAGING_FILENAME);
}

function lockPath(baseDirectory: string): string {
  return join(baseDirectory, POSIX_CONTROL_PLANE_LOCK_DIRECTORYNAME);
}

function modeBits(mode: number): number {
  return mode & 0o777;
}

async function expectStoreError(
  promise: Promise<unknown>,
  code: PosixControlPlaneStoreError['code'],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: 'PosixControlPlaneStoreError',
    code,
  });
}

it.runIf(process.platform === 'win32')(
  'fails closed with platform-unsupported on Windows',
  () => {
    let failure: unknown;
    try {
      new PosixControlPlaneStore({
        baseDirectory: join(tmpdir(), 'clodex-control-plane-platform-probe'),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'PosixControlPlaneStoreError',
      code: 'platform-unsupported',
    });
  },
);

describePosix('PosixControlPlaneStore', () => {
  it('persists one canonical private snapshot before APPLIED', async () => {
    const baseDirectory = await newBaseDirectory();
    const observed: PosixControlPlaneFaultPoint[] = [];
    const store = new PosixControlPlaneStore({
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
    expect(canonicalizeJson(parseCanonicalJson(text))).toBe(text);
    await expect(stat(stagingPath(baseDirectory))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(lockPath(baseDirectory))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('declares local durability while explicitly excluding external-effect atomicity', () => {
    expect(POSIX_LOCAL_CONTROL_PLANE_DURABILITY).toEqual({
      version: 1,
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
    });
    expect(POSIX_LOCAL_CONTROL_PLANE_PROFILE).toMatchObject({
      antiRollback: false,
      independentProtectedHead: false,
      externalEffectAtomicity: false,
      effectReplayOnRecovery: false,
      networkFilesystemDurabilityClaim: false,
    });
  });

  it('is restart-readable from a new adapter instance', async () => {
    const baseDirectory = await newBaseDirectory();
    const record = preparedFixture();
    await new PosixControlPlaneStore({ baseDirectory }).compareAndSwap(
      insertMutation(record),
    );

    const restarted = new PosixControlPlaneStore({ baseDirectory });

    await expect(restarted.read(record.transactionId)).resolves.toEqual(record);
    await expect(restarted.scan()).resolves.toEqual([record]);
  });

  it('invokes the final fence once after CAS checks and not on conflict', async () => {
    const baseDirectory = await newBaseDirectory();
    const store = new PosixControlPlaneStore({ baseDirectory });
    const prepared = preparedFixture();
    const permitted = permittedFixture(prepared);
    await store.compareAndSwap(insertMutation(prepared));
    let fenceCalls = 0;

    const applied = await store.compareAndSwap(
      successorMutation(prepared, permitted, () => {
        fenceCalls += 1;
      }),
    );
    const conflict = await store.compareAndSwap({
      ...successorMutation(prepared, permitted),
      preCommitFence: () => {
        fenceCalls += 100;
      },
    });

    expect(applied.outcome).toBe('APPLIED');
    expect(conflict).toEqual({
      outcome: 'REVISION_CONFLICT',
      actualRevision: 2,
    });
    expect(fenceCalls).toBe(1);
  });

  it('leaves the prior snapshot untouched when the final fence rejects', async () => {
    const baseDirectory = await newBaseDirectory();
    const store = new PosixControlPlaneStore({ baseDirectory });
    const prepared = preparedFixture();
    await store.compareAndSwap(insertMutation(prepared));

    await expect(
      store.compareAndSwap(
        successorMutation(prepared, permittedFixture(prepared), () => {
          throw new Error('authority revoked');
        }),
      ),
    ).rejects.toThrow('authority revoked');
    await expect(store.read(prepared.transactionId)).resolves.toEqual(prepared);
    await expect(stat(stagingPath(baseDirectory))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('serializes independent instances so only one CAS wins', async () => {
    const baseDirectory = await newBaseDirectory();
    const first = new PosixControlPlaneStore({ baseDirectory });
    const second = new PosixControlPlaneStore({ baseDirectory });
    const mutation = insertMutation();

    const [left, right] = await Promise.all([
      first.compareAndSwap(mutation),
      second.compareAndSwap(mutation),
    ]);

    expect([left.outcome, right.outcome].sort()).toEqual([
      'APPLIED',
      'REVISION_CONFLICT',
    ]);
  });

  it('reserves replay identities across different records', async () => {
    const baseDirectory = await newBaseDirectory();
    const store = new PosixControlPlaneStore({ baseDirectory });
    const first = preparedFixture('1');
    const secondBase = preparedFixture('2');
    const second = createPreparedControlPlaneRecord({
      transactionId: secondBase.transactionId,
      ticketCommitment: secondBase.ticket.ticketCommitment,
      authorityScopeHash: secondBase.ticket.authorityScopeHash,
      nonce: first.ticket.nonce,
      budgetReservationId: secondBase.ticket.budgetReservationId,
      attemptId: secondBase.effect.attemptId,
      adapterId: secondBase.effect.adapterId,
      adapterDigest: secondBase.effect.adapterDigest,
      operationCommitment: secondBase.effect.operationCommitment,
      targetObjectId: secondBase.effect.targetObjectId,
      preStateHash: secondBase.effect.preStateHash,
      idempotencyKey: secondBase.effect.idempotencyKey,
      ledgerEntryId: secondBase.ledger.entryId,
      evidenceIntentId: secondBase.evidenceOutbox.intentId,
      attestationId: secondBase.evidenceOutbox.attestationId,
      now: T0,
    });
    await store.compareAndSwap(insertMutation(first));

    await expect(store.compareAndSwap(insertMutation(second))).resolves.toEqual(
      {
        outcome: 'IDENTITY_CONFLICT',
        identityKey: `nonce:${first.ticket.nonce}`,
      },
    );
  });

  it('keeps the old snapshot and blocks mutation after a pre-rename crash', async () => {
    const baseDirectory = await newBaseDirectory();
    const prepared = preparedFixture();
    const injectedFailure = new Error('crash:after-temporary-file-fsync');
    let fault: PosixControlPlaneFaultPoint | null = null;
    const store = new PosixControlPlaneStore({
      baseDirectory,
      faultInjector(point) {
        if (point === fault) throw injectedFailure;
      },
    });
    await store.compareAndSwap(insertMutation(prepared));
    fault = 'after-temporary-file-fsync';

    let failure: unknown;
    try {
      await store.compareAndSwap(
        successorMutation(prepared, permittedFixture(prepared)),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'PosixControlPlaneStoreError',
      code: 'filesystem-failure',
      message: 'Failed to durably replace control-plane snapshot',
    });
    expect((failure as PosixControlPlaneStoreError).originalCause).toBe(
      injectedFailure,
    );
    const restarted = new PosixControlPlaneStore({ baseDirectory });
    await expect(restarted.read(prepared.transactionId)).resolves.toEqual(
      prepared,
    );
    await expectStoreError(
      restarted.compareAndSwap(
        successorMutation(prepared, permittedFixture(prepared)),
      ),
      'orphan-temporary-file',
    );
  });

  it.each([
    'after-atomic-rename',
    'after-directory-fsync',
  ] as const)('reconciles exact durable state after %s failure', async (point) => {
    const baseDirectory = await newBaseDirectory();
    let fault: PosixControlPlaneFaultPoint | null = null;
    const store = new PosixControlPlaneStore({
      baseDirectory,
      faultInjector(observed) {
        if (observed === fault) throw new Error(`crash:${observed}`);
      },
    });
    const prepared = preparedFixture();
    await store.compareAndSwap(insertMutation(prepared));
    const permitted = permittedFixture(prepared);
    fault = point;

    await expect(
      store.compareAndSwap(successorMutation(prepared, permitted)),
    ).resolves.toMatchObject({ outcome: 'APPLIED', record: permitted });
    await expect(
      new PosixControlPlaneStore({ baseDirectory }).read(
        prepared.transactionId,
      ),
    ).resolves.toEqual(permitted);
  });

  it('rejects a rollback-shaped revision/state snapshot', async () => {
    const baseDirectory = await newBaseDirectory();
    const store = new PosixControlPlaneStore({ baseDirectory });
    const prepared = preparedFixture();
    await store.compareAndSwap(insertMutation(prepared));
    const parsed = parseCanonicalJson(
      await readFile(snapshotPath(baseDirectory), 'utf8'),
    ) as unknown as {
      mutationCount: number;
      records: Array<Record<string, unknown>>;
    };
    parsed.mutationCount = 8;
    if (parsed.records[0] !== undefined) parsed.records[0].revision = 8;
    await writeFile(snapshotPath(baseDirectory), canonicalizeJson(parsed));
    await chmod(snapshotPath(baseDirectory), 0o600);

    await expectStoreError(
      new PosixControlPlaneStore({ baseDirectory }).scan(),
      'store-invalid',
    );
  });

  it('fails closed if the pinned base-directory inode is replaced', async () => {
    const baseDirectory = await newBaseDirectory();
    const displaced = `${baseDirectory}.displaced`;
    const store = new PosixControlPlaneStore({ baseDirectory });
    await store.compareAndSwap(insertMutation());
    await rename(baseDirectory, displaced);
    await mkdir(baseDirectory, { mode: 0o700 });

    await expectStoreError(store.scan(), 'base-directory-invalid');
  });

  it('never breaks a surviving lock as stale', async () => {
    const baseDirectory = await newBaseDirectory();
    const store = new PosixControlPlaneStore({
      baseDirectory,
      lockAcquisitionTimeoutMs: 0,
      lockRetryDelayMs: 1,
    });
    await store.scan();
    await mkdir(lockPath(baseDirectory), { mode: 0o700 });

    await expectStoreError(
      store.compareAndSwap(insertMutation()),
      'lock-unavailable',
    );
    await expect(stat(lockPath(baseDirectory))).resolves.toBeDefined();
  });

  it('serializes CAS across separate Node processes', async () => {
    const baseDirectory = await newBaseDirectory();
    const mutation = insertMutation();
    const [left, right] = await Promise.all([
      runWorker(baseDirectory, mutation, 30),
      runWorker(baseDirectory, mutation, 0),
    ]);

    expect(
      [
        (left as { outcome: string }).outcome,
        (right as { outcome: string }).outcome,
      ].sort(),
    ).toEqual(['APPLIED', 'REVISION_CONFLICT']);
  });

  it('accepts the exact in-flight revision and rejects revision laundering', async () => {
    const baseDirectory = await newBaseDirectory();
    const store = new PosixControlPlaneStore({ baseDirectory });
    const prepared = preparedFixture();
    const permitted = permittedFixture(prepared);
    const inFlight = markControlPlaneEffectInFlight(permitted, T2);
    await store.compareAndSwap(insertMutation(prepared));
    await store.compareAndSwap(successorMutation(prepared, permitted));

    await expect(
      store.compareAndSwap(successorMutation(permitted, inFlight)),
    ).resolves.toMatchObject({ outcome: 'APPLIED', record: inFlight });
  });
});

async function runWorker(
  baseDirectory: string,
  mutation: ControlPlaneStorageMutation,
  holdAfterLockMs: number,
): Promise<unknown> {
  if (process.platform === 'win32') {
    throw new Error('The POSIX CAS worker must not run on Windows');
  }
  const executable = fileURLToPath(
    new URL('../../../node_modules/.bin/tsx', import.meta.url),
  );
  const worker = fileURLToPath(
    new URL('./test-support/cas-worker.ts', import.meta.url),
  );
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [worker], {
      env: {
        ...process.env,
        CLODEX_CONTROL_PLANE_NODE_WORKER_INPUT: canonicalizeJson({
          baseDirectory,
          mutation,
          holdAfterLockMs,
        }),
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
      resolve(JSON.parse(stdout) as unknown);
    });
  });
}
