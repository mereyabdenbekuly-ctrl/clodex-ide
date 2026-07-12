import { createHash } from 'node:crypto';

export * from './paired-replay';

export const runnerRoutingProviderKinds = [
  'local',
  'ssh',
  'docker',
  'cloud',
] as const;
export type RunnerRoutingProviderKind =
  (typeof runnerRoutingProviderKinds)[number];

export interface RunnerRoutingCapabilities {
  persistentSessions: boolean;
  streamingOutput: boolean;
  stdin: boolean;
  cancellation: boolean;
  workspaceLeases: boolean;
  networkAccess: 'none' | 'restricted' | 'host';
}

export interface RunnerRoutingCandidate {
  providerId: string;
  providerKind: RunnerRoutingProviderKind;
  available: boolean;
  environmentFingerprintHash: string | null;
  capabilities: RunnerRoutingCapabilities;
}

export interface RunnerRoutingObservation {
  commandClassHash: string;
  providerId: string;
  providerKind: RunnerRoutingProviderKind;
  environmentFingerprintHash: string | null;
  outcome: 'completed' | 'failed';
  durationMs: number;
  timedOut: boolean;
  exitCodeClass: 'zero' | 'non-zero' | 'missing';
}

export interface RunnerRoutingIntent {
  operation: 'create-session' | 'execute-command' | 'kill-session';
  commandClassHash: string | null;
  actualProviderId: string;
  actualProviderKind: RunnerRoutingProviderKind;
  requiresNetwork: boolean;
  requiresInteractive: boolean;
  requiresCancellation: boolean;
  requiresWorkspaceLease: boolean;
}

export const runnerRoutingReasonCodes = [
  'actual-provider-preferred',
  'candidate-unavailable',
  'insufficient-evidence',
  'interactive-capability-required',
  'network-capability-required',
  'non-command-operation',
  'observed-failures',
  'observed-latency',
  'observed-success',
  'observed-timeouts',
  'cancellation-capability-required',
  'workspace-lease-required',
] as const;
export type RunnerRoutingReasonCode = (typeof runnerRoutingReasonCodes)[number];

export interface RunnerRoutingRankedCandidate {
  providerId: string;
  providerKind: RunnerRoutingProviderKind;
  score: number;
  observationCount: number;
  estimatedDurationMs: number | null;
  reasonCodes: RunnerRoutingReasonCode[];
}

export interface RunnerRoutingExcludedCandidate {
  providerId: string;
  providerKind: RunnerRoutingProviderKind;
  reasonCodes: RunnerRoutingReasonCode[];
}

export interface RunnerRoutingDecision {
  version: 1;
  mode: 'shadow';
  actualProviderId: string;
  actualProviderKind: RunnerRoutingProviderKind;
  recommendedProviderId: string;
  recommendedProviderKind: RunnerRoutingProviderKind;
  confidence: number;
  evidenceSampleCount: number;
  reasonCodes: RunnerRoutingReasonCode[];
  ranked: RunnerRoutingRankedCandidate[];
  excluded: RunnerRoutingExcludedCandidate[];
  policyHash: string;
}

export const runnerRoutingPromotionReasonCodes = [
  'recommended-provider-is-actual',
  'promotion-confidence-insufficient',
  'promotion-evidence-insufficient',
  'promotion-environment-unverified',
  'promotion-failure-rate-too-high',
  'promotion-score-advantage-insufficient',
  'promotion-timeout-observed',
  'promotion-approved',
] as const;
export type RunnerRoutingPromotionReasonCode =
  (typeof runnerRoutingPromotionReasonCodes)[number];

export interface RunnerRoutingPromotionPolicyOptions {
  minimumConfidence?: number;
  minimumProviderEvidenceSamples?: number;
  minimumSuccessRate?: number;
  minimumScoreAdvantage?: number;
  maximumTimeoutRate?: number;
  requireEnvironmentFingerprint?: boolean;
}

export interface RunnerRoutingPromotionEvaluation {
  version: 1;
  mode: 'retain-configured' | 'automatic';
  selectedProviderId: string;
  selectedProviderKind: RunnerRoutingProviderKind;
  promoted: boolean;
  confidence: number;
  providerEvidenceSamples: number;
  successRate: number;
  timeoutRate: number;
  scoreAdvantage: number;
  reasonCodes: RunnerRoutingPromotionReasonCode[];
  policyHash: string;
}

export interface RunnerRoutingPolicyOptions {
  minimumEvidenceSamples?: number;
  timeoutPenalty?: number;
  failurePenalty?: number;
  actualProviderTieBreakBonus?: number;
}

const DEFAULT_POLICY = Object.freeze({
  minimumEvidenceSamples: 3,
  timeoutPenalty: 0.55,
  failurePenalty: 0.35,
  actualProviderTieBreakBonus: 0.000_001,
});

const DEFAULT_PROMOTION_POLICY = Object.freeze({
  minimumConfidence: 0.2,
  minimumProviderEvidenceSamples: 5,
  minimumSuccessRate: 0.9,
  minimumScoreAdvantage: 0.1,
  maximumTimeoutRate: 0,
  requireEnvironmentFingerprint: true,
});

/**
 * Pure, provider-neutral shadow scorer.
 *
 * It cannot change dispatch. It consumes only hashes, capabilities, and
 * aggregate execution outcomes; command text and runner output are never
 * accepted by this API.
 */
export function scoreRunnerRoutingPolicy(
  intent: RunnerRoutingIntent,
  candidates: readonly RunnerRoutingCandidate[],
  observations: readonly RunnerRoutingObservation[],
  options: RunnerRoutingPolicyOptions = {},
): RunnerRoutingDecision {
  const policy = normalizePolicy(options);
  const policyHash = hashCanonical({
    version: 1,
    ...policy,
  });
  const actual =
    candidates.find(
      (candidate) =>
        candidate.providerId === intent.actualProviderId &&
        candidate.providerKind === intent.actualProviderKind,
    ) ?? fallbackActualCandidate(intent);

  if (intent.operation !== 'execute-command' || !intent.commandClassHash) {
    return conservativeDecision(
      intent,
      actual,
      candidates,
      policyHash,
      'non-command-operation',
    );
  }

  const ranked: RunnerRoutingRankedCandidate[] = [];
  const excluded: RunnerRoutingExcludedCandidate[] = [];
  for (const candidate of candidates) {
    const exclusionReasons: RunnerRoutingReasonCode[] = [];
    if (!candidate.available) exclusionReasons.push('candidate-unavailable');
    if (
      intent.requiresInteractive &&
      (!candidate.capabilities.stdin ||
        !candidate.capabilities.persistentSessions)
    ) {
      exclusionReasons.push('interactive-capability-required');
    }
    if (
      intent.requiresNetwork &&
      candidate.capabilities.networkAccess === 'none'
    ) {
      exclusionReasons.push('network-capability-required');
    }
    if (intent.requiresCancellation && !candidate.capabilities.cancellation) {
      exclusionReasons.push('cancellation-capability-required');
    }
    if (
      intent.requiresWorkspaceLease &&
      !candidate.capabilities.workspaceLeases
    ) {
      exclusionReasons.push('workspace-lease-required');
    }
    if (exclusionReasons.length > 0) {
      excluded.push({
        providerId: candidate.providerId,
        providerKind: candidate.providerKind,
        reasonCodes: exclusionReasons,
      });
      continue;
    }

    const samples = observations.filter(
      (observation) =>
        observation.commandClassHash === intent.commandClassHash &&
        observation.providerId === candidate.providerId &&
        observation.providerKind === candidate.providerKind &&
        (candidate.environmentFingerprintHash === null ||
          observation.environmentFingerprintHash ===
            candidate.environmentFingerprintHash),
    );
    const successes = samples.filter(
      (observation) =>
        observation.outcome === 'completed' &&
        observation.exitCodeClass === 'zero' &&
        !observation.timedOut,
    ).length;
    const timeouts = samples.filter(
      (observation) => observation.timedOut,
    ).length;
    const failures = samples.length - successes;
    const estimatedDurationMs =
      samples.length === 0
        ? null
        : Math.round(
            samples.reduce(
              (total, observation) => total + observation.durationMs,
              0,
            ) / samples.length,
          );
    const successRate = samples.length === 0 ? 0.5 : successes / samples.length;
    const timeoutRate = samples.length === 0 ? 0 : timeouts / samples.length;
    const failureRate = samples.length === 0 ? 0 : failures / samples.length;
    const latencyScore =
      estimatedDurationMs === null
        ? 0.5
        : 1 / (1 + estimatedDurationMs / 30_000);
    const reasonCodes: RunnerRoutingReasonCode[] = [];
    if (successes > 0) reasonCodes.push('observed-success');
    if (failures > 0) reasonCodes.push('observed-failures');
    if (timeouts > 0) reasonCodes.push('observed-timeouts');
    if (estimatedDurationMs !== null) reasonCodes.push('observed-latency');
    if (candidate.providerId === intent.actualProviderId) {
      reasonCodes.push('actual-provider-preferred');
    }
    ranked.push({
      providerId: candidate.providerId,
      providerKind: candidate.providerKind,
      score:
        successRate * 0.7 +
        latencyScore * 0.3 -
        timeoutRate * policy.timeoutPenalty -
        failureRate * policy.failurePenalty +
        (candidate.providerId === intent.actualProviderId
          ? policy.actualProviderTieBreakBonus
          : 0),
      observationCount: samples.length,
      estimatedDurationMs,
      reasonCodes,
    });
  }
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      Number(right.providerId === intent.actualProviderId) -
        Number(left.providerId === intent.actualProviderId) ||
      left.providerKind.localeCompare(right.providerKind) ||
      left.providerId.localeCompare(right.providerId),
  );

  const evidenceSampleCount = ranked.reduce(
    (total, candidate) => total + candidate.observationCount,
    0,
  );
  if (evidenceSampleCount < policy.minimumEvidenceSamples) {
    const actualEligible = ranked.find(
      (candidate) =>
        candidate.providerId === intent.actualProviderId &&
        candidate.providerKind === intent.actualProviderKind,
    );
    const conservativeRecommendation = actualEligible ?? ranked[0];
    const actualExclusion = excluded.find(
      (candidate) =>
        candidate.providerId === intent.actualProviderId &&
        candidate.providerKind === intent.actualProviderKind,
    );
    return {
      version: 1,
      mode: 'shadow',
      actualProviderId: intent.actualProviderId,
      actualProviderKind: intent.actualProviderKind,
      recommendedProviderId:
        conservativeRecommendation?.providerId ?? actual.providerId,
      recommendedProviderKind:
        conservativeRecommendation?.providerKind ?? actual.providerKind,
      confidence: 0,
      evidenceSampleCount,
      reasonCodes: [
        'insufficient-evidence',
        ...(actualExclusion?.reasonCodes ?? []),
      ],
      ranked,
      excluded,
      policyHash,
    };
  }

  const recommended = ranked[0] ?? {
    providerId: actual.providerId,
    providerKind: actual.providerKind,
    score: 0,
    observationCount: 0,
    estimatedDurationMs: null,
    reasonCodes: ['actual-provider-preferred'] as RunnerRoutingReasonCode[],
  };
  const runnerUp = ranked[1];
  const scoreAdvantage = Math.max(
    0,
    recommended.score - (runnerUp?.score ?? 0),
  );
  return {
    version: 1,
    mode: 'shadow',
    actualProviderId: intent.actualProviderId,
    actualProviderKind: intent.actualProviderKind,
    recommendedProviderId: recommended.providerId,
    recommendedProviderKind: recommended.providerKind,
    confidence: clamp01(
      Math.min(1, evidenceSampleCount / (policy.minimumEvidenceSamples * 3)) *
        Math.min(1, scoreAdvantage * 2),
    ),
    evidenceSampleCount,
    reasonCodes:
      recommended.reasonCodes.length > 0
        ? recommended.reasonCodes
        : ['actual-provider-preferred'],
    ranked,
    excluded,
    policyHash,
  };
}

/**
 * Fail-closed promotion evaluator for guarded automatic routing.
 *
 * A shadow recommendation alone is never enough to switch providers. The
 * recommended provider must have environment-bound evidence, a clean timeout
 * history, a high success rate, and a material score advantage.
 */
export function evaluateRunnerRoutingPromotion(
  decision: RunnerRoutingDecision,
  candidates: readonly RunnerRoutingCandidate[],
  observations: readonly RunnerRoutingObservation[],
  options: RunnerRoutingPromotionPolicyOptions = {},
): RunnerRoutingPromotionEvaluation {
  const policy = normalizePromotionPolicy(options);
  const policyHash = hashCanonical({ version: 1, ...policy });
  const retain = (
    reasonCodes: RunnerRoutingPromotionReasonCode[],
    metrics: {
      providerEvidenceSamples?: number;
      successRate?: number;
      timeoutRate?: number;
      scoreAdvantage?: number;
    } = {},
  ): RunnerRoutingPromotionEvaluation => ({
    version: 1,
    mode: 'retain-configured',
    selectedProviderId: decision.actualProviderId,
    selectedProviderKind: decision.actualProviderKind,
    promoted: false,
    confidence: decision.confidence,
    providerEvidenceSamples: metrics.providerEvidenceSamples ?? 0,
    successRate: metrics.successRate ?? 0,
    timeoutRate: metrics.timeoutRate ?? 0,
    scoreAdvantage: metrics.scoreAdvantage ?? 0,
    reasonCodes,
    policyHash,
  });

  if (
    decision.recommendedProviderId === decision.actualProviderId &&
    decision.recommendedProviderKind === decision.actualProviderKind
  ) {
    return retain(['recommended-provider-is-actual']);
  }

  const candidate = candidates.find(
    (value) =>
      value.providerId === decision.recommendedProviderId &&
      value.providerKind === decision.recommendedProviderKind &&
      value.available,
  );
  if (
    !candidate ||
    (policy.requireEnvironmentFingerprint &&
      candidate.environmentFingerprintHash === null)
  ) {
    return retain(['promotion-environment-unverified']);
  }

  const samples = observations.filter(
    (observation) =>
      observation.providerId === candidate.providerId &&
      observation.providerKind === candidate.providerKind &&
      (candidate.environmentFingerprintHash === null ||
        observation.environmentFingerprintHash ===
          candidate.environmentFingerprintHash),
  );
  const providerEvidenceSamples = samples.length;
  const successes = samples.filter(
    (observation) =>
      observation.outcome === 'completed' &&
      observation.exitCodeClass === 'zero' &&
      !observation.timedOut,
  ).length;
  const timeouts = samples.filter((observation) => observation.timedOut).length;
  const successRate =
    providerEvidenceSamples === 0 ? 0 : successes / providerEvidenceSamples;
  const timeoutRate =
    providerEvidenceSamples === 0 ? 0 : timeouts / providerEvidenceSamples;
  const recommendedRank = decision.ranked.find(
    (value) =>
      value.providerId === candidate.providerId &&
      value.providerKind === candidate.providerKind,
  );
  const runnerUp = decision.ranked.find(
    (value) =>
      value.providerId !== candidate.providerId ||
      value.providerKind !== candidate.providerKind,
  );
  const scoreAdvantage = Math.max(
    0,
    (recommendedRank?.score ?? 0) - (runnerUp?.score ?? 0),
  );
  const metrics = {
    providerEvidenceSamples,
    successRate,
    timeoutRate,
    scoreAdvantage,
  };
  const reasons: RunnerRoutingPromotionReasonCode[] = [];
  if (decision.confidence < policy.minimumConfidence) {
    reasons.push('promotion-confidence-insufficient');
  }
  if (providerEvidenceSamples < policy.minimumProviderEvidenceSamples) {
    reasons.push('promotion-evidence-insufficient');
  }
  if (successRate < policy.minimumSuccessRate) {
    reasons.push('promotion-failure-rate-too-high');
  }
  if (timeoutRate > policy.maximumTimeoutRate) {
    reasons.push('promotion-timeout-observed');
  }
  if (scoreAdvantage < policy.minimumScoreAdvantage) {
    reasons.push('promotion-score-advantage-insufficient');
  }
  if (reasons.length > 0) return retain(reasons, metrics);

  return {
    version: 1,
    mode: 'automatic',
    selectedProviderId: candidate.providerId,
    selectedProviderKind: candidate.providerKind,
    promoted: true,
    confidence: decision.confidence,
    ...metrics,
    reasonCodes: ['promotion-approved'],
    policyHash,
  };
}

function conservativeDecision(
  intent: RunnerRoutingIntent,
  actual: RunnerRoutingCandidate,
  candidates: readonly RunnerRoutingCandidate[],
  policyHash: string,
  reason: RunnerRoutingReasonCode,
): RunnerRoutingDecision {
  return {
    version: 1,
    mode: 'shadow',
    actualProviderId: intent.actualProviderId,
    actualProviderKind: intent.actualProviderKind,
    recommendedProviderId: actual.providerId,
    recommendedProviderKind: actual.providerKind,
    confidence: 0,
    evidenceSampleCount: 0,
    reasonCodes: [reason],
    ranked: candidates
      .filter((candidate) => candidate.available)
      .map((candidate) => ({
        providerId: candidate.providerId,
        providerKind: candidate.providerKind,
        score: candidate.providerId === intent.actualProviderId ? 1 : 0,
        observationCount: 0,
        estimatedDurationMs: null,
        reasonCodes:
          candidate.providerId === intent.actualProviderId
            ? (['actual-provider-preferred'] as RunnerRoutingReasonCode[])
            : [],
      })),
    excluded: candidates
      .filter((candidate) => !candidate.available)
      .map((candidate) => ({
        providerId: candidate.providerId,
        providerKind: candidate.providerKind,
        reasonCodes: ['candidate-unavailable'],
      })),
    policyHash,
  };
}

function fallbackActualCandidate(
  intent: RunnerRoutingIntent,
): RunnerRoutingCandidate {
  return {
    providerId: intent.actualProviderId,
    providerKind: intent.actualProviderKind,
    available: true,
    environmentFingerprintHash: null,
    capabilities: {
      persistentSessions: true,
      streamingOutput: true,
      stdin: true,
      cancellation: true,
      workspaceLeases: true,
      networkAccess: 'host',
    },
  };
}

function normalizePolicy(
  options: RunnerRoutingPolicyOptions,
): Required<RunnerRoutingPolicyOptions> {
  return {
    minimumEvidenceSamples: normalizePositiveInteger(
      options.minimumEvidenceSamples ?? DEFAULT_POLICY.minimumEvidenceSamples,
    ),
    timeoutPenalty: normalizeFiniteNonNegative(
      options.timeoutPenalty ?? DEFAULT_POLICY.timeoutPenalty,
    ),
    failurePenalty: normalizeFiniteNonNegative(
      options.failurePenalty ?? DEFAULT_POLICY.failurePenalty,
    ),
    actualProviderTieBreakBonus: normalizeFiniteNonNegative(
      options.actualProviderTieBreakBonus ??
        DEFAULT_POLICY.actualProviderTieBreakBonus,
    ),
  };
}

function normalizePromotionPolicy(
  options: RunnerRoutingPromotionPolicyOptions,
): Required<RunnerRoutingPromotionPolicyOptions> {
  return {
    minimumConfidence: normalizeUnitInterval(
      options.minimumConfidence ?? DEFAULT_PROMOTION_POLICY.minimumConfidence,
      'minimumConfidence',
    ),
    minimumProviderEvidenceSamples: normalizePositiveInteger(
      options.minimumProviderEvidenceSamples ??
        DEFAULT_PROMOTION_POLICY.minimumProviderEvidenceSamples,
    ),
    minimumSuccessRate: normalizeUnitInterval(
      options.minimumSuccessRate ?? DEFAULT_PROMOTION_POLICY.minimumSuccessRate,
      'minimumSuccessRate',
    ),
    minimumScoreAdvantage: normalizeFiniteNonNegative(
      options.minimumScoreAdvantage ??
        DEFAULT_PROMOTION_POLICY.minimumScoreAdvantage,
    ),
    maximumTimeoutRate: normalizeUnitInterval(
      options.maximumTimeoutRate ?? DEFAULT_PROMOTION_POLICY.maximumTimeoutRate,
      'maximumTimeoutRate',
    ),
    requireEnvironmentFingerprint:
      options.requireEnvironmentFingerprint ??
      DEFAULT_PROMOTION_POLICY.requireEnvironmentFingerprint,
  };
}

function normalizePositiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('minimumEvidenceSamples must be a positive integer');
  }
  return value;
}

function normalizeFiniteNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      'Runner routing policy weights must be finite and non-negative',
    );
  }
  return value;
}

function normalizeUnitInterval(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return value;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export * from './evaluation';
