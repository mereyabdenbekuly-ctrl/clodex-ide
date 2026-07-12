import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildIsolatedAgentRuntimeAggregateHogQl,
  createIsolatedAgentRuntimePromotionEvidence,
  parseIsolatedAgentRuntimeAggregateResult,
} from '../src/shared/isolated-agent-runtime-evidence-collection';
import { evaluateIsolatedAgentRuntimePromotionReadiness } from '../src/shared/isolated-agent-runtime-promotion';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const defaultOutputPath = path.join(
  repositoryRoot,
  '.release-evidence',
  'isolated-agent-runtime.json',
);
const qualityGateFlags = {
  happySmokePassed: '--happy-smoke-passed',
  faultSmokePassed: '--fault-smoke-passed',
  contentFreeTelemetryAuditPassed: '--content-free-telemetry-audit-passed',
  noPostDispatchReplayAuditPassed: '--no-post-dispatch-replay-audit-passed',
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
    'ISOLATED_AGENT_RUNTIME_EVIDENCE collected=false exit=1',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}

async function collectEvidence(options: CollectionOptions): Promise<void> {
  const observationStartedAt = requiredOption(
    options.observationStartedAt,
    '--from',
  );
  const observationEndedAt = requiredOption(options.observationEndedAt, '--to');
  const missingQualityGates = Object.entries(qualityGateFlags)
    .filter(([key]) => !options.qualityGates[key as keyof QualityGates])
    .map(([, flag]) => flag);
  if (missingQualityGates.length > 0) {
    throw new Error(
      `quality gates must be explicitly attested after running them: ${missingQualityGates.join(', ')}`,
    );
  }

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
  const query = buildIsolatedAgentRuntimeAggregateHogQl({
    observationStartedAt,
    observationEndedAt,
  });
  const aggregateResponse = await queryPostHog({
    apiHost,
    projectId,
    personalApiKey,
    query,
  });
  const aggregates =
    parseIsolatedAgentRuntimeAggregateResult(aggregateResponse);
  const evidence = createIsolatedAgentRuntimePromotionEvidence({
    observationStartedAt,
    observationEndedAt,
    aggregates,
    qualityGates: options.qualityGates,
  });
  const readiness = evaluateIsolatedAgentRuntimePromotionReadiness(evidence);

  if (!readiness.ready) {
    const failedChecks = readiness.checks
      .filter((check) => !check.passed)
      .map(
        (check) =>
          `${check.id} actual=${formatValue(check.actual)} required=${formatValue(check.required)}`,
      );
    throw new Error(
      `aggregate evidence is not promotion-ready; artifact was not written: ${failedChecks.join('; ')}`,
    );
  }

  const outputPath = path.resolve(options.outputPath ?? defaultOutputPath);
  await writeJsonAtomically(outputPath, evidence);

  console.log(
    [
      'ISOLATED_AGENT_RUNTIME_EVIDENCE',
      'collected=true',
      `output=${outputPath}`,
      `builds=${evidence.observedBuildCount}`,
      `installs=${evidence.observedInstallCount}`,
      `finishedSteps=${readiness.metrics.finishedStepCount}`,
      `failureRate=${readiness.metrics.failureRate.toFixed(6)}`,
      `abortRate=${readiness.metrics.abortRate.toFixed(6)}`,
      `workerCrashRate=${readiness.metrics.workerCrashRate.toFixed(6)}`,
      `circuitBreakerOpenRate=${readiness.metrics.circuitBreakerOpenRate.toFixed(6)}`,
      'exit=0',
    ].join(' '),
  );
}

interface QualityGates {
  happySmokePassed: boolean;
  faultSmokePassed: boolean;
  contentFreeTelemetryAuditPassed: boolean;
  noPostDispatchReplayAuditPassed: boolean;
}

interface CollectionOptions {
  observationStartedAt?: string;
  observationEndedAt?: string;
  projectId?: string;
  apiHost?: string;
  outputPath?: string;
  qualityGates: QualityGates;
  help: boolean;
}

function parseArguments(args: string[]): CollectionOptions {
  const options: CollectionOptions = {
    qualityGates: {
      happySmokePassed: false,
      faultSmokePassed: false,
      contentFreeTelemetryAuditPassed: false,
      noPostDispatchReplayAuditPassed: false,
    },
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--':
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
      case '--output':
        options.outputPath = readArgumentValue(args, ++index, '--output');
        break;
      case '--happy-smoke-passed':
        options.qualityGates.happySmokePassed = true;
        break;
      case '--fault-smoke-passed':
        options.qualityGates.faultSmokePassed = true;
        break;
      case '--content-free-telemetry-audit-passed':
        options.qualityGates.contentFreeTelemetryAuditPassed = true;
        break;
      case '--no-post-dispatch-replay-audit-passed':
        options.qualityGates.noPostDispatchReplayAuditPassed = true;
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
        'User-Agent': 'clodex-isolated-agent-runtime-evidence-collector',
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

async function writeJsonAtomically(
  outputPath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o644,
      flag: 'wx',
    });
    await fs.rename(temporaryPath, outputPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
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
  pnpm collect:isolated-agent-runtime-evidence -- \\
    --from <canonical-ISO-start> \\
    --to <canonical-ISO-exclusive-end> \\
    --happy-smoke-passed \\
    --fault-smoke-passed \\
    --content-free-telemetry-audit-passed \\
    --no-post-dispatch-replay-audit-passed

Environment:
  POSTHOG_PERSONAL_API_KEY  Personal API key used only in the request header
  POSTHOG_PROJECT_ID       Numeric PostHog project ID
  POSTHOG_API_HOST         https://eu.posthog.com or https://us.posthog.com

POSTHOG_CLI_API_KEY, POSTHOG_CLI_PROJECT_ID, and POSTHOG_CLI_HOST are accepted
as fallbacks. The collector requests exactly one aggregate-only HogQL row,
refuses to write evidence below the promotion thresholds, and never prints or
stores the API key, raw events, IDs, app versions, or content.`);
}
