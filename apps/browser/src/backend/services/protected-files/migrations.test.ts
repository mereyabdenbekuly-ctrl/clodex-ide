import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AeadDataProtection,
  ProtectedAppendFileStorage,
  ProtectedFileStorage,
  protectedFileContext,
  type HostPaths,
} from '@clodex/agent-core/host';
import {
  migrateDiffHistoryBlobs,
  migrateMemoryFiles,
  migrateShellLogFiles,
} from './migrations';

describe('protected-file browser migrations', () => {
  let root: string;
  let paths: HostPaths;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'protected-migrations-'));
    const noop = () => root;
    paths = {
      dataDir: noop,
      tempDir: noop,
      agentsDir: () => path.join(root, 'agents'),
      agentDir: (id) => path.join(root, 'agents', id),
      agentAttachmentsDir: noop,
      agentAttachmentPath: noop,
      agentAppsDir: noop,
      agentShellLogsDir: (id) => path.join(root, 'agents', id, 'shell-logs'),
      diffHistoryDir: noop,
      diffHistoryDbPath: noop,
      diffHistoryBlobsDir: () => path.join(root, 'diff-history', 'data-blobs'),
      agentDbPath: noop,
      fileReadCacheDbPath: noop,
      processedImageCacheDbPath: noop,
      userDataDir: noop,
      plansDir: noop,
      logsDir: noop,
      memoryDir: () => path.join(root, 'memory'),
      pluginsDir: noop,
      builtinSkillsDir: noop,
      ripgrepBaseDir: noop,
    };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('migrates plaintext shell logs into protected append segments', async () => {
    const logPath = path.join(
      paths.agentShellLogsDir('agent-a'),
      's1.shell.log',
    );
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, 'legacy shell secret\n');
    const storage = new ProtectedFileStorage(
      new AeadDataProtection(randomBytes(32)),
      { chunkSize: 4096 },
    );

    await expect(migrateShellLogFiles(storage, paths)).resolves.toBe(1);
    expect(await fs.readFile(logPath, 'utf-8')).not.toContain('legacy shell');
    const append = new ProtectedAppendFileStorage(
      storage,
      logPath,
      protectedFileContext.shellLog('agent-a', 's1.shell.log'),
    );
    expect((await append.readFile()).toString('utf-8')).toBe(
      'legacy shell secret\n',
    );
  });

  it('recursively migrates memory archives with path-bound contexts', async () => {
    const memoryFile = path.join(
      paths.memoryDir(),
      'agents',
      'agent-a',
      'history.md',
    );
    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    await fs.writeFile(memoryFile, '# private memory\nsecret');
    const storage = new ProtectedFileStorage(
      new AeadDataProtection(randomBytes(32)),
      { chunkSize: 4096 },
    );

    await expect(migrateMemoryFiles(storage, paths)).resolves.toBe(1);
    expect(await fs.readFile(memoryFile, 'utf-8')).not.toContain('private');
    expect(
      (
        await storage.readFile(
          memoryFile,
          protectedFileContext.memory('agents/agent-a/history.md'),
        )
      ).toString('utf-8'),
    ).toContain('# private memory');
  });

  it('migrates and verifies content-addressed diff-history blobs', async () => {
    const plaintext = Buffer.from('private external diff payload');
    const oid = (await import('node:crypto'))
      .createHash('sha256')
      .update(plaintext)
      .digest('hex');
    const blobPath = path.join(paths.diffHistoryBlobsDir(), oid);
    await fs.mkdir(path.dirname(blobPath), { recursive: true });
    await fs.writeFile(blobPath, plaintext);
    const storage = new ProtectedFileStorage(
      new AeadDataProtection(randomBytes(32)),
      { chunkSize: 4096 },
    );

    await expect(migrateDiffHistoryBlobs(storage, paths)).resolves.toBe(1);
    expect((await fs.readFile(blobPath)).includes(plaintext)).toBe(false);
    expect(
      await storage.readFile(
        blobPath,
        protectedFileContext.diffHistoryBlobStore(),
      ),
    ).toEqual(plaintext);
  });

  it('fails startup migration when a diff-history OID does not match its content', async () => {
    const blobPath = path.join(paths.diffHistoryBlobsDir(), '0'.repeat(64));
    await fs.mkdir(path.dirname(blobPath), { recursive: true });
    await fs.writeFile(blobPath, 'corrupt legacy blob');
    const storage = new ProtectedFileStorage(
      new AeadDataProtection(randomBytes(32)),
      { chunkSize: 4096 },
    );

    await expect(migrateDiffHistoryBlobs(storage, paths)).rejects.toThrow(
      'does not match OID',
    );
  });
});
