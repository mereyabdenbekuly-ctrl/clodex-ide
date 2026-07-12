import type { IsolatedAgentRuntimeRolloutPolicy } from './isolated-agent-runtime-policy';

export const ISOLATED_AGENT_RUNTIME_PROMOTION_THRESHOLDS = {
  minimumObservationHours: 72,
  maximumEvidenceAgeHours: 48,
  minimumObservedBuildCount: 2,
  minimumObservedInstallCount: 25,
  minimumFinishedStepCount: 500,
  maximumFailureRate: 0.01,
  maximumAbortRate: 0.1,
  maximumWorkerCrashRate: 0.002,
  maximumCircuitBreakerOpenRate: 0.002,
} as const;

export interface IsolatedAgentRuntimePromotionEvidence {
  schemaVersion: 1;
  sourceChannel: 'prerelease';
  observationStartedAt: string;
  observationEndedAt: string;
  observedBuildCount: number;
  observedInstallCount: number;
  stepOutcomes: {
    completed: number;
    failed: number;
    aborted: number;
  };
  workerLifecycle: {
    crashed: number;
    restartSucceeded: number;
    restartSpawnFailed: number;
    restartBudgetExhausted: number;
  };
  circuitBreakerOpened: number;
  qualityGates: {
    happySmokePassed: boolean;
    faultSmokePassed: boolean;
    contentFreeTelemetryAuditPassed: boolean;
    noPostDispatchReplayAuditPassed: boolean;
  };
}

export type IsolatedAgentRuntimePromotionCheckId =
  | 'valid-observation-window'
  | 'evidence-not-from-future'
  | 'maximum-evidence-age-hours'
  | 'minimum-observation-hours'
  | 'minimum-observed-builds'
  | 'minimum-observed-installs'
  | 'minimum-finished-steps'
  | 'maximum-failure-rate'
  | 'maximum-abort-rate'
  | 'maximum-worker-crash-rate'
  | 'all-crashes-recovered'
  | 'no-restart-spawn-failures'
  | 'no-restart-budget-exhaustion'
  | 'maximum-circuit-breaker-open-rate'
  | 'happy-smoke-passed'
  | 'fault-smoke-passed'
  | 'content-free-telemetry-audit-passed'
  | 'no-post-dispatch-replay-audit-passed';

export interface IsolatedAgentRuntimePromotionCheck {
  id: IsolatedAgentRuntimePromotionCheckId;
  passed: boolean;
  actual: string | number | boolean;
  required: string | number | boolean;
}

export interface IsolatedAgentRuntimePromotionMetrics {
  observationHours: number;
  evidenceAgeHours: number;
  finishedStepCount: number;
  failureRate: number;
  abortRate: number;
  workerCrashRate: number;
  circuitBreakerOpenRate: number;
}

export interface IsolatedAgentRuntimePromotionReadiness {
  ready: boolean;
  checks: IsolatedAgentRuntimePromotionCheck[];
  metrics: IsolatedAgentRuntimePromotionMetrics;
}

export function parseIsolatedAgentRuntimePromotionEvidence(
  value: unknown,
): IsolatedAgentRuntimePromotionEvidence {
  const evidence = readRecord(value, 'evidence');
  assertAllowedKeys(
    evidence,
    [
      'schemaVersion',
      'sourceChannel',
      'observationStartedAt',
      'observationEndedAt',
      'observedBuildCount',
      'observedInstallCount',
      'stepOutcomes',
      'workerLifecycle',
      'circuitBreakerOpened',
      'qualityGates',
    ],
    'evidence',
  );

  const stepOutcomes = readRecord(evidence.stepOutcomes, 'stepOutcomes');
  assertAllowedKeys(
    stepOutcomes,
    ['completed', 'failed', 'aborted'],
    'stepOutcomes',
  );

  const workerLifecycle = readRecord(
    evidence.workerLifecycle,
    'workerLifecycle',
  );
  assertAllowedKeys(
    workerLifecycle,
    [
      'crashed',
      'restartSucceeded',
      'restartSpawnFailed',
      'restartBudgetExhausted',
    ],
    'workerLifecycle',
  );

  const qualityGates = readRecord(evidence.qualityGates, 'qualityGates');
  assertAllowedKeys(
    qualityGates,
    [
      'happySmokePassed',
      'faultSmokePassed',
      'contentFreeTelemetryAuditPassed',
      'noPostDispatchReplayAuditPassed',
    ],
    'qualityGates',
  );

  return {
    schemaVersion: readLiteral(evidence.schemaVersion, 1, 'schemaVersion'),
    sourceChannel: readLiteral(
      evidence.sourceChannel,
      'prerelease',
      'sourceChannel',
    ),
    observationStartedAt: readString(
      evidence.observationStartedAt,
      'observationStartedAt',
    ),
    observationEndedAt: readString(
      evidence.observationEndedAt,
      'observationEndedAt',
    ),
    observedBuildCount: readCount(
      evidence.observedBuildCount,
      'observedBuildCount',
    ),
    observedInstallCount: readCount(
      evidence.observedInstallCount,
      'observedInstallCount',
    ),
    stepOutcomes: {
      completed: readCount(stepOutcomes.completed, 'stepOutcomes.completed'),
      failed: readCount(stepOutcomes.failed, 'stepOutcomes.failed'),
      aborted: readCount(stepOutcomes.aborted, 'stepOutcomes.aborted'),
    },
    workerLifecycle: {
      crashed: readCount(workerLifecycle.crashed, 'workerLifecycle.crashed'),
      restartSucceeded: readCount(
        workerLifecycle.restartSucceeded,
        'workerLifecycle.restartSucceeded',
      ),
      restartSpawnFailed: readCount(
        workerLifecycle.restartSpawnFailed,
        'workerLifecycle.restartSpawnFailed',
      ),
      restartBudgetExhausted: readCount(
        workerLifecycle.restartBudgetExhausted,
        'workerLifecycle.restartBudgetExhausted',
      ),
    },
    circuitBreakerOpened: readCount(
      evidence.circuitBreakerOpened,
      'circuitBreakerOpened',
    ),
    qualityGates: {
      happySmokePassed: readBoolean(
        qualityGates.happySmokePassed,
        'qualityGates.happySmokePassed',
      ),
      faultSmokePassed: readBoolean(
        qualityGates.faultSmokePassed,
        'qualityGates.faultSmokePassed',
      ),
      contentFreeTelemetryAuditPassed: readBoolean(
        qualityGates.contentFreeTelemetryAuditPassed,
        'qualityGates.contentFreeTelemetryAuditPassed',
      ),
      noPostDispatchReplayAuditPassed: readBoolean(
        qualityGates.noPostDispatchReplayAuditPassed,
        'qualityGates.noPostDispatchReplayAuditPassed',
      ),
    },
  };
}

export function evaluateIsolatedAgentRuntimePromotionReadiness(
  evidence: IsolatedAgentRuntimePromotionEvidence,
  options: {
    now?: Date;
  } = {},
): IsolatedAgentRuntimePromotionReadiness {
  const thresholds = ISOLATED_AGENT_RUNTIME_PROMOTION_THRESHOLDS;
  const observationStartedAt = parseIsoTimestamp(evidence.observationStartedAt);
  const observationEndedAt = parseIsoTimestamp(evidence.observationEndedAt);
  const now = (options.now ?? new Date()).getTime();
  const validObservationWindow =
    Number.isFinite(observationStartedAt) &&
    Number.isFinite(observationEndedAt) &&
    observationEndedAt > observationStartedAt;
  const evidenceNotFromFuture =
    Number.isFinite(observationEndedAt) &&
    observationEndedAt <= now + 5 * 60_000;
  const evidenceAgeHours = Number.isFinite(observationEndedAt)
    ? Math.max(0, (now - observationEndedAt) / (60 * 60_000))
    : Number.POSITIVE_INFINITY;
  const observationHours = validObservationWindow
    ? (observationEndedAt - observationStartedAt) / (60 * 60_000)
    : 0;
  const finishedStepCount =
    evidence.stepOutcomes.completed +
    evidence.stepOutcomes.failed +
    evidence.stepOutcomes.aborted;
  const nonAbortedStepCount =
    evidence.stepOutcomes.completed + evidence.stepOutcomes.failed;
  const failureRate = calculateRate(
    evidence.stepOutcomes.failed,
    nonAbortedStepCount,
  );
  const abortRate = calculateRate(
    evidence.stepOutcomes.aborted,
    finishedStepCount,
  );
  const workerCrashRate = calculateRate(
    evidence.workerLifecycle.crashed,
    finishedStepCount,
  );
  const circuitBreakerOpenRate = calculateRate(
    evidence.circuitBreakerOpened,
    finishedStepCount,
  );

  const checks: IsolatedAgentRuntimePromotionCheck[] = [
    check(
      'valid-observation-window',
      validObservationWindow,
      `${evidence.observationStartedAt}..${evidence.observationEndedAt}`,
      'valid increasing ISO-8601 window',
    ),
    check(
      'evidence-not-from-future',
      evidenceNotFromFuture,
      evidence.observationEndedAt,
      'not more than 5 minutes in the future',
    ),
    check(
      'maximum-evidence-age-hours',
      evidenceAgeHours <= thresholds.maximumEvidenceAgeHours,
      evidenceAgeHours,
      thresholds.maximumEvidenceAgeHours,
    ),
    check(
      'minimum-observation-hours',
      observationHours >= thresholds.minimumObservationHours,
      observationHours,
      thresholds.minimumObservationHours,
    ),
    check(
      'minimum-observed-builds',
      evidence.observedBuildCount >= thresholds.minimumObservedBuildCount,
      evidence.observedBuildCount,
      thresholds.minimumObservedBuildCount,
    ),
    check(
      'minimum-observed-installs',
      evidence.observedInstallCount >= thresholds.minimumObservedInstallCount,
      evidence.observedInstallCount,
      thresholds.minimumObservedInstallCount,
    ),
    check(
      'minimum-finished-steps',
      finishedStepCount >= thresholds.minimumFinishedStepCount,
      finishedStepCount,
      thresholds.minimumFinishedStepCount,
    ),
    check(
      'maximum-failure-rate',
      failureRate <= thresholds.maximumFailureRate,
      failureRate,
      thresholds.maximumFailureRate,
    ),
    check(
      'maximum-abort-rate',
      abortRate <= thresholds.maximumAbortRate,
      abortRate,
      thresholds.maximumAbortRate,
    ),
    check(
      'maximum-worker-crash-rate',
      workerCrashRate <= thresholds.maximumWorkerCrashRate,
      workerCrashRate,
      thresholds.maximumWorkerCrashRate,
    ),
    check(
      'all-crashes-recovered',
      evidence.workerLifecycle.restartSucceeded ===
        evidence.workerLifecycle.crashed,
      `${evidence.workerLifecycle.restartSucceeded}/${evidence.workerLifecycle.crashed}`,
      'one successful recovery per crash',
    ),
    check(
      'no-restart-spawn-failures',
      evidence.workerLifecycle.restartSpawnFailed === 0,
      evidence.workerLifecycle.restartSpawnFailed,
      0,
    ),
    check(
      'no-restart-budget-exhaustion',
      evidence.workerLifecycle.restartBudgetExhausted === 0,
      evidence.workerLifecycle.restartBudgetExhausted,
      0,
    ),
    check(
      'maximum-circuit-breaker-open-rate',
      circuitBreakerOpenRate <= thresholds.maximumCircuitBreakerOpenRate,
      circuitBreakerOpenRate,
      thresholds.maximumCircuitBreakerOpenRate,
    ),
    check(
      'happy-smoke-passed',
      evidence.qualityGates.happySmokePassed,
      evidence.qualityGates.happySmokePassed,
      true,
    ),
    check(
      'fault-smoke-passed',
      evidence.qualityGates.faultSmokePassed,
      evidence.qualityGates.faultSmokePassed,
      true,
    ),
    check(
      'content-free-telemetry-audit-passed',
      evidence.qualityGates.contentFreeTelemetryAuditPassed,
      evidence.qualityGates.contentFreeTelemetryAuditPassed,
      true,
    ),
    check(
      'no-post-dispatch-replay-audit-passed',
      evidence.qualityGates.noPostDispatchReplayAuditPassed,
      evidence.qualityGates.noPostDispatchReplayAuditPassed,
      true,
    ),
  ];

  return {
    ready: checks.every((item) => item.passed),
    checks,
    metrics: {
      observationHours,
      evidenceAgeHours,
      finishedStepCount,
      failureRate,
      abortRate,
      workerCrashRate,
      circuitBreakerOpenRate,
    },
  };
}

export function isStablePromotionPolicyArmed(
  policy: IsolatedAgentRuntimeRolloutPolicy,
): boolean {
  return !policy.defaultEnabled && policy.rolloutStage === 'next';
}

function calculateRate(count: number, total: number): number {
  if (total === 0) return count === 0 ? 0 : 1;
  return count / total;
}

function parseIsoTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return Number.NaN;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : Number.NaN;
}

function check(
  id: IsolatedAgentRuntimePromotionCheckId,
  passed: boolean,
  actual: string | number | boolean,
  required: string | number | boolean,
): IsolatedAgentRuntimePromotionCheck {
  return {
    id,
    passed,
    actual,
    required,
  };
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `${path} contains unsupported fields: ${unexpected.join(', ')}`,
    );
  }
}

function readCount(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function readLiteral<T extends string | number>(
  value: unknown,
  expected: T,
  path: string,
): T {
  if (value !== expected) {
    throw new Error(`${path} must equal ${JSON.stringify(expected)}`);
  }
  return expected;
}
