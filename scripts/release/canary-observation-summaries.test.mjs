import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assembleCanaryObservationEvidenceBundle,
  assembleCanaryObservationReceipt,
  validateCanaryObservationEvidenceBundle,
} from './assemble-canary-observation-receipt.mjs';
import { canaryObservationBindings } from './canary-observation-receipt.mjs';
import {
  CANARY_DISTRIBUTION_COUNTER_NAMES,
  CANARY_HEALTH_COUNTER_NAMES,
  canonicalCanaryArtifactBytes,
  parseCanonicalCanarySummaryBytes,
  validateCanaryDistributionSummary,
  validateCanaryHealthSummary,
} from './canary-observation-summaries.mjs';
import {
  CANARY_FIXTURE_NOW,
  canaryDistributionSummary,
  canaryExpectedProducers,
  canaryHealthSummary,
  canaryObservationEvidenceBundle,
  canaryReceiptProducer,
  canaryVerifiedAttestations,
} from './canary-observation-test-fixtures.mjs';
import { verifyCanaryObservationEvidenceBundle } from './verify-canary-observation.mjs';
import { verifyTrustedCanaryObservationSubjects } from './verify-release-promotion.mjs';

test('strict summary schemas partition every content-free policy counter', () => {
  assert.doesNotThrow(() =>
    validateCanaryDistributionSummary(canaryDistributionSummary(), {
      now: CANARY_FIXTURE_NOW,
    }),
  );
  assert.doesNotThrow(() =>
    validateCanaryHealthSummary(canaryHealthSummary(), {
      now: CANARY_FIXTURE_NOW,
    }),
  );
  assert.deepEqual(CANARY_DISTRIBUTION_COUNTER_NAMES, [
    'signatureTrustFailures',
    'uniqueInstallations',
  ]);
  assert.equal(CANARY_HEALTH_COUNTER_NAMES.length, 13);

  const serialized = JSON.stringify({
    distribution: canaryDistributionSummary(),
    health: canaryHealthSummary(),
  });
  for (const forbidden of [
    'distinctId',
    'installationId',
    'machineId',
    'prompt',
    'traceId',
    'workspaceId',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, 'u'));
  }
});

test('published JSON schemas are closed and match the validator counter sets', () => {
  const distributionSchema = JSON.parse(
    readFileSync(
      new URL(
        'schemas/content-free-canary-distribution-summary-v1.schema.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const healthSchema = JSON.parse(
    readFileSync(
      new URL(
        'schemas/content-free-canary-health-summary-v1.schema.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.equal(distributionSchema.additionalProperties, false);
  assert.equal(healthSchema.additionalProperties, false);
  assert.deepEqual(
    distributionSchema.properties.observation.properties.counters.required.sort(),
    [...CANARY_DISTRIBUTION_COUNTER_NAMES].sort(),
  );
  assert.deepEqual(
    healthSchema.properties.observation.properties.counters.required.sort(),
    [...CANARY_HEALTH_COUNTER_NAMES].sort(),
  );
});

test('synthetic conformance vectors are canonical and assemble cleanly', () => {
  const distributionBytes = readFileSync(
    new URL(
      'fixtures/canary-observation-v1/distribution-summary.json',
      import.meta.url,
    ),
  );
  const healthBytes = readFileSync(
    new URL(
      'fixtures/canary-observation-v1/health-summary.json',
      import.meta.url,
    ),
  );
  assert.doesNotThrow(() =>
    parseCanonicalCanarySummaryBytes(distributionBytes, {
      now: CANARY_FIXTURE_NOW,
    }),
  );
  assert.doesNotThrow(() =>
    parseCanonicalCanarySummaryBytes(healthBytes, {
      now: CANARY_FIXTURE_NOW,
    }),
  );
  const receipt = assembleCanaryObservationReceipt(
    { distributionBytes, healthBytes, producer: canaryReceiptProducer() },
    { now: CANARY_FIXTURE_NOW },
  );
  assert.equal(receipt.observation.observedHours, 24);
  assert.deepEqual(receipt.observation.stopReasons, []);
});

test('summary bytes must be exact canonical UTF-8 JSON', () => {
  const summary = canaryDistributionSummary();
  const canonical = canonicalCanaryArtifactBytes(summary);
  const parsed = parseCanonicalCanarySummaryBytes(canonical, {
    kind: summary.artifactKind,
    now: CANARY_FIXTURE_NOW,
  });
  assert.equal(parsed.value.artifactKind, summary.artifactKind);
  assert.match(parsed.sha256, /^[a-f0-9]{64}$/u);

  assert.throws(
    () =>
      parseCanonicalCanarySummaryBytes(
        Buffer.from(`${JSON.stringify(summary, null, 2)}\n`),
        { now: CANARY_FIXTURE_NOW },
      ),
    /not canonical JSON/u,
  );
  assert.throws(
    () =>
      parseCanonicalCanarySummaryBytes(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]),
        { now: CANARY_FIXTURE_NOW },
      ),
    /BOM/u,
  );
});

test('deterministically assembles one receipt from the two exact subjects', () => {
  const input = {
    distributionBytes: canonicalCanaryArtifactBytes(
      canaryDistributionSummary(),
    ),
    healthBytes: canonicalCanaryArtifactBytes(canaryHealthSummary()),
    producer: canaryReceiptProducer(),
  };
  const first = assembleCanaryObservationReceipt(input, {
    now: CANARY_FIXTURE_NOW,
  });
  const second = assembleCanaryObservationReceipt(input, {
    now: CANARY_FIXTURE_NOW,
  });
  assert.deepEqual(first, second);
  assert.equal(first.generatedAt, '2026-07-14T00:31:30.000Z');
  assert.equal(first.observation.counters.uniqueInstallations, 5);
  assert.equal(first.observation.counters.launchAttempts, 10);
  assert.equal(first.observation.observedHours, 24);
  assert.deepEqual(first.observation.stopReasons, []);

  const bundle = assembleCanaryObservationEvidenceBundle(input, {
    now: CANARY_FIXTURE_NOW,
  });
  const validated = validateCanaryObservationEvidenceBundle(bundle, {
    now: CANARY_FIXTURE_NOW,
  });
  assert.equal(validated.policy.policySatisfied, true);
  assert.equal(
    bundle.receipt.value.evidence.distribution.sha256,
    bundle.distribution.sha256,
  );
  assert.equal(
    bundle.receipt.value.evidence.telemetry.sha256,
    bundle.health.sha256,
  );
});

test('assembler rejects binding drift and non-identical windows', () => {
  const distribution = canaryDistributionSummary();
  const health = canaryHealthSummary();
  health.manifest.sha256 = 'f'.repeat(64);
  assert.throws(
    () =>
      assembleCanaryObservationReceipt(
        {
          distributionBytes: canonicalCanaryArtifactBytes(distribution),
          healthBytes: canonicalCanaryArtifactBytes(health),
          producer: canaryReceiptProducer(),
        },
        { now: CANARY_FIXTURE_NOW },
      ),
    /manifest bindings differ/u,
  );

  const differentWindow = canaryHealthSummary();
  differentWindow.observation.startedAt = '2026-07-13T00:31:00.000Z';
  assert.throws(
    () =>
      assembleCanaryObservationReceipt(
        {
          distributionBytes: canonicalCanaryArtifactBytes(distribution),
          healthBytes: canonicalCanaryArtifactBytes(differentWindow),
          producer: canaryReceiptProducer(),
        },
        { now: CANARY_FIXTURE_NOW },
      ),
    /observation windows differ/u,
  );
});

test('summary schemas reject raw identifiers and incomplete counter sets', () => {
  const raw = canaryHealthSummary();
  raw.observation.distinctId = 'not-allowed';
  assert.throws(
    () => validateCanaryHealthSummary(raw, { now: CANARY_FIXTURE_NOW }),
    /missing or unsupported fields/u,
  );

  const missing = canaryDistributionSummary();
  delete missing.observation.counters.uniqueInstallations;
  assert.throws(
    () =>
      validateCanaryDistributionSummary(missing, { now: CANARY_FIXTURE_NOW }),
    /counters contains missing or unsupported fields/u,
  );
});

test('nested verifier binds all three exact subjects to verified producers', () => {
  const bundle = canaryObservationEvidenceBundle();
  const verified = verifyCanaryObservationEvidenceBundle(bundle, {
    expected: canaryObservationBindings(bundle.receipt.value, {
      now: CANARY_FIXTURE_NOW,
    }),
    expectedProducers: canaryExpectedProducers(),
    now: CANARY_FIXTURE_NOW,
    verifiedAttestations: canaryVerifiedAttestations(bundle),
  });
  assert.equal(verified.policy.policySatisfied, true);

  const forged = canaryVerifiedAttestations(bundle);
  forged.health.subjectSha256 = 'f'.repeat(64);
  assert.throws(
    () =>
      verifyCanaryObservationEvidenceBundle(bundle, {
        expected: canaryObservationBindings(bundle.receipt.value, {
          now: CANARY_FIXTURE_NOW,
        }),
        expectedProducers: canaryExpectedProducers(),
        now: CANARY_FIXTURE_NOW,
        verifiedAttestations: forged,
      }),
    /does not bind the exact producer and subject/u,
  );

  const unauthorized = canaryExpectedProducers();
  unauthorized.distribution.runId += 1;
  assert.throws(
    () =>
      verifyCanaryObservationEvidenceBundle(bundle, {
        expected: canaryObservationBindings(bundle.receipt.value, {
          now: CANARY_FIXTURE_NOW,
        }),
        expectedProducers: unauthorized,
        now: CANARY_FIXTURE_NOW,
        verifiedAttestations: canaryVerifiedAttestations(bundle),
      }),
    /not authorized by the expected binding/u,
  );
});

test('promotion wiring reconstructs and verifies every nested subject', async () => {
  const bundle = canaryObservationEvidenceBundle();
  const calls = [];
  const result = await verifyTrustedCanaryObservationSubjects(
    {
      canary: { observationEvidence: bundle },
      status: 'ready-for-stable',
    },
    {
      expectedProducers: canaryExpectedProducers(),
      now: CANARY_FIXTURE_NOW,
      verifyAttestationImpl: (filePath, binding) => {
        const bytes = readFileSync(filePath);
        assert.equal(bytes.at(-1), 0x0a);
        calls.push({ binding, filePath });
      },
    },
  );
  assert.equal(result.policy.policySatisfied, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((entry) => entry.binding.repository),
    [
      'example-org/clodex-distribution-evidence',
      'example-org/clodex-health-evidence',
      'mereyabdenbekuly-ctrl/clodex-ide',
    ],
  );

  await assert.rejects(
    verifyTrustedCanaryObservationSubjects(
      {
        canary: { observationEvidence: bundle },
        status: 'ready-for-stable',
      },
      { now: CANARY_FIXTURE_NOW, verifyAttestationImpl: () => undefined },
    ),
    /producer policy is not configured/u,
  );
});
