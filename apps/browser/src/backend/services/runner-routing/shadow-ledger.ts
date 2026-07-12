import { createHash, randomUUID } from 'node:crypto';
import {
  ProtectedAppendFileStorage,
  type ProtectedFileStorage,
} from '@clodex/agent-core/host';
import {
  createRunnerRoutingPromotionProgress,
  evaluateRunnerRouting,
  runnerPairedReplayReasonCodes,
  runnerPairedReplayProfiles,
  runnerRoutingProviderKinds,
  runnerRoutingPromotionReasonCodes,
  runnerRoutingReasonCodes,
  type RunnerRoutingDecision,
  type RunnerRoutingEvaluationReport,
  type RunnerRoutingEvaluationSample,
  type RunnerRoutingEvaluationThresholds,
  type RunnerRoutingObservation,
  type RunnerPairedReplayProfile,
  type RunnerRoutingPromotionEvaluation,
  type RunnerRoutingPromotionProgress,
} from '@clodex/agent-core/runner-routing';
import type { RunnerExecutionStageTimings } from '@clodex/agent-shell';
import { z } from 'zod';
import type { Logger } from '@/services/logger';
import {
  getRunnerDogfoodEvidenceScenario,
  isRunnerDogfoodEvidencePromotionEligible,
  verifyRunnerDogfoodEvidenceBundle,
  type RunnerDogfoodEvidenceBundle,
  type RunnerDogfoodEvidenceScenario,
} from './dogfood-evidence';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const providerKindSchema = z.enum(runnerRoutingProviderKinds);
const reasonCodeSchema = z.enum(runnerRoutingReasonCodes);
const promotionReasonCodeSchema = z.enum(runnerRoutingPromotionReasonCodes);
const pairedReplayReasonCodeSchema = z.enum(runnerPairedReplayReasonCodes);
const pairedReplayProfileSchema = z.enum(runnerPairedReplayProfiles);
const executionTimingsSchema = z
  .object({
    version: z.literal(1),
    sshRoundTrips: z.number().int().nonnegative(),
    artifactBeforeRoundTrips: z.number().int().nonnegative(),
    dispatchRoundTrips: z.number().int().nonnegative(),
    pollingRoundTrips: z.number().int().nonnegative(),
    artifactAfterRoundTrips: z.number().int().nonnegative(),
    artifactBeforeDurationMs: z.number().int().nonnegative(),
    dispatchDurationMs: z.number().int().nonnegative(),
    commandDurationMs: z.number().int().nonnegative().nullable(),
    pollingDurationMs: z.number().int().nonnegative(),
    artifactAfterDurationMs: z.number().int().nonnegative(),
    receiptFinalizationDurationMs: z.number().int().nonnegative(),
  })
  .strict();
const rankedCandidateSchema = z
  .object({
    providerId: z.string().min(1).max(2_048),
    providerKind: providerKindSchema,
    score: z.number().finite(),
    observationCount: z.number().int().nonnegative(),
    estimatedDurationMs: z.number().int().nonnegative().nullable(),
    reasonCodes: z.array(reasonCodeSchema).max(16),
  })
  .strict();
const excludedCandidateSchema = z
  .object({
    providerId: z.string().min(1).max(2_048),
    providerKind: providerKindSchema,
    reasonCodes: z.array(reasonCodeSchema).min(1).max(16),
  })
  .strict();
const decisionEventSchema = z
  .object({
    type: z.literal('runner_shadow_route_decided'),
    decisionId: z.string().uuid(),
    createdAt: z.number().int().nonnegative(),
    taskScopeHash: sha256Schema,
    commandClassHash: sha256Schema.nullable(),
    operation: z.enum(['create-session', 'execute-command', 'kill-session']),
    snapshotHash: sha256Schema,
    repositoryRevisionHash: sha256Schema.nullable(),
    dirtyPatchHash: sha256Schema.nullable(),
    environmentFingerprintHash: sha256Schema,
    actualProviderIdHash: sha256Schema,
    actualProviderKind: providerKindSchema,
    recommendedProviderIdHash: sha256Schema,
    recommendedProviderKind: providerKindSchema,
    confidence: z.number().min(0).max(1),
    evidenceSampleCount: z.number().int().nonnegative(),
    reasonCodes: z.array(reasonCodeSchema).max(16),
    ranked: z.array(rankedCandidateSchema).max(16),
    excluded: z.array(excludedCandidateSchema).max(16),
    policyHash: sha256Schema,
    replayProfile: pairedReplayProfileSchema.nullable().optional(),
  })
  .strict();
const observationEventSchema = z
  .object({
    type: z.literal('runner_shadow_route_observed'),
    decisionId: z.string().uuid(),
    createdAt: z.number().int().nonnegative(),
    taskScopeHash: sha256Schema,
    commandClassHash: sha256Schema.nullable(),
    providerIdHash: sha256Schema,
    providerKind: providerKindSchema,
    environmentFingerprintHash: sha256Schema,
    outcome: z.enum(['completed', 'failed']),
    durationMs: z.number().int().nonnegative(),
    timedOut: z.boolean(),
    exitCodeClass: z.enum(['zero', 'non-zero', 'missing']),
  })
  .strict();
const automaticSelectionEventSchema = z
  .object({
    type: z.literal('runner_automatic_route_selected'),
    decisionId: z.string().uuid(),
    createdAt: z.number().int().nonnegative(),
    taskScopeHash: sha256Schema,
    configuredProviderIdHash: sha256Schema,
    configuredProviderKind: providerKindSchema,
    selectedProviderIdHash: sha256Schema,
    selectedProviderKind: providerKindSchema,
    confidence: z.number().min(0).max(1),
    providerEvidenceSamples: z.number().int().nonnegative(),
    successRate: z.number().min(0).max(1),
    timeoutRate: z.number().min(0).max(1),
    scoreAdvantage: z.number().nonnegative(),
    reasonCodes: z.array(promotionReasonCodeSchema).min(1).max(16),
    policyHash: sha256Schema,
    replayProfile: pairedReplayProfileSchema.optional(),
    fallbackPolicy: z.literal('configured-provider-before-dispatch-only'),
  })
  .strict();
const pairedReplayEventSchema = z
  .object({
    type: z.literal('runner_paired_replay_observed'),
    decisionId: z.string().uuid(),
    createdAt: z.number().int().nonnegative(),
    taskScopeHash: sha256Schema,
    commandClassHash: sha256Schema,
    providerIdHash: sha256Schema,
    providerKind: z.enum(['local', 'ssh', 'docker']),
    snapshotHash: sha256Schema,
    environmentFingerprintHash: sha256Schema,
    outcome: z.enum(['completed', 'failed']),
    durationMs: z.number().int().nonnegative(),
    preparationDurationMs: z.number().int().nonnegative().optional(),
    totalDurationMs: z.number().int().nonnegative().optional(),
    workspaceCacheStatus: z
      .enum(['disabled', 'cold', 'warm', 'quarantined'])
      .optional(),
    workspaceReuseCount: z.number().int().nonnegative().optional(),
    transferBytes: z.number().int().nonnegative().optional(),
    transferBytesAvoided: z.number().int().nonnegative().optional(),
    timedOut: z.boolean(),
    exitCodeClass: z.enum(['zero', 'non-zero', 'missing']),
    receiptHash: sha256Schema,
    jobHash: sha256Schema,
    outputHash: sha256Schema.nullable(),
    artifactManifestHash: sha256Schema.nullable(),
    executionTimingHash: sha256Schema.nullable().optional(),
    executionTimings: executionTimingsSchema.optional(),
    riskClass: z.enum(['read-only', 'workspace-contained']),
    sampleBucket: z.number().min(0).max(1),
    policyHash: sha256Schema,
    replayProfile: pairedReplayProfileSchema.optional(),
  })
  .strict();
const pairedReplayAdmissionEventSchema = z
  .object({
    type: z.literal('runner_paired_replay_admission_evaluated'),
    decisionId: z.string().uuid(),
    createdAt: z.number().int().nonnegative(),
    taskScopeHash: sha256Schema,
    commandClassHash: sha256Schema,
    snapshotHash: sha256Schema,
    actualProviderKind: providerKindSchema,
    targetProviderIdHash: sha256Schema,
    targetProviderKind: z.enum(['local', 'ssh', 'docker']),
    riskClass: z.enum(['read-only', 'workspace-contained', 'ineligible']),
    admitted: z.boolean(),
    scheduleOutcome: z.enum([
      'policy-rejected',
      'not-sampled',
      'concurrency-limited',
      'scheduled',
    ]),
    sampleBucket: z.number().min(0).max(1),
    sampleRate: z.number().min(0).max(1),
    reasonCodes: z.array(pairedReplayReasonCodeSchema).min(1).max(20),
    policyHash: sha256Schema,
    replayProfile: pairedReplayProfileSchema.optional(),
  })
  .strict();
const dogfoodEvidenceEventSchema = z
  .object({
    type: z.literal('runner_profile_dogfood_ingested'),
    createdAt: z.number().int().nonnegative(),
    ingestionKey: sha256Schema,
    bundleId: z.string().uuid(),
    sampleId: z.string().uuid(),
    collectorKeyIdHash: sha256Schema,
    commandClassHash: sha256Schema,
    snapshotHash: sha256Schema,
    replayProfile: pairedReplayProfileSchema,
    scenario: z
      .enum([
        'organic-read-only',
        'organic-heavyweight',
        'controlled-local-timeout',
        'controlled-local-failure',
        'controlled-local-latency',
      ])
      .optional(),
    promotionEligible: z.boolean().optional(),
    actualProviderIdHash: sha256Schema,
    actualProviderKind: z.enum(['local', 'ssh', 'docker']),
    actualEnvironmentFingerprintHash: sha256Schema,
    actualOutcome: z.enum(['completed', 'failed']),
    actualDurationMs: z.number().int().nonnegative(),
    actualTimedOut: z.boolean(),
    actualExitCodeClass: z.enum(['zero', 'non-zero', 'missing']),
    actualReceiptHash: sha256Schema,
    actualJobHash: sha256Schema,
    replayProviderIdHash: sha256Schema,
    replayProviderKind: z.enum(['local', 'ssh', 'docker']),
    replayEnvironmentFingerprintHash: sha256Schema,
    replayOutcome: z.enum(['completed', 'failed']),
    replayDurationMs: z.number().int().nonnegative(),
    replayPreparationDurationMs: z.number().int().nonnegative().optional(),
    replayTotalDurationMs: z.number().int().nonnegative().optional(),
    replayWorkspaceCacheStatus: z
      .enum(['disabled', 'cold', 'warm', 'quarantined'])
      .optional(),
    replayWorkspaceReuseCount: z.number().int().nonnegative().optional(),
    replayTransferBytes: z.number().int().nonnegative().optional(),
    replayTransferBytesAvoided: z.number().int().nonnegative().optional(),
    replayTimedOut: z.boolean(),
    replayExitCodeClass: z.enum(['zero', 'non-zero', 'missing']),
    replayReceiptHash: sha256Schema,
    replayJobHash: sha256Schema,
    replayExecutionTimingHash: sha256Schema.nullable().optional(),
    replayExecutionTimings: executionTimingsSchema.optional(),
  })
  .strict();
const shadowEventSchema = z.discriminatedUnion('type', [
  decisionEventSchema,
  observationEventSchema,
  automaticSelectionEventSchema,
  pairedReplayAdmissionEventSchema,
  pairedReplayEventSchema,
  dogfoodEvidenceEventSchema,
]);
type RunnerRoutingShadowEvent = z.infer<typeof shadowEventSchema>;
const shadowRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
    previousHash: z.string(),
    eventHash: sha256Schema,
    event: shadowEventSchema,
  })
  .strict();
type RunnerRoutingShadowRecord = z.infer<typeof shadowRecordSchema>;

export interface RecordRunnerRoutingDecisionInput {
  taskId: string;
  commandClassHash: string | null;
  operation: 'create-session' | 'execute-command' | 'kill-session';
  snapshotHash: string;
  repositoryRevision: string | null;
  dirtyPatchHash: string | null;
  environmentFingerprintHash: string;
  replayProfile: RunnerPairedReplayProfile | null;
  decision: RunnerRoutingDecision;
}

export interface RecordRunnerRoutingObservationInput {
  decisionId: string;
  taskId: string;
  commandClassHash: string | null;
  providerId: string;
  observation: Omit<
    RunnerRoutingObservation,
    'commandClassHash' | 'providerId'
  >;
  createdAt?: number;
}

export interface RecordRunnerAutomaticSelectionInput {
  decisionId: string;
  taskId: string;
  configuredProviderId: string;
  configuredProviderKind: RunnerRoutingDecision['actualProviderKind'];
  replayProfile: RunnerPairedReplayProfile;
  promotion: RunnerRoutingPromotionEvaluation;
}

export interface RecordRunnerPairedReplayInput {
  decisionId: string;
  taskId: string;
  commandClassHash: string;
  providerId: string;
  providerKind: 'local' | 'ssh' | 'docker';
  snapshotHash: string;
  environmentFingerprintHash: string;
  outcome: 'completed' | 'failed';
  durationMs: number;
  preparationDurationMs?: number;
  totalDurationMs?: number;
  workspaceCacheStatus?: 'disabled' | 'cold' | 'warm' | 'quarantined';
  workspaceReuseCount?: number;
  transferBytes?: number;
  transferBytesAvoided?: number;
  timedOut: boolean;
  exitCodeClass: 'zero' | 'non-zero' | 'missing';
  receiptHash: string;
  jobHash: string;
  outputHash: string | null;
  artifactManifestHash: string | null;
  executionTimingHash?: string | null;
  executionTimings?: RunnerExecutionStageTimings;
  riskClass: 'read-only' | 'workspace-contained';
  sampleBucket: number;
  policyHash: string;
  replayProfile: RunnerPairedReplayProfile;
  createdAt?: number;
}

export interface RecordRunnerPairedReplayAdmissionInput {
  decisionId: string;
  taskId: string;
  commandClassHash: string;
  snapshotHash: string;
  actualProviderKind: RunnerRoutingDecision['actualProviderKind'];
  targetProviderId: string;
  targetProviderKind: 'local' | 'ssh' | 'docker';
  riskClass: 'read-only' | 'workspace-contained' | 'ineligible';
  admitted: boolean;
  scheduleOutcome:
    | 'policy-rejected'
    | 'not-sampled'
    | 'concurrency-limited'
    | 'scheduled';
  sampleBucket: number;
  sampleRate: number;
  reasonCodes: Array<(typeof runnerPairedReplayReasonCodes)[number]>;
  policyHash: string;
  replayProfile: RunnerPairedReplayProfile;
  createdAt?: number;
}

export interface RunnerPairedReplayDogfoodReport {
  candidateCount: number;
  policyAdmittedCount: number;
  scheduledCount: number;
  concurrencyLimitedCount: number;
  completedCount: number;
  completionCoverage: number;
  replaySuccessRate: number | null;
  replayTimeoutRate: number | null;
  averageDurationMs: number | null;
  averagePreparationDurationMs: number | null;
  averageTotalDurationMs: number | null;
  rejectionReasonCounts: Record<string, number>;
  riskClassCounts: Record<string, number>;
  providerCounts: Record<string, number>;
  profileCounts: Record<string, number>;
  profileMetrics: RunnerPairedReplayDogfoodProfileMetrics[];
  policyHashes: string[];
}

export interface RunnerPairedReplayDogfoodProfileMetrics {
  profile: RunnerPairedReplayProfile;
  candidateCount: number;
  scheduledCount: number;
  completedCount: number;
  replaySuccessRate: number | null;
  replayFailureRate: number | null;
  replayTimeoutRate: number | null;
  averageDurationMs: number | null;
  averagePreparationDurationMs: number | null;
  averageTotalDurationMs: number | null;
  warmCacheRate: number | null;
  coldCacheRate: number | null;
  workspaceReuseAverage: number | null;
  transferBytesAverage: number | null;
  transferBytesAvoidedAverage: number | null;
  averageSshRoundTrips: number | null;
  averageArtifactBeforeDurationMs: number | null;
  averageDispatchDurationMs: number | null;
  averageCommandDurationMs: number | null;
  averagePollingDurationMs: number | null;
  averageArtifactAfterDurationMs: number | null;
  averageReceiptFinalizationDurationMs: number | null;
}

export interface ListRunnerRoutingEvaluationSamplesInput {
  taskId?: string;
  limit?: number;
  includeHistoricalCounterfactuals?: boolean;
  replayProfile?: RunnerPairedReplayProfile;
}

export interface EvaluateRunnerRoutingShadowLedgerInput
  extends ListRunnerRoutingEvaluationSamplesInput {
  thresholds?: RunnerRoutingEvaluationThresholds;
}

export interface RunnerDogfoodEvidenceIngestionResult {
  bundleId: string;
  importedSamples: number;
  duplicateSamples: number;
  profiles: RunnerPairedReplayProfile[];
}

export interface RunnerDogfoodScenarioMetrics {
  scenario: RunnerDogfoodEvidenceScenario;
  sampleCount: number;
  promotionEligibleCount: number;
  actualFailureRate: number | null;
  actualTimeoutRate: number | null;
  replayFailureRate: number | null;
  replayTimeoutRate: number | null;
  recommendationWinRate: number | null;
  harmfulRecommendationRate: number | null;
  latencyAdvantageAverageMs: number | null;
  latencyAdvantageP50Ms: number | null;
  latencyAdvantageP95Ms: number | null;
  replayPreparationAverageMs: number | null;
  replayTotalAverageMs: number | null;
  warmCacheRate: number | null;
  coldCacheRate: number | null;
  workspaceReuseAverage: number | null;
  transferBytesAverage: number | null;
  transferBytesAvoidedAverage: number | null;
  replaySshRoundTripsAverage: number | null;
  replayArtifactBeforeAverageMs: number | null;
  replayDispatchAverageMs: number | null;
  replayCommandAverageMs: number | null;
  replayPollingAverageMs: number | null;
  replayArtifactAfterAverageMs: number | null;
  replayReceiptFinalizationAverageMs: number | null;
}

export interface RunnerDogfoodDiagnosticsReport {
  sampleCount: number;
  promotionEligibleCount: number;
  controlledSampleCount: number;
  scenarioMetrics: RunnerDogfoodScenarioMetrics[];
}

/**
 * Protected, tamper-evident and content-free shadow routing ledger.
 *
 * Provider IDs, task scopes and repository revisions are hashed before
 * persistence. Commands, output, file paths and artifact contents are not
 * represented in the event schema and therefore cannot be appended.
 */
export class RunnerRoutingShadowLedger {
  private readonly storage: ProtectedAppendFileStorage;
  private readonly observations: RunnerRoutingObservation[] = [];
  private readonly evaluationEvents: RunnerRoutingShadowEvent[] = [];
  private readonly dogfoodIngestionKeys = new Set<string>();
  private queue = Promise.resolve();
  private dogfoodQueue = Promise.resolve();
  private initialized = false;
  private sequence = 0;
  private previousHash = 'GENESIS';

  public constructor(
    protectedFiles: ProtectedFileStorage,
    filePath: string,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
    private readonly maxIndexedObservations = 5_000,
  ) {
    this.storage = new ProtectedAppendFileStorage(
      protectedFiles,
      filePath,
      'runner-routing/shadow-ledger/v1',
    );
  }

  public async recordDecision(
    input: RecordRunnerRoutingDecisionInput,
  ): Promise<string> {
    const decisionId = this.createId();
    const event = decisionEventSchema.parse({
      type: 'runner_shadow_route_decided',
      decisionId,
      createdAt: this.now(),
      taskScopeHash: hashText(input.taskId),
      commandClassHash: input.commandClassHash,
      operation: input.operation,
      snapshotHash: input.snapshotHash,
      repositoryRevisionHash: input.repositoryRevision
        ? hashText(input.repositoryRevision)
        : null,
      dirtyPatchHash: input.dirtyPatchHash,
      environmentFingerprintHash: input.environmentFingerprintHash,
      actualProviderIdHash: hashText(input.decision.actualProviderId),
      actualProviderKind: input.decision.actualProviderKind,
      recommendedProviderIdHash: hashText(input.decision.recommendedProviderId),
      recommendedProviderKind: input.decision.recommendedProviderKind,
      confidence: input.decision.confidence,
      evidenceSampleCount: input.decision.evidenceSampleCount,
      reasonCodes: input.decision.reasonCodes,
      ranked: input.decision.ranked.map((candidate) => ({
        ...candidate,
        providerId: hashText(candidate.providerId),
      })),
      excluded: input.decision.excluded.map((candidate) => ({
        ...candidate,
        providerId: hashText(candidate.providerId),
      })),
      policyHash: input.decision.policyHash,
      replayProfile: input.replayProfile,
    });
    await this.enqueue(event);
    return decisionId;
  }

  public async recordObservation(
    input: RecordRunnerRoutingObservationInput,
  ): Promise<void> {
    const event = observationEventSchema.parse({
      type: 'runner_shadow_route_observed',
      decisionId: input.decisionId,
      createdAt: input.createdAt ?? this.now(),
      taskScopeHash: hashText(input.taskId),
      commandClassHash: input.commandClassHash,
      providerIdHash: hashText(input.providerId),
      providerKind: input.observation.providerKind,
      environmentFingerprintHash: input.observation.environmentFingerprintHash,
      outcome: input.observation.outcome,
      durationMs: input.observation.durationMs,
      timedOut: input.observation.timedOut,
      exitCodeClass: input.observation.exitCodeClass,
    });
    await this.enqueue(event);
  }

  public async recordAutomaticSelection(
    input: RecordRunnerAutomaticSelectionInput,
  ): Promise<void> {
    if (!input.promotion.promoted) {
      throw new Error('Only promoted runner routes can be recorded');
    }
    const event = automaticSelectionEventSchema.parse({
      type: 'runner_automatic_route_selected',
      decisionId: input.decisionId,
      createdAt: this.now(),
      taskScopeHash: hashText(input.taskId),
      configuredProviderIdHash: hashText(input.configuredProviderId),
      configuredProviderKind: input.configuredProviderKind,
      selectedProviderIdHash: hashText(input.promotion.selectedProviderId),
      selectedProviderKind: input.promotion.selectedProviderKind,
      confidence: input.promotion.confidence,
      providerEvidenceSamples: input.promotion.providerEvidenceSamples,
      successRate: input.promotion.successRate,
      timeoutRate: input.promotion.timeoutRate,
      scoreAdvantage: input.promotion.scoreAdvantage,
      reasonCodes: input.promotion.reasonCodes,
      policyHash: input.promotion.policyHash,
      replayProfile: input.replayProfile,
      fallbackPolicy: 'configured-provider-before-dispatch-only',
    });
    await this.enqueue(event);
  }

  public async recordPairedReplayAdmission(
    input: RecordRunnerPairedReplayAdmissionInput,
  ): Promise<void> {
    await this.initialize();
    const decision = this.findDecision(input.decisionId);
    if (
      !decision ||
      decision.taskScopeHash !== hashText(input.taskId) ||
      decision.commandClassHash !== input.commandClassHash ||
      decision.snapshotHash !== input.snapshotHash ||
      decision.actualProviderKind !== input.actualProviderKind ||
      decision.recommendedProviderIdHash !== hashText(input.targetProviderId) ||
      decision.recommendedProviderKind !== input.targetProviderKind ||
      (decision.replayProfile !== undefined &&
        decision.replayProfile !== input.replayProfile)
    ) {
      throw new Error('Paired replay admission is not bound to its decision');
    }
    const event = pairedReplayAdmissionEventSchema.parse({
      type: 'runner_paired_replay_admission_evaluated',
      decisionId: input.decisionId,
      createdAt: input.createdAt ?? this.now(),
      taskScopeHash: hashText(input.taskId),
      commandClassHash: input.commandClassHash,
      snapshotHash: input.snapshotHash,
      actualProviderKind: input.actualProviderKind,
      targetProviderIdHash: hashText(input.targetProviderId),
      targetProviderKind: input.targetProviderKind,
      riskClass: input.riskClass,
      admitted: input.admitted,
      scheduleOutcome: input.scheduleOutcome,
      sampleBucket: input.sampleBucket,
      sampleRate: input.sampleRate,
      reasonCodes: input.reasonCodes,
      policyHash: input.policyHash,
      replayProfile: input.replayProfile,
    });
    await this.enqueue(event);
  }

  public async recordPairedReplay(
    input: RecordRunnerPairedReplayInput,
  ): Promise<void> {
    await this.initialize();
    const decision = this.findDecision(input.decisionId);
    if (
      !decision ||
      decision.taskScopeHash !== hashText(input.taskId) ||
      decision.commandClassHash !== input.commandClassHash ||
      decision.snapshotHash !== input.snapshotHash ||
      decision.recommendedProviderIdHash !== hashText(input.providerId) ||
      decision.recommendedProviderKind !== input.providerKind ||
      (decision.replayProfile !== undefined &&
        decision.replayProfile !== input.replayProfile)
    ) {
      throw new Error('Paired replay is not bound to its shadow decision');
    }
    const event = pairedReplayEventSchema.parse({
      type: 'runner_paired_replay_observed',
      decisionId: input.decisionId,
      createdAt: input.createdAt ?? this.now(),
      taskScopeHash: hashText(input.taskId),
      commandClassHash: input.commandClassHash,
      providerIdHash: hashText(input.providerId),
      providerKind: input.providerKind,
      snapshotHash: input.snapshotHash,
      environmentFingerprintHash: input.environmentFingerprintHash,
      outcome: input.outcome,
      durationMs: input.durationMs,
      preparationDurationMs: input.preparationDurationMs,
      totalDurationMs: input.totalDurationMs,
      workspaceCacheStatus: input.workspaceCacheStatus,
      workspaceReuseCount: input.workspaceReuseCount,
      transferBytes: input.transferBytes,
      transferBytesAvoided: input.transferBytesAvoided,
      timedOut: input.timedOut,
      exitCodeClass: input.exitCodeClass,
      receiptHash: input.receiptHash,
      jobHash: input.jobHash,
      outputHash: input.outputHash,
      artifactManifestHash: input.artifactManifestHash,
      executionTimingHash: input.executionTimingHash,
      executionTimings: input.executionTimings,
      riskClass: input.riskClass,
      sampleBucket: input.sampleBucket,
      policyHash: input.policyHash,
      replayProfile: input.replayProfile,
    });
    await this.enqueue(event);
  }

  public ingestDogfoodEvidence(
    input: unknown,
    trustedCollectorPublicKeys: readonly string[],
  ): Promise<RunnerDogfoodEvidenceIngestionResult> {
    const bundle = verifyRunnerDogfoodEvidenceBundle(
      input,
      trustedCollectorPublicKeys,
    );
    const operation = this.dogfoodQueue.then(
      () => this.ingestVerifiedDogfoodEvidence(bundle),
      () => this.ingestVerifiedDogfoodEvidence(bundle),
    );
    this.dogfoodQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async ingestVerifiedDogfoodEvidence(
    bundle: RunnerDogfoodEvidenceBundle,
  ): Promise<RunnerDogfoodEvidenceIngestionResult> {
    await this.initialize();
    let importedSamples = 0;
    let duplicateSamples = 0;
    const profiles = new Set<RunnerPairedReplayProfile>();
    for (const sample of bundle.samples) {
      const ingestionKey = hashText(`${bundle.bundleId}\0${sample.sampleId}`);
      profiles.add(sample.profile);
      if (this.dogfoodIngestionKeys.has(ingestionKey)) {
        duplicateSamples += 1;
        continue;
      }
      const event = dogfoodEvidenceEventSchema.parse({
        type: 'runner_profile_dogfood_ingested',
        createdAt: bundle.collectedAt,
        ingestionKey,
        bundleId: bundle.bundleId,
        sampleId: sample.sampleId,
        collectorKeyIdHash: hashText(bundle.collectorKeyId),
        commandClassHash: sample.commandClassHash,
        snapshotHash: sample.snapshotHash,
        replayProfile: sample.profile,
        scenario: getRunnerDogfoodEvidenceScenario(sample),
        promotionEligible: isRunnerDogfoodEvidencePromotionEligible(sample),
        actualProviderIdHash: hashText(sample.actual.providerId),
        actualProviderKind: sample.actual.providerKind,
        actualEnvironmentFingerprintHash:
          sample.actual.environmentFingerprintHash,
        actualOutcome: sample.actual.outcome,
        actualDurationMs: sample.actual.durationMs,
        actualTimedOut: sample.actual.timedOut,
        actualExitCodeClass: sample.actual.exitCodeClass,
        actualReceiptHash: sample.actual.receiptHash,
        actualJobHash: sample.actual.jobHash,
        replayProviderIdHash: hashText(sample.replay.providerId),
        replayProviderKind: sample.replay.providerKind,
        replayEnvironmentFingerprintHash:
          sample.replay.environmentFingerprintHash,
        replayOutcome: sample.replay.outcome,
        replayDurationMs: sample.replay.durationMs,
        replayPreparationDurationMs: sample.replay.preparationDurationMs,
        replayTotalDurationMs: sample.replay.totalDurationMs,
        replayWorkspaceCacheStatus: sample.replay.workspaceCacheStatus,
        replayWorkspaceReuseCount: sample.replay.workspaceReuseCount,
        replayTransferBytes: sample.replay.transferBytes,
        replayTransferBytesAvoided: sample.replay.transferBytesAvoided,
        replayTimedOut: sample.replay.timedOut,
        replayExitCodeClass: sample.replay.exitCodeClass,
        replayReceiptHash: sample.replay.receiptHash,
        replayJobHash: sample.replay.jobHash,
        replayExecutionTimingHash: sample.replay.executionTimingHash,
        replayExecutionTimings: sample.replay.executionTimings,
      });
      await this.enqueue(event);
      importedSamples += 1;
    }
    return {
      bundleId: bundle.bundleId,
      importedSamples,
      duplicateSamples,
      profiles: [...profiles].sort(),
    };
  }

  private findDecision(
    decisionId: string,
  ): z.infer<typeof decisionEventSchema> | undefined {
    return this.evaluationEvents.find(
      (event): event is z.infer<typeof decisionEventSchema> =>
        event.type === 'runner_shadow_route_decided' &&
        event.decisionId === decisionId,
    );
  }

  public async listRecentObservations(
    commandClassHash: string,
    providerIds: ReadonlyMap<string, string>,
    limit = 200,
  ): Promise<RunnerRoutingObservation[]> {
    await this.initialize();
    const normalizedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const providerIdByHash = new Map(
      Array.from(providerIds, ([providerId, providerKind]) => [
        hashText(providerId),
        { providerId, providerKind },
      ]),
    );
    return this.observations
      .filter(
        (observation) =>
          observation.commandClassHash === commandClassHash &&
          providerIdByHash.has(observation.providerId),
      )
      .slice(-normalizedLimit)
      .map((observation) => {
        const provider = providerIdByHash.get(observation.providerId)!;
        return {
          ...observation,
          providerId: provider.providerId,
          providerKind:
            provider.providerKind as RunnerRoutingObservation['providerKind'],
        };
      });
  }

  private async enqueue(event: RunnerRoutingShadowEvent): Promise<void> {
    this.queue = this.queue.then(
      () => this.append(event),
      () => this.append(event),
    );
    await this.queue;
  }

  private async append(event: RunnerRoutingShadowEvent): Promise<void> {
    await this.initialize();
    const withoutHash = {
      schemaVersion: 1 as const,
      sequence: this.sequence + 1,
      previousHash: this.previousHash,
      event,
    };
    const record: RunnerRoutingShadowRecord = {
      ...withoutHash,
      eventHash: hashRecord(withoutHash),
    };
    await this.storage.append(`${JSON.stringify(record)}\n`);
    this.sequence = record.sequence;
    this.previousHash = record.eventHash;
    this.indexObservation(event);
    this.indexEvaluationEvent(event);
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const content = (await this.storage.readFile()).toString('utf8');
      let sequence = 0;
      let previousHash = 'GENESIS';
      this.observations.length = 0;
      this.evaluationEvents.length = 0;
      this.dogfoodIngestionKeys.clear();
      for (const line of content.split('\n').filter(Boolean)) {
        const parsed = shadowRecordSchema.safeParse(JSON.parse(line));
        if (
          !parsed.success ||
          parsed.data.sequence !== sequence + 1 ||
          parsed.data.previousHash !== previousHash ||
          parsed.data.eventHash !==
            hashRecord({
              schemaVersion: parsed.data.schemaVersion,
              sequence: parsed.data.sequence,
              previousHash: parsed.data.previousHash,
              event: parsed.data.event,
            })
        ) {
          throw new Error('invalid runner routing shadow record');
        }
        sequence = parsed.data.sequence;
        previousHash = parsed.data.eventHash;
        this.indexObservation(parsed.data.event);
        this.indexEvaluationEvent(parsed.data.event);
      }
      this.sequence = sequence;
      this.previousHash = previousHash;
      this.initialized = true;
    } catch (error) {
      this.logger.error(
        '[RunnerRouting] Shadow ledger integrity failed',
        error,
      );
      throw new Error('Runner routing shadow ledger integrity check failed', {
        cause: error,
      });
    }
  }

  private indexObservation(event: RunnerRoutingShadowEvent): void {
    if (
      event.type !== 'runner_shadow_route_observed' ||
      !event.commandClassHash
    ) {
      return;
    }
    this.observations.push({
      commandClassHash: event.commandClassHash,
      providerId: event.providerIdHash,
      providerKind: event.providerKind,
      environmentFingerprintHash: event.environmentFingerprintHash,
      outcome: event.outcome,
      durationMs: event.durationMs,
      timedOut: event.timedOut,
      exitCodeClass: event.exitCodeClass,
    });
    if (this.observations.length > this.maxIndexedObservations) {
      this.observations.splice(
        0,
        this.observations.length - this.maxIndexedObservations,
      );
    }
  }

  public async listEvaluationSamples(
    input: ListRunnerRoutingEvaluationSamplesInput = {},
  ): Promise<RunnerRoutingEvaluationSample[]> {
    await this.initialize();
    const taskScopeHash = input.taskId ? hashText(input.taskId) : null;
    const limit = Math.max(
      1,
      Math.min(5_000, Math.floor(input.limit ?? 1_000)),
    );
    const decisions = new Map<string, z.infer<typeof decisionEventSchema>>();
    const observations: z.infer<typeof observationEventSchema>[] = [];
    const dogfoodSamples: z.infer<typeof dogfoodEvidenceEventSchema>[] = [];
    const pairedReplays = new Map<
      string,
      z.infer<typeof pairedReplayEventSchema>
    >();
    for (const event of this.evaluationEvents) {
      if (
        taskScopeHash &&
        event.type !== 'runner_profile_dogfood_ingested' &&
        event.taskScopeHash !== taskScopeHash
      ) {
        continue;
      }
      if (event.type === 'runner_shadow_route_decided') {
        decisions.set(event.decisionId, event);
      } else if (event.type === 'runner_shadow_route_observed') {
        observations.push(event);
      } else if (event.type === 'runner_paired_replay_observed') {
        pairedReplays.set(event.decisionId, event);
      } else if (event.type === 'runner_profile_dogfood_ingested') {
        dogfoodSamples.push(event);
      }
    }
    const samples = observations.flatMap((observation) => {
      const decision = decisions.get(observation.decisionId);
      if (!decision) return [];
      const actualRank = decision.ranked.find(
        (candidate) =>
          candidate.providerId === decision.actualProviderIdHash &&
          candidate.providerKind === decision.actualProviderKind,
      );
      const recommendedRank = decision.ranked.find(
        (candidate) =>
          candidate.providerId === decision.recommendedProviderIdHash &&
          candidate.providerKind === decision.recommendedProviderKind,
      );
      const pairedReplay = pairedReplays.get(observation.decisionId);
      const verifiedCounterfactual = pairedReplay
        ? {
            providerId: pairedReplay.providerIdHash,
            providerKind: pairedReplay.providerKind,
            outcome: pairedReplay.outcome,
            durationMs: pairedReplay.durationMs,
            preparationDurationMs: pairedReplay.preparationDurationMs,
            totalDurationMs: pairedReplay.totalDurationMs,
            timedOut: pairedReplay.timedOut,
            exitCodeClass: pairedReplay.exitCodeClass,
            source: 'paired-replay' as const,
          }
        : undefined;
      const historicalCounterfactual =
        verifiedCounterfactual ||
        input.includeHistoricalCounterfactuals === false ||
        (decision.actualProviderIdHash === decision.recommendedProviderIdHash &&
          decision.actualProviderKind === decision.recommendedProviderKind)
          ? undefined
          : closestHistoricalCounterfactual(
              observations,
              observation,
              decision,
            );
      return [
        {
          decisionId: decision.decisionId,
          commandClassHash: decision.commandClassHash,
          actualProviderId: decision.actualProviderIdHash,
          actualProviderKind: decision.actualProviderKind,
          recommendedProviderId: decision.recommendedProviderIdHash,
          recommendedProviderKind: decision.recommendedProviderKind,
          confidence: decision.confidence,
          evidenceSampleCount: decision.evidenceSampleCount,
          estimatedActualDurationMs: actualRank?.estimatedDurationMs ?? null,
          estimatedRecommendedDurationMs:
            recommendedRank?.estimatedDurationMs ?? null,
          replayProfile:
            pairedReplay?.replayProfile ?? decision.replayProfile ?? null,
          actual: {
            providerId: observation.providerIdHash,
            providerKind: observation.providerKind,
            outcome: observation.outcome,
            durationMs: observation.durationMs,
            timedOut: observation.timedOut,
            exitCodeClass: observation.exitCodeClass,
          },
          counterfactualRecommended:
            verifiedCounterfactual ?? historicalCounterfactual,
        } satisfies RunnerRoutingEvaluationSample,
      ];
    });
    const importedSamples = dogfoodSamples
      .filter((sample) => sample.promotionEligible !== false)
      .map(
        (sample): RunnerRoutingEvaluationSample => ({
          decisionId: sample.sampleId,
          commandClassHash: sample.commandClassHash,
          actualProviderId: sample.actualProviderIdHash,
          actualProviderKind: sample.actualProviderKind,
          recommendedProviderId: sample.replayProviderIdHash,
          recommendedProviderKind: sample.replayProviderKind,
          confidence: 1,
          evidenceSampleCount: 1,
          estimatedActualDurationMs: sample.actualDurationMs,
          estimatedRecommendedDurationMs: sample.replayDurationMs,
          replayProfile: sample.replayProfile,
          actual: {
            providerId: sample.actualProviderIdHash,
            providerKind: sample.actualProviderKind,
            outcome: sample.actualOutcome,
            durationMs: sample.actualDurationMs,
            timedOut: sample.actualTimedOut,
            exitCodeClass: sample.actualExitCodeClass,
          },
          counterfactualRecommended: {
            providerId: sample.replayProviderIdHash,
            providerKind: sample.replayProviderKind,
            outcome: sample.replayOutcome,
            durationMs: sample.replayDurationMs,
            preparationDurationMs: sample.replayPreparationDurationMs,
            totalDurationMs: sample.replayTotalDurationMs,
            timedOut: sample.replayTimedOut,
            exitCodeClass: sample.replayExitCodeClass,
            source: 'paired-replay',
          },
        }),
      );
    return [...samples, ...importedSamples]
      .filter(
        (sample) =>
          input.replayProfile === undefined ||
          sample.replayProfile === input.replayProfile,
      )
      .slice(-limit);
  }

  public async evaluate(
    input: EvaluateRunnerRoutingShadowLedgerInput = {},
  ): Promise<RunnerRoutingEvaluationReport> {
    return evaluateRunnerRouting(
      await this.listEvaluationSamples(input),
      input.thresholds,
    );
  }

  public async evaluatePromotionProgress(
    input: EvaluateRunnerRoutingShadowLedgerInput = {},
  ): Promise<RunnerRoutingPromotionProgress> {
    return createRunnerRoutingPromotionProgress(
      await this.evaluate(input),
      input.thresholds,
    );
  }

  public async evaluateDogfoodDiagnostics(
    input: { replayProfile?: RunnerPairedReplayProfile } = {},
  ): Promise<RunnerDogfoodDiagnosticsReport> {
    await this.initialize();
    const samples = this.evaluationEvents.filter(
      (event): event is z.infer<typeof dogfoodEvidenceEventSchema> =>
        event.type === 'runner_profile_dogfood_ingested' &&
        (input.replayProfile === undefined ||
          event.replayProfile === input.replayProfile),
    );
    const scenarios: RunnerDogfoodEvidenceScenario[] = [
      'organic-read-only',
      'organic-heavyweight',
      'controlled-local-timeout',
      'controlled-local-failure',
      'controlled-local-latency',
    ];
    const scenarioMetrics = scenarios.flatMap((scenario) => {
      const scenarioSamples = samples.filter(
        (sample) => (sample.scenario ?? 'organic-read-only') === scenario,
      );
      if (scenarioSamples.length === 0) return [];
      const latencyAdvantages = scenarioSamples.flatMap((sample) =>
        dogfoodExecutionSucceeded(sample, 'actual') &&
        dogfoodExecutionSucceeded(sample, 'replay')
          ? [sample.actualDurationMs - sample.replayDurationMs]
          : [],
      );
      return [
        {
          scenario,
          sampleCount: scenarioSamples.length,
          promotionEligibleCount: scenarioSamples.filter(
            (sample) => sample.promotionEligible !== false,
          ).length,
          actualFailureRate: nullableRate(
            scenarioSamples.filter(
              (sample) => !dogfoodExecutionSucceeded(sample, 'actual'),
            ).length,
            scenarioSamples.length,
          ),
          actualTimeoutRate: nullableRate(
            scenarioSamples.filter((sample) => sample.actualTimedOut).length,
            scenarioSamples.length,
          ),
          replayFailureRate: nullableRate(
            scenarioSamples.filter(
              (sample) => !dogfoodExecutionSucceeded(sample, 'replay'),
            ).length,
            scenarioSamples.length,
          ),
          replayTimeoutRate: nullableRate(
            scenarioSamples.filter((sample) => sample.replayTimedOut).length,
            scenarioSamples.length,
          ),
          recommendationWinRate: nullableRate(
            scenarioSamples.filter(dogfoodRecommendationWins).length,
            scenarioSamples.length,
          ),
          harmfulRecommendationRate: nullableRate(
            scenarioSamples.filter(dogfoodRecommendationHarms).length,
            scenarioSamples.length,
          ),
          latencyAdvantageAverageMs: nullableAverage(latencyAdvantages),
          latencyAdvantageP50Ms: nullablePercentile(latencyAdvantages, 0.5),
          latencyAdvantageP95Ms: nullablePercentile(latencyAdvantages, 0.95),
          replayPreparationAverageMs: nullableAverage(
            scenarioSamples.flatMap((sample) =>
              sample.replayPreparationDurationMs === undefined
                ? []
                : [sample.replayPreparationDurationMs],
            ),
          ),
          replayTotalAverageMs: nullableAverage(
            scenarioSamples.flatMap((sample) =>
              sample.replayTotalDurationMs === undefined
                ? []
                : [sample.replayTotalDurationMs],
            ),
          ),
          warmCacheRate: nullableRate(
            scenarioSamples.filter(
              (sample) => sample.replayWorkspaceCacheStatus === 'warm',
            ).length,
            scenarioSamples.filter(
              (sample) => sample.replayWorkspaceCacheStatus !== undefined,
            ).length,
          ),
          coldCacheRate: nullableRate(
            scenarioSamples.filter(
              (sample) => sample.replayWorkspaceCacheStatus === 'cold',
            ).length,
            scenarioSamples.filter(
              (sample) => sample.replayWorkspaceCacheStatus !== undefined,
            ).length,
          ),
          workspaceReuseAverage: nullableAverage(
            scenarioSamples.flatMap((sample) =>
              sample.replayWorkspaceReuseCount === undefined
                ? []
                : [sample.replayWorkspaceReuseCount],
            ),
          ),
          transferBytesAverage: nullableAverage(
            scenarioSamples.flatMap((sample) =>
              sample.replayTransferBytes === undefined
                ? []
                : [sample.replayTransferBytes],
            ),
          ),
          transferBytesAvoidedAverage: nullableAverage(
            scenarioSamples.flatMap((sample) =>
              sample.replayTransferBytesAvoided === undefined
                ? []
                : [sample.replayTransferBytesAvoided],
            ),
          ),
          replaySshRoundTripsAverage: nullableAverage(
            scenarioSamples.flatMap((sample) =>
              sample.replayExecutionTimings
                ? [sample.replayExecutionTimings.sshRoundTrips]
                : [],
            ),
          ),
          replayArtifactBeforeAverageMs: nullableAverage(
            scenarioSamples.flatMap((sample) =>
              sample.replayExecutionTimings
                ? [sample.replayExecutionTimings.artifactBeforeDurationMs]
                : [],
            ),
          ),
          replayDispatchAverageMs: nullableAverage(
            scenarioSamples.flatMap((sample) =>
              sample.replayExecutionTimings
                ? [sample.replayExecutionTimings.dispatchDurationMs]
                : [],
            ),
          ),
          replayCommandAverageMs: nullableAverage(
            scenarioSamples.flatMap((sample) =>
              sample.replayExecutionTimings?.commandDurationMs === null ||
              sample.replayExecutionTimings?.commandDurationMs === undefined
                ? []
                : [sample.replayExecutionTimings.commandDurationMs],
            ),
          ),
          replayPollingAverageMs: nullableAverage(
            scenarioSamples.flatMap((sample) =>
              sample.replayExecutionTimings
                ? [sample.replayExecutionTimings.pollingDurationMs]
                : [],
            ),
          ),
          replayArtifactAfterAverageMs: nullableAverage(
            scenarioSamples.flatMap((sample) =>
              sample.replayExecutionTimings
                ? [sample.replayExecutionTimings.artifactAfterDurationMs]
                : [],
            ),
          ),
          replayReceiptFinalizationAverageMs: nullableAverage(
            scenarioSamples.flatMap((sample) =>
              sample.replayExecutionTimings
                ? [sample.replayExecutionTimings.receiptFinalizationDurationMs]
                : [],
            ),
          ),
        },
      ];
    });
    const promotionEligibleCount = samples.filter(
      (sample) => sample.promotionEligible !== false,
    ).length;
    return {
      sampleCount: samples.length,
      promotionEligibleCount,
      controlledSampleCount: samples.length - promotionEligibleCount,
      scenarioMetrics,
    };
  }

  public async evaluatePairedReplayDogfood(
    input: { taskId?: string } = {},
  ): Promise<RunnerPairedReplayDogfoodReport> {
    await this.initialize();
    const taskScopeHash = input.taskId ? hashText(input.taskId) : null;
    const admissions = this.evaluationEvents.filter(
      (event): event is z.infer<typeof pairedReplayAdmissionEventSchema> =>
        event.type === 'runner_paired_replay_admission_evaluated' &&
        (!taskScopeHash || event.taskScopeHash === taskScopeHash),
    );
    const replayByDecision = new Map(
      this.evaluationEvents
        .filter(
          (event): event is z.infer<typeof pairedReplayEventSchema> =>
            event.type === 'runner_paired_replay_observed' &&
            (!taskScopeHash || event.taskScopeHash === taskScopeHash),
        )
        .map((event) => [event.decisionId, event]),
    );
    const scheduled = admissions.filter(
      (event) => event.scheduleOutcome === 'scheduled',
    );
    const completed = scheduled.flatMap((event) => {
      const replay = replayByDecision.get(event.decisionId);
      return replay ? [replay] : [];
    });
    const rejectionReasonCounts: Record<string, number> = {};
    const riskClassCounts: Record<string, number> = {};
    const providerCounts: Record<string, number> = {};
    const profileCounts: Record<string, number> = {};
    for (const admission of admissions) {
      increment(riskClassCounts, admission.riskClass);
      increment(providerCounts, admission.targetProviderKind);
      if (admission.replayProfile) {
        increment(profileCounts, admission.replayProfile);
      }
      if (admission.scheduleOutcome !== 'scheduled') {
        for (const reason of admission.reasonCodes) {
          increment(rejectionReasonCounts, reason);
        }
        if (admission.scheduleOutcome === 'concurrency-limited') {
          increment(rejectionReasonCounts, 'concurrency-limited');
        }
      }
    }
    const durations = completed.map((event) => event.durationMs);
    const preparationDurations = completed.flatMap((event) =>
      event.preparationDurationMs === undefined
        ? []
        : [event.preparationDurationMs],
    );
    const totalDurations = completed.flatMap((event) =>
      event.totalDurationMs === undefined ? [] : [event.totalDurationMs],
    );
    const profileMetrics = runnerPairedReplayProfiles.flatMap((profile) => {
      const profileAdmissions = admissions.filter(
        (event) => event.replayProfile === profile,
      );
      if (profileAdmissions.length === 0) return [];
      const profileScheduled = profileAdmissions.filter(
        (event) => event.scheduleOutcome === 'scheduled',
      );
      const profileCompleted: Array<z.infer<typeof pairedReplayEventSchema>> =
        [];
      for (const scheduledEvent of profileScheduled) {
        const replay = replayByDecision.get(scheduledEvent.decisionId);
        if (replay?.replayProfile === profile) {
          profileCompleted.push(replay);
        }
      }
      const profileSuccessful = profileCompleted.filter(
        (event) =>
          event.outcome === 'completed' &&
          event.exitCodeClass === 'zero' &&
          !event.timedOut,
      );
      return [
        {
          profile,
          candidateCount: profileAdmissions.length,
          scheduledCount: profileScheduled.length,
          completedCount: profileCompleted.length,
          replaySuccessRate: nullableRate(
            profileSuccessful.length,
            profileCompleted.length,
          ),
          replayFailureRate: nullableRate(
            profileCompleted.length - profileSuccessful.length,
            profileCompleted.length,
          ),
          replayTimeoutRate: nullableRate(
            profileCompleted.filter((event) => event.timedOut).length,
            profileCompleted.length,
          ),
          averageDurationMs: nullableAverage(
            profileCompleted.map((event) => event.durationMs),
          ),
          averagePreparationDurationMs: nullableAverage(
            profileCompleted.flatMap((event) =>
              event.preparationDurationMs === undefined
                ? []
                : [event.preparationDurationMs],
            ),
          ),
          averageTotalDurationMs: nullableAverage(
            profileCompleted.flatMap((event) =>
              event.totalDurationMs === undefined
                ? []
                : [event.totalDurationMs],
            ),
          ),
          warmCacheRate: nullableRate(
            profileCompleted.filter(
              (event) => event.workspaceCacheStatus === 'warm',
            ).length,
            profileCompleted.filter(
              (event) => event.workspaceCacheStatus !== undefined,
            ).length,
          ),
          coldCacheRate: nullableRate(
            profileCompleted.filter(
              (event) => event.workspaceCacheStatus === 'cold',
            ).length,
            profileCompleted.filter(
              (event) => event.workspaceCacheStatus !== undefined,
            ).length,
          ),
          workspaceReuseAverage: nullableAverage(
            profileCompleted.flatMap((event) =>
              event.workspaceReuseCount === undefined
                ? []
                : [event.workspaceReuseCount],
            ),
          ),
          transferBytesAverage: nullableAverage(
            profileCompleted.flatMap((event) =>
              event.transferBytes === undefined ? [] : [event.transferBytes],
            ),
          ),
          transferBytesAvoidedAverage: nullableAverage(
            profileCompleted.flatMap((event) =>
              event.transferBytesAvoided === undefined
                ? []
                : [event.transferBytesAvoided],
            ),
          ),
          averageSshRoundTrips: nullableAverage(
            profileCompleted.flatMap((event) =>
              event.executionTimings
                ? [event.executionTimings.sshRoundTrips]
                : [],
            ),
          ),
          averageArtifactBeforeDurationMs: nullableAverage(
            profileCompleted.flatMap((event) =>
              event.executionTimings
                ? [event.executionTimings.artifactBeforeDurationMs]
                : [],
            ),
          ),
          averageDispatchDurationMs: nullableAverage(
            profileCompleted.flatMap((event) =>
              event.executionTimings
                ? [event.executionTimings.dispatchDurationMs]
                : [],
            ),
          ),
          averageCommandDurationMs: nullableAverage(
            profileCompleted.flatMap((event) =>
              event.executionTimings?.commandDurationMs === null ||
              event.executionTimings?.commandDurationMs === undefined
                ? []
                : [event.executionTimings.commandDurationMs],
            ),
          ),
          averagePollingDurationMs: nullableAverage(
            profileCompleted.flatMap((event) =>
              event.executionTimings
                ? [event.executionTimings.pollingDurationMs]
                : [],
            ),
          ),
          averageArtifactAfterDurationMs: nullableAverage(
            profileCompleted.flatMap((event) =>
              event.executionTimings
                ? [event.executionTimings.artifactAfterDurationMs]
                : [],
            ),
          ),
          averageReceiptFinalizationDurationMs: nullableAverage(
            profileCompleted.flatMap((event) =>
              event.executionTimings
                ? [event.executionTimings.receiptFinalizationDurationMs]
                : [],
            ),
          ),
        },
      ];
    });
    return {
      candidateCount: admissions.length,
      policyAdmittedCount: admissions.filter((event) => event.admitted).length,
      scheduledCount: scheduled.length,
      concurrencyLimitedCount: admissions.filter(
        (event) => event.scheduleOutcome === 'concurrency-limited',
      ).length,
      completedCount: completed.length,
      completionCoverage:
        scheduled.length === 0 ? 0 : completed.length / scheduled.length,
      replaySuccessRate:
        completed.length === 0
          ? null
          : completed.filter(
              (event) =>
                event.outcome === 'completed' &&
                event.exitCodeClass === 'zero' &&
                !event.timedOut,
            ).length / completed.length,
      replayTimeoutRate:
        completed.length === 0
          ? null
          : completed.filter((event) => event.timedOut).length /
            completed.length,
      averageDurationMs:
        durations.length === 0
          ? null
          : durations.reduce((total, value) => total + value, 0) /
            durations.length,
      averagePreparationDurationMs:
        preparationDurations.length === 0
          ? null
          : preparationDurations.reduce((total, value) => total + value, 0) /
            preparationDurations.length,
      averageTotalDurationMs:
        totalDurations.length === 0
          ? null
          : totalDurations.reduce((total, value) => total + value, 0) /
            totalDurations.length,
      rejectionReasonCounts,
      riskClassCounts,
      providerCounts,
      profileCounts,
      profileMetrics,
      policyHashes: Array.from(
        new Set(admissions.map((event) => event.policyHash)),
      ).sort(),
    };
  }

  private indexEvaluationEvent(event: RunnerRoutingShadowEvent): void {
    if (event.type === 'runner_profile_dogfood_ingested') {
      this.dogfoodIngestionKeys.add(event.ingestionKey);
    }
    this.evaluationEvents.push(event);
    const maximumEvents = this.maxIndexedObservations * 4;
    if (this.evaluationEvents.length > maximumEvents) {
      this.evaluationEvents.splice(
        0,
        this.evaluationEvents.length - maximumEvents,
      );
    }
  }
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function nullableRate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function nullableAverage(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function nullablePercentile(
  values: readonly number[],
  quantile: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1] ?? null;
}

function dogfoodExecutionSucceeded(
  sample: z.infer<typeof dogfoodEvidenceEventSchema>,
  side: 'actual' | 'replay',
): boolean {
  return (
    sample[`${side}Outcome`] === 'completed' &&
    sample[`${side}ExitCodeClass`] === 'zero' &&
    !sample[`${side}TimedOut`]
  );
}

function dogfoodRecommendationWins(
  sample: z.infer<typeof dogfoodEvidenceEventSchema>,
): boolean {
  const actualSucceeded = dogfoodExecutionSucceeded(sample, 'actual');
  const replaySucceeded = dogfoodExecutionSucceeded(sample, 'replay');
  if (actualSucceeded !== replaySucceeded) return replaySucceeded;
  return replaySucceeded && sample.replayDurationMs < sample.actualDurationMs;
}

function dogfoodRecommendationHarms(
  sample: z.infer<typeof dogfoodEvidenceEventSchema>,
): boolean {
  const actualSucceeded = dogfoodExecutionSucceeded(sample, 'actual');
  const replaySucceeded = dogfoodExecutionSucceeded(sample, 'replay');
  if (actualSucceeded !== replaySucceeded) return actualSucceeded;
  return (
    actualSucceeded && sample.replayDurationMs > sample.actualDurationMs * 1.1
  );
}

function closestHistoricalCounterfactual(
  observations: readonly z.infer<typeof observationEventSchema>[],
  actual: z.infer<typeof observationEventSchema>,
  decision: z.infer<typeof decisionEventSchema>,
):
  | (RunnerRoutingEvaluationSample['actual'] & {
      source: 'matched-command-history';
    })
  | undefined {
  if (!decision.commandClassHash) return undefined;
  const candidates = observations.filter(
    (observation) =>
      observation.decisionId !== actual.decisionId &&
      observation.commandClassHash === decision.commandClassHash &&
      observation.providerIdHash === decision.recommendedProviderIdHash &&
      observation.providerKind === decision.recommendedProviderKind,
  );
  candidates.sort(
    (left, right) =>
      Math.abs(left.createdAt - actual.createdAt) -
      Math.abs(right.createdAt - actual.createdAt),
  );
  const selected = candidates[0];
  if (!selected) return undefined;
  return {
    providerId: selected.providerIdHash,
    providerKind: selected.providerKind,
    outcome: selected.outcome,
    durationMs: selected.durationMs,
    timedOut: selected.timedOut,
    exitCodeClass: selected.exitCodeClass,
    source: 'matched-command-history',
  };
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashRecord(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
