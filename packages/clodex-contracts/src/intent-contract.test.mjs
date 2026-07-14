import {
  EFFECT_ATTESTATION_PAYLOAD_TYPE,
  INTENT_CONTRACT_HASH_DOMAIN,
  INTENT_CONTRACT_PAYLOAD_TYPE,
  SAFE_CODING_ACTION_HASH_DOMAIN,
  canonicalizeJson,
  createEnvelopePreAuthenticationEncoding,
  decodeBase64Url,
  encodeBase64Url,
  encodeUtf8,
  hashIntentContract,
  hashSafeCodingAction,
  parseCanonicalJson,
  parseCanonicalSafeCodingIntentContract,
  resourceSelectorCovers,
  validateResourceSelector,
  validateSafeCodingAction,
  validateSafeCodingEffectAttestation,
  validateSafeCodingExecutionTicket,
  validateSafeCodingIntentContract,
  verifySignedIntentContract,
} from './index.ts';

const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const TRUST_REGISTRY_DIGEST = '9'.repeat(64);
const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';
const TICKET_ID = '22222222-2222-4222-8222-222222222222';
const ATTESTATION_ID = '33333333-3333-4333-8333-333333333333';

function sorted(values) {
  return [...values].sort((left, right) =>
    canonicalizeJson(left) < canonicalizeJson(right) ? -1 : 1,
  );
}

function trustedSignerSnapshot(overrides = {}) {
  return {
    keyId: 'key.human-1',
    role: 'human-authorizer',
    trustEpoch: 7,
    registryDigest: TRUST_REGISTRY_DIGEST,
    ...overrides,
  };
}

function signedContractFixture(
  signatures = [
    {
      keyId: 'key.human-1',
      algorithm: 'P-256-SHA256-P1363',
      signature: encodeBase64Url(new Uint8Array(64).fill(7)),
    },
  ],
) {
  const canonicalPayload = canonicalizeJson(contractFixture());
  return {
    payloadType: INTENT_CONTRACT_PAYLOAD_TYPE,
    payload: encodeBase64Url(encodeUtf8(canonicalPayload)),
    signatures,
  };
}

function contractFixture() {
  return {
    kind: 'clodex.intent-contract',
    specVersion: '1.0.0',
    contractId: CONTRACT_ID,
    revision: 1,
    previousRevisionHash: null,
    issuedAt: '2026-07-14T00:00:00Z',
    validity: {
      notBefore: '2026-07-14T00:00:00Z',
      expiresAt: '2026-07-14T02:00:00Z',
    },
    subject: {
      principalId: 'principal.local-agent',
      instanceId: 'instance.session-1',
    },
    audience: {
      guardianId: 'guardian.local',
      executorId: 'executor.docker',
      runtimeEpoch: 7,
      taskId: 'task.auth-tests',
      workspaceId: 'workspace.repo-1',
    },
    bindings: {
      policyDigest: DIGEST,
      adapterRegistryDigest: OTHER_DIGEST,
      runnerRegistryDigest: 'c'.repeat(64),
      effectRegistryDigest: 'd'.repeat(64),
      approvalRendererVersion: 'safe-review-v1',
    },
    authority: {
      filesystem: sorted([
        {
          action: 'filesystem.read',
          selector: { kind: 'tree', path: 'src/auth' },
        },
        {
          action: 'filesystem.create',
          selector: { kind: 'tree', path: 'tests/auth' },
        },
        {
          action: 'filesystem.replace',
          selector: { kind: 'file', path: 'src/auth/login.ts' },
        },
      ]),
      git: sorted([{ action: 'git.status' }, { action: 'git.diff' }]),
      testProfiles: ['tests.auth.unit'],
      allowedEffectClasses: [
        'local.observation',
        'local.reversible',
        'sandbox.ephemeral',
      ],
      limits: {
        maxUniqueModifiedFiles: 12,
        maxMutationBytes: 1_048_576,
        maxTestRuns: 4,
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
      goalLabel: 'Fix authentication tests',
      notes: ['No host workspace promotion.'],
    },
  };
}

function ticketFixture() {
  return {
    kind: 'clodex.execution-ticket',
    specVersion: '1.0.0',
    ticketId: TICKET_ID,
    requestId: 'request-1',
    contractHash: DIGEST,
    contractRevision: 1,
    subject: contractFixture().subject,
    audience: contractFixture().audience,
    actionHash: OTHER_DIGEST,
    argumentsHash: 'c'.repeat(64),
    resolvedObjectId: 'object.workspace/src/auth/login.ts',
    stateCommitmentHash: 'd'.repeat(64),
    adapterId: 'adapter.safe-fs-v1',
    adapterDigest: 'e'.repeat(64),
    policyDigest: DIGEST,
    registryDigest: 'f'.repeat(64),
    runnerRegistryDigest: 'b'.repeat(64),
    effectRegistryDigest: 'c'.repeat(64),
    effectClass: 'local.reversible',
    revocationEpoch: 3,
    budgetReservationId: 'reservation-1',
    nonce: encodeBase64Url(Uint8Array.from({ length: 24 }, (_, i) => i)),
    issuedAt: '2026-07-14T00:01:00Z',
    expiresAt: '2026-07-14T00:02:00Z',
  };
}

function attestationFixture() {
  return {
    kind: 'clodex.effect-attestation',
    specVersion: '1.0.0',
    attestationId: ATTESTATION_ID,
    requestId: 'request-1',
    ticketId: TICKET_ID,
    contractHash: DIGEST,
    contractRevision: 1,
    actionHash: OTHER_DIGEST,
    delegationLineageHash: 'c'.repeat(64),
    adapterId: 'adapter.safe-fs-v1',
    adapterDigest: 'd'.repeat(64),
    runnerId: 'runner.docker-1',
    runnerDigest: 'e'.repeat(64),
    executorId: 'executor.docker',
    observerId: 'observer.safe-fs',
    effectClass: 'local.reversible',
    registryDigest: 'f'.repeat(64),
    revocationEpoch: 3,
    preStateHash: DIGEST,
    postStateHash: OTHER_DIGEST,
    idempotencyKey: null,
    resultHash: 'c'.repeat(64),
    budgetCharges: {
      uniqueModifiedFiles: 1,
      mutationBytes: 32,
      testRuns: 0,
    },
    startedAt: '2026-07-14T00:01:00Z',
    finishedAt: '2026-07-14T00:01:01Z',
    status: 'committed',
    evidenceLevel: 'local_state_reconciled',
    reconciliationRef: null,
  };
}

describe('canonical JSON', () => {
  it('orders object keys and preserves canonical Unicode', () => {
    expect(canonicalizeJson({ z: 1, a: 'café' })).toBe('{"a":"café","z":1}');
  });

  it('rejects whitespace, duplicate keys, alternate escapes, and unsafe numbers', () => {
    for (const value of [
      '{ "a":1}',
      '{"a":1,"a":2}',
      '{"a":"\\u0062"}',
      '{"a":1.5}',
      '{"a":-0}',
      '{"a":9007199254740992}',
    ]) {
      expect(() => parseCanonicalJson(value)).toThrow();
    }
  });

  it('rejects non-NFC and unpaired surrogate strings', () => {
    expect(() => canonicalizeJson({ value: 'cafe\u0301' })).toThrow(/NFC/);
    expect(() =>
      canonicalizeJson({ value: String.fromCharCode(0xd800) }),
    ).toThrow(/surrogate/);
  });

  it('rejects accessors and hidden fields instead of evaluating or ignoring them', () => {
    let evaluated = false;
    const accessor = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get() {
        evaluated = true;
        return 1;
      },
    });
    expect(() => canonicalizeJson(accessor)).toThrow(/accessors/);
    expect(evaluated).toBe(false);

    const hidden = { value: 1 };
    Object.defineProperty(hidden, 'purpose', { value: 'safe' });
    expect(() => canonicalizeJson(hidden)).toThrow(/non-enumerable/);
  });

  it('rejects array accessors, extra fields, symbols, and custom prototypes', () => {
    let getterReads = 0;
    const accessor = [];
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return 'unsafe';
      },
    });
    accessor.length = 1;
    expect(() => canonicalizeJson(accessor)).toThrow(/accessors/);
    expect(getterReads).toBe(0);

    const extra = ['safe'];
    extra.extra = true;
    expect(() => canonicalizeJson(extra)).toThrow(/extra or hidden/);

    const symbol = ['safe'];
    symbol[Symbol('hidden')] = true;
    expect(() => canonicalizeJson(symbol)).toThrow(/symbol/);

    const customPrototype = ['safe'];
    Object.setPrototypeOf(customPrototype, { custom: true });
    expect(() => canonicalizeJson(customPrototype)).toThrow(/plain Array/);
  });

  it('fails closed on canonical JSON depth, node, and string budgets', () => {
    const deeplyNested = `${'['.repeat(65)}0${']'.repeat(65)}`;
    expect(() => parseCanonicalJson(deeplyNested)).toThrow(/depth budget/);

    let nested = 0;
    for (let index = 0; index < 65; index += 1) nested = [nested];
    expect(() => canonicalizeJson(nested)).toThrow(/depth budget/);

    expect(() => canonicalizeJson(Array(100_000).fill(null))).toThrow(
      /node budget/,
    );
    expect(() => canonicalizeJson('x'.repeat(1024 * 1024 + 1))).toThrow(
      /string exceeds the size budget/,
    );
  });

  it('rejects accessor arrays before public contract validators can evaluate them', async () => {
    let authorityGetterReads = 0;
    const contract = contractFixture();
    const filesystem = [];
    Object.defineProperty(filesystem, '0', {
      enumerable: true,
      get: () => {
        authorityGetterReads += 1;
        return contract.authority.filesystem[0];
      },
    });
    filesystem.length = 1;
    contract.authority.filesystem = filesystem;
    expect(() => validateSafeCodingIntentContract(contract)).toThrow(
      /accessors/,
    );
    expect(authorityGetterReads).toBe(0);

    let signatureGetterReads = 0;
    const canonicalPayload = canonicalizeJson(contractFixture());
    const originalSignature = {
      keyId: 'human:key',
      algorithm: 'P-256-SHA256-P1363',
      signature: encodeBase64Url(new Uint8Array(64)),
    };
    const signed = {
      payloadType: INTENT_CONTRACT_PAYLOAD_TYPE,
      payload: encodeBase64Url(encodeUtf8(canonicalPayload)),
      signatures: [originalSignature],
    };
    const signatures = [];
    Object.defineProperty(signatures, '0', {
      enumerable: true,
      get: () => {
        signatureGetterReads += 1;
        return originalSignature;
      },
    });
    signatures.length = 1;
    signed.signatures = signatures;
    await expect(
      verifySignedIntentContract(signed, {
        hash: { sha256: () => DIGEST },
        signatures: {
          resolveTrustedSigner: (keyId) => trustedSignerSnapshot({ keyId }),
          verify: () => true,
          assertTrusted: () => {},
        },
      }),
    ).rejects.toThrow(/accessors/);
    expect(signatureGetterReads).toBe(0);
  });
});

describe('resource selectors', () => {
  it('implements exact file/tree containment', () => {
    expect(
      resourceSelectorCovers(
        { kind: 'tree', path: 'src/auth' },
        { kind: 'file', path: 'src/auth/login.ts' },
      ),
    ).toBe(true);
    expect(
      resourceSelectorCovers(
        { kind: 'file', path: 'src/auth/login.ts' },
        { kind: 'file', path: 'src/auth/login.ts' },
      ),
    ).toBe(true);
    expect(
      resourceSelectorCovers(
        { kind: 'file', path: 'src/auth/login.ts' },
        { kind: 'tree', path: 'src/auth/login.ts' },
      ),
    ).toBe(false);
    expect(
      resourceSelectorCovers(
        { kind: 'tree', path: 'src/auth' },
        { kind: 'file', path: 'src/authentication.ts' },
      ),
    ).toBe(false);
    expect(
      resourceSelectorCovers(
        { kind: 'tree', path: '' },
        { kind: 'tree', path: 'tests/auth' },
      ),
    ).toBe(true);
  });

  it('rejects traversal, absolute, backslash, empty-file, control, and non-NFC paths', () => {
    for (const path of [
      '../secret',
      'src/../secret',
      '/etc/passwd',
      'C:/Windows/System32',
      'src\\auth',
      'src//auth',
      'src/./auth',
      'src/auth/',
      'src/\u0000auth',
      'cafe\u0301',
    ]) {
      expect(() => validateResourceSelector({ kind: 'file', path })).toThrow();
    }
    expect(() =>
      validateResourceSelector({ kind: 'file', path: '' }),
    ).toThrow();
    expect(validateResourceSelector({ kind: 'tree', path: '' })).toEqual({
      kind: 'tree',
      path: '',
    });
  });

  it('rejects unknown selector fields', () => {
    expect(() =>
      validateResourceSelector({ kind: 'file', path: 'a', glob: '*' }),
    ).toThrow(/unknown or missing/);
  });
});

describe('Safe Coding Intent Contract', () => {
  it('validates and freezes the closed v1 shape', () => {
    const validated = validateSafeCodingIntentContract(contractFixture());
    expect(validated.authority.ambientAuthority).toEqual({
      network: false,
      secrets: false,
      shell: false,
      delete: false,
      gitCommit: false,
      gitPush: false,
    });
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.authority.filesystem)).toBe(true);
    expect(
      parseCanonicalSafeCodingIntentContract(canonicalizeJson(validated)),
    ).toEqual(validated);
  });

  it('rejects unknown fields at every authority boundary', () => {
    const contract = contractFixture();
    contract.authority.limits.purpose = 'safe';
    expect(() => validateSafeCodingIntentContract(contract)).toThrow(
      /unknown or missing/,
    );
  });

  it('rejects noncanonical set ordering and duplicate authority', () => {
    const reversed = contractFixture();
    reversed.authority.filesystem.reverse();
    expect(() => validateSafeCodingIntentContract(reversed)).toThrow(
      /sorted and unique/,
    );

    const duplicate = contractFixture();
    duplicate.authority.testProfiles.push('tests.auth.unit');
    expect(() => validateSafeCodingIntentContract(duplicate)).toThrow(
      /sorted and unique/,
    );
  });

  it('hard-denies ambient authority and validates revision lineage', () => {
    const ambient = contractFixture();
    ambient.authority.ambientAuthority.network = true;
    expect(() => validateSafeCodingIntentContract(ambient)).toThrow();

    const revision = contractFixture();
    revision.revision = 2;
    expect(() => validateSafeCodingIntentContract(revision)).toThrow(
      /previous hash/,
    );
    revision.previousRevisionHash = DIGEST;
    expect(validateSafeCodingIntentContract(revision).revision).toBe(2);
  });

  it('requires canonical timestamps and ordered validity', () => {
    const milliseconds = contractFixture();
    milliseconds.issuedAt = '2026-07-14T00:00:00.000Z';
    expect(() => validateSafeCodingIntentContract(milliseconds)).toThrow(
      /canonical UTC/,
    );

    const backwards = contractFixture();
    backwards.validity.expiresAt = backwards.validity.notBefore;
    expect(() => validateSafeCodingIntentContract(backwards)).toThrow(
      /issuedAt <= notBefore < expiresAt/,
    );
  });

  it('requires operation-compatible permission selectors', () => {
    const contract = contractFixture();
    contract.authority.filesystem = [
      {
        action: 'filesystem.create',
        selector: { kind: 'file', path: 'tests/auth/new.test.ts' },
      },
    ];
    expect(() => validateSafeCodingIntentContract(contract)).toThrow(
      /tree selector/,
    );
  });

  it('rejects oversized authority collections before traversing entries', () => {
    const contract = contractFixture();
    contract.authority.filesystem = Array.from({ length: 1_025 }, () => ({
      action: 'filesystem.read',
      selector: { kind: 'tree', path: 'src' },
    }));
    expect(() => validateSafeCodingIntentContract(contract)).toThrow(
      /maximum of 1024 entries/,
    );
  });
});

describe('Safe Coding actions and evidence artifacts', () => {
  it('accepts the complete initial action vocabulary', () => {
    const actions = [
      {
        requestId: 'r-1',
        action: 'filesystem.stat',
        selector: { kind: 'file', path: 'src/auth/login.ts' },
      },
      {
        requestId: 'r-2',
        action: 'filesystem.list',
        selector: { kind: 'tree', path: 'src/auth' },
      },
      {
        requestId: 'r-3',
        action: 'filesystem.read',
        selector: { kind: 'file', path: 'src/auth/login.ts' },
      },
      {
        requestId: 'r-4',
        action: 'filesystem.create',
        selector: { kind: 'file', path: 'tests/auth/new.test.ts' },
        contentSha256: DIGEST,
        contentBytes: 10,
      },
      {
        requestId: 'r-5',
        action: 'filesystem.replace',
        selector: { kind: 'file', path: 'src/auth/login.ts' },
        beforeSha256: OTHER_DIGEST,
        contentSha256: DIGEST,
        contentBytes: 10,
      },
      {
        requestId: 'r-6',
        action: 'filesystem.mkdir',
        selector: { kind: 'tree', path: 'tests/auth/fixtures' },
      },
      { requestId: 'r-7', action: 'git.status' },
      { requestId: 'r-8', action: 'git.diff', scope: 'worktree' },
      { requestId: 'r-9', action: 'test.run', profileId: 'tests.auth.unit' },
    ];
    for (const action of actions) {
      expect(validateSafeCodingAction(action).action).toBe(action.action);
    }
  });

  it('rejects delete, shell, network, secret, commit, and push actions', () => {
    for (const action of [
      'filesystem.delete',
      'shell.exec',
      'network.request',
      'secret.read',
      'git.commit',
      'git.push',
    ]) {
      expect(() =>
        validateSafeCodingAction({ requestId: 'r-1', action }),
      ).toThrow(/unsupported/);
    }
  });

  it('rejects missing before-state and wrong selector kinds', () => {
    expect(() =>
      validateSafeCodingAction({
        requestId: 'r-1',
        action: 'filesystem.replace',
        selector: { kind: 'file', path: 'src/auth/login.ts' },
        contentSha256: DIGEST,
        contentBytes: 1,
      }),
    ).toThrow(/unknown or missing/);
    expect(() =>
      validateSafeCodingAction({
        requestId: 'r-1',
        action: 'filesystem.list',
        selector: { kind: 'file', path: 'src/auth/login.ts' },
      }),
    ).toThrow(/tree selector/);
  });

  it('validates closed tickets and attestations', () => {
    expect(validateSafeCodingExecutionTicket(ticketFixture()).ticketId).toBe(
      TICKET_ID,
    );
    expect(
      validateSafeCodingEffectAttestation(attestationFixture()).status,
    ).toBe('committed');

    const stale = ticketFixture();
    stale.expiresAt = stale.issuedAt;
    expect(() => validateSafeCodingExecutionTicket(stale)).toThrow(/expiry/);

    const backwards = attestationFixture();
    backwards.finishedAt = '2026-07-13T23:59:59Z';
    expect(() => validateSafeCodingEffectAttestation(backwards)).toThrow(
      /finish before/,
    );
  });

  it('validates ticket nonces by decoded bytes and rejects base64url aliases', () => {
    const short = ticketFixture();
    short.nonce = encodeBase64Url(new Uint8Array(15));
    expect(() => validateSafeCodingExecutionTicket(short)).toThrow(
      /16 and 96 bytes/,
    );

    const aliased = ticketFixture();
    aliased.nonce = `${encodeBase64Url(new Uint8Array(16)).slice(0, -1)}B`;
    expect(() => validateSafeCodingExecutionTicket(aliased)).toThrow(
      /trailing bits|canonical base64url/,
    );
  });

  it('rejects status and evidence-level semantic laundering', () => {
    for (const status of ['denied', 'failed_no_effect']) {
      const impossible = attestationFixture();
      impossible.status = status;
      expect(() => validateSafeCodingEffectAttestation(impossible)).toThrow(
        /cannot claim post-state or result/,
      );
    }

    const independentWithoutReference = attestationFixture();
    independentWithoutReference.evidenceLevel = 'independently_reconciled';
    expect(() =>
      validateSafeCodingEffectAttestation(independentWithoutReference),
    ).toThrow(/reconciliationRef/);

    const attemptClaimingResult = attestationFixture();
    attemptClaimingResult.status = 'uncertain';
    attemptClaimingResult.evidenceLevel = 'attempt_only';
    expect(() =>
      validateSafeCodingEffectAttestation(attemptClaimingResult),
    ).toThrow(/attempt_only/);

    const reconciledWithoutPostState = attestationFixture();
    reconciledWithoutPostState.postStateHash = null;
    expect(() =>
      validateSafeCodingEffectAttestation(reconciledWithoutPostState),
    ).toThrow(/requires pre-state and post-state/);

    const committedWithOnlyPreState = attestationFixture();
    committedWithOnlyPreState.evidenceLevel = 'adapter_observed';
    committedWithOnlyPreState.postStateHash = null;
    committedWithOnlyPreState.resultHash = null;
    expect(() =>
      validateSafeCodingEffectAttestation(committedWithOnlyPreState),
    ).toThrow(/committed attestations require/);

    const falseNoop = attestationFixture();
    falseNoop.status = 'noop';
    expect(() => validateSafeCodingEffectAttestation(falseNoop)).toThrow(
      /equal pre\/post state and zero budget charges/,
    );

    const falseRollback = attestationFixture();
    falseRollback.status = 'rolled_back';
    falseRollback.budgetCharges = {
      uniqueModifiedFiles: 0,
      mutationBytes: 0,
      testRuns: 0,
    };
    expect(() => validateSafeCodingEffectAttestation(falseRollback)).toThrow(
      /equal reconciled pre\/post state/,
    );

    const deniedWithCharges = attestationFixture();
    deniedWithCharges.status = 'denied';
    deniedWithCharges.preStateHash = null;
    deniedWithCharges.postStateHash = null;
    deniedWithCharges.resultHash = null;
    deniedWithCharges.evidenceLevel = 'attempt_only';
    expect(() =>
      validateSafeCodingEffectAttestation(deniedWithCharges),
    ).toThrow(/cannot claim budget charges/);
  });
});

describe('domain-separated hashing and signed envelopes', () => {
  it('hashes exact canonical contract/action bytes behind an injected port', async () => {
    const calls = [];
    const hash = {
      sha256(bytes) {
        calls.push([...bytes]);
        return DIGEST;
      },
    };
    await expect(hashIntentContract(contractFixture(), hash)).resolves.toBe(
      DIGEST,
    );
    await expect(
      hashSafeCodingAction({ requestId: 'r-1', action: 'git.status' }, hash),
    ).resolves.toBe(DIGEST);
    expect(calls).toHaveLength(2);
    expect(calls[0].slice(0, INTENT_CONTRACT_HASH_DOMAIN.length)).toEqual([
      ...encodeUtf8(INTENT_CONTRACT_HASH_DOMAIN),
    ]);
    expect(calls[0][INTENT_CONTRACT_HASH_DOMAIN.length]).toBe(0);
    expect(calls[1].slice(0, SAFE_CODING_ACTION_HASH_DOMAIN.length)).toEqual([
      ...encodeUtf8(SAFE_CODING_ACTION_HASH_DOMAIN),
    ]);
  });

  it('round-trips canonical unpadded base64url', () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => index);
    expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
    expect(() => decodeBase64Url('A')).toThrow(/length/);
    expect(() => decodeBase64Url('AB')).toThrow(/trailing bits/);
  });

  it('requires exactly 64 canonical decoded signature bytes', async () => {
    const canonicalPayload = canonicalizeJson(contractFixture());
    const envelope = {
      payloadType: INTENT_CONTRACT_PAYLOAD_TYPE,
      payload: encodeBase64Url(encodeUtf8(canonicalPayload)),
      signatures: [
        {
          keyId: 'key.human-1',
          algorithm: 'P-256-SHA256-P1363',
          signature: encodeBase64Url(new Uint8Array(63)),
        },
      ],
    };
    const dependencies = {
      hash: { sha256: () => DIGEST },
      signatures: {
        resolveTrustedSigner: (keyId) => trustedSignerSnapshot({ keyId }),
        verify: () => true,
        assertTrusted: () => {},
      },
    };
    await expect(
      verifySignedIntentContract(envelope, dependencies),
    ).rejects.toThrow(/exactly 64 bytes/);

    const canonicalSignature = encodeBase64Url(new Uint8Array(64));
    envelope.signatures[0].signature = `${canonicalSignature.slice(0, -1)}B`;
    await expect(
      verifySignedIntentContract(envelope, dependencies),
    ).rejects.toThrow(/trailing bits|canonical base64url/);
  });

  it('creates DSSE v1 pre-authentication bytes', () => {
    const payload = canonicalizeJson({ value: 1 });
    const pae = createEnvelopePreAuthenticationEncoding(
      EFFECT_ATTESTATION_PAYLOAD_TYPE,
      payload,
    );
    expect([...pae]).toEqual([
      ...encodeUtf8(
        `DSSEv1 ${EFFECT_ATTESTATION_PAYLOAD_TYPE.length} ${EFFECT_ATTESTATION_PAYLOAD_TYPE} ${encodeUtf8(payload).length} `,
      ),
      ...encodeUtf8(payload),
    ]);
  });

  it('verifies an exact canonical contract with an accepted trusted role', async () => {
    const canonicalPayload = canonicalizeJson(contractFixture());
    const signature = encodeBase64Url(new Uint8Array(64).fill(7));
    const message = createEnvelopePreAuthenticationEncoding(
      INTENT_CONTRACT_PAYLOAD_TYPE,
      canonicalPayload,
    );
    const envelope = {
      payloadType: INTENT_CONTRACT_PAYLOAD_TYPE,
      payload: encodeBase64Url(encodeUtf8(canonicalPayload)),
      signatures: [
        {
          keyId: 'key.human-1',
          algorithm: 'P-256-SHA256-P1363',
          signature,
        },
      ],
    };
    const assertions = [];
    const verified = await verifySignedIntentContract(envelope, {
      hash: { sha256: async () => DIGEST },
      signatures: {
        resolveTrustedSigner: async (keyId) => trustedSignerSnapshot({ keyId }),
        verify: async (input) => {
          expect(Object.isFrozen(input.trustedSigner)).toBe(true);
          return (
            input.signature === signature &&
            [...input.message].join(',') === [...message].join(',')
          );
        },
        assertTrusted: (snapshot) => {
          assertions.push(snapshot);
        },
      },
    });
    expect(verified.contractHash).toBe(DIGEST);
    expect(verified.signerRole).toBe('human-authorizer');
    expect(verified.signer).toEqual(
      trustedSignerSnapshot({ keyId: 'key.human-1' }),
    );
    expect(verified.canonicalPayload).toBe(canonicalPayload);
    expect(assertions).toEqual([verified.signer]);
  });

  it('pins and binds verification port methods before the first await', async () => {
    const envelope = signedContractFixture();
    const signatures = {
      marker: 'bound',
      resolveTrustedSigner(keyId) {
        expect(this.marker).toBe('bound');
        this.verify = () => false;
        return trustedSignerSnapshot({ keyId });
      },
      verify(input) {
        expect(this.marker).toBe('bound');
        expect(input.trustedSigner.registryDigest).toBe(TRUST_REGISTRY_DIGEST);
        this.assertTrusted = () => {
          throw new Error('unpinned final fence');
        };
        return true;
      },
      assertTrusted(snapshot) {
        expect(this.marker).toBe('bound');
        expect(snapshot.keyId).toBe('key.human-1');
      },
    };
    const hash = {
      marker: 'bound',
      sha256() {
        expect(this.marker).toBe('bound');
        return DIGEST;
      },
    };
    await expect(
      verifySignedIntentContract(envelope, { hash, signatures }),
    ).resolves.toMatchObject({ contractHash: DIGEST });
  });

  it('rejects dependency and port accessors without evaluating getters', async () => {
    const envelope = signedContractFixture();
    const verifier = {
      resolveTrustedSigner: (keyId) => trustedSignerSnapshot({ keyId }),
      verify: () => true,
      assertTrusted: () => {},
    };

    let topLevelReads = 0;
    const topLevel = { signatures: verifier };
    Object.defineProperty(topLevel, 'hash', {
      enumerable: true,
      get: () => {
        topLevelReads += 1;
        return { sha256: () => DIGEST };
      },
    });
    await expect(
      verifySignedIntentContract(envelope, topLevel),
    ).rejects.toThrow(/own data field/);
    expect(topLevelReads).toBe(0);

    let methodReads = 0;
    const accessorHash = {};
    Object.defineProperty(accessorHash, 'sha256', {
      enumerable: true,
      get: () => {
        methodReads += 1;
        return () => DIGEST;
      },
    });
    await expect(
      verifySignedIntentContract(envelope, {
        hash: accessorHash,
        signatures: verifier,
      }),
    ).rejects.toThrow(/data method/);
    expect(methodReads).toBe(0);

    let acceptedRoleReads = 0;
    const acceptedRoles = {
      hash: { sha256: () => DIGEST },
      signatures: verifier,
    };
    Object.defineProperty(acceptedRoles, 'acceptedRootRoles', {
      enumerable: true,
      get: () => {
        acceptedRoleReads += 1;
        return ['human-authorizer'];
      },
    });
    await expect(
      verifySignedIntentContract(envelope, acceptedRoles),
    ).rejects.toThrow(/own data field/);
    expect(acceptedRoleReads).toBe(0);

    let verifierMethodReads = 0;
    const accessorVerifier = {
      verify: () => true,
      assertTrusted: () => {},
    };
    Object.defineProperty(accessorVerifier, 'resolveTrustedSigner', {
      enumerable: true,
      get: () => {
        verifierMethodReads += 1;
        return () => trustedSignerSnapshot();
      },
    });
    await expect(
      verifySignedIntentContract(envelope, {
        hash: { sha256: () => DIGEST },
        signatures: accessorVerifier,
      }),
    ).rejects.toThrow(/data method/);
    expect(verifierMethodReads).toBe(0);
  });

  it.each([
    'verify',
    'hash',
  ])('rejects root revocation during asynchronous %s', async (revocationPoint) => {
    const envelope = signedContractFixture();
    const trust = {
      active: true,
      role: 'human-authorizer',
      epoch: 7,
      digest: TRUST_REGISTRY_DIGEST,
    };
    const revoke = () => {
      trust.active = false;
      trust.epoch += 1;
      trust.digest = '8'.repeat(64);
    };
    const dependencies = {
      hash: {
        sha256: async () => {
          if (revocationPoint === 'hash') revoke();
          return DIGEST;
        },
      },
      signatures: {
        resolveTrustedSigner: (keyId) =>
          trust.active
            ? trustedSignerSnapshot({
                keyId,
                role: trust.role,
                trustEpoch: trust.epoch,
                registryDigest: trust.digest,
              })
            : null,
        verify: async () => {
          if (revocationPoint === 'verify') revoke();
          return true;
        },
        assertTrusted: (snapshot) => {
          if (
            !trust.active ||
            trust.role !== snapshot.role ||
            trust.epoch !== snapshot.trustEpoch ||
            trust.digest !== snapshot.registryDigest
          ) {
            throw new Error('trusted signer changed');
          }
        },
      },
    };
    await expect(
      verifySignedIntentContract(envelope, dependencies),
    ).rejects.toThrow(/trusted signer changed/);
  });

  it('rejects role/epoch drift and never combines signature registry snapshots', async () => {
    const signatures = [
      {
        keyId: 'key.model-1',
        algorithm: 'P-256-SHA256-P1363',
        signature: encodeBase64Url(new Uint8Array(64).fill(1)),
      },
      {
        keyId: 'key.policy-1',
        algorithm: 'P-256-SHA256-P1363',
        signature: encodeBase64Url(new Uint8Array(64).fill(2)),
      },
    ];
    const verifyCalls = [];
    await expect(
      verifySignedIntentContract(signedContractFixture(signatures), {
        hash: { sha256: () => DIGEST },
        signatures: {
          resolveTrustedSigner: (keyId) =>
            keyId === 'key.model-1'
              ? trustedSignerSnapshot({
                  keyId,
                  role: 'model',
                  trustEpoch: 10,
                  registryDigest: '1'.repeat(64),
                })
              : trustedSignerSnapshot({
                  keyId,
                  role: 'policy-authorizer',
                  trustEpoch: 11,
                  registryDigest: '2'.repeat(64),
                }),
          verify: (input) => {
            verifyCalls.push(input.keyId);
            return true;
          },
          assertTrusted: () => {},
        },
      }),
    ).rejects.toThrow(/Trust registry changed/);
    expect(verifyCalls).toEqual([]);
  });

  it('rejects a role change at the final synchronous trust fence', async () => {
    const trust = { role: 'human-authorizer', epoch: 4 };
    await expect(
      verifySignedIntentContract(signedContractFixture(), {
        hash: {
          sha256: async () => {
            trust.role = 'model';
            trust.epoch = 5;
            return DIGEST;
          },
        },
        signatures: {
          resolveTrustedSigner: (keyId) =>
            trustedSignerSnapshot({
              keyId,
              role: trust.role,
              trustEpoch: trust.epoch,
            }),
          verify: () => true,
          assertTrusted: (snapshot) => {
            if (
              trust.role !== snapshot.role ||
              trust.epoch !== snapshot.trustEpoch
            ) {
              throw new Error('role or trust epoch changed');
            }
          },
        },
      }),
    ).rejects.toThrow(/role or trust epoch changed/);
  });

  it('rejects asynchronous final trust assertions', async () => {
    await expect(
      verifySignedIntentContract(signedContractFixture(), {
        hash: { sha256: () => DIGEST },
        signatures: {
          resolveTrustedSigner: (keyId) => trustedSignerSnapshot({ keyId }),
          verify: () => true,
          assertTrusted: async () => {},
        },
      }),
    ).rejects.toThrow(/must complete synchronously/);
  });

  it('rejects untrusted roles, invalid signatures, wrong types, and noncanonical payloads', async () => {
    const signature = encodeBase64Url(new Uint8Array(64).fill(7));
    const canonicalPayload = canonicalizeJson(contractFixture());
    const base = {
      payloadType: INTENT_CONTRACT_PAYLOAD_TYPE,
      payload: encodeBase64Url(encodeUtf8(canonicalPayload)),
      signatures: [
        {
          keyId: 'key.model-1',
          algorithm: 'P-256-SHA256-P1363',
          signature,
        },
      ],
    };
    const dependencies = {
      hash: { sha256: () => DIGEST },
      signatures: {
        resolveTrustedSigner: (keyId) =>
          trustedSignerSnapshot({ keyId, role: 'model' }),
        verify: () => true,
        assertTrusted: () => {},
      },
    };
    await expect(
      verifySignedIntentContract(base, dependencies),
    ).rejects.toThrow(/no valid trusted/);

    await expect(
      verifySignedIntentContract(base, {
        ...dependencies,
        signatures: {
          resolveTrustedSigner: (keyId) =>
            trustedSignerSnapshot({ keyId, role: 'policy-authorizer' }),
          verify: () => false,
          assertTrusted: () => {},
        },
      }),
    ).rejects.toThrow(/no valid trusted/);

    await expect(
      verifySignedIntentContract(
        { ...base, payloadType: EFFECT_ATTESTATION_PAYLOAD_TYPE },
        dependencies,
      ),
    ).rejects.toThrow(/wrong Intent Contract payload type/);

    const noncanonical = ` ${canonicalPayload}`;
    await expect(
      verifySignedIntentContract(
        { ...base, payload: encodeBase64Url(encodeUtf8(noncanonical)) },
        dependencies,
      ),
    ).rejects.toThrow(/exact canonical/);
  });
});
