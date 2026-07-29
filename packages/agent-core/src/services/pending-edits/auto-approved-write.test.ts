import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { open as nodeOpen } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const fsMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('../../fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../fs')>();
  return { ...actual, open: fsMocks.open };
});

import {
  type AutoApprovedFileBinding,
  writeAutoApprovedEditToDisk,
} from './index';

type NodeFileHandle = Awaited<ReturnType<typeof nodeOpen>>;

function withFailingClose(handle: NodeFileHandle): NodeFileHandle {
  const close = handle.close.bind(handle);
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'close') {
        return async () => {
          await close();
          throw new Error('synthetic close failure');
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function withBeforeFirstWrite(
  handle: NodeFileHandle,
  callback: () => void,
): NodeFileHandle {
  let invoked = false;
  const write = handle.write.bind(handle) as unknown as (
    ...args: unknown[]
  ) => Promise<unknown>;
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'write') {
        return async (...args: unknown[]) => {
          if (!invoked) {
            invoked = true;
            callback();
          }
          return await write(...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function captureBinding(
  workspaceRoot: string,
  target: string,
): AutoApprovedFileBinding {
  // Match the native canonicalization used by the production promises API.
  // The non-native sync resolver can preserve a Windows 8.3 path alias.
  const physicalWorkspaceRoot = realpathSync.native(workspaceRoot);
  const physicalTarget = realpathSync.native(target);
  // Production captures this capability with lstat().  Keep the test seam
  // identical: on Windows, identity values obtained through stat() and
  // lstat() are not interchangeable across every canonical/short-path alias.
  const workspaceStat = lstatSync(physicalWorkspaceRoot);
  const targetStat = lstatSync(physicalTarget);
  return {
    dev: targetStat.dev,
    ino: targetStat.ino,
    workspaceRoot,
    physicalWorkspaceRoot,
    physicalTarget,
    workspaceRootIdentity: {
      dev: workspaceStat.dev,
      ino: workspaceStat.ino,
    },
  };
}

function expectWindowsRenameDenied(error: unknown): void {
  expect(process.platform).toBe('win32');
  expect(error).toBeInstanceOf(Error);
  const errno = error as NodeJS.ErrnoException;
  expect(['EPERM', 'EACCES', 'EBUSY']).toContain(errno.code);
  expect(errno.syscall).toBe('rename');
}

describe('guarded automatic file writes', () => {
  let root: string;
  let filePath: string;

  beforeEach(() => {
    // Windows runners may expose tmpdir() through an 8.3 alias such as
    // C:\Users\RUNNER~1 while native realpath resolution returns the long path.
    // Build every fixture path from one canonical root so the test exercises
    // production's object/path binding checks instead of an alias mismatch in
    // the fixture.
    root = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), 'agent-core-auto-write-')),
    );
    filePath = path.join(root, 'file.txt');
    writeFileSync(filePath, 'before');
    fsMocks.open.mockReset();
    fsMocks.open.mockImplementation((...args: Parameters<typeof nodeOpen>) =>
      nodeOpen(...args),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('revokes automatic authority at the final boundary before the first write', async () => {
    const assertAutoPolicyAuthorized = vi.fn(() => {
      throw new Error('automatic mode disabled');
    });

    await expect(
      writeAutoApprovedEditToDisk(
        filePath,
        'before',
        'after',
        captureBinding(root, filePath),
        assertAutoPolicyAuthorized,
      ),
    ).rejects.toThrow('automatic mode disabled');

    expect(assertAutoPolicyAuthorized).toHaveBeenCalledOnce();
    expect(readFileSync(filePath, 'utf8')).toBe('before');
  });

  it('keeps a synced mutation authoritative when close cleanup fails', async () => {
    fsMocks.open.mockImplementationOnce(
      async (...args: Parameters<typeof nodeOpen>) =>
        withFailingClose(await nodeOpen(...args)),
    );
    const receipt = await writeAutoApprovedEditToDisk(
      filePath,
      'before',
      'after',
      captureBinding(root, filePath),
      () => {},
    );

    expect(readFileSync(filePath, 'utf8')).toBe('after');
    await expect(receipt.verify()).resolves.toBe(true);
    await expect(receipt.commit()).resolves.toBe(true);
    expect(receipt.cleanupError).toMatchObject({
      message: 'synthetic close failure',
    });
    expect(readFileSync(filePath, 'utf8')).toBe('after');
  });

  it('fails closed when a newer same-inode write remains observable', async () => {
    const beforeStat = statSync(filePath);
    const receipt = await writeAutoApprovedEditToDisk(
      filePath,
      'before',
      'agent content',
      captureBinding(root, filePath),
      () => {},
    );

    // A portable regular-file API cannot exclude an uncooperative writer
    // between compare and write. This test covers the detectable side of that
    // residual risk: once the newer state is observable, verification and
    // rollback both fail closed instead of overwriting it.
    writeFileSync(filePath, 'newer user content');
    expect(statSync(filePath).ino).toBe(beforeStat.ino);

    await expect(receipt.verify()).resolves.toBe(false);
    await expect(receipt.rollback()).resolves.toBe(false);
    expect(readFileSync(filePath, 'utf8')).toBe('newer user content');
  });

  it('restores the baseline through the open handle after a parent swap during write', async () => {
    const workspaceRoot = path.join(root, 'workspace');
    const parentPath = path.join(workspaceRoot, 'src');
    const movedParentPath = path.join(root, 'moved-src');
    mkdirSync(parentPath, { recursive: true });
    filePath = path.join(parentPath, 'file.txt');
    writeFileSync(filePath, 'before');
    const binding = captureBinding(workspaceRoot, filePath);
    let relocationError: unknown;

    fsMocks.open.mockImplementationOnce(
      async (...args: Parameters<typeof nodeOpen>) =>
        withBeforeFirstWrite(await nodeOpen(...args), () => {
          try {
            renameSync(parentPath, movedParentPath);
          } catch (error) {
            relocationError = error;
            if (process.platform !== 'win32') throw error;
            return;
          }
          symlinkSync(
            movedParentPath,
            parentPath,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        }),
    );

    const operation = writeAutoApprovedEditToDisk(
      filePath,
      'before',
      'agent content',
      binding,
      () => {},
    );
    if (process.platform === 'win32') {
      // Windows denies renaming a parent that contains the target while the
      // target handle is held open. The denied attacker operation must not
      // interrupt the authorized write; settlement then restores the exact
      // baseline and releases the handle so a later rename can succeed.
      const receipt = await operation;
      expectWindowsRenameDenied(relocationError);
      expect(lstatSync(parentPath).isDirectory()).toBe(true);
      expect(() => lstatSync(movedParentPath)).toThrow();
      expect(readFileSync(filePath, 'utf8')).toBe('agent content');
      await expect(receipt.verify()).resolves.toBe(true);
      await expect(receipt.rollback()).resolves.toBe(true);
      expect(readFileSync(filePath, 'utf8')).toBe('before');
      renameSync(parentPath, movedParentPath);
      expect(readFileSync(path.join(movedParentPath, 'file.txt'), 'utf8')).toBe(
        'before',
      );
      return;
    }

    await expect(operation).rejects.toThrow('path binding changed');

    expect(readFileSync(path.join(movedParentPath, 'file.txt'), 'utf8')).toBe(
      'before',
    );
    expect(readFileSync(filePath, 'utf8')).toBe('before');
  });

  it('uses the held inode to roll back exact agent bytes after the target leaves its bound parent chain', async () => {
    const workspaceRoot = path.join(root, 'workspace');
    const parentPath = path.join(workspaceRoot, 'src');
    const movedParentPath = path.join(root, 'moved-src');
    mkdirSync(parentPath, { recursive: true });
    filePath = path.join(parentPath, 'file.txt');
    writeFileSync(filePath, 'before');
    const binding = captureBinding(workspaceRoot, filePath);
    const receipt = await writeAutoApprovedEditToDisk(
      filePath,
      'before',
      'after',
      binding,
      () => {},
    );

    let relocationError: unknown;
    try {
      renameSync(parentPath, movedParentPath);
    } catch (error) {
      relocationError = error;
    }
    if (relocationError !== undefined) {
      // A Windows open handle pins this parent chain against rename. Verify
      // that the receipt remains valid and can still restore the exact agent
      // effect; platforms that permit the relocation continue through the
      // observable-drift assertions below.
      expectWindowsRenameDenied(relocationError);
      expect(lstatSync(parentPath).isDirectory()).toBe(true);
      expect(() => lstatSync(movedParentPath)).toThrow();
      await expect(receipt.verify()).resolves.toBe(true);
      await expect(receipt.rollback()).resolves.toBe(true);
      expect(readFileSync(filePath, 'utf8')).toBe('before');
      renameSync(parentPath, movedParentPath);
      expect(readFileSync(path.join(movedParentPath, 'file.txt'), 'utf8')).toBe(
        'before',
      );
      return;
    }
    symlinkSync(
      movedParentPath,
      parentPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(receipt.verify()).resolves.toBe(false);
    await expect(receipt.commit()).resolves.toBe(false);
    await expect(receipt.rollback()).resolves.toBe(true);
    expect(readFileSync(path.join(movedParentPath, 'file.txt'), 'utf8')).toBe(
      'before',
    );
  });
});
