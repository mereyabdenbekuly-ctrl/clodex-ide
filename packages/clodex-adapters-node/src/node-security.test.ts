import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const platformMocks = vi.hoisted(() => ({
  open: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: platformMocks.open };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: platformMocks.spawn };
});

import {
  NodeAdapterSecurityError,
  assertPinnedDirectoryLease,
  openPinnedDirectory,
  runPinnedExecutable,
  type PinnedDirectoryLease,
  type PinnedExecutableDescriptor,
} from './node-security.js';

const HELPER_BYTES = Buffer.concat([
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from('synthetic-clodex-helper', 'utf8'),
]);
const HELPER_SHA256 = createHash('sha256').update(HELPER_BYTES).digest('hex');
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

interface SyntheticMetadataOptions {
  readonly device?: bigint;
  readonly inode?: bigint;
  readonly mode?: bigint;
  readonly nlink?: bigint;
  readonly uid?: bigint;
  readonly size?: bigint;
  readonly mtimeMs?: bigint;
  readonly ctimeMs?: bigint;
  readonly file?: boolean;
  readonly directory?: boolean;
}

function metadata(options: SyntheticMetadataOptions = {}) {
  return {
    dev: options.device ?? 7n,
    ino: options.inode ?? 12n,
    mode: options.mode ?? 0o100555n,
    nlink: options.nlink ?? 1n,
    uid: options.uid ?? 0n,
    size: options.size ?? BigInt(HELPER_BYTES.byteLength),
    mtimeMs: options.mtimeMs ?? 1_000n,
    ctimeMs: options.ctimeMs ?? 1_001n,
    isFile: () => options.file ?? true,
    isDirectory: () => options.directory ?? false,
  };
}

function regularFileHandle(
  options: {
    readonly fd?: number;
    readonly bytes?: Buffer;
    readonly stats?: readonly ReturnType<typeof metadata>[];
  } = {},
) {
  const bytes = options.bytes ?? HELPER_BYTES;
  const stats = options.stats ?? [metadata({ size: BigInt(bytes.byteLength) })];
  let statIndex = 0;
  const stat = vi.fn(async () => {
    const value = stats[Math.min(statIndex, stats.length - 1)];
    statIndex += 1;
    return value;
  });
  const read = vi.fn(
    async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      const available = Math.max(0, bytes.byteLength - position);
      const bytesRead = Math.min(length, available);
      if (bytesRead > 0) {
        bytes.copy(buffer, offset, position, position + bytesRead);
      }
      return { bytesRead, buffer };
    },
  );
  const close = vi.fn(async () => undefined);
  return {
    handle: {
      fd: options.fd ?? 73,
      stat,
      read,
      close,
    } as unknown as FileHandle,
    stat,
    read,
    close,
  };
}

function directoryHandle(
  options: { readonly device?: bigint; readonly inode?: bigint } = {},
) {
  const stat = vi.fn(async () =>
    metadata({
      device: options.device ?? 7n,
      inode: options.inode ?? 11n,
      mode: 0o40555n,
      size: 0n,
      file: false,
      directory: true,
    }),
  );
  const close = vi.fn(async () => undefined);
  return {
    handle: { fd: 41, stat, close } as unknown as FileHandle,
    stat,
    close,
  };
}

function successfulChild(stdoutBytes = 'helper stdout', stderrBytes = '') {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  const stdin = new EventEmitter() as EventEmitter & {
    end: ReturnType<typeof vi.fn>;
  };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  child.pid = 6543;
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  stdin.end = vi.fn(() => {
    if (stdoutBytes !== '') stdout.emit('data', Buffer.from(stdoutBytes));
    if (stderrBytes !== '') stderr.emit('data', Buffer.from(stderrBytes));
    queueMicrotask(() => child.emit('close', 0, null));
  });
  return { child, stdin, stdout, stderr };
}

function processInput(
  overrides: {
    readonly executable?: PinnedExecutableDescriptor;
    readonly args?: string[];
    readonly environment?: Record<string, string>;
    readonly extraFileDescriptors?: number[];
  } = {},
) {
  return {
    executable: overrides.executable ?? {
      path: '/trusted/clodex-openat2-helper',
      sha256: HELPER_SHA256,
      device: '7',
      inode: '12',
    },
    args: overrides.args ?? ['--protocol-v1', 'inspect-create'],
    stdin: Uint8Array.from([1, 2, 3, 4]),
    environment: overrides.environment ?? { LANG: 'C', LC_ALL: 'C' },
    extraFileDescriptors: overrides.extraFileDescriptors ?? [41],
    timeoutMs: 1_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 4_096,
    stage: 'prepare' as const,
    effectMayHaveOccurredOnFailure: false,
  };
}

beforeAll(() => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: 'linux',
  });
});

afterAll(() => {
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe('pinned executable launcher boundary', () => {
  it('hashes and revalidates one descriptor, then executes that fd with a fixed process topology', async () => {
    const file = regularFileHandle();
    const launched = successfulChild('bounded stdout', 'bounded stderr');
    platformMocks.open.mockResolvedValue(file.handle);
    platformMocks.spawn.mockReturnValue(launched.child);

    const inheritedEnvironmentGetter = vi.fn(() => 'must-not-leak');
    const environmentPrototype = Object.create(null) as Record<string, string>;
    Object.defineProperty(environmentPrototype, 'INHERITED_SECRET', {
      enumerable: true,
      get: inheritedEnvironmentGetter,
    });
    const environment = Object.assign(Object.create(environmentPrototype), {
      LANG: 'C',
      LC_ALL: 'C',
    }) as Record<string, string>;
    const args = ['--protocol-v1', 'inspect-create'];
    const extraFileDescriptors = [41];
    const invocation = runPinnedExecutable(
      processInput({ args, environment, extraFileDescriptors }),
    );

    args[0] = '--mutated-after-dispatch';
    environment.LANG = 'mutated';
    extraFileDescriptors[0] = 99;
    const result = await invocation;

    expect(platformMocks.open).toHaveBeenCalledWith(
      '/trusted/clodex-openat2-helper',
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    expect(file.stat).toHaveBeenCalledTimes(2);
    expect(file.read).toHaveBeenCalledWith(expect.any(Buffer), 0, 4, 0);
    expect(platformMocks.spawn).toHaveBeenCalledOnce();
    const [command, capturedArgs, options] = platformMocks.spawn.mock
      .calls[0] as [
      string,
      readonly string[],
      {
        readonly cwd: string;
        readonly detached: boolean;
        readonly env: Readonly<Record<string, string>>;
        readonly shell: boolean;
        readonly stdio: readonly ('pipe' | number)[];
        readonly windowsHide: boolean;
      },
    ];
    expect(command).toBe('/proc/self/fd/3');
    expect(capturedArgs).toEqual(['--protocol-v1', 'inspect-create']);
    expect(options).toMatchObject({
      cwd: '/',
      detached: true,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', 73, 41],
    });
    expect(options.env).toEqual({ LANG: 'C', LC_ALL: 'C' });
    expect(Object.getPrototypeOf(options.env)).toBeNull();
    expect(inheritedEnvironmentGetter).not.toHaveBeenCalled();
    expect(launched.stdin.end).toHaveBeenCalledWith(Buffer.from([1, 2, 3, 4]));
    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stdout: Uint8Array.from(Buffer.from('bounded stdout')),
      stderr: Uint8Array.from(Buffer.from('bounded stderr')),
    });
    expect(file.close).toHaveBeenCalledOnce();
  });

  it('rejects a device/inode mismatch before digesting or spawning and closes the fd', async () => {
    const file = regularFileHandle();
    platformMocks.open.mockResolvedValue(file.handle);

    await expect(
      runPinnedExecutable(
        processInput({
          executable: {
            path: '/trusted/clodex-openat2-helper',
            sha256: HELPER_SHA256,
            device: '8',
            inode: '12',
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: 'NodeAdapterSecurityError',
      code: 'executable-integrity-mismatch',
      stage: 'prepare',
      effectMayHaveOccurred: false,
    });
    expect(file.read).not.toHaveBeenCalled();
    expect(platformMocks.spawn).not.toHaveBeenCalled();
    expect(file.close).toHaveBeenCalledOnce();
  });

  it('rejects identity drift across hashing before spawning', async () => {
    const before = metadata();
    const after = metadata({ ctimeMs: 2_000n });
    const file = regularFileHandle({ stats: [before, after] });
    platformMocks.open.mockResolvedValue(file.handle);

    await expect(runPinnedExecutable(processInput())).rejects.toMatchObject({
      name: 'NodeAdapterSecurityError',
      code: 'executable-integrity-mismatch',
      stage: 'prepare',
    });
    expect(file.read).toHaveBeenCalled();
    expect(platformMocks.spawn).not.toHaveBeenCalled();
    expect(file.close).toHaveBeenCalledOnce();
  });

  it.each([
    'own accessor',
    'prototype accessor',
  ])('rejects an executable path supplied by an %s without invoking it', async (placement) => {
    const pathGetter = vi.fn(() => '/trusted/clodex-openat2-helper');
    const prototype = Object.create(null) as Record<string, unknown>;
    const descriptor = Object.create(
      placement === 'prototype accessor' ? prototype : null,
    ) as Record<string, unknown>;
    const accessorOwner =
      placement === 'prototype accessor' ? prototype : descriptor;
    Object.defineProperty(accessorOwner, 'path', {
      enumerable: true,
      get: pathGetter,
    });
    Object.assign(descriptor, {
      sha256: HELPER_SHA256,
      device: '7',
      inode: '12',
    });

    await expect(
      runPinnedExecutable(
        processInput({
          executable: descriptor as unknown as PinnedExecutableDescriptor,
        }),
      ),
    ).rejects.toBeInstanceOf(NodeAdapterSecurityError);
    expect(pathGetter).not.toHaveBeenCalled();
    expect(platformMocks.open).not.toHaveBeenCalled();
    expect(platformMocks.spawn).not.toHaveBeenCalled();
  });
});

describe('pinned workspace root identity boundary', () => {
  it('opens a no-follow directory fd and returns only the provisioned identity', async () => {
    const directory = directoryHandle();
    platformMocks.open.mockResolvedValue(directory.handle);

    const lease = await openPinnedDirectory({
      path: '/trusted/workspace',
      device: '7',
      inode: '11',
    });

    expect(platformMocks.open).toHaveBeenCalledWith(
      '/trusted/workspace',
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    expect(lease).toEqual({
      handle: directory.handle,
      path: '/trusted/workspace',
      device: '7',
      inode: '11',
    });
    expect(Object.isFrozen(lease)).toBe(true);
    expect(directory.close).not.toHaveBeenCalled();
  });

  it('closes and rejects a root whose opened identity differs from provisioning', async () => {
    const directory = directoryHandle({ inode: 99n });
    platformMocks.open.mockResolvedValue(directory.handle);

    await expect(
      openPinnedDirectory({
        path: '/trusted/workspace',
        device: '7',
        inode: '11',
      }),
    ).rejects.toMatchObject({
      name: 'NodeAdapterSecurityError',
      code: 'root-identity-mismatch',
      stage: 'prepare',
      effectMayHaveOccurred: false,
    });
    expect(directory.close).toHaveBeenCalledOnce();
  });

  it('marks a held-root revalidation failure during execute as potentially effected', async () => {
    const directory = directoryHandle({ inode: 99n });
    const lease = Object.freeze({
      handle: directory.handle,
      path: '/trusted/workspace',
      device: '7',
      inode: '11',
    }) as PinnedDirectoryLease;

    await expect(
      assertPinnedDirectoryLease(lease, 'execute'),
    ).rejects.toMatchObject({
      name: 'NodeAdapterSecurityError',
      code: 'root-identity-mismatch',
      stage: 'execute',
      effectMayHaveOccurred: true,
    });
  });

  it('rejects an accessor root field without invoking it or opening a path', async () => {
    const pathGetter = vi.fn(() => '/trusted/workspace');
    const descriptor = {
      device: '7',
      inode: '11',
    } as Record<string, unknown>;
    Object.defineProperty(descriptor, 'path', {
      enumerable: true,
      get: pathGetter,
    });

    await expect(
      openPinnedDirectory(
        descriptor as unknown as Parameters<typeof openPinnedDirectory>[0],
      ),
    ).rejects.toBeInstanceOf(NodeAdapterSecurityError);
    expect(pathGetter).not.toHaveBeenCalled();
    expect(platformMocks.open).not.toHaveBeenCalled();
  });
});
