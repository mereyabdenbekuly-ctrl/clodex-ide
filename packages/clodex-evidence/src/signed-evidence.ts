import {
  EFFECT_ATTESTATION_PAYLOAD_TYPE,
  SIGNATURE_ALGORITHM,
  canonicalizeJson,
  createEnvelopePreAuthenticationEncoding,
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
  encodeUtf8,
  validateSafeCodingEffectAttestation,
  type HashPort,
  type SafeCodingEffectAttestation,
  type SignatureVerificationInput,
  type SignedEnvelope,
} from '@clodex/contracts';

export const EVIDENCE_CHAIN_SPEC_VERSION = '1.0.0' as const;
export const EVIDENCE_CHAIN_RECORD_KIND =
  'clodex.evidence-chain-record' as const;
export const EVIDENCE_CHECKPOINT_KIND = 'clodex.evidence-checkpoint' as const;
export const PROTECTED_CHECKPOINT_PUBLICATION_KIND =
  'clodex.protected-checkpoint-publication' as const;

export const SIGNED_EFFECT_ATTESTATION_HASH_DOMAIN =
  'clodex.signed-effect-attestation.v1' as const;
export const EVIDENCE_CHAIN_RECORD_HASH_DOMAIN =
  'clodex.evidence-chain-record.v1' as const;
export const EVIDENCE_CHECKPOINT_HASH_DOMAIN =
  'clodex.evidence-checkpoint.v1' as const;

export const EVIDENCE_VERIFICATION_LIMITS = Object.freeze({
  maximumRecords: 4096,
  maximumCanonicalPayloadBytes: 256 * 1024,
  maximumEnvelopeBytes: 384 * 1024,
  maximumAggregateEnvelopeBytes: 64 * 1024 * 1024,
} as const);

export const REQUIRED_EFFECT_SIGNER_ROLES = Object.freeze([
  'executor',
  'observer',
] as const);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type EffectAttestationSignerRole =
  (typeof REQUIRED_EFFECT_SIGNER_ROLES)[number];

export interface EffectAttestationSigningInput {
  readonly algorithm: typeof SIGNATURE_ALGORITHM;
  readonly message: Uint8Array;
}

/**
 * An injected signing capability. This package never loads, stores, or derives
 * a private key. A production implementation must keep that authority outside
 * this process and bind the returned identity to its real key registry.
 */
export interface EffectAttestationSigner {
  readonly keyId: string;
  readonly role: EffectAttestationSignerRole;
  readonly principalId: string;
  sign(input: EffectAttestationSigningInput): Uint8Array | Promise<Uint8Array>;
}

export interface EffectAttestationTrustedIdentity {
  readonly keyId: string;
  readonly role: EffectAttestationSignerRole;
  readonly principalId: string;
  /** Monotonic snapshot epoch owned by the trusted key registry. */
  readonly trustEpoch: number;
  /** Exact signer-trust registry snapshot under which this identity is active. */
  readonly registryDigest: string;
}

export interface EffectAttestationTrustAssertion {
  readonly identities: readonly EffectAttestationTrustedIdentity[];
  readonly trustEpoch: number;
  readonly registryDigest: string;
}

/** Trusted key identity lookup and signature verification are injected ports. */
export interface EffectAttestationSignatureVerifier {
  getTrustedIdentity(
    keyId: string,
  ):
    | EffectAttestationTrustedIdentity
    | null
    | Promise<EffectAttestationTrustedIdentity | null>;
  verify(input: SignatureVerificationInput): boolean | Promise<boolean>;
  /**
   * One synchronous atomic final fence for the complete identity set. It MUST
   * reject a stale/revoked epoch or registry and return exactly undefined.
   */
  assertTrusted(input: EffectAttestationTrustAssertion): void;
}

export interface VerifiedSignedEffectAttestation {
  readonly envelope: SignedEnvelope;
  readonly attestation: SafeCodingEffectAttestation;
  readonly canonicalPayload: string;
  readonly envelopeHash: string;
  readonly signerKeyIds: Readonly<Record<EffectAttestationSignerRole, string>>;
  readonly signerIdentities: readonly EffectAttestationTrustedIdentity[];
  readonly trustEpoch: number;
  readonly registryDigest: string;
}

export interface EvidenceChainRecord {
  readonly kind: typeof EVIDENCE_CHAIN_RECORD_KIND;
  readonly specVersion: typeof EVIDENCE_CHAIN_SPEC_VERSION;
  readonly ledgerId: string;
  readonly sequence: number;
  readonly previousRecordHash: string | null;
  readonly envelopeHash: string;
  readonly envelope: SignedEnvelope;
}

export interface EvidenceCheckpoint {
  readonly kind: typeof EVIDENCE_CHECKPOINT_KIND;
  readonly specVersion: typeof EVIDENCE_CHAIN_SPEC_VERSION;
  readonly ledgerId: string;
  readonly sequence: number;
  readonly headHash: string;
  readonly previousCheckpointHash: string | null;
}

/**
 * The proof is deliberately opaque to this package. Trust comes only from a
 * successful call to the configured ProtectedCheckpointPort.verify method.
 */
export interface ProtectedCheckpointPublication {
  readonly kind: typeof PROTECTED_CHECKPOINT_PUBLICATION_KIND;
  readonly specVersion: typeof EVIDENCE_CHAIN_SPEC_VERSION;
  readonly publicationId: string;
  readonly checkpoint: EvidenceCheckpoint;
  readonly proof: string;
}

export interface ProtectedCheckpointCasInput {
  readonly ledgerId: string;
  readonly expectedPublicationId: string | null;
  readonly expectedCheckpointHash: string | null;
  readonly checkpoint: EvidenceCheckpoint;
}

export type ProtectedCheckpointCasResult =
  | {
      readonly status: 'published';
      readonly publication: ProtectedCheckpointPublication;
    }
  | {
      readonly status: 'conflict';
      readonly current: ProtectedCheckpointPublication | null;
    };

/**
 * Port for a head stored in a protection domain independent from the ledger.
 * Implementations MUST make compareAndSwap linearizable. The in-memory port in
 * this package is only a test/reference adapter and provides no such external
 * protection or durability.
 */
export interface ProtectedCheckpointPort {
  load(ledgerId: string): unknown | Promise<unknown>;
  verify(
    publication: ProtectedCheckpointPublication,
  ): boolean | Promise<boolean>;
  compareAndSwap(
    input: ProtectedCheckpointCasInput,
  ): unknown | Promise<unknown>;
}

export interface VerifiedEvidenceChain {
  readonly ledgerId: string;
  readonly sequence: number;
  readonly headHash: string | null;
  readonly records: readonly EvidenceChainRecord[];
  readonly attestationIds: readonly string[];
  readonly requestIds: readonly string[];
  readonly ticketIds: readonly string[];
  readonly idempotencyKeys: readonly string[];
  readonly signerIdentities: readonly EffectAttestationTrustedIdentity[];
  readonly trustEpoch: number | null;
  readonly registryDigest: string | null;
  readonly aggregateEnvelopeBytes: number;
}

export type EvidenceErrorCode =
  | 'artifact-invalid'
  | 'checkpoint-conflict'
  | 'checkpoint-port-failed'
  | 'checkpoint-untrusted'
  | 'fork-detected'
  | 'hash-port-invalid'
  | 'replay-detected'
  | 'resource-limit-exceeded'
  | 'rollback-detected'
  | 'signature-invalid'
  | 'signer-invalid';

export class EvidenceError extends Error {
  public constructor(
    public readonly code: EvidenceErrorCode,
    message: string,
    public readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = 'EvidenceError';
  }
}

/**
 * Produce the exact closed DSSE-style envelope admitted by this package.
 * Exactly one executor and one observer signature are required.
 */
export async function signEffectAttestation(
  attestationValue: unknown,
  signersValue: readonly EffectAttestationSigner[],
): Promise<SignedEnvelope> {
  const attestation = validateAttestation(attestationValue);
  const signers = validateSigners(signersValue, attestation);
  const canonicalPayload = canonicalizeJson(attestation);
  const canonicalPayloadBytes = encodeUtf8(canonicalPayload);
  assertWithinLimit(
    canonicalPayloadBytes.length,
    EVIDENCE_VERIFICATION_LIMITS.maximumCanonicalPayloadBytes,
    'Effect Attestation canonical payload',
  );
  const message = createEnvelopePreAuthenticationEncoding(
    EFFECT_ATTESTATION_PAYLOAD_TYPE,
    canonicalPayload,
  );

  const signatures = [];
  for (const signer of signers) {
    let signatureValue: Uint8Array;
    try {
      signatureValue = await signer.sign({
        algorithm: SIGNATURE_ALGORITHM,
        message: message.slice(),
      });
    } catch (error) {
      throw new EvidenceError(
        'signer-invalid',
        `Effect Attestation signer ${signer.keyId} failed closed`,
        error,
      );
    }
    if (
      !(signatureValue instanceof Uint8Array) ||
      signatureValue.length !== 64
    ) {
      throw new EvidenceError(
        'signer-invalid',
        `Effect Attestation signer ${signer.keyId} must return exactly 64 signature bytes`,
      );
    }
    signatures.push(
      Object.freeze({
        keyId: signer.keyId,
        algorithm: SIGNATURE_ALGORITHM,
        signature: encodeBase64Url(signatureValue.slice()),
      }),
    );
  }

  return validateSignedEffectAttestationEnvelope({
    payloadType: EFFECT_ATTESTATION_PAYLOAD_TYPE,
    payload: encodeBase64Url(canonicalPayloadBytes),
    signatures,
  });
}

/** Verify canonical payload bytes, trusted identities, and both signatures. */
export async function verifySignedEffectAttestation(
  envelopeValue: unknown,
  dependencies: {
    readonly hash: HashPort;
    readonly signatures: EffectAttestationSignatureVerifier;
  },
): Promise<VerifiedSignedEffectAttestation> {
  const dependencyRecord = requireRecord(
    dependencies,
    'Signed Effect Attestation verification dependencies',
  );
  requireExactKeys(
    dependencyRecord,
    ['hash', 'signatures'],
    'Signed Effect Attestation verification dependencies',
  );
  const hash = pinHashPort(dependencyRecord.hash as HashPort);
  const signatures = pinSignatureVerifier(
    dependencyRecord.signatures as EffectAttestationSignatureVerifier,
  );
  const verified = await verifySignedEffectAttestationCandidate(envelopeValue, {
    hash,
    signatures,
  });
  // This is deliberately the only operation after the last await.
  assertTrustedSynchronously(signatures, verified.signerIdentities, {
    trustEpoch: verified.trustEpoch,
    registryDigest: verified.registryDigest,
  });
  return verified;
}

interface PinnedEffectAttestationSignatureVerifier {
  readonly getTrustedIdentity: EffectAttestationSignatureVerifier['getTrustedIdentity'];
  readonly verify: EffectAttestationSignatureVerifier['verify'];
  readonly assertTrusted: EffectAttestationSignatureVerifier['assertTrusted'];
}

async function verifySignedEffectAttestationCandidate(
  envelopeValue: unknown,
  dependencies: {
    readonly hash: HashPort;
    readonly signatures: PinnedEffectAttestationSignatureVerifier;
  },
): Promise<VerifiedSignedEffectAttestation> {
  const envelope = validateSignedEffectAttestationEnvelope(envelopeValue);
  const canonicalPayload = decodeCanonicalPayload(envelope);
  const attestation = validateAttestationFromCanonical(canonicalPayload);
  const message = createEnvelopePreAuthenticationEncoding(
    envelope.payloadType,
    canonicalPayload,
  );
  const signerKeyIds: Partial<Record<EffectAttestationSignerRole, string>> = {};
  const signerIdentities: EffectAttestationTrustedIdentity[] = [];
  let trustEpoch: number | null = null;
  let registryDigest: string | null = null;

  for (const signature of envelope.signatures) {
    let identityValue: EffectAttestationTrustedIdentity | null;
    try {
      identityValue = await dependencies.signatures.getTrustedIdentity(
        signature.keyId,
      );
    } catch (error) {
      throw new EvidenceError(
        'signature-invalid',
        `Trusted identity lookup failed for ${signature.keyId}`,
        error,
      );
    }
    if (identityValue === null) {
      throw new EvidenceError(
        'signature-invalid',
        `No trusted Effect Attestation identity exists for ${signature.keyId}`,
      );
    }
    const identity = validateTrustedIdentity(identityValue, signature.keyId);
    const expectedPrincipal =
      identity.role === 'executor'
        ? attestation.executorId
        : attestation.observerId;
    if (identity.principalId !== expectedPrincipal) {
      throw new EvidenceError(
        'signature-invalid',
        `${identity.role} key ${identity.keyId} is not bound to the attested principal`,
      );
    }
    if (
      (trustEpoch !== null && identity.trustEpoch !== trustEpoch) ||
      (registryDigest !== null && identity.registryDigest !== registryDigest)
    ) {
      throw new EvidenceError(
        'signature-invalid',
        'Effect Attestation signer identities come from mixed trust snapshots',
      );
    }
    trustEpoch = identity.trustEpoch;
    registryDigest = identity.registryDigest;
    if (signerKeyIds[identity.role] !== undefined) {
      throw new EvidenceError(
        'signature-invalid',
        `Effect Attestation contains more than one ${identity.role} signature`,
      );
    }

    let verified: boolean;
    try {
      verified = await dependencies.signatures.verify({
        algorithm: signature.algorithm,
        keyId: signature.keyId,
        signature: signature.signature,
        message: message.slice(),
      });
    } catch (error) {
      throw new EvidenceError(
        'signature-invalid',
        `Signature verification failed closed for ${signature.keyId}`,
        error,
      );
    }
    if (verified !== true) {
      throw new EvidenceError(
        'signature-invalid',
        `Effect Attestation signature is invalid for ${signature.keyId}`,
      );
    }
    signerKeyIds[identity.role] = identity.keyId;
    signerIdentities.push(identity);
  }

  for (const role of REQUIRED_EFFECT_SIGNER_ROLES) {
    if (signerKeyIds[role] === undefined) {
      throw new EvidenceError(
        'signature-invalid',
        `Effect Attestation is missing its trusted ${role} signature`,
      );
    }
  }

  if (trustEpoch === null || registryDigest === null) {
    throw new EvidenceError(
      'signature-invalid',
      'Effect Attestation has no complete trusted signer snapshot',
    );
  }
  const envelopeHash = await hashSignedEffectAttestationEnvelope(
    envelope,
    dependencies.hash,
  );
  signerIdentities.sort((left, right) =>
    compareStrings(left.keyId, right.keyId),
  );
  return Object.freeze({
    envelope,
    attestation,
    canonicalPayload,
    envelopeHash,
    signerKeyIds: Object.freeze({
      executor: signerKeyIds.executor!,
      observer: signerKeyIds.observer!,
    }),
    signerIdentities: Object.freeze(signerIdentities),
    trustEpoch,
    registryDigest,
  });
}

export function validateSignedEffectAttestationEnvelope(
  value: unknown,
): SignedEnvelope {
  try {
    const record = requireRecord(value, 'Signed Effect Attestation envelope');
    requireExactKeys(
      record,
      ['payloadType', 'payload', 'signatures'],
      'Signed Effect Attestation envelope',
    );
    if (record.payloadType !== EFFECT_ATTESTATION_PAYLOAD_TYPE) {
      artifactInvalid('Signed Effect Attestation payloadType is not accepted');
    }
    const payload = requireBase64Url(
      record.payload,
      'Signed Effect Attestation payload',
      1,
      maximumBase64UrlLength(
        EVIDENCE_VERIFICATION_LIMITS.maximumCanonicalPayloadBytes,
      ),
    );
    const signaturesValue = requireArray(
      record.signatures,
      'Signed Effect Attestation signatures',
      REQUIRED_EFFECT_SIGNER_ROLES.length,
    );
    if (signaturesValue.length !== REQUIRED_EFFECT_SIGNER_ROLES.length) {
      artifactInvalid(
        'Signed Effect Attestation must contain exactly two signatures',
      );
    }
    const signatures = signaturesValue.map((entry, index) => {
      const signature = requireRecord(
        entry,
        `Signed Effect Attestation signature ${index}`,
      );
      requireExactKeys(
        signature,
        ['keyId', 'algorithm', 'signature'],
        `Signed Effect Attestation signature ${index}`,
      );
      if (signature.algorithm !== SIGNATURE_ALGORITHM) {
        artifactInvalid(
          'Effect Attestation signature algorithm is not accepted',
        );
      }
      const encoded = requireBase64Url(
        signature.signature,
        'Effect Attestation signature bytes',
        86,
        86,
      );
      if (decodeBase64Url(encoded).length !== 64) {
        artifactInvalid('Effect Attestation signatures must be 64 bytes');
      }
      return Object.freeze({
        keyId: requireIdentifier(
          signature.keyId,
          'Effect Attestation signature key ID',
        ),
        algorithm: SIGNATURE_ALGORITHM,
        signature: encoded,
      });
    });
    assertSortedUnique(
      signatures.map((signature) => signature.keyId),
      'Effect Attestation signature key IDs',
    );

    const envelope = deepFreeze({
      payloadType: EFFECT_ATTESTATION_PAYLOAD_TYPE,
      payload,
      signatures,
    }) as SignedEnvelope;
    validateAttestationFromCanonical(decodeCanonicalPayload(envelope));
    assertWithinLimit(
      encodeUtf8(canonicalizeJson(envelope)).length,
      EVIDENCE_VERIFICATION_LIMITS.maximumEnvelopeBytes,
      'Signed Effect Attestation envelope',
    );
    return envelope;
  } catch (error) {
    throw asEvidenceError(error, 'Signed Effect Attestation is invalid');
  }
}

export function validateEvidenceChainRecord(
  value: unknown,
): EvidenceChainRecord {
  try {
    const record = requireRecord(value, 'Evidence chain record');
    requireExactKeys(
      record,
      [
        'kind',
        'specVersion',
        'ledgerId',
        'sequence',
        'previousRecordHash',
        'envelopeHash',
        'envelope',
      ],
      'Evidence chain record',
    );
    if (record.kind !== EVIDENCE_CHAIN_RECORD_KIND) {
      artifactInvalid('Evidence chain record kind is not accepted');
    }
    if (record.specVersion !== EVIDENCE_CHAIN_SPEC_VERSION) {
      artifactInvalid('Evidence chain record specVersion is not accepted');
    }
    const sequence = requirePositiveInteger(
      record.sequence,
      'Evidence chain sequence',
    );
    const previousRecordHash = requireNullableDigest(
      record.previousRecordHash,
      'Previous evidence record hash',
    );
    if ((sequence === 1) !== (previousRecordHash === null)) {
      artifactInvalid(
        'Only evidence sequence 1 may have a null previous record hash',
      );
    }
    const validated: EvidenceChainRecord = {
      kind: EVIDENCE_CHAIN_RECORD_KIND,
      specVersion: EVIDENCE_CHAIN_SPEC_VERSION,
      ledgerId: requireIdentifier(record.ledgerId, 'Evidence ledger ID'),
      sequence,
      previousRecordHash,
      envelopeHash: requireDigest(
        record.envelopeHash,
        'Signed Effect Attestation envelope hash',
      ),
      envelope: validateSignedEffectAttestationEnvelope(record.envelope),
    };
    canonicalizeJson(validated);
    return deepFreeze(validated);
  } catch (error) {
    throw asEvidenceError(error, 'Evidence chain record is invalid');
  }
}

export function validateEvidenceCheckpoint(value: unknown): EvidenceCheckpoint {
  try {
    const record = requireRecord(value, 'Evidence checkpoint');
    requireExactKeys(
      record,
      [
        'kind',
        'specVersion',
        'ledgerId',
        'sequence',
        'headHash',
        'previousCheckpointHash',
      ],
      'Evidence checkpoint',
    );
    if (record.kind !== EVIDENCE_CHECKPOINT_KIND) {
      artifactInvalid('Evidence checkpoint kind is not accepted');
    }
    if (record.specVersion !== EVIDENCE_CHAIN_SPEC_VERSION) {
      artifactInvalid('Evidence checkpoint specVersion is not accepted');
    }
    const sequence = requirePositiveInteger(
      record.sequence,
      'Evidence checkpoint sequence',
    );
    const previousCheckpointHash = requireNullableDigest(
      record.previousCheckpointHash,
      'Previous checkpoint hash',
    );
    if ((sequence === 1) !== (previousCheckpointHash === null)) {
      artifactInvalid(
        'Only evidence checkpoint sequence 1 may have a null previous hash',
      );
    }
    const checkpoint: EvidenceCheckpoint = {
      kind: EVIDENCE_CHECKPOINT_KIND,
      specVersion: EVIDENCE_CHAIN_SPEC_VERSION,
      ledgerId: requireIdentifier(record.ledgerId, 'Checkpoint ledger ID'),
      sequence,
      headHash: requireDigest(record.headHash, 'Checkpoint head hash'),
      previousCheckpointHash,
    };
    canonicalizeJson(checkpoint);
    return deepFreeze(checkpoint);
  } catch (error) {
    throw asEvidenceError(error, 'Evidence checkpoint is invalid');
  }
}

export function validateProtectedCheckpointPublication(
  value: unknown,
): ProtectedCheckpointPublication {
  try {
    const record = requireRecord(value, 'Protected checkpoint publication');
    requireExactKeys(
      record,
      ['kind', 'specVersion', 'publicationId', 'checkpoint', 'proof'],
      'Protected checkpoint publication',
    );
    if (record.kind !== PROTECTED_CHECKPOINT_PUBLICATION_KIND) {
      artifactInvalid('Protected checkpoint publication kind is not accepted');
    }
    if (record.specVersion !== EVIDENCE_CHAIN_SPEC_VERSION) {
      artifactInvalid(
        'Protected checkpoint publication specVersion is not accepted',
      );
    }
    const publication: ProtectedCheckpointPublication = {
      kind: PROTECTED_CHECKPOINT_PUBLICATION_KIND,
      specVersion: EVIDENCE_CHAIN_SPEC_VERSION,
      publicationId: requireIdentifier(
        record.publicationId,
        'Checkpoint publication ID',
      ),
      checkpoint: validateEvidenceCheckpoint(record.checkpoint),
      proof: requireBase64Url(
        record.proof,
        'Checkpoint publication proof',
        1,
        16 * 1024,
      ),
    };
    canonicalizeJson(publication);
    return deepFreeze(publication);
  } catch (error) {
    throw asEvidenceError(error, 'Protected checkpoint publication is invalid');
  }
}

export function validateProtectedCheckpointCasResult(
  value: unknown,
): ProtectedCheckpointCasResult {
  try {
    const record = requireRecord(value, 'Protected checkpoint CAS result');
    if (record.status === 'published') {
      requireExactKeys(
        record,
        ['status', 'publication'],
        'Published checkpoint CAS result',
      );
      return Object.freeze({
        status: 'published',
        publication: validateProtectedCheckpointPublication(record.publication),
      });
    }
    if (record.status === 'conflict') {
      requireExactKeys(
        record,
        ['status', 'current'],
        'Conflicting checkpoint CAS result',
      );
      return Object.freeze({
        status: 'conflict',
        current:
          record.current === null
            ? null
            : validateProtectedCheckpointPublication(record.current),
      });
    }
    artifactInvalid('Protected checkpoint CAS result status is not accepted');
  } catch (error) {
    throw asEvidenceError(error, 'Protected checkpoint CAS result is invalid');
  }
}

export function validateProtectedCheckpointCasInput(
  value: unknown,
): ProtectedCheckpointCasInput {
  try {
    const record = requireRecord(value, 'Protected checkpoint CAS input');
    requireExactKeys(
      record,
      [
        'ledgerId',
        'expectedPublicationId',
        'expectedCheckpointHash',
        'checkpoint',
      ],
      'Protected checkpoint CAS input',
    );
    const ledgerId = requireIdentifier(
      record.ledgerId,
      'Checkpoint CAS ledger ID',
    );
    const checkpoint = validateEvidenceCheckpoint(record.checkpoint);
    if (checkpoint.ledgerId !== ledgerId) {
      artifactInvalid('Checkpoint CAS input binds two different ledger IDs');
    }
    return Object.freeze({
      ledgerId,
      expectedPublicationId:
        record.expectedPublicationId === null
          ? null
          : requireIdentifier(
              record.expectedPublicationId,
              'Expected checkpoint publication ID',
            ),
      expectedCheckpointHash: requireNullableDigest(
        record.expectedCheckpointHash,
        'Expected checkpoint hash',
      ),
      checkpoint,
    });
  } catch (error) {
    throw asEvidenceError(error, 'Protected checkpoint CAS input is invalid');
  }
}

export async function hashSignedEffectAttestationEnvelope(
  envelope: unknown,
  hash: HashPort,
): Promise<string> {
  return await hashCanonicalArtifact(
    SIGNED_EFFECT_ATTESTATION_HASH_DOMAIN,
    validateSignedEffectAttestationEnvelope(envelope),
    hash,
  );
}

export async function hashEvidenceChainRecord(
  record: unknown,
  hash: HashPort,
): Promise<string> {
  return await hashCanonicalArtifact(
    EVIDENCE_CHAIN_RECORD_HASH_DOMAIN,
    validateEvidenceChainRecord(record),
    hash,
  );
}

export async function hashEvidenceCheckpoint(
  checkpoint: unknown,
  hash: HashPort,
): Promise<string> {
  return await hashCanonicalArtifact(
    EVIDENCE_CHECKPOINT_HASH_DOMAIN,
    validateEvidenceCheckpoint(checkpoint),
    hash,
  );
}

/**
 * Verify every signature, envelope digest, sequence, link, and one-shot
 * attestation identity in a chain. Empty chains are valid only as sequence 0.
 */
export async function verifyEvidenceChain(
  recordsValue: readonly unknown[],
  dependencies: {
    readonly ledgerId: string;
    readonly hash: HashPort;
    readonly signatures: EffectAttestationSignatureVerifier;
  },
): Promise<VerifiedEvidenceChain> {
  const dependencyRecord = requireRecord(
    dependencies,
    'Evidence chain verification dependencies',
  );
  requireExactKeys(
    dependencyRecord,
    ['ledgerId', 'hash', 'signatures'],
    'Evidence chain verification dependencies',
  );
  const ledgerId = requireIdentifier(
    dependencyRecord.ledgerId,
    'Evidence ledger ID',
  );
  const hash = pinHashPort(dependencyRecord.hash as HashPort);
  const signatures = pinSignatureVerifier(
    dependencyRecord.signatures as EffectAttestationSignatureVerifier,
  );
  const recordsInput = requireArray(
    recordsValue,
    'Evidence chain',
    EVIDENCE_VERIFICATION_LIMITS.maximumRecords,
  );
  assertWithinLimit(
    recordsInput.length,
    EVIDENCE_VERIFICATION_LIMITS.maximumRecords,
    'Evidence chain record count',
  );
  const validatedRecords: EvidenceChainRecord[] = [];
  let aggregateEnvelopeBytes = 0;
  for (const value of recordsInput) {
    const record = validateEvidenceChainRecord(value);
    aggregateEnvelopeBytes += encodeUtf8(
      canonicalizeJson(record.envelope),
    ).length;
    assertWithinLimit(
      aggregateEnvelopeBytes,
      EVIDENCE_VERIFICATION_LIMITS.maximumAggregateEnvelopeBytes,
      'Evidence chain aggregate envelope bytes',
    );
    validatedRecords.push(record);
  }
  const records: EvidenceChainRecord[] = [];
  const attestationIds = new Set<string>();
  const requestIds = new Set<string>();
  const ticketIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  const signerIdentities: EffectAttestationTrustedIdentity[] = [];
  let trustEpoch: number | null = null;
  let registryDigest: string | null = null;
  let previousRecordHash: string | null = null;

  for (let index = 0; index < validatedRecords.length; index += 1) {
    const record = validatedRecords[index]!;
    const expectedSequence = index + 1;
    if (record.ledgerId !== ledgerId) {
      throw new EvidenceError(
        'fork-detected',
        `Evidence record ${record.sequence} belongs to another ledger`,
      );
    }
    if (record.sequence !== expectedSequence) {
      throw new EvidenceError(
        'fork-detected',
        `Evidence sequence ${record.sequence} does not equal ${expectedSequence}`,
      );
    }
    if (record.previousRecordHash !== previousRecordHash) {
      throw new EvidenceError(
        'fork-detected',
        `Evidence record ${record.sequence} does not extend the exact prior head`,
      );
    }

    const verified = await verifySignedEffectAttestationCandidate(
      record.envelope,
      { hash, signatures },
    );
    if (record.envelopeHash !== verified.envelopeHash) {
      throw new EvidenceError(
        'fork-detected',
        `Evidence record ${record.sequence} has a mismatched envelope hash`,
      );
    }
    assertNotReplay(
      attestationIds,
      verified.attestation.attestationId,
      'attestation ID',
    );
    assertNotReplay(requestIds, verified.attestation.requestId, 'request ID');
    assertNotReplay(ticketIds, verified.attestation.ticketId, 'ticket ID');
    if (verified.attestation.idempotencyKey !== null) {
      assertNotReplay(
        idempotencyKeys,
        verified.attestation.idempotencyKey,
        'idempotency key',
      );
    }
    if (
      (trustEpoch !== null && verified.trustEpoch !== trustEpoch) ||
      (registryDigest !== null && verified.registryDigest !== registryDigest)
    ) {
      throw new EvidenceError(
        'signature-invalid',
        'Evidence chain spans mixed or stale signer trust snapshots',
      );
    }
    trustEpoch = verified.trustEpoch;
    registryDigest = verified.registryDigest;
    signerIdentities.push(...verified.signerIdentities);

    previousRecordHash = await hashEvidenceChainRecord(record, hash);
    records.push(record);
  }

  if (trustEpoch !== null && registryDigest !== null) {
    // One atomic synchronous assertion for every signer identity after the
    // final hash/signature await. No external operation follows this fence.
    assertTrustedSynchronously(signatures, signerIdentities, {
      trustEpoch,
      registryDigest,
    });
  }
  return Object.freeze({
    ledgerId,
    sequence: records.length,
    headHash: previousRecordHash,
    records: Object.freeze(records),
    attestationIds: Object.freeze([...attestationIds]),
    requestIds: Object.freeze([...requestIds]),
    ticketIds: Object.freeze([...ticketIds]),
    idempotencyKeys: Object.freeze([...idempotencyKeys]),
    signerIdentities: Object.freeze(signerIdentities),
    trustEpoch,
    registryDigest,
    aggregateEnvelopeBytes,
  });
}

export async function verifyProtectedCheckpoint(
  publicationValue: unknown,
  dependencies: {
    readonly checkpoints: ProtectedCheckpointPort;
    readonly ledgerId: string;
  },
): Promise<ProtectedCheckpointPublication> {
  const dependencyRecord = requireRecord(
    dependencies,
    'Protected checkpoint verification dependencies',
  );
  requireExactKeys(
    dependencyRecord,
    ['checkpoints', 'ledgerId'],
    'Protected checkpoint verification dependencies',
  );
  const ledgerId = requireIdentifier(
    dependencyRecord.ledgerId,
    'Evidence ledger ID',
  );
  const publication = validateProtectedCheckpointPublication(publicationValue);
  const verify = pinPortMethod(
    dependencyRecord.checkpoints as ProtectedCheckpointPort,
    'verify',
    'Protected checkpoint port',
  );
  if (publication.checkpoint.ledgerId !== ledgerId) {
    throw new EvidenceError(
      'fork-detected',
      'Protected checkpoint belongs to another evidence ledger',
    );
  }
  let verified: boolean;
  try {
    verified = await verify(publication);
  } catch (error) {
    throw new EvidenceError(
      'checkpoint-port-failed',
      'Protected checkpoint verification port failed closed',
      error,
    );
  }
  if (verified !== true) {
    throw new EvidenceError(
      'checkpoint-untrusted',
      'Protected checkpoint publication was not verified exactly true',
    );
  }
  return publication;
}

export function assertCheckpointMatchesChain(
  publication: ProtectedCheckpointPublication | null,
  chain: VerifiedEvidenceChain,
): void {
  if (publication === null) {
    if (chain.sequence !== 0 || chain.headHash !== null) {
      throw new EvidenceError(
        'rollback-detected',
        'Local evidence exists but the protected checkpoint is missing',
      );
    }
    return;
  }
  const checkpoint = publication.checkpoint;
  if (checkpoint.ledgerId !== chain.ledgerId) {
    throw new EvidenceError(
      'fork-detected',
      'Protected checkpoint belongs to another evidence ledger',
    );
  }
  if (checkpoint.sequence !== chain.sequence) {
    throw new EvidenceError(
      'rollback-detected',
      `Evidence sequence ${chain.sequence} disagrees with protected sequence ${checkpoint.sequence}`,
    );
  }
  if (checkpoint.headHash !== chain.headHash) {
    throw new EvidenceError(
      'fork-detected',
      'Evidence head does not match the independently verified checkpoint head',
    );
  }
}

export async function loadVerifiedCheckpoint(
  checkpoints: ProtectedCheckpointPort,
  ledgerId: string,
): Promise<ProtectedCheckpointPublication | null> {
  const validatedLedgerId = requireIdentifier(ledgerId, 'Evidence ledger ID');
  const load = pinPortMethod(checkpoints, 'load', 'Protected checkpoint port');
  const verify = pinPortMethod(
    checkpoints,
    'verify',
    'Protected checkpoint port',
  );
  const compareAndSwap = pinPortMethod(
    checkpoints,
    'compareAndSwap',
    'Protected checkpoint port',
  );
  let loaded: unknown;
  try {
    loaded = await load(validatedLedgerId);
  } catch (error) {
    throw new EvidenceError(
      'checkpoint-port-failed',
      'Protected checkpoint load failed closed',
      error,
    );
  }
  if (loaded === null) return null;
  if (loaded === undefined) {
    throw new EvidenceError(
      'checkpoint-port-failed',
      'Protected checkpoint load returned an invalid undefined result',
    );
  }
  return await verifyProtectedCheckpoint(loaded, {
    checkpoints: Object.freeze({
      load,
      verify,
      compareAndSwap,
    }),
    ledgerId: validatedLedgerId,
  });
}

function validateAttestation(value: unknown): SafeCodingEffectAttestation {
  try {
    // The contracts validator includes the mandatory status/evidence-level
    // semantic policy; evidence signing and verification cannot bypass it.
    const attestation = validateSafeCodingEffectAttestation(value);
    if (attestation.executorId === attestation.observerId) {
      throw new EvidenceError(
        'artifact-invalid',
        'Effect Attestation executor and observer principals must be distinct',
      );
    }
    return attestation;
  } catch (error) {
    throw new EvidenceError(
      'artifact-invalid',
      'Effect Attestation payload is invalid',
      error,
    );
  }
}

function validateAttestationFromCanonical(
  canonicalPayload: string,
): SafeCodingEffectAttestation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalPayload) as unknown;
  } catch (error) {
    throw new EvidenceError(
      'artifact-invalid',
      'Effect Attestation payload is not valid JSON',
      error,
    );
  }
  const attestation = validateAttestation(parsed);
  if (canonicalizeJson(attestation) !== canonicalPayload) {
    throw new EvidenceError(
      'artifact-invalid',
      'Effect Attestation payload bytes are not exact canonical JSON',
    );
  }
  return attestation;
}

function decodeCanonicalPayload(envelope: SignedEnvelope): string {
  try {
    const bytes = decodeBase64Url(envelope.payload);
    assertWithinLimit(
      bytes.length,
      EVIDENCE_VERIFICATION_LIMITS.maximumCanonicalPayloadBytes,
      'Effect Attestation canonical payload',
    );
    return decodeUtf8(bytes);
  } catch (error) {
    throw new EvidenceError(
      'artifact-invalid',
      'Effect Attestation payload is not strict canonical UTF-8/base64url',
      error,
    );
  }
}

function validateSigners(
  value: readonly EffectAttestationSigner[],
  attestation: SafeCodingEffectAttestation,
): readonly EffectAttestationSigner[] {
  const signers = requireArray(
    value,
    'Effect Attestation signers',
    REQUIRED_EFFECT_SIGNER_ROLES.length,
  );
  if (signers.length !== REQUIRED_EFFECT_SIGNER_ROLES.length) {
    throw new EvidenceError(
      'signer-invalid',
      'Effect Attestation signing requires exactly one executor and one observer signer',
    );
  }
  const roles = new Set<EffectAttestationSignerRole>();
  const keyIds = new Set<string>();
  const validated = signers.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new EvidenceError(
        'signer-invalid',
        `Effect Attestation signer ${index} is not an object`,
      );
    }
    const signer = entry as EffectAttestationSigner;
    const keyId = requireIdentifier(
      readDataProperty(signer, 'keyId', `Signer ${index}`),
      `Signer ${index} key ID`,
    );
    const role = requireSignerRole(
      readDataProperty(signer, 'role', `Signer ${index}`),
      `Signer ${index} role`,
    );
    const principalId = requireIdentifier(
      readDataProperty(signer, 'principalId', `Signer ${index}`),
      `Signer ${index} principal ID`,
    );
    let sign: EffectAttestationSigner['sign'];
    try {
      sign = pinPortMethod(
        signer,
        'sign',
        `Effect Attestation signer ${keyId}`,
      );
    } catch (error) {
      throw new EvidenceError(
        'signer-invalid',
        `Effect Attestation signer ${keyId} has no pinned signing method`,
        error,
      );
    }
    if (keyIds.has(keyId) || roles.has(role)) {
      throw new EvidenceError(
        'signer-invalid',
        'Effect Attestation signer keys and roles must be unique',
      );
    }
    const expectedPrincipal =
      role === 'executor' ? attestation.executorId : attestation.observerId;
    if (principalId !== expectedPrincipal) {
      throw new EvidenceError(
        'signer-invalid',
        `${role} signer is not bound to the attested principal`,
      );
    }
    keyIds.add(keyId);
    roles.add(role);
    return Object.freeze({
      keyId,
      role,
      principalId,
      sign,
    });
  });
  for (const role of REQUIRED_EFFECT_SIGNER_ROLES) {
    if (!roles.has(role)) {
      throw new EvidenceError(
        'signer-invalid',
        `Effect Attestation signing is missing the ${role} signer`,
      );
    }
  }
  validated.sort((left, right) => compareStrings(left.keyId, right.keyId));
  return Object.freeze(validated);
}

function validateTrustedIdentity(
  value: unknown,
  expectedKeyId: string,
): EffectAttestationTrustedIdentity {
  try {
    const record = requireRecord(value, 'Trusted signer identity');
    requireExactKeys(
      record,
      ['keyId', 'role', 'principalId', 'trustEpoch', 'registryDigest'],
      'Trusted signer identity',
    );
    const identity: EffectAttestationTrustedIdentity = {
      keyId: requireIdentifier(record.keyId, 'Trusted signer key ID'),
      role: requireSignerRole(record.role, 'Trusted signer role'),
      principalId: requireIdentifier(
        record.principalId,
        'Trusted signer principal ID',
      ),
      trustEpoch: requireNonNegativeInteger(
        record.trustEpoch,
        'Trusted signer epoch',
      ),
      registryDigest: requireDigest(
        record.registryDigest,
        'Trusted signer registry digest',
      ),
    };
    if (identity.keyId !== expectedKeyId) {
      artifactInvalid('Trusted signer lookup returned a different key ID');
    }
    return Object.freeze(identity);
  } catch (error) {
    throw new EvidenceError(
      'signature-invalid',
      `Trusted identity for ${expectedKeyId} is invalid`,
      error,
    );
  }
}

async function hashCanonicalArtifact(
  domain: string,
  value: unknown,
  hash: HashPort,
): Promise<string> {
  const sha256 = pinPortMethod(hash, 'sha256', 'Evidence hash port');
  const canonical = canonicalizeJson(value);
  const payload = encodeUtf8(canonical);
  const prefix = encodeUtf8(`${domain} ${payload.length} `);
  const message = concatenateBytes(prefix, payload);
  let digest: string;
  try {
    digest = await sha256(message.slice());
  } catch (error) {
    throw new EvidenceError(
      'hash-port-invalid',
      `Hash port failed for ${domain}`,
      error,
    );
  }
  if (typeof digest !== 'string' || !SHA256_PATTERN.test(digest)) {
    throw new EvidenceError(
      'hash-port-invalid',
      `Hash port returned a non-canonical SHA-256 digest for ${domain}`,
    );
  }
  return digest;
}

function concatenateBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const result = new Uint8Array(first.length + second.length);
  result.set(first, 0);
  result.set(second, first.length);
  return result;
}

function pinHashPort(hash: HashPort): HashPort {
  return Object.freeze({
    sha256: pinPortMethod(hash, 'sha256', 'Evidence hash port'),
  });
}

function pinSignatureVerifier(
  verifier: EffectAttestationSignatureVerifier,
): PinnedEffectAttestationSignatureVerifier {
  return Object.freeze({
    getTrustedIdentity: pinPortMethod(
      verifier,
      'getTrustedIdentity',
      'Effect Attestation signature verifier',
    ),
    verify: pinPortMethod(
      verifier,
      'verify',
      'Effect Attestation signature verifier',
    ),
    assertTrusted: pinPortMethod(
      verifier,
      'assertTrusted',
      'Effect Attestation signature verifier',
    ),
  });
}

function assertTrustedSynchronously(
  verifier: PinnedEffectAttestationSignatureVerifier,
  identitiesValue: readonly EffectAttestationTrustedIdentity[],
  expected: { readonly trustEpoch: number; readonly registryDigest: string },
): void {
  const identities = Object.freeze(
    identitiesValue.map((identity) =>
      validateTrustedIdentity(identity, identity.keyId),
    ),
  );
  if (identities.length === 0) {
    throw new EvidenceError(
      'signature-invalid',
      'Final trust fence requires at least one signer identity',
    );
  }
  for (const identity of identities) {
    if (
      identity.trustEpoch !== expected.trustEpoch ||
      identity.registryDigest !== expected.registryDigest
    ) {
      throw new EvidenceError(
        'signature-invalid',
        'Final signer set contains a mixed or stale trust snapshot',
      );
    }
  }
  try {
    const result = verifier.assertTrusted(
      Object.freeze({
        identities,
        trustEpoch: expected.trustEpoch,
        registryDigest: expected.registryDigest,
      }),
    );
    if (result !== undefined) {
      throw new EvidenceError(
        'signature-invalid',
        'Final signer trust fence must synchronously return undefined',
      );
    }
  } catch (error) {
    throw error instanceof EvidenceError
      ? error
      : new EvidenceError(
          'signature-invalid',
          'Final signer trust fence failed closed',
          error,
        );
  }
}

function pinPortMethod<Port extends object, Name extends keyof Port>(
  port: Port,
  name: Name,
  label: string,
): Port[Name] {
  if (
    port === null ||
    (typeof port !== 'object' && typeof port !== 'function')
  ) {
    throw new EvidenceError('artifact-invalid', `${label} is missing`);
  }
  let target: object | null = port;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw new EvidenceError(
          'artifact-invalid',
          `${label} ${String(name)} must be a data method`,
        );
      }
      return descriptor.value.bind(port) as Port[Name];
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  throw new EvidenceError(
    'artifact-invalid',
    `${label} must provide ${String(name)}()`,
  );
}

function readDataProperty<Port extends object, Name extends keyof Port>(
  port: Port,
  name: Name,
  label: string,
): Port[Name] {
  let target: object | null = port;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      if (!('value' in descriptor)) {
        throw new EvidenceError(
          'signer-invalid',
          `${label} ${String(name)} must be a data property`,
        );
      }
      return descriptor.value as Port[Name];
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  throw new EvidenceError(
    'signer-invalid',
    `${label} must provide ${String(name)}`,
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    artifactInvalid(`${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    artifactInvalid(`${label} must use a plain-record prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    artifactInvalid(`${label} cannot contain symbol keys`);
  }
  const names = Object.getOwnPropertyNames(value);
  const keys = Object.keys(value);
  if (names.length !== keys.length) {
    artifactInvalid(`${label} cannot hide non-enumerable fields`);
  }
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      artifactInvalid(`${label} cannot contain accessors`);
    }
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
    artifactInvalid(
      `${label} must contain exactly: ${sortedExpected.join(', ')}`,
    );
  }
}

function requireArray(
  value: unknown,
  label: string,
  maximumLength?: number,
): readonly unknown[] {
  if (!Array.isArray(value)) artifactInvalid(`${label} must be an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    artifactInvalid(`${label} must use the ordinary array prototype`);
  }
  if (maximumLength !== undefined && value.length > maximumLength) {
    throw new EvidenceError(
      'resource-limit-exceeded',
      `${label} exceeds the hard item-count limit of ${maximumLength}`,
    );
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    artifactInvalid(`${label} cannot contain symbol keys`);
  }
  const names = Object.getOwnPropertyNames(value);
  const enumerableKeys = Object.keys(value);
  if (
    names.length !== value.length + 1 ||
    names[names.length - 1] !== 'length' ||
    enumerableKeys.length !== value.length ||
    enumerableKeys.some((key, index) => key !== String(index))
  ) {
    artifactInvalid(`${label} cannot be sparse or contain extra fields`);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) {
      artifactInvalid(`${label} cannot contain accessors`);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    artifactInvalid(`${label} is not a canonical identifier`);
  }
  return value;
}

function requireSignerRole(
  value: unknown,
  label: string,
): EffectAttestationSignerRole {
  if (value !== 'executor' && value !== 'observer') {
    artifactInvalid(`${label} must be executor or observer`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 1) {
    artifactInvalid(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    artifactInvalid(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    artifactInvalid(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireNullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : requireDigest(value, label);
}

function requireBase64Url(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    !BASE64URL_PATTERN.test(value)
  ) {
    artifactInvalid(`${label} must be canonical unpadded base64url`);
  }
  try {
    decodeBase64Url(value);
  } catch (error) {
    throw new EvidenceError(
      'artifact-invalid',
      `${label} must be canonical unpadded base64url`,
      error,
    );
  }
  return value;
}

function maximumBase64UrlLength(byteLength: number): number {
  const padded = Math.ceil(byteLength / 3) * 4;
  const remainder = byteLength % 3;
  return padded - (remainder === 0 ? 0 : 3 - remainder);
}

function assertWithinLimit(
  actual: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(actual) || actual < 0 || actual > maximum) {
    throw new EvidenceError(
      'resource-limit-exceeded',
      `${label} exceeds the hard limit of ${maximum}`,
    );
  }
}

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareStrings(values[index - 1]!, values[index]!) >= 0) {
      artifactInvalid(`${label} must be sorted and unique`);
    }
  }
}

function assertNotReplay(
  values: Set<string>,
  value: string,
  label: string,
): void {
  if (values.has(value)) {
    throw new EvidenceError(
      'replay-detected',
      `Evidence chain reuses ${label} ${value}`,
    );
  }
  values.add(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function artifactInvalid(message: string): never {
  throw new EvidenceError('artifact-invalid', message);
}

function asEvidenceError(error: unknown, message: string): EvidenceError {
  return error instanceof EvidenceError
    ? error
    : new EvidenceError('artifact-invalid', message, error);
}
