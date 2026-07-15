import {
  CANARY_DISTRIBUTION_SUMMARY_KIND,
  CANARY_HEALTH_SUMMARY_KIND,
  validateCanaryObservationBindings,
  validateCanaryObservationReceipt,
  validateCanaryReceiptProducer,
} from './canary-observation-receipt.mjs';
import {
  validateCanaryObservationEvidenceBundle,
  validateCanaryObservationReceiptSubject,
} from './assemble-canary-observation-receipt.mjs';
import {
  canonicalCanaryJson,
  validateCanarySummaryProducer,
  validateVerifiedCanaryAttestation,
  verifyCanarySummaryAttestationBinding,
} from './canary-observation-summaries.mjs';

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  if (
    !isObject(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  ) {
    fail(`${label} contains missing or unsupported fields`);
  }
}

function assertExpectedBindings(expected) {
  if (!isObject(expected)) fail('expected canary bindings are required');
  validateCanaryObservationBindings(expected);
}

function assertExactBinding(actual, expected, label) {
  if (canonicalCanaryJson(actual) !== canonicalCanaryJson(expected)) {
    fail(`canary observation ${label} does not match the expected binding`);
  }
}

function verifyReceiptAttestationBinding(
  subject,
  attestation,
  expectedProducer,
  { now },
) {
  validateCanaryObservationReceiptSubject(subject, { now });
  validateVerifiedCanaryAttestation(attestation);
  validateCanaryReceiptProducer(expectedProducer);
  const producer = subject.value.producer;
  assertExactBinding(producer, expectedProducer, 'receipt producer');
  if (
    attestation.repository !== producer.repository ||
    attestation.signerWorkflow !== producer.workflow ||
    attestation.sourceRef !== producer.sourceRef ||
    attestation.sourceDigest !== producer.sourceCommit ||
    attestation.signerDigest !== producer.workflowCommit ||
    attestation.subjectSha256 !== subject.sha256
  ) {
    fail(
      'verified canary receipt attestation does not bind the exact producer and subject',
    );
  }
  return { attestation, producer, subject };
}

/**
 * Verifies the receipt's internal derivations and exact trusted inputs. This
 * Phase A verifier intentionally does not verify a GitHub attestation and does
 * not replace the stable promotion NOT_READY guard.
 */
export function verifyCanaryObservationReceipt(
  value,
  { expected, now = new Date() } = {},
) {
  assertExpectedBindings(expected);
  const validated = validateCanaryObservationReceipt(value, { now });
  const actual = {
    evidence: validated.receipt.evidence,
    manifest: validated.receipt.manifest,
    producer: validated.receipt.producer,
    publication: validated.receipt.publication,
    release: validated.receipt.release,
    source: validated.receipt.source,
  };
  for (const label of [
    'source',
    'manifest',
    'release',
    'publication',
    'producer',
    'evidence',
  ]) {
    assertExactBinding(actual[label], expected[label], label);
  }
  return validated;
}

/**
 * Binds a self-contained receipt/summary bundle to attestation claims that were
 * already cryptographically verified by the caller. This function never turns
 * caller-authored claims into attestations; promotion code must obtain the
 * claims from a successful external verifier first.
 */
export function verifyCanaryObservationEvidenceBundle(
  value,
  { expected, expectedProducers, now = new Date(), verifiedAttestations } = {},
) {
  assertExpectedBindings(expected);
  assertExactKeys(
    expectedProducers,
    ['distribution', 'health', 'receipt'],
    'expected canary producers',
  );
  validateCanarySummaryProducer(expectedProducers.distribution);
  validateCanarySummaryProducer(expectedProducers.health);
  validateCanaryReceiptProducer(expectedProducers.receipt);
  assertExactKeys(
    verifiedAttestations,
    ['distribution', 'health', 'receipt'],
    'verified canary attestations',
  );

  const validated = validateCanaryObservationEvidenceBundle(value, { now });
  const receipt = verifyCanaryObservationReceipt(value.receipt.value, {
    expected,
    now,
  });
  verifyCanarySummaryAttestationBinding(
    value.distribution,
    verifiedAttestations.distribution,
    {
      expectedProducer: expectedProducers.distribution,
      kind: CANARY_DISTRIBUTION_SUMMARY_KIND,
      now,
    },
  );
  verifyCanarySummaryAttestationBinding(
    value.health,
    verifiedAttestations.health,
    {
      expectedProducer: expectedProducers.health,
      kind: CANARY_HEALTH_SUMMARY_KIND,
      now,
    },
  );
  verifyReceiptAttestationBinding(
    value.receipt,
    verifiedAttestations.receipt,
    expectedProducers.receipt,
    { now },
  );
  return { ...validated, receipt };
}
