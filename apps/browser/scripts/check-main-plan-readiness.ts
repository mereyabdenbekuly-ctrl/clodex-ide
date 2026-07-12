import { spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises, { type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assessModelFabricPromotion,
  assessRunnerPromotion,
} from '../src/backend/services/main-plan-promotion-assessments';
import { parseTrustedRunnerDogfoodCollectorKeys } from '../src/backend/services/runner-routing/dogfood-ingestion';
import {
  evaluateCloudTaskReleaseReadiness,
  parseCloudTaskReleaseEvidence,
} from '../src/shared/cloud-task-release-readiness';
import type { AppReleaseChannel } from '../src/shared/feature-gates';
import {
  evaluateMainPlanReadiness,
  mainPlanEpicIds,
  type MainPlanEpicId,
  type MainPlanPromotionAssessment,
  type MainPlanReadinessReport,
  type MainPlanSourceState,
} from '../src/shared/main-plan-readiness';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const browserRoot = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(browserRoot, '../..');
const tsconfigPath = path.join(browserRoot, 'tsconfig.backend.json');
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve('tsx/cli');
const MAX_CHECK_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_CLOUD_EVIDENCE_BYTES = 1024 * 1024;

const defaultCloudTaskEvidencePath = path.join(
  repositoryRoot,
  '.release-evidence',
  'cloud-tasks.json',
);
const defaultModelFabricStatePath = path.join(
  repositoryRoot,
  '.release-evidence',
  'model-fabric-publication-state.json',
);
const defaultModelFabricRootPublicKeyPath = path.join(
  repositoryRoot,
  '.release-evidence',
  'model-fabric-root-public-key.pem',
);
const defaultRunnerEvidenceDirectoryPath = path.join(
  repositoryRoot,
  '.release-evidence',
  'runner-routing',
);
const defaultRunnerTrustedCollectorsPath = path.join(
  repositoryRoot,
  '.release-evidence',
  'runner-routing-trusted-collectors.txt',
);

interface CheckMainPlanReadinessOptions {
  channel: AppReleaseChannel;
  requiredPromotions: MainPlanEpicId[];
  requireCleanSource: boolean;
  json: boolean;
  outputPath?: string;
  evidenceMemoryEvidencePath?: string;
  evidenceMemoryQualityPath?: string;
  evidenceMemoryTracePath?: string;
  evidenceMemoryPublicKeyPath?: string;
  agenticAppEvidencePath?: string;
  agenticAppEvaluationPath?: string;
  cloudTaskEvidencePath?: string;
  modelFabricStatePath?: string;
  modelFabricRootPublicKeyPath?: string;
  modelFabricSnapshotRootPublicKeyPath?: string;
  runnerEvidenceDirectoryPath?: string;
  runnerTrustedCollectorsPath?: string;
  runnerTrustedCollectorPublicKeys: string[];
  help: boolean;
}

interface MainPlanReadinessCliDependencies {
  now: () => Date;
  inspectSource: () => MainPlanSourceState;
  collectPromotions: (
    options: CheckMainPlanReadinessOptions,
    source: MainPlanSourceState,
    now: Date,
  ) => Partial<Record<MainPlanEpicId, MainPlanPromotionAssessment>>;
}

const defaultDependencies: MainPlanReadinessCliDependencies = {
  now: () => new Date(),
  inspectSource: inspectRepositorySource,
  collectPromotions: collectPromotionAssessments,
};

export async function runMainPlanReadinessCli(
  rawArgs: string[] = process.argv.slice(2),
  dependencies: MainPlanReadinessCliDependencies = defaultDependencies,
): Promise<MainPlanReadinessReport | null> {
  const options = parseArguments(rawArgs);
  if (options.help) {
    process.stdout.write(usage());
    return null;
  }

  const now = dependencies.now();
  const source = dependencies.inspectSource();
  const promotions = dependencies.collectPromotions(options, source, now);
  const report = evaluateMainPlanReadiness({
    generatedAt: now.toISOString(),
    channel: options.channel,
    source,
    requireCleanSource: options.requireCleanSource,
    requiredPromotions: options.requiredPromotions,
    promotions,
  });

  if (options.outputPath) {
    await writeAtomicJson(path.resolve(options.outputPath), report);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHumanReport(report, options.outputPath);
  }
  return report;
}

function collectPromotionAssessments(
  options: CheckMainPlanReadinessOptions,
  source: MainPlanSourceState,
  now: Date,
): Partial<Record<MainPlanEpicId, MainPlanPromotionAssessment>> {
  const evidenceMemoryArgs = [
    '--json',
    '--channel',
    options.channel,
    '--build-commit',
    source.commitSha,
  ];
  appendOptionalArgument(
    evidenceMemoryArgs,
    '--evidence',
    options.evidenceMemoryEvidencePath,
  );
  appendOptionalArgument(
    evidenceMemoryArgs,
    '--quality',
    options.evidenceMemoryQualityPath,
  );
  appendOptionalArgument(
    evidenceMemoryArgs,
    '--trace',
    options.evidenceMemoryTracePath,
  );
  appendOptionalArgument(
    evidenceMemoryArgs,
    '--public-key',
    options.evidenceMemoryPublicKeyPath,
  );

  const agenticAppArgs = ['--json', '--build-commit', source.commitSha];
  appendOptionalArgument(
    agenticAppArgs,
    '--evidence',
    options.agenticAppEvidencePath,
  );
  appendOptionalArgument(
    agenticAppArgs,
    '--evaluation-evidence',
    options.agenticAppEvaluationPath,
  );

  return {
    'evidence-memory': runJsonPromotionCheck(
      'check-evidence-memory-rollout.ts',
      evidenceMemoryArgs,
      'evidence-memory-rollout',
    ),
    'model-fabric': assessModelFabricPromotion({
      channel: options.channel,
      now,
      statePath: path.resolve(
        options.modelFabricStatePath ?? defaultModelFabricStatePath,
      ),
      rootPublicKeyPath: path.resolve(
        options.modelFabricRootPublicKeyPath ??
          defaultModelFabricRootPublicKeyPath,
      ),
      ...(options.modelFabricSnapshotRootPublicKeyPath
        ? {
            snapshotRootPublicKeyPath: path.resolve(
              options.modelFabricSnapshotRootPublicKeyPath,
            ),
          }
        : {}),
    }),
    'session-teleporter': assessCloudTaskPromotion(
      path.resolve(
        options.cloudTaskEvidencePath ?? defaultCloudTaskEvidencePath,
      ),
      now,
      source.commitSha,
    ),
    'decoupled-execution': assessRunnerPromotion({
      now,
      buildCommitSha: source.commitSha,
      evidenceDirectoryPath: path.resolve(
        options.runnerEvidenceDirectoryPath ??
          defaultRunnerEvidenceDirectoryPath,
      ),
      trustedCollectorPublicKeys: options.runnerTrustedCollectorPublicKeys,
      trustedCollectorPublicKeysPath: path.resolve(
        options.runnerTrustedCollectorsPath ??
          defaultRunnerTrustedCollectorsPath,
      ),
    }),
    'generated-app-capability-bridge': runJsonPromotionCheck(
      'check-agentic-app-runtime-promotion.ts',
      agenticAppArgs,
      'agentic-app-runtime-promotion',
    ),
  };
}

function runJsonPromotionCheck(
  scriptName: string,
  args: readonly string[],
  source: string,
): MainPlanPromotionAssessment {
  const result = spawnSync(
    process.execPath,
    [
      tsxCliPath,
      '--tsconfig',
      tsconfigPath,
      path.join(scriptDirectory, scriptName),
      ...args,
    ],
    {
      cwd: browserRoot,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: MAX_CHECK_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const parsed = tryParseJsonRecord(result.stdout);
  if (parsed) {
    const ready = parsed.ready === true;
    const evidenceRequired = parsed.evidenceRequired !== false;
    const evidencePath = optionalString(parsed.evidencePath);
    const blockers = readFailedCheckIds(parsed);
    const state: MainPlanPromotionAssessment['state'] = ready
      ? 'ready'
      : result.status === 0 && !evidenceRequired
        ? 'absent'
        : 'not-ready';
    return {
      state,
      source,
      ...(evidencePath ? { evidencePath } : {}),
      blockers:
        state === 'not-ready' && blockers.length === 0
          ? ['promotion-check-not-ready']
          : blockers,
      details: readPromotionDetails(parsed),
    };
  }
  return {
    state: 'invalid',
    source,
    blockers: [
      result.error
        ? 'promotion-check-process-failed'
        : result.signal
          ? 'promotion-check-terminated'
          : 'promotion-check-output-invalid',
    ],
  };
}

function assessCloudTaskPromotion(
  evidencePath: string,
  now: Date,
  buildCommitSha: string,
): MainPlanPromotionAssessment {
  if (!fs.existsSync(evidencePath)) {
    return {
      state: 'absent',
      source: 'cloud-task-release-readiness',
      evidencePath,
      blockers: [],
    };
  }
  try {
    const stat = fs.lstatSync(evidencePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_CLOUD_EVIDENCE_BYTES
    ) {
      throw new Error('untrusted evidence file');
    }
    const evidence = parseCloudTaskReleaseEvidence(
      JSON.parse(fs.readFileSync(evidencePath, 'utf8')),
    );
    const readiness = evaluateCloudTaskReleaseReadiness(evidence, {
      now,
      buildCommitSha,
    });
    return {
      state: readiness.ready ? 'ready' : 'not-ready',
      source: 'cloud-task-release-readiness',
      evidencePath,
      blockers: readiness.checks
        .filter((check) => !check.passed)
        .map((check) => check.id)
        .slice(0, 64),
      details: {
        status: readiness.status,
        observationHours: readiness.metrics.observationHours,
        finishedExecutions: readiness.metrics.finishedExecutions,
      },
    };
  } catch {
    return {
      state: 'invalid',
      source: 'cloud-task-release-readiness',
      evidencePath,
      blockers: ['cloud-task-evidence-validation-failed'],
    };
  }
}

function inspectRepositorySource(): MainPlanSourceState {
  const commitSha = gitOutput(['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40,64}$/u.test(commitSha)) {
    throw new Error('Current source commit SHA is invalid');
  }
  const status = gitOutput([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  return {
    commitSha,
    clean: status.trim().length === 0,
  };
}

function gitOutput(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_CHECK_OUTPUT_BYTES,
  });
}

function parseArguments(rawArgs: string[]): CheckMainPlanReadinessOptions {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const options: CheckMainPlanReadinessOptions = {
    channel: parseChannel(
      process.env.MAIN_PLAN_RELEASE_CHANNEL ??
        process.env.EVIDENCE_MEMORY_RELEASE_CHANNEL ??
        'release',
    ),
    requiredPromotions: [],
    requireCleanSource: false,
    json: false,
    runnerTrustedCollectorPublicKeys: parseTrustedRunnerDogfoodCollectorKeys(
      process.env.CLODEX_RUNNER_DOGFOOD_TRUSTED_COLLECTOR_KEYS,
    ),
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--channel':
        options.channel = parseChannel(
          readArgument(args, ++index, '--channel'),
        );
        break;
      case '--require-promotion':
        options.requiredPromotions.push(
          ...parseRequiredPromotions(
            readArgument(args, ++index, '--require-promotion'),
          ),
        );
        break;
      case '--require-clean':
        options.requireCleanSource = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--out':
        options.outputPath = readArgument(args, ++index, '--out');
        break;
      case '--evidence-memory-evidence':
        options.evidenceMemoryEvidencePath = readArgument(
          args,
          ++index,
          argument,
        );
        break;
      case '--evidence-memory-quality':
        options.evidenceMemoryQualityPath = readArgument(
          args,
          ++index,
          argument,
        );
        break;
      case '--evidence-memory-trace':
        options.evidenceMemoryTracePath = readArgument(args, ++index, argument);
        break;
      case '--evidence-memory-public-key':
        options.evidenceMemoryPublicKeyPath = readArgument(
          args,
          ++index,
          argument,
        );
        break;
      case '--agentic-app-evidence':
        options.agenticAppEvidencePath = readArgument(args, ++index, argument);
        break;
      case '--agentic-app-evaluation':
        options.agenticAppEvaluationPath = readArgument(
          args,
          ++index,
          argument,
        );
        break;
      case '--cloud-task-evidence':
        options.cloudTaskEvidencePath = readArgument(args, ++index, argument);
        break;
      case '--model-fabric-state':
        options.modelFabricStatePath = readArgument(args, ++index, argument);
        break;
      case '--model-fabric-root-public-key':
        options.modelFabricRootPublicKeyPath = readArgument(
          args,
          ++index,
          argument,
        );
        break;
      case '--model-fabric-snapshot-root-public-key':
        options.modelFabricSnapshotRootPublicKeyPath = readArgument(
          args,
          ++index,
          argument,
        );
        break;
      case '--runner-evidence-dir':
        options.runnerEvidenceDirectoryPath = readArgument(
          args,
          ++index,
          argument,
        );
        break;
      case '--runner-trusted-collectors':
        options.runnerTrustedCollectorsPath = readArgument(
          args,
          ++index,
          argument,
        );
        break;
      case '--runner-trusted-collector-key':
        options.runnerTrustedCollectorPublicKeys.push(
          ...parseTrustedRunnerDogfoodCollectorKeys(
            readArgument(args, ++index, argument),
          ),
        );
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown main-plan readiness argument: ${argument}`);
    }
  }

  options.requiredPromotions = [...new Set(options.requiredPromotions)];
  options.runnerTrustedCollectorPublicKeys = [
    ...new Set(options.runnerTrustedCollectorPublicKeys),
  ];
  return options;
}

function parseRequiredPromotions(value: string): MainPlanEpicId[] {
  if (value === 'all') return [...mainPlanEpicIds];
  return value.split(',').map((rawId) => {
    const id = rawId.trim();
    if (!mainPlanEpicIds.includes(id as MainPlanEpicId)) {
      throw new Error(`Unknown main-plan epic: ${id}`);
    }
    return id as MainPlanEpicId;
  });
}

function parseChannel(value: string): AppReleaseChannel {
  if (
    value !== 'dev' &&
    value !== 'prerelease' &&
    value !== 'nightly' &&
    value !== 'release'
  ) {
    throw new Error('Channel must be dev, prerelease, nightly, or release');
  }
  return value;
}

function appendOptionalArgument(
  args: string[],
  name: string,
  value: string | undefined,
): void {
  if (value) args.push(name, path.resolve(value));
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

function tryParseJsonRecord(value: string): Record<string, unknown> | null {
  if (Buffer.byteLength(value) > MAX_CHECK_OUTPUT_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readFailedCheckIds(value: Record<string, unknown>): string[] {
  if (!Array.isArray(value.checks)) return [];
  return value.checks
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && item.passed === false && typeof item.id === 'string',
    )
    .map((item) => item.id as string)
    .slice(0, 64);
}

function readPromotionDetails(
  value: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const details: Record<string, string | number | boolean | null> = {};
  for (const key of [
    'channel',
    'stage',
    'allocationPercent',
    'status',
    'armed',
  ]) {
    const candidate = value[key];
    if (
      typeof candidate === 'string' ||
      typeof candidate === 'number' ||
      typeof candidate === 'boolean' ||
      candidate === null
    ) {
      details[key] = candidate;
    }
  }
  return details;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function printHumanReport(
  report: MainPlanReadinessReport,
  outputPath: string | undefined,
): void {
  for (const epic of report.epics) {
    process.stdout.write(
      `${epic.releaseSafe ? 'PASS' : 'FAIL'} ${epic.id} implementation=${epic.implementationComplete ? 'complete' : 'incomplete'} status=${epic.status} promotion=${epic.promotionState} promotion_source=${epic.promotionSource} blockers=${epic.blockers.length}\n`,
    );
  }
  process.stdout.write(
    `MAIN_PLAN_READINESS ready=${report.ready} code_complete=${report.codeComplete} build_ready=${report.buildReady} promotion_ready=${report.promotionReady} required_promotion_ready=${report.requiredPromotionReady} channel=${report.channel} promoted=${report.promotedEpicCount}/${report.promotableEpicCount} source_clean=${report.source.clean} report=${outputPath ? JSON.stringify(path.resolve(outputPath)) : 'stdout-only'} exit=${report.ready ? 0 : 1}\n`,
  );
}

async function writeAtomicJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | null = null;
  try {
    handle = await fsPromises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporaryPath, filePath);
    if (process.platform !== 'win32') await fsPromises.chmod(filePath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fsPromises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function usage(): string {
  return `Main plan readiness gate

Usage:
  pnpm check:main-plan-readiness -- --channel release
  pnpm check:main-plan-readiness -- --channel release --require-clean
  pnpm check:main-plan-readiness -- \\
    --channel prerelease \\
    --require-promotion all \\
    --out test-results/main-plan-readiness.json

The default check passes when all five v1 epics are code-complete and every
unpromoted release capability remains safely default-off. Existing malformed,
stale, or insufficient promotion evidence always fails closed. Use repeatable
--require-promotion values (or "all") only when a release operator intends to
promote those epics. --require-clean is intended for an exact RC source tree.

Model Fabric defaults to .release-evidence/model-fabric-publication-state.json
plus model-fabric-root-public-key.pem. Decoupled Execution defaults to signed
bundles under .release-evidence/runner-routing and pinned public collector keys
from runner-routing-trusted-collectors.txt or
CLODEX_RUNNER_DOGFOOD_TRUSTED_COLLECTOR_KEYS.
`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  void runMainPlanReadinessCli()
    .then((report) => {
      if (report && !report.ready) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(
        `MAIN_PLAN_READINESS ready=false exit=1 error=${JSON.stringify(
          error instanceof Error ? error.message : 'Readiness check failed',
        )}\n`,
      );
      process.exitCode = 1;
    });
}
