import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AeadDataProtection,
  ProtectedAppendFileStorage,
  ProtectedFileStorage,
} from '@clodex/agent-core/host';
import type { RunnerRoutingDecision } from '@clodex/agent-core/runner-routing';
import {
  P256RunnerSigningAuthority,
  hashRunnerExecutionStageTimings,
} from '@clodex/agent-shell';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/services/logger';
import { signRunnerDogfoodEvidenceBundle } from './dogfood-evidence';
import { RunnerRoutingShadowLedger } from './shadow-ledger';

const TEST_EXECUTION_TIMINGS = {
  version: 1 as const,
  sshRoundTrips: 5,
  artifactBeforeRoundTrips: 2,
  dispatchRoundTrips: 1,
  pollingRoundTrips: 0,
  artifactAfterRoundTrips: 2,
  artifactBeforeDurationMs: 12,
  dispatchDurationMs: 8,
  commandDurationMs: 5,
  pollingDurationMs: 0,
  artifactAfterDurationMs: 10,
  receiptFinalizationDurationMs: 2,
};

describe('RunnerRoutingShadowLedger', () => {
  let root: string;
  let filePath: string;
  let protectedFiles: ProtectedFileStorage;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-routing-'));
    filePath = path.join(root, 'shadow.jsonl');
    protectedFiles = new ProtectedFileStorage(
      new AeadDataProtection(randomBytes(32)),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('stores immutable linked decision and observation events without content', async () => {
    const ledger = new RunnerRoutingShadowLedger(
      protectedFiles,
      filePath,
      {} as Logger,
      () => 42,
      () => '00000000-0000-4000-8000-000000000001',
    );
    const decisionId = await ledger.recordDecision(decisionInput());
    await ledger.recordObservation({
      decisionId,
      taskId: '/private/task-a',
      commandClassHash: 'b'.repeat(64),
      providerId: 'local-runner',
      observation: {
        providerKind: 'local',
        environmentFingerprintHash: 'c'.repeat(64),
        outcome: 'completed',
        durationMs: 120,
        timedOut: false,
        exitCodeClass: 'zero',
      },
    });

    const storage = new ProtectedAppendFileStorage(
      protectedFiles,
      filePath,
      'runner-routing/shadow-ledger/v1',
    );
    const records = (await storage.readFile())
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0].event.type).toBe('runner_shadow_route_decided');
    expect(records[1]).toMatchObject({
      sequence: 2,
      previousHash: records[0].eventHash,
      event: {
        type: 'runner_shadow_route_observed',
        decisionId,
      },
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('/private/task-a');
    expect(serialized).not.toContain('local-runner');
    expect(serialized).not.toContain('pnpm test');
  });

  it('restores a verified bounded observation index after restart', async () => {
    const first = new RunnerRoutingShadowLedger(
      protectedFiles,
      filePath,
      {} as Logger,
      () => 42,
      () => '00000000-0000-4000-8000-000000000001',
      1,
    );
    const decisionId = await first.recordDecision(decisionInput());
    for (const durationMs of [10, 20]) {
      await first.recordObservation({
        decisionId,
        taskId: 'task-a',
        commandClassHash: 'b'.repeat(64),
        providerId: 'local-runner',
        observation: {
          providerKind: 'local',
          environmentFingerprintHash: 'c'.repeat(64),
          outcome: 'completed',
          durationMs,
          timedOut: false,
          exitCodeClass: 'zero',
        },
      });
    }
    const restarted = new RunnerRoutingShadowLedger(
      protectedFiles,
      filePath,
      {} as Logger,
      Date.now,
      randomUUID,
      1,
    );

    await expect(
      restarted.listRecentObservations(
        'b'.repeat(64),
        new Map([['local-runner', 'local']]),
      ),
    ).resolves.toEqual([
      expect.objectContaining({ providerId: 'local-runner', durationMs: 20 }),
    ]);
  });

  it('restores legacy protected decisions that predate replay profiles', async () => {
    const storage = new ProtectedAppendFileStorage(
      protectedFiles,
      filePath,
      'runner-routing/shadow-ledger/v1',
    );
    const decisionId = '00000000-0000-4000-8000-000000000001';
    const event = {
      type: 'runner_shadow_route_decided',
      decisionId,
      createdAt: 42,
      taskScopeHash: hashText('/private/task-a'),
      commandClassHash: 'b'.repeat(64),
      operation: 'execute-command',
      snapshotHash: 'a'.repeat(64),
      repositoryRevisionHash: hashText('revision-secret'),
      dirtyPatchHash: 'd'.repeat(64),
      environmentFingerprintHash: 'c'.repeat(64),
      actualProviderIdHash: hashText('local-runner'),
      actualProviderKind: 'local',
      recommendedProviderIdHash: hashText('local-runner'),
      recommendedProviderKind: 'local',
      confidence: 0,
      evidenceSampleCount: 0,
      reasonCodes: ['insufficient-evidence'],
      ranked: [],
      excluded: [],
      policyHash: 'e'.repeat(64),
    };
    const withoutHash = {
      schemaVersion: 1,
      sequence: 1,
      previousHash: 'GENESIS',
      event,
    };
    await storage.append(
      `${JSON.stringify({
        ...withoutHash,
        eventHash: hashRecord(withoutHash),
      })}\n`,
    );

    const restarted = new RunnerRoutingShadowLedger(
      protectedFiles,
      filePath,
      {} as Logger,
      () => 43,
      randomUUID,
    );
    await restarted.recordObservation({
      decisionId,
      taskId: '/private/task-a',
      commandClassHash: 'b'.repeat(64),
      providerId: 'local-runner',
      observation: {
        providerKind: 'local',
        environmentFingerprintHash: 'c'.repeat(64),
        outcome: 'completed',
        durationMs: 20,
        timedOut: false,
        exitCodeClass: 'zero',
      },
    });

    await expect(
      restarted.listEvaluationSamples({ taskId: '/private/task-a' }),
    ).resolves.toEqual([
      expect.objectContaining({
        decisionId,
        replayProfile: null,
      }),
    ]);
  });

  it('records automatic promotion in the protected hash chain', async () => {
    const ledger = new RunnerRoutingShadowLedger(
      protectedFiles,
      filePath,
      {} as Logger,
      () => 42,
      () => '00000000-0000-4000-8000-000000000001',
    );
    const decisionId = await ledger.recordDecision(decisionInput());
    await ledger.recordAutomaticSelection({
      decisionId,
      taskId: '/private/task-a',
      configuredProviderId: 'local-runner',
      configuredProviderKind: 'local',
      replayProfile: 'ssh-read-only',
      promotion: {
        version: 1,
        mode: 'automatic',
        selectedProviderId: 'ssh-runner:dev',
        selectedProviderKind: 'ssh',
        promoted: true,
        confidence: 0.9,
        providerEvidenceSamples: 12,
        successRate: 1,
        timeoutRate: 0,
        scoreAdvantage: 0.4,
        reasonCodes: ['promotion-approved'],
        policyHash: 'f'.repeat(64),
      },
    });

    const storage = new ProtectedAppendFileStorage(
      protectedFiles,
      filePath,
      'runner-routing/shadow-ledger/v1',
    );
    const records = (await storage.readFile())
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records[1]).toMatchObject({
      sequence: 2,
      previousHash: records[0].eventHash,
      event: {
        type: 'runner_automatic_route_selected',
        decisionId,
        selectedProviderKind: 'ssh',
        fallbackPolicy: 'configured-provider-before-dispatch-only',
      },
    });
    expect(JSON.stringify(records)).not.toContain('/private/task-a');
    expect(JSON.stringify(records)).not.toContain('ssh-runner:dev');
  });

  it('aggregates content-free dogfood admission and concurrency metrics', async () => {
    const ledger = new RunnerRoutingShadowLedger(
      protectedFiles,
      filePath,
      {} as Logger,
      () => 42,
      () => '00000000-0000-4000-8000-000000000001',
    );
    const decisionId = await ledger.recordDecision(
      decisionInput({
        recommendedProviderId: 'docker-runner',
        recommendedProviderKind: 'docker',
      }),
    );
    await ledger.recordPairedReplayAdmission({
      decisionId,
      taskId: '/private/task-a',
      commandClassHash: 'b'.repeat(64),
      snapshotHash: 'a'.repeat(64),
      actualProviderKind: 'local',
      targetProviderId: 'docker-runner',
      targetProviderKind: 'docker',
      riskClass: 'workspace-contained',
      admitted: false,
      scheduleOutcome: 'not-sampled',
      sampleBucket: 0.8,
      sampleRate: 0.1,
      reasonCodes: ['sample-not-selected'],
      policyHash: '4'.repeat(64),
      replayProfile: 'docker-isolated',
    });
    await ledger.recordPairedReplayAdmission({
      decisionId,
      taskId: '/private/task-a',
      commandClassHash: 'b'.repeat(64),
      snapshotHash: 'a'.repeat(64),
      actualProviderKind: 'local',
      targetProviderId: 'docker-runner',
      targetProviderKind: 'docker',
      riskClass: 'workspace-contained',
      admitted: true,
      scheduleOutcome: 'concurrency-limited',
      sampleBucket: 0.05,
      sampleRate: 0.1,
      reasonCodes: ['admitted'],
      policyHash: '4'.repeat(64),
      replayProfile: 'docker-isolated',
    });

    await expect(
      ledger.evaluatePairedReplayDogfood({ taskId: '/private/task-a' }),
    ).resolves.toMatchObject({
      candidateCount: 2,
      policyAdmittedCount: 1,
      scheduledCount: 0,
      concurrencyLimitedCount: 1,
      completedCount: 0,
      rejectionReasonCounts: {
        'sample-not-selected': 1,
        admitted: 1,
        'concurrency-limited': 1,
      },
      providerCounts: { docker: 2 },
      profileCounts: { 'docker-isolated': 2 },
      riskClassCounts: { 'workspace-contained': 2 },
    });
  });

  it('fails closed when the hash chain is corrupted', async () => {
    const ledger = new RunnerRoutingShadowLedger(
      protectedFiles,
      filePath,
      {} as Logger,
    );
    await ledger.recordDecision(decisionInput());
    const storage = new ProtectedAppendFileStorage(
      protectedFiles,
      filePath,
      'runner-routing/shadow-ledger/v1',
    );
    await storage.append('{"broken":true}\n');
    const logger = { error: vi.fn() } as unknown as Logger;
    const restarted = new RunnerRoutingShadowLedger(
      protectedFiles,
      filePath,
      logger,
    );

    await expect(
      restarted.listRecentObservations(
        'b'.repeat(64),
        new Map([['local-runner', 'local']]),
      ),
    ).rejects.toThrow('integrity check failed');
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('records verified disposable local replay as a counterfactual provider', async () => {
    const ledger = new RunnerRoutingShadowLedger(
      protectedFiles,
      filePath,
      {} as Logger,
      () => 42,
      () => '00000000-0000-4000-8000-000000000001',
    );
    const decisionId = await ledger.recordDecision(
      decisionInput({
        actualProviderId: 'ssh-runner',
        actualProviderKind: 'ssh',
        recommendedProviderId: 'local-runner',
        recommendedProviderKind: 'local',
      }),
    );
    await ledger.recordPairedReplayAdmission({
      decisionId,
      taskId: '/private/task-a',
      commandClassHash: 'b'.repeat(64),
      snapshotHash: 'a'.repeat(64),
      actualProviderKind: 'ssh',
      targetProviderId: 'local-runner',
      targetProviderKind: 'local',
      riskClass: 'read-only',
      admitted: true,
      scheduleOutcome: 'scheduled',
      sampleBucket: 0.01,
      sampleRate: 0.1,
      reasonCodes: ['admitted'],
      policyHash: '4'.repeat(64),
      replayProfile: 'local-read-only',
    });
    await ledger.recordPairedReplay({
      decisionId,
      taskId: '/private/task-a',
      commandClassHash: 'b'.repeat(64),
      providerId: 'local-runner',
      providerKind: 'local',
      snapshotHash: 'a'.repeat(64),
      environmentFingerprintHash: 'c'.repeat(64),
      outcome: 'completed',
      durationMs: 25,
      preparationDurationMs: 10,
      totalDurationMs: 35,
      timedOut: false,
      exitCodeClass: 'zero',
      receiptHash: '1'.repeat(64),
      jobHash: '2'.repeat(64),
      outputHash: '3'.repeat(64),
      artifactManifestHash: null,
      executionTimingHash: hashRunnerExecutionStageTimings(
        TEST_EXECUTION_TIMINGS,
      ),
      executionTimings: TEST_EXECUTION_TIMINGS,
      riskClass: 'read-only',
      sampleBucket: 0.01,
      policyHash: '4'.repeat(64),
      replayProfile: 'local-read-only',
    });

    await expect(
      ledger.evaluatePairedReplayDogfood({ taskId: '/private/task-a' }),
    ).resolves.toMatchObject({
      candidateCount: 1,
      completedCount: 1,
      providerCounts: { local: 1 },
      averagePreparationDurationMs: 10,
      averageTotalDurationMs: 35,
      profileCounts: { 'local-read-only': 1 },
      profileMetrics: [
        expect.objectContaining({
          profile: 'local-read-only',
          candidateCount: 1,
          completedCount: 1,
          replaySuccessRate: 1,
          replayFailureRate: 0,
          replayTimeoutRate: 0,
          averagePreparationDurationMs: 10,
          averageTotalDurationMs: 35,
          averageSshRoundTrips: 5,
          averageCommandDurationMs: 5,
          averageReceiptFinalizationDurationMs: 2,
        }),
      ],
    });
  });

  it('builds an honest evaluation report with historical matches separated from verified replay', async () => {
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ];
    const ledger = new RunnerRoutingShadowLedger(
      protectedFiles,
      filePath,
      {} as Logger,
      (() => {
        let value = 10;
        return () => value++;
      })(),
      () => ids.shift()!,
    );
    const localDecisionId = await ledger.recordDecision(
      decisionInput({
        recommendedProviderId: 'ssh-runner',
        recommendedProviderKind: 'ssh',
        ranked: [
          ranked('local-runner', 'local', 60_000),
          ranked('ssh-runner', 'ssh', 8_000),
        ],
      }),
    );
    await ledger.recordObservation({
      decisionId: localDecisionId,
      taskId: '/private/task-a',
      commandClassHash: 'b'.repeat(64),
      providerId: 'local-runner',
      observation: {
        providerKind: 'local',
        environmentFingerprintHash: 'c'.repeat(64),
        outcome: 'failed',
        durationMs: 60_000,
        timedOut: true,
        exitCodeClass: 'non-zero',
      },
    });
    const sshDecisionId = await ledger.recordDecision(
      decisionInput({
        actualProviderId: 'ssh-runner',
        actualProviderKind: 'ssh',
        recommendedProviderId: 'ssh-runner',
        recommendedProviderKind: 'ssh',
        ranked: [ranked('ssh-runner', 'ssh', 8_000)],
      }),
    );
    await ledger.recordObservation({
      decisionId: sshDecisionId,
      taskId: '/private/task-a',
      commandClassHash: 'b'.repeat(64),
      providerId: 'ssh-runner',
      observation: {
        providerKind: 'ssh',
        environmentFingerprintHash: 'c'.repeat(64),
        outcome: 'completed',
        durationMs: 8_000,
        timedOut: false,
        exitCodeClass: 'zero',
      },
    });

    const samples = await ledger.listEvaluationSamples({
      taskId: '/private/task-a',
    });
    const report = await ledger.evaluate({
      taskId: '/private/task-a',
      thresholds: {
        minimumObservedSamples: 1,
        minimumDivergentSamples: 1,
        minimumVerifiedCounterfactualSamples: 1,
      },
    });

    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      decisionId: localDecisionId,
      estimatedActualDurationMs: 60_000,
      estimatedRecommendedDurationMs: 8_000,
      counterfactualRecommended: {
        source: 'matched-command-history',
        outcome: 'completed',
        durationMs: 8_000,
      },
    });
    expect(JSON.stringify(samples)).not.toContain('local-runner');
    expect(report.historicalCounterfactualSampleCount).toBe(1);
    expect(report.verifiedCounterfactualSampleCount).toBe(0);
    expect(report.failureAvoidanceSignalCount).toBe(1);
    expect(report.promotionReady).toBe(false);
    expect(report.promotionBlockers).toContain(
      'insufficient-verified-counterfactuals',
    );

    await ledger.recordPairedReplayAdmission({
      decisionId: localDecisionId,
      taskId: '/private/task-a',
      commandClassHash: 'b'.repeat(64),
      snapshotHash: 'a'.repeat(64),
      actualProviderKind: 'local',
      targetProviderId: 'ssh-runner',
      targetProviderKind: 'ssh',
      riskClass: 'read-only',
      admitted: true,
      scheduleOutcome: 'scheduled',
      sampleBucket: 0.05,
      sampleRate: 0.1,
      reasonCodes: ['admitted'],
      policyHash: '4'.repeat(64),
      replayProfile: 'ssh-read-only',
    });
    await ledger.recordPairedReplay({
      decisionId: localDecisionId,
      taskId: '/private/task-a',
      commandClassHash: 'b'.repeat(64),
      providerId: 'ssh-runner',
      providerKind: 'ssh',
      snapshotHash: 'a'.repeat(64),
      environmentFingerprintHash: 'c'.repeat(64),
      outcome: 'completed',
      durationMs: 7_000,
      timedOut: false,
      exitCodeClass: 'zero',
      receiptHash: '1'.repeat(64),
      jobHash: '2'.repeat(64),
      outputHash: '3'.repeat(64),
      artifactManifestHash: null,
      riskClass: 'read-only',
      sampleBucket: 0.05,
      policyHash: '4'.repeat(64),
      replayProfile: 'ssh-read-only',
    });
    const verifiedSamples = await ledger.listEvaluationSamples({
      taskId: '/private/task-a',
    });
    const verifiedReport = await ledger.evaluate({
      taskId: '/private/task-a',
      thresholds: {
        minimumObservedSamples: 1,
        minimumDivergentSamples: 1,
        minimumVerifiedCounterfactualSamples: 1,
        minimumVerifiedFailureSignals: 1,
        minimumVerifiedTimeoutSignals: 1,
        minimumVerifiedLatencyPairs: 1,
      },
    });
    const dogfoodReport = await ledger.evaluatePairedReplayDogfood({
      taskId: '/private/task-a',
    });

    expect(verifiedSamples[0]?.counterfactualRecommended).toMatchObject({
      source: 'paired-replay',
      durationMs: 7_000,
      providerKind: 'ssh',
    });
    expect(verifiedReport.historicalCounterfactualSampleCount).toBe(0);
    expect(verifiedReport.verifiedCounterfactualSampleCount).toBe(1);
    expect(verifiedReport.failureAvoidancePrecision).toBe(1);
    expect(verifiedReport.timeoutAvoidancePrecision).toBe(1);
    expect(verifiedReport.promotionBlockers).not.toContain(
      'insufficient-verified-counterfactuals',
    );
    await expect(
      ledger.evaluate({
        taskId: '/private/task-a',
        replayProfile: 'ssh-read-only',
        thresholds: {
          minimumObservedSamples: 1,
          minimumDivergentSamples: 1,
          minimumVerifiedCounterfactualSamples: 1,
          minimumVerifiedFailureSignals: 1,
          minimumVerifiedTimeoutSignals: 1,
          minimumVerifiedLatencyPairs: 1,
        },
      }),
    ).resolves.toMatchObject({
      evaluatedProfile: 'ssh-read-only',
      sampleCount: 2,
      verifiedCounterfactualSampleCount: 1,
      profileMetrics: [
        expect.objectContaining({
          profile: 'ssh-read-only',
          replaySuccessRate: 1,
          replayTimeoutRate: 0,
        }),
      ],
    });
    expect(dogfoodReport).toMatchObject({
      candidateCount: 1,
      policyAdmittedCount: 1,
      scheduledCount: 1,
      completedCount: 1,
      completionCoverage: 1,
      replaySuccessRate: 1,
      replayTimeoutRate: 0,
      providerCounts: { ssh: 1 },
      riskClassCounts: { 'read-only': 1 },
    });

    const storage = new ProtectedAppendFileStorage(
      protectedFiles,
      filePath,
      'runner-routing/shadow-ledger/v1',
    );
    const serialized = (await storage.readFile()).toString('utf8');
    expect(serialized).not.toContain('/private/task-a');
    expect(serialized).not.toContain('ssh-runner');
    expect(serialized).not.toContain('pnpm test');
  });

  it('keeps promotion evidence isolated between dependency and transport profiles', async () => {
    let id = 0;
    const ledger = new RunnerRoutingShadowLedger(
      protectedFiles,
      filePath,
      {} as Logger,
      (() => {
        let value = 10;
        return () => value++;
      })(),
      () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    );

    await recordVerifiedReplaySample(ledger, {
      profile: 'node-copy-on-write',
      suffix: '1',
      actualOutcome: 'failed',
      actualDurationMs: 60_000,
      actualTimedOut: true,
      replayDurationMs: 8_000,
    });
    await recordVerifiedReplaySample(ledger, {
      profile: 'node-copy-on-write',
      suffix: '2',
      actualOutcome: 'completed',
      actualDurationMs: 30_000,
      actualTimedOut: false,
      replayDurationMs: 10_000,
    });
    await recordVerifiedReplaySample(ledger, {
      profile: 'cargo-cache',
      suffix: '3',
      actualOutcome: 'completed',
      actualDurationMs: 20_000,
      actualTimedOut: false,
      replayDurationMs: 12_000,
    });

    const thresholds = {
      minimumObservedSamples: 2,
      minimumDivergentSamples: 2,
      minimumVerifiedCounterfactualSamples: 2,
      minimumVerifiedFailureSignals: 1,
      minimumVerifiedTimeoutSignals: 1,
      minimumVerifiedLatencyPairs: 1,
      minimumRecommendationWinRate: 0.5,
      minimumFailureAvoidancePrecision: 1,
      minimumTimeoutAvoidancePrecision: 1,
      maximumHarmfulRecommendationRate: 0,
      maximumActualDurationPredictionMaeMs: 100_000,
    };

    await expect(
      ledger.evaluate({
        taskId: '/private/task-a',
        replayProfile: 'node-copy-on-write',
        thresholds,
      }),
    ).resolves.toMatchObject({
      evaluatedProfile: 'node-copy-on-write',
      sampleCount: 2,
      verifiedCounterfactualSampleCount: 2,
      promotionReady: true,
      promotionBlockers: [],
    });
    await expect(
      ledger.evaluate({
        taskId: '/private/task-a',
        replayProfile: 'cargo-cache',
        thresholds,
      }),
    ).resolves.toMatchObject({
      evaluatedProfile: 'cargo-cache',
      sampleCount: 1,
      verifiedCounterfactualSampleCount: 1,
      promotionReady: false,
      promotionBlockers: expect.arrayContaining([
        'insufficient-observed-samples',
        'insufficient-verified-counterfactuals',
        'insufficient-verified-failure-signals',
        'insufficient-verified-timeout-signals',
      ]),
    });
  });

  it('ingests trusted dogfood once and reports exact profile promotion progress', async () => {
    const ledger = new RunnerRoutingShadowLedger(
      protectedFiles,
      filePath,
      {} as Logger,
    );
    const collector = P256RunnerSigningAuthority.generate();
    const bundle = signRunnerDogfoodEvidenceBundle(
      {
        schemaVersion: 2,
        bundleId: '00000000-0000-4000-8000-000000000010',
        collectedAt: 42,
        sourceCommitSha: '9'.repeat(40),
        samples: [
          {
            sampleId: '00000000-0000-4000-8000-000000000011',
            profile: 'ssh-read-only',
            commandClassHash: 'a'.repeat(64),
            snapshotHash: 'b'.repeat(64),
            actual: dogfoodExecution('local-dogfood', 'local', 30_000),
            replay: {
              ...dogfoodExecution('ssh-dogfood', 'ssh', 8_000),
              preparationDurationMs: 2_500,
              totalDurationMs: 17_000,
            },
          },
          {
            sampleId: '00000000-0000-4000-8000-000000000012',
            profile: 'ssh-read-only',
            commandClassHash: 'a'.repeat(64),
            snapshotHash: 'b'.repeat(64),
            scenario: 'controlled-local-timeout',
            promotionEligible: false,
            actual: {
              ...dogfoodExecution('local-dogfood', 'local', 1),
              outcome: 'failed',
              timedOut: true,
              exitCodeClass: 'missing',
            },
            replay: {
              ...dogfoodExecution('ssh-dogfood', 'ssh', 8_000),
              preparationDurationMs: 2_500,
              totalDurationMs: 17_000,
            },
          },
        ],
      },
      collector,
    );

    await expect(
      ledger.ingestDogfoodEvidence(bundle, [collector.publicKey]),
    ).resolves.toEqual({
      bundleId: bundle.bundleId,
      importedSamples: 2,
      duplicateSamples: 0,
      profiles: ['ssh-read-only'],
    });
    await expect(
      ledger.ingestDogfoodEvidence(bundle, [collector.publicKey]),
    ).resolves.toEqual({
      bundleId: bundle.bundleId,
      importedSamples: 0,
      duplicateSamples: 2,
      profiles: ['ssh-read-only'],
    });

    const thresholds = {
      minimumObservedSamples: 2,
      minimumDivergentSamples: 2,
      minimumVerifiedCounterfactualSamples: 2,
      minimumVerifiedFailureSignals: 1,
      minimumVerifiedTimeoutSignals: 1,
      minimumVerifiedLatencyPairs: 1,
    };
    await expect(
      ledger.evaluatePromotionProgress({
        taskId: '/private/unrelated-task',
        replayProfile: 'ssh-read-only',
        thresholds,
      }),
    ).resolves.toMatchObject({
      profile: 'ssh-read-only',
      promotionReady: false,
      counts: {
        observedSamples: { current: 1, required: 2, remaining: 1 },
        divergentSamples: { current: 1, required: 2, remaining: 1 },
        verifiedCounterfactuals: { current: 1, required: 2, remaining: 1 },
        verifiedFailureSignals: { current: 0, required: 1, remaining: 1 },
        verifiedTimeoutSignals: { current: 0, required: 1, remaining: 1 },
        verifiedLatencyPairs: { current: 1, required: 1, remaining: 0 },
      },
    });
    await expect(
      ledger.evaluateDogfoodDiagnostics({
        replayProfile: 'ssh-read-only',
      }),
    ).resolves.toMatchObject({
      sampleCount: 2,
      promotionEligibleCount: 1,
      controlledSampleCount: 1,
      scenarioMetrics: expect.arrayContaining([
        expect.objectContaining({
          scenario: 'organic-read-only',
          sampleCount: 1,
          harmfulRecommendationRate: 0,
        }),
        expect.objectContaining({
          scenario: 'controlled-local-timeout',
          sampleCount: 1,
          promotionEligibleCount: 0,
          actualFailureRate: 1,
          actualTimeoutRate: 1,
          recommendationWinRate: 1,
        }),
      ]),
    });

    const storage = new ProtectedAppendFileStorage(
      protectedFiles,
      filePath,
      'runner-routing/shadow-ledger/v1',
    );
    const serialized = (await storage.readFile()).toString('utf8');
    expect(serialized).not.toContain('local-dogfood');
    expect(serialized).not.toContain('ssh-dogfood');
    expect(serialized).not.toContain('/private/unrelated-task');
  });

  it('reports cold/warm persistent SSH workspace cache evidence', async () => {
    const ledger = new RunnerRoutingShadowLedger(
      protectedFiles,
      filePath,
      {} as Logger,
    );
    const collector = P256RunnerSigningAuthority.generate();
    const bundle = signRunnerDogfoodEvidenceBundle(
      {
        schemaVersion: 2,
        bundleId: '00000000-0000-4000-8000-000000000020',
        collectedAt: 43,
        sourceCommitSha: '9'.repeat(40),
        samples: [
          {
            sampleId: '00000000-0000-4000-8000-000000000021',
            profile: 'ssh-node-cache',
            scenario: 'organic-heavyweight',
            promotionEligible: true,
            commandClassHash: 'c'.repeat(64),
            snapshotHash: 'd'.repeat(64),
            actual: dogfoodExecution('local-node', 'local', 10_000),
            replay: {
              ...dogfoodExecution('ssh-node', 'ssh', 8_000),
              preparationDurationMs: 2_000,
              totalDurationMs: 12_000,
              workspaceCacheStatus: 'warm',
              workspaceReuseCount: 3,
              transferBytes: 0,
              transferBytesAvoided: 4_096,
              executionTimingHash: hashRunnerExecutionStageTimings(
                TEST_EXECUTION_TIMINGS,
              ),
              executionTimings: TEST_EXECUTION_TIMINGS,
            },
          },
        ],
      },
      collector,
    );

    await ledger.ingestDogfoodEvidence(bundle, [collector.publicKey]);

    await expect(
      ledger.evaluateDogfoodDiagnostics({ replayProfile: 'ssh-node-cache' }),
    ).resolves.toMatchObject({
      sampleCount: 1,
      promotionEligibleCount: 1,
      scenarioMetrics: [
        expect.objectContaining({
          scenario: 'organic-heavyweight',
          warmCacheRate: 1,
          coldCacheRate: 0,
          workspaceReuseAverage: 3,
          transferBytesAverage: 0,
          transferBytesAvoidedAverage: 4_096,
          replaySshRoundTripsAverage: 5,
          replayCommandAverageMs: 5,
          replayReceiptFinalizationAverageMs: 2,
        }),
      ],
    });
  });
});

async function recordVerifiedReplaySample(
  ledger: RunnerRoutingShadowLedger,
  input: {
    profile: 'node-copy-on-write' | 'cargo-cache';
    suffix: string;
    actualOutcome: 'completed' | 'failed';
    actualDurationMs: number;
    actualTimedOut: boolean;
    replayDurationMs: number;
  },
) {
  const commandClassHash = input.suffix.repeat(64);
  const decisionId = await ledger.recordDecision({
    ...decisionInput({
      actualProviderId: 'ssh-runner',
      actualProviderKind: 'ssh',
      recommendedProviderId: 'local-runner',
      recommendedProviderKind: 'local',
      ranked: [
        ranked('ssh-runner', 'ssh', input.actualDurationMs),
        ranked('local-runner', 'local', input.replayDurationMs),
      ],
    }),
    commandClassHash,
    replayProfile: input.profile,
  });
  await ledger.recordObservation({
    decisionId,
    taskId: '/private/task-a',
    commandClassHash,
    providerId: 'ssh-runner',
    observation: {
      providerKind: 'ssh',
      environmentFingerprintHash: 'c'.repeat(64),
      outcome: input.actualOutcome,
      durationMs: input.actualDurationMs,
      timedOut: input.actualTimedOut,
      exitCodeClass: input.actualOutcome === 'completed' ? 'zero' : 'non-zero',
    },
  });
  await ledger.recordPairedReplayAdmission({
    decisionId,
    taskId: '/private/task-a',
    commandClassHash,
    snapshotHash: 'a'.repeat(64),
    actualProviderKind: 'ssh',
    targetProviderId: 'local-runner',
    targetProviderKind: 'local',
    riskClass: 'workspace-contained',
    admitted: true,
    scheduleOutcome: 'scheduled',
    sampleBucket: 0.01,
    sampleRate: 1,
    reasonCodes: ['admitted'],
    policyHash: '4'.repeat(64),
    replayProfile: input.profile,
  });
  await ledger.recordPairedReplay({
    decisionId,
    taskId: '/private/task-a',
    commandClassHash,
    providerId: 'local-runner',
    providerKind: 'local',
    snapshotHash: 'a'.repeat(64),
    environmentFingerprintHash: 'c'.repeat(64),
    outcome: 'completed',
    durationMs: input.replayDurationMs,
    preparationDurationMs: 2_000,
    totalDurationMs: input.replayDurationMs + 2_000,
    timedOut: false,
    exitCodeClass: 'zero',
    receiptHash: input.suffix.repeat(64),
    jobHash: '2'.repeat(64),
    outputHash: '3'.repeat(64),
    artifactManifestHash: null,
    riskClass: 'workspace-contained',
    sampleBucket: 0.01,
    policyHash: '4'.repeat(64),
    replayProfile: input.profile,
  });
}

function decisionInput(overrides: Partial<RunnerRoutingDecision> = {}) {
  const decision = {
    version: 1,
    mode: 'shadow',
    actualProviderId: 'local-runner',
    actualProviderKind: 'local',
    recommendedProviderId: 'local-runner',
    recommendedProviderKind: 'local',
    confidence: 0,
    evidenceSampleCount: 0,
    reasonCodes: ['insufficient-evidence'],
    ranked: [],
    excluded: [],
    policyHash: 'e'.repeat(64),
    ...overrides,
  } satisfies RunnerRoutingDecision;
  return {
    taskId: '/private/task-a',
    commandClassHash: 'b'.repeat(64),
    operation: 'execute-command' as const,
    snapshotHash: 'a'.repeat(64),
    repositoryRevision: 'revision-secret',
    dirtyPatchHash: 'd'.repeat(64),
    environmentFingerprintHash: 'c'.repeat(64),
    replayProfile:
      decision.recommendedProviderKind === 'ssh'
        ? ('ssh-read-only' as const)
        : decision.recommendedProviderKind === 'docker'
          ? ('docker-isolated' as const)
          : ('local-read-only' as const),
    decision,
  };
}

function ranked(
  providerId: string,
  providerKind: RunnerRoutingDecision['actualProviderKind'],
  estimatedDurationMs: number,
) {
  return {
    providerId,
    providerKind,
    score: 0.8,
    observationCount: 3,
    estimatedDurationMs,
    reasonCodes: ['observed-success' as const],
  };
}

function dogfoodExecution(
  providerId: string,
  providerKind: 'local' | 'ssh',
  durationMs: number,
) {
  return {
    providerId,
    providerKind,
    environmentFingerprintHash: 'c'.repeat(64),
    outcome: 'completed' as const,
    durationMs,
    timedOut: false,
    exitCodeClass: 'zero' as const,
    receiptHash: providerKind === 'local' ? 'd'.repeat(64) : 'e'.repeat(64),
    jobHash: providerKind === 'local' ? 'f'.repeat(64) : '1'.repeat(64),
    outputHash: '2'.repeat(64),
    artifactManifestHash: null,
  };
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashRecord(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
