import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import {
  canonicalizePluginPublisherAttestation,
  type PluginMarketplaceIndexPayload,
  type PluginMarketplacePublisherKey,
} from '@shared/plugin-marketplace';

export function parseEd25519PublicKey(
  publicKey: string,
  label: string,
): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(publicKey);
  } catch {
    throw new Error(`${label} is not a valid public key`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${label} must be an Ed25519 public key`);
  }
  return key;
}

export function verifyPublisherSignatures(
  payload: PluginMarketplaceIndexPayload,
): Map<string, string> {
  const keys = new Map<string, PluginMarketplacePublisherKey>(
    (payload.publisherKeys ?? []).map((key) => [key.keyId, key]),
  );
  const verified = new Map<string, string>();
  for (const entry of payload.plugins) {
    const publisherId = entry.manifest.publisherId;
    if (!publisherId || !entry.publisherSignature) continue;
    const key = keys.get(entry.publisherSignature.keyId);
    if (!key) {
      throw new Error(
        `Publisher signing key is not present: ${entry.publisherSignature.keyId}`,
      );
    }
    if (key.status !== 'active') {
      throw new Error(
        `Publisher signing key is revoked: ${entry.publisherSignature.keyId}`,
      );
    }
    if (
      key.publisherId !== publisherId ||
      key.publisherName !== entry.manifest.publisher
    ) {
      throw new Error(
        `Publisher identity does not match plugin ${entry.manifest.id}`,
      );
    }
    const attestation = Buffer.from(
      canonicalizePluginPublisherAttestation(entry),
      'utf8',
    );
    const signature = Buffer.from(entry.publisherSignature.signature, 'base64');
    const publicKey = parseEd25519PublicKey(
      key.publicKey,
      `Publisher signing key ${key.keyId}`,
    );
    if (!verify(null, attestation, publicKey, signature)) {
      throw new Error(
        `Publisher signature is invalid for plugin ${entry.manifest.id}`,
      );
    }
    verified.set(entry.manifest.id, key.keyId);
  }
  return verified;
}
