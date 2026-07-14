import {
  SIGNATURE_ALGORITHM,
  canonicalizeJson,
  createEnvelopePreAuthenticationEncoding,
  decodeBase64Url,
  decodeUtf8,
  encodeUtf8,
  parseCanonicalJson,
  validateSafeCodingIntentContract,
  type EnvelopeSignature,
  type HashPort,
  type SafeCodingAudience,
  type SafeCodingAuthority,
  type SafeCodingIntentContract,
  type SafeCodingSubject,
  type SignedEnvelope,
} from '@clodex/contracts';

export const APPROVAL_ARTIFACT_KIND = 'clodex.approval-artifact' as const;
export const APPROVAL_RENDER_MODEL_KIND =
  'clodex.approval-render-model' as const;
export const APPROVAL_REVIEW_KIND = 'clodex.approval-review' as const;
export const APPROVAL_SPEC_VERSION = '1.0.0' as const;
export const APPROVAL_ARTIFACT_PAYLOAD_TYPE =
  'application/vnd.clodex.approval-artifact.v1+jcs' as const;
export const APPROVAL_AUTHORITY_DIGEST_DOMAIN =
  'clodex.approval-authority-view.v1' as const;
export const APPROVAL_ARTIFACT_DIGEST_DOMAIN =
  'clodex.approval-artifact.v1' as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const MAX_DATA_TREE_DEPTH = 64;
const MAX_DATA_TREE_NODES = 100_000;
const MAX_DATA_ARRAY_LENGTH = 10_000;
const MAX_DATA_STRING_CODE_UNITS = 4 * 1024 * 1024;
const MAX_DATA_RECORD_KEYS = 10_000;
const MAX_DATA_KEY_CODE_UNITS = 1 * 1024 * 1024;

export type ApprovalReviewerRole = 'human-reviewer' | 'policy-reviewer';

export interface ApprovalReviewer {
  readonly reviewerId: string;
  readonly role: ApprovalReviewerRole;
}

export interface ApprovalCommitmentSnapshot {
  readonly policyDigest: string;
  readonly adapterRegistryDigest: string;
  readonly runnerRegistryDigest: string;
  readonly effectRegistryDigest: string;
  readonly rendererVersion: string;
}

/**
 * Canonical security-view model. Every field is copied from the validated
 * authoritative portion of an Intent Contract. In particular, goal labels,
 * notes, model prose, and any other nonAuthoritative value are absent.
 */
export interface CanonicalApprovalRenderModel {
  readonly kind: typeof APPROVAL_RENDER_MODEL_KIND;
  readonly specVersion: typeof APPROVAL_SPEC_VERSION;
  readonly rendererVersion: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly previousRevisionHash: string | null;
  readonly contractIssuedAt: string;
  readonly validity: SafeCodingIntentContract['validity'];
  readonly subject: SafeCodingSubject;
  readonly audience: SafeCodingAudience;
  readonly bindings: SafeCodingIntentContract['bindings'];
  readonly authority: SafeCodingAuthority;
}

/** One-time backend review challenge echoed by the trusted review UI. */
export interface ApprovalReviewChallenge {
  readonly kind: typeof APPROVAL_REVIEW_KIND;
  readonly specVersion: typeof APPROVAL_SPEC_VERSION;
  readonly reviewId: string;
  readonly contractHash: string;
  readonly contractRevision: number;
  readonly authorityDigest: string;
  readonly policyDigest: string;
  readonly adapterRegistryDigest: string;
  readonly runnerRegistryDigest: string;
  readonly effectRegistryDigest: string;
  readonly rendererVersion: string;
  readonly reviewer: ApprovalReviewer;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

export interface CanonicalApprovalArtifact {
  readonly kind: typeof APPROVAL_ARTIFACT_KIND;
  readonly specVersion: typeof APPROVAL_SPEC_VERSION;
  readonly approvalId: string;
  readonly reviewId: string;
  readonly contractHash: string;
  readonly contractRevision: number;
  /** Digest of the complete canonical security-view model above. */
  readonly authorityDigest: string;
  readonly policyDigest: string;
  readonly adapterRegistryDigest: string;
  readonly runnerRegistryDigest: string;
  readonly effectRegistryDigest: string;
  readonly rendererVersion: string;
  readonly reviewer: ApprovalReviewer;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

export interface ParsedSignedApprovalArtifact {
  readonly artifact: CanonicalApprovalArtifact;
  readonly canonicalPayload: string;
  readonly envelope: SignedEnvelope;
  readonly signature: EnvelopeSignature;
  readonly message: Uint8Array;
}

export interface ApprovalArtifactReplayReference {
  readonly approvalId: string;
  readonly artifactDigest: string;
  readonly contractHash: string;
  readonly contractRevision: number;
  readonly nonce: string;
  readonly expiresAt: string;
}

export class ApprovalValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ApprovalValidationError';
  }
}

export function createCanonicalApprovalRenderModel(
  contractValue: unknown,
): CanonicalApprovalRenderModel {
  assertDataOnlyTree(contractValue, 'Intent Contract');
  const contract = validateSafeCodingIntentContract(contractValue);
  return deepFreeze({
    kind: APPROVAL_RENDER_MODEL_KIND,
    specVersion: APPROVAL_SPEC_VERSION,
    rendererVersion: contract.bindings.approvalRendererVersion,
    contractId: contract.contractId,
    contractRevision: contract.revision,
    previousRevisionHash: contract.previousRevisionHash,
    contractIssuedAt: contract.issuedAt,
    validity: contract.validity,
    subject: contract.subject,
    audience: contract.audience,
    bindings: contract.bindings,
    authority: contract.authority,
  });
}

export function validateCanonicalApprovalRenderModel(
  value: unknown,
): CanonicalApprovalRenderModel {
  assertDataOnlyTree(value, 'Approval render model');
  const record = requireRecord(value, 'Approval render model');
  requireExactKeys(
    record,
    [
      'kind',
      'specVersion',
      'rendererVersion',
      'contractId',
      'contractRevision',
      'previousRevisionHash',
      'contractIssuedAt',
      'validity',
      'subject',
      'audience',
      'bindings',
      'authority',
    ],
    'Approval render model',
  );
  requireLiteral(
    record.kind,
    APPROVAL_RENDER_MODEL_KIND,
    'Approval render model kind',
  );
  requireLiteral(
    record.specVersion,
    APPROVAL_SPEC_VERSION,
    'Approval render model specVersion',
  );

  const normalized = createCanonicalApprovalRenderModel({
    kind: 'clodex.intent-contract',
    specVersion: '1.0.0',
    contractId: record.contractId,
    revision: record.contractRevision,
    previousRevisionHash: record.previousRevisionHash,
    issuedAt: record.contractIssuedAt,
    validity: record.validity,
    subject: record.subject,
    audience: record.audience,
    bindings: record.bindings,
    authority: record.authority,
    nonAuthoritative: { goalLabel: '', notes: [] },
  });
  const rendererVersion = requireAsciiToken(
    record.rendererVersion,
    'Approval renderer version',
    128,
  );
  if (rendererVersion !== normalized.bindings.approvalRendererVersion) {
    throw new ApprovalValidationError(
      'Approval render model renderer version does not match its binding',
    );
  }
  return normalized;
}

export async function hashCanonicalApprovalAuthority(
  modelValue: unknown,
  hashPort: HashPort,
): Promise<string> {
  const model = validateCanonicalApprovalRenderModel(modelValue);
  return await hashDomainSeparated(
    APPROVAL_AUTHORITY_DIGEST_DOMAIN,
    canonicalizeJson(model),
    hashPort,
  );
}

export function validateApprovalReviewer(value: unknown): ApprovalReviewer {
  assertDataOnlyTree(value, 'Approval reviewer');
  const record = requireRecord(value, 'Approval reviewer');
  requireExactKeys(record, ['reviewerId', 'role'], 'Approval reviewer');
  return Object.freeze({
    reviewerId: requireIdentifier(record.reviewerId, 'Reviewer ID'),
    role: requireEnum(
      record.role,
      ['human-reviewer', 'policy-reviewer'] as const,
      'Reviewer role',
    ),
  });
}

export function validateApprovalCommitmentSnapshot(
  value: unknown,
): ApprovalCommitmentSnapshot {
  assertDataOnlyTree(value, 'Approval commitment snapshot');
  const record = requireRecord(value, 'Approval commitment snapshot');
  requireExactKeys(
    record,
    [
      'policyDigest',
      'adapterRegistryDigest',
      'runnerRegistryDigest',
      'effectRegistryDigest',
      'rendererVersion',
    ],
    'Approval commitment snapshot',
  );
  return Object.freeze({
    policyDigest: requireDigest(record.policyDigest, 'Policy digest'),
    adapterRegistryDigest: requireDigest(
      record.adapterRegistryDigest,
      'Adapter registry digest',
    ),
    runnerRegistryDigest: requireDigest(
      record.runnerRegistryDigest,
      'Runner registry digest',
    ),
    effectRegistryDigest: requireDigest(
      record.effectRegistryDigest,
      'Effect registry digest',
    ),
    rendererVersion: requireAsciiToken(
      record.rendererVersion,
      'Approval renderer version',
      128,
    ),
  });
}

export function validateApprovalReviewChallenge(
  value: unknown,
): ApprovalReviewChallenge {
  assertDataOnlyTree(value, 'Approval review challenge');
  const record = requireRecord(value, 'Approval review challenge');
  requireExactKeys(
    record,
    [
      'kind',
      'specVersion',
      'reviewId',
      'contractHash',
      'contractRevision',
      'authorityDigest',
      'policyDigest',
      'adapterRegistryDigest',
      'runnerRegistryDigest',
      'effectRegistryDigest',
      'rendererVersion',
      'reviewer',
      'issuedAt',
      'expiresAt',
      'nonce',
    ],
    'Approval review challenge',
  );
  requireLiteral(record.kind, APPROVAL_REVIEW_KIND, 'Approval review kind');
  requireLiteral(
    record.specVersion,
    APPROVAL_SPEC_VERSION,
    'Approval review specVersion',
  );
  const issuedAt = requireTimestamp(record.issuedAt, 'Review issuedAt');
  const expiresAt = requireTimestamp(record.expiresAt, 'Review expiresAt');
  requireIncreasingTimestamps(issuedAt, expiresAt, 'Approval review');
  return deepFreeze({
    kind: APPROVAL_REVIEW_KIND,
    specVersion: APPROVAL_SPEC_VERSION,
    reviewId: requireUuid(record.reviewId, 'Review ID'),
    contractHash: requireDigest(record.contractHash, 'Review contract hash'),
    contractRevision: requirePositiveInteger(
      record.contractRevision,
      'Review contract revision',
    ),
    authorityDigest: requireDigest(
      record.authorityDigest,
      'Review authority digest',
    ),
    ...commitmentFields(record, 'Review'),
    reviewer: validateApprovalReviewer(record.reviewer),
    issuedAt,
    expiresAt,
    nonce: requireBase64Url(record.nonce, 'Review nonce', 16, 128),
  });
}

export function validateCanonicalApprovalArtifact(
  value: unknown,
): CanonicalApprovalArtifact {
  assertDataOnlyTree(value, 'Approval Artifact');
  const record = requireRecord(value, 'Approval Artifact');
  requireExactKeys(
    record,
    [
      'kind',
      'specVersion',
      'approvalId',
      'reviewId',
      'contractHash',
      'contractRevision',
      'authorityDigest',
      'policyDigest',
      'adapterRegistryDigest',
      'runnerRegistryDigest',
      'effectRegistryDigest',
      'rendererVersion',
      'reviewer',
      'issuedAt',
      'expiresAt',
      'nonce',
    ],
    'Approval Artifact',
  );
  requireLiteral(record.kind, APPROVAL_ARTIFACT_KIND, 'Approval Artifact kind');
  requireLiteral(
    record.specVersion,
    APPROVAL_SPEC_VERSION,
    'Approval Artifact specVersion',
  );
  const issuedAt = requireTimestamp(record.issuedAt, 'Approval issuedAt');
  const expiresAt = requireTimestamp(record.expiresAt, 'Approval expiresAt');
  requireIncreasingTimestamps(issuedAt, expiresAt, 'Approval Artifact');
  const artifact: CanonicalApprovalArtifact = {
    kind: APPROVAL_ARTIFACT_KIND,
    specVersion: APPROVAL_SPEC_VERSION,
    approvalId: requireUuid(record.approvalId, 'Approval ID'),
    reviewId: requireUuid(record.reviewId, 'Approval review ID'),
    contractHash: requireDigest(record.contractHash, 'Approval contract hash'),
    contractRevision: requirePositiveInteger(
      record.contractRevision,
      'Approval contract revision',
    ),
    authorityDigest: requireDigest(
      record.authorityDigest,
      'Approval authority digest',
    ),
    ...commitmentFields(record, 'Approval'),
    reviewer: validateApprovalReviewer(record.reviewer),
    issuedAt,
    expiresAt,
    nonce: requireBase64Url(record.nonce, 'Approval nonce', 16, 128),
  };
  canonicalizeJson(artifact);
  return deepFreeze(artifact);
}

export function parseCanonicalApprovalArtifact(
  canonicalPayload: string,
): CanonicalApprovalArtifact {
  if (typeof canonicalPayload !== 'string') {
    throw new ApprovalValidationError(
      'Canonical Approval Artifact payload must be a string',
    );
  }
  try {
    return validateCanonicalApprovalArtifact(
      parseCanonicalJson(canonicalPayload),
    );
  } catch (error) {
    throw wrapValidationError(error, 'Approval Artifact payload is invalid');
  }
}

export function parseSignedApprovalArtifact(
  envelopeValue: unknown,
): ParsedSignedApprovalArtifact {
  assertDataOnlyTree(envelopeValue, 'Signed Approval Artifact envelope');
  const record = requireRecord(
    envelopeValue,
    'Signed Approval Artifact envelope',
  );
  requireExactKeys(
    record,
    ['payloadType', 'payload', 'signatures'],
    'Signed Approval Artifact envelope',
  );
  requireLiteral(
    record.payloadType,
    APPROVAL_ARTIFACT_PAYLOAD_TYPE,
    'Approval Artifact payload type',
  );
  const encodedPayload = requireBase64Url(
    record.payload,
    'Approval Artifact envelope payload',
    1,
    128 * 1024,
  );
  const signatures = requireArray(record.signatures, 'Approval signatures');
  if (signatures.length !== 1) {
    throw new ApprovalValidationError(
      'Signed Approval Artifact must contain exactly one signature',
    );
  }
  const signature = validateEnvelopeSignature(signatures[0]);
  let canonicalPayload: string;
  try {
    canonicalPayload = decodeUtf8(decodeBase64Url(encodedPayload));
  } catch (error) {
    throw wrapValidationError(error, 'Approval envelope payload is invalid');
  }
  const artifact = parseCanonicalApprovalArtifact(canonicalPayload);
  const envelope = deepFreeze({
    payloadType: APPROVAL_ARTIFACT_PAYLOAD_TYPE,
    payload: encodedPayload,
    signatures: [signature],
  });
  return Object.freeze({
    artifact,
    canonicalPayload,
    envelope,
    signature,
    message: createEnvelopePreAuthenticationEncoding(
      APPROVAL_ARTIFACT_PAYLOAD_TYPE,
      canonicalPayload,
    ),
  });
}

export async function hashCanonicalApprovalArtifact(
  artifactValue: unknown,
  hashPort: HashPort,
): Promise<string> {
  const artifact = validateCanonicalApprovalArtifact(artifactValue);
  return await hashDomainSeparated(
    APPROVAL_ARTIFACT_DIGEST_DOMAIN,
    canonicalizeJson(artifact),
    hashPort,
  );
}

export function validateArtifactReplayReference(
  value: unknown,
): ApprovalArtifactReplayReference {
  assertDataOnlyTree(value, 'Approval artifact replay reference');
  const record = requireRecord(value, 'Approval artifact replay reference');
  requireExactKeys(
    record,
    [
      'approvalId',
      'artifactDigest',
      'contractHash',
      'contractRevision',
      'nonce',
      'expiresAt',
    ],
    'Approval artifact replay reference',
  );
  return Object.freeze({
    approvalId: requireUuid(record.approvalId, 'Approval ID'),
    artifactDigest: requireDigest(
      record.artifactDigest,
      'Approval Artifact digest',
    ),
    contractHash: requireDigest(record.contractHash, 'Approval contract hash'),
    contractRevision: requirePositiveInteger(
      record.contractRevision,
      'Approval contract revision',
    ),
    nonce: requireBase64Url(record.nonce, 'Approval nonce', 16, 128),
    expiresAt: requireTimestamp(record.expiresAt, 'Approval expiresAt'),
  });
}

export function commitmentsFromContract(
  contractValue: unknown,
): ApprovalCommitmentSnapshot {
  assertDataOnlyTree(contractValue, 'Intent Contract');
  const contract = validateSafeCodingIntentContract(contractValue);
  return Object.freeze({
    policyDigest: contract.bindings.policyDigest,
    adapterRegistryDigest: contract.bindings.adapterRegistryDigest,
    runnerRegistryDigest: contract.bindings.runnerRegistryDigest,
    effectRegistryDigest: contract.bindings.effectRegistryDigest,
    rendererVersion: contract.bindings.approvalRendererVersion,
  });
}

export function commitmentsFromReview(
  reviewValue: unknown,
): ApprovalCommitmentSnapshot {
  const review = validateApprovalReviewChallenge(reviewValue);
  return Object.freeze({
    policyDigest: review.policyDigest,
    adapterRegistryDigest: review.adapterRegistryDigest,
    runnerRegistryDigest: review.runnerRegistryDigest,
    effectRegistryDigest: review.effectRegistryDigest,
    rendererVersion: review.rendererVersion,
  });
}

export function commitmentsFromArtifact(
  artifactValue: unknown,
): ApprovalCommitmentSnapshot {
  const artifact = validateCanonicalApprovalArtifact(artifactValue);
  return Object.freeze({
    policyDigest: artifact.policyDigest,
    adapterRegistryDigest: artifact.adapterRegistryDigest,
    runnerRegistryDigest: artifact.runnerRegistryDigest,
    effectRegistryDigest: artifact.effectRegistryDigest,
    rendererVersion: artifact.rendererVersion,
  });
}

export function approvalValuesEqual(left: unknown, right: unknown): boolean {
  try {
    assertDataOnlyTree(left, 'Approval comparison value');
    assertDataOnlyTree(right, 'Approval comparison value');
    return canonicalizeJson(left) === canonicalizeJson(right);
  } catch {
    return false;
  }
}

/**
 * Reject accessors, hidden fields, symbols, sparse arrays, exotic prototypes,
 * and cycles before any untrusted field is read by a validator.
 */
export function assertDataOnlyTree(value: unknown, label: string): void {
  inspectDataOnlyTree(
    value,
    label,
    new Set<object>(),
    { nodes: 0, stringCodeUnits: 0, keyCodeUnits: 0 },
    0,
  );
}

function inspectDataOnlyTree(
  value: unknown,
  label: string,
  ancestors: Set<object>,
  budget: { nodes: number; stringCodeUnits: number; keyCodeUnits: number },
  depth: number,
): void {
  if (typeof value === 'string') {
    budget.stringCodeUnits += value.length;
    if (budget.stringCodeUnits > MAX_DATA_STRING_CODE_UNITS) {
      throw new ApprovalValidationError(`${label} exceeds the data size limit`);
    }
    return;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return;
  }
  if (typeof value !== 'object') {
    throw new ApprovalValidationError(`${label} contains a non-data value`);
  }
  if (ancestors.has(value)) {
    throw new ApprovalValidationError(`${label} contains a cycle`);
  }
  if (depth >= MAX_DATA_TREE_DEPTH) {
    throw new ApprovalValidationError(`${label} exceeds the data depth limit`);
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_DATA_TREE_NODES) {
    throw new ApprovalValidationError(`${label} exceeds the data node limit`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      inspectDataArray(value, label, ancestors, budget, depth + 1);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ApprovalValidationError(
        `${label} must contain only plain data records`,
      );
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new ApprovalValidationError(`${label} cannot contain symbol keys`);
    }
    const names = Object.getOwnPropertyNames(value);
    if (names.length > MAX_DATA_RECORD_KEYS) {
      throw new ApprovalValidationError(`${label} has too many fields`);
    }
    if (names.length !== Object.keys(value).length) {
      throw new ApprovalValidationError(
        `${label} cannot contain hidden fields`,
      );
    }
    for (const name of names) {
      budget.keyCodeUnits += name.length;
      if (budget.keyCodeUnits > MAX_DATA_KEY_CODE_UNITS) {
        throw new ApprovalValidationError(
          `${label} keys exceed the size limit`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !('value' in descriptor)) {
        throw new ApprovalValidationError(`${label} cannot contain accessors`);
      }
      inspectDataOnlyTree(
        descriptor.value,
        `${label}.${name}`,
        ancestors,
        budget,
        depth + 1,
      );
    }
  } finally {
    ancestors.delete(value);
  }
}

function inspectDataArray(
  value: readonly unknown[],
  label: string,
  ancestors: Set<object>,
  budget: { nodes: number; stringCodeUnits: number; keyCodeUnits: number },
  depth: number,
): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new ApprovalValidationError(`${label} contains an exotic array`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new ApprovalValidationError(`${label} array has symbol keys`);
  }
  if (value.length > MAX_DATA_ARRAY_LENGTH) {
    throw new ApprovalValidationError(`${label} array has too many entries`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== value.length + 1 ||
    names[value.length] !== 'length' ||
    names.slice(0, value.length).some((name, index) => name !== String(index))
  ) {
    throw new ApprovalValidationError(
      `${label} array must be dense and contain no extra fields`,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) {
      throw new ApprovalValidationError(
        `${label} array cannot contain accessors`,
      );
    }
    inspectDataOnlyTree(
      descriptor.value,
      `${label}[${index}]`,
      ancestors,
      budget,
      depth,
    );
  }
}

function validateEnvelopeSignature(value: unknown): EnvelopeSignature {
  const record = requireRecord(value, 'Approval envelope signature');
  requireExactKeys(
    record,
    ['keyId', 'algorithm', 'signature'],
    'Approval envelope signature',
  );
  requireLiteral(
    record.algorithm,
    SIGNATURE_ALGORITHM,
    'Approval signature algorithm',
  );
  const encoded = requireBase64Url(
    record.signature,
    'Approval signature bytes',
    86,
    86,
  );
  try {
    if (decodeBase64Url(encoded).length !== 64) {
      throw new ApprovalValidationError(
        'P-256 P1363 approval signatures must contain exactly 64 bytes',
      );
    }
  } catch (error) {
    throw wrapValidationError(error, 'Approval signature bytes are invalid');
  }
  return Object.freeze({
    keyId: requireIdentifier(record.keyId, 'Approval signer key ID'),
    algorithm: SIGNATURE_ALGORITHM,
    signature: encoded,
  });
}

async function hashDomainSeparated(
  domain: string,
  canonicalPayload: string,
  hashPort: HashPort,
): Promise<string> {
  if (!hashPort || typeof hashPort.sha256 !== 'function') {
    throw new ApprovalValidationError('A SHA-256 HashPort is required');
  }
  const domainBytes = encodeUtf8(domain);
  const payloadBytes = encodeUtf8(canonicalPayload);
  const input = new Uint8Array(domainBytes.length + 1 + payloadBytes.length);
  input.set(domainBytes, 0);
  input[domainBytes.length] = 0;
  input.set(payloadBytes, domainBytes.length + 1);
  const digest = await hashPort.sha256(input);
  return requireDigest(digest, 'HashPort SHA-256 result');
}

function commitmentFields(
  record: Record<string, unknown>,
  label: string,
): ApprovalCommitmentSnapshot {
  return {
    policyDigest: requireDigest(record.policyDigest, `${label} policy digest`),
    adapterRegistryDigest: requireDigest(
      record.adapterRegistryDigest,
      `${label} adapter registry digest`,
    ),
    runnerRegistryDigest: requireDigest(
      record.runnerRegistryDigest,
      `${label} runner registry digest`,
    ),
    effectRegistryDigest: requireDigest(
      record.effectRegistryDigest,
      `${label} effect registry digest`,
    ),
    rendererVersion: requireAsciiToken(
      record.rendererVersion,
      `${label} renderer version`,
      128,
    ),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new ApprovalValidationError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new ApprovalValidationError(`${label} has unknown or missing fields`);
  }
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ApprovalValidationError(`${label} must be an array`);
  }
  return value;
}

function requireString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new ApprovalValidationError(`${label} must be a bounded string`);
  }
  try {
    encodeUtf8(value);
  } catch (error) {
    throw wrapValidationError(error, `${label} is invalid`);
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  const identifier = requireString(value, label, 256);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new ApprovalValidationError(`${label} is not a canonical identifier`);
  }
  return identifier;
}

function requireAsciiToken(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  const token = requireString(value, label, maxLength);
  if (!/^[\u0021-\u007e]+$/.test(token)) {
    throw new ApprovalValidationError(`${label} must be printable ASCII`);
  }
  return token;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new ApprovalValidationError(
      `${label} must be a lowercase SHA-256 hex digest`,
    );
  }
  return value;
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ApprovalValidationError(`${label} must be a lowercase UUID`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label, 32);
  if (!TIMESTAMP_PATTERN.test(timestamp)) {
    throw new ApprovalValidationError(`${label} must be canonical UTC`);
  }
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) {
    throw new ApprovalValidationError(`${label} is not a real timestamp`);
  }
  const iso = new Date(milliseconds).toISOString();
  const canonical = iso.endsWith('.000Z') ? iso.replace('.000Z', 'Z') : iso;
  if (canonical !== timestamp) {
    throw new ApprovalValidationError(`${label} is not canonical UTC`);
  }
  return timestamp;
}

function requireIncreasingTimestamps(
  issuedAt: string,
  expiresAt: string,
  label: string,
): void {
  if (Date.parse(issuedAt) >= Date.parse(expiresAt)) {
    throw new ApprovalValidationError(`${label} expiry must be after issuance`);
  }
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ApprovalValidationError(
      `${label} must be a positive safe integer`,
    );
  }
  return value as number;
}

function requireLiteral<T extends string>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) {
    throw new ApprovalValidationError(`${label} must equal ${expected}`);
  }
  return expected;
}

function requireEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new ApprovalValidationError(`${label} is unsupported`);
  }
  return value as Values[number];
}

function requireBase64Url(
  value: unknown,
  label: string,
  minLength: number,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < minLength ||
    value.length > maxLength ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw new ApprovalValidationError(
      `${label} must be canonical unpadded base64url`,
    );
  }
  return value;
}

function wrapValidationError(error: unknown, fallback: string): Error {
  return new ApprovalValidationError(
    error instanceof Error ? error.message : fallback,
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
