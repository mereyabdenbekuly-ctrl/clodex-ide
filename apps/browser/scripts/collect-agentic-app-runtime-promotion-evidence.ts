import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAgenticAppRuntimeAggregateHogQl,
  parseAgenticAppRuntimeAggregateResult,
} from '../src/shared/agentic-app-runtime-evidence-collection';
import { parseAgenticAppRuntimeEvaluationEvidence } from '../src/shared/agentic-app-runtime-evaluation';
import {
  createAgenticAppRuntimePromotionEvidence,
  evaluateAgenticAppRuntimePromotionReadiness,
  parseAgenticAppRuntimeDogfoodAggregate,
  type AgenticAppRuntimeManualQualityGates,
} from '../src/shared/agentic-app-runtime-promotion';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const defaultEvaluationPath = path.resolve(
  scriptDirectory,
  '../test-results/agentic-app-runtime-evaluation.json',
);
const defaultOutputPath = path.join(
  repositoryRoot,
  '.release-evidence',
  'agentic-app-runtime.json',
);
const defaultBundledEvaluationPath = path.join(
  repositoryRoot,
  '.release-evidence',
  'agentic-app-runtime-evaluation.json',
);
const qualityGateFlags = {
  previewLifecyclePassed: '--preview-lifecycle-passed',
  ephemeralGrantReloadPassed: '--ephemeral-grant-reload-passed',
  sensitiveApprovalPassed: '--sensitive-approval-passed',
  asyncCancelTimeoutPassed: '--async-cancel-timeout-passed',
  runtimeInspectorPassed: '--runtime-inspector-passed',
  packageTrustReviewPassed: '--package-trust-review-passed',
} as const;

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
  } else {
    await collectEvidence(options);
  }
} catch (error) {
  console.error(
    'AGENTIC_APP_RUNTIME_PROMOTION_EVIDENCE collected=false exit=1',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}

async function collectEvidence(options: CollectionOptions): Promise<void> {
  const evaluationPath = path.resolve(
    options.evaluationPath ?? defaultEvaluationPath,
  );
  const aggregate = await collectDogfoodAggregate(options);
  if (options.aggregateOutputPath) {
    await writeJsonAtomically(
      path.resolve(options.aggregateOutputPath),
      aggregate,
    );
  }
  if (options.aggregateOnly) {
    if (!options.aggregateOutputPath) {
      console.log(JSON.stringify(aggregate, null, 2));
    }
    console.log(
      [
        'AGENTIC_APP_RUNTIME_DOGFOOD_AGGREGATE',
        'collected=true',
        `output=${options.aggregateOutputPath ? path.resolve(options.aggregateOutputPath) : 'stdout-only'}`,
        `builds=${aggregate.observedBuildCount}`,
        `installs=${aggregate.observedInstallCount}`,
        `previewSessions=${aggregate.dogfood.previewSessions}`,
        `capabilityInvocations=${aggregate.dogfood.capabilityInvocations}`,
        `failures=${aggregate.dogfood.failures}`,
        'exit=0',
      ].join(' '),
    );
    return;
  }
  const sourceCommitSha =
    options.sourceCommitSha ??
    process.env.CLODEX_BUILD_COMMIT_SHA ??
    process.env.GITHUB_SHA;
  if (!sourceCommitSha || !/^[a-f0-9]{40,64}$/u.test(sourceCommitSha)) {
    throw new Error('--source-commit must be a 40-64 character lowercase SHA');
  }
  const missingQualityGates = Object.entries(qualityGateFlags)
    .filter(([key]) => !options.manualQualityGates[key as keyof ManualGates])
    .map(([, flag]) => flag);
  if (missingQualityGates.length > 0) {
    throw new Error(
      `manual gates must be explicitly attested after dogfood: ${missingQualityGates.join(', ')}`,
    );
  }
  const evaluationBytes = await fs.readFile(evaluationPath);
  const evaluationEvidence = parseAgenticAppRuntimeEvaluationEvidence(
    JSON.parse(evaluationBytes.toString('utf8')),
  );
  const evaluationSha256 = sha256(evaluationBytes);
  const evidence = createAgenticAppRuntimePromotionEvidence({
    aggregate,
    sourceCommitSha,
    evaluationEvidence,
    evaluationSha256,
    manualQualityGates: options.manualQualityGates,
  });
  const readiness = evaluateAgenticAppRuntimePromotionReadiness(evidence, {
    evaluationEvidence,
    evaluationSha256,
    buildCommitSha: sourceCommitSha,
  });

  if (!readiness.ready) {
    const failedChecks = readiness.checks
      .filter((item) => !item.passed)
      .map(
        (item) =>
          `${item.id} actual=${formatValue(item.actual)} required=${formatValue(item.required)}`,
      );
    throw new Error(
      `dogfood evidence is not promotion-ready; artifact was not written: ${failedChecks.join('; ')}`,
    );
  }

  const outputPath = path.resolve(options.outputPath ?? defaultOutputPath);
  const bundledEvaluationPath = path.resolve(
    options.bundledEvaluationPath ??
      (options.outputPath
        ? path.join(
            path.dirname(outputPath),
            'agentic-app-runtime-evaluation.json',
          )
        : defaultBundledEvaluationPath),
  );
  await writeBytesAtomically(bundledEvaluationPath, evaluationBytes);
  await writeJsonAtomically(outputPath, evidence);
  console.log(
    [
      'AGENTIC_APP_RUNTIME_PROMOTION_EVIDENCE',
      'collected=true',
      `output=${outputPath}`,
      `evaluation=${bundledEvaluationPath}`,
      `builds=${evidence.observedBuildCount}`,
      `installs=${evidence.observedInstallCount}`,
      `previewSessions=${evidence.dogfood.previewSessions}`,
      `capabilityInvocations=${evidence.dogfood.capabilityInvocations}`,
      `failureRate=${readiness.metrics.failureRate.toFixed(6)}`,
      `evaluationRun=${evidence.evaluationEvidence.runId}`,
      'exit=0',
    ].join(' '),
  );
}

type ManualGates = AgenticAppRuntimeManualQualityGates;

type CollectionOptions = {
  aggregatePath?: string;
  sourceCommitSha?: string;
  aggregateOutputPath?: string;
  observationStartedAt?: string;
  observationEndedAt?: string;
  projectId?: string;
  apiHost?: string;
  evaluationPath?: string;
  bundledEvaluationPath?: string;
  outputPath?: string;
  aggregateOnly: boolean;
  manualQualityGates: ManualGates;
  help: boolean;
};

function parseArguments(args: string[]): CollectionOptions {
  const options: CollectionOptions = {
    manualQualityGates: {
      previewLifecyclePassed: false,
      ephemeralGrantReloadPassed: false,
      sensitiveApprovalPassed: false,
      asyncCancelTimeoutPassed: false,
      runtimeInspectorPassed: false,
      packageTrustReviewPassed: false,
    },
    aggregateOnly: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--':
        break;
      case '--dogfood-aggregate':
        options.aggregatePath = readArgumentValue(
          args,
          ++index,
          '--dogfood-aggregate',
        );
        break;
      case '--source-commit':
        options.sourceCommitSha = readArgumentValue(
          args,
          ++index,
          '--source-commit',
        );
        break;
      case '--aggregate-output':
        options.aggregateOutputPath = readArgumentValue(
          args,
          ++index,
          '--aggregate-output',
        );
        break;
      case '--aggregate-only':
        options.aggregateOnly = true;
        break;
      case '--from':
        options.observationStartedAt = readArgumentValue(
          args,
          ++index,
          '--from',
        );
        break;
      case '--to':
        options.observationEndedAt = readArgumentValue(args, ++index, '--to');
        break;
      case '--project-id':
        options.projectId = readArgumentValue(args, ++index, '--project-id');
        break;
      case '--host':
        options.apiHost = readArgumentValue(args, ++index, '--host');
        break;
      case '--evaluation-evidence':
        options.evaluationPath = readArgumentValue(
          args,
          ++index,
          '--evaluation-evidence',
        );
        break;
      case '--output':
        options.outputPath = readArgumentValue(args, ++index, '--output');
        break;
      case '--bundled-evaluation-output':
        options.bundledEvaluationPath = readArgumentValue(
          args,
          ++index,
          '--bundled-evaluation-output',
        );
        break;
      case '--preview-lifecycle-passed':
        options.manualQualityGates.previewLifecyclePassed = true;
        break;
      case '--ephemeral-grant-reload-passed':
        options.manualQualityGates.ephemeralGrantReloadPassed = true;
        break;
      case '--sensitive-approval-passed':
        options.manualQualityGates.sensitiveApprovalPassed = true;
        break;
      case '--async-cancel-timeout-passed':
        options.manualQualityGates.asyncCancelTimeoutPassed = true;
        break;
      case '--runtime-inspector-passed':
        options.manualQualityGates.runtimeInspectorPassed = true;
        break;
      case '--package-trust-review-passed':
        options.manualQualityGates.packageTrustReviewPassed = true;
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

async function collectDogfoodAggregate(
  options: CollectionOptions,
): Promise<ReturnType<typeof parseAgenticAppRuntimeDogfoodAggregate>> {
  if (options.aggregatePath) {
    if (options.observationStartedAt || options.observationEndedAt) {
      throw new Error(
        '--dogfood-aggregate cannot be combined with --from or --to',
      );
    }
    const bytes = await fs.readFile(path.resolve(options.aggregatePath));
    return parseAgenticAppRuntimeDogfoodAggregate(
      JSON.parse(bytes.toString('utf8')),
    );
  }

  const observationStartedAt = requiredOption(
    options.observationStartedAt,
    '--from',
  );
  const observationEndedAt = requiredOption(options.observationEndedAt, '--to');
  const personalApiKey =
    process.env.POSTHOG_PERSONAL_API_KEY ??
    process.env.POSTHOG_CLI_API_KEY ??
    '';
  if (!personalApiKey) {
    throw new Error(
      'PostHog Personal API Key is missing; set POSTHOG_PERSONAL_API_KEY (or POSTHOG_CLI_API_KEY)',
    );
  }
  const projectId = readProjectId(
    options.projectId ??
      process.env.POSTHOG_PROJECT_ID ??
      process.env.POSTHOG_CLI_PROJECT_ID,
  );
  const apiHost = readApiHost(
    options.apiHost ??
      process.env.POSTHOG_API_HOST ??
      process.env.POSTHOG_CLI_HOST ??
      'https://eu.posthog.com',
  );
  const query = buildAgenticAppRuntimeAggregateHogQl({
    observationStartedAt,
    observationEndedAt,
  });
  const response = await queryPostHog({
    apiHost,
    projectId,
    personalApiKey,
    query,
  });
  return parseAgenticAppRuntimeAggregateResult({
    response,
    observationStartedAt,
    observationEndedAt,
  });
}

async function queryPostHog(options: {
  apiHost: string;
  projectId: string;
  personalApiKey: string;
  query: string;
}): Promise<unknown> {
  const response = await fetch(
    `${options.apiHost}/api/projects/${options.projectId}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.personalApiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'clodex-agentic-app-runtime-evidence-collector',
      },
      body: JSON.stringify({
        query: {
          kind: 'HogQLQuery',
          query: options.query,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `PostHog aggregate query failed with HTTP ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

function readProjectId(value: string | undefined): string {
  if (!value || !/^\d+$/.test(value) || value === '0') {
    throw new Error(
      'PostHog project ID is missing or invalid; set POSTHOG_PROJECT_ID (or POSTHOG_CLI_PROJECT_ID)',
    );
  }
  return value;
}

function readApiHost(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PostHog API host must be a valid URL');
  }
  if (
    url.protocol !== 'https:' ||
    !['eu.posthog.com', 'us.posthog.com'].includes(url.hostname) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'PostHog API host must be https://eu.posthog.com or https://us.posthog.com',
    );
  }
  return url.origin;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeJsonAtomically(
  outputPath: string,
  value: unknown,
): Promise<void> {
  await writeBytesAtomically(
    outputPath,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
  );
}

async function writeBytesAtomically(
  outputPath: string,
  value: Uint8Array,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, value, {
      mode: 0o644,
      flag: 'wx',
    });
    await fs.rename(temporaryPath, outputPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function readArgumentValue(
  args: string[],
  index: number,
  argument: string,
): string {
  const value = args[index];
  if (!value) throw new Error(`${argument} requires a value`);
  return value;
}

function requiredOption(value: string | undefined, argument: string): string {
  if (!value) throw new Error(`${argument} is required`);
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
  pnpm collect:agentic-app-runtime-promotion-evidence -- \\
    --from <canonical-ISO-start> \\
    --to <canonical-ISO-exclusive-end> \\
    --preview-lifecycle-passed \\
    --ephemeral-grant-reload-passed \\
    --sensitive-approval-passed \\
    --async-cancel-timeout-passed \\
    --runtime-inspector-passed \\
    --package-trust-review-passed

Optional:
  --source-commit <sha>         Exact 40-64 character build/source commit SHA.
  --project-id <id>             PostHog project ID (or environment variable).
  --host <url>                  eu.posthog.com or us.posthog.com.
  --aggregate-output <file>     Write the content-free aggregate snapshot.
  --aggregate-only              Collect progress without promotion attestations.
  --dogfood-aggregate <file>    Offline fallback instead of querying PostHog.
  --evaluation-evidence <file>  Deterministic suite evidence.
  --output <file>               Promotion evidence destination.
  --bundled-evaluation-output <file>
                                Exact linked evaluation copy destination.

The PostHog query returns one aggregate-only row and never event payloads,
identifiers, app versions or raw app hashes. Every manual flag remains an
explicit human attestation. No promotion artifact is written until every
threshold passes. The exact evaluation file is copied beside promotion evidence
for reproducible checking. If --source-commit is omitted, the collector reads
CLODEX_BUILD_COMMIT_SHA or GITHUB_SHA and fails closed when neither is valid.`);
}
