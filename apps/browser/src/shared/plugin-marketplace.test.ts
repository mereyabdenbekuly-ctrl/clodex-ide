import { describe, expect, it } from 'vitest';
import {
  pluginMarketplaceManifestSchema,
  privateMarketplaceSourceSchema,
  privateMarketplaceSourcesConfigSchema,
} from './plugin-marketplace';

const PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAmtXDsSMwk5v2GM/4QzVB38heq2oSkyWO2spmWg2PS5w=', // gitleaks:allow
  '-----END PUBLIC KEY-----',
].join('\n');

function source(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'engineering',
    displayName: 'Engineering Marketplace',
    indexUrl: 'https://plugins.example.com/clodex/index.json',
    signingKeyId: 'engineering-2026-01',
    signingPublicKey: PUBLIC_KEY,
    enabled: true,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

describe('private marketplace source contracts', () => {
  it('accepts an HTTPS source with an explicitly pinned public key', () => {
    expect(privateMarketplaceSourceSchema.safeParse(source()).success).toBe(
      true,
    );
  });

  it.each([
    'http://plugins.example.com/index.json',
    'https://user:secret@plugins.example.com/index.json',
    'https://plugins.example.com/index.json?token=secret',
    'https://plugins.example.com/index.json#fragment',
  ])('rejects unsafe private marketplace URL %s', (indexUrl) => {
    expect(
      privateMarketplaceSourceSchema.safeParse(source({ indexUrl })).success,
    ).toBe(false);
  });

  it('rejects TOFU-style sources without an explicitly pinned public key', () => {
    expect(
      privateMarketplaceSourceSchema.safeParse(source({ signingPublicKey: '' }))
        .success,
    ).toBe(false);
  });

  it('rejects duplicate source IDs and URLs', () => {
    expect(
      privateMarketplaceSourcesConfigSchema.safeParse({
        schemaVersion: 1,
        sources: [
          source(),
          source({ displayName: 'Duplicate', updatedAt: 101 }),
        ],
      }).success,
    ).toBe(false);
  });
});

describe('executable runtime marketplace summaries', () => {
  const manifest = {
    schemaVersion: 1,
    id: 'local-tools',
    version: '1.0.0',
    displayName: 'Local Tools',
    description: 'Signed local tool runtime',
    publisher: 'Clodex',
    compatibility: { minAppVersion: '1.0.0' },
    permissions: ['mcp', 'process'],
    requiredCredentials: [],
    mcpServers: [
      {
        id: 'local-tools',
        displayName: 'Local Tools',
        transport: 'stdio',
        runtimeId: 'local-tools-runtime',
        endpoint: 'runtime:local-tools-runtime',
        authentication: 'none',
      },
    ],
    executableRuntimes: [
      {
        id: 'local-tools-runtime',
        sha256: 'a'.repeat(64),
        platforms: ['darwin', 'linux'],
        architectures: ['arm64', 'x64'],
        limits: { maxMemoryMb: 256, requestTimeoutMs: 30_000 },
      },
    ],
  };

  it('accepts signed executable runtime review metadata', () => {
    expect(pluginMarketplaceManifestSchema.safeParse(manifest).success).toBe(
      true,
    );
  });

  it('requires process permission for executable runtime metadata', () => {
    expect(
      pluginMarketplaceManifestSchema.safeParse({
        ...manifest,
        permissions: ['mcp'],
      }).success,
    ).toBe(false);
  });
});
