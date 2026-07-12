import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { dialog } from 'electron';
import type {
  EvidenceMemoryService,
  EvidenceMemoryTaskExport,
  EvidenceMemorySummaryScheduler,
} from '@clodex/agent-core/evidence-memory';
import {
  evaluateEvidenceMemoryDogfood,
  toEvidenceMemoryDogfoodReceipt,
} from '@clodex/agent-core/evidence-memory';
import type { FeatureGateId } from '@shared/feature-gates';
import {
  evidenceMemoryClaimDetailsInputSchema,
  evidenceMemoryConflictResolutionInputSchema,
  evidenceMemoryConflictResolutionUndoInputSchema,
  evidenceMemoryDogfoodBackfillInputSchema,
  evidenceMemoryDogfoodEvaluationInputSchema,
  evidenceMemoryInspectorSearchInputSchema,
  evidenceMemoryInspectorSnapshotInputSchema,
  evidenceMemoryReadinessInputSchema,
  evidenceMemoryTaskIdSchema,
  type EvidenceMemoryDogfoodBackfillResult,
  type EvidenceMemoryInspectorExportResult,
  type EvidenceMemoryInspectorResetResult,
  type EvidenceMemoryReadinessDashboard,
  type EvidenceMemoryReadinessEvaluationResult,
} from '@shared/evidence-memory-inspector';
import {
  GUARDIAN_SHADOW_READINESS_THRESHOLDS,
  type GuardianReleaseReadiness,
  type GuardianShadowReadiness,
} from '@shared/guardian-release-readiness';
import { DisposableService } from './disposable';
import type { EvidenceMemoryDogfoodBackfill } from './evidence-memory-dogfood-backfill';
import type { KartonService } from './karton';
import type { Logger } from './logger';

const PROCEDURE_NAMES = [
  'evidenceMemoryInspector.getSnapshot',
  'evidenceMemoryInspector.search',
  'evidenceMemoryInspector.getClaimDetails',
  'evidenceMemoryInspector.resolveConflict',
  'evidenceMemoryInspector.undoConflictResolution',
  'evidenceMemoryInspector.evaluateDogfood',
  'evidenceMemoryInspector.getDogfoodDashboard',
  'evidenceMemoryInspector.getReadinessDashboard',
  'evidenceMemoryInspector.evaluateReadiness',
  'evidenceMemoryInspector.runDogfoodBackfill',
  'evidenceMemoryInspector.exportToFile',
  'evidenceMemoryInspector.resetTask',
] as const;

interface SaveExportResult {
  canceled: boolean;
  filePath?: string;
}

type EvidenceMemoryInspectorStore = Pick<
  EvidenceMemoryService,
  | 'getInspectorSnapshot'
  | 'searchClaims'
  | 'getClaimDetails'
  | 'resolveConflict'
  | 'undoConflictResolution'
  | 'record'
  | 'getDogfoodCohortReport'
  | 'listMaterializedSummaries'
  | 'buildSummaryOrientation'
  | 'pruneByDefaultRetention'
  | 'exportTask'
  | 'clearTask'
>;

export interface EvidenceMemoryInspectorServiceOptions {
  logger: Logger;
  karton: KartonService;
  evidenceMemory: EvidenceMemoryInspectorStore | undefined;
  summaryScheduler?: Pick<EvidenceMemorySummaryScheduler, 'getSnapshot'>;
  getGuardianReadiness?: () => GuardianReleaseReadiness | null;
  getGuardianShadowReadiness?: () => GuardianShadowReadiness | null;
  dogfoodBackfill?: Pick<EvidenceMemoryDogfoodBackfill, 'run'>;
  isFeatureEnabled: (feature: FeatureGateId) => boolean;
  saveExport?: (
    exported: EvidenceMemoryTaskExport,
  ) => Promise<SaveExportResult>;
}

/**
 * Explicit trusted-UI access to task-scoped Evidence Graph Memory. No
 * procedure exposes the SQLite database or permits cross-task claim reads.
 */
export class EvidenceMemoryInspectorService extends DisposableService {
  private constructor(
    private readonly options: EvidenceMemoryInspectorServiceOptions,
  ) {
    super();
  }

  public static async create(
    options: EvidenceMemoryInspectorServiceOptions,
  ): Promise<EvidenceMemoryInspectorService> {
    const service = new EvidenceMemoryInspectorService(options);
    service.registerProcedures();
    return service;
  }

  private registerProcedures(): void {
    const { karton } = this.options;
    karton.registerServerProcedureHandler(
      'evidenceMemoryInspector.getSnapshot',
      async (_clientId, value) => {
        const input = evidenceMemoryInspectorSnapshotInputSchema.parse(value);
        return await this.assertReady().getInspectorSnapshot(input);
      },
    );
    karton.registerServerProcedureHandler(
      'evidenceMemoryInspector.search',
      async (_clientId, value) => {
        const input = evidenceMemoryInspectorSearchInputSchema.parse(value);
        return await this.assertReady().searchClaims(input);
      },
    );
    karton.registerServerProcedureHandler(
      'evidenceMemoryInspector.getClaimDetails',
      async (_clientId, value) => {
        const input = evidenceMemoryClaimDetailsInputSchema.parse(value);
        const details = await this.assertReady().getClaimDetails(input.claimId);
        if (details.claim.taskId !== input.taskId) {
          throw new Error('Evidence memory claim does not belong to this task');
        }
        return details;
      },
    );
    karton.registerServerProcedureHandler(
      'evidenceMemoryInspector.resolveConflict',
      async (_clientId, value) => {
        const input = evidenceMemoryConflictResolutionInputSchema.parse(value);
        return await this.assertReady().resolveConflict(input);
      },
    );
    karton.registerServerProcedureHandler(
      'evidenceMemoryInspector.undoConflictResolution',
      async (_clientId, value) => {
        const input =
          evidenceMemoryConflictResolutionUndoInputSchema.parse(value);
        return await this.assertReady().undoConflictResolution(
          input.taskId,
          input.resolutionId,
        );
      },
    );
    karton.registerServerProcedureHandler(
      'evidenceMemoryInspector.evaluateDogfood',
      async (_clientId, value) => {
        const input = evidenceMemoryDogfoodEvaluationInputSchema.parse(value);
        const memory = this.assertReady();
        const report = evaluateEvidenceMemoryDogfood(
          input.observations,
          input.thresholds,
        );
        await memory.record({
          taskId: input.taskId,
          type: 'memory_dogfood_evaluated',
          source: 'evidence_memory_dogfood',
          ingestionKey: `memory-dogfood:${report.policyHash}:${report.sampleCount}:${report.guardedMemoryRecall}:${report.guardedMemoryStaleLeakageRate}`,
          payload: toEvidenceMemoryDogfoodReceipt(report),
        });
        return report;
      },
    );
    karton.registerServerProcedureHandler(
      'evidenceMemoryInspector.getDogfoodDashboard',
      async () => {
        return await this.assertReady().getDogfoodCohortReport();
      },
    );
    karton.registerServerProcedureHandler(
      'evidenceMemoryInspector.getReadinessDashboard',
      async (_clientId, value) => {
        const input = evidenceMemoryReadinessInputSchema.parse(value);
        return await this.buildReadinessDashboard(input.taskId);
      },
    );
    karton.registerServerProcedureHandler(
      'evidenceMemoryInspector.evaluateReadiness',
      async (
        _clientId,
        value,
      ): Promise<EvidenceMemoryReadinessEvaluationResult> => {
        const input = evidenceMemoryReadinessInputSchema.parse(value);
        const dashboard = await this.buildReadinessDashboard(input.taskId);
        const receipt = createReadinessReceipt(dashboard);
        const event = await this.assertReady().record({
          taskId: input.taskId,
          type: 'memory_readiness_evaluated',
          source: 'evidence_memory_readiness',
          ingestionKey: `memory-readiness:v1:${dashboard.policyHash}:${hashReceipt(receipt)}`,
          payload: receipt,
        });
        return { dashboard, receiptEventId: event.id };
      },
    );
    karton.registerServerProcedureHandler(
      'evidenceMemoryInspector.runDogfoodBackfill',
      async (
        _clientId,
        value,
      ): Promise<EvidenceMemoryDogfoodBackfillResult> => {
        const input = evidenceMemoryDogfoodBackfillInputSchema.parse(value);
        this.assertReady();
        if (!this.options.dogfoodBackfill) {
          throw new Error('Evidence Memory dogfood backfill is unavailable');
        }
        return await this.options.dogfoodBackfill.run(input);
      },
    );
    karton.registerServerProcedureHandler(
      'evidenceMemoryInspector.exportToFile',
      async (_clientId, value) => {
        return await this.exportToFile(value);
      },
    );
    karton.registerServerProcedureHandler(
      'evidenceMemoryInspector.resetTask',
      async (_clientId, value) => {
        return await this.resetTask(value);
      },
    );
  }

  private async exportToFile(
    value: string,
  ): Promise<EvidenceMemoryInspectorExportResult> {
    const taskId = evidenceMemoryTaskIdSchema.parse(value);
    const exported = await this.assertReady().exportTask(taskId);
    const result = await (this.options.saveExport ?? saveEvidenceMemoryExport)(
      exported,
    );
    return {
      ...result,
      taskId,
      eventCount: exported.snapshot.recentEvents.length,
      claimCount: exported.snapshot.claims.length,
      truncated: exported.truncated.events || exported.truncated.claims,
    };
  }

  private async resetTask(
    value: string,
  ): Promise<EvidenceMemoryInspectorResetResult> {
    const taskId = evidenceMemoryTaskIdSchema.parse(value);
    return await this.assertReady().clearTask(taskId);
  }

  private async buildReadinessDashboard(
    taskId: string,
  ): Promise<EvidenceMemoryReadinessDashboard> {
    const memory = this.assertReady();
    const generatedAt = Date.now();
    const [dogfood, summaries, orientation, pruningPreview] = await Promise.all(
      [
        memory.getDogfoodCohortReport(),
        memory.listMaterializedSummaries(taskId),
        memory.buildSummaryOrientation({ taskId, tokenBudget: 4_000 }),
        memory.pruneByDefaultRetention({ taskId, at: generatedAt }),
      ],
    );
    const short = summaries.filter((summary) => summary.tier === '10m');
    const long = summaries.filter((summary) => summary.tier === '6h');
    const scheduler = this.options.summaryScheduler?.getSnapshot() ?? null;
    const guardian = this.options.getGuardianReadiness?.() ?? null;
    const guardianShadow = this.options.getGuardianShadowReadiness?.() ?? null;
    const gates = {
      modelSummaries: this.options.isFeatureEnabled(
        'evidence-memory-model-summaries',
      ),
      guardianShadow: this.options.isFeatureEnabled('guardian-model-shadow'),
      promptInjection: this.options.isFeatureEnabled(
        'evidence-memory-prompt-injection',
      ),
    };
    const blockers = [
      ...dogfood.promotionBlockers.map((blocker) => `memory:${blocker}`),
      ...(long.length === 0 ? ['memory:no-long-summary'] : []),
      ...(!scheduler ? ['scheduler:unavailable'] : []),
      ...(scheduler?.droppedTasks ? ['scheduler:dropped-tasks'] : []),
      ...(scheduler?.backingOffTasks ? ['scheduler:backing-off'] : []),
      ...(scheduler?.lastRun?.failedTasks ? ['scheduler:last-run-failed'] : []),
      ...(pruningPreview.uncoveredCount > 0
        ? ['pruning:uncovered-events']
        : []),
      ...(!guardian ? ['guardian:unavailable'] : []),
      ...(guardian?.checks
        .filter((check) => !check.passed)
        .map((check) => `guardian:${check.id}`) ?? []),
      ...(gates.guardianShadow && !guardianShadow
        ? ['guardian-shadow:unavailable']
        : []),
      ...(gates.guardianShadow
        ? (guardianShadow?.checks
            .filter((check) => !check.passed)
            .map((check) => `guardian-shadow:${check.id}`) ?? [])
        : []),
    ];
    const uniqueBlockers = [...new Set(blockers)].sort();
    const collecting =
      dogfood.sampleCount < 100 ||
      long.length === 0 ||
      guardian?.status === 'collecting' ||
      (gates.guardianShadow &&
        (!guardianShadow || guardianShadow.status === 'collecting'));
    return {
      version: 1,
      taskId,
      generatedAt,
      status:
        uniqueBlockers.length === 0
          ? 'candidate'
          : collecting
            ? 'collecting'
            : 'needs-tuning',
      policyHash: READINESS_POLICY_HASH,
      blockers: uniqueBlockers,
      gates,
      summaries: {
        shortCount: short.length,
        longCount: long.length,
        latestShortAt: short[0]?.windowEndedAt ?? null,
        latestLongAt: long[0]?.windowEndedAt ?? null,
        orientationSummaryCount: orientation.summaries.length,
        orientationEstimatedTokens: orientation.estimatedTokens,
      },
      scheduler,
      pruningPreview: {
        eligibleEventCount: pruningPreview.eligibleEventCount,
        protectedByClaimCount: pruningPreview.protectedByClaimCount,
        protectedByTypeCount: pruningPreview.protectedByTypeCount,
        uncoveredCount: pruningPreview.uncoveredCount,
        retainedByTtlCount: pruningPreview.retainedByTtlCount,
      },
      memory: dogfood,
      guardian,
      guardianShadow,
    };
  }

  private assertReady(): EvidenceMemoryInspectorStore {
    if (!this.options.isFeatureEnabled('evidence-memory-inspector')) {
      throw new Error('Evidence memory inspector feature is disabled');
    }
    if (!this.options.evidenceMemory) {
      throw new Error('Evidence memory ledger is unavailable');
    }
    return this.options.evidenceMemory;
  }

  protected onTeardown(): void {
    for (const procedureName of PROCEDURE_NAMES) {
      this.options.karton.removeServerProcedureHandler(procedureName);
    }
  }
}

const READINESS_POLICY_HASH = createHash('sha256')
  .update(
    JSON.stringify({
      version: 1,
      memoryMinimumObservations: 100,
      requireLongSummary: true,
      requireSchedulerHealthy: true,
      requirePruningCoverage: true,
      requireGuardianCandidate: true,
      requireGuardianShadowCandidateWhenGateEnabled: true,
      guardianShadowThresholds: GUARDIAN_SHADOW_READINESS_THRESHOLDS,
    }),
  )
  .digest('hex');

function createReadinessReceipt(dashboard: EvidenceMemoryReadinessDashboard) {
  return {
    version: 1 as const,
    generatedAt: dashboard.generatedAt,
    status: dashboard.status,
    policyHash: dashboard.policyHash,
    blockers: dashboard.blockers,
    summaryShortCount: dashboard.summaries.shortCount,
    summaryLongCount: dashboard.summaries.longCount,
    schedulerPendingTasks: dashboard.scheduler?.pendingTasks ?? null,
    schedulerBackingOffTasks: dashboard.scheduler?.backingOffTasks ?? null,
    schedulerDroppedTasks: dashboard.scheduler?.droppedTasks ?? null,
    pruningEligibleEventCount: dashboard.pruningPreview.eligibleEventCount,
    pruningUncoveredCount: dashboard.pruningPreview.uncoveredCount,
    memorySampleCount: dashboard.memory.sampleCount,
    memoryPromotionReady: dashboard.memory.promotionReady,
    guardianStatus: dashboard.guardian?.status ?? null,
    guardianLabeled: dashboard.guardian?.labeled ?? null,
    guardianShadowEnabled: dashboard.gates.guardianShadow,
    guardianShadowStatus: dashboard.guardianShadow?.status ?? null,
    guardianShadowTotal: dashboard.guardianShadow?.total ?? null,
    guardianShadowSuccessRate: dashboard.guardianShadow?.successRate ?? null,
    guardianShadowRiskAgreementRate:
      dashboard.guardianShadow?.riskAgreementRate ?? null,
    guardianShadowDecisionAgreementRate:
      dashboard.guardianShadow?.decisionAgreementRate ?? null,
    guardianShadowCriticalRiskDisagreements:
      dashboard.guardianShadow?.criticalRiskDisagreements ?? null,
    guardianShadowAverageLatencyMs:
      dashboard.guardianShadow?.averageLatencyMs ?? null,
  };
}

function hashReceipt(receipt: ReturnType<typeof createReadinessReceipt>) {
  return createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
}

async function saveEvidenceMemoryExport(
  exported: EvidenceMemoryTaskExport,
): Promise<SaveExportResult> {
  const date = new Date(exported.exportedAt).toISOString().slice(0, 10);
  const safeTaskId = exported.taskId
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(0, 80);
  const result = await dialog.showSaveDialog({
    title: 'Export evidence memory',
    defaultPath: `clodex-evidence-memory-${safeTaskId || 'task'}-${date}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(
    result.filePath,
    `${JSON.stringify(exported, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return { canceled: false, filePath: result.filePath };
}
