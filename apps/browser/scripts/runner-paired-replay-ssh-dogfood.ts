import { spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import {
  P256RunnerSigningAuthority,
  SshRunnerAdapter,
  classifyRunnerCommandForRouting,
  classifyRunnerReplayIsolationProfile,
  createSignedExecutionReceipt,
  createSignedRunnerJob,
  executeDisposableRunnerReplay,
  hashExecutionReceipt,
  hashRunnerJob,
  hashRunnerPayload,
  type RunnerExecutionEvidence,
  type RunnerSecurityAuditEvent,
} from '@clodex/agent-shell';
import { createWorkspaceSnapshot } from '@clodex/agent-core/agents';
import { resolveRunnerPairedReplayProfile } from '@clodex/agent-core/runner-routing';
import { buildLocalWorkspaceSnapshotMetadata } from '../src/backend/agent-host/workspace-snapshot-builder';
import { RemoteConnectionSshRunnerTransport } from '../src/backend/services/remote-connections/ssh-runner-transport';
import type { RemoteConnectionsService } from '../src/backend/services/remote-connections';
import {
  runnerDogfoodEvidenceScenarios,
  signRunnerDogfoodEvidenceBundle,
  type RunnerDogfoodEvidenceSample,
  type RunnerDogfoodEvidenceScenario,
} from '../src/backend/services/runner-routing/dogfood-evidence';

const execFileAsync = promisify(execFile);
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const ORGANIC_WORKLOADS = [
  { label: 'git-status', command: 'git status --short' },
  { label: 'git-diff-stat', command: 'git diff --stat' },
  { label: 'git-log-200', command: 'git log -n 200 --oneline' },
  { label: 'git-revision', command: 'git rev-parse HEAD' },
] as const;

async function main(): Promise<void> {
  const target = requiredEnvironment('CLODEX_RUNNER_DOGFOOD_SSH_TARGET');
  const remotePath = requiredEnvironment(
    'CLODEX_RUNNER_DOGFOOD_SSH_REMOTE_PATH',
  );
  const repositoryRoot = (
    await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    })
  ).stdout.trim();
  const revision = await resolveDogfoodRevision(repositoryRoot);
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), 'clodex-ssh-dogfood-'),
  );
  const localWorktree = path.join(temporaryRoot, 'workspace');
  const auditEvents: RunnerSecurityAuditEvent[] = [];
  const collectorIdentityPath =
    process.env.CLODEX_RUNNER_DOGFOOD_COLLECTOR_IDENTITY_PATH?.trim() ||
    path.join(os.homedir(), '.clodex', 'dogfood', 'collector-identity.json');
  const collectorIdentity = await loadOrCreateCollectorIdentity(
    collectorIdentityPath,
  );
  const scenarios = readDogfoodScenarios();
  const repetitions = readBoundedIntegerEnvironment(
    'CLODEX_RUNNER_DOGFOOD_REPETITIONS',
    1,
    1,
    10,
  );
  let executor: DirectSshRunnerExecutor | null = null;

  try {
    await execFileAsync('git', [
      '-C',
      repositoryRoot,
      'worktree',
      'add',
      '--detach',
      localWorktree,
      revision,
    ]);
    await execFileAsync(
      'pnpm',
      ['install', '--offline', '--frozen-lockfile', '--ignore-scripts'],
      { cwd: localWorktree, timeout: 120_000 },
    );
    await createDirtyDogfoodState(localWorktree);

    const metadata = await buildLocalWorkspaceSnapshotMetadata({
      mounts: [{ prefix: 'work', path: localWorktree }],
      entries: [],
      selection: 'mounted-workspaces',
      includeMaterialization: true,
    });
    const snapshot = createWorkspaceSnapshot({
      selection: 'mounted-workspaces',
      entries: [],
      mounts: metadata.mounts,
      environment: metadata.environment,
    });
    const mount = metadata.mounts[0];
    if (!mount?.materialization) {
      throw new Error('SSH dogfood snapshot did not produce materialization');
    }

    executor = new DirectSshRunnerExecutor(target, remotePath);
    const connectionId = '00000000-0000-4000-8000-000000000001';
    const transport = new RemoteConnectionSshRunnerTransport(
      executor as unknown as RemoteConnectionsService,
      connectionId,
      {
        enabled: true,
        diagnosticErrors: true,
        allowDependencyFetch: true,
        multiplexedProtocolEnabled: true,
        artifactManifestFastPathEnabled: true,
      },
    );
    const guardian = new P256RunnerSigningAuthority(collectorIdentity);
    const runner = P256RunnerSigningAuthority.generate().authority;
    const localRunner = P256RunnerSigningAuthority.generate().authority;
    const provider = new SshRunnerAdapter(
      `ssh-runner:dogfood:${target}`,
      transport,
      {
        receiptAuthority: runner,
        trustedGuardianPublicKey: guardian.publicKey,
        runnerName: 'SSH dogfood runner',
        heavyweightCacheEnabled: true,
        audit: {
          record: async (event) => {
            auditEvents.push(event);
          },
        },
      },
    );
    const snapshotIdentity = {
      snapshotHash: snapshot.snapshotHash,
      environmentFingerprintHash: snapshot.environment.fingerprintHash,
      mounts: [
        {
          mountPrefix: mount.mountPrefix,
          workspaceRoot: localWorktree,
          repositoryRevision: mount.repositoryRevision,
          dirtyPatchHash: mount.dirtyPatchHash,
          dependencyFingerprintHash: mount.dependencyFingerprintHash,
          hasDirtyChanges: mount.hasDirtyChanges,
          materialization: mount.materialization,
        },
      ],
    };

    const workloads = createDogfoodWorkloads(scenarios, repetitions);
    const evidence: RunnerExecutionEvidence[] = [];
    const samples: RunnerDogfoodEvidenceSample[] = [];
    const workloadResults = [];
    for (const [index, workload] of workloads.entries()) {
      const cwd = path.join(localWorktree, workload.cwdRelative ?? '');
      const request = { command: workload.command, cwd };
      const actual = await executeLocalDogfoodBaseline({
        command: workload.command,
        cwd,
        snapshotHash: snapshot.snapshotHash,
        environmentFingerprintHash: snapshot.environment.fingerprintHash,
        guardian,
        runner: localRunner,
        timeoutMs: workload.localTimeoutMs,
        preDispatchDelayMs: workload.localPreDispatchDelayMs,
        environmentFault: workload.localEnvironmentFault,
      });
      const replay = await executeDisposableRunnerReplay({
        provider,
        snapshotIdentity,
        authority: guardian,
        command: request,
        agentInstanceId: 'runner-dogfood',
        decisionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        timeoutMs: workload.remoteTimeoutMs ?? 60_000,
      });
      evidence.push(replay);
      const replayExecution = toDogfoodExecution(replay);
      const profile = resolveRunnerPairedReplayProfile({
        targetProviderKind: 'ssh',
        dependencyIsolationProfile:
          classifyRunnerReplayIsolationProfile(request),
      });
      if (!profile) throw new Error('SSH dogfood profile is unresolved');
      samples.push({
        sampleId: randomUUID(),
        profile,
        scenario: workload.scenario,
        promotionEligible: workload.scenario.startsWith('organic-'),
        commandClassHash:
          classifyRunnerCommandForRouting(request).commandClassHash,
        snapshotHash: snapshot.snapshotHash,
        actual,
        replay: replayExecution,
      });
      workloadResults.push({
        label: workload.label,
        scenario: workload.scenario,
        profile,
        promotionEligible: workload.scenario.startsWith('organic-'),
        actualOutcome: actual.outcome,
        actualTimedOut: actual.timedOut,
        actualDurationMs: actual.durationMs,
        replayOutcome: replayExecution.outcome,
        replayTimedOut: replayExecution.timedOut,
        replayDurationMs: replayExecution.durationMs,
        replayPreparationDurationMs: replayExecution.preparationDurationMs,
        replayTotalDurationMs: replayExecution.totalDurationMs,
        sshRoundTrips: replay.executionTimings?.sshRoundTrips,
        commandDurationMs: replay.executionTimings?.commandDurationMs,
        pollingDurationMs: replay.executionTimings?.pollingDurationMs,
        artifactDurationMs:
          replay.executionTimings === undefined
            ? undefined
            : replay.executionTimings.artifactBeforeDurationMs +
              replay.executionTimings.artifactAfterDurationMs,
        receiptFinalizationDurationMs:
          replay.executionTimings?.receiptFinalizationDurationMs,
        latencyAdvantageMs:
          actual.outcome === 'completed' &&
          replayExecution.outcome === 'completed'
            ? actual.durationMs - replayExecution.durationMs
            : null,
      });
    }
    const bundle = signRunnerDogfoodEvidenceBundle(
      {
        schemaVersion: 2,
        bundleId: randomUUID(),
        collectedAt: Date.now(),
        sourceCommitSha: revision,
        samples,
      },
      collectorIdentity,
    );
    const bundlePath = await writeEvidenceBundle(bundle);

    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          checkedAt: Date.now(),
          target,
          remotePath,
          revision,
          snapshotHash: snapshot.snapshotHash,
          dirtyPatchHash: mount.dirtyPatchHash,
          dependencyFingerprintHash: mount.dependencyFingerprintHash,
          hasDirtyChanges: mount.hasDirtyChanges,
          runnerKeyDistinctFromGuardian:
            runner.publicKey !== guardian.publicKey,
          collectorKeyId: guardian.keyId,
          collectorPublicKey: guardian.publicKey,
          evidenceBundleId: bundle.bundleId,
          evidenceBundlePath: bundlePath,
          evidenceSamples: bundle.samples.length,
          scenarioCounts: countBy(
            bundle.samples.map(
              (sample) => sample.scenario ?? 'organic-read-only',
            ),
          ),
          sshProtocol: executor.getDiagnostics(),
          workloads: workloadResults,
          results: evidence.map(toContentFreeResult),
          audit: {
            eventCount: auditEvents.length,
            eventTypes: countBy(auditEvents.map((event) => event.type)),
          },
          privacy: {
            commandTextPersisted: false,
            outputPersisted: false,
            workspacePathsPersisted: false,
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await executor?.dispose().catch(() => undefined);
    await execFileAsync('git', [
      '-C',
      repositoryRoot,
      'worktree',
      'remove',
      '--force',
      localWorktree,
    ]).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function resolveDogfoodRevision(repositoryRoot: string): Promise<string> {
  const configured = process.env.CLODEX_RUNNER_DOGFOOD_REVISION?.trim();
  const revision = configured
    ? configured.toLowerCase()
    : (
        await execFileAsync(
          'git',
          ['-C', repositoryRoot, 'rev-parse', 'HEAD'],
          {
            encoding: 'utf8',
          },
        )
      ).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision)) {
    throw new Error('CLODEX_RUNNER_DOGFOOD_REVISION must be a commit hash');
  }
  await execFileAsync(
    'git',
    ['-C', repositoryRoot, 'cat-file', '-e', `${revision}^{commit}`],
    { encoding: 'utf8' },
  );
  return revision;
}

async function executeLocalDogfoodBaseline(input: {
  command: string;
  cwd: string;
  snapshotHash: string;
  environmentFingerprintHash: string;
  guardian: P256RunnerSigningAuthority;
  runner: P256RunnerSigningAuthority;
  timeoutMs?: number;
  preDispatchDelayMs?: number;
  environmentFault?: 'invalid-git-dir';
}) {
  const request = { command: input.command, cwd: input.cwd };
  const signedJob = createSignedRunnerJob({
    providerId: 'local-runner:dogfood',
    leaseId: randomUUID(),
    snapshotHash: input.snapshotHash,
    operation: 'execute-command',
    payloadHash: hashRunnerPayload('execute-command', request),
    environmentFingerprintHash: input.environmentFingerprintHash,
    authority: input.guardian,
  });
  const startedAt = Date.now();
  if (input.preDispatchDelayMs) {
    await new Promise((resolve) =>
      setTimeout(resolve, input.preDispatchDelayMs),
    );
  }
  const result = await runLocalCommand({
    command: input.command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? 60_000,
    environmentFault: input.environmentFault,
  });
  const finishedAt = Date.now();
  const receipt = createSignedExecutionReceipt({
    signedJob,
    authority: input.runner,
    startedAt,
    finishedAt,
    outcome: result.exitCode === 0 && !result.timedOut ? 'completed' : 'failed',
    exitCode: result.exitCode,
    resolvedBy: result.timedOut ? 'timeout' : 'exit',
    output: `${result.stdout}\n${result.stderr}`,
    terminalState: result.timedOut
      ? 'timed-out'
      : result.exitCode === 0
        ? 'completed'
        : 'failed',
  });
  return {
    providerId: signedJob.job.providerId,
    providerKind: 'local' as const,
    environmentFingerprintHash: input.environmentFingerprintHash,
    outcome: receipt.receipt.outcome,
    durationMs: Math.max(0, finishedAt - startedAt),
    timedOut: result.timedOut,
    exitCodeClass:
      result.exitCode === null
        ? ('missing' as const)
        : result.exitCode === 0
          ? ('zero' as const)
          : ('non-zero' as const),
    receiptHash: hashExecutionReceipt(receipt.receipt),
    jobHash: hashRunnerJob(signedJob.job),
    outputHash: receipt.receipt.outputHash,
    artifactManifestHash: null,
  };
}

async function runLocalCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  environmentFault?: 'invalid-git-dir';
}): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-lc', input.command], {
      cwd: input.cwd,
      env:
        input.environmentFault === 'invalid-git-dir'
          ? {
              ...process.env,
              GIT_DIR: path.join(
                input.cwd,
                '.clodex-dogfood-missing-git-directory',
              ),
            }
          : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    const capture = (target: Buffer[], chunk: Buffer) => {
      capturedBytes += chunk.byteLength;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        child.kill('SIGKILL');
        reject(new Error('Local dogfood output exceeded capture limits'));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.once('error', reject);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      });
    });
  });
}

class DirectSshRunnerExecutor {
  private controlDirectory: string | null = null;
  private controlPath: string | null = null;
  private initialization: Promise<void> | null = null;
  private controlMasterInitializations = 0;
  private runnerCommandCount = 0;

  public constructor(
    private readonly target: string,
    private readonly remotePath: string,
  ) {}

  public async ensureRunnerControlSession(
    _connectionId: string,
  ): Promise<void> {
    if (this.controlPath) return;
    if (this.initialization) return await this.initialization;
    this.initialization = (async () => {
      const controlDirectory = await mkdtemp(
        path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cldx-'),
      );
      await chmod(controlDirectory, 0o700);
      const controlPath = path.join(controlDirectory, 'c');
      try {
        await execFileAsync(
          'ssh',
          [
            '-M',
            '-N',
            '-f',
            '-S',
            controlPath,
            '-o',
            'ControlMaster=yes',
            '-o',
            'ControlPersist=no',
            '-o',
            'BatchMode=yes',
            '-o',
            'StrictHostKeyChecking=yes',
            this.target,
          ],
          { timeout: 30_000 },
        );
        this.controlDirectory = controlDirectory;
        this.controlPath = controlPath;
        this.controlMasterInitializations += 1;
      } catch (error) {
        await rm(controlDirectory, { recursive: true, force: true });
        throw error;
      }
    })();
    try {
      await this.initialization;
    } finally {
      this.initialization = null;
    }
  }

  public async executeRunnerCommand(input: {
    connectionId: string;
    command: string;
    timeoutMs: number;
    stdin?: Uint8Array;
    requirePersistentSession?: boolean;
  }) {
    if (input.requirePersistentSession) {
      await this.ensureRunnerControlSession(input.connectionId);
    }
    this.runnerCommandCount += 1;
    const startedAt = Date.now();
    const result = await runSsh({
      target: this.target,
      command: `cd -- ${shellQuote(this.remotePath)} && (${input.command})`,
      timeoutMs: input.timeoutMs,
      stdin: input.stdin,
      controlPath: this.controlPath,
    });
    return {
      ok: true as const,
      connectionId: input.connectionId,
      connectionName: this.target,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
    };
  }

  public async dispose(): Promise<void> {
    const controlPath = this.controlPath;
    const controlDirectory = this.controlDirectory;
    this.controlPath = null;
    this.controlDirectory = null;
    if (controlPath) {
      await execFileAsync(
        'ssh',
        ['-S', controlPath, '-O', 'exit', this.target],
        { timeout: 5_000 },
      ).catch(() => undefined);
    }
    if (controlDirectory) {
      await rm(controlDirectory, { recursive: true, force: true });
    }
  }

  public getDiagnostics(): {
    multiplexed: true;
    controlMasterInitializations: number;
    runnerCommandCount: number;
  } {
    return {
      multiplexed: true,
      controlMasterInitializations: this.controlMasterInitializations,
      runnerCommandCount: this.runnerCommandCount,
    };
  }
}

async function createDirtyDogfoodState(worktree: string): Promise<void> {
  const candidates = ['README.md', 'package.json', '.gitignore'];
  let trackedPath: string | null = null;
  for (const candidate of candidates) {
    const content = await readFile(path.join(worktree, candidate)).catch(
      () => null,
    );
    if (!content) continue;
    await writeFile(
      path.join(worktree, candidate),
      Buffer.concat([
        content,
        Buffer.from('\n<!-- clodex SSH dogfood dirty patch -->\n'),
      ]),
    );
    trackedPath = candidate;
    break;
  }
  if (!trackedPath) {
    throw new Error('SSH dogfood could not find a tracked fixture file');
  }
  await writeFile(
    path.join(worktree, 'clodex-ssh-dogfood-untracked.txt'),
    'verified dirty materialization\n',
    { mode: 0o640 },
  );
  const cargoFixture = path.join(worktree, '.clodex-dogfood', 'cargo');
  await mkdir(path.join(cargoFixture, 'src'), { recursive: true });
  await writeFile(
    path.join(cargoFixture, 'Cargo.toml'),
    '[package]\nname = "clodex-dogfood"\nversion = "0.1.0"\nedition = "2021"\n',
  );
  const nodeFixture = path.join(worktree, '.clodex-dogfood', 'node');
  await mkdir(path.join(nodeFixture, 'src'), { recursive: true });
  await writeFile(
    path.join(nodeFixture, 'tsconfig.json'),
    `${JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: [],
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    })}\n`,
  );
  await writeFile(
    path.join(nodeFixture, 'src', 'workload.ts'),
    Array.from(
      { length: 20_000 },
      (_, index) => `export const value${index}: number = ${index};`,
    ).join('\n'),
  );
  await writeFile(
    path.join(cargoFixture, 'src', 'lib.rs'),
    'pub fn answer() -> u32 { 42 }\n#[cfg(test)] mod tests { #[test] fn works() { assert_eq!(super::answer(), 42); } }\n',
  );
  const goFixture = path.join(worktree, '.clodex-dogfood', 'go');
  await mkdir(goFixture, { recursive: true });
  await writeFile(
    path.join(goFixture, 'go.mod'),
    'module clodex.local/dogfood\n\ngo 1.18\n',
  );
  await writeFile(
    path.join(goFixture, 'dogfood_test.go'),
    'package dogfood\n\nimport "testing"\n\nfunc TestAnswer(t *testing.T) { if 6*7 != 42 { t.Fatal("math") } }\n',
  );
}

async function runSsh(input: {
  target: string;
  command: string;
  timeoutMs: number;
  stdin?: Uint8Array;
  controlPath?: string | null;
}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      'ssh',
      [
        ...(input.controlPath
          ? ['-S', input.controlPath, '-o', 'ControlMaster=no']
          : []),
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        input.target,
        input.command,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    const capture = (target: Buffer[], chunk: Buffer) => {
      capturedBytes += chunk.byteLength;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        child.kill('SIGKILL');
        reject(new Error('SSH dogfood output exceeded capture limits'));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.once('error', reject);
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('SSH dogfood command timed out'));
    }, input.timeoutMs + 5_000);
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(input.stdin ? Buffer.from(input.stdin) : undefined);
  });
}

function toContentFreeResult(evidence: RunnerExecutionEvidence) {
  return {
    providerId: evidence.providerId,
    providerKind: evidence.providerKind,
    outcome: evidence.outcome,
    exitCode: evidence.exitCode,
    terminalState: evidence.terminalState,
    receiptHash: evidence.receiptHash,
    jobHash: evidence.jobHash,
    outputHash: evidence.outputHash,
    artifactManifestHash: evidence.artifactManifestHash,
    environmentFingerprintHash: evidence.environmentFingerprintHash,
    replayPreparationDurationMs: evidence.replayPreparationDurationMs,
    replayTotalDurationMs: evidence.replayTotalDurationMs,
    workspaceCacheStatus: evidence.workspaceCacheStatus,
    workspaceReuseCount: evidence.workspaceReuseCount,
    workspaceTransferBytes: evidence.workspaceTransferBytes,
    workspaceTransferBytesAvoided: evidence.workspaceTransferBytesAvoided,
    workspacePreparationHash: evidence.workspacePreparationHash,
    executionTimingHash: evidence.executionTimingHash,
    executionTimings: evidence.executionTimings,
  };
}

function toDogfoodExecution(evidence: RunnerExecutionEvidence) {
  return {
    providerId: evidence.providerId,
    providerKind: evidence.providerKind as 'ssh',
    environmentFingerprintHash: evidence.environmentFingerprintHash,
    outcome: evidence.outcome,
    durationMs: Math.max(0, evidence.finishedAt - evidence.startedAt),
    timedOut:
      evidence.terminalState === 'timed-out' ||
      evidence.resolvedBy === 'timeout',
    exitCodeClass:
      evidence.exitCode === null
        ? ('missing' as const)
        : evidence.exitCode === 0
          ? ('zero' as const)
          : ('non-zero' as const),
    receiptHash: evidence.receiptHash,
    jobHash: evidence.jobHash,
    outputHash: evidence.outputHash,
    artifactManifestHash: evidence.artifactManifestHash,
    executionTimingHash: evidence.executionTimingHash,
    executionTimings: evidence.executionTimings,
    preparationDurationMs: evidence.replayPreparationDurationMs,
    totalDurationMs: evidence.replayTotalDurationMs,
    workspaceCacheStatus: evidence.workspaceCacheStatus,
    workspaceReuseCount: evidence.workspaceReuseCount,
    transferBytes: evidence.workspaceTransferBytes,
    transferBytesAvoided: evidence.workspaceTransferBytesAvoided,
  };
}

async function loadOrCreateCollectorIdentity(identityPath: string): Promise<{
  privateKeyPem: string;
  publicKey: string;
}> {
  try {
    const stats = await stat(identityPath);
    if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
      throw new Error(
        'Dogfood collector identity must not be group/world readable',
      );
    }
    const parsed = JSON.parse(await readFile(identityPath, 'utf8')) as {
      version?: unknown;
      privateKeyPem?: unknown;
      publicKey?: unknown;
    };
    if (
      parsed.version !== 1 ||
      typeof parsed.privateKeyPem !== 'string' ||
      typeof parsed.publicKey !== 'string'
    ) {
      throw new Error('Dogfood collector identity is malformed');
    }
    new P256RunnerSigningAuthority({
      privateKeyPem: parsed.privateKeyPem,
      publicKey: parsed.publicKey,
    });
    return {
      privateKeyPem: parsed.privateKeyPem,
      publicKey: parsed.publicKey,
    };
  } catch (error) {
    if (
      !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
    ) {
      throw error;
    }
  }
  const generated = P256RunnerSigningAuthority.generate();
  await mkdir(path.dirname(identityPath), { recursive: true, mode: 0o700 });
  await writeFile(
    identityPath,
    `${JSON.stringify(
      {
        version: 1,
        privateKeyPem: generated.privateKeyPem,
        publicKey: generated.publicKey,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  await chmod(identityPath, 0o600);
  return {
    privateKeyPem: generated.privateKeyPem,
    publicKey: generated.publicKey,
  };
}

async function writeEvidenceBundle(
  bundle: ReturnType<typeof signRunnerDogfoodEvidenceBundle>,
): Promise<string> {
  const inbox =
    process.env.CLODEX_RUNNER_DOGFOOD_EVIDENCE_INBOX?.trim() ||
    path.join(os.homedir(), '.clodex', 'dogfood', 'evidence-inbox');
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  const bundlePath = path.join(inbox, `${bundle.bundleId}.json`);
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  return bundlePath;
}

function createDogfoodWorkloads(
  scenarios: readonly RunnerDogfoodEvidenceScenario[],
  repetitions: number,
): Array<{
  label: string;
  command: string;
  scenario: RunnerDogfoodEvidenceScenario;
  localTimeoutMs?: number;
  localPreDispatchDelayMs?: number;
  localEnvironmentFault?: 'invalid-git-dir';
  cwdRelative?: string;
  remoteTimeoutMs?: number;
}> {
  const workloads = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    if (scenarios.includes('organic-read-only')) {
      for (const workload of ORGANIC_WORKLOADS) {
        workloads.push({
          ...workload,
          label: `${workload.label}:${repetition}`,
          scenario: 'organic-read-only' as const,
        });
      }
    }
    if (scenarios.includes('organic-heavyweight')) {
      const enabledProfiles = readHeavyweightProfiles();
      for (const workload of [
        {
          profile: 'node',
          label: 'node-typecheck',
          command:
            'node_modules/.bin/tsc -p .clodex-dogfood/node/tsconfig.json --noEmit',
          cwdRelative: '',
          remoteTimeoutMs: 5 * 60_000,
        },
        {
          profile: 'cargo',
          label: 'cargo-test',
          command: 'cargo test',
          cwdRelative: '.clodex-dogfood/cargo',
          remoteTimeoutMs: 5 * 60_000,
        },
        {
          profile: 'go',
          label: 'go-test',
          command: 'go test ./...',
          cwdRelative: '.clodex-dogfood/go',
          remoteTimeoutMs: 5 * 60_000,
        },
      ] as const) {
        if (!enabledProfiles.has(workload.profile)) continue;
        workloads.push({
          ...workload,
          label: `${workload.label}:${repetition}`,
          scenario: 'organic-heavyweight' as const,
        });
      }
    }
    if (scenarios.includes('controlled-local-timeout')) {
      workloads.push({
        label: `git-status-timeout:${repetition}`,
        command: 'git status --short',
        scenario: 'controlled-local-timeout',
        localTimeoutMs: readBoundedIntegerEnvironment(
          'CLODEX_RUNNER_DOGFOOD_CONTROLLED_TIMEOUT_MS',
          1,
          1,
          1_000,
        ),
      });
    }
    if (scenarios.includes('controlled-local-failure')) {
      workloads.push({
        label: `git-status-environment-failure:${repetition}`,
        command: 'git status --short',
        scenario: 'controlled-local-failure',
        localEnvironmentFault: 'invalid-git-dir',
      });
    }
    if (scenarios.includes('controlled-local-latency')) {
      workloads.push({
        label: `git-status-latency:${repetition}`,
        command: 'git status --short',
        scenario: 'controlled-local-latency',
        localPreDispatchDelayMs: readBoundedIntegerEnvironment(
          'CLODEX_RUNNER_DOGFOOD_CONTROLLED_LATENCY_MS',
          25_000,
          1,
          60_000,
        ),
      });
    }
  }
  if (workloads.length === 0 || workloads.length > 128) {
    throw new Error('SSH dogfood workload count must be between 1 and 128');
  }
  return workloads;
}

function readHeavyweightProfiles(): Set<'node' | 'cargo' | 'go'> {
  const values = (
    process.env.CLODEX_RUNNER_DOGFOOD_HEAVYWEIGHT_PROFILES?.trim() ||
    'node,cargo,go'
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    values.length === 0 ||
    values.some((value) => !['node', 'cargo', 'go'].includes(value))
  ) {
    throw new Error(
      'CLODEX_RUNNER_DOGFOOD_HEAVYWEIGHT_PROFILES must contain only node,cargo,go',
    );
  }
  return new Set(values as Array<'node' | 'cargo' | 'go'>);
}

function readDogfoodScenarios(): RunnerDogfoodEvidenceScenario[] {
  const configured =
    process.env.CLODEX_RUNNER_DOGFOOD_SCENARIOS?.trim() || 'organic-read-only';
  const scenarios = configured
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    scenarios.length === 0 ||
    scenarios.some(
      (scenario) =>
        !runnerDogfoodEvidenceScenarios.includes(
          scenario as RunnerDogfoodEvidenceScenario,
        ),
    )
  ) {
    throw new Error(
      `CLODEX_RUNNER_DOGFOOD_SCENARIOS must contain only: ${runnerDogfoodEvidenceScenarios.join(', ')}`,
    );
  }
  return [...new Set(scenarios)] as RunnerDogfoodEvidenceScenario[];
}

function readBoundedIntegerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

await main();
