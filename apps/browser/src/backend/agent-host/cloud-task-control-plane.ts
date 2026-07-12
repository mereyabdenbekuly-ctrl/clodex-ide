import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type {
  EvidenceMemorySyncBatch,
  EvidenceMemorySyncCursor,
} from '@clodex/agent-core/evidence-memory';
import type { CloudTaskMemoryDivergenceResolution } from '@shared/cloud-task-memory-sync';
import {
  CloudTaskMemoryCompareAndSwapError,
  type CloudTaskMemoryAtomicMergeReceipt,
  type CloudTaskMemoryAtomicMergeRequest,
  type CloudTaskMemoryCheckpointIdentity,
} from './cloud-task-memory-atomic-sync';
import {
  isIsolatedAgentTurnResult,
  type IsolatedAgentTurnRequest,
  type IsolatedAgentTurnResult,
} from './isolated-agent-turn';
import type { CloudTaskSnapshotDescriptor } from './cloud-task-snapshot-packager';
import {
  CloudTaskExecutionLeaseError,
  type CloudTaskExecutionLease,
} from './cloud-task-execution-lease';
import type {
  CloudTaskExecutionHandoffReceipt,
  CloudTaskExecutionResumeResult,
} from './cloud-task-execution-handoff';
import {
  CloudTaskRestoreHandshakeError,
  type CloudTaskExecutionRestoreReceipt,
  type CloudTaskRestoreCheckpointBinding,
} from './cloud-task-restore-handshake';
import {
  cloudTaskCredentialScopes,
  type CloudDataResidency,
  type CloudTaskCredentialIssueRequest,
  type CloudTaskCredentialIssueResponse,
  type CloudTaskExecutionPolicy,
  type CloudTaskRecipientKey,
  type CloudTaskSecretBrokerTransport,
} from './cloud-task-security';

const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_STREAM_LINE_BYTES = 1024 * 1024;
const MAX_LOG_MESSAGE_LENGTH = 16_384;

export interface CloudTaskUploadSession {
  sessionId: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  expiresAt: number;
  residency: CloudDataResidency;
  maxBytes: number;
  maxFiles: number;
  recipientKey: CloudTaskRecipientKey;
}

export interface CloudTaskUploadedObject {
  sessionId: string;
  objectId: string;
  sha256: string;
}

export interface CloudTaskStartRequest {
  taskId: string;
  uploadSessionId: string;
  snapshotSha256: string;
  policy: CloudTaskExecutionPolicy;
  turn: IsolatedAgentTurnRequest;
}

export interface CloudTaskStartedExecution {
  executionId: string;
  taskId: string;
  streamUrl: string;
  cancelUrl: string;
  expiresAt: number;
  restoreReceiptId?: string;
}

export interface CloudTaskExecutionRestoreRequest {
  taskId: string;
  executionId: string;
  uploadSessionId: string;
  snapshotSha256: string;
  workspaceSnapshotHash: string;
  checkpoint: CloudTaskRestoreCheckpointBinding | null;
}

export interface CloudTaskExecutionLeaseAcquireRequest {
  taskId: string;
  executionId: string;
  holderId: string;
  checkpointId: string | null;
  restoreReceiptId: string;
}

export type CloudTaskExecutionStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface CloudTaskExecutionStatusResult {
  executionId: string;
  taskId: string;
  status: CloudTaskExecutionStatus;
  updatedAt: number;
}

export interface CloudTaskArtifactDescriptor {
  artifactId: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
  expiresAt: number;
}

export interface CloudTaskArtifactDownload {
  body: ReadableStream<Uint8Array>;
  startOffset: number;
  totalSize: number;
}

export type CloudTaskStreamEvent =
  | {
      sequence: number;
      executionId: string;
      type: 'chunk';
      chunk: Record<string, unknown>;
    }
  | {
      sequence: number;
      executionId: string;
      type: 'log';
      level: 'debug' | 'info' | 'warn' | 'error';
      message: string;
    }
  | {
      sequence: number;
      executionId: string;
      type: 'usage';
      durationMs: number;
      costMicros: number;
    }
  | {
      sequence: number;
      executionId: string;
      type: 'artifact';
      artifact: CloudTaskArtifactDescriptor;
    }
  | {
      sequence: number;
      executionId: string;
      type: 'completed';
      result: IsolatedAgentTurnResult;
    }
  | {
      sequence: number;
      executionId: string;
      type: 'failed';
      reason: string;
    }
  | {
      sequence: number;
      executionId: string;
      type: 'cancelled';
    }
  | {
      sequence: number;
      executionId: string;
      type: 'suspended';
      handoffId: string;
    };

export interface CloudTaskControlPlane extends CloudTaskSecretBrokerTransport {
  createUploadSession(
    input: {
      taskId: string;
      residency: CloudDataResidency;
      selectedEntryCount: number;
      policy: CloudTaskExecutionPolicy;
    },
    accountAccessToken: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskUploadSession>;
  uploadSnapshot(
    session: CloudTaskUploadSession,
    snapshot: CloudTaskSnapshotDescriptor,
    signal?: AbortSignal,
  ): Promise<CloudTaskUploadedObject>;
  startExecution(
    request: CloudTaskStartRequest,
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskStartedExecution>;
  pushEvidenceMemory?(
    input: {
      taskId: string;
      execution: CloudTaskStartedExecution;
      batch: EvidenceMemorySyncBatch;
    },
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<{ checkpointId: string; eventCount: number }>;
  commitEvidenceMemoryAtomicMerge?(
    input: {
      taskId: string;
      execution: CloudTaskStartedExecution;
      request: CloudTaskMemoryAtomicMergeRequest;
    },
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskMemoryAtomicMergeReceipt>;
  pullEvidenceMemory?(
    input: {
      taskId: string;
      execution: CloudTaskStartedExecution;
      cursor: EvidenceMemorySyncCursor | null;
    },
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<EvidenceMemorySyncBatch>;
  resolveEvidenceMemoryDivergence?(
    input: {
      taskId: string;
      execution: CloudTaskStartedExecution;
      strategy: CloudTaskMemoryDivergenceResolution;
    },
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<void>;
  confirmExecutionRestore?(
    request: CloudTaskExecutionRestoreRequest,
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskExecutionRestoreReceipt>;
  acquireExecutionLease?(
    request: CloudTaskExecutionLeaseAcquireRequest,
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskExecutionLease>;
  renewExecutionLease?(
    lease: CloudTaskExecutionLease,
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskExecutionLease>;
  releaseExecutionLease?(
    lease: CloudTaskExecutionLease,
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<void>;
  suspendExecution?(
    execution: CloudTaskStartedExecution,
    lease: CloudTaskExecutionLease,
    afterSequence: number,
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskExecutionHandoffReceipt>;
  resumeExecution?(
    handoff: CloudTaskExecutionHandoffReceipt,
    holderId: string,
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskExecutionResumeResult>;
  streamExecution(
    execution: CloudTaskStartedExecution,
    taskCredential: string,
    afterSequence: number,
    signal?: AbortSignal,
    lease?: CloudTaskExecutionLease,
  ): AsyncIterable<CloudTaskStreamEvent>;
  getExecutionStatus(
    taskId: string,
    executionId: string,
    taskCredential: string,
    signal?: AbortSignal,
    lease?: CloudTaskExecutionLease,
  ): Promise<CloudTaskExecutionStatusResult>;
  cancelExecution(
    execution: CloudTaskStartedExecution,
    taskCredential: string,
    signal?: AbortSignal,
    lease?: CloudTaskExecutionLease,
  ): Promise<void>;
  cancelExecutionById(
    taskId: string,
    executionId: string,
    taskCredential: string,
    signal?: AbortSignal,
    lease?: CloudTaskExecutionLease,
  ): Promise<void>;
  downloadArtifact(
    artifact: CloudTaskArtifactDescriptor,
    taskCredential: string,
    offset: number,
    signal?: AbortSignal,
  ): Promise<CloudTaskArtifactDownload>;
}

export interface HttpCloudTaskControlPlaneOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class HttpCloudTaskControlPlane implements CloudTaskControlPlane {
  private readonly baseUrl: URL;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  public constructor(options: HttpCloudTaskControlPlaneOptions) {
    this.baseUrl = validateHttpsUrl(options.baseUrl, 'cloud task base URL');
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  public async createUploadSession(
    input: {
      taskId: string;
      residency: CloudDataResidency;
      selectedEntryCount: number;
      policy: CloudTaskExecutionPolicy;
    },
    accountAccessToken: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskUploadSession> {
    const payload = await this.requestJson(
      new URL('/v1/cloud-tasks/upload-sessions', this.baseUrl),
      {
        method: 'POST',
        headers: bearerJsonHeaders(accountAccessToken),
        body: JSON.stringify({
          taskId: input.taskId,
          residency: input.residency,
          selectedEntryCount: input.selectedEntryCount,
          quotas: {
            maxBytes: input.policy.maxSnapshotBytes,
            maxFiles: input.policy.maxSnapshotFiles,
          },
        }),
        signal,
      },
    );
    return parseUploadSession(payload, this.now(), input);
  }

  public async uploadSnapshot(
    session: CloudTaskUploadSession,
    snapshot: CloudTaskSnapshotDescriptor,
    signal?: AbortSignal,
  ): Promise<CloudTaskUploadedObject> {
    if (snapshot.archive.sizeBytes > session.maxBytes) {
      throw new Error('Cloud task snapshot exceeds upload-session byte quota');
    }
    if (snapshot.manifest.entries.length > session.maxFiles) {
      throw new Error('Cloud task snapshot exceeds upload-session file quota');
    }
    const uploadUrl = validateHttpsUrl(
      session.uploadUrl,
      'cloud task upload URL',
    );
    const headers = sanitizeUploadHeaders(session.uploadHeaders);
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Length', String(snapshot.archive.sizeBytes));
    headers.set('X-Clodex-SHA256', snapshot.archive.sha256);
    const body = Readable.toWeb(
      createReadStream(snapshot.archive.path),
    ) as ReadableStream<Uint8Array>;
    const response = await this.fetchFn(uploadUrl, {
      method: 'PUT',
      headers,
      body,
      signal,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    if (!response.ok) {
      throw new Error(`Cloud task snapshot upload failed (${response.status})`);
    }
    const acknowledgedHash = response.headers.get('x-clodex-sha256');
    if (acknowledgedHash !== snapshot.archive.sha256) {
      throw new Error('Cloud task upload integrity acknowledgement mismatch');
    }
    const objectId = response.headers.get('x-clodex-object-id')?.trim();
    if (!objectId || !isOpaqueId(objectId)) {
      throw new Error('Cloud task upload object id is invalid');
    }
    return {
      sessionId: session.sessionId,
      objectId,
      sha256: acknowledgedHash,
    };
  }

  public async issueCredential(
    request: CloudTaskCredentialIssueRequest,
    accountAccessToken: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskCredentialIssueResponse> {
    const payload = await this.requestJson(
      new URL('/v1/cloud-tasks/credentials', this.baseUrl),
      {
        method: 'POST',
        headers: bearerJsonHeaders(accountAccessToken),
        body: JSON.stringify(request),
        signal,
      },
    );
    return parseCredentialResponse(payload);
  }

  public async revokeCredential(
    credentialId: string,
    accountAccessToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = new URL(
      `/v1/cloud-tasks/credentials/${encodeURIComponent(credentialId)}/revoke`,
      this.baseUrl,
    );
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accountAccessToken}`,
        Accept: 'application/json',
      },
      signal,
    });
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new Error(
        `Cloud task credential revoke failed (${response.status})`,
      );
    }
  }

  public async startExecution(
    request: CloudTaskStartRequest,
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskStartedExecution> {
    const payload = await this.requestJson(
      new URL('/v1/cloud-tasks/executions', this.baseUrl),
      {
        method: 'POST',
        headers: bearerJsonHeaders(taskCredential),
        body: JSON.stringify(request),
        signal,
      },
    );
    return parseStartedExecution(
      payload,
      this.baseUrl,
      request.taskId,
      this.now(),
    );
  }

  public async pushEvidenceMemory(
    input: {
      taskId: string;
      execution: CloudTaskStartedExecution;
      batch: EvidenceMemorySyncBatch;
    },
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<{ checkpointId: string; eventCount: number }> {
    const taskId = requireOpaqueId(input.taskId, 'task id');
    const executionId = requireOpaqueId(
      input.execution.executionId,
      'execution id',
    );
    const payload = await this.requestJson(
      new URL(
        `/v1/cloud-tasks/executions/${encodeURIComponent(executionId)}/evidence-memory/push`,
        this.baseUrl,
      ),
      {
        method: 'POST',
        headers: bearerJsonHeaders(taskCredential),
        body: JSON.stringify({ taskId, batch: input.batch }),
        signal,
      },
    );
    return parseEvidenceMemoryPushReceipt(payload);
  }

  public async pullEvidenceMemory(
    input: {
      taskId: string;
      execution: CloudTaskStartedExecution;
      cursor: EvidenceMemorySyncCursor | null;
    },
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<EvidenceMemorySyncBatch> {
    const taskId = requireOpaqueId(input.taskId, 'task id');
    const executionId = requireOpaqueId(
      input.execution.executionId,
      'execution id',
    );
    const url = new URL(
      `/v1/cloud-tasks/executions/${encodeURIComponent(executionId)}/evidence-memory/pull`,
      this.baseUrl,
    );
    url.searchParams.set('taskId', taskId);
    if (input.cursor) {
      url.searchParams.set('afterTimestamp', String(input.cursor.timestamp));
      url.searchParams.set('afterEventId', input.cursor.eventId);
    }
    const payload = await this.requestJson(url, {
      method: 'GET',
      headers: bearerJsonHeaders(taskCredential),
      signal,
    });
    return parseEvidenceMemorySyncBatch(payload, taskId);
  }

  public async commitEvidenceMemoryAtomicMerge(
    input: {
      taskId: string;
      execution: CloudTaskStartedExecution;
      request: CloudTaskMemoryAtomicMergeRequest;
    },
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskMemoryAtomicMergeReceipt> {
    const taskId = requireOpaqueId(input.taskId, 'task id');
    const executionId = requireOpaqueId(
      input.execution.executionId,
      'execution id',
    );
    if (
      input.request.version !== 1 ||
      input.request.taskId !== taskId ||
      input.request.batches.length === 0 ||
      input.request.batches.length > 1_000
    ) {
      throw new Error('Cloud evidence memory atomic merge request is invalid');
    }
    const url = validateSameOriginUrl(
      new URL(
        `/v1/cloud-tasks/executions/${encodeURIComponent(executionId)}/evidence-memory/merge`,
        this.baseUrl,
      ).toString(),
      this.baseUrl,
      'cloud task API URL',
    );
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        ...bearerJsonHeaders(taskCredential),
        'Idempotency-Key': input.request.mutationId,
      },
      body: JSON.stringify(input.request),
      signal,
    });
    const text = await readBoundedText(response, MAX_JSON_RESPONSE_BYTES);
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error('Cloud task API returned invalid JSON');
      }
    }
    if (response.status === 409) {
      throw new CloudTaskMemoryCompareAndSwapError(
        input.request.expectedRemoteCheckpoint,
        parseOptionalCheckpointIdentity(payload),
      );
    }
    if (response.status === 412) {
      throw new CloudTaskExecutionLeaseError('stale-fencing-token');
    }
    if (!response.ok) {
      throw new Error(`Cloud task API request failed (${response.status})`);
    }
    return parseEvidenceMemoryAtomicMergeReceipt(payload);
  }

  public async resolveEvidenceMemoryDivergence(
    input: {
      taskId: string;
      execution: CloudTaskStartedExecution;
      strategy: CloudTaskMemoryDivergenceResolution;
    },
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const taskId = requireOpaqueId(input.taskId, 'task id');
    const executionId = requireOpaqueId(
      input.execution.executionId,
      'execution id',
    );
    if (input.strategy !== 'keep-local' && input.strategy !== 'accept-cloud') {
      throw new Error('Cloud evidence memory resolution is invalid');
    }
    await this.requestJson(
      new URL(
        `/v1/cloud-tasks/executions/${encodeURIComponent(executionId)}/evidence-memory/resolve`,
        this.baseUrl,
      ),
      {
        method: 'POST',
        headers: bearerJsonHeaders(taskCredential),
        body: JSON.stringify({ taskId, strategy: input.strategy }),
        signal,
      },
    );
  }

  public async confirmExecutionRestore(
    request: CloudTaskExecutionRestoreRequest,
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskExecutionRestoreReceipt> {
    const taskId = requireOpaqueId(request.taskId, 'task id');
    const executionId = requireOpaqueId(request.executionId, 'execution id');
    const uploadSessionId = requireOpaqueId(
      request.uploadSessionId,
      'upload session id',
    );
    const snapshotSha256 = requireSha256(
      request.snapshotSha256,
      'snapshot SHA-256',
    );
    const workspaceSnapshotHash = requireSha256(
      request.workspaceSnapshotHash,
      'workspace snapshot hash',
    );
    const payload = await this.requestJson(
      new URL(
        `/v1/cloud-tasks/executions/${encodeURIComponent(executionId)}/restore-handshake`,
        this.baseUrl,
      ),
      {
        method: 'POST',
        headers: bearerJsonHeaders(taskCredential),
        body: JSON.stringify({
          taskId,
          uploadSessionId,
          snapshotSha256,
          workspaceSnapshotHash,
          checkpoint: request.checkpoint,
        }),
        signal,
      },
    );
    return parseExecutionRestoreReceipt(payload, {
      taskId,
      executionId,
      uploadSessionId,
      snapshotSha256,
      workspaceSnapshotHash,
      checkpoint: request.checkpoint,
      now: this.now(),
    });
  }

  public async acquireExecutionLease(
    request: CloudTaskExecutionLeaseAcquireRequest,
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskExecutionLease> {
    const taskId = requireOpaqueId(request.taskId, 'task id');
    const executionId = requireOpaqueId(request.executionId, 'execution id');
    const holderId = requireOpaqueId(request.holderId, 'lease holder id');
    const restoreReceiptId = requireOpaqueId(
      request.restoreReceiptId,
      'restore receipt id',
    );
    const checkpointId =
      request.checkpointId === null
        ? null
        : requireOpaqueId(request.checkpointId, 'checkpoint id');
    const payload = await this.requestJson(
      new URL(
        `/v1/cloud-tasks/executions/${encodeURIComponent(executionId)}/lease`,
        this.baseUrl,
      ),
      {
        method: 'POST',
        headers: bearerJsonHeaders(taskCredential),
        body: JSON.stringify({
          taskId,
          holderId,
          checkpointId,
          restoreReceiptId,
        }),
        signal,
      },
    );
    return parseExecutionLease(payload, {
      taskId,
      executionId,
      holderId,
      restoreReceiptId,
      now: this.now(),
    });
  }

  public async renewExecutionLease(
    lease: CloudTaskExecutionLease,
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskExecutionLease> {
    const payload = await this.requestJson(
      new URL(
        `/v1/cloud-tasks/execution-leases/${encodeURIComponent(lease.leaseId)}/renew`,
        this.baseUrl,
      ),
      {
        method: 'POST',
        headers: fencingJsonHeaders(taskCredential, lease),
        body: JSON.stringify({
          taskId: lease.taskId,
          executionId: lease.executionId,
          restoreReceiptId: lease.restoreReceiptId,
          holderId: lease.holderId,
          epoch: lease.epoch,
        }),
        signal,
      },
    );
    return parseExecutionLease(payload, {
      taskId: lease.taskId,
      executionId: lease.executionId,
      restoreReceiptId: lease.restoreReceiptId,
      holderId: lease.holderId,
      expectedEpoch: lease.epoch,
      expectedFencingToken: lease.fencingToken,
      now: this.now(),
    });
  }

  public async releaseExecutionLease(
    lease: CloudTaskExecutionLease,
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchFn(
      new URL(
        `/v1/cloud-tasks/execution-leases/${encodeURIComponent(lease.leaseId)}/release`,
        this.baseUrl,
      ),
      {
        method: 'POST',
        headers: fencingJsonHeaders(taskCredential, lease),
        body: JSON.stringify({
          taskId: lease.taskId,
          executionId: lease.executionId,
          restoreReceiptId: lease.restoreReceiptId,
          holderId: lease.holderId,
          epoch: lease.epoch,
        }),
        signal,
      },
    );
    if (response.status === 412) {
      throw new CloudTaskExecutionLeaseError('stale-fencing-token');
    }
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new Error(
        `Cloud task execution lease release failed (${response.status})`,
      );
    }
  }

  public async suspendExecution(
    execution: CloudTaskStartedExecution,
    lease: CloudTaskExecutionLease,
    afterSequence: number,
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskExecutionHandoffReceipt> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error('Cloud task handoff sequence is invalid');
    }
    const payload = await this.requestJson(
      new URL(
        `/v1/cloud-tasks/executions/${encodeURIComponent(execution.executionId)}/handoffs/suspend`,
        this.baseUrl,
      ),
      {
        method: 'POST',
        headers: fencingJsonHeaders(taskCredential, lease),
        body: JSON.stringify({
          taskId: execution.taskId,
          restoreReceiptId: lease.restoreReceiptId,
          afterSequence,
        }),
        signal,
      },
    );
    return parseExecutionHandoffReceipt(payload, {
      execution,
      lease,
      afterSequence,
      now: this.now(),
    });
  }

  public async resumeExecution(
    handoff: CloudTaskExecutionHandoffReceipt,
    holderId: string,
    taskCredential: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskExecutionResumeResult> {
    const normalizedHolderId = requireOpaqueId(holderId, 'lease holder id');
    const payload = await this.requestJson(
      new URL(
        `/v1/cloud-tasks/execution-handoffs/${encodeURIComponent(handoff.handoffId)}/resume`,
        this.baseUrl,
      ),
      {
        method: 'POST',
        headers: bearerJsonHeaders(taskCredential),
        body: JSON.stringify({
          taskId: handoff.taskId,
          executionId: handoff.executionId,
          restoreReceiptId: handoff.restoreReceiptId,
          sourceLeaseId: handoff.sourceLeaseId,
          sourceEpoch: handoff.sourceEpoch,
          resumeAfterSequence: handoff.suspendedAtSequence,
          holderId: normalizedHolderId,
        }),
        signal,
      },
    );
    return parseExecutionResumeResult(payload, {
      handoff,
      holderId: normalizedHolderId,
      baseUrl: this.baseUrl,
      now: this.now(),
    });
  }

  public async *streamExecution(
    execution: CloudTaskStartedExecution,
    taskCredential: string,
    afterSequence: number,
    signal?: AbortSignal,
    lease?: CloudTaskExecutionLease,
  ): AsyncIterable<CloudTaskStreamEvent> {
    const url = validateSameOriginUrl(
      execution.streamUrl,
      this.baseUrl,
      'cloud task stream URL',
    );
    url.searchParams.set('after', String(afterSequence));
    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: {
        ...(lease
          ? fencingHeaders(taskCredential, lease)
          : { Authorization: `Bearer ${taskCredential}` }),
        Accept: 'application/x-ndjson',
      },
      signal,
    });
    throwIfFencingRejected(response);
    if (!response.ok || !response.body) {
      throw new Error(`Cloud task stream failed (${response.status})`);
    }

    let lastSequence = afterSequence;
    for await (const value of readNdjson(response.body, signal)) {
      const event = parseStreamEvent(
        value,
        execution.executionId,
        this.baseUrl,
        this.now(),
      );
      if (event.sequence <= lastSequence) {
        throw new Error('Cloud task stream sequence is not monotonic');
      }
      lastSequence = event.sequence;
      yield event;
    }
  }

  public async getExecutionStatus(
    taskId: string,
    executionId: string,
    taskCredential: string,
    signal?: AbortSignal,
    lease?: CloudTaskExecutionLease,
  ): Promise<CloudTaskExecutionStatusResult> {
    const normalizedTaskId = requireOpaqueId(taskId, 'task id');
    const normalizedExecutionId = requireOpaqueId(executionId, 'execution id');
    const payload = await this.requestJson(
      new URL(
        `/v1/cloud-tasks/executions/${encodeURIComponent(normalizedExecutionId)}`,
        this.baseUrl,
      ),
      {
        method: 'GET',
        headers: {
          ...(lease
            ? fencingHeaders(taskCredential, lease)
            : { Authorization: `Bearer ${taskCredential}` }),
          Accept: 'application/json',
        },
        signal,
      },
    );
    return parseExecutionStatus(
      payload,
      normalizedTaskId,
      normalizedExecutionId,
    );
  }

  public async cancelExecution(
    execution: CloudTaskStartedExecution,
    taskCredential: string,
    signal?: AbortSignal,
    lease?: CloudTaskExecutionLease,
  ): Promise<void> {
    const url = validateSameOriginUrl(
      execution.cancelUrl,
      this.baseUrl,
      'cloud task cancel URL',
    );
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        ...(lease
          ? fencingHeaders(taskCredential, lease)
          : { Authorization: `Bearer ${taskCredential}` }),
        Accept: 'application/json',
      },
      signal,
    });
    throwIfFencingRejected(response);
    if (!response.ok && response.status !== 409 && response.status !== 410) {
      throw new Error(`Cloud task cancellation failed (${response.status})`);
    }
  }

  public async cancelExecutionById(
    taskId: string,
    executionId: string,
    taskCredential: string,
    signal?: AbortSignal,
    lease?: CloudTaskExecutionLease,
  ): Promise<void> {
    requireOpaqueId(taskId, 'task id');
    const normalizedExecutionId = requireOpaqueId(executionId, 'execution id');
    const url = new URL(
      `/v1/cloud-tasks/executions/${encodeURIComponent(normalizedExecutionId)}/cancel`,
      this.baseUrl,
    );
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        ...(lease
          ? fencingHeaders(taskCredential, lease)
          : { Authorization: `Bearer ${taskCredential}` }),
        Accept: 'application/json',
      },
      signal,
    });
    throwIfFencingRejected(response);
    if (!response.ok && response.status !== 409 && response.status !== 410) {
      throw new Error(`Cloud task cancellation failed (${response.status})`);
    }
  }

  public async downloadArtifact(
    artifact: CloudTaskArtifactDescriptor,
    taskCredential: string,
    offset: number,
    signal?: AbortSignal,
  ): Promise<CloudTaskArtifactDownload> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > artifact.sizeBytes
    ) {
      throw new Error('Cloud task artifact resume offset is invalid');
    }
    const url = validateSameOriginUrl(
      artifact.downloadUrl,
      this.baseUrl,
      'cloud task artifact URL',
    );
    const headers = new Headers({
      Authorization: `Bearer ${taskCredential}`,
      Accept: 'application/octet-stream',
      'Accept-Encoding': 'identity',
    });
    if (offset > 0) headers.set('Range', `bytes=${offset}-`);
    const response = await this.fetchFn(url, {
      method: 'GET',
      headers,
      signal,
      redirect: 'error',
    });
    if (!response.ok || !response.body) {
      throw new Error(
        `Cloud task artifact download failed (${response.status})`,
      );
    }
    const contentEncoding = response.headers.get('content-encoding');
    if (contentEncoding && contentEncoding !== 'identity') {
      throw new Error('Cloud task artifact download must not be transformed');
    }
    const acknowledgedHash = response.headers.get('x-clodex-sha256');
    if (acknowledgedHash !== artifact.sha256) {
      throw new Error('Cloud task artifact integrity acknowledgement mismatch');
    }
    const range = parseDownloadRange(response, offset, artifact.sizeBytes);
    return {
      body: response.body,
      startOffset: range.start,
      totalSize: range.total,
    };
  }

  private async requestJson(url: URL, init: RequestInit): Promise<unknown> {
    const target = validateSameOriginUrl(
      url.toString(),
      this.baseUrl,
      'cloud task API URL',
    );
    const response = await this.fetchFn(target, init);
    const text = await readBoundedText(response, MAX_JSON_RESPONSE_BYTES);
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error('Cloud task API returned invalid JSON');
      }
    }
    if (!response.ok) {
      if (response.status === 409) {
        throw new CloudTaskExecutionLeaseError('conflict');
      }
      if (response.status === 412) {
        throw new CloudTaskExecutionLeaseError('stale-fencing-token');
      }
      throw new Error(`Cloud task API request failed (${response.status})`);
    }
    return payload;
  }
}

function parseUploadSession(
  value: unknown,
  now: number,
  request: {
    residency: CloudDataResidency;
    policy: CloudTaskExecutionPolicy;
  },
): CloudTaskUploadSession {
  const record = requireRecord(value, 'upload session');
  const sessionId = requireOpaqueId(record.sessionId, 'upload session id');
  const residency = requireResidency(record.residency);
  const expiresAt = requireFutureTimestamp(record.expiresAt, now, 30 * 60_000);
  const maxBytes = requirePositiveInteger(record.maxBytes, 'upload byte quota');
  const maxFiles = requirePositiveInteger(record.maxFiles, 'upload file quota');
  if (residency !== request.residency) {
    throw new Error('Cloud task upload session violates local policy');
  }
  const recipient = requireRecord(record.recipientKey, 'recipient key');
  return {
    sessionId,
    uploadUrl: validateHttpsUrl(
      requireString(record.uploadUrl, 'upload URL'),
      'cloud task upload URL',
    ).toString(),
    uploadHeaders: requireStringRecord(record.uploadHeaders, 'upload headers'),
    expiresAt,
    residency,
    maxBytes: Math.min(maxBytes, request.policy.maxSnapshotBytes),
    maxFiles: Math.min(maxFiles, request.policy.maxSnapshotFiles),
    recipientKey: {
      algorithm: requireLiteral(recipient.algorithm, 'p256', 'key algorithm'),
      keyId: requireOpaqueId(recipient.keyId, 'recipient key id'),
      publicKeySpki: requireString(
        recipient.publicKeySpki,
        'recipient public key',
      ),
      expiresAt: requireFutureTimestamp(recipient.expiresAt, now, 30 * 60_000),
    },
  };
}

function parseCredentialResponse(
  value: unknown,
): CloudTaskCredentialIssueResponse {
  const record = requireRecord(value, 'credential response');
  const rawScopes = Array.isArray(record.scopes) ? record.scopes : [];
  const allowedScopes = new Set<string>(cloudTaskCredentialScopes);
  const scopes = rawScopes.map((scope) => {
    if (typeof scope !== 'string' || !allowedScopes.has(scope)) {
      throw new Error('Cloud task credential response scope is invalid');
    }
    return scope as CloudTaskCredentialIssueResponse['scopes'][number];
  });
  return {
    credentialId: requireOpaqueId(record.credentialId, 'credential id'),
    taskId: requireOpaqueId(record.taskId, 'credential task id'),
    audience: requireString(record.audience, 'credential audience'),
    residency: requireResidency(record.residency),
    scopes,
    token: requireString(record.token, 'credential token'),
    issuedAt: requireInteger(record.issuedAt, 'credential issue time'),
    expiresAt: requireInteger(record.expiresAt, 'credential expiry time'),
  };
}

function parseStartedExecution(
  value: unknown,
  baseUrl: URL,
  taskId: string,
  now: number,
): CloudTaskStartedExecution {
  const record = requireRecord(value, 'started execution');
  if (record.taskId !== taskId) {
    throw new Error('Cloud task execution id binding mismatch');
  }
  return {
    executionId: requireOpaqueId(record.executionId, 'execution id'),
    taskId,
    streamUrl: validateSameOriginUrl(
      requireString(record.streamUrl, 'stream URL'),
      baseUrl,
      'cloud task stream URL',
    ).toString(),
    cancelUrl: validateSameOriginUrl(
      requireString(record.cancelUrl, 'cancel URL'),
      baseUrl,
      'cloud task cancel URL',
    ).toString(),
    expiresAt: requireFutureTimestamp(record.expiresAt, now, 24 * 60 * 60_000),
  };
}

function parseExecutionRestoreReceipt(
  value: unknown,
  expected: CloudTaskExecutionRestoreRequest & { now: number },
): CloudTaskExecutionRestoreReceipt {
  const record = requireRecord(value, 'execution restore receipt');
  const checkpoint = expected.checkpoint;
  if (
    record.taskId !== expected.taskId ||
    record.executionId !== expected.executionId ||
    record.uploadSessionId !== expected.uploadSessionId ||
    record.snapshotSha256 !== expected.snapshotSha256 ||
    record.workspaceSnapshotHash !== expected.workspaceSnapshotHash ||
    record.checkpointId !== (checkpoint?.checkpointId ?? null) ||
    record.historyContentHash !== (checkpoint?.historyContentHash ?? null) ||
    record.workspaceRevisionHash !==
      (checkpoint?.workspaceRevisionHash ?? null) ||
    (record.memoryCheckpointId ?? null) !==
      (checkpoint?.memoryCheckpointId ?? null) ||
    (record.memoryLedgerHash ?? null) !==
      (checkpoint?.memoryLedgerHash ?? null) ||
    (record.memoryEventCount ?? null) !== (checkpoint?.memoryEventCount ?? null)
  ) {
    throw new CloudTaskRestoreHandshakeError('restore-mismatch');
  }
  const restoredAt = requireNonNegativeInteger(
    record.restoredAt,
    'restore completion time',
  );
  if (restoredAt > expected.now + 60_000) {
    throw new CloudTaskRestoreHandshakeError('restore-mismatch');
  }
  return {
    restoreReceiptId: requireOpaqueId(
      record.restoreReceiptId,
      'restore receipt id',
    ),
    taskId: expected.taskId,
    executionId: expected.executionId,
    uploadSessionId: expected.uploadSessionId,
    snapshotSha256: expected.snapshotSha256,
    workspaceSnapshotHash: expected.workspaceSnapshotHash,
    checkpointId: checkpoint?.checkpointId ?? null,
    historyContentHash: checkpoint?.historyContentHash ?? null,
    workspaceRevisionHash: checkpoint?.workspaceRevisionHash ?? null,
    memoryCheckpointId: checkpoint?.memoryCheckpointId ?? null,
    memoryLedgerHash: checkpoint?.memoryLedgerHash ?? null,
    memoryEventCount: checkpoint?.memoryEventCount ?? null,
    restoredAt,
  };
}

function parseEvidenceMemoryPushReceipt(value: unknown): {
  checkpointId: string;
  eventCount: number;
} {
  const record = requireRecord(value, 'evidence memory push receipt');
  return {
    checkpointId: requireOpaqueId(record.checkpointId, 'memory checkpoint id'),
    eventCount: requireNonNegativeInteger(
      record.eventCount,
      'memory event count',
    ),
  };
}

function parseEvidenceMemoryAtomicMergeReceipt(
  value: unknown,
): CloudTaskMemoryAtomicMergeReceipt {
  const record = requireRecord(value, 'evidence memory atomic merge receipt');
  if (record.version !== 1 || typeof record.replayed !== 'boolean') {
    throw new Error('Cloud evidence memory atomic merge receipt is invalid');
  }
  return {
    version: 1,
    mutationId: requireOpaqueId(record.mutationId, 'memory atomic mutation id'),
    replayed: record.replayed,
    previousCheckpoint: parseCheckpointIdentity(
      record.previousCheckpoint,
      'previous memory checkpoint',
    ),
    checkpoint: parseCheckpointIdentity(
      record.checkpoint,
      'committed memory checkpoint',
    ),
    importedEvents: requireNonNegativeInteger(
      record.importedEvents,
      'memory imported event count',
    ),
    duplicateEvents: requireNonNegativeInteger(
      record.duplicateEvents,
      'memory duplicate event count',
    ),
    committedAt: requireNonNegativeInteger(
      record.committedAt,
      'memory commit timestamp',
    ),
  };
}

function parseOptionalCheckpointIdentity(
  value: unknown,
): CloudTaskMemoryCheckpointIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const candidate = record.actualCheckpoint ?? record.checkpoint;
  try {
    return parseCheckpointIdentity(candidate, 'actual memory checkpoint');
  } catch {
    return null;
  }
}

function parseCheckpointIdentity(
  value: unknown,
  label: string,
): CloudTaskMemoryCheckpointIdentity {
  const record = requireRecord(value, label);
  return {
    checkpointId: requireOpaqueId(record.checkpointId, `${label} id`),
    eventCount: requireNonNegativeInteger(
      record.eventCount,
      `${label} event count`,
    ),
  };
}

function parseEvidenceMemorySyncBatch(
  value: unknown,
  expectedTaskId: string,
): EvidenceMemorySyncBatch {
  const record = requireRecord(value, 'evidence memory sync batch');
  if (
    record.version !== 1 ||
    record.taskId !== expectedTaskId ||
    !Array.isArray(record.events) ||
    record.events.length > 500
  ) {
    throw new Error('Cloud evidence memory sync batch is invalid');
  }
  const events = record.events.map((value) => {
    const envelope = requireRecord(value, 'evidence memory event envelope');
    if (envelope.version !== 1) {
      throw new Error('Cloud evidence memory event envelope is invalid');
    }
    const event = requireRecord(envelope.event, 'evidence memory event');
    if (event.taskId !== expectedTaskId) {
      throw new Error('Cloud evidence memory event task binding is invalid');
    }
    return {
      version: 1 as const,
      event,
    } as unknown as EvidenceMemorySyncBatch['events'][number];
  });
  const nextCursor =
    record.nextCursor === null
      ? null
      : (() => {
          const cursor = requireRecord(
            record.nextCursor,
            'evidence memory sync cursor',
          );
          return {
            timestamp: requireNonNegativeInteger(
              cursor.timestamp,
              'memory cursor timestamp',
            ),
            eventId: requireOpaqueId(cursor.eventId, 'memory cursor event id'),
          };
        })();
  return {
    version: 1,
    taskId: expectedTaskId,
    baseCheckpoint: parseEvidenceMemoryCheckpoint(
      record.baseCheckpoint,
      expectedTaskId,
    ),
    targetCheckpoint: parseEvidenceMemoryCheckpoint(
      record.targetCheckpoint,
      expectedTaskId,
    ),
    events,
    nextCursor,
  };
}

function parseEvidenceMemoryCheckpoint(
  value: unknown,
  expectedTaskId: string,
): EvidenceMemorySyncBatch['targetCheckpoint'] {
  const record = requireRecord(value, 'evidence memory checkpoint');
  if (record.version !== 1 || record.taskId !== expectedTaskId) {
    throw new Error('Cloud evidence memory checkpoint binding is invalid');
  }
  return {
    version: 1,
    checkpointId: requireOpaqueId(record.checkpointId, 'memory checkpoint id'),
    taskId: expectedTaskId,
    eventCount: requireNonNegativeInteger(
      record.eventCount,
      'memory event count',
    ),
    headEventId:
      record.headEventId === null
        ? null
        : requireOpaqueId(record.headEventId, 'memory head event id'),
    headTimestamp:
      record.headTimestamp === null
        ? null
        : requireNonNegativeInteger(
            record.headTimestamp,
            'memory head timestamp',
          ),
    ledgerHash: requireSha256(record.ledgerHash, 'memory ledger hash'),
    createdAt: requireNonNegativeInteger(
      record.createdAt,
      'memory checkpoint creation time',
    ),
  };
}

function parseExecutionLease(
  value: unknown,
  expected: {
    taskId: string;
    executionId: string;
    restoreReceiptId: string;
    holderId: string;
    expectedEpoch?: number;
    expectedFencingToken?: string;
    now: number;
  },
): CloudTaskExecutionLease {
  const record = requireRecord(value, 'execution lease');
  if (
    record.taskId !== expected.taskId ||
    record.executionId !== expected.executionId ||
    record.restoreReceiptId !== expected.restoreReceiptId ||
    record.holderId !== expected.holderId
  ) {
    throw new CloudTaskExecutionLeaseError(
      'invalid',
      'Cloud task execution lease binding mismatch',
    );
  }
  const epoch = requirePositiveInteger(record.epoch, 'lease epoch');
  const fencingToken = requireOpaqueId(
    record.fencingToken,
    'lease fencing token',
  );
  if (
    expected.expectedEpoch !== undefined &&
    epoch !== expected.expectedEpoch
  ) {
    throw new CloudTaskExecutionLeaseError(
      'stale-fencing-token',
      'Cloud task lease renewal changed epoch',
    );
  }
  if (
    expected.expectedFencingToken !== undefined &&
    fencingToken !== expected.expectedFencingToken
  ) {
    throw new CloudTaskExecutionLeaseError('stale-fencing-token');
  }
  const acquiredAt = requireNonNegativeInteger(
    record.acquiredAt,
    'lease acquisition time',
  );
  return {
    leaseId: requireOpaqueId(record.leaseId, 'lease id'),
    taskId: expected.taskId,
    executionId: expected.executionId,
    restoreReceiptId: expected.restoreReceiptId,
    holderId: expected.holderId,
    epoch,
    fencingToken,
    acquiredAt,
    expiresAt: requireFutureTimestamp(
      record.expiresAt,
      expected.now,
      10 * 60_000,
    ),
  };
}

function parseExecutionHandoffReceipt(
  value: unknown,
  expected: {
    execution: CloudTaskStartedExecution;
    lease: CloudTaskExecutionLease;
    afterSequence: number;
    now: number;
  },
): CloudTaskExecutionHandoffReceipt {
  const record = requireRecord(value, 'execution handoff receipt');
  if (
    record.taskId !== expected.execution.taskId ||
    record.executionId !== expected.execution.executionId ||
    record.restoreReceiptId !== expected.lease.restoreReceiptId ||
    record.sourceLeaseId !== expected.lease.leaseId ||
    record.sourceEpoch !== expected.lease.epoch
  ) {
    throw new Error('Cloud task execution handoff binding mismatch');
  }
  const suspendedAtSequence = requireNonNegativeInteger(
    record.suspendedAtSequence,
    'handoff suspension sequence',
  );
  if (suspendedAtSequence < expected.afterSequence) {
    throw new Error('Cloud task handoff sequence regressed');
  }
  return {
    handoffId: requireOpaqueId(record.handoffId, 'handoff id'),
    taskId: expected.execution.taskId,
    executionId: expected.execution.executionId,
    restoreReceiptId: expected.lease.restoreReceiptId,
    sourceLeaseId: expected.lease.leaseId,
    sourceEpoch: expected.lease.epoch,
    suspendedAtSequence,
    createdAt: requireNonNegativeInteger(
      record.createdAt,
      'handoff creation time',
    ),
    expiresAt: requireFutureTimestamp(
      record.expiresAt,
      expected.now,
      24 * 60 * 60_000,
    ),
  };
}

function parseExecutionResumeResult(
  value: unknown,
  expected: {
    handoff: CloudTaskExecutionHandoffReceipt;
    holderId: string;
    baseUrl: URL;
    now: number;
  },
): CloudTaskExecutionResumeResult {
  const record = requireRecord(value, 'execution resume result');
  if (
    record.handoffId !== expected.handoff.handoffId ||
    record.resumeAfterSequence !== expected.handoff.suspendedAtSequence
  ) {
    throw new Error('Cloud task execution resume barrier mismatch');
  }
  const executionRecord = requireRecord(record.execution, 'resumed execution');
  const execution = {
    ...parseStartedExecution(
      executionRecord,
      expected.baseUrl,
      expected.handoff.taskId,
      expected.now,
    ),
    restoreReceiptId: expected.handoff.restoreReceiptId,
  };
  if (execution.executionId !== expected.handoff.executionId) {
    throw new Error('Cloud task resumed execution binding mismatch');
  }
  const lease = parseExecutionLease(record.lease, {
    taskId: expected.handoff.taskId,
    executionId: expected.handoff.executionId,
    restoreReceiptId: expected.handoff.restoreReceiptId,
    holderId: expected.holderId,
    now: expected.now,
  });
  if (lease.epoch <= expected.handoff.sourceEpoch) {
    throw new CloudTaskExecutionLeaseError('stale-fencing-token');
  }
  return {
    handoffId: expected.handoff.handoffId,
    resumeAfterSequence: expected.handoff.suspendedAtSequence,
    execution,
    lease,
  };
}

function parseExecutionStatus(
  value: unknown,
  taskId: string,
  executionId: string,
): CloudTaskExecutionStatusResult {
  const record = requireRecord(value, 'execution status');
  if (record.taskId !== taskId || record.executionId !== executionId) {
    throw new Error('Cloud task execution status binding mismatch');
  }
  const status = record.status;
  if (
    status !== 'queued' &&
    status !== 'preparing' &&
    status !== 'running' &&
    status !== 'suspended' &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'cancelled'
  ) {
    throw new Error('Cloud task execution status is invalid');
  }
  return {
    taskId,
    executionId,
    status,
    updatedAt: requireNonNegativeInteger(
      record.updatedAt,
      'execution status update time',
    ),
  };
}

function parseStreamEvent(
  value: unknown,
  executionId: string,
  baseUrl: URL,
  now: number,
): CloudTaskStreamEvent {
  const record = requireRecord(value, 'stream event');
  if (record.executionId !== executionId) {
    throw new Error('Cloud task stream execution binding mismatch');
  }
  const sequence = requirePositiveInteger(record.sequence, 'stream sequence');
  switch (record.type) {
    case 'chunk':
      return {
        sequence,
        executionId,
        type: 'chunk',
        chunk: requireRecord(record.chunk, 'UI message chunk'),
      };
    case 'log': {
      const level = record.level;
      if (
        level !== 'debug' &&
        level !== 'info' &&
        level !== 'warn' &&
        level !== 'error'
      ) {
        throw new Error('Cloud task log level is invalid');
      }
      const message = requireString(record.message, 'log message');
      if (message.length > MAX_LOG_MESSAGE_LENGTH) {
        throw new Error('Cloud task log message is too large');
      }
      return { sequence, executionId, type: 'log', level, message };
    }
    case 'usage':
      return {
        sequence,
        executionId,
        type: 'usage',
        durationMs: requireNonNegativeInteger(
          record.durationMs,
          'usage duration',
        ),
        costMicros: requireNonNegativeInteger(record.costMicros, 'usage cost'),
      };
    case 'artifact': {
      const artifact = requireRecord(record.artifact, 'artifact');
      const fileName = requireString(artifact.fileName, 'artifact file name');
      if (
        fileName.length > 240 ||
        fileName === '.' ||
        fileName === '..' ||
        hasUnsafeArtifactFileNameCharacters(fileName)
      ) {
        throw new Error('Cloud task artifact file name is invalid');
      }
      const mediaType = requireString(
        artifact.mediaType,
        'artifact media type',
      );
      if (mediaType.length > 200 || /[\r\n]/.test(mediaType)) {
        throw new Error('Cloud task artifact media type is invalid');
      }
      return {
        sequence,
        executionId,
        type: 'artifact',
        artifact: {
          artifactId: requireOpaqueId(artifact.artifactId, 'artifact id'),
          fileName,
          mediaType,
          sizeBytes: requirePositiveInteger(
            artifact.sizeBytes,
            'artifact size',
          ),
          sha256: requireSha256(artifact.sha256, 'artifact SHA-256'),
          downloadUrl: validateSameOriginUrl(
            requireString(artifact.downloadUrl, 'artifact URL'),
            baseUrl,
            'cloud task artifact URL',
          ).toString(),
          expiresAt: requireFutureTimestamp(
            artifact.expiresAt,
            now,
            24 * 60 * 60_000,
          ),
        },
      };
    }
    case 'completed':
      if (!isIsolatedAgentTurnResult(record.result)) {
        throw new Error('Cloud task completed result is invalid');
      }
      return {
        sequence,
        executionId,
        type: 'completed',
        result: record.result,
      };
    case 'cancelled':
      return { sequence, executionId, type: 'cancelled' };
    case 'suspended':
      return {
        sequence,
        executionId,
        type: 'suspended',
        handoffId: requireOpaqueId(record.handoffId, 'handoff id'),
      };
    case 'failed':
      return {
        sequence,
        executionId,
        type: 'failed',
        reason: requireString(record.reason, 'failure reason').slice(0, 500),
      };
    default:
      throw new Error('Cloud task stream event type is invalid');
  }
}

async function* readNdjson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await reader.read();
      if (result.done) break;
      pending += decoder.decode(result.value, { stream: true });
      if (Buffer.byteLength(pending, 'utf8') > MAX_STREAM_LINE_BYTES) {
        throw new Error('Cloud task stream line is too large');
      }
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) yield parseJsonLine(line);
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.decode();
    const finalLine = pending.trim();
    if (finalLine) yield parseJsonLine(finalLine);
  } finally {
    reader.releaseLock();
  }
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error('Cloud task stream returned invalid NDJSON');
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        throw new Error('Cloud task API response is too large');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    'utf8',
  );
}

function bearerJsonHeaders(token: string): Record<string, string> {
  if (!token?.trim()) throw new Error('Cloud task bearer token is unavailable');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function fencingHeaders(
  token: string,
  lease: CloudTaskExecutionLease,
): Record<string, string> {
  if (!token?.trim()) throw new Error('Cloud task bearer token is unavailable');
  return {
    Authorization: `Bearer ${token}`,
    'X-Clodex-Lease-Id': lease.leaseId,
    'X-Clodex-Lease-Epoch': String(lease.epoch),
    'X-Clodex-Fencing-Token': lease.fencingToken,
  };
}

function fencingJsonHeaders(
  token: string,
  lease: CloudTaskExecutionLease,
): Record<string, string> {
  return {
    ...fencingHeaders(token, lease),
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function throwIfFencingRejected(response: Response): void {
  if (response.status === 412) {
    throw new CloudTaskExecutionLeaseError('stale-fencing-token');
  }
}

function sanitizeUploadHeaders(value: Record<string, string>): Headers {
  const headers = new Headers();
  const forbidden = new Set([
    'authorization',
    'cookie',
    'host',
    'content-length',
    'proxy-authorization',
  ]);
  for (const [name, headerValue] of Object.entries(value)) {
    const normalizedName = name.trim().toLowerCase();
    if (
      !normalizedName ||
      forbidden.has(normalizedName) ||
      /[\r\n]/.test(name) ||
      /[\r\n]/.test(headerValue)
    ) {
      throw new Error('Cloud task upload header is unsafe');
    }
    headers.set(name, headerValue);
  }
  return headers;
}

function validateHttpsUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${label} must use authenticated HTTPS`);
  }
  return url;
}

function validateSameOriginUrl(
  value: string,
  baseUrl: URL,
  label: string,
): URL {
  const url = validateHttpsUrl(value, label);
  if (url.origin !== baseUrl.origin) {
    throw new Error(`${label} must remain on the configured API origin`);
  }
  return url;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Cloud task ${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Cloud task ${label} is invalid`);
  }
  return value.trim();
}

function requireOpaqueId(value: unknown, label: string): string {
  const id = requireString(value, label);
  if (!isOpaqueId(id)) throw new Error(`Cloud task ${label} is invalid`);
  return id;
}

function isOpaqueId(value: string): boolean {
  return value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function requireStringRecord(
  value: unknown,
  label: string,
): Record<string, string> {
  const record = requireRecord(value, label);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') {
      throw new Error(`Cloud task ${label} is invalid`);
    }
    result[key] = entry;
  }
  return result;
}

function requireResidency(value: unknown): CloudDataResidency {
  if (value === 'us' || value === 'eu' || value === 'apac') return value;
  throw new Error('Cloud task residency is invalid');
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Cloud task ${label} is invalid`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const number = requireInteger(value, label);
  if (number <= 0) throw new Error(`Cloud task ${label} is invalid`);
  return number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const number = requireInteger(value, label);
  if (number < 0) throw new Error(`Cloud task ${label} is invalid`);
  return number;
}

function requireSha256(value: unknown, label: string): string {
  const hash = requireString(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Cloud task ${label} is invalid`);
  }
  return hash;
}

function parseDownloadRange(
  response: Response,
  requestedOffset: number,
  expectedTotal: number,
): { start: number; total: number } {
  if (requestedOffset > 0 && response.status !== 206) {
    throw new Error('Cloud task artifact server rejected range resume');
  }
  if (response.status !== 200 && response.status !== 206) {
    throw new Error('Cloud task artifact download status is invalid');
  }
  if (response.status === 200) {
    if (requestedOffset !== 0) {
      throw new Error('Cloud task artifact resume response is invalid');
    }
    validateDownloadLength(response, expectedTotal);
    return { start: 0, total: expectedTotal };
  }
  const value = response.headers.get('content-range');
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) throw new Error('Cloud task artifact content range is invalid');
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start !== requestedOffset ||
    end < start ||
    total !== expectedTotal ||
    end >= total
  ) {
    throw new Error('Cloud task artifact content range is invalid');
  }
  validateDownloadLength(response, end - start + 1);
  return { start, total };
}

function validateDownloadLength(response: Response, expected: number): void {
  const value = response.headers.get('content-length');
  if (value === null) return;
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length !== expected) {
    throw new Error('Cloud task artifact content length is invalid');
  }
}

function hasUnsafeArtifactFileNameCharacters(value: string): boolean {
  return (
    value.includes('/') ||
    value.includes('\\') ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  );
}

function requireFutureTimestamp(
  value: unknown,
  now: number,
  maxFutureMs: number,
): number {
  const timestamp = requireInteger(value, 'expiry timestamp');
  if (timestamp <= now || timestamp - now > maxFutureMs) {
    throw new Error('Cloud task expiry timestamp is invalid');
  }
  return timestamp;
}

function requireLiteral<T extends string>(
  value: unknown,
  literal: T,
  label: string,
): T {
  if (value !== literal) throw new Error(`Cloud task ${label} is invalid`);
  return literal;
}
