import { describe, expect, it } from 'vitest';
import {
  INTENT_CONTRACT_PAYLOAD_TYPE,
  canonicalizeJson,
  encodeBase64Url,
  encodeUtf8,
  type HashPort,
  type SafeCodingIntentContract,
  type SignedEnvelope,
} from '@clodex/contracts';
import {
  APPROVAL_ARTIFACT_PAYLOAD_TYPE,
  ApprovalReplayError,
  ApprovalValidationError,
  CanonicalApprovalService,
  InMemoryApprovalReplayRegistry,
  createCanonicalApprovalRenderModel,
  hashCanonicalApprovalAuthority,
  parseSignedApprovalArtifact,
  validateCanonicalApprovalArtifact,
  validateCanonicalApprovalRenderModel,
  type ApprovalCommitmentSnapshot,
  type ApprovalReviewer,
  type CanonicalApprovalArtifact,
  type CanonicalApprovalServiceDependencies,
  type IssuedCanonicalApproval,
  type TrustedApprovalReviewer,
} from './index.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const REVIEW_ID_1 = '10000000-0000-4000-8000-000000000001';
const REVIEW_ID_2 = '10000000-0000-4000-8000-000000000002';
const APPROVAL_ID_1 = '20000000-0000-4000-8000-000000000001';
const APPROVAL_ID_2 = '20000000-0000-4000-8000-000000000002';
const SIGNER_KEY = 'approval:key:one';

function sorted<Value>(values: readonly Value[]): readonly Value[] {
  return [...values].sort((left, right) => {
    const leftJson = canonicalizeJson(left);
    const rightJson = canonicalizeJson(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
}

function contractFixture(): SafeCodingIntentContract {
  return {
    kind: 'clodex.intent-contract',
    specVersion: '1.0.0',
    contractId: '00000000-0000-4000-8000-000000000001',
    revision: 1,
    previousRevisionHash: null,
    issuedAt: '2026-07-14T00:00:00Z',
    validity: {
      notBefore: '2026-07-14T00:00:00Z',
      expiresAt: '2026-07-14T02:00:00Z',
    },
    subject: {
      principalId: 'agent:one',
      instanceId: 'runtime:one',
    },
    audience: {
      guardianId: 'guardian:local',
      executorId: 'executor:sandbox',
      runtimeEpoch: 7,
      taskId: 'task:approval',
      workspaceId: 'workspace:repo',
    },
    bindings: {
      policyDigest: HASH_A,
      adapterRegistryDigest: HASH_B,
      runnerRegistryDigest: HASH_C,
      effectRegistryDigest: HASH_D,
      approvalRendererVersion: 'approval-renderer:1',
    },
    authority: {
      filesystem: sorted([
        {
          action: 'filesystem.read',
          selector: { kind: 'tree', path: 'src' },
        },
        {
          action: 'filesystem.replace',
          selector: { kind: 'file', path: 'src/auth.ts' },
        },
      ]),
      git: sorted([{ action: 'git.diff' }, { action: 'git.status' }]),
      testProfiles: ['tests.unit'],
      allowedEffectClasses: [
        'local.observation',
        'local.reversible',
        'sandbox.ephemeral',
      ],
      limits: {
        maxUniqueModifiedFiles: 4,
        maxMutationBytes: 32_768,
        maxTestRuns: 2,
      },
      ambientAuthority: {
        network: false,
        secrets: false,
        shell: false,
        delete: false,
        gitCommit: false,
        gitPush: false,
      },
      delegation: { allowed: false, maxDepth: 0 },
    },
    nonAuthoritative: {
      goalLabel: 'LLM summary must not authorize anything',
      notes: ['Untrusted model prose.'],
    },
  };
}

function signedContract(
  contract: SafeCodingIntentContract = contractFixture(),
): SignedEnvelope {
  return {
    payloadType: INTENT_CONTRACT_PAYLOAD_TYPE,
    payload: encodeBase64Url(encodeUtf8(canonicalizeJson(contract))),
    signatures: [
      {
        keyId: 'contract:key:one',
        algorithm: 'P-256-SHA256-P1363',
        signature: encodeBase64Url(new Uint8Array(64)),
      },
    ],
  };
}

const toyHash: HashPort = {
  sha256(input): string {
    let state = 2_166_136_261;
    for (const byte of input) {
      state = Math.imul(state ^ byte, 16_777_619) >>> 0;
    }
    return state.toString(16).padStart(8, '0').repeat(8);
  },
};

function signatureFor(message: Uint8Array, keyId = SIGNER_KEY): string {
  const keyBytes = encodeUtf8(keyId);
  const bytes = new Uint8Array(64);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] =
      (message[index % message.length]! ^
        keyBytes[index % keyBytes.length]! ^
        index) &
      0xff;
  }
  return encodeBase64Url(bytes);
}

function commitments(
  contract: SafeCodingIntentContract = contractFixture(),
): ApprovalCommitmentSnapshot {
  return {
    policyDigest: contract.bindings.policyDigest,
    adapterRegistryDigest: contract.bindings.adapterRegistryDigest,
    runnerRegistryDigest: contract.bindings.runnerRegistryDigest,
    effectRegistryDigest: contract.bindings.effectRegistryDigest,
    rendererVersion: contract.bindings.approvalRendererVersion,
  };
}

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

type MutableDeep<Value> = Value extends readonly (infer Entry)[]
  ? MutableDeep<Entry>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: MutableDeep<Value[Key]> }
    : Value;

function mutableClone<Value>(value: Value): MutableDeep<Value> {
  return JSON.parse(JSON.stringify(value)) as MutableDeep<Value>;
}

interface HarnessState {
  clock: string;
  reviewer: ApprovalReviewer;
  trusted: TrustedApprovalReviewer | null;
  currentCommitments: ApprovalCommitmentSnapshot;
  identityCalls: number;
  commitmentReads: number;
  signatureVerifications: number;
  afterIdentity?: (call: number) => void;
  afterCommitmentRead?: (call: number) => void;
  afterSignatureVerification?: (call: number) => void;
}

interface Harness {
  service: CanonicalApprovalService;
  replay: InMemoryApprovalReplayRegistry;
  state: HarnessState;
  contract: SafeCodingIntentContract;
  signedContract: SignedEnvelope;
  dependencies: CanonicalApprovalServiceDependencies;
}

function createHarness(options?: {
  contract?: SafeCodingIntentContract;
  acceptedReviewerRoles?: readonly ('human-reviewer' | 'policy-reviewer')[];
}): Harness {
  const contract = options?.contract ?? contractFixture();
  const replay = new InMemoryApprovalReplayRegistry();
  const state: HarnessState = {
    clock: '2026-07-14T00:10:00Z',
    reviewer: { reviewerId: 'reviewer:alice', role: 'human-reviewer' },
    trusted: {
      reviewerId: 'reviewer:alice',
      role: 'human-reviewer',
      status: 'active',
    },
    currentCommitments: commitments(contract),
    identityCalls: 0,
    commitmentReads: 0,
    signatureVerifications: 0,
  };
  const reviewIds = [REVIEW_ID_1, REVIEW_ID_2];
  const approvalIds = [APPROVAL_ID_1, APPROVAL_ID_2];
  let reviewIndex = 0;
  let approvalIndex = 0;
  let nonceIndex = 0;
  const dependencies: CanonicalApprovalServiceDependencies = {
    hash: toyHash,
    contractSignatures: {
      resolveTrustedSigner: (keyId) => ({
        keyId,
        role: 'human-authorizer',
        trustEpoch: 1,
        registryDigest: HASH_D,
      }),
      verify: () => true,
      assertTrusted: () => undefined,
    },
    identity: {
      authenticate: () => {
        state.identityCalls += 1;
        const result = clone(state.reviewer);
        state.afterIdentity?.(state.identityCalls);
        return result;
      },
    },
    signing: {
      sign: ({ message }) => ({
        keyId: SIGNER_KEY,
        algorithm: 'P-256-SHA256-P1363',
        signature: signatureFor(message),
      }),
    },
    trustStore: {
      resolveReviewer: () => (state.trusted ? clone(state.trusted) : null),
      verify: ({ keyId, signature, message }) => {
        state.signatureVerifications += 1;
        const valid = signature === signatureFor(message, keyId);
        state.afterSignatureVerification?.(state.signatureVerifications);
        return valid;
      },
      assertTrusted: ({ keyId, reviewer }) => {
        if (
          keyId !== SIGNER_KEY ||
          !state.trusted ||
          state.trusted.status !== 'active' ||
          canonicalizeJson(reviewer) !==
            canonicalizeJson({
              reviewerId: state.trusted.reviewerId,
              role: state.trusted.role,
            })
        ) {
          throw new Error('final reviewer trust changed');
        }
      },
    },
    commitments: {
      readCurrent: () => {
        state.commitmentReads += 1;
        const result = clone(state.currentCommitments);
        state.afterCommitmentRead?.(state.commitmentReads);
        return result;
      },
      assertCurrent: ({ expected }) => {
        if (
          canonicalizeJson(expected) !==
          canonicalizeJson(state.currentCommitments)
        ) {
          throw new Error('final commitments changed');
        }
      },
    },
    replay,
    ids: {
      nextReviewId: () => reviewIds[reviewIndex++]!,
      nextApprovalId: () => approvalIds[approvalIndex++]!,
      nextNonce: () => {
        const offset = nonceIndex++ * 31;
        return encodeBase64Url(
          Uint8Array.from({ length: 24 }, (_, index) => index + offset),
        );
      },
    },
    clock: { now: () => state.clock },
    acceptedReviewerRoles: options?.acceptedReviewerRoles,
  };
  return {
    service: new CanonicalApprovalService(dependencies),
    replay,
    state,
    contract,
    signedContract: signedContract(contract),
    dependencies,
  };
}

async function issueApproval(
  harness: Harness,
): Promise<IssuedCanonicalApproval> {
  const prepared = await harness.service.prepareReview({
    signedContract: harness.signedContract,
  });
  return await harness.service.issueApproval({
    signedContract: harness.signedContract,
    challenge: prepared.challenge,
  });
}

describe('canonical approval model and artifact', () => {
  it('derives the security view only from authoritative contract fields', async () => {
    const first = contractFixture();
    const second = mutableClone(first);
    second.nonAuthoritative.goalLabel = 'Totally different LLM summary';
    second.nonAuthoritative.notes = ['Different untrusted prose.'];

    const firstModel = createCanonicalApprovalRenderModel(first);
    const secondModel = createCanonicalApprovalRenderModel(second);
    expect(canonicalizeJson(firstModel)).toBe(canonicalizeJson(secondModel));
    expect(canonicalizeJson(firstModel)).not.toContain('goalLabel');
    expect(canonicalizeJson(firstModel)).not.toContain('notes');
    await expect(
      hashCanonicalApprovalAuthority(firstModel, toyHash),
    ).resolves.toBe(await hashCanonicalApprovalAuthority(secondModel, toyHash));
  });

  it('changes the exact authority digest when any rendered authority changes', async () => {
    const first = contractFixture();
    const second = mutableClone(first);
    second.authority.limits.maxMutationBytes += 1;
    const firstDigest = await hashCanonicalApprovalAuthority(
      createCanonicalApprovalRenderModel(first),
      toyHash,
    );
    const secondDigest = await hashCanonicalApprovalAuthority(
      createCanonicalApprovalRenderModel(second),
      toyHash,
    );
    expect(secondDigest).not.toBe(firstDigest);
  });

  it('rejects unknown renderer fields and accessors without evaluating them', () => {
    const model = createCanonicalApprovalRenderModel(contractFixture());
    expect(() =>
      validateCanonicalApprovalRenderModel({ ...model, llmSummary: 'safe' }),
    ).toThrow(/unknown or missing/);

    let evaluated = false;
    const accessor = clone(model) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, 'authority', {
      enumerable: true,
      get() {
        evaluated = true;
        return model.authority;
      },
    });
    expect(() => validateCanonicalApprovalRenderModel(accessor)).toThrow(
      /accessors/,
    );
    expect(evaluated).toBe(false);
  });

  it('strictly validates artifact fields, timestamps, digests, and nonce', () => {
    const artifact = artifactFixture();
    expect(validateCanonicalApprovalArtifact(artifact)).toEqual(artifact);
    for (const invalid of [
      { ...artifact, extra: true },
      { ...artifact, contractRevision: 0 },
      { ...artifact, authorityDigest: 'A'.repeat(64) },
      { ...artifact, expiresAt: artifact.issuedAt },
      { ...artifact, nonce: 'not+base64' },
      { ...artifact, reviewer: { ...artifact.reviewer, role: 'model' } },
    ]) {
      expect(() => validateCanonicalApprovalArtifact(invalid)).toThrow(
        ApprovalValidationError,
      );
    }
  });

  it('rejects accessor array entries in signed envelopes without invocation', () => {
    const envelope = signedArtifactEnvelope(artifactFixture());
    let evaluated = false;
    const signatures: unknown[] = [];
    Object.defineProperty(signatures, '0', {
      enumerable: true,
      configurable: true,
      get() {
        evaluated = true;
        return envelope.signatures[0];
      },
    });
    Object.defineProperty(signatures, 'length', { value: 1 });
    expect(() =>
      parseSignedApprovalArtifact({ ...envelope, signatures }),
    ).toThrow(/accessors/);
    expect(evaluated).toBe(false);
  });

  it('rejects non-canonical payload bytes and extra envelope fields', () => {
    const artifact = artifactFixture();
    const padded = ` ${canonicalizeJson(artifact)}`;
    const envelope = signedArtifactEnvelope(artifact);
    expect(() =>
      parseSignedApprovalArtifact({
        ...envelope,
        payload: encodeBase64Url(encodeUtf8(padded)),
      }),
    ).toThrow(/exact canonical form/);
    expect(() =>
      parseSignedApprovalArtifact({ ...envelope, reviewer: 'caller' }),
    ).toThrow(/unknown or missing/);
  });
});

describe('canonical approval service', () => {
  it('prepares, signs, verifies, and consumes an exact Approval Artifact', async () => {
    const harness = createHarness();
    const prepared = await harness.service.prepareReview({
      signedContract: harness.signedContract,
    });
    expect(prepared.challenge).toMatchObject({
      reviewId: REVIEW_ID_1,
      contractRevision: 1,
      reviewer: { reviewerId: 'reviewer:alice', role: 'human-reviewer' },
      policyDigest: HASH_A,
      adapterRegistryDigest: HASH_B,
      runnerRegistryDigest: HASH_C,
      effectRegistryDigest: HASH_D,
      rendererVersion: 'approval-renderer:1',
    });
    expect(prepared.canonicalModel).toBe(canonicalizeJson(prepared.model));

    const issued = await harness.service.issueApproval({
      signedContract: harness.signedContract,
      challenge: prepared.challenge,
    });
    expect(issued.artifact).toMatchObject({
      approvalId: APPROVAL_ID_1,
      reviewId: REVIEW_ID_1,
      contractRevision: 1,
      authorityDigest: prepared.challenge.authorityDigest,
      reviewer: prepared.challenge.reviewer,
    });
    expect(issued.envelope.payloadType).toBe(APPROVAL_ARTIFACT_PAYLOAD_TYPE);
    expect(parseSignedApprovalArtifact(issued.envelope).canonicalPayload).toBe(
      issued.canonicalPayload,
    );

    const verified = await harness.service.verifyAndConsumeApproval({
      signedContract: harness.signedContract,
      signedApproval: issued.envelope,
    });
    expect(verified.artifact).toEqual(issued.artifact);
    expect(verified.signerKeyId).toBe(SIGNER_KEY);
    expect(verified.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.replay.snapshot()).toMatchObject({
      pendingReviewIds: [],
      consumedReviewIds: [REVIEW_ID_1],
      consumedApprovalIds: [APPROVAL_ID_1],
    });
  });

  it('rejects stale policy, adapter, runner, effect, and renderer commitments', async () => {
    for (const field of [
      'policyDigest',
      'adapterRegistryDigest',
      'runnerRegistryDigest',
      'effectRegistryDigest',
      'rendererVersion',
    ] as const) {
      const harness = createHarness();
      harness.state.currentCommitments = {
        ...harness.state.currentCommitments,
        [field]:
          field === 'rendererVersion' ? 'renderer:stale' : 'e'.repeat(64),
      };
      await expect(
        harness.service.prepareReview({
          signedContract: harness.signedContract,
        }),
      ).rejects.toMatchObject({ code: 'stale-commitment' });
    }
  });

  it('consumes a review before rejecting contract or registry drift', async () => {
    const harness = createHarness();
    const prepared = await harness.service.prepareReview({
      signedContract: harness.signedContract,
    });
    harness.state.currentCommitments = {
      ...harness.state.currentCommitments,
      runnerRegistryDigest: 'e'.repeat(64),
    };
    await expect(
      harness.service.issueApproval({
        signedContract: harness.signedContract,
        challenge: prepared.challenge,
      }),
    ).rejects.toMatchObject({ code: 'stale-commitment' });
    harness.state.currentCommitments = commitments(harness.contract);
    await expect(
      harness.service.issueApproval({
        signedContract: harness.signedContract,
        challenge: prepared.challenge,
      }),
    ).rejects.toMatchObject({ code: 'review-replay' });
  });

  it('detects reviewer identity drift at dialog open and submit', async () => {
    const prepareHarness = createHarness();
    prepareHarness.state.afterIdentity = (call) => {
      if (call === 1) {
        prepareHarness.state.reviewer = {
          reviewerId: 'reviewer:bob',
          role: 'human-reviewer',
        };
      }
    };
    await expect(
      prepareHarness.service.prepareReview({
        signedContract: prepareHarness.signedContract,
      }),
    ).rejects.toMatchObject({ code: 'identity-drift' });

    const submitHarness = createHarness();
    const prepared = await submitHarness.service.prepareReview({
      signedContract: submitHarness.signedContract,
    });
    submitHarness.state.reviewer = {
      reviewerId: 'reviewer:bob',
      role: 'human-reviewer',
    };
    await expect(
      submitHarness.service.issueApproval({
        signedContract: submitHarness.signedContract,
        challenge: prepared.challenge,
      }),
    ).rejects.toMatchObject({ code: 'identity-drift' });
  });

  it('detects identity changes during signing and requires a fresh review', async () => {
    const harness = createHarness();
    const prepared = await harness.service.prepareReview({
      signedContract: harness.signedContract,
    });
    harness.state.afterSignatureVerification = () => {
      harness.state.reviewer = {
        reviewerId: 'reviewer:bob',
        role: 'human-reviewer',
      };
    };
    await expect(
      harness.service.issueApproval({
        signedContract: harness.signedContract,
        challenge: prepared.challenge,
      }),
    ).rejects.toMatchObject({ code: 'identity-drift' });
    await expect(
      harness.service.issueApproval({
        signedContract: harness.signedContract,
        challenge: prepared.challenge,
      }),
    ).rejects.toBeInstanceOf(ApprovalReplayError);
  });

  it('rejects signer keys whose trust identity or role differs', async () => {
    const harness = createHarness();
    const prepared = await harness.service.prepareReview({
      signedContract: harness.signedContract,
    });
    harness.state.trusted = {
      reviewerId: 'reviewer:bob',
      role: 'human-reviewer',
      status: 'active',
    };
    await expect(
      harness.service.issueApproval({
        signedContract: harness.signedContract,
        challenge: prepared.challenge,
      }),
    ).rejects.toMatchObject({ code: 'reviewer-untrusted' });
  });

  it('rejects invalid signatures returned by an injected signer', async () => {
    const harness = createHarness();
    harness.dependencies.signing.sign = () => ({
      keyId: SIGNER_KEY,
      algorithm: 'P-256-SHA256-P1363',
      signature: encodeBase64Url(new Uint8Array(64)),
    });
    const service = new CanonicalApprovalService(harness.dependencies);
    const prepared = await service.prepareReview({
      signedContract: harness.signedContract,
    });
    await expect(
      service.issueApproval({
        signedContract: harness.signedContract,
        challenge: prepared.challenge,
      }),
    ).rejects.toMatchObject({ code: 'signature-invalid' });
  });

  it('uses synchronous final fences to catch post-verification drift', async () => {
    const commitmentHarness = createHarness();
    const prepared = await commitmentHarness.service.prepareReview({
      signedContract: commitmentHarness.signedContract,
    });
    commitmentHarness.state.afterCommitmentRead = (call) => {
      if (call === 3) {
        commitmentHarness.state.currentCommitments = {
          ...commitmentHarness.state.currentCommitments,
          effectRegistryDigest: 'e'.repeat(64),
        };
      }
    };
    await expect(
      commitmentHarness.service.issueApproval({
        signedContract: commitmentHarness.signedContract,
        challenge: prepared.challenge,
      }),
    ).rejects.toThrow(/final commitments changed/);

    const trustHarness = createHarness();
    const trustPrepared = await trustHarness.service.prepareReview({
      signedContract: trustHarness.signedContract,
    });
    trustHarness.state.afterSignatureVerification = () => {
      if (trustHarness.state.trusted) {
        trustHarness.state.trusted = {
          ...trustHarness.state.trusted,
          status: 'revoked',
        };
      }
    };
    await expect(
      trustHarness.service.issueApproval({
        signedContract: trustHarness.signedContract,
        challenge: trustPrepared.challenge,
      }),
    ).rejects.toThrow(/final reviewer trust changed/);
  });

  it('pins constructor port methods against post-construction substitution', async () => {
    const harness = createHarness();
    harness.dependencies.signing.sign = () => {
      throw new Error('substituted signer must be unreachable');
    };
    harness.dependencies.replay.consumeArtifact = () => {
      throw new Error('substituted replay registry must be unreachable');
    };

    const issued = await issueApproval(harness);
    await expect(
      harness.service.verifyAndConsumeApproval({
        signedContract: harness.signedContract,
        signedApproval: issued.envelope,
      }),
    ).resolves.toBeDefined();
  });

  it('rejects port method accessors without evaluating them', () => {
    const harness = createHarness();
    let evaluated = false;
    const identity = {};
    Object.defineProperty(identity, 'authenticate', {
      enumerable: true,
      get: () => {
        evaluated = true;
        return () => harness.state.reviewer;
      },
    });
    expect(
      () =>
        new CanonicalApprovalService({
          ...harness.dependencies,
          identity: identity as never,
        }),
    ).toThrow(/data method/);
    expect(evaluated).toBe(false);
  });

  it('rejects top-level dependency and optional configuration accessors without evaluating them', () => {
    const harness = createHarness();
    let dependencyReads = 0;
    const dependencyAccessor = { ...harness.dependencies } as Record<
      string,
      unknown
    >;
    delete dependencyAccessor.identity;
    Object.defineProperty(dependencyAccessor, 'identity', {
      enumerable: true,
      get: () => {
        dependencyReads += 1;
        return harness.dependencies.identity;
      },
    });
    expect(
      () => new CanonicalApprovalService(dependencyAccessor as never),
    ).toThrow(/own data field/);
    expect(dependencyReads).toBe(0);

    let optionalReads = 0;
    const optionalAccessor = { ...harness.dependencies } as Record<
      string,
      unknown
    >;
    Object.defineProperty(optionalAccessor, 'acceptedReviewerRoles', {
      enumerable: true,
      get: () => {
        optionalReads += 1;
        return ['human-reviewer'];
      },
    });
    expect(
      () => new CanonicalApprovalService(optionalAccessor as never),
    ).toThrow(/own data field/);
    expect(optionalReads).toBe(0);
  });

  it('rejects public service input accessors without evaluating them', async () => {
    const harness = createHarness();
    let evaluated = false;
    const input = {};
    Object.defineProperty(input, 'signedContract', {
      enumerable: true,
      get: () => {
        evaluated = true;
        return harness.signedContract;
      },
    });
    await expect(harness.service.prepareReview(input as never)).rejects.toThrow(
      /cannot contain accessors/,
    );
    expect(evaluated).toBe(false);
  });

  it('rechecks synchronous time after the last asynchronous commitment read', async () => {
    const harness = createHarness();
    const issued = await issueApproval(harness);
    const readsBeforeVerification = harness.state.commitmentReads;
    harness.state.afterCommitmentRead = (call) => {
      if (call === readsBeforeVerification + 2) {
        harness.state.clock = issued.artifact.expiresAt;
      }
    };

    await expect(
      harness.service.verifyAndConsumeApproval({
        signedContract: harness.signedContract,
        signedApproval: issued.envelope,
      }),
    ).rejects.toMatchObject({ code: 'expired' });
    expect(harness.replay.snapshot().consumedApprovalIds).toEqual([]);
  });

  it('rejects Approval Artifact replay after successful one-shot consumption', async () => {
    const harness = createHarness();
    const issued = await issueApproval(harness);
    await harness.service.verifyAndConsumeApproval({
      signedContract: harness.signedContract,
      signedApproval: issued.envelope,
    });
    await expect(
      harness.service.verifyAndConsumeApproval({
        signedContract: harness.signedContract,
        signedApproval: issued.envelope,
      }),
    ).rejects.toMatchObject({ code: 'artifact-replay' });
  });

  it('rejects an artifact against another contract hash or revision', async () => {
    const harness = createHarness();
    const issued = await issueApproval(harness);
    const revisionTwo = mutableClone(harness.contract);
    revisionTwo.revision = 2;
    revisionTwo.previousRevisionHash = 'f'.repeat(64);
    revisionTwo.nonAuthoritative.notes = ['Revision two.'];
    await expect(
      harness.service.verifyAndConsumeApproval({
        signedContract: signedContract(revisionTwo),
        signedApproval: issued.envelope,
      }),
    ).rejects.toMatchObject({ code: 'artifact-mismatch' });
  });

  it('rejects every re-signed exact-binding mutation independently', async () => {
    const mutations: readonly ((
      artifact: CanonicalApprovalArtifact,
    ) => CanonicalApprovalArtifact)[] = [
      (artifact) => ({ ...artifact, contractHash: 'e'.repeat(64) }),
      (artifact) => ({ ...artifact, contractRevision: 2 }),
      (artifact) => ({ ...artifact, authorityDigest: 'e'.repeat(64) }),
      (artifact) => ({ ...artifact, policyDigest: 'e'.repeat(64) }),
      (artifact) => ({
        ...artifact,
        adapterRegistryDigest: 'e'.repeat(64),
      }),
      (artifact) => ({
        ...artifact,
        runnerRegistryDigest: 'e'.repeat(64),
      }),
      (artifact) => ({
        ...artifact,
        effectRegistryDigest: 'e'.repeat(64),
      }),
      (artifact) => ({ ...artifact, rendererVersion: 'renderer:other' }),
    ];

    for (const mutate of mutations) {
      const harness = createHarness();
      const issued = await issueApproval(harness);
      const mutated = validateCanonicalApprovalArtifact(
        mutate(issued.artifact),
      );
      await expect(
        harness.service.verifyAndConsumeApproval({
          signedContract: harness.signedContract,
          signedApproval: signedArtifactEnvelope(mutated),
        }),
      ).rejects.toMatchObject({ code: 'artifact-mismatch' });
    }
  });

  it('rejects overlong artifacts and artifacts that outlive the contract', async () => {
    const longHarness = createHarness();
    const longIssued = await issueApproval(longHarness);
    const overlong = validateCanonicalApprovalArtifact({
      ...longIssued.artifact,
      expiresAt: '2026-07-14T00:20:00Z',
    });
    await expect(
      longHarness.service.verifyAndConsumeApproval({
        signedContract: longHarness.signedContract,
        signedApproval: signedArtifactEnvelope(overlong),
      }),
    ).rejects.toMatchObject({ code: 'expired' });

    const outerHarness = createHarness();
    const outerIssued = await issueApproval(outerHarness);
    const outliving = validateCanonicalApprovalArtifact({
      ...outerIssued.artifact,
      expiresAt: '2026-07-14T02:01:00Z',
    });
    const verifier = new CanonicalApprovalService({
      ...outerHarness.dependencies,
      approvalTtlMs: 4 * 60 * 60 * 1_000,
    });
    await expect(
      verifier.verifyAndConsumeApproval({
        signedContract: outerHarness.signedContract,
        signedApproval: signedArtifactEnvelope(outliving),
      }),
    ).rejects.toMatchObject({ code: 'artifact-mismatch' });
  });

  it('rejects artifacts after expiry and before replay admission', async () => {
    const harness = createHarness();
    const issued = await issueApproval(harness);
    harness.state.clock = issued.artifact.expiresAt;
    await expect(
      harness.service.verifyAndConsumeApproval({
        signedContract: harness.signedContract,
        signedApproval: issued.envelope,
      }),
    ).rejects.toMatchObject({ code: 'expired' });
    expect(harness.replay.snapshot().consumedApprovalIds).toEqual([]);
  });

  it('rejects stale artifact digests even when the signature remains valid', async () => {
    const harness = createHarness();
    const issued = await issueApproval(harness);
    harness.state.currentCommitments = {
      ...harness.state.currentCommitments,
      adapterRegistryDigest: 'e'.repeat(64),
    };
    await expect(
      harness.service.verifyAndConsumeApproval({
        signedContract: harness.signedContract,
        signedApproval: issued.envelope,
      }),
    ).rejects.toMatchObject({ code: 'stale-commitment' });
  });

  it('denies policy reviewers by default and permits only explicit policy', async () => {
    const denied = createHarness();
    denied.state.reviewer = {
      reviewerId: 'reviewer:policy',
      role: 'policy-reviewer',
    };
    denied.state.trusted = {
      ...denied.state.reviewer,
      status: 'active',
    };
    await expect(
      denied.service.prepareReview({ signedContract: denied.signedContract }),
    ).rejects.toMatchObject({ code: 'reviewer-untrusted' });

    const allowed = createHarness({
      acceptedReviewerRoles: ['policy-reviewer'],
    });
    allowed.state.reviewer = {
      reviewerId: 'reviewer:policy',
      role: 'policy-reviewer',
    };
    allowed.state.trusted = { ...allowed.state.reviewer, status: 'active' };
    await expect(
      allowed.service.prepareReview({ signedContract: allowed.signedContract }),
    ).resolves.toBeDefined();
  });

  it('rejects trust-store accessors without evaluating them', async () => {
    const harness = createHarness();
    let evaluated = false;
    harness.dependencies.trustStore.resolveReviewer = () => {
      const entry = {
        role: 'human-reviewer',
        status: 'active',
      } as Record<string, unknown>;
      Object.defineProperty(entry, 'reviewerId', {
        enumerable: true,
        get() {
          evaluated = true;
          return 'reviewer:alice';
        },
      });
      return entry as unknown as TrustedApprovalReviewer;
    };
    const service = new CanonicalApprovalService(harness.dependencies);
    const prepared = await service.prepareReview({
      signedContract: harness.signedContract,
    });
    await expect(
      service.issueApproval({
        signedContract: harness.signedContract,
        challenge: prepared.challenge,
      }),
    ).rejects.toThrow(/accessors/);
    expect(evaluated).toBe(false);
  });

  it('rejects giant sparse arrays before allocating an expected-name mirror', () => {
    const signatures: unknown[] = [];
    signatures.length = 0xffff_ffff;
    expect(() =>
      parseSignedApprovalArtifact({
        payloadType: APPROVAL_ARTIFACT_PAYLOAD_TYPE,
        payload: 'AA',
        signatures,
      }),
    ).toThrow(/too many entries/);
  });

  it('rejects pathologically wide records under a fixed field budget', () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 10_001; index += 1) {
      wide[`field${index}`] = index;
    }
    expect(() => parseSignedApprovalArtifact(wide)).toThrow(/too many fields/);
  });
});

describe('in-memory approval replay registry', () => {
  it('rejects duplicate review IDs and nonces', () => {
    const registry = new InMemoryApprovalReplayRegistry();
    const first = reviewFixture();
    registry.registerReview(first);
    expect(() => registry.registerReview(first)).toThrow(ApprovalReplayError);
    expect(() =>
      registry.registerReview({ ...first, reviewId: REVIEW_ID_2 }),
    ).toThrow(/nonce/);
  });

  it('consumes a review before reporting an exact-value mismatch', () => {
    const registry = new InMemoryApprovalReplayRegistry();
    const first = reviewFixture();
    registry.registerReview(first);
    expect(() =>
      registry.consumeReview({ ...first, authorityDigest: 'e'.repeat(64) }),
    ).toThrow(/exactly match/);
    expect(() => registry.consumeReview(first)).toThrow(
      /already been consumed/,
    );
  });

  it('rejects replay by artifact ID, nonce, or canonical artifact digest', () => {
    const base = {
      approvalId: APPROVAL_ID_1,
      artifactDigest: HASH_A,
      contractHash: HASH_B,
      contractRevision: 1,
      nonce: nonce(9),
      expiresAt: '2026-07-14T00:20:00Z',
    };
    for (const replay of [
      { ...base, nonce: nonce(10), artifactDigest: HASH_C },
      { ...base, approvalId: APPROVAL_ID_2, artifactDigest: HASH_C },
      { ...base, approvalId: APPROVAL_ID_2, nonce: nonce(10) },
    ]) {
      const registry = new InMemoryApprovalReplayRegistry();
      registry.consumeArtifact(base);
      expect(() => registry.consumeArtifact(replay)).toThrow(
        ApprovalReplayError,
      );
    }
  });
});

function nonce(offset: number): string {
  return encodeBase64Url(
    Uint8Array.from({ length: 24 }, (_, index) => index + offset),
  );
}

function reviewFixture() {
  return {
    kind: 'clodex.approval-review' as const,
    specVersion: '1.0.0' as const,
    reviewId: REVIEW_ID_1,
    contractHash: HASH_A,
    contractRevision: 1,
    authorityDigest: HASH_B,
    policyDigest: HASH_A,
    adapterRegistryDigest: HASH_B,
    runnerRegistryDigest: HASH_C,
    effectRegistryDigest: HASH_D,
    rendererVersion: 'approval-renderer:1',
    reviewer: {
      reviewerId: 'reviewer:alice',
      role: 'human-reviewer' as const,
    },
    issuedAt: '2026-07-14T00:10:00Z',
    expiresAt: '2026-07-14T00:15:00Z',
    nonce: nonce(1),
  };
}

function artifactFixture() {
  return {
    kind: 'clodex.approval-artifact' as const,
    specVersion: '1.0.0' as const,
    approvalId: APPROVAL_ID_1,
    reviewId: REVIEW_ID_1,
    contractHash: HASH_A,
    contractRevision: 1,
    authorityDigest: HASH_B,
    policyDigest: HASH_A,
    adapterRegistryDigest: HASH_B,
    runnerRegistryDigest: HASH_C,
    effectRegistryDigest: HASH_D,
    rendererVersion: 'approval-renderer:1',
    reviewer: {
      reviewerId: 'reviewer:alice',
      role: 'human-reviewer' as const,
    },
    issuedAt: '2026-07-14T00:10:00Z',
    expiresAt: '2026-07-14T00:15:00Z',
    nonce: nonce(2),
  };
}

function signedArtifactEnvelope(
  artifact: CanonicalApprovalArtifact,
): SignedEnvelope {
  const payload = canonicalizeJson(artifact);
  const typeBytes = encodeUtf8(APPROVAL_ARTIFACT_PAYLOAD_TYPE);
  const payloadBytes = encodeUtf8(payload);
  const prefix = encodeUtf8(
    `DSSEv1 ${typeBytes.length} ${APPROVAL_ARTIFACT_PAYLOAD_TYPE} ${payloadBytes.length} `,
  );
  const message = new Uint8Array(prefix.length + payloadBytes.length);
  message.set(prefix, 0);
  message.set(payloadBytes, prefix.length);
  return {
    payloadType: APPROVAL_ARTIFACT_PAYLOAD_TYPE,
    payload: encodeBase64Url(payloadBytes),
    signatures: [
      {
        keyId: SIGNER_KEY,
        algorithm: 'P-256-SHA256-P1363',
        signature: signatureFor(message),
      },
    ],
  };
}
