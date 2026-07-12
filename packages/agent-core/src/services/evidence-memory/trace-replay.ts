import { createHash } from 'node:crypto';
import {
  EVIDENCE_MEMORY_DOGFOOD_OBSERVATION_VERSION,
  evaluateEvidenceMemoryDogfoodCohort,
  parseEvidenceMemoryDogfoodObservation,
  type EvidenceMemoryDogfoodCohortReport,
  type EvidenceMemoryDogfoodCohortThresholds,
  type EvidenceMemoryDogfoodObservation,
  type EvidenceMemoryPromotionBlocker,
} from './evaluation';

export const EVIDENCE_MEMORY_TRACE_REPLAY_FORMAT =
  'clodex-evidence-memory-trace-replay';

export interface EvidenceMemoryTraceReplayBundle {
  format: typeof EVIDENCE_MEMORY_TRACE_REPLAY_FORMAT;
  version: 1;
  observations: unknown[];
}

export type EvidenceMemoryTraceReplayBlocker =
  | EvidenceMemoryPromotionBlocker
  | 'invalid-trace-observations'
  | 'duplicate-trace-observations'
  | 'missing-trace-timestamps';

export interface EvidenceMemoryTraceReplayRequirements {
  requireObservedAt?: boolean;
}

export interface EvidenceMemoryTraceReplayReport
  extends Omit<
    EvidenceMemoryDogfoodCohortReport,
    'promotionBlockers' | 'promotionReady'
  > {
  traceVersion: 1;
  traceSetHash: string;
  inputObservationCount: number;
  replayedObservationCount: number;
  invalidObservationCount: number;
  duplicateObservationCount: number;
  missingObservedAtCount: number;
  promotionReady: boolean;
  promotionBlockers: EvidenceMemoryTraceReplayBlocker[];
}

export function evaluateEvidenceMemoryTraceReplay(
  input: unknown,
  thresholds: EvidenceMemoryDogfoodCohortThresholds = {},
  now: number = Date.now(),
  requirements: EvidenceMemoryTraceReplayRequirements = {},
): EvidenceMemoryTraceReplayReport {
  const rawObservations = extractRawObservations(input);
  const accepted: EvidenceMemoryDogfoodObservation[] = [];
  const identities = new Set<string>();
  let invalidObservationCount = 0;
  let duplicateObservationCount = 0;

  for (const rawObservation of rawObservations) {
    const observation = parseEvidenceMemoryDogfoodObservation(rawObservation);
    if (!observation) {
      invalidObservationCount += 1;
      continue;
    }
    if (identities.has(observation.scenarioIdHash)) {
      duplicateObservationCount += 1;
      continue;
    }
    identities.add(observation.scenarioIdHash);
    accepted.push(observation);
  }

  const cohort = evaluateEvidenceMemoryDogfoodCohort(accepted, thresholds, now);
  const missingObservedAtCount = accepted.filter(
    (observation) => observation.observedAt === undefined,
  ).length;
  const blockers: EvidenceMemoryTraceReplayBlocker[] = [
    ...cohort.promotionBlockers,
  ];
  if (invalidObservationCount > 0) {
    blockers.push('invalid-trace-observations');
  }
  if (duplicateObservationCount > 0) {
    blockers.push('duplicate-trace-observations');
  }
  if (requirements.requireObservedAt && missingObservedAtCount > 0) {
    blockers.push('missing-trace-timestamps');
  }
  const policyHash = createHash('sha256')
    .update(
      JSON.stringify({
        traceVersion: 1,
        observationVersion: EVIDENCE_MEMORY_DOGFOOD_OBSERVATION_VERSION,
        cohortPolicyHash: cohort.policyHash,
        requireObservedAt: requirements.requireObservedAt === true,
      }),
    )
    .digest('hex');

  return {
    ...cohort,
    policyHash,
    traceVersion: 1,
    traceSetHash: hashTraceSet(accepted),
    inputObservationCount: rawObservations.length,
    replayedObservationCount: accepted.length,
    invalidObservationCount,
    duplicateObservationCount,
    missingObservedAtCount,
    promotionReady: blockers.length === 0,
    promotionBlockers: Array.from(new Set(blockers)),
  };
}

export function createEvidenceMemoryTraceReplayFixture(): EvidenceMemoryTraceReplayBundle {
  const categories = [
    ...Array.from({ length: 45 }, () => 'exact_fact' as const),
    ...Array.from({ length: 20 }, () => 'user_constraint' as const),
    ...Array.from({ length: 15 }, () => 'staleness' as const),
    ...Array.from({ length: 10 }, () => 'supersession' as const),
    ...Array.from({ length: 10 }, () => 'restart' as const),
  ];
  return {
    format: EVIDENCE_MEMORY_TRACE_REPLAY_FORMAT,
    version: 1,
    observations: categories.map((category, index) => ({
      observationVersion: EVIDENCE_MEMORY_DOGFOOD_OBSERVATION_VERSION,
      scenarioIdHash: createHash('sha256')
        .update(`evidence-memory-trace-replay-v3:${index}`)
        .digest('hex'),
      sourceTaskHash: createHash('sha256')
        .update(`evidence-memory-trace-task-v3:${index % 3}`)
        .digest('hex'),
      category,
      expectedClaimCount: 10,
      retrievalRecoveredCount: 10,
      admissionRecoveredCount: 10,
      compressedHistoryRecoveredCount: 8,
      guardedMemoryRecoveredCount: 10,
      forbiddenClaimCount: 1,
      compressedHistoryLeakedCount: 1,
      guardedMemoryLeakedCount: 0,
      compressedHistoryTokens: 100,
      guardedMemoryTokens: 110,
      compressedHistoryLatencyMs: 10,
      guardedMemoryLatencyMs: 25,
    })),
  };
}

export function toEvidenceMemoryTraceReplayReceipt(
  report: EvidenceMemoryTraceReplayReport,
): Record<
  string,
  string | number | boolean | null | string[] | Record<string, number>
> {
  return {
    observationVersion: report.observationVersion,
    traceVersion: report.traceVersion,
    traceSetHash: report.traceSetHash,
    thresholdVersion: report.thresholdVersion,
    policyHash: report.policyHash,
    inputObservationCount: report.inputObservationCount,
    replayedObservationCount: report.replayedObservationCount,
    invalidObservationCount: report.invalidObservationCount,
    duplicateObservationCount: report.duplicateObservationCount,
    missingObservedAtCount: report.missingObservedAtCount,
    staleObservationCount: report.staleObservationCount,
    freshnessWindowMs: report.freshnessWindowMs,
    distinctTaskCount: report.distinctTaskCount,
    categoryCoverage: report.categoryCoverage,
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
    promotionReady: report.promotionReady,
    promotionBlockers: report.promotionBlockers,
  };
}

function extractRawObservations(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (typeof input !== 'object' || input === null) {
    throw new Error('Evidence Memory trace replay input must be an object');
  }
  const candidate = input as Partial<EvidenceMemoryTraceReplayBundle>;
  if (
    candidate.format !== EVIDENCE_MEMORY_TRACE_REPLAY_FORMAT ||
    candidate.version !== 1 ||
    !Array.isArray(candidate.observations)
  ) {
    throw new Error('Evidence Memory trace replay bundle is malformed');
  }
  return candidate.observations;
}

function hashTraceSet(
  observations: readonly EvidenceMemoryDogfoodObservation[],
): string {
  const canonical = [...observations]
    .sort((left, right) =>
      left.scenarioIdHash.localeCompare(right.scenarioIdHash),
    )
    .map((observation) => ({
      observationVersion: observation.observationVersion,
      scenarioIdHash: observation.scenarioIdHash,
      sourceTaskHash: observation.sourceTaskHash ?? null,
      cohortIdHash: observation.cohortIdHash ?? null,
      observedAt: observation.observedAt ?? null,
      category: observation.category,
      expectedClaimSource: observation.expectedClaimSource ?? null,
      expectedClaimCount: observation.expectedClaimCount,
      retrievalRecoveredCount:
        observation.retrievalRecoveredCount ?? observation.expectedClaimCount,
      admissionRecoveredCount:
        observation.admissionRecoveredCount ??
        observation.guardedMemoryRecoveredCount,
      compressedHistoryRecoveredCount:
        observation.compressedHistoryRecoveredCount,
      guardedMemoryRecoveredCount: observation.guardedMemoryRecoveredCount,
      forbiddenClaimCount: observation.forbiddenClaimCount,
      compressedHistoryLeakedCount: observation.compressedHistoryLeakedCount,
      guardedMemoryLeakedCount: observation.guardedMemoryLeakedCount,
      compressedHistoryTokens: observation.compressedHistoryTokens,
      guardedMemoryTokens: observation.guardedMemoryTokens,
      compressedHistoryLatencyMs: observation.compressedHistoryLatencyMs,
      guardedMemoryLatencyMs: observation.guardedMemoryLatencyMs,
      missingProvenanceAdmissionCount:
        observation.missingProvenanceAdmissionCount ?? 0,
      unresolvedContradictionInjectionCount:
        observation.unresolvedContradictionInjectionCount ?? 0,
      diagnostics:
        observation.diagnostics === undefined
          ? null
          : {
              retrievalCandidateCount:
                observation.diagnostics.retrievalCandidateCount,
              retrievalSelectedCount:
                observation.diagnostics.retrievalSelectedCount,
              retrievalExclusionReasonCounts: sortCountRecord(
                observation.diagnostics.retrievalExclusionReasonCounts,
              ),
              admissionCandidateCount:
                observation.diagnostics.admissionCandidateCount,
              admissionSelectedCount:
                observation.diagnostics.admissionSelectedCount,
              admissionReasonCodeCounts: sortCountRecord(
                observation.diagnostics.admissionReasonCodeCounts,
              ),
              guardedEnvelopeTokens:
                observation.diagnostics.guardedEnvelopeTokens,
              guardedClaimTokenContributions:
                observation.diagnostics.guardedClaimTokenContributions,
            },
    }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function sortCountRecord(
  value: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}
