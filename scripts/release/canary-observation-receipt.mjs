import path from 'node:path';
import {
  CANONICAL_REPOSITORY,
  PUBLICATION_REPORT_FILE_NAME,
  TRUSTED_SOURCE_REF,
} from './release-trust-constants.mjs';
import {
  CANARY_OBSERVATION_POLICY_ID,
  CANARY_OBSERVATION_POLICY_SHA256,
  CANARY_OBSERVATION_STOP_REASONS,
  assertCanaryObservationCounters,
  evaluateCanaryObservationPolicy,
} from './canary-observation-policy.mjs';

export const CANARY_OBSERVATION_SCHEMA_VERSION = 1;
export const CANARY_OBSERVATION_RECEIPT_KIND = 'release-canary-observation';
export const CANARY_DISTRIBUTION_SUMMARY_KIND =
  'content-free-canary-distribution-summary-v1';
export const CANARY_HEALTH_SUMMARY_KIND =
  'content-free-canary-health-summary-v1';
export const CANARY_OBSERVATION_MAX_AGE_MS = 72 * 60 * 60 * 1000;
export const CANARY_OBSERVATION_CLOSURE_GRACE_MS = 5 * 60 * 1000;

const CLOCK_SKEW_MS = 5 * 60 * 1000;
const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+-preview\.[1-9]\d*$/u;
const PRODUCER_WORKFLOW = new RegExp(
  `^${CANONICAL_REPOSITORY.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/\\.github/workflows/[A-Za-z0-9_.-]+\\.ya?ml$`,
  'u',
);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertCanaryExactKeys(value, expected, label) {
  assert(isObject(value), `${label} must be an object`);
  assert(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort()),
    `${label} contains missing or unsupported fields`,
  );
}

export function parseCanonicalCanaryInstant(value, label) {
  assert(typeof value === 'string', `${label} is invalid`);
  const instant = new Date(value);
  assert(
    !Number.isNaN(instant.getTime()) && instant.toISOString() === value,
    `${label} must be a canonical UTC instant`,
  );
  return instant.getTime();
}

export function validateCanarySourceBinding(value) {
  assertCanaryExactKeys(
    value,
    ['commit', 'ref', 'repository'],
    'source binding',
  );
  assert(
    value.repository === CANONICAL_REPOSITORY &&
      value.ref === TRUSTED_SOURCE_REF &&
      COMMIT.test(String(value.commit ?? '')),
    'source binding is invalid',
  );
}

export function validateCanaryManifestBinding(value) {
  assertCanaryExactKeys(
    value,
    ['path', 'sha256', 'sourceCommit'],
    'manifest binding',
  );
  assert(
    typeof value.path === 'string' &&
      value.path.length <= 160 &&
      !value.path.includes('\\') &&
      path.posix.normalize(value.path) === value.path &&
      path.posix.dirname(value.path) === '.release-notes' &&
      value.path.startsWith('.release-notes/') &&
      /^[A-Za-z0-9._-]+\.json$/u.test(path.posix.basename(value.path)) &&
      value.path.endsWith('.json') &&
      SHA256.test(String(value.sha256 ?? '')) &&
      COMMIT.test(String(value.sourceCommit ?? '')),
    'manifest binding is invalid',
  );
}

export function validateCanaryReleaseBinding(value) {
  assertCanaryExactKeys(
    value,
    ['channel', 'promotionRole', 'sourceCommit', 'tag', 'version'],
    'release binding',
  );
  assert(
    value.channel === 'preview' &&
      value.promotionRole === 'canary' &&
      String(value.version ?? '').length <= 64 &&
      VERSION.test(String(value.version ?? '')) &&
      value.tag === `v${value.version}` &&
      COMMIT.test(String(value.sourceCommit ?? '')),
    'release binding is invalid',
  );
}

export function validateCanaryPublicationBinding(value) {
  assertCanaryExactKeys(
    value,
    [
      'createdAt',
      'releaseId',
      'reportAssetId',
      'reportFileName',
      'reportSha256',
      'repository',
      'sourceCommit',
      'state',
      'tag',
    ],
    'publication binding',
  );
  parseCanonicalCanaryInstant(value.createdAt, 'publication createdAt');
  assert(
    value.repository === CANONICAL_REPOSITORY &&
      Number.isSafeInteger(value.releaseId) &&
      value.releaseId > 0 &&
      Number.isSafeInteger(value.reportAssetId) &&
      value.reportAssetId > 0 &&
      value.reportFileName === PUBLICATION_REPORT_FILE_NAME &&
      SHA256.test(String(value.reportSha256 ?? '')) &&
      COMMIT.test(String(value.sourceCommit ?? '')) &&
      value.state === 'draft' &&
      typeof value.tag === 'string' &&
      value.tag.length > 0,
    'publication binding is invalid',
  );
}

function validateEvidenceSummary(value, kind, label) {
  assertCanaryExactKeys(value, ['artifactKind', 'sha256'], label);
  assert(
    value.artifactKind === kind && SHA256.test(String(value.sha256 ?? '')),
    `${label} is invalid`,
  );
}

function validateEvidence(value) {
  assertCanaryExactKeys(
    value,
    ['distribution', 'telemetry'],
    'evidence bindings',
  );
  validateEvidenceSummary(
    value.distribution,
    CANARY_DISTRIBUTION_SUMMARY_KIND,
    'distribution summary binding',
  );
  validateEvidenceSummary(
    value.telemetry,
    CANARY_HEALTH_SUMMARY_KIND,
    'health summary binding',
  );
}

export function validateCanaryReceiptProducer(value) {
  assertCanaryExactKeys(
    value,
    [
      'repository',
      'runAttempt',
      'runId',
      'sourceCommit',
      'sourceRef',
      'workflow',
      'workflowCommit',
    ],
    'producer binding',
  );
  assert(
    value.repository === CANONICAL_REPOSITORY &&
      value.sourceRef === TRUSTED_SOURCE_REF &&
      COMMIT.test(String(value.sourceCommit ?? '')) &&
      COMMIT.test(String(value.workflowCommit ?? '')) &&
      value.sourceCommit === value.workflowCommit &&
      String(value.workflow ?? '').length <= 200 &&
      PRODUCER_WORKFLOW.test(String(value.workflow ?? '')) &&
      Number.isSafeInteger(value.runId) &&
      value.runId > 0 &&
      Number.isSafeInteger(value.runAttempt) &&
      value.runAttempt > 0,
    'producer binding is invalid',
  );
}

function validatePolicy(value) {
  assertCanaryExactKeys(value, ['id', 'sha256'], 'policy binding');
  assert(
    value.id === CANARY_OBSERVATION_POLICY_ID &&
      value.sha256 === CANARY_OBSERVATION_POLICY_SHA256,
    'canary observation policy binding is invalid',
  );
}

function validateObservation(value) {
  assertCanaryExactKeys(
    value,
    [
      'counters',
      'distributionClosedAt',
      'endedAt',
      'observedHours',
      'startedAt',
      'stopReasons',
    ],
    'observation',
  );
  assertCanaryObservationCounters(value.counters);
  parseCanonicalCanaryInstant(value.startedAt, 'observation startedAt');
  parseCanonicalCanaryInstant(value.endedAt, 'observation endedAt');
  parseCanonicalCanaryInstant(
    value.distributionClosedAt,
    'observation distributionClosedAt',
  );
  assert(
    typeof value.observedHours === 'number' &&
      Number.isFinite(value.observedHours) &&
      value.observedHours >= 0,
    'observation observedHours is invalid',
  );
  assert(
    Array.isArray(value.stopReasons),
    'observation stopReasons is invalid',
  );
  assert(
    value.stopReasons.every((reason) =>
      CANARY_OBSERVATION_STOP_REASONS.includes(reason),
    ),
    'observation stopReasons contains an unsupported reason',
  );
}

function validateInput(value) {
  assertCanaryExactKeys(
    value,
    [
      'evidence',
      'generatedAt',
      'manifest',
      'observation',
      'producer',
      'publication',
      'release',
      'source',
    ],
    'canary observation input',
  );
  parseCanonicalCanaryInstant(value.generatedAt, 'receipt generatedAt');
  validateCanarySourceBinding(value.source);
  validateCanaryManifestBinding(value.manifest);
  validateCanaryReleaseBinding(value.release);
  validateCanaryPublicationBinding(value.publication);
  validateEvidence(value.evidence);
  validateCanaryReceiptProducer(value.producer);
  assertCanaryExactKeys(
    value.observation,
    ['counters', 'distributionClosedAt', 'endedAt', 'startedAt'],
    'observation input',
  );
  assertCanaryObservationCounters(value.observation.counters);
  parseCanonicalCanaryInstant(
    value.observation.startedAt,
    'observation startedAt',
  );
  parseCanonicalCanaryInstant(value.observation.endedAt, 'observation endedAt');
  parseCanonicalCanaryInstant(
    value.observation.distributionClosedAt,
    'observation distributionClosedAt',
  );
}

function validateBindingIdentity(bindings) {
  const sourceCommit = bindings.source.commit;
  assert(
    bindings.manifest.sourceCommit === sourceCommit &&
      bindings.release.sourceCommit === sourceCommit &&
      bindings.publication.sourceCommit === sourceCommit,
    'source, manifest, release, and publication commits differ',
  );
  assert(
    bindings.release.tag === bindings.publication.tag &&
      bindings.publication.repository === bindings.source.repository,
    'release and publication identity differ',
  );
}

export function validateCanaryObservationBindings(value) {
  assertCanaryExactKeys(
    value,
    ['evidence', 'manifest', 'producer', 'publication', 'release', 'source'],
    'canary observation bindings',
  );
  validateCanarySourceBinding(value.source);
  validateCanaryManifestBinding(value.manifest);
  validateCanaryReleaseBinding(value.release);
  validateCanaryPublicationBinding(value.publication);
  validateEvidence(value.evidence);
  validateCanaryReceiptProducer(value.producer);
  validateBindingIdentity(value);
  return value;
}

function validateCrossBindings(receipt, now) {
  validateBindingIdentity(receipt);

  const nowMs = now.getTime();
  assert(!Number.isNaN(nowMs), 'verification clock is invalid');
  const publicationCreatedAt = parseCanonicalCanaryInstant(
    receipt.publication.createdAt,
    'publication createdAt',
  );
  const startedAt = parseCanonicalCanaryInstant(
    receipt.observation.startedAt,
    'observation startedAt',
  );
  const endedAt = parseCanonicalCanaryInstant(
    receipt.observation.endedAt,
    'observation endedAt',
  );
  const distributionClosedAt = parseCanonicalCanaryInstant(
    receipt.observation.distributionClosedAt,
    'observation distributionClosedAt',
  );
  const generatedAt = parseCanonicalCanaryInstant(
    receipt.generatedAt,
    'receipt generatedAt',
  );
  assert(
    publicationCreatedAt <= startedAt,
    'canary observation started before the bound publication existed',
  );
  assert(endedAt >= startedAt, 'canary observation window is invalid');
  assert(
    distributionClosedAt >= endedAt,
    'canary distribution closed before observation ended',
  );
  assert(
    generatedAt >= distributionClosedAt,
    'canary receipt predates distribution closure',
  );
  assert(endedAt <= nowMs, 'canary observation end is in the future');
  assert(
    distributionClosedAt <= nowMs,
    'canary distribution closure is in the future',
  );
  assert(
    generatedAt <= nowMs + CLOCK_SKEW_MS,
    'canary receipt generatedAt is in the future',
  );
  assert(
    nowMs - generatedAt <= CANARY_OBSERVATION_MAX_AGE_MS,
    'canary observation receipt is stale',
  );
  assert(
    nowMs - distributionClosedAt <= CANARY_OBSERVATION_MAX_AGE_MS,
    'canary distribution closure is stale',
  );
  assert(
    nowMs - endedAt <= CANARY_OBSERVATION_MAX_AGE_MS,
    'canary observation end is stale',
  );
  assert(
    distributionClosedAt - endedAt <= CANARY_OBSERVATION_CLOSURE_GRACE_MS,
    'canary distribution closure exceeds the allowed grace period',
  );
}

/**
 * Validates the closed, content-free receipt contract and recomputes every
 * derived policy field. It does not verify an attestation and cannot authorize
 * stable promotion by itself.
 */
export function validateCanaryObservationReceipt(
  value,
  { now = new Date() } = {},
) {
  assertCanaryExactKeys(
    value,
    [
      'evidence',
      'generatedAt',
      'manifest',
      'observation',
      'policy',
      'producer',
      'publication',
      'receiptKind',
      'release',
      'schemaVersion',
      'source',
    ],
    'canary observation receipt',
  );
  assert(
    value.schemaVersion === CANARY_OBSERVATION_SCHEMA_VERSION &&
      value.receiptKind === CANARY_OBSERVATION_RECEIPT_KIND,
    'canary observation receipt schema is invalid',
  );
  validateCanarySourceBinding(value.source);
  validateCanaryManifestBinding(value.manifest);
  validateCanaryReleaseBinding(value.release);
  validateCanaryPublicationBinding(value.publication);
  validateEvidence(value.evidence);
  validateCanaryReceiptProducer(value.producer);
  validatePolicy(value.policy);
  validateObservation(value.observation);
  validateCrossBindings(value, now);

  const assessment = evaluateCanaryObservationPolicy({
    counters: value.observation.counters,
    endedAt: value.observation.endedAt,
    startedAt: value.observation.startedAt,
  });
  assert(
    value.observation.observedHours === assessment.observedHours,
    'observation observedHours was not derived from the exact window',
  );
  assert(
    JSON.stringify(value.observation.stopReasons) ===
      JSON.stringify(assessment.stopReasons),
    'observation stopReasons were not derived from the exact counters',
  );
  return {
    observedHours: assessment.observedHours,
    policySatisfied: assessment.policySatisfied,
    receipt: value,
    stopReasons: assessment.stopReasons,
  };
}

export function createCanaryObservationReceipt(
  input,
  { now = new Date() } = {},
) {
  validateInput(input);
  const assessment = evaluateCanaryObservationPolicy({
    counters: input.observation.counters,
    endedAt: input.observation.endedAt,
    startedAt: input.observation.startedAt,
  });
  const receipt = {
    evidence: {
      distribution: { ...input.evidence.distribution },
      telemetry: { ...input.evidence.telemetry },
    },
    generatedAt: input.generatedAt,
    manifest: { ...input.manifest },
    observation: {
      counters: { ...input.observation.counters },
      distributionClosedAt: input.observation.distributionClosedAt,
      endedAt: input.observation.endedAt,
      observedHours: assessment.observedHours,
      startedAt: input.observation.startedAt,
      stopReasons: assessment.stopReasons,
    },
    policy: {
      id: CANARY_OBSERVATION_POLICY_ID,
      sha256: CANARY_OBSERVATION_POLICY_SHA256,
    },
    producer: { ...input.producer },
    publication: { ...input.publication },
    receiptKind: CANARY_OBSERVATION_RECEIPT_KIND,
    release: { ...input.release },
    schemaVersion: CANARY_OBSERVATION_SCHEMA_VERSION,
    source: { ...input.source },
  };
  validateCanaryObservationReceipt(receipt, { now });
  return receipt;
}

export function canaryObservationBindings(receipt, options = {}) {
  validateCanaryObservationReceipt(receipt, options);
  return {
    evidence: {
      distribution: { ...receipt.evidence.distribution },
      telemetry: { ...receipt.evidence.telemetry },
    },
    manifest: { ...receipt.manifest },
    producer: { ...receipt.producer },
    publication: { ...receipt.publication },
    release: { ...receipt.release },
    source: { ...receipt.source },
  };
}
