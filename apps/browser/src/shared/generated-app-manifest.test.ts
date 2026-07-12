import { describe, expect, it } from 'vitest';
import {
  canonicalizeGeneratedAppManifest,
  generatedAppManifestSchema,
} from './generated-app-manifest';

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'status-dashboard',
    name: 'Status dashboard',
    version: '1.0.0',
    entrypoint: 'index.html',
    capabilities: [],
    ...overrides,
  };
}

describe('generated app manifest', () => {
  it('canonicalizes object keys without changing declared list order', () => {
    const first = generatedAppManifestSchema.parse(
      manifest({
        capabilities: [
          {
            reason: 'Search documentation',
            tools: [{ toolName: 'search', serverId: 'docs' }],
            type: 'mcp:call',
          },
        ],
      }),
    );
    const second = generatedAppManifestSchema.parse({
      capabilities: [
        {
          type: 'mcp:call',
          tools: [{ serverId: 'docs', toolName: 'search' }],
          reason: 'Search documentation',
        },
      ],
      entrypoint: 'index.html',
      version: '1.0.0',
      name: 'Status dashboard',
      id: 'status-dashboard',
      schemaVersion: 1,
    });

    expect(canonicalizeGeneratedAppManifest(first)).toBe(
      canonicalizeGeneratedAppManifest(second),
    );
  });

  it('rejects duplicate capability declarations and scoped resources', () => {
    const duplicateCapability = generatedAppManifestSchema.safeParse(
      manifest({
        capabilities: [
          { type: 'agent:ask', reason: 'First reason' },
          { type: 'agent:ask', reason: 'Second reason' },
        ],
      }),
    );
    const duplicateTool = generatedAppManifestSchema.safeParse(
      manifest({
        capabilities: [
          {
            type: 'mcp:call',
            reason: 'Search documentation',
            tools: [
              { serverId: 'docs', toolName: 'search' },
              { serverId: 'docs', toolName: 'search' },
            ],
          },
        ],
      }),
    );

    expect(duplicateCapability.success).toBe(false);
    expect(duplicateTool.success).toBe(false);
  });

  it('requires semantic versions and path-safe app IDs', () => {
    expect(
      generatedAppManifestSchema.safeParse(manifest({ version: 'latest' }))
        .success,
    ).toBe(false);
    expect(
      generatedAppManifestSchema.safeParse(manifest({ id: '../escape' }))
        .success,
    ).toBe(false);
    expect(
      generatedAppManifestSchema.safeParse(manifest({ id: 'nested/app' }))
        .success,
    ).toBe(false);
    expect(
      generatedAppManifestSchema.safeParse(manifest({ id: 'safe-app_2.0' }))
        .success,
    ).toBe(true);
  });
});
