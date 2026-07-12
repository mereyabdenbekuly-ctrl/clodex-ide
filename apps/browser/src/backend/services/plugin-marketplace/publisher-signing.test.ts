import { generateKeyPairSync, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalizePluginPublisherAttestation,
  pluginMarketplaceManifestSchema,
} from '@shared/plugin-marketplace';
import { signPublisherAttestation } from './publisher-signing';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('publisher attestation signing', () => {
  it('signs canonical entry metadata without exposing private key material', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'clodex-publisher-signing-'),
    );
    temporaryRoots.push(root);
    const keyPair = generateKeyPairSync('ed25519');
    const privateKeyPath = path.join(root, 'publisher-private.pem');
    const publicKeyPath = path.join(root, 'publisher-public.pem');
    const entryPath = path.join(root, 'entry.json');
    const entry = {
      manifest: {
        schemaVersion: 1 as const,
        id: 'learn-docs',
        version: '1.0.0',
        displayName: 'Learn Docs',
        description: 'Read official documentation through MCP.',
        publisher: 'Example Publisher',
        publisherId: 'example-publisher',
        compatibility: { minAppVersion: '1.16.0' },
        permissions: ['mcp', 'network'],
        requiredCredentials: [],
        mcpServers: [
          {
            id: 'learn',
            displayName: 'Learn',
            transport: 'streamable-http' as const,
            endpoint: 'https://learn.example.com/api/mcp',
            authentication: 'none' as const,
          },
        ],
      },
      source: {
        type: 'https' as const,
        url: 'https://downloads.example.com/learn-docs.clodex-plugin',
      },
      sha256: 'a'.repeat(64),
    };
    await Promise.all([
      fs.writeFile(
        privateKeyPath,
        keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        { mode: 0o600 },
      ),
      fs.writeFile(
        publicKeyPath,
        keyPair.publicKey.export({ type: 'spki', format: 'pem' }),
      ),
      fs.writeFile(entryPath, JSON.stringify(entry)),
    ]);

    const result = await signPublisherAttestation({
      entryPath,
      privateKeyPath,
      publicKeyPath,
      keyId: 'example-publisher-2026-01',
    });

    expect(result).toEqual({
      keyId: 'example-publisher-2026-01',
      signature: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
    expect(
      verify(
        null,
        Buffer.from(
          canonicalizePluginPublisherAttestation({
            ...entry,
            manifest: pluginMarketplaceManifestSchema.parse(entry.manifest),
          }),
          'utf8',
        ),
        keyPair.publicKey,
        Buffer.from(result.signature, 'base64'),
      ),
    ).toBe(true);
  });

  it.runIf(process.platform !== 'win32')(
    'rejects publisher private keys with broad filesystem permissions',
    async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'clodex-publisher-permissions-'),
      );
      temporaryRoots.push(root);
      const keyPair = generateKeyPairSync('ed25519');
      const privateKeyPath = path.join(root, 'publisher-private.pem');
      const publicKeyPath = path.join(root, 'publisher-public.pem');
      const entryPath = path.join(root, 'entry.json');
      await Promise.all([
        fs.writeFile(
          privateKeyPath,
          keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
          { mode: 0o644 },
        ),
        fs.writeFile(
          publicKeyPath,
          keyPair.publicKey.export({ type: 'spki', format: 'pem' }),
        ),
        fs.writeFile(
          entryPath,
          JSON.stringify({
            manifest: {
              schemaVersion: 1,
              id: 'example',
              version: '1.0.0',
              displayName: 'Example',
              description: 'Example publisher package.',
              publisher: 'Example Publisher',
              publisherId: 'example-publisher',
              compatibility: { minAppVersion: '1.16.0' },
              permissions: ['skills'],
              requiredCredentials: [],
            },
            source: {
              type: 'https',
              url: 'https://downloads.example.com/example.clodex-plugin',
            },
            sha256: 'b'.repeat(64),
          }),
        ),
      ]);

      await expect(
        signPublisherAttestation({
          entryPath,
          privateKeyPath,
          publicKeyPath,
          keyId: 'example-publisher-2026-01',
        }),
      ).rejects.toThrow('must not be readable or writable by group/other');
    },
  );
});
