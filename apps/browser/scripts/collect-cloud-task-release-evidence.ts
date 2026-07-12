import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createCloudTaskReleaseEvidence,
  evaluateCloudTaskReleaseReadiness,
} from '../src/shared/cloud-task-release-readiness';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const defaultOutputPath = path.join(
  repositoryRoot,
  '.release-evidence',
  'cloud-tasks.json',
);
const MAX_JSON_BYTES = 2 * 1024 * 1024;

interface CollectionOptions {
  aggregatePath?: string;
  sourceCommitSha?: string;
  smokePaths: string[];
  outputPath?: string;
  backendConformancePassed: boolean;
  contentFreeTelemetryAuditPassed: boolean;
  productSignoff: boolean;
  securitySignoff: boolean;
  operationsSignoff: boolean;
  help: boolean;
}

export async function runCloudTaskReleaseEvidenceCollector(
  rawArgs: string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseArguments(rawArgs);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const aggregatePath = path.resolve(
    requiredValue(options.aggregatePath, '--aggregate'),
  );
  const sourceCommitSha =
    options.sourceCommitSha ??
    process.env.CLODEX_BUILD_COMMIT_SHA ??
    process.env.GITHUB_SHA;
  if (!sourceCommitSha || !/^[a-f0-9]{40,64}$/u.test(sourceCommitSha)) {
    throw new Error('--source-commit must be a 40-64 character lowercase SHA');
  }
  if (options.smokePaths.length !== 3) {
    throw new Error('--smoke must be provided exactly three times');
  }
  const missingAttestations = [
    ['--backend-conformance-passed', options.backendConformancePassed],
    [
      '--content-free-telemetry-audit-passed',
      options.contentFreeTelemetryAuditPassed,
    ],
    ['--product-signoff', options.productSignoff],
    ['--security-signoff', options.securitySignoff],
    ['--operations-signoff', options.operationsSignoff],
  ]
    .filter(([, passed]) => !passed)
    .map(([flag]) => flag);
  if (missingAttestations.length > 0) {
    throw new Error(
      `explicit release attestations are required: ${missingAttestations.join(', ')}`,
    );
  }

  const [aggregate, ...platformSmokes] = await Promise.all([
    readJsonFile(aggregatePath, 'Cloud Task aggregate'),
    ...options.smokePaths.map((smokePath) =>
      readJsonFile(path.resolve(smokePath), 'Cloud Task platform smoke'),
    ),
  ]);
  const evidence = createCloudTaskReleaseEvidence({
    aggregate,
    sourceCommitSha,
    platformSmokes,
    backendConformancePassed: options.backendConformancePassed,
    contentFreeTelemetryAuditPassed: options.contentFreeTelemetryAuditPassed,
    humanSignoff: {
      product: options.productSignoff,
      security: options.securitySignoff,
      operations: options.operationsSignoff,
    },
  });
  const readiness = evaluateCloudTaskReleaseReadiness(evidence, {
    buildCommitSha: sourceCommitSha,
  });
  if (!readiness.ready) {
    throw new Error(
      `Cloud Task evidence is not release-ready: ${readiness.checks
        .filter((check) => !check.passed)
        .map((check) => check.id)
        .join(', ')}`,
    );
  }

  const outputPath = path.resolve(options.outputPath ?? defaultOutputPath);
  await writeJsonAtomically(outputPath, evidence);
  process.stdout.write(
    `${[
      'CLOUD_TASK_RELEASE_EVIDENCE',
      'collected=true',
      `output=${JSON.stringify(outputPath)}`,
      `observationHours=${readiness.metrics.observationHours}`,
      `finishedExecutions=${readiness.metrics.finishedExecutions}`,
      `status=${readiness.status}`,
      'exit=0',
    ].join(' ')}\n`,
  );
}

function parseArguments(rawArgs: string[]): CollectionOptions {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const options: CollectionOptions = {
    smokePaths: [],
    backendConformancePassed: false,
    contentFreeTelemetryAuditPassed: false,
    productSignoff: false,
    securitySignoff: false,
    operationsSignoff: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--aggregate':
        options.aggregatePath = readArgument(args, ++index, argument);
        break;
      case '--source-commit':
        options.sourceCommitSha = readArgument(args, ++index, argument);
        break;
      case '--smoke':
        options.smokePaths.push(readArgument(args, ++index, argument));
        break;
      case '--output':
        options.outputPath = readArgument(args, ++index, argument);
        break;
      case '--backend-conformance-passed':
        options.backendConformancePassed = true;
        break;
      case '--content-free-telemetry-audit-passed':
        options.contentFreeTelemetryAuditPassed = true;
        break;
      case '--product-signoff':
        options.productSignoff = true;
        break;
      case '--security-signoff':
        options.securitySignoff = true;
        break;
      case '--operations-signoff':
        options.operationsSignoff = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown Cloud Task evidence argument: ${argument}`);
    }
  }
  return options;
}

async function readJsonFile(filePath: string, label: string): Promise<unknown> {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > MAX_JSON_BYTES
  ) {
    throw new Error(`${label} must be a bounded regular non-symlink file`);
  }
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

async function writeJsonAtomically(
  outputPath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await fs.rename(temporaryPath, outputPath);
    if (process.platform !== 'win32') await fs.chmod(outputPath, 0o600);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function requiredValue(value: string | undefined, argument: string): string {
  if (!value?.trim()) throw new Error(`${argument} is required`);
  return value;
}

function readArgument(
  args: readonly string[],
  index: number,
  argument: string,
): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${argument} requires a value`);
  }
  return value;
}

function usage(): string {
  return `Cloud Task release evidence collector

Usage:
  pnpm collect:cloud-task-release-evidence -- \\
    --aggregate cloud-task-aggregate.json \\
    --source-commit <exact-candidate-sha> \\
    --smoke darwin-arm64.json \\
    --smoke win32-x64.json \\
    --smoke linux-x64.json \\
    --backend-conformance-passed \\
    --content-free-telemetry-audit-passed \\
    --product-signoff \\
    --security-signoff \\
    --operations-signoff \\
    [--output .release-evidence/cloud-tasks.json]

The collector writes nothing until the aggregate, all three fresh platform
smokes, every SLO, and all explicit sign-offs pass. Raw telemetry, identifiers,
paths, URLs, logs, prompts, and credentials are not accepted by the schemas.
`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  void runCloudTaskReleaseEvidenceCollector().catch((error) => {
    process.stderr.write(
      `CLOUD_TASK_RELEASE_EVIDENCE collected=false exit=1 error=${JSON.stringify(
        error instanceof Error ? error.message : 'Collection failed',
      )}\n`,
    );
    process.exitCode = 1;
  });
}
