import { createHash } from 'node:crypto';

import {
  CANARY_DISTRIBUTION_SUMMARY_KIND,
  CANARY_HEALTH_SUMMARY_KIND,
  CANARY_OBSERVATION_CLOSURE_GRACE_MS,
  CANARY_OBSERVATION_MAX_AGE_MS,
  assertCanaryExactKeys,
  parseCanonicalCanaryInstant,
  validateCanaryManifestBinding,
  validateCanaryPublicationBinding,
  validateCanaryReleaseBinding,
  validateCanarySourceBinding,
} from './canary-observation-receipt.mjs';
import { CANARY_OBSERVATION_COUNTER_NAMES } from './canary-observation-policy.mjs';
import { TRUSTED_SOURCE_REF } from './release-trust-constants.mjs';

export const CANARY_SUMMARY_SCHEMA_VERSION = 1;
export const CANARY_SUMMARY_MAX_BYTES = 64 * 1024;
export const CANARY_SUMMARY_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const CANARY_DISTRIBUTION_COUNTER_NAMES = Object.freeze([
  'signatureTrustFailures',
  'uniqueInstallations',
]);
export const CANARY_HEALTH_COUNTER_NAMES = Object.freeze(
  CANARY_OBSERVATION_COUNTER_NAMES.filter(
    (name) => !CANARY_DISTRIBUTION_COUNTER_NAMES.includes(name),
  ),
);

const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function canonicalCanaryJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalCanaryJson(item)).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalCanaryJson(value[key])}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    fail('canary artifact is not JSON serializable');
  return serialized;
}

export function canonicalCanaryArtifactBytes(value) {
  return Buffer.from(`${canonicalCanaryJson(value)}\n`, 'utf8');
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertExactCounters(value, names, label) {
  assertCanaryExactKeys(value, names, `${label} counters`);
  for (const name of names) {
    assert(
      Number.isSafeInteger(value[name]) && value[name] >= 0,
      `${label} counter is invalid: ${name}`,
    );
  }
}

export function validateCanarySummaryProducer(value) {
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
    'canary summary producer',
  );
  const repository = String(value.repository ?? '');
  const workflowPattern = new RegExp(
    `^${escapeRegex(repository)}/\\.github/workflows/[A-Za-z0-9_.-]+\\.ya?ml$`,
    'u',
  );
  assert(
    repository.length <= 160 &&
      REPOSITORY.test(repository) &&
      value.sourceRef === TRUSTED_SOURCE_REF &&
      COMMIT.test(String(value.sourceCommit ?? '')) &&
      COMMIT.test(String(value.workflowCommit ?? '')) &&
      value.sourceCommit === value.workflowCommit &&
      typeof value.workflow === 'string' &&
      value.workflow.length <= 240 &&
      workflowPattern.test(value.workflow) &&
      Number.isSafeInteger(value.runId) &&
      value.runId > 0 &&
      Number.isSafeInteger(value.runAttempt) &&
      value.runAttempt > 0,
    'canary summary producer is invalid',
  );
  return value;
}

function validateCommonSummary(value, { kind, now }) {
  assertCanaryExactKeys(
    value,
    [
      'artifactKind',
      'generatedAt',
      'manifest',
      'observation',
      'producer',
      'publication',
      'release',
      'schemaVersion',
      'source',
    ],
    'canary summary',
  );
  assert(
    value.schemaVersion === CANARY_SUMMARY_SCHEMA_VERSION &&
      value.artifactKind === kind,
    'canary summary schema or artifact kind is invalid',
  );
  validateCanarySourceBinding(value.source);
  validateCanaryManifestBinding(value.manifest);
  validateCanaryReleaseBinding(value.release);
  validateCanaryPublicationBinding(value.publication);
  validateCanarySummaryProducer(value.producer);
  const sourceCommit = value.source.commit;
  assert(
    value.manifest.sourceCommit === sourceCommit &&
      value.release.sourceCommit === sourceCommit &&
      value.publication.sourceCommit === sourceCommit &&
      value.release.tag === value.publication.tag &&
      value.publication.repository === value.source.repository,
    'canary summary source, manifest, release, and publication differ',
  );

  const nowMs = now.getTime();
  assert(!Number.isNaN(nowMs), 'canary summary verification clock is invalid');
  const generatedAt = parseCanonicalCanaryInstant(
    value.generatedAt,
    'canary summary generatedAt',
  );
  assert(
    generatedAt <= nowMs + CANARY_SUMMARY_CLOCK_SKEW_MS,
    'canary summary generatedAt is in the future',
  );
  assert(
    nowMs - generatedAt <= CANARY_OBSERVATION_MAX_AGE_MS,
    'canary summary is stale',
  );
  return { generatedAt, nowMs };
}

export function validateCanaryDistributionSummary(
  value,
  { now = new Date() } = {},
) {
  const { generatedAt, nowMs } = validateCommonSummary(value, {
    kind: CANARY_DISTRIBUTION_SUMMARY_KIND,
    now,
  });
  assertCanaryExactKeys(
    value.observation,
    ['counters', 'distributionClosedAt', 'endedAt', 'startedAt'],
    'canary distribution observation',
  );
  assertExactCounters(
    value.observation.counters,
    CANARY_DISTRIBUTION_COUNTER_NAMES,
    'canary distribution',
  );
  const publicationCreatedAt = parseCanonicalCanaryInstant(
    value.publication.createdAt,
    'publication createdAt',
  );
  const startedAt = parseCanonicalCanaryInstant(
    value.observation.startedAt,
    'canary distribution startedAt',
  );
  const endedAt = parseCanonicalCanaryInstant(
    value.observation.endedAt,
    'canary distribution endedAt',
  );
  const distributionClosedAt = parseCanonicalCanaryInstant(
    value.observation.distributionClosedAt,
    'canary distribution closedAt',
  );
  assert(
    publicationCreatedAt <= startedAt,
    'canary distribution started before publication',
  );
  assert(endedAt >= startedAt, 'canary distribution window is invalid');
  assert(
    distributionClosedAt >= endedAt,
    'canary distribution closed before observation ended',
  );
  assert(
    distributionClosedAt - endedAt <= CANARY_OBSERVATION_CLOSURE_GRACE_MS,
    'canary distribution closure exceeds the allowed grace period',
  );
  assert(
    endedAt <= nowMs && distributionClosedAt <= nowMs,
    'canary distribution window is in the future',
  );
  assert(
    generatedAt >= distributionClosedAt,
    'canary distribution summary predates closure',
  );
  assert(
    nowMs - endedAt <= CANARY_OBSERVATION_MAX_AGE_MS &&
      nowMs - distributionClosedAt <= CANARY_OBSERVATION_MAX_AGE_MS,
    'canary distribution window is stale',
  );
  return value;
}

export function validateCanaryHealthSummary(value, { now = new Date() } = {}) {
  const { generatedAt, nowMs } = validateCommonSummary(value, {
    kind: CANARY_HEALTH_SUMMARY_KIND,
    now,
  });
  assertCanaryExactKeys(
    value.observation,
    ['counters', 'endedAt', 'startedAt'],
    'canary health observation',
  );
  assertExactCounters(
    value.observation.counters,
    CANARY_HEALTH_COUNTER_NAMES,
    'canary health',
  );
  const publicationCreatedAt = parseCanonicalCanaryInstant(
    value.publication.createdAt,
    'publication createdAt',
  );
  const startedAt = parseCanonicalCanaryInstant(
    value.observation.startedAt,
    'canary health startedAt',
  );
  const endedAt = parseCanonicalCanaryInstant(
    value.observation.endedAt,
    'canary health endedAt',
  );
  assert(
    publicationCreatedAt <= startedAt,
    'canary health observation started before publication',
  );
  assert(endedAt >= startedAt, 'canary health observation window is invalid');
  assert(endedAt <= nowMs, 'canary health observation end is in the future');
  assert(
    generatedAt >= endedAt,
    'canary health summary predates observation end',
  );
  assert(
    nowMs - endedAt <= CANARY_OBSERVATION_MAX_AGE_MS,
    'canary health observation end is stale',
  );
  return value;
}

export function validateCanarySummary(value, options = {}) {
  if (value?.artifactKind === CANARY_DISTRIBUTION_SUMMARY_KIND) {
    return validateCanaryDistributionSummary(value, options);
  }
  if (value?.artifactKind === CANARY_HEALTH_SUMMARY_KIND) {
    return validateCanaryHealthSummary(value, options);
  }
  fail('canary summary artifact kind is unsupported');
}

function normalizeArtifactBytes(bytes) {
  assert(
    bytes instanceof Uint8Array,
    'canary artifact bytes must be a Uint8Array',
  );
  const normalized = Buffer.from(bytes);
  assert(
    normalized.length > 0 && normalized.length <= CANARY_SUMMARY_MAX_BYTES,
    'canary artifact byte length is invalid',
  );
  return normalized;
}

export function parseCanonicalCanarySummaryBytes(
  bytes,
  { kind, now = new Date() } = {},
) {
  const normalized = normalizeArtifactBytes(bytes);
  assert(
    !(
      normalized[0] === 0xef &&
      normalized[1] === 0xbb &&
      normalized[2] === 0xbf
    ),
    'canary summary bytes contain a BOM',
  );
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(normalized);
  } catch {
    fail('canary summary bytes are not valid UTF-8');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('canary summary bytes are not valid JSON');
  }
  assert(
    text === canonicalCanaryArtifactBytes(value).toString('utf8'),
    'canary summary bytes are not canonical JSON',
  );
  if (kind !== undefined && value?.artifactKind !== kind) {
    fail('canary summary bytes have the wrong artifact kind');
  }
  validateCanarySummary(value, { now });
  return {
    bytes: normalized,
    sha256: sha256Bytes(normalized),
    value,
  };
}

export function createCanaryArtifactSubject(value, { now = new Date() } = {}) {
  validateCanarySummary(value, { now });
  const bytes = canonicalCanaryArtifactBytes(value);
  return {
    artifactKind: value.artifactKind,
    sha256: sha256Bytes(bytes),
    value: JSON.parse(bytes.toString('utf8')),
  };
}

export function validateCanaryArtifactSubject(
  subject,
  { kind, now = new Date() } = {},
) {
  assertCanaryExactKeys(
    subject,
    ['artifactKind', 'sha256', 'value'],
    'canary artifact subject',
  );
  assert(
    subject.artifactKind === subject.value?.artifactKind &&
      (kind === undefined || subject.artifactKind === kind) &&
      SHA256.test(String(subject.sha256 ?? '')),
    'canary artifact subject identity is invalid',
  );
  validateCanarySummary(subject.value, { now });
  assert(
    sha256Bytes(canonicalCanaryArtifactBytes(subject.value)) === subject.sha256,
    'canary artifact subject digest is invalid',
  );
  return subject;
}

export function validateVerifiedCanaryAttestation(value) {
  assertCanaryExactKeys(
    value,
    [
      'repository',
      'signerDigest',
      'signerWorkflow',
      'sourceDigest',
      'sourceRef',
      'subjectSha256',
    ],
    'verified canary attestation',
  );
  const repository = String(value.repository ?? '');
  const workflowPattern = new RegExp(
    `^${escapeRegex(repository)}/\\.github/workflows/[A-Za-z0-9_.-]+\\.ya?ml$`,
    'u',
  );
  assert(
    repository.length <= 160 &&
      REPOSITORY.test(repository) &&
      value.sourceRef === TRUSTED_SOURCE_REF &&
      COMMIT.test(String(value.sourceDigest ?? '')) &&
      COMMIT.test(String(value.signerDigest ?? '')) &&
      typeof value.signerWorkflow === 'string' &&
      workflowPattern.test(value.signerWorkflow) &&
      SHA256.test(String(value.subjectSha256 ?? '')),
    'verified canary attestation binding is invalid',
  );
  return value;
}

export function verifyCanarySummaryAttestationBinding(
  subject,
  attestation,
  { expectedProducer, kind, now = new Date() } = {},
) {
  validateCanaryArtifactSubject(subject, { kind, now });
  validateVerifiedCanaryAttestation(attestation);
  const producer = subject.value.producer;
  if (expectedProducer !== undefined) {
    validateCanarySummaryProducer(expectedProducer);
    assert(
      canonicalCanaryJson(producer) === canonicalCanaryJson(expectedProducer),
      'canary summary producer is not authorized by the expected binding',
    );
  }
  assert(
    attestation.repository === producer.repository &&
      attestation.signerWorkflow === producer.workflow &&
      attestation.sourceRef === producer.sourceRef &&
      attestation.sourceDigest === producer.sourceCommit &&
      attestation.signerDigest === producer.workflowCommit &&
      attestation.subjectSha256 === subject.sha256,
    'verified canary attestation does not bind the exact producer and subject',
  );
  return { attestation, producer, subject };
}

const union = [
  ...CANARY_DISTRIBUTION_COUNTER_NAMES,
  ...CANARY_HEALTH_COUNTER_NAMES,
]
  .sort()
  .join('\n');
const policy = [...CANARY_OBSERVATION_COUNTER_NAMES].sort().join('\n');
if (union !== policy) {
  fail('canary summary counter partitions do not cover the observation policy');
}
