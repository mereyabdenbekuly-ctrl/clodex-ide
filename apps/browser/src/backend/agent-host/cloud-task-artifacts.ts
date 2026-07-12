import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type {
  CloudTaskArtifactDescriptor,
  CloudTaskControlPlane,
  CloudTaskStartedExecution,
} from './cloud-task-control-plane';
import {
  classifyCloudTaskFailure,
  type CloudTaskControlPlaneAuditEvent,
} from './cloud-task-observability';
import type {
  CloudTaskExecutionPolicy,
  CloudTaskSecretBroker,
} from './cloud-task-security';
import type {
  CloudTaskArtifactReservation,
  FileSystemCloudTaskArtifactStore,
} from './cloud-task-artifact-store';

const CHECKPOINT_VERSION = 1;
const CHECKPOINT_INTERVAL_BYTES = 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 32 * 1024;

export interface DownloadedCloudTaskArtifact {
  executionId: string;
  artifactId: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  localPath: string;
  resumedBytes: number;
}

export interface CloudTaskArtifactDownloader {
  download(input: {
    taskId: string;
    execution: CloudTaskStartedExecution;
    artifact: CloudTaskArtifactDescriptor;
    policy: CloudTaskExecutionPolicy;
    signal?: AbortSignal;
  }): Promise<DownloadedCloudTaskArtifact>;
}

export interface FileSystemCloudTaskArtifactDownloaderOptions {
  rootDirectory: string;
  controlPlane: CloudTaskControlPlane;
  secretBroker: CloudTaskSecretBroker;
  artifactStore?: FileSystemCloudTaskArtifactStore;
  audit?: (event: CloudTaskControlPlaneAuditEvent) => void;
  now?: () => number;
}

interface ArtifactResumeCheckpoint {
  version: typeof CHECKPOINT_VERSION;
  artifactId: string;
  executionId: string;
  expectedSize: number;
  expectedSha256: string;
  downloadedBytes: number;
  updatedAt: number;
}

export class FileSystemCloudTaskArtifactDownloader
  implements CloudTaskArtifactDownloader
{
  private readonly rootDirectory: string;
  private readonly now: () => number;

  public constructor(
    private readonly options: FileSystemCloudTaskArtifactDownloaderOptions,
  ) {
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.now = options.now ?? Date.now;
  }

  public async download(input: {
    taskId: string;
    execution: CloudTaskStartedExecution;
    artifact: CloudTaskArtifactDescriptor;
    policy: CloudTaskExecutionPolicy;
    signal?: AbortSignal;
  }): Promise<DownloadedCloudTaskArtifact> {
    const startedAt = this.now();
    const { artifact, policy } = input;
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(artifact.artifactId)) {
      throw new Error('Cloud task artifact id is invalid');
    }
    if (artifact.sizeBytes > policy.maxArtifactBytes) {
      const error = new Error('Cloud task artifact byte quota exceeded');
      this.auditFailure(input, error, startedAt, 0);
      throw error;
    }
    const directory = this.artifactDirectory(input.execution.executionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const partialPath = path.join(directory, `${artifact.artifactId}.part`);
    const finalPath = path.join(directory, `${artifact.artifactId}.artifact`);
    const checkpointPath = path.join(
      directory,
      `${artifact.artifactId}.resume.json`,
    );
    let reservation: CloudTaskArtifactReservation | undefined;
    if (this.options.artifactStore) {
      reservation = await this.options.artifactStore.reserve({
        executionId: input.execution.executionId,
        artifactId: artifact.artifactId,
        expectedBytes: artifact.sizeBytes,
      });
    }

    try {
      const existing = await this.readCompletedArtifact(finalPath, artifact);
      if (existing) {
        await this.recordCompleted(input.execution, artifact);
        this.audit({
          operation: 'resume',
          success: true,
          residency: policy.residency,
          durationMs: this.now() - startedAt,
          artifactBytes: artifact.sizeBytes,
          resumedBytes: artifact.sizeBytes,
        });
        return this.result(
          input.execution,
          artifact,
          finalPath,
          artifact.sizeBytes,
        );
      }

      let offset = await this.resolveResumeOffset(
        input.execution,
        artifact,
        partialPath,
        checkpointPath,
      );
      const resumedBytes = offset;
      const digest = createHash('sha256');
      if (offset > 0) {
        await hashFileInto(partialPath, digest, input.signal);
      }
      if (offset === artifact.sizeBytes) {
        const actualHash = digest.digest('hex');
        if (actualHash !== artifact.sha256) {
          await Promise.all([
            rm(partialPath, { force: true }),
            rm(checkpointPath, { force: true }),
          ]);
          const error = new Error(
            'Cloud task artifact integrity digest mismatch',
          );
          this.auditFailure(input, error, startedAt, offset);
          throw error;
        }
        await rm(finalPath, { force: true });
        await rename(partialPath, finalPath);
        await rm(checkpointPath, { force: true });
        await this.recordCompleted(input.execution, artifact);
        this.audit({
          operation: 'resume',
          success: true,
          residency: policy.residency,
          durationMs: this.now() - startedAt,
          artifactBytes: artifact.sizeBytes,
          resumedBytes: offset,
        });
        this.audit({
          operation: 'artifact',
          success: true,
          residency: policy.residency,
          durationMs: this.now() - startedAt,
          artifactBytes: artifact.sizeBytes,
          resumedBytes: offset,
        });
        return this.result(input.execution, artifact, finalPath, offset);
      }

      let lease:
        | Awaited<ReturnType<CloudTaskSecretBroker['acquire']>>
        | undefined;
      try {
        lease = await this.options.secretBroker.acquire({
          taskId: input.taskId,
          residency: policy.residency,
          scopes: ['artifact:read'],
          signal: input.signal,
        });
        let complete = false;
        for (let attempt = 0; attempt < 2 && !complete; attempt += 1) {
          assertNotAborted(input.signal);
          try {
            offset = await this.downloadAttempt({
              ...input,
              token: lease.token,
              partialPath,
              checkpointPath,
              offset,
              digest,
            });
            complete = offset === artifact.sizeBytes;
            if (!complete) {
              throw new Error(
                'Cloud task artifact download ended before expected size',
              );
            }
          } catch (error) {
            if (
              attempt > 0 ||
              shouldDiscardPartial(error) ||
              input.signal?.aborted
            ) {
              throw error;
            }
            const nextOffset = await this.validPartialSize(
              partialPath,
              artifact.sizeBytes,
            );
            if (nextOffset < offset) {
              throw new Error('Cloud task artifact resume state regressed');
            }
            offset = nextOffset;
            await this.saveCheckpoint(
              checkpointPath,
              input.execution,
              artifact,
              offset,
            );
            this.audit({
              operation: 'resume',
              success: true,
              residency: policy.residency,
              artifactBytes: artifact.sizeBytes,
              resumedBytes: offset,
            });
          }
        }

        const actualHash = digest.digest('hex');
        if (actualHash !== artifact.sha256) {
          throw new Error('Cloud task artifact integrity digest mismatch');
        }
        await rm(finalPath, { force: true });
        await rename(partialPath, finalPath);
        await rm(checkpointPath, { force: true });
        await this.recordCompleted(input.execution, artifact);
        this.audit({
          operation: 'artifact',
          success: true,
          residency: policy.residency,
          durationMs: this.now() - startedAt,
          artifactBytes: artifact.sizeBytes,
          resumedBytes,
        });
        return this.result(input.execution, artifact, finalPath, resumedBytes);
      } catch (error) {
        if (shouldDiscardPartial(error)) {
          await Promise.all([
            rm(partialPath, { force: true }),
            rm(checkpointPath, { force: true }),
          ]);
        }
        this.auditFailure(input, error, startedAt, resumedBytes);
        throw error;
      } finally {
        await lease?.dispose();
      }
    } finally {
      await reservation?.release();
    }
  }

  private async downloadAttempt(input: {
    taskId: string;
    execution: CloudTaskStartedExecution;
    artifact: CloudTaskArtifactDescriptor;
    policy: CloudTaskExecutionPolicy;
    signal?: AbortSignal;
    token: string;
    partialPath: string;
    checkpointPath: string;
    offset: number;
    digest: ReturnType<typeof createHash>;
  }): Promise<number> {
    const opened = await this.options.controlPlane.downloadArtifact(
      input.artifact,
      input.token,
      input.offset,
      input.signal,
    );
    if (
      opened.startOffset !== input.offset ||
      opened.totalSize !== input.artifact.sizeBytes
    ) {
      throw new Error('Cloud task artifact resume binding is invalid');
    }
    const handle = await open(
      input.partialPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        (input.offset === 0 ? constants.O_TRUNC : 0) |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = input.offset;
    let checkpointAt = offset;
    try {
      const reader = opened.body.getReader();
      try {
        while (true) {
          assertNotAborted(input.signal);
          const result = await reader.read();
          if (result.done) break;
          if (result.value.byteLength === 0) continue;
          if (offset + result.value.byteLength > input.artifact.sizeBytes) {
            throw new Error('Cloud task artifact exceeds declared size');
          }
          await handle.write(result.value);
          input.digest.update(result.value);
          offset += result.value.byteLength;
          if (offset - checkpointAt >= CHECKPOINT_INTERVAL_BYTES) {
            await this.saveCheckpoint(
              input.checkpointPath,
              input.execution,
              input.artifact,
              offset,
            );
            checkpointAt = offset;
          }
        }
      } finally {
        reader.releaseLock();
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.saveCheckpoint(
      input.checkpointPath,
      input.execution,
      input.artifact,
      offset,
    );
    return offset;
  }

  private async readCompletedArtifact(
    finalPath: string,
    artifact: CloudTaskArtifactDescriptor,
  ): Promise<boolean> {
    try {
      const entry = await lstat(finalPath);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        await rm(finalPath, { recursive: true, force: true });
        return false;
      }
      if (entry.size !== artifact.sizeBytes) {
        await rm(finalPath, { force: true });
        return false;
      }
      return (await hashFile(finalPath)) === artifact.sha256;
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
  }

  private async resolveResumeOffset(
    execution: CloudTaskStartedExecution,
    artifact: CloudTaskArtifactDescriptor,
    partialPath: string,
    checkpointPath: string,
  ): Promise<number> {
    const checkpoint = await this.readCheckpoint(checkpointPath);
    if (
      !checkpoint ||
      checkpoint.executionId !== execution.executionId ||
      checkpoint.artifactId !== artifact.artifactId ||
      checkpoint.expectedSize !== artifact.sizeBytes ||
      checkpoint.expectedSha256 !== artifact.sha256
    ) {
      await Promise.all([
        rm(partialPath, { recursive: true, force: true }),
        rm(checkpointPath, { force: true }),
      ]);
      return 0;
    }
    const size = await this.validPartialSize(partialPath, artifact.sizeBytes);
    if (size !== checkpoint.downloadedBytes) {
      await Promise.all([
        rm(partialPath, { force: true }),
        rm(checkpointPath, { force: true }),
      ]);
      return 0;
    }
    return size;
  }

  private async validPartialSize(
    partialPath: string,
    expectedSize: number,
  ): Promise<number> {
    try {
      const entry = await lstat(partialPath);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.size > expectedSize
      ) {
        throw new Error('Cloud task artifact partial file is invalid');
      }
      return entry.size;
    } catch (error) {
      if (isMissingFileError(error)) return 0;
      throw error;
    }
  }

  private async readCheckpoint(
    checkpointPath: string,
  ): Promise<ArtifactResumeCheckpoint | null> {
    let text: string;
    try {
      text = await readFile(checkpointPath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_CHECKPOINT_BYTES) return null;
    try {
      const value = JSON.parse(text) as Partial<ArtifactResumeCheckpoint>;
      if (
        value.version !== CHECKPOINT_VERSION ||
        typeof value.artifactId !== 'string' ||
        typeof value.executionId !== 'string' ||
        !Number.isSafeInteger(value.expectedSize) ||
        typeof value.expectedSha256 !== 'string' ||
        !Number.isSafeInteger(value.downloadedBytes) ||
        !Number.isSafeInteger(value.updatedAt)
      ) {
        return null;
      }
      return value as ArtifactResumeCheckpoint;
    } catch {
      return null;
    }
  }

  private async saveCheckpoint(
    checkpointPath: string,
    execution: CloudTaskStartedExecution,
    artifact: CloudTaskArtifactDescriptor,
    downloadedBytes: number,
  ): Promise<void> {
    const checkpoint: ArtifactResumeCheckpoint = {
      version: CHECKPOINT_VERSION,
      artifactId: artifact.artifactId,
      executionId: execution.executionId,
      expectedSize: artifact.sizeBytes,
      expectedSha256: artifact.sha256,
      downloadedBytes,
      updatedAt: this.now(),
    };
    const temporaryPath = `${checkpointPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(checkpoint), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, checkpointPath);
  }

  private artifactDirectory(executionId: string): string {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(executionId)) {
      throw new Error('Cloud task execution id is invalid');
    }
    return path.join(this.rootDirectory, executionId);
  }

  private result(
    execution: CloudTaskStartedExecution,
    artifact: CloudTaskArtifactDescriptor,
    localPath: string,
    resumedBytes: number,
  ): DownloadedCloudTaskArtifact {
    return {
      executionId: execution.executionId,
      artifactId: artifact.artifactId,
      fileName: artifact.fileName,
      mediaType: artifact.mediaType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      localPath,
      resumedBytes,
    };
  }

  private async recordCompleted(
    execution: CloudTaskStartedExecution,
    artifact: CloudTaskArtifactDescriptor,
  ): Promise<void> {
    await this.options.artifactStore?.recordCompleted({
      executionId: execution.executionId,
      artifactId: artifact.artifactId,
      fileName: artifact.fileName,
      mediaType: artifact.mediaType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
    });
  }

  private auditFailure(
    input: {
      artifact: CloudTaskArtifactDescriptor;
      policy: CloudTaskExecutionPolicy;
    },
    error: unknown,
    startedAt: number,
    resumedBytes: number,
  ): void {
    this.audit({
      operation: 'artifact',
      success: false,
      residency: input.policy.residency,
      reason: classifyCloudTaskFailure(error),
      durationMs: this.now() - startedAt,
      artifactBytes: input.artifact.sizeBytes,
      resumedBytes,
    });
  }

  private audit(event: CloudTaskControlPlaneAuditEvent): void {
    try {
      this.options.audit?.(event);
    } catch {
      // Audit transport must never change artifact outcome.
    }
  }
}

async function hashFile(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  await hashFileInto(filePath, digest);
  return digest.digest('hex');
}

async function hashFileInto(
  filePath: string,
  digest: ReturnType<typeof createHash>,
  signal?: AbortSignal,
): Promise<void> {
  for await (const chunk of createReadStream(filePath)) {
    assertNotAborted(signal);
    digest.update(chunk as Buffer);
  }
}

function shouldDiscardPartial(error: unknown): boolean {
  const reason = classifyCloudTaskFailure(error);
  return reason === 'integrity' || reason === 'policy';
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException(
      'Cloud task artifact download aborted',
      'AbortError',
    );
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
