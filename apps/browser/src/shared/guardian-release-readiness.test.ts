import { describe, expect, it } from 'vitest';
import {
  createGuardianPolicyCohort,
  guardianDogfoodStateSchema,
  guardianShadowMetricsSchema,
} from './guardian';
import {
  evaluateGuardianReleaseReadiness,
  evaluateGuardianShadowReadiness,
  GUARDIAN_RELEASE_THRESHOLDS,
  GUARDIAN_SHADOW_READINESS_THRESHOLDS,
} from './guardian-release-readiness';

function createReadyState() {
  const state = guardianDogfoodStateSchema.parse({});
  const cohort = createGuardianPolicyCohort(1, 100);
  cohort.lastAssessmentAt = 200;
  cohort.distribution.total = 500;
  cohort.feedback = {
    labeled: 250,
    correct: 233,
    falsePositive: 15,
    falseNegative: 2,
  };
  cohort.feedbackByDecision.approve = {
    labeled: 100,
    correct: 98,
    falsePositive: 0,
    falseNegative: 2,
  };
  cohort.feedbackByDecision.deny = {
    labeled: 50,
    correct: 45,
    falsePositive: 5,
    falseNegative: 0,
  };
  cohort.feedbackByDecision.escalate = {
    labeled: 100,
    correct: 90,
    falsePositive: 10,
    falseNegative: 0,
  };
  cohort.feedbackByKind.shell.labeled = 100;
  cohort.feedbackByKind.network.labeled = 50;
  cohort.feedbackByKind.mcp.labeled = 50;
  cohort.feedbackByKind.sandbox.labeled = 50;
  state.policyCohorts['1'] = cohort;
  state.policyCohortsInitialized = true;
  return state;
}

describe('evaluateGuardianReleaseReadiness', () => {
  it('starts in collecting state without a representative sample', () => {
    const readiness = evaluateGuardianReleaseReadiness(
      guardianDogfoodStateSchema.parse({}),
    );

    expect(readiness).toMatchObject({
      status: 'collecting',
      assessments: 0,
      labeled: 0,
      falsePositiveRate: null,
      falseNegativeRate: null,
    });
  });

  it('accepts the documented thresholds inclusively', () => {
    const readiness = evaluateGuardianReleaseReadiness(createReadyState());

    expect(readiness.status).toBe('candidate');
    expect(readiness.labelCoverage).toBe(0.5);
    expect(readiness.falsePositiveRate).toBe(
      GUARDIAN_RELEASE_THRESHOLDS.maximumFalsePositiveRate,
    );
    expect(readiness.falseNegativeRate).toBe(
      GUARDIAN_RELEASE_THRESHOLDS.maximumFalseNegativeRate,
    );
    expect(readiness.checks.every((check) => check.passed)).toBe(true);
  });

  it('requires representative coverage for every action kind', () => {
    const state = createReadyState();
    state.policyCohorts['1']!.feedbackByKind.sandbox.labeled = 29;

    const readiness = evaluateGuardianReleaseReadiness(state);

    expect(readiness.status).toBe('collecting');
    expect(
      readiness.checks.find((check) => check.id === 'kind-sandbox'),
    ).toMatchObject({ passed: false, actual: 29, target: 30 });
  });

  it('requires enough reviewed approvals and restrictive decisions', () => {
    const state = createReadyState();
    state.policyCohorts['1']!.feedbackByDecision.approve.labeled = 99;

    const readiness = evaluateGuardianReleaseReadiness(state);

    expect(readiness.status).toBe('collecting');
    expect(
      readiness.checks.find((check) => check.id === 'approved-labeled'),
    ).toMatchObject({ passed: false, actual: 99, target: 100 });
  });

  it('recommends tuning after sample gates pass but an error rate is too high', () => {
    const state = createReadyState();
    state.policyCohorts['1']!.feedbackByDecision.approve.falseNegative = 3;

    const readiness = evaluateGuardianReleaseReadiness(state);

    expect(readiness.status).toBe('needs-tuning');
    expect(readiness.falseNegativeRate).toBe(0.03);
    expect(
      readiness.checks.find((check) => check.id === 'false-negative-rate'),
    ).toMatchObject({ passed: false });
  });
});

describe('evaluateGuardianShadowReadiness', () => {
  it('collects observations before scoring the shadow classifier', () => {
    const readiness = evaluateGuardianShadowReadiness(
      guardianShadowMetricsSchema.parse({}),
    );

    expect(readiness).toMatchObject({
      status: 'collecting',
      total: 0,
      successRate: null,
      riskAgreementRate: null,
      decisionAgreementRate: null,
      averageLatencyMs: null,
    });
  });

  it('accepts the documented shadow thresholds inclusively', () => {
    const readiness = evaluateGuardianShadowReadiness(
      guardianShadowMetricsSchema.parse({
        total: 100,
        success: 95,
        failure: 5,
        riskAgreement: 85,
        decisionAgreement: 90,
        criticalRiskDisagreements: 0,
        totalLatencyMs: 2_500,
        lastAssessmentAt: 300,
      }),
    );

    expect(readiness).toMatchObject({
      status: 'candidate',
      successRate: GUARDIAN_SHADOW_READINESS_THRESHOLDS.minimumSuccessRate,
      riskAgreementRate:
        GUARDIAN_SHADOW_READINESS_THRESHOLDS.minimumRiskAgreementRate,
      decisionAgreementRate:
        GUARDIAN_SHADOW_READINESS_THRESHOLDS.minimumDecisionAgreementRate,
      averageLatencyMs: 25,
      lastAssessmentAt: 300,
    });
    expect(readiness.checks.every((check) => check.passed)).toBe(true);
  });

  it('requires tuning for disagreement or critical-risk underclassification', () => {
    const readiness = evaluateGuardianShadowReadiness(
      guardianShadowMetricsSchema.parse({
        total: 100,
        success: 95,
        failure: 5,
        riskAgreement: 84,
        decisionAgreement: 90,
        criticalRiskDisagreements: 1,
      }),
    );

    expect(readiness.status).toBe('needs-tuning');
    expect(
      readiness.checks.find((check) => check.id === 'risk-agreement-rate'),
    ).toMatchObject({ passed: false, actual: 0.84 });
    expect(
      readiness.checks.find(
        (check) => check.id === 'critical-risk-disagreements',
      ),
    ).toMatchObject({ passed: false, actual: 1, target: 0 });
  });
});
