import { createHash } from 'node:crypto';
import { evidenceMemoryContextContainsClaim } from './context-match';
import type {
  EvidenceMemoryClaim,
  EvidenceMemoryContextPack,
  EvidenceMemoryContextPackExclusionReason,
  EvidenceMemoryInjectionAdmission,
  EvidenceMemoryInjectionReasonCode,
  EvidenceMemoryService,
  RecordEvidenceMemoryClaimInput,
  RecordEvidenceMemoryEventInput,
} from './index';

export const EVIDENCE_MEMORY_DOGFOOD_OBSERVATION_VERSION = 3 as const;

export interface EvidenceMemoryEvaluationScenario {
  id: string;
  taskId: string;
  query: string;
  expectedClaimIds: readonly string[];
  forbiddenClaimIds?: readonly string[];
  repositoryRevision?: string | null;
  tokenBudget?: number;
  category:
    | 'exact_fact'
    | 'user_constraint'
    | 'staleness'
    | 'supersession'
    | 'restart'
    | 'fork_isolation'
    | 'workspace_isolation';
}

export interface EvidenceMemoryEvaluationScenarioResult {
  id: string;
  category: EvidenceMemoryEvaluationScenario['category'];
  expected: number;
  recovered: number;
  leaked: number;
  recall: number;
  latencyMs: number;
  estimatedTokens: number;
  passed: boolean;
}

export interface EvidenceMemoryEvaluationReport {
  scenarios: EvidenceMemoryEvaluationScenarioResult[];
  scenarioCount: number;
  failedScenarioIds: string[];
  exactFactRecall: number;
  userConstraintRecall: number;
  restartRecoveryRate: number;
  staleLeakageRate: number;
  staleEvidenceInjectionRate: number;
  overallRecall: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  averageEstimatedTokens: number;
  totalEstimatedTokens: number;
  maximumEstimatedTokens: number;
  passedTargets: boolean;
}

export interface EvidenceMemoryEvaluationFixture {
  eventCount: number;
  events: RecordEvidenceMemoryEventInput[];
  claims: RecordEvidenceMemoryClaimInput[];
  scenarios: EvidenceMemoryEvaluationScenario[];
}

export type EvidenceMemoryAutoMergeDecision =
  | 'applied'
  | 'manual'
  | 'not-applicable';

export interface EvidenceMemoryQualityObservation {
  observationIdHash: string;
  expectedFactCount: number;
  recoveredFactCount: number;
  staleFactCount: number;
  staleInjectedCount: number;
  baselineTokens: number;
  evidenceMemoryTokens: number;
  synchronization?: {
    expectedToConverge: boolean;
    converged: boolean;
    autoMergeDecision: EvidenceMemoryAutoMergeDecision;
    groundTruthMergeSafe: boolean | null;
  };
}

export interface EvidenceMemoryQualityThresholds {
  minimumObservations?: number;
  minimumSyncObservations?: number;
  minimumUnsafeMergeObservations?: number;
  minimumFactRecall?: number;
  maximumStaleMemoryRate?: number;
  minimumConvergenceRate?: number;
  maximumFalseAutoMergeRate?: number;
  minimumTokenSavingsRatio?: number;
}

export type EvidenceMemoryQualityBlocker =
  | 'insufficient-observations'
  | 'insufficient-sync-observations'
  | 'insufficient-unsafe-merge-coverage'
  | 'fact-recall-below-target'
  | 'stale-memory-above-target'
  | 'convergence-below-target'
  | 'false-auto-merge-above-target'
  | 'token-savings-unmeasurable'
  | 'token-savings-below-target';

export interface EvidenceMemoryQualityReport {
  thresholdVersion: 1;
  policyHash: string;
  observationCount: number;
  syncObservationCount: number;
  unsafeMergeObservationCount: number;
  expectedFactCount: number;
  recoveredFactCount: number;
  factRecall: number;
  staleFactCount: number;
  staleInjectedCount: number;
  staleMemoryRate: number;
  convergedSyncCount: number;
  convergenceRate: number;
  autoMergeAppliedCount: number;
  falseAutoMergeCount: number;
  falseAutoMergeRate: number;
  baselineTotalTokens: number;
  evidenceMemoryTotalTokens: number;
  tokensSaved: number;
  tokenSavingsRatio: number | null;
  promotionReady: boolean;
  promotionBlockers: EvidenceMemoryQualityBlocker[];
}

export interface EvidenceMemoryDogfoodObservation {
  observationVersion: typeof EVIDENCE_MEMORY_DOGFOOD_OBSERVATION_VERSION;
  scenarioIdHash: string;
  sourceTaskHash?: string;
  cohortIdHash?: string;
  observedAt?: number;
  category: EvidenceMemoryEvaluationScenario['category'];
  expectedClaimSource?: 'context-pack' | 'explicit';
  expectedClaimCount: number;
  retrievalRecoveredCount?: number;
  admissionRecoveredCount?: number;
  compressedHistoryRecoveredCount: number;
  guardedMemoryRecoveredCount: number;
  forbiddenClaimCount: number;
  compressedHistoryLeakedCount: number;
  guardedMemoryLeakedCount: number;
  compressedHistoryTokens: number;
  guardedMemoryTokens: number;
  compressedHistoryLatencyMs: number;
  guardedMemoryLatencyMs: number;
  missingProvenanceAdmissionCount?: number;
  unresolvedContradictionInjectionCount?: number;
  diagnostics?: EvidenceMemoryDogfoodObservationDiagnostics;
}

export interface EvidenceMemoryDogfoodObservationDiagnostics {
  retrievalCandidateCount: number;
  retrievalSelectedCount: number;
  retrievalExclusionReasonCounts: Partial<
    Record<EvidenceMemoryContextPackExclusionReason, number>
  >;
  admissionCandidateCount: number;
  admissionSelectedCount: number;
  admissionReasonCodeCounts: Partial<
    Record<EvidenceMemoryInjectionReasonCode, number>
  >;
  guardedEnvelopeTokens: number;
  guardedClaimTokenContributions: number[];
}

export interface EvidenceMemoryDogfoodThresholds {
  minimumObservations?: number;
  minimumGuardedRecall?: number;
  minimumRecallLift?: number;
  maximumGuardedStaleLeakageRate?: number;
  maximumGuardedLatencyP95Ms?: number;
  maximumTokenOverheadRatio?: number;
}

export type EvidenceMemoryPromotionBlocker =
  | 'insufficient-observations'
  | 'guarded-recall-below-target'
  | 'recall-lift-below-target'
  | 'guarded-stale-leakage-above-target'
  | 'guarded-latency-above-target'
  | 'token-overhead-unmeasurable'
  | 'token-overhead-above-target'
  | 'missing-provenance-admissions'
  | 'unresolved-contradiction-injections'
  | 'insufficient-distinct-tasks'
  | 'insufficient-exact-fact-coverage'
  | 'insufficient-user-constraint-coverage'
  | 'insufficient-staleness-coverage'
  | 'insufficient-supersession-coverage'
  | 'insufficient-restart-coverage';

export interface EvidenceMemoryDogfoodReport {
  observationVersion: typeof EVIDENCE_MEMORY_DOGFOOD_OBSERVATION_VERSION;
  thresholdVersion: 1;
  policyHash: string;
  sampleCount: number;
  expectedClaimCount: number;
  forbiddenClaimCount: number;
  retrievalRecoveredClaimCount: number;
  admissionRecoveredClaimCount: number;
  retrievalRecall: number;
  retrievalLossCount: number;
  admissionLossCount: number;
  compressedHistoryRecall: number;
  guardedMemoryRecall: number;
  recallLift: number;
  compressedHistoryStaleLeakageRate: number;
  guardedMemoryStaleLeakageRate: number;
  compressedHistoryLatencyP95Ms: number;
  guardedMemoryLatencyP95Ms: number;
  compressedHistoryTotalTokens: number;
  guardedMemoryTotalTokens: number;
  tokenOverheadRatio: number | null;
  missingProvenanceAdmissionCount: number;
  unresolvedContradictionInjectionCount: number;
  retrievalCandidateCount: number;
  retrievalSelectedCount: number;
  retrievalExclusionReasonCounts: Partial<
    Record<EvidenceMemoryContextPackExclusionReason, number>
  >;
  admissionCandidateCount: number;
  admissionSelectedCount: number;
  admissionReasonCodeCounts: Partial<
    Record<EvidenceMemoryInjectionReasonCode, number>
  >;
  guardedEnvelopeTotalTokens: number;
  guardedClaimTotalTokens: number;
  guardedTokensPerAdmittedClaim: number | null;
  promotionReady: boolean;
  promotionBlockers: EvidenceMemoryPromotionBlocker[];
}

export interface EvidenceMemoryDogfoodCohortThresholds
  extends EvidenceMemoryDogfoodThresholds {
  freshnessWindowMs?: number;
  minimumDistinctTasks?: number;
  minimumExactFactObservations?: number;
  minimumUserConstraintObservations?: number;
  minimumStalenessObservations?: number;
  minimumSupersessionObservations?: number;
  minimumRestartObservations?: number;
}

export interface EvidenceMemoryDogfoodCohortReport
  extends EvidenceMemoryDogfoodReport {
  totalObservationCount: number;
  staleObservationCount: number;
  freshnessWindowMs: number;
  distinctTaskCount: number;
  categoryCoverage: Record<
    EvidenceMemoryEvaluationScenario['category'],
    number
  >;
}

export interface EvidenceMemoryCompressedHistoryResult {
  recoveredClaimIds: readonly string[];
  estimatedTokens: number;
  latencyMs: number;
}

export interface RunEvidenceMemoryDogfoodComparisonOptions {
  evaluateCompressedHistory: (
    scenario: EvidenceMemoryEvaluationScenario,
  ) => Promise<EvidenceMemoryCompressedHistoryResult>;
  thresholds?: EvidenceMemoryDogfoodThresholds;
  recordReceipt?: boolean;
  receiptSource?: string;
}

export interface CreateEvidenceMemoryLiveDogfoodObservationInput {
  pack: EvidenceMemoryContextPack;
  admission: EvidenceMemoryInjectionAdmission;
  expectedClaims?: readonly EvidenceMemoryClaim[];
  compressedHistory: string;
  compressedHistoryLatencyMs: number;
  guardedMemoryLatencyMs: number;
  staleClaims?: readonly EvidenceMemoryClaim[];
  forbiddenClaims?: readonly EvidenceMemoryClaim[];
  categoryOverride?: EvidenceMemoryEvaluationScenario['category'];
  scenarioIdSeed?: string;
  sourceTaskHash?: string;
  cohortIdHash?: string;
  observedAt?: number;
}

type NormalizedEvidenceMemoryDogfoodThresholds =
  Required<EvidenceMemoryDogfoodThresholds>;

const DEFAULT_DOGFOOD_THRESHOLDS: NormalizedEvidenceMemoryDogfoodThresholds =
  Object.freeze({
    minimumObservations: 100,
    minimumGuardedRecall: 0.95,
    minimumRecallLift: 0.1,
    maximumGuardedStaleLeakageRate: 0.01,
    maximumGuardedLatencyP95Ms: 250,
    maximumTokenOverheadRatio: 0.2,
  });

const DEFAULT_COHORT_THRESHOLDS = Object.freeze({
  freshnessWindowMs: 30 * 24 * 60 * 60 * 1_000,
  minimumDistinctTasks: 3,
  minimumExactFactObservations: 45,
  minimumUserConstraintObservations: 20,
  minimumStalenessObservations: 15,
  minimumSupersessionObservations: 10,
  minimumRestartObservations: 10,
});

const DEFAULT_QUALITY_THRESHOLDS = Object.freeze({
  minimumObservations: 100,
  minimumSyncObservations: 20,
  minimumUnsafeMergeObservations: 10,
  minimumFactRecall: 0.95,
  maximumStaleMemoryRate: 0.01,
  minimumConvergenceRate: 0.99,
  maximumFalseAutoMergeRate: 0,
  minimumTokenSavingsRatio: 0.3,
});

type NormalizedEvidenceMemoryQualityThresholds =
  Required<EvidenceMemoryQualityThresholds>;

export function evaluateEvidenceMemoryQuality(
  observations: readonly EvidenceMemoryQualityObservation[],
  thresholds: EvidenceMemoryQualityThresholds = {},
): EvidenceMemoryQualityReport {
  const target = normalizeQualityThresholds(thresholds);
  observations.forEach(validateQualityObservation);
  const expectedFactCount = sum(
    observations,
    (observation) => observation.expectedFactCount,
  );
  const recoveredFactCount = sum(
    observations,
    (observation) => observation.recoveredFactCount,
  );
  const staleFactCount = sum(
    observations,
    (observation) => observation.staleFactCount,
  );
  const staleInjectedCount = sum(
    observations,
    (observation) => observation.staleInjectedCount,
  );
  const sync = observations.flatMap((observation) =>
    observation.synchronization ? [observation.synchronization] : [],
  );
  const expectedSync = sync.filter(
    (observation) => observation.expectedToConverge,
  );
  const convergedSyncCount = expectedSync.filter(
    (observation) => observation.converged,
  ).length;
  const unsafeMergeObservationCount = sync.filter(
    (observation) => observation.groundTruthMergeSafe === false,
  ).length;
  const autoMergeAppliedCount = sync.filter(
    (observation) => observation.autoMergeDecision === 'applied',
  ).length;
  const falseAutoMergeCount = sync.filter(
    (observation) =>
      observation.autoMergeDecision === 'applied' &&
      observation.groundTruthMergeSafe === false,
  ).length;
  const baselineTotalTokens = sum(
    observations,
    (observation) => observation.baselineTokens,
  );
  const evidenceMemoryTotalTokens = sum(
    observations,
    (observation) => observation.evidenceMemoryTokens,
  );
  const tokensSaved = baselineTotalTokens - evidenceMemoryTotalTokens;
  const tokenSavingsRatio =
    baselineTotalTokens === 0
      ? evidenceMemoryTotalTokens === 0
        ? 0
        : null
      : tokensSaved / baselineTotalTokens;
  const factRecall = safeRecall(recoveredFactCount, expectedFactCount);
  const staleMemoryRate = safeLeakage(staleInjectedCount, staleFactCount);
  const convergenceRate = safeRecall(convergedSyncCount, expectedSync.length);
  const falseAutoMergeRate = safeLeakage(
    falseAutoMergeCount,
    unsafeMergeObservationCount,
  );
  const blockers: EvidenceMemoryQualityBlocker[] = [];
  if (observations.length < target.minimumObservations) {
    blockers.push('insufficient-observations');
  }
  if (sync.length < target.minimumSyncObservations) {
    blockers.push('insufficient-sync-observations');
  }
  if (unsafeMergeObservationCount < target.minimumUnsafeMergeObservations) {
    blockers.push('insufficient-unsafe-merge-coverage');
  }
  if (factRecall < target.minimumFactRecall) {
    blockers.push('fact-recall-below-target');
  }
  if (staleMemoryRate > target.maximumStaleMemoryRate) {
    blockers.push('stale-memory-above-target');
  }
  if (convergenceRate < target.minimumConvergenceRate) {
    blockers.push('convergence-below-target');
  }
  if (falseAutoMergeRate > target.maximumFalseAutoMergeRate) {
    blockers.push('false-auto-merge-above-target');
  }
  if (tokenSavingsRatio === null) {
    blockers.push('token-savings-unmeasurable');
  } else if (tokenSavingsRatio < target.minimumTokenSavingsRatio) {
    blockers.push('token-savings-below-target');
  }
  return {
    thresholdVersion: 1,
    policyHash: hashQualityPolicy(target),
    observationCount: observations.length,
    syncObservationCount: sync.length,
    unsafeMergeObservationCount,
    expectedFactCount,
    recoveredFactCount,
    factRecall,
    staleFactCount,
    staleInjectedCount,
    staleMemoryRate,
    convergedSyncCount,
    convergenceRate,
    autoMergeAppliedCount,
    falseAutoMergeCount,
    falseAutoMergeRate,
    baselineTotalTokens,
    evidenceMemoryTotalTokens,
    tokensSaved,
    tokenSavingsRatio,
    promotionReady: blockers.length === 0,
    promotionBlockers: blockers,
  };
}

export function createEvidenceMemoryQualityFixture(
  observationCount: 100 | 500 | 1_000,
): EvidenceMemoryQualityObservation[] {
  return Array.from({ length: observationCount }, (_, offset) => {
    const index = offset + 1;
    const isSync = index % 5 === 0;
    const unsafeMerge = isSync && index % 10 === 0;
    return {
      observationIdHash: createHash('sha256')
        .update(`evidence-memory-quality-v1:${observationCount}:${index}`)
        .digest('hex'),
      expectedFactCount: 1,
      recoveredFactCount: 1,
      staleFactCount: index % 10 === 0 ? 1 : 0,
      staleInjectedCount: 0,
      baselineTokens: 6_000,
      evidenceMemoryTokens: 1_200 + (index % 7) * 10,
      synchronization: isSync
        ? {
            expectedToConverge: true,
            converged: true,
            autoMergeDecision: unsafeMerge ? 'manual' : 'applied',
            groundTruthMergeSafe: !unsafeMerge,
          }
        : undefined,
    };
  });
}

export function toEvidenceMemoryQualityReceipt(
  report: EvidenceMemoryQualityReport,
): Record<string, string | number | boolean | null | string[]> {
  return {
    thresholdVersion: report.thresholdVersion,
    policyHash: report.policyHash,
    observationCount: report.observationCount,
    syncObservationCount: report.syncObservationCount,
    unsafeMergeObservationCount: report.unsafeMergeObservationCount,
    expectedFactCount: report.expectedFactCount,
    recoveredFactCount: report.recoveredFactCount,
    factRecall: report.factRecall,
    staleFactCount: report.staleFactCount,
    staleInjectedCount: report.staleInjectedCount,
    staleMemoryRate: report.staleMemoryRate,
    convergedSyncCount: report.convergedSyncCount,
    convergenceRate: report.convergenceRate,
    autoMergeAppliedCount: report.autoMergeAppliedCount,
    falseAutoMergeCount: report.falseAutoMergeCount,
    falseAutoMergeRate: report.falseAutoMergeRate,
    baselineTotalTokens: report.baselineTotalTokens,
    evidenceMemoryTotalTokens: report.evidenceMemoryTotalTokens,
    tokensSaved: report.tokensSaved,
    tokenSavingsRatio: report.tokenSavingsRatio,
    promotionReady: report.promotionReady,
    promotionBlockers: report.promotionBlockers,
  };
}

export async function runEvidenceMemoryEvaluation(
  service: EvidenceMemoryService,
  scenarios: readonly EvidenceMemoryEvaluationScenario[],
  now: () => number = performance.now.bind(performance),
): Promise<EvidenceMemoryEvaluationReport> {
  const results: EvidenceMemoryEvaluationScenarioResult[] = [];
  for (const scenario of scenarios) {
    const startedAt = now();
    const pack = await service.buildContextPack({
      taskId: scenario.taskId,
      query: scenario.query,
      repositoryRevision: scenario.repositoryRevision,
      tokenBudget: scenario.tokenBudget,
      recordShadowRun: false,
    });
    const latencyMs = Math.max(0, now() - startedAt);
    const actual = new Set(pack.items.map((item) => item.claim.id));
    const recovered = scenario.expectedClaimIds.filter((id) =>
      actual.has(id),
    ).length;
    const leaked = (scenario.forbiddenClaimIds ?? []).filter((id) =>
      actual.has(id),
    ).length;
    const recall =
      scenario.expectedClaimIds.length === 0
        ? 1
        : recovered / scenario.expectedClaimIds.length;
    results.push({
      id: scenario.id,
      category: scenario.category,
      expected: scenario.expectedClaimIds.length,
      recovered,
      leaked,
      recall,
      latencyMs,
      estimatedTokens: pack.estimatedTokens,
      passed: recall === 1 && leaked === 0,
    });
  }

  const exactFactRecall = categoryRecall(results, 'exact_fact');
  const userConstraintRecall = categoryRecall(results, 'user_constraint');
  const restartRecoveryRate = categoryRecall(results, 'restart');
  const totalForbidden = scenarios.reduce(
    (sum, scenario) => sum + (scenario.forbiddenClaimIds?.length ?? 0),
    0,
  );
  const totalLeaked = results.reduce((sum, result) => sum + result.leaked, 0);
  const staleLeakageRate =
    totalForbidden === 0 ? 0 : totalLeaked / totalForbidden;
  const totalExpected = results.reduce(
    (sum, result) => sum + result.expected,
    0,
  );
  const totalRecovered = results.reduce(
    (sum, result) => sum + result.recovered,
    0,
  );
  const overallRecall =
    totalExpected === 0 ? 1 : totalRecovered / totalExpected;
  const latencyP95Ms = percentile(
    results.map((result) => result.latencyMs),
    0.95,
  );
  const latencyP50Ms = percentile(
    results.map((result) => result.latencyMs),
    0.5,
  );
  const totalEstimatedTokens = results.reduce(
    (sum, result) => sum + result.estimatedTokens,
    0,
  );
  const averageEstimatedTokens =
    results.length === 0 ? 0 : totalEstimatedTokens / results.length;
  const maximumEstimatedTokens = Math.max(
    0,
    ...results.map((result) => result.estimatedTokens),
  );
  return {
    scenarios: results,
    scenarioCount: results.length,
    failedScenarioIds: results
      .filter((result) => !result.passed)
      .map((result) => result.id),
    exactFactRecall,
    userConstraintRecall,
    restartRecoveryRate,
    staleLeakageRate,
    staleEvidenceInjectionRate: staleLeakageRate,
    overallRecall,
    latencyP50Ms,
    latencyP95Ms,
    averageEstimatedTokens,
    totalEstimatedTokens,
    maximumEstimatedTokens,
    passedTargets:
      exactFactRecall >= 0.95 &&
      userConstraintRecall === 1 &&
      restartRecoveryRate >= 0.95 &&
      staleLeakageRate < 0.01 &&
      latencyP95Ms < 100 &&
      maximumEstimatedTokens <= 15_000,
  };
}

/**
 * Compares Guarded Memory and compressed history over the same scenarios.
 * The caller owns baseline judging because compressed history is free-form
 * text; only hashed scenario identity and aggregate counts enter dogfood
 * observations or the protected receipt.
 */
export async function runEvidenceMemoryDogfoodComparison(
  service: EvidenceMemoryService,
  scenarios: readonly EvidenceMemoryEvaluationScenario[],
  options: RunEvidenceMemoryDogfoodComparisonOptions,
  now: () => number = performance.now.bind(performance),
): Promise<EvidenceMemoryDogfoodReport> {
  const observations: EvidenceMemoryDogfoodObservation[] = [];
  for (const scenario of scenarios) {
    const baseline = await options.evaluateCompressedHistory(scenario);
    const guardedStartedAt = now();
    const pack = await service.buildContextPack({
      taskId: scenario.taskId,
      query: scenario.query,
      repositoryRevision: scenario.repositoryRevision,
      tokenBudget: scenario.tokenBudget,
      recordShadowRun: false,
    });
    const guardedLatencyMs = Math.max(0, now() - guardedStartedAt);
    const expected = new Set(scenario.expectedClaimIds);
    const forbidden = new Set(scenario.forbiddenClaimIds ?? []);
    const baselineRecovered = new Set(baseline.recoveredClaimIds);
    const retrieved = new Set(pack.items.map((item) => item.claim.id));
    const effectiveGuarded = new Set([...baselineRecovered, ...retrieved]);
    const incrementalItems = pack.items.filter(
      (item) => !baselineRecovered.has(item.claim.id),
    );
    const incrementalEvidenceTokens =
      incrementalItems.length === 0
        ? 0
        : pack.diagnostics.envelopeTokens +
          incrementalItems.reduce(
            (total, item) => total + item.estimatedTokens,
            0,
          );
    observations.push({
      observationVersion: EVIDENCE_MEMORY_DOGFOOD_OBSERVATION_VERSION,
      scenarioIdHash: createHash('sha256').update(scenario.id).digest('hex'),
      category: scenario.category,
      expectedClaimSource: 'explicit',
      expectedClaimCount: expected.size,
      retrievalRecoveredCount: intersectionSize(expected, retrieved),
      admissionRecoveredCount: intersectionSize(expected, retrieved),
      compressedHistoryRecoveredCount: intersectionSize(
        expected,
        baselineRecovered,
      ),
      guardedMemoryRecoveredCount: intersectionSize(expected, effectiveGuarded),
      forbiddenClaimCount: forbidden.size,
      compressedHistoryLeakedCount: intersectionSize(
        forbidden,
        baselineRecovered,
      ),
      guardedMemoryLeakedCount: intersectionSize(forbidden, effectiveGuarded),
      compressedHistoryTokens: baseline.estimatedTokens,
      guardedMemoryTokens: baseline.estimatedTokens + incrementalEvidenceTokens,
      compressedHistoryLatencyMs: baseline.latencyMs,
      guardedMemoryLatencyMs: guardedLatencyMs,
    });
  }

  const report = evaluateEvidenceMemoryDogfood(
    observations,
    options.thresholds,
  );
  if (options.recordReceipt) {
    const taskIds = new Set(scenarios.map((scenario) => scenario.taskId));
    if (taskIds.size !== 1) {
      throw new Error(
        'Evidence Memory dogfood receipts require one task-scoped scenario set',
      );
    }
    const taskId = scenarios[0]?.taskId;
    if (!taskId) {
      throw new Error(
        'Evidence Memory dogfood receipts require at least one scenario',
      );
    }
    await service.record({
      taskId,
      type: 'memory_dogfood_evaluated',
      source: options.receiptSource ?? 'evidence_memory_dogfood',
      ingestionKey: `memory-dogfood:${report.policyHash}:${report.sampleCount}:${report.guardedMemoryRecall}:${report.guardedMemoryStaleLeakageRate}`,
      payload: toEvidenceMemoryDogfoodReceipt(report),
    });
  }
  return report;
}

export function evaluateEvidenceMemoryDogfood(
  observations: readonly EvidenceMemoryDogfoodObservation[],
  thresholds: EvidenceMemoryDogfoodThresholds = {},
): EvidenceMemoryDogfoodReport {
  const target = normalizeDogfoodThresholds(thresholds);
  observations.forEach(validateDogfoodObservation);

  const expectedClaimCount = sum(
    observations,
    (observation) => observation.expectedClaimCount,
  );
  const retrievalRecoveredClaimCount = sum(
    observations,
    (observation) =>
      observation.retrievalRecoveredCount ?? observation.expectedClaimCount,
  );
  const admissionRecoveredClaimCount = sum(
    observations,
    (observation) =>
      observation.admissionRecoveredCount ??
      observation.guardedMemoryRecoveredCount,
  );
  const forbiddenClaimCount = sum(
    observations,
    (observation) => observation.forbiddenClaimCount,
  );
  const compressedHistoryRecovered = sum(
    observations,
    (observation) => observation.compressedHistoryRecoveredCount,
  );
  const guardedMemoryRecovered = sum(
    observations,
    (observation) => observation.guardedMemoryRecoveredCount,
  );
  const compressedHistoryLeaked = sum(
    observations,
    (observation) => observation.compressedHistoryLeakedCount,
  );
  const guardedMemoryLeaked = sum(
    observations,
    (observation) => observation.guardedMemoryLeakedCount,
  );
  const compressedHistoryTotalTokens = sum(
    observations,
    (observation) => observation.compressedHistoryTokens,
  );
  const guardedMemoryTotalTokens = sum(
    observations,
    (observation) => observation.guardedMemoryTokens,
  );
  const compressedHistoryRecall = safeRecall(
    compressedHistoryRecovered,
    expectedClaimCount,
  );
  const guardedMemoryRecall = safeRecall(
    guardedMemoryRecovered,
    expectedClaimCount,
  );
  const retrievalRecall = safeRecall(
    retrievalRecoveredClaimCount,
    expectedClaimCount,
  );
  const tokenOverheadRatio =
    compressedHistoryTotalTokens === 0
      ? guardedMemoryTotalTokens === 0
        ? 0
        : null
      : (guardedMemoryTotalTokens - compressedHistoryTotalTokens) /
        compressedHistoryTotalTokens;
  const missingProvenanceAdmissionCount = sum(
    observations,
    (observation) => observation.missingProvenanceAdmissionCount ?? 0,
  );
  const unresolvedContradictionInjectionCount = sum(
    observations,
    (observation) => observation.unresolvedContradictionInjectionCount ?? 0,
  );
  const retrievalCandidateCount = sum(
    observations,
    (observation) => observation.diagnostics?.retrievalCandidateCount ?? 0,
  );
  const retrievalSelectedCount = sum(
    observations,
    (observation) => observation.diagnostics?.retrievalSelectedCount ?? 0,
  );
  const admissionCandidateCount = sum(
    observations,
    (observation) => observation.diagnostics?.admissionCandidateCount ?? 0,
  );
  const admissionSelectedCount = sum(
    observations,
    (observation) => observation.diagnostics?.admissionSelectedCount ?? 0,
  );
  const retrievalExclusionReasonCounts = mergeDogfoodReasonCounts(
    observations.map(
      (observation) =>
        observation.diagnostics?.retrievalExclusionReasonCounts ?? {},
    ),
  );
  const admissionReasonCodeCounts = mergeDogfoodReasonCounts(
    observations.map(
      (observation) => observation.diagnostics?.admissionReasonCodeCounts ?? {},
    ),
  );
  const guardedEnvelopeTotalTokens = sum(
    observations,
    (observation) => observation.diagnostics?.guardedEnvelopeTokens ?? 0,
  );
  const guardedClaimTotalTokens = sum(
    observations,
    (observation) =>
      observation.diagnostics?.guardedClaimTokenContributions.reduce(
        (total, value) => total + value,
        0,
      ) ?? 0,
  );
  const guardedMemoryStaleLeakageRate = safeLeakage(
    guardedMemoryLeaked,
    forbiddenClaimCount,
  );
  const guardedMemoryLatencyP95Ms = percentile(
    observations.map((observation) => observation.guardedMemoryLatencyMs),
    0.95,
  );
  const blockers: EvidenceMemoryPromotionBlocker[] = [];
  if (observations.length < target.minimumObservations) {
    blockers.push('insufficient-observations');
  }
  if (guardedMemoryRecall < target.minimumGuardedRecall) {
    blockers.push('guarded-recall-below-target');
  }
  if (
    guardedMemoryRecall - compressedHistoryRecall <
    target.minimumRecallLift
  ) {
    blockers.push('recall-lift-below-target');
  }
  if (guardedMemoryStaleLeakageRate > target.maximumGuardedStaleLeakageRate) {
    blockers.push('guarded-stale-leakage-above-target');
  }
  if (guardedMemoryLatencyP95Ms > target.maximumGuardedLatencyP95Ms) {
    blockers.push('guarded-latency-above-target');
  }
  if (tokenOverheadRatio === null) {
    blockers.push('token-overhead-unmeasurable');
  } else if (tokenOverheadRatio > target.maximumTokenOverheadRatio) {
    blockers.push('token-overhead-above-target');
  }
  if (missingProvenanceAdmissionCount > 0) {
    blockers.push('missing-provenance-admissions');
  }
  if (unresolvedContradictionInjectionCount > 0) {
    blockers.push('unresolved-contradiction-injections');
  }

  return {
    observationVersion: EVIDENCE_MEMORY_DOGFOOD_OBSERVATION_VERSION,
    thresholdVersion: 1,
    policyHash: hashDogfoodPolicy(target),
    sampleCount: observations.length,
    expectedClaimCount,
    forbiddenClaimCount,
    retrievalRecoveredClaimCount,
    admissionRecoveredClaimCount,
    retrievalRecall,
    retrievalLossCount: Math.max(
      0,
      expectedClaimCount - retrievalRecoveredClaimCount,
    ),
    admissionLossCount: Math.max(
      0,
      retrievalRecoveredClaimCount - admissionRecoveredClaimCount,
    ),
    compressedHistoryRecall,
    guardedMemoryRecall,
    recallLift: guardedMemoryRecall - compressedHistoryRecall,
    compressedHistoryStaleLeakageRate: safeLeakage(
      compressedHistoryLeaked,
      forbiddenClaimCount,
    ),
    guardedMemoryStaleLeakageRate,
    compressedHistoryLatencyP95Ms: percentile(
      observations.map((observation) => observation.compressedHistoryLatencyMs),
      0.95,
    ),
    guardedMemoryLatencyP95Ms,
    compressedHistoryTotalTokens,
    guardedMemoryTotalTokens,
    tokenOverheadRatio,
    missingProvenanceAdmissionCount,
    unresolvedContradictionInjectionCount,
    retrievalCandidateCount,
    retrievalSelectedCount,
    retrievalExclusionReasonCounts,
    admissionCandidateCount,
    admissionSelectedCount,
    admissionReasonCodeCounts,
    guardedEnvelopeTotalTokens,
    guardedClaimTotalTokens,
    guardedTokensPerAdmittedClaim:
      admissionSelectedCount === 0
        ? null
        : guardedClaimTotalTokens / admissionSelectedCount,
    promotionReady: blockers.length === 0,
    promotionBlockers: blockers,
  };
}

/**
 * Builds a content-free paired observation from a real agent step.
 *
 * The retrieved current Context Pack is the deterministic relevance oracle.
 * Compressed-history recovery is deliberately lexical: a claim is counted
 * only when enough distinctive claim terms survived in the lossy summary.
 * This avoids a second model call and keeps dogfood collection local.
 */
export function createEvidenceMemoryLiveDogfoodObservation(
  input: CreateEvidenceMemoryLiveDogfoodObservationInput,
): EvidenceMemoryDogfoodObservation {
  const baselineStartedAt = Math.max(0, input.compressedHistoryLatencyMs);
  const expectedClaims = [
    ...(input.expectedClaims ?? input.pack.items.map((item) => item.claim)),
  ].filter(
    (claim, index, claims) =>
      claims.findIndex((candidate) => candidate.id === claim.id) === index,
  );
  const retrievedIds = new Set(input.pack.items.map((item) => item.claim.id));
  const admittedIds = new Set(
    input.admission.selectedItems.map((item) => item.claim.id),
  );
  const forbiddenClaims = [
    ...(input.staleClaims ?? []),
    ...(input.forbiddenClaims ?? []),
  ].filter(
    (claim, index, claims) =>
      claims.findIndex((candidate) => candidate.id === claim.id) === index,
  );
  const missingProvenanceAdmissionCount = input.admission.selectedItems.filter(
    (item) => item.claim.evidenceEventIds.length === 0,
  ).length;
  const retrievalExclusionReasonCounts = countDogfoodReasons(
    input.pack.exclusions.map((exclusion) => exclusion.reason),
  );
  const admissionDiagnostics = input.admission.diagnostics;
  const baselineRecoveredIds = new Set(
    expectedClaims
      .filter((claim) =>
        evidenceMemoryContextContainsClaim(input.compressedHistory, claim),
      )
      .map((claim) => claim.id),
  );
  const effectiveGuardedIds = new Set([
    ...baselineRecoveredIds,
    ...admittedIds,
  ]);
  const baselineLeakedIds = new Set(
    forbiddenClaims
      .filter((claim) =>
        evidenceMemoryContextContainsClaim(input.compressedHistory, claim),
      )
      .map((claim) => claim.id),
  );
  const effectiveLeakedIds = new Set([...baselineLeakedIds, ...admittedIds]);
  const compressedHistoryTokens = Math.ceil(input.compressedHistory.length / 4);
  return {
    observationVersion: EVIDENCE_MEMORY_DOGFOOD_OBSERVATION_VERSION,
    scenarioIdHash: createHash('sha256')
      .update(
        input.scenarioIdSeed ??
          `${input.pack.taskId}\0${input.pack.id}\0${input.pack.queryHash}\0live-dogfood-v3`,
      )
      .digest('hex'),
    sourceTaskHash: input.sourceTaskHash,
    cohortIdHash: input.cohortIdHash,
    observedAt: input.observedAt,
    category:
      input.categoryOverride ??
      dominantDogfoodCategory(expectedClaims, forbiddenClaims),
    expectedClaimSource:
      input.expectedClaims === undefined ? 'context-pack' : 'explicit',
    expectedClaimCount: expectedClaims.length,
    retrievalRecoveredCount: expectedClaims.filter((claim) =>
      retrievedIds.has(claim.id),
    ).length,
    admissionRecoveredCount: expectedClaims.filter((claim) =>
      admittedIds.has(claim.id),
    ).length,
    compressedHistoryRecoveredCount: baselineRecoveredIds.size,
    guardedMemoryRecoveredCount: expectedClaims.filter((claim) =>
      effectiveGuardedIds.has(claim.id),
    ).length,
    forbiddenClaimCount: forbiddenClaims.length,
    compressedHistoryLeakedCount: baselineLeakedIds.size,
    guardedMemoryLeakedCount: forbiddenClaims.filter((claim) =>
      effectiveLeakedIds.has(claim.id),
    ).length,
    compressedHistoryTokens,
    guardedMemoryTokens:
      compressedHistoryTokens + input.admission.estimatedTokens,
    compressedHistoryLatencyMs: baselineStartedAt,
    guardedMemoryLatencyMs: Math.max(0, input.guardedMemoryLatencyMs),
    missingProvenanceAdmissionCount,
    unresolvedContradictionInjectionCount:
      input.admission.admitted &&
      input.admission.reasonCodes.includes('unresolved-conflict')
        ? 1
        : 0,
    diagnostics: {
      retrievalCandidateCount: input.pack.diagnostics.candidateCount,
      retrievalSelectedCount: input.pack.items.length,
      retrievalExclusionReasonCounts,
      admissionCandidateCount:
        admissionDiagnostics?.candidateCount ?? input.pack.items.length,
      admissionSelectedCount:
        admissionDiagnostics?.selectedCount ??
        input.admission.selectedItems.length,
      admissionReasonCodeCounts:
        admissionDiagnostics?.reasonCodeCounts ??
        countDogfoodReasons(input.admission.reasonCodes),
      guardedEnvelopeTokens: admissionDiagnostics?.envelopeTokens ?? 0,
      guardedClaimTokenContributions:
        admissionDiagnostics?.selectedItemTokenContributions ?? [],
    },
  };
}

export function evaluateEvidenceMemoryDogfoodCohort(
  observations: readonly EvidenceMemoryDogfoodObservation[],
  thresholds: EvidenceMemoryDogfoodCohortThresholds = {},
  now: number = Date.now(),
): EvidenceMemoryDogfoodCohortReport {
  const freshnessWindowMs = finiteNonNegative(
    thresholds.freshnessWindowMs ?? DEFAULT_COHORT_THRESHOLDS.freshnessWindowMs,
  );
  const fresh = observations.filter(
    (observation) =>
      observation.observedAt === undefined ||
      now - observation.observedAt <= freshnessWindowMs,
  );
  const base = evaluateEvidenceMemoryDogfood(fresh, thresholds);
  const categoryCoverage = emptyCategoryCoverage();
  for (const observation of fresh) {
    categoryCoverage[observation.category] += 1;
  }
  const distinctTaskCount = new Set(
    fresh
      .map((observation) => observation.sourceTaskHash)
      .filter((value): value is string => typeof value === 'string'),
  ).size;
  const blockers = [...base.promotionBlockers];
  if (
    distinctTaskCount <
    positiveInteger(
      thresholds.minimumDistinctTasks ??
        DEFAULT_COHORT_THRESHOLDS.minimumDistinctTasks,
    )
  ) {
    blockers.push('insufficient-distinct-tasks');
  }
  addCoverageBlocker(
    blockers,
    categoryCoverage.exact_fact,
    thresholds.minimumExactFactObservations ??
      DEFAULT_COHORT_THRESHOLDS.minimumExactFactObservations,
    'insufficient-exact-fact-coverage',
  );
  addCoverageBlocker(
    blockers,
    categoryCoverage.user_constraint,
    thresholds.minimumUserConstraintObservations ??
      DEFAULT_COHORT_THRESHOLDS.minimumUserConstraintObservations,
    'insufficient-user-constraint-coverage',
  );
  addCoverageBlocker(
    blockers,
    categoryCoverage.staleness,
    thresholds.minimumStalenessObservations ??
      DEFAULT_COHORT_THRESHOLDS.minimumStalenessObservations,
    'insufficient-staleness-coverage',
  );
  addCoverageBlocker(
    blockers,
    categoryCoverage.supersession,
    thresholds.minimumSupersessionObservations ??
      DEFAULT_COHORT_THRESHOLDS.minimumSupersessionObservations,
    'insufficient-supersession-coverage',
  );
  addCoverageBlocker(
    blockers,
    categoryCoverage.restart,
    thresholds.minimumRestartObservations ??
      DEFAULT_COHORT_THRESHOLDS.minimumRestartObservations,
    'insufficient-restart-coverage',
  );
  const cohortPolicyHash = createHash('sha256')
    .update(
      JSON.stringify({
        basePolicyHash: base.policyHash,
        observationVersion: EVIDENCE_MEMORY_DOGFOOD_OBSERVATION_VERSION,
        thresholdVersion: 1,
        freshnessWindowMs,
        minimumDistinctTasks:
          thresholds.minimumDistinctTasks ??
          DEFAULT_COHORT_THRESHOLDS.minimumDistinctTasks,
        minimumExactFactObservations:
          thresholds.minimumExactFactObservations ??
          DEFAULT_COHORT_THRESHOLDS.minimumExactFactObservations,
        minimumUserConstraintObservations:
          thresholds.minimumUserConstraintObservations ??
          DEFAULT_COHORT_THRESHOLDS.minimumUserConstraintObservations,
        minimumStalenessObservations:
          thresholds.minimumStalenessObservations ??
          DEFAULT_COHORT_THRESHOLDS.minimumStalenessObservations,
        minimumSupersessionObservations:
          thresholds.minimumSupersessionObservations ??
          DEFAULT_COHORT_THRESHOLDS.minimumSupersessionObservations,
        minimumRestartObservations:
          thresholds.minimumRestartObservations ??
          DEFAULT_COHORT_THRESHOLDS.minimumRestartObservations,
      }),
    )
    .digest('hex');
  return {
    ...base,
    policyHash: cohortPolicyHash,
    totalObservationCount: observations.length,
    staleObservationCount: observations.length - fresh.length,
    freshnessWindowMs,
    distinctTaskCount,
    categoryCoverage,
    promotionReady: blockers.length === 0,
    promotionBlockers: Array.from(new Set(blockers)),
  };
}

export function toEvidenceMemoryDogfoodReceipt(
  report: EvidenceMemoryDogfoodReport,
): Record<
  string,
  string | number | boolean | null | string[] | Record<string, number>
> {
  const receipt: Record<
    string,
    string | number | boolean | null | string[] | Record<string, number>
  > = {
    observationVersion: report.observationVersion,
    thresholdVersion: report.thresholdVersion,
    policyHash: report.policyHash,
    sampleCount: report.sampleCount,
    expectedClaimCount: report.expectedClaimCount,
    forbiddenClaimCount: report.forbiddenClaimCount,
    retrievalRecoveredClaimCount: report.retrievalRecoveredClaimCount,
    admissionRecoveredClaimCount: report.admissionRecoveredClaimCount,
    retrievalRecall: report.retrievalRecall,
    retrievalLossCount: report.retrievalLossCount,
    admissionLossCount: report.admissionLossCount,
    compressedHistoryRecall: report.compressedHistoryRecall,
    guardedMemoryRecall: report.guardedMemoryRecall,
    recallLift: report.recallLift,
    compressedHistoryStaleLeakageRate: report.compressedHistoryStaleLeakageRate,
    guardedMemoryStaleLeakageRate: report.guardedMemoryStaleLeakageRate,
    compressedHistoryLatencyP95Ms: report.compressedHistoryLatencyP95Ms,
    guardedMemoryLatencyP95Ms: report.guardedMemoryLatencyP95Ms,
    compressedHistoryTotalTokens: report.compressedHistoryTotalTokens,
    guardedMemoryTotalTokens: report.guardedMemoryTotalTokens,
    tokenOverheadRatio: report.tokenOverheadRatio,
    missingProvenanceAdmissionCount: report.missingProvenanceAdmissionCount,
    unresolvedContradictionInjectionCount:
      report.unresolvedContradictionInjectionCount,
    retrievalCandidateCount: report.retrievalCandidateCount,
    retrievalSelectedCount: report.retrievalSelectedCount,
    retrievalExclusionReasonCounts: report.retrievalExclusionReasonCounts,
    admissionCandidateCount: report.admissionCandidateCount,
    admissionSelectedCount: report.admissionSelectedCount,
    admissionReasonCodeCounts: report.admissionReasonCodeCounts,
    guardedEnvelopeTotalTokens: report.guardedEnvelopeTotalTokens,
    guardedClaimTotalTokens: report.guardedClaimTotalTokens,
    guardedTokensPerAdmittedClaim: report.guardedTokensPerAdmittedClaim,
    promotionReady: report.promotionReady,
    promotionBlockers: report.promotionBlockers,
  };
  if (isDogfoodCohortReport(report)) {
    receipt.totalObservationCount = report.totalObservationCount;
    receipt.staleObservationCount = report.staleObservationCount;
    receipt.freshnessWindowMs = report.freshnessWindowMs;
    receipt.distinctTaskCount = report.distinctTaskCount;
    receipt.categoryCoverage = report.categoryCoverage;
  }
  return receipt;
}

export function parseEvidenceMemoryDogfoodObservation(
  value: unknown,
): EvidenceMemoryDogfoodObservation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<EvidenceMemoryDogfoodObservation>;
  if (
    candidate.observationVersion !==
      EVIDENCE_MEMORY_DOGFOOD_OBSERVATION_VERSION ||
    typeof candidate.scenarioIdHash !== 'string' ||
    !isDogfoodCategory(candidate.category)
  ) {
    return null;
  }
  const observation = candidate as EvidenceMemoryDogfoodObservation;
  try {
    validateDogfoodObservation(observation);
    return observation;
  } catch {
    return null;
  }
}

/**
 * Generates deterministic 100/300/1000-event fixtures without model calls.
 * Every 25th event becomes an exact fact; every 100th is also a user
 * constraint. The last claim is revision-bound so stale-injection behavior is
 * measured by the same fixture.
 */
export function createEvidenceMemoryEvaluationFixture(
  eventCount: 100 | 300 | 1_000,
): EvidenceMemoryEvaluationFixture {
  const taskId = `evaluation-${eventCount}`;
  const events: RecordEvidenceMemoryEventInput[] = [];
  const claims: RecordEvidenceMemoryClaimInput[] = [];
  const scenarios: EvidenceMemoryEvaluationScenario[] = [];
  for (let index = 1; index <= eventCount; index += 1) {
    const eventId = `event-${eventCount}-${index}`;
    events.push({
      id: eventId,
      taskId,
      type: index % 100 === 0 ? 'user_message' : 'decision_recorded',
      timestamp: index,
      payload: { text: `Deterministic memory fact ${index}.` },
    });
    if (index % 25 !== 0) continue;
    const claimId = `claim-${eventCount}-${index}`;
    const isConstraint = index % 100 === 0;
    claims.push({
      id: claimId,
      taskId,
      kind: isConstraint ? 'user_constraint' : 'observed_fact',
      subject: `fixture.fact.${index}`,
      text: `Deterministic memory fact ${index}.`,
      evidenceEventIds: [eventId],
      validAtRevision: index === eventCount ? 'fixture-revision-a' : null,
    });
    scenarios.push({
      id: `recall-${eventCount}-${index}`,
      taskId,
      query: `memory fact ${index}`,
      expectedClaimIds: [claimId],
      category: isConstraint ? 'user_constraint' : 'exact_fact',
    });
  }
  const staleClaimId = `claim-${eventCount}-${eventCount}`;
  scenarios.push({
    id: `stale-${eventCount}`,
    taskId,
    query: `memory fact ${eventCount}`,
    repositoryRevision: 'fixture-revision-b',
    expectedClaimIds: [],
    forbiddenClaimIds: [staleClaimId],
    category: 'staleness',
  });
  scenarios.push({
    id: `restart-${eventCount}`,
    taskId,
    query: 'memory fact 25',
    expectedClaimIds: [`claim-${eventCount}-25`],
    category: 'restart',
  });
  return { eventCount, events, claims, scenarios };
}

function categoryRecall(
  results: readonly EvidenceMemoryEvaluationScenarioResult[],
  category: EvidenceMemoryEvaluationScenario['category'],
): number {
  const selected = results.filter((result) => result.category === category);
  const expected = selected.reduce((sum, result) => sum + result.expected, 0);
  return expected === 0
    ? 1
    : selected.reduce((sum, result) => sum + result.recovered, 0) / expected;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? 0;
}

function normalizeDogfoodThresholds(
  thresholds: EvidenceMemoryDogfoodThresholds,
): NormalizedEvidenceMemoryDogfoodThresholds {
  return {
    minimumObservations: positiveInteger(
      thresholds.minimumObservations ??
        DEFAULT_DOGFOOD_THRESHOLDS.minimumObservations,
    ),
    minimumGuardedRecall: unitInterval(
      thresholds.minimumGuardedRecall ??
        DEFAULT_DOGFOOD_THRESHOLDS.minimumGuardedRecall,
    ),
    minimumRecallLift: unitInterval(
      thresholds.minimumRecallLift ??
        DEFAULT_DOGFOOD_THRESHOLDS.minimumRecallLift,
    ),
    maximumGuardedStaleLeakageRate: unitInterval(
      thresholds.maximumGuardedStaleLeakageRate ??
        DEFAULT_DOGFOOD_THRESHOLDS.maximumGuardedStaleLeakageRate,
    ),
    maximumGuardedLatencyP95Ms: finiteNonNegative(
      thresholds.maximumGuardedLatencyP95Ms ??
        DEFAULT_DOGFOOD_THRESHOLDS.maximumGuardedLatencyP95Ms,
    ),
    maximumTokenOverheadRatio: finiteNonNegative(
      thresholds.maximumTokenOverheadRatio ??
        DEFAULT_DOGFOOD_THRESHOLDS.maximumTokenOverheadRatio,
    ),
  };
}

function normalizeQualityThresholds(
  thresholds: EvidenceMemoryQualityThresholds,
): NormalizedEvidenceMemoryQualityThresholds {
  return {
    minimumObservations: positiveInteger(
      thresholds.minimumObservations ??
        DEFAULT_QUALITY_THRESHOLDS.minimumObservations,
    ),
    minimumSyncObservations: positiveInteger(
      thresholds.minimumSyncObservations ??
        DEFAULT_QUALITY_THRESHOLDS.minimumSyncObservations,
    ),
    minimumUnsafeMergeObservations: positiveInteger(
      thresholds.minimumUnsafeMergeObservations ??
        DEFAULT_QUALITY_THRESHOLDS.minimumUnsafeMergeObservations,
    ),
    minimumFactRecall: unitInterval(
      thresholds.minimumFactRecall ??
        DEFAULT_QUALITY_THRESHOLDS.minimumFactRecall,
    ),
    maximumStaleMemoryRate: unitInterval(
      thresholds.maximumStaleMemoryRate ??
        DEFAULT_QUALITY_THRESHOLDS.maximumStaleMemoryRate,
    ),
    minimumConvergenceRate: unitInterval(
      thresholds.minimumConvergenceRate ??
        DEFAULT_QUALITY_THRESHOLDS.minimumConvergenceRate,
    ),
    maximumFalseAutoMergeRate: unitInterval(
      thresholds.maximumFalseAutoMergeRate ??
        DEFAULT_QUALITY_THRESHOLDS.maximumFalseAutoMergeRate,
    ),
    minimumTokenSavingsRatio: unitInterval(
      thresholds.minimumTokenSavingsRatio ??
        DEFAULT_QUALITY_THRESHOLDS.minimumTokenSavingsRatio,
    ),
  };
}

function dominantDogfoodCategory(
  expectedClaims: readonly EvidenceMemoryClaim[],
  staleClaims: readonly EvidenceMemoryClaim[],
): EvidenceMemoryEvaluationScenario['category'] {
  if (expectedClaims.length === 0 && staleClaims.length > 0) return 'staleness';
  if (
    expectedClaims.length > 0 &&
    expectedClaims.every((claim) => claim.kind === 'user_constraint')
  ) {
    return 'user_constraint';
  }
  return 'exact_fact';
}

function isDogfoodCategory(
  value: unknown,
): value is EvidenceMemoryEvaluationScenario['category'] {
  return (
    value === 'exact_fact' ||
    value === 'user_constraint' ||
    value === 'staleness' ||
    value === 'supersession' ||
    value === 'restart' ||
    value === 'fork_isolation' ||
    value === 'workspace_isolation'
  );
}

function isDogfoodCohortReport(
  report: EvidenceMemoryDogfoodReport,
): report is EvidenceMemoryDogfoodCohortReport {
  return 'categoryCoverage' in report && 'distinctTaskCount' in report;
}

function validateDogfoodObservation(
  observation: EvidenceMemoryDogfoodObservation,
): void {
  if (
    observation.observationVersion !==
    EVIDENCE_MEMORY_DOGFOOD_OBSERVATION_VERSION
  ) {
    throw new Error(
      'Evidence Memory dogfood observation version is unsupported',
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(observation.scenarioIdHash)) {
    throw new Error(
      'Evidence Memory dogfood scenario identity must be a SHA-256 hash',
    );
  }
  if (
    observation.sourceTaskHash !== undefined &&
    !/^[a-f0-9]{64}$/u.test(observation.sourceTaskHash)
  ) {
    throw new Error(
      'Evidence Memory dogfood task identity must be a SHA-256 hash',
    );
  }
  if (
    observation.cohortIdHash !== undefined &&
    !/^[a-f0-9]{64}$/u.test(observation.cohortIdHash)
  ) {
    throw new Error(
      'Evidence Memory dogfood cohort identity must be a SHA-256 hash',
    );
  }
  if (
    observation.expectedClaimSource !== undefined &&
    observation.expectedClaimSource !== 'context-pack' &&
    observation.expectedClaimSource !== 'explicit'
  ) {
    throw new Error('Evidence Memory dogfood ground-truth source is invalid');
  }
  if (
    observation.observedAt !== undefined &&
    (!Number.isFinite(observation.observedAt) || observation.observedAt < 0)
  ) {
    throw new Error(
      'Evidence Memory dogfood observation timestamp must be non-negative',
    );
  }
  for (const value of [
    observation.expectedClaimCount,
    observation.retrievalRecoveredCount ?? observation.expectedClaimCount,
    observation.admissionRecoveredCount ??
      observation.guardedMemoryRecoveredCount,
    observation.compressedHistoryRecoveredCount,
    observation.guardedMemoryRecoveredCount,
    observation.forbiddenClaimCount,
    observation.compressedHistoryLeakedCount,
    observation.guardedMemoryLeakedCount,
    observation.compressedHistoryTokens,
    observation.guardedMemoryTokens,
    observation.compressedHistoryLatencyMs,
    observation.guardedMemoryLatencyMs,
    observation.missingProvenanceAdmissionCount ?? 0,
    observation.unresolvedContradictionInjectionCount ?? 0,
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        'Evidence Memory dogfood metrics must be finite and non-negative',
      );
    }
  }
  if (
    (observation.retrievalRecoveredCount ?? observation.expectedClaimCount) >
      observation.expectedClaimCount ||
    (observation.admissionRecoveredCount ??
      observation.guardedMemoryRecoveredCount) >
      observation.expectedClaimCount ||
    (observation.admissionRecoveredCount ??
      observation.guardedMemoryRecoveredCount) >
      (observation.retrievalRecoveredCount ?? observation.expectedClaimCount) ||
    observation.compressedHistoryRecoveredCount >
      observation.expectedClaimCount ||
    observation.guardedMemoryRecoveredCount > observation.expectedClaimCount ||
    observation.compressedHistoryLeakedCount >
      observation.forbiddenClaimCount ||
    observation.guardedMemoryLeakedCount > observation.forbiddenClaimCount
  ) {
    throw new Error(
      'Evidence Memory dogfood recovered/leaked counts exceed scenario totals',
    );
  }
  const diagnostics = observation.diagnostics;
  if (diagnostics) {
    for (const value of [
      diagnostics.retrievalCandidateCount,
      diagnostics.retrievalSelectedCount,
      diagnostics.admissionCandidateCount,
      diagnostics.admissionSelectedCount,
      diagnostics.guardedEnvelopeTokens,
      ...diagnostics.guardedClaimTokenContributions,
      ...Object.values(diagnostics.retrievalExclusionReasonCounts),
      ...Object.values(diagnostics.admissionReasonCodeCounts),
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(
          'Evidence Memory dogfood diagnostics must be non-negative integers',
        );
      }
    }
    if (
      diagnostics.retrievalSelectedCount >
        diagnostics.retrievalCandidateCount ||
      diagnostics.admissionSelectedCount > diagnostics.admissionCandidateCount
    ) {
      throw new Error(
        'Evidence Memory dogfood selected diagnostics exceed candidates',
      );
    }
  }
}

function validateQualityObservation(
  observation: EvidenceMemoryQualityObservation,
): void {
  if (!/^[a-f0-9]{64}$/u.test(observation.observationIdHash)) {
    throw new Error(
      'Evidence Memory quality observation identity must be a SHA-256 hash',
    );
  }
  for (const value of [
    observation.expectedFactCount,
    observation.recoveredFactCount,
    observation.staleFactCount,
    observation.staleInjectedCount,
    observation.baselineTokens,
    observation.evidenceMemoryTokens,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        'Evidence Memory quality counts must be non-negative safe integers',
      );
    }
  }
  if (
    observation.recoveredFactCount > observation.expectedFactCount ||
    observation.staleInjectedCount > observation.staleFactCount
  ) {
    throw new Error(
      'Evidence Memory quality recovered/injected counts exceed totals',
    );
  }
  const sync = observation.synchronization;
  if (!sync) return;
  if (
    typeof sync.expectedToConverge !== 'boolean' ||
    typeof sync.converged !== 'boolean' ||
    (sync.autoMergeDecision !== 'applied' &&
      sync.autoMergeDecision !== 'manual' &&
      sync.autoMergeDecision !== 'not-applicable') ||
    (sync.groundTruthMergeSafe !== null &&
      typeof sync.groundTruthMergeSafe !== 'boolean')
  ) {
    throw new Error('Evidence Memory synchronization quality data is invalid');
  }
  if (
    sync.autoMergeDecision !== 'not-applicable' &&
    sync.groundTruthMergeSafe === null
  ) {
    throw new Error(
      'Evidence Memory auto-merge decisions require ground-truth safety',
    );
  }
}

function emptyCategoryCoverage(): Record<
  EvidenceMemoryEvaluationScenario['category'],
  number
> {
  return {
    exact_fact: 0,
    user_constraint: 0,
    staleness: 0,
    supersession: 0,
    restart: 0,
    fork_isolation: 0,
    workspace_isolation: 0,
  };
}

function addCoverageBlocker(
  blockers: EvidenceMemoryPromotionBlocker[],
  actual: number,
  required: number,
  blocker: EvidenceMemoryPromotionBlocker,
): void {
  if (!Number.isSafeInteger(required) || required < 0) {
    throw new Error(
      'Evidence Memory dogfood category thresholds must be non-negative integers',
    );
  }
  if (actual < required) blockers.push(blocker);
}

function hashDogfoodPolicy(
  thresholds: NormalizedEvidenceMemoryDogfoodThresholds,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        observationVersion: EVIDENCE_MEMORY_DOGFOOD_OBSERVATION_VERSION,
        thresholdVersion: 1,
        ...thresholds,
      }),
    )
    .digest('hex');
}

function hashQualityPolicy(
  thresholds: NormalizedEvidenceMemoryQualityThresholds,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ thresholdVersion: 1, ...thresholds }))
    .digest('hex');
}

function intersectionSize(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function safeRecall(recovered: number, expected: number): number {
  return expected === 0 ? 1 : recovered / expected;
}

function safeLeakage(leaked: number, forbidden: number): number {
  return forbidden === 0 ? 0 : leaked / forbidden;
}

function countDogfoodReasons<T extends string>(
  reasons: readonly T[],
): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const reason of reasons) {
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function mergeDogfoodReasonCounts<T extends string>(
  entries: readonly Partial<Record<T, number>>[],
): Partial<Record<T, number>> {
  const merged: Partial<Record<T, number>> = {};
  for (const entry of entries) {
    for (const [reason, count] of Object.entries(entry) as Array<[T, number]>) {
      merged[reason] = (merged[reason] ?? 0) + count;
    }
  }
  return merged;
}

function sum<T>(values: readonly T[], getValue: (value: T) => number): number {
  return values.reduce((total, value) => total + getValue(value), 0);
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      'Evidence Memory dogfood sample thresholds must be positive integers',
    );
  }
  return value;
}

function unitInterval(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      'Evidence Memory dogfood rates must be between zero and one',
    );
  }
  return value;
}

function finiteNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      'Evidence Memory dogfood thresholds must be finite and non-negative',
    );
  }
  return value;
}
