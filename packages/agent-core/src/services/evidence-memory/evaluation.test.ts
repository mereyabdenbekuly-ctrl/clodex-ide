import { describe, expect, it } from 'vitest';
import type { Logger } from '../../host/logger';
import {
  EVIDENCE_MEMORY_DOGFOOD_OBSERVATION_VERSION,
  EVIDENCE_MEMORY_DOGFOOD_COHORT_TASK_ID,
  EvidenceMemoryService,
} from './index';
import {
  createEvidenceMemoryEvaluationFixture,
  createEvidenceMemoryQualityFixture,
  createEvidenceMemoryLiveDogfoodObservation,
  evaluateEvidenceMemoryDogfood,
  evaluateEvidenceMemoryDogfoodCohort,
  evaluateEvidenceMemoryQuality,
  runEvidenceMemoryEvaluation,
  runEvidenceMemoryDogfoodComparison,
  toEvidenceMemoryDogfoodReceipt,
  toEvidenceMemoryQualityReceipt,
  type EvidenceMemoryDogfoodObservation,
} from './evaluation';

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe('Evidence Memory evaluation suite', () => {
  it.each([
    100, 500, 1_000,
  ] as const)('measures the complete quality envelope over %i observations', (observationCount) => {
    const observations = createEvidenceMemoryQualityFixture(observationCount);
    const report = evaluateEvidenceMemoryQuality(observations);

    expect(report.observationCount).toBe(observationCount);
    expect(report.factRecall).toBe(1);
    expect(report.staleMemoryRate).toBe(0);
    expect(report.convergenceRate).toBe(1);
    expect(report.falseAutoMergeRate).toBe(0);
    expect(report.unsafeMergeObservationCount).toBe(observationCount / 10);
    expect(report.tokenSavingsRatio).toBeGreaterThan(0.79);
    expect(report.promotionReady).toBe(true);
    expect(report.promotionBlockers).toEqual([]);
    expect(report.policyHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('fails promotion on stale memory, missed facts, failed convergence, false merge, and token regression', () => {
    const report = evaluateEvidenceMemoryQuality(
      [
        {
          observationIdHash: 'a'.repeat(64),
          expectedFactCount: 2,
          recoveredFactCount: 1,
          staleFactCount: 1,
          staleInjectedCount: 1,
          baselineTokens: 100,
          evidenceMemoryTokens: 150,
          synchronization: {
            expectedToConverge: true,
            converged: false,
            autoMergeDecision: 'applied',
            groundTruthMergeSafe: false,
          },
        },
      ],
      {
        minimumObservations: 1,
        minimumSyncObservations: 1,
        minimumUnsafeMergeObservations: 1,
      },
    );

    expect(report.factRecall).toBe(0.5);
    expect(report.staleMemoryRate).toBe(1);
    expect(report.convergenceRate).toBe(0);
    expect(report.falseAutoMergeRate).toBe(1);
    expect(report.tokensSaved).toBe(-50);
    expect(report.tokenSavingsRatio).toBe(-0.5);
    expect(report.promotionReady).toBe(false);
    expect(report.promotionBlockers).toEqual(
      expect.arrayContaining([
        'fact-recall-below-target',
        'stale-memory-above-target',
        'convergence-below-target',
        'false-auto-merge-above-target',
        'token-savings-below-target',
      ]),
    );
  });

  it('emits a content-free quality receipt', () => {
    const report = evaluateEvidenceMemoryQuality(
      createEvidenceMemoryQualityFixture(100),
    );
    const receipt = toEvidenceMemoryQualityReceipt(report);

    expect(receipt).toEqual(
      expect.objectContaining({
        factRecall: 1,
        staleMemoryRate: 0,
        convergenceRate: 1,
        falseAutoMergeRate: 0,
        promotionReady: true,
      }),
    );
    expect(JSON.stringify(receipt)).not.toContain('observationIdHash');
  });

  it('measures recall, stale leakage, latency, and token overhead', async () => {
    const directory = path.join(os.tmpdir(), 'evidence-memory-evaluation');
    await fs.mkdir(directory, { recursive: true });
    const service = await EvidenceMemoryService.createWithUrl(
      `file:${path.join(directory, `${randomUUID()}.sqlite`)}`,
      { logger },
    );
    try {
      await service.recordClaim({
        id: 'constraint',
        taskId: 'task-a',
        kind: 'user_constraint',
        subject: 'api.compatibility',
        text: 'Keep the public API stable.',
        confidence: 0.4,
      });
      await service.recordClaim({
        id: 'stale-fact',
        taskId: 'task-a',
        kind: 'observed_fact',
        subject: 'build.revision',
        text: 'The build uses revision abc123.',
        confidence: 0.4,
        validAtRevision: 'abc123',
      });
      const ticks = [0, 4, 10, 17];
      const report = await runEvidenceMemoryEvaluation(
        service,
        [
          {
            id: 'constraint-recall',
            taskId: 'task-a',
            query: 'public API stable',
            expectedClaimIds: ['constraint'],
            category: 'user_constraint',
          },
          {
            id: 'stale-filter',
            taskId: 'task-a',
            query: 'build revision',
            repositoryRevision: 'def456',
            expectedClaimIds: [],
            forbiddenClaimIds: ['stale-fact'],
            category: 'staleness',
          },
        ],
        () => ticks.shift() ?? 17,
      );

      expect(report.userConstraintRecall).toBe(1);
      expect(report.staleLeakageRate).toBe(0);
      expect(report.staleEvidenceInjectionRate).toBe(0);
      expect(report.overallRecall).toBe(1);
      expect(report.restartRecoveryRate).toBe(1);
      expect(report.latencyP50Ms).toBe(4);
      expect(report.latencyP95Ms).toBe(7);
      expect(report.scenarioCount).toBe(2);
      expect(report.failedScenarioIds).toEqual([]);
      expect(report.averageEstimatedTokens).toBeGreaterThanOrEqual(0);
      expect(report.totalEstimatedTokens).toBeGreaterThan(0);
      expect(report.maximumEstimatedTokens).toBeGreaterThan(0);
      expect(report.passedTargets).toBe(true);
    } finally {
      await service.teardown();
    }
  });

  it.each([
    100, 300, 1_000,
  ] as const)('generates a deterministic %i-event scale fixture', (eventCount) => {
    const fixture = createEvidenceMemoryEvaluationFixture(eventCount);
    expect(fixture.eventCount).toBe(eventCount);
    expect(fixture.events).toHaveLength(eventCount);
    expect(fixture.claims).toHaveLength(eventCount / 25);
    expect(fixture.scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'staleness' }),
        expect.objectContaining({ category: 'restart' }),
      ]),
    );
  });

  it('measures recovery after reopening the durable ledger', async () => {
    const directory = path.join(os.tmpdir(), 'evidence-memory-restart');
    await fs.mkdir(directory, { recursive: true });
    const url = `file:${path.join(directory, `${randomUUID()}.sqlite`)}`;
    const writer = await EvidenceMemoryService.createWithUrl(url, { logger });
    await writer.recordClaim({
      id: 'durable-claim',
      taskId: 'restart-task',
      kind: 'observed_fact',
      subject: 'restart.fact',
      text: 'The durable fact survives a process restart.',
      confidence: 0.4,
    });
    await writer.teardown();

    const reader = await EvidenceMemoryService.createWithUrl(url, { logger });
    try {
      const report = await runEvidenceMemoryEvaluation(reader, [
        {
          id: 'restart-recovery',
          taskId: 'restart-task',
          query: 'durable fact process restart',
          expectedClaimIds: ['durable-claim'],
          category: 'restart',
        },
      ]);
      expect(report.restartRecoveryRate).toBe(1);
      expect(report.failedScenarioIds).toEqual([]);
      expect(report.passedTargets).toBe(true);
    } finally {
      await reader.teardown();
    }
  });

  it('compares guarded memory with compressed history and promotes only strong evidence', () => {
    const observations = Array.from({ length: 100 }, (_, index) =>
      dogfoodObservation({
        scenarioIdHash: index.toString(16).padStart(64, '0'),
      }),
    );
    const report = evaluateEvidenceMemoryDogfood(observations);

    expect(report.compressedHistoryRecall).toBe(0.8);
    expect(report.guardedMemoryRecall).toBe(1);
    expect(report.recallLift).toBeCloseTo(0.2);
    expect(report.guardedMemoryStaleLeakageRate).toBe(0);
    expect(report.tokenOverheadRatio).toBe(0.1);
    expect(report.guardedMemoryLatencyP95Ms).toBe(25);
    expect(report.promotionReady).toBe(true);
    expect(report.promotionBlockers).toEqual([]);
    expect(report.policyHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('fails closed on weak samples, stale leakage, unsafe admissions, and unmeasurable tokens', () => {
    const report = evaluateEvidenceMemoryDogfood([
      dogfoodObservation({
        compressedHistoryTokens: 0,
        guardedMemoryTokens: 10,
        guardedMemoryRecoveredCount: 0,
        guardedMemoryLeakedCount: 1,
        missingProvenanceAdmissionCount: 1,
        unresolvedContradictionInjectionCount: 1,
        guardedMemoryLatencyMs: 300,
      }),
    ]);

    expect(report.promotionReady).toBe(false);
    expect(report.promotionBlockers).toEqual(
      expect.arrayContaining([
        'insufficient-observations',
        'guarded-recall-below-target',
        'recall-lift-below-target',
        'guarded-stale-leakage-above-target',
        'guarded-latency-above-target',
        'token-overhead-unmeasurable',
        'missing-provenance-admissions',
        'unresolved-contradiction-injections',
      ]),
    );
  });

  it('records only an aggregate protected dogfood receipt', async () => {
    const directory = path.join(os.tmpdir(), 'evidence-memory-dogfood');
    await fs.mkdir(directory, { recursive: true });
    const service = await EvidenceMemoryService.createWithUrl(
      `file:${path.join(directory, `${randomUUID()}.sqlite`)}`,
      { logger },
    );
    try {
      await service.recordClaim({
        id: 'remembered-claim',
        taskId: 'task-dogfood',
        kind: 'observed_fact',
        subject: 'dogfood.fact',
        text: 'The guarded path recovers this exact fact.',
      });
      const report = await runEvidenceMemoryDogfoodComparison(
        service,
        [
          {
            id: 'private-scenario-name',
            taskId: 'task-dogfood',
            query: 'guarded exact fact',
            expectedClaimIds: ['remembered-claim'],
            category: 'exact_fact',
          },
        ],
        {
          evaluateCompressedHistory: async () => ({
            recoveredClaimIds: [],
            estimatedTokens: 100,
            latencyMs: 5,
          }),
          thresholds: {
            minimumObservations: 1,
            minimumRecallLift: 0.5,
          },
          recordReceipt: true,
        },
        (() => {
          const ticks = [0, 10];
          return () => ticks.shift() ?? 10;
        })(),
      );
      const [receipt] = await service.list({
        taskId: 'task-dogfood',
        types: ['memory_dogfood_evaluated'],
        limit: 1,
      });

      expect(report.guardedMemoryRecall).toBe(1);
      expect(receipt?.payload).toEqual(toEvidenceMemoryDogfoodReceipt(report));
      expect(JSON.stringify(receipt?.payload)).not.toContain(
        'private-scenario-name',
      );
      expect(JSON.stringify(receipt?.payload)).not.toContain(
        'guarded exact fact',
      );
    } finally {
      await service.teardown();
    }
  });

  it('collects a real compressed-history pair and updates promotion progress', async () => {
    const directory = path.join(os.tmpdir(), 'evidence-memory-live-dogfood');
    await fs.mkdir(directory, { recursive: true });
    let observedCohortSampleCount = 0;
    const service = await EvidenceMemoryService.createWithUrl(
      `file:${path.join(directory, `${randomUUID()}.sqlite`)}`,
      {
        logger,
        onDogfoodCohortEvaluated: (report) => {
          observedCohortSampleCount = report.sampleCount;
        },
      },
    );
    try {
      const event = await service.record({
        taskId: 'live-task',
        type: 'user_message',
        payload: { text: 'Keep the public API stable.' },
      });
      await service.recordClaim({
        id: 'live-constraint',
        taskId: 'live-task',
        kind: 'user_constraint',
        subject: 'api.compatibility',
        text: 'Keep the public API stable.',
        evidenceEventIds: [event.id],
        confidence: 0.9,
      });
      const pack = await service.buildContextPack({
        taskId: 'live-task',
        query: 'public API compatibility',
        repositoryRevision: 'revision-a',
        recordShadowRun: false,
      });
      const admission = await service.evaluateContextPackForDogfood({
        pack,
        repositoryRevision: 'revision-a',
      });
      const result = await service.recordLiveDogfoodComparison({
        pack,
        admission,
        compressedHistory: 'We must keep the public API stable.',
        compressedHistoryLatencyMs: 1,
        guardedMemoryLatencyMs: 12,
        cohortIdSeed: 'controlled-cohort-a',
      });

      expect(result.observation.compressedHistoryRecoveredCount).toBe(1);
      expect(result.observation.guardedMemoryRecoveredCount).toBe(1);
      expect(result.report.sampleCount).toBe(1);
      expect(result.report.promotionBlockers).toContain(
        'insufficient-observations',
      );
      expect(result.cohortReport.distinctTaskCount).toBe(1);
      expect(result.observation.cohortIdHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.observation.diagnostics).toEqual(
        expect.objectContaining({
          retrievalCandidateCount: 1,
          retrievalSelectedCount: 1,
          admissionCandidateCount: 1,
          admissionSelectedCount: 1,
        }),
      );
      expect(observedCohortSampleCount).toBe(1);
      const stats = await service.getStats('live-task');
      expect(stats.byType.memory_dogfood_observed).toBe(1);
      expect(stats.byType.memory_dogfood_evaluated).toBe(1);
      const cohortStats = await service.getStats(
        EVIDENCE_MEMORY_DOGFOOD_COHORT_TASK_ID,
      );
      expect(cohortStats.byType.memory_dogfood_observed).toBe(1);
      expect(cohortStats.byType.memory_dogfood_evaluated).toBe(1);
      await expect(service.listDogfoodCohortObservations()).resolves.toEqual([
        result.observation,
      ]);
    } finally {
      await service.teardown();
    }
  });

  it('uses a deterministic lexical judge without retaining compressed text', () => {
    const claim = {
      id: 'claim',
      taskId: 'task',
      workspaceId: null,
      kind: 'observed_fact' as const,
      subject: 'build.experimental_vm_modules',
      text: 'The build requires --experimental-vm-modules.',
      status: 'active' as const,
      confidence: 0.9,
      evidenceEventIds: ['event'],
      entities: [],
      validAtRevision: 'revision-a',
      invalidatedBy: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const observation = createEvidenceMemoryLiveDogfoodObservation({
      pack: {
        id: 'pack',
        taskId: 'task',
        queryHash: 'query-hash',
        tokenBudget: 4_000,
        estimatedTokens: 50,
        items: [
          {
            claim,
            lexicalScore: 1,
            semanticScore: 0,
            hybridScore: 1,
            estimatedTokens: 50,
            codeEvidence: [],
            explanation: {
              originalRank: 1,
              matchedBy: ['lexical'],
              revisionStatus: 'current',
              evidenceEventCount: 1,
              graphSnippetCount: 0,
              utilityScore: 1,
              packingScore: 1,
            },
          },
        ],
        excludedStaleClaimIds: [],
        exclusions: [],
        diagnostics: {
          strategy: 'utility-density-v2',
          candidateCount: 1,
          selectedCount: 1,
          codeSnippetCount: 0,
          graphExpandedClaimCount: 0,
          envelopeTokens: 10,
          unusedTokens: 3_950,
        },
        createdAt: 1,
        shadow: true,
      },
      admission: {
        admitted: true,
        reasonCodes: ['admitted'],
        estimatedTokens: 50,
        claimCount: 1,
        selectedItems: [],
        policyHash: 'a'.repeat(64),
      },
      expectedClaims: [
        claim,
        {
          ...claim,
          id: 'claim-not-retrieved',
          subject: 'build.second_exact_fact',
          text: 'A second exact fact is deliberately absent from retrieval.',
        },
      ],
      compressedHistory:
        'Remember that the build requires --experimental-vm-modules.',
      compressedHistoryLatencyMs: 2,
      guardedMemoryLatencyMs: 8,
    });

    expect(observation.expectedClaimSource).toBe('explicit');
    expect(observation.expectedClaimCount).toBe(2);
    expect(observation.retrievalRecoveredCount).toBe(1);
    expect(observation.compressedHistoryRecoveredCount).toBe(1);
    expect(observation.guardedMemoryRecoveredCount).toBe(1);
    expect(observation.admissionRecoveredCount).toBe(0);
    const report = evaluateEvidenceMemoryDogfood([observation], {
      minimumObservations: 1,
      minimumGuardedRecall: 0,
      minimumRecallLift: 0,
      maximumTokenOverheadRatio: 10,
    });
    expect(report.retrievalRecall).toBe(0.5);
    expect(report.retrievalLossCount).toBe(1);
    expect(report.admissionLossCount).toBe(1);
    expect(JSON.stringify(observation)).not.toContain('experimental');
  });

  it('enforces fresh cross-task scenario coverage for promotion', () => {
    const now = 40 * 24 * 60 * 60 * 1_000;
    const categories = [
      ...Array.from({ length: 45 }, () => 'exact_fact' as const),
      ...Array.from({ length: 20 }, () => 'user_constraint' as const),
      ...Array.from({ length: 15 }, () => 'staleness' as const),
      ...Array.from({ length: 10 }, () => 'supersession' as const),
      ...Array.from({ length: 10 }, () => 'restart' as const),
    ];
    const observations = categories.map((category, index) =>
      dogfoodObservation({
        scenarioIdHash: index.toString(16).padStart(64, '0'),
        sourceTaskHash: (index % 3).toString(16).padStart(64, 'a'),
        observedAt: now - 1_000,
        category,
      }),
    );
    const report = evaluateEvidenceMemoryDogfoodCohort(observations, {}, now);

    expect(report.sampleCount).toBe(100);
    expect(report.distinctTaskCount).toBe(3);
    expect(report.categoryCoverage).toMatchObject({
      exact_fact: 45,
      user_constraint: 20,
      staleness: 15,
      supersession: 10,
      restart: 10,
    });
    expect(report.promotionReady).toBe(true);

    const stale = evaluateEvidenceMemoryDogfoodCohort(
      observations.map((observation) => ({
        ...observation,
        observedAt: 0,
      })),
      {},
      now,
    );
    expect(stale.sampleCount).toBe(0);
    expect(stale.staleObservationCount).toBe(100);
    expect(stale.promotionReady).toBe(false);
  });
});

function dogfoodObservation(
  overrides: Partial<EvidenceMemoryDogfoodObservation> = {},
): EvidenceMemoryDogfoodObservation {
  return {
    observationVersion: EVIDENCE_MEMORY_DOGFOOD_OBSERVATION_VERSION,
    scenarioIdHash: 'a'.repeat(64),
    category: 'exact_fact',
    expectedClaimCount: 10,
    compressedHistoryRecoveredCount: 8,
    guardedMemoryRecoveredCount: 10,
    forbiddenClaimCount: 1,
    compressedHistoryLeakedCount: 1,
    guardedMemoryLeakedCount: 0,
    compressedHistoryTokens: 100,
    guardedMemoryTokens: 110,
    compressedHistoryLatencyMs: 10,
    guardedMemoryLatencyMs: 25,
    ...overrides,
  };
}
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
