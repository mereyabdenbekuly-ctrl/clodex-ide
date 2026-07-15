export const CANARY_OBSERVATION_POLICY_ID: 'clodex.release.canary-5-observation.v1';

export const CANARY_OBSERVATION_COUNTER_NAMES: readonly [
  'authAttempts',
  'authFailures',
  'crashLoops',
  'crashes',
  'dataLossIncidents',
  'egressMissingPrompts',
  'egressPromptAttempts',
  'egressUnexpectedAllows',
  'guardianBypassIncidents',
  'launchAttempts',
  'launchFailures',
  'recoveryAttempts',
  'recoveryFailures',
  'signatureTrustFailures',
  'uniqueInstallations',
];

export const CANARY_OBSERVATION_STOP_REASONS: readonly [
  'canary-installation-scope-exceeded',
  'signature-trust-failure',
  'guardian-bypass',
  'unexpected-egress-allow',
  'missing-egress-prompt',
  'data-loss',
  'crash-loop',
  'crash',
  'launch-failure',
  'recovery-failure',
  'auth-failure',
];

export type CanaryObservationCounterName =
  (typeof CANARY_OBSERVATION_COUNTER_NAMES)[number];
export type CanaryObservationStopReason =
  (typeof CANARY_OBSERVATION_STOP_REASONS)[number];

export interface CanaryObservationCounters {
  authAttempts: number;
  authFailures: number;
  crashLoops: number;
  crashes: number;
  dataLossIncidents: number;
  egressMissingPrompts: number;
  egressPromptAttempts: number;
  egressUnexpectedAllows: number;
  guardianBypassIncidents: number;
  launchAttempts: number;
  launchFailures: number;
  recoveryAttempts: number;
  recoveryFailures: number;
  signatureTrustFailures: number;
  uniqueInstallations: number;
}

export interface CanaryObservationPolicy {
  counterNames: typeof CANARY_OBSERVATION_COUNTER_NAMES;
  counterMinimums: Readonly<
    Partial<Record<CanaryObservationCounterName, number>>
  >;
  counterRelationships: readonly Readonly<{
    atMost: CanaryObservationCounterName;
    counter: CanaryObservationCounterName;
  }>[];
  id: typeof CANARY_OBSERVATION_POLICY_ID;
  orderedStopReasons: typeof CANARY_OBSERVATION_STOP_REASONS;
  stopConditions: readonly Readonly<{
    counter: CanaryObservationCounterName;
    maximum: number;
    reason: CanaryObservationStopReason;
  }>[];
  targetObservationHours: 24;
}

export const CANARY_OBSERVATION_POLICY: Readonly<CanaryObservationPolicy>;
export const CANARY_OBSERVATION_POLICY_SHA256: string;

export interface CanaryObservationPolicyAssessment {
  observedHours: number;
  policySatisfied: boolean;
  stopReasons: CanaryObservationStopReason[];
}

export function assertCanaryObservationCounters(
  value: unknown,
): asserts value is CanaryObservationCounters;

export function computeCanaryObservedHours(
  startedAt: string,
  endedAt: string,
): number;

export function computeCanaryStopReasons(
  counters: CanaryObservationCounters,
): CanaryObservationStopReason[];

export function evaluateCanaryObservationPolicy(input: {
  counters: CanaryObservationCounters;
  endedAt: string;
  startedAt: string;
}): CanaryObservationPolicyAssessment;
