import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { CloudTaskStartedExecution } from './cloud-task-control-plane';

const CHECKPOINT_VERSION = 5;
const LEGACY_CHECKPOINT_VERSIONS = [3, 4] as const;
const MAX_CHECKPOINT_BYTES = 16 * 1024;
const DEFAULT_MAX_PENDING_CHECKPOINTS = 256;

export interface CloudTaskStreamResumeCheckpoint {
  version: typeof CHECKPOINT_VERSION;
  taskId: string;
  executionId: string;
  restoreReceiptId: string;
  agentInstanceId?: string | null;
  handoff: CloudTaskStreamResumeHandoff | null;
  cloudOwnership: CloudTaskStreamResumeOwnership | null;
  memoryCheckpoint: CloudTaskStreamResumeMemoryCheckpoint | null;
  lastSequence: number;
  expiresAt: number;
  updatedAt: number;
}

export interface CloudTaskStreamResumeOwnership {
  epoch: number;
}

export interface CloudTaskStreamResumeContext {
  agentInstanceId?: string | null;
  cloudOwnership?: CloudTaskStreamResumeOwnership | null;
  memoryCheckpoint?: CloudTaskStreamResumeMemoryCheckpoint | null;
}

export interface CloudTaskStreamResumeMemoryCheckpoint {
  checkpointId: string;
  eventCount: number;
  epoch: number;
  lastSequence: number;
  syncState: 'pending' | 'synchronized' | 'diverged' | 'failed';
}

export interface CloudTaskStreamResumeHandoff {
  handoffId: string;
  sourceLeaseId: string;
  sourceEpoch: number;
  suspendedAtSequence: number;
}

export interface CloudTaskStreamResumeStore {
  load(execution: CloudTaskStartedExecution): Promise<number>;
  save(
    execution: CloudTaskStartedExecution,
    lastSequence: number,
    handoff?: CloudTaskStreamResumeHandoff | null,
    context?: CloudTaskStreamResumeContext,
  ): Promise<void>;
  clear(execution: CloudTaskStartedExecution): Promise<void>;
  listPending(limit?: number): Promise<CloudTaskStreamResumeCheckpoint[]>;
  clearByExecutionId(executionId: string): Promise<void>;
}

export interface FileSystemCloudTaskStreamResumeStoreOptions {
  rootDirectory: string;
  now?: () => number;
}

/**
 * Stores only opaque task/execution/restore ids, the replay cursor, and timestamps.
 * Prompt, paths, logs, artifacts, credentials, URLs, and hashes are excluded.
 */
export class FileSystemCloudTaskStreamResumeStore
  implements CloudTaskStreamResumeStore
{
  private readonly rootDirectory: string;
  private readonly now: () => number;

  public constructor(options: FileSystemCloudTaskStreamResumeStoreOptions) {
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.now = options.now ?? Date.now;
  }

  public async load(execution: CloudTaskStartedExecution): Promise<number> {
    const checkpointPath = this.checkpointPath(execution.executionId);
    let text: string;
    try {
      text = await readFile(checkpointPath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) return 0;
      throw error;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_CHECKPOINT_BYTES) {
      await rm(checkpointPath, { force: true });
      return 0;
    }
    try {
      const value = JSON.parse(
        text,
      ) as Partial<CloudTaskStreamResumeCheckpoint>;
      if (
        !isSupportedVersion(value.version) ||
        value.taskId !== execution.taskId ||
        value.executionId !== execution.executionId ||
        value.restoreReceiptId !== execution.restoreReceiptId ||
        !isValidHandoff(value.handoff, value.lastSequence) ||
        !isValidCloudOwnership(value.cloudOwnership, value.handoff) ||
        !isValidMemoryCheckpoint(
          value.memoryCheckpoint,
          value.lastSequence,
          value.cloudOwnership,
          value.handoff,
        ) ||
        !Number.isSafeInteger(value.lastSequence) ||
        (value.lastSequence ?? -1) < 0 ||
        value.expiresAt !== execution.expiresAt ||
        execution.expiresAt <= this.now()
      ) {
        await rm(checkpointPath, { force: true });
        return 0;
      }
      return value.lastSequence ?? 0;
    } catch {
      await rm(checkpointPath, { force: true });
      return 0;
    }
  }

  public async save(
    execution: CloudTaskStartedExecution,
    lastSequence: number,
    handoff: CloudTaskStreamResumeHandoff | null = null,
    context: CloudTaskStreamResumeContext = {},
  ): Promise<void> {
    if (!Number.isSafeInteger(lastSequence) || lastSequence < 0) {
      throw new Error('Cloud task resume sequence is invalid');
    }
    if (!isOpaqueId(execution.restoreReceiptId)) {
      throw new Error('Cloud task restore receipt id is unavailable');
    }
    if (!isValidHandoff(handoff, lastSequence)) {
      throw new Error('Cloud task handoff checkpoint is invalid');
    }
    const cloudOwnership = context.cloudOwnership ?? null;
    if (!isValidCloudOwnership(cloudOwnership, handoff)) {
      throw new Error('Cloud task ownership checkpoint is invalid');
    }
    const memoryCheckpoint = context.memoryCheckpoint ?? null;
    if (
      !isValidMemoryCheckpoint(
        memoryCheckpoint,
        lastSequence,
        cloudOwnership,
        handoff,
      )
    ) {
      throw new Error('Cloud task memory checkpoint is invalid');
    }
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const checkpoint: CloudTaskStreamResumeCheckpoint = {
      version: CHECKPOINT_VERSION,
      taskId: execution.taskId,
      executionId: execution.executionId,
      restoreReceiptId: execution.restoreReceiptId,
      agentInstanceId: normalizeOptionalOpaqueId(context.agentInstanceId),
      handoff,
      cloudOwnership,
      memoryCheckpoint,
      lastSequence,
      expiresAt: execution.expiresAt,
      updatedAt: this.now(),
    };
    const checkpointPath = this.checkpointPath(execution.executionId);
    const temporaryPath = `${checkpointPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(checkpoint), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, checkpointPath);
  }

  public async clear(execution: CloudTaskStartedExecution): Promise<void> {
    await this.clearByExecutionId(execution.executionId);
  }

  public async listPending(
    limit = DEFAULT_MAX_PENDING_CHECKPOINTS,
  ): Promise<CloudTaskStreamResumeCheckpoint[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new Error('Cloud task resume checkpoint limit is invalid');
    }
    let names: string[];
    try {
      names = await readdir(this.rootDirectory);
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }

    const checkpoints: CloudTaskStreamResumeCheckpoint[] = [];
    for (const name of names.sort()) {
      if (checkpoints.length >= limit) break;
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const executionId = name.slice(0, -'.json'.length);
      if (!isOpaqueId(executionId)) {
        await rm(path.join(this.rootDirectory, name), { force: true });
        continue;
      }
      const checkpointPath = this.checkpointPath(executionId);
      const checkpoint = await this.readCheckpoint(checkpointPath);
      if (!checkpoint || checkpoint.expiresAt <= this.now()) {
        await rm(checkpointPath, { force: true });
        continue;
      }
      checkpoints.push(checkpoint);
    }
    return checkpoints.sort((a, b) => a.updatedAt - b.updatedAt);
  }

  public async clearByExecutionId(executionId: string): Promise<void> {
    await Promise.all([
      rm(this.checkpointPath(executionId), { force: true }),
      rm(`${this.checkpointPath(executionId)}.tmp`, { force: true }),
    ]);
  }

  private checkpointPath(executionId: string): string {
    if (!isOpaqueId(executionId)) {
      throw new Error('Cloud task execution id is invalid');
    }
    return path.join(this.rootDirectory, `${executionId}.json`);
  }

  private async readCheckpoint(
    checkpointPath: string,
  ): Promise<CloudTaskStreamResumeCheckpoint | null> {
    let text: string;
    try {
      text = await readFile(checkpointPath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_CHECKPOINT_BYTES) return null;
    try {
      const value = JSON.parse(
        text,
      ) as Partial<CloudTaskStreamResumeCheckpoint>;
      if (
        !isSupportedVersion(value.version) ||
        !isOpaqueId(value.taskId) ||
        !isOpaqueId(value.executionId) ||
        !isOpaqueId(value.restoreReceiptId) ||
        !isOptionalOpaqueId(value.agentInstanceId) ||
        !isValidHandoff(value.handoff, value.lastSequence) ||
        !isValidCloudOwnership(value.cloudOwnership, value.handoff) ||
        !isValidMemoryCheckpoint(
          value.memoryCheckpoint,
          value.lastSequence,
          value.cloudOwnership,
          value.handoff,
        ) ||
        !Number.isSafeInteger(value.lastSequence) ||
        (value.lastSequence ?? -1) < 0 ||
        !Number.isSafeInteger(value.expiresAt) ||
        !Number.isSafeInteger(value.updatedAt)
      ) {
        return null;
      }
      return {
        ...(value as Omit<
          CloudTaskStreamResumeCheckpoint,
          'version' | 'cloudOwnership' | 'memoryCheckpoint'
        >),
        version: CHECKPOINT_VERSION,
        agentInstanceId: value.agentInstanceId ?? null,
        cloudOwnership: value.cloudOwnership ?? null,
        memoryCheckpoint: value.memoryCheckpoint ?? null,
      };
    } catch {
      return null;
    }
  }
}

function isSupportedVersion(
  value: unknown,
): value is
  | typeof CHECKPOINT_VERSION
  | (typeof LEGACY_CHECKPOINT_VERSIONS)[number] {
  return (
    value === CHECKPOINT_VERSION ||
    (LEGACY_CHECKPOINT_VERSIONS as readonly number[]).includes(value as number)
  );
}

function isValidMemoryCheckpoint(
  value: unknown,
  lastSequence: unknown,
  ownership: unknown,
  handoff: unknown,
): value is CloudTaskStreamResumeMemoryCheckpoint | null | undefined {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const checkpoint = value as Partial<CloudTaskStreamResumeMemoryCheckpoint>;
  const expectedEpoch =
    handoff && typeof handoff === 'object'
      ? (handoff as Partial<CloudTaskStreamResumeHandoff>).sourceEpoch
      : ownership && typeof ownership === 'object'
        ? (ownership as Partial<CloudTaskStreamResumeOwnership>).epoch
        : undefined;
  return (
    isOpaqueId(checkpoint.checkpointId) &&
    Number.isSafeInteger(checkpoint.eventCount) &&
    (checkpoint.eventCount ?? -1) >= 0 &&
    Number.isSafeInteger(checkpoint.epoch) &&
    (checkpoint.epoch ?? 0) > 0 &&
    (expectedEpoch === undefined || checkpoint.epoch === expectedEpoch) &&
    Number.isSafeInteger(checkpoint.lastSequence) &&
    checkpoint.lastSequence === lastSequence &&
    (checkpoint.syncState === 'pending' ||
      checkpoint.syncState === 'synchronized' ||
      checkpoint.syncState === 'diverged' ||
      checkpoint.syncState === 'failed')
  );
}

function isValidCloudOwnership(
  value: unknown,
  handoff: unknown,
): value is CloudTaskStreamResumeOwnership | null | undefined {
  if (value === null || value === undefined) return true;
  if (handoff !== null) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ownership = value as Partial<CloudTaskStreamResumeOwnership>;
  return Number.isSafeInteger(ownership.epoch) && (ownership.epoch ?? 0) > 0;
}

function isValidHandoff(
  value: unknown,
  lastSequence: unknown,
): value is CloudTaskStreamResumeHandoff | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const handoff = value as Partial<CloudTaskStreamResumeHandoff>;
  return (
    isOpaqueId(handoff.handoffId) &&
    isOpaqueId(handoff.sourceLeaseId) &&
    Number.isSafeInteger(handoff.sourceEpoch) &&
    (handoff.sourceEpoch ?? 0) > 0 &&
    Number.isSafeInteger(handoff.suspendedAtSequence) &&
    handoff.suspendedAtSequence === lastSequence
  );
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
}

function isOptionalOpaqueId(
  value: unknown,
): value is string | null | undefined {
  return value === null || value === undefined || isOpaqueId(value);
}

function normalizeOptionalOpaqueId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!isOpaqueId(value)) {
    throw new Error('Cloud task agent instance id is invalid');
  }
  return value;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
