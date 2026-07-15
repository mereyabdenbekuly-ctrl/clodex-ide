import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchReleases } from './github.js';

function release(
  version: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    assets: [
      {
        browser_download_url: `https://example.test/clodex-${version}.dmg`,
        name: `clodex-${version}.dmg`,
        size: 123,
      },
    ],
    body: `Release ${version}`,
    draft: false,
    name: `Clodex ${version}`,
    prerelease: false,
    published_at: '2026-07-16T00:00:00Z',
    tag_name: `clodex@${version}`,
    ...overrides,
  };
}

function mockGitHub(payload: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHub release ingestion', () => {
  it('never exposes a privileged-token draft in the public release feed', async () => {
    mockGitHub([
      release('9.9.9', { draft: true, published_at: null }),
      release('1.16.0'),
    ]);

    await expect(fetchReleases()).resolves.toMatchObject([
      { tag: 'clodex@1.16.0', version: '1.16.0' },
    ]);
  });

  it('rejects unpublished releases even when draft is false', async () => {
    mockGitHub([release('1.16.1', { published_at: null }), release('1.16.0')]);

    await expect(fetchReleases()).resolves.toHaveLength(1);
  });

  it('skips malformed draft, prerelease, and publication fields', async () => {
    mockGitHub([
      release('1.16.3', { draft: 'false' }),
      release('1.16.2', { prerelease: 'false' }),
      release('1.16.1', { published_at: 'not-a-timestamp' }),
      release('1.16.0'),
    ]);

    await expect(fetchReleases()).resolves.toMatchObject([
      { version: '1.16.0' },
    ]);
  });

  it('accepts canonical GitHub timestamps with or without milliseconds', async () => {
    mockGitHub([
      release('1.16.1', { published_at: '2026-07-16T00:00:00.123Z' }),
      release('1.16.0'),
    ]);

    await expect(fetchReleases()).resolves.toMatchObject([
      { publishedAt: '2026-07-16T00:00:00.123Z', version: '1.16.1' },
      { publishedAt: '2026-07-16T00:00:00Z', version: '1.16.0' },
    ]);
  });

  it('fails closed when GitHub returns a non-array payload', async () => {
    mockGitHub({ message: 'unexpected response' });

    await expect(fetchReleases()).rejects.toThrow(
      'GitHub API returned an invalid release list',
    );
  });
});
