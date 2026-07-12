import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SessionCommandRequest, SessionCommandResult } from './types';
import {
  createExecutionArtifactManifest,
  hashExecutionArtifactManifest,
  type ExecutionArtifactManifest,
  type WorkspaceArtifactState,
  type WorkspaceArtifactStateEntry,
} from './execution-artifact-manifest';
import {
  commandPayloadForHash,
  createSignedExecutionReceipt,
  getRunnerPublicKeyId,
  hashExecutionReceipt,
  hashRunnerJob,
  hashRunnerPayload,
  verifySignedRunnerJob,
  type RunnerOperation,
  type RunnerSecurityAuditSink,
  type RunnerSigningAuthority,
  type SignedExecutionReceipt,
  type SignedRunnerJob,
} from './runner-security';
import {
  RunnerExecutionError,
  RunnerJobAdmissionError,
  WorkspaceLeaseValidationError,
  hashRunnerExecutionStageTimings,
  hashRunnerWorkspacePreparation,
  type CommandExecutionRequest,
  type CreateExecutionSessionRequest,
  type PrepareWorkspaceRequest,
  type RunnerCapabilities,
  type RunnerDispatchResult,
  type RunnerExecutionStageTimings,
  type WorkspaceExecutionMountBinding,
  type WorkspaceExecutionProvider,
  type WorkspaceLease,
  type RunnerWorkspacePreparation,
} from './workspace-execution-provider';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 15 * 60_000;
const MAX_MATERIALIZATION_BYTES = 128 * 1024 * 1024;
const MAX_REMOTE_OUTPUT_CHARS = 8 * 1024 * 1024;

export interface SshRunnerWorkspaceObservation {
  repositoryRevision: string | null;
  dirtyPatchHash: string;
  environmentFingerprintHash: string;
}

export interface SshRunnerPreparedWorkspace
  extends SshRunnerWorkspaceObservation {
  workspaceHandle: string;
  materializationArchiveHash: string;
  preparation?: RunnerWorkspacePreparation;
}

export interface SshRunnerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RemoteRunnerJobState =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

export interface RemoteRunnerJobSnapshot {
  jobId: string;
  state: RemoteRunnerJobState;
  stdout: string;
  stderr: string;
  stdoutOffset: number;
  stderrOffset: number;
  exitCode: number | null;
  commandDurationMs?: number | null;
  stdoutComplete?: boolean;
  stderrComplete?: boolean;
  artifactCapture?: SshRunnerArtifactCaptureResult;
}

export interface SshRunnerArtifactCapture {
  captureId: string;
  snapshotHash: string;
}

export interface SshRunnerArtifactCaptureResult {
  manifest: ExecutionArtifactManifest;
  captureDurationMs: number;
}

export interface SshRunnerTransport {
  readonly lifecycleLongPolling?: boolean;
  readonly artifactManifestFastPath?: boolean;
  prepareWorkspace(input: {
    snapshotHash: string;
    workspaceRoot: string;
    repositoryRevision: string;
    dirtyPatchHash: string;
    materialization: NonNullable<
      WorkspaceExecutionMountBinding['materialization']
    >;
    dependencyFingerprintHash?: string;
    dependencyMaterialization?:
      | 'none'
      | 'copy-on-write'
      | 'cargo-cache'
      | 'go-cache';
  }): Promise<SshRunnerPreparedWorkspace>;
  execute(input: {
    workspaceHandle: string;
    command: string;
    cwdRelative: string;
    timeoutMs: number;
  }): Promise<SshRunnerCommandResult>;
  startJob?(input: {
    workspaceHandle: string;
    command: string;
    cwdRelative: string;
    timeoutMs: number;
    waitMs?: number;
  }): Promise<{ jobId: string; snapshot?: RemoteRunnerJobSnapshot }>;
  readJob?(input: {
    workspaceHandle: string;
    jobId: string;
    stdoutOffset: number;
    stderrOffset: number;
    waitMs?: number;
    artifactCapture?: SshRunnerArtifactCapture;
  }): Promise<RemoteRunnerJobSnapshot>;
  cancelJob?(input: {
    workspaceHandle: string;
    jobId: string;
    stdoutOffset: number;
    stderrOffset: number;
    artifactCapture?: SshRunnerArtifactCapture;
  }): Promise<RemoteRunnerJobSnapshot>;
  beginWorkspaceArtifactCapture?(input: {
    workspaceHandle: string;
    snapshotHash: string;
  }): Promise<SshRunnerArtifactCapture>;
  finalizeWorkspaceArtifactCapture?(input: {
    workspaceHandle: string;
    artifactCapture: SshRunnerArtifactCapture;
  }): Promise<SshRunnerArtifactCaptureResult>;
  captureWorkspaceArtifactState(input: {
    workspaceHandle: string;
    includeEntries?: readonly WorkspaceArtifactStateEntry[];
  }): Promise<WorkspaceArtifactState>;
  getRoundTripCount?(): number;
  releaseWorkspace(workspaceHandle: string): Promise<void>;
}

interface StoredSshLease extends WorkspaceLease {
  mount: WorkspaceExecutionMountBinding;
  workspaceHandle: string;
  ownsWorkspace: boolean;
}

interface SshSyntheticSession {
  id: string;
  snapshotHash: string;
  workspaceRoot: string;
  workspaceHandle: string;
  environmentFingerprintHash: string;
  cwd: string;
  cwdRelative: string;
  preparation?: RunnerWorkspacePreparation;
}

/**
 * Non-interactive SSH runner.
 *
 * V1 deliberately exposes synthetic sessions to preserve the existing shell
 * tool contract, but every command is a fresh remote process. Stdin, polling,
 * and persistent process state are rejected rather than emulated.
 */
export class SshRunnerAdapter implements WorkspaceExecutionProvider {
  public readonly kind = 'ssh' as const;
  public readonly receiptPublicKey: string;
  public readonly replayIsolationProfiles:
    | readonly ('node-copy-on-write' | 'cargo-cache' | 'go-cache')[]
    | undefined;

  private readonly leases = new Map<string, StoredSshLease>();
  private readonly sessions = new Map<string, SshSyntheticSession>();
  private readonly consumedNonces = new Map<string, number>();

  public constructor(
    public readonly id: string,
    private readonly transport: SshRunnerTransport,
    private readonly options: {
      receiptAuthority: RunnerSigningAuthority;
      trustedGuardianPublicKey: string;
      audit?: RunnerSecurityAuditSink;
      now?: () => number;
      createId?: () => string;
      runnerName?: string;
      heavyweightCacheEnabled?: boolean;
    },
  ) {
    if (!id.trim()) throw new Error('SSH runner id is required');
    this.receiptPublicKey = options.receiptAuthority.publicKey;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.runnerName = options.runnerName?.trim() || 'SSH runner';
    this.replayIsolationProfiles = options.heavyweightCacheEnabled
      ? Object.freeze([
          'node-copy-on-write',
          'cargo-cache',
          'go-cache',
        ] as const)
      : undefined;
  }

  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly runnerName: string;

  public async getCapabilities(): Promise<RunnerCapabilities> {
    const lifecycle = hasRemoteJobLifecycle(this.transport);
    return {
      persistentSessions: false,
      streamingOutput: lifecycle,
      stdin: false,
      cancellation: lifecycle,
      workspaceLeases: true,
    };
  }

  public async prepareWorkspace(
    request: PrepareWorkspaceRequest,
  ): Promise<WorkspaceLease> {
    assertSha256(request.snapshotHash, 'Workspace snapshot hash');
    const mount = requireSingleMount(request.mounts, this.runnerName);
    if (!mount.repositoryRevision) {
      throw new WorkspaceLeaseValidationError(
        `${this.runnerName} requires a Git repository revision`,
      );
    }
    assertSha256(mount.dirtyPatchHash, 'Workspace dirty patch hash');
    const materialization = mount.materialization;
    if (!materialization) {
      throw new WorkspaceLeaseValidationError(
        `${this.runnerName} requires a workspace materialization bundle`,
      );
    }
    assertMaterialization(materialization, this.runnerName);

    const resumedSession = request.resumeSessionId
      ? this.sessions.get(request.resumeSessionId)
      : undefined;
    if (request.resumeSessionId && !resumedSession) {
      throw new WorkspaceLeaseValidationError(
        `${this.runnerName} session is unknown or has expired`,
      );
    }
    if (
      resumedSession &&
      (resumedSession.snapshotHash !== request.snapshotHash ||
        resumedSession.workspaceRoot !== mount.workspaceRoot)
    ) {
      throw new WorkspaceLeaseValidationError(
        `${this.runnerName} session snapshot does not match the local workspace`,
      );
    }

    const observed = resumedSession
      ? {
          workspaceHandle: resumedSession.workspaceHandle,
          repositoryRevision: mount.repositoryRevision,
          dirtyPatchHash: mount.dirtyPatchHash,
          materializationArchiveHash: materialization.archiveHash,
          environmentFingerprintHash: resumedSession.environmentFingerprintHash,
          preparation: resumedSession.preparation,
        }
      : await this.transport.prepareWorkspace({
          snapshotHash: request.snapshotHash,
          workspaceRoot: mount.workspaceRoot,
          repositoryRevision: mount.repositoryRevision,
          dirtyPatchHash: mount.dirtyPatchHash,
          materialization,
          dependencyFingerprintHash: mount.dependencyFingerprintHash,
          dependencyMaterialization:
            request.dependencyMaterialization ?? 'none',
        });
    if (!observed.workspaceHandle.trim()) {
      if (!resumedSession) {
        await this.transport
          .releaseWorkspace(observed.workspaceHandle)
          .catch(() => undefined);
      }
      throw new WorkspaceLeaseValidationError(
        `${this.runnerName} returned an invalid workspace handle`,
      );
    }
    assertSha256(
      observed.environmentFingerprintHash,
      'Remote environment fingerprint hash',
    );
    assertSha256(observed.dirtyPatchHash, 'Remote dirty patch hash');
    assertSha256(
      observed.materializationArchiveHash,
      'Remote materialization archive hash',
    );
    if (observed.repositoryRevision !== mount.repositoryRevision) {
      if (!resumedSession) {
        await this.transport
          .releaseWorkspace(observed.workspaceHandle)
          .catch(() => undefined);
      }
      throw new WorkspaceLeaseValidationError(
        'Remote repository revision does not match the requested snapshot',
      );
    }
    if (observed.dirtyPatchHash !== mount.dirtyPatchHash) {
      if (!resumedSession) {
        await this.transport
          .releaseWorkspace(observed.workspaceHandle)
          .catch(() => undefined);
      }
      throw new WorkspaceLeaseValidationError(
        'Remote workspace state does not match the requested snapshot',
      );
    }
    if (observed.materializationArchiveHash !== materialization.archiveHash) {
      if (!resumedSession) {
        await this.transport
          .releaseWorkspace(observed.workspaceHandle)
          .catch(() => undefined);
      }
      throw new WorkspaceLeaseValidationError(
        'Remote materialization archive does not match the requested snapshot',
      );
    }

    const createdAt = this.now();
    const expiresInMs = request.expiresInMs ?? null;
    if (
      expiresInMs !== null &&
      (!Number.isSafeInteger(expiresInMs) || expiresInMs <= 0)
    ) {
      throw new Error('Workspace lease expiry must be a positive integer');
    }
    const lease: StoredSshLease = {
      id: this.createId(),
      providerId: this.id,
      snapshotHash: request.snapshotHash,
      environmentFingerprintHash: observed.environmentFingerprintHash,
      createdAt,
      expiresAt: expiresInMs === null ? null : createdAt + expiresInMs,
      mount: { ...mount },
      workspaceHandle: observed.workspaceHandle,
      ownsWorkspace: !resumedSession,
      preparation: observed.preparation,
    };
    this.leases.set(lease.id, lease);
    return publicLease(lease);
  }

  public async createSession(
    lease: WorkspaceLease,
    request: CreateExecutionSessionRequest,
  ): Promise<RunnerDispatchResult<string>> {
    const current = this.assertLease(lease, request.snapshotHash);
    const cwd = resolveSshCwd(current.mount.workspaceRoot, request.cwd);
    const sessionId = this.createId();
    const dispatched = await this.dispatch(
      current,
      request.signedJob,
      'create-session',
      hashRunnerPayload('create-session', {
        agentInstanceId: request.agentInstanceId,
        toolCallId: request.toolCallId,
        cwd: request.cwd,
      }),
      () => sessionId,
      { getRoundTripCount: () => this.transport.getRoundTripCount?.() },
    );
    this.sessions.set(sessionId, {
      id: sessionId,
      snapshotHash: current.snapshotHash,
      workspaceRoot: current.mount.workspaceRoot,
      workspaceHandle: current.workspaceHandle,
      environmentFingerprintHash: current.environmentFingerprintHash,
      cwd: cwd.absolute,
      cwdRelative: cwd.relative,
      preparation: current.preparation,
    });
    current.ownsWorkspace = false;
    return dispatched;
  }

  public async execute(
    lease: WorkspaceLease,
    request: CommandExecutionRequest,
  ): Promise<RunnerDispatchResult<SessionCommandResult>> {
    const current = this.assertLease(lease, request.snapshotHash);
    const command = request.command;
    let artifactSession: SshSyntheticSession | null = null;
    let remoteJobId: string | null = null;
    let terminalState: Exclude<RemoteRunnerJobState, 'running'> | null = null;
    let lifecycleTimings: SshLifecycleStageTimings | null = null;
    let fastArtifactCapture: SshRunnerArtifactCapture | null = null;
    let fastArtifactResult: SshRunnerArtifactCaptureResult | null = null;
    const artifactFastTransport = supportsSshArtifactFastPath(this.transport)
      ? this.transport
      : null;
    return await this.dispatch(
      current,
      request.signedJob,
      'execute-command',
      hashRunnerPayload('execute-command', {
        agentInstanceId: request.agentInstanceId,
        toolCallId: request.toolCallId,
        command: commandPayloadForHash(command),
      }),
      async () => {
        const session = this.requireSession(current, command);
        artifactSession = session;
        if (command.rawInput) {
          throw new Error(`${this.runnerName} v1 does not support stdin`);
        }
        if (!command.command.trim()) {
          throw new Error(
            `${this.runnerName} v1 does not support output polling`,
          );
        }
        if (command.abortSignal?.aborted) {
          throw command.abortSignal.reason ?? new Error('SSH command aborted');
        }
        const result = hasRemoteJobLifecycle(this.transport)
          ? await executeRemoteLifecycleJob({
              transport: this.transport,
              workspaceHandle: session.workspaceHandle,
              command: command.command,
              cwdRelative: session.cwdRelative,
              timeoutMs: resolveCommandTimeout(command),
              abortSignal: command.abortSignal,
              artifactCapture: fastArtifactCapture ?? undefined,
              onJobStarted: (jobId) => {
                remoteJobId = jobId;
              },
            })
          : await (async () => {
              const commandStartedAt = performance.now();
              const legacy = await this.transport.execute({
                workspaceHandle: session.workspaceHandle,
                command: command.command,
                cwdRelative: session.cwdRelative,
                timeoutMs: resolveCommandTimeout(command),
              });
              return {
                ...legacy,
                timedOut: false,
                resolvedBy: 'exit' as const,
                terminalState:
                  legacy.exitCode === 0
                    ? ('completed' as const)
                    : ('failed' as const),
                stageTimings: {
                  dispatchDurationMs: 0,
                  commandDurationMs: Math.max(
                    0,
                    Math.round(performance.now() - commandStartedAt),
                  ),
                  pollingDurationMs: 0,
                  dispatchRoundTrips: 1,
                  pollingRoundTrips: 0,
                },
                artifactCapture: undefined,
              };
            })();
        const output = combineOutput(result.stdout, result.stderr);
        terminalState = result.terminalState;
        lifecycleTimings = result.stageTimings;
        fastArtifactResult = result.artifactCapture ?? null;
        return {
          sessionId: session.id,
          output,
          recentOutput: output,
          exitCode: result.exitCode,
          sessionExited: false,
          timedOut: result.timedOut,
          resolvedBy: result.resolvedBy,
        };
      },
      {
        beginArtifactCapture: artifactFastTransport
          ? async () => {
              const session = this.requireSession(current, command);
              artifactSession = session;
              fastArtifactCapture =
                await artifactFastTransport.beginWorkspaceArtifactCapture({
                  workspaceHandle: session.workspaceHandle,
                  snapshotHash: current.snapshotHash,
                });
            }
          : undefined,
        captureBefore: async () => {
          const session = this.requireSession(current, command);
          artifactSession = session;
          return await this.transport.captureWorkspaceArtifactState({
            workspaceHandle: session.workspaceHandle,
          });
        },
        captureAfter: async (before) => {
          const session =
            artifactSession ?? this.requireSession(current, command);
          return await this.transport.captureWorkspaceArtifactState({
            workspaceHandle: session.workspaceHandle,
            includeEntries: before.entries,
          });
        },
        captureFastManifest: artifactFastTransport
          ? async () => {
              if (fastArtifactResult) {
                return {
                  ...fastArtifactResult,
                  bundledWithLifecycle: true,
                };
              }
              if (!fastArtifactCapture) return null;
              const session =
                artifactSession ?? this.requireSession(current, command);
              return {
                ...(await artifactFastTransport.finalizeWorkspaceArtifactCapture(
                  {
                    workspaceHandle: session.workspaceHandle,
                    artifactCapture: fastArtifactCapture,
                  },
                )),
                bundledWithLifecycle: false,
              };
            }
          : undefined,
        getLifecycle: () => ({ remoteJobId, terminalState }),
        getStageTimings: () => lifecycleTimings,
        getRoundTripCount: () => this.transport.getRoundTripCount?.(),
      },
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
    const current = this.assertLease(lease, request.snapshotHash);
    return await this.dispatch(
      current,
      request.signedJob,
      'kill-session',
      hashRunnerPayload('kill-session', { sessionId: request.sessionId }),
      async () => {
        const session = this.sessions.get(request.sessionId);
        if (
          !session ||
          session.snapshotHash !== current.snapshotHash ||
          session.workspaceRoot !== current.mount.workspaceRoot
        ) {
          return false;
        }
        this.sessions.delete(request.sessionId);
        await this.transport.releaseWorkspace(session.workspaceHandle);
        return true;
      },
      { getRoundTripCount: () => this.transport.getRoundTripCount?.() },
    );
  }

  public getRecentOutputForClassifier(): string | undefined {
    return undefined;
  }

  public getSessionCurrentCwd(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd;
  }

  public clearPendingOutputs(): void {}

  public async disposeWorkspace(lease: WorkspaceLease): Promise<void> {
    if (lease.providerId !== this.id) return;
    const stored = this.leases.get(lease.id);
    this.leases.delete(lease.id);
    if (stored?.ownsWorkspace) {
      await this.transport.releaseWorkspace(stored.workspaceHandle);
    }
  }

  public async dispose(): Promise<void> {
    const workspaceHandles = new Set<string>();
    for (const lease of this.leases.values()) {
      if (lease.ownsWorkspace) workspaceHandles.add(lease.workspaceHandle);
    }
    for (const session of this.sessions.values()) {
      workspaceHandles.add(session.workspaceHandle);
    }
    this.leases.clear();
    this.sessions.clear();
    const failures: unknown[] = [];
    for (const workspaceHandle of workspaceHandles) {
      try {
        await this.transport.releaseWorkspace(workspaceHandle);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${this.runnerName} could not release every prepared workspace`,
      );
    }
  }

  private assertLease(
    lease: WorkspaceLease,
    snapshotHash: string,
  ): StoredSshLease {
    assertSha256(snapshotHash, 'Workspace snapshot hash');
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
      current.snapshotHash !== snapshotHash ||
      current.environmentFingerprintHash !== lease.environmentFingerprintHash
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

  private requireSession(
    lease: StoredSshLease,
    command: SessionCommandRequest,
  ): SshSyntheticSession {
    if (!command.sessionId) {
      throw new Error(`${this.runnerName} requires a synthetic session id`);
    }
    const session = this.sessions.get(command.sessionId);
    if (
      !session ||
      session.snapshotHash !== lease.snapshotHash ||
      session.workspaceRoot !== lease.mount.workspaceRoot
    ) {
      throw new Error(
        `${this.runnerName} session is unknown or belongs to another lease`,
      );
    }
    return session;
  }

  private async dispatch<T>(
    lease: StoredSshLease,
    signedJob: SignedRunnerJob,
    operation: RunnerOperation,
    payloadHash: string,
    execute: () => T | Promise<T>,
    hooks?: SshDispatchHooks,
  ): Promise<RunnerDispatchResult<T>> {
    await this.admitJob(lease, signedJob, operation, payloadHash);
    const startedAt = this.now();
    const dispatchRoundTripStart = readSshRoundTripCount(hooks);
    const artifactBeforeStartedAt = performance.now();
    const fastArtifactCaptureReady = await beginSshArtifactCapture(
      hooks?.beginArtifactCapture,
    );
    const artifactBefore = fastArtifactCaptureReady
      ? null
      : await captureSshArtifactState(hooks?.captureBefore);
    const artifactBeforeDurationMs = elapsedMonotonicMs(
      artifactBeforeStartedAt,
    );
    const artifactBeforeRoundTrips = roundTripDelta(
      dispatchRoundTripStart,
      readSshRoundTripCount(hooks),
    );
    const executeRoundTripStart = readSshRoundTripCount(hooks);
    const executeStartedAt = performance.now();
    let value: T;
    try {
      value = await execute();
    } catch (error) {
      const stageTimings =
        hooks?.getStageTimings?.() ??
        fallbackSshLifecycleStageTimings(
          executeStartedAt,
          executeRoundTripStart,
          readSshRoundTripCount(hooks),
        );
      const artifactAfterRoundTripStart = readSshRoundTripCount(hooks);
      const artifactAfterStartedAt = performance.now();
      const artifactCapture = await collectSshArtifactManifest({
        snapshotHash: lease.snapshotHash,
        before: artifactBefore,
        captureAfter: hooks?.captureAfter,
        captureFastManifest: fastArtifactCaptureReady
          ? hooks?.captureFastManifest
          : undefined,
      });
      const artifactManifest = artifactCapture.manifest;
      const unsignedTimings = createSshExecutionStageTimings({
        roundTripStart: dispatchRoundTripStart,
        roundTripFinish: readSshRoundTripCount(hooks),
        artifactBeforeRoundTrips,
        artifactBeforeDurationMs,
        stageTimings,
        artifactAfterRoundTrips: roundTripDelta(
          artifactAfterRoundTripStart,
          readSshRoundTripCount(hooks),
        ),
        artifactAfterDurationMs:
          artifactCapture.bundledDurationMs ??
          elapsedMonotonicMs(artifactAfterStartedAt),
      });
      const receiptFinalizationStartedAt = performance.now();
      const receipt = createSignedExecutionReceipt({
        signedJob,
        authority: this.options.receiptAuthority,
        startedAt,
        finishedAt: this.now(),
        outcome: 'failed',
        artifactManifestHash: artifactManifest
          ? hashExecutionArtifactManifest(artifactManifest)
          : null,
        workspacePreparationHash: lease.preparation
          ? hashRunnerWorkspacePreparation(lease.preparation)
          : null,
        executionTimingHash: hashRunnerExecutionStageTimings(unsignedTimings),
        remoteJobId: hooks?.getLifecycle?.().remoteJobId,
        terminalState: hooks?.getLifecycle?.().terminalState,
        errorCode:
          error instanceof Error ? error.name.slice(0, 128) : 'UnknownError',
      });
      try {
        await this.auditReceipt(signedJob, receipt);
      } catch (auditError) {
        const executionTimings = withReceiptFinalizationDuration(
          unsignedTimings,
          receiptFinalizationStartedAt,
        );
        throw new RunnerExecutionError(
          'Execution failed and receipt audit could not be persisted',
          receipt,
          { cause: new AggregateError([error, auditError]) },
          artifactManifest,
          executionTimings,
        );
      }
      const executionTimings = withReceiptFinalizationDuration(
        unsignedTimings,
        receiptFinalizationStartedAt,
      );
      throw new RunnerExecutionError(
        error instanceof Error ? error.message : String(error),
        receipt,
        { cause: error },
        artifactManifest,
        executionTimings,
      );
    }
    const stageTimings =
      hooks?.getStageTimings?.() ??
      fallbackSshLifecycleStageTimings(
        executeStartedAt,
        executeRoundTripStart,
        readSshRoundTripCount(hooks),
      );
    const artifactAfterRoundTripStart = readSshRoundTripCount(hooks);
    const artifactAfterStartedAt = performance.now();
    const artifactCapture = await collectSshArtifactManifest({
      snapshotHash: lease.snapshotHash,
      before: artifactBefore,
      captureAfter: hooks?.captureAfter,
      captureFastManifest: fastArtifactCaptureReady
        ? hooks?.captureFastManifest
        : undefined,
    });
    const artifactManifest = artifactCapture.manifest;
    const unsignedTimings = createSshExecutionStageTimings({
      roundTripStart: dispatchRoundTripStart,
      roundTripFinish: readSshRoundTripCount(hooks),
      artifactBeforeRoundTrips,
      artifactBeforeDurationMs,
      stageTimings,
      artifactAfterRoundTrips: roundTripDelta(
        artifactAfterRoundTripStart,
        readSshRoundTripCount(hooks),
      ),
      artifactAfterDurationMs:
        artifactCapture.bundledDurationMs ??
        elapsedMonotonicMs(artifactAfterStartedAt),
    });
    const shellResult =
      operation === 'execute-command'
        ? (value as SessionCommandResult)
        : undefined;
    const receiptFinalizationStartedAt = performance.now();
    const receipt = createSignedExecutionReceipt({
      signedJob,
      authority: this.options.receiptAuthority,
      startedAt,
      finishedAt: this.now(),
      outcome: 'completed',
      exitCode: shellResult?.exitCode,
      resolvedBy: shellResult?.resolvedBy,
      output: shellResult?.output,
      artifactManifestHash: artifactManifest
        ? hashExecutionArtifactManifest(artifactManifest)
        : null,
      workspacePreparationHash: lease.preparation
        ? hashRunnerWorkspacePreparation(lease.preparation)
        : null,
      executionTimingHash: hashRunnerExecutionStageTimings(unsignedTimings),
      remoteJobId: hooks?.getLifecycle?.().remoteJobId,
      terminalState: hooks?.getLifecycle?.().terminalState,
    });
    try {
      await this.auditReceipt(signedJob, receipt);
    } catch (error) {
      const executionTimings = withReceiptFinalizationDuration(
        unsignedTimings,
        receiptFinalizationStartedAt,
      );
      throw new RunnerExecutionError(
        'Execution completed but receipt audit could not be persisted',
        receipt,
        { cause: error },
        artifactManifest,
        executionTimings,
      );
    }
    const executionTimings = withReceiptFinalizationDuration(
      unsignedTimings,
      receiptFinalizationStartedAt,
    );
    return Object.freeze({
      value,
      receipt,
      artifactManifest,
      executionTimings: Object.freeze(executionTimings),
    });
  }

  private async admitJob(
    lease: StoredSshLease,
    signedJob: SignedRunnerJob,
    operation: RunnerOperation,
    payloadHash: string,
  ): Promise<void> {
    const reject = async (reason: string): Promise<never> => {
      const job = signedJob?.job;
      await this.options.audit?.record({
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
      !verifySignedRunnerJob(
        signedJob,
        this.options.trustedGuardianPublicKey,
      ) ||
      signedJob.job.authorityKeyId !==
        getRunnerPublicKeyId(this.options.trustedGuardianPublicKey)
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
    await this.options.audit?.record({
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
    await this.options.audit?.record({
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

interface SshDispatchHooks {
  beginArtifactCapture?(): Promise<void>;
  captureBefore?(): Promise<WorkspaceArtifactState>;
  captureAfter?(
    before: WorkspaceArtifactState,
  ): Promise<WorkspaceArtifactState>;
  captureFastManifest?(): Promise<
    | (SshRunnerArtifactCaptureResult & {
        bundledWithLifecycle: boolean;
      })
    | null
  >;
  getLifecycle?(): {
    remoteJobId: string | null;
    terminalState: Exclude<RemoteRunnerJobState, 'running'> | null;
  };
  getStageTimings?(): SshLifecycleStageTimings | null;
  getRoundTripCount?(): number | undefined;
}

interface SshLifecycleStageTimings {
  dispatchDurationMs: number;
  commandDurationMs: number | null;
  pollingDurationMs: number;
  dispatchRoundTrips: number;
  pollingRoundTrips: number;
}

function createSshExecutionStageTimings(input: {
  roundTripStart: number | null;
  roundTripFinish: number | null;
  artifactBeforeRoundTrips: number;
  artifactBeforeDurationMs: number;
  stageTimings: SshLifecycleStageTimings;
  artifactAfterRoundTrips: number;
  artifactAfterDurationMs: number;
}): RunnerExecutionStageTimings {
  const stageRoundTrips =
    input.artifactBeforeRoundTrips +
    input.stageTimings.dispatchRoundTrips +
    input.stageTimings.pollingRoundTrips +
    input.artifactAfterRoundTrips;
  return {
    version: 1,
    sshRoundTrips:
      input.roundTripStart === null || input.roundTripFinish === null
        ? stageRoundTrips
        : roundTripDelta(input.roundTripStart, input.roundTripFinish),
    artifactBeforeRoundTrips: input.artifactBeforeRoundTrips,
    dispatchRoundTrips: input.stageTimings.dispatchRoundTrips,
    pollingRoundTrips: input.stageTimings.pollingRoundTrips,
    artifactAfterRoundTrips: input.artifactAfterRoundTrips,
    artifactBeforeDurationMs: input.artifactBeforeDurationMs,
    dispatchDurationMs: input.stageTimings.dispatchDurationMs,
    commandDurationMs: input.stageTimings.commandDurationMs,
    pollingDurationMs: input.stageTimings.pollingDurationMs,
    artifactAfterDurationMs: input.artifactAfterDurationMs,
    receiptFinalizationDurationMs: 0,
  };
}

function withReceiptFinalizationDuration(
  timings: RunnerExecutionStageTimings,
  startedAt: number,
): RunnerExecutionStageTimings {
  return {
    ...timings,
    receiptFinalizationDurationMs: elapsedMonotonicMs(startedAt),
  };
}

function fallbackSshLifecycleStageTimings(
  startedAt: number,
  roundTripStart: number | null,
  roundTripFinish: number | null,
): SshLifecycleStageTimings {
  return {
    dispatchDurationMs: elapsedMonotonicMs(startedAt),
    commandDurationMs: null,
    pollingDurationMs: 0,
    dispatchRoundTrips: roundTripDelta(roundTripStart, roundTripFinish),
    pollingRoundTrips: 0,
  };
}

function readSshRoundTripCount(
  hooks: SshDispatchHooks | undefined,
): number | null {
  const value = hooks?.getRoundTripCount?.();
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : null;
}

function roundTripDelta(start: number | null, finish: number | null): number {
  if (start === null || finish === null) return 0;
  return Math.max(0, finish - start);
}

function elapsedMonotonicMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function captureSshArtifactState(
  capture: (() => Promise<WorkspaceArtifactState>) | undefined,
): Promise<WorkspaceArtifactState | null> {
  if (!capture) return null;
  try {
    return await capture();
  } catch {
    return null;
  }
}

async function beginSshArtifactCapture(
  begin: (() => Promise<void>) | undefined,
): Promise<boolean> {
  if (!begin) return false;
  try {
    await begin();
    return true;
  } catch {
    return false;
  }
}

async function collectSshArtifactManifest(input: {
  snapshotHash: string;
  before: WorkspaceArtifactState | null;
  captureAfter:
    | ((before: WorkspaceArtifactState) => Promise<WorkspaceArtifactState>)
    | undefined;
  captureFastManifest:
    | (() => Promise<
        | (SshRunnerArtifactCaptureResult & {
            bundledWithLifecycle: boolean;
          })
        | null
      >)
    | undefined;
}): Promise<{
  manifest: ExecutionArtifactManifest | null;
  bundledDurationMs: number | null;
}> {
  if (input.captureFastManifest) {
    try {
      const captured = await input.captureFastManifest();
      if (captured) {
        return {
          manifest: captured.manifest,
          bundledDurationMs: captured.bundledWithLifecycle
            ? captured.captureDurationMs
            : null,
        };
      }
    } catch {
      return { manifest: null, bundledDurationMs: null };
    }
  }
  if (!input.before || !input.captureAfter) {
    return { manifest: null, bundledDurationMs: null };
  }
  try {
    return {
      manifest: createExecutionArtifactManifest({
        snapshotHash: input.snapshotHash,
        before: input.before,
        after: await input.captureAfter(input.before),
      }),
      bundledDurationMs: null,
    };
  } catch {
    return { manifest: null, bundledDurationMs: null };
  }
}

function publicLease(lease: StoredSshLease): WorkspaceLease {
  return {
    id: lease.id,
    providerId: lease.providerId,
    snapshotHash: lease.snapshotHash,
    environmentFingerprintHash: lease.environmentFingerprintHash,
    createdAt: lease.createdAt,
    expiresAt: lease.expiresAt,
    preparation: lease.preparation
      ? Object.freeze({ ...lease.preparation })
      : undefined,
  };
}

function requireSingleMount(
  mounts: readonly WorkspaceExecutionMountBinding[] | undefined,
  runnerName = 'SSH runner',
): WorkspaceExecutionMountBinding {
  if (mounts?.length !== 1) {
    throw new WorkspaceLeaseValidationError(
      `${runnerName} v1 requires exactly one mounted workspace`,
    );
  }
  return mounts[0]!;
}

function resolveSshCwd(
  workspaceRoot: string,
  requestedCwd: string,
): { absolute: string; relative: string } {
  const root = path.resolve(workspaceRoot);
  const absolute = path.resolve(requestedCwd);
  const relative = path.relative(root, absolute);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new WorkspaceLeaseValidationError(
      'SSH session cwd is outside the leased workspace',
    );
  }
  return {
    absolute,
    relative: relative.split(path.sep).join('/'),
  };
}

function resolveCommandTimeout(request: SessionCommandRequest): number {
  const requested = request.waitUntil?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  return Math.min(Math.trunc(requested), MAX_COMMAND_TIMEOUT_MS);
}

function combineOutput(stdout: string, stderr: string): string {
  if (!stderr) return stdout;
  if (!stdout) return stderr;
  return `${stdout}${stdout.endsWith('\n') ? '' : '\n'}${stderr}`;
}

type LifecycleSshRunnerTransport = SshRunnerTransport &
  Required<Pick<SshRunnerTransport, 'startJob' | 'readJob' | 'cancelJob'>>;

type ArtifactFastPathSshRunnerTransport = SshRunnerTransport &
  Required<
    Pick<
      SshRunnerTransport,
      'beginWorkspaceArtifactCapture' | 'finalizeWorkspaceArtifactCapture'
    >
  >;

function hasRemoteJobLifecycle(
  transport: SshRunnerTransport,
): transport is LifecycleSshRunnerTransport {
  return Boolean(
    transport.startJob && transport.readJob && transport.cancelJob,
  );
}

function supportsSshArtifactFastPath(
  transport: SshRunnerTransport,
): transport is ArtifactFastPathSshRunnerTransport {
  return Boolean(
    transport.artifactManifestFastPath &&
      transport.beginWorkspaceArtifactCapture &&
      transport.finalizeWorkspaceArtifactCapture,
  );
}

async function executeRemoteLifecycleJob(input: {
  transport: LifecycleSshRunnerTransport;
  workspaceHandle: string;
  command: string;
  cwdRelative: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  artifactCapture?: SshRunnerArtifactCapture;
  onJobStarted?(jobId: string): void;
}): Promise<
  SshRunnerCommandResult & {
    timedOut: boolean;
    resolvedBy: 'exit' | 'timeout' | 'abort';
    terminalState: Exclude<RemoteRunnerJobState, 'running'>;
    stageTimings: SshLifecycleStageTimings;
    artifactCapture?: SshRunnerArtifactCaptureResult;
  }
> {
  const dispatchStartedAt = performance.now();
  const started = await input.transport.startJob({
    workspaceHandle: input.workspaceHandle,
    command: input.command,
    cwdRelative: input.cwdRelative,
    timeoutMs: input.timeoutMs,
    waitMs: input.transport.lifecycleLongPolling ? 1_000 : 0,
  });
  const dispatchDurationMs = elapsedMonotonicMs(dispatchStartedAt);
  input.onJobStarted?.(started.jobId);
  let stdout = '';
  let stderr = '';
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let commandDurationMs: number | null = null;
  let pollingDurationMs = 0;
  let pollingRoundTrips = 0;
  let artifactCaptureResult: SshRunnerArtifactCaptureResult | undefined;
  const deadline = Date.now() + input.timeoutMs + 15_000;
  let pendingSnapshot = started.snapshot;
  while (true) {
    let snapshot: RemoteRunnerJobSnapshot;
    if (pendingSnapshot) {
      snapshot = pendingSnapshot;
      pendingSnapshot = undefined;
    } else {
      const pollingStartedAt = performance.now();
      snapshot = input.abortSignal?.aborted
        ? await input.transport.cancelJob({
            workspaceHandle: input.workspaceHandle,
            jobId: started.jobId,
            stdoutOffset,
            stderrOffset,
            artifactCapture: artifactCaptureResult
              ? undefined
              : input.artifactCapture,
          })
        : await input.transport.readJob({
            workspaceHandle: input.workspaceHandle,
            jobId: started.jobId,
            stdoutOffset,
            stderrOffset,
            waitMs: input.transport.lifecycleLongPolling ? 1_000 : 0,
            artifactCapture: artifactCaptureResult
              ? undefined
              : input.artifactCapture,
          });
      const pollingElapsedMs = elapsedMonotonicMs(pollingStartedAt);
      if (snapshot.artifactCapture) {
        artifactCaptureResult = snapshot.artifactCapture;
      }
      pollingDurationMs += Math.max(
        0,
        pollingElapsedMs - (snapshot.artifactCapture?.captureDurationMs ?? 0),
      );
      pollingRoundTrips += 1;
    }
    if (snapshot.artifactCapture) {
      artifactCaptureResult = snapshot.artifactCapture;
    }
    stdout = appendRemoteOutput(stdout, snapshot.stdout);
    stderr = appendRemoteOutput(stderr, snapshot.stderr);
    stdoutOffset = snapshot.stdoutOffset;
    stderrOffset = snapshot.stderrOffset;
    commandDurationMs = snapshot.commandDurationMs ?? commandDurationMs;
    const outputComplete =
      snapshot.stdoutComplete !== false && snapshot.stderrComplete !== false;
    if (snapshot.state !== 'running' && outputComplete) {
      return {
        stdout,
        stderr,
        exitCode: snapshot.exitCode ?? 1,
        timedOut: snapshot.state === 'timed-out',
        resolvedBy:
          snapshot.state === 'timed-out'
            ? 'timeout'
            : snapshot.state === 'cancelled'
              ? 'abort'
              : 'exit',
        terminalState: snapshot.state,
        stageTimings: {
          dispatchDurationMs,
          commandDurationMs,
          pollingDurationMs,
          dispatchRoundTrips: 1,
          pollingRoundTrips,
        },
        artifactCapture: artifactCaptureResult,
      };
    }
    if (Date.now() >= deadline) {
      await input.transport
        .cancelJob({
          workspaceHandle: input.workspaceHandle,
          jobId: started.jobId,
          stdoutOffset,
          stderrOffset,
        })
        .catch(() => undefined);
      throw new Error('Remote runner lifecycle status deadline exceeded');
    }
    if (!input.transport.lifecycleLongPolling && snapshot.state === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function appendRemoteOutput(current: string, chunk: string): string {
  const combined = `${current}${chunk}`;
  return combined.length <= MAX_REMOTE_OUTPUT_CHARS
    ? combined
    : combined.slice(combined.length - MAX_REMOTE_OUTPUT_CHARS);
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
}

function assertMaterialization(
  materialization: NonNullable<
    WorkspaceExecutionMountBinding['materialization']
  >,
  runnerName = 'SSH runner',
): void {
  if (
    materialization.version !== 1 ||
    materialization.archiveFormat !== 'tar-gzip'
  ) {
    throw new WorkspaceLeaseValidationError(
      `${runnerName} materialization format is unsupported`,
    );
  }
  if (
    !Number.isSafeInteger(materialization.totalBytes) ||
    materialization.totalBytes < 0 ||
    materialization.archive.byteLength !== materialization.totalBytes ||
    materialization.totalBytes > MAX_MATERIALIZATION_BYTES
  ) {
    throw new WorkspaceLeaseValidationError(
      `${runnerName} materialization size is invalid`,
    );
  }
  assertSha256(materialization.archiveHash, 'Materialization archive hash');
  const actualHash = createHash('sha256')
    .update(materialization.archive)
    .digest('hex');
  if (actualHash !== materialization.archiveHash) {
    throw new WorkspaceLeaseValidationError(
      `${runnerName} materialization archive hash does not match`,
    );
  }
}
