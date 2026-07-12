import { describe, expect, it } from 'vitest';
import {
  evaluateIsolatedAgentRuntimePromotionReadiness,
  isStablePromotionPolicyArmed,
  parseIsolatedAgentRuntimePromotionEvidence,
  type IsolatedAgentRuntimePromotionEvidence,
} from './isolated-agent-runtime-promotion';

const readyEvidence: IsolatedAgentRuntimePromotionEvidence = {
  schemaVersion: 1,
  sourceChannel: 'prerelease',
  observationStartedAt: '2026-07-01T00:00:00.000Z',
  observationEndedAt: '2026-07-05T00:00:00.000Z',
  observedBuildCount: 3,
  observedInstallCount: 100,
  stepOutcomes: {
    completed: 990,
    failed: 5,
    aborted: 5,
  },
  workerLifecycle: {
    crashed: 1,
    restartSucceeded: 1,
    restartSpawnFailed: 0,
    restartBudgetExhausted: 0,
  },
  circuitBreakerOpened: 1,
  qualityGates: {
    happySmokePassed: true,
    faultSmokePassed: true,
    contentFreeTelemetryAuditPassed: true,
    noPostDispatchReplayAuditPassed: true,
  },
};

describe('isolated agent runtime stable promotion readiness', () => {
  it('accepts aggregate prerelease evidence that meets every threshold', () => {
    const readiness = evaluateIsolatedAgentRuntimePromotionReadiness(
      readyEvidence,
      {
        now: new Date('2026-07-06T00:00:00.000Z'),
      },
    );

    expect(readiness.ready).toBe(true);
    expect(readiness.metrics).toMatchObject({
      observationHours: 96,
      evidenceAgeHours: 24,
      finishedStepCount: 1_000,
      failureRate: 5 / 995,
      abortRate: 5 / 1_000,
      workerCrashRate: 1 / 1_000,
      circuitBreakerOpenRate: 1 / 1_000,
    });
    expect(readiness.checks.every((check) => check.passed)).toBe(true);
  });

  it('blocks promotion when observation, reliability, or audits are weak', () => {
    const readiness = evaluateIsolatedAgentRuntimePromotionReadiness(
      {
        ...readyEvidence,
        observationEndedAt: '2026-07-02T00:00:00.000Z',
        observedBuildCount: 1,
        observedInstallCount: 4,
        stepOutcomes: {
          completed: 80,
          failed: 20,
          aborted: 20,
        },
        workerLifecycle: {
          crashed: 3,
          restartSucceeded: 1,
          restartSpawnFailed: 1,
          restartBudgetExhausted: 1,
        },
        circuitBreakerOpened: 8,
        qualityGates: {
          ...readyEvidence.qualityGates,
          faultSmokePassed: false,
          noPostDispatchReplayAuditPassed: false,
        },
      },
      {
        now: new Date('2026-07-06T00:00:00.000Z'),
      },
    );

    expect(readiness.ready).toBe(false);
    expect(
      readiness.checks
        .filter((check) => !check.passed)
        .map((check) => check.id),
    ).toEqual(
      expect.arrayContaining([
        'minimum-observation-hours',
        'maximum-evidence-age-hours',
        'minimum-observed-builds',
        'minimum-observed-installs',
        'minimum-finished-steps',
        'maximum-failure-rate',
        'maximum-abort-rate',
        'maximum-worker-crash-rate',
        'all-crashes-recovered',
        'no-restart-spawn-failures',
        'no-restart-budget-exhaustion',
        'maximum-circuit-breaker-open-rate',
        'fault-smoke-passed',
        'no-post-dispatch-replay-audit-passed',
      ]),
    );
  });

  it('strictly rejects content or identifiers added to aggregate evidence', () => {
    expect(() =>
      parseIsolatedAgentRuntimePromotionEvidence({
        ...readyEvidence,
        prompt: 'private prompt',
      }),
    ).toThrow('unsupported fields: prompt');
    expect(() =>
      parseIsolatedAgentRuntimePromotionEvidence({
        ...readyEvidence,
        workerLifecycle: {
          ...readyEvidence.workerLifecycle,
          agentInstanceId: 'agent-1',
        },
      }),
    ).toThrow('unsupported fields: agentInstanceId');
  });

  it('rejects non-canonical or future observation timestamps', () => {
    const readiness = evaluateIsolatedAgentRuntimePromotionReadiness(
      {
        ...readyEvidence,
        observationStartedAt: 'July 1, 2026',
        observationEndedAt: '2026-07-07T00:10:00.000Z',
      },
      {
        now: new Date('2026-07-06T00:00:00.000Z'),
      },
    );

    expect(readiness.ready).toBe(false);
    expect(
      readiness.checks
        .filter((check) => !check.passed)
        .map((check) => check.id),
    ).toEqual(
      expect.arrayContaining([
        'valid-observation-window',
        'evidence-not-from-future',
      ]),
    );
  });

  it('arms stable promotion only while release is next and default-off', () => {
    expect(
      isStablePromotionPolicyArmed({
        defaultEnabled: false,
        rolloutStage: 'next',
        failureThreshold: 2,
        cooldownMs: 10 * 60_000,
      }),
    ).toBe(true);
    expect(
      isStablePromotionPolicyArmed({
        defaultEnabled: false,
        rolloutStage: 'hold',
        failureThreshold: 2,
        cooldownMs: 10 * 60_000,
      }),
    ).toBe(false);
  });
});
