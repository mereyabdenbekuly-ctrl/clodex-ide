import { describe, expect, it } from 'vitest';
import type { AgenticAppRuntimeEvaluationEvidence } from './agentic-app-runtime-evaluation';
import {
  createAgenticAppRuntimePromotionEvidence,
  evaluateAgenticAppRuntimePromotionReadiness,
  parseAgenticAppRuntimeDogfoodAggregate,
  parseAgenticAppRuntimePromotionEvidence,
  type AgenticAppRuntimeDogfoodAggregate,
  type AgenticAppRuntimeManualQualityGates,
} from './agentic-app-runtime-promotion';

const evaluationEvidence: AgenticAppRuntimeEvaluationEvidence = {
  schemaVersion: 1,
  runId: '7d8889b6-0a8f-4ef8-a239-6ce544ce52a4',
  generatedAt: '2026-07-05T00:00:00.000Z',
  source: 'deterministic-local-harness',
  scenarios: [
    'session-replay',
    'one-time-commit',
    'cross-principal-isolation',
    'grant-revoke-latency',
    'credential-egress',
    'package-trust',
    'runtime-inspector-content-free',
  ].map((id) => ({
    id: id as AgenticAppRuntimeEvaluationEvidence['scenarios'][number]['id'],
    passed: true,
    durationMs: 1,
    assertionCount: 1,
    failureCode: null,
  })),
  metrics: {
    replay: { attempts: 1, violations: 0 },
    crossPrincipalIsolation: { attempts: 2, violations: 0 },
    secretEgress: { attempts: 4, violations: 0 },
    packageTrust: { attempts: 4, violations: 0 },
    grantRevokeLatency: {
      samples: 25,
      p50Ms: 1,
      p95Ms: 2,
      maxMs: 3,
    },
  },
  qualityGates: {
    reportContentFree: true,
    auditContentFree: true,
    inspectorContentFree: true,
    packageRevocationFailClosed: true,
  },
};

const aggregate: AgenticAppRuntimeDogfoodAggregate = {
  schemaVersion: 1,
  sourceChannel: 'prerelease',
  observationStartedAt: '2026-07-01T00:00:00.000Z',
  observationEndedAt: '2026-07-05T00:00:00.000Z',
  observedBuildCount: 3,
  observedInstallCount: 30,
  dogfood: {
    previewSessions: 30,
    distinctGeneratedApps: 12,
    capabilityInvocations: 250,
    sensitiveApprovals: 5,
    writeApprovals: 5,
    asyncOperations: 10,
    inspectorReviews: 5,
    packageTrustReviews: 3,
    failures: 1,
    replayViolations: 0,
    isolationViolations: 0,
    secretLeaks: 0,
    trustBypasses: 0,
  },
};

const manualQualityGates: AgenticAppRuntimeManualQualityGates = {
  previewLifecyclePassed: true,
  ephemeralGrantReloadPassed: true,
  sensitiveApprovalPassed: true,
  asyncCancelTimeoutPassed: true,
  runtimeInspectorPassed: true,
  packageTrustReviewPassed: true,
};

const evaluationSha256 = 'a'.repeat(64);
const sourceCommitSha = 'b'.repeat(40);

describe('Agentic App Runtime promotion evidence', () => {
  it('accepts sufficient dogfood linked to fresh deterministic evidence', () => {
    const evidence = createAgenticAppRuntimePromotionEvidence({
      aggregate,
      sourceCommitSha,
      evaluationEvidence,
      evaluationSha256,
      manualQualityGates,
    });
    const readiness = evaluateAgenticAppRuntimePromotionReadiness(evidence, {
      now: new Date('2026-07-05T12:00:00.000Z'),
      evaluationEvidence,
      evaluationSha256,
      buildCommitSha: sourceCommitSha,
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.metrics).toEqual({
      observationHours: 96,
      evidenceAgeHours: 12,
      failureRate: 1 / 250,
    });
  });

  it('rejects promotion evidence collected for a different build commit', () => {
    const evidence = createAgenticAppRuntimePromotionEvidence({
      aggregate,
      sourceCommitSha,
      evaluationEvidence,
      evaluationSha256,
      manualQualityGates,
    });
    const readiness = evaluateAgenticAppRuntimePromotionReadiness(evidence, {
      now: new Date('2026-07-05T12:00:00.000Z'),
      evaluationEvidence,
      evaluationSha256,
      buildCommitSha: 'c'.repeat(40),
    });

    expect(readiness.ready).toBe(false);
    expect(
      readiness.checks.find(
        (item) => item.id === 'source-commit-matches-build',
      ),
    ).toEqual({
      id: 'source-commit-matches-build',
      passed: false,
      actual: sourceCommitSha,
      required: 'c'.repeat(40),
    });
  });

  it('blocks weak dogfood, security violations and incomplete attestations', () => {
    const evidence = createAgenticAppRuntimePromotionEvidence({
      aggregate: {
        ...aggregate,
        observedBuildCount: 1,
        observedInstallCount: 3,
        dogfood: {
          ...aggregate.dogfood,
          previewSessions: 2,
          distinctGeneratedApps: 1,
          capabilityInvocations: 10,
          sensitiveApprovals: 0,
          failures: 2,
          secretLeaks: 1,
        },
      },
      sourceCommitSha,
      evaluationEvidence,
      evaluationSha256,
      manualQualityGates: {
        ...manualQualityGates,
        sensitiveApprovalPassed: false,
      },
    });
    const readiness = evaluateAgenticAppRuntimePromotionReadiness(evidence, {
      now: new Date('2026-07-05T12:00:00.000Z'),
      evaluationEvidence,
      evaluationSha256,
      buildCommitSha: sourceCommitSha,
    });

    expect(readiness.ready).toBe(false);
    expect(
      readiness.checks.filter((item) => !item.passed).map((item) => item.id),
    ).toEqual(
      expect.arrayContaining([
        'minimum-observed-builds',
        'minimum-observed-installs',
        'minimum-preview-sessions',
        'minimum-distinct-generated-apps',
        'minimum-capability-invocations',
        'minimum-sensitive-approvals',
        'maximum-failure-rate',
        'no-secret-leaks',
        'sensitive-approval-passed',
      ]),
    );
  });

  it('fails closed when linked evaluation evidence is missing or changed', () => {
    const evidence = createAgenticAppRuntimePromotionEvidence({
      aggregate,
      sourceCommitSha,
      evaluationEvidence,
      evaluationSha256,
      manualQualityGates,
    });
    const missing = evaluateAgenticAppRuntimePromotionReadiness(evidence, {
      now: new Date('2026-07-05T12:00:00.000Z'),
    });
    const changed = evaluateAgenticAppRuntimePromotionReadiness(evidence, {
      now: new Date('2026-07-05T12:00:00.000Z'),
      evaluationEvidence: {
        ...evaluationEvidence,
        runId: '12d25d2a-2b52-4800-bac2-a94c9536b7e4',
      },
      evaluationSha256: 'b'.repeat(64),
      buildCommitSha: sourceCommitSha,
    });

    expect(missing.ready).toBe(false);
    expect(changed.ready).toBe(false);
    expect(
      changed.checks.filter((item) => !item.passed).map((item) => item.id),
    ).toEqual(
      expect.arrayContaining([
        'evaluation-run-id-matches',
        'evaluation-sha256-matches',
      ]),
    );
  });

  it('strictly rejects content, identifiers and unknown fields', () => {
    expect(() =>
      parseAgenticAppRuntimeDogfoodAggregate({
        ...aggregate,
        userId: 'operator-1',
      }),
    ).toThrow();
    expect(() =>
      parseAgenticAppRuntimePromotionEvidence({
        ...createAgenticAppRuntimePromotionEvidence({
          aggregate,
          sourceCommitSha,
          evaluationEvidence,
          evaluationSha256,
          manualQualityGates,
        }),
        prompt: 'private content',
      }),
    ).toThrow();
  });

  it('rejects non-canonical observation timestamps at readiness time', () => {
    const evidence = createAgenticAppRuntimePromotionEvidence({
      aggregate: {
        ...aggregate,
        observationStartedAt: '2026-07-01T00:00:00Z',
      },
      sourceCommitSha,
      evaluationEvidence,
      evaluationSha256,
      manualQualityGates,
    });
    const readiness = evaluateAgenticAppRuntimePromotionReadiness(evidence, {
      now: new Date('2026-07-05T12:00:00.000Z'),
      evaluationEvidence,
      evaluationSha256,
      buildCommitSha: sourceCommitSha,
    });

    expect(readiness.ready).toBe(false);
    expect(
      readiness.checks.find((item) => item.id === 'valid-observation-window')
        ?.passed,
    ).toBe(false);
  });
});
