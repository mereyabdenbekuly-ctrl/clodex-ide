import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { P256RunnerSigningAuthority } from '@clodex/agent-shell';
import { afterEach, describe, expect, it } from 'vitest';
import { signRunnerDogfoodEvidenceBundle } from './runner-routing/dogfood-evidence';
import {
  authorizeModelFabricPolicyPublication,
  createModelFabricPublicationApproval,
  prepareSignedModelFabricPolicySnapshot,
  signModelFabricPublicationAuthority,
} from './model-fabric-policy-publication';
import {
  assessModelFabricPromotion,
  assessRunnerPromotion,
  evaluateRunnerPromotionBundles,
} from './main-plan-promotion-assessments';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('main plan promotion assessments', () => {
  it('keeps absent evidence non-blocking and fails closed on a missing Model Fabric root', async () => {
    const root = await temporaryRoot();
    const statePath = path.join(root, 'model-fabric.json');
    const rootPublicKeyPath = path.join(root, 'missing.pem');
    expect(
      assessModelFabricPromotion({
        channel: 'prerelease',
        now: new Date('2026-07-12T00:00:00.000Z'),
        statePath,
        rootPublicKeyPath,
      }),
    ).toMatchObject({ state: 'absent', blockers: [] });

    await fs.writeFile(statePath, '{}', 'utf8');
    expect(
      assessModelFabricPromotion({
        channel: 'prerelease',
        now: new Date('2026-07-12T00:00:00.000Z'),
        statePath,
        rootPublicKeyPath,
      }),
    ).toMatchObject({
      state: 'not-ready',
      blockers: ['model-fabric-root-public-key-missing'],
    });
  });

  it('accepts an authenticated production Model Fabric publication state', async () => {
    const root = await temporaryRoot();
    const statePath = path.join(root, 'model-fabric.json');
    const rootPublicKeyPath = path.join(root, 'root.public.pem');
    const fixture = modelFabricFixture();
    const authority = signModelFabricPublicationAuthority({
      authority: fixture.authority,
      rootPrivateKey: fixture.root.privateKeyPem,
      rootPublicKey: fixture.root.publicKeyPem,
      now: fixture.now,
    });
    const snapshot = prepareSignedModelFabricPolicySnapshot({
      payload: fixture.snapshot,
      pinnedRootPublicKey: fixture.root.publicKeyPem,
      rootsetPrivateKey: fixture.root.privateKeyPem,
      keysetPrivateKey: fixture.root.privateKeyPem,
      policyPrivateKey: fixture.policy.privateKeyPem,
      now: fixture.now,
    });
    const canaryApproval = createModelFabricPublicationApproval({
      authority,
      authorityRootPublicKey: fixture.root.publicKeyPem,
      snapshot,
      snapshotRootPublicKey: fixture.root.publicKeyPem,
      approverId: 'approver-release',
      approverPrivateKey: fixture.release.privateKeyPem,
      stage: 'canary',
      now: fixture.now,
      nonce: 'a'.repeat(32),
    });
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
    });
    const productionReleaseApproval = createModelFabricPublicationApproval({
      authority,
      authorityRootPublicKey: fixture.root.publicKeyPem,
      snapshot,
      snapshotRootPublicKey: fixture.root.publicKeyPem,
      approverId: 'approver-release',
      approverPrivateKey: fixture.release.privateKeyPem,
      stage: 'production',
      previousState: canary.state,
      now: fixture.now + 200,
      nonce: 'b'.repeat(32),
    });
    const productionSecurityApproval = createModelFabricPublicationApproval({
      authority,
      authorityRootPublicKey: fixture.root.publicKeyPem,
      snapshot,
      snapshotRootPublicKey: fixture.root.publicKeyPem,
      approverId: 'approver-security',
      approverPrivateKey: fixture.security.privateKeyPem,
      stage: 'production',
      previousState: canary.state,
      now: fixture.now + 200,
      nonce: 'c'.repeat(32),
    });
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
      now: fixture.now + 300,
    });
    await Promise.all([
      fs.writeFile(statePath, JSON.stringify(production.state), 'utf8'),
      fs.writeFile(rootPublicKeyPath, fixture.root.publicKeyPem, 'utf8'),
    ]);

    expect(
      assessModelFabricPromotion({
        channel: 'release',
        now: new Date(fixture.now + 400),
        statePath,
        rootPublicKeyPath,
      }),
    ).toMatchObject({
      state: 'ready',
      blockers: [],
      details: { stage: 'production', policyRevision: 1 },
    });
  });

  it('accepts fresh signed SSH paired replay with bounded workload coverage', () => {
    const identity = P256RunnerSigningAuthority.generate();
    const now = new Date('2026-07-12T00:00:00.000Z');
    const bundle = signRunnerDogfoodEvidenceBundle(
      unsignedBundle(now.getTime()),
      identity,
    );

    expect(evaluateRunnerPromotionBundles([bundle], now)).toMatchObject({
      state: 'ready',
      blockers: [],
      details: {
        bundleCount: 1,
        physicalSampleCount: 4,
        distinctCommandClasses: 2,
        providerKinds: 'ssh',
      },
    });
  });

  it('rejects physical runner evidence collected from another source commit', () => {
    const identity = P256RunnerSigningAuthority.generate();
    const now = new Date('2026-07-12T00:00:00.000Z');
    const bundle = signRunnerDogfoodEvidenceBundle(
      unsignedBundle(now.getTime()),
      identity,
    );

    expect(
      evaluateRunnerPromotionBundles(
        [bundle],
        now,
        'in-memory',
        '8'.repeat(40),
      ),
    ).toMatchObject({
      state: 'not-ready',
      blockers: expect.arrayContaining(['runner-source-commit-mismatch']),
    });
  });

  it('verifies pinned collectors from disk and rejects untrusted bundles', async () => {
    const root = await temporaryRoot();
    const evidenceDirectoryPath = path.join(root, 'runner-routing');
    const trustedCollectorPublicKeysPath = path.join(root, 'collectors.txt');
    await fs.mkdir(evidenceDirectoryPath);
    const now = new Date('2026-07-12T00:00:00.000Z');
    const identity = P256RunnerSigningAuthority.generate();
    const bundle = signRunnerDogfoodEvidenceBundle(
      unsignedBundle(now.getTime()),
      identity,
    );
    await fs.writeFile(
      path.join(evidenceDirectoryPath, 'ssh.json'),
      JSON.stringify(bundle),
      'utf8',
    );
    await fs.writeFile(
      trustedCollectorPublicKeysPath,
      identity.publicKey,
      'utf8',
    );

    expect(
      assessRunnerPromotion({
        now,
        buildCommitSha: '9'.repeat(40),
        evidenceDirectoryPath,
        trustedCollectorPublicKeysPath,
      }),
    ).toMatchObject({ state: 'ready', blockers: [] });

    const untrusted = P256RunnerSigningAuthority.generate();
    await fs.writeFile(
      trustedCollectorPublicKeysPath,
      untrusted.publicKey,
      'utf8',
    );
    expect(
      assessRunnerPromotion({
        now,
        buildCommitSha: '9'.repeat(40),
        evidenceDirectoryPath,
        trustedCollectorPublicKeysPath,
      }),
    ).toMatchObject({
      state: 'invalid',
      blockers: ['runner-evidence-validation-failed'],
    });
  });

  it('does not let controlled-only or stale replay unlock promotion', () => {
    const identity = P256RunnerSigningAuthority.generate();
    const now = new Date('2026-07-12T00:00:00.000Z');
    const controlled = unsignedBundle(now.getTime() - 8 * 24 * 60 * 60_000);
    const bundle = signRunnerDogfoodEvidenceBundle(
      {
        ...controlled,
        samples: controlled.samples.map((sample) => ({
          ...sample,
          scenario: 'controlled-local-failure' as const,
          promotionEligible: false,
        })),
      },
      identity,
    );
    const assessment = evaluateRunnerPromotionBundles([bundle], now);

    expect(assessment.state).toBe('not-ready');
    expect(assessment.blockers).toEqual(
      expect.arrayContaining([
        'runner-evidence-stale',
        'runner-physical-samples-insufficient',
        'runner-command-class-coverage-insufficient',
      ]),
    );
  });

  it('rejects duplicated signed bundles instead of counting replayed evidence', () => {
    const identity = P256RunnerSigningAuthority.generate();
    const now = new Date('2026-07-12T00:00:00.000Z');
    const bundle = signRunnerDogfoodEvidenceBundle(
      unsignedBundle(now.getTime()),
      identity,
    );
    const assessment = evaluateRunnerPromotionBundles([bundle, bundle], now);

    expect(assessment.state).toBe('not-ready');
    expect(assessment.blockers).toEqual(
      expect.arrayContaining([
        'runner-bundle-replay-detected',
        'runner-sample-replay-detected',
        'runner-receipt-replay-detected',
        'runner-job-replay-detected',
      ]),
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'main-plan-promotion-'));
  temporaryRoots.push(root);
  return root;
}

function unsignedBundle(collectedAt: number) {
  return {
    schemaVersion: 2 as const,
    bundleId: randomUUID(),
    collectedAt,
    sourceCommitSha: '9'.repeat(40),
    samples: Array.from({ length: 4 }, (_, index) => ({
      sampleId: randomUUID(),
      profile: 'ssh-read-only' as const,
      commandClassHash: (index % 2 === 0 ? 'a' : 'b').repeat(64),
      snapshotHash: 'c'.repeat(64),
      actual: execution(`local-${index}`, 'local', 20 + index),
      replay: execution(`ssh-${index}`, 'ssh', 10 + index),
    })),
  };
}

function execution(
  providerId: string,
  providerKind: 'local' | 'ssh',
  durationMs: number,
) {
  return {
    providerId,
    providerKind,
    environmentFingerprintHash: 'd'.repeat(64),
    outcome: 'completed' as const,
    durationMs,
    timedOut: false,
    exitCodeClass: 'zero' as const,
    receiptHash: hash(`${providerId}:receipt`),
    jobHash: hash(`${providerId}:job`),
    outputHash: hash(`${providerId}:output`),
    artifactManifestHash: null,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function modelFabricFixture() {
  const now = 2_000;
  const root = ed25519KeyPair();
  const policy = ed25519KeyPair();
  const release = ed25519KeyPair();
  const security = ed25519KeyPair();
  const publisher = ed25519KeyPair();
  const trustWindow = {
    status: 'active' as const,
    notBefore: 1_000,
    notAfter: 100_000,
  };
  return {
    now,
    root,
    policy,
    release,
    security,
    publisher,
    authority: {
      schemaVersion: 1 as const,
      authorityId: 'enterprise-policy-authority',
      revision: 1,
      issuedAt: 1_000,
      expiresAt: 90_000,
      signedBy: 'root-a',
      approvers: [
        {
          keyId: 'approver-release',
          publicKey: release.publicKeyPem,
          ...trustWindow,
          roles: ['release'],
        },
        {
          keyId: 'approver-security',
          publicKey: security.publicKeyPem,
          ...trustWindow,
          roles: ['security'],
        },
      ],
      publishers: [
        {
          keyId: 'publisher-a',
          publicKey: publisher.publicKeyPem,
          ...trustWindow,
        },
      ],
      stages: [
        {
          stage: 'canary' as const,
          requiredApprovals: 1,
          requiredRoles: ['release'],
        },
        {
          stage: 'production' as const,
          requiredApprovals: 2,
          requiredRoles: ['release', 'security'],
          requiresPriorStage: 'canary' as const,
        },
      ],
    },
    snapshot: {
      schemaVersion: 1 as const,
      rootset: {
        schemaVersion: 1 as const,
        revision: 1,
        issuedAt: 1_000,
        expiresAt: 90_000,
        signedBy: 'root-a',
        roots: [
          {
            keyId: 'root-a',
            publicKey: root.publicKeyPem,
            ...trustWindow,
          },
        ],
      },
      keyset: {
        schemaVersion: 2 as const,
        rootKeyId: 'root-a',
        revision: 1,
        issuedAt: 1_000,
        expiresAt: 80_000,
        keys: [
          {
            keyId: 'policy-a',
            publicKey: policy.publicKeyPem,
            ...trustWindow,
          },
        ],
      },
      policy: {
        schemaVersion: 1 as const,
        keyId: 'policy-a',
        revision: 1,
        issuedAt: 1_000,
        expiresAt: 70_000,
        policies: [
          {
            id: 'enterprise-global',
            scope: 'global' as const,
            scopeRef: 'global',
            windowMs: 86_400_000,
            limitUsd: 250,
            mode: 'hard' as const,
          },
        ],
      },
    },
  };
}

function ed25519KeyPair() {
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
