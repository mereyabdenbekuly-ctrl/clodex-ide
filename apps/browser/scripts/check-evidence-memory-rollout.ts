import { createPublicKey } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateEvidenceMemoryPromotionReadiness,
  isEvidenceMemoryRolloutPolicyArmed,
  parseEvidenceMemoryPromotionEvidence,
  type EvidenceMemoryPromotionArtifactSummary,
  type EvidenceMemoryPromotionEvidence,
  type EvidenceMemoryPromotionSourceBinding,
} from '../src/shared/evidence-memory-promotion';
import {
  getEvidenceMemoryRolloutPolicy,
  type EvidenceMemoryRolloutPolicy,
} from '../src/shared/evidence-memory-rollout';
import type { AppReleaseChannel } from '../src/shared/feature-gates';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const defaultEvidencePath = path.join(
  repositoryRoot,
  '.release-evidence',
  'evidence-memory.json',
);
const defaultQualityPath = path.join(
  repositoryRoot,
  '.release-evidence',
  'evidence-memory-quality.json',
);
const defaultTracePath = path.join(
  repositoryRoot,
  '.release-evidence',
  'evidence-memory-trace-replay.json',
);

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
  } else {
    runCheck(options);
  }
} catch (error) {
  console.error(
    'EVIDENCE_MEMORY_ROLLOUT ready=false exit=1',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}

function runCheck(options: CheckOptions): void {
  const channel =
    options.channel ??
    parseChannel(process.env.EVIDENCE_MEMORY_RELEASE_CHANNEL) ??
    'release';
  const policy = getEvidenceMemoryRolloutPolicy(channel);
  const evidencePath = path.resolve(
    options.evidencePath ?? defaultEvidencePath,
  );
  if (!isEvidenceMemoryRolloutPolicyArmed(policy) && !options.requireEvidence) {
    printInactivePolicy(options, channel, policy, evidencePath);
    return;
  }
  if (!fs.existsSync(evidencePath)) {
    throw new Error(
      `${channel} ${policy.stage} requires promotion evidence at ${evidencePath}`,
    );
  }

  const publicKeyPem = options.publicKeyPath
    ? fs.readFileSync(path.resolve(options.publicKeyPath), 'utf8')
    : process.env.CLODEX_EVIDENCE_MEMORY_PROMOTION_PUBLIC_KEY;
  if (!publicKeyPem) {
    throw new Error(
      'promotion evidence exists but no Ed25519 public key was provided',
    );
  }
  const evidence = parseEvidenceMemoryPromotionEvidence(
    JSON.parse(fs.readFileSync(evidencePath, 'utf8')),
  );
  const sourceBinding = inspectSourceBinding(
    evidence,
    resolveBuildCommitSha(options),
  );
  const quality = readArtifact(
    path.resolve(options.qualityPath ?? defaultQualityPath),
    'quality',
  );
  const traceReplay = readArtifact(
    path.resolve(options.tracePath ?? defaultTracePath),
    'trace',
  );
  const readiness = evaluateEvidenceMemoryPromotionReadiness(evidence, {
    publicKey: createPublicKey(publicKeyPem),
    sourceBinding,
    currentPolicy: policy,
    quality,
    traceReplay,
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...readiness,
          channel,
          stage: policy.stage,
          allocationPercent: policy.allocationPercent,
          evidencePath,
          deliveryMode: evidence.delivery.mode,
          sourceCommitSha: evidence.sourceCommitSha,
          buildCommitSha: sourceBinding.buildCommitSha,
          changedPaths: sourceBinding.changedPaths,
        },
        null,
        2,
      ),
    );
  } else {
    for (const check of readiness.checks) {
      console.log(
        `${check.passed ? 'PASS' : 'FAIL'} ${check.id} actual=${formatValue(check.actual)} required=${formatValue(check.required)}`,
      );
    }
    console.log(
      `EVIDENCE_MEMORY_ROLLOUT ready=${readiness.ready} channel=${channel} stage=${policy.stage} allocation=${policy.allocationPercent} evidence=${evidencePath} exit=${readiness.ready ? 0 : 1}`,
    );
  }
  if (!readiness.ready) process.exitCode = 1;
}

type CheckOptions = {
  channel?: AppReleaseChannel;
  evidencePath?: string;
  qualityPath?: string;
  tracePath?: string;
  publicKeyPath?: string;
  buildCommitSha?: string;
  requireEvidence: boolean;
  json: boolean;
  help: boolean;
};

function parseArguments(args: string[]): CheckOptions {
  const options: CheckOptions = {
    requireEvidence: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--':
        break;
      case '--channel':
        options.channel = requiredChannel(
          readArgument(args, ++index, '--channel'),
        );
        break;
      case '--evidence':
        options.evidencePath = readArgument(args, ++index, '--evidence');
        break;
      case '--quality':
        options.qualityPath = readArgument(args, ++index, '--quality');
        break;
      case '--trace':
        options.tracePath = readArgument(args, ++index, '--trace');
        break;
      case '--public-key':
        options.publicKeyPath = readArgument(args, ++index, '--public-key');
        break;
      case '--build-commit':
      case '--commit':
        options.buildCommitSha = readArgument(args, ++index, argument);
        break;
      case '--require-evidence':
        options.requireEvidence = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument ${argument}`);
    }
  }
  return options;
}

function readArtifact(
  filePath: string,
  kind: 'quality' | 'trace',
): EvidenceMemoryPromotionArtifactSummary {
  const bytes = fs.readFileSync(filePath);
  const value = readRecord(JSON.parse(bytes.toString('utf8')), kind);
  const report = readRecord(value.report, `${kind}.report`);
  return {
    bytes,
    generatedAt: requiredString(value.generatedAt, `${kind}.generatedAt`),
    policyHash: requiredHash(report.policyHash, `${kind}.policyHash`),
    promotionReady: report.promotionReady === true,
    source:
      kind === 'trace'
        ? requiredString(value.source, 'trace.source')
        : undefined,
    traceSetHash:
      kind === 'trace'
        ? requiredHash(report.traceSetHash, 'trace.traceSetHash')
        : undefined,
  };
}

function resolveBuildCommitSha(options: CheckOptions): string {
  const explicit =
    options.buildCommitSha ?? process.env.CLODEX_BUILD_COMMIT_SHA;
  const commitSha =
    explicit ?? tryGitOutput(['rev-parse', 'HEAD']) ?? process.env.GITHUB_SHA;
  if (!commitSha || !/^[a-f0-9]{40,64}$/u.test(commitSha)) {
    throw new Error(
      'promotion evidence exists but no valid build commit SHA could be resolved',
    );
  }
  return commitSha;
}

function inspectSourceBinding(
  evidence: EvidenceMemoryPromotionEvidence,
  buildCommitSha: string,
): EvidenceMemoryPromotionSourceBinding {
  assertGitCommitAvailable(evidence.sourceCommitSha, 'source');
  assertGitCommitAvailable(buildCommitSha, 'build');
  if (evidence.delivery.mode === 'external-ci-artifact') {
    return {
      buildCommitSha,
      sourceCommitIsAncestor: evidence.sourceCommitSha === buildCommitSha,
      changedPaths: [],
    };
  }

  const ancestorResult = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', evidence.sourceCommitSha, buildCommitSha],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
    },
  );
  if (ancestorResult.status !== 0 && ancestorResult.status !== 1) {
    throw new Error(
      `unable to inspect Evidence Memory source ancestry: ${ancestorResult.stderr.trim() || 'git merge-base failed'}`,
    );
  }
  const sourceCommitIsAncestor = ancestorResult.status === 0;
  const changedPaths = sourceCommitIsAncestor
    ? gitOutput([
        'diff',
        '--no-renames',
        '--name-only',
        '-z',
        evidence.sourceCommitSha,
        buildCommitSha,
        '--',
      ])
        .split('\0')
        .filter(Boolean)
    : [];
  return {
    buildCommitSha,
    sourceCommitIsAncestor,
    changedPaths,
  };
}

function assertGitCommitAvailable(commitSha: string, label: string): void {
  const result = spawnSync('git', ['cat-file', '-e', `${commitSha}^{commit}`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} commit ${commitSha} is unavailable; fetch full history before checking repository evidence`,
    );
  }
}

function tryGitOutput(args: string[]): string | undefined {
  try {
    return gitOutput(args).trim() || undefined;
  } catch {
    return undefined;
  }
}

function gitOutput(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function printInactivePolicy(
  options: CheckOptions,
  channel: AppReleaseChannel,
  policy: EvidenceMemoryRolloutPolicy,
  evidencePath: string,
): void {
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ready: false,
          evidenceRequired: false,
          channel,
          stage: policy.stage,
          allocationPercent: policy.allocationPercent,
          evidencePath,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `EVIDENCE_MEMORY_ROLLOUT ready=false channel=${channel} stage=${policy.stage} allocation=0 evidence=not-required exit=0`,
    );
  }
}

function parseChannel(
  value: string | undefined,
): AppReleaseChannel | undefined {
  if (!value) return undefined;
  return requiredChannel(value);
}

function requiredChannel(value: string): AppReleaseChannel {
  if (
    value !== 'dev' &&
    value !== 'prerelease' &&
    value !== 'nightly' &&
    value !== 'release'
  ) {
    throw new Error('channel must be dev, prerelease, nightly, or release');
  }
  return value;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredHash(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) {
    throw new Error(`${label} must be a SHA-256 hash`);
  }
  return result;
}

function readArgument(args: string[], index: number, argument: string): string {
  const value = args[index];
  if (!value) throw new Error(`${argument} requires a value`);
  return value;
}

function formatValue(value: string | number | boolean): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(6);
  }
  return JSON.stringify(value);
}

function printUsage(): void {
  console.log(`Usage:
  pnpm check:evidence-memory-rollout
  pnpm check:evidence-memory-rollout -- --channel prerelease
  pnpm check:evidence-memory-rollout -- \\
    --require-evidence \\
    --evidence <evidence.json> \\
    --quality <quality.json> \\
    --trace <trace.json> \\
    --public-key <ed25519-public-key.pem> \\
    --build-commit <git-sha>

Missing evidence passes only while the selected channel remains shadow/hold,
unless --require-evidence is supplied for pre-promotion verification. An armed
canary always fails closed unless signed, fresh, commit-bound evidence links the
exact quality and external trace replay artifacts. Repository-delivered evidence
must descend from the signed source commit and may change only the three
generated .release-evidence files.`);
}
