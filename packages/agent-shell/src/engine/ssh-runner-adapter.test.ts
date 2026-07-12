import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  P256RunnerSigningAuthority,
  commandPayloadForHash,
  createSignedRunnerJob,
  hashRunnerPayload,
  verifySignedExecutionReceipt,
  type RunnerOperation,
  type RunnerSigningAuthority,
} from './runner-security';
import { hashExecutionArtifactManifest } from './execution-artifact-manifest';
import {
  SshRunnerAdapter,
  type SshRunnerTransport,
} from './ssh-runner-adapter';
import type {
  RunnerWorkspacePreparation,
  WorkspaceExecutionMountBinding,
  WorkspaceLease,
} from './workspace-execution-provider';
import {
  hashRunnerExecutionStageTimings,
  hashRunnerWorkspacePreparation,
} from './workspace-execution-provider';

const SNAPSHOT_HASH = 'a'.repeat(64);
const LOCAL_ENVIRONMENT_HASH = 'b'.repeat(64);
const REMOTE_ENVIRONMENT_HASH = 'c'.repeat(64);
const DIRTY_PATCH_HASH = 'd'.repeat(64);
const REPOSITORY_REVISION = '0123456789abcdef';
const MATERIALIZATION_ARCHIVE = Buffer.from('materialization');
const MATERIALIZATION_ARCHIVE_HASH = createHash('sha256')
  .update(MATERIALIZATION_ARCHIVE)
  .digest('hex');
const PREPARATION: RunnerWorkspacePreparation = {
  cacheStatus: 'warm',
  profile: 'node-copy-on-write',
  durationMs: 12,
  workspaceReuseCount: 2,
  transferBytes: 0,
  transferBytesAvoided: MATERIALIZATION_ARCHIVE.byteLength,
};

function createTransport(): SshRunnerTransport {
  return {
    prepareWorkspace: vi.fn(async () => ({
      workspaceHandle: '/tmp/remote-workspace',
      repositoryRevision: REPOSITORY_REVISION,
      dirtyPatchHash: DIRTY_PATCH_HASH,
      materializationArchiveHash: MATERIALIZATION_ARCHIVE_HASH,
      environmentFingerprintHash: REMOTE_ENVIRONMENT_HASH,
      preparation: PREPARATION,
    })),
    execute: vi.fn(async () => ({
      stdout: 'tests passed\n',
      stderr: 'warning\n',
      exitCode: 0,
    })),
    captureWorkspaceArtifactState: vi.fn(async () => ({
      entries: [],
      truncated: false,
    })),
    releaseWorkspace: vi.fn(async () => undefined),
  };
}

function mount(
  overrides: Partial<WorkspaceExecutionMountBinding> = {},
): WorkspaceExecutionMountBinding {
  return {
    mountPrefix: 'work',
    workspaceRoot: '/local/workspace',
    repositoryRevision: REPOSITORY_REVISION,
    dirtyPatchHash: DIRTY_PATCH_HASH,
    hasDirtyChanges: false,
    materialization: {
      version: 1,
      archiveFormat: 'tar-gzip',
      archive: MATERIALIZATION_ARCHIVE,
      archiveHash: MATERIALIZATION_ARCHIVE_HASH,
      totalBytes: MATERIALIZATION_ARCHIVE.byteLength,
    },
    ...overrides,
  };
}

function createAdapter(transport = createTransport()) {
  const guardian = P256RunnerSigningAuthority.generate().authority;
  const runner = P256RunnerSigningAuthority.generate().authority;
  let nextId = 0;
  const adapter = new SshRunnerAdapter('ssh-runner:test', transport, {
    receiptAuthority: runner,
    trustedGuardianPublicKey: guardian.publicKey,
    createId: () => `id-${++nextId}`,
  });
  return { adapter, guardian, runner, transport };
}

describe('SshRunnerAdapter', () => {
  it('admits only an exact remote revision and dirty workspace identity', async () => {
    const { adapter } = createAdapter();
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      environmentFingerprintHash: LOCAL_ENVIRONMENT_HASH,
      mounts: [mount()],
    });

    expect(lease).toMatchObject({
      providerId: 'ssh-runner:test',
      snapshotHash: SNAPSHOT_HASH,
      environmentFingerprintHash: REMOTE_ENVIRONMENT_HASH,
    });
  });

  it('fails closed before dispatch when the remote revision is stale', async () => {
    const transport = createTransport();
    vi.mocked(transport.prepareWorkspace).mockResolvedValueOnce({
      workspaceHandle: '/tmp/stale-workspace',
      repositoryRevision: 'stale-revision',
      dirtyPatchHash: DIRTY_PATCH_HASH,
      materializationArchiveHash: MATERIALIZATION_ARCHIVE_HASH,
      environmentFingerprintHash: REMOTE_ENVIRONMENT_HASH,
    });
    const { adapter } = createAdapter(transport);

    await expect(
      adapter.prepareWorkspace({
        snapshotHash: SNAPSHOT_HASH,
        environmentFingerprintHash: LOCAL_ENVIRONMENT_HASH,
        mounts: [mount()],
      }),
    ).rejects.toThrow('revision does not match');
    expect(transport.execute).not.toHaveBeenCalled();
    expect(transport.releaseWorkspace).toHaveBeenCalledWith(
      '/tmp/stale-workspace',
    );
  });

  it('admits dirty local snapshots when a verified bundle is present', async () => {
    const { adapter, transport } = createAdapter();

    await expect(
      adapter.prepareWorkspace({
        snapshotHash: SNAPSHOT_HASH,
        environmentFingerprintHash: LOCAL_ENVIRONMENT_HASH,
        mounts: [mount({ hasDirtyChanges: true })],
      }),
    ).resolves.toMatchObject({ snapshotHash: SNAPSHOT_HASH });
    expect(transport.prepareWorkspace).toHaveBeenCalledOnce();
  });

  it('rejects a remotely observed materialization archive mismatch', async () => {
    const transport = createTransport();
    vi.mocked(transport.prepareWorkspace).mockResolvedValueOnce({
      workspaceHandle: '/tmp/remote-workspace',
      repositoryRevision: REPOSITORY_REVISION,
      dirtyPatchHash: DIRTY_PATCH_HASH,
      materializationArchiveHash: 'e'.repeat(64),
      environmentFingerprintHash: REMOTE_ENVIRONMENT_HASH,
    });
    const { adapter } = createAdapter(transport);

    await expect(
      adapter.prepareWorkspace({
        snapshotHash: SNAPSHOT_HASH,
        environmentFingerprintHash: LOCAL_ENVIRONMENT_HASH,
        mounts: [mount({ hasDirtyChanges: true })],
      }),
    ).rejects.toThrow('archive does not match');
    expect(transport.releaseWorkspace).toHaveBeenCalledWith(
      '/tmp/remote-workspace',
    );
  });

  it('runs one-shot commands and signs receipts with a distinct runner key', async () => {
    const { adapter, guardian, runner, transport } = createAdapter();
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      environmentFingerprintHash: LOCAL_ENVIRONMENT_HASH,
      mounts: [mount()],
    });
    const createPayload = {
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-create',
      cwd: '/local/workspace/packages/app',
    };
    const created = await adapter.createSession(lease, {
      snapshotHash: SNAPSHOT_HASH,
      ...createPayload,
      signedJob: signJob(guardian, lease, 'create-session', createPayload),
    });
    await adapter.disposeWorkspace(lease);
    const executeLease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      environmentFingerprintHash: LOCAL_ENVIRONMENT_HASH,
      mounts: [mount()],
      resumeSessionId: created.value,
    });
    const command = {
      command: 'pnpm test',
      sessionId: created.value,
      waitUntil: { exited: true, timeoutMs: 300_000 },
    };
    const executePayload = {
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-execute',
      command: commandPayloadForHash(command),
    };
    const executed = await adapter.execute(executeLease, {
      snapshotHash: SNAPSHOT_HASH,
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-execute',
      command,
      signedJob: signJob(
        guardian,
        executeLease,
        'execute-command',
        executePayload,
      ),
    });

    expect(transport.execute).toHaveBeenCalledWith({
      workspaceHandle: '/tmp/remote-workspace',
      command: 'pnpm test',
      cwdRelative: 'packages/app',
      timeoutMs: 300_000,
    });
    expect(executed.value).toMatchObject({
      output: 'tests passed\nwarning\n',
      exitCode: 0,
      resolvedBy: 'exit',
    });
    expect(executed.receipt.receipt).toMatchObject({
      version: 3,
      remoteJobId: null,
      terminalState: 'completed',
      workspacePreparationHash: hashRunnerWorkspacePreparation(PREPARATION),
      executionTimingHash: hashRunnerExecutionStageTimings(
        executed.executionTimings!,
      ),
    });
    expect(executed.receipt.publicKey).toBe(runner.publicKey);
    expect(executed.receipt.publicKey).not.toBe(guardian.publicKey);
    expect(
      verifySignedExecutionReceipt(executed.receipt, runner.publicKey),
    ).toBe(true);
  });

  it('binds remote file artifacts into the signed execution receipt', async () => {
    const transport = createTransport();
    vi.mocked(transport.captureWorkspaceArtifactState)
      .mockResolvedValueOnce({ entries: [], truncated: false })
      .mockResolvedValueOnce({
        entries: [
          {
            relativePath: 'reports/result.json',
            tracked: false,
            kind: 'file',
            sizeBytes: 12,
            mode: 0o644,
            sha256: 'f'.repeat(64),
            modifiedAtMs: 2_000,
            omissionReason: null,
          },
        ],
        truncated: false,
      });
    const { adapter, guardian } = createAdapter(transport);
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      environmentFingerprintHash: LOCAL_ENVIRONMENT_HASH,
      mounts: [mount()],
    });
    const createPayload = {
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-create',
      cwd: '/local/workspace',
    };
    const created = await adapter.createSession(lease, {
      snapshotHash: SNAPSHOT_HASH,
      ...createPayload,
      signedJob: signJob(guardian, lease, 'create-session', createPayload),
    });
    const command = {
      command: 'mkdir -p reports && printf ok > reports/result.json',
      sessionId: created.value,
    };
    const payload = {
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-execute',
      command: commandPayloadForHash(command),
    };

    const executed = await adapter.execute(lease, {
      snapshotHash: SNAPSHOT_HASH,
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-execute',
      command,
      signedJob: signJob(guardian, lease, 'execute-command', payload),
    });

    expect(executed.artifactManifest).toEqual({
      version: 1,
      snapshotHash: SNAPSHOT_HASH,
      entries: [
        expect.objectContaining({
          relativePath: 'reports/result.json',
          change: 'created',
          sha256: 'f'.repeat(64),
        }),
      ],
      truncated: false,
    });
    expect(executed.receipt.receipt.artifactManifestHash).toBe(
      hashExecutionArtifactManifest(executed.artifactManifest!),
    );
  });

  it('uses the server-side Artifact Manifest fast path without legacy path round trips', async () => {
    const transport: SshRunnerTransport = {
      ...createTransport(),
      artifactManifestFastPath: true,
    };
    let roundTrips = 0;
    transport.getRoundTripCount = () => roundTrips;
    transport.beginWorkspaceArtifactCapture = vi.fn(async () => {
      roundTrips += 1;
      return {
        captureId: `artifact-${'1'.repeat(32)}`,
        snapshotHash: SNAPSHOT_HASH,
      };
    });
    vi.mocked(transport.execute).mockImplementationOnce(async () => {
      roundTrips += 1;
      return { stdout: 'ok\n', stderr: '', exitCode: 0 };
    });
    const manifest = {
      version: 1 as const,
      snapshotHash: SNAPSHOT_HASH,
      entries: [
        {
          relativePath: 'reports/result.json',
          change: 'created' as const,
          sizeBytes: 2,
          mode: 0o644,
          sha256: 'f'.repeat(64),
          omissionReason: null,
        },
      ],
      truncated: false,
    };
    transport.finalizeWorkspaceArtifactCapture = vi.fn(async () => {
      roundTrips += 1;
      return { manifest, captureDurationMs: 4 };
    });
    const { adapter, guardian } = createAdapter(transport);
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      environmentFingerprintHash: LOCAL_ENVIRONMENT_HASH,
      mounts: [mount()],
    });
    const createPayload = {
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-create',
      cwd: '/local/workspace',
    };
    const created = await adapter.createSession(lease, {
      snapshotHash: SNAPSHOT_HASH,
      ...createPayload,
      signedJob: signJob(guardian, lease, 'create-session', createPayload),
    });
    const command = { command: 'true', sessionId: created.value };
    const executed = await adapter.execute(lease, {
      snapshotHash: SNAPSHOT_HASH,
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-execute',
      command,
      signedJob: signJob(guardian, lease, 'execute-command', {
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-execute',
        command: commandPayloadForHash(command),
      }),
    });

    expect(executed.artifactManifest).toEqual(manifest);
    expect(transport.captureWorkspaceArtifactState).not.toHaveBeenCalled();
    expect(transport.beginWorkspaceArtifactCapture).toHaveBeenCalledTimes(1);
    expect(transport.finalizeWorkspaceArtifactCapture).toHaveBeenCalledTimes(1);
    expect(executed.executionTimings).toMatchObject({
      sshRoundTrips: 3,
      artifactBeforeRoundTrips: 1,
      dispatchRoundTrips: 1,
      pollingRoundTrips: 0,
      artifactAfterRoundTrips: 1,
    });
  });

  it('rejects stdin without invoking the SSH transport', async () => {
    const { adapter, guardian, transport } = createAdapter();
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      environmentFingerprintHash: LOCAL_ENVIRONMENT_HASH,
      mounts: [mount()],
    });
    const createPayload = {
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-create',
      cwd: '/local/workspace',
    };
    const created = await adapter.createSession(lease, {
      snapshotHash: SNAPSHOT_HASH,
      ...createPayload,
      signedJob: signJob(guardian, lease, 'create-session', createPayload),
    });
    const command = {
      command: 'y\r',
      sessionId: created.value,
      rawInput: true,
    };

    await expect(
      adapter.execute(lease, {
        snapshotHash: SNAPSHOT_HASH,
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-execute',
        command,
        signedJob: signJob(guardian, lease, 'execute-command', {
          agentInstanceId: 'agent-1',
          toolCallId: 'tool-execute',
          command: commandPayloadForHash(command),
        }),
      }),
    ).rejects.toThrow('does not support stdin');
    expect(transport.execute).not.toHaveBeenCalled();
  });

  it('blocks replay before a second remote process is started', async () => {
    const { adapter, guardian, transport } = createAdapter();
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      environmentFingerprintHash: LOCAL_ENVIRONMENT_HASH,
      mounts: [mount()],
    });
    const createPayload = {
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-create',
      cwd: '/local/workspace',
    };
    const created = await adapter.createSession(lease, {
      snapshotHash: SNAPSHOT_HASH,
      ...createPayload,
      signedJob: signJob(guardian, lease, 'create-session', createPayload),
    });
    const command = {
      command: 'pnpm test',
      sessionId: created.value,
    };
    const request = {
      snapshotHash: SNAPSHOT_HASH,
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-execute',
      command,
      signedJob: signJob(guardian, lease, 'execute-command', {
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-execute',
        command: commandPayloadForHash(command),
      }),
    };

    await adapter.execute(lease, request);
    await expect(adapter.execute(lease, request)).rejects.toThrow(
      'runner-job-replay',
    );
    expect(transport.execute).toHaveBeenCalledTimes(1);
  });

  it('polls lifecycle output by offset until the remote job completes', async () => {
    const transport = createTransport();
    transport.startJob = vi.fn(async () => ({
      jobId: `job-${'1'.repeat(32)}`,
    }));
    transport.readJob = vi
      .fn()
      .mockResolvedValueOnce({
        jobId: `job-${'1'.repeat(32)}`,
        state: 'running',
        stdout: 'first\n',
        stderr: '',
        stdoutOffset: 6,
        stderrOffset: 0,
        exitCode: null,
      })
      .mockResolvedValueOnce({
        jobId: `job-${'1'.repeat(32)}`,
        state: 'completed',
        stdout: 'second\n',
        stderr: 'warning\n',
        stdoutOffset: 13,
        stderrOffset: 8,
        exitCode: 0,
      });
    transport.cancelJob = vi.fn();
    const { adapter, guardian } = createAdapter(transport);
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      environmentFingerprintHash: LOCAL_ENVIRONMENT_HASH,
      mounts: [mount()],
    });
    const createPayload = {
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-create',
      cwd: '/local/workspace',
    };
    const created = await adapter.createSession(lease, {
      snapshotHash: SNAPSHOT_HASH,
      ...createPayload,
      signedJob: signJob(guardian, lease, 'create-session', createPayload),
    });
    const command = {
      command: 'pnpm test',
      sessionId: created.value,
      waitUntil: { exited: true, timeoutMs: 10_000 },
    };
    const executed = await adapter.execute(lease, {
      snapshotHash: SNAPSHOT_HASH,
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-execute',
      command,
      signedJob: signJob(guardian, lease, 'execute-command', {
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-execute',
        command: commandPayloadForHash(command),
      }),
    });

    expect(executed.value).toMatchObject({
      output: 'first\nsecond\nwarning\n',
      exitCode: 0,
      timedOut: false,
      resolvedBy: 'exit',
    });
    expect(executed.receipt.receipt).toMatchObject({
      version: 3,
      remoteJobId: `job-${'1'.repeat(32)}`,
      terminalState: 'completed',
      executionTimingHash: hashRunnerExecutionStageTimings(
        executed.executionTimings!,
      ),
    });
    expect(executed.executionTimings).toMatchObject({
      version: 1,
      dispatchRoundTrips: 1,
      pollingRoundTrips: 2,
      commandDurationMs: null,
    });
    expect(transport.execute).not.toHaveBeenCalled();
    expect(transport.readJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        stdoutOffset: 6,
        stderrOffset: 0,
      }),
    );
    await expect(adapter.getCapabilities()).resolves.toMatchObject({
      streamingOutput: true,
      cancellation: true,
    });
  });

  it('uses a terminal lifecycle read as the Artifact Manifest finalization round trip', async () => {
    let roundTrips = 0;
    const manifest = {
      version: 1 as const,
      snapshotHash: SNAPSHOT_HASH,
      entries: [
        {
          relativePath: 'reports/result.json',
          change: 'created' as const,
          sizeBytes: 2,
          mode: 0o644,
          sha256: 'f'.repeat(64),
          omissionReason: null,
        },
      ],
      truncated: false,
    };
    const transport: SshRunnerTransport = {
      ...createTransport(),
      lifecycleLongPolling: true,
      artifactManifestFastPath: true,
      getRoundTripCount: () => roundTrips,
      beginWorkspaceArtifactCapture: vi.fn(async () => {
        roundTrips += 1;
        return {
          captureId: `artifact-${'3'.repeat(32)}`,
          snapshotHash: SNAPSHOT_HASH,
        };
      }),
      finalizeWorkspaceArtifactCapture: vi.fn(async () => {
        throw new Error('standalone finalization must not run');
      }),
      startJob: vi.fn(async () => {
        roundTrips += 1;
        return { jobId: `job-${'3'.repeat(32)}` };
      }),
      readJob: vi.fn(async (input) => {
        roundTrips += 1;
        expect(input.artifactCapture).toMatchObject({
          snapshotHash: SNAPSHOT_HASH,
        });
        return {
          jobId: input.jobId,
          state: 'completed' as const,
          stdout: 'ok\n',
          stderr: '',
          stdoutOffset: 3,
          stderrOffset: 0,
          exitCode: 0,
          commandDurationMs: 5,
          artifactCapture: { manifest, captureDurationMs: 7 },
        };
      }),
      cancelJob: vi.fn(),
    };
    const { adapter, guardian } = createAdapter(transport);
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      environmentFingerprintHash: LOCAL_ENVIRONMENT_HASH,
      mounts: [mount()],
    });
    const createPayload = {
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-create',
      cwd: '/local/workspace',
    };
    const created = await adapter.createSession(lease, {
      snapshotHash: SNAPSHOT_HASH,
      ...createPayload,
      signedJob: signJob(guardian, lease, 'create-session', createPayload),
    });
    const command = { command: 'true', sessionId: created.value };
    const executed = await adapter.execute(lease, {
      snapshotHash: SNAPSHOT_HASH,
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-execute',
      command,
      signedJob: signJob(guardian, lease, 'execute-command', {
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-execute',
        command: commandPayloadForHash(command),
      }),
    });

    expect(executed.artifactManifest).toEqual(manifest);
    expect(transport.finalizeWorkspaceArtifactCapture).not.toHaveBeenCalled();
    expect(transport.captureWorkspaceArtifactState).not.toHaveBeenCalled();
    expect(executed.executionTimings).toMatchObject({
      sshRoundTrips: 3,
      artifactBeforeRoundTrips: 1,
      dispatchRoundTrips: 1,
      pollingRoundTrips: 1,
      artifactAfterRoundTrips: 0,
      artifactAfterDurationMs: 7,
    });
  });

  it('cancels the remote process group when the abort signal fires', async () => {
    const controller = new AbortController();
    const transport = createTransport();
    transport.startJob = vi.fn(async () => ({
      jobId: `job-${'2'.repeat(32)}`,
    }));
    transport.readJob = vi.fn(async () => {
      controller.abort();
      return {
        jobId: `job-${'2'.repeat(32)}`,
        state: 'running' as const,
        stdout: 'started\n',
        stderr: '',
        stdoutOffset: 8,
        stderrOffset: 0,
        exitCode: null,
      };
    });
    transport.cancelJob = vi.fn(async (input) => ({
      jobId: input.jobId,
      state: 'cancelled' as const,
      stdout: '',
      stderr: '',
      stdoutOffset: input.stdoutOffset,
      stderrOffset: input.stderrOffset,
      exitCode: 130,
    }));
    const { adapter, guardian } = createAdapter(transport);
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      environmentFingerprintHash: LOCAL_ENVIRONMENT_HASH,
      mounts: [mount()],
    });
    const createPayload = {
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-create',
      cwd: '/local/workspace',
    };
    const created = await adapter.createSession(lease, {
      snapshotHash: SNAPSHOT_HASH,
      ...createPayload,
      signedJob: signJob(guardian, lease, 'create-session', createPayload),
    });
    const command = {
      command: 'sleep 60',
      sessionId: created.value,
      abortSignal: controller.signal,
    };
    const executed = await adapter.execute(lease, {
      snapshotHash: SNAPSHOT_HASH,
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-execute',
      command,
      signedJob: signJob(guardian, lease, 'execute-command', {
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-execute',
        command: commandPayloadForHash(command),
      }),
    });

    expect(executed.value).toMatchObject({
      exitCode: 130,
      timedOut: false,
      resolvedBy: 'abort',
    });
    expect(executed.receipt.receipt).toMatchObject({
      remoteJobId: `job-${'2'.repeat(32)}`,
      terminalState: 'cancelled',
    });
    expect(transport.cancelJob).toHaveBeenCalledWith(
      expect.objectContaining({
        stdoutOffset: 8,
        stderrOffset: 0,
      }),
    );
  });

  it('releases session-owned remote workspaces during adapter disposal', async () => {
    const { adapter, guardian, transport } = createAdapter();
    const lease = await adapter.prepareWorkspace({
      snapshotHash: SNAPSHOT_HASH,
      environmentFingerprintHash: LOCAL_ENVIRONMENT_HASH,
      mounts: [mount()],
    });
    const createPayload = {
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-create',
      cwd: '/local/workspace',
    };
    await adapter.createSession(lease, {
      snapshotHash: SNAPSHOT_HASH,
      ...createPayload,
      signedJob: signJob(guardian, lease, 'create-session', createPayload),
    });

    await adapter.dispose();

    expect(transport.releaseWorkspace).toHaveBeenCalledOnce();
    expect(transport.releaseWorkspace).toHaveBeenCalledWith(
      '/tmp/remote-workspace',
    );
  });
});

function signJob(
  authority: RunnerSigningAuthority,
  lease: WorkspaceLease,
  operation: RunnerOperation,
  payload: unknown,
) {
  return createSignedRunnerJob({
    providerId: lease.providerId,
    leaseId: lease.id,
    snapshotHash: lease.snapshotHash,
    operation,
    payloadHash: hashRunnerPayload(operation, payload),
    environmentFingerprintHash: lease.environmentFingerprintHash,
    authority,
  });
}
