import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AeadDataProtection, ProtectedFileStorage } from '../../host';
import type { HostPaths } from '../../host';
import { AttachmentsService } from './service';

describe('AttachmentsService protected files', () => {
  let root: string;
  let paths: HostPaths;
  let storage: ProtectedFileStorage;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'attachments-protected-'));
    const noop = () => root;
    paths = {
      dataDir: noop,
      tempDir: noop,
      agentsDir: () => path.join(root, 'agents'),
      agentDir: (agentId) => path.join(root, 'agents', agentId),
      agentAttachmentsDir: (agentId) =>
        path.join(root, 'agents', agentId, 'data-attachments'),
      agentAttachmentPath: (agentId, attachmentId) =>
        path.join(root, 'agents', agentId, 'data-attachments', attachmentId),
      agentAppsDir: noop,
      agentShellLogsDir: noop,
      diffHistoryDir: noop,
      diffHistoryDbPath: noop,
      diffHistoryBlobsDir: noop,
      agentDbPath: noop,
      fileReadCacheDbPath: noop,
      processedImageCacheDbPath: noop,
      userDataDir: noop,
      plansDir: noop,
      logsDir: noop,
      memoryDir: noop,
      pluginsDir: noop,
      builtinSkillsDir: noop,
      ripgrepBaseDir: noop,
    };
    storage = new ProtectedFileStorage(
      new AeadDataProtection(randomBytes(32)),
      { chunkSize: 4096 },
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores ciphertext but exposes plaintext through buffer and stream reads', async () => {
    const service = new AttachmentsService(paths, storage);
    const content = Buffer.concat([
      Buffer.from('attachment-secret:'),
      randomBytes(10_000),
    ]);
    await service.write('agent-a', 'payload.bin', content);

    const disk = await readFile(service.blobPath('agent-a', 'payload.bin'));
    expect(disk.includes(Buffer.from('attachment-secret'))).toBe(false);
    expect(await service.read('agent-a', 'payload.bin')).toEqual(content);

    const chunks: Buffer[] = [];
    for await (const chunk of service.readStream('agent-a', 'payload.bin')) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks)).toEqual(content);
  });

  it('migrates existing plaintext blobs before use', async () => {
    const legacyPath = paths.agentAttachmentPath('legacy-agent', 'old.txt');
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, 'legacy-sensitive-content');

    const service = new AttachmentsService(paths, storage);
    await expect(service.migrateAllBlobs()).resolves.toBe(1);
    expect(await service.read('legacy-agent', 'old.txt')).toEqual(
      Buffer.from('legacy-sensitive-content'),
    );
    expect(await readFile(legacyPath, 'utf-8')).not.toContain(
      'legacy-sensitive-content',
    );
  });
});
