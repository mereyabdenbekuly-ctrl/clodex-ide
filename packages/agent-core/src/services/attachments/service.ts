import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  protectedFileContext,
  readPossiblyProtectedFile,
  type HostPaths,
  type ProtectedFileStorage,
} from '../../host';
import {
  access,
  copyFile,
  createReadStream,
  mkdir,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
  type ReadStream,
} from '../../fs';
import { Readable } from 'node:stream';

/**
 * Per-agent on-disk attachment blob store.
 *
 * Each attachment is identified by `(agentId, attachmentId)` and stored at
 * `host.agentAttachmentPath(agentId, attachmentId)`. Writes go through a
 * temp-then-rename dance for atomicity. Per-agent cleanup is exposed via
 * `deleteAgentBlobs()`; the agent-manager fires it when an agent is hard
 * deleted (archive intentionally preserves blobs so a resumed agent can
 * still read its attachments).
 *
 * Construction is cheap and stateless — the service holds only the
 * injected `HostPaths` reference and does not open any handles up front.
 */
export class AttachmentsService {
  private readonly paths: HostPaths;
  private readonly protectedFiles: ProtectedFileStorage | undefined;

  constructor(paths: HostPaths, protectedFiles?: ProtectedFileStorage) {
    this.paths = paths;
    this.protectedFiles = protectedFiles;
  }

  /**
   * Returns the per-agent attachment directory (may not exist yet).
   */
  public agentBlobDir(agentId: string): string {
    return this.paths.agentAttachmentsDir(agentId);
  }

  /**
   * Returns the absolute path of an attachment blob (may not exist yet).
   */
  public blobPath(agentId: string, attachmentId: string): string {
    return this.paths.agentAttachmentPath(agentId, attachmentId);
  }

  /**
   * Write attachment content to disk using temp-then-rename for atomicity.
   * Accepts either a Buffer (for IPC-transferred data) or a filesystem path
   * (for direct copy from a dropped file).
   */
  public async write(
    agentId: string,
    attachmentId: string,
    source: Buffer | string,
  ): Promise<void> {
    const dir = this.paths.agentAttachmentsDir(agentId);
    await mkdir(dir, { recursive: true });

    const finalPath = this.paths.agentAttachmentPath(agentId, attachmentId);
    const tempPath = path.join(dir, `tmp-${randomUUID()}`);

    try {
      if (this.protectedFiles) {
        await this.protectedFiles.writeFile(
          finalPath,
          typeof source === 'string' ? createReadStream(source) : source,
          protectedFileContext.attachment(agentId, attachmentId),
        );
      } else {
        if (typeof source === 'string') {
          await copyFile(source, tempPath);
        } else {
          await writeFile(tempPath, source);
        }
        await rename(tempPath, finalPath);
      }
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      throw err;
    }
  }

  public async read(agentId: string, attachmentId: string): Promise<Buffer> {
    const filePath = this.paths.agentAttachmentPath(agentId, attachmentId);
    return readPossiblyProtectedFile(
      this.protectedFiles,
      filePath,
      protectedFileContext.attachment(agentId, attachmentId),
    );
  }

  public readStream(
    agentId: string,
    attachmentId: string,
  ): ReadStream | Readable {
    const filePath = this.paths.agentAttachmentPath(agentId, attachmentId);
    if (this.protectedFiles) {
      return Readable.from(
        (async function* (
          storage: ProtectedFileStorage,
          context: string,
        ): AsyncGenerator<Buffer> {
          if (await storage.isProtectedFile(filePath)) {
            yield* storage.readChunks(filePath, context);
          } else {
            for await (const chunk of createReadStream(filePath)) {
              yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            }
          }
        })(
          this.protectedFiles,
          protectedFileContext.attachment(agentId, attachmentId),
        ),
      );
    }
    return createReadStream(filePath);
  }

  public async migrateAgentBlobs(agentId: string): Promise<number> {
    if (!this.protectedFiles) return 0;
    const dir = this.paths.agentAttachmentsDir(agentId);
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let migrated = 0;
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('tmp-')) continue;
      const attachmentId = entry.name;
      const result = await this.protectedFiles.migrateFile(
        this.paths.agentAttachmentPath(agentId, attachmentId),
        protectedFileContext.attachment(agentId, attachmentId),
      );
      if (result === 'migrated') migrated++;
    }
    return migrated;
  }

  public async migrateAllBlobs(): Promise<number> {
    if (!this.protectedFiles) return 0;
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(this.paths.agentsDir(), {
        withFileTypes: true,
      });
    } catch {
      return 0;
    }
    let migrated = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      migrated += await this.migrateAgentBlobs(entry.name);
    }
    return migrated;
  }

  public async deleteAgentBlobs(agentId: string): Promise<void> {
    const dir = this.paths.agentAttachmentsDir(agentId);
    await rm(dir, { recursive: true, force: true });
  }

  public async copyAgentBlobs(
    sourceAgentId: string,
    targetAgentId: string,
  ): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(this.paths.agentAttachmentsDir(sourceAgentId), {
        withFileTypes: true,
      });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('tmp-')) continue;
      const content = await this.read(sourceAgentId, entry.name);
      await this.write(targetAgentId, entry.name, content);
    }
  }

  public async exists(agentId: string, attachmentId: string): Promise<boolean> {
    try {
      await access(this.paths.agentAttachmentPath(agentId, attachmentId));
      return true;
    } catch {
      return false;
    }
  }
}
