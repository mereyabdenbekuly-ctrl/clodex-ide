import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createWorkspaceSnapshot } from '@clodex/agent-core/agents';
import { resolveRunnerPairedReplayProfile } from '@clodex/agent-core/runner-routing';
import {
  DockerRunnerAdapter,
  P256RunnerSigningAuthority,
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
import { buildLocalWorkspaceSnapshotMetadata } from '../src/backend/agent-host/workspace-snapshot-builder';
import {
  DockerCliRunnerTransport,
  readDockerRunnerConfig,
} from '../src/backend/services/docker-runner/docker-runner-transport';
import {
  signRunnerDogfoodEvidenceBundle,
  verifyRunnerDogfoodEvidenceBundle,
  type RunnerDogfoodEvidenceSample,
} from '../src/backend/services/runner-routing/dogfood-evidence';

const execFileAsync = promisify(execFile);
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const WORKLOADS = [
  { label: 'git-status', command: 'git status --short' },
  { label: 'git-diff-stat', command: 'git diff --stat' },
  { label: 'git-log', command: 'git log -n 20 --oneline' },
  { label: 'git-revision', command: 'git rev-parse HEAD' },
] as const;

async function main(): Promise<void> {
  const dockerConfig = readDockerRunnerConfig();
  if (!dockerConfig) {
    throw new Error(
      'CLODEX_DOCKER_RUNNER_IMAGE must contain a digest-pinned Docker image',
    );
  }
  const collectorIdentityPath = requiredEnvironment(
    'CLODEX_RUNNER_DOGFOOD_COLLECTOR_IDENTITY_PATH',
  );
  const evidenceInbox = requiredEnvironment(
    'CLODEX_RUNNER_DOGFOOD_EVIDENCE_INBOX',
  );
  const repositoryRoot = (
    await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    })
  ).stdout.trim();
  const revision = await resolveDogfoodRevision(repositoryRoot);
  const collectorIdentity = await readCollectorIdentity(collectorIdentityPath);
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), 'clodex-docker-dogfood-'),
  );
  const localWorktree = path.join(temporaryRoot, 'workspace');
  const auditEvents: RunnerSecurityAuditEvent[] = [];
  let provider: DockerRunnerAdapter | null = null;

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
      throw new Error(
        'Docker dogfood snapshot did not produce materialization',
      );
    }

    const guardian = new P256RunnerSigningAuthority(collectorIdentity);
    const runner = P256RunnerSigningAuthority.generate().authority;
    const localRunner = P256RunnerSigningAuthority.generate().authority;
    const transport = new DockerCliRunnerTransport(dockerConfig);
    provider = new DockerRunnerAdapter(
      `docker-runner:dogfood:${dockerConfig.image.split('@sha256:')[1]!.slice(0, 16)}`,
      transport,
      {
        receiptAuthority: runner,
        trustedGuardianPublicKey: guardian.publicKey,
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

    const samples: RunnerDogfoodEvidenceSample[] = [];
    const results: Array<Record<string, string | number | boolean | null>> = [];
    const repetitions = readRepetitions();
    let sequence = 0;
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      for (const workload of WORKLOADS) {
        sequence += 1;
        const request = { command: workload.command, cwd: localWorktree };
        const actual = await executeLocalDogfoodBaseline({
          command: workload.command,
          cwd: localWorktree,
          snapshotHash: snapshot.snapshotHash,
          environmentFingerprintHash: snapshot.environment.fingerprintHash,
          guardian,
          runner: localRunner,
        });
        const replay = await executeDisposableRunnerReplay({
          provider,
          snapshotIdentity,
          authority: guardian,
          command: request,
          agentInstanceId: 'runner-docker-dogfood',
          decisionId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
          timeoutMs: 120_000,
        });
        const replayExecution = toDogfoodExecution(replay);
        const profile = resolveRunnerPairedReplayProfile({
          targetProviderKind: 'docker',
          dependencyIsolationProfile:
            classifyRunnerReplayIsolationProfile(request),
        });
        if (profile !== 'docker-isolated') {
          throw new Error(
            'Docker dogfood profile did not resolve to docker-isolated',
          );
        }
        samples.push({
          sampleId: randomUUID(),
          profile,
          scenario: 'organic-read-only',
          promotionEligible: true,
          commandClassHash:
            classifyRunnerCommandForRouting(request).commandClassHash,
          snapshotHash: snapshot.snapshotHash,
          actual,
          replay: replayExecution,
        });
        results.push({
          label: `${workload.label}:${repetition}`,
          profile,
          actualOutcome: actual.outcome,
          actualDurationMs: actual.durationMs,
          replayOutcome: replayExecution.outcome,
          replayDurationMs: replayExecution.durationMs,
          replayPreparationDurationMs:
            replayExecution.preparationDurationMs ?? null,
          replayTotalDurationMs: replayExecution.totalDurationMs ?? null,
        });
      }
    }

    if (samples.length < 4) {
      throw new Error('Docker dogfood must produce at least four samples');
    }
    if (new Set(samples.map((sample) => sample.commandClassHash)).size < 2) {
      throw new Error('Docker dogfood must cover at least two command classes');
    }
    if (
      samples.some(
        (sample) =>
          sample.replay.providerKind !== 'docker' ||
          sample.replay.outcome !== 'completed' ||
          sample.replay.timedOut ||
          sample.replay.exitCodeClass !== 'zero',
      )
    ) {
      throw new Error('Docker dogfood contains a failed physical replay');
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
    verifyRunnerDogfoodEvidenceBundle(bundle, [collectorIdentity.publicKey]);
    const bundlePath = await writeEvidenceBundle(bundle, evidenceInbox);
    const dockerVersion = await readDockerServerVersion();

    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          checkedAt: Date.now(),
          sourceCommitSha: revision,
          image: dockerConfig.image,
          dockerServerVersion: dockerVersion,
          snapshotHash: snapshot.snapshotHash,
          dirtyPatchHash: mount.dirtyPatchHash,
          dependencyFingerprintHash: mount.dependencyFingerprintHash,
          hasDirtyChanges: mount.hasDirtyChanges,
          collectorKeyId: guardian.keyId,
          collectorPublicKey: guardian.publicKey,
          evidenceBundleId: bundle.bundleId,
          evidenceBundleFile: path.basename(bundlePath),
          evidenceSamples: bundle.samples.length,
          distinctCommandClasses: new Set(
            bundle.samples.map((sample) => sample.commandClassHash),
          ).size,
          workloads: results,
          audit: {
            eventCount: auditEvents.length,
            eventTypes: countBy(auditEvents.map((event) => event.type)),
          },
          isolation: {
            network: 'none',
            readOnlyRootFilesystem: true,
            nonRootUser: '65532:65532',
            capabilityDrop: 'ALL',
            noNewPrivileges: true,
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
    await provider?.dispose().catch(() => undefined);
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
          { encoding: 'utf8' },
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

async function createDirtyDogfoodState(worktree: string): Promise<void> {
  const candidates = ['README.md', '.gitignore'];
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
        Buffer.from('\n<!-- clodex Docker dogfood dirty patch -->\n'),
      ]),
    );
    trackedPath = candidate;
    break;
  }
  if (!trackedPath) {
    throw new Error('Docker dogfood could not find a tracked fixture file');
  }
  await writeFile(
    path.join(worktree, 'clodex-docker-dogfood-untracked.txt'),
    'verified dirty materialization\n',
    { mode: 0o640 },
  );
}

async function executeLocalDogfoodBaseline(input: {
  command: string;
  cwd: string;
  snapshotHash: string;
  environmentFingerprintHash: string;
  guardian: P256RunnerSigningAuthority;
  runner: ReturnType<typeof P256RunnerSigningAuthority.generate>['authority'];
}) {
  const request = { command: input.command, cwd: input.cwd };
  const signedJob = createSignedRunnerJob({
    providerId: 'local-runner:docker-dogfood-baseline',
    leaseId: randomUUID(),
    snapshotHash: input.snapshotHash,
    operation: 'execute-command',
    payloadHash: hashRunnerPayload('execute-command', request),
    environmentFingerprintHash: input.environmentFingerprintHash,
    authority: input.guardian,
  });
  const startedAt = Date.now();
  const result = await runLocalCommand(input.command, input.cwd, 60_000);
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

async function runLocalCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-lc', command], {
      cwd,
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
        reject(new Error('Docker dogfood baseline exceeded capture limits'));
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
    }, timeoutMs);
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

function toDogfoodExecution(evidence: RunnerExecutionEvidence) {
  return {
    providerId: evidence.providerId,
    providerKind: evidence.providerKind as 'docker',
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

async function readCollectorIdentity(identityPath: string): Promise<{
  privateKeyPem: string;
  publicKey: string;
}> {
  const stats = await lstat(identityPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Docker dogfood collector identity must be a regular file');
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(
      'Docker dogfood collector identity must not be group/world readable',
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
    throw new Error('Docker dogfood collector identity is malformed');
  }
  new P256RunnerSigningAuthority({
    privateKeyPem: parsed.privateKeyPem,
    publicKey: parsed.publicKey,
  });
  return {
    privateKeyPem: parsed.privateKeyPem,
    publicKey: parsed.publicKey,
  };
}

async function writeEvidenceBundle(
  bundle: ReturnType<typeof signRunnerDogfoodEvidenceBundle>,
  inbox: string,
): Promise<string> {
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  await chmod(inbox, 0o700);
  const bundlePath = path.join(inbox, `${bundle.bundleId}.json`);
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  return bundlePath;
}

async function readDockerServerVersion(): Promise<string> {
  const result = await execFileAsync(
    'docker',
    ['version', '--format', '{{.Server.Version}}'],
    { encoding: 'utf8', timeout: 10_000 },
  );
  const version = result.stdout.trim();
  if (!/^[A-Za-z0-9._+-]{1,128}$/.test(version)) {
    throw new Error('Docker server returned an invalid version');
  }
  return version;
}

function readRepetitions(): number {
  const raw = process.env.CLODEX_RUNNER_DOGFOOD_REPETITIONS?.trim();
  if (!raw) return 1;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new Error('CLODEX_RUNNER_DOGFOOD_REPETITIONS must be 1-10');
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

await main();
