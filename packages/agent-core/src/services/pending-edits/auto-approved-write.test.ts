import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  mkdirSync,
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
  const physicalWorkspaceRoot = realpathSync(workspaceRoot);
  const physicalTarget = realpathSync(target);
  const workspaceStat = statSync(physicalWorkspaceRoot);
  const targetStat = statSync(physicalTarget);
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

describe('guarded automatic file writes', () => {
  let root: string;
  let filePath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'agent-core-auto-write-'));
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

    fsMocks.open.mockImplementationOnce(
      async (...args: Parameters<typeof nodeOpen>) =>
        withBeforeFirstWrite(await nodeOpen(...args), () => {
          renameSync(parentPath, movedParentPath);
          symlinkSync(
            movedParentPath,
            parentPath,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        }),
    );

    await expect(
      writeAutoApprovedEditToDisk(filePath, 'before', 'agent content', binding),
    ).rejects.toThrow('path binding changed');

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
    );

    renameSync(parentPath, movedParentPath);
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
