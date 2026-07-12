import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShellService } from './shell-service';
import {
  LocalRunnerAdapter,
  ProviderBackedShellExecution,
  RunnerExecutionError,
  classifyRunnerCommandForPairedReplay,
  classifyRunnerCommandForRouting,
  classifyRunnerReplayIsolationProfile,
  executeDisposableRunnerReplay,
  isRunnerCommandDependencyIsolatable,
  isRunnerCommandWorkspaceConfined,
  selectShellExecutionBackend,
  WorkspaceLeaseValidationError,
  type WorkspaceExecutionProvider,
} from './workspace-execution-provider';
import type { SessionCommandRequest, SessionCommandResult } from './types';
import {
  P256RunnerSigningAuthority,
  commandPayloadForHash,
  createSignedExecutionReceipt,
  createSignedRunnerJob,
  hashRunnerPayload,
  type RunnerSigningAuthority,
  type SignedRunnerJob,
} from './runner-security';
import { hashExecutionArtifactManifest } from './execution-artifact-manifest';

const SNAPSHOT_A = 'a'.repeat(64);
const SNAPSHOT_B = 'b'.repeat(64);
const ENVIRONMENT_HASH = 'c'.repeat(64);

describe('classifyRunnerCommandForRouting', () => {
  it('returns stable content-free classes and conservative capability hints', () => {
    const first = classifyRunnerCommandForRouting({
      command: 'pnpm install --frozen-lockfile',
    });
    const second = classifyRunnerCommandForRouting({
      command: 'pnpm install --offline',
    });

    expect(first.commandClassHash).toBe(second.commandClassHash);
    expect(first.commandClassHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.requiresNetwork).toBe(true);
    expect(first.requiresInteractive).toBe(false);
    expect(JSON.stringify(first)).not.toContain('pnpm');
  });

  it('classifies raw input as interactive without retaining bytes', () => {
    const classified = classifyRunnerCommandForRouting({
      command: 'super-secret-input',
      rawInput: true,
    });

    expect(classified.requiresInteractive).toBe(true);
    expect(classified.requiresNetwork).toBe(false);
    expect(JSON.stringify(classified)).not.toContain('super-secret-input');
  });
});

describe('classifyRunnerCommandForPairedReplay', () => {
  it('separates SSH-safe reads from Docker-only workspace commands', () => {
    expect(
      classifyRunnerCommandForPairedReplay({ command: 'git status --short' }),
    ).toBe('read-only');
    expect(classifyRunnerCommandForPairedReplay({ command: 'pnpm test' })).toBe(
      'workspace-contained',
    );
    expect(
      classifyRunnerCommandForPairedReplay({ command: 'pnpm run typecheck' }),
    ).toBe('workspace-contained');
  });

  it('fails closed for destructive, network, and compound shell commands', () => {
    for (const command of [
      'rm -rf dist',
      'pnpm install',
      'pnpm test && rm -rf dist',
      'git status > status.txt',
    ]) {
      expect(classifyRunnerCommandForPairedReplay({ command })).toBe(
        'ineligible',
      );
    }
  });
});

describe('isRunnerCommandWorkspaceConfined', () => {
  it('accepts workspace-relative read commands', () => {
    for (const command of [
      'git status --short',
      'cat src/index.ts',
      'rg value packages/agent-shell',
    ]) {
      expect(isRunnerCommandWorkspaceConfined({ command })).toBe(true);
    }
  });

  it('rejects paths and Git options that can escape the workspace', () => {
    for (const command of [
      '/bin/cat /etc/passwd',
      'cat /etc/passwd',
      'cat ~/secret',
      'cat ../secret',
      'cat file:///etc/passwd',
      'git -C /tmp status',
      'git --git-dir=/tmp/repo/.git status',
      'git --work-tree ../repo status',
    ]) {
      expect(isRunnerCommandWorkspaceConfined({ command })).toBe(false);
    }
  });
});

describe('isRunnerCommandDependencyIsolatable', () => {
  it.each([
    ['vitest run', 'node-copy-on-write'],
    ['pnpm test', 'node-copy-on-write'],
    ['pnpm run typecheck', 'node-copy-on-write'],
    ['cargo check', 'cargo-cache'],
    ['go test ./...', 'go-cache'],
    ['pnpm install', null],
    ['go install example.test/tool@latest', null],
  ] as const)('maps %s to the expected replay isolation', (command, expected) => {
    expect(classifyRunnerReplayIsolationProfile({ command })).toBe(expected);
  });

  it('allows bounded package-manager build/test commands', () => {
    for (const command of [
      'pnpm test',
      'npm run build',
      'yarn lint',
      'bun typecheck',
      'vitest run',
      'cargo test',
      'go test ./...',
    ]) {
      expect(isRunnerCommandDependencyIsolatable({ command })).toBe(true);
    }
  });

  it('rejects install, package-exec, and non-build package-manager commands', () => {
    for (const command of [
      'pnpm install',
      'pnpm exec biome check .',
      'cargo install ripgrep',
      'go install example.test/tool@latest',
    ]) {
      expect(isRunnerCommandDependencyIsolatable({ command })).toBe(false);
    }
  });
});
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function createShellDouble() {
  const result: SessionCommandResult = {
    sessionId: 'session-1',
    output: 'stdout\nstderr',
    recentOutput: 'tail',
    exitCode: 7,
    sessionExited: true,
    timedOut: false,
    resolvedBy: 'exit',
  };
  const shell = {
    isAvailable: vi.fn(() => true),
    createSession: vi.fn(() => 'session-1'),
    executeInSession: vi.fn(async () => result),
    killSession: vi.fn(() => true),
    getRecentOutputForClassifier: vi.fn(() => 'recent'),
    getSessionCurrentCwd: vi.fn(() => '/workspace'),
    clearPendingOutputs: vi.fn(),
  } as unknown as ShellService;
  return { shell, result };
}

describe('LocalRunnerAdapter', () => {
  it('preserves the existing session command request and result', async () => {
    const { shell, result } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const adapter = new LocalRunnerAdapter(shell, {
      createId: () => 'lease-1',
      receiptAuthority: authority,
      trustedGuardianPublicKey: authority.publicKey,
    });
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_A,
      environmentFingerprintHash: ENVIRONMENT_HASH,
    });
    const abortSignal = new AbortController().signal;
    const command: SessionCommandRequest = {
      command: 'pnpm test',
      sessionId: 'session-1',
      rawInput: true,
      waitUntil: {
        timeoutMs: 12_345,
        exited: true,
        outputPattern: 'done',
        idleMs: 321,
      },
      abortSignal,
    };

    const signedJob = signCommandJob(authority, lease, command);
    await expect(
      adapter.execute(lease, {
        snapshotHash: SNAPSHOT_A,
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        command,
        signedJob,
      }),
    ).resolves.toMatchObject({ value: result });
    expect(shell.executeInSession).toHaveBeenCalledWith(
      'agent-1',
      'tool-1',
      command,
    );
  });

  it('binds local workspace file changes into the receipt', async () => {
    const root = await createRepository();
    const { shell, result } = createShellDouble();
    vi.mocked(shell.getSessionCurrentCwd).mockReturnValue(root);
    vi.mocked(shell.executeInSession).mockImplementation(async () => {
      await writeFile(path.join(root, 'build-result.json'), '{"ok":true}\n');
      return result;
    });
    const authority = P256RunnerSigningAuthority.generate().authority;
    const adapter = new LocalRunnerAdapter(shell, {
      receiptAuthority: authority,
      trustedGuardianPublicKey: authority.publicKey,
    });
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_A,
      environmentFingerprintHash: ENVIRONMENT_HASH,
      mounts: [
        {
          mountPrefix: 'work',
          workspaceRoot: root,
          repositoryRevision: 'revision-1',
          dirtyPatchHash: 'd'.repeat(64),
          hasDirtyChanges: false,
        },
      ],
    });
    const command = { command: 'build', sessionId: 'session-1' };

    const executed = await adapter.execute(lease, {
      snapshotHash: SNAPSHOT_A,
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      command,
      signedJob: signCommandJob(authority, lease, command),
    });

    expect(executed.artifactManifest?.entries).toEqual([
      expect.objectContaining({
        relativePath: 'build-result.json',
        change: 'created',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(executed.receipt.receipt.artifactManifestHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it('preserves artifacts produced before a failed local command', async () => {
    const root = await createRepository();
    const { shell } = createShellDouble();
    vi.mocked(shell.getSessionCurrentCwd).mockReturnValue(root);
    vi.mocked(shell.executeInSession).mockImplementation(async () => {
      await writeFile(path.join(root, 'failure-report.json'), '{"ok":false}\n');
      throw new Error('build failed');
    });
    const authority = P256RunnerSigningAuthority.generate().authority;
    const adapter = new LocalRunnerAdapter(shell, {
      receiptAuthority: authority,
      trustedGuardianPublicKey: authority.publicKey,
    });
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_A,
      environmentFingerprintHash: ENVIRONMENT_HASH,
      mounts: [
        {
          mountPrefix: 'work',
          workspaceRoot: root,
          repositoryRevision: 'revision-1',
          dirtyPatchHash: 'd'.repeat(64),
          hasDirtyChanges: false,
        },
      ],
    });
    const command = { command: 'build', sessionId: 'session-1' };

    const execution = adapter.execute(lease, {
      snapshotHash: SNAPSHOT_A,
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      command,
      signedJob: signCommandJob(authority, lease, command),
    });

    await expect(execution).rejects.toMatchObject({
      name: 'RunnerExecutionError',
      receipt: {
        receipt: {
          outcome: 'failed',
          artifactManifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      artifactManifest: {
        entries: [
          expect.objectContaining({
            relativePath: 'failure-report.json',
            change: 'created',
          }),
        ],
      },
    });
  });

  it('keeps artifact inspection best-effort when a mount is not a Git workspace', async () => {
    const { shell, result } = createShellDouble();
    vi.mocked(shell.getSessionCurrentCwd).mockReturnValue('/missing/workspace');
    const authority = P256RunnerSigningAuthority.generate().authority;
    const adapter = new LocalRunnerAdapter(shell, {
      receiptAuthority: authority,
      trustedGuardianPublicKey: authority.publicKey,
    });
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_A,
      environmentFingerprintHash: ENVIRONMENT_HASH,
      mounts: [
        {
          mountPrefix: 'work',
          workspaceRoot: '/missing/workspace',
          repositoryRevision: null,
          dirtyPatchHash: 'd'.repeat(64),
          hasDirtyChanges: false,
        },
      ],
    });
    const command = { command: 'printf ok', sessionId: 'session-1' };

    await expect(
      adapter.execute(lease, {
        snapshotHash: SNAPSHOT_A,
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        command,
        signedJob: signCommandJob(authority, lease, command),
      }),
    ).resolves.toMatchObject({
      value: result,
      artifactManifest: null,
      receipt: { receipt: { artifactManifestHash: null } },
    });
  });

  it('rejects an untrusted Guardian signature before shell dispatch', async () => {
    const { shell } = createShellDouble();
    const trusted = P256RunnerSigningAuthority.generate().authority;
    const untrusted = P256RunnerSigningAuthority.generate().authority;
    const adapter = new LocalRunnerAdapter(shell, {
      authority: trusted,
      trustedGuardianPublicKey: trusted.publicKey,
    });
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_A,
      environmentFingerprintHash: ENVIRONMENT_HASH,
    });
    const command = { command: 'pnpm test', sessionId: 'session-1' };

    await expect(
      adapter.execute(lease, {
        snapshotHash: SNAPSHOT_A,
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        command,
        signedJob: signCommandJob(untrusted, lease, command),
      }),
    ).rejects.toThrow('runner-job-signature-invalid');
    expect(shell.executeInSession).not.toHaveBeenCalled();
  });

  it('rejects replay of an already admitted signed job', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const adapter = new LocalRunnerAdapter(shell, {
      receiptAuthority: authority,
      trustedGuardianPublicKey: authority.publicKey,
    });
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_A,
      environmentFingerprintHash: ENVIRONMENT_HASH,
    });
    const command = { command: 'pnpm test', sessionId: 'session-1' };
    const signedJob = signCommandJob(authority, lease, command);
    const request = {
      snapshotHash: SNAPSHOT_A,
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      command,
      signedJob,
    };

    await adapter.execute(lease, request);
    await expect(adapter.execute(lease, request)).rejects.toThrow(
      'runner-job-replay',
    );
    expect(shell.executeInSession).toHaveBeenCalledTimes(1);
  });

  it('fails closed before shell dispatch on a snapshot mismatch', async () => {
    const { shell } = createShellDouble();
    const adapter = new LocalRunnerAdapter(shell);
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_A,
      environmentFingerprintHash: ENVIRONMENT_HASH,
    });

    await expect(
      adapter.execute(lease, {
        snapshotHash: SNAPSHOT_B,
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        command: { command: 'rm -rf build', sessionId: 'session-1' },
      }),
    ).rejects.toBeInstanceOf(WorkspaceLeaseValidationError);
    expect(shell.executeInSession).not.toHaveBeenCalled();
  });

  it('does not let a caller mutate a returned lease to bypass validation', async () => {
    const { shell } = createShellDouble();
    const adapter = new LocalRunnerAdapter(shell);
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_A,
      environmentFingerprintHash: ENVIRONMENT_HASH,
    });
    lease.snapshotHash = SNAPSHOT_B;

    await expect(
      adapter.createSession(lease, {
        snapshotHash: SNAPSHOT_B,
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        cwd: '/workspace',
      }),
    ).rejects.toBeInstanceOf(WorkspaceLeaseValidationError);
    expect(shell.createSession).not.toHaveBeenCalled();
  });

  it('rejects expired leases before creating a process', async () => {
    let now = 1_000;
    const { shell } = createShellDouble();
    const adapter = new LocalRunnerAdapter(shell, { now: () => now });
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_A,
      environmentFingerprintHash: ENVIRONMENT_HASH,
      expiresInMs: 50,
    });
    now = 1_050;

    await expect(
      adapter.createSession(lease, {
        snapshotHash: SNAPSHOT_A,
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        cwd: '/workspace',
      }),
    ).rejects.toThrow('expired');
    expect(shell.createSession).not.toHaveBeenCalled();
  });

  it('disposes a lease idempotently', async () => {
    const { shell } = createShellDouble();
    const adapter = new LocalRunnerAdapter(shell);
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_A,
      environmentFingerprintHash: ENVIRONMENT_HASH,
    });

    await adapter.disposeWorkspace(lease);
    await adapter.disposeWorkspace(lease);
    await expect(
      adapter.killSession(lease, {
        snapshotHash: SNAPSHOT_A,
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('unknown or has been disposed');
    expect(shell.killSession).not.toHaveBeenCalled();
  });

  it('blocks nonce replay before a second shell dispatch', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const adapter = new LocalRunnerAdapter(shell, {
      receiptAuthority: authority,
      trustedGuardianPublicKey: authority.publicKey,
    });
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_A,
      environmentFingerprintHash: ENVIRONMENT_HASH,
    });
    const command = { command: 'printf ok', sessionId: 'session-1' };
    const signedJob = signCommandJob(authority, lease, command);
    const request = {
      snapshotHash: SNAPSHOT_A,
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      command,
      signedJob,
    };

    await adapter.execute(lease, request);
    await expect(adapter.execute(lease, request)).rejects.toThrow(
      'runner-job-replay',
    );
    expect(shell.executeInSession).toHaveBeenCalledTimes(1);
  });

  it('rejects a validly signed job bound to another environment', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const adapter = new LocalRunnerAdapter(shell, {
      receiptAuthority: authority,
      trustedGuardianPublicKey: authority.publicKey,
    });
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_A,
      environmentFingerprintHash: ENVIRONMENT_HASH,
    });
    const command = { command: 'pnpm test', sessionId: 'session-1' };
    const signedJob = createSignedRunnerJob({
      providerId: lease.providerId,
      leaseId: lease.id,
      snapshotHash: lease.snapshotHash,
      operation: 'execute-command',
      payloadHash: hashRunnerPayload('execute-command', {
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        command: commandPayloadForHash(command),
      }),
      environmentFingerprintHash: 'd'.repeat(64),
      authority,
    });

    await expect(
      adapter.execute(lease, {
        snapshotHash: SNAPSHOT_A,
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        command,
        signedJob,
      }),
    ).rejects.toThrow('runner-job-binding-mismatch');
    expect(shell.executeInSession).not.toHaveBeenCalled();
  });

  it('does not replay a completed command when receipt audit persistence fails', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const audit = {
      record: vi.fn(async (event: { type: string }) => {
        if (event.type === 'receipt-issued') {
          throw new Error('audit unavailable');
        }
      }),
    };
    const adapter = new LocalRunnerAdapter(shell, {
      receiptAuthority: authority,
      trustedGuardianPublicKey: authority.publicKey,
      audit,
    });
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_A,
      environmentFingerprintHash: ENVIRONMENT_HASH,
    });
    const command = { command: 'printf ok', sessionId: 'session-1' };

    const result = adapter.execute(lease, {
      snapshotHash: SNAPSHOT_A,
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      command,
      signedJob: signCommandJob(authority, lease, command),
    });

    await expect(result).rejects.toMatchObject({
      name: 'RunnerExecutionError',
      message: 'Execution completed but receipt audit could not be persisted',
      receipt: {
        receipt: {
          outcome: 'completed',
          environmentFingerprintHash: ENVIRONMENT_HASH,
        },
      },
    });
    await result.catch((error: unknown) => {
      expect(error).toBeInstanceOf(RunnerExecutionError);
    });
    expect(shell.executeInSession).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(2);
  });
});

describe('ProviderBackedShellExecution', () => {
  it('returns the exact legacy backend while the gate is off', () => {
    const { shell } = createShellDouble();
    const selected = selectShellExecutionBackend({
      enabled: false,
      provider: createProviderDouble(),
      fallback: shell,
      getSnapshotIdentity: async () => ({
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
      }),
      authority: P256RunnerSigningAuthority.generate().authority,
    });

    expect(selected).toBe(shell);
  });

  it('selects the provider-backed route while the gate is on', () => {
    const { shell } = createShellDouble();
    const selected = selectShellExecutionBackend({
      enabled: true,
      provider: createProviderDouble(),
      fallback: shell,
      getSnapshotIdentity: async () => ({
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
      }),
      authority: P256RunnerSigningAuthority.generate().authority,
    });

    expect(selected).toBeInstanceOf(ProviderBackedShellExecution);
  });

  it('uses the legacy path only when preparation fails before dispatch', async () => {
    const { shell, result } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const provider = createProviderDouble(authority);
    provider.prepareWorkspace = vi.fn(async () => {
      throw new Error('runner unavailable');
    });
    const backend = new ProviderBackedShellExecution(
      provider,
      shell,
      async () => ({
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
      }),
      authority,
    );
    const command = { command: 'printf ok', sessionId: 'session-1' };

    await expect(
      backend.executeInSession('agent-1', 'tool-1', command),
    ).resolves.toBe(result);
    expect(shell.executeInSession).toHaveBeenCalledWith(
      'agent-1',
      'tool-1',
      command,
    );
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('fails closed on preparation errors when remote fallback is disabled', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const provider = createProviderDouble(authority);
    provider.prepareWorkspace = vi.fn(async () => {
      throw new Error('remote snapshot mismatch');
    });
    const backend = new ProviderBackedShellExecution(
      provider,
      shell,
      async () => ({
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
      }),
      authority,
      undefined,
      false,
    );

    await expect(
      backend.executeInSession('agent-1', 'tool-1', {
        command: 'pnpm test',
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('remote snapshot mismatch');
    expect(shell.executeInSession).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('never replays a dispatched command through the fallback', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const provider = createProviderDouble(authority);
    provider.execute = vi.fn(async () => {
      throw new Error('provider failed after dispatch');
    });
    const backend = new ProviderBackedShellExecution(
      provider,
      shell,
      async () => ({
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
      }),
      authority,
    );

    await expect(
      backend.executeInSession('agent-1', 'tool-1', {
        command: 'git reset --hard',
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('provider failed after dispatch');
    expect(shell.executeInSession).not.toHaveBeenCalled();
  });

  it('rejects an invalid completion receipt without local replay', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const provider = createProviderDouble(authority);
    Object.defineProperty(provider, 'receiptPublicKey', {
      value: P256RunnerSigningAuthority.generate().authority.publicKey,
    });
    const backend = new ProviderBackedShellExecution(
      provider,
      shell,
      async () => ({
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
      }),
      authority,
    );

    await expect(
      backend.executeInSession('agent-1', 'tool-1', {
        command: 'printf ok',
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('receipt signature or binding is invalid');
    expect(shell.executeInSession).not.toHaveBeenCalled();
  });

  it('rejects an artifact manifest not bound into the signed receipt', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const provider = createProviderDouble(authority);
    provider.execute = vi.fn(async (_lease, request) => ({
      ...dispatchResult(authority, request.signedJob, {
        sessionId: 'session-1',
        output: 'provider',
        exitCode: 0,
        sessionExited: true,
        timedOut: false,
        resolvedBy: 'exit' as const,
      }),
      artifactManifest: {
        version: 1,
        snapshotHash: SNAPSHOT_A,
        entries: [],
        truncated: false,
      },
    }));
    const backend = new ProviderBackedShellExecution(
      provider,
      shell,
      async () => ({
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
      }),
      authority,
    );

    await expect(
      backend.executeInSession('agent-1', 'tool-1', {
        command: 'printf ok',
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('receipt signature or binding is invalid');
    expect(shell.executeInSession).not.toHaveBeenCalled();
  });

  it('emits a verified content-free receipt for Evidence Memory', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const provider = createProviderDouble(authority);
    const onExecutionReceipt = vi.fn(async () => undefined);
    const backend = new ProviderBackedShellExecution(
      provider,
      shell,
      async () => ({
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
        mounts: [
          {
            mountPrefix: 'work',
            workspaceRoot: '/workspace',
            repositoryRevision: 'revision-1',
            dirtyPatchHash: 'd'.repeat(64),
            hasDirtyChanges: true,
          },
        ],
      }),
      authority,
      undefined,
      false,
      onExecutionReceipt,
    );

    await backend.executeInSession('agent-1', 'tool-1', {
      command: 'printf secret-output',
      sessionId: 'session-1',
    });

    expect(onExecutionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        providerId: 'provider-1',
        providerKind: 'local',
        operation: 'execute-command',
        snapshotHash: SNAPSHOT_A,
        repositoryRevision: 'revision-1',
        dirtyPatchHash: 'd'.repeat(64),
        outcome: 'completed',
        receiptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    const evidence = onExecutionReceipt.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(evidence).not.toHaveProperty('command');
    expect(evidence).not.toHaveProperty('output');
  });

  it('emits content-free shadow observations without changing dispatch', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const provider = createProviderDouble(authority);
    const onExecutionReceipt = vi.fn(async () => undefined);
    const observeShadowRoute = vi.fn(() => 'shadow-decision-1');
    const backend = new ProviderBackedShellExecution(
      provider,
      shell,
      async () => ({
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
        mounts: [
          {
            mountPrefix: 'work',
            workspaceRoot: '/workspace',
            repositoryRevision: 'revision-1',
            dirtyPatchHash: 'd'.repeat(64),
            hasDirtyChanges: true,
          },
        ],
      }),
      authority,
      undefined,
      false,
      onExecutionReceipt,
      observeShadowRoute,
    );

    await backend.executeInSession('agent-1', 'tool-1', {
      command: 'private command text',
      sessionId: 'session-1',
      waitUntil: { timeoutMs: 45_000, exited: true },
    });

    expect(observeShadowRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        actualProviderId: 'provider-1',
        actualProviderKind: 'local',
        operation: 'execute-command',
        snapshotHash: SNAPSHOT_A,
        mounts: [
          expect.objectContaining({
            mountPrefix: 'work',
            hasDirtyChanges: true,
          }),
        ],
        expectedDurationMs: 45_000,
        rawInput: false,
        commandClassHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        requiresInteractive: false,
        environmentFingerprintHash: ENVIRONMENT_HASH,
      }),
    );
    expect(JSON.stringify(observeShadowRoute.mock.calls)).not.toContain(
      'private command text',
    );
    expect(onExecutionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        shadowRouteDecisionId: 'shadow-decision-1',
      }),
    );
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect(shell.executeInSession).not.toHaveBeenCalled();
  });

  it('offers verified divergent commands for paired replay without affecting the original result', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const configured = createProviderDouble(authority);
    const replayTarget = createProviderDouble(authority, {
      id: 'docker-replay',
      kind: 'docker',
    });
    const observePairedReplay = vi.fn(async () => {
      throw new Error('replay unavailable');
    });
    const backend = new ProviderBackedShellExecution(
      configured,
      shell,
      async () => ({
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
        mounts: [
          {
            mountPrefix: 'work',
            workspaceRoot: '/workspace',
            repositoryRevision: 'revision-1',
            dirtyPatchHash: 'd'.repeat(64),
            hasDirtyChanges: true,
          },
        ],
      }),
      authority,
      undefined,
      false,
      undefined,
      () => ({
        decisionId: '00000000-0000-4000-8000-000000000001',
        pairedReplayProvider: replayTarget,
      }),
      observePairedReplay,
    );

    await expect(
      backend.executeInSession('agent-1', 'tool-1', {
        command: 'pnpm test',
      }),
    ).resolves.toMatchObject({ output: 'provider', exitCode: 0 });
    await Promise.resolve();

    expect(observePairedReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionId: '00000000-0000-4000-8000-000000000001',
        commandClassHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        riskClass: 'workspace-contained',
        snapshotIdentity: expect.objectContaining({
          snapshotHash: SNAPSHOT_A,
          mounts: [expect.objectContaining({ workspaceRoot: '/workspace' })],
        }),
        actualEvidence: expect.objectContaining({
          providerId: 'provider-1',
          outcome: 'completed',
        }),
        targetProvider: replayTarget,
      }),
    );
    expect(configured.execute).toHaveBeenCalledTimes(1);
    expect(replayTarget.execute).not.toHaveBeenCalled();
    expect(shell.executeInSession).not.toHaveBeenCalled();
  });

  it('automatically routes a sessionless command before dispatch', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const configured = createProviderDouble(authority);
    const selected = createProviderDouble(authority, {
      id: 'provider-2',
      kind: 'ssh',
    });
    const onExecutionReceipt = vi.fn(async () => undefined);
    const resolveRoute = vi.fn(() => ({
      decisionId: 'automatic-decision-1',
      selectedProvider: selected,
    }));
    const backend = new ProviderBackedShellExecution(
      configured,
      shell,
      async () => ({
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
      }),
      authority,
      undefined,
      false,
      onExecutionReceipt,
      resolveRoute,
    );

    await backend.executeInSession('agent-1', 'tool-1', {
      command: 'build',
    });

    expect(configured.execute).not.toHaveBeenCalled();
    expect(selected.execute).toHaveBeenCalledTimes(1);
    expect(configured.disposeWorkspace).toHaveBeenCalledTimes(1);
    expect(selected.disposeWorkspace).toHaveBeenCalledTimes(1);
    expect(onExecutionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'provider-2',
        providerKind: 'ssh',
        configuredProviderId: 'provider-1',
        configuredProviderKind: 'local',
        routeMode: 'automatic',
        shadowRouteDecisionId: 'automatic-decision-1',
      }),
    );
    expect(shell.executeInSession).not.toHaveBeenCalled();
  });

  it('retains provider affinity for existing sessions', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const configured = createProviderDouble(authority);
    const selected = createProviderDouble(authority, {
      id: 'provider-2',
      kind: 'ssh',
    });
    const backend = new ProviderBackedShellExecution(
      configured,
      shell,
      async () => ({
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
      }),
      authority,
      undefined,
      false,
      undefined,
      () => ({
        decisionId: 'automatic-decision-2',
        selectedProvider: selected,
      }),
    );

    await backend.executeInSession('agent-1', 'tool-1', {
      command: 'build',
      sessionId: 'session-1',
    });

    expect(configured.execute).toHaveBeenCalledTimes(1);
    expect(selected.prepareWorkspace).not.toHaveBeenCalled();
    expect(selected.execute).not.toHaveBeenCalled();
  });

  it('falls back only before dispatch when automatic provider preparation fails', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const configured = createProviderDouble(authority);
    const selected = createProviderDouble(authority, {
      id: 'provider-2',
      kind: 'docker',
    });
    selected.prepareWorkspace = vi.fn(async () => {
      throw new Error('runner unavailable');
    });
    const onExecutionReceipt = vi.fn(async () => undefined);
    const backend = new ProviderBackedShellExecution(
      configured,
      shell,
      async () => ({
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
      }),
      authority,
      undefined,
      false,
      onExecutionReceipt,
      () => ({
        decisionId: 'automatic-decision-3',
        selectedProvider: selected,
      }),
    );

    await backend.executeInSession('agent-1', 'tool-1', {
      command: 'build',
    });

    expect(configured.execute).toHaveBeenCalledTimes(1);
    expect(selected.execute).not.toHaveBeenCalled();
    expect(onExecutionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'provider-1',
        routeMode: 'automatic-fallback',
      }),
    );
    expect(shell.executeInSession).not.toHaveBeenCalled();
  });

  it('records a verified failed receipt and ignores Evidence write failures', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const provider = createProviderDouble(authority);
    provider.execute = vi.fn(async (_lease, request) => {
      throw new RunnerExecutionError(
        'remote command failed',
        createSignedExecutionReceipt({
          signedJob: request.signedJob,
          authority,
          startedAt: 10,
          finishedAt: 11,
          outcome: 'failed',
          errorCode: 'RemoteCommandError',
        }),
      );
    });
    const onExecutionReceipt = vi.fn(async () => {
      throw new Error('evidence database unavailable');
    });
    const backend = new ProviderBackedShellExecution(
      provider,
      shell,
      async () => ({
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
      }),
      authority,
      undefined,
      false,
      onExecutionReceipt,
    );

    await expect(
      backend.executeInSession('agent-1', 'tool-1', {
        command: 'false',
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('remote command failed');
    expect(onExecutionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failed',
        errorCode: 'RemoteCommandError',
      }),
    );
    expect(shell.executeInSession).not.toHaveBeenCalled();
  });

  it('forwards a receipt-bound Artifact Manifest to Evidence Memory', async () => {
    const { shell } = createShellDouble();
    const authority = P256RunnerSigningAuthority.generate().authority;
    const provider = createProviderDouble(authority);
    const artifactManifest = {
      version: 1 as const,
      snapshotHash: SNAPSHOT_A,
      entries: [
        {
          relativePath: 'reports/result.json',
          change: 'created' as const,
          sizeBytes: 12,
          mode: 0o644,
          sha256: 'f'.repeat(64),
          omissionReason: null,
        },
      ],
      truncated: false,
    };
    provider.execute = vi.fn(async (_lease, request) => ({
      value: {
        sessionId: 'session-1',
        output: 'provider',
        exitCode: 0,
        sessionExited: true,
        timedOut: false,
        resolvedBy: 'exit' as const,
      },
      artifactManifest,
      receipt: createSignedExecutionReceipt({
        signedJob: request.signedJob,
        authority,
        startedAt: 1,
        finishedAt: 2,
        outcome: 'completed',
        artifactManifestHash: hashExecutionArtifactManifest(artifactManifest),
      }),
    }));
    const onExecutionReceipt = vi.fn(async () => undefined);
    const backend = new ProviderBackedShellExecution(
      provider,
      shell,
      async () => ({
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
      }),
      authority,
      undefined,
      false,
      onExecutionReceipt,
    );

    await backend.executeInSession('agent-1', 'tool-1', {
      command: 'build',
      sessionId: 'session-1',
    });

    expect(onExecutionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactManifestHash: hashExecutionArtifactManifest(artifactManifest),
        artifactManifest,
      }),
    );
  });
});

describe('executeDisposableRunnerReplay', () => {
  it('rejects a normal local provider without disposable isolation', async () => {
    const authority = P256RunnerSigningAuthority.generate().authority;
    const provider = createProviderDouble(authority, {
      id: 'local-runner',
      kind: 'local',
    });

    await expect(
      executeDisposableRunnerReplay({
        provider,
        snapshotIdentity: {
          snapshotHash: SNAPSHOT_A,
          environmentFingerprintHash: ENVIRONMENT_HASH,
        },
        authority,
        command: { command: 'git status' },
        agentInstanceId: 'agent-1',
        decisionId: '00000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toThrow('isolated local provider');
    expect(provider.prepareWorkspace).not.toHaveBeenCalled();
  });

  it('reuses the exact snapshot, creates a fresh session, and tears it down', async () => {
    const authority = P256RunnerSigningAuthority.generate().authority;
    const provider = createProviderDouble(authority, {
      id: 'docker-replay',
      kind: 'docker',
    });

    const evidence = await executeDisposableRunnerReplay({
      provider,
      snapshotIdentity: {
        snapshotHash: SNAPSHOT_A,
        environmentFingerprintHash: ENVIRONMENT_HASH,
        mounts: [
          {
            mountPrefix: 'work',
            workspaceRoot: '/workspace',
            repositoryRevision: 'revision-1',
            dirtyPatchHash: 'd'.repeat(64),
            hasDirtyChanges: true,
          },
        ],
      },
      authority,
      command: { command: 'pnpm test', cwd: '/workspace' },
      agentInstanceId: 'agent-1',
      decisionId: '00000000-0000-4000-8000-000000000001',
      timeoutMs: 5_000,
    });

    expect(provider.prepareWorkspace).toHaveBeenCalledTimes(3);
    for (const [request] of provider.prepareWorkspace.mock.calls) {
      expect(request).toMatchObject({ snapshotHash: SNAPSHOT_A });
    }
    expect(provider.execute).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotHash: SNAPSHOT_A }),
      expect.objectContaining({
        snapshotHash: SNAPSHOT_A,
        command: expect.objectContaining({
          command: 'pnpm test',
          sessionId: 'session-1',
          rawInput: false,
          waitUntil: { timeoutMs: 5_000, exited: true, idleMs: 0 },
        }),
      }),
    );
    expect(provider.killSession).toHaveBeenCalledTimes(1);
    expect(evidence).toMatchObject({
      providerId: 'docker-replay',
      providerKind: 'docker',
      snapshotHash: SNAPSHOT_A,
      operation: 'execute-command',
    });
  });

  it('fails closed before dispatch and never invokes a local fallback', async () => {
    const authority = P256RunnerSigningAuthority.generate().authority;
    const provider = createProviderDouble(authority, {
      id: 'ssh-replay',
      kind: 'ssh',
    });
    provider.prepareWorkspace = vi.fn(async () => {
      throw new Error('snapshot preparation failed');
    });

    await expect(
      executeDisposableRunnerReplay({
        provider,
        snapshotIdentity: {
          snapshotHash: SNAPSHOT_A,
          environmentFingerprintHash: ENVIRONMENT_HASH,
        },
        authority,
        command: { command: 'git status' },
        agentInstanceId: 'agent-1',
        decisionId: '00000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toThrow('snapshot preparation failed');
    expect(provider.createSession).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
  });
});

function createProviderDouble(
  authority = P256RunnerSigningAuthority.generate().authority,
  identity: {
    id?: string;
    kind?: WorkspaceExecutionProvider['kind'];
  } = {},
): WorkspaceExecutionProvider {
  const id = identity.id ?? 'provider-1';
  const kind = identity.kind ?? 'local';
  return {
    id,
    kind,
    receiptPublicKey: authority.publicKey,
    getCapabilities: vi.fn(async () => ({
      persistentSessions: true,
      streamingOutput: true,
      stdin: true,
      cancellation: true,
      workspaceLeases: true,
    })),
    prepareWorkspace: vi.fn(
      async ({ snapshotHash, environmentFingerprintHash }) => ({
        id: 'lease-1',
        providerId: id,
        snapshotHash,
        environmentFingerprintHash,
        createdAt: 1,
        expiresAt: null,
      }),
    ),
    createSession: vi.fn(async (_lease, request) =>
      dispatchResult(authority, request.signedJob, 'session-1'),
    ),
    execute: vi.fn(async (_lease, request) =>
      dispatchResult(authority, request.signedJob, {
        sessionId: 'session-1',
        output: 'provider',
        exitCode: 0,
        sessionExited: true,
        timedOut: false,
        resolvedBy: 'exit' as const,
      }),
    ),
    killSession: vi.fn(async (_lease, request) =>
      dispatchResult(authority, request.signedJob, true),
    ),
    getRecentOutputForClassifier: vi.fn(() => 'recent'),
    getSessionCurrentCwd: vi.fn(() => '/workspace'),
    clearPendingOutputs: vi.fn(),
    disposeWorkspace: vi.fn(async () => {}),
  };
}

function signCommandJob(
  authority: RunnerSigningAuthority,
  lease: {
    id: string;
    providerId: string;
    snapshotHash: string;
    environmentFingerprintHash: string;
  },
  command: SessionCommandRequest,
): SignedRunnerJob {
  return createSignedRunnerJob({
    providerId: lease.providerId,
    leaseId: lease.id,
    snapshotHash: lease.snapshotHash,
    operation: 'execute-command',
    payloadHash: hashRunnerPayload('execute-command', {
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      command: commandPayloadForHash(command),
    }),
    environmentFingerprintHash: lease.environmentFingerprintHash,
    authority,
  });
}

function dispatchResult<T>(
  authority: RunnerSigningAuthority,
  signedJob: SignedRunnerJob,
  value: T,
) {
  return {
    value,
    artifactManifest: null,
    receipt: createSignedExecutionReceipt({
      signedJob,
      authority,
      startedAt: 1,
      finishedAt: 2,
      outcome: 'completed',
    }),
  };
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), `local-runner-artifact-${randomUUID()}-`),
  );
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/index.ts'), 'export const value = 1;\n');
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'runner@example.test']);
  await git(root, ['config', 'user.name', 'Runner Test']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'initial']);
  return root;
}

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
