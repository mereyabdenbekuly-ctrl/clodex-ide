import { createHash } from 'node:crypto';

import type {
  CapabilityScope,
  FilesystemCreateExecuteInput,
  FilesystemCreateInspectInput,
  FilesystemMkdirExecuteInput,
  FilesystemReplaceExecuteInput,
} from '@clodex/adapters';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PinnedDirectoryLease,
  PinnedProcessResult,
} from './node-security.js';

const securityMocks = vi.hoisted(() => ({
  assertPinnedDirectoryLease: vi.fn(),
  openPinnedDirectory: vi.fn(),
  runPinnedExecutable: vi.fn(),
}));

vi.mock('./node-security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./node-security.js')>();
  return {
    ...actual,
    assertPinnedDirectoryLease: securityMocks.assertPinnedDirectoryLease,
    openPinnedDirectory: securityMocks.openPinnedDirectory,
    runPinnedExecutable: securityMocks.runPinnedExecutable,
  };
});

import {
  LinuxOpenat2FilesystemCapability,
  NodeAdapterSecurityError,
} from './index.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const CAPABILITY_SCOPE: CapabilityScope = Object.freeze({
  workspaceId: 'workspace:test',
  taskId: 'task:test',
  rootObjectId: 'root:test',
});
const CONTENT = Uint8Array.from(Buffer.from('exact create bytes', 'utf8'));
const CONTENT_SHA256 = createHash('sha256').update(CONTENT).digest('hex');

const closeRoot = vi.fn(async () => undefined);
const ROOT_LEASE = Object.freeze({
  handle: Object.freeze({
    fd: 41,
    close: closeRoot,
  }),
  path: '/trusted/workspace',
  device: '7',
  inode: '11',
}) as unknown as PinnedDirectoryLease;

function capability(): LinuxOpenat2FilesystemCapability {
  return new LinuxOpenat2FilesystemCapability({
    capabilityScope: CAPABILITY_SCOPE,
    root: {
      path: '/trusted/workspace',
      device: ROOT_LEASE.device,
      inode: ROOT_LEASE.inode,
    },
    helper: {
      path: '/trusted/clodex-openat2-helper',
      sha256: HASH_A,
      device: '7',
      inode: '12',
    },
  });
}

function processResult(
  stdout: string,
  stderr = '',
  exitCode: number | null = 0,
  signal: NodeJS.Signals | null = null,
): PinnedProcessResult {
  return Object.freeze({
    exitCode,
    signal,
    stdout: Uint8Array.from(Buffer.from(stdout, 'utf8')),
    stderr: Uint8Array.from(Buffer.from(stderr, 'utf8')),
  });
}

function inspectCreateInput(): FilesystemCreateInspectInput {
  return {
    capabilityScope: CAPABILITY_SCOPE,
    requestId: 'request:create',
    selector: { kind: 'file', path: 'src/new-file.ts' },
    contentSha256: CONTENT_SHA256,
    contentBytes: CONTENT.byteLength,
  };
}

function executeCreateInput(
  resolvedObjectId: string,
): FilesystemCreateExecuteInput {
  return {
    ...inspectCreateInput(),
    ticketId: 'ticket:create',
    resolvedObjectId,
    expectedStateCommitmentHash: HASH_A,
    content: CONTENT,
  };
}

async function preparedCreate(
  filesystem: LinuxOpenat2FilesystemCapability,
): Promise<{ readonly resolvedObjectId: string }> {
  securityMocks.runPinnedExecutable.mockResolvedValueOnce(
    processResult(`OK\t${HASH_A}\n`),
  );
  return (await filesystem.inspectCreate(inspectCreateInput())) as {
    readonly resolvedObjectId: string;
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  closeRoot.mockResolvedValue(undefined);
  securityMocks.openPinnedDirectory.mockResolvedValue(ROOT_LEASE);
  securityMocks.assertPinnedDirectoryLease.mockResolvedValue(undefined);
});

describe('disabled filesystem mutation paths', () => {
  it('rejects replace before reading selector, content, or opening the helper boundary', async () => {
    const filesystem = capability();
    const forbiddenRead = vi.fn(() => {
      throw new Error('disabled replace input was read after scope validation');
    });
    const input = { capabilityScope: CAPABILITY_SCOPE } as Record<
      string,
      unknown
    >;
    for (const name of [
      'requestId',
      'selector',
      'contentSha256',
      'contentBytes',
      'beforeSha256',
      'ticketId',
      'resolvedObjectId',
      'expectedStateCommitmentHash',
      'content',
    ]) {
      Object.defineProperty(input, name, {
        configurable: true,
        enumerable: true,
        get: forbiddenRead,
      });
    }

    await expect(
      filesystem.executeReplace(
        input as unknown as FilesystemReplaceExecuteInput,
      ),
    ).rejects.toMatchObject({
      name: 'NodeAdapterSecurityError',
      code: 'operation-unsupported',
      stage: 'execute',
      effectMayHaveOccurred: false,
    });
    expect(forbiddenRead).not.toHaveBeenCalled();
    expect(securityMocks.openPinnedDirectory).not.toHaveBeenCalled();
    expect(securityMocks.runPinnedExecutable).not.toHaveBeenCalled();
    expect(securityMocks.assertPinnedDirectoryLease).not.toHaveBeenCalled();
  });

  it('rejects mkdir before reading its selector or opening the helper boundary', async () => {
    const filesystem = capability();
    const forbiddenRead = vi.fn(() => {
      throw new Error('disabled mkdir input was read after scope validation');
    });
    const input = { capabilityScope: CAPABILITY_SCOPE } as Record<
      string,
      unknown
    >;
    for (const name of [
      'requestId',
      'selector',
      'ticketId',
      'resolvedObjectId',
      'expectedStateCommitmentHash',
    ]) {
      Object.defineProperty(input, name, {
        configurable: true,
        enumerable: true,
        get: forbiddenRead,
      });
    }

    await expect(
      filesystem.executeMkdir(input as unknown as FilesystemMkdirExecuteInput),
    ).rejects.toMatchObject({
      name: 'NodeAdapterSecurityError',
      code: 'operation-unsupported',
      stage: 'execute',
      effectMayHaveOccurred: false,
    });
    expect(forbiddenRead).not.toHaveBeenCalled();
    expect(securityMocks.openPinnedDirectory).not.toHaveBeenCalled();
    expect(securityMocks.runPinnedExecutable).not.toHaveBeenCalled();
    expect(securityMocks.assertPinnedDirectoryLease).not.toHaveBeenCalled();
  });
});

describe('create helper protocol classification', () => {
  it('passes exact create bytes and the held root descriptor through the fixed helper protocol', async () => {
    const filesystem = capability();
    const prepared = await preparedCreate(filesystem);
    securityMocks.runPinnedExecutable.mockResolvedValueOnce(
      processResult(`OK\t${HASH_B}\t${HASH_C}\n`),
    );

    const result = await filesystem.executeCreate(
      executeCreateInput(prepared.resolvedObjectId),
    );

    expect(result).toEqual({
      operation: 'filesystem.create',
      ticketId: 'ticket:create',
      resolvedObjectId: prepared.resolvedObjectId,
      preStateHash: HASH_B,
      postStateHash: HASH_C,
      contentSha256: CONTENT_SHA256,
      contentBytes: CONTENT.byteLength,
    });
    expect(securityMocks.runPinnedExecutable).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: [
          '--protocol-v1',
          'execute-create',
          ROOT_LEASE.device,
          ROOT_LEASE.inode,
          'src/new-file.ts',
          HASH_A,
          '-',
          CONTENT_SHA256,
          String(CONTENT.byteLength),
        ],
        stdin: CONTENT,
        environment: { LANG: 'C', LC_ALL: 'C' },
        extraFileDescriptors: [ROOT_LEASE.handle.fd],
        stage: 'execute',
        effectMayHaveOccurredOnFailure: true,
      }),
    );
    expect(securityMocks.assertPinnedDirectoryLease).toHaveBeenLastCalledWith(
      ROOT_LEASE,
      'execute',
    );
    expect(closeRoot).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: 'ordinary prepare failure',
      result: processResult('', 'ERR\tDENIED\tpath absent\n', 9),
      code: 'helper-failure',
      effectMayHaveOccurred: false,
    },
    {
      name: 'helper-declared uncertain prepare failure',
      result: processResult('', 'ERR\tUNCERTAIN\tstate changed\n', 9),
      code: 'effect-uncertain',
      effectMayHaveOccurred: true,
    },
    {
      name: 'unexpected stderr on prepare success',
      result: processResult(`OK\t${HASH_A}\n`, 'warning\n'),
      code: 'helper-output-invalid',
      effectMayHaveOccurred: false,
    },
    {
      name: 'malformed prepare success record',
      result: processResult(`OK\t${HASH_A}`),
      code: 'helper-output-invalid',
      effectMayHaveOccurred: false,
    },
  ])('classifies $name without granting mutation authority', async ({
    result,
    code,
    effectMayHaveOccurred,
  }) => {
    const filesystem = capability();
    securityMocks.runPinnedExecutable.mockResolvedValueOnce(result);

    await expect(
      filesystem.inspectCreate(inspectCreateInput()),
    ).rejects.toMatchObject({
      name: 'NodeAdapterSecurityError',
      code,
      stage: 'prepare',
      effectMayHaveOccurred,
    });
    expect(closeRoot).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'non-zero exit',
      result: processResult('', 'ERR\tDENIED\tcreate failed\n', 9),
      code: 'effect-uncertain',
    },
    {
      name: 'signal termination',
      result: processResult('', '', null, 'SIGKILL'),
      code: 'effect-uncertain',
    },
    {
      name: 'unexpected stderr on success',
      result: processResult(`OK\t${HASH_B}\t${HASH_C}\n`, 'unexpected\n'),
      code: 'helper-output-invalid',
    },
    {
      name: 'malformed success record',
      result: processResult(`OK\t${HASH_B}\n`),
      code: 'helper-output-invalid',
    },
  ])('marks execute-create $name as potentially effected', async ({
    result,
    code,
  }) => {
    const filesystem = capability();
    const prepared = await preparedCreate(filesystem);
    securityMocks.runPinnedExecutable.mockResolvedValueOnce(result);

    await expect(
      filesystem.executeCreate(executeCreateInput(prepared.resolvedObjectId)),
    ).rejects.toMatchObject({
      name: 'NodeAdapterSecurityError',
      code,
      stage: 'execute',
      effectMayHaveOccurred: true,
    });
    expect(closeRoot).toHaveBeenCalledTimes(2);
  });
});

describe('data-only capability configuration', () => {
  it('rejects an accessor option without invoking it', () => {
    const capabilityScopeGetter = vi.fn(() => CAPABILITY_SCOPE);
    const options = {
      root: { path: '/trusted/workspace', device: '7', inode: '11' },
      helper: { path: '/trusted/helper', sha256: HASH_A },
    } as Record<string, unknown>;
    Object.defineProperty(options, 'capabilityScope', {
      enumerable: true,
      get: capabilityScopeGetter,
    });

    expect(
      () =>
        new LinuxOpenat2FilesystemCapability(
          options as unknown as ConstructorParameters<
            typeof LinuxOpenat2FilesystemCapability
          >[0],
        ),
    ).toThrowError(NodeAdapterSecurityError);
    expect(capabilityScopeGetter).not.toHaveBeenCalled();
  });

  it('does not accept a required option inherited from the prototype', () => {
    const capabilityScopeGetter = vi.fn(() => CAPABILITY_SCOPE);
    const prototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(prototype, 'capabilityScope', {
      enumerable: true,
      get: capabilityScopeGetter,
    });
    const options = Object.assign(Object.create(prototype), {
      root: { path: '/trusted/workspace', device: '7', inode: '11' },
      helper: { path: '/trusted/helper', sha256: HASH_A },
    });

    expect(
      () =>
        new LinuxOpenat2FilesystemCapability(
          options as ConstructorParameters<
            typeof LinuxOpenat2FilesystemCapability
          >[0],
        ),
    ).toThrowError(NodeAdapterSecurityError);
    expect(capabilityScopeGetter).not.toHaveBeenCalled();
  });
});
