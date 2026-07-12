import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  canonicalizeGeneratedAppPackagePayload,
  generatedAppPackageAttestationSchema,
  generatedAppPackagePayloadSchema,
  type GeneratedAppPackageAttestation,
  type GeneratedAppPackagePayload,
} from '@shared/generated-app-package';
import type {
  GeneratedAppIdentity,
  GeneratedAppManifest,
} from '@shared/generated-app-manifest';

const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60_000;

export type GeneratedAppPackageSigner = {
  publisherId: string;
  keyId: string;
  privateKeyPem: string;
};

export type GeneratedAppPackageVerification = {
  attestation: GeneratedAppPackageAttestation;
  publisherId: string;
  keyId: string;
  publicKeyFingerprint: string;
};

export function signGeneratedAppPackage(
  input: {
    manifest: GeneratedAppManifest;
    identity: GeneratedAppIdentity;
    issuedAt: string;
    expiresAt: string | null;
  },
  signer: GeneratedAppPackageSigner,
): GeneratedAppPackageAttestation {
  const privateKey = createPrivateKey(signer.privateKeyPem);
  assertEd25519Key(privateKey, 'private');
  const publicKey = createPublicKey(privateKey);
  const payload = generatedAppPackagePayloadSchema.parse({
    schemaVersion: 1,
    manifest: input.manifest,
    identity: input.identity,
    publisher: {
      publisherId: signer.publisherId,
      keyId: signer.keyId,
      publicKeyFingerprint: fingerprintPublicKey(publicKey),
    },
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  });
  const signature = sign(
    null,
    Buffer.from(canonicalizeGeneratedAppPackagePayload(payload), 'utf8'),
    privateKey,
  );
  return generatedAppPackageAttestationSchema.parse({
    ...payload,
    signature: {
      algorithm: 'ed25519',
      value: signature.toString('base64'),
    },
  });
}

export function verifyGeneratedAppPackage(
  rawAttestation: unknown,
  expected: {
    manifest: GeneratedAppManifest;
    identity: GeneratedAppIdentity;
  },
  trustedPublicKeys: Readonly<Record<string, string>>,
  now = Date.now(),
): GeneratedAppPackageVerification {
  const attestation =
    generatedAppPackageAttestationSchema.parse(rawAttestation);
  const trustedPublicKeyPem = trustedPublicKeys[attestation.publisher.keyId];
  if (!trustedPublicKeyPem) {
    throw new Error('Generated app package signing key is not trusted');
  }
  const publicKey = createPublicKey(trustedPublicKeyPem);
  assertEd25519Key(publicKey, 'public');
  const fingerprint = fingerprintPublicKey(publicKey);
  if (fingerprint !== attestation.publisher.publicKeyFingerprint) {
    throw new Error('Generated app package signing key fingerprint changed');
  }
  const { signature, ...payload } = attestation;
  const valid = verify(
    null,
    Buffer.from(
      canonicalizeGeneratedAppPackagePayload(
        payload as GeneratedAppPackagePayload,
      ),
      'utf8',
    ),
    publicKey,
    Buffer.from(signature.value, 'base64'),
  );
  if (!valid) {
    throw new Error('Generated app package signature is invalid');
  }
  const issuedAt = Date.parse(attestation.issuedAt);
  if (issuedAt > now + MAX_FUTURE_CLOCK_SKEW_MS) {
    throw new Error('Generated app package attestation is from the future');
  }
  if (attestation.expiresAt && Date.parse(attestation.expiresAt) <= now) {
    throw new Error('Generated app package attestation has expired');
  }
  assertPackageContentMatches(attestation, expected);
  return {
    attestation,
    publisherId: attestation.publisher.publisherId,
    keyId: attestation.publisher.keyId,
    publicKeyFingerprint: fingerprint,
  };
}

export function fingerprintGeneratedAppPackagePublicKey(
  publicKeyPem: string,
): string {
  const publicKey = createPublicKey(publicKeyPem);
  assertEd25519Key(publicKey, 'public');
  return fingerprintPublicKey(publicKey);
}

function assertPackageContentMatches(
  attestation: GeneratedAppPackageAttestation,
  expected: {
    manifest: GeneratedAppManifest;
    identity: GeneratedAppIdentity;
  },
): void {
  if (
    canonicalJson(attestation.manifest) !== canonicalJson(expected.manifest)
  ) {
    throw new Error(
      'Generated app package manifest does not match its content',
    );
  }
  if (
    canonicalJson(attestation.identity) !== canonicalJson(expected.identity)
  ) {
    throw new Error(
      'Generated app package identity does not match its content',
    );
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJsonValue(nested)]),
  );
}

function assertEd25519Key(
  key: KeyObject,
  expectedType: 'private' | 'public',
): void {
  if (key.type !== expectedType || key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `Generated app package requires an Ed25519 ${expectedType} key`,
    );
  }
}

function fingerprintPublicKey(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex');
}
