import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ShellService } from './shell-service';
import type { SessionCommandRequest, SessionCommandResult } from './types';
import {
  createExecutionArtifactManifest,
  hashExecutionArtifactManifest,
  type ExecutionArtifactManifest,
  type WorkspaceArtifactState,
} from './execution-artifact-manifest';
import { captureLocalWorkspaceArtifactState } from './workspace-artifact-state';
import {
  P256RunnerSigningAuthority,
  commandPayloadForHash,
  createSignedExecutionReceipt,
  createSignedRunnerJob,
  getRunnerPublicKeyId,
  hashExecutionReceipt,
  hashRunnerJob,
  hashRunnerPayload,
  verifySignedExecutionReceipt,
  verifySignedRunnerJob,
  type RunnerOperation,
  type RunnerSecurityAuditSink,
  type RunnerSigningAuthority,
  type SignedExecutionReceipt,
  type SignedRunnerJob,
} from './runner-security';

export type WorkspaceExecutionProviderKind =
  | 'local'
  | 'docker'
  | 'ssh'
  | 'cloud';

export type RunnerReplayIsolationProfile =
  | 'node-copy-on-write'
  | 'cargo-cache'
  | 'go-cache';

export type RunnerWorkspaceCacheStatus =
  | 'disabled'
  | 'cold'
  | 'warm'
  | 'quarantined';

export interface RunnerWorkspacePreparation {
  cacheStatus: RunnerWorkspaceCacheStatus;
  profile: 'none' | 'node-copy-on-write' | 'cargo-cache' | 'go-cache';
  durationMs: number;
  workspaceReuseCount: number;
  transferBytes: number;
  transferBytesAvoided: number;
}

/**
 * Content-free control-plane timings for one runner dispatch.
 *
 * `commandDurationMs` is measured by the remote runner when available and can
 * overlap local dispatch/polling wait time; it is an independent diagnostic,
 * not an additive phase. The remaining durations are measured by the local
 * control plane. Receipt
 * finalization is intentionally excluded from the signed timing hash because
 * the receipt cannot include the duration required to sign itself.
 */
export interface RunnerExecutionStageTimings {
  version: 1;
  sshRoundTrips: number;
  artifactBeforeRoundTrips: number;
  dispatchRoundTrips: number;
  pollingRoundTrips: number;
  artifactAfterRoundTrips: number;
  artifactBeforeDurationMs: number;
  dispatchDurationMs: number;
  commandDurationMs: number | null;
  pollingDurationMs: number;
  artifactAfterDurationMs: number;
  receiptFinalizationDurationMs: number;
}

export function hashRunnerExecutionStageTimings(
  timings: RunnerExecutionStageTimings,
): string {
  assertRunnerExecutionStageTimings(timings);
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: timings.version,
        sshRoundTrips: timings.sshRoundTrips,
        artifactBeforeRoundTrips: timings.artifactBeforeRoundTrips,
        dispatchRoundTrips: timings.dispatchRoundTrips,
        pollingRoundTrips: timings.pollingRoundTrips,
        artifactAfterRoundTrips: timings.artifactAfterRoundTrips,
        artifactBeforeDurationMs: timings.artifactBeforeDurationMs,
        dispatchDurationMs: timings.dispatchDurationMs,
        commandDurationMs: timings.commandDurationMs,
        pollingDurationMs: timings.pollingDurationMs,
        artifactAfterDurationMs: timings.artifactAfterDurationMs,
      }),
    )
    .digest('hex');
}

export function hashRunnerWorkspacePreparation(
  preparation: RunnerWorkspacePreparation,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        cacheStatus: preparation.cacheStatus,
        profile: preparation.profile,
        durationMs: preparation.durationMs,
        workspaceReuseCount: preparation.workspaceReuseCount,
        transferBytes: preparation.transferBytes,
        transferBytesAvoided: preparation.transferBytesAvoided,
      }),
    )
    .digest('hex');
}

function assertRunnerExecutionStageTimings(
  timings: RunnerExecutionStageTimings,
): void {
  if (timings.version !== 1) {
    throw new Error('Runner execution timing version is unsupported');
  }
  const integers = [
    timings.sshRoundTrips,
    timings.artifactBeforeRoundTrips,
    timings.dispatchRoundTrips,
    timings.pollingRoundTrips,
    timings.artifactAfterRoundTrips,
    timings.artifactBeforeDurationMs,
    timings.dispatchDurationMs,
    timings.pollingDurationMs,
    timings.artifactAfterDurationMs,
    timings.receiptFinalizationDurationMs,
  ];
  if (
    integers.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    (timings.commandDurationMs !== null &&
      (!Number.isSafeInteger(timings.commandDurationMs) ||
        timings.commandDurationMs < 0))
  ) {
    throw new Error('Runner execution timings are invalid');
  }
}

export interface RunnerCapabilities {
  persistentSessions: boolean;
  streamingOutput: boolean;
  stdin: boolean;
  cancellation: boolean;
  workspaceLeases: boolean;
}

export interface PrepareWorkspaceRequest {
  snapshotHash: string;
  environmentFingerprintHash: string;
  mounts?: readonly WorkspaceExecutionMountBinding[];
  resumeSessionId?: string;
  expiresInMs?: number | null;
  dependencyMaterialization?:
    | 'none'
    | 'copy-on-write'
    | 'cargo-cache'
    | 'go-cache';
}

export interface WorkspaceExecutionMaterialization {
  version: 1;
  archiveFormat: 'tar-gzip';
  archive: Uint8Array;
  archiveHash: string;
  totalBytes: number;
}

export interface WorkspaceExecutionMountBinding {
  mountPrefix: string;
  workspaceRoot: string;
  repositoryRevision: string | null;
  dirtyPatchHash: string;
  dependencyFingerprintHash?: string;
  hasDirtyChanges: boolean;
  materialization?: WorkspaceExecutionMaterialization;
}

export interface WorkspaceLease {
  id: string;
  providerId: string;
  snapshotHash: string;
  environmentFingerprintHash: string;
  createdAt: number;
  expiresAt: number | null;
  preparation?: RunnerWorkspacePreparation;
}

export interface CreateExecutionSessionRequest {
  snapshotHash: string;
  agentInstanceId: string;
  toolCallId: string;
  cwd: string;
  signedJob: SignedRunnerJob;
}

export interface CommandExecutionRequest {
  snapshotHash: string;
  agentInstanceId: string;
  toolCallId: string;
  command: SessionCommandRequest;
  signedJob: SignedRunnerJob;
}

export interface RunnerDispatchResult<T> {
  value: T;
  receipt: SignedExecutionReceipt;
  artifactManifest: ExecutionArtifactManifest | null;
  executionTimings?: RunnerExecutionStageTimings;
}

export interface RunnerExecutionEvidence {
  agentInstanceId: string | null;
  toolCallId: string | null;
  receiptId: string;
  receiptHash: string;
  jobId: string;
  jobHash: string;
  providerId: string;
  providerKind: WorkspaceExecutionProviderKind;
  operation: RunnerOperation;
  snapshotHash: string;
  environmentFingerprintHash: string;
  repositoryRevision: string | null;
  dirtyPatchHash: string | null;
  outcome: 'completed' | 'failed';
  exitCode: number | null;
  resolvedBy: SignedExecutionReceipt['receipt']['resolvedBy'];
  outputHash: string | null;
  artifactManifestHash: string | null;
  artifactManifest: ExecutionArtifactManifest | null;
  remoteJobId: string | null;
  terminalState: 'completed' | 'failed' | 'cancelled' | 'timed-out' | null;
  errorCode: string | null;
  startedAt: number;
  finishedAt: number;
  runnerKeyId: string;
  shadowRouteDecisionId: string | null;
  shadowRouteCommandClassHash: string | null;
  configuredProviderId: string;
  configuredProviderKind: WorkspaceExecutionProviderKind;
  routeMode: 'configured' | 'shadow' | 'automatic' | 'automatic-fallback';
  replayPreparationDurationMs?: number;
  replayTotalDurationMs?: number;
  workspaceCacheStatus?: RunnerWorkspaceCacheStatus;
  workspaceCacheProfile?: RunnerWorkspacePreparation['profile'];
  workspaceReuseCount?: number;
  workspaceTransferBytes?: number;
  workspaceTransferBytesAvoided?: number;
  workspacePreparationHash?: string | null;
  executionTimingHash?: string | null;
  executionTimings?: RunnerExecutionStageTimings;
}

export type RunnerExecutionEvidenceSink = (
  evidence: RunnerExecutionEvidence,
) => void | Promise<void>;

export interface RunnerShadowRoutingObservationInput {
  actualProviderId: string;
  actualProviderKind: WorkspaceExecutionProviderKind;
  operation: RunnerOperation;
  snapshotHash: string;
  mounts?: readonly WorkspaceExecutionMountBinding[];
  expectedDurationMs: number;
  rawInput: boolean;
  commandClassHash: string | null;
  replayIsolationProfile: RunnerReplayIsolationProfile | null;
  requiresNetwork: boolean;
  requiresInteractive: boolean;
  requiresCancellation: boolean;
  requiresWorkspaceLease: boolean;
  environmentFingerprintHash: string;
  hasSessionAffinity: boolean;
}

export interface RunnerRoutingResolution {
  decisionId: string | null;
  selectedProvider?: WorkspaceExecutionProvider;
  pairedReplayProvider?: WorkspaceExecutionProvider;
}

export type RunnerShadowRoutingObserver = (
  input: RunnerShadowRoutingObservationInput,
) =>
  | string
  | null
  | undefined
  | RunnerRoutingResolution
  | Promise<string | null | undefined | RunnerRoutingResolution>;

export interface RunnerPairedReplayCandidate {
  decisionId: string;
  command: SessionCommandRequest;
  commandClassHash: string;
  riskClass: 'read-only' | 'workspace-contained' | 'ineligible';
  snapshotIdentity: {
    snapshotHash: string;
    environmentFingerprintHash: string;
    mounts?: readonly WorkspaceExecutionMountBinding[];
  };
  actualEvidence: RunnerExecutionEvidence;
  targetProvider: WorkspaceExecutionProvider;
}

export type RunnerPairedReplayObserver = (
  candidate: RunnerPairedReplayCandidate,
) => void | Promise<void>;

/**
 * Provider-neutral workspace execution seam.
 *
 * The provider owns execution mechanics while the host retains policy,
 * approvals, and snapshot construction. Every process-starting operation is
 * bound to a prepared workspace lease and fails closed when the requested
 * snapshot no longer matches that lease.
 */
export interface WorkspaceExecutionProvider {
  readonly id: string;
  readonly kind: WorkspaceExecutionProviderKind;
  readonly receiptPublicKey: string;
  readonly isDisposableReplayProvider?: true;
  readonly replayDependencyIsolation?: 'copy-on-write';
  readonly replayIsolationProfiles?: readonly RunnerReplayIsolationProfile[];

  getCapabilities(): Promise<RunnerCapabilities>;
  prepareWorkspace(request: PrepareWorkspaceRequest): Promise<WorkspaceLease>;
  createSession(
    lease: WorkspaceLease,
    request: CreateExecutionSessionRequest,
  ): Promise<RunnerDispatchResult<string>>;
  execute(
    lease: WorkspaceLease,
    request: CommandExecutionRequest,
  ): Promise<RunnerDispatchResult<SessionCommandResult>>;
  killSession(
    lease: WorkspaceLease,
    request: {
      snapshotHash: string;
      sessionId: string;
      signedJob: SignedRunnerJob;
    },
  ): Promise<RunnerDispatchResult<boolean>>;
  getRecentOutputForClassifier(
    sessionId: string,
    maxLines: number,
  ): string | undefined;
  getSessionCurrentCwd(sessionId: string): string | undefined;
  clearPendingOutputs(agentInstanceId: string, toolCallId: string): void;
  disposeWorkspace(lease: WorkspaceLease): Promise<void>;
  dispose?(): Promise<void>;
}

export class WorkspaceLeaseValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WorkspaceLeaseValidationError';
  }
}

export class RunnerJobAdmissionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RunnerJobAdmissionError';
  }
}

export class RunnerExecutionError extends Error {
  public constructor(
    message: string,
    public readonly receipt: SignedExecutionReceipt,
    options?: ErrorOptions,
    public readonly artifactManifest: ExecutionArtifactManifest | null = null,
    public readonly executionTimings: RunnerExecutionStageTimings | null = null,
  ) {
    super(message, options);
    this.name = 'RunnerExecutionError';
  }
}

/**
 * Local v1 adapter. It deliberately delegates every shell operation to the
 * existing ShellService so PTY, streaming, timeout, stdin, and cancellation
 * behavior remain unchanged.
 */
export class LocalRunnerAdapter implements WorkspaceExecutionProvider {
  public readonly id: string;
  public readonly kind = 'local' as const;
  public readonly receiptPublicKey: string;

  private readonly leases = new Map<string, StoredLocalLease>();
  private readonly consumedNonces = new Map<string, number>();
  private readonly receiptAuthority: RunnerSigningAuthority;
  private readonly trustedGuardianPublicKey: string;
  private readonly audit: RunnerSecurityAuditSink | undefined;

  public constructor(
    private readonly shellService: ShellService,
    options: {
      id?: string;
      now?: () => number;
      createId?: () => string;
      receiptAuthority?: RunnerSigningAuthority;
      trustedGuardianPublicKey?: string;
      audit?: RunnerSecurityAuditSink;
      mapCreateSessionCwd?: (lease: WorkspaceLease, cwd: string) => string;
      mapExecutionCommand?: (
        lease: WorkspaceLease,
        command: SessionCommandRequest,
      ) => SessionCommandRequest;
    } = {},
  ) {
    this.id = options.id ?? 'local-runner';
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.receiptAuthority =
      options.receiptAuthority ??
      P256RunnerSigningAuthority.generate().authority;
    this.receiptPublicKey = this.receiptAuthority.publicKey;
    this.trustedGuardianPublicKey =
      options.trustedGuardianPublicKey ?? this.receiptAuthority.publicKey;
    this.audit = options.audit;
    this.mapCreateSessionCwd =
      options.mapCreateSessionCwd ?? ((_lease, cwd) => cwd);
    this.mapExecutionCommand =
      options.mapExecutionCommand ?? ((_lease, command) => command);
  }

  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly mapCreateSessionCwd: (
    lease: WorkspaceLease,
    cwd: string,
  ) => string;
  private readonly mapExecutionCommand: (
    lease: WorkspaceLease,
    command: SessionCommandRequest,
  ) => SessionCommandRequest;

  public async getCapabilities(): Promise<RunnerCapabilities> {
    return {
      persistentSessions: true,
      streamingOutput: true,
      stdin: true,
      cancellation: true,
      workspaceLeases: true,
    };
  }

  public async prepareWorkspace(
    request: PrepareWorkspaceRequest,
  ): Promise<WorkspaceLease> {
    assertSnapshotHash(request.snapshotHash);
    assertEnvironmentFingerprintHash(request.environmentFingerprintHash);
    const createdAt = this.now();
    const expiresInMs = request.expiresInMs ?? null;
    if (
      expiresInMs !== null &&
      (!Number.isSafeInteger(expiresInMs) || expiresInMs <= 0)
    ) {
      throw new Error('Workspace lease expiry must be a positive integer');
    }
    const lease: WorkspaceLease = {
      id: this.createId(),
      providerId: this.id,
      snapshotHash: request.snapshotHash,
      environmentFingerprintHash: request.environmentFingerprintHash,
      createdAt,
      expiresAt: expiresInMs === null ? null : createdAt + expiresInMs,
    };
    this.leases.set(lease.id, {
      ...lease,
      mounts: request.mounts?.map((mount) => ({ ...mount })) ?? [],
    });
    return { ...lease };
  }

  public async createSession(
    lease: WorkspaceLease,
    request: CreateExecutionSessionRequest,
  ): Promise<RunnerDispatchResult<string>> {
    this.assertLease(lease, request.snapshotHash);
    return await this.dispatch(
      lease,
      request.signedJob,
      'create-session',
      hashRunnerPayload('create-session', {
        agentInstanceId: request.agentInstanceId,
        toolCallId: request.toolCallId,
        cwd: request.cwd,
      }),
      () =>
        this.shellService.createSession(
          request.agentInstanceId,
          request.toolCallId,
          this.mapCreateSessionCwd(lease, request.cwd),
        ),
    );
  }

  public async execute(
    lease: WorkspaceLease,
    request: CommandExecutionRequest,
  ): Promise<RunnerDispatchResult<SessionCommandResult>> {
    const current = this.assertLease(lease, request.snapshotHash);
    const executionCommand = this.mapExecutionCommand(current, request.command);
    const artifactWorkspace = this.resolveArtifactWorkspace(
      current,
      executionCommand,
    );
    return await this.dispatch(
      current,
      request.signedJob,
      'execute-command',
      hashRunnerPayload('execute-command', {
        agentInstanceId: request.agentInstanceId,
        toolCallId: request.toolCallId,
        command: commandPayloadForHash(request.command),
      }),
      () =>
        this.shellService.executeInSession(
          request.agentInstanceId,
          request.toolCallId,
          executionCommand,
        ),
      artifactWorkspace
        ? {
            captureBefore: () =>
              captureLocalWorkspaceArtifactState({
                workspaceRoot: artifactWorkspace,
              }),
            captureAfter: (before) =>
              captureLocalWorkspaceArtifactState({
                workspaceRoot: artifactWorkspace,
                includeEntries: before.entries,
              }),
          }
        : undefined,
    );
  }

  public async killSession(
    lease: WorkspaceLease,
    request: {
      snapshotHash: string;
      sessionId: string;
      signedJob: SignedRunnerJob;
    },
  ): Promise<RunnerDispatchResult<boolean>> {
    this.assertLease(lease, request.snapshotHash);
    return await this.dispatch(
      lease,
      request.signedJob,
      'kill-session',
      hashRunnerPayload('kill-session', { sessionId: request.sessionId }),
      () => this.shellService.killSession(request.sessionId),
    );
  }

  public getRecentOutputForClassifier(
    sessionId: string,
    maxLines: number,
  ): string | undefined {
    return this.shellService.getRecentOutputForClassifier(sessionId, maxLines);
  }

  public getSessionCurrentCwd(sessionId: string): string | undefined {
    return this.shellService.getSessionCurrentCwd(sessionId);
  }

  public clearPendingOutputs(
    agentInstanceId: string,
    toolCallId: string,
  ): void {
    this.shellService.clearPendingOutputs(agentInstanceId, toolCallId);
  }

  public async disposeWorkspace(lease: WorkspaceLease): Promise<void> {
    if (lease.providerId !== this.id) return;
    this.leases.delete(lease.id);
  }

  private assertLease(
    lease: WorkspaceLease,
    snapshotHash: string,
  ): StoredLocalLease {
    assertSnapshotHash(snapshotHash);
    const current = this.leases.get(lease.id);
    if (
      !current ||
      current.providerId !== this.id ||
      lease.providerId !== this.id
    ) {
      throw new WorkspaceLeaseValidationError(
        'Workspace lease is unknown or has been disposed',
      );
    }
    if (
      current.snapshotHash !== lease.snapshotHash ||
      current.snapshotHash !== snapshotHash
    ) {
      throw new WorkspaceLeaseValidationError(
        'Workspace snapshot does not match the prepared lease',
      );
    }
    if (current.expiresAt !== null && this.now() >= current.expiresAt) {
      throw new WorkspaceLeaseValidationError('Workspace lease has expired');
    }
    return current;
  }

  private async dispatch<T>(
    lease: WorkspaceLease,
    signedJob: SignedRunnerJob,
    operation: RunnerOperation,
    payloadHash: string,
    execute: () => T | Promise<T>,
    artifacts?: ArtifactCaptureHooks,
  ): Promise<RunnerDispatchResult<T>> {
    await this.admitJob(lease, signedJob, operation, payloadHash);
    const startedAt = this.now();
    const artifactBefore = await captureArtifactState(artifacts?.captureBefore);
    let value: T;
    try {
      value = await execute();
    } catch (error) {
      const artifactManifest = await collectArtifactManifest({
        snapshotHash: lease.snapshotHash,
        before: artifactBefore,
        captureAfter: artifacts?.captureAfter,
      });
      const receipt = createSignedExecutionReceipt({
        signedJob,
        authority: this.receiptAuthority,
        startedAt,
        finishedAt: this.now(),
        outcome: 'failed',
        artifactManifestHash: artifactManifest
          ? hashExecutionArtifactManifest(artifactManifest)
          : null,
        errorCode:
          error instanceof Error ? error.name.slice(0, 128) : 'UnknownError',
      });
      try {
        await this.auditReceipt(signedJob, receipt);
      } catch (auditError) {
        throw new RunnerExecutionError(
          'Execution failed and receipt audit could not be persisted',
          receipt,
          { cause: new AggregateError([error, auditError]) },
          artifactManifest,
        );
      }
      throw new RunnerExecutionError(
        error instanceof Error ? error.message : String(error),
        receipt,
        { cause: error },
        artifactManifest,
      );
    }
    const artifactManifest = await collectArtifactManifest({
      snapshotHash: lease.snapshotHash,
      before: artifactBefore,
      captureAfter: artifacts?.captureAfter,
    });
    const shellResult =
      operation === 'execute-command'
        ? (value as SessionCommandResult)
        : undefined;
    const receipt = createSignedExecutionReceipt({
      signedJob,
      authority: this.receiptAuthority,
      startedAt,
      finishedAt: this.now(),
      outcome: 'completed',
      exitCode: shellResult?.exitCode,
      resolvedBy: shellResult?.resolvedBy,
      output: shellResult?.output,
      artifactManifestHash: artifactManifest
        ? hashExecutionArtifactManifest(artifactManifest)
        : null,
    });
    try {
      await this.auditReceipt(signedJob, receipt);
    } catch (error) {
      throw new RunnerExecutionError(
        'Execution completed but receipt audit could not be persisted',
        receipt,
        { cause: error },
        artifactManifest,
      );
    }
    return Object.freeze({ value, receipt, artifactManifest });
  }

  private resolveArtifactWorkspace(
    lease: StoredLocalLease,
    command: SessionCommandRequest,
  ): string | null {
    if (command.rawInput || !command.command.trim()) return null;
    const cwd =
      command.cwd ??
      (command.sessionId
        ? this.shellService.getSessionCurrentCwd(command.sessionId)
        : undefined);
    if (!cwd) {
      return lease.mounts.length === 1
        ? path.resolve(lease.mounts[0]!.workspaceRoot)
        : null;
    }
    const resolvedCwd = path.resolve(cwd);
    return (
      lease.mounts
        .map((mount) => path.resolve(mount.workspaceRoot))
        .filter(
          (root) =>
            resolvedCwd === root ||
            resolvedCwd.startsWith(`${root}${path.sep}`),
        )
        .sort((left, right) => right.length - left.length)[0] ?? null
    );
  }

  private async admitJob(
    lease: WorkspaceLease,
    signedJob: SignedRunnerJob,
    operation: RunnerOperation,
    payloadHash: string,
  ): Promise<void> {
    const reject = async (reason: string): Promise<never> => {
      const job = signedJob?.job;
      await this.audit?.record({
        type: 'job-rejected',
        createdAt: this.now(),
        jobId: job?.jobId ?? '00000000-0000-4000-8000-000000000000',
        providerId: job?.providerId ?? this.id,
        leaseId: job?.leaseId ?? lease.id,
        snapshotHash: job?.snapshotHash ?? lease.snapshotHash,
        operation: job?.operation ?? operation,
        jobHash: job ? hashRunnerJob(job) : '0'.repeat(64),
        receiptHash: null,
        outcome: null,
        reason,
      });
      throw new RunnerJobAdmissionError(reason);
    };
    if (
      !verifySignedRunnerJob(signedJob, this.trustedGuardianPublicKey) ||
      signedJob.job.authorityKeyId !==
        getRunnerPublicKeyId(this.trustedGuardianPublicKey)
    ) {
      return await reject('runner-job-signature-invalid');
    }
    const { job } = signedJob;
    if (
      job.providerId !== this.id ||
      job.leaseId !== lease.id ||
      job.snapshotHash !== lease.snapshotHash ||
      job.environmentFingerprintHash !== lease.environmentFingerprintHash ||
      job.operation !== operation ||
      job.payloadHash !== payloadHash
    ) {
      return await reject('runner-job-binding-mismatch');
    }
    const now = this.now();
    if (job.issuedAt > now + 30_000 || job.expiresAt <= now) {
      return await reject('runner-job-expired');
    }
    for (const [nonce, expiresAt] of this.consumedNonces) {
      if (expiresAt <= now) this.consumedNonces.delete(nonce);
    }
    if (this.consumedNonces.has(job.nonce)) {
      return await reject('runner-job-replay');
    }
    this.consumedNonces.set(job.nonce, job.expiresAt);
    await this.audit?.record({
      type: 'job-admitted',
      createdAt: now,
      jobId: job.jobId,
      providerId: job.providerId,
      leaseId: job.leaseId,
      snapshotHash: job.snapshotHash,
      operation: job.operation,
      jobHash: hashRunnerJob(job),
      receiptHash: null,
      outcome: null,
      reason: null,
    });
  }

  private async auditReceipt(
    signedJob: SignedRunnerJob,
    receipt: SignedExecutionReceipt,
  ): Promise<void> {
    await this.audit?.record({
      type: 'receipt-issued',
      createdAt: receipt.receipt.finishedAt,
      jobId: signedJob.job.jobId,
      providerId: signedJob.job.providerId,
      leaseId: signedJob.job.leaseId,
      snapshotHash: signedJob.job.snapshotHash,
      operation: signedJob.job.operation,
      jobHash: receipt.receipt.jobHash,
      receiptHash: hashExecutionReceipt(receipt.receipt),
      outcome: receipt.receipt.outcome,
      reason: receipt.receipt.errorCode,
    });
  }
}

/**
 * Narrow shell surface consumed by the tools. ShellService itself conforms to
 * this contract, which keeps the gate-off route byte-for-byte on the legacy
 * implementation.
 */
export interface ShellExecutionBackend {
  isAvailable(): boolean;
  createSession(
    agentInstanceId: string,
    toolCallId: string,
    cwd: string,
  ): string | Promise<string>;
  executeInSession(
    agentInstanceId: string,
    toolCallId: string,
    request: SessionCommandRequest,
  ): Promise<SessionCommandResult>;
  getRecentOutputForClassifier(
    sessionId: string,
    maxLines: number,
  ): string | undefined;
  getSessionCurrentCwd(sessionId: string): string | undefined;
  clearPendingOutputs(agentInstanceId: string, toolCallId: string): void;
  killSession(sessionId: string): boolean | Promise<boolean>;
}

/**
 * Gate-on router for shell tools.
 *
 * Fallback is allowed only while obtaining the snapshot or preparing a lease,
 * before the provider can start or mutate a process. Once dispatch begins,
 * provider errors are returned directly and are never replayed locally.
 */
export class ProviderBackedShellExecution implements ShellExecutionBackend {
  public constructor(
    private readonly provider: WorkspaceExecutionProvider,
    private readonly fallback: ShellExecutionBackend,
    private readonly getSnapshotIdentity: () => Promise<{
      snapshotHash: string;
      environmentFingerprintHash: string;
      mounts?: readonly WorkspaceExecutionMountBinding[];
      dependencyMaterialization?:
        | 'none'
        | 'copy-on-write'
        | 'cargo-cache'
        | 'go-cache';
    }>,
    private readonly authority: RunnerSigningAuthority,
    private readonly audit?: RunnerSecurityAuditSink,
    private readonly fallbackOnPreparationFailure = true,
    private readonly onExecutionReceipt?: RunnerExecutionEvidenceSink,
    private readonly observeShadowRoute?: RunnerShadowRoutingObserver,
    private readonly observePairedReplay?: RunnerPairedReplayObserver,
  ) {}

  public isAvailable(): boolean {
    return this.fallback.isAvailable();
  }

  public async createSession(
    agentInstanceId: string,
    toolCallId: string,
    cwd: string,
  ): Promise<string> {
    const prepared = await this.prepareOrNull(undefined, {
      operation: 'create-session',
      expectedDurationMs: 1_000,
      rawInput: false,
      commandClassHash: null,
      replayIsolationProfile: null,
      requiresNetwork: false,
      requiresInteractive: true,
      requiresCancellation: false,
      requiresWorkspaceLease: true,
    });
    if (!prepared) {
      return await this.fallback.createSession(
        agentInstanceId,
        toolCallId,
        cwd,
      );
    }
    try {
      const signedJob = await this.issueJob(prepared, 'create-session', {
        agentInstanceId,
        toolCallId,
        cwd,
      });
      const dispatched = await this.dispatchWithReceiptEvidence(
        prepared,
        signedJob,
        { agentInstanceId, toolCallId },
        () =>
          prepared.provider.createSession(prepared.lease, {
            snapshotHash: prepared.snapshotHash,
            agentInstanceId,
            toolCallId,
            cwd,
            signedJob,
          }),
      );
      return dispatched.value;
    } finally {
      await this.disposePrepared(prepared);
    }
  }

  public async executeInSession(
    agentInstanceId: string,
    toolCallId: string,
    request: SessionCommandRequest,
  ): Promise<SessionCommandResult> {
    const commandRouting = classifyRunnerCommandForRouting(request);
    const prepared = await this.prepareOrNull(request.sessionId, {
      operation: 'execute-command',
      expectedDurationMs: expectedCommandDurationMs(request),
      rawInput: request.rawInput === true,
      ...commandRouting,
      replayIsolationProfile: classifyRunnerReplayIsolationProfile(request),
      requiresCancellation: expectedCommandDurationMs(request) > 10_000,
      requiresWorkspaceLease: true,
    });
    if (!prepared) {
      return await this.fallback.executeInSession(
        agentInstanceId,
        toolCallId,
        request,
      );
    }
    try {
      const signedJob = await this.issueJob(prepared, 'execute-command', {
        agentInstanceId,
        toolCallId,
        command: commandPayloadForHash(request),
      });
      const dispatched = await this.dispatchWithReceiptEvidence(
        prepared,
        signedJob,
        { agentInstanceId, toolCallId, command: request },
        () =>
          prepared.provider.execute(prepared.lease, {
            snapshotHash: prepared.snapshotHash,
            agentInstanceId,
            toolCallId,
            command: request,
            signedJob,
          }),
      );
      return dispatched.value;
    } finally {
      await this.disposePrepared(prepared);
    }
  }

  public async killSession(sessionId: string): Promise<boolean> {
    const prepared = await this.prepareOrNull(sessionId, {
      operation: 'kill-session',
      expectedDurationMs: 500,
      rawInput: false,
      commandClassHash: null,
      replayIsolationProfile: null,
      requiresNetwork: false,
      requiresInteractive: false,
      requiresCancellation: false,
      requiresWorkspaceLease: true,
    });
    if (!prepared) return await this.fallback.killSession(sessionId);
    try {
      const signedJob = await this.issueJob(prepared, 'kill-session', {
        sessionId,
      });
      const dispatched = await this.dispatchWithReceiptEvidence(
        prepared,
        signedJob,
        { agentInstanceId: null, toolCallId: null },
        () =>
          prepared.provider.killSession(prepared.lease, {
            snapshotHash: prepared.snapshotHash,
            sessionId,
            signedJob,
          }),
      );
      return dispatched.value;
    } finally {
      await this.disposePrepared(prepared);
    }
  }

  public getRecentOutputForClassifier(
    sessionId: string,
    maxLines: number,
  ): string | undefined {
    return this.provider.getRecentOutputForClassifier(sessionId, maxLines);
  }

  public getSessionCurrentCwd(sessionId: string): string | undefined {
    return this.provider.getSessionCurrentCwd(sessionId);
  }

  public clearPendingOutputs(
    agentInstanceId: string,
    toolCallId: string,
  ): void {
    this.provider.clearPendingOutputs(agentInstanceId, toolCallId);
  }

  private async prepareOrNull(
    resumeSessionId: string | undefined,
    observation: {
      operation: RunnerOperation;
      expectedDurationMs: number;
      rawInput: boolean;
      commandClassHash: string | null;
      replayIsolationProfile: RunnerReplayIsolationProfile | null;
      requiresNetwork: boolean;
      requiresInteractive: boolean;
      requiresCancellation: boolean;
      requiresWorkspaceLease: boolean;
    },
  ): Promise<{
    snapshotHash: string;
    environmentFingerprintHash: string;
    mounts?: readonly WorkspaceExecutionMountBinding[];
    lease: WorkspaceLease;
    provider: WorkspaceExecutionProvider;
    pairedReplayProvider?: WorkspaceExecutionProvider;
    shadowRouteDecisionId: string | null;
    shadowRouteCommandClassHash: string | null;
    routeMode: 'configured' | 'shadow' | 'automatic' | 'automatic-fallback';
  } | null> {
    try {
      const identity = await this.getSnapshotIdentity();
      let provider = this.provider;
      let lease = await provider.prepareWorkspace({
        ...identity,
        resumeSessionId,
      });
      let shadowRouteDecisionId: string | null = null;
      let routingResolution:
        | string
        | null
        | undefined
        | RunnerRoutingResolution;
      let routeMode:
        | 'configured'
        | 'shadow'
        | 'automatic'
        | 'automatic-fallback' = 'configured';
      try {
        routingResolution = await this.observeShadowRoute?.({
          actualProviderId: this.provider.id,
          actualProviderKind: this.provider.kind,
          operation: observation.operation,
          snapshotHash: identity.snapshotHash,
          mounts: identity.mounts,
          expectedDurationMs: observation.expectedDurationMs,
          rawInput: observation.rawInput,
          commandClassHash: observation.commandClassHash,
          replayIsolationProfile: observation.replayIsolationProfile,
          requiresNetwork: observation.requiresNetwork,
          requiresInteractive: observation.requiresInteractive,
          requiresCancellation: observation.requiresCancellation,
          requiresWorkspaceLease: observation.requiresWorkspaceLease,
          environmentFingerprintHash: lease.environmentFingerprintHash,
          hasSessionAffinity: resumeSessionId !== undefined,
        });
        const normalized = normalizeRunnerRoutingResolution(routingResolution);
        shadowRouteDecisionId = normalized.decisionId;
        if (shadowRouteDecisionId) routeMode = 'shadow';
        const selected = normalized.selectedProvider;
        if (
          selected &&
          selected.id !== this.provider.id &&
          canAutomaticallyRoute(observation, resumeSessionId)
        ) {
          try {
            const selectedLease = await selected.prepareWorkspace({
              ...identity,
            });
            await this.provider.disposeWorkspace(lease).catch(() => undefined);
            provider = selected;
            lease = selectedLease;
            routeMode = 'automatic';
          } catch {
            // The configured lease remains valid and no process has started.
            // Automatic routing may fall back only at this pre-dispatch point.
            routeMode = 'automatic-fallback';
          }
        }
      } catch {
        // Shadow routing is observational and must never affect dispatch.
      }
      return {
        ...identity,
        environmentFingerprintHash: lease.environmentFingerprintHash,
        lease,
        provider,
        shadowRouteDecisionId,
        shadowRouteCommandClassHash: observation.commandClassHash,
        routeMode,
        pairedReplayProvider: normalizedPairedReplayProvider(
          provider,
          this.provider,
          shadowRouteDecisionId,
          routingResolution,
        ),
      };
    } catch (error) {
      if (!this.fallbackOnPreparationFailure) throw error;
      return null;
    }
  }

  private async disposePrepared(prepared: {
    lease: WorkspaceLease;
    provider: WorkspaceExecutionProvider;
  }): Promise<void> {
    await prepared.provider
      .disposeWorkspace(prepared.lease)
      .catch(() => undefined);
  }

  private async issueJob(
    prepared: {
      snapshotHash: string;
      environmentFingerprintHash: string;
      mounts?: readonly WorkspaceExecutionMountBinding[];
      lease: WorkspaceLease;
      provider: WorkspaceExecutionProvider;
      pairedReplayProvider?: WorkspaceExecutionProvider;
      shadowRouteDecisionId: string | null;
      shadowRouteCommandClassHash: string | null;
      routeMode: 'configured' | 'shadow' | 'automatic' | 'automatic-fallback';
    },
    operation: RunnerOperation,
    payload: unknown,
  ): Promise<SignedRunnerJob> {
    const signedJob = createSignedRunnerJob({
      providerId: prepared.provider.id,
      leaseId: prepared.lease.id,
      snapshotHash: prepared.snapshotHash,
      operation,
      payloadHash: hashRunnerPayload(operation, payload),
      environmentFingerprintHash: prepared.environmentFingerprintHash,
      authority: this.authority,
    });
    await this.audit?.record({
      type: 'job-issued',
      createdAt: signedJob.job.issuedAt,
      jobId: signedJob.job.jobId,
      providerId: signedJob.job.providerId,
      leaseId: signedJob.job.leaseId,
      snapshotHash: signedJob.job.snapshotHash,
      operation,
      jobHash: hashRunnerJob(signedJob.job),
      receiptHash: null,
      outcome: null,
      reason: null,
    });
    return signedJob;
  }

  private assertReceipt(
    provider: WorkspaceExecutionProvider,
    signedJob: SignedRunnerJob,
    receipt: SignedExecutionReceipt,
    artifactManifest: ExecutionArtifactManifest | null,
    preparation?: RunnerWorkspacePreparation,
    executionTimings?: RunnerExecutionStageTimings,
  ): void {
    let artifactManifestHash: string | null;
    try {
      artifactManifestHash = artifactManifest
        ? hashExecutionArtifactManifest(artifactManifest)
        : null;
    } catch {
      throw new RunnerJobAdmissionError(
        'Execution receipt Artifact Manifest is invalid',
      );
    }
    if (
      !verifySignedExecutionReceipt(receipt, provider.receiptPublicKey) ||
      receipt.receipt.jobId !== signedJob.job.jobId ||
      receipt.receipt.jobHash !== hashRunnerJob(signedJob.job) ||
      receipt.receipt.providerId !== provider.id ||
      receipt.receipt.leaseId !== signedJob.job.leaseId ||
      receipt.receipt.snapshotHash !== signedJob.job.snapshotHash ||
      receipt.receipt.operation !== signedJob.job.operation ||
      receipt.receipt.environmentFingerprintHash !==
        signedJob.job.environmentFingerprintHash ||
      receipt.receipt.artifactManifestHash !== artifactManifestHash ||
      receipt.receipt.workspacePreparationHash !==
        (preparation ? hashRunnerWorkspacePreparation(preparation) : null) ||
      receipt.receipt.executionTimingHash !==
        (executionTimings
          ? hashRunnerExecutionStageTimings(executionTimings)
          : null) ||
      (artifactManifest !== null &&
        artifactManifest.snapshotHash !== signedJob.job.snapshotHash)
    ) {
      throw new RunnerJobAdmissionError(
        'Execution receipt signature or binding is invalid',
      );
    }
  }

  private async dispatchWithReceiptEvidence<T>(
    prepared: {
      snapshotHash: string;
      environmentFingerprintHash: string;
      mounts?: readonly WorkspaceExecutionMountBinding[];
      shadowRouteDecisionId: string | null;
      shadowRouteCommandClassHash: string | null;
      lease: WorkspaceLease;
      provider: WorkspaceExecutionProvider;
      routeMode: 'configured' | 'shadow' | 'automatic' | 'automatic-fallback';
    },
    signedJob: SignedRunnerJob,
    context: {
      agentInstanceId: string | null;
      toolCallId: string | null;
      command?: SessionCommandRequest;
    },
    dispatch: () => Promise<RunnerDispatchResult<T>>,
  ): Promise<RunnerDispatchResult<T>> {
    try {
      const result = await dispatch();
      this.assertReceipt(
        prepared.provider,
        signedJob,
        result.receipt,
        result.artifactManifest,
        prepared.lease.preparation,
        result.executionTimings,
      );
      await this.emitReceiptEvidence(
        prepared,
        context,
        result.receipt,
        result.artifactManifest,
        result.executionTimings,
      );
      return result;
    } catch (error) {
      if (error instanceof RunnerExecutionError) {
        this.assertReceipt(
          prepared.provider,
          signedJob,
          error.receipt,
          error.artifactManifest,
          prepared.lease.preparation,
          error.executionTimings ?? undefined,
        );
        await this.emitReceiptEvidence(
          prepared,
          context,
          error.receipt,
          error.artifactManifest,
          error.executionTimings ?? undefined,
        );
      }
      throw error;
    }
  }

  private async emitReceiptEvidence(
    prepared: {
      snapshotHash: string;
      environmentFingerprintHash: string;
      mounts?: readonly WorkspaceExecutionMountBinding[];
      shadowRouteDecisionId: string | null;
      shadowRouteCommandClassHash: string | null;
      lease: WorkspaceLease;
      provider: WorkspaceExecutionProvider;
      pairedReplayProvider?: WorkspaceExecutionProvider;
      routeMode: 'configured' | 'shadow' | 'automatic' | 'automatic-fallback';
    },
    context: {
      agentInstanceId: string | null;
      toolCallId: string | null;
      command?: SessionCommandRequest;
    },
    signedReceipt: SignedExecutionReceipt,
    artifactManifest: ExecutionArtifactManifest | null,
    executionTimings?: RunnerExecutionStageTimings,
  ): Promise<void> {
    const receipt = signedReceipt.receipt;
    const mount = prepared.mounts?.length === 1 ? prepared.mounts[0] : null;
    const evidence: RunnerExecutionEvidence = {
      agentInstanceId: context.agentInstanceId,
      toolCallId: context.toolCallId,
      receiptId: receipt.receiptId,
      receiptHash: hashExecutionReceipt(receipt),
      jobId: receipt.jobId,
      jobHash: receipt.jobHash,
      providerId: receipt.providerId,
      providerKind: prepared.provider.kind,
      operation: receipt.operation,
      snapshotHash: receipt.snapshotHash,
      environmentFingerprintHash: receipt.environmentFingerprintHash,
      repositoryRevision: mount?.repositoryRevision ?? null,
      dirtyPatchHash: mount?.dirtyPatchHash ?? null,
      outcome: receipt.outcome,
      exitCode: receipt.exitCode,
      resolvedBy: receipt.resolvedBy,
      outputHash: receipt.outputHash,
      artifactManifestHash: receipt.artifactManifestHash,
      artifactManifest,
      remoteJobId: receipt.remoteJobId,
      terminalState: receipt.terminalState,
      errorCode: receipt.errorCode,
      startedAt: receipt.startedAt,
      finishedAt: receipt.finishedAt,
      runnerKeyId: receipt.runnerKeyId,
      shadowRouteDecisionId: prepared.shadowRouteDecisionId ?? null,
      shadowRouteCommandClassHash: prepared.shadowRouteCommandClassHash ?? null,
      configuredProviderId: this.provider.id,
      configuredProviderKind: this.provider.kind,
      routeMode: prepared.routeMode,
      workspaceCacheStatus: prepared.lease.preparation?.cacheStatus,
      workspaceCacheProfile: prepared.lease.preparation?.profile,
      workspaceReuseCount: prepared.lease.preparation?.workspaceReuseCount,
      workspaceTransferBytes: prepared.lease.preparation?.transferBytes,
      workspaceTransferBytesAvoided:
        prepared.lease.preparation?.transferBytesAvoided,
      workspacePreparationHash: receipt.workspacePreparationHash,
      executionTimingHash: receipt.executionTimingHash,
      executionTimings: executionTimings
        ? Object.freeze({ ...executionTimings })
        : undefined,
    };
    if (
      this.observePairedReplay &&
      context.command &&
      evidence.shadowRouteDecisionId &&
      evidence.shadowRouteCommandClassHash &&
      prepared.pairedReplayProvider
    ) {
      const classification = classifyRunnerCommandForPairedReplay(
        context.command,
      );
      void Promise.resolve(
        this.observePairedReplay({
          decisionId: evidence.shadowRouteDecisionId,
          command: context.command,
          commandClassHash: evidence.shadowRouteCommandClassHash,
          riskClass: classification,
          snapshotIdentity: {
            snapshotHash: prepared.snapshotHash,
            environmentFingerprintHash: prepared.environmentFingerprintHash,
            mounts: prepared.mounts,
          },
          actualEvidence: evidence,
          targetProvider: prepared.pairedReplayProvider,
        }),
      ).catch(() => undefined);
    }
    if (!this.onExecutionReceipt) return;
    try {
      await this.onExecutionReceipt(Object.freeze(evidence));
    } catch {
      // Evidence Memory is observational. Persistence failures must never
      // change or replay an already-dispatched runner operation.
    }
  }
}

interface StoredLocalLease extends WorkspaceLease {
  mounts: WorkspaceExecutionMountBinding[];
}

interface ArtifactCaptureHooks {
  captureBefore(): Promise<WorkspaceArtifactState>;
  captureAfter(before: WorkspaceArtifactState): Promise<WorkspaceArtifactState>;
}

async function captureArtifactState(
  capture: (() => Promise<WorkspaceArtifactState>) | undefined,
): Promise<WorkspaceArtifactState | null> {
  if (!capture) return null;
  try {
    return await capture();
  } catch {
    return null;
  }
}

async function collectArtifactManifest(input: {
  snapshotHash: string;
  before: WorkspaceArtifactState | null;
  captureAfter:
    | ((before: WorkspaceArtifactState) => Promise<WorkspaceArtifactState>)
    | undefined;
}): Promise<ExecutionArtifactManifest | null> {
  if (!input.before || !input.captureAfter) return null;
  try {
    const after = await input.captureAfter(input.before);
    return createExecutionArtifactManifest({
      snapshotHash: input.snapshotHash,
      before: input.before,
      after,
    });
  } catch {
    return null;
  }
}

export interface DisposableRunnerReplayInput {
  provider: WorkspaceExecutionProvider;
  snapshotIdentity: {
    snapshotHash: string;
    environmentFingerprintHash: string;
    mounts?: readonly WorkspaceExecutionMountBinding[];
  };
  authority: RunnerSigningAuthority;
  audit?: RunnerSecurityAuditSink;
  command: SessionCommandRequest;
  agentInstanceId: string;
  decisionId: string;
  timeoutMs?: number;
}

/**
 * Executes one command on a fresh remote workspace/session and tears it down.
 *
 * This helper has no fallback, shadow observer, or replay observer, so a replay
 * cannot recursively route or execute locally after remote dispatch starts.
 */
export async function executeDisposableRunnerReplay(
  input: DisposableRunnerReplayInput,
): Promise<RunnerExecutionEvidence> {
  if (
    input.provider.kind !== 'ssh' &&
    input.provider.kind !== 'docker' &&
    !(
      input.provider.kind === 'local' &&
      input.provider.isDisposableReplayProvider === true
    )
  ) {
    throw new Error(
      'Disposable paired replay requires SSH, Docker, or an isolated local provider',
    );
  }
  if (input.command.rawInput || input.command.sessionId) {
    throw new Error('Disposable paired replay requires a sessionless command');
  }
  const riskClass = classifyRunnerCommandForPairedReplay(input.command);
  const isolationProfile = classifyRunnerReplayIsolationProfile(input.command);
  if (
    input.provider.kind === 'local' &&
    riskClass === 'workspace-contained' &&
    !isolationProfile
  ) {
    throw new Error(
      'Disposable local build/test replay requires a supported cache-isolation profile',
    );
  }
  const timeoutMs = Math.min(
    15 * 60_000,
    Math.max(1_000, Math.floor(input.timeoutMs ?? 60_000)),
  );
  let executeEvidence: RunnerExecutionEvidence | null = null;
  let sessionId: string | null = null;
  const replayStartedAt = Date.now();
  let executionStartedAt = replayStartedAt;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('Paired replay execution budget expired')),
    timeoutMs,
  );
  const backend = new ProviderBackedShellExecution(
    input.provider,
    failClosedReplayFallback,
    async () => ({
      ...input.snapshotIdentity,
      dependencyMaterialization:
        riskClass === 'workspace-contained'
          ? isolationProfile === 'node-copy-on-write'
            ? 'copy-on-write'
            : isolationProfile === 'cargo-cache'
              ? 'cargo-cache'
              : isolationProfile === 'go-cache'
                ? 'go-cache'
                : 'none'
          : 'none',
    }),
    input.authority,
    input.audit,
    false,
    (evidence) => {
      if (evidence.operation === 'execute-command') executeEvidence = evidence;
    },
  );
  const toolCallId = `paired-replay:${input.decisionId}`;
  try {
    sessionId = await backend.createSession(
      input.agentInstanceId,
      toolCallId,
      input.command.cwd ??
        input.snapshotIdentity.mounts?.[0]?.workspaceRoot ??
        '',
    );
    executionStartedAt = Date.now();
    try {
      await backend.executeInSession(input.agentInstanceId, toolCallId, {
        ...input.command,
        sessionId,
        rawInput: false,
        abortSignal: controller.signal,
        waitUntil: {
          timeoutMs,
          exited: true,
          idleMs: 0,
        },
      });
    } catch {
      // A failed execution still returns a verified signed receipt through the
      // evidence sink. The receipt, rather than the thrown transport error, is
      // the paired replay result.
    }
  } finally {
    clearTimeout(timer);
    if (sessionId) {
      await backend.killSession(sessionId).catch(() => false);
    }
  }
  const verifiedEvidence = executeEvidence as RunnerExecutionEvidence | null;
  if (!verifiedEvidence) {
    throw new Error(
      'Paired replay did not produce a verified execution receipt',
    );
  }
  return Object.freeze({
    ...verifiedEvidence,
    replayPreparationDurationMs: Math.max(
      0,
      executionStartedAt - replayStartedAt,
    ),
    replayTotalDurationMs: Math.max(0, Date.now() - replayStartedAt),
  });
}

const failClosedReplayFallback: ShellExecutionBackend = {
  isAvailable: () => false,
  createSession: () => {
    throw new Error('Paired replay fallback is disabled');
  },
  executeInSession: async () => {
    throw new Error('Paired replay fallback is disabled');
  },
  getRecentOutputForClassifier: () => undefined,
  getSessionCurrentCwd: () => undefined,
  clearPendingOutputs: () => undefined,
  killSession: async () => false,
};

export function selectShellExecutionBackend(input: {
  enabled: boolean;
  provider: WorkspaceExecutionProvider;
  fallback: ShellExecutionBackend;
  getSnapshotIdentity: () => Promise<{
    snapshotHash: string;
    environmentFingerprintHash: string;
    mounts?: readonly WorkspaceExecutionMountBinding[];
  }>;
  authority: RunnerSigningAuthority;
  audit?: RunnerSecurityAuditSink;
  fallbackOnPreparationFailure?: boolean;
  onExecutionReceipt?: RunnerExecutionEvidenceSink;
  observeShadowRoute?: RunnerShadowRoutingObserver;
  observePairedReplay?: RunnerPairedReplayObserver;
}): ShellExecutionBackend {
  if (!input.enabled) return input.fallback;
  return new ProviderBackedShellExecution(
    input.provider,
    input.fallback,
    input.getSnapshotIdentity,
    input.authority,
    input.audit,
    input.fallbackOnPreparationFailure,
    input.onExecutionReceipt,
    input.observeShadowRoute,
    input.observePairedReplay,
  );
}

function normalizeRunnerRoutingResolution(
  value: string | null | undefined | RunnerRoutingResolution,
): RunnerRoutingResolution {
  if (typeof value === 'string') return { decisionId: value };
  if (!value) return { decisionId: null };
  return {
    decisionId: value.decisionId ?? null,
    selectedProvider: value.selectedProvider,
    pairedReplayProvider: value.pairedReplayProvider,
  };
}

function normalizedPairedReplayProvider(
  dispatchedProvider: WorkspaceExecutionProvider,
  configuredProvider: WorkspaceExecutionProvider,
  decisionId: string | null,
  resolution: string | null | undefined | RunnerRoutingResolution,
): WorkspaceExecutionProvider | undefined {
  if (!decisionId || typeof resolution !== 'object' || resolution === null) {
    return undefined;
  }
  const target = resolution.pairedReplayProvider;
  if (
    !target ||
    (target.id === dispatchedProvider.id &&
      target.kind === dispatchedProvider.kind) ||
    (target.id === configuredProvider.id &&
      target.kind === configuredProvider.kind &&
      dispatchedProvider.id === configuredProvider.id &&
      dispatchedProvider.kind === configuredProvider.kind)
  ) {
    return undefined;
  }
  return target;
}

function canAutomaticallyRoute(
  observation: {
    operation: RunnerOperation;
    rawInput: boolean;
    requiresInteractive: boolean;
  },
  resumeSessionId: string | undefined,
): boolean {
  return (
    observation.operation === 'execute-command' &&
    !observation.rawInput &&
    !observation.requiresInteractive &&
    resumeSessionId === undefined
  );
}

function expectedCommandDurationMs(request: SessionCommandRequest): number {
  const requested = request.waitUntil?.timeoutMs;
  if (Number.isSafeInteger(requested) && requested !== undefined) {
    return Math.min(300_000, Math.max(0, requested));
  }
  if (request.rawInput) return 5_000;
  if (request.waitUntil?.exited) return 300_000;
  return 10_000;
}

export function classifyRunnerCommandForRouting(
  request: SessionCommandRequest,
): {
  commandClassHash: string;
  requiresNetwork: boolean;
  requiresInteractive: boolean;
} {
  if (request.rawInput) {
    return {
      commandClassHash: hashCommandClass('interactive-input', null),
      requiresNetwork: false,
      requiresInteractive: true,
    };
  }
  const tokens =
    request.command
      .trim()
      .match(/(?:[^\s"'`]+|"[^"]*"|'[^']*'|`[^`]*`)/g)
      ?.map((token) => token.replace(/^["'`]|["'`]$/g, '')) ?? [];
  while (tokens.length > 0) {
    if (
      tokens[0] === 'env' ||
      tokens[0] === 'sudo' ||
      tokens[0] === 'command' ||
      (tokens[0]!.includes('=') && !tokens[0]!.startsWith('='))
    ) {
      tokens.shift();
      continue;
    }
    break;
  }
  const executable = path.basename(tokens[0] ?? 'unknown').toLowerCase();
  const argumentsWithoutFlags = tokens
    .slice(1)
    .filter((token) => !token.startsWith('-'))
    .map((token) => token.toLowerCase());
  const subcommand =
    argumentsWithoutFlags[0] === 'run'
      ? (argumentsWithoutFlags[1] ?? null)
      : (argumentsWithoutFlags[0] ?? null);
  return {
    commandClassHash: hashCommandClass(executable, subcommand),
    requiresNetwork: commandClassRequiresNetwork(executable, subcommand),
    requiresInteractive: false,
  };
}

export function classifyRunnerCommandForPairedReplay(
  request: SessionCommandRequest,
): 'read-only' | 'workspace-contained' | 'ineligible' {
  if (
    request.rawInput ||
    !request.command.trim() ||
    /(?:&&|\|\||[;|<>`]|\$\(|\n|\r)/.test(request.command)
  ) {
    return 'ineligible';
  }
  const tokens =
    request.command
      .trim()
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')/g)
      ?.map((token) => token.replace(/^["']|["']$/g, '')) ?? [];
  while (
    tokens[0] === 'env' ||
    tokens[0] === 'command' ||
    (tokens[0]?.includes('=') && !tokens[0].startsWith('='))
  ) {
    tokens.shift();
  }
  const executable = path.basename(tokens[0] ?? '').toLowerCase();
  const argumentsWithoutFlags = tokens
    .slice(1)
    .filter((token) => !token.startsWith('-'))
    .map((token) => token.toLowerCase());
  const subcommand =
    argumentsWithoutFlags[0] === 'run'
      ? (argumentsWithoutFlags[1] ?? null)
      : (argumentsWithoutFlags[0] ?? null);

  if (
    [
      'pwd',
      'ls',
      'find',
      'rg',
      'grep',
      'cat',
      'head',
      'tail',
      'wc',
      'stat',
    ].includes(executable) ||
    (executable === 'git' &&
      ['status', 'diff', 'log', 'show', 'rev-parse'].includes(subcommand ?? ''))
  ) {
    return 'read-only';
  }

  if (
    (['npm', 'pnpm', 'yarn', 'bun'].includes(executable) &&
      ['test', 'lint', 'typecheck', 'check', 'build'].includes(
        subcommand ?? '',
      )) ||
    (executable === 'cargo' &&
      ['test', 'build', 'check'].includes(subcommand ?? '')) ||
    (executable === 'go' && subcommand === 'test') ||
    ['pytest', 'vitest', 'tsc', 'eslint', 'biome'].includes(executable)
  ) {
    return 'workspace-contained';
  }

  return 'ineligible';
}

export function isRunnerCommandWorkspaceConfined(
  request: SessionCommandRequest,
): boolean {
  if (request.rawInput || !request.command.trim()) return false;
  const tokens =
    request.command
      .trim()
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')/g)
      ?.map((token) => token.replace(/^["']|["']$/g, '')) ?? [];
  return !tokens.some((token, index) => {
    const normalized = token.replaceAll('\\', '/');
    return (
      normalized.startsWith('/') ||
      normalized.startsWith('~/') ||
      normalized === '~' ||
      normalized.startsWith('file:') ||
      normalized.split('/').includes('..') ||
      ((index === 0 || token.startsWith('-')) &&
        (token === '-C' ||
          token.startsWith('--git-dir') ||
          token.startsWith('--work-tree')))
    );
  });
}

export function isRunnerCommandDependencyIsolatable(
  request: SessionCommandRequest,
): boolean {
  return classifyRunnerReplayIsolationProfile(request) !== null;
}

export function classifyRunnerReplayIsolationProfile(
  request: SessionCommandRequest,
): RunnerReplayIsolationProfile | null {
  if (request.rawInput || !request.command.trim()) return null;
  const tokens =
    request.command
      .trim()
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')/g)
      ?.map((token) => token.replace(/^["']|["']$/g, '')) ?? [];
  while (
    tokens[0] === 'env' ||
    tokens[0] === 'command' ||
    (tokens[0]?.includes('=') && !tokens[0].startsWith('='))
  ) {
    tokens.shift();
  }
  const executable = path.basename(tokens[0] ?? '').toLowerCase();
  const argumentsWithoutFlags = tokens
    .slice(1)
    .filter((token) => !token.startsWith('-'))
    .map((token) => token.toLowerCase());
  const subcommand =
    argumentsWithoutFlags[0] === 'run'
      ? (argumentsWithoutFlags[1] ?? null)
      : (argumentsWithoutFlags[0] ?? null);
  if (
    ['npm', 'pnpm', 'yarn', 'bun'].includes(executable) &&
    ['test', 'lint', 'typecheck', 'check', 'build'].includes(subcommand ?? '')
  ) {
    return 'node-copy-on-write';
  }
  if (
    ['vitest', 'tsc', 'eslint', 'biome'].includes(executable) &&
    argumentsWithoutFlags[0] !== 'install'
  ) {
    return 'node-copy-on-write';
  }
  if (
    executable === 'cargo' &&
    ['test', 'build', 'check'].includes(subcommand ?? '')
  ) {
    return 'cargo-cache';
  }
  if (executable === 'go' && subcommand === 'test') {
    return 'go-cache';
  }
  return null;
}

function hashCommandClass(
  executable: string,
  subcommand: string | null,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, executable, subcommand }))
    .digest('hex');
}

function commandClassRequiresNetwork(
  executable: string,
  subcommand: string | null,
): boolean {
  if (
    ['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat'].includes(
      executable,
    )
  ) {
    return true;
  }
  return (
    (['npm', 'pnpm', 'yarn', 'bun'].includes(executable) &&
      ['add', 'install', 'publish'].includes(subcommand ?? '')) ||
    (executable === 'git' &&
      ['clone', 'fetch', 'pull', 'push'].includes(subcommand ?? '')) ||
    (['pip', 'pip3', 'cargo', 'go'].includes(executable) &&
      ['install', 'get'].includes(subcommand ?? '')) ||
    (executable === 'docker' &&
      ['build', 'pull', 'push'].includes(subcommand ?? ''))
  );
}

function assertSnapshotHash(snapshotHash: string): void {
  if (!/^[a-f0-9]{64}$/.test(snapshotHash)) {
    throw new Error('Workspace snapshot hash must be a SHA-256 hex digest');
  }
}

function assertEnvironmentFingerprintHash(
  environmentFingerprintHash: string,
): void {
  if (!/^[a-f0-9]{64}$/.test(environmentFingerprintHash)) {
    throw new Error(
      'Environment fingerprint hash must be a SHA-256 hex digest',
    );
  }
}
