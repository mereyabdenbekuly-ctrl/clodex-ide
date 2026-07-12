import { vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn() },
}));

import { afterEach, describe, expect, it } from 'vitest';
import { guardianDogfoodStateSchema } from '@shared/guardian';
import {
  evaluateGuardianReleaseReadiness,
  evaluateGuardianShadowReadiness,
} from '@shared/guardian-release-readiness';
import type { FeatureGateId } from '@shared/feature-gates';
import type { KartonService } from './karton';
import type { Logger } from './logger';
import { EvidenceMemoryInspectorService } from './evidence-memory-inspector';

type Handler = (clientId: string, ...args: never[]) => Promise<unknown>;
const services: EvidenceMemoryInspectorService[] = [];

function createHarness(
  enabled = true,
  disabledFeatures: readonly FeatureGateId[] = [],
) {
  const handlers = new Map<string, Handler>();
  const removed: string[] = [];
  const karton = {
    registerServerProcedureHandler(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    removeServerProcedureHandler(name: string) {
      removed.push(name);
      handlers.delete(name);
    },
  } as unknown as KartonService;
  const snapshot = {
    taskId: 'task-a',
    generatedAt: 10,
    stats: {
      events: { total: 1, byType: { user_message: 1 } },
      claims: {
        total: 1,
        byKind: { user_constraint: 1 },
        byStatus: { active: 1 },
      },
      fingerprints: {},
      oldestEventAt: 1,
      newestEventAt: 1,
      oldestClaimAt: 2,
      newestClaimAt: 2,
    },
    quality: {
      status: 'healthy' as const,
      ingestion: {
        totalEvents: 1,
        deterministicEvents: 1,
        deterministicCoverage: 1,
        sourceAttributedEvents: 1,
        sourceCoverage: 1,
        payloadHashedEvents: 1,
        payloadHashCoverage: 1,
        totalClaims: 1,
        evidenceBackedClaims: 1,
        evidenceBackedClaimRate: 1,
      },
      retrieval: {
        totalContextPacks: 1,
        sampledContextPacks: 1,
        packsWithClaims: 1,
        hitRate: 1,
        averageClaimsPerPack: 1,
        averageEstimatedTokens: 100,
        tokenBudgetUtilization: 0.1,
        staleExclusions: 0,
        staleExclusionRate: 0,
        lexicalEvidenceRate: 1,
        averageCodeSnippets: 0,
        graphExpansionRate: 0,
        tokenBudgetExclusions: 0,
        tokenBudgetExclusionRate: 0,
      },
      contradictionAutomation: {
        totalRelations: 0,
        automatedRelations: 0,
        superseded: 0,
        invalidated: 0,
        contradictions: 0,
        confirmations: 0,
        unresolvedConflicts: 0,
      },
      warnings: [],
    },
    recentEvents: [],
    claims: [],
    conflicts: [],
    conflictResolutions: [],
    latestContextPackEvent: null,
  };
  const evidenceMemory = {
    getInspectorSnapshot: vi.fn(async () => snapshot),
    record: vi.fn(async (event: object) => ({ id: 'receipt-event', ...event })),
    getDogfoodCohortReport: vi.fn(async () => ({
      thresholdVersion: 1 as const,
      policyHash: 'a'.repeat(64),
      sampleCount: 0,
      expectedClaimCount: 0,
      forbiddenClaimCount: 0,
      compressedHistoryRecall: 1,
      guardedMemoryRecall: 1,
      recallLift: 0,
      compressedHistoryStaleLeakageRate: 0,
      guardedMemoryStaleLeakageRate: 0,
      compressedHistoryLatencyP95Ms: 0,
      guardedMemoryLatencyP95Ms: 0,
      compressedHistoryTotalTokens: 0,
      guardedMemoryTotalTokens: 0,
      tokenOverheadRatio: 0,
      missingProvenanceAdmissionCount: 0,
      unresolvedContradictionInjectionCount: 0,
      promotionReady: false,
      promotionBlockers: ['insufficient-observations' as const],
      totalObservationCount: 0,
      staleObservationCount: 0,
      freshnessWindowMs: 30 * 24 * 60 * 60 * 1_000,
      distinctTaskCount: 0,
      categoryCoverage: {
        exact_fact: 0,
        user_constraint: 0,
        staleness: 0,
        supersession: 0,
        restart: 0,
        fork_isolation: 0,
        workspace_isolation: 0,
      },
    })),
    listMaterializedSummaries: vi.fn(async () => [
      {
        eventId: 'summary-short',
        taskId: 'task-a',
        workspaceId: null,
        tier: '10m' as const,
        windowStartedAt: 0,
        windowEndedAt: 600_000,
        markdown: 'short',
        sourceEventIds: ['event-1'],
        sourceHash: 'b'.repeat(64),
        createdAt: 600_000,
      },
      {
        eventId: 'summary-long',
        taskId: 'task-a',
        workspaceId: null,
        tier: '6h' as const,
        windowStartedAt: 0,
        windowEndedAt: 21_600_000,
        markdown: 'long',
        sourceEventIds: ['event-1'],
        sourceHash: 'c'.repeat(64),
        createdAt: 21_600_000,
      },
    ]),
    buildSummaryOrientation: vi.fn(async () => ({
      taskId: 'task-a',
      markdown: 'orientation',
      summaries: [],
      estimatedTokens: 20,
      tokenBudget: 4_000,
      createdAt: 30,
    })),
    pruneByDefaultRetention: vi.fn(async () => ({
      taskId: 'task-a',
      dryRun: true,
      eligibleEventCount: 2,
      deletedEventCount: 0,
      protectedByClaimCount: 1,
      protectedByTypeCount: 3,
      uncoveredCount: 0,
      retainedByTtlCount: 4,
    })),
    searchClaims: vi.fn(async () => []),
    getClaimDetails: vi.fn(async () => ({
      claim: {
        id: 'claim-a',
        taskId: 'task-a',
        workspaceId: null,
        kind: 'user_constraint',
        subject: 'api.stability',
        text: 'Keep the API stable.',
        status: 'active',
        confidence: 0.9,
        evidenceEventIds: [],
        entities: [],
        validAtRevision: null,
        invalidatedBy: null,
        createdAt: 1,
        updatedAt: 1,
      },
      evidenceEvents: [],
      relations: [],
      fingerprints: [],
      truth: {
        taskId: 'task-a',
        subject: 'api.stability',
        state: 'resolved',
        selectedClaim: null,
        supportingClaims: [],
        competingClaims: [],
        exclusions: [],
        conflicts: [],
      },
    })),
    exportTask: vi.fn(async () => ({
      format: 'clodex-evidence-memory' as const,
      version: 1 as const,
      exportedAt: 10,
      taskId: 'task-a',
      truncated: { events: false, claims: false },
      snapshot,
    })),
    clearTask: vi.fn(async () => ({
      taskId: 'task-a',
      deletedEvents: 2,
      deletedClaims: 1,
    })),
    resolveConflict: vi.fn(async () => ({
      id: 'resolution-a',
      taskId: 'task-a',
      subject: 'api.stability',
      claimIds: ['claim-a', 'claim-b'],
      action: 'accept_newer' as const,
      selectedClaimId: 'claim-b',
      createdAt: 20,
      revertedAt: null,
    })),
    undoConflictResolution: vi.fn(async () => ({
      id: 'resolution-a',
      taskId: 'task-a',
      subject: 'api.stability',
      claimIds: ['claim-a', 'claim-b'],
      action: 'accept_newer' as const,
      selectedClaimId: 'claim-b',
      createdAt: 20,
      revertedAt: 30,
    })),
  };
  return {
    handlers,
    removed,
    karton,
    evidenceMemory,
    summaryScheduler: {
      getSnapshot: vi.fn(() => ({
        running: false,
        intervalMs: 60_000,
        maxTasksPerPass: 25,
        maxPendingTasks: 1_000,
        pendingTasks: 0,
        backingOffTasks: 0,
        droppedTasks: 0,
        lastRun: null,
      })),
    },
    getGuardianReadiness: () =>
      evaluateGuardianReleaseReadiness(guardianDogfoodStateSchema.parse({})),
    getGuardianShadowReadiness: () =>
      evaluateGuardianShadowReadiness(
        guardianDogfoodStateSchema.parse({}).shadow,
      ),
    isFeatureEnabled: (feature: FeatureGateId) =>
      enabled && !disabledFeatures.includes(feature),
    dogfoodBackfill: {
      run: vi.fn(async () => ({
        archivesScanned: 2,
        archivesWithCompression: 1,
        observationsReplayed: 3,
        observationsSkipped: 1,
        failures: 0,
      })),
    },
    saveExport: vi.fn(async () => ({
      canceled: false,
      filePath: '/tmp/evidence.json',
    })),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger,
  };
}

async function createService(harness: ReturnType<typeof createHarness>) {
  const service = await EvidenceMemoryInspectorService.create({
    logger: harness.logger,
    karton: harness.karton,
    evidenceMemory: harness.evidenceMemory as never,
    summaryScheduler: harness.summaryScheduler,
    getGuardianReadiness: harness.getGuardianReadiness,
    getGuardianShadowReadiness: harness.getGuardianShadowReadiness,
    dogfoodBackfill: harness.dogfoodBackfill,
    isFeatureEnabled: harness.isFeatureEnabled,
    saveExport: harness.saveExport,
  });
  services.push(service);
  return service;
}

afterEach(() => {
  for (const service of services.splice(0)) service.teardown();
  vi.restoreAllMocks();
});

describe('EvidenceMemoryInspectorService', () => {
  it('serves bounded task-scoped snapshot, search, export, and reset', async () => {
    const harness = createHarness();
    await createService(harness);

    await harness.handlers.get('evidenceMemoryInspector.getSnapshot')!(
      'client',
      { taskId: 'task-a', eventLimit: 20, claimLimit: 30 } as never,
    );
    await harness.handlers.get('evidenceMemoryInspector.search')!('client', {
      taskId: 'task-a',
      query: 'stable API',
      limit: 10,
    } as never);
    await harness.handlers.get('evidenceMemoryInspector.resolveConflict')!(
      'client',
      {
        taskId: 'task-a',
        claimIds: ['claim-a', 'claim-b'],
        action: 'accept_newer',
      } as never,
    );
    await harness.handlers.get(
      'evidenceMemoryInspector.undoConflictResolution',
    )!('client', { taskId: 'task-a', resolutionId: 'resolution-a' } as never);
    const dogfood = await harness.handlers.get(
      'evidenceMemoryInspector.evaluateDogfood',
    )!('client', {
      taskId: 'task-a',
      observations: [
        {
          observationVersion: 3,
          scenarioIdHash: 'a'.repeat(64),
          category: 'exact_fact',
          expectedClaimCount: 1,
          compressedHistoryRecoveredCount: 0,
          guardedMemoryRecoveredCount: 1,
          forbiddenClaimCount: 1,
          compressedHistoryLeakedCount: 1,
          guardedMemoryLeakedCount: 0,
          compressedHistoryTokens: 100,
          guardedMemoryTokens: 110,
          compressedHistoryLatencyMs: 10,
          guardedMemoryLatencyMs: 20,
        },
      ],
      thresholds: {
        minimumObservations: 1,
        minimumRecallLift: 0.5,
      },
    } as never);
    const dashboard = await harness.handlers.get(
      'evidenceMemoryInspector.getDogfoodDashboard',
    )!('client');
    const readiness = await harness.handlers.get(
      'evidenceMemoryInspector.getReadinessDashboard',
    )!('client', { taskId: 'task-a' } as never);
    const evaluation = await harness.handlers.get(
      'evidenceMemoryInspector.evaluateReadiness',
    )!('client', { taskId: 'task-a' } as never);
    const backfill = await harness.handlers.get(
      'evidenceMemoryInspector.runDogfoodBackfill',
    )!('client', {} as never);
    const exported = await harness.handlers.get(
      'evidenceMemoryInspector.exportToFile',
    )!('client', 'task-a' as never);
    const reset = await harness.handlers.get(
      'evidenceMemoryInspector.resetTask',
    )!('client', 'task-a' as never);

    expect(harness.evidenceMemory.getInspectorSnapshot).toHaveBeenCalledWith({
      taskId: 'task-a',
      eventLimit: 20,
      claimLimit: 30,
    });
    expect(harness.evidenceMemory.searchClaims).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-a', query: 'stable API' }),
    );
    expect(harness.evidenceMemory.resolveConflict).toHaveBeenCalledWith({
      taskId: 'task-a',
      claimIds: ['claim-a', 'claim-b'],
      action: 'accept_newer',
    });
    expect(harness.evidenceMemory.undoConflictResolution).toHaveBeenCalledWith(
      'task-a',
      'resolution-a',
    );
    expect(dogfood).toEqual(
      expect.objectContaining({
        sampleCount: 1,
        promotionReady: true,
      }),
    );
    expect(harness.evidenceMemory.record).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-a',
        type: 'memory_dogfood_evaluated',
        payload: expect.not.objectContaining({
          scenarioIdHash: expect.anything(),
        }),
      }),
    );
    expect(dashboard).toEqual(expect.objectContaining({ sampleCount: 0 }));
    expect(readiness).toEqual(
      expect.objectContaining({
        status: 'collecting',
        summaries: expect.objectContaining({ shortCount: 1, longCount: 1 }),
        pruningPreview: expect.objectContaining({ eligibleEventCount: 2 }),
        guardianShadow: expect.objectContaining({
          status: 'collecting',
          total: 0,
        }),
        blockers: expect.arrayContaining([
          'guardian-shadow:total-observations',
        ]),
      }),
    );
    expect(evaluation).toEqual(
      expect.objectContaining({ receiptEventId: 'receipt-event' }),
    );
    expect(harness.evidenceMemory.record).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-a',
        type: 'memory_readiness_evaluated',
        payload: expect.objectContaining({
          status: 'collecting',
          summaryLongCount: 1,
          guardianShadowEnabled: true,
          guardianShadowStatus: 'collecting',
          guardianShadowTotal: 0,
        }),
      }),
    );
    expect(backfill).toEqual(
      expect.objectContaining({ observationsReplayed: 3 }),
    );
    expect(exported).toEqual(
      expect.objectContaining({
        taskId: 'task-a',
        canceled: false,
        truncated: false,
      }),
    );
    expect(reset).toEqual({
      taskId: 'task-a',
      deletedEvents: 2,
      deletedClaims: 1,
    });
  });

  it('rejects cross-task claim details and rechecks the gate', async () => {
    const harness = createHarness();
    await createService(harness);
    await expect(
      harness.handlers.get('evidenceMemoryInspector.getClaimDetails')!(
        'client',
        { taskId: 'task-b', claimId: 'claim-a' } as never,
      ),
    ).rejects.toThrow('does not belong');

    const disabled = createHarness(false);
    await createService(disabled);
    await expect(
      disabled.handlers.get('evidenceMemoryInspector.getSnapshot')!('client', {
        taskId: 'task-a',
      } as never),
    ).rejects.toThrow('feature is disabled');
  });

  it('observes shadow readiness without blocking when its gate is off', async () => {
    const harness = createHarness(true, ['guardian-model-shadow']);
    await createService(harness);

    const readiness = await harness.handlers.get(
      'evidenceMemoryInspector.getReadinessDashboard',
    )!('client', { taskId: 'task-a' } as never);

    expect(readiness).toEqual(
      expect.objectContaining({
        gates: expect.objectContaining({ guardianShadow: false }),
        guardianShadow: expect.objectContaining({
          status: 'collecting',
          total: 0,
        }),
      }),
    );
    expect(
      (readiness as { blockers: string[] }).blockers.some((blocker) =>
        blocker.startsWith('guardian-shadow:'),
      ),
    ).toBe(false);
  });

  it('removes every procedure on teardown', async () => {
    const harness = createHarness();
    const service = await createService(harness);
    service.teardown();
    expect(harness.removed).toHaveLength(12);
  });
});
