import type {
  AgentStepExecution,
  AgentStepExecutionRequest,
} from '@clodex/agent-core/agents';
import type {
  AsyncIterableStream,
  InferUIMessageChunk,
  UIMessage,
  UIMessageStreamOptions,
} from 'ai';
import {
  createAgentStepResultFromIsolatedStep,
  serializeAgentStepExecutionRequestForRemote,
} from './browser-agent-step-executor';
import type {
  CloudTaskControlPlane,
  CloudTaskStartedExecution,
  CloudTaskStreamEvent,
} from './cloud-task-control-plane';
import type {
  CloudTaskArtifactDownloader,
  DownloadedCloudTaskArtifact,
} from './cloud-task-artifacts';
import {
  classifyCloudTaskFailure,
  type CloudTaskControlPlaneAuditEvent,
} from './cloud-task-observability';
import type { CloudTaskStreamResumeStore } from './cloud-task-resume-store';
import {
  createServerRecipientSnapshotCryptoProvider,
  type CloudTaskExecutionPolicy,
  type CloudTaskSecretBroker,
  type ServerRecipientSnapshotCryptoProvider,
  validateCloudTaskExecutionPolicy,
} from './cloud-task-security';
import {
  type AgentExecutionTargetAdapter,
  CloudExecutionSnapshotPreparationError,
} from './execution-target-router';
import type {
  CloudTaskSnapshotCryptoProvider,
  CloudTaskSnapshotDescriptor,
  CloudTaskSnapshotPackager,
  FileSystemCloudTaskSnapshotPackager,
  PreparedCloudTaskSnapshot,
} from './cloud-task-snapshot-packager';
import {
  CloudTaskExecutionLeaseError,
  CloudTaskExecutionLeaseRegistry,
  type CloudTaskExecutionLease,
} from './cloud-task-execution-lease';
import {
  createCloudTaskRestoreCheckpointBinding,
  createCloudTaskWorkspaceRevisionHash,
  type CloudTaskExecutionRestoreReceipt,
} from './cloud-task-restore-handshake';
import type { CloudTaskTeleportState } from '@shared/cloud-task-teleport';
import type { CloudTaskTeleportSession } from '../services/cloud-task-teleport';
import type {
  CloudTaskExecutionHandoffCoordinator,
  CloudTaskExecutionHandoffReceipt,
} from './cloud-task-execution-handoff';
import type {
  CloudTaskEvidenceMemoryCheckpointState,
  CloudTaskEvidenceMemorySynchronizer,
} from './cloud-task-evidence-memory';

export interface CloudTaskTeleportObserver {
  publish(state: CloudTaskTeleportState): void;
  register(session: CloudTaskTeleportSession): () => void;
  update(
    agentInstanceId: string,
    update: Partial<Omit<CloudTaskTeleportState, 'agentInstanceId'>>,
  ): void;
}

export interface CloudTaskUploadSnapshotPackagerOptions {
  controlPlane: CloudTaskControlPlane;
  getAccountAccessToken: () => string | undefined;
  resolvePolicy: (input: {
    taskId: string;
    agentInstanceId: string;
  }) => CloudTaskExecutionPolicy;
  createLocalPackager: (input: {
    cryptoProvider: CloudTaskSnapshotCryptoProvider;
    maxEntries: number;
    maxTotalBytes: number;
  }) => FileSystemCloudTaskSnapshotPackager;
  audit?: (event: CloudTaskControlPlaneAuditEvent) => void;
}

export type { CloudTaskControlPlaneAuditEvent } from './cloud-task-observability';

/**
 * Creates the upload session before local packaging so encryption is bound to
 * the current server recipient key. The signed URL never receives account or
 * task bearer credentials.
 */
export class CloudTaskUploadSnapshotPackager
  implements CloudTaskSnapshotPackager
{
  public constructor(
    private readonly options: CloudTaskUploadSnapshotPackagerOptions,
  ) {}

  public async prepare(input: {
    taskId: string;
    agentInstanceId: string;
    selection: Parameters<CloudTaskSnapshotPackager['prepare']>[0]['selection'];
    abortSignal?: AbortSignal;
  }): Promise<PreparedCloudTaskSnapshot> {
    const startedAt = Date.now();
    const policy = validateCloudTaskExecutionPolicy(
      this.options.resolvePolicy({
        taskId: input.taskId,
        agentInstanceId: input.agentInstanceId,
      }),
    );
    const accountAccessToken = this.options.getAccountAccessToken();
    if (!accountAccessToken?.trim()) {
      this.audit({
        operation: 'upload',
        success: false,
        residency: policy.residency,
        reason: 'auth',
        durationMs: Date.now() - startedAt,
      });
      throw new CloudExecutionSnapshotPreparationError('snapshot-unavailable');
    }
    let prepared: PreparedCloudTaskSnapshot | undefined;
    let cryptoProvider: ServerRecipientSnapshotCryptoProvider | undefined;
    try {
      const session = await this.options.controlPlane.createUploadSession(
        {
          taskId: input.taskId,
          residency: policy.residency,
          selectedEntryCount: input.selection.entries.length,
          policy,
        },
        accountAccessToken,
        input.abortSignal,
      );
      cryptoProvider = createServerRecipientSnapshotCryptoProvider({
        taskId: input.taskId,
        recipient: session.recipientKey,
      });
      const localPackager = this.options.createLocalPackager({
        cryptoProvider,
        maxEntries: Math.min(policy.maxSnapshotFiles, session.maxFiles),
        maxTotalBytes: Math.min(policy.maxSnapshotBytes, session.maxBytes),
      });
      prepared = await localPackager.prepare(input);
      const uploaded = await this.options.controlPlane.uploadSnapshot(
        session,
        prepared.descriptor,
        input.abortSignal,
      );
      if (uploaded.sha256 !== prepared.descriptor.archive.sha256) {
        throw new Error('Cloud task uploaded object integrity mismatch');
      }
      this.audit({
        operation: 'upload',
        success: true,
        residency: policy.residency,
        durationMs: Date.now() - startedAt,
        snapshotBytes: prepared.descriptor.archive.sizeBytes,
        snapshotFiles: prepared.descriptor.manifest.entries.length,
      });
      return {
        descriptor: {
          ...prepared.descriptor,
          upload: {
            sessionId: uploaded.sessionId,
            objectId: uploaded.objectId,
            residency: session.residency,
            expiresAt: session.expiresAt,
            sha256: uploaded.sha256,
          },
        },
        cleanup: prepared.cleanup,
      };
    } catch (error) {
      await prepared?.cleanup().catch(() => {});
      this.audit({
        operation: 'upload',
        success: false,
        residency: policy.residency,
        reason: classifyCloudTaskFailure(error),
        durationMs: Date.now() - startedAt,
        snapshotBytes: prepared?.descriptor.archive.sizeBytes,
        snapshotFiles: prepared?.descriptor.manifest.entries.length,
      });
      throw error;
    } finally {
      cryptoProvider?.dispose();
    }
  }

  private audit(event: CloudTaskControlPlaneAuditEvent): void {
    try {
      this.options.audit?.(event);
    } catch {
      // Audit transport must never change cloud task outcome.
    }
  }
}

export interface ProductionCloudExecutionTargetAdapterOptions {
  controlPlane: CloudTaskControlPlane;
  secretBroker: CloudTaskSecretBroker;
  getAccountAccessToken: () => string | undefined;
  resolvePolicy: (
    request: AgentStepExecutionRequest,
  ) => CloudTaskExecutionPolicy;
  serializeRequest?: typeof serializeAgentStepExecutionRequestForRemote;
  artifactDownloader?: CloudTaskArtifactDownloader;
  resumeStore?: CloudTaskStreamResumeStore;
  leaseRegistry?: CloudTaskExecutionLeaseRegistry;
  leaseHolderId?: string;
  handoffCoordinator?: CloudTaskExecutionHandoffCoordinator;
  evidenceMemorySynchronizer?: CloudTaskEvidenceMemorySynchronizer;
  audit?: (event: CloudTaskControlPlaneAuditEvent) => void;
  now?: () => number;
}

export class ProductionCloudExecutionTargetAdapter
  implements AgentExecutionTargetAdapter
{
  public readonly target = 'cloud' as const;
  private readonly serializeRequest: typeof serializeAgentStepExecutionRequestForRemote;
  private readonly leaseRegistry: CloudTaskExecutionLeaseRegistry;
  private readonly leaseHolderId: string;
  private teleportObserver: CloudTaskTeleportObserver | undefined;

  public constructor(
    private readonly options: ProductionCloudExecutionTargetAdapterOptions,
  ) {
    this.serializeRequest =
      options.serializeRequest ?? serializeAgentStepExecutionRequestForRemote;
    this.leaseRegistry =
      options.leaseRegistry ??
      new CloudTaskExecutionLeaseRegistry({ now: options.now });
    this.leaseHolderId = options.leaseHolderId ?? 'clodex-desktop';
  }

  public setTeleportObserver(observer: CloudTaskTeleportObserver): void {
    this.teleportObserver = observer;
  }

  public isAvailable(): boolean {
    return Boolean(this.options.getAccountAccessToken()?.trim());
  }

  public async execute(
    request: AgentStepExecutionRequest,
  ): Promise<AgentStepExecution> {
    const startedAt = Date.now();
    const taskId = request.context.executionTaskId;
    if (!taskId) throw new Error('Cloud execution task id is missing');
    const snapshot = readUploadedSnapshot(request.context.metadata);
    if (
      snapshot.manifest.taskId !== taskId ||
      snapshot.upload?.sha256 !== snapshot.archive.sha256
    ) {
      throw new Error('Cloud execution snapshot binding is invalid');
    }
    const policy = validateCloudTaskExecutionPolicy(
      this.options.resolvePolicy(request),
    );
    if (snapshot.upload.residency !== policy.residency) {
      throw new Error('Cloud execution residency does not match local policy');
    }
    const restoreCheckpoint = createCloudTaskRestoreCheckpointBinding(
      request.context.metadata.session_checkpoint,
      request.context.agentInstanceId,
    );
    if (
      (snapshot.manifest.selection === 'mounted-workspaces') !==
      (restoreCheckpoint !== null)
    ) {
      throw new Error(
        'Session Teleport requires a checkpoint bound to a session-wide workspace snapshot',
      );
    }
    if (
      restoreCheckpoint &&
      restoreCheckpoint.workspaceRevisionHash !==
        createCloudTaskWorkspaceRevisionHash(
          snapshot.manifest.mounts.map((mount) => ({
            repositoryId: mount.repositoryId,
            worktreeId: mount.worktreeId,
            revision: mount.repositoryRevision,
          })),
        )
    ) {
      throw new Error(
        'Session checkpoint workspace revisions do not match the packaged snapshot',
      );
    }

    let lease:
      | Awaited<ReturnType<CloudTaskSecretBroker['acquire']>>
      | undefined;
    let execution: CloudTaskStartedExecution | undefined;
    let restoreReceipt: CloudTaskExecutionRestoreReceipt | undefined;
    let executionLease: CloudTaskExecutionLease | undefined;
    let memoryCheckpoint: CloudTaskEvidenceMemoryCheckpointState | null = null;
    let restoreHandshakeStartedAt: number | undefined;
    let leaseAcquisitionStartedAt: number | undefined;
    try {
      lease = await this.options.secretBroker.acquire({
        taskId,
        residency: policy.residency,
        scopes: [
          'task:start',
          'task:restore',
          'task:lease',
          'task:suspend',
          'task:resume',
          'task:stream',
          'task:memory',
          'task:cancel',
        ],
        signal: request.options.abortSignal,
      });
      const turn = await this.serializeRequest(request);
      execution = await this.options.controlPlane.startExecution(
        {
          taskId,
          uploadSessionId: snapshot.upload.sessionId,
          snapshotSha256: snapshot.archive.sha256,
          policy,
          turn,
        },
        lease.token,
        request.options.abortSignal,
      );
      this.teleportObserver?.publish({
        agentInstanceId: request.context.agentInstanceId,
        taskId,
        executionId: execution.executionId,
        phase: 'restoring',
        epoch: null,
        handoffId: null,
        lastSequence: 0,
        updatedAt: this.options.now?.() ?? Date.now(),
        error: null,
      });
      const confirmExecutionRestore =
        this.options.controlPlane.confirmExecutionRestore;
      if (!confirmExecutionRestore) {
        throw new Error('Cloud task restore handshake API is unavailable');
      }
      restoreHandshakeStartedAt = Date.now();
      restoreReceipt = await confirmExecutionRestore.call(
        this.options.controlPlane,
        {
          taskId,
          executionId: execution.executionId,
          uploadSessionId: snapshot.upload.sessionId,
          snapshotSha256: snapshot.archive.sha256,
          workspaceSnapshotHash: snapshot.manifest.snapshotHash,
          checkpoint: restoreCheckpoint,
        },
        lease.token,
        request.options.abortSignal,
      );
      execution = {
        ...execution,
        restoreReceiptId: restoreReceipt.restoreReceiptId,
      };
      this.audit({
        operation: 'restore-handshake',
        success: true,
        residency: policy.residency,
        durationMs: Date.now() - restoreHandshakeStartedAt,
      });
      if (this.options.evidenceMemorySynchronizer) {
        memoryCheckpoint =
          await this.options.evidenceMemorySynchronizer.prepareCloudRestore({
            taskId,
            agentInstanceId: request.context.agentInstanceId,
            execution,
            checkpoint:
              restoreCheckpoint?.memoryCheckpointId &&
              typeof restoreCheckpoint.memoryLedgerHash === 'string' &&
              typeof restoreCheckpoint.memoryEventCount === 'number'
                ? {
                    checkpointId: restoreCheckpoint.memoryCheckpointId,
                    ledgerHash: restoreCheckpoint.memoryLedgerHash,
                    eventCount: restoreCheckpoint.memoryEventCount,
                  }
                : null,
            taskCredential: lease.token,
            signal: request.options.abortSignal,
          });
      }
      const acquireExecutionLease =
        this.options.controlPlane.acquireExecutionLease;
      if (!acquireExecutionLease) {
        throw new Error('Cloud task execution lease API is unavailable');
      }
      leaseAcquisitionStartedAt = Date.now();
      executionLease = await acquireExecutionLease.call(
        this.options.controlPlane,
        {
          taskId,
          executionId: execution.executionId,
          holderId: this.leaseHolderId,
          checkpointId: restoreCheckpoint?.checkpointId ?? null,
          restoreReceiptId: restoreReceipt.restoreReceiptId,
        },
        lease.token,
        request.options.abortSignal,
      );
      this.leaseRegistry.activate(
        request.context.agentInstanceId,
        executionLease,
      );
      if (this.options.evidenceMemorySynchronizer) {
        memoryCheckpoint =
          await this.options.evidenceMemorySynchronizer.activateCloudOwnership({
            taskId,
            agentInstanceId: request.context.agentInstanceId,
            execution,
            lease: executionLease,
            checkpoint: memoryCheckpoint,
          });
      }
      if (this.options.resumeStore) {
        await this.options.resumeStore.save(execution, 0, null, {
          agentInstanceId: request.context.agentInstanceId,
          cloudOwnership: { epoch: executionLease.epoch },
          ...(memoryCheckpoint ? { memoryCheckpoint } : {}),
        });
      }
      this.audit({
        operation: 'lease-acquire',
        success: true,
        residency: policy.residency,
        durationMs: Date.now() - leaseAcquisitionStartedAt,
      });
      this.audit({
        operation: 'start',
        success: true,
        residency: policy.residency,
        durationMs: Date.now() - startedAt,
      });
      const step = new ProductionCloudAgentStepExecution({
        request,
        execution,
        controlPlane: this.options.controlPlane,
        credential: lease,
        executionLease,
        leaseRegistry: this.leaseRegistry,
        policy,
        artifactDownloader: this.options.artifactDownloader,
        resumeStore: this.options.resumeStore,
        handoffCoordinator: this.options.handoffCoordinator,
        evidenceMemorySynchronizer: this.options.evidenceMemorySynchronizer,
        memoryCheckpoint,
        leaseHolderId: this.leaseHolderId,
        audit: this.options.audit,
        now: this.options.now ?? Date.now,
      });
      if (this.teleportObserver) {
        step.attachTeleportObserver(this.teleportObserver);
      }
      return step;
    } catch (error) {
      if (execution) {
        const memoryState =
          this.options.evidenceMemorySynchronizer?.getCheckpointState?.(
            execution.executionId,
          );
        this.teleportObserver?.update(request.context.agentInstanceId, {
          phase: 'failed',
          memoryCheckpointId: memoryState?.checkpointId ?? null,
          memoryEventCount: memoryState?.eventCount ?? null,
          memorySyncState: memoryState?.syncState ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (restoreHandshakeStartedAt !== undefined && !restoreReceipt) {
        this.audit({
          operation: 'restore-handshake',
          success: false,
          residency: policy.residency,
          reason: classifyCloudTaskFailure(error),
          durationMs: Date.now() - restoreHandshakeStartedAt,
        });
      }
      if (leaseAcquisitionStartedAt !== undefined) {
        this.audit({
          operation: 'lease-acquire',
          success: false,
          residency: policy.residency,
          reason: classifyCloudTaskFailure(error),
          durationMs: Date.now() - leaseAcquisitionStartedAt,
        });
      }
      if (execution && lease) {
        if (executionLease) {
          try {
            await this.options.controlPlane.cancelExecution(
              execution,
              lease.token,
              undefined,
              executionLease,
            );
          } catch {
            // Best effort: the control plane remains authoritative.
          }
          try {
            await this.options.controlPlane.releaseExecutionLease?.call(
              this.options.controlPlane,
              executionLease,
              lease.token,
            );
          } catch {
            // An uncertain release must not hide the original start failure.
          }
        } else {
          try {
            await this.options.controlPlane.cancelExecution(
              execution,
              lease.token,
            );
          } catch {
            // Execution was created but ownership was never acquired.
          }
        }
      }
      await lease?.dispose();
      this.audit({
        operation: 'start',
        success: false,
        residency: policy.residency,
        reason: classifyCloudTaskFailure(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private audit(event: CloudTaskControlPlaneAuditEvent): void {
    try {
      this.options.audit?.(event);
    } catch {
      // Audit transport must never change cloud task outcome.
    }
  }
}

class ProductionCloudAgentStepExecution implements AgentStepExecution {
  private readonly consumeBranch: ReadableStream<
    InferUIMessageChunk<UIMessage>
  >;
  private readonly uiBranch: ReadableStream<InferUIMessageChunk<UIMessage>>;
  private consumeClaimed = false;
  private uiClaimed = false;
  private currentExecution: CloudTaskStartedExecution;
  private currentLease: CloudTaskExecutionLease;
  private lastSequence = 0;
  private handoff: CloudTaskExecutionHandoffReceipt | null = null;
  private barrierWaiter: Deferred<{
    sequence: number;
    handoffId: string;
  }> | null = null;
  private resumeGate: Deferred<void> | null = null;
  private teleportObserver: CloudTaskTeleportObserver | null = null;
  private unregisterTeleport: (() => void) | null = null;
  private startLeaseRenewal: (() => void) | null = null;
  private stopLeaseRenewal: (() => void) | null = null;
  private leaseReleased = false;
  private terminal = false;
  private currentMemoryCheckpoint: CloudTaskEvidenceMemoryCheckpointState | null;

  public constructor(
    private readonly options: {
      request: AgentStepExecutionRequest;
      execution: CloudTaskStartedExecution;
      controlPlane: CloudTaskControlPlane;
      credential: Awaited<ReturnType<CloudTaskSecretBroker['acquire']>>;
      executionLease: CloudTaskExecutionLease;
      leaseRegistry: CloudTaskExecutionLeaseRegistry;
      policy: CloudTaskExecutionPolicy;
      artifactDownloader?: CloudTaskArtifactDownloader;
      resumeStore?: CloudTaskStreamResumeStore;
      handoffCoordinator?: CloudTaskExecutionHandoffCoordinator;
      evidenceMemorySynchronizer?: CloudTaskEvidenceMemorySynchronizer;
      memoryCheckpoint: CloudTaskEvidenceMemoryCheckpointState | null;
      leaseHolderId: string;
      audit?: (event: CloudTaskControlPlaneAuditEvent) => void;
      now: () => number;
    },
  ) {
    this.currentExecution = options.execution;
    this.currentLease = options.executionLease;
    this.currentMemoryCheckpoint = options.memoryCheckpoint;
    const source = this.createSource();
    [this.consumeBranch, this.uiBranch] = source.tee();
  }

  public attachTeleportObserver(observer: CloudTaskTeleportObserver): void {
    if (this.teleportObserver) {
      throw new Error('Cloud task Teleport observer is already attached');
    }
    this.teleportObserver = observer;
    this.unregisterTeleport = observer.register(this.createTeleportSession());
  }

  private createTeleportSession(): CloudTaskTeleportSession {
    return {
      state: this.createTeleportState('cloud-owned'),
      continueLocally: async () => await this.suspendToLocal(),
      resumeInCloud: async () => await this.resumeInCloud(),
      retryMemorySync: async () =>
        this.handoff ? await this.resumeInCloud() : await this.suspendToLocal(),
      resolveMemoryDivergence: async (strategy) =>
        await this.resolveMemoryDivergence(strategy),
    };
  }

  private createTeleportState(
    phase: CloudTaskTeleportState['phase'],
    error: string | null = null,
  ): CloudTaskTeleportState {
    return {
      agentInstanceId: this.options.request.context.agentInstanceId,
      taskId: this.currentExecution.taskId,
      executionId: this.currentExecution.executionId,
      phase,
      epoch: this.currentLease.epoch,
      handoffId: this.handoff?.handoffId ?? null,
      lastSequence: this.lastSequence,
      memoryCheckpointId: this.currentMemoryCheckpoint?.checkpointId ?? null,
      memoryEventCount: this.currentMemoryCheckpoint?.eventCount ?? null,
      memorySyncState: this.currentMemoryCheckpoint?.syncState ?? null,
      updatedAt: this.options.now(),
      error,
    };
  }

  private async suspendToLocal(): Promise<CloudTaskTeleportState> {
    if (this.terminal) throw new Error('Cloud task execution has finished');
    if (!this.options.handoffCoordinator) {
      throw new Error('Cloud task handoff coordinator is unavailable');
    }
    if (this.handoff || this.barrierWaiter || this.resumeGate) {
      throw new Error('Cloud task execution is already suspended');
    }
    this.barrierWaiter = createDeferred();
    this.resumeGate = createDeferred();
    try {
      const receipt = await this.options.handoffCoordinator.suspendToLocal({
        agentInstanceId: this.options.request.context.agentInstanceId,
        execution: this.currentExecution,
        lease: this.currentLease,
        taskCredential: this.options.credential.token,
        lastObservedSequence: this.lastSequence,
        waitForBarrier: async () => await this.barrierWaiter!.promise,
        signal: this.options.request.options.abortSignal,
      });
      this.handoff = receipt;
      this.currentMemoryCheckpoint =
        this.options.handoffCoordinator.getMemoryCheckpoint(
          this.currentExecution.executionId,
        );
      this.leaseReleased = true;
      this.stopLeaseRenewal?.();
      return this.createTeleportState('suspended');
    } catch (error) {
      this.refreshMemoryDiagnostics();
      this.barrierWaiter?.reject(error);
      this.barrierWaiter = null;
      this.resumeGate?.resolve();
      this.resumeGate = null;
      throw error;
    }
  }

  private async resumeInCloud(): Promise<CloudTaskTeleportState> {
    if (this.terminal) throw new Error('Cloud task execution has finished');
    if (!this.options.handoffCoordinator) {
      throw new Error('Cloud task handoff coordinator is unavailable');
    }
    const handoff = this.handoff;
    const resumeGate = this.resumeGate;
    if (!handoff || !resumeGate) {
      throw new Error('Cloud task execution is not suspended');
    }
    const result = await this.options.handoffCoordinator.resumeInCloud({
      agentInstanceId: this.options.request.context.agentInstanceId,
      execution: this.currentExecution,
      handoff,
      holderId: this.options.leaseHolderId,
      taskCredential: this.options.credential.token,
      assertLocalSafePoint: () => {
        if (
          this.handoff?.handoffId !== handoff.handoffId ||
          this.lastSequence !== handoff.suspendedAtSequence
        ) {
          throw new Error(
            'Cloud task suspension barrier is not the current local safe point',
          );
        }
      },
      signal: this.options.request.options.abortSignal,
    });
    this.currentExecution = result.execution;
    this.currentLease = result.lease;
    this.lastSequence = result.resumeAfterSequence;
    this.currentMemoryCheckpoint =
      this.options.handoffCoordinator.getMemoryCheckpoint(
        result.execution.executionId,
      );
    this.handoff = null;
    this.barrierWaiter = null;
    this.resumeGate = null;
    this.leaseReleased = false;
    this.startLeaseRenewal?.();
    resumeGate.resolve();
    return this.createTeleportState('cloud-owned');
  }

  private async resolveMemoryDivergence(
    strategy: 'keep-local' | 'accept-cloud',
  ): Promise<CloudTaskTeleportState> {
    const synchronizer = this.options.evidenceMemorySynchronizer;
    if (!synchronizer?.resolveDivergence) {
      throw new Error('Memory divergence recovery is unavailable');
    }
    try {
      this.currentMemoryCheckpoint = await synchronizer.resolveDivergence({
        strategy,
        taskId: this.currentExecution.taskId,
        agentInstanceId: this.options.request.context.agentInstanceId,
        execution: this.currentExecution,
        lease: this.currentLease,
        taskCredential: this.options.credential.token,
        lastSequence: this.lastSequence,
        signal: this.options.request.options.abortSignal,
      });
    } catch (error) {
      this.refreshMemoryDiagnostics();
      throw error;
    }
    return this.createTeleportState(this.handoff ? 'suspended' : 'cloud-owned');
  }

  private refreshMemoryDiagnostics(): void {
    const state = this.options.evidenceMemorySynchronizer?.getCheckpointState?.(
      this.currentExecution.executionId,
    );
    if (!state) return;
    this.currentMemoryCheckpoint = state;
    this.teleportObserver?.update(
      this.options.request.context.agentInstanceId,
      {
        memoryCheckpointId: state.checkpointId,
        memoryEventCount: state.eventCount,
        memorySyncState: state.syncState,
      },
    );
  }

  public async consumeStream(options?: {
    onError?: (error: unknown) => void;
  }): Promise<void> {
    if (this.consumeClaimed) {
      throw new Error('Cloud task consume stream has already been claimed');
    }
    this.consumeClaimed = true;
    try {
      await drainStream(this.consumeBranch);
    } catch (error) {
      options?.onError?.(error);
      throw error;
    }
  }

  public toUIMessageStream<UI_MESSAGE extends UIMessage>(
    _options?: UIMessageStreamOptions<UI_MESSAGE>,
  ): AsyncIterableStream<InferUIMessageChunk<UI_MESSAGE>> {
    if (this.uiClaimed) {
      throw new Error('Cloud task UI stream has already been claimed');
    }
    this.uiClaimed = true;
    return toAsyncIterableStream(
      this.uiBranch as ReadableStream<InferUIMessageChunk<UI_MESSAGE>>,
    );
  }

  private createSource(): ReadableStream<InferUIMessageChunk<UIMessage>> {
    const { request, controlPlane, credential } = this.options;
    const agentInstanceId = request.context.agentInstanceId;
    const abortSignal = request.options.abortSignal;
    let remoteTerminal = false;
    let cancelling = false;
    let policyLimit: CloudTaskPolicyLimit | undefined;
    let leaseFailure: Error | null = null;
    let leaseRenewalTimer: ReturnType<typeof setTimeout> | null = null;
    const streamStartedAt = this.options.now();
    const policyAbortController = new AbortController();
    const leaseAbortController = new AbortController();
    const combinedSignal = combineAbortSignals([
      abortSignal,
      policyAbortController.signal,
      leaseAbortController.signal,
    ]);
    const cancelRemote = async (): Promise<void> => {
      if (cancelling || this.terminal) return;
      cancelling = true;
      const cancelStartedAt = Date.now();
      try {
        this.options.leaseRegistry.assertCurrent(
          agentInstanceId,
          this.currentLease,
        );
        await controlPlane.cancelExecution(
          this.currentExecution,
          credential.token,
          undefined,
          this.currentLease,
        );
        this.audit({
          operation: 'cancel',
          success: true,
          residency: this.options.policy.residency,
          durationMs: Date.now() - cancelStartedAt,
        });
      } catch (error) {
        this.audit({
          operation: 'cancel',
          success: false,
          residency: this.options.policy.residency,
          reason: classifyCloudTaskFailure(error),
          durationMs: Date.now() - cancelStartedAt,
        });
      }
    };
    const abortHandler = () => {
      void cancelRemote();
    };
    abortSignal?.addEventListener('abort', abortHandler, { once: true });
    const policyTimer = setTimeout(() => {
      if (this.terminal) return;
      policyLimit = 'duration';
      policyAbortController.abort();
      void cancelRemote();
    }, this.options.policy.maxDurationMs);
    const releaseLease = async (): Promise<void> => {
      if (this.leaseReleased) return;
      this.leaseReleased = true;
      const releaseStartedAt = Date.now();
      let releasedRemotely = false;
      try {
        const releaseExecutionLease = controlPlane.releaseExecutionLease;
        if (!releaseExecutionLease) {
          throw new Error('Cloud task execution lease API is unavailable');
        }
        await releaseExecutionLease.call(
          controlPlane,
          this.currentLease,
          credential.token,
        );
        releasedRemotely = true;
        this.audit({
          operation: 'lease-release',
          success: true,
          residency: this.options.policy.residency,
          durationMs: Date.now() - releaseStartedAt,
        });
      } catch (error) {
        this.audit({
          operation: 'lease-release',
          success: false,
          residency: this.options.policy.residency,
          reason: classifyCloudTaskFailure(error),
          durationMs: Date.now() - releaseStartedAt,
        });
      }
      if (releasedRemotely || remoteTerminal) {
        this.options.leaseRegistry.release(agentInstanceId, this.currentLease);
      }
    };
    const scheduleLeaseRenewal = (): void => {
      if (this.terminal || this.leaseReleased || leaseRenewalTimer) return;
      const remaining = this.currentLease.expiresAt - this.options.now();
      const delay = Math.max(250, Math.floor(remaining / 2));
      leaseRenewalTimer = setTimeout(() => {
        leaseRenewalTimer = null;
        void (async () => {
          const renewalStartedAt = Date.now();
          try {
            this.options.leaseRegistry.assertCurrent(
              agentInstanceId,
              this.currentLease,
            );
            const renewExecutionLease = controlPlane.renewExecutionLease;
            if (!renewExecutionLease) {
              throw new Error('Cloud task execution lease API is unavailable');
            }
            const renewed = await renewExecutionLease.call(
              controlPlane,
              this.currentLease,
              credential.token,
            );
            this.options.leaseRegistry.renew(agentInstanceId, renewed);
            this.currentLease = renewed;
            this.teleportObserver?.update(agentInstanceId, {
              epoch: renewed.epoch,
            });
            this.audit({
              operation: 'lease-renew',
              success: true,
              residency: this.options.policy.residency,
              durationMs: Date.now() - renewalStartedAt,
            });
            scheduleLeaseRenewal();
          } catch (error) {
            leaseFailure = normalizeError(error);
            this.audit({
              operation: 'lease-renew',
              success: false,
              residency: this.options.policy.residency,
              reason: classifyCloudTaskFailure(error),
              durationMs: Date.now() - renewalStartedAt,
            });
            leaseAbortController.abort(leaseFailure);
          }
        })();
      }, delay);
      leaseRenewalTimer.unref?.();
    };
    this.startLeaseRenewal = scheduleLeaseRenewal;
    this.stopLeaseRenewal = () => {
      if (leaseRenewalTimer) clearTimeout(leaseRenewalTimer);
      leaseRenewalTimer = null;
    };
    scheduleLeaseRenewal();

    return new ReadableStream<InferUIMessageChunk<UIMessage>>({
      start: (controller) => {
        void (async () => {
          this.lastSequence = await this.loadResumeSequence();
          let reconnects = 0;
          try {
            streamLoop: while (!this.terminal) {
              try {
                for await (const event of controlPlane.streamExecution(
                  this.currentExecution,
                  credential.token,
                  this.lastSequence,
                  combinedSignal.signal,
                  this.currentLease,
                )) {
                  this.options.leaseRegistry.assertCurrent(
                    agentInstanceId,
                    this.currentLease,
                  );
                  const eventTerminal = await this.handleEvent(
                    event,
                    controller,
                    cancelRemote,
                  );
                  this.lastSequence = event.sequence;
                  this.teleportObserver?.update(agentInstanceId, {
                    lastSequence: this.lastSequence,
                  });
                  await this.saveResumeSequence(this.lastSequence);
                  if (event.type === 'suspended') {
                    const waiter = this.barrierWaiter;
                    const gate = this.resumeGate;
                    if (!waiter || !gate) {
                      throw new Error(
                        `Cloud task suspended for handoff ${event.handoffId} without an active local transfer`,
                      );
                    }
                    waiter.resolve({
                      sequence: event.sequence,
                      handoffId: event.handoffId,
                    });
                    await waitForPromiseOrAbort(
                      gate.promise,
                      combinedSignal.signal,
                    );
                    reconnects = 0;
                    continue streamLoop;
                  }
                  if (eventTerminal) {
                    this.terminal = true;
                    remoteTerminal = true;
                    this.audit({
                      operation: 'stream',
                      success: event.type === 'completed',
                      residency: this.options.policy.residency,
                      reason:
                        event.type === 'failed'
                          ? 'execution'
                          : event.type === 'cancelled'
                            ? 'aborted'
                            : undefined,
                      durationMs: this.options.now() - streamStartedAt,
                    });
                    break;
                  }
                }
                if (!this.terminal) {
                  throw new Error(
                    'Cloud task stream ended before a terminal event',
                  );
                }
              } catch (error) {
                if (error instanceof CloudTaskPolicyLimitError) throw error;
                if (error instanceof CloudTaskExecutionLeaseError) throw error;
                if (leaseFailure) throw leaseFailure;
                if (policyLimit) {
                  throw new CloudTaskPolicyLimitError(policyLimit);
                }
                if (abortSignal?.aborted) throw abortError();
                if (
                  reconnects >= 3 ||
                  this.options.now() >= this.currentExecution.expiresAt
                ) {
                  throw error;
                }
                reconnects += 1;
                await waitForReconnect(
                  250 * 2 ** (reconnects - 1),
                  abortSignal,
                );
              }
            }
          } catch (error) {
            const normalized = normalizeError(error);
            if (normalized.name !== 'AbortError' && !remoteTerminal) {
              await cancelRemote();
            }
            this.audit({
              operation: 'stream',
              success: false,
              residency: this.options.policy.residency,
              reason: classifyCloudTaskFailure(normalized),
              durationMs: this.options.now() - streamStartedAt,
              limit:
                normalized instanceof CloudTaskPolicyLimitError
                  ? normalized.limit
                  : undefined,
            });
            if (normalized.name === 'AbortError') {
              await request.options.onAbort?.({ steps: [] });
              enqueueSafely(controller, {
                type: 'abort',
                reason: normalized.message,
              } as InferUIMessageChunk<UIMessage>);
            } else {
              await request.options.onError?.({ error: normalized });
              enqueueSafely(controller, {
                type: 'error',
                errorText: normalized.message,
              } as InferUIMessageChunk<UIMessage>);
            }
          } finally {
            this.terminal = true;
            this.resumeGate?.resolve();
            clearTimeout(policyTimer);
            if (leaseRenewalTimer) clearTimeout(leaseRenewalTimer);
            combinedSignal.dispose();
            abortSignal?.removeEventListener('abort', abortHandler);
            if (remoteTerminal) {
              await this.clearResumeSequence();
            }
            await releaseLease();
            await credential.dispose();
            this.unregisterTeleport?.();
            this.unregisterTeleport = null;
            closeSafely(controller);
          }
        })();
      },
      cancel: async () => {
        await cancelRemote();
        this.terminal = true;
        this.resumeGate?.resolve();
        await releaseLease();
        await credential.dispose();
        this.unregisterTeleport?.();
        this.unregisterTeleport = null;
      },
    });
  }

  private async handleEvent(
    event: CloudTaskStreamEvent,
    controller: ReadableStreamDefaultController<InferUIMessageChunk<UIMessage>>,
    cancelRemote: () => Promise<void>,
  ): Promise<boolean> {
    switch (event.type) {
      case 'chunk':
        enqueueSafely(
          controller,
          event.chunk as InferUIMessageChunk<UIMessage>,
        );
        return false;
      case 'log':
        enqueueSafely(controller, {
          type: 'data-cloud-log',
          id: `cloud-log-${event.sequence}`,
          data: {
            level: event.level,
            message: event.message,
          },
        } as InferUIMessageChunk<UIMessage>);
        return false;
      case 'usage':
        await this.handleUsage(event, controller, cancelRemote);
        return false;
      case 'artifact': {
        const downloaded = await this.downloadArtifact(event, cancelRemote);
        enqueueSafely(controller, {
          type: 'data-cloud-artifact',
          id: `cloud-artifact-${event.sequence}`,
          data: {
            executionId: downloaded.executionId,
            artifactId: downloaded.artifactId,
            fileName: downloaded.fileName,
            mediaType: downloaded.mediaType,
            sizeBytes: downloaded.sizeBytes,
          },
        } as InferUIMessageChunk<UIMessage>);
        return false;
      }
      case 'completed': {
        if (!this.sawUsage) {
          throw new Error(
            'Cloud task completed without required usage accounting',
          );
        }
        const steps = event.result.steps.map((step) =>
          createAgentStepResultFromIsolatedStep(step, this.options.request),
        );
        const finalStep = steps.at(-1);
        if (!finalStep) {
          throw new Error('Cloud task completed without a step result');
        }
        await this.options.request.options.onFinish?.({
          ...finalStep,
          steps,
          totalUsage: finalStep.usage,
        });
        return true;
      }
      case 'cancelled':
        await this.options.request.options.onAbort?.({ steps: [] });
        enqueueSafely(controller, {
          type: 'abort',
          reason: 'Cloud task was cancelled',
        } as InferUIMessageChunk<UIMessage>);
        return true;
      case 'suspended':
        return false;
      case 'failed': {
        const error = new Error(event.reason);
        await this.options.request.options.onError?.({ error });
        enqueueSafely(controller, {
          type: 'error',
          errorText: error.message,
        } as InferUIMessageChunk<UIMessage>);
        return true;
      }
    }
  }

  private audit(event: CloudTaskControlPlaneAuditEvent): void {
    try {
      this.options.audit?.(event);
    } catch {
      // Audit transport must never change cloud task outcome.
    }
  }

  private readonly artifactIds = new Set<string>();
  private artifactBytes = 0;
  private lastUsageDurationMs = 0;
  private lastCostMicros = 0;
  private sawUsage = false;

  private async handleUsage(
    event: Extract<CloudTaskStreamEvent, { type: 'usage' }>,
    controller: ReadableStreamDefaultController<InferUIMessageChunk<UIMessage>>,
    cancelRemote: () => Promise<void>,
  ): Promise<void> {
    if (
      event.durationMs < this.lastUsageDurationMs ||
      event.costMicros < this.lastCostMicros
    ) {
      throw new Error('Cloud task usage sequence is not monotonic');
    }
    this.lastUsageDurationMs = event.durationMs;
    this.lastCostMicros = event.costMicros;
    this.sawUsage = true;
    const limit =
      event.durationMs > this.options.policy.maxDurationMs
        ? 'duration'
        : event.costMicros > this.options.policy.maxCostMicros
          ? 'cost'
          : undefined;
    this.audit({
      operation: 'usage',
      success: limit === undefined,
      residency: this.options.policy.residency,
      reason: limit ? 'policy' : undefined,
      usageDurationMs: event.durationMs,
      costMicros: event.costMicros,
      limit,
    });
    if (limit) {
      await cancelRemote();
      throw new CloudTaskPolicyLimitError(limit);
    }
    enqueueSafely(controller, {
      type: 'data-cloud-usage',
      id: `cloud-usage-${event.sequence}`,
      data: {
        durationMs: event.durationMs,
        costMicros: event.costMicros,
      },
    } as InferUIMessageChunk<UIMessage>);
  }

  private async downloadArtifact(
    event: Extract<CloudTaskStreamEvent, { type: 'artifact' }>,
    cancelRemote: () => Promise<void>,
  ): Promise<DownloadedCloudTaskArtifact> {
    if (this.artifactIds.has(event.artifact.artifactId)) {
      throw new Error('Cloud task artifact id was emitted more than once');
    }
    const nextCount = this.artifactIds.size + 1;
    const nextBytes = this.artifactBytes + event.artifact.sizeBytes;
    const limit: CloudTaskPolicyLimit | undefined =
      nextCount > this.options.policy.maxArtifactFiles
        ? 'artifact-files'
        : nextBytes > this.options.policy.maxArtifactBytes
          ? 'artifact-bytes'
          : undefined;
    if (limit) {
      this.audit({
        operation: 'artifact',
        success: false,
        residency: this.options.policy.residency,
        reason: 'policy',
        artifactBytes: event.artifact.sizeBytes,
        limit,
      });
      await cancelRemote();
      throw new CloudTaskPolicyLimitError(limit);
    }
    if (!this.options.artifactDownloader) {
      throw new Error('Cloud task artifact downloader is unavailable');
    }
    const downloaded = await this.options.artifactDownloader.download({
      taskId: this.currentExecution.taskId,
      execution: this.currentExecution,
      artifact: event.artifact,
      policy: this.options.policy,
      signal: this.options.request.options.abortSignal,
    });
    this.artifactIds.add(event.artifact.artifactId);
    this.artifactBytes = nextBytes;
    return downloaded;
  }

  private async loadResumeSequence(): Promise<number> {
    if (!this.options.resumeStore) return 0;
    try {
      const sequence = await this.options.resumeStore.load(
        this.currentExecution,
      );
      if (sequence > 0) {
        this.audit({
          operation: 'resume',
          success: true,
          residency: this.options.policy.residency,
          resumeSequence: sequence,
        });
      }
      return sequence;
    } catch (error) {
      this.audit({
        operation: 'resume',
        success: false,
        residency: this.options.policy.residency,
        reason: classifyCloudTaskFailure(error),
      });
      return 0;
    }
  }

  private async saveResumeSequence(sequence: number): Promise<void> {
    if (!this.options.resumeStore) return;
    try {
      await this.options.resumeStore.save(
        this.currentExecution,
        sequence,
        null,
        {
          agentInstanceId: this.options.request.context.agentInstanceId,
          cloudOwnership: { epoch: this.currentLease.epoch },
          ...(this.currentMemoryCheckpoint
            ? {
                memoryCheckpoint: {
                  ...this.currentMemoryCheckpoint,
                  epoch: this.currentLease.epoch,
                  lastSequence: sequence,
                },
              }
            : {}),
        },
      );
    } catch (error) {
      this.audit({
        operation: 'resume',
        success: false,
        residency: this.options.policy.residency,
        reason: classifyCloudTaskFailure(error),
      });
    }
  }

  private async clearResumeSequence(): Promise<void> {
    try {
      await this.options.resumeStore?.clear(this.currentExecution);
    } catch (error) {
      this.audit({
        operation: 'resume',
        success: false,
        residency: this.options.policy.residency,
        reason: classifyCloudTaskFailure(error),
      });
    }
  }
}

function readUploadedSnapshot(
  metadata: Record<string, unknown>,
): CloudTaskSnapshotDescriptor & {
  upload: NonNullable<CloudTaskSnapshotDescriptor['upload']>;
} {
  const snapshot = metadata.cloudSnapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Cloud execution snapshot descriptor is missing');
  }
  const descriptor = snapshot as CloudTaskSnapshotDescriptor;
  if (!descriptor.upload) {
    throw new Error('Cloud execution snapshot upload reference is missing');
  }
  return descriptor as CloudTaskSnapshotDescriptor & {
    upload: NonNullable<CloudTaskSnapshotDescriptor['upload']>;
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForPromiseOrAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abortHandler);
    const abortHandler = () => {
      cleanup();
      reject(abortError());
    };
    signal.addEventListener('abort', abortHandler, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function drainStream<T>(stream: ReadableStream<T>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
      // Drain the tee branch to preserve backpressure.
    }
  } finally {
    reader.releaseLock();
  }
}

function toAsyncIterableStream<T>(
  source: ReadableStream<T>,
): AsyncIterableStream<T> {
  const stream = source as AsyncIterableStream<T>;
  (
    stream as unknown as {
      [Symbol.asyncIterator]: () => AsyncIterator<T>;
    }
  )[Symbol.asyncIterator] = () => {
    const reader = source.getReader();
    const iterator: AsyncIterator<T> & AsyncIterable<T> = {
      async next(): Promise<IteratorResult<T>> {
        const result = await reader.read();
        if (result.done) {
          reader.releaseLock();
          return { done: true, value: undefined };
        }
        return { done: false, value: result.value };
      },
      async return(): Promise<IteratorResult<T>> {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  };
  return stream;
}

function enqueueSafely<T>(
  controller: ReadableStreamDefaultController<T>,
  value: T,
): void {
  try {
    controller.enqueue(value);
  } catch {
    // A cancelled UI consumer must not alter the remote task outcome.
  }
}

function closeSafely<T>(controller: ReadableStreamDefaultController<T>): void {
  try {
    controller.close();
  } catch {
    // The stream may already be cancelled by both tee consumers.
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(): Error {
  return new DOMException('Cloud task was aborted', 'AbortError');
}

type CloudTaskPolicyLimit =
  | 'duration'
  | 'cost'
  | 'artifact-bytes'
  | 'artifact-files';

class CloudTaskPolicyLimitError extends Error {
  public constructor(public readonly limit: CloudTaskPolicyLimit) {
    super(`Cloud task ${limit} policy limit exceeded`);
    this.name = 'CloudTaskPolicyLimitError';
  }
}

function combineAbortSignals(signals: (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const handlers: Array<{ signal: AbortSignal; handler: () => void }> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    const handler = () => controller.abort();
    signal.addEventListener('abort', handler, { once: true });
    handlers.push({ signal, handler });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, handler } of handlers) {
        signal.removeEventListener('abort', handler);
      }
    },
  };
}

async function waitForReconnect(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const abortHandler = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abortHandler);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
}
