import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ProtectedAppendFileStorage,
  protectedFileContext,
  type HostPaths,
  type ProtectedFileStorage,
} from '@clodex/agent-core/host';

export async function migrateShellLogFiles(
  storage: ProtectedFileStorage,
  paths: HostPaths,
): Promise<number> {
  let agents: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    agents = await fs.readdir(paths.agentsDir(), { withFileTypes: true });
  } catch {
    return 0;
  }

  let migrated = 0;
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const logsDir = paths.agentShellLogsDir(agent.name);
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(logsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.shell.log')) continue;
      const appendFile = new ProtectedAppendFileStorage(
        storage,
        path.join(logsDir, entry.name),
        protectedFileContext.shellLog(agent.name, entry.name),
      );
      if ((await appendFile.migrate()) === 'migrated') migrated++;
    }
  }
  return migrated;
}

export async function migrateMemoryFiles(
  storage: ProtectedFileStorage,
  paths: HostPaths,
): Promise<number> {
  const root = path.resolve(paths.memoryDir());
  let migrated = 0;

  const walk = async (directory: string): Promise<void> => {
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.includes('.staging')) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(root, absolutePath);
      const result = await storage.migrateFile(
        absolutePath,
        protectedFileContext.memory(relativePath),
      );
      if (result === 'migrated') migrated++;
    }
  };

  await walk(root);
  return migrated;
}

export async function migrateDiffHistoryBlobs(
  storage: ProtectedFileStorage,
  paths: HostPaths,
): Promise<number> {
  const blobsDir = paths.diffHistoryBlobsDir();
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(blobsDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let migrated = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.includes('.staging')) continue;
    const blobPath = path.join(blobsDir, entry.name);
    const result = await storage.migrateFile(
      blobPath,
      protectedFileContext.diffHistoryBlobStore(),
    );
    if (result === 'migrated') migrated++;

    if (/^[a-f0-9]{64}$/.test(entry.name)) {
      const hash = createHash('sha256');
      for await (const chunk of storage.readChunks(
        blobPath,
        protectedFileContext.diffHistoryBlobStore(),
      )) {
        hash.update(chunk);
      }
      if (hash.digest('hex') !== entry.name) {
        throw new Error(
          `Diff-history blob content hash does not match OID: ${entry.name}`,
        );
      }
    }
  }
  return migrated;
}
