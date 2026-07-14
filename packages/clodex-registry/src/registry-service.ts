import {
  SIGNATURE_ALGORITHM,
  canonicalizeJson,
  encodeUtf8,
  type SignatureVerificationInput,
} from '@clodex/contracts';

import {
  SCOPED_REGISTRY_MANIFEST_HASH_DOMAIN,
  parseSignedScopedRegistryManifest,
  validateAdapterRegistryMember,
  validateEffectRegistryMember,
  validateRunnerRegistryMember,
  type AdapterRegistryManifest,
  type AdapterRegistryMember,
  type EffectRegistryManifest,
  type EffectRegistryMember,
  type RunnerRegistryManifest,
  type RunnerRegistryMember,
  type ScopedRegistryManifest,
  type ScopedRegistryType,
} from './manifest.js';

export const REGISTRY_HEAD_KIND = 'clodex.scoped-registry-head' as const;
export const REGISTRY_HEAD_VERSION = 1 as const;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const CURRENT_REGISTRY_TOKEN = Symbol('CurrentScopedRegistry');

export interface RegistryManifestExpectation {
  readonly registryType: ScopedRegistryType;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly rootObjectId: string;
  readonly policyDigest: string;
  readonly configurationDigest: string;
  readonly buildDigest: string;
  /** Digest committed by the active contract/deployment configuration. */
  readonly manifestHash: string;
}

export interface RegistryHeadKey {
  readonly registryType: ScopedRegistryType;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly rootObjectId: string;
}

export interface RegistryHeadSnapshot extends RegistryHeadKey {
  readonly kind: typeof REGISTRY_HEAD_KIND;
  readonly version: typeof REGISTRY_HEAD_VERSION;
  readonly policyDigest: string;
  readonly configurationDigest: string;
  readonly buildDigest: string;
  readonly epoch: number;
  readonly manifestHash: string;
  readonly previousManifestHash: string | null;
}

export interface RegistryHeadCompareAndSwapInput {
  readonly key: RegistryHeadKey;
  readonly expected: RegistryHeadSnapshot | null;
  readonly next: RegistryHeadSnapshot;
}

export type RegistryHeadCompareAndSwapOutcome = 'APPLIED' | 'CONFLICT';

/**
 * Production implementations must be linearizable and independently
 * protected against replacement/rollback. Mutation and both final fences are
 * deliberately synchronous so no request work can interleave after the last
 * trust decision.
 */
export interface ProtectedRegistryHeadPort {
  readCurrent(key: RegistryHeadKey): unknown | null | Promise<unknown | null>;
  compareAndSwap(
    input: RegistryHeadCompareAndSwapInput,
  ): RegistryHeadCompareAndSwapOutcome;
  assertCurrent(expected: RegistryHeadSnapshot): void;
}

export interface TrustedRegistrySignerSnapshot {
  readonly keyId: string;
  readonly issuerId: string;
  readonly role: 'registry-authority';
  /** Monotonic trust-registry view binding key material and revocation state. */
  readonly trustEpoch: number;
  readonly trustRegistryDigest: string;
}

export interface RegistrySignatureVerificationInput
  extends SignatureVerificationInput {
  readonly trustedSigner: TrustedRegistrySignerSnapshot;
}

export interface RegistrySignatureVerifierPort {
  resolveTrustedSigner(
    keyId: string,
  ):
    | TrustedRegistrySignerSnapshot
    | null
    | Promise<TrustedRegistrySignerSnapshot | null>;
  /** Perform actual P-256 verification against this exact trust snapshot. */
  verify(input: RegistrySignatureVerificationInput): boolean | Promise<boolean>;
  /** Final synchronous revocation/role/epoch/key-material fence. */
  assertTrusted(snapshot: TrustedRegistrySignerSnapshot): void;
}

export interface RegistryHashPort {
  sha256(input: Uint8Array): string | Promise<string>;
}

export interface RegistryClockPort {
  /** Trusted synchronous UTC clock, never request-supplied. */
  now(): string;
}

export interface ScopedRegistryServiceDependencies {
  readonly hash: RegistryHashPort;
  readonly signatures: RegistrySignatureVerifierPort;
  readonly head: ProtectedRegistryHeadPort;
  readonly clock: RegistryClockPort;
}

export type RegistrySecurityErrorCode =
  | 'binding-mismatch'
  | 'digest-mismatch'
  | 'epoch-gap'
  | 'fork-detected'
  | 'head-conflict'
  | 'head-invalid'
  | 'head-missing'
  | 'input-invalid'
  | 'manifest-inactive'
  | 'port-invalid'
  | 'rollback-detected'
  | 'signature-invalid'
  | 'signer-untrusted'
  | 'stale-registry'
  | 'trust-drift';

export class RegistrySecurityError extends Error {
  public constructor(
    public readonly code: RegistrySecurityErrorCode,
    message: string,
    public readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = 'RegistrySecurityError';
  }
}

export type RegistryAdmissionDisposition =
  | 'already-current'
  | 'installed-genesis'
  | 'installed-successor';

export interface RegistryAdmissionResult {
  readonly registry: CurrentScopedRegistry;
  readonly disposition: RegistryAdmissionDisposition;
}

interface PinnedRegistryDependencies {
  readonly sha256: RegistryHashPort['sha256'];
  readonly resolveTrustedSigner: RegistrySignatureVerifierPort['resolveTrustedSigner'];
  readonly verifySignature: RegistrySignatureVerifierPort['verify'];
  readonly assertTrusted: RegistrySignatureVerifierPort['assertTrusted'];
  readonly readCurrent: ProtectedRegistryHeadPort['readCurrent'];
  readonly compareAndSwap: ProtectedRegistryHeadPort['compareAndSwap'];
  readonly assertHeadCurrent: ProtectedRegistryHeadPort['assertCurrent'];
  readonly now: RegistryClockPort['now'];
}

/**
 * Verifies and installs one exact signed registry manifest. The caller must
 * supply the manifest digest already committed by trusted authority. A lower
 * epoch, same-epoch fork, skipped epoch, or wrong predecessor is rejected.
 */
export class ScopedRegistryService {
  readonly #dependencies: PinnedRegistryDependencies;

  public constructor(dependenciesValue: ScopedRegistryServiceDependencies) {
    const dependencies = requireDependencyRecord(dependenciesValue, [
      'hash',
      'signatures',
      'head',
      'clock',
    ]);
    const hash = dependencies.hash as RegistryHashPort;
    const signatures = dependencies.signatures as RegistrySignatureVerifierPort;
    const head = dependencies.head as ProtectedRegistryHeadPort;
    const clock = dependencies.clock as RegistryClockPort;
    this.#dependencies = Object.freeze({
      sha256: pinMethod(hash, 'sha256', 'Registry hash port'),
      resolveTrustedSigner: pinMethod(
        signatures,
        'resolveTrustedSigner',
        'Registry signature verifier',
      ),
      verifySignature: pinMethod(
        signatures,
        'verify',
        'Registry signature verifier',
      ),
      assertTrusted: pinMethod(
        signatures,
        'assertTrusted',
        'Registry signature verifier',
      ),
      readCurrent: pinMethod(head, 'readCurrent', 'Protected registry head'),
      compareAndSwap: pinMethod(
        head,
        'compareAndSwap',
        'Protected registry head',
      ),
      assertHeadCurrent: pinMethod(
        head,
        'assertCurrent',
        'Protected registry head',
      ),
      now: pinMethod(clock, 'now', 'Registry clock'),
    });
    Object.freeze(this);
  }

  public async admit(inputValue: {
    readonly envelope: unknown;
    readonly expected: RegistryManifestExpectation;
  }): Promise<RegistryAdmissionResult> {
    const input = requireServiceInput(inputValue);
    const expected = validateRegistryManifestExpectation(input.expected);
    const parsed = parseSignedScopedRegistryManifest(input.envelope);
    assertExpectedBindings(parsed.manifest, expected);
    const manifestHash = await hashCanonicalManifest(
      parsed.manifest,
      this.#dependencies.sha256,
    );
    if (manifestHash !== expected.manifestHash) {
      throw security(
        'digest-mismatch',
        'Signed registry manifest does not match the committed manifest hash',
      );
    }

    const signerValue = await this.#dependencies.resolveTrustedSigner(
      parsed.signature.keyId,
    );
    if (signerValue === null) {
      throw security('signer-untrusted', 'Registry signer is not trusted');
    }
    const signer = validateTrustedRegistrySignerSnapshot(
      signerValue,
      parsed.signature.keyId,
    );
    if (
      signer.issuerId !== parsed.manifest.issuer.issuerId ||
      signer.keyId !== parsed.manifest.issuer.keyId
    ) {
      throw security(
        'signer-untrusted',
        'Trusted signer snapshot does not match the manifest issuer',
      );
    }
    let signatureValid: boolean;
    try {
      signatureValid =
        (await this.#dependencies.verifySignature({
          algorithm: SIGNATURE_ALGORITHM,
          keyId: parsed.signature.keyId,
          signature: parsed.signature.signature,
          message: parsed.message.slice(),
          trustedSigner: signer,
        })) === true;
    } catch (error) {
      throw security(
        'signature-invalid',
        'Registry signature verification failed closed',
        error,
      );
    }
    if (!signatureValid) {
      throw security('signature-invalid', 'Registry signature is invalid');
    }

    const key = registryHeadKeyFromManifest(parsed.manifest);
    const currentValue = await this.#dependencies.readCurrent(key);
    const current =
      currentValue === null
        ? null
        : validateRegistryHeadForKey(currentValue, key);
    const next = registryHeadFromManifest(parsed.manifest, manifestHash);
    const transition = classifyHeadTransition(current, next);

    this.assertManifestActive(parsed.manifest);
    this.assertSignerTrusted(signer);

    let disposition: RegistryAdmissionDisposition;
    if (transition === 'already-current') {
      disposition = transition;
    } else {
      const outcome = this.#dependencies.compareAndSwap({
        key,
        expected: current,
        next,
      });
      if (outcome !== 'APPLIED') {
        if (outcome !== 'CONFLICT') {
          throw security(
            'port-invalid',
            'Protected registry head CAS must be synchronous and return a valid outcome',
          );
        }
        throw security(
          'head-conflict',
          'Protected registry head changed during admission',
        );
      }
      disposition = transition;
    }

    // No await is permitted after these final trust/time/head fences.
    this.assertManifestActive(parsed.manifest);
    this.assertSignerTrusted(signer);
    assertSynchronousVoid(
      this.#dependencies.assertHeadCurrent(next),
      'Protected registry head assertCurrent',
    );

    const registry = new CurrentScopedRegistry(
      CURRENT_REGISTRY_TOKEN,
      parsed.manifest,
      parsed.canonicalPayload,
      manifestHash,
      signer,
      next,
      this.#dependencies,
    );
    return Object.freeze({ registry, disposition });
  }

  private assertManifestActive(manifest: ScopedRegistryManifest): void {
    const now = requireTimestamp(this.#dependencies.now(), 'Registry clock');
    const nowMs = Date.parse(now);
    if (
      nowMs < Date.parse(manifest.validity.notBefore) ||
      nowMs >= Date.parse(manifest.validity.expiresAt)
    ) {
      throw security(
        'manifest-inactive',
        'Registry manifest is not active at the trusted current time',
      );
    }
  }

  private assertSignerTrusted(signer: TrustedRegistrySignerSnapshot): void {
    try {
      assertSynchronousVoid(
        this.#dependencies.assertTrusted(signer),
        'Registry signer assertTrusted',
      );
    } catch (error) {
      if (error instanceof RegistrySecurityError) throw error;
      throw security(
        'trust-drift',
        'Registry signer trust changed during verification',
        error,
      );
    }
  }
}

/**
 * Resolver backed by a manifest that was current at admission. Every lookup
 * repeats synchronous time, signer-trust, and protected-head fences so a stale
 * resolver cannot continue granting membership after rotation or revocation.
 */
export class CurrentScopedRegistry {
  public readonly manifest: ScopedRegistryManifest;
  public readonly canonicalPayload: string;
  public readonly manifestHash: string;
  public readonly signer: TrustedRegistrySignerSnapshot;
  public readonly head: RegistryHeadSnapshot;

  readonly #dependencies: Pick<
    PinnedRegistryDependencies,
    'assertHeadCurrent' | 'assertTrusted' | 'now'
  >;
  readonly #members: ReadonlyMap<
    string,
    AdapterRegistryMember | EffectRegistryMember | RunnerRegistryMember
  >;

  public constructor(
    token: symbol,
    manifest: ScopedRegistryManifest,
    canonicalPayload: string,
    manifestHash: string,
    signer: TrustedRegistrySignerSnapshot,
    head: RegistryHeadSnapshot,
    dependencies: PinnedRegistryDependencies,
  ) {
    if (token !== CURRENT_REGISTRY_TOKEN) {
      throw security(
        'input-invalid',
        'CurrentScopedRegistry can only be created by ScopedRegistryService',
      );
    }
    this.manifest = manifest;
    this.canonicalPayload = canonicalPayload;
    this.manifestHash = manifestHash;
    this.signer = signer;
    this.head = head;
    this.#dependencies = Object.freeze({
      assertHeadCurrent: dependencies.assertHeadCurrent,
      assertTrusted: dependencies.assertTrusted,
      now: dependencies.now,
    });
    this.#members = new Map(
      manifest.members.map((member) => [memberKey(member), member]),
    );
    Object.freeze(this);
  }

  public resolveAdapter(value: unknown): AdapterRegistryMember | null {
    if (this.manifest.registryType !== 'adapter') {
      throw security(
        'binding-mismatch',
        'Adapter membership requires an adapter registry',
      );
    }
    const expected = validateAdapterRegistryMember(value);
    this.assertCurrent();
    return this.resolveExact(expected) as AdapterRegistryMember | null;
  }

  public resolveRunner(value: unknown): RunnerRegistryMember | null {
    if (this.manifest.registryType !== 'runner') {
      throw security(
        'binding-mismatch',
        'Runner membership requires a runner registry',
      );
    }
    const expected = validateRunnerRegistryMember(value);
    this.assertCurrent();
    return this.resolveExact(expected) as RunnerRegistryMember | null;
  }

  public resolveEffect(value: unknown): EffectRegistryMember | null {
    if (this.manifest.registryType !== 'effect') {
      throw security(
        'binding-mismatch',
        'Effect membership requires an effect registry',
      );
    }
    const expected = validateEffectRegistryMember(value);
    this.assertCurrent();
    return this.resolveExact(expected) as EffectRegistryMember | null;
  }

  public assertCurrent(): void {
    const now = requireTimestamp(this.#dependencies.now(), 'Registry clock');
    const nowMs = Date.parse(now);
    if (
      nowMs < Date.parse(this.manifest.validity.notBefore) ||
      nowMs >= Date.parse(this.manifest.validity.expiresAt)
    ) {
      throw security(
        'stale-registry',
        'Registry resolver is outside its signed validity window',
      );
    }
    try {
      assertSynchronousVoid(
        this.#dependencies.assertTrusted(this.signer),
        'Registry signer assertTrusted',
      );
      assertSynchronousVoid(
        this.#dependencies.assertHeadCurrent(this.head),
        'Protected registry head assertCurrent',
      );
    } catch (error) {
      if (error instanceof RegistrySecurityError) throw error;
      throw security(
        'stale-registry',
        'Registry signer or protected head is no longer current',
        error,
      );
    }
  }

  private resolveExact(
    expected:
      | AdapterRegistryMember
      | EffectRegistryMember
      | RunnerRegistryMember,
  ):
    | AdapterRegistryMember
    | EffectRegistryMember
    | RunnerRegistryMember
    | null {
    const member = this.#members.get(memberKey(expected));
    if (!member || canonicalizeJson(member) !== canonicalizeJson(expected)) {
      return null;
    }
    return member;
  }
}

/**
 * Deterministic single-process reference only. This object is neither durable
 * nor independently protected and therefore cannot satisfy the production
 * anti-rollback requirement.
 */
export class InMemoryRegistryHeadReference
  implements ProtectedRegistryHeadPort
{
  public readonly profile = Object.freeze({
    implementation: 'memory-only-reference',
    linearizableScope: 'single-javascript-instance',
    durable: false,
    multiProcess: false,
    independentlyProtected: false,
    antiRollback: false,
  } as const);

  readonly #heads = new Map<string, RegistryHeadSnapshot>();

  public constructor(initialHeadsValue: readonly unknown[] = []) {
    assertCanonicalData(initialHeadsValue, 'Initial registry heads');
    for (const value of initialHeadsValue) {
      const head = validateRegistryHeadSnapshot(value);
      const key = serializeHeadKey(head);
      if (this.#heads.has(key)) {
        throw security('head-invalid', 'Duplicate initial registry head');
      }
      this.#heads.set(key, head);
    }
  }

  public readCurrent(keyValue: RegistryHeadKey): RegistryHeadSnapshot | null {
    const key = validateRegistryHeadKey(keyValue);
    return this.#heads.get(serializeHeadKey(key)) ?? null;
  }

  public compareAndSwap(
    inputValue: RegistryHeadCompareAndSwapInput,
  ): RegistryHeadCompareAndSwapOutcome {
    const input = validateRegistryHeadCompareAndSwapInput(inputValue);
    const serializedKey = serializeHeadKey(input.key);
    const current = this.#heads.get(serializedKey) ?? null;
    if (!headValuesEqual(current, input.expected)) return 'CONFLICT';
    assertHeadSuccessor(input.expected, input.next);
    this.#heads.set(serializedKey, input.next);
    return 'APPLIED';
  }

  public assertCurrent(expectedValue: RegistryHeadSnapshot): void {
    const expected = validateRegistryHeadSnapshot(expectedValue);
    const current = this.#heads.get(serializeHeadKey(expected)) ?? null;
    if (!headValuesEqual(current, expected)) {
      throw security(
        'stale-registry',
        'In-memory registry head no longer matches the expected snapshot',
      );
    }
  }

  public snapshot(): readonly RegistryHeadSnapshot[] {
    return Object.freeze(
      [...this.#heads.values()].sort((left, right) =>
        compareAscii(serializeHeadKey(left), serializeHeadKey(right)),
      ),
    );
  }
}

export function validateRegistryManifestExpectation(
  value: unknown,
): RegistryManifestExpectation {
  assertCanonicalData(value, 'Registry manifest expectation');
  const record = requireRecord(value, 'Registry manifest expectation');
  requireExactKeys(
    record,
    [
      'registryType',
      'workspaceId',
      'taskId',
      'rootObjectId',
      'policyDigest',
      'configurationDigest',
      'buildDigest',
      'manifestHash',
    ],
    'Registry manifest expectation',
  );
  return Object.freeze({
    registryType: requireRegistryType(record.registryType),
    workspaceId: requireIdentifier(record.workspaceId, 'Expected workspace ID'),
    taskId: requireIdentifier(record.taskId, 'Expected task ID'),
    rootObjectId: requireIdentifier(
      record.rootObjectId,
      'Expected root object ID',
    ),
    policyDigest: requireDigest(record.policyDigest, 'Expected policy digest'),
    configurationDigest: requireDigest(
      record.configurationDigest,
      'Expected configuration digest',
    ),
    buildDigest: requireDigest(record.buildDigest, 'Expected build digest'),
    manifestHash: requireDigest(record.manifestHash, 'Expected manifest hash'),
  });
}

export function validateTrustedRegistrySignerSnapshot(
  value: unknown,
  expectedKeyId?: string,
): TrustedRegistrySignerSnapshot {
  assertCanonicalData(value, 'Trusted registry signer snapshot');
  const record = requireRecord(value, 'Trusted registry signer snapshot');
  requireExactKeys(
    record,
    ['keyId', 'issuerId', 'role', 'trustEpoch', 'trustRegistryDigest'],
    'Trusted registry signer snapshot',
  );
  const keyId = requireIdentifier(record.keyId, 'Trusted signer key ID');
  if (expectedKeyId !== undefined && keyId !== expectedKeyId) {
    throw security(
      'signer-untrusted',
      'Trust resolver returned a snapshot for a different key',
    );
  }
  if (record.role !== 'registry-authority') {
    throw security(
      'signer-untrusted',
      'Trusted signer does not hold the registry-authority role',
    );
  }
  return Object.freeze({
    keyId,
    issuerId: requireIdentifier(record.issuerId, 'Trusted signer issuer ID'),
    role: 'registry-authority',
    trustEpoch: requirePositiveInteger(
      record.trustEpoch,
      'Trusted signer trust epoch',
    ),
    trustRegistryDigest: requireDigest(
      record.trustRegistryDigest,
      'Trusted signer registry digest',
    ),
  });
}

export function validateRegistryHeadKey(value: unknown): RegistryHeadKey {
  assertCanonicalData(value, 'Registry head key');
  const record = requireRecord(value, 'Registry head key');
  requireExactKeys(
    record,
    ['registryType', 'workspaceId', 'taskId', 'rootObjectId'],
    'Registry head key',
  );
  return Object.freeze({
    registryType: requireRegistryType(record.registryType),
    workspaceId: requireIdentifier(record.workspaceId, 'Head workspace ID'),
    taskId: requireIdentifier(record.taskId, 'Head task ID'),
    rootObjectId: requireIdentifier(record.rootObjectId, 'Head root object ID'),
  });
}

export function validateRegistryHeadSnapshot(
  value: unknown,
): RegistryHeadSnapshot {
  assertCanonicalData(value, 'Registry head snapshot');
  const record = requireRecord(value, 'Registry head snapshot');
  requireExactKeys(
    record,
    [
      'kind',
      'version',
      'registryType',
      'workspaceId',
      'taskId',
      'rootObjectId',
      'policyDigest',
      'configurationDigest',
      'buildDigest',
      'epoch',
      'manifestHash',
      'previousManifestHash',
    ],
    'Registry head snapshot',
  );
  if (
    record.kind !== REGISTRY_HEAD_KIND ||
    record.version !== REGISTRY_HEAD_VERSION
  ) {
    throw security('head-invalid', 'Registry head kind/version is invalid');
  }
  const epoch = requirePositiveInteger(record.epoch, 'Registry head epoch');
  const previousManifestHash = requireNullableDigest(
    record.previousManifestHash,
    'Registry head previous hash',
  );
  if (
    (epoch === 1 && previousManifestHash !== null) ||
    (epoch > 1 && previousManifestHash === null)
  ) {
    throw security(
      'head-invalid',
      'Registry head epoch and previous hash are inconsistent',
    );
  }
  return Object.freeze({
    kind: REGISTRY_HEAD_KIND,
    version: REGISTRY_HEAD_VERSION,
    registryType: requireRegistryType(record.registryType),
    workspaceId: requireIdentifier(record.workspaceId, 'Head workspace ID'),
    taskId: requireIdentifier(record.taskId, 'Head task ID'),
    rootObjectId: requireIdentifier(record.rootObjectId, 'Head root object ID'),
    policyDigest: requireDigest(record.policyDigest, 'Head policy digest'),
    configurationDigest: requireDigest(
      record.configurationDigest,
      'Head configuration digest',
    ),
    buildDigest: requireDigest(record.buildDigest, 'Head build digest'),
    epoch,
    manifestHash: requireDigest(record.manifestHash, 'Head manifest hash'),
    previousManifestHash,
  });
}

export function registryHeadKeyFromManifest(
  manifest: ScopedRegistryManifest,
): RegistryHeadKey {
  return Object.freeze({
    registryType: manifest.registryType,
    workspaceId: manifest.workspaceId,
    taskId: manifest.taskId,
    rootObjectId: manifest.rootObjectId,
  });
}

export function registryHeadFromManifest(
  manifest: ScopedRegistryManifest,
  manifestHashValue: string,
): RegistryHeadSnapshot {
  return Object.freeze({
    kind: REGISTRY_HEAD_KIND,
    version: REGISTRY_HEAD_VERSION,
    ...registryHeadKeyFromManifest(manifest),
    policyDigest: manifest.policyDigest,
    configurationDigest: manifest.configurationDigest,
    buildDigest: manifest.buildDigest,
    epoch: manifest.epoch,
    manifestHash: requireDigest(manifestHashValue, 'Manifest hash'),
    previousManifestHash: manifest.previousManifestHash,
  });
}

function validateRegistryHeadForKey(
  value: unknown,
  expectedKey: RegistryHeadKey,
): RegistryHeadSnapshot {
  const head = validateRegistryHeadSnapshot(value);
  if (serializeHeadKey(head) !== serializeHeadKey(expectedKey)) {
    throw security(
      'head-invalid',
      'Protected registry head returned a snapshot for a different scope',
    );
  }
  return head;
}

function assertExpectedBindings(
  manifest: ScopedRegistryManifest,
  expected: RegistryManifestExpectation,
): void {
  if (
    manifest.registryType !== expected.registryType ||
    manifest.workspaceId !== expected.workspaceId ||
    manifest.taskId !== expected.taskId ||
    manifest.rootObjectId !== expected.rootObjectId ||
    manifest.policyDigest !== expected.policyDigest ||
    manifest.configurationDigest !== expected.configurationDigest ||
    manifest.buildDigest !== expected.buildDigest
  ) {
    throw security(
      'binding-mismatch',
      'Signed registry manifest does not match the expected scope/commitments',
    );
  }
}

function classifyHeadTransition(
  current: RegistryHeadSnapshot | null,
  next: RegistryHeadSnapshot,
): RegistryAdmissionDisposition {
  if (current === null) {
    if (next.epoch !== 1 || next.previousManifestHash !== null) {
      throw security(
        'head-missing',
        'Protected registry head is missing for a non-genesis manifest',
      );
    }
    return 'installed-genesis';
  }
  if (headValuesEqual(current, next)) return 'already-current';
  if (next.epoch < current.epoch) {
    throw security(
      'rollback-detected',
      'Registry manifest epoch is older than the protected head',
    );
  }
  if (next.epoch === current.epoch) {
    throw security(
      'fork-detected',
      'A different registry manifest exists at the same protected epoch',
    );
  }
  if (next.epoch !== current.epoch + 1) {
    throw security(
      'epoch-gap',
      'Registry manifest skips one or more protected epochs',
    );
  }
  if (next.previousManifestHash !== current.manifestHash) {
    throw security(
      'fork-detected',
      'Registry manifest does not extend the protected current head',
    );
  }
  return 'installed-successor';
}

export function validateRegistryHeadCompareAndSwapInput(
  value: unknown,
): RegistryHeadCompareAndSwapInput {
  assertCanonicalData(value, 'Registry head CAS input');
  const record = requireRecord(value, 'Registry head CAS input');
  requireExactKeys(
    record,
    ['key', 'expected', 'next'],
    'Registry head CAS input',
  );
  const key = validateRegistryHeadKey(record.key);
  const expected =
    record.expected === null
      ? null
      : validateRegistryHeadForKey(record.expected, key);
  const next = validateRegistryHeadForKey(record.next, key);
  return Object.freeze({ key, expected, next });
}

function assertHeadSuccessor(
  expected: RegistryHeadSnapshot | null,
  next: RegistryHeadSnapshot,
): void {
  if (expected === null) {
    if (next.epoch !== 1 || next.previousManifestHash !== null) {
      throw security('head-invalid', 'Genesis registry head is invalid');
    }
    return;
  }
  if (
    next.epoch !== expected.epoch + 1 ||
    next.previousManifestHash !== expected.manifestHash ||
    serializeHeadKey(next) !== serializeHeadKey(expected)
  ) {
    throw security(
      'head-invalid',
      'Registry head CAS attempted a non-successor transition',
    );
  }
}

function requireServiceInput(value: unknown): {
  readonly envelope: unknown;
  readonly expected: unknown;
} {
  const record = requireDependencyRecord(value, ['envelope', 'expected']);
  return Object.freeze({
    envelope: record.envelope,
    expected: record.expected,
  });
}

function requireDependencyRecord(
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
    throw security(
      'input-invalid',
      'Registry service input must be a plain object',
    );
  }
  const names = Object.getOwnPropertyNames(value);
  const expected = [...expectedKeys].sort();
  const actual = [...names].sort();
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    throw security(
      'input-invalid',
      `Registry service input must contain exactly: ${expected.join(', ')}`,
    );
  }
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw security(
        'input-invalid',
        'Registry service input cannot contain accessors or hidden fields',
      );
    }
    result[name] = descriptor.value;
  }
  return result;
}

async function hashCanonicalManifest(
  manifest: ScopedRegistryManifest,
  sha256: RegistryHashPort['sha256'],
): Promise<string> {
  const digest = await sha256(
    encodeUtf8(
      `${SCOPED_REGISTRY_MANIFEST_HASH_DOMAIN}\0${canonicalizeJson(manifest)}`,
    ),
  );
  return requireDigest(digest, 'Registry hash result');
}

function memberKey(
  member: AdapterRegistryMember | EffectRegistryMember | RunnerRegistryMember,
): string {
  if (member.kind === 'adapter') {
    return `${member.adapterId}\0${member.operation}`;
  }
  if (member.kind === 'runner') {
    return `${member.runnerId}\0${member.profileId}`;
  }
  return member.effectId;
}

function headValuesEqual(
  left: RegistryHeadSnapshot | null,
  right: RegistryHeadSnapshot | null,
): boolean {
  if (left === null || right === null) return left === right;
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function serializeHeadKey(key: RegistryHeadKey): string {
  return canonicalizeJson({
    registryType: key.registryType,
    workspaceId: key.workspaceId,
    taskId: key.taskId,
    rootObjectId: key.rootObjectId,
  });
}

function assertCanonicalData(value: unknown, label: string): void {
  try {
    canonicalizeJson(value);
  } catch (error) {
    throw security(
      'input-invalid',
      error instanceof Error
        ? `${label} is not closed canonical data: ${error.message}`
        : `${label} is not closed canonical data`,
      error,
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
    throw security('input-invalid', `${label} must be a plain object`);
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
    throw security(
      'input-invalid',
      `${label} must contain exactly: ${expected.join(', ')}`,
    );
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw security('input-invalid', `${label} is invalid`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw security(
      'input-invalid',
      `${label} must be a lowercase SHA-256 digest`,
    );
  }
  return value;
}

function requireNullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : requireDigest(value, label);
}

function requireRegistryType(value: unknown): ScopedRegistryType {
  if (value !== 'adapter' && value !== 'effect' && value !== 'runner') {
    throw security('input-invalid', 'Registry type is invalid');
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw security('input-invalid', `${label} must be a positive safe integer`);
  }
  return value as number;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    throw security('port-invalid', `${label} must return canonical UTC`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw security('port-invalid', `${label} returned an invalid time`);
  }
  const iso = new Date(milliseconds).toISOString();
  const canonical = iso.endsWith('.000Z') ? iso.replace('.000Z', 'Z') : iso;
  if (canonical !== value) {
    throw security('port-invalid', `${label} must return canonical UTC`);
  }
  return value;
}

function pinMethod<Port extends object, Name extends keyof Port>(
  port: Port,
  name: Name,
  label: string,
): Port[Name] {
  if (port === null || typeof port !== 'object') {
    throw security('port-invalid', `${label} is missing`);
  }
  let target: object | null = port;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw security(
          'port-invalid',
          `${label} ${String(name)} must be a data method`,
        );
      }
      return descriptor.value.bind(port) as Port[Name];
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  throw security('port-invalid', `${label} must provide ${String(name)}()`);
}

function assertSynchronousVoid(value: unknown, label: string): void {
  if (value !== undefined) {
    throw security(
      'port-invalid',
      `${label} must complete synchronously and return undefined`,
    );
  }
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function security(
  code: RegistrySecurityErrorCode,
  message: string,
  originalCause?: unknown,
): RegistrySecurityError {
  return new RegistrySecurityError(code, message, originalCause);
}

// These aliases make discriminated narrowing explicit to API consumers.
export type CurrentAdapterRegistryManifest = AdapterRegistryManifest;
export type CurrentRunnerRegistryManifest = RunnerRegistryManifest;
export type CurrentEffectRegistryManifest = EffectRegistryManifest;
