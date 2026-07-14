import {
  EFFECT_ATTESTATION_PAYLOAD_TYPE,
  SIGNATURE_ALGORITHM,
  canonicalizeJson,
  createEnvelopePreAuthenticationEncoding,
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
  encodeUtf8,
  type HashPort,
  type SafeCodingEffectAttestation,
  type SignatureVerificationInput,
  type SignedEnvelope,
} from '@clodex/contracts';
import { describe, expect, it } from 'vitest';

import {
  IN_MEMORY_EVIDENCE_PROFILE,
  InMemoryEvidenceLedger,
  InMemoryUnprotectedCheckpointPort,
} from './in-memory-evidence.js';
import {
  EVIDENCE_CHAIN_SPEC_VERSION,
  EVIDENCE_CHECKPOINT_KIND,
  EVIDENCE_VERIFICATION_LIMITS,
  PROTECTED_CHECKPOINT_PUBLICATION_KIND,
  EvidenceError,
  hashEvidenceCheckpoint,
  hashSignedEffectAttestationEnvelope,
  signEffectAttestation,
  validateEvidenceCheckpoint,
  validateProtectedCheckpointCasInput,
  validateProtectedCheckpointPublication,
  validateSignedEffectAttestationEnvelope,
  verifyEvidenceChain,
  verifySignedEffectAttestation,
  type EffectAttestationSignatureVerifier,
  type EffectAttestationSigner,
  type EffectAttestationSignerRole,
  type EffectAttestationTrustedIdentity,
  type EvidenceCheckpoint,
  type ProtectedCheckpointCasInput,
  type ProtectedCheckpointPort,
  type ProtectedCheckpointPublication,
} from './signed-evidence.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const LEDGER_ID = 'ledger:safe-coding:test';

const hash: HashPort = {
  sha256(input) {
    const lanes = [
      0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344, 0xa4093822, 0x299f31d0,
      0x082efa98, 0xec4e6c89,
    ];
    for (let index = 0; index < input.length; index += 1) {
      const byte = input[index]!;
      for (let lane = 0; lane < lanes.length; lane += 1) {
        lanes[lane] = Math.imul(
          (lanes[lane]! ^ (byte + index + lane)) >>> 0,
          0x01000193,
        );
      }
    }
    return lanes
      .map((lane) => (lane >>> 0).toString(16).padStart(8, '0'))
      .join('');
  },
};

class DeterministicSigner implements EffectAttestationSigner {
  public readonly messages: Uint8Array[] = [];

  public constructor(
    public readonly keyId: string,
    public readonly role: EffectAttestationSignerRole,
    public readonly principalId: string,
  ) {}

  public sign(input: {
    readonly algorithm: typeof SIGNATURE_ALGORITHM;
    readonly message: Uint8Array;
  }): Uint8Array {
    expect(input.algorithm).toBe(SIGNATURE_ALGORITHM);
    this.messages.push(input.message.slice());
    return signatureBytes(this.keyId, input.message);
  }
}

class DeterministicVerifier implements EffectAttestationSignatureVerifier {
  public readonly identities = new Map<
    string,
    EffectAttestationTrustedIdentity
  >();
  public readonly trustAssertions: EffectAttestationTrustedIdentity[][] = [];
  public currentTrustEpoch = 7;
  public currentRegistryDigest = HASH_B;

  public constructor(identities = trustedIdentities()) {
    for (const identity of identities) {
      this.identities.set(identity.keyId, identity);
    }
  }

  public getTrustedIdentity(
    keyId: string,
  ): EffectAttestationTrustedIdentity | null {
    return this.identities.get(keyId) ?? null;
  }

  public verify(input: SignatureVerificationInput): boolean {
    const expected = signatureBytes(input.keyId, input.message);
    const actual = decodeBase64Url(input.signature);
    return bytesEqual(actual, expected);
  }

  public assertTrusted(input: {
    readonly identities: readonly EffectAttestationTrustedIdentity[];
    readonly trustEpoch: number;
    readonly registryDigest: string;
  }): void {
    if (
      input.trustEpoch !== this.currentTrustEpoch ||
      input.registryDigest !== this.currentRegistryDigest ||
      input.identities.some((identity) => {
        const current = this.identities.get(identity.keyId);
        return (
          current === undefined ||
          canonicalizeJson(current) !== canonicalizeJson(identity)
        );
      })
    ) {
      throw new Error('signer trust snapshot is stale');
    }
    this.trustAssertions.push([...input.identities]);
  }
}

function trustedIdentities(): readonly EffectAttestationTrustedIdentity[] {
  return [
    {
      keyId: 'key:executor',
      role: 'executor',
      principalId: 'executor:sandbox',
      trustEpoch: 7,
      registryDigest: HASH_B,
    },
    {
      keyId: 'key:observer',
      role: 'observer',
      principalId: 'observer:runtime',
      trustEpoch: 7,
      registryDigest: HASH_B,
    },
  ];
}

function signers(): readonly [DeterministicSigner, DeterministicSigner] {
  return [
    new DeterministicSigner('key:executor', 'executor', 'executor:sandbox'),
    new DeterministicSigner('key:observer', 'observer', 'observer:runtime'),
  ];
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function attestationFixture(
  index = 1,
  overrides: Partial<SafeCodingEffectAttestation> = {},
): SafeCodingEffectAttestation {
  return {
    kind: 'clodex.effect-attestation',
    specVersion: '1.0.0',
    attestationId: uuid(10_000 + index),
    requestId: `request:${index}`,
    ticketId: uuid(20_000 + index),
    contractHash: HASH_A,
    contractRevision: 1,
    actionHash: HASH_B,
    delegationLineageHash: HASH_C,
    adapterId: 'adapter:safe-file',
    adapterDigest: HASH_D,
    runnerId: 'runner:recording',
    runnerDigest: HASH_A,
    executorId: 'executor:sandbox',
    observerId: 'observer:runtime',
    effectClass: 'local.reversible',
    registryDigest: HASH_B,
    revocationEpoch: 0,
    preStateHash: HASH_C,
    postStateHash: HASH_D,
    idempotencyKey: `idempotency:${index}`,
    resultHash: HASH_A,
    budgetCharges: {
      uniqueModifiedFiles: 1,
      mutationBytes: 128,
      testRuns: 0,
    },
    startedAt: '2026-07-14T00:10:00Z',
    finishedAt: '2026-07-14T00:10:01Z',
    status: 'committed',
    evidenceLevel: 'adapter_observed',
    reconciliationRef: null,
    ...overrides,
  };
}

async function signedFixture(
  index = 1,
  overrides: Partial<SafeCodingEffectAttestation> = {},
): Promise<SignedEnvelope> {
  return await signEffectAttestation(
    attestationFixture(index, overrides),
    signers(),
  );
}

function signatureBytes(keyId: string, message: Uint8Array): Uint8Array {
  const key = encodeUtf8(keyId);
  const bytes = new Uint8Array(64);
  for (let index = 0; index < bytes.length; index += 1) {
    const messageByte = message[index % message.length] ?? 0;
    const keyByte = key[index % key.length] ?? 0;
    bytes[index] =
      (messageByte ^ keyByte ^ ((index * 29 + message.length) & 0xff)) & 0xff;
  }
  return bytes;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function ledger(
  checkpoints: ProtectedCheckpointPort = new InMemoryUnprotectedCheckpointPort({
    hash,
  }),
  initialRecords: readonly unknown[] = [],
  verifier: EffectAttestationSignatureVerifier = new DeterministicVerifier(),
): InMemoryEvidenceLedger {
  return new InMemoryEvidenceLedger({
    ledgerId: LEDGER_ID,
    hash,
    signatures: verifier,
    checkpoints,
    initialRecords,
  });
}

function expectEvidenceError(
  operation: () => unknown,
  code: EvidenceError['code'],
): EvidenceError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(EvidenceError);
    expect((error as EvidenceError).code).toBe(code);
    return error as EvidenceError;
  }
  throw new Error(`Expected EvidenceError(${code})`);
}

async function expectEvidenceRejection(
  operation: () => Promise<unknown>,
  code: EvidenceError['code'],
): Promise<EvidenceError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(EvidenceError);
    expect((error as EvidenceError).code).toBe(code);
    return error as EvidenceError;
  }
  throw new Error(`Expected EvidenceError(${code})`);
}

describe('signed Effect Attestation admission', () => {
  it('signs exact canonical payload bytes with DSSE PAE and both identities', async () => {
    const fixture = attestationFixture();
    const fixtureSigners = signers();
    const envelope = await signEffectAttestation(fixture, fixtureSigners);
    const canonical = canonicalizeJson(fixture);
    const expectedMessage = createEnvelopePreAuthenticationEncoding(
      EFFECT_ATTESTATION_PAYLOAD_TYPE,
      canonical,
    );

    expect(envelope.payloadType).toBe(EFFECT_ATTESTATION_PAYLOAD_TYPE);
    expect(decodeUtf8(decodeBase64Url(envelope.payload))).toBe(canonical);
    expect(fixtureSigners[0].messages).toEqual([expectedMessage]);
    expect(fixtureSigners[1].messages).toEqual([expectedMessage]);
    expect(envelope.signatures.map((entry) => entry.keyId)).toEqual([
      'key:executor',
      'key:observer',
    ]);

    const verified = await verifySignedEffectAttestation(envelope, {
      hash,
      signatures: new DeterministicVerifier(),
    });
    expect(verified.attestation).toEqual(fixture);
    expect(verified.signerKeyIds).toEqual({
      executor: 'key:executor',
      observer: 'key:observer',
    });
    expect(verified.envelopeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects missing, duplicate, wrong-principal, throwing, and malformed signers', async () => {
    const fixture = attestationFixture();
    await expectEvidenceRejection(
      () => signEffectAttestation(fixture, [signers()[0]]),
      'signer-invalid',
    );
    await expectEvidenceRejection(
      () =>
        signEffectAttestation(fixture, [
          signers()[0],
          new DeterministicSigner(
            'key:executor:two',
            'executor',
            'executor:sandbox',
          ),
        ]),
      'signer-invalid',
    );
    await expectEvidenceRejection(
      () =>
        signEffectAttestation(fixture, [
          signers()[0],
          new DeterministicSigner('key:observer', 'observer', 'observer:other'),
        ]),
      'signer-invalid',
    );

    const throwing: EffectAttestationSigner = {
      keyId: 'key:observer',
      role: 'observer',
      principalId: 'observer:runtime',
      sign: () => {
        throw new Error('signer offline');
      },
    };
    await expectEvidenceRejection(
      () => signEffectAttestation(fixture, [signers()[0], throwing]),
      'signer-invalid',
    );

    const short: EffectAttestationSigner = {
      keyId: 'key:observer',
      role: 'observer',
      principalId: 'observer:runtime',
      sign: () => new Uint8Array(63),
    };
    await expectEvidenceRejection(
      () => signEffectAttestation(fixture, [signers()[0], short]),
      'signer-invalid',
    );

    await expectEvidenceRejection(
      () =>
        signEffectAttestation(
          attestationFixture(1, { observerId: 'executor:sandbox' }),
          [
            signers()[0],
            new DeterministicSigner(
              'key:observer',
              'observer',
              'executor:sandbox',
            ),
          ],
        ),
      'artifact-invalid',
    );

    let getterCalls = 0;
    const accessorSigner = {
      role: 'observer' as const,
      principalId: 'observer:runtime',
      sign: () => new Uint8Array(64),
    } as Partial<EffectAttestationSigner>;
    Object.defineProperty(accessorSigner, 'keyId', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'key:observer';
      },
    });
    await expectEvidenceRejection(
      () =>
        signEffectAttestation(fixture, [
          signers()[0],
          accessorSigner as EffectAttestationSigner,
        ]),
      'signer-invalid',
    );
    expect(getterCalls).toBe(0);
  });

  it('enforces a closed envelope without invoking array accessors', async () => {
    const envelope = await signedFixture();
    expectEvidenceError(
      () =>
        validateSignedEffectAttestationEnvelope({
          ...envelope,
          unexpected: true,
        }),
      'artifact-invalid',
    );

    let accessorInvoked = false;
    const signatures = [...envelope.signatures];
    Object.defineProperty(signatures, '0', {
      enumerable: true,
      configurable: true,
      get() {
        accessorInvoked = true;
        return envelope.signatures[0];
      },
    });
    expectEvidenceError(
      () =>
        validateSignedEffectAttestationEnvelope({
          ...envelope,
          signatures,
        }),
      'artifact-invalid',
    );
    expect(accessorInvoked).toBe(false);
  });

  it('rejects noncanonical payload bytes and noncanonical signature ordering', async () => {
    const envelope = await signedFixture();
    const noncanonicalPayload = encodeBase64Url(
      encodeUtf8(`${decodeUtf8(decodeBase64Url(envelope.payload))} `),
    );
    expectEvidenceError(
      () =>
        validateSignedEffectAttestationEnvelope({
          ...envelope,
          payload: noncanonicalPayload,
        }),
      'artifact-invalid',
    );
    expectEvidenceError(
      () =>
        validateSignedEffectAttestationEnvelope({
          ...envelope,
          signatures: [...envelope.signatures].reverse(),
        }),
      'artifact-invalid',
    );
  });

  it('fails closed for tampering, unknown identities, identity confusion, and truthy verifier results', async () => {
    const envelope = await signedFixture();
    const first = envelope.signatures[0]!;
    const tamperedSignature = `${first.signature[0] === 'A' ? 'B' : 'A'}${first.signature.slice(1)}`;
    const tampered = {
      ...envelope,
      signatures: [
        { ...first, signature: tamperedSignature },
        envelope.signatures[1],
      ],
    };
    await expectEvidenceRejection(
      () =>
        verifySignedEffectAttestation(tampered, {
          hash,
          signatures: new DeterministicVerifier(),
        }),
      'signature-invalid',
    );

    const unknown = new DeterministicVerifier();
    unknown.identities.delete('key:observer');
    await expectEvidenceRejection(
      () =>
        verifySignedEffectAttestation(envelope, {
          hash,
          signatures: unknown,
        }),
      'signature-invalid',
    );

    const confused = new DeterministicVerifier([
      trustedIdentities()[0]!,
      {
        ...trustedIdentities()[1]!,
        principalId: 'observer:other',
      },
    ]);
    await expectEvidenceRejection(
      () =>
        verifySignedEffectAttestation(envelope, {
          hash,
          signatures: confused,
        }),
      'signature-invalid',
    );

    const truthy: EffectAttestationSignatureVerifier = {
      getTrustedIdentity: (keyId) =>
        trustedIdentities().find((entry) => entry.keyId === keyId) ?? null,
      verify: () => 1 as unknown as boolean,
      assertTrusted: () => undefined,
    };
    await expectEvidenceRejection(
      () =>
        verifySignedEffectAttestation(envelope, {
          hash,
          signatures: truthy,
        }),
      'signature-invalid',
    );
  });

  it('rejects malformed trusted identity records and invalid hash-port output', async () => {
    const envelope = await signedFixture();
    const extraIdentity: EffectAttestationSignatureVerifier = {
      getTrustedIdentity: (keyId) => ({
        ...(trustedIdentities().find((entry) => entry.keyId === keyId) ??
          trustedIdentities()[0]!),
        extra: true,
      }),
      verify: () => true,
      assertTrusted: () => undefined,
    };
    await expectEvidenceRejection(
      () =>
        verifySignedEffectAttestation(envelope, {
          hash,
          signatures: extraIdentity,
        }),
      'signature-invalid',
    );

    await expectEvidenceRejection(
      () =>
        hashSignedEffectAttestationEnvelope(envelope, {
          sha256: () => 'not-a-digest',
        }),
      'hash-port-invalid',
    );
  });

  it('rejects semantically impossible attestations before either signer runs', async () => {
    const fixtureSigners = signers();
    await expectEvidenceRejection(
      () =>
        signEffectAttestation(
          attestationFixture(1, {
            status: 'failed_no_effect',
            evidenceLevel: 'attempt_only',
            postStateHash: HASH_D,
            resultHash: HASH_A,
          }),
          fixtureSigners,
        ),
      'artifact-invalid',
    );
    await expectEvidenceRejection(
      () =>
        signEffectAttestation(
          attestationFixture(1, {
            evidenceLevel: 'independently_reconciled',
            reconciliationRef: null,
          }),
          fixtureSigners,
        ),
      'artifact-invalid',
    );
    expect(fixtureSigners[0].messages).toHaveLength(0);
    expect(fixtureSigners[1].messages).toHaveLength(0);
  });

  it('pins verifier methods and executes one synchronous final trust fence', async () => {
    const envelope = await signedFixture();
    const verifier = new DeterministicVerifier();
    const verified = await verifySignedEffectAttestation(envelope, {
      hash,
      signatures: verifier,
    });
    expect(verifier.trustAssertions).toHaveLength(1);
    expect(verifier.trustAssertions[0]).toHaveLength(2);
    expect(verified.trustEpoch).toBe(7);
    expect(verified.registryDigest).toBe(HASH_B);

    let getterCalls = 0;
    const accessorVerifier = {
      getTrustedIdentity: verifier.getTrustedIdentity.bind(verifier),
      assertTrusted: verifier.assertTrusted.bind(verifier),
    } as Partial<EffectAttestationSignatureVerifier>;
    Object.defineProperty(accessorVerifier, 'verify', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return () => true;
      },
    });
    await expectEvidenceRejection(
      () =>
        verifySignedEffectAttestation(envelope, {
          hash,
          signatures: accessorVerifier as EffectAttestationSignatureVerifier,
        }),
      'artifact-invalid',
    );
    expect(getterCalls).toBe(0);

    let dependencyGetterCalls = 0;
    const dependencies = { hash } as Record<string, unknown>;
    Object.defineProperty(dependencies, 'signatures', {
      enumerable: true,
      get: () => {
        dependencyGetterCalls += 1;
        return verifier;
      },
    });
    await expectEvidenceRejection(
      () =>
        verifySignedEffectAttestation(
          envelope,
          dependencies as unknown as {
            readonly hash: HashPort;
            readonly signatures: EffectAttestationSignatureVerifier;
          },
        ),
      'artifact-invalid',
    );
    expect(dependencyGetterCalls).toBe(0);
  });

  it('fails the final synchronous fence when trust rotates after signature verification', async () => {
    const envelope = await signedFixture();
    const verifier = new DeterministicVerifier();
    let verifications = 0;
    const rotating: EffectAttestationSignatureVerifier = {
      getTrustedIdentity: verifier.getTrustedIdentity.bind(verifier),
      verify(input) {
        verifications += 1;
        const result = verifier.verify(input);
        if (verifications === 2) verifier.currentTrustEpoch = 8;
        return result;
      },
      assertTrusted: verifier.assertTrusted.bind(verifier),
    };
    await expectEvidenceRejection(
      () =>
        verifySignedEffectAttestation(envelope, { hash, signatures: rotating }),
      'signature-invalid',
    );
  });
});

describe('evidence chain, checkpoints, and fail-closed admission', () => {
  it('appends a linked sequence and publishes a checkpoint for every head', async () => {
    const checkpoints = new InMemoryUnprotectedCheckpointPort({ hash });
    const evidence = ledger(checkpoints);
    const first = await evidence.append(await signedFixture(1));
    const second = await evidence.append(await signedFixture(2));
    const integrity = await evidence.verifyIntegrity();

    expect(first.record).toMatchObject({
      sequence: 1,
      previousRecordHash: null,
    });
    expect(second.record).toMatchObject({
      sequence: 2,
      previousRecordHash: first.recordHash,
    });
    expect(second.publication.checkpoint).toMatchObject({
      sequence: 2,
      headHash: second.recordHash,
      previousCheckpointHash: await hashEvidenceCheckpoint(
        first.publication.checkpoint,
        hash,
      ),
    });
    expect(integrity.chain.sequence).toBe(2);
    expect(integrity.chain.headHash).toBe(second.recordHash);
    expect(integrity.publication).toEqual(second.publication);
    expect(Object.isFrozen(evidence.snapshot())).toBe(true);
  });

  it('fences the complete chain signer set once and rejects mixed trust epochs', async () => {
    const evidence = ledger();
    await evidence.append(await signedFixture(1));
    await evidence.append(await signedFixture(2));
    const verifier = new DeterministicVerifier();
    const verified = await verifyEvidenceChain(evidence.snapshot(), {
      ledgerId: LEDGER_ID,
      hash,
      signatures: verifier,
    });
    expect(verifier.trustAssertions).toHaveLength(1);
    expect(verifier.trustAssertions[0]).toHaveLength(4);
    expect(verified.trustEpoch).toBe(7);

    let lookups = 0;
    const mixed: EffectAttestationSignatureVerifier = {
      getTrustedIdentity(keyId) {
        const identity = trustedIdentities().find(
          (entry) => entry.keyId === keyId,
        );
        const trustEpoch = 7 + Math.floor(lookups / 2);
        lookups += 1;
        return identity ? { ...identity, trustEpoch } : null;
      },
      verify: verifier.verify.bind(verifier),
      assertTrusted: () => undefined,
    };
    await expectEvidenceRejection(
      () =>
        verifyEvidenceChain(evidence.snapshot(), {
          ledgerId: LEDGER_ID,
          hash,
          signatures: mixed,
        }),
      'signature-invalid',
    );
  });

  it('verifies historical artifact-registry changes under one current signer-trust snapshot', async () => {
    const evidence = ledger();
    await evidence.append(await signedFixture(1, { registryDigest: HASH_B }));
    await evidence.append(await signedFixture(2, { registryDigest: HASH_C }));
    const verifier = new DeterministicVerifier();
    const chain = await verifyEvidenceChain(evidence.snapshot(), {
      ledgerId: LEDGER_ID,
      hash,
      signatures: verifier,
    });
    expect(chain.sequence).toBe(2);
    expect(chain.registryDigest).toBe(HASH_B);
    expect(verifier.trustAssertions).toHaveLength(1);
  });

  it('detaches the complete chain input before the first verifier await', async () => {
    const evidence = ledger();
    await evidence.append(await signedFixture(1));
    await evidence.append(await signedFixture(2));
    const expectedHead = (await evidence.verifyIntegrity()).chain.headHash;
    const records = [...evidence.snapshot()];
    const gate = deferred<void>();
    const verifier = new DeterministicVerifier();
    let firstLookup = true;
    const asynchronous: EffectAttestationSignatureVerifier = {
      async getTrustedIdentity(keyId) {
        if (firstLookup) {
          firstLookup = false;
          await gate.promise;
        }
        return verifier.getTrustedIdentity(keyId);
      },
      verify: verifier.verify.bind(verifier),
      assertTrusted: verifier.assertTrusted.bind(verifier),
    };
    const operation = verifyEvidenceChain(records, {
      ledgerId: LEDGER_ID,
      hash,
      signatures: asynchronous,
    });
    records.reverse();
    records.length = 0;
    gate.resolve(undefined);
    await expect(operation).resolves.toMatchObject({
      sequence: 2,
      headHash: expectedHead,
    });
  });

  it('enforces hard record-count limits before signature work', async () => {
    const verifier = new DeterministicVerifier();
    let identityLookups = 0;
    const counting: EffectAttestationSignatureVerifier = {
      getTrustedIdentity(keyId) {
        identityLookups += 1;
        return verifier.getTrustedIdentity(keyId);
      },
      verify: verifier.verify.bind(verifier),
      assertTrusted: verifier.assertTrusted.bind(verifier),
    };
    await expectEvidenceRejection(
      () =>
        verifyEvidenceChain(
          new Array(EVIDENCE_VERIFICATION_LIMITS.maximumRecords + 1).fill(null),
          { ledgerId: LEDGER_ID, hash, signatures: counting },
        ),
      'resource-limit-exceeded',
    );
    expect(identityLookups).toBe(0);
  });

  it('fails closed after checkpoint publication when signer trust rotates, exposing the non-atomic boundary', async () => {
    const verifier = new DeterministicVerifier();
    const delegate = new InMemoryUnprotectedCheckpointPort({ hash });
    const rotatingCheckpoints: ProtectedCheckpointPort = {
      load: delegate.load.bind(delegate),
      verify: delegate.verify.bind(delegate),
      async compareAndSwap(input) {
        const result = await delegate.compareAndSwap(input);
        verifier.currentTrustEpoch = 8;
        return result;
      },
    };
    const evidence = ledger(rotatingCheckpoints, [], verifier);
    await expectEvidenceRejection(
      async () => await evidence.append(await signedFixture()),
      'signature-invalid',
    );
    expect(evidence.snapshot()).toHaveLength(0);
    expect(delegate.load(LEDGER_ID)).not.toBeNull();
    expect(evidence.atomicCheckpointAndTrustTransaction).toBe(false);
  });

  it('detects reordered sequence, broken linkage, and envelope-hash tampering', async () => {
    const evidence = ledger();
    await evidence.append(await signedFixture(1));
    await evidence.append(await signedFixture(2));
    const [first, second] = evidence.snapshot();

    await expectEvidenceRejection(
      () =>
        verifyEvidenceChain([second!, first!], {
          ledgerId: LEDGER_ID,
          hash,
          signatures: new DeterministicVerifier(),
        }),
      'fork-detected',
    );
    await expectEvidenceRejection(
      () =>
        verifyEvidenceChain(
          [first!, { ...second!, previousRecordHash: HASH_A }],
          {
            ledgerId: LEDGER_ID,
            hash,
            signatures: new DeterministicVerifier(),
          },
        ),
      'fork-detected',
    );
    await expectEvidenceRejection(
      () =>
        verifyEvidenceChain([first!, { ...second!, envelopeHash: HASH_A }], {
          ledgerId: LEDGER_ID,
          hash,
          signatures: new DeterministicVerifier(),
        }),
      'fork-detected',
    );
  });

  it('rejects attestation, request, ticket, and non-null idempotency replay before advancing the head', async () => {
    for (const overrides of [
      { attestationId: uuid(10_001) },
      { requestId: 'request:1' },
      { ticketId: uuid(20_001) },
      { idempotencyKey: 'idempotency:1' },
    ] as const) {
      const evidence = ledger();
      await evidence.append(await signedFixture(1));
      await expectEvidenceRejection(
        async () => await evidence.append(await signedFixture(2, overrides)),
        'replay-detected',
      );
      expect(evidence.snapshot()).toHaveLength(1);
    }
  });

  it('detects a restored local rollback against the newer protected head', async () => {
    const checkpoints = new InMemoryUnprotectedCheckpointPort({ hash });
    const original = ledger(checkpoints);
    await original.append(await signedFixture(1));
    await original.append(await signedFixture(2));

    const rolledBack = ledger(checkpoints, original.snapshot().slice(0, 1));
    await expectEvidenceRejection(
      () => rolledBack.verifyIntegrity(),
      'rollback-detected',
    );
  });

  it('detects a valid alternate chain as a fork at the protected sequence', async () => {
    const protectedPort = new InMemoryUnprotectedCheckpointPort({ hash });
    const canonical = ledger(protectedPort);
    await canonical.append(await signedFixture(1));

    const alternatePort = new InMemoryUnprotectedCheckpointPort({ hash });
    const alternate = ledger(alternatePort);
    await alternate.append(await signedFixture(2));

    const forkedRestore = ledger(protectedPort, alternate.snapshot());
    await expectEvidenceRejection(
      () => forkedRestore.verifyIntegrity(),
      'fork-detected',
    );
  });

  it('fails closed when local evidence has no protected checkpoint', async () => {
    const original = ledger();
    await original.append(await signedFixture(1));
    const missingHead = ledger(
      new InMemoryUnprotectedCheckpointPort({ hash }),
      original.snapshot(),
    );
    await expectEvidenceRejection(
      () => missingHead.verifyIntegrity(),
      'rollback-detected',
    );
  });

  it('linearizes concurrent first admission so one competing fork loses CAS', async () => {
    const checkpoints = new InMemoryUnprotectedCheckpointPort({ hash });
    const left = ledger(checkpoints);
    const right = ledger(checkpoints);
    const outcomes = await Promise.allSettled([
      left.append(await signedFixture(1)),
      right.append(await signedFixture(2)),
    ]);

    expect(
      outcomes.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = outcomes.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(EvidenceError);
    expect((rejected?.reason as EvidenceError).code).toBe('fork-detected');
    expect(left.snapshot().length + right.snapshot().length).toBe(1);
  });

  it('does not mutate local evidence when checkpoint verification rejects publication', async () => {
    const delegate = new InMemoryUnprotectedCheckpointPort({ hash });
    const rejecting: ProtectedCheckpointPort = {
      load: delegate.load.bind(delegate),
      compareAndSwap: delegate.compareAndSwap.bind(delegate),
      verify: () => false,
    };
    const evidence = ledger(rejecting);
    await expectEvidenceRejection(
      async () => await evidence.append(await signedFixture()),
      'checkpoint-untrusted',
    );
    expect(evidence.snapshot()).toHaveLength(0);
  });

  it('does not mutate local evidence when a port publishes a different head', async () => {
    const lying = new LyingCheckpointPort('different-head');
    const evidence = ledger(lying);
    await expectEvidenceRejection(
      async () => await evidence.append(await signedFixture()),
      'fork-detected',
    );
    expect(evidence.snapshot()).toHaveLength(0);
  });

  it('does not mutate local evidence when read-after-publish loses the head', async () => {
    const disappearing = new LyingCheckpointPort('disappear-after-publish');
    const evidence = ledger(disappearing);
    await expectEvidenceRejection(
      async () => await evidence.append(await signedFixture()),
      'checkpoint-port-failed',
    );
    expect(evidence.snapshot()).toHaveLength(0);
  });

  it('rejects malformed checkpoint CAS output without mutating local evidence', async () => {
    const malformed: ProtectedCheckpointPort = {
      load: () => null,
      verify: () => true,
      compareAndSwap: () => ({
        status: 'published',
        publication: null,
        unexpected: true,
      }),
    };
    const evidence = ledger(malformed);
    await expectEvidenceRejection(
      async () => await evidence.append(await signedFixture()),
      'artifact-invalid',
    );
    expect(evidence.snapshot()).toHaveLength(0);
  });

  it('validates checkpoint linkage and closed checkpoint fields', () => {
    expectEvidenceError(
      () =>
        validateEvidenceCheckpoint({
          kind: EVIDENCE_CHECKPOINT_KIND,
          specVersion: EVIDENCE_CHAIN_SPEC_VERSION,
          ledgerId: LEDGER_ID,
          sequence: 1,
          headHash: HASH_A,
          previousCheckpointHash: HASH_B,
        }),
      'artifact-invalid',
    );
    expectEvidenceError(
      () =>
        validateEvidenceCheckpoint({
          kind: EVIDENCE_CHECKPOINT_KIND,
          specVersion: EVIDENCE_CHAIN_SPEC_VERSION,
          ledgerId: LEDGER_ID,
          sequence: 2,
          headHash: HASH_A,
          previousCheckpointHash: null,
        }),
      'artifact-invalid',
    );
    expectEvidenceError(
      () =>
        validateEvidenceCheckpoint({
          kind: EVIDENCE_CHECKPOINT_KIND,
          specVersion: EVIDENCE_CHAIN_SPEC_VERSION,
          ledgerId: LEDGER_ID,
          sequence: 1,
          headHash: HASH_A,
          previousCheckpointHash: null,
          extra: true,
        }),
      'artifact-invalid',
    );

    let accessorInvoked = false;
    const casInput = {
      ledgerId: LEDGER_ID,
      expectedPublicationId: null,
      expectedCheckpointHash: null,
    } as Record<string, unknown>;
    Object.defineProperty(casInput, 'checkpoint', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return null;
      },
    });
    expectEvidenceError(
      () => validateProtectedCheckpointCasInput(casInput),
      'artifact-invalid',
    );
    expect(accessorInvoked).toBe(false);
  });

  it('labels the bundled reference implementations as non-durable and unprotected', () => {
    const checkpoints = new InMemoryUnprotectedCheckpointPort({ hash });
    const evidence = ledger(checkpoints);
    expect(IN_MEMORY_EVIDENCE_PROFILE).toEqual({
      durability: 'memory-only',
      crashSafety: 'none',
      checkpointProtection: 'unprotected-reference',
      independentProtection: false,
      keyStorage: 'none',
      productionReady: false,
      verificationComplexity: 'full-chain-per-append',
      atomicCheckpointAndTrustTransaction: false,
      maximumRecords: 4096,
      maximumAggregateEnvelopeBytes: 64 * 1024 * 1024,
    });
    expect(evidence.durability).toBe('memory-only');
    expect(evidence.crashSafety).toBe('none');
    expect(evidence.independentProtection).toBe(false);
    expect(evidence.atomicCheckpointAndTrustTransaction).toBe(false);
    expect(checkpoints.durability).toBe('memory-only');
    expect(checkpoints.protection).toBe('none');
    expect(checkpoints.independentlyProtected).toBe(false);

    let optionGetterCalls = 0;
    const options = {
      ledgerId: LEDGER_ID,
      signatures: new DeterministicVerifier(),
      checkpoints,
    } as Record<string, unknown>;
    Object.defineProperty(options, 'hash', {
      enumerable: true,
      get: () => {
        optionGetterCalls += 1;
        return hash;
      },
    });
    expectEvidenceError(
      () => new InMemoryEvidenceLedger(options as never),
      'artifact-invalid',
    );
    expect(optionGetterCalls).toBe(0);
  });

  it('makes the unprotected reference CAS reject stale expectations', async () => {
    const checkpoints = new InMemoryUnprotectedCheckpointPort({ hash });
    const firstCheckpoint = validateEvidenceCheckpoint({
      kind: EVIDENCE_CHECKPOINT_KIND,
      specVersion: EVIDENCE_CHAIN_SPEC_VERSION,
      ledgerId: LEDGER_ID,
      sequence: 1,
      headHash: HASH_A,
      previousCheckpointHash: null,
    });
    const first = await checkpoints.compareAndSwap({
      ledgerId: LEDGER_ID,
      expectedPublicationId: null,
      expectedCheckpointHash: null,
      checkpoint: firstCheckpoint,
    });
    expect(first.status).toBe('published');

    const stale = await checkpoints.compareAndSwap({
      ledgerId: LEDGER_ID,
      expectedPublicationId: null,
      expectedCheckpointHash: null,
      checkpoint: firstCheckpoint,
    });
    expect(stale.status).toBe('conflict');
    if (first.status !== 'published') throw new Error('unreachable');
    expect(checkpoints.verify(first.publication)).toBe(true);

    const firstCheckpointHash = await hashEvidenceCheckpoint(
      firstCheckpoint,
      hash,
    );
    const secondCheckpoint = validateEvidenceCheckpoint({
      kind: EVIDENCE_CHECKPOINT_KIND,
      specVersion: EVIDENCE_CHAIN_SPEC_VERSION,
      ledgerId: LEDGER_ID,
      sequence: 2,
      headHash: HASH_B,
      previousCheckpointHash: firstCheckpointHash,
    });
    const second = await checkpoints.compareAndSwap({
      ledgerId: LEDGER_ID,
      expectedPublicationId: first.publication.publicationId,
      expectedCheckpointHash: firstCheckpointHash,
      checkpoint: secondCheckpoint,
    });
    expect(second.status).toBe('published');
    expect(checkpoints.verify(first.publication)).toBe(false);
    if (second.status !== 'published') throw new Error('unreachable');
    expect(checkpoints.verify(second.publication)).toBe(true);
  });
});

class LyingCheckpointPort implements ProtectedCheckpointPort {
  #publication: ProtectedCheckpointPublication | null = null;
  #loadCount = 0;

  public constructor(
    private readonly behavior: 'different-head' | 'disappear-after-publish',
  ) {}

  public load(): ProtectedCheckpointPublication | null {
    this.#loadCount += 1;
    if (this.behavior === 'disappear-after-publish' && this.#loadCount > 1) {
      return null;
    }
    return this.#publication;
  }

  public verify(): boolean {
    return true;
  }

  public compareAndSwap(input: ProtectedCheckpointCasInput): unknown {
    const checkpoint =
      this.behavior === 'different-head'
        ? { ...input.checkpoint, headHash: 'f'.repeat(64) }
        : input.checkpoint;
    this.#publication = publicationFixture(checkpoint);
    return { status: 'published', publication: this.#publication };
  }
}

function publicationFixture(
  checkpoint: EvidenceCheckpoint,
): ProtectedCheckpointPublication {
  return validateProtectedCheckpointPublication({
    kind: PROTECTED_CHECKPOINT_PUBLICATION_KIND,
    specVersion: EVIDENCE_CHAIN_SPEC_VERSION,
    publicationId: 'publication:adversarial',
    checkpoint,
    proof: encodeBase64Url(encodeUtf8('not-independently-protected')),
  });
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}
