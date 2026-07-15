import { createHash } from 'node:crypto';

const STOP_CONDITIONS = [
  {
    counter: 'uniqueInstallations',
    maximum: 5,
    reason: 'canary-installation-scope-exceeded',
  },
  {
    counter: 'signatureTrustFailures',
    maximum: 0,
    reason: 'signature-trust-failure',
  },
  {
    counter: 'guardianBypassIncidents',
    maximum: 0,
    reason: 'guardian-bypass',
  },
  {
    counter: 'egressUnexpectedAllows',
    maximum: 0,
    reason: 'unexpected-egress-allow',
  },
  {
    counter: 'egressMissingPrompts',
    maximum: 0,
    reason: 'missing-egress-prompt',
  },
  {
    counter: 'dataLossIncidents',
    maximum: 0,
    reason: 'data-loss',
  },
  { counter: 'crashLoops', maximum: 0, reason: 'crash-loop' },
  { counter: 'crashes', maximum: 0, reason: 'crash' },
  { counter: 'launchFailures', maximum: 0, reason: 'launch-failure' },
  {
    counter: 'recoveryFailures',
    maximum: 0,
    reason: 'recovery-failure',
  },
  { counter: 'authFailures', maximum: 0, reason: 'auth-failure' },
];

export const CANARY_OBSERVATION_POLICY = deepFreeze({
  counterNames: [
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
  ],
  counterMinimums: {
    authAttempts: 5,
    egressPromptAttempts: 5,
    launchAttempts: 10,
    recoveryAttempts: 5,
    uniqueInstallations: 5,
  },
  counterRelationships: [
    { atMost: 'authAttempts', counter: 'authFailures' },
    { atMost: 'launchAttempts', counter: 'launchFailures' },
    { atMost: 'recoveryAttempts', counter: 'recoveryFailures' },
    { atMost: 'egressPromptAttempts', counter: 'egressMissingPrompts' },
  ],
  id: 'clodex.release.canary-5-observation.v1',
  orderedStopReasons: STOP_CONDITIONS.map(({ reason }) => reason),
  stopConditions: STOP_CONDITIONS,
  targetObservationHours: 24,
});

export const CANARY_OBSERVATION_POLICY_ID = CANARY_OBSERVATION_POLICY.id;
export const CANARY_OBSERVATION_COUNTER_NAMES =
  CANARY_OBSERVATION_POLICY.counterNames;
export const CANARY_OBSERVATION_STOP_REASONS =
  CANARY_OBSERVATION_POLICY.orderedStopReasons;

export const CANARY_OBSERVATION_POLICY_SHA256 = createHash('sha256')
  .update(canonicalJson(CANARY_OBSERVATION_POLICY))
  .digest('hex');

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze(value) {
  if (isObject(value) || Array.isArray(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseCanonicalInstant(value, label) {
  if (typeof value !== 'string') fail(`${label} is invalid`);
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    fail(`${label} must be a canonical UTC instant`);
  }
  return timestamp.getTime();
}

function hasExactKeys(value, expectedKeys) {
  return (
    isObject(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expectedKeys].sort())
  );
}

export function assertCanaryObservationCounters(value) {
  const policy = CANARY_OBSERVATION_POLICY;
  if (!hasExactKeys(value, policy.counterNames)) {
    fail('canary observation counters must contain the exact aggregate set');
  }
  for (const name of policy.counterNames) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 0) {
      fail(`canary observation counter is invalid: ${name}`);
    }
  }
  for (const relationship of policy.counterRelationships) {
    if (value[relationship.counter] > value[relationship.atMost]) {
      fail('canary observation counters are internally inconsistent');
    }
  }
}

export function computeCanaryObservedHours(startedAt, endedAt) {
  const startedAtMs = parseCanonicalInstant(
    startedAt,
    'canary observation startedAt',
  );
  const endedAtMs = parseCanonicalInstant(
    endedAt,
    'canary observation endedAt',
  );
  if (endedAtMs < startedAtMs) {
    fail('canary observation ended before it started');
  }
  return (endedAtMs - startedAtMs) / (60 * 60 * 1000);
}

export function computeCanaryStopReasons(counters) {
  assertCanaryObservationCounters(counters);
  const reasons = [];
  for (const condition of CANARY_OBSERVATION_POLICY.stopConditions) {
    if (counters[condition.counter] > condition.maximum) {
      reasons.push(condition.reason);
    }
  }
  return reasons;
}

/**
 * Evaluates only the content-free aggregate policy. A satisfied result is not
 * a release authorization and deliberately does not change any stable gate.
 */
export function evaluateCanaryObservationPolicy({
  counters,
  endedAt,
  startedAt,
}) {
  assertCanaryObservationCounters(counters);
  const observedHours = computeCanaryObservedHours(startedAt, endedAt);
  const stopReasons = computeCanaryStopReasons(counters);
  const minimums = CANARY_OBSERVATION_POLICY.counterMinimums;
  return {
    observedHours,
    policySatisfied:
      observedHours >= CANARY_OBSERVATION_POLICY.targetObservationHours &&
      stopReasons.length === 0 &&
      counters.uniqueInstallations === minimums.uniqueInstallations &&
      counters.launchAttempts >= minimums.launchAttempts &&
      counters.authAttempts >= minimums.authAttempts &&
      counters.egressPromptAttempts >= minimums.egressPromptAttempts &&
      counters.recoveryAttempts >= minimums.recoveryAttempts,
    stopReasons,
  };
}
