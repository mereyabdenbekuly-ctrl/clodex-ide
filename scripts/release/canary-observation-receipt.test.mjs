import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANARY_OBSERVATION_COUNTER_NAMES,
  CANARY_OBSERVATION_POLICY,
  CANARY_OBSERVATION_POLICY_SHA256,
  CANARY_OBSERVATION_STOP_REASONS,
  evaluateCanaryObservationPolicy,
} from './canary-observation-policy.mjs';
import {
  CANARY_DISTRIBUTION_SUMMARY_KIND,
  CANARY_HEALTH_SUMMARY_KIND,
  CANARY_OBSERVATION_CLOSURE_GRACE_MS,
  CANARY_OBSERVATION_MAX_AGE_MS,
  canaryObservationBindings,
  createCanaryObservationReceipt,
  validateCanaryObservationReceipt,
} from './canary-observation-receipt.mjs';
import { verifyCanaryObservationReceipt } from './verify-canary-observation.mjs';

const RELEASE_COMMIT = '1'.repeat(40);
const PRODUCER_COMMIT = '2'.repeat(40);
const MANIFEST_SHA256 = '3'.repeat(64);
const PUBLICATION_SHA256 = '4'.repeat(64);
const DISTRIBUTION_SHA256 = '5'.repeat(64);
const HEALTH_SHA256 = '6'.repeat(64);
const NOW = new Date('2026-07-15T00:00:00.000Z');

function passingCounters() {
  return {
    authAttempts: 5,
    authFailures: 0,
    crashLoops: 0,
    crashes: 0,
    dataLossIncidents: 0,
    egressMissingPrompts: 0,
    egressPromptAttempts: 5,
    egressUnexpectedAllows: 0,
    guardianBypassIncidents: 0,
    launchAttempts: 10,
    launchFailures: 0,
    recoveryAttempts: 5,
    recoveryFailures: 0,
    signatureTrustFailures: 0,
    uniqueInstallations: 5,
  };
}

function input() {
  return {
    evidence: {
      distribution: {
        artifactKind: CANARY_DISTRIBUTION_SUMMARY_KIND,
        sha256: DISTRIBUTION_SHA256,
      },
      telemetry: {
        artifactKind: CANARY_HEALTH_SUMMARY_KIND,
        sha256: HEALTH_SHA256,
      },
    },
    generatedAt: '2026-07-14T00:32:00.000Z',
    manifest: {
      path: '.release-notes/clodex-technical-preview.json',
      sha256: MANIFEST_SHA256,
      sourceCommit: RELEASE_COMMIT,
    },
    observation: {
      counters: passingCounters(),
      distributionClosedAt: '2026-07-14T00:31:00.000Z',
      endedAt: '2026-07-14T00:30:00.000Z',
      startedAt: '2026-07-13T00:30:00.000Z',
    },
    producer: {
      repository: 'mereyabdenbekuly-ctrl/clodex-ide',
      runAttempt: 1,
      runId: 12345,
      sourceCommit: PRODUCER_COMMIT,
      sourceRef: 'refs/heads/main',
      workflow:
        'mereyabdenbekuly-ctrl/clodex-ide/.github/workflows/release-canary-observation.yml',
      workflowCommit: PRODUCER_COMMIT,
    },
    publication: {
      createdAt: '2026-07-13T00:00:00.000Z',
      releaseId: 77,
      reportAssetId: 101,
      reportFileName: 'clodex-release-publication.json',
      reportSha256: PUBLICATION_SHA256,
      repository: 'mereyabdenbekuly-ctrl/clodex-ide',
      sourceCommit: RELEASE_COMMIT,
      state: 'draft',
      tag: 'v1.16.0-preview.3',
    },
    release: {
      channel: 'preview',
      promotionRole: 'canary',
      sourceCommit: RELEASE_COMMIT,
      tag: 'v1.16.0-preview.3',
      version: '1.16.0-preview.3',
    },
    source: {
      commit: RELEASE_COMMIT,
      ref: 'refs/heads/main',
      repository: 'mereyabdenbekuly-ctrl/clodex-ide',
    },
  };
}

function receipt() {
  return createCanaryObservationReceipt(input(), { now: NOW });
}

test('freezes a digest-bound exactly-five aggregate policy', () => {
  const digestBeforeMutationAttempts = CANARY_OBSERVATION_POLICY_SHA256;
  assert.equal(CANARY_OBSERVATION_POLICY.targetObservationHours, 24);
  assert.equal(
    CANARY_OBSERVATION_POLICY.counterMinimums.uniqueInstallations,
    5,
  );
  assert.equal(
    CANARY_OBSERVATION_POLICY_SHA256,
    '369d562782952b2181c411825de206e5e6c00c13ae3d26186c9f9785e11d9d75',
  );
  assert.equal(Object.isFrozen(CANARY_OBSERVATION_POLICY), true);
  assert.equal(
    Object.isFrozen(CANARY_OBSERVATION_POLICY.counterMinimums),
    true,
  );
  assert.equal(Object.isFrozen(CANARY_OBSERVATION_COUNTER_NAMES), true);
  assert.equal(Object.isFrozen(CANARY_OBSERVATION_STOP_REASONS), true);
  assert.deepEqual(
    CANARY_OBSERVATION_POLICY.counterNames,
    CANARY_OBSERVATION_COUNTER_NAMES,
  );
  assert.deepEqual(
    CANARY_OBSERVATION_POLICY.orderedStopReasons,
    CANARY_OBSERVATION_STOP_REASONS,
  );
  assert.throws(
    () => CANARY_OBSERVATION_COUNTER_NAMES.push('contentBearingCounter'),
    TypeError,
  );
  assert.throws(
    () => CANARY_OBSERVATION_STOP_REASONS.push('caller-authored-stop'),
    TypeError,
  );
  assert.throws(() => {
    CANARY_OBSERVATION_POLICY.stopConditions[0].maximum = 6;
  }, TypeError);
  assert.equal(CANARY_OBSERVATION_POLICY_SHA256, digestBeforeMutationAttempts);
});

test('creates and verifies a closed content-free receipt with derived fields', () => {
  const value = receipt();
  assert.equal(value.observation.observedHours, 24);
  assert.deepEqual(value.observation.stopReasons, []);
  assert.equal(Object.hasOwn(value, 'status'), false);
  assert.doesNotMatch(JSON.stringify(value), /ready-for-stable/u);

  const verified = verifyCanaryObservationReceipt(value, {
    expected: canaryObservationBindings(value, { now: NOW }),
    now: NOW,
  });
  assert.equal(verified.policySatisfied, true);
  assert.equal(verified.observedHours, 24);
  assert.deepEqual(verified.stopReasons, []);
});

test('keeps incomplete clean aggregates non-authorizing without inventing stops', () => {
  const value = input();
  value.observation.counters.launchAttempts = 9;
  const created = createCanaryObservationReceipt(value, { now: NOW });
  const validated = validateCanaryObservationReceipt(created, { now: NOW });
  assert.equal(validated.policySatisfied, false);
  assert.deepEqual(validated.stopReasons, []);
});

test('derives deterministic stop reasons from the complete counter set', () => {
  const value = input();
  Object.assign(value.observation.counters, {
    authFailures: 1,
    egressUnexpectedAllows: 1,
    guardianBypassIncidents: 1,
    signatureTrustFailures: 1,
    uniqueInstallations: 6,
  });
  const created = createCanaryObservationReceipt(value, { now: NOW });
  assert.deepEqual(created.observation.stopReasons, [
    'canary-installation-scope-exceeded',
    'signature-trust-failure',
    'guardian-bypass',
    'unexpected-egress-allow',
    'auth-failure',
  ]);
  assert.equal(
    validateCanaryObservationReceipt(created, { now: NOW }).policySatisfied,
    false,
  );
});

test('rejects caller-authored observed hours or stop reasons', () => {
  const hours = receipt();
  hours.observation.observedHours = 25;
  assert.throws(
    () => validateCanaryObservationReceipt(hours, { now: NOW }),
    /observedHours was not derived/u,
  );

  const reasons = receipt();
  reasons.observation.stopReasons = ['auth-failure'];
  assert.throws(
    () => validateCanaryObservationReceipt(reasons, { now: NOW }),
    /stopReasons were not derived/u,
  );
});

test('positive exact schemas reject raw, metadata, and per-installation fields', () => {
  const raw = input();
  raw.observation.rawLogs = ['must-not-enter-receipt'];
  assert.throws(
    () => createCanaryObservationReceipt(raw, { now: NOW }),
    /missing or unsupported fields/u,
  );

  const installations = input();
  installations.installations = [{ id: 'installation-1' }];
  assert.throws(
    () => createCanaryObservationReceipt(installations, { now: NOW }),
    /missing or unsupported fields/u,
  );

  const metadata = receipt();
  metadata.metadata = { note: 'free-form data' };
  assert.throws(
    () => validateCanaryObservationReceipt(metadata, { now: NOW }),
    /missing or unsupported fields/u,
  );
});

test('receipt and expected-binding schemas reject content-bearing identifiers', () => {
  const fields = [
    'distinctId',
    'machineId',
    'traceId',
    'agentId',
    'workspaceId',
    'prompt',
    'message',
    'toolInput',
    'toolOutput',
  ];
  for (const field of fields) {
    const withReceiptField = receipt();
    withReceiptField.observation[field] = 'content-is-not-allowed';
    assert.throws(
      () => validateCanaryObservationReceipt(withReceiptField, { now: NOW }),
      /observation contains missing or unsupported fields/u,
    );

    const value = receipt();
    const expected = canaryObservationBindings(value, { now: NOW });
    expected.source[field] = 'content-is-not-allowed';
    assert.throws(
      () => verifyCanaryObservationReceipt(value, { expected, now: NOW }),
      /source binding contains missing or unsupported fields/u,
    );
  }
});

test('requires all aggregate counters and rejects inconsistent aggregates', () => {
  const missing = input();
  delete missing.observation.counters.recoveryAttempts;
  assert.throws(
    () => createCanaryObservationReceipt(missing, { now: NOW }),
    /exact aggregate set/u,
  );

  const inconsistent = input();
  inconsistent.observation.counters.authAttempts = 0;
  inconsistent.observation.counters.authFailures = 1;
  assert.throws(
    () => createCanaryObservationReceipt(inconsistent, { now: NOW }),
    /internally inconsistent/u,
  );
});

test('fails closed on exact source, manifest, release, and publication drift', () => {
  const value = receipt();
  const cases = [
    [
      'source',
      (expected) => {
        const commit = 'a'.repeat(40);
        expected.source.commit = commit;
        expected.manifest.sourceCommit = commit;
        expected.release.sourceCommit = commit;
        expected.publication.sourceCommit = commit;
      },
    ],
    ['manifest', (expected) => (expected.manifest.sha256 = 'b'.repeat(64))],
    [
      'release',
      (expected) => {
        expected.release.tag = 'v1.16.0-preview.4';
        expected.release.version = '1.16.0-preview.4';
        expected.publication.tag = 'v1.16.0-preview.4';
      },
    ],
    ['publication', (expected) => (expected.publication.releaseId = 78)],
  ];
  for (const [label, mutate] of cases) {
    const expected = structuredClone(
      canaryObservationBindings(value, { now: NOW }),
    );
    mutate(expected);
    assert.throws(
      () => verifyCanaryObservationReceipt(value, { expected, now: NOW }),
      new RegExp(`${label} does not match the expected binding`, 'u'),
    );
  }
});

test('binds the exact producer run and aggregate evidence digests', () => {
  const value = receipt();
  const producer = structuredClone(
    canaryObservationBindings(value, { now: NOW }),
  );
  producer.producer.runAttempt = 2;
  assert.throws(
    () =>
      verifyCanaryObservationReceipt(value, { expected: producer, now: NOW }),
    /producer does not match the expected binding/u,
  );

  const evidence = structuredClone(
    canaryObservationBindings(value, { now: NOW }),
  );
  evidence.evidence.telemetry.sha256 = 'f'.repeat(64);
  assert.throws(
    () =>
      verifyCanaryObservationReceipt(value, { expected: evidence, now: NOW }),
    /evidence does not match the expected binding/u,
  );
});

test('rejects pre-publication, open, and future observation windows', () => {
  const beforePublication = input();
  beforePublication.observation.startedAt = '2026-07-12T23:59:59.000Z';
  assert.throws(
    () => createCanaryObservationReceipt(beforePublication, { now: NOW }),
    /started before the bound publication existed/u,
  );

  const notClosed = input();
  notClosed.observation.distributionClosedAt = '2026-07-14T00:29:59.000Z';
  assert.throws(
    () => createCanaryObservationReceipt(notClosed, { now: NOW }),
    /closed before observation ended/u,
  );

  const future = input();
  future.observation.endedAt = '2026-07-15T00:00:01.000Z';
  future.observation.distributionClosedAt = '2026-07-15T00:00:01.000Z';
  future.generatedAt = '2026-07-15T00:00:01.000Z';
  assert.throws(
    () => createCanaryObservationReceipt(future, { now: NOW }),
    /observation end is in the future/u,
  );
});

test('rejects receipts older than the mandatory 72-hour freshness window', () => {
  const value = receipt();
  const staleNow = new Date(
    new Date(value.generatedAt).getTime() + CANARY_OBSERVATION_MAX_AGE_MS + 1,
  );
  assert.throws(
    () => validateCanaryObservationReceipt(value, { now: staleNow }),
    /receipt is stale/u,
  );
});

test('rejects a fresh receipt that rewraps a stale observation closure', () => {
  const value = input();
  value.publication.createdAt = '2026-07-09T00:00:00.000Z';
  value.observation.startedAt = '2026-07-10T00:00:00.000Z';
  value.observation.endedAt = '2026-07-11T00:00:00.000Z';
  value.observation.distributionClosedAt = '2026-07-11T00:01:00.000Z';
  value.generatedAt = '2026-07-15T00:00:00.000Z';
  assert.throws(
    () => createCanaryObservationReceipt(value, { now: NOW }),
    /distribution closure is stale/u,
  );
});

test('rejects a fresh closure that rewraps a stale observation end', () => {
  const value = input();
  value.publication.createdAt = '2026-01-01T00:00:00.000Z';
  value.observation.startedAt = '2026-01-01T00:30:00.000Z';
  value.observation.endedAt = '2026-01-02T00:30:00.000Z';
  value.observation.distributionClosedAt = '2026-07-14T23:59:00.000Z';
  value.generatedAt = '2026-07-15T00:00:00.000Z';
  assert.throws(
    () => createCanaryObservationReceipt(value, { now: NOW }),
    /observation end is stale/u,
  );
});

test('rejects a distribution closure outside the five-minute grace', () => {
  const value = input();
  value.observation.distributionClosedAt = '2026-07-14T00:36:00.000Z';
  value.generatedAt = '2026-07-14T00:37:00.000Z';
  assert.equal(CANARY_OBSERVATION_CLOSURE_GRACE_MS, 5 * 60 * 1000);
  assert.throws(
    () => createCanaryObservationReceipt(value, { now: NOW }),
    /closure exceeds the allowed grace period/u,
  );
});

test('the policy evaluator computes fractional hours rather than accepting them', () => {
  const assessment = evaluateCanaryObservationPolicy({
    counters: passingCounters(),
    endedAt: '2026-07-14T00:30:00.000Z',
    startedAt: '2026-07-13T00:00:00.000Z',
  });
  assert.equal(assessment.observedHours, 24.5);
  assert.equal(assessment.policySatisfied, true);

  const oneMillisecondShort = evaluateCanaryObservationPolicy({
    counters: passingCounters(),
    endedAt: '2026-07-13T23:59:59.999Z',
    startedAt: '2026-07-13T00:00:00.000Z',
  });
  assert.equal(oneMillisecondShort.observedHours < 24, true);
  assert.equal(oneMillisecondShort.policySatisfied, false);
});
