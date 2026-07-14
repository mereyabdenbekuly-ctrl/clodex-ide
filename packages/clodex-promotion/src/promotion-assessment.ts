import {
  canonicalizeJson,
  encodeUtf8,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from '@clodex/contracts';

export const PROMOTION_PROFILE_KIND = 'clodex.promotion-profile' as const;
export const PROMOTION_ASSESSMENT_KIND = 'clodex.promotion-assessment' as const;
export const PROMOTION_ASSESSMENT_VERSION = 1 as const;

const PROFILE_HASH_DOMAIN = 'clodex.promotion.profile.v1';
const EVIDENCE_HASH_DOMAIN = 'clodex.promotion.evidence.v1';
const ASSESSMENT_HASH_DOMAIN = 'clodex.promotion.assessment.v1';
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const INVARIANT_PATTERN = /^INV-[A-Z0-9][A-Z0-9-]{1,126}$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const MAX_PROMOTION_REQUIREMENTS = 256;
const MAX_PROMOTION_EVIDENCE_RECORDS = 512;
const MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_NODES = 50_000;
const MAX_CANONICAL_ARRAY_LENGTH = 1_024;
const MAX_CANONICAL_STRING_CODE_UNITS = 2 * 1024 * 1024;

export type SecurityGuaranteeStatus =
  | 'ENFORCED'
  | 'TESTED'
  | 'IN_PROGRESS'
  | 'SPEC_ONLY'
  | 'BLOCKED'
  | 'NOT_APPLICABLE';

export interface PromotionRequirement {
  readonly invariantId: string;
  readonly scope: string;
}

export interface PromotionProfile {
  readonly kind: typeof PROMOTION_PROFILE_KIND;
  readonly version: typeof PROMOTION_ASSESSMENT_VERSION;
  readonly profileId: string;
  readonly targetGateId: string;
  readonly environmentDigest: string;
  readonly buildDigest: string;
  readonly configurationDigest: string;
  readonly evidencePolicyDigest: string;
  readonly maxEvidenceAgeMs: number;
  readonly allowedIssuerIds: readonly string[];
  readonly requirements: readonly PromotionRequirement[];
}

/**
 * Evidence is admitted by a trusted caller after signature/source validation.
 * This package evaluates freshness, exact scope, status, completeness, and
 * profile binding; it does not implement a key store or mutate a feature gate.
 */
export interface PromotionInvariantEvidence {
  readonly invariantId: string;
  readonly scope: string;
  readonly status: SecurityGuaranteeStatus;
  readonly issuerId: string;
  readonly artifactDigest: string;
  readonly verificationReceiptDigest: string;
  readonly environmentDigest: string;
  readonly buildDigest: string;
  readonly configurationDigest: string;
  readonly evidencePolicyDigest: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
}

export interface PromotionEvidenceTrustPort {
  /** Resolve and verify the exact evidence artifact/verification receipt. */
  verifyEvidence(
    evidence: PromotionInvariantEvidence,
  ): boolean | Promise<boolean>;
  /** Synchronous final fence against trust-policy or environment drift. */
  assertCurrent(input: {
    readonly profileDigest: string;
    readonly evidenceBundleDigest: string;
    readonly environmentDigest: string;
    readonly buildDigest: string;
    readonly configurationDigest: string;
    readonly evidencePolicyDigest: string;
    readonly evaluatedAt: string;
  }): void;
}

export interface PromotionHashPort {
  /** Synchronous local hash used after the last asynchronous trust check. */
  sha256(input: Uint8Array): string;
}

export interface PromotionClockPort {
  /** Trusted synchronous assessment time; never supplied by request data. */
  now(): string;
}

export type PromotionBlockerReason =
  | 'evidence-expired'
  | 'evidence-from-future'
  | 'evidence-too-old'
  | 'evidence-untrusted'
  | 'environment-mismatch'
  | 'build-mismatch'
  | 'configuration-mismatch'
  | 'evidence-policy-mismatch'
  | 'issuer-untrusted'
  | 'invariant-missing'
  | 'scope-mismatch'
  | 'status-not-enforced';

export interface PromotionBlocker {
  readonly invariantId: string;
  readonly reason: PromotionBlockerReason;
  readonly observedStatus: SecurityGuaranteeStatus | null;
}

export interface PromotionAssessment {
  readonly kind: typeof PROMOTION_ASSESSMENT_KIND;
  readonly version: typeof PROMOTION_ASSESSMENT_VERSION;
  readonly profileId: string;
  readonly profileDigest: string;
  readonly targetGateId: string;
  readonly evaluatedAt: string;
  readonly evidenceBundleDigest: string;
  readonly eligibility: 'blocked' | 'eligible-for-reviewed-decision';
  /** This evaluator never enables or mutates a feature gate. */
  readonly automaticEnablement: false;
  readonly blockers: readonly PromotionBlocker[];
  readonly assessmentDigest: string;
}

export class PromotionAssessmentError extends Error {
  public constructor(
    public readonly code:
      | 'evidence-duplicate'
      | 'input-invalid'
      | 'profile-digest-mismatch'
      | 'trust-port-failed',
    message: string,
  ) {
    super(message);
    this.name = 'PromotionAssessmentError';
  }
}

export async function hashPromotionProfile(
  value: unknown,
  hash: PromotionHashPort,
): Promise<string> {
  const profile = validatePromotionProfile(value);
  const sha256 = pinMethod(hash, 'sha256', 'Hash port');
  return await hashCanonical(PROFILE_HASH_DOMAIN, profile, { sha256 });
}

export async function assessPromotion(input: {
  readonly profile: unknown;
  readonly expectedProfileDigest: string;
  readonly evidence: readonly unknown[];
  readonly hash: PromotionHashPort;
  readonly clock: PromotionClockPort;
  readonly trust: PromotionEvidenceTrustPort;
}): Promise<PromotionAssessment> {
  const source = requireInputRecord(input, [
    'clock',
    'evidence',
    'expectedProfileDigest',
    'hash',
    'profile',
    'trust',
  ]);
  const sha256 = pinMethod(
    source.hash as PromotionHashPort,
    'sha256',
    'Hash port',
  );
  const now = pinMethod(
    source.clock as PromotionClockPort,
    'now',
    'Promotion clock port',
  );
  const verifyEvidence = pinMethod(
    source.trust as PromotionEvidenceTrustPort,
    'verifyEvidence',
    'Evidence trust port',
  );
  const assertCurrent = pinMethod(
    source.trust as PromotionEvidenceTrustPort,
    'assertCurrent',
    'Evidence trust port',
  );
  const hash = Object.freeze({ sha256 });
  const profile = validatePromotionProfile(source.profile);
  const expectedProfileDigest = requireDigest(
    source.expectedProfileDigest,
    'Expected profile digest',
  );
  const profileDigest = hashCanonical(PROFILE_HASH_DOMAIN, profile, hash);
  if (profileDigest !== expectedProfileDigest) {
    throw new PromotionAssessmentError(
      'profile-digest-mismatch',
      'Promotion profile does not match the pinned profile digest',
    );
  }
  const evidenceValues = requireDenseDataArray(
    source.evidence,
    'Promotion evidence bundle',
    MAX_PROMOTION_EVIDENCE_RECORDS,
  );
  const evidence = evidenceValues.map((value) =>
    validatePromotionInvariantEvidence(value),
  );
  const evidenceByInvariant = new Map<string, PromotionInvariantEvidence>();
  const requiredInvariantIds = new Set(
    profile.requirements.map((requirement) => requirement.invariantId),
  );
  for (const item of evidence) {
    if (!requiredInvariantIds.has(item.invariantId)) {
      throw invalid(`Unexpected evidence for ${item.invariantId}`);
    }
    if (evidenceByInvariant.has(item.invariantId)) {
      throw new PromotionAssessmentError(
        'evidence-duplicate',
        `Duplicate evidence for ${item.invariantId}`,
      );
    }
    evidenceByInvariant.set(item.invariantId, item);
  }

  const trustedEvidence = new Map<string, boolean>();
  for (const item of evidence) {
    let trusted: boolean;
    try {
      trusted = (await verifyEvidence(item)) === true;
    } catch (error) {
      throw new PromotionAssessmentError(
        'trust-port-failed',
        error instanceof Error
          ? `Evidence trust verification failed: ${error.message}`
          : 'Evidence trust verification failed',
      );
    }
    trustedEvidence.set(item.invariantId, trusted);
  }
  const evaluatedAt = requireTimestamp(now(), 'Evaluation time');
  const evaluatedAtMs = Date.parse(evaluatedAt);
  const blockers: PromotionBlocker[] = [];
  for (const requirement of profile.requirements) {
    const item = evidenceByInvariant.get(requirement.invariantId);
    if (!item) {
      blockers.push({
        invariantId: requirement.invariantId,
        reason: 'invariant-missing',
        observedStatus: null,
      });
      continue;
    }
    if (item.scope !== requirement.scope) {
      blockers.push({
        invariantId: requirement.invariantId,
        reason: 'scope-mismatch',
        observedStatus: item.status,
      });
      continue;
    }
    if (item.environmentDigest !== profile.environmentDigest) {
      blockers.push({
        invariantId: requirement.invariantId,
        reason: 'environment-mismatch',
        observedStatus: item.status,
      });
      continue;
    }
    if (item.buildDigest !== profile.buildDigest) {
      blockers.push({
        invariantId: requirement.invariantId,
        reason: 'build-mismatch',
        observedStatus: item.status,
      });
      continue;
    }
    if (item.configurationDigest !== profile.configurationDigest) {
      blockers.push({
        invariantId: requirement.invariantId,
        reason: 'configuration-mismatch',
        observedStatus: item.status,
      });
      continue;
    }
    if (item.evidencePolicyDigest !== profile.evidencePolicyDigest) {
      blockers.push({
        invariantId: requirement.invariantId,
        reason: 'evidence-policy-mismatch',
        observedStatus: item.status,
      });
      continue;
    }
    if (!profile.allowedIssuerIds.includes(item.issuerId)) {
      blockers.push({
        invariantId: requirement.invariantId,
        reason: 'issuer-untrusted',
        observedStatus: item.status,
      });
      continue;
    }
    if (Date.parse(item.verifiedAt) > evaluatedAtMs) {
      blockers.push({
        invariantId: requirement.invariantId,
        reason: 'evidence-from-future',
        observedStatus: item.status,
      });
      continue;
    }
    if (
      evaluatedAtMs - Date.parse(item.verifiedAt) >
      profile.maxEvidenceAgeMs
    ) {
      blockers.push({
        invariantId: requirement.invariantId,
        reason: 'evidence-too-old',
        observedStatus: item.status,
      });
      continue;
    }
    if (evaluatedAtMs >= Date.parse(item.expiresAt)) {
      blockers.push({
        invariantId: requirement.invariantId,
        reason: 'evidence-expired',
        observedStatus: item.status,
      });
      continue;
    }
    if (trustedEvidence.get(item.invariantId) !== true) {
      blockers.push({
        invariantId: requirement.invariantId,
        reason: 'evidence-untrusted',
        observedStatus: item.status,
      });
      continue;
    }
    if (item.status !== 'ENFORCED') {
      blockers.push({
        invariantId: requirement.invariantId,
        reason: 'status-not-enforced',
        observedStatus: item.status,
      });
    }
  }

  const sortedEvidence = [...evidence].sort((left, right) =>
    compareAscii(left.invariantId, right.invariantId),
  );
  const evidenceBundleDigest = hashCanonical(
    EVIDENCE_HASH_DOMAIN,
    sortedEvidence,
    hash,
  );
  const assessmentWithoutDigest = Object.freeze({
    kind: PROMOTION_ASSESSMENT_KIND,
    version: PROMOTION_ASSESSMENT_VERSION,
    profileId: profile.profileId,
    profileDigest,
    targetGateId: profile.targetGateId,
    evaluatedAt,
    evidenceBundleDigest,
    eligibility:
      blockers.length === 0
        ? ('eligible-for-reviewed-decision' as const)
        : ('blocked' as const),
    automaticEnablement: false as const,
    blockers: Object.freeze(
      blockers.map((blocker) => Object.freeze({ ...blocker })),
    ),
  });
  const assessmentDigest = hashCanonical(
    ASSESSMENT_HASH_DOMAIN,
    assessmentWithoutDigest,
    hash,
  );
  const finalFenceResult = assertCurrent({
    profileDigest,
    evidenceBundleDigest,
    environmentDigest: profile.environmentDigest,
    buildDigest: profile.buildDigest,
    configurationDigest: profile.configurationDigest,
    evidencePolicyDigest: profile.evidencePolicyDigest,
    evaluatedAt,
  });
  if (finalFenceResult !== undefined) {
    throw new PromotionAssessmentError(
      'trust-port-failed',
      'Evidence trust final fence must synchronously return undefined',
    );
  }
  return Object.freeze({ ...assessmentWithoutDigest, assessmentDigest });
}

export function validatePromotionProfile(value: unknown): PromotionProfile {
  const record = requireClosedRecord(value, [
    'allowedIssuerIds',
    'buildDigest',
    'configurationDigest',
    'environmentDigest',
    'evidencePolicyDigest',
    'kind',
    'maxEvidenceAgeMs',
    'profileId',
    'requirements',
    'targetGateId',
    'version',
  ]);
  if (record.kind !== PROMOTION_PROFILE_KIND) {
    throw invalid('Promotion profile kind is invalid');
  }
  if (record.version !== PROMOTION_ASSESSMENT_VERSION) {
    throw invalid('Promotion profile version is invalid');
  }
  const profileId = requireIdentifier(record.profileId, 'Profile ID');
  const targetGateId = requireIdentifier(record.targetGateId, 'Target gate ID');
  const allowedIssuerIds = requireSortedUniqueIdentifiers(
    record.allowedIssuerIds,
    'Allowed evidence issuers',
  );
  if (
    !Array.isArray(record.requirements) ||
    record.requirements.length === 0 ||
    record.requirements.length > MAX_PROMOTION_REQUIREMENTS
  ) {
    throw invalid('Promotion profile needs at least one invariant');
  }
  const requirements = record.requirements.map((requirement) => {
    const item = requireClosedRecord(requirement, ['invariantId', 'scope']);
    return Object.freeze({
      invariantId: requireInvariantId(item.invariantId),
      scope: requireIdentifier(item.scope, 'Requirement scope'),
    });
  });
  const sorted = [...requirements].sort((left, right) =>
    compareAscii(left.invariantId, right.invariantId),
  );
  if (
    requirements.some(
      (requirement, index) =>
        requirement.invariantId !== sorted[index]?.invariantId,
    )
  ) {
    throw invalid('Promotion requirements must be sorted by invariant ID');
  }
  if (
    new Set(requirements.map((requirement) => requirement.invariantId)).size !==
    requirements.length
  ) {
    throw invalid('Promotion requirements must be unique');
  }
  return Object.freeze({
    kind: PROMOTION_PROFILE_KIND,
    version: PROMOTION_ASSESSMENT_VERSION,
    profileId,
    targetGateId,
    environmentDigest: requireDigest(
      record.environmentDigest,
      'Environment digest',
    ),
    buildDigest: requireDigest(record.buildDigest, 'Build digest'),
    configurationDigest: requireDigest(
      record.configurationDigest,
      'Configuration digest',
    ),
    evidencePolicyDigest: requireDigest(
      record.evidencePolicyDigest,
      'Evidence policy digest',
    ),
    maxEvidenceAgeMs: requirePositiveBoundedInteger(
      record.maxEvidenceAgeMs,
      MAX_EVIDENCE_AGE_MS,
      'Maximum evidence age',
    ),
    allowedIssuerIds,
    requirements: Object.freeze(requirements),
  });
}

export function validatePromotionInvariantEvidence(
  value: unknown,
): PromotionInvariantEvidence {
  const record = requireClosedRecord(value, [
    'artifactDigest',
    'buildDigest',
    'configurationDigest',
    'environmentDigest',
    'evidencePolicyDigest',
    'expiresAt',
    'invariantId',
    'issuerId',
    'scope',
    'status',
    'verificationReceiptDigest',
    'verifiedAt',
  ]);
  const status = requireStatus(record.status);
  const verifiedAt = requireTimestamp(record.verifiedAt, 'Evidence verifiedAt');
  const expiresAt = requireTimestamp(record.expiresAt, 'Evidence expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(verifiedAt)) {
    throw invalid('Evidence expiry must be after verification time');
  }
  return Object.freeze({
    invariantId: requireInvariantId(record.invariantId),
    scope: requireIdentifier(record.scope, 'Evidence scope'),
    status,
    issuerId: requireIdentifier(record.issuerId, 'Evidence issuer ID'),
    artifactDigest: requireDigest(record.artifactDigest, 'Artifact digest'),
    verificationReceiptDigest: requireDigest(
      record.verificationReceiptDigest,
      'Evidence verification receipt digest',
    ),
    environmentDigest: requireDigest(
      record.environmentDigest,
      'Evidence environment digest',
    ),
    buildDigest: requireDigest(record.buildDigest, 'Evidence build digest'),
    configurationDigest: requireDigest(
      record.configurationDigest,
      'Evidence configuration digest',
    ),
    evidencePolicyDigest: requireDigest(
      record.evidencePolicyDigest,
      'Evidence policy digest',
    ),
    verifiedAt,
    expiresAt,
  });
}

function hashCanonical(
  domain: string,
  value: unknown,
  hash: PromotionHashPort,
): string {
  const digest = hash.sha256(
    encodeUtf8(`${domain}\0${canonicalizeJson(value as CanonicalJsonValue)}`),
  );
  return requireDigest(digest, 'Hash output');
}

function requireClosedRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  assertBoundedCanonicalData(value);
  let canonical: CanonicalJsonValue;
  try {
    canonical = parseCanonicalJson(
      canonicalizeJson(value as CanonicalJsonValue),
    );
  } catch (error) {
    throw new PromotionAssessmentError(
      'input-invalid',
      error instanceof Error ? error.message : 'Input is not canonical JSON',
    );
  }
  if (
    canonical === null ||
    Array.isArray(canonical) ||
    typeof canonical !== 'object'
  ) {
    throw invalid('Expected a closed object');
  }
  const keys = Object.keys(canonical).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw invalid('Object has unknown or missing fields');
  }
  return canonical as Record<string, unknown>;
}

function assertBoundedCanonicalData(value: unknown): void {
  inspectBoundedCanonicalData(
    value,
    new Set<object>(),
    { nodes: 0, stringCodeUnits: 0 },
    0,
  );
}

function inspectBoundedCanonicalData(
  value: unknown,
  ancestors: Set<object>,
  budget: { nodes: number; stringCodeUnits: number },
  depth: number,
): void {
  if (typeof value === 'string') {
    budget.stringCodeUnits += value.length;
    if (budget.stringCodeUnits > MAX_CANONICAL_STRING_CODE_UNITS) {
      throw invalid('Canonical input exceeds the string-size budget');
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
    throw invalid('Canonical input contains a non-data value');
  }
  if (depth >= MAX_CANONICAL_DEPTH) {
    throw invalid('Canonical input exceeds the depth budget');
  }
  if (ancestors.has(value)) throw invalid('Canonical input contains a cycle');
  budget.nodes += 1;
  if (budget.nodes > MAX_CANONICAL_NODES) {
    throw invalid('Canonical input exceeds the node budget');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = requireDenseDataArray(
        value,
        'Canonical input array',
        MAX_CANONICAL_ARRAY_LENGTH,
      );
      for (const entry of entries) {
        inspectBoundedCanonicalData(entry, ancestors, budget, depth + 1);
      }
      return;
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw invalid('Canonical input must use plain records');
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw invalid('Canonical input cannot contain symbol keys');
    }
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== Object.keys(value).length) {
      throw invalid('Canonical input cannot contain hidden fields');
    }
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !('value' in descriptor)) {
        throw invalid('Canonical input cannot contain accessors');
      }
      inspectBoundedCanonicalData(
        descriptor.value,
        ancestors,
        budget,
        depth + 1,
      );
    }
  } finally {
    ancestors.delete(value);
  }
}

function requireInputRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw invalid('Promotion assessment input must be a plain data wrapper');
  }
  const names = Object.getOwnPropertyNames(value);
  const keys = Object.keys(value).sort();
  if (
    names.length !== keys.length ||
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw invalid('Promotion assessment input has unknown or hidden fields');
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor)) {
      throw invalid('Promotion assessment input cannot contain accessors');
    }
  }
  return value as Record<string, unknown>;
}

function requireDenseDataArray(
  value: unknown,
  label: string,
  maximumLength: number,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumLength ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw invalid(`${label} is invalid or too large`);
  }
  const names = Object.getOwnPropertyNames(value);
  const keys = Object.keys(value);
  if (
    names.length !== value.length + 1 ||
    !names.includes('length') ||
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index))
  ) {
    throw invalid(`${label} must be dense and contain no extra fields`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw invalid(`${label} cannot contain accessors or hidden entries`);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function requireSortedUniqueIdentifiers(
  value: unknown,
  label: string,
): readonly string[] {
  const entries = requireDenseDataArray(value, label, 256).map((entry) =>
    requireIdentifier(entry, label),
  );
  if (entries.length === 0) throw invalid(`${label} cannot be empty`);
  for (let index = 1; index < entries.length; index += 1) {
    if (compareAscii(entries[index - 1]!, entries[index]!) >= 0) {
      throw invalid(`${label} must be sorted and unique`);
    }
  }
  return Object.freeze(entries);
}

function requirePositiveBoundedInteger(
  value: unknown,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw invalid(`${label} must be a positive bounded integer`);
  }
  return value;
}

function pinMethod<Port extends object, Name extends keyof Port>(
  port: Port,
  name: Name,
  label: string,
): Port[Name] {
  if (port === null || typeof port !== 'object') {
    throw invalid(`${label} is missing`);
  }
  let target: object | null = port;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw invalid(`${label} ${String(name)} must be a data method`);
      }
      return descriptor.value.bind(port) as Port[Name];
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  throw invalid(`${label} must provide ${String(name)}()`);
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw invalid(`${label} is invalid`);
  }
  return value;
}

function requireInvariantId(value: unknown): string {
  if (typeof value !== 'string' || !INVARIANT_PATTERN.test(value)) {
    throw invalid('Invariant ID is invalid');
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw invalid(`${label} is not a lowercase SHA-256 digest`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    throw invalid(`${label} is not canonical UTC`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw invalid(`${label} is not a real timestamp`);
  }
  const iso = new Date(milliseconds).toISOString();
  const canonical = iso.endsWith('.000Z') ? iso.replace('.000Z', 'Z') : iso;
  if (canonical !== value) throw invalid(`${label} is not canonical UTC`);
  return value;
}

function requireStatus(value: unknown): SecurityGuaranteeStatus {
  if (
    value !== 'ENFORCED' &&
    value !== 'TESTED' &&
    value !== 'IN_PROGRESS' &&
    value !== 'SPEC_ONLY' &&
    value !== 'BLOCKED' &&
    value !== 'NOT_APPLICABLE'
  ) {
    throw invalid('Security guarantee status is invalid');
  }
  return value;
}

function invalid(message: string): PromotionAssessmentError {
  return new PromotionAssessmentError('input-invalid', message);
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
