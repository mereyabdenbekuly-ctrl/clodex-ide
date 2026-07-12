import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEvidenceMemoryPromotionEvidence,
  EVIDENCE_MEMORY_REPOSITORY_EVIDENCE_PATHS,
  evaluateEvidenceMemoryPromotionReadiness,
  type EvidenceMemoryPromotionArtifactSummary,
  type EvidenceMemoryPromotionDeliveryMode,
} from '../src/shared/evidence-memory-promotion';
import { getEvidenceMemoryRolloutPolicy } from '../src/shared/evidence-memory-rollout';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const defaultQualityPath = path.resolve(
  scriptDirectory,
  '../test-results/evidence-memory-quality.json',
);
const defaultTracePath = path.resolve(
  scriptDirectory,
  '../test-results/evidence-memory-trace-replay.json',
);
const defaultOutputPath = path.join(
  repositoryRoot,
  '.release-evidence',
  'evidence-memory.json',
);

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
  } else {
    await collectEvidence(options);
  }
} catch (error) {
  console.error(
    'EVIDENCE_MEMORY_PROMOTION_EVIDENCE collected=false exit=1',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}

async function collectEvidence(options: CollectionOptions): Promise<void> {
  const qualityPath = path.resolve(options.qualityPath ?? defaultQualityPath);
  const tracePath = path.resolve(options.tracePath ?? defaultTracePath);
  const quality = await readQualityArtifact(qualityPath);
  const traceReplay = await readTraceArtifact(tracePath);
  if (!quality.summary.promotionReady || !traceReplay.summary.promotionReady) {
    throw new Error('linked quality and trace replay reports must be ready');
  }
  if (traceReplay.summary.source !== 'external-content-free-trace') {
    throw new Error(
      'promotion evidence requires an external content-free trace replay',
    );
  }

  const sourceCommitSha =
    options.sourceCommitSha ??
    process.env.CLODEX_EVIDENCE_MEMORY_SOURCE_COMMIT_SHA ??
    process.env.CLODEX_BUILD_COMMIT_SHA ??
    process.env.GITHUB_SHA;
  if (!sourceCommitSha || !/^[a-f0-9]{40,64}$/u.test(sourceCommitSha)) {
    throw new Error(
      '--source-commit must be a 40-64 character lowercase hex SHA',
    );
  }
  const privateKeyPem = options.privateKeyPath
    ? await fs.readFile(path.resolve(options.privateKeyPath), 'utf8')
    : process.env.CLODEX_EVIDENCE_MEMORY_PROMOTION_PRIVATE_KEY;
  if (!privateKeyPem) {
    throw new Error(
      'provide --private-key or CLODEX_EVIDENCE_MEMORY_PROMOTION_PRIVATE_KEY',
    );
  }
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) {
    throw new Error('--generated-at must be an ISO-8601 timestamp');
  }
  const expiresAt = new Date(
    generatedAtMs + options.validityHours * 3_600_000,
  ).toISOString();
  const privateKey = createPrivateKey(privateKeyPem);
  const evidence = createEvidenceMemoryPromotionEvidence({
    privateKey,
    keyId: options.keyId,
    body: {
      schemaVersion: 2,
      sourceChannel: 'prerelease',
      generatedAt,
      expiresAt,
      sourceCommitSha,
      delivery: {
        mode: options.deliveryMode,
      },
      targetStage: options.targetStage,
      qualityEvidence: {
        generatedAt: quality.summary.generatedAt,
        sha256: sha256(quality.bytes),
        policyHash: quality.summary.policyHash,
      },
      traceReplayEvidence: {
        generatedAt: traceReplay.summary.generatedAt,
        sha256: sha256(traceReplay.bytes),
        policyHash: traceReplay.summary.policyHash,
        traceSetHash: requiredString(
          traceReplay.summary.traceSetHash,
          'traceSetHash',
        ),
      },
    },
  });

  const publicKeyPem = options.publicKeyPath
    ? await fs.readFile(path.resolve(options.publicKeyPath), 'utf8')
    : process.env.CLODEX_EVIDENCE_MEMORY_PROMOTION_PUBLIC_KEY;
  const signingPublicKey = createPublicKey(privateKey);
  const verificationPublicKey = publicKeyPem
    ? createPublicKey(publicKeyPem)
    : signingPublicKey;
  if (publicKeyPem) {
    const trustedPublicKeyBytes = verificationPublicKey.export({
      type: 'spki',
      format: 'der',
    });
    const signingPublicKeyBytes = signingPublicKey.export({
      type: 'spki',
      format: 'der',
    });
    if (!trustedPublicKeyBytes.equals(signingPublicKeyBytes)) {
      throw new Error(
        'promotion private key does not match the configured trusted public key',
      );
    }
  }
  const readiness = evaluateEvidenceMemoryPromotionReadiness(evidence, {
    publicKey: verificationPublicKey,
    sourceBinding: createCollectionSourceBinding(
      options.deliveryMode,
      sourceCommitSha,
    ),
    currentPolicy: getEvidenceMemoryRolloutPolicy('prerelease'),
    quality: quality.summary,
    traceReplay: traceReplay.summary,
    now: new Date(generatedAt),
  });
  if (!readiness.ready) {
    throw new Error(
      `generated evidence failed self-verification: ${readiness.checks
        .filter((check) => !check.passed)
        .map((check) => check.id)
        .join(', ')}`,
    );
  }
  const outputPath = path.resolve(options.outputPath ?? defaultOutputPath);
  const qualityOutputPath = path.join(
    path.dirname(outputPath),
    'evidence-memory-quality.json',
  );
  const traceOutputPath = path.join(
    path.dirname(outputPath),
    'evidence-memory-trace-replay.json',
  );
  await Promise.all([
    writeJsonAtomically(outputPath, evidence),
    writeBytesAtomically(qualityOutputPath, quality.bytes),
    writeBytesAtomically(traceOutputPath, traceReplay.bytes),
  ]);
  console.log(
    [
      'EVIDENCE_MEMORY_PROMOTION_EVIDENCE',
      'collected=true',
      `output=${outputPath}`,
      `sourceCommit=${sourceCommitSha}`,
      `delivery=${options.deliveryMode}`,
      `target=${options.targetStage}`,
      `expires=${expiresAt}`,
      `quality=${qualityOutputPath}`,
      `trace=${traceOutputPath}`,
      'exit=0',
    ].join(' '),
  );
}

type CollectionOptions = {
  qualityPath?: string;
  tracePath?: string;
  outputPath?: string;
  privateKeyPath?: string;
  publicKeyPath?: string;
  sourceCommitSha?: string;
  generatedAt?: string;
  keyId: string;
  deliveryMode: EvidenceMemoryPromotionDeliveryMode;
  targetStage: 'canary-5' | 'canary-25' | 'canary-100';
  validityHours: number;
  help: boolean;
};

function parseArguments(args: string[]): CollectionOptions {
  const options: CollectionOptions = {
    keyId: 'evidence-memory-promotion-v2',
    deliveryMode: 'repository-evidence-commit',
    targetStage: 'canary-5',
    validityHours: 48,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--':
        break;
      case '--quality':
        options.qualityPath = readArgument(args, ++index, '--quality');
        break;
      case '--trace':
        options.tracePath = readArgument(args, ++index, '--trace');
        break;
      case '--output':
        options.outputPath = readArgument(args, ++index, '--output');
        break;
      case '--private-key':
        options.privateKeyPath = readArgument(args, ++index, '--private-key');
        break;
      case '--public-key':
        options.publicKeyPath = readArgument(args, ++index, '--public-key');
        break;
      case '--source-commit':
      case '--commit':
        options.sourceCommitSha = readArgument(args, ++index, argument);
        break;
      case '--generated-at':
        options.generatedAt = readArgument(args, ++index, '--generated-at');
        break;
      case '--key-id':
        options.keyId = readArgument(args, ++index, '--key-id');
        break;
      case '--delivery-mode': {
        const value = readArgument(args, ++index, '--delivery-mode');
        if (
          value !== 'external-ci-artifact' &&
          value !== 'repository-evidence-commit'
        ) {
          throw new Error(
            '--delivery-mode must be external-ci-artifact or repository-evidence-commit',
          );
        }
        options.deliveryMode = value;
        break;
      }
      case '--target-stage': {
        const value = readArgument(args, ++index, '--target-stage');
        if (
          value !== 'canary-5' &&
          value !== 'canary-25' &&
          value !== 'canary-100'
        ) {
          throw new Error(
            '--target-stage must be canary-5, canary-25, or canary-100',
          );
        }
        options.targetStage = value;
        break;
      }
      case '--validity-hours': {
        const value = Number(readArgument(args, ++index, '--validity-hours'));
        if (!Number.isFinite(value) || value <= 0 || value > 48) {
          throw new Error('--validity-hours must be greater than 0 and <= 48');
        }
        options.validityHours = value;
        break;
      }
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

async function readQualityArtifact(
  filePath: string,
): Promise<{ bytes: Buffer; summary: EvidenceMemoryPromotionArtifactSummary }> {
  const bytes = await fs.readFile(filePath);
  const value = readRecord(JSON.parse(bytes.toString('utf8')), 'quality');
  if (
    value.format !== 'clodex-evidence-memory-quality' ||
    value.version !== 1
  ) {
    throw new Error('quality artifact has an unsupported format');
  }
  const report = readRecord(value.report, 'quality.report');
  return {
    bytes,
    summary: {
      bytes,
      generatedAt: requiredString(value.generatedAt, 'quality.generatedAt'),
      policyHash: requiredHash(report.policyHash, 'quality.policyHash'),
      promotionReady: report.promotionReady === true,
    },
  };
}

async function readTraceArtifact(
  filePath: string,
): Promise<{ bytes: Buffer; summary: EvidenceMemoryPromotionArtifactSummary }> {
  const bytes = await fs.readFile(filePath);
  const value = readRecord(JSON.parse(bytes.toString('utf8')), 'trace');
  if (
    value.format !== 'clodex-evidence-memory-trace-replay-report' ||
    value.version !== 1
  ) {
    throw new Error('trace artifact has an unsupported format');
  }
  const report = readRecord(value.report, 'trace.report');
  return {
    bytes,
    summary: {
      bytes,
      generatedAt: requiredString(value.generatedAt, 'trace.generatedAt'),
      policyHash: requiredHash(report.policyHash, 'trace.policyHash'),
      promotionReady: report.promotionReady === true,
      source: requiredString(value.source, 'trace.source'),
      traceSetHash: requiredHash(report.traceSetHash, 'trace.traceSetHash'),
    },
  };
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

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function createCollectionSourceBinding(
  deliveryMode: EvidenceMemoryPromotionDeliveryMode,
  sourceCommitSha: string,
) {
  if (deliveryMode === 'external-ci-artifact') {
    return {
      buildCommitSha: sourceCommitSha,
      sourceCommitIsAncestor: true,
      changedPaths: [],
    };
  }
  const alternateDigit = sourceCommitSha.startsWith('f') ? 'e' : 'f';
  return {
    buildCommitSha: alternateDigit.repeat(sourceCommitSha.length),
    sourceCommitIsAncestor: true,
    changedPaths: EVIDENCE_MEMORY_REPOSITORY_EVIDENCE_PATHS,
  };
}

async function writeJsonAtomically(
  outputPath: string,
  value: unknown,
): Promise<void> {
  await writeBytesAtomically(
    outputPath,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
  );
}

async function writeBytesAtomically(
  outputPath: string,
  bytes: Uint8Array,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, bytes, { mode: 0o600 });
  await fs.rename(temporaryPath, outputPath);
}

function printUsage(): void {
  console.log(`Usage:
  pnpm collect:evidence-memory-promotion -- \\
    --trace <external-trace-report.json> \\
    --private-key <ed25519-private-key.pem> \\
    --public-key <trusted-ed25519-public-key.pem> \\
    --source-commit <git-sha> \\
    --delivery-mode repository-evidence-commit \\
    --target-stage canary-5

Creates a signed, expiring promotion artifact linked byte-for-byte to the
deterministic quality report and an external content-free trace replay. The
default repository-evidence-commit mode must be committed after the exact
source commit and may change only the three generated .release-evidence files.`);
}
