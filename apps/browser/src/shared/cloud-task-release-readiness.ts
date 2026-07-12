import { z } from 'zod';
import {
  parseCloudTaskSuspendResumeSmokeEvidence,
  type CloudTaskSuspendResumeSmokeEvidence,
} from './cloud-task-suspend-resume-smoke';

export const CLOUD_TASK_RELEASE_THRESHOLDS = {
  minimumObservationHours: 72,
  maximumEvidenceAgeHours: 48,
  minimumObservedBuilds: 2,
  minimumObservedInstalls: 25,
  minimumFinishedExecutions: 200,
  maximumFailureRate: 0.02,
  maximumNetworkFailureRate: 0.03,
  maximumResumeFailureRate: 0.01,
  maximumPolicyLimitRate: 0.01,
  maximumReconciliationFailureRate: 0.01,
  maximumArtifactActionFailureRate: 0.02,
  maximumIntegrityFailures: 0,
  maximumStartLatencyP95Ms: 5_000,
  maximumReconnectLatencyP95Ms: 3_000,
} as const;

const boundedCountSchema = z.number().int().nonnegative().max(1_000_000_000);
const boundedLatencySchema = z
  .number()
  .int()
  .nonnegative()
  .max(24 * 60 * 60_000);

export const cloudTaskReleaseEvidenceSchema = z
  .object({
    schemaVersion: z.literal(2),
    sourceChannel: z.literal('prerelease'),
    sourceCommitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    observationStartedAt: z.string().datetime({ offset: true }),
    observationEndedAt: z.string().datetime({ offset: true }),
    observedBuildCount: boundedCountSchema,
    observedInstallCount: boundedCountSchema,
    executions: z
      .object({
        completed: boundedCountSchema,
        failed: boundedCountSchema,
        cancelled: boundedCountSchema,
      })
      .strict(),
    failures: z
      .object({
        network: boundedCountSchema,
        resume: boundedCountSchema,
        integrity: boundedCountSchema,
        policyLimit: boundedCountSchema,
      })
      .strict(),
    reconciliation: z
      .object({
        inspected: boundedCountSchema,
        failed: boundedCountSchema,
      })
      .strict(),
    artifactActions: z
      .object({
        attempted: boundedCountSchema,
        failed: boundedCountSchema,
      })
      .strict(),
    latency: z
      .object({
        startP95Ms: boundedLatencySchema,
        reconnectP95Ms: boundedLatencySchema,
      })
      .strict(),
    qualityGates: z
      .object({
        backendConformancePassed: z.boolean(),
        contentFreeTelemetryAuditPassed: z.boolean(),
        macosSuspendResumePassed: z.boolean(),
        windowsSuspendResumePassed: z.boolean(),
        linuxSuspendResumePassed: z.boolean(),
      })
      .strict(),
    humanSignoff: z
      .object({
        product: z.boolean(),
        security: z.boolean(),
        operations: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const cloudTaskReleaseDogfoodAggregateSchema =
  cloudTaskReleaseEvidenceSchema.omit({
    sourceCommitSha: true,
    qualityGates: true,
    humanSignoff: true,
  });

export type CloudTaskReleaseEvidence = z.infer<
  typeof cloudTaskReleaseEvidenceSchema
>;
export type CloudTaskReleaseDogfoodAggregate = z.infer<
  typeof cloudTaskReleaseDogfoodAggregateSchema
>;

const REQUIRED_SMOKE_PLATFORMS = ['darwin', 'win32', 'linux'] as const;
const MAXIMUM_SMOKE_AGE_MS = 7 * 24 * 60 * 60_000;
const MAXIMUM_CLOCK_SKEW_MS = 5 * 60_000;

export function createCloudTaskReleaseEvidence(input: {
  aggregate: unknown;
  sourceCommitSha: string;
  platformSmokes: readonly unknown[];
  backendConformancePassed: boolean;
  contentFreeTelemetryAuditPassed: boolean;
  humanSignoff: CloudTaskReleaseEvidence['humanSignoff'];
  now?: Date;
}): CloudTaskReleaseEvidence {
  const aggregate = cloudTaskReleaseDogfoodAggregateSchema.parse(
    input.aggregate,
  );
  const smokes = input.platformSmokes.map((value) =>
    parseCloudTaskSuspendResumeSmokeEvidence(value),
  );
  const smokeByPlatform = new Map<
    CloudTaskSuspendResumeSmokeEvidence['platform'],
    CloudTaskSuspendResumeSmokeEvidence
  >();
  for (const smoke of smokes) {
    if (smokeByPlatform.has(smoke.platform)) {
      throw new Error(`Duplicate Cloud Task smoke platform: ${smoke.platform}`);
    }
    smokeByPlatform.set(smoke.platform, smoke);
  }
  const missingPlatforms = REQUIRED_SMOKE_PLATFORMS.filter(
    (platform) => !smokeByPlatform.has(platform),
  );
  if (missingPlatforms.length > 0) {
    throw new Error(
      `Cloud Task smoke evidence is missing platforms: ${missingPlatforms.join(', ')}`,
    );
  }
  const versions = new Set(smokes.map((smoke) => smoke.appVersion));
  if (versions.size !== 1) {
    throw new Error('Cloud Task smoke evidence must use one app version');
  }
  const nowMs = (input.now ?? new Date()).getTime();
  for (const smoke of smokes) {
    const completedAt = Date.parse(smoke.completedAt);
    if (completedAt > nowMs + MAXIMUM_CLOCK_SKEW_MS) {
      throw new Error(`Cloud Task smoke is from the future: ${smoke.platform}`);
    }
    if (nowMs - completedAt > MAXIMUM_SMOKE_AGE_MS) {
      throw new Error(`Cloud Task smoke is stale: ${smoke.platform}`);
    }
  }

  return parseCloudTaskReleaseEvidence({
    ...aggregate,
    sourceCommitSha: input.sourceCommitSha,
    qualityGates: {
      backendConformancePassed: input.backendConformancePassed,
      contentFreeTelemetryAuditPassed: input.contentFreeTelemetryAuditPassed,
      macosSuspendResumePassed: smokeByPlatform.has('darwin'),
      windowsSuspendResumePassed: smokeByPlatform.has('win32'),
      linuxSuspendResumePassed: smokeByPlatform.has('linux'),
    },
    humanSignoff: input.humanSignoff,
  });
}

export function parseCloudTaskReleaseEvidence(
  value: unknown,
): CloudTaskReleaseEvidence {
  const parsed = cloudTaskReleaseEvidenceSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Cloud Task release evidence failed validation');
  }
  return parsed.data;
}

export type CloudTaskReleaseReadinessStatus =
  | 'collecting'
  | 'needs-tuning'
  | 'awaiting-signoff'
  | 'candidate';

export interface CloudTaskReleaseReadinessCheck {
  id: string;
  category: 'sample' | 'quality' | 'platform' | 'signoff';
  passed: boolean;
  actual: number | boolean | string;
  required: number | boolean | string;
}

export interface CloudTaskReleaseReadiness {
  status: CloudTaskReleaseReadinessStatus;
  ready: boolean;
  metrics: {
    observationHours: number;
    evidenceAgeHours: number;
    finishedExecutions: number;
    failureRate: number;
    networkFailureRate: number;
    resumeFailureRate: number;
    policyLimitRate: number;
    reconciliationFailureRate: number;
    artifactActionFailureRate: number;
  };
  checks: CloudTaskReleaseReadinessCheck[];
}

export function evaluateCloudTaskReleaseReadiness(
  evidence: CloudTaskReleaseEvidence,
  options: { now?: Date; buildCommitSha?: string } = {},
): CloudTaskReleaseReadiness {
  const thresholds = CLOUD_TASK_RELEASE_THRESHOLDS;
  const start = Date.parse(evidence.observationStartedAt);
  const end = Date.parse(evidence.observationEndedAt);
  const now = (options.now ?? new Date()).getTime();
  const validWindow =
    Number.isFinite(start) && Number.isFinite(end) && end > start;
  const observationHours = validWindow ? (end - start) / 3_600_000 : 0;
  const evidenceAgeHours = Number.isFinite(end)
    ? Math.max(0, (now - end) / 3_600_000)
    : Number.POSITIVE_INFINITY;
  const finishedExecutions =
    evidence.executions.completed +
    evidence.executions.failed +
    evidence.executions.cancelled;
  const nonCancelled =
    evidence.executions.completed + evidence.executions.failed;
  const failureRate = rate(evidence.executions.failed, nonCancelled);
  const networkFailureRate = rate(evidence.failures.network, nonCancelled);
  const resumeFailureRate = rate(evidence.failures.resume, finishedExecutions);
  const policyLimitRate = rate(
    evidence.failures.policyLimit,
    finishedExecutions,
  );
  const reconciliationFailureRate = rate(
    evidence.reconciliation.failed,
    evidence.reconciliation.inspected,
  );
  const artifactActionFailureRate = rate(
    evidence.artifactActions.failed,
    evidence.artifactActions.attempted,
  );

  const checks: CloudTaskReleaseReadinessCheck[] = [
    check('schema-version', 'quality', evidence.schemaVersion === 2, 2, 2),
    check(
      'source-channel',
      'quality',
      evidence.sourceChannel === 'prerelease',
      evidence.sourceChannel,
      'prerelease',
    ),
    check(
      'source-commit-matches-build',
      'quality',
      options.buildCommitSha === undefined ||
        evidence.sourceCommitSha === options.buildCommitSha,
      evidence.sourceCommitSha,
      options.buildCommitSha ?? evidence.sourceCommitSha,
    ),
    check('valid-observation-window', 'sample', validWindow, validWindow, true),
    maximum(
      'evidence-age-hours',
      'sample',
      evidenceAgeHours,
      thresholds.maximumEvidenceAgeHours,
    ),
    minimum(
      'observation-hours',
      'sample',
      observationHours,
      thresholds.minimumObservationHours,
    ),
    minimum(
      'observed-builds',
      'sample',
      evidence.observedBuildCount,
      thresholds.minimumObservedBuilds,
    ),
    minimum(
      'observed-installs',
      'sample',
      evidence.observedInstallCount,
      thresholds.minimumObservedInstalls,
    ),
    minimum(
      'finished-executions',
      'sample',
      finishedExecutions,
      thresholds.minimumFinishedExecutions,
    ),
    maximum(
      'failure-rate',
      'quality',
      failureRate,
      thresholds.maximumFailureRate,
    ),
    maximum(
      'network-failure-rate',
      'quality',
      networkFailureRate,
      thresholds.maximumNetworkFailureRate,
    ),
    maximum(
      'resume-failure-rate',
      'quality',
      resumeFailureRate,
      thresholds.maximumResumeFailureRate,
    ),
    maximum(
      'policy-limit-rate',
      'quality',
      policyLimitRate,
      thresholds.maximumPolicyLimitRate,
    ),
    maximum(
      'reconciliation-failure-rate',
      'quality',
      reconciliationFailureRate,
      thresholds.maximumReconciliationFailureRate,
    ),
    maximum(
      'artifact-action-failure-rate',
      'quality',
      artifactActionFailureRate,
      thresholds.maximumArtifactActionFailureRate,
    ),
    maximum(
      'integrity-failures',
      'quality',
      evidence.failures.integrity,
      thresholds.maximumIntegrityFailures,
    ),
    maximum(
      'start-latency-p95-ms',
      'quality',
      evidence.latency.startP95Ms,
      thresholds.maximumStartLatencyP95Ms,
    ),
    maximum(
      'reconnect-latency-p95-ms',
      'quality',
      evidence.latency.reconnectP95Ms,
      thresholds.maximumReconnectLatencyP95Ms,
    ),
    ...Object.entries(evidence.qualityGates).map(([id, passed]) =>
      check(id, 'platform', passed, passed, true),
    ),
    ...Object.entries(evidence.humanSignoff).map(([id, passed]) =>
      check(`signoff-${id}`, 'signoff', passed, passed, true),
    ),
  ];
  const sampleReady = categoryPassed(checks, 'sample');
  const qualityReady =
    categoryPassed(checks, 'quality') && categoryPassed(checks, 'platform');
  const signoffReady = categoryPassed(checks, 'signoff');
  const status: CloudTaskReleaseReadinessStatus = !sampleReady
    ? 'collecting'
    : !qualityReady
      ? 'needs-tuning'
      : !signoffReady
        ? 'awaiting-signoff'
        : 'candidate';
  return {
    status,
    ready: status === 'candidate',
    metrics: {
      observationHours,
      evidenceAgeHours,
      finishedExecutions,
      failureRate,
      networkFailureRate,
      resumeFailureRate,
      policyLimitRate,
      reconciliationFailureRate,
      artifactActionFailureRate,
    },
    checks,
  };
}

function categoryPassed(
  checks: CloudTaskReleaseReadinessCheck[],
  category: CloudTaskReleaseReadinessCheck['category'],
): boolean {
  return checks
    .filter((item) => item.category === category)
    .every((item) => item.passed);
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return numerator === 0 ? 0 : 1;
  return numerator / denominator;
}

function minimum(
  id: string,
  category: CloudTaskReleaseReadinessCheck['category'],
  actual: number,
  required: number,
): CloudTaskReleaseReadinessCheck {
  return check(id, category, actual >= required, actual, required);
}

function maximum(
  id: string,
  category: CloudTaskReleaseReadinessCheck['category'],
  actual: number,
  required: number,
): CloudTaskReleaseReadinessCheck {
  return check(id, category, actual <= required, actual, required);
}

function check(
  id: string,
  category: CloudTaskReleaseReadinessCheck['category'],
  passed: boolean,
  actual: number | boolean | string,
  required: number | boolean | string,
): CloudTaskReleaseReadinessCheck {
  return { id, category, passed, actual, required };
}
