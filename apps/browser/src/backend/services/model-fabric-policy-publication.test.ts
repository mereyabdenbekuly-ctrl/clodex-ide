import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authorizeModelFabricPolicyPublication,
  createModelFabricPublicationApproval,
  getModelFabricPolicySnapshotHash,
  prepareSignedModelFabricPolicySnapshot,
  signModelFabricPublicationAuthority,
  verifyModelFabricPublicationState,
  verifyPreparedModelFabricPolicySnapshot,
  type ModelFabricPublicationState,
  type SignedModelFabricPolicySnapshot,
  type SignedModelFabricPublicationAuthority,
} from './model-fabric-policy-publication';

describe('Model Fabric policy publication', () => {
  it('builds a runtime-valid v3 snapshot and rejects key mismatch or tampering', () => {
    const fixture = createFixture();
    const snapshot = prepareSnapshot(fixture);

    expect(snapshot).toMatchObject({
      schemaVersion: 3,
      rootset: { revision: 1, signedBy: 'root-a' },
      keyset: { revision: 1, rootKeyId: 'root-a' },
      policy: { revision: 1, keyId: 'policy-a' },
    });
    expect(getModelFabricPolicySnapshotHash(snapshot)).toMatch(
      /^[a-f0-9]{64}$/,
    );

    const tampered = structuredClone(snapshot);
    tampered.policy.policies[0]!.limitUsd = 999;
    expect(() =>
      verifyPreparedModelFabricPolicySnapshot({
        snapshot: tampered,
        rootPublicKey: fixture.root.publicKeyPem,
        now: fixture.now,
      }),
    ).toThrow('runtime verification');

    const wrong = keyPair();
    expect(() =>
      prepareSignedModelFabricPolicySnapshot({
        payload: createUnsignedSnapshot(fixture),
        pinnedRootPublicKey: fixture.root.publicKeyPem,
        rootsetPrivateKey: wrong.privateKeyPem,
        keysetPrivateKey: fixture.root.privateKeyPem,
        policyPrivateKey: fixture.policy.privateKeyPem,
        now: fixture.now,
      }),
    ).toThrow('Rootset private key does not match');
  });

  it('enforces authenticated canary approval before production promotion', () => {
    const fixture = createFixture();
    const authority = signAuthority(fixture);
    const snapshot = prepareSnapshot(fixture);
    const canaryApproval = createApproval(
      fixture,
      authority,
      snapshot,
      'release',
      'canary',
      '1'.repeat(32),
    );

    const canary = authorizeModelFabricPolicyPublication({
      authority,
      authorityRootPublicKey: fixture.root.publicKeyPem,
      snapshot,
      snapshotRootPublicKey: fixture.root.publicKeyPem,
      approvals: [canaryApproval],
      stage: 'canary',
      publisherKeyId: 'publisher-a',
      publisherPrivateKey: fixture.publisher.privateKeyPem,
      allowBootstrap: true,
      now: fixture.now + 100,
      publicationId: 'publication-canary',
    });
    expect(canary.receipt).toMatchObject({
      stage: 'canary',
      previousReceiptHash: null,
      snapshotHash: getModelFabricPolicySnapshotHash(snapshot),
    });
    expect(JSON.stringify(canary.receipt)).not.toMatch(
      /policies|limitUsd|publicKey|privateKey/i,
    );

    const productionReleaseApproval = createApproval(
      fixture,
      authority,
      snapshot,
      'release',
      'production',
      '2'.repeat(32),
    );
    const productionSecurityApproval = createApproval(
      fixture,
      authority,
      snapshot,
      'security',
      'production',
      '3'.repeat(32),
    );
    expect(() =>
      authorizeModelFabricPolicyPublication({
        authority,
        authorityRootPublicKey: fixture.root.publicKeyPem,
        snapshot,
        snapshotRootPublicKey: fixture.root.publicKeyPem,
        approvals: [productionReleaseApproval],
        stage: 'production',
        publisherKeyId: 'publisher-a',
        publisherPrivateKey: fixture.publisher.privateKeyPem,
        previousState: canary.state,
        now: fixture.now + 200,
      }),
    ).toThrow('requires 2 distinct approvals');

    const production = authorizeModelFabricPolicyPublication({
      authority,
      authorityRootPublicKey: fixture.root.publicKeyPem,
      snapshot,
      snapshotRootPublicKey: fixture.root.publicKeyPem,
      approvals: [productionReleaseApproval, productionSecurityApproval],
      stage: 'production',
      publisherKeyId: 'publisher-a',
      publisherPrivateKey: fixture.publisher.privateKeyPem,
      previousState: canary.state,
      now: fixture.now + 200,
      publicationId: 'publication-production',
    });
    expect(production.receipt).toMatchObject({
      stage: 'production',
      snapshotHash: canary.receipt.snapshotHash,
      authorityRevision: 1,
    });
    expect(production.receipt.previousReceiptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      verifyModelFabricPublicationState({
        state: production.state,
        rootPublicKey: fixture.root.publicKeyPem,
        now: fixture.now + 300,
      }),
    ).toEqual(production.state);
  });

  it('rejects direct production, approval tampering, and duplicate approvers', () => {
    const fixture = createFixture();
    const authority = signAuthority(fixture);
    const snapshot = prepareSnapshot(fixture);
    const releaseApproval = createApproval(
      fixture,
      authority,
      snapshot,
      'release',
      'production',
      '4'.repeat(32),
    );
    const securityApproval = createApproval(
      fixture,
      authority,
      snapshot,
      'security',
      'production',
      '5'.repeat(32),
    );

    expect(() =>
      authorizeModelFabricPolicyPublication({
        authority,
        authorityRootPublicKey: fixture.root.publicKeyPem,
        snapshot,
        snapshotRootPublicKey: fixture.root.publicKeyPem,
        approvals: [releaseApproval, securityApproval],
        stage: 'production',
        publisherKeyId: 'publisher-a',
        publisherPrivateKey: fixture.publisher.privateKeyPem,
        allowBootstrap: true,
        now: fixture.now + 100,
      }),
    ).toThrow('requires a prior canary receipt');

    const canaryApproval = createApproval(
      fixture,
      authority,
      snapshot,
      'release',
      'canary',
      '6'.repeat(32),
    );
    expect(() =>
      authorizeModelFabricPolicyPublication({
        authority,
        authorityRootPublicKey: fixture.root.publicKeyPem,
        snapshot,
        snapshotRootPublicKey: fixture.root.publicKeyPem,
        approvals: [canaryApproval],
        stage: 'canary',
        publisherKeyId: 'publisher-a',
        publisherPrivateKey: fixture.publisher.privateKeyPem,
        now: fixture.now + 100,
      }),
    ).toThrow('explicit bootstrap authorization');
    const tampered = {
      ...canaryApproval,
      expiresAt: canaryApproval.expiresAt - 1,
    };
    expect(() =>
      authorizeModelFabricPolicyPublication({
        authority,
        authorityRootPublicKey: fixture.root.publicKeyPem,
        snapshot,
        snapshotRootPublicKey: fixture.root.publicKeyPem,
        approvals: [tampered],
        stage: 'canary',
        publisherKeyId: 'publisher-a',
        publisherPrivateKey: fixture.publisher.privateKeyPem,
        allowBootstrap: true,
        now: fixture.now + 100,
      }),
    ).toThrow('signature verification failed');

    expect(() =>
      authorizeModelFabricPolicyPublication({
        authority,
        authorityRootPublicKey: fixture.root.publicKeyPem,
        snapshot,
        snapshotRootPublicKey: fixture.root.publicKeyPem,
        approvals: [canaryApproval, canaryApproval],
        stage: 'canary',
        publisherKeyId: 'publisher-a',
        publisherPrivateKey: fixture.publisher.privateKeyPem,
        allowBootstrap: true,
        now: fixture.now + 100,
      }),
    ).toThrow('distinct approvers');
  });

  it('prevents approval replay and requires revision advances for later canaries', () => {
    const fixture = createFixture();
    const authority = signAuthority(fixture);
    const snapshot = prepareSnapshot(fixture);
    const canary = publishCanary(fixture, authority, snapshot, '7'.repeat(32));

    expect(() =>
      authorizeModelFabricPolicyPublication({
        authority,
        authorityRootPublicKey: fixture.root.publicKeyPem,
        snapshot,
        snapshotRootPublicKey: fixture.root.publicKeyPem,
        approvals: [
          createApproval(
            fixture,
            authority,
            snapshot,
            'release',
            'canary',
            '8'.repeat(32),
          ),
        ],
        stage: 'canary',
        publisherKeyId: 'publisher-a',
        publisherPrivateKey: fixture.publisher.privateKeyPem,
        previousState: canary.state,
        now: fixture.now + 200,
      }),
    ).toThrow('already published');

    const advancedSnapshot = prepareSnapshot(fixture, {
      policyRevision: 2,
      limitUsd: 275,
    });
    const replayedNonceApproval = createApproval(
      fixture,
      authority,
      advancedSnapshot,
      'release',
      'canary',
      '7'.repeat(32),
    );
    expect(() =>
      authorizeModelFabricPolicyPublication({
        authority,
        authorityRootPublicKey: fixture.root.publicKeyPem,
        snapshot: advancedSnapshot,
        snapshotRootPublicKey: fixture.root.publicKeyPem,
        approvals: [replayedNonceApproval],
        stage: 'canary',
        publisherKeyId: 'publisher-a',
        publisherPrivateKey: fixture.publisher.privateKeyPem,
        previousState: canary.state,
        now: fixture.now + 200,
      }),
    ).toThrow('approval replay');

    const replayState = structuredClone(canary.state);
    replayState.lastReceipt = {
      ...replayState.lastReceipt,
      publicationId: 'tampered-publication',
    };
    expect(() =>
      verifyModelFabricPublicationState({
        state: replayState,
        rootPublicKey: fixture.root.publicKeyPem,
        now: fixture.now + 200,
      }),
    ).toThrow('state signature verification failed');

    const nonceDeletion = structuredClone(canary.state);
    nonceDeletion.usedApprovalNonceHashes = [];
    expect(() =>
      verifyModelFabricPublicationState({
        state: nonceDeletion,
        rootPublicKey: fixture.root.publicKeyPem,
        now: fixture.now + 200,
      }),
    ).toThrow('state signature verification failed');

    const nonceInsertion = structuredClone(canary.state);
    nonceInsertion.usedApprovalNonceHashes.push('f'.repeat(64));
    nonceInsertion.usedApprovalNonceHashes.sort();
    expect(() =>
      verifyModelFabricPublicationState({
        state: nonceInsertion,
        rootPublicKey: fixture.root.publicKeyPem,
        now: fixture.now + 200,
      }),
    ).toThrow('state signature verification failed');

    const rollbackSnapshot = prepareSnapshot(fixture, {
      rootsetRevision: 1,
      keysetRevision: 1,
      policyRevision: 0,
      limitUsd: 200,
    });
    const rollbackApproval = createApproval(
      fixture,
      authority,
      rollbackSnapshot,
      'release',
      'canary',
      '9'.repeat(32),
    );
    expect(() =>
      authorizeModelFabricPolicyPublication({
        authority,
        authorityRootPublicKey: fixture.root.publicKeyPem,
        snapshot: rollbackSnapshot,
        snapshotRootPublicKey: fixture.root.publicKeyPem,
        approvals: [rollbackApproval],
        stage: 'canary',
        publisherKeyId: 'publisher-a',
        publisherPrivateKey: fixture.publisher.privateKeyPem,
        previousState: canary.state,
        now: fixture.now + 200,
      }),
    ).toThrow('policy rollback');
  });

  it('continues publication across a cross-signed root rotation only with authenticated previous trust', () => {
    const fixture = createFixture();
    const rootB = keyPair();
    const authority = signAuthority(fixture);
    const snapshotV1 = prepareSnapshot(fixture);
    const publicationV1 = publishCanary(
      fixture,
      authority,
      snapshotV1,
      'c'.repeat(32),
    );

    const snapshotV2 = prepareRotatedSnapshot(fixture, rootB, {
      revision: 2,
      signedBy: 'root-a',
      rootsetPrivateKey: fixture.root.privateKeyPem,
      previousSnapshot: publicationV1.state.lastSnapshot,
    });
    const approvalV2 = createModelFabricPublicationApproval({
      authority,
      authorityRootPublicKey: fixture.root.publicKeyPem,
      snapshot: snapshotV2,
      snapshotRootPublicKey: fixture.root.publicKeyPem,
      approverId: 'approver-release',
      approverPrivateKey: fixture.release.privateKeyPem,
      stage: 'canary',
      previousState: publicationV1.state,
      now: fixture.now + 200,
      nonce: 'd'.repeat(32),
    });
    const publicationV2 = authorizeModelFabricPolicyPublication({
      authority,
      authorityRootPublicKey: fixture.root.publicKeyPem,
      snapshot: snapshotV2,
      snapshotRootPublicKey: fixture.root.publicKeyPem,
      approvals: [approvalV2],
      stage: 'canary',
      publisherKeyId: 'publisher-a',
      publisherPrivateKey: fixture.publisher.privateKeyPem,
      previousState: publicationV1.state,
      now: fixture.now + 300,
    });

    expect(() =>
      prepareRotatedSnapshot(fixture, rootB, {
        revision: 3,
        signedBy: 'root-b',
        rootsetPrivateKey: rootB.privateKeyPem,
      }),
    ).toThrow('initial rootset is not signed by the pinned root');

    const snapshotV3 = prepareRotatedSnapshot(fixture, rootB, {
      revision: 3,
      signedBy: 'root-b',
      rootsetPrivateKey: rootB.privateKeyPem,
      previousSnapshot: publicationV2.state.lastSnapshot,
    });
    expect(() =>
      createModelFabricPublicationApproval({
        authority,
        authorityRootPublicKey: fixture.root.publicKeyPem,
        snapshot: snapshotV3,
        snapshotRootPublicKey: fixture.root.publicKeyPem,
        approverId: 'approver-release',
        approverPrivateKey: fixture.release.privateKeyPem,
        stage: 'canary',
        now: fixture.now + 400,
        nonce: 'e'.repeat(32),
      }),
    ).toThrow('initial rootset is not signed by the pinned root');

    const approvalV3 = createModelFabricPublicationApproval({
      authority,
      authorityRootPublicKey: fixture.root.publicKeyPem,
      snapshot: snapshotV3,
      snapshotRootPublicKey: fixture.root.publicKeyPem,
      approverId: 'approver-release',
      approverPrivateKey: fixture.release.privateKeyPem,
      stage: 'canary',
      previousState: publicationV2.state,
      now: fixture.now + 400,
      nonce: 'e'.repeat(32),
    });
    const publicationV3 = authorizeModelFabricPolicyPublication({
      authority,
      authorityRootPublicKey: fixture.root.publicKeyPem,
      snapshot: snapshotV3,
      snapshotRootPublicKey: fixture.root.publicKeyPem,
      approvals: [approvalV3],
      stage: 'canary',
      publisherKeyId: 'publisher-a',
      publisherPrivateKey: fixture.publisher.privateKeyPem,
      previousState: publicationV2.state,
      now: fixture.now + 500,
    });
    expect(publicationV3.state.lastSnapshot.rootset).toMatchObject({
      revision: 3,
      signedBy: 'root-b',
    });
    expect(
      verifyModelFabricPublicationState({
        state: publicationV3.state,
        rootPublicKey: fixture.root.publicKeyPem,
        now: fixture.now + 600,
      }),
    ).toEqual(publicationV3.state);
  });

  it('rejects rollout requirements that only revoked approvers can satisfy', () => {
    const fixture = createFixture();
    expect(() =>
      signAuthority(fixture, {
        releaseStatus: 'revoked',
        canaryRequiredRole: 'security',
        productionRequiredApprovals: 1,
        productionRequiredRoles: ['release'],
      }),
    ).toThrow('roles without active approvers');
  });

  it('rejects authority rollback and revoked-approver reactivation', () => {
    const fixture = createFixture();
    const authorityV1 = signAuthority(fixture);
    const snapshot = prepareSnapshot(fixture);
    const canary = publishCanary(
      fixture,
      authorityV1,
      snapshot,
      'a'.repeat(32),
    );

    const authorityV2 = signAuthority(fixture, {
      revision: 2,
      releaseStatus: 'revoked',
      canaryRequiredRole: 'security',
      productionRequiredApprovals: 1,
      productionRequiredRoles: ['security'],
    });
    const snapshotV2 = prepareSnapshot(fixture, {
      policyRevision: 2,
      limitUsd: 300,
    });
    const securityApproval = createApproval(
      fixture,
      authorityV2,
      snapshotV2,
      'security',
      'canary',
      'b'.repeat(32),
    );
    const v2Publication = authorizeModelFabricPolicyPublication({
      authority: authorityV2,
      authorityRootPublicKey: fixture.root.publicKeyPem,
      snapshot: snapshotV2,
      snapshotRootPublicKey: fixture.root.publicKeyPem,
      approvals: [securityApproval],
      stage: 'canary',
      publisherKeyId: 'publisher-a',
      publisherPrivateKey: fixture.publisher.privateKeyPem,
      previousState: canary.state,
      now: fixture.now + 300,
    });

    expect(() =>
      authorizeModelFabricPolicyPublication({
        authority: authorityV1,
        authorityRootPublicKey: fixture.root.publicKeyPem,
        snapshot: snapshotV2,
        snapshotRootPublicKey: fixture.root.publicKeyPem,
        approvals: [],
        stage: 'canary',
        publisherKeyId: 'publisher-a',
        publisherPrivateKey: fixture.publisher.privateKeyPem,
        previousState: v2Publication.state,
        now: fixture.now + 400,
      }),
    ).toThrow('authority rollback');

    const authorityV3 = signAuthority(fixture, {
      revision: 3,
      releaseStatus: 'active',
      canaryRequiredRole: 'security',
      productionRequiredApprovals: 1,
      productionRequiredRoles: ['security'],
    });
    expect(() =>
      authorizeModelFabricPolicyPublication({
        authority: authorityV3,
        authorityRootPublicKey: fixture.root.publicKeyPem,
        snapshot: snapshotV2,
        snapshotRootPublicKey: fixture.root.publicKeyPem,
        approvals: [],
        stage: 'canary',
        publisherKeyId: 'publisher-a',
        publisherPrivateKey: fixture.publisher.privateKeyPem,
        previousState: v2Publication.state,
        now: fixture.now + 400,
      }),
    ).toThrow('approver revocation rollback');
  });
});

interface KeyFixture {
  privateKeyPem: string;
  publicKeyPem: string;
}

interface Fixture {
  now: number;
  root: KeyFixture;
  policy: KeyFixture;
  release: KeyFixture;
  security: KeyFixture;
  publisher: KeyFixture;
}

function createFixture(): Fixture {
  return {
    now: 2_000,
    root: keyPair(),
    policy: keyPair(),
    release: keyPair(),
    security: keyPair(),
    publisher: keyPair(),
  };
}

function keyPair(): KeyFixture {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    publicKeyPem: pair.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
  };
}

function createUnsignedSnapshot(
  fixture: Fixture,
  overrides: {
    rootsetRevision?: number;
    keysetRevision?: number;
    policyRevision?: number;
    limitUsd?: number;
  } = {},
) {
  const trustWindow = {
    status: 'active' as const,
    notBefore: 1_000,
    notAfter: 100_000,
  };
  return {
    schemaVersion: 1 as const,
    rootset: {
      schemaVersion: 1 as const,
      revision: overrides.rootsetRevision ?? 1,
      issuedAt: 1_000,
      expiresAt: 90_000,
      signedBy: 'root-a',
      roots: [
        {
          keyId: 'root-a',
          publicKey: fixture.root.publicKeyPem,
          ...trustWindow,
        },
      ],
    },
    keyset: {
      schemaVersion: 2 as const,
      rootKeyId: 'root-a',
      revision: overrides.keysetRevision ?? 1,
      issuedAt: 1_000,
      expiresAt: 80_000,
      keys: [
        {
          keyId: 'policy-a',
          publicKey: fixture.policy.publicKeyPem,
          ...trustWindow,
        },
      ],
    },
    policy: {
      schemaVersion: 1 as const,
      keyId: 'policy-a',
      revision: overrides.policyRevision ?? 1,
      issuedAt: 1_000,
      expiresAt: 70_000,
      policies: [
        {
          id: 'enterprise-global',
          scope: 'global' as const,
          scopeRef: 'global',
          windowMs: 86_400_000,
          limitUsd: overrides.limitUsd ?? 250,
          mode: 'hard' as const,
        },
      ],
    },
  };
}

function prepareSnapshot(
  fixture: Fixture,
  overrides: Parameters<typeof createUnsignedSnapshot>[1] = {},
): SignedModelFabricPolicySnapshot {
  return prepareSignedModelFabricPolicySnapshot({
    payload: createUnsignedSnapshot(fixture, overrides),
    pinnedRootPublicKey: fixture.root.publicKeyPem,
    rootsetPrivateKey: fixture.root.privateKeyPem,
    keysetPrivateKey: fixture.root.privateKeyPem,
    policyPrivateKey: fixture.policy.privateKeyPem,
    now: fixture.now,
  });
}

function prepareRotatedSnapshot(
  fixture: Fixture,
  rootB: KeyFixture,
  options: {
    revision: number;
    signedBy: 'root-a' | 'root-b';
    rootsetPrivateKey: string;
    previousSnapshot?: SignedModelFabricPolicySnapshot;
  },
): SignedModelFabricPolicySnapshot {
  const trustWindow = {
    notBefore: 1_000,
    notAfter: 100_000,
  };
  return prepareSignedModelFabricPolicySnapshot({
    payload: {
      schemaVersion: 1,
      rootset: {
        schemaVersion: 1,
        revision: options.revision,
        issuedAt: 1_000 + options.revision * 10,
        expiresAt: 90_000,
        signedBy: options.signedBy,
        roots: [
          {
            keyId: 'root-a',
            publicKey: fixture.root.publicKeyPem,
            status: 'revoked',
            ...trustWindow,
          },
          {
            keyId: 'root-b',
            publicKey: rootB.publicKeyPem,
            status: 'active',
            ...trustWindow,
          },
        ],
      },
      keyset: {
        schemaVersion: 2,
        rootKeyId: 'root-b',
        revision: options.revision,
        issuedAt: 1_000 + options.revision * 10,
        expiresAt: 80_000,
        keys: [
          {
            keyId: 'policy-a',
            publicKey: fixture.policy.publicKeyPem,
            status: 'active',
            ...trustWindow,
          },
        ],
      },
      policy: {
        schemaVersion: 1,
        keyId: 'policy-a',
        revision: options.revision,
        issuedAt: 1_000 + options.revision * 10,
        expiresAt: 70_000,
        policies: [
          {
            id: 'enterprise-global',
            scope: 'global',
            scopeRef: 'global',
            windowMs: 86_400_000,
            limitUsd: 250 + options.revision,
            mode: 'hard',
          },
        ],
      },
    },
    pinnedRootPublicKey: fixture.root.publicKeyPem,
    rootsetPrivateKey: options.rootsetPrivateKey,
    keysetPrivateKey: rootB.privateKeyPem,
    policyPrivateKey: fixture.policy.privateKeyPem,
    previousSnapshot: options.previousSnapshot,
    now: fixture.now,
  });
}

function createUnsignedAuthority(
  fixture: Fixture,
  overrides: {
    revision?: number;
    releaseStatus?: 'active' | 'revoked';
    canaryRequiredRole?: 'release' | 'security';
    productionRequiredApprovals?: number;
    productionRequiredRoles?: Array<'release' | 'security'>;
  } = {},
) {
  const trustWindow = {
    notBefore: 1_000,
    notAfter: 100_000,
  };
  return {
    schemaVersion: 1 as const,
    authorityId: 'enterprise-policy-authority',
    revision: overrides.revision ?? 1,
    issuedAt: 1_000,
    expiresAt: 90_000,
    signedBy: 'root-a',
    approvers: [
      {
        keyId: 'approver-release',
        publicKey: fixture.release.publicKeyPem,
        status: overrides.releaseStatus ?? ('active' as const),
        ...trustWindow,
        roles: ['release'],
      },
      {
        keyId: 'approver-security',
        publicKey: fixture.security.publicKeyPem,
        status: 'active' as const,
        ...trustWindow,
        roles: ['security'],
      },
    ],
    publishers: [
      {
        keyId: 'publisher-a',
        publicKey: fixture.publisher.publicKeyPem,
        status: 'active' as const,
        ...trustWindow,
      },
    ],
    stages: [
      {
        stage: 'canary' as const,
        requiredApprovals: 1,
        requiredRoles: [overrides.canaryRequiredRole ?? 'release'],
      },
      {
        stage: 'production' as const,
        requiredApprovals: overrides.productionRequiredApprovals ?? 2,
        requiredRoles: overrides.productionRequiredRoles ?? [
          'release',
          'security',
        ],
        requiresPriorStage: 'canary' as const,
      },
    ],
  };
}

function signAuthority(
  fixture: Fixture,
  overrides: Parameters<typeof createUnsignedAuthority>[1] = {},
): SignedModelFabricPublicationAuthority {
  return signModelFabricPublicationAuthority({
    authority: createUnsignedAuthority(fixture, overrides),
    rootPrivateKey: fixture.root.privateKeyPem,
    rootPublicKey: fixture.root.publicKeyPem,
    now: fixture.now,
  });
}

function createApproval(
  fixture: Fixture,
  authority: SignedModelFabricPublicationAuthority,
  snapshot: SignedModelFabricPolicySnapshot,
  approver: 'release' | 'security',
  stage: 'canary' | 'production',
  nonce: string,
) {
  return createModelFabricPublicationApproval({
    authority,
    authorityRootPublicKey: fixture.root.publicKeyPem,
    snapshot,
    snapshotRootPublicKey: fixture.root.publicKeyPem,
    approverId:
      approver === 'release' ? 'approver-release' : 'approver-security',
    approverPrivateKey:
      approver === 'release'
        ? fixture.release.privateKeyPem
        : fixture.security.privateKeyPem,
    stage,
    now: fixture.now,
    nonce,
  });
}

function publishCanary(
  fixture: Fixture,
  authority: SignedModelFabricPublicationAuthority,
  snapshot: SignedModelFabricPolicySnapshot,
  nonce: string,
): { state: ModelFabricPublicationState } {
  const requiredRole = authority.stages.find(
    (stage) => stage.stage === 'canary',
  )!.requiredRoles[0];
  const approver = requiredRole === 'security' ? 'security' : 'release';
  const approval = createApproval(
    fixture,
    authority,
    snapshot,
    approver,
    'canary',
    nonce,
  );
  return authorizeModelFabricPolicyPublication({
    authority,
    authorityRootPublicKey: fixture.root.publicKeyPem,
    snapshot,
    snapshotRootPublicKey: fixture.root.publicKeyPem,
    approvals: [approval],
    stage: 'canary',
    publisherKeyId: 'publisher-a',
    publisherPrivateKey: fixture.publisher.privateKeyPem,
    allowBootstrap: true,
    now: fixture.now + 100,
  });
}
