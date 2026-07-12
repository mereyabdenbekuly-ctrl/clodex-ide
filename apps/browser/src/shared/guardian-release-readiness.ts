import {
  GUARDIAN_POLICY_VERSION,
  type GuardianActionKind,
  type GuardianDogfoodState,
  type GuardianPolicyCohort,
  type GuardianShadowMetrics,
} from './guardian';

export const GUARDIAN_RELEASE_THRESHOLDS = {
  minimumLabeled: 250,
  minimumLabelCoverage: 0.3,
  minimumLabeledPerKind: 30,
  minimumApprovedLabeled: 100,
  minimumRestrictedLabeled: 100,
  maximumFalsePositiveRate: 0.1,
  maximumFalseNegativeRate: 0.02,
} as const;

export const GUARDIAN_SHADOW_READINESS_THRESHOLDS = {
  minimumObservations: 100,
  minimumSuccessRate: 0.95,
  minimumRiskAgreementRate: 0.85,
  minimumDecisionAgreementRate: 0.9,
  maximumCriticalRiskDisagreements: 0,
} as const;

export type GuardianReleaseReadinessStatus =
  | 'collecting'
  | 'needs-tuning'
  | 'candidate';

export type GuardianReleaseReadinessCheck = {
  id:
    | 'total-labeled'
    | 'label-coverage'
    | 'approved-labeled'
    | 'restricted-labeled'
    | `kind-${GuardianActionKind}`
    | 'false-positive-rate'
    | 'false-negative-rate';
  category: 'sample' | 'quality';
  label: string;
  actual: number;
  target: number;
  operator: 'minimum' | 'maximum';
  unit: 'count' | 'rate';
  passed: boolean;
};

export type GuardianReleaseReadiness = {
  policyVersion: number;
  status: GuardianReleaseReadinessStatus;
  startedAt: number | null;
  lastAssessmentAt: number | null;
  assessments: number;
  labeled: number;
  labelCoverage: number;
  approvedLabeled: number;
  restrictedLabeled: number;
  falsePositive: number;
  falseNegative: number;
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
  labeledByKind: Record<GuardianActionKind, number>;
  checks: GuardianReleaseReadinessCheck[];
};

export type GuardianShadowReadinessCheck = {
  id:
    | 'total-observations'
    | 'success-rate'
    | 'risk-agreement-rate'
    | 'decision-agreement-rate'
    | 'critical-risk-disagreements';
  category: 'sample' | 'quality';
  label: string;
  actual: number;
  target: number;
  operator: 'minimum' | 'maximum';
  unit: 'count' | 'rate';
  passed: boolean;
};

export type GuardianShadowReadiness = {
  status: GuardianReleaseReadinessStatus;
  total: number;
  success: number;
  failure: number;
  successRate: number | null;
  riskAgreement: number;
  riskAgreementRate: number | null;
  decisionAgreement: number;
  decisionAgreementRate: number | null;
  criticalRiskDisagreements: number;
  averageLatencyMs: number | null;
  lastAssessmentAt: number | null;
  checks: GuardianShadowReadinessCheck[];
};

const ACTION_KINDS: readonly GuardianActionKind[] = [
  'shell',
  'network',
  'mcp',
  'sandbox',
];

export function evaluateGuardianReleaseReadiness(
  state: GuardianDogfoodState,
  policyVersion = GUARDIAN_POLICY_VERSION,
): GuardianReleaseReadiness {
  const cohort = state.policyCohorts[String(policyVersion)];
  const assessments = cohort?.distribution.total ?? 0;
  const labeled = cohort?.feedback.labeled ?? 0;
  const approvedLabeled = cohort?.feedbackByDecision.approve.labeled ?? 0;
  const restrictedLabeled =
    (cohort?.feedbackByDecision.deny.labeled ?? 0) +
    (cohort?.feedbackByDecision.escalate.labeled ?? 0);
  const falsePositive =
    (cohort?.feedbackByDecision.deny.falsePositive ?? 0) +
    (cohort?.feedbackByDecision.escalate.falsePositive ?? 0);
  const falseNegative = cohort?.feedbackByDecision.approve.falseNegative ?? 0;
  const labelCoverage = assessments === 0 ? 0 : labeled / assessments;
  const falsePositiveRate =
    restrictedLabeled === 0 ? null : falsePositive / restrictedLabeled;
  const falseNegativeRate =
    approvedLabeled === 0 ? null : falseNegative / approvedLabeled;
  const labeledByKind = createLabeledByKind(cohort);

  const checks: GuardianReleaseReadinessCheck[] = [
    createCheck({
      id: 'total-labeled',
      category: 'sample',
      label: 'Total reviewed decisions',
      actual: labeled,
      target: GUARDIAN_RELEASE_THRESHOLDS.minimumLabeled,
      operator: 'minimum',
      unit: 'count',
    }),
    createCheck({
      id: 'label-coverage',
      category: 'sample',
      label: 'Label coverage',
      actual: labelCoverage,
      target: GUARDIAN_RELEASE_THRESHOLDS.minimumLabelCoverage,
      operator: 'minimum',
      unit: 'rate',
    }),
    createCheck({
      id: 'approved-labeled',
      category: 'sample',
      label: 'Reviewed approvals',
      actual: approvedLabeled,
      target: GUARDIAN_RELEASE_THRESHOLDS.minimumApprovedLabeled,
      operator: 'minimum',
      unit: 'count',
    }),
    createCheck({
      id: 'restricted-labeled',
      category: 'sample',
      label: 'Reviewed escalations/denials',
      actual: restrictedLabeled,
      target: GUARDIAN_RELEASE_THRESHOLDS.minimumRestrictedLabeled,
      operator: 'minimum',
      unit: 'count',
    }),
    ...ACTION_KINDS.map((kind) =>
      createCheck({
        id: `kind-${kind}` as const,
        category: 'sample' as const,
        label: `Reviewed ${kind} decisions`,
        actual: labeledByKind[kind],
        target: GUARDIAN_RELEASE_THRESHOLDS.minimumLabeledPerKind,
        operator: 'minimum' as const,
        unit: 'count' as const,
      }),
    ),
    createCheck({
      id: 'false-positive-rate',
      category: 'quality',
      label: 'False-positive rate',
      actual: falsePositiveRate ?? 1,
      target: GUARDIAN_RELEASE_THRESHOLDS.maximumFalsePositiveRate,
      operator: 'maximum',
      unit: 'rate',
    }),
    createCheck({
      id: 'false-negative-rate',
      category: 'quality',
      label: 'False-negative rate',
      actual: falseNegativeRate ?? 1,
      target: GUARDIAN_RELEASE_THRESHOLDS.maximumFalseNegativeRate,
      operator: 'maximum',
      unit: 'rate',
    }),
  ];

  const sampleReady = checks
    .filter((check) => check.category === 'sample')
    .every((check) => check.passed);
  const qualityReady = checks
    .filter((check) => check.category === 'quality')
    .every((check) => check.passed);

  return {
    policyVersion,
    status: !sampleReady
      ? 'collecting'
      : qualityReady
        ? 'candidate'
        : 'needs-tuning',
    startedAt: cohort?.startedAt ?? null,
    lastAssessmentAt: cohort?.lastAssessmentAt ?? null,
    assessments,
    labeled,
    labelCoverage,
    approvedLabeled,
    restrictedLabeled,
    falsePositive,
    falseNegative,
    falsePositiveRate,
    falseNegativeRate,
    labeledByKind,
    checks,
  };
}

/**
 * Scores the non-authoritative model classifier as an end-to-end shadow path.
 * Failed classifications therefore count against both availability and
 * agreement rates, while deterministic authorization remains unchanged.
 */
export function evaluateGuardianShadowReadiness(
  metrics: GuardianShadowMetrics,
): GuardianShadowReadiness {
  const successRate =
    metrics.total === 0 ? null : metrics.success / metrics.total;
  const riskAgreementRate =
    metrics.total === 0 ? null : metrics.riskAgreement / metrics.total;
  const decisionAgreementRate =
    metrics.total === 0 ? null : metrics.decisionAgreement / metrics.total;
  const averageLatencyMs =
    metrics.total === 0 ? null : metrics.totalLatencyMs / metrics.total;
  const checks: GuardianShadowReadinessCheck[] = [
    createShadowCheck({
      id: 'total-observations',
      category: 'sample',
      label: 'Shadow observations',
      actual: metrics.total,
      target: GUARDIAN_SHADOW_READINESS_THRESHOLDS.minimumObservations,
      operator: 'minimum',
      unit: 'count',
    }),
    createShadowCheck({
      id: 'success-rate',
      category: 'quality',
      label: 'Shadow classifier success rate',
      actual: successRate ?? 0,
      target: GUARDIAN_SHADOW_READINESS_THRESHOLDS.minimumSuccessRate,
      operator: 'minimum',
      unit: 'rate',
    }),
    createShadowCheck({
      id: 'risk-agreement-rate',
      category: 'quality',
      label: 'Risk agreement rate',
      actual: riskAgreementRate ?? 0,
      target: GUARDIAN_SHADOW_READINESS_THRESHOLDS.minimumRiskAgreementRate,
      operator: 'minimum',
      unit: 'rate',
    }),
    createShadowCheck({
      id: 'decision-agreement-rate',
      category: 'quality',
      label: 'Decision agreement rate',
      actual: decisionAgreementRate ?? 0,
      target: GUARDIAN_SHADOW_READINESS_THRESHOLDS.minimumDecisionAgreementRate,
      operator: 'minimum',
      unit: 'rate',
    }),
    createShadowCheck({
      id: 'critical-risk-disagreements',
      category: 'quality',
      label: 'Critical-risk underclassification',
      actual: metrics.criticalRiskDisagreements,
      target:
        GUARDIAN_SHADOW_READINESS_THRESHOLDS.maximumCriticalRiskDisagreements,
      operator: 'maximum',
      unit: 'count',
    }),
  ];
  const sampleReady = checks
    .filter((check) => check.category === 'sample')
    .every((check) => check.passed);
  const qualityReady = checks
    .filter((check) => check.category === 'quality')
    .every((check) => check.passed);

  return {
    status: !sampleReady
      ? 'collecting'
      : qualityReady
        ? 'candidate'
        : 'needs-tuning',
    total: metrics.total,
    success: metrics.success,
    failure: metrics.failure,
    successRate,
    riskAgreement: metrics.riskAgreement,
    riskAgreementRate,
    decisionAgreement: metrics.decisionAgreement,
    decisionAgreementRate,
    criticalRiskDisagreements: metrics.criticalRiskDisagreements,
    averageLatencyMs,
    lastAssessmentAt: metrics.lastAssessmentAt,
    checks,
  };
}

function createLabeledByKind(
  cohort: GuardianPolicyCohort | undefined,
): Record<GuardianActionKind, number> {
  return {
    shell: cohort?.feedbackByKind.shell.labeled ?? 0,
    network: cohort?.feedbackByKind.network.labeled ?? 0,
    mcp: cohort?.feedbackByKind.mcp.labeled ?? 0,
    sandbox: cohort?.feedbackByKind.sandbox.labeled ?? 0,
  };
}

function createCheck(
  input: Omit<GuardianReleaseReadinessCheck, 'passed'>,
): GuardianReleaseReadinessCheck {
  return {
    ...input,
    passed:
      input.operator === 'minimum'
        ? input.actual >= input.target
        : input.actual <= input.target,
  };
}

function createShadowCheck(
  input: Omit<GuardianShadowReadinessCheck, 'passed'>,
): GuardianShadowReadinessCheck {
  return {
    ...input,
    passed:
      input.operator === 'minimum'
        ? input.actual >= input.target
        : input.actual <= input.target,
  };
}
