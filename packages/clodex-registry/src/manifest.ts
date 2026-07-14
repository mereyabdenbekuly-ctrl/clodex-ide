import {
  SIGNATURE_ALGORITHM,
  canonicalizeJson,
  createEnvelopePreAuthenticationEncoding,
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
  encodeUtf8,
  parseCanonicalJson,
  type EnvelopeSignature,
  type HashPort,
  type SafeCodingAction,
  type SafeCodingEffectClass,
  type SignedEnvelope,
} from '@clodex/contracts';

export const SCOPED_REGISTRY_MANIFEST_KIND =
  'clodex.scoped-registry-manifest' as const;
export const SCOPED_REGISTRY_MANIFEST_SPEC_VERSION = '1.0.0' as const;
export const SCOPED_REGISTRY_MANIFEST_PAYLOAD_TYPE =
  'application/vnd.clodex.scoped-registry-manifest.v1+jcs' as const;
export const SCOPED_REGISTRY_MANIFEST_HASH_DOMAIN =
  'clodex.scoped-registry-manifest.v1' as const;

export const MAX_SCOPED_REGISTRY_MEMBERS = 512;
export const MAX_SCOPED_REGISTRY_PAYLOAD_BYTES = 1024 * 1024;
export const MAX_SCOPED_REGISTRY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const P256_P1363_SIGNATURE_BYTES = 64;
const P256_ORDER = hexToBytes(
  'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
);
const P256_HALF_ORDER = hexToBytes(
  '7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8',
);

export type ScopedRegistryType = 'adapter' | 'effect' | 'runner';

export interface RegistryManifestIssuer {
  readonly issuerId: string;
  readonly keyId: string;
}

export interface RegistryManifestValidity {
  readonly notBefore: string;
  readonly expiresAt: string;
}

/** One exact adapter implementation for one exact operation. */
export interface AdapterRegistryMember {
  readonly kind: 'adapter';
  readonly adapterId: string;
  readonly adapterDigest: string;
  readonly operation: SafeCodingAction['action'];
  readonly argumentSchemaDigest: string;
  readonly effectId: string;
  readonly runnerId: string | null;
  readonly runnerDigest: string | null;
}

/** One digest-pinned runner/profile/image combination. */
export interface RunnerRegistryMember {
  readonly kind: 'runner';
  readonly runnerId: string;
  readonly runnerDigest: string;
  readonly profileId: string;
  readonly profileDigest: string;
  readonly imageDigest: string;
  readonly network: false;
  readonly credentials: false;
  readonly hostWorkspaceReadOnly: true;
  readonly disposableScratch: true;
}

export type RegistryCommitProtocol =
  | 'atomic-local-cas'
  | 'observation-only'
  | 'one-shot-commit-permit'
  | 'sandbox-ephemeral';

export type RegistryIdempotencyRule =
  | 'forbidden-retry'
  | 'not-applicable'
  | 'required';

export type RegistryObserverStrength =
  | 'adapter_observed'
  | 'independently_reconciled'
  | 'local_state_reconciled';

export type RegistryReconciliationRule =
  | 'not-required'
  | 'required-after-effect'
  | 'required-on-uncertain';

export type RegistryApprovalRule =
  | 'canonical-review-required'
  | 'contract-authority';

export type RegistrySecretHandlingRule =
  | 'forbidden'
  | 'isolated-broker-required';

/**
 * Complete authority-relevant classification for one effect. Model or MCP
 * metadata cannot override any field in this record.
 */
export interface EffectRegistryMember {
  readonly kind: 'effect';
  readonly effectId: string;
  readonly adapterId: string;
  readonly adapterDigest: string;
  readonly operation: SafeCodingAction['action'];
  readonly argumentSchemaDigest: string;
  readonly effectClass: SafeCodingEffectClass;
  readonly commitProtocol: RegistryCommitProtocol;
  readonly idempotency: RegistryIdempotencyRule;
  readonly observerStrength: RegistryObserverStrength;
  readonly reconciliation: RegistryReconciliationRule;
  readonly approval: RegistryApprovalRule;
  readonly secretHandling: RegistrySecretHandlingRule;
}

export type ScopedRegistryMember =
  | AdapterRegistryMember
  | EffectRegistryMember
  | RunnerRegistryMember;

interface ScopedRegistryManifestBase {
  readonly kind: typeof SCOPED_REGISTRY_MANIFEST_KIND;
  readonly specVersion: typeof SCOPED_REGISTRY_MANIFEST_SPEC_VERSION;
  readonly registryType: ScopedRegistryType;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly rootObjectId: string;
  readonly policyDigest: string;
  readonly configurationDigest: string;
  readonly buildDigest: string;
  readonly epoch: number;
  readonly previousManifestHash: string | null;
  readonly validity: RegistryManifestValidity;
  readonly issuer: RegistryManifestIssuer;
}

export interface AdapterRegistryManifest extends ScopedRegistryManifestBase {
  readonly registryType: 'adapter';
  readonly members: readonly AdapterRegistryMember[];
}

export interface EffectRegistryManifest extends ScopedRegistryManifestBase {
  readonly registryType: 'effect';
  readonly members: readonly EffectRegistryMember[];
}

export interface RunnerRegistryManifest extends ScopedRegistryManifestBase {
  readonly registryType: 'runner';
  readonly members: readonly RunnerRegistryMember[];
}

export type ScopedRegistryManifest =
  | AdapterRegistryManifest
  | EffectRegistryManifest
  | RunnerRegistryManifest;

export interface ParsedSignedScopedRegistryManifest {
  readonly manifest: ScopedRegistryManifest;
  readonly canonicalPayload: string;
  readonly envelope: SignedEnvelope;
  readonly signature: EnvelopeSignature;
  readonly message: Uint8Array;
}

export interface ScopedRegistryManifestSigningRequest {
  readonly manifest: ScopedRegistryManifest;
  readonly canonicalPayload: string;
  readonly payloadType: typeof SCOPED_REGISTRY_MANIFEST_PAYLOAD_TYPE;
  readonly message: Uint8Array;
}

export class RegistryManifestValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RegistryManifestValidationError';
  }
}

export function validateScopedRegistryManifest(
  value: unknown,
): ScopedRegistryManifest {
  assertCanonicalData(value, 'Scoped registry manifest');
  const record = requireRecord(value, 'Scoped registry manifest');
  requireExactKeys(
    record,
    [
      'kind',
      'specVersion',
      'registryType',
      'workspaceId',
      'taskId',
      'rootObjectId',
      'policyDigest',
      'configurationDigest',
      'buildDigest',
      'epoch',
      'previousManifestHash',
      'validity',
      'issuer',
      'members',
    ],
    'Scoped registry manifest',
  );
  requireLiteral(
    record.kind,
    SCOPED_REGISTRY_MANIFEST_KIND,
    'Registry manifest kind',
  );
  requireLiteral(
    record.specVersion,
    SCOPED_REGISTRY_MANIFEST_SPEC_VERSION,
    'Registry manifest specVersion',
  );
  const registryType = requireEnum(
    record.registryType,
    ['adapter', 'effect', 'runner'] as const,
    'Registry type',
  );
  const epoch = requirePositiveInteger(record.epoch, 'Registry epoch');
  const previousManifestHash = requireNullableDigest(
    record.previousManifestHash,
    'Previous manifest hash',
  );
  if (epoch === 1 && previousManifestHash !== null) {
    throw invalid('Registry epoch 1 must not name a previous manifest hash');
  }
  if (epoch > 1 && previousManifestHash === null) {
    throw invalid('Registry epochs after 1 must name a previous manifest hash');
  }

  const common = {
    kind: SCOPED_REGISTRY_MANIFEST_KIND,
    specVersion: SCOPED_REGISTRY_MANIFEST_SPEC_VERSION,
    workspaceId: requireIdentifier(record.workspaceId, 'Workspace ID'),
    taskId: requireIdentifier(record.taskId, 'Task ID'),
    rootObjectId: requireIdentifier(record.rootObjectId, 'Root object ID'),
    policyDigest: requireDigest(record.policyDigest, 'Policy digest'),
    configurationDigest: requireDigest(
      record.configurationDigest,
      'Configuration digest',
    ),
    buildDigest: requireDigest(record.buildDigest, 'Build digest'),
    epoch,
    previousManifestHash,
    validity: validateValidityInternal(record.validity),
    issuer: validateIssuerInternal(record.issuer),
  } as const;

  const rawMembers = requireArray(
    record.members,
    'Registry members',
    MAX_SCOPED_REGISTRY_MEMBERS,
  );
  if (registryType === 'adapter') {
    const members = rawMembers.map(validateAdapterMemberInternal);
    assertSortedUnique(
      members,
      (member) => `${member.adapterId}\0${member.operation}`,
      'Adapter registry members',
    );
    return assertManifestPayloadBound(
      deepFreeze({ ...common, registryType, members }),
    );
  }
  if (registryType === 'runner') {
    const members = rawMembers.map(validateRunnerMemberInternal);
    assertSortedUnique(
      members,
      (member) => `${member.runnerId}\0${member.profileId}`,
      'Runner registry members',
    );
    return assertManifestPayloadBound(
      deepFreeze({ ...common, registryType, members }),
    );
  }
  const members = rawMembers.map(validateEffectMemberInternal);
  assertSortedUnique(
    members,
    (member) => member.effectId,
    'Effect registry members',
  );
  return assertManifestPayloadBound(
    deepFreeze({ ...common, registryType, members }),
  );
}

export function validateAdapterRegistryMember(
  value: unknown,
): AdapterRegistryMember {
  assertCanonicalData(value, 'Adapter registry member');
  return validateAdapterMemberInternal(value);
}

export function validateRunnerRegistryMember(
  value: unknown,
): RunnerRegistryMember {
  assertCanonicalData(value, 'Runner registry member');
  return validateRunnerMemberInternal(value);
}

export function validateEffectRegistryMember(
  value: unknown,
): EffectRegistryMember {
  assertCanonicalData(value, 'Effect registry member');
  return validateEffectMemberInternal(value);
}

export function createScopedRegistryManifestSigningRequest(
  value: unknown,
): ScopedRegistryManifestSigningRequest {
  const manifest = validateScopedRegistryManifest(value);
  const canonicalPayload = canonicalizeJson(manifest);
  return Object.freeze({
    manifest,
    canonicalPayload,
    payloadType: SCOPED_REGISTRY_MANIFEST_PAYLOAD_TYPE,
    message: createEnvelopePreAuthenticationEncoding(
      SCOPED_REGISTRY_MANIFEST_PAYLOAD_TYPE,
      canonicalPayload,
    ),
  });
}

/**
 * Assemble a DSSE envelope around a signature produced by external key
 * custody. The signature key must be the issuer key committed by the payload.
 */
export function assembleSignedScopedRegistryManifest(
  manifestValue: unknown,
  signatureValue: unknown,
): SignedEnvelope {
  const request = createScopedRegistryManifestSigningRequest(manifestValue);
  assertCanonicalData(signatureValue, 'Registry envelope signature');
  const signature = validateEnvelopeSignature(signatureValue);
  if (signature.keyId !== request.manifest.issuer.keyId) {
    throw invalid('Envelope signer does not match the manifest issuer key');
  }
  const envelope: SignedEnvelope = {
    payloadType: SCOPED_REGISTRY_MANIFEST_PAYLOAD_TYPE,
    payload: encodeBase64Url(encodeUtf8(request.canonicalPayload)),
    signatures: [signature],
  };
  return parseSignedScopedRegistryManifest(envelope).envelope;
}

export function parseSignedScopedRegistryManifest(
  value: unknown,
): ParsedSignedScopedRegistryManifest {
  assertCanonicalData(value, 'Signed registry envelope');
  const record = requireRecord(value, 'Signed registry envelope');
  requireExactKeys(
    record,
    ['payloadType', 'payload', 'signatures'],
    'Signed registry envelope',
  );
  requireLiteral(
    record.payloadType,
    SCOPED_REGISTRY_MANIFEST_PAYLOAD_TYPE,
    'Registry envelope payload type',
  );
  if (typeof record.payload !== 'string') {
    throw invalid('Registry envelope payload must be base64url text');
  }
  const payloadBytes = decodeCanonicalBase64Url(
    record.payload,
    'Registry envelope payload',
  );
  if (payloadBytes.length > MAX_SCOPED_REGISTRY_PAYLOAD_BYTES) {
    throw invalid('Registry envelope payload exceeds the byte limit');
  }
  const signatureValues = requireArray(
    record.signatures,
    'Registry envelope signatures',
    1,
  );
  if (signatureValues.length !== 1) {
    throw invalid('Registry envelopes require exactly one issuer signature');
  }
  const signature = validateEnvelopeSignature(signatureValues[0]);
  const canonicalPayload = decodeCanonicalUtf8(payloadBytes);
  let parsedPayload: unknown;
  try {
    parsedPayload = parseCanonicalJson(canonicalPayload);
  } catch (error) {
    throw invalid(
      error instanceof Error
        ? `Registry payload is not canonical JSON: ${error.message}`
        : 'Registry payload is not canonical JSON',
    );
  }
  const manifest = validateScopedRegistryManifest(parsedPayload);
  if (canonicalizeJson(manifest) !== canonicalPayload) {
    throw invalid('Registry payload changed during closed-schema validation');
  }
  if (signature.keyId !== manifest.issuer.keyId) {
    throw invalid('Envelope signer does not match the manifest issuer key');
  }
  const envelope: SignedEnvelope = deepFreeze({
    payloadType: SCOPED_REGISTRY_MANIFEST_PAYLOAD_TYPE,
    payload: record.payload,
    signatures: [signature],
  });
  return Object.freeze({
    manifest,
    canonicalPayload,
    envelope,
    signature,
    message: createEnvelopePreAuthenticationEncoding(
      SCOPED_REGISTRY_MANIFEST_PAYLOAD_TYPE,
      canonicalPayload,
    ),
  });
}

export async function hashScopedRegistryManifest(
  value: unknown,
  hashPort: HashPort,
): Promise<string> {
  const manifest = validateScopedRegistryManifest(value);
  const sha256 = pinMethod(hashPort, 'sha256', 'Registry hash port');
  const digest = await sha256(
    encodeUtf8(
      `${SCOPED_REGISTRY_MANIFEST_HASH_DOMAIN}\0${canonicalizeJson(manifest)}`,
    ),
  );
  return requireDigest(digest, 'Registry hash result');
}

export function registryManifestMemberKey(
  member: ScopedRegistryMember,
): string {
  if (member.kind === 'adapter') {
    return `${member.adapterId}\0${member.operation}`;
  }
  if (member.kind === 'runner') {
    return `${member.runnerId}\0${member.profileId}`;
  }
  return member.effectId;
}

function validateAdapterMemberInternal(value: unknown): AdapterRegistryMember {
  const record = requireRecord(value, 'Adapter registry member');
  requireExactKeys(
    record,
    [
      'kind',
      'adapterId',
      'adapterDigest',
      'operation',
      'argumentSchemaDigest',
      'effectId',
      'runnerId',
      'runnerDigest',
    ],
    'Adapter registry member',
  );
  requireLiteral(record.kind, 'adapter', 'Adapter member kind');
  const runnerId = requireNullableIdentifier(record.runnerId, 'Runner ID');
  const runnerDigest = requireNullableDigest(
    record.runnerDigest,
    'Runner digest',
  );
  if ((runnerId === null) !== (runnerDigest === null)) {
    throw invalid('Adapter runner ID and digest must both be null or present');
  }
  const operation = requireSafeCodingOperation(record.operation);
  if (operation === 'test.run' && runnerId === null) {
    throw invalid('test.run adapters must bind an exact runner ID and digest');
  }
  if (operation !== 'test.run' && runnerId !== null) {
    throw invalid('Only test.run adapters may bind a runner');
  }
  return Object.freeze({
    kind: 'adapter',
    adapterId: requireIdentifier(record.adapterId, 'Adapter ID'),
    adapterDigest: requireDigest(record.adapterDigest, 'Adapter digest'),
    operation,
    argumentSchemaDigest: requireDigest(
      record.argumentSchemaDigest,
      'Argument schema digest',
    ),
    effectId: requireIdentifier(record.effectId, 'Effect ID'),
    runnerId,
    runnerDigest,
  });
}

function assertManifestPayloadBound<Manifest extends ScopedRegistryManifest>(
  manifest: Manifest,
): Manifest {
  if (
    encodeUtf8(canonicalizeJson(manifest)).length >
    MAX_SCOPED_REGISTRY_PAYLOAD_BYTES
  ) {
    throw invalid('Scoped registry manifest exceeds the payload byte limit');
  }
  return manifest;
}

function validateRunnerMemberInternal(value: unknown): RunnerRegistryMember {
  const record = requireRecord(value, 'Runner registry member');
  requireExactKeys(
    record,
    [
      'kind',
      'runnerId',
      'runnerDigest',
      'profileId',
      'profileDigest',
      'imageDigest',
      'network',
      'credentials',
      'hostWorkspaceReadOnly',
      'disposableScratch',
    ],
    'Runner registry member',
  );
  requireLiteral(record.kind, 'runner', 'Runner member kind');
  requireLiteral(record.network, false, 'Runner network authority');
  requireLiteral(record.credentials, false, 'Runner credential authority');
  requireLiteral(
    record.hostWorkspaceReadOnly,
    true,
    'Runner host-workspace mode',
  );
  requireLiteral(record.disposableScratch, true, 'Runner scratch durability');
  return Object.freeze({
    kind: 'runner',
    runnerId: requireIdentifier(record.runnerId, 'Runner ID'),
    runnerDigest: requireDigest(record.runnerDigest, 'Runner digest'),
    profileId: requireIdentifier(record.profileId, 'Runner profile ID'),
    profileDigest: requireDigest(record.profileDigest, 'Runner profile digest'),
    imageDigest: requireDigest(record.imageDigest, 'Runner image digest'),
    network: false,
    credentials: false,
    hostWorkspaceReadOnly: true,
    disposableScratch: true,
  });
}

function validateEffectMemberInternal(value: unknown): EffectRegistryMember {
  const record = requireRecord(value, 'Effect registry member');
  requireExactKeys(
    record,
    [
      'kind',
      'effectId',
      'adapterId',
      'adapterDigest',
      'operation',
      'argumentSchemaDigest',
      'effectClass',
      'commitProtocol',
      'idempotency',
      'observerStrength',
      'reconciliation',
      'approval',
      'secretHandling',
    ],
    'Effect registry member',
  );
  requireLiteral(record.kind, 'effect', 'Effect member kind');
  const operation = requireSafeCodingOperation(record.operation);
  const effectClass = requireEnum(
    record.effectClass,
    ['local.observation', 'local.reversible', 'sandbox.ephemeral'] as const,
    'Effect class',
  );
  const commitProtocol = requireEnum(
    record.commitProtocol,
    [
      'atomic-local-cas',
      'observation-only',
      'one-shot-commit-permit',
      'sandbox-ephemeral',
    ] as const,
    'Effect commit protocol',
  );
  assertOperationEffectSemantics(operation, effectClass, commitProtocol);
  return Object.freeze({
    kind: 'effect',
    effectId: requireIdentifier(record.effectId, 'Effect ID'),
    adapterId: requireIdentifier(record.adapterId, 'Effect adapter ID'),
    adapterDigest: requireDigest(record.adapterDigest, 'Effect adapter digest'),
    operation,
    argumentSchemaDigest: requireDigest(
      record.argumentSchemaDigest,
      'Effect argument schema digest',
    ),
    effectClass,
    commitProtocol,
    idempotency: requireEnum(
      record.idempotency,
      ['forbidden-retry', 'not-applicable', 'required'] as const,
      'Effect idempotency rule',
    ),
    observerStrength: requireEnum(
      record.observerStrength,
      [
        'adapter_observed',
        'independently_reconciled',
        'local_state_reconciled',
      ] as const,
      'Effect observer strength',
    ),
    reconciliation: requireEnum(
      record.reconciliation,
      [
        'not-required',
        'required-after-effect',
        'required-on-uncertain',
      ] as const,
      'Effect reconciliation rule',
    ),
    approval: requireEnum(
      record.approval,
      ['canonical-review-required', 'contract-authority'] as const,
      'Effect approval rule',
    ),
    secretHandling: requireEnum(
      record.secretHandling,
      ['forbidden', 'isolated-broker-required'] as const,
      'Effect secret-handling rule',
    ),
  });
}

function validateValidityInternal(value: unknown): RegistryManifestValidity {
  const record = requireRecord(value, 'Registry validity');
  requireExactKeys(record, ['notBefore', 'expiresAt'], 'Registry validity');
  const notBefore = requireTimestamp(record.notBefore, 'Registry notBefore');
  const expiresAt = requireTimestamp(record.expiresAt, 'Registry expiresAt');
  const duration = Date.parse(expiresAt) - Date.parse(notBefore);
  if (duration <= 0) {
    throw invalid('Registry expiry must be after notBefore');
  }
  if (duration > MAX_SCOPED_REGISTRY_LIFETIME_MS) {
    throw invalid('Registry validity exceeds the maximum lifetime');
  }
  return Object.freeze({ notBefore, expiresAt });
}

function validateIssuerInternal(value: unknown): RegistryManifestIssuer {
  const record = requireRecord(value, 'Registry issuer');
  requireExactKeys(record, ['issuerId', 'keyId'], 'Registry issuer');
  return Object.freeze({
    issuerId: requireIdentifier(record.issuerId, 'Registry issuer ID'),
    keyId: requireIdentifier(record.keyId, 'Registry issuer key ID'),
  });
}

function validateEnvelopeSignature(value: unknown): EnvelopeSignature {
  const record = requireRecord(value, 'Registry envelope signature');
  requireExactKeys(
    record,
    ['keyId', 'algorithm', 'signature'],
    'Registry envelope signature',
  );
  requireLiteral(
    record.algorithm,
    SIGNATURE_ALGORITHM,
    'Registry signature algorithm',
  );
  if (typeof record.signature !== 'string') {
    throw invalid('Registry signature must be base64url text');
  }
  if (record.signature.length !== 86) {
    throw invalid('Registry signature must encode exactly 64 bytes');
  }
  const signatureBytes = decodeCanonicalBase64Url(
    record.signature,
    'Registry signature',
  );
  if (signatureBytes.length !== P256_P1363_SIGNATURE_BYTES) {
    throw invalid('Registry signature must be a 64-byte P-256/P1363 value');
  }
  assertCanonicalP256P1363Signature(signatureBytes);
  return Object.freeze({
    keyId: requireIdentifier(record.keyId, 'Registry signature key ID'),
    algorithm: SIGNATURE_ALGORITHM,
    signature: record.signature,
  });
}

function decodeCanonicalBase64Url(value: string, label: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Url(value);
  } catch (error) {
    throw invalid(
      error instanceof Error
        ? `${label} is invalid: ${error.message}`
        : `${label} is invalid`,
    );
  }
  if (encodeBase64Url(decoded) !== value) {
    throw invalid(`${label} is not canonical unpadded base64url`);
  }
  return decoded;
}

function assertCanonicalP256P1363Signature(bytes: Uint8Array): void {
  const r = bytes.slice(0, 32);
  const s = bytes.slice(32, 64);
  if (isAllZero(r) || compareBigEndian(r, P256_ORDER) >= 0) {
    throw invalid('Registry signature has an out-of-range P-256 r value');
  }
  if (isAllZero(s) || compareBigEndian(s, P256_HALF_ORDER) > 0) {
    throw invalid('Registry signature must use canonical low-S P-256 form');
  }
}

function compareBigEndian(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}

function isAllZero(value: Uint8Array): boolean {
  for (const byte of value) {
    if (byte !== 0) return false;
  }
  return true;
}

function hexToBytes(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function decodeCanonicalUtf8(value: Uint8Array): string {
  try {
    return decodeUtf8(value);
  } catch (error) {
    throw invalid(
      error instanceof Error
        ? `Registry payload is not strict UTF-8: ${error.message}`
        : 'Registry payload is not strict UTF-8',
    );
  }
}

function assertCanonicalData(value: unknown, label: string): void {
  try {
    canonicalizeJson(value);
  } catch (error) {
    throw invalid(
      error instanceof Error
        ? `${label} is not closed canonical data: ${error.message}`
        : `${label} is not closed canonical data`,
    );
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw invalid(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw invalid(`${label} must contain exactly: ${expected.join(', ')}`);
  }
}

function requireArray(
  value: unknown,
  label: string,
  maximumLength: number,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw invalid(`${label} must be an ordinary array`);
  }
  if (value.length > maximumLength) {
    throw invalid(`${label} exceeds ${maximumLength} entries`);
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw invalid(`${label} is invalid`);
  }
  return value;
}

function requireSafeCodingOperation(
  value: unknown,
): SafeCodingAction['action'] {
  return requireEnum(
    value,
    [
      'filesystem.stat',
      'filesystem.list',
      'filesystem.read',
      'filesystem.create',
      'filesystem.replace',
      'filesystem.mkdir',
      'git.status',
      'git.diff',
      'test.run',
    ] as const,
    'Registry operation',
  );
}

function assertOperationEffectSemantics(
  operation: SafeCodingAction['action'],
  effectClass: SafeCodingEffectClass,
  commitProtocol: RegistryCommitProtocol,
): void {
  const expectedClass: SafeCodingEffectClass =
    operation === 'test.run'
      ? 'sandbox.ephemeral'
      : operation === 'filesystem.create' ||
          operation === 'filesystem.replace' ||
          operation === 'filesystem.mkdir'
        ? 'local.reversible'
        : 'local.observation';
  if (effectClass !== expectedClass) {
    throw invalid(
      `${operation} must use the fixed Safe Coding effect class ${expectedClass}`,
    );
  }
  if (
    (effectClass === 'local.observation' &&
      commitProtocol !== 'observation-only') ||
    (effectClass === 'sandbox.ephemeral' &&
      commitProtocol !== 'sandbox-ephemeral') ||
    (effectClass === 'local.reversible' &&
      commitProtocol !== 'atomic-local-cas' &&
      commitProtocol !== 'one-shot-commit-permit')
  ) {
    throw invalid(
      `Effect commit protocol ${commitProtocol} is incompatible with ${effectClass}`,
    );
  }
}

function requireNullableIdentifier(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : requireIdentifier(value, label);
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw invalid(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireNullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : requireDigest(value, label);
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    throw invalid(`${label} must be canonical UTC`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw invalid(`${label} must be a real timestamp`);
  }
  const iso = new Date(milliseconds).toISOString();
  const canonical = iso.endsWith('.000Z') ? iso.replace('.000Z', 'Z') : iso;
  if (canonical !== value) {
    throw invalid(`${label} must be canonical UTC`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalid(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function requireLiteral<Value>(
  value: unknown,
  expected: Value,
  label: string,
): Value {
  if (value !== expected) {
    throw invalid(`${label} must equal ${String(expected)}`);
  }
  return expected;
}

function requireEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw invalid(`${label} is invalid`);
  }
  return value as Values[number];
}

function assertSortedUnique<Value>(
  values: readonly Value[],
  key: (value: Value) => string,
  label: string,
): void {
  let previous: string | null = null;
  for (const value of values) {
    const current = key(value);
    if (previous !== null && current <= previous) {
      throw invalid(`${label} must be strictly sorted and unique`);
    }
    previous = current;
  }
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

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
  }
  return value;
}

function invalid(message: string): RegistryManifestValidationError {
  return new RegistryManifestValidationError(message);
}
