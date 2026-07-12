import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprintGeneratedAppPackagePublicKey } from './package-attestation';
import {
  GeneratedAppPackageTrustService,
  type GeneratedAppPackageTrustPersistence,
} from './package-trust';

function publicIdentity() {
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({
    type: 'spki',
    format: 'pem',
  }) as string;
  return {
    publisherId: 'team-acme',
    keyId: 'release-key',
    publicKeyPem,
    publicKeyFingerprint: fingerprintGeneratedAppPackagePublicKey(publicKeyPem),
  };
}

describe('GeneratedAppPackageTrustService', () => {
  it('never replaces a trusted key ID with a different fingerprint', async () => {
    let store: unknown = { version: 1, entries: [] };
    const persistence: GeneratedAppPackageTrustPersistence = {
      load: async () => structuredClone(store),
      save: async (next) => {
        store = structuredClone(next);
      },
    };
    const service = new GeneratedAppPackageTrustService(persistence);
    const first = publicIdentity();
    const substituted = publicIdentity();
    await service.trust(first);

    await expect(service.assertCompatible(substituted)).rejects.toThrow(
      'different signing key',
    );
    await expect(
      service.find(first.publisherId, first.keyId),
    ).resolves.toMatchObject({
      publicKeyFingerprint: first.publicKeyFingerprint,
    });
  });

  it('migrates v1, revokes permanently, and records bounded administration state', async () => {
    let store: unknown = { version: 1, entries: [] };
    const persistence: GeneratedAppPackageTrustPersistence = {
      load: async () => structuredClone(store),
      save: async (next) => {
        store = structuredClone(next);
      },
    };
    const service = new GeneratedAppPackageTrustService(persistence, () =>
      Date.parse('2026-07-11T12:00:00.000Z'),
    );
    const identity = publicIdentity();
    await service.trust(identity);
    await service.revoke(
      identity.publisherId,
      identity.keyId,
      'security incident',
    );

    await expect(service.trust(identity)).rejects.toThrow(
      'cannot be silently trusted again',
    );
    await expect(service.getAdministration()).resolves.toMatchObject({
      entries: [
        {
          publisherId: identity.publisherId,
          revokedAt: '2026-07-11T12:00:00.000Z',
        },
      ],
      audit: [
        { operation: 'trust' },
        { operation: 'revoke', reason: 'security incident' },
      ],
    });
    expect(store).toMatchObject({ version: 2 });
  });

  it('enforces organization allowlists by publisher or exact fingerprint', async () => {
    let store: unknown = { version: 1, entries: [] };
    const service = new GeneratedAppPackageTrustService({
      load: async () => structuredClone(store),
      save: async (next) => {
        store = structuredClone(next);
      },
    });
    const identity = publicIdentity();
    await service.setPolicy({
      mode: 'allowlist',
      allowedPublisherIds: ['another-team'],
      allowedPublicKeyFingerprints: [],
    });
    await expect(service.evaluatePolicy(identity)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(service.trust(identity)).rejects.toThrow(
      'not allowed by organization policy',
    );
    await expect(service.getAdministration()).resolves.toMatchObject({
      audit: expect.arrayContaining([
        expect.objectContaining({
          operation: 'policy-deny',
          publisherId: identity.publisherId,
        }),
      ]),
    });

    await service.setPolicy({
      mode: 'allowlist',
      allowedPublisherIds: [],
      allowedPublicKeyFingerprints: [identity.publicKeyFingerprint],
    });
    await expect(service.trust(identity)).resolves.toMatchObject({
      publisherId: identity.publisherId,
    });
  });
});
