import type { RunnerRoutingProviderKind } from './index';
import {
  runnerPairedReplayProfiles,
  type RunnerPairedReplayProfile,
} from './paired-replay';

export type RunnerRoutingCounterfactualSource =
  | 'paired-replay'
  | 'matched-command-history';

export interface RunnerRoutingEvaluationExecution {
  providerId: string;
  providerKind: RunnerRoutingProviderKind;
  outcome: 'completed' | 'failed';
  durationMs: number;
  timedOut: boolean;
  exitCodeClass: 'zero' | 'non-zero' | 'missing';
  preparationDurationMs?: number;
  totalDurationMs?: number;
}

export interface RunnerRoutingEvaluationSample {
  decisionId: string;
  commandClassHash: string | null;
  actualProviderId: string;
  actualProviderKind: RunnerRoutingProviderKind;
  recommendedProviderId: string;
  recommendedProviderKind: RunnerRoutingProviderKind;
  confidence: number;
  evidenceSampleCount: number;
  estimatedActualDurationMs: number | null;
  estimatedRecommendedDurationMs: number | null;
  replayProfile: RunnerPairedReplayProfile | null;
  actual: RunnerRoutingEvaluationExecution;
  counterfactualRecommended?: RunnerRoutingEvaluationExecution & {
    source: RunnerRoutingCounterfactualSource;
  };
}

export interface RunnerRoutingEvaluationThresholds {
  minimumObservedSamples?: number;
  minimumDivergentSamples?: number;
  minimumVerifiedCounterfactualSamples?: number;
  minimumVerifiedFailureSignals?: number;
  minimumVerifiedTimeoutSignals?: number;
  minimumVerifiedLatencyPairs?: number;
  minimumRecommendationWinRate?: number;
  minimumFailureAvoidancePrecision?: number;
  minimumTimeoutAvoidancePrecision?: number;
  maximumHarmfulRecommendationRate?: number;
  maximumActualDurationPredictionMaeMs?: number;
}

export type RunnerRoutingPromotionBlocker =
  | 'insufficient-observed-samples'
  | 'insufficient-divergent-samples'
  | 'insufficient-verified-counterfactuals'
  | 'insufficient-verified-failure-signals'
  | 'insufficient-verified-timeout-signals'
  | 'insufficient-verified-latency-pairs'
  | 'recommendation-win-rate-below-target'
  | 'failure-avoidance-precision-below-target'
  | 'timeout-avoidance-precision-below-target'
  | 'harmful-recommendation-rate-above-target'
  | 'duration-calibration-error-above-target';

export interface RunnerRoutingEvaluationReport {
  evaluatedProfile: RunnerPairedReplayProfile | null;
  sampleCount: number;
  divergentDecisionCount: number;
  divergentDecisionRate: number;
  recommendationAgreementRate: number;
  observedActualSuccessRate: number;
  observedActualFailureRate: number;
  observedActualTimeoutRate: number;
  failureAvoidanceSignalCount: number;
  timeoutAvoidanceSignalCount: number;
  durationPredictionSampleCount: number;
  actualDurationPredictionMaeMs: number | null;
  estimatedLatencyAdvantageSampleCount: number;
  estimatedLatencyAdvantageAverageMs: number | null;
  estimatedLatencyAdvantageP50Ms: number | null;
  estimatedLatencyAdvantageP95Ms: number | null;
  estimatedFasterRecommendationRate: number | null;
  historicalCounterfactualSampleCount: number;
  verifiedCounterfactualSampleCount: number;
  verifiedCounterfactualCoverage: number;
  verifiedFailureSignalCount: number;
  verifiedTimeoutSignalCount: number;
  verifiedLatencyPairCount: number;
  recommendationWinRate: number | null;
  failureAvoidancePrecision: number | null;
  timeoutAvoidancePrecision: number | null;
  harmfulRecommendationRate: number | null;
  realizedLatencyAdvantageAverageMs: number | null;
  realizedLatencyAdvantageP50Ms: number | null;
  realizedLatencyAdvantageP95Ms: number | null;
  promotionReady: boolean;
  promotionBlockers: RunnerRoutingPromotionBlocker[];
  profileMetrics: RunnerRoutingProfileMetrics[];
}

export interface RunnerRoutingProfileMetrics {
  profile: RunnerPairedReplayProfile;
  sampleCount: number;
  verifiedCounterfactualSampleCount: number;
  replaySuccessRate: number | null;
  replayFailureRate: number | null;
  replayTimeoutRate: number | null;
  replayDurationAverageMs: number | null;
  replayDurationP50Ms: number | null;
  replayDurationP95Ms: number | null;
  replayPreparationAverageMs: number | null;
  replayTotalAverageMs: number | null;
  recommendationWinRate: number | null;
  failureAvoidancePrecision: number | null;
  timeoutAvoidancePrecision: number | null;
  harmfulRecommendationRate: number | null;
  realizedLatencyAdvantageAverageMs: number | null;
  realizedLatencyAdvantageP50Ms: number | null;
  realizedLatencyAdvantageP95Ms: number | null;
  promotionReady: boolean;
  promotionBlockers: RunnerRoutingPromotionBlocker[];
}

type NormalizedRunnerRoutingEvaluationThresholds =
  Required<RunnerRoutingEvaluationThresholds>;

export const runnerRoutingEvaluationDefaultThresholds: Readonly<
  Required<RunnerRoutingEvaluationThresholds>
> = Object.freeze({
  minimumObservedSamples: 100,
  minimumDivergentSamples: 25,
  minimumVerifiedCounterfactualSamples: 25,
  minimumVerifiedFailureSignals: 10,
  minimumVerifiedTimeoutSignals: 10,
  minimumVerifiedLatencyPairs: 10,
  minimumRecommendationWinRate: 0.65,
  minimumFailureAvoidancePrecision: 0.7,
  minimumTimeoutAvoidancePrecision: 0.8,
  maximumHarmfulRecommendationRate: 0.1,
  maximumActualDurationPredictionMaeMs: 15_000,
});

export interface RunnerRoutingPromotionProgressCount {
  current: number;
  required: number;
  remaining: number;
  satisfied: boolean;
}

export interface RunnerRoutingPromotionProgress {
  profile: RunnerPairedReplayProfile | null;
  promotionReady: boolean;
  promotionBlockers: RunnerRoutingPromotionBlocker[];
  counts: {
    observedSamples: RunnerRoutingPromotionProgressCount;
    divergentSamples: RunnerRoutingPromotionProgressCount;
    verifiedCounterfactuals: RunnerRoutingPromotionProgressCount;
    verifiedFailureSignals: RunnerRoutingPromotionProgressCount;
    verifiedTimeoutSignals: RunnerRoutingPromotionProgressCount;
    verifiedLatencyPairs: RunnerRoutingPromotionProgressCount;
  };
  quality: {
    recommendationWinRate: number | null;
    minimumRecommendationWinRate: number;
    failureAvoidancePrecision: number | null;
    minimumFailureAvoidancePrecision: number;
    timeoutAvoidancePrecision: number | null;
    minimumTimeoutAvoidancePrecision: number;
    harmfulRecommendationRate: number | null;
    maximumHarmfulRecommendationRate: number;
    actualDurationPredictionMaeMs: number | null;
    maximumActualDurationPredictionMaeMs: number;
  };
  metrics: {
    replaySuccessRate: number | null;
    replayFailureRate: number | null;
    replayTimeoutRate: number | null;
    replayDurationAverageMs: number | null;
    replayDurationP50Ms: number | null;
    replayDurationP95Ms: number | null;
    replayPreparationAverageMs: number | null;
    replayTotalAverageMs: number | null;
    realizedLatencyAdvantageAverageMs: number | null;
    realizedLatencyAdvantageP50Ms: number | null;
    realizedLatencyAdvantageP95Ms: number | null;
  };
}

/**
 * Evaluates shadow-routing decisions without pretending that an unexecuted
 * recommendation is ground truth.
 *
 * Observed metrics are computed for every receipt. Accuracy, realized latency
 * advantage, and promotion readiness require verified paired replays.
 * Same-command historical matches are reported separately and never satisfy
 * the verified-counterfactual promotion threshold.
 */
export function evaluateRunnerRouting(
  samples: readonly RunnerRoutingEvaluationSample[],
  thresholds: RunnerRoutingEvaluationThresholds = {},
): RunnerRoutingEvaluationReport {
  const target = normalizeThresholds(thresholds);
  return evaluateRunnerRoutingWithTarget(samples, target, true);
}

export function createRunnerRoutingPromotionProgress(
  report: RunnerRoutingEvaluationReport,
  thresholds: RunnerRoutingEvaluationThresholds = {},
): RunnerRoutingPromotionProgress {
  const target = normalizeThresholds(thresholds);
  const profileMetrics =
    report.evaluatedProfile === null
      ? null
      : (report.profileMetrics.find(
          (metrics) => metrics.profile === report.evaluatedProfile,
        ) ?? null);
  return {
    profile: report.evaluatedProfile,
    promotionReady: report.promotionReady,
    promotionBlockers: [...report.promotionBlockers],
    counts: {
      observedSamples: progressCount(
        report.sampleCount,
        target.minimumObservedSamples,
      ),
      divergentSamples: progressCount(
        report.divergentDecisionCount,
        target.minimumDivergentSamples,
      ),
      verifiedCounterfactuals: progressCount(
        report.verifiedCounterfactualSampleCount,
        target.minimumVerifiedCounterfactualSamples,
      ),
      verifiedFailureSignals: progressCount(
        report.verifiedFailureSignalCount,
        target.minimumVerifiedFailureSignals,
      ),
      verifiedTimeoutSignals: progressCount(
        report.verifiedTimeoutSignalCount,
        target.minimumVerifiedTimeoutSignals,
      ),
      verifiedLatencyPairs: progressCount(
        report.verifiedLatencyPairCount,
        target.minimumVerifiedLatencyPairs,
      ),
    },
    quality: {
      recommendationWinRate: report.recommendationWinRate,
      minimumRecommendationWinRate: target.minimumRecommendationWinRate,
      failureAvoidancePrecision: report.failureAvoidancePrecision,
      minimumFailureAvoidancePrecision: target.minimumFailureAvoidancePrecision,
      timeoutAvoidancePrecision: report.timeoutAvoidancePrecision,
      minimumTimeoutAvoidancePrecision: target.minimumTimeoutAvoidancePrecision,
      harmfulRecommendationRate: report.harmfulRecommendationRate,
      maximumHarmfulRecommendationRate: target.maximumHarmfulRecommendationRate,
      actualDurationPredictionMaeMs: report.actualDurationPredictionMaeMs,
      maximumActualDurationPredictionMaeMs:
        target.maximumActualDurationPredictionMaeMs,
    },
    metrics: {
      replaySuccessRate: profileMetrics?.replaySuccessRate ?? null,
      replayFailureRate: profileMetrics?.replayFailureRate ?? null,
      replayTimeoutRate: profileMetrics?.replayTimeoutRate ?? null,
      replayDurationAverageMs: profileMetrics?.replayDurationAverageMs ?? null,
      replayDurationP50Ms: profileMetrics?.replayDurationP50Ms ?? null,
      replayDurationP95Ms: profileMetrics?.replayDurationP95Ms ?? null,
      replayPreparationAverageMs:
        profileMetrics?.replayPreparationAverageMs ?? null,
      replayTotalAverageMs: profileMetrics?.replayTotalAverageMs ?? null,
      realizedLatencyAdvantageAverageMs:
        profileMetrics?.realizedLatencyAdvantageAverageMs ?? null,
      realizedLatencyAdvantageP50Ms:
        profileMetrics?.realizedLatencyAdvantageP50Ms ?? null,
      realizedLatencyAdvantageP95Ms:
        profileMetrics?.realizedLatencyAdvantageP95Ms ?? null,
    },
  };
}

function evaluateRunnerRoutingWithTarget(
  samples: readonly RunnerRoutingEvaluationSample[],
  target: NormalizedRunnerRoutingEvaluationThresholds,
  includeProfileMetrics: boolean,
): RunnerRoutingEvaluationReport {
  const divergent = samples.filter((sample) => !recommendationMatches(sample));
  const actualSuccesses = samples.filter((sample) =>
    executionSucceeded(sample.actual),
  );
  const actualFailures = samples.filter(
    (sample) => !executionSucceeded(sample.actual),
  );
  const actualTimeouts = samples.filter((sample) => sample.actual.timedOut);
  const failureAvoidanceSignals = divergent.filter(
    (sample) => !executionSucceeded(sample.actual),
  );
  const timeoutAvoidanceSignals = divergent.filter(
    (sample) => sample.actual.timedOut,
  );

  const durationPredictionErrors = samples.flatMap((sample) =>
    sample.estimatedActualDurationMs === null
      ? []
      : [Math.abs(sample.actual.durationMs - sample.estimatedActualDurationMs)],
  );
  const estimatedLatencyAdvantages = divergent.flatMap((sample) =>
    sample.estimatedActualDurationMs === null ||
    sample.estimatedRecommendedDurationMs === null
      ? []
      : [
          sample.estimatedActualDurationMs -
            sample.estimatedRecommendedDurationMs,
        ],
  );

  const historicalCounterfactuals = divergent.filter(
    (sample) =>
      sample.counterfactualRecommended?.source === 'matched-command-history',
  );
  const verifiedCounterfactuals = divergent.filter(
    (sample) => sample.counterfactualRecommended?.source === 'paired-replay',
  );
  const verifiedWins = verifiedCounterfactuals.filter((sample) =>
    recommendationWins(sample),
  );
  const verifiedHarm = verifiedCounterfactuals.filter((sample) =>
    recommendationHarms(sample),
  );
  const verifiedFailureSignals = verifiedCounterfactuals.filter(
    (sample) => !executionSucceeded(sample.actual),
  );
  const verifiedFailureAvoided = verifiedFailureSignals.filter((sample) =>
    executionSucceeded(sample.counterfactualRecommended!),
  );
  const verifiedTimeoutSignals = verifiedCounterfactuals.filter(
    (sample) => sample.actual.timedOut,
  );
  const verifiedTimeoutAvoided = verifiedTimeoutSignals.filter(
    (sample) => !sample.counterfactualRecommended!.timedOut,
  );
  const realizedLatencyAdvantages = verifiedCounterfactuals.flatMap((sample) =>
    executionSucceeded(sample.actual) &&
    executionSucceeded(sample.counterfactualRecommended!)
      ? [
          sample.actual.durationMs -
            sample.counterfactualRecommended!.durationMs,
        ]
      : [],
  );

  const recommendationWinRate = nullableRate(
    verifiedWins.length,
    verifiedCounterfactuals.length,
  );
  const failureAvoidancePrecision = nullableRate(
    verifiedFailureAvoided.length,
    verifiedFailureSignals.length,
  );
  const timeoutAvoidancePrecision = nullableRate(
    verifiedTimeoutAvoided.length,
    verifiedTimeoutSignals.length,
  );
  const harmfulRecommendationRate = nullableRate(
    verifiedHarm.length,
    verifiedCounterfactuals.length,
  );
  const actualDurationPredictionMaeMs = nullableAverage(
    durationPredictionErrors,
  );
  const blockers: RunnerRoutingPromotionBlocker[] = [];
  if (samples.length < target.minimumObservedSamples) {
    blockers.push('insufficient-observed-samples');
  }
  if (divergent.length < target.minimumDivergentSamples) {
    blockers.push('insufficient-divergent-samples');
  }
  if (
    verifiedCounterfactuals.length < target.minimumVerifiedCounterfactualSamples
  ) {
    blockers.push('insufficient-verified-counterfactuals');
  }
  if (verifiedFailureSignals.length < target.minimumVerifiedFailureSignals) {
    blockers.push('insufficient-verified-failure-signals');
  }
  if (verifiedTimeoutSignals.length < target.minimumVerifiedTimeoutSignals) {
    blockers.push('insufficient-verified-timeout-signals');
  }
  if (realizedLatencyAdvantages.length < target.minimumVerifiedLatencyPairs) {
    blockers.push('insufficient-verified-latency-pairs');
  }
  if (
    recommendationWinRate !== null &&
    recommendationWinRate < target.minimumRecommendationWinRate
  ) {
    blockers.push('recommendation-win-rate-below-target');
  }
  if (
    failureAvoidancePrecision !== null &&
    failureAvoidancePrecision < target.minimumFailureAvoidancePrecision
  ) {
    blockers.push('failure-avoidance-precision-below-target');
  }
  if (
    timeoutAvoidancePrecision !== null &&
    timeoutAvoidancePrecision < target.minimumTimeoutAvoidancePrecision
  ) {
    blockers.push('timeout-avoidance-precision-below-target');
  }
  if (
    harmfulRecommendationRate !== null &&
    harmfulRecommendationRate > target.maximumHarmfulRecommendationRate
  ) {
    blockers.push('harmful-recommendation-rate-above-target');
  }
  if (
    actualDurationPredictionMaeMs !== null &&
    actualDurationPredictionMaeMs > target.maximumActualDurationPredictionMaeMs
  ) {
    blockers.push('duration-calibration-error-above-target');
  }

  const evaluatedProfiles = new Set(
    samples.flatMap((sample) =>
      sample.replayProfile === null ? [] : [sample.replayProfile],
    ),
  );
  const evaluatedProfile =
    evaluatedProfiles.size === 1 ? [...evaluatedProfiles][0]! : null;
  const profileMetrics = includeProfileMetrics
    ? runnerPairedReplayProfiles.flatMap((profile) => {
        const profileSamples = samples.filter(
          (sample) => sample.replayProfile === profile,
        );
        if (profileSamples.length === 0) return [];
        const profileReport = evaluateRunnerRoutingWithTarget(
          profileSamples,
          target,
          false,
        );
        const replayExecutions = profileSamples.flatMap((sample) =>
          sample.counterfactualRecommended?.source === 'paired-replay'
            ? [sample.counterfactualRecommended]
            : [],
        );
        const successfulReplays = replayExecutions.filter(executionSucceeded);
        return [
          {
            profile,
            sampleCount: profileSamples.length,
            verifiedCounterfactualSampleCount:
              profileReport.verifiedCounterfactualSampleCount,
            replaySuccessRate: nullableRate(
              successfulReplays.length,
              replayExecutions.length,
            ),
            replayFailureRate: nullableRate(
              replayExecutions.length - successfulReplays.length,
              replayExecutions.length,
            ),
            replayTimeoutRate: nullableRate(
              replayExecutions.filter((execution) => execution.timedOut).length,
              replayExecutions.length,
            ),
            replayDurationAverageMs: nullableAverage(
              replayExecutions.map((execution) => execution.durationMs),
            ),
            replayDurationP50Ms: nullablePercentile(
              replayExecutions.map((execution) => execution.durationMs),
              0.5,
            ),
            replayDurationP95Ms: nullablePercentile(
              replayExecutions.map((execution) => execution.durationMs),
              0.95,
            ),
            replayPreparationAverageMs: nullableAverage(
              replayExecutions.flatMap((execution) =>
                execution.preparationDurationMs === undefined
                  ? []
                  : [execution.preparationDurationMs],
              ),
            ),
            replayTotalAverageMs: nullableAverage(
              replayExecutions.flatMap((execution) =>
                execution.totalDurationMs === undefined
                  ? []
                  : [execution.totalDurationMs],
              ),
            ),
            recommendationWinRate: profileReport.recommendationWinRate,
            failureAvoidancePrecision: profileReport.failureAvoidancePrecision,
            timeoutAvoidancePrecision: profileReport.timeoutAvoidancePrecision,
            harmfulRecommendationRate: profileReport.harmfulRecommendationRate,
            realizedLatencyAdvantageAverageMs:
              profileReport.realizedLatencyAdvantageAverageMs,
            realizedLatencyAdvantageP50Ms:
              profileReport.realizedLatencyAdvantageP50Ms,
            realizedLatencyAdvantageP95Ms:
              profileReport.realizedLatencyAdvantageP95Ms,
            promotionReady: profileReport.promotionReady,
            promotionBlockers: profileReport.promotionBlockers,
          },
        ];
      })
    : [];

  return {
    evaluatedProfile,
    sampleCount: samples.length,
    divergentDecisionCount: divergent.length,
    divergentDecisionRate: rate(divergent.length, samples.length),
    recommendationAgreementRate: rate(
      samples.length - divergent.length,
      samples.length,
    ),
    observedActualSuccessRate: rate(actualSuccesses.length, samples.length),
    observedActualFailureRate: rate(actualFailures.length, samples.length),
    observedActualTimeoutRate: rate(actualTimeouts.length, samples.length),
    failureAvoidanceSignalCount: failureAvoidanceSignals.length,
    timeoutAvoidanceSignalCount: timeoutAvoidanceSignals.length,
    durationPredictionSampleCount: durationPredictionErrors.length,
    actualDurationPredictionMaeMs,
    estimatedLatencyAdvantageSampleCount: estimatedLatencyAdvantages.length,
    estimatedLatencyAdvantageAverageMs: nullableAverage(
      estimatedLatencyAdvantages,
    ),
    estimatedLatencyAdvantageP50Ms: nullablePercentile(
      estimatedLatencyAdvantages,
      0.5,
    ),
    estimatedLatencyAdvantageP95Ms: nullablePercentile(
      estimatedLatencyAdvantages,
      0.95,
    ),
    estimatedFasterRecommendationRate:
      estimatedLatencyAdvantages.length === 0
        ? null
        : rate(
            estimatedLatencyAdvantages.filter((value) => value > 0).length,
            estimatedLatencyAdvantages.length,
          ),
    historicalCounterfactualSampleCount: historicalCounterfactuals.length,
    verifiedCounterfactualSampleCount: verifiedCounterfactuals.length,
    verifiedCounterfactualCoverage: rate(
      verifiedCounterfactuals.length,
      divergent.length,
    ),
    verifiedFailureSignalCount: verifiedFailureSignals.length,
    verifiedTimeoutSignalCount: verifiedTimeoutSignals.length,
    verifiedLatencyPairCount: realizedLatencyAdvantages.length,
    recommendationWinRate,
    failureAvoidancePrecision,
    timeoutAvoidancePrecision,
    harmfulRecommendationRate,
    realizedLatencyAdvantageAverageMs: nullableAverage(
      realizedLatencyAdvantages,
    ),
    realizedLatencyAdvantageP50Ms: nullablePercentile(
      realizedLatencyAdvantages,
      0.5,
    ),
    realizedLatencyAdvantageP95Ms: nullablePercentile(
      realizedLatencyAdvantages,
      0.95,
    ),
    promotionReady: blockers.length === 0,
    promotionBlockers: blockers,
    profileMetrics,
  };
}

function recommendationMatches(sample: RunnerRoutingEvaluationSample): boolean {
  return (
    sample.actualProviderId === sample.recommendedProviderId &&
    sample.actualProviderKind === sample.recommendedProviderKind
  );
}

function executionSucceeded(
  execution: RunnerRoutingEvaluationExecution,
): boolean {
  return (
    execution.outcome === 'completed' &&
    execution.exitCodeClass === 'zero' &&
    !execution.timedOut
  );
}

function recommendationWins(sample: RunnerRoutingEvaluationSample): boolean {
  const recommended = sample.counterfactualRecommended;
  if (!recommended) return false;
  const actualSucceeded = executionSucceeded(sample.actual);
  const recommendedSucceeded = executionSucceeded(recommended);
  if (recommendedSucceeded !== actualSucceeded) return recommendedSucceeded;
  return (
    recommendedSucceeded && recommended.durationMs < sample.actual.durationMs
  );
}

function recommendationHarms(sample: RunnerRoutingEvaluationSample): boolean {
  const recommended = sample.counterfactualRecommended;
  if (!recommended) return false;
  const actualSucceeded = executionSucceeded(sample.actual);
  const recommendedSucceeded = executionSucceeded(recommended);
  if (recommendedSucceeded !== actualSucceeded) return actualSucceeded;
  return (
    actualSucceeded && recommended.durationMs > sample.actual.durationMs * 1.1
  );
}

function normalizeThresholds(
  thresholds: RunnerRoutingEvaluationThresholds,
): NormalizedRunnerRoutingEvaluationThresholds {
  return {
    minimumObservedSamples: positiveInteger(
      thresholds.minimumObservedSamples ??
        runnerRoutingEvaluationDefaultThresholds.minimumObservedSamples,
    ),
    minimumDivergentSamples: positiveInteger(
      thresholds.minimumDivergentSamples ??
        runnerRoutingEvaluationDefaultThresholds.minimumDivergentSamples,
    ),
    minimumVerifiedCounterfactualSamples: positiveInteger(
      thresholds.minimumVerifiedCounterfactualSamples ??
        runnerRoutingEvaluationDefaultThresholds.minimumVerifiedCounterfactualSamples,
    ),
    minimumVerifiedFailureSignals: positiveInteger(
      thresholds.minimumVerifiedFailureSignals ??
        runnerRoutingEvaluationDefaultThresholds.minimumVerifiedFailureSignals,
    ),
    minimumVerifiedTimeoutSignals: positiveInteger(
      thresholds.minimumVerifiedTimeoutSignals ??
        runnerRoutingEvaluationDefaultThresholds.minimumVerifiedTimeoutSignals,
    ),
    minimumVerifiedLatencyPairs: positiveInteger(
      thresholds.minimumVerifiedLatencyPairs ??
        runnerRoutingEvaluationDefaultThresholds.minimumVerifiedLatencyPairs,
    ),
    minimumRecommendationWinRate: unitInterval(
      thresholds.minimumRecommendationWinRate ??
        runnerRoutingEvaluationDefaultThresholds.minimumRecommendationWinRate,
    ),
    minimumFailureAvoidancePrecision: unitInterval(
      thresholds.minimumFailureAvoidancePrecision ??
        runnerRoutingEvaluationDefaultThresholds.minimumFailureAvoidancePrecision,
    ),
    minimumTimeoutAvoidancePrecision: unitInterval(
      thresholds.minimumTimeoutAvoidancePrecision ??
        runnerRoutingEvaluationDefaultThresholds.minimumTimeoutAvoidancePrecision,
    ),
    maximumHarmfulRecommendationRate: unitInterval(
      thresholds.maximumHarmfulRecommendationRate ??
        runnerRoutingEvaluationDefaultThresholds.maximumHarmfulRecommendationRate,
    ),
    maximumActualDurationPredictionMaeMs: finiteNonNegative(
      thresholds.maximumActualDurationPredictionMaeMs ??
        runnerRoutingEvaluationDefaultThresholds.maximumActualDurationPredictionMaeMs,
    ),
  };
}

function progressCount(
  current: number,
  required: number,
): RunnerRoutingPromotionProgressCount {
  return {
    current,
    required,
    remaining: Math.max(0, required - current),
    satisfied: current >= required,
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function nullableRate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function nullableAverage(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nullablePercentile(
  values: readonly number[],
  quantile: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? null;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      'Runner routing evaluation sample thresholds must be positive integers',
    );
  }
  return value;
}

function unitInterval(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      'Runner routing evaluation rates must be between zero and one',
    );
  }
  return value;
}

function finiteNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      'Runner routing evaluation duration thresholds must be non-negative',
    );
  }
  return value;
}
