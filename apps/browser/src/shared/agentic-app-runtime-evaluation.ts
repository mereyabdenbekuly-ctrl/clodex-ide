import { z } from 'zod';

export const AGENTIC_APP_RUNTIME_EVALUATION_THRESHOLDS = {
  maximumEvidenceAgeHours: 24,
  minimumScenarioCount: 7,
  minimumRevokeLatencySamples: 25,
  maximumScenarioFailureRate: 0,
  maximumReplayAcceptanceRate: 0,
  maximumCrossPrincipalLeakRate: 0,
  maximumSecretLeakRate: 0,
  maximumPackageTrustBypassRate: 0,
  maximumGrantRevokeP95Ms: 100,
  maximumGrantRevokeMaxMs: 250,
} as const;

export const agenticAppRuntimeEvaluationScenarioIdSchema = z.enum([
  'session-replay',
  'one-time-commit',
  'cross-principal-isolation',
  'grant-revoke-latency',
  'credential-egress',
  'package-trust',
  'runtime-inspector-content-free',
]);
export type AgenticAppRuntimeEvaluationScenarioId = z.infer<
  typeof agenticAppRuntimeEvaluationScenarioIdSchema
>;

const scenarioSchema = z
  .object({
    id: agenticAppRuntimeEvaluationScenarioIdSchema,
    passed: z.boolean(),
    durationMs: z.number().nonnegative(),
    assertionCount: z.number().int().nonnegative(),
    failureCode: z.string().min(1).max(128).nullable(),
  })
  .strict()
  .superRefine((scenario, context) => {
    if (scenario.passed && scenario.failureCode !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Passed scenarios cannot include a failure code',
        path: ['failureCode'],
      });
    }
    if (!scenario.passed && scenario.failureCode === null) {
      context.addIssue({
        code: 'custom',
        message: 'Failed scenarios require a bounded failure code',
        path: ['failureCode'],
      });
    }
  });

const countMetricSchema = z
  .object({
    attempts: z.number().int().nonnegative(),
    violations: z.number().int().nonnegative(),
  })
  .strict();

const latencyMetricSchema = z
  .object({
    samples: z.number().int().nonnegative(),
    p50Ms: z.number().nonnegative(),
    p95Ms: z.number().nonnegative(),
    maxMs: z.number().nonnegative(),
  })
  .strict();

export const agenticAppRuntimeEvaluationEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    generatedAt: z.string().datetime(),
    source: z.literal('deterministic-local-harness'),
    scenarios: z.array(scenarioSchema).min(1).max(100),
    metrics: z
      .object({
        replay: countMetricSchema,
        crossPrincipalIsolation: countMetricSchema,
        secretEgress: countMetricSchema,
        packageTrust: countMetricSchema,
        grantRevokeLatency: latencyMetricSchema,
      })
      .strict(),
    qualityGates: z
      .object({
        reportContentFree: z.boolean(),
        auditContentFree: z.boolean(),
        inspectorContentFree: z.boolean(),
        packageRevocationFailClosed: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type AgenticAppRuntimeEvaluationEvidence = z.infer<
  typeof agenticAppRuntimeEvaluationEvidenceSchema
>;

export type AgenticAppRuntimeEvaluationCheckId =
  | 'evidence-not-from-future'
  | 'maximum-evidence-age-hours'
  | 'minimum-scenario-count'
  | 'all-required-scenarios-present'
  | 'unique-scenario-ids'
  | 'maximum-scenario-failure-rate'
  | 'maximum-replay-acceptance-rate'
  | 'maximum-cross-principal-leak-rate'
  | 'maximum-secret-leak-rate'
  | 'maximum-package-trust-bypass-rate'
  | 'minimum-revoke-latency-samples'
  | 'maximum-grant-revoke-p95-ms'
  | 'maximum-grant-revoke-max-ms'
  | 'report-content-free'
  | 'audit-content-free'
  | 'inspector-content-free'
  | 'package-revocation-fail-closed';

export type AgenticAppRuntimeEvaluationCheck = {
  id: AgenticAppRuntimeEvaluationCheckId;
  passed: boolean;
  actual: string | number | boolean;
  required: string | number | boolean;
};

export type AgenticAppRuntimeEvaluationReadiness = {
  ready: boolean;
  checks: AgenticAppRuntimeEvaluationCheck[];
  metrics: {
    evidenceAgeHours: number;
    scenarioFailureRate: number;
    replayAcceptanceRate: number;
    crossPrincipalLeakRate: number;
    secretLeakRate: number;
    packageTrustBypassRate: number;
  };
};

const REQUIRED_SCENARIOS = agenticAppRuntimeEvaluationScenarioIdSchema.options;

export function parseAgenticAppRuntimeEvaluationEvidence(
  value: unknown,
): AgenticAppRuntimeEvaluationEvidence {
  return agenticAppRuntimeEvaluationEvidenceSchema.parse(value);
}

export function evaluateAgenticAppRuntimeReadiness(
  evidence: AgenticAppRuntimeEvaluationEvidence,
  options: { now?: Date } = {},
): AgenticAppRuntimeEvaluationReadiness {
  const thresholds = AGENTIC_APP_RUNTIME_EVALUATION_THRESHOLDS;
  const now = (options.now ?? new Date()).getTime();
  const generatedAt = Date.parse(evidence.generatedAt);
  const evidenceAgeHours = Number.isFinite(generatedAt)
    ? Math.max(0, (now - generatedAt) / 3_600_000)
    : Number.POSITIVE_INFINITY;
  const evidenceNotFromFuture =
    Number.isFinite(generatedAt) && generatedAt <= now + 5 * 60_000;
  const scenarioFailures = evidence.scenarios.filter(
    (scenario) => !scenario.passed,
  ).length;
  const scenarioFailureRate = calculateRate(
    scenarioFailures,
    evidence.scenarios.length,
  );
  const replayAcceptanceRate = calculateRate(
    evidence.metrics.replay.violations,
    evidence.metrics.replay.attempts,
  );
  const crossPrincipalLeakRate = calculateRate(
    evidence.metrics.crossPrincipalIsolation.violations,
    evidence.metrics.crossPrincipalIsolation.attempts,
  );
  const secretLeakRate = calculateRate(
    evidence.metrics.secretEgress.violations,
    evidence.metrics.secretEgress.attempts,
  );
  const packageTrustBypassRate = calculateRate(
    evidence.metrics.packageTrust.violations,
    evidence.metrics.packageTrust.attempts,
  );
  const scenarioIds = new Set(
    evidence.scenarios.map((scenario) => scenario.id),
  );
  const missingScenarios = REQUIRED_SCENARIOS.filter(
    (scenario) => !scenarioIds.has(scenario),
  );
  const duplicateScenarioCount = evidence.scenarios.length - scenarioIds.size;

  const checks: AgenticAppRuntimeEvaluationCheck[] = [
    check(
      'evidence-not-from-future',
      evidenceNotFromFuture,
      evidence.generatedAt,
      'not more than 5 minutes in the future',
    ),
    check(
      'maximum-evidence-age-hours',
      evidenceAgeHours <= thresholds.maximumEvidenceAgeHours,
      evidenceAgeHours,
      thresholds.maximumEvidenceAgeHours,
    ),
    check(
      'minimum-scenario-count',
      evidence.scenarios.length >= thresholds.minimumScenarioCount,
      evidence.scenarios.length,
      thresholds.minimumScenarioCount,
    ),
    check(
      'all-required-scenarios-present',
      missingScenarios.length === 0,
      missingScenarios.length === 0 ? 'all' : missingScenarios.join(','),
      'all',
    ),
    check(
      'unique-scenario-ids',
      duplicateScenarioCount === 0,
      duplicateScenarioCount,
      0,
    ),
    check(
      'maximum-scenario-failure-rate',
      scenarioFailureRate <= thresholds.maximumScenarioFailureRate,
      scenarioFailureRate,
      thresholds.maximumScenarioFailureRate,
    ),
    check(
      'maximum-replay-acceptance-rate',
      replayAcceptanceRate <= thresholds.maximumReplayAcceptanceRate,
      replayAcceptanceRate,
      thresholds.maximumReplayAcceptanceRate,
    ),
    check(
      'maximum-cross-principal-leak-rate',
      crossPrincipalLeakRate <= thresholds.maximumCrossPrincipalLeakRate,
      crossPrincipalLeakRate,
      thresholds.maximumCrossPrincipalLeakRate,
    ),
    check(
      'maximum-secret-leak-rate',
      secretLeakRate <= thresholds.maximumSecretLeakRate,
      secretLeakRate,
      thresholds.maximumSecretLeakRate,
    ),
    check(
      'maximum-package-trust-bypass-rate',
      packageTrustBypassRate <= thresholds.maximumPackageTrustBypassRate,
      packageTrustBypassRate,
      thresholds.maximumPackageTrustBypassRate,
    ),
    check(
      'minimum-revoke-latency-samples',
      evidence.metrics.grantRevokeLatency.samples >=
        thresholds.minimumRevokeLatencySamples,
      evidence.metrics.grantRevokeLatency.samples,
      thresholds.minimumRevokeLatencySamples,
    ),
    check(
      'maximum-grant-revoke-p95-ms',
      evidence.metrics.grantRevokeLatency.p95Ms <=
        thresholds.maximumGrantRevokeP95Ms,
      evidence.metrics.grantRevokeLatency.p95Ms,
      thresholds.maximumGrantRevokeP95Ms,
    ),
    check(
      'maximum-grant-revoke-max-ms',
      evidence.metrics.grantRevokeLatency.maxMs <=
        thresholds.maximumGrantRevokeMaxMs,
      evidence.metrics.grantRevokeLatency.maxMs,
      thresholds.maximumGrantRevokeMaxMs,
    ),
    check(
      'report-content-free',
      evidence.qualityGates.reportContentFree,
      evidence.qualityGates.reportContentFree,
      true,
    ),
    check(
      'audit-content-free',
      evidence.qualityGates.auditContentFree,
      evidence.qualityGates.auditContentFree,
      true,
    ),
    check(
      'inspector-content-free',
      evidence.qualityGates.inspectorContentFree,
      evidence.qualityGates.inspectorContentFree,
      true,
    ),
    check(
      'package-revocation-fail-closed',
      evidence.qualityGates.packageRevocationFailClosed,
      evidence.qualityGates.packageRevocationFailClosed,
      true,
    ),
  ];

  return {
    ready: checks.every((item) => item.passed),
    checks,
    metrics: {
      evidenceAgeHours,
      scenarioFailureRate,
      replayAcceptanceRate,
      crossPrincipalLeakRate,
      secretLeakRate,
      packageTrustBypassRate,
    },
  };
}

function calculateRate(violations: number, attempts: number): number {
  if (attempts === 0) return violations === 0 ? 0 : 1;
  return violations / attempts;
}

function check(
  id: AgenticAppRuntimeEvaluationCheckId,
  passed: boolean,
  actual: string | number | boolean,
  required: string | number | boolean,
): AgenticAppRuntimeEvaluationCheck {
  return { id, passed, actual, required };
}
