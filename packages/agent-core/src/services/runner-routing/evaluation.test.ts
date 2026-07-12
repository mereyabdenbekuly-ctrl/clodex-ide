import { describe, expect, it } from 'vitest';
import {
  createRunnerRoutingPromotionProgress,
  evaluateRunnerRouting,
  type RunnerRoutingEvaluationSample,
} from './evaluation';

describe('Runner Routing evaluation suite', () => {
  it('reports observational signals without inventing counterfactual accuracy', () => {
    const report = evaluateRunnerRouting([
      sample({
        decisionId: 'match',
        recommendedProviderId: 'local',
        recommendedProviderKind: 'local',
      }),
      sample({
        decisionId: 'failure-signal',
        actual: execution('local', 'local', 'failed', 60_000, true),
        recommendedProviderId: 'ssh',
        recommendedProviderKind: 'ssh',
        estimatedActualDurationMs: 60_000,
        estimatedRecommendedDurationMs: 10_000,
      }),
    ]);

    expect(report.sampleCount).toBe(2);
    expect(report.divergentDecisionCount).toBe(1);
    expect(report.failureAvoidanceSignalCount).toBe(1);
    expect(report.timeoutAvoidanceSignalCount).toBe(1);
    expect(report.estimatedLatencyAdvantageAverageMs).toBe(50_000);
    expect(report.recommendationWinRate).toBeNull();
    expect(report.verifiedCounterfactualSampleCount).toBe(0);
    expect(report.promotionReady).toBe(false);
    expect(report.promotionBlockers).toContain(
      'insufficient-verified-counterfactuals',
    );
  });

  it('measures verified wins, failure/timeout precision, latency, and harm', () => {
    const samples: RunnerRoutingEvaluationSample[] = [
      sample({
        decisionId: 'avoided-timeout',
        actual: execution('local', 'local', 'failed', 60_000, true),
        recommendedProviderId: 'ssh',
        recommendedProviderKind: 'ssh',
        counterfactualRecommended: {
          ...execution('ssh', 'ssh', 'completed', 8_000, false),
          source: 'paired-replay',
        },
      }),
      sample({
        decisionId: 'faster',
        actual: execution('local', 'local', 'completed', 30_000, false),
        recommendedProviderId: 'ssh',
        recommendedProviderKind: 'ssh',
        counterfactualRecommended: {
          ...execution('ssh', 'ssh', 'completed', 10_000, false),
          source: 'paired-replay',
        },
      }),
      sample({
        decisionId: 'harmful',
        actual: execution('local', 'local', 'completed', 10_000, false),
        recommendedProviderId: 'ssh',
        recommendedProviderKind: 'ssh',
        counterfactualRecommended: {
          ...execution('ssh', 'ssh', 'failed', 5_000, false),
          source: 'paired-replay',
        },
      }),
    ];
    const report = evaluateRunnerRouting(samples, {
      minimumObservedSamples: 3,
      minimumDivergentSamples: 3,
      minimumVerifiedCounterfactualSamples: 3,
      minimumVerifiedFailureSignals: 1,
      minimumVerifiedTimeoutSignals: 1,
      minimumVerifiedLatencyPairs: 1,
      minimumRecommendationWinRate: 0.6,
      minimumFailureAvoidancePrecision: 1,
      minimumTimeoutAvoidancePrecision: 1,
      maximumHarmfulRecommendationRate: 0.34,
      maximumActualDurationPredictionMaeMs: 100_000,
    });

    expect(report.recommendationWinRate).toBeCloseTo(2 / 3);
    expect(report.failureAvoidancePrecision).toBe(1);
    expect(report.timeoutAvoidancePrecision).toBe(1);
    expect(report.harmfulRecommendationRate).toBeCloseTo(1 / 3);
    expect(report.realizedLatencyAdvantageAverageMs).toBe(20_000);
    expect(report.promotionReady).toBe(true);
  });

  it('does not count matched-command history as verified promotion evidence', () => {
    const report = evaluateRunnerRouting(
      [
        sample({
          decisionId: 'history-only',
          recommendedProviderId: 'docker',
          recommendedProviderKind: 'docker',
          counterfactualRecommended: {
            ...execution('docker', 'docker', 'completed', 5_000, false),
            source: 'matched-command-history',
          },
        }),
      ],
      {
        minimumObservedSamples: 1,
        minimumDivergentSamples: 1,
        minimumVerifiedCounterfactualSamples: 1,
      },
    );

    expect(report.historicalCounterfactualSampleCount).toBe(1);
    expect(report.verifiedCounterfactualSampleCount).toBe(0);
    expect(report.promotionBlockers).toContain(
      'insufficient-verified-counterfactuals',
    );
  });

  it('reports independent latency, failure, timeout, and promotion metrics per replay profile', () => {
    const report = evaluateRunnerRouting(
      [
        sample({
          decisionId: 'node-success',
          replayProfile: 'node-copy-on-write',
          actualProviderId: 'ssh',
          actualProviderKind: 'ssh',
          actual: execution('ssh', 'ssh', 'completed', 30_000, false),
          recommendedProviderId: 'local',
          recommendedProviderKind: 'local',
          counterfactualRecommended: {
            ...execution('local', 'local', 'completed', 10_000, false),
            preparationDurationMs: 2_000,
            totalDurationMs: 12_000,
            source: 'paired-replay',
          },
        }),
        sample({
          decisionId: 'node-timeout',
          replayProfile: 'node-copy-on-write',
          actualProviderId: 'ssh',
          actualProviderKind: 'ssh',
          actual: execution('ssh', 'ssh', 'failed', 60_000, true),
          recommendedProviderId: 'local',
          recommendedProviderKind: 'local',
          counterfactualRecommended: {
            ...execution('local', 'local', 'failed', 60_000, true),
            preparationDurationMs: 3_000,
            totalDurationMs: 63_000,
            source: 'paired-replay',
          },
        }),
        sample({
          decisionId: 'ssh-read',
          replayProfile: 'ssh-read-only',
          counterfactualRecommended: {
            ...execution('ssh', 'ssh', 'completed', 8_000, false),
            preparationDurationMs: 2_500,
            totalDurationMs: 17_000,
            source: 'paired-replay',
          },
        }),
        sample({
          decisionId: 'cargo-failure',
          replayProfile: 'cargo-cache',
          actualProviderId: 'ssh',
          actualProviderKind: 'ssh',
          actual: execution('ssh', 'ssh', 'completed', 15_000, false),
          recommendedProviderId: 'local',
          recommendedProviderKind: 'local',
          counterfactualRecommended: {
            ...execution('local', 'local', 'failed', 12_000, false),
            preparationDurationMs: 4_000,
            totalDurationMs: 16_000,
            source: 'paired-replay',
          },
        }),
        sample({
          decisionId: 'go-timeout',
          replayProfile: 'go-cache',
          actualProviderId: 'ssh',
          actualProviderKind: 'ssh',
          actual: execution('ssh', 'ssh', 'completed', 18_000, false),
          recommendedProviderId: 'local',
          recommendedProviderKind: 'local',
          counterfactualRecommended: {
            ...execution('local', 'local', 'failed', 60_000, true),
            preparationDurationMs: 5_000,
            totalDurationMs: 65_000,
            source: 'paired-replay',
          },
        }),
      ],
      {
        minimumObservedSamples: 1,
        minimumDivergentSamples: 1,
        minimumVerifiedCounterfactualSamples: 1,
        minimumVerifiedFailureSignals: 1,
        minimumVerifiedTimeoutSignals: 1,
        minimumVerifiedLatencyPairs: 1,
      },
    );

    expect(report.profileMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profile: 'node-copy-on-write',
          sampleCount: 2,
          verifiedCounterfactualSampleCount: 2,
          replaySuccessRate: 0.5,
          replayFailureRate: 0.5,
          replayTimeoutRate: 0.5,
          replayDurationAverageMs: 35_000,
          replayPreparationAverageMs: 2_500,
          replayTotalAverageMs: 37_500,
          promotionReady: false,
        }),
        expect.objectContaining({
          profile: 'ssh-read-only',
          sampleCount: 1,
          verifiedCounterfactualSampleCount: 1,
          replaySuccessRate: 1,
          replayFailureRate: 0,
          replayTimeoutRate: 0,
          replayDurationAverageMs: 8_000,
          replayPreparationAverageMs: 2_500,
          replayTotalAverageMs: 17_000,
        }),
        expect.objectContaining({
          profile: 'cargo-cache',
          sampleCount: 1,
          replaySuccessRate: 0,
          replayFailureRate: 1,
          replayTimeoutRate: 0,
          replayDurationAverageMs: 12_000,
          replayPreparationAverageMs: 4_000,
          replayTotalAverageMs: 16_000,
        }),
        expect.objectContaining({
          profile: 'go-cache',
          sampleCount: 1,
          replaySuccessRate: 0,
          replayFailureRate: 1,
          replayTimeoutRate: 1,
          replayDurationAverageMs: 60_000,
          replayPreparationAverageMs: 5_000,
          replayTotalAverageMs: 65_000,
        }),
      ]),
    );
  });

  it('reports exact remaining evidence before profile promotion', () => {
    const report = evaluateRunnerRouting(
      [
        sample({
          replayProfile: 'ssh-read-only',
          actual: execution('local', 'local', 'failed', 60_000, true),
          counterfactualRecommended: {
            ...execution('ssh', 'ssh', 'completed', 8_000, false),
            source: 'paired-replay',
          },
        }),
      ],
      {
        minimumObservedSamples: 3,
        minimumDivergentSamples: 2,
        minimumVerifiedCounterfactualSamples: 2,
        minimumVerifiedFailureSignals: 1,
        minimumVerifiedTimeoutSignals: 1,
        minimumVerifiedLatencyPairs: 1,
      },
    );
    const progress = createRunnerRoutingPromotionProgress(report, {
      minimumObservedSamples: 3,
      minimumDivergentSamples: 2,
      minimumVerifiedCounterfactualSamples: 2,
      minimumVerifiedFailureSignals: 1,
      minimumVerifiedTimeoutSignals: 1,
      minimumVerifiedLatencyPairs: 1,
    });

    expect(progress).toMatchObject({
      profile: 'ssh-read-only',
      promotionReady: false,
      counts: {
        observedSamples: { current: 1, required: 3, remaining: 2 },
        divergentSamples: { current: 1, required: 2, remaining: 1 },
        verifiedCounterfactuals: { current: 1, required: 2, remaining: 1 },
        verifiedFailureSignals: { current: 1, required: 1, remaining: 0 },
        verifiedTimeoutSignals: { current: 1, required: 1, remaining: 0 },
        verifiedLatencyPairs: { current: 0, required: 1, remaining: 1 },
      },
      metrics: {
        replaySuccessRate: 1,
        replayFailureRate: 0,
        replayTimeoutRate: 0,
        replayDurationAverageMs: 8_000,
      },
    });
  });
});

function sample(
  overrides: Partial<RunnerRoutingEvaluationSample>,
): RunnerRoutingEvaluationSample {
  return {
    decisionId: 'decision',
    commandClassHash: 'a'.repeat(64),
    actualProviderId: 'local',
    actualProviderKind: 'local',
    recommendedProviderId: 'ssh',
    recommendedProviderKind: 'ssh',
    confidence: 0.8,
    evidenceSampleCount: 10,
    estimatedActualDurationMs: 20_000,
    estimatedRecommendedDurationMs: 10_000,
    replayProfile: null,
    actual: execution('local', 'local', 'completed', 20_000, false),
    ...overrides,
  };
}

function execution(
  providerId: string,
  providerKind: RunnerRoutingEvaluationSample['actualProviderKind'],
  outcome: 'completed' | 'failed',
  durationMs: number,
  timedOut: boolean,
) {
  return {
    providerId,
    providerKind,
    outcome,
    durationMs,
    timedOut,
    exitCodeClass:
      outcome === 'completed' ? ('zero' as const) : ('non-zero' as const),
  };
}
