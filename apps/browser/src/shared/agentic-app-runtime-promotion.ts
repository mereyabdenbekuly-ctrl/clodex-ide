import { z } from 'zod';
import {
  evaluateAgenticAppRuntimeReadiness,
  type AgenticAppRuntimeEvaluationEvidence,
} from './agentic-app-runtime-evaluation';

export const AGENTIC_APP_RUNTIME_PROMOTION_THRESHOLDS = {
  minimumObservationHours: 72,
  maximumEvidenceAgeHours: 48,
  minimumObservedBuildCount: 2,
  minimumObservedInstallCount: 25,
  minimumPreviewSessions: 25,
  minimumDistinctGeneratedApps: 10,
  minimumCapabilityInvocations: 200,
  minimumPrivilegedFlowCount: 1,
  maximumFailureRate: 0.01,
  maximumSecurityViolationCount: 0,
} as const;

const dogfoodMetricsSchema = z
  .object({
    previewSessions: z.number().int().nonnegative(),
    distinctGeneratedApps: z.number().int().nonnegative(),
    capabilityInvocations: z.number().int().nonnegative(),
    sensitiveApprovals: z.number().int().nonnegative(),
    writeApprovals: z.number().int().nonnegative(),
    asyncOperations: z.number().int().nonnegative(),
    inspectorReviews: z.number().int().nonnegative(),
    packageTrustReviews: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    replayViolations: z.number().int().nonnegative(),
    isolationViolations: z.number().int().nonnegative(),
    secretLeaks: z.number().int().nonnegative(),
    trustBypasses: z.number().int().nonnegative(),
  })
  .strict();

const manualQualityGatesSchema = z
  .object({
    previewLifecyclePassed: z.boolean(),
    ephemeralGrantReloadPassed: z.boolean(),
    sensitiveApprovalPassed: z.boolean(),
    asyncCancelTimeoutPassed: z.boolean(),
    runtimeInspectorPassed: z.boolean(),
    packageTrustReviewPassed: z.boolean(),
  })
  .strict();

export const agenticAppRuntimeDogfoodAggregateSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceChannel: z.literal('prerelease'),
    observationStartedAt: z.string().datetime(),
    observationEndedAt: z.string().datetime(),
    observedBuildCount: z.number().int().nonnegative(),
    observedInstallCount: z.number().int().nonnegative(),
    dogfood: dogfoodMetricsSchema,
  })
  .strict();
export type AgenticAppRuntimeDogfoodAggregate = z.infer<
  typeof agenticAppRuntimeDogfoodAggregateSchema
>;

export const agenticAppRuntimePromotionEvidenceSchema =
  agenticAppRuntimeDogfoodAggregateSchema
    .extend({
      sourceCommitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
      evaluationEvidence: z
        .object({
          runId: z.string().uuid(),
          generatedAt: z.string().datetime(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
      manualQualityGates: manualQualityGatesSchema,
    })
    .strict();
export type AgenticAppRuntimePromotionEvidence = z.infer<
  typeof agenticAppRuntimePromotionEvidenceSchema
>;
export type AgenticAppRuntimeManualQualityGates = z.infer<
  typeof manualQualityGatesSchema
>;

export type AgenticAppRuntimePromotionCheckId =
  | 'valid-observation-window'
  | 'source-commit-matches-build'
  | 'evidence-not-from-future'
  | 'maximum-evidence-age-hours'
  | 'minimum-observation-hours'
  | 'minimum-observed-builds'
  | 'minimum-observed-installs'
  | 'minimum-preview-sessions'
  | 'minimum-distinct-generated-apps'
  | 'minimum-capability-invocations'
  | 'minimum-sensitive-approvals'
  | 'minimum-write-approvals'
  | 'minimum-async-operations'
  | 'minimum-inspector-reviews'
  | 'minimum-package-trust-reviews'
  | 'maximum-failure-rate'
  | 'no-replay-violations'
  | 'no-isolation-violations'
  | 'no-secret-leaks'
  | 'no-trust-bypasses'
  | 'evaluation-evidence-present'
  | 'evaluation-run-id-matches'
  | 'evaluation-generated-at-matches'
  | 'evaluation-sha256-matches'
  | 'evaluation-suite-ready'
  | 'preview-lifecycle-passed'
  | 'ephemeral-grant-reload-passed'
  | 'sensitive-approval-passed'
  | 'async-cancel-timeout-passed'
  | 'runtime-inspector-passed'
  | 'package-trust-review-passed';

export type AgenticAppRuntimePromotionCheck = {
  id: AgenticAppRuntimePromotionCheckId;
  passed: boolean;
  actual: string | number | boolean;
  required: string | number | boolean;
};

export type AgenticAppRuntimePromotionReadiness = {
  ready: boolean;
  checks: AgenticAppRuntimePromotionCheck[];
  metrics: {
    observationHours: number;
    evidenceAgeHours: number;
    failureRate: number;
  };
};

export function parseAgenticAppRuntimeDogfoodAggregate(
  value: unknown,
): AgenticAppRuntimeDogfoodAggregate {
  return agenticAppRuntimeDogfoodAggregateSchema.parse(value);
}

export function parseAgenticAppRuntimePromotionEvidence(
  value: unknown,
): AgenticAppRuntimePromotionEvidence {
  return agenticAppRuntimePromotionEvidenceSchema.parse(value);
}

export function createAgenticAppRuntimePromotionEvidence(options: {
  aggregate: AgenticAppRuntimeDogfoodAggregate;
  sourceCommitSha: string;
  evaluationEvidence: AgenticAppRuntimeEvaluationEvidence;
  evaluationSha256: string;
  manualQualityGates: AgenticAppRuntimeManualQualityGates;
}): AgenticAppRuntimePromotionEvidence {
  return parseAgenticAppRuntimePromotionEvidence({
    ...options.aggregate,
    sourceCommitSha: options.sourceCommitSha,
    evaluationEvidence: {
      runId: options.evaluationEvidence.runId,
      generatedAt: options.evaluationEvidence.generatedAt,
      sha256: options.evaluationSha256,
    },
    manualQualityGates: options.manualQualityGates,
  });
}

export function evaluateAgenticAppRuntimePromotionReadiness(
  evidence: AgenticAppRuntimePromotionEvidence,
  options: {
    now?: Date;
    evaluationEvidence?: AgenticAppRuntimeEvaluationEvidence;
    evaluationSha256?: string;
    buildCommitSha?: string;
  } = {},
): AgenticAppRuntimePromotionReadiness {
  const thresholds = AGENTIC_APP_RUNTIME_PROMOTION_THRESHOLDS;
  const now = (options.now ?? new Date()).getTime();
  const observationStartedAt = parseCanonicalTimestamp(
    evidence.observationStartedAt,
  );
  const observationEndedAt = parseCanonicalTimestamp(
    evidence.observationEndedAt,
  );
  const validObservationWindow =
    Number.isFinite(observationStartedAt) &&
    Number.isFinite(observationEndedAt) &&
    observationEndedAt > observationStartedAt;
  const evidenceNotFromFuture =
    Number.isFinite(observationEndedAt) &&
    observationEndedAt <= now + 5 * 60_000;
  const evidenceAgeHours = Number.isFinite(observationEndedAt)
    ? Math.max(0, (now - observationEndedAt) / 3_600_000)
    : Number.POSITIVE_INFINITY;
  const observationHours = validObservationWindow
    ? (observationEndedAt - observationStartedAt) / 3_600_000
    : 0;
  const failureRate = calculateRate(
    evidence.dogfood.failures,
    evidence.dogfood.capabilityInvocations,
  );
  const evaluationEvidence = options.evaluationEvidence;
  const evaluationReadiness = evaluationEvidence
    ? evaluateAgenticAppRuntimeReadiness(evaluationEvidence, {
        now: options.now,
      })
    : undefined;

  const checks: AgenticAppRuntimePromotionCheck[] = [
    check(
      'source-commit-matches-build',
      options.buildCommitSha === undefined ||
        evidence.sourceCommitSha === options.buildCommitSha,
      evidence.sourceCommitSha,
      options.buildCommitSha ?? evidence.sourceCommitSha,
    ),
    check(
      'valid-observation-window',
      validObservationWindow,
      `${evidence.observationStartedAt}..${evidence.observationEndedAt}`,
      'valid increasing canonical ISO-8601 window',
    ),
    check(
      'evidence-not-from-future',
      evidenceNotFromFuture,
      evidence.observationEndedAt,
      'not more than 5 minutes in the future',
    ),
    check(
      'maximum-evidence-age-hours',
      evidenceAgeHours <= thresholds.maximumEvidenceAgeHours,
      evidenceAgeHours,
      thresholds.maximumEvidenceAgeHours,
    ),
    check(
      'minimum-observation-hours',
      observationHours >= thresholds.minimumObservationHours,
      observationHours,
      thresholds.minimumObservationHours,
    ),
    check(
      'minimum-observed-builds',
      evidence.observedBuildCount >= thresholds.minimumObservedBuildCount,
      evidence.observedBuildCount,
      thresholds.minimumObservedBuildCount,
    ),
    check(
      'minimum-observed-installs',
      evidence.observedInstallCount >= thresholds.minimumObservedInstallCount,
      evidence.observedInstallCount,
      thresholds.minimumObservedInstallCount,
    ),
    countCheck(
      'minimum-preview-sessions',
      evidence.dogfood.previewSessions,
      thresholds.minimumPreviewSessions,
    ),
    countCheck(
      'minimum-distinct-generated-apps',
      evidence.dogfood.distinctGeneratedApps,
      thresholds.minimumDistinctGeneratedApps,
    ),
    countCheck(
      'minimum-capability-invocations',
      evidence.dogfood.capabilityInvocations,
      thresholds.minimumCapabilityInvocations,
    ),
    countCheck(
      'minimum-sensitive-approvals',
      evidence.dogfood.sensitiveApprovals,
      thresholds.minimumPrivilegedFlowCount,
    ),
    countCheck(
      'minimum-write-approvals',
      evidence.dogfood.writeApprovals,
      thresholds.minimumPrivilegedFlowCount,
    ),
    countCheck(
      'minimum-async-operations',
      evidence.dogfood.asyncOperations,
      thresholds.minimumPrivilegedFlowCount,
    ),
    countCheck(
      'minimum-inspector-reviews',
      evidence.dogfood.inspectorReviews,
      thresholds.minimumPrivilegedFlowCount,
    ),
    countCheck(
      'minimum-package-trust-reviews',
      evidence.dogfood.packageTrustReviews,
      thresholds.minimumPrivilegedFlowCount,
    ),
    check(
      'maximum-failure-rate',
      failureRate <= thresholds.maximumFailureRate,
      failureRate,
      thresholds.maximumFailureRate,
    ),
    zeroCheck('no-replay-violations', evidence.dogfood.replayViolations),
    zeroCheck('no-isolation-violations', evidence.dogfood.isolationViolations),
    zeroCheck('no-secret-leaks', evidence.dogfood.secretLeaks),
    zeroCheck('no-trust-bypasses', evidence.dogfood.trustBypasses),
    check(
      'evaluation-evidence-present',
      evaluationEvidence !== undefined,
      evaluationEvidence !== undefined,
      true,
    ),
    check(
      'evaluation-run-id-matches',
      evaluationEvidence?.runId === evidence.evaluationEvidence.runId,
      evaluationEvidence?.runId ?? 'missing',
      evidence.evaluationEvidence.runId,
    ),
    check(
      'evaluation-generated-at-matches',
      evaluationEvidence?.generatedAt ===
        evidence.evaluationEvidence.generatedAt,
      evaluationEvidence?.generatedAt ?? 'missing',
      evidence.evaluationEvidence.generatedAt,
    ),
    check(
      'evaluation-sha256-matches',
      options.evaluationSha256 === evidence.evaluationEvidence.sha256,
      options.evaluationSha256 ?? 'missing',
      evidence.evaluationEvidence.sha256,
    ),
    check(
      'evaluation-suite-ready',
      evaluationReadiness?.ready === true,
      evaluationReadiness?.ready ?? false,
      true,
    ),
    booleanCheck(
      'preview-lifecycle-passed',
      evidence.manualQualityGates.previewLifecyclePassed,
    ),
    booleanCheck(
      'ephemeral-grant-reload-passed',
      evidence.manualQualityGates.ephemeralGrantReloadPassed,
    ),
    booleanCheck(
      'sensitive-approval-passed',
      evidence.manualQualityGates.sensitiveApprovalPassed,
    ),
    booleanCheck(
      'async-cancel-timeout-passed',
      evidence.manualQualityGates.asyncCancelTimeoutPassed,
    ),
    booleanCheck(
      'runtime-inspector-passed',
      evidence.manualQualityGates.runtimeInspectorPassed,
    ),
    booleanCheck(
      'package-trust-review-passed',
      evidence.manualQualityGates.packageTrustReviewPassed,
    ),
  ];

  return {
    ready: checks.every((item) => item.passed),
    checks,
    metrics: {
      observationHours,
      evidenceAgeHours,
      failureRate,
    },
  };
}

function parseCanonicalTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return Number.NaN;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : Number.NaN;
}

function calculateRate(count: number, total: number): number {
  if (total === 0) return count === 0 ? 0 : 1;
  return count / total;
}

function countCheck(
  id: AgenticAppRuntimePromotionCheckId,
  actual: number,
  required: number,
): AgenticAppRuntimePromotionCheck {
  return check(id, actual >= required, actual, required);
}

function zeroCheck(
  id: AgenticAppRuntimePromotionCheckId,
  actual: number,
): AgenticAppRuntimePromotionCheck {
  return check(id, actual === 0, actual, 0);
}

function booleanCheck(
  id: AgenticAppRuntimePromotionCheckId,
  actual: boolean,
): AgenticAppRuntimePromotionCheck {
  return check(id, actual, actual, true);
}

function check(
  id: AgenticAppRuntimePromotionCheckId,
  passed: boolean,
  actual: string | number | boolean,
  required: string | number | boolean,
): AgenticAppRuntimePromotionCheck {
  return { id, passed, actual, required };
}
