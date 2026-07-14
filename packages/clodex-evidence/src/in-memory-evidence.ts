import {
  EVIDENCE_CHAIN_RECORD_KIND,
  EVIDENCE_CHAIN_SPEC_VERSION,
  EVIDENCE_CHECKPOINT_KIND,
  EVIDENCE_VERIFICATION_LIMITS,
  PROTECTED_CHECKPOINT_PUBLICATION_KIND,
  EvidenceError,
  assertCheckpointMatchesChain,
  hashEvidenceChainRecord,
  hashEvidenceCheckpoint,
  loadVerifiedCheckpoint,
  validateEvidenceChainRecord,
  validateEvidenceCheckpoint,
  validateProtectedCheckpointCasInput,
  validateProtectedCheckpointCasResult,
  validateProtectedCheckpointPublication,
  verifyEvidenceChain,
  verifyProtectedCheckpoint,
  verifySignedEffectAttestation,
  type EffectAttestationSignatureVerifier,
  type EffectAttestationTrustedIdentity,
  type EvidenceChainRecord,
  type EvidenceCheckpoint,
  type ProtectedCheckpointCasInput,
  type ProtectedCheckpointCasResult,
  type ProtectedCheckpointPort,
  type ProtectedCheckpointPublication,
  type VerifiedEvidenceChain,
} from './signed-evidence.js';
import {
  canonicalizeJson,
  encodeBase64Url,
  encodeUtf8,
  type HashPort,
} from '@clodex/contracts';

export const IN_MEMORY_EVIDENCE_PROFILE = Object.freeze({
  durability: 'memory-only',
  crashSafety: 'none',
  checkpointProtection: 'unprotected-reference',
  independentProtection: false,
  keyStorage: 'none',
  productionReady: false,
  verificationComplexity: 'full-chain-per-append',
  atomicCheckpointAndTrustTransaction: false,
  maximumRecords: EVIDENCE_VERIFICATION_LIMITS.maximumRecords,
  maximumAggregateEnvelopeBytes:
    EVIDENCE_VERIFICATION_LIMITS.maximumAggregateEnvelopeBytes,
} as const);

export interface InMemoryEvidenceLedgerOptions {
  readonly ledgerId: string;
  readonly hash: HashPort;
  readonly signatures: EffectAttestationSignatureVerifier;
  readonly checkpoints: ProtectedCheckpointPort;
  readonly initialRecords?: readonly unknown[];
}

export interface EvidenceAppendResult {
  readonly record: EvidenceChainRecord;
  readonly recordHash: string;
  readonly publication: ProtectedCheckpointPublication;
}

export interface EvidenceLedgerIntegrity {
  readonly chain: VerifiedEvidenceChain;
  readonly publication: ProtectedCheckpointPublication | null;
}

/**
 * Memory-only reference ledger. It is not durable, crash-safe, independently
 * protected, or an atomic substitute for a production ledger/head transaction.
 * Its purpose is to exercise the admission protocol and make rollback/fork
 * failures explicit before a durable adapter exists.
 */
export class InMemoryEvidenceLedger {
  public readonly durability = IN_MEMORY_EVIDENCE_PROFILE.durability;
  public readonly crashSafety = IN_MEMORY_EVIDENCE_PROFILE.crashSafety;
  public readonly independentProtection = false as const;
  public readonly atomicCheckpointAndTrustTransaction = false as const;

  readonly #ledgerId: string;
  readonly #hash: HashPort;
  readonly #signatures: EffectAttestationSignatureVerifier;
  readonly #checkpoints: ProtectedCheckpointPort;
  #records: readonly EvidenceChainRecord[];

  public constructor(options: InMemoryEvidenceLedgerOptions) {
    const resolved = snapshotEvidenceLedgerOptions(options);
    assertLedgerId(resolved.ledgerId);
    assertDependencies(resolved);
    this.#ledgerId = resolved.ledgerId;
    this.#hash = Object.freeze({
      sha256: pinPortMethod(resolved.hash, 'sha256', 'Evidence hash port'),
    });
    this.#signatures = Object.freeze({
      getTrustedIdentity: pinPortMethod(
        resolved.signatures,
        'getTrustedIdentity',
        'Evidence signature verifier',
      ),
      verify: pinPortMethod(
        resolved.signatures,
        'verify',
        'Evidence signature verifier',
      ),
      assertTrusted: pinPortMethod(
        resolved.signatures,
        'assertTrusted',
        'Evidence signature verifier',
      ),
    });
    this.#checkpoints = Object.freeze({
      load: pinPortMethod(
        resolved.checkpoints,
        'load',
        'Protected checkpoint port',
      ),
      verify: pinPortMethod(
        resolved.checkpoints,
        'verify',
        'Protected checkpoint port',
      ),
      compareAndSwap: pinPortMethod(
        resolved.checkpoints,
        'compareAndSwap',
        'Protected checkpoint port',
      ),
    });
    const initialRecords = snapshotInitialRecords(
      resolved.initialRecords ?? [],
    );
    const validatedRecords: EvidenceChainRecord[] = [];
    let aggregateEnvelopeBytes = 0;
    for (const value of initialRecords) {
      const record = validateEvidenceChainRecord(value);
      aggregateEnvelopeBytes += encodeUtf8(
        canonicalizeJson(record.envelope),
      ).length;
      if (
        aggregateEnvelopeBytes >
        EVIDENCE_VERIFICATION_LIMITS.maximumAggregateEnvelopeBytes
      ) {
        throw new EvidenceError(
          'resource-limit-exceeded',
          'Initial evidence records exceed the aggregate envelope-byte limit',
        );
      }
      validatedRecords.push(record);
    }
    this.#records = Object.freeze(validatedRecords);
  }

  public async append(envelope: unknown): Promise<EvidenceAppendResult> {
    // Re-verify the complete local history and protected anchor before every
    // admission. A compromised restore therefore cannot become a trusted base.
    const chain = await this.verifyLocalChain();
    const previousPublication = await loadVerifiedCheckpoint(
      this.#checkpoints,
      this.#ledgerId,
    );
    assertCheckpointMatchesChain(previousPublication, chain);
    if (chain.sequence >= EVIDENCE_VERIFICATION_LIMITS.maximumRecords) {
      throw new EvidenceError(
        'resource-limit-exceeded',
        'Evidence ledger reached its hard record-count limit',
      );
    }

    const incoming = await verifySignedEffectAttestation(envelope, {
      hash: this.#hash,
      signatures: this.#signatures,
    });
    const incomingEnvelopeBytes = encodeUtf8(
      canonicalizeJson(incoming.envelope),
    ).length;
    if (
      chain.aggregateEnvelopeBytes + incomingEnvelopeBytes >
      EVIDENCE_VERIFICATION_LIMITS.maximumAggregateEnvelopeBytes
    ) {
      throw new EvidenceError(
        'resource-limit-exceeded',
        'Evidence ledger reached its hard aggregate envelope-byte limit',
      );
    }
    assertIncomingIsUnique(chain, incoming.attestation);

    const record = validateEvidenceChainRecord({
      kind: EVIDENCE_CHAIN_RECORD_KIND,
      specVersion: EVIDENCE_CHAIN_SPEC_VERSION,
      ledgerId: this.#ledgerId,
      sequence: chain.sequence + 1,
      previousRecordHash: chain.headHash,
      envelopeHash: incoming.envelopeHash,
      envelope: incoming.envelope,
    });
    const recordHash = await hashEvidenceChainRecord(record, this.#hash);
    const previousCheckpointHash =
      previousPublication === null
        ? null
        : await hashEvidenceCheckpoint(
            previousPublication.checkpoint,
            this.#hash,
          );
    const checkpoint = validateEvidenceCheckpoint({
      kind: EVIDENCE_CHECKPOINT_KIND,
      specVersion: EVIDENCE_CHAIN_SPEC_VERSION,
      ledgerId: this.#ledgerId,
      sequence: record.sequence,
      headHash: recordHash,
      previousCheckpointHash,
    });

    const casResult = await this.publishCheckpoint({
      ledgerId: this.#ledgerId,
      expectedPublicationId: previousPublication?.publicationId ?? null,
      expectedCheckpointHash: previousCheckpointHash,
      checkpoint,
    });
    if (casResult.status === 'conflict') {
      return await this.classifyConflict(casResult.current, checkpoint);
    }

    const publication = await this.verifyPublishedResult(
      casResult.publication,
      checkpoint,
    );

    // A protected checkpoint port and signer trust registry are independent
    // external protection domains, so this reference cannot make their update
    // atomic. We re-fence the complete identity set after the final await; a
    // failure leaves local state untouched but may require checkpoint repair.
    assertCombinedTrustSynchronously(
      this.#signatures,
      chain,
      incoming.signerIdentities,
      incoming.trustEpoch,
      incoming.registryDigest,
    );

    // Mutation happens only after CAS, publication verification, and an exact
    // read-after-publish check. Any ambiguity leaves local state untouched.
    this.#records = Object.freeze([...chain.records, record]);
    return Object.freeze({ record, recordHash, publication });
  }

  public async verifyIntegrity(): Promise<EvidenceLedgerIntegrity> {
    const chain = await this.verifyLocalChain();
    const publication = await loadVerifiedCheckpoint(
      this.#checkpoints,
      this.#ledgerId,
    );
    assertCheckpointMatchesChain(publication, chain);
    assertChainTrustSynchronously(this.#signatures, chain);
    return Object.freeze({ chain, publication });
  }

  /** Detached, immutable records suitable only for reference/test restore. */
  public snapshot(): readonly EvidenceChainRecord[] {
    return Object.freeze(
      this.#records.map((record) => validateEvidenceChainRecord(record)),
    );
  }

  private async verifyLocalChain(): Promise<VerifiedEvidenceChain> {
    return await verifyEvidenceChain(this.#records, {
      ledgerId: this.#ledgerId,
      hash: this.#hash,
      signatures: this.#signatures,
    });
  }

  private async publishCheckpoint(
    input: ProtectedCheckpointCasInput,
  ): Promise<ProtectedCheckpointCasResult> {
    let result: unknown;
    try {
      result = await this.#checkpoints.compareAndSwap(input);
    } catch (error) {
      throw new EvidenceError(
        'checkpoint-port-failed',
        'Protected checkpoint CAS failed closed',
        error,
      );
    }
    return validateProtectedCheckpointCasResult(result);
  }

  private async classifyConflict(
    currentValue: ProtectedCheckpointPublication | null,
    proposed: EvidenceCheckpoint,
  ): Promise<never> {
    if (currentValue === null) {
      throw new EvidenceError(
        'rollback-detected',
        'Protected checkpoint disappeared during compare-and-swap',
      );
    }
    const current = await verifyProtectedCheckpoint(currentValue, {
      checkpoints: this.#checkpoints,
      ledgerId: this.#ledgerId,
    });
    if (
      current.checkpoint.sequence === proposed.sequence &&
      current.checkpoint.headHash !== proposed.headHash
    ) {
      throw new EvidenceError(
        'fork-detected',
        'A competing evidence head won the protected checkpoint CAS',
      );
    }
    throw new EvidenceError(
      'checkpoint-conflict',
      'Protected checkpoint changed during evidence admission',
    );
  }

  private async verifyPublishedResult(
    publicationValue: ProtectedCheckpointPublication,
    expectedCheckpoint: EvidenceCheckpoint,
  ): Promise<ProtectedCheckpointPublication> {
    const publication = await verifyProtectedCheckpoint(publicationValue, {
      checkpoints: this.#checkpoints,
      ledgerId: this.#ledgerId,
    });
    if (
      canonicalizeJson(publication.checkpoint) !==
      canonicalizeJson(expectedCheckpoint)
    ) {
      throw new EvidenceError(
        'fork-detected',
        'Checkpoint port published a different head than requested',
      );
    }

    const loaded = await loadVerifiedCheckpoint(
      this.#checkpoints,
      this.#ledgerId,
    );
    if (
      loaded === null ||
      canonicalizeJson(loaded) !== canonicalizeJson(publication)
    ) {
      throw new EvidenceError(
        'checkpoint-port-failed',
        'Protected checkpoint failed exact read-after-publish verification',
      );
    }
    return publication;
  }
}

export interface InMemoryUnprotectedCheckpointPortOptions {
  readonly hash: HashPort;
}

interface StoredPublication {
  readonly publication: ProtectedCheckpointPublication;
  readonly checkpointHash: string;
}

/**
 * Explicitly unprotected, memory-only CAS adapter for tests and reference use.
 * Its proof is only a canonical marker; it is not a signature or trust anchor.
 */
export class InMemoryUnprotectedCheckpointPort
  implements ProtectedCheckpointPort
{
  public readonly durability = 'memory-only' as const;
  public readonly protection = 'none' as const;
  public readonly independentlyProtected = false as const;

  readonly #hash: HashPort;
  readonly #publications = new Map<string, StoredPublication>();
  #nextPublicationId = 1;

  public constructor(options: InMemoryUnprotectedCheckpointPortOptions) {
    const hash = snapshotCheckpointOptions(options);
    if (!hasDataMethod(hash, 'sha256')) {
      throw new EvidenceError(
        'checkpoint-port-failed',
        'In-memory checkpoint port requires a hash function',
      );
    }
    this.#hash = Object.freeze({
      sha256: pinPortMethod(hash, 'sha256', 'Checkpoint hash port'),
    });
  }

  public load(ledgerId: string): ProtectedCheckpointPublication | null {
    assertLedgerId(ledgerId);
    const stored = this.#publications.get(ledgerId);
    return stored
      ? validateProtectedCheckpointPublication(stored.publication)
      : null;
  }

  public verify(publicationValue: ProtectedCheckpointPublication): boolean {
    let publication: ProtectedCheckpointPublication;
    try {
      publication = validateProtectedCheckpointPublication(publicationValue);
    } catch {
      return false;
    }
    const current = this.#publications.get(publication.checkpoint.ledgerId);
    return (
      current !== undefined &&
      canonicalizeJson(current.publication) === canonicalizeJson(publication)
    );
  }

  public async compareAndSwap(
    inputValue: ProtectedCheckpointCasInput,
  ): Promise<ProtectedCheckpointCasResult> {
    const input = validateProtectedCheckpointCasInput(inputValue);
    const checkpoint = input.checkpoint;

    // Hash before observing mutable state. After this await, the comparison and
    // publication below form one synchronous in-isolate CAS boundary.
    const checkpointHash = await hashEvidenceCheckpoint(checkpoint, this.#hash);

    const current = this.#publications.get(input.ledgerId);
    if (
      (current?.publication.publicationId ?? null) !==
        input.expectedPublicationId ||
      (current?.checkpointHash ?? null) !== input.expectedCheckpointHash
    ) {
      return Object.freeze({
        status: 'conflict',
        current: current
          ? validateProtectedCheckpointPublication(current.publication)
          : null,
      });
    }

    const expectedSequence =
      (current?.publication.checkpoint.sequence ?? 0) + 1;
    if (
      checkpoint.sequence !== expectedSequence ||
      checkpoint.previousCheckpointHash !== (current?.checkpointHash ?? null)
    ) {
      throw new EvidenceError(
        'fork-detected',
        'Checkpoint CAS proposal does not extend the exact current checkpoint',
      );
    }

    const publicationId = `memory:unprotected:${this.#nextPublicationId}`;
    this.#nextPublicationId = safeIncrement(this.#nextPublicationId);
    const proof = encodeBase64Url(
      encodeUtf8(`UNPROTECTED:${publicationId}:${checkpointHash}`),
    );
    const publication = validateProtectedCheckpointPublication({
      kind: PROTECTED_CHECKPOINT_PUBLICATION_KIND,
      specVersion: EVIDENCE_CHAIN_SPEC_VERSION,
      publicationId,
      checkpoint,
      proof,
    });
    this.#publications.set(input.ledgerId, {
      publication,
      checkpointHash,
    });
    return Object.freeze({ status: 'published', publication });
  }
}

function assertDependencies(options: InMemoryEvidenceLedgerOptions): void {
  if (!hasDataMethod(options.hash, 'sha256')) {
    throw new EvidenceError(
      'hash-port-invalid',
      'Evidence hash port is invalid',
    );
  }
  if (
    !hasDataMethod(options.signatures, 'getTrustedIdentity') ||
    !hasDataMethod(options.signatures, 'verify') ||
    !hasDataMethod(options.signatures, 'assertTrusted')
  ) {
    throw new EvidenceError(
      'signature-invalid',
      'Evidence signature verifier port is invalid',
    );
  }
  if (
    !hasDataMethod(options.checkpoints, 'load') ||
    !hasDataMethod(options.checkpoints, 'verify') ||
    !hasDataMethod(options.checkpoints, 'compareAndSwap')
  ) {
    throw new EvidenceError(
      'checkpoint-port-failed',
      'Protected checkpoint port is invalid',
    );
  }
}

function snapshotEvidenceLedgerOptions(
  value: InMemoryEvidenceLedgerOptions,
): InMemoryEvidenceLedgerOptions {
  const record = requireOptionsRecord(
    value,
    ['ledgerId', 'hash', 'signatures', 'checkpoints'],
    ['initialRecords'],
    'In-memory evidence ledger options',
  );
  return Object.freeze({
    ledgerId: record.ledgerId as string,
    hash: record.hash as HashPort,
    signatures: record.signatures as EffectAttestationSignatureVerifier,
    checkpoints: record.checkpoints as ProtectedCheckpointPort,
    ...(record.initialRecords === undefined
      ? {}
      : { initialRecords: record.initialRecords as readonly unknown[] }),
  });
}

function snapshotCheckpointOptions(
  value: InMemoryUnprotectedCheckpointPortOptions,
): HashPort {
  const record = requireOptionsRecord(
    value,
    ['hash'],
    [],
    'In-memory checkpoint options',
  );
  return record.hash as HashPort;
}

function requireOptionsRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new EvidenceError(
      'artifact-invalid',
      `${label} must be a plain record`,
    );
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== Object.keys(value).length) {
    throw new EvidenceError(
      'artifact-invalid',
      `${label} cannot contain hidden fields`,
    );
  }
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !names.includes(key)) ||
    names.some((key) => !allowed.has(key))
  ) {
    throw new EvidenceError(
      'artifact-invalid',
      `${label} has unknown or missing fields`,
    );
  }
  const snapshot: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      !descriptor ||
      !('value' in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new EvidenceError(
        'artifact-invalid',
        `${label} cannot contain accessors`,
      );
    }
    snapshot[name] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function hasDataMethod(value: unknown, name: string): boolean {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return false;
  }
  let target: object | null = value;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      return 'value' in descriptor && typeof descriptor.value === 'function';
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  return false;
}

function assertIncomingIsUnique(
  chain: VerifiedEvidenceChain,
  attestation: {
    readonly attestationId: string;
    readonly requestId: string;
    readonly ticketId: string;
    readonly idempotencyKey: string | null;
  },
): void {
  const checks = [
    ['attestation ID', attestation.attestationId, chain.attestationIds],
    ['request ID', attestation.requestId, chain.requestIds],
    ['ticket ID', attestation.ticketId, chain.ticketIds],
    ...(attestation.idempotencyKey === null
      ? []
      : [
          [
            'idempotency key',
            attestation.idempotencyKey,
            chain.idempotencyKeys,
          ] as const,
        ]),
  ] as const;
  for (const [label, value, existing] of checks) {
    if (existing.includes(value)) {
      throw new EvidenceError(
        'replay-detected',
        `Evidence admission reuses ${label} ${value}`,
      );
    }
  }
}

function assertCombinedTrustSynchronously(
  verifier: EffectAttestationSignatureVerifier,
  chain: VerifiedEvidenceChain,
  incomingIdentities: readonly EffectAttestationTrustedIdentity[],
  incomingTrustEpoch: number,
  incomingRegistryDigest: string,
): void {
  if (
    (chain.trustEpoch !== null && chain.trustEpoch !== incomingTrustEpoch) ||
    (chain.registryDigest !== null &&
      chain.registryDigest !== incomingRegistryDigest)
  ) {
    throw new EvidenceError(
      'signature-invalid',
      'Incoming evidence does not share the current chain trust snapshot',
    );
  }
  assertTrustSynchronously(
    verifier,
    Object.freeze([...chain.signerIdentities, ...incomingIdentities]),
    incomingTrustEpoch,
    incomingRegistryDigest,
  );
}

function assertChainTrustSynchronously(
  verifier: EffectAttestationSignatureVerifier,
  chain: VerifiedEvidenceChain,
): void {
  if (chain.trustEpoch === null || chain.registryDigest === null) return;
  assertTrustSynchronously(
    verifier,
    chain.signerIdentities,
    chain.trustEpoch,
    chain.registryDigest,
  );
}

function assertTrustSynchronously(
  verifier: EffectAttestationSignatureVerifier,
  identities: readonly EffectAttestationTrustedIdentity[],
  trustEpoch: number,
  registryDigest: string,
): void {
  let result: unknown;
  try {
    result = verifier.assertTrusted(
      Object.freeze({
        identities,
        trustEpoch,
        registryDigest,
      }),
    );
  } catch (error) {
    throw new EvidenceError(
      'signature-invalid',
      'Final combined signer trust fence failed closed',
      error,
    );
  }
  if (result !== undefined) {
    throw new EvidenceError(
      'signature-invalid',
      'Final combined signer trust fence must synchronously return undefined',
    );
  }
}

function snapshotInitialRecords(value: readonly unknown[]): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new EvidenceError(
      'artifact-invalid',
      'Initial evidence records must be an ordinary array',
    );
  }
  if (value.length > EVIDENCE_VERIFICATION_LIMITS.maximumRecords) {
    throw new EvidenceError(
      'resource-limit-exceeded',
      'Initial evidence records exceed the hard record-count limit',
    );
  }
  const names = Object.getOwnPropertyNames(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    names.length !== value.length + 1 ||
    names[names.length - 1] !== 'length' ||
    Object.keys(value).some((key, index) => key !== String(index))
  ) {
    throw new EvidenceError(
      'artifact-invalid',
      'Initial evidence records cannot be sparse or extended',
    );
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) {
      throw new EvidenceError(
        'artifact-invalid',
        'Initial evidence records cannot contain accessors',
      );
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function pinPortMethod<Port extends object, Name extends keyof Port>(
  port: Port,
  name: Name,
  label: string,
): Port[Name] {
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

function assertLedgerId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value)
  ) {
    throw new EvidenceError(
      'artifact-invalid',
      'Evidence ledger ID is not a canonical identifier',
    );
  }
}

function safeIncrement(value: number): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new EvidenceError(
      'checkpoint-port-failed',
      'In-memory checkpoint publication counter is exhausted',
    );
  }
  return value + 1;
}
