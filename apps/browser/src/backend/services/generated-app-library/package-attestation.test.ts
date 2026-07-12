import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  fingerprintGeneratedAppPackagePublicKey,
  signGeneratedAppPackage,
  verifyGeneratedAppPackage,
} from './package-attestation';

function createFixture() {
  const keys = generateKeyPairSync('ed25519');
  const privateKeyPem = keys.privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string;
  const publicKeyPem = keys.publicKey.export({
    type: 'spki',
    format: 'pem',
  }) as string;
  const manifest = {
    schemaVersion: 1 as const,
    id: 'dashboard',
    name: 'Dashboard',
    version: '1.0.0',
    entrypoint: 'index.html' as const,
    capabilities: [
      {
        type: 'agent:ask' as const,
        reason: 'Summarize the current dashboard',
      },
    ],
  };
  const identity = {
    manifestSchemaVersion: 1 as const,
    appVersion: '1.0.0',
    manifestHash: 'a'.repeat(64),
    executableHash: 'b'.repeat(64),
    assetHash: 'c'.repeat(64),
  };
  return { privateKeyPem, publicKeyPem, manifest, identity };
}

describe('generated app package attestation', () => {
  it('signs and verifies an identity-bound package with a trusted key', () => {
    const fixture = createFixture();
    const attestation = signGeneratedAppPackage(
      {
        manifest: fixture.manifest,
        identity: fixture.identity,
        issuedAt: '2026-07-11T12:00:00.000Z',
        expiresAt: '2026-08-11T12:00:00.000Z',
      },
      {
        publisherId: 'clodex-local',
        keyId: 'generated-app-key-1',
        privateKeyPem: fixture.privateKeyPem,
      },
    );

    expect(
      verifyGeneratedAppPackage(
        attestation,
        {
          manifest: fixture.manifest,
          identity: fixture.identity,
        },
        { 'generated-app-key-1': fixture.publicKeyPem },
        Date.parse('2026-07-12T12:00:00.000Z'),
      ),
    ).toMatchObject({
      publisherId: 'clodex-local',
      keyId: 'generated-app-key-1',
      publicKeyFingerprint: fingerprintGeneratedAppPackagePublicKey(
        fixture.publicKeyPem,
      ),
    });
  });

  it('rejects untrusted, expired, and future attestations', () => {
    const fixture = createFixture();
    const attestation = signGeneratedAppPackage(
      {
        manifest: fixture.manifest,
        identity: fixture.identity,
        issuedAt: '2026-07-11T12:00:00.000Z',
        expiresAt: '2026-07-12T12:00:00.000Z',
      },
      {
        publisherId: 'clodex-local',
        keyId: 'generated-app-key-1',
        privateKeyPem: fixture.privateKeyPem,
      },
    );

    expect(() =>
      verifyGeneratedAppPackage(
        attestation,
        { manifest: fixture.manifest, identity: fixture.identity },
        {},
        Date.parse('2026-07-11T12:01:00.000Z'),
      ),
    ).toThrow('not trusted');
    expect(() =>
      verifyGeneratedAppPackage(
        attestation,
        { manifest: fixture.manifest, identity: fixture.identity },
        { 'generated-app-key-1': fixture.publicKeyPem },
        Date.parse('2026-07-12T12:00:00.000Z'),
      ),
    ).toThrow('expired');

    const future = signGeneratedAppPackage(
      {
        manifest: fixture.manifest,
        identity: fixture.identity,
        issuedAt: '2026-07-13T12:00:00.000Z',
        expiresAt: null,
      },
      {
        publisherId: 'clodex-local',
        keyId: 'generated-app-key-1',
        privateKeyPem: fixture.privateKeyPem,
      },
    );
    expect(() =>
      verifyGeneratedAppPackage(
        future,
        { manifest: fixture.manifest, identity: fixture.identity },
        { 'generated-app-key-1': fixture.publicKeyPem },
        Date.parse('2026-07-11T12:00:00.000Z'),
      ),
    ).toThrow('from the future');
  });

  it('rejects content substitution and invalid signatures', () => {
    const fixture = createFixture();
    const attestation = signGeneratedAppPackage(
      {
        manifest: fixture.manifest,
        identity: fixture.identity,
        issuedAt: '2026-07-11T12:00:00.000Z',
        expiresAt: null,
      },
      {
        publisherId: 'clodex-local',
        keyId: 'generated-app-key-1',
        privateKeyPem: fixture.privateKeyPem,
      },
    );

    expect(() =>
      verifyGeneratedAppPackage(
        attestation,
        {
          manifest: { ...fixture.manifest, name: 'Substituted app' },
          identity: fixture.identity,
        },
        { 'generated-app-key-1': fixture.publicKeyPem },
        Date.parse('2026-07-11T13:00:00.000Z'),
      ),
    ).toThrow('manifest does not match');
    expect(() =>
      verifyGeneratedAppPackage(
        attestation,
        {
          manifest: fixture.manifest,
          identity: {
            ...fixture.identity,
            executableHash: 'd'.repeat(64),
          },
        },
        { 'generated-app-key-1': fixture.publicKeyPem },
        Date.parse('2026-07-11T13:00:00.000Z'),
      ),
    ).toThrow('identity does not match');

    const invalidSignature = {
      ...attestation,
      signature: {
        ...attestation.signature,
        value: Buffer.alloc(64, 7).toString('base64'),
      },
    };
    expect(() =>
      verifyGeneratedAppPackage(
        invalidSignature,
        { manifest: fixture.manifest, identity: fixture.identity },
        { 'generated-app-key-1': fixture.publicKeyPem },
        Date.parse('2026-07-11T13:00:00.000Z'),
      ),
    ).toThrow('signature is invalid');
  });

  it('rejects non-Ed25519 signing keys', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fixture = createFixture();
    expect(() =>
      signGeneratedAppPackage(
        {
          manifest: fixture.manifest,
          identity: fixture.identity,
          issuedAt: '2026-07-11T12:00:00.000Z',
          expiresAt: null,
        },
        {
          publisherId: 'clodex-local',
          keyId: 'rsa-key',
          privateKeyPem: rsa.privateKey.export({
            type: 'pkcs8',
            format: 'pem',
          }) as string,
        },
      ),
    ).toThrow('Ed25519 private key');
  });
});
