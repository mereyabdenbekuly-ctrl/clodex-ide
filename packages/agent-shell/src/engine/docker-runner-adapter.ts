import type { SessionCommandResult } from './types';
import {
  SshRunnerAdapter,
  type SshRunnerCommandResult,
  type SshRunnerPreparedWorkspace,
  type SshRunnerTransport,
} from './ssh-runner-adapter';
import type {
  CommandExecutionRequest,
  CreateExecutionSessionRequest,
  PrepareWorkspaceRequest,
  RunnerCapabilities,
  RunnerDispatchResult,
  WorkspaceExecutionProvider,
  WorkspaceLease,
} from './workspace-execution-provider';
import type {
  RunnerSecurityAuditSink,
  RunnerSigningAuthority,
  SignedRunnerJob,
} from './runner-security';

export type DockerRunnerPreparedWorkspace = SshRunnerPreparedWorkspace;
export type DockerRunnerCommandResult = SshRunnerCommandResult;
export type DockerRunnerTransport = SshRunnerTransport;

/**
 * Docker Runner v1 intentionally reuses the hardened non-interactive runner
 * admission, receipt, artifact-manifest, nonce, and lease implementation.
 * Only workspace preparation and command transport differ from SSH.
 */
export class DockerRunnerAdapter implements WorkspaceExecutionProvider {
  public readonly kind = 'docker' as const;
  public readonly receiptPublicKey: string;
  private readonly delegate: SshRunnerAdapter;

  public constructor(
    public readonly id: string,
    transport: DockerRunnerTransport,
    options: {
      receiptAuthority: RunnerSigningAuthority;
      trustedGuardianPublicKey: string;
      audit?: RunnerSecurityAuditSink;
      now?: () => number;
      createId?: () => string;
    },
  ) {
    if (!id.trim()) throw new Error('Docker runner id is required');
    this.delegate = new SshRunnerAdapter(id, transport, {
      ...options,
      runnerName: 'Docker runner',
    });
    this.receiptPublicKey = this.delegate.receiptPublicKey;
  }

  public getCapabilities(): Promise<RunnerCapabilities> {
    return this.delegate.getCapabilities();
  }

  public prepareWorkspace(
    request: PrepareWorkspaceRequest,
  ): Promise<WorkspaceLease> {
    return this.delegate.prepareWorkspace(request);
  }

  public createSession(
    lease: WorkspaceLease,
    request: CreateExecutionSessionRequest,
  ): Promise<RunnerDispatchResult<string>> {
    return this.delegate.createSession(lease, request);
  }

  public execute(
    lease: WorkspaceLease,
    request: CommandExecutionRequest,
  ): Promise<RunnerDispatchResult<SessionCommandResult>> {
    return this.delegate.execute(lease, request);
  }

  public killSession(
    lease: WorkspaceLease,
    request: {
      snapshotHash: string;
      sessionId: string;
      signedJob: SignedRunnerJob;
    },
  ): Promise<RunnerDispatchResult<boolean>> {
    return this.delegate.killSession(lease, request);
  }

  public getRecentOutputForClassifier(
    _sessionId: string,
    _maxLines: number,
  ): string | undefined {
    return this.delegate.getRecentOutputForClassifier();
  }

  public getSessionCurrentCwd(sessionId: string): string | undefined {
    return this.delegate.getSessionCurrentCwd(sessionId);
  }

  public clearPendingOutputs(
    _agentInstanceId: string,
    _toolCallId: string,
  ): void {
    this.delegate.clearPendingOutputs();
  }

  public disposeWorkspace(lease: WorkspaceLease): Promise<void> {
    return this.delegate.disposeWorkspace(lease);
  }

  public dispose(): Promise<void> {
    return this.delegate.dispose();
  }
}
