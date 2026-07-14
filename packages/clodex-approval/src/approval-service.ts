import {
  SIGNATURE_ALGORITHM,
  canonicalizeJson,
  createEnvelopePreAuthenticationEncoding,
  encodeBase64Url,
  encodeUtf8,
  verifySignedIntentContract,
  type EnvelopeSignature,
  type HashPort,
  type RootAuthorizerRole,
  type SignatureVerificationInput,
  type SignatureVerifier,
  type SignedEnvelope,
  type VerifiedIntentContract,
} from '@clodex/contracts';
import {
  APPROVAL_ARTIFACT_KIND,
  APPROVAL_ARTIFACT_PAYLOAD_TYPE,
  APPROVAL_REVIEW_KIND,
  APPROVAL_SPEC_VERSION,
  approvalValuesEqual,
  assertDataOnlyTree,
  commitmentsFromArtifact,
  commitmentsFromContract,
  commitmentsFromReview,
  createCanonicalApprovalRenderModel,
  hashCanonicalApprovalArtifact,
  hashCanonicalApprovalAuthority,
  parseSignedApprovalArtifact,
  validateApprovalCommitmentSnapshot,
  validateApprovalReviewChallenge,
  validateApprovalReviewer,
  validateCanonicalApprovalArtifact,
  type ApprovalArtifactReplayReference,
  type ApprovalCommitmentSnapshot,
  type ApprovalReviewChallenge,
  type ApprovalReviewer,
  type ApprovalReviewerRole,
  type CanonicalApprovalArtifact,
  type CanonicalApprovalRenderModel,
} from './approval-artifact.js';

const DEFAULT_REVIEW_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1_000;

export interface ApprovalCommitmentScope {
  readonly contractId: string;
  readonly contractHash: string;
  readonly contractRevision: number;
  readonly taskId: string;
  readonly workspaceId: string;
}

export interface TrustedApprovalReviewer extends ApprovalReviewer {
  readonly status: 'active' | 'revoked';
}

export interface ApprovalReviewerIdentityPort {
  /** Resolved from the trusted review transport, never from UI request data. */
  authenticate(): ApprovalReviewer | Promise<ApprovalReviewer>;
}

export interface ApprovalSigningInput {
  readonly algorithm: typeof SIGNATURE_ALGORITHM;
  readonly payloadType: typeof APPROVAL_ARTIFACT_PAYLOAD_TYPE;
  readonly message: Uint8Array;
}

/** The signing implementation owns key selection; the caller cannot pick it. */
export interface ApprovalSigningPort {
  sign(input: ApprovalSigningInput): unknown | Promise<unknown>;
}

/**
 * Migration port for externally protected reviewer keys and revocation state.
 * Verification must enforce canonical low-S P-256/P1363 semantics.
 */
export interface ApprovalTrustStorePort {
  resolveReviewer(
    keyId: string,
  ): TrustedApprovalReviewer | null | Promise<TrustedApprovalReviewer | null>;
  verify(input: SignatureVerificationInput): boolean | Promise<boolean>;
  /** Synchronous final local fence immediately before one-shot admission. */
  assertTrusted(input: {
    readonly keyId: string;
    readonly reviewer: ApprovalReviewer;
  }): void;
}

export interface ApprovalCurrentCommitmentsPort {
  readCurrent(
    scope: ApprovalCommitmentScope,
  ): ApprovalCommitmentSnapshot | Promise<ApprovalCommitmentSnapshot>;
  /** Synchronous final local fence against policy/registry/renderer drift. */
  assertCurrent(input: {
    readonly scope: ApprovalCommitmentScope;
    readonly expected: ApprovalCommitmentSnapshot;
  }): void;
}

export interface ApprovalReplayRegistryPort {
  /** Atomically register an unconsumed review challenge. */
  registerReview(challenge: ApprovalReviewChallenge): void;
  /** Atomically consume the exact challenge, including its nonce. */
  consumeReview(challenge: ApprovalReviewChallenge): void;
  /** Atomically admit an artifact reference exactly once. */
  consumeArtifact(reference: ApprovalArtifactReplayReference): void;
}

export interface ApprovalIdPort {
  nextReviewId(): string;
  nextApprovalId(): string;
  nextNonce(): string;
}

export interface ApprovalClockPort {
  /** Synchronous trusted clock used by the final one-shot admission fence. */
  now(): string;
}

export interface CanonicalApprovalServiceDependencies {
  readonly hash: HashPort;
  readonly contractSignatures: SignatureVerifier;
  readonly identity: ApprovalReviewerIdentityPort;
  readonly signing: ApprovalSigningPort;
  readonly trustStore: ApprovalTrustStorePort;
  readonly commitments: ApprovalCurrentCommitmentsPort;
  readonly replay: ApprovalReplayRegistryPort;
  readonly ids: ApprovalIdPort;
  readonly clock: ApprovalClockPort;
  readonly acceptedContractRoles?: readonly RootAuthorizerRole[];
  readonly acceptedReviewerRoles?: readonly ApprovalReviewerRole[];
  readonly reviewTtlMs?: number;
  readonly approvalTtlMs?: number;
}

export interface PreparedCanonicalApprovalReview {
  readonly model: CanonicalApprovalRenderModel;
  readonly canonicalModel: string;
  readonly challenge: ApprovalReviewChallenge;
}

export interface IssuedCanonicalApproval {
  readonly artifact: CanonicalApprovalArtifact;
  readonly canonicalPayload: string;
  readonly envelope: SignedEnvelope;
  readonly signerKeyId: string;
}

export interface VerifiedCanonicalApproval {
  readonly artifact: CanonicalApprovalArtifact;
  readonly canonicalPayload: string;
  readonly artifactDigest: string;
  readonly signerKeyId: string;
  readonly reviewer: ApprovalReviewer;
  readonly model: CanonicalApprovalRenderModel;
  readonly verifiedContract: VerifiedIntentContract;
}

export type ApprovalSecurityErrorCode =
  | 'artifact-mismatch'
  | 'contract-invalid'
  | 'expired'
  | 'identity-drift'
  | 'invalid-port-output'
  | 'review-mismatch'
  | 'reviewer-untrusted'
  | 'signature-invalid'
  | 'stale-commitment';

export class ApprovalSecurityError extends Error {
  public constructor(
    public readonly code: ApprovalSecurityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalSecurityError';
  }
}

interface SnapshottedApprovalDependencies {
  readonly hash: HashPort;
  readonly contractSignatures: SignatureVerifier;
  readonly identity: ApprovalReviewerIdentityPort;
  readonly signing: ApprovalSigningPort;
  readonly trustStore: ApprovalTrustStorePort;
  readonly commitments: ApprovalCurrentCommitmentsPort;
  readonly replay: ApprovalReplayRegistryPort;
  readonly ids: ApprovalIdPort;
  readonly clock: ApprovalClockPort;
  readonly acceptedContractRoles: readonly RootAuthorizerRole[];
  readonly acceptedReviewerRoles: ReadonlySet<ApprovalReviewerRole>;
  readonly reviewTtlMs: number;
  readonly approvalTtlMs: number;
}

/**
 * Shell- and UI-independent reference approval boundary.
 *
 * This class deliberately does not implement a dialog, key store, P-256, or
 * durable registry. Those are injected migration ports. Its authorization
 * methods fail closed on identity, signature, contract, digest, renderer,
 * expiry, or replay drift.
 */
export class CanonicalApprovalService {
  readonly #dependencies: SnapshottedApprovalDependencies;

  public constructor(dependencies: CanonicalApprovalServiceDependencies) {
    const hash = readDependencyField<HashPort>(
      dependencies,
      'hash',
      'Hash port',
    );
    const contractSignatures = readDependencyField<SignatureVerifier>(
      dependencies,
      'contractSignatures',
      'Contract signature port',
    );
    const identity = readDependencyField<ApprovalReviewerIdentityPort>(
      dependencies,
      'identity',
      'Reviewer identity port',
    );
    const signing = readDependencyField<ApprovalSigningPort>(
      dependencies,
      'signing',
      'Approval signing port',
    );
    const trustStore = readDependencyField<ApprovalTrustStorePort>(
      dependencies,
      'trustStore',
      'Approval trust store',
    );
    const commitments = readDependencyField<ApprovalCurrentCommitmentsPort>(
      dependencies,
      'commitments',
      'Commitment port',
    );
    const replay = readDependencyField<ApprovalReplayRegistryPort>(
      dependencies,
      'replay',
      'Replay registry',
    );
    const ids = readDependencyField<ApprovalIdPort>(
      dependencies,
      'ids',
      'ID port',
    );
    const clock = readDependencyField<ApprovalClockPort>(
      dependencies,
      'clock',
      'Clock port',
    );
    const reviewTtlMs = validateTtl(
      readOptionalDependencyField<number>(
        dependencies,
        'reviewTtlMs',
        'Review TTL',
      ) ?? DEFAULT_REVIEW_TTL_MS,
      'Review TTL',
    );
    const approvalTtlMs = validateTtl(
      readOptionalDependencyField<number>(
        dependencies,
        'approvalTtlMs',
        'Approval TTL',
      ) ?? DEFAULT_APPROVAL_TTL_MS,
      'Approval TTL',
    );
    const acceptedContractRoles = validateContractRoles(
      readOptionalDependencyField<readonly RootAuthorizerRole[]>(
        dependencies,
        'acceptedContractRoles',
        'Accepted contract roles',
      ) ?? ['human-authorizer', 'policy-authorizer'],
    );
    const acceptedReviewerRoles = validateReviewerRoles(
      readOptionalDependencyField<readonly ApprovalReviewerRole[]>(
        dependencies,
        'acceptedReviewerRoles',
        'Accepted reviewer roles',
      ) ?? ['human-reviewer'],
    );
    this.#dependencies = Object.freeze({
      hash: Object.freeze({
        sha256: pinPortMethod(hash, 'sha256', 'Hash port'),
      }),
      contractSignatures: Object.freeze({
        resolveTrustedSigner: pinPortMethod(
          contractSignatures,
          'resolveTrustedSigner',
          'Contract signature port',
        ),
        verify: pinPortMethod(
          contractSignatures,
          'verify',
          'Contract signature port',
        ),
        assertTrusted: pinPortMethod(
          contractSignatures,
          'assertTrusted',
          'Contract signature port',
        ),
      }),
      identity: Object.freeze({
        authenticate: pinPortMethod(
          identity,
          'authenticate',
          'Reviewer identity port',
        ),
      }),
      signing: Object.freeze({
        sign: pinPortMethod(signing, 'sign', 'Approval signing port'),
      }),
      trustStore: Object.freeze({
        resolveReviewer: pinPortMethod(
          trustStore,
          'resolveReviewer',
          'Approval trust store',
        ),
        verify: pinPortMethod(trustStore, 'verify', 'Approval trust store'),
        assertTrusted: pinPortMethod(
          trustStore,
          'assertTrusted',
          'Approval trust store',
        ),
      }),
      commitments: Object.freeze({
        readCurrent: pinPortMethod(
          commitments,
          'readCurrent',
          'Commitment port',
        ),
        assertCurrent: pinPortMethod(
          commitments,
          'assertCurrent',
          'Commitment port',
        ),
      }),
      replay: Object.freeze({
        registerReview: pinPortMethod(
          replay,
          'registerReview',
          'Replay registry',
        ),
        consumeReview: pinPortMethod(
          replay,
          'consumeReview',
          'Replay registry',
        ),
        consumeArtifact: pinPortMethod(
          replay,
          'consumeArtifact',
          'Replay registry',
        ),
      }),
      ids: Object.freeze({
        nextReviewId: pinPortMethod(ids, 'nextReviewId', 'ID port'),
        nextApprovalId: pinPortMethod(ids, 'nextApprovalId', 'ID port'),
        nextNonce: pinPortMethod(ids, 'nextNonce', 'ID port'),
      }),
      clock: Object.freeze({
        now: pinPortMethod(clock, 'now', 'Clock port'),
      }),
      acceptedContractRoles,
      acceptedReviewerRoles,
      reviewTtlMs,
      approvalTtlMs,
    });
  }

  /**
   * Create the exact model a trusted UI must render and a one-time challenge
   * it must echo on submit. No non-authoritative contract text enters model.
   */
  public async prepareReview(input: {
    readonly signedContract: unknown;
  }): Promise<PreparedCanonicalApprovalReview> {
    const request = requireServiceInput(input, ['signedContract']);
    const verifiedContract = await this.verifyContract(request.signedContract);
    const now = this.currentTime();
    assertContractActive(verifiedContract, now);
    const scope = scopeFor(verifiedContract);
    const expected = commitmentsFromContract(verifiedContract.contract);
    await this.assertFreshCommitments(scope, expected);
    const reviewer = await this.currentReviewer();
    this.assertAcceptedReviewer(reviewer);
    const model = createCanonicalApprovalRenderModel(verifiedContract.contract);
    const authorityDigest = await hashCanonicalApprovalAuthority(
      model,
      this.#dependencies.hash,
    );
    const expiresAt = boundedExpiry(
      now,
      this.#dependencies.reviewTtlMs,
      verifiedContract.contract.validity.expiresAt,
    );
    const challenge = validateApprovalReviewChallenge({
      kind: APPROVAL_REVIEW_KIND,
      specVersion: APPROVAL_SPEC_VERSION,
      reviewId: this.#dependencies.ids.nextReviewId(),
      contractHash: verifiedContract.contractHash,
      contractRevision: verifiedContract.contract.revision,
      authorityDigest,
      policyDigest: expected.policyDigest,
      adapterRegistryDigest: expected.adapterRegistryDigest,
      runnerRegistryDigest: expected.runnerRegistryDigest,
      effectRegistryDigest: expected.effectRegistryDigest,
      rendererVersion: expected.rendererVersion,
      reviewer,
      issuedAt: now,
      expiresAt,
      nonce: this.#dependencies.ids.nextNonce(),
    });

    const finalReviewer = await this.currentReviewer();
    if (!approvalValuesEqual(reviewer, finalReviewer)) {
      throw new ApprovalSecurityError(
        'identity-drift',
        'Reviewer identity changed while preparing the review',
      );
    }
    const finalNow = this.currentTime();
    assertActiveWindow(
      challenge.issuedAt,
      challenge.expiresAt,
      finalNow,
      'Review',
    );
    assertContractActive(verifiedContract, finalNow);
    this.assertCurrentSynchronously(scope, expected);
    assertSynchronous(
      this.#dependencies.replay.registerReview(challenge),
      'Review registration',
    );
    return Object.freeze({
      model,
      canonicalModel: canonicalizeJson(model),
      challenge,
    });
  }

  /**
   * Consume one exact trusted-UI review challenge and mint one signed artifact.
   * Any failed submission consumes the challenge; a fresh review is required.
   */
  public async issueApproval(input: {
    readonly signedContract: unknown;
    readonly challenge: unknown;
  }): Promise<IssuedCanonicalApproval> {
    const request = requireServiceInput(input, ['challenge', 'signedContract']);
    const challenge = validateApprovalReviewChallenge(request.challenge);
    assertSynchronous(
      this.#dependencies.replay.consumeReview(challenge),
      'Review consumption',
    );

    const verifiedContract = await this.verifyContract(request.signedContract);
    const now = this.currentTime();
    assertActiveWindow(challenge.issuedAt, challenge.expiresAt, now, 'Review');
    assertBoundedLifetime(
      challenge.issuedAt,
      challenge.expiresAt,
      this.#dependencies.reviewTtlMs,
      'Review',
    );
    assertContractActive(verifiedContract, now);
    const model = createCanonicalApprovalRenderModel(verifiedContract.contract);
    const authorityDigest = await hashCanonicalApprovalAuthority(
      model,
      this.#dependencies.hash,
    );
    const scope = scopeFor(verifiedContract);
    const expected = commitmentsFromContract(verifiedContract.contract);
    assertReviewBindsContract(
      challenge,
      verifiedContract,
      authorityDigest,
      expected,
    );
    const reviewer = await this.currentReviewer();
    this.assertAcceptedReviewer(reviewer);
    if (!approvalValuesEqual(reviewer, challenge.reviewer)) {
      throw new ApprovalSecurityError(
        'identity-drift',
        'Submitting reviewer does not match the prepared review identity',
      );
    }
    await this.assertFreshCommitments(scope, expected);

    const artifact = validateCanonicalApprovalArtifact({
      kind: APPROVAL_ARTIFACT_KIND,
      specVersion: APPROVAL_SPEC_VERSION,
      approvalId: this.#dependencies.ids.nextApprovalId(),
      reviewId: challenge.reviewId,
      contractHash: verifiedContract.contractHash,
      contractRevision: verifiedContract.contract.revision,
      authorityDigest,
      policyDigest: expected.policyDigest,
      adapterRegistryDigest: expected.adapterRegistryDigest,
      runnerRegistryDigest: expected.runnerRegistryDigest,
      effectRegistryDigest: expected.effectRegistryDigest,
      rendererVersion: expected.rendererVersion,
      reviewer,
      issuedAt: now,
      expiresAt: boundedExpiry(
        now,
        this.#dependencies.approvalTtlMs,
        verifiedContract.contract.validity.expiresAt,
      ),
      nonce: this.#dependencies.ids.nextNonce(),
    });
    const canonicalPayload = canonicalizeJson(artifact);
    const message = createEnvelopePreAuthenticationEncoding(
      APPROVAL_ARTIFACT_PAYLOAD_TYPE,
      canonicalPayload,
    );
    const signatureValue = await this.#dependencies.signing.sign({
      algorithm: SIGNATURE_ALGORITHM,
      payloadType: APPROVAL_ARTIFACT_PAYLOAD_TYPE,
      message: message.slice(),
    });
    const parsed = parseIssuedEnvelope(artifact, signatureValue);
    const trusted = await this.resolveTrustedReviewer(parsed.signature.keyId);
    assertTrustedReviewerMatches(trusted, reviewer);
    const signatureValid = await this.#dependencies.trustStore.verify({
      algorithm: parsed.signature.algorithm,
      keyId: parsed.signature.keyId,
      signature: parsed.signature.signature,
      message: parsed.message.slice(),
    });
    if (signatureValid !== true) {
      throw new ApprovalSecurityError(
        'signature-invalid',
        'Approval signer returned a signature rejected by the trust store',
      );
    }

    await this.assertFreshCommitments(scope, expected);
    const finalReviewer = await this.currentReviewer();
    if (!approvalValuesEqual(reviewer, finalReviewer)) {
      throw new ApprovalSecurityError(
        'identity-drift',
        'Reviewer identity changed while signing the Approval Artifact',
      );
    }
    const finalNow = this.currentTime();
    assertActiveWindow(
      artifact.issuedAt,
      artifact.expiresAt,
      finalNow,
      'Approval Artifact',
    );
    assertContractActive(verifiedContract, finalNow);
    this.assertTrustSynchronously(parsed.signature.keyId, reviewer);
    this.assertCurrentSynchronously(scope, expected);

    return Object.freeze({
      artifact,
      canonicalPayload,
      envelope: parsed.envelope,
      signerKeyId: parsed.signature.keyId,
    });
  }

  /**
   * Verify every binding against the signed contract and current trusted
   * registries, then atomically consume the artifact's replay reference.
   */
  public async verifyAndConsumeApproval(input: {
    readonly signedContract: unknown;
    readonly signedApproval: unknown;
  }): Promise<VerifiedCanonicalApproval> {
    const request = requireServiceInput(input, [
      'signedApproval',
      'signedContract',
    ]);
    const parsed = parseSignedApprovalArtifact(request.signedApproval);
    const verifiedContract = await this.verifyContract(request.signedContract);
    const now = this.currentTime();
    assertActiveWindow(
      parsed.artifact.issuedAt,
      parsed.artifact.expiresAt,
      now,
      'Approval Artifact',
    );
    assertBoundedLifetime(
      parsed.artifact.issuedAt,
      parsed.artifact.expiresAt,
      this.#dependencies.approvalTtlMs,
      'Approval Artifact',
    );
    assertContractActive(verifiedContract, now);
    const model = createCanonicalApprovalRenderModel(verifiedContract.contract);
    const authorityDigest = await hashCanonicalApprovalAuthority(
      model,
      this.#dependencies.hash,
    );
    const expected = commitmentsFromContract(verifiedContract.contract);
    assertArtifactBindsContract(
      parsed.artifact,
      verifiedContract,
      authorityDigest,
      expected,
    );
    this.assertAcceptedReviewer(parsed.artifact.reviewer);
    const trusted = await this.resolveTrustedReviewer(parsed.signature.keyId);
    assertTrustedReviewerMatches(trusted, parsed.artifact.reviewer);
    const signatureValid = await this.#dependencies.trustStore.verify({
      algorithm: parsed.signature.algorithm,
      keyId: parsed.signature.keyId,
      signature: parsed.signature.signature,
      message: parsed.message.slice(),
    });
    if (signatureValid !== true) {
      throw new ApprovalSecurityError(
        'signature-invalid',
        'Approval Artifact signature is invalid',
      );
    }
    const scope = scopeFor(verifiedContract);
    await this.assertFreshCommitments(scope, expected);
    const artifactDigest = await hashCanonicalApprovalArtifact(
      parsed.artifact,
      this.#dependencies.hash,
    );

    await this.assertFreshCommitments(scope, expected);
    const finalNow = this.currentTime();
    assertActiveWindow(
      parsed.artifact.issuedAt,
      parsed.artifact.expiresAt,
      finalNow,
      'Approval Artifact',
    );
    assertContractActive(verifiedContract, finalNow);
    this.assertTrustSynchronously(
      parsed.signature.keyId,
      parsed.artifact.reviewer,
    );
    this.assertCurrentSynchronously(scope, expected);
    const replayReference: ApprovalArtifactReplayReference = {
      approvalId: parsed.artifact.approvalId,
      artifactDigest,
      contractHash: parsed.artifact.contractHash,
      contractRevision: parsed.artifact.contractRevision,
      nonce: parsed.artifact.nonce,
      expiresAt: parsed.artifact.expiresAt,
    };
    assertSynchronous(
      this.#dependencies.replay.consumeArtifact(replayReference),
      'Approval Artifact consumption',
    );

    return Object.freeze({
      artifact: parsed.artifact,
      canonicalPayload: parsed.canonicalPayload,
      artifactDigest,
      signerKeyId: parsed.signature.keyId,
      reviewer: parsed.artifact.reviewer,
      model,
      verifiedContract,
    });
  }

  private async verifyContract(
    signedContract: unknown,
  ): Promise<VerifiedIntentContract> {
    try {
      assertDataOnlyTree(signedContract, 'Signed Intent Contract');
      return await verifySignedIntentContract(signedContract, {
        hash: this.#dependencies.hash,
        signatures: this.#dependencies.contractSignatures,
        acceptedRootRoles: this.#dependencies.acceptedContractRoles,
      });
    } catch (error) {
      throw new ApprovalSecurityError(
        'contract-invalid',
        error instanceof Error
          ? `Intent Contract verification failed: ${error.message}`
          : 'Intent Contract verification failed',
      );
    }
  }

  private async currentReviewer(): Promise<ApprovalReviewer> {
    try {
      return validateApprovalReviewer(
        await this.#dependencies.identity.authenticate(),
      );
    } catch (error) {
      throw new ApprovalSecurityError(
        'invalid-port-output',
        error instanceof Error
          ? `Reviewer identity port returned invalid data: ${error.message}`
          : 'Reviewer identity port returned invalid data',
      );
    }
  }

  private currentTime(): string {
    return validateTimestamp(this.#dependencies.clock.now(), 'Clock');
  }

  private assertAcceptedReviewer(reviewer: ApprovalReviewer): void {
    if (!this.#dependencies.acceptedReviewerRoles.has(reviewer.role)) {
      throw new ApprovalSecurityError(
        'reviewer-untrusted',
        'Reviewer role is not accepted by external approval policy',
      );
    }
  }

  private async resolveTrustedReviewer(
    keyId: string,
  ): Promise<TrustedApprovalReviewer> {
    const value = await this.#dependencies.trustStore.resolveReviewer(keyId);
    const trusted = validateTrustedReviewer(value);
    if (!trusted || trusted.status !== 'active') {
      throw new ApprovalSecurityError(
        'reviewer-untrusted',
        'Approval signer key is missing, revoked, or inactive',
      );
    }
    this.assertAcceptedReviewer(trusted);
    return trusted;
  }

  private async assertFreshCommitments(
    scope: ApprovalCommitmentScope,
    expected: ApprovalCommitmentSnapshot,
  ): Promise<void> {
    let current: ApprovalCommitmentSnapshot;
    try {
      current = validateApprovalCommitmentSnapshot(
        await this.#dependencies.commitments.readCurrent(scope),
      );
    } catch (error) {
      throw new ApprovalSecurityError(
        'invalid-port-output',
        error instanceof Error
          ? `Commitment port returned invalid data: ${error.message}`
          : 'Commitment port returned invalid data',
      );
    }
    if (!approvalValuesEqual(current, expected)) {
      throw new ApprovalSecurityError(
        'stale-commitment',
        'Intent Contract policy, registry, or renderer binding is stale',
      );
    }
  }

  private assertCurrentSynchronously(
    scope: ApprovalCommitmentScope,
    expected: ApprovalCommitmentSnapshot,
  ): void {
    assertSynchronous(
      this.#dependencies.commitments.assertCurrent({ scope, expected }),
      'Final commitment fence',
    );
  }

  private assertTrustSynchronously(
    keyId: string,
    reviewer: ApprovalReviewer,
  ): void {
    assertSynchronous(
      this.#dependencies.trustStore.assertTrusted({ keyId, reviewer }),
      'Final reviewer trust fence',
    );
  }
}

function parseIssuedEnvelope(
  artifact: CanonicalApprovalArtifact,
  signatureValue: unknown,
) {
  assertDataOnlyTree(signatureValue, 'Approval signing port result');
  const envelope: SignedEnvelope = {
    payloadType: APPROVAL_ARTIFACT_PAYLOAD_TYPE,
    payload: encodeBase64Url(encodeUtf8(canonicalizeJson(artifact))),
    signatures: [signatureValue as EnvelopeSignature],
  };
  return parseSignedApprovalArtifact(envelope);
}

function assertReviewBindsContract(
  review: ApprovalReviewChallenge,
  verifiedContract: VerifiedIntentContract,
  authorityDigest: string,
  expected: ApprovalCommitmentSnapshot,
): void {
  if (
    review.contractHash !== verifiedContract.contractHash ||
    review.contractRevision !== verifiedContract.contract.revision ||
    review.authorityDigest !== authorityDigest ||
    Date.parse(review.issuedAt) <
      Date.parse(verifiedContract.contract.validity.notBefore) ||
    Date.parse(review.expiresAt) >
      Date.parse(verifiedContract.contract.validity.expiresAt) ||
    !approvalValuesEqual(commitmentsFromReview(review), expected)
  ) {
    throw new ApprovalSecurityError(
      'review-mismatch',
      'Review challenge does not bind the exact current contract authority',
    );
  }
}

function assertArtifactBindsContract(
  artifact: CanonicalApprovalArtifact,
  verifiedContract: VerifiedIntentContract,
  authorityDigest: string,
  expected: ApprovalCommitmentSnapshot,
): void {
  if (
    artifact.contractHash !== verifiedContract.contractHash ||
    artifact.contractRevision !== verifiedContract.contract.revision ||
    artifact.authorityDigest !== authorityDigest ||
    Date.parse(artifact.issuedAt) <
      Date.parse(verifiedContract.contract.validity.notBefore) ||
    Date.parse(artifact.expiresAt) >
      Date.parse(verifiedContract.contract.validity.expiresAt) ||
    !approvalValuesEqual(commitmentsFromArtifact(artifact), expected)
  ) {
    throw new ApprovalSecurityError(
      'artifact-mismatch',
      'Approval Artifact does not bind the exact current contract authority',
    );
  }
}

function assertTrustedReviewerMatches(
  trusted: TrustedApprovalReviewer,
  reviewer: ApprovalReviewer,
): void {
  if (
    trusted.status !== 'active' ||
    trusted.reviewerId !== reviewer.reviewerId ||
    trusted.role !== reviewer.role
  ) {
    throw new ApprovalSecurityError(
      'reviewer-untrusted',
      'Signer trust entry does not match the artifact reviewer identity',
    );
  }
}

function assertContractActive(
  verifiedContract: VerifiedIntentContract,
  now: string,
): void {
  assertActiveWindow(
    verifiedContract.contract.validity.notBefore,
    verifiedContract.contract.validity.expiresAt,
    now,
    'Intent Contract',
  );
}

function assertActiveWindow(
  notBefore: string,
  expiresAt: string,
  now: string,
  label: string,
): void {
  const nowMs = Date.parse(now);
  if (nowMs < Date.parse(notBefore) || nowMs >= Date.parse(expiresAt)) {
    throw new ApprovalSecurityError(
      'expired',
      `${label} is not active at the trusted current time`,
    );
  }
}

function assertBoundedLifetime(
  issuedAt: string,
  expiresAt: string,
  maximumTtlMs: number,
  label: string,
): void {
  if (Date.parse(expiresAt) - Date.parse(issuedAt) > maximumTtlMs) {
    throw new ApprovalSecurityError(
      'expired',
      `${label} exceeds the locally accepted maximum lifetime`,
    );
  }
}

function scopeFor(
  verifiedContract: VerifiedIntentContract,
): ApprovalCommitmentScope {
  const contract = verifiedContract.contract;
  return Object.freeze({
    contractId: contract.contractId,
    contractHash: verifiedContract.contractHash,
    contractRevision: contract.revision,
    taskId: contract.audience.taskId,
    workspaceId: contract.audience.workspaceId,
  });
}

function boundedExpiry(
  now: string,
  ttlMs: number,
  outerExpiry: string,
): string {
  const expiryMs = Math.min(Date.parse(now) + ttlMs, Date.parse(outerExpiry));
  if (expiryMs <= Date.parse(now)) {
    throw new ApprovalSecurityError(
      'expired',
      'No positive approval validity window remains',
    );
  }
  return canonicalTimestamp(expiryMs);
}

function canonicalTimestamp(milliseconds: number): string {
  const timestamp = new Date(milliseconds).toISOString();
  return timestamp.endsWith('.000Z')
    ? timestamp.replace('.000Z', 'Z')
    : timestamp;
}

function validateTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 32) {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      `${label} timestamp must be a bounded string`,
    );
  }
  try {
    encodeUtf8(value);
  } catch {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      `${label} timestamp contains invalid Unicode`,
    );
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    canonicalTimestamp(milliseconds) !== value
  ) {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      `${label} timestamp must be canonical UTC`,
    );
  }
  return value;
}

function validateTrustedReviewer(
  value: unknown,
): TrustedApprovalReviewer | null {
  if (value === null) return null;
  assertDataOnlyTree(value, 'Trusted reviewer entry');
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      'Trust store reviewer entry must be a plain object',
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'reviewerId' ||
    keys[1] !== 'role' ||
    keys[2] !== 'status'
  ) {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      'Trust store reviewer entry has unknown or missing fields',
    );
  }
  const reviewer = validateApprovalReviewer({
    reviewerId: record.reviewerId,
    role: record.role,
  });
  if (record.status !== 'active' && record.status !== 'revoked') {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      'Trust store reviewer status is unsupported',
    );
  }
  return Object.freeze({ ...reviewer, status: record.status });
}

function validateTtl(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > MAX_TTL_MS
  ) {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      `${label} must be a positive bounded safe integer`,
    );
  }
  return value as number;
}

function validateContractRoles(
  roles: readonly RootAuthorizerRole[],
): readonly RootAuthorizerRole[] {
  assertDataOnlyTree(roles, 'Accepted contract roles');
  const unique = new Set<RootAuthorizerRole>();
  for (const role of roles) {
    if (role !== 'human-authorizer' && role !== 'policy-authorizer') {
      throw new ApprovalSecurityError(
        'invalid-port-output',
        'Accepted contract signer role is unsupported',
      );
    }
    unique.add(role);
  }
  if (unique.size === 0) {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      'At least one contract signer role must be accepted',
    );
  }
  return Object.freeze([...unique].sort());
}

function validateReviewerRoles(
  roles: readonly ApprovalReviewerRole[],
): ReadonlySet<ApprovalReviewerRole> {
  assertDataOnlyTree(roles, 'Accepted reviewer roles');
  const unique = new Set<ApprovalReviewerRole>();
  for (const role of roles) {
    if (role !== 'human-reviewer' && role !== 'policy-reviewer') {
      throw new ApprovalSecurityError(
        'invalid-port-output',
        'Accepted reviewer role is unsupported',
      );
    }
    unique.add(role);
  }
  if (unique.size === 0) {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      'At least one reviewer role must be accepted',
    );
  }
  return unique;
}

function assertSynchronous(value: unknown, label: string): void {
  if (value !== undefined) {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      `${label} must synchronously return undefined`,
    );
  }
}

function requireServiceInput(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      'Approval service input must be a plain data wrapper',
    );
  }
  const names = Object.getOwnPropertyNames(value);
  const keys = Object.keys(value).sort();
  if (
    names.length !== keys.length ||
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      'Approval service input has unknown or hidden fields',
    );
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor)) {
      throw new ApprovalSecurityError(
        'invalid-port-output',
        'Approval service input cannot contain accessors',
      );
    }
  }
  return value as Record<string, unknown>;
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
    throw new ApprovalSecurityError(
      'invalid-port-output',
      `${label} is missing`,
    );
  }
  let target: object | null = port;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw new ApprovalSecurityError(
          'invalid-port-output',
          `${label} ${String(name)} must be a data method`,
        );
      }
      return descriptor.value.bind(port) as Port[Name];
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  throw new ApprovalSecurityError(
    'invalid-port-output',
    `${label} must provide ${String(name)}()`,
  );
}

function readDependencyField<T>(
  dependencies: object,
  name: string,
  label: string,
): T {
  if (
    dependencies === null ||
    (typeof dependencies !== 'object' && typeof dependencies !== 'function')
  ) {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      'Approval service dependencies are required',
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(dependencies, name);
  if (!descriptor || !('value' in descriptor)) {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      `${label} must be an own data field`,
    );
  }
  return descriptor.value as T;
}

function readOptionalDependencyField<T>(
  dependencies: object,
  name: string,
  label: string,
): T | undefined {
  if (
    dependencies === null ||
    (typeof dependencies !== 'object' && typeof dependencies !== 'function')
  ) {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      'Approval service dependencies are required',
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(dependencies, name);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) {
    throw new ApprovalSecurityError(
      'invalid-port-output',
      `${label} must be an own data field`,
    );
  }
  return descriptor.value as T | undefined;
}
