import { sign, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  canonicalizePluginPublisherAttestation,
  pluginMarketplaceManifestSchema,
  pluginMarketplacePackageSourceSchema,
} from '@shared/plugin-marketplace';

export type SignPublisherAttestationOptions = {
  entryPath: string;
  privateKeyPath: string;
  publicKeyPath: string;
  keyId: string;
};

export async function signPublisherAttestation(
  options: SignPublisherAttestationOptions,
): Promise<{ keyId: string; signature: string }> {
  const privateKeyStat = await fs.lstat(options.privateKeyPath);
  if (privateKeyStat.isSymbolicLink() || !privateKeyStat.isFile()) {
    throw new Error('Publisher private key must be a regular file');
  }
  if (process.platform !== 'win32' && (privateKeyStat.mode & 0o077) !== 0) {
    throw new Error(
      'Publisher private key must not be readable or writable by group/other',
    );
  }
  const rawEntry = JSON.parse(
    await fs.readFile(options.entryPath, 'utf8'),
  ) as Record<string, unknown>;
  const entry = {
    manifest: pluginMarketplaceManifestSchema.parse(rawEntry.manifest),
    source: pluginMarketplacePackageSourceSchema.parse(rawEntry.source),
    sha256:
      typeof rawEntry.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(rawEntry.sha256)
        ? rawEntry.sha256
        : (() => {
            throw new Error('Entry sha256 must be a lowercase SHA-256 digest');
          })(),
  };
  if (!entry.manifest.publisherId) {
    throw new Error('Publisher signing requires manifest.publisherId');
  }

  const [privateKey, publicKey] = await Promise.all([
    fs.readFile(options.privateKeyPath, 'utf8'),
    fs.readFile(options.publicKeyPath, 'utf8'),
  ]);
  const attestation = Buffer.from(
    canonicalizePluginPublisherAttestation(entry),
    'utf8',
  );
  const signature = sign(null, attestation, privateKey);
  if (!verify(null, attestation, publicKey, signature)) {
    throw new Error('Publisher public key does not match the private key');
  }
  return {
    keyId: options.keyId,
    signature: signature.toString('base64'),
  };
}
