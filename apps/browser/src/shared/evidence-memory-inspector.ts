import { z } from 'zod';
import type {
  EvidenceMemoryClaimDetails,
  EvidenceMemoryClaimConflict,
  EvidenceMemoryClaimSearchHit,
  EvidenceMemoryConflictResolution,
  EvidenceMemoryConflictResolutionAction,
  EvidenceMemoryDogfoodCohortReport,
  EvidenceMemoryDogfoodReport,
  EvidenceMemoryInspectorSnapshot,
  EvidenceMemorySummarySchedulerSnapshot,
} from '@clodex/agent-core/evidence-memory';
import type {
  GuardianReleaseReadiness,
  GuardianShadowReadiness,
} from './guardian-release-readiness';

export const evidenceMemoryTaskIdSchema = z.string().trim().min(1).max(4_096);

export const evidenceMemoryInspectorSnapshotInputSchema = z.object({
  taskId: evidenceMemoryTaskIdSchema,
  eventLimit: z.number().int().min(1).max(500).default(100),
  claimLimit: z.number().int().min(1).max(500).default(100),
});
export type EvidenceMemoryInspectorSnapshotInput = z.input<
  typeof evidenceMemoryInspectorSnapshotInputSchema
>;

export const evidenceMemoryInspectorSearchInputSchema = z.object({
  taskId: evidenceMemoryTaskIdSchema,
  query: z.string().trim().min(1).max(8_192),
  limit: z.number().int().min(1).max(100).default(25),
  repositoryRevision: z.string().trim().min(1).max(1_024).optional(),
  includeStale: z.boolean().default(true),
});
export type EvidenceMemoryInspectorSearchInput = z.input<
  typeof evidenceMemoryInspectorSearchInputSchema
>;

const evidenceMemoryDogfoodObservationSchema = z.object({
  observationVersion: z.literal(3),
  scenarioIdHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceTaskHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  cohortIdHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  observedAt: z.number().min(0).optional(),
  category: z.enum([
    'exact_fact',
    'user_constraint',
    'staleness',
    'supersession',
    'restart',
    'fork_isolation',
    'workspace_isolation',
  ]),
  expectedClaimSource: z.enum(['context-pack', 'explicit']).optional(),
  expectedClaimCount: z.number().int().min(0),
  retrievalRecoveredCount: z.number().int().min(0).optional(),
  admissionRecoveredCount: z.number().int().min(0).optional(),
  compressedHistoryRecoveredCount: z.number().int().min(0),
  guardedMemoryRecoveredCount: z.number().int().min(0),
  forbiddenClaimCount: z.number().int().min(0),
  compressedHistoryLeakedCount: z.number().int().min(0),
  guardedMemoryLeakedCount: z.number().int().min(0),
  compressedHistoryTokens: z.number().int().min(0),
  guardedMemoryTokens: z.number().int().min(0),
  compressedHistoryLatencyMs: z.number().min(0),
  guardedMemoryLatencyMs: z.number().min(0),
  missingProvenanceAdmissionCount: z.number().int().min(0).optional(),
  unresolvedContradictionInjectionCount: z.number().int().min(0).optional(),
  diagnostics: z
    .object({
      retrievalCandidateCount: z.number().int().min(0),
      retrievalSelectedCount: z.number().int().min(0),
      retrievalExclusionReasonCounts: z.record(
        z.enum([
          'query-anchor-mismatch',
          'stale-revision',
          'stale-code',
          'token-budget',
          'max-claims',
        ]),
        z.number().int().min(0),
      ),
      admissionCandidateCount: z.number().int().min(0),
      admissionSelectedCount: z.number().int().min(0),
      admissionReasonCodeCounts: z.record(
        z.enum([
          'admitted',
          'gate-disabled',
          'repository-revision-unavailable',
          'empty-pack',
          'stale-evidence',
          'unresolved-conflict',
          'missing-provenance',
          'max-claims-exceeded',
          'token-budget-exceeded',
          'quality-insufficient',
          'baseline-duplicate',
        ]),
        z.number().int().min(0),
      ),
      guardedEnvelopeTokens: z.number().int().min(0),
      guardedClaimTokenContributions: z.array(z.number().int().min(0)).max(100),
    })
    .optional(),
});

export const evidenceMemoryDogfoodEvaluationInputSchema = z.object({
  taskId: evidenceMemoryTaskIdSchema,
  observations: z
    .array(evidenceMemoryDogfoodObservationSchema)
    .min(1)
    .max(5_000),
  thresholds: z
    .object({
      minimumObservations: z.number().int().positive().optional(),
      minimumGuardedRecall: z.number().min(0).max(1).optional(),
      minimumRecallLift: z.number().min(0).max(1).optional(),
      maximumGuardedStaleLeakageRate: z.number().min(0).max(1).optional(),
      maximumGuardedLatencyP95Ms: z.number().min(0).optional(),
      maximumTokenOverheadRatio: z.number().min(0).optional(),
    })
    .optional(),
});
export type EvidenceMemoryDogfoodEvaluationInput = z.input<
  typeof evidenceMemoryDogfoodEvaluationInputSchema
>;

export const evidenceMemoryDogfoodBackfillInputSchema = z
  .object({
    maxArchives: z.number().int().min(1).max(100).optional(),
    maxObservations: z.number().int().min(1).max(250).optional(),
  })
  .default({});
export type EvidenceMemoryDogfoodBackfillInput = z.input<
  typeof evidenceMemoryDogfoodBackfillInputSchema
>;

export interface EvidenceMemoryDogfoodBackfillResult {
  archivesScanned: number;
  archivesWithCompression: number;
  observationsReplayed: number;
  observationsSkipped: number;
  failures: number;
}

export const evidenceMemoryClaimDetailsInputSchema = z.object({
  taskId: evidenceMemoryTaskIdSchema,
  claimId: z.string().trim().min(1).max(128),
});
export type EvidenceMemoryClaimDetailsInput = z.input<
  typeof evidenceMemoryClaimDetailsInputSchema
>;

export const evidenceMemoryConflictResolutionInputSchema = z.object({
  taskId: evidenceMemoryTaskIdSchema,
  claimIds: z
    .array(z.string().trim().min(1).max(128))
    .min(2)
    .max(100)
    .transform((claimIds) => Array.from(new Set(claimIds))),
  action: z.enum([
    'keep_older',
    'accept_newer',
    'both_valid',
    'defer',
    'dismiss',
  ]),
});
export type EvidenceMemoryConflictResolutionInput = z.input<
  typeof evidenceMemoryConflictResolutionInputSchema
>;

export const evidenceMemoryConflictResolutionUndoInputSchema = z.object({
  taskId: evidenceMemoryTaskIdSchema,
  resolutionId: z.string().trim().min(1).max(128),
});
export type EvidenceMemoryConflictResolutionUndoInput = z.input<
  typeof evidenceMemoryConflictResolutionUndoInputSchema
>;

export interface EvidenceMemoryInspectorExportResult {
  canceled: boolean;
  taskId: string;
  eventCount: number;
  claimCount: number;
  truncated: boolean;
  filePath?: string;
}

export interface EvidenceMemoryInspectorResetResult {
  taskId: string;
  deletedEvents: number;
  deletedClaims: number;
}

export const evidenceMemoryReadinessInputSchema = z.object({
  taskId: evidenceMemoryTaskIdSchema,
});
export type EvidenceMemoryReadinessInput = z.input<
  typeof evidenceMemoryReadinessInputSchema
>;

export type EvidenceMemoryReadinessStatus =
  | 'collecting'
  | 'needs-tuning'
  | 'candidate';

export interface EvidenceMemoryReadinessDashboard {
  version: 1;
  taskId: string;
  generatedAt: number;
  status: EvidenceMemoryReadinessStatus;
  policyHash: string;
  blockers: string[];
  gates: {
    modelSummaries: boolean;
    guardianShadow: boolean;
    promptInjection: boolean;
  };
  summaries: {
    shortCount: number;
    longCount: number;
    latestShortAt: number | null;
    latestLongAt: number | null;
    orientationSummaryCount: number;
    orientationEstimatedTokens: number;
  };
  scheduler: EvidenceMemorySummarySchedulerSnapshot | null;
  pruningPreview: {
    eligibleEventCount: number;
    protectedByClaimCount: number;
    protectedByTypeCount: number;
    uncoveredCount: number;
    retainedByTtlCount: number;
  };
  memory: EvidenceMemoryDogfoodCohortReport;
  guardian: GuardianReleaseReadiness | null;
  guardianShadow: GuardianShadowReadiness | null;
}

export interface EvidenceMemoryReadinessEvaluationResult {
  dashboard: EvidenceMemoryReadinessDashboard;
  receiptEventId: string;
}

export type {
  EvidenceMemoryClaimDetails,
  EvidenceMemoryClaimConflict,
  EvidenceMemoryClaimSearchHit,
  EvidenceMemoryConflictResolution,
  EvidenceMemoryConflictResolutionAction,
  EvidenceMemoryDogfoodCohortReport,
  EvidenceMemoryDogfoodReport,
  EvidenceMemoryInspectorSnapshot,
  EvidenceMemorySummarySchedulerSnapshot,
};
