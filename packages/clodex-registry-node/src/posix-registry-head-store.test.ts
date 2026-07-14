import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REGISTRY_HEAD_KIND,
  REGISTRY_HEAD_VERSION,
  type RegistryHeadKey,
  type RegistryHeadSnapshot,
} from '@clodex/registry';

import {
  POSIX_LOCAL_REGISTRY_HEAD_PROFILE,
  POSIX_REGISTRY_HEAD_LOCK_DIRECTORYNAME,
  POSIX_REGISTRY_HEAD_SNAPSHOT_FILENAME,
  POSIX_REGISTRY_HEAD_STAGING_FILENAME,
  PosixRegistryHeadSnapshotStore,
  PosixRegistryHeadStoreError,
} from './index.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const roots: string[] = [];
const describePosix = describe.skipIf(process.platform === 'win32');

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function baseDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'clodex-registry-head-'));
  roots.push(root);
  return join(root, 'store');
}

function headFixture(
  overrides: Partial<RegistryHeadSnapshot> = {},
): RegistryHeadSnapshot {
  return {
    kind: REGISTRY_HEAD_KIND,
    version: REGISTRY_HEAD_VERSION,
    registryType: 'adapter',
    workspaceId: 'workspace:repo',
    taskId: 'task:one',
    rootObjectId: 'root:workspace',
    policyDigest: HASH_A,
    configurationDigest: HASH_B,
    buildDigest: HASH_C,
    epoch: 1,
    manifestHash: HASH_D,
    previousManifestHash: null,
    ...overrides,
  };
}

function headKeyFixture(
  overrides: Partial<RegistryHeadKey> = {},
): RegistryHeadKey {
  return {
    registryType: 'adapter',
    workspaceId: 'workspace:repo',
    taskId: 'task:one',
    rootObjectId: 'root:workspace',
    ...overrides,
  };
}

it.runIf(process.platform === 'win32')(
  'fails closed with platform-unsupported on Windows',
  () => {
    let failure: unknown;
    try {
      new PosixRegistryHeadSnapshotStore({
        baseDirectory: join(tmpdir(), 'clodex-registry-head-platform-probe'),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'PosixRegistryHeadStoreError',
      code: 'platform-unsupported',
    });
  },
);

describePosix('POSIX registry head snapshot store', () => {
  it('persists genesis with private modes and reopens the exact head', () => {
    const directory = baseDirectory();
    const store = new PosixRegistryHeadSnapshotStore({
      baseDirectory: directory,
    });
    const head = headFixture();
    const key = headKeyFixture();
    expect(
      store.compareAndSwap({
        key,
        expected: null,
        next: head,
      }),
    ).toBe('APPLIED');
    expect(store.readCurrent(key)).toEqual(head);
    expect(store.profile).toBe(POSIX_LOCAL_REGISTRY_HEAD_PROFILE);
    expect(store.profile.independentlyProtected).toBe(false);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(
      statSync(join(directory, POSIX_REGISTRY_HEAD_SNAPSHOT_FILENAME)).mode &
        0o777,
    ).toBe(0o600);

    const reopened = new PosixRegistryHeadSnapshotStore({
      baseDirectory: directory,
    });
    expect(reopened.readCurrent(key)).toEqual(head);
    reopened.assertCurrent(head);
  });

  it('enforces CAS and accepts only the exact next hash-linked epoch', () => {
    const store = new PosixRegistryHeadSnapshotStore({
      baseDirectory: baseDirectory(),
    });
    const genesis = headFixture();
    const key = headKeyFixture();
    expect(store.compareAndSwap({ key, expected: null, next: genesis })).toBe(
      'APPLIED',
    );
    expect(store.compareAndSwap({ key, expected: null, next: genesis })).toBe(
      'CONFLICT',
    );

    const successor = headFixture({
      epoch: 2,
      manifestHash: HASH_A,
      previousManifestHash: genesis.manifestHash,
    });
    expect(
      store.compareAndSwap({
        key,
        expected: genesis,
        next: successor,
      }),
    ).toBe('APPLIED');
    expect(store.readCurrent(key)).toEqual(successor);

    expect(() =>
      store.compareAndSwap({
        key,
        expected: successor,
        next: headFixture({
          epoch: 4,
          manifestHash: HASH_B,
          previousManifestHash: successor.manifestHash,
        }),
      }),
    ).toThrow(/exact next hash-linked epoch/);
  });

  it('fails closed on a surviving lock or orphan staging file', () => {
    const directory = baseDirectory();
    const store = new PosixRegistryHeadSnapshotStore({
      baseDirectory: directory,
    });
    mkdirSync(join(directory, POSIX_REGISTRY_HEAD_LOCK_DIRECTORYNAME), {
      mode: 0o700,
    });
    expect(() => store.readAll()).toThrow(/never broken automatically/);
    rmSync(join(directory, POSIX_REGISTRY_HEAD_LOCK_DIRECTORYNAME), {
      recursive: true,
    });
    writeFileSync(
      join(directory, POSIX_REGISTRY_HEAD_STAGING_FILENAME),
      'orphan',
      { mode: 0o600 },
    );
    expect(() => store.readAll()).toThrow(/operator reconciliation/);
  });

  it('rejects noncanonical/corrupt, permissive, and symlink snapshots', () => {
    const directory = baseDirectory();
    const store = new PosixRegistryHeadSnapshotStore({
      baseDirectory: directory,
    });
    const head = headFixture();
    const key = headKeyFixture();
    expect(store.compareAndSwap({ key, expected: null, next: head })).toBe(
      'APPLIED',
    );
    const snapshot = join(directory, POSIX_REGISTRY_HEAD_SNAPSHOT_FILENAME);
    writeFileSync(snapshot, '{ "not": "canonical" }', { mode: 0o600 });
    expect(() => store.readAll()).toThrow(PosixRegistryHeadStoreError);

    writeFileSync(snapshot, '{}');
    chmodSync(snapshot, 0o644);
    expect(() => store.readAll()).toThrow(/mode 0600/);

    rmSync(snapshot);
    const target = join(directory, 'attacker-controlled.json');
    writeFileSync(target, '{}', { mode: 0o600 });
    symlinkSync(target, snapshot);
    expect(() => store.readAll()).toThrow(/non-symlink/);
  });

  it('documents that complete valid snapshot replacement remains undetectable', () => {
    const directory = baseDirectory();
    const store = new PosixRegistryHeadSnapshotStore({
      baseDirectory: directory,
    });
    const genesis = headFixture();
    const key = headKeyFixture();
    store.compareAndSwap({ key, expected: null, next: genesis });
    const snapshot = join(directory, POSIX_REGISTRY_HEAD_SNAPSHOT_FILENAME);
    const backup = join(directory, 'valid-old-backup.json');
    copyFileSync(snapshot, backup);
    chmodSync(backup, 0o600);

    const successor = headFixture({
      epoch: 2,
      manifestHash: HASH_A,
      previousManifestHash: genesis.manifestHash,
    });
    store.compareAndSwap({
      key,
      expected: genesis,
      next: successor,
    });
    copyFileSync(backup, snapshot);
    chmodSync(snapshot, 0o600);

    // This is the explicit non-claim: without an independent protected anchor,
    // a complete older canonical snapshot cannot be distinguished from current.
    expect(store.readCurrent(key)).toEqual(genesis);
    expect(store.profile.antiRollbackAgainstSnapshotReplacement).toBe(false);
  });

  it('rejects relative paths, option accessors, and a replaced base directory', () => {
    expect(
      () =>
        new PosixRegistryHeadSnapshotStore({
          baseDirectory: 'relative/path',
        }),
    ).toThrow(/normalized absolute path/);

    let reads = 0;
    const accessor = {} as { baseDirectory: string };
    Object.defineProperty(accessor, 'baseDirectory', {
      enumerable: true,
      get: () => {
        reads += 1;
        return baseDirectory();
      },
    });
    expect(() => new PosixRegistryHeadSnapshotStore(accessor)).toThrow(
      /own data field/,
    );
    expect(reads).toBe(0);

    const directory = baseDirectory();
    const store = new PosixRegistryHeadSnapshotStore({
      baseDirectory: directory,
    });
    // Keep the original inode live so the replacement cannot reuse it.
    renameSync(directory, `${directory}.displaced`);
    mkdirSync(directory, { mode: 0o700 });
    expect(() => store.readAll()).toThrow(/identity changed/);
  });

  it('stores strict canonical JSON rather than a platform-dependent encoding', () => {
    const directory = baseDirectory();
    const store = new PosixRegistryHeadSnapshotStore({
      baseDirectory: directory,
    });
    const head = headFixture();
    store.compareAndSwap({
      key: headKeyFixture(),
      expected: null,
      next: head,
    });
    const text = readFileSync(
      join(directory, POSIX_REGISTRY_HEAD_SNAPSHOT_FILENAME),
      'utf8',
    );
    expect(text.startsWith('{"heads"')).toBe(true);
    expect(text.includes('\n')).toBe(false);
  });
});
